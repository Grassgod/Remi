#!/usr/bin/env bun
/**
 * MUL-432 item 10 (MUL-402 B8): trace read latency from backfilled archives,
 * by trace size.
 *
 * Builds three synthetic size tiers (`generateTieredCorpus` in
 * `scripts/lib/task-trace-synthetic.ts`): 170 tasks each whose row count and
 * column bytes are production's per-task p50, p90 and p99 within ±5%, with
 * payload text taken from the repository's docs and sources so the members
 * compress like real traces rather than like a word list. Runs the real
 * backfill (`scripts/backfill-task-traces.ts`) so every task points into a
 * `trace_backfill` archive, reconciles the fixed 200-task sample
 * (`scripts/reconcile-task-traces.ts` defaults), then reads every tier task
 * back through the B5 `TraceReader` — the same path `GET /api/tasks/:id/trace`
 * takes — on SQLite and on Postgres, each reported separately.
 *
 * Before anything is generated the disk it will take is estimated from the
 * tier targets and checked against the free space of every file system
 * involved; when it does not fit the bench stops with exit status 4 and
 * leaves the tiers as they are.
 *
 * Per task, in a seeded random order:
 *   full / cold  — archive file evicted from the page cache, then pages of
 *                  500 events from seq 0 until eof;
 *   full / warm  — the same again, file now cached;
 *   tail / cold  — evicted again, one read of the last 100 events from a seq
 *                  cursor (the seq before them);
 *   tail / warm  — the same again.
 * Every read is checked against the pointer (event count and head). Latency
 * is wall time around the `TraceReader` calls (pointer and archive row
 * lookups, open, pread, inflate, sha256 check, line parse); no HTTP.
 * Percentiles are nearest-rank (`sorted[ceil(q·n) - 1]`).
 *
 * Bytes read: `FileHandle.prototype.read` is counted, so the figure is what
 * the reader asked the file system for, per `readTrace` call; each call is
 * checked against `compressed_size + 64 KiB` of its member
 * (`archive-trace-read-guard.ts`). `/proc/self/io` `read_bytes` (what reached
 * storage) is recorded alongside to show that cold reads really missed the
 * page cache and warm ones did not. Eviction is `posix_fadvise(DONTNEED)` on
 * the whole archive file; no root or cache drop is needed.
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://user@127.0.0.1:5432/postgres \
 *     bun run tests/manual/bench-archive-trace-read.ts \
 *     --out reports/performance/MUL-402-archive-trace-read-2026-09-29.json
 *
 * Options: --tiers=p50,p90,p99 --per-tier=170 --warmup=20 --jitter=0.05
 *   --seed=m432-bench --backends=sqlite,postgres
 *   --work-dir=<dir> (default a fresh <tmpdir>/m432-bench-*) --keep
 *   --estimate-only (print the disk estimate and exit)
 *   --inject-extra-read-bytes=N (after every call, also read N bytes of a
 *     scratch file through the counted FileHandle; only for testing the guard)
 * The Markdown report is written next to `--out` with the same name.
 * Exit status: 0 ok; 3 a read failed validation, the reconcile sample found a
 * mismatch or a call broke the byte bound; 4 not enough disk.
 */
import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { cpus, loadavg, totalmem, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { deflateRawSync } from "node:zlib";
import { InMemoryDaemonTraceReader } from "../../packages/server/src/api/trace/daemon-trace-reader.js";
import { SessionArchiveReader } from "../../packages/server/src/session-archive/reader.js";
import { SessionArchiveService } from "../../packages/server/src/session-archive/service.js";
import { PostgresSyncDatabase, type SqlDatabase } from "../../packages/server/src/store/db/postgres.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { TRACE_READ_MAX_LIMIT, TraceReader } from "../../packages/server/src/trace/trace-reader.js";
import { runTraceBackfill } from "../../scripts/backfill-task-traces.js";
import { runTraceReconcile } from "../../scripts/reconcile-task-traces.js";
import { TRACE_BACKFILL_GROUPS } from "../../scripts/lib/task-trace-backfill.js";
import { TRACE_RECONCILE_SAMPLE_QUOTAS, TRACE_RECONCILE_SAMPLE_SEED } from "../../scripts/lib/task-trace-reconcile.js";
import { sampleWithoutReplacement, seededRandom } from "../../scripts/lib/seeded-random.js";
import {
  buildTraceTextPools,
  generateTieredCorpus,
  PRODUCTION_TRACE_SHAPE,
  textPool,
  TIERED_CORPUS_DEFAULTS,
  TRACE_SIZE_TIER_TARGETS,
  TRACE_SIZE_TIERS,
  type TieredCorpusParams,
  type TieredCorpusSummary,
  type TieredTask,
  type TraceSizeTier,
} from "../../scripts/lib/task-trace-synthetic.js";
import { benchExitCode, TRACE_READ_BYTE_SLACK, TraceReadByteGuard } from "./archive-trace-read-guard.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TAIL_WINDOW = 100;
const POSIX_FADV_DONTNEED = 4;
const OPS = ["full_cold", "full_warm", "tail_cold", "tail_warm"] as const;
type Op = (typeof OPS)[number];
const BENCH_EXIT_NO_SPACE = 4;

/**
 * Compression ratios the synthetic text is compared with. None is a
 * production figure: the MUL-402 read-only survey (cmt_z0j166q2zbx9) and the
 * spec give rows and bytes, not a ratio.
 */
const COMPRESSION_REFERENCES = {
  local_transcript: {
    ratio: 3.25,
    note: "本机一份 agent 会话记录（非生产）的 tool_use / tool_result / text 载荷按 trace 行渲染后整体 deflate-6：343 事件 3.25×；切成 49 KB 窗口中位 3.17×，425 KB 窗口中位 3.21×（MUL-432 第一段返工时一次性测得，文件不入库）",
  },
  previous_report: {
    ratio: 4.2,
    note: "本报告上一版（英文词池、按分位分桶，commit 7a77ca80）1798 个成员的 Σ解压 / Σ压缩",
  },
};

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const OUT = argValue("out");
const SEED = argValue("seed") ?? "m432-bench";
const TIERS = (argValue("tiers") ?? TRACE_SIZE_TIERS.join(",")).split(",").map((tier) => tier.trim()).filter(Boolean) as TraceSizeTier[];
const PER_TIER = Number(argValue("per-tier") ?? TIERED_CORPUS_DEFAULTS.perTier);
const WARMUP = Number(argValue("warmup") ?? TIERED_CORPUS_DEFAULTS.warmupTasks);
const JITTER = Number(argValue("jitter") ?? TIERED_CORPUS_DEFAULTS.jitter);
const BACKENDS = (argValue("backends") ?? "sqlite,postgres").split(",").map((name) => name.trim()).filter(Boolean);
const INJECT_EXTRA_READ_BYTES = Number(argValue("inject-extra-read-bytes") ?? 0);
const KEEP = process.argv.includes("--keep");
const ESTIMATE_ONLY = process.argv.includes("--estimate-only");
const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL ?? null;

// ───────────────────────────── instrumentation ─────────────────────────────

const libc = dlopen("libc.so.6", {
  posix_fadvise: { args: [FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i32], returns: FFIType.i32 },
});

/** Drop a file's pages from the page cache (they are clean: the archive was fsynced at publish). */
function evict(path: string): void {
  const fd = openSync(path, "r");
  try {
    const rc = libc.symbols.posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
    if (rc !== 0) throw new Error(`posix_fadvise failed with ${rc} on ${path}`);
  } finally {
    closeSync(fd);
  }
}

function storageReadBytes(): number {
  return Number(/^read_bytes: (\d+)$/m.exec(readFileSync("/proc/self/io", "utf8"))![1]);
}

const fileReads = { bytes: 0, calls: 0 };

/** Count every `FileHandle.read`; the archive reader does its pread through it. */
async function instrumentFileHandleReads(): Promise<void> {
  const probe = await open(import.meta.path, "r");
  const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> };
  await probe.close();
  const original = proto.read;
  proto.read = async function counted(this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args);
    fileReads.bytes += result.bytesRead;
    fileReads.calls += 1;
    return result;
  };
  const check = await open(import.meta.path, "r");
  await check.read(Buffer.alloc(16), 0, 16, 0);
  await check.close();
  if (fileReads.bytes !== 16) throw new Error("FileHandle.read instrumentation is not effective");
  fileReads.bytes = 0;
  fileReads.calls = 0;
}

