/**
 * Remi orchestrator — the Hub in Hub-and-Spoke architecture.
 *
 * Responsibilities:
 * 1. Receive messages from any connector (IncomingMessage)
 * 2. Lane Queue — serialize per chatId to prevent race conditions
 * 3. Session management — chatId → sessionId mapping
 * 4. Memory injection — assemble context before calling provider
 * 5. Provider routing — select provider + fallback
 * 6. Response dispatch — return AgentResponse via originating connector
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { RemiConfig } from "./config.js";
import { GroupConfigStore } from "./group/store.js";
import type { GroupConfig } from "./group/model.js";
import { ProjectStore } from "./project/store.js";
import type { Connector, IncomingMessage } from "./connectors/base.js";
import { createAgentResponse, type AgentResponse, type Provider, type ProviderEvent } from "./providers/base.js";
import type { ToolCallUpdate, ToolCallProgressUpdate } from "./providers/acp/protocol.js";
import { ClaudeCLIProvider } from "./providers/claude-cli/index.js";
import { AcpProvider, resolveAcpPermissionMode } from "./providers/acp/index.js";
import { FeishuConnector } from "./connectors/feishu/index.js";
import { flushDedupCacheSync } from "./connectors/feishu/receive.js";
import { MenuSyncer } from "./connectors/feishu/menu-sync.js";

import { AuthStore, FeishuAuthAdapter, ByteDanceSSOAdapter } from "./auth/index.js";
import type { TokenSyncRule } from "./auth/token-sync.js";
import { MemoryStore } from "./memory/store.js";
import { RemiQueueManager } from "./queue/index.js";
import { MetricsCollector } from "./metrics/collector.js";
import { insertConversationProcessing, completeConversation, failConversation, getDb } from "./db/index.js";
import * as sessDb from "./db/sessions.js";
import { createLogger, flushLogs } from "./logger.js";
import { TraceCollector, type TraceContext, type Span } from "./tracing.js";
import { writeEcosystem, runBuildsSync, getEcosystemPath } from "./pm2.js";
import {
  availableSwitchModes,
  buildSwitchTarget,
  defaultSwitchMode,
  isKnownSwitchMode,
  parseSwitchArgs,
  providerLabel,
  resolveSwitchProviderAlias,
} from "./switch-mode.js";

const log = createLogger("core");

/** Simple promise-based mutex for per-lane serialization. */
class AsyncLock {
  private _queue: Array<() => void> = [];
  private _locked = false;

  /** True when no one holds or waits for the lock. */
  get isIdle(): boolean {
    return !this._locked && this._queue.length === 0;
  }

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }
}

// System prompt now lives in ~/.remi/soul.md (symlinked to ~/.claude/CLAUDE.md)
// Claude CLI loads it automatically — no need to inject via --append-system-prompt


export class Remi {
  config: RemiConfig;
  memory: MemoryStore;
  metrics: MetricsCollector;
  traceCollector: TraceCollector;
  queue: RemiQueueManager;
  authStore: AuthStore | null = null;
  _configManager: any = null; // ConfigManager instance
  _providers = new Map<string, Provider>();
  private _connectors: Connector[] = [];
  private _laneLocks = new Map<string, AsyncLock>();
  private _activeAborts = new Map<string, AbortController>();
  private _onRestart: ((info: { chatId: string; connectorName?: string }) => void) | null = null;

  constructor(config: RemiConfig) {
    this.config = config;
    // Initialize VectorStore if embedding config is available
    let vectorStore: InstanceType<typeof import("./db/vector-store.js").VectorStore> | null = null;
    if (config.embedding?.apiKey) {
      try {
        const { VectorStore } = require("./db/vector-store.js");
        vectorStore = new VectorStore(config.embedding);
      } catch { /* vector search unavailable */ }
    }
    this.memory = new MemoryStore(config.memoryDir, vectorStore);
    this.metrics = new MetricsCollector(dirname(config.memoryDir));
    this.traceCollector = new TraceCollector();
    this.queue = new RemiQueueManager(this.memory);
    this._migrateSessionsJson();
  }

  // ── Provider management ──────────────────────────────────

  addProvider(provider: Provider): void {
    this._providers.set(provider.name, provider);
  }

  _getProvider(name?: string | null): Provider {
    const n = name ?? this.config.provider.name;
    let provider = this._providers.get(n);
    if (!provider) {
      // "acp" → match first "acp:*" variant
      for (const [key, p] of this._providers) {
        if (key.startsWith(`${n}:`)) {
          provider = p;
          break;
        }
      }
    }
    if (!provider) {
      throw new Error(
        `Provider '${n}' not registered. Available: ${[...this._providers.keys()]}`,
      );
    }
    return provider;
  }

  // ── Connector management ─────────────────────────────────

  addConnector(connector: Connector): void {
    this._connectors.push(connector);
  }

  /** Get the Feishu connector (for mission pipeline streaming). */
  getFeishuConnector(): import("./connectors/feishu/index.js").FeishuConnector | null {
    return (this._connectors.find((c) => c.name === "feishu") as any) ?? null;
  }

  /** Register a callback that fires when /restart is invoked. */
  onRestart(cb: (info: { chatId: string; connectorName?: string }) => void): void {
    this._onRestart = cb;
  }

  /** Abort active processing for a session (called by /esc). */
  abortSession(sessionKey: string): void {
    const ac = this._activeAborts.get(sessionKey);
    if (ac) {
      ac.abort();
      log.info(`abortSession: aborted "${sessionKey}"`);
    }
  }

