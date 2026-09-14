import type { Context } from "hono";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { authenticatedRequestUserId, cleanString, currentAccessToken } from "../wire/context.js";

export function resolveDefaultWorkspaceIdForUser(store: MultiremiStore, userId: string): string {
  const memberships = store.listWorkspaceMembers().filter((member) =>
    member.userId === userId
    || member.id === userId
    || member.id === `mem_${member.workspaceId}_${userId}`
  );
  memberships.sort((left, right) =>
    Number(right.role === "owner") - Number(left.role === "owner")
    || left.createdAt.localeCompare(right.createdAt)
    || left.workspaceId.localeCompare(right.workspaceId)
    || left.id.localeCompare(right.id)
  );
  return memberships[0]?.workspaceId ?? "local";
}

/** Resolve request context only; callers must authorize this same ID before using it. */
export function resolveRequestWorkspaceId(
  c: Context,
  store: MultiremiStore,
  explicitId?: string | null,
): string | Response {
  const id = cleanString(explicitId) ?? cleanString(c.req.header("X-Workspace-ID"));
  if (id) return id;
  const slug = cleanString(c.req.header("X-Workspace-Slug"));
  if (slug) {
    const workspace = store.listWorkspaces().find((candidate) => candidate.slug === slug);
    return workspace?.id ?? c.json({ error: "workspace not found" }, 404);
  }
  const token = currentAccessToken(c);
  if (token && store.getUserRoleInWorkspace(token.userId, token.workspaceId) !== null) {
    return token.workspaceId;
  }
  const userId = token?.userId ?? authenticatedRequestUserId(c);
  return userId ? resolveDefaultWorkspaceIdForUser(store, userId) : "local";
}
