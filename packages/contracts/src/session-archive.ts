/**
 * Session Archive v2 wire contract.
 *
 * The v2 container is a standard ZIP with one member per archived file plus two
 * reserved members: `manifest.json` first and `index.json` last. `index.json`
 * is the random-access table — every member records its offsets, sizes and
 * digest — so a reader that wants one task's trace reads its compressed bytes
 * and nothing else.
 *
 * `sourceRevision` hashes the content manifest (member paths, sizes, digests)
 * and therefore does not change when the compression does; the archive `sha256`
 * stays the hash of the whole blob. The GC barrier and the hard-delete barrier
 * both key on those two values, so they are unaffected by the container change.
 */

export const SESSION_ARCHIVE_V2_FORMAT = "multiremi.session-archive.v2" as const;
/** v1 tar.gz container; accepted rows stay readable, new uploads are rejected. */
export const SESSION_ARCHIVE_V1_FORMAT = "multiremi.issue-sessions.v1" as const;

export const SESSION_ARCHIVE_MANIFEST_MEMBER = "manifest.json" as const;
export const SESSION_ARCHIVE_INDEX_MEMBER = "index.json" as const;
export const SESSION_ARCHIVE_TRACES_PREFIX = "traces/" as const;
export const SESSION_ARCHIVE_TRACE_SUFFIX = ".jsonl" as const;
export const SESSION_ARCHIVE_SESSIONS_PREFIX = "sessions/" as const;

export type SessionArchiveSubjectKind = "issue" | "chat" | "task";

export interface SessionArchiveSubject {
  kind: SessionArchiveSubjectKind;
  id: string;
}

export type SessionArchiveMemberKind = "trace" | "provider" | "meta";

/**
 * One member of the archive, as recorded in `index.json`.
 *
 * A `trace` member also carries the three facts readers and pointer writes need
 * without inflating the file: `head` (the largest event seq in it),
 * `event_count` (how many events it holds) and `closed` (whether the trace was
 * sealed with a trailer). They are optional so a provider or meta member needs
 * none of them, and are required for trace members by the parser.
 */
export interface SessionArchiveMemberIndexEntry {
  path: string;
  kind: SessionArchiveMemberKind;
  /** Present for `trace` members only. */
  task_id?: string;
  /** Largest event seq in the member; 0 when it holds no events. */
  head?: number;
  event_count?: number;
  /** True when the trace file carries a trailer, i.e. the task finished. */
  closed?: boolean;
  /** Offset of the member's local file header. */
  local_header_offset: number;
  /** Offset of the member's first compressed byte. */
  data_offset: number;
  compressed_size: number;
  uncompressed_size: number;
  sha256: string;
}

/** `manifest.json`: the content manifest whose digest is `source_revision`. */
export interface SessionArchiveManifest {
  format: typeof SESSION_ARCHIVE_V2_FORMAT;
  subject: SessionArchiveSubject;
  /** Files in the content manifest, sorted by path. */
  files: Array<{ path: string; size: number; sha256: string }>;
}

/**
 * `index.json`: the member table read by ingest and by random-access readers.
 *
 * It lists every member except itself — the record for `index.json` cannot
 * contain the size of the bytes that describe it. Ingest therefore expects the
 * container to hold exactly `members.length + 1` entries.
 */
export interface SessionArchiveIndex {
  format: typeof SESSION_ARCHIVE_V2_FORMAT;
  subject: SessionArchiveSubject;
  members: SessionArchiveMemberIndexEntry[];
}

export type MultiremiTaskTraceLocation =
  | "daemon"
  | "archive"
  | "none"
  | "lost"
  | "backfilling";

/**
 * Where one task's trace can be read right now.
 *
 * This sub-order only ever writes `archive`; the other locations belong to the
 * daemon-side and retirement work in later sub-orders.
 */
export interface MultiremiTaskTrace {
  taskId: string;
  location: MultiremiTaskTraceLocation;
  runtimeId: string | null;
  archiveId: string | null;
  memberPath: string | null;
  dataOffset: number | null;
  compressedSize: number | null;
  uncompressedSize: number | null;
  sha256: string | null;
  eventCount: number | null;
  /** Largest event seq in the trace; null when unknown. */
  headSeq: number | null;
  /** Whether the trace was sealed; null when unknown. */
  closed: boolean | null;
  updatedAt: string;
}

/** Parse `manifest.json` defensively; ingest rejects anything malformed. */
export function parseSessionArchiveManifest(value: unknown): SessionArchiveManifest | null {
  if (!isRecord(value)) return null;
  if (value.format !== SESSION_ARCHIVE_V2_FORMAT) return null;
  const subject = value.subject;
  if (!isRecord(subject)) return null;
  if (subject.kind !== "issue" && subject.kind !== "chat" && subject.kind !== "task") return null;
  if (typeof subject.id !== "string" || !subject.id) return null;
  if (!Array.isArray(value.files)) return null;
  const files: SessionArchiveManifest["files"] = [];
  for (const entry of value.files) {
    if (!isRecord(entry)) return null;
    if (typeof entry.path !== "string" || !entry.path) return null;
    if (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0) return null;
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) return null;
    files.push({ path: entry.path, size: Number(entry.size), sha256: entry.sha256.toLowerCase() });
  }
  return {
    format: SESSION_ARCHIVE_V2_FORMAT,
    subject: { kind: subject.kind, id: subject.id },
    files,
  };
}

