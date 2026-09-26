/**
 * Reverse RPC surface: reading a task's hot trace from the daemon that owns it
 * (MUL-401 §6).
 *
 * This is the only interface MUL-402 and MUL-403 call. It is deliberately one
 * method: everything else about the daemon connection - socket lookup, framing,
 * in-flight limits, timeouts - stays behind the implementation, which A-6 writes.
 *
 * Naming note: the plan text in MUL-402 called this `HotTraceSource`; the two are
 * the same object under one name. The result shape is the merged version of both
 * proposals, and MUL-402's `cursor` is this interface's `after_seq`.
 */

import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type { DaemonProtocolErrorCode } from "@multiremi/contracts/daemon-protocol.js";

export interface DaemonTraceReadRequest {
  taskId: string;
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
  /** True when the task is finished and no further events will appear. */
  ended: boolean;
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
 * - `daemon_busy`          too many concurrent reads, or the queue is full
 * - `trace_not_hot`       the daemon no longer holds this task (query the archive)
 */
export type DaemonTraceReadErrorCode = Extract<
  DaemonProtocolErrorCode,
  "daemon_unreachable" | "daemon_timeout" | "daemon_busy" | "trace_not_hot"
>;

export interface DaemonTraceReader {
  read(request: DaemonTraceReadRequest): Promise<DaemonTraceReadResult>;
}
