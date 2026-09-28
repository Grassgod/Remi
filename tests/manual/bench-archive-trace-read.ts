#!/usr/bin/env bun
/**
 * MUL-432 item 10 (MUL-402 B8): trace read latency from backfilled archives.
 *
 * Builds a synthetic `multiremi_task_messages` corpus shaped by the production
 * statistics (`scripts/lib/task-trace-synthetic.ts`), runs the real backfill
 * (`scripts/backfill-task-traces.ts`) so every terminal task points into a
 * `trace_backfill` archive, then reads traces back through the B5
 * `TraceReader` — the same path `GET /api/tasks/:id/trace` takes — on SQLite
 * and on Postgres, each reported separately.
 *
 * Sample: 500 archived tasks (seeded), stratified by trace size (the member's
 * uncompressed bytes) into three buckets of about 167: up to p50, p50 to p90,
 * and above p90 (which holds every task at or above p99).
 *
 * Per task, in this order:
 *   full / cold  — archive file evicted from the page cache, then pages of
 *                  500 events from seq 0 until eof;
 *   full / warm  — the same again, file now cached;
 *   tail / cold  — evicted again, one read of the last 100 events from a seq
 *                  cursor (the seq before them);
 *   tail / warm  — the same again.
 * Every read is checked against the source rows (event count, head, tail
 * length). Latency is wall time around the `TraceReader` calls (pointer and
 * archive row lookups, open, pread, inflate, sha256 check, line parse); no
 * HTTP. Percentiles are nearest-rank (`sorted[ceil(q·n) - 1]`).
 *
 * Bytes read: `FileHandle.prototype.read` is counted, so the figure is what
 * the reader asked the file system for, per `readTrace` call; each call is
 * checked against `compressed_size + 64 KiB` of its member. `/proc/self/io`
 * `read_bytes` (what reached storage, page-granular and with kernel
 * readahead) is recorded alongside to show that cold reads really missed the
 * page cache and warm ones did not. Eviction is `posix_fadvise(DONTNEED)` on
 * the whole archive file; no root or cache drop is needed.
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://user@127.0.0.1:5432/postgres \
 *     bun run tests/manual/bench-archive-trace-read.ts \
 *     --out reports/performance/MUL-402-archive-trace-read-2026-09-29.json
 *
 * Options: --tasks=1800 --row-scale=1 --seed=m432-bench --sample=500
 *   --backends=sqlite,postgres --work-dir=<dir> (default a fresh /tmp/m432-bench-*) --keep
 * The Markdown report is written next to `--out` with the same name.
 */
import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { cpus, totalmem, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { InMemoryDaemonTraceReader } from "../../packages/server/src/api/trace/daemon-trace-reader.js";
import { SessionArchiveReader } from "../../packages/server/src/session-archive/reader.js";
import { SessionArchiveService } from "../../packages/server/src/session-archive/service.js";
import { PostgresSyncDatabase, type SqlDatabase } from "../../packages/server/src/store/db/postgres.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { TRACE_READ_MAX_LIMIT, TraceReader } from "../../packages/server/src/trace/trace-reader.js";
import { runTraceBackfill } from "../../scripts/backfill-task-traces.js";
import { TRACE_BACKFILL_GROUPS } from "../../scripts/lib/task-trace-backfill.js";
import { sampleWithoutReplacement, seededRandom } from "../../scripts/lib/seeded-random.js";
import {
  generateSyntheticCorpus,
  PRODUCTION_TRACE_SHAPE,
  SYNTHETIC_CORPUS_DEFAULTS,
  type SyntheticCorpusParams,
  type SyntheticCorpusSummary,
} from "../../scripts/lib/task-trace-synthetic.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TAIL_WINDOW = 100;
const BYTE_SLACK = 64 * 1024;
const WARMUP_TASKS = 20;
const POSIX_FADV_DONTNEED = 4;
const BUCKETS = ["le_p50", "p50_p90", "gt_p90"] as const;
type Bucket = (typeof BUCKETS)[number];
const OPS = ["full_cold", "full_warm", "tail_cold", "tail_warm"] as const;
type Op = (typeof OPS)[number];

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const OUT = argValue("out");
const TASKS = Number(argValue("tasks") ?? 1800);
const ROW_SCALE = Number(argValue("row-scale") ?? 1);
const SEED = argValue("seed") ?? "m432-bench";
const SAMPLE = Number(argValue("sample") ?? 500);
const BACKENDS = (argValue("backends") ?? "sqlite,postgres").split(",").map((name) => name.trim()).filter(Boolean);
const KEEP = process.argv.includes("--keep");
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
    p50: round(nearestRank(values, 0.5)),
    p95: round(nearestRank(values, 0.95)),
    p99: round(nearestRank(values, 0.99)),
    max: round(values.length ? Math.max(...values) : 0),
    mean: round(mean),
  };
}

