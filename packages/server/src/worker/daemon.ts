import { mkdirSync } from "node:fs";
import { cpus, homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { createLogger } from "@shared/logger.js";
import {
  AcpProvider,
  type AcpModelCapability,
  type AcpProviderOptions,
  bridgeVersion,
  agentCliVersion,
  reinstallBridge,
  type ProvisionProvider,
  createAdapter,
} from "@acp/index.js";
import type { ElicitationCreateParams, ElicitationResult, PermissionOutcome, RequestPermissionParams } from "@shared/contracts/acp-protocol.js";
import { answersToElicitationContent, elicitationToQuestions } from "@shared/contracts/acp-elicitation.js";
import type { AgentResponse, Provider } from "@shared/contracts/provider-types.js";
import {
  isTerminalDaemonAuthorityError,
  MultiremiDaemonClient,
  type MultiremiDaemonGcStatus,
  type MultiremiDaemonRegisterResponse,
  type MultiremiRelayWire,
} from "./client.js";
import { createEventMapper, responseToUsage } from "./acp-event-mapper.js";
import {
  browseRuntimeDirectory,
  listRuntimeLocalSkills,
  loadRuntimeLocalSkillBundle,
  localSkillRootForProvider,
  scanRuntimeDirectories,
} from "./local-skills.js";
import { buildTaskPromptArtifact, type TaskRepoCheckout } from "@multiremi/prompt.js";
import { MultiremiRepoCache, normalizeRepoList } from "@multiremi/repo-cache.js";
import { classifyDaemonTaskFailure, classifyPoisonedOutput } from "./task-failure.js";
import { multiremiVersion } from "@multiremi/version.js";
import {
  writeTaskContext,
  writeTaskGcContext,
  writeProjectResourceContext,
  writeAgentSkillContext,
} from "@daemon/agent-runtime/skills/ephemeral.js";
import { prepareIntakeWorkspace } from "@daemon/agent-runtime/workspace/intake.js";
import {
  loadIssueSessionProviderEnv,
  prepareIssueSessionProviderHome,
  resolveIssueSessionProviderHome,
  resolveIssueRuntimeStateRoot,
  type IssueSessionProviderHome,
} from "@daemon/agent-runtime/workspace/session-home.js";
import { prepareIssueWikiWorkspace } from "@daemon/agent-runtime/workspace/wiki.js";
import { cleanProcessEnv } from "@daemon/agent-runtime/env/injector.js";
import { mergeCodexConfig, syncRelayConfigs } from "@daemon/agent-runtime/relay-sync.js";
import { AgentRuntime } from "@daemon/agent-runtime/runtime.js";
import { AgentSession } from "@daemon/agent-runtime/session.js";
import type { EphemeralContext } from "@daemon/agent-runtime/types.js";
import { AgentPluginCache } from "@daemon/agent-runtime/agent-plugins/cache.js";
import {
  AgentPluginRuntimeReconciler,
  pluginBlocked,
  pluginSetupRequired,
} from "@daemon/agent-runtime/agent-plugins/reconciler.js";
import {
  cleanupNonIssueTaskPluginRuntime,
  materializeTaskPlugins,
  prepareCodexPluginReadinessRuntime,
  resolveTaskPluginRuntimeBase,
  resolveTaskPluginSnapshot,
} from "@daemon/agent-runtime/agent-plugins/materialize.js";
import {
  installCodexPluginHome,
  seedCodexHomeFromBase,
} from "@daemon/agent-runtime/agent-plugins/codex-home.js";
import {
  agentPluginDesiredFromWire,
  runtimePluginStateReport,
} from "@daemon/agent-runtime/agent-plugins/wire.js";
import type {
  AgentPluginArtifactSpec,
  PreparedAgentPluginRuntime,
} from "@daemon/agent-runtime/agent-plugins/types.js";
import { AgentPluginError } from "@daemon/agent-runtime/agent-plugins/types.js";
import {
  LocalDirectoryError,
  LocalPathLocker,
  resolveTaskWorkDir,
  type ResolvedTaskWorkDir,
} from "@daemon/agent-runtime/workspace/ephemeral.js";
import { runWorkspaceGcOnce, type MultiremiDaemonGcSummary } from "@daemon/agent-runtime/workspace/gc.js";
import { SshMeshManager } from "@daemon/ssh-mesh.js";
import type {
  MultiremiDaemonHeartbeatAck,
  MultiremiDaemonSshMeshStatus,
  MultiremiIssueWorkspaceRepo,
  MultiremiRepoData,
  MultiremiRuntimeModel,
  MultiremiRuntimeUpdateScope,
  MultiremiTaskHumanRequest,
  MultiremiTaskWithAgent,
  MultiremiSshMeshHeartbeatAck,
  RegisterRuntimeInput,
  TaskUsageEntry,
} from "@multiremi/contracts/types.js";
import {
  MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
  MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
} from "@multiremi/contracts/types.js";

// Re-export the per-task context writers (moved to daemon/agent-runtime/skills in D6)
// so existing `from "../multiremi/daemon.js"` imports keep resolving (铁律#3).
export { writeTaskContext, writeTaskGcContext, writeProjectResourceContext, writeAgentSkillContext };
// Re-export the workspace GC entry point (moved to daemon/agent-runtime/workspace
// in D6) so existing `from "../multiremi/daemon.js"` imports keep resolving.
export { runWorkspaceGcOnce, type MultiremiDaemonGcSummary };
// Re-export the ACP-event mapper (moved to ./acp-event-mapper.ts) and the
// runtime directory scan/browse entry points (moved to ./local-skills.ts) so
// existing `from "@multiremi/daemon.js"` imports keep resolving.
export { createEventMapper };
export { browseRuntimeDirectory, scanRuntimeDirectories };

const log = createLogger("multiremi-daemon");
const HUMAN_REQUEST_POLL_MS = 2000;
const RUNTIME_MODEL_PROBE_TIMEOUT_MS = 30_000;
const RUNTIME_MODEL_RETRY_BASE_MS = 5_000;
const RUNTIME_MODEL_RETRY_MAX_MS = 5 * 60_000;

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

function providerBootstrapEnv(
  task: MultiremiTaskWithAgent,
  resolved: Record<string, string> | undefined,
): Record<string, string> {
  const keys = task.agent?.provider === "claude"
    ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
    : task.agent?.provider === "codex"
      ? ["OPENAI_API_KEY"]
      : [];
  const result: Record<string, string> = {};
  for (const source of [
    process.env,
    task.workspaceEnv ?? task.workspace_env,
    task.agent?.customEnv,
    resolved,
  ]) {
    for (const key of keys) {
      const value = source?.[key];
      if (typeof value === "string" && value.trim()) result[key] = value;
    }
  }
  return result;
}
export const MULTIREMI_REREGISTER_COALESCE_WINDOW_MS = 30_000;
export const MULTIREMI_REREGISTER_FAILURE_BACKOFF_MS = 60_000;
const TERMINAL_AUTHORITY_CLEANUP_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];

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
  /** Runtime-global immutable Agent Plugin cache. */
  pluginCacheRoot?: string;
  /** Injectable provider capability probe; production uses the native CLI and ACP bridge. */
  agentPluginProviderPreflight?: MultiremiAgentPluginProviderPreflight;
  /** Initial retry delay for Runtime model discovery/reporting. */
  runtimeModelRetryBaseMs?: number;
  /** Maximum retry delay for Runtime model discovery/reporting. */
  runtimeModelRetryMaxMs?: number;
  /** Injectable SSH Mesh lifecycle for daemon integration tests. */
  sshMeshManager?: MultiremiDaemonSshMeshRuntime;
  /** Injectable retry schedule for terminal-authority SSH Mesh cleanup tests. */
  terminalAuthorityCleanupRetryDelaysMs?: number[];
}

