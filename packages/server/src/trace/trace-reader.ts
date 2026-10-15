import type { TraceEventLine, TraceEventPage, TraceItem, TraceTurnPage } from "@multiremi/contracts/trace.js";
import type { MultiremiTaskTrace } from "@multiremi/contracts/trace-file.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { DaemonTraceReader, DaemonTraceReadRequest, DaemonTraceReadResult } from "@multiremi/api/trace/daemon-trace-reader.js";

export const TRACE_READ_DEFAULT_LIMIT = 200;
export const TRACE_READ_MAX_LIMIT = 500;
export const TRACE_READ_MAX_BYTES = 1024 * 1024;

export type TraceReadState = "ok" | "unreachable" | "not_found" | "lost";

/** Where a read came from and whether it worked. When `state` is not `ok`, the page is empty. */
export interface TraceReadStatus {
  source: "daemon" | null;
  state: TraceReadState;
  reason?: string;
  retryable?: boolean;
  runtime_id?: string;
  runtime_name?: string;
  last_seen_at?: string;
}

/** `view=turn`: the running fold, the closed snapshot, or `format: "legacy"` for a v1 file. */
export type TraceTurnReadResult = TraceReadStatus & TraceTurnPage;
/** `view=events`: raw stored lines, v1 files included. */
export type TraceEventsReadResult = TraceReadStatus & TraceEventPage;
export type TraceReadResult = TraceTurnReadResult | TraceEventsReadResult;

/** A parsed route window (`parseTraceWindow`), one per view. */
export type TraceReadWindow =
  | { view: "turn"; itemCursor: number; limit: number; maxBytes?: number }
  | { view: "events"; afterSeq: number; limit: number; maxBytes?: number };

export interface TraceReaderOptions {
  store: MultiremiStore;
  daemon: DaemonTraceReader;
  /** The store's pointer repo uses an injectable query(sql, params) callback. */
  getPointer?: (taskId: string) => MultiremiTaskTrace | null;
}

type Location = Pick<TraceReadStatus, "runtime_id" | "runtime_name">;
/** A daemon request without its routing fields, kept per view. */
type ViewRequest = DaemonTraceReadRequest extends infer R ? R extends DaemonTraceReadRequest ? Omit<R, "taskId" | "runtimeId"> : never : never;
type Failure = Omit<TraceReadStatus, "state"> & { state: Exclude<TraceReadState, "ok"> };

/**
 * The server's trace read path (MUL-402 B5, PR 2 §3.4). The trace lives on the
 * daemon that ran the attempt; this resolves the pointer, reads through the
 * daemon's `trace.read` RPC and maps the outcome onto four states:
 * `ok` / `unreachable` (retryable) / `not_found` / `lost`.
 */
export class TraceReader {
  constructor(private readonly options: TraceReaderOptions) {}

  /** One `view=turn` page from `itemCursor` (an item index). */
  async readTurn(taskId: string, itemCursor = 0, limit = TRACE_READ_DEFAULT_LIMIT, maxBytes = TRACE_READ_MAX_BYTES): Promise<TraceTurnReadResult> {
    if (!Number.isSafeInteger(itemCursor) || itemCursor < 0) throw new RangeError("item_cursor must be a non-negative integer");
    const { pageLimit, byteLimit } = checkBudget(limit, maxBytes);
    const result = await this.readDaemon(taskId, { view: "turn", itemCursor, limit: pageLimit, maxBytes: byteLimit });
    if (!("ok" in result)) return { ...emptyTurnPage(), ...result };
    if (result.ok.view !== "turn") return { ...emptyTurnPage(), ...unreadable(result.location) };
    return { ...boundedTurnPage(result.ok, itemCursor, pageLimit, byteLimit), source: "daemon", state: "ok", ...result.location };
  }

