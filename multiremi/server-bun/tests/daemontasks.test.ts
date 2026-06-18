/**
 * Daemon write-path routes (server side): heartbeat, claim, report.
 * Live-DB tests gated on a reachable Postgres (skipIf), with fixtures inserted
 * via Drizzle and torn down in finally. Mirrors tests/labels.test.ts +
 * tests/daemon.test.ts (workspace → member → agent_runtime → agent → issue →
 * agent_task_queue fixture chain).
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { asc, eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import {
  user,
  member,
  workspace,
  issue,
  agent,
  agentRuntime,
  agentTaskQueue,
  taskMessage,
  taskUsage,
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

/** Build the full fixture chain. Returns ids + a cleanup fn (delete children → parents). */
async function setupFixture(db: ReturnType<typeof createDb>["db"], slug: string) {
  const { user: u } = await findOrCreateUser(db, `${slug}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "Daemon WS", slug, issuePrefix: "DTK", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" })
    .returning();
  const [ag] = await db
    .insert(agent)
    .values({
      workspaceId: ws!.id,
      name: "Worker",
      runtimeId: rt!.id,
      runtimeMode: "local",
      instructions: "do work",
      ownerId: u.id,
    })
    .returning();
  const [iss] = await db
    .insert(issue)
    .values({ workspaceId: ws!.id, title: "task issue", creatorType: "member", creatorId: u.id, number: 1 })
    .returning();

  const cleanup = async () => {
    await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
  };

  return { u, ws: ws!, rt: rt!, ag: ag!, iss: iss!, cleanup };
}

test.skipIf(!reachable)("POST /api/runtimes/:id/heartbeat marks runtime online + bumps last_seen_at", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { u, ws, rt, cleanup } = await setupFixture(db, `bun-dt-hb-${stamp}`);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws.id, "Content-Type": "application/json" };

  try {
    // runtime starts offline (schema default), last_seen_at null
    const [before] = await db.select().from(agentRuntime).where(eq(agentRuntime.id, rt.id));
    expect(before!.status).toBe("offline");
    expect(before!.lastSeenAt).toBeNull();

    const res = await app.request(`/api/runtimes/${rt.id}/heartbeat`, { method: "POST", headers: auth, body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });

    const [after] = await db.select().from(agentRuntime).where(eq(agentRuntime.id, rt.id));
    expect(after!.status).toBe("online");
    expect(after!.lastSeenAt).not.toBeNull();

    // missing workspace header → 400
    const noWs = await app.request(`/api/runtimes/${rt.id}/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(noWs.status).toBe(400);

    // unknown runtime → 404
    const gone = await app.request(`/api/runtimes/00000000-0000-4000-8000-000000000000/heartbeat`, {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    expect(gone.status).toBe(404);
  } finally {
    await cleanup();
    await close();
  }
});

test.skipIf(!reachable)("POST /api/daemon/claim claims next queued task + returns agent context; empty → null", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { u, ws, rt, ag, iss, cleanup } = await setupFixture(db, `bun-dt-cl-${stamp}`);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws.id, "Content-Type": "application/json" };

  const [task] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "queued" })
    .returning();

  try {
    const res = await app.request("/api/daemon/claim", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ runtime_id: rt.id }),
    });
    expect(res.status).toBe(200);
    const claimed = (await res.json()) as {
      task: { id: string; status: string; workspace_id: string; agent: { id: string; name: string; instructions: string } } | null;
    };
    expect(claimed.task).not.toBeNull();
    expect(claimed.task!.id).toBe(task!.id);
    expect(claimed.task!.status).toBe("dispatched"); // claim flips queued → dispatched
    expect(claimed.task!.workspace_id).toBe(ws.id);
    expect(claimed.task!.agent.id).toBe(ag.id);
    expect(claimed.task!.agent.name).toBe("Worker");
    expect(claimed.task!.agent.instructions).toBe("do work");

    // queue now empty → { task: null }
    const empty = await app.request("/api/daemon/claim", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ runtime_id: rt.id }),
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ task: null });

    // missing runtime_id → 400
    const noRt = await app.request("/api/daemon/claim", { method: "POST", headers: auth, body: "{}" });
    expect(noRt.status).toBe(400);

    // a member of another workspace can't claim against this runtime → 404
    const otherStamp = stamp + 1;
    const { u: u2, cleanup: cleanup2 } = await setupFixture(db, `bun-dt-cl2-${otherStamp}`);
    const token2 = await issueJWT({ sub: u2.id, email: u2.email, name: u2.name }, SECRET);
    try {
      // u2 is a member of ws2 (its own header), but the runtime lives in ws1 → 404
      const foreign = await app.request("/api/daemon/claim", {
        method: "POST",
        headers: { Authorization: `Bearer ${token2}`, "X-Workspace-ID": ws.id, "Content-Type": "application/json" },
        body: JSON.stringify({ runtime_id: rt.id }),
      });
      // u2 is not a member of ws1 → workspace gate 404
      expect(foreign.status).toBe(404);
    } finally {
      await cleanup2();
    }
  } finally {
    await cleanup();
    await close();
  }
});

