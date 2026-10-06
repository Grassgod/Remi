/** Migration-only tar.gz member reader. It never extracts paths to disk. */
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

export async function* readLegacyUsageMembers(path: string, maxMemberBytes = 128 * 1024 * 1024): AsyncGenerator<{ path: string; body: string }> {
  const source = createReadStream(path, { flags: "r" });
  const stream = source.pipe(createGunzip());
  source.on("error", error => stream.destroy(error));
  let buffer: Buffer = Buffer.alloc(0);
  let remaining = 0, padding = 0, name = "", kind = "";
  let parts: Buffer[] = [], collect = false, pendingName: string | null = null;
  try {
    for await (const raw of stream) {
      buffer = buffer.length ? Buffer.concat([buffer, raw]) : raw as Buffer;
      for (;;) {
        if (remaining > 0) {
          if (!buffer.length) break;
          const length = Math.min(remaining, buffer.length);
          if (collect) parts.push(Buffer.from(buffer.subarray(0, length)));
          buffer = buffer.subarray(length); remaining -= length;
          if (remaining) continue;
          if (collect) {
            const body = Buffer.concat(parts).toString();
            if (kind === "L") pendingName = body.replace(/\0.*$/, "").trimEnd();
            else if (kind === "x") pendingName = /(?:^|\n)\d+ path=([^\n]+)/.exec(body)?.[1] ?? null;
            else yield { path: name, body };
          }
          parts = [];
        }
        if (padding) {
          const length = Math.min(padding, buffer.length);
          buffer = buffer.subarray(length); padding -= length;
          if (padding) break;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
        if (header.every(byte => byte === 0)) return;
        const storedChecksum = parseInt(header.subarray(148, 156).toString().replace(/\0/g, "").trim(), 8);
        const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (storedChecksum !== checksum) throw new Error("Legacy tar header checksum mismatch");
        const text = (start: number, end: number) => header.subarray(start, end).toString().replace(/\0.*$/, "");
        const prefix = text(345, 500);
        name = pendingName ?? `${prefix ? `${prefix}/` : ""}${text(0, 100)}`;
        pendingName = null;
        if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("Unsafe legacy archive member");
        const size = parseInt(text(124, 136).trim() || "0", 8);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid legacy archive member size");
        kind = text(156, 157);
        const metadata = kind === "L" || kind === "x";
        collect = metadata ? size <= 64 * 1024 : (kind === "0" || kind === "") && name.startsWith("sessions/") && name.endsWith(".jsonl") && size <= maxMemberBytes;
        remaining = size; padding = (512 - size % 512) % 512;
        if (!size) { collect = false; continue; }
      }
    }
    if (remaining || padding || buffer.length) throw new Error("Truncated legacy tar archive");
  } finally { stream.destroy(); source.destroy(); }
}