// ───────────────────────────── stats ─────────────────────────────

function nearestRank(values: readonly number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1]!;
}

function summarize(values: readonly number[], digits = 3) {
  const round = (value: number) => Number(value.toFixed(digits));
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return {
    n: values.length,
    min: round(values.length ? Math.min(...values) : 0),
    p50: round(nearestRank(values, 0.5)),
    p90: round(nearestRank(values, 0.9)),
    p95: round(nearestRank(values, 0.95)),
    p99: round(nearestRank(values, 0.99)),
    max: round(values.length ? Math.max(...values) : 0),
    mean: round(mean),
  };
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

// ───────────────────────────── disk ─────────────────────────────

/**
 * Upper-bound assumptions of the estimate. Bytes per old-table row beyond its
 * columns (id, keys, type, timestamps, row header, the (task_id, seq) index);
 * JSONL envelope per event in a member (every key, nulls, created_at); the
 * database counted twice for the WAL of the single generation transaction
 * (SQLite `-wal`, Postgres `pg_wal` and TOAST); staging and archives both at
 * the members' uncompressed size. SQLite is 300 B: the first full run took
 * 2,297 MiB for 3.10 M rows and 434 MiB of columns, about 240 B under this
 * formula, where 200 B had estimated 2,156 MiB.
 */
const DISK_ASSUMPTIONS = {
  row_overhead_bytes: { sqlite: 300, postgres: 250 } as Record<string, number>,
  member_envelope_bytes_per_event: 170,
  database_factor: 2,
  archive_compression: 1,
  reserve_bytes: 5 * 1024 ** 3,
};

interface DiskEstimate {
  rows: number;
  column_bytes: number;
  member_bytes: number;
  per_backend: Record<string, { database: number; staging: number; archives: number; total: number; database_path: string; files_path: string }>;
  by_filesystem: Array<{ paths: string[]; needed_bytes: number; free_bytes: number; reserve_bytes: number; fits: boolean }>;
  fits: boolean;
}

function estimateDisk(params: TieredCorpusParams, workDir: string, pgDataDir: string | null): DiskEstimate {
  const high = 1 + params.jitter;
  let rows = params.warmupTasks * TRACE_SIZE_TIER_TARGETS.p50.rows * high;
  let bytes = params.warmupTasks * TRACE_SIZE_TIER_TARGETS.p50.bytes * high;
  for (const tier of params.tiers) {
    rows += params.perTier * TRACE_SIZE_TIER_TARGETS[tier].rows * high;
    bytes += params.perTier * TRACE_SIZE_TIER_TARGETS[tier].bytes * high;
  }
  rows = Math.ceil(rows);
  bytes = Math.ceil(bytes);
  const member = bytes + rows * DISK_ASSUMPTIONS.member_envelope_bytes_per_event;
  const perBackend: DiskEstimate["per_backend"] = {};
  const need = new Map<number, { paths: string[]; bytes: number; free: number }>();
  const charge = (path: string, amount: number) => {
    let probe = path;
    while (!existsSync(probe)) probe = dirname(probe);
    const dev = statSync(probe).dev;
    const entry = need.get(dev) ?? { paths: [], bytes: 0, free: 0 };
    const fs = statfsSync(probe);
    entry.free = Number(fs.bavail) * Number(fs.bsize);
    if (!entry.paths.includes(path)) entry.paths.push(path);
    entry.bytes += amount;
    need.set(dev, entry);
  };
  for (const name of BACKENDS) {
    const database = Math.ceil(DISK_ASSUMPTIONS.database_factor * (bytes + rows * (DISK_ASSUMPTIONS.row_overhead_bytes[name] ?? 250)));
    const staging = member;
    const archives = Math.ceil(member / DISK_ASSUMPTIONS.archive_compression);
    const filesPath = join(workDir, name);
    const databasePath = name === "postgres" ? pgDataDir ?? "(Postgres data directory not visible from here)" : join(workDir, name, "sqlite");
    perBackend[name] = { database, staging, archives, total: database + staging + archives, database_path: databasePath, files_path: filesPath };
    charge(filesPath, staging + archives);
    if (name === "sqlite" || (pgDataDir && existsSync(pgDataDir))) charge(databasePath, database);
  }
  const byFilesystem = [...need.values()].map((entry) => ({
    paths: entry.paths,
    needed_bytes: entry.bytes,
    free_bytes: entry.free,
    reserve_bytes: DISK_ASSUMPTIONS.reserve_bytes,
    fits: entry.free >= entry.bytes + DISK_ASSUMPTIONS.reserve_bytes,
  }));
  return {
    rows,
    column_bytes: bytes,
    member_bytes: member,
    per_backend: perBackend,
    by_filesystem: byFilesystem,
    fits: byFilesystem.every((entry) => entry.fits),
  };
}

/** Allocated bytes (st_blocks × 512) under `path`, 0 if it is gone. */
function allocatedBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.blocks * 512;
  let total = stat.blocks * 512;
  for (const entry of readdirSync(path, { recursive: true }) as string[]) {
    total += statSync(join(path, entry)).blocks * 512;
  }
  return total;
}

// ───────────────────────────── backends ─────────────────────────────

interface BenchStore {
  name: "sqlite" | "postgres";
  database: string;
  db: SqlDatabase;
  store: MultiremiStore;
  /** Bytes the database takes now: SQLite file plus `-wal`/`-shm`, or `pg_database_size`. */
  size(): number;
  close(): Promise<void>;
}