test.skipIf(!reachable)("POST /api/daemon/tasks/:id/report writes completed + failed; idempotent re-report", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { u, ws, rt, ag, iss, cleanup } = await setupFixture(db, `bun-dt-rp-${stamp}`);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws.id, "Content-Type": "application/json" };

  // A dispatched task is reportable (WHERE status IN dispatched/running/...).
  const [done] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "dispatched" })
    .returning();
  const [fail] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, status: "running" })
    .returning();

  try {
    // completed report writes result + status
    const okRes = await app.request(`/api/daemon/tasks/${done!.id}/report`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: "completed", output: "all good", pr_url: "https://x/pr/1", session_id: "sess-1" }),
    });
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { status: string; result: { output: string } };
    expect(okBody.status).toBe("completed");
    expect(okBody.result.output).toBe("all good");

    const [afterDone] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, done!.id));
    expect(afterDone!.status).toBe("completed");
    expect(afterDone!.completedAt).not.toBeNull();
    expect(afterDone!.sessionId).toBe("sess-1");

    // re-reporting an already-completed task is idempotent (returns current row, 200)
    const again = await app.request(`/api/daemon/tasks/${done!.id}/report`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: "completed", output: "ignored" }),
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("completed");

    // failed report writes error + default failure_reason
    const failRes = await app.request(`/api/daemon/tasks/${fail!.id}/report`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: "failed", error: "boom" }),
    });
    expect(failRes.status).toBe(200);
    const failBody = (await failRes.json()) as { status: string; error: string; failure_reason?: string };
    expect(failBody.status).toBe("failed");
    expect(failBody.error).toBe("boom");
    expect(failBody.failure_reason).toBe("agent_error");

    const [afterFail] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, fail!.id));
    expect(afterFail!.status).toBe("failed");
    expect(afterFail!.error).toBe("boom");

    // unknown status → 400
    const badStatus = await app.request(`/api/daemon/tasks/${done!.id}/report`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: "weird" }),
    });
    expect(badStatus.status).toBe(400);

    // unknown task → 404
    const noTask = await app.request(`/api/daemon/tasks/00000000-0000-4000-8000-000000000000/report`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: "completed" }),
    });
    expect(noTask.status).toBe(404);

    // missing workspace header → 400
    const noWs = await app.request(`/api/daemon/tasks/${done!.id}/report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(noWs.status).toBe(400);
  } finally {
    await cleanup();
    await close();
  }
});

test.skipIf(!reachable)("daemon split protocol claims, starts, reports usage, completes, and recovers orphans", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { u, ws, rt, ag, iss, cleanup } = await setupFixture(db, `bun-dt-sp-${stamp}`);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws.id, "Content-Type": "application/json" };

  const [queued] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "queued" })
    .returning();
  const [orphan] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "running" })
    .returning();

  try {
    const claim = await app.request(`/api/daemon/runtimes/${rt.id}/tasks/claim`, {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as { task: { id: string; status: string; agent: { instructions: string } } | null };
    expect(claimed.task?.id).toBe(queued!.id);
    expect(claimed.task?.status).toBe("dispatched");
    expect(claimed.task?.agent.instructions).toBe("do work");

    const start = await app.request(`/api/daemon/tasks/${queued!.id}/start`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ session_id: "sess-start", work_dir: "/tmp/remi-work" }),
    });
    expect(start.status).toBe(200);
    expect(((await start.json()) as { status: string }).status).toBe("running");

    const messages = await app.request(`/api/daemon/tasks/${queued!.id}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        messages: [
          { seq: 1, type: "thinking", content: "planning the change" },
          { seq: 2, type: "tool_use", tool: "bash", input: { command: "pwd" } },
        ],
      }),
    });
    expect(messages.status).toBe(200);
    expect(await messages.json()).toEqual({ status: "ok", persisted: 2 });
    const messageRows = await db
      .select()
      .from(taskMessage)
      .where(eq(taskMessage.taskId, queued!.id))
      .orderBy(asc(taskMessage.seq));
    expect(messageRows).toHaveLength(2);
    expect(messageRows[0]!.type).toBe("thinking");
    expect(messageRows[0]!.content).toBe("planning the change");
    expect(messageRows[1]!.type).toBe("tool_use");
    expect(messageRows[1]!.tool).toBe("bash");

    const usage = await app.request(`/api/daemon/tasks/${queued!.id}/usage`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        usage: [{ provider: "codex", model: "gpt-test", inputTokens: 10, outputTokens: 20, cacheReadTokens: 3 }],
      }),
    });
    expect(usage.status).toBe(200);
    const [usageRow] = await db.select().from(taskUsage).where(eq(taskUsage.taskId, queued!.id));
    expect(usageRow!.provider).toBe("codex");
    expect(usageRow!.model).toBe("gpt-test");
    expect(usageRow!.inputTokens).toBe(10);
    expect(usageRow!.outputTokens).toBe(20);
    expect(usageRow!.cacheReadTokens).toBe(3);

    const session = await app.request(`/api/daemon/tasks/${queued!.id}/session`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ session_id: "sess-final", work_dir: "/tmp/remi-final" }),
    });
    expect(session.status).toBe(200);

    const status = await app.request(`/api/daemon/tasks/${queued!.id}/status`, { method: "GET", headers: auth });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: "running" });

    const complete = await app.request(`/api/daemon/tasks/${queued!.id}/complete`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "done", session_id: "sess-final", work_dir: "/tmp/remi-final" }),
    });
    expect(complete.status).toBe(200);
    expect(((await complete.json()) as { status: string }).status).toBe("completed");
    const [done] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, queued!.id));
    expect(done!.sessionId).toBe("sess-final");
    expect(done!.workDir).toBe("/tmp/remi-final");

    const recover = await app.request(`/api/daemon/runtimes/${rt.id}/recover-orphans`, {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    expect(recover.status).toBe(200);
    expect(await recover.json()).toEqual({ recovered: 1 });
    const [recovered] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, orphan!.id));
    expect(recovered!.status).toBe("queued");
    expect(recovered!.startedAt).toBeNull();
  } finally {
    await db.delete(taskMessage).where(eq(taskMessage.taskId, queued!.id));
    await db.delete(taskUsage).where(eq(taskUsage.taskId, queued!.id));
    await cleanup();
    await close();
  }
});
