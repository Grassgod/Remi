/**
 * Autopilot inbound webhook — port of Go handler/autopilot_webhook.go.
 * Public endpoint (external providers call it with no JWT). A trigger is
 * resolved by its bearer token; the body's HMAC signature is verified against
 * the trigger's signing secret (GitHub-compatible X-Hub-Signature-256); the
 * delivery is persisted (idempotent on the (trigger_id, dedupe_key) partial
 * unique index); and on success the autopilot is dispatched.
 *
 * Declares the absolute /api/webhooks/* path and is mounted BEFORE the /api/*
 * JWT gate so it stays public. Not yet ported (follow-up): per-IP/token rate
 * limiting, body normalization/BOM handling, and event-filter scoping.
 */

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { autopilot, autopilotTrigger, webhookDelivery } from "../../db/schema.js";
import { dispatchAutopilot } from "../../agent/autopilot.js";

type SigStatus = "not_required" | "valid" | "invalid" | "missing";

/** GitHub-compatible HMAC: header is "sha256=<hex(hmac_sha256(body, secret))>". */
function verifyHubSignature(secret: string, header: string, body: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Provider-specific idempotency key + the header it came from. */
function extractDedupeKey(provider: string, header: (k: string) => string | undefined): { key: string | null; source: string | null } {
  if (provider === "github") {
    const v = header("X-GitHub-Delivery");
    return v ? { key: v, source: "X-GitHub-Delivery" } : { key: null, source: null };
  }
  const v = header("X-Idempotency-Key");
  return v ? { key: v, source: "X-Idempotency-Key" } : { key: null, source: null };
}

const DEDUPE_WHERE = sql`dedupe_key is not null and status <> all (array['rejected','failed'])`;

export function autopilotWebhookRoutes(db?: Db): Hono {
  const r = new Hono();

  r.post("/api/webhooks/autopilots/:token", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const token = c.req.param("token");
    if (!token) return c.json({ error: "webhook not found" }, 404);

    // Resolve the webhook trigger; derive the workspace from its parent
    // autopilot (never trust a request header for tenancy).
    const [trig] = await db
      .select()
      .from(autopilotTrigger)
      .where(and(eq(autopilotTrigger.webhookToken, token), eq(autopilotTrigger.kind, "webhook")));
    if (!trig) return c.json({ error: "webhook not found" }, 404);
    const [ap] = await db.select().from(autopilot).where(eq(autopilot.id, trig.autopilotId));
    if (!ap) return c.json({ error: "webhook not found" }, 404);

    const raw = await c.req.text();
    const header = (k: string) => c.req.header(k);
    const provider = trig.provider || "generic";
    const event = header("X-GitHub-Event") ?? "webhook.received";

    // Signature outcome.
    const secret = trig.signingSecret ?? "";
    const sigHeader = header("X-Hub-Signature-256");
    let sigStatus: SigStatus;
    if (!secret) sigStatus = "not_required";
    else if (!sigHeader) sigStatus = "missing";
    else sigStatus = verifyHubSignature(secret, sigHeader, raw) ? "valid" : "invalid";

    const rejected = sigStatus === "invalid" || sigStatus === "missing";
    const { key: dedupeKey, source: dedupeSource } = extractDedupeKey(provider, header);

    // Persist the delivery. Idempotent on the partial unique dedupe index: a
    // re-delivery of the same key (that wasn't rejected/failed) inserts nothing.
    const inserted = await db
      .insert(webhookDelivery)
      .values({
        workspaceId: ap.workspaceId,
        autopilotId: ap.id,
        triggerId: trig.id,
        provider,
        event,
        dedupeKey,
        dedupeSource,
        signatureStatus: sigStatus,
        status: rejected ? "rejected" : "queued",
        contentType: header("Content-Type") ?? null,
        rawBody: Buffer.from(raw),
        selectedHeaders: { event, signature_present: Boolean(sigHeader) },
      })
      .onConflictDoNothing({ target: [webhookDelivery.triggerId, webhookDelivery.dedupeKey], where: DEDUPE_WHERE })
      .returning();

    if (inserted.length === 0) {
      const [existing] = await db
        .select()
        .from(webhookDelivery)
        .where(and(eq(webhookDelivery.triggerId, trig.id), eq(webhookDelivery.dedupeKey, dedupeKey!)));
      return c.json({ status: "duplicate", delivery_id: existing?.id, run_id: existing?.autopilotRunId ?? undefined });
    }
    const delivery = inserted[0]!;

    // Signature failure → 401, no dispatch (delivery row already 'rejected').
    if (rejected) {
      return c.json(
        { status: "rejected", delivery_id: delivery.id, reason: sigStatus === "missing" ? "missing_signature" : "invalid_signature" },
        401,
      );
    }

    // Disabled trigger / non-active autopilot → ignored (200 so providers stop retrying).
    const ignore = (reason: string) => {
      void db.update(webhookDelivery).set({ status: "ignored" }).where(eq(webhookDelivery.id, delivery.id));
      return c.json({ status: "ignored", delivery_id: delivery.id, reason });
    };
    if (!trig.enabled) return ignore("trigger_disabled");
    if (ap.status === "archived") return ignore("autopilot_archived");
    if (ap.status !== "active") return ignore("autopilot_paused");

    // Dispatch synchronously, then link the run on the delivery.
    let payload: unknown;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    try {
      const res = await dispatchAutopilot(db, { autopilotId: ap.id, source: "webhook", triggerId: trig.id, payload });
      await db
        .update(webhookDelivery)
        .set({ status: "dispatched", autopilotRunId: res.runId, lastAttemptAt: sql`now()` })
        .where(eq(webhookDelivery.id, delivery.id));
      await db.update(autopilotTrigger).set({ lastFiredAt: sql`now()`, updatedAt: sql`now()` }).where(eq(autopilotTrigger.id, trig.id));
      return c.json({ status: "accepted", delivery_id: delivery.id, run_id: res.runId, issue_id: res.issueId });
    } catch (err) {
      await db.update(webhookDelivery).set({ status: "failed", error: err instanceof Error ? err.message : String(err) }).where(eq(webhookDelivery.id, delivery.id));
      return c.json({ error: "failed to dispatch autopilot" }, 500);
    }
  });

  return r;
}
