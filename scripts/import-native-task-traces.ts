/**
 * Import a pinned, private native-recovery plan. Default is a read-only preflight.
 *
 * bun scripts/import-native-task-traces.ts --plan=<json> --staging-root=<dir>
 *   [--task-id=<id> ...] [--execute --journal=<jsonl>]
 *   [--service-uid=<uid> --service-gid=<gid>] [--verify --journal=<jsonl>]
 *
 * MULTIREMI_DATABASE_URL and MULTIREMI_SESSION_ARCHIVE_ROOT are required. No
 * MultiremiStore is constructed: the explicit facade below contains only
 * migration-free repositories and the narrow native-recovery commit. The
 * operator must verify native source hashes and hot-trace absence immediately
 * before execution and record that observation in each plan's evidence.
 * Writes and verification require the effective uid/gid to equal the declared API
 * service identity (explicit flags or REMI_RUNTIME_UID/GID). docker exec does
 * not run the image's privilege-dropping entrypoint again.
 */
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { isAbsolute, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { MultiremiStore } from "../packages/server/src/store/store.js";
import { StoreContext, type StoreContextHost } from "../packages/server/src/store/context.js";
import { SessionArchivesRepo, type NativeTraceRecoveryCommitInput } from "../packages/server/src/store/repos/session-archives-repo.js";
import { TaskTracesRepo, type TaskTraceArchivePointer, type TaskTracePointerSource } from "../packages/server/src/store/repos/task-traces-repo.js";
import { PostgresSyncDatabase, type SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { SessionArchiveService, sessionArchiveStorageConfigFromEnv, type NativeTraceRecoveryIngestInput } from "../packages/server/src/session-archive/service.js";
import { SessionArchiveReader } from "../packages/server/src/session-archive/reader.js";
import { verifyArchiveIngest } from "../packages/server/src/session-archive/ingest.js";
import { assertNativeExecutionBinding, canonicalRecoveryJson, nativeRecoveryMetadata } from "../packages/server/src/session-archive/native-recovery.js";
import { TraceReader } from "../packages/server/src/trace/trace-reader.js";
import { readZipMemberBody } from "../packages/shared/src/zip/reader.js";

export interface NativeTraceImportPlan extends NativeTraceRecoveryIngestInput {
  taskId: string;
  expectedTraceDigest: string;
  expectedEventCount: number;
}

export interface NativeTraceImportManifest {
  schema: 1;
  algorithmVersion: string;
  plans: NativeTraceImportPlan[];
}

export interface NativeTraceServiceIdentity { uid: number; gid: number }

function actualProcessIdentity(): NativeTraceServiceIdentity {
  if (!process.geteuid || !process.getegid) throw new Error("native trace import requires a POSIX process identity");
  return { uid: process.geteuid(), gid: process.getegid() };
}

function identityNumber(value: string | number | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) throw new Error(`${name} must be a numeric uid/gid`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number >= 0xffffffff) throw new Error(`${name} must be a valid POSIX uid/gid`);
  return number;
}

/** No I/O or mutation. Explicit arguments cannot contradict the configured API identity. */
export function assertNativeTraceServiceIdentity(
  declared?: NativeTraceServiceIdentity,
  actual: NativeTraceServiceIdentity = actualProcessIdentity(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): NativeTraceServiceIdentity {
  const configuredUid = identityNumber(env.REMI_RUNTIME_UID, "REMI_RUNTIME_UID");
  const configuredGid = identityNumber(env.REMI_RUNTIME_GID, "REMI_RUNTIME_GID");
  const uid = identityNumber(declared?.uid, "service uid") ?? configuredUid;
  const gid = identityNumber(declared?.gid, "service gid") ?? configuredGid;
  if (uid === undefined || gid === undefined) {
    throw new Error("trace import/verification requires the actual API service uid/gid: set --service-uid and --service-gid or REMI_RUNTIME_UID and REMI_RUNTIME_GID");
  }
  if ((configuredUid !== undefined && uid !== configuredUid) || (configuredGid !== undefined && gid !== configuredGid)) {
    throw new Error("declared service uid/gid conflicts with REMI_RUNTIME_UID/GID; verify the API process identity");
  }
  identityNumber(actual.uid, "effective process uid");
  identityNumber(actual.gid, "effective process gid");
  if (actual.uid !== uid || actual.gid !== gid) {
    throw new Error(`importer effective identity ${actual.uid}:${actual.gid} differs from API service ${uid}:${gid}; run the importer as the API uid/gid (docker exec --user ${uid}:${gid})`);
  }
  return { uid, gid };
}

type RecoveryStore = Pick<MultiremiStore, "getSessionArchive" | "listSessionArchivesForSubject" | "getTaskTrace"
  | "getNativeTraceRecoveryTaskSnapshot" | "commitNativeTraceRecovery" | "writeTaskTraceArchivePointers">;

/** No constructors, migrations, seeding, telemetry workers or timers from MultiremiStore. */
export function createNativeTraceOperatorStore(db: SqlDatabase): RecoveryStore {
  // Resolve every column this path reads/writes without creating or altering a schema.
  for (const sql of [
    "SELECT id, workspace_id, agent_id, runtime_id, provider, status, issue_id, issue_session_id, chat_session_id, session_id, started_at, completed_at, failed_at, cancelled_at, updated_at, usage FROM multiremi_tasks WHERE 1 = 0",
    "SELECT task_id, location, runtime_id, archive_id, member_path, data_offset, compressed_size, uncompressed_size, sha256, event_count, head_seq, closed, source, updated_at FROM multiremi_task_traces WHERE 1 = 0",
    "SELECT id, workspace_id, subject_kind, subject_id, format, source_revision, sha256, size_bytes, uploaded_size_bytes, file_count, relative_path, metadata, attempt_count, runtime_id, daemon_id, status, created_at, updated_at, completed_at FROM multiremi_session_archives WHERE 1 = 0",
    "SELECT session_id, id, task_id, metadata, body_md, revision, updated_at FROM multiremi_conversation_log WHERE 1 = 0",
    "SELECT subject_kind, subject_id, digest FROM multiremi_trace_backfill_progress WHERE 1 = 0",
    "SELECT task_id, digest FROM multiremi_trace_backfill_tasks WHERE 1 = 0",
  ]) db.query(sql).all();
  let facade: RecoveryStore;
  const context = new StoreContext(db, () => facade as unknown as StoreContextHost);
  const archives = new SessionArchivesRepo(context);
  const traces = new TaskTracesRepo(context);
  facade = {
    getSessionArchive: (id) => archives.get(id),
    listSessionArchivesForSubject: (kind, id) => archives.listSubject(kind, id),
    getTaskTrace: (id) => traces.get(id),
    getNativeTraceRecoveryTaskSnapshot: (id) => archives.getNativeTraceRecoveryTaskSnapshot(id),
    writeTaskTraceArchivePointers: (pointers: readonly TaskTraceArchivePointer[], source: TaskTracePointerSource) => traces.writeArchivePointers(pointers, source),
    commitNativeTraceRecovery: (input: NativeTraceRecoveryCommitInput) => db.transaction(() => archives.commitNativeTraceRecoveryWithinTransaction(input))(),
  };
  return facade;
}

function assertManifest(value: unknown): asserts value is NativeTraceImportManifest {
  const manifest = value as NativeTraceImportManifest;
  if (!manifest || manifest.schema !== 1 || !manifest.algorithmVersion || !Array.isArray(manifest.plans) || !manifest.plans.length) {
    throw new Error("invalid native recovery manifest");
  }
  const seen = new Set<string>();
  for (const plan of manifest.plans) {
    if (!plan || plan.algorithmVersion !== manifest.algorithmVersion || !/^tsk_[a-zA-Z0-9_-]+$/.test(plan.taskId)
      || seen.has(plan.taskId) || plan.tasks?.length !== 1 || plan.tasks[0]?.task.taskId !== plan.taskId
      || !/^[a-f0-9]{64}$/.test(plan.expectedTraceDigest)
      || !Number.isSafeInteger(plan.expectedEventCount) || plan.expectedEventCount < 1) throw new Error("invalid or duplicate native recovery plan");
    seen.add(plan.taskId);
    nativeRecoveryMetadata(plan.algorithmVersion, plan.tasks);
  }
}

async function regularPath(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error("unsafe native recovery path");
}

async function checkedStagePath(root: string, target: string, allowMissing: boolean): Promise<string> {
  const base = resolve(root);
  const path = resolve(target);
  const suffix = relative(base, path);
  if (!isAbsolute(target) || !suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error("native recovery archive is outside the explicit staging root");
  }
  let part = dirname(path);
  for (;;) {
    await regularPath(part, true);
    if (part === dirname(part)) break;
    part = dirname(part);
  }
  try { await regularPath(path, false); }
  catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return path;
}

function checkIdentity(store: RecoveryStore, plan: NativeTraceImportPlan): void {
  const observed = store.getNativeTraceRecoveryTaskSnapshot(plan.taskId);
  if (canonicalRecoveryJson(observed) !== canonicalRecoveryJson(plan.tasks[0]!.task)) {
    throw new Error(`terminal task identity changed: ${plan.taskId}`);
  }
}

function checkOwnership(db: SqlDatabase, plan: NativeTraceImportPlan): void {
  const task = plan.tasks[0]!.task;
  assertNativeExecutionBinding(db, plan.tasks[0]!);
  if (task.workspaceId !== plan.workspaceId || task.runtimeId !== plan.runtimeId
    || (plan.subject.kind === "issue" ? task.issueId !== plan.subject.id
      : plan.subject.kind === "chat" ? task.issueId !== null || task.chatSessionId !== plan.subject.id
        : task.taskId !== plan.subject.id || task.issueId !== null)) throw new Error(`archive/task ownership mismatch: ${plan.taskId}`);
  const runtime = db.query("SELECT workspace_id, provider, daemon_id FROM multiremi_runtimes WHERE id = ?").get(plan.runtimeId);
  if (!runtime || runtime.workspace_id !== plan.workspaceId || runtime.provider !== task.provider || runtime.daemon_id !== plan.daemonId) {
    throw new Error(`Runtime ownership changed: ${plan.taskId}`);
  }
  if (plan.subject.kind === "issue") {
    const issue = db.query("SELECT workspace_id, lifecycle_state FROM multiremi_issues WHERE id = ?").get(plan.subject.id);
    if (!issue || issue.workspace_id !== plan.workspaceId || String(issue.lifecycle_state ?? "active") !== "active") {
      throw new Error(`Issue is missing, moved or deleting: ${plan.taskId}`);
    }
  } else if (plan.subject.kind === "chat") {
    const chat = db.query("SELECT workspace_id FROM multiremi_chat_sessions WHERE id = ?").get(plan.subject.id);
    if (!chat || chat.workspace_id !== plan.workspaceId) throw new Error(`Chat is missing or moved: ${plan.taskId}`);
  }
}

function matchingImportedArchive(store: RecoveryStore, plan: NativeTraceImportPlan) {
  const pointer = store.getTaskTrace(plan.taskId);
  if (pointer?.location !== "archive" || !pointer.archiveId) return null;
  const archive = store.getSessionArchive(pointer.archiveId);
  if (!archive || archive.status !== "ready" || archive.workspaceId !== plan.workspaceId
    || archive.subjectKind !== plan.subject.kind || archive.subjectId !== plan.subject.id
    || archive.runtimeId !== plan.runtimeId || archive.daemonId !== plan.daemonId
    || archive.sha256 !== plan.sha256 || archive.sourceRevision !== plan.sourceRevision
    || canonicalRecoveryJson(archive.metadata) !== canonicalRecoveryJson(nativeRecoveryMetadata(plan.algorithmVersion, plan.tasks))) {
    throw new Error(`a different archive already owns task: ${plan.taskId}`);
  }
  return archive;
}

async function stagedDigest(service: SessionArchiveService, plan: NativeTraceImportPlan): Promise<void> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(plan.archivePath)) { hash.update(chunk); size += chunk.length; }
  if (size !== plan.sizeBytes || hash.digest("hex") !== plan.sha256) throw new Error(`staged archive hash changed: ${plan.taskId}`);
  const handle = await open(plan.archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const ingest = await verifyArchiveIngest(handle);
    if (ingest.sourceRevision !== plan.sourceRevision || ingest.index.subject.kind !== plan.subject.kind
      || ingest.index.subject.id !== plan.subject.id) throw new Error(`staged archive subject/revision mismatch: ${plan.taskId}`);
    await service.validateNativeTraceRecovery(plan, ingest);
    const member = ingest.traces[0]!;
    const { bytes } = await readZipMemberBody(handle, {
      dataOffset: member.data_offset, compressedSize: member.compressed_size,
      uncompressedSize: member.uncompressed_size, sha256: member.sha256,
    });
    const events = bytes.toString("utf8").trimEnd().split("\n").slice(1, -1).map((line) => JSON.parse(line));
    const digest = createHash("sha256").update(events.map((event) => JSON.stringify(event)).join("\n") + "\n").digest("hex");
    if (events.length !== plan.expectedEventCount || digest !== plan.expectedTraceDigest) throw new Error(`staged event digest mismatch: ${plan.taskId}`);
  } finally { await handle.close(); }
}

