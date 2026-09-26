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
 * The event types the daemon actually produces today, read from the writers
 * rather than inferred from the viewer:
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
 */
export const TRACE_EVENT_TYPES = [
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

export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

const TRACE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(TRACE_EVENT_TYPES);

export function isTraceEventType(value: unknown): value is TraceEventType {
  return typeof value === "string" && TRACE_EVENT_TYPE_SET.has(value);
}

/**
 * Server-side backstop caps for one event's fields, in bytes.
 *
 * These are the values `store/repos/tasks-repo.ts` applies today
 * (`TASK_MESSAGE_TEXT_MAX`, `TASK_MESSAGE_OUTPUT_MAX`, `TASK_MESSAGE_INPUT_MAX`,
 * `TASK_MESSAGE_META_MAX`, `TASK_MESSAGE_TOOL_MAX`). A-6 deletes that duplicate
 * when the `POST /tasks/:id/messages` write path goes away; until then the two
 * must not drift, so change them in both places or not at all.
 */
export const TRACE_EVENT_TOOL_MAX_BYTES = 512;
export const TRACE_EVENT_CONTENT_MAX_BYTES = 256 * 1024;
export const TRACE_EVENT_INPUT_MAX_BYTES = 256 * 1024;
export const TRACE_EVENT_OUTPUT_MAX_BYTES = 64 * 1024;
export const TRACE_EVENT_META_MAX_BYTES = 64 * 1024;

/** Structured-field guards, mirroring `sanitizeTaskMessageJson`. */
export const TRACE_EVENT_JSON_MAX_DEPTH = 8;
export const TRACE_EVENT_JSON_MAX_ARRAY = 256;

/** Tool statuses the write path accepts; anything else is dropped to null. */
export const TRACE_EVENT_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;

export type TraceEventStatus = (typeof TRACE_EVENT_STATUSES)[number];

/**
 * One event as a producer hands it over, before the store assigns a sequence.
 *
 * `ts` is the moment the producer observed the event, in ms since epoch — not the
 * write time. Replayed frames keep their original `ts`, so a viewer can order by
 * `seq` and still show honest timings.
 */
export interface TraceEventInput {
  ts: number;
  type: TraceEventType;
  tool?: string | null;
  content?: string | null;
  input?: Record<string, unknown> | null;
  output?: string | null;
  tool_call_id?: string | null;
  status?: string | null;
  meta?: Record<string, unknown> | null;
}

/**
 * One stored event.
 *
 * `seq` is dense and per task: it starts at 1 and increases by one for every
 * appended event, so `first_seq .. head` has no holes. It is assigned once by
 * {@link TraceStore.append} and never rewritten — a rewritten sequence would
 * break the Hub's "drop everything at or below head" rule and the file's
 * append-only invariant. (The legacy `TaskMessageInput.seq` fell out of
 * `TaskMessageBatcher` coalescing, which leaves gaps; that sequence is void in
 * v2.)
 *
 * The event carries no `task_id`: the container that holds it does — the
 * `trace.append` frame, the trace-file line, the Hub subscription.
 */
export interface TraceEvent extends TraceEventInput {
  seq: number;
}

/** `{ task_id }`-scoped container used by frames and file segments. */
export interface TraceEventBatch {
  task_id: string;
  events: TraceEvent[];
}

/** Lossless `TaskMessageInput` -> trace event. Used by the MUL-402 backfill. */
export function taskMessageToTraceEvent(message: TaskMessageInput, ts: number): TraceEventInput {
  return {
    ts,
    type: isTraceEventType(message.type) ? message.type : "text",
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
