#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  AcpProvider,
  resolveAcpExecutableForAgent,
  resolveAcpHealthCheckCommand,
} from "@acp/index.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";

type SmokeProvider = "claude" | "codex";
type SmokeStatus = "passed" | "failed" | "unavailable" | "available";

interface SmokeOptions {
  providers: SmokeProvider[];
  allowUnavailable: boolean;
  checkOnly: boolean;
  prompt: string;
  marker: string;
  model: string | null;
  timeoutMs: number;
  codexConfig: string | null;
  codexRelayBaseUrl: string | null;
  questionAnswer: string | null;
}

interface SmokeResult {
  provider: SmokeProvider;
  status: SmokeStatus;
  reason?: string;
  runtimeId?: string | null;
  taskId?: string;
  taskStatus?: string;
  failureReason?: string | null;
  messageCount?: number;
  messageTypes?: string[];
  assistantMessageCount?: number;
  usageMessageCount?: number;
  usageCount?: number;
  humanRequestCount?: number;
  humanRequests?: MultiremiTaskHumanRequest[];
  output?: string | null;
  executable?: string;
  healthCommand?: string;
}

const DEFAULT_MARKER = "MULTIREMI_SMOKE_OK";

const options = parseArgs(process.argv.slice(2));
const results: SmokeResult[] = [];

for (const provider of options.providers) {
  results.push(await runProviderSmoke(provider, options));
}

console.log(JSON.stringify({
  ok: results.every((result) =>
    result.status === "passed" ||
    result.status === "available" ||
    (options.allowUnavailable && result.status === "unavailable")
  ),
  results,
}, null, 2));

const hasFailure = results.some((result) => result.status === "failed" || (!options.allowUnavailable && result.status === "unavailable"));
process.exit(hasFailure ? 1 : 0);

