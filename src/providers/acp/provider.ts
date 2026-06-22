/**
 * AcpProvider — implements Remi's Provider interface using ACP protocol.
 * Yields raw ACP SessionUpdate events directly (no translation layer).
 * Agent-specific behavior (Claude/Codex) is delegated to adapters.
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configManager } from "../../infra/config-manager.js";
import type {
  Provider,
  SendOptions,
  AgentResponse,
  ProviderEvent,
} from "../base.js";
import { createAgentResponse } from "../base.js";
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
} from "./protocol.js";

export interface AcpProviderOptions {
  /** Agent type: "claude" | "codex" (default: "claude"). */
  agentType?: string;
  /** ACP executable path (auto-detected from agentType if omitted). */
  executable?: string;
  /** Default model. */
  model?: string | null;
  /** Default timeout in seconds. */
  timeout?: number;
  /** Tools to allow. */
  allowedTools?: string[];
  /** Working directory. */
  cwd?: string;
  /** API key (if using API auth instead of subscription). */
  apiKey?: string | null;
  /** Base URL override. */
  baseUrl?: string | null;
  /** Codex Responses API base URL override. */
  codexBaseUrl?: string | null;
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_PERMISSION_MODE_BY_AGENT: Record<string, string | null> = {
  claude: "bypassPermissions",
};
const REMI_CLAUDE_AGENT_ACP_WRAPPER = "remi-claude-agent-acp";

interface PromptState {
  promptStartTime: number;
  text: string;
  thinking: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
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
    thinking: "",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
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
  modes?: SessionModeState;
}

type PermissionHandler = (params: RequestPermissionParams) => Promise<PermissionOutcome>;
type ElicitationHandler = (params: ElicitationCreateParams) => Promise<ElicitationResult>;

export function resolveAcpPermissionMode(agentType: string, mode?: string | null): string | null {
  const normalized = typeof mode === "string" ? mode.trim() : "";
  if (normalized) return normalized === "bypass" ? "bypassPermissions" : normalized;
  return DEFAULT_PERMISSION_MODE_BY_AGENT[agentType] ?? null;
}

export function resolveAvailableAcpPermissionMode(
  mode: string | null,
  modes?: SessionModeState,
): string | null {
  if (!mode) return null;
  if (!modes?.availableModes?.length) return mode;
  if (modes.availableModes.some((m) => m.id === mode)) return mode;
  return mode;
}

