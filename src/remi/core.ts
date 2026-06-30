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
import type { RemiConfig } from "../shared/config.js";
import { MEMORY_DIR, SESSIONS_FILE } from "../shared/config.js";
import { GroupConfigStore } from "./group/store.js";
import type { GroupConfig } from "./group/model.js";
import { ProjectStore } from "./project/store.js";
import type { Connector, IncomingMessage } from "../connectors/base.js";
import { LaneScheduler, resolveSessionKey } from "../daemon/orchestrator.js";
import { createAgentResponse, type AgentResponse, type Provider, type ProviderEvent } from "@shared/contracts/provider-types.js";
import type { ToolCallUpdate, ToolCallProgressUpdate } from "@acp/protocol.js";
import { AcpProvider, resolveAcpPermissionMode } from "@acp/index.js";
import { AgentRuntime } from "../daemon/agent-runtime/runtime.js";
import { AgentSession } from "../daemon/agent-runtime/session.js";
import type { AgentRunResult } from "../daemon/agent-runtime/types.js";
import { FeishuConnector } from "../connectors/feishu/index.js";
import { flushDedupCacheSync, MenuSyncer } from "../connectors/feishu/sdk.js";

import { AuthStore, FeishuAuthAdapter } from "../auth/index.js";
import type { TokenSyncRule } from "../auth/token-sync.js";
import { PluginRegistry } from "../daemon/agent-runtime/plugins/registry.js";
import { MemoryStore } from "../memory/store.js";
import { RemiQueueManager } from "../queue/index.js";
import { MetricsCollector } from "../shared/metrics/collector.js";
import { insertConversationProcessing, completeConversation, failConversation, getDb } from "../shared/db/index.js";
import * as sessDb from "../shared/db/sessions.js";
import { createLogger, flushLogs } from "../shared/logger.js";
import { TraceCollector, type TraceContext, type Span } from "../shared/tracing.js";
import { writeEcosystem, runBuildsSync, getEcosystemPath } from "../daemon/pm2.js";
import {
  availableSwitchModes,
  buildSwitchTarget,
  defaultSwitchMode,
  isKnownSwitchMode,
  parseSwitchArgs,
  providerLabel,
  resolveSwitchProviderAlias,
} from "../acp/switch-mode.js";

const log = createLogger("core");

