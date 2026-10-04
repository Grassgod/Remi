export function envelopeSummary(body: string | null | undefined): string {
  const head = Array.from((body ?? "").trim().slice(0, 1_000)).slice(0, 500).join("");
  return utf8Head(head, 1_100);
}

function utf8Head(body: string, bytes: number): string {
  const encoded = Buffer.from(body);
  if (encoded.length <= bytes) return body;
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}

export function clampEnvelopeBody(body: string): string {
  if (Buffer.byteLength(body) <= 4_096) return body;
  const suffix = "\n（已截断；全文见来源评论或任务）";
  console.warn(JSON.stringify({ event: "envelope_body_clamped", original_bytes: Buffer.byteLength(body) }));
  return utf8Head(body, 4_096 - Buffer.byteLength(suffix)) + suffix;
}
