/**
 * LangSmith exporter — async, fire-and-forget span upload.
 *
 * Converts Remi SpanData into LangSmith runs.
 * Enabled when tracing.langsmith_api_key is set in remi.toml (or LANGCHAIN_API_KEY env).
 */

import { Client } from "langsmith";
import type { SpanData } from "./tracing.js";
import type { TracingConfig } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("langsmith");

let client: Client | null = null;
let projectName = "remi";
let enabled = false;

// Cache dotted_order per spanId so child spans can reference their parent's dotted_order.
const dottedOrderCache = new Map<string, string>();
// Map traceId → root spanId so all spans in a trace share the same LangSmith trace_id.
const rootSpanMap = new Map<string, string>();
// Map traceId → session_key so all spans (including children) can carry the thread identifier.
const traceSessionMap = new Map<string, string>();

export function initLangSmith(config: TracingConfig): boolean {
  const apiKey = config.langsmithApiKey;
  if (!apiKey) {
    log.debug("LangSmith API key not configured, export disabled");
    return false;
  }

  client = new Client({
    apiKey,
    apiUrl: config.langsmithEndpoint,
  });
  projectName = config.langsmithProject;
  enabled = true;
  log.info(`LangSmith exporter initialized (project=${projectName})`);
  return true;
}

export function isLangSmithEnabled(): boolean {
  return enabled;
}

/**
 * Register a span at creation time to build its dotted_order early,
 * so child spans can look up their parent's dotted_order when they end.
 */
/** Register session_key for a trace so all child spans inherit it for Thread grouping. */
export function registerTraceSession(traceId: string, sessionKey: string): void {
  traceSessionMap.set(traceId, sessionKey);
  setTimeout(() => traceSessionMap.delete(traceId), 10 * 60 * 1000);
}

export function registerSpanStart(spanId: string, traceId: string, parentSpanId: string | undefined, startTime: string): void {
  const runId = toUuid(spanId).replace(/-/g, "");
  const ts = toDottedTs(startTime);
  const selfSegment = `${ts}${runId}`;

  if (parentSpanId) {
    const parentDotted = dottedOrderCache.get(parentSpanId);
    dottedOrderCache.set(spanId, parentDotted ? `${parentDotted}.${selfSegment}` : selfSegment);
  } else {
    // Root span: register as LangSmith trace root
    dottedOrderCache.set(spanId, selfSegment);
    rootSpanMap.set(traceId, spanId);
  }
  // Auto-cleanup after 10 minutes
  setTimeout(() => dottedOrderCache.delete(spanId), 10 * 60 * 1000);
}

/** Pad a hex string to UUID format for LangSmith compatibility. */
function toUuid(hex: string): string {
  const padded = hex.padStart(32, "0");
  return `${padded.slice(0, 8)}-${padded.slice(8, 12)}-${padded.slice(12, 16)}-${padded.slice(16, 20)}-${padded.slice(20, 32)}`;
}

/** Convert ISO timestamp to LangSmith dotted_order timestamp format: "YYYYMMDDTHHMMSSsss000Z" */
function toDottedTs(isoTime: string): string {
  // "2026-03-14T09:58:27.316Z" → "20260314T095827316000Z"
  const d = new Date(isoTime);
  const iso = d.toISOString(); // "2026-03-14T09:58:27.316Z"
  return iso.slice(0, -1).replace(/[-:.]/g, "") + "000Z"; // strip trailing Z, remove separators, add 000 for microseconds + Z
}

/**
 * Export a completed span to LangSmith as a run.
 * Fire-and-forget — errors are logged but never thrown.
 */
