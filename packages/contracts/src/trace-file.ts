/**
 * Contract for trace ownership: the on-disk per-task trace file and the server
 * pointer that says whether it is readable (ADR 0006, ADR 0018).
 *
 * A trace lives only on the daemon that ran the task; the server keeps a pointer
 * and reads through the daemon. `TraceRef` is what both the page read and the
 * agent projects route on, so the pointer states are part of the wire contract.
 * The v2 event schema itself is `TraceEvent` in `./trace.js`; v1 files hold
 * fragment events of an open shape. The file validator checks only the framing
 * every line shares (`seq`, `ts`, `type`) and never redefines their fields.
 *
 * Backend-only: this module value-imports `./trace.js` (the v2 snapshot
 * validators), which the web bundle cannot resolve; the frontend reads it as
 * types only, through the contracts root.
 */

import {
  isTraceTimestamp,
  isTraceTurn,
  knownTraceItems,
  type TraceEventLine,
  type TraceItem,
  type TraceTurn,
} from "./trace.js";

/**
 * Format marker of a fragment trace (before PR 2). The daemon no longer writes
 * it; a v1 file stays readable (raw lines, `view=events`) and is never appended to.
 */
export const TRACE_FILE_FORMAT_V1 = "multiremi.trace.v1";

/**
 * Format marker of a turn + items trace (PR 2, ADR 0019). Events are
 * `TraceEvent` lines; `close()` appends snapshot framing lines before the trailer.
 */
export const TRACE_FILE_FORMAT_V2 = "multiremi.trace.v2";

/** Format marker on the first line of every trace file the daemon writes now. */
export const TRACE_FILE_FORMAT = TRACE_FILE_FORMAT_V2;

export const TRACE_FILE_FORMATS = [TRACE_FILE_FORMAT_V1, TRACE_FILE_FORMAT_V2] as const;
export type TraceFileFormat = (typeof TRACE_FILE_FORMATS)[number];

/** Short name recorded by `checkTraceFileLines`. */
export type TraceFileFormatVersion = "v1" | "v2";

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

/** First line of `<workspacesRoot>/traces/<subject>/<task_id>.jsonl` in a v1 file. */
export interface TraceFileHeader {
  format: typeof TRACE_FILE_FORMAT_V1;
  task_id: string;
  session_id: string;
  agent_id: string;
  provider: string;
  started_at: string;
  /** Persisted hot-trace ACL; older files without this field remain unowned. */
  runtime_id?: string;
}

/** First line of a v2 trace file: the v1 header with the v2 format marker. */
export interface TraceFileHeaderV2 extends Omit<TraceFileHeader, "format"> {
  format: typeof TRACE_FILE_FORMAT_V2;
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
 * This is deliberately NOT an item status (`TRACE_ITEM_STATUSES` in
 * `./trace.js`): a turn's outcome is a different vocabulary (`completed` /
 * `failed` / `cancelled`), the terminal subset of `TRACE_TURN_STATUSES`. `TraceStore.close` also narrows
 * to these three outcomes,
 * and the contract tests assert both sides stay assignable in both directions,
 * so neither can drift.
 */
export const TRACE_END_STATUSES = ["completed", "failed", "cancelled"] as const;

export type TraceEndStatus = (typeof TRACE_END_STATUSES)[number];

/** v2 trailer: the v1 block plus how many snapshot lines precede it. */
export interface TraceFileTrailerV2 {
  end: TraceFileTrailer["end"] & {
    snapshot_parts: number;
  };
}

/** Upper bound for one serialized snapshot line, so a part fits one read. */
export const TRACE_SNAPSHOT_PART_MAX_BYTES = 768 * 1024;

/**
 * v2 snapshot framing line, written by `close()` between the last event and the
 * trailer: part `part` (0-based) of `parts` of the fold at `head`. Every part
 * repeats `turn` so each line stands alone; `items` are consecutive slices in
 * fold order. Like the header and trailer it has no `seq`, so it never enters
 * the seq axis, the Live Hub or the replay budget.
 */
export interface TraceFileSnapshotLine {
  snapshot: {
    part: number;
    parts: number;
    head: number;
    turn: TraceTurn;
    items: TraceItem[];
  };
}

export interface TraceFileCheck {
  head: number;
  event_count: number;
  /** A duplicate seq or incomplete final line is recoverable for reads, but never proves closure. */
  closed: boolean;
  duplicate_seqs: number[];
  /** Which header the file carries. */
  format: TraceFileFormatVersion;
  /** Snapshot framing lines seen (always 0 for v1). */
  snapshot_parts: number;
}

export type TraceFileCheckResult =
  | { ok: true; value: TraceFileCheck }
  | { ok: false; reason: string };

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
    && isTraceTimestamp(row.ended_at);
}

/** v2 trailer: the v1 checks plus a count of snapshot lines. */
export function isTraceFileTrailerV2(value: unknown): value is TraceFileTrailerV2 {
  if (!isTraceFileTrailer(value)) return false;
  const parts = (value.end as { snapshot_parts?: unknown }).snapshot_parts;
  return Number.isSafeInteger(parts) && (parts as number) >= 0;
}

