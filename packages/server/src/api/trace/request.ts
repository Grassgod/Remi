import type { Context } from "hono";
import { TRACE_READ_DEFAULT_LIMIT, TRACE_READ_MAX_BYTES, TRACE_READ_MAX_LIMIT, type TraceReadWindow } from "@multiremi/trace/trace-reader.js";

const COUNT = /^(0|[1-9]\d*)$/;
const POSITIVE = /^[1-9]\d*$/;

/**
 * The trace read window of `GET .../trace` (PR 2 §1.3).
 *
 * - `view`: `turn` (default) or `events`.
 * - `view=turn` pages items from `item_cursor` (an item index, default 0).
 * - `view=events` pages raw stored lines after `after_seq` (default 0).
 * - `limit` (items or events, clamped to 500) and `max_bytes` (clamped to 1 MiB) apply to both.
 *
 * A cursor of the other view is rejected rather than ignored, so a client still
 * paging fragment events by `after_seq` learns it must ask for `view=events`.
 * Null means 400.
 */
export function parseTraceWindow(c: Context): TraceReadWindow | null {
  const rawView = c.req.query("view");
  const rawCursor = c.req.query("item_cursor");
  const rawAfter = c.req.query("after_seq");
  const rawLimit = c.req.query("limit");
  const rawBytes = c.req.query("max_bytes");
  if (rawView != null && rawView !== "turn" && rawView !== "events") return null;
  const view = rawView ?? "turn";
  if ((view === "turn" && rawAfter != null) || (view === "events" && rawCursor != null)) return null;
  if (rawCursor != null && !COUNT.test(rawCursor)) return null;
  if (rawAfter != null && !COUNT.test(rawAfter)) return null;
  if (rawLimit != null && !POSITIVE.test(rawLimit)) return null;
  if (rawBytes != null && !POSITIVE.test(rawBytes)) return null;
  const limit = rawLimit == null ? TRACE_READ_DEFAULT_LIMIT : Number(rawLimit);
  const maxBytes = rawBytes == null ? TRACE_READ_MAX_BYTES : Number(rawBytes);
  const cursor = Number(view === "turn" ? rawCursor ?? 0 : rawAfter ?? 0);
  if (!Number.isSafeInteger(cursor) || !Number.isSafeInteger(limit) || !Number.isSafeInteger(maxBytes)) return null;
  const budget = { limit: Math.min(limit, TRACE_READ_MAX_LIMIT), maxBytes: Math.min(maxBytes, TRACE_READ_MAX_BYTES) };
  return view === "turn" ? { view, itemCursor: cursor, ...budget } : { view, afterSeq: cursor, ...budget };
}
