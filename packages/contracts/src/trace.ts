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
export const TRACE_EVENT_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;

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
