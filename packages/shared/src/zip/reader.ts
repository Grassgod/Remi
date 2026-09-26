/**
 * Random-access ZIP reader for Session Archive v2.
 *
 * Two distinct jobs, on purpose:
 *
 * - {@link readZipCentralDirectory} walks the end-of-central-directory record
 *   and the central directory to produce one entry per member. Ingest and
 *   `verify` use it to cross-check `index.json`; nothing else needs it.
 * - {@link readZipMember} reads exactly one member: one `pread` for the local
 *   header and one for the compressed body, then inflate. It never touches the
 *   central directory, which is what makes reading a single task's trace cost
 *   `compressed_size` bytes instead of the whole archive.
 */

import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import {
  ZIP_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP_DEFLATE_METHOD,
  ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP_LOCAL_HEADER_SIGNATURE,
  ZIP_STORED_METHOD,
  ZIP_UINT16_MAX,
  ZIP_UINT32_MAX,
  ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE,
  ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP64_EXTRA_FIELD_ID,
  findSignatureBackwards,
  readZip64ExtraField,
} from "./format.js";

/** How much of the archive tail can hold the end-of-central-directory records. */
const EOCD_SEARCH_BYTES = 22 + 64 * 1024 + 8;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_RECORD_SIZE = 56;
/** Upper bound on a local header read; keeps the single-member budget honest. */
export const ZIP_MAX_LOCAL_HEADER_BYTES = 64 * 1024;

export interface ZipDirectoryEntry {
  path: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the member's local file header. */
  localHeaderOffset: number;
  /** Offset of the first compressed byte, derived from the local header. */
  dataOffset: number;
}

export interface ZipCentralDirectory {
  entries: ZipDirectoryEntry[];
  entryCount: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  /** Total bytes read from the file while parsing the directory. */
  bytesRead: number;
}

export interface ReadZipMemberOptions {
  /** Offset of the member's local header. */
  localHeaderOffset: number;
  /** Compressed byte count, normally taken from the archive index. */
  compressedSize: number;
  /** Uncompressed byte count, checked after inflate when supplied. */
  uncompressedSize?: number;
  /** Expected SHA-256 of the uncompressed bytes; verified when supplied. */
  sha256?: string;
}

export interface ReadZipMemberResult {
  /** Member path recorded in the local header. */
  path: string;
  bytes: Buffer;
  /** Bytes actually read from the archive, including the local header. */
  bytesRead: number;
}

export interface ReadZipMemberBodyOptions {
  /** Offset of the first compressed byte, from the archive index. */
  dataOffset: number;
  /** Compressed byte count, from the archive index. */
  compressedSize: number;
  /** Uncompressed byte count, checked after inflate when supplied. */
  uncompressedSize?: number;
  /** Expected SHA-256 of the uncompressed bytes; verified when supplied. */
  sha256?: string;
  /** Compression method; the v2 writer always uses deflate. */
  method?: number;
}

export interface ReadZipMemberBodyResult {
  bytes: Buffer;
  /** Bytes actually read from the archive. Exactly `compressedSize`. */
  bytesRead: number;
}

/**
 * Read one member body straight from its index entry: one `pread`, one inflate.
 *
 * This is the hot path — `readArchiveMember(archive_id, data_offset,
 * compressed_size)` — and it deliberately never reads the local header or the
 * central directory, so the cost of reading one task's trace is its compressed
 * size in bytes and nothing else.
 */
export async function readZipMemberBody(
  handle: FileHandle,
  options: ReadZipMemberBodyOptions,
): Promise<ReadZipMemberBodyResult> {
  if (!Number.isSafeInteger(options.dataOffset) || options.dataOffset < 0) {
    throw new Error(`Invalid ZIP member data offset: ${options.dataOffset}`);
  }
  if (!Number.isSafeInteger(options.compressedSize) || options.compressedSize < 0) {
    throw new Error(`Invalid ZIP member compressed size: ${options.compressedSize}`);
  }
  const compressed = await readExactly(handle, options.compressedSize, options.dataOffset);
  if (compressed.length !== options.compressedSize) {
    throw new Error(
      `ZIP member is truncated: expected ${options.compressedSize} compressed bytes, read ${compressed.length}`,
    );
  }
  const method = options.method ?? ZIP_DEFLATE_METHOD;
  const bytes = method === ZIP_STORED_METHOD
    ? compressed
    : method === ZIP_DEFLATE_METHOD
      ? inflateRawSync(compressed)
      : (() => { throw new Error(`Unsupported ZIP compression method: ${method}`); })();
  if (options.uncompressedSize !== undefined && bytes.length !== options.uncompressedSize) {
    throw new Error(
      `ZIP member size mismatch: expected ${options.uncompressedSize} bytes, got ${bytes.length}`,
    );
  }
  if (options.sha256 && sha256Hex(bytes) !== options.sha256) {
    throw new Error("ZIP member sha256 mismatch");
  }
  return { bytes, bytesRead: compressed.length };
}

