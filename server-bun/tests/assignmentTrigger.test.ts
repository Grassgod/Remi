/**
 * Assignment-driven dispatch (src/agent/assignmentTrigger.ts) + the
 * quick-create endpoint: the kanban triggers that turn board actions into
 * agent_task_queue rows.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import {
  agent,
  agentRuntime,
  agentTaskQueue,
  issue,
  member,
  user,
  workspace,
} from "../src/db/schema.js";
import type { Config } from "../src/config.js";

const SECRET = "test-secret-0123456789";
const cfg: Config = {
  port: 0,
  jwtSecret: SECRET,
  authTokenTtlSeconds: 3600,
  databaseUrl: "",
  allowedEmailDomains: [],
};

const DB_URL =
  process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

async function activeTasks(db: ReturnType<typeof createDb>["db"], issueId: string) {
  return db
    .select()
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.issueId, issueId),
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running", "waiting_local_directory"]),
      ),
    );
}

test.skipIf(!reachable)(
  "assign → enqueue; reassign cancels + re-enqueues; cancelled status cancels; backlog parks",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-at-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "AT WS", slug: `bun-at-${stamp}`, issuePrefix: "AT" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "rt", runtimeMode: "local", provider: "codex", ownerId: u.id })
      .returning();
    const [ag1] = await db
      .insert(agent)
      .values({ workspaceId: ws!.id, runtimeId: rt!.id, name: "a1", runtimeMode: "local", ownerId: u.id })
      .returning();
    const [ag2] = await db
      .insert(agent)
      .values({ workspaceId: ws!.id, runtimeId: rt!.id, name: "a2", runtimeMode: "local", ownerId: u.id })
      .returning();
    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "dispatch me",
        status: "todo",
        priority: "high",
        creatorType: "member",
        creatorId: u.id,
        number: 1,
      })
      .returning();
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    try {
      // 1. Assign the agent → one queued task (priority high → 3).
      let res = await app.request(`/api/issues/${iss!.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ assignee_type: "agent", assignee_id: ag1!.id }),
      });
      expect(res.status).toBe(200);
      let tasks = await activeTasks(db, iss!.id);
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.agentId).toBe(ag1!.id);
      expect(tasks[0]!.priority).toBe(3);

      // 2. Reassign to another agent → old cancelled, fresh task for ag2.
      res = await app.request(`/api/issues/${iss!.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ assignee_type: "agent", assignee_id: ag2!.id }),
      });
      expect(res.status).toBe(200);
      tasks = await activeTasks(db, iss!.id);
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.agentId).toBe(ag2!.id);

      // 3. Cancel the issue → no active tasks left.
      res = await app.request(`/api/issues/${iss!.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ status: "cancelled" }),
      });
      expect(res.status).toBe(200);
      tasks = await activeTasks(db, iss!.id);
      expect(tasks.length).toBe(0);

      // 4. Backlog parking lot: a fresh issue assigned while in backlog does
      //    NOT dispatch; promoting it to todo does.
      const [parked] = await db
        .insert(issue)
        .values({
          workspaceId: ws!.id,
          title: "parked",
          status: "backlog",
          priority: "none",
          creatorType: "member",
          creatorId: u.id,
          number: 2,
        })
        .returning();
      res = await app.request(`/api/issues/${parked!.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ assignee_type: "agent", assignee_id: ag1!.id }),
      });
      expect(res.status).toBe(200);
      expect((await activeTasks(db, parked!.id)).length).toBe(0);

      res = await app.request(`/api/issues/${parked!.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ status: "todo" }),
      });
      expect(res.status).toBe(200);
      const promoted = await activeTasks(db, parked!.id);
      expect(promoted.length).toBe(1);
      expect(promoted[0]!.agentId).toBe(ag1!.id);

      await db.delete(agentTaskQueue).where(eq(agentTaskQueue.issueId, parked!.id));
    } finally {
      await db.delete(agentTaskQueue).where(inArray(agentTaskQueue.agentId, [ag1!.id, ag2!.id]));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.id, rt!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "POST /api/issues/quick-create → issue (origin quick_create) + queued task + {task_id}",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-qc-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "QC WS", slug: `bun-qc-${stamp}`, issuePrefix: "QC" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "rt", runtimeMode: "local", provider: "codex", ownerId: u.id })
      .returning();
    const [ag] = await db
      .insert(agent)
      .values({ workspaceId: ws!.id, runtimeId: rt!.id, name: "qa", runtimeMode: "local", ownerId: u.id })
      .returning();
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    let created: string | undefined;
    try {
      // Validation: prompt required; agent XOR squad.
      let res = await app.request("/api/issues/quick-create", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ agent_id: ag!.id, prompt: "" }),
      });
      expect(res.status).toBe(400);
      res = await app.request("/api/issues/quick-create", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ prompt: "x" }),
      });
      expect(res.status).toBe(400);

      // Happy path.
      const prompt = "实现一个工具\n详细描述在第二行";
      res = await app.request("/api/issues/quick-create", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ agent_id: ag!.id, prompt }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { task_id: string };
      expect(body.task_id).toBeTruthy();

      const [task] = await db
        .select()
        .from(agentTaskQueue)
        .where(eq(agentTaskQueue.id, body.task_id));
      expect(task!.status).toBe("queued");
      expect(task!.agentId).toBe(ag!.id);
      created = task!.issueId ?? undefined;
      expect(created).toBeTruthy();

      const [iss] = await db.select().from(issue).where(eq(issue.id, created!));
      expect(iss!.originType).toBe("quick_create");
      expect(iss!.status).toBe("todo");
      expect(iss!.title).toBe("实现一个工具");
      expect(iss!.description).toBe(prompt);
      expect(iss!.assigneeType).toBe("agent");
      expect(iss!.assigneeId).toBe(ag!.id);
    } finally {
      await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
      if (created) await db.delete(issue).where(eq(issue.id, created));
      await db.delete(agent).where(eq(agent.id, ag!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.id, rt!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
