/**
 * Task traces (MUL-401 §5, PR 2). This file is the single definition of a trace
 * event: the daemon's trace file, the `trace.append` WebSocket frame, the Live
 * Hub (MUL-403) and every reader carry these exact shapes. Nothing may restate
 * them.
 *
 * Since PR 2 (ADR 0019) a trace is one turn attempt as "turn + items"
 * ({@link TraceEvent}, below). v1 files written before it hold fragment events
 * of an open shape; they are read-only and only ever surface as raw lines
 * ({@link TraceEventLine}, `view=events`).
 */

// ── Turn + items trace (PR 2) ───────────────────────────────────────────────
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
  /**
   * Top-level items that produce a Chat fold row: not user_message, permission,
   * question, reasoning, the final agent_message, or an agent_message with no
   * visible text (decision D-count).
   */
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

/**
 * What a bridge's native steer call answered (ACP `_session/steering`, ADR 0020).
 * `SteerOutcome` in `provider-types.ts` is this type; it lives here so the trace
 * stays a runtime leaf.
 */
export const TRACE_STEER_OUTCOMES = ["injected", "promptRequired", "startedNewTurn", "failed", "unsupported"] as const;
export type TraceSteerOutcome = (typeof TRACE_STEER_OUTCOMES)[number];

/**
 * How a steer reached the agent (ADR 0020 "Native steering"):
 * - `native`: injected into the running prompt by the bridge;
 * - `reprompt`: sent as the next prompt of the same provider session, after the
 *   native call answered `native_outcome` (null when none was made);
 * - `none`: recorded without delivery, after the force-answer grace expired.
 */
export const TRACE_STEER_DELIVERIES = ["native", "reprompt", "none"] as const;
export type TraceSteerDelivery = (typeof TRACE_STEER_DELIVERIES)[number];

export interface TraceSteerResult {
  via: TraceSteerDelivery;
  native_outcome: TraceSteerOutcome | null;
  error: string | null;
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
    /** `result.via !== "none"`. */
    injected: boolean;
    author_type: string | null;
    author_id: string | null;
    /** Absent on traces recorded before native steering (PR 3 Phase B). */
    result?: TraceSteerResult;
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
  /**
   * The model's own label for the command (Claude AIR `commandTitle`, the Bash
   * `description`), shown as the step label; the command stays in the detail.
   * Absent when the bridge sends none and in traces written before it existed.
   */
  title?: string | null;
  /** `command`, `cwd` or an action's `command` was capped (or dropped to fit an event). */
  command_truncated?: true;
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
  output_truncated?: true;
  duration_ms: number | null;
}

export interface TraceWebSearchItem extends TraceItemBase {
  type: "web_search";
  tool: string;
  action: "search" | "fetch";
  query: string | null;
  url: string | null;
  output: string | null;
  output_truncated?: true;
  duration_ms: number | null;
}

export interface TraceToolItem extends TraceItemBase {
  type: "tool";
  tool: string;
  server: string | null;
  kind: string | null;
  title: string | null;
  input: Record<string, unknown> | null;
  input_truncated?: true;
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
  output_truncated?: true;
  duration_ms: number | null;
  // Optional facts (PR 2 §13), absent when the bridge sends none and in traces
  // written before they existed.
  /** The kind of agent: Claude `subagent_type` (input or progress beat). */
  agent_type?: string | null;
  /** The agent's short name: Claude `description`, Codex agent path. */
  name?: string | null;
  /**
   * Runs in the background, as the bridge's hook reports it: true for an async
   * launch (`toolResponse.isAsync` / `async_launched`), false for a foreground
   * result, absent before the hook says. Never taken from the input's
   * `run_in_background` request. A background subagent stays `in_progress` after
   * its launch is acknowledged and ends when the turn closes.
   */
  background?: boolean | null;
  /** The model the subagent was asked to use, when the call names one. */
  model?: string | null;
  /** The child thread: Codex `agentThreadId` / `receiverThreadIds[0]`. */
  thread_id?: string | null;
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

export type TraceEventType = TraceEventBody["type"];

/**
 * One stored trace event. `seq` is dense per attempt, from 1, and never
 * rewritten; `ts` is the ISO 8601 write time. Both are assigned by
 * `TraceStore.append`, never by a producer. The event carries no `task_id`: the
 * container that holds it does (the `trace.append` frame, the file header, the
 * Hub subscription). Completeness is `{ head, closed }`; there is no terminator
 * event (MUL-402 ruling 3) - `turn.completed` ends the turn, not the stream.
 */
export type TraceEvent = { seq: number; ts: string } & TraceEventBody;

/** What a producer hands the store: the body only. The store assigns `seq` and `ts`. */
export type TraceEventInput = TraceEventBody;

/**
 * A stored line of either format, as the transport and the `view=events` read
 * carry it: v2 lines are {@link TraceEvent}s, v1 lines are fragment events.
 * Payloads are opaque at this level; a reader that needs a typed event checks it
 * with {@link isTraceEvent} and skips what fails.
 */
export type TraceEventLine = Record<string, unknown> & { seq: number; ts: string; type: string };

const TRACE_EVENT_TYPE_SET: Record<TraceEventType, true> = {
  "turn.started": true,
  "turn.updated": true,
  "turn.completed": true,
  "item.started": true,
  "item.updated": true,
  "item.delta": true,
  "item.completed": true,
};
/** The event types; readers skip any other `type` rather than failing. */
export const KNOWN_TRACE_EVENT_TYPES = Object.keys(TRACE_EVENT_TYPE_SET) as ReadonlyArray<TraceEventType>;

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
  events: TraceEventLine[];
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

export function isKnownTraceEventType(value: unknown): value is TraceEventType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TRACE_EVENT_TYPE_SET, value);
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
function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNullableBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "boolean";
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

