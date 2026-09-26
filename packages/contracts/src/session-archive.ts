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

/** One member of the archive, as recorded in `index.json`. */
export interface SessionArchiveMemberIndexEntry {
  path: string;
  kind: SessionArchiveMemberKind;
  /** Present for `trace` members only. */
  task_id?: string;
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
  return {
    path: value.path,
    kind: value.kind,
    ...(typeof taskId === "string" ? { task_id: taskId } : {}),
    local_header_offset: Number(value.local_header_offset),
    data_offset: Number(value.data_offset),
    compressed_size: Number(value.compressed_size),
    uncompressed_size: Number(value.uncompressed_size),
    sha256: value.sha256.toLowerCase(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
