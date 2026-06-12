/**
 * Autopilot action route tests — PATCH/DELETE autopilot, manual /trigger,
 * trigger CRUD + rotate-webhook-token, delivery detail GET + replay.
 * Mirrors the Go autopilot.go / webhook_delivery.go handler behaviour.
 *
 * DB-gated: probe `select 1` once; skip the suite when Postgres is unreachable.
 * Each test creates + tears down its own fixtures (unique epoch-millis suffix),
 * deleting in reverse FK order in `finally`.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { autopilotActionsRoutes } from "../src/http/routes/autopilotActions.js";
import {
  user,
  member,
  workspace,
  agent,
  agentRuntime,
  agentTaskQueue,
  autopilot,
  autopilotRun,
  autopilotTrigger,
  issue,
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

type Ctx = {
  db: ReturnType<typeof createDb>["db"];
  close: () => Promise<void>;
  app: Hono<AppEnv>;
  headers: Record<string, string>;
  userId: string;
  wsId: string;
  runtimeId: string;
  agentId: string;
};

/** workspace → member → runtime → agent fixture chain + a bare app with the factory. */
async function setup(tag: string): Promise<Ctx> {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-apact-${tag}-${stamp}@bytedance.com`, cfg);

  const [ws] = await db
    .insert(workspace)
    .values({ name: "AP Actions WS", slug: `bun-apact-${tag}-${stamp}`, issuePrefix: "APA" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

  const [rt] = await db
    .insert(agentRuntime)
    .values({ workspaceId: ws!.id, name: "rt", runtimeMode: "local", provider: "codex" })
    .returning();
  const [ag] = await db
    .insert(agent)
    .values({
      workspaceId: ws!.id,
      name: `apact-agent-${tag}-${stamp}`,
      runtimeMode: "local",
      runtimeId: rt!.id,
      ownerId: u.id,
    })
    .returning();

  // Bare app: mount only the route factory and inject the authed user, so the
  // unit test exercises the handler without the real JWT gate.
  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => {
    c.set("user", { sub: u.id, email: u.email, name: u.name });
    await n();
  });
  app.route("/", autopilotActionsRoutes(db));

  return {
    db,
    close,
    app,
    headers: { "X-Workspace-ID": ws!.id, "Content-Type": "application/json" },
    userId: u.id,
    wsId: ws!.id,
    runtimeId: rt!.id,
    agentId: ag!.id,
  };
}

/** Reverse-FK teardown for everything a test (or a dispatch) may have created. */
async function teardown(ctx: Ctx): Promise<void> {
  const { db } = ctx;
  await db.delete(webhookDelivery).where(eq(webhookDelivery.workspaceId, ctx.wsId));
  await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ctx.agentId));
  const aps = await db.select().from(autopilot).where(eq(autopilot.workspaceId, ctx.wsId));
  for (const ap of aps) {
    await db.delete(autopilotRun).where(eq(autopilotRun.autopilotId, ap.id));
    await db.delete(autopilotTrigger).where(eq(autopilotTrigger.autopilotId, ap.id));
  }
  await db.delete(issue).where(eq(issue.workspaceId, ctx.wsId));
  await db.delete(autopilot).where(eq(autopilot.workspaceId, ctx.wsId));
  await db.delete(agent).where(eq(agent.workspaceId, ctx.wsId));
  await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ctx.wsId));
  await db.delete(member).where(eq(member.workspaceId, ctx.wsId));
  await db.delete(workspace).where(eq(workspace.id, ctx.wsId));
  await db.delete(user).where(eq(user.id, ctx.userId));
  await ctx.close();
}

async function createFixtureAutopilot(
  ctx: Ctx,
  overrides: Partial<typeof autopilot.$inferInsert> = {},
) {
  const [ap] = await ctx.db
    .insert(autopilot)
    .values({
      workspaceId: ctx.wsId,
      title: "Fixture autopilot",
      assigneeType: "agent",
      assigneeId: ctx.agentId,
      status: "active",
      executionMode: "create_issue",
      createdByType: "member",
      createdById: ctx.userId,
      ...overrides,
    })
    .returning();
  return ap!;
}

test.skipIf(!reachable)(
  "autopilot actions: PATCH updates fields (null clears), validates pairs; DELETE removes",
  async () => {
    const ctx = await setup("patch");
    try {
      const ap = await createFixtureAutopilot(ctx, { description: "orig desc" });

      // Update title + description + status in one PATCH.
      const res = await ctx.app.request(`/api/autopilots/${ap.id}`, {
        method: "PATCH",
        headers: ctx.headers,
        body: JSON.stringify({ title: "Renamed", description: "new desc", status: "paused" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.id).toBe(ap.id);
      expect(body.title).toBe("Renamed");
      expect(body.description).toBe("new desc");
      expect(body.status).toBe("paused");
      expect(body.workspace_id).toBe(ctx.wsId);
      expect(body.assignee_type).toBe("agent");
      expect(body.assignee_id).toBe(ctx.agentId);
      expect(body.execution_mode).toBe("create_issue");

      // Explicit null clears description; absent fields stay untouched.
      const clear = await ctx.app.request(`/api/autopilots/${ap.id}`, {
        method: "PATCH",
        headers: ctx.headers,
        body: JSON.stringify({ description: null }),
      });
      expect(clear.status).toBe(200);
      const cleared = (await clear.json()) as Record<string, unknown>;
      expect(cleared.description).toBeNull();
      expect(cleared.title).toBe("Renamed");

      // issue_title_template: supported variable passes, unknown one is 400.
      const tmplOk = await ctx.app.request(`/api/autopilots/${ap.id}`, {
        method: "PATCH",
        headers: ctx.headers,
        body: JSON.stringify({ issue_title_template: "Daily {{date}}" }),
      });
      expect(tmplOk.status).toBe(200);
      expect(((await tmplOk.json()) as Record<string, unknown>).issue_title_template).toBe(
        "Daily {{date}}",
      );
      const tmplBad = await ctx.app.request(`/api/autopilots/${ap.id}`, {
        method: "PATCH",
        headers: ctx.headers,
        body: JSON.stringify({ issue_title_template: "x {{bogus}}" }),
      });
      expect(tmplBad.status).toBe(400);

      // Changing assignee_type without a paired assignee_id is rejected.
      const pair = await ctx.app.request(`/api/autopilots/${ap.id}`, {
        method: "PATCH",
        headers: ctx.headers,
        body: JSON.stringify({ assignee_type: "squad" }),
      });
      expect(pair.status).toBe(400);
      expect(((await pair.json()) as { error: string }).error).toBe(
        "assignee_id is required when changing assignee_type",
      );

      // Unknown id and cross-workspace miss → 404.
      const missing = await ctx.app.request(`/api/autopilots/${randomUUID()}`, {
        method: "PATCH",
        headers: ctx.headers,
        body: JSON.stringify({ title: "x" }),
      });
      expect(missing.status).toBe(404);

      // DELETE removes the row; a second DELETE is a 404.
      const del = await ctx.app.request(`/api/autopilots/${ap.id}`, {
        method: "DELETE",
        headers: ctx.headers,
      });
      expect(del.status).toBe(204);
      const rows = await ctx.db.select().from(autopilot).where(eq(autopilot.id, ap.id));
      expect(rows).toHaveLength(0);
      const again = await ctx.app.request(`/api/autopilots/${ap.id}`, {
        method: "DELETE",
        headers: ctx.headers,
      });
      expect(again.status).toBe(404);
    } finally {
      await teardown(ctx);
    }
  },
);

test.skipIf(!reachable)(
  "autopilot actions: POST /trigger creates a manual run + issue + queued task",
  async () => {
    const ctx = await setup("run");
    try {
      const ap = await createFixtureAutopilot(ctx, { issueTitleTemplate: "Manual run issue" });

      const res = await ctx.app.request(`/api/autopilots/${ap.id}/trigger`, {
        method: "POST",
        headers: ctx.headers,
      });
      expect(res.status).toBe(200);
      const run = (await res.json()) as Record<string, unknown>;
      expect(run.autopilot_id).toBe(ap.id);
      expect(run.source).toBe("manual");
      expect(run.status).toBe("issue_created");
      expect(run.trigger_id).toBeNull();
      expect(typeof run.issue_id).toBe("string");
      expect(typeof run.task_id).toBe("string");

      // DB rows: the run, the created issue, and the queued agent task.
      const [runRow] = await ctx.db
        .select()
        .from(autopilotRun)
        .where(eq(autopilotRun.id, run.id as string));
      expect(runRow).toBeDefined();
      expect(runRow!.source).toBe("manual");

      const [iss] = await ctx.db.select().from(issue).where(eq(issue.id, run.issue_id as string));
      expect(iss).toBeDefined();
      expect(iss!.title).toBe("Manual run issue");
      expect(iss!.originType).toBe("autopilot");
      expect(iss!.workspaceId).toBe(ctx.wsId);

      const [task] = await ctx.db
        .select()
        .from(agentTaskQueue)
        .where(eq(agentTaskQueue.id, run.task_id as string));
      expect(task).toBeDefined();
      expect(task!.agentId).toBe(ctx.agentId);
      expect(task!.status).toBe("queued");
      expect(task!.issueId).toBe(run.issue_id as string);

      // Non-active autopilots cannot be run manually.
      await ctx.db.update(autopilot).set({ status: "paused" }).where(eq(autopilot.id, ap.id));
      const paused = await ctx.app.request(`/api/autopilots/${ap.id}/trigger`, {
        method: "POST",
        headers: ctx.headers,
      });
      expect(paused.status).toBe(400);
      expect(((await paused.json()) as { error: string }).error).toBe("autopilot is not active");
    } finally {
      await teardown(ctx);
    }
  },
);

test.skipIf(!reachable)(
  "autopilot actions: trigger CRUD round-trip incl. rotate-webhook-token",
  async () => {
    const ctx = await setup("trig");
    try {
      const ap = await createFixtureAutopilot(ctx);

      // Schedule trigger: created enabled with a computed next_run_at.
      const sched = await ctx.app.request(`/api/autopilots/${ap.id}/triggers`, {
        method: "POST",
        headers: ctx.headers,
        body: JSON.stringify({ kind: "schedule", cron_expression: "0 9 * * *", timezone: "UTC", label: "daily" }),
      });
      expect(sched.status).toBe(201);
      const schedTrig = (await sched.json()) as Record<string, unknown>;
      expect(schedTrig.kind).toBe("schedule");
      expect(schedTrig.enabled).toBe(true);
      expect(schedTrig.cron_expression).toBe("0 9 * * *");
      expect(schedTrig.next_run_at).not.toBeNull();
      expect(schedTrig.webhook_token).toBeNull();
      expect(schedTrig.webhook_path).toBeNull();
      expect(schedTrig.label).toBe("daily");

      // Deprecated "api" kind is rejected loudly.
      const apiKind = await ctx.app.request(`/api/autopilots/${ap.id}/triggers`, {
        method: "POST",
        headers: ctx.headers,
        body: JSON.stringify({ kind: "api" }),
      });
      expect(apiKind.status).toBe(400);

      // PATCH: disable + relabel + new cron recomputes next_run_at.
      const patched = await ctx.app.request(
        `/api/autopilots/${ap.id}/triggers/${schedTrig.id as string}`,
        {
          method: "PATCH",
          headers: ctx.headers,
          body: JSON.stringify({ enabled: false, label: "renamed", cron_expression: "30 8 * * *" }),
        },
      );
      expect(patched.status).toBe(200);
      const patchedTrig = (await patched.json()) as Record<string, unknown>;
      expect(patchedTrig.enabled).toBe(false);
      expect(patchedTrig.label).toBe("renamed");
      expect(patchedTrig.cron_expression).toBe("30 8 * * *");
      expect(patchedTrig.next_run_at).not.toBeNull();

      // Webhook trigger: minted token + computed path + echoed filters.
      const wh = await ctx.app.request(`/api/autopilots/${ap.id}/triggers`, {
        method: "POST",
        headers: ctx.headers,
        body: JSON.stringify({
          kind: "webhook",
          provider: "github",
          label: "gh",
          event_filters: [{ event: "pull_request", actions: ["opened"] }],
        }),
      });
      expect(wh.status).toBe(201);
      const whTrig = (await wh.json()) as Record<string, unknown>;
      expect(whTrig.kind).toBe("webhook");
      const token = whTrig.webhook_token as string;
      expect(token.startsWith("awt_")).toBe(true);
      expect(token).toHaveLength(47); // "awt_" + base64url(32 bytes)
      expect(whTrig.webhook_path).toBe(`/api/webhooks/autopilots/${token}`);
      expect(whTrig.provider).toBe("github");
      expect(whTrig.has_signing_secret).toBe(false);
      expect(whTrig.event_filters).toEqual([{ event: "pull_request", actions: ["opened"] }]);

      // cron/timezone are schedule-only fields.
      const badPatch = await ctx.app.request(
        `/api/autopilots/${ap.id}/triggers/${whTrig.id as string}`,
        {
          method: "PATCH",
          headers: ctx.headers,
          body: JSON.stringify({ cron_expression: "0 9 * * *" }),
        },
      );
      expect(badPatch.status).toBe(400);

      // Rotate mints a fresh token; the DB row matches the response.
      const rotated = await ctx.app.request(
        `/api/autopilots/${ap.id}/triggers/${whTrig.id as string}/rotate-webhook-token`,
        { method: "POST", headers: ctx.headers },
      );
      expect(rotated.status).toBe(200);
      const rotatedTrig = (await rotated.json()) as Record<string, unknown>;
      const newToken = rotatedTrig.webhook_token as string;
      expect(newToken.startsWith("awt_")).toBe(true);
      expect(newToken).not.toBe(token);
      expect(rotatedTrig.webhook_path).toBe(`/api/webhooks/autopilots/${newToken}`);
      const [whRow] = await ctx.db
        .select()
        .from(autopilotTrigger)
        .where(eq(autopilotTrigger.id, whTrig.id as string));
      expect(whRow!.webhookToken).toBe(newToken);

      // Rotating a schedule trigger is a 400.
      const rotSched = await ctx.app.request(
        `/api/autopilots/${ap.id}/triggers/${schedTrig.id as string}/rotate-webhook-token`,
        { method: "POST", headers: ctx.headers },
      );
      expect(rotSched.status).toBe(400);

      // DELETE removes the trigger; second call 404s.
      const del = await ctx.app.request(
        `/api/autopilots/${ap.id}/triggers/${whTrig.id as string}`,
        { method: "DELETE", headers: ctx.headers },
      );
      expect(del.status).toBe(204);
      const gone = await ctx.db
        .select()
        .from(autopilotTrigger)
        .where(eq(autopilotTrigger.id, whTrig.id as string));
      expect(gone).toHaveLength(0);
      const delAgain = await ctx.app.request(
        `/api/autopilots/${ap.id}/triggers/${whTrig.id as string}`,
        { method: "DELETE", headers: ctx.headers },
      );
      expect(delAgain.status).toBe(404);
    } finally {
      await teardown(ctx);
    }
  },
);

test.skipIf(!reachable)(
  "autopilot actions: delivery detail GET + replay creates a new dispatched delivery",
  async () => {
    const ctx = await setup("deliv");
    try {
      // run_only keeps the dispatch side-effects minimal (no issue/task).
      const ap = await createFixtureAutopilot(ctx, { executionMode: "run_only" });
      const [trig] = await ctx.db
        .insert(autopilotTrigger)
        .values({
          autopilotId: ap.id,
          kind: "webhook",
          provider: "github",
          webhookToken: `awt_fixture-${Date.now()}`,
        })
        .returning();

      const rawJson = '{"action":"opened","number":7}';
      const [orig] = await ctx.db
        .insert(webhookDelivery)
        .values({
          workspaceId: ctx.wsId,
          autopilotId: ap.id,
          triggerId: trig!.id,
          provider: "github",
          event: "issues.opened",
          signatureStatus: "valid",
          status: "dispatched",
          contentType: "application/json",
          selectedHeaders: { event: "issues.opened", signature_present: true },
          rawBody: Buffer.from(rawJson),
        })
        .returning();

      // Detail GET returns the full row, including raw_body + selected_headers.
      const got = await ctx.app.request(
        `/api/autopilots/${ap.id}/deliveries/${orig!.id}`,
        { headers: ctx.headers },
      );
      expect(got.status).toBe(200);
      const detail = (await got.json()) as Record<string, unknown>;
      expect(detail.id).toBe(orig!.id);
      expect(detail.autopilot_id).toBe(ap.id);
      expect(detail.trigger_id).toBe(trig!.id);
      expect(detail.event).toBe("issues.opened");
      expect(detail.signature_status).toBe("valid");
      expect(detail.raw_body).toBe(rawJson);
      expect(detail.selected_headers).toEqual({ event: "issues.opened", signature_present: true });

      // Unknown delivery id → 404.
      const missing = await ctx.app.request(
        `/api/autopilots/${ap.id}/deliveries/${randomUUID()}`,
        { headers: ctx.headers },
      );
      expect(missing.status).toBe(404);

      // Replay: a NEW delivery row, linked to the original and dispatched.
      const replay = await ctx.app.request(
        `/api/autopilots/${ap.id}/deliveries/${orig!.id}/replay`,
        { method: "POST", headers: ctx.headers },
      );
      expect(replay.status).toBe(201);
      const replayed = (await replay.json()) as Record<string, unknown>;
      expect(replayed.id).not.toBe(orig!.id);
      expect(replayed.replayed_from_delivery_id).toBe(orig!.id);
      expect(replayed.status).toBe("dispatched");
      expect(replayed.signature_status).toBe("not_required");
      expect(replayed.dedupe_key).toBeNull(); // replays bypass dedupe
      expect(typeof replayed.autopilot_run_id).toBe("string");
      expect(replayed.raw_body).toBe(rawJson);
      expect(replayed.response_status).toBe(201);

      // DB: the run came from the webhook source and points at the trigger.
      const [run] = await ctx.db
        .select()
        .from(autopilotRun)
        .where(eq(autopilotRun.id, replayed.autopilot_run_id as string));
      expect(run).toBeDefined();
      expect(run!.source).toBe("webhook");
      expect(run!.triggerId).toBe(trig!.id);
      expect(run!.autopilotId).toBe(ap.id);

      // Signature-failed deliveries cannot be replayed.
      const [rejected] = await ctx.db
        .insert(webhookDelivery)
        .values({
          workspaceId: ctx.wsId,
          autopilotId: ap.id,
          triggerId: trig!.id,
          provider: "github",
          event: "issues.opened",
          signatureStatus: "invalid",
          status: "rejected",
          rawBody: Buffer.from(rawJson),
        })
        .returning();
      const noReplay = await ctx.app.request(
        `/api/autopilots/${ap.id}/deliveries/${rejected!.id}/replay`,
        { method: "POST", headers: ctx.headers },
      );
      expect(noReplay.status).toBe(400);
      expect(((await noReplay.json()) as { error: string }).error).toBe(
        "cannot replay a delivery that failed signature verification",
      );
    } finally {
      await teardown(ctx);
    }
  },
);
