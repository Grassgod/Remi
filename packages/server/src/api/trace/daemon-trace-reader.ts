/**
 * Reverse RPC surface: reading a task's hot trace from the daemon that owns it
 * (MUL-401 §6).
 *
 * This is the only interface MUL-402 and MUL-403 call. It is deliberately one
 * method: everything else about the daemon connection - socket lookup, framing,
 * in-flight limits, timeouts - stays behind the implementation, which A-6 writes.
 *
 * Naming note: the plan text in MUL-402 called this `HotTraceSource`; the two are
 * the same object under one name.
 *
 * Endpoint ownership (MUL-402 ruling 4). This interface is the only hot-read path
 * the daemon exposes; A owns the RPC frames and this interface, and A-6 implements
 * it. The HTTP endpoints are NOT here:
 *
 *   - `GET /api/tasks/:id/trace` and `GET /api/shares/:token/tasks/:task_id/trace`
 *     belong to MUL-402's B5, authorized with `canUserViewTaskMessages`;
 *   - the Feishu concierge reads through the WS `trace.fetch` RPC, so there is no
 *     `GET /api/daemon/tasks/:id/trace` route to keep or delete.
 *
 * B5's trace-reader depends on this interface and maps the four codes onto its own
 * five state values; the daemon side never learns about those states.
 */

import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type { DaemonProtocolErrorCode } from "@multiremi/contracts/daemon-protocol.js";
import type { TraceStore } from "@multiremi/worker/trace-store.js";

export interface DaemonTraceReadRequest {
  taskId: string;
  /**
   * The runtime that owns the task.
   *
   * Required, and deliberately not derived from the task row: the caller already
   * holds the runtime id (B's pointer stores it), and the server routes
   * `runtimeId -> daemonId` through its own registry, so asking for the task first
   * would be an extra query on the hot path.
   */
  runtimeId: string;
  /** Exclusive cursor: the first event returned has `seq > after_seq`. */
  afterSeq?: number;
  /** Maximum events per page. Clamped to 1..500; defaults to 200. */
  limit?: number;
  /** Maximum serialized bytes per page. Defaults to 1 MiB. */
  maxBytes?: number;
  /** Per-request deadline. Defaults to 10 s. */
  timeoutMs?: number;
}

export interface DaemonTraceReadSuccess {
  ok: true;
  events: TraceEvent[];
  /** Pass back as `afterSeq` to continue. */
  next_after_seq: number;
  /** Daemon's current head for this task. */
  head: number;
  /** True when this page reached the head. */
  eof: boolean;
  /**
   * True when the trace is final. The one completeness signal on this path, taken
   * from `TraceStore.head(taskId).closed`; there is no terminator event.
   */
  closed: boolean;
}

export interface DaemonTraceReadFailure {
  ok: false;
  code: DaemonTraceReadErrorCode;
  /** Present for the errors that are about a specific runtime. */
  runtime_id?: string;
  /** ISO timestamp of the runtime's last observation, when known. */
  last_seen_at?: string;
}

export type DaemonTraceReadResult = DaemonTraceReadSuccess | DaemonTraceReadFailure;

/**
 * The error codes this RPC can fail with, drawn from the protocol's shared set.
 *
 * - `daemon_unreachable`  no live connection owns the task's runtime (page degrades)
 * - `daemon_timeout`      the daemon did not answer inside `timeoutMs`
 * - `daemon_busy`         too many concurrent reads, or the queue is full
 * - `trace_not_hot`       the daemon does not hold this task; decided by
 *                         `TraceStore.head(taskId) === null`, so a task whose
 *                         trace is closed is still hot and still readable
 */
export type DaemonTraceReadErrorCode = Extract<
  DaemonProtocolErrorCode,
  "daemon_unreachable" | "daemon_timeout" | "daemon_busy" | "trace_not_hot"
>;

export interface DaemonTraceReader {
  read(request: DaemonTraceReadRequest): Promise<DaemonTraceReadResult>;
}

/** Clamp a caller's page request the way the real implementation must. */
export const DAEMON_TRACE_READ_DEFAULT_LIMIT = 200;
export const DAEMON_TRACE_READ_MAX_LIMIT = 500;

/** Where a runtime's trace store comes from. Injectable so tests stay in memory. */
export type DaemonTraceStoreLookup = (runtimeId: string) => TraceStore | null;

/**
 * In-memory {@link DaemonTraceReader}, routing `runtimeId -> TraceStore`.
 *
 * A-0 ships this so A-6 and B5 can wire against a working reader before the socket
 * layer exists, and so the error contract is executable: an unknown runtime is
 * `daemon_unreachable`, a runtime that has never seen the task is `trace_not_hot`.
 *
 * It is not a stand-in for the transport: there is no timeout, no concurrency
 * limit and no `daemon_busy`, because those belong to the socket. A-6's real
 * implementation keeps this mapping and adds those three.
 */
export class InMemoryDaemonTraceReader implements DaemonTraceReader {
  constructor(
    private readonly lookup: DaemonTraceStoreLookup,
    /** Latest observation per runtime, used to fill `last_seen_at`. */
    private readonly lastSeenAt: (runtimeId: string) => string | null = () => null,
  ) {}

  async read(request: DaemonTraceReadRequest): Promise<DaemonTraceReadResult> {
    const store = this.lookup(request.runtimeId);
    if (!store) {
      return {
        ok: false,
        code: "daemon_unreachable",
        runtime_id: request.runtimeId,
        last_seen_at: this.lastSeenAt(request.runtimeId) ?? undefined,
      };
    }
    // A closed trace is still hot and still readable; only "never seen" is not.
    const head = store.head(request.taskId);
    if (head === null) {
      return { ok: false, code: "trace_not_hot", runtime_id: request.runtimeId };
    }

    const limit = Math.max(
      1,
      Math.min(Math.floor(request.limit ?? DAEMON_TRACE_READ_DEFAULT_LIMIT), DAEMON_TRACE_READ_MAX_LIMIT),
    );
    const page = store.read(request.taskId, request.afterSeq ?? 0, limit, request.maxBytes);
    return {
      ok: true,
      events: page.events,
      next_after_seq: page.events.at(-1)?.seq ?? request.afterSeq ?? 0,
      head: page.head,
      eof: page.eof,
      closed: head.closed,
    };
  }
}