/**
 * A snapshot framing line, independent of its position in the file. Items of
 * unknown types (a newer daemon's) are dropped from `items` in place, like
 * `isTraceTurnSnapshot` does; a damaged item of a known type rejects the line.
 */
export function isTraceFileSnapshotLine(value: unknown): value is TraceFileSnapshotLine {
  if (!value || typeof value !== "object" || Array.isArray(value) || "seq" in value || "end" in value) return false;
  const snapshot = (value as { snapshot?: unknown }).snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const row = snapshot as Record<string, unknown>;
  if (!(Number.isSafeInteger(row.parts) && (row.parts as number) >= 1
    && Number.isSafeInteger(row.part) && (row.part as number) >= 0 && (row.part as number) < (row.parts as number)
    && Number.isSafeInteger(row.head) && (row.head as number) >= 0
    && isTraceTurn(row.turn))) return false;
  const items = knownTraceItems(row.items);
  if (!items) return false;
  if (items.length !== (row.items as unknown[]).length) row.items = items;
  return true;
}

/** An event line of either format: `seq >= 1`, a valid `ts` and a non-empty `type`. */
export function isTraceFileEvent(value: unknown): value is TraceEventLine {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return Number.isSafeInteger(event.seq) && (event.seq as number) >= 1
    && isTraceTimestamp(event.ts) && typeof event.type === "string" && !!event.type;
}

/**
 * Inspect complete JSONL lines without touching the filesystem. Duplicate seq
 * keeps its first event; a half line is ignored for recovery. Neither condition
 * can establish a closed trace for GC, even if a trailer is present.
 *
 * Both formats are accepted and the result records which one the header names.
 * A v2 file may carry snapshot framing lines, but only after the last event and
 * before the trailer, numbered `0..parts-1` at the events' head; its trailer must
 * count them in `snapshot_parts`. A v1 file has no snapshot lines (such a line is
 * an invalid event there, exactly as before v2 existed).
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
  const format: TraceFileFormatVersion | null = first.format === TRACE_FILE_FORMAT_V1 ? "v1"
    : first.format === TRACE_FILE_FORMAT_V2 ? "v2" : null;
  if (format === null || typeof first.task_id !== "string" || !first.task_id
    || typeof first.session_id !== "string" || !first.session_id
    || (options.taskId !== undefined && first.task_id !== options.taskId)
    || (options.sessionId !== undefined && first.session_id !== options.sessionId)
    || typeof first.agent_id !== "string" || !first.agent_id
    || typeof first.provider !== "string" || !first.provider
    || (first.runtime_id !== undefined && (typeof first.runtime_id !== "string" || !first.runtime_id))
    || !isTraceTimestamp(first.started_at) || "seq" in first) return { ok: false, reason: "invalid header" };

  let head = 0;
  let eventCount = 0;
  let closed = false;
  let snapshotParts = 0;
  let snapshotTotal: number | null = null;
  const seen = new Set<number>();
  const duplicateSeqs: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    let row: unknown;
    try { row = JSON.parse(lines[i]!); } catch { return { ok: false, reason: `invalid JSON at line ${i + 1}` }; }
    if (isTraceFileTrailer(row)) {
      if (i !== lines.length - 1) return { ok: false, reason: "trailer is not final line" };
      if (row.end.head !== head || row.end.event_count !== eventCount) return { ok: false, reason: "trailer counts disagree with events" };
      if (duplicateSeqs.length || options.incompleteTail) return { ok: false, reason: "ambiguous trailer after recovered events" };
      if (format === "v2") {
        if (!isTraceFileTrailerV2(row)) return { ok: false, reason: "v2 trailer without snapshot_parts" };
        if (row.end.snapshot_parts !== snapshotParts || (snapshotTotal !== null && snapshotTotal !== snapshotParts)) {
          return { ok: false, reason: "trailer snapshot_parts disagree with snapshot lines" };
        }
      }
      closed = true;
      continue;
    }
    if (format === "v2" && isTraceFileSnapshotLine(row)) {
      const part = row.snapshot;
      if (part.head !== head) return { ok: false, reason: `snapshot head disagrees with events at line ${i + 1}` };
      if (part.part !== snapshotParts || (snapshotTotal !== null && part.parts !== snapshotTotal)) {
        return { ok: false, reason: `snapshot part out of order at line ${i + 1}` };
      }
      snapshotTotal = part.parts;
      snapshotParts++;
      continue;
    }
    if (!isTraceFileEvent(row)) return { ok: false, reason: `invalid event at line ${i + 1}` };
    if (snapshotParts > 0) return { ok: false, reason: `event after snapshot at line ${i + 1}` };
    const seq = row.seq;
    if (seen.has(seq)) { duplicateSeqs.push(seq); continue; }
    if (seq < head) return { ok: false, reason: `out-of-order seq ${seq} at line ${i + 1}` };
    seen.add(seq);
    head = seq;
    eventCount++;
  }
  return {
    ok: true,
    value: { head, event_count: eventCount, closed, duplicate_seqs: duplicateSeqs, format, snapshot_parts: snapshotParts },
  };
}