function protectedStateDigest(db: SqlDatabase, plan: NativeTraceImportPlan): string {
  const value = {
    task: db.query(`SELECT id, status, usage, result, error, failure_reason, agent_id, runtime_id, provider,
      issue_id, issue_session_id, chat_session_id, session_id, started_at, completed_at, failed_at, cancelled_at, updated_at
      FROM multiremi_tasks WHERE id = ?`).get(plan.taskId),
    cards: db.query("SELECT * FROM multiremi_conversation_log WHERE task_id = ? ORDER BY session_id, seq").all(plan.taskId),
    progress: db.query("SELECT * FROM multiremi_trace_backfill_progress WHERE subject_kind = ? AND subject_id = ?").get(plan.subject.kind, plan.subject.id),
    legacy: db.query("SELECT * FROM multiremi_trace_backfill_tasks WHERE task_id = ?").get(plan.taskId),
  };
  return createHash("sha256").update(canonicalRecoveryJson(value)).digest("hex");
}

async function verifyImported(store: RecoveryStore, root: string, plan: NativeTraceImportPlan) {
  const archive = matchingImportedArchive(store, plan);
  if (!archive) throw new Error(`task has not been imported: ${plan.taskId}`);
  const reader = new TraceReader({
    store: store as MultiremiStore,
    archive: new SessionArchiveReader({ store: store as MultiremiStore, root }),
    daemon: { read: async () => { throw new Error("native migration verification cannot read a daemon"); } },
  });
  let after = 0, count = 0;
  const hash = createHash("sha256");
  for (;;) {
    const page = await reader.readTrace(plan.taskId, after, 200);
    if (page.state !== "ok" || page.source !== "archive" || !page.closed || page.head !== plan.expectedEventCount) {
      throw new Error(`imported trace is not a closed readable archive: ${plan.taskId}`);
    }
    for (const event of page.events) { hash.update(JSON.stringify(event) + "\n"); count++; }
    if (page.eof) break;
    if (page.next_after_seq <= after) throw new Error(`trace cursor did not advance: ${plan.taskId}`);
    after = page.next_after_seq;
  }
  const digest = hash.digest("hex");
  if (count !== plan.expectedEventCount || digest !== plan.expectedTraceDigest) throw new Error(`imported trace event digest mismatch: ${plan.taskId}`);
  return { archiveId: archive.id, digest, eventCount: count };
}

