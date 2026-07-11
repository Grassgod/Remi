import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { cpus, homedir, hostname } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { createLogger } from "@shared/logger.js";
import { AcpProvider, type AcpProviderOptions, bridgeVersion, agentCliVersion, reinstallBridge, type ProvisionProvider } from "@acp/index.js";
import type { ElicitationCreateParams, ElicitationResult, PermissionOutcome, RequestPermissionParams } from "@acp/protocol.js";
import { answersToElicitationContent, elicitationToQuestions } from "@shared/contracts/acp-elicitation.js";
import type { AgentResponse, Provider, ProviderEvent } from "@shared/contracts/provider-types.js";
import { MultiremiDaemonClient, type MultiremiDaemonGcStatus, type MultiremiDaemonRegisterResponse } from "./client.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import { MultiremiRepoCache, normalizeRepoList } from "@multiremi/repo-cache.js";
import { classifyDaemonTaskFailure, classifyPoisonedOutput } from "./task-failure.js";
import { multiremiVersion } from "@multiremi/version.js";
import {
  writeTaskContext,
  writeTaskGcContext,
  writeProjectResourceContext,
  writeAgentSkillContext,
  normalizeSkillFilePath,
} from "@daemon/agent-runtime/skills/ephemeral.js";
import { cleanProcessEnv } from "@daemon/agent-runtime/env/injector.js";
import { AgentRuntime } from "@daemon/agent-runtime/runtime.js";
import { AgentSession } from "@daemon/agent-runtime/session.js";
import type { EphemeralContext } from "@daemon/agent-runtime/types.js";
import {
  LocalDirectoryError,
  LocalPathLocker,
  resolveTaskWorkDir,
  type ResolvedTaskWorkDir,
} from "@daemon/agent-runtime/workspace/ephemeral.js";
import { runWorkspaceGcOnce, type MultiremiDaemonGcSummary } from "@daemon/agent-runtime/workspace/gc.js";
import type {
  MultiremiDaemonHeartbeatAck,
  MultiremiRepoData,
  MultiremiRuntimeDirectoryCandidate,
  MultiremiRuntimeLocalSkillSummary,
  MultiremiRuntimeModel,
  MultiremiRuntimeUpdateScope,
  MultiremiSkillFile,
  MultiremiTaskHumanRequest,
  MultiremiTaskWithAgent,
  RegisterRuntimeInput,
  TaskMessageInput,
  TaskUsageEntry,
} from "@multiremi/contracts/types.js";

// Re-export the per-task context writers (moved to daemon/agent-runtime/skills in D6)
// so existing `from "../multiremi/daemon.js"` imports keep resolving (铁律#3).
export { writeTaskContext, writeTaskGcContext, writeProjectResourceContext, writeAgentSkillContext };
// Re-export the workspace GC entry point (moved to daemon/agent-runtime/workspace
// in D6) so existing `from "../multiremi/daemon.js"` imports keep resolving.
export { runWorkspaceGcOnce, type MultiremiDaemonGcSummary };

const log = createLogger("multiremi-daemon");
const HUMAN_REQUEST_POLL_MS = 2000;

function readResponseOptionId(response: Record<string, unknown> | null): string | null {
  if (!response) return null;
  const value = response.option_id ?? response.optionId;
  return typeof value === "string" && value.trim() ? value : null;
}

function readResponseAnswers(response: Record<string, unknown> | null): Record<string, string> | null {
  if (!response || typeof response.answers !== "object" || response.answers === null || Array.isArray(response.answers)) return null;
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.answers as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) answers[key] = value;
  }
  return Object.keys(answers).length ? answers : null;
}
export const MULTIREMI_REREGISTER_COALESCE_WINDOW_MS = 30_000;
export const MULTIREMI_REREGISTER_FAILURE_BACKOFF_MS = 60_000;

export interface MultiremiDaemonOptions {
  serverUrl: string;
  token?: string | null;
  runtimeId?: string | null;
  daemonId?: string | null;
  runtimeName?: string;
  /**
   * Human-facing machine name shown as the runtime-card title. Shared across
   * all providers on this host (no provider suffix, no internal "bun-runtime"
   * token). The per-runtime row label is derived server-side as
   * `<provider> (<deviceName>)`.
   */
  deviceName?: string;
  provider?: string;
  workspaceId?: string | null;
  pollIntervalMs?: number;
  maxConcurrency?: number;
  once?: boolean;
  providerFactory?: MultiremiDaemonProviderFactory;
  updateRunner?: MultiremiDaemonUpdateRunner;
  localSkillRoots?: Record<string, string>;
  launchedBy?: string | null;
  onRestartRequested?: () => void;
  taskTimeoutMs?: number;
  /** "ask" routes permission/question prompts to a human via the server; "auto" (default) self-approves. */
  approvalMode?: "auto" | "ask";
  /** How long an "ask"-mode prompt waits for a human before expiring (default 30 min). */
  humanRequestTimeoutMs?: number;
  daemonPort?: number;
  workspacesRoot?: string;
  repoCacheRoot?: string;
  gcEnabled?: boolean;
  gcIntervalMs?: number;
  gcTtlMs?: number;
  gcOrphanTtlMs?: number;
}

interface RunSummary {
  output: string;
  sessionId: string | null;
  workDir: string | null;
  usage: TaskUsageEntry[];
}

export type MultiremiTaskProvider = Pick<Provider, "sendStream" | "getLastResponse"> & {
  close?: () => Promise<void> | void;
  setPermissionHandler?: (handler: (params: RequestPermissionParams) => Promise<PermissionOutcome>) => void;
  setElicitationHandler?: (handler: (params: ElicitationCreateParams) => Promise<ElicitationResult>) => void;
};

export type MultiremiDaemonProviderFactory = (options: AcpProviderOptions) => MultiremiTaskProvider;
export type MultiremiDaemonUpdateRunner = (targetVersion: string) => string | Promise<string>;

export class MultiremiRuntimeReregisterGate {
  private nextAttemptByWorkspace = new Map<string, number>();
  private lastCompletedAtByWorkspace = new Map<string, number>();

  tryClaimRegisterSlot(workspaceId: string, entryAtMs: number, nowMs: number): boolean {
    const nextAttempt = this.nextAttemptByWorkspace.get(workspaceId);
    if (nextAttempt !== undefined && nowMs < nextAttempt) return false;
    const lastCompletedAt = this.lastCompletedAtByWorkspace.get(workspaceId);
    if (lastCompletedAt !== undefined && lastCompletedAt >= entryAtMs) return false;
    this.nextAttemptByWorkspace.set(workspaceId, nowMs + MULTIREMI_REREGISTER_COALESCE_WINDOW_MS);
    return true;
  }

  recordRegisterCompletion(workspaceId: string, completedAtMs: number, error?: unknown): void {
    if (error) {
      this.nextAttemptByWorkspace.set(workspaceId, completedAtMs + MULTIREMI_REREGISTER_FAILURE_BACKOFF_MS);
      return;
    }
    this.lastCompletedAtByWorkspace.set(workspaceId, completedAtMs);
    this.nextAttemptByWorkspace.delete(workspaceId);
  }
}

