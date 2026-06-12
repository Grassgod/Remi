/**
 * GitHub inbound webhook — the minimal mirror loop:
 *   1. verify the X-Hub-Signature-256 HMAC over the raw body (when a secret is
 *      configured) so only GitHub-signed payloads are accepted;
 *   2. on a `pull_request` event, resolve the workspace via the installation id
 *      and upsert the PR mirror row, then publish a realtime invalidation.
 *
 * Public endpoint (GitHub calls it without a JWT) — mounted BEFORE the /api/*
 * gate. Full install/OAuth handling and check-suite ingestion are out of scope
 * for this port (the `installation` event is acked but not yet persisted).
 */

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "../../db/client.js";
import { getInstallationByInstallationId, upsertPullRequest } from "../../db/queries/github.js";
import { bus } from "../../realtime/bus.js";

/** Constant-time compare of "sha256=<hex>" against HMAC-SHA256(secret, body). */
function verifySignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function githubWebhookRoutes(db?: Db): Hono {
  const r = new Hono();

  r.post("/api/webhooks/github", async (c) => {
    const raw = await c.req.text();

    // Require a valid signature whenever a secret is configured.
    const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (secret && !verifySignature(secret, raw, c.req.header("X-Hub-Signature-256"))) {
      return c.json({ error: "invalid signature" }, 401);
    }

    let payload: Record<string, any>;
    try {
      payload = JSON.parse(raw) as Record<string, any>;
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    const event = c.req.header("X-GitHub-Event") ?? "";
    if (!db) return c.json({ ok: true });

    if (event === "pull_request") {
      const installationId = payload.installation?.id;
      if (typeof installationId !== "number") return c.json({ ok: true });
      const inst = await getInstallationByInstallationId(db, installationId);
      if (!inst) return c.json({ ok: true }); // unknown installation → ack + ignore

      const pr = payload.pull_request ?? {};
      const repo = payload.repository ?? {};
      const nowIso = new Date().toISOString();
      const stored = await upsertPullRequest(db, {
        workspaceId: inst.workspaceId,
        installationId,
        repoOwner: repo.owner?.login ?? "",
        repoName: repo.name ?? "",
        prNumber: pr.number ?? 0,
        title: pr.title ?? "",
        state: pr.state ?? "open",
        htmlUrl: pr.html_url ?? "",
        branch: pr.head?.ref ?? null,
        authorLogin: pr.user?.login ?? null,
        authorAvatarUrl: pr.user?.avatar_url ?? null,
        mergedAt: pr.merged_at ?? null,
        closedAt: pr.closed_at ?? null,
        prCreatedAt: pr.created_at ?? nowIso,
        prUpdatedAt: pr.updated_at ?? nowIso,
        headSha: pr.head?.sha ?? "",
      });

      bus.publish({
        type: "github.pull_request",
        workspaceId: inst.workspaceId,
        payload: { id: stored.id, prNumber: stored.prNumber, state: stored.state },
      });
      return c.json({ ok: true, pull_request_id: stored.id });
    }

    // installation / unknown events → ack (full handling out of scope).
    return c.json({ ok: true });
  });

  return r;
}