  /** One `view=events` page: raw stored lines with `seq > afterSeq`. */
  async readEvents(taskId: string, afterSeq = 0, limit = TRACE_READ_DEFAULT_LIMIT, maxBytes = TRACE_READ_MAX_BYTES): Promise<TraceEventsReadResult> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new RangeError("after_seq must be a non-negative integer");
    const { pageLimit, byteLimit } = checkBudget(limit, maxBytes);
    const result = await this.readDaemon(taskId, { view: "events", afterSeq, limit: pageLimit, maxBytes: byteLimit });
    if (!("ok" in result)) return { ...emptyEventPage(afterSeq), ...result };
    if (result.ok.view !== "events") return { ...emptyEventPage(afterSeq), ...unreadable(result.location) };
    return { ...boundedEventPage(result.ok, afterSeq, byteLimit), source: "daemon", state: "ok", ...result.location };
  }

  /** The route entry point: one page of the requested view. */
  read(taskId: string, window: TraceReadWindow): Promise<TraceReadResult> {
    return window.view === "turn"
      ? this.readTurn(taskId, window.itemCursor, window.limit, window.maxBytes)
      : this.readEvents(taskId, window.afterSeq, window.limit, window.maxBytes);
  }

  private async readDaemon(
    taskId: string,
    request: ViewRequest,
  ): Promise<{ ok: TraceTurnPage | TraceEventPage; location: Location } | Failure> {
    const pointer = this.pointer(taskId);
    if (!pointer) {
      const task = this.options.store.getTask(taskId);
      const active = task && ["dispatched", "running", "waiting_local_directory", "awaiting_human"].includes(task.status);
      const runtime = task?.runtimeId ? this.options.store.getRuntime(task.runtimeId) : null;
      return {
        ...failure(active ? "unreachable" : "not_found", active ? "daemon" : null, "pointer_missing"),
        ...(active && task?.runtimeId ? {
          runtime_id: task.runtimeId,
          runtime_name: runtime?.name ?? task.runtimeId,
        } : {}),
      };
    }
    if (pointer.location === "lost") return failure("lost", null);
    if (pointer.location === "none") return failure("not_found", null, "no_events");
    if (!pointer.runtimeId) return failure("unreachable", "daemon", "runtime_missing");

    const runtime = this.options.store.getRuntime(pointer.runtimeId);
    const location = { runtime_id: pointer.runtimeId, runtime_name: runtime?.name ?? pointer.runtimeId };
    let result: DaemonTraceReadResult;
    try {
      result = await this.options.daemon.read({ ...request, taskId, runtimeId: pointer.runtimeId } as DaemonTraceReadRequest);
    } catch {
      return { ...failure("unreachable", "daemon", "daemon_read_failed"), ...location, retryable: true };
    }
    if (!result.ok) {
      if (result.code === "trace_not_hot") return { ...failure("not_found", "daemon", "trace_not_hot"), ...location };
      return {
        ...failure("unreachable", "daemon", result.code), ...location,
        last_seen_at: result.last_seen_at, retryable: true,
      };
    }
    const { ok: _ok, ...page } = result;
    return { ok: page, location };
  }

  private pointer(taskId: string): MultiremiTaskTrace | null {
    return this.options.getPointer ? this.options.getPointer(taskId) : this.options.store.getTaskTrace(taskId);
  }
}

function checkBudget(limit: number, maxBytes: number): { pageLimit: number; byteLimit: number } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
  return { pageLimit: Math.min(limit, TRACE_READ_MAX_LIMIT), byteLimit: Math.min(maxBytes, TRACE_READ_MAX_BYTES) };
}

/** A success reply that does not match the view asked for: the daemon is not readable. */
function unreadable(location: Location): Failure {
  return { ...failure("unreachable", "daemon", "daemon_read_failed"), ...location, retryable: true };
}

/**
 * Re-apply the page budget on the server: at most `limit` items and, after the
 * first, at most `maxBytes` of serialized items. Never trusts the daemon to have
 * cut the page, and never skips an item it did not return.
 */
function boundedTurnPage(page: TraceTurnPage, itemCursor: number, limit: number, maxBytes: number): TraceTurnPage {
  const items: TraceItem[] = [];
  let bytes = 2;
  for (const item of page.items) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length ? 1 : 0);
    if (items.length >= limit || (items.length > 0 && bytes + size > maxBytes)) break;
    items.push(item);
    bytes += size;
  }
  const cut = items.length < page.items.length;
  return {
    view: "turn",
    format: page.format,
    turn: page.turn,
    items,
    next_item_cursor: cut ? itemCursor + items.length : page.next_item_cursor,
    head: page.head,
    closed: page.closed,
  };
}

/** The same budget for raw lines; a single line over it is still returned alone. */
function boundedEventPage(page: TraceEventPage, afterSeq: number, maxBytes: number): TraceEventPage {
  const events: TraceEventLine[] = [];
  let bytes = 2;
  for (const event of page.events) {
    const size = Buffer.byteLength(JSON.stringify(event), "utf8") + (events.length ? 1 : 0);
    if (bytes + size > maxBytes) {
      if (!events.length) events.push(event);
      break;
    }
    events.push(event);
    bytes += size;
  }
  return {
    view: "events",
    format: page.format,
    events,
    next_after_seq: events.at(-1)?.seq ?? afterSeq,
    head: page.head,
    eof: page.eof && events.length === page.events.length,
    closed: page.closed,
  };
}

function failure(state: Exclude<TraceReadState, "ok">, source: TraceReadStatus["source"], reason?: string): Failure {
  return { source, state, ...(reason ? { reason } : {}) };
}

function emptyTurnPage(): TraceTurnPage {
  return { view: "turn", format: "v2", turn: null, items: [], next_item_cursor: null, head: 0, closed: false };
}

function emptyEventPage(afterSeq: number): TraceEventPage {
  return { view: "events", format: "v2", events: [], next_after_seq: afterSeq, head: 0, eof: true, closed: false };
}
