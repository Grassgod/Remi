/**
 * Canonical task-trace event (MUL-401 §5). This file is the single definition of
 * a trace event: the daemon's trace file, the `trace.append` WebSocket frame, the
 * Live Hub (MUL-403) and the archived conversation log (MUL-402) all carry this
 * exact shape. Nothing may restate it.
 *
 * Field-to-field mapping with {@link TaskMessageInput} is intentional and
 * lossless: the backfill of `multiremi_task_messages` (MUL-402) must reproduce
 * every historical row, so the two shapes move together. The one naming
 * difference is `toolCallId` -> `tool_call_id`; every other field keeps its name
 * and nullability.
 */

import type { TaskMessageInput } from "./types.js";

/**
 * The event types the daemon produces today, read from the writers rather than
 * inferred from the viewer:
 *
 * - `execution`            daemon.ts (task start / model switch), acp-event-mapper
 * - `text`                 acp-event-mapper: `agent_message_chunk`
 * - `thinking`             acp-event-mapper: `agent_thought_chunk`
 * - `compaction`           acp-event-mapper: bridge compaction banner
 * - `usage`                acp-event-mapper: `usage_update` snapshot
 * - `plan`                 acp-event-mapper: `plan` snapshot
 * - `tool_use`             acp-event-mapper: `tool_call` / `tool_call_update`
 * - `tool_result`          acp-event-mapper: terminal tool frame
 * - `permission_request`   daemon.ts permission handler
 * - `permission_response`  daemon.ts permission handler
 * - `question_request`     daemon.ts elicitation handler
 * - `question_response`    daemon.ts elicitation handler
 * - `steer`                daemon.ts steer feed
 *
 * Deliberately absent: `assistant` and `error`. `assistant` was a stale writer
 * that e1d88572 removed (the mapper emits `text`), and `error` only appears in
 * frontend display unions and on the browser socket's handshake frames — no
 * daemon writer emits either as a task message. A viewer that shows error or
 * assistant rows derives them; it must not expect them on the wire.
 *
 * This list is for enumeration and histogram bucketing ONLY. It is not a
 * validator: {@link TraceEvent.type} is an open string (MUL-402 ruling 1), and an
 * event whose type is not listed here is stored, transmitted and rendered
 * verbatim rather than being rewritten or dropped. Consumers switch on the known
 * values and fall back to a generic row for anything else.
 */
export const KNOWN_TRACE_EVENT_TYPES = [
  "execution",
  "text",
  "thinking",
  "compaction",
  "usage",
  "plan",
  "tool_use",
  "tool_result",
  "permission_request",
  "permission_response",
  "question_request",
  "question_response",
  "steer",
] as const;

/**
 * The closed union of the types listed above. Named `Known...` on purpose: it
 * describes the known set, and is never the declared type of a field.
 */
export type KnownTraceEventType = (typeof KNOWN_TRACE_EVENT_TYPES)[number];

const KNOWN_TRACE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(KNOWN_TRACE_EVENT_TYPES);

/** Whether this is one of the types the daemon is known to produce today. */
export function isKnownTraceEventType(value: unknown): value is KnownTraceEventType {
  return typeof value === "string" && KNOWN_TRACE_EVENT_TYPE_SET.has(value);
}

/**
 * Tool statuses the write path accepts; anything else is normalized to null.
 *
 * This is the **single source** for the status set, and it lives with the type it
 * constrains: `TraceEvent.status` is a contract field, so the allowed values are
 * part of the wire contract. `@shared/trace-sanitize.js` derives its lookup set
 * from this constant rather than restating it, which makes "a status added here but
 * silently dropped by the sanitizer" impossible by construction — the drift a test
 * would otherwise have to catch.
 *
 * The direction is `shared -> contracts`. It is safe: `packages/contracts` is a
 * runtime leaf (no imports at all after types are erased, and no dependency on
 * `packages/shared`), so there is no cycle, and `@multiremi/contracts/*` subpath
 * imports are explicitly allowed for every package by
 * `tests/arch/package-boundaries.test.ts`.
 *
 * The byte caps and the structured guards are deliberately NOT declared here: they
 * are enforcement policy rather than wire shape, and their single home is
 * `@shared/trace-sanitize.js`.
 */
