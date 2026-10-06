import { describe, expect, it } from "bun:test";
import { AcpProvider } from "@acp/provider.js";
import { responseToUsageUnits } from "@multiremi/worker/acp-event-mapper.js";

const request = (id: string, model: string | null, input: number, output: number, total = input + output, accuracy = "exact") => ({
  sessionUpdate: "usage_update", used: 50000, size: 200000,
  _meta: { remiTokenUsage: { id, model, scope: "request_snapshot", source: "claude_assistant_usage", accuracy, inputTokens: input, cachedInputTokens: 0, outputTokens: output, totalTokens: total } },
});

describe("ACP usage survives unsuccessful prompts", () => {
  it("captures usage arriving between cancel ACK and prompt settlement", async () => {
    const provider = new AcpProvider({ agentType: "claude" });
    const abort = new AbortController();
    let settle: (value: any) => void = () => {};
    const client = {
      _options: { onSessionUpdate: (_event: any) => {} },
      prompt: async () => {
        client._options.onSessionUpdate({ sessionId: "s", update: request("request", "opus", 10, 0, 10, "partial") });
        abort.abort();
        return new Promise(resolve => { settle = resolve; });
      },
      cancel: async () => {
        setTimeout(() => {
          client._options.onSessionUpdate({ sessionId: "s", update: request("request", "opus", 10, 8) });
          settle({ stopReason: "cancelled", usage: { totalTokens: 0 } });
        }, 5);
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    const streamed: any[] = [];
    await expect((async () => { for await (const event of provider.sendStream("work", { signal: abort.signal })) streamed.push(event); })()).rejects.toThrow("Cancelled");
    expect(provider.getLastResponse()?.totalTokens).toBe(18);
    expect(streamed.filter(event => event._meta?.remiTokenUsage).map(event => event._meta.remiTokenUsage.outputTokens)).toEqual([0, 8]);
  });
  it.each(["throw", "cancelled", "abort"])("keeps multi-request and child usage after %s and isolates the next turn", async (failure) => {
    const provider = new AcpProvider({ agentType: "claude" });
    const abort = new AbortController();
    let turn = 0;
    let settleAbort: (value: any) => void = () => {};
    const client = {
      typedSessionFailures: true, _options: { onSessionUpdate: (_event: any) => {} },
      cancel: async () => { settleAbort({ stopReason: "cancelled", usage: { totalTokens: 0 } }); },
      prompt: async () => {
        const notify = (update: any) => client._options.onSessionUpdate({ sessionId: "s", update });
        if (turn++ > 0) {
          notify(request("followup", "sonnet", 4, 3));
          return { stopReason: "end_turn", usage: { totalTokens: 7 } };
        }
        notify(request("main", "opus", 10, 0, 10, "partial"));
        notify(request("child", "haiku", 5, 2));
        notify(request("main", "opus", 10, 8));
        notify(request("main", "opus", 10, 8)); // transport replay
        notify({ sessionUpdate: "usage_update", used: 70000, size: 200000 }); // context only
        if (failure === "throw") throw new Error("network ended mid-prompt");
        if (failure === "abort") {
          abort.abort();
          return new Promise<any>(resolve => { settleAbort = resolve; });
        }
        return { stopReason: "cancelled", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    const drain = async (signal?: AbortSignal) => { for await (const _event of provider.sendStream("work", { signal })) {} };
    await expect(drain(abort.signal)).rejects.toThrow();
    const usage = responseToUsageUnits("claude", provider.getLastResponse(), "configured-last-model", "turn1").filter(unit => unit.source !== "context_snapshot");
    expect(usage).toEqual([
      expect.objectContaining({ model: "opus", reportedTotalTokens: 18, inputTokens: 10, outputTokens: 8, accuracy: "exact" }),
      expect.objectContaining({ model: "haiku", reportedTotalTokens: 7, inputTokens: 5, outputTokens: 2 }),
    ]);
    expect(provider.getLastResponse()?.totalTokens).toBe(25);
    await drain();
    expect(responseToUsageUnits("claude", provider.getLastResponse(), null, "turn2").filter(unit => unit.source !== "context_snapshot")).toEqual([
      expect.objectContaining({ model: "sonnet", reportedTotalTokens: 7 }),
    ]);
  });

  it("retains total-only evidence with uncertainty and never attributes it to the last model", async () => {
    const provider = new AcpProvider({ agentType: "codex" });
    const client = {
      _options: { onSessionUpdate: (_event: any) => {} },
      prompt: async () => {
        client._options.onSessionUpdate({ sessionId: "s", update: request("unknown", null, 0, 0, 1200) });
        return { stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 1200 } };
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    for await (const _event of provider.sendStream("work")) {}
    expect(responseToUsageUnits("codex", provider.getLastResponse(), "gpt-latest", "turn1").filter(unit => unit.source !== "context_snapshot")).toEqual([
      expect.objectContaining({ model: null, actualUnsplitTokens: null, reportedTotalTokens: 1200, inputTokens: null, accuracy: "unknown", source: "provider_request", requestedModel: "gpt-latest" }),
    ]);
  });
  it.each([0.25, 0])("preserves a USD %s SDK estimate with request units even when the prompt throws", async (amount) => {
    const provider = new AcpProvider({ agentType: "claude" });
    const client = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => {
      client._options.onSessionUpdate({ sessionId: "s", update: request("priced-request", "opus", 10, 2) });
      client._options.onSessionUpdate({ sessionId: "s", update: { sessionUpdate: "usage_update", used: 0, size: 0,
        cost: { amount, currency: "USD" }, _meta: { remiCostUsage: { scope: "turn", source: "sdk_estimate" } } } });
      throw new Error("post-usage failure");
    } };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    await expect((async () => { for await (const _event of provider.sendStream("work")) {} })()).rejects.toThrow();
    const monetary = responseToUsageUnits("claude", provider.getLastResponse(), null, "turn").filter(unit => unit.costAmount !== null);
    expect(monetary).toEqual([expect.objectContaining({ costAmount: amount, costCurrency: "USD", costSource: "sdk_estimate", scope: "turn",
      inputTokens: null, outputTokens: null, actualUnsplitTokens: null })]);
  });
  it("preserves a compaction total in the settle fallback without counting consumption", async () => {
    const provider = new AcpProvider({ agentType: "codex" });
    const client = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => ({ stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 78048 } }) };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    for await (const _event of provider.sendStream("work")) {}
    expect(responseToUsageUnits("codex", provider.getLastResponse(), null, "turn")).toEqual([
      expect.objectContaining({ source: "provider_turn", reportedTotalTokens: 78048, inputTokens: null, outputTokens: null, actualUnsplitTokens: null, accuracy: "unknown" }),
    ]);
  });
});
