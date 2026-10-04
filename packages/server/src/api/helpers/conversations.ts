import type { Context } from "hono";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { denyCurrentUserWorkspaceAccess, loadChatSessionForCurrentUser } from "./auth-guards.js";
import { currentTaskAccessToken, currentWorkspaceMember } from "../wire/context.js";
import type { SendMessageInput } from "@multiremi/contracts/unified-model.js";

export function loadConversation(c: Context, store: MultiremiStore, id: string) {
  const session = store.getIssueSession(id);
  if (session) return denyCurrentUserWorkspaceAccess(c, store, session.workspaceId)
    ?? { id, workspaceId: session.workspaceId, issueId: session.issueId, chatId: null };
  if (id.startsWith("auto_orphan_inbox_")) {
    const workspaceId = id.slice("auto_orphan_inbox_".length);
    if (!store.getWorkspace(workspaceId) || !store.getConversationLogHead(id)) return c.json({ error: "conversation not found" }, 404);
    return denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? { id, workspaceId, issueId: null, chatId: null };
  }
  if (id.startsWith("auto_")) {
    const auto = store.getAutopilot(id.slice(5));
    if (!auto) return c.json({ error: "conversation not found" }, 404);
    return denyCurrentUserWorkspaceAccess(c, store, auto.workspaceId)
      ?? { id, workspaceId: auto.workspaceId, issueId: null, chatId: null };
  }
  const chat = loadChatSessionForCurrentUser(c, store, id);
  return chat instanceof Response ? chat
    : { id, workspaceId: chat.session.workspaceId, issueId: null, chatId: id };
}

export function messageActor(c: Context, store: MultiremiStore, workspaceId: string): SendMessageInput["sender"] | Response {
  const token = currentTaskAccessToken(c);
  if (token) {
    const agent = token.agentId ? store.getAgent(token.agentId) : null;
    if (!agent || agent.archivedAt || agent.workspaceId !== workspaceId) return c.json({ error: "agent not found" }, 404);
    return { type: "agent", id: agent.id };
  }
  const member = currentWorkspaceMember(c, store, workspaceId);
  return member && !member.archivedAt ? { type: "member", id: member.id }
    : c.json({ error: "active workspace member required" }, 403);
}

export function messageResponse<T extends { card_token_hash?: unknown; card_token_recipient?: unknown; card_token_consumed_at?: unknown }>(message: T) {
  const { card_token_hash, card_token_recipient, card_token_consumed_at, ...publicMessage } = message;
  return publicMessage;
}
