import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipStreamWriter } from "../../../packages/shared/src/zip/writer.js";
import { applyUsageReconciliation, verifyUsageReconciliation } from "../../../scripts/usage-reconciliation-store.js";
import { migrationBatchSize } from "../../../scripts/migrate-usage-accounting.js";
import { buildReconcileUsagePlan, type ReconcileUsagePlan } from "../../../scripts/reconcile-task-usage.js";
import { actualUnit } from "../../../packages/acp/src/usage-collector.js";
import { migrateLegacyUsage } from "@multiremi/store/usage-accounting.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "../multiremi/helpers.js";
afterEach(resetMultiremiTestEnv);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "history", provider: "claude", workspaceId: "local" });
  const first = store.createTask({ agentId: agent.id, prompt: "first", workspaceId: "local" });
  const second = store.createTask({ agentId: agent.id, prompt: "second", workspaceId: "local" });
  const original = JSON.stringify([{ provider: "claude", model: "configured-opus", inputTokens: 100, outputTokens: 2, totalTokens: 102 }]);
  db!.run("UPDATE multiremi_tasks SET usage=?,provider='claude',status='completed'", [original]);
  migrateLegacyUsage(db!);
  const plan: ReconcileUsagePlan = { version: 2, mode: "read-only", generatedAt: "2026-10-06T00:00:00Z", counts: {
    tasks: 2, rawEvents: 2, archives: 1, nativeMembers: 1, rejected: 0, replayed: 0, ambiguousRawEvents: 0, ambiguousTaskEvents: 0, archiveReadFailures: 0, bytesRead: 100,
  }, limitations: [], tasks: [first, second].map(task => ({ taskId: task.id, expectedLegacyUsageSha256: hash(original), supersedeLegacyRun: false, countedActualTokens: 0,
    source: "native", coverage: "partial", legacyKnownTokens: 102, knownDeltaTokens: -77, ambiguousRawEvents: 0,
    unrecoverableReason: "partial_evidence_legacy_preserved", actualTokens: 25, snapshot: { version: 2, runId: "historical-evidence-v2", revision: 1, complete: false,
      units: [{ ...actualUnit({ unitId: "request-one", provider: "claude", model: "actual-haiku", scope: "request", source: "provider_request",
        inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 25, evidenceRef: "native:sha:line1" }), occurredAt: "2026-10-01T01:00:00.000Z" }] } })) };
  return { store, first, second, original, plan };
}

