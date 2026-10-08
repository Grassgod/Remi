import { afterEach, describe, expect, it } from "bun:test";
import { AcpProvider } from "@acp/provider.js";
import { claudeUsagePatch, codexUsagePatch } from "@acp/usage-bridge-patches.js";
import { responseToUsageUnits } from "@multiremi/worker/acp-event-mapper.js";
import { TaskUsageLedger } from "@multiremi/worker/task-usage-ledger.js";
import { createLocalStore, resetMultiremiTestEnv } from "../multiremi/helpers.js";

afterEach(resetMultiremiTestEnv);
const codexBoundary = "  async handleNotification(notification) {}\n  async createUpdateEvent(notification) { switch(notification.method) { case \"rawResponse/completed\": return null; } }\n  createUsageUpdate(params) {}\n  handleRateLimitsUpdated(params) {}\n  routeChild(childEvent, session) { if (session.current.supportsSubagents) session.current.dispatch(childEvent); }";
const vector = (n: number) => ({ inputTokens: 100 * n, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10 * n, reasoningOutputTokens: 0, totalTokens: 110 * n });
async function collect(providerType: "claude" | "codex", updates: any[], connection: string | null, runId: string) {
  const provider = new AcpProvider({ agentType: providerType });
  const client = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => {
    for (const pending of updates) {
      const update = await pending;
      if (update) client._options.onSessionUpdate({ sessionId: "acp-envelope", update });
    }
    return { stopReason: "end_turn" };
  } };
  (provider as any)._ensureSession = async () => ({ client, acpSessionId: "acp-envelope" });
  const ledger = new TaskUsageLedger(connection, runId);
  for await (const event of provider.sendStream("actual parser fixture")) if ((event as any)._meta?.remiUsageUnits) ledger.observe((event as any)._meta.remiUsageUnits);
  ledger.observe(responseToUsageUnits(providerType, provider.getLastResponse(), null, "turn"));
  return ledger.finish();
}
function actor(sessionId = "thread") {
  const Handler = new Function(`return class { ${codexUsagePatch(codexBoundary)!} }`)();
  const handler = new Handler();
  handler.sessionState = { sessionId, totalTokenUsage: null };
  handler.handleTokenUsageUpdated = (p: any) => Object.assign(handler.sessionState, { totalTokenUsage: p.tokenUsage.total, lastTokenUsage: p.tokenUsage.last });
  return { handler, notify: (id: number, usage = vector(1)) => handler.createUpdateEvent({ method: "rawResponse/completed",
    params: { threadId: sessionId, turnId: "turn", responseId: `response-${id}`, usage } }) };
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

  it("counts independent Codex responses once across notification reordering, replayed tasks and runs", async () => {
    const source = actor();
    const updates = [1, 3, 2, 4, 2].map(n => source.notify(n));
    const a = await collect("codex", updates, "meter-route", "meter-run-a");
    const b = await collect("codex", updates, "meter-route", "meter-run-b");
    const units = a.units.filter(unit => unit.providerRequestId);
    expect(units.map(unit => unit.reportedTotalTokens)).toEqual([110, 110, 110, 110]);
    expect(units.every(unit => unit.identityKind === "request" && !unit.meterEvidence && unit.providerSessionId === "thread")).toBe(true);
    const store = createLocalStore();
    const agent = store.createAgent({ name: "meter owner", provider: "codex" });
    const first = store.createTask({ agentId: agent.id, prompt: "first" }), second = store.createTask({ agentId: agent.id, prompt: "replay" });
    store.reportTaskUsageSnapshot(first.id, a);
    store.reportTaskUsageSnapshot(second.id, b);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(440);
    // A second task observing the same response cannot count it again.
    const overlap = actor();
    const c = await collect("codex", [overlap.notify(1), overlap.notify(2)], "meter-route", "meter-run-c");
    store.reportTaskUsageSnapshot(second.id, c);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(440);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.complete).toBe(false);
  });

  it("includes a resumed thread's compaction response with no cumulative epoch or historical consumption", async () => {
    const source = actor("resumed-native");
    const totals = [238975, 247635, 86755, 92188];
    const updates = totals.map((total, i) => source.notify(i, { inputTokens: total - 10, outputTokens: 10,
      cachedInputTokens: total - 20, cacheWriteInputTokens: 0, reasoningOutputTokens: 5, totalTokens: total }));
    const snapshot = await collect("codex", updates, "route", "compacted");
    expect(snapshot.units.map(unit => unit.reportedTotalTokens)).toEqual(totals);
    expect(snapshot.units.every(unit => unit.accuracy === "exact" && unit.providerSessionId === "resumed-native" && !unit.meterEvidence)).toBe(true);
    const store = createLocalStore();
    const agent = store.createAgent({ name: "resumed", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "compacted" });
    store.reportTaskUsageSnapshot(task.id, snapshot);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 665553, unknown_task_count: 0 });
  });
});
