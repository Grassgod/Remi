/**
 * Contract for trace ownership: the on-disk per-task trace file and the server
 * pointer that says whether it is readable (ADR 0006, ADR 0018).
 *
 * A trace lives only on the daemon that ran the task; the server keeps a pointer
 * and reads through the daemon. `TraceRef` is what both the page read and the
 * agent projects route on, so the pointer states are part of the wire contract.
 * The event schema itself is `TraceEvent` in `./trace.js`; the file validator
 * uses that type without redefining its event fields.
 */

import type { TraceEvent } from "./trace.js";

/** Format marker on the first line of a per-task trace file. */
export const TRACE_FILE_FORMAT = "multiremi.trace.v1";

/**
 * Where the readable copy of a task's trace is.
 *
 * - `daemon`: a file on `runtime_id`; readable only while that daemon is online.
 * - `none`: the task produced no process events at all, so there is nothing to read.
 * - `lost`: the daemon was retired or its runtime deleted; unrecoverable.
 */
export type TraceRefLocation = "daemon" | "none" | "lost";

export const TRACE_REF_LOCATIONS = ["daemon", "none", "lost"] as const;

/**
 * The wire shape of one `multiremi_task_traces` row.
 *
 * `runtime_id` names the daemon that holds the file and stays populated on
 * `lost` rows so usage accounting can still attribute the task.
 */
export interface TraceRef {
  location: TraceRefLocation;
  runtime_id: string | null;
  /** Highest event seq in the trace, from the trailer or the append stream. */
  head_seq: number | null;
  event_count: number | null;
  /** True once the trailer line exists; a hot or interrupted trace is not closed. */
  closed: boolean;
}

/** Store form of a `TraceRef`: one `multiremi_task_traces` row. */
export interface MultiremiTaskTrace {
  taskId: string;
  location: TraceRefLocation;
  runtimeId: string | null;
  eventCount: number | null;
  /** Largest event seq in the trace; null when unknown. */
  headSeq: number | null;
  /** Whether the trace was sealed; null when unknown. */
  closed: boolean | null;
  updatedAt: string;
}

/** First line of `<workspacesRoot>/traces/<subject>/<task_id>.jsonl`. */
export interface TraceFileHeader {
  format: typeof TRACE_FILE_FORMAT;
  task_id: string;
  session_id: string;
  agent_id: string;
  provider: string;
  started_at: string;
  /** Persisted hot-trace ACL; older files without this field remain unowned. */
  runtime_id?: string;
}

/**
 * Last line of the trace file, written while closing the task.
 *
 * Header and trailer carry no `seq`: they are file framing, not events. A
 * reader treats a line with an integer `seq >= 1` as an event, so the two
 * framing lines never enter the seq axis, the live stream or the trace index.
 */
export interface TraceFileTrailer {
  end: {
    status: TraceEndStatus;
    /** Highest allocated event seq. */
    head: number;
    event_count: number;
    ended_at: string;
  };
}

/**
 * The status a trailer records: how the turn that owns the trace ended.
 *
 * This is deliberately NOT `TraceEventStatus`. Event status is the ACP tool
 * lifecycle (`TRACE_EVENT_STATUSES` in `./trace.js`) and stays the sole source
 * for an event's `status` field; a turn's outcome is a different vocabulary
 * (`completed` / `failed` / `cancelled`). `TraceStore.close` also narrows
 * to these three outcomes,
 * and the contract tests assert both sides stay assignable in both directions,
 * so neither can drift.
 */
export const TRACE_END_STATUSES = ["completed", "failed", "cancelled"] as const;

export type TraceEndStatus = (typeof TRACE_END_STATUSES)[number];

export interface TraceFileCheck {
  head: number;
  event_count: number;
  /** A duplicate seq or incomplete final line is recoverable for reads, but never proves closure. */
  closed: boolean;
  duplicate_seqs: number[];
}

