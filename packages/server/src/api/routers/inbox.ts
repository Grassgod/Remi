import type { Hono } from "hono";
import {
  compatibilityInboxScope,
} from "../helpers.js";
import {
  inboxCompatibilityResponse,
} from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

export function registerInboxRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;
  app.get("/api/inbox", (c) => {
    const scope = compatibilityInboxScope(c, store);
    if (scope instanceof Response) return scope;
    return c.json(store.listInboxItems(scope.memberId, scope.workspaceId).map(inboxCompatibilityResponse));
  });
}
