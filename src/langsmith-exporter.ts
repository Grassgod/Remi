/**
 * LangSmith exporter — uses RunTree SDK for automatic trace hierarchy.
 *
 * Two-phase lifecycle per span:
 *   1. registerSpan()  — called at span creation, creates RunTree + postRun()
 *   2. exportSpan()    — called at span end, sets outputs + patchRun()
 *
 * RunTree.createChild() handles trace_id, dotted_order, parent_run_id automatically.
 */

import { RunTree } from "langsmith/run_trees";
import type { SpanData } from "./tracing.js";
import type { TracingConfig } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("langsmith");

let projectName = "Remi";
let enabled = false;

// spanId → RunTree instance (alive between registerSpan and exportSpan)
const runTreeMap = new Map<string, RunTree>();
// traceId → session_key for Thread grouping
const sessionMap = new Map<string, string>();

const CLEANUP_MS = 10 * 60 * 1000;

// ── Init ─────────────────────────────────────────────────────────

export function initLangSmith(config: TracingConfig): boolean {
  const apiKey = config.langsmithApiKey;
  if (!apiKey) {
    log.debug("LangSmith API key not configured, export disabled");
    return false;
  }

  process.env.LANGCHAIN_API_KEY = apiKey;
  if (config.langsmithEndpoint) process.env.LANGCHAIN_ENDPOINT = config.langsmithEndpoint;

  projectName = config.langsmithProject;
  enabled = true;
  log.info(`LangSmith exporter initialized (project=${projectName})`);
  return true;
}

export function isLangSmithEnabled(): boolean {
  return enabled;
}

// ── Session registration ─────────────────────────────────────────

export function registerTraceSession(traceId: string, sessionKey: string): void {
  sessionMap.set(traceId, sessionKey);
  setTimeout(() => sessionMap.delete(traceId), CLEANUP_MS);
}

// ── Span lifecycle ───────────────────────────────────────────────

/** Called at span creation — creates RunTree and posts it. */
export function registerSpan(
  spanId: string,
  traceId: string,
  parentSpanId: string | undefined,
  operationName: string,
  attributes?: Record<string, string | number | boolean>,
): void {
  if (!enabled) return;

  const runType = resolveRunType(operationName);
  const sessionKey = sessionMap.get(traceId);
  const metadata = { session_id: sessionKey };
  const inputs = buildInputs(operationName, attributes);

  try {
    let runTree: RunTree;

    if (parentSpanId) {
      const parent = runTreeMap.get(parentSpanId);
      if (parent) {
        runTree = parent.createChild({
          name: operationName,
          run_type: runType,
          inputs,
          extra: { metadata },
        });
      } else {
        log.debug(`Parent not found for ${operationName}, creating standalone`);
        runTree = new RunTree({
          name: operationName,
          run_type: runType,
          project_name: projectName,
          inputs,
          extra: { metadata },
        });
      }
    } else {
      runTree = new RunTree({
        name: operationName,
        run_type: runType,
        project_name: projectName,
        inputs,
        extra: { metadata },
      });
    }

    runTreeMap.set(spanId, runTree);
    runTree.postRun().catch((err) => log.warn(`postRun failed for ${operationName}: ${err.message}`));
    setTimeout(() => runTreeMap.delete(spanId), CLEANUP_MS);
  } catch (err) {
    log.warn(`registerSpan failed for ${operationName}: ${(err as Error).message}`);
  }
}

/** Called at span end — sets outputs and patches the run. */
export function exportSpan(span: SpanData): void {
  if (!enabled) return;

  const runTree = runTreeMap.get(span.spanId);
  if (!runTree) {
    log.debug(`No RunTree for ${span.operationName}, skipping export`);
    return;
  }

  runTree.end({
    outputs: buildOutputs(span),
    error: span.status === "ERROR" ? (span.statusMessage ?? "unknown error") : undefined,
  });

  runTree.patchRun().catch((err) => log.warn(`patchRun failed for ${span.operationName}: ${err.message}`));
  runTreeMap.delete(span.spanId);
}

/** Flush pending uploads on graceful shutdown. */
export async function flushLangSmith(): Promise<void> {
  await Promise.allSettled([...runTreeMap.values()].map((rt) => rt.patchRun()));
}

// ── Helpers ──────────────────────────────────────────────────────

function resolveRunType(op: string): "chain" | "llm" | "tool" {
  if (op === "provider.chat" || op === "provider.chat.fallback") return "llm";
  if (op.startsWith("tool.")) return "tool";
  return "chain";
}

function buildInputs(op: string, attrs?: Record<string, string | number | boolean>): Record<string, unknown> {
  if (!attrs) return {};
  const inputs: Record<string, unknown> = {};
  const skipKeys = new Set(["tool.output", "tool.duration_ms", "llm.response", "llm.thinking"]);
  for (const [k, v] of Object.entries(attrs)) {
    if (!skipKeys.has(k)) inputs[k] = v;
  }
  if (op.startsWith("tool.") && attrs["tool.input"]) {
    try { inputs.input = JSON.parse(attrs["tool.input"] as string); }
    catch { inputs.input = attrs["tool.input"]; }
  }
  return inputs;
}

function buildOutputs(span: SpanData): Record<string, unknown> {
  const out: Record<string, unknown> = { duration_ms: span.durationMs, status: span.status };
  if (span.statusMessage) out.error = span.statusMessage;
  const a = span.attributes;
  if (a["llm.model"]) {
    Object.assign(out, {
      model: a["llm.model"], input_tokens: a["llm.input_tokens"] ?? 0,
      output_tokens: a["llm.output_tokens"] ?? 0, cost_usd: a["llm.cost_usd"] ?? 0,
    });
    if (a["llm.response"]) out.response = a["llm.response"];
    if (a["llm.thinking"]) out.thinking = a["llm.thinking"];
  }
  if (a["tool.output"]) out.output = a["tool.output"];
  return out;
}
