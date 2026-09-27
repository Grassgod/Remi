/**
 * Minimal ZIP container primitives shared by the daemon Session Archive writer
 * and the server-side archive reader.
 *
 * The container is a plain ZIP so `unzip -t` and `zipinfo` validate it with no
 * bespoke tooling: every member is deflated independently (level 6), the CRC-32
 * and sizes travel in a trailing data descriptor, and Zip64 takes over once a
 * member, an offset or the member count leaves the 32-bit range. Members are
 * addressed through the offsets recorded in `index.json`, so a reader issues
 * one `pread` for the compressed body and never touches the rest of the blob.
 */

export const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
export const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
export const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
export const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
export const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
export const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
export const ZIP64_EXTRA_FIELD_ID = 0x0001;

export const ZIP_DEFLATE_METHOD = 8;
export const ZIP_STORED_METHOD = 0;
/** General-purpose bit 3: sizes and CRC follow the member in a data descriptor. */
export const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
/** General-purpose bit 11: the member name is UTF-8. */
export const ZIP_UTF8_NAME_FLAG = 0x0800;
export const ZIP_VERSION_NEEDED_DEFLATE = 20;
export const ZIP_VERSION_NEEDED_ZIP64 = 45;
/** "Made by" field: MS-DOS host, PKZIP 4.5-compatible version. */
export const ZIP_MADE_BY = 0x031e;
export const ZIP_DOS_TIME = 0;
/** 1980-01-01, the zero value for MS-DOS dates. */
export const ZIP_DOS_DATE = 0x0021;

export const ZIP_UINT16_MAX = 0xffff;
export const ZIP_UINT32_MAX = 0xffffffff;

/** Sizes and offsets above this need Zip64 rather than a 32-bit field. */
export function isZip64Value(value: number): boolean {
  return !Number.isSafeInteger(value) || value < 0 || value > ZIP_UINT32_MAX;
}

export interface ZipMemberSizes {
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Build a Zip64 extended information extra field.
 *
 * Zip64 stores only the values that overflowed their 32-bit field, in the fixed
 * order uncompressed size, compressed size, local header offset. Passing a
 * prefix of that list is valid; a later value without the earlier ones is not.
 */
export function buildZip64ExtraField(values: {
  uncompressedSize?: number;
  compressedSize?: number;
  localHeaderOffset?: number;
}): Buffer {
  const entries: Buffer[] = [];
  const append = (value: number): void => {
    const entry = Buffer.alloc(8);
    entry.writeBigUInt64LE(BigInt(value), 0);
    entries.push(entry);
  };
  if (values.uncompressedSize !== undefined) append(values.uncompressedSize);
  if (values.compressedSize !== undefined) append(values.compressedSize);
  if (values.localHeaderOffset !== undefined) append(values.localHeaderOffset);
  const field = Buffer.alloc(4 + entries.length * 8);
  field.writeUInt16LE(ZIP64_EXTRA_FIELD_ID, 0);
  field.writeUInt16LE(entries.length * 8, 2);
  let cursor = 4;
  for (const entry of entries) {
    entry.copy(field, cursor);
    cursor += entry.length;
  }
  return field;
}

/**
 * Central-directory Zip64 extra field for one member.
 *
 * Unlike the local header, the central directory always carries all three
 * values: readers (Info-ZIP, Python's zipfile) require the sizes before the
 * offset, so a partial list would be misparsed.
 */
export function buildCentralZip64ExtraField(member: ZipMemberSizes): Buffer {
  return buildZip64ExtraField({
    uncompressedSize: member.uncompressedSize,
    compressedSize: member.compressedSize,
    localHeaderOffset: member.localHeaderOffset,
  });
}

export function localHeaderSize(nameLength: number, extraLength: number): number {
  return 30 + nameLength + extraLength;
}

export function dataDescriptorSize(zip64: boolean): number {
  return zip64 ? 24 : 16;
}

export interface Zip64ExtraValues {
  uncompressedSize: bigint | null;
  compressedSize: bigint | null;
  localHeaderOffset: bigint | null;
}

/**
 * Read the Zip64 extra field out of a local header or central-directory record.
 *
 * A field only stores the values that overflowed their 32-bit slots, so the
 * caller decides which returned slots to trust: `null` means "not stored here,
 * use the 32-bit field".
 */
export function readZip64ExtraField(extra: Buffer): Zip64ExtraValues {
  const values: Zip64ExtraValues = {
    uncompressedSize: null,
    compressedSize: null,
    localHeaderOffset: null,
  };
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const bodyStart = cursor + 4;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > extra.length) break;
    if (id === ZIP64_EXTRA_FIELD_ID) {
      const take = (at: number): bigint | null =>
        at + 8 <= bodyEnd ? extra.readBigUInt64LE(at) : null;
      values.uncompressedSize = take(bodyStart);
      values.compressedSize = take(bodyStart + 8);
      values.localHeaderOffset = take(bodyStart + 16);
      break;
    }
    cursor = bodyEnd;
  }
  return values;
}

/** Reject member paths that could escape the archive root on extraction. */
export function assertZipMemberPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`Invalid ZIP member path: ${JSON.stringify(path)}`);
  }
  for (const segment of path.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Invalid ZIP member path: ${JSON.stringify(path)}`);
    }
  }
}

/**
 * Find the last occurrence of a 32-bit signature in `buffer`.
 *
 * Used to locate the end-of-central-directory record, whose position varies
 * with the optional archive comment that may follow it.
 */
export function findSignatureBackwards(buffer: Buffer, signature: number): number {
  for (let offset = buffer.length - 4; offset >= 0; offset--) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}