export class MultiremiDaemon {
  private client: MultiremiDaemonClient;
  private options: Required<Omit<MultiremiDaemonOptions, "token" | "runtimeId" | "daemonId" | "workspaceId" | "providerFactory" | "updateRunner" | "localSkillRoots" | "launchedBy" | "onRestartRequested" | "taskTimeoutMs" | "daemonPort" | "workspacesRoot" | "repoCacheRoot" | "gcEnabled" | "gcIntervalMs" | "gcTtlMs" | "gcOrphanTtlMs">> & {
    token: string | null;
    runtimeId: string | null;
    daemonId: string | null;
    workspaceId: string | null;
    launchedBy: string | null;
    taskTimeoutMs: number;
    daemonPort: number;
    workspacesRoot: string;
    repoCacheRoot: string;
    gcEnabled: boolean;
    gcIntervalMs: number;
    gcTtlMs: number;
    gcOrphanTtlMs: number;
  };
  private providerFactory: MultiremiDaemonProviderFactory;
  private updateRunner: MultiremiDaemonUpdateRunner;
  private onRestartRequested: (() => void) | null;
  private localSkillRoots: Record<string, string>;
  private repoCache: MultiremiRepoCache;
  private repoServer: ReturnType<typeof Bun.serve> | null = null;
  private repoServerPort = 0;
  private workspaceRepoUrls = new Map<string, Set<string>>();
  private workspaceSettings = new Map<string, Record<string, unknown>>();
  private stopped = false;
  private startedAt = new Date();
  private ready = false;
  private activeTaskCount = 0;
  private inflight = new Set<Promise<void>>();
  private claimsPaused = false;
  private restartRequestedFlag = false;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private localPathLocks = new LocalPathLocker();
  private runtimeGoneInflight = new Set<string>();
  private reregisterGate = new MultiremiRuntimeReregisterGate();
  private readonly explicitRuntimeId: boolean;

  constructor(options: MultiremiDaemonOptions) {
    const workspacesRoot = options.workspacesRoot ?? process.env.MULTIREMI_WORKSPACES_ROOT ?? join(homedir(), ".remi", "multiremi", "workspaces");
    const runtimeName = options.runtimeName ?? process.env.MULTIREMI_RUNTIME_NAME ?? `${hostname()}-${Bun.env.USER ?? "local"}-bun-runtime`;
    const deviceName = options.deviceName ?? process.env.MULTIREMI_DEVICE_NAME ?? `${hostname()}-${Bun.env.USER ?? "local"}`;
    const runtimeId = options.runtimeId ?? process.env.MULTIREMI_RUNTIME_ID ?? null;
    const daemonId = options.daemonId ?? process.env.MULTIREMI_DAEMON_ID ?? runtimeId ?? deviceName;
    this.explicitRuntimeId = Boolean(runtimeId);
    this.options = {
      token: options.token ?? process.env.MULTIREMI_TOKEN ?? null,
      runtimeId,
      daemonId,
      runtimeName,
      deviceName,
      provider: options.provider ?? process.env.MULTIREMI_PROVIDER ?? "claude",
      workspaceId: options.workspaceId ?? process.env.MULTIREMI_WORKSPACE_ID ?? "local",
      pollIntervalMs: options.pollIntervalMs ?? parseInt(process.env.MULTIREMI_POLL_INTERVAL_MS ?? "3000", 10),
      maxConcurrency: resolveDaemonConcurrency(options.maxConcurrency ?? numberEnv(process.env.MULTIREMI_MAX_CONCURRENCY, 0)),
      once: options.once ?? false,
      launchedBy: options.launchedBy ?? process.env.MULTIREMI_LAUNCHED_BY ?? null,
      taskTimeoutMs: options.taskTimeoutMs ?? parseInt(process.env.MULTIREMI_TASK_TIMEOUT_MS ?? "0", 10),
      approvalMode: options.approvalMode ?? (process.env.MULTIREMI_APPROVAL_MODE === "ask" ? "ask" : "auto"),
      humanRequestTimeoutMs: options.humanRequestTimeoutMs ?? numberEnv(process.env.MULTIREMI_HUMAN_REQUEST_TIMEOUT_MS, 30 * 60 * 1000),
      daemonPort: options.daemonPort ?? numberEnv(process.env.MULTIREMI_DAEMON_PORT, 6131),
      workspacesRoot,
      repoCacheRoot: options.repoCacheRoot ?? process.env.MULTIREMI_REPO_CACHE_ROOT ?? join(workspacesRoot, ".repos"),
      gcEnabled: options.gcEnabled ?? booleanEnv(process.env.MULTIREMI_GC_ENABLED, true),
      gcIntervalMs: options.gcIntervalMs ?? numberEnv(process.env.MULTIREMI_GC_INTERVAL_MS, 15 * 60 * 1000),
      gcTtlMs: options.gcTtlMs ?? numberEnv(process.env.MULTIREMI_GC_TTL_MS, 72 * 60 * 60 * 1000),
      gcOrphanTtlMs: options.gcOrphanTtlMs ?? numberEnv(process.env.MULTIREMI_GC_ORPHAN_TTL_MS, 72 * 60 * 60 * 1000),
      serverUrl: options.serverUrl,
    };
    this.providerFactory = options.providerFactory ?? ((providerOptions) => new AcpProvider(providerOptions));
    this.updateRunner = options.updateRunner ?? runDefaultMultiremiUpdate;
    this.onRestartRequested = options.onRestartRequested ?? null;
    this.localSkillRoots = options.localSkillRoots ?? {};
    this.client = new MultiremiDaemonClient(options.serverUrl, this.options.token);
    this.repoCache = new MultiremiRepoCache(this.options.repoCacheRoot);
  }

  async start(): Promise<void> {
    this.startedAt = new Date();
    this.ready = false;
    this.stopped = false;
    this.claimsPaused = false;
    this.restartRequestedFlag = false;
    this.startRepoCheckoutServer();
    this.startGcLoop();
    try {
      await this.registerCurrentRuntime();
      await this.refreshWorkspaceRepos(this.options.workspaceId);
      // registerCurrentRuntime() assigns a non-null runtime id; it is re-read each
      // iteration because handleHeartbeatAck() may re-register and replace it.
      await this.client.recoverOrphans(this.options.runtimeId!);
      this.ready = true;

      while (!this.stopped) {
        try {
          const ack = await this.client.heartbeatRuntime(this.options.runtimeId!);
          const skipClaim = await this.handleHeartbeatAck(this.options.runtimeId!, ack);
          if (this.stopped || this.claimsPaused) break;
          if (skipClaim) {
            if (this.options.once) return;
            await sleep(this.options.pollIntervalMs);
            continue;
          }

          if (this.options.once) {
            // One-shot mode (tests, single runs) stays strictly serial:
            // claim one task, run it to completion, return.
            const task = await this.client.claimTask(this.options.runtimeId!) as MultiremiTaskWithAgent | null;
            if (!task) return;
            await this.handleTask(task);
            return;
          }

          // Bounded claim pump: keep claiming while we have spare capacity, and
          // run each task concurrently (detached). The server's claim query also
          // caps in-flight tasks at the runtime's maxConcurrency, so this local
          // gate and the server agree. activeTaskCount is incremented
          // synchronously at the top of handleTask, so the loop sees it grow.
          while (this.activeTaskCount < this.options.maxConcurrency && !this.stopped && !this.claimsPaused) {
            const task = await this.client.claimTask(this.options.runtimeId!) as MultiremiTaskWithAgent | null;
            if (!task) break;
            const run = this.handleTask(task).catch((err) => {
              // handleTask routes task failures to failTask itself; this guards
              // the detached promise against an unexpected unhandled rejection.
              log.error(`task ${task.id} crashed outside handleTask: ${err instanceof Error ? err.message : String(err)}`);
            });
            this.inflight.add(run);
            void run.finally(() => this.inflight.delete(run));
          }
          await sleep(this.options.pollIntervalMs);
        } catch (err) {
          // A transient server/network blip (e.g. the server restarting) must not
          // kill the daemon — that takes every runtime offline until a human
          // re-launches it. Log and retry on the next poll. `once` mode (tests,
          // one-shot runs) still surfaces the error.
          if (this.stopped || this.options.once) throw err;
          log.warn(`daemon poll loop error, retrying in ${this.options.pollIntervalMs}ms: ${err instanceof Error ? err.message : String(err)}`);
          await sleep(this.options.pollIntervalMs);
        }
      }
    } finally {
      this.ready = false;
      // Running tasks depend on the repo-checkout server, so let any in-flight
      // tasks drain before tearing it (and the GC loop) down.
      await Promise.allSettled([...this.inflight]);
      this.stopGcLoop();
      this.stopRepoCheckoutServer();
    }
  }