// ───────────────────────────── backends ─────────────────────────────

interface BenchStore {
  name: "sqlite" | "postgres";
  database: string;
  db: SqlDatabase;
  store: MultiremiStore;
  close(): Promise<void>;
}

async function adminExec(sql: string): Promise<void> {
  const admin = new Bun.SQL(PG_ADMIN_URL!, { max: 1 });
  try {
    await admin.unsafe(sql);
  } finally {
    await admin.end();
  }
}

async function openBenchStore(name: string, workDir: string): Promise<BenchStore> {
  if (name === "sqlite") {
    const path = join(workDir, "sqlite", "remi.db");
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path, { create: true, readwrite: true });
    raw.exec("PRAGMA journal_mode = WAL");
    const db = Object.assign(raw as unknown as SqlDatabase, { dialect: "sqlite" as const });
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    return { name: "sqlite", database: "SQLite file (WAL), bun:sqlite", db, store, close: async () => raw.close() };
  }
  if (name === "postgres") {
    if (!PG_ADMIN_URL) throw new Error("postgres backend needs MULTIREMI_TEST_POSTGRES_URL");
    const database = `m432_bench_${process.pid}`;
    await adminExec(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await adminExec(`CREATE DATABASE ${database}`);
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
      close: async () => {
        db.close();
        if (!KEEP) await adminExec(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
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
  bucket: Bucket;
  op: Op;
  ms: number;
  calls: number;
  events: number;
  /** Bytes the reader read from the archive file, all calls of this read. */
  file_bytes: number;
  /** Largest single `readTrace` call, and its excess over the member's compressed size. */
  max_call_bytes: number;
  max_call_excess: number;
  storage_bytes: number;
}

interface CallBound {
  calls: number;
  violations: number;
  max_excess_bytes: number;
  min_excess_bytes: number;
}

function loadArchivedTasks(db: SqlDatabase): ArchivedTask[] {
  const rows = db.query(
    `SELECT task_id, archive_id, compressed_size, uncompressed_size, event_count, head_seq
     FROM multiremi_task_traces WHERE location = 'archive' ORDER BY task_id`,
  ).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    task_id: String(row.task_id),
    archive_id: String(row.archive_id),
    compressed_size: Number(row.compressed_size),
    uncompressed_size: Number(row.uncompressed_size),
    event_count: Number(row.event_count),
    head_seq: Number(row.head_seq),
  }));
}

