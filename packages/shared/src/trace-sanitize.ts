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
 * The deprecated Store writer also delegates here for legacy reader fixtures.
 * Boundary tests pin the original byte caps, truncation marker, UTF-8 handling
 * and structured-field guards; there is no second sanitizer to keep in sync.
 *
 * Lives in `@multiremi/shared` because the server store and the daemon trace
 * store both need it and neither may depend on the other.
 */

import type {
  CommandAction,
  FileChange,
  TraceEventBody,
  TraceItem,
} from "@multiremi/contracts/trace.js";
import { utf8ByteLength } from "./utf8.js";

export { utf8ByteLength };

/** Byte caps, in bytes. Not code points: the DB and the wire both count bytes. */
export const TRACE_TOOL_MAX_BYTES = 512;
export const TRACE_CONTENT_MAX_BYTES = 256 * 1024;
export const TRACE_INPUT_MAX_BYTES = 256 * 1024;
export const TRACE_OUTPUT_MAX_BYTES = 64 * 1024;
export const TRACE_META_MAX_BYTES = 64 * 1024;

/** Structured-field guards. */
export const TRACE_JSON_MAX_DEPTH = 8;
export const TRACE_JSON_MAX_ARRAY = 256;

/**
 * Tool statuses the legacy fragment write path accepts; anything else is dropped
 * to null. Only the deprecated `multiremi_task_messages` writer (legacy reader
 * fixtures) still sanitizes fragments; turn + items traces use the item caps
 * below and `TRACE_ITEM_STATUSES` from the contract.
 */
export const LEGACY_TRACE_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"] as const;
export const TRACE_STATUSES: ReadonlySet<string> = new Set(LEGACY_TRACE_STATUSES);

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

/** Keep a status only when the trace contract accepts it. */
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

// ── Item caps (turn + items traces, PR 2) ───────────────────────────────────
//
// Applied by the daemon translator when it builds an item and re-checked by the
// store before a write, so the file, the frame and every reader see the same
// bounded item. The byte caps above serve only the legacy task-message table
// writer (`tasks-repo.ts`); no trace event is a fragment any more.

/** `agent_message` / `user_message` text. */
export const TRACE_ITEM_TEXT_MAX_BYTES = 256 * 1024;
/** `reasoning` text. */
export const TRACE_ITEM_REASONING_MAX_BYTES = 64 * 1024;
/** Tool `output`: the first 16 KiB and the last 48 KiB are kept around the marker. */
export const TRACE_ITEM_OUTPUT_HEAD_BYTES = 16 * 1024;
export const TRACE_ITEM_OUTPUT_TAIL_BYTES = 48 * 1024;
export const TRACE_ITEM_OUTPUT_MAX_BYTES = TRACE_ITEM_OUTPUT_HEAD_BYTES + TRACE_ITEM_OUTPUT_TAIL_BYTES;
/** Tool `input`, as serialized JSON after `sanitizeTraceJson`. */
export const TRACE_ITEM_INPUT_MAX_BYTES = 16 * 1024;
/** `FileChange.diff`, per change and per item. */
export const TRACE_ITEM_DIFF_MAX_BYTES = 64 * 1024;
export const TRACE_ITEM_DIFFS_MAX_BYTES = 256 * 1024;
/** `title` / `tool` labels. */
export const TRACE_ITEM_LABEL_MAX_BYTES = 512;
/** A command's `command` line, and the budget all of its `actions[].command` share. */
export const TRACE_ITEM_COMMAND_MAX_BYTES = 16 * 1024;
/** A command's `cwd`. */
export const TRACE_ITEM_CWD_MAX_BYTES = 4 * 1024;
/** One serialized event; over it, the largest fields are dropped. */
export const TRACE_EVENT_MAX_BYTES = 1024 * 1024;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

/** The first `maxBytes` bytes, cut back to a character boundary. */
function utf8Head(bytes: Uint8Array, maxBytes: number): string {
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return utf8Decoder.decode(bytes.subarray(0, end));
}

