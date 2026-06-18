/**
 * Remote daemon loop — the DB-less counterpart to daemon-main.ts. Given only a
 * server URL + PAT (from ~/.remi/config.json), it registers a runtime per
 * detected agent CLI, then polls each runtime for a task, runs it through the
 * unified AcpProvider, and reports the result — all over HTTP.
 *
 * M1 is intentionally "thin": the prompt is the agent's instructions and the
 * agent runs in the process cwd. M2 swaps in the server-built ClaimBundle
 * (prompt + working directory) so it matches the DB-direct executor exactly.
 */

import { hostname } from "node:os";
import { AcpProvider } from "../agent/acp/index.js";
import { createAdapter } from "../agent/acp/adapters/index.js";
import type { AgentAdapter } from "../agent/acp/adapters/base.js";
import type { ToolCallProgressUpdate, ToolCallUpdate } from "../agent/acp/protocol.js";
import type { AgentEvent } from "../agent/types.js";
import { createLogger } from "../logger.js";
import {
  DaemonClient,
  HttpError,
  type ClaimedTask,
  type RegisteredRuntime,
  type TaskMessageInput,
  type TaskUsageInput,
} from "./client.js";
import { ensureDaemonId, loadConfig } from "./config.js";

const log = createLogger("remi");

/** provider (ACP agent type) → the CLI binary that backs it. */
const PROVIDER_BINARIES: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  copilot: "copilot",
  opencode: "opencode",
  openclaw: "openclaw",
  hermes: "hermes",
  gemini: "gemini",
  pi: "pi",
  cursor: "cursor-agent",
  kimi: "kimi",
  kiro: "kiro-cli",
};

const POLL_INTERVAL_MS = 10_000;

