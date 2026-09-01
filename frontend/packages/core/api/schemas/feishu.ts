// MUL-155: Feishu message ingestion contracts.
//
// The endpoint schema deliberately has no URL field. The API returns a
// registered *name* plus health only, and the control panel must never be able
// to learn — or submit — an internal address. If the server ever started
// leaking one, `.loose()` would carry it into the client, so the endpoints
// module strips the parsed object down to these keys.
import { z } from "zod";

export const FeishuEndpointHealthSchema = z.object({
  name: z.string().default(""),
  status: z.string().default("unknown"),
  checkedAt: z.string().nullable().default(null),
  latencyMs: z.number().nullable().default(null),
  version: z.string().nullable().default(null),
  capabilities: z.array(z.string()).nullable().default(null),
  errorCode: z.string().nullable().default(null),
  sourceCount: z.number().default(0),
}).loose();

export const FeishuEndpointListResponseSchema = z.object({
  configured: z.boolean().default(false),
  endpoints: z.array(FeishuEndpointHealthSchema).default([]),
}).loose();

export const FeishuEndpointCheckResponseSchema = z.object({
  endpoint: FeishuEndpointHealthSchema,
}).loose();

export const FeishuAllowlistEntrySchema = z.object({
  chatId: z.string().default(""),
  addedAt: z.string().default(""),
}).loose();

export const FeishuSourceSchema = z.object({
  id: z.string().default(""),
  workspaceId: z.string().default(""),
  name: z.string().default(""),
  type: z.string().default("feishu"),
  endpointName: z.string().default(""),
  allowlist: z.array(FeishuAllowlistEntrySchema).default([]),
  enabled: z.boolean().default(false),
  retentionDays: z.number().default(30),
  pollIntervalSeconds: z.number().default(60),
  unprocessedRetrySeconds: z.number().default(900),
  unprocessedRetryLimit: z.number().default(3),
  accessTokenSet: z.boolean().default(false),
  accessTokenHint: z.string().nullable().default(null),
  createdAt: z.string().default(""),
  updatedAt: z.string().default(""),
}).loose();

export const FeishuSourceListResponseSchema = z.object({
  sources: z.array(FeishuSourceSchema).default([]),
  total: z.number().default(0),
}).loose();

export const FeishuSourceResponseSchema = z.object({
  source: FeishuSourceSchema,
}).loose();

export const FeishuSourceStatusSchema = z.object({
  sourceId: z.string().default(""),
  unprocessedCount: z.number().default(0),
  timedOutCount: z.number().default(0),
  mutedDeliveryCount: z.number().default(0),
  pendingIssueProposalCount: z.number().default(0),
  oldestUnprocessedAt: z.string().nullable().default(null),
  maximumRetryCount: z.number().default(0),
  lastSuccessfulIngestAt: z.string().nullable().default(null),
  lastErrorCode: z.string().nullable().default(null),
  lastErrorAt: z.string().nullable().default(null),
  lagSeconds: z.number().nullable().default(null),
  consecutiveFailures: z.number().default(0),
  connectionAlertedAt: z.string().nullable().default(null),
  connectionAlertDeliveryFailureCount: z.number().default(0),
  connectionAlertDeliveryErrorCode: z.string().nullable().default(null),
  connectionAlertDeliveryFailedAt: z.string().nullable().default(null),
}).loose();

export const FeishuSourceStatusResponseSchema = z.object({
  status: FeishuSourceStatusSchema,
}).loose();

export const FeishuAvailableChatSchema = z.object({
  chatId: z.string().default(""),
  name: z.string().nullable().default(null),
  type: z.string().nullable().default(null),
  memberCount: z.number().nullable().default(null),
  external: z.boolean().default(false),
  description: z.string().nullable().default(null),
  inAllowlist: z.boolean().default(false),
}).loose();

export const FeishuAvailableChatsResponseSchema = z.object({
  chats: z.array(FeishuAvailableChatSchema).default([]),
  total: z.number().default(0),
  limit: z.number().default(0),
}).loose();

export const FeishuMessageOutcomeSchema = z.object({
  id: z.string().default(""),
  workspaceId: z.string().default(""),
  messageId: z.string().default(""),
  outcomeKind: z.string().default("ignored"),
  ref: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  taskId: z.string().nullable().default(null),
  createdAt: z.string().default(""),
}).loose();

export const FeishuMessageSchema = z.object({
  messageId: z.string().default(""),
  workspaceId: z.string().default(""),
  sourceId: z.string().default(""),
  chatId: z.string().default(""),
  chatType: z.string().nullable().default(null),
  chatName: z.string().nullable().default(null),
  threadId: z.string().nullable().default(null),
  rootId: z.string().nullable().default(null),
  parentId: z.string().nullable().default(null),
  sender: z.record(z.string(), z.unknown()).default({}),
  content: z.record(z.string(), z.unknown()).default({}),
  searchableText: z.string().default(""),
  contentFingerprint: z.string().default(""),
  messageAppLink: z.string().nullable().default(null),
  createdAt: z.string().default(""),
  updatedAt: z.string().nullable().default(null),
  recalled: z.boolean().default(false),
  edited: z.boolean().default(false),
  ingestedAt: z.string().default(""),
  processedAt: z.string().nullable().default(null),
  retryCount: z.number().default(0),
  lastRetryAt: z.string().nullable().default(null),
  outcomes: z.array(FeishuMessageOutcomeSchema).default([]),
}).loose();

