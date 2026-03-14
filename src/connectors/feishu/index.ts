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
  TOOL_EMOJI,
  shortPath,
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
function renderPlanStatus(tasks: PlanTask[], elapsed?: number): string {
  if (tasks.length === 0) return "";
  const completed = tasks.filter((t) => t.status === "completed").length;
  const header = elapsed != null
    ? `📋 **Plan** (${completed}/${tasks.length}) · ⏳ ${elapsed}s`
    : `📋 **Plan** (${completed}/${tasks.length})`;
  const lines = [header];
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
function renderCombinedStatus(planTasks: PlanTask[], activeAgents: ActiveAgent[], elapsed?: number): string {
  const parts: string[] = [];

  if (planTasks.length > 0) {
    parts.push(renderPlanStatus(planTasks, elapsed));
  }

  if (activeAgents.length > 0) {
    const elapsedSuffix = elapsed != null && planTasks.length === 0 ? ` · ⏳ ${elapsed}s` : "";
    const agentLines = [`🤖 **Agents** (${activeAgents.length} active)${elapsedSuffix}`];
    for (const a of activeAgents) {
      const agentElapsed = ((Date.now() - a.startTime) / 1000).toFixed(0);
      agentLines.push(`⏳ ${a.description} (${agentElapsed}s)`);
    }
    parts.push(agentLines.join("\n"));
  }

  return parts.join("\n\n");
}

/** Generate a human-readable status line from a tool call for the status bar. */
function formatToolStatus(name: string, input?: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? "" : String(v));
  const trunc = (t: string, max: number) => t.length <= max ? t : t.slice(0, max - 3) + "...";
  const emoji = TOOL_EMOJI[name] ?? TOOL_EMOJI._default ?? "⚙️";
  const MAX = 200;

  switch (name) {
    case "Read":
      return `${emoji} Reading ${trunc(shortPath(s(input?.file_path)), MAX)}...`;
    case "Bash":
      return `${emoji} Running: ${trunc(shortPath(s(input?.command)), MAX)}...`;
    case "Grep":
      return `${emoji} Searching: ${trunc(s(input?.pattern), MAX)}...`;
    case "Edit":
    case "Write":
      return `${emoji} Editing ${trunc(shortPath(s(input?.file_path)), MAX)}...`;
    case "Glob":
      return `${emoji} Finding: ${trunc(s(input?.pattern), MAX)}...`;
    case "WebFetch":
      return `${emoji} Fetching: ${trunc(s(input?.url), MAX)}...`;
    case "WebSearch":
      return `${emoji} Searching: ${trunc(s(input?.query), MAX)}...`;
    case "Agent":
      return `${emoji} Agent: ${trunc(s(input?.description ?? input?.prompt), MAX)}...`;
    default:
      return `${emoji} Tool: ${name}...`;
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

    const client = createFeishuClient({
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain,
    });
    let thinkingReactionId: string | undefined;
    try {
      // Add typing indicator (thinking emoji)
      try {
        const { addReactionFeishu } = await import("./reactions.js");
        const result = await addReactionFeishu(client, msg.messageId, "THINKING");
        thinkingReactionId = result.reactionId;
      } catch {
        // Non-critical: skip typing indicator if it fails
      }

      // Determine reply mode: p2p chats never use thread; groups check bot profile
      const botProfile = this._findBotProfile(msg.chatId);
      const replyInThread = msg.chatType === "p2p" ? false : (botProfile ? botProfile.replyMode === "thread" : true);
      const replyToId = replyInThread ? msg.messageId : undefined;

      // Use real streaming if streamHandler is available
      if (this._streamHandler) {
        await this._handleStreaming(incoming, msg.chatId, replyToId);
      } else {
        // Fallback: blocking handler → static card
        const response = await this._handler(incoming);
        await this._sendStaticReply(msg.chatId, response, replyToId);
      }
    } catch (err) {
      log.error(`failed to process message ${msg.messageId}: ${String(err)}`);
      try {
        await sendMarkdownCardFeishu(client, msg.chatId, `**Error:** ${String(err)}`);
      } catch {
        // Give up
      }
    } finally {
      // Always clean up thinking reaction, even if streaming threw
      if (thinkingReactionId) {
        try {
          const { removeReactionFeishu } = await import("./reactions.js");
          await removeReactionFeishu(client, msg.messageId, thinkingReactionId);
        } catch {
          // Non-critical
        }
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

    /** Sync heartbeat renderer: register when plan/agents active, clear when idle. */
    const syncHeartbeatRenderer = () => {
      if (planTasks.length > 0 || activeAgents.length > 0) {
        session.setHeartbeatRenderer((elapsed) =>
          renderCombinedStatus(planTasks, activeAgents, elapsed) || `⏳ Running (${elapsed}s)`,
        );
      } else {
        session.setHeartbeatRenderer(null);
      }
    };

    // Use callback pattern: the lane lock in core.ts covers this entire consumer,
    // so card close + @mention complete before the next message starts processing.
    await this._streamHandler!(incoming, async (stream, meta) => {
      // Start streaming card with session name (existing session → deterministic name, new → newborn)
      try {
        await session.start(chatId, "chat_id", { replyToMessageId, sessionId: meta.sessionId });
      } catch (err) {
        log.warn(`streaming card creation failed, falling back to static reply: ${String(err)}`);
        if (this._handler) {
          const response = await this._handler(incoming);
          await this._sendStaticReply(chatId, response, replyToMessageId);
        }
        return;
      }

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
              // Show thinking status (no step added — thinking is not a tool step)
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
                syncHeartbeatRenderer();
                await session.updateStatus(renderPlanStatus(planTasks, session.getElapsed()));
              } else if (event.name === "TaskCreate" && event.input) {
                planTasks.push({
                  id: `_pending_${event.toolUseId}`,
                  subject: String(event.input.subject ?? ""),
                  status: "pending",
                });
                syncHeartbeatRenderer();
                await session.updateStatus(renderPlanStatus(planTasks, session.getElapsed()));
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
                  syncHeartbeatRenderer();
                  await session.updateStatus(renderPlanStatus(planTasks, session.getElapsed()));
                }
              } else if (event.name === "Agent") {
                activeAgents.push({
                  toolUseId: event.toolUseId,
                  description: String(event.input?.description ?? event.input?.prompt ?? "").slice(0, 60),
                  startTime: Date.now(),
                });
                syncHeartbeatRenderer();
                await session.updateStatus(renderCombinedStatus(planTasks, activeAgents, session.getElapsed()));
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
              // Add icon step to process panel (strip emoji prefix from formatToolStatus to avoid double emoji in addStep)
              const stepDesc = formatToolStatus(event.name, event.input)
                .replace(/\.\.\.$/, "")
                .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]+\s*/u, "");
              session.addStep(event.name, stepDesc);
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
                syncHeartbeatRenderer();
              }
              // Update status bar
              const combined = renderCombinedStatus(planTasks, activeAgents, session.getElapsed());
              await session.updateStatus(combined || "🤔 Thinking...");
              // Update the matching pending entry
              const entry = toolEntries.findLast((e) => e.status === "pending");
              if (entry) {
                entry.status = "done";
                entry.durationMs = event.durationMs;
                entry.resultPreview = event.resultPreview;
              }
              // Steps panel is already updated by addStep() — no need to update process_content here
              break;
            }
            case "rate_limit":
              // status "allowed" = informational quota update, not a real block — skip UI noise
              if (event.status !== "allowed") {
                const secs = ((event.retryAfterMs) / 1000).toFixed(0);
                await session.updateStatus(`⚠️ Rate limited, retrying in ${secs}s...`);
                session.addStep("_default", `⚠️ Rate limited, retrying in ${secs}s`);
              }
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
        const mentionOpenId: string | undefined = undefined;
        await session.close({
          finalText: finalResponse?.text ?? contentText,
          thinking: thinkingText || finalResponse?.thinking || null,
          toolEntries: toolEntries.length > 0 ? toolEntries : undefined,
          trailingThinking: currentThinkingSegment || undefined,
          toolCount: toolCount > 0 ? toolCount : undefined,
          stats,
          mentionOpenId,
          sessionId: finalResponse?.sessionId,
        });

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

