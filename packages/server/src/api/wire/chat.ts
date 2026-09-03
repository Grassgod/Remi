// Wire serializers for the chat domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import type {
  MultiremiAttachment,
  MultiremiChatMessage,
  MultiremiChatSession,
  MultiremiInboxItem,
  SendChatMessageResult,
} from "@multiremi/contracts/types.js";
import { chatAttachmentCompatibilityResponse } from "./attachments.js";

export function chatSessionCompatibilityResponse(session: MultiremiChatSession): {
  id: string;
  workspace_id: string;
  creator_id: string;
  agent_id: string;
  issue_id: string | null;
  title: string;
  status: string;
  has_unread: boolean;
  created_at: string;
  updated_at: string;
} {
  return {
    id: session.id,
    workspace_id: session.workspaceId,
    agent_id: session.agentId,
    issue_id: session.issueId,
    creator_id: session.creatorId ?? "local",
    title: session.title,
    status: session.status,
    has_unread: session.hasUnread,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

export function chatMessageCompatibilityResponse(message: MultiremiChatMessage, attachments: MultiremiAttachment[] = []): {
  id: string;
  chat_session_id: string;
  role: string;
  content: string;
  task_id: string | null;
  created_at: string;
  failure_reason: string | null;
  elapsed_ms: number | null;
  attachments?: Record<string, unknown>[];
} {
  const response: {
    id: string;
    chat_session_id: string;
    role: string;
    content: string;
    task_id: string | null;
    created_at: string;
    failure_reason: string | null;
    elapsed_ms: number | null;
    attachments?: Record<string, unknown>[];
  } = {
    id: message.id,
    chat_session_id: message.chatSessionId,
    role: message.role,
    content: message.body,
    task_id: message.taskId,
    created_at: message.createdAt,
    failure_reason: message.failureReason,
    elapsed_ms: message.elapsedMs,
  };
  if (attachments.length) response.attachments = attachments.map(chatAttachmentCompatibilityResponse);
  return response;
}

export function sendChatMessageCompatibilityResponse(result: SendChatMessageResult): {
  message_id: string;
  task_id: string;
  created_at: string;
} {
  return {
    message_id: result.message.id,
    task_id: result.task.id,
    created_at: result.task.createdAt,
  };
}

export function inboxCompatibilityResponse(item: MultiremiInboxItem): MultiremiInboxItem & {
  workspace_id: string;
  issue_id: string | null;
  member_id: string;
  recipient_type: string;
  recipient_id: string;
  actor_type: string;
  actor_id: string | null;
  severity: string;
  details: unknown | null;
  created_at: string;
} {
  return {
    ...item,
    workspace_id: item.workspaceId,
    issue_id: item.issueId,
    member_id: item.memberId,
    recipient_type: item.recipientType,
    recipient_id: item.recipientId,
    actor_type: item.actorType,
    actor_id: item.actorId,
    severity: item.severity,
    details: item.details,
    created_at: item.createdAt,
  };
}