/** The last `maxBytes` bytes, moved forward to a character boundary. */
function utf8Tail(bytes: Uint8Array, maxBytes: number): string {
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return utf8Decoder.decode(bytes.subarray(start));
}

export interface CappedValue<T> {
  value: T;
  truncated: boolean;
}

/** Cut text to `maxBytes` (character-safe) and append the marker. */
export function capItemText(text: string, maxBytes: number = TRACE_ITEM_TEXT_MAX_BYTES): CappedValue<string> {
  if (utf8ByteLength(text) <= maxBytes) return { value: text, truncated: false };
  return { value: utf8Head(utf8Encoder.encode(text), maxBytes) + TRACE_TRUNCATION_MARKER, truncated: true };
}

/**
 * Keep the head and the tail of a long output, which is where commands print
 * what they are doing and how they ended, with the marker on its own line.
 */
export function capOutput(
  output: string | null,
  headBytes: number = TRACE_ITEM_OUTPUT_HEAD_BYTES,
  tailBytes: number = TRACE_ITEM_OUTPUT_TAIL_BYTES,
): CappedValue<string | null> {
  if (output === null || utf8ByteLength(output) <= headBytes + tailBytes) return { value: output, truncated: false };
  const bytes = utf8Encoder.encode(output);
  return {
    value: `${utf8Head(bytes, headBytes)}\n${TRACE_TRUNCATION_MARKER}\n${utf8Tail(bytes, tailBytes)}`,
    truncated: true,
  };
}

/** `title` / `tool` labels: 512 bytes. */
export function capLabel<T extends string | null>(value: T): T {
  return (value === null ? null : truncateUtf8(value, TRACE_ITEM_LABEL_MAX_BYTES)) as T;
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = mapStrings(entry, fn);
    return out;
  }
  return value;
}

/**
 * Tool input: `sanitizeTraceJson`, then at most `maxBytes` of JSON. Over the cap,
 * long string values are shortened step by step so the keys survive (a Write
 * tool keeps its path, not its whole content); input that still does not fit is
 * dropped to null.
 */
export function capItemInput(
  input: Record<string, unknown> | null,
  maxBytes: number = TRACE_ITEM_INPUT_MAX_BYTES,
): CappedValue<Record<string, unknown> | null> {
  if (input === null) return { value: null, truncated: false };
  const sanitized = sanitizeTraceJson(input) as Record<string, unknown>;
  const fits = (value: unknown) => utf8ByteLength(JSON.stringify(value)) <= maxBytes;
  // `truncated` also reports what `sanitizeTraceJson` elided (depth, width, base64).
  if (fits(sanitized)) return { value: sanitized, truncated: JSON.stringify(sanitized) !== JSON.stringify(input) };
  for (const limit of [4096, 1024, 256, 64]) {
    const shortened = mapStrings(sanitized, (s) => truncateUtf8(s, limit) ?? s) as Record<string, unknown>;
    if (fits(shortened)) return { value: shortened, truncated: true };
  }
  return { value: null, truncated: true };
}

/**
 * Diffs: 64 KiB per change, 256 KiB per item. A change over its cap keeps its
 * head; once the item budget is spent, later diffs are dropped. Both set
 * `diff_truncated`; `added` / `removed` keep the full counts.
 */
export function capFileChanges(changes: readonly FileChange[]): CappedValue<FileChange[]> {
  let budget = TRACE_ITEM_DIFFS_MAX_BYTES;
  let truncated = false;
  const value = changes.map((change) => {
    if (change.diff === null) return change;
    const limit = Math.min(TRACE_ITEM_DIFF_MAX_BYTES, budget);
    // Charge kept content only, never the marker, so re-capping a capped item is a no-op.
    const diff = limit > 0 ? capItemText(change.diff, limit).value : null;
    budget -= Math.min(utf8ByteLength(change.diff), Math.max(limit, 0));
    if (diff === change.diff) return change;
    truncated = true;
    return { ...change, diff, diff_truncated: true as const };
  });
  return { value, truncated };
}

