/**
 * FeishuConnector — implements Remi Connector interface for Feishu/Lark.
 *
 * Message flow:
 *   Feishu WebSocket → parse + dedup + resolve → IncomingMessage → handler()
 *   AgentResponse → streaming card (if streaming) or markdown card → Feishu
 */

import type { FeishuConfig } from "../../config.js";
import type { AgentResponse } from "../../providers/base.js";
import type { Connector, MessageHandler, IncomingMessage } from "../base.js";
import { createFeishuClient } from "./client.js";
import { sendMarkdownCardFeishu } from "./send.js";
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

  constructor(config: FeishuConfig & { domain?: string; connectionMode?: string }) {
    this._config = config;
  }

  async start(handler: MessageHandler): Promise<void> {
    if (!this._config.appId || !this._config.appSecret) {
      throw new Error("Feishu connector: appId and appSecret are required");
    }

    this._handler = handler;
    console.log("feishu: starting connector...");

    this._wsHandle = startWebSocketListener(this._config, async (msg: ParsedFeishuMessage) => {
      await this._handleFeishuMessage(msg);
    });

    // Keep alive — WebSocket listener runs in background
    // The promise resolves when the connector is stopped, but the WS client
    // keeps running via the event loop. We return a never-resolving promise
    // that gets cancelled on stop().
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
    console.log("feishu: connector stopped");
  }

  async reply(chatId: string, response: AgentResponse): Promise<void> {
    const client = createFeishuClient({
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain,
    });

    // Use streaming card for longer responses, plain card for short ones
    const text = response.text;
    if (text.length > 500) {
      await this._sendStreamingReply(chatId, text);
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

      const response = await this._handler(incoming);

      // Remove typing indicator
      if (thinkingReactionId) {
        try {
          const { removeReactionFeishu } = await import("./reactions.js");
          await removeReactionFeishu(client, msg.messageId, thinkingReactionId);
        } catch {
          // Non-critical
        }
      }

      // Send reply (threaded under original message)
      await this._sendReply(msg.chatId, response, msg.messageId);
    } catch (err) {
      console.error(`feishu: failed to process message ${msg.messageId}: ${String(err)}`);
      // Try to send an error reply
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

  private async _sendReply(chatId: string, response: AgentResponse, replyToMessageId?: string): Promise<void> {
    const client = createFeishuClient({
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain,
    });

    const text = response.text;

    // For longer responses, use streaming card for better UX
    if (text.length > 500) {
      await this._sendStreamingReply(chatId, text, replyToMessageId);
    } else {
      await sendMarkdownCardFeishu(client, chatId, text, { replyToMessageId });
    }
  }

  private async _sendStreamingReply(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const creds = {
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain,
    };
    const client = createFeishuClient(creds);
    const session = new FeishuStreamingSession(client, creds);

    try {
      await session.start(chatId, "chat_id", { replyToMessageId });

      // Simulate streaming by sending the text in chunks
      const chunkSize = 100;
      for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.slice(0, i + chunkSize);
        await session.update(chunk);
        // Small delay between updates for the typewriter effect
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      await session.close(text);
    } catch (err) {
      // Fallback to regular card if streaming fails
      console.warn(`feishu: streaming failed, falling back to card: ${String(err)}`);
      await sendMarkdownCardFeishu(client, chatId, text, { replyToMessageId });
    }
  }
}
