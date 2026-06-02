import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { AcpProvider } from "../providers/acp/index.js";
import type { ProviderEvent } from "../providers/base.js";
import { MulticaDaemonClient } from "./client.js";
import { buildTaskPrompt } from "./prompt.js";
import type { MulticaTaskWithAgent, TaskMessageInput, TaskUsageEntry } from "./types.js";

const log = createLogger("multica-daemon");

export interface MulticaDaemonOptions {
  serverUrl: string;
  token?: string | null;
  runtimeId?: string | null;
  runtimeName?: string;
  provider?: string;
  workspaceId?: string | null;
  pollIntervalMs?: number;
  once?: boolean;
}

interface RunSummary {
  output: string;
  sessionId: string | null;
  workDir: string | null;
  usage: TaskUsageEntry[];
}

export class MulticaDaemon {
  private client: MulticaDaemonClient;
  private options: Required<Omit<MulticaDaemonOptions, "token" | "runtimeId" | "workspaceId">> & {
    token: string | null;
    runtimeId: string | null;
    workspaceId: string | null;
  };
  private stopped = false;

  constructor(options: MulticaDaemonOptions) {
    this.options = {
      token: options.token ?? process.env.MULTICA_TOKEN ?? null,
      runtimeId: options.runtimeId ?? process.env.MULTICA_RUNTIME_ID ?? null,
      runtimeName: options.runtimeName ?? process.env.MULTICA_RUNTIME_NAME ?? `${Bun.env.USER ?? "local"}-bun-runtime`,
      provider: options.provider ?? process.env.MULTICA_PROVIDER ?? "claude",
      workspaceId: options.workspaceId ?? process.env.MULTICA_WORKSPACE_ID ?? "local",
      pollIntervalMs: options.pollIntervalMs ?? parseInt(process.env.MULTICA_POLL_INTERVAL_MS ?? "3000", 10),
      once: options.once ?? false,
      serverUrl: options.serverUrl,
    };
    this.client = new MulticaDaemonClient(options.serverUrl, this.options.token);
  }

