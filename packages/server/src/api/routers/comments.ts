import type { Hono } from "hono";
import {
  denyCurrentUserWorkspaceAccess,
  denyCurrentUserCommentAccess,
  isJsonApiError,
  normalizeReactionInput,
  readJson,
  readJsonStrict,
  readJsonStrictAllowEmpty,
} from "../helpers.js";
import {
  commentCompatibilityResponse,
  commentReactionCompatibilityResponse,
  issueCommentMutationErrorResponse,
} from "../wire/index.js";
import type {
  CreateMultiremiReactionInput,
  UpdateIssueCommentInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerCommentRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.put("/api/multiremi/comments/:id", async (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJson<UpdateIssueCommentInput>(c);
    return c.json({ comment: store.updateIssueComment(c.req.param("id"), body) });
  });
  app.patch("/api/multiremi/comments/:id", async (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJson<UpdateIssueCommentInput>(c);
    return c.json({ comment: store.updateIssueComment(c.req.param("id"), body) });
  });
  app.delete("/api/multiremi/comments/:id", (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    store.deleteIssueComment(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/multiremi/comments/:id/resolve", async (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJson<{ actorType?: string; actor_type?: string; actorId?: string | null; actor_id?: string | null }>(c);
    return c.json({
      comment: store.resolveIssueComment(c.req.param("id"), {
        actorType: body.actorType ?? body.actor_type,
        actorId: body.actorId ?? body.actor_id,
      }),
    });
  });
  app.delete("/api/multiremi/comments/:id/resolve", (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    return c.json({ comment: store.unresolveIssueComment(c.req.param("id")) });
  });
  app.put("/api/comments/:id", async (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJsonStrict<UpdateIssueCommentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(commentCompatibilityResponse(store.updateIssueComment(c.req.param("id"), body)));
    } catch (error) {
      return issueCommentMutationErrorResponse(c, error);
    }
  });
  app.delete("/api/comments/:id", (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    try {
      store.deleteIssueComment(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return issueCommentMutationErrorResponse(c, error);
    }
  });
  app.post("/api/comments/:id/resolve", async (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJsonStrictAllowEmpty<{ actorType?: string; actor_type?: string; actorId?: string | null; actor_id?: string | null }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(commentCompatibilityResponse(store.resolveIssueComment(c.req.param("id"), {
        actorType: body.actorType ?? body.actor_type,
        actorId: body.actorId ?? body.actor_id,
      })));
    } catch (error) {
      return issueCommentMutationErrorResponse(c, error);
    }
  });
  app.delete("/api/comments/:id/resolve", (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    try {
      return c.json(commentCompatibilityResponse(store.unresolveIssueComment(c.req.param("id"))));
    } catch (error) {
      return issueCommentMutationErrorResponse(c, error);
    }
  });
  app.post("/api/comments/:id/reactions", async (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJsonStrict<CreateMultiremiReactionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = normalizeReactionInput(body);
    if (!input.emoji) return c.json({ error: "emoji is required" }, 400);
    return c.json(commentReactionCompatibilityResponse(store.addCommentReaction(c.req.param("id"), input)), 201);
  });
  app.delete("/api/comments/:id/reactions", async (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJsonStrict<CreateMultiremiReactionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = normalizeReactionInput(body);
    if (!input.emoji) return c.json({ error: "emoji is required" }, 400);
    store.removeCommentReaction(c.req.param("id"), input);
    return c.body(null, 204);
  });

  app.get("/api/multiremi/comments/:id/reactions", (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    return c.json({ reactions: store.listCommentReactions(c.req.param("id")) });
  });
  app.post("/api/multiremi/comments/:id/reactions", async (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJson<CreateMultiremiReactionInput>(c);
    return c.json({ reaction: store.addCommentReaction(c.req.param("id"), normalizeReactionInput(body)) }, 201);
  });
  app.delete("/api/multiremi/comments/:id/reactions", async (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJson<CreateMultiremiReactionInput>(c);
    store.removeCommentReaction(c.req.param("id"), normalizeReactionInput(body));
    return c.json({ ok: true });
  });
  app.get("/api/multiremi/comments/:id/attachments", (c) => {
    const denied = denyCurrentUserCommentAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const comment = store.getIssueComment(c.req.param("id"));
    if (!comment) return c.json({ attachments: [] });
    const issue = store.getIssue(comment.issueId);
    if (issue) {
      const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
      if (denied) return denied;
    }
    return c.json({ attachments: store.listAttachmentsForComment(comment.id) });
  });
}
