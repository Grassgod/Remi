/**
 * Streaming ZIP writer for the daemon Session Archive v2 writer.
 *
 * Members are appended one at a time. Each member is deflated at level 6 into a
 * private deflate stream whose output goes straight to the sink, while CRC-32,
 * both sizes and (optionally) the SHA-256 digest are computed on the fly and
 * verified against the scan that produced the work list. The trailing data
 * descriptor carries the sizes, so the writer never needs to buffer a member or
 * revisit an earlier offset.
 *
 * Zip64 takes over for a member once its sizes or its offset leave 32 bits, and
 * for the archive once the member count, the central-directory size or the
 * central-directory offset would overflow, so archives above 4 GiB and 65535
 * members stay valid standard ZIP files.
 */

import { createDeflateRaw, crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import {
  ZIP_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP_DATA_DESCRIPTOR_FLAG,
  ZIP_DATA_DESCRIPTOR_SIGNATURE,
  ZIP_DEFLATE_METHOD,
  ZIP_DOS_DATE,
  ZIP_DOS_TIME,
  ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP_LOCAL_HEADER_SIGNATURE,
  ZIP_MADE_BY,
  ZIP_UINT16_MAX,
  ZIP_UINT32_MAX,
  ZIP_UTF8_NAME_FLAG,
  ZIP_VERSION_NEEDED_DEFLATE,
  ZIP_VERSION_NEEDED_ZIP64,
  ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE,
  ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  assertZipMemberPath,
  buildCentralZip64ExtraField,
  buildZip64ExtraField,
  dataDescriptorSize,
  isZip64Value,
  localHeaderSize,
} from "./format.js";

export interface ZipStreamMember {
  path: string;
  /** Offset of the local file header. */
  localHeaderOffset: number;
  /** Offset of the first compressed byte (header + name + extra). */
  dataOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  sha256: string;
}

/** One member to append, described by its scan results. */
export interface ZipStreamMemberInput {
  path: string;
  /** Uncompressed size from the scan. Streaming verifies it byte-for-byte. */
  size: number;
  /** SHA-256 from the scan. Streaming recomputes and compares. */
  sha256: string;
  /** Produces the member bytes in order. Consumed exactly once. */
  stream: AsyncIterable<Buffer>;
}

export interface ZipStreamWriterOptions {
  /** Sink for archive bytes, called in order. */
  write: (chunk: Buffer) => void | Promise<void>;
  /** deflate level; the Session Archive contract fixes it at 6. */
  level?: number;
}

export class ZipStreamWriter {
  private readonly members: ZipStreamMember[] = [];
  private readonly seenPaths = new Set<string>();
  private offset = 0;
  private finalized = false;

  constructor(private readonly options: ZipStreamWriterOptions) {}

  get bytesWritten(): number {
    return this.offset;
  }

  /** Index records for every member written so far, in write order. */
  get index(): readonly ZipStreamMember[] {
    return this.members;
  }

  /** Append a member whose bytes come from a file or another async source. */
  async addStream(input: ZipStreamMemberInput): Promise<ZipStreamMember> {
    return await this.addMember(
      input.path,
      input.size,
      input.sha256,
      (push) => consumeStream(input.stream, push),
    );
  }

  /** Append a member already held in memory (manifest and index members). */
  async addBuffer(path: string, body: Buffer, sha256: string): Promise<ZipStreamMember> {
    return await this.addMember(path, body.length, sha256, async (push) => {
      if (body.length) await push(body);
    });
  }

  private async addMember(
    path: string,
    size: number,
    expectedSha256: string,
    feed: (push: (chunk: Buffer) => Promise<void>) => Promise<void>,
  ): Promise<ZipStreamMember> {
    if (this.finalized) throw new Error("ZIP archive is already finalized");
    assertZipMemberPath(path);
    if (this.seenPaths.has(path)) throw new Error(`Duplicate ZIP member: ${path}`);
    this.seenPaths.add(path);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid ZIP member size for ${path}: ${size}`);
    }

    const name = Buffer.from(path, "utf8");
    // The sizes are known from the scan, but the member can still be written
    // only once its bytes flow through the deflate stream, so the local header
    // always carries the data-descriptor flag.
    const zip64 = isZip64Value(size) || isZip64Value(this.offset);
    const localExtra = zip64
      ? buildZip64ExtraField({ uncompressedSize: size })
      : Buffer.alloc(0);
    const localHeaderOffset = this.offset;
    const dataOffset = localHeaderOffset + localHeaderSize(name.length, localExtra.length);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(zip64 ? ZIP_VERSION_NEEDED_ZIP64 : ZIP_VERSION_NEEDED_DEFLATE, 4);
    local.writeUInt16LE(ZIP_DATA_DESCRIPTOR_FLAG | ZIP_UTF8_NAME_FLAG, 6);
    local.writeUInt16LE(ZIP_DEFLATE_METHOD, 8);
    local.writeUInt16LE(ZIP_DOS_TIME, 10);
    local.writeUInt16LE(ZIP_DOS_DATE, 12);
    local.writeUInt32LE(zip64 ? ZIP_UINT32_MAX : 0, 14);
    local.writeUInt32LE(zip64 ? ZIP_UINT32_MAX : 0, 18);
    local.writeUInt32LE(zip64 ? ZIP_UINT32_MAX : size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    await this.emit(local);
    await this.emit(name);
    if (localExtra.length) await this.emit(localExtra);

    const deflate = createDeflateRaw({ level: this.options.level ?? 6 });
    let compressedSize = 0;
    let uncompressedSize = 0;
    let crc = 0;
    const digest = createHash("sha256");
    const members = this.members;
    const emit = this.emit.bind(this);
    const deflated = (async () => {
      for await (const chunk of deflate) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        compressedSize += bytes.length;
        await emit(bytes);
      }
    })();
    let failure: unknown = null;
    try {
      await feed(async (chunk) => {
        uncompressedSize += chunk.length;
        if (uncompressedSize > size) {
          throw new Error(`ZIP member grew while it was being read: ${path}`);
        }
        crc = crc32(chunk, crc) >>> 0;
        digest.update(chunk);
        if (!deflate.write(chunk)) await new Promise<void>((resolve) => deflate.once("drain", resolve));
      });
      deflate.end();
    } catch (error) {
      failure = error;
      deflate.destroy(error as Error);
    }
    try {
      await deflated;
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
    if (uncompressedSize !== size) {
      throw new Error(
        `ZIP member changed while it was being read: ${path} (expected ${size} bytes, read ${uncompressedSize})`,
      );
    }
    const actualSha256 = digest.digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(`ZIP member changed while it was being read: ${path}`);
    }
    const memberZip64 = zip64 || isZip64Value(compressedSize) || isZip64Value(uncompressedSize);
    await this.emit(dataDescriptor(crc, compressedSize, uncompressedSize, memberZip64));

    const member: ZipStreamMember = {
      path,
      localHeaderOffset,
      dataOffset,
      compressedSize,
      uncompressedSize,
      crc32: crc,
      sha256: actualSha256,
    };
    members.push(member);
    return member;
  }

  /**
   * Write the central directory and end-of-central-directory records.
   *
   * The 65535-member and 4 GiB boundaries are covered by archive-level Zip64;
   * the per-member records use the same rule as their local headers.
   */
  async finish(): Promise<void> {
    if (this.finalized) throw new Error("ZIP archive is already finalized");
    this.finalized = true;
    const centralOffset = this.offset;
    for (const member of this.members) {
      const name = Buffer.from(member.path, "utf8");
      const zip64 = isZip64Value(member.localHeaderOffset)
        || isZip64Value(member.compressedSize)
        || isZip64Value(member.uncompressedSize);
      const centralExtra = zip64
        ? buildCentralZip64ExtraField({
          compressedSize: member.compressedSize,
          uncompressedSize: member.uncompressedSize,
          localHeaderOffset: member.localHeaderOffset,
        })
        : Buffer.alloc(0);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_SIGNATURE, 0);
      header.writeUInt16LE(ZIP_MADE_BY, 4);
      header.writeUInt16LE(zip64 ? ZIP_VERSION_NEEDED_ZIP64 : ZIP_VERSION_NEEDED_DEFLATE, 6);
      header.writeUInt16LE(ZIP_DATA_DESCRIPTOR_FLAG | ZIP_UTF8_NAME_FLAG, 8);
      header.writeUInt16LE(ZIP_DEFLATE_METHOD, 10);
      header.writeUInt16LE(ZIP_DOS_TIME, 12);
      header.writeUInt16LE(ZIP_DOS_DATE, 14);
      header.writeUInt32LE(member.crc32, 16);
      header.writeUInt32LE(zip64 ? ZIP_UINT32_MAX : member.compressedSize, 20);
      header.writeUInt32LE(zip64 ? ZIP_UINT32_MAX : member.uncompressedSize, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt16LE(centralExtra.length, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(zip64 ? ZIP_UINT32_MAX : member.localHeaderOffset, 42);
      await this.emit(header);
      await this.emit(name);
      if (centralExtra.length) await this.emit(centralExtra);
    }
    const centralSize = this.offset - centralOffset;
    const archiveZip64 = this.members.length > ZIP_UINT16_MAX
      || isZip64Value(centralOffset)
      || isZip64Value(centralSize);

    if (archiveZip64) {
      const recordOffset = this.offset;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
      record.writeBigUInt64LE(BigInt(44), 4);
      record.writeUInt16LE(ZIP_MADE_BY, 12);
      record.writeUInt16LE(ZIP_VERSION_NEEDED_ZIP64, 14);
      record.writeUInt32LE(0, 16);
      record.writeUInt32LE(0, 20);
      record.writeBigUInt64LE(BigInt(this.members.length), 24);
      record.writeBigUInt64LE(BigInt(this.members.length), 32);
      record.writeBigUInt64LE(BigInt(centralSize), 40);
      record.writeBigUInt64LE(BigInt(centralOffset), 48);
      await this.emit(record);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(recordOffset), 8);
      locator.writeUInt32LE(1, 16);
      await this.emit(locator);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(archiveZip64 ? ZIP_UINT16_MAX : this.members.length, 8);
    eocd.writeUInt16LE(archiveZip64 ? ZIP_UINT16_MAX : this.members.length, 10);
    eocd.writeUInt32LE(archiveZip64 ? ZIP_UINT32_MAX : centralSize, 12);
    eocd.writeUInt32LE(archiveZip64 ? ZIP_UINT32_MAX : centralOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await this.emit(eocd);
  }

  private async emit(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return;
    await this.options.write(chunk);
    this.offset += chunk.length;
  }
}

async function consumeStream(
  stream: AsyncIterable<Buffer>,
  push: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length) await push(bytes);
  }
}

function dataDescriptor(crc: number, compressedSize: number, uncompressedSize: number, zip64: boolean): Buffer {
  const descriptor = Buffer.alloc(dataDescriptorSize(zip64));
  descriptor.writeUInt32LE(ZIP_DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(crc, 4);
  if (zip64) {
    descriptor.writeBigUInt64LE(BigInt(compressedSize), 8);
    descriptor.writeBigUInt64LE(BigInt(uncompressedSize), 16);
  } else {
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(uncompressedSize, 12);
  }
  return descriptor;
}
