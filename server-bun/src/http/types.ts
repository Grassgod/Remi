import type { AuthClaims } from "../auth/jwt.js";

/**
 * Hono env. `user` is set by the /api/* JWT middleware. `wsId` is the workspace
 * UUID resolved by the workspace-context middleware from an X-Workspace-Slug
 * header or a workspace_id query param (the frontend sends the slug header on
 * every request); route gates fall back to it when no X-Workspace-ID header is
 * present.
 */
export type AppEnv = { Variables: { user: AuthClaims; wsId?: string } };
