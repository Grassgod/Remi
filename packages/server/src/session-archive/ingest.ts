/**
 * Ingest-time validation for Session Archive v2.
 *
 * Order matters and mirrors the acceptance criteria:
 *
 * 1. hash the whole blob and compare it with the declared `sha256` (the
 *    existing integrity gate, unchanged);
 * 2. parse the ZIP central directory;
 * 3. read `manifest.json` and `index.json` out of the archive and cross-check
 *    every member against the central directory — path, uncompressed size,
 *    compressed size and data offset;
 * 4. verify each member's recorded sha256 against its actual bytes.
 *
 * Any mismatch raises {@link SessionArchiveIngestError}; the caller marks the
 * row `failed` with the message, so a tampered index can never reach `ready`
 * and can never produce trace pointers.
 */

import type { FileHandle } from "node:fs/promises";
import {
  SESSION_ARCHIVE_INDEX_MEMBER,
  SESSION_ARCHIVE_MANIFEST_MEMBER,
  parseSessionArchiveIndex,
  parseSessionArchiveManifest,
  type SessionArchiveIndex,
  type SessionArchiveMemberIndexEntry,
} from "@multiremi/contracts/session-archive.js";
import { readZipCentralDirectory, readZipMember } from "@shared/zip/reader.js";
import { sessionArchiveSourceRevision } from "@shared/session-archive/source-revision.js";

export class SessionArchiveIngestError extends Error {
  constructor(message: string, readonly code = "session_archive_ingest_invalid") {
    super(message);
    this.name = "SessionArchiveIngestError";
  }
}

export interface ArchiveIngestVerification {
  index: SessionArchiveIndex;
  /** Trace members in the order the index lists them. */
  traces: SessionArchiveMemberIndexEntry[];
  /** Members whose sha256 was recomputed during validation. */
  /** Members whose digest was recomputed; every listed member. */
  verifiedMembers: number;
  /** Digest of the content manifest, which must equal the row's source_revision. */
  sourceRevision: string;
  bytesRead: number;
}

export interface VerifyArchiveIngestOptions {
  /** Total member budget; prevents a hostile index from forcing unbounded reads. */
  maxMembers?: number;
}

const DEFAULT_MAX_MEMBERS = 200_000;

/**
 * Validate a finished v2 archive against its own index.
 *
 * The caller has already checked the blob hash; this function then reads every
 * member the index lists and verifies its recorded digest, and cross-checks the
 * manifest's file list against both the index and the container. A blob digest
 * only proves the bytes are the ones the uploader declared; it says nothing
 * about whether the index, the manifest and the members agree with each other.
 */
