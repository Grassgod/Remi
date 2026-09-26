/**
 * The single sanitize point for task-trace fields (MUL-402 ruling 6b).
 *
 * These rules used to live only inside `store/repos/tasks-repo.ts`
 * `appendTaskMessages`, where they guarded the `POST /api/daemon/tasks/:id/messages`
 * write path. In protocol v2 the daemon owns the trace file and the frame is
 * typed, so the caps move to the producer: `TraceStore.append` calls this module,
 * and B's file implementation uses the same functions, so the file and the frame
 * can never disagree.
 *
 * `sanitizeTraceEventFields` is a faithful extraction, not a rewrite. Its output
 * for a given message must equal what `appendTaskMessages` writes into
 * `multiremi_task_messages` today, byte for byte — including the truncation
 * marker and the UTF-8 char-boundary handling — and
 * `tests/unit/daemon/trace-sanitize-equivalence.test.ts` holds it to that by
 * running one fixture set through both implementations. When A-6 deletes the old
 * write path, that test's tasks-repo half is deleted with it; this module stays.
 *
 * Lives in `@multiremi/shared` because the server store and the daemon trace
 * store both need it and neither may depend on the other.
 */

/** Byte caps, in bytes. Not code points: the DB and the wire both count bytes. */
export const TRACE_TOOL_MAX_BYTES = 512;
export const TRACE_CONTENT_MAX_BYTES = 256 * 1024;
export const TRACE_INPUT_MAX_BYTES = 256 * 1024;
export const TRACE_OUTPUT_MAX_BYTES = 64 * 1024;
export const TRACE_META_MAX_BYTES = 64 * 1024;

/** Structured-field guards. */
export const TRACE_JSON_MAX_DEPTH = 8;
export const TRACE_JSON_MAX_ARRAY = 256;

/** Tool statuses the write path accepts; anything else is dropped to null. */
export const TRACE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

/** A string longer than this that looks like base64 is elided, not stored. */
const BASE64_LOOKALIKE_MIN_LENGTH = 4096;
const BASE64_LOOKALIKE_RE = /^[A-Za-z0-9+/=]+$/;

/** Marker appended when a value is cut, matching the historical write path. */
export const TRACE_TRUNCATION_MARKER = "… [truncated]";

/** `null` for absent values, and for the empty string (which the DB stores as null). */
export function cleanTraceField(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s.length > 0 ? s : null;
}

/** Keep a status only when it is one of the four the write path accepts. */
export function normalizeTraceStatus(value: unknown): string | null {
  const s = cleanTraceField(value);
  return s && TRACE_STATUSES.has(s) ? s : null;
}

/**
 * Cut a string to `maxBytes` on a UTF-8 char boundary and flag it.
 *
 * The replacement of trailing U+FFFD keeps a split multi-byte character from
 * surviving as a lone replacement char before the marker.
 */
export function truncateUtf8(value: string | null, maxBytes: number): string | null {
  if (value == null) return null;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const head = decoder.decode(bytes.slice(0, maxBytes)).replace(/\uFFFD+$/, "");
  return head + TRACE_TRUNCATION_MARKER;
}

/**
 * Bound a structured value: depth, array width, and base64-looking payloads.
 *
 * The base64 rule exists because image/data payloads arrive inside tool input and
 * would otherwise bloat the row and every frame that carries it. The length and
 * shape checks are deliberately the same as the historical ones so the same value
 * is elided in both implementations.
 */
export function sanitizeTraceJson(value: unknown, depth = 0): unknown {
  if (depth > TRACE_JSON_MAX_DEPTH) return "[depth-limited]";
  if (value == null || typeof value !== "object") {
    if (
      typeof value === "string"
      && value.length > BASE64_LOOKALIKE_MIN_LENGTH
      && BASE64_LOOKALIKE_RE.test(value)
    ) {
      return "[base64-elided]";
    }
    return value;
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, TRACE_JSON_MAX_ARRAY).map((v) => sanitizeTraceJson(v, depth + 1));
    if (value.length > TRACE_JSON_MAX_ARRAY) {
      out.push(`[+${value.length - TRACE_JSON_MAX_ARRAY} more]`);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sanitizeTraceJson(v, depth + 1);
  }
  return out;
}

/** The fields `sanitizeTraceEventFields` accepts, loose on purpose (untrusted input). */
export interface TraceFieldInput {
  /** Already a string by the time it reaches here (the API layer defaults it). */
  type: string;
  tool?: unknown;
  content?: unknown;
  input?: unknown;
  output?: unknown;
  tool_call_id?: unknown;
  status?: unknown;
  meta?: unknown;
}

/**
 * The stored form of one event's fields: exactly the strings
 * `appendTaskMessages` writes into the SQLite/Postgres columns.
 *
 * `input` and `meta` come back as **serialized JSON text**, because that is what
 * the historical path stores. `TraceStore.append` turns them back into structured
 * values for the typed `TraceEvent`; see `sanitizeTraceEvent` for that step.
 */
export interface TraceStoredFields {
  type: string;
  tool: string | null;
  content: string | null;
  input: string | null;
  output: string | null;
  tool_call_id: string | null;
  status: string | null;
  meta: string | null;
}

export function sanitizeTraceEventFields(message: TraceFieldInput): TraceStoredFields {
  return {
    // `type` is the one field the historical path writes raw, without cleaning or
    // truncating: the API layer already defaulted it, and a type is short by
    // construction. Kept raw here so the two implementations agree.
    type: message.type,
    tool: truncateUtf8(cleanTraceField(message.tool), TRACE_TOOL_MAX_BYTES),
    content: truncateUtf8(cleanTraceField(message.content), TRACE_CONTENT_MAX_BYTES),
    input: message.input == null
      ? null
      : truncateUtf8(JSON.stringify(sanitizeTraceJson(message.input)), TRACE_INPUT_MAX_BYTES),
    output: truncateUtf8(cleanTraceField(message.output), TRACE_OUTPUT_MAX_BYTES),
    tool_call_id: cleanTraceField(message.tool_call_id),
    status: normalizeTraceStatus(message.status),
    meta: message.meta == null
      ? null
      : truncateUtf8(JSON.stringify(sanitizeTraceJson(message.meta)), TRACE_META_MAX_BYTES),
  };
}

/**
 * Turn a serialized structured field back into a value for the typed event.
 *
 * Returns the parsed value on valid JSON, and `null` otherwise — including the
 * capped case, where the stored text is a truncated string and cannot be parsed.
 * Returning `null` there is not a loss of information relative to today: the
 * historical write path stores the same truncated text and its read path
 * (`parseJson(row.input, null)`) also yields `null`. A-6's frame carries `null`
 * for such a field, exactly as the API answers `null` for that row today.
 */
export function parseStoredTraceJson<T>(stored: string | null): T | null {
  if (stored == null) return null;
  try {
    return JSON.parse(stored) as T;
  } catch {
    return null;
  }
}
