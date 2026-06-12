import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import {
  user,
  member,
  workspace,
  agent,
  agentRuntime,
  autopilot,
  autopilotTrigger,
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

type AutopilotJSON = {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  assignee_type: string;
  assignee_id: string;
  status: string;
  execution_mode: string;
  issue_title_template: string | null;
  created_by_type: string;
  created_by_id: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

test.skipIf(!reachable)(
  "autopilots read path: list newest-first + get with triggers, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-ap-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Autopilot WS", slug: `bun-ap-${stamp}`, issuePrefix: "AP" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    // agent needs a runtime (NOT-NULL FK runtime_id → agent_runtime).
    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "rt",
        runtimeMode: "cloud",
        provider: `prov-${stamp}`,
        status: "offline",
      })
      .returning();
    const [ag] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: `Agent ${stamp}`,
        runtimeMode: "cloud",
        runtimeId: rt!.id,
      })
      .returning();

    // Two autopilots; the second is inserted later so it sorts first (DESC).
    const [ap1] = await db
      .insert(autopilot)
      .values({
        workspaceId: ws!.id,
        title: "Older Pilot",
        assigneeType: "agent",
        assigneeId: ag!.id,
        status: "active",
        executionMode: "create_issue",
        createdByType: "member",
        createdById: u.id,
        createdAt: "2024-01-01T00:00:00Z",
      })
      .returning();
    const [ap2] = await db
      .insert(autopilot)
      .values({
        workspaceId: ws!.id,
        title: "Newer Pilot",
        assigneeType: "agent",
        assigneeId: ag!.id,
        status: "paused",
        executionMode: "run_only",
        createdByType: "member",
        createdById: u.id,
        createdAt: "2025-01-01T00:00:00Z",
      })
      .returning();

    // A schedule trigger on the newer pilot, surfaced by the get endpoint.
    await db.insert(autopilotTrigger).values({
      autopilotId: ap2!.id,
      kind: "schedule",
      enabled: true,
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    });

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // list — newest first
      const listRes = await app.request("/api/autopilots", { headers: auth });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { autopilots: AutopilotJSON[]; total: number };
      expect(list.total).toBe(2);
      expect(list.autopilots.map((a) => a.title)).toEqual(["Newer Pilot", "Older Pilot"]);
      expect(list.autopilots[0]!.workspace_id).toBe(ws!.id);
      expect(list.autopilots[0]!.assignee_type).toBe("agent");
      expect(list.autopilots[0]!.execution_mode).toBe("run_only");

      // list with status filter
      const filtered = await app.request("/api/autopilots?status=paused", { headers: auth });
      const filteredJson = (await filtered.json()) as { autopilots: AutopilotJSON[]; total: number };
      expect(filteredJson.total).toBe(1);
      expect(filteredJson.autopilots[0]!.title).toBe("Newer Pilot");

      // get — includes triggers
      const getRes = await app.request(`/api/autopilots/${ap2!.id}`, { headers: auth });
      expect(getRes.status).toBe(200);
      const detail = (await getRes.json()) as {
        autopilot: AutopilotJSON;
        triggers: Array<{ id: string; kind: string; cron_expression: string | null; enabled: boolean }>;
      };
      expect(detail.autopilot.id).toBe(ap2!.id);
      expect(detail.triggers.length).toBe(1);
      expect(detail.triggers[0]!.kind).toBe("schedule");
      expect(detail.triggers[0]!.cron_expression).toBe("0 9 * * *");

      // get the older pilot — no triggers
      const getOlder = await app.request(`/api/autopilots/${ap1!.id}`, { headers: auth });
      const olderDetail = (await getOlder.json()) as { triggers: unknown[] };
      expect(olderDetail.triggers.length).toBe(0);

      // unknown id → 404
      const missing = await app.request(
        "/api/autopilots/11111111-1111-4111-8111-111111111111",
        { headers: auth },
      );
      expect(missing.status).toBe(404);

      // missing workspace header → 400
      const noWs = await app.request("/api/autopilots", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/autopilots", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(autopilotTrigger).where(eq(autopilotTrigger.autopilotId, ap2!.id));
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

test.skipIf(!reachable)(
  "POST /api/autopilots validates body + assignee, creates an active row",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-apc-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Autopilot Create WS", slug: `bun-apc-${stamp}`, issuePrefix: "APC" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "rt",
        runtimeMode: "cloud",
        provider: `prov-${stamp}`,
        status: "offline",
      })
      .returning();
    const [ag] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: `Agent ${stamp}`,
        runtimeMode: "cloud",
        runtimeId: rt!.id,
      })
      .returning();

    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    try {
      // create — valid
      const ok = await app.request("/api/autopilots", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          title: "Triage Pilot",
          assignee_id: ag!.id,
          assignee_type: "agent",
          execution_mode: "create_issue",
          description: "auto triage",
        }),
      });
      expect(ok.status).toBe(201);
      const created = (await ok.json()) as AutopilotJSON;
      expect(created.title).toBe("Triage Pilot");
      expect(created.status).toBe("active");
      expect(created.assignee_type).toBe("agent");
      expect(created.assignee_id).toBe(ag!.id);
      expect(created.execution_mode).toBe("create_issue");
      expect(created.created_by_type).toBe("member");
      expect(created.created_by_id).toBe(u.id);
      expect(created.workspace_id).toBe(ws!.id);
      expect(created.description).toBe("auto triage");

      // missing title → 400
      const noTitle = await app.request("/api/autopilots", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ assignee_id: ag!.id, execution_mode: "run_only" }),
      });
      expect(noTitle.status).toBe(400);

      // bad execution_mode → 400
      const badMode = await app.request("/api/autopilots", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ title: "X", assignee_id: ag!.id, execution_mode: "nope" }),
      });
      expect(badMode.status).toBe(400);

      // bad assignee_type → 400
      const badType = await app.request("/api/autopilots", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          title: "X",
          assignee_id: ag!.id,
          assignee_type: "human",
          execution_mode: "run_only",
        }),
      });
      expect(badType.status).toBe(400);

      // assignee agent not in workspace → 400
      const unknownAgent = await app.request("/api/autopilots", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          title: "X",
          assignee_id: "22222222-2222-4222-8222-222222222222",
          assignee_type: "agent",
          execution_mode: "run_only",
        }),
      });
      expect(unknownAgent.status).toBe(400);
    } finally {
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
