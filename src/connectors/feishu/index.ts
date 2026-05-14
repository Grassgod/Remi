/**
 * FeishuConnector — implements Remi Connector interface for Feishu/Lark.
 *
 * Message flow:
 *   Feishu WebSocket → parse + dedup + resolve → IncomingMessage → streamHandler()
 *   ACP SessionUpdate events → streaming card (thinking + content in real-time) → close with stats
 */

import type { FeishuConfig } from "../../config.js";
import { GroupConfigStore } from "../../group/store.js";
import type { AgentResponse, ProviderEvent } from "../../providers/base.js";
import type { ToolCallUpdate, ToolCallProgressUpdate, ContentBlock, RequestPermissionParams, PermissionOutcome, PermissionOption } from "../../providers/acp/protocol.js";
import { createAdapter, type AgentAdapter } from "../../providers/acp/adapters/index.js";
import type { Connector, MessageHandler, StreamingHandler, IncomingMessage } from "../base.js";
import type { MediaAttachment } from "../../providers/claude-cli/protocol.js";
import { createLogger } from "../../logger.js";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const log = createLogger("feishu");
import { createFeishuClient } from "./client.js";
import { sendMarkdownCardFeishu, sendCardFeishu } from "./send.js";
import { FeishuStreamingSession, buildFinalCard, type TokenProvider } from "./streaming.js";
import {
  type ToolEntry,
  shortPath,
  formatToolInputSummary,
} from "./tool-formatters.js";
import { registerPendingAction, rejectAllPendingActions, rejectPendingAction, rejectPendingActionsForChat, hasPendingAction } from "./card-actions.js";
import { buildToolApprovalForm, buildAskQuestionForm, buildPlanReviewForm } from "./permission-ui.js";
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
  const MAX = 400;

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
    case "Skill":
      return `Skill: ${trunc(s(input?.skill ?? input?.args), MAX)}`;
    default:
      return `Tool: ${name}...`;
  }
}

function selectPermissionOption(
  options: PermissionOption[],
  preferredIds: string[],
  fallbackKinds: PermissionOption["kind"][],
): PermissionOption | undefined {
  for (const id of preferredIds) {
    const option = options.find((o) => o.optionId === id);
    if (option) return option;
  }
  for (const kind of fallbackKinds) {
    const option = options.find((o) => o.kind === kind);
    if (option) return option;
  }
  return undefined;
}

function allowCurrentToolOption(options: PermissionOption[]): PermissionOption | undefined {
  return selectPermissionOption(options, ["allow"], ["allow_once", "allow_always"]);
}

export function approvePlanOption(options: PermissionOption[]): PermissionOption | undefined {
  return selectPermissionOption(
    options,
    ["default", "acceptEdits", "auto", "allow"],
    ["allow_once", "allow_always"],
  );
}

export function rejectPermissionOption(options: PermissionOption[]): PermissionOption | undefined {
  return selectPermissionOption(options, ["reject", "plan"], ["reject_once", "reject_always"]);
}

function selectedPermissionOption(value: unknown, options: PermissionOption[]): PermissionOption | undefined {
  const decision = typeof value === "string" ? value : formValueText(value, "decision");
  if (!decision) return undefined;
  return options.find((option) => option.optionId === decision);
}

function formValueText(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const raw = (value as Record<string, unknown>)[key];
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map(String).join(", ");
  if (typeof raw === "object" && "value" in raw) return String((raw as Record<string, unknown>).value ?? "");
  return String(raw);
}

export function isPlanApproval(value: unknown): boolean {
  const decision = formValueText(value, "decision").toLowerCase();
  return decision === "approved" || decision === "approve" || decision === "allow";
}

function answerValueText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(answerValueText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.label === "string") return obj.label;
    if (typeof obj.content === "string") return obj.content;
    if (obj.text && typeof obj.text === "object") return answerValueText((obj.text as Record<string, unknown>).content);
  }
  return String(value);
}

function normalizeAskAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const answers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw == null) continue;
    answers[key] = answerValueText(raw);
  }
  return answers;
}

