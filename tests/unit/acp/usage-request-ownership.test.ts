import { afterEach, describe, expect, it } from "bun:test";
import { AcpProvider } from "@acp/provider.js";
import { claudeUsagePatch, codexUsagePatch } from "@acp/usage-bridge-patches.js";
import { responseToUsageUnits } from "@multiremi/worker/acp-event-mapper.js";
import { TaskUsageLedger } from "@multiremi/worker/task-usage-ledger.js";
import { createLocalStore, resetMultiremiTestEnv } from "../multiremi/helpers.js";

afterEach(resetMultiremiTestEnv);
const codexBoundary = "  async createUpdateEvent(notification) { return null; }\n  createUsageUpdate(params) {}\n  handleRateLimitsUpdated(params) {}";
const vector = (n: number) => ({ inputTokens: 100 * n, cachedInputTokens: 0, outputTokens: 10 * n, reasoningOutputTokens: 0, totalTokens: 110 * n });
async function collect(providerType: "claude" | "codex", updates: any[], connection: string | null, runId: string) {
  const provider = new AcpProvider({ agentType: providerType });
  const client = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => {
    for (const update of updates) if (update) client._options.onSessionUpdate({ sessionId: "acp-envelope", update });
    return { stopReason: "end_turn" };
  } };
  (provider as any)._ensureSession = async () => ({ client, acpSessionId: "acp-envelope" });
  const ledger = new TaskUsageLedger(connection, runId);
  for await (const event of provider.sendStream("actual parser fixture")) if ((event as any)._meta?.remiUsageUnits) ledger.observe((event as any)._meta.remiUsageUnits);
  ledger.observe(responseToUsageUnits(providerType, provider.getLastResponse(), null, "turn"));
  return ledger.finish();
}
function actor(sessionId = "thread", epoch: string | null = "initial") {
  const Handler = new Function(`return class { ${codexUsagePatch(codexBoundary)!} }`)();
  const handler = new Handler();
  handler.sessionState = { sessionId, remiMeterEpochId: epoch, totalTokenUsage: null };
  handler.handleTokenUsageUpdated = (p: any) => Object.assign(handler.sessionState, { totalTokenUsage: p.tokenUsage.total, lastTokenUsage: p.tokenUsage.last });
  return { handler, notify: (n: number) => handler.createUsageUpdate({ threadId: sessionId, tokenUsage: { total: vector(n), last: vector(1) } }) };
}

describe("actual provider identities survive parsing and canonical ownership", () => {
  it.each(["same-request", "different-session", "different-connection"] as const)("accounts Claude %s across task/run ownership", async scenario => {
    const consume = new Function("session", "message", "params", `return (async () => { ${claudeUsagePatch("                if (session.emitRawSDKMessages && false) {}")!} })();`);
    const updates = async (sessionId: string) => {
      const result: any[] = [];
      await consume.call({ client: { sessionUpdate: async (event: any) => result.push(event.update) } }, {},
        { type: "assistant", session_id: sessionId, message: { id: "same-short-id", model: "opus", usage: { input_tokens: 10, output_tokens: 2 } } },
        { sessionId: "acp-envelope" });
      return result;
    };
    const store = createLocalStore();
    const agent = store.createAgent({ name: "true request owner", provider: "claude" });
    const first = store.createTask({ agentId: agent.id, prompt: "first" }), second = store.createTask({ agentId: agent.id, prompt: "second" });
    const a = await collect("claude", await updates("native-session-a"), "route-a", "first-run");
    const b = await collect("claude", await updates(scenario === "different-session" ? "native-session-b" : "native-session-a"), scenario === "different-connection" ? "route-b" : "route-a", "second-run");
    expect(a.units[0]).toMatchObject({ providerSessionId: "native-session-a", providerRequestId: "same-short-id", identityKind: "request", inputTokens: 10, outputTokens: 2 });
    store.reportTaskUsageSnapshot(first.id, a);
    store.reportTaskUsageSnapshot(second.id, b);
    store.reportTaskUsageSnapshot(second.id, b);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(scenario === "same-request" ? 12 : 24);
    if (scenario === "same-request") {
      expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.complete).toBe(false);
      store.reportTaskUsageSnapshot(first.id, { ...a, runId: "third-run" });
      expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(12);
    }
  });

  it("counts disjoint Codex meter intervals once across cumulative reordering, replayed runs and overlapping observations", async () => {
    const source = actor();
    const updates = [1, 3, 2, 4].map(n => source.notify(n));
    const a = await collect("codex", updates, "meter-route", "meter-run-a");
    const b = await collect("codex", updates, "meter-route", "meter-run-b");
    const units = a.units.filter(unit => unit.meterEvidence);
    expect(units.map(unit => unit.reportedTotalTokens)).toEqual([110, 220, 110]);
    expect(units.every(unit => unit.identityKind === "cumulative_meter" && !unit.providerRequestId && unit.providerSessionId === "thread")).toBe(true);
    const store = createLocalStore();
    const agent = store.createAgent({ name: "meter owner", provider: "codex" });
    const first = store.createTask({ agentId: agent.id, prompt: "first" }), second = store.createTask({ agentId: agent.id, prompt: "replay" });
    store.reportTaskUsageSnapshot(first.id, a);
    store.reportTaskUsageSnapshot(second.id, b);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(440);
    // This observation's endpoint is new, but its interval overlaps the earlier
    // (110,330] checkpoint. An endpoint-only dedup would incorrectly add 110.
    const overlap = actor();
    const c = await collect("codex", [overlap.notify(1), overlap.notify(2)], "meter-route", "meter-run-c");
    store.reportTaskUsageSnapshot(second.id, c);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(440);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.complete).toBe(false);
  });

  it("retains valid Codex consumption after an explicit compaction and diagnoses resumed epochs without fabricating request IDs", async () => {
    const source = actor();
    const before = source.notify(3);
    await source.handler.createUpdateEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { type: "contextCompaction", id: "real-compaction-item" } } });
    const after = source.notify(1), next = source.notify(2);
    const snapshot = await collect("codex", [before, after, next], "route", "compacted");
    expect(snapshot.units.filter(unit => unit.meterEvidence).map(unit => [unit.reportedTotalTokens, unit.meterEvidence!.epochId])).toEqual([
      [110, "initial"], [110, "compaction-item:real-compaction-item"], [110, "compaction-item:real-compaction-item"],
    ]);
    const unknown = await collect("codex", [actor("resumed", null).notify(3)], "route", "resumed-unknown");
    expect(unknown.units.every(unit => !unit.providerRequestId && !unit.meterEvidence)).toBe(true);
    expect(unknown.units[0]).toMatchObject({ accuracy: "unknown", inputTokens: null, outputTokens: null, reportedTotalTokens: 110 });
  });
});
