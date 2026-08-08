// Chat session request plumbing: workspace resolution and the create/send input builders that fold
// in the caller. The session and agent access guards live in ./auth-guards.ts.
import type { Context } from "hono";
import { MultiremiStore } from "@multiremi/store/store.js";
import { cleanString, currentRequestUserId } from "../wire/index.js";
import type { CreateChatSessionInput, SendChatMessageInput } from "@multiremi/contracts/types.js";
import { canCurrentUserAccessAgent, denyCurrentUserWorkspaceAccess } from "./auth-guards.js";
import { uniqueStrings } from "./common.js";

export function withChatSessionCreator(
  c: Context,
  input: CreateChatSessionInput,
): CreateChatSessionInput {
  const creatorId = currentRequestUserId(c);
  return { ...input, creatorId, creator_id: creatorId };
}

export function requestedChatWorkspaceId(c: Context, input?: Pick<CreateChatSessionInput, "workspaceId" | "workspace_id">): string {
  return cleanString(input?.workspaceId) ??
    cleanString(input?.workspace_id) ??
    cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id")) ??
    "local";
}

export function withChatSessionRequestContext(c: Context, store: MultiremiStore, input: CreateChatSessionInput): CreateChatSessionInput | Response {
  const workspaceId = requestedChatWorkspaceId(c, input);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const agentId = cleanString(input.agentId ?? input.agent_id);
  if (!agentId) return c.json({ error: "agent_id is required" }, 400);
  const agent = store.getAgent(agentId);
  if (!agent || agent.workspaceId !== workspaceId) return c.json({ error: "agent not found" }, 404);
  if (!canCurrentUserAccessAgent(c, store, agent)) {
    return c.json({ error: "you do not have access to this agent" }, 403);
  }
  return withChatSessionCreator(c, { ...input, workspaceId, workspace_id: workspaceId });
}

export function normalizeSendChatMessageInput(c: Context, input: SendChatMessageInput): SendChatMessageInput | Response {
  const body = cleanString(input.body ?? input.content);
  if (!body) return c.json({ error: "content is required" }, 400);
  const rawAttachmentIds = input.attachmentIds ?? input.attachment_ids;
  if (rawAttachmentIds != null && !Array.isArray(rawAttachmentIds)) {
    return c.json({ error: "invalid attachment_ids" }, 400);
  }
  const attachmentIds = rawAttachmentIds ? uniqueStrings(rawAttachmentIds) : [];
  return { ...input, body, attachmentIds, attachment_ids: attachmentIds };
}