/** Read the most recently modified plan file from .claude/plans/ directory. */
function readLatestPlanContent(cwd?: string): string | null {
  const plansDir = join(cwd || homedir(), ".claude", "plans");
  try {
    const files = readdirSync(plansDir)
      .filter((f) => f.endsWith(".md") && !f.includes("-agent-"))
      .map((f) => {
        const full = join(plansDir, f);
        return { path: full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    return readFileSync(files[0].path, "utf-8");
  } catch {
    return null;
  }
}

export class FeishuConnector implements Connector {
  readonly name = "feishu";
  private _config: FeishuConfig & { domain?: string; connectionMode?: string };
  private _wsHandle: FeishuWSHandle | null = null;
  private _handler: MessageHandler | null = null;
  private _streamHandler: StreamingHandler | null = null;
  private _tokenProvider: TokenProvider | null = null;

  /** Active streaming sessions keyed by sessionKey (chatId + thread context, for /esc abort). */
  private _activeSessions = new Map<string, FeishuStreamingSession>();

  /** Callback to kill the CLI process on /esc (set by Remi core via setAbortHandler). */
  private _abortHandler: ((sessionKey: string) => Promise<void>) | null = null;

  /** Enqueue mission step to BunQueue (set by serve.ts). */
  private _enqueueMission: ((data: import("../../queue/queues.js").MissionJobData) => Promise<void>) | null = null;

  constructor(config: FeishuConfig & { domain?: string; connectionMode?: string }) {
    this._config = config;
  }

  /**
   * Derive session key from a Feishu message, mirroring core._resolveSessionKey().
   * Group threads use chatId:thread:rootId; new group @mentions use chatId:thread:messageId; P2P uses chatId.
   */
  /**
   * Resolve or create a Mission for a group thread.
   * Works for both first messages (no rootId, uses messageId) and subsequent messages (has rootId).
   * Returns the mission if found/created, null if non-project group.
   */
  private async _resolveMissionForThread(
    msg: ParsedFeishuMessage,
    threadId: string,
  ): Promise<{ mission: import("../../mission/model.js").Mission; isNew: boolean } | null> {
    const { MissionStore } = await import("../../mission/store.js");
    const { getDb } = await import("../../db/index.js");
    const db = getDb();

    // Check if a mission already exists for this thread
    const existing = db.query(
      "SELECT id FROM missions WHERE chat_id = ? AND thread_id = ?",
    ).get(msg.chatId, threadId) as { id: string } | null;
    if (existing) {
      const store = new MissionStore();
      const mission = store.getById(existing.id);
      if (mission) return { mission, isNew: false };
    }

    // Only create missions for groups with mission_enabled flag
    const gcStore = new GroupConfigStore();
    const gc = gcStore.getByChatId(msg.chatId);
    if (!gc?.missionEnabled) return null; // Mission not enabled for this group
    const projectId = gc.projectId;

    // Create mission — use the message text as title
    const title = msg.rawContent.slice(0, 100) || `Topic ${threadId.slice(0, 8)}`;
    const store = new MissionStore();
    const mission = store.create({
      title,
      projectId,
      chatId: msg.chatId,
      threadId,
      createdBy: msg.senderOpenId,
      createdByName: msg.senderName ?? undefined,
    });

    log.info(`Auto-created mission ${mission.id} for thread ${threadId} in group ${msg.chatId}`);

    return { mission, isNew: true };
  }

  private _resolveSessionKey(msg: ParsedFeishuMessage): string {
    if (msg.rootId) return `${msg.chatId}:thread:${msg.rootId}`;
    if (msg.chatType === "group") return `${msg.chatId}:thread:${msg.messageId}`;
    return msg.chatId;
  }

  /**
   * Augment rawContent with media metadata for mission intake.
   * Images: inject {image_key, message_id} JSON so skills can fetch via resource API.
   * Files/audio/video: persist to tmp and inline the path. Stickers ignored.
   */
  private _buildUserMessageWithMedia(msg: ParsedFeishuMessage): string {
    let userMessage = msg.rawContent;
    for (const m of msg.media) {
      if (m.placeholder === "<media:image>" && m.imageKey) {
        userMessage += `\n{"image_key":"${m.imageKey}","message_id":"${msg.messageId}"}`;
      } else if (m.placeholder !== "<media:sticker>") {
        try {
          const dir = join(tmpdir(), "remi-media", msg.chatId.slice(0, 16));
          mkdirSync(dir, { recursive: true });
          const name = m.fileName ?? `${Date.now()}.bin`;
          const filePath = join(dir, name);
          writeFileSync(filePath, m.buffer);
          userMessage += `\n[文件已保存: ${filePath}]`;
          log.info(`saved mission intake media to ${filePath} (${m.buffer.length} bytes)`);
        } catch (err) {
          log.warn(`failed to save mission intake media: ${String(err)}`);
        }
      }
    }
    return userMessage;
  }

  /** Load IntakeSkill SKILL.md with mission context appended. */
  /** Register a handler that kills the CLI process for a given sessionKey. */
  setAbortHandler(handler: (sessionKey: string) => Promise<void>): void {
    this._abortHandler = handler;
  }

  /** Set the token provider (from 1Passport AuthStore). */
  setTokenProvider(provider: TokenProvider): void {
    this._tokenProvider = provider;
  }

  /** Set the queue enqueue function (from serve.ts, for mission thread routing). */
  setQueueRef(fn: (data: import("../../queue/queues.js").MissionJobData) => Promise<void>): void {
    this._enqueueMission = fn;
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
    if (/^\/esc$/i.test(msg.rawContent.trim())) {
      // First, reject any pending interactive actions (AskUserQuestion / ExitPlanMode)
      // so the provider's `await promise` unblocks and the lane lock can be released.
      rejectAllPendingActions("User sent /esc");

      const sessionKey = this._resolveSessionKey(msg);
      const session = this._activeSessions.get(sessionKey);
      if (session && session.isActive()) {
        log.info(`/esc received from ${msg.senderOpenId} — aborting active session "${sessionKey}"`);
        await session.abort();
        // Also kill the underlying CLI process
        if (this._abortHandler) {
          await this._abortHandler(sessionKey).catch((e) =>
            log.warn(`abort handler failed: ${String(e)}`));
        }
      } else {
        log.info(`/esc received but no active session for "${sessionKey}"`);
      }
      return;
    }

    // ── Mission auto-creation: only for NEW threads in mission-enabled groups ──
    // Messages WITH rootId (follow-up in thread) skip this and go through normal chat.
    if (msg.chatType === "group" && this._enqueueMission && !msg.rootId) {
      try {
        const result = await this._resolveMissionForThread(msg, msg.messageId);
        if (result && result.isNew) {
          await this._enqueueMission({
            missionId: result.mission.id,
            step: "intake",
            userMessage: this._buildUserMessageWithMedia(msg),
          });
          log.info(`New mission ${result.mission.id} created, intake enqueued (thread=${msg.messageId})`);
          return; // intake handler will streamToThread with skill guidance
        }
      } catch (err) {
        log.warn(`resolveMissionForThread failed: ${err}`);
      }
    }

    // Request-scoped logger with traceId = feishu messageId
    const _log = log.child({ traceId: msg.messageId });

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
        _log.info(`saved ${m.mediaType} to ${filePath} (${m.buffer.length} bytes)`);
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

    _log.info(`received message from ${msg.senderName ?? msg.senderOpenId}: ${text.slice(0, 80)}${media.length > 0 ? ` [+${media.length} media]` : ""}`);

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

      // If there's an active session for this topic (previous message still processing),
      // reject any pending interactive actions to unblock the lane lock.
      // This handles the P2P case where user sends a new message instead of clicking the form.
      const sessionKey = this._resolveSessionKey(msg);
      const existingSession = this._activeSessions.get(sessionKey);
      if (existingSession && existingSession.isActive()) {
        const rejected = rejectPendingActionsForChat(msg.chatId, "New message received, cancelling pending interaction");
        if (rejected > 0) {
          _log.info(`Cancelled ${rejected} pending action(s) for session "${sessionKey}" — new message takes priority`);
        }
      }

      // Determine reply mode: p2p chats never use thread; groups check group_configs DB
      const gcStore = new GroupConfigStore();
      const groupConfig = gcStore.getByChatId(msg.chatId);
      const replyInThread = msg.chatType === "p2p" ? false : (groupConfig ? groupConfig.replyMode === "thread" : true);
      const replyToId = replyInThread ? msg.messageId : undefined;

      // Use real streaming if streamHandler is available
      if (this._streamHandler) {
        await this._handleStreaming(incoming, msg.chatId, sessionKey, replyToId, _log);
      } else {
        // Fallback: blocking handler → static card
        const response = await this._handler(incoming);
        await this._sendStaticReply(msg.chatId, response, replyToId);
      }
    } catch (err) {
      _log.error(`failed to process message: ${String(err)}`);
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
  /**
   * Stream a message to a Feishu thread (public API for mission pipeline).
   * Reuses _handleStreaming with full UI features.
   */
  async streamToThread(
    incoming: IncomingMessage,
    chatId: string,
    threadId: string,
  ): Promise<void> {
    const sessionKey = `${chatId}:thread:${threadId}`;
    await this._handleStreaming(incoming, chatId, sessionKey, threadId);
  }

  private async _handleStreaming(
    incoming: IncomingMessage,
    chatId: string,
    sessionKey: string,
    replyToMessageId?: string,
    _log?: import("../../logger.js").Logger,
  ): Promise<void> {
    const slog = _log ?? log; // streaming-scoped logger
    const creds = {
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain,
    };
    const client = createFeishuClient(creds);
    const session = new FeishuStreamingSession(client, creds, {
      log: (msg) => slog.info(msg),
      tokenProvider: this._tokenProvider ?? undefined,
    });

    // Register active session for /esc abort (keyed by sessionKey to isolate topics)
    this._activeSessions.set(sessionKey, session);

    let thinkingText = "";
    let contentText = "";
    // finalResponse removed — stats built from usage_update events directly
    let toolCount = 0;

    // Collect tool entries for final card nested collapsible panels
    const toolEntries: ToolEntry[] = [];
    let currentThinkingSegment = "";
    let trailingThinkingFlushed = false;
    let usageTokens = 0;
    let usageContextWindow: number | null = null;
    let usageCost = 0;

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
        // Build name suffix: mission ID + provider/mode label
        const missionSuffix = incoming.metadata?.missionId ? ` · ${incoming.metadata.missionId}` : "";
        const agentLabel = meta.agentType === "codex" ? "Codex" : "Claude";
        const modeLabel = meta.mode && meta.mode !== "auto" ? ` ${meta.mode === "bypassPermissions" ? "Bypass" : meta.mode.charAt(0).toUpperCase() + meta.mode.slice(1)}` : "";
        const providerSuffix = ` · ${agentLabel}${modeLabel}`;
        const nameSuffix = `${missionSuffix}${providerSuffix}` || undefined;
        await session.start(chatId, "chat_id", { replyToMessageId, sessionId: meta.sessionId, displayName: meta.displayName ?? undefined, nameSuffix });
      } catch (err) {
        slog.warn(`streaming card creation failed, falling back to static reply: ${String(err)}`);
        if (this._handler) {
          const response = await this._handler(incoming);
          await this._sendStaticReply(chatId, response, replyToMessageId);
        }
        return;
      }

      const agentType = meta.agentType
        ?? (meta.providerName?.startsWith("acp:") ? meta.providerName.slice("acp:".length) : null)
        ?? "claude";
      let acpAdapter: AgentAdapter;
      try {
        acpAdapter = createAdapter(agentType);
      } catch {
        acpAdapter = createAdapter("claude");
      }
      const toolStartTimes = new Map<string, number>();
      const seenInputs = new Set<string>();
      const acpToolNames = new Map<string, string>();
      let permissionQueue: Promise<void> = Promise.resolve();

      // Register permission handler for interactive approval
      if (meta.setPermissionHandler) {
        const handlePermissionRequest = async (params: RequestPermissionParams): Promise<PermissionOutcome> => {
          const askData = acpAdapter.extractAskUserQuestion(params.toolCall);
          const isExitPlan = acpAdapter.isExitPlanMode(params.toolCall);
          const toolName = acpAdapter.resolveToolName(params.toolCall);

          const savedStatus = session.getLastStatus();
          let actionId = "";
          let result: unknown;
          let resolved = false;
          let actionPromise: Promise<unknown> | null = null;
          try {
            const questions = askData
              ? askData.questions.map((q) => ({ question: q.question, options: q.options }))
              : undefined;
            actionPromise = new Promise<unknown>((resolve, reject) => {
              actionId = registerPendingAction(resolve, reject, questions, chatId);
            });

            let form;
            if (askData) {
              form = buildAskQuestionForm(actionId, askData);
              session.updateStatus("Waiting for input...");
            } else if (isExitPlan) {
              const planContent = typeof params.toolCall.rawInput === "object" && params.toolCall.rawInput
                ? String((params.toolCall.rawInput as any).planContent ?? (params.toolCall.rawInput as any).plan ?? "")
                : undefined;
              form = buildPlanReviewForm(actionId, planContent || undefined);
              session.updateStatus("Waiting for approval...");
            } else {
              const inputSummary = formatToolInputSummary(toolName, acpAdapter.extractToolInput(params.toolCall) ?? undefined);
              form = buildToolApprovalForm(actionId, toolName, inputSummary, params.options);
              session.updateStatus(`Waiting for ${toolName} approval...`);
            }

            slog.info(`permission request: type=${askData ? "ask" : isExitPlan ? "plan" : "tool"} tool=${toolName} actionId=${actionId}`);
            await session.appendPermissionForm(form);
            result = await actionPromise;
            resolved = true;
          } catch (err) {
            if (actionId && hasPendingAction(actionId)) {
              rejectPendingAction(actionId, String(err));
              await actionPromise?.catch(() => {});
            }
            slog.info(`permission cancelled: tool=${toolName} reason=${String(err)}`);
            return { outcome: "cancelled" };
          } finally {
            if (actionId) {
              await session.removePermissionForm(actionId, { preservePanel: isExitPlan && resolved }).catch(() => {});
            }
            await session.updateStatus(savedStatus || "Running...");
          }

          if (askData) {
            const option = allowCurrentToolOption(params.options);
            const answers = normalizeAskAnswers(result);
            slog.info(`AskUserQuestion answered via card: ${JSON.stringify(result)?.slice(0, 500)} option=${option?.optionId ?? "none"}`);
            return option
              ? {
                  outcome: "selected",
                  optionId: option.optionId,
                  updatedInput: { questions: askData.questions, answers },
                }
              : { outcome: "cancelled" };
          }

          if (isExitPlan) {
            if (isPlanApproval(result)) {
              const option = approvePlanOption(params.options);
              slog.info(`ExitPlanMode approved via card: option=${option?.optionId ?? "none"}`);
              return option
                ? { outcome: "selected", optionId: option.optionId }
                : { outcome: "cancelled" };
            }
            const option = rejectPermissionOption(params.options);
            slog.info(`ExitPlanMode rejected via card: option=${option?.optionId ?? "none"}`);
            return option
              ? { outcome: "selected", optionId: option.optionId }
              : { outcome: "cancelled" };
          }

          const selected = selectedPermissionOption(result, params.options);
          slog.info(`permission selected via card: tool=${toolName} option=${selected?.optionId ?? "none"}`);
          return selected
            ? { outcome: "selected", optionId: selected.optionId }
            : { outcome: "cancelled" };
        };

        meta.setPermissionHandler((params: RequestPermissionParams): Promise<PermissionOutcome> => {
          const run = () => handlePermissionRequest(params);
          const queued = permissionQueue.then(run, run);
          permissionQueue = queued.then(() => undefined, () => undefined);
          return queued;
        });
      }

      try {
        try {
        for await (const event of stream) {
          if (session.abortSignal.aborted) {
            slog.warn("Safety timeout aborted stream consumption");
            break;
          }
          slog.debug(`received event: ${event.sessionUpdate}`);
          switch (event.sessionUpdate) {
            case "agent_thought_chunk": {
              const blocks = Array.isArray(event.content) ? event.content : [event.content];
              for (const b of blocks as ContentBlock[]) {
                if (b.type === "text" && b.text) {
                  thinkingText += b.text;
                  currentThinkingSegment += b.text;
                }
              }
              if (planTasks.length === 0 && activeAgents.length === 0) {
                await session.updateStatus("Thinking...");
              }
              await session.updateThinking(thinkingText);
              break;
            }
            case "agent_message_chunk": {
              const blocks = Array.isArray(event.content) ? event.content : [event.content];
              for (const b of blocks as ContentBlock[]) {
                if (b.type === "text" && b.text) {
                  contentText += b.text;
                }
              }
              if (!trailingThinkingFlushed && currentThinkingSegment.trim()) {
                session.addStep("_thinking", currentThinkingSegment.trim().replace(/\n{3,}/g, "\n\n"));
                trailingThinkingFlushed = true;
              }
              if (planTasks.length === 0 && activeAgents.length === 0) {
                await session.updateStatus("Writing...");
              }
              await session.update(contentText);
              break;
            }
            case "tool_call": {
              const tc = event as ToolCallUpdate;
              const toolName = acpAdapter.resolveToolName(tc);
              const input = acpAdapter.extractToolInput(tc);
              acpToolNames.set(tc.toolCallId, toolName);
              toolStartTimes.set(tc.toolCallId, Date.now());
              toolCount++;
              slog.info(`tool_call: tool=${toolName} id=${tc.toolCallId} inputKeys=[${input ? Object.keys(input) : "none"}]`);

              if (toolName === "TodoWrite" && input?.todos) {
                const todos = input.todos as Array<Record<string, unknown>>;
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
              } else if (toolName === "TaskCreate" && input) {
                planTasks.push({
                  id: `_pending_${tc.toolCallId}`,
                  subject: String(input.subject ?? ""),
                  status: "pending",
                });
                syncHeartbeatRenderer();
                await session.updateStatus(renderPlanStatus(planTasks, session.getElapsed()));
              } else if (toolName === "TaskUpdate" && input) {
                const task = planTasks.find((t) => t.id === String(input.taskId));
                if (task) {
                  if (input.status === "deleted") {
                    const idx = planTasks.indexOf(task);
                    if (idx !== -1) planTasks.splice(idx, 1);
                  } else {
                    if (input.status) task.status = String(input.status);
                    if (input.subject) task.subject = String(input.subject);
                  }
                  syncHeartbeatRenderer();
                  await session.updateStatus(renderPlanStatus(planTasks, session.getElapsed()));
                }
              } else if (toolName === "Agent") {
                activeAgents.push({
                  toolUseId: tc.toolCallId,
                  description: String(input?.description ?? input?.prompt ?? "").slice(0, 60),
                  startTime: Date.now(),
                });
                syncHeartbeatRenderer();
                await session.updateStatus(renderCombinedStatus(planTasks, activeAgents, session.getElapsed()));
              } else if (!PLAN_TOOLS.has(toolName)) {
                if (planTasks.length === 0 && activeAgents.length === 0) {
                  await session.updateStatus(formatToolStatus(toolName, input));
                }
              }

              toolEntries.push({
                name: toolName,
                input,
                status: "pending",
                thinkingBefore: currentThinkingSegment,
              });
              if (currentThinkingSegment.trim()) {
                session.addStep("_thinking", currentThinkingSegment.trim().replace(/\n{3,}/g, "\n\n"));
              }
              currentThinkingSegment = "";
              trailingThinkingFlushed = false;
              break;
            }
            case "tool_call_update": {
              const tc = event as ToolCallProgressUpdate;
              const toolName = acpToolNames.get(tc.toolCallId) ?? acpAdapter.resolveToolName(tc);

              if (tc.status === "completed" || tc.status === "failed") {
                const startTime = toolStartTimes.get(tc.toolCallId);
                const durationMs = startTime ? Date.now() - startTime : undefined;
                slog.info(`tool_call_update(${tc.status}): tool=${toolName} id=${tc.toolCallId} duration=${durationMs ?? "?"}ms hasRawInput=${!!tc.rawInput}`);
                toolStartTimes.delete(tc.toolCallId);
                acpToolNames.delete(tc.toolCallId);
                seenInputs.delete(tc.toolCallId);
                const resultPreview = acpAdapter.extractResultPreview(tc);
                const resolvedInput = acpAdapter.extractToolInput(tc);

                if (toolName === "TaskCreate" && resultPreview) {
                  const match = resultPreview.match(/Task #(\S+)/);
                  if (match) {
                    const task = planTasks.find((t) => t.id === `_pending_${tc.toolCallId}`);
                    if (task) task.id = match[1];
                  }
                }
                if (toolName === "Agent") {
                  const idx = activeAgents.findIndex((a) => a.toolUseId === tc.toolCallId);
                  if (idx !== -1) activeAgents.splice(idx, 1);
                  syncHeartbeatRenderer();
                }
                const combined = renderCombinedStatus(planTasks, activeAgents, session.getElapsed());
                await session.updateStatus(combined || "Thinking...");

                const entry = toolEntries.findLast((e) => e.status === "pending");
                if (entry) {
                  entry.status = "done";
                  entry.durationMs = durationMs;
                  entry.resultPreview = resultPreview;
                  if (resolvedInput && !entry.input) entry.input = resolvedInput;
                  if (!entry.stepAdded) {
                    entry.stepAdded = true;
                    const desc = `${entry.name} ${formatToolInputSummary(entry.name, entry.input)}`.trim();
                    slog.info(`tool_result fallback addStep: tool=${entry.name} inputKeys=[${entry.input ? Object.keys(entry.input) : "none"}] desc="${desc.slice(0, 80)}"`);
                    session.addStep(entry.name, desc);
                  }
                }
                if (durationMs) session.updateStepDuration(durationMs);
              } else {
                const alreadySeen = seenInputs.has(tc.toolCallId);
                const input = acpAdapter.extractToolInput(tc);
                const inputKeys = input ? Object.keys(input) : [];
                slog.info(`tool_call_update(in-progress): tool=${toolName} id=${tc.toolCallId} alreadySeen=${alreadySeen} inputKeys=[${inputKeys}] rawInput=${JSON.stringify(tc.rawInput)?.slice(0, 100)} title="${tc.title ?? ""}" content=${JSON.stringify(tc.content)?.slice(0, 100)}`);
                if (!alreadySeen && toolName === "AskUserQuestion") {
                  seenInputs.add(tc.toolCallId);
                  slog.info("AskUserQuestion tool update observed; waiting is handled by ACP permission request");
                } else if (!alreadySeen && toolName === "ExitPlanMode") {
                  seenInputs.add(tc.toolCallId);
                  slog.info("ExitPlanMode tool update observed; waiting is handled by ACP permission request");
                } else if (!alreadySeen && input && inputKeys.length > 0) {
                  seenInputs.add(tc.toolCallId);
                  const pendingEntry = toolEntries.findLast((e) => e.status === "pending" && e.name === toolName);
                  if (pendingEntry && !pendingEntry.stepAdded) {
                    pendingEntry.input = input;
                    pendingEntry.stepAdded = true;
                    const inputSummary = formatToolInputSummary(toolName, input);
                    const stepDesc = `${toolName} ${inputSummary}`.trim();
                    slog.info(`addStep(in-progress): tool=${toolName} id=${tc.toolCallId} summary="${inputSummary.slice(0, 80)}" desc="${stepDesc.slice(0, 80)}"`);
                    session.addStep(toolName, stepDesc);
                    if (planTasks.length === 0 && activeAgents.length === 0) {
                      await session.updateStatus(formatToolStatus(toolName, input));
                    }
                  }
                }
              }
              break;
            }
            case "usage_update": {
              const u = event as any;
              if (u.used != null) usageTokens = u.used;
              if (u.size != null) usageContextWindow = u.size;
              if (u.cost?.amount != null) usageCost = u.cost.amount;
              break;
            }
            case "plan": {
              const planEvent = event as any;
              if (Array.isArray(planEvent.entries)) {
                planTasks.length = 0;
                for (const entry of planEvent.entries) {
                  planTasks.push({
                    id: String(entry.id ?? planTasks.length),
                    subject: String(entry.content ?? ""),
                    status: String(entry.status ?? "pending"),
                  });
                }
                syncHeartbeatRenderer();
                await session.updateStatus(renderPlanStatus(planTasks, session.getElapsed()));
              }
              break;
            }
            case "current_mode_update": {
              const modeEvent = event as any;
              slog.info(`mode update: ${modeEvent.currentModeId}`);
              break;
            }
            case "session_info_update": {
              const infoEvent = event as any;
              if (infoEvent.title) {
                slog.info(`session info: title="${infoEvent.title}"`);
              }
              break;
            }
            case "config_option_update": {
              const configEvent = event as any;
              slog.info(`config update: ${configEvent.id}=${JSON.stringify(configEvent.value)?.slice(0, 100)}`);
              break;
            }
          }
        }
      } catch (streamErr) {
        const message = streamErr instanceof Error ? streamErr.message : String(streamErr);
        slog.error(`Stream error: ${message}`);
        contentText += `\n\n**Error:** ${message}\n`;
      }

        slog.info(`Stream ended: tools=${toolCount} elapsed=${session.getElapsed()}s`);

        const stats = this._formatStreamStats(session.getElapsed(), usageTokens, usageContextWindow, toolCount);
        const mentionOpenId: string | undefined = undefined;

        // AskUserQuestion / ExitPlanMode: handled via ACP permission requests, not via stream events
        const askQuestions = undefined;
        const planReviewAction = undefined;

        slog.info(`Closing streaming card...`);
        const closeStart = Date.now();
        await session.close({
          finalText: contentText || undefined,
          thinking: thinkingText || null,
          toolEntries: toolEntries.length > 0 ? toolEntries : undefined,
          trailingThinking: currentThinkingSegment || undefined,
          toolCount: toolCount > 0 ? toolCount : undefined,
          stats,
          mentionOpenId,
          sessionId: meta.sessionId,
          displayName: meta.displayName,
          askQuestions,
          planReview: planReviewAction,
        });
        slog.info(`Card closed in ${Date.now() - closeStart}ms`);

      } catch (err) {
        slog.error(`streaming error: ${String(err)}`);
        // Always close the streaming card to prevent it from being stuck
        if (session.isActive()) {
          const stats = this._formatStreamStats(session.getElapsed(), usageTokens, usageContextWindow, toolCount);
          await session.close({
            finalText: contentText || `Error: ${String(err)}`,
            thinking: thinkingText || null,
            toolEntries: toolEntries.length > 0 ? toolEntries : undefined,
            trailingThinking: currentThinkingSegment || undefined,
            toolCount: toolCount > 0 ? toolCount : undefined,
            stats,
            sessionId: meta.sessionId,
            displayName: meta.displayName,
          }).catch(() => {});
        }
      } finally {
        // Unregister active session
        this._activeSessions.delete(sessionKey);
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
      const inTok = response.inputTokens ?? 0;
      const outTok = response.outputTokens ?? 0;
      const fmtN = (n: number) =>
        n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` :
        n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n}`;
      if (outTok > 0) {
        parts.push(`${inTok}→${outTok}`);
      } else if (inTok > 0) {
        const usedStr = fmtN(inTok);
        if (response.contextWindow) {
          parts.push(`${usedStr}/${fmtN(response.contextWindow)}`);
        } else {
          parts.push(usedStr);
        }
      }
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      parts.push(`${response.toolCalls.length} tools`);
    }

    return parts.length > 0 ? parts.join(" · ") : null;
  }

  private _formatStreamStats(elapsedSec: number, usedTokens: number, contextWindow: number | null, toolCount: number): string | null {
    const parts: string[] = [];
    if (elapsedSec > 0) parts.push(`${elapsedSec.toFixed(1)}s`);
    if (usedTokens > 0) {
      const fmtN = (n: number) =>
        n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` :
        n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n}`;
      const usedStr = fmtN(usedTokens);
      parts.push(contextWindow ? `${usedStr}/${fmtN(contextWindow)}` : usedStr);
    }
    if (toolCount > 0) parts.push(`${toolCount} tools`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
}
