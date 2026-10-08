import { describe, expect, it } from "bun:test";
import { claudeUsagePatch, codexUsagePatch } from "@acp/usage-bridge-patches.js";

// These are the upstream handler boundaries; execute patched JavaScript with
// protocol notifications, rather than assert that generated text contains fields.
const codexBoundary = `  async handleNotification(notification) {
    const update = await this.createUpdateEvent(notification);
    if (update) await this.session.update(update, "child-rendering-session");
  }
  async createUpdateEvent(notification) {
    switch (notification.method) { case "rawResponse/completed": return null; }
    return null;
  }
  createUsageUpdate(params) {}
  handleRateLimitsUpdated(params) {}
  routeChild(childEvent, session) {
    if (session.current.supportsSubagents) session.current.dispatch(childEvent);
    else session.current.enqueueInteraction(childEvent);
  }`;
const count = (input: number, cache: number, output: number, total: number) => ({
  inputTokens: input, cachedInputTokens: cache, cacheWriteInputTokens: 0, outputTokens: output,
  reasoningOutputTokens: output / 2, totalTokens: total,
});

describe("Codex consumption bridge", () => {
  function actor() {
    const Handler = new Function(`return class { ${codexUsagePatch(codexBoundary)!} }`)();
    const instance = new Handler();
    instance.sessionState = { sessionId: "parent", currentModelId: "requested-model", totalTokenUsage: null };
    instance.handleTokenUsageUpdated = (p: any) => Object.assign(instance.sessionState, {
      totalTokenUsage: p.tokenUsage.total, lastTokenUsage: p.tokenUsage.last, modelContextWindow: p.tokenUsage.modelContextWindow,
    });
    return instance;
  }

  it("requires the pinned raw response handler and patches idempotently", () => {
    expect(codexUsagePatch(codexBoundary.replace('case "rawResponse/completed":', 'case "unknown":'))).toBeNull();
    const patched = codexUsagePatch(codexBoundary)!;
    expect(codexUsagePatch(patched)).toBe(patched);
  });

  it("upgrades v5 bundles without leaving the compaction epoch state machine or duplicating request hooks", () => {
    const old = codexBoundary.replace("  async createUpdateEvent(notification) {", `  async createUpdateEvent(notification) {
    // Upstream's two explicit successful compaction notifications are reset
    // evidence. Error/start notifications and display text are not evidence.
    if (notification.method === "thread/compacted") {
      const seen = this.sessionState.remiUsageCompactions ??= new Set();
      if (!seen.has("compact")) {
        this.sessionState.remiUsageCompactionPending = { epochId: "old" };
      }
    }
`).replace("  createUsageUpdate(params) {}", '  createUsageUpdate(params) { const CODEX_USAGE_PATCH = "codex-usage-v5"; this.sessionState.remiUsageAccounting = {}; }');
    const patched = codexUsagePatch(old)!;
    expect(patched).not.toContain("remiUsageCompactionPending");
    expect(patched).not.toContain("remiUsageCompactions");
    expect(patched).not.toContain("remiUsageAccounting");
    expect(patched).not.toContain("codex-usage-v5");
    expect(patched.match(/const normalize = /g)).toHaveLength(1);
    expect(codexUsagePatch(patched)).toBe(patched);
  });

  it("records exact upstream requests independently of cumulative counters or epoch", async () => {
    const instance = actor();
    const raw = { ...count(244990, 244864, 2645, 247635), cacheWriteInputTokens: 0 };
    const update = await instance.createUpdateEvent({ method: "rawResponse/completed", params: {
      threadId: "parent", turnId: "turn", responseId: "compact-response", usage: raw,
    } });
    expect(update._meta.remiTokenUsage).toMatchObject({ providerSessionId: "parent",
      providerRequestId: "compact-response", inputTokens: 126, cachedInputTokens: 244864,
      outputTokens: 2645, totalTokens: 247635, accuracy: "exact", model: null, requestedModel: "requested-model" });
    for (const total of [1000, 500, 78048]) {
      const context = instance.createUsageUpdate({ tokenUsage: { total: count(0, 0, 0, total), last: raw, modelContextWindow: 200000 } });
      expect(context._meta.remiTokenUsage).toBeUndefined();
      expect(context._meta.remiUsageMode).toBe("request");
    }
  });

  it("reports missing request usage as a gap rather than inventing counters", async () => {
    const instance = actor();
    for (const usage of [null, count(10, 11, 2, 12), count(10, 0, 2, 78048)]) {
      const update = await instance.createUpdateEvent({ method: "rawResponse/completed", params: { threadId: "native", responseId: "missing", usage } });
      expect(update._meta.remiTokenUsage).toBeUndefined();
      expect(update._meta.remiMissingRequestUsage).toMatchObject({ providerSessionId: "native", providerRequestId: "missing", accuracy: "unknown" });
    }
  });

  it("publishes child request usage on the parent envelope before lifecycle/rendering filters", async () => {
    const instance = actor();
    const calls: any[] = [];
    instance.session = { update: (...args: any[]) => calls.push(args) };
    const childEvent = { method: "rawResponse/completed", params: {
      threadId: "child-native", turnId: "child-turn", responseId: "child-response", usage: count(10, 8, 2, 12),
    } };
    const pending: Promise<void>[] = [];
    instance.routeChild(childEvent, { current: { rootSessionId: "parent", supportsSubagents: false,
      dispatch: (event: any) => pending.push(instance.handleNotification(event)),
      enqueueInteraction: () => { throw new Error("Usage must bypass interaction-only routing"); },
    } });
    await Promise.all(pending);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1); // No child ACP envelope override.
    expect(calls[0][0]._meta.remiTokenUsage).toMatchObject({ providerSessionId: "child-native", providerRequestId: "child-response", totalTokens: 12,
      requestedModel: null, modelSource: "unknown" });
    await instance.handleNotification({ ...childEvent, params: { ...childEvent.params, threadId: "unrelated-native" } });
    expect(calls).toHaveLength(1);
    await instance.handleNotification({ ...childEvent, _remiUsageRootSessionId: "another-parent" });
    expect(calls).toHaveLength(1);
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
    await consume.call(receiver, session, { type: "assistant", parent_tool_use_id: "tool1", message: { id: "child", model: "haiku", stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 } } }, params);
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
