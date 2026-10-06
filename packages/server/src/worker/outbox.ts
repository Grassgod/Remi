import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { openSqliteDatabase } from "../store/db/sqlite.js";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "@shared/logger.js";
import type { TaskMessageInput } from "@multiremi/contracts/types.js";
import { MultiremiDaemonHttpError } from "./client.js";
import { DaemonProtocolRpcError } from "./daemon-protocol-client.js";
import { DAEMON_FRAME_MAX_BYTES, DAEMON_UPLINK_WINDOW_FRAMES, DAEMON_UPLINK_WINDOW_BYTES } from "@multiremi/contracts/daemon-protocol.js";
import { outboxRecordBytes } from "./report-frames.js";
import { splitUsageReport } from "./usage-report-chunks.js";
import {
  coalesceTaskMessages,
  DEFAULT_TASK_MESSAGE_BATCH_COUNT,
} from "./task-message-batcher.js";

const log = createLogger("multiremi-outbox");

export type MultiremiOutboxKind =
  | "start"
  | "prompt"
  | "session_pin"
  | "progress"
  | "messages"
  | "usage"
  | "workspace"
  | "complete"
  | "fail"
  | "runtime.update_result"
  | "runtime.command_result"
  | "runtime.model_list_result"
  | "runtime.local_skills_result"
  | "runtime.directory_scan_result"
  | "runtime.local_skill_import_result"
  | "runtime.bot_menu_result"
  | "feishu.outbound_result"
  | "plugin.state";

const TERMINAL_KINDS = new Set<MultiremiOutboxKind>(["complete", "fail"]);

export interface MultiremiOutboxRecord {
  id: number;
  taskId: string;
  kind: MultiremiOutboxKind;
  payload: Record<string, unknown>;
  seq: number;
  terminal: boolean;
  attempts: number;
}

export interface MultiremiOutboxStats {
  pending: number;
  pendingNonTerminal: number;
  blocked: number;
  pendingTerminal: number;
  pendingTasks: number;
  oldestPendingCreatedAt: string | null;
  droppedTotal: number;
  fileBytes: number;
  overCapBytes: number;
}

export type MultiremiOutboxDrainResult = "delivered" | "blocked" | "aborted";

