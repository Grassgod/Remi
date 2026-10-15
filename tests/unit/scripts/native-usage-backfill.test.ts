import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actualUnit, requestUnitId } from "../../../packages/acp/src/usage-collector.js";
import { writeUsageSnapshot } from "../../../packages/server/src/store/usage-accounting.js";
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { exportCodexNativeUsage, type CodexNativeUsageExport } from "../../../scripts/export-codex-native-usage.js";
import { buildNativeUsageBackfill } from "../../../scripts/native-usage-backfill.js";
import { mergeNativeUsageBackfill, type ReconcileUsagePlan } from "../../../scripts/reconcile-task-usage.js";
import { applyUsageReconciliation, verifyUsageReconciliation } from "../../../scripts/usage-reconciliation-store.js";
import { parseNativeUsageEvidence } from "../../../scripts/usage-evidence.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "../multiremi/helpers.js";

// Rollout shapes from codex 0.162.1: a subagent child repeats its root's
// session_meta and names the root as every record's session_id.
const dirs: string[] = [];
afterEach(() => {
  resetMultiremiTestEnv();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ROOT = "019a0000-0000-7000-8000-000000000001", CHILD = "019a0000-0000-7000-8000-000000000002";
const OTHER = "019a0000-0000-7000-8000-000000000003";
const at = (time: string) => `2026-10-12T${time}.000Z`;
const line = (time: string, type: string, payload: unknown) => JSON.stringify({ timestamp: at(time), type, payload }) + "\n";
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached,
  cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const record = (time: string, thread: string, root: string, response: string, value = usage(100, 40, 10)) => line(time, "token_usage_record", {
  thread_id: thread, turn_id: `turn-${response}`, session_id: root, root_turn_id: `turn-${response}`, response_id: response, usage: value });
const transcript = (time: string, text: string) => line(time, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
const rootRollout = (records: string) => line("00:00:00", "session_meta", { id: ROOT, source: "vscode" }) + line("00:00:01", "turn_context", { model: "gpt-6.1-sol" })
  + transcript("00:00:02", "SECRET PROMPT TEXT") + records;
const childRollout = (records: string) => line("00:10:00", "session_meta", { id: CHILD, forked_from_id: ROOT, source: { subagent: { thread_spawn: { parent_thread_id: ROOT } } } })
  + line("00:00:00", "session_meta", { id: ROOT, source: "vscode" }) + record("00:00:05", ROOT, ROOT, "resp_copied_root") + records;
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "remi-native-backfill-"));
  dirs.push(dir);
  return dir;
}
function put(root: string, path: string, body: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), body);
}

describe("Codex native rollout export", () => {
  it("keeps a subagent rollout's own requests under its root and skips copied root records", () => {
    const parsed = parseNativeUsageEvidence("codex", childRollout(record("00:10:05", CHILD, ROOT, "resp_child")), "fixture");
    expect(parsed.units.filter(unit => unit.providerRequestId).map(unit => [unit.providerSessionId, unit.providerRequestId])).toEqual([[CHILD, "resp_child"]]);
    expect(parsed.sourceScopes?.filter(scope => scope.kind === "request").map(scope => scope.rootSessionId)).toEqual([ROOT]);
    expect(parsed).toMatchObject({ rejected: 0, replayed: 1 });
  });

  it("reads provider homes in every daemon layout, never work trees, links or transcript text", async () => {
    const root = home(), outside = home();
    put(root, `.runtime/chat_a/agt_1/1/executions/f1/home/sessions/2026/10/12/rollout-2026-10-12T00-00-00-${ROOT}.jsonl`,
      rootRollout(record("00:05:00", ROOT, ROOT, "resp_runtime") + record("00:01:00", ROOT, ROOT, "resp_early")));
    put(root, `legacy-2026-10-20/.runtime/chat_b/agt_1/1/home/sessions/2026/10/12/rollout-2026-10-12T00-10-00-${CHILD}.jsonl`,
      childRollout(record("00:10:05", CHILD, ROOT, "resp_child")));
    put(root, `env/chat_c/conv/agt_1/main/1/home/archived_sessions/rollout-2026-10-12T00-20-00-${OTHER}.jsonl`,
      line("00:20:00", "session_meta", { id: OTHER }) + record("00:20:05", OTHER, OTHER, "resp_env"));
    // Agent work trees and unrelated top-level directories are not provider history.
    put(root, `.runtime/chat_a/agt_1/1/work/repo/sessions/rollout-x-${OTHER}.jsonl`, record("00:30:00", OTHER, OTHER, "resp_work"));
    put(root, `work/chat_a/sessions/rollout-y-${OTHER}.jsonl`, record("00:30:00", OTHER, OTHER, "resp_top_work"));
    put(outside, `sessions/rollout-z-${OTHER}.jsonl`, record("00:30:00", OTHER, OTHER, "resp_linked"));
    symlinkSync(join(outside, "sessions"), join(root, ".runtime/chat_a/agt_1/1/executions/f1/home/sessions/linked"));
    const exported = await exportCodexNativeUsage({ workspacesRoots: [root], since: at("00:02:00"), host: "daemon-a", now: new Date(at("12:00:00")) });
    expect(exported.requests.map(request => [request.rootSessionId, request.unit.providerSessionId, request.unit.providerRequestId]).sort())
      .toEqual([[OTHER, OTHER, "resp_env"], [ROOT, CHILD, "resp_child"], [ROOT, ROOT, "resp_runtime"]].sort());
    expect(exported.counts).toMatchObject({ files: 3, requests: 3, beforeSince: 1, replayed: 1, unreadable: 0 });
    expect(exported.files.map(file => file.ref)).toContain(`native:daemon-a:workspaces0/.runtime/chat_a/agt_1/1/executions/f1/home/sessions/2026/10/12/rollout-2026-10-12T00-00-00-${ROOT}.jsonl`);
    expect(JSON.stringify(exported)).not.toContain("SECRET PROMPT TEXT");
    // Refs are relative to the scanned root; `sources` alone names the roots for review.
    expect(JSON.stringify([exported.files, exported.requests])).not.toContain(root);
    // An explicit CODEX_HOME or extracted archive is read wherever its rollouts are.
    const scanned = await exportCodexNativeUsage({ scanDirs: [outside], host: "daemon-a" });
    expect(scanned.requests.map(request => request.unit.providerRequestId)).toEqual(["resp_linked"]);
  });
});

