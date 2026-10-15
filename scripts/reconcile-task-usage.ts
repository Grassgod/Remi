/** Read-only reconciliation plan from raw telemetry. */
import type { TaskUsageSnapshot, TaskUsageUnit } from "../packages/contracts/src/usage-accounting.js";
import { meterIntervalsOverlap, unitActualTotal } from "../packages/acp/src/usage-collector.js";
import { createHash } from "node:crypto";
import { PostgresSyncDatabase } from "../packages/server/src/store/db/postgres.js";
import { applyUsageReconciliation, verifyUsageReconciliation } from "./usage-reconciliation-store.js";
import { ensureUsageAccountingSchema, legacyUsageSnapshot } from "../packages/server/src/store/usage-accounting.js";
import { parseRawUsageEvidence, type HistoricalTaskBoundary } from "./usage-evidence.js";
import { nextUsageRevision, readPlanUsageRevisionStates, usageRevisionStateSha256 } from "./usage-reconciliation-revisions.js";
import { assertUsageReconciliationSchema, type ModernUsageRepair } from "./modern-usage-repair.js";
import { buildNativeUsageBackfill, summarizeNativeBackfill, type NativeBackfillReport } from "./native-usage-backfill.js";
import type { CodexNativeUsageExport } from "./export-codex-native-usage.js";

interface Task extends HistoricalTaskBoundary { workspace_id: string; agent_id: string; issue_id: string | null; chat_session_id: string | null; usage: string; has_live_usage: boolean; status: string; }
export interface ReconcileUsagePlan {
  version: 2; mode: "read-only"; generatedAt: string;
  counts: { tasks: number; rawEvents: number; rejected: number; replayed: number; ambiguousRawEvents: number; ambiguousTaskEvents: number };
  tasks: Array<{ taskId: string; expectedLegacyUsageSha256: string; supersedeLegacyRun: boolean; snapshot: TaskUsageSnapshot; actualTokens: number; source: "raw" | "context_only";
    coverage: "partial" | "none"; legacyKnownTokens: number; countedActualTokens: number; knownDeltaTokens: number; ambiguousRawEvents: number; unrecoverableReason: string | null;
    expectedRevisionStateSha256?: string; legacyRevision?: number;
    attributionEvidence?: Array<{ reason: "missing_request_namespace" | "competing_request_owners"; unit: TaskUsageUnit; competingTaskIds: string[] }> }>;
  limitations: string[];
  excludedTasks?: Array<{ taskId: string; reason: "modern_live_usage" | "nonterminal_task" }>;
  modernRepairs?: ModernUsageRepair[];
  modernRepairSkipped?: Array<{ taskId: string; reason: string }>;
  /** Coverage of the daemon-host Codex rollout exports given with --native-evidence. */
  nativeBackfill?: NativeBackfillReport;
}

