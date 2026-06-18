/**
 * HTTP shell (Hono). Mirrors the Go Chi router's surface incrementally.
 * For now: health + JWT auth middleware + /api/me. Handlers land in Chunk 5.
 */

import { Hono } from "hono";
import { verifyJWT } from "../auth/jwt.js";
import { loadConfig, type Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { AppEnv } from "./types.js";
import { authRoutes } from "./routes/auth.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { issueRoutes } from "./routes/issues.js";
import { projectRoutes } from "./routes/projects.js";
import { memberRoutes } from "./routes/members.js";
import { labelRoutes } from "./routes/labels.js";
import { commentRoutes } from "./routes/comments.js";
import { agentRoutes } from "./routes/agents.js";
import { inboxRoutes } from "./routes/inbox.js";
import { runtimeRoutes } from "./routes/runtimes.js";
import { skillRoutes } from "./routes/skills.js";
import { squadRoutes } from "./routes/squads.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { pinRoutes } from "./routes/pins.js";
import { githubRoutes } from "./routes/github.js";
import { activityRoutes } from "./routes/activity.js";
import { notificationRoutes } from "./routes/notifications.js";
import { searchRoutes } from "./routes/search.js";
import { upgradeWebSocket } from "./ws.js";
import { bus } from "../realtime/bus.js";
import { attachClient } from "../realtime/hub.js";
import { reactionRoutes } from "./routes/reactions.js";
import { autopilotRoutes } from "./routes/autopilots.js";
import { chatRoutes } from "./routes/chat.js";
import { patRoutes } from "./routes/pat.js";
import { daemonTaskRoutes } from "./routes/daemontasks.js";
import { larkRoutes } from "./routes/lark.js";
import { githubWebhookRoutes } from "./routes/githubWebhook.js";
import { autopilotWebhookRoutes } from "./routes/autopilotWebhook.js";
import { invitationRoutes } from "./routes/invitations.js";
import { agentEnvRoutes } from "./routes/agentEnv.js";
import { issueMetadataRoutes } from "./routes/issueMetadata.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { subscriberRoutes } from "./routes/subscribers.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { webhookDeliveryRoutes } from "./routes/webhookDeliveries.js";
import { agentSkillRoutes } from "./routes/agentSkills.js";
import { skillFileRoutes } from "./routes/skillFiles.js";
import { agentTemplateRoutes } from "./routes/agentTemplates.js";
import { meRoutes } from "./routes/me.js";
import { configRoutes } from "./routes/config.js";
import { latencyRoutes } from "./routes/latency.js";
import { remiInstallRoutes } from "./routes/remiInstall.js";
import { miscRoutes } from "./routes/misc.js";
import { issueExtrasRoutes } from "./routes/issueExtras.js";
import { issueTasksRoutes } from "./routes/issueTasks.js";
import { agentTaskListsRoutes } from "./routes/agentTaskLists.js";
import { squadMembersRoutes } from "./routes/squadMembers.js";
import { projectResourcesRoutes } from "./routes/projectResources.js";
import { larkInstallationsRoutes } from "./routes/larkInstallations.js";
import { autopilotActionsRoutes } from "./routes/autopilotActions.js";
import { workspaceAdminRoutes } from "./routes/workspaceAdmin.js";
import { runtimeAdminRoutes } from "./routes/runtimeAdmin.js";
import { commentActionsRoutes } from "./routes/commentActions.js";
import { miscActionsRoutes } from "./routes/miscActions.js";
import { chatDepthRoutes } from "./routes/chatDepth.js";
import { larkBindingRoutes } from "./routes/larkBinding.js";
import { getWorkspaceBySlug } from "../db/queries/workspace.js";
import {
  getPersonalAccessTokenByHash,
  hashPatToken,
  touchPatLastUsed,
} from "../db/queries/pat.js";

/** Extract the bearer token from the Authorization header or the auth cookie. */
function bearerFrom(c: { req: { header: (k: string) => string | undefined } }): string | undefined {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const cookie = c.req.header("Cookie");
  const m = cookie?.match(/(?:^|;\s*)multimira_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(cfg: Config = loadConfig(), db?: Db): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Realtime WS. Auth is via query params (browsers can't set headers on the
  // upgrade): ?token=<jwt>&workspace_id=<uuid>. Mounted before the /api/* gate.
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      let detach: (() => void) | undefined;
      return {
        async onOpen(_evt, ws) {
          const token = c.req.query("token");
          const workspaceId = c.req.query("workspace_id");
          if (!token || !workspaceId || !UUID_RE.test(workspaceId)) {
            ws.close(1008, "unauthorized");
            return;
          }
          try {
            await verifyJWT(token, cfg.jwtSecret);
          } catch {
            ws.close(1008, "invalid token");
            return;
          }
          detach = attachClient(bus, workspaceId, { send: (d) => ws.send(d) });
        },
        onClose() {
          detach?.();
        },
      };
    }),
  );

  // Public auth routes (Feishu SSO). Mounted before the /api/* gate.
  app.route("/", authRoutes(cfg, db));
  // Public app config (read at frontend boot, before login).
  app.route("/", configRoutes());
  // Public UI latency probe. Mounted before the /api/* gate so login and
  // bootstrap screens can measure the current origin too.
  app.route("/", latencyRoutes());
  // Public Remi daemon installer + release assets for self-host deployments.
  app.route("/", remiInstallRoutes());
  // Public Feishu inbound webhook (Feishu calls it without a JWT).
  app.route("/lark", larkRoutes(db));
  // Public provider-signed inbound webhooks. These declare absolute
  // /api/webhooks/* paths but are mounted BEFORE the /api/* JWT gate so the
  // external caller (GitHub / an autopilot webhook source) reaches them
  // without a token; each verifies its own HMAC signature instead.
  app.route("/", githubWebhookRoutes(db));
  app.route("/", autopilotWebhookRoutes(db));

  // Auth gate for /api/* (cookie or bearer).
  app.use("/api/*", async (c, next) => {
    const token = bearerFrom(c);
    if (!token) return c.json({ error: "unauthorized" }, 401);

    // Personal access tokens ("mul_") authenticate the remote daemon over HTTP
    // (no DB credentials on the daemon side). Branch strictly on the prefix so
    // JWT requests never pay the extra DB lookup. PATs are user-scoped: the
    // workspace is still resolved from X-Workspace-ID + the membership check in
    // each route gate. Mirrors server/internal/middleware/daemon_auth.go.
    if (token.startsWith("mul_")) {
      if (!db) return c.json({ error: "database not configured" }, 503);
      const pat = await getPersonalAccessTokenByHash(db, hashPatToken(token));
      if (!pat) return c.json({ error: "invalid token" }, 401);
      c.set("user", { sub: pat.userId, email: "", name: "" });
      // Refresh last_used_at without blocking the request.
      void touchPatLastUsed(db, pat.id).catch(() => {});
      return next();
    }

    let claims;
    try {
      claims = await verifyJWT(token, cfg.jwtSecret);
    } catch {
      return c.json({ error: "invalid token" }, 401);
    }
    // Validate the subject UUID at the boundary so a malformed `sub` can never
    // reach a uuid-typed DB column and 500 (mirrors the Go UUID-parsing
    // convention; see server/CLAUDE.md + incident #1661).
    if (!claims.sub || !UUID_RE.test(claims.sub)) {
      return c.json({ error: "invalid token subject" }, 401);
    }
    c.set("user", claims);
    return next();
  });

  // Workspace context: the web/desktop clients identify the workspace by an
  // X-Workspace-Slug header (sent on every request) or a workspace_id query
  // param — NOT always the X-Workspace-ID header the route gates read. Resolve
  // the canonical UUID here so those gates can fall back to c.get("wsId").
  if (db) {
    app.use("/api/*", async (c, next) => {
      if (!c.req.header("X-Workspace-ID")) {
        const slug = c.req.header("X-Workspace-Slug");
        const qid = c.req.query("workspace_id");
        if (slug) {
          const ws = await getWorkspaceBySlug(db, slug);
          if (ws) c.set("wsId", ws.id);
        } else if (qid && UUID_RE.test(qid)) {
          c.set("wsId", qid);
        }
      }
      return next();
    });
  }

  app.route("/", meRoutes(db));
  app.route("/api/workspaces", workspaceRoutes(db));
  app.route("/api/issues", issueRoutes(db));
  app.route("/api/issues/:id/comments", commentRoutes(db));
  app.route("/api/projects", projectRoutes(db));
  app.route("/api/labels", labelRoutes(db));
  app.route("/api/agents", agentRoutes(db));
  app.route("/api/inbox", inboxRoutes(db));
  app.route("/api/runtimes", runtimeRoutes(db));
  app.route("/api/skills", skillRoutes(db));
  app.route("/api/squads", squadRoutes(db));
  app.route("/api/attachments", attachmentRoutes(db));
  app.route("/api/pins", pinRoutes(db));
  app.route("/api/activity", activityRoutes(db));
  app.route("/api/notification-preferences", notificationRoutes(db));
  app.route("/api/search", searchRoutes(db));
  app.route("/api/issues/:id/reactions", reactionRoutes(db));
  app.route("/api/autopilots", autopilotRoutes(db));
  app.route("/api/chat", chatRoutes(db));
  app.route("/api/personal-access-tokens", patRoutes(db));
  app.route("/api/dashboard", dashboardRoutes(db));
  app.route("/api/agent-templates", agentTemplateRoutes());
  // daemonTaskRoutes declares absolute /api/* paths (heartbeat/claim/report).
  app.route("/api", daemonTaskRoutes(db));
  // These factories declare absolute /api/* paths → mount at root.
  app.route("/", memberRoutes(db));
  app.route("/", githubRoutes(db));
  app.route("/", invitationRoutes(db));
  app.route("/", agentEnvRoutes(db));
  app.route("/", issueMetadataRoutes(db));
  app.route("/", subscriberRoutes(db));
  app.route("/", onboardingRoutes(db));
  app.route("/", miscRoutes(db));
  app.route("/", webhookDeliveryRoutes(db));
  app.route("/", agentSkillRoutes(db));
  app.route("/", skillFileRoutes(db));
  app.route("/", issueExtrasRoutes(db));
  app.route("/", issueTasksRoutes(db));
  app.route("/", agentTaskListsRoutes(db));
  app.route("/", squadMembersRoutes(db));
  app.route("/", projectResourcesRoutes(db));
  app.route("/", larkInstallationsRoutes(db));
  app.route("/", autopilotActionsRoutes(db));
  app.route("/", workspaceAdminRoutes(db));
  app.route("/", runtimeAdminRoutes(db));
  app.route("/", commentActionsRoutes(db));
  app.route("/", miscActionsRoutes(db));
  app.route("/", chatDepthRoutes(db));
  app.route("/", larkBindingRoutes(db));

  return app;
}