/** Detect which agent CLIs are installed on PATH (the providers we can run). */
function detectProviders(): string[] {
  const found: string[] = [];
  for (const [provider, bin] of Object.entries(PROVIDER_BINARIES)) {
    if (Bun.which(bin)) found.push(provider);
  }
  return found;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runRemoteDaemon(): Promise<void> {
  const cfg = loadConfig();
  const serverUrl = cfg.server_url?.trim() ?? "";
  const token = cfg.token?.trim() ?? "";
  const workspaceId = cfg.workspace_id?.trim() ?? "";

  if (!serverUrl) throw new Error("server_url is not set — run `remi config set server_url <url>`");
  if (!token) throw new Error("token is not set — run `remi login --token <mul_…>`");
  if (!workspaceId) {
    throw new Error("workspace_id is not set — run `remi config set workspace_id <uuid>`");
  }

  const providers = detectProviders();
  if (providers.length === 0) {
    throw new Error(
      "no agent CLI found on PATH (claude, codex, …) — install one before starting the daemon",
    );
  }

  const daemonId = ensureDaemonId(cfg);
  const client = new DaemonClient({ serverUrl, token, workspaceId });
  const provider = new AcpProvider();

  let stop = false;
  const onSignal = (): void => {
    stop = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let runtimes: RegisteredRuntime[] = await client.register(daemonId, hostname(), providers);
  log.info(
    `registered ${runtimes.length} runtime(s): ${runtimes.map((r) => `${r.provider}=${r.id}`).join(", ")}`,
  );
  for (const rt of runtimes) {
    const recovered = await client.recoverOrphans(rt.id).catch(() => 0);
    if (recovered > 0) log.info(`recovered ${recovered} orphan task(s) for ${rt.provider}`);
  }

  while (!stop) {
    try {
      let anyGone = false;
      for (const rt of runtimes) {
        const alive = await client.heartbeat(rt.id);
        if (!alive) {
          anyGone = true;
          continue;
        }
        const task = await client.claim(rt.id);
        if (task) await runAndReport(client, provider, rt.provider, task);
      }
      // A runtime was deleted server-side → re-register cleanly.
      if (anyGone) {
        runtimes = await client.register(daemonId, hostname(), providers);
        for (const rt of runtimes) {
          await client.recoverOrphans(rt.id).catch(() => 0);
        }
        log.info("re-registered after a runtime went missing");
      }
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        log.error("token rejected (401) — run `remi login --token <mul_…>`; stopping");
        break;
      }
      log.warn(`loop error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stop) await sleep(POLL_INTERVAL_MS);
  }

  log.info("daemon stopped");
}

async function runAndReport(
  client: DaemonClient,
  provider: AcpProvider,
  agentType: string,
  task: ClaimedTask,
): Promise<void> {
  log.info(`running task ${task.id} (${agentType})`);
  let sessionId: string | null = task.sessionId ?? null;
  const workDir = task.workDir ?? process.cwd();
  let usage: TaskUsageInput | null = null;
  const adapter = createAdapter(agentType);
  try {
    await client.startTask(task.id, sessionId, workDir);
    await client.reportProgress(task.id, "Agent execution started", 1, 3).catch(() => {});
    const gen = provider.execute({
      agentType,
      prompt: task.instructions || "Proceed.",
      model: task.model ?? null,
      env: task.env,
      permissionMode: "bypassPermissions",
      cwd: workDir,
    });
    let result;
    let seq = 1;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      usage = usageFromEvent(next.value.raw, agentType, task.model) ?? usage;
      const message = messageFromEvent(next.value, seq++, adapter);
      if (message) await client.reportTaskMessages(task.id, [message]).catch(() => {});
    }
    sessionId = result.sessionId || sessionId;
    await client.pinTaskSession(task.id, sessionId, workDir).catch(() => {});
    if (usage) await client.reportTaskUsage(task.id, [usage]).catch(() => {});
    await client.reportProgress(task.id, "Agent execution completed", 3, 3).catch(() => {});
    await client.completeTask(task.id, result.text, sessionId, workDir);
    log.info(`task ${task.id} completed`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await client.failTask(task.id, error, "agent_error", sessionId, workDir).catch(() => {});
    log.warn(`task ${task.id} failed: ${error}`);
  }
}

function messageFromEvent(
  event: AgentEvent,
  seq: number,
  adapter: AgentAdapter,
): TaskMessageInput | null {
  if (!event || typeof event !== "object") return null;
  if (event.kind === "text" && event.text.trim()) {
    return { type: "text", content: event.text, seq };
  }
  if (event.kind === "thought" && event.text.trim()) {
    return { type: "thinking", content: event.text, seq };
  }
  if (event.kind === "tool_call") {
    const update = event.raw as ToolCallUpdate;
    const tool = adapter.resolveToolName(update);
    return {
      type: "tool_use",
      seq,
      tool,
      content: update.title || tool,
      input: adapter.extractToolInput(update),
    };
  }
  if (event.kind === "tool_update") {
    const update = event.raw as ToolCallProgressUpdate;
    const tool = adapter.resolveToolName(update);
    const output = adapter.extractResultPreview(update) ?? stringPreview(update.rawOutput);
    return {
      type: "tool_result",
      seq,
      tool,
      content: update.title ?? undefined,
      output: output ?? update.status ?? undefined,
    };
  }
  if (event.kind === "plan") {
    const content = planPreview(event.raw);
    return content ? { type: "thinking", content, seq } : null;
  }
  return null;
}

function planPreview(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  const active = entries
    .map((entry) => (entry && typeof entry === "object" ? entry as Record<string, unknown> : null))
    .find((entry) => entry?.status === "in_progress") ?? null;
  const content = typeof active?.activeForm === "string" && active.activeForm.trim()
    ? active.activeForm
    : typeof active?.content === "string" && active.content.trim()
      ? active.content
      : "";
  return content || null;
}

function stringPreview(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function usageFromEvent(raw: unknown, provider: string, fallbackModel?: string): TaskUsageInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.sessionUpdate !== "usage_update") return null;
  const usage = r.usage && typeof r.usage === "object" ? r.usage as Record<string, unknown> : r;
  const model = typeof usage.model === "string" && usage.model ? usage.model : fallbackModel ?? "unknown";
  const inputTokens = numberValue(usage.inputTokens ?? usage.input_tokens ?? usage.used);
  const outputTokens = numberValue(usage.outputTokens ?? usage.output_tokens);
  const cacheReadTokens = numberValue(usage.cacheReadTokens ?? usage.cache_read_tokens);
  const cacheWriteTokens = numberValue(usage.cacheWriteTokens ?? usage.cache_write_tokens);
  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
