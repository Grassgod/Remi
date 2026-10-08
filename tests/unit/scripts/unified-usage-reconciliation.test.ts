import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actualUnit, requestUnitId } from "@acp/usage-collector.js";
import { writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { ZipStreamWriter } from "@shared/zip/writer.js";
import { buildReconcileUsagePlan } from "../../../scripts/reconcile-task-usage.js";
import { applyUsageReconciliation, verifyUsageReconciliation } from "../../../scripts/usage-reconciliation-store.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "../multiremi/helpers.js";

const at = "2026-10-01T01:00:00.000Z";
const roots: string[] = [];
afterEach(() => {
  resetMultiremiTestEnv();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture(provider: "claude" | "codex" = "claude") {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Unified archived usage", provider });
  const task = store.createTask({ agentId: agent.id, prompt: "archived attempt evidence" });
  runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET status='completed',provider=?,session_id='native-session',started_at='2026-10-01T00:00:00Z',completed_at='2026-10-01T02:00:00Z',usage='[]' WHERE id=?", [provider, task.id]);
  return { store, agent, task };
}

async function archive(taskId: string, kind: "trace" | "provider", rows: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "unified-usage-evidence-"));
  roots.push(root);
  const chunks: Buffer[] = [];
  const writer = new ZipStreamWriter({ write: chunk => { chunks.push(chunk); } });
  const body = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const member = await writer.addBuffer(kind === "trace" ? `traces/${taskId}.jsonl` : "native/session.jsonl", body, hash(body));
  const index = Buffer.from(JSON.stringify({ format: "multiremi.session-archive.v2", subject: { kind: "task", id: taskId }, members: [{
    path: member.path, kind, local_header_offset: member.localHeaderOffset, data_offset: member.dataOffset,
    compressed_size: member.compressedSize, uncompressed_size: member.uncompressedSize, sha256: member.sha256,
    ...(kind === "trace" ? { task_id: taskId, head: 1, event_count: 1, closed: true } : {}),
  }] }));
  await writer.addBuffer("index.json", index, hash(index));
  await writer.finish();
  await Bun.write(join(root, "evidence.zip"), Buffer.concat(chunks));
  const sql = { unsafe: async (statement: string, params: any[] = []) => statement.includes("FROM multiremi_session_archives")
    ? [{ id: "archive", relative_path: "evidence.zip", subject_kind: "task", subject_id: taskId, format: "multiremi.session-archive.v2" }]
    : db!.query(statement.replace(/\$\d+/g, "?")).all(...params) } as unknown as Bun.SQL;
  return { root, sql };
}

describe("usage evidence on unified attempts", () => {
  for (const provider of ["claude", "codex"] as const) it(`plans, applies and resumes final ${provider} request repair from a native archive`, async () => {
    const { store, task } = fixture(provider);
    const early = provider === "claude"
      ? actualUnit({ unitId: requestUnitId("response", "native-session"), provider, providerSessionId: "native-session", providerRequestId: "response", scope: "request", source: "provider_request", inputTokens: 10, outputTokens: 1, cacheReadTokens: 20, cacheWriteTokens: 0 })
      : actualUnit({ unitId: 'request:native-session:epoch:0:{"inputTokens":10,"cachedInputTokens":20,"outputTokens":1,"totalTokens":31}', provider, scope: "request", source: "provider_request", accuracy: "unknown", evidenceRef: "codex_meter_epoch_unresolved" });
    early.occurredAt = at;
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "original-run", revision: 1, complete: true, units: [early] }, { historical: true });
    const rows = provider === "claude"
      ? [{ type: "assistant", timestamp: at, sessionId: "native-session", message: { id: "response", stop_reason: "end_turn", model: "actual-model", usage: { input_tokens: 10, output_tokens: 11, cache_read_input_tokens: 20 } } }]
      : [{ type: "session_meta", payload: { id: "native-session" } },
        { type: "event_msg", timestamp: "2026-10-01T00:30:00Z", payload: { type: "task_started", turn_id: "native-turn" } },
        { type: "token_usage_record", timestamp: at, payload: { thread_id: "native-session", turn_id: "native-turn", response_id: "response", usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 11, total_tokens: 41 }, turn_token_usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 11, total_tokens: 41 } } },
        { type: "event_msg", timestamp: "2026-10-01T01:30:00Z", payload: { type: "task_complete", turn_id: "native-turn" } }];
    const { root, sql } = await archive(task.id, "provider", rows);
    const plan = await buildReconcileUsagePlan(sql, { archiveRoot: root, taskId: task.id });
    expect(plan.tasks).toHaveLength(0);
    expect(plan.modernRepairs).toHaveLength(1);
    expect(plan.modernRepairs![0]).toMatchObject({ taskId: task.id, afterActualTokens: 41, snapshot: { runId: "original-run" } });
    expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 1, resumed: 0 });
    expect(verifyUsageReconciliation(db!, plan).tasks).toBe(1);
    expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 0, resumed: 1 });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(41);
    expect((await buildReconcileUsagePlan(sql, { archiveRoot: root, taskId: task.id })).modernRepairs).toHaveLength(0);
  });

  for (const scenario of ["trace-only", "backfilled-copy", "wrong-conversation"] as const) it(`handles ${scenario} raw usage by exact attempt and trace identity`, async () => {
    const { store, agent, task } = fixture();
    const meta = { _meta: { remiTokenUsage: { id: "response", providerSessionId: "native-session", providerRequestId: "response", inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12 } } };
    if (scenario === "backfilled-copy") store.appendTaskMessages(task.id, [{ seq: 1, type: "usage", meta }]);
    const rows = [{ format: "multiremi.trace.v1", task_id: task.id, session_id: scenario === "wrong-conversation" ? "another-conversation" : task.id, agent_id: agent.id, provider: "claude", started_at: "2026-10-01T00:00:00Z" },
      { seq: 1, ts: at, type: "usage", meta },
      { end: { status: "completed", head: 1, event_count: 1, ended_at: "2026-10-01T02:00:00Z" } }];
    const { root, sql } = await archive(task.id, "trace", rows);
    const plan = await buildReconcileUsagePlan(sql, { archiveRoot: root, taskId: task.id });
    expect(plan.counts.archiveReadFailures).toBe(0);
    if (scenario === "wrong-conversation") {
      expect(plan.counts.rejected).toBe(1);
      expect(plan.counts.rawEvents).toBe(0);
      expect(plan.tasks[0]!.actualTokens).toBe(0);
    } else {
      expect(plan.counts.rawEvents).toBe(1);
      expect(plan.counts.replayed).toBe(scenario === "backfilled-copy" ? 1 : 0);
      expect(plan.tasks[0]).toMatchObject({ taskId: task.id, source: "raw", actualTokens: 12, countedActualTokens: 12 });
      expect(applyUsageReconciliation(db!, plan).applied).toBe(1);
      expect(verifyUsageReconciliation(db!, plan).actualTokens).toBe(12);
      expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(12);
    }
  });
});
