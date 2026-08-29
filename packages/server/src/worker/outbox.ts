import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "@shared/logger.js";
import { MultiremiDaemonHttpError } from "./client.js";

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
  | "fail";

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
}

export type MultiremiOutboxDrainResult = "delivered" | "blocked" | "aborted";

export interface MultiremiTaskReportOutboxOptions {
  /** SQLite file path; ":memory:" for tests. Parent directory is created. */
  path: string;
  /** Sends one record to the API; throws MultiremiDaemonHttpError on HTTP errors. */
  deliver: (record: MultiremiOutboxRecord) => Promise<void>;
  /** Bounded exponential backoff schedule; the last entry repeats. */
  backoffScheduleMs?: number[];
  /** Soft cap for the on-disk queue; oldest NON-terminal rows are dropped over it. */
  maxBytes?: number;
  /** Called once when a task's queue enters the blocked state. */
  onTaskBlocked?: (taskId: string, error: string) => void;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DISCARDED_TASK_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Durable per-task report queue. Every task-scoped API report is written here
 * first and delivered strictly in per-task seq order by a background pump, so
 * a transient API outage (restart, 5xx, network) retries with bounded backoff
 * instead of unwinding the agent's provider session. Terminal events
 * (complete/fail) are enqueued last and therefore always delivered after the
 * messages/usage that precede them; they are never dropped by the size cap.
 *
 * Permanent authority errors (401/403/410) and other deterministic 4xx stop
 * the pump for that task with a recorded diagnostic instead of retrying
 * forever. The one deliberate exception: a 400 replay of "start" means the
 * task already left dispatched — that is success, not an error.
 */
export class MultiremiTaskReportOutbox {
  private readonly db: Database;
  private readonly deliver: (record: MultiremiOutboxRecord) => Promise<void>;
  private readonly backoff: number[];
  private readonly maxBytes: number;
  private readonly onTaskBlocked: ((taskId: string, error: string) => void) | null;
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly wakes = new Map<string, () => void>();
  private readonly drainWaiters = new Map<string, Array<(result: MultiremiOutboxDrainResult) => void>>();
  private closed = false;

  constructor(options: MultiremiTaskReportOutboxOptions) {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = new Database(options.path, { create: true });
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
        discarded_at TEXT NOT NULL
      );
    `);
    this.deliver = options.deliver;
    this.backoff = options.backoffScheduleMs?.length ? options.backoffScheduleMs : DEFAULT_BACKOFF_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.onTaskBlocked = options.onTaskBlocked ?? null;
  }

  /** Persist a report and wake the task's delivery pump. Never throws on queue pressure. */
  enqueue(taskId: string, kind: MultiremiOutboxKind, payload: Record<string, unknown>): void {
    if (this.closed) throw new Error("outbox is closed");
    const terminal = TERMINAL_KINDS.has(kind);
    const discarded = this.db.query(
      "SELECT keep_terminal FROM outbox_discarded_tasks WHERE task_id = ?",
    ).get(taskId) as { keep_terminal: number } | null;
    if (discarded && !(Number(discarded.keep_terminal) === 1 && terminal)) {
      const total = Number(this.readMeta("dropped_total") ?? 0) + 1;
      this.writeMeta("dropped_total", String(total));
      log.debug(`outbox discarded ${kind} report for tombstoned task ${taskId}`);
      return;
    }
    const seqRow = this.db.query(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM outbox_events WHERE task_id = ?",
    ).get(taskId) as { seq: number };
    const seq = Number(seqRow.seq) + 1;
    this.db.run(
      `INSERT INTO outbox_events (idempotency_key, task_id, kind, payload, seq, terminal, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [`${taskId}:${kind}:${seq}`, taskId, kind, JSON.stringify(payload), seq, terminal ? 1 : 0, new Date().toISOString()],
    );
    this.enforceSizeCap();
    this.ensurePump(taskId);
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

  taskIdsWithPendingTerminal(): string[] {
    const rows = this.db.query(
      "SELECT DISTINCT task_id FROM outbox_events WHERE status = 'pending' AND terminal = 1",
    ).all() as Array<{ task_id: string }>;
    return rows.map((row) => String(row.task_id));
  }

  /**
   * Discard reports that no longer have server-side value and prevent future
   * producers from recreating them. A terminal-only tombstone is useful when
   * callers still need to preserve a completion/failure report.
   */
  purgeTask(taskId: string, options: { keepTerminal?: boolean } = {}): number {
    if (this.closed) return 0;
    const keepTerminal = options.keepTerminal === true;
    const discardedAt = new Date().toISOString();
    const cutoff = new Date(Date.now() - DISCARDED_TASK_TTL_MS).toISOString();
    const purge = this.db.transaction(() => {
      this.db.run("DELETE FROM outbox_discarded_tasks WHERE discarded_at < ?", [cutoff]);
      this.db.run(
        `INSERT INTO outbox_discarded_tasks (task_id, keep_terminal, discarded_at)
         VALUES (?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           keep_terminal = MIN(outbox_discarded_tasks.keep_terminal, excluded.keep_terminal),
           discarded_at = excluded.discarded_at`,
        [taskId, keepTerminal ? 1 : 0, discardedAt],
      );
      const tombstone = this.db.query(
        "SELECT keep_terminal FROM outbox_discarded_tasks WHERE task_id = ?",
      ).get(taskId) as { keep_terminal: number };
      const result = Number(tombstone.keep_terminal) === 1
        ? this.db.run("DELETE FROM outbox_events WHERE task_id = ? AND terminal = 0", [taskId])
        : this.db.run("DELETE FROM outbox_events WHERE task_id = ?", [taskId]);
      return Number(result.changes);
    });
    const purged = purge();

    // The pump may be in retry backoff, and drain waiters otherwise only settle
    // from ensurePump().finally(). Re-evaluate both immediately after deletion.
    this.wakes.get(taskId)?.();
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
    return {
      pending: Number(pending.n),
      pendingNonTerminal: Number(pending.n) - Number(pendingTerminal.n),
      blocked: Number(blocked.n),
      pendingTerminal: Number(pendingTerminal.n),
      pendingTasks: Number(pendingTasks.n),
      oldestPendingCreatedAt: oldest.at ?? null,
      droppedTotal: Number(this.readMeta("dropped_total") ?? 0),
      fileBytes: Number(pages.page_count) * Number(pageSize.page_size),
    };
  }