/**
 * Read one member through its local header: two `pread`s plus one inflate.
 *
 * Used where the caller knows only the local header offset (ingest, `verify`).
 * The header read is bounded by {@link ZIP_MAX_LOCAL_HEADER_BYTES}, so the cost
 * is `compressed_size + 64 KiB` at worst. Hot-path readers use
 * {@link readZipMemberBody}, which skips the header entirely.
 */
export async function readZipMember(
  handle: FileHandle,
  options: ReadZipMemberOptions,
): Promise<ReadZipMemberResult> {
  if (!Number.isSafeInteger(options.localHeaderOffset) || options.localHeaderOffset < 0) {
    throw new Error(`Invalid ZIP member local header offset: ${options.localHeaderOffset}`);
  }
  if (!Number.isSafeInteger(options.compressedSize) || options.compressedSize < 0) {
    throw new Error(`Invalid ZIP member compressed size: ${options.compressedSize}`);
  }

  const headerFixed = await readExactly(handle, 30, options.localHeaderOffset);
  if (headerFixed.length < 30 || headerFixed.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIGNATURE) {
    throw new Error(`Invalid ZIP local header at offset ${options.localHeaderOffset}`);
  }
  const nameLength = headerFixed.readUInt16LE(26);
  const extraLength = headerFixed.readUInt16LE(28);
  const variableLength = nameLength + extraLength;
  if (variableLength > ZIP_MAX_LOCAL_HEADER_BYTES) {
    throw new Error(`ZIP local header is implausibly large: ${variableLength} bytes`);
  }
  const variable = variableLength
    ? await readExactly(handle, variableLength, options.localHeaderOffset + 30)
    : Buffer.alloc(0);
  const path = variable.subarray(0, nameLength).toString("utf8");
  const method = headerFixed.readUInt16LE(8);
  const dataOffset = options.localHeaderOffset + 30 + variableLength;

  const compressed = await readExactly(handle, options.compressedSize, dataOffset);
  if (compressed.length !== options.compressedSize) {
    throw new Error(
      `ZIP member is truncated: expected ${options.compressedSize} compressed bytes, read ${compressed.length}`,
    );
  }
  const bytes = method === ZIP_STORED_METHOD
    ? compressed
    : method === ZIP_DEFLATE_METHOD
      ? inflateRawSync(compressed)
      : (() => { throw new Error(`Unsupported ZIP compression method: ${method}`); })();
  if (options.uncompressedSize !== undefined && bytes.length !== options.uncompressedSize) {
    throw new Error(
      `ZIP member size mismatch: expected ${options.uncompressedSize} bytes, got ${bytes.length}`,
    );
  }
  if (options.sha256 && sha256Hex(bytes) !== options.sha256) {
    throw new Error("ZIP member sha256 mismatch");
  }
  return { path, bytes, bytesRead: 30 + variableLength + compressed.length };
}

/**
 * Parse the central directory.
 *
 * This is the only reader that walks the archive tail; per-member reads go
 * through {@link readZipMember} and stay at one seek.
 */