  async start(): Promise<void> {
    const runtime = await this.client.registerRuntime({
      id: this.options.runtimeId ?? undefined,
      name: this.options.runtimeName,
      provider: this.options.provider,
      workspaceId: this.options.workspaceId,
      maxConcurrency: 1,
    });
    this.options.runtimeId = runtime.runtime.id;
    log.info(`Runtime registered: ${this.options.runtimeId} (${this.options.provider})`);
    await this.client.recoverOrphans(this.options.runtimeId);

    while (!this.stopped) {
      const task = await this.client.claimTask(this.options.runtimeId) as MulticaTaskWithAgent | null;
      if (!task) {
        if (this.options.once) return;
        await sleep(this.options.pollIntervalMs);
        continue;
      }
      await this.handleTask(task);
      if (this.options.once) return;
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async handleTask(task: MulticaTaskWithAgent): Promise<void> {
    log.info(`Claimed task ${task.id}`);
    const abort = new AbortController();
    const cancelWatcher = this.watchCancellation(task.id, abort);
    let summary: RunSummary | null = null;

    try {
      await this.client.startTask(task.id);
      await this.client.reportProgress(task.id, "Agent execution started", 1, 3);
      summary = await this.runAgent(task, abort.signal);
      await this.client.reportProgress(task.id, "Agent execution completed", 3, 3);
      await this.client.reportTaskUsage(task.id, summary.usage);
      await this.client.completeTask(task.id, summary.output, summary.sessionId, summary.workDir);
      log.info(`Completed task ${task.id}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.client.failTask(task.id, error, summary?.sessionId ?? task.sessionId, summary?.workDir ?? task.workDir);
      log.error(`Failed task ${task.id}: ${error}`);
    } finally {
      clearInterval(cancelWatcher);
    }
  }

  private async runAgent(task: MulticaTaskWithAgent, signal: AbortSignal): Promise<RunSummary> {
    const agent = task.agent;
    if (!agent) throw new Error(`Task ${task.id} has no agent`);
    if (agent.provider !== "claude" && agent.provider !== "codex") {
      throw new Error(`Unsupported Bun Multica provider: ${agent.provider}`);
    }

    const workDir = resolveWorkDir(task);
    mkdirSync(workDir, { recursive: true });
    await this.client.pinTaskSession(task.id, task.sessionId, workDir);

    const provider = new AcpProvider({
      agentType: agent.provider,
      executable: agent.executable ?? undefined,
      model: agent.model,
      allowedTools: agent.allowedTools,
      cwd: workDir,
      env: agent.customEnv,
    });

    let output = "";
    let seq = 1;
    let finalSessionId: string | null = task.sessionId;
    let usage: TaskUsageEntry[] = [];

    try {
      const prompt = buildTaskPrompt(task);
      for await (const event of provider.sendStream!(prompt, {
        cwd: workDir,
        sessionId: task.sessionId,
        chatId: task.id,
        allowedTools: agent.allowedTools,
        signal,
      })) {
        const message = eventToTaskMessage(event, seq++);
        if (message) {
          if (message.type === "assistant" && message.content) output += message.content;
          await this.client.reportTaskMessages(task.id, [message]);
        }
      }
      const last = provider.getLastResponse?.();
      finalSessionId = last?.sessionId ?? finalSessionId;
      usage = responseToUsage(agent.provider, last);
      await this.client.pinTaskSession(task.id, finalSessionId, workDir);
      return {
        output: output.trim() || last?.text || "Task completed.",
        sessionId: finalSessionId,
        workDir,
        usage,
      };
    } finally {
      await provider.close?.();
    }
  }

  private watchCancellation(taskId: string, abort: AbortController): ReturnType<typeof setInterval> {
    return setInterval(() => {
      this.client.getTaskStatus(taskId).then((status) => {
        if (status === "cancelled") abort.abort();
      }).catch(() => {});
    }, 2500);
  }
}

function resolveWorkDir(task: MulticaTaskWithAgent): string {
  if (task.workDir) return task.workDir;
  if (task.agent?.cwd) return task.agent.cwd;
  return join(homedir(), ".remi", "multica", "workspaces", task.workspaceId, task.id);
}

function eventToTaskMessage(event: ProviderEvent, seq: number): TaskMessageInput | null {
  const raw = event as Record<string, any>;
  if (raw.sessionUpdate === "agent_message_chunk" || raw.sessionUpdate === "agent_thought_chunk") {
    const content = extractText(raw.content);
    if (!content) return null;
    return {
      seq,
      type: raw.sessionUpdate === "agent_thought_chunk" ? "thought" : "assistant",
      content,
    };
  }
  if (raw.sessionUpdate === "tool_call" || raw.sessionUpdate === "tool_call_update") {
    return {
      seq,
      type: "tool",
      tool: raw.title ?? raw.kind ?? raw.toolCallId ?? null,
      input: raw.rawInput ? parseMaybeJson(raw.rawInput) : undefined,
      output: raw.rawOutput ? JSON.stringify(raw.rawOutput) : extractText(raw.content),
    };
  }
  if (raw.sessionUpdate === "usage_update") {
    return {
      seq,
      type: "usage",
      content: JSON.stringify(raw),
    };
  }
  return null;
}

function extractText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  let text = "";
  for (const block of blocks) {
    if (typeof block === "string") text += block;
    else if (block && typeof block === "object" && "text" in block) {
      text += String((block as { text?: unknown }).text ?? "");
    }
  }
  return text;
}

function parseMaybeJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { value };
  }
}

function responseToUsage(provider: string, response: any): TaskUsageEntry[] {
  if (!response) return [];
  const inputTokens = Number(response.inputTokens ?? 0);
  const outputTokens = Number(response.outputTokens ?? 0);
  const cacheReadTokens = Number(response.cacheReadInputTokens ?? 0);
  const cacheWriteTokens = Number(response.cacheCreateInputTokens ?? 0);
  if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens) return [];
  return [{
    provider,
    model: String(response.model ?? ""),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  }];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
