/**
 * Hand-written stand-ins for the two upstream contracts the Live Hub implements.
 *
 * 「A-0/B0 推送后对齐」— neither A-0 (MUL-401) nor B0 (MUL-425) is on this
 * branch's base (`agent/MUL-403` == `main` @ 922b332c) when C0 lands, and C0 may
 * not merge their branches. So the shapes are transcribed from the published
 * signatures and verified against their pushed commits; this file is deleted and
 * replaced by real imports the moment those commits reach `agent/MUL-403`.
 *
 * | stand-in | replace with | aligned to |
 * |---|---|---|
 * | `A0TraceEvent*`, `A0TraceSink*` | `@multiremi/api/trace/trace-sink.js` + `@multiremi/contracts/trace.js` | MUL-401 A-0, commit `5fa2a3e2`, PR #261 |
 * | `B0ConversationLogEntry` | `@multiremi/contracts/conversation-log.js` | MUL-425 B0, commit `fe7810c9`, PR #262 |
 *
 * The A-0 shapes are reproduced in full (including the 13-value `type` union) so
 * a drift is a compile error rather than a silent widening. The B0 shape is
 * deliberately the subset the hub reads — `session_id`, `seq`, `revision`,
 * `kind`, `visibility` — which accepts B0's full 18-field `ConversationLogEntry`
 * structurally; `tests/unit/multiremi/live-hub-contract.test.ts` proves that
 * against a full-field probe of B0's published row.
 *
 * Nothing on the request path imports this file.
 */

// ─── A-0 (MUL-401): the daemon trace stream ─────────────────────────────────────────────────────

/** A-0 `TRACE_EVENT_TYPES`: the event types the daemon actually writes. */
export const A0_TRACE_EVENT_TYPES = [
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

export type A0TraceEventType = (typeof A0_TRACE_EVENT_TYPES)[number];

/**
 * A-0 `TraceEvent`. `seq` is the daemon's own dense, append-only trace sequence
 * and is never rewritten by the server; `task_id` lives on the container, not on
 * the event.
 */
export interface A0TraceEvent {
  seq: number;
  ts: number;
  type: A0TraceEventType;
  tool?: string | null;
  content?: string | null;
  input?: Record<string, unknown> | null;
  output?: string | null;
  tool_call_id?: string | null;
  status?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface A0TraceSinkAppendResult {
  head: number;
}

/**
 * A-0 `TraceSinkSubscription`. Note `gap` is a **boolean** here, unlike the
 * keyed `HubSubscription` in `@multiremi/contracts/live-hub`, where it is the
 * missing range. The two shapes are reachable through the two `subscribe`
 * overloads; the difference is intentional and pinned by the contract test.
 */
export interface A0TraceSinkSubscription {
  first_seq: number;
  head: number;
  gap: boolean;
  unsubscribe(): void;
}

export type A0TraceSinkListener = (taskId: string, events: A0TraceEvent[]) => void;

/** A-0 `TraceSink`. `end` stays optional exactly as upstream declares it. */
export interface A0TraceSink {
  append(taskId: string, events: A0TraceEvent[]): A0TraceSinkAppendResult;
  head(taskId: string): number | null;
  subscribe(taskId: string, fromSeq: number, onEvents: A0TraceSinkListener): A0TraceSinkSubscription;
  end?(taskId: string): void;
}

// ─── B0 (MUL-425): the conversation log row ─────────────────────────────────────────────────────

/**
 * B0 `ConversationLogEntry`, narrowed to the fields the hub reads.
 *
 * The real row is keyed by `(session_id, seq)` and carries `id`, `kind`,
 * `visibility`, `author_type`, `author_id`, `task_id`, `body_md`, `body_html`,
 * `render_version`, `parent_id`, `metadata`, `revision`, `created_at`,
 * `updated_at` and `deleted_at`. Only the five below reach the hub: the key pair
 * to address the stream, `revision` to stamp an in-place update, and
 * `kind`/`visibility` to decide whether a row is a display unit or a hidden
 * marker.
 */
export interface B0ConversationLogEntry {
  session_id: string;
  seq: number;
  kind: string;
  visibility: "shown" | "hidden";
  /** Increments on every in-place update; the hub compares it against its ring. */
  revision: number;
}
