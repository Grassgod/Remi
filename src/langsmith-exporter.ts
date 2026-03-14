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
// Populated at span creation time (registerSpanStart), consumed at export time (exportSpan).
const dottedOrderCache = new Map<string, string>();

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
export function registerSpanStart(spanId: string, parentSpanId: string | undefined, startTime: string): void {
  // Always cache dotted_order even before LangSmith is initialized — spans may start before init completes
  const runId = toUuid(spanId).replace(/-/g, "");
  const ts = toDottedTs(startTime);
  const selfSegment = `${ts}${runId}`;

  if (parentSpanId) {
    const parentDotted = dottedOrderCache.get(parentSpanId);
    dottedOrderCache.set(spanId, parentDotted ? `${parentDotted}.${selfSegment}` : selfSegment);
  } else {
    dottedOrderCache.set(spanId, selfSegment);
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

  // Build inputs/outputs
  const inputs: Record<string, unknown> = {};
  const outputs: Record<string, unknown> = {};

  if (isRoot) {
    inputs.message = span.attributes["message.text"] ?? "";
    inputs.chat_id = span.attributes["chat.id"] ?? "";
    inputs.connector = span.attributes["connector.name"] ?? "";
  }

  if (isLLM) {
    outputs.model = span.attributes["llm.model"] ?? "unknown";
    outputs.input_tokens = span.attributes["llm.input_tokens"] ?? 0;
    outputs.output_tokens = span.attributes["llm.output_tokens"] ?? 0;
    outputs.cost_usd = span.attributes["llm.cost_usd"] ?? 0;
    outputs.duration_ms = span.attributes["llm.duration_ms"] ?? 0;
  }

  if (span.operationName.startsWith("tool.")) {
    inputs.tool_name = span.attributes["tool.name"] ?? "";
    inputs.tool_use_id = span.attributes["tool.use_id"] ?? "";
    if (span.attributes["tool.duration_ms"] != null) {
      outputs.duration_ms = span.attributes["tool.duration_ms"];
    }
  }

  // Convert IDs to UUID format (LangSmith requires 32-hex or UUID pattern)
  const runId = toUuid(span.spanId);
  const traceId = toUuid(span.traceId);
  const parentRunId = span.parentSpanId ? toUuid(span.parentSpanId) : undefined;

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

  // Session info for multi-turn grouping (via metadata + tags, NOT session_name which creates new projects)
  const sessionKey = (span.attributes["session.key"] as string) ?? undefined;
  const chatId = (span.attributes["chat.id"] as string) ?? undefined;

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
        session_key: sessionKey,
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