export function exportSpan(span: SpanData): void {
  if (!enabled || !client) {
    log.info(`exportSpan skipped: enabled=${enabled}, client=${!!client}, op=${span.operationName}`);
    return;
  }

  const isRoot = !span.parentSpanId;
  const isLLM = span.operationName === "provider.chat" || span.operationName === "provider.chat.fallback";

  // Map operation to LangSmith run_type
  let runType: "chain" | "llm" | "tool" = "chain";
  if (isLLM) runType = "llm";
  else if (span.operationName.startsWith("tool.")) runType = "tool";

  // Build inputs/outputs — pass all attributes so LangSmith Dashboard shows full context
  const inputs: Record<string, unknown> = {};
  const outputs: Record<string, unknown> = {};

  // Always include all span attributes as inputs for full visibility
  for (const [k, v] of Object.entries(span.attributes)) {
    inputs[k] = v;
  }

  // Span-specific structured outputs
  if (isLLM) {
    outputs.model = span.attributes["llm.model"] ?? "unknown";
    outputs.input_tokens = span.attributes["llm.input_tokens"] ?? 0;
    outputs.output_tokens = span.attributes["llm.output_tokens"] ?? 0;
    outputs.cost_usd = span.attributes["llm.cost_usd"] ?? 0;
    outputs.duration_ms = span.attributes["llm.duration_ms"] ?? 0;
  }

  outputs.duration_ms = span.durationMs;
  outputs.status = span.status;
  if (span.statusMessage) outputs.error = span.statusMessage;

  // Convert IDs to UUID format (LangSmith requires 32-hex or UUID pattern)
  const runId = toUuid(span.spanId);
  const parentRunId = span.parentSpanId ? toUuid(span.parentSpanId) : undefined;

  // LangSmith trace_id must match the first segment's runId in dotted_order (= root span's runId).
  // rootSpanMap is populated at span creation time (registerSpanStart) so it's always available.
  const rootSpanId = rootSpanMap.get(span.traceId) ?? span.spanId;
  const traceId = toUuid(rootSpanId);

  // Look up dotted_order from cache (populated by registerSpanStart at span creation time)
  let dottedOrder = dottedOrderCache.get(span.spanId);
  if (!dottedOrder) {
    // Fallback: build it now (shouldn't happen if registerSpanStart was called)
    const ts = toDottedTs(span.startTime);
    const strippedRunId = runId.replace(/-/g, "");
    dottedOrder = `${ts}${strippedRunId}`;
    log.debug(`dotted_order cache miss for ${span.operationName}, built fallback`);
  }

  log.debug(`exportSpan ${span.operationName}: dottedOrder=${dottedOrder ? dottedOrder.slice(0, 40) + "..." : "EMPTY"}, runId=${runId}`);

  // Session/thread grouping: cache on root, propagate to all children
  const chatId = (span.attributes["chat.id"] as string) ?? undefined;
  let sessionKey = (span.attributes["session.key"] as string) ?? undefined;
  if (isRoot && sessionKey) {
    traceSessionMap.set(span.traceId, sessionKey);
  } else if (!sessionKey) {
    sessionKey = traceSessionMap.get(span.traceId);
  }

  // Async create — fire-and-forget
  client.createRun({
    id: runId,
    trace_id: traceId,
    dotted_order: dottedOrder,
    parent_run_id: parentRunId,
    name: span.operationName,
    run_type: runType,
    project_name: projectName,
    tags: chatId ? [chatId] : undefined,
    inputs,
    outputs,
    start_time: new Date(span.startTime).getTime(),
    end_time: span.endTime ? new Date(span.endTime).getTime() : undefined,
    status: span.status === "ERROR" ? "error" : "success",
    error: span.statusMessage ?? undefined,
    extra: {
      metadata: {
        // LangSmith recognizes session_id/thread_id/conversation_id for Thread grouping
        session_id: sessionKey,
        chat_id: chatId,
        connector: span.attributes["connector.name"] ?? undefined,
      },
      attributes: span.attributes,
      events: span.events,
    },
  }).catch((err) => {
    log.warn(`LangSmith export failed for ${span.operationName}: ${err.message}`);
  });
}

/** Flush pending uploads. Call on graceful shutdown. */
export async function flushLangSmith(): Promise<void> {
  if (client) {
    try {
      await new Promise((r) => setTimeout(r, 2000));
    } catch {
      // ignore
    }
  }
}