/**
 * Command actions: their `command` strings share one budget of
 * `TRACE_ITEM_COMMAND_MAX_BYTES` (an action repeats part of the command line,
 * so a heredoc parsed into actions must not outgrow the line's own cap). A
 * string over what is left keeps its head and the marker.
 */
export function capCommandActions(actions: readonly CommandAction[]): CappedValue<CommandAction[]> {
  let budget = TRACE_ITEM_COMMAND_MAX_BYTES;
  let truncated = false;
  const value = actions.map((action) => {
    if (action.command === null) return action;
    const limit = Math.max(budget, 0);
    // Charge kept content only, never the marker, so re-capping is a no-op.
    const command = capItemText(action.command, limit).value;
    budget -= Math.min(utf8ByteLength(action.command), limit);
    if (command === action.command) return action;
    truncated = true;
    return { ...action, command } as CommandAction;
  });
  return { value, truncated };
}

/** Apply every item cap for the item's type. Returns the same object when nothing changed. */
export function capTraceItem<T extends TraceItem>(item: T): T {
  const next = { ...item } as TraceItem;
  let changed = false;
  const text = (maxBytes: number) => {
    const target = next as { text: string; truncated?: true };
    const capped = capItemText(target.text, maxBytes);
    if (capped.truncated) { target.text = capped.value; target.truncated = true; changed = true; }
  };
  const output = (flag: boolean) => {
    const target = next as { output: string | null; output_truncated?: true };
    const capped = capOutput(target.output);
    if (capped.truncated) {
      target.output = capped.value;
      if (flag && !target.output_truncated) target.output_truncated = true;
      changed = true;
    }
  };
  const label = <K extends string>(key: K) => {
    const target = next as unknown as Record<K, string | null>;
    const capped = capLabel(target[key]);
    if (capped !== target[key]) { target[key] = capped; changed = true; }
  };
  /** An optional label (PR 2 §13 fields): capped when present, left absent otherwise. */
  const optionalLabel = (key: string) => {
    const target = next as unknown as Record<string, unknown>;
    if (typeof target[key] !== "string") return;
    const capped = capLabel(target[key] as string);
    if (capped !== target[key]) { target[key] = capped; changed = true; }
  };
  switch (next.type) {
    case "user_message":
    case "agent_message":
      text(TRACE_ITEM_TEXT_MAX_BYTES);
      break;
    case "reasoning":
      text(TRACE_ITEM_REASONING_MAX_BYTES);
      break;
    case "command": {
      label("tool");
      optionalLabel("title");
      output(true);
      let commandTruncated = false;
      const line = (key: "command" | "cwd", maxBytes: number) => {
        const value = next[key];
        if (value === null) return;
        const capped = capItemText(value, maxBytes);
        if (capped.truncated) { next[key] = capped.value; commandTruncated = true; }
      };
      line("command", TRACE_ITEM_COMMAND_MAX_BYTES);
      line("cwd", TRACE_ITEM_CWD_MAX_BYTES);
      const actions = capCommandActions(next.actions);
      if (actions.truncated) { next.actions = actions.value; commandTruncated = true; }
      if (commandTruncated) { next.command_truncated = true; changed = true; }
      break;
    }
    case "file_change": {
      label("tool");
      output(true);
      const capped = capFileChanges(next.changes);
      if (capped.truncated) { next.changes = capped.value; changed = true; }
      break;
    }
    case "web_search":
      label("tool");
      output(true);
      break;
    case "tool": {
      label("tool");
      label("title");
      output(true);
      const capped = capItemInput(next.input);
      if (capped.truncated) { next.input = capped.value; next.input_truncated = true; changed = true; }
      break;
    }
    case "subagent":
      label("tool");
      label("title");
      for (const key of ["agent_type", "name", "model", "thread_id"]) optionalLabel(key);
      output(true);
      break;
    case "permission":
    case "notice":
      label("title");
      break;
    default:
      break;
  }
  return (changed ? next : item) as T;
}

