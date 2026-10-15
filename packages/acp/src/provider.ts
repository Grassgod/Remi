/**
 * AcpProvider — implements Remi's Provider interface using ACP protocol.
 * Yields raw ACP SessionUpdate events directly (no translation layer).
 * Agent-specific behavior (Claude/Codex) is delegated to adapters.
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import type {
  Provider,
  SendOptions,
  AgentResponse,
  ListenAutonomousOptions,
  ProviderEvent,
  SteerOutcome,
  SteerResult,
} from "@shared/contracts/provider-types.js";
import { createAgentResponse, STEER_REASONS } from "@shared/contracts/provider-types.js";
import { TRACE_STEER_OUTCOMES } from "@shared/contracts/trace.js";
import { readContextUsage, type ContextUsage } from "@shared/agent-execution.js";
import { UsageCollector } from "./usage-collector.js";
import { beginCodexRolloutUsage, codexHomeFor, collectCodexRolloutUsage, type CodexRolloutCursor } from "./codex-rollout-usage.js";
import type { TaskUsageUnit } from "@shared/contracts/usage-accounting.js";
import { AcpClient } from "./client.js";
import { AcpRpcError, AcpSessionFailureError, airMetadata, readSessionFailure, redactProviderError, redactProviderErrorText, record, type AcpSessionFailure } from "./session-failure.js";
import { resolveAcpProcessLaunch } from "./launch.js";
import { createAdapter, type AgentAdapter } from "./adapters/index.js";
import { resolveClaudeContextSelection, hasOneMillionContext } from "./adapters/claude-code/model-context.js";
import { autonomousOrigin, isWorkspaceTrustPrompt, nativeAgentId, permissionAsQuestion, serviceMessage, serviceMessageFailure, type PermissionQuestion } from "./adapters/trace-vendor.js";
import { accessConfigFor, type AcpAccessConfig } from "./access/index.js";
import type { GatewayShimChannel, GatewayShimEvent, GatewayShimHost, GatewayShimListingFailure } from "./access/gateway-shim-types.js";
import { GEMINI_USAGE_SOURCE, geminiObservationUsage } from "./gemini-request-usage.js";
import type {
  SessionNotification,
  SessionUpdate,
  RequestPermissionParams,
  PermissionOutcome,
  ElicitationCreateParams,
  ElicitationResult,
  PromptResult,
  UsageUpdate,
  SessionModeState,
  SessionModelState,
  SessionConfigOption,
  SessionConfigSelectOption,
  McpServerConfig,
  NewSessionMeta,
  NewSessionResult,
  PromptUsageSettleScope,
  SteerResponse,
} from "@shared/contracts/acp-protocol.js";

export interface AcpProviderOptions {
  /** Internal capability probes keep descendants inside the supervisor's process group. */
  inheritProcessGroup?: boolean;
  /** Agent type: "claude" | "codex" (default: "claude"). */
  agentType?: string;
  /** ACP executable path (auto-detected from agentType if omitted). */
  executable?: string;
  /** Arguments placed after the ACP executable. */
  args?: string[];
  /** Optional API key forwarded to compatible ACP wrappers. */
  apiKey?: string;
  /** Optional API base URL forwarded to compatible ACP wrappers. */
  baseUrl?: string;
  /** Default model. */
  model?: string | null;
  /** Administrator-declared Claude gateway models using the 1M context window. */
  claudeOneMillionModels?: readonly string[];
  /** Default timeout in seconds. */
  timeout?: number;
  /** Tools to allow. */
  allowedTools?: string[];
  /** Working directory. */
  cwd?: string;
  /**
   * Daemon-owned directory bound to this task execution. Linux mounts it as the
   * literal /tmp; macOS (MUL-449) exports it through TMPDIR/TMP/TEMP instead.
   */
  privateTmpDirectory?: string;
  /** Platform override for the private-/tmp contract (test injection). */
  privateTmpPlatform?: NodeJS.Platform;
  /** Inject MCP servers at construction time (ACP wire shape — see {@link McpServerConfig}). */
  getMcpServers?: () => McpServerConfig[];
  /** Extra environment variables for the spawned ACP process. */
  env?: Record<string, string>;
  /** Non-secret Claude routing settings, passed through the maintained ACP bridge. */
  claudeSettings?: { model: string; env: Record<string, string> };
  /** Provider-native Plugin roots. Ephemeral callers normally pass these per send. */
  pluginPaths?: string[];
  /** Exact Plugin-set fingerprint; a change forces a fresh ACP process/session. */
  pluginFingerprint?: string;
  /** Isolated home used only for Codex Plugin execution. */
  codexHome?: string;
  /**
   * Session (lane) provider home, for agents whose access config derives the
   * agent home from it (Antigravity: `GEMINI_HOME`).
   */
  providerHome?: string;
  /** The run's loopback gateway shim; one channel per ACP process. In-process only, never serialized. */
  gatewayShim?: GatewayShimHost;
  /** A shim base URL without usage observations, for subprocess model probes that cannot hold a host. */
  gatewayUrl?: string;
  /**
   * Stall watchdog bound for access configs that declare one (Antigravity:
   * 120 s). Tests shorten it; production leaves it unset.
   */
  turnStallTimeoutMs?: number;
  /** How long a native steer may take before it falls back (default 30 s; tests shorten it). */
  steerTimeoutMs?: number;
  /** How long a steer waits for running top-level tool calls (default 30 s; tests shorten it). */
  toolCallWaitMs?: number;
  /** How long a bridge `promptRequired` during our prompt is retried (default 10 s; tests shorten it). */
  steerRetryWindowMs?: number;
  /**
   * Ask the bridge for native child sessions (PR 5 §1.1), when the adapter
   * declares them. Each subagent's frames then arrive on its own session and
   * are passed on stamped with `_meta.remiSessionId`. Default off.
   */
  nativeSubagentSessions?: boolean;
  /**
   * Keep every frame that arrives between prompts, not only usage, so
   * {@link AcpProvider.listenAutonomous} can replay an autonomous round that
   * started before anyone listened (PR 5 §2.3). Only for adapters that declare
   * `autonomousRounds` (Claude). Default off.
   */
  captureAutonomousRounds?: boolean;
  /** Once an autonomous round's frames flow, how long it may run without its result (default 10 min; tests shorten it). */
  autonomousRoundCapMs?: number;
}

/** ACP-local SendOptions extension kept out of the provider-neutral contract. */
export interface AcpAgentPluginSendOptions {
  pluginPaths?: string[];
  pluginFingerprint?: string;
  codexHome?: string;
}

export interface AcpModelEffortCapability {
  /** Missing selectors are unknown; an advertised empty selector is unsupported. */
  status?: "supported" | "unsupported" | "unknown" | "error";
  /** Concrete default reported after selecting this model, if available. */
  defaultLevel?: string;
  supportedLevels: Array<{
    value: string;
    label: string;
    description?: string;
  }>;
}

/** One model and its model-specific effort values, discovered from ACP. */
export interface AcpModelCapability {
  id: string;
  label: string;
  description?: string;
  default: boolean;
  /** The bridge's default selector state, not a guessed concrete model. */
  providerDefault?: boolean;
  effort?: AcpModelEffortCapability;
}

/** Codex cannot run an explicitly selected model on a different, previously active model. */
export class UnsupportedAcpModelError extends Error {
  readonly code = "acp_model_unsupported";

  constructor(
    readonly agentType: string,
    readonly model: string,
    readonly supportedModels: string[],
    readonly selectedModel?: string | null,
  ) {
    super(`[acp_model_unsupported] ${agentType}: cannot select model "${model}" ` +
      `(selected: ${selectedModel ?? "unknown"}; available: ${supportedModels.join(", ") || "none"})`);
    this.name = "UnsupportedAcpModelError";
  }
}

/** A caller explicitly requested an effort value the selected model does not advertise. */
export class UnsupportedAcpEffortError extends Error {
  readonly code = "acp_effort_unsupported";

