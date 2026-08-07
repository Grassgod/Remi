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
} from "./provider-types.js";
import { createAgentResponse } from "./provider-types.js";
import { AcpClient } from "./client.js";
import { createAdapter, type AgentAdapter } from "./adapters/index.js";
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
  McpServerConfig,
  NewSessionMeta,
  NewSessionResult,
} from "./protocol.js";

export interface AcpProviderOptions {
  /** Agent type: "claude" | "codex" (default: "claude"). */
  agentType?: string;
  /** ACP executable path (auto-detected from agentType if omitted). */
  executable?: string;
  /** Optional API key forwarded to compatible ACP wrappers. */
  apiKey?: string;
  /** Optional API base URL forwarded to compatible ACP wrappers. */
  baseUrl?: string;
  /** Default model. */
  model?: string | null;
  /** Default timeout in seconds. */
  timeout?: number;
  /** Tools to allow. */
  allowedTools?: string[];
  /** Working directory. */
  cwd?: string;
  /** Inject MCP servers at construction time (ACP wire shape — see {@link McpServerConfig}). */
  getMcpServers?: () => McpServerConfig[];
  /** Extra environment variables for the spawned ACP process. */
  env?: Record<string, string>;
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

interface PromptState {
  promptStartTime: number;
  /** Streamed agent_message_chunk text, so getLastResponse().text carries the final reply. */
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
    model: string | null;
    contextWindowSize: number | null;
  };
  completedToolCount: number;
}