describe("historical reconciliation checkpoints", () => {
  it.each(["shared", "missing-session", "different-session", "different-connection", "unknown-connection", "modern-competitor"] as const)(
    "uses global provider ownership for %s stored telemetry even with --task-id", async scenario => {
      const store = createLocalStore();
      const agent = store.createAgent({ name: "Global request attribution", provider: "claude", workspaceId: "local" });
      const first = store.createTask({ agentId: agent.id, prompt: "first historical owner" });
      const second = store.createTask({ agentId: agent.id, prompt: "second historical owner" });
      db!.run("UPDATE multiremi_tasks SET provider='claude',status='completed',usage=?", [JSON.stringify([{ provider: "claude", totalTokens: 78048 }])]);
      migrateLegacyUsage(db!);
      for (const [index, task] of [first, second].entries()) store.appendTaskMessages(task.id, [{ type: "usage", meta: { _meta: { remiTokenUsage: {
        id: "same-short-request", providerRequestId: "same-short-request", source: "claude_assistant_usage",
        ...(scenario !== "missing-session" ? { providerSessionId: scenario === "different-session" ? `session-${index}` : "same-real-session" } : {}),
        ...(scenario === "different-connection" ? { connectionId: `connection-${index}` }
          : scenario === "unknown-connection" && index === 1 ? { connectionId: "known-connection" } : {}),
        inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12,
      } } } }]);
      if (scenario === "modern-competitor") store.reportTaskUsageSnapshot(second.id, { version: 2, runId: "accepted-modern", revision: 1, complete: true,
        units: [actualUnit({ unitId: "live-request", provider: "claude", scope: "request", source: "provider_request",
          providerSessionId: "same-real-session", providerRequestId: "same-short-request", inputTokens: 10, outputTokens: 2 })] });
      const sql = { unsafe: async (statement: string, params: any[] = []) => db!.query(statement.replace(/\$\d+/g, "?")).all(...params) } as unknown as Bun.SQL;
      const independent = ["different-session", "different-connection"].includes(scenario);
      const plan = await buildReconcileUsagePlan(sql, independent ? {} : { taskId: first.id });
      expect(plan.tasks.reduce((sum, task) => sum + task.countedActualTokens, 0)).toBe(independent ? 24 : 0);
      expect(plan.counts.replayed).toBe(0); // Equal counters are not request identity.
      if (!independent) {
        expect(plan.tasks[0]!.attributionEvidence).toHaveLength(1);
        expect(plan.tasks[0]!.attributionEvidence![0]!.reason).toBe(scenario === "missing-session" ? "missing_request_namespace" : "competing_request_owners");
        expect(plan.tasks[0]!.attributionEvidence![0]!.unit.inputTokens).toBe(10);
        expect(plan.tasks[0]!.snapshot.units[0]).toMatchObject({ inputTokens: null, outputTokens: null, reportedTotalTokens: 12, accuracy: "unknown" });
      }
      applyUsageReconciliation(db!, plan);
      expect(verifyUsageReconciliation(db!, plan).actualTokens).toBe(independent ? 24 : 0);
      expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(independent ? 24 : scenario === "modern-competitor" ? 12 : 0);
      expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 0, resumed: plan.tasks.length });
      if (!independent) {
        db!.run("UPDATE multiremi_usage_reconciliation_attribution SET evidence_json='[]' WHERE task_id=?", [first.id]);
        expect(() => verifyUsageReconciliation(db!, plan)).toThrow("Reconciliation attribution mismatch");
      }
    });

  it("keeps equal short request IDs distinct on two explicitly known connections within one task", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "two routes", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "two actual upstream routes" });
    db!.run("UPDATE multiremi_tasks SET provider='claude',status='completed',usage='[]' WHERE id=?", [task.id]);
    migrateLegacyUsage(db!);
    store.appendTaskMessages(task.id, ["known-route-one", "known-route-two"].map(connectionId => ({ type: "usage" as const, meta: { _meta: { remiTokenUsage: {
      id: "same-short-id", providerSessionId: "real-provider-session", connectionId, inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12,
    } } } })));
    const sql = { unsafe: async (statement: string, params: any[] = []) => db!.query(statement.replace(/\$\d+/g, "?")).all(...params) } as unknown as Bun.SQL;
    const plan = await buildReconcileUsagePlan(sql);
    expect(plan.tasks[0]!.actualTokens).toBe(24);
    expect(plan.tasks[0]!.attributionEvidence).toEqual([]);
    expect(new Set(plan.tasks[0]!.snapshot.units.map(unit => unit.unitId)).size).toBe(2);
    applyUsageReconciliation(db!, plan);
    expect(verifyUsageReconciliation(db!, plan).actualTokens).toBe(24);
  });

  it("rolls back a stale generated plan when another live owner claims its request after planning", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "ownership race", provider: "claude" });
    const first = store.createTask({ agentId: agent.id, prompt: "historical" }), second = store.createTask({ agentId: agent.id, prompt: "live" });
    db!.run("UPDATE multiremi_tasks SET provider='claude',status='completed',usage=?", [JSON.stringify([{ provider: "claude", totalTokens: 78048 }])]);
    migrateLegacyUsage(db!);
    store.appendTaskMessages(first.id, [{ type: "usage", meta: { _meta: { remiTokenUsage: { id: "raced-request", providerSessionId: "real-session",
      inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12 } } } }]);
    const sql = { unsafe: async (statement: string, params: any[] = []) => db!.query(statement.replace(/\$\d+/g, "?")).all(...params) } as unknown as Bun.SQL;
    const plan = await buildReconcileUsagePlan(sql, { taskId: first.id });
    expect(plan.tasks[0]!.countedActualTokens).toBe(12);
    store.reportTaskUsageSnapshot(second.id, { version: 2, runId: "late-live-owner", revision: 1, complete: true,
      units: [actualUnit({ unitId: "live-unit", provider: "claude", scope: "request", source: "provider_request", providerSessionId: "real-session",
        providerRequestId: "raced-request", inputTokens: 10, outputTokens: 2 })] });
    expect(() => applyUsageReconciliation(db!, plan)).toThrow("Canonical ownership changed after plan");
    expect(db!.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=? AND run_id='historical-evidence-v2'").get(first.id)).toBeNull();
    expect(db!.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=? AND run_id='legacy'").get(first.id)).not.toBeNull();
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(12);
    const safer = await buildReconcileUsagePlan(sql, { taskId: first.id });
    expect(safer.tasks[0]!.countedActualTokens).toBe(0);
    applyUsageReconciliation(db!, safer);
    expect(verifyUsageReconciliation(db!, safer).actualTokens).toBe(0);
  });

  it("keeps competing Codex cumulative meter intervals as evidence rather than double-counting different endpoints", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "historical meter", provider: "codex" });
    const first = store.createTask({ agentId: agent.id, prompt: "first interval" }), second = store.createTask({ agentId: agent.id, prompt: "overlapping interval" });
    db!.run("UPDATE multiremi_tasks SET provider='codex',status='completed',usage='[]'");
    migrateLegacyUsage(db!);
    const vector = (n: number) => ({ inputTokens: n * 10, outputTokens: n * 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: n * 12 });
    for (const [index, task] of [first, second].entries()) store.appendTaskMessages(task.id, [{ type: "usage", meta: { _meta: { remiTokenUsage: {
      id: `raw-observation-${index}`, threadId: "same-native-thread", source: "codex_thread_token_usage", inputTokens: (index + 1) * 10,
      outputTokens: (index + 1) * 2, cachedInputTokens: 0, totalTokens: (index + 1) * 12,
      meterEvidence: { epochId: "initial", before: vector(1), after: vector(index + 2), last: vector(1) },
    } } } }]);
    const sql = { unsafe: async (statement: string, params: any[] = []) => db!.query(statement.replace(/\$\d+/g, "?")).all(...params) } as unknown as Bun.SQL;
    const plan = await buildReconcileUsagePlan(sql);
    expect(plan.tasks.reduce((sum, task) => sum + task.countedActualTokens, 0)).toBe(0);
    expect(plan.tasks.every(task => task.attributionEvidence?.[0]?.reason === "competing_request_owners")).toBe(true);
    expect(plan.tasks.map(task => task.attributionEvidence![0]!.unit.providerRequestId)).toEqual([undefined, undefined]);
    applyUsageReconciliation(db!, plan);
    expect(verifyUsageReconciliation(db!, plan).actualTokens).toBe(0);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(0);
  });

  it("preserves a 102-token aggregate alongside 25-token partial evidence and resumes without double counting", () => {
    const { store, first, original, plan } = fixture();
    expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 2, resumed: 0 });
    expect(verifyUsageReconciliation(db!, plan)).toMatchObject({ tasks: 2, units: 0, actualTokens: 0, preservedLegacyTokens: 204, unknownTasks: 2 });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(204);
    expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 0, resumed: 2 });
    expect(store.getTask(first.id)?.usage).toMatchObject(JSON.parse(original));
    const audit = db!.query("SELECT original_units FROM multiremi_usage_reconciliation_audit WHERE task_id=?").get(first.id) as { original_units: string };
    expect(JSON.parse(audit.original_units)[0]).toMatchObject({ run_id: "legacy", input_tokens: 100, requested_model: "configured-opus" });
    const evidence = db!.query("SELECT units_json FROM multiremi_usage_reconciliation_evidence WHERE task_id=?").get(first.id) as { units_json: string };
    expect(JSON.parse(evidence.units_json)[0]).toMatchObject({ inputTokens: 20, outputTokens: 5, model: "actual-haiku" });
    db!.run("UPDATE multiremi_usage_reconciliation_evidence SET units_json='[]' WHERE task_id=?", [first.id]);
    expect(() => verifyUsageReconciliation(db!, plan)).toThrow("Reconciliation evidence mismatch");
  });

  it("stops at a changed task and resumes completed checkpoints after the same plan becomes applicable", () => {
    const { second, original, plan } = fixture();
    db!.run("UPDATE multiremi_tasks SET usage='changed' WHERE id=?", [second.id]);
    expect(() => applyUsageReconciliation(db!, plan)).toThrow("Legacy usage changed after plan");
    expect((db!.query("SELECT count(*) AS n FROM multiremi_usage_reconciliation_audit").get() as { n: number }).n).toBe(1);
    expect((db!.query("SELECT count(*) AS n FROM multiremi_usage_runs WHERE run_id='legacy'").get() as { n: number }).n).toBe(2);
    db!.run("UPDATE multiremi_tasks SET usage=? WHERE id=?", [original, second.id]);
    expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 1, resumed: 1 });
    expect(verifyUsageReconciliation(db!, plan).preservedLegacyTokens).toBe(204);
  });

  it("migrates an unrecoverable task explicitly as unknown and rejects forged totals before any write", () => {
    const { store, plan } = fixture();
    plan.tasks[0]!.snapshot.units = [];
    plan.tasks[0]!.actualTokens = 0;
    plan.tasks[0]!.supersedeLegacyRun = false;
    plan.tasks[0]!.coverage = "none";
    plan.tasks[0]!.knownDeltaTokens = 0;
    plan.tasks[0]!.unrecoverableReason = "no_request_evidence";
    plan.tasks[1]!.actualTokens = 999;
    expect(() => applyUsageReconciliation(db!, plan)).toThrow("Reconciliation totals or identities");
    expect(db!.query("SELECT name FROM sqlite_master WHERE name='multiremi_usage_reconciliation_audit'").get()).toBeNull();
    plan.tasks[1]!.actualTokens = 25;
    applyUsageReconciliation(db!, plan);
    expect(verifyUsageReconciliation(db!, plan)).toMatchObject({ unknownTasks: 2, actualTokens: 0, preservedLegacyTokens: 204, ledgerActualTokens: 204 });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(204);
  });

  it("generates plans from stored telemetry with distinct equal request IDs and preserves unidentified observations", async () => {
    const { store, first } = fixture();
    const observation = (id?: string) => ({ type: "usage" as const, meta: { used: 100, size: 200000, _meta: { remiTokenUsage: {
      ...(id ? { id, providerSessionId: "native-provider-session" } : {}), accuracy: "partial", inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12,
    } } } });
    store.appendTaskMessages(first.id, [observation("one"), observation("two"), observation(), observation()]);
    const sql = { unsafe: async (statement: string, params: any[] = []) => db!.query(statement.replace(/\$\d+/g, "?")).all(...params) } as unknown as Bun.SQL;
    const plan = await buildReconcileUsagePlan(sql, { taskId: first.id });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({ actualTokens: 24, countedActualTokens: 0, supersedeLegacyRun: false });
    expect(plan.tasks[0]!.snapshot.units.filter(unit => unit.source === "provider_request")).toHaveLength(2);
    expect(plan.tasks[0]!.attributionEvidence?.map(value => value.reason)).toEqual(["missing_request_namespace", "missing_request_namespace"]);
    expect(plan.counts.replayed).toBe(0);
  });

  it("excludes modern live tasks at plan generation and rejects tasks gaining a live run after planning", async () => {
    const { store, first, second, plan } = fixture();
    store.reportTaskUsageSnapshot(first.id, { version: 2, runId: "live", revision: 1, complete: true,
      units: [actualUnit({ unitId: "live-one", provider: "claude", scope: "request", source: "provider_request", inputTokens: 7 })] });
    const sql = { unsafe: async (statement: string, params: any[] = []) => db!.query(statement.replace(/\$\d+/g, "?")).all(...params) } as unknown as Bun.SQL;
    const generated = await buildReconcileUsagePlan(sql);
    expect(generated.tasks.map(task => task.taskId)).toEqual([second.id]);
    expect(() => applyUsageReconciliation(db!, plan)).toThrow("Historical cohort changed");
    expect((db!.query("SELECT count(*) AS n FROM multiremi_usage_runs WHERE run_id='historical-evidence-v2'").get() as { n: number }).n).toBe(0);
  });

  it("keeps all shared-session competitors in a --task-id archive scan", async () => {
    const { first, second } = fixture();
    db!.run("UPDATE multiremi_tasks SET chat_session_id='shared',started_at='2026-10-01T00:00:00Z',completed_at='2026-10-01T02:00:00Z'");
    const root = mkdtempSync(join(tmpdir(), "usage-ownership-test-"));
    try {
      const buffers: Buffer[] = [];
      const writer = new ZipStreamWriter({ write: chunk => { buffers.push(chunk); } });
      const body = Buffer.from(JSON.stringify({ type: "assistant", sessionId: "shared-native-session", timestamp: "2026-10-01T01:00:00Z", message: {
        id: "shared-request", model: "haiku", usage: { input_tokens: 20, output_tokens: 5 },
      } }) + "\n");
      const member = await writer.addBuffer("sessions/root/native.jsonl", body, hash(body.toString()));
      const index = Buffer.from(JSON.stringify({ format: "multiremi.session-archive.v2", subject: { kind: "chat", id: "shared" }, members: [{
        path: member.path, kind: "provider", local_header_offset: member.localHeaderOffset, data_offset: member.dataOffset,
        compressed_size: member.compressedSize, uncompressed_size: member.uncompressedSize, sha256: member.sha256,
      }] }));
      await writer.addBuffer("index.json", index, hash(index.toString()));
      await writer.finish();
      await Bun.write(join(root, "shared.zip"), Buffer.concat(buffers));
      const sql = { unsafe: async (statement: string, params: any[] = []) => statement.includes("FROM multiremi_session_archives")
        ? [{ id: "archive", relative_path: "shared.zip", subject_kind: "chat", subject_id: "shared", format: "multiremi.session-archive.v2" }]
        : db!.query(statement.replace(/\$\d+/g, "?")).all(...params) } as unknown as Bun.SQL;
      const full = await buildReconcileUsagePlan(sql, { archiveRoot: root });
      const filtered = await buildReconcileUsagePlan(sql, { archiveRoot: root, taskId: first.id });
      expect(full.tasks.map(task => task.taskId).sort()).toEqual([first.id, second.id].sort());
      expect(full.counts.ambiguousTaskEvents).toBe(1);
      expect(filtered.tasks).toHaveLength(1);
      expect(filtered.counts.ambiguousTaskEvents).toBe(1);
      expect(filtered.tasks[0]!.actualTokens).toBe(0);
      db!.run("UPDATE multiremi_tasks SET started_at='2026-10-01T01:30:00Z' WHERE id=?", [second.id]);
      const unambiguous = await buildReconcileUsagePlan(sql, { archiveRoot: root, taskId: first.id });
      expect(unambiguous.tasks[0]).toMatchObject({ source: "native", actualTokens: 25, countedActualTokens: 0, supersedeLegacyRun: false });
      applyUsageReconciliation(db!, unambiguous);
      expect(verifyUsageReconciliation(db!, unambiguous)).toMatchObject({ actualTokens: 0, preservedLegacyTokens: 102, ledgerActualTokens: 102 });
    } finally {
      if (!root.startsWith(join(tmpdir(), "usage-ownership-test-"))) throw new Error("Unexpected test fixture path");
      rmSync(root, { recursive: true });
    }
  });

  it("rejects an older unsafe replacement plan before creating its checkpoint tables", () => {
    const { plan } = fixture();
    plan.tasks[0]!.supersedeLegacyRun = true;
    expect(() => applyUsageReconciliation(db!, plan)).toThrow("Partial evidence cannot supersede");
    expect(db!.query("SELECT name FROM sqlite_master WHERE name='multiremi_usage_reconciliation_audit'").get()).toBeNull();
  });

  it("rejects a newly generated empty or narrower plan without erasing previously recovered request facts", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Unknown historical consumer", provider: "claude", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "recover", workspaceId: "local" });
    db!.run("UPDATE multiremi_tasks SET usage=?,provider='claude',status='completed' WHERE id=?",
      [JSON.stringify([{ provider: "claude", totalTokens: 78048 }]), task.id]);
    migrateLegacyUsage(db!);
    store.appendTaskMessages(task.id, [{ type: "usage", meta: { _meta: { remiTokenUsage: {
      id: "established-request", providerSessionId: "established-native-session", model: "haiku", inputTokens: 20, outputTokens: 5, cachedInputTokens: 0, totalTokens: 25,
    } } } }]);
    const sql = { unsafe: async (statement: string, params: any[] = []) => db!.query(statement.replace(/\$\d+/g, "?")).all(...params) } as unknown as Bun.SQL;
    const first = await buildReconcileUsagePlan(sql, { taskId: task.id });
    expect(first.tasks[0]).toMatchObject({ actualTokens: 25, countedActualTokens: 25, supersedeLegacyRun: true });
    applyUsageReconciliation(db!, first);
    expect(verifyUsageReconciliation(db!, first).ledgerActualTokens).toBe(25);

    db!.run("DELETE FROM multiremi_task_messages WHERE task_id=?", [task.id]);
    const empty = await buildReconcileUsagePlan(sql, { taskId: task.id });
    expect(empty.tasks[0]!.actualTokens).toBe(0);
    expect(() => applyUsageReconciliation(db!, empty)).toThrow("Recovery plan would downgrade established evidence");
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(25);
    expect(verifyUsageReconciliation(db!, first).ledgerActualTokens).toBe(25);

    store.appendTaskMessages(task.id, [{ type: "usage", meta: { _meta: { remiTokenUsage: {
      id: "established-request", providerSessionId: "established-native-session", model: "haiku", inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12,
    } } } }]);
    const narrower = await buildReconcileUsagePlan(sql, { taskId: task.id });
    expect(narrower.tasks[0]!.actualTokens).toBe(12);
    expect(() => applyUsageReconciliation(db!, narrower)).toThrow("Recovery plan would downgrade established evidence");
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(25);
    expect(verifyUsageReconciliation(db!, first).ledgerActualTokens).toBe(25);
  });

  it("bounds migration batch sizes", () => {
    expect(migrationBatchSize(undefined)).toBe(500);
    expect(migrationBatchSize("100")).toBe(100);
    for (const value of [0, -1, 5001, NaN, "all", 1.5]) expect(() => migrationBatchSize(value)).toThrow();
  });

  it("allows a newly generated evidence superset and resumes it without recounting established requests", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Expandable recovery", provider: "claude", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "history", workspaceId: "local" });
    db!.run("UPDATE multiremi_tasks SET usage=?,provider='claude',status='completed' WHERE id=?",
      [JSON.stringify([{ provider: "claude", totalTokens: 78048 }]), task.id]);
    migrateLegacyUsage(db!);
    const append = (id: string, inputTokens: number, outputTokens: number) => store.appendTaskMessages(task.id, [{ type: "usage",
      meta: { _meta: { remiTokenUsage: { id, providerSessionId: "expandable-native-session", model: "haiku", inputTokens, outputTokens, cachedInputTokens: 0, totalTokens: inputTokens + outputTokens } } } }]);
    const sql = { unsafe: async (statement: string, params: any[] = []) => db!.query(statement.replace(/\$\d+/g, "?")).all(...params) } as unknown as Bun.SQL;
    append("retained", 20, 5);
    const first = await buildReconcileUsagePlan(sql, { taskId: task.id });
    applyUsageReconciliation(db!, first);
    append("new", 8, 2);
    const superset = await buildReconcileUsagePlan(sql, { taskId: task.id });
    expect(superset.tasks[0]!.countedActualTokens).toBe(35);
    expect(applyUsageReconciliation(db!, superset)).toMatchObject({ applied: 1, resumed: 0 });
    expect(verifyUsageReconciliation(db!, superset)).toMatchObject({ units: 2, ledgerActualTokens: 35 });
    expect(applyUsageReconciliation(db!, superset)).toMatchObject({ applied: 0, resumed: 1 });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(35);
  });

  it("preserves established monetary coverage through recovery and verifies the stored links", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Historical charge", provider: "claude", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "history", workspaceId: "local" });
    db!.run("UPDATE multiremi_tasks SET usage=?,provider='claude',status='completed' WHERE id=?",
      [JSON.stringify([{ provider: "claude", totalTokens: 78048 }]), task.id]);
    migrateLegacyUsage(db!);
    store.appendTaskMessages(task.id, [{ type: "usage", meta: { _meta: { remiTokenUsage: {
      id: "charged", providerSessionId: "charged-native-session", model: "haiku", inputTokens: 20, outputTokens: 5, cachedInputTokens: 0, totalTokens: 25,
    } } } }]);
    const sql = { unsafe: async (statement: string, params: any[] = []) => db!.query(statement.replace(/\$\d+/g, "?")).all(...params) } as unknown as Bun.SQL;
    const plan = await buildReconcileUsagePlan(sql, { taskId: task.id });
    const request = plan.tasks[0]!.snapshot.units[0]!;
    const money = { ...actualUnit({ unitId: "historical-charge", provider: "claude", scope: "request", source: "provider_request",
      costAmount: 0.25, costCurrency: "USD", costSource: "provider_reported" }), occurredAt: request.occurredAt, coveredUnitIds: [request.unitId] };
    plan.tasks[0]!.snapshot.units.push(money);
    applyUsageReconciliation(db!, plan);
    expect(verifyUsageReconciliation(db!, plan)).toMatchObject({ units: 2, ledgerActualTokens: 25 });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.known_cost_by_currency).toEqual({ USD: 0.25 });

    const narrower = structuredClone(plan);
    narrower.tasks[0]!.snapshot.units[1]!.coveredUnitIds = [];
    expect(() => applyUsageReconciliation(db!, narrower)).toThrow("Recovery plan would downgrade established evidence");
    expect(verifyUsageReconciliation(db!, plan).ledgerActualTokens).toBe(25);
    const degraded = structuredClone(plan);
    degraded.tasks[0]!.snapshot.units[0]!.accuracy = "unknown";
    expect(() => applyUsageReconciliation(db!, degraded)).toThrow("Recovery plan would downgrade established evidence");
    degraded.tasks[0]!.snapshot.units[0]!.accuracy = request.accuracy;
    degraded.tasks[0]!.snapshot.units[0]!.modelSource = "unknown";
    expect(() => applyUsageReconciliation(db!, degraded)).toThrow("Recovery plan would downgrade established evidence");
    db!.run("DELETE FROM multiremi_usage_cost_coverage WHERE task_id=?", [task.id]);
    expect(() => verifyUsageReconciliation(db!, plan)).toThrow("Reconciliation evidence mismatch");
  });
});
