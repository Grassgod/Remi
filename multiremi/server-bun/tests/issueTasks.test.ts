/**
 * Issue-scoped task + timeline routes: active-task, task-runs, usage, timeline,
 * cancel. Live-DB tests gated on a reachable Postgres (skipIf), with fixtures
 * inserted via Drizzle and torn down in finally. Mirrors tests/daemontasks.test.ts
 * (workspace → member → agent_runtime → agent → issue → agent_task_queue chain).
 *
 * issueTasksRoutes declares absolute /api/issues/:id/* paths and is not yet
 * mounted in app.ts, so each test mounts it onto the createApp shell (the JWT
 * gate registered by createApp still applies to routes added afterwards).
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { issueTasksRoutes } from "../src/http/routes/issueTasks.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { bus, type BusEvent } from "../src/realtime/bus.js";
import {
  user,
  member,
  workspace,
  issue,
  agent,
  agentRuntime,
  agentTaskQueue,
  taskUsage,
  comment,
  commentReaction,
  attachment,
  activityLog,
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
    .values({ name: "IssueTasks WS", slug, issuePrefix: "ITK", issueCounter: 0 })
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
    await db.delete(commentReaction).where(eq(commentReaction.workspaceId, ws!.id));
    await db.delete(attachment).where(eq(attachment.workspaceId, ws!.id));
    await db.delete(comment).where(eq(comment.workspaceId, ws!.id));
    await db.delete(activityLog).where(eq(activityLog.workspaceId, ws!.id));
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

function makeApp(db: ReturnType<typeof createDb>["db"]) {
  const app = createApp(cfg, db);
  app.route("/", issueTasksRoutes(db));
  return app;
}

test.skipIf(!reachable)("GET /api/issues/:id/active-task returns active tasks only; identifier + cross-workspace", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, rt, ag, iss, cleanup } = await setupFixture(db, `bun-itk-at-${stamp}`);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws.id };

  const [done] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "completed" })
    .returning();
  const [queued] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "queued", priority: 2 })
    .returning();
  const [running] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "running" })
    .returning();
  void done;

  try {
    const res = await app.request(`/api/issues/${iss.id}/active-task`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Record<string, unknown>[] };
    // queued + running only (completed excluded), newest first.
    expect(body.tasks.length).toBe(2);
    expect(body.tasks.map((t) => t.id)).toEqual([running!.id, queued!.id]);
    const q = body.tasks[1]!;
    expect(q.agent_id).toBe(ag.id);
    expect(q.runtime_id).toBe(rt.id);
    expect(q.issue_id).toBe(iss.id);
    expect(q.workspace_id).toBe(ws.id);
    expect(q.status).toBe("queued");
    expect(q.priority).toBe(2);
    expect(q.kind).toBe("direct");
    expect(q.result).toBeNull();
    expect(q.dispatched_at).toBeNull();
    // omitempty fields absent on a plain queued task
    expect("failure_reason" in q).toBe(false);
    expect("chat_session_id" in q).toBe(false);
    expect("work_dir" in q).toBe(false);

    // the :id param also accepts the human identifier
    const byIdent = await app.request(`/api/issues/ITK-1/active-task`, { headers: auth });
    expect(byIdent.status).toBe(200);
    expect(((await byIdent.json()) as { tasks: unknown[] }).tasks.length).toBe(2);

    // a member of another workspace can't read this issue's tasks → 404
    const { u: u2, ws: ws2, cleanup: cleanup2 } = await setupFixture(db, `bun-itk-at2-${stamp}`);
    const token2 = await issueJWT({ sub: u2.id, email: u2.email, name: u2.name }, SECRET);
    try {
      const foreign = await app.request(`/api/issues/${iss.id}/active-task`, {
        headers: { Authorization: `Bearer ${token2}`, "X-Workspace-ID": ws2.id },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await cleanup2();
    }
  } finally {
    await cleanup();
    await close();
  }
});

test.skipIf(!reachable)("GET /api/issues/:id/task-runs returns all tasks newest first", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, rt, ag, iss, cleanup } = await setupFixture(db, `bun-itk-tr-${stamp}`);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws.id };

  const [t1] = await db
    .insert(agentTaskQueue)
    .values({
      agentId: ag.id,
      runtimeId: rt.id,
      issueId: iss.id,
      status: "failed",
      error: "boom",
      failureReason: "agent_error",
    })
    .returning();
  const [t2] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "queued" })
    .returning();

  try {
    const res = await app.request(`/api/issues/${iss.id}/task-runs`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.length).toBe(2);
    expect(body.map((t) => t.id)).toEqual([t2!.id, t1!.id]);
    const failed = body[1]!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("boom");
    expect(failed.failure_reason).toBe("agent_error");
    expect(failed.attempt).toBe(1);
    expect(failed.max_attempts).toBe(2);
    const queued = body[0]!;
    expect(queued.error).toBeNull();
    expect("failure_reason" in queued).toBe(false);
  } finally {
    await cleanup();
    await close();
  }
});

test.skipIf(!reachable)("GET /api/issues/:id/usage aggregates token usage across the issue's tasks", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, rt, ag, iss, cleanup } = await setupFixture(db, `bun-itk-us-${stamp}`);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws.id };

  const [t1] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "completed" })
    .returning();
  const [t2] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "completed" })
    .returning();
  // t1 reports usage under two models; t2 under one → task_count is DISTINCT 2.
  await db.insert(taskUsage).values([
    { taskId: t1!.id, provider: "codex", model: "gpt-5", inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
    { taskId: t1!.id, provider: "codex", model: "gpt-5-mini", inputTokens: 30, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { taskId: t2!.id, provider: "codex", model: "gpt-5", inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 1 },
  ]);

  try {
    const res = await app.request(`/api/issues/${iss.id}/usage`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total_input_tokens: 137,
      total_output_tokens: 73,
      total_cache_read_tokens: 11,
      total_cache_write_tokens: 6,
      task_count: 2,
    });

    // an issue with no usage rows → zeros
    const [iss2] = await db
      .insert(issue)
      .values({ workspaceId: ws.id, title: "empty", creatorType: "member", creatorId: u.id, number: 2 })
      .returning();
    const empty = await app.request(`/api/issues/${iss2!.id}/usage`, { headers: auth });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      task_count: 0,
    });
  } finally {
    await db.delete(taskUsage).where(inArray(taskUsage.taskId, [t1!.id, t2!.id]));
    await cleanup();
    await close();
  }
});

test.skipIf(!reachable)("GET /api/issues/:id/timeline merges comments + activities; flat ASC and wrapped legacy shapes", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, iss, cleanup } = await setupFixture(db, `bun-itk-tl-${stamp}`);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws.id };

  // Insert in chronological order: comment c1 → activity a1 → reply c2.
  const [c1] = await db
    .insert(comment)
    .values({ issueId: iss.id, workspaceId: ws.id, authorType: "member", authorId: u.id, content: "first" })
    .returning();
  const [a1] = await db
    .insert(activityLog)
    .values({
      workspaceId: ws.id,
      issueId: iss.id,
      actorType: "member",
      actorId: u.id,
      action: "status_changed",
      details: { from: "todo", to: "in_progress" },
    })
    .returning();
  const [c2] = await db
    .insert(comment)
    .values({ issueId: iss.id, workspaceId: ws.id, authorType: "member", authorId: u.id, content: "reply", parentId: c1!.id })
    .returning();
  await db
    .insert(commentReaction)
    .values({ commentId: c1!.id, workspaceId: ws.id, actorType: "member", actorId: u.id, emoji: "👍" });
  await db.insert(attachment).values({
    workspaceId: ws.id,
    commentId: c1!.id,
    uploaderType: "member",
    uploaderId: u.id,
    filename: "notes.txt",
    url: "https://cdn.example/notes.txt",
    contentType: "text/plain",
    sizeBytes: 42,
  });

  try {
    // Flat contract: no pagination params → ASC TimelineEntry[].
    const res = await app.request(`/api/issues/${iss.id}/timeline`, { headers: auth });
    expect(res.status).toBe(200);
    const entries = (await res.json()) as Record<string, unknown>[];
    expect(entries.map((e) => e.id)).toEqual([c1!.id, a1!.id, c2!.id]);
    expect(entries.map((e) => e.type)).toEqual(["comment", "activity", "comment"]);

    const first = entries[0]!;
    expect(first.actor_type).toBe("member");
    expect(first.actor_id).toBe(u.id);
    expect(first.content).toBe("first");
    expect(first.comment_type).toBe("comment");
    expect("parent_id" in first).toBe(false); // omitempty: no parent → omitted
    const reactions = first.reactions as Record<string, unknown>[];
    expect(reactions.length).toBe(1);
    expect(reactions[0]!.emoji).toBe("👍");
    expect(reactions[0]!.comment_id).toBe(c1!.id);
    const attachments = first.attachments as Record<string, unknown>[];
    expect(attachments.length).toBe(1);
    expect(attachments[0]!.filename).toBe("notes.txt");
    expect(attachments[0]!.download_url).toBe(`/api/attachments/${attachments[0]!.id}/download`);
    expect(attachments[0]!.size_bytes).toBe(42);

    const act = entries[1]!;
    expect(act.action).toBe("status_changed");
    expect(act.details).toEqual({ from: "todo", to: "in_progress" });
    expect("content" in act).toBe(false);

    const reply = entries[2]!;
    expect(reply.parent_id).toBe(c1!.id);
    expect("reactions" in reply).toBe(false); // omitempty: none → omitted

    // Legacy wrapped contract: any pagination param → DESC entries + null cursors.
    const wrapped = await app.request(`/api/issues/${iss.id}/timeline?limit=50`, { headers: auth });
    expect(wrapped.status).toBe(200);
    const page = (await wrapped.json()) as {
      entries: Record<string, unknown>[];
      next_cursor: null;
      prev_cursor: null;
      has_more_before: boolean;
      has_more_after: boolean;
      target_index?: number;
    };
    expect(page.entries.map((e) => e.id)).toEqual([c2!.id, a1!.id, c1!.id]);
    expect(page.next_cursor).toBeNull();
    expect(page.prev_cursor).toBeNull();
    expect(page.has_more_before).toBe(false);
    expect(page.has_more_after).toBe(false);
    expect("target_index" in page).toBe(false);

    // around=<id> resolves the anchor's index in the DESC slice.
    const around = await app.request(`/api/issues/${iss.id}/timeline?around=${c1!.id}`, { headers: auth });
    expect(around.status).toBe(200);
    expect(((await around.json()) as { target_index?: number }).target_index).toBe(2);
  } finally {
    await cleanup();
    await close();
  }
});

test.skipIf(!reachable)("POST /api/issues/:id/tasks/:taskId/cancel cancels, is idempotent, publishes task:cancelled", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, rt, ag, iss, cleanup } = await setupFixture(db, `bun-itk-cx-${stamp}`);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws.id };

  const [task] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "running" })
    .returning();

  const events: BusEvent[] = [];
  const unsubscribe = bus.subscribe(ws.id, (e) => events.push(e));

  try {
    const res = await app.request(`/api/issues/${iss.id}/tasks/${task!.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(task!.id);
    expect(body.status).toBe("cancelled");
    expect(body.completed_at).not.toBeNull();
    expect(body.workspace_id).toBe(ws.id);

    const [row] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, task!.id));
    expect(row!.status).toBe("cancelled");
    expect(row!.completedAt).not.toBeNull();

    // realtime: a task:cancelled frame went out to the workspace
    const cancelledEvents = events.filter((e) => e.type === "task:cancelled");
    expect(cancelledEvents.length).toBe(1);
    expect(cancelledEvents[0]!.payload).toEqual({
      task_id: task!.id,
      agent_id: ag.id,
      issue_id: iss.id,
      status: "cancelled",
    });

    // idempotent: cancelling an already-terminal task returns the row, no new event
    const again = await app.request(`/api/issues/${iss.id}/tasks/${task!.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("cancelled");
    expect(events.filter((e) => e.type === "task:cancelled").length).toBe(1);

    // a task belonging to a different issue must not be cancellable via this issue
    const [iss2] = await db
      .insert(issue)
      .values({ workspaceId: ws.id, title: "other", creatorType: "member", creatorId: u.id, number: 2 })
      .returning();
    const [task2] = await db
      .insert(agentTaskQueue)
      .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss2!.id, status: "queued" })
      .returning();
    const cross = await app.request(`/api/issues/${iss.id}/tasks/${task2!.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    expect(cross.status).toBe(404);
    const [task2Row] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, task2!.id));
    expect(task2Row!.status).toBe("queued"); // untouched

    // malformed task id → 400; unknown task uuid → 404
    const bad = await app.request(`/api/issues/${iss.id}/tasks/not-a-uuid/cancel`, {
      method: "POST",
      headers: auth,
    });
    expect(bad.status).toBe(400);
    const gone = await app.request(
      `/api/issues/${iss.id}/tasks/00000000-0000-4000-8000-000000000000/cancel`,
      { method: "POST", headers: auth },
    );
    expect(gone.status).toBe(404);
  } finally {
    unsubscribe();
    await cleanup();
    await close();
  }
});