  constructor(
    readonly agentType: string,
    readonly model: string | null,
    readonly effort: string,
    readonly supportedEfforts: string[],
  ) {
    const modelText = model ? `model "${model}"` : "the current model";
    const available = supportedEfforts.length ? supportedEfforts.join(", ") : "none";
    super(
      `[acp_effort_unsupported] ${agentType}: effort "${effort}" is not supported by ${modelText} ` +
        `(available: ${available})`,
    );
    this.name = "UnsupportedAcpEffortError";
  }
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const PROMPT_CANCEL_SETTLE_MS = 5_000;
/** The server's own text after a `session/cancel` (server 1.4.0), not the model's. */
const CANCELLED_BY_CLIENT_TEXT = "The request was cancelled by the client.";
/** How long a prompt waits for its last gateway-shim observations before settling usage. */
const GATEWAY_SETTLE_MS = 2_000;
/** After cutting the calls still open at prompt end, how long their (aborted) observations may take. */
const GATEWAY_ABORT_SETTLE_MS = 500;
/** Codex appends a turn's last rollout records just after the prompt resolves. */
const CODEX_ROLLOUT_SETTLE_MS = 1_000;
/** A native steer that has not answered by then falls back to interrupt + re-prompt (ADR 0020). */
const STEER_TIMEOUT_MS = 30_000;
/** How long a steer waits for running top-level tool calls before interrupt + re-prompt. */
const STEER_TOOL_CALL_WAIT_MS = 30_000;
/** A bridge `promptRequired` while our prompt runs is retried this long, at most this often. */
const STEER_RETRY_WINDOW_MS = 10_000;
const STEER_MAX_ATTEMPTS = 5;
const NO_ACTIVE_PROMPT: SteerResult = { outcome: "promptRequired", reason: STEER_REASONS.noActivePrompt };
/** A cancelled bridge-started turn counts as settled after this long without a session/update. */
const STEER_QUIET_MS = 500;
/** Usage frames kept between prompts for billing replay; the oldest are dropped first. */
const MAX_IDLE_USAGE_FRAMES = 1_000;
/** Frames kept between prompts while capturing autonomous rounds (PR 5 §2.3); the oldest non-usage frame goes first. */
const MAX_AUTONOMOUS_FRAMES = 2_000;
const MAX_AUTONOMOUS_BYTES = 4 * 1024 * 1024;
/** How long `listenAutonomous` waits for an autonomous round's first frame by default. */
const AUTONOMOUS_IDLE_MS = 60_000;
/** Once a round's frames flow, the longest it may run before the listen gives up (Codex's own child wait). */
const AUTONOMOUS_HARD_CAP_MS = 10 * 60 * 1000;
/** Unknown session ids logged per pool entry, at most. */
const MAX_LOGGED_UNKNOWN_SESSIONS = 32;
const DEFAULT_PERMISSION_MODE_BY_AGENT: Record<string, string | null> = {
  claude: "bypassPermissions",
  // codex advertises read-only/agent/agent-full-access, so the literal id is
  // meaningless to it — CodexAdapter.mapPermissionMode translates this to
  // `agent-full-access`. Without an entry here an unconfigured codex chat
  // stayed in codex's own initial mode and prompted for every tool call.
  codex: "bypassPermissions",
};
const REMI_CLAUDE_AGENT_ACP_WRAPPER = "remi-claude-agent-acp";

/**
 * `category` values the two bridges use for the model and effort selectors.
 * Reading the category rather than the id keeps one code path for both:
 * claude-agent-acp uses ids `model`/`effort` (dist/acp-agent.js:5110, 5142)
 * while codex-acp uses `model`/`reasoning_effort` (dist/index.js:27151-27152),
 * but both tag them `model` and `thought_level` (acp-agent.js:5113, 5145;
 * index.js:27177, 27188).
 */
const MODEL_OPTION_CATEGORY = "model";
const EFFORT_OPTION_CATEGORY = "thought_level";

export interface PromptUsageState {
  collector: UsageCollector;
  /** Latest `used` context-occupancy snapshot, retained for existing displays. */
  totalTokens: number;
  costUsd: number | null;
  model: string | null;
  contextWindowSize: number | null;
}

interface PromptState {
  promptStartTime: number;
  /** Streamed agent_message_chunk text, so getLastResponse().text carries the final reply. */
  text: string;
  usage: PromptUsageState;
  completedToolCount: number;
  contextUsage?: ContextUsage;
  /** Native rollout position for requests app-server cannot stream (resume/fork). */
  codexRollout?: CodexRolloutCursor;
}

export function createPromptUsageState(): PromptUsageState {
  return {
    collector: new UsageCollector(),
    totalTokens: 0,
    costUsd: null,
    model: null,
    contextWindowSize: null,
  };
}

function createPromptState(): PromptState {
  return {
    promptStartTime: Date.now(),
    text: "",
    usage: createPromptUsageState(),
    completedToolCount: 0,
  };
}

interface PoolEntry {
  client: AcpClient;
  acpSessionId: string;
  lastUsed: number;
  promptState: PromptState;
  /** Everything the agent advertised for this session (session/new|load|resume). */
  modes?: SessionModeState;
  configOptions?: SessionConfigOption[];
  models?: SessionModelState;
  /**
   * The cwd and MCP server set this session was created with. Both bridges bind
   * them at creation (claude-agent-acp dist/acp-agent.js:4447 `cwd: params.cwd`;
   * codex-acp threadStart config, dist/index.js:26582-26586), so a change means
   * the pooled session can no longer serve the request.
   */
  cwd: string;
  mcpServersKey: string;
  pluginPathsKey: string;
  pluginFingerprint: string;
  codexHome: string | null;
  /** Session env is fixed at creation; a changed declaration requires a new process. */
  customModelOption: string | null;
  /** Claude model pinned in the bridge process env, including resumed sessions. */
  startupModel: string | null;
  /** Values currently in force, so a re-apply is only sent when they change. */
  appliedModel: string | null;
  /** Last requested model, including an unsuccessful but already attempted declaration. */
  attemptedModel: string | null;
  appliedContext: string | null;
  appliedEffort: string | null;
  /** Last permission mode we logged about, so a fallback is reported once per session. */
  warnedPermissionMode: string | null;
  /**
   * The `session/prompt` currently awaiting its response, or null. Native
   * steering needs one to join; without it `steer()` makes no wire call.
   */
  promptInFlight: object | null;
  /** When the agent last sent a `session/update` for this session. */
  lastUpdateAt: number;
  /** Top-level tool calls of the current prompt that have not completed or failed. */
  openToolCalls: Set<string>;
  /** Wakes steers waiting for the turn, tool calls, a person, or the prompt's end. */
  steerWaiters: Set<() => void>;
  /** Turn-level updates of the current prompt (text, tool calls, usage). */
  turnUpdates: number;
  /** Permission and question requests of this session waiting for an answer. */
  userInputs: number;
  /** A timed-out steer a bridge without the idle opt-in may still turn into a turn of its own. */
  lateSteer: Promise<SteerResponse> | null;
  /** `steer()` calls in progress (held for the turn, a tool call or the retry window): the turn is not stalled. */
  steersInFlight?: number;
  /**
   * Frames that arrived while no stream was listening (a bridge-started turn,
   * a task-notification follow-up after the prompt resolved). Only
   * `usage_update` frames, unless the provider captures autonomous rounds
   * (then every accepted frame, PR 5 §2.3). The next `listenAutonomous` or
   * `sendStream` replays them, so their requests are billed.
   */
  idleFrames: SessionNotification[];
  /** Serialized size of {@link idleFrames} while capturing. */
  idleFrameBytes?: number;
  /**
   * Native child sessions announced on the root or on another child (PR 5
   * §1.2), by session id. A child stays registered after its state update:
   * late frames still route to it.
   */
  children?: Map<string, NativeChildSession>;
  /** Unknown session ids already logged for this entry. */
  unknownSessions?: Set<string>;
  /** Codex rollout read position for this session; each settle advances it. */
  codexRollout?: CodexRolloutCursor;
  /** The gateway-shim channel of this ACP process (access configs with `usage: "gateway-shim"`). */
  gateway?: GatewayState;
}

interface NativeChildSession {
  /** The session that announced it: the root or another child. */
  parentSessionId: string;
  /** Its `subagent_state_update` arrived. */
  terminal: boolean;
  /** The announced name, for a request it raises before the trace saw the announcement. */
  name: string | null;
}

/** One ACP process's gateway-shim channel and what the provider learned from it. */
interface GatewayState {
  channel: GatewayShimChannel | null;
  unsubscribe: () => void;
  /** The active prompt's listener; null between prompts. */
  listener: ((event: GatewayShimEvent) => void) | null;
  /** The breaker opened: this process can no longer reach the gateway. */
  fatal: Extract<GatewayShimEvent, { type: "fatal" }> | null;
  /** The agent's own context window report; its `used` is never trusted. */
  nativeContextSize: number | null;
  /** Model calls the shim reported started but not yet ended. */
  inflight: number;
  /** The last model listing failed (refused or unreachable); cleared by a listing that succeeds. */
  listingFailure: GatewayShimListingFailure | null;
}

/** Usage updates the provider synthesized from shim observations (unforgeable by the agent). */
const SHIM_USAGE_UPDATES = new WeakSet<object>();

function openGateway(host: GatewayShimHost, label: string): GatewayState {
  const channel = host.open(label);
  const state: GatewayState = { channel, unsubscribe: () => {}, listener: null, fatal: null, nativeContextSize: null, inflight: 0, listingFailure: null };
  state.unsubscribe = channel.subscribe((event) => {
    if (event.type === "fatal") state.fatal = event;
    if (event.type === "request_started") state.inflight++;
    if (event.type === "request") state.inflight = Math.max(0, state.inflight - 1);
    if (event.type === "listing") state.listingFailure = event.failure;
    state.listener?.(event);
  });
  return state;
}

/** `settled()` is bounded by contract; a misbehaving shim still cannot hold the prompt open. */
async function settleGateway(channel: GatewayShimChannel, ms: number = GATEWAY_SETTLE_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      channel.settled(ms).catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms + 500); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function closeGateway(state: GatewayState | undefined): void {
  if (!state) return;
  state.listener = null;
  try { state.unsubscribe(); } catch {}
  try { state.channel?.close(); } catch {}
}

type PermissionHandler = (params: RequestPermissionParams) => Promise<PermissionOutcome>;
type ElicitationHandler = (params: ElicitationCreateParams) => Promise<ElicitationResult>;

export function resolveAcpPermissionMode(agentType: string, mode?: string | null): string | null {
  const normalized = typeof mode === "string" ? mode.trim() : "";
  if (normalized) return normalized === "bypass" ? "bypassPermissions" : normalized;
  return DEFAULT_PERMISSION_MODE_BY_AGENT[agentType] ?? accessConfigFor(agentType)?.defaultPermissionMode ?? null;
}

/**
 * The mode id to send on session/set_mode, or null to skip the call. The agent's
 * own advertised ids win; anything else is translated by the adapter (only codex
 * needs a table — claude advertises our ids directly).
 */
export function resolveAvailableAcpPermissionMode(
  mode: string | null,
  modes?: SessionModeState,
  adapter?: Pick<AgentAdapter, "mapPermissionMode">,
): string | null {
  if (!mode) return null;
  if (!modes?.availableModes?.length) return mode;
  if (modes.availableModes.some((m) => m.id === mode)) return mode;
  const available = new Set(modes.availableModes.map((m) => m.id));
  for (const candidate of adapter?.mapPermissionMode?.(mode) ?? []) {
    if (available.has(candidate)) return candidate;
  }
  // An id the agent doesn't advertise gets rejected with -32602 (codex-acp
  // validates session/set_mode strictly) — skip the call and keep the agent's
  // default mode rather than killing the session.
  return null;
}

/**
 * The `session/set_config_option` call for a requested select value, or null
 * when the bridge does not advertise it. Codex rejects unknown values;
 * Claude can additionally resolve full model IDs to SDK picker aliases.
 * Codex rejects missing explicit selections; Claude also supports SDK model
 * IDs via session metadata and resolves explicit 1M aliases through its bridge.
 */
export function resolveConfigOptionChange(
  configOptions: SessionConfigOption[] | undefined,
  category: string,
  value: string,
): { configId: string; value: string } | null {
  const option = configOptions?.find((o) => o.category === category);
  if (!option || option.type !== "select") return null;
  if (option.currentValue === value) return null;
  const selectable = option.options.flatMap((o) => ("options" in o ? o.options : [o]));
  if (!selectable.some((o) => o.value === value)) return null;
  return { configId: option.id, value };
}

/** The agent's current value for a config category, if it advertises one. */
function currentConfigValue(configOptions: SessionConfigOption[] | undefined, category: string): string | null {
  const option = configOptions?.find((o) => o.category === category);
  if (!option || option.type !== "select") return null;
  return option.currentValue;
}

function selectConfigOption(
  configOptions: SessionConfigOption[] | undefined,
  category: string,
): Extract<SessionConfigOption, { type: "select" }> | undefined {
  const option = configOptions?.find((item) => item.category === category);
  return option?.type === "select" ? option : undefined;
}

function flattenSelectOptions(option: Extract<SessionConfigOption, { type: "select" }>): SessionConfigSelectOption[] {
  return option.options.flatMap((item) => ("options" in item ? item.options : [item]));
}

function recommendedConfigValue(option: SessionConfigOption | undefined): string | undefined {
  const jetbrains = option?._meta?.jetbrains;
  if (!jetbrains || typeof jetbrains !== "object") return undefined;
  const air = (jetbrains as Record<string, unknown>).air;
  if (!air || typeof air !== "object") return undefined;
  const value = (air as Record<string, unknown>).recommendedValue;
  return typeof value === "string" ? value : undefined;
}

function isAcpDefaultSentinel(value: string): boolean {
  return value.trim().toLowerCase() === "default";
}

export function resolveAcpExecutableForAgent(agentType: string, executable: string | null | undefined, fallback: string): string {
  const explicit = typeof executable === "string" ? executable.trim() : "";
  const access = accessConfigFor(agentType);
  if (explicit) {
    if (access?.retiredExecutables.includes(basename(explicit))) {
      throw new Error(`[acp_executable_retired] ${agentType}: Agent executable "${explicit}" points at the retired agy CLI; clear it`);
    }
    return explicit;
  }
  if (access) {
    // The pinned per-machine install; a missing one surfaces through health and launch.
    try { return access.launch().executable; } catch { return fallback; }
  }

  if (agentType === "claude") {
    const envExecutable = process.env.REMI_CLAUDE_AGENT_ACP_EXECUTABLE?.trim();
    if (envExecutable) return envExecutable;

    const remiHome = process.env.REMI_HOME ?? join(homedir(), ".remi");
    const candidates = [
      // Prefer the wrapper shipped next to the running remi binary — it always
      // matches this build. Otherwise a stale copy earlier on PATH (e.g. an old
      // /usr/local/bin/remi-claude-agent-acp) gets picked and can fail
      // --verify-patch against a newer bridge. (For source runs execPath is the
      // bun binary, so this candidate simply doesn't exist and we fall through.)
      join(dirname(process.execPath), REMI_CLAUDE_AGENT_ACP_WRAPPER),
      join(remiHome, "bin", REMI_CLAUDE_AGENT_ACP_WRAPPER),
      join(homedir(), ".remi", "bin", REMI_CLAUDE_AGENT_ACP_WRAPPER),
      join(import.meta.dir, "..", "bin", REMI_CLAUDE_AGENT_ACP_WRAPPER),
      join(import.meta.dir, "..", "..", "..", "bin", REMI_CLAUDE_AGENT_ACP_WRAPPER),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }

    const pathExecutable = resolveExecutableOnPath(REMI_CLAUDE_AGENT_ACP_WRAPPER);
    if (pathExecutable) return pathExecutable;
  }

  if (agentType === "codex") {
    const envExecutable = process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE?.trim();
    if (envExecutable) return envExecutable;

    const remiHome = process.env.REMI_HOME ?? join(homedir(), ".remi");
    const candidates = [
      join(remiHome, "bin", "codex-acp"),
      join(homedir(), ".remi", "bin", "codex-acp"),
      join(homedir(), ".npm-global", "bin", "codex-acp"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }

    const pathExecutable = resolveExecutableOnPath("codex-acp");
    if (pathExecutable) return pathExecutable;
  }

  return fallback;
}

function resolveExecutableOnPath(command: string): string | null {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of paths) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface AcpHealthCheckCommand {
  command: string;
  /**
   * Args to spawn for the check. When omitted, the check is "the executable
   * resolves to a file" — no spawn. Used for ACP agents that have no portable
   * probe flag.
   */
  args?: string[];
  /** A spawn-free check already failed (e.g. the pinned install does not match its manifest). */
  failure?: string;
}

export function resolveAcpHealthCheckCommand(
  agentType: string,
  executable: string | null | undefined,
  fallback: string,
): AcpHealthCheckCommand {
  const command = resolveAcpExecutableForAgent(agentType, executable, fallback);
  const access = accessConfigFor(agentType);
  if (access && !executable?.trim()) {
    // Never spawned at daemon start: the manifest, executables and machine policy are the check.
    const failure = access.healthProblem();
    return failure ? { command, failure } : { command };
  }
  // The claude wrapper applies + verifies the AskUserQuestion patch, so it
  // genuinely has to run --verify-patch.
  if (agentType === "claude" && command.endsWith(REMI_CLAUDE_AGENT_ACP_WRAPPER)) {
    return { command, args: ["--verify-patch"] };
  }
  // Everything else (e.g. codex): existence-only, no spawn. There is no
  // portable probe flag for codex-acp — the npm build boots a heavy app-server
  // on --help (which can outrun the timeout on slow networks) while the Rust
  // build rejects --version with exit 2. So we just confirm the executable
  // resolves; a real task run surfaces anything deeper.
  return { command };
}

/** True if `executable` is an existing file (by path) or resolvable on PATH. */
export function acpExecutableResolves(executable: string): boolean {
  if (executable.includes("/") || executable.includes("\\")) {
    return existsSync(executable);
  }
  const dirs = (process.env.PATH ?? "").split(delimiter);
  return dirs.some((dir) => dir && existsSync(join(dir, executable)));
}

export class AcpProvider implements Provider {
  readonly name: string;

  private _options: AcpProviderOptions;
  private _adapter: AgentAdapter;
  private _pool = new Map<string, PoolEntry>();
  private _startingClients = new Set<AcpClient>();
  private _activeStreaming = new Set<string>();
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _permissionHandler: PermissionHandler | null = null;
  private _permissionHandlers = new Map<string, PermissionHandler>();
  private _elicitationHandler: ElicitationHandler | null = null;
  private _elicitationHandlers = new Map<string, ElicitationHandler>();
  private _sessionToChatId = new Map<string, string>();
  private _lastResponse: AgentResponse | null = null;
  private _typedSessionFailures: boolean | undefined;
  /** Active-stream wakeups keyed by chatId, fired when the entry's ACP process dies. */
  private _deathListeners = new Map<string, (reason: string) => void>();

  /** The agent's access config; null for the npm-bridge agents. */
  private _access: AcpAccessConfig | null;

  constructor(options: AcpProviderOptions = {}) {
    this._options = options;
    this._adapter = createAdapter(options.agentType ?? "claude");
    this._access = accessConfigFor(this._adapter.agentType);
    this.name = `acp:${this._adapter.agentType}`;
  }

  /** A requested model the agent cannot select fails instead of running another one. */
  private get _strictModel(): boolean {
    return this._adapter.agentType === "codex" || this._access?.strictModel === true;
  }

  get adapter(): AgentAdapter {
    return this._adapter;
  }

  get typedSessionFailures(): boolean | undefined {
    return this._typedSessionFailures;
  }

  /** Register external handler for permission requests (AskUserQuestion, ExitPlanMode, tool approval). */
  setPermissionHandler(handler: PermissionHandler, chatId?: string | null): void {
    if (chatId) {
      this._permissionHandlers.set(chatId, handler);
    } else {
      this._permissionHandler = handler;
    }
  }

  /** Register external handler for form elicitation requests (AskUserQuestion on Claude ACP). */
  setElicitationHandler(handler: ElicitationHandler, chatId?: string | null): void {
    if (chatId) {
      this._elicitationHandlers.set(chatId, handler);
    } else {
      this._elicitationHandler = handler;
    }
  }

  getLastResponse(): AgentResponse | null {
    return this._lastResponse;
  }

  /** Assistant text emitted so far for the active prompt in this chat. */
  getStreamedText(chatId: string): string {
    return this._pool.get(chatId)?.promptState.text ?? "";
  }

  /**
   * Discover the bridge's live model catalog and each model's effort values.
   * Both supported bridges rewrite `thought_level` after the `model` option is
   * changed, so a single session must walk the model selector in order.
   */
  async discoverModelCapabilities(): Promise<AcpModelCapability[]> {
    const chatId = `__capability_probe__:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const entry = await this._ensureSession(chatId, {
      chatId,
      cwd: this._options.cwd ?? homedir(),
      permissionMode: null,
    });

    try {
      // A refused or unreachable listing leaves the server's built-in fallback ids, not the gateway's models.
      const listing = entry.gateway?.fatal ?? entry.gateway?.listingFailure;
      if (listing) throw gatewaySessionFailure(this._adapter.agentType, listing, credentialsOf(this._options));
      const modelOption = selectConfigOption(entry.configOptions, MODEL_OPTION_CATEGORY);
      if (!modelOption) return [];

      const initialModel = modelOption.currentValue;
      const models = flattenSelectOptions(modelOption).filter((model) => !isAcpDefaultSentinel(model.value));
      if (isAcpDefaultSentinel(initialModel)) {
        models.unshift({ value: initialModel, name: "Default" });
      }
      if (this._access?.effort === "none") {
        // No effort selector in this access mode: one read, no per-model walk.
        return models.map((model) => ({
          id: model.value,
          label: model.name || model.value,
          ...(model.description ? { description: model.description } : {}),
          default: model.value === initialModel,
          effort: { status: "unsupported" as const, supportedLevels: [] },
        }));
      }
      const discovered: AcpModelCapability[] = [];

      for (const model of models) {
        const previousEffort = currentConfigValue(entry.configOptions, EFFORT_OPTION_CATEGORY);
        const modelChanged = currentConfigValue(entry.configOptions, MODEL_OPTION_CATEGORY) !== model.value;
        if (modelChanged) {
          await this._setConfigOption(entry, MODEL_OPTION_CATEGORY, model.value);
        }

        const effortOption = selectConfigOption(entry.configOptions, EFFORT_OPTION_CATEGORY);
        const effortLevels = effortOption
          ? flattenSelectOptions(effortOption).filter((level) => !isAcpDefaultSentinel(level.value))
          : [];
        // Recent Codex bridges preserve the prior effort when both models
        // support it. Prefer their recommendation; unchanged currentValue
        // after switching is not evidence of the new model's default.
        const recommendedEffort = recommendedConfigValue(effortOption);
        const defaultEffort = recommendedEffort
          ?? (!modelChanged || effortOption?.currentValue !== previousEffort ? effortOption?.currentValue : undefined);
        discovered.push({
          id: model.value,
          label: model.name || model.value,
          ...(model.description ? { description: model.description } : {}),
          default: model.value === initialModel,
          ...(isAcpDefaultSentinel(model.value) ? { providerDefault: true } : {}),
          effort: {
            status: !effortOption ? "unknown" : effortLevels.length ? "supported" : "unsupported",
            ...(defaultEffort && effortLevels.some((level) => level.value === defaultEffort)
              ? { defaultLevel: defaultEffort }
              : {}),
            supportedLevels: effortLevels.map((level) => ({
              value: level.value,
              label: level.name || level.value,
              ...(level.description ? { description: level.description } : {}),
            })),
          },
        });
      }

      return discovered;
    } finally {
      await this._discardEntry(chatId, entry);
    }
  }

  // ── Provider interface ─────────────────────────────────────────

  async send(message: string, options?: SendOptions): Promise<AgentResponse> {
    let text = "";
    let thinking = "";

    for await (const event of this.sendStream(message, options)) {
      if (event.sessionUpdate === "agent_message_chunk") {
        const blocks = Array.isArray(event.content) ? event.content : [event.content];
        for (const b of blocks) { if (b.type === "text" && b.text) text += b.text; }
      } else if (event.sessionUpdate === "agent_thought_chunk") {
        const blocks = Array.isArray(event.content) ? event.content : [event.content];
        for (const b of blocks) { if (b.type === "text" && b.text) thinking += b.text; }
      }
    }

    return this._lastResponse ?? createAgentResponse({ text, thinking: thinking || null });
  }

  async *sendStream(message: string, options?: SendOptions): AsyncGenerator<ProviderEvent> {
    this._lastResponse = null;
    const credentials = this._credentials();
    const chatId = options?.chatId ?? "__default__";
    if (this._access?.modelRequired && !(options?.model ?? this._options.model)) {
      // Without an explicit selection the agent silently runs the gateway's first model.
      throw new Error(`[${this._adapter.agentType}_model_required] ${this._adapter.agentType} needs a model: `
        + "set the Agent's model or the Model gateway default_model");
    }
    // A bridge-started turn from a timed-out steer must not overlap this prompt.
    const previous = this._pool.get(chatId);
    if (previous?.lateSteer) await this._settleLateSteer(previous);
    const entry = await abortableEnsureSession(this._ensureSession(chatId, options), options?.signal);
    // An access config that turns service messages into typed failures needs no legacy text heuristics.
    this._typedSessionFailures = (entry.client.typedSessionFailures ?? false) || this._access?.serviceMessages === true;

    this._activeStreaming.add(chatId);
    entry.lastUsed = Date.now();
    entry.promptState = createPromptState();
    const promptState = entry.promptState;
    const requestedModel = () => currentConfigValue(entry.configOptions, MODEL_OPTION_CATEGORY)
      ?? entry.models?.currentModelId ?? options?.model ?? this._options.model;
    const requestedModelSource = (): TaskUsageUnit["modelSource"] => currentConfigValue(entry.configOptions, MODEL_OPTION_CATEGORY)
      || entry.models?.currentModelId ? "session_acknowledged" : requestedModel() ? "configured" : "unknown";
    this._lastResponse = null;

    const eventQueue: ProviderEvent[] = [];
    let promptDone = false;
    let promptError: Error | null = null;
    const failureState: { failure: AcpSessionFailure | null; compaction: AcpSessionFailure | null } = { failure: null, compaction: null };
    const turnFailure = () => failureState.failure?.severity === "error"
      ? failureState.failure : failureState.compaction ?? failureState.failure;
    let resolveWaiting: (() => void) | null = null;

    const pushEvent = (evt: ProviderEvent) => {
      eventQueue.push(evt);
      resolveWaiting?.();
    };

    // Publish the acknowledged session model, including default/resumed sessions.
    // Construction-time model options alone do not prove what the bridge selected.
    if (selectConfigOption(entry.configOptions, MODEL_OPTION_CATEGORY)) {
      pushEvent({ sessionUpdate: "config_option_update", configOptions: entry.configOptions });
    } else if (entry.models?.currentModelId) {
      pushEvent({ sessionUpdate: "config_option_update", id: "model", value: entry.models.currentModelId });
    }

    // Belt-and-braces against a mid-turn process death: the prompt request's
    // rejection normally wakes the loop, but if the death races request
    // bookkeeping this guarantees the stream still terminates.
    this._deathListeners.set(chatId, (reason) => {
      promptDone = true;
      promptError ??= new Error(redactProviderErrorText(`ACP agent died unexpectedly (${reason})`, credentials));
      resolveWaiting?.();
    });

    // Set once this stream's prompt is on the wire; see onPromptStarted.
    let promptToken: object | null = null;
    let promptStarted = false;
    const originalOnUpdate = entry.client["_options"].onSessionUpdate;
    /** Last HTTP status the gateway shim saw in this prompt (service-message category). */
    let gatewayStatus: number | null = null;
    let syntheticSeq = 0;
    /** This round sent `session/cancel` (a stop, a steer, an opened breaker or the stall watchdog). */
    let cancelSent = false;
    /** Stall watchdog state (access configs with `turnStallTimeoutMs`). */
    let lastActivity = Date.now();
    let stalled = false;
    /** The opened shim breaker asked to stop the turn. */
    let gatewayStop = false;
    /** A cancel is waiting for the prompt to settle (a stop, a steer fallback, the breaker or the watchdog). */
    let settling = false;
    /** Order of agent frames, and of the last one that was model output (text, thought or a new tool call). */
    let frameSeq = 0;
    let lastOutputSeq = 0;
    /** Tool calls still pending / in progress, with the frame order of their last update. */
    const openTools = new Map<string, number>();
    const onUpdate = (notification: SessionNotification) => {
      const child = this._routeFrame(chatId, entry, notification);
      if (child === undefined) return;
      entry.lastUpdateAt = Date.now();
      if (child !== null) {
        // A child's frame is its own (PR 5 §1.2): it never touches the root
        // turn's model, failure, text, context or steering state.
        lastActivity = Date.now();
        pushEvent(this._childUpdate(entry, notification.update, child, requestedModel(), requestedModelSource(), credentials));
        return;
      }
      let update = notification.update;
      if (promptToken && entry.promptInFlight === promptToken && isTurnLevelUpdate(update)) {
        // The bridge registers the turn asynchronously (codex-acp `prompt()`
        // awaits before its pending turn start; claude-agent-acp awaits in
        // `startTurn`): only a turn-level update proves a steer can join it.
        entry.turnUpdates = (entry.turnUpdates ?? 0) + 1;
        wakeSteerWaiters(entry);
        if (!promptStarted) {
          promptStarted = true;
          try {
            options?.onPromptStarted?.();
          } catch (error) {
            console.warn(`[AcpProvider] onPromptStarted failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      lastActivity = Date.now();
      frameSeq++;
      if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") lastOutputSeq = frameSeq;
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const id = (update as { toolCallId?: unknown }).toolCallId;
        const status = (update as { status?: unknown }).status;
        if (typeof id === "string") {
          if (update.sessionUpdate === "tool_call" && !openTools.has(id)) lastOutputSeq = frameSeq;
          if (status === "completed" || status === "failed") openTools.delete(id);
          else if (status === "pending" || status === "in_progress" || update.sessionUpdate === "tool_call" || openTools.has(id)) openTools.set(id, frameSeq);
        }
      }
      if (update.sessionUpdate === "usage_update" && entry.gateway && !SHIM_USAGE_UPDATES.has(update)) {
        // Native `used` is total + cached (double-counts the cache): keep only the window size.
        const size = nonNegativeFinite(update.size);
        if (size) entry.gateway.nativeContextSize = size;
        return;
      }
      if (update.sessionUpdate === "agent_message_chunk" && this._access?.serviceMessages) {
        const text = extractChunkText((update as Record<string, any>).content);
        // The server's acknowledgement of our own cancel, not the model's words.
        if (cancelSent && text.trim() === CANCELLED_BY_CLIENT_TEXT) return;
        const service = serviceMessage(text);
        if (service?.type === "failure") {
          const failure = serviceMessageFailure(service, `${this._adapter.agentType}:service:${++syntheticSeq}`, gatewayStatus);
          onUpdate({ sessionId: entry.acpSessionId, update: {
            sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { sessionFailure: failure } } },
          } as SessionUpdate });
          return;
        }
        if (service?.type === "model_replaced") {
          // The agent also sends the new selection as `config_option_update` (the turn's model).
          pushEvent({ sessionUpdate: "notice", severity: "warning", title: "Model replaced",
            description: `${service.previous} is no longer available; the agent switched to ${service.replacement}.` });
          if (!service.rest) return;
          update = { ...update, content: [{ type: "text", text: service.rest }] } as SessionUpdate;
        }
      }
      if (update.sessionUpdate === "session_info_update") {
        const read = withRedactedSessionFailure(update, credentials);
        const failure = read.failure;
        if (failure && (failure.severity === "error" || failureState.failure?.severity !== "error")) failureState.failure = failure;
        update = read.update;
      }
      this._applyConfigUpdate(entry, update);
      if (update.sessionUpdate === "usage_update") {
        update = this._stampUsage(entry, update, requestedModel(), requestedModelSource(), true);
      }
      if (update.sessionUpdate === "agent_message_chunk" && !stampedParent(update)) {
        // Remi advertises `session.compaction` and `session.notices`, so neither
        // bridge reports compaction or notices as message text any more. A
        // subagent's prose (stamped with its Agent call) is never the reply.
        const text = extractChunkText((update as Record<string, any>).content);
        entry.promptState.text += text;
        if (text.trim() && failureState.compaction) {
          failureState.compaction = null;
          console.warn("[AcpProvider] Assistant continued after a context compaction failure");
        }
      }
      if (update.sessionUpdate === "compaction_update") {
        const compaction = update as { compactionId?: unknown; status?: unknown; error?: unknown };
        // The ACP compaction lifecycle (CA/context-compaction.js, CX:42234-42296):
        // a failed compaction ends the turn unless the assistant continues.
        if (compaction.status === "failed") {
          const error = typeof compaction.error === "string" ? compaction.error
            : typeof record(compaction.error)?.message === "string" ? record(compaction.error)!.message as string : "Compacting failed";
          failureState.compaction = {
            id: typeof compaction.compactionId === "string" ? compaction.compactionId : "compaction",
            revision: 1, category: "unknown", severity: "error",
            title: "Context compaction failed",
            details: redactProviderErrorText(error, credentials),
          };
          update = JSON.parse(JSON.stringify(update, (_key, value) =>
            typeof value === "string" ? redactProviderErrorText(value, credentials) : value));
        }
      }
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        trackToolCall(entry, update);
      }
      if (update.sessionUpdate === "tool_call_update") {
        const status = (update as any).status;
        const compaction = record(record(update._meta)?.contextCompaction);
        // Claude /compact can resolve end_turn after this failed tool, without
        // an AIR failure. Only later assistant output in this prompt recovers it.
        if (status === "failed" && compaction) {
          const details = redactProviderErrorText(typeof compaction.error === "string" ? compaction.error : "Compacting failed", credentials);
          failureState.compaction = {
            id: update.toolCallId, revision: 1, category: "unknown", severity: "error",
            title: "Context compaction failed",
            details,
          };
          // This failed tool's text also becomes task messages, not just Error.message.
          update = JSON.parse(JSON.stringify(update, (_key, value) =>
            typeof value === "string" ? redactProviderErrorText(value, credentials) : value));
        }
        if (status === "completed" || status === "failed") {
          entry.promptState.completedToolCount++;
        }
      }
      pushEvent(update);
    };
    entry.client["_options"].onSessionUpdate = onUpdate;

    const gateway = entry.gateway;
    if (gateway) {
      // Shim observations enter the same queue as agent updates: one writer, in order.
      gateway.listener = (event) => {
        if (event.type === "fatal") {
          gatewayStatus = event.status ?? gatewayStatus;
          onUpdate({ sessionId: entry.acpSessionId, update: {
            sessionUpdate: "session_info_update",
            _meta: { jetbrains: { air: { sessionFailure: gatewayFatalFailure(event, `${this._adapter.agentType}:gateway:${++syntheticSeq}`) } } },
          } as SessionUpdate });
          // The harness retries a dead gateway forever; end the turn through the cancel settle path.
          gatewayStop = true;
          resolveWaiting?.();
          return;
        }
        lastActivity = Date.now();
        if (event.type === "request_started" || event.type === "listing") return;
        const obs = event.obs;
        if (obs.status) gatewayStatus = obs.status;
        const usage = geminiObservationUsage(obs, entry.acpSessionId);
        if (!usage) return;
        // Subagent and browser calls run other models; only the session model's calls are its context (R9).
        const sessionModel = requestedModel();
        const context = usage.contextTokens !== null && (!obs.requestedModel || !sessionModel || obs.requestedModel === sessionModel);
        const synthetic: UsageUpdate = {
          sessionUpdate: "usage_update",
          used: context ? usage.contextTokens! : 0,
          size: context ? gateway.nativeContextSize ?? this._access!.defaultContextWindow : 0,
          _meta: { remiUsageMode: "request", ...("remiTokenUsage" in usage
            ? { remiTokenUsage: usage.remiTokenUsage } : { remiMissingRequestUsage: usage.remiMissingRequestUsage }) },
        };
        SHIM_USAGE_UPDATES.add(synthetic);
        onUpdate({ sessionId: entry.acpSessionId, update: synthetic });
      };
    }
    entry.openToolCalls?.clear();
    entry.turnUpdates = 0;
    // Bill the requests of turns no stream was listening to (ADR 0020): a
    // bridge-started turn the daemon cancelled, or a follow-up after a resolve.
    // While capturing autonomous rounds, the whole follow-up replays into this
    // round (PR 5 §2.6: a steer that stopped the wait re-prompts here).
    for (const notification of takeIdleFrames(entry)) onUpdate(notification);

    const rolloutHome = this._adapter.agentType === "codex" ? codexHomeFor(entry.codexHome, { ...process.env, ...this._options.env }) : null;
    if (rolloutHome) {
      // The ACP session ID is the native thread ID. One cursor per session, so a
      // turn the bridge ran between prompts is read now, as idle usage is billed.
      if (entry.codexRollout?.threadId !== entry.acpSessionId || entry.codexRollout.sessionsDir !== join(rolloutHome, "sessions")) {
        entry.codexRollout = beginCodexRolloutUsage(rolloutHome, entry.acpSessionId, promptState.promptStartTime);
      }
      promptState.codexRollout = entry.codexRollout;
    }
    const promptStartMs = Date.now();
    promptToken = {};
    const settlePromptInFlight = () => {
      if (entry.promptInFlight === promptToken) entry.promptInFlight = null;
      wakeSteerWaiters(entry);
    };
    // The shim serves model calls only while a prompt of this process is active.
    let endGatewayPrompt: (() => void) | null = null;
    // Model calls still running when the prompt ends are this prompt's: wait
    // for their observations (bounded), then cut the rest, which bill as
    // partial. Nothing outside a prompt is metered, so nothing may run there.
    const drainGateway = async () => {
      const channel = gateway?.channel;
      if (!channel) return;
      // The server ended the prompt: refuse new model calls first, so none can
      // start after the drain and finish unobserved.
      endGatewayPrompt?.();
      await settleGateway(channel);
      if (gateway!.inflight > 0) {
        channel.abortInflight();
        await settleGateway(channel, GATEWAY_ABORT_SETTLE_MS);
      }
    };
    endGatewayPrompt = gateway?.channel?.beginPrompt() ?? null;
    const promptCompletion = entry.client
      .prompt(entry.acpSessionId, message, buildMediaContent(options?.media))
      .then(async (result: PromptResult) => {
        // The turn is over for steering at once; usage settles before promptDone,
        // so the stream cannot build its fallback response first.
        settlePromptInFlight();
        // The last requests' usage must land in this prompt's collector.
        await drainGateway();
        if (entry.promptState === promptState) {
          await settleCodexRolloutUsage(promptState, requestedModel(), requestedModelSource(), CODEX_ROLLOUT_SETTLE_MS);
        }
        promptDone = true;
        const failure = readSessionFailure(result._meta, credentials);
        if (failure && (failure.severity === "error" || failureState.failure?.severity !== "error")) failureState.failure = failure;
        if (entry.promptState === promptState && this._activeStreaming.has(chatId)) {
          this._lastResponse = buildAgentResponse(entry, result, this._adapter.promptUsageSettleScope, turnFailure(),
            this._adapter.agentType, requestedModel(), requestedModelSource());
        }
        if (result.stopReason === "cancelled" || result.stopReason === "interrupted") {
          promptError = new Error("Cancelled");
        }
        resolveWaiting?.();
      })
      .catch(async (err: unknown) => {
        settlePromptInFlight();
        await drainGateway();
        promptDone = true;
        promptError = redactProviderError(err, credentials);
        console.error(`[AcpProvider] prompt FAILED after ${((Date.now() - promptStartMs) / 1000).toFixed(1)}s: ${promptError.message}`);
        resolveWaiting?.();
      });
    // The request is on the wire; `onPromptStarted` waits for the turn itself.
    if (!promptDone) entry.promptInFlight = promptToken;

    // The breaker opened before this prompt (e.g. while `session/new` listed
    // models): the harness would retry the dead token forever, so fail now.
    // Sent after the prompt request, so the agent sees the cancel for it.
    if (gateway?.fatal) gateway.listener?.(gateway.fatal);

    // cancel is only a notification. Keep this stream and its update handler
    // alive until the original prompt settles; the daemon may then send its
    // steering prompt on the same session without overlap.
    const cancelAndSettle = async () => {
      cancelSent = true;
      settling = true;
      await entry.client.cancel(entry.acpSessionId).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const settled = await Promise.race([
          promptCompletion.then(() => true),
          new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), PROMPT_CANCEL_SETTLE_MS); }),
        ]);
        if (!settled) {
          // An unresponsive bridge cannot retain an in-flight prompt or
          // block task shutdown. Stop it before allowing session reuse.
          await entry.client.stop();
          await promptCompletion;
          if (!this._lastResponse) await settleCodexRolloutUsage(promptState, requestedModel(), requestedModelSource(), 0);
          this._lastResponse ??= buildAgentResponse(entry, { stopReason: "cancelled" }, this._adapter.promptUsageSettleScope, turnFailure(),
            this._adapter.agentType, requestedModel(), requestedModelSource());
        }
      } finally {
        if (timer) clearTimeout(timer);
        settling = false;
      }
    };

    // Stall watchdog: no agent update, no model call in flight, no tool call
    // the model is waiting on and no pending permission or question for the
    // whole bound. An open tool call counts as blocking until later model
    // output (text, a thought, another tool call) arrives on the same ordered
    // ACP stream: a model can only continue once the tool returned, so after
    // that the tool runs in the background and no longer explains the silence.
    const stallMs = this._access?.turnStallTimeoutMs && gateway
      ? Math.max(1, this._options.turnStallTimeoutMs ?? this._access.turnStallTimeoutMs) : null;
    const watchdog = stallMs === null ? null : setInterval(() => {
      // A stop, a steer fallback or the breaker is already ending the turn through the settle path.
      if (promptDone || stalled || settling || gatewayStop || options?.signal?.aborted) return;
      const now = Date.now();
      const blockingTool = [...openTools.values()].some((updatedSeq) => updatedSeq >= lastOutputSeq);
      if (gateway!.inflight > 0 || blockingTool || (entry.userInputs ?? 0) > 0 || (entry.steersInFlight ?? 0) > 0) {
        lastActivity = now;
        return;
      }
      if (now - lastActivity < stallMs) return;
      stalled = true;
      // An earlier typed failure (e.g. an opened breaker whose cancel the server ignored) stays the turn's reason.
      if (failureState.failure?.severity !== "error") onUpdate({ sessionId: entry.acpSessionId, update: {
        sessionUpdate: "session_info_update",
        _meta: { jetbrains: { air: { sessionFailure: turnStalledFailure(this._adapter.agentType, stallMs, `${this._adapter.agentType}:stall:${++syntheticSeq}`) } } },
      } as SessionUpdate });
      resolveWaiting?.();
    }, Math.max(5, Math.min(5_000, Math.floor(stallMs / 4))));
    (watchdog as { unref?: () => void } | null)?.unref?.();

    try {
      while (true) {
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }

        if (promptDone) break;

        if (stalled || gatewayStop) {
          // Stop the turn the way a cancel does; the typed failure above fails it.
          await cancelAndSettle();
          while (eventQueue.length) yield eventQueue.shift()!;
          break;
        }

        if (options?.signal?.aborted) {
          await cancelAndSettle();
          // ACP permits final tool/content updates before the cancelled reply.
          while (eventQueue.length) yield eventQueue.shift()!;
          throw new Error("Cancelled");
        }

        await new Promise<void>((resolve) => {
          resolveWaiting = resolve;
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        resolveWaiting = null;
      }
    } finally {
      if (watchdog) clearInterval(watchdog);
      endGatewayPrompt?.();
      // Streaming errors, process death, generator return and task aborts all
      // retain actual requests observed before the prompt stopped.
      if (!this._lastResponse) {
        await settleCodexRolloutUsage(promptState, requestedModel(), requestedModelSource(), 0);
        this._lastResponse = buildAgentResponse(entry,
          { stopReason: options?.signal?.aborted ? "cancelled" : "end_turn" }, this._adapter.promptUsageSettleScope, turnFailure(),
          this._adapter.agentType, requestedModel(), requestedModelSource());
      }
      this._deathListeners.delete(chatId);
      entry.client["_options"].onSessionUpdate = originalOnUpdate;
      if (gateway) gateway.listener = null;
      this._activeStreaming.delete(chatId);
      entry.lastUsed = Date.now();
    }

    const failure = turnFailure();
    if (failure?.severity === "error") throw new AcpSessionFailureError(failure, promptError ?? undefined, credentials);
    if (promptError) throw promptError;
  }

  /**
   * Stream an autonomous round of `chatId`'s session (PR 5 §2.3): a model cycle
   * the bridge started after the last prompt resolved, such as Claude's
   * task-notification follow-up for a background subagent that finished before
   * the human turn's result. Frames that arrived since the prompt replay first.
   *
   * The round keeps the last prompt's state: its usage collector (so Claude's
   * cumulative turn-cost estimate replaces the prompt's, R6), streamed text and
   * context. It ends at the first of:
   * - a root `usage_update` whose `_meta["_claude/origin"].kind` is one of the
   *   adapter's result origins (the round's result);
   * - `idleMs` without a frame of turn activity, before the first one;
   * - {@link AUTONOMOUS_HARD_CAP_MS} after the first one;
   * - `signal` abort or the agent process dying.
   * Afterwards `getLastResponse()` covers the prompt and the round. Without a
   * pooled, idle session, or for an adapter without autonomous rounds, it
   * yields nothing. A failure is reported as frames, never thrown.
   */
  async *listenAutonomous(options: ListenAutonomousOptions = {}): AsyncGenerator<ProviderEvent> {
    const chatId = options.chatId ?? "__default__";
    const entry = this._pool.get(chatId);
    const rounds = this._adapter.autonomousRounds;
    if (!entry || !rounds || !this._capturesAutonomousRounds || entry.promptInFlight || !entry.client.alive
      || this._activeStreaming.has(chatId)) return;
    const credentials = this._credentials();
    const requestedModel = () => currentConfigValue(entry.configOptions, MODEL_OPTION_CATEGORY)
      ?? entry.models?.currentModelId ?? this._options.model;
    const requestedModelSource = (): TaskUsageUnit["modelSource"] => currentConfigValue(entry.configOptions, MODEL_OPTION_CATEGORY)
      || entry.models?.currentModelId ? "session_acknowledged" : requestedModel() ? "configured" : "unknown";
    const resultOrigins = new Set(rounds.resultOrigins);
    const idleMs = Math.max(1, options.idleMs ?? AUTONOMOUS_IDLE_MS);
    const capMs = Math.max(1, this._options.autonomousRoundCapMs ?? AUTONOMOUS_HARD_CAP_MS);
    const startedAt = Date.now();
    let firstActivityAt = null as number | null;
    let ended = null as "result" | "death" | null;
    const queue: ProviderEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (event: ProviderEvent) => {
      queue.push(event);
      wake?.();
    };

    this._activeStreaming.add(chatId);
    this._deathListeners.set(chatId, () => {
      ended ??= "death";
      wake?.();
    });
    const onUpdate = (notification: SessionNotification) => {
      const child = this._routeFrame(chatId, entry, notification);
      if (child === undefined) return;
      entry.lastUpdateAt = Date.now();
      const update = child !== null
        ? this._childUpdate(entry, notification.update, child, requestedModel(), requestedModelSource(), credentials)
        : this._rootIdleUpdate(entry, notification.update, requestedModel(), requestedModelSource(), credentials);
      if (firstActivityAt === null && (child !== null || isTurnLevelUpdate(update) || isSubagentLifecycle(update))) {
        firstActivityAt = Date.now();
      }
      push(update);
      if (child === null && update.sessionUpdate === "usage_update") {
        const origin = autonomousOrigin(update as unknown as Record<string, unknown>);
        if (origin && resultOrigins.has(origin)) {
          ended ??= "result";
          wake?.();
        }
      }
    };
    const originalOnUpdate = entry.client["_options"].onSessionUpdate;
    entry.client["_options"].onSessionUpdate = onUpdate;
    let stop: "result" | "death" | "idle" | "cap" | "abort" | null = null;
    try {
      for (const notification of takeIdleFrames(entry)) onUpdate(notification);
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (ended) { stop = ended; break; }
        if (options.signal?.aborted) { stop = "abort"; break; }
        const now = Date.now();
        const deadline = firstActivityAt === null ? startedAt + idleMs : firstActivityAt + capMs;
        if (now >= deadline) { stop = firstActivityAt === null ? "idle" : "cap"; break; }
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onAbort = () => wake?.();
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, deadline - now);
          options.signal?.addEventListener("abort", onAbort, { once: true });
        });
        wake = null;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      if (entry.client["_options"].onSessionUpdate === onUpdate) entry.client["_options"].onSessionUpdate = originalOnUpdate;
      this._deathListeners.delete(chatId);
      this._activeStreaming.delete(chatId);
      entry.lastUsed = Date.now();
      if (stop === "cap") {
        console.warn(`[AcpProvider] ${this._adapter.agentType}: an autonomous round ran ${Math.round(capMs / 1000)} s without its result; stopped listening`);
      }
      this._lastResponse = buildAgentResponse(entry, { stopReason: "end_turn" }, this._adapter.promptUsageSettleScope, null,
        this._adapter.agentType, requestedModel(), requestedModelSource());
    }
  }

  /** The adapter declares autonomous rounds and the caller asked to capture them. */
  private get _capturesAutonomousRounds(): boolean {
    return this._options.captureAutonomousRounds === true && !!this._adapter.autonomousRounds;
  }

  /**
   * Whether `notification` belongs to `entry` (PR 5 §1.2): its root session or
   * a registered child. Returns null for a root frame, the child's session id
   * for a child frame, undefined to drop it (logged once per unknown id).
   * A `subagent_spawned` on either registers the announced child and routes its
   * permission and question requests to `chatId`; a `subagent_state_update`
   * marks it ended but keeps it registered.
   */
  private _routeFrame(chatId: string, entry: PoolEntry, notification: SessionNotification): string | null | undefined {
    const sessionId = notification.sessionId;
    let child: string | null = null;
    if (sessionId !== entry.acpSessionId) {
      if (!entry.children?.has(sessionId)) {
        entry.unknownSessions ??= new Set();
        if (!entry.unknownSessions.has(sessionId) && entry.unknownSessions.size < MAX_LOGGED_UNKNOWN_SESSIONS) {
          entry.unknownSessions.add(sessionId);
          console.warn(`[AcpProvider] ${this._adapter.agentType}: dropping updates for unknown session ${sessionId}`);
        }
        return undefined;
      }
      child = sessionId;
    }
    const update = notification.update as unknown as Record<string, unknown> | undefined;
    const announced = typeof update?.subagentSessionId === "string" ? update.subagentSessionId : "";
    if (update?.sessionUpdate === "subagent_spawned" && announced && announced !== entry.acpSessionId) {
      entry.children ??= new Map();
      const name = typeof update.name === "string" && update.name.trim() ? update.name.trim() : null;
      const known = entry.children.get(announced);
      if (known) {
        known.terminal = false;
        known.name = name ?? known.name;
      } else {
        entry.children.set(announced, { parentSessionId: sessionId, terminal: false, name });
      }
      this._sessionToChatId.set(announced, chatId);
    } else if (update?.sessionUpdate === "subagent_state_update" && announced) {
      const known = entry.children?.get(announced);
      if (known) known.terminal = true;
    }
    return child;
  }

  /**
   * A child session's frame, stamped `_meta.remiSessionId`. Only its billing
   * reaches the root prompt's collector (context occupancy is the child's own);
   * failures and compaction errors are redacted but never fail the root turn.
   */
  private _childUpdate(entry: PoolEntry, update: SessionUpdate, sessionId: string, requestedModel: string | null | undefined,
    modelSource: TaskUsageUnit["modelSource"], credentials: string[]): SessionUpdate {
    let next = update;
    if (next.sessionUpdate === "session_info_update") next = withRedactedSessionFailure(next, credentials).update;
    if (next.sessionUpdate === "usage_update") next = this._stampUsage(entry, next, requestedModel, modelSource, false);
    if (next.sessionUpdate === "compaction_update" || next.sessionUpdate === "tool_call_update") next = redactFailedFrame(next, credentials);
    return { ...next, _meta: { ...metaOf(next), remiSessionId: sessionId } } as SessionUpdate;
  }

  /**
   * A root frame of an autonomous round: the prompt's text, model, usage and
   * context carry on, as in `sendStream`; failures are only reported.
   */
  private _rootIdleUpdate(entry: PoolEntry, update: SessionUpdate, requestedModel: string | null | undefined,
    modelSource: TaskUsageUnit["modelSource"], credentials: string[]): SessionUpdate {
    let next = update;
    if (next.sessionUpdate === "session_info_update") next = withRedactedSessionFailure(next, credentials).update;
    this._applyConfigUpdate(entry, next);
    if (next.sessionUpdate === "usage_update") next = this._stampUsage(entry, next, requestedModel, modelSource, true);
    if (next.sessionUpdate === "agent_message_chunk" && !stampedParent(next)) {
      entry.promptState.text += extractChunkText((next as Record<string, any>).content);
    }
    if (next.sessionUpdate === "compaction_update" || next.sessionUpdate === "tool_call_update") next = redactFailedFrame(next, credentials);
    if (next.sessionUpdate === "tool_call_update") {
      const status = (next as { status?: unknown }).status;
      if (status === "completed" || status === "failed") entry.promptState.completedToolCount++;
    }
    return next;
  }

  /** A model or config change the agent reported for the root session. */
  private _applyConfigUpdate(entry: PoolEntry, update: SessionUpdate): void {
    if (update.sessionUpdate !== "config_option_update") return;
    if (update.configOptions) {
      entry.configOptions = update.configOptions;
    } else if (update.id === "model" && typeof update.value === "string") {
      const value = update.value;
      entry.configOptions = entry.configOptions?.map(option => option.type === "select" && (option.category === "model" || option.id === "model")
        ? { ...option, currentValue: value } : option);
      if (entry.models) entry.models = { ...entry.models, currentModelId: value };
    }
  }

  /**
   * Fold a `usage_update` into the current prompt's collector and stamp the
   * units it changed (`_meta.remiUsageUnits`). `context` false (a child
   * session, PR 5 §1.4) keeps it out of the root's context occupancy.
   */
  private _stampUsage(entry: PoolEntry, update: Extract<SessionUpdate, { sessionUpdate: "usage_update" }>,
    requestedModel: string | null | undefined, modelSource: TaskUsageUnit["modelSource"], context: boolean): SessionUpdate {
    accumulateUsage(entry.promptState.usage, update, requestedModel, modelSource, this._adapter.agentType, { context });
    const occupancy = !context || stampedParent(update)
      // A billing-only shim observation (size 0) says nothing about context.
      || (SHIM_USAGE_UPDATES.has(update) && !(update.size > 0))
      ? null : readContextUsage(update);
    if (occupancy) entry.promptState.contextUsage = occupancy;
    return { ...update, _meta: { ...update._meta,
      remiUsageUnits: entry.promptState.usage.collector.takeChangedUnits(this._adapter.agentType, requestedModel),
    } };
  }

  /**
   * The native agent a child session belongs to, as this provider registered
   * it from `subagent_spawned` (PR 5 §1.3): the agent id without the
   * generation suffix, and its announced name. Null for a root or unknown
   * session. Answers synchronously, while the announcement may still be
   * queued for the stream's consumer.
   */
  subagentSession(sessionId: string): { agentId: string; name: string | null } | null {
    for (const entry of this._pool.values()) {
      const child = entry.children?.get(sessionId);
      if (!child) continue;
      // Any generation's own announcement may carry the name; the first one does.
      const name = child.name ?? entry.children?.get(nativeAgentId(sessionId))?.name ?? null;
      return { agentId: nativeAgentId(sessionId), name };
    }
    return null;
  }

  /** Forget the entry's child sessions (wherever its root session is forgotten). */
  private _forgetChildren(entry: PoolEntry): void {
    for (const sessionId of entry.children?.keys() ?? []) this._sessionToChatId.delete(sessionId);
    entry.children?.clear();
  }

  /**
   * Native steering (ADR 0020): inject `text` into the prompt streaming for
   * `chatId`. Every failure is an outcome; the caller falls back to interrupt
   * and re-prompt for anything but `injected` (see {@link STEER_REASONS}).
   *
   * Before the wire call: no permission or question may be waiting for a
   * person, the bridge must have started the turn (a turn-level update), and,
   * for a bridge that backgrounds running calls, no top-level tool call may be
   * running (capped). A bridge `promptRequired` while our prompt still runs
   * is retried on the next turn-level update, within a bounded window.
   */
  async steer(text: string, options: { chatId?: string | null } = {}): Promise<SteerResult> {
    const entry = this._pool.get(options.chatId ?? "__default__");
    const prompt = entry?.promptInFlight;
    // Nothing to join: no wire call, the caller sends the text as a prompt.
    if (!entry || !prompt || !entry.client.alive) return NO_ACTIVE_PROMPT;
    const steering = this._adapter.steering;
    if (!steering || !entry.client.steeringSupported) return { outcome: "unsupported" };
    entry.steersInFlight = (entry.steersInFlight ?? 0) + 1;
    try {
      return await this._steerInto(entry, prompt, text, steering);
    } finally {
      entry.steersInFlight = Math.max(0, (entry.steersInFlight ?? 1) - 1);
    }
  }

  private async _steerInto(entry: PoolEntry, prompt: object, text: string, steering: NonNullable<AgentAdapter["steering"]>): Promise<SteerResult> {
    // The daemon steers only after onPromptStarted, so the turn has normally started already.
    let ready = await this._waitForSteerable(entry, prompt, () => (entry.turnUpdates ?? 0) > 0, Number.POSITIVE_INFINITY);
    let retryDeadline: number | null = null;
    for (let attempt = 1; ; attempt++) {
      if (ready === "ready" && steering.waitForToolCalls) {
        ready = await this._waitForSteerable(entry, prompt, () => !entry.openToolCalls?.size,
          Date.now() + (this._options.toolCallWaitMs ?? STEER_TOOL_CALL_WAIT_MS));
        if (ready === "timeout") return { outcome: "promptRequired", reason: STEER_REASONS.toolCallRunning };
      }
      if (ready === "ended") return NO_ACTIVE_PROMPT;
      if (ready === "userInput") return { outcome: "promptRequired", reason: STEER_REASONS.userInputPending };
      if (ready === "timeout") return { outcome: "promptRequired", reason: STEER_REASONS.noRunningTurn };
      const seen = entry.turnUpdates ?? 0;
      const result = await this._sendSteer(entry, text, steering);
      if (result.outcome === "startedNewTurn") await this._cancelBridgeTurn(entry);
      if (result.outcome !== "promptRequired") return result;
      if (entry.promptInFlight !== prompt || !entry.client.alive) return NO_ACTIVE_PROMPT;
      // The turn settled just before our prompt answers, or has not been
      // registered yet: try again on the next turn-level update.
      retryDeadline ??= Date.now() + (this._options.steerRetryWindowMs ?? STEER_RETRY_WINDOW_MS);
      if (attempt >= STEER_MAX_ATTEMPTS || Date.now() >= retryDeadline) {
        return { outcome: "promptRequired", reason: STEER_REASONS.noRunningTurn };
      }
      ready = await this._waitForSteerable(entry, prompt, () => (entry.turnUpdates ?? 0) > seen, retryDeadline);
    }
  }

  /** One `_session/steering` request, with the timeout and the outcome mapping. */
  private async _sendSteer(entry: PoolEntry, text: string, steering: NonNullable<AgentAdapter["steering"]>): Promise<SteerResult> {
    const timeoutMs = this._options.steerTimeoutMs ?? STEER_TIMEOUT_MS;
    const request = entry.client.steer(entry.acpSessionId, text, steering);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let response: SteerResponse | null | undefined;
    try {
      response = await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SteerTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof SteerTimeoutError) {
        // The bridge may still inject it, so the re-prompt can deliver it twice (R9).
        console.warn(`[AcpProvider] ${this._adapter.agentType} steer did not answer within ${timeoutMs}ms; falling back to re-prompt`);
        // Without the idle opt-in the bridge may still start a turn of its own
        // with this text once our prompt ends; settle it before re-prompting.
        if (!steering.idleOptIn) entry.lateSteer = request;
      }
      // A bridge that advertises steering but does not serve the method.
      if (error instanceof AcpRpcError && error.code === -32601) return { outcome: "unsupported" };
      const message = error instanceof Error ? error.message : String(error);
      return { outcome: "failed", error: redactProviderErrorText(message, this._credentials()).slice(0, 2_000) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const reason = typeof response?.reason === "string" && response.reason ? response.reason : undefined;
    const answered = response?.outcome;
    const outcome = TRACE_STEER_OUTCOMES.includes(answered as SteerOutcome) && answered !== "unsupported"
      ? answered as SteerOutcome : "failed";
    if (outcome === "failed") {
      return { outcome, ...(reason ? { reason } : {}),
        error: answered === "failed" ? reason ?? "The agent could not apply the steer" : `Unexpected steer outcome: ${String(answered)}` };
    }
    return { outcome, ...(reason ? { reason } : {}) };
  }

  /**
   * Wait until `ready()` holds for this prompt. A person-facing request beats
   * readiness: the caller must not steer while a permission or question waits.
   */
  private async _waitForSteerable(entry: PoolEntry, prompt: object, ready: () => boolean,
    deadline: number): Promise<"ready" | "ended" | "userInput" | "timeout"> {
    while (true) {
      if (entry.promptInFlight !== prompt || !entry.client.alive) return "ended";
      if ((entry.userInputs ?? 0) > 0) return "userInput";
      if (ready()) return "ready";
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "timeout";
      let timer: ReturnType<typeof setTimeout> | null = null;
      await new Promise<void>((resolve) => {
        entry.steerWaiters.add(resolve);
        // A missed wake costs at most a second.
        timer = setTimeout(resolve, Math.min(remaining, 1_000));
      });
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * A steer that timed out on a bridge without the idle opt-in may still start
   * a turn of its own once the previous prompt ended (codex-acp
   * `startNewTurnFromSteering`). Before the next prompt: wait for its answer,
   * cancel such a turn (D3), and stop a bridge that does not answer in time.
   */
  private async _settleLateSteer(entry: PoolEntry): Promise<void> {
    const late = entry.lateSteer;
    if (!late) return;
    entry.lateSteer = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const answer = await Promise.race([
      late.then((response) => response, () => null),
      new Promise<"pending">((resolve) => { timer = setTimeout(() => resolve("pending"), PROMPT_CANCEL_SETTLE_MS); }),
    ]);
    if (timer) clearTimeout(timer);
    if (answer === "pending") {
      console.warn(`[AcpProvider] ${this._adapter.agentType}: a timed-out steer is still unanswered; stopping the bridge before re-prompting`);
      await entry.client.stop();
    } else if (answer?.outcome === "startedNewTurn") {
      await this._cancelBridgeTurn(entry);
    }
  }

  /**
   * The bridge started a turn of its own (codex-acp's idle steer, D3). Cancel
   * it and wait until the session has been quiet for {@link STEER_QUIET_MS},
   * at most {@link PROMPT_CANCEL_SETTLE_MS}; a bridge that keeps talking is
   * stopped, as an unresponsive cancel is, so the next prompt never overlaps it.
   */
  private async _cancelBridgeTurn(entry: PoolEntry): Promise<void> {
    const cancelledAt = Date.now();
    await entry.client.cancel(entry.acpSessionId).catch(() => {});
    while (true) {
      const now = Date.now();
      const quietSince = Math.max(cancelledAt, entry.lastUpdateAt ?? 0);
      if (now - quietSince >= STEER_QUIET_MS) return;
      if (now - cancelledAt >= PROMPT_CANCEL_SETTLE_MS) break;
      await Bun.sleep(Math.min(50, STEER_QUIET_MS - (now - quietSince)));
    }
    console.warn(`[AcpProvider] ${this._adapter.agentType}: the bridge-started turn did not go quiet within `
      + `${PROMPT_CANCEL_SETTLE_MS / 1000}s of cancel; stopping the bridge before re-prompting`);
    await entry.client.stop();
  }

  /** Values of credential-like settings, redacted from provider errors. */
  private _credentials(): string[] {
    return [this._options.apiKey, ...Object.entries(this._options.env ?? {})
      .filter(([name]) => /(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)(?:_|$)/i.test(name))
      .map(([, value]) => value)].filter((value): value is string => Boolean(value));
  }

  /**
   * Updates that arrive while no stream is listening. Records activity for
   * the steer quiet-wait, registers announced child sessions, and keeps
   * `usage_update` frames for the next stream, so a bridge-started or
   * follow-up turn is still billed. While capturing autonomous rounds every
   * accepted frame is kept (PR 5 §2.3), up to {@link MAX_AUTONOMOUS_FRAMES} or
   * {@link MAX_AUTONOMOUS_BYTES}; the oldest non-usage frame goes first. A
   * bridge that starts a turn of its own without that (Codex D3) keeps only
   * the billing: its text is discarded.
   */
  private _handleIdleUpdate(client: AcpClient, notification: SessionNotification): void {
    for (const [chatId, entry] of this._pool) {
      if (entry.client !== client) continue;
      if (this._routeFrame(chatId, entry, notification) === undefined) return;
      entry.lastUpdateAt = Date.now();
      entry.idleFrames ??= [];
      if (this._capturesAutonomousRounds) {
        entry.idleFrames.push(notification);
        entry.idleFrameBytes = (entry.idleFrameBytes ?? 0) + frameBytes(notification);
        let dropped = 0;
        while (entry.idleFrames.length > MAX_AUTONOMOUS_FRAMES
          || (entry.idleFrameBytes > MAX_AUTONOMOUS_BYTES && entry.idleFrames.length > 1)) {
          const index = entry.idleFrames.findIndex((frame) => frame.update?.sessionUpdate !== "usage_update");
          const [removed] = entry.idleFrames.splice(index >= 0 ? index : 0, 1);
          entry.idleFrameBytes -= frameBytes(removed!);
          dropped++;
        }
        if (dropped) {
          console.warn(`[AcpProvider] ${this._adapter.agentType}: dropped ${dropped} frame(s) received between prompts (buffer full)`);
        }
        return;
      }
      if (notification.update?.sessionUpdate !== "usage_update") return;
      entry.idleFrames.push(notification);
      if (entry.idleFrames.length > MAX_IDLE_USAGE_FRAMES) {
        entry.idleFrames.splice(0, entry.idleFrames.length - MAX_IDLE_USAGE_FRAMES);
        console.warn(`[AcpProvider] ${this._adapter.agentType}: dropped the oldest usage frames received between prompts`);
      }
      return;
    }
  }

  async healthCheck(): Promise<boolean> {
    let check: AcpHealthCheckCommand;
    try {
      check = resolveAcpHealthCheckCommand(
        this._adapter.agentType,
        this._options.executable,
        this._adapter.defaultExecutable(),
      );
    } catch (error) {
      // A retired executable override.
      console.error(`[acp] ${this._adapter.agentType} health check failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (check.failure) {
      console.error(`[acp] ${this._adapter.agentType} health check failed: ${check.failure}`);
      return false;
    }
    // No probe args → existence is the whole check (e.g. codex-acp).
    if (!check.args) {
      const ok = acpExecutableResolves(check.command);
      if (!ok) {
        console.error(`[acp] ${this._adapter.agentType} health check failed: executable not found (${check.command})`);
      }
      return ok;
    }
    const probeArgs = check.args;
    const { spawn } = await import("node:child_process");
    // Async spawn, NOT execFileSync: Bun's spawnSync hangs forever spawning
    // some node ACP scripts, which silently dropped a healthy provider from
    // daemon registration. stdin/stdout/stderr are /dev/null so the child can't
    // block on them; we only need the exit code. On failure we log the reason —
    // a swallowed health check is how a healthy provider silently vanishes.
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let stderr = "";
      const launch = resolveAcpProcessLaunch(check.command, probeArgs);
      const child = spawn(launch.executable, launch.args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        env: { ...process.env, ...this._options.env },
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 2000) stderr += String(chunk);
      });
      const finish = (ok: boolean, reason?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.kill("SIGKILL");
        } catch {}
        if (!ok && reason) {
          const detail = stderr.trim() ? ` — ${stderr.trim().slice(0, 400)}` : "";
          console.error(`[acp] ${this._adapter.agentType} health check failed (${check.command} ${probeArgs.join(" ")}): ${reason}${detail}`);
        }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false, "timed out"), 15000);
      child.on("error", (err) => finish(false, err.message));
      child.on("exit", (code) => finish(code === 0, code === 0 ? undefined : `exit ${code}`));
    });
  }

  // ── Session pool management ────────────────────────────────────

  private async _ensureSession(chatId: string, options?: SendOptions): Promise<PoolEntry> {
    const pluginOptions = options as SendOptions & AcpAgentPluginSendOptions | undefined;
    const permissionMode = resolveAcpPermissionMode(this._adapter.agentType, options?.permissionMode);
    const cwd = options?.cwd ?? this._options.cwd ?? homedir();
    const mcpServers = this._options.getMcpServers?.() ?? [];
    const mcpServersKey = JSON.stringify(mcpServers);
    const model = options?.model ?? this._options.model ?? null;
    const startupModel = this._adapter.agentType === "claude" ? model : null;
    const customModelOption = this._adapter.agentType === "claude"
      ? resolveClaudeContextSelection(model, this._options.claudeOneMillionModels).customModelOption
      : null;
    const effort = options?.effort ?? null;
    const pluginPaths = absolutePluginPaths(pluginOptions?.pluginPaths ?? this._options.pluginPaths);
    const pluginPathsKey = JSON.stringify(pluginPaths);
    const pluginFingerprint = cleanFingerprint(
      pluginOptions?.pluginFingerprint ?? this._options.pluginFingerprint,
      pluginPathsKey,
    );
    const codexHome = this._adapter.agentType === "codex"
      ? absoluteCodexHome(pluginOptions?.codexHome ?? this._options.codexHome)
      : null;
    if (this._adapter.agentType === "codex" && pluginPaths.length && !codexHome) {
      throw new Error("Codex Agent Plugins require an isolated CODEX_HOME");
    }

    const sessionMeta = this._adapter.buildSessionMeta({
      model,
      claudeEnv: customModelOption ? { ANTHROPIC_CUSTOM_MODEL_OPTION: customModelOption } : undefined,
      claudeSettings: this._options.claudeSettings,
      allowedTools: options?.allowedTools ?? this._options.allowedTools,
      systemPrompt: options?.systemPrompt,
      pluginPaths,
      home: this._options.providerHome,
      cwd,
    } as Parameters<AgentAdapter["buildSessionMeta"]>[0]);

    const existing = this._pool.get(chatId);
    // Unbilled frames survive a process replacement (e.g. the bridge stopped
    // after a bridge-started turn would not go quiet); a captured autonomous
    // round does not (PR 5 §1.5): its children died with the process.
    let idleFrames: SessionNotification[] = [];
    if (existing) {
      const stale =
        !existing.client.alive ||
        // The shim breaker opened for this process's token; a new process gets a new one.
        !!existing.gateway?.fatal ||
        existing.cwd !== cwd ||
        existing.mcpServersKey !== mcpServersKey ||
        existing.pluginPathsKey !== pluginPathsKey ||
        existing.pluginFingerprint !== pluginFingerprint ||
        existing.codexHome !== codexHome ||
        existing.customModelOption !== customModelOption ||
        existing.startupModel !== startupModel;
      if (stale && existing.client.alive) {
        const reason = existing.gateway?.fatal ? `gateway unavailable (${existing.gateway.fatal.reason})` : existing.cwd !== cwd
          ? `cwd ${existing.cwd} -> ${cwd}`
          : existing.mcpServersKey !== mcpServersKey
            ? "mcpServers changed"
            : existing.pluginFingerprint !== pluginFingerprint || existing.pluginPathsKey !== pluginPathsKey
              ? "Agent Plugins changed"
              : existing.customModelOption !== customModelOption
                ? "Claude context declaration changed"
                : existing.startupModel !== startupModel
                  ? `startup model ${existing.startupModel} -> ${model}`
                  : "CODEX_HOME changed";
        console.warn(
          `[acp] ${this._adapter.agentType}: recreating session for ${chatId} — ` +
            `${reason} (fixed at process/session creation and cannot be re-applied)`,
        );
      }
      if (stale) {
        idleFrames = (existing.idleFrames ?? []).filter((frame) => frame.update?.sessionUpdate === "usage_update");
        await this._discardEntry(chatId, existing);
      } else {
        try {
          if (options?.sessionId && options.sessionId !== existing.acpSessionId) {
            this._sessionToChatId.delete(existing.acpSessionId);
            // The registry holds live children only (PR 5 §1.5); a load replays none into it.
            this._forgetChildren(existing);
            dropCapturedRound(existing);
            const addDirs = absoluteAdditionalDirectories(options.addDirs, this._adapter.agentType);
            const officialAddDirs = !!existing.client.initializeResult?.agentCapabilities?.sessionCapabilities?.additionalDirectories;
            const meta = addDirs.length && !officialAddDirs
              ? { ...(sessionMeta ?? {}), additionalRoots: addDirs } : sessionMeta;
            const result = await existing.client.loadSession(options.sessionId, cwd, mcpServers, {
              additionalDirectories: officialAddDirs ? addDirs : undefined, _meta: meta,
            });
            existing.acpSessionId = result.sessionId;
            this._adoptSessionState(existing, result);
            this._sessionToChatId.set(existing.acpSessionId, chatId);
          }
          await this._applyMode(existing, permissionMode);
          await this._applyModelAndEffort(existing, model, effort);
          return existing;
        } catch (error) {
          // A model switch can rewrite the effort selector before we learn that
          // an explicit effort is unsupported. Never leave that half-applied
          // state in the warm pool for the next turn.
          await this._discardEntry(chatId, existing);
          throw error;
        }
      }
    }

    const env: Record<string, string> = {};
    // Anthropic credentials are meaningless to a codex process and would put an
    // Anthropic key in its environment for nothing.
    if (this._adapter.agentType === "claude") {
      if (this._options.apiKey) env.ANTHROPIC_API_KEY = this._options.apiKey;
      if (this._options.baseUrl) env.ANTHROPIC_BASE_URL = this._options.baseUrl;
    }
    if (this._options.env) Object.assign(env, this._options.env);
    // The bridge's current-model/effort state reads its process env, not startup metadata.
    if (startupModel) env.ANTHROPIC_MODEL = startupModel;
    if (codexHome) env.CODEX_HOME = codexHome;

    const launch = this._resolveLaunch();
    let gateway: GatewayState | undefined;
    if (this._access) {
      const home = this._options.providerHome?.trim();
      if (this._access.requiresHome && !(home && isAbsolute(home))) {
        throw new Error(`[${this._adapter.agentType}_home_required] ${this._adapter.agentType} needs an absolute session home`);
      }
      if (this._access.usage === "gateway-shim" && this._options.gatewayShim) {
        gateway = openGateway(this._options.gatewayShim, `${this._adapter.agentType}:${chatId}`);
      }
      const shimUrl = gateway?.channel?.baseUrl ?? this._options.gatewayUrl;
      if (!shimUrl) {
        throw new Error(`[${this._adapter.agentType}_gateway_unconfigured] ${this._adapter.agentType} runs only through the `
          + "workspace Model gateway; configure it under Model gateway");
      }
      try {
        // Last, so the access config owns home, routing and the blanked credentials.
        Object.assign(env, this._access.buildEnv({
          home: home!, shimUrl, model, daemonEnv: { ...process.env, ...this._options.env },
          launch: launch.pinned ? { executable: launch.executable, args: launch.args ?? [] } : null,
        }));
      } catch (error) {
        closeGateway(gateway);
        throw error;
      }
    }

    const client = new AcpClient({
      inheritProcessGroup: this._options.inheritProcessGroup,
      executable: launch.executable,
      args: launch.args,
      agentType: this._adapter.agentType,
      nativeSubagents: this._options.nativeSubagentSessions ? this._adapter.nativeSubagents ?? null : null,
      cwd,
      privateTmpDirectory: this._options.privateTmpDirectory,
      privateTmpPlatform: this._options.privateTmpPlatform,
      env,
      onPermissionRequest: (params) => this._handlePermission(params),
      onElicitationRequest: (params) => this._handleElicitation(params),
      onSessionUpdate: (notification) => this._handleIdleUpdate(client, notification),
      onProcessExit: (reason) => this._handleClientDeath(client, reason),
      log: (...args) => {
        if (process.env.REMI_DEBUG) console.error(...args);
      },
    });

    this._startingClients.add(client);
    try {
      await client.start();
      const initializeResult = await client.initialize();

      // Official field when the agent advertises it, `_meta.additionalRoots`
      // otherwise — both pinned bridges read the meta form as the compatibility
      // fallback (claude-agent-acp dist/acp-agent.js:4549; codex-acp
      // dist/index.js:27064-27072).
      const addDirs = absoluteAdditionalDirectories(options?.addDirs, this._adapter.agentType);
      const officialAddDirs = !!initializeResult.agentCapabilities?.sessionCapabilities?.additionalDirectories;
      const meta: NewSessionMeta | undefined =
        addDirs.length && !officialAddDirs ? { ...(sessionMeta ?? {}), additionalRoots: addDirs } : sessionMeta;
      const additionalDirectories = officialAddDirs ? addDirs : undefined;

      const result = options?.sessionId
        ? await client.resumeSession(options.sessionId, cwd, mcpServers, { additionalDirectories, _meta: meta })
        : await client.newSession({ cwd, mcpServers, additionalDirectories, _meta: meta });

      const entry: PoolEntry = {
        client,
        acpSessionId: result.sessionId,
        lastUsed: Date.now(),
        promptState: createPromptState(),
        cwd,
        mcpServersKey,
        pluginPathsKey,
        pluginFingerprint,
        codexHome,
        customModelOption,
        startupModel,
        appliedModel: null,
        attemptedModel: null,
        appliedContext: null,
        appliedEffort: null,
        warnedPermissionMode: null,
        ...(gateway ? { gateway } : {}),
        promptInFlight: null,
        lastUpdateAt: 0,
        openToolCalls: new Set(),
        steerWaiters: new Set(),
        turnUpdates: 0,
        userInputs: 0,
        lateSteer: null,
        idleFrames,
        children: new Map(),
      };
      this._adoptSessionState(entry, result);
      // Server 1.4.0 never fails `session/new` on a refused listing: it falls
      // back to built-in model ids. A failure the shim saw is the real cause.
      if (gateway?.fatal) throw gatewaySessionFailure(this._adapter.agentType, gateway.fatal, credentialsOf(this._options));
      await this._applyMode(entry, permissionMode);
      try {
        await this._applyModelAndEffort(entry, model, effort);
      } catch (error) {
        const problem = gateway?.fatal ?? gateway?.listingFailure;
        if (problem) throw gatewaySessionFailure(this._adapter.agentType, problem, credentialsOf(this._options), error);
        throw error;
      }

      this._pool.set(chatId, entry);
      this._sessionToChatId.set(entry.acpSessionId, chatId);
      this._startCleanupTimer();
      this._startingClients.delete(client);
      return entry;
    } catch (error) {
      this._startingClients.delete(client);
      await client.stop();
      closeGateway(gateway);
      throw error;
    }
  }

  /**
   * The executable and args to spawn. An Agent `executable` override wins (and
   * keeps its own args); otherwise an access config supplies its pinned launch.
   */
  private _resolveLaunch(): { executable: string; args: string[] | undefined; pinned: boolean } {
    const explicit = this._options.executable?.trim();
    const executable = resolveAcpExecutableForAgent(this._adapter.agentType, this._options.executable, this._adapter.defaultExecutable());
    if (!this._access || explicit) return { executable, args: this._options.args, pinned: false };
    const pinned = this._access.launch();
    if (this._options.args?.length) {
      console.warn(`[acp] ${this._adapter.agentType}: ignoring custom args without an executable override`);
    }
    return { executable: pinned.executable, args: pinned.args, pinned: true };
  }

  /** Record what the agent advertised for a freshly created/loaded session. */
  private _adoptSessionState(entry: PoolEntry, result: NewSessionResult): void {
    entry.modes = result.modes;
    entry.configOptions = result.configOptions;
    entry.models = result.models;
    // Apply the declaration once even when new/resume/load already selected the ID.
    entry.appliedModel = currentConfigValue(result.configOptions, MODEL_OPTION_CATEGORY) ?? result.models?.currentModelId ?? null;
    entry.attemptedModel = this._adapter.agentType === "claude" ? null : entry.appliedModel;
    entry.appliedContext = null;
    entry.appliedEffort = currentConfigValue(result.configOptions, EFFORT_OPTION_CATEGORY);
  }

  /**
   * The pooled agent process died without stop(). Evict the entry immediately
   * so the next turn resumes on a fresh process instead of writing into a dead
   * pipe, and wake any stream currently iterating this chat — with zero
   * in-flight JSON-RPC requests, the client's own rejection path has no
   * consumer (the MUL-63 wedge: dead run, cancel inert, task pending forever).
   */
  private _handleClientDeath(client: AcpClient, reason: string): void {
    for (const [chatId, entry] of this._pool) {
      if (entry.client !== client) continue;
      this._pool.delete(chatId);
      this._sessionToChatId.delete(entry.acpSessionId);
      this._forgetChildren(entry);
      closeGateway(entry.gateway);
      console.error(`[AcpProvider] ${this._adapter.agentType} agent for ${chatId} died (${reason}); session evicted`);
      this._deathListeners.get(chatId)?.(reason);
    }
  }

  private async _discardEntry(chatId: string, entry: PoolEntry): Promise<void> {
    try {
      if (entry.client.alive) await entry.client.closeSession(entry.acpSessionId);
    } catch {}
    await entry.client.stop();
    closeGateway(entry.gateway);
    this._sessionToChatId.delete(entry.acpSessionId);
    this._forgetChildren(entry);
    this._pool.delete(chatId);
  }

  private async _applyMode(entry: PoolEntry, permissionMode: string | null): Promise<void> {
    const effectiveMode = resolveAvailableAcpPermissionMode(permissionMode, entry.modes, this._adapter);
    // Report a translation or a skip once per session, not once per turn.
    if (effectiveMode !== permissionMode && permissionMode !== entry.warnedPermissionMode) {
      entry.warnedPermissionMode = permissionMode;
      const available = entry.modes?.availableModes.map((m) => m.id).join(", ") ?? "unknown";
      console.warn(
        `[acp] ${this._adapter.agentType}: permission mode "${permissionMode}" is not advertised ` +
          `(available: ${available}) — ` +
          (effectiveMode
            ? `using "${effectiveMode}"`
            : `keeping the agent's "${entry.modes?.currentModeId}"`),
      );
    }
    if (!effectiveMode) return;
    await entry.client.setMode(entry.acpSessionId, effectiveMode);
    if (entry.modes) entry.modes = { ...entry.modes, currentModeId: effectiveMode };
  }

  private async _applyModel(entry: PoolEntry, model: string): Promise<void> {
    if (model === entry.attemptedModel && entry.appliedContext === entry.customModelOption) return;
    if (entry.customModelOption) {
      try {
        await this._setConfigOption(entry, MODEL_OPTION_CATEGORY, entry.customModelOption);
      } catch (error) {
        if (!entry.client.alive) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        const applied = await this._setConfigOption(entry, MODEL_OPTION_CATEGORY, model);
        const actual = currentConfigValue(entry.configOptions, MODEL_OPTION_CATEGORY) ?? entry.models?.currentModelId ?? null;
        console.warn(
          `[acp_model_context_fallback] claude: model="${model}", selection="${entry.customModelOption}": ${reason}; ` +
            `actual="${actual ?? "unknown"}"; ` +
            (applied && actual === model ? "running with the standard context window"
              : "standard model not confirmed; keeping the agent's actual selection"),
        );
      }
    } else if (!await this._setConfigOption(entry, MODEL_OPTION_CATEGORY, model)) {
      return;
    }
    // Cache the attempt separately: a skipped fallback must not claim the requested model was applied.
    entry.appliedModel = currentConfigValue(entry.configOptions, MODEL_OPTION_CATEGORY) ?? entry.models?.currentModelId ?? null;
    entry.attemptedModel = model;
    entry.appliedContext = entry.customModelOption;
    entry.appliedEffort = currentConfigValue(entry.configOptions, EFFORT_OPTION_CATEGORY);
  }

  /**
   * Model first, then effort: switching rewrites the valid effort values and
   * may reset or retain the current effort, depending on the bridge.
   */
  private async _applyModelAndEffort(entry: PoolEntry, model: string | null, effort: string | null): Promise<void> {
    if (model) await this._applyModel(entry, model);
    const requestedEffort = effort?.trim() || null;
    if (requestedEffort) {
      const option = selectConfigOption(entry.configOptions, EFFORT_OPTION_CATEGORY);
      const supported = option
        ? flattenSelectOptions(option)
            .map((item) => item.value)
            .filter((value) => !isAcpDefaultSentinel(value))
        : [];
      if (!option || !supported.includes(requestedEffort)) {
        throw new UnsupportedAcpEffortError(
          this._adapter.agentType,
          currentConfigValue(entry.configOptions, MODEL_OPTION_CATEGORY) ?? model,
          requestedEffort,
          supported,
        );
      }
      if (requestedEffort === entry.appliedEffort) return;
      const result = await entry.client.setConfigOption(entry.acpSessionId, option.id, requestedEffort);
      if (result?.configOptions) entry.configOptions = result.configOptions;
      if (this._adapter.agentType === "codex"
        && currentConfigValue(entry.configOptions, EFFORT_OPTION_CATEGORY) !== requestedEffort) {
        throw new Error(`[acp_effort_unacknowledged] ${this._adapter.agentType}: the agent did not select effort "${requestedEffort}"`);
      }
      entry.appliedEffort = requestedEffort;
    }
  }

  private async _setConfigOption(entry: PoolEntry, category: string, value: string): Promise<boolean> {
    const option = selectConfigOption(entry.configOptions, category);
    if (option?.currentValue === value) return true;
    if (!option && category === MODEL_OPTION_CATEGORY
      && entry.models?.currentModelId.replace(/\[[^\]]*\]$/, "") === value) return true;
    const claudeOneMillion = this._adapter.agentType === "claude"
      && category === MODEL_OPTION_CATEGORY && hasOneMillionContext(value);
    let change = resolveConfigOptionChange(entry.configOptions, category, value);
    if (!change && claudeOneMillion) {
      const option = selectConfigOption(entry.configOptions, category);
      if (option?.currentValue === value) return true;
      if (!option) throw new Error(`[acp_model_context_unsupported] Claude cannot select ${value}: no model selector`);
      // Claude ACP resolves full IDs against its SDK modelInfos, including
      // resolvedModel aliases (e.g. claude-opus-5-5[1m] -> opus[1m]).
      // Let that resolver validate the request; never silently drop the hint.
      change = { configId: option.id, value };
    }
    if (!change) {
      if (!this._strictModel) {
        // Claude's session metadata can already select a full SDK model ID
        // while its picker reports an alias. Preserve that existing path;
        // the explicit 1M resolver above still validates context selection.
        console.warn(`[acp] ${this._adapter.agentType}: skipping ${category}="${value}" — the agent does not offer it`);
        return false;
      }
      throw new UnsupportedAcpModelError(
        this._adapter.agentType,
        value,
        option ? flattenSelectOptions(option).map((item) => item.value) : [],
        currentConfigValue(entry.configOptions, MODEL_OPTION_CATEGORY) ?? entry.models?.currentModelId,
      );
    }
    const result = await entry.client.setConfigOption(entry.acpSessionId, change.configId, change.value);
    if (result?.configOptions) entry.configOptions = result.configOptions;
    if (claudeOneMillion) {
      const selected = currentConfigValue(entry.configOptions, category);
      const selectedOption = selectConfigOption(entry.configOptions, category);
      const declaredCustomRow = entry.customModelOption === value && selectedOption
        && flattenSelectOptions(selectedOption).some(item => item.value === selected && item.description?.includes(value));
      if (!selected || (!hasOneMillionContext(selected) && !declaredCustomRow)) {
        throw new Error(`[acp_model_context_unsupported] Claude did not select ${value} (selected: ${selected ?? "unknown"})`);
      }
    } else if (this._strictModel
      && category === MODEL_OPTION_CATEGORY && currentConfigValue(entry.configOptions, category) !== value) {
      throw new UnsupportedAcpModelError(
        this._adapter.agentType,
        value,
        option ? flattenSelectOptions(option).map((item) => item.value) : [],
        currentConfigValue(entry.configOptions, category),
      );
    }
    return true;
  }

  /** The permission modes this chat's agent advertised, for `/switch`. */
  advertisedModes(chatId: string): SessionModeState | undefined {
    return this._pool.get(chatId)?.modes;
  }

  private async _handlePermission(params: RequestPermissionParams): Promise<PermissionOutcome> {
    if (this._access?.denyWorkspaceTrust && isWorkspaceTrustPrompt(params)) {
      // Seeded `untrusted` already suppresses repository hooks; never trust them on a model's behalf.
      return { outcome: "selected", optionId: "deny" };
    }
    if (this._access?.permissionQuestions) {
      const question = permissionAsQuestion(params);
      // Not a tool approval: the daemon's auto-approve would answer the model's question arbitrarily.
      if (question) return this._permissionQuestion(params, question);
    }
    const chatId = this._sessionToChatId.get(params.sessionId);
    const handler = (chatId ? this._permissionHandlers.get(chatId) : undefined) ?? this._permissionHandler;
    if (handler) {
      return this._whileUserInput(chatId, () => handler(params));
    }
    console.error(`[AcpProvider] permission request cancelled: no handler for session ${params.sessionId}`);
    return { outcome: "cancelled" };
  }

  /** A single-choice question asked through `session/request_permission`, answered through the elicitation handler. */
  private async _permissionQuestion(params: RequestPermissionParams, question: PermissionQuestion): Promise<PermissionOutcome> {
    const field = "answer";
    const result = await this._handleElicitation({
      mode: "form",
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      message: question.question,
      requestedSchema: {
        type: "object",
        properties: { [field]: { type: "string", oneOf: question.options.map((option) => ({ const: option.label, title: option.label })) } },
        required: [field],
      },
    });
    const answer = result.action === "accept" ? result.content?.[field] : undefined;
    const chosen = typeof answer === "string" ? question.options.find((option) => option.label === answer.trim()) : undefined;
    return chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" };
  }

  private async _handleElicitation(params: ElicitationCreateParams): Promise<ElicitationResult> {
    const chatId = this._sessionToChatId.get(params.sessionId);
    const handler = (chatId ? this._elicitationHandlers.get(chatId) : undefined) ?? this._elicitationHandler;
    if (handler) {
      return this._whileUserInput(chatId, () => handler(params));
    }
    console.error(`[AcpProvider] elicitation request cancelled: no handler for session ${params.sessionId}`);
    return { action: "cancel" };
  }

  /**
   * A permission or question is with the daemon (in ask mode, a card waits
   * for a person): a native steer must not be sent meanwhile (ADR 0020).
   */
  private async _whileUserInput<T>(chatId: string | undefined, handle: () => Promise<T>): Promise<T> {
    const entry = chatId ? this._pool.get(chatId) : undefined;
    if (!entry) return handle();
    entry.userInputs = (entry.userInputs ?? 0) + 1;
    wakeSteerWaiters(entry);
    try {
      return await handle();
    } finally {
      entry.userInputs--;
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────

  private _startCleanupTimer(): void {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => this._cleanupIdle(), CLEANUP_INTERVAL_MS);
  }

  private async _cleanupIdle(): Promise<void> {
    const now = Date.now();
    for (const [chatId, entry] of this._pool) {
      if (this._activeStreaming.has(chatId)) continue;
      if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
        try {
          await entry.client.closeSession(entry.acpSessionId);
          await entry.client.stop();
        } catch {}
        closeGateway(entry.gateway);
        this._sessionToChatId.delete(entry.acpSessionId);
        this._forgetChildren(entry);
        this._permissionHandlers.delete(chatId);
        this._elicitationHandlers.delete(chatId);
        this._pool.delete(chatId);
      }
    }
    if (this._pool.size === 0 && this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  async clearSession(chatId?: string): Promise<void> {
    if (chatId) {
      const entry = this._pool.get(chatId);
      if (entry) {
        try { await entry.client.closeSession(entry.acpSessionId); } catch {}
        await entry.client.stop();
        closeGateway(entry.gateway);
        this._sessionToChatId.delete(entry.acpSessionId);
        this._forgetChildren(entry);
        this._permissionHandlers.delete(chatId);
        this._elicitationHandlers.delete(chatId);
        this._pool.delete(chatId);
      }
    } else {
      for (const [, entry] of this._pool) {
        try { await entry.client.closeSession(entry.acpSessionId); } catch {}
        await entry.client.stop();
        closeGateway(entry.gateway);
        this._sessionToChatId.delete(entry.acpSessionId);
        this._forgetChildren(entry);
      }
      this._pool.clear();
      this._permissionHandlers.clear();
      this._elicitationHandlers.clear();
    }
  }

  async close(): Promise<void> {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    const starting = [...this._startingClients];
    this._startingClients.clear();
    await Promise.allSettled(starting.map((client) => client.stop()));
    await this.clearSession();
  }
}

/** Updates that only a running turn sends: text, thoughts, tool calls, plans, usage. */
function isTurnLevelUpdate(update: SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "plan":
    case "usage_update":
      return true;
    default:
      return false;
  }
}

/** A child session's announcement or end (PR 5): turn activity of an autonomous round. */
function isSubagentLifecycle(update: SessionUpdate): boolean {
  return update.sessionUpdate === "subagent_spawned" || update.sessionUpdate === "subagent_state_update";
}

/** A frame claude-agent-acp stamped with the subagent call it belongs to (`_meta.claudeCode.parentToolUseId`). */
function stampedParent(update: SessionUpdate): boolean {
  return !!(metaOf(update)?.claudeCode as { parentToolUseId?: unknown } | undefined)?.parentToolUseId;
}

/** A frame's `_meta`; ACP lets every update carry one, though not every contract type spells it. */
function metaOf(update: SessionUpdate): Record<string, unknown> | undefined {
  return (update as { _meta?: Record<string, unknown> })._meta;
}

/** A `session_info_update` with its AIR session failure redacted, and that failure. */
function withRedactedSessionFailure(update: SessionUpdate, credentials: readonly string[]): { update: SessionUpdate; failure: AcpSessionFailure | null } {
  const meta = metaOf(update);
  const failure = readSessionFailure(meta, credentials);
  if (!failure) return { update, failure: null };
  return { failure, update: {
    ...update, _meta: { ...meta, jetbrains: {
      ...record(record(meta)?.jetbrains), air: { ...airMetadata(meta), sessionFailure: failure },
    } },
  } as SessionUpdate };
}

/** A failed compaction (its `compaction_update`, or Claude's failed /compact tool call) with credentials redacted. */
function redactFailedFrame(update: SessionUpdate, credentials: readonly string[]): SessionUpdate {
  const frame = update as { sessionUpdate: string; status?: unknown; _meta?: unknown };
  const failed = frame.status === "failed"
    && (frame.sessionUpdate === "compaction_update" || record(record(frame._meta)?.contextCompaction) !== null);
  if (!failed) return update;
  return JSON.parse(JSON.stringify(update, (_key, value) =>
    typeof value === "string" ? redactProviderErrorText(value, credentials) : value));
}

function frameBytes(notification: SessionNotification): number {
  try { return Buffer.byteLength(JSON.stringify(notification)); } catch { return 0; }
}

/** The frames kept between prompts, oldest first, leaving the buffer empty. */
function takeIdleFrames(entry: PoolEntry): SessionNotification[] {
  entry.idleFrameBytes = 0;
  return (entry.idleFrames ?? []).splice(0);
}

/** Drop a captured autonomous round, keeping only its billing (PR 5 §1.5: before a load or resume). */
function dropCapturedRound(entry: PoolEntry): void {
  entry.idleFrames = (entry.idleFrames ?? []).filter((frame) => frame.update?.sessionUpdate === "usage_update");
  entry.idleFrameBytes = entry.idleFrames.reduce((sum, frame) => sum + frameBytes(frame), 0);
}

/** Keep the prompt's running top-level tool calls; subagent calls carry a parent. */
function trackToolCall(entry: PoolEntry, update: SessionUpdate): void {
  const call = update as { sessionUpdate: string; toolCallId?: unknown; status?: unknown; _meta?: Record<string, any> };
  if (!entry.openToolCalls || typeof call.toolCallId !== "string" || call._meta?.claudeCode?.parentToolUseId) return;
  if (call.status === "completed" || call.status === "failed") {
    if (entry.openToolCalls.delete(call.toolCallId) && !entry.openToolCalls.size) wakeSteerWaiters(entry);
  } else if (call.sessionUpdate === "tool_call") {
    entry.openToolCalls.add(call.toolCallId);
  }
}

function wakeSteerWaiters(entry: PoolEntry): void {
  if (!entry.steerWaiters?.size) return;
  const waiters = [...entry.steerWaiters];
  entry.steerWaiters.clear();
  for (const wake of waiters) wake();
}

class SteerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Steer did not answer within ${timeoutMs}ms`);
    this.name = "SteerTimeoutError";
  }
}

function abortableEnsureSession(promise: Promise<PoolEntry>, signal?: AbortSignal): Promise<PoolEntry> {
  if (!signal) return promise;

  const stopAfterAbort = (entry: PoolEntry) => {
    entry.client.stop().catch(() => {});
  };

  if (signal.aborted) {
    promise.then(stopAfterAbort).catch(() => {});
    return Promise.reject(new Error("Cancelled"));
  }

  return new Promise((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      signal.removeEventListener("abort", onAbort);
      promise.then(stopAfterAbort).catch(() => {});
      reject(new Error("Cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((entry) => {
      signal.removeEventListener("abort", onAbort);
      if (aborted || signal.aborted) {
        stopAfterAbort(entry);
        reject(new Error("Cancelled"));
        return;
      }
      resolve(entry);
    }).catch((err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function buildMediaContent(
  media?: SendOptions["media"],
): Array<{ type: string; data: string; mimeType: string }> | undefined {
  if (!media?.length) return undefined;
  return media
    .filter((m) => m.mediaType === "image" || m.mediaType === "sticker")
    .map((m) => ({
      type: "image",
      data: m.buffer.toString("base64"),
      mimeType: m.contentType || "image/png",
    }));
}

/**
 * codex-acp rejects the whole `session/new` with -32602 when any entry is
 * relative or empty (dist/index.js:27078-27088), so a misconfigured extra root
 * must not be able to take the session down with it.
 */
function absoluteAdditionalDirectories(addDirs: string[] | undefined, agentType: string): string[] {
  if (!addDirs?.length) return [];
  const kept = addDirs.filter((dir) => dir && isAbsolute(dir));
  const dropped = addDirs.filter((dir) => !kept.includes(dir));
  if (dropped.length) {
    console.warn(`[acp] ${agentType}: ignoring non-absolute additionalDirectories: ${dropped.join(", ")}`);
  }
  return kept;
}

function absolutePluginPaths(paths: string[] | undefined): string[] {
  if (!paths?.length) return [];
  const unique = new Set<string>();
  for (const path of paths) {
    const normalized = typeof path === "string" ? path.trim() : "";
    if (!normalized || !isAbsolute(normalized)) {
      throw new Error(`Agent Plugin path must be absolute: ${JSON.stringify(path)}`);
    }
    unique.add(normalized);
  }
  return [...unique];
}

function absoluteCodexHome(value: string | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return null;
  if (!isAbsolute(normalized)) {
    throw new Error(`CODEX_HOME must be absolute: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function cleanFingerprint(value: string | undefined, pluginPathsKey: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || `paths:${pluginPathsKey}`;
}

function extractChunkText(content: unknown): string {
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

/**
 * Actual request telemetry is authoritative. Claude's whole-turn settle can
 * expose unattributed work; Codex's last-request settle is only a partial
 * fallback. Context occupancy is never consumption.
 */
export function resolvePromptUsage(
  streamed: PromptUsageState,
  settle: PromptResult["usage"],
  settleScope: PromptUsageSettleScope,
): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number } {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  for (const entry of streamed.collector.units("", null, settle, settleScope)) {
    if (entry.source === "context_snapshot") continue;
    totals.inputTokens += entry.inputTokens ?? 0;
    totals.outputTokens += entry.outputTokens ?? 0;
    totals.cacheReadTokens += entry.cacheReadTokens ?? 0;
    totals.cacheWriteTokens += entry.cacheWriteTokens ?? 0;
    totals.totalTokens += (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0) + (entry.cacheReadTokens ?? 0)
      + (entry.cacheWriteTokens ?? 0) + (entry.actualUnsplitTokens ?? 0);
  }
  return totals;
}

/**
 * Add the native rollout's requests for this prompt. They share the bridge
 * hook's identity (native thread + response ID), so a request also streamed
 * by rawResponse/completed merges into the same unit instead of adding usage.
 */
export async function settleCodexRolloutUsage(promptState: { codexRollout?: CodexRolloutCursor; usage: PromptUsageState },
  requestedModel: string | null | undefined, modelSource: TaskUsageUnit["modelSource"], waitMs: number): Promise<void> {
  const cursor = promptState.codexRollout;
  if (!cursor) return;
  promptState.codexRollout = undefined;
  try {
    for (const request of await collectCodexRolloutUsage(cursor, { requestedModel: requestedModel ?? null, waitMs })) {
      promptState.usage.collector.update(request.usage, requestedModel, modelSource);
    }
  } catch (error) {
    console.warn(`[AcpProvider] Codex rollout usage unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fold one `usage_update` into a prompt's usage. `context: false` (a native
 * child session's frame, PR 5 §1.4) keeps it out of the context occupancy:
 * `totalTokens`, the context snapshot and the window size. Billing (request
 * units, uncertain totals, cost) accumulates either way.
 */
export function accumulateUsage(state: PromptUsageState, update: SessionUpdate, requestedModel?: string | null, modelSource?: TaskUsageUnit["modelSource"], providerType?: string,
  options: { context?: boolean } = {}): void {
  const context = options.context !== false;
  const u = update as Record<string, any>;
  const used = nonNegativeFinite(u.used);
  if (context && used != null) state.totalTokens = used;
  if (context && !(u._meta?.claudeCode?.parentToolUseId)) state.collector.context(u.used, u.size);
  const shimUsage = accessConfigFor(providerType)?.usage === "gateway-shim";
  if ((providerType === "codex" || shimUsage) && u._meta?.remiUsageMode === "request") state.collector.useRequestTelemetry();

  const remiUsage = readRemiTokenUsage(u._meta?.remiTokenUsage);
  if (remiUsage) {
    state.collector.update(u._meta.remiTokenUsage, requestedModel, modelSource);
  }
  const missing = u._meta?.remiMissingRequestUsage;
  if (providerType === "codex" && missing?.source === "codex_response_usage"
    && typeof missing.providerSessionId === "string" && missing.providerSessionId
    && typeof missing.providerRequestId === "string" && missing.providerRequestId) {
    state.collector.update(missing, requestedModel, modelSource);
  } else if (shimUsage && missing?.source === GEMINI_USAGE_SOURCE && typeof missing.id === "string" && missing.id) {
    // A shim observation whose counters cannot be split: billed as unknown, never guessed.
    state.collector.update(missing, requestedModel, modelSource);
  }
  state.collector.uncertainTotal(u._meta?.remiUncertainUsage?.reportedTotalTokens);

  const size = nonNegativeFinite(u.size);
  if (context && size != null && size > 0) state.contextWindowSize = size;
  const cost = nonNegativeFinite(u.cost?.amount);
  if (cost != null) {
    if (u.cost?.currency === "USD") state.costUsd = cost;
    const monetary = u._meta?.remiCostUsage;
    const established = monetary && ["request", "turn", "task"].includes(monetary.scope);
    const source = established && monetary.source === "provider_reported" ? "provider_reported"
      : established && monetary.source === "sdk_estimate" || providerType === "claude" ? "sdk_estimate" : "unknown";
    state.collector.cost(cost, u.cost?.currency, established ? monetary.scope : providerType === "claude" ? "turn" : "task", source,
      established && typeof monetary.requestId === "string" ? monetary.requestId : undefined,
      established && typeof monetary.providerSessionId === "string" ? monetary.providerSessionId : undefined);
  }
}

/**
 * The typed failure of a turn the stall watchdog stopped. Classified as an
 * agent timeout (`errorKind: turn_stalled`), never retried automatically.
 */
function turnStalledFailure(agentType: string, stallMs: number, id: string): AcpSessionFailure {
  const bound = stallMs >= 1000 ? `${Math.round(stallMs / 1000)} s` : `${stallMs} ms`;
  return { id, revision: 1, severity: "error", category: "timeout", errorKind: "turn_stalled",
    title: `The ${agentType} turn timed out after ${bound} without progress`,
    details: `No agent update, model call, running tool or pending question for ${bound}, so Remi stopped the turn. `
      + "A shell command left running in the background can hold a turn open; ask for it to run in the foreground." };
}

function credentialsOf(options: AcpProviderOptions): string[] {
  return [options.apiKey, ...Object.entries(options.env ?? {})
    .filter(([name]) => /(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)(?:_|$)/i.test(name))
    .map(([, value]) => value)].filter((value): value is string => Boolean(value));
}

/** A gateway failure the shim saw while the session was set up (breaker or listing), as a typed failure. */
function gatewaySessionFailure(agentType: string, problem: Extract<GatewayShimEvent, { type: "fatal" }> | GatewayShimListingFailure,
  credentials: string[], cause?: unknown): AcpSessionFailureError {
  const event = "type" in problem ? problem
    : { type: "fatal" as const, reason: problem.reason, status: problem.status || null, message: problem.message };
  return new AcpSessionFailureError(gatewayFatalFailure(event, `${agentType}:gateway:setup`),
    cause instanceof Error ? cause : undefined, credentials);
}

/** The typed failure of an opened gateway-shim breaker (§4.2). */
function gatewayFatalFailure(event: Extract<GatewayShimEvent, { type: "fatal" }>, id: string): AcpSessionFailure {
  const status = event.status !== null && !event.message.includes(`HTTP ${event.status}`) ? ` (HTTP ${event.status})` : "";
  switch (event.reason) {
    case "auth":
      return { id, revision: 1, severity: "error", category: "authentication", errorKind: "authentication_failed",
        title: "The model gateway rejected the credentials", details: `${event.message}${status}` };
    case "quota":
      return { id, revision: 1, severity: "error", category: "quota", errorKind: "rate_limit",
        title: "The model gateway is rate limiting or out of quota", details: `${event.message}${status}` };
    default:
      // 5xx answers are the gateway's own errors; no answer at all is the network.
      return { id, revision: 1, severity: "error", category: "connection",
        errorKind: event.status !== null && event.status >= 500 ? "server_error" : "gateway_unreachable",
        title: "The model gateway is unreachable", details: `${event.message}${status}` };
  }
}

function readRemiTokenUsage(value: unknown): {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const inputTokens = nonNegativeFinite(raw.inputTokens);
  const cachedInputTokens = nonNegativeFinite(raw.cachedInputTokens);
  const outputTokens = nonNegativeFinite(raw.outputTokens);
  const totalTokens = nonNegativeFinite(raw.totalTokens);
  if (inputTokens == null || cachedInputTokens == null || outputTokens == null || totalTokens == null) return null;
  return { inputTokens, cachedInputTokens, outputTokens, totalTokens };
}

function nonNegativeFinite(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function buildAgentResponse(entry: PoolEntry, result: PromptResult, settleScope: PromptUsageSettleScope, sessionFailure?: AcpSessionFailure | null,
  providerType = "acp", requestedModel?: string | null, modelSource?: TaskUsageUnit["modelSource"]): AgentResponse {
  const { usage, text, promptStartTime, completedToolCount, contextUsage } = entry.promptState;
  const durationMs = Date.now() - promptStartTime;

  const resolved = resolvePromptUsage(usage, result.usage, settleScope);

  return createAgentResponse({
    text,
    sessionId: entry.acpSessionId,
    model: usage.model,
    costUsd: usage.costUsd,
    inputTokens: resolved.inputTokens || null,
    outputTokens: resolved.outputTokens || null,
    totalTokens: resolved.totalTokens || null,
    cacheReadInputTokens: resolved.cacheReadTokens || null,
    cacheCreateInputTokens: resolved.cacheWriteTokens || null,
    contextWindow: usage.contextWindowSize,
    durationMs,
    toolCalls: completedToolCount > 0 ? [{ count: completedToolCount }] : undefined,
    metadata: {
      stopReason: result.stopReason,
      provider: "acp",
      usageUnits: usage.collector.units(providerType, requestedModel, result.usage, settleScope, modelSource),
      ...(sessionFailure ? { sessionFailure } : {}),
      ...(contextUsage ? { contextUsage } : {}),
    },
  });
}
