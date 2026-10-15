/**
 * Read the usage facts of one Gemini model response while the gateway shim
 * passes its bytes through unchanged (PR 4 §4.2). The scanner never alters or
 * withholds bytes; it only parses copies.
 *
 * - `sse` (`:streamGenerateContent?alt=sse`): each `data:` event is one JSON
 *   chunk. An event whose data exceeds the cap is skipped, never parsed.
 * - `json` (`:generateContent`, or a stream without `alt=sse`, which is one JSON
 *   array of chunks): the body is buffered up to the JSON cap, for parsing only.
 *
 * The last `usageMetadata`, `responseId` and `modelVersion` win: Gemini repeats
 * cumulative counters on every chunk and completes them on the last one.
 */

export const SSE_EVENT_MAX_BYTES = 2 * 1024 * 1024;
export const JSON_BODY_MAX_BYTES = 8 * 1024 * 1024;

export interface GeminiResponseFacts {
  responseId: string | null;
  modelVersion: string | null;
  /** Numeric top-level counters only (nested detail arrays are dropped). */
  usageMetadata: Record<string, number> | null;
}

function usageCounters(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const counters: Record<string, number> = {};
  for (const [name, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isFinite(count)) counters[name] = count;
  }
  return counters;
}

export class GeminiResponseScanner {
  private readonly facts: GeminiResponseFacts = { responseId: null, modelVersion: null, usageMetadata: null };
  private readonly decoder = new TextDecoder();
  /** SSE: the unterminated tail of the current line. */
  private line = "";
  /** SSE: the line in progress exceeded the cap; drop it up to its newline. */
  private skippingLine = false;
  /** SSE: `data:` values of the event in progress. */
  private data: string[] = [];
  private dataLength = 0;
  private skippingEvent = false;
  /** JSON: buffered copies, or null once the cap was exceeded. */
  private json: Uint8Array[] | null = [];
  private jsonBytes = 0;

  constructor(
    readonly mode: "sse" | "json",
    private readonly limits: { sseEventBytes?: number; jsonBytes?: number } = {},
  ) {}

  get result(): GeminiResponseFacts {
    return { ...this.facts, usageMetadata: this.facts.usageMetadata ? { ...this.facts.usageMetadata } : null };
  }

  push(chunk: Uint8Array): void {
    if (this.mode === "json") {
      if (!this.json) return;
      this.jsonBytes += chunk.byteLength;
      if (this.jsonBytes > (this.limits.jsonBytes ?? JSON_BODY_MAX_BYTES)) this.json = null;
      else this.json.push(chunk.slice());
      return;
    }
    this.feedText(this.decoder.decode(chunk, { stream: true }));
  }

  /** The body ended (or was cut short); parse what is complete. */
  end(): GeminiResponseFacts {
    if (this.mode === "json") {
      if (this.json) {
        const merged = new Uint8Array(this.jsonBytes);
        let offset = 0;
        for (const part of this.json) { merged.set(part, offset); offset += part.byteLength; }
        this.json = null;
        try { this.observeJson(JSON.parse(new TextDecoder().decode(merged))); } catch { /* not JSON: nothing to learn */ }
      }
      return this.result;
    }
    this.feedText(this.decoder.decode());
    if (this.line && !this.skippingLine) this.feedLine(this.line);
    this.line = "";
    this.dispatch();
    return this.result;
  }

  private get cap(): number {
    return this.limits.sseEventBytes ?? SSE_EVENT_MAX_BYTES;
  }

  private feedText(text: string): void {
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline < 0) break;
      if (this.skippingLine) {
        // The over-cap line ends here; its whole event is dropped.
        this.skippingLine = false;
        this.skippingEvent = true;
      } else {
        this.feedLine(this.line + text.slice(start, newline));
      }
      this.line = "";
      start = newline + 1;
    }
    if (this.skippingLine) return;
    this.line += text.slice(start);
    if (this.line.length > this.cap) {
      this.line = "";
      this.skippingLine = true;
    }
  }

  private feedLine(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":") || this.skippingEvent) return;
    const colon = line.indexOf(":");
    if ((colon < 0 ? line : line.slice(0, colon)) !== "data") return;
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    this.dataLength += value.length + 1;
    if (this.dataLength > this.cap) {
      this.data = [];
      this.skippingEvent = true;
      return;
    }
    this.data.push(value);
  }

  private dispatch(): void {
    const data = this.data.join("\n");
    const skipped = this.skippingEvent;
    this.data = [];
    this.dataLength = 0;
    this.skippingEvent = false;
    if (skipped || !data || data === "[DONE]") return;
    try { this.observeJson(JSON.parse(data)); } catch { /* a malformed event teaches nothing */ }
  }

  private observeJson(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.observeJson(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const chunk = value as Record<string, unknown>;
    const usage = usageCounters(chunk.usageMetadata);
    if (usage) this.facts.usageMetadata = usage;
    if (typeof chunk.responseId === "string" && chunk.responseId) this.facts.responseId = chunk.responseId;
    if (typeof chunk.modelVersion === "string" && chunk.modelVersion) this.facts.modelVersion = chunk.modelVersion;
  }
}