export interface MultiremiDaemonSshMeshRuntime {
  getHeartbeatStatus(): MultiremiDaemonSshMeshStatus;
  reconcile(desired: MultiremiSshMeshHeartbeatAck): Promise<void>;
  cleanupForRetirement(): Promise<void>;
}

interface RunSummary {
  output: string;
  sessionId: string | null;
  workDir: string | null;
  usage: TaskUsageEntry[];
}

interface PreparedIssueWorkspace {
  checkouts: TaskRepoCheckout[];
  repos: MultiremiIssueWorkspaceRepo[];
}

export type MultiremiTaskProvider = Pick<Provider, "sendStream" | "getLastResponse"> & {
  close?: () => Promise<void> | void;
  discoverModelCapabilities?: () => Promise<AcpModelCapability[]>;
  setPermissionHandler?: (handler: (params: RequestPermissionParams) => Promise<PermissionOutcome>) => void;
  setElicitationHandler?: (handler: (params: ElicitationCreateParams) => Promise<ElicitationResult>) => void;
};

export type MultiremiDaemonProviderFactory = (options: AcpProviderOptions) => MultiremiTaskProvider;
export type MultiremiDaemonUpdateRunner = (targetVersion: string) => string | Promise<string>;
export type MultiremiAgentPluginProviderPreflight = (
  provider: "claude" | "codex",
  signal?: AbortSignal,
) => void | Promise<void>;

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
  private options: Required<Omit<MultiremiDaemonOptions, "token" | "runtimeId" | "daemonId" | "workspaceId" | "providerFactory" | "updateRunner" | "localSkillRoots" | "launchedBy" | "onRestartRequested" | "taskTimeoutMs" | "daemonPort" | "workspacesRoot" | "repoCacheRoot" | "gcEnabled" | "gcIntervalMs" | "gcTtlMs" | "gcOrphanTtlMs" | "pluginCacheRoot" | "agentPluginProviderPreflight" | "sshMeshManager" | "terminalAuthorityCleanupRetryDelaysMs">> & {
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
    pluginCacheRoot: string;
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
  private workspaceRelays = new Map<string, MultiremiRelayWire | undefined>();
  private stopped = false;
  private startedAt = new Date();
  private ready = false;
  private activeTaskCount = 0;
  private inflight = new Set<Promise<void>>();
  private activeTaskAborts = new Set<AbortController>();
  private claimsPaused = false;
  private restartRequestedFlag = false;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private localPathLocks = new LocalPathLocker();
  private runtimeGoneInflight = new Set<string>();
  private reregisterGate = new MultiremiRuntimeReregisterGate();
  private readonly explicitRuntimeId: boolean;
  private readonly agentPluginCache: AgentPluginCache;
  private readonly agentPluginReconciler: AgentPluginRuntimeReconciler;
  private readonly agentPluginProviderPreflight: MultiremiAgentPluginProviderPreflight;
  private readonly sshMeshManager: MultiremiDaemonSshMeshRuntime;
  private readonly terminalAuthorityCleanupRetryDelaysMs: number[];
  private terminalAuthorityCleanup: Promise<void> | null = null;
  private terminalAuthorityCleanupRetryWake: (() => void) | null = null;
  private terminalAuthorityMode = false;
  private terminalAuthorityCleanupAttempts = 0;
  private agentPluginReconcileAbort: AbortController | null = null;
  private runtimeModels: MultiremiRuntimeModel[] | null = null;
  private runtimeRegistrationGeneration = 0;
  private runtimeModelReportedGeneration = 0;
  private runtimeModelProbe: Promise<MultiremiRuntimeModel[]> | null = null;
  private runtimeModelProbeAbort: AbortController | null = null;
  private runtimeModelRefreshTask: Promise<void> | null = null;
  private runtimeModelRefreshAbort: AbortController | null = null;
  private runtimeModelRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeModelRetryWake: (() => void) | null = null;

  constructor(options: MultiremiDaemonOptions) {
    const workspacesRoot = options.workspacesRoot ?? process.env.MULTIREMI_WORKSPACES_ROOT ?? join(homedir(), ".remi", "multiremi", "workspaces");
    const runtimeName = options.runtimeName ?? process.env.MULTIREMI_RUNTIME_NAME ?? `${hostname()}-${Bun.env.USER ?? "local"}-bun-runtime`;
    const deviceName = options.deviceName ?? process.env.MULTIREMI_DEVICE_NAME ?? `${hostname()}-${Bun.env.USER ?? "local"}`;
    const runtimeId = options.runtimeId ?? process.env.MULTIREMI_RUNTIME_ID ?? null;
    const daemonId = options.daemonId ?? process.env.MULTIREMI_DAEMON_ID ?? runtimeId ?? deviceName;
    const runtimeModelRetryBaseMs = Math.max(
      1,
      options.runtimeModelRetryBaseMs
        ?? numberEnv(process.env.MULTIREMI_RUNTIME_MODEL_RETRY_BASE_MS, RUNTIME_MODEL_RETRY_BASE_MS),
    );
    const runtimeModelRetryMaxMs = Math.max(
      runtimeModelRetryBaseMs,
      options.runtimeModelRetryMaxMs
        ?? numberEnv(process.env.MULTIREMI_RUNTIME_MODEL_RETRY_MAX_MS, RUNTIME_MODEL_RETRY_MAX_MS),
    );
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
      pluginCacheRoot: options.pluginCacheRoot
        ?? process.env.MULTIREMI_PLUGIN_CACHE_ROOT
        ?? join(homedir(), ".remi", "plugin-cache", "sha256"),
      runtimeModelRetryBaseMs,
      runtimeModelRetryMaxMs,
      serverUrl: options.serverUrl,
    };
    this.providerFactory = options.providerFactory ?? ((providerOptions) => new AcpProvider(providerOptions));
    this.updateRunner = options.updateRunner ?? runDefaultMultiremiUpdate;
    this.onRestartRequested = options.onRestartRequested ?? null;
    this.agentPluginProviderPreflight = options.agentPluginProviderPreflight
      ?? ((provider, signal) => preflightAgentPluginProvider(provider, {}, signal));
    const cleanupRetryDelays = (options.terminalAuthorityCleanupRetryDelaysMs ?? [])
      .filter((delay) => Number.isFinite(delay) && delay > 0)
      .map((delay) => Math.max(1, Math.floor(delay)));
    this.terminalAuthorityCleanupRetryDelaysMs = cleanupRetryDelays.length
      ? cleanupRetryDelays
      : [...TERMINAL_AUTHORITY_CLEANUP_RETRY_DELAYS_MS];
    this.localSkillRoots = options.localSkillRoots ?? {};
    this.client = new MultiremiDaemonClient(options.serverUrl, this.options.token);
    this.sshMeshManager = options.sshMeshManager ?? new SshMeshManager({
      workspaceId: this.options.workspaceId ?? "local",
      daemonId: this.options.daemonId ?? this.options.runtimeName,
      getConfig: async (signal) => {
        const runtimeId = this.options.runtimeId;
        if (!runtimeId) throw new Error("SSH Mesh configuration requested before Runtime registration");
        return await this.client.getSshMeshConfig(runtimeId, signal);
      },
    });
    this.repoCache = new MultiremiRepoCache(this.options.repoCacheRoot);
    this.agentPluginCache = new AgentPluginCache({
      root: this.options.pluginCacheRoot,
      serverUrl: this.options.serverUrl,
      getAuthToken: () => this.options.token,
    });
    this.agentPluginReconciler = new AgentPluginRuntimeReconciler({
      cache: this.agentPluginCache,
      preflight: (snapshot, payloadPath, signal) =>
        this.preflightAgentPlugin(snapshot, payloadPath, signal),
      reportState: async (state) => {
        const runtimeId = this.options.runtimeId;
        if (!runtimeId) return;
        const report = runtimePluginStateReport(state);
        await this.client.reportRuntimeAgentPluginState(runtimeId, report.versionId, report.input);
      },
    });
  }

  async start(): Promise<void> {
    this.startedAt = new Date();
    this.ready = false;
    this.stopped = false;
    this.claimsPaused = false;
    this.terminalAuthorityMode = false;
    this.terminalAuthorityCleanupAttempts = 0;
    this.restartRequestedFlag = false;
    this.startRepoCheckoutServer();
    this.startGcLoop();
    try {
      await this.registerCurrentRuntime();
      await this.refreshWorkspaceRepos(this.options.workspaceId);
      // One-shot mode is primarily used for a single queued task (and tests), so
      // avoid paying for a second ACP process unless a model-list request exists.
      if (!this.options.once) {
        this.startRuntimeModelRefresh();
      }
      await this.reconcileRuntimeAgentPlugins(this.options.runtimeId!);
      // registerCurrentRuntime() assigns a non-null runtime id; it is re-read each
      // iteration because handleHeartbeatAck() may re-register and replace it.
      await this.client.recoverOrphans(this.options.runtimeId!);
      this.ready = true;

      while (!this.stopped) {
        try {
          const ack = await this.client.heartbeatRuntime(
            this.options.runtimeId!,
            this.sshMeshManager.getHeartbeatStatus(),
          );
          const skipClaim = await this.handleHeartbeatAck(this.options.runtimeId!, ack);
          if (!skipClaim && !this.stopped) {
            await this.reconcileRuntimeAgentPlugins(this.options.runtimeId!);
          }
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
          if (isTerminalDaemonAuthorityError(err)) {
            log.error(
              `daemon authorization was revoked or retired; entering cleanup-only mode: ${err instanceof Error ? err.message : String(err)}`,
            );
            await this.stopAfterTerminalAuthority();
            break;
          }
          if (this.stopped || this.options.once) throw err;
          log.warn(`daemon poll loop error, retrying in ${this.options.pollIntervalMs}ms: ${err instanceof Error ? err.message : String(err)}`);
          await sleep(this.options.pollIntervalMs);
        }
      }
    } catch (error) {
      if (isTerminalDaemonAuthorityError(error)) {
        log.error(
          `daemon authorization was revoked or retired during startup; entering cleanup-only mode: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.stopAfterTerminalAuthority();
      }
      throw error;
    } finally {
      this.ready = false;
      this.cancelRuntimeModelRefresh();
      const modelRefresh = this.runtimeModelRefreshTask;
      if (modelRefresh) await Promise.allSettled([modelRefresh]);
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
        agentPluginProtocol: MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
        sshMeshProtocol: MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
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
      this.runtimeRegistrationGeneration++;
      log.info(`Runtime registered: ${this.options.runtimeId} (${this.options.provider})`);
      return this.options.runtimeId;
    }
    const runtime = await this.client.registerRuntime(this.currentRuntimeRegistrationInput());
    this.options.runtimeId = runtime.runtime.id;
    this.runtimeRegistrationGeneration++;
    log.info(`Runtime registered: ${this.options.runtimeId} (${this.options.provider})`);
    return this.options.runtimeId;
  }

  private syncWorkspaceRepos(response: MultiremiDaemonRegisterResponse): void {
    const workspaceId = response.workspace_id ?? this.options.workspaceId ?? "local";
    const repos = normalizeRepoList(response.repos ?? []);
    this.workspaceRepoUrls.set(workspaceId, new Set(repos.map((repo) => repo.url.trim()).filter(Boolean)));
    this.workspaceSettings.set(workspaceId, response.settings ?? {});
    this.workspaceRelays.set(workspaceId, response.relay);
    this.repoCache.sync(workspaceId, repos);
    syncRelayConfigs(response.relay, workspaceId);
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
        agent_plugin_protocol: MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
        ssh_mesh_protocol: MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
      },
      deviceInfo: `${this.options.runtimeName} · ${multiremiVersion}`,
      ...(this.runtimeModels ? { models: this.runtimeModels } : {}),
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
    if (ack.ssh_mesh) {
      await this.sshMeshManager.reconcile(ack.ssh_mesh);
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
      await this.stopAfterTerminalAuthority();
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
        if (isTerminalDaemonAuthorityError(error)) {
          log.error(
            `Runtime cannot re-register because daemon authorization was revoked or retired; entering cleanup-only mode: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.stopAfterTerminalAuthority();
          return false;
        }
        log.warn(`Re-register after runtime_gone failed for ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      if (this.runtimeModels || !this.options.once) this.startRuntimeModelRefresh();
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
    try {
      const models = await this.discoverRuntimeModels(true);
      await this.client.reportRuntimeModelListResult(runtimeId, requestId, {
        status: "completed",
        supported: true,
        models,
      });
    } catch (error) {
      await this.client.reportRuntimeModelListResult(runtimeId, requestId, {
        status: "failed",
        supported: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async refreshAndReportRuntimeModels(signal: AbortSignal): Promise<MultiremiRuntimeModel[]> {
    const models = await this.discoverRuntimeModels(false);
    if (this.stopped || signal.aborted) throw new Error("Runtime model refresh cancelled");

    // Resolve the target only after discovery. A runtime_gone re-registration
    // can happen while ACP is probing, and retries must never retain the deleted
    // Runtime id in a closure.
    const runtimeId = this.options.runtimeId;
    if (!runtimeId) throw new Error("Runtime model refresh has no registered Runtime");
    const generation = this.runtimeRegistrationGeneration;
    await this.client.updateRuntimeModels(runtimeId, models, signal);
    if (this.stopped || signal.aborted) throw new Error("Runtime model refresh cancelled");
    if (this.options.runtimeId === runtimeId && this.runtimeRegistrationGeneration === generation) {
      this.runtimeModelReportedGeneration = generation;
    }
    return models;
  }

  private startRuntimeModelRefresh(): void {
    if (this.stopped) return;
    if (this.runtimeModelRefreshTask) {
      this.wakeRuntimeModelRetry();
      return;
    }
    const abort = new AbortController();
    this.runtimeModelRefreshAbort = abort;
    const task = this.runRuntimeModelRefreshLoop(abort.signal).catch((error) => {
      if (!this.stopped && !abort.signal.aborted) {
        log.warn(`Runtime model refresh stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    this.runtimeModelRefreshTask = task;
    void task.then(() => {
      if (this.runtimeModelRefreshTask === task) this.runtimeModelRefreshTask = null;
      if (this.runtimeModelRefreshAbort === abort) this.runtimeModelRefreshAbort = null;
      if (!this.stopped && this.runtimeModelReportedGeneration < this.runtimeRegistrationGeneration) {
        this.startRuntimeModelRefresh();
      }
    });
  }

  private async runRuntimeModelRefreshLoop(signal: AbortSignal): Promise<void> {
    let failureCount = 0;
    while (!this.stopped && !signal.aborted) {
      if (this.runtimeModelReportedGeneration >= this.runtimeRegistrationGeneration) return;
      const attemptGeneration = this.runtimeRegistrationGeneration;
      try {
        await this.refreshAndReportRuntimeModels(signal);
        failureCount = 0;
        // The Runtime may have re-registered while the PUT was in flight. In that
        // case the generation was deliberately not marked and the cached catalog
        // is uploaded again immediately to the current Runtime.
        if (this.runtimeModelReportedGeneration >= this.runtimeRegistrationGeneration) return;
      } catch (error) {
        if (this.stopped || signal.aborted) return;
        // A replacement Runtime should be attempted immediately. This also
        // covers the narrow race where re-registration happened just before the
        // retry sleeper installed its wake callback.
        if (this.runtimeRegistrationGeneration !== attemptGeneration) {
          failureCount = 0;
          continue;
        }
        failureCount++;
        const delayMs = Math.min(
          this.options.runtimeModelRetryMaxMs,
          this.options.runtimeModelRetryBaseMs * (2 ** Math.min(failureCount - 1, 20)),
        );
        log.warn(
          `Runtime model refresh failed; retrying in ${delayMs}ms: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        await this.waitForRuntimeModelRetry(delayMs, signal);
      }
    }
  }

  private async waitForRuntimeModelRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    if (this.stopped || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.runtimeModelRetryTimer) clearTimeout(this.runtimeModelRetryTimer);
        this.runtimeModelRetryTimer = null;
        if (this.runtimeModelRetryWake === finish) this.runtimeModelRetryWake = null;
        signal.removeEventListener("abort", finish);
        resolve();
      };
      this.runtimeModelRetryWake = finish;
      this.runtimeModelRetryTimer = setTimeout(finish, delayMs);
      this.runtimeModelRetryTimer.unref?.();
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private wakeRuntimeModelRetry(): void {
    this.runtimeModelRetryWake?.();
  }

  private cancelRuntimeModelProbe(): void {
    this.runtimeModelProbeAbort?.abort();
  }

  private cancelRuntimeModelRefresh(): void {
    this.runtimeModelRefreshAbort?.abort();
    this.cancelRuntimeModelProbe();
    this.wakeRuntimeModelRetry();
  }

  private async discoverRuntimeModels(force: boolean): Promise<MultiremiRuntimeModel[]> {
    if (!force && this.runtimeModels) return this.runtimeModels;
    if (this.runtimeModelProbe) return this.runtimeModelProbe;

    const abort = new AbortController();
    this.runtimeModelProbeAbort = abort;
    const probe = (async () => {
      const provider = this.providerFactory({
        agentType: this.options.provider,
        cwd: homedir(),
      });
      try {
        if (!provider.discoverModelCapabilities) {
          throw new Error(`ACP model discovery is not supported by provider: ${this.options.provider}`);
        }
        const capabilities = await withTimeout(
          provider.discoverModelCapabilities(),
          RUNTIME_MODEL_PROBE_TIMEOUT_MS,
          `ACP model discovery timed out after ${RUNTIME_MODEL_PROBE_TIMEOUT_MS}ms`,
          abort.signal,
        );
        if (!capabilities.length) {
          throw new Error(`ACP did not advertise any models for provider: ${this.options.provider}`);
        }
        const models = runtimeModelsFromAcpCapabilities(this.options.provider, capabilities);
        this.runtimeModels = models;
        return models;
      } finally {
        await provider.close?.();
      }
    })();

    this.runtimeModelProbe = probe;
    try {
      return await probe;
    } finally {
      if (this.runtimeModelProbe === probe) this.runtimeModelProbe = null;
      if (this.runtimeModelProbeAbort === abort) this.runtimeModelProbeAbort = null;
    }
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

  private async reconcileRuntimeAgentPlugins(runtimeId: string): Promise<void> {
    this.agentPluginReconcileAbort?.abort();
    const abort = new AbortController();
    this.agentPluginReconcileAbort = abort;
    try {
      const desired = await this.client.getRuntimeAgentPluginDesired(runtimeId);
      if (desired.runtime_id && desired.runtime_id !== runtimeId) {
        throw new Error(`Agent Plugin desired state belongs to Runtime ${desired.runtime_id}, expected ${runtimeId}`);
      }
      const parsed = desired.plugins.map(agentPluginDesiredFromWire);
      this.agentPluginReconciler.restoreStates(parsed.map((entry) => entry.state));
      await this.agentPluginReconciler.reconcile(
        parsed.map((entry) => entry.artifact),
        { signal: abort.signal },
      );
    } finally {
      if (this.agentPluginReconcileAbort === abort) {
        this.agentPluginReconcileAbort = null;
      }
    }
  }

  private async preflightAgentPlugin(
    snapshot: AgentPluginArtifactSpec,
    payloadPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.agentPluginProviderPreflight(snapshot.provider, signal);
    const binaries = snapshot.requirements?.binaries;
    if (binaries !== undefined) {
      if (!Array.isArray(binaries) || binaries.some((value) => typeof value !== "string" || !value.trim())) {
        throw pluginBlocked(
          `Agent Plugin ${snapshot.name} has invalid requirements.binaries`,
          "plugin_requirements_invalid",
        );
      }
      const missing = binaries
        .map((value) => String(value).trim())
        .filter((binary) => !Bun.which(binary));
      if (missing.length) {
        throw pluginSetupRequired(
          `Agent Plugin ${snapshot.name} requires missing Runtime binaries: ${missing.join(", ")}`,
          "plugin_binary_missing",
        );
      }
    }
    if (snapshot.provider !== "codex") return;

    try {
      const prepared = await prepareCodexPluginReadinessRuntime(
        snapshot,
        payloadPath,
        join(this.options.pluginCacheRoot, ".codex-readiness"),
        signal,
      );
      const workspaceId = this.options.workspaceId ?? "local";
      const relayFragment = this.workspaceRelays.get(workspaceId)?.codex?.fragment ?? "";
      const configToml = relayFragment.trim() ? mergeCodexConfig("", relayFragment) : undefined;
      const baseHome = process.env.CODEX_HOME || join(homedir(), ".codex");
      await installCodexPluginHome(prepared, {
        signal,
        seedHome: (targetHome) => seedCodexHomeFromBase({
          baseHome,
          targetHome,
          ...(configToml === undefined ? {} : { configToml }),
        }),
      });
    } catch (error) {
      if (error instanceof AgentPluginError) throw error;
      throw pluginBlocked(
        `Codex Plugin ${snapshot.name} native installation failed: ${error instanceof Error ? error.message : String(error)}`,
        "plugin_codex_install_failed",
      );
    }
  }

  stop(): void {
    this.stopped = true;
    this.terminalAuthorityCleanupRetryWake?.();
    this.agentPluginReconcileAbort?.abort();
    this.cancelRuntimeModelRefresh();
  }

  private async stopAfterTerminalAuthority(): Promise<void> {
    this.claimsPaused = true;
    this.ready = false;
    this.terminalAuthorityMode = true;
    this.stopGcLoop();
    for (const abort of this.activeTaskAborts) abort.abort();
    this.agentPluginReconcileAbort?.abort();
    this.cancelRuntimeModelRefresh();
    this.terminalAuthorityCleanup ??= this.retryTerminalAuthorityCleanup();
    await this.terminalAuthorityCleanup;
  }

  private async retryTerminalAuthorityCleanup(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      attempt++;
      this.terminalAuthorityCleanupAttempts = attempt;
      try {
        await this.sshMeshManager.cleanupForRetirement();
        log.info(`SSH Mesh retirement cleanup completed after ${attempt} attempt${attempt === 1 ? "" : "s"}`);
        this.stop();
        return;
      } catch (error) {
        if (this.stopped) return;
        const delay = this.terminalAuthorityCleanupRetryDelaysMs[
          Math.min(attempt - 1, this.terminalAuthorityCleanupRetryDelaysMs.length - 1)
        ]!;
        log.error(
          `SSH Mesh retirement cleanup attempt ${attempt} failed; retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.waitForTerminalAuthorityCleanupRetry(delay);
      }
    }
  }

  private async waitForTerminalAuthorityCleanupRetry(delayMs: number): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolveWait) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.terminalAuthorityCleanupRetryWake === finish) {
          this.terminalAuthorityCleanupRetryWake = null;
        }
        resolveWait();
      };
      const timer = setTimeout(finish, delayMs);
      this.terminalAuthorityCleanupRetryWake = finish;
      if (this.stopped) finish();
    });
  }

  async runGcOnce(): Promise<MultiremiDaemonGcSummary> {
    const summary = await runWorkspaceGcOnce({
      root: this.options.workspacesRoot,
      ttlMs: this.options.gcTtlMs,
      orphanTtlMs: this.options.gcOrphanTtlMs,
      client: this.client,
      runtimeId: this.options.runtimeId,
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
    this.stop();
    this.onRestartRequested?.();
  }

  private async handleTask(task: MultiremiTaskWithAgent): Promise<void> {
    this.activeTaskCount++;
    log.info(`Claimed task ${task.id}`);
    const abort = new AbortController();
    this.activeTaskAborts.add(abort);
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
    let pluginRuntimeBase: string | null = null;
    let pluginRuntime: PreparedAgentPluginRuntime | undefined;
    let providerHome: IssueSessionProviderHome | null = null;
    let providerEnv: Record<string, string> | undefined;
    let providerInstallEnv: Record<string, string> | undefined;

    try {
      resolvedWorkDir = await this.resolveTaskWorkDir(task, abort.signal);
      const issueRuntimeStateRoot = resolveIssueRuntimeStateRoot(
        task,
        resolvedWorkDir.workDir,
        this.options.workspacesRoot,
        resolvedWorkDir.localDirectory,
      );
      providerHome = resolveIssueSessionProviderHome(task, issueRuntimeStateRoot, this.options.workspacesRoot);
      const relay = task.agent?.provider === "claude"
        ? this.workspaceRelays.get(task.workspaceId)?.claude
        : task.agent?.provider === "codex"
          ? this.workspaceRelays.get(task.workspaceId)?.codex
          : null;
      if (providerHome) {
        providerEnv = await loadIssueSessionProviderEnv(providerHome, {
          relayFragment: relay?.fragment,
          relayAuthToken: relay?.auth_token,
        });
        providerInstallEnv = providerBootstrapEnv(task, providerEnv);
      }
      if (resolveTaskPluginSnapshot(task).length) {
        pluginRuntimeBase = resolveTaskPluginRuntimeBase(task, issueRuntimeStateRoot, this.options.workspacesRoot);
        pluginRuntime = await this.prepareTaskPluginRuntime(
          task,
          resolvedWorkDir.workDir,
          pluginRuntimeBase,
          abort.signal,
          providerHome,
          providerInstallEnv,
        );
      }
      if (providerHome) {
        await prepareIssueSessionProviderHome(providerHome, {
          codexPluginInstalled: task.agent?.provider === "codex" && Boolean(pluginRuntime?.codexHome),
          linkCodexAuth: !providerInstallEnv?.OPENAI_API_KEY,
          linkClaudeCredentials: !providerInstallEnv?.ANTHROPIC_AUTH_TOKEN && !providerInstallEnv?.ANTHROPIC_API_KEY,
          ...(task.agent?.provider === "codex" && relay?.fragment?.trim()
            ? { codexConfigToml: mergeCodexConfig("", relay.fragment) }
            : {}),
        });
      }
      await this.client.startTask(task.id);
      await this.client.reportProgress(task.id, "Agent execution started", 1, 3);
      summary = await this.runAgent(task, abort.signal, resolvedWorkDir, pluginRuntime, providerHome, providerEnv);
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
      if (pluginRuntimeBase && !task.issueId && !task.chatSessionId) {
        await cleanupNonIssueTaskPluginRuntime(task, this.options.workspacesRoot).catch((error) => {
          log.warn(`Failed to clean task Plugin runtime for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      resolvedWorkDir?.release?.();
      this.activeTaskAborts.delete(abort);
      this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);
      clearInterval(cancelWatcher);
      if (timeout) clearTimeout(timeout);
    }
  }

  private async prepareTaskPluginRuntime(
    task: MultiremiTaskWithAgent,
    workDir: string,
    runtimeBase: string,
    signal: AbortSignal,
    providerHome: IssueSessionProviderHome | null,
    providerEnv?: Record<string, string>,
  ): Promise<PreparedAgentPluginRuntime> {
    const prepared = await materializeTaskPlugins(task, workDir, this.agentPluginCache, {
      runtimeBase,
      signal,
      codexHome: task.agent?.provider === "codex" ? providerHome?.home : undefined,
    });
    if (!task.issueId) writeTaskGcContext(runtimeBase, task);
    if (task.agent?.provider === "codex" && prepared.codexHome) {
      const relayFragment = this.workspaceRelays.get(task.workspaceId)?.codex?.fragment ?? "";
      const configToml = relayFragment.trim() ? mergeCodexConfig("", relayFragment) : undefined;
      const baseHome = process.env.CODEX_HOME || join(homedir(), ".codex");
      await installCodexPluginHome(prepared, {
        signal,
        seedHome: (targetHome) => seedCodexHomeFromBase({
          baseHome,
          targetHome,
          requireAuth: !providerEnv?.OPENAI_API_KEY,
          copyAuth: false,
          linkAuth: !providerEnv?.OPENAI_API_KEY,
          ...(configToml === undefined ? {} : { configToml }),
        }),
        env: providerEnv,
      });
    }
    return prepared;
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

  /**
   * Pre-flight repo materialization: check out every task repo as a worktree
   * in the task's workDir before the agent starts, so an issue's work is
   * branch-isolated from the first turn without relying on the agent running
   * `remi repo checkout` itself. Scope is deliberately narrow: issue tasks
   * only, and only in daemon-owned dirs (never agent.cwd / local_directory).
   * An existing worktree is reused as-is so a resumed task keeps uncommitted
   * work, and any failure degrades to the manual-checkout prompt instead of
   * failing the task.
   */
  private async autoCheckoutTaskRepos(
    task: MultiremiTaskWithAgent,
    resolvedWorkDir: ResolvedTaskWorkDir,
  ): Promise<PreparedIssueWorkspace> {
    const repos = normalizeRepoList(task.repos ?? []);
    if (!repos.length || !task.issueId || !resolvedWorkDir.ensureDir || resolvedWorkDir.localDirectory) {
      return { checkouts: [], repos: [] };
    }
    const checkouts: TaskRepoCheckout[] = [];
    const workspaceRepos: MultiremiIssueWorkspaceRepo[] = [];
    const runtimeId = task.runtimeId ?? this.options.runtimeId;
    const branchName = `agent/${task.issue?.key ?? task.id}`;
    if (runtimeId) {
      await this.client.reportIssueWorkspace(task.id, {
        runtimeId,
        rootPath: resolvedWorkDir.workDir,
        branchName,
        status: "preparing",
        repos: [],
      }).catch((err) => log.warn(`Failed to report workspace preparation for ${task.id}: ${err instanceof Error ? err.message : String(err)}`));
    }
    for (const repo of repos) {
      try {
        await this.ensureRepoReady(task.workspaceId, repo.url);
        const result = this.repoCache.createWorktree({
          workspaceId: task.workspaceId,
          repoUrl: repo.url,
          workDir: resolvedWorkDir.workDir,
          agentName: task.agent?.name ?? "agent",
          taskId: task.issue?.key || task.id,
          branchName,
          reuseExisting: true,
          coAuthoredByEnabled: this.workspaceCoAuthoredByEnabled(task.workspaceId),
        });
        checkouts.push({ repoUrl: repo.url, path: result.path, branch: result.branchName, baseRef: result.baseRef });
        workspaceRepos.push({
          repoUrl: repo.url,
          repoName: basename(result.path),
          worktreePath: result.path,
          branchName: result.branchName,
          baseRef: result.baseRef,
          status: "ready",
          dirty: false,
          error: null,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        workspaceRepos.push({
          repoUrl: repo.url,
          repoName: basename(repo.url.replace(/\.git$/, "")),
          worktreePath: join(resolvedWorkDir.workDir, basename(repo.url.replace(/\.git$/, ""))),
          branchName,
          baseRef: "",
          status: "error",
          dirty: false,
          error,
        });
        log.warn(`Auto checkout of ${repo.url} failed for task ${task.id}: ${error}`);
      }
    }
    if (runtimeId) {
      await this.client.reportIssueWorkspace(task.id, {
        runtimeId,
        rootPath: resolvedWorkDir.workDir,
        branchName,
        status: workspaceRepos.some((repo) => repo.status === "error") ? "error" : "in_use",
        repos: workspaceRepos,
      }).catch((err) => log.warn(`Failed to report workspace for ${task.id}: ${err instanceof Error ? err.message : String(err)}`));
    }
    return { checkouts, repos: workspaceRepos };
  }

  private async prepareTaskWorkspace(
    task: MultiremiTaskWithAgent,
    resolvedWorkDir: ResolvedTaskWorkDir,
  ): Promise<PreparedIssueWorkspace> {
    if (task.issue?.issueKind !== "intake") {
      const prepared = await this.autoCheckoutTaskRepos(task, resolvedWorkDir);
      if (!resolvedWorkDir.localDirectory) {
        await prepareIssueWikiWorkspace(resolvedWorkDir.workDir, task);
      }
      return prepared;
    }
    if (!task.issueId || !resolvedWorkDir.ensureDir || resolvedWorkDir.localDirectory) {
      throw new Error("Intake tasks require a daemon-owned issue workspace");
    }
    const runtimeId = task.runtimeId ?? this.options.runtimeId;
    if (runtimeId) {
      await this.client.reportIssueWorkspace(task.id, {
        runtimeId,
        rootPath: resolvedWorkDir.workDir,
        branchName: "",
        status: "preparing",
        repos: [],
      });
    }
    let prepared: PreparedIssueWorkspace;
    try {
      prepared = prepareIntakeWorkspace(resolvedWorkDir.workDir, task, this.repoCache, {
        snapshotsRoot: join(this.options.workspacesRoot, ".snapshots"),
      });
    } catch (error) {
      if (runtimeId) {
        await this.client.reportIssueWorkspace(task.id, {
          runtimeId,
          rootPath: resolvedWorkDir.workDir,
          branchName: "",
          status: "error",
          repos: [],
        }).catch(() => undefined);
      }
      throw error;
    }
    if (runtimeId) {
      await this.client.reportIssueWorkspace(task.id, {
        runtimeId,
        rootPath: resolvedWorkDir.workDir,
        branchName: "",
        status: "in_use",
        repos: prepared.repos,
      });
    }
    return prepared;
  }

  private async reportIssueWorkspaceAfterRun(
    task: MultiremiTaskWithAgent,
    rootPath: string,
    workspaceRepos: MultiremiIssueWorkspaceRepo[],
  ): Promise<void> {
    const runtimeId = task.runtimeId ?? this.options.runtimeId;
    if (!task.issueId || !runtimeId) return;
    if (task.issue?.issueKind === "intake") {
      await this.client.reportIssueWorkspace(task.id, {
        runtimeId,
        rootPath,
        branchName: "",
        status: "ready",
        repos: workspaceRepos,
      });
      return;
    }
    const branchName = `agent/${task.issue?.key ?? task.id}`;
    const repos: MultiremiIssueWorkspaceRepo[] = workspaceRepos.map((repo) => {
      if (repo.status === "error") return repo;
      try {
        const state = this.repoCache.inspectWorktree(repo.worktreePath);
        return {
          ...repo,
          status: state.dirty ? "dirty" : "ready",
          dirty: state.dirty,
          error: null,
        };
      } catch (err) {
        return {
          ...repo,
          status: "error",
          dirty: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
    const status = repos.some((repo) => repo.status === "error")
      ? "error"
      : repos.some((repo) => repo.dirty)
        ? "dirty"
        : "ready";
    await this.client.reportIssueWorkspace(task.id, { runtimeId, rootPath, branchName, status, repos });
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
    } else {
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
    }

    // AskUserQuestion is a collaboration primitive, not a tool permission.
    // Always surface it, including when destructive-tool approvals are automatic.
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

  private async runAgent(
    task: MultiremiTaskWithAgent,
    signal: AbortSignal,
    resolvedWorkDir: ResolvedTaskWorkDir,
    pluginRuntime?: PreparedAgentPluginRuntime,
    providerHome?: IssueSessionProviderHome | null,
    providerEnv?: Record<string, string>,
  ): Promise<RunSummary> {
    const agent = task.agent;
    if (!agent) throw new Error(`Task ${task.id} has no agent`);
    if (agent.provider !== "claude" && agent.provider !== "codex") {
      throw new Error(`Unsupported Bun Multiremi provider: ${agent.provider}`);
    }

    const workDir = resolvedWorkDir.workDir;
    // Only create dirs the daemon owns (default per-task dir / machine-affine
    // task.workDir). A validated agent.cwd (ensureDir=false) is never recreated
    // — if it vanished post-resolve the run fails loudly instead of mkdir-ing a
    // machine-local path on a pool machine that shouldn't have it.
    if (resolvedWorkDir.ensureDir) mkdirSync(workDir, { recursive: true });
    await this.registerTaskRepos(task.workspaceId, task.repos ?? []);
    const preparedWorkspace = await this.prepareTaskWorkspace(task, resolvedWorkDir);
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
      pluginRuntime,
      providerHome: providerHome ?? undefined,
      providerEnv,
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
      pluginPaths: config.pluginPaths,
      pluginFingerprint: config.pluginFingerprint,
      codexHome: config.codexHome,
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
    const toMessages = createEventMapper(createAdapter(config.agentType));

    try {
      const session = new AgentSession(provider as any, config);
      const promptArtifact = buildTaskPromptArtifact(task, { repoCheckouts: preparedWorkspace.checkouts });
      await this.client.reportTaskPrompt(task.id, promptArtifact);
      signal.throwIfAborted();
      for await (const event of session.run(promptArtifact.prompt)) {
        // One event may yield several messages (e.g. a completed tool_call →
        // tool_use + tool_result). Each gets its own seq so none collides.
        const emitted = toMessages(event).map((m) => ({ ...m, seq: nextSeq() }));
        for (const message of emitted) {
          // Assistant text becomes the task result / issue activity body.
          if (message.type === "text" && message.content) output += message.content;
        }
        if (emitted.length) await this.client.reportTaskMessages(task.id, emitted);
      }
      const last = provider.getLastResponse?.() as AgentResponse | null | undefined;
      finalSessionId = last?.sessionId ?? finalSessionId;
      usage = responseToUsage(agent.provider, last, config.model);
      await this.client.pinTaskSession(task.id, finalSessionId, workDir);
      return {
        output: output.trim() || last?.text || "Task completed.",
        sessionId: finalSessionId,
        workDir,
        usage,
      };
    } finally {
      await this.reportIssueWorkspaceAfterRun(task, workDir, preparedWorkspace.repos).catch((err) => {
        log.warn(`Failed to report final workspace state for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
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
    if (this.terminalAuthorityMode) {
      return jsonResponse({ error: "daemon is in terminal cleanup-only mode" }, 503);
    }
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
      mode: this.terminalAuthorityMode ? "cleanup_only" : this.ready ? "serving" : "starting",
      ssh_mesh_cleanup_attempts: this.terminalAuthorityCleanupAttempts,
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
      this.workspaceRelays.set(workspaceId, response.relay);
      this.repoCache.sync(workspaceId, response.repos);
      syncRelayConfigs(response.relay, workspaceId);
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

export interface AgentPluginProviderPreflightDependencies {
  which?: (binary: string) => string | null;
  commandSucceeds?: (executable: string, args: string[], signal?: AbortSignal) => Promise<boolean>;
  bridgeHealthy?: (provider: "claude" | "codex") => Promise<boolean>;
}

/** Verify the provider can actually consume a native Plugin before reporting Ready. */
export async function preflightAgentPluginProvider(
  provider: "claude" | "codex",
  dependencies: AgentPluginProviderPreflightDependencies = {},
  signal?: AbortSignal,
): Promise<void> {
  const which = dependencies.which ?? ((binary: string) => Bun.which(binary));
  const executable = which(provider);
  if (!executable) {
    throw pluginSetupRequired(
      `${provider} CLI is not installed on this Runtime`,
      `plugin_${provider}_cli_missing`,
    );
  }
  if (provider === "codex") {
    const supportsPlugins = await (dependencies.commandSucceeds ?? pluginProbeCommandSucceeds)(
      executable,
      ["plugin", "--help"],
      signal,
    );
    if (!supportsPlugins) {
      throw pluginSetupRequired(
        "Codex CLI does not support Agent Plugins; update Codex and retry",
        "plugin_codex_cli_unsupported",
      );
    }
  }
  const bridgeHealthy = dependencies.bridgeHealthy ?? (async (agentType: "claude" | "codex") => {
    const providerClient = new AcpProvider({ agentType });
    try {
      return await providerClient.healthCheck();
    } finally {
      await providerClient.close();
    }
  });
  let bridgeAvailable: boolean;
  try {
    bridgeAvailable = await withTimeout(
      bridgeHealthy(provider),
      15_000,
      `${provider} ACP bridge health check timed out`,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) {
      throw new AgentPluginError(
        `${provider} Plugin preflight was cancelled`,
        "plugin_cancelled",
        "transient",
        { cause: error },
      );
    }
    throw pluginSetupRequired(
      `${provider} ACP bridge is unavailable on this Runtime: ${error instanceof Error ? error.message : String(error)}`,
      `plugin_${provider}_bridge_missing`,
    );
  }
  if (!bridgeAvailable) {
    throw pluginSetupRequired(
      `${provider} ACP bridge is unavailable on this Runtime`,
      `plugin_${provider}_bridge_missing`,
    );
  }
}

async function pluginProbeCommandSucceeds(
  executable: string,
  args: string[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    throw new AgentPluginError("Codex Plugin preflight was cancelled", "plugin_cancelled", "transient");
  }
  let processHandle: ReturnType<typeof Bun.spawn>;
  try {
    processHandle = Bun.spawn([executable, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;
  const timedOut = new Promise<number>((resolveTimeout) => {
    timer = setTimeout(() => {
      try { processHandle.kill(); } catch {}
      resolveTimeout(-1);
    }, 15_000);
    timer.unref?.();
  });
  try {
    const candidates: Promise<number>[] = [processHandle.exited, timedOut];
    if (signal) {
      candidates.push(new Promise<number>((_, reject) => {
        abortHandler = () => {
          try { processHandle.kill(); } catch {}
          reject(new AgentPluginError(
            "Codex Plugin preflight was cancelled",
            "plugin_cancelled",
            "transient",
          ));
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      }));
    }
    return await Promise.race(candidates) === 0;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
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

export function runtimeModelsFromAcpCapabilities(
  provider: string,
  capabilities: AcpModelCapability[],
): MultiremiRuntimeModel[] {
  const vendor = provider.toLowerCase() === "claude"
    ? "anthropic"
    : provider.toLowerCase() === "codex"
      ? "openai"
      : provider;
  return capabilities.map((model) => ({
    id: model.id,
    label: model.label,
    provider: vendor,
    default: model.default,
    ...(model.effort?.supportedLevels.length
      ? {
          thinking: {
            supportedLevels: model.effort.supportedLevels.map((level) => ({ ...level })),
          },
        }
      : {}),
  }));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;
  try {
    const candidates: Promise<T>[] = [
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ];
    if (signal) {
      candidates.push(new Promise<T>((_, reject) => {
        abortHandler = () => reject(new Error("ACP model discovery cancelled"));
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }));
    }
    return await Promise.race(candidates);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
