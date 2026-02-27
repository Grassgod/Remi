/**
 * FeishuConnector — implements Remi Connector interface for Feishu/Lark.
 *
 * Message flow:
 *   Feishu WebSocket → parse + dedup + resolve → IncomingMessage → streamHandler()
 *   StreamEvent deltas → streaming card (thinking + content in real-time) → close with stats
 */

import type { FeishuConfig } from "../../config.js";
import type { AgentResponse } from "../../providers/base.js";
import type { Connector, MessageHandler, StreamingHandler, IncomingMessage } from "../base.js";
import { createFeishuClient } from "./client.js";
import { sendMarkdownCardFeishu, sendCardFeishu, buildRichCard } from "./send.js";
import { FeishuStreamingSession } from "./streaming.js";
import {
  startWebSocketListener,
  type FeishuWSHandle,
  type ParsedFeishuMessage,
} from "./receive.js";

export class FeishuConnector implements Connector {
  readonly name = "feishu";
  private _config: FeishuConfig & { domain?: string; connectionMode?: string };
  private _wsHandle: FeishuWSHandle | null = null;
  private _handler: MessageHandler | null = null;
  private _streamHandler: StreamingHandler | null = null;

  constructor(config: FeishuConfig & { domain?: string; connectionMode?: string }) {
    this._config = config;
  }

  async start(handler: MessageHandler, streamHandler?: StreamingHandler): Promise<void> {
    if (!this._config.appId || !this._config.appSecret) {
      throw new Error("Feishu connector: appId and appSecret are required");
    }

    this._handler = handler;
    this._streamHandler = streamHandler ?? null;
    console.log("feishu: starting connector...");

    this._wsHandle = startWebSocketListener(this._config, async (msg: ParsedFeishuMessage) => {
      await this._handleFeishuMessage(msg);
    });

    // Keep alive — WebSocket listener runs in background
    return new Promise<void>(() => {
      // Intentionally never resolves — connector runs until stop() is called
    });
  }