async function adminQuery<T>(sql: string): Promise<T[]> {
  const admin = new Bun.SQL(PG_ADMIN_URL!, { max: 1 });
  try {
    return (await admin.unsafe(sql)) as T[];
  } finally {
    await admin.end();
  }
}

async function postgresDataDirectory(): Promise<string | null> {
  if (!PG_ADMIN_URL || !BACKENDS.includes("postgres")) return null;
  const rows = await adminQuery<{ setting: string }>("SELECT setting FROM pg_settings WHERE name = 'data_directory'");
  return rows[0]?.setting ?? null;
}

async function openBenchStore(name: string, backendDir: string): Promise<BenchStore> {
  if (name === "sqlite") {
    const dir = join(backendDir, "sqlite");
    const path = join(dir, "remi.db");
    mkdirSync(dir, { recursive: true });
    const raw = new Database(path, { create: true, readwrite: true });
    raw.exec("PRAGMA journal_mode = WAL");
    const db = Object.assign(raw as unknown as SqlDatabase, { dialect: "sqlite" as const });
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    return {
      name: "sqlite",
      database: "SQLite file (WAL), bun:sqlite",
      db,
      store,
      size: () => allocatedBytes(dir),
      close: async () => raw.close(),
    };
  }
  if (name === "postgres") {
    if (!PG_ADMIN_URL) throw new Error("postgres backend needs MULTIREMI_TEST_POSTGRES_URL");
    const database = `m432_bench_${process.pid}`;
    await adminQuery(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await adminQuery(`CREATE DATABASE ${database}`);
    const url = new URL(PG_ADMIN_URL);
    url.pathname = `/${database}`;
    const db = new PostgresSyncDatabase(url.toString());
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const version = String((db.query("SELECT version() AS v").get() as { v: unknown }).v).split(" ").slice(0, 2).join(" ");
    return {
      name: "postgres",
      database: `${version} on 127.0.0.1 through PostgresSyncDatabase (the server's bridge)`,
      db,
      store,
      size: () => Number((db.query("SELECT pg_database_size(current_database()) AS n").get() as { n: unknown }).n),
      close: async () => {
        db.close();
        if (!KEEP) await adminQuery(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      },
    };
  }
  throw new Error(`unknown backend ${name}`);
}

// ───────────────────────────── measurement ─────────────────────────────

interface ArchivedTask {
  task_id: string;
  archive_id: string;
  compressed_size: number;
  uncompressed_size: number;
  event_count: number;
  head_seq: number;
}

interface ReadSample {
  task_id: string;
  tier: TraceSizeTier;
  op: Op;
  ms: number;
  calls: number;
  events: number;
  /** Bytes the reader read from the archive file, all calls of this read. */
  file_bytes: number;
  /** Largest single `readTrace` call. */
  max_call_bytes: number;
  storage_bytes: number;
}

function loadArchivedTasks(db: SqlDatabase): Map<string, ArchivedTask> {
  const rows = db.query(
    `SELECT task_id, archive_id, compressed_size, uncompressed_size, event_count, head_seq
     FROM multiremi_task_traces WHERE location = 'archive' ORDER BY task_id`,
  ).all() as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => [String(row.task_id), {
    task_id: String(row.task_id),
    archive_id: String(row.archive_id),
    compressed_size: Number(row.compressed_size),
    uncompressed_size: Number(row.uncompressed_size),
    event_count: Number(row.event_count),
    head_seq: Number(row.head_seq),
  }]));
}

