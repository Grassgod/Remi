import type { Hono } from "hono";
import { handleGitHubWebhook, headersToRecord, readJson, readPublicWebhookBody, webhookClientIpKey, webhookSignatureStatus } from "../helpers.js";
import { isObjectRecord, publicWebhookDeliveryResponse } from "../wire/index.js";
import type { RunAutopilotInput } from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerWebhookRoutes(app: Hono, deps: RouterDeps): void {
  const { store, webhookRateLimiter, webhookIpRateLimiter } = deps;

  app.post("/api/webhooks/github", async (c) => c.json(handleGitHubWebhook(store, await readJson(c)), 202));
  app.post("/api/webhooks/autopilots/:token", async (c) => {
    if (!webhookIpRateLimiter.allow(webhookClientIpKey(c.req.raw))) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    const trigger = store.getAutopilotTriggerByWebhookToken(c.req.param("token"));
    if (!trigger) return c.json({ error: "webhook not found" }, 404);
    if (!webhookRateLimiter.allow(c.req.param("token"))) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    const parsedBody = await readPublicWebhookBody(c);
    if ("apiError" in parsedBody) return c.json({ error: parsedBody.apiError }, parsedBody.statusCode);
    const { rawBody, body } = parsedBody;
    const headers = headersToRecord(c.req.raw.headers);
    const provider = trigger.provider ?? "generic";
    const signatureStatus = webhookSignatureStatus(provider, headers, rawBody, store.getAutopilotTriggerSigningSecret(trigger.id));
    const bodyObject = isObjectRecord(body) ? body as RunAutopilotInput & { payload?: unknown } : {};
    const result = store.handleAutopilotWebhookByToken(trigger.webhookToken ?? c.req.param("token"), {
      prompt: bodyObject.prompt ?? null,
      payload: Object.prototype.hasOwnProperty.call(bodyObject, "payload") ? bodyObject.payload : body,
      rawBody,
      headers,
      provider,
      signatureStatus,
    });
    if (!result) return c.json({ error: "webhook not found" }, 404);
    const response = publicWebhookDeliveryResponse(result);
    return c.json(response.body, response.statusCode);
  });

  app.post("/api/webhooks/stripe", (c) => c.json({
    received: true,
    configured: false,
    mode: "local",
  }, 202));
}