  // ── Lane Queue (per-chat serialization) ──────────────────

  private _getLaneLock(chatId: string): AsyncLock {
    if (!this._laneLocks.has(chatId)) {
      this._laneLocks.set(chatId, new AsyncLock());
    }
    return this._laneLocks.get(chatId)!;
  }

  // ── Session key resolution (thread-aware) ────────────────

  /**
   * Resolve session key for a message.
   * Thread messages (with rootId) get isolated sessions: `${chatId}:thread:${rootId}`.
   * Group messages without rootId use messageId as thread key (they will become thread roots).
   * P2P messages use plain `chatId` for continuous conversation.
   */
  _resolveSessionKey(msg: IncomingMessage): string {
    const rootId = msg.metadata?.rootId as string | undefined;
    if (rootId) {
      return `${msg.chatId}:thread:${rootId}`;
    }
    // Group messages without rootId: each @mention starts a new session
    // using messageId as thread key (Remi replies in thread, so subsequent
    // messages will have rootId = this messageId, matching this key)
    const chatType = msg.metadata?.chatType as string | undefined;
    const messageId = msg.metadata?.messageId as string | undefined;
    if (chatType === "group" && messageId) {
      return `${msg.chatId}:thread:${messageId}`;
    }
    return msg.chatId;
  }

  // ── Group config resolution ──────────────────────────────

  /** Look up group config from DB by chatId. Returns all routing info in one query. */
  private _getGroupConfig(chatId: string): GroupConfig | null {
    try {
      const store = new GroupConfigStore();
      return store.getByChatId(chatId);
    } catch {
      return null;
    }
  }

  // ── Message handling (the core loop) ─────────────────────

  async handleMessage(msg: IncomingMessage): Promise<AgentResponse> {
    const sessionKey = this._resolveSessionKey(msg);
    const lock = this._getLaneLock(sessionKey);
    await lock.acquire();
    try {
      return await this._process(msg);
    } finally {
      lock.release();
      if (lock.isIdle) this._laneLocks.delete(sessionKey);
    }
  }

  async handleMessageStream(
    msg: IncomingMessage,
    consumer: (stream: AsyncIterable<ProviderEvent>, meta: import("./connectors/base.js").StreamMeta) => Promise<void>,
  ): Promise<void> {
    const sessionKey = this._resolveSessionKey(msg);
    const lock = this._getLaneLock(sessionKey);
    await lock.acquire();
    // Create root trace span
    const msgPreview = msg.text.slice(0, 50).replace(/\n/g, " ");
    const rootSpan = this.traceCollector.startTrace(`handle: ${msgPreview}`, {
      "chat.id": msg.chatId,
      "session.key": sessionKey,
      "connector.name": msg.connectorName ?? "",
      "message.text": msg.text.slice(0, 200),
    });
    const existingSessionId = sessDb.getSessionId(sessionKey);

    // Phase 1: record "processing" immediately so we know this message exists
    let convId: number | null = null;
    const startMs = Date.now();
    try {
      // Resolve thread_id: rootId if reply, messageId if new group msg, null for P2P
      const _rootId = msg.metadata?.rootId as string | undefined;
      const _msgId = msg.metadata?.messageId as string | undefined;
      const _chatType = msg.metadata?.chatType as string | undefined;
      const threadId = _rootId ?? (_chatType === "group" ? _msgId : undefined);

      convId = insertConversationProcessing({
        chatId: msg.chatId,
        senderId: msg.sender,
        connector: msg.connectorName,
        messageId: _msgId,
        cliSessionId: existingSessionId ?? undefined,
        cliCwd: (msg.metadata?.cwd as string) ?? undefined,
        cliRoundStart: new Date().toISOString(),
        threadId,
        userMessage: msg.text,
        sessionKey,
      });
    } catch (e) {
      log.warn("insert conversation (processing) failed:", e);
    }

    // Create request-scoped logger with traceId = feishu messageId (available from the start)
    const traceId = (msg.metadata?.messageId as string) ?? undefined;
    const rlog = traceId ? log.child({ traceId }) : log;

    try {
      const existingDisplayName = sessDb.getDisplayName(sessionKey);
      const groupConfig = this._getGroupConfig(msg.chatId);
      const sessRow = sessDb.getSession(sessionKey);
      const providerName = groupConfig?.provider ?? sessRow?.provider ?? null;
      const provider = this._getProvider(providerName);
      const setPermHandler = typeof (provider as any).setPermissionHandler === "function"
        ? (handler: any) => (provider as any).setPermissionHandler(handler, sessionKey)
        : undefined;
      const agentType = typeof (provider as any).adapter?.agentType === "string"
        ? (provider as any).adapter.agentType
        : provider.name.startsWith("acp:")
          ? provider.name.slice("acp:".length)
          : null;
      const effectiveMode = agentType
        ? resolveAcpPermissionMode(agentType, sessRow?.mode)
        : sessRow?.mode ?? null;
      await consumer(this._processStream(msg, rootSpan.context(), convId, startMs, rlog), {
        sessionId: existingSessionId,
        displayName: existingDisplayName,
        providerName: provider.name,
        agentType,
        mode: effectiveMode,
        setPermissionHandler: setPermHandler,
      });
      rootSpan.end();
    } catch (e) {
      rootSpan.endWithError(e instanceof Error ? e.message : String(e));
      // Phase 2b: mark failed
      if (convId != null) {
        try { failConversation(convId, e instanceof Error ? e.message : String(e), Date.now() - startMs); } catch {}
      }
      throw e;
    } finally {
      // Guarantee span is always recorded — SpanImpl._ended prevents double-write
      rootSpan.end();
      this._activeAborts.delete(sessionKey);
      lock.release();
      if (lock.isIdle) this._laneLocks.delete(sessionKey);
    }
  }

