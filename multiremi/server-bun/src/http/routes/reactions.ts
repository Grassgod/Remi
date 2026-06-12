/**
 * Issue reaction routes (write path) — port of the Go issue_reaction handler's
 * POST /api/issues/{id}/reactions (add) and DELETE /api/issues/{id}/reactions
 * (remove). Behind the /api/* JWT gate; scoped to a workspace via the
 * X-Workspace-ID header + a membership check (multi-tenancy). The issue in the
 * path is resolved within the workspace first (loadIssueForUser equivalent).
 *
 * Mounted at /api/issues/:id/reactions, so the issue identifier is available via
 * c.req.param("id") (the parent mount path's param survives into these handlers).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Issue } from "../../db/schema.js";
import { getIssueByIdentifier, getMembership } from "../../db/queries/issues.js";
import { getAgent } from "../../db/queries/comments.js";
import {
  addIssueReaction,
  removeIssueReaction,
  type IssueReaction,
} from "../../db/queries/reactions.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors the Go IssueReactionResponse struct (snake_case JSON). */
function reactionToResponse(r: IssueReaction) {
  return {
    id: r.id,
    issue_id: r.issueId,
    actor_type: r.actorType,
    actor_id: r.actorId,
    emoji: r.emoji,
    created_at: r.createdAt,
  };
}

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID, or a Response to short-circuit with (400 missing/malformed
 * header, 404 not-a-member — mirrors the Go workspace-member gate).
 */
async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

/**
 * Resolve the issue in the path within the workspace (loadIssueForUser
 * equivalent). Returns the issue or a 404 Response.
 */
async function requireIssue(c: Context<AppEnv>, db: Db, wsId: string): Promise<Issue | Response> {
  // The issue identifier comes from the parent mount path (/api/issues/:id/...),
  // so Hono types it as possibly undefined here.
  const idParam = c.req.param("id") ?? "";
  const found = await getIssueByIdentifier(db, wsId, idParam);
  if (!found) return c.json({ error: "issue not found" }, 404);
  return found;
}

/**
 * Determine the actor identity for the reaction: agent (via X-Agent-ID,
 * validated against the workspace and a present X-Task-ID) or member. Mirrors
 * Go resolveActor's read-path subset — without task-token trust or the
 * X-Task-ID/agent cross-validation that depends on the agent_task subsystem not
 * ported here. The agent must exist in the request's workspace, otherwise we
 * fall back to member.
 */
async function resolveActor(
  c: Context<AppEnv>,
  db: Db,
  userId: string,
  wsId: string,
): Promise<{ actorType: string; actorId: string }> {
  const agentId = c.req.header("X-Agent-ID");
  if (!agentId || !UUID_RE.test(agentId)) {
    return { actorType: "member", actorId: userId };
  }
  // An agent identity is only trusted when accompanied by a task context.
  if (!c.req.header("X-Task-ID")) {
    return { actorType: "member", actorId: userId };
  }
  const a = await getAgent(db, agentId);
  if (!a || a.workspaceId !== wsId) {
    return { actorType: "member", actorId: userId };
  }
  return { actorType: "agent", actorId: agentId };
}

/** Parse the request body and pull a non-empty `emoji`. */
async function readEmoji(c: Context<AppEnv>): Promise<{ emoji: string } | Response> {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid request body" }, 400);
  }
  const emoji = typeof body.emoji === "string" ? body.emoji : "";
  if (!emoji) return c.json({ error: "emoji is required" }, 400);
  return { emoji };
}

export function reactionRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const issue = await requireIssue(c, db, ws);
    if (issue instanceof Response) return issue;

    const parsed = await readEmoji(c);
    if (parsed instanceof Response) return parsed;

    const { actorType, actorId } = await resolveActor(c, db, c.get("user").sub, ws);
    const reaction = await addIssueReaction(db, {
      issueId: issue.id,
      workspaceId: ws,
      actorType,
      actorId,
      emoji: parsed.emoji,
    });

    bus.publish({
      type: "issue_reaction:added",
      workspaceId: ws,
      payload: { issue_id: issue.id, emoji: parsed.emoji, actor_type: actorType, actor_id: actorId },
    });
    return c.json(reactionToResponse(reaction), 201);
  });

  r.delete("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const issue = await requireIssue(c, db, ws);
    if (issue instanceof Response) return issue;

    const parsed = await readEmoji(c);
    if (parsed instanceof Response) return parsed;

    const { actorType, actorId } = await resolveActor(c, db, c.get("user").sub, ws);
    await removeIssueReaction(db, issue.id, actorType, actorId, parsed.emoji);

    bus.publish({
      type: "issue_reaction:removed",
      workspaceId: ws,
      payload: { issue_id: issue.id, emoji: parsed.emoji, actor_type: actorType, actor_id: actorId },
    });
    return c.body(null, 204);
  });

  return r;
}
