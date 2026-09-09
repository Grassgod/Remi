import type { Context } from "hono";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { cleanString, currentAccessToken } from "../wire/context.js";

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
  return currentAccessToken(c)?.workspaceId ?? "local";
}
