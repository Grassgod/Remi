import { describe, expect, it, mock, spyOn } from "bun:test";
import { normalizeCodexRequestUsage } from "@acp/codex-request-usage.js";
import { codexUsagePatch } from "@acp/usage-bridge-patches.js";
import { AcpProvider } from "@acp/provider.js";
import { unitActualTotal } from "@acp/usage-collector.js";
import { responseToUsageUnits } from "@multiremi/worker/acp-event-mapper.js";

const boundary = `  async handleNotification(notification) {}
  async createUpdateEvent(notification) { switch(notification.method) { case "rawResponse/completed": return null; } }
  createUsageUpdate(params) {}
  handleRateLimitsUpdated(params) {}
  routeChild(childEvent, session) { if (session.current.supportsSubagents) session.current.dispatch(childEvent); }`;

function bridge() {
  const Handler = new Function(`return class { ${codexUsagePatch(boundary)!} }`)();
  const handler = new Handler();
  handler.sessionState = { sessionId: "resumed-parent", currentModelId: "requested-model" };
  handler.handleTokenUsageUpdated = (p: any) => Object.assign(handler.sessionState, {
    totalTokenUsage: p.tokenUsage.total, lastTokenUsage: p.tokenUsage.last, modelContextWindow: p.tokenUsage.modelContextWindow,
  });
  return {
    request: (id: string, total: number | null, threadId = "resumed-parent") => handler.createUpdateEvent({
      method: "rawResponse/completed", params: { threadId, turnId: "native-turn", responseId: id,
        usage: total === null ? null : { inputTokens: total - 10, cachedInputTokens: total - 20,
          cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: total } },
    }),
    context: () => handler.createUsageUpdate({ tokenUsage: {
      last: { totalTokens: 78048 }, total: { totalTokens: 46649851 }, modelContextWindow: 200000,
    } }),
  };
}