export const TRACE_EVENT_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"] as const;

export type TraceEventStatus = (typeof TRACE_EVENT_STATUSES)[number];

/**
 * One stored event.
 *
 * `seq` is dense and per task: it starts at 1 and increases by one for every
 * appended event, so `first_seq .. head` has no holes. It is assigned at the
 * durable write by {@link TraceStore.append} and never rewritten — a rewritten
 * sequence would break the Hub's "drop everything at or below head" rule and the
 * file's append-only invariant. (The legacy `TaskMessageInput.seq` fell out of
 * `TaskMessageBatcher` coalescing, which leaves gaps; that sequence is void in
 * v2.)
 *
 * `ts` is an **ISO 8601 string**, not a number: it is the moment the event was
 * observed, and a backfilled event takes `task_messages.created_at` verbatim so
 * the two can be compared field for field. The numeric `ts` on the frame
 * envelope is a different thing and is unaffected.
 *
 * `type` is an open string. See {@link KNOWN_TRACE_EVENT_TYPES}.
 *
 * The event carries no `task_id`: the container that holds it does — the
 * `trace.append` frame's payload, the trace-file header, the Hub subscription.
 *
 * Runtime/context completeness is carried by `{ head, closed }` rather than by a
 * terminator event: there is no `trace.end` event type (MUL-402 ruling 3).
 */
export interface TraceEvent {
  seq: number;
  ts: string;
  type: string;
  tool?: string | null;
  content?: string | null;
  input?: Record<string, unknown> | null;
  output?: string | null;
  tool_call_id?: string | null;
  status?: string | null;
  meta?: Record<string, unknown> | null;
}

/**
 * An event as a producer hands it over: no `seq`, and normally no `ts`.
 *
 * `seq` is always the store's to assign. `ts` is too in the live path, where the
 * store stamps the write time, so a producer omits it — but the backfill must
 * supply it, because a reproduced historical turn has to keep the row's original
 * `created_at` rather than the moment of the migration. Hence `ts` is optional
 * here and the store's rule is "use the event's `ts` when it has one, otherwise
 * stamp the clock".
 *
 * (MUL-402's A2 wrote the input as `Omit<TraceEvent, "seq" | "ts">` with the store
 * assigning both. That is the live path and this type is that type plus the
 * backfill's timestamp; without the field there is no way to express
 * `ts = task_messages.created_at`, which ruling 1 requires.)
 */
export type TraceEventInput = Omit<TraceEvent, "seq" | "ts"> & { ts?: string };

/** `{ task_id }`-scoped container used by frames and file segments. */
export interface TraceEventBatch {
  task_id: string;
  events: TraceEvent[];
}

/**
 * Lossless `TaskMessageInput` -> trace event, used by the MUL-402 backfill.
 *
 * Unknown type strings pass through **verbatim**; rewriting them would make the
 * backfill lossy. `ts` is the ISO timestamp to stamp the event with — for a
 * backfilled row that is the row's `created_at`.
 */
export function taskMessageToTraceEvent(message: TaskMessageInput, ts: string): TraceEventInput {
  return {
    ts,
    type: message.type,
    tool: message.tool ?? null,
    content: message.content ?? null,
    input: message.input ?? null,
    output: message.output ?? null,
    tool_call_id: message.toolCallId ?? null,
    status: message.status ?? null,
    meta: message.meta ?? null,
  };
}

/** Lossless trace event -> `TaskMessageInput`, for readers not yet on the Hub. */
export function traceEventToTaskMessage(event: TraceEvent): TaskMessageInput {
  return {
    seq: event.seq,
    type: event.type,
    tool: event.tool ?? null,
    content: event.content ?? null,
    input: event.input ?? null,
    output: event.output ?? null,
    toolCallId: event.tool_call_id ?? null,
    status: event.status ?? null,
    meta: event.meta ?? null,
  };
}