async function measureBackend(
  name: string,
  workDir: string,
  params: TieredCorpusParams,
  pools: ReturnType<typeof buildTraceTextPools>,
  injectFile: string | null,
) {
  const backendDir = join(workDir, name);
  const bench = await openBenchStore(name, backendDir);
  const root = join(backendDir, "archives");
  mkdirSync(root, { recursive: true });
  const injectHandle = injectFile ? await open(injectFile, "r") : null;
  const injectBuffer = Buffer.alloc(INJECT_EXTRA_READ_BYTES);
  try {
    const db = bench.db;
    let started = performance.now();
    const corpus: TieredCorpusSummary = generateTieredCorpus(db, params, pools);
    const generateMs = performance.now() - started;
    const databaseAfterGenerate = bench.size();
    console.error(`[${name}] generated ${corpus.rows.total} rows / ${corpus.rows.bytes} bytes in ${Math.round(generateMs)} ms`);

    const service = new SessionArchiveService(bench.store, { root, minFreeBytes: 0 });
    started = performance.now();
    const backfill = await runTraceBackfill({
      db,
      execute: true,
      oldTableStoppedAt: params.oldTableStoppedAt,
      store: bench.store,
      service,
      log: () => {},
    });
    const backfillMs = performance.now() - started;
    for (const group of TRACE_BACKFILL_GROUPS) {
      if (!backfill.reconcile[group]?.ok) throw new Error(`[${name}] backfill reconciliation of ${group} failed`);
    }
    console.error(`[${name}] backfilled in ${Math.round(backfillMs)} ms`);

    const disk = {
      database_after_generate_bytes: databaseAfterGenerate,
      database_after_backfill_bytes: bench.size(),
      archives_bytes: allocatedBytes(root),
      staging_left_bytes: allocatedBytes(join(root, ".trace-backfill-staging")),
      database_measure: name === "sqlite" ? "SQLite 目录（remi.db + -wal + -shm）按块占用" : "pg_database_size（不含共享的 pg_wal）",
    };

    started = performance.now();
    const reconcile = await runTraceReconcile({ db, archiveRoot: root, mode: "sample", oldTableStoppedAt: params.oldTableStoppedAt });
    const reconcileMs = performance.now() - started;
    console.error(`[${name}] reconciled the sample of ${reconcile.sample?.tasks} tasks in ${Math.round(reconcileMs)} ms, ${reconcile.result.mismatch_total} mismatches`);

    const archived = loadArchivedTasks(db);
    const failures: string[] = [];
    const pointerOf = (task: TieredTask): ArchivedTask | null => {
      const pointer = archived.get(task.task_id);
      if (!pointer) {
        failures.push(`${task.task_id}: no archive pointer`);
        return null;
      }
      if (pointer.event_count !== task.rows || pointer.head_seq !== task.head_seq) {
        failures.push(`${task.task_id}: pointer has ${pointer.event_count} events up to ${pointer.head_seq}, generated ${task.rows} up to ${task.head_seq}`);
      }
      return pointer;
    };
    const random = seededRandom(`${SEED}:order`);
    const tierTasks = corpus.tasks.filter((task) => task.tier !== "warmup");
    const order = sampleWithoutReplacement(random, tierTasks, tierTasks.length);
    const warmup = corpus.tasks.filter((task) => task.tier === "warmup");

    const archivePath = new Map<string, string>();
    const pathOf = (archiveId: string) => {
      let path = archivePath.get(archiveId);
      if (!path) {
        path = resolve(root, bench.store.getSessionArchive(archiveId)!.relativePath);
        archivePath.set(archiveId, path);
      }
      return path;
    };
    const tailCursor = (task: ArchivedTask) => {
      const row = db.query(
        `SELECT seq FROM multiremi_task_messages WHERE task_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ${TAIL_WINDOW}`,
      ).get(task.task_id) as { seq: unknown } | null;
      return row ? Number(row.seq) : 0;
    };

    const reader = new TraceReader({
      store: bench.store,
      daemon: new InMemoryDaemonTraceReader(() => null),
      archive: new SessionArchiveReader({ store: bench.store, root }),
    });
    const guard = new TraceReadByteGuard();

    const timedRead = async (task: ArchivedTask, kind: "full" | "tail", cursor: number) => {
      let calls = 0;
      let events = 0;
      let lastSeq = 0;
      let fileBytes = 0;
      let maxCall = 0;
      const storageBefore = storageReadBytes();
      let elapsed = 0;
      let after = kind === "full" ? 0 : cursor;
      for (;;) {
        const callBefore = fileReads.bytes;
        const t0 = performance.now();
        const page = await reader.readTrace(task.task_id, after, kind === "full" ? TRACE_READ_MAX_LIMIT : TAIL_WINDOW);
        elapsed += performance.now() - t0;
        if (injectHandle) await injectHandle.read(injectBuffer, 0, injectBuffer.length, 0);
        const callBytes = fileReads.bytes - callBefore;
        calls++;
        fileBytes += callBytes;
        maxCall = Math.max(maxCall, callBytes);
        guard.check(task.task_id, callBytes, task.compressed_size);
        if (page.state !== "ok" || page.source !== "archive") {
          failures.push(`${task.task_id} ${kind}: state ${page.state} source ${page.source} ${page.reason ?? ""}`);
          break;
        }
        events += page.events.length;
        if (page.events.length) lastSeq = page.events.at(-1)!.seq;
        if (kind === "tail" || page.eof || page.events.length === 0) break;
        after = page.next_after_seq;
      }
      const storageBytes = storageReadBytes() - storageBefore;
      const expected = kind === "full" ? task.event_count : Math.min(TAIL_WINDOW, task.event_count);
      if (events !== expected || lastSeq !== task.head_seq) {
        failures.push(`${task.task_id} ${kind}: ${events} events ending at ${lastSeq}, expected ${expected} ending at ${task.head_seq}`);
      }
      return { ms: elapsed, calls, events, file_bytes: fileBytes, max_call_bytes: maxCall, storage_bytes: storageBytes };
    };

    for (const task of warmup) {
      const pointer = pointerOf(task);
      if (!pointer) continue;
      await timedRead(pointer, "full", 0);
      await timedRead(pointer, "tail", tailCursor(pointer));
    }
    guard.reset();
    const warmupFailures = failures.splice(0);

    const samples: ReadSample[] = [];
    started = performance.now();
    for (const task of order) {
      const pointer = pointerOf(task);
      if (!pointer) continue;
      const tier = task.tier as TraceSizeTier;
      const cursor = tailCursor(pointer);
      const path = pathOf(pointer.archive_id);
      evict(path);
      samples.push({ task_id: task.task_id, tier, op: "full_cold", ...(await timedRead(pointer, "full", 0)) });
      samples.push({ task_id: task.task_id, tier, op: "full_warm", ...(await timedRead(pointer, "full", 0)) });
      evict(path);
      samples.push({ task_id: task.task_id, tier, op: "tail_cold", ...(await timedRead(pointer, "tail", cursor)) });
      samples.push({ task_id: task.task_id, tier, op: "tail_warm", ...(await timedRead(pointer, "tail", cursor)) });
    }
    const measureMs = performance.now() - started;
    const bound = guard.report();
    console.error(`[${name}] measured ${order.length} tasks in ${Math.round(measureMs)} ms, ${failures.length} failures, ${bound.violations}/${bound.calls} byte-bound violations`);

    const statsFor = (subset: ReadSample[]) => ({
      reads: subset.length,
      latency_ms: summarize(subset.map((sample) => sample.ms)),
      calls_per_read: summarize(subset.map((sample) => sample.calls), 0),
      events_per_read: summarize(subset.map((sample) => sample.events), 0),
      file_bytes_per_read: summarize(subset.map((sample) => sample.file_bytes), 0),
      file_bytes_per_call_max: summarize(subset.map((sample) => sample.max_call_bytes), 0),
      storage_bytes_per_read: summarize(subset.map((sample) => sample.storage_bytes), 0),
    });
    const tiers = Object.fromEntries(params.tiers.map((tier) => {
      const tasks = corpus.tasks.filter((task) => task.tier === tier);
      const pointers = tasks.map((task) => archived.get(task.task_id)).filter((pointer): pointer is ArchivedTask => Boolean(pointer));
      const ofTier = samples.filter((sample) => sample.tier === tier);
      const byGroup: Record<string, number> = {};
      for (const task of tasks) byGroup[task.group] = (byGroup[task.group] ?? 0) + 1;
      return [tier, {
        tasks: tasks.length,
        by_group: byGroup,
        target: TRACE_SIZE_TIER_TARGETS[tier],
        rows: summarize(tasks.map((task) => task.rows), 0),
        column_bytes: summarize(tasks.map((task) => task.bytes), 0),
        max_bytes_error_vs_jittered_target: Number(Math.max(...tasks.map((task) => Math.abs(task.bytes - task.target_bytes) / task.target_bytes)).toFixed(5)),
        member_uncompressed_bytes: summarize(pointers.map((pointer) => pointer.uncompressed_size), 0),
        member_compressed_bytes: summarize(pointers.map((pointer) => pointer.compressed_size), 0),
        member_ratio: Number((sum(pointers.map((pointer) => pointer.uncompressed_size)) / sum(pointers.map((pointer) => pointer.compressed_size))).toFixed(2)),
        payload_ratio: Number((sum(tasks.map((task) => task.bytes)) / sum(tasks.map((task) => task.payload_deflate6_bytes))).toFixed(2)),
        envelope_share: Number((1 - sum(tasks.map((task) => task.bytes)) / sum(pointers.map((pointer) => pointer.uncompressed_size))).toFixed(3)),
        results: Object.fromEntries(OPS.map((op) => [op, statsFor(ofTier.filter((sample) => sample.op === op))])) as Record<Op, ReturnType<typeof statsFor>>,
      }];
    })) as Record<TraceSizeTier, {
      tasks: number; by_group: Record<string, number>; target: { rows: number; bytes: number };
      rows: ReturnType<typeof summarize>; column_bytes: ReturnType<typeof summarize>; max_bytes_error_vs_jittered_target: number;
      member_uncompressed_bytes: ReturnType<typeof summarize>; member_compressed_bytes: ReturnType<typeof summarize>;
      member_ratio: number; payload_ratio: number; envelope_share: number; results: Record<Op, ReturnType<typeof statsFor>>;
    }>;

    const archives = db.query(
      `SELECT COUNT(*) AS n, SUM(size_bytes) AS bytes FROM multiremi_session_archives
       WHERE status = 'ready' AND metadata LIKE '%"kind":"trace_backfill"%'`,
    ).get() as { n: unknown; bytes: unknown };
    const reconcileFailures = reconcile.result.ok ? [] : [`reconcile sample: ${reconcile.result.mismatch_total} mismatches`];
    return {
      backend: name,
      database: bench.database,
      corpus: {
        generate_ms: Math.round(generateMs),
        rows: corpus.rows,
        subjects: corpus.subjects,
        sparse: corpus.sparse,
        warmup_tasks: warmup.length,
      },
      backfill: {
        ms: Math.round(backfillMs),
        execution: backfill.execution,
        archives: Number(archives.n),
        archive_bytes: Number(archives.bytes),
      },
      disk,
      reconcile_sample: {
        ms: Math.round(reconcileMs),
        sample: reconcile.sample,
        checked_tasks: reconcile.result.checked_tasks,
        checked_rows: reconcile.result.checked_rows,
        checked_by_group: reconcile.result.checked_by_group,
        mismatch_total: reconcile.result.mismatch_total,
        mismatches: reconcile.result.mismatches,
        ok: reconcile.result.ok,
      },
      measured_tasks: order.length,
      byte_bound: bound,
      validation_failures: [...warmupFailures, ...failures, ...reconcileFailures],
      measure_ms: Math.round(measureMs),
      tiers,
    };
  } finally {
    await injectHandle?.close();
    await bench.close();
    if (!KEEP) await rm(backendDir, { recursive: true, force: true });
  }
}