export function summarizeReconcileUsagePlan(plan: ReconcileUsagePlan) {
  const source: Record<string, number> = {}, coverage: Record<string, number> = {}, unrecoverable: Record<string, number> = {}, attribution: Record<string, number> = {};
  const delta = { lower: 0, equal: 0, higher: 0, legacyPreserved: 0 };
  const evidenceDelta = { lower: 0, equal: 0, higher: 0, noActualEvidence: 0 };
  const excluded: Record<string, number> = {};
  for (const task of plan.excludedTasks ?? []) excluded[task.reason] = (excluded[task.reason] ?? 0) + 1;
  let originalKnownTokens = 0, recoveredKnownSubtotal = 0, preservedLegacyTokens = 0, countedEvidenceTokens = 0;
  for (const task of plan.tasks) {
    for (const evidence of task.attributionEvidence ?? []) attribution[evidence.reason] = (attribution[evidence.reason] ?? 0) + 1;
    source[task.source] = (source[task.source] ?? 0) + 1;
    coverage[task.coverage] = (coverage[task.coverage] ?? 0) + 1;
    if (task.unrecoverableReason) unrecoverable[task.unrecoverableReason] = (unrecoverable[task.unrecoverableReason] ?? 0) + 1;
    originalKnownTokens += task.legacyKnownTokens; recoveredKnownSubtotal += task.actualTokens;
    countedEvidenceTokens += task.countedActualTokens;
    if (!task.actualTokens) evidenceDelta.noActualEvidence++;
    else if (task.actualTokens < task.legacyKnownTokens) evidenceDelta.lower++;
    else if (task.actualTokens > task.legacyKnownTokens) evidenceDelta.higher++;
    else evidenceDelta.equal++;
    if (!task.supersedeLegacyRun) { preservedLegacyTokens += task.legacyKnownTokens; delta.legacyPreserved++; }
    else if (task.knownDeltaTokens < 0) delta.lower++;
    else if (task.knownDeltaTokens > 0) delta.higher++;
    else delta.equal++;
  }
  return { counts: plan.counts, taskManifestCount: plan.tasks.length, excluded, source, coverage, unrecoverable, attribution, delta, evidenceDelta,
    originalKnownTokens, recoveredKnownSubtotal, countedEvidenceTokens, preservedLegacyTokens,
    modernRepairCount: plan.modernRepairs?.length ?? 0, modernRepairSkipped: plan.modernRepairSkipped ?? [],
    nativeBackfill: summarizeNativeBackfill(plan.nativeBackfill),
    modernBeforeActualTokens: (plan.modernRepairs ?? []).reduce((sum, repair) => sum + repair.beforeActualTokens, 0),
    modernAfterActualTokens: (plan.modernRepairs ?? []).reduce((sum, repair) => sum + repair.afterActualTokens, 0),
    plannedLedgerKnownTokens: countedEvidenceTokens + preservedLegacyTokens + (plan.modernRepairs ?? []).reduce((sum, repair) => sum + repair.afterActualTokens, 0) };
}

