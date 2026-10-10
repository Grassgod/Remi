/** Offline role entrypoint and parent-side process timing; never starts a server. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PostgresSyncDatabase, type SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { runMigrations } from "../packages/server/src/store/migrations.js";
import { locksForRole, startHubRoleGuard } from "../packages/server/src/api/hub/hub-role-guard.js";
import type { UnifiedModelReport } from "../packages/server/src/store/unified-model-migration.js";
import { readOnlyConversationTransaction } from "./reconcile-conversation-log.js";
import { collectCopyUsageSnapshot, reconcileCopyUsage, type CopyUsageSnapshot } from "./unified-model-copy-usage.js";
import { reconcileCopyReadback, type CopyBaseline } from "./unified-model-copy-readback.js";

export function validateCopyDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error("MUL493_COPY_DATABASE_URL is required; ambient production database configuration is never used");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid copy database URL"); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== "mul493-copy-postgres"
      || url.port !== "5432" || url.username !== "mul493_rehearsal" || url.password
      || url.pathname !== "/mul493_rehearsal" || url.search || url.hash) {
    throw new Error("Only the isolated mul493-copy-postgres rehearsal database is allowed");
  }
  return value;
}

export function validateCopyBuild(sourceSha: string | undefined, imageDigest: string | undefined) {
  if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha) || !imageDigest || !/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    throw new Error("Full candidate source SHA and pinned image digest are required for offline process timing");
  }
  return { source_sha: sourceSha, image_digest: imageDigest };
}

export interface CopyStartupInput {
  role: "api" | "api-runtime";
  phase: "first_start" | "restart";
  sample: number;
  source_sha: string;
  image_digest: string;
  report_dir: string;
  model_before: UnifiedModelReport;
  baseline: CopyBaseline;
  usage_before: CopyUsageSnapshot;
}
type Row = Record<string, any>;
export interface CopyStartupEvent {
  event: "progress" | "after_schema" | "usage" | "ready" | "failed";
  timing: Row;
  snapshot?: CopyUsageSnapshot;
  mismatches?: string[];
}

/** The factory is explicit so synthetic fixtures exercise the same child path. */
export async function runCopyStartupWorker(input: CopyStartupInput, options: {
  open: () => SqlDatabase;
  databaseUrl?: string;
  verifyIdentity?: (db: SqlDatabase) => void;
  emit: (event: CopyStartupEvent) => void;
}): Promise<void> {
  validateCopyBuild(input.source_sha, input.image_digest);
  if (!["api", "api-runtime"].includes(input.role) || !["first_start", "restart"].includes(input.phase)
      || !Number.isSafeInteger(input.sample) || input.sample < 1) throw new Error("Invalid offline role sample");
  const timing: Row = { role: input.role, phase: input.phase, sample: input.sample,
    source_sha: input.source_sha, image_digest: input.image_digest, pid: process.pid, unit: "ms",
    mode: "offline_process", effective_api_role: input.role === "api" ? "all" : "runtime",
    steps_ms: {}, database_total_ms: 0, offline_ready: false, completed: false, status: "not_ready",
    connection_open_measured: true, role_lock_measured: Boolean(options.databaseUrl) };
  const emit = (event: CopyStartupEvent["event"], extra: Partial<CopyStartupEvent> = {}) => options.emit({ event, timing, ...extra });
  const databaseSteps = new Set(["role_lock", "database_open", "run_migrations"]);
  const measure = async <T>(name: string, action: () => T | Promise<T>): Promise<T> => {
    timing.active_step = name;
    emit("progress");
    const started = performance.now();
    try { return await action(); }
    finally {
      timing.steps_ms[name] = performance.now() - started;
      if (databaseSteps.has(name)) timing.database_total_ms += timing.steps_ms[name];
      emit("progress");
    }
  };
  let db: SqlDatabase | undefined;
  let guard: Awaited<ReturnType<typeof startHubRoleGuard>> = null;
  try {
    guard = await measure("role_lock", () => startHubRoleGuard({ databaseUrl: options.databaseUrl,
      locks: locksForRole(timing.effective_api_role, true), timeoutMs: 0,
      exit: () => { throw new Error("Copy role lock acquisition failed"); } }));
    db = await measure("database_open", options.open);
    options.verifyIdentity?.(db);
    await measure("run_migrations", () => runMigrations(db!));
    if (input.phase === "first_start" && input.role === "api") {
      const snapshot = await measure("after_schema_readback", () => readOnlyConversationTransaction(db!,
        () => collectCopyUsageSnapshot(db!, "multiremi_turn_attempts")));
      emit("after_schema", { snapshot });
    }
    const evidence = await measure("readback_validation", () => readOnlyConversationTransaction(db!, () => {
      const snapshot = collectCopyUsageSnapshot(db!, "multiremi_turn_attempts");
      const model = reconcileCopyReadback(db!, input.model_before, input.baseline);
      return { snapshot, mismatches: [...model.mismatches, ...reconcileCopyUsage(input.usage_before, snapshot).mismatches] };
    }));
    timing.readback_mismatches = evidence.mismatches;
    emit("usage", evidence);
    if (evidence.mismatches.length) throw new Error("Copy reconciliation failed before offline ready");
    timing.active_step = null;
    timing.offline_ready = true;
    timing.completed = true;
    timing.status = "success";
    emit("ready");
  } catch (error) {
    timing.failed = true;
    timing.failure_stage = timing.active_step;
    emit("failed");
    throw error;
  } finally {
    try { db?.close(); }
    finally { await guard?.close(); }
  }
}