describe("reviewed Codex native usage backfill", () => {
  function attempt(store: ReturnType<typeof createLocalStore>, agentId: string, start: string, end: string, status = "completed") {
    const task = store.createTask({ agentId, prompt: "synthetic codex attempt" });
    runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET status=?,provider='codex',session_id=?,started_at=?,completed_at=?,usage='[]' WHERE id=?",
      [status, ROOT, at(start), status === "running" ? null : at(end), task.id]);
    return task.id;
  }
  // What a codex-usage-v6 daemon recorded: one complete live run with a context row.
  const contextOnly = (taskId: string, runId: string) => writeUsageSnapshot(db!, taskId, { version: 2, runId, revision: 2, complete: true, units: [{
    ...actualUnit({ unitId: `context:${runId}`, provider: "codex", scope: "turn", source: "context_snapshot", accuracy: "unknown", requestedModel: "gpt-6.1-sol" }),
    contextTokens: 18_000, contextWindow: 475_000, connectionId: "conn-codex", occurredAt: at("00:00:00") }] }, { historical: true });
  async function evidence(records: { runtime: string; legacy: string }, host: string): Promise<CodexNativeUsageExport> {
    const root = home();
    put(root, `.runtime/chat_a/agt_1/1/home/sessions/2026/10/12/rollout-2026-10-12T00-00-00-${ROOT}.jsonl`, rootRollout(records.runtime));
    put(root, `legacy-2026-10-20/.runtime/chat_a/agt_1/1/home/sessions/2026/10/12/rollout-2026-10-12T00-10-00-${CHILD}.jsonl`, childRollout(records.legacy));
    return exportCodexNativeUsage({ workspacesRoots: [root], host });
  }

  it("adds each attempt's missing requests by session window and keeps every other fact", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "codex", provider: "codex" });
    const first = attempt(store, agent.id, "00:00:00", "01:00:00"), second = attempt(store, agent.id, "01:00:00", "02:00:00");
    const live = attempt(store, agent.id, "02:00:00", "03:00:00"), lost = attempt(store, agent.id, "03:00:00", "04:00:00");
    const running = attempt(store, agent.id, "04:00:00", "05:00:00", "running");
    contextOnly(first, "run-first"); contextOnly(second, "run-second"); contextOnly(lost, "run-lost");
    const recorded = { ...actualUnit({ unitId: requestUnitId("resp_live", ROOT), provider: "codex", providerSessionId: ROOT, providerRequestId: "resp_live",
      scope: "request", source: "provider_request", inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10 }), occurredAt: at("02:30:00") };
    writeUsageSnapshot(db!, live, { version: 2, runId: "run-live", revision: 1, complete: true, units: [recorded] }, { historical: true });
    // The running attempt has no usage yet and is unknown throughout.
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 10, unknown_task_count: 4 });

    const host = await evidence({
      runtime: record("00:05:00", ROOT, ROOT, "resp_a") + record("01:30:00", ROOT, ROOT, "resp_b", usage(200, 0, 20))
        + record("02:30:00", ROOT, ROOT, "resp_live", usage(5, 0, 5)) + record("02:40:00", ROOT, ROOT, "resp_c")
        + record("06:00:00", ROOT, ROOT, "resp_after") + record("00:50:00", ROOT, ROOT, "resp_disputed"),
      legacy: record("00:10:05", CHILD, ROOT, "resp_child", usage(300, 100, 30)),
    }, "daemon-a");
    // The same rollout copied to a second host agrees except for one response.
    const copy = structuredClone(host);
    copy.host = "daemon-b";
    copy.requests.find(request => request.unit.providerRequestId === "resp_disputed")!.unit.outputTokens = 999;
    copy.requests.find(request => request.unit.providerRequestId === "resp_disputed")!.unit.reportedTotalTokens = 1099;

    const native = buildNativeUsageBackfill(db!, [host, copy]);
    expect(native.report.counts).toMatchObject({ requests: 14, duplicateRequests: 6, conflictingRequests: 1, invalidRequests: 0,
      alreadyRecorded: 1, outsideTaskWindow: 1, overlappingTaskWindows: 0, attributed: 4 });
    expect(Object.fromEntries(native.report.tasks.map(task => [task.taskId, [task.outcome, task.requests, task.actualTokens]]))).toEqual({
      [first]: ["repaired", 2, 110 + 330], [second]: ["repaired", 1, 220],
      [live]: ["live_request_usage_present", 1, 110], [lost]: ["no_native_request_evidence", 0, 0],
    });
    expect(native.report.tasks.some(task => task.taskId === running)).toBe(false);
    const repair = native.repairs.find(value => value.taskId === first)!;
    expect(repair.scope).toMatchObject({ providerSessionId: ROOT, descendantSessionIds: [CHILD], runId: "run-first" });
    expect(repair.snapshot.units.map(unit => [unit.unitId, unit.providerSessionId ?? null, unit.connectionId, unit.identityKind ?? null, unit.inputTokens]).sort()).toEqual([
      ["context:run-first", null, "conn-codex", null, null],
      [requestUnitId("resp_a", ROOT), ROOT, "conn-codex", "request", 60],
      [requestUnitId("resp_child", CHILD), CHILD, "conn-codex", "request", 200],
    ].sort());

    const plan: ReconcileUsagePlan = { version: 2, mode: "read-only", generatedAt: at("12:00:00"), tasks: [], limitations: [],
      counts: { tasks: 0, rawEvents: 0, rejected: 0, replayed: 0, ambiguousRawEvents: 0, ambiguousTaskEvents: 0 } };
    mergeNativeUsageBackfill(plan, native);
    expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 2, resumed: 0 });
    expect(verifyUsageReconciliation(db!, plan)).toMatchObject({ tasks: 2, actualTokens: 440 + 220 });
    expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 0, resumed: 2 });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 10 + 440 + 220, unknown_task_count: 2 });
    expect(db!.query("SELECT context_tokens FROM multiremi_usage_units WHERE task_id=? AND unit_id='context:run-first'").get(first)).toEqual({ context_tokens: 18_000 });

    // A later plan never adds to a repaired attempt, even a request that was
    // disputed before: every host's export belongs in the one reviewed plan.
    const again = buildNativeUsageBackfill(db!, [host]);
    expect(again.repairs).toEqual([]);
    expect(again.report.counts.alreadyRecorded).toBe(4);
    expect(again.report.tasks.find(task => task.taskId === first)).toMatchObject({ outcome: "live_request_usage_present", requests: 1 });
  });

  it("leaves requests in overlapping attempt windows unattributed", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "codex", provider: "codex" });
    const first = attempt(store, agent.id, "00:00:00", "01:00:00"), overlapping = attempt(store, agent.id, "00:30:00", "02:00:00");
    contextOnly(first, "run-first"); contextOnly(overlapping, "run-overlapping");
    const native = buildNativeUsageBackfill(db!, [await evidence({ runtime: record("00:45:00", ROOT, ROOT, "resp_both") + record("00:10:00", ROOT, ROOT, "resp_first"), legacy: "" }, "daemon-a")]);
    expect(native.report.counts).toMatchObject({ overlappingTaskWindows: 1, attributed: 1 });
    expect(native.repairs.map(repair => [repair.taskId, repair.correctedRequestIds])).toEqual([[first, ["resp_first"]]]);
  });
});