export async function verifyArchiveIngest(
  handle: FileHandle,
  options: VerifyArchiveIngestOptions = {},
): Promise<ArchiveIngestVerification> {
  const central = await readZipCentralDirectory(handle);
  const maxMembers = options.maxMembers ?? DEFAULT_MAX_MEMBERS;
  if (central.entries.length > maxMembers) {
    throw new SessionArchiveIngestError(
      `archive has ${central.entries.length} members, above the ${maxMembers} limit`,
    );
  }
  const byPath = new Map(central.entries.map((entry) => [entry.path, entry]));

  const indexEntry = byPath.get(SESSION_ARCHIVE_INDEX_MEMBER);
  if (!indexEntry) {
    throw new SessionArchiveIngestError("archive is missing index.json");
  }
  const indexBytes = await readZipMember(handle, {
    localHeaderOffset: indexEntry.localHeaderOffset,
    compressedSize: indexEntry.compressedSize,
    uncompressedSize: indexEntry.uncompressedSize,
  });
  const parsedIndex = parseSessionArchiveIndex(parseJson(indexBytes.bytes, SESSION_ARCHIVE_INDEX_MEMBER));
  if (!parsedIndex) {
    throw new SessionArchiveIngestError("archive index.json is not a valid v2 index");
  }
  const manifestEntry = byPath.get(SESSION_ARCHIVE_MANIFEST_MEMBER);
  if (!manifestEntry) {
    throw new SessionArchiveIngestError("archive is missing manifest.json");
  }
  const manifestBytes = await readZipMember(handle, {
    localHeaderOffset: manifestEntry.localHeaderOffset,
    compressedSize: manifestEntry.compressedSize,
    uncompressedSize: manifestEntry.uncompressedSize,
  });
  const manifest = parseSessionArchiveManifest(
    parseJson(manifestBytes.bytes, SESSION_ARCHIVE_MANIFEST_MEMBER),
  );
  if (!manifest) {
    throw new SessionArchiveIngestError("archive manifest.json is not a valid v2 manifest");
  }
  if (
    manifest.subject.kind !== parsedIndex.subject.kind
    || manifest.subject.id !== parsedIndex.subject.id
  ) {
    throw new SessionArchiveIngestError(
      "archive manifest and index disagree on the subject",
    );
  }

  const seen = new Set<string>();
  let bytesRead = central.bytesRead + indexBytes.bytesRead + manifestBytes.bytesRead;
  const traces: SessionArchiveMemberIndexEntry[] = [];
  for (const member of parsedIndex.members) {
    if (seen.has(member.path)) {
      throw new SessionArchiveIngestError(`archive index lists ${member.path} more than once`);
    }
    seen.add(member.path);
    const actual = byPath.get(member.path);
    if (!actual) {
      throw new SessionArchiveIngestError(`archive index references a member the ZIP does not contain: ${member.path}`);
    }
    if (actual.uncompressedSize !== member.uncompressed_size) {
      throw new SessionArchiveIngestError(
        `member ${member.path} uncompressed size mismatch: index ${member.uncompressed_size}, ZIP ${actual.uncompressedSize}`,
      );
    }
    if (actual.compressedSize !== member.compressed_size) {
      throw new SessionArchiveIngestError(
        `member ${member.path} compressed size mismatch: index ${member.compressed_size}, ZIP ${actual.compressedSize}`,
      );
    }
    if (actual.localHeaderOffset !== member.local_header_offset) {
      throw new SessionArchiveIngestError(
        `member ${member.path} offset mismatch: index ${member.local_header_offset}, ZIP ${actual.localHeaderOffset}`,
      );
    }
    if (actual.dataOffset !== member.data_offset) {
      throw new SessionArchiveIngestError(
        `member ${member.path} data offset mismatch: index ${member.data_offset}, ZIP ${actual.dataOffset}`,
      );
    }
    if (member.kind === "trace") traces.push(member);
    // Every listed member is verified, not only the traces: the blob digest a
    // daemon declares proves nothing about whether the index and the members
    // agree, and a provider member is just as load-bearing as a trace one.
    const read = await readZipMember(handle, {
      localHeaderOffset: member.local_header_offset,
      compressedSize: member.compressed_size,
      uncompressedSize: member.uncompressed_size,
      sha256: member.sha256,
    });
    bytesRead += read.bytesRead;
    if (read.path !== member.path) {
      throw new SessionArchiveIngestError(
        `member name mismatch: index ${member.path}, ZIP ${read.path}`,
      );
    }
  }
  // `index.json` is the one member the index cannot describe: its own bytes
  // depend on the offsets it records. Every other member must be listed, and
  // nothing extra may appear in the container.
  if (seen.has(SESSION_ARCHIVE_INDEX_MEMBER)) {
    throw new SessionArchiveIngestError("archive index lists index.json itself");
  }
  const expectedMembers = parsedIndex.members.length + 1;
  if (byPath.size !== expectedMembers) {
    throw new SessionArchiveIngestError(
      `archive contains ${byPath.size} members but the index plus index.json implies ${expectedMembers}`,
    );
  }

  // The manifest is the content manifest whose digest becomes source_revision,
  // so it has to describe exactly the members that exist. A manifest that omits
  // a member, or lists one the container does not hold, would make the revision
  // describe something other than the archive it labels.
  const manifestFiles = new Map(manifest.files.map((file) => [file.path, file]));
  if (manifestFiles.size !== manifest.files.length) {
    throw new SessionArchiveIngestError("archive manifest lists the same file twice");
  }
  for (const member of parsedIndex.members) {
    // `manifest.json` describes the content files, not itself: its own record
    // cannot carry the digest of the bytes that contain it.
    if (member.path === SESSION_ARCHIVE_MANIFEST_MEMBER) continue;
    const listed = manifestFiles.get(member.path);
    if (!listed) {
      throw new SessionArchiveIngestError(
        `archive manifest does not list member ${member.path}`,
      );
    }
    if (listed.size !== member.uncompressed_size || listed.sha256 !== member.sha256) {
      throw new SessionArchiveIngestError(
        `member ${member.path} disagrees with the manifest: `
        + `manifest ${listed.size}/${listed.sha256}, index ${member.uncompressed_size}/${member.sha256}`,
      );
    }
    manifestFiles.delete(member.path);
  }
  // The manifest lists every content member and nothing else: not itself and not
  // the index, because neither can carry its own digest.
  for (const selfDescribing of [SESSION_ARCHIVE_MANIFEST_MEMBER, SESSION_ARCHIVE_INDEX_MEMBER]) {
    if (manifestFiles.has(selfDescribing)) {
      throw new SessionArchiveIngestError(`archive manifest lists ${selfDescribing} itself`);
    }
  }
  const listedContent = parsedIndex.members.filter(
    (member) => member.path !== SESSION_ARCHIVE_MANIFEST_MEMBER,
  ).length;
  if (manifest.files.length !== listedContent) {
    throw new SessionArchiveIngestError(
      `archive manifest lists ${manifest.files.length} files but the index lists `
      + `${listedContent} content members`,
    );
  }
  return {
    index: parsedIndex,
    traces,
    verifiedMembers: parsedIndex.members.length,
    sourceRevision: sessionArchiveSourceRevision(manifest),
    bytesRead,
  };
}


function parseJson(bytes: Buffer, member: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SessionArchiveIngestError(`archive member ${member} is not valid JSON`);
  }
}
