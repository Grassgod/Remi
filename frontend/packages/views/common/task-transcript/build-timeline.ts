import type { TaskMessagePayload } from "@multiremi/core/types/events";
import { redactString, redactValue } from "./redact";

/** A unified timeline entry: tool calls, thinking, text, and errors in chronological order. */
export interface TimelineItem {
  seq: number;
  type:
    | "tool_use"
    | "tool_result"
    | "thinking"
    | "text"
    | "error"
    | "permission_request"
    | "permission_response"
    | "question_request"
    | "question_response";
  tool?: string;
  content?: string;
  input?: Record<string, unknown>;
  output?: string;
  /** Server insert time (ISO), when the wire carries it. */
  createdAt?: string;
  /** ACP tool call id (Batch 2+) — pairs tool_use with tool_result. */
  toolCallId?: string;
  /** ACP tool status (Batch 2+). */
  status?: string;
  /** Low-frequency display semantics (Batch 2+). */
  meta?: Record<string, unknown>;
}

/** Rolled-up token snapshot for the transcript header. */
export interface UsageSnapshot {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * A step is a paired tool_use + tool_result (grouped by tool_call_id) rendered
 * as one card; everything else stays a plain event. Older messages without a
 * tool_call_id can't be paired, so they degrade to `event` entries.
 */
export type TranscriptEntry =
  | {
      kind: "step";
      seq: number;
      toolCallId: string;
      tool?: string;
      status?: string;
      input?: Record<string, unknown>;
      output?: string;
      meta?: Record<string, unknown>;
      durationMs?: number;
      createdAt?: string;
    }
  | { kind: "event"; seq: number; item: TimelineItem };

const TERMINAL_STATUS = new Set(["completed", "failed"]);

/**
 * Fold a redacted timeline into render entries: pair tool_use/tool_result by
 * tool_call_id into step cards (input from the use, status/output/duration from
 * the result), keep everything else as events. Duration prefers the daemon's
 * meta.duration_ms and falls back to the createdAt delta between the paired
 * messages.
 */
export function buildEntries(items: TimelineItem[]): TranscriptEntry[] {
  const steps = new Map<string, Extract<TranscriptEntry, { kind: "step" }>>();
  const out: TranscriptEntry[] = [];
  // Pair in chronological (seq) order regardless of how the caller sorts for
  // display — otherwise a newest-first list processes the tool_result before
  // its tool_use, and the pending tool_use overwrites the completed status
  // (steps then show a spinner forever). The caller reverses the returned
  // entries for newest-first display.
  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  for (const item of sorted) {
    if ((item.type === "tool_use" || item.type === "tool_result") && item.toolCallId) {
      const id = item.toolCallId;
      let step = steps.get(id);
      if (!step) {
        step = { kind: "step", seq: item.seq, toolCallId: id, tool: item.tool };
        steps.set(id, step);
        out.push(step);
      }
      if (item.tool) step.tool = item.tool;
      if (item.status) step.status = item.status;
      if (item.meta) step.meta = { ...step.meta, ...item.meta };
      if (item.createdAt && !step.createdAt) step.createdAt = item.createdAt;
      if (item.type === "tool_use") {
        if (item.input) step.input = item.input;
      } else {
        // Claude sends the args in the update, so the result may carry the
        // input when the use didn't — take it as a fallback.
        if (item.input && !step.input) step.input = item.input;
        if (item.output != null) step.output = item.output;
        const metaDuration = typeof item.meta?.duration_ms === "number" ? item.meta.duration_ms : undefined;
        if (metaDuration != null) step.durationMs = metaDuration;
        else if (step.createdAt && item.createdAt) {
          const d = new Date(item.createdAt).getTime() - new Date(step.createdAt).getTime();
          if (Number.isFinite(d) && d >= 0) step.durationMs = d;
        }
      }
      continue;
    }
    out.push({ kind: "event", seq: item.seq, item });
  }
  return out;
}

export function isStepRunning(status?: string): boolean {
  return status != null && !TERMINAL_STATUS.has(status);
}

function canMergeStreamingText(prev: TimelineItem, next: TimelineItem): boolean {
  return (prev.type === "thinking" || prev.type === "text") && prev.type === next.type;
}

/** Merge adjacent text/thinking fragments that were split only by daemon flush timing. */
export function coalesceTimelineItems(items: TimelineItem[]): TimelineItem[] {
  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  const out: TimelineItem[] = [];

  for (const item of sorted) {
    const prev = out[out.length - 1];
    if (prev && canMergeStreamingText(prev, item)) {
      out[out.length - 1] = {
        ...prev,
        content: `${prev.content ?? ""}${item.content ?? ""}`,
      };
      continue;
    }
    out.push(item);
  }

  return out;
}

export function appendTimelineItem(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  return coalesceTimelineItems([...items, item]);
}

function redactTimelineItems(items: TimelineItem[]): TimelineItem[] {
  // Redact every leaf a viewer can reach: display strings AND structured
  // input/meta (tool args, file locations, diffs) — a secret in `input` never
  // hit the old content/output-only path.
  return items.map((item) => ({
    ...item,
    content: item.content ? redactString(item.content) : item.content,
    output: item.output ? redactString(item.output) : item.output,
    input: item.input ? redactValue(item.input) : item.input,
    meta: item.meta ? redactValue(item.meta) : item.meta,
  }));
}

const USAGE_TYPES = new Set(["usage"]);

/**
 * Last usage snapshot (not a sum — ACP usage_update reports the current total,
 * so `used` can even go down; accumulating double-counts). Reads the daemon's
 * `meta` blob first (Batch 2+), then falls back to the legacy JSON-in-content
 * form ({sessionUpdate:"usage_update", used, size, cost}).
 */
export function extractUsageFromMessages(msgs: TaskMessagePayload[]): UsageSnapshot | null {
  let last: UsageSnapshot | null = null;
  for (const msg of msgs) {
    if (!USAGE_TYPES.has(msg.type)) continue;
    const src = msg.meta ?? parseUsageContent(msg.content);
    if (!src) continue;
    const nested = src.usage;
    const usage: Record<string, unknown> =
      nested && typeof nested === "object" ? (nested as Record<string, unknown>) : src;
    const num = (...keys: string[]): number | undefined => {
      for (const k of keys) {
        const v = usage[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
      return undefined;
    };
    const snapshot: UsageSnapshot = {
      model: typeof usage.model === "string" ? usage.model : last?.model,
      inputTokens: num("inputTokens", "input_tokens"),
      outputTokens: num("outputTokens", "output_tokens"),
      totalTokens: num("totalTokens", "total_tokens", "used"),
      cacheReadTokens: num("cacheReadTokens", "cache_read_tokens"),
      cacheWriteTokens: num("cacheWriteTokens", "cache_write_tokens"),
    };
    last = snapshot;
  }
  return last;
}

function parseUsageContent(content?: string): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Build a chronologically ordered timeline from raw task messages. `usage`
 * rows are dropped here — they carry no per-event display value and drove the
 * "(empty)" rows; the header shows the rolled-up totals instead.
 */
export function buildTimeline(msgs: TaskMessagePayload[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const msg of msgs) {
    if (USAGE_TYPES.has(msg.type)) continue;
    items.push({
      seq: msg.seq,
      type: msg.type as TimelineItem["type"],
      tool: msg.tool,
      content: msg.content,
      input: msg.input,
      output: msg.output,
      createdAt: msg.created_at,
      toolCallId: msg.tool_call_id,
      status: msg.status,
      meta: msg.meta,
    });
  }
  return redactTimelineItems(coalesceTimelineItems(items));
}
