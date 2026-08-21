import type { Hono } from "hono";
import type { RouterDeps } from "@multiremi/api/routers/deps.js";
import { webhookClientIpKey } from "@multiremi/api/helpers/webhooks.js";
import { lowerCaseHeaders } from "./http.js";
import { SCM_PROVIDER_CAPABILITIES } from "./capabilities.js";
import { scmIngestionStore } from "./store.js";
import { MAX_SCM_WEBHOOK_BODY_BYTES, ScmWebhookError, ScmWebhookIngestor } from "./webhook.js";

export function registerScmWebhookRoutes(app: Hono, deps: RouterDeps): void {
  const ingestor = new ScmWebhookIngestor(scmIngestionStore(deps.store));
  app.get("/api/scm/capabilities", (c) => c.json({ providers: SCM_PROVIDER_CAPABILITIES }));
  app.post("/api/webhooks/scm/:connectionId", async (c) => {
    const connectionId = c.req.param("connectionId");
    if (!deps.webhookIpRateLimiter.allow(`scm-ip:${webhookClientIpKey(c.req.raw)}`)) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    if (!deps.webhookRateLimiter.allow(`scm:${connectionId}`)) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await c.req.raw.arrayBuffer();
    } catch {
      return c.json({ error: "failed to read request body", code: "scm_webhook_body_unreadable" }, 400);
    }
    if (bytes.byteLength > MAX_SCM_WEBHOOK_BODY_BYTES) {
      return c.json({ error: "payload too large", code: "scm_webhook_payload_too_large" }, 413);
    }
    const rawBody = Buffer.from(bytes).toString("utf8");
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid JSON body", code: "scm_webhook_invalid_json" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "body must be a JSON object", code: "scm_webhook_invalid_body" }, 400);
    }
    try {
      const result = ingestor.ingest({
        connectionId,
        headers: lowerCaseHeaders(c.req.raw.headers),
        rawBody,
        body: body as Record<string, unknown>,
      });
      return c.json({
        accepted: true,
        provider: result.provider,
        provider_event: result.providerEvent,
        delivery_id: result.deliveryId,
        ignored: result.ignoredReason,
        events: result.events.map((entry) => ({
          id: entry.event.id,
          type: entry.event.type,
          created: entry.created,
          evidence_created: entry.evidenceCreated,
        })),
      }, 202);
    } catch (error) {
      if (error instanceof ScmWebhookError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }
  });
}