export interface CopyStartupProcessOptions {
  databaseUrl?: string;
  /** Fixture driver only; the rehearsal CLI always uses this file. */
  command?: string[];
  env?: Record<string, string>;
  onEvent?: (event: CopyStartupEvent) => void;
}

/** Stop the parent clock on the ready IPC event, before child cleanup/exit. */
export async function runCopyStartupProcess(input: CopyStartupInput, options: CopyStartupProcessOptions): Promise<Row> {
  validateCopyBuild(input.source_sha, input.image_digest);
  if (!options.command) validateCopyDatabaseUrl(options.databaseUrl);
  const timing: Row = { role: input.role, phase: input.phase, sample: input.sample, unit: "ms",
    mode: "offline_process", source_sha: input.source_sha, image_digest: input.image_digest,
    parent_pid: process.pid, pid: null, started_at: null, ready_at: null,
    startup_total_ms: null, attempt_total_ms: null, database_total_ms: 0, steps_ms: {},
    offline_ready: false, completed: false, status: "not_ready" };
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
    BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR,
    MUL493_COPY_DATABASE_URL: options.databaseUrl, MULTIREMI_MIGRATION_REPORT_DIR: input.report_dir,
    ...options.env };
  let child: Bun.Subprocess<Blob, "pipe", "pipe">;
  let readyMs: number | null = null;
  let receivedFailure = false;
  let protocolFailure = false;
  let readbackValidated = false;
  const command = options.command ?? [process.execPath, "--no-env-file", import.meta.path];
  const stdin = new Blob([JSON.stringify(input)]);
  timing.started_at = new Date().toISOString();
  const started = performance.now();
  try {
    child = Bun.spawn(command, {
      cwd: join(import.meta.dir, ".."), env, stdin, stdout: "pipe", stderr: "pipe",
      ipc: (message: CopyStartupEvent) => {
        const observed = performance.now();
        if (!message?.timing || message.timing.pid !== child.pid || message.timing.role !== input.role
            || message.timing.phase !== input.phase || message.timing.sample !== input.sample
            || message.timing.source_sha !== input.source_sha || message.timing.image_digest !== input.image_digest
            || !["progress", "after_schema", "usage", "ready", "failed"].includes(message.event)) {
          protocolFailure = true;
          return;
        }
        Object.assign(timing, message.timing);
        // Only the parent may certify the readiness boundary and total duration.
        timing.offline_ready = false;
        timing.completed = false;
        timing.status = "not_ready";
        if (message.event === "failed") receivedFailure = true;
        if (message.event === "usage") {
          readbackValidated = Boolean(message.snapshot && Array.isArray(message.mismatches)
            && message.mismatches.length === 0 && reconcileCopyUsage(input.usage_before, message.snapshot).mismatches.length === 0);
        }
        if (message.event === "ready") {
          if (readyMs !== null || receivedFailure || !readbackValidated || !message.timing.offline_ready) protocolFailure = true;
          else { readyMs = observed - started; timing.ready_at = new Date().toISOString(); }
        }
        options.onEvent?.({ ...message, timing: { ...timing } });
      },
    });
    timing.pid = child.pid;
  } catch (error) {
    timing.attempt_total_ms = performance.now() - started;
    timing.failed = true;
    timing.failure_stage = "process_spawn";
    options.onEvent?.({ event: "failed", timing });
    return timing;
  }
  options.onEvent?.({ event: "progress", timing: { ...timing } });
  const exited = child.exited.then(code => {
    timing.attempt_total_ms = performance.now() - started;
    return code;
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), exited,
  ]);
  timing.exit_code = exitCode;
  timing.startup_total_ms = readyMs;
  timing.offline_ready = readyMs !== null && exitCode === 0 && !receivedFailure && !protocolFailure;
  timing.completed = timing.offline_ready;
  timing.status = timing.offline_ready ? "success" : "not_ready";
  if (!timing.offline_ready) {
    timing.failed = true;
    timing.failure_stage ??= protocolFailure ? "ready_protocol" : timing.active_step ?? (readyMs === null ? "exit_before_ready" : "process_exit");
  }
  mkdirSync(input.report_dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(input.report_dir, `startup-${input.phase}-${input.role}.private.log`), stdout + stderr, { mode: 0o600 });
  options.onEvent?.({ event: timing.offline_ready ? "progress" : "failed", timing: { ...timing } });
  return timing;
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text()) as CopyStartupInput;
    const url = validateCopyDatabaseUrl(process.env.MUL493_COPY_DATABASE_URL);
    await runCopyStartupWorker(input, { databaseUrl: url, open: () => new PostgresSyncDatabase(url),
      verifyIdentity: db => {
        const identity = db.query("SELECT current_database() AS database,current_user AS role").get();
        if (identity?.database !== "mul493_rehearsal" || identity?.role !== "mul493_rehearsal") throw new Error("Copy database identity mismatch");
      }, emit: event => process.send!(event) });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally { process.disconnect?.(); }
}