// ── Turn + items trace (PR 2) ───────────────────────────────────────────────
//
// The types below replace the fragment `TraceEvent` above. They land next to it
// first (P1, additive); P2 renames the old `TraceEvent` to `LegacyTraceEvent` and
// `TurnTraceEvent` to `TraceEvent`. Until then nothing writes them.
//
// A trace is one turn attempt: a `TraceTurn` plus the `TraceItem`s that happened
// in it, each a complete record (Codex app-server v2 Turn / Item model). Events
// carry whole items (`item.started` / `item.updated` / `item.completed`) plus
// appends (`item.delta`); `@multiremi/shared/turn-trace` is the one fold every
// reader uses.
//
// This module stays a runtime leaf (no value imports): the web bundles it
// through `@multiremi/shared/turn-trace`.

export const TRACE_ITEM_STATUSES = ["in_progress", "completed", "failed", "declined", "stopped"] as const;
export type TraceItemStatus = (typeof TRACE_ITEM_STATUSES)[number];

export const TRACE_TURN_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type TraceTurnStatus = (typeof TRACE_TURN_STATUSES)[number];

/** Context-window occupancy the bridge last reported for the turn. */
export interface TraceContextUsage {
  used: number;
  size: number;
}

/** One `(item type, tool)` bucket; `tool` is set only for items that name a tool. */
export interface TraceHistogramBucket {
  type: TraceItemType;
  tool: string | null;
  count: number;
}

export interface TraceTurnStats {
  /** Every item, at any depth. */
  item_count: number;
  /** command|file_change|web_search|tool|subagent items, any depth. The single tool-count rule. */
  tool_call_count: number;
  /** Top-level items other than user_message and the final agent_message. */
  process_item_count: number;
  type_histogram: TraceHistogramBucket[];
}

export interface TraceTurn {
  /** Attempt id (= task id, trace file key). */
  id: string;
  turn_id: string | null;
  agent_id: string;
  agent_name: string | null;
  provider: string;
  requested_model: string | null;
  /** Last model the bridge/provider reported. */
  model: string | null;
  status: TraceTurnStatus;
  error: { message: string; reason: string | null } | null;
  /** ISO 8601. */
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  final_item_id: string | null;
  /** Start of the final reply ("Worked for" end point). */
  final_started_at: string | null;
  context_usage: TraceContextUsage | null;
  stats: TraceTurnStats;
}

/** What `turn.updated` may change while the turn runs. */
export type TraceTurnPatch = Partial<Pick<TraceTurn, "model" | "requested_model" | "agent_name" | "context_usage">>;

export interface TraceItemBase {
  id: string;
  /** Owning subagent item id; null for top-level items. */
  parent_id: string | null;
  status: TraceItemStatus;
  started_at: string;
  completed_at: string | null;
  /** Reader-side only: seq of the last event applied by the reducer. Producers never set it. */
  seq?: number;
}

