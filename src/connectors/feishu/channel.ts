/**
 * FeishuChannel — the single public entry point for the feishu-channel SDK.
 *
 * Bundles transport (WebSocket), event dispatch, streaming card sessions,
 * and ACP adapter routing into a clean API surface.
 */

import type { FeishuChannelConfig, GroupPolicy } from "./config.js";
import { createLogger } from "./logger.js";
import { createFeishuClient } from "./client.js";
import { startWebSocketListener, setGroupPolicy, flushDedupCacheSync, type FeishuWSHandle, type ParsedFeishuMessage } from "./receive.js";
import { sendMarkdownCardFeishu, sendCardFeishu } from "./send.js";
import { FeishuStreamingSession, buildFinalCard, type TokenProvider } from "./streaming.js";
import { handleAgentStream } from "./adapters/stream-handler.js";
import { createAdapter } from "./adapters/index.js";
import type { StreamMeta, StreamHandlerLog } from "@shared/acp-protocol.js";
import type { AgentAdapter } from "@shared/acp-protocol.js";
import type { SessionUpdate } from "@shared/acp-protocol.js";
import { rejectAllPendingActions, rejectPendingActionsForChat } from "./card-actions.js";
import { addReactionFeishu, removeReactionFeishu } from "./reactions.js";

export type { ParsedFeishuMessage } from "./receive.js";
export type { FeishuStreamingSession, TokenProvider } from "./streaming.js";
export type { StreamMeta } from "@shared/acp-protocol.js";

const log = createLogger("feishu-channel");

// ── Event handler types ───────────────────────────────────────

export type Unsubscribe = () => void;

export type MessageHandler = (msg: ParsedFeishuMessage) => Promise<void>;
export type CardActionHandler = (event: { actionId: string; value: unknown; chatId: string }) => Promise<void>;
export type ReactionHandler = (event: { messageId: string; emoji: string; userId: string }) => Promise<void>;

// ── handleStream options ──────────────────────────────────────

export interface HandleStreamOpts {
  /** ACP adapter: pass "claude" | "codex" or a custom AgentAdapter instance. */
  adapter: string | AgentAdapter;
  replyToMessageId?: string;
  sessionId?: string | null;
  displayName?: string | null;
  nameSuffix?: string;
  subtitle?: string | null;
  tokenProvider?: TokenProvider;
  log?: StreamHandlerLog;
}

// ── FeishuChannel ─────────────────────────────────────────────

export class FeishuChannel {
  private readonly _config: FeishuChannelConfig;
  private _wsHandle: FeishuWSHandle | null = null;
  private _messageHandlers: MessageHandler[] = [];
  private _activeSessions = new Map<string, FeishuStreamingSession>();
  private _abortHandler: ((sessionKey: string) => Promise<void>) | null = null;
  private _tokenProvider: TokenProvider | null = null;