function createPromptState(): PromptState {
  return {
    promptStartTime: Date.now(),
    text: "",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      model: null,
      contextWindowSize: null,
    },
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
  /** Values currently in force, so a re-apply is only sent when they change. */
  appliedModel: string | null;
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
 * The `session/set_config_option` call for a requested model/effort value, or
 * null to skip it. Both bridges reject an unknown option id or value outright
 * (claude-agent-acp dist/acp-agent.js:3476, 3525; codex-acp dist/index.js:29328,
 * 29370, 29379), so — as with permission modes — an unsupported value is skipped
 * rather than allowed to kill the session.
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
  private _activeStreaming = new Set<string>();
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _permissionHandler: PermissionHandler | null = null;
  private _permissionHandlers = new Map<string, PermissionHandler>();
  private _elicitationHandler: ElicitationHandler | null = null;
  private _elicitationHandlers = new Map<string, ElicitationHandler>();
  private _sessionToChatId = new Map<string, string>();
  private _lastResponse: AgentResponse | null = null;

  constructor(options: AcpProviderOptions = {}) {
    this._options = options;
    this._adapter = createAdapter(options.agentType ?? "claude");
    this.name = `acp:${this._adapter.agentType}`;
  }

  get adapter(): AgentAdapter {
    return this._adapter;
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
    const chatId = options?.chatId ?? "__default__";
    const entry = await abortableEnsureSession(this._ensureSession(chatId, options), options?.signal);

    this._activeStreaming.add(chatId);
    entry.lastUsed = Date.now();
    entry.promptState = createPromptState();
    this._lastResponse = null;

    const eventQueue: ProviderEvent[] = [];
    let promptDone = false;
    let promptError: Error | null = null;
    let resolveWaiting: (() => void) | null = null;

    const pushEvent = (evt: ProviderEvent) => {
      eventQueue.push(evt);
      resolveWaiting?.();
    };

    const originalOnUpdate = entry.client["_options"].onSessionUpdate;
    entry.client["_options"].onSessionUpdate = (notification: SessionNotification) => {
      if (notification.sessionId !== entry.acpSessionId) return;
      const update = notification.update;
      if (update.sessionUpdate === "usage_update") {
        accumulateUsage(entry.promptState, update);
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        entry.promptState.text += extractChunkText((update as Record<string, any>).content);
      }
      if (update.sessionUpdate === "tool_call_update") {
        const status = (update as any).status;
        if (status === "completed" || status === "failed") {
          entry.promptState.completedToolCount++;
        }
      }
      pushEvent(update);
    };

    const promptStartMs = Date.now();
    entry.client
      .prompt(entry.acpSessionId, message, buildMediaContent(options?.media))
      .then((result: PromptResult) => {
        promptDone = true;
        this._lastResponse = buildAgentResponse(entry, result);
        if (result.stopReason === "cancelled" || result.stopReason === "interrupted") {
          promptError = new Error("Cancelled");
        }
        resolveWaiting?.();
      })
      .catch((err: Error) => {
        promptDone = true;
        promptError = err;
        console.error(`[AcpProvider] prompt FAILED after ${((Date.now() - promptStartMs) / 1000).toFixed(1)}s: ${err.message}`);
        resolveWaiting?.();
      });

    try {
      while (true) {
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }

        if (promptDone) break;

        if (options?.signal?.aborted) {
          await entry.client.cancel(entry.acpSessionId);
          throw new Error("Cancelled");
        }

        await new Promise<void>((resolve) => {
          resolveWaiting = resolve;
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        resolveWaiting = null;
      }
    } finally {
      entry.client["_options"].onSessionUpdate = originalOnUpdate;
      this._activeStreaming.delete(chatId);
      entry.lastUsed = Date.now();
    }

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
      const child = spawn(check.command, probeArgs, {
        stdio: ["ignore", "ignore", "pipe"],
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
    const permissionMode = resolveAcpPermissionMode(this._adapter.agentType, options?.permissionMode);
    const cwd = options?.cwd ?? this._options.cwd ?? homedir();
    const mcpServers = this._options.getMcpServers?.() ?? [];
    const mcpServersKey = JSON.stringify(mcpServers);
    const model = options?.model ?? this._options.model ?? null;
    const effort = options?.effort ?? null;

    const existing = this._pool.get(chatId);
    if (existing) {
      const stale =
        !existing.client.alive ||
        existing.cwd !== cwd ||
        existing.mcpServersKey !== mcpServersKey;
      if (stale && existing.client.alive) {
        console.warn(
          `[acp] ${this._adapter.agentType}: recreating session for ${chatId} — ` +
            `${existing.cwd !== cwd ? `cwd ${existing.cwd} -> ${cwd}` : "mcpServers changed"} ` +
            "(both are fixed at session creation and cannot be re-applied)",
        );
      }
      if (stale) {
        await this._discardEntry(chatId, existing);
      } else {
        if (options?.sessionId && options.sessionId !== existing.acpSessionId) {
          this._sessionToChatId.delete(existing.acpSessionId);
          const result = await existing.client.loadSession(options.sessionId, cwd, mcpServers);
          existing.acpSessionId = result.sessionId;
          this._adoptSessionState(existing, result);
          this._sessionToChatId.set(existing.acpSessionId, chatId);
        }
        await this._applyMode(existing, permissionMode);
        await this._applyModelAndEffort(existing, model, effort);
        return existing;
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

    const sessionMeta = this._adapter.buildSessionMeta({
      model,
      allowedTools: options?.allowedTools ?? this._options.allowedTools,
      systemPrompt: options?.systemPrompt,
    });

    const client = new AcpClient({
      executable: resolveAcpExecutableForAgent(
        this._adapter.agentType,
        this._options.executable,
        this._adapter.defaultExecutable(),
      ),
      agentType: this._adapter.agentType,
      cwd,
      env,
      onPermissionRequest: (params) => this._handlePermission(params),
      onElicitationRequest: (params) => this._handleElicitation(params),
      onSessionUpdate: () => {},
      log: (...args) => {
        if (process.env.REMI_DEBUG) console.error(...args);
      },
    });

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
      appliedModel: null,
      appliedEffort: null,
      warnedPermissionMode: null,
    };
    this._adoptSessionState(entry, result);
    await this._applyMode(entry, permissionMode);
    await this._applyModelAndEffort(entry, model, effort);

    this._pool.set(chatId, entry);
    this._sessionToChatId.set(entry.acpSessionId, chatId);
    this._startCleanupTimer();
    return entry;
  }

  /** Record what the agent advertised for a freshly created/loaded session. */
  private _adoptSessionState(entry: PoolEntry, result: NewSessionResult): void {
    entry.modes = result.modes;
    entry.configOptions = result.configOptions;
    entry.models = result.models;
    entry.appliedModel = currentConfigValue(result.configOptions, MODEL_OPTION_CATEGORY);
    entry.appliedEffort = currentConfigValue(result.configOptions, EFFORT_OPTION_CATEGORY);
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

  /**
   * Model first, then effort: changing the model resets the effort to the new
   * model's default and rewrites the effort option's valid values
   * (claude-agent-acp dist/acp-agent.js:4084-4100, codex-acp dist/index.js:29369-29374).
   */
  private async _applyModelAndEffort(entry: PoolEntry, model: string | null, effort: string | null): Promise<void> {
    if (model && model !== entry.appliedModel) {
      if (await this._setConfigOption(entry, MODEL_OPTION_CATEGORY, model)) {
        entry.appliedModel = model;
        // The agent just rewrote the effort option: codex re-derives it from the
        // new model's supported list (dist/index.js:29372-29374) and claude
        // rebuilds and re-clamps it (dist/acp-agent.js:4084-4100). Re-read what
        // it now reports, or a requested effort equal to the pre-switch value
        // would look already-applied and be skipped.
        entry.appliedEffort = currentConfigValue(entry.configOptions, EFFORT_OPTION_CATEGORY);
      }
    }
    if (effort && effort !== entry.appliedEffort) {
      if (await this._setConfigOption(entry, EFFORT_OPTION_CATEGORY, effort)) entry.appliedEffort = effort;
    }
  }

  private async _setConfigOption(entry: PoolEntry, category: string, value: string): Promise<boolean> {
    const change = resolveConfigOptionChange(entry.configOptions, category, value);
    if (!change) {
      console.warn(
        `[acp] ${this._adapter.agentType}: skipping ${category}="${value}" — the agent does not offer it`,
      );
      return false;
    }
    const result = await entry.client.setConfigOption(entry.acpSessionId, change.configId, change.value);
    if (result?.configOptions) entry.configOptions = result.configOptions;
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

function accumulateUsage(state: PromptState, update: SessionUpdate): void {
  const u = update as Record<string, any>;
  // ACP wire format ({used, size, cost}): `used` is total context tokens with
  // no input/output split — record it as such rather than faking input=used.
  if (u.used != null) state.usage.totalTokens = u.used;
  if (u.size != null) state.usage.contextWindowSize = u.size;
  if (u.cost?.amount != null) state.usage.costUsd = u.cost.amount;
}

function buildAgentResponse(entry: PoolEntry, result: PromptResult): AgentResponse {
  const { usage, text, promptStartTime, completedToolCount } = entry.promptState;
  const durationMs = Date.now() - promptStartTime;

  // Reset per-prompt state for next prompt
  entry.promptState = createPromptState();

  return createAgentResponse({
    text,
    sessionId: entry.acpSessionId,
    model: usage.model,
    costUsd: usage.costUsd || null,
    inputTokens: usage.inputTokens || null,
    outputTokens: usage.outputTokens || null,
    totalTokens: usage.totalTokens || null,
    cacheReadInputTokens: usage.cacheReadTokens || null,
    contextWindow: usage.contextWindowSize,
    durationMs,
    toolCalls: completedToolCount > 0 ? [{ count: completedToolCount }] : undefined,
    metadata: {
      stopReason: result.stopReason,
      provider: "acp",
    },
  });
}