/** One parsed step of a shell command (port of Codex `ParsedCommand`). */
export type CommandAction =
  | { type: "read"; command: string | null; name: string; path: string }
  | { type: "list_files"; command: string | null; path: string | null }
  | { type: "search"; command: string | null; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export interface FileChange {
  path: string;
  kind: "add" | "update" | "delete";
  move_path: string | null;
  /** Unified body lines (" ", "+", "-"; "@@" separators, no line numbers). */
  diff: string | null;
  added: number;
  removed: number;
  diff_truncated?: true;
}

export interface TraceUserMessageItem extends TraceItemBase {
  type: "user_message";
  origin: "input" | "steer";
  text: string;
  message_ids: string[];
  attachments: Array<{ id: string; name: string | null }>;
  steer: {
    steer_id: string;
    kind: string;
    injected: boolean;
    author_type: string | null;
    author_id: string | null;
  } | null;
  truncated?: true;
}

export interface TraceAgentMessageItem extends TraceItemBase {
  type: "agent_message";
  text: string;
  phase: "commentary" | "final" | "unknown";
  truncated?: true;
}

export interface TraceReasoningItem extends TraceItemBase {
  type: "reasoning";
  text: string;
  truncated?: true;
}

export interface TraceCommandItem extends TraceItemBase {
  type: "command";
  tool: string;
  source: "shell" | "tool";
  command: string | null;
  cwd: string | null;
  actions: CommandAction[];
  output: string | null;
  output_truncated?: true;
  exit_code: number | null;
  duration_ms: number | null;
}

export interface TraceFileChangeItem extends TraceItemBase {
  type: "file_change";
  tool: string;
  changes: FileChange[];
  output: string | null;
  duration_ms: number | null;
}

export interface TraceWebSearchItem extends TraceItemBase {
  type: "web_search";
  tool: string;
  action: "search" | "fetch";
  query: string | null;
  url: string | null;
  output: string | null;
  duration_ms: number | null;
}

export interface TraceToolItem extends TraceItemBase {
  type: "tool";
  tool: string;
  server: string | null;
  kind: string | null;
  title: string | null;
  input: Record<string, unknown> | null;
  output: string | null;
  output_truncated?: true;
  duration_ms: number | null;
}

export interface TraceSubagentItem extends TraceItemBase {
  type: "subagent";
  tool: string;
  title: string | null;
  prompt: string | null;
  output: string | null;
  duration_ms: number | null;
}

export interface TracePlanItem extends TraceItemBase {
  type: "plan";
  entries: Array<{ content: string; status: "pending" | "in_progress" | "completed"; priority: string | null }>;
}

export interface TracePermissionItem extends TraceItemBase {
  type: "permission";
  tool_item_id: string | null;
  title: string;
  message_id: string | null;
  options: Array<{ option_id: string; name: string; kind: string }>;
  decision: { option_id: string; name: string; kind: string } | null;
  outcome: "selected" | "cancelled" | "timeout" | null;
  responded_by: string | null;
  reply_message_id: string | null;
}

export interface TraceQuestionItem extends TraceItemBase {
  type: "question";
  tool_item_id: string | null;
  message: string;
  message_id: string | null;
  questions: unknown[];
  answers: Record<string, string> | null;
  responded_by: string | null;
  reply_message_id: string | null;
}

export interface TraceCompactionItem extends TraceItemBase {
  type: "compaction";
  trigger: "automatic" | "manual" | null;
  summary: string | null;
  pre_tokens: number | null;
  post_tokens: number | null;
  error: string | null;
}

export interface TraceNoticeItem extends TraceItemBase {
  type: "notice";
  severity: "info" | "warning" | "error";
  title: string;
  description: string | null;
  category: string | null;
  error_kind: string | null;
}

export type TraceItem =
  | TraceUserMessageItem
  | TraceAgentMessageItem
  | TraceReasoningItem
  | TraceCommandItem
  | TraceFileChangeItem
  | TraceWebSearchItem
  | TraceToolItem
  | TraceSubagentItem
  | TracePlanItem
  | TracePermissionItem
  | TraceQuestionItem
  | TraceCompactionItem
  | TraceNoticeItem;

export type TraceItemType = TraceItem["type"];
export type TraceItemOf<T extends TraceItemType> = Extract<TraceItem, { type: T }>;

/** `Record` keyed by the union, so a variant added above without a row here fails to compile. */
const TRACE_ITEM_TYPE_SET: Record<TraceItemType, true> = {
  user_message: true,
  agent_message: true,
  reasoning: true,
  command: true,
  file_change: true,
  web_search: true,
  tool: true,
  subagent: true,
  plan: true,
  permission: true,
  question: true,
  compaction: true,
  notice: true,
};
export const TRACE_ITEM_TYPES = Object.keys(TRACE_ITEM_TYPE_SET) as readonly TraceItemType[];

/** The item types that count as a tool call. The single tool-count rule (any depth). */
export const TRACE_TOOL_ITEM_TYPES = ["command", "file_change", "web_search", "tool", "subagent"] as const;
export type TraceToolItemType = (typeof TRACE_TOOL_ITEM_TYPES)[number];

/** A trace event as the producer writes it; the store adds `seq` and `ts`. */
export type TraceEventBody =
  | { type: "turn.started"; turn: TraceTurn }
  | { type: "turn.updated"; patch: TraceTurnPatch }
  | { type: "turn.completed"; turn: TraceTurn }
  | { type: "item.started"; item: TraceItem }
  /** Full replacement of an in-progress item (late command text, plan snapshot, hook diff). */
  | { type: "item.updated"; item: TraceItem }
  | { type: "item.delta"; item_id: string; field: "text" | "output"; delta: string }
  | { type: "item.completed"; item: TraceItem };

export type TurnTraceEventType = TraceEventBody["type"];

/**
 * One stored turn-trace event. `seq` is dense per attempt and `ts` is the write
 * time; both are assigned by `TraceStore.append`, exactly as for the fragment
 * events above. P2 renames this to `TraceEvent`.
 */
export type TurnTraceEvent = { seq: number; ts: string } & TraceEventBody;

/** What a producer hands the store. P2 renames this to `TraceEventInput` (no `ts` override). */
export type TurnTraceEventInput = TraceEventBody;

const TURN_TRACE_EVENT_TYPE_SET: Record<TurnTraceEventType, true> = {
  "turn.started": true,
  "turn.updated": true,
  "turn.completed": true,
  "item.started": true,
  "item.updated": true,
  "item.delta": true,
  "item.completed": true,
};
/** Readers skip any other `type` rather than failing. P2 renames this to `KNOWN_TRACE_EVENT_TYPES`. */
export const KNOWN_TURN_TRACE_EVENT_TYPES = Object.keys(TURN_TRACE_EVENT_TYPE_SET) as ReadonlyArray<TurnTraceEventType>;

/** The fold at `head`; `closed` once the trailer exists. */
export interface TraceTurnSnapshot {
  turn: TraceTurn;
  items: TraceItem[];
  head: number;
  closed: boolean;
}

/** `view=turn` page of a trace read. A v1 file answers `format: "legacy"` with no turn and no items. */
export interface TraceTurnPage {
  view: "turn";
  format: "v2" | "legacy";
  turn: TraceTurn | null;
  items: TraceItem[];
  /** Index of the next item; null = last page. */
  next_item_cursor: number | null;
  head: number;
  closed: boolean;
}

/** `view=events` page: raw stored lines, v1 files included (CLI `--raw`). */
export interface TraceEventPage {
  view: "events";
  format: "v2" | "legacy";
  events: Array<Record<string, unknown> & { seq: number; ts: string; type: string }>;
  next_after_seq: number;
  head: number;
  eof: boolean;
  closed: boolean;
}

// ── Runtime validators ──────────────────────────────────────────────────────
//
// Wire-boundary checks for the shapes above: socket replies, file lines and the
// reducer's input. They check what readers depend on (discriminants, ids,
// statuses, timestamps and the type of every declared field) and accept extra
// keys, so a newer producer's additions never make an old reader drop an item.

/** ISO 8601 with a real calendar date and an explicit zone, e.g. `2026-10-15T00:00:00.000Z`. */
export function isTraceTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return calendar.getUTCFullYear() === Number(year) && calendar.getUTCMonth() + 1 === Number(month)
    && calendar.getUTCDate() === Number(day) && Number(hour) < 24 && Number(minute) < 60
    && Number(second) < 60 && (offsetHour === undefined || (Number(offsetHour) < 24 && Number(offsetMinute) < 60));
}

