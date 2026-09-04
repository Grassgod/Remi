import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { cpus, homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
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
  MultiremiDaemonHttpError,
  type MultiremiDaemonHeartbeatConfigAck,
  type MultiremiDaemonGcStatus,
  type MultiremiDaemonRegisterResponse,
  type MultiremiDaemonSessionArchiveStatus,
  type MultiremiDaemonSessionArchiveWire,
  type MultiremiRelayEngineWire,
  type MultiremiRelayWire,
} from "./client.js";
import { createEventMapper, responseToUsage } from "./acp-event-mapper.js";
import { FeishuConciergeSupervisor, type FeishuConciergeHost } from "./feishu-concierge.js";
import { redactFeishuBotError } from "@multiremi/feishu-bot/diagnostics.js";
import {
  buildSteerInjectionPrompt,
  DEFAULT_FORCE_ANSWER_GRACE_MS,
  DEFAULT_STEER_POLL_MS,
  mergeTaskUsageEntries,
  TaskSteerFeed,
} from "./steer.js";
import {
  MultiremiTaskReportOutbox,
  type MultiremiOutboxKind,
  type MultiremiOutboxRecord,
  type MultiremiOutboxStats,
  type MultiremiOutboxDrainResult,
} from "./outbox.js";
import { TaskMessageBatcher } from "./task-message-batcher.js";
import {
  browseRuntimeDirectory,
  listRuntimeLocalSkills,
  loadRuntimeLocalSkillBundle,
  localSkillRootForProvider,
  scanRuntimeDirectories,
} from "./local-skills.js";
import { buildTaskPromptArtifact, type TaskRepoCheckout, type TaskRepoWarning } from "@multiremi/prompt.js";
import {
  MultiremiRepoCache,
  normalizeRepoList,
  repoCacheTimeoutOverrides,
  type MultiremiRepoSyncResult,
} from "@multiremi/repo-cache.js";
import {
  classifyDaemonTaskFailure,
  classifyPoisonedOutput,
  TaskFailureReason,
  type TaskFailureReasonValue,
} from "./task-failure.js";
import { executeRuntimeCommand } from "./runtime-command.js";
import { multiremiVersion } from "@multiremi/version.js";
import {
  writeTaskContext,
  writeTaskGcContext,
  writeProjectResourceContext,
  writeAgentSkillContext,
} from "@daemon/agent-runtime/skills/ephemeral.js";
import { prepareIntakeWorkspace } from "@daemon/agent-runtime/workspace/intake.js";
import {
  assertIssueSessionNativeCodexOAuth,
  cleanupTemporaryTaskProviderHome,
  ensureProviderHomeDirectory,
  loadIssueSessionProviderEnv,
  listIssueSessionRuntimeRoots,
  prepareIssueSessionProviderHome,
  resolveIssueRuntimeStateRoot,
  resolveTaskProviderHome,
  type IssueSessionProviderHome,
} from "@daemon/agent-runtime/workspace/session-home.js";
import { prepareIssueWikiWorkspace } from "@daemon/agent-runtime/workspace/wiki.js";
import { cleanProcessEnv } from "@daemon/agent-runtime/env/injector.js";
import { mergeCodexSessionConfig } from "@daemon/agent-runtime/relay-sync.js";
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
  type CodexPluginCommand,
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
import {
  discussionSessionLifecycleKey,
  runWorkspaceGcOnce,
  type MultiremiDaemonGcSummary,
} from "@daemon/agent-runtime/workspace/gc.js";
import { resolveWorkspaceGcPolicy, type WorkspaceGcPolicy } from "@daemon/agent-runtime/workspace/gc-policy.js";
import { resolveWorkspaceProgressSummaryPolicy } from "@daemon/agent-runtime/workspace/progress-summary-policy.js";
import {
  IsomorphicGitWorktreeInspector,
  type GitWorktreeInspector,
} from "@daemon/agent-runtime/workspace/git-worktree-inspector.js";
import { IssueWorkspaceLifecycleLocker } from "@daemon/agent-runtime/workspace/lifecycle-lock.js";
import {
  TopicWorkspaceLifecycle,
  type CommittedTopicMigration,
  type PreparedTopicMigration,
} from "@daemon/agent-runtime/workspace/topic-lifecycle.js";
import { configuredMultiremiWorkspacesRoot } from "@daemon/agent-runtime/workspace/process-owner.js";
import { ownedDirectoryRemovalSupport } from "@daemon/agent-runtime/workspace/safe-remove.js";
import {
  prepareIssueSessionArchive,
  readIssueSessionArchiveReceipt,
  removePreparedIssueSessionArchive,
  writeIssueSessionArchiveReceipt,
} from "@daemon/agent-runtime/workspace/session-archive.js";
import { SshMeshManager } from "@daemon/ssh-mesh.js";
import type {
  BotMenuPublishResult,
  MultiremiDaemonHeartbeatAck,
  MultiremiDaemonSshMeshStatus,
  MultiremiIssueWorkspaceRepo,
  MultiremiIssueWorkspaceArchiveBinding,
  MultiremiRepoData,
  MultiremiRuntimeModel,
  MultiremiRuntimeUpdateScope,
  MultiremiTaskHumanRequest,
  MultiremiTaskMessage,
  MultiremiTaskStatus,
  MultiremiTaskSteerMessage,
  MultiremiTaskWithAgent,
  MultiremiSshMeshHeartbeatAck,
  RegisterRuntimeInput,
  ResolvedBotMenuConfig,
  TaskUsageEntry,
  FeishuBotTaskSnapshot,
  SubmitFeishuBotMessageInput,
  SubmitFeishuBotMessageResult,
} from "@multiremi/contracts/types.js";
import {
  MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
  MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION,
  MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
} from "@multiremi/contracts/types.js";
import {
  pickTaskStartupLine,
  resolveTaskProgressSummaryConfig,
  resolveSummarizerCredentials,
  TaskProgressSummarizer,
  type ProgressRunOutcome,
} from "./progress-summarizer.js";
import {
  MultiremiCliUpdateCoordinator,
  type MultiremiCliUpdatePauseResult,
} from "./cli-update-coordinator.js";

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
  for (const key of keys) {
    let value: string | undefined;
    for (const source of [
      process.env,
      task.workspaceEnv ?? task.workspace_env,
      task.agent?.customEnv,
      resolved,
    ]) {
      if (source && Object.prototype.hasOwnProperty.call(source, key)) {
        value = source[key];
      }
    }
    // Preserve an authoritative empty value: Plugin installers also merge on
    // top of process.env, so omitting the key would resurrect a machine secret.
    if (typeof value === "string") result[key] = value.trim() ? value : "";
  }
  return result;
}

export interface InstallCodexPluginReadinessHomeOptions {
  readinessRoot: string;
  /** Non-secret owner identity; keeps readiness state isolated across workspaces. */
  scopeIdentity?: string;
  baseHome?: string;
  /** Presence distinguishes an authoritative workspace clear from legacy/local config. */
  relayAuthoritative: boolean;
  relay: MultiremiRelayEngineWire | null;
  signal?: AbortSignal;
  runCommand?: (command: CodexPluginCommand) => Promise<void>;
}

/**
 * Build the Runtime-readiness CODEX_HOME with the same Relay contract used by
 * task execution. Gateway credentials exist only in the native Plugin command
 * environment; the generated config contains routing plus an env-key pointer.
 */
export async function installCodexPluginReadinessHome(
  snapshot: AgentPluginArtifactSpec,
  payloadPath: string,
  options: InstallCodexPluginReadinessHomeOptions,
): Promise<string | null> {
  const relayToken = options.relay?.auth_token.trim() ?? "";
  const readinessScope = createHash("sha256").update(JSON.stringify({
    owner: options.scopeIdentity ?? "default",
    mode: options.relayAuthoritative
      ? relayToken ? "workspace-relay" : "workspace-native-oauth"
      : "runtime-native",
    revision: options.relay?.revision ?? null,
  })).digest("hex").slice(0, 24);
  const prepared = await prepareCodexPluginReadinessRuntime(
    snapshot,
    payloadPath,
    join(options.readinessRoot, readinessScope),
    options.signal,
  );
  const baseHome = options.baseHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const relayUsesEnvApiKey = options.relayAuthoritative && Boolean(relayToken);
  const useNativeOAuth = !relayUsesEnvApiKey;

  let configToml: string | undefined;
  let env: Record<string, string> | undefined;
  if (options.relayAuthoritative) {
    configToml = mergeCodexSessionConfig(
      "",
      options.relay?.fragment ?? "",
      relayUsesEnvApiKey,
    );
    // An empty value is an intentional tombstone: installCodexPluginHome
    // overlays this on process.env, so a stale machine key cannot survive a
    // workspace Relay clear and bypass native OAuth.
    env = { OPENAI_API_KEY: relayToken };
    if (useNativeOAuth) await assertIssueSessionNativeCodexOAuth(baseHome);
  }

  return installCodexPluginHome(prepared, {
    signal: options.signal,
    ...(options.runCommand ? { runCommand: options.runCommand } : {}),
    ...(env ? { env } : {}),
    seedHome: (targetHome) => seedCodexHomeFromBase({
      baseHome,
      targetHome,
      ...(configToml === undefined ? {} : { configToml }),
      requireAuth: useNativeOAuth,
      copyAuth: false,
      linkAuth: useNativeOAuth,
    }),
  });
}
export const MULTIREMI_REREGISTER_COALESCE_WINDOW_MS = 30_000;
export const MULTIREMI_REREGISTER_FAILURE_BACKOFF_MS = 60_000;
const TERMINAL_AUTHORITY_CLEANUP_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];
const DEFAULT_TASK_DRAIN_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_OUTBOX_STARTUP_FLUSH_TIMEOUT_MS = 30_000;
const OUTBOX_RECONCILE_CONCURRENCY = 6;
const IN_PROCESS_RUNTIME_MODEL_DISCOVERY_DISABLED =
  "Runtime model discovery is temporarily disabled in the daemon process; gateway models remain available";

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
  /** How long an unattended task waits for human input before expiring (default 5 min). */
  unattendedHumanRequestTimeoutMs?: number;
  /** How often a running task polls for unconsumed steer messages (default 2.5s). */
  steerPollIntervalMs?: number;
  /** How long a force-answer run may keep going before the daemon wraps it up with the output so far (default 3 min). */
  forceAnswerGraceMs?: number;
  daemonPort?: number;
  workspacesRoot?: string;
  repoCacheRoot?: string;
  gcEnabled?: boolean;
  gcIntervalMs?: number;
  gcTtlMs?: number;
  gcOrphanTtlMs?: number;
  /** Session archives are a mandatory Issue GC precondition by default. */
  gcRequireArchive?: boolean;
  /** Injectable isolated Git inspector for GC tests. */
  gitWorktreeInspector?: GitWorktreeInspector;
  /** Maximum uncompressed provider history accepted for one Issue snapshot. */
  sessionArchiveMaxSourceBytes?: number;
  /** Operator-trusted API origin used only for Session Archive content uploads. */
  sessionArchiveUploadBaseUrl?: string | null;
  /** Largest archive allowed through the control-plane proxy fallback. */
  sessionArchiveProxyMaxBytes?: number;
  /** TTL for positive and negative direct-route HEAD attestations. */
  sessionArchiveDirectProbeTtlMs?: number;
  /** Maximum duration of a direct-route HEAD attestation. */
  sessionArchiveDirectProbeTimeoutMs?: number;
  /** Maximum total duration of one archive content upload. */
  sessionArchiveUploadTimeoutMs?: number;
  /** Maximum duration of best-effort upload failure reporting. */
  sessionArchiveFailureReportTimeoutMs?: number;
  /** Runtime-global immutable Agent Plugin cache. */
  pluginCacheRoot?: string;
  /** Injectable provider capability probe; production uses the native CLI and ACP bridge. */
  agentPluginProviderPreflight?: MultiremiAgentPluginProviderPreflight;
  /** Initial retry delay for Runtime model discovery/reporting. */
  runtimeModelRetryBaseMs?: number;
  /** Maximum retry delay for Runtime model discovery/reporting. */
  runtimeModelRetryMaxMs?: number;
  /**
   * Test-only escape hatch for the legacy in-process ACP model probe. Production
   * callers must leave this disabled until discovery runs in an isolated OS
   * process: a native ACP/Bun crash would otherwise terminate the daemon.
   */
  inProcessRuntimeModelDiscoveryEnabled?: boolean;
  /** Injectable SSH Mesh lifecycle for daemon integration tests. */
  sshMeshManager?: MultiremiDaemonSshMeshRuntime;
  /** Injectable retry schedule for terminal-authority SSH Mesh cleanup tests. */
  terminalAuthorityCleanupRetryDelaysMs?: number[];
  /**
   * Root-scoped Issue lifecycle barrier. Every provider daemon that shares a
   * workspaces root must receive the same instance so task setup cannot race
   * another provider's archive-and-delete pass.
   */
  issueWorkspaceLifecycleLocker?: IssueWorkspaceLifecycleLocker;
  /** Verifies that this process still owns the canonical workspaces root. */
  workspaceRootFence?: () => void;
  /** Shared readiness of every provider daemon in this supervisor process. */
  supervisorReady?: () => boolean;
  /** Updates the shared provider readiness barrier. */
  onReadyChange?: (ready: boolean) => void;
  /** Shared machine-level gate for the CLI binary used by co-resident providers. */
  cliUpdateCoordinator?: MultiremiCliUpdateCoordinator;
  /** Full path of the durable report-outbox database (tests use ":memory:"). */
  outboxPath?: string;
  /** Injectable retry schedule for outbox delivery tests. */
  outboxBackoffMs?: number[];
  /** Soft on-disk cap for the report outbox. */
  outboxMaxBytes?: number;
  /** Maximum wait for one task's reports before execution accounting moves on. */
  taskDrainTimeoutMs?: number;
  /** Maximum startup wait for persisted reports before the daemon becomes ready. */
  outboxStartupFlushTimeoutMs?: number;
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
  failureReason?: TaskFailureReasonValue;
  /** True when the run loop already finalized the task server-side (progress,
   *  usage and completeTask) — done inside runAgent so a steer racing
   *  completion can still be injected while the provider session is open. */
  completed: boolean;
}