export async function buildReconcileUsagePlan(sql: Bun.SQL, options: { taskId?: string; onProgress?: (message: string) => void } = {}): Promise<ReconcileUsagePlan> {
  const plan: ReconcileUsagePlan = { version: 2, mode: "read-only", generatedAt: new Date().toISOString(), counts: {
    tasks: 0, rawEvents: 0, rejected: 0, replayed: 0, ambiguousRawEvents: 0, ambiguousTaskEvents: 0,
  }, tasks: [], limitations: [
    "Context occupancy and compaction estimates are diagnostic and never summed into actual consumption.",
    "Raw events require unique task time boundaries; overlapping or missing boundaries remain unattributed.",
    "Legacy raw v1 reports without request identity remain separate observations; numeric equality never proves replay.",
    "Historical connection IDs require explicit event evidence; current configuration never fills them. Configured/current runtime models never become actual models.",
    "Partial raw evidence never replaces a known legacy aggregate without proven complete coverage; it is retained separately for reconciliation. Only unknown legacy consumption can gain a request subtotal; no task is claimed completely recovered.",
    "Nonterminal tasks remain excluded. Modern terminal tasks require a single completed run and an evidenced matching provider session; ambiguous ownership or coverage is skipped.",
    "A request requires real provider session/request identity; Codex cumulative meters require real session, explicit epoch and before/after intervals, never a fabricated turn request ID. Missing namespaces and cross-task competing identities remain non-additive attribution evidence; unknown routes compete with known routes rather than being guessed independent.",
  ] };
  // Ownership resolution must see every competing task, even --task-id.
  const tasks = await sql.unsafe<Task[]>(`SELECT t.id,t.workspace_id,t.agent_id,t.provider,t.status,t.session_id,t.issue_session_id,t.issue_id,t.chat_session_id,t.started_at,t.completed_at,t.failed_at,t.cancelled_at,t.usage,
    EXISTS(SELECT 1 FROM multiremi_usage_runs r WHERE r.task_id=t.id AND r.run_id NOT IN ('legacy','historical-evidence-v2')) AS has_live_usage FROM multiremi_turn_execution_records t`);
  const terminal = (task: Task) => ["completed", "failed", "cancelled"].includes(task.status);
  const selected = (task: Task) => !task.has_live_usage && terminal(task) && (!options.taskId || task.id === options.taskId);
  plan.excludedTasks = tasks.filter(task => (!options.taskId || task.id === options.taskId) && !selected(task))
    .map(task => ({ taskId: task.id, reason: task.has_live_usage ? "modern_live_usage" : "nonterminal_task" }));
  plan.counts.tasks = tasks.filter(selected).length;
  const byTask = new Map(tasks.map(t => [t.id, { task: t, raw: new Map<string, TaskUsageUnit>(), context: null as TaskUsageUnit | null, ambiguousRawEvents: 0 }]));
  const lastSignature = new Map<string, string>();
  const seenRawEvents = new Set<string>();
  const ingestRaw = (row: { task_id: string; seq: number; created_at: string; meta: unknown }, evidenceRef: string) => {
    // A backfilled trace carries the original attempt/seq. Reading both copies
    // does not create another observation, even without provider request IDs.
    const key = JSON.stringify([row.task_id, Number(row.seq)]);
    if (seenRawEvents.has(key)) { plan.counts.replayed++; return; }
    seenRawEvents.add(key);
    plan.counts.rawEvents++;
    const target = byTask.get(row.task_id);
    if (!target?.task.provider) return;
    const evidence = parseRawUsageEvidence({ provider: target.task.provider, meta: row.meta,
      evidenceRef, occurredAt: row.created_at });
    plan.counts.rejected += evidence.rejected;
    for (const unit of evidence.units) {
      if (unit.source === "context_snapshot") {
        if (!target.context || unit.contextTokens! > target.context.contextTokens!) target.context = unit;
        continue;
      }
      const signature = JSON.stringify([unit.provider, unit.model, unit.inputTokens, unit.outputTokens, unit.cacheReadTokens, unit.cacheWriteTokens, unit.reportedTotalTokens]);
      if (lastSignature.get(row.task_id) === signature && !evidence.stableRequestIdentity) {
        plan.counts.ambiguousRawEvents++; target.ambiguousRawEvents++;
      }
      lastSignature.set(row.task_id, signature);
      const old = target.raw.get(unit.unitId);
      if (old) {
        for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "actualUnsplitTokens", "reportedTotalTokens"] as const) {
          if (old[field] !== null) unit[field] = Math.max(old[field]!, unit[field] ?? 0);
        }
        unit.occurredAt = old.occurredAt;
      }
      target.raw.set(unit.unitId, unit);
    }
  };
  // Historical read-only source retained by trace backfill. Unified executions
  // write daemon traces, never into this table.
  let afterTask = "", afterSeq = -1;
  for (;;) {
    const rows = await sql.unsafe<Array<{ task_id: string; seq: number; created_at: string; meta: string }>>(
      `SELECT task_id,seq,created_at,meta FROM multiremi_task_messages WHERE type=$1 AND (task_id,seq)>($2,$3)
       ORDER BY task_id,seq LIMIT 1000`, ["usage", afterTask, afterSeq]);
    if (!rows.length) break;
    for (const row of rows) ingestRaw(row, `task-message:${row.task_id}:${row.seq}`);
    const last = rows.at(-1)!;
    afterTask = last.task_id; afterSeq = Number(last.seq);
    if (plan.counts.rawEvents % 10_000 === 0) options.onProgress?.(`Read ${plan.counts.rawEvents} raw usage events`);
  }
  const ownership = new Map<string, Array<{ taskId: string; connectionId: string | null; unit: TaskUsageUnit }>>();
  const identity = (workspaceId: string, unit: TaskUsageUnit) => unit.providerSessionId && (unit.providerRequestId || (unit.providerObservationId && unit.meterEvidence))
    ? JSON.stringify([workspaceId, unit.provider, unit.providerSessionId, unit.identityKind ?? "request", unit.meterEvidence ? "meter-stream" : unit.providerRequestId]) : null;
  const claim = (workspaceId: string, taskId: string, unit: TaskUsageUnit) => {
    const key = identity(workspaceId, unit);
    if (!key || unit.source === "context_snapshot") return;
    const claims = ownership.get(key) ?? [];
    const connectionId = unit.connectionId ?? null;
    if (!claims.some(value => value.taskId === taskId && value.connectionId === connectionId && value.unit.unitId === unit.unitId)) claims.push({ taskId, connectionId, unit });
    ownership.set(key, claims);
  };
  const revisionStates = await readPlanUsageRevisionStates(sql);
  for (const [taskId, target] of byTask) {
    for (const unit of target.raw.values()) claim(target.task.workspace_id, taskId, unit);
  }
  // Existing live facts are ownership evidence even when their task and raw
  // telemetry are excluded from the requested historical application cohort.
  const liveClaims = await sql.unsafe<Array<{ workspace_id: string; task_id: string; unit_id: string; provider: string; connection_id: string | null; provider_session_id: string; provider_request_id: string | null; provider_observation_id: string | null; identity_kind: TaskUsageUnit["identityKind"]; meter_evidence: string | null }>>(`
    SELECT t.workspace_id,u.task_id,u.unit_id,u.provider,u.connection_id,u.provider_session_id,u.provider_request_id,u.provider_observation_id,u.identity_kind,u.meter_evidence
    FROM multiremi_usage_units u JOIN multiremi_turn_execution_records t ON t.id=u.task_id
    WHERE u.run_id NOT IN ('legacy','historical-evidence-v2') AND u.provider_session_id IS NOT NULL AND (u.provider_request_id IS NOT NULL OR u.provider_observation_id IS NOT NULL)
      AND u.source IN ('provider_request','provider_turn')`);
  const vector = (values: number[]) => ({ inputTokens: values[0]!, outputTokens: values[1]!, cacheReadTokens: values[2]!, cacheWriteTokens: values[3]!, totalTokens: values[4]! });
  for (const row of liveClaims) {
    const meter = row.meter_evidence ? JSON.parse(row.meter_evidence) : null;
    claim(row.workspace_id, row.task_id, { unitId: row.unit_id, provider: row.provider, connectionId: row.connection_id,
      providerSessionId: row.provider_session_id, providerRequestId: row.provider_request_id, providerObservationId: row.provider_observation_id,
      identityKind: row.identity_kind ?? undefined,
      ...(meter ? { meterEvidence: { epochId: meter.epochId, before: vector(meter.before), after: vector(meter.after) } } : {}) } as TaskUsageUnit);
  }
  const conflictingClaims = await sql.unsafe<Array<{ workspace_id: string; task_id: string; unit_json: string }>>(`
    SELECT t.workspace_id,c.task_id,c.unit_json FROM multiremi_usage_identity_conflicts c JOIN multiremi_turn_execution_records t ON t.id=c.task_id`);
  for (const row of conflictingClaims) {
    try { claim(row.workspace_id, row.task_id, JSON.parse(row.unit_json) as TaskUsageUnit); }
    catch { plan.counts.rejected++; }
  }
  for (const [taskId, target] of byTask) {
    if (!selected(target.task)) continue;
    const evidenceUnits = [...target.raw.values()].filter(u => u.source !== "context_snapshot");
    const actual: TaskUsageUnit[] = [], diagnostics: TaskUsageUnit[] = [];
    const attributionEvidence: NonNullable<ReconcileUsagePlan["tasks"][number]["attributionEvidence"]> = [];
    for (const unit of evidenceUnits) {
      if (unit.source === "provider_turn" && unit.accuracy === "unknown" && unitActualTotal(unit) === 0
        && !unit.providerSessionId && unit.evidenceRef?.endsWith("#overlapping-unscoped-meter")) {
        diagnostics.push(unit);
        attributionEvidence.push({ reason: "missing_request_namespace", unit, competingTaskIds: [] });
        continue;
      }
      const key = identity(target.task.workspace_id, unit);
      const competitors = key ? (ownership.get(key) ?? []).filter(owner => (owner.connectionId === (unit.connectionId ?? null)
        || owner.connectionId === null || unit.connectionId == null) && (!unit.meterEvidence || (owner.unit.meterEvidence && (
          owner.unit.providerObservationId === unit.providerObservationId || meterIntervalsOverlap(owner.unit.meterEvidence, unit.meterEvidence))))) : [];
      const competingTaskIds = [...new Set(competitors.map(owner => owner.taskId))].sort();
      if (key && competingTaskIds.length === 1 && !competitors.some(owner => owner.unit.unitId !== unit.unitId && owner.unit.meterEvidence)) { actual.push(unit); continue; }
      const reason = key ? "competing_request_owners" : "missing_request_namespace";
      attributionEvidence.push({ reason, unit, competingTaskIds });
      if (key) plan.counts.ambiguousTaskEvents++;
      diagnostics.push({ ...unit, unitId: `unattributed:${createHash("sha256").update(unit.unitId).digest("hex")}`,
        scope: "turn", source: "context_snapshot", accuracy: "unknown", inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null,
        reportedTotalTokens: unit.reportedTotalTokens ?? unitActualTotal(unit), costAmount: null, costCurrency: null,
        providerSessionId: undefined, providerRequestId: undefined, providerObservationId: undefined, identityKind: undefined, meterEvidence: undefined, coveredUnitIds: undefined });
    }
    const context = target.context;
    const units = [...actual, ...diagnostics, ...(context ? [context] : [])];
    const revisionState = revisionStates.get(taskId) ?? { receipts: [], units: [], runs: [] };
    for (const unit of units) unit.revision = nextUsageRevision(revisionState, "historical-evidence-v2", unit.unitId);
    const actualTokens = actual.reduce((sum, u) => sum + unitActualTotal(u), 0);
    const legacyKnownTokens = legacyUsageSnapshot(taskId, target.task.usage, plan.generatedAt).units.reduce((sum, unit) => sum + unitActualTotal(unit), 0);
    plan.tasks.push({ taskId, expectedLegacyUsageSha256: createHash("sha256").update(target.task.usage ?? "").digest("hex"),
      expectedRevisionStateSha256: usageRevisionStateSha256(revisionState), legacyRevision: nextUsageRevision(revisionState, "legacy"),
      supersedeLegacyRun: actualTokens > 0 && legacyKnownTokens === 0, countedActualTokens: legacyKnownTokens === 0 ? actualTokens : 0,
      source: evidenceUnits.length ? "raw" : "context_only",
      coverage: actual.length ? "partial" : "none", legacyKnownTokens, knownDeltaTokens: actualTokens > 0 ? actualTokens - legacyKnownTokens : 0,
      ambiguousRawEvents: target.ambiguousRawEvents,
      unrecoverableReason: actual.length ? (legacyKnownTokens > 0 ? "partial_evidence_legacy_preserved" : "partial_request_coverage")
        : attributionEvidence.some(e => e.reason === "competing_request_owners") ? "competing_request_owners"
        : attributionEvidence.length ? "missing_request_namespace" : context ? "context_only_no_request_evidence" : "no_request_evidence",
      attributionEvidence, snapshot: { version: 2, runId: "historical-evidence-v2", revision: nextUsageRevision(revisionState, "historical-evidence-v2"), complete: false, units }, actualTokens });
  }
  return plan;
}