async function runProviderSmoke(provider: SmokeProvider, options: SmokeOptions): Promise<SmokeResult> {
  const executable = resolveAcpExecutableForAgent(provider, null, defaultExecutable(provider));
  const health = resolveAcpHealthCheckCommand(provider, null, defaultExecutable(provider));
  const unavailable = executableUnavailable(executable) ?? executableUnavailable(health.command);
  if (unavailable) {
    return {
      provider,
      status: "unavailable",
      reason: unavailable,
      executable,
      healthCommand: [health.command, ...(health.args ?? [])].join(" "),
    };
  }

  const healthProvider = new AcpProvider({ agentType: provider, model: options.model });
  try {
    if (!(await healthProvider.healthCheck())) {
      return {
        provider,
        status: "unavailable",
        reason: "health_check_failed",
        executable,
        healthCommand: [health.command, ...(health.args ?? [])].join(" "),
      };
    }
  } finally {
    await healthProvider.close?.();
  }
  if (options.checkOnly) {
    return {
      provider,
      status: "available",
      reason: "check_only",
      executable,
      healthCommand: [health.command, ...(health.args ?? [])].join(" "),
    };
  }

  const db = new Database(":memory:");
  const workDir = mkdtempSync(join(tmpdir(), `multiremi-acp-${provider}-`));
  const rootToken = `root-${provider}-smoke`;
  const store = new MultiremiStore(db);
  const server = startMultiremiServer({ store, scheduler: null, authToken: rootToken, hostname: "127.0.0.1", port: 0 });
  try {
    if (provider === "codex" && options.codexRelayBaseUrl) {
      const authToken = process.env.OPENAI_API_KEY?.trim();
      if (!authToken) throw new Error("--codex-relay-base-url requires OPENAI_API_KEY");
      store.upsertRelayConfig("local", "codex", {
        fragment: [
          'model_provider = "OpenAI"',
          "[model_providers.OpenAI]",
          'name = "OpenAI"',
          `base_url = ${JSON.stringify(options.codexRelayBaseUrl)}`,
          'wire_api = "responses"',
          "requires_openai_auth = false",
        ].join("\n"),
        tokenOp: "set",
        authToken,
      });
    }
    const daemonToken = await store.createAccessToken({
      name: `${provider} ACP smoke daemon`,
      type: "daemon",
      workspaceId: "local",
    });
    const agent = store.createAgent({
      name: `${provider} ACP Smoke`,
      provider,
      cwd: workDir,
      model: options.model,
      allowedTools: [],
      customEnv: options.codexConfig ? { CODEX_CONFIG: options.codexConfig } : {},
    });
    const task = store.createTask({
      agentId: agent.id,
      prompt: options.prompt,
      workspaceId: "local",
      workDir,
    });

    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      provider,
      runtimeName: `${provider}-acp-smoke`,
      workspaceId: "local",
      once: true,
      taskTimeoutMs: options.timeoutMs,
      humanRequestTimeoutMs: options.timeoutMs,
      daemonPort: 0,
      repoCacheRoot: join(workDir, ".repo-cache"),
    });
    const daemonRun = daemon.start();
    if (options.questionAnswer) {
      await answerPendingQuestion({
        store,
        taskId: task.id,
        baseUrl: `http://127.0.0.1:${server.port}`,
        authToken: rootToken,
        answer: options.questionAnswer,
        timeoutMs: options.timeoutMs,
      });
    }
    const timedOut = await runWithHardTimeout(daemonRun, options.timeoutMs + 10_000);
    if (timedOut) {
      return {
        provider,
        status: "failed",
        reason: `hard_timeout_after_${options.timeoutMs + 10_000}ms`,
        executable,
        healthCommand: [health.command, ...(health.args ?? [])].join(" "),
      };
    }

    const completed = store.getTask(task.id);
    const output = completed?.result ?? completed?.error ?? null;
    const messages = store.listTaskMessages(task.id);
    const messageTypes = messages.map((message) => message.type);
    const assistantMessageCount = messages.filter(
      (message) => message.type === "assistant" || message.type === "text",
    ).length;
    const usageMessageCount = messages.filter((message) => message.type === "usage").length;
    const messageCount = messages.length;
    const usageCount = completed?.usage.length ?? 0;
    const humanRequests = store.listTaskHumanRequests(task.id);
    const runtimeId = store.listRuntimes()[0]?.id ?? null;
    const base = {
      provider,
      runtimeId,
      taskId: task.id,
      taskStatus: completed?.status,
      failureReason: completed?.failureReason ?? null,
      messageCount,
      messageTypes,
      assistantMessageCount,
      usageMessageCount,
      usageCount,
      humanRequestCount: humanRequests.length,
      humanRequests,
      output,
      executable,
      healthCommand: [health.command, ...(health.args ?? [])].join(" "),
    };

    if (completed?.status !== "completed") {
      return {
        ...base,
        status: "failed",
        reason: completed?.failureReason ?? completed?.error ?? "task_not_completed",
      };
    }
    if (!String(completed.result ?? "").includes(options.marker)) {
      return {
        ...base,
        status: "failed",
        reason: "marker_missing",
      };
    }
    if (assistantMessageCount === 0) {
      return {
        ...base,
        status: "failed",
        reason: "transcript_missing_assistant_messages",
      };
    }
    if (usageMessageCount === 0 || usageCount === 0) {
      return {
        ...base,
        status: "failed",
        reason: "usage_transcript_missing",
      };
    }
    return {
      ...base,
      status: "passed",
    };
  } catch (err) {
    return {
      provider,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      executable,
      healthCommand: [health.command, ...(health.args ?? [])].join(" "),
    };
  } finally {
    server.stop(true);
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

function runWithHardTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(true), timeoutMs);
    promise.then(() => {
      clearTimeout(timeout);
      resolve(false);
    }).catch((err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function answerPendingQuestion(options: {
  store: MultiremiStore;
  taskId: string;
  baseUrl: string;
  authToken: string;
  answer: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  let request: MultiremiTaskHumanRequest | null = null;
  while (Date.now() < deadline) {
    request = options.store.listTaskHumanRequests(options.taskId)
      .find((candidate) => candidate.kind === "question" && candidate.status === "pending") ?? null;
    if (request) break;
    const task = options.store.getTask(options.taskId);
    if (task?.status === "completed" || task?.status === "failed" || task?.status === "cancelled") {
      throw new Error(`Task ended with status ${task.status} before requesting human input`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!request) throw new Error(`Timed out waiting for a question request after ${options.timeoutMs}ms`);

  const questions = (request.payload as {
    questions?: Array<{ question?: { question?: string } }>;
  }).questions;
  const question = questions?.[0]?.question?.question;
  if (!question) throw new Error("Question request did not contain a renderable question");
  const response = await fetch(
    `${options.baseUrl}/api/tasks/${options.taskId}/human-requests/${request.id}/respond`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ response: { answers: { [question]: options.answer } } }),
    },
  );
  if (!response.ok) {
    throw new Error(`Human request response failed (${response.status}): ${await response.text()}`);
  }
}

function parseArgs(args: string[]): SmokeOptions {
  let provider = "all";
  let allowUnavailable = false;
  let checkOnly = false;
  let marker = DEFAULT_MARKER;
  let prompt = `Reply exactly with ${DEFAULT_MARKER}. Do not use tools.`;
  let model: string | null = null;
  let timeoutMs = 120_000;
  let codexConfig: string | null = null;
  let codexRelayBaseUrl: string | null = null;
  let questionAnswer: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--allow-unavailable") {
      allowUnavailable = true;
      continue;
    }
    if (arg === "--check-only") {
      checkOnly = true;
      continue;
    }
    const [key, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const nextValue = () => inlineValue ?? args[++i];
    if (key === "--provider") provider = nextValue();
    else if (key === "--prompt") prompt = nextValue();
    else if (key === "--marker") marker = nextValue();
    else if (key === "--model") model = nextValue();
    else if (key === "--timeout-ms") timeoutMs = Number(nextValue());
    else if (key === "--codex-config") codexConfig = nextValue();
    else if (key === "--codex-relay-base-url") codexRelayBaseUrl = nextValue();
    else if (key === "--answer-question") questionAnswer = nextValue();
    else throw new Error(`Unknown argument: ${arg}`);
  }

  const providers = provider === "all"
    ? ["claude", "codex"] as SmokeProvider[]
    : [provider as SmokeProvider];
  for (const item of providers) {
    if (item !== "claude" && item !== "codex") throw new Error(`Unsupported provider: ${item}`);
  }
  if (!marker.trim()) throw new Error("--marker must not be empty");
  if (!prompt.trim()) throw new Error("--prompt must not be empty");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
  if (codexConfig) {
    try {
      JSON.parse(codexConfig);
    } catch {
      throw new Error("--codex-config must be valid JSON");
    }
  }
  if (questionAnswer != null && !questionAnswer.trim()) throw new Error("--answer-question must not be empty");
  if (codexRelayBaseUrl) {
    const parsed = new URL(codexRelayBaseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("--codex-relay-base-url must be an HTTP(S) URL");
    }
  }
  return {
    providers,
    allowUnavailable,
    checkOnly,
    prompt,
    marker,
    model,
    timeoutMs,
    codexConfig,
    codexRelayBaseUrl,
    questionAnswer,
  };
}

function executableUnavailable(command: string): string | null {
  if (!command) return "executable_absent";
  if (isAbsolute(command)) return existsSync(command) ? null : "executable_absent";
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return paths.some((entry) => existsSync(join(entry, command))) ? null : "executable_absent";
}

function defaultExecutable(provider: SmokeProvider): string {
  return provider === "claude" ? "claude-agent-acp" : "codex-acp";
}

function printHelp(): void {
  console.log(`Usage: bun run tests/integration/smoke-multiremi-acp.ts [--provider=all|claude|codex] [--allow-unavailable] [--check-only]

Runs a real ACP-backed Multiremi daemon smoke against a local in-memory server.
The smoke uses a daemon token, creates one agent/task, runs the daemon once, and
requires the completed task output to include the configured marker.

Options:
  --provider              Provider to run, default: all
  --allow-unavailable     Exit 0 when a provider executable/health check is unavailable
  --check-only            Only verify executables and health checks; do not send prompts
  --prompt                Prompt sent to the provider
  --marker                Required marker in completed output, default: ${DEFAULT_MARKER}
  --model                 Optional model passed to the agent/provider
  --timeout-ms            Per-task daemon timeout, default: 120000
  --codex-config          JSON forwarded through agent customEnv as CODEX_CONFIG
  --codex-relay-base-url  Use OPENAI_API_KEY with this Codex gateway in the in-memory server
  --answer-question       Wait for one question request and answer it over the user API
`);
}