export const FeishuMessageListResponseSchema = z.object({
  messages: z.array(FeishuMessageSchema).default([]),
  total: z.number().default(0),
  limit: z.number().default(0),
  offset: z.number().default(0),
  hasMore: z.boolean().default(false),
}).loose();

export const FeishuMessageActionResponseSchema = z.object({
  outcomes: z.array(FeishuMessageOutcomeSchema).default([]),
}).loose();

export const FeishuChatSchema = z.object({
  sourceId: z.string().default(""),
  chatId: z.string().default(""),
  chatName: z.string().nullable().default(null),
  chatType: z.string().nullable().default(null),
  messageCount: z.number().default(0),
  lastMessageAt: z.string().default(""),
  inAllowlist: z.boolean().default(false),
}).loose();

export const FeishuChatListResponseSchema = z.object({
  chats: z.array(FeishuChatSchema).default([]),
  total: z.number().default(0),
}).loose();

export const FeishuProposalIssueSchema = z.object({
  title: z.string().default(""),
  description: z.string().nullable().default(null),
  priority: z.string().nullable().default(null),
  projectId: z.string().nullable().default(null),
  assigneeType: z.string().nullable().default(null),
  assigneeId: z.string().nullable().default(null),
}).loose();

export const FeishuProposalMessageSummarySchema = z.object({
  messageId: z.string().default(""),
  sourceId: z.string().default(""),
  chatId: z.string().default(""),
  chatName: z.string().nullable().default(null),
  sender: z.record(z.string(), z.unknown()).default({}),
  searchableText: z.string().default(""),
  messageAppLink: z.string().nullable().default(null),
  createdAt: z.string().default(""),
}).loose();

export const FeishuProposalSchema = z.object({
  id: z.string().default(""),
  workspaceId: z.string().default(""),
  messageId: z.string().default(""),
  inboxItemId: z.string().nullable().default(null),
  issue: FeishuProposalIssueSchema.default({
    title: "", description: null, priority: null, projectId: null, assigneeType: null, assigneeId: null,
  }),
  status: z.string().default("pending"),
  resolvedAt: z.string().nullable().default(null),
  resolvedBy: z.string().nullable().default(null),
  createdAt: z.string().default(""),
  message: FeishuProposalMessageSummarySchema.default({
    messageId: "", sourceId: "", chatId: "", chatName: null,
    sender: {}, searchableText: "", messageAppLink: null, createdAt: "",
  }),
}).loose();

export const FeishuProposalListResponseSchema = z.object({
  proposals: z.array(FeishuProposalSchema).default([]),
  total: z.number().default(0),
  limit: z.number().default(0),
  offset: z.number().default(0),
  hasMore: z.boolean().default(false),
}).loose();

export type FeishuEndpointHealth = z.infer<typeof FeishuEndpointHealthSchema>;
export type FeishuEndpointList = z.infer<typeof FeishuEndpointListResponseSchema>;
export type FeishuSource = z.infer<typeof FeishuSourceSchema>;
export type FeishuSourceList = z.infer<typeof FeishuSourceListResponseSchema>;
export type FeishuSourceStatus = z.infer<typeof FeishuSourceStatusSchema>;
export type FeishuAvailableChat = z.infer<typeof FeishuAvailableChatSchema>;
export type FeishuAvailableChats = z.infer<typeof FeishuAvailableChatsResponseSchema>;
export type FeishuMessage = z.infer<typeof FeishuMessageSchema>;
export type FeishuMessageList = z.infer<typeof FeishuMessageListResponseSchema>;
export type FeishuMessageOutcome = z.infer<typeof FeishuMessageOutcomeSchema>;
export type FeishuChat = z.infer<typeof FeishuChatSchema>;
export type FeishuChatList = z.infer<typeof FeishuChatListResponseSchema>;
export type FeishuProposal = z.infer<typeof FeishuProposalSchema>;
export type FeishuProposalList = z.infer<typeof FeishuProposalListResponseSchema>;

/** Fail-closed fallback: an unparseable endpoint list reads as "nothing is
 *  configured", which renders the operator-setup hint rather than pretending a
 *  connection is reachable. */
export const EMPTY_FEISHU_ENDPOINT_LIST: FeishuEndpointList = { configured: false, endpoints: [] };
export const EMPTY_FEISHU_SOURCE_LIST: FeishuSourceList = { sources: [], total: 0 };
export const EMPTY_FEISHU_MESSAGE_LIST: FeishuMessageList = {
  messages: [], total: 0, limit: 0, offset: 0, hasMore: false,
};
export const EMPTY_FEISHU_CHAT_LIST: FeishuChatList = { chats: [], total: 0 };
export const EMPTY_FEISHU_PROPOSAL_LIST: FeishuProposalList = {
  proposals: [], total: 0, limit: 0, offset: 0, hasMore: false,
};
export const EMPTY_FEISHU_AVAILABLE_CHATS: FeishuAvailableChats = { chats: [], total: 0, limit: 0 };