export interface MultiremiTaskReportOutboxOptions {
  /** SQLite file path; ":memory:" for tests. Parent directory is created. */
  path: string;
  /** Sends one reliable frame and waits for its individual res. */
  deliver: (record: MultiremiOutboxRecord) => Promise<void | Record<string, unknown>>;
  canSend?: () => boolean;
  /** Legacy wire adaptation runs before frame/window byte accounting. */
  prepareDelivery?: (record: MultiremiOutboxRecord) => MultiremiOutboxRecord;
  /** Bounded exponential backoff schedule; the last entry repeats. */
  backoffScheduleMs?: number[];
  /** Soft cap: compact covered progress/session_pin/workspace rows, retaining all other reliable reports. */
  maxBytes?: number;
  /** Called once when a task's queue enters the blocked state. */
  onTaskBlocked?: (taskId: string, error: string) => void;
  /** Maximum consecutive message records delivered in one API request. */
  deliveryBatchSize?: number;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DISCARDED_TASK_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * One durable process-wide pump. Row ids are reliable WS seqs; each task or
 * rt: partition is ordered, while independent partitions share the bounded
 * frame/byte window. Only covered overwrite reports are compacted at the soft size cap.
 * Permanent errors block a partition; task_not_found discards it instead,
 * and steer_pending hands completion back to the executor or reports recovery.
 */
export class MultiremiTaskReportOutbox {
  private readonly db: Database;
  private readonly deliver: MultiremiTaskReportOutboxOptions["deliver"];
  private readonly backoff: number[];
  private readonly maxBytes: number;
  private readonly onTaskBlocked: ((taskId: string, error: string) => void) | null;
  private readonly deliveryBatchSize: number;
  private readonly inFlight = new Map<string, { bytes: number; done: Promise<void> }>();
  private readonly canSend: () => boolean;
  private readonly prepareDelivery: NonNullable<MultiremiTaskReportOutboxOptions["prepareDelivery"]>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduled = false;
  private readonly drainWaiters = new Map<string, Array<(result: MultiremiOutboxDrainResult) => void>>();
  private readonly recordWaiters = new Map<number, { taskId: string; resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  private closed = false;

  constructor(options: MultiremiTaskReportOutboxOptions) {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = openSqliteDatabase(options.path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    if (options.path !== ":memory:") {
      // Payloads mirror task reports (transcripts, prompts) — owner-only, like
      // the rest of the daemon state dir.
      try {
        chmodSync(options.path, 0o600);
      } catch {
        // Non-fatal on filesystems without chmod support.
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL,
        terminal INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_task_seq ON outbox_events(task_id, seq);
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status);
      CREATE TABLE IF NOT EXISTS outbox_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox_discarded_tasks (
        task_id TEXT PRIMARY KEY,
        keep_terminal INTEGER NOT NULL,
        keep_usage INTEGER NOT NULL DEFAULT 0,
        discarded_at TEXT NOT NULL
      );
    `);
    const discardedColumns = this.db.query("PRAGMA table_info(outbox_discarded_tasks)").all() as Array<{ name: string }>;
    if (!discardedColumns.some(column => column.name === "keep_usage")) {
      this.db.exec("ALTER TABLE outbox_discarded_tasks ADD COLUMN keep_usage INTEGER NOT NULL DEFAULT 0");
    }
    this.deliver = options.deliver;
    this.canSend = options.canSend ?? (() => true);
    this.prepareDelivery = options.prepareDelivery ?? (record => record);
    this.backoff = options.backoffScheduleMs?.length ? options.backoffScheduleMs : DEFAULT_BACKOFF_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.onTaskBlocked = options.onTaskBlocked ?? null;
    this.deliveryBatchSize = Math.max(1, Math.floor(options.deliveryBatchSize ?? DEFAULT_TASK_MESSAGE_BATCH_COUNT));
    this.db.run("UPDATE outbox_events SET next_attempt_at = NULL WHERE status = 'pending'");
  }

  /** Persist a report and wake the task's delivery pump. Never throws on queue pressure. */
  enqueue(taskId: string, kind: MultiremiOutboxKind, payload: Record<string, unknown>): number | null {
    if (this.closed) throw new Error("outbox is closed");
    const snapshot = payload.usageSnapshot as import("@multiremi/contracts/usage-accounting.js").TaskUsageSnapshot | undefined;
    if (kind === "usage" && snapshot?.version === 2 && Array.isArray(snapshot.units)) {
      const chunks = splitUsageReport(snapshot);
      if (chunks.length > 1) {
        let lastId: number | null = null;
        for (const chunk of chunks) lastId = this.enqueue(taskId, kind, { ...payload, usageSnapshot: chunk });
        return lastId;
      }
    }
    const terminal = TERMINAL_KINDS.has(kind);
    const discarded = this.db.query(
      "SELECT keep_terminal, keep_usage FROM outbox_discarded_tasks WHERE task_id = ?",
    ).get(taskId) as { keep_terminal: number; keep_usage: number } | null;
    if (discarded && !(Number(discarded.keep_terminal) === 1 && terminal)
      && !(Number(discarded.keep_usage) === 1 && kind === "usage")) {
      const total = Number(this.readMeta("dropped_total") ?? 0) + 1;
      this.writeMeta("dropped_total", String(total));
      log.debug(`outbox discarded ${kind} report for tombstoned task ${taskId}`);
      return null;
    }
    const idRow = this.db.query("SELECT seq FROM sqlite_sequence WHERE name = 'outbox_events'").get() as { seq: number } | null;
    const id = Number(idRow?.seq ?? 0) + 1;
    const oversized = outboxRecordBytes({ id, taskId, kind, payload, seq: id, terminal, attempts: 0 }) > DAEMON_FRAME_MAX_BYTES;
    const blocked = this.readMeta(`blocked:${taskId}`) !== null || oversized;
    this.db.run(
      `INSERT INTO outbox_events (idempotency_key, task_id, kind, payload, seq, terminal, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), taskId, kind, JSON.stringify(oversized ? {} : payload), id, terminal ? 1 : 0, blocked ? "blocked" : "pending", new Date().toISOString()],
    );
    // A complete marker may follow multiple bounded chunks. It never proves
    // that one body contains older units, so pending usage deltas are retained.
    if (oversized) this.blockPartition(taskId, "protocol_violation: encoded report exceeds 1 MiB");
    this.enforceSizeCap();
    this.ensurePump(taskId);
    return id;
  }

  enqueueAndWait(taskId: string, kind: MultiremiOutboxKind, payload: Record<string, unknown>, timeoutMs = 30_000, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const id = this.enqueue(taskId, kind, payload);
    if (id === null) return Promise.resolve({ ok: true });
    const blocked = this.readMeta(`blocked:${taskId}`);
    if (blocked) return Promise.reject(new DaemonProtocolRpcError(this.readMeta(`blocked-code:${taskId}`) ?? "protocol_violation", false));
    return new Promise((resolve, reject) => {
      const clear = () => { clearTimeout(timer); signal?.removeEventListener("abort", interrupted); };
      const interrupted = () => {
        clear();
        this.recordWaiters.delete(id);
        if (terminal) resolve({ ok: true, queued: true });
        else reject(new DaemonProtocolRpcError("daemon_unreachable", true));
      };
      const terminal = TERMINAL_KINDS.has(kind);
      const timer = setTimeout(() => {
        clear();
        this.recordWaiters.delete(id);
        log.warn(`outbox result wait timed out for ${taskId} (${kind} id ${id}); retained for replay`);
        if (terminal) resolve({ ok: true, queued: true });
        else reject(new DaemonProtocolRpcError("daemon_timeout", true));
      }, timeoutMs);
      this.recordWaiters.set(id, { taskId,
        resolve: value => { clear(); resolve(value); },
        reject: error => { clear(); reject(error); },
      });
      signal?.addEventListener("abort", interrupted, { once: true });
      if (signal?.aborted) interrupted();
    });
  }

  /** Copy old provider queues once; their files remain recoverable. */
  importLegacy(path: string, runtimeId?: string): void {
    if (path === ":memory:") return;
    const source = openSqliteDatabase(path, { readonly: true });
    try {
      const prefix = createHash("sha256").update(path).digest("hex");
      const rows = source.query("SELECT * FROM outbox_events ORDER BY id").all() as Array<Record<string, unknown>>;
      this.db.transaction(() => {
        for (const row of rows) {
          const key = `imported:${prefix}:${row.idempotency_key}`;
          if (this.readMeta(key)) continue;
          const record = toRecord(row);
          const id = this.enqueue(record.taskId, record.kind, { ...record.payload, ...(runtimeId ? { runtime_id: runtimeId } : {}) });
          if (row.status === "blocked" && id !== null) this.blockPartition(record.taskId, "legacy permanent delivery error");
          this.writeMeta(key, "1");
        }
      })();
    } finally { source.close(); }
    const backup = `${path}.migrated-v2`;
    const destination = ["", "-wal", "-shm"].some(suffix => existsSync(`${backup}${suffix}`))
      ? `${path}.${randomUUID()}.migrated-v2` : backup;
    renameSync(path, destination);
    // A crashed v1 writer can leave committed rows only in its WAL.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${destination}${suffix}`);
    }
  }

