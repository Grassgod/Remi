import type { Context } from "hono";
import { TRACE_READ_DEFAULT_LIMIT, TRACE_READ_MAX_LIMIT } from "@multiremi/trace/trace-reader.js";

export function parseTraceWindow(c: Context): { afterSeq: number; limit: number } | null {
  const rawAfter = c.req.query("after_seq");
  const rawLimit = c.req.query("limit");
  if (rawAfter != null && !/^(0|[1-9]\d*)$/.test(rawAfter)) return null;
  if (rawLimit != null && !/^[1-9]\d*$/.test(rawLimit)) return null;
  const afterSeq = rawAfter == null ? 0 : Number(rawAfter);
  const limit = rawLimit == null ? TRACE_READ_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(afterSeq) || !Number.isSafeInteger(limit)) return null;
  return { afterSeq, limit: Math.min(limit, TRACE_READ_MAX_LIMIT) };
}