export async function readZipCentralDirectory(handle: FileHandle): Promise<ZipCentralDirectory> {
  const size = (await handle.stat()).size;
  if (!Number.isSafeInteger(size) || size < 22) {
    throw new Error("ZIP archive is too small to contain an end-of-central-directory record");
  }
  const tailLength = Math.min(size, EOCD_SEARCH_BYTES);
  const tailStart = size - tailLength;
  const tail = await readExactly(handle, tailLength, tailStart);
  let bytesRead = tail.length;
  const eocdOffset = findSignatureBackwards(tail, ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  if (eocdOffset < 0 || eocdOffset + 22 > tail.length) {
    throw new Error("ZIP archive has no end-of-central-directory record");
  }
  let entryCount = tail.readUInt16LE(eocdOffset + 10);
  let centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
  let centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);

  if (
    entryCount === ZIP_UINT16_MAX
    || centralDirectorySize === ZIP_UINT32_MAX
    || centralDirectoryOffset === ZIP_UINT32_MAX
  ) {
    const locatorOffset = findSignatureBackwards(
      tail.subarray(0, eocdOffset),
      ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE,
    );
    if (locatorOffset < 0 || locatorOffset + ZIP64_LOCATOR_SIZE > tail.length) {
      throw new Error("ZIP64 archive is missing its end-of-central-directory locator");
    }
    const recordOffset = Number(tail.readBigUInt64LE(locatorOffset + 8));
    const inTail = recordOffset >= tailStart && recordOffset + ZIP64_RECORD_SIZE <= size;
    const record = inTail
      ? tail.subarray(recordOffset - tailStart, recordOffset - tailStart + ZIP64_RECORD_SIZE)
      : await readExactly(handle, ZIP64_RECORD_SIZE, recordOffset);
    if (!inTail) bytesRead += record.length;
    if (record.length < ZIP64_RECORD_SIZE
      || record.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("ZIP64 end-of-central-directory record is missing");
    }
    entryCount = Number(record.readBigUInt64LE(32));
    centralDirectorySize = Number(record.readBigUInt64LE(40));
    centralDirectoryOffset = Number(record.readBigUInt64LE(48));
  }

  if (!Number.isSafeInteger(centralDirectorySize) || !Number.isSafeInteger(centralDirectoryOffset)) {
    throw new Error("ZIP central directory is beyond this platform's offset range");
  }
  if (centralDirectoryOffset + centralDirectorySize > size) {
    throw new Error("ZIP central directory extends past the end of the archive");
  }
  const directory = await readExactly(handle, centralDirectorySize, centralDirectoryOffset);
  bytesRead += directory.length;
  const entries: ZipDirectoryEntry[] = [];
  let cursor = 0;
  while (cursor + 46 <= directory.length) {
    if (directory.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) break;
    const flags = directory.readUInt16LE(cursor + 8);
    const method = directory.readUInt16LE(cursor + 10);
    const crc = directory.readUInt32LE(cursor + 16);
    let compressedSize = directory.readUInt32LE(cursor + 20);
    let uncompressedSize = directory.readUInt32LE(cursor + 24);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    let localHeaderOffset = directory.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    const extraEnd = nameEnd + extraLength;
    if (extraEnd + commentLength > directory.length) {
      throw new Error("ZIP central directory entry is truncated");
    }
    const path = directory.subarray(nameStart, nameEnd).toString("utf8");
    const extra = directory.subarray(nameEnd, extraEnd);
    if (
      uncompressedSize === ZIP_UINT32_MAX
      || compressedSize === ZIP_UINT32_MAX
      || localHeaderOffset === ZIP_UINT32_MAX
      || hasZip64Field(extra)
    ) {
      const zip64 = readZip64ExtraField(extra);
      if (uncompressedSize === ZIP_UINT32_MAX && zip64.uncompressedSize !== null) {
        uncompressedSize = Number(zip64.uncompressedSize);
      }
      if (compressedSize === ZIP_UINT32_MAX && zip64.compressedSize !== null) {
        compressedSize = Number(zip64.compressedSize);
      }
      if (localHeaderOffset === ZIP_UINT32_MAX && zip64.localHeaderOffset !== null) {
        localHeaderOffset = Number(zip64.localHeaderOffset);
      }
    }
    // Data offset is derived from the local header's variable-length fields so
    // callers never have to trust a stored value that the archive could omit.
    const localFixed = await readExactly(handle, 30, localHeaderOffset);
    bytesRead += localFixed.length;
    if (localFixed.length < 30 || localFixed.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIGNATURE) {
      throw new Error(`ZIP entry ${path} has no local file header at ${localHeaderOffset}`);
    }
    const dataOffset = localHeaderOffset + 30 + localFixed.readUInt16LE(26) + localFixed.readUInt16LE(28);
    entries.push({
      path, method, flags, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset, dataOffset,
    });
    cursor = extraEnd + commentLength;
  }
  if (entries.length !== entryCount) {
    throw new Error(
      `ZIP central directory entry count mismatch: header says ${entryCount}, found ${entries.length}`,
    );
  }
  return { entries, entryCount, centralDirectoryOffset, centralDirectorySize, bytesRead };
}

export function hasZip64Field(extra: Buffer): boolean {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    if (cursor + 4 + size > extra.length) return false;
    if (id === ZIP64_EXTRA_FIELD_ID) return true;
    cursor += 4 + size;
  }
  return false;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read exactly `length` bytes from `offset`, or as many as the file holds. */
async function readExactly(handle: FileHandle, length: number, offset: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}
