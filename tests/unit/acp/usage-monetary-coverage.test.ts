import { afterEach, describe, expect, it } from "bun:test";
import { AcpProvider } from "@acp/provider.js";
import { responseToUsageUnits } from "@multiremi/worker/acp-event-mapper.js";
import { TaskUsageLedger } from "@multiremi/worker/task-usage-ledger.js";
import { createLocalStore, resetMultiremiTestEnv } from "../multiremi/helpers.js";

afterEach(resetMultiremiTestEnv);

describe("provider monetary evidence covers the requests actually billed", () => {
  it.each([0.25, 0])("records USD %s once when request cost arrives before tokens and the prompt throws", async amount => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "money", provider: "claude", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "work", workspaceId: "local" });
    store.setUsagePrice("local", { provider: "claude", model: "opus", connection_id: null, requested_model_alias: false,
      currency: "USD", input_per_million: 2, output_per_million: 0, cache_read_per_million: 0, cache_write_per_million: 0,
      unsplit_per_million: null, source: "configured", source_url: null, effective_from: "2026-01-01T00:00:00Z", effective_to: null });
    const provider = new AcpProvider({ agentType: "claude" });
    const client = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => {
      const send = (update: any) => client._options.onSessionUpdate({ sessionId: "s", update });
      send({ sessionUpdate: "usage_update", used: 0, size: 0, cost: { amount, currency: "USD" },
        _meta: { remiCostUsage: { scope: "request", source: "provider_reported", requestId: "charged-request" } } });
      send({ sessionUpdate: "usage_update", used: 0, size: 0, _meta: { remiTokenUsage: {
        id: "charged-request", model: "opus", scope: "request_snapshot", inputTokens: 1_000_000,
        outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000,
      } } });
      throw new Error("after provider cost and token evidence");
    } };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    const ledger = new TaskUsageLedger(null, "accepted-run");
    const observations: Record<string, number>[] = [];
    await expect((async () => { for await (const event of provider.sendStream("work")) {
      const changed = (event as any)._meta?.remiUsageUnits;
      const checkpoint = changed && ledger.observe(changed);
      if (checkpoint) {
        store.reportTaskUsageSnapshot(task.id, checkpoint);
        observations.push(store.getUsageReport({ workspaceId: "local", days: null }).summary.known_cost_by_currency);
      }
    } })()).rejects.toThrow();
    expect(observations).toEqual([{}, { USD: amount }]);
    const units = responseToUsageUnits("claude", provider.getLastResponse(), null, "turn");
    const monetary = units.find(unit => unit.costAmount !== null)!;
    expect(monetary).toMatchObject({ costAmount: amount, coveredUnitIds: ["request:charged-request"] });
    const finalChanges = ledger.observe(units);
    if (finalChanges) store.reportTaskUsageSnapshot(task.id, finalChanges);
    const final = ledger.finish();
    store.reportTaskUsageSnapshot(task.id, final);
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ actual_total_tokens: 1_000_000, priced_tokens: 1_000_000,
      unpriced_tokens: 0, known_cost_by_currency: { USD: amount }, complete: true });
    store.reportTaskUsageSnapshot(task.id, final);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.known_cost_by_currency).toEqual({ USD: amount });
  });

  it("links a provider turn charge to both main and child requests, including final fallback usage", async () => {
    const provider = new AcpProvider({ agentType: "claude" });
    const client = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => {
      const send = (update: any) => client._options.onSessionUpdate({ sessionId: "s", update });
      send({ sessionUpdate: "usage_update", used: 0, size: 0, cost: { amount: 0.25, currency: "USD" },
        _meta: { remiCostUsage: { scope: "turn", source: "provider_reported" } } });
      for (const [id, model] of [["main", "opus"], ["child", "haiku"]]) send({ sessionUpdate: "usage_update", used: 0, size: 0,
        _meta: { remiTokenUsage: { id, model, inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12 } } });
      return { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } };
    } };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    for await (const _event of provider.sendStream("work")) {}
    expect(responseToUsageUnits("claude", provider.getLastResponse(), null, "turn").find(unit => unit.costAmount !== null))
      .toMatchObject({ coveredUnitIds: ["request:child", "request:main"] });

    const fallback = new AcpProvider({ agentType: "claude" });
    const fallbackClient = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => {
      fallbackClient._options.onSessionUpdate({ sessionId: "s", update: { sessionUpdate: "usage_update", used: 0, size: 0,
        cost: { amount: 0.25, currency: "USD" }, _meta: { remiCostUsage: { scope: "turn", source: "provider_reported" } } } });
      return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
    } };
    (fallback as any)._ensureSession = async () => ({ client: fallbackClient, acpSessionId: "s" });
    for await (const _event of fallback.sendStream("work")) {}
    const fallbackUnits = responseToUsageUnits("claude", fallback.getLastResponse(), null, "turn");
    expect(fallbackUnits.find(unit => unit.costAmount !== null)!.coveredUnitIds)
      .toEqual([fallbackUnits.find(unit => unit.costAmount === null)!.unitId]);
  });
});
