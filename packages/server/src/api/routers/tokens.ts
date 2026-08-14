import type { Hono } from "hono";
import {
  denyCurrentUserWorkspaceAccess,
  isTaskTokenCreateInput,
  readJson,
  requireWorkspaceAdmin,
  workspaceIdFromSlugHeader,
} from "../helpers.js";
import {
  authenticatedRequestUserId,
  currentAccessToken,
} from "../wire/index.js";
import type {
  CreateAccessTokenInput,
  MultiremiAccessToken,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

function personalTokenResponse(token: MultiremiAccessToken & { token?: string }) {
  return {
    id: token.id,
    name: token.name,
    token_prefix: token.tokenPrefix,
    expires_at: token.expiresAt,
    last_used_at: token.lastUsedAt,
    created_at: token.createdAt,
    ...(token.token ? { token: token.token } : {}),
  };
}

export function registerTokenRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/tokens", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const tokens = store.listAccessTokens(workspaceId);
    return c.json({ tokens, total: tokens.length });
  });
  app.post("/api/multiremi/tokens", async (c) => {
    const body = await readJson<CreateAccessTokenInput>(c);
    if (isTaskTokenCreateInput(body)) return c.json({ error: "task tokens are minted by daemon task claim" }, 400);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    return c.json({ token: await store.createAccessToken(body) }, 201);
  });
  app.delete("/api/multiremi/tokens/:id", (c) => {
    const current = store.getAccessToken(c.req.param("id"));
    if (!current) return c.json({ error: "token not found" }, 404);
    const denied = requireWorkspaceAdmin(c, store, current.workspaceId);
    if (denied) return denied;
    const token = store.revokeAccessToken(current.id);
    return c.json({ token, ok: true });
  });

  app.get("/api/tokens", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = authenticatedRequestUserId(c);
    const tokens = userId
      ? store.listPersonalAccessTokens(workspaceId, userId)
      : store.listAccessTokens(workspaceId).filter((token) => (
        token.type === "pat" &&
        token.purpose === "personal" &&
        !token.revokedAt &&
        (!token.expiresAt || Date.parse(token.expiresAt) > Date.now())
      ));
    return c.json(tokens.map(personalTokenResponse));
  });
  app.post("/api/tokens", async (c) => {
    const body = await readJson<CreateAccessTokenInput>(c);
    if (isTaskTokenCreateInput(body)) return c.json({ error: "task tokens are minted by daemon task claim" }, 400);
    // The dashboard "add computer" dialog posts no workspace in the body; fall
    // back to the X-Workspace-Slug header the web client sends on every request,
    // so the token is minted (and access-checked) for the workspace the user is
    // actually in — not the "local" default they may not be a member of.
    const workspaceId = body.workspaceId ?? body.workspace_id ?? workspaceIdFromSlugHeader(c, store) ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    // A human requester always mints for themselves: bind the token to the
    // resolved workspace and their own user id, so they can't mint a user-less
    // "local" admin credential. Master token / open mode keeps body semantics.
    const userId = authenticatedRequestUserId(c);
    const purpose = body.purpose === "cli" ? "cli" : "personal";
    const input = userId
      ? { ...body, workspaceId, userId, type: "pat", purpose }
      : { ...body, workspaceId, type: "pat", purpose };
    return c.json(personalTokenResponse(await store.createAccessToken(input)), 201);
  });
  app.post("/api/tokens/current/renew", async (c) => {
    const current = currentAccessToken(c);
    if (current) {
      const authHeader = c.req.header("Authorization") ?? "";
      const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
      if (current.type !== "pat" || !rawToken.startsWith("mul_")) {
        return c.json({ error: "only personal access tokens can be renewed" }, 400);
      }
      const renewal = await store.renewAccessTokenExpiry(current.id, { thresholdDays: 7, extensionDays: 90 });
      if (!renewal) return c.json({ error: "token is no longer valid" }, 401);
      return c.json({
        ...(renewal.rawToken ? { access_token: renewal.rawToken, token_type: "bearer" } : {}),
        expires_at: renewal.token.expiresAt ?? "",
        renewed: renewal.renewed,
      });
    }

    const body = await readJson<Partial<CreateAccessTokenInput>>(c);
    const token = await store.createAccessToken({
      workspaceId: body.workspaceId ?? body.workspace_id ?? "local",
      name: body.name ?? "Renewed local token",
      type: body.type ?? "pat",
      expiresInDays: body.expiresInDays ?? body.expires_in_days ?? 30,
    });
    return c.json({
      ...token,
      access_token: token.token,
      token_type: "bearer",
    }, 201);
  });
  app.delete("/api/tokens/:id", (c) => {
    const token = store.getAccessToken(c.req.param("id"));
    if (!token) return c.json({ error: "token not found" }, 404);
    const userId = authenticatedRequestUserId(c);
    if (
      userId &&
      (token.userId !== userId || token.type !== "pat" || token.purpose !== "personal")
    ) {
      return c.json({ error: "token not found" }, 404);
    }
    store.revokeAccessToken(token.id);
    return c.body(null, 204);
  });
}
