/**
 * Session Archive v2 fixtures for the server test suite.
 *
 * Ingest validates the container against its index, so tests can no longer
 * upload arbitrary bytes. These helpers build a real v2 archive with the same
 * writer the daemon uses and return the blob plus the control-plane values
 * (`source_revision`, `sha256`) it must be initialized with.
 */

import { createHash } from "node:crypto";
import {
  SESSION_ARCHIVE_INDEX_MEMBER,
  SESSION_ARCHIVE_MANIFEST_MEMBER,
  SESSION_ARCHIVE_TRACES_PREFIX,
  SESSION_ARCHIVE_TRACE_SUFFIX,
  SESSION_ARCHIVE_V2_FORMAT,
  type SessionArchiveIndex,
  type SessionArchiveMemberIndexEntry,
  type SessionArchiveSubject,
} from "@multiremi/contracts/session-archive.js";
import { readTraceMemberWindow } from "@multiremi/contracts/session-archive.js";
import { sessionArchiveSourceRevision } from "@shared/session-archive/source-revision.js";
import { ZipStreamWriter } from "@shared/zip/writer.js";

export interface ArchiveFixtureMember {
  path: string;
  body: Buffer;
  /** Set for trace members; the path must be `traces/<taskId>.jsonl`. */
  taskId?: string;
}

export interface ArchiveFixture {
  /**
   * The archive blob. Typed as `Uint8Array` so it can be used directly as a
   * `BodyInit` and passed to `fs.writeFile`.
   */
  bytes: Uint8Array<ArrayBuffer>;
  sourceRevision: string;
  sha256: string;
  sizeBytes: number;
  /** The index exactly as embedded, after any tamper hook ran. */
  index: SessionArchiveIndex;
  /** Inflated member bodies by path, plus the embedded `index.json`. */
  contents: Map<string, Buffer>;
}

export interface ArchiveFixtureOptions {
  subject: SessionArchiveSubject;
  /** Explicit members. Trace members need `taskId`. */
  members?: ArchiveFixtureMember[];
  /** Convenience for trace-only fixtures: task id -> JSONL body. */
  traces?: Record<string, string>;
  /**
   * Mutate the index before it is embedded. Used by the tamper tests: the
   * container is then internally inconsistent, which is exactly what ingest
   * must reject.
   */
  tamperIndex?: (index: SessionArchiveIndex) => void;
  /** Mutate a member body after the manifest digest was taken. */
  tamperMemberBody?: (path: string, body: Buffer) => Buffer;
}

/**
 * Build a trace file body in the ruled shape.
 *
 * The header line and the trailer line carry no `seq` (they are structural, not
 * events); every event carries an integer `seq` starting at 1. Passing
 * `closed: false` omits the trailer, which is what a task still running looks
 * like. `gapAfter` drops one seq so tests can prove `head` is the largest seq
 * rather than the event count.
 */
