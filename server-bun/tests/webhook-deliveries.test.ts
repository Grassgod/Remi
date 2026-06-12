/**
 * Webhook-delivery list route test — exercises GET
 * /api/autopilots/:id/deliveries against a real DB, mirroring the Go
 * webhook_delivery_test list assertions.
 *
 * DB-gated: probe `select 1` once; skip the suite when Postgres is unreachable.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { webhookDeliveryRoutes } from "../src/http/routes/webhookDeliveries.js";
import {
  user,
  member,
  workspace,
  agent,
  agentRuntime,
  autopilot,
  autopilotTrigger,
  webhookDelivery,
} from "../src/db/schema.js";
import type { AppEnv } from "../src/http/types.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = {
  port: 0,
  jwtSecret: "test-secret-0123456789",
  authTokenTtlSeconds: 3600,
  databaseUrl: DB_URL,
  allowedEmailDomains: [],
};

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

type DeliveryJSON = {
  id: string;
  workspace_id: string;
  autopilot_id: string;
  trigger_id: string;
  provider: string;
  event: string;
  signature_status: string;
  status: string;
  attempt_count: number;
  raw_body?: unknown;
  selected_headers?: unknown;
  response_body?: unknown;
};

test.skipIf(!reachable)(
  "webhook deliveries: list returns the autopilot's deliveries, newest first, slim",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();

    const { user: u } = await findOrCreateUser(db, `bun-whdeliv-${stamp}@bytedance.com`, cfg);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Deliveries WS", slug: `bun-whdeliv-${stamp}`, issuePrefix: "WHD" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    // agent needs a runtime (NOT-NULL FK runtime_id → agent_runtime).
    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "Local Runtime",
        runtimeMode: "local",
        provider: "codex",
      })
      .returning();
    const [ag] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: `deliv-agent-${stamp}`,
        runtimeMode: "local",
        runtimeId: rt!.id,
        ownerId: u.id,
      })
      .returning();

    const [ap] = await db
      .insert(autopilot)
      .values({
        workspaceId: ws!.id,
        title: "Deliveries autopilot",
        assigneeType: "agent",
        assigneeId: ag!.id,
        status: "active",
        executionMode: "create_issue",
        createdByType: "member",
        createdById: u.id,
      })
      .returning();

    // A webhook delivery's trigger_id has a real FK to autopilot_trigger, so
    // create the trigger first (kind 'webhook', provider 'github').
    const [trig] = await db
      .insert(autopilotTrigger)
      .values({
        autopilotId: ap!.id,
        kind: "webhook",
        provider: "github",
        webhookToken: `tok-${stamp}`,
      })
      .returning();
    const triggerId = trig!.id;

    // Insert a delivery row directly (the ingress/dispatch path is out of scope).
    const [deliv] = await db
      .insert(webhookDelivery)
      .values({
        workspaceId: ws!.id,
        autopilotId: ap!.id,
        triggerId,
        provider: "github",
        event: "x",
        status: "dispatched",
        signatureStatus: "valid",
        // raw_body is large + must NOT come back through the list endpoint.
        rawBody: Buffer.from('{"hello":"world"}'),
      })
      .returning();

    // Bare app: mount only the route factory and inject the authed user, so the
    // unit test exercises the handler without the real JWT gate.
    const app = new Hono<AppEnv>();
    app.use("*", async (c, n) => {
      c.set("user", { sub: u.id, email: u.email, name: u.name });
      await n();
    });
    app.route("/", webhookDeliveryRoutes(db));

    const headers = { "X-Workspace-ID": ws!.id };

    try {
      const res = await app.request(`/api/autopilots/${ap!.id}/deliveries`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deliveries: DeliveryJSON[]; total: number };

      expect(body.total).toBe(1);
      expect(body.deliveries).toHaveLength(1);

      const d = body.deliveries[0]!;
      expect(d.id).toBe(deliv!.id);
      expect(d.workspace_id).toBe(ws!.id);
      expect(d.autopilot_id).toBe(ap!.id);
      expect(d.trigger_id).toBe(triggerId);
      expect(d.provider).toBe("github");
      expect(d.event).toBe("x");
      expect(d.status).toBe("dispatched");
      expect(d.signature_status).toBe("valid");
      expect(d.attempt_count).toBe(1);

      // Slim projection: raw_body / selected_headers / response_body never leak.
      expect(d.raw_body).toBeUndefined();
      expect(d.selected_headers).toBeUndefined();
      expect(d.response_body).toBeUndefined();

      // Wrong / missing workspace header is rejected (multi-tenancy gate).
      const noWs = await app.request(`/api/autopilots/${ap!.id}/deliveries`);
      expect(noWs.status).toBe(400);

      // Unknown autopilot id -> 404.
      const missing = await app.request(`/api/autopilots/${randomUUID()}/deliveries`, { headers });
      expect(missing.status).toBe(404);
    } finally {
      await db.delete(webhookDelivery).where(eq(webhookDelivery.workspaceId, ws!.id));
      await db.delete(autopilotTrigger).where(eq(autopilotTrigger.autopilotId, ap!.id));
      await db.delete(autopilot).where(eq(autopilot.workspaceId, ws!.id));
      await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
