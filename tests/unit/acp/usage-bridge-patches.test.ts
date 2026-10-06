import { describe, expect, it } from "bun:test";
import { claudeUsagePatch, codexUsagePatch } from "@acp/usage-bridge-patches.js";

// These are the upstream handler boundaries; execute patched JavaScript with
// protocol notifications, rather than assert that generated text contains fields.
const codexBoundary = `  createUsageUpdate(params) {}
  handleRateLimitsUpdated(params) {}`;
const count = (input: number, cache: number, output: number, total: number) => ({
  inputTokens: input, cachedInputTokens: cache, outputTokens: output,
  reasoningOutputTokens: output / 2, totalTokens: total,
});

describe("Codex consumption bridge", () => {
  it("emits cumulative deltas once across requests, replay, absent context windows and turns", () => {
    const patched = codexUsagePatch(codexBoundary)!;
    const handler = new Function(`return class { ${patched} }`)();
    const instance = new handler();
    instance.sessionState = { sessionId: "session", currentTurnId: "turn1", totalTokenUsage: count(100, 500, 30, 630) };
    instance.handleTokenUsageUpdated = (params: any) => Object.assign(instance.sessionState, {
      totalTokenUsage: params.tokenUsage.total, lastTokenUsage: params.tokenUsage.last,
      modelContextWindow: params.tokenUsage.modelContextWindow,
    });
    const params = { threadId: "thread", tokenUsage: { last: count(10, 100, 5, 115), total: count(110, 600, 35, 745), modelContextWindow: null } };
    const first = instance.createUsageUpdate(params);
    expect(first._meta.remiTokenUsage).toMatchObject({ inputTokens: 10, cachedInputTokens: 100, outputTokens: 5, totalTokens: 115, model: null });
    expect(first.size).toBe(0);
    expect(instance.createUsageUpdate(params)).toBeNull();
    instance.sessionState.currentTurnId = "turn2";
    const next = instance.createUsageUpdate({ ...params, tokenUsage: { ...params.tokenUsage, total: count(120, 680, 45, 845) } });
    expect(next._meta.remiTokenUsage).toMatchObject({ totalTokens: 100, inputTokens: 10, cachedInputTokens: 80, outputTokens: 10, turnId: "turn2" });
    instance.sessionState = { sessionId: "session", currentTurnId: "turn3", totalTokenUsage: null }; // new resumed bridge
    const resumed = instance.createUsageUpdate(params);
    expect(resumed._meta.remiTokenUsage).toMatchObject({ totalTokens: 115, accuracy: "partial" });
    expect(codexUsagePatch(patched)).toBe(patched);
  });

  it("keeps the baseline across reordered replays, distinct counter epochs and compaction diagnostics", () => {
    const Handler = new Function(`return class { ${codexUsagePatch(codexBoundary)!} }`)();
    const instance = new Handler();
    instance.sessionState = { sessionId: "s", totalTokenUsage: null };
    instance.handleTokenUsageUpdated = (p: any) => Object.assign(instance.sessionState, { totalTokenUsage: p.tokenUsage.total, lastTokenUsage: p.tokenUsage.last });
    const notify = (input: number, output: number, total = input + output) => instance.createUsageUpdate({ threadId: "s", tokenUsage: { total: count(input, 0, output, total), last: count(100, 0, 10, 110) } });
    const first = notify(100, 10), second = notify(200, 20);
    expect(notify(100, 10)).toBeNull();
    const third = notify(300, 30);
    expect([first, second, third].reduce((sum, event) => sum + event._meta.remiTokenUsage.totalTokens, 0)).toBe(330);
    const context = notify(0, 0, 78048);
    expect(context._meta.remiTokenUsage).toBeUndefined();
    expect(context._meta.remiUncertainUsage.reportedTotalTokens).toBe(78048);
    expect(notify(400, 40)._meta.remiTokenUsage.totalTokens).toBe(110);
    const reset = notify(10, 1);
    const reused = notify(100, 10);
    expect(reset._meta.remiTokenUsage.accuracy).toBe("partial");
    expect(reused._meta.remiTokenUsage.id).not.toBe(first._meta.remiTokenUsage.id);
  });
});

describe("Claude request consumption bridge", () => {
  it("preserves cumulative request snapshots and real child models before errors or cancellation", async () => {
    const source = `                if (session.emitRawSDKMessages && false) {}`;
    const patched = claudeUsagePatch(source)!;
    const consume = new Function("session", "message", "params", `return (async () => { ${patched} })();`);
    const updates: any[] = [];
    const receiver = { client: { sessionUpdate: async (event: any) => updates.push(event.update._meta.remiTokenUsage) } };
    const session = {};
    const params = { sessionId: "session" };
    const message = (parent: string | null, event: any) => ({ type: "stream_event", parent_tool_use_id: parent, event });
    await consume.call(receiver, session, message(null, { type: "message_start", message: { id: "main", model: "opus", usage: { input_tokens: 10, cache_read_input_tokens: 80, output_tokens: 0 } } }), params);
    await consume.call(receiver, session, message("tool1", { type: "message_start", message: { id: "child", model: "haiku", usage: { input_tokens: 4, output_tokens: 0 } } }), params);
    await consume.call(receiver, session, message(null, { type: "message_delta", usage: { output_tokens: 12, input_tokens: null } }), params);
    await consume.call(receiver, session, { type: "assistant", parent_tool_use_id: "tool1", message: { id: "child", model: "haiku", usage: { input_tokens: 4, output_tokens: 2 } } }, params);
    expect(updates).toEqual([
      expect.objectContaining({ id: "main", model: "opus", totalTokens: 90, accuracy: "partial" }),
      expect.objectContaining({ id: "child", model: "haiku", totalTokens: 4, parentToolUseId: "tool1" }),
      expect.objectContaining({ id: "main", model: "opus", inputTokens: 10, totalTokens: 102 }),
      expect.objectContaining({ id: "child", model: "haiku", totalTokens: 6, accuracy: "exact" }),
    ]);
    expect(claudeUsagePatch(patched)).toBe(patched);
  });
  it("retains SDK turn estimates including explicit zero without inventing token counters", async () => {
    const source = `                if (session.emitRawSDKMessages && false) {}`;
    const consume = new Function("session", "message", "params", `return (async () => { ${claudeUsagePatch(source)!} })();`);
    const updates: any[] = [];
    const receiver = { client: { sessionUpdate: async (event: any) => updates.push(event.update) } };
    for (const total_cost_usd of [0.25, 0]) await consume.call(receiver, {}, { type: "result", total_cost_usd }, { sessionId: "s" });
    expect(updates.map(update => [update.cost, update._meta.remiCostUsage])).toEqual([
      [{ amount: 0.25, currency: "USD" }, { scope: "turn", source: "sdk_estimate" }],
      [{ amount: 0, currency: "USD" }, { scope: "turn", source: "sdk_estimate" }],
    ]);
  });
});
