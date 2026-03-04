/**
 * FeishuConnector — implements Remi Connector interface for Feishu/Lark.
 *
 * Message flow:
 *   Feishu WebSocket → parse + dedup + resolve → IncomingMessage → streamHandler()
 *   StreamEvent deltas → streaming card (thinking + content in real-time) → close with stats
 */

import type { BotProfile, FeishuConfig } from "../../config.js";
import type { AgentResponse } from "../../providers/base.js";
import type { Connector, MessageHandler, StreamingHandler, IncomingMessage } from "../base.js";
import type { MediaAttachment } from "../../providers/claude-cli/protocol.js";
import { createLogger } from "../../logger.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const log = createLogger("feishu");
import { createFeishuClient } from "./client.js";
import { sendMarkdownCardFeishu, sendCardFeishu, buildRichCard } from "./send.js";
import { FeishuStreamingSession, type TokenProvider } from "./streaming.js";
import {
  type ToolEntry,
  formatToolEntryMarkdown,
  replaceLastPending,
} from "./tool-formatters.js";
import {
  startWebSocketListener,
  flushDedupCacheSync,
  type FeishuWSHandle,
  type ParsedFeishuMessage,
} from "./receive.js";

// ── Plan task tracking for status bar ──────────────────────

interface PlanTask {
  id: string;
  subject: string;
  status: string;
}

interface ActiveAgent {
  toolUseId: string;
  description: string;
  startTime: number;
}

/** Tool names that manage plan/task state. */
const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList"]);

/** Render the full plan task list as status bar markdown. */
function renderPlanStatus(tasks: PlanTask[]): string {
  if (tasks.length === 0) return "";
  const completed = tasks.filter((t) => t.status === "completed").length;
  const lines = [`📋 **Plan** (${completed}/${tasks.length})`];
  for (const t of tasks) {
    const icon =
      t.status === "completed" ? "✅"
      : t.status === "in_progress" ? "⏳"
      : "◻";
    lines.push(`${icon} ${t.subject}`);
  }
  return lines.join("\n");
}

/** Render combined plan + active agents status for the status bar. */
function renderCombinedStatus(planTasks: PlanTask[], activeAgents: ActiveAgent[]): string {
  const parts: string[] = [];

  if (planTasks.length > 0) {
    parts.push(renderPlanStatus(planTasks));
  }

  if (activeAgents.length > 0) {
    const agentLines = [`🤖 **Agents** (${activeAgents.length} active)`];
    for (const a of activeAgents) {
      const elapsed = ((Date.now() - a.startTime) / 1000).toFixed(0);
      agentLines.push(`⏳ ${a.description} (${elapsed}s)`);
    }
    parts.push(agentLines.join("\n"));
  }

  return parts.join("\n\n");
}

/** Generate a human-readable status line from a tool call for the status bar. */
function formatToolStatus(name: string, input?: Record<string, unknown>): string {
  const str = (v: unknown) => (v == null ? "" : String(v));
  const trunc = (s: string, max: number) => s.length <= max ? s : s.slice(0, max - 3) + "...";

  switch (name) {
    case "Read":
      return `📖 Reading ${trunc(str(input?.file_path), 60)}...`;
    case "Bash":
      return `⚙️ Running: ${trunc(str(input?.command), 60)}...`;
    case "Grep":
      return `🔍 Searching: ${trunc(str(input?.pattern), 60)}...`;
    case "Edit":
    case "Write":
      return `✏️ Editing ${trunc(str(input?.file_path), 60)}...`;
    case "Glob":
      return `📂 Finding: ${trunc(str(input?.pattern), 60)}...`;
    case "WebFetch":
      return `🌐 Fetching: ${trunc(str(input?.url), 60)}...`;
    case "WebSearch":
      return `🌐 Searching: ${trunc(str(input?.query), 60)}...`;
    case "Agent":
      return `🤖 Agent: ${trunc(str(input?.description ?? input?.prompt), 60)}...`;
    default:
      return `🔧 Tool: ${name}...`;
  }
}

