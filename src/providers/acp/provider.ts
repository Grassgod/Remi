/**
 * AcpProvider — implements Remi's Provider interface using ACP protocol.
 * Agent-specific behavior (Claude/Codex) is delegated to adapters.
 */

import { homedir } from "node:os";
import type {
  Provider,
  SendOptions,
  AgentResponse,
  StreamEvent,
} from "../base.js";
import { createAgentResponse } from "../base.js";
import { AcpClient } from "./client.js";
import { mapSessionUpdate, createMapperState, type MapperState } from "./event-mapper.js";
import { createAdapter, type AgentAdapter } from "./adapters/index.js";
import type {
  SessionNotification,
  RequestPermissionParams,
  PermissionOutcome,
  PromptResult,
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
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

interface PoolEntry {
  client: AcpClient;
  acpSessionId: string;
  lastUsed: number;
  mapperState: MapperState;
}

type PermissionHandler = (params: RequestPermissionParams) => Promise<PermissionOutcome>;

export class AcpProvider implements Provider {
  readonly name: string;

  private _options: AcpProviderOptions;
  private _adapter: AgentAdapter;
  private _pool = new Map<string, PoolEntry>();
  private _activeStreaming = new Set<string>();
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _permissionHandler: PermissionHandler | null = null;

  constructor(options: AcpProviderOptions = {}) {
    this._options = options;
    this._adapter = createAdapter(options.agentType ?? "claude");
    this.name = `acp:${this._adapter.agentType}`;
  }

  get adapter(): AgentAdapter {
    return this._adapter;
  }

  /** Register external handler for permission requests (AskUserQuestion, ExitPlanMode, tool approval). */
  setPermissionHandler(handler: PermissionHandler): void {
    this._permissionHandler = handler;
  }

  // ── Provider interface ─────────────────────────────────────────

  async send(message: string, options?: SendOptions): Promise<AgentResponse> {
    let text = "";
    let thinking = "";
    let lastResponse: AgentResponse | null = null;

    for await (const event of this.sendStream(message, options)) {
      switch (event.kind) {
        case "content_delta":
          text += event.text;
          break;
        case "thinking_delta":
          thinking += event.text;
          break;
        case "result":
          lastResponse = event.response;
          break;
      }
    }

    if (lastResponse) return lastResponse;
    return createAgentResponse({ text, thinking: thinking || null });
  }

  async *sendStream(message: string, options?: SendOptions): AsyncGenerator<StreamEvent> {
    const chatId = options?.chatId ?? "__default__";
    const entry = await this._ensureSession(chatId, options);

    this._activeStreaming.add(chatId);
    entry.lastUsed = Date.now();

    const eventQueue: StreamEvent[] = [];
    let promptDone = false;
    let resolveWaiting: (() => void) | null = null;

    const pushEvent = (evt: StreamEvent) => {
      eventQueue.push(evt);
      resolveWaiting?.();
    };

    // Subscribe to session updates — use adapter for event mapping
    const originalOnUpdate = entry.client["_options"].onSessionUpdate;
    entry.client["_options"].onSessionUpdate = (notification: SessionNotification) => {
      if (notification.sessionId !== entry.acpSessionId) return;
      const events = mapSessionUpdate(notification.update, entry.mapperState, this._adapter);
      for (const evt of events) pushEvent(evt);
    };

    // Start prompt (runs in background)
    entry.client
      .prompt(entry.acpSessionId, message, buildMediaContent(options?.media))
      .then((result: PromptResult) => {
        promptDone = true;
        if (result.stopReason === "cancelled" || result.stopReason === "interrupted") {
          pushEvent({ kind: "error", error: "Cancelled", code: "cancelled" });
        } else {
          const response = buildAgentResponse(entry, result);
          pushEvent({ kind: "result", response });
        }
      })
      .catch((err: Error) => {
        promptDone = true;
        pushEvent({ kind: "error", error: err.message });
      });

    // Yield events as they arrive
    try {
      while (true) {
        while (eventQueue.length > 0) {
          const evt = eventQueue.shift()!;
          yield evt;
          if (evt.kind === "result" || evt.kind === "error") return;
        }

        if (promptDone) break;

        if (options?.signal?.aborted) {
          await entry.client.cancel(entry.acpSessionId);
          yield { kind: "error", error: "Cancelled", code: "cancelled" };
          return;
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
  }

  async healthCheck(): Promise<boolean> {
    try {
      const { execSync } = await import("node:child_process");
      execSync("claude --version", { timeout: 5000, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  // ── Session pool management ────────────────────────────────────

  private async _ensureSession(chatId: string, options?: SendOptions): Promise<PoolEntry> {
    const existing = this._pool.get(chatId);
    if (existing?.client.alive) {
      if (options?.sessionId && options.sessionId !== existing.acpSessionId) {
        const result = await existing.client.loadSession(options.sessionId);
        existing.acpSessionId = result.sessionId;
      }
      if (options?.permissionMode) {
        await existing.client.setMode(existing.acpSessionId, options.permissionMode);
      }
      return existing;
    }

    if (existing) {
      await existing.client.stop();
      this._pool.delete(chatId);
    }

    const cwd = options?.cwd ?? this._options.cwd ?? homedir();
    const env: Record<string, string> = {};
    if (this._options.apiKey) {
      env.ANTHROPIC_API_KEY = this._options.apiKey;
    }
    if (this._options.baseUrl) env.ANTHROPIC_BASE_URL = this._options.baseUrl;

    // Build session meta via adapter (agent-specific options)
    const sessionMeta = this._adapter.buildSessionMeta({
      model: this._options.model,
      allowedTools: options?.allowedTools ?? this._options.allowedTools,
      permissionMode: options?.permissionMode,
      additionalDirectories: options?.addDirs,
    });

    const client = new AcpClient({
      executable: this._options.executable ?? this._adapter.defaultExecutable(),
      cwd,
      env,
      claudeCodeOptions: sessionMeta?.claudeCode?.options as Record<string, unknown> | undefined,
      onPermissionRequest: (params) => this._handlePermission(params),
      onSessionUpdate: () => {},
      log: (...args) => {
        if (process.env.REMI_DEBUG) console.error(...args);
      },
    });

    await client.start();
    await client.initialize();

    let acpSessionId: string;
    if (options?.sessionId) {
      const result = await client.resumeSession(options.sessionId, cwd);
      acpSessionId = result.sessionId;
    } else {
      const result = await client.newSession({ cwd, _meta: sessionMeta });
      acpSessionId = result.sessionId;
    }

    const entry: PoolEntry = {
      client,
      acpSessionId,
      lastUsed: Date.now(),
      mapperState: createMapperState(),
    };

    this._pool.set(chatId, entry);
    this._startCleanupTimer();
    return entry;
  }

  private async _handlePermission(params: RequestPermissionParams): Promise<PermissionOutcome> {
    if (this._permissionHandler) {
      return this._permissionHandler(params);
    }
    const allowOption = params.options.find(
      (o) => o.kind === "allow_once" || o.kind === "allow_always",
    );
    if (allowOption) return { outcome: "selected", optionId: allowOption.optionId };
    // No explicit allow option — select the first option available to avoid hard cancel
    const firstOption = params.options[0];
    if (firstOption) return { outcome: "selected", optionId: firstOption.optionId };
    return { outcome: "cancelled" };
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
        this._pool.delete(chatId);
      }
    } else {
      for (const [, entry] of this._pool) {
        try { await entry.client.closeSession(entry.acpSessionId); } catch {}
        await entry.client.stop();
      }
      this._pool.clear();
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

function buildAgentResponse(entry: PoolEntry, result: PromptResult): AgentResponse {
  const usage = entry.mapperState.usage;
  const durationMs = Date.now() - entry.mapperState.promptStartTime;
  const toolCalls = entry.mapperState.completedTools.map((t) => ({
    name: t.name,
    duration: t.durationMs ?? 0,
  }));

  // Reset per-prompt state for next prompt
  entry.mapperState.completedTools = [];
  entry.mapperState.promptStartTime = Date.now();

  return createAgentResponse({
    text: "",
    sessionId: entry.acpSessionId,
    model: usage.model,
    costUsd: usage.costUsd || null,
    inputTokens: usage.inputTokens || null,
    outputTokens: usage.outputTokens || null,
    cacheReadInputTokens: usage.cacheReadTokens || null,
    contextWindow: usage.contextWindowSize,
    durationMs,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    metadata: {
      stopReason: result.stopReason,
      provider: "acp",
    },
  });
}