async function measureBackend(name: string, workDir: string, corpusParams: SyntheticCorpusParams) {
  const bench = await openBenchStore(name, workDir);
  const root = join(workDir, name, "archives");
  mkdirSync(root, { recursive: true });
  try {
    const db = bench.db;
    let started = performance.now();
    const corpus: SyntheticCorpusSummary = generateSyntheticCorpus(db, corpusParams);
    const generateMs = performance.now() - started;
    console.error(`[${name}] generated ${corpus.rows.total} rows / ${corpus.rows.bytes} bytes in ${Math.round(generateMs)} ms`);

    const service = new SessionArchiveService(bench.store, { root, minFreeBytes: 0 });
    started = performance.now();
    const backfill = await runTraceBackfill({
      db,
      execute: true,
      oldTableStoppedAt: corpusParams.oldTableStoppedAt,
      store: bench.store,
      service,
      log: () => {},
    });
    const backfillMs = performance.now() - started;
    for (const group of TRACE_BACKFILL_GROUPS) {
      if (!backfill.reconcile[group]?.ok) throw new Error(`[${name}] backfill reconciliation of ${group} failed`);
    }
    console.error(`[${name}] backfilled in ${Math.round(backfillMs)} ms`);

    const archived = loadArchivedTasks(db);
    const sizes = archived.map((task) => task.uncompressed_size);
    const thresholds = { p50: nearestRank(sizes, 0.5), p90: nearestRank(sizes, 0.9), p99: nearestRank(sizes, 0.99) };
    const bucketOf = (task: ArchivedTask): Bucket =>
      task.uncompressed_size <= thresholds.p50 ? "le_p50" : task.uncompressed_size <= thresholds.p90 ? "p50_p90" : "gt_p90";
    const byBucket = Object.fromEntries(BUCKETS.map((bucket) => [bucket, [] as ArchivedTask[]])) as Record<Bucket, ArchivedTask[]>;
    for (const task of archived) byBucket[bucketOf(task)].push(task);
    const random = seededRandom(`${SEED}:sample`);
    const quota = (index: number) => Math.floor(SAMPLE / BUCKETS.length) + (index < SAMPLE % BUCKETS.length ? 1 : 0);
    const sampled: Array<ArchivedTask & { bucket: Bucket }> = [];
    BUCKETS.forEach((bucket, index) => {
      const picked = sampleWithoutReplacement(random, byBucket[bucket], quota(index));
      if (picked.length < quota(index)) throw new Error(`[${name}] bucket ${bucket} has only ${picked.length} tasks`);
      for (const task of picked) sampled.push({ ...task, bucket });
    });
    const order = sampleWithoutReplacement(random, sampled, sampled.length);
    const sampledIds = new Set(sampled.map((task) => task.task_id));
    const warmup = sampleWithoutReplacement(random, archived.filter((task) => !sampledIds.has(task.task_id)), WARMUP_TASKS);

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
    const bound: CallBound = { calls: 0, violations: 0, max_excess_bytes: -Infinity, min_excess_bytes: Infinity };
    const failures: string[] = [];

    const timedRead = async (task: ArchivedTask, kind: "full" | "tail", cursor: number) => {
      let calls = 0;
      let events = 0;
      let lastSeq = 0;
      let fileBytes = 0;
      let maxCall = 0;
      let maxExcess = -Infinity;
      const storageBefore = storageReadBytes();
      let elapsed = 0;
      let after = kind === "full" ? 0 : cursor;
      for (;;) {
        const callBefore = fileReads.bytes;
        const t0 = performance.now();
        const page = await reader.readTrace(task.task_id, after, kind === "full" ? TRACE_READ_MAX_LIMIT : TAIL_WINDOW);
        elapsed += performance.now() - t0;
        const callBytes = fileReads.bytes - callBefore;
        calls++;
        fileBytes += callBytes;
        maxCall = Math.max(maxCall, callBytes);
        const excess = callBytes - task.compressed_size;
        maxExcess = Math.max(maxExcess, excess);
        bound.calls++;
        if (callBytes > task.compressed_size + BYTE_SLACK) bound.violations++;
        bound.max_excess_bytes = Math.max(bound.max_excess_bytes, excess);
        bound.min_excess_bytes = Math.min(bound.min_excess_bytes, excess);
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
      return { ms: elapsed, calls, events, file_bytes: fileBytes, max_call_bytes: maxCall, max_call_excess: maxExcess, storage_bytes: storageBytes };
    };

    for (const task of warmup) {
      await timedRead(task, "full", 0);
      await timedRead(task, "tail", tailCursor(task));
    }
    bound.calls = 0;
    bound.violations = 0;
    bound.max_excess_bytes = -Infinity;
    bound.min_excess_bytes = Infinity;
    failures.length = 0;

    const samples: ReadSample[] = [];
    started = performance.now();
    for (const task of order) {
      const cursor = tailCursor(task);
      const path = pathOf(task.archive_id);
      evict(path);
      samples.push({ task_id: task.task_id, bucket: task.bucket, op: "full_cold", ...(await timedRead(task, "full", 0)) });
      samples.push({ task_id: task.task_id, bucket: task.bucket, op: "full_warm", ...(await timedRead(task, "full", 0)) });
      evict(path);
      samples.push({ task_id: task.task_id, bucket: task.bucket, op: "tail_cold", ...(await timedRead(task, "tail", cursor)) });
      samples.push({ task_id: task.task_id, bucket: task.bucket, op: "tail_warm", ...(await timedRead(task, "tail", cursor)) });
    }
    const measureMs = performance.now() - started;
    console.error(`[${name}] measured ${order.length} tasks in ${Math.round(measureMs)} ms, ${failures.length} failures`);

    const statsFor = (subset: ReadSample[]) => ({
      reads: subset.length,
      latency_ms: summarize(subset.map((sample) => sample.ms)),
      calls_per_read: summarize(subset.map((sample) => sample.calls), 0),
      events_per_read: summarize(subset.map((sample) => sample.events), 0),
      file_bytes_per_read: summarize(subset.map((sample) => sample.file_bytes), 0),
      file_bytes_per_call_max: summarize(subset.map((sample) => sample.max_call_bytes), 0),
      storage_bytes_per_read: summarize(subset.map((sample) => sample.storage_bytes), 0),
    });
    const results = Object.fromEntries(OPS.map((op) => {
      const ofOp = samples.filter((sample) => sample.op === op);
      return [op, {
        all: statsFor(ofOp),
        by_bucket: Object.fromEntries(BUCKETS.map((bucket) => [bucket, statsFor(ofOp.filter((sample) => sample.bucket === bucket))])),
      }];
    })) as Record<Op, { all: ReturnType<typeof statsFor>; by_bucket: Record<Bucket, ReturnType<typeof statsFor>> }>;

    const archives = db.query(
      `SELECT COUNT(*) AS n, SUM(size_bytes) AS bytes FROM multiremi_session_archives
       WHERE status = 'ready' AND metadata LIKE '%"kind":"trace_backfill"%'`,
    ).get() as { n: unknown; bytes: unknown };
    const sampleStats = (bucket: Bucket) => {
      const tasks = sampled.filter((task) => task.bucket === bucket);
      return {
        population: byBucket[bucket].length,
        sampled: tasks.length,
        uncompressed_bytes: summarize(tasks.map((task) => task.uncompressed_size), 0),
        compressed_bytes: summarize(tasks.map((task) => task.compressed_size), 0),
        events: summarize(tasks.map((task) => task.event_count), 0),
        at_or_above_p99: tasks.filter((task) => task.uncompressed_size >= thresholds.p99).length,
      };
    };
    return {
      backend: name,
      database: bench.database,
      corpus: { generate_ms: Math.round(generateMs), summary: { ...corpus, params: undefined } },
      backfill: {
        ms: Math.round(backfillMs),
        execution: backfill.execution,
        archives: Number(archives.n),
        archive_bytes: Number(archives.bytes),
      },
      population: {
        archived_tasks: archived.length,
        size_thresholds_uncompressed_bytes: thresholds,
        compressed_bytes: summarize(archived.map((task) => task.compressed_size), 0),
        uncompressed_bytes: summarize(sizes, 0),
        events: summarize(archived.map((task) => task.event_count), 0),
      },
      sample: {
        seed: `${SEED}:sample`,
        tasks: sampled.length,
        warmup_tasks: warmup.length,
        by_bucket: Object.fromEntries(BUCKETS.map((bucket) => [bucket, sampleStats(bucket)])),
      },
      byte_bound: {
        rule: "every readTrace call reads <= member compressed_size + 65536 bytes from the archive file",
        calls: bound.calls,
        violations: bound.violations,
        max_excess_over_compressed_bytes: bound.max_excess_bytes,
        min_excess_over_compressed_bytes: bound.min_excess_bytes,
      },
      validation_failures: failures,
      measure_ms: Math.round(measureMs),
      results,
    };
  } finally {
    await bench.close();
  }
}

// ───────────────────────────── report ─────────────────────────────

type BackendReport = Awaited<ReturnType<typeof measureBackend>>;

function gitCommit(): { head: string; dirty: boolean } {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim();
  const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: REPO_ROOT }).stdout.toString().trim();
  return { head, dirty: status.length > 0 };
}