  /** Wake every pending pump without waiting (fire-and-forget delivery). */
  pumpAll(): void {
    for (const taskId of this.pendingTaskIds()) this.ensurePump(taskId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const wake of this.wakes.values()) wake();
    await Promise.allSettled([...this.pumps.values()]);
    for (const [taskId] of this.drainWaiters) this.settleDrainWaiters(taskId, "aborted");
    this.db.close();
  }

  private taskDrainState(taskId: string): MultiremiOutboxDrainResult | null {
    if (this.closed) return "aborted";
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
    if (this.closed) return;
    if (this.pumps.has(taskId)) {
      this.wakes.get(taskId)?.();
      return;
    }
    const run = this.runPump(taskId)
      .catch((error) => {
        log.error(`outbox pump for ${taskId} crashed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.pumps.delete(taskId);
        this.wakes.delete(taskId);
        const state = this.taskDrainState(taskId);
        if (state) this.settleDrainWaiters(taskId, state);
        // New rows may have raced the pump teardown; restart if so.
        else this.ensurePump(taskId);
      });
    this.pumps.set(taskId, run);
  }

  private async runPump(taskId: string): Promise<void> {
    while (!this.closed) {
      const row = this.db.query(
        "SELECT * FROM outbox_events WHERE task_id = ? ORDER BY seq ASC LIMIT 1",
      ).get(taskId) as Record<string, unknown> | null;
      if (!row) return;
      if (String(row.status) === "blocked") return;
      const record = toRecord(row);
      try {
        await this.deliver(record);
        this.db.run("DELETE FROM outbox_events WHERE id = ?", [record.id]);
      } catch (error) {
        if (isDeliveredEquivalent(error, record)) {
          this.db.run("DELETE FROM outbox_events WHERE id = ?", [record.id]);
          continue;
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
          if (Number(blocked.changes) === 0) continue;
          log.error(`outbox for task ${taskId} blocked on permanent error: ${message}`);
          this.onTaskBlocked?.(taskId, message);
          this.settleDrainWaiters(taskId, "blocked");
          return;
        }
        const attempts = record.attempts + 1;
        const delay = this.backoff[Math.min(attempts - 1, this.backoff.length - 1)]!;
        const updated = this.db.run(
          "UPDATE outbox_events SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
          [attempts, Date.now() + delay, message.slice(0, 2_000), record.id],
        );
        if (Number(updated.changes) === 0) continue;
        if (attempts === 1 || attempts % 10 === 0) {
          log.warn(`outbox delivery for task ${taskId} (${record.kind} seq ${record.seq}) failed, retrying in ${delay}ms: ${message}`);
        }
        await this.sleepWithWake(taskId, record.id, delay);
      }
    }
  }

  private async sleepWithWake(taskId: string, recordId: number, ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.wakes.get(taskId) === finish) this.wakes.delete(taskId);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      // unref keeps a retrying pump from pinning the process open after stop().
      (timer as unknown as { unref?: () => void }).unref?.();
      this.wakes.set(taskId, finish);
      // Close the tiny purge-before-wake-registration race: once the wake is
      // installed, a missing record means there is no backoff left to observe.
      const row = this.db.query("SELECT 1 AS present FROM outbox_events WHERE id = ?").get(recordId);
      if (!row) finish();
    });
  }

  /**
   * Drop the oldest NON-terminal pending rows when the file outgrows maxBytes.
   * Terminal events are never dropped — losing one would strand the task in
   * `running` forever, which is exactly what this queue exists to prevent.
   */
  private enforceSizeCap(): void {
    const pages = this.db.query("PRAGMA page_count").get() as { page_count: number };
    const pageSize = this.db.query("PRAGMA page_size").get() as { page_size: number };
    let bytes = Number(pages.page_count) * Number(pageSize.page_size);
    if (bytes <= this.maxBytes) return;
    let dropped = 0;
    while (bytes > this.maxBytes) {
      const victim = this.db.query(
        "SELECT id, length(payload) AS bytes FROM outbox_events WHERE terminal = 0 ORDER BY id ASC LIMIT 1",
      ).get() as { id: number; bytes: number } | null;
      if (!victim) break;
      this.db.run("DELETE FROM outbox_events WHERE id = ?", [victim.id]);
      dropped += 1;
      bytes -= Number(victim.bytes);
    }
    if (dropped > 0) {
      const total = Number(this.readMeta("dropped_total") ?? 0) + dropped;
      this.writeMeta("dropped_total", String(total));
      log.warn(`outbox exceeded ${this.maxBytes} bytes; dropped ${dropped} oldest non-terminal record(s) (total dropped: ${total})`);
    }
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
  if (!(error instanceof MultiremiDaemonHttpError)) return false;
  if (record.kind === "start" && error.status === 400) return true;
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
  if (!(error instanceof MultiremiDaemonHttpError)) return false;
  return error.status >= 400 && error.status < 500;
}