export interface NativeTraceImportOptions {
  db: SqlDatabase;
  archiveRoot: string;
  stagingRoot: string;
  manifest: NativeTraceImportManifest;
  execute?: boolean;
  verify?: boolean;
  taskIds?: readonly string[];
  /** Required for writes; append, flush, fsync before processing the next Task. */
  journalPath?: string;
  log?: (line: string) => void;
  /** The verified API identity. Otherwise use the container's REMI_RUNTIME_UID/GID. */
  serviceIdentity?: NativeTraceServiceIdentity;
  /** Dependency injection for tests; CLI always reads the real effective uid/gid. */
  processIdentity?: () => NativeTraceServiceIdentity;
}

export async function runNativeTraceImport(options: NativeTraceImportOptions) {
  // Must precede even schema inspection, journal creation and archive staging.
  if (options.execute || options.verify) assertNativeTraceServiceIdentity(options.serviceIdentity, options.processIdentity?.() ?? actualProcessIdentity());
  assertManifest(options.manifest);
  if (options.execute && options.verify) throw new Error("choose --execute or --verify");
  if (options.execute && !options.journalPath) throw new Error("execution requires --journal");
  const selected = options.taskIds?.length ? new Set(options.taskIds) : null;
  const plans = options.manifest.plans.filter((plan) => !selected || selected.has(plan.taskId));
  if (!plans.length || (selected && plans.length !== selected.size)) throw new Error("selected task IDs must exist exactly once in the plan");
  const store = createNativeTraceOperatorStore(options.db);
  const service = new SessionArchiveService(store as MultiremiStore, sessionArchiveStorageConfigFromEnv(options.archiveRoot));
  const log = options.log ?? (() => {});
  const results: Array<{ taskId: string; outcome: string; archiveId?: string; digest: string; eventCount: number; preservedStateDigest: string }> = [];
  const priorState = new Map<string, string>();
  if (options.journalPath) {
    try {
      const info = await lstat(options.journalPath);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 64 * 1024 * 1024) throw new Error("invalid native recovery journal");
      for (const line of (await readFile(options.journalPath, "utf8")).split("\n").filter(Boolean)) {
        const row = JSON.parse(line);
        if (typeof row.taskId === "string" && typeof row.preservedStateDigest === "string") {
          const previous = priorState.get(row.taskId);
          if (previous && previous !== row.preservedStateDigest) throw new Error("native recovery journal has inconsistent state digests");
          priorState.set(row.taskId, row.preservedStateDigest);
        }
      }
    } catch (error) { if (!options.execute || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // Verify the complete selected plan before the first write.
  for (const plan of plans) {
    checkIdentity(store, plan);
    checkOwnership(options.db, plan);
    const existing = matchingImportedArchive(store, plan);
    if (!options.verify) await checkedStagePath(options.stagingRoot, plan.archivePath, Boolean(existing));
    if (existing || options.verify) await verifyImported(store, options.archiveRoot, plan);
    else {
      if (canonicalRecoveryJson(store.getTaskTrace(plan.taskId)) !== canonicalRecoveryJson(plan.tasks[0]!.expectedPointer)) {
        throw new Error(`daemon pointer changed since planning: ${plan.taskId}`);
      }
      await stagedDigest(service, plan);
    }
  }
  let journal: Awaited<ReturnType<typeof open>> | null = null;
  if (options.execute) {
    const path = resolve(options.journalPath!);
    await regularPath(dirname(path), true);
    journal = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
    const info = await journal.stat();
    if (!info.isFile() || (info.mode & 0o077)) { await journal.close(); throw new Error("journal must be a regular owner-only file"); }
  }
  try {
    for (const plan of plans) {
      const before = protectedStateDigest(options.db, plan);
      if (priorState.has(plan.taskId) && priorState.get(plan.taskId) !== before) throw new Error(`protected task/card state differs from original journal: ${plan.taskId}`);
      checkIdentity(store, plan);
      let result: { archiveId?: string; digest: string; eventCount: number } = { digest: plan.expectedTraceDigest, eventCount: plan.expectedEventCount };
      let outcome = "validated";
      if (options.execute) {
        await journal!.writeFile(JSON.stringify({ at: new Date().toISOString(), taskId: plan.taskId, outcome: "applying",
          digest: plan.expectedTraceDigest, eventCount: plan.expectedEventCount, preservedStateDigest: before }) + "\n");
        await journal!.sync();
        const existing = matchingImportedArchive(store, plan);
        if (existing) outcome = "replayed";
        else {
          // ingest moves its input. Preserve the immutable planned ZIP for
          // future verification/replays and use a disposable exact copy.
          const applyDirectory = await mkdtemp(join(resolve(options.stagingRoot), ".native-trace-apply-"));
          try {
            const applyPath = join(applyDirectory, "sessions.zip");
            await copyFile(plan.archivePath, applyPath, constants.COPYFILE_EXCL);
            const committed = await service.ingestNativeTraceRecovery({ ...plan, archivePath: applyPath });
            outcome = committed.replayed ? "replayed" : "imported";
          } finally { await rm(applyDirectory, { recursive: true, force: true }); }
        }
        result = await verifyImported(store, options.archiveRoot, plan);
      } else if (options.verify) {
        outcome = "verified";
        result = await verifyImported(store, options.archiveRoot, plan);
      }
      if (protectedStateDigest(options.db, plan) !== before) throw new Error(`protected task/card/backfill state changed: ${plan.taskId}`);
      const row = { taskId: plan.taskId, outcome, ...result, preservedStateDigest: before };
      if (journal) { await journal.writeFile(JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n"); await journal.sync(); }
      log(JSON.stringify(row));
      results.push(row);
    }
  } finally { await journal?.close(); }
  return { mode: options.execute ? "execute" : options.verify ? "verify" : "dry-run", tasks: results.length, results };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (key: string) => args.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  if (args.includes("--help")) {
    process.stdout.write("bun scripts/import-native-task-traces.ts --plan=<json> --staging-root=<dir> [--task-id=<id> ...] [--execute --journal=<jsonl>] [--service-uid=<uid> --service-gid=<gid>] [--verify]\n");
    return;
  }
  const execute = args.includes("--execute");
  const verify = args.includes("--verify");
  const serviceUid = identityNumber(value("service-uid"), "--service-uid");
  const serviceGid = identityNumber(value("service-gid"), "--service-gid");
  if ((serviceUid === undefined) !== (serviceGid === undefined)) throw new Error("--service-uid and --service-gid must be provided together");
  const serviceIdentity = serviceUid === undefined ? undefined : { uid: serviceUid, gid: serviceGid! };
  // Reject root docker-exec invocations before reading the plan or opening PostgreSQL.
  if (execute || verify) assertNativeTraceServiceIdentity(serviceIdentity);
  const planPath = value("plan"), stagingRoot = value("staging-root");
  const databaseUrl = process.env.MULTIREMI_DATABASE_URL?.trim();
  const archiveRoot = process.env.MULTIREMI_SESSION_ARCHIVE_ROOT?.trim();
  if (!planPath || !stagingRoot || !databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl) || !archiveRoot) {
    throw new Error("--plan, --staging-root, MULTIREMI_DATABASE_URL (Postgres) and MULTIREMI_SESSION_ARCHIVE_ROOT are required");
  }
  await regularPath(resolve(planPath), false);
  const manifest: unknown = JSON.parse(await readFile(planPath, "utf8"));
  assertManifest(manifest);
  const db = new PostgresSyncDatabase(databaseUrl);
  try {
    if (!execute) db.exec("SET default_transaction_read_only = on");
    const report = await runNativeTraceImport({
      db, archiveRoot, stagingRoot, manifest, execute, verify,
      taskIds: args.filter((arg) => arg.startsWith("--task-id=")).map((arg) => arg.slice(10)),
      journalPath: value("journal"), log: (line) => process.stdout.write(line + "\n"),
      serviceIdentity,
    });
    process.stdout.write(JSON.stringify({ mode: report.mode, tasks: report.tasks }) + "\n");
  } finally { db.close(); }
}

if (import.meta.main || (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "native trace import failed";
    // Driver errors can mention connection URIs; never print raw connection data.
    const safe = message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database]").slice(0, 500);
    process.stderr.write(JSON.stringify({ error: safe }) + "\n");
    process.exitCode = 1;
  });
}