  private async registerCurrentRuntime(): Promise<string> {
    if (!this.explicitRuntimeId) {
      const response = await this.client.registerDaemonRuntime({
        workspaceId: this.options.workspaceId ?? "local",
        daemonId: this.options.daemonId ?? this.options.runtimeName,
        deviceName: this.options.deviceName,
        cliVersion: multiremiVersion,
        launchedBy: this.options.launchedBy ?? "manual",
        runtime: {
          // Empty name → server derives `<provider> (<deviceName>)`, which the
          // dashboard splits into the machine title + a clean provider row.
          name: "",
          type: this.options.provider,
          version: multiremiVersion,
          status: "online",
          maxConcurrency: this.options.maxConcurrency,
          acpVersion: this.acpVersion(),
          agentVersion: this.agentVersion(),
        },
      });
      const runtime = response.runtimes.find((item) => (item.provider ?? item.type) === this.options.provider) ?? response.runtimes[0];
      if (!runtime) throw new Error("daemon register returned no runtimes");
      this.options.runtimeId = runtime.id;
      this.syncWorkspaceRepos(response);
      log.info(`Runtime registered: ${this.options.runtimeId} (${this.options.provider})`);
      return this.options.runtimeId;
    }
    const runtime = await this.client.registerRuntime(this.currentRuntimeRegistrationInput());
    this.options.runtimeId = runtime.runtime.id;
    log.info(`Runtime registered: ${this.options.runtimeId} (${this.options.provider})`);
    return this.options.runtimeId;
  }

  private syncWorkspaceRepos(response: MultiremiDaemonRegisterResponse): void {
    const workspaceId = response.workspace_id ?? this.options.workspaceId ?? "local";
    const repos = normalizeRepoList(response.repos ?? []);
    this.workspaceRepoUrls.set(workspaceId, new Set(repos.map((repo) => repo.url.trim()).filter(Boolean)));
    this.workspaceSettings.set(workspaceId, response.settings ?? {});
    this.repoCache.sync(workspaceId, repos);
  }

  /** Version of this runtime's ACP bridge (claude-agent-acp / codex-acp), or null. */
  private acpVersion(): string | null {
    const provider = this.options.provider;
    return provider === "claude" || provider === "codex" ? bridgeVersion(provider) : null;
  }

  /** Version of the underlying agent CLI (`claude` / `codex`), or null. */
  private agentVersion(): string | null {
    const provider = this.options.provider;
    return provider === "claude" || provider === "codex" ? agentCliVersion(provider) : null;
  }

  private currentRuntimeRegistrationInput(): RegisterRuntimeInput {
    return {
      id: this.options.runtimeId ?? undefined,
      name: this.options.runtimeName,
      provider: this.options.provider,
      daemonId: this.options.daemonId ?? undefined,
      runtimeMode: "local",
      workspaceId: this.options.workspaceId,
      maxConcurrency: this.options.maxConcurrency,
      metadata: {
        version: multiremiVersion,
        cli_version: multiremiVersion,
        acp_version: this.acpVersion() ?? undefined,
        agent_version: this.agentVersion() ?? undefined,
        launched_by: this.options.launchedBy ?? "manual",
      },
      deviceInfo: `${this.options.runtimeName} · ${multiremiVersion}`,
      models: defaultRuntimeModels(this.options.provider),
    };
  }

  private async handleHeartbeatAck(runtimeId: string, ack: MultiremiDaemonHeartbeatAck): Promise<boolean> {
    if (ack.status === "runtime_gone" || ack.runtime_gone) {
      return !(await this.handleRuntimeGone(runtimeId, Date.now()));
    }
    if (ack.pending_update) {
      await this.handleRuntimeUpdate(runtimeId, ack.pending_update.id, ack.pending_update.target_version, ack.pending_update.scope ?? "cli");
    }
    if (ack.pending_model_list) {
      await this.handleRuntimeModelList(runtimeId, ack.pending_model_list.id);
    }
    if (ack.pending_local_skills) {
      await this.handleRuntimeLocalSkillList(runtimeId, ack.pending_local_skills.id);
    }
    if (ack.pending_directory_scan) {
      await this.handleRuntimeDirectoryScan(runtimeId, ack.pending_directory_scan);
    }
    const imports = ack.pending_local_skill_imports?.length
      ? ack.pending_local_skill_imports
      : ack.pending_local_skill_import
        ? [ack.pending_local_skill_import]
        : [];
    for (const request of imports) {
      await this.handleRuntimeLocalSkillImport(runtimeId, request.id, request.skill_key);
    }
    return false;
  }