/** Read through the apply-time reader so the reviewed state hashes are reproducible. */
export async function addNativeUsageBackfill(databaseUrl: string, plan: ReconcileUsagePlan, files: string[], options: { taskId?: string; since?: string | null }): Promise<void> {
  const exports = await Promise.all(files.map(file => Bun.file(file).json() as Promise<CodexNativeUsageExport>));
  const db = new PostgresSyncDatabase(databaseUrl);
  try {
    assertUsageReconciliationSchema(db);
    const native = db.transaction(() => {
      db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      return buildNativeUsageBackfill(db, exports, options);
    })();
    mergeNativeUsageBackfill(plan, native);
  } finally { db.close(); }
}

export function mergeNativeUsageBackfill(plan: ReconcileUsagePlan, native: ReturnType<typeof buildNativeUsageBackfill>): void {
  plan.modernRepairs = [...(plan.modernRepairs ?? []), ...native.repairs];
  plan.nativeBackfill = native.report;
  const repaired = new Set(native.repairs.map(repair => repair.taskId));
  plan.excludedTasks = plan.excludedTasks?.filter(task => !repaired.has(task.taskId));
  plan.limitations.push(
    "Codex native rollout exports are attributed by root session to the single attempt whose execution window contains each request; requests outside every window, in overlapping windows, already recorded, or reported differently by two exports stay unattributed.",
    "Native backfill only adds missing requests to a terminal attempt's single complete live run that recorded no consumption; its context and other units are kept unchanged. Attempts whose rollouts were deleted remain unknown.",
  );
}