/** Parse `index.json` defensively: ingest must reject anything malformed. */
export function parseSessionArchiveIndex(value: unknown): SessionArchiveIndex | null {
  if (!isRecord(value)) return null;
  if (value.format !== SESSION_ARCHIVE_V2_FORMAT) return null;
  const subject = value.subject;
  if (!isRecord(subject)) return null;
  if (subject.kind !== "issue" && subject.kind !== "chat" && subject.kind !== "task") return null;
  if (typeof subject.id !== "string" || !subject.id) return null;
  if (!Array.isArray(value.members)) return null;
  const members: SessionArchiveMemberIndexEntry[] = [];
  for (const entry of value.members) {
    const parsed = parseSessionArchiveMember(entry);
    if (!parsed) return null;
    members.push(parsed);
  }
  return { format: SESSION_ARCHIVE_V2_FORMAT, subject: { kind: subject.kind, id: subject.id }, members };
}

export function parseSessionArchiveMember(value: unknown): SessionArchiveMemberIndexEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== "string" || !value.path) return null;
  if (value.kind !== "trace" && value.kind !== "provider" && value.kind !== "meta") return null;
  const taskId = value.task_id;
  if (taskId !== undefined && (typeof taskId !== "string" || !taskId)) return null;
  if (value.kind === "trace" && typeof taskId !== "string") return null;
  const offsets = [
    value.local_header_offset,
    value.data_offset,
    value.compressed_size,
    value.uncompressed_size,
  ];
  if (offsets.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0)) return null;
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256)) return null;
  const head = value.head;
  const eventCount = value.event_count;
  const closed = value.closed;
  if (value.kind === "trace") {
    if (!Number.isSafeInteger(head) || Number(head) < 0) return null;
    if (!Number.isSafeInteger(eventCount) || Number(eventCount) < 0) return null;
    if (typeof closed !== "boolean") return null;
  } else if (
    (head !== undefined && (!Number.isSafeInteger(head) || Number(head) < 0))
    || (eventCount !== undefined && (!Number.isSafeInteger(eventCount) || Number(eventCount) < 0))
    || (closed !== undefined && typeof closed !== "boolean")
  ) {
    return null;
  }
  return {
    path: value.path,
    kind: value.kind,
    ...(typeof taskId === "string" ? { task_id: taskId } : {}),
    ...(Number.isSafeInteger(head) ? { head: Number(head) } : {}),
    ...(Number.isSafeInteger(eventCount) ? { event_count: Number(eventCount) } : {}),
    ...(typeof closed === "boolean" ? { closed } : {}),
    local_header_offset: Number(value.local_header_offset),
    data_offset: Number(value.data_offset),
    compressed_size: Number(value.compressed_size),
    uncompressed_size: Number(value.uncompressed_size),
    sha256: value.sha256.toLowerCase(),
  };
}

/** One parsed trace line: an event when `seq` is a positive integer. */
export interface TraceLine {
  /** 1-based event seq. Null for the header and trailer lines. */
  seq: number | null;
  /** The decoded JSON object. */
  value: Record<string, unknown>;
}

/** The result of reading a trace member window. */
export interface TraceMemberWindow {
  events: Array<Record<string, unknown> & { seq: number }>;
  /** Largest seq present in the whole member; 0 when it has no events. */
  head: number;
  /** Whether the member ends with a trailer line. */
  closed: boolean;
  /** True when the window reached the end of the member. */
  complete: boolean;
  /** Count of events skipped because their seq repeats an earlier one. */
  duplicateSeqSkipped: number;
}

/**
 * Split a `traces/<task_id>.jsonl` member into lines.
 *
 * The file shape (ADR 0006): an optional first header line and an optional last
 * trailer line carry no `seq`; every event line carries a positive integer
 * `seq`. A truncated final line without a trailing newline is discarded — a
 * crash can leave a half-written append, and it is not an event.
 */
export function splitTraceMemberLines(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString("utf8");
  if (!text) return [];
  // A trailing partial line has no newline: drop it.
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return [];
  const complete = text.slice(0, lastNewline);
  return complete.length ? complete.split("\n") : [];
}

/**
 * Read a window of events out of a trace member.
 *
 * Rules fixed by the ADR and the ruling:
 * - only lines whose `seq` is an integer >= 1 count as events, so the header and
 *   trailer are skipped whatever they contain;
 * - a repeated `seq` is corruption and the *first* occurrence wins;
 * - `head` is the largest seq in the member, not the event count, because
 *   historical traces may have gaps;
 * - `closed` is true when a trailer line is present.
 */
export function readTraceMemberWindow(
  bytes: Uint8Array,
  cursor: number,
  limit: number,
): TraceMemberWindow {
  const lines = splitTraceMemberLines(bytes);
  const seen = new Set<number>();
  const events: Array<Record<string, unknown> & { seq: number }> = [];
  let head = 0;
  let duplicateSeqSkipped = 0;
  let closed = false;
  for (let index = 0; index < lines.length; index++) {
    const parsed = parseTraceLine(lines[index]!);
    if (!parsed) continue;
    if (parsed.seq === null) {
      // Header and trailer are structural, not events. Only a trailer (the last
      // line) marks the trace closed.
      if (index === lines.length - 1) closed = true;
      continue;
    }
    if (seen.has(parsed.seq)) {
      duplicateSeqSkipped++;
      continue;
    }
    seen.add(parsed.seq);
    if (parsed.seq > head) head = parsed.seq;
    events.push({ ...parsed.value, seq: parsed.seq });
  }
  const start = Math.min(cursor, events.length);
  const window = events.slice(start, start + limit);
  return {
    events: window,
    head,
    closed,
    complete: start + window.length >= events.length,
    duplicateSeqSkipped,
  };
}

function parseTraceLine(line: string): TraceLine | null {
  if (!line.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const seq = value.seq;
  // The header and trailer deliberately carry no seq; anything non-integer is
  // structural for the same reason.
  if (!Number.isSafeInteger(seq) || Number(seq) < 1) return { seq: null, value };
  return { seq: Number(seq), value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
