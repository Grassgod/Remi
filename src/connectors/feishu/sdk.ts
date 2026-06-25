/**
 * @remi/feishu-channel — Feishu/Lark channel SDK for Remi.
 *
 * Public API surface:
 *   createLarkChannel(config) → FeishuChannel
 *   FeishuChannel: on / sendText / sendCard / createStream / handleStream / abortSession
 */

// ── Core entry point ──────────────────────────────────────────
export { createLarkChannel, FeishuChannel } from "./channel.js";
export type {
  HandleStreamOpts,
  MessageHandler,
  CardActionHandler,
  ReactionHandler,
  Unsubscribe,
} from "./channel.js";

// ── Config ────────────────────────────────────────────────────
export type { FeishuChannelConfig, GroupPolicy, FeishuDomainName } from "./config.js";

// ── Message types ─────────────────────────────────────────────
export type { ParsedFeishuMessage, FeishuWSHandle } from "./receive.js";
export { flushDedupCacheSync } from "./receive.js";
export type { FeishuDomain, FeishuProbeResult } from "./types.js";

// ── Streaming ─────────────────────────────────────────────────
export { FeishuStreamingSession, buildFinalCard } from "./streaming.js";
export type { StreamingCloseOptions, TokenProvider } from "./streaming.js";
export type { StreamMeta, StreamHandlerLog } from "@shared/contracts/acp-protocol.js";

// ── Adapters ──────────────────────────────────────────────────
export { createAdapter, ClaudeAdapter, CodexAdapter } from "./adapters/index.js";
export type { AgentAdapter, AskUserQuestionData, AgentSessionOptions } from "@shared/contracts/acp-protocol.js";

// ── ACP Protocol types ────────────────────────────────────────
export type {
  SessionUpdate,
  ToolCallUpdate,
  ToolCallProgressUpdate,
  RequestPermissionParams,
  PermissionOutcome,
  PermissionOption,
  ContentBlock,
  PlanUpdate,
  UsageUpdate,
} from "@shared/contracts/acp-protocol.js";

// ── Low-level client (for remi's thin adapter) ───────────────
export { createFeishuClient } from "./client.js";

// ── Image utilities ───────────────────────────────────────────
export { compressImageForModel } from "./media.js";
export type { CompressResult } from "./media.js";

// ── Card/UI utilities (for remi's thin adapter to use directly) ──
export { sendMarkdownCardFeishu, sendCardFeishu, getMessageFeishu } from "./send.js";
export { shortPath, formatToolInputSummary, formatToolInputSummary as formatToolSummary } from "./tool-formatters.js";
export { addReactionFeishu, removeReactionFeishu } from "./reactions.js";
export {
  registerPendingAction,
  rejectAllPendingActions,
  rejectPendingActionsForChat,
  handleButtonClick,
  handleFormSubmission,
} from "./card-actions.js";
export { buildToolApprovalForm, buildAskQuestionForm, buildPlanReviewForm } from "./permission-ui.js";
export type { PermissionFormElements, AskUserQuestionData as PermissionAskData } from "./permission-ui.js";
export { approvePlanOption, rejectPermissionOption, isPlanApproval } from "./adapters/stream-handler.js";

// ── Session naming ────────────────────────────────────────────
export { generateUniqueName, getSessionName } from "./session-name.js";

// ── Group utilities ───────────────────────────────────────────
export { createProjectChat, getChatName, transferChatOwner, updateChat, addChatTab, setupProjectChat, getBoardBaseUrl, REMI_AVATAR_KEY } from "./chat.js";
export { createThread, sendToThread, getThreadMessages, getBaseUrl as getFeishuBaseUrl, getTenantToken } from "./thread.js";
export type { ThreadMessage } from "./thread.js";
export { MenuSyncer } from "./menu-sync.js";
export type { BotMenuConfig, BotMenuItemConfig, BotMenuBehavior, BotMenuUserConfig, BotMenuIcon } from "./config.js";