export function resolveAcpExecutableForAgent(agentType: string, executable: string | null | undefined, fallback: string): string {
  const explicit = typeof executable === "string" ? executable.trim() : "";
  if (explicit) return explicit;

  if (agentType === "claude") {
    const envExecutable = process.env.REMI_CLAUDE_AGENT_ACP_EXECUTABLE?.trim();
    if (envExecutable) return envExecutable;

    const remiHome = process.env.REMI_HOME ?? join(homedir(), ".remi");
    const candidates = [
      join(remiHome, "bin", REMI_CLAUDE_AGENT_ACP_WRAPPER),
      join(homedir(), ".remi", "bin", REMI_CLAUDE_AGENT_ACP_WRAPPER),
      join(import.meta.dir, "..", "bin", REMI_CLAUDE_AGENT_ACP_WRAPPER),
      join(import.meta.dir, "..", "..", "..", "bin", REMI_CLAUDE_AGENT_ACP_WRAPPER),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
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
  }

  return fallback;
}

export interface AcpHealthCheckCommand {
  command: string;
  args: string[];
}

export function resolveAcpHealthCheckCommand(
  agentType: string,
  executable: string | null | undefined,
  fallback: string,
): AcpHealthCheckCommand {
  const explicit = typeof executable === "string" ? executable.trim() : "";

  // Preserve the cheap Claude CLI check for the default Claude ACP setup. The
  // Remi Claude ACP wrapper prepares a patched server and should not be invoked
  // on every heartbeat just to check liveness.
  if (agentType === "claude" && !explicit) {
    return { command: "claude", args: ["--version"] };
  }

  const command = resolveAcpExecutableForAgent(agentType, executable, fallback);
  return { command, args: ["--version"] };
}

export function buildCodexAcpEnv(options: { baseUrl?: string | null }): Record<string, string> {
  const baseUrl = options.baseUrl?.trim();
  if (!baseUrl) return {};

  const existingConfig = parseCodexConfigEnv(process.env.CODEX_CONFIG);
  const modelProvider = typeof existingConfig.model_provider === "string" && existingConfig.model_provider.trim()
    ? existingConfig.model_provider
    : "OpenAI";
  const existingProviders = isRecord(existingConfig.model_providers) ? existingConfig.model_providers : {};
  const existingProvider = isRecord(existingProviders[modelProvider]) ? existingProviders[modelProvider] : {};
  const nextConfig = {
    ...existingConfig,
    model_provider: modelProvider,
    model_providers: {
      ...existingProviders,
      [modelProvider]: {
        ...existingProvider,
        name: typeof existingProvider.name === "string" ? existingProvider.name : modelProvider,
        base_url: baseUrl,
        wire_api: "responses",
        requires_openai_auth: true,
        supports_websockets: false,
      },
    },
    features: {
      ...(isRecord(existingConfig.features) ? existingConfig.features : {}),
      responses_websockets_v2: false,
    },
  };

  return {
    CODEX_CONFIG: JSON.stringify(nextConfig),
    MODEL_PROVIDER: modelProvider,
  };
}

function parseCodexConfigEnv(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
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

  /** Register external handler for permission requests (ExitPlanMode, tool approval). */
  setPermissionHandler(handler: PermissionHandler, chatId?: string | null): void {
    if (chatId) {
      this._permissionHandlers.set(chatId, handler);
    } else {
      this._permissionHandler = handler;
    }
  }

  /** Register external handler for form elicitations (AskUserQuestion). */
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
    const entry = await this._ensureSession(chatId, options);

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
        entry.promptState.text += contentText(update.content);
      } else if (update.sessionUpdate === "agent_thought_chunk") {
        entry.promptState.thinking += contentText(update.content);
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
    try {
      const { execFileSync } = await import("node:child_process");
      const check = resolveAcpHealthCheckCommand(
        this._adapter.agentType,
        this._options.executable,
        this._adapter.defaultExecutable(),
      );
      execFileSync(check.command, check.args, { timeout: 5000, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  // ── Session pool management ────────────────────────────────────

  private async _ensureSession(chatId: string, options?: SendOptions): Promise<PoolEntry> {
    const permissionMode = resolveAcpPermissionMode(this._adapter.agentType, options?.permissionMode);
    const existing = this._pool.get(chatId);
    if (existing?.client.alive) {
      if (options?.sessionId && options.sessionId !== existing.acpSessionId) {
        this._sessionToChatId.delete(existing.acpSessionId);
        const result = await existing.client.loadSession(options.sessionId);
        existing.acpSessionId = result.sessionId;
        existing.modes = result.modes;
        this._sessionToChatId.set(existing.acpSessionId, chatId);
      }
      const effectiveMode = resolveAvailableAcpPermissionMode(permissionMode, existing.modes);
      if (effectiveMode) {
        const appliedMode = await this._setMode(existing.client, existing.acpSessionId, effectiveMode);
        if (existing.modes) existing.modes = { ...existing.modes, currentModeId: appliedMode };
      }
      return existing;
    }

    if (existing) {
      await existing.client.stop();
      this._sessionToChatId.delete(existing.acpSessionId);
      this._pool.delete(chatId);
    }

    const cwd = options?.cwd ?? this._options.cwd ?? homedir();
    const env: Record<string, string> = {};
    if (this._options.apiKey) {
      env.ANTHROPIC_API_KEY = this._options.apiKey;
    }
    if (this._options.baseUrl) env.ANTHROPIC_BASE_URL = this._options.baseUrl;
    if (this._adapter.agentType === "codex") {
      Object.assign(env, buildCodexAcpEnv({
        baseUrl: this._options.codexBaseUrl ?? this._options.baseUrl,
      }));
    }

    const sessionMeta = this._adapter.buildSessionMeta({
      model: this._options.model,
      allowedTools: options?.allowedTools ?? this._options.allowedTools,
      permissionMode,
      additionalDirectories: options?.addDirs,
    });

    const client = new AcpClient({
      executable: resolveAcpExecutableForAgent(
        this._adapter.agentType,
        this._options.executable,
        this._adapter.defaultExecutable(),
      ),
      cwd,
      env,
      sessionMeta: sessionMeta ?? undefined,
      onPermissionRequest: (params) => this._handlePermission(params),
      onElicitationRequest: (params) => this._handleElicitation(params),
      onSessionUpdate: () => {},
      log: (...args) => {
        if (process.env.REMI_DEBUG) console.error(...args);
      },
    });

    await client.start();
    await client.initialize();

    const mcpServers = this._adapter.agentType === "codex"
      ? []
      : configManager.hasCCSwitch
        ? configManager.ccSwitch.getMcpServersForApp(this._adapter.agentType as any)
        : [];

    let acpSessionId: string;
    let sessionModes: SessionModeState | undefined;
    if (options?.sessionId) {
      const result = await client.resumeSession(options.sessionId, cwd, mcpServers);
      acpSessionId = result.sessionId;
      sessionModes = result.modes;
    } else {
      const result = await client.newSession({ cwd, mcpServers, _meta: sessionMeta });
      acpSessionId = result.sessionId;
      sessionModes = result.modes;
    }
    if (this._options.model) {
      await this._setModel(client, acpSessionId, this._options.model);
    }
    const effectiveMode = resolveAvailableAcpPermissionMode(permissionMode, sessionModes);
    if (effectiveMode) {
      const appliedMode = await this._setMode(client, acpSessionId, effectiveMode);
      if (sessionModes) sessionModes = { ...sessionModes, currentModeId: appliedMode };
    }

    const entry: PoolEntry = {
      client,
      acpSessionId,
      lastUsed: Date.now(),
      promptState: createPromptState(),
      modes: sessionModes,
    };

    this._pool.set(chatId, entry);
    this._sessionToChatId.set(acpSessionId, chatId);
    this._startCleanupTimer();
    return entry;
  }

  private async _setMode(client: AcpClient, sessionId: string, mode: string): Promise<string> {
    await client.setMode(sessionId, mode);
    return mode;
  }

  private async _setModel(client: AcpClient, sessionId: string, model: string): Promise<void> {
    try {
      await client.setModel(sessionId, model);
    } catch (err) {
      console.error(`[AcpProvider] set_model failed for ${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    console.error(`[AcpProvider] elicitation cancelled: no handler for session ${params.sessionId}`);
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
          if (this._adapter.agentType !== "codex") {
            await entry.client.closeSession(entry.acpSessionId);
          }
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
        if (this._adapter.agentType !== "codex") {
          try { await entry.client.closeSession(entry.acpSessionId); } catch {}
        }
        await entry.client.stop();
        this._sessionToChatId.delete(entry.acpSessionId);
        this._permissionHandlers.delete(chatId);
        this._elicitationHandlers.delete(chatId);
        this._pool.delete(chatId);
      }
    } else {
      for (const [, entry] of this._pool) {
        if (this._adapter.agentType !== "codex") {
          try { await entry.client.closeSession(entry.acpSessionId); } catch {}
        }
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

// ── Helpers ──────────────────────────────────────────────────────

function buildMediaContent(
  media?: import("../base.js").SendOptions["media"],
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

function accumulateUsage(state: PromptState, update: SessionUpdate): void {
  const u = update as Record<string, any>;
  if (u.inputTokens != null) state.usage.inputTokens = u.inputTokens;
  if (u.outputTokens != null) state.usage.outputTokens = u.outputTokens;
  if (u.cacheReadTokens != null) state.usage.cacheReadTokens = u.cacheReadTokens;
  if (u.cacheWriteTokens != null) state.usage.cacheWriteTokens = u.cacheWriteTokens;
  if (u.model) state.usage.model = u.model;
  if (u.costUsd != null) state.usage.costUsd = u.costUsd;
  if (u.contextWindowSize != null) state.usage.contextWindowSize = u.contextWindowSize;
  // ACP format: `used` is total tokens consumed
  if (u.used != null) {
    state.usage.inputTokens = u.used;
    state.usage.outputTokens = 0;
  }
  if (u.size != null) state.usage.contextWindowSize = u.size;
  if (u.cost?.amount != null) state.usage.costUsd = u.cost.amount;
}

function contentText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  let text = "";
  for (const block of blocks) {
    if (block && typeof block === "object" && !Array.isArray(block)) {
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        text += record.text;
      }
    }
  }
  return text;
}

function buildAgentResponse(entry: PoolEntry, result: PromptResult): AgentResponse {
  const { usage, promptStartTime, completedToolCount, text, thinking } = entry.promptState;
  const durationMs = Date.now() - promptStartTime;

  // Reset per-prompt state for next prompt
  entry.promptState = createPromptState();

  return createAgentResponse({
    text,
    thinking: thinking || null,
    sessionId: entry.acpSessionId,
    model: usage.model,
    costUsd: usage.costUsd || null,
    inputTokens: usage.inputTokens || null,
    outputTokens: usage.outputTokens || null,
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