export function traceFileBody(options: {
  events: number;
  taskId?: string;
  closed?: boolean;
  /** Drop this seq (1-based) to simulate a historical gap. */
  gapAfter?: number;
}): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({
    format: "multiremi.trace.v1",
    task_id: options.taskId ?? "tsk_fixture",
    started_at: "2026-09-27T00:00:00.000Z",
  }));
  for (let seq = 1; seq <= options.events; seq++) {
    if (options.gapAfter !== undefined && seq === options.gapAfter) continue;
    lines.push(JSON.stringify({
      seq,
      ts: new Date(Date.UTC(2026, 8, 27, 0, 0, seq)).toISOString(),
      type: "execution",
      content: `event ${seq}`,
    }));
  }
  if (options.closed !== false) {
    lines.push(JSON.stringify({ status: "completed", event_count: options.events }));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `head` / `event_count` / `closed` for a trace body, using the same reader the
 * server uses so the fixture cannot disagree with ingest.
 */
function traceIndexFacts(bytes: Uint8Array): { head: number; event_count: number; closed: boolean } {
  const window = readTraceMemberWindow(bytes, 0, Number.MAX_SAFE_INTEGER);
  return { head: window.head, event_count: window.events.length, closed: window.closed };
}

export function fixtureSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build a v2 archive in memory. */
export async function buildArchiveFixture(options: ArchiveFixtureOptions): Promise<ArchiveFixture> {
  const members: ArchiveFixtureMember[] = [...(options.members ?? [])];
  for (const [taskId, body] of Object.entries(options.traces ?? {})) {
    members.push({
      path: `${SESSION_ARCHIVE_TRACES_PREFIX}${taskId}${SESSION_ARCHIVE_TRACE_SUFFIX}`,
      body: Buffer.from(body, "utf8"),
      taskId,
    });
  }
  // The manifest is the content manifest: it digests the *original* bytes, so a
  // tampered body no longer matches it.
  const manifest = {
    format: SESSION_ARCHIVE_V2_FORMAT,
    subject: options.subject,
    files: members.map((member) => ({
      path: member.path,
      size: member.body.length,
      sha256: fixtureSha256(member.body),
    })),
  };
  const sourceRevision = sessionArchiveSourceRevision(manifest);

  const written: Array<{ path: string; body: Buffer }> = [];
  const writer = new ZipStreamWriter({
    write: (chunk) => {
      written.push({ path: "", body: chunk });
    },
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writer.addBuffer(SESSION_ARCHIVE_MANIFEST_MEMBER, manifestBytes, fixtureSha256(manifestBytes));
  const contents = new Map<string, Buffer>([[SESSION_ARCHIVE_MANIFEST_MEMBER, manifestBytes]]);
  for (const member of members) {
    const body = options.tamperMemberBody?.(member.path, member.body) ?? member.body;
    await writer.addBuffer(member.path, body, fixtureSha256(body));
    contents.set(member.path, body);
  }

  const index: SessionArchiveIndex = {
    format: SESSION_ARCHIVE_V2_FORMAT,
    subject: options.subject,
    members: writer.index.map((member): SessionArchiveMemberIndexEntry => {
      const source = members.find((candidate) => candidate.path === member.path);
      const taskId = source?.taskId
        ?? (member.path.startsWith(SESSION_ARCHIVE_TRACES_PREFIX)
          ? member.path.slice(
            SESSION_ARCHIVE_TRACES_PREFIX.length,
            -SESSION_ARCHIVE_TRACE_SUFFIX.length,
          )
          : null);
      const isTrace = Boolean(source?.taskId || taskId);
      return {
        path: member.path,
        kind: isTrace
          ? "trace"
          : member.path === SESSION_ARCHIVE_MANIFEST_MEMBER ? "meta" : "provider",
        ...(taskId ? { task_id: taskId } : {}),
        // Mirrors what the daemon writer records for a trace member.
        ...(isTrace ? traceIndexFacts(contents.get(member.path) ?? Buffer.alloc(0)) : {}),
        local_header_offset: member.localHeaderOffset,
        data_offset: member.dataOffset,
        compressed_size: member.compressedSize,
        uncompressed_size: member.uncompressedSize,
        sha256: member.sha256,
      };
    }),
  };
  options.tamperIndex?.(index);
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
  await writer.addBuffer(SESSION_ARCHIVE_INDEX_MEMBER, indexBytes, fixtureSha256(indexBytes));
  await writer.finish();
  contents.set(SESSION_ARCHIVE_INDEX_MEMBER, indexBytes);

  // Copy into a fresh ArrayBuffer: a `Buffer` view is not assignable to
  // `BodyInit`, and tests hand these bytes to `fetch` bodies and `writeFile`.
  const blob = Buffer.concat(written.map((entry) => entry.body), writer.bytesWritten);
  const bytes = new Uint8Array(new ArrayBuffer(blob.length));
  bytes.set(blob);
  return {
    bytes,
    sourceRevision,
    sha256: fixtureSha256(bytes),
    sizeBytes: bytes.length,
    index,
    contents,
  };
}