// AsyncLock + resolveSessionKey extracted to daemon/orchestrator.ts in D6.

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
  // Per-lane (per session-key) serialization. Unbounded by default, matching the
  // monolith's historical behavior; the shared LaneScheduler also caps total
  // concurrency, which is what the multiremi daemon uses via its SQL queue.
  private _scheduler = new LaneScheduler();
  private _activeAborts = new Map<string, AbortController>();
  private _runtime = new AgentRuntime();
  private _onRestart: ((info: { chatId: string; connectorName?: string }) => void) | null = null;

  constructor(config: RemiConfig) {
    this.config = config;
    // Initialize VectorStore if embedding config is available
    let vectorStore: InstanceType<typeof import("../shared/db/vector-store.js").VectorStore> | null = null;
    if (config.embedding?.apiKey) {
      try {
        const { VectorStore } = require("../shared/db/vector-store.js");
        vectorStore = new VectorStore(config.embedding);
      } catch { /* vector search unavailable */ }
    }
    this.memory = new MemoryStore(MEMORY_DIR, vectorStore);
    this.metrics = new MetricsCollector(dirname(MEMORY_DIR));
    this.traceCollector = new TraceCollector();
    this.queue = new RemiQueueManager();
    this._migrateSessionsJson();
  }

  // ── Provider management ──────────────────────────────────

  addProvider(provider: Provider): void {
    this._providers.set(provider.name, provider);
  }

  _getProvider(name?: string | null): Provider {
    const n = name ?? `acp:${this.config.provider.default}`;
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
  getFeishuConnector(): import("../connectors/feishu/index.js").FeishuConnector | null {
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

  // ── Session key resolution (thread-aware) ────────────────

  /**
   * Resolve session key for a message.
   * Thread messages (with rootId) get isolated sessions: `${chatId}:thread:${rootId}`.
   * Group messages without rootId use messageId as thread key (they will become thread roots).
   * P2P messages use plain `chatId` for continuous conversation.
   */
  _resolveSessionKey(msg: IncomingMessage): string {
    return resolveSessionKey(msg);
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
    return this._scheduler.run(sessionKey, () => this._process(msg));
  }

  async handleMessageStream(
    msg: IncomingMessage,
    consumer: (stream: AsyncIterable<ProviderEvent>, meta: import("../connectors/base.js").StreamMeta) => Promise<void>,
  ): Promise<void> {
    const sessionKey = this._resolveSessionKey(msg);
    await this._scheduler.run(sessionKey, async () => {
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
      const setElicHandler = typeof (provider as any).setElicitationHandler === "function"
        ? (handler: any) => (provider as any).setElicitationHandler(handler, sessionKey)
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
        setElicitationHandler: setElicHandler,
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
    }
    });
  }

  private async *_processStream(msg: IncomingMessage, traceCtx?: TraceContext, convId?: number | null, startMs?: number, rlog?: import("../shared/logger.js").Logger): AsyncGenerator<ProviderEvent, AgentResponse | null, unknown> {
    const _log = rlog ?? log; // request-scoped logger (with traceId) or fallback to global

    let resultResponse: AgentResponse | null = null;

    // Handle slash commands — use rawContent (without speaker prefix) for detection
    const rawContent = (msg.metadata?.rawContent as string) ?? msg.text;
    const cmdResponse = await this._tryCommand(rawContent, msg);
    if (cmdResponse) {
      yield { sessionUpdate: "agent_message_chunk" as const, content: [{ type: "text" as const, text: cmdResponse.text }] };
      resultResponse = cmdResponse;
      return resultResponse;
    }

    const sessionKey = this._resolveSessionKey(msg);
    const groupConfig = this._getGroupConfig(msg.chatId);
    const sessRow = sessDb.getSession(sessionKey);
    const existingSessionId = sessRow?.session_id || undefined;
    _log.info(`session lookup: key="${sessionKey}" → ${existingSessionId ? `resume="${existingSessionId.slice(0, 12)}..."` : "new session"}${groupConfig ? ` [group: ${groupConfig.projectId}]` : ""}`);

    // AbortController for /esc — allows immediate readline interruption
    const abortController = new AbortController();
    this._activeAborts.set(sessionKey, abortController);

    // Assemble config via AgentRuntime
    const runtimeCtx: import("../daemon/agent-runtime/types.js").PersistentContext = {
      kind: "persistent",
      message: msg,
      config: this.config,
      groupConfig,
      memory: this.memory,
      sessionRow: sessRow,
      sessionKey,
    };
    const sessionConfig = this._runtime.assemble(runtimeCtx);

    const cwd = sessionConfig.cwd;

    // Provider selection: group config (DB) → session provider → default
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

    // Run the turn through the shared AgentSession — the same execution wrapper
    // the multiremi worker uses — so stream iteration + auto-recovery
    // (prompt-too-long / stale-session) live in one place. onSessionReset drops
    // Remi's own session-DB mapping when AgentSession resets the provider session.
    _log.debug("starting AgentSession.run iteration");
    const toolSpans = new Map<string, Span>(); // toolUseId → Span
    const toolCallMap = new Map<string, { name: string; toolUseId: string; input?: Record<string, unknown>; resultPreview?: string; durationMs?: number }>();
    let streamedText = "";
    let streamedThinking = "";

    const session = new AgentSession(provider, {
      ...sessionConfig,
      signal: abortController.signal,
      recovery: {
        retryOnPromptTooLong: true,
        retryOnStaleSession: true,
        onSessionReset: () => { sessDb.clearSessionId(sessionKey); },
      },
    });

    let runResult: AgentRunResult | null = null;
    try {
      const iter = session.run(msg.text);
      let step = await iter.next();
      while (!step.done) {
        const event = step.value;
        _log.debug(`received event: ${event.sessionUpdate}`);
        if (event.sessionUpdate === "agent_message_chunk") {
          const blocks = Array.isArray(event.content) ? event.content : [event.content];
          for (const block of blocks) {
            if (block.type === "text") streamedText += block.text;
          }
        } else if (event.sessionUpdate === "agent_thought_chunk") {
          const blocks = Array.isArray(event.content) ? event.content : [event.content];
          for (const block of blocks) {
            if (block.type === "text") streamedThinking += block.text;
          }
        }
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
        step = await iter.next();
      }
      runResult = step.value;
    } catch (streamErr) {
      // Preserve prior behavior: an unrecoverable stream error degrades
      // gracefully (use whatever the provider already produced) rather than
      // aborting the turn.
      _log.error(`Stream error: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`);
    }

    resultResponse = runResult?.response
      ?? provider.getLastResponse?.()
      ?? (streamedText ? createAgentResponse({ text: streamedText, thinking: streamedThinking || null }) : null);

    // End any unclosed tool spans
    for (const [, s] of toolSpans) s.end();
    toolSpans.clear();

    if (runResult?.recovered === "prompt_too_long") {
      _log.warn(`Prompt too long for "${sessionKey}", auto-reset and retried`);
      providerSpan?.endWithError("prompt_too_long");
    } else if (runResult?.recovered === "stale_session") {
      _log.warn(`Stale session for "${sessionKey}", auto-reset and retried`);
      providerSpan?.endWithError("stale_session");
    } else {
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

      providerSpan?.end();
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
      } catch (e) {
        _log.warn("insert conversation failed:", e);
      }
    }

    return resultResponse;
  }

  private async _process(msg: IncomingMessage): Promise<AgentResponse> {
    let returnedResponse: AgentResponse | null = null;
    let text = "";
    let thinking = "";
    const stream = this._processStream(msg);
    while (true) {
      const next = await stream.next();
      if (next.done) {
        returnedResponse = next.value ?? null;
        break;
      }
      const event = next.value;
      if (event.sessionUpdate === "agent_message_chunk") {
        for (const block of event.content) {
          if (block.type === "text") text += block.text;
        }
      } else if (event.sessionUpdate === "agent_thought_chunk") {
        for (const block of event.content) {
          if (block.type === "text") thinking += block.text;
        }
      }
    }
    if (returnedResponse) {
      return returnedResponse;
    } else if (text) {
      return createAgentResponse({ text, thinking: thinking || null });
    } else {
      return createAgentResponse({ text: "[Error: no result from provider]" });
    }
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
        sessDb.clearSessionId(sessionKey);
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
          const curProvider = resolveSwitchProviderAlias(switchSessRow?.provider ?? `acp:${this.config.provider.default}`);
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

        const curProviderName = resolveSwitchProviderAlias(sessDb.getSession(sessionKey)?.provider ?? `acp:${this.config.provider.default}`);
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
    remi.authStore = authStore;

    // Plugins (core surface) — auth adapters contributed by in-tree or external
    // (~/.remi/plugins) plugins. ByteDance SSO is an external plugin. Best-effort:
    // a broken plugin must never block the daemon from booting.
    try {
      new PluginRegistry().load(config).dispatchCore({ authStore, config });
    } catch (e) {
      log.warn("Plugin core dispatch failed:", e);
    }

    // 2. Providers — register primary + both ACP agents
    const provider = Remi._buildProvider(config);
    remi.addProvider(provider);

    // Auto-register the other ACP agent so /switch claude ↔ /switch codex works
    const otherType = config.provider.default === "claude" ? "codex" : "claude";
    if (!remi._providers.has(`acp:${otherType}`)) {
      try {
        remi.addProvider(Remi._buildProvider(config, otherType));
      } catch (e) {
        log.warn(`Failed to build acp:${otherType} provider:`, e);
      }
    }


    // 3. Feishu connector
    if (hasFeishuCreds) {
      const feishuConfig = { ...config.feishu };
      // Inject the group-policy lookup so the connector (L1) never imports the
      // remi-product GroupConfigStore (L3) itself.
      const gcStore = new GroupConfigStore();
      const feishu = new FeishuConnector(feishuConfig, {
        getByChatId: (chatId) => gcStore.getByChatId(chatId),
      });
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

      // Bot menu sync (fire-and-forget on startup)
      const menuSyncer = new MenuSyncer({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
        domain: config.feishu.domain,
      });
      menuSyncer.syncAll(config.botMenu, config.feishu.triggerUserIds).catch((err) => {
        log.warn(`Bot menu sync failed: ${err.message}`);
      });
    }

    // 4. ConfigManager — symlinks
    const { configManager } = require("../shared/infra/config-manager");
    remi._configManager = configManager;
    configManager.ensureAllProjects();
    configManager.ensureGlobals();

    // 5. Restart handler
    remi.onRestart((info) => remi._handleRestart(info));

    return remi;
  }

  private static _buildProvider(config: RemiConfig, agentType?: string) {
    const rawType = agentType ?? config.provider.default;
    const type = rawType.startsWith("acp:") ? rawType.slice("acp:".length) : rawType;
    if (type !== "claude" && type !== "codex") {
      throw new Error(`Unknown ACP provider: ${rawType}`);
    }
    const agentCfg = config.provider[type] ?? config.provider.claude;
    return new AcpProvider({
      agentType: type,
      model: agentCfg.model,
      timeout: agentCfg.timeout,
      allowedTools: agentCfg.allowedTools,
      cwd: homedir(),
      executable: agentCfg.executable,
      getMcpServers: () => config.mcp
        .filter((e) => !e.agents || e.agents.includes(type))
        .map((e) => ({ name: e.name, command: e.command, args: e.args, env: e.env })),
    });
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
      if (!existsSync(SESSIONS_FILE)) return;
      const raw = readFileSync(SESSIONS_FILE, "utf-8");
      const data = JSON.parse(raw) as sessDb.LegacySessionData;
      if (!data.entries || !Array.isArray(data.entries) || data.entries.length === 0) return;

      const count = sessDb.migrateFromJson(data);
      log.info(`Migrated ${count} session(s) from sessions.json to DB`);

      // Rename old file as backup (presence of .migrated = migration done)
      const { renameSync } = require("node:fs");
      renameSync(SESSIONS_FILE, SESSIONS_FILE + ".migrated");
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
