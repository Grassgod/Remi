/**
 * The one remaining hand-written stand-in for an upstream contract: MUL-402's
 * B0 conversation-log row.
 *
 * 「待 B 确认」— B0 (MUL-425, PR #262) has not landed on `agent/MUL-403` and is
 * still being revised, so its row shape is transcribed from the published commit
 * (`fe7810c9`) rather than imported. When B0 reaches this branch, delete this
 * file and import `@multiremi/contracts/conversation-log.js` instead; the hub
 * reads so few fields that the swap is mechanical.
 *
 * The A-0 half of this file is gone. A-0's final commit `43e41952` is merged into
 * this branch, so the hub imports the real modules:
 *
 * | was | now |
 * |---|---|
 * | `A0TraceEvent`, `A0TraceEventType` | `TraceEvent` from `@multiremi/contracts/trace.js` |
 * | `A0TraceSink`, `A0TraceSinkSubscription`, `A0TraceSinkListener` | the same names from `@multiremi/api/trace/trace-sink.js` |
 *
 * The B0 shape below is deliberately the subset the hub reads — `session_id`,
 * `seq`, `revision`, `kind`, `visibility` — so B0's full row is structurally
 * assignable to it; `tests/unit/multiremi/live-hub-contract.test.ts` proves that
 * against a full-field probe of B0's published `ConversationLogEntry`.
 *
 * Nothing on the request path imports this file.
 */

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
