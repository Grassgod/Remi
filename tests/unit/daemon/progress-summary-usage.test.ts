import { afterEach, describe, expect, it } from "bun:test";
import { TaskProgressSummarizer, PROGRESS_SUMMARY_DEFAULTS } from "@multiremi/worker/progress-summarizer.js";
import { TaskUsageLedger } from "@multiremi/worker/task-usage-ledger.js";
import { actualUnit, unitActualTotal } from "@acp/usage-collector.js";
import type { TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "../multiremi/helpers.js";

afterEach(resetMultiremiTestEnv);
const config = { enabled: true, ...PROGRESS_SUMMARY_DEFAULTS, minNewMessages: 1, minIntervalMs: 0, requestTimeoutMs: 5000, transport: "api" as const };
const stream = (text: string) => new Blob([text]).stream();

describe("task auxiliary consumption accounting", () => {
  it("persists an actual auxiliary API model arriving after task completion and closes the run only after the helper", async () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ name: "summary", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "summary", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "main", workspaceId: "local" });
    store.claimTask(runtime.id);
    const ledger = new TaskUsageLedger("workspace:local:relay:claude", "accepted-run");
    store.startTask(task.id, ledger.runId);
    const report = (snapshot: ReturnType<typeof ledger.observe>) => { if (snapshot) store.reportTaskUsageSnapshot(task.id, snapshot); };
    report(ledger.observe([actualUnit({ unitId: "main", provider: "claude", model: "opus", scope: "request", source: "provider_request", inputTokens: 10, outputTokens: 2 })]));
    const releaseScope = ledger.deferCompletion();
    let received!: () => void, resolveReply!: () => void;
    const receivedRequest = new Promise<void>(resolve => { received = resolve; });
    const replyGate = new Promise<void>(resolve => { resolveReply = resolve; });
    const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      expect((await request.json() as any).model).toBe("requested-haiku");
      received();
      await replyGate;
      return Response.json({ model: "actual-haiku", usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
        content: [{ type: "text", text: '{"summary":"done"}' }] });
    } });
    try {
      const summarizer = new TaskProgressSummarizer({ config: { ...config, model: "requested-haiku" }, credentials: { baseUrl: `http://127.0.0.1:${api.port}`, apiKey: "fixture" },
        taskTitle: "summary", taskPrompt: "main", report: async () => {},
        onUsage: units => report(ledger.observe(units)), onClosed: () => report(releaseScope()) });
      const work = summarizer.finalize("completed");
      await receivedRequest;
      store.completeTask(task.id, { output: "main done" });
      report(ledger.finish());
      expect(ledger.snapshot.complete).toBe(false);
      expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(12);
      resolveReply();
      await work;
      expect(ledger.snapshot.complete).toBe(true);
      expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(32);
      const helper = ledger.snapshot.units.filter(unit => unit.purpose === "progress_summary");
      expect(helper).toEqual([expect.objectContaining({ provider: "claude", model: "actual-haiku", requestedModel: "requested-haiku", connectionId: null,
        inputTokens: 10, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2, accuracy: "exact" })]);
      expect((db!.query("SELECT complete FROM multiremi_usage_runs WHERE task_id=? AND run_id=?").get(task.id, ledger.runId) as any).complete).toBe(1);
      expect(store.getTask(task.id)?.status).toBe("completed");
    } finally { resolveReply(); api.stop(true); }
  });

  it("preserves one unknown failed attempt and a distinct OpenAI fallback request, splitting cached input once", async () => {
    const ledger = new TaskUsageLedger();
    let calls = 0;
    const summarizer = new TaskProgressSummarizer({ config: { ...config, transport: "auto", openAi: { baseUrl: "https://fixture", model: "requested-luna", apiKey: "fixture" } },
      credentials: { baseUrl: "https://fixture", apiKey: "fixture" }, taskTitle: "summary", taskPrompt: "main", report: async () => {},
      onUsage: units => { ledger.observe(units); }, fetchImpl: async () => {
        if (calls++ === 0) return Response.json({ error: "unavailable" }, { status: 503 });
        return Response.json({ model: "actual-haiku", usage: { input_tokens: 4, output_tokens: 2 }, content: [{ type: "text", text: '{"summary":"done"}' }] });
      } });
    await summarizer.finalize("failed");
    expect(ledger.snapshot.units).toHaveLength(2);
    expect(ledger.snapshot.units[0]).toMatchObject({ provider: "openai", model: null, requestedModel: "requested-luna", accuracy: "unknown", inputTokens: null });
    expect(ledger.snapshot.units[1]).toMatchObject({ provider: "claude", model: "actual-haiku", inputTokens: 4, outputTokens: 2 });
    const observed: TaskUsageUnit[] = [];
    const openai = new TaskProgressSummarizer({ config: { ...config, transport: "openai", openAi: { baseUrl: "https://fixture", model: "requested-luna", apiKey: "fixture" } },
      taskTitle: "summary", taskPrompt: "main", report: async () => {}, onUsage: units => { observed.push(...units); },
      fetchImpl: async () => Response.json({ model: "actual-luna", usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 10 } },
        choices: [{ message: { content: '{"summary":"done"}' } }] }) });
    await openai.finalize("completed");
    expect(observed.at(-1)).toMatchObject({ model: "actual-luna", inputTokens: 20, cacheReadTokens: 80, outputTokens: 20, reportedTotalTokens: 120 });
    expect(unitActualTotal(observed.at(-1)!)).toBe(120);
  });

  it.each([0, 1])("captures Claude CLI JSON usage/model and SDK monetary evidence before exit %s", async exitCode => {
    const ledger = new TaskUsageLedger();
    const reported: string[] = [];
    const summarizer = new TaskProgressSummarizer({ config: { ...config, transport: "cli" }, taskTitle: "summary", taskPrompt: "main",
      onUsage: units => { ledger.observe(units); }, report: async result => { reported.push(result.summary); }, whichImpl: () => "fixture-cli",
      spawnImpl: () => ({ exited: Promise.resolve(exitCode), kill: () => {}, stderr: stream(""), stdout: stream(JSON.stringify({ type: "result", result: '{"summary":"CLI done"}', total_cost_usd: 0.25,
        usage: { input_tokens: 1000, output_tokens: 1000 }, modelUsage: { "actual-haiku": { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 4, cacheCreationInputTokens: 1 } } })) }) });
    await summarizer.finalize(exitCode ? "failed" : "completed");
    expect(ledger.snapshot.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(10);
    expect(ledger.snapshot.units.find(unit => unit.model === "actual-haiku")).toMatchObject({ purpose: "progress_summary", scope: "turn", inputTokens: 3, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 });
    expect(ledger.snapshot.units.find(unit => unit.costAmount !== null)).toMatchObject({ costAmount: 0.25, costCurrency: "USD", costSource: "sdk_estimate", scope: "turn" });
    expect(reported).toEqual(exitCode ? [] : ["CLI done"]);
  });

  it("keeps a failed helper's unknown consumption visible beside an exact main request", async () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ name: "summary", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "summary", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "main", workspaceId: "local" });
    store.claimTask(runtime.id);
    const ledger = new TaskUsageLedger(null, "accepted-helper-failure");
    store.startTask(task.id, ledger.runId);
    const save = (snapshot: ReturnType<typeof ledger.observe>) => { if (snapshot) store.reportTaskUsageSnapshot(task.id, snapshot); };
    save(ledger.observe([actualUnit({ unitId: "main", provider: "claude", model: "opus", scope: "request", source: "provider_request", inputTokens: 10, outputTokens: 2 })]));
    const summarizer = new TaskProgressSummarizer({ config, credentials: { baseUrl: "https://fixture", apiKey: "fixture" }, taskTitle: "summary", taskPrompt: "main",
      report: async () => {}, onUsage: units => save(ledger.observe(units)), fetchImpl: async () => { throw new Error("request sent but reply lost"); } });
    await summarizer.finalize("failed");
    save(ledger.finish());
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 12, unknown_task_count: 1, complete: false });
  });
});
