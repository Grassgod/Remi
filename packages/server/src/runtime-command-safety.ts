const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;

export function redactRuntimeCommandText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[REDACTED]@")
    .replace(/(\b(?:password|token)\s*=\s*)(["']?)([^\s"';&]+)\2/gi, "$1$2[REDACTED]$2")
    .replace(/\b(?:ghp|gho)_[A-Za-z0-9]{4,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "[REDACTED]");
}

export function redactRuntimeCommandArgs(values: readonly string[]): string[] {
  return values.map((value, index) => {
    const previous = values[index - 1]?.trim() ?? "";
    const beforePrevious = values[index - 2]?.trim() ?? "";
    if (/^authorization\s*:\s*bearer$/i.test(previous)) return "[REDACTED]";
    if (/^bearer$/i.test(previous) && /^authorization\s*:?$/i.test(beforePrevious)) return "[REDACTED]";
    return redactRuntimeCommandText(value);
  });
}

export function truncateRuntimeCommandOutput(value: string, limitBytes = DEFAULT_OUTPUT_LIMIT_BYTES): string {
  const buffer = new HeadTailBuffer(positiveInteger(limitBytes, "limitBytes"));
  buffer.append(new TextEncoder().encode(value));
  return buffer.text();
}

export class HeadTailBuffer {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private tail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private full: Uint8Array<ArrayBufferLike> | null = new Uint8Array(0);
  private totalBytes = 0;

  constructor(private readonly limitBytes: number) {
    const markerReserve = Math.min(96, Math.max(32, Math.floor(limitBytes / 4)));
    const retained = Math.max(2, limitBytes - markerReserve);
    this.headLimit = Math.ceil(retained / 2);
    this.tailLimit = Math.floor(retained / 2);
  }

  append(chunk: Uint8Array<ArrayBufferLike>): void {
    this.totalBytes += chunk.byteLength;
    if (this.full) {
      const combined = concatBytes(this.full, chunk);
      if (this.totalBytes <= this.limitBytes) {
        this.full = combined;
        return;
      }
      this.head = combined.subarray(0, this.headLimit).slice();
      this.tail = combined.subarray(Math.max(0, combined.byteLength - this.tailLimit)).slice();
      this.full = null;
      return;
    }
    const headRoom = this.headLimit - this.head.byteLength;
    const headBytes = headRoom > 0 ? chunk.subarray(0, Math.min(headRoom, chunk.byteLength)) : new Uint8Array(0);
    if (headBytes.byteLength) this.head = concatBytes(this.head, headBytes);
    const remainder = chunk.subarray(headBytes.byteLength);
    if (remainder.byteLength) {
      const combined = concatBytes(this.tail, remainder);
      this.tail = combined.subarray(Math.max(0, combined.byteLength - this.tailLimit)).slice();
    }
  }

  text(): string {
    const decoder = new TextDecoder();
    if (this.full) return decoder.decode(this.full);
    const truncated = this.totalBytes - this.head.byteLength - this.tail.byteLength;
    return `${decoder.decode(this.head)}\n... ${truncated} bytes truncated ...\n${decoder.decode(this.tail)}`;
  }
}

function concatBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  if (!left.byteLength) return right.slice();
  if (!right.byteLength) return left.slice();
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
