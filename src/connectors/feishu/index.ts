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
import { sendMarkdownCardFeishu, sendCardFeishu } from "./send.js";
import { FeishuStreamingSession, buildFinalCard, type TokenProvider } from "./streaming.js";
import {
  type ToolEntry,
  shortPath,
} from "./tool-formatters.js";
import { registerPendingAction, rejectAllPendingActions, rejectPendingActionsForChat } from "./card-actions.js";
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
    ? `Plan (${completed}/${tasks.length}) · ${elapsed}s`
    : `Plan (${completed}/${tasks.length})`;
  const lines = [header];
  for (const t of tasks) {
    const icon =
      t.status === "completed" ? "✓"
      : t.status === "in_progress" ? "→"
      : "·";
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
    const elapsedSuffix = elapsed != null && planTasks.length === 0 ? ` · ${elapsed}s` : "";
    const agentLines = [`Agents (${activeAgents.length} active)${elapsedSuffix}`];
    for (const a of activeAgents) {
      const agentElapsed = ((Date.now() - a.startTime) / 1000).toFixed(0);
      agentLines.push(`→ ${a.description} (${agentElapsed}s)`);
    }
    parts.push(agentLines.join("\n"));
  }

  return parts.join("\n\n");
}

/** Generate a human-readable status line from a tool call for the status bar. */
function formatToolStatus(name: string, input?: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? "" : String(v));
  const trunc = (t: string, max: number) => t.length <= max ? t : t.slice(0, max - 3) + "...";
  const MAX = 200;

  switch (name) {
    case "Read":
      return `Reading ${trunc(shortPath(s(input?.file_path)), MAX)}...`;
    case "Bash": {
      const cmd = s(input?.command).split("\n")[0];
      return `Running: ${trunc(shortPath(cmd), MAX)}`;
    }
    case "Grep":
      return `Searching: ${trunc(s(input?.pattern), MAX)}...`;
    case "Edit":
    case "Write":
      return `Editing ${trunc(shortPath(s(input?.file_path)), MAX)}...`;
    case "Glob":
      return `Finding: ${trunc(s(input?.pattern), MAX)}...`;
    case "WebFetch":
      return `Fetching: ${trunc(s(input?.url), MAX)}...`;
    case "WebSearch":
      return `Searching: ${trunc(s(input?.query), MAX)}...`;
    case "Agent":
      return `Agent: ${trunc(s(input?.description ?? input?.prompt), MAX)}...`;
    default:
      return `Tool: ${name}...`;
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

  /** Active streaming sessions keyed by chatId (for /esc abort). */
  private _activeSessions = new Map<string, FeishuStreamingSession>();

  /** Callback to kill the CLI process on /esc (set by Remi core via setAbortHandler). */
  private _abortHandler: ((chatId: string) => Promise<void>) | null = null;

  constructor(config: FeishuConfig & { domain?: string; connectionMode?: string }) {
    this._config = config;
  }

  /** Register a handler that kills the CLI process for a given chatId. */
  setAbortHandler(handler: (chatId: string) => Promise<void>): void {
    this._abortHandler = handler;
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
      const card = buildFinalCard({ text, thinking: response.thinking, stats });
      await sendCardFeishu(client, chatId, card);
    } else {
      await sendMarkdownCardFeishu(client, chatId, text);
    }
  }

  // ── Internal ───────────────────────────────────────────────

  private async _handleFeishuMessage(msg: ParsedFeishuMessage): Promise<void> {
    if (!this._handler) return;

    // ── /esc: abort active session (bypasses Lane Queue) ──
    if (/^\/esc$/i.test(msg.text.trim())) {
      // First, reject any pending interactive actions (AskUserQuestion / ExitPlanMode)
      // so the provider's `await promise` unblocks and the lane lock can be released.
      rejectAllPendingActions("User sent /esc");

      const session = this._activeSessions.get(msg.chatId);
      if (session && session.isActive()) {
        log.info(`/esc received from ${msg.senderOpenId} — aborting active session in ${msg.chatId}`);
        await session.abort();
        // Also kill the underlying CLI process
        if (this._abortHandler) {
          await this._abortHandler(msg.chatId).catch((e) =>
            log.warn(`abort handler failed: ${String(e)}`));
        }
      } else {
        log.info(`/esc received but no active session in ${msg.chatId}`);
      }
      return;
    }

    // Convert Feishu media to protocol MediaAttachment
    const media: MediaAttachment[] = msg.media.map((m) => ({
      buffer: m.buffer,
      contentType: m.contentType ?? "application/octet-stream",
      fileName: m.fileName,
      mediaType: this._inferMediaType(m.placeholder),
    }));

    // Save non-image files to temp directory so Claude can read them
    // Images: inject metadata into text so skills can download via message resource API (no local caching)
    let text = msg.text;
    for (const m of media) {
      if (m.mediaType === "image") {
        const feishuMedia = msg.media.find((fm) => fm.buffer === m.buffer);
        const imageKey = feishuMedia?.imageKey;
        if (imageKey) {
          text += `\n{"image_key":"${imageKey}","message_id":"${msg.messageId}"}`;
        }
      } else if (m.mediaType !== "sticker") {
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

      // If there's an active session for this chat (previous message still processing),
      // reject any pending interactive actions to unblock the lane lock.
      // This handles the P2P case where user sends a new message instead of clicking the form.
      const existingSession = this._activeSessions.get(msg.chatId);
      if (existingSession && existingSession.isActive()) {
        const rejected = rejectPendingActionsForChat(msg.chatId, "New message received, cancelling pending interaction");
        if (rejected > 0) {
          log.info(`Cancelled ${rejected} pending action(s) for chat ${msg.chatId} — new message takes priority`);
        }
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

    // Register active session for /esc abort
    this._activeSessions.set(chatId, session);

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
          renderCombinedStatus(planTasks, activeAgents, elapsed) || `Running (${elapsed}s)`,
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
                await session.updateStatus("Thinking...");
              }
              await session.updateThinking(thinkingText);
              break;
            case "content_delta":
              contentText += event.text;
              if (planTasks.length === 0 && activeAgents.length === 0) {
                await session.updateStatus("Writing...");
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
              // Add thinking div before tool step if thinking segment is non-empty
              if (currentThinkingSegment.trim()) {
                const thinkingSummary = currentThinkingSegment.trim().replace(/\n{3,}/g, "\n\n");
                const thinkingDesc = thinkingSummary;
                session.addStep("_thinking", thinkingDesc);
              }
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
              await session.updateStatus(combined || "Thinking...");
              // Update the matching pending entry
              const entry = toolEntries.findLast((e) => e.status === "pending");
              if (entry) {
                entry.status = "done";
                entry.durationMs = event.durationMs;
                entry.resultPreview = event.resultPreview;
              }
              // Update step duration in timeline
              if (event.durationMs) session.updateStepDuration(event.durationMs);
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

        // Extract permission_denials and register card actions for AskUserQuestion / ExitPlanMode
        let askQuestions: { actionId: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }> } | undefined;
        let planReviewAction: { actionId: string } | undefined;
        const denials = finalResponse?.permissionDenials;

        if (denials && denials.length > 0) {
          for (const denial of denials) {
            if (denial.toolName === "AskUserQuestion" && denial.toolInput?.questions) {
              const questions = denial.toolInput.questions as typeof askQuestions extends { questions: infer Q } | undefined ? Q : never;
              // Register action: on resolve, send answers as new user message to CLI
              // Capture replyToMessageId for group chat thread context
              const capturedReplyTo = replyToMessageId;
              const actionId = registerPendingAction(
                (answers) => {
                  const answerMap = answers as Record<string, string>;
                  const lines = Object.entries(answerMap).map(([q, a], i) => `${i + 1}. ${q}: ${a}`);
                  const answerText = `用户回答了之前的问题:\n${lines.join("\n")}`;
                  log.info(`AskUserQuestion answered, sending as new streaming message`);
                  // Use full _handleStreaming to render the CLI response in a new card
                  this._handleStreaming(
                    { ...incoming, text: answerText },
                    chatId,
                    capturedReplyTo,
                  ).catch((e) => log.error(`Failed to relay AskUserQuestion answer: ${e}`));
                },
                () => {},
                questions,
                chatId,
              );
              askQuestions = { actionId, questions };
              log.info(`Embedded AskUserQuestion form: actionId=${actionId}`);
            } else if (denial.toolName === "ExitPlanMode") {
              const capturedReplyTo = replyToMessageId;
              const actionId = registerPendingAction(
                (rawDecision) => {
                  // Form submits { decision: "approved"|"rejected"|"feedback", feedback_text?: string }
                  const formData = typeof rawDecision === "object" && rawDecision !== null
                    ? rawDecision as Record<string, string>
                    : { decision: String(rawDecision) };
                  const d = formData.decision;
                  const feedback = String(formData.feedback_text ?? "").trim();
                  let decisionText: string;
                  if (d === "approved") {
                    decisionText = "Plan approved, please proceed.";
                  } else if (d === "feedback" && feedback) {
                    decisionText = `User has feedback on the plan:\n${feedback}\nPlease revise accordingly.`;
                  } else if (d === "feedback") {
                    decisionText = "User wants to give feedback but didn't write anything. Please ask what they'd like changed.";
                  } else {
                    decisionText = "Plan rejected. Please stop.";
                  }
                  log.info(`ExitPlanMode answered: ${d}, feedback=${feedback.slice(0, 100)}`);
                  this._handleStreaming(
                    { ...incoming, text: decisionText },
                    chatId,
                    capturedReplyTo,
                  ).catch((e) => log.error(`Failed to relay ExitPlanMode decision: ${e}`));
                },
                () => {},
                undefined,
                chatId,
              );
              planReviewAction = { actionId };
              log.info(`Embedded ExitPlanMode buttons: actionId=${actionId}`);
            }
          }
        }

        await session.close({
          finalText: contentText || finalResponse?.text,
          thinking: thinkingText || finalResponse?.thinking || null,
          toolEntries: toolEntries.length > 0 ? toolEntries : undefined,
          trailingThinking: currentThinkingSegment || undefined,
          toolCount: toolCount > 0 ? toolCount : undefined,
          stats,
          mentionOpenId,
          sessionId: finalResponse?.sessionId,
          askQuestions,
          planReview: planReviewAction,
        });

      } catch (err) {
        log.error(`streaming error: ${String(err)}`);
        // Always close the streaming card to prevent it from being stuck
        if (session.isActive()) {
          await session.close({
            finalText: contentText || `Error: ${String(err)}`,
          }).catch(() => {});
        }
      } finally {
        // Unregister active session
        this._activeSessions.delete(chatId);
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
      const card = buildFinalCard({ text, thinking: response.thinking, stats });
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
      parts.push(`${(response.durationMs / 1000).toFixed(1)}s`);
    }

    if (response.inputTokens != null || response.outputTokens != null) {
      const inTok = response.inputTokens ?? "?";
      const outTok = response.outputTokens ?? "?";
      parts.push(`${inTok}→${outTok}`);
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      parts.push(`${response.toolCalls.length} tools`);
    }

    return parts.length > 0 ? parts.join(" · ") : null;
  }
}