  async stop(): Promise<void> {
    if (this._wsHandle) {
      this._wsHandle.stop();
      this._wsHandle = null;
    }
    this._handler = null;
    this._streamHandler = null;
    console.log("feishu: connector stopped");
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
      const card = buildRichCard({ text, thinking: response.thinking, stats });
      await sendCardFeishu(client, chatId, card);
    } else {
      await sendMarkdownCardFeishu(client, chatId, text);
    }
  }

  // ── Internal ───────────────────────────────────────────────

  private async _handleFeishuMessage(msg: ParsedFeishuMessage): Promise<void> {
    if (!this._handler) return;

    const incoming: IncomingMessage = {
      text: msg.text,
      chatId: msg.chatId,
      sender: msg.senderName ?? msg.senderOpenId,
      connectorName: this.name,
      metadata: {
        messageId: msg.messageId,
        chatType: msg.chatType,
        senderOpenId: msg.senderOpenId,
        mentionedBot: msg.mentionedBot,
        mediaCount: msg.media.length,
        quotedContent: msg.quotedContent,
        rootId: msg.rootId,
      },
    };

    console.log(`feishu: received message ${msg.messageId} from ${msg.senderName ?? msg.senderOpenId}: ${msg.text.slice(0, 80)}`);

    try {
      // Add typing indicator (thinking emoji)
      const client = createFeishuClient({
        appId: this._config.appId,
        appSecret: this._config.appSecret,
        domain: this._config.domain,
      });
      let thinkingReactionId: string | undefined;
      try {
        const { addReactionFeishu } = await import("./reactions.js");
        const result = await addReactionFeishu(client, msg.messageId, "THINKING");
        thinkingReactionId = result.reactionId;
      } catch {
        // Non-critical: skip typing indicator if it fails
      }

      // Use real streaming if streamHandler is available
      if (this._streamHandler) {
        await this._handleStreaming(incoming, msg.chatId, msg.messageId);
      } else {
        // Fallback: blocking handler → static card
        const response = await this._handler(incoming);
        await this._sendStaticReply(msg.chatId, response, msg.messageId);
      }

      // Remove typing indicator
      if (thinkingReactionId) {
        try {
          const { removeReactionFeishu } = await import("./reactions.js");
          await removeReactionFeishu(client, msg.messageId, thinkingReactionId);
        } catch {
          // Non-critical
        }
      }
    } catch (err) {
      console.error(`feishu: failed to process message ${msg.messageId}: ${String(err)}`);
      try {
        const client = createFeishuClient({
          appId: this._config.appId,
          appSecret: this._config.appSecret,
          domain: this._config.domain,
        });
        await sendMarkdownCardFeishu(client, msg.chatId, `**Error:** ${String(err)}`);
      } catch {
        // Give up
      }
    }
  }

  /**
   * Real streaming: start card immediately, pipe deltas as they arrive.
   * Falls back to static card if streaming card creation fails.
   */
  private async _handleStreaming(
    incoming: IncomingMessage,
    chatId: string,
    replyToMessageId: string,
  ): Promise<void> {
    const creds = {
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain,
    };
    const client = createFeishuClient(creds);
    const session = new FeishuStreamingSession(client, creds);

    // Try to start the streaming card — fall back to blocking handler if it fails
    try {
      await session.start(chatId, "chat_id", { replyToMessageId });
    } catch (err) {
      console.warn(`feishu: streaming card creation failed, falling back to static reply: ${String(err)}`);
      if (this._handler) {
        const response = await this._handler(incoming);
        await this._sendStaticReply(chatId, response, replyToMessageId);
      }
      return;
    }

    let thinkingText = "";
    let contentText = "";
    let finalResponse: AgentResponse | null = null;
    let toolCount = 0;

    try {
      for await (const event of this._streamHandler!(incoming)) {
        console.log(`[feishu] received event: ${event.kind}`);
        switch (event.kind) {
          case "thinking_delta":
            thinkingText += event.text;
            await session.updateThinking(thinkingText);
            break;
          case "content_delta":
            contentText += event.text;
            await session.update(contentText);
            break;
          case "tool_use":
            toolCount++;
            thinkingText += `\n🔧 **${event.name}** ${formatToolInput(event.input)}\n`;
            await session.updateThinking(thinkingText);
            break;
          case "result":
            finalResponse = event.response;
            break;
        }
      }

      // Close streaming card with final content + stats
      const stats = finalResponse ? this._formatStats(finalResponse) : null;
      await session.close({
        finalText: finalResponse?.text ?? contentText,
        thinking: finalResponse?.thinking ?? (thinkingText || null),
        stats,
      });
    } catch (err) {
      console.error(`feishu: streaming error: ${String(err)}`);
      // Always close the streaming card to prevent it from being stuck
      if (session.isActive()) {
        await session.close({
          finalText: contentText || `Error: ${String(err)}`,
        }).catch(() => {});
      }
    }
  }

  /**
   * Static reply — for non-streaming path or short responses.
   */
  private async _sendStaticReply(chatId: string, response: AgentResponse, replyToMessageId?: string): Promise<void> {
    const client = createFeishuClient({
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain,
    });

    const text = response.text;
    const stats = this._formatStats(response);
    if (response.thinking || stats) {
      const card = buildRichCard({ text, thinking: response.thinking, stats });
      await sendCardFeishu(client, chatId, card, { replyToMessageId });
    } else {
      await sendMarkdownCardFeishu(client, chatId, text, { replyToMessageId });
    }
  }

  private _formatStats(response: AgentResponse): string | null {
    const parts: string[] = [];

    if (response.durationMs != null) {
      parts.push(`⏱ ${(response.durationMs / 1000).toFixed(1)}s`);
    }
    if (response.inputTokens != null || response.outputTokens != null) {
      const inTok = response.inputTokens ?? "?";
      const outTok = response.outputTokens ?? "?";
      parts.push(`📥 ${inTok} → 📤 ${outTok} tokens`);
    }
    if (response.toolCalls && response.toolCalls.length > 0) {
      parts.push(`🔧 ${response.toolCalls.length} tools`);
    }
    if (response.costUsd != null) {
      parts.push(`💰 $${response.costUsd.toFixed(4)}`);
    }

    return parts.length > 0 ? parts.join(" | ") : null;
  }
}

// ── Helpers ──────────────────────────────────────────────────

/** Format the first meaningful tool input parameter for display. */
function formatToolInput(input?: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return "";
  const key = Object.keys(input)[0];
  const val = String(input[key]);
  const truncated = val.length > 60 ? val.slice(0, 57) + "..." : val;
  return `\`${key}="${truncated}"\``;
}
