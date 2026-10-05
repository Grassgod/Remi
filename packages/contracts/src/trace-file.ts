/**
 * Contract for B's trace ownership: the on-disk per-task trace file, the server
 * pointer that says which copy is readable, and the archive request row that
 * asks a daemon to hand its copy over (MUL-402, message architecture v2-B;
 * ADR 0006).
 *
 * A trace has exactly one owner at a time. While hot it is a JSONL file on the
 * daemon; after archiving it lives only inside a session archive on the server
 * disk. `TraceRef` is what both the page read and the agent projects route on,
 * so the pointer states are part of the wire contract. The event schema itself
 * is `TraceEvent` in `./trace.js` (owned by MUL-401 / A-0); the file validator
 * uses that type without redefining its event fields.
 *
 * The writer lands in B3, the archive container in B4, the read routes in B5.
 */

import type { TraceEvent } from "./trace.js";

/** Format marker on the first line of a per-task trace file. */
export const TRACE_FILE_FORMAT = "multiremi.trace.v1";

/**
 * Where the readable copy of a task's trace is.
 *
 * - `daemon`: hot on `runtime_id`; readable only while that daemon is online.
 * - `archive`: a member of `archive_id`, addressed by `member_path` and offset.
 * - `none`: the task produced no process events at all, so there is nothing to read.
 * - `lost`: the daemon was retired or abandoned before archiving; unrecoverable.
 * - `backfilling`: the historical backfill has not produced the archive member yet.
 */
export type TraceRefLocation = "daemon" | "archive" | "none" | "lost" | "backfilling";

export const TRACE_REF_LOCATIONS = [
  "daemon",
  "archive",
  "none",
  "lost",
  "backfilling",
] as const;

/**
 * The wire shape of one `multiremi_task_traces` row.
 *
 * The archive fields are meaningful only for `location = "archive"`, and
 * `runtime_id` only for `location = "daemon"`; both are kept nullable rather
 * than modelled as a discriminated union because the row is written field by
 * field as the trace moves between owners.
 */
export interface TraceRef {
  location: TraceRefLocation;
  /** Daemon that holds the hot copy, for `location = "daemon"`. */
  runtime_id: string | null;
  /** Session archive row that holds the archived member, for `location = "archive"`. */
  archive_id: string | null;
  /** Member path inside the archive, e.g. `traces/<task_id>.jsonl`. */
  member_path: string | null;
  data_offset: number | null;
  compressed_size: number | null;
  uncompressed_size: number | null;
  sha256: string | null;
  /** Highest event seq in the member, from the trailer or the archive index. */
  head_seq: number | null;
  event_count: number | null;
  /** True once the trailer line exists; a hot or interrupted trace is not closed. */
  closed: boolean;
}

/** First line of `<workspacesRoot>/.runtime/<session_id>/traces/<task_id>.jsonl`. */
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
 * framing lines never enter the seq axis, the live stream or the archive index.
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

/**
 * Wire shape of one `multiremi_session_archive_requests` row (ADR 0006 Decision 8).
 *
 * The server writes a row when a session must be archived before its daemon copy
 * is deleted (daemon retirement, chat and one-shot task GC). The request travels
 * to the daemon as a typed WebSocket frame and the row follows the same states
 * here; `created_by` records the actor that asked, never a credential.
 */
export type SessionArchiveRequestStatus = "pending" | "sent" | "acked" | "completed" | "failed";

export const SESSION_ARCHIVE_REQUEST_STATUSES = [
  "pending",
  "sent",
  "acked",
  "completed",
  "failed",
] as const;

/** What a request asks a daemon to archive, matching the archive subject kinds. */
export type SessionArchiveSubjectKind = "issue" | "chat" | "task";

export const SESSION_ARCHIVE_SUBJECT_KINDS = ["issue", "chat", "task"] as const;

export interface SessionArchiveRequest {
  id: string;
  runtime_id: string;
  subject_kind: SessionArchiveSubjectKind;
  subject_id: string;
  status: SessionArchiveRequestStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}
