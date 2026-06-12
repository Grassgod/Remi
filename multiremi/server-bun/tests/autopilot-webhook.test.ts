/**
 * Autopilot webhook ingestion: a bad signature is rejected (401) without
 * dispatch; a correctly-signed delivery dispatches the autopilot and creates a
 * run; re-delivering the same id is deduped (200 duplicate, no second run).
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { autopilotWebhookRoutes } from "../src/http/routes/autopilotWebhook.js";
import {
  user, member, workspace, issue, agent, agentRuntime, agentTaskQueue,
  autopilot, autopilotRun, autopilotTrigger, webhookDelivery,
} from "../src/db/schema.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = { port: 0, jwtSecret: "x", authTokenTtlSeconds: 3600, databaseUrl: DB_URL, allowedEmailDomains: [] };

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

test.skipIf(!reachable)("webhook rejects bad signature, dispatches a signed delivery, dedups a replay", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const secret = "whsec_test";
  const token = `wht_${stamp}`;
  const deliveryId = `gh-${stamp}`;
  const body = JSON.stringify({ action: "opened", ref: "refs/heads/main" });
  const goodSig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  const { user: u } = await findOrCreateUser(db, `bun-aw-${stamp}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "AW WS", slug: `bun-aw-${stamp}`, issuePrefix: "AW", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" })
    .returning();
  const [ag] = await db
    .insert(agent)
    .values({ workspaceId: ws!.id, name: "Hookbot", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id })
    .returning();
  const [ap] = await db
    .insert(autopilot)
    .values({
      workspaceId: ws!.id, title: "Webhook autopilot", assigneeType: "agent", assigneeId: ag!.id,
      executionMode: "create_issue", issueTitleTemplate: "Webhook issue", createdByType: "member", createdById: u.id,
    })
    .returning();
  const [trig] = await db
    .insert(autopilotTrigger)
    .values({ autopilotId: ap!.id, kind: "webhook", enabled: true, provider: "github", webhookToken: token, signingSecret: secret })
    .returning();

  const app = new Hono();
  app.route("/", autopilotWebhookRoutes(db));
  const path = `/api/webhooks/autopilots/${token}`;
  const headers = (sig: string) => ({
    "Content-Type": "application/json",
    "X-GitHub-Event": "pull_request",
    "X-GitHub-Delivery": deliveryId,
    "X-Hub-Signature-256": sig,
  });

  try {
    // 1. Bad signature → 401 rejected, no dispatch.
    const bad = await app.request(path, { method: "POST", headers: headers("sha256=bad"), body });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as any).status).toBe("rejected");
    expect((await db.select().from(autopilotRun).where(eq(autopilotRun.autopilotId, ap!.id))).length).toBe(0);

    // 2. Correct signature → accepted + run created (rejected row doesn't block).
    const ok = await app.request(path, { method: "POST", headers: headers(goodSig), body });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { status: string; run_id?: string; issue_id?: string };
    expect(okBody.status).toBe("accepted");
    expect(okBody.run_id).toBeTruthy();
    const runs = await db.select().from(autopilotRun).where(eq(autopilotRun.autopilotId, ap!.id));
    expect(runs.length).toBe(1);
    expect(runs[0]!.source).toBe("webhook");
    expect(runs[0]!.triggerId).toBe(trig!.id);

    // 3. Replay of the same delivery id → deduped, no second run.
    const dup = await app.request(path, { method: "POST", headers: headers(goodSig), body });
    expect(dup.status).toBe(200);
    expect(((await dup.json()) as any).status).toBe("duplicate");
    expect((await db.select().from(autopilotRun).where(eq(autopilotRun.autopilotId, ap!.id))).length).toBe(1);
  } finally {
    await db.delete(webhookDelivery).where(eq(webhookDelivery.workspaceId, ws!.id));
    await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
    await db.delete(autopilotRun).where(eq(autopilotRun.autopilotId, ap!.id));
    await db.delete(autopilotTrigger).where(eq(autopilotTrigger.autopilotId, ap!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(autopilot).where(eq(autopilot.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
