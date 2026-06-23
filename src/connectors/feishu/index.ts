/**
 * FeishuConnector — thin adapter that bridges @remi/feishu-channel to the Remi Connector interface.
 */

import type { FeishuConfig } from "../../config.js";
import { GroupConfigStore } from "../../group/store.js";
import type { AgentResponse, ProviderEvent } from "../../providers/base.js";
import type { Connector, MessageHandler, StreamingHandler, IncomingMessage } from "../base.js";
import type { MediaAttachment } from "@remi/acp-provider";
import { createLogger } from "../../logger.js";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

import {
  createLarkChannel,
  buildFinalCard,
  sendMarkdownCardFeishu,
  sendCardFeishu,
  type FeishuChannel,
  type ParsedFeishuMessage,
  type TokenProvider,
  type StreamMeta,
} from "@remi/feishu-channel";
import { createFeishuClient } from "@remi/feishu-channel";
import { createAdapter } from "@remi/feishu-channel";

const log = createLogger("feishu");

export { approvePlanOption, rejectPermissionOption, isPlanApproval } from "@remi/feishu-channel";

// ── Plan reading helper ───────────────────────────────────────

function readLatestPlanContent(cwd?: string): string | null {
  const plansDir = join(cwd || homedir(), ".claude", "plans");
  try {
    const files = readdirSync(plansDir)
      .filter((f) => f.endsWith(".md") && !f.includes("-agent-"))
      .map((f) => { const full = join(plansDir, f); return { path: full, mtime: statSync(full).mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    return readFileSync(files[0].path, "utf-8");
  } catch {
    return null;
  }
}

// ── FeishuConnector ───────────────────────────────────────────

export class FeishuConnector implements Connector {
  readonly name = "feishu";
  private _config: FeishuConfig & { domain?: string; connectionMode?: string };
  private _channel: FeishuChannel;
  private _handler: MessageHandler | null = null;
  private _streamHandler: StreamingHandler | null = null;

  constructor(config: FeishuConfig & { domain?: string; connectionMode?: string }) {
    this._config = config;
    this._channel = createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain as any,
      connectionMode: config.connectionMode as any,
    });

    // Inject group policy
    const gcStore = new GroupConfigStore();
    this._channel.setGroupPolicy({
      getByChatId: (chatId) => gcStore.getByChatId(chatId),
    });
  }

  setAbortHandler(handler: (sessionKey: string) => Promise<void>): void {
    this._channel.setAbortHandler(handler);
  }

  setTokenProvider(provider: TokenProvider): void {
    this._channel.setTokenProvider(provider);
  }

  async start(handler: MessageHandler, streamHandler?: StreamingHandler): Promise<void> {
    if (!this._config.appId || !this._config.appSecret) {
      throw new Error("Feishu connector: appId and appSecret are required");
    }
    this._handler = handler;
    this._streamHandler = streamHandler ?? null;
    log.info("starting connector...");

    this._channel.on("message", async (msg) => {
      await this._handleFeishuMessage(msg);
    });

    return this._channel.connect();
  }

  async stop(): Promise<void> {
    this._channel.disconnect();
    this._handler = null;
    this._streamHandler = null;
    log.info("connector stopped");
  }

  async reply(chatId: string, response: AgentResponse): Promise<void> {
    const client = createFeishuClient({
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain,
    });
    const text = response.text;
    const stats = this._formatStats(response);
    if (response.thinking || stats) {
      const card = buildFinalCard({ text, thinking: response.thinking, stats });
      await sendCardFeishu(client, chatId, card);
    } else {
      await sendMarkdownCardFeishu(client, chatId, text);
    }
  }

  async streamToThread(incoming: IncomingMessage, chatId: string, threadId: string): Promise<void> {
    const sessionKey = `${chatId}:thread:${threadId}`;
    await this._handleStreaming(incoming, chatId, sessionKey, threadId);
  }

  // ── Internal ──────────────────────────────────────────────

  private async _handleFeishuMessage(msg: ParsedFeishuMessage): Promise<void> {
    if (!this._handler) return;

    // /esc: abort active session
    if (/^\/esc$/i.test(msg.rawContent.trim())) {
      const sessionKey = this._resolveSessionKey(msg);
      await this._channel.abortSession(sessionKey);
      return;
    }

    const _log = log.child({ traceId: msg.messageId });

    // Build IncomingMessage
    const media: MediaAttachment[] = msg.media.map((m) => ({
      buffer: m.buffer,
      contentType: m.contentType ?? "application/octet-stream",
      fileName: m.fileName,
      mediaType: this._inferMediaType(m.placeholder),
    }));

    let text = msg.text;
    for (const m of media) {
      if (m.mediaType === "image") {
        const feishuMedia = msg.media.find((fm) => fm.buffer === m.buffer);
        const imageKey = feishuMedia?.imageKey;
        if (imageKey) text += `\n{"image_key":"${imageKey}","message_id":"${msg.messageId}"}`;
      } else if (m.mediaType !== "sticker") {
        const dir = join(tmpdir(), "remi-media", msg.chatId.slice(0, 16));
        mkdirSync(dir, { recursive: true });
        const name = m.fileName ?? `${Date.now()}.bin`;
        const filePath = join(dir, name);
        writeFileSync(filePath, m.buffer);
        text = text.replace(m.mediaType === "file" ? "<media:document>" : `<media:${m.mediaType}>`, `[文件已保存: ${filePath}]`);
      }
    }

    const incoming: IncomingMessage = {
      text,
      chatId: msg.chatId,
      sender: msg.senderName ?? msg.senderOpenId,
      connectorName: this.name,
      media: media.length > 0 ? media : undefined,
      metadata: {
        messageId: msg.messageId,
        chatType: msg.chatType,
        senderOpenId: msg.senderOpenId,
        mentionedBot: msg.mentionedBot,
        monitored: msg.monitored,
        mediaCount: msg.media.length,
        quotedContent: msg.quotedContent,
        rootId: msg.rootId,
        rawContent: msg.rawContent,
      },
    };

    _log.info(`received message from ${msg.senderName ?? msg.senderOpenId}: ${text.slice(0, 80)}`);

    // Typing indicator
    let thinkingReactionId: string | undefined;
    try {
      thinkingReactionId = await this._channel.addReaction(msg.messageId, "THINKING");
    } catch { /* non-critical */ }

    try {
      // Cancel pending interactions if a new message arrives for the same session
      const sessionKey = this._resolveSessionKey(msg);
      const cancelled = this._channel.cancelPendingInteractions(msg.chatId);
      if (cancelled > 0) _log.info(`Cancelled ${cancelled} pending action(s) for session "${sessionKey}"`);

      const { GroupConfigStore } = await import("../../group/store.js");
      const gcStore = new GroupConfigStore();
      const groupConfig = gcStore.getByChatId(msg.chatId);
      const replyInThread = msg.chatType === "p2p" ? false : (groupConfig ? groupConfig.replyMode === "thread" : true);
      const replyToId = replyInThread ? msg.messageId : undefined;

      if (this._streamHandler) {
        await this._handleStreaming(incoming, msg.chatId, sessionKey, replyToId, _log);
      } else {
        const response = await this._handler!(incoming);
        await this._sendStaticReply(msg.chatId, response, replyToId);
      }
    } catch (err) {
      _log.error(`failed to process message: ${String(err)}`);
      try {
        await this._channel.sendText(msg.chatId, `**Error:** ${String(err)}`);
      } catch { /* give up */ }
    } finally {
      if (thinkingReactionId) {
        await this._channel.removeReaction(msg.messageId, thinkingReactionId);
      }
    }
  }

  private async _handleStreaming(
    incoming: IncomingMessage,
    chatId: string,
    sessionKey: string,
    replyToMessageId?: string,
    _log?: ReturnType<typeof log.child>,
  ): Promise<void> {
    const slog = _log ?? log;
    const agentType = (incoming.metadata?.agentType as string | null) ?? "claude";

    await this._streamHandler!(incoming, async (stream, meta) => {
      const acpAdapter = (() => {
        try { return createAdapter(meta.agentType ?? agentType); }
        catch { return createAdapter("claude"); }
      })();

      // Determine subtitle
      const agentLabel = meta.agentType === "codex" ? "Codex" : "Claude";
      const modeLabel = meta.mode && meta.mode !== "auto"
        ? ` ${meta.mode === "bypassPermissions" ? "Bypass" : meta.mode.charAt(0).toUpperCase() + meta.mode.slice(1)}`
        : "";
      const subtitle = `${agentLabel}${modeLabel}`;

      await this._channel.handleStream(chatId, sessionKey, stream as AsyncIterable<import("@remi/feishu-channel").SessionUpdate>, meta as StreamMeta, {
        adapter: acpAdapter,
        replyToMessageId,
        sessionId: meta.sessionId,
        displayName: meta.displayName ?? undefined,
        subtitle,
        log: {
          info: (m) => slog.info(m),
          warn: (m) => slog.warn(m),
          error: (m) => slog.error(m),
          debug: (m) => slog.debug(m),
        },
      });
    });
  }

  private async _sendStaticReply(chatId: string, response: AgentResponse, replyToMessageId?: string): Promise<void> {
    const client = createFeishuClient({
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain,
    });
    const text = response.text;
    const stats = this._formatStats(response);
    if (response.thinking || stats) {
      const card = buildFinalCard({ text, thinking: response.thinking, stats });
      await sendCardFeishu(client, chatId, card, { replyToMessageId });
    } else {
      await sendMarkdownCardFeishu(client, chatId, text, { replyToMessageId });
    }
  }

  private _resolveSessionKey(msg: ParsedFeishuMessage): string {
    if (msg.rootId) return `${msg.chatId}:thread:${msg.rootId}`;
    if (msg.chatType === "group") return `${msg.chatId}:thread:${msg.messageId}`;
    return msg.chatId;
  }

  private _inferMediaType(placeholder: string): MediaAttachment["mediaType"] {
    if (placeholder.includes("image")) return "image";
    if (placeholder.includes("audio")) return "audio";
    if (placeholder.includes("video")) return "video";
    if (placeholder.includes("sticker")) return "sticker";
    return "file";
  }

  private _formatStats(response: AgentResponse): string | null {
    const parts: string[] = [];
    if (response.durationMs != null) parts.push(`${(response.durationMs / 1000).toFixed(1)}s`);
    if (response.inputTokens != null || response.outputTokens != null) {
      const inTok = response.inputTokens ?? 0;
      const outTok = response.outputTokens ?? 0;
      const fmtN = (n: number) => n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n}`;
      if (outTok > 0) parts.push(`${inTok}→${outTok}`);
      else if (inTok > 0) {
        parts.push(response.contextWindow ? `${fmtN(inTok)}/${fmtN(response.contextWindow)}` : fmtN(inTok));
      }
    }
    if (response.toolCalls?.length) parts.push(`${response.toolCalls.length} tools`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
}