export async function mainReconcileTaskUsage(): Promise<void> {
  const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const databaseUrl = process.env.MULTIREMI_DATABASE_URL;
  if (!databaseUrl) throw new Error("MULTIREMI_DATABASE_URL is required; use an isolated restored database for reconciliation.");
  const applyPlan = arg("apply-plan"), verifyPlan = arg("verify-plan");
  if (process.argv.includes("--execute") && (!applyPlan || arg("confirm") !== "USAGE_EVIDENCE_V2")) throw new Error("Apply requires a reviewed --apply-plan, --execute and --confirm=USAGE_EVIDENCE_V2");
  if (applyPlan || verifyPlan) {
    if (applyPlan && !process.argv.includes("--execute")) throw new Error("Applying a plan requires --execute");
    const plan = await Bun.file((applyPlan ?? verifyPlan)!).json() as ReconcileUsagePlan;
    const db = new PostgresSyncDatabase(databaseUrl);
    try {
      assertUsageReconciliationSchema(db);
      if (applyPlan) ensureUsageAccountingSchema(db);
      const result = applyPlan ? applyUsageReconciliation(db, plan, progress => process.stderr.write(`${JSON.stringify(progress)}\n`)) : null;
      process.stdout.write(`${JSON.stringify({ applied: result, verified: verifyUsageReconciliation(db, plan) }, null, 2)}\n`);
    } finally { db.close(); }
    return;
  }
  const sql = new Bun.SQL(databaseUrl, { max: 1 });
  try {
    const plan = await sql.begin(async tx => {
      await tx.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      return buildReconcileUsagePlan(tx, { taskId: arg("task-id"),
        onProgress: message => process.stderr.write(`${message}\n`) });
    });
    const nativeEvidence = process.argv.filter(a => a.startsWith("--native-evidence=")).flatMap(a => a.slice("--native-evidence=".length).split(",")).filter(Boolean);
    if (nativeEvidence.length) await addNativeUsageBackfill(databaseUrl, plan, nativeEvidence, { taskId: arg("task-id"), since: arg("native-since") ?? null });
    const out = arg("out");
    if (out) await Bun.write(out, JSON.stringify(plan));
    process.stdout.write(`${JSON.stringify({ mode: plan.mode, ...summarizeReconcileUsagePlan(plan), output: out ?? null, limitations: plan.limitations }, null, 2)}\n`);
  } finally { await sql.end(); }
}
if (import.meta.main) await mainReconcileTaskUsage();
