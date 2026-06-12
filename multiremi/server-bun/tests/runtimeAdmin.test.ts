/**
 * Tests for the runtime admin routes (src/http/routes/runtimeAdmin.ts):
 * PATCH /api/runtimes/:id, GET :id/activity, GET :id/usage/by-hour and
 * POST :id/archive-agents-and-delete. DB-gated: skipped when Postgres is
 * unreachable. The factory is not yet mounted in app.ts, so each test builds
 * createApp (real JWT + workspace middlewares) and mounts the factory at the
 * root, exactly as app.ts will.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { runtimeAdminRoutes } from "../src/http/routes/runtimeAdmin.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import {
  user,
  member,
  workspace,
  agent,
  agentRuntime,
  agentTaskQueue,
  autopilot,
  taskUsageHourly,
} from "../src/db/schema.js";
import { bus, type BusEvent } from "../src/realtime/bus.js";
import type { Config } from "../src/config.js";

const SECRET = "test-secret-0123456789";
const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = {
  port: 0,
  jwtSecret: SECRET,
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

function buildApp(db: ReturnType<typeof createDb>["db"]) {
  const app = createApp(cfg, db);
  // The factory declares absolute /api/* paths; app.ts will mount it the same
  // way. The /api/* JWT gate registered inside createApp still applies.
  app.route("/", runtimeAdminRoutes(db));
  return app;
}

type RuntimeResp = {
  id: string;
  workspace_id: string;
  name: string;
  visibility: string;
  launch_header: string;
  status: string;
};

type HourlyActivityResp = { hour: number; count: number }[];

type UsageByHourResp = {
  hour: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  task_count: number;
}[];

type CascadeOkResp = { status: string; agents_archived: number; tasks_cancelled: number };

type CascadeConflictResp = {
  error: string;
  code: string;
  active_agents: { id: string; name: string; skills: unknown[]; archived_at: string | null }[];
};

test.skipIf(!reachable)(
  "PATCH /api/runtimes/:id flips visibility, publishes runtime.updated only on change",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = buildApp(db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rta-patch-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "RTA Patch", slug: `bun-rta-patch-${stamp}`, issuePrefix: "RAP" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "patch-rt", runtimeMode: "local", provider: "claude", ownerId: u.id })
      .returning();
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    const events: BusEvent[] = [];
    const unsub = bus.subscribe(ws!.id, (e) => events.push(e));
    try {
      // private → public: 200, updated row in the Go AgentRuntimeResponse shape.
      const res = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as RuntimeResp;
      expect(body.id).toBe(rt!.id);
      expect(body.workspace_id).toBe(ws!.id);
      expect(body.visibility).toBe("public");
      expect(body.launch_header).toBe("claude (stream-json)");
      expect(events.filter((e) => e.type === "runtime.updated")).toHaveLength(1);

      // Empty patch body: 200, nothing changed, no extra event (Go: only a
      // real visibility change publishes).
      const noop = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({}),
      });
      expect(noop.status).toBe(200);
      expect(((await noop.json()) as RuntimeResp).visibility).toBe("public");

      // Same-value patch: 200, still no extra event.
      const same = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(same.status).toBe(200);
      expect(events.filter((e) => e.type === "runtime.updated")).toHaveLength(1);

      // bad visibility → 400
      const bad = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ visibility: "secret" }),
      });
      expect(bad.status).toBe(400);

      // malformed JSON → 400
      const badJson = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PATCH",
        headers: auth,
        body: "{",
      });
      expect(badJson.status).toBe(400);

      // unknown id → 404
      const missing = await app.request("/api/runtimes/99999999-9999-4999-8999-999999999999", {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(missing.status).toBe(404);
    } finally {
      unsub();
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "runtime write access: plain members only their own runtimes; admins any (403 otherwise)",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = buildApp(db);
    const stamp = Date.now();
    const { user: u1 } = await findOrCreateUser(db, `bun-rta-own1-${stamp}@bytedance.com`, cfg);
    const { user: u2 } = await findOrCreateUser(db, `bun-rta-own2-${stamp}@bytedance.com`, cfg);
    const token2 = await issueJWT({ sub: u2.id, email: u2.email, name: u2.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "RTA Own", slug: `bun-rta-own-${stamp}`, issuePrefix: "RAO" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u1.id, role: "owner" });
    const [m2] = await db
      .insert(member)
      .values({ workspaceId: ws!.id, userId: u2.id, role: "member" })
      .returning();
    // rt1 belongs to u1; rt2 belongs to u2 (the plain member).
    const [rt1] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "rt-of-u1", runtimeMode: "local", provider: "claude", ownerId: u1.id })
      .returning();
    const [rt2] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "rt-of-u2", runtimeMode: "cloud", provider: "codex", ownerId: u2.id })
      .returning();
    const auth2 = {
      Authorization: `Bearer ${token2}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    try {
      // plain member PATCHing someone else's runtime → 403
      const patchForeign = await app.request(`/api/runtimes/${rt1!.id}`, {
        method: "PATCH",
        headers: auth2,
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(patchForeign.status).toBe(403);
      expect(((await patchForeign.json()) as { error: string }).error).toBe(
        "you can only edit your own runtimes",
      );

      // plain member cascading someone else's runtime → 403
      const cascadeForeign = await app.request(`/api/runtimes/${rt1!.id}/archive-agents-and-delete`, {
        method: "POST",
        headers: auth2,
        body: JSON.stringify({ expected_active_agent_ids: [] }),
      });
      expect(cascadeForeign.status).toBe(403);
      expect(((await cascadeForeign.json()) as { error: string }).error).toBe(
        "you can only delete your own runtimes",
      );

      // plain member editing their OWN runtime → 200
      const patchOwn = await app.request(`/api/runtimes/${rt2!.id}`, {
        method: "PATCH",
        headers: auth2,
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(patchOwn.status).toBe(200);

      // promote u2 to admin → foreign runtime becomes editable
      await db.update(member).set({ role: "admin" }).where(eq(member.id, m2!.id));
      const patchAsAdmin = await app.request(`/api/runtimes/${rt1!.id}`, {
        method: "PATCH",
        headers: auth2,
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(patchAsAdmin.status).toBe(200);
    } finally {
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(inArray(user.id, [u1.id, u2.id]));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "GET /api/runtimes/:id/activity buckets task starts by hour in the viewer tz",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = buildApp(db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rta-act-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "RTA Act", slug: `bun-rta-act-${stamp}`, issuePrefix: "RAA" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "act-rt", runtimeMode: "local", provider: "claude", ownerId: u.id })
      .returning();
    const [ag] = await db
      .insert(agent)
      .values({ workspaceId: ws!.id, name: `Act Agent ${stamp}`, runtimeMode: "local", runtimeId: rt!.id, ownerId: u.id })
      .returning();

    // Two starts in the 03:00 UTC hour, one in 07:00 UTC; a queued task with
    // no started_at must not count. The query has no date cutoff (all time).
    const started = [
      new Date(Date.UTC(2026, 4, 20, 3, 5, 0)).toISOString(),
      new Date(Date.UTC(2026, 4, 21, 3, 50, 0)).toISOString(),
      new Date(Date.UTC(2026, 4, 20, 7, 30, 0)).toISOString(),
    ];
    const tasks = await db
      .insert(agentTaskQueue)
      .values([
        { agentId: ag!.id, runtimeId: rt!.id, status: "completed", startedAt: started[0], completedAt: started[0] },
        { agentId: ag!.id, runtimeId: rt!.id, status: "completed", startedAt: started[1], completedAt: started[1] },
        { agentId: ag!.id, runtimeId: rt!.id, status: "completed", startedAt: started[2], completedAt: started[2] },
        { agentId: ag!.id, runtimeId: rt!.id, status: "queued" },
      ])
      .returning({ id: agentTaskQueue.id });
    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // Default tz = UTC.
      const utcRes = await app.request(`/api/runtimes/${rt!.id}/activity`, { headers: auth });
      expect(utcRes.status).toBe(200);
      expect((await utcRes.json()) as HourlyActivityResp).toEqual([
        { hour: 3, count: 2 },
        { hour: 7, count: 1 },
      ]);

      // Viewer tz shifts the hour-of-day axis (UTC+8).
      const cnRes = await app.request(`/api/runtimes/${rt!.id}/activity?tz=Asia/Shanghai`, {
        headers: auth,
      });
      expect((await cnRes.json()) as HourlyActivityResp).toEqual([
        { hour: 11, count: 2 },
        { hour: 15, count: 1 },
      ]);

      // Unknown tz falls back to UTC (display concern; mirrors Go).
      const badTzRes = await app.request(`/api/runtimes/${rt!.id}/activity?tz=Not/AZone`, {
        headers: auth,
      });
      expect((await badTzRes.json()) as HourlyActivityResp).toEqual([
        { hour: 3, count: 2 },
        { hour: 7, count: 1 },
      ]);
    } finally {
      await db.delete(agentTaskQueue).where(
        inArray(
          agentTaskQueue.id,
          tasks.map((t) => t.id),
        ),
      );
      await db.delete(agent).where(eq(agent.id, ag!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "GET /api/runtimes/:id/usage/by-hour aggregates seeded hourly rollups per (hour, model)",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = buildApp(db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rta-hour-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "RTA Hour", slug: `bun-rta-hour-${stamp}`, issuePrefix: "RAH" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "hour-rt", runtimeMode: "local", provider: "claude", ownerId: u.id })
      .returning();

    // task_usage_hourly has no FKs — agent/foreign-runtime ids can be synthetic.
    const agentId = crypto.randomUUID();
    const otherRuntimeId = crypto.randomUUID();
    const HOUR = 3_600_000;
    const b1 = new Date(Math.floor(stamp / HOUR) * HOUR); // current hour today
    const b2 = new Date(b1.getTime() - 24 * HOUR); // yesterday, same hour-of-day
    const b3 = new Date(b1.getTime() - 2 * HOUR); // different hour-of-day
    const bOld = new Date(b1.getTime() - 40 * 24 * HOUR); // outside default 30d
    const h1 = b1.getUTCHours();
    const h3 = b3.getUTCHours();

    const base = { workspaceId: ws!.id, agentId, provider: "claude", eventCount: 1 };
    await db.insert(taskUsageHourly).values([
      // Same (hour-of-day, model) across two days → one aggregated row.
      { ...base, runtimeId: rt!.id, bucketHour: b1.toISOString(), model: "m-a", inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, taskCount: 2 },
      { ...base, runtimeId: rt!.id, bucketHour: b2.toISOString(), model: "m-a", inputTokens: 40, outputTokens: 20, cacheReadTokens: 4, cacheWriteTokens: 2, taskCount: 1 },
      // Different hour + model → its own row.
      { ...base, runtimeId: rt!.id, bucketHour: b3.toISOString(), model: "m-b", inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 1, taskCount: 1 },
      // Outside the default 30-day window → excluded unless ?days=60.
      { ...base, runtimeId: rt!.id, bucketHour: bOld.toISOString(), model: "m-a", inputTokens: 999, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, taskCount: 1 },
      // Another runtime's row → never included.
      { ...base, runtimeId: otherRuntimeId, bucketHour: b1.toISOString(), model: "m-a", inputTokens: 5_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, taskCount: 1 },
    ]);
    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      const res = await app.request(`/api/runtimes/${rt!.id}/usage/by-hour`, { headers: auth });
      expect(res.status).toBe(200);
      const rows = (await res.json()) as UsageByHourResp;
      expect(rows).toHaveLength(2);
      // Sorted by hour asc, model asc.
      const sorted = [...rows].sort((a, b) => a.hour - b.hour || a.model.localeCompare(b.model));
      expect(rows).toEqual(sorted);

      const ma = rows.find((r) => r.model === "m-a")!;
      expect(ma.hour).toBe(h1);
      expect(ma.input_tokens).toBe(140);
      expect(ma.output_tokens).toBe(70);
      expect(ma.cache_read_tokens).toBe(14);
      expect(ma.cache_write_tokens).toBe(7);
      expect(ma.task_count).toBe(3);

      const mb = rows.find((r) => r.model === "m-b")!;
      expect(mb.hour).toBe(h3);
      expect(mb.input_tokens).toBe(7);
      expect(mb.task_count).toBe(1);

      // Widening the window pulls the 40-day-old bucket into the same
      // (hour, model) aggregate.
      const wide = await app.request(`/api/runtimes/${rt!.id}/usage/by-hour?days=60`, { headers: auth });
      const wideRows = (await wide.json()) as UsageByHourResp;
      const maWide = wideRows.find((r) => r.model === "m-a" && r.hour === bOld.getUTCHours());
      // bOld shares b1's hour-of-day (-40 whole days), so the m-a row absorbs it.
      expect(maWide?.input_tokens).toBe(140 + 999);
      expect(maWide?.task_count).toBe(4);

      // Out-of-range days (Go: >365 → default) keeps the 30d window.
      const clamped = await app.request(`/api/runtimes/${rt!.id}/usage/by-hour?days=999`, { headers: auth });
      expect((await clamped.json()) as UsageByHourResp).toHaveLength(2);
    } finally {
      await db.delete(taskUsageHourly).where(inArray(taskUsageHourly.runtimeId, [rt!.id, otherRuntimeId]));
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "POST archive-agents-and-delete archives agents, cancels tasks, pauses autopilots, deletes runtime",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = buildApp(db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rta-casc-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "RTA Casc", slug: `bun-rta-casc-${stamp}`, issuePrefix: "RAC" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "casc-rt", runtimeMode: "local", provider: "claude", ownerId: u.id })
      .returning();
    const now = new Date(stamp).toISOString();
    const [agA] = await db
      .insert(agent)
      .values({ workspaceId: ws!.id, name: `casc-a-${stamp}`, runtimeMode: "local", runtimeId: rt!.id, ownerId: u.id })
      .returning();
    const [agB] = await db
      .insert(agent)
      .values({ workspaceId: ws!.id, name: `casc-b-${stamp}`, runtimeMode: "local", runtimeId: rt!.id, ownerId: u.id })
      .returning();
    // Already-archived agent on the same runtime: not part of the confirmed
    // plan, but its autopilot must still be paused before the hard-delete.
    const [agC] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: `casc-c-${stamp}`,
        runtimeMode: "local",
        runtimeId: rt!.id,
        ownerId: u.id,
        archivedAt: now,
        archivedBy: u.id,
      })
      .returning();
    // One active task (→ cancelled) and one terminal task (→ untouched count).
    const [tQ] = await db
      .insert(agentTaskQueue)
      .values({ agentId: agA!.id, runtimeId: rt!.id, status: "queued" })
      .returning();
    await db
      .insert(agentTaskQueue)
      .values({ agentId: agA!.id, runtimeId: rt!.id, status: "completed", startedAt: now, completedAt: now })
      .returning();
    const apValues = {
      workspaceId: ws!.id,
      assigneeType: "agent",
      status: "active",
      createdByType: "member",
      createdById: u.id,
    };
    const [apA] = await db
      .insert(autopilot)
      .values({ ...apValues, title: "ap-of-A", assigneeId: agA!.id })
      .returning();
    const [apC] = await db
      .insert(autopilot)
      .values({ ...apValues, title: "ap-of-C", assigneeId: agC!.id })
      .returning();
    const [apOther] = await db
      .insert(autopilot)
      .values({ ...apValues, title: "ap-other", assigneeId: crypto.randomUUID() })
      .returning();
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    const events: BusEvent[] = [];
    const unsub = bus.subscribe(ws!.id, (e) => events.push(e));
    try {
      const res = await app.request(`/api/runtimes/${rt!.id}/archive-agents-and-delete`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ expected_active_agent_ids: [agA!.id, agB!.id] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as CascadeOkResp;
      expect(body.status).toBe("ok");
      expect(body.agents_archived).toBe(2);
      expect(body.tasks_cancelled).toBe(1);

      // Runtime and ALL its agents (incl. the pre-archived one) are gone; the
      // task rows follow via the agent/runtime FK cascade.
      expect(await db.select().from(agentRuntime).where(eq(agentRuntime.id, rt!.id))).toHaveLength(0);
      expect(
        await db.select().from(agent).where(inArray(agent.id, [agA!.id, agB!.id, agC!.id])),
      ).toHaveLength(0);
      expect(await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.runtimeId, rt!.id))).toHaveLength(0);

      // Autopilots aimed at any archived agent on the runtime are paused;
      // unrelated autopilots stay active.
      const [apA2] = await db.select().from(autopilot).where(eq(autopilot.id, apA!.id));
      const [apC2] = await db.select().from(autopilot).where(eq(autopilot.id, apC!.id));
      const [apOther2] = await db.select().from(autopilot).where(eq(autopilot.id, apOther!.id));
      expect(apA2!.status).toBe("paused");
      expect(apC2!.status).toBe("paused");
      expect(apOther2!.status).toBe("active");

      // Event fan-out mirrors the Go ordering: task:cancelled → agent archived
      // (Bun vocabulary: agent.updated) → runtime-list refresh (runtime.deleted).
      const cancelIdx = events.findIndex((e) => e.type === "task:cancelled");
      const agentIdx = events.findIndex((e) => e.type === "agent.updated");
      const deleteIdx = events.findIndex((e) => e.type === "runtime.deleted");
      expect(cancelIdx).toBeGreaterThanOrEqual(0);
      expect(agentIdx).toBeGreaterThan(cancelIdx);
      expect(deleteIdx).toBeGreaterThan(agentIdx);
      expect(events.filter((e) => e.type === "agent.updated")).toHaveLength(2);
      expect(events[cancelIdx]!.payload?.task_id).toBe(tQ!.id);
      expect(events[deleteIdx]!.payload?.id).toBe(rt!.id);
    } finally {
      unsub();
      await db.delete(autopilot).where(eq(autopilot.workspaceId, ws!.id));
      await db.delete(agentTaskQueue).where(eq(agentTaskQueue.runtimeId, rt!.id));
      await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "POST archive-agents-and-delete refuses a stale plan with 409 and validates the id list",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = buildApp(db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rta-plan-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "RTA Plan", slug: `bun-rta-plan-${stamp}`, issuePrefix: "RAN" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "plan-rt", runtimeMode: "local", provider: "claude", ownerId: u.id })
      .returning();
    const [agA] = await db
      .insert(agent)
      .values({ workspaceId: ws!.id, name: `plan-a-${stamp}`, runtimeMode: "local", runtimeId: rt!.id, ownerId: u.id })
      .returning();
    const [agB] = await db
      .insert(agent)
      .values({ workspaceId: ws!.id, name: `plan-b-${stamp}`, runtimeMode: "local", runtimeId: rt!.id, ownerId: u.id })
      .returning();
    // Agent-less runtime for the empty-plan happy path.
    const [rtEmpty] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "plan-rt-empty", runtimeMode: "cloud", provider: "codex", ownerId: u.id })
      .returning();
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };
    const cascade = (rtId: string, bodyJson: string) =>
      app.request(`/api/runtimes/${rtId}/archive-agents-and-delete`, {
        method: "POST",
        headers: auth,
        body: bodyJson,
      });

    try {
      // Confirmed snapshot missing agB → 409 with the FRESH set, name-ordered.
      const stale = await cascade(rt!.id, JSON.stringify({ expected_active_agent_ids: [agA!.id] }));
      expect(stale.status).toBe(409);
      const conflict = (await stale.json()) as CascadeConflictResp;
      expect(conflict.code).toBe("runtime_delete_plan_changed");
      expect(conflict.error).toBe("the active agent set changed; please review and confirm again.");
      expect(conflict.active_agents.map((a) => a.id)).toEqual([agA!.id, agB!.id]);
      expect(conflict.active_agents[0]!.skills).toEqual([]);
      expect(conflict.active_agents[0]!.archived_at).toBeNull();

      // Empty plan against live agents is also a mismatch → 409.
      const empty = await cascade(rt!.id, JSON.stringify({ expected_active_agent_ids: [] }));
      expect(empty.status).toBe(409);

      // Nothing was touched by the refused attempts.
      expect(await db.select().from(agentRuntime).where(eq(agentRuntime.id, rt!.id))).toHaveLength(1);
      const agents = await db.select().from(agent).where(inArray(agent.id, [agA!.id, agB!.id]));
      expect(agents.every((a) => a.archivedAt === null)).toBe(true);

      // Malformed id list → 400; non-array → 400; malformed JSON → 400.
      const badIds = await cascade(rt!.id, JSON.stringify({ expected_active_agent_ids: ["nope"] }));
      expect(badIds.status).toBe(400);
      expect(((await badIds.json()) as { error: string }).error).toBe(
        "expected_active_agent_ids must be a list of valid UUIDs",
      );
      const notArray = await cascade(rt!.id, JSON.stringify({ expected_active_agent_ids: "x" }));
      expect(notArray.status).toBe(400);
      const badJson = await cascade(rt!.id, "{");
      expect(badJson.status).toBe(400);

      // Empty plan on an agent-less runtime succeeds and deletes it.
      const ok = await cascade(rtEmpty!.id, JSON.stringify({ expected_active_agent_ids: [] }));
      expect(ok.status).toBe(200);
      const okBody = (await ok.json()) as CascadeOkResp;
      expect(okBody.agents_archived).toBe(0);
      expect(okBody.tasks_cancelled).toBe(0);
      expect(await db.select().from(agentRuntime).where(eq(agentRuntime.id, rtEmpty!.id))).toHaveLength(0);
    } finally {
      await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "all four endpoints 404 across workspaces and for non-members",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = buildApp(db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rta-xws-${stamp}@bytedance.com`, cfg);
    const { user: outsider } = await findOrCreateUser(db, `bun-rta-out-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const outToken = await issueJWT({ sub: outsider.id, email: outsider.email, name: outsider.name }, SECRET);
    const [ws1] = await db
      .insert(workspace)
      .values({ name: "RTA X1", slug: `bun-rta-x1-${stamp}`, issuePrefix: "RX1" })
      .returning();
    const [ws2] = await db
      .insert(workspace)
      .values({ name: "RTA X2", slug: `bun-rta-x2-${stamp}`, issuePrefix: "RX2" })
      .returning();
    await db.insert(member).values([
      { workspaceId: ws1!.id, userId: u.id, role: "owner" },
      { workspaceId: ws2!.id, userId: u.id, role: "owner" },
    ]);
    const [rt] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws1!.id, name: "xws-rt", runtimeMode: "local", provider: "claude", ownerId: u.id })
      .returning();
    // Member of ws2 asking about a ws1 runtime → 404, never cross-tenant data.
    const wrongWs = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws2!.id,
      "Content-Type": "application/json",
    };

    try {
      const patch = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PATCH",
        headers: wrongWs,
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(patch.status).toBe(404);

      const activity = await app.request(`/api/runtimes/${rt!.id}/activity`, { headers: wrongWs });
      expect(activity.status).toBe(404);

      const byHour = await app.request(`/api/runtimes/${rt!.id}/usage/by-hour`, { headers: wrongWs });
      expect(byHour.status).toBe(404);

      const cascade = await app.request(`/api/runtimes/${rt!.id}/archive-agents-and-delete`, {
        method: "POST",
        headers: wrongWs,
        body: JSON.stringify({ expected_active_agent_ids: [] }),
      });
      expect(cascade.status).toBe(404);

      // Non-member of the runtime's workspace → 404 at the membership gate.
      const nonMember = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${outToken}`,
          "X-Workspace-ID": ws1!.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(nonMember.status).toBe(404);

      // The refused calls really left the runtime untouched.
      const [still] = await db.select().from(agentRuntime).where(eq(agentRuntime.id, rt!.id));
      expect(still!.visibility).toBe("private");
    } finally {
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws1!.id));
      await db.delete(member).where(inArray(member.workspaceId, [ws1!.id, ws2!.id]));
      await db.delete(workspace).where(inArray(workspace.id, [ws1!.id, ws2!.id]));
      await db.delete(user).where(inArray(user.id, [u.id, outsider.id]));
      await close();
    }
  },
);
