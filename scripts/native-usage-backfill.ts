/**
 * Reviewed backfill of Codex requests that live runs missed (codex-usage-v6:
 * only a context row per prompt), from daemon-host native rollout exports.
 * Read-only: it only produces modern repairs for the reconciliation plan.
 */
import type { TaskUsageUnit } from "../packages/contracts/src/usage-accounting.js";
import type { SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { unitActualTotal } from "../packages/acp/src/usage-collector.js";
import { CODEX_NATIVE_USAGE_EXPORT_KIND, type CodexNativeUsageExport } from "./export-codex-native-usage.js";
import { buildModernUsageRepairs, readModernRepairState, type ModernUsageRepair, type NativeRunScope } from "./modern-usage-repair.js";

type Row = Record<string, any>;
export type NativeBackfillOutcome = "repaired" | "no_native_request_evidence" | "live_request_usage_present"
  | "no_single_complete_live_run" | "nonterminal_task" | "repair_not_proven";
export interface NativeBackfillReport {
  evidence: Array<{ host: string; generatedAt: string; since: string | null; requests: number }>;
  counts: { requests: number; duplicateRequests: number; conflictingRequests: number; invalidRequests: number;
    alreadyRecorded: number; outsideTaskWindow: number; overlappingTaskWindows: number; attributed: number };
  /**
   * Every cohort attempt and every attempt that received evidence. Repaired
   * attempts count the added requests and tokens; others count the attributed
   * evidence that was not applied.
   */
  tasks: Array<{ taskId: string; outcome: NativeBackfillOutcome; requests: number; actualTokens: number }>;
}
const ENDED = ["completed", "failed", "cancelled"];
const LIVE = (runId: string) => runId !== "legacy" && runId !== "historical-evidence-v2";
const counters = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reportedTotalTokens"] as const;

function validRequest(unit: TaskUsageUnit): boolean {
  const split = [unit.inputTokens, unit.outputTokens, unit.cacheReadTokens, unit.cacheWriteTokens];
  return unit.provider === "codex" && unit.identityKind === "request" && unit.source === "provider_request" && unit.scope === "request"
    && unit.accuracy === "exact" && !!unit.providerSessionId && !!unit.providerRequestId && Number.isFinite(Date.parse(unit.occurredAt))
    && split.every(value => Number.isSafeInteger(value) && value! >= 0) && unit.actualUnsplitTokens === 0
    && split.reduce<number>((sum, value) => sum + value!, 0) === unit.reportedTotalTokens;
}

/** Same response from several hosts or copies is one request; disagreement is no evidence. */
function mergeExports(exports: CodexNativeUsageExport[], report: NativeBackfillReport) {
  const merged = new Map<string, { rootSessionId: string; unit: TaskUsageUnit }>();
  const conflicting = new Set<string>();
  for (const file of exports) {
    if (file?.kind !== CODEX_NATIVE_USAGE_EXPORT_KIND || file.version !== 1 || !Array.isArray(file.requests)) throw new Error("Unsupported native usage export");
    report.evidence.push({ host: file.host, generatedAt: file.generatedAt, since: file.since, requests: file.requests.length });
    for (const { rootSessionId, unit } of file.requests) {
      report.counts.requests++;
      if (typeof rootSessionId !== "string" || !rootSessionId || !validRequest(unit)) { report.counts.invalidRequests++; continue; }
      const key = JSON.stringify([unit.providerSessionId, unit.providerRequestId]);
      const old = merged.get(key);
      if (!old) { if (!conflicting.has(key)) merged.set(key, { rootSessionId, unit }); continue; }
      if (old.rootSessionId === rootSessionId && counters.every(field => old.unit[field] === unit[field])) { report.counts.duplicateRequests++; continue; }
      merged.delete(key);
      conflicting.add(key);
    }
  }
  report.counts.conflictingRequests = conflicting.size;
  return [...merged.values()];
}

/**
 * Attribute each request by root session to the one attempt whose execution
 * window contains it, then repair cohort attempts: terminal Codex attempts
 * with one complete live run that recorded no consumption.
 */
export function buildNativeUsageBackfill(db: SqlDatabase, exports: CodexNativeUsageExport[], options: { taskId?: string; since?: string | null } = {}): {
  repairs: ModernUsageRepair[]; report: NativeBackfillReport;
} {
  const report: NativeBackfillReport = { evidence: [], counts: { requests: 0, duplicateRequests: 0, conflictingRequests: 0, invalidRequests: 0,
    alreadyRecorded: 0, outsideTaskWindow: 0, overlappingTaskWindows: 0, attributed: 0 }, tasks: [] };
  const requests = mergeExports(exports, report);
  const tasks = db.query(`SELECT id,provider,status,session_id,started_at,completed_at,failed_at,cancelled_at
    FROM multiremi_turn_execution_records WHERE provider='codex' AND session_id IS NOT NULL ORDER BY id`).all() as Row[];
  const bySession = new Map<string, Row[]>();
  for (const task of tasks) {
    const list = bySession.get(task.session_id) ?? [];
    list.push(task);
    bySession.set(task.session_id, list);
  }

  // A request already in any run belongs to its owner; never offer it twice.
  const recorded = new Set<string>();
  const threads = [...new Set(requests.map(({ unit }) => unit.providerSessionId!))];
  for (let offset = 0; offset < threads.length; offset += 500) {
    const chunk = threads.slice(offset, offset + 500);
    for (const row of db.query(`SELECT provider_session_id,provider_request_id FROM multiremi_usage_units
      WHERE provider='codex' AND provider_request_id IS NOT NULL AND provider_session_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Row[]) {
      recorded.add(JSON.stringify([row.provider_session_id, row.provider_request_id]));
    }
  }
  for (const row of db.query("SELECT unit_json FROM multiremi_usage_identity_conflicts").all() as Row[]) {
    try {
      const unit = JSON.parse(row.unit_json);
      if (unit?.providerSessionId && unit.providerRequestId) recorded.add(JSON.stringify([unit.providerSessionId, unit.providerRequestId]));
    } catch { /* An unreadable audit row cannot prove ownership either way. */ }
  }

  const attributed = new Map<string, { units: TaskUsageUnit[]; descendants: Set<string> }>();
  for (const { rootSessionId, unit } of requests) {
    if (recorded.has(JSON.stringify([unit.providerSessionId, unit.providerRequestId]))) { report.counts.alreadyRecorded++; continue; }
    const at = Date.parse(unit.occurredAt);
    const owners = (bySession.get(rootSessionId) ?? []).filter(task => {
      const start = Date.parse(task.started_at), end = Date.parse(task.completed_at ?? task.failed_at ?? task.cancelled_at);
      return Number.isFinite(start) && Number.isFinite(end) && at >= start && at < end;
    });
    if (owners.length !== 1) {
      if (owners.length) report.counts.overlappingTaskWindows++; else report.counts.outsideTaskWindow++;
      continue;
    }
    report.counts.attributed++;
    const target = attributed.get(owners[0]!.id) ?? { units: [], descendants: new Set<string>() };
    target.units.push(unit);
    if (unit.providerSessionId !== rootSessionId) target.descendants.add(unit.providerSessionId!);
    attributed.set(owners[0]!.id, target);
  }

  // Cohort: the live run exists and is complete but holds no agent consumption.
  const runs = new Map<string, Row[]>();
  for (const row of db.query(`SELECT r.task_id,r.run_id,r.complete FROM multiremi_usage_runs r
    JOIN multiremi_turn_execution_records t ON t.id=r.task_id WHERE t.provider='codex'`).all() as Row[]) {
    if (!LIVE(row.run_id)) continue;
    const list = runs.get(row.task_id) ?? [];
    list.push(row);
    runs.set(row.task_id, list);
  }
  const consumed = new Set((db.query(`SELECT DISTINCT u.task_id FROM multiremi_usage_units u
    JOIN multiremi_turn_execution_records t ON t.id=u.task_id
    WHERE t.provider='codex' AND u.run_id NOT IN ('legacy','historical-evidence-v2') AND u.source<>'context_snapshot'
      AND COALESCE(u.purpose,'agent')='agent'
      AND COALESCE(u.input_tokens,0)+COALESCE(u.output_tokens,0)+COALESCE(u.cache_read_tokens,0)+COALESCE(u.cache_write_tokens,0)+COALESCE(u.actual_unsplit_tokens,0)>0`).all() as Row[])
    .map(row => row.task_id));
  const outcome = (task: Row): NativeBackfillOutcome | null => {
    if (!ENDED.includes(task.status)) return "nonterminal_task";
    const live = runs.get(task.id) ?? [];
    if (live.length !== 1 || Number(live[0]!.complete) !== 1) return "no_single_complete_live_run";
    if (consumed.has(task.id)) return "live_request_usage_present";
    return null;
  };
  const inScope = (task: Row) => (!options.taskId || task.id === options.taskId)
    && (!options.since || Date.parse(task.started_at) >= Date.parse(options.since));
  const repairs: ModernUsageRepair[] = [];
  for (const task of tasks) {
    if (!inScope(task)) continue;
    const evidence = attributed.get(task.id);
    const blocked = outcome(task);
    // Only cohort members and attempts that received evidence are reported.
    if (blocked && !evidence) continue;
    const requestCount = evidence?.units.length ?? 0;
    const tokens = evidence?.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0) ?? 0;
    if (blocked || !evidence) {
      report.tasks.push({ taskId: task.id, outcome: blocked ?? "no_native_request_evidence", requests: requestCount, actualTokens: tokens });
      continue;
    }
    const run = runs.get(task.id)![0]!;
    const scope: NativeRunScope = { taskId: task.id, runId: run.run_id, providerSessionId: task.session_id,
      evidenceRef: "codex_native_rollout_export", descendantSessionIds: [...evidence.descendants].sort() };
    const built = buildModernUsageRepairs(readModernRepairState(db, task.id), evidence.units, [scope]);
    if (built.length !== 1) {
      report.tasks.push({ taskId: task.id, outcome: "repair_not_proven", requests: requestCount, actualTokens: tokens });
      continue;
    }
    repairs.push(built[0]!);
    report.tasks.push({ taskId: task.id, outcome: "repaired", requests: built[0]!.correctedRequestIds.length,
      actualTokens: built[0]!.afterActualTokens - built[0]!.beforeActualTokens });
  }
  return { repairs, report };
}

export function summarizeNativeBackfill(report: NativeBackfillReport | undefined) {
  if (!report) return null;
  const outcomes: Record<string, { tasks: number; requests: number; actualTokens: number }> = {};
  for (const task of report.tasks) {
    const entry = outcomes[task.outcome] ??= { tasks: 0, requests: 0, actualTokens: 0 };
    entry.tasks++; entry.requests += task.requests; entry.actualTokens += task.actualTokens;
  }
  return { evidence: report.evidence, counts: report.counts, outcomes };
}
