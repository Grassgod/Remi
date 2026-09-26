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
 * is `TraceEvent` in `./trace.js` (owned by MUL-401 / A-0); nothing here
 * references it, which keeps B and A independently buildable.
 *
 * Type-only module plus the format constant. The writer lands in B3, the archive
 * container in B4, the read routes in B5.
 */

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
    status: string;
    /** Highest allocated event seq. */
    head: number;
    event_count: number;
    ended_at: string;
  };
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