  private async handleRuntimeGone(runtimeId: string, entryAtMs: number): Promise<boolean> {
    const workspaceId = this.options.workspaceId;
    if (!workspaceId) {
      this.stopped = true;
      return false;
    }
    if (this.runtimeGoneInflight.has(runtimeId)) return false;
    this.runtimeGoneInflight.add(runtimeId);
    try {
      if (!this.reregisterGate.tryClaimRegisterSlot(workspaceId, entryAtMs, Date.now())) {
        log.debug(`Skip runtime_gone re-register for ${workspaceId}: coalesced with a recent attempt`);
        return false;
      }
      let newRuntimeId: string;
      try {
        newRuntimeId = await this.registerCurrentRuntime();
        this.reregisterGate.recordRegisterCompletion(workspaceId, Date.now());
      } catch (error) {
        this.reregisterGate.recordRegisterCompletion(workspaceId, Date.now(), error);
        log.warn(`Re-register after runtime_gone failed for ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      await this.refreshWorkspaceRepos(workspaceId);
      try {
        await this.client.recoverOrphans(newRuntimeId);
      } catch (error) {
        log.warn(`Recover orphans after runtime_gone failed for ${newRuntimeId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return true;
    } finally {
      this.runtimeGoneInflight.delete(runtimeId);
    }
  }

  private async handleRuntimeUpdate(
    runtimeId: string,
    requestId: string,
    targetVersion: string,
    scope: MultiremiRuntimeUpdateScope = "cli",
  ): Promise<void> {
    // Only the CLI binary is owned by the Desktop app; the ACP bridges live in
    // ~/.remi and are independent of how the daemon was launched.
    if (scope === "cli" && this.options.launchedBy === "desktop") {
      await this.client.reportRuntimeUpdateResult(runtimeId, requestId, {
        status: "failed",
        error: "CLI is managed by Multiremi Desktop - update the Desktop app to upgrade the CLI",
      });
      return;
    }
    if (!this.tryPauseClaimsForUpdate()) {
      await this.client.reportRuntimeUpdateResult(runtimeId, requestId, {
        status: "failed",
        error: "daemon is busy; retry update when idle",
      });
      return;
    }
    try {
      await this.client.reportRuntimeUpdateResult(runtimeId, requestId, { status: "running" });
      const output = scope === "acp"
        ? this.reinstallAcpBridge()
        : scope === "agent"
          ? await this.updateAgentCli()
          : await this.updateRunner(targetVersion);
      await this.client.reportRuntimeUpdateResult(runtimeId, requestId, {
        status: "completed",
        output: output || (scope === "acp" ? "ACP bridge updated" : scope === "agent" ? "Agent updated" : `Updated to ${targetVersion}`),
      });
      this.requestRestartAfterUpdate();
    } catch (err) {
      this.releaseUpdateClaimPause();
      await this.client.reportRuntimeUpdateResult(runtimeId, requestId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Force-reinstall this runtime's ACP bridge to the latest version. */
  private reinstallAcpBridge(): string {
    const provider = this.options.provider;
    if (provider !== "claude" && provider !== "codex") {
      throw new Error(`ACP bridge update not supported for provider: ${provider}`);
    }
    return reinstallBridge(provider as ProvisionProvider, (m) => log.info(`[acp] ${m}`));
  }

  /** Update the underlying agent CLI (claude/codex) via its own `update` subcommand. */
  private async updateAgentCli(): Promise<string> {
    const provider = this.options.provider;
    if (provider !== "claude" && provider !== "codex") {
      throw new Error(`agent update not supported for provider: ${provider}`);
    }
    // Spawn with the daemon's own env: it was launched from a login shell, so
    // PATH already resolves claude/codex (incl. Homebrew on macOS).
    const proc = Bun.spawn([provider, "update"], { stdout: "pipe", stderr: "pipe", env: process.env });
    const [stdout, stderr, exitCode] = await Promise.all([
      streamText(proc.stdout),
      streamText(proc.stderr),
      proc.exited,
    ]);
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    if (exitCode !== 0) throw new Error(output || `${provider} update failed with exit code ${exitCode}`);
    return output || `${provider} updated`;
  }

  private async handleRuntimeModelList(runtimeId: string, requestId: string): Promise<void> {
    await this.client.reportRuntimeModelListResult(runtimeId, requestId, {
      status: "completed",
      supported: true,
      models: defaultRuntimeModels(this.options.provider),
    });
  }

  private async handleRuntimeLocalSkillList(runtimeId: string, requestId: string): Promise<void> {
    const root = localSkillRootForProvider(this.options.provider, this.localSkillRoots);
    if (!root) {
      await this.client.reportRuntimeLocalSkillListResult(runtimeId, requestId, {
        status: "completed",
        supported: false,
        skills: [],
      });
      return;
    }
    try {
      await this.client.reportRuntimeLocalSkillListResult(runtimeId, requestId, {
        status: "completed",
        supported: true,
        skills: listRuntimeLocalSkills(this.options.provider, root),
      });
    } catch (err) {
      await this.client.reportRuntimeLocalSkillListResult(runtimeId, requestId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleRuntimeDirectoryScan(
    runtimeId: string,
    request: { id: string; root?: string; max_depth?: number; mode?: string },
  ): Promise<void> {
    try {
      if (request.mode === "browse") {
        const { candidates, resolvedRoot } = await browseRuntimeDirectory(request.root);
        await this.client.reportRuntimeDirectoryScanResult(runtimeId, request.id, {
          status: "completed",
          supported: true,
          candidates,
          resolvedRoot,
        });
      } else {
        const candidates = await scanRuntimeDirectories(request.root, request.max_depth);
        await this.client.reportRuntimeDirectoryScanResult(runtimeId, request.id, {
          status: "completed",
          supported: true,
          candidates,
        });
      }
    } catch (err) {
      await this.client.reportRuntimeDirectoryScanResult(runtimeId, request.id, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleRuntimeLocalSkillImport(runtimeId: string, requestId: string, skillKey: string): Promise<void> {
    const root = localSkillRootForProvider(this.options.provider, this.localSkillRoots);
    if (!root) {
      await this.client.reportRuntimeLocalSkillImportResult(runtimeId, requestId, {
        status: "failed",
        error: `provider ${JSON.stringify(this.options.provider)} does not expose runtime local skills`,
      });
      return;
    }
    try {
      await this.client.reportRuntimeLocalSkillImportResult(runtimeId, requestId, {
        status: "completed",
        skill: loadRuntimeLocalSkillBundle(this.options.provider, root, skillKey),
      });
    } catch (err) {
      await this.client.reportRuntimeLocalSkillImportResult(runtimeId, requestId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async runGcOnce(): Promise<MultiremiDaemonGcSummary> {
    const summary = await runWorkspaceGcOnce({
      root: this.options.workspacesRoot,
      ttlMs: this.options.gcTtlMs,
      orphanTtlMs: this.options.gcOrphanTtlMs,
      client: this.client,
    });
    this.repoCache.pruneWorktrees();
    return summary;
  }

  restartRequested(): boolean {
    return this.restartRequestedFlag;
  }

  localPort(): number {
    return this.repoServerPort;
  }

  private tryPauseClaimsForUpdate(): boolean {
    if (this.claimsPaused || this.activeTaskCount > 0) return false;
    this.claimsPaused = true;
    return true;
  }

  private releaseUpdateClaimPause(): void {
    if (!this.restartRequestedFlag) this.claimsPaused = false;
  }

  private requestRestartAfterUpdate(): void {
    this.restartRequestedFlag = true;
    this.stopped = true;
    this.onRestartRequested?.();
  }

  private async handleTask(task: MultiremiTaskWithAgent): Promise<void> {
    this.activeTaskCount++;
    log.info(`Claimed task ${task.id}`);
    const abort = new AbortController();
    const cancelWatcher = this.watchCancellation(task.id, abort);
    let timedOut = false;
    const timeoutMs = Number.isFinite(this.options.taskTimeoutMs) ? Math.max(0, this.options.taskTimeoutMs) : 0;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, timeoutMs)
      : null;
    let summary: RunSummary | null = null;
    let resolvedWorkDir: ResolvedTaskWorkDir | null = null;

    try {
      resolvedWorkDir = await this.resolveTaskWorkDir(task, abort.signal);
      await this.client.startTask(task.id);
      await this.client.reportProgress(task.id, "Agent execution started", 1, 3);
      summary = await this.runAgent(task, abort.signal, resolvedWorkDir);
      const poisonedReason = classifyPoisonedOutput(summary.output);
      if (poisonedReason) {
        await this.client.reportTaskUsage(task.id, summary.usage);
        await this.client.failTask(task.id, summary.output, summary.sessionId, summary.workDir, poisonedReason);
        log.warn(`Failed task ${task.id} with poisoned output: ${poisonedReason}`);
        return;
      }
      await this.client.reportProgress(task.id, "Agent execution completed", 3, 3);
      await this.client.reportTaskUsage(task.id, summary.usage);
      await this.client.completeTask(task.id, summary.output, summary.sessionId, summary.workDir);
      log.info(`Completed task ${task.id}`);
    } catch (err) {
      const error = timedOut ? `Agent timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
      if (!timedOut && abort.signal.aborted && await this.wasTaskCancelledByServer(task.id)) {
        log.info(`Task ${task.id} was cancelled by the server`);
        return;
      }
      const failureReason = err instanceof LocalDirectoryError
        ? err.failureReason
        : classifyDaemonTaskFailure(task.agent?.provider ?? "", error);
      await this.client.failTask(task.id, error, summary?.sessionId ?? task.sessionId, summary?.workDir ?? task.workDir, failureReason);
      log.error(`Failed task ${task.id}: ${error}`);
    } finally {
      resolvedWorkDir?.release?.();
      this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);
      clearInterval(cancelWatcher);
      if (timeout) clearTimeout(timeout);
    }
  }

  private async resolveTaskWorkDir(task: MultiremiTaskWithAgent, signal: AbortSignal): Promise<ResolvedTaskWorkDir> {
    return resolveTaskWorkDir(task, {
      daemonIds: this.localDirectoryDaemonIds(task),
      workspacesRoot: this.options.workspacesRoot,
      locker: this.localPathLocks,
      signal,
      onWaitLocalDirectory: async (taskId, reason) => {
        await this.client.markTaskWaitingLocalDirectory(taskId, reason).catch((err) => {
          log.warn(`Failed to mark task ${taskId} waiting_local_directory: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
    });
  }

  private localDirectoryDaemonIds(task: MultiremiTaskWithAgent): string[] {
    return [
      this.options.daemonId,
      this.options.runtimeId,
      task.runtimeId,
      this.options.runtimeName,
    ].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  }

  private attachHumanInputHandlers(
    provider: MultiremiTaskProvider,
    task: MultiremiTaskWithAgent,
    signal: AbortSignal,
    nextSeq: () => number,
  ): void {
    if (this.options.approvalMode !== "ask") {
      provider.setPermissionHandler?.((params) => {
        const allow = params.options.find((o) => o.kind === "allow_always")
          ?? params.options.find((o) => o.kind === "allow_once");
        return Promise.resolve<PermissionOutcome>(
          allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" },
        );
      });
      // Elicitation stays unhandled in auto mode: the provider cancels it and
      // the agent picks its own answer, matching pre-approval-routing behavior.
      return;
    }

    provider.setPermissionHandler?.(async (params) => {
      try {
        const toolTitle = params.toolCall?.title ?? "tool call";
        const request = await this.client.createTaskHumanRequest(task.id, {
          kind: "permission",
          payload: { session_id: params.sessionId, tool_call: params.toolCall ?? null, options: params.options },
        });
        await this.reportHumanRequestMessage(task.id, nextSeq(), "permission_request", `Permission requested: ${toolTitle}`, {
          request_id: request.id,
          options: params.options,
          tool_call: params.toolCall ?? null,
        });
        const settled = await this.awaitHumanDecision(task.id, request.id, signal);
        const optionId = settled?.status === "responded" ? readResponseOptionId(settled.response) : null;
        const chosen = optionId ? params.options.find((o) => o.optionId === optionId) ?? null : null;
        await this.reportHumanRequestMessage(
          task.id,
          nextSeq(),
          "permission_response",
          chosen
            ? `Permission ${chosen.kind.startsWith("allow") ? "granted" : "denied"}: ${chosen.name}`
            : `Permission request ${settled?.status ?? "cancelled"}`,
          { request_id: request.id, option_id: optionId, status: settled?.status ?? "cancelled", responded_by: settled?.respondedBy ?? null },
        );
        if (optionId) return { outcome: "selected", optionId };
        return { outcome: "cancelled" };
      } catch (err) {
        // Conservative deny when the routing infrastructure itself fails.
        log.warn(`Permission routing failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
        return { outcome: "cancelled" };
      }
    });

    provider.setElicitationHandler?.(async (params) => {
      try {
        const questions = elicitationToQuestions(params);
        if (!questions?.length) return { action: "cancel" };
        const request = await this.client.createTaskHumanRequest(task.id, {
          kind: "question",
          payload: { session_id: params.sessionId, message: params.message, questions },
        });
        await this.reportHumanRequestMessage(task.id, nextSeq(), "question_request", params.message || "Agent asked a question", {
          request_id: request.id,
          questions,
        });
        const settled = await this.awaitHumanDecision(task.id, request.id, signal);
        const answers = settled?.status === "responded" ? readResponseAnswers(settled.response) : null;
        await this.reportHumanRequestMessage(
          task.id,
          nextSeq(),
          "question_response",
          answers ? Object.entries(answers).map(([q, a]) => `${q}: ${a}`).join("; ") : `Question ${settled?.status ?? "cancelled"}`,
          { request_id: request.id, answers, status: settled?.status ?? "cancelled", responded_by: settled?.respondedBy ?? null },
        );
        if (!answers) return { action: "cancel" };
        return { action: "accept", content: answersToElicitationContent(questions, answers) };
      } catch (err) {
        log.warn(`Question routing failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
        return { action: "cancel" };
      }
    });
  }

  /**
   * Poll until the request leaves "pending", the task aborts, or the human
   * timeout elapses. Timeout/abort expires the request server-side; if a human
   * response won that race, the server returns the responded row and we honor it.
   */
  private async awaitHumanDecision(taskId: string, requestId: string, signal: AbortSignal): Promise<MultiremiTaskHumanRequest | null> {
    const deadline = Date.now() + Math.max(0, this.options.humanRequestTimeoutMs);
    while (!signal.aborted && Date.now() < deadline) {
      try {
        const request = await this.client.getTaskHumanRequest(taskId, requestId);
        if (request && request.status !== "pending") return request;
      } catch (err) {
        log.warn(`Poll human request ${requestId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(Math.min(Math.max(this.options.pollIntervalMs, 250), HUMAN_REQUEST_POLL_MS));
    }
    try {
      return await this.client.expireTaskHumanRequest(taskId, requestId, signal.aborted ? "cancelled" : "timeout");
    } catch (err) {
      log.warn(`Expire human request ${requestId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async reportHumanRequestMessage(taskId: string, seq: number, type: string, content: string, input: Record<string, unknown>): Promise<void> {
    try {
      await this.client.reportTaskMessages(taskId, [{ seq, type, content, input }]);
    } catch (err) {
      log.warn(`Failed to report ${type} message for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runAgent(task: MultiremiTaskWithAgent, signal: AbortSignal, resolvedWorkDir: ResolvedTaskWorkDir): Promise<RunSummary> {
    const agent = task.agent;
    if (!agent) throw new Error(`Task ${task.id} has no agent`);
    if (agent.provider !== "claude" && agent.provider !== "codex") {
      throw new Error(`Unsupported Bun Multiremi provider: ${agent.provider}`);
    }

    const workDir = resolvedWorkDir.workDir;
    if (!resolvedWorkDir.localDirectory) mkdirSync(workDir, { recursive: true });
    await this.registerTaskRepos(task.workspaceId, task.repos ?? []);
    try {
      writeTaskContext(workDir, task);
      writeTaskGcContext(workDir, task, { localDirectory: resolvedWorkDir.localDirectory });
      writeProjectResourceContext(workDir, task);
      writeAgentSkillContext(workDir, task);
    } catch (err) {
      log.warn(`Failed to write task context for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.client.pinTaskSession(task.id, task.sessionId, workDir);

    // Assemble config via AgentRuntime
    const runtime = new AgentRuntime();
    const ctx: EphemeralContext = {
      kind: "ephemeral",
      task,
      daemonOptions: {
        daemonPort: this.repoServerPort,
        serverUrl: this.options.serverUrl,
        fallbackToken: this.options.token,
        workspacesRoot: this.options.workspacesRoot,
      },
      workDir,
      signal,
      approvalMode: this.options.approvalMode,
    };
    const config = runtime.assemble(ctx);

    const provider = this.providerFactory({
      agentType: config.agentType,
      executable: config.executable,
      model: config.model,
      allowedTools: config.allowedTools,
      cwd: config.cwd,
      env: config.env,
      getMcpServers: () => config.mcpServers,
    });
    if (!provider.sendStream) {
      throw new Error(`Provider ${agent.provider} does not support streaming`);
    }
    let output = "";
    let seq = 1;
    const nextSeq = () => seq++;
    this.attachHumanInputHandlers(provider, task, signal, nextSeq);
    let finalSessionId: string | null = task.sessionId;
    let usage: TaskUsageEntry[] = [];

    try {
      const session = new AgentSession(provider as any, config);
      const prompt = buildTaskPrompt(task);
      for await (const event of session.run(prompt)) {
        const message = eventToTaskMessage(event, nextSeq());
        if (message) {
          // eventToTaskMessage reports assistant text as type "text" — this is
          // what becomes the task result / issue activity body on completion.
          if (message.type === "text" && message.content) output += message.content;
          await this.client.reportTaskMessages(task.id, [message]);
        }
      }
      const last = provider.getLastResponse?.() as AgentResponse | null | undefined;
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

  private async wasTaskCancelledByServer(taskId: string): Promise<boolean> {
    try {
      return await this.client.getTaskStatus(taskId) === "cancelled";
    } catch (err) {
      return err instanceof Error && /\b404\b/.test(err.message);
    }
  }

  private startRepoCheckoutServer(): void {
    if (this.repoServer) return;
    this.repoServer = Bun.serve({
      hostname: "127.0.0.1",
      port: this.options.daemonPort,
      fetch: (request) => this.handleLocalDaemonRequest(request),
    });
    // TCP servers always expose a numeric port; default to 0 to satisfy the type.
    this.repoServerPort = this.repoServer.port ?? 0;
    log.info(`Repo checkout server listening on 127.0.0.1:${this.repoServerPort}`);
  }

  private stopRepoCheckoutServer(): void {
    this.repoServer?.stop(true);
    this.repoServer = null;
    this.repoServerPort = 0;
  }

  private startGcLoop(): void {
    if (!this.options.gcEnabled || this.options.once) return;
    this.runGcOnce().catch((err) => {
      log.warn(`Workspace GC failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (this.options.gcIntervalMs <= 0) return;
    this.gcTimer = setInterval(() => {
      this.runGcOnce().catch((err) => {
        log.warn(`Workspace GC failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.options.gcIntervalMs);
  }

  private stopGcLoop(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = null;
  }

  private async handleLocalDaemonRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return this.handleHealthRequest(request);
    if (url.pathname === "/shutdown") return this.handleShutdownRequest(request);
    if (url.pathname !== "/repo/checkout") return jsonResponse({ error: "not found" }, 404);
    if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch (err) {
      return jsonResponse({ error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
    const repoUrl = stringField(body.url);
    const workspaceId = stringField(body.workspace_id ?? body.workspaceId);
    const workDir = stringField(body.workdir ?? body.workDir);
    if (!repoUrl) return jsonResponse({ error: "url is required" }, 400);
    if (!workspaceId) return jsonResponse({ error: "workspace_id is required" }, 400);
    if (!workDir) return jsonResponse({ error: "workdir is required" }, 400);

    try {
      await this.ensureRepoReady(workspaceId, repoUrl);
      const result = this.repoCache.createWorktree({
        workspaceId,
        repoUrl,
        workDir,
        ref: stringField(body.ref) ?? undefined,
        agentName: stringField(body.agent_name ?? body.agentName) ?? "agent",
        taskId: stringField(body.task_id ?? body.taskId) ?? "task",
        coAuthoredByEnabled: this.workspaceCoAuthoredByEnabled(workspaceId),
      });
      return jsonResponse(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: message }, message.includes("not configured") ? 400 : 500);
    }
  }

  private handleHealthRequest(request: Request): Response {
    if (request.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);
    return jsonResponse({
      status: this.ready ? "running" : "starting",
      pid: process.pid,
      uptime: formatDuration(Date.now() - this.startedAt.getTime()),
      runtime_id: this.options.runtimeId,
      runtime_name: this.options.runtimeName,
      provider: this.options.provider,
      workspace_id: this.options.workspaceId,
      server_url: this.options.serverUrl,
      cli_version: multiremiVersion,
      active_task_count: this.activeTaskCount,
      daemon_port: this.repoServerPort,
      restart_requested: this.restartRequestedFlag,
    });
  }

  private handleShutdownRequest(request: Request): Response {
    if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
    setTimeout(() => {
      this.stop();
      this.stopRepoCheckoutServer();
    }, 10);
    return jsonResponse({ status: "shutting_down" });
  }

  private async refreshWorkspaceRepos(workspaceId: string | null): Promise<void> {
    if (!workspaceId) return;
    try {
      const response = await this.client.getWorkspaceRepos(workspaceId);
      this.workspaceRepoUrls.set(workspaceId, new Set(response.repos.map((repo) => repo.url.trim()).filter(Boolean)));
      this.workspaceSettings.set(workspaceId, response.settings ?? {});
      this.repoCache.sync(workspaceId, response.repos);
    } catch (err) {
      log.warn(`Workspace repo sync failed for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async registerTaskRepos(workspaceId: string, repos: MultiremiRepoData[]): Promise<void> {
    const normalized = normalizeRepoList(repos);
    if (!normalized.length) return;
    const allowed = this.workspaceRepoUrls.get(workspaceId) ?? new Set<string>();
    for (const repo of normalized) allowed.add(repo.url);
    this.workspaceRepoUrls.set(workspaceId, allowed);
    try {
      this.repoCache.sync(workspaceId, normalized);
    } catch (err) {
      log.warn(`Task repo sync failed for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async ensureRepoReady(workspaceId: string, repoUrl: string): Promise<void> {
    if (!this.isRepoAllowed(workspaceId, repoUrl)) {
      await this.refreshWorkspaceRepos(workspaceId);
    }
    if (!this.isRepoAllowed(workspaceId, repoUrl)) {
      throw new Error(`repo not configured for workspace: ${repoUrl}`);
    }
    if (!this.repoCache.lookup(workspaceId, repoUrl)) {
      this.repoCache.sync(workspaceId, [{ url: repoUrl }]);
    }
    if (!this.repoCache.lookup(workspaceId, repoUrl)) {
      throw new Error(`repo is configured but not synced: ${repoUrl}`);
    }
  }

  private isRepoAllowed(workspaceId: string, repoUrl: string): boolean {
    return this.workspaceRepoUrls.get(workspaceId)?.has(repoUrl.trim()) ?? false;
  }

  private workspaceCoAuthoredByEnabled(workspaceId: string): boolean {
    const settings = this.workspaceSettings.get(workspaceId);
    if (!settings) return true;
    const githubEnabled = optionalBoolean(settings.github_enabled)
      ?? optionalBoolean(settings.githubEnabled)
      ?? optionalBoolean(settings.enabled);
    if (githubEnabled === false) return false;
    const coAuthoredByEnabled = optionalBoolean(settings.co_authored_by_enabled)
      ?? optionalBoolean(settings.coAuthoredByEnabled)
      ?? optionalBoolean(settings.coauthor_enabled)
      ?? optionalBoolean(settings.coauthorEnabled)
      ?? optionalBoolean(settings.coAuthor);
    return coAuthoredByEnabled ?? true;
  }
}

function stringField(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve the runtime's task concurrency. An explicit value >= 1 wins;
 * anything else (0/unset) defaults to one fewer than the machine's CPU count
 * (min 1), so a daemon runs several tasks at once without saturating the box.
 */
function resolveDaemonConcurrency(value: number | undefined): number {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return Math.max(1, cpus().length - 1);
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function eventToTaskMessage(event: ProviderEvent, seq: number): TaskMessageInput | null {
  const raw = event as Record<string, any>;
  if (raw.sessionUpdate === "agent_message_chunk" || raw.sessionUpdate === "agent_thought_chunk") {
    const content = extractText(raw.content);
    if (!content) return null;
    return {
      seq,
      type: raw.sessionUpdate === "agent_thought_chunk" ? "thinking" : "text",
      content,
    };
  }
  if (raw.sessionUpdate === "tool_call" || raw.sessionUpdate === "tool_call_update") {
    return {
      seq,
      type: raw.sessionUpdate === "tool_call_update" ? "tool_result" : "tool_use",
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

const MAX_LOCAL_SKILL_FILE_SIZE = 1 << 20;
const MAX_LOCAL_SKILL_BUNDLE_SIZE = 8 << 20;
const MAX_LOCAL_SKILL_FILE_COUNT = 128;
const MAX_LOCAL_SKILL_DIR_DEPTH = 4;
const LOCAL_SKILL_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

function localSkillRootForProvider(provider: string, overrides: Record<string, string>): string | null {
  const normalized = provider.toLowerCase();
  if (overrides[normalized]) return overrides[normalized];
  if (normalized === "claude") {
    return process.env.MULTIREMI_CLAUDE_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
  }
  if (normalized === "codex") {
    return process.env.MULTIREMI_CODEX_SKILLS_DIR ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills");
  }
  return null;
}

function listRuntimeLocalSkills(provider: string, root: string): MultiremiRuntimeLocalSkillSummary[] {
  if (!existsSync(root)) return [];
  const rootPath = resolve(root);
  const summaries: MultiremiRuntimeLocalSkillSummary[] = [];
  const visited = new Set<string>();
  walkLocalSkillDirs(rootPath, rootPath, 0, summaries, provider, visited);
  return summaries.sort((left, right) => left.key.localeCompare(right.key));
}

function walkLocalSkillDirs(
  root: string,
  dir: string,
  depth: number,
  summaries: MultiremiRuntimeLocalSkillSummary[],
  provider: string,
  visited: Set<string>,
): void {
  if (depth > MAX_LOCAL_SKILL_DIR_DEPTH) return;
  const realPath = safeRealPath(dir);
  if (!realPath || visited.has(realPath)) return;
  visited.add(realPath);

  const entries = safeReadDir(dir);
  if (!entries) return;

  if (isFile(join(dir, "SKILL.md"))) {
    const key = slashPath(relative(root, dir));
    if (key) {
      let main: string;
      let files: MultiremiSkillFile[];
      try {
        main = readRuntimeLocalSkillMainFile(dir);
        files = collectRuntimeLocalSkillFiles(dir, false);
      } catch {
        return;
      }
      const meta = parseSkillFrontmatter(main);
      summaries.push({
        key,
        name: meta.name || humanizeSkillKey(key),
        description: meta.description,
        sourcePath: relativizeHomePath(dir),
        source_path: relativizeHomePath(dir),
        provider,
        fileCount: files.length + 1,
        file_count: files.length + 1,
      });
    }
    return;
  }

  for (const entry of entries) {
    if (isIgnoredLocalSkillEntry(entry.name)) continue;
    const child = join(dir, entry.name);
    if (isDirectory(child)) walkLocalSkillDirs(root, child, depth + 1, summaries, provider, visited);
  }
}

function loadRuntimeLocalSkillBundle(provider: string, root: string, rawKey: string): {
  name: string;
  description: string;
  content: string;
  source_path: string;
  provider: string;
  files: MultiremiSkillFile[];
} {
  const key = normalizeLocalSkillKey(rawKey);
  if (key.split("/").length > MAX_LOCAL_SKILL_DIR_DEPTH) {
    throw new Error(`local skill key exceeds ${MAX_LOCAL_SKILL_DIR_DEPTH} directory levels`);
  }
  const rootPath = resolve(root);
  const skillDir = resolve(rootPath, key);
  const rel = slashPath(relative(rootPath, skillDir));
  if (!rel || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) throw new Error("invalid skill key");
  if (!isDirectory(skillDir)) throw new Error("local skill not found");
  const content = readRuntimeLocalSkillMainFile(skillDir);
  const meta = parseSkillFrontmatter(content);
  return {
    name: meta.name || humanizeSkillKey(key),
    description: meta.description ?? "",
    content,
    source_path: skillDir,
    provider,
    files: collectRuntimeLocalSkillFiles(skillDir, true),
  };
}

function collectRuntimeLocalSkillFiles(skillDir: string, includeContent: boolean): MultiremiSkillFile[] {
  const files: MultiremiSkillFile[] = [];
  let totalSize = 0;

  const visit = (dir: string): void => {
    const entries = safeReadDir(dir);
    if (!entries) return;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredLocalSkillEntry(entry.name)) visit(path);
        continue;
      }
      if (!entry.isFile() || isIgnoredLocalSkillEntry(entry.name) || entry.name.toLowerCase() === "skill.md") continue;
      const rel = slashPath(relative(skillDir, path));
      let normalized: string;
      try {
        normalized = normalizeSkillFilePath(rel);
      } catch {
        continue;
      }
      const size = fileSize(path);
      if (size == null || size > MAX_LOCAL_SKILL_FILE_SIZE) continue;
      const content = readRuntimeLocalSkillTextFile(path);
      if (content == null) continue;
      if (files.length >= MAX_LOCAL_SKILL_FILE_COUNT) throw new Error(`local skill exceeds ${MAX_LOCAL_SKILL_FILE_COUNT} files`);
      totalSize += size;
      if (totalSize > MAX_LOCAL_SKILL_BUNDLE_SIZE) throw new Error(`local skill exceeds ${MAX_LOCAL_SKILL_BUNDLE_SIZE} bytes in total`);
      files.push({ path: normalized, content: includeContent ? content : "" });
    }
  };

  visit(skillDir);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function readRuntimeLocalSkillMainFile(skillDir: string): string {
  const mainPath = join(skillDir, "SKILL.md");
  const size = fileSize(mainPath);
  if (size == null) throw new Error("local skill not found");
  if (size > MAX_LOCAL_SKILL_FILE_SIZE) throw new Error(`SKILL.md exceeds ${MAX_LOCAL_SKILL_FILE_SIZE} bytes`);
  const content = readRuntimeLocalSkillTextFile(mainPath);
  if (content == null) throw new Error("SKILL.md is not valid UTF-8 text");
  return content;
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta: { name?: string; description?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const parsed = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!parsed) continue;
    const key = parsed[1]!.toLowerCase();
    const value = parsed[2]!.trim().replace(/^["']|["']$/g, "");
    if (key === "name") meta.name = value;
    if (key === "description") meta.description = value;
  }
  return meta;
}

function normalizeLocalSkillKey(value: string): string {
  const normalized = slashPath(String(value ?? "").trim());
  if (!normalized) throw new Error("skill key is required");
  const parts = normalized.split("/").filter(Boolean);
  if (normalized.startsWith("/") || parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("invalid skill key");
  }
  return parts.join("/");
}

function isIgnoredLocalSkillEntry(name: string): boolean {
  if (!name || name.startsWith(".")) return true;
  const normalized = name.toLowerCase();
  return normalized === "license" || normalized === "license.md" || normalized === "license.txt";
}

function relativizeHomePath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  const prefix = `${home}/`;
  const normalized = slashPath(path);
  const normalizedPrefix = slashPath(prefix);
  if (normalized.startsWith(normalizedPrefix)) return `~/${normalized.slice(normalizedPrefix.length)}`;
  return normalized;
}

function safeReadDir(path: string): Dirent[] | null {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function safeRealPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function readRuntimeLocalSkillTextFile(path: string): string | null {
  try {
    const content = readFileSync(path);
    if (isLikelyBinaryLocalSkillFile(content)) return null;
    return LOCAL_SKILL_TEXT_DECODER.decode(content);
  } catch {
    return null;
  }
}

function isLikelyBinaryLocalSkillFile(content: Uint8Array): boolean {
  if (content.length === 0) return false;
  const sample = content.subarray(0, Math.min(content.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious > Math.max(16, sample.length * 0.1);
}

function humanizeSkillKey(key: string): string {
  return basename(key).replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function slashPath(path: string): string {
  return path.replace(/\\/g, "/");
}

const DIRECTORY_SCAN_DEFAULT_DEPTH = 3;
const DIRECTORY_SCAN_MAX_DEPTH = 5;
const DIRECTORY_SCAN_MAX_CANDIDATES = 100;
const DIRECTORY_SCAN_TIME_BUDGET_MS = 20_000;
const DIRECTORY_SCAN_SKIP_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "out", ".cache", "vendor",
  "__pycache__", ".turbo", ".venv", "venv", "target", "Library",
]);

/**
 * Walk a runtime directory tree (iterative BFS) looking for git working trees.
 * A directory containing `.git` (dir or file) is a candidate and is not
 * descended into. Metadata is read purely from the filesystem — no git spawn —
 * so a pathological root can only cost the ~20s time box, never a hung process.
 */
export async function scanRuntimeDirectories(root: string | undefined, maxDepthParam: number | undefined): Promise<MultiremiRuntimeDirectoryCandidate[]> {
  const rootPath = resolve(root && root.trim() ? expandHomePath(root.trim()) : homedir());
  if (!isDirectory(rootPath)) throw new Error(`directory does not exist: ${rootPath}`);
  const maxDepth = Math.min(Number.isFinite(maxDepthParam) ? Number(maxDepthParam) : DIRECTORY_SCAN_DEFAULT_DEPTH, DIRECTORY_SCAN_MAX_DEPTH);
  const deadline = Date.now() + DIRECTORY_SCAN_TIME_BUDGET_MS;
  const candidates: MultiremiRuntimeDirectoryCandidate[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
  let dequeued = 0;
  scan: while (queue.length > 0) {
    if (candidates.length >= DIRECTORY_SCAN_MAX_CANDIDATES || Date.now() >= deadline) break;
    const { dir, depth } = queue.shift()!;
    // Yield to the event loop periodically so a large tree can't block ACP
    // streaming or cancellation polling on a busy daemon.
    if (++dequeued % 50 === 0) await new Promise((r) => setTimeout(r, 0));
    // A git working tree is a leaf candidate: record it and stop descending.
    if (existsSync(join(dir, ".git"))) {
      candidates.push(readDirectoryCandidate(dir));
      continue;
    }
    if (depth >= maxDepth) continue;
    const entries = safeReadDir(dir);
    if (!entries) continue;
    for (const entry of entries) {
      // Re-check the time box inside the per-entry loop: a huge fan-out could
      // otherwise blow past the budget before the next dequeue.
      if (Date.now() >= deadline) break scan;
      if (isSkippedScanDir(entry.name)) continue;
      const child = join(dir, entry.name);
      // lstat (no symlink follow) so symlinked directories are skipped for loop safety.
      if (!isRealDirectory(child)) continue;
      queue.push({ dir: child, depth: depth + 1 });
    }
  }
  return candidates;
}

const DIRECTORY_BROWSE_MAX_ENTRIES = 200;
const DIRECTORY_BROWSE_TIME_BUDGET_MS = 10_000;
const DIRECTORY_BROWSE_YIELD_EVERY = 200;

/**
 * List the immediate child directories of `root` (depth 1) — the folder-picker
 * counterpart to scan mode. Every visible directory is surfaced, git or not;
 * dot-dirs and the usual junk (see DIRECTORY_SCAN_SKIP_DIRS) are hidden and
 * symlinked dirs are skipped for loop safety. Git children carry the same
 * remote/branch metadata scan mode reads. Sorted by name, capped at 200.
 *
 * Like scan mode, this is guarded against a pathological root (e.g. a directory
 * with hundreds of thousands of entries, worse on cold NFS): the per-entry lstat
 * sweep checks a time box and yields to the event loop periodically so it can't
 * block ACP streaming or cancellation polling on a busy daemon. Returns the
 * expanded absolute `resolvedRoot` so the UI can render/ascend on empty listings.
 */
export async function browseRuntimeDirectory(root: string | undefined): Promise<{
  candidates: MultiremiRuntimeDirectoryCandidate[];
  resolvedRoot: string;
}> {
  const rootPath = resolve(root && root.trim() ? expandHomePath(root.trim()) : homedir());
  if (!isDirectory(rootPath)) throw new Error(`directory does not exist: ${rootPath}`);
  const entries = safeReadDir(rootPath);
  if (!entries) return { candidates: [], resolvedRoot: rootPath };
  const deadline = Date.now() + DIRECTORY_BROWSE_TIME_BUDGET_MS;
  const names: string[] = [];
  let seen = 0;
  for (const entry of entries) {
    if (Date.now() >= deadline) break;
    // Yield to the event loop periodically so a huge fan-out can't block the
    // daemon's ACP streaming / cancellation polling mid-sweep.
    if (++seen % DIRECTORY_BROWSE_YIELD_EVERY === 0) await new Promise((r) => setTimeout(r, 0));
    if (isSkippedScanDir(entry.name)) continue;
    // lstat (no symlink follow) so symlinked directories are skipped for loop safety.
    if (!isRealDirectory(join(rootPath, entry.name))) continue;
    names.push(entry.name);
  }
  names.sort((a, b) => a.localeCompare(b));
  const capped = names.slice(0, DIRECTORY_BROWSE_MAX_ENTRIES);
  const candidates: MultiremiRuntimeDirectoryCandidate[] = [];
  for (let i = 0; i < capped.length; i++) {
    if (i > 0 && i % DIRECTORY_BROWSE_YIELD_EVERY === 0) await new Promise((r) => setTimeout(r, 0));
    candidates.push(readBrowseCandidate(join(rootPath, capped[i]!)));
  }
  return { candidates, resolvedRoot: rootPath };
}

function readBrowseCandidate(dir: string): MultiremiRuntimeDirectoryCandidate {
  const isGitRepo = existsSync(join(dir, ".git"));
  const gitDir = isGitRepo ? resolveGitDir(dir) : null;
  return {
    path: dir,
    name: basename(dir),
    remoteUrl: gitDir ? readGitRemoteOriginUrl(gitDir) : null,
    currentBranch: gitDir ? readGitCurrentBranch(gitDir) : null,
    isDirty: null,
    isGitRepo,
  };
}

function isSkippedScanDir(name: string): boolean {
  return name.startsWith(".") || DIRECTORY_SCAN_SKIP_DIRS.has(name);
}

function expandHomePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function readDirectoryCandidate(dir: string): MultiremiRuntimeDirectoryCandidate {
  const gitDir = resolveGitDir(dir);
  return {
    path: dir,
    name: basename(dir),
    remoteUrl: gitDir ? readGitRemoteOriginUrl(gitDir) : null,
    currentBranch: gitDir ? readGitCurrentBranch(gitDir) : null,
    isDirty: null,
  };
}

/**
 * Resolve the git directory for a candidate. A `.git` directory is used as-is;
 * a `.git` file (worktree/submodule) is resolved via its `gitdir:` pointer.
 * Best effort — returns null when the pointer can't be resolved.
 */
function resolveGitDir(dir: string): string | null {
  const dotGit = join(dir, ".git");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  const pointer = safeReadTextFile(dotGit);
  const match = pointer?.match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;
  const target = match[1]!.trim();
  const resolved = isAbsolute(target) ? target : resolve(dir, target);
  return isDirectory(resolved) ? resolved : null;
}

function readGitRemoteOriginUrl(gitDir: string): string | null {
  const config = readGitConfig(gitDir);
  if (!config) return null;
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim());
      continue;
    }
    if (!inOrigin) continue;
    const url = line.match(/^url\s*=\s*(.+)$/);
    if (url) return url[1]!.trim() || null;
  }
  return null;
}

/**
 * Read a git dir's config. A linked worktree's gitdir (`.git/worktrees/<name>`)
 * has no local `config` — the shared config lives in the common dir named by the
 * sibling `commondir` pointer, so fall back to that when the direct read misses.
 */
function readGitConfig(gitDir: string): string | null {
  const direct = safeReadTextFile(join(gitDir, "config"));
  if (direct) return direct;
  const pointer = safeReadTextFile(join(gitDir, "commondir"));
  const target = pointer?.trim();
  if (!target) return null;
  const commonDir = isAbsolute(target) ? target : resolve(gitDir, target);
  return safeReadTextFile(join(commonDir, "config"));
}

function readGitCurrentBranch(gitDir: string): string | null {
  const head = safeReadTextFile(join(gitDir, "HEAD"));
  const match = head?.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
  return match ? match[1]!.trim() || null : null;
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeReadTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function runDefaultMultiremiUpdate(targetVersion: string): Promise<string> {
  const version = targetVersion.trim();
  if (!version) throw new Error("target_version is required");
  const repo = process.env.MULTIREMI_REPO || "Grassgod/remi";
  const installerUrl = process.env.MULTIREMI_INSTALLER_URL || `https://github.com/${repo}/releases/latest/download/install-remi.sh`;
  const env = cleanProcessEnv({
    ...process.env,
    MULTIREMI_VERSION: version,
  });
  const proc = Bun.spawn(["bash", "-lc", `curl -fsSL ${shellQuote(installerUrl)} | bash`], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    streamText(proc.stdout),
    streamText(proc.stderr),
    proc.exited,
  ]);
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (exitCode !== 0) throw new Error(output || `multiremi update failed with exit code ${exitCode}`);
  return output || `Updated to ${version}`;
}

async function streamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function defaultRuntimeModels(provider: string): MultiremiRuntimeModel[] {
  const normalized = provider.toLowerCase();
  if (normalized === "codex") {
    return [
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        provider: "openai",
        default: true,
        thinking: {
          supportedLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra high" },
          ],
          defaultLevel: "medium",
        },
      },
      { id: "gpt-5.5-mini", label: "GPT-5.5 mini", provider: "openai", default: false },
      { id: "gpt-5.4", label: "GPT-5.4", provider: "openai", default: false },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini", provider: "openai", default: false },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", provider: "openai", default: false },
      { id: "gpt-5", label: "GPT-5", provider: "openai", default: false },
    ];
  }
  if (normalized === "claude") {
    return [
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        provider: "anthropic",
        default: true,
        thinking: {
          supportedLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "max", label: "Max" },
          ],
        },
      },
      {
        id: "claude-opus-4-7",
        label: "Claude Opus 4.7",
        provider: "anthropic",
        default: false,
        thinking: {
          supportedLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra high" },
            { value: "max", label: "Max" },
          ],
        },
      },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", provider: "anthropic", default: false },
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", provider: "anthropic", default: false },
    ];
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