interface PreparedIssueWorkspace {
  checkouts: TaskRepoCheckout[];
  repos: MultiremiIssueWorkspaceRepo[];
  warnings: TaskRepoWarning[];
}

function repoWarningsFromSyncResults(results: MultiremiRepoSyncResult[]): TaskRepoWarning[] {
  return results.flatMap((result) => {
    if (result.status === "fresh") return [];
    return [{
      repoUrl: result.repoUrl,
      kind: result.status === "cached" ? "stale_cache" as const : "unavailable" as const,
      message: result.error ?? "repository preparation failed",
    }];
  });
}

function upsertRepoWarning(warnings: TaskRepoWarning[], warning: TaskRepoWarning): void {
  const index = warnings.findIndex((item) => item.repoUrl === warning.repoUrl);
  if (index >= 0) warnings[index] = warning;
  else warnings.push(warning);
}

export type MultiremiTaskProvider = Pick<Provider, "sendStream" | "getLastResponse"> & {
  close?: () => Promise<void> | void;
  discoverModelCapabilities?: () => Promise<AcpModelCapability[]>;
  getStreamedText?: (chatId: string) => string;
  setPermissionHandler?: (handler: (params: RequestPermissionParams) => Promise<PermissionOutcome>) => void;
  setElicitationHandler?: (handler: (params: ElicitationCreateParams) => Promise<ElicitationResult>) => void;
};

export interface ElicitationContext {
  text: string;
  truncated?: boolean;
}

export interface ElicitationContextSlice {
  offset: number;
  context?: ElicitationContext;
}

const MAX_ELICITATION_CONTEXT_CHARACTERS = 4_000;

function comparableText(value: string): string {
  return value.replace(/\s/g, "");
}