const ITEM_STATUS_SET: ReadonlySet<string> = new Set(TRACE_ITEM_STATUSES);
const TURN_STATUS_SET: ReadonlySet<string> = new Set(TRACE_TURN_STATUSES);

export function isTraceItemStatus(value: unknown): value is TraceItemStatus {
  return typeof value === "string" && ITEM_STATUS_SET.has(value);
}

export function isTraceTurnStatus(value: unknown): value is TraceTurnStatus {
  return typeof value === "string" && TURN_STATUS_SET.has(value);
}

export function isTraceItemType(value: unknown): value is TraceItemType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TRACE_ITEM_TYPE_SET, value);
}

export function isKnownTurnTraceEventType(value: unknown): value is TurnTraceEventType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TURN_TRACE_EVENT_TYPE_SET, value);
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}
function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function isNullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}
function isOptionalTrue(value: unknown): boolean {
  return value === undefined || value === true;
}
function isOneOf(value: unknown, allowed: readonly unknown[]): boolean {
  return allowed.includes(value);
}
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isTraceContextUsage(value: unknown): value is TraceContextUsage {
  return isRow(value) && typeof value.used === "number" && Number.isFinite(value.used) && value.used >= 0
    && typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0;
}

function isHistogramBucket(value: unknown): boolean {
  return isRow(value) && isTraceItemType(value.type) && isNullableString(value.tool) && isCount(value.count);
}

