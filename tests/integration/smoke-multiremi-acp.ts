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
} from "../../src/acp/index.js";
import { startMultiremiServer } from "../../src/multiremi/api.js";
import { MultiremiDaemon } from "../../src/multiremi/daemon.js";
import { MultiremiStore } from "../../src/multiremi/store.js";

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
    });
    const timedOut = await runWithHardTimeout(daemon.start(), options.timeoutMs + 10_000);
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
    const assistantMessageCount = messages.filter((message) => message.type === "assistant").length;
    const usageMessageCount = messages.filter((message) => message.type === "usage").length;
    const messageCount = messages.length;
    const usageCount = completed?.usage.length ?? 0;
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

function parseArgs(args: string[]): SmokeOptions {
  let provider = "all";
  let allowUnavailable = false;
  let checkOnly = false;
  let marker = DEFAULT_MARKER;
  let prompt = `Reply exactly with ${DEFAULT_MARKER}. Do not use tools.`;
  let model: string | null = null;
  let timeoutMs = 120_000;

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
  return { providers, allowUnavailable, checkOnly, prompt, marker, model, timeoutMs };
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
`);
}