  constructor(config: FeishuChannelConfig) {
    this._config = config;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  /** Inject group policy (remi's GroupConfigStore). Must be called before connect(). */
  setGroupPolicy(policy: GroupPolicy): this {
    setGroupPolicy(policy);
    return this;
  }

  /** Inject abort handler (called on /esc to kill the provider process). */
  setAbortHandler(handler: (sessionKey: string) => Promise<void>): this {
    this._abortHandler = handler;
    return this;
  }

  /** Inject token provider for auth-gated card features. */
  setTokenProvider(provider: TokenProvider): this {
    this._tokenProvider = provider;
    return this;
  }

  /** Start WebSocket listener. Returns a promise that never resolves (runs forever). */
  connect(): Promise<void> {
    if (!this._config.appId || !this._config.appSecret) {
      throw new Error("FeishuChannel: appId and appSecret are required");
    }

    this._wsHandle = startWebSocketListener(
      this._config as FeishuChannelConfig & { triggerUserIds?: string[] },
      async (msg) => {
        for (const handler of this._messageHandlers) {
          await handler(msg).catch((err) => log.error(`message handler error: ${String(err)}`));
        }
      },
    );

    return new Promise<void>(() => {
      // Intentionally never resolves — runs until disconnect() is called.
    });
  }

  disconnect(): void {
    if (this._wsHandle) {
      this._wsHandle.stop();
      this._wsHandle = null;
    }
    flushDedupCacheSync();
  }

  // ── Event API ───────────────────────────────────────────────

  /** Register a handler for incoming messages. Returns an unsubscribe function. */
  on(event: "message", handler: MessageHandler): Unsubscribe;
  on(event: string, handler: MessageHandler | ((...args: unknown[]) => Promise<void>)): Unsubscribe {
    if (event === "message") {
      this._messageHandlers.push(handler as MessageHandler);
      return () => {
        const idx = this._messageHandlers.indexOf(handler as MessageHandler);
        if (idx !== -1) this._messageHandlers.splice(idx, 1);
      };
    }
    log.warn(`Unknown event: ${event}`);
    return () => {};
  }

  // ── Send API ────────────────────────────────────────────────

  async sendText(chatId: string, text: string, opts?: { replyToMessageId?: string }): Promise<void> {
    const client = this._makeClient();
    await sendMarkdownCardFeishu(client, chatId, text, opts);
  }

  async sendCard(chatId: string, card: Record<string, unknown>, opts?: { replyToMessageId?: string }): Promise<void> {
    const client = this._makeClient();
    await sendCardFeishu(client, chatId, card, opts);
  }

  // ── Streaming session ───────────────────────────────────────

  /** Create a raw streaming session (lower-level). */
  createStream(opts?: { logFn?: (msg: string) => void }): FeishuStreamingSession {
    const client = this._makeClient();
    const creds = this._creds();
    return new FeishuStreamingSession(client, creds, {
      log: opts?.logFn ?? ((msg) => log.info(msg)),
      tokenProvider: this._tokenProvider ?? undefined,
    });
  }

  /**
   * Consume an ACP stream and render it as a streaming Feishu card.
   * Handles the full lifecycle: card creation → live updates → close.
   */
  async handleStream(
    chatId: string,
    sessionKey: string,
    stream: AsyncIterable<SessionUpdate>,
    meta: StreamMeta,
    opts: HandleStreamOpts,
  ): Promise<void> {
    const slog: StreamHandlerLog = opts.log ?? {
      info: (m) => log.info(m),
      warn: (m) => log.warn(m),
      error: (m) => log.error(m),
      debug: (m) => log.debug(m),
    };

    const acpAdapter: AgentAdapter = typeof opts.adapter === "string"
      ? createAdapter(opts.adapter)
      : opts.adapter;

    const session = this.createStream({ logFn: (m) => slog.info(m) });
    this._activeSessions.set(sessionKey, session);

    try {
      // Start streaming card
      await session.start(chatId, "chat_id", {
        replyToMessageId: opts.replyToMessageId,
        sessionId: opts.sessionId,
        displayName: opts.displayName ?? undefined,
        nameSuffix: opts.nameSuffix,
        subtitle: opts.subtitle,
      });

      // Consume ACP stream
      const result = await handleAgentStream(session, stream, acpAdapter, chatId, slog, meta);

      // Build stats string
      const stats = this._formatStreamStats(result.elapsedSec, result.usageTokens, result.contextWindow, result.toolCount);

      // Close card
      await session.close({
        finalText: result.contentText || undefined,
        thinking: result.thinkingText || null,
        toolEntries: result.toolEntries.length > 0 ? result.toolEntries : undefined,
        toolCount: result.toolCount > 0 ? result.toolCount : undefined,
        stats,
        sessionId: opts.sessionId,
        displayName: opts.displayName,
      });
    } catch (err) {
      slog.error(`handleStream error: ${String(err)}`);
      if (session.isActive()) {
        await session.close({ finalText: `Error: ${String(err)}` }).catch(() => {});
      }
    } finally {
      this._activeSessions.delete(sessionKey);
    }
  }

  /** Abort an active streaming session by sessionKey (called on /esc). */
  async abortSession(sessionKey: string): Promise<void> {
    rejectAllPendingActions("User sent /esc");
    const session = this._activeSessions.get(sessionKey);
    if (session?.isActive()) {
      await session.abort();
      if (this._abortHandler) {
        await this._abortHandler(sessionKey).catch((e) => log.warn(`abort handler failed: ${String(e)}`));
      }
    }
  }

  /** Cancel pending interactions for a chat (when a new message supersedes). */
  cancelPendingInteractions(chatId: string): number {
    return rejectPendingActionsForChat(chatId, "New message received, cancelling pending interaction");
  }

  /** Add a reaction (e.g. typing indicator). */
  async addReaction(messageId: string, emoji: string): Promise<string | undefined> {
    try {
      const client = this._makeClient();
      const result = await addReactionFeishu(client, messageId, emoji as any);
      return result.reactionId;
    } catch {
      return undefined;
    }
  }

  /** Remove a reaction. */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      const client = this._makeClient();
      await removeReactionFeishu(client, messageId, reactionId);
    } catch {
      // Non-critical
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private _makeClient() {
    return createFeishuClient(this._creds());
  }

  private _creds() {
    return {
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain,
    };
  }

  private _formatStreamStats(elapsedSec: number, usedTokens: number, contextWindow: number | null, toolCount: number): string | null {
    const parts: string[] = [];
    if (elapsedSec > 0) parts.push(`${elapsedSec.toFixed(1)}s`);
    if (usedTokens > 0) {
      const fmtN = (n: number) => n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n}`;
      parts.push(contextWindow ? `${fmtN(usedTokens)}/${fmtN(contextWindow)}` : fmtN(usedTokens));
    }
    if (toolCount > 0) parts.push(`${toolCount} tools`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
}

// ── Factory ───────────────────────────────────────────────────

export function createLarkChannel(config: FeishuChannelConfig): FeishuChannel {
  return new FeishuChannel(config);
}