describe("Codex exact response consumption", () => {
  it("separates input cache read/write without counting reasoning twice in both native and protocol records", () => {
    const usage = { inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 60,
      outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 110 };
    const protocol = normalizeCodexRequestUsage({ threadId: "thread", responseId: "response", usage, format: "protocol" });
    const native = normalizeCodexRequestUsage({ threadId: "thread", responseId: "response", format: "native",
      usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 60,
        output_tokens: 10, reasoning_output_tokens: 5, total_tokens: 110 } });
    expect(native).toEqual(protocol);
    expect(protocol).toMatchObject({ inputTokens: 0, cachedInputTokens: 40, cacheWriteTokens: 60, outputTokens: 10, totalTokens: 110, model: null });
    for (const invalid of [{ ...usage, totalTokens: 78048 }, { ...usage, inputTokens: 99 }, { ...usage, outputTokens: -1 },
      { ...usage, inputTokens: Number.MAX_SAFE_INTEGER + 1 }, { ...usage, cachedInputTokens: 41 },
      { ...usage, cachedInputTokens: undefined }, { ...usage, cacheWriteInputTokens: null }, { ...usage, cacheWriteInputTokens: undefined }]) {
      expect(normalizeCodexRequestUsage({ threadId: "thread", responseId: "response", usage: invalid, format: "protocol" })).toBeNull();
    }
  });

  it.each(["end_turn", "throw", "cancelled", "abort"])("keeps four responses including compaction after %s and isolates the next task", async failure => {
    const provider = new AcpProvider({ agentType: "codex" });
    const source = bridge();
    const abort = new AbortController();
    const interrupted = Promise.withResolvers<never>();
    const stopped = mock(async () => { interrupted.reject(new Error("ACP client stopped")); });
    const realSetTimeout = globalThis.setTimeout;
    // Exercise the real cancellation deadline without spending the test's 5s budget.
    const deadline = failure === "abort" ? spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
      realSetTimeout(callback, delay === 5_000 ? 0 : delay, ...args)) as typeof setTimeout) : null;
    let turn = 0;
    const client = { _options: { onSessionUpdate: (_event: any) => {} }, cancel: async () => {}, stop: stopped, prompt: async () => {
      const emit = (update: any) => client._options.onSessionUpdate({ sessionId: "acp-parent", update });
      if (turn++ > 0) {
        emit(await source.request("next-task", 32));
        return { stopReason: "end_turn", usage: { inputTokens: 22, outputTokens: 10, totalTokens: 32 } };
      }
      for (const [i, total] of [238975, 247635, 86755, 92188].entries()) emit(await source.request(`response-${i}`, total));
      emit(await source.request("response-1", 247635)); // Transport replay, not another compaction request.
      emit(source.context());
      if (failure === "throw") throw new Error("fixture connection failure");
      if (failure === "abort") {
        abort.abort();
        return interrupted.promise; // Unresponsive until the provider stops the bridge.
      }
      return { stopReason: failure === "cancelled" ? "cancelled" : "end_turn",
        usage: { inputTokens: 92178, cachedReadTokens: 92168, outputTokens: 10, totalTokens: 92188 } };
    } };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "acp-parent", models: { currentModelId: "parent-requested-model" } });
    const events: any[] = [];
    const run = async () => { for await (const event of provider.sendStream("synthetic task", { signal: abort.signal })) events.push(event); };
    try {
      if (failure === "end_turn") await run();
      else await expect(run()).rejects.toThrow();
      if (failure === "abort") {
        expect(deadline!.mock.calls.filter(args => args[1] === 5_000)).toHaveLength(1);
        expect(stopped).toHaveBeenCalledTimes(1);
      }
    } finally { deadline?.mockRestore(); stopped.mockRestore(); }
    expect(provider.getLastResponse()?.totalTokens).toBe(665553);
    const units = responseToUsageUnits("codex", provider.getLastResponse(), "requested-model", "turn");
    expect(units.filter(unit => unit.providerRequestId)).toHaveLength(4);
    expect(units.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(665553);
    expect(units.filter(unit => unit.providerRequestId).every(unit => unit.accuracy === "exact" && unit.model === null)).toBe(true);
    expect(events.flatMap(event => event._meta?.remiUsageUnits ?? []).filter(unit => unit.providerRequestId)).toHaveLength(4);
    for await (const _event of provider.sendStream("next synthetic task")) {}
    expect(provider.getLastResponse()?.totalTokens).toBe(32);
  });

  it("preserves a missing response as unknown and never replaces it with final or cumulative counters", async () => {
    const provider = new AcpProvider({ agentType: "codex" });
    const source = bridge();
    const client = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => {
      for (const update of [await source.request("missing", null), source.context()]) {
        client._options.onSessionUpdate({ sessionId: "acp-parent", update });
      }
      return { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
    } };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "acp-parent" });
    for await (const _event of provider.sendStream("synthetic task")) {}
    const units = responseToUsageUnits("codex", provider.getLastResponse(), null, "turn");
    expect(units.filter(unit => unit.providerRequestId)).toEqual([expect.objectContaining({ providerRequestId: "missing", accuracy: "unknown", inputTokens: null, reportedTotalTokens: null })]);
    expect(units.some(unit => unit.evidenceRef === "acp_prompt_settle")).toBe(false);
    expect(units.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(0);
  });

  it("counts matching response IDs in different native child threads independently", async () => {
    const provider = new AcpProvider({ agentType: "codex" });
    const source = bridge();
    const client = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => {
      for (const thread of ["resumed-parent", "child", "child"]) {
        client._options.onSessionUpdate({ sessionId: "acp-parent", update: await source.request("same-short-id", 32, thread) });
      }
      return { stopReason: "end_turn" };
    } };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "acp-parent", models: { currentModelId: "parent-requested-model" } });
    for await (const _event of provider.sendStream("synthetic task")) {}
    expect(provider.getLastResponse()?.totalTokens).toBe(64);
    const units = responseToUsageUnits("codex", provider.getLastResponse(), null, "turn").filter(unit => unit.providerRequestId);
    expect(units.map(unit => unit.providerSessionId)).toEqual(["resumed-parent", "child"]);
    expect(units.find(unit => unit.providerSessionId === "child")).toMatchObject({ requestedModel: null, modelSource: "unknown" });
  });
});