export type TraceFileCheckResult =
  | { ok: true; value: TraceFileCheck }
  | { ok: false; reason: string };

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return calendar.getUTCFullYear() === Number(year) && calendar.getUTCMonth() + 1 === Number(month)
    && calendar.getUTCDate() === Number(day) && Number(hour) < 24 && Number(minute) < 60
    && Number(second) < 60 && (offsetHour === undefined || (Number(offsetHour) < 24 && Number(offsetMinute) < 60));
}

/** Validate the complete framing shape, independent of event counts. */
export function isTraceFileTrailer(value: unknown): value is TraceFileTrailer {
  if (!value || typeof value !== "object" || Array.isArray(value) || "seq" in value) return false;
  const end = (value as { end?: unknown }).end;
  if (!end || typeof end !== "object" || Array.isArray(end)) return false;
  const row = end as Record<string, unknown>;
  return TRACE_END_STATUSES.includes(row.status as TraceEndStatus)
    && Number.isSafeInteger(row.head) && (row.head as number) >= 0
    && Number.isSafeInteger(row.event_count) && (row.event_count as number) >= 0
    && (row.head as number) >= (row.event_count as number)
    && validTimestamp(row.ended_at);
}

export function isTraceFileEvent(value: unknown): value is TraceEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return Number.isSafeInteger(event.seq) && (event.seq as number) >= 1
    && validTimestamp(event.ts) && typeof event.type === "string" && !!event.type;
}

/**
 * Inspect complete JSONL lines without touching the filesystem. Duplicate seq
 * keeps its first event; a half line is ignored for recovery. Neither condition
 * can establish a closed trace for GC, even if a trailer is present.
 */
export function checkTraceFileLines(
  lines: readonly string[],
  options: { taskId?: string; sessionId?: string; incompleteTail?: boolean } = {},
): TraceFileCheckResult {
  if (lines.length === 0) return { ok: false, reason: "missing complete header" };
  let header: unknown;
  try { header = JSON.parse(lines[0]!); } catch { return { ok: false, reason: "invalid header JSON" }; }
  if (!header || typeof header !== "object" || Array.isArray(header)) return { ok: false, reason: "invalid header" };
  const first = header as Record<string, unknown>;
  if (first.format !== TRACE_FILE_FORMAT || typeof first.task_id !== "string" || !first.task_id
    || typeof first.session_id !== "string" || !first.session_id
    || (options.taskId !== undefined && first.task_id !== options.taskId)
    || (options.sessionId !== undefined && first.session_id !== options.sessionId)
    || typeof first.agent_id !== "string" || !first.agent_id
    || typeof first.provider !== "string" || !first.provider
    || (first.runtime_id !== undefined && (typeof first.runtime_id !== "string" || !first.runtime_id))
    || !validTimestamp(first.started_at) || "seq" in first) return { ok: false, reason: "invalid header" };

  let head = 0;
  let eventCount = 0;
  let closed = false;
  const seen = new Set<number>();
  const duplicateSeqs: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    let row: unknown;
    try { row = JSON.parse(lines[i]!); } catch { return { ok: false, reason: `invalid JSON at line ${i + 1}` }; }
    if (isTraceFileTrailer(row)) {
      if (i !== lines.length - 1) return { ok: false, reason: "trailer is not final line" };
      if (row.end.head !== head || row.end.event_count !== eventCount) return { ok: false, reason: "trailer counts disagree with events" };
      if (duplicateSeqs.length || options.incompleteTail) return { ok: false, reason: "ambiguous trailer after recovered events" };
      closed = true;
      continue;
    }
    if (!isTraceFileEvent(row)) return { ok: false, reason: `invalid event at line ${i + 1}` };
    const seq = row.seq;
    if (seen.has(seq)) { duplicateSeqs.push(seq); continue; }
    if (seq < head) return { ok: false, reason: `out-of-order seq ${seq} at line ${i + 1}` };
    seen.add(seq);
    head = seq;
    eventCount++;
  }
  return { ok: true, value: { head, event_count: eventCount, closed, duplicate_seqs: duplicateSeqs } };
}
