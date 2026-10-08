/**
 * AcpProvider — implements Remi's Provider interface using ACP protocol.
 * Yields raw ACP SessionUpdate events directly (no translation layer).
 * Agent-specific behavior (Claude/Codex) is delegated to adapters.
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type {
  Provider,
  SendOptions,
  AgentResponse,
  ProviderEvent,
} from "@shared/contracts/provider-types.js";
import { createAgentResponse } from "@shared/contracts/provider-types.js";
import { isCompactionChunk } from "@shared/contracts/compaction.js";
import { readContextUsage, type ContextUsage } from "@shared/agent-execution.js";
import { UsageCollector } from "./usage-collector.js";
import type { TaskUsageUnit } from "@shared/contracts/usage-accounting.js";
import { AcpClient } from "./client.js";
import { AcpSessionFailureError, airMetadata, readSessionFailure, redactProviderError, redactProviderErrorText, record, type AcpSessionFailure } from "./session-failure.js";
import { resolveAcpProcessLaunch } from "./launch.js";
import { createAdapter, type AgentAdapter } from "./adapters/index.js";
import { resolveClaudeContextSelection, hasOneMillionContext } from "./adapters/claude-code/model-context.js";
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
}

type PermissionHandler = (params: RequestPermissionParams) => Promise<PermissionOutcome>;
type ElicitationHandler = (params: ElicitationCreateParams) => Promise<ElicitationResult>;

export function resolveAcpPermissionMode(agentType: string, mode?: string | null): string | null {
  const normalized = typeof mode === "string" ? mode.trim() : "";
  if (normalized) return normalized === "bypass" ? "bypassPermissions" : normalized;
  return DEFAULT_PERMISSION_MODE_BY_AGENT[agentType] ?? null;
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
  if (explicit) return explicit;

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
}

export function resolveAcpHealthCheckCommand(
  agentType: string,
  executable: string | null | undefined,
  fallback: string,
): AcpHealthCheckCommand {
  const command = resolveAcpExecutableForAgent(agentType, executable, fallback);
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

  constructor(options: AcpProviderOptions = {}) {
    this._options = options;
    this._adapter = createAdapter(options.agentType ?? "claude");
    this.name = `acp:${this._adapter.agentType}`;
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
      const modelOption = selectConfigOption(entry.configOptions, MODEL_OPTION_CATEGORY);
      if (!modelOption) return [];

      const initialModel = modelOption.currentValue;
      const models = flattenSelectOptions(modelOption).filter((model) => !isAcpDefaultSentinel(model.value));
      if (isAcpDefaultSentinel(initialModel)) {
        models.unshift({ value: initialModel, name: "Default" });
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
    const credentials = [this._options.apiKey, ...Object.entries(this._options.env ?? {})
      .filter(([name]) => /(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)(?:_|$)/i.test(name))
      .map(([, value]) => value)].filter((value): value is string => Boolean(value));
    const chatId = options?.chatId ?? "__default__";
    const entry = await abortableEnsureSession(this._ensureSession(chatId, options), options?.signal);
    this._typedSessionFailures = entry.client.typedSessionFailures ?? false;

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

    const originalOnUpdate = entry.client["_options"].onSessionUpdate;
    entry.client["_options"].onSessionUpdate = (notification: SessionNotification) => {
      if (notification.sessionId !== entry.acpSessionId) return;
      let update = notification.update;
      if (update.sessionUpdate === "session_info_update") {
        const failure = readSessionFailure(update._meta, credentials);
        if (failure && (failure.severity === "error" || failureState.failure?.severity !== "error")) failureState.failure = failure;
        if (failure) update = {
          ...update, _meta: { ...update._meta, jetbrains: {
            ...record(record(update._meta)?.jetbrains), air: { ...airMetadata(update._meta), sessionFailure: failure },
          } },
        };
      }
      if (update.sessionUpdate === "config_option_update" && update.configOptions) {
        entry.configOptions = update.configOptions;
      } else if (update.sessionUpdate === "config_option_update" && update.id === "model" && typeof update.value === "string") {
        const value = update.value;
        entry.configOptions = entry.configOptions?.map(option => option.type === "select" && (option.category === "model" || option.id === "model")
          ? { ...option, currentValue: value } : option);
        if (entry.models) entry.models = { ...entry.models, currentModelId: value };
      }
      if (update.sessionUpdate === "usage_update") {
        accumulateUsage(entry.promptState.usage, update, requestedModel(), requestedModelSource(), this._adapter.agentType);
        const context = (update._meta?.claudeCode as { parentToolUseId?: string } | undefined)?.parentToolUseId
          ? null : readContextUsage(update);
        if (context) entry.promptState.contextUsage = context;
        update = { ...update, _meta: { ...update._meta,
          remiUsageUnits: entry.promptState.usage.collector.takeChangedUnits(this._adapter.agentType, requestedModel()),
        } };
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        const text = extractChunkText((update as Record<string, any>).content);
        if (!isCompactionChunk(text)) {
          entry.promptState.text += text;
          if (text.trim() && failureState.compaction) {
            failureState.compaction = null;
            console.warn("[AcpProvider] Assistant continued after a context compaction failure");
          }
        }
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

    const promptStartMs = Date.now();
    const promptSettled = entry.client
      .prompt(entry.acpSessionId, message, buildMediaContent(options?.media))
      .then((result: PromptResult) => {
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
      .catch((err: unknown) => {
        promptDone = true;
        promptError = redactProviderError(err, credentials);
        console.error(`[AcpProvider] prompt FAILED after ${((Date.now() - promptStartMs) / 1000).toFixed(1)}s: ${promptError.message}`);
        resolveWaiting?.();
      });

    try {
      while (true) {
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }

        if (promptDone) break;

        if (options?.signal?.aborted) {
          // A dead process makes cancel a no-op; the abort must still win.
          await entry.client.cancel(entry.acpSessionId).catch(() => {});
          // Cancel ACK and prompt settlement are separate messages. Preserve
          // trailing usage emitted before settlement, without waiting forever
          // for a dead/hung bridge.
          let settleTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([promptSettled, new Promise<void>(resolve => {
              settleTimer = setTimeout(resolve, 1000);
            })]);
          } finally {
            if (settleTimer) clearTimeout(settleTimer);
          }
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
      // Streaming errors, process death, generator return and task aborts all
      // retain actual requests observed before the prompt stopped.
      if (!this._lastResponse) this._lastResponse = buildAgentResponse(entry,
        { stopReason: options?.signal?.aborted ? "cancelled" : "end_turn" }, this._adapter.promptUsageSettleScope, turnFailure(),
        this._adapter.agentType, requestedModel(), requestedModelSource());
      this._deathListeners.delete(chatId);
      entry.client["_options"].onSessionUpdate = originalOnUpdate;
      this._activeStreaming.delete(chatId);
      entry.lastUsed = Date.now();
    }

    const failure = turnFailure();
    if (failure?.severity === "error") throw new AcpSessionFailureError(failure, promptError ?? undefined, credentials);
    if (promptError) throw promptError;
  }

  async healthCheck(): Promise<boolean> {
    const check = resolveAcpHealthCheckCommand(
      this._adapter.agentType,
      this._options.executable,
      this._adapter.defaultExecutable(),
    );
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
    } as Parameters<AgentAdapter["buildSessionMeta"]>[0]);

    const existing = this._pool.get(chatId);
    if (existing) {
      const stale =
        !existing.client.alive ||
        existing.cwd !== cwd ||
        existing.mcpServersKey !== mcpServersKey ||
        existing.pluginPathsKey !== pluginPathsKey ||
        existing.pluginFingerprint !== pluginFingerprint ||
        existing.codexHome !== codexHome ||
        existing.customModelOption !== customModelOption ||
        existing.startupModel !== startupModel;
      if (stale && existing.client.alive) {
        const reason = existing.cwd !== cwd
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
        await this._discardEntry(chatId, existing);
      } else {
        try {
          if (options?.sessionId && options.sessionId !== existing.acpSessionId) {
            this._sessionToChatId.delete(existing.acpSessionId);
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

    const client = new AcpClient({
      inheritProcessGroup: this._options.inheritProcessGroup,
      executable: resolveAcpExecutableForAgent(
        this._adapter.agentType,
        this._options.executable,
        this._adapter.defaultExecutable(),
      ),
      args: this._options.args,
      agentType: this._adapter.agentType,
      cwd,
      privateTmpDirectory: this._options.privateTmpDirectory,
      privateTmpPlatform: this._options.privateTmpPlatform,
      env,
      onPermissionRequest: (params) => this._handlePermission(params),
      onElicitationRequest: (params) => this._handleElicitation(params),
      onSessionUpdate: () => {},
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
      };
      this._adoptSessionState(entry, result);
      await this._applyMode(entry, permissionMode);
      await this._applyModelAndEffort(entry, model, effort);

      this._pool.set(chatId, entry);
      this._sessionToChatId.set(entry.acpSessionId, chatId);
      this._startCleanupTimer();
      this._startingClients.delete(client);
      return entry;
    } catch (error) {
      this._startingClients.delete(client);
      await client.stop();
      throw error;
    }
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
      console.error(`[AcpProvider] ${this._adapter.agentType} agent for ${chatId} died (${reason}); session evicted`);
      this._deathListeners.get(chatId)?.(reason);
    }
  }

  private async _discardEntry(chatId: string, entry: PoolEntry): Promise<void> {
    try {
      if (entry.client.alive) await entry.client.closeSession(entry.acpSessionId);
    } catch {}
    await entry.client.stop();
    this._sessionToChatId.delete(entry.acpSessionId);
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
      if (this._adapter.agentType !== "codex") {
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
    } else if (this._adapter.agentType === "codex"
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
    const chatId = this._sessionToChatId.get(params.sessionId);
    const handler = (chatId ? this._permissionHandlers.get(chatId) : undefined) ?? this._permissionHandler;
    if (handler) {
      return handler(params);
    }
    console.error(`[AcpProvider] permission request cancelled: no handler for session ${params.sessionId}`);
    return { outcome: "cancelled" };
  }

  private async _handleElicitation(params: ElicitationCreateParams): Promise<ElicitationResult> {
    const chatId = this._sessionToChatId.get(params.sessionId);
    const handler = (chatId ? this._elicitationHandlers.get(chatId) : undefined) ?? this._elicitationHandler;
    if (handler) {
      return handler(params);
    }
    console.error(`[AcpProvider] elicitation request cancelled: no handler for session ${params.sessionId}`);
    return { action: "cancel" };
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
        this._sessionToChatId.delete(entry.acpSessionId);
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
        this._sessionToChatId.delete(entry.acpSessionId);
        this._permissionHandlers.delete(chatId);
        this._elicitationHandlers.delete(chatId);
        this._pool.delete(chatId);
      }
    } else {
      for (const [, entry] of this._pool) {
        try { await entry.client.closeSession(entry.acpSessionId); } catch {}
        await entry.client.stop();
        this._sessionToChatId.delete(entry.acpSessionId);
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

export function accumulateUsage(state: PromptUsageState, update: SessionUpdate, requestedModel?: string | null, modelSource?: TaskUsageUnit["modelSource"], providerType?: string): void {
  const u = update as Record<string, any>;
  const used = nonNegativeFinite(u.used);
  if (used != null) state.totalTokens = used;
  if (!(u._meta?.claudeCode?.parentToolUseId)) state.collector.context(u.used, u.size);
  if (providerType === "codex" && u._meta?.remiUsageMode === "request") state.collector.useRequestTelemetry();

  const remiUsage = readRemiTokenUsage(u._meta?.remiTokenUsage);
  if (remiUsage) {
    state.collector.update(u._meta.remiTokenUsage, requestedModel, modelSource);
  }
  const missing = u._meta?.remiMissingRequestUsage;
  if (providerType === "codex" && missing?.source === "codex_response_usage"
    && typeof missing.providerSessionId === "string" && missing.providerSessionId
    && typeof missing.providerRequestId === "string" && missing.providerRequestId) {
    state.collector.update(missing, requestedModel, modelSource);
  }
  state.collector.uncertainTotal(u._meta?.remiUncertainUsage?.reportedTotalTokens);

  const size = nonNegativeFinite(u.size);
  if (size != null && size > 0) state.contextWindowSize = size;
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
