import type { Hono, MiddlewareHandler } from "hono";
import {
  denyCurrentUserWorkspaceAccess,
  readJson,
  safeJoinCloudWaitlist,
  safeNoRuntimeOnboardingBootstrap,
  safeRuntimeOnboardingBootstrap,
  safeUpdateCurrentUser,
  setAuthCookie,
} from "../helpers.js";
import {
  currentRequestUserId,
} from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

export function registerMeRoutes(app: Hono, deps: RouterDeps): void {
  const { store, authToken } = deps;
  const requireKnownUser: MiddlewareHandler = async (c, next) => {
    const userId = currentRequestUserId(c);
    if (userId !== "local" && !store.getUser(userId)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  app.use("/api/me", requireKnownUser);
  app.use("/api/me/*", requireKnownUser);

  app.get("/api/me", (c) => {
    const userId = currentRequestUserId(c);
    const user = userId === "local" ? store.getCurrentUser() : store.getUser(userId);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    // Sessions that predate cookie auth carry only the localStorage token.
    // The app calls /api/me on boot with the Bearer header (already verified
    // by the auth gate), so mirror it into the cookie — existing logins get
    // working <img> loads without re-authenticating. Never mirror the master
    // token: it is a non-expiring deployment-wide admin secret, and an
    // ambient host-wide cookie would broaden its exposure for no benefit.
    const header = c.req.header("Authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (bearer && bearer !== authToken) setAuthCookie(c, bearer);
    return c.json(user);
  });
  app.patch("/api/me", async (c) => {
    const body = await readJson<any>(c);
    const result = safeUpdateCurrentUser(store, body, currentRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.patch("/api/me/onboarding", async (c) => {
    const body = await readJson<{ questionnaire?: Record<string, unknown>; onboarding_questionnaire?: Record<string, unknown> }>(c);
    return c.json(store.patchCurrentUserOnboarding(body.questionnaire ?? body.onboarding_questionnaire ?? {}, currentRequestUserId(c)));
  });
  app.post("/api/me/onboarding/complete", (c) => c.json(store.markCurrentUserOnboarded(currentRequestUserId(c))));
  app.post("/api/me/onboarding/cloud-waitlist", async (c) => {
    const body = await readJson<{ email?: string; reason?: string }>(c);
    const result = safeJoinCloudWaitlist(body, store, currentRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.post("/api/me/onboarding/runtime-bootstrap", async (c) => {
    const body = await readJson<{ workspace_id?: string; workspaceId?: string; runtime_id?: string; runtimeId?: string }>(c);
    const workspaceId = body.workspace_id ?? body.workspaceId ?? "";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const result = safeRuntimeOnboardingBootstrap(store, body, currentRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.post("/api/me/onboarding/no-runtime-bootstrap", async (c) => {
    const body = await readJson<{ workspace_id?: string; workspaceId?: string }>(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspace_id ?? body.workspaceId ?? "");
    if (denied) return denied;
    const result = safeNoRuntimeOnboardingBootstrap(store, body, currentRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
}