export class FeishuConnector implements Connector {
  readonly name = "feishu";
  private _config: FeishuConfig & { domain?: string; connectionMode?: string };
  private _bots: BotProfile[] = [];
  private _wsHandle: FeishuWSHandle | null = null;
  private _handler: MessageHandler | null = null;
  private _streamHandler: StreamingHandler | null = null;
  private _tokenProvider: TokenProvider | null = null;

  constructor(config: FeishuConfig & { domain?: string; connectionMode?: string }) {
    this._config = config;
  }

  /** Set bot profiles for per-group reply mode configuration. */
  setBotProfiles(bots: BotProfile[]): void {
    this._bots = bots;
  }

  /** Find matching bot profile for a chat ID. */
  private _findBotProfile(chatId: string): BotProfile | null {
    return this._bots.find((b) => b.groups.includes(chatId)) ?? null;
  }

  /** Set the token provider (from 1Passport AuthStore). */
  setTokenProvider(provider: TokenProvider): void {
    this._tokenProvider = provider;
  }

  async start(handler: MessageHandler, streamHandler?: StreamingHandler): Promise<void> {
    if (!this._config.appId || !this._config.appSecret) {
      throw new Error("Feishu connector: appId and appSecret are required");
    }

    this._handler = handler;
    this._streamHandler = streamHandler ?? null;
    log.info("starting connector...");

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
    // Flush dedup cache synchronously so the new process (after restart)
    // won't re-process messages that were already handled before exit.
    flushDedupCacheSync();
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
      const card = buildRichCard({ text, thinking: response.thinking, stats });
      await sendCardFeishu(client, chatId, card);
    } else {
      await sendMarkdownCardFeishu(client, chatId, text);
    }
  }

  // ── Internal ───────────────────────────────────────────────

  private async _handleFeishuMessage(msg: ParsedFeishuMessage): Promise<void> {
    if (!this._handler) return;

    // Convert Feishu media to protocol MediaAttachment
    const media: MediaAttachment[] = msg.media.map((m) => ({
      buffer: m.buffer,
      contentType: m.contentType ?? "application/octet-stream",
      fileName: m.fileName,
      mediaType: this._inferMediaType(m.placeholder),
    }));

    // Save non-image files to temp directory so Claude can read them
    let text = msg.text;
    for (const m of media) {
      if (m.mediaType !== "image" && m.mediaType !== "sticker") {
        const dir = join(tmpdir(), "remi-media", msg.chatId.slice(0, 16));
        mkdirSync(dir, { recursive: true });
        const name = m.fileName ?? `${Date.now()}.bin`;
        const filePath = join(dir, name);
        writeFileSync(filePath, m.buffer);
        // Replace placeholder with actual file path hint
        text = text.replace(
          m.mediaType === "file" ? "<media:document>" : `<media:${m.mediaType}>`,
          `[文件已保存: ${filePath}]`,
        );
        log.info(`saved ${m.mediaType} to ${filePath} (${m.buffer.length} bytes)`);
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
      },
    };

    log.info(`received message ${msg.messageId} from ${msg.senderName ?? msg.senderOpenId}: ${text.slice(0, 80)}${media.length > 0 ? ` [+${media.length} media]` : ""}`);

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

      // Determine reply mode from bot profile
      const botProfile = this._findBotProfile(msg.chatId);
      const replyInThread = botProfile ? botProfile.replyMode === "thread" : true;
      const replyToId = replyInThread ? msg.messageId : undefined;

      // Use real streaming if streamHandler is available
      if (this._streamHandler) {
        await this._handleStreaming(incoming, msg.chatId, replyToId);
      } else {
        // Fallback: blocking handler → static card
        const response = await this._handler(incoming);
        await this._sendStaticReply(msg.chatId, response, replyToId);
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
      log.error(`failed to process message ${msg.messageId}: ${String(err)}`);
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
    replyToMessageId?: string,
  ): Promise<void> {
    const creds = {
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain,
    };
    const client = createFeishuClient(creds);
    const session = new FeishuStreamingSession(client, creds, {
      tokenProvider: this._tokenProvider ?? undefined,
    });

    // Try to start the streaming card — fall back to blocking handler if it fails
    try {
      await session.start(chatId, "chat_id", { replyToMessageId });
    } catch (err) {
      log.warn(`streaming card creation failed, falling back to static reply: ${String(err)}`);
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

    // Collect tool entries for final card nested collapsible panels
    const toolEntries: ToolEntry[] = [];
    let currentThinkingSegment = "";

    // Plan task tracking for status bar
    const planTasks: PlanTask[] = [];
    // Active sub-agent tracking
    const activeAgents: ActiveAgent[] = [];

    // Use callback pattern: the lane lock in core.ts covers this entire consumer,
    // so card close + @mention complete before the next message starts processing.
    await this._streamHandler!(incoming, async (stream) => {
      try {
        for await (const event of stream) {
          // If safety timeout fired, stop consuming events
          if (session.abortSignal.aborted) {
            log.warn("Safety timeout aborted stream consumption");
            break;
          }
          log.debug(`received event: ${event.kind}`);
          switch (event.kind) {
            case "thinking_delta":
              thinkingText += event.text;
              currentThinkingSegment += event.text;
              if (planTasks.length === 0 && activeAgents.length === 0) {
                await session.updateStatus("🤔 Thinking...");
              }
              await session.updateThinking(thinkingText);
              break;
            case "content_delta":
              contentText += event.text;
              if (planTasks.length === 0 && activeAgents.length === 0) {
                await session.updateStatus("✍️ Writing...");
              }
              await session.update(contentText);
              break;
            case "tool_use": {
              toolCount++;

              // Plan task tracking
              if (event.name === "TodoWrite" && event.input?.todos) {
                const todos = event.input.todos as Array<Record<string, unknown>>;
                planTasks.length = 0;
                for (const t of todos) {
                  planTasks.push({
                    id: String(t.id ?? planTasks.length),
                    subject: String(t.content ?? t.subject ?? ""),
                    status: String(t.status ?? "pending"),
                  });
                }
                await session.updateStatus(renderPlanStatus(planTasks));
              } else if (event.name === "TaskCreate" && event.input) {
                planTasks.push({
                  id: `_pending_${event.toolUseId}`,
                  subject: String(event.input.subject ?? ""),
                  status: "pending",
                });
                await session.updateStatus(renderPlanStatus(planTasks));
              } else if (event.name === "TaskUpdate" && event.input) {
                const task = planTasks.find((t) => t.id === String(event.input!.taskId));
                if (task) {
                  if (event.input.status === "deleted") {
                    const idx = planTasks.indexOf(task);
                    if (idx !== -1) planTasks.splice(idx, 1);
                  } else {
                    if (event.input.status) task.status = String(event.input.status);
                    if (event.input.subject) task.subject = String(event.input.subject);
                  }
                  await session.updateStatus(renderPlanStatus(planTasks));
                }
              } else if (event.name === "Agent") {
                activeAgents.push({
                  toolUseId: event.toolUseId,
                  description: String(event.input?.description ?? event.input?.prompt ?? "").slice(0, 60),
                  startTime: Date.now(),
                });
                await session.updateStatus(renderCombinedStatus(planTasks, activeAgents));
              } else if (!PLAN_TOOLS.has(event.name)) {
                // Non-plan/non-agent tool: only update status bar if no plan or agents active
                if (planTasks.length === 0 && activeAgents.length === 0) {
                  await session.updateStatus(formatToolStatus(event.name, event.input));
                }
              }

              // Record entry for final card rebuild
              toolEntries.push({
                name: event.name,
                input: event.input,
                status: "pending",
                thinkingBefore: currentThinkingSegment,
              });
              currentThinkingSegment = "";
              // Streaming: append rich tool entry to thinking
              thinkingText += formatToolEntryMarkdown(
                event.name, event.input, undefined, undefined, "pending",
              );
              await session.updateThinking(thinkingText);
              break;
            }
            case "tool_result": {
              // Fix TaskCreate temp IDs with real IDs from result
              if (event.name === "TaskCreate" && event.resultPreview) {
                const match = event.resultPreview.match(/Task #(\S+)/);
                if (match) {
                  const task = planTasks.find((t) => t.id === `_pending_${event.toolUseId}`);
                  if (task) task.id = match[1];
                }
              }
              // Remove completed agent
              if (event.name === "Agent") {
                const idx = activeAgents.findIndex((a) => a.toolUseId === event.toolUseId);
                if (idx !== -1) activeAgents.splice(idx, 1);
              }
              // Update status bar
              const combined = renderCombinedStatus(planTasks, activeAgents);
              await session.updateStatus(combined || "🤔 Thinking...");
              // Update the matching pending entry
              const entry = toolEntries.findLast((e) => e.status === "pending");
              if (entry) {
                entry.status = "done";
                entry.durationMs = event.durationMs;
                entry.resultPreview = event.resultPreview;
              }
              // Replace ⏳ with ✅ + result preview in thinking text
              thinkingText = replaceLastPending(
                thinkingText, event.name, event.resultPreview, event.durationMs,
              );
              await session.updateThinking(thinkingText);
              break;
            }
            case "rate_limit":
              await session.updateStatus(`⚠️ Rate limited, retrying in ${((event.retryAfterMs) / 1000).toFixed(0)}s...`);
              thinkingText += `\n⚠️ **Rate limited** — retrying in ${((event.retryAfterMs) / 1000).toFixed(0)}s...\n`;
              await session.updateThinking(thinkingText);
              break;
            case "error":
              contentText += `\n\n**Error:** ${event.error}\n`;
              await session.update(contentText);
              break;
            case "result":
              finalResponse = event.response;
              break;
          }
        }

        // Close streaming card with final content + stats + tool entries
        // @mention is embedded in the final card for group chats (single message)
        const stats = finalResponse ? this._formatStats(finalResponse) : null;
        const mentionOpenId = incoming.metadata?.chatType === "group"
          ? (incoming.metadata?.senderOpenId as string | undefined)
          : undefined;
        await session.close({
          finalText: finalResponse?.text ?? contentText,
          thinking: thinkingText || finalResponse?.thinking || null,
          toolEntries: toolEntries.length > 0 ? toolEntries : undefined,
          trailingThinking: currentThinkingSegment || undefined,
          toolCount: toolCount > 0 ? toolCount : undefined,
          stats,
          mentionOpenId,
        });

        // Send in-app urgent notification so the user gets a push notification
        // (card @mentions don't trigger Feishu notifications)
        if (mentionOpenId && session.getMessageId()) {
          try {
            await client.im.message.urgentApp({
              path: { message_id: session.getMessageId()! },
              params: { user_id_type: "open_id" },
              data: { user_id_list: [mentionOpenId] },
            });
          } catch (err) {
            log.warn(`urgent_app notification failed: ${String(err)}`);
          }
        }
      } catch (err) {
        log.error(`streaming error: ${String(err)}`);
        // Always close the streaming card to prevent it from being stuck
        if (session.isActive()) {
          await session.close({
            finalText: contentText || `Error: ${String(err)}`,
          }).catch(() => {});
        }
      }
    });
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

  private _inferMediaType(placeholder: string): MediaAttachment["mediaType"] {
    if (placeholder.includes("image")) return "image";
    if (placeholder.includes("audio")) return "audio";
    if (placeholder.includes("video")) return "video";
    if (placeholder.includes("sticker")) return "sticker";
    return "file";
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

