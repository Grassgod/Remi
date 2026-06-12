/**
 * Tests for the agent task history + autopilot run history routes
 * (src/http/routes/agentTaskLists.ts). DB-gated: skipped when Postgres is
 * unreachable. The factory is not yet mounted in app.ts, so each test builds
 * createApp (real JWT + workspace middlewares) and mounts the factory at the
 * root, exactly as app.ts will.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { agentTaskListsRoutes } from "../src/http/routes/agentTaskLists.js";
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
  autopilotRun,
  issue,
} from "../src/db/schema.js";
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

type TaskJSON = {
  id: string;
  agent_id: string;
  runtime_id: string;
  issue_id: string;
  workspace_id: string;
  status: string;
  priority: number;
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  result: unknown;
  error: string | null;
  failure_reason?: string;
  attempt: number;
  max_attempts: number;
  parent_task_id?: string;
  created_at: string;
  trigger_comment_id?: string;
  trigger_summary?: string;
  work_dir?: string;
  relative_work_dir?: string;
  chat_session_id?: string;
  autopilot_run_id?: string;
  kind: string;
};

type RunJSON = {
  id: string;
  autopilot_id: string;
  trigger_id: string | null;
  source: string;
  status: string;
  issue_id: string | null;
  task_id: string | null;
  triggered_at: string;
  completed_at: string | null;
  failure_reason: string | null;
  trigger_payload: unknown;
  result: unknown;
  created_at: string;
};

function buildApp(db: ReturnType<typeof createDb>["db"]) {
  const app = createApp(cfg, db);
  // The factory declares absolute /api/* paths; app.ts will mount it the same
  // way. The /api/* JWT gate registered inside createApp still applies.
  app.route("/", agentTaskListsRoutes(db));
  return app;
}

test.skipIf(!reachable)(
  "GET /api/agents/:id/tasks returns history newest-first with Go-shaped JSON",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = buildApp(db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-atl-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "TaskList WS", slug: `bun-atl-${stamp}`, issuePrefix: "ATL" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "rt",
        runtimeMode: "local", // CHECK: must be 'local' | 'cloud'
        provider: `prov-${stamp}`,
        status: "offline",
      })
      .returning();
    const [ag] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: `Agent ${stamp}`,
        runtimeMode: "local",
        runtimeId: rt!.id,
        visibility: "workspace",
        ownerId: u.id,
      })
      .returning();

    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Task list issue",
        creatorType: "member",
        creatorId: u.id,
      })
      .returning();

    // Autopilot + run so one task can carry autopilot_run_id (kind=autopilot).
    const [ap] = await db
      .insert(autopilot)
      .values({
        workspaceId: ws!.id,
        title: "Pilot",
        assigneeType: "agent",
        assigneeId: ag!.id,
        status: "active",
        executionMode: "run_only",
        createdByType: "member",
        createdById: u.id,
      })
      .returning();
    const [run] = await db
      .insert(autopilotRun)
      .values({ autopilotId: ap!.id, source: "manual", status: "running" })
      .returning();

    // Oldest: issue-linked, completed, with a work_dir under a home prefix.
    const [tA] = await db
      .insert(agentTaskQueue)
      .values({
        agentId: ag!.id,
        runtimeId: rt!.id,
        issueId: iss!.id,
        status: "completed",
        priority: 5,
        result: { pr_url: "https://example.test/pr/1" },
        workDir: "/Users/alice/repos/foo",
        dispatchedAt: "2024-01-01T00:01:00Z",
        startedAt: "2024-01-01T00:02:00Z",
        completedAt: "2024-01-01T00:10:00Z",
        createdAt: "2024-01-01T00:00:00Z",
      })
      .returning();
    // Middle: no linked issue, queued → kind quick_create, all-null optionals.
    const [tB] = await db
      .insert(agentTaskQueue)
      .values({
        agentId: ag!.id,
        runtimeId: rt!.id,
        status: "queued",
        createdAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    // Newest: autopilot-spawned → kind autopilot.
    const [tC] = await db
      .insert(agentTaskQueue)
      .values({
        agentId: ag!.id,
        runtimeId: rt!.id,
        status: "running",
        autopilotRunId: run!.id,
        createdAt: "2025-06-01T00:00:00Z",
      })
      .returning();

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      const res = await app.request(`/api/agents/${ag!.id}/tasks`, { headers: auth });
      expect(res.status).toBe(200);
      const tasks = (await res.json()) as TaskJSON[];
      expect(tasks.length).toBe(3);
      // Newest first (created_at DESC).
      expect(tasks.map((t) => t.id)).toEqual([tC!.id, tB!.id, tA!.id]);

      const [jC, jB, jA] = tasks as [TaskJSON, TaskJSON, TaskJSON];

      // tC — autopilot-spawned.
      expect(jC.kind).toBe("autopilot");
      expect(jC.autopilot_run_id).toBe(run!.id);
      expect(jC.issue_id).toBe(""); // NULL issue serializes as "" (Go uuidToString)
      expect(jC.status).toBe("running");
      expect(jC.workspace_id).toBe(ws!.id);
      expect(jC.agent_id).toBe(ag!.id);
      expect(jC.runtime_id).toBe(rt!.id);

      // tB — quick_create: always-present nullables are null, omitempty keys absent.
      expect(jB.kind).toBe("quick_create");
      expect(jB.dispatched_at).toBeNull();
      expect(jB.started_at).toBeNull();
      expect(jB.completed_at).toBeNull();
      expect(jB.result).toBeNull();
      expect(jB.error).toBeNull();
      expect(jB.attempt).toBe(1);
      expect(jB.max_attempts).toBe(2);
      expect(jB.priority).toBe(0);
      expect("failure_reason" in jB).toBe(false);
      expect("parent_task_id" in jB).toBe(false);
      expect("trigger_comment_id" in jB).toBe(false);
      expect("trigger_summary" in jB).toBe(false);
      expect("work_dir" in jB).toBe(false);
      expect("relative_work_dir" in jB).toBe(false);
      expect("chat_session_id" in jB).toBe(false);
      expect("autopilot_run_id" in jB).toBe(false);

      // tA — issue-linked direct task with privacy-safe relative_work_dir.
      expect(jA.kind).toBe("direct");
      expect(jA.issue_id).toBe(iss!.id);
      expect(jA.result).toEqual({ pr_url: "https://example.test/pr/1" });
      expect(jA.work_dir).toBe("/Users/alice/repos/foo");
      expect(jA.relative_work_dir).toBe("repos/foo"); // home prefix stripped
      expect(jA.dispatched_at).not.toBeNull();
      expect(jA.completed_at).not.toBeNull();
      expect(jA.priority).toBe(5);

      // Malformed agent id → 400 (Go parseUUIDOrBadRequest).
      const bad = await app.request("/api/agents/not-a-uuid/tasks", { headers: auth });
      expect(bad.status).toBe(400);

      // Unknown agent → 404.
      const missing = await app.request(
        "/api/agents/11111111-1111-4111-8111-111111111111/tasks",
        { headers: auth },
      );
      expect(missing.status).toBe(404);

      // Missing workspace header → 400.
      const noWs = await app.request(`/api/agents/${ag!.id}/tasks`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);
    } finally {
      await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
      await db.delete(autopilotRun).where(eq(autopilotRun.autopilotId, ap!.id));
      await db.delete(autopilot).where(eq(autopilot.workspaceId, ws!.id));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
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
  "GET /api/agents/:id/tasks gates private agents: owner 200, plain member 403, ws owner 200",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = buildApp(db);
    const stamp = Date.now();
    const { user: wsOwner } = await findOrCreateUser(db, `bun-atlp-own-${stamp}@bytedance.com`, cfg);
    const { user: agentOwner } = await findOrCreateUser(db, `bun-atlp-ag-${stamp}@bytedance.com`, cfg);
    const { user: plainMember } = await findOrCreateUser(db, `bun-atlp-pm-${stamp}@bytedance.com`, cfg);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Private WS", slug: `bun-atlp-${stamp}`, issuePrefix: "ATP" })
      .returning();
    await db.insert(member).values([
      { workspaceId: ws!.id, userId: wsOwner.id, role: "owner" },
      { workspaceId: ws!.id, userId: agentOwner.id, role: "member" },
      { workspaceId: ws!.id, userId: plainMember.id, role: "member" },
    ]);

    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "rt",
        runtimeMode: "local",
        provider: `prov-p-${stamp}`,
        status: "offline",
      })
      .returning();
    // visibility 'private' (also the column default) + an owner who is a plain
    // member — mirrors Go's privateAgentTestFixture.
    const [ag] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: `Private Agent ${stamp}`,
        runtimeMode: "local",
        runtimeId: rt!.id,
        visibility: "private",
        ownerId: agentOwner.id,
      })
      .returning();

    const tokenFor = async (uid: string, email: string) =>
      issueJWT({ sub: uid, email, name: email }, SECRET);
    const headersFor = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
    });

    try {
      // Agent owner (plain member who owns the agent): 200.
      const ownerRes = await app.request(`/api/agents/${ag!.id}/tasks`, {
        headers: headersFor(await tokenFor(agentOwner.id, agentOwner.email)),
      });
      expect(ownerRes.status).toBe(200);
      expect((await ownerRes.json()) as TaskJSON[]).toEqual([]);

      // Plain member: 403 (mirrors TestListAgentTasks_PrivateAgentForbidsPlainMember).
      const memberRes = await app.request(`/api/agents/${ag!.id}/tasks`, {
        headers: headersFor(await tokenFor(plainMember.id, plainMember.email)),
      });
      expect(memberRes.status).toBe(403);
      expect(((await memberRes.json()) as { error: string }).error).toBe(
        "you do not have access to this agent",
      );

      // Workspace owner role: allowed by the implicit allowed_principals set.
      const adminRes = await app.request(`/api/agents/${ag!.id}/tasks`, {
        headers: headersFor(await tokenFor(wsOwner.id, wsOwner.email)),
      });
      expect(adminRes.status).toBe(200);
    } finally {
      await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, wsOwner.id));
      await db.delete(user).where(eq(user.id, agentOwner.id));
      await db.delete(user).where(eq(user.id, plainMember.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "autopilot runs: paginated slim list + full detail + cross-autopilot 404",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = buildApp(db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-atlr-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Runs WS", slug: `bun-atlr-${stamp}`, issuePrefix: "ATR" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "rt",
        runtimeMode: "cloud",
        provider: `prov-r-${stamp}`,
        status: "offline",
      })
      .returning();
    const [ag] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: `Runs Agent ${stamp}`,
        runtimeMode: "cloud",
        runtimeId: rt!.id,
      })
      .returning();

    const pilotBase = {
      workspaceId: ws!.id,
      assigneeType: "agent",
      assigneeId: ag!.id,
      status: "active",
      executionMode: "run_only",
      createdByType: "member",
      createdById: u.id,
    };
    const [ap1] = await db
      .insert(autopilot)
      .values({ ...pilotBase, title: "Pilot One" })
      .returning();
    const [ap2] = await db
      .insert(autopilot)
      .values({ ...pilotBase, title: "Pilot Two" })
      .returning();

    // Three runs on ap1, statuses/sources within the CHECK sets:
    // status ∈ {issue_created,running,completed,failed,skipped},
    // source ∈ {schedule,manual,webhook,api}.
    const [r1] = await db
      .insert(autopilotRun)
      .values({
        autopilotId: ap1!.id,
        source: "schedule",
        status: "completed",
        completedAt: "2024-01-01T01:00:00Z",
        result: { created_issue: "ATR-1" },
        createdAt: "2024-01-01T00:00:00Z",
      })
      .returning();
    const [r2] = await db
      .insert(autopilotRun)
      .values({
        autopilotId: ap1!.id,
        source: "manual",
        status: "failed",
        failureReason: "boom",
        createdAt: "2024-06-01T00:00:00Z",
      })
      .returning();
    const [r3] = await db
      .insert(autopilotRun)
      .values({
        autopilotId: ap1!.id,
        source: "webhook",
        status: "running",
        triggerPayload: { hello: "world" },
        createdAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    // A run on the OTHER autopilot — must 404 when fetched via ap1's URL.
    const [rX] = await db
      .insert(autopilotRun)
      .values({ autopilotId: ap2!.id, source: "api", status: "skipped" })
      .returning();

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // Full list — newest first, trigger_payload always null (slim shape).
      const listRes = await app.request(`/api/autopilots/${ap1!.id}/runs`, { headers: auth });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { runs: RunJSON[]; total: number };
      expect(list.total).toBe(3);
      expect(list.runs.map((r) => r.id)).toEqual([r3!.id, r2!.id, r1!.id]);
      for (const r of list.runs) {
        expect(r.trigger_payload).toBeNull(); // omitted from list rows, even when stored
        expect(r.autopilot_id).toBe(ap1!.id);
        expect(r.trigger_id).toBeNull();
        expect(r.issue_id).toBeNull();
        expect(r.task_id).toBeNull();
      }
      const [jr3, jr2, jr1] = list.runs as [RunJSON, RunJSON, RunJSON];
      expect(jr3.source).toBe("webhook");
      expect(jr3.status).toBe("running");
      expect(jr2.failure_reason).toBe("boom");
      expect(jr2.status).toBe("failed");
      expect(jr1.result).toEqual({ created_issue: "ATR-1" });
      expect(jr1.completed_at).not.toBeNull();
      expect(jr1.source).toBe("schedule");

      // Pagination: limit + offset; total reflects the returned page length.
      const page1 = await app.request(`/api/autopilots/${ap1!.id}/runs?limit=2`, { headers: auth });
      const page1Json = (await page1.json()) as { runs: RunJSON[]; total: number };
      expect(page1Json.total).toBe(2);
      expect(page1Json.runs.map((r) => r.id)).toEqual([r3!.id, r2!.id]);
      const page2 = await app.request(`/api/autopilots/${ap1!.id}/runs?limit=2&offset=2`, {
        headers: auth,
      });
      const page2Json = (await page2.json()) as { runs: RunJSON[]; total: number };
      expect(page2Json.runs.map((r) => r.id)).toEqual([r1!.id]);

      // Invalid limit falls back to the default (mirrors Go's Atoi guard).
      const badLimit = await app.request(`/api/autopilots/${ap1!.id}/runs?limit=abc`, {
        headers: auth,
      });
      expect(((await badLimit.json()) as { runs: RunJSON[] }).runs.length).toBe(3);

      // Detail — full trigger_payload comes back.
      const detail = await app.request(`/api/autopilots/${ap1!.id}/runs/${r3!.id}`, {
        headers: auth,
      });
      expect(detail.status).toBe(200);
      const detailJson = (await detail.json()) as RunJSON;
      expect(detailJson.id).toBe(r3!.id);
      expect(detailJson.trigger_payload).toEqual({ hello: "world" });

      // Detail of a payload-less run — trigger_payload null.
      const detail1 = await app.request(`/api/autopilots/${ap1!.id}/runs/${r1!.id}`, {
        headers: auth,
      });
      expect(((await detail1.json()) as RunJSON).trigger_payload).toBeNull();

      // A runId belonging to another autopilot fails closed with 404.
      const cross = await app.request(`/api/autopilots/${ap1!.id}/runs/${rX!.id}`, {
        headers: auth,
      });
      expect(cross.status).toBe(404);

      // Malformed run id → 400.
      const badRun = await app.request(`/api/autopilots/${ap1!.id}/runs/not-a-uuid`, {
        headers: auth,
      });
      expect(badRun.status).toBe(400);

      // Unknown autopilot → 404.
      const noPilot = await app.request(
        "/api/autopilots/11111111-1111-4111-8111-111111111111/runs",
        { headers: auth },
      );
      expect(noPilot.status).toBe(404);
    } finally {
      await db.delete(autopilotRun).where(eq(autopilotRun.autopilotId, ap1!.id));
      await db.delete(autopilotRun).where(eq(autopilotRun.autopilotId, ap2!.id));
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