  private async *_processStream(msg: IncomingMessage, traceCtx?: TraceContext, convId?: number | null, startMs?: number, rlog?: import("./logger.js").Logger): AsyncGenerator<ProviderEvent> {
    const _log = rlog ?? log; // request-scoped logger (with traceId) or fallback to global

    let resultResponse: AgentResponse | null = null;

    // Handle slash commands — use rawContent (without speaker prefix) for detection
    const rawContent = (msg.metadata?.rawContent as string) ?? msg.text;
    const cmdResponse = await this._tryCommand(rawContent, msg);
    if (cmdResponse) {
      yield { sessionUpdate: "agent_message_chunk" as const, content: [{ type: "text" as const, text: cmdResponse.text }] };
      resultResponse = cmdResponse;
      return;
    }

    // Handle report detail request
    const reportResponse = this._tryReportDetail(msg.text);
    if (reportResponse) {
      yield { sessionUpdate: "agent_message_chunk" as const, content: [{ type: "text" as const, text: reportResponse.text }] };
      resultResponse = reportResponse;
      return;
    }

    const sessionKey = this._resolveSessionKey(msg);
    const groupConfig = this._getGroupConfig(msg.chatId);
    // CWD priority: group-level override > project cwd > session > message metadata
    const cwd = groupConfig?.cwd || groupConfig?.projectCwd || sessDb.getSession(sessionKey)?.cwd || (msg.metadata?.cwd as string) || undefined;

    const sessRow = sessDb.getSession(sessionKey);
    const existingSessionId = sessRow?.session_id || undefined;
    _log.info(`session lookup: key="${sessionKey}" → ${existingSessionId ? `resume="${existingSessionId.slice(0, 12)}..."` : "new session"}${groupConfig ? ` [group: ${groupConfig.projectId}]` : ""}`);
    const msgTraceId = (msg.metadata?.messageId as string) ?? undefined;

    // AbortController for /esc — allows immediate readline interruption
    const abortController = new AbortController();
    this._activeAborts.set(sessionKey, abortController);

    // Inject chat metadata for groups with injectChatContext enabled
    const chatMeta = groupConfig?.injectChatContext
      ? `\n[chat_context] chatId=${msg.chatId} sender=${msg.sender} senderOpenId=${msg.metadata?.senderOpenId ?? "unknown"}`
      : "";
    const effectiveSystemPrompt = groupConfig?.systemPrompt
      ? groupConfig.systemPrompt + chatMeta
      : chatMeta || undefined;

    const streamOptions = {
      systemPrompt: effectiveSystemPrompt,
      chatId: this._resolveSessionKey(msg),
      sessionId: existingSessionId,
      cwd: cwd ?? undefined,
      media: msg.media,
      allowedTools: groupConfig?.allowedTools?.length ? groupConfig.allowedTools : undefined,
      addDirs: groupConfig?.addDirs?.length ? groupConfig.addDirs : undefined,
      permissionMode: sessRow?.mode ?? undefined,
      traceId: msgTraceId,
      signal: abortController.signal,
    };

    // Provider selection:
    // 1. Group → GroupConfig.provider (DB)
    // 2. P2P → DB session provider (user switched via /switch or bot menu)
    // 3. Default → config.provider.name
    const providerName =
      groupConfig?.provider                              // group-level config (DB)
      ?? sessRow?.provider                               // P2P user choice
      ?? null;                                           // fall through to default
    const provider = this._getProvider(providerName);

    if (typeof provider.sendStream !== "function") {
      throw new Error(`Provider "${provider.name}" does not support streaming`);
    }

    // Span: provider chat
    const providerSpan = traceCtx?.startSpan("provider.chat", {
      "provider.name": provider.name,
      "session.id": existingSessionId ?? "new",
    });

    _log.debug("starting provider.sendStream iteration");
    const toolSpans = new Map<string, Span>(); // toolUseId → Span
    let promptTooLong = false;
    let staleSession = false;

    const toolCallMap = new Map<string, { name: string; toolUseId: string; input?: Record<string, unknown>; resultPreview?: string; durationMs?: number }>();

    try {
      for await (const event of provider.sendStream(msg.text, streamOptions)) {
        _log.debug(`received event: ${event.sessionUpdate}`);
        yield event;

        if (event.sessionUpdate === "tool_call") {
          const tc = event as ToolCallUpdate;
          const toolName = (tc._meta as any)?.claudeCode?.toolName ?? tc.title ?? "unknown";
          toolCallMap.set(tc.toolCallId, { name: toolName, toolUseId: tc.toolCallId, input: tc.rawInput as Record<string, unknown> });
          if (providerSpan) {
            const toolSpan = providerSpan.context().startSpan(`tool.${toolName}`, {
              "tool.name": toolName,
              "tool.use_id": tc.toolCallId,
              "tool.input": JSON.stringify(tc.rawInput ?? {}).slice(0, 4096),
            });
            toolSpans.set(tc.toolCallId, toolSpan);
          }
        } else if (event.sessionUpdate === "tool_call_update") {
          const tc = event as ToolCallProgressUpdate;
          if (tc.status === "completed" || tc.status === "failed") {
            const existing = toolCallMap.get(tc.toolCallId);
            if (existing) {
              existing.resultPreview = tc.rawOutput ? String(tc.rawOutput).slice(0, 2048) : undefined;
            }
            const toolSpan = toolSpans.get(tc.toolCallId);
            if (toolSpan) {
              if (tc.rawOutput) toolSpan.setAttribute("tool.output", String(tc.rawOutput).slice(0, 4096));
              toolSpan.end();
              toolSpans.delete(tc.toolCallId);
            }
          }
        }
      }
    } catch (streamErr) {
      _log.error(`Stream error: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`);
      const errText = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (/prompt.*(too long|too_long)|context.*(too long|exceed)/i.test(errText)) {
        promptTooLong = true;
      } else if (existingSessionId && /no conversation found/i.test(errText)) {
        staleSession = true;
      }
    }

    // Get response from provider after stream ends
    resultResponse = provider.getLastResponse?.() ?? null;
    // Detect prompt-too-long from response text
    if (!promptTooLong && resultResponse && /prompt.*(too long|too_long)|context.*(too long|exceed)/i.test(resultResponse.text)) {
      promptTooLong = true;
    }
    if (!staleSession && existingSessionId && resultResponse && resultResponse.inputTokens === 0 && resultResponse.durationMs === 0) {
      staleSession = true;
    }

    // End any unclosed tool spans
    for (const [, s] of toolSpans) s.end();
    toolSpans.clear();

    // ── Auto-recovery: prompt too long → reset session + retry ──
    if (promptTooLong) {
      _log.warn(`Prompt too long for "${sessionKey}", auto-resetting session and retrying`);
      providerSpan?.endWithError("prompt_too_long");

      // Clear session mapping (keep display_name)
      sessDb.clearSessionId(sessionKey);

      // Kill the old process so a fresh one is spawned on retry
      if ("clearSession" in provider && typeof provider.clearSession === "function") {
        await (provider as Provider & { clearSession: (k?: string) => Promise<void> }).clearSession(sessionKey);
      }

      // Notify user via card content
      yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "上下文过长，已自动重置会话。正在重新处理...\n\n" }] } as ProviderEvent;

      const retryOptions = { ...streamOptions, sessionId: undefined };
      resultResponse = null;
      for await (const event of provider.sendStream(msg.text, retryOptions)) {
        yield event;
      }
      resultResponse = provider.getLastResponse?.() ?? null;
    }

    // ── Auto-recovery: stale session → clear session + retry ──
    if (staleSession) {
      _log.warn(`Stale session for "${sessionKey}" (sessionId=${existingSessionId}), auto-resetting and retrying`);
      providerSpan?.endWithError("stale_session");

      sessDb.clearSessionId(sessionKey);

      if ("clearSession" in provider && typeof provider.clearSession === "function") {
        await (provider as Provider & { clearSession: (k?: string) => Promise<void> }).clearSession(sessionKey);
      }

      yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "会话已过期，自动重置。正在重新处理...\n\n" }] } as ProviderEvent;

      const retryOptions = { ...streamOptions, sessionId: undefined };
      resultResponse = null;
      for await (const event of provider.sendStream(msg.text, retryOptions)) {
        yield event;
      }
      resultResponse = provider.getLastResponse?.() ?? null;
    }

    if (!promptTooLong && !staleSession) {
      // Attach result attributes to provider span
      if (resultResponse && providerSpan) {
        providerSpan.setAttributes({
          "llm.model": resultResponse.model ?? "unknown",
          "llm.input_tokens": resultResponse.inputTokens ?? 0,
          "llm.output_tokens": resultResponse.outputTokens ?? 0,
          "llm.cost_usd": resultResponse.costUsd ?? 0,
          "llm.duration_ms": resultResponse.durationMs ?? 0,
          "llm.response": resultResponse.text.slice(0, 4096),
          "llm.thinking": (resultResponse.thinking ?? "").slice(0, 4096),
        });
      }

      // Fallback: if primary result was an error, try fallback provider
      if (
        resultResponse &&
        (resultResponse.text.startsWith("[Provider error") ||
          resultResponse.text.startsWith("[Provider timeout"))
      ) {
        providerSpan?.endWithError("primary provider failed");

        const fallbackName = this.config.provider.fallback;
        if (fallbackName && this._providers.has(fallbackName)) {
          _log.warn(`Primary provider failed, trying fallback: ${fallbackName}`);
          const fallbackSpan = traceCtx?.startSpan("provider.chat.fallback", {
            "provider.name": fallbackName,
          });
          const fallback = this._providers.get(fallbackName)!;
          if (typeof fallback.sendStream === "function") {
            for await (const event of fallback.sendStream(msg.text, streamOptions)) {
              yield event;
            }
            resultResponse = fallback.getLastResponse?.() ?? null;
          } else {
            resultResponse = await fallback.send(msg.text, streamOptions);
            yield { sessionUpdate: "agent_message_chunk" as const, content: [{ type: "text" as const, text: resultResponse.text }] };
          }
          fallbackSpan?.end();
        }
      } else {
        providerSpan?.end();
      }
    }

    // Update session + daily notes
    if (resultResponse) {
      if (resultResponse.sessionId) {
        const displayName = sessDb.upsertSession(sessionKey, resultResponse.sessionId);
        _log.debug(`session stored: key="${sessionKey}" → "${resultResponse.sessionId.slice(0, 12)}..." (${displayName})`);
      }
      this.memory.appendDaily(
        `[${msg.connectorName ?? ""}] ${msg.sender ?? ""}: ${msg.text.slice(0, 100)}`,
      );

      // Record token metrics
      if (resultResponse.inputTokens || resultResponse.outputTokens) {
        this.metrics.record({
          ts: new Date().toISOString(),
          src: "remi",
          sid: resultResponse.sessionId ?? null,
          model: resultResponse.model ?? null,
          in: resultResponse.inputTokens ?? 0,
          out: resultResponse.outputTokens ?? 0,
          cacheCreate: resultResponse.cacheCreateInputTokens ?? 0,
          cacheRead: resultResponse.cacheReadInputTokens ?? 0,
          cost: resultResponse.costUsd ?? null,
          dur: resultResponse.durationMs ?? null,
          project: cwd ?? null,
          connector: msg.connectorName ?? null,
        });
      }

      // Write conversation record to SQLite (Remi business context + CLI correlation)
      // CLI JSONL (~/.claude/projects/) is the full trace; this table is the index.
      try {
        const spans: Array<Record<string, unknown>> = [];

        // Memory assembly span (duration not available from Span interface)
        spans.push({ op: "memory.assemble" });

        // Provider chat span
        spans.push({
          op: "provider.chat",
          ms: resultResponse.durationMs ?? 0,
          model: resultResponse.model,
          tool_count: toolCallMap.size,
        });

        // Tool call details
        for (const tc of toolCallMap.values()) {
          spans.push({ op: `tool.${tc.name}`, ms: tc.durationMs ?? 0 });
        }

        // Phase 2a: update to "completed" with full results
        if (convId != null) {
          completeConversation({
            id: convId,
            costUsd: resultResponse.costUsd ?? undefined,
            durationMs: startMs ? Date.now() - startMs : resultResponse.durationMs ?? undefined,
            cliSessionId: resultResponse.sessionId ?? undefined,
            cliRoundEnd: new Date().toISOString(),
            cliMessageIds: (resultResponse.metadata?.messageIds as string[]) ?? undefined,
            model: resultResponse.model ?? undefined,
            inputTokens: resultResponse.inputTokens ?? undefined,
            outputTokens: resultResponse.outputTokens ?? undefined,
            cacheCreateTokens: resultResponse.cacheCreateInputTokens ?? undefined,
            cacheReadTokens: resultResponse.cacheReadInputTokens ?? undefined,
            spans,
          });
        }

        // Trigger memory extraction check via BunQueue (fire-and-forget)
        this.queue.enqueueConversation({
          sessionKey,
          chatId: msg.chatId,
        }).catch((e) => log.warn("enqueue conversation trigger failed:", e));
      } catch (e) {
        _log.warn("insert conversation failed:", e);
      }
    }
  }

  private async _process(msg: IncomingMessage): Promise<AgentResponse> {
    let lastResponse: AgentResponse | null = null;
    for await (const event of this._processStream(msg)) {
      // consume all events
    }
    const provider = this._getProvider();
    lastResponse = provider.getLastResponse?.() ?? null;
    if (!lastResponse) {
      return createAgentResponse({ text: "[Error: no result from provider]" });
    }
    return lastResponse;
  }

  // ── Slash commands ───────────────────────────────────────

  private static COMMANDS = new Set(["clear", "new", "status", "restart", "project", "p", "context", "compact", "switch", "sessions"]);

  private async _tryCommand(text: string, msg: IncomingMessage): Promise<AgentResponse | null> {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;

    const spaceIdx = trimmed.indexOf(" ");
    const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();

    if (!Remi.COMMANDS.has(name)) return null; // Unknown command → pass to provider

    const sessionKey = this._resolveSessionKey(msg);
    const isThread = sessionKey !== msg.chatId;

    switch (name) {
      case "clear":
      case "new": {
        sessDb.deleteSession(sessionKey);
        // Also clear the underlying provider's conversation context
        const provider = this._getProvider();
        if ("clearSession" in provider && typeof provider.clearSession === "function") {
          await (provider as Provider & { clearSession: (chatId?: string) => Promise<void> }).clearSession(sessionKey);
        }
        return { text: "上下文已清除，开始新对话。" };
      }
      case "switch": {
        const groupCfg = this._getGroupConfig(msg.chatId);
        if (groupCfg?.provider) {
          return { text: `此群 provider 已由管理员固定为 ${providerLabel(groupCfg.provider)}，无法通过 /switch 切换。` };
        }
        const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

        if (!args) {
          // Show current state + available options
          const switchSessRow = sessDb.getSession(sessionKey);
          const curProvider = resolveSwitchProviderAlias(switchSessRow?.provider ?? this.config.provider.name);
          const curMode = switchSessRow?.mode ?? defaultSwitchMode(curProvider) ?? "agent default";
          const lines = [
            `当前: **${providerLabel(curProvider)} · ${curMode === "bypassPermissions" ? "bypass" : curMode}**`,
            "",
            "可用组合:",
            "  `/switch claude` 或 `/switch claude:auto` — ACP Claude Auto（默认，若 agent 不支持会回退 default）",
            "  `/switch claude:default` — ACP Claude 标准权限确认",
            "  `/switch claude:acceptEdits` — ACP Claude 自动接受编辑",
            "  `/switch claude:plan` — ACP Claude Plan 模式",
            "  `/switch claude:dontAsk` — ACP Claude 不询问，未预批准则拒绝",
            "  `/switch claude:bypass` — ACP Claude 跳过权限检查",
            "  `/switch cli:bypass` — 旧 Claude CLI 全权限",
          ];
          if (this._providers.has("acp:codex")) {
            lines.push("  `/switch codex[:mode]` — ACP Codex（mode 由 agent 定义）");
          }
          return { text: lines.join("\n") };
        }

        // Parse provider:mode. Use the last colon so "acp:claude:auto" also works.
        const { providerAlias, modeArg } = parseSwitchArgs(args);
        const target = buildSwitchTarget(providerAlias, modeArg);
        const providerName = target.providerName;
        let provider: Provider;
        try {
          provider = this._getProvider(providerName);
        } catch {
          return { text: `Provider "${providerAlias}" 不可用。可选: claude, codex, cli` };
        }

        if (target.mode && !isKnownSwitchMode(providerName, target.mode)) {
          const available = availableSwitchModes(providerName).join(", ");
          return { text: `模式 "${modeArg}" 对 ${providerLabel(providerName)} 不可用。可选: ${available}` };
        }

        const curProviderName = resolveSwitchProviderAlias(sessDb.getSession(sessionKey)?.provider ?? this.config.provider.name);
        const providerChanged = curProviderName !== providerName;

        if (providerChanged) {
          // Switching provider — clear old session (sessionId is provider-specific)
          let oldProvider: Provider | null = null;
          try { oldProvider = this._getProvider(curProviderName); } catch {}
          if (oldProvider && "clearSession" in oldProvider && typeof (oldProvider as any).clearSession === "function") {
            await (oldProvider as any).clearSession(sessionKey);
          }
          sessDb.clearSessionId(sessionKey);
        } else {
          // Same provider, mode change only — kill process but keep sessionId for resume
          if (provider && "clearSession" in provider && typeof (provider as any).clearSession === "function") {
            await (provider as any).clearSession(sessionKey);
          }
          // Don't clear session — preserve sessionId for --resume
        }

        sessDb.upsertSessionSettings(sessionKey, {
          provider: providerName,
          mode: target.storedMode,
          clearSessionId: providerChanged,
        });

        const resumeNote = !providerChanged ? "（上下文保留）" : "（新对话）";
        return { text: `已切换到 **${providerLabel(providerName)} · ${target.modeLabel}** ${resumeNote}` };
      }
      case "restart": {
        // Delay restart so the response gets sent first
        if (this._onRestart) {
          const info = { chatId: msg.chatId, connectorName: msg.connectorName };
          setTimeout(() => this._onRestart!(info), 500);
        }
        return { text: "正在重启 Remi..." };
      }
      case "project":
      case "p": {
        const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
        const projectStore = new ProjectStore();

        if (!arg) {
          // Show current project + list
          const currentCwd = sessDb.getSession(sessionKey)?.cwd ?? undefined;
          const projects = projectStore.list().filter((p) => p.cwd);
          const lines = [`📍 当前: ${currentCwd ?? "~ (默认)"}`];
          if (projects.length > 0) {
            lines.push("", "可用项目:");
            for (const p of projects) {
              const marker = currentCwd === p.cwd ? " ◀" : "";
              lines.push(`  ${p.id}  →  ${p.cwd}${marker}`);
            }
          } else {
            lines.push("", "暂无注册项目，请在 Dashboard → Projects 中添加。");
          }
          return { text: lines.join("\n") };
        }

        if (arg === "reset") {
          sessDb.updateSessionCwd(sessionKey, null);
          sessDb.clearSessionId(sessionKey);
          const provider = this._getProvider();
          if ("clearSession" in provider && typeof provider.clearSession === "function") {
            await (provider as Provider & { clearSession: (chatId?: string) => Promise<void> }).clearSession(sessionKey);
          }
          return { text: "已清除项目绑定，下条消息将在默认目录启动。" };
        }

        // Resolve alias or direct path
        let targetPath: string;
        const matched = projectStore.getById(arg);
        if (matched?.cwd) {
          targetPath = matched.cwd;
        } else {
          // Treat as direct path, expand ~
          targetPath = arg.startsWith("~") ? arg.replace("~", homedir()) : resolve(arg);
        }

        if (!existsSync(targetPath)) {
          return { text: `路径不存在: ${targetPath}` };
        }

        // Kill old process, bind new cwd
        this._configManager?.ensureForCwd(targetPath);
        sessDb.updateSessionCwd(sessionKey, targetPath);
        sessDb.clearSessionId(sessionKey);
        const provider = this._getProvider();
        if ("clearSession" in provider && typeof provider.clearSession === "function") {
          await (provider as Provider & { clearSession: (chatId?: string) => Promise<void> }).clearSession(sessionKey);
        }

        // Find alias name for display
        const aliasName = matched?.id ?? projectStore.list().find((p) => p.cwd === targetPath)?.id;
        return { text: `项目已切换: ${aliasName ? `${aliasName} (${targetPath})` : targetPath}\n下条消息将在新目录启动 Claude。` };
      }
      case "context": {
        // Forward /context to CLI to get detailed context usage breakdown
        const provider = this._getProvider();
        try {
          const resp = await provider.send("/context", { chatId: sessionKey, sessionId: sessDb.getSessionId(sessionKey) ?? undefined });
          return { text: resp.text || "无法获取 context 信息" };
        } catch {
          return { text: "无法获取 context 信息，当前会话可能未启动。" };
        }
      }
      case "compact": {
        // Forward /compact to CLI to compress conversation context
        const provider = this._getProvider();
        try {
          const resp = await provider.send("/compact", { chatId: sessionKey, sessionId: sessDb.getSessionId(sessionKey) ?? undefined });
          return { text: resp.text || "Compact 完成" };
        } catch {
          return { text: "Compact 失败，当前会话可能未启动。" };
        }
      }
      case "sessions": {
        const allActive = sessDb.listActiveSessions();
        if (allActive.length === 0) {
          return { text: "当前无活跃 session。" };
        }
        const lines = [`**活跃 Sessions** (${allActive.length}):`];
        for (const s of allActive) {
          const isCurrent = s.session_key === sessionKey;
          const time = new Date(s.last_active);
          const hh = String(((time.getUTCHours() + 8) % 24)).padStart(2, "0");
          const mm = String(time.getUTCMinutes()).padStart(2, "0");
          lines.push(`  ${s.display_name} | ${hh}:${mm} | ${s.session_id ? s.session_id.slice(0, 8) : "new"}${isCurrent ? " ← 当前" : ""}`);
        }
        return { text: lines.join("\n") };
      }
      case "status": {
        const statusRow = sessDb.getSession(sessionKey);
        const providers = [...this._providers.keys()].join(", ");
        const connectors = this._connectors.map((c) => c.name).join(", ");
        const lines = [
          `**Remi Status**`,
          `- Session: ${statusRow?.session_id ? statusRow.session_id.slice(0, 12) + "..." : "无"}`,
          statusRow?.display_name ? `- Name: ${statusRow.display_name}` : "",
          isThread ? `- Context: Thread (isolated)` : `- Context: Main chat`,
          statusRow?.cwd ? `- Project: ${statusRow.cwd}` : `- Project: ~ (默认)`,
          `- Providers: ${providers}`,
          `- Connectors: ${connectors}`,
        ].filter(Boolean);
        if (this.authStore) {
          for (const s of this.authStore.status()) {
            const ttl = Math.round((s.expiresAt - Date.now()) / 1000 / 60);
            lines.push(
              `- Token ${s.service}/${s.type}: ${s.valid ? `valid (${ttl}min)` : "expired"}`,
            );
          }
        }
        return { text: lines.join("\n") };
      }
      default:
        return null;
    }
  }

  // ── Report detail on demand ─────────────────────────────

  private _tryReportDetail(text: string): AgentResponse | null {
    const trimmed = text.trim();
    if (!trimmed.includes("详细报告") && !trimmed.includes("完整报告")) return null;

    const today = new Date().toISOString().slice(0, 10);

    for (const skill of this.config.scheduledSkills) {
      if (!skill.enabled) continue;
      const reportPath = join(skill.outputDir, `${today}.md`);
      if (existsSync(reportPath)) {
        return { text: readFileSync(reportPath, "utf-8").trim() };
      }
    }

    return { text: `今天（${today}）还没有生成报告，请稍后再试。` };
  }

  // ── Static factory ─────────────────────────────────────────

  /**
   * Build a fully-wired Remi instance from config.
   * Replaces the old RemiDaemon._buildRemi() — all component assembly in one place.
   */
  static boot(config: RemiConfig): Remi {
    const remi = new Remi(config);

    // 1. AuthStore (1Passport) with token sync rules
    const syncRules: TokenSyncRule[] | undefined =
      config.tokenSync.length > 0
        ? (config.tokenSync as TokenSyncRule[])
        : undefined;
    const authStore = new AuthStore(join(homedir(), ".remi", "auth"), syncRules);
    const hasFeishuCreds = !!(config.feishu.appId && config.feishu.appSecret);
    if (hasFeishuCreds) {
      authStore.registerAdapter(
        new FeishuAuthAdapter({
          appId: config.feishu.appId,
          appSecret: config.feishu.appSecret,
          domain: config.feishu.domain,
          userAccessToken: config.feishu.userAccessToken || undefined,
        }),
      );
    }
    if (config.bytedanceSso?.clientId) {
      authStore.registerAdapter(
        new ByteDanceSSOAdapter(config.bytedanceSso),
      );
      log.info("Registered ByteDance SSO adapter (1Passport)");
    }
    remi.authStore = authStore;

    // 2. Providers — register primary + fallback + ACP siblings
    const provider = Remi._buildProvider(config);
    remi.addProvider(provider);

    if (config.provider.fallback) {
      try {
        const fallback = Remi._buildProvider(config, config.provider.fallback);
        remi.addProvider(fallback);
      } catch (e) {
        log.warn("Failed to build fallback provider:", e);
      }
    }

    // Auto-register ACP sibling (claude↔codex) so /switch works
    const ACP_SIBLINGS: Record<string, string> = { "acp:claude": "acp:codex", "acp:codex": "acp:claude" };
    const sibling = ACP_SIBLINGS[provider.name];
    if (sibling && !remi._providers.has(sibling)) {
      try {
        remi.addProvider(Remi._buildProvider(config, sibling));
      } catch (e) {
        log.warn(`Failed to build ACP sibling provider ${sibling}:`, e);
      }
    }


    // 3. Feishu connector
    if (hasFeishuCreds) {
      const feishuConfig = { ...config.feishu };
      const feishu = new FeishuConnector(feishuConfig);
      feishu.setTokenProvider(() => authStore.getToken("feishu", "tenant"));
      // Wire /esc abort: (1) signal abort to unblock readline, (2) kill CLI process
      feishu.setAbortHandler(async (chatId: string) => {
        remi.abortSession(chatId);  // Immediately unblock _readline via AbortSignal
        const provider = remi._getProvider();
        if ("clearSession" in provider && typeof provider.clearSession === "function") {
          await (provider as Provider & { clearSession: (k?: string) => Promise<void> }).clearSession(chatId);
        }
      });
      remi.addConnector(feishu);
      log.info("Registered Feishu connector (with 1Passport)");

      // Bot menu sync (fire-and-forget on startup) — remi.toml is the single source of truth
      const menuSyncer = new MenuSyncer({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
        domain: config.feishu.domain,
      });
      menuSyncer.syncAll(config.botMenu, config.feishu.triggerUserIds).catch((err) => {
        log.warn(`Bot menu sync failed: ${err.message}`);
      });
    }

    // 4. ConfigManager — symlinks + cc-switch sync
    const { configManager } = require("./infra/config-manager");
    remi._configManager = configManager;
    configManager.ensureAllProjects();
    configManager.ensureGlobals();

    // 5. Restart handler
    remi.onRestart((info) => remi._handleRestart(info));

    return remi;
  }

  private static _buildProvider(config: RemiConfig, name?: string | null) {
    const n = name ?? config.provider.name;
    if (n === "claude_cli") {
      return new ClaudeCLIProvider({
        model: config.provider.model,
        timeout: config.provider.timeout,
        allowedTools: config.provider.allowedTools,
        cwd: homedir(),
        apiKey: config.provider.apiKey,
        baseUrl: config.provider.baseUrl,
      });
    }
    if (n === "acp" || n === "acp:claude" || n === "acp:codex") {
      const agentType = n.includes(":") ? n.split(":")[1] : "claude";
      return new AcpProvider({
        agentType,
        model: config.provider.model,
        timeout: config.provider.timeout,
        allowedTools: config.provider.allowedTools,
        cwd: homedir(),
        apiKey: config.provider.apiKey,
        baseUrl: config.provider.baseUrl,
        executable: config.provider.executable ?? undefined,
      });
    }
    throw new Error(`Unknown provider: ${n}`);
  }

  // ── Restart / notify ──────────────────────────────────────

  private static get _restartNotifyPath(): string {
    return join(homedir(), ".remi", "restart-notify.json");
  }

  private _handleRestart(info: { chatId: string; connectorName?: string }): void {
    log.info("Restart requested — rebuilding services and triggering PM2 restart...");

    // Save notify info so post-restart we can notify the user
    const dir = join(homedir(), ".remi");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(Remi._restartNotifyPath, JSON.stringify(info));

    flushDedupCacheSync();
    runBuildsSync(this.config);
    writeEcosystem(this.config);

    const child = spawn("pm2", ["restart", getEcosystemPath(), "--update-env"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  /** After startup, check if we need to notify someone that restart succeeded. */
  async sendRestartNotify(): Promise<void> {
    const filePath = Remi._restartNotifyPath;
    if (!existsSync(filePath)) return;

    let info: { chatId: string; connectorName?: string };
    try {
      const raw = readFileSync(filePath, "utf-8");
      info = JSON.parse(raw);
      unlinkSync(filePath);
      log.info(`Restart notify: connector=${info.connectorName}, chatId=${info.chatId}`);
    } catch (e) {
      log.warn("Restart notify: failed to read file:", e);
      if (existsSync(filePath)) unlinkSync(filePath);
      return;
    }

    const connector = this._connectors.find(
      (c) => c.name === (info.connectorName ?? ""),
    );
    if (!connector) {
      log.warn(
        `Restart notify: connector "${info.connectorName}" not found (available: ${this._connectors.map((c) => c.name).join(", ")})`,
      );
      return;
    }

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await connector.reply(info.chatId, { text: "Remi 重启成功，已上线。" });
        log.info(`Restart notification sent to ${info.connectorName}:${info.chatId}`);
        return;
      } catch (e) {
        log.warn(`Restart notify attempt ${attempt}/${maxRetries} failed: ${String(e)}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
    log.error("Restart notification failed after all retries.");
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._providers.size === 0) {
      throw new Error("No providers registered. Call addProvider() first.");
    }

    const tasks = this._connectors.map((c) =>
      c.start(this.handleMessage.bind(this), this.handleMessageStream.bind(this)),
    );
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  async stop(): Promise<void> {
    flushLogs();

    for (const connector of this._connectors) {
      await connector.stop();
    }

    for (const provider of this._providers.values()) {
      const closeable = provider as Provider & { close?: () => Promise<void> };
      if (typeof closeable.close === "function") {
        await closeable.close();
      }
    }
  }

  // ── Session migration (sessions.json → DB) ─────────────────

  /** One-time migration from sessions.json to SQLite. */
  private _migrateSessionsJson(): void {
    try {
      if (!existsSync(this.config.sessionsFile)) return;
      const raw = readFileSync(this.config.sessionsFile, "utf-8");
      const data = JSON.parse(raw) as sessDb.LegacySessionData;
      if (!data.entries || !Array.isArray(data.entries) || data.entries.length === 0) return;

      const count = sessDb.migrateFromJson(data);
      log.info(`Migrated ${count} session(s) from sessions.json to DB`);

      // Rename old file as backup (presence of .migrated = migration done)
      const { renameSync } = require("node:fs");
      renameSync(this.config.sessionsFile, this.config.sessionsFile + ".migrated");
      log.info(`Renamed sessions.json → sessions.json.migrated`);
    } catch (e) {
      log.warn("Failed to migrate sessions.json:", e);
    }
  }

  /** Get session display name for a session key. */
  getSessionDisplayName(sessionKey: string): string | null {
    return sessDb.getDisplayName(sessionKey);
  }
}