  /** Resolves when the task queue is empty (delivered), blocked, or the signal aborts. */
  async waitForTaskDrain(taskId: string, signal?: AbortSignal): Promise<MultiremiOutboxDrainResult> {
    const immediate = this.taskDrainState(taskId);
    if (immediate) return immediate;
    if (signal?.aborted) return "aborted";
    this.ensurePump(taskId);
    return await new Promise<MultiremiOutboxDrainResult>((resolve) => {
      let settled = false;
      const finish = (result: MultiremiOutboxDrainResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => finish("aborted");
      const waiters = this.drainWaiters.get(taskId) ?? [];
      waiters.push(finish);
      this.drainWaiters.set(taskId, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const state = this.taskDrainState(taskId);
      if (state) this.settleDrainWaiters(taskId, state);
    });
  }

  /** Restart recovery: pump every task with pending rows and wait for the queues to settle. */
  async flushAll(signal?: AbortSignal): Promise<void> {
    const rows = this.db.query(
      "SELECT DISTINCT task_id FROM outbox_events WHERE status = 'pending'",
    ).all() as Array<{ task_id: string }>;
    await Promise.all(rows.map((row) => this.waitForTaskDrain(String(row.task_id), signal)));
  }

  pendingTaskIds(): string[] {
    const rows = this.db.query(
      "SELECT DISTINCT task_id FROM outbox_events WHERE status = 'pending'",
    ).all() as Array<{ task_id: string }>;
    return rows.map((row) => String(row.task_id));
  }

  taskIdsWithPendingTerminal(runtimeId?: string): string[] {
    const rows = this.db.query(
      `SELECT DISTINCT task_id FROM outbox_events WHERE status = 'pending' AND terminal = 1
       AND (? IS NULL OR json_extract(payload, '$.runtime_id') = ?)`,
    ).all(runtimeId ?? null, runtimeId ?? null) as Array<{ task_id: string }>;
    return rows.map((row) => String(row.task_id));
  }

  /**
   * Discard reports that no longer have server-side value and prevent future
   * producers from recreating them. A terminal-only tombstone is useful when
   * callers still need to preserve a completion/failure report.
   */
  purgeTask(taskId: string, options: { keepTerminal?: boolean; keepUsage?: boolean } = {}): number {
    if (this.closed) return 0;
    const keepTerminal = options.keepTerminal === true;
    const keepUsage = options.keepUsage === true;
    const discardedAt = new Date().toISOString();
    const cutoff = new Date(Date.now() - DISCARDED_TASK_TTL_MS).toISOString();
    const purge = this.db.transaction(() => {
      this.db.run("DELETE FROM outbox_discarded_tasks WHERE discarded_at < ?", [cutoff]);
      this.db.run(
        `INSERT INTO outbox_discarded_tasks (task_id, keep_terminal, keep_usage, discarded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           keep_terminal = MIN(outbox_discarded_tasks.keep_terminal, excluded.keep_terminal),
           keep_usage = MIN(outbox_discarded_tasks.keep_usage, excluded.keep_usage),
           discarded_at = excluded.discarded_at`,
        [taskId, keepTerminal ? 1 : 0, keepUsage ? 1 : 0, discardedAt],
      );
      const tombstone = this.db.query(
        "SELECT keep_terminal, keep_usage FROM outbox_discarded_tasks WHERE task_id = ?",
      ).get(taskId) as { keep_terminal: number; keep_usage: number };
      const result = this.db.run("DELETE FROM outbox_events WHERE task_id = ? AND NOT (terminal = 1 AND ? = 1) AND NOT (kind = 'usage' AND ? = 1)",
        [taskId, Number(tombstone.keep_terminal), Number(tombstone.keep_usage)]);
      return Number(result.changes);
    });
    const purged = purge();
    for (const [id, waiter] of this.recordWaiters) {
      if (waiter.taskId === taskId && !this.db.query("SELECT id FROM outbox_events WHERE id = ?").get(id)) {
        waiter.resolve({ ok: true, discarded: true });
        this.recordWaiters.delete(id);
      }
    }
    this.db.run("DELETE FROM outbox_meta WHERE key IN (?, ?)", [`blocked:${taskId}`, `blocked-code:${taskId}`]);

    // The pump may be in retry backoff, and drain waiters otherwise only settle
    // from ensurePump().finally(). Re-evaluate both immediately after deletion.
    this.ensurePump(taskId);
    const state = this.taskDrainState(taskId);
    if (state) this.settleDrainWaiters(taskId, state);
    return purged;
  }

  stats(): MultiremiOutboxStats {
    const pending = this.db.query("SELECT COUNT(*) AS n FROM outbox_events WHERE status = 'pending'").get() as { n: number };
    const blocked = this.db.query("SELECT COUNT(*) AS n FROM outbox_events WHERE status = 'blocked'").get() as { n: number };
    const pendingTerminal = this.db.query(
      "SELECT COUNT(*) AS n FROM outbox_events WHERE status = 'pending' AND terminal = 1",
    ).get() as { n: number };
    const pendingTasks = this.db.query(
      "SELECT COUNT(DISTINCT task_id) AS n FROM outbox_events WHERE status = 'pending'",
    ).get() as { n: number };
    const oldest = this.db.query(
      "SELECT MIN(created_at) AS at FROM outbox_events WHERE status = 'pending'",
    ).get() as { at: string | null };
    const pages = this.db.query("PRAGMA page_count").get() as { page_count: number };
    const pageSize = this.db.query("PRAGMA page_size").get() as { page_size: number };
    const fileBytes = Number(pages.page_count) * Number(pageSize.page_size);
    return {
      pending: Number(pending.n),
      pendingNonTerminal: Number(pending.n) - Number(pendingTerminal.n),
      blocked: Number(blocked.n),
      pendingTerminal: Number(pendingTerminal.n),
      pendingTasks: Number(pendingTasks.n),
      oldestPendingCreatedAt: oldest.at ?? null,
      droppedTotal: Number(this.readMeta("dropped_total") ?? 0),
      fileBytes,
      overCapBytes: Math.max(0, fileBytes - this.maxBytes),
    };
  }

  /** Wake every pending pump without waiting (fire-and-forget delivery). */
  pumpAll(): void {
    for (const taskId of this.pendingTaskIds()) this.ensurePump(taskId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const waiter of this.recordWaiters.values()) waiter.reject(new DaemonProtocolRpcError("daemon_unreachable", true));
    this.recordWaiters.clear();
    for (const [taskId] of this.drainWaiters) this.settleDrainWaiters(taskId, "aborted");
    await Promise.allSettled([...this.inFlight.values()].map(item => item.done));
    this.db.close();
  }

  private taskDrainState(taskId: string): MultiremiOutboxDrainResult | null {
    if (this.closed) return "aborted";
    if (this.readMeta(`blocked:${taskId}`) !== null) return "blocked";
    const row = this.db.query(
      "SELECT status FROM outbox_events WHERE task_id = ? ORDER BY seq ASC LIMIT 1",
    ).get(taskId) as { status: string } | null;
    if (!row) return "delivered";
    if (row.status === "blocked") return "blocked";
    return null;
  }

  private settleDrainWaiters(taskId: string, result: MultiremiOutboxDrainResult): void {
    const waiters = this.drainWaiters.get(taskId);
    if (!waiters?.length) return;
    this.drainWaiters.delete(taskId);
    for (const waiter of waiters) waiter(result);
  }

  private ensurePump(taskId: string): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.closed) this.runPump();
    });
  }

  private runPump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const rows = this.db.query(`SELECT task_id, MIN(id) AS id FROM outbox_events
      GROUP BY task_id ORDER BY id`).all() as Array<{ task_id: string; id: number }>;
    let bytes = [...this.inFlight.values()].reduce((total, item) => total + item.bytes, 0);
    let nextWake = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      if (!this.canSend()) { nextWake = Math.min(nextWake, 100); break; }
      const taskId = row.task_id;
      if (this.inFlight.has(taskId)) continue;
      const delivery = this.nextDelivery(taskId);
      if (!delivery || delivery.blocked || this.readMeta(`blocked:${taskId}`) !== null) continue;
      const retry = this.db.query("SELECT next_attempt_at FROM outbox_events WHERE id = ?").get(delivery.record.id) as { next_attempt_at: number | null };
      const delay = Number(retry.next_attempt_at ?? 0) - Date.now();
      if (delay > 0) { nextWake = Math.min(nextWake, delay); continue; }
      delivery.record = this.prepareDelivery(delivery.record);
      const frameBytes = outboxRecordBytes(delivery.record);
      if (frameBytes > DAEMON_FRAME_MAX_BYTES) {
        this.blockPartition(taskId, "protocol_violation: persisted report exceeds 1 MiB");
        continue;
      }
      if (this.inFlight.size >= DAEMON_UPLINK_WINDOW_FRAMES || bytes + frameBytes > DAEMON_UPLINK_WINDOW_BYTES) break;
      bytes += frameBytes;
      const done = Promise.resolve().then(() => this.deliverRecord(delivery)).finally(() => {
        this.inFlight.delete(taskId);
        if (this.closed) return;
        const state = this.taskDrainState(taskId);
        if (state) this.settleDrainWaiters(taskId, state);
        this.ensurePump(taskId);
      });
      this.inFlight.set(taskId, { bytes: frameBytes, done });
    }
    if (Number.isFinite(nextWake)) {
      this.timer = setTimeout(() => { this.timer = null; this.ensurePump(""); }, Math.max(1, nextWake));
      this.timer.unref?.();
    }
  }

  private async deliverRecord({ record, recordIds }: OutboxDelivery): Promise<void> {
    const taskId = record.taskId;
    if (!this.db.query("SELECT id FROM outbox_events WHERE id = ? AND status = 'pending'").get(record.id)) return;
    try {
      const reply = await this.deliver(record);
      this.deleteRecords(recordIds);
      for (const id of recordIds) {
        this.recordWaiters.get(id)?.resolve(reply ?? { ok: true });
        this.recordWaiters.delete(id);
      }
    } catch (error) {
      if (error instanceof DaemonProtocolRpcError && error.code === "steer_pending" && record.kind === "complete") {
        if (this.closed) return;
        const waiter = this.recordWaiters.get(record.id);
        this.deleteRecords(recordIds);
        this.recordWaiters.delete(record.id);
        if (waiter) waiter.reject(error);
        else {
          log.warn(`outbox completion for ${taskId} rejected by steer barrier without a waiting executor; reporting runtime_recovery`);
          this.enqueue(taskId, "fail", { runtime_id: record.payload.runtime_id,
            session_id: record.payload.session_id ?? record.payload.sessionId,
            work_dir: record.payload.work_dir ?? record.payload.workDir,
            failure_reason: "runtime_recovery", error: "完成时有未注入的 steer，执行端已不在" });
        }
        return;
      }
      if (error instanceof DaemonProtocolRpcError && error.code === "task_not_found") {
        log.warn(`outbox partition ${taskId} discarded: task_not_found`);
        this.purgeTask(taskId);
        for (const id of recordIds) {
          this.recordWaiters.get(id)?.resolve({ ok: true, discarded: true });
          this.recordWaiters.delete(id);
        }
        return;
      }
      if (isDeliveredEquivalent(error, record)) {
        this.deleteRecords(recordIds);
        for (const id of recordIds) {
          this.recordWaiters.get(id)?.resolve({ ok: true });
          this.recordWaiters.delete(id);
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isPermanentDeliveryError(error)) {
        const blocked = this.db.run(
          `UPDATE outbox_events SET status = 'blocked', last_error = ?
           WHERE task_id = ? AND status = 'pending'
             AND EXISTS (SELECT 1 FROM outbox_events WHERE id = ?)`,
          [message.slice(0, 2_000), taskId, record.id],
        );
        // purgeTask may have deleted the in-flight record while deliver()
        // awaited. In that case, do not let its stale failure block terminal
        // rows that a keepTerminal tombstone still permits.
        if (Number(blocked.changes) === 0) return;
        this.blockPartition(taskId, message, error instanceof DaemonProtocolRpcError ? error.code : "invalid_report");
        for (const id of recordIds) {
          this.recordWaiters.get(id)?.reject(error instanceof Error ? error : new Error(message));
          this.recordWaiters.delete(id);
        }
        return;
      }
      const attempts = record.attempts + 1;
      const delay = this.backoff[Math.min(attempts - 1, this.backoff.length - 1)]!;
      const updated = this.db.run(
        "UPDATE outbox_events SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
        [attempts, Date.now() + delay, message.slice(0, 2_000), record.id],
      );
      if (Number(updated.changes) === 0) return;
      if (attempts === 1 || attempts % 10 === 0) {
        log.warn(`outbox delivery for task ${taskId} (${record.kind} seq ${record.seq}) failed, retrying in ${delay}ms: ${message}`);
      }
    }
  }

  private blockPartition(taskId: string, error: string, code = "protocol_violation"): void {
    const first = this.readMeta(`blocked:${taskId}`) === null;
    this.writeMeta(`blocked:${taskId}`, error.slice(0, 2_000));
    this.writeMeta(`blocked-code:${taskId}`, code);
    this.db.run("UPDATE outbox_events SET status = 'blocked', last_error = ? WHERE task_id = ?", [error.slice(0, 2_000), taskId]);
    if (first) {
      log.error(`outbox partition ${taskId} blocked on permanent error: ${error}`);
      this.onTaskBlocked?.(taskId, error);
    }
    this.settleDrainWaiters(taskId, "blocked");
    for (const [id, waiter] of this.recordWaiters) {
      if (waiter.taskId !== taskId) continue;
      waiter.reject(new DaemonProtocolRpcError(code, false));
      this.recordWaiters.delete(id);
    }
  }

  private nextDelivery(taskId: string): OutboxDelivery | null {
    const rows = this.db.query(
      "SELECT * FROM outbox_events WHERE task_id = ? ORDER BY id ASC LIMIT ?",
    ).all(taskId, this.deliveryBatchSize) as Array<Record<string, unknown>>;
    const firstRow = rows[0];
    if (!firstRow) return null;
    const first = toRecord(firstRow);
    if (String(firstRow.status) === "blocked") {
      return { record: first, recordIds: [first.id], blocked: true };
    }
    if (first.kind !== "messages") {
      return { record: first, recordIds: [first.id], blocked: false };
    }

    const records: MultiremiOutboxRecord[] = [];
    const messages: TaskMessageInput[] = [];
    for (const row of rows) {
      if (String(row.status) === "blocked") break;
      const record = toRecord(row);
      if (record.kind !== "messages") break;
      const recordMessages = Array.isArray(record.payload.messages)
        ? record.payload.messages as TaskMessageInput[]
        : [];
      if (records.length > 0 && messages.length + recordMessages.length > DEFAULT_TASK_MESSAGE_BATCH_COUNT) break;
      records.push(record);
      messages.push(...recordMessages);
      if (messages.length >= DEFAULT_TASK_MESSAGE_BATCH_COUNT) break;
    }

    return {
      record: {
        ...first,
        payload: { ...first.payload, messages: coalesceTaskMessages(messages) },
      },
      recordIds: records.map((record) => record.id),
      blocked: false,
    };
  }

  private deleteRecords(recordIds: number[]): void {
    if (recordIds.length === 1) {
      this.db.run("DELETE FROM outbox_events WHERE id = ?", [recordIds[0]!]);
      return;
    }
    const placeholders = recordIds.map(() => "?").join(", ");
    this.db.run(`DELETE FROM outbox_events WHERE id IN (${placeholders})`, recordIds);
  }

  /** Capacity pressure may compact only pending overwrite rows already covered by a newer row. */
  private enforceSizeCap(): void {
    const pages = this.db.query("PRAGMA page_count").get() as { page_count: number };
    const pageSize = this.db.query("PRAGMA page_size").get() as { page_size: number };
    const bytes = Number(pages.page_count) * Number(pageSize.page_size);
    if (bytes <= this.maxBytes) return;
    const dropped = Number(this.db.run(`DELETE FROM outbox_events AS old
      WHERE old.status = 'pending' AND old.kind IN ('progress', 'session_pin', 'workspace')
        AND NOT (old.kind = 'progress' AND COALESCE(json_extract(old.payload, '$.final'), 0) = 1)
        AND EXISTS (SELECT 1 FROM outbox_events AS newer WHERE newer.task_id = old.task_id
          AND newer.kind = old.kind AND newer.status = 'pending' AND newer.id > old.id)`).changes);
    if (dropped > 0) {
      const total = Number(this.readMeta("dropped_total") ?? 0) + dropped;
      this.writeMeta("dropped_total", String(total));
      log.warn(`outbox exceeded ${this.maxBytes} bytes; compacted ${dropped} covered overwrite record(s) (total dropped: ${total})`);
    }
    // SQLite can retain allocated pages after compaction; never evict reliable rows to shrink the file.
    log.warn(`outbox remains over its ${this.maxBytes} byte soft cap; retaining reliable reports`);
  }

  private readMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM outbox_meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  private writeMeta(key: string, value: string): void {
    this.db.run(
      "INSERT INTO outbox_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }
}

interface OutboxDelivery {
  record: MultiremiOutboxRecord;
  recordIds: number[];
  blocked: boolean;
}

function toRecord(row: Record<string, unknown>): MultiremiOutboxRecord {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.payload ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch {
    // A corrupt payload is delivered as empty; the server-side guards make
    // the resulting call a no-op rather than a crash loop.
  }
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    kind: String(row.kind) as MultiremiOutboxKind,
    payload,
    seq: Number(row.seq),
    terminal: Number(row.terminal ?? 0) === 1,
    attempts: Number(row.attempts ?? 0),
  };
}

/** Best-effort, last-write-wins reports: rejecting one must not dam the queue. */
const DROPPABLE_KINDS = new Set<MultiremiOutboxKind>(["progress", "session_pin", "workspace"]);

/**
 * Deterministic replays/rejections that must not stall the queue: a `start`
 * replay after the task left dispatched returns 400 (the server already has
 * it), and best-effort status reports (progress/pin/workspace) are dropped on
 * any 4xx exactly like their old fire-and-forget call sites logged-and-moved-on.
 */
function isDeliveredEquivalent(error: unknown, record: MultiremiOutboxRecord): boolean {
  if (error instanceof DaemonProtocolRpcError) return record.kind === "start" && error.code === "start_replayed";
  if (!(error instanceof MultiremiDaemonHttpError)) return false;
  if (record.kind === "start" && error.status === 400 && !record.payload.usage_run_id) return true;
  if (DROPPABLE_KINDS.has(record.kind) && error.status >= 400 && error.status < 500) {
    log.warn(`outbox dropped rejected ${record.kind} report for task ${record.taskId}: ${error.message}`);
    return true;
  }
  return false;
}

/**
 * 401/403/410 are revoked/retired authority; 404 is a deleted task; other 4xx
 * are deterministic rejections. Retrying any of them forever cannot succeed —
 * they park the queue in `blocked` with a diagnostic instead.
 */
function isPermanentDeliveryError(error: unknown): boolean {
  if (error instanceof DaemonProtocolRpcError) return !error.retryable;
  if (!(error instanceof MultiremiDaemonHttpError)) return false;
  return error.status >= 400 && error.status < 500;
}