/** Largest-first fields an oversized event may lose, per item type, until the item fits `maxBytes`. */
function dropOversizedFields(item: TraceItem, maxBytes: number): TraceItem | null {
  const next = { ...item } as Record<string, unknown>;
  const candidates: Array<[string, () => void]> = [];
  if (typeof next.output === "string") {
    candidates.push(["output", () => {
      next.output = null;
      next.output_truncated = true;
    }]);
  }
  if (typeof next.text === "string") candidates.push(["text", () => { next.text = ""; next.truncated = true; }]);
  if (next.input && typeof next.input === "object") {
    candidates.push(["input", () => { next.input = null; next.input_truncated = true; }]);
  }
  if (item.type === "command") {
    if (typeof next.command === "string") candidates.push(["command", () => { next.command = null; next.command_truncated = true; }]);
    if (typeof next.cwd === "string") candidates.push(["cwd", () => { next.cwd = null; next.command_truncated = true; }]);
    if (item.actions.length > 0) candidates.push(["actions", () => { next.actions = []; next.command_truncated = true; }]);
  }
  if (Array.isArray(next.changes)) {
    candidates.push(["changes", () => {
      next.changes = (next.changes as FileChange[]).map((change) => change.diff === null ? change : { ...change, diff: null, diff_truncated: true });
    }]);
  }
  for (const key of ["prompt", "summary", "description", "message"]) {
    if (typeof next[key] === "string") candidates.push([key, () => { next[key] = item.type === "question" && key === "message" ? "" : null; }]);
  }
  if (Array.isArray(next.questions)) candidates.push(["questions", () => { next.questions = []; }]);
  if (Array.isArray(next.entries)) candidates.push(["entries", () => { next.entries = []; }]);
  candidates.sort(([a], [b]) => utf8ByteLength(JSON.stringify(item[b as keyof TraceItem] ?? null))
    - utf8ByteLength(JSON.stringify(item[a as keyof TraceItem] ?? null)));
  for (const [, drop] of candidates) {
    drop();
    if (utf8ByteLength(JSON.stringify(next)) <= maxBytes) return next as unknown as TraceItem;
  }
  return null;
}

/**
 * Field caps plus the per-event ceiling: an `item.*` event whose item still
 * serializes over 1 MiB loses its largest fields (with `*_truncated` set where the
 * type has one). Returns null only for an event that cannot be brought under the
 * ceiling, which the caller drops.
 */
export function capTraceEvent<T extends TraceEventBody>(body: T): T | null {
  if (body.type === "item.started" || body.type === "item.updated" || body.type === "item.completed") {
    const item = capTraceItem(body.item);
    const capped = item === body.item ? body : { ...body, item };
    if (utf8ByteLength(JSON.stringify(capped)) <= TRACE_EVENT_MAX_BYTES) return capped;
    // The ceiling bounds the whole body: the item gets what the envelope leaves.
    const envelope = utf8ByteLength(JSON.stringify({ ...body, item: null })) - utf8ByteLength("null");
    const reduced = dropOversizedFields(item, TRACE_EVENT_MAX_BYTES - envelope);
    return reduced ? { ...body, item: reduced } : null;
  }
  if (body.type === "item.delta") {
    if (utf8ByteLength(body.delta) <= TRACE_ITEM_OUTPUT_MAX_BYTES) return body;
    return { ...body, delta: utf8Head(utf8Encoder.encode(body.delta), TRACE_ITEM_OUTPUT_MAX_BYTES) };
  }
  return utf8ByteLength(JSON.stringify(body)) <= TRACE_EVENT_MAX_BYTES ? body : null;
}