const OP_LABEL: Record<Op, string> = {
  full_cold: "全量 / 冷",
  full_warm: "全量 / 热",
  tail_cold: "尾窗 100 / 冷",
  tail_warm: "尾窗 100 / 热",
};
const BUCKET_LABEL: Record<Bucket, string> = { le_p50: "≤p50", p50_p90: "p50–p90", gt_p90: ">p90（含 ≥p99）" };

function kib(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

function markdown(report: {
  generated_at: string; commit: { head: string; dirty: boolean }; machine: Record<string, unknown>;
  params: Record<string, unknown>; backends: BackendReport[]; json_name: string;
}): string {
  const lines: string[] = [];
  const corpus = report.backends[0]?.corpus.summary;
  lines.push("# MUL-402 B8：回填归档的 trace 读延迟（MUL-432 第 10 项）", "");
  lines.push(
    "- 父单：MUL-402；本单：MUL-432（第一段）",
    `- 生成时间：${report.generated_at}`,
    `- 被测 commit：\`${report.commit.head}\`${report.commit.dirty ? "（运行时已跟踪文件有未提交改动）" : "（运行时已跟踪文件无改动；harness 与本报告随后一起提交）"}`,
    `- 运行机器：${report.machine.platform} ${report.machine.arch}，${report.machine.cpus} vCPU，${report.machine.mem_gib} GiB RAM；Bun ${report.machine.bun}；归档目录在 ext4 本地盘`,
    `- 原始 JSON：[\`${report.json_name}\`](${report.json_name})`,
    "",
    "## 口径",
    "",
    "- 读路径：B5 `TraceReader.readTrace`（`GET /api/tasks/:id/trace` 用的同一个类），指针 → 归档行 → open/pread → inflate → sha256 校验 → 行解析 → 窗口。计时只包 `readTrace` 调用，不含 HTTP。",
    `- 全量读：从 seq 0 起每页 ${TRACE_READ_MAX_LIMIT} 条（接口上限），跟 \`next_after_seq\` 翻到 eof；一次全量读的耗时和字节是所有页之和。尾窗：一次 \`readTrace(cursor, 100)\`，cursor 是倒数第 101 条事件的 seq（稀疏 seq 下按真实事件数取尾 100 条）。`,
    "- 冷：每次读前对整个归档文件做 `posix_fadvise(DONTNEED)`，把它踢出页缓存；热：紧接着再读一遍。`storage bytes` 列是 `/proc/self/io` 的 `read_bytes` 增量（真正落到磁盘的字节，按页取整、含内核预读），用来证明冷读确实没命中缓存、热读确实命中了。",
    "- 读字节：给 `FileHandle.prototype.read` 计数，即读者向文件系统要的字节。每次 `readTrace` 调用单独核对 `≤ compressed_size + 64 KiB`。",
    "- 分位数：最近秩法 `sorted[ceil(q·n)-1]`；每个格子 n 是读的次数。",
    `- 抽样：归档任务按成员解压后大小分三桶——≤p50、p50–p90、>p90（>p90 包含全部 ≥p99 的任务），每桶随机抽约 ${Math.round(Number(report.params.sample) / 3)} 个，共 ${report.params.sample} 个；另取 ${WARMUP_TASKS} 个不在样本里的任务先读一遍预热（不计入）。任务顺序打乱，冷热交替。`,
    "",
    "## 合成数据",
    "",
    "生成器 `scripts/lib/task-trace-synthetic.ts`，分布取自 MUL-402 评论 cmt_z0j166q2zbx9（生产只读统计，快照 2026-09-26T19:19Z）与父单描述里的单任务分位数，不读生产库。两个后端用同一个 seed，数据逐行相同。",
    "",
    `- 参数：tasksWithRows=${report.params.tasks}，rowScale=${report.params.row_scale}，seed=\`${report.params.seed}\`，rowsSigma=${SYNTHETIC_CORPUS_DEFAULTS.rowsSigma}，maxRowsPerTask=${SYNTHETIC_CORPUS_DEFAULTS.maxRowsPerTask}，oldTableStoppedAt=${SYNTHETIC_CORPUS_DEFAULTS.oldTableStoppedAt}`,
  );
  if (corpus) {
    lines.push(
      `- 规模：${corpus.rows.total.toLocaleString("en-US")} 行，${(corpus.rows.bytes / 1024 / 1024).toFixed(1)} MiB 列字节；有行任务 ${corpus.tasks.with_rows}（chat ${corpus.tasks.by_group.chat} / 单次 ${corpus.tasks.by_group.task} / 无归档 issue ${corpus.tasks.by_group.issue_without_archive} / 有归档 issue ${corpus.tasks.by_group.issue_with_archive}），其中运行中 ${corpus.tasks.nonterminal_with_rows}；无行终态任务 issue ${corpus.tasks.none.issue} / chat ${corpus.tasks.none.chat} / 单次 ${corpus.tasks.none.task}`,
      `- 主体：chat ${corpus.subjects.chat}，单次任务 ${corpus.subjects.task}，无归档 issue ${corpus.subjects.issue_without_archive}，有归档 issue ${corpus.subjects.issue_with_archive}`,
      `- 单任务行数 p50/p90/p99/max = ${corpus.task_rows.p50}/${corpus.task_rows.p90}/${corpus.task_rows.p99}/${corpus.task_rows.max}（生产 ${PRODUCTION_TRACE_SHAPE.taskRows.p50}/${PRODUCTION_TRACE_SHAPE.taskRows.p90}/${PRODUCTION_TRACE_SHAPE.taskRows.p99}）；单任务字节 p50/p90/p99 = ${kib(corpus.task_bytes.p50)}/${kib(corpus.task_bytes.p90)}/${kib(corpus.task_bytes.p99)} KiB（生产 ${kib(PRODUCTION_TRACE_SHAPE.taskBytes.p50)}/${kib(PRODUCTION_TRACE_SHAPE.taskBytes.p90)}/${kib(PRODUCTION_TRACE_SHAPE.taskBytes.p99)} KiB）`,
      `- 特殊行：截断 input ${corpus.special.truncated_input}，截断 output ${corpus.special.truncated_output}，截断 meta ${corpus.special.truncated_meta}，meta 含 \`\\u0000\` ${corpus.special.nul_escape_meta}；稀疏 seq 任务 ${corpus.sparse.tasks_with_gaps}，缺号 ${corpus.sparse.missing_seqs}`,
    );
  }
  lines.push("");
  for (const backend of report.backends) {
    lines.push(`## ${backend.backend === "sqlite" ? "SQLite" : "PostgreSQL"}`, "");
    lines.push(
      `- 数据库：${backend.database}`,
      `- 生成 ${backend.corpus.generate_ms} ms；回填 ${backend.backfill.ms} ms，产出 ${backend.backfill.archives} 个 trace_backfill 归档共 ${(backend.backfill.archive_bytes / 1024 / 1024).toFixed(1)} MiB；逐组对账全部通过`,
      `- 归档任务 ${backend.population.archived_tasks} 个；分桶阈值（解压后字节）p50=${backend.population.size_thresholds_uncompressed_bytes.p50}，p90=${backend.population.size_thresholds_uncompressed_bytes.p90}，p99=${backend.population.size_thresholds_uncompressed_bytes.p99}`,
      `- 读正确性核对失败：${backend.validation_failures.length}`,
      "",
      "| 桶 | 总数 | 抽中 | 其中 ≥p99 | 解压 KiB p50 / max | 压缩 KiB p50 / max | 事件数 p50 / max |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const bucket of BUCKETS) {
      const s = backend.sample.by_bucket[bucket];
      lines.push(`| ${BUCKET_LABEL[bucket]} | ${s.population} | ${s.sampled} | ${s.at_or_above_p99} | ${kib(s.uncompressed_bytes.p50)} / ${kib(s.uncompressed_bytes.max)} | ${kib(s.compressed_bytes.p50)} / ${kib(s.compressed_bytes.max)} | ${s.events.p50} / ${s.events.max} |`);
    }
    lines.push("", `### 延迟（ms，全部 ${backend.sample.tasks} 个任务）`, "");
    lines.push("| 读法 | n | p50 | p95 | p99 | max | 调用数 p50 / max | 读字节 KiB p50 / p95 / p99 / max | storage KiB p50 / p95 |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const op of OPS) {
      const s = backend.results[op].all;
      lines.push(`| ${OP_LABEL[op]} | ${s.reads} | ${s.latency_ms.p50} | ${s.latency_ms.p95} | ${s.latency_ms.p99} | ${s.latency_ms.max} | ${s.calls_per_read.p50} / ${s.calls_per_read.max} | ${kib(s.file_bytes_per_read.p50)} / ${kib(s.file_bytes_per_read.p95)} / ${kib(s.file_bytes_per_read.p99)} / ${kib(s.file_bytes_per_read.max)} | ${kib(s.storage_bytes_per_read.p50)} / ${kib(s.storage_bytes_per_read.p95)} |`);
    }
    lines.push("", "### 分桶延迟（ms，p50 / p95 / p99）", "");
    lines.push(`| 读法 | ${BUCKETS.map((bucket) => BUCKET_LABEL[bucket]).join(" | ")} |`);
    lines.push(`| --- | ${BUCKETS.map(() => "---:").join(" | ")} |`);
    for (const op of OPS) {
      const cells = BUCKETS.map((bucket) => {
        const s = backend.results[op].by_bucket[bucket].latency_ms;
        return `${s.p50} / ${s.p95} / ${s.p99}`;
      });
      lines.push(`| ${OP_LABEL[op]} | ${cells.join(" | ")} |`);
    }
    const bound = backend.byte_bound;
    lines.push(
      "",
      `### 读字节上界`,
      "",
      `${bound.calls} 次 \`readTrace\` 调用逐次核对 \`读字节 ≤ compressed_size + 64 KiB\`：违例 **${bound.violations}**。每次调用读字节减去该成员 compressed_size 的差值范围是 ${bound.min_excess_over_compressed_bytes} 到 ${bound.max_excess_over_compressed_bytes} 字节${bound.min_excess_over_compressed_bytes === 0 && bound.max_excess_over_compressed_bytes === 0 ? "，即每次调用只读成员压缩体本身（一次 pread），不读中央目录、不读本地头" : ""}。全量读要翻多页时每页各读一遍成员，所以“一次全量读”的总字节是页数 × compressed_size，上界按调用成立。`,
      "",
    );
  }
  lines.push(
    "## 解读与局限",
    "",
    "- 这是进程内服务端读路径的数字，不含 HTTP 与网络；PG 列包含指针与归档行两次查询经桥往返的开销。",
    "- 冷读只把归档文件踢出页缓存；数据库页（SQLite 文件、PG shared buffers）保持热，这与生产上指针表常驻缓存的情况一致。",
    "- 合成数据的单任务行数按对数正态拟合生产 p50 与均值，p99 行数低于生产（见上），字节分位与生产接近；列内容取自英文词池，压缩率接近文本日志，与真实 trace 会有出入。",
    "- 生产 209 上的真实延迟要等回填经贺华杰授权执行后再测，本报告不替代那一步。",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (!OUT) throw new Error("--out <report.json> is required");
  if (!Number.isSafeInteger(TASKS) || TASKS <= 0) throw new Error("--tasks must be a positive integer");
  if (!Number.isFinite(ROW_SCALE) || ROW_SCALE <= 0) throw new Error("--row-scale must be positive");
  await instrumentFileHandleReads();
  const workDir = argValue("work-dir") ?? await mkdtemp(join(tmpdir(), "m432-bench-"));
  mkdirSync(workDir, { recursive: true });
  const corpusParams: SyntheticCorpusParams = { ...SYNTHETIC_CORPUS_DEFAULTS, seed: SEED, tasksWithRows: TASKS, rowScale: ROW_SCALE };
  const backends: BackendReport[] = [];
  try {
    for (const name of BACKENDS) backends.push(await measureBackend(name, workDir, corpusParams));
  } finally {
    if (!KEEP) await rm(workDir, { recursive: true, force: true });
  }
  const outPath = resolve(OUT);
  const report = {
    generated_at: new Date().toISOString(),
    issue: "MUL-432 item 10 (MUL-402 B8)",
    commit: gitCommit(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      mem_gib: Math.round(totalmem() / 1024 ** 3),
      bun: Bun.version,
    },
    params: {
      tasks: TASKS,
      row_scale: ROW_SCALE,
      seed: SEED,
      sample: SAMPLE,
      tail_window: TAIL_WINDOW,
      page_limit: TRACE_READ_MAX_LIMIT,
      byte_slack: BYTE_SLACK,
      warmup_tasks: WARMUP_TASKS,
      corpus: corpusParams,
    },
    backends,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  const mdPath = outPath.replace(/\.json$/, ".md");
  writeFileSync(mdPath, markdown({ ...report, json_name: outPath.split("/").at(-1)! }));
  console.error(`wrote ${outPath} and ${mdPath}`);
  const failed = backends.some((backend) => backend.validation_failures.length || backend.byte_bound.violations);
  if (failed) process.exitCode = 3;
}

if (import.meta.main) {
  await main();
}
