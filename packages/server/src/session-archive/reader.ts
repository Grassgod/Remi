/**
 * Random-access reads from a Session Archive.
 *
 * A pointer row in `multiremi_task_traces` names an archive, a member path and
 * the member's byte range, so reading one task's trace is one `pread` of the
 * compressed body plus one inflate — never a scan of the archive. The central
 * directory is only parsed at ingest and at `verify`; this module deliberately
 * does not read it.
 *
 * Bytes read per call are bounded by `compressed_size + 64 KiB`, which is what
 * the acceptance criteria measure.
 */

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MultiremiTaskTrace } from "@multiremi/contracts/session-archive.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { readZipMemberBody, sha256Hex } from "@shared/zip/reader.js";

export class SessionArchiveReadError extends Error {
  constructor(
    message: string,
    readonly code = "session_archive_read_failed",
  ) {
    super(message);
    this.name = "SessionArchiveReadError";
  }
}

export interface ReadArchiveMemberOptions {
  /** Offset of the first compressed byte, from the archive index. */
  dataOffset: number;
  /** Compressed byte count, from the archive index. */
  compressedSize: number;
  uncompressedSize?: number;
  /** When set, the inflated bytes are checked against this digest. */
  sha256?: string;
}

export interface ArchiveMemberBytes {
  bytes: Buffer;
  /** Bytes actually read from the archive; equal to the member's compressed size. */
  bytesRead: number;
}

export interface TraceLineCursor {
  /** Events from this offset onward, up to `limit` lines. */
  cursor: number;
  lines: string[];
  /** Cursor to pass to the next call; equal to `cursor` when at end of member. */
  nextCursor: number;
  /** True when the member has been fully drained. */
  complete: boolean;
}

export interface SessionArchiveReaderOptions {
  store: MultiremiStore;
  /** Archive storage root, as configured on the service. */
  root: string;
}

/**
 * Reads members out of ready archives on local disk.
 *
 * The reader resolves `archive_id` to the archive's stored path and re-verifies
 * the file identity on every open, mirroring the service's `unsafe_archive_path`
 * checks so a swapped path cannot be read through.
 */
export class SessionArchiveReader {
  constructor(private readonly options: SessionArchiveReaderOptions) {}

  /**
   * Read one member by its recorded offsets: a single `pread` of the compressed
   * body plus one inflate, with optional digest verification.
   */
  async readArchiveMember(
    archiveId: string,
    options: ReadArchiveMemberOptions,
  ): Promise<ArchiveMemberBytes> {
    const path = await this.resolveArchivePath(archiveId);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new SessionArchiveReadError("session archive is not a regular file", "unsafe_archive_path");
      }
      const member = await readZipMemberBody(handle, {
        dataOffset: options.dataOffset,
        compressedSize: options.compressedSize,
        uncompressedSize: options.uncompressedSize,
        sha256: options.sha256,
      });
      return { bytesRead: member.bytesRead };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /**
   * Read a window of JSONL lines from a trace member.
   *
   * Traces are line-oriented and append-only, so a cursor is a line index; the
   * member is inflated once per call, which is the same single `pread` as
   * {@link readArchiveMember} and keeps the read budget identical.
   */
  async readTraceLines(
    pointer: Pick<
      MultiremiTaskTrace,
      "archiveId" | "memberPath" | "dataOffset" | "compressedSize" | "uncompressedSize" | "sha256"
    >,
    cursor: number,
    limit: number,
  ): Promise<TraceLineCursor> {
    if (!pointer.archiveId) {
      throw new SessionArchiveReadError("trace pointer has no archive", "trace_pointer_incomplete");
    }
    if (pointer.dataOffset == null || pointer.compressedSize == null) {
      throw new SessionArchiveReadError("trace pointer has no byte range", "trace_pointer_incomplete");
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new SessionArchiveReadError("trace cursor must be a non-negative integer", "trace_cursor_invalid");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new SessionArchiveReadError("trace limit must be a positive integer", "trace_cursor_invalid");
    }
    const member = await this.readArchiveMember(pointer.archiveId, {
      dataOffset: pointer.dataOffset,
      compressedSize: pointer.compressedSize,
      uncompressedSize: pointer.uncompressedSize ?? undefined,
      sha256: pointer.sha256 ?? undefined,
    });
    const lines = splitLines(member.bytes);
    const start = Math.min(cursor, lines.length);
    const window = lines.slice(start, start + limit);
    const nextCursor = start + window.length;
    return {
      cursor: start,
      lines: window,
      nextCursor,
      complete: nextCursor >= lines.length,
    };
  }

  private async resolveArchivePath(archiveId: string): Promise<string> {
    const archive = this.options.store.getSessionArchive(archiveId);
    if (!archive) {
      throw new SessionArchiveReadError("session archive not found", "session_archive_not_found");
    }
    if (archive.status !== "ready") {
      throw new SessionArchiveReadError(
        `session archive is not readable in ${archive.status} state`,
        "session_archive_not_ready",
      );
    }
    const root = this.options.root;
    const path = resolve(root, archive.relativePath);
    const fromRoot = relative(root, path);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new SessionArchiveReadError("unsafe archive path", "unsafe_archive_path");
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SessionArchiveReadError("archive is not a regular file", "unsafe_archive_path");
    }
    return path;
  }
}

/** Read one member from a ready archive by id. */
export async function readArchiveMember(
  reader: SessionArchiveReader,
  archiveId: string,
  options: ReadArchiveMemberOptions,
): Promise<ArchiveMemberBytes> {
  return await reader.readArchiveMember(archiveId, options);
}

/** Split a JSONL member into lines, ignoring a trailing newline. */
export function splitLines(bytes: Buffer): string[] {
  const text = bytes.toString("utf8");
  if (!text) return [];
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed ? trimmed.split("\n") : [];
}

export { sha256Hex };