export function isTraceTurnStats(value: unknown): value is TraceTurnStats {
  return isRow(value) && isCount(value.item_count) && isCount(value.tool_call_count)
    && isCount(value.process_item_count)
    && Array.isArray(value.type_histogram) && value.type_histogram.every(isHistogramBucket);
}

export function isTraceTurn(value: unknown): value is TraceTurn {
  if (!isRow(value)) return false;
  const error = value.error;
  return isNonEmptyString(value.id) && isNullableString(value.turn_id)
    && isNonEmptyString(value.agent_id) && isNullableString(value.agent_name)
    && isNonEmptyString(value.provider) && isNullableString(value.requested_model) && isNullableString(value.model)
    && isTraceTurnStatus(value.status)
    && (error === null || (isRow(error) && typeof error.message === "string" && isNullableString(error.reason)))
    && isTraceTimestamp(value.started_at)
    && (value.completed_at === null || isTraceTimestamp(value.completed_at))
    && isNullableNumber(value.duration_ms)
    && isNullableString(value.final_item_id)
    && (value.final_started_at === null || isTraceTimestamp(value.final_started_at))
    && (value.context_usage === null || isTraceContextUsage(value.context_usage))
    && isTraceTurnStats(value.stats);
}

/** Only the patchable keys, each well-typed; an empty patch is valid. */
export function isTraceTurnPatch(value: unknown): value is TraceTurnPatch {
  if (!isRow(value)) return false;
  for (const [key, field] of Object.entries(value)) {
    if (key === "model" || key === "requested_model" || key === "agent_name") {
      if (!isNullableString(field)) return false;
    } else if (key === "context_usage") {
      if (field !== null && !isTraceContextUsage(field)) return false;
    } else {
      return false;
    }
  }
  return true;
}

export function isCommandAction(value: unknown): value is CommandAction {
  if (!isRow(value)) return false;
  switch (value.type) {
    case "read":
      return isNullableString(value.command) && typeof value.name === "string" && typeof value.path === "string";
    case "list_files":
      return isNullableString(value.command) && isNullableString(value.path);
    case "search":
      return isNullableString(value.command) && isNullableString(value.query) && isNullableString(value.path);
    case "unknown":
      return typeof value.command === "string";
    default:
      return false;
  }
}

export function isFileChange(value: unknown): value is FileChange {
  return isRow(value) && typeof value.path === "string" && isOneOf(value.kind, ["add", "update", "delete"])
    && isNullableString(value.move_path) && isNullableString(value.diff)
    && isCount(value.added) && isCount(value.removed) && isOptionalTrue(value.diff_truncated);
}

function isDecisionOption(value: unknown): boolean {
  return isRow(value) && typeof value.option_id === "string" && typeof value.name === "string" && typeof value.kind === "string";
}

function isItemBase(value: Row): boolean {
  return isNonEmptyString(value.id) && isNullableString(value.parent_id) && isTraceItemStatus(value.status)
    && isTraceTimestamp(value.started_at) && (value.completed_at === null || isTraceTimestamp(value.completed_at))
    && (value.seq === undefined || (Number.isSafeInteger(value.seq) && (value.seq as number) >= 1));
}