// ───────────────────────────── report ─────────────────────────────

type BackendReport = Awaited<ReturnType<typeof measureBackend>>;

/** The checked-out commit and whether tracked files differ from it; throws if git cannot tell. */
function gitCommit(): { head: string; dirty: boolean } {
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString().trim()}`);
    return run.stdout.toString().trim();
  };
  const head = git("rev-parse", "HEAD");
  return { head, dirty: git("status", "--porcelain", "--untracked-files=no").length > 0 };
}

const OP_LABEL: Record<Op, string> = {
  full_cold: "整条 / 冷",
  full_warm: "整条 / 暖",
  tail_cold: "尾窗 100 / 冷",
  tail_warm: "尾窗 100 / 暖",
};
const GROUP_LABEL: Record<string, string> = { chat: "chat", task: "单次任务", issue_without_archive: "无归档 issue", issue_with_archive: "有归档 issue" };

function kib(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

function mib(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function markdown(report: {
  generated_at: string; commit: { head: string; dirty: boolean }; machine: Record<string, unknown>;
  params: { corpus: TieredCorpusParams; inject_extra_read_bytes: number }; pools: ReturnType<typeof buildTraceTextPools>["sources"];
  english_pool_ratio: number; disk_estimate: DiskEstimate; backends: BackendReport[]; json_name: string;
}): string {
  const lines: string[] = [];
  const params = report.params.corpus;
  const first = report.backends[0];
  lines.push("# MUL-402 B8：回填归档的 trace 读延迟，按体积分档（MUL-432 第 10 项）", "");
  lines.push(
    "- 父单：MUL-402；本单：MUL-432（第一段，QA 第 2 轮返工）",
    `- 生成时间：${report.generated_at}`,
    `- 被测 commit：\`${report.commit.head}\`${report.commit.dirty ? "（运行时已跟踪文件有未提交改动，即本次提交的 bench 与生成器）" : "（运行时已跟踪文件无改动）"}`,
    `- 运行机器：${report.machine.platform} ${report.machine.arch}，${report.machine.cpus} vCPU，${report.machine.mem_gib} GiB RAM；Bun ${report.machine.bun}；归档目录在 ext4 本地盘`,
    `- **负载**：机器是共享的，计时在并发负载下测得（其他任务同时在跑），不是生产 SLO。load average（1/5/15 分钟）开始 ${(report.machine.loadavg_start as number[] | undefined)?.join(" / ") ?? "未记录"}，结束 ${(report.machine.loadavg_end as number[] | undefined)?.join(" / ") ?? "未记录"}。`,
    `- 原始 JSON：[\`${report.json_name}\`](${report.json_name})`,
  );
  if (report.params.inject_extra_read_bytes > 0) {
    lines.push(`- **注意：本次带 \`--inject-extra-read-bytes=${report.params.inject_extra_read_bytes}\`，每次调用额外读一个临时文件，只用于验证字节守卫，延迟与字节数字无效。**`);
  }
  lines.push(
    "",
    "## 口径",
    "",
    "- 读路径：B5 `TraceReader.readTrace`（`GET /api/tasks/:id/trace` 用的同一个类），指针 → 归档行 → open/pread → inflate → sha256 校验 → 行解析 → 窗口。计时只包 `readTrace` 调用，不含 HTTP。",
    `- 整条：从 seq 0 起每页 ${TRACE_READ_MAX_LIMIT} 条（接口上限），跟 \`next_after_seq\` 翻到 eof；一次整条读的耗时和字节是所有页之和。尾窗 100：一次 \`readTrace(cursor, 100)\`，cursor 是倒数第 101 条事件的 seq（稀疏 seq 下按真实事件数取尾 100 条）。`,
    "- 冷：每次读前对整个归档文件做 `posix_fadvise(DONTNEED)`，把它踢出页缓存；暖：紧接着再读一遍。`storage` 列是 `/proc/self/io` 的 `read_bytes` 增量（真正落到磁盘的字节，按页取整、含内核预读），用来证明冷读确实没命中缓存、暖读确实命中了。",
    `- 读字节：给 \`FileHandle.prototype.read\` 计数，即读者向文件系统要的字节。每次 \`readTrace\` 调用单独核对 \`≤ compressed_size + ${TRACE_READ_BYTE_SLACK / 1024} KiB\`（\`tests/manual/archive-trace-read-guard.ts\`），任何一次超出，进程退出码为 3。`,
    `- 分位数：最近秩法 \`sorted[ceil(q·n)-1]\`；每个格子 n 是该档该读法的读次数（每档 ${params.perTier}）。`,
    `- 顺序：各档任务混在一起按 seed \`${SEED}:order\` 打乱，每个任务依次做整条冷、整条暖、尾窗冷、尾窗暖。另有 ${params.warmupTasks} 个 p50 体积的预热任务先各读一遍，不计入统计与字节核对。`,
    "",
    "## 分档取值与来源",
    "",
    "三档是按体积造的合成任务，不是从一个总体里分桶抽样。每档每个任务的行数和压缩前字节（content+input+output+meta 列字节，与生产统计同一口径）分别取目标值 × (1 + U(−5%, +5%))，两者独立抽取，seed 固定。",
    "",
    "| 档 | 行数目标 | 压缩前字节目标 | 来源 |",
    "| --- | ---: | ---: | --- |",
  );
  for (const tier of params.tiers) {
    const target = TRACE_SIZE_TIER_TARGETS[tier];
    lines.push(`| ${tier} | ${target.rows.toLocaleString("en-US")} | ${target.bytes.toLocaleString("en-US")} | 生产单任务 ${tier}：\`PRODUCTION_TRACE_SHAPE.taskRows/taskBytes\`，数值出自 ADR 0006（\`docs/adr/0006-conversation-log-and-daemon-owned-traces.md\` 第 53 行，即 ADR 草稿 \`cmt_94esdskv3s3y\`） |`);
  }
  lines.push("", `分组任务数、行类型占比、seq 缺号比例出自 ${PRODUCTION_TRACE_SHAPE.source}；该评论不含上表的单任务分位数。`);
  lines.push(
    "",
    `参数：每档 ${params.perTier} 个，档内抖动 ±${params.jitter * 100}%，seed \`${params.seed}\`，oldTableStoppedAt=${params.oldTableStoppedAt}。任务按生产各组任务数比例分到四组主体（组内主体大小同形状语料），行类型按生产类型占比，seq 缺号按生产比例。`,
  );
  if (first) {
    lines.push(
      "",
      `实际生成（两个后端逐行相同）：${first.corpus.rows.total.toLocaleString("en-US")} 行，${mib(first.corpus.rows.bytes)} MiB 列字节；稀疏 seq 任务 ${first.corpus.sparse.tasks_with_gaps}，缺号 ${first.corpus.sparse.missing_seqs}。`,
      "",
      "| 档 | 任务 | 行数 min / p50 / max | 列字节 KiB min / p50 / max | 与抖动后目标的最大偏差 | 成员解压 KiB p50 | 成员压缩 KiB p50 | 成员压缩比 Σ解压/Σ压缩 | 纯载荷压缩比 | 成员里 JSONL 外壳占比 | 各组任务数 |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const tier of params.tiers) {
      const t = first.tiers[tier];
      const groups = Object.entries(t.by_group).map(([group, count]) => `${GROUP_LABEL[group] ?? group} ${count}`).join(" / ");
      lines.push(`| ${tier} | ${t.tasks} | ${t.rows.min} / ${t.rows.p50} / ${t.rows.max} | ${kib(t.column_bytes.min)} / ${kib(t.column_bytes.p50)} / ${kib(t.column_bytes.max)} | ${(t.max_bytes_error_vs_jittered_target * 100).toFixed(2)}% | ${kib(t.member_uncompressed_bytes.p50)} | ${kib(t.member_compressed_bytes.p50)} | **${t.member_ratio}×** | ${t.payload_ratio}× | ${(t.envelope_share * 100).toFixed(1)}% | ${groups} |`);
    }
  }
  lines.push(
    "",
    "## 压缩率",
    "",
    "- 生产压缩率：规格与父单的生产只读数据评论（cmt_z0j166q2zbx9）只有行数与字节，没有压缩率，生产真实压缩比未知。下表是合成数据的实测值与两个非生产参照。",
    "- 文本不用英文词池：thinking/text 取仓库 `docs/`、`reports/` 的 Markdown（中英混排）；Edit/Write 输入与 heredoc 取 `packages/server/src`、`scripts` 的 TypeScript；Bash/Read/Grep 结果取由这两者拼出的 `cat -n` 列表、`grep -n` 命中、unified diff、测试输出、CLI 评论 JSON。",
    "- 成员压缩比是回填写出的 `traces/<task>.jsonl` 成员（deflate-6）的 Σ解压 / Σ压缩，取自指针表；纯载荷压缩比只算列值本身（换行拼接后 deflate-6），两者之差来自每行固定的 JSONL 外壳（全部键名、null、created_at）。行多而每行短的档外壳占比高，成员压缩比就更高。",
    "",
    "| 文本 | 来源 | 字节 | deflate-6 压缩比 |",
    "| --- | --- | ---: | ---: |",
    `| prose 池 | ${report.pools.prose.from}（${report.pools.prose.files} 个文件） | ${report.pools.prose.bytes.toLocaleString("en-US")} | ${report.pools.prose.deflate6_ratio}× |`,
    `| code 池 | ${report.pools.code.from}（${report.pools.code.files} 个文件） | ${report.pools.code.bytes.toLocaleString("en-US")} | ${report.pools.code.deflate6_ratio}× |`,
    `| shell 池 | ${report.pools.shell.from} | ${report.pools.shell.bytes.toLocaleString("en-US")} | ${report.pools.shell.deflate6_ratio}× |`,
    `| 旧英文词池（仅对照） | \`textPool\`，形状语料仍在用 | — | ${report.english_pool_ratio}× |`,
    `| 参照：本机会话记录 | ${COMPRESSION_REFERENCES.local_transcript.note} | — | ${COMPRESSION_REFERENCES.local_transcript.ratio}× |`,
    `| 参照：上一版报告成员 | ${COMPRESSION_REFERENCES.previous_report.note} | — | ${COMPRESSION_REFERENCES.previous_report.ratio}× |`,
    "",
    "## 磁盘占用",
    "",
    `生成前估算（行数与字节按目标上限 +${params.jitter * 100}% 计）：${report.disk_estimate.rows.toLocaleString("en-US")} 行，列字节 ${mib(report.disk_estimate.column_bytes)} MiB，成员解压约 ${mib(report.disk_estimate.member_bytes)} MiB（每事件外壳按 ${DISK_ASSUMPTIONS.member_envelope_bytes_per_event} B）。每个后端：数据库 = ${DISK_ASSUMPTIONS.database_factor} ×（列字节 + 行数 × 每行开销 SQLite ${DISK_ASSUMPTIONS.row_overhead_bytes.sqlite} B / PG ${DISK_ASSUMPTIONS.row_overhead_bytes.postgres} B），×2 是单事务生成的 WAL；暂存与归档都按成员解压大小计（即假设不压缩）。`,
    "",
    "| 后端 | 数据库 | 暂存 | 归档 | 合计 | 数据库位置 |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  );
  for (const [name, estimate] of Object.entries(report.disk_estimate.per_backend)) {
    lines.push(`| ${name} | ${mib(estimate.database)} MiB | ${mib(estimate.staging)} MiB | ${mib(estimate.archives)} MiB | ${mib(estimate.total)} MiB | \`${estimate.database_path}\` |`);
  }
  const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);
  const estimates = Object.entries(report.disk_estimate.per_backend);
  const estimateSum = estimates.reduce((sum, [, estimate]) => sum + estimate.total, 0);
  lines.push(
    "",
    `上表每行是**单个后端**的估算：${estimates.map(([name, estimate]) => `${name} ${estimate.total.toLocaleString("en-US")} B ≈ ${gib(estimate.total)} GiB`).join("、")}${estimates.length > 1 ? `；两个后端合计 ${estimateSum.toLocaleString("en-US")} B ≈ ${gib(estimateSum)} GiB` : ""}。文件系统另须留出预留量（下表“预留”列）。PG 的数据库实测用 \`pg_database_size\`，不含共享的 \`pg_wal\`，不能据此直接推导生产峰值。`,
  );
  lines.push("", "| 文件系统上的路径 | 估算需要 | 可用 | 预留 | 结论 |", "| --- | ---: | ---: | ---: | --- |");
  for (const fs of report.disk_estimate.by_filesystem) {
    lines.push(`| ${fs.paths.map((path) => `\`${path}\``).join("、")} | ${mib(fs.needed_bytes)} MiB | ${(fs.free_bytes / 1024 ** 3).toFixed(1)} GiB | ${(fs.reserve_bytes / 1024 ** 3).toFixed(0)} GiB | ${fs.fits ? "够" : "不够（本应退出码 4）"} |`);
  }
  lines.push("", "实测：", "", "| 后端 | 数据库（生成后） | 数据库（回填后） | 归档目录 | 回填后暂存残留 | 数据库口径 |", "| --- | ---: | ---: | ---: | ---: | --- |");
  for (const backend of report.backends) {
    const d = backend.disk;
    lines.push(`| ${backend.backend} | ${mib(d.database_after_generate_bytes)} MiB | ${mib(d.database_after_backfill_bytes)} MiB | ${mib(d.archives_bytes)} MiB | ${mib(d.staging_left_bytes)} MiB | ${d.database_measure} |`);
  }
  const overruns: string[] = [];
  const comparisons = report.backends.map((backend) => {
    const estimate = report.disk_estimate.per_backend[backend.backend]!;
    const database = Math.max(backend.disk.database_after_generate_bytes, backend.disk.database_after_backfill_bytes);
    if (database > estimate.database) overruns.push(`${backend.backend} 数据库`);
    if (backend.disk.archives_bytes > estimate.archives) overruns.push(`${backend.backend} 归档`);
    const pct = (measured: number, estimated: number) => `${((measured / estimated) * 100).toFixed(0)}%`;
    return `${backend.backend} 数据库实测峰值为估算的 ${pct(database, estimate.database)}、归档为 ${pct(backend.disk.archives_bytes, estimate.archives)}`;
  });
  lines.push("", `估算与实测：${comparisons.join("；")}。${overruns.length === 0 ? "实测都没有超过估算。" : `**超过估算：${overruns.join("、")}**。`}`, "");
  for (const backend of report.backends) {
    lines.push(`## ${backend.backend === "sqlite" ? "SQLite" : "PostgreSQL"}`, "");
    lines.push(
      `- 数据库：${backend.database}`,
      `- 生成 ${backend.corpus.generate_ms} ms；回填 ${backend.backfill.ms} ms，产出 ${backend.backfill.archives} 个 trace_backfill 归档共 ${mib(backend.backfill.archive_bytes)} MiB；回填内置的逐组对账全部通过`,
      `- 读正确性核对失败：${backend.validation_failures.length}；测量 ${backend.measured_tasks} 个任务用时 ${Math.round(backend.measure_ms / 1000)} s`,
      "",
      "### 对账抽样",
      "",
    );
    const sample = backend.reconcile_sample.sample;
    if (sample) {
      lines.push(
        `\`scripts/reconcile-task-traces.ts\` 默认抽样（不传 \`--sample-size\` / \`--seed\`）：四组配额 ${Object.entries(TRACE_RECONCILE_SAMPLE_QUOTAS).map(([group, quota]) => `${GROUP_LABEL[group] ?? group} ${quota}`).join(" / ")}，共 ${sample.requested}；seed \`${sample.seed}\`（\`TRACE_RECONCILE_SAMPLE_QUOTAS\` / \`TRACE_RECONCILE_SAMPLE_SEED\`，固化在 \`scripts/lib/task-trace-reconcile.ts\`）。某组候选不足配额时取全，缺额按固定组序（${TRACE_BACKFILL_GROUPS.map((group) => GROUP_LABEL[group] ?? group).join(" → ")}）轮流、每轮一个，从仍有候选的组补足，用同一个 seed 抽；同一 seed、同一数据抽出的任务相同。总候选不足 ${sample.requested} 时全取，并在 \`sample.note\` 写明实际数量和原因。`,
        "",
        `本次实际抽中 **${sample.tasks}** 个，其中补抽 ${sample.refilled} 个；${sample.note ? `说明：${sample.note}。` : "候选足够，抽满。"}`,
        "",
        "| 组 | 配额 | 候选 | 抽中 | 其中补抽 |",
        "| --- | ---: | ---: | ---: | ---: |",
      );
      for (const [group, entry] of Object.entries(sample.by_group)) {
        lines.push(`| ${GROUP_LABEL[group] ?? group} | ${entry.quota} | ${entry.candidates} | ${entry.sampled} | ${entry.refill} |`);
      }
      lines.push("", `核对 ${backend.reconcile_sample.checked_tasks} 个任务、${backend.reconcile_sample.checked_rows.toLocaleString("en-US")} 行，用时 ${backend.reconcile_sample.ms} ms，不一致 **${backend.reconcile_sample.mismatch_total}**。`, "");
    }
    lines.push(
      "### 延迟（ms）",
      "",
      "| 档 | 读法 | n | p50 | p90 | p99 | max | 调用数 p50 / max | 读字节 KiB p50 / p99 / max | storage KiB p50 / p99 |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const tier of params.tiers) {
      for (const op of OPS) {
        const s = backend.tiers[tier].results[op];
        lines.push(`| ${tier} | ${OP_LABEL[op]} | ${s.reads} | ${s.latency_ms.p50} | ${s.latency_ms.p90} | **${s.latency_ms.p99}** | ${s.latency_ms.max} | ${s.calls_per_read.p50} / ${s.calls_per_read.max} | ${kib(s.file_bytes_per_read.p50)} / ${kib(s.file_bytes_per_read.p99)} / ${kib(s.file_bytes_per_read.max)} | ${kib(s.storage_bytes_per_read.p50)} / ${kib(s.storage_bytes_per_read.p99)} |`);
      }
    }
    const bound = backend.byte_bound;
    lines.push(
      "",
      "### 每次调用的读字节守卫",
      "",
      `${bound.calls} 次 \`readTrace\` 调用逐次核对 \`读字节 ≤ compressed_size + ${bound.slack_bytes / 1024} KiB\`：违例 **${bound.violations}**。每次调用读字节减去该成员 compressed_size 的差值范围是 ${bound.min_excess_over_compressed_bytes} 到 ${bound.max_excess_over_compressed_bytes} 字节${bound.min_excess_over_compressed_bytes === 0 && bound.max_excess_over_compressed_bytes === 0 ? "，即每次调用只读成员压缩体本身（一次 pread），不读中央目录、不读本地头" : ""}。整条读要翻多页时每页各读一遍成员，所以一次整条读的总字节约是页数 × compressed_size，上界按调用成立。`,
      "",
    );
  }
  lines.push(
    "## 解读与局限",
    "",
    "- 这是进程内服务端读路径的数字，不含 HTTP 与网络；PG 列包含指针与归档行两次查询经桥往返的开销。",
    "- 冷读只把归档文件踢出页缓存；数据库页（SQLite 文件、PG shared buffers）保持热，这与生产上指针表常驻缓存的情况一致。",
    `- 整条读每页 ${TRACE_READ_MAX_LIMIT} 条，每页都要读整个成员、解压、校验 sha256 再切窗口，所以整条读的耗时和字节随“页数 × 成员大小”增长，p99 档（约 ${Math.ceil(TRACE_SIZE_TIER_TARGETS.p99.rows / TRACE_READ_MAX_LIMIT)} 页）最明显；尾窗 100 只读一页。`,
    `- p99 档“整条”那几秒是从 seq 0 一页页翻到 eof（约 ${Math.ceil(TRACE_SIZE_TIER_TARGETS.p99.rows / TRACE_READ_MAX_LIMIT)} 页）的 \`readTrace\` 累计耗时，不含 HTTP，**不是首屏耗时**；本 bench 没有单测首屏。`,
    "- 计时在共享机器的并发负载下测得（见文首“负载”），不是生产 SLO。",
    "- 合成文本取自本仓库，压缩比与真实 trace 仍会有出入；生产压缩比未知（见“压缩率”）。",
    "- 生产 209 上的真实延迟要等回填经贺华杰授权执行后再测，本报告不替代那一步。",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (!OUT && !ESTIMATE_ONLY) throw new Error("--out <report.json> is required");
  for (const tier of TIERS) if (!TRACE_SIZE_TIERS.includes(tier)) throw new Error(`unknown tier ${tier}`);
  if (!Number.isSafeInteger(PER_TIER) || PER_TIER <= 0) throw new Error("--per-tier must be a positive integer");
  if (!Number.isSafeInteger(WARMUP) || WARMUP < 0) throw new Error("--warmup must be a non-negative integer");
  if (!Number.isFinite(JITTER) || JITTER < 0 || JITTER >= 1) throw new Error("--jitter must be in [0, 1)");
  if (!Number.isSafeInteger(INJECT_EXTRA_READ_BYTES) || INJECT_EXTRA_READ_BYTES < 0) throw new Error("--inject-extra-read-bytes must be a non-negative integer");
  const params: TieredCorpusParams = { ...TIERED_CORPUS_DEFAULTS, seed: SEED, tiers: TIERS, perTier: PER_TIER, warmupTasks: WARMUP, jitter: JITTER };
  const commit = gitCommit();
  const ownWorkDir = argValue("work-dir") === undefined;
  const workDir = argValue("work-dir") ?? await mkdtemp(join(tmpdir(), "m432-bench-"));
  mkdirSync(workDir, { recursive: true });

  const diskEstimate = estimateDisk(params, workDir, await postgresDataDirectory());
  console.error(`[disk] estimate ${JSON.stringify(diskEstimate)}`);
  if (ESTIMATE_ONLY || !diskEstimate.fits) {
    if (ownWorkDir) await rm(workDir, { recursive: true, force: true });
    if (!diskEstimate.fits) {
      console.error("[disk] not enough free space for these tiers; stopping without shrinking them — ask the operator");
      process.exitCode = BENCH_EXIT_NO_SPACE;
    }
    return;
  }

  await instrumentFileHandleReads();
  let started = performance.now();
  const pools = buildTraceTextPools(REPO_ROOT, SEED);
  console.error(`[pools] built in ${Math.round(performance.now() - started)} ms: ${JSON.stringify(pools.sources)}`);
  const english = Buffer.from(textPool(seededRandom(`corpus:${SEED}`)), "utf8");
  const englishPoolRatio = Number((english.length / deflateRawSync(english, { level: 6 }).length).toFixed(2));
  let injectFile: string | null = null;
  if (INJECT_EXTRA_READ_BYTES > 0) {
    injectFile = join(workDir, "inject-extra-read.bin");
    writeFileSync(injectFile, Buffer.alloc(INJECT_EXTRA_READ_BYTES, 0x61));
  }

  const backends: BackendReport[] = [];
  const loadStart = loadavg().map((value) => Number(value.toFixed(2)));
  started = performance.now();
  try {
    for (const name of BACKENDS) backends.push(await measureBackend(name, workDir, params, pools, injectFile));
  } finally {
    if (!KEEP) await rm(workDir, { recursive: true, force: true });
  }
  const loadEnd = loadavg().map((value) => Number(value.toFixed(2)));
  const outPath = resolve(OUT!);
  const report = {
    generated_at: new Date().toISOString(),
    issue: "MUL-432 item 10 (MUL-402 B8)",
    commit,
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      mem_gib: Math.round(totalmem() / 1024 ** 3),
      bun: Bun.version,
      /** 1/5/15-minute load averages when measuring started and ended; the machine is shared. */
      loadavg_start: loadStart,
      loadavg_end: loadEnd,
    },
    params: {
      corpus: params,
      tail_window: TAIL_WINDOW,
      page_limit: TRACE_READ_MAX_LIMIT,
      byte_slack: TRACE_READ_BYTE_SLACK,
      order_seed: `${SEED}:order`,
      reconcile_sample: { quotas: TRACE_RECONCILE_SAMPLE_QUOTAS, seed: TRACE_RECONCILE_SAMPLE_SEED },
      inject_extra_read_bytes: INJECT_EXTRA_READ_BYTES,
    },
    targets: TRACE_SIZE_TIER_TARGETS,
    target_source: "PRODUCTION_TRACE_SHAPE.taskRows / taskBytes: ADR 0006 (docs/adr/0006-conversation-log-and-daemon-owned-traces.md, from ADR comment cmt_94esdskv3s3y); "
      + `group, type and seq-gap shape: ${PRODUCTION_TRACE_SHAPE.source}`,
    pools: pools.sources,
    english_pool_ratio: englishPoolRatio,
    compression_references: COMPRESSION_REFERENCES,
    disk_estimate: { ...diskEstimate, assumptions: DISK_ASSUMPTIONS },
    total_ms: Math.round(performance.now() - started),
    backends,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  const mdPath = outPath.replace(/\.json$/, ".md");
  writeFileSync(mdPath, markdown({ ...report, json_name: outPath.split("/").at(-1)! }));
  console.error(`wrote ${outPath} and ${mdPath}`);
  for (const backend of backends) {
    console.error(`[${backend.backend}] validation failures ${backend.validation_failures.length}, byte-bound violations ${backend.byte_bound.violations} of ${backend.byte_bound.calls} calls`);
  }
  process.exitCode = benchExitCode(backends.map((backend) => ({
    validationFailures: backend.validation_failures.length,
    violations: backend.byte_bound.violations,
  })));
}

if (import.meta.main) {
  await main();
}