/** A well-formed bucket; its `type` may be an item type this build does not know. */
function isHistogramBucketShape(value: unknown): value is Row {
  return isRow(value) && isNonEmptyString(value.type) && isNullableString(value.tool) && isCount(value.count);
}

/**
 * Stats with well-formed counts and buckets. Forward compatible (spec §12): a
 * bucket whose item type a newer producer added is dropped from
 * `type_histogram` in place, so the turn still validates.
 */
export function isTraceTurnStats(value: unknown): value is TraceTurnStats {
  if (!isRow(value) || !isCount(value.item_count) || !isCount(value.tool_call_count)
    || !isCount(value.process_item_count)
    || !Array.isArray(value.type_histogram) || !value.type_histogram.every(isHistogramBucketShape)) return false;
  const histogram = value.type_histogram as Row[];
  if (!histogram.every((bucket) => isTraceItemType(bucket.type))) {
    value.type_histogram = histogram.filter((bucket) => isTraceItemType(bucket.type));
  }
  return true;
}

/**
 * A well-formed turn. Histogram buckets of unknown item types are dropped in
 * place rather than rejecting the turn ({@link isTraceTurnStats}).
 */
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

export function isTraceSteerResult(value: unknown): value is TraceSteerResult {
  return isRow(value) && isOneOf(value.via, TRACE_STEER_DELIVERIES)
    && (value.native_outcome === null || isOneOf(value.native_outcome, TRACE_STEER_OUTCOMES))
    && isNullableString(value.error);
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
          && typeof steer.injected === "boolean" && isNullableString(steer.author_type) && isNullableString(steer.author_id)
          && (steer.result === undefined || isTraceSteerResult(steer.result))))
        && isOptionalTrue(v.truncated);
    }
    case "agent_message":
      return typeof v.text === "string" && isOneOf(v.phase, ["commentary", "final", "unknown"]) && isOptionalTrue(v.truncated);
    case "reasoning":
      return typeof v.text === "string" && isOptionalTrue(v.truncated);
    case "command":
      return typeof v.tool === "string" && isOneOf(v.source, ["shell", "tool"]) && isNullableString(v.command)
        && isNullableString(v.cwd) && Array.isArray(v.actions) && v.actions.every(isCommandAction)
        && isOptionalNullableString(v.title) && isOptionalTrue(v.command_truncated) && isNullableString(v.output) && isOptionalTrue(v.output_truncated)
        && (v.exit_code === null || Number.isSafeInteger(v.exit_code)) && isNullableNumber(v.duration_ms);
    case "file_change":
      return typeof v.tool === "string" && Array.isArray(v.changes) && v.changes.every(isFileChange)
        && isNullableString(v.output) && isOptionalTrue(v.output_truncated) && isNullableNumber(v.duration_ms);
    case "web_search":
      return typeof v.tool === "string" && isOneOf(v.action, ["search", "fetch"]) && isNullableString(v.query)
        && isNullableString(v.url) && isNullableString(v.output) && isOptionalTrue(v.output_truncated)
        && isNullableNumber(v.duration_ms);
    case "tool":
      return typeof v.tool === "string" && isNullableString(v.server) && isNullableString(v.kind)
        && isNullableString(v.title) && (v.input === null || isRow(v.input)) && isOptionalTrue(v.input_truncated)
        && isNullableString(v.output) && isOptionalTrue(v.output_truncated) && isNullableNumber(v.duration_ms);
    case "subagent":
      return typeof v.tool === "string" && isNullableString(v.title) && isNullableString(v.prompt)
        && isNullableString(v.output) && isOptionalTrue(v.output_truncated) && isNullableNumber(v.duration_ms)
        && isOptionalNullableString(v.agent_type) && isOptionalNullableString(v.name)
        && isOptionalNullableBoolean(v.background) && isOptionalNullableString(v.model)
        && isOptionalNullableString(v.thread_id);
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
export function isTraceEvent(value: unknown): value is TraceEvent {
  return isRow(value) && Number.isSafeInteger(value.seq) && (value.seq as number) >= 1
    && isTraceTimestamp(value.ts) && isTraceEventBody(value);
}

/**
 * The items of a snapshot a reader can use, or null when one is damaged.
 * Forward compatible (spec §13): an item whose `type` this build does not know,
 * from a newer producer, is dropped; an item of a known type that fails its
 * validator, or a row with no type, rejects the whole list. A newer producer
 * therefore adds facts only as new optional fields or new item types, never as
 * new `status` or `type` values on existing items (ADR 0019 decision 1).
 */
export function knownTraceItems(items: unknown): TraceItem[] | null {
  if (!Array.isArray(items)) return null;
  const known: TraceItem[] = [];
  for (const item of items) {
    if (isTraceItem(item)) known.push(item);
    else if (!isRow(item) || !isNonEmptyString(item.type) || isTraceItemType(item.type)) return null;
  }
  return known;
}

/**
 * A well-formed snapshot. Items of unknown types are dropped from `items` in
 * place ({@link knownTraceItems}), as unknown histogram buckets are.
 */
export function isTraceTurnSnapshot(value: unknown): value is TraceTurnSnapshot {
  if (!isRow(value) || !isTraceTurn(value.turn) || !isCount(value.head) || typeof value.closed !== "boolean") return false;
  const items = knownTraceItems(value.items);
  if (!items) return false;
  if (items.length !== (value.items as unknown[]).length) value.items = items;
  return true;
}