export function isTraceItem(value: unknown): value is TraceItem {
  if (!isRow(value) || !isItemBase(value)) return false;
  const v = value;
  switch (v.type) {
    case "user_message": {
      const steer = v.steer;
      return isOneOf(v.origin, ["input", "steer"]) && typeof v.text === "string" && isStringArray(v.message_ids)
        && Array.isArray(v.attachments)
        && v.attachments.every((a) => isRow(a) && typeof a.id === "string" && isNullableString(a.name))
        && (steer === null || (isRow(steer) && typeof steer.steer_id === "string" && typeof steer.kind === "string"
          && typeof steer.injected === "boolean" && isNullableString(steer.author_type) && isNullableString(steer.author_id)))
        && isOptionalTrue(v.truncated);
    }
    case "agent_message":
      return typeof v.text === "string" && isOneOf(v.phase, ["commentary", "final", "unknown"]) && isOptionalTrue(v.truncated);
    case "reasoning":
      return typeof v.text === "string" && isOptionalTrue(v.truncated);
    case "command":
      return typeof v.tool === "string" && isOneOf(v.source, ["shell", "tool"]) && isNullableString(v.command)
        && isNullableString(v.cwd) && Array.isArray(v.actions) && v.actions.every(isCommandAction)
        && isNullableString(v.output) && isOptionalTrue(v.output_truncated)
        && (v.exit_code === null || Number.isSafeInteger(v.exit_code)) && isNullableNumber(v.duration_ms);
    case "file_change":
      return typeof v.tool === "string" && Array.isArray(v.changes) && v.changes.every(isFileChange)
        && isNullableString(v.output) && isNullableNumber(v.duration_ms);
    case "web_search":
      return typeof v.tool === "string" && isOneOf(v.action, ["search", "fetch"]) && isNullableString(v.query)
        && isNullableString(v.url) && isNullableString(v.output) && isNullableNumber(v.duration_ms);
    case "tool":
      return typeof v.tool === "string" && isNullableString(v.server) && isNullableString(v.kind)
        && isNullableString(v.title) && (v.input === null || isRow(v.input)) && isNullableString(v.output)
        && isOptionalTrue(v.output_truncated) && isNullableNumber(v.duration_ms);
    case "subagent":
      return typeof v.tool === "string" && isNullableString(v.title) && isNullableString(v.prompt)
        && isNullableString(v.output) && isNullableNumber(v.duration_ms);
    case "plan":
      return Array.isArray(v.entries) && v.entries.every((entry) => isRow(entry) && typeof entry.content === "string"
        && isOneOf(entry.status, ["pending", "in_progress", "completed"]) && isNullableString(entry.priority));
    case "permission":
      return isNullableString(v.tool_item_id) && typeof v.title === "string" && isNullableString(v.message_id)
        && Array.isArray(v.options) && v.options.every(isDecisionOption)
        && (v.decision === null || isDecisionOption(v.decision))
        && isOneOf(v.outcome, ["selected", "cancelled", "timeout", null])
        && isNullableString(v.responded_by) && isNullableString(v.reply_message_id);
    case "question":
      return isNullableString(v.tool_item_id) && typeof v.message === "string" && isNullableString(v.message_id)
        && Array.isArray(v.questions)
        && (v.answers === null || (isRow(v.answers) && Object.values(v.answers).every((a) => typeof a === "string")))
        && isNullableString(v.responded_by) && isNullableString(v.reply_message_id);
    case "compaction":
      return isOneOf(v.trigger, ["automatic", "manual", null]) && isNullableString(v.summary)
        && isNullableNumber(v.pre_tokens) && isNullableNumber(v.post_tokens) && isNullableString(v.error);
    case "notice":
      return isOneOf(v.severity, ["info", "warning", "error"]) && typeof v.title === "string"
        && isNullableString(v.description) && isNullableString(v.category) && isNullableString(v.error_kind);
    default:
      return false;
  }
}

/** A producer-side body: a known `type` with a well-formed payload. */
export function isTraceEventBody(value: unknown): value is TraceEventBody {
  if (!isRow(value)) return false;
  switch (value.type) {
    case "turn.started":
    case "turn.completed":
      return isTraceTurn(value.turn);
    case "turn.updated":
      return isTraceTurnPatch(value.patch);
    case "item.started":
    case "item.updated":
    case "item.completed":
      return isTraceItem(value.item);
    case "item.delta":
      return isNonEmptyString(value.item_id) && isOneOf(value.field, ["text", "output"]) && typeof value.delta === "string";
    default:
      return false;
  }
}

/**
 * A stored event: `seq >= 1`, a valid `ts` and a well-formed known body. Readers
 * call this per event and skip what fails, so one bad or newer line costs one row.
 */
export function isTurnTraceEvent(value: unknown): value is TurnTraceEvent {
  return isRow(value) && Number.isSafeInteger(value.seq) && (value.seq as number) >= 1
    && isTraceTimestamp(value.ts) && isTraceEventBody(value);
}

export function isTraceTurnSnapshot(value: unknown): value is TraceTurnSnapshot {
  return isRow(value) && isTraceTurn(value.turn) && Array.isArray(value.items) && value.items.every(isTraceItem)
    && isCount(value.head) && typeof value.closed === "boolean";
}
