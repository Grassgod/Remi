/** Offline migration job. No API, scheduler, daemon, bot or provider is started. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PostgresSyncDatabase, type SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { collectUnifiedBeforeReport, unifiedModelPreflight } from "../packages/server/src/store/unified-model-migration.js";
import { runMigrations } from "../packages/server/src/store/migrations.js";
import { UNIFIED_MODEL_MIGRATION } from "../packages/server/src/store/unified-model-schema.js";
import { readOnlyConversationTransaction } from "./reconcile-conversation-log.js";
import { prepareUsageAccountingStartup, ensureUsageAccountingStartup } from "../packages/server/src/store/usage-migration.js";
import { locksForRole, startHubRoleGuard } from "../packages/server/src/api/hub/hub-role-guard.js";
import { collectCopyUsageSnapshot, reconcileCopyUsage, type CopyUsageSnapshot } from "./unified-model-copy-usage.js";
import { runCopyStartupProcess, validateCopyBuild, validateCopyDatabaseUrl, type CopyStartupProcessOptions } from "./unified-model-copy-startup.js";
import { pages, inventory, issueSnapshot, laneKey, copyReadPositions, reconcileCopyReadback } from "./unified-model-copy-readback.js";
export { validateCopyDatabaseUrl } from "./unified-model-copy-startup.js";

type Row = Record<string, any>;
function save(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
function issueSamples(db: SqlDatabase, issues: Row[]): Row[] {
  const picked: Row[] = [], groups = new Map<string, number>();
  for (const issue of issues) {
    const group = `${issue.status}/${issue.assignee_type ?? 'unassigned'}/${issue.parent_issue_id ? 'child' : 'root'}`;
    const used = groups.get(group) ?? 0;
    if (used >= 3) continue;
    groups.set(group, used + 1);
    picked.push(issue);
  }
  // Explicitly include retry chains, unanswered decisions and parents even if
  // they are rare in a large status group. No message bodies leave the copy.
  const extra = db.query(`SELECT DISTINCT i.id FROM multiremi_issues i WHERE
    EXISTS (SELECT 1 FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id WHERE t.issue_id=i.id AND a.attempt_no>1)
    OR EXISTS (SELECT 1 FROM multiremi_issue_sessions s JOIN multiremi_conversation_log m ON m.session_id=s.id
      WHERE s.issue_id=i.id AND m.message_kind='decision' AND m.resolved_at IS NULL AND m.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM multiremi_issues c WHERE c.parent_issue_id=i.id)
    ORDER BY i.id LIMIT 15`).all() as Row[];
  const ids = new Set([...picked.map(i => i.id), ...extra.map(i => i.id)]);
  return issues.filter(i => ids.has(i.id)).map(issue => ({
    ...issue,
    turns: pages(db, `SELECT t.id,t.agent_id,t.status,t.wake_source,t.session_id,t.trigger_message_id,
      (SELECT COUNT(*) FROM multiremi_turn_attempts a WHERE a.turn_id=t.id) AS attempts
      FROM multiremi_turns t WHERE t.issue_id=? ORDER BY t.created_at DESC,t.seq DESC,t.id DESC`, [issue.id])
      .map(turn => ({ ...turn, attempts: Number(turn.attempts) })),
    decisions: pages(db, `SELECT m.id,m.sender_type,m.sender_id,m.resolved_at,
      CASE WHEN EXISTS(SELECT 1 FROM multiremi_conversation_log r WHERE r.reply_to_id=m.id AND r.message_kind='reply' AND r.deleted_at IS NULL) THEN 1 ELSE 0 END AS answered
      FROM multiremi_conversation_log m JOIN multiremi_issue_sessions s ON s.id=m.session_id
      WHERE s.issue_id=? AND m.kind='message' AND m.message_kind='decision' AND m.deleted_at IS NULL ORDER BY m.id`, [issue.id]),
    children: pages(db, "SELECT id,status FROM multiremi_issues WHERE parent_issue_id=? ORDER BY id", [issue.id]),
    review: "manual: apply inbox/issue-status.ts owner, trigger and child guards; migration does not rederive stored Issue status",
  }));
}

/** Exported for local synthetic fixtures; the CLI only opens the isolated PG. */
export async function rehearseUnifiedModelCopy(db: SqlDatabase, reportDir: string, copyDatabaseUrl?: string, options: {
  sourceSha?: string;
  imageDigest?: string;
  /** Synthetic process driver; unavailable from the rehearsal CLI. */
  process?: CopyStartupProcessOptions;
} = {}): Promise<Row> {
  if (copyDatabaseUrl) validateCopyDatabaseUrl(copyDatabaseUrl);
  const processMeasured = Boolean(copyDatabaseUrl || options.process);
  const build = processMeasured ? validateCopyBuild(options.sourceSha, options.imageDigest) : null;
  if (db.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(UNIFIED_MODEL_MIGRATION)) {
    throw new Error("Copy is already migrated; restore the immutable pre-cutover backup for every run");
  }
  const preflight = readOnlyConversationTransaction(db, () => unifiedModelPreflight(db));
  save(reportDir, "preflight.json", preflight);
  if (preflight.some(c => !c.ok)) throw new Error("Copy is not drained; see preflight.json. Never delete or rewrite blockers to manufacture a pass");
  const before = readOnlyConversationTransaction(db, () => collectUnifiedBeforeReport(db));
  const original = readOnlyConversationTransaction(db, () => ({
    counts: inventory(db), issues: issueSnapshot(db),
    checkpoints: pages(db, `SELECT session_id,agent_id,execution_scope,cursor_seq,parent_cursor_seq,
      wake_hint_seq,swept_to_seq,provider_session_id,work_dir,generation
      FROM multiremi_session_agent_lanes ORDER BY session_id,agent_id,execution_scope`),
    reads: pages(db, "SELECT session_id,agent_read_state FROM multiremi_conversation_heads ORDER BY session_id"),
  }));
  save(reportDir, "copy-baseline.json", original);
  const usageBefore = readOnlyConversationTransaction(db, () => collectCopyUsageSnapshot(db, "multiremi_tasks"));
  save(reportDir, "copy-usage-before.json", usageBefore);
  if (usageBefore.markers.length !== 2) throw new Error("F24 copy must already have both #384 usage cutover markers; take a matching post-startup copy");
  const usageSnapshots: Record<string, CopyUsageSnapshot> = { before: usageBefore };
  const usageReconciliation: Record<string, ReturnType<typeof reconcileCopyUsage>> = {};
  const startup: Row[] = [];
  const unmeasured = ["HTTP listener and /readyz", "container scheduling and container cold start",
    "Store facade construction", "read-pool/Live Hub/peer initialization", "background jobs, daemon, Feishu and outbox delivery",
    "production contention and concurrent api/api-runtime startup (roles run sequentially on the copy)"];
  if (!processMeasured) unmeasured.push("module loading and process cold start (in-process synthetic fixture only)");
  const recordStartup = () => save(reportDir, "copy-startup.json", { topology: "api=all with peer configured; api-runtime=runtime",
    startup, unmeasured, http_ready_measured: false, lock_policy: "single acquisition attempt; no rehearsal retries",
    process_startup_measured: processMeasured,
    timing_scope: "startup_total_ms: parent spawn to child offline ready after schema, usage gate and readback validation; database_total_ms: database steps only; process cleanup/exit excluded from startup_total_ms" });
  const recordUsage = (name: string, supplied?: CopyUsageSnapshot) => {
    const snapshot = supplied ?? readOnlyConversationTransaction(db, () => collectCopyUsageSnapshot(db, "multiremi_turn_attempts"));
    usageSnapshots[name] = snapshot;
    usageReconciliation[name] = reconcileCopyUsage(usageBefore, snapshot);
    save(reportDir, "copy-usage-reconciliation.json", { snapshots: usageSnapshots, stages: usageReconciliation,
      expectation: "Post-#384 startup copy: all usage table contents, attempt attribution, two markers and scalar evidence remain identical" });
  };
  const readPositions = copyReadPositions(original);
  // The final consumer cursor differs from the provider checkpoint in the raw
  // before report. Give every offline child the same actual-read expectation.
  const finalBefore = { ...before, lane_cursors: before.lane_cursors.map(lane => ({
    ...lane, cursor_seq: readPositions.get(laneKey(lane))?.seq ?? lane.cursor_seq,
  })) };
  const previousDir = process.env.MULTIREMI_MIGRATION_REPORT_DIR;
  try {
    process.env.MULTIREMI_MIGRATION_REPORT_DIR = reportDir;
    for (const phase of ["first_start", "restart"] as const) {
      for (const role of ["api", "api-runtime"] as const) {
        if (processMeasured) {
          const timing: Row = {};
          startup.push(timing);
          const result = await runCopyStartupProcess({ phase, role, sample: phase === "first_start" ? 1 : 2,
            ...build!, report_dir: reportDir, model_before: finalBefore, baseline: original, usage_before: usageBefore }, {
            ...options.process, databaseUrl: copyDatabaseUrl ?? options.process?.databaseUrl,
            onEvent: event => {
              Object.assign(timing, event.timing);
              if (event.event === "after_schema" && event.snapshot) recordUsage("after_schema", event.snapshot);
              if (event.event === "usage" && event.snapshot) recordUsage(`${phase}_${role}`, event.snapshot);
              recordStartup();
            },
          });
          Object.assign(timing, result);
          recordStartup();
          if (!result.offline_ready) {
            save(reportDir, "copy-timing.json", { startup, unmeasured, http_ready_measured: false,
              usage_reconciliation: usageReconciliation, mismatches: [...(result.readback_mismatches ?? []),
                ...Object.entries(usageReconciliation)
                  .flatMap(([stage, reconciliation]) => reconciliation.mismatches.map(message => `${stage}: ${message}`))] });
            throw new Error(`Copy reconciliation failed or offline startup not ready: ${phase}/${role}; see copy-startup.json and private log`);
          }
          continue;
        }
        const timing: Row = { phase, role, effective_api_role: role === "api" ? "all" : "runtime",
          mode: "in_process_synthetic_fixture", pid: process.pid, unit: "ms", startup_total_ms: null,
          steps_ms: {}, database_total_ms: 0, completed: false,
          connection_open_measured: Boolean(copyDatabaseUrl), role_lock_measured: Boolean(copyDatabaseUrl) };
        startup.push(timing);
        recordStartup();
        const measure = async <T>(name: string, action: () => T | Promise<T>): Promise<T> => {
          const started = performance.now();
          try { return await action(); }
          finally { timing.steps_ms[name] = performance.now() - started; timing.database_total_ms += timing.steps_ms[name]; }
        };
        let guard: Awaited<ReturnType<typeof startHubRoleGuard>> = null;
        let startupDb = db;
        try {
          guard = await measure("role_lock", () => startHubRoleGuard({ databaseUrl: copyDatabaseUrl,
            locks: locksForRole(timing.effective_api_role, true), timeoutMs: 0,
            exit: () => { throw new Error(`Copy ${role} role lock acquisition failed`); } }));
          if (copyDatabaseUrl) startupDb = await measure("database_open", () => new PostgresSyncDatabase(copyDatabaseUrl));
          await measure("run_migrations", () => runMigrations(startupDb));
          if (phase === "first_start" && role === "api") recordUsage("after_schema");
          await measure("prepare_usage", () => prepareUsageAccountingStartup(startupDb));
          await measure("ensure_usage", () => ensureUsageAccountingStartup(startupDb));
          timing.completed = true;
          recordUsage(`${phase}_${role}`);
        } catch (error) {
          timing.failed = true;
          throw error;
        } finally {
          try { recordStartup(); }
          finally {
            try { if (startupDb !== db) startupDb.close(); }
            finally { await guard?.close(); }
          }
        }
      }
    }
  } finally {
    if (previousDir === undefined) delete process.env.MULTIREMI_MIGRATION_REPORT_DIR;
    else process.env.MULTIREMI_MIGRATION_REPORT_DIR = previousDir;
  }
  // MUL-507 separates provider checkpoints from actual consumption. Keep the
  // raw before/after reports, compare final read positions to agent_read_state,
  // and compare original checkpoints to provider_cursor_seq independently.
  const final = readOnlyConversationTransaction(db, () => {
    const { issue_snapshot: issues, ...report } = reconcileCopyReadback(db, finalBefore, original);
    const mismatches = [...report.mismatches, ...Object.entries(usageReconciliation)
      .flatMap(([stage, result]) => result.mismatches.map(message => `${stage}: ${message}`))];
    return { ...report, mismatches,
      issue_samples: issueSamples(db, issues), usage_reconciliation: usageReconciliation };
  });
  save(reportDir, "copy-reconciliation.json", final);
  const summary = { migration: UNIFIED_MODEL_MIGRATION,
    migrationMs: startup[0]!.steps_ms.run_migrations, restartMs: startup[2]!.steps_ms.run_migrations,
    startup, unmeasured, http_ready_measured: false, orphan_steer: final.orphan_steer,
    usage_reconciliation: usageReconciliation, counts: final.counts,
    mismatches: final.mismatches, issue_sample_count: final.issue_samples.length,
    issue_sampling: "manual review required", checkpoint_count: final.checkpoint_count,
    read_position_count: final.read_position_count, partial_read_count: final.partial_read_count };
  save(reportDir, "copy-timing.json", summary);
  if (final.mismatches.length) throw new Error("Copy reconciliation failed; inspect private copy-reconciliation.json");
  return summary;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, 'report-dir': { type: 'string' },
    'source-sha': { type: 'string' }, 'image-digest': { type: 'string' } } });
  if (values.help) {
    console.log("Usage: bun scripts/rehearse-unified-model-copy.ts --report-dir DIR --source-sha FULL_SHA --image-digest sha256:DIGEST\nOnly via rehearse-unified-model-copy.sh after approval; uses MUL493_COPY_DATABASE_URL, never MULTIREMI_DATABASE_URL.");
  } else {
    const url = validateCopyDatabaseUrl(process.env.MUL493_COPY_DATABASE_URL);
    if (!values['report-dir']) throw new Error("--report-dir is required");
    validateCopyBuild(values['source-sha'], values['image-digest']);
    const db = new PostgresSyncDatabase(url);
    try {
      const identity = db.query("SELECT current_database() AS database,current_user AS role").get();
      if (identity?.database !== 'mul493_rehearsal' || identity?.role !== 'mul493_rehearsal') throw new Error("Copy database identity mismatch");
      console.log(JSON.stringify(await rehearseUnifiedModelCopy(db, values['report-dir'], url,
        { sourceSha: values['source-sha'], imageDigest: values['image-digest'] })));
    } finally { db.close(); }
  }
}