/** Consume only assistant prose emitted since the previous elicitation. */
export function sliceElicitationContext(
  streamedText: string,
  offset: number,
  message: string,
  questionTexts: string[],
): ElicitationContextSlice {
  const safeOffset = offset >= 0 && offset <= streamedText.length ? offset : 0;
  const text = streamedText.slice(safeOffset).trim();
  const result: ElicitationContextSlice = { offset: streamedText.length };
  if (!text) return result;

  const comparable = comparableText(text);
  if ([message, ...questionTexts].some((candidate) => comparableText(candidate) === comparable)) {
    return result;
  }

  const characters = Array.from(text);
  if (characters.length > MAX_ELICITATION_CONTEXT_CHARACTERS) {
    return {
      ...result,
      context: {
        text: characters.slice(-MAX_ELICITATION_CONTEXT_CHARACTERS).join(""),
        truncated: true,
      },
    };
  }
  return { ...result, context: { text } };
}

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
  private options: Required<Omit<MultiremiDaemonOptions, "token" | "runtimeId" | "daemonId" | "workspaceId" | "providerFactory" | "updateRunner" | "localSkillRoots" | "launchedBy" | "onRestartRequested" | "taskTimeoutMs" | "daemonPort" | "workspacesRoot" | "repoCacheRoot" | "gcEnabled" | "gcIntervalMs" | "gcTtlMs" | "gcOrphanTtlMs" | "gcRequireArchive" | "gitWorktreeInspector" | "sessionArchiveMaxSourceBytes" | "sessionArchiveUploadBaseUrl" | "sessionArchiveProxyMaxBytes" | "sessionArchiveDirectProbeTtlMs" | "sessionArchiveDirectProbeTimeoutMs" | "sessionArchiveUploadTimeoutMs" | "sessionArchiveFailureReportTimeoutMs" | "pluginCacheRoot" | "agentPluginProviderPreflight" | "sshMeshManager" | "terminalAuthorityCleanupRetryDelaysMs" | "issueWorkspaceLifecycleLocker" | "workspaceRootFence" | "supervisorReady" | "onReadyChange" | "cliUpdateCoordinator" | "outboxPath" | "outboxBackoffMs" | "outboxMaxBytes">> & {
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
    gcRequireArchive: boolean;
    sessionArchiveMaxSourceBytes: number;
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
  private drainingTaskCount = 0;
  private pendingClaimCount = 0;
  private inflight = new Set<Promise<void>>();
  private activeTaskIds = new Set<string>();
  private activeTaskAborts = new Set<AbortController>();
  private claimsPaused = false;
  /**
   * Server-driven platform drain. Unlike claimsPaused (local CLI self-update,
   * which exits the poll loop), a drain keeps the loop alive: heartbeats and
   * running tasks continue, only new claims stop until the server acks normal.
   */
  private serverDrainActive = false;
  private appliedDrainGeneration = 0;
  private outbox: MultiremiTaskReportOutbox | null = null;
  private outboxAbort: AbortController | null = null;
  private readonly outboxPath: string;
  private readonly outboxBackoffMs: number[] | undefined;
  private readonly outboxMaxBytes: number | undefined;
  private restartRequestedFlag = false;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private gcInFlight: Promise<MultiremiDaemonGcSummary> | null = null;
  private sessionArchiveRetryLogAt = new Map<string, number>();
  private readonly gitWorktreeInspector: GitWorktreeInspector;
  private localPathLocks = new LocalPathLocker();
  private issueWorkspaceLifecycleLocks: IssueWorkspaceLifecycleLocker;
  private readonly topicWorkspaces: TopicWorkspaceLifecycle;
  private runtimeGoneInflight = new Set<string>();
  private reregisterGate = new MultiremiRuntimeReregisterGate();
  private readonly explicitRuntimeId: boolean;
  private readonly agentPluginCache: AgentPluginCache;
  private readonly agentPluginReconciler: AgentPluginRuntimeReconciler;
  private readonly agentPluginProviderPreflight: MultiremiAgentPluginProviderPreflight;
  private readonly sshMeshManager: MultiremiDaemonSshMeshRuntime;
  private readonly terminalAuthorityCleanupRetryDelaysMs: number[];
  private readonly defaultGcPolicy: WorkspaceGcPolicy;
  private readonly workspaceRootFence: (() => void) | null;
  private readonly supervisorReady: () => boolean;
  private readonly onReadyChange: (ready: boolean) => void;
  private readonly cliUpdateCoordinator: MultiremiCliUpdateCoordinator | null;
  private workspaceOwnershipLost = false;
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
  private botMenuPublisher: ((config: ResolvedBotMenuConfig, dryRun: boolean) => Promise<BotMenuPublishResult>) | null = null;
  private feishuConcierge: FeishuConciergeSupervisor | null = null;
  private feishuConciergeReconcile: Promise<void> = Promise.resolve();

  constructor(options: MultiremiDaemonOptions) {
    if (options.inProcessRuntimeModelDiscoveryEnabled && !options.providerFactory) {
      throw new Error(
        "In-process Runtime model discovery may only be enabled with an injected test provider",
      );
    }
    const workspacesRoot = configuredMultiremiWorkspacesRoot(options.workspacesRoot);
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
    this.issueWorkspaceLifecycleLocks = options.issueWorkspaceLifecycleLocker
      ?? new IssueWorkspaceLifecycleLocker();
    this.gitWorktreeInspector = options.gitWorktreeInspector
      ?? new IsomorphicGitWorktreeInspector();
    this.workspaceRootFence = options.workspaceRootFence ?? null;
    this.supervisorReady = options.supervisorReady ?? (() => this.ready);
    this.onReadyChange = options.onReadyChange ?? (() => {});
    this.cliUpdateCoordinator = options.cliUpdateCoordinator ?? null;
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
      taskDrainTimeoutMs: Math.max(1, options.taskDrainTimeoutMs ?? DEFAULT_TASK_DRAIN_TIMEOUT_MS),
      outboxStartupFlushTimeoutMs: Math.max(
        1,
        options.outboxStartupFlushTimeoutMs ?? DEFAULT_OUTBOX_STARTUP_FLUSH_TIMEOUT_MS,
      ),
      approvalMode: options.approvalMode ?? (process.env.MULTIREMI_APPROVAL_MODE === "ask" ? "ask" : "auto"),
      humanRequestTimeoutMs: options.humanRequestTimeoutMs ?? numberEnv(process.env.MULTIREMI_HUMAN_REQUEST_TIMEOUT_MS, 30 * 60 * 1000),
      unattendedHumanRequestTimeoutMs: options.unattendedHumanRequestTimeoutMs
        ?? numberEnv(process.env.MULTIREMI_UNATTENDED_HUMAN_REQUEST_TIMEOUT_MS, 5 * 60 * 1000),
      steerPollIntervalMs: options.steerPollIntervalMs ?? numberEnv(process.env.MULTIREMI_STEER_POLL_INTERVAL_MS, DEFAULT_STEER_POLL_MS),
      forceAnswerGraceMs: options.forceAnswerGraceMs ?? numberEnv(process.env.MULTIREMI_FORCE_ANSWER_GRACE_MS, DEFAULT_FORCE_ANSWER_GRACE_MS),
      daemonPort: options.daemonPort ?? numberEnv(process.env.MULTIREMI_DAEMON_PORT, 6131),
      workspacesRoot,
      repoCacheRoot: options.repoCacheRoot ?? process.env.MULTIREMI_REPO_CACHE_ROOT ?? join(workspacesRoot, ".repos"),
      gcEnabled: options.gcEnabled ?? booleanEnv(process.env.MULTIREMI_GC_ENABLED, true),
      gcIntervalMs: options.gcIntervalMs ?? numberEnv(process.env.MULTIREMI_GC_INTERVAL_MS, 15 * 60 * 1000),
      gcTtlMs: options.gcTtlMs ?? numberEnv(process.env.MULTIREMI_GC_TTL_MS, 72 * 60 * 60 * 1000),
      gcOrphanTtlMs: options.gcOrphanTtlMs ?? numberEnv(process.env.MULTIREMI_GC_ORPHAN_TTL_MS, 72 * 60 * 60 * 1000),
      gcRequireArchive: options.gcRequireArchive ?? true,
      sessionArchiveMaxSourceBytes: options.sessionArchiveMaxSourceBytes
        ?? numberEnv(process.env.MULTIREMI_SESSION_ARCHIVE_MAX_SOURCE_BYTES, 512 * 1024 * 1024),
      pluginCacheRoot: options.pluginCacheRoot
        ?? process.env.MULTIREMI_PLUGIN_CACHE_ROOT
        ?? join(homedir(), ".remi", "plugin-cache", "sha256"),
      runtimeModelRetryBaseMs,
      runtimeModelRetryMaxMs,
      inProcessRuntimeModelDiscoveryEnabled:
        options.inProcessRuntimeModelDiscoveryEnabled === true,
      serverUrl: options.serverUrl,
    };
    this.topicWorkspaces = new TopicWorkspaceLifecycle({
      root: workspacesRoot,
      locker: this.issueWorkspaceLifecycleLocks,
      assertRootOwner: () => this.assertWorkspaceRootOwner(),
    });
    this.defaultGcPolicy = {
      ttlMs: this.options.gcTtlMs,
      intervalMs: this.options.gcIntervalMs,
    };
    this.providerFactory = options.providerFactory ?? ((providerOptions) => new AcpProvider(providerOptions));
    this.updateRunner = options.updateRunner ?? runDefaultMultiremiUpdate;
    this.onRestartRequested = options.onRestartRequested ?? null;
    this.cliUpdateCoordinator?.register({
      provider: this.options.provider,
      activeTaskCount: () => this.activeTaskCount,
      pendingClaimCount: () => this.pendingClaimCount,
      claimsPaused: () => this.claimsPaused,
      pauseClaims: () => { this.claimsPaused = true; },
      releaseClaims: () => this.releaseLocalUpdateClaimPause(),
    });
    this.agentPluginProviderPreflight = options.agentPluginProviderPreflight
      ?? ((provider, signal) => preflightAgentPluginProvider(provider, {}, signal));
    const cleanupRetryDelays = (options.terminalAuthorityCleanupRetryDelaysMs ?? [])
      .filter((delay) => Number.isFinite(delay) && delay > 0)
      .map((delay) => Math.max(1, Math.floor(delay)));
    this.terminalAuthorityCleanupRetryDelaysMs = cleanupRetryDelays.length
      ? cleanupRetryDelays
      : [...TERMINAL_AUTHORITY_CLEANUP_RETRY_DELAYS_MS];
    this.localSkillRoots = options.localSkillRoots ?? {};
    this.client = new MultiremiDaemonClient(options.serverUrl, this.options.token, {
      sessionArchiveUploadBaseUrl: options.sessionArchiveUploadBaseUrl === undefined
        ? process.env.MULTIREMI_ARCHIVE_UPLOAD_BASE_URL ?? null
        : options.sessionArchiveUploadBaseUrl,
      sessionArchiveProxyMaxBytes: options.sessionArchiveProxyMaxBytes
        ?? numberEnv(process.env.MULTIREMI_ARCHIVE_PROXY_MAX_BYTES, 8 * 1024 * 1024),
      sessionArchiveDirectProbeTtlMs: options.sessionArchiveDirectProbeTtlMs
        ?? numberEnv(process.env.MULTIREMI_ARCHIVE_DIRECT_PROBE_TTL_MS, 5 * 60 * 1_000),
      sessionArchiveDirectProbeTimeoutMs: options.sessionArchiveDirectProbeTimeoutMs
        ?? numberEnv(process.env.MULTIREMI_ARCHIVE_DIRECT_PROBE_TIMEOUT_MS, 10_000),
      sessionArchiveUploadTimeoutMs: options.sessionArchiveUploadTimeoutMs
        ?? numberEnv(process.env.MULTIREMI_ARCHIVE_UPLOAD_TIMEOUT_MS, 15 * 60 * 1_000),
      sessionArchiveFailureReportTimeoutMs: options.sessionArchiveFailureReportTimeoutMs
        ?? numberEnv(process.env.MULTIREMI_ARCHIVE_FAILURE_REPORT_TIMEOUT_MS, 10_000),
    });
    this.sshMeshManager = options.sshMeshManager ?? new SshMeshManager({
      workspaceId: this.options.workspaceId ?? "local",
      daemonId: this.options.daemonId ?? this.options.runtimeName,
      getConfig: async (signal) => {
        const runtimeId = this.options.runtimeId;
        if (!runtimeId) throw new Error("SSH Mesh configuration requested before Runtime registration");
        return await this.client.getSshMeshConfig(runtimeId, signal);
      },
    });
    this.repoCache = new MultiremiRepoCache(this.options.repoCacheRoot, {
      credentialBroker: {
        serverUrl: this.options.serverUrl,
        token: this.options.token,
      },
      ...repoCacheTimeoutOverrides(process.env),
    });
    this.agentPluginCache = new AgentPluginCache({
      root: this.options.pluginCacheRoot,
      serverUrl: this.options.serverUrl,
      getAuthToken: () => this.options.token,
    });
    // One durable outbox per (server, workspace, daemon, provider) identity so
    // a restarted daemon reopens exactly its own undelivered reports, and
    // co-resident provider daemons never contend for one file. Lives in the
    // daemon's own state dir — never inside any Git worktree.
    const outboxIdentity = createHash("sha256").update([
      this.options.serverUrl,
      this.options.workspaceId ?? "local",
      this.options.daemonId ?? this.options.runtimeName,
      this.options.provider,
    ].join("|")).digest("hex").slice(0, 16);
    this.outboxPath = options.outboxPath
      ?? join(
        process.env.MULTIREMI_OUTBOX_DIR
          ?? join(process.env.MULTIREMI_STATE_DIR ?? join(homedir(), ".multiremi"), "outbox"),
        `${this.options.provider}-${outboxIdentity}.db`,
      );
    this.outboxBackoffMs = options.outboxBackoffMs;
    this.outboxMaxBytes = options.outboxMaxBytes
      ?? numberEnv(process.env.MULTIREMI_OUTBOX_MAX_BYTES, 256 * 1024 * 1024);
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

  async checkExternalWorkspaceMembership(workspaceId: string, externalId: string): Promise<boolean> {
    workspaceId = workspaceId.trim();
    if (!workspaceId) {
      throw new Error("Multiremi workspace is required for external membership checks");
    }
    return this.client.checkExternalWorkspaceMembership(workspaceId, externalId);
  }

  submitFeishuBotMessage(input: SubmitFeishuBotMessageInput): Promise<SubmitFeishuBotMessageResult> {
    return this.client.submitFeishuBotMessage(this.options.runtimeId!, input);
  }

  listFeishuBotTaskMessages(taskId: string, sinceSeq: number): Promise<MultiremiTaskMessage[]> {
    return this.client.listTaskMessages(taskId, sinceSeq);
  }

  getFeishuBotTaskSnapshot(taskId: string): Promise<FeishuBotTaskSnapshot> {
    return this.client.getFeishuBotTaskSnapshot(taskId);
  }

  respondFeishuBotHumanRequest(
    taskId: string,
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<MultiremiTaskHumanRequest> {
    return this.client.respondTaskHumanRequest(taskId, requestId, response);
  }

  resetFeishuBotSession(revision: number, externalSessionKey: string): Promise<boolean> {
    return this.client.resetFeishuBotSession(this.options.runtimeId!, revision, externalSessionKey);
  }

  cancelFeishuBotSessionTask(
    revision: number,
    externalSessionKey: string,
  ): Promise<{ cancelled: boolean; taskId: string | null }> {
    return this.client.cancelFeishuBotSessionTask(this.options.runtimeId!, revision, externalSessionKey);
  }

  inspectFeishuBotSession(revision: number, externalSessionKey: string) {
    return this.client.inspectFeishuBotSession(this.options.runtimeId!, revision, externalSessionKey);
  }

  async ensureTopicWorkspace(sessionKey: string, topicId: string): Promise<string | null> {
    return this.topicWorkspaces.ensureTopicWorkspace(sessionKey, topicId);
  }

  setBotMenuPublisher(
    publisher: ((config: ResolvedBotMenuConfig, dryRun: boolean) => Promise<BotMenuPublishResult>) | null,
  ): void {
    this.botMenuPublisher = publisher;
  }

  /**
   * Let this process host the workspace Feishu concierge (MUL-206). Passing a
   * host is what advertises `feishu_concierge_protocol` on the heartbeat, so a
   * daemon that cannot boot a Remi core never gets offered the bot.
   */
  setFeishuConciergeHost(host: FeishuConciergeHost | null): void {
    if (!host) {
      this.feishuConcierge = null;
      return;
    }
    this.feishuConcierge = new FeishuConciergeSupervisor({
      host,
      // Both callbacks read runtimeId at call time: the daemon can re-register
      // and get a new id while the connector is running.
      fetchConfig: async () => this.client.getFeishuBotConfig(this.options.runtimeId!),
      report: async (input) => {
        await this.client.reportFeishuBotRuntimeStatus(this.options.runtimeId!, input);
      },
      log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
    });
  }

  /**
   * Report a concierge that died on its own — a websocket the connector could
   * not recover, say. Without this the control plane keeps showing `online` for
   * a bot that stopped answering, and no heartbeat would ever restart it.
   */
  async reportFeishuConciergeFailure(error: unknown): Promise<void> {
    await this.feishuConcierge?.reportChannelFailure(error);
  }

  /**
   * Take the concierge down and tell the control plane before the process
   * exits. Without this the workspace waits out the 90s staleness window
   * before another Runtime may take the bot.
   */
  async shutdownFeishuConcierge(): Promise<void> {
    const supervisor = this.feishuConcierge;
    if (!supervisor) return;
    await this.feishuConciergeReconcile.catch(() => {});
    await supervisor.shutdown().catch((error) => {
      log.warn(`Feishu concierge shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async start(): Promise<void> {
    this.startedAt = new Date();
    this.ready = false;
    this.stopped = false;
    this.claimsPaused = false;
    this.serverDrainActive = false;
    this.appliedDrainGeneration = 0;
    this.terminalAuthorityMode = false;
    this.terminalAuthorityCleanupAttempts = 0;
    this.restartRequestedFlag = false;
    this.workspaceOwnershipLost = false;
    this.onReadyChange(false);
    this.assertWorkspaceRootOwner();
    const outbox = this.ensureOutbox();
    this.startRepoCheckoutServer();
    try {
      await this.registerCurrentRuntime();
      this.assertWorkspaceRootOwner();
      // Replay reports left over from a previous run BEFORE recover-orphans:
      // recoverOrphans marks in-flight tasks failed, so an undelivered
      // complete/fail must land first or a finished task gets mislabelled.
      // Purely non-terminal history has a bounded startup wait and may continue
      // in the background; tasks with terminal reports must settle first.
      await this.reconcilePendingOutboxTasks(outbox);
      await this.flushStartupOutbox(outbox);
      await this.refreshWorkspaceRepos(this.options.workspaceId);
      this.assertWorkspaceRootOwner();
      this.startGcLoop();
      // One-shot mode is primarily used for a single queued task (and tests), so
      // avoid paying for a second ACP process unless a model-list request exists.
      if (this.options.inProcessRuntimeModelDiscoveryEnabled && !this.options.once) {
        this.startRuntimeModelRefresh();
      }
      await this.reconcileRuntimeAgentPlugins(this.options.runtimeId!);
      // registerCurrentRuntime() assigns a non-null runtime id; it is re-read each
      // iteration because handleHeartbeatAck() may re-register and replace it.
      await this.client.recoverOrphans(this.options.runtimeId!);
      this.ready = true;
      this.onReadyChange(true);
      // A co-resident provider becoming ready is not enough to claim work.
      // Hold every lane until the process-wide readiness barrier is complete;
      // otherwise a sibling startup failure can leave an unacknowledged task.
      while (!this.stopped && !this.supervisorReady()) {
        await sleep(Math.max(10, Math.min(this.options.pollIntervalMs, 100)));
      }

      while (!this.stopped) {
        try {
          this.assertWorkspaceRootOwner();
          if (!this.supervisorReady()) {
            await sleep(Math.max(10, Math.min(this.options.pollIntervalMs, 100)));
            continue;
          }
          const ack = await this.client.heartbeatRuntime(
            this.options.runtimeId!,
            this.sshMeshManager.getHeartbeatStatus(),
            {
              ackGeneration: this.appliedDrainGeneration,
              activeTaskCount: this.activeTaskCount,
            },
            this.botMenuPublisher !== null,
            this.feishuConcierge !== null,
          );
          const skipClaim = await this.handleHeartbeatAck(this.options.runtimeId!, ack);
          if (!skipClaim && !this.stopped) {
            await this.reconcileRuntimeAgentPlugins(this.options.runtimeId!);
          }
          if (this.stopped || this.claimsPaused) break;
          if (skipClaim || this.serverDrainActive) {
            if (this.options.once) return;
            await sleep(this.options.pollIntervalMs);
            continue;
          }

          if (this.options.once) {
            // One-shot mode (tests, single runs) stays strictly serial:
            // claim one task, run it to completion, return.
            const task = await this.claimTask(this.options.runtimeId!);
            if (!task) return;
            await this.handleTask(task);
            return;
          }

          // Bounded claim pump: keep claiming while we have spare capacity, and
          // run each task concurrently (detached). The server's claim query also
          // caps in-flight tasks at the runtime's maxConcurrency, so this local
          // gate and the server agree. activeTaskCount is incremented
          // synchronously at the top of handleTask, so the loop sees it grow.
          while (
            this.activeTaskCount < this.options.maxConcurrency
            && !this.stopped
            && !this.claimsPaused
            && !this.serverDrainActive
            && this.supervisorReady()
          ) {
            const task = await this.claimTask(this.options.runtimeId!);
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
      this.onReadyChange(false);
      // Stop scheduling new sweeps before draining tasks. An existing sweep
      // may be waiting on a task's Issue lifecycle lease and is drained below.
      this.stopGcLoop();
      this.cancelRuntimeModelRefresh();
      const modelRefresh = this.runtimeModelRefreshTask;
      if (modelRefresh) await Promise.allSettled([modelRefresh]);
      // Running tasks depend on the repo-checkout server, so let any in-flight
      // tasks drain before waiting for the GC lease they may currently hold.
      await Promise.allSettled([...this.inflight]);
      await this.drainGcInFlight();
      this.gitWorktreeInspector?.close();
      this.stopRepoCheckoutServer();
      // Undelivered rows stay on disk and replay on the next start(). close()
      // wakes retry sleepers, so a mid-backoff pump exits promptly.
      this.outboxAbort?.abort();
      const outbox = this.outbox;
      this.outbox = null;
      if (outbox) {
        await outbox.close().catch((error) => {
          log.warn(`outbox close failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
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
      this.applyWorkspaceRegistrationState(response);
      this.runtimeRegistrationGeneration++;
      log.info(`Runtime registered: ${this.options.runtimeId} (${this.options.provider})`);
      return this.options.runtimeId;
    }
    const runtime = await this.client.registerRuntime(this.currentRuntimeRegistrationInput());
    this.options.runtimeId = runtime.runtime.id;
    if (this.botMenuPublisher || this.feishuConcierge) {
      const ack = await this.client.heartbeatRuntime(
        this.options.runtimeId,
        undefined,
        undefined,
        this.botMenuPublisher !== null,
        this.feishuConcierge !== null,
      );
      if (ack.workspace_settings) this.applyWorkspaceSettings(this.options.workspaceId ?? "local", ack.workspace_settings);
      if (ack.relay) this.workspaceRelays.set(this.options.workspaceId ?? "local", ack.relay);
      this.applyFeishuBotDirective(ack);
    }
    this.runtimeRegistrationGeneration++;
    log.info(`Runtime registered: ${this.options.runtimeId} (${this.options.provider})`);
    return this.options.runtimeId;
  }

  private applyWorkspaceRegistrationState(response: MultiremiDaemonRegisterResponse): void {
    const workspaceId = response.workspace_id ?? this.options.workspaceId ?? "local";
    const repos = normalizeRepoList(response.repos ?? []);
    this.workspaceRepoUrls.set(workspaceId, new Set(repos.map((repo) => repo.url.trim()).filter(Boolean)));
    this.applyWorkspaceSettings(workspaceId, response.settings ?? {});
    this.workspaceRelays.set(workspaceId, response.relay);
    // Keep startup metadata-only. Eager Git sync blocks Bun's event loop and is
    // duplicated by co-resident Claude/Codex daemons. Tasks and explicit
    // checkouts populate only the repositories they actually need.
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

  private async handleHeartbeatAck(runtimeId: string, ack: MultiremiDaemonHeartbeatConfigAck): Promise<boolean> {
    const workspaceId = this.options.workspaceId ?? "local";
    if (ack.drain) {
      const draining = ack.drain.mode === "draining";
      if (draining !== this.serverDrainActive) {
        log.info(
          draining
            ? `Platform drain generation ${ack.drain.generation} active: pausing task claims (running tasks continue)`
            : "Platform drain released: resuming task claims",
        );
      }
      this.serverDrainActive = draining;
      // Track the highest generation seen so the next heartbeat acknowledges
      // it. Acknowledging in normal mode too keeps the ack current when a new
      // drain begins (the bumped generation is only acked after it is applied).
      if (Number.isSafeInteger(ack.drain.generation) && ack.drain.generation > this.appliedDrainGeneration) {
        this.appliedDrainGeneration = ack.drain.generation;
      }
    }
    if (ack.status === "runtime_gone" || ack.runtime_gone) {
      return !(await this.handleRuntimeGone(runtimeId, Date.now()));
    }
    if (ack.workspace_settings) this.applyWorkspaceSettings(workspaceId, ack.workspace_settings);
    if (ack.relay) {
      this.workspaceRelays.set(workspaceId, ack.relay);
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
    if (ack.pending_command) {
      await this.handleRuntimeCommand(runtimeId, ack.pending_command);
    }
    if (ack.pending_bot_menu) {
      await this.handleBotMenuPublish(runtimeId, ack.pending_bot_menu);
    }
    this.applyFeishuBotDirective(ack);
    if (ack.pending_feishu_outbound) {
      await this.handleFeishuBotOutbound(runtimeId, ack.pending_feishu_outbound);
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
      if (
        this.options.inProcessRuntimeModelDiscoveryEnabled
        && (this.runtimeModels || !this.options.once)
      ) {
        this.startRuntimeModelRefresh();
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
    const claimPause = this.tryPauseClaimsForUpdate(scope);
    if (!claimPause.ok) {
      await this.client.reportRuntimeUpdateResult(runtimeId, requestId, {
        status: "failed",
        error: claimPause.error,
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
      this.releaseUpdateClaimPause(scope);
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
    if (!this.options.inProcessRuntimeModelDiscoveryEnabled) {
      await this.client.reportRuntimeModelListResult(runtimeId, requestId, {
        status: "failed",
        error: IN_PROCESS_RUNTIME_MODEL_DISCOVERY_DISABLED,
      });
      return;
    }
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

  private async handleRuntimeCommand(
    runtimeId: string,
    request: NonNullable<MultiremiDaemonHeartbeatAck["pending_command"]>,
  ): Promise<void> {
    const result = await executeRuntimeCommand({
      command: request.command,
      args: request.args,
      timeoutMs: request.timeout_ms,
    });
    await this.client.reportRuntimeCommandResult(runtimeId, request.id, {
      status: result.status,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  private async handleBotMenuPublish(
    runtimeId: string,
    request: NonNullable<MultiremiDaemonHeartbeatAck["pending_bot_menu"]>,
  ): Promise<void> {
    if (!this.botMenuPublisher) {
      await this.client.reportBotMenuPublishResult(runtimeId, request.id, {
        status: "failed",
        error: "Feishu bot menu publisher is unavailable",
      });
      return;
    }
    try {
      const result = await this.botMenuPublisher(request.config, request.dry_run);
      await this.client.reportBotMenuPublishResult(runtimeId, request.id, {
        status: "completed",
        result,
      });
    } catch (error) {
      await this.client.reportBotMenuPublishResult(runtimeId, request.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Hand a heartbeat's concierge directive to the supervisor without waiting
   * for it. Booting a Remi core takes seconds, and the heartbeat loop is also
   * what claims tasks — blocking it on a connector start would stall unrelated
   * work. The supervisor serializes its own reconciles, so firing on every
   * heartbeat cannot overlap two starts.
   */
  private applyFeishuBotDirective(ack: MultiremiDaemonHeartbeatConfigAck): void {
    const supervisor = this.feishuConcierge;
    if (!supervisor || !ack.feishu_bot) return;
    const directive = ack.feishu_bot;
    this.feishuConciergeReconcile = this.feishuConciergeReconcile
      .catch(() => {})
      .then(() => supervisor.apply(directive))
      .catch((error) => {
        log.warn(`Feishu concierge reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private async handleFeishuBotOutbound(
    runtimeId: string,
    delivery: NonNullable<MultiremiDaemonHeartbeatConfigAck["pending_feishu_outbound"]>,
  ): Promise<void> {
    const supervisor = this.feishuConcierge;
    try {
      if (!supervisor) throw new Error("Feishu concierge is unavailable");
      const sent = await supervisor.sendOutbound(delivery);
      await this.client.reportFeishuBotOutboundResult(runtimeId, delivery.id, {
        claimToken: delivery.claimToken,
        status: "sent",
        externalMessageId: sent.messageId,
      });
    } catch (error) {
      await this.client.reportFeishuBotOutboundResult(runtimeId, delivery.id, {
        claimToken: delivery.claimToken,
        status: "failed",
        error: redactFeishuBotError(error),
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
    if (!this.options.inProcessRuntimeModelDiscoveryEnabled || this.stopped) return;
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
    if (!this.options.inProcessRuntimeModelDiscoveryEnabled) {
      throw new Error(IN_PROCESS_RUNTIME_MODEL_DISCOVERY_DISABLED);
    }
    if (!force && this.runtimeModels) return this.runtimeModels;
    if (this.runtimeModelProbe) return this.runtimeModelProbe;

    const abort = new AbortController();
    this.runtimeModelProbeAbort = abort;
    const probe = (async () => {
      const provider = this.providerFactory(await this.runtimeModelProbeProviderOptions());
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

  private async runtimeModelProbeProviderOptions(): Promise<AcpProviderOptions> {
    const provider = this.options.provider;
    if (provider !== "claude" && provider !== "codex") {
      return { agentType: provider, cwd: homedir() };
    }
    const workspaceId = this.options.workspaceId ?? "local";
    const workspaceRelay = this.workspaceRelays.get(workspaceId);
    const relayAuthoritative = workspaceRelay !== undefined;
    const relay = provider === "claude" ? workspaceRelay?.claude : workspaceRelay?.codex;
    const owner = `${this.options.daemonId ?? this.options.runtimeName}:${provider}`;
    const root = join(
      resolve(this.options.workspacesRoot),
      ".runtime-probe",
      `${provider}-${createHash("sha256").update(owner).digest("hex").slice(0, 16)}`,
    );
    const providerHome: IssueSessionProviderHome = {
      storageRoot: resolve(this.options.workspacesRoot),
      root,
      home: join(root, "home"),
      sessionId: "runtime-model-probe",
      agentId: owner,
      generation: 1,
      provider,
    };
    const providerEnv = await loadIssueSessionProviderEnv(providerHome, {
      ...(relayAuthoritative
        ? {
            relayFragment: relay?.fragment ?? "",
            relayAuthToken: relay?.auth_token ?? "",
          }
        : {}),
    });
    const usesCodexRelayKey = provider === "codex" && Boolean(providerEnv.OPENAI_API_KEY);
    await prepareIssueSessionProviderHome(providerHome, {
      linkCodexAuth: provider === "codex" && !usesCodexRelayKey,
      linkClaudeCredentials: provider === "claude"
        && !providerEnv.ANTHROPIC_AUTH_TOKEN
        && !providerEnv.ANTHROPIC_API_KEY,
      ...(relayAuthoritative ? { relayFragment: relay?.fragment ?? "" } : {}),
      codexRelayUsesEnvApiKey: usesCodexRelayKey,
    });
    return {
      agentType: provider,
      cwd: root,
      env: {
        ...providerEnv,
        ...(provider === "claude"
          ? { CLAUDE_CONFIG_DIR: providerHome.home }
          : { CODEX_HOME: providerHome.home }),
      },
    };
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
      const workspaceId = this.options.workspaceId ?? "local";
      const workspaceRelay = this.workspaceRelays.get(workspaceId);
      await installCodexPluginReadinessHome(
        snapshot,
        payloadPath,
        {
          readinessRoot: join(this.options.pluginCacheRoot, ".codex-readiness"),
          scopeIdentity: workspaceId,
          baseHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
          relayAuthoritative: workspaceRelay !== undefined,
          relay: workspaceRelay?.codex ?? null,
          signal,
        },
      );
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
    // stop() is synchronous and may be called while start() is sleeping. Clear
    // the timer immediately; start()'s finally block waits for any current run.
    this.stopGcLoop();
    this.terminalAuthorityCleanupRetryWake?.();
    this.agentPluginReconcileAbort?.abort();
    this.cancelRuntimeModelRefresh();
    // Release any handleTask waiting on report delivery; undelivered rows are
    // durable and replay on the next start().
    this.outboxAbort?.abort();
  }

  stopForWorkspaceOwnershipLoss(error: unknown): void {
    if (!this.workspaceOwnershipLost) {
      this.workspaceOwnershipLost = true;
      log.error(
        `Workspace supervisor ownership was lost; aborting local work: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.claimsPaused = true;
    this.ready = false;
    this.onReadyChange(false);
    for (const abort of this.activeTaskAborts) abort.abort();
    this.stop();
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
    if (this.gcInFlight) return await this.gcInFlight;
    const run = this.executeGcOnce();
    this.gcInFlight = run;
    try {
      return await run;
    } finally {
      if (this.gcInFlight === run) this.gcInFlight = null;
    }
  }

  private async executeGcOnce(): Promise<MultiremiDaemonGcSummary> {
    this.assertWorkspaceRootOwner();
    const summary = await runWorkspaceGcOnce({
      root: this.options.workspacesRoot,
      ttlMs: this.options.gcTtlMs,
      orphanTtlMs: this.options.gcOrphanTtlMs,
      client: this.client,
      runtimeId: this.options.runtimeId,
      requireIssueSessionArchive: this.options.gcRequireArchive,
      ensureIssueSessionArchive: (issueId, workspaceDir, forceFreshSnapshot) =>
        this.ensureIssueSessionArchive(issueId, workspaceDir, forceFreshSnapshot),
      assertRootOwner: () => this.assertWorkspaceRootOwner(),
      hasDirtyGitWorktree: (workspaceDir) =>
        this.gitWorktreeInspector.hasDirtyWorktree(workspaceDir),
      withIssueWorkspaceLock: (issueId, _workspaceDir, action) =>
        this.issueWorkspaceLifecycleLocks.runExclusive(issueId, async () => {
          this.assertWorkspaceRootOwner();
          await action();
          this.assertWorkspaceRootOwner();
        }),
      recoverTopicWorkspace: (topicDir) => this.topicWorkspaces.recoverTopicWorkspace(topicDir),
      isTopicWorkspaceBound: (topicDir) => this.topicWorkspaces.isTopicWorkspaceBound(topicDir),
      recoverIssueWorkspace: (issueDir) => this.topicWorkspaces.recoverIssueWorkspace(issueDir),
      returnTerminalIssueToTopic: (issueDir) => this.topicWorkspaces.returnTerminalIssueToTopic(issueDir),
      onError: (workspaceDir, error) => {
        log.warn(`Workspace GC skipped ${workspaceDir}: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    this.assertWorkspaceRootOwner();
    // Repo worktree metadata is pruned lazily for the repository that is about
    // to create a worktree. Sweeping every cached repository here creates a
    // large burst of synchronous child processes in the long-lived Bun daemon.
    return summary;
  }

  private async ensureIssueSessionArchive(
    issueId: string,
    workspaceDir: string,
    forceFreshSnapshot = false,
  ): Promise<MultiremiIssueWorkspaceArchiveBinding | null> {
    this.assertWorkspaceRootOwner();
    const runtimeId = this.options.runtimeId;
    if (!runtimeId) throw new Error("Session archive requires a registered Runtime");
    const receipt = await readIssueSessionArchiveReceipt(workspaceDir);
    let preflightStatus: MultiremiDaemonSessionArchiveStatus | null = null;
    if (!forceFreshSnapshot && receipt?.issueId === issueId) {
      const status = await this.client.getIssueSessionArchiveStatus(
        runtimeId,
        issueId,
        receipt.sourceRevision,
        receipt.sha256,
      );
      if (
        receipt.archiveId
        && status.gc_ready
        && status.requested_ready?.id === receipt.archiveId
      ) {
        return {
          archiveId: receipt.archiveId,
          sourceRevision: receipt.sourceRevision,
          sha256: receipt.sha256,
        };
      }
      preflightStatus = status;
    }
    preflightStatus ??= await this.client.getIssueSessionArchiveStatus(runtimeId, issueId);
    if (this.shouldDeferIssueSessionArchive(issueId, preflightStatus.latest)) {
      return null;
    }
    const runtimeStorageRoot = this.options.workspacesRoot;
    const sessionArchiveSource = runtimeStorageRoot ? ".runtime" : ".multiremi/sessions";
    let prepared: Awaited<ReturnType<typeof prepareIssueSessionArchive>>;
    try {
      this.assertWorkspaceRootOwner();
      prepared = await prepareIssueSessionArchive(workspaceDir, {
        maxSourceBytes: this.options.sessionArchiveMaxSourceBytes,
        ...(runtimeStorageRoot
          ? {
              sessionRoots: listIssueSessionRuntimeRoots(runtimeStorageRoot, issueId),
              sessionRootBoundary: runtimeStorageRoot,
            }
          : {}),
      });
      log.debug(`Issue Session archive prepared for ${issueId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.client.reportIssueSessionArchiveFailure(runtimeId, issueId, {
          stage: "prepare",
          error: message,
        });
      } catch (reportError) {
        log.warn(
          `Failed to report Issue session archive preparation failure for ${issueId}: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
        );
      }
      throw error;
    }
    try {
      log.debug(`Checking Issue Session archive status for ${issueId}`);
      const status = await this.client.getIssueSessionArchiveStatus(
        runtimeId,
        issueId,
        prepared.sourceRevision,
        prepared.sha256,
        forceFreshSnapshot,
      );
      log.debug(`Issue Session archive status checked for ${issueId}: ready=${status.gc_ready}`);
      if (status.gc_ready) {
        if (
          status.latest?.source_revision === MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION
          && (status.latest.status === "failed" || status.latest.status === "pending")
        ) {
          await this.client.initIssueSessionArchive(runtimeId, issueId, {
            sourceRevision: prepared.sourceRevision,
            sha256: prepared.sha256,
            sizeBytes: prepared.sizeBytes,
            fileCount: prepared.fileCount,
            metadata: {
              format: prepared.metadata.format,
              source: sessionArchiveSource,
            },
          });
        }
        const archiveId = status.requested_ready?.id;
        if (!archiveId) return null;
        this.assertWorkspaceRootOwner();
        await writeIssueSessionArchiveReceipt(workspaceDir, {
          issueId,
          sourceRevision: prepared.sourceRevision,
          sha256: prepared.sha256,
          archiveId,
        });
        return {
          archiveId,
          sourceRevision: prepared.sourceRevision,
          sha256: prepared.sha256,
        };
      }

      log.debug(`Initializing Issue Session archive for ${issueId}`);
      const initialized = await this.client.initIssueSessionArchive(runtimeId, issueId, {
        sourceRevision: prepared.sourceRevision,
        sha256: prepared.sha256,
        sizeBytes: prepared.sizeBytes,
        fileCount: prepared.fileCount,
        metadata: {
          format: prepared.metadata.format,
          source: sessionArchiveSource,
        },
      });
      log.debug(`Issue Session archive initialized for ${issueId}: status=${initialized.archive.status}`);
      if (initialized.archive.status === "ready") {
        this.assertWorkspaceRootOwner();
        await writeIssueSessionArchiveReceipt(workspaceDir, {
          issueId,
          sourceRevision: prepared.sourceRevision,
          sha256: prepared.sha256,
          archiveId: initialized.archive.id,
        });
        return {
          archiveId: initialized.archive.id,
          sourceRevision: prepared.sourceRevision,
          sha256: prepared.sha256,
        };
      }
      log.debug(`Uploading Issue Session archive for ${issueId}`);
      await this.client.uploadIssueSessionArchive(
        runtimeId,
        issueId,
        initialized.archive.id,
        prepared.archivePath,
      );
      log.debug(`Issue Session archive uploaded for ${issueId}`);
      const completed = await this.client.completeIssueSessionArchive(
        runtimeId,
        issueId,
        initialized.archive.id,
      );
      if (completed.status !== "ready") return null;
      this.assertWorkspaceRootOwner();
      await writeIssueSessionArchiveReceipt(workspaceDir, {
        issueId,
        sourceRevision: prepared.sourceRevision,
        sha256: prepared.sha256,
        archiveId: completed.id,
      });
      return {
        archiveId: completed.id,
        sourceRevision: prepared.sourceRevision,
        sha256: prepared.sha256,
      };
    } finally {
      await removePreparedIssueSessionArchive(prepared.archivePath);
    }
  }

  private shouldDeferIssueSessionArchive(
    issueId: string,
    archive: MultiremiDaemonSessionArchiveWire | null,
  ): boolean {
    if (
      !archive
      || (archive.status !== "pending" && archive.status !== "uploading" && archive.status !== "failed")
    ) return false;
    const retryState = archive.retry_state
      ?? (archive?.retry_exhausted_at
        ? "exhausted"
        : archive?.next_retry_at && archive.next_retry_at > new Date().toISOString()
          ? "backoff"
          : "eligible");
    if (retryState !== "backoff" && retryState !== "exhausted") return false;
    const now = Date.now();
    const logs = this.sessionArchiveRetryLogAt ??= new Map<string, number>();
    const previous = logs.get(issueId) ?? 0;
    if (now - previous >= 60_000) {
      logs.set(issueId, now);
      if (logs.size > 1_000) logs.delete(logs.keys().next().value!);
      log.warn(
        retryState === "exhausted"
          ? `Issue Session archive automatic retries exhausted for ${issueId}; preserving workspace for manual retry`
          : `Issue Session archive retry deferred for ${issueId} until ${archive?.next_retry_at ?? "the server retry window"}`,
      );
    }
    return true;
  }

  restartRequested(): boolean {
    return this.restartRequestedFlag;
  }

  localPort(): number {
    return this.repoServerPort;
  }

  /**
   * All task-scoped reports go through the durable outbox: enqueue is local
   * and effectively instant, delivery happens in per-task order in the
   * background with bounded-backoff retries. A transient API outage therefore
   * never unwinds the agent's provider session.
   */
  private enqueueTaskReport(taskId: string, kind: MultiremiOutboxKind, payload: Record<string, unknown>): void {
    this.ensureOutbox().enqueue(taskId, kind, payload);
  }

  /**
   * Lazily construct the durable outbox. start() opens it eagerly; the lazy
   * path exists for direct handleTask() invocations (tests, one-off harnesses)
   * where no daemon lifecycle is running — those fall back to an in-memory
   * queue when the constructor never resolved a durable path.
   */
  private ensureOutbox(): MultiremiTaskReportOutbox {
    if (!this.outbox) {
      this.outboxAbort ??= new AbortController();
      this.outbox = new MultiremiTaskReportOutbox({
        path: this.outboxPath ?? ":memory:",
        deliver: (record) => this.deliverOutboxRecord(record),
        ...(this.outboxBackoffMs ? { backoffScheduleMs: this.outboxBackoffMs } : {}),
        ...(this.outboxMaxBytes ? { maxBytes: this.outboxMaxBytes } : {}),
      });
    }
    return this.outbox;
  }

  private async awaitTaskReportDrain(taskId: string): Promise<MultiremiOutboxDrainResult> {
    const outbox = this.outbox;
    const drainAbort = new AbortController();
    const shutdownSignal = this.outboxAbort?.signal;
    const onShutdown = () => drainAbort.abort();
    if (shutdownSignal?.aborted) drainAbort.abort();
    else shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      drainAbort.abort();
    }, this.options.taskDrainTimeoutMs);
    timer.unref?.();
    try {
      if (!outbox) return "delivered";
      const result = await outbox.waitForTaskDrain(taskId, drainAbort.signal);
      if (result === "blocked") {
        log.error(`task ${taskId} still has undelivered reports blocked on a permanent error`);
      } else if (result === "aborted" && timedOut) {
        try {
          const status = await this.client.getTaskStatus(taskId);
          if (status === "completed" || status === "failed" || status === "cancelled") {
            const purged = outbox.purgeTask(taskId);
            log.warn(
              `task ${taskId} report delivery exceeded ${this.options.taskDrainTimeoutMs}ms after reaching ${status}; `
              + `discarded ${purged} stale report(s) instead of replaying them indefinitely`,
            );
            return "delivered";
          }
        } catch (error) {
          log.warn(
            `could not reconcile timed-out outbox reports for task ${taskId}; preserving them: `
            + (error instanceof Error ? error.message : String(error)),
          );
        }
        log.warn(
          `task ${taskId} report delivery exceeded ${this.options.taskDrainTimeoutMs}ms; `
          + "continuing while the durable outbox retries in the background",
        );
      } else if (result === "aborted") {
        log.warn(`task ${taskId} report delivery interrupted by shutdown; will replay on next start`);
      }
      return result;
    } finally {
      clearTimeout(timer);
      shutdownSignal?.removeEventListener("abort", onShutdown);
    }
  }

  private async reconcilePendingOutboxTasks(outbox: MultiremiTaskReportOutbox): Promise<void> {
    const terminalTaskIds = outbox.taskIdsWithPendingTerminal();
    const terminalSet = new Set(terminalTaskIds);
    const taskIds = [
      ...terminalTaskIds,
      ...outbox.pendingTaskIds().filter((taskId) => !terminalSet.has(taskId)),
    ];
    let nextIndex = 0;
    const reconcile = async () => {
      while (nextIndex < taskIds.length) {
        const taskId = taskIds[nextIndex++]!;
        try {
          const status = await this.client.getTaskStatus(taskId);
          if (status === "completed" || status === "failed" || status === "cancelled") {
            const purged = outbox.purgeTask(taskId);
            log.debug(`purged ${purged} stale outbox report(s) for terminal task ${taskId} (${status})`);
          }
        } catch (error) {
          if (error instanceof MultiremiDaemonHttpError && error.status === 404) {
            const purged = outbox.purgeTask(taskId);
            log.debug(`purged ${purged} stale outbox report(s) for missing task ${taskId}`);
            continue;
          }
          // Status lookup and delivery use the same control-plane dependency.
          // Preserve unknown tasks so a transient failure cannot lose reports.
          log.warn(
            `could not reconcile persisted outbox task ${taskId}; preserving its reports: `
            + (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(OUTBOX_RECONCILE_CONCURRENCY, taskIds.length) }, () => reconcile()),
    );
  }

  private async flushStartupOutbox(outbox: MultiremiTaskReportOutbox): Promise<void> {
    const terminalTaskIds = outbox.taskIdsWithPendingTerminal();
    const terminalTaskSet = new Set(terminalTaskIds);
    const historicalTaskIds = outbox.pendingTaskIds().filter((taskId) => !terminalTaskSet.has(taskId));
    const flushAbort = new AbortController();
    const shutdownSignal = this.outboxAbort?.signal;
    const onShutdown = () => flushAbort.abort();
    if (shutdownSignal?.aborted) flushAbort.abort();
    else shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      flushAbort.abort();
    }, this.options.outboxStartupFlushTimeoutMs);
    timer.unref?.();
    try {
      await Promise.all(historicalTaskIds.map((taskId) => outbox.waitForTaskDrain(taskId, flushAbort.signal)));
    } finally {
      clearTimeout(timer);
      shutdownSignal?.removeEventListener("abort", onShutdown);
    }
    if (timedOut) {
      log.warn(
        `startup non-terminal outbox replay exceeded ${this.options.outboxStartupFlushTimeoutMs}ms; `
        + "continuing those historical deliveries in the background",
      );
      outbox.pumpAll();
    }

    // Reconciliation removed tasks already terminal on the server. Every
    // remaining local terminal row is therefore authoritative completion or
    // failure evidence for an in-flight server task. Do not let orphan
    // recovery overwrite it, even when ordinary history took too long.
    const terminalResults = await Promise.all(terminalTaskIds.map(async (taskId) => ({
      taskId,
      result: await outbox.waitForTaskDrain(taskId, shutdownSignal),
    })));
    const unsettled = terminalResults.filter(({ result }) => result !== "delivered");
    if (unsettled.length > 0) {
      throw new Error(
        `startup terminal outbox replay did not complete for ${unsettled
          .map(({ taskId, result }) => `${taskId} (${result})`)
          .join(", ")}`,
      );
    }
  }

  /** Outbox → API dispatch. Each call is idempotent server-side (seq upsert / status guards). */
  private async deliverOutboxRecord(record: MultiremiOutboxRecord): Promise<void> {
    const payload = record.payload as Record<string, any>;
    switch (record.kind) {
      case "start":
        await this.client.startTask(record.taskId);
        return;
      case "prompt":
        await this.client.reportTaskPrompt(record.taskId, {
          mode: payload.mode === "delta" ? "delta" : "bootstrap",
          prompt: String(payload.prompt ?? ""),
          sha256: String(payload.sha256 ?? ""),
        });
        return;
      case "session_pin":
        await this.client.pinTaskSession(record.taskId, payload.sessionId ?? null, payload.workDir ?? null);
        return;
      case "progress":
        await this.client.reportProgress(record.taskId, String(payload.summary ?? ""), payload.step, payload.total);
        return;
      case "messages":
        await this.client.reportTaskMessages(record.taskId, Array.isArray(payload.messages) ? payload.messages : []);
        return;
      case "usage":
        await this.client.reportTaskUsage(record.taskId, Array.isArray(payload.usage) ? payload.usage : []);
        return;
      case "workspace":
        await this.client.reportIssueWorkspace(record.taskId, {
          runtimeId: String(payload.runtimeId ?? ""),
          rootPath: String(payload.rootPath ?? ""),
          branchName: String(payload.branchName ?? ""),
          status: payload.status,
          repos: Array.isArray(payload.repos) ? payload.repos : [],
        });
        return;
      case "complete":
        await this.client.completeTask(record.taskId, String(payload.output ?? ""), payload.sessionId ?? null, payload.workDir ?? null);
        return;
      case "fail":
        await this.client.failTask(
          record.taskId,
          String(payload.error ?? "Task failed"),
          payload.sessionId ?? null,
          payload.workDir ?? null,
          payload.failureReason ?? null,
        );
        return;
      default:
        throw new Error(`unknown outbox record kind: ${String(record.kind)}`);
    }
  }

  /** Exposed on the local /health endpoint for observability. */
  outboxStats(): MultiremiOutboxStats | null {
    return this.outbox?.stats() ?? null;
  }

  private tryPauseClaimsForUpdate(scope: MultiremiRuntimeUpdateScope): MultiremiCliUpdatePauseResult {
    if (scope === "cli" && this.cliUpdateCoordinator) {
      return this.cliUpdateCoordinator.tryPauseClaims();
    }
    if (this.claimsPaused || this.activeTaskCount > 0) {
      return { ok: false, error: "daemon is busy; retry update when idle" };
    }
    this.claimsPaused = true;
    return { ok: true };
  }

  private async claimTask(runtimeId: string): Promise<MultiremiTaskWithAgent | null> {
    this.pendingClaimCount++;
    try {
      return await this.client.claimTask(runtimeId) as MultiremiTaskWithAgent | null;
    } finally {
      this.pendingClaimCount--;
    }
  }

  private releaseUpdateClaimPause(scope: MultiremiRuntimeUpdateScope): void {
    if (scope === "cli" && this.cliUpdateCoordinator) {
      this.cliUpdateCoordinator.releaseClaims();
      return;
    }
    this.releaseLocalUpdateClaimPause();
  }

  private releaseLocalUpdateClaimPause(): void {
    if (!this.restartRequestedFlag) this.claimsPaused = false;
  }

  private requestRestartAfterUpdate(): void {
    this.restartRequestedFlag = true;
    this.stop();
    this.onRestartRequested?.();
  }

  private async handleTask(task: MultiremiTaskWithAgent): Promise<void> {
    if (this.activeTaskIds.has(task.id)) {
      log.warn(`Ignored duplicate claim for active task ${task.id}`);
      return;
    }
    this.activeTaskIds.add(task.id);
    this.activeTaskCount++;
    log.info(`Claimed task ${task.id}`);
    const abort = new AbortController();
    this.activeTaskAborts.add(abort);
    let serverTerminalStatus: Extract<MultiremiTaskStatus, "completed" | "failed" | "cancelled"> | null = null;
    const taskStateWatcher = this.watchTaskState(task.id, abort, (status) => {
      serverTerminalStatus = status;
    });
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
    let releaseIssueWorkspaceLifecycle: (() => void) | null = null;
    let progressSummarizer: TaskProgressSummarizer | null = null;
    let activeExecutionReleased = false;
    const awaitFinalReportDrain = async () => {
      if (!activeExecutionReleased) {
        activeExecutionReleased = true;
        this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);
      }
      this.drainingTaskCount++;
      try {
        await this.awaitTaskReportDrain(task.id);
      } finally {
        this.drainingTaskCount = Math.max(0, this.drainingTaskCount - 1);
      }
    };

    try {
      this.assertWorkspaceRootOwner();
      if (task.issueId) {
        // Shared Issue roots and private discussion Session roots have separate
        // lifecycle keys, so each is protected from GC without serializing them
        // against one another.
        const lifecycleKey = task.holdsWorkspace === false
          ? discussionSessionLifecycleKey(task.issueSessionId ?? "")
          : task.issueId;
        releaseIssueWorkspaceLifecycle = await this.issueWorkspaceLifecycleLocks.acquire(lifecycleKey);
        this.assertWorkspaceRootOwner();
        if (task.holdsWorkspace !== false && task.issue?.key) {
          const adopted = await this.topicWorkspaces.preparePendingMigrationForIssue(
            task.issueId,
            task.issue.key,
          );
          if (adopted) log.info(`Adopted pending Feishu topic workspace for ${task.issue.key}`);
        }
      }
      resolvedWorkDir = await this.resolveTaskWorkDir(task, abort.signal);
      const issueRuntimeStateRoot = resolveIssueRuntimeStateRoot(
        task,
        resolvedWorkDir.workDir,
        this.options.workspacesRoot,
        resolvedWorkDir.localDirectory,
      );
      providerHome = resolveTaskProviderHome(task, issueRuntimeStateRoot, this.options.workspacesRoot);
      if (providerHome) {
        // Validate/create every daemon-owned parent before GC metadata, Plugin
        // materialization or provider-native JSONL can write through it.
        await ensureProviderHomeDirectory(providerHome);
      }
      if (task.issueId && task.holdsWorkspace !== false) {
        // Establish the Issue lifecycle before provider setup can create JSONL.
        // This also covers repository-free Issues and preparation failures, so
        // GC can never mistake their history for an unowned directory.
        writeTaskGcContext(issueRuntimeStateRoot, task, {
          localDirectory: resolvedWorkDir.localDirectory,
        });
        const runtimeId = task.runtimeId ?? this.options.runtimeId;
        if (runtimeId) {
          this.enqueueTaskReport(task.id, "workspace", {
            runtimeId,
            rootPath: issueRuntimeStateRoot,
            branchName: task.issue?.issueKind === "intake" ? "" : `agent/${task.issue?.key ?? task.id}`,
            status: "preparing",
            repos: [],
          });
        }
      }
      if (providerHome?.runtimeStateRoot) {
        writeTaskGcContext(
          providerHome.runtimeStateRoot,
          task,
          task.issueId ? { kind: "issue_runtime" } : undefined,
        );
      }
      const workspaceRelay = this.workspaceRelays.get(task.workspaceId);
      const relayAuthoritative = workspaceRelay !== undefined;
      const relay = task.agent?.provider === "claude"
        ? workspaceRelay?.claude
        : task.agent?.provider === "codex"
          ? workspaceRelay?.codex
          : null;
      if (providerHome) {
        providerEnv = await loadIssueSessionProviderEnv(providerHome, {
          ...(relayAuthoritative
            ? {
                relayFragment: relay?.fragment ?? "",
                relayAuthToken: relay?.auth_token ?? "",
              }
            : {}),
        });
        providerInstallEnv = providerBootstrapEnv(task, providerEnv);
        if (
          task.agent?.provider === "codex"
          && relayAuthoritative
          && !providerInstallEnv.OPENAI_API_KEY
        ) {
          await assertIssueSessionNativeCodexOAuth(
            process.env.CODEX_HOME || join(homedir(), ".codex"),
          );
        }
      }
      if (resolveTaskPluginSnapshot(task).length) {
        this.assertWorkspaceRootOwner();
        pluginRuntimeBase = resolveTaskPluginRuntimeBase(
          task,
          providerHome?.root ?? issueRuntimeStateRoot,
          this.options.workspacesRoot,
        );
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
        this.assertWorkspaceRootOwner();
        await prepareIssueSessionProviderHome(providerHome, {
          codexPluginInstalled: task.agent?.provider === "codex" && Boolean(pluginRuntime?.codexHome),
          linkCodexAuth: !providerInstallEnv?.OPENAI_API_KEY,
          linkClaudeCredentials: !providerInstallEnv?.ANTHROPIC_AUTH_TOKEN && !providerInstallEnv?.ANTHROPIC_API_KEY,
          ...(relayAuthoritative ? { relayFragment: relay?.fragment ?? "" } : {}),
          codexRelayUsesEnvApiKey: task.agent?.provider === "codex" && Boolean(providerInstallEnv?.OPENAI_API_KEY),
        });
      }
      this.enqueueTaskReport(task.id, "start", {});
      this.enqueueTaskReport(task.id, "progress", { summary: pickTaskStartupLine(task.agent?.name), step: 1, total: 3 });
      progressSummarizer = await this.createTaskProgressSummarizer(task, providerEnv, relay?.fragment);
      summary = await this.runAgent(task, abort.signal, resolvedWorkDir, pluginRuntime, providerHome, providerEnv, progressSummarizer);
      if (!summary.completed) {
        const failureReason = summary.failureReason
          ?? classifyPoisonedOutput(summary.output)
          ?? TaskFailureReason.AgentFallbackMessage;
        if (summary.usage.length) this.enqueueTaskReport(task.id, "usage", { usage: summary.usage });
        this.enqueueTaskReport(task.id, "fail", {
          error: summary.output,
          sessionId: summary.sessionId,
          workDir: summary.workDir,
          failureReason,
        });
        log.warn(`Failed task ${task.id} with unusable output: ${failureReason}`);
        this.finalizeTaskProgress(progressSummarizer, "failed", failureReason);
        await awaitFinalReportDrain();
        return;
      }
      // Completion itself (progress 3/3, usage, completeTask with the steer
      // barrier) already happened synchronously inside runAgent, while the
      // provider session was still open — only the summarizer wrap-up and the
      // outbox drain remain.
      this.finalizeTaskProgress(progressSummarizer, "completed", summary.output);
      await awaitFinalReportDrain();
    } catch (err) {
      const error = timedOut ? `Agent timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
      if (!timedOut && abort.signal.aborted && serverTerminalStatus) {
        if (serverTerminalStatus === "cancelled") this.outbox?.purgeTask(task.id);
        log.info(`Task ${task.id} is already ${serverTerminalStatus} on the server; stopped local execution`);
        this.finalizeTaskProgress(progressSummarizer, serverTerminalStatus);
        return;
      }
      if (!timedOut && abort.signal.aborted && await this.wasTaskCancelledByServer(task.id)) {
        this.outbox?.purgeTask(task.id);
        log.info(`Task ${task.id} was cancelled by the server`);
        this.finalizeTaskProgress(progressSummarizer, "cancelled");
        return;
      }
      const failureReason = err instanceof LocalDirectoryError
        ? err.failureReason
        : classifyDaemonTaskFailure(task.agent?.provider ?? "", error);
      this.enqueueTaskReport(task.id, "fail", {
        error,
        sessionId: summary?.sessionId ?? task.sessionId,
        workDir: summary?.workDir ?? task.workDir,
        failureReason,
      });
      log.error(`Failed task ${task.id}: ${error}`);
      this.finalizeTaskProgress(progressSummarizer, "failed", error);
      await awaitFinalReportDrain();
    } finally {
      if (pluginRuntimeBase && !task.issueId && !task.chatSessionId) {
        await cleanupNonIssueTaskPluginRuntime(
          task,
          this.options.workspacesRoot,
          () => this.assertWorkspaceRootOwner(),
        ).catch((error) => {
          log.warn(`Failed to clean task Plugin runtime for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      await cleanupTemporaryTaskProviderHome(
        providerHome,
        this.options.workspacesRoot,
        () => this.assertWorkspaceRootOwner(),
      ).catch((error) => {
        log.warn(`Failed to clean task provider home for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
      resolvedWorkDir?.release?.();
      releaseIssueWorkspaceLifecycle?.();
      this.activeTaskAborts.delete(abort);
      this.activeTaskIds.delete(task.id);
      if (!activeExecutionReleased) {
        this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);
      }
      clearInterval(taskStateWatcher);
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
      const baseHome = process.env.CODEX_HOME || join(homedir(), ".codex");
      await installCodexPluginHome(prepared, {
        signal,
        seedHome: (targetHome) => seedCodexHomeFromBase({
          baseHome,
          targetHome,
          requireAuth: !providerEnv?.OPENAI_API_KEY,
          copyAuth: false,
          linkAuth: !providerEnv?.OPENAI_API_KEY,
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
   * only, and only in daemon-owned dirs (never local_directory).
   * An existing worktree is reused as-is so a resumed task keeps uncommitted
   * work, and any failure degrades to the manual-checkout prompt instead of
   * failing the task.
   */
  private async autoCheckoutTaskRepos(
    task: MultiremiTaskWithAgent,
    resolvedWorkDir: ResolvedTaskWorkDir,
    syncResults: MultiremiRepoSyncResult[],
    signal: AbortSignal,
  ): Promise<PreparedIssueWorkspace> {
    const repos = normalizeRepoList(task.repos ?? []);
    const warnings = repoWarningsFromSyncResults(syncResults);
    if (!repos.length || !task.issueId || !resolvedWorkDir.ensureDir || resolvedWorkDir.localDirectory) {
      return { checkouts: [], repos: [], warnings };
    }
    const checkouts: TaskRepoCheckout[] = [];
    const workspaceRepos: MultiremiIssueWorkspaceRepo[] = [];
    const runtimeId = task.runtimeId ?? this.options.runtimeId;
    const branchName = `agent/${task.issue?.key ?? task.id}`;
    if (runtimeId) {
      this.enqueueTaskReport(task.id, "workspace", {
        runtimeId,
        rootPath: resolvedWorkDir.workDir,
        branchName,
        status: "preparing",
        repos: [],
      });
    }
    for (const repo of repos) {
      try {
        const syncResult = syncResults.find((result) => result.repoUrl === repo.url);
        if (syncResult?.status === "failed" && !this.repoCache.lookup(task.workspaceId, repo.url)) {
          throw new Error(syncResult.error ?? "repository sync failed");
        }
        await this.ensureRepoReady(task.workspaceId, repo.url, signal);
        this.assertWorkspaceRootOwner();
        const result = await this.repoCache.createWorktree({
          workspaceId: task.workspaceId,
          repoUrl: repo.url,
          workDir: resolvedWorkDir.workDir,
          agentName: task.agent?.name ?? "agent",
          taskId: task.issue?.key || task.id,
          branchName,
          reuseExisting: true,
          skipFetch: true,
          signal,
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
        signal.throwIfAborted();
        const error = err instanceof Error ? err.message : String(err);
        upsertRepoWarning(warnings, { repoUrl: repo.url, kind: "unavailable", message: error });
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
      this.enqueueTaskReport(task.id, "workspace", {
        runtimeId,
        rootPath: resolvedWorkDir.workDir,
        branchName,
        status: workspaceRepos.some((repo) => repo.status === "error") ? "error" : "in_use",
        repos: workspaceRepos,
      });
    }
    return { checkouts, repos: workspaceRepos, warnings };
  }

  private async prepareTaskWorkspace(
    task: MultiremiTaskWithAgent,
    resolvedWorkDir: ResolvedTaskWorkDir,
    syncResults: MultiremiRepoSyncResult[],
    signal: AbortSignal,
  ): Promise<PreparedIssueWorkspace> {
    if (task.holdsWorkspace === false) return { checkouts: [], repos: [], warnings: [] };
    if (task.issue?.issueKind !== "intake") {
      const prepared = await this.autoCheckoutTaskRepos(task, resolvedWorkDir, syncResults, signal);
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
      this.enqueueTaskReport(task.id, "workspace", {
        runtimeId,
        rootPath: resolvedWorkDir.workDir,
        branchName: "",
        status: "preparing",
        repos: [],
      });
    }
    // Intake prefers a fresh snapshot of every repo, but a refresh failure
    // degrades to the cached (or absent) view with a prompt warning instead of
    // failing the task: triage rarely depends on being at the exact tip.
    const warnings = repoWarningsFromSyncResults(syncResults);
    for (const warning of warnings) {
      log.warn(`Intake workspace degraded for ${task.id}: ${warning.repoUrl} is ${warning.kind === "stale_cache" ? "stale" : "unavailable"}: ${warning.message}`);
    }
    let prepared: PreparedIssueWorkspace;
    try {
      prepared = await prepareIntakeWorkspace(resolvedWorkDir.workDir, task, this.repoCache, {
        snapshotsRoot: join(this.options.workspacesRoot, ".snapshots"),
        skipRepoFetch: true,
        signal,
      });
    } catch (error) {
      if (runtimeId) {
        this.enqueueTaskReport(task.id, "workspace", {
          runtimeId,
          rootPath: resolvedWorkDir.workDir,
          branchName: "",
          status: "error",
          repos: [],
        });
      }
      throw error;
    }
    for (const repo of prepared.repos) {
      if (repo.status !== "error") continue;
      upsertRepoWarning(warnings, {
        repoUrl: repo.repoUrl,
        kind: "unavailable",
        message: repo.error ?? "repository preparation failed",
      });
      log.warn(`Intake snapshot of ${repo.repoUrl} unavailable for ${task.id}: ${repo.error ?? "repository preparation failed"}`);
    }
    if (runtimeId) {
      this.enqueueTaskReport(task.id, "workspace", {
        runtimeId,
        rootPath: resolvedWorkDir.workDir,
        branchName: "",
        status: prepared.repos.some((repo) => repo.status === "error") ? "error" : "in_use",
        repos: prepared.repos,
      });
    }
    return { ...prepared, warnings };
  }

  private async reportIssueWorkspaceAfterRun(
    task: MultiremiTaskWithAgent,
    rootPath: string,
    workspaceRepos: MultiremiIssueWorkspaceRepo[],
  ): Promise<void> {
    const runtimeId = task.runtimeId ?? this.options.runtimeId;
    if (!task.issueId || task.holdsWorkspace === false || !runtimeId) return;
    if (task.issue?.issueKind === "intake") {
      // A degraded intake run keeps its error repos; the final report must not
      // paper over them with "ready" or the workspace status would contradict
      // the per-repo detail it carries.
      this.enqueueTaskReport(task.id, "workspace", {
        runtimeId,
        rootPath,
        branchName: "",
        status: workspaceRepos.some((repo) => repo.status === "error") ? "error" : "ready",
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
    this.enqueueTaskReport(task.id, "workspace", { runtimeId, rootPath, branchName, status, repos });
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
  ): () => void {
    let elicitationContextOffset = 0;
    const humanRequestTimeoutMs = task.autopilotRunId
      ? this.options.unattendedHumanRequestTimeoutMs
      : this.options.humanRequestTimeoutMs;
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
          const settled = await this.awaitHumanDecision(task.id, request.id, signal, humanRequestTimeoutMs);
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
        let context: ElicitationContext | undefined;
        const streamedText = provider.getStreamedText?.(task.id);
        if (typeof streamedText === "string") {
          const sliced = sliceElicitationContext(
            streamedText,
            elicitationContextOffset,
            params.message,
            questions.map(({ question }) => question.question),
          );
          elicitationContextOffset = sliced.offset;
          context = sliced.context;
        }
        const request = await this.client.createTaskHumanRequest(task.id, {
          kind: "question",
          payload: {
            session_id: params.sessionId,
            message: params.message,
            questions,
            ...(context ? { context } : {}),
          },
        });
        await this.reportHumanRequestMessage(task.id, nextSeq(), "question_request", params.message || "Agent asked a question", {
          request_id: request.id,
          questions,
        });
        const settled = await this.awaitHumanDecision(task.id, request.id, signal, humanRequestTimeoutMs);
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

    return () => {
      elicitationContextOffset = 0;
    };
  }

  /**
   * Poll until the request leaves "pending", the task aborts, or the human
   * timeout elapses. Timeout/abort expires the request server-side; if a human
   * response won that race, the server returns the responded row and we honor it.
   */
  private async awaitHumanDecision(
    taskId: string,
    requestId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<MultiremiTaskHumanRequest | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
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
      this.enqueueTaskReport(taskId, "messages", { messages: [{ seq, type, content, input }] });
    } catch (err) {
      log.warn(`Failed to report ${type} message for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Per-task LLM progress summarizer (MUL-67). Reuses the task's provider
   * credentials for Anthropic transports or a dedicated OpenAI-compatible
   * config; returns null when disabled or no selected transport can authenticate.
   */
  private async createTaskProgressSummarizer(
    task: MultiremiTaskWithAgent,
    providerEnv?: Record<string, string>,
    relayFragment?: string,
  ): Promise<TaskProgressSummarizer | null> {
    try {
      const workspacePolicy = resolveWorkspaceProgressSummaryPolicy(
        this.workspaceSettings.get(task.workspaceId),
      );
      const config = await resolveTaskProgressSummaryConfig(
        providerEnv,
        process.env,
        undefined,
        workspacePolicy,
        (task.agent?.provider === "codex" || task.agent?.provider === "claude")
          && relayFragment !== undefined
          ? { engine: task.agent.provider, fragment: relayFragment }
          : undefined,
      );
      if (!config.enabled) return null;
      const credentials = resolveSummarizerCredentials(providerEnv);
      const hasOpenAiTransport = (config.transport === "auto" || config.transport === "openai")
        && config.openAi !== null;
      if (!credentials && !hasOpenAiTransport) {
        log.info(`Progress summaries unavailable for task ${task.id}: no usable model credential`);
        return null;
      }
      return new TaskProgressSummarizer({
        config,
        credentials: credentials ?? undefined,
        providerEnv,
        taskTitle: task.issue?.title ?? task.triggerSummary ?? "",
        taskPrompt: task.prompt ?? "",
        report: async (result, { final }) => {
          await this.client.reportProgress(task.id, result.summary, result.step, result.total, { final });
        },
      });
    } catch (err) {
      log.warn(`Progress summarizer setup failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Terminal summary, detached from the task lifecycle — never blocks or fails it. */
  private finalizeTaskProgress(
    summarizer: TaskProgressSummarizer | null,
    outcome: ProgressRunOutcome,
    detail?: string,
  ): void {
    summarizer?.finalize(outcome, detail).catch((err) => {
      log.warn(`Final progress summary failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async runAgent(
    task: MultiremiTaskWithAgent,
    signal: AbortSignal,
    resolvedWorkDir: ResolvedTaskWorkDir,
    pluginRuntime?: PreparedAgentPluginRuntime,
    providerHome?: IssueSessionProviderHome | null,
    providerEnv?: Record<string, string>,
    progressSummarizer?: TaskProgressSummarizer | null,
  ): Promise<RunSummary> {
    this.assertWorkspaceRootOwner();
    const agent = task.agent;
    if (!agent) throw new Error(`Task ${task.id} has no agent`);
    if (agent.provider !== "claude" && agent.provider !== "codex") {
      throw new Error(`Unsupported Bun Multiremi provider: ${agent.provider}`);
    }

    const workDir = resolvedWorkDir.workDir;
    // Only create dirs the daemon owns. local_directory paths are validated
    // separately and carry ensureDir=false.
    if (resolvedWorkDir.ensureDir) mkdirSync(workDir, { recursive: true });
    // Homepage Chat starts from the safe database directory and performs Git
    // work only through an explicit `remi repo checkout`. Keep Issue task repo
    // preparation unchanged, including for any task that also carries Chat
    // metadata but is anchored to an Issue workspace.
    const homepageChat = Boolean(task.chatSessionId && !task.issueId);
    const repoSyncResults = homepageChat || task.holdsWorkspace === false
      ? []
      : await this.registerTaskRepos(task.workspaceId, task.repos ?? [], signal);
    const preparedWorkspace = await this.prepareTaskWorkspace(task, resolvedWorkDir, repoSyncResults, signal);
    this.assertWorkspaceRootOwner();
    try {
      writeTaskContext(workDir, task);
      writeTaskGcContext(workDir, task, { localDirectory: resolvedWorkDir.localDirectory });
      writeProjectResourceContext(workDir, task);
      writeAgentSkillContext(workDir, task);
    } catch (err) {
      log.warn(`Failed to write task context for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (task.sessionId || workDir) {
      this.enqueueTaskReport(task.id, "session_pin", { sessionId: task.sessionId, workDir });
    }

    // Assemble config via AgentRuntime
    const runtime = new AgentRuntime();
    const ctx: EphemeralContext = {
      kind: "ephemeral",
      task,
      daemonOptions: {
        daemonPort: this.repoServerPort,
        serverUrl: this.options.serverUrl,
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
      args: config.customArgs,
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
    let sawCompaction = false;
    let seq = 1;
    const nextSeq = () => seq++;
    let messageBatcher: TaskMessageBatcher | null = null;
    const nextExternalSeq = () => {
      // Human-request and steer messages use a separate producer. Flush ACP
      // chunks first so their durable record and sequence stay chronological.
      messageBatcher?.flush();
      return nextSeq();
    };
    const resetElicitationContextOffset = this.attachHumanInputHandlers(provider, task, signal, nextExternalSeq);
    let finalSessionId: string | null = task.sessionId;
    let usage: TaskUsageEntry[] = [];
    const toMessages = createEventMapper(createAdapter(config.agentType));
    messageBatcher = new TaskMessageBatcher({
      emit: (messages) => {
        const sequenced = messages.map((message) => ({ ...message, seq: nextSeq() }));
        this.enqueueTaskReport(task.id, "messages", { messages: sequenced });
        progressSummarizer?.onMessages(sequenced);
      },
    });

    // Steer channel: the feed polls for mid-run user directives; each batch
    // soft-interrupts the streaming turn (ACP session/cancel) and is injected
    // as the next prompt on the same provider session, so the transcript and
    // all completed work survive. `force_answer` additionally arms a grace
    // deadline after which the run wraps up with the output produced so far.
    const steerFeed = new TaskSteerFeed(this.client, task.id, this.options.steerPollIntervalMs, (err) => {
      log.warn(`Steer poll failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
    let forceAnswerDeadline: number | null = null;
    let forceAnswerExpired = false;

    try {
      const session = new AgentSession(provider as any, config);
      const promptArtifact = buildTaskPromptArtifact(task, {
        repoCheckouts: preparedWorkspace.checkouts,
        repoWarnings: preparedWorkspace.warnings,
      });
      this.enqueueTaskReport(task.id, "prompt", {
        mode: promptArtifact.mode,
        prompt: promptArtifact.prompt,
        sha256: promptArtifact.sha256,
      });
      signal.throwIfAborted();
      steerFeed.start();
      let prompt = promptArtifact.prompt;

      // Every steer batch flows through here exactly once (injected into the
      // next turn, or — after the force-answer grace elapsed — recorded and
      // consumed without injection so completion can proceed).
      const recordedSteerIds = new Set<string>();
      const recordSteerBatch = async (messages: MultiremiTaskSteerMessage[], injected: boolean): Promise<void> => {
        for (const message of messages) recordedSteerIds.add(message.id);
        // Immunize the feed against its own in-flight poll: a GET that was
        // already on the wire when these ids were handled must not re-enqueue
        // them, or the stale duplicate would trip the next turn's interrupt.
        steerFeed.markHandled(messages.map((m) => m.id));
        await this.client.consumeTaskSteerMessages(task.id, messages.map((m) => m.id)).catch((err) => {
          log.warn(`Failed to mark steer consumed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
        });
        for (const message of messages) {
          await this.reportHumanRequestMessage(task.id, nextExternalSeq(), "steer", message.content, {
            steer_id: message.id,
            steer_kind: message.kind,
            author_type: message.authorType,
            author_id: message.authorId,
            injected,
          });
        }
      };
      const injectSteerBatch = async (messages: MultiremiTaskSteerMessage[]): Promise<void> => {
        if (messages.some((m) => m.kind === "force_answer") && forceAnswerDeadline == null) {
          forceAnswerDeadline = Date.now() + Math.max(0, this.options.forceAnswerGraceMs);
        }
        prompt = buildSteerInjectionPrompt(messages);
        await recordSteerBatch(messages, true);
        log.info(`Injected ${messages.length} steer message(s) into task ${task.id}`);
      };
      // Authoritative server read; a swallowed error here is safe because the
      // completeTask steer barrier still refuses to strand a pending steer.
      const fetchPendingSteer = async (): Promise<MultiremiTaskSteerMessage[]> => {
        try {
          const pending = await this.client.listPendingTaskSteerMessages(task.id);
          return pending.filter((m) => !recordedSteerIds.has(m.id));
        } catch (err) {
          log.warn(`Pending-steer check failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      };

      while (true) {
        const turnAbort = new AbortController();
        const onTaskAbort = () => turnAbort.abort();
        signal.addEventListener("abort", onTaskAbort, { once: true });
        if (signal.aborted) turnAbort.abort();
        config.signal = turnAbort.signal;
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        if (forceAnswerDeadline != null) {
          graceTimer = setTimeout(() => {
            forceAnswerExpired = true;
            turnAbort.abort();
          }, Math.max(0, forceAnswerDeadline - Date.now()));
        }
        steerFeed.setInterrupt(() => turnAbort.abort());
        let turnError: unknown = null;
        try {
          resetElicitationContextOffset();
          for await (const event of session.run(prompt)) {
            const emitted = toMessages(event);
            for (const message of emitted) {
              if (message.type === "compaction") sawCompaction = true;
              // Assistant text becomes the task result / issue activity body.
              if (message.type === "text" && message.content) output += message.content;
            }
            // The front buffer coalesces token chunks for up to 200ms while
            // tool/lifecycle boundaries flush immediately. Delivery remains
            // enqueue-only, so a transient API outage never closes the provider.
            messageBatcher.push(emitted);
          }
        } catch (err) {
          turnError = err;
        } finally {
          messageBatcher.flush();
          steerFeed.setInterrupt(null);
          signal.removeEventListener("abort", onTaskAbort);
          if (graceTimer) clearTimeout(graceTimer);
        }
        const last = provider.getLastResponse?.() as AgentResponse | null | undefined;
        finalSessionId = last?.sessionId ?? finalSessionId;
        usage = mergeTaskUsageEntries(usage, responseToUsage(agent.provider, last, config.model));
        // Resume by provider session id if the follow-up turn needs a fresh
        // ACP process (e.g. the previous one died between turns).
        if (finalSessionId) config.sessionId = finalSessionId;
        if (signal.aborted) throw (turnError ?? new Error("Cancelled"));
        const steered = steerFeed.take().filter((m) => !recordedSteerIds.has(m.id));
        if (turnError && !turnAbort.signal.aborted) throw turnError;
        if (forceAnswerExpired) {
          log.warn(`Task ${task.id} force-answer grace elapsed; delivering accumulated output`);
          // Steers that arrived too late to act on are still recorded/consumed
          // so the audit trail is complete and completion is not blocked.
          if (steered.length) await recordSteerBatch(steered, false);
        } else {
          if (steered.length) {
            await injectSteerBatch(steered);
            continue;
          }
          if (turnError) throw turnError;
          // The turn ended naturally. A steer accepted by the server but not
          // yet seen by the 2.5s poll must not be stranded: check once more
          // before trying to finish.
          const pending = await fetchPendingSteer();
          if (pending.length) {
            await injectSteerBatch(pending);
            continue;
          }
        }

        // Finalize while the provider session is still open, so a steer that
        // races completion (completeTask steer barrier → 409 steer_pending)
        // can still be injected as another turn instead of failing the run.
        if (!output.trim() && !(last?.text ?? "").trim() && sawCompaction) {
          await this.client.pinTaskSession(task.id, finalSessionId, workDir);
          return {
            output: "Agent returned empty output after compaction.",
            sessionId: finalSessionId,
            workDir,
            usage,
            completed: false,
            failureReason: TaskFailureReason.AgentEmptyOrUnparseableOutput,
          };
        }
        const candidate = output.trim() || last?.text || "Task completed.";
        if (classifyPoisonedOutput(candidate)) {
          await this.client.pinTaskSession(task.id, finalSessionId, workDir);
          return { output: candidate, sessionId: finalSessionId, workDir, usage, completed: false };
        }
        await this.client.pinTaskSession(task.id, finalSessionId, workDir);
        // Flush the outbox before flipping the task terminal: a queued
        // "progress" record delivered after completion would be rejected by
        // the server's terminal-status guard and wedge the outbox.
        await this.awaitTaskReportDrain(task.id);
        await this.client.reportProgress(task.id, "Agent execution completed", 3, 3);
        await this.client.reportTaskUsage(task.id, usage);
        try {
          await this.client.completeTask(task.id, candidate, finalSessionId, workDir);
        } catch (err) {
          if (!isSteerPendingConflict(err)) throw err;
          const pendingNow = await this.client.listPendingTaskSteerMessages(task.id).catch(() => [] as MultiremiTaskSteerMessage[]);
          // Already-recorded ids still pending mean an earlier consume call
          // failed (e.g. transient network) — retry it so the barrier lifts,
          // instead of letting an ignorable consume error become a terminal
          // completion conflict.
          const stale = pendingNow.filter((m) => recordedSteerIds.has(m.id));
          if (stale.length) await this.client.consumeTaskSteerMessages(task.id, stale.map((m) => m.id));
          const fresh = pendingNow.filter((m) => !recordedSteerIds.has(m.id));
          if (!forceAnswerExpired && fresh.length) {
            await injectSteerBatch(fresh);
            continue;
          }
          // Force-answer wrap-up (or an inconsistent conflict): record what's
          // there and complete once more; a second conflict fails the run
          // loudly rather than looping forever.
          if (fresh.length) await recordSteerBatch(fresh, false);
          await this.client.completeTask(task.id, candidate, finalSessionId, workDir);
        }
        log.info(`Completed task ${task.id}`);
        return { output: candidate, sessionId: finalSessionId, workDir, usage, completed: true };
      }
    } finally {
      messageBatcher?.close();
      steerFeed.stop();
      await this.reportIssueWorkspaceAfterRun(task, workDir, preparedWorkspace.repos).catch((err) => {
        log.warn(`Failed to report final workspace state for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
      await provider.close?.();
    }
  }

  private watchTaskState(
    taskId: string,
    abort: AbortController,
    onTerminal: (status: Extract<MultiremiTaskStatus, "completed" | "failed" | "cancelled">) => void,
  ): ReturnType<typeof setInterval> {
    let checking = false;
    const check = async () => {
      if (abort.signal.aborted || checking) return;
      checking = true;
      try {
        let status = await this.client.getTaskStatus(taskId);
        if (status === "dispatched") {
          status = await this.client.renewTaskDispatchLease(taskId);
        }
        if (status === "completed" || status === "failed" || status === "cancelled") {
          onTerminal(status);
          if (status === "cancelled") this.outbox?.purgeTask(taskId);
          abort.abort();
        }
      } catch (error) {
        if (error instanceof MultiremiDaemonHttpError && error.status === 404) {
          abort.abort();
        }
      } finally {
        checking = false;
      }
    };
    return setInterval(() => void check(), 2500);
  }

  private async wasTaskCancelledByServer(taskId: string): Promise<boolean> {
    try {
      return await this.client.getTaskStatus(taskId) === "cancelled";
    } catch (err) {
      return err instanceof MultiremiDaemonHttpError && err.status === 404;
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
    if (this.options.gcIntervalMs <= 0) return;
    // Do not burst synchronous repository inspections into the startup path.
    // Registration and Plugin preflight also launch provider child processes;
    // the first GC runs on the normal interval after the daemon is fully ready.
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

  private async drainGcInFlight(): Promise<void> {
    const gcRun = this.gcInFlight;
    if (gcRun) await Promise.allSettled([gcRun]);
  }

  private async handleLocalDaemonRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return this.handleHealthRequest(request);
    if (url.pathname === "/shutdown") return this.handleShutdownRequest(request);
    if (url.pathname === "/topic/migrate") return this.handleTopicMigrationRequest(request);
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
      this.assertWorkspaceRootOwner();
      await this.ensureRepoReady(workspaceId, repoUrl, request.signal);
      this.assertWorkspaceRootOwner();
      const result = await this.repoCache.createWorktree({
        workspaceId,
        repoUrl,
        workDir,
        ref: stringField(body.ref) ?? undefined,
        agentName: stringField(body.agent_name ?? body.agentName) ?? "agent",
        taskId: stringField(body.task_id ?? body.taskId) ?? "task",
        signal: request.signal,
        coAuthoredByEnabled: this.workspaceCoAuthoredByEnabled(workspaceId),
      });
      return jsonResponse(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: message }, message.includes("not configured") ? 400 : 500);
    }
  }

  private async handleTopicMigrationRequest(request: Request): Promise<Response> {
    if (this.terminalAuthorityMode) {
      return jsonResponse({ error: "daemon is in terminal cleanup-only mode" }, 503);
    }
    if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch (error) {
      return jsonResponse({ error: `invalid request body: ${error instanceof Error ? error.message : String(error)}` }, 400);
    }
    const action = stringField(body.action);
    const cwd = stringField(body.cwd);
    if (!action) return jsonResponse({ error: "action is required" }, 400);
    if (!cwd && action !== "resume") return jsonResponse({ error: "cwd is required" }, 400);
    try {
      this.assertWorkspaceRootOwner();
      let result: PreparedTopicMigration | CommittedTopicMigration | { cancelled: true };
      if (action === "prepare") {
        result = await this.topicWorkspaces.prepareMigration(cwd!);
      } else if (action === "cancel") {
        const migrationId = stringField(body.migration_id ?? body.migrationId);
        if (!migrationId) return jsonResponse({ error: "migration_id is required" }, 400);
        await this.topicWorkspaces.cancelPreparedMigration(cwd!, migrationId);
        result = { cancelled: true };
      } else if (action === "commit") {
        const migrationId = stringField(body.migration_id ?? body.migrationId);
        const issueId = stringField(body.issue_id ?? body.issueId);
        const issueKey = stringField(body.issue_key ?? body.issueKey);
        if (!migrationId) return jsonResponse({ error: "migration_id is required" }, 400);
        if (!issueId) return jsonResponse({ error: "issue_id is required" }, 400);
        if (!issueKey) return jsonResponse({ error: "issue_key is required" }, 400);
        result = await this.topicWorkspaces.commitMigration({ cwd: cwd!, migrationId, issueId, issueKey });
      } else if (action === "resume") {
        const issueId = stringField(body.issue_id ?? body.issueId);
        const issueKey = stringField(body.issue_key ?? body.issueKey);
        if (!issueId) return jsonResponse({ error: "issue_id is required" }, 400);
        if (!issueKey) return jsonResponse({ error: "issue_key is required" }, 400);
        result = await this.topicWorkspaces.resumeMigration({ cwd: cwd ?? undefined, issueId, issueKey });
      } else {
        return jsonResponse({ error: "action must be prepare, commit, resume, or cancel" }, 400);
      }
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  }

  private handleHealthRequest(request: Request): Response {
    if (request.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);
    const cleanupSupport = ownedDirectoryRemovalSupport();
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
      supervisor_ready: this.supervisorReady(),
      active_task_count: this.activeTaskCount,
      draining_task_count: this.drainingTaskCount,
      daemon_port: this.repoServerPort,
      workspace_cleanup_capability: cleanupSupport.capability,
      workspace_cleanup_error: cleanupSupport.error,
      restart_requested: this.restartRequestedFlag,
      claims_paused_by_drain: this.serverDrainActive,
      drain_ack_generation: this.appliedDrainGeneration,
      outbox: this.outboxStats(),
    });
  }

  private handleShutdownRequest(request: Request): Response {
    if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
    setTimeout(() => {
      this.stop();
    }, 10);
    return jsonResponse({ status: "shutting_down" });
  }

  private async refreshWorkspaceRepos(workspaceId: string | null): Promise<void> {
    if (!workspaceId) return;
    try {
      const response = await this.client.getWorkspaceRepos(workspaceId);
      this.assertWorkspaceRootOwner();
      this.workspaceRepoUrls.set(workspaceId, new Set(response.repos.map((repo) => repo.url.trim()).filter(Boolean)));
      this.applyWorkspaceSettings(workspaceId, response.settings ?? {});
      this.workspaceRelays.set(workspaceId, response.relay);
    } catch (err) {
      log.warn(`Workspace repo sync failed for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private assertWorkspaceRootOwner(): void {
    if (!this.workspaceRootFence) return;
    try {
      this.workspaceRootFence();
    } catch (error) {
      this.stopForWorkspaceOwnershipLoss(error);
      throw error;
    }
  }

  private applyWorkspaceSettings(workspaceId: string, settings: Record<string, unknown>): void {
    this.workspaceSettings.set(workspaceId, settings);
    if (workspaceId !== (this.options.workspaceId ?? "local")) return;
    const policy = resolveWorkspaceGcPolicy(settings, this.defaultGcPolicy);
    const intervalChanged = policy.intervalMs !== this.options.gcIntervalMs;
    const ttlChanged = policy.ttlMs !== this.options.gcTtlMs;
    if (!intervalChanged && !ttlChanged) return;
    this.options.gcTtlMs = policy.ttlMs;
    this.options.gcIntervalMs = policy.intervalMs;
    log.info(`Workspace GC policy applied: ttl=${policy.ttlMs}ms interval=${policy.intervalMs}ms`);
    if (intervalChanged && this.gcTimer) {
      this.stopGcLoop();
      this.startGcLoop();
    }
  }

  private async registerTaskRepos(
    workspaceId: string,
    repos: MultiremiRepoData[],
    signal?: AbortSignal,
  ): Promise<MultiremiRepoSyncResult[]> {
    const normalized = normalizeRepoList(repos);
    if (!normalized.length) return [];
    const allowed = this.workspaceRepoUrls.get(workspaceId) ?? new Set<string>();
    for (const repo of normalized) allowed.add(repo.url);
    this.workspaceRepoUrls.set(workspaceId, allowed);
    try {
      this.assertWorkspaceRootOwner();
      const results = await this.repoCache.sync(workspaceId, normalized, { signal });
      for (const result of results) {
        if (result.status !== "fresh") {
          log.warn(`Task repo ${result.status} for ${workspaceId}: ${result.repoUrl}: ${result.error ?? "unknown error"}`);
        }
      }
      return results;
    } catch (err) {
      log.warn(`Task repo sync failed for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
      signal?.throwIfAborted();
      return normalized.map((repo) => ({
        repoUrl: repo.url,
        status: "failed" as const,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  private async ensureRepoReady(workspaceId: string, repoUrl: string, signal?: AbortSignal): Promise<void> {
    if (!this.isRepoAllowed(workspaceId, repoUrl)) {
      await this.refreshWorkspaceRepos(workspaceId);
    }
    if (!this.isRepoAllowed(workspaceId, repoUrl)) {
      throw new Error(`repo not configured for workspace: ${repoUrl}`);
    }
    if (!this.repoCache.lookup(workspaceId, repoUrl)) {
      this.assertWorkspaceRootOwner();
      const [result] = await this.repoCache.sync(workspaceId, [{ url: repoUrl }], { signal });
      if (result?.status === "failed") throw new Error(result.error ?? `repo sync failed: ${repoUrl}`);
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

/** completeTask refused because an unconsumed steer won the race (server steer barrier). */
function isSteerPendingConflict(err: unknown): boolean {
  return err instanceof MultiremiDaemonHttpError && err.status === 409 && err.code === "steer_pending";
}
