/**
 * GET /api/config — public app config read at frontend boot (port of Go
 * GetConfig). Feature flags + integration keys from env; matches the frontend
 * AppConfigSchema. Public (read before login), so mounted before the /api/* gate.
 */

import { Hono } from "hono";

export function configRoutes(): Hono {
  const r = new Hono();

  r.get("/api/config", (c) => {
    const env = process.env;
    return c.json({
      cdn_domain: env.CDN_DOMAIN ?? "",
      allow_signup: env.ALLOW_SIGNUP !== "false",
      google_client_id: env.GOOGLE_CLIENT_ID ?? "",
      posthog_key: env.POSTHOG_KEY ?? "",
      posthog_host: env.POSTHOG_HOST ?? "",
      analytics_environment:
        env.ANALYTICS_DISABLED === "true" || env.ANALYTICS_DISABLED === "1" ? "" : env.ANALYTICS_ENVIRONMENT ?? "",
      daemon_server_url: env.REMI_DAEMON_SERVER_URL ?? env.DAEMON_SERVER_URL ?? "",
      daemon_app_url: env.REMI_DAEMON_APP_URL ?? env.DAEMON_APP_URL ?? "",
      workspace_creation_disabled: env.DISABLE_WORKSPACE_CREATION === "true",
    });
  });

  return r;
}
