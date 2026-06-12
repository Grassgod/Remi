/**
 * A comment @mentioning an agent enqueues a queued task for that agent carrying
 * the trigger comment id; re-mentioning while a task is pending is deduped; a
 * member mention enqueues nothing.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { enqueueAssigneeOnComment, enqueueMentionedAgentTasks } from "../src/agent/commentTrigger.js";
import {
  user, member, workspace, issue, comment, agent, agentRuntime, agentTaskQueue,
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

test.skipIf(!reachable)("an agent mention enqueues a trigger task; dedup holds; member mention is a no-op", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-ct-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "CT WS", slug: `bun-ct-${stamp}`, issuePrefix: "CT", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();
  const [ag] = await db.insert(agent).values({ workspaceId: ws!.id, name: "Ada", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id }).returning();
  const [iss] = await db.insert(issue).values({ workspaceId: ws!.id, title: "Discuss", creatorType: "member", creatorId: u.id, number: 1 }).returning();

  const mkComment = async (content: string) =>
    (await db.insert(comment).values({ issueId: iss!.id, workspaceId: ws!.id, authorType: "member", authorId: u.id, content, type: "comment" }).returning())[0]!;

  try {
    // 1. Comment mentioning the agent → one queued task with the trigger id.
    const c1 = await mkComment(`Please look [@Ada](mention://agent/${ag!.id})`);
    const ids1 = await enqueueMentionedAgentTasks(db, iss!, c1, "member", u.id);
    expect(ids1.length).toBe(1);
    const [task] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, ids1[0]!));
    expect(task!.status).toBe("queued");
    expect(task!.agentId).toBe(ag!.id);
    expect(task!.issueId).toBe(iss!.id);
    expect(task!.triggerCommentId).toBe(c1.id);

    // 2. Re-mention while the first task is still queued → deduped (no new task).
    const c2 = await mkComment(`Still waiting [@Ada](mention://agent/${ag!.id})`);
    const ids2 = await enqueueMentionedAgentTasks(db, iss!, c2, "member", u.id);
    expect(ids2.length).toBe(0);
    const count = (await db.select().from(agentTaskQueue).where(and(eq(agentTaskQueue.issueId, iss!.id), eq(agentTaskQueue.agentId, ag!.id)))).length;
    expect(count).toBe(1);

    // 3. A member mention triggers nothing.
    const c3 = await mkComment(`cc [@Owner](mention://member/${u.id})`);
    const ids3 = await enqueueMentionedAgentTasks(db, iss!, c3, "member", u.id);
    expect(ids3.length).toBe(0);
  } finally {
    await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
    await db.delete(comment).where(eq(comment.issueId, iss!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

test.skipIf(!reachable)("a plain member cannot wake a private agent they don't own; the owner can", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: owner } = await findOrCreateUser(db, `bun-ctp-owner-${stamp}@bytedance.com`, cfg);
  const { user: plain } = await findOrCreateUser(db, `bun-ctp-plain-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "CTP WS", slug: `bun-ctp-${stamp}`, issuePrefix: "CTP", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: owner.id, role: "owner" });
  await db.insert(member).values({ workspaceId: ws!.id, userId: plain.id, role: "member" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();
  // A private agent owned by `owner`.
  const [ag] = await db.insert(agent).values({ workspaceId: ws!.id, name: "Sec", runtimeId: rt!.id, runtimeMode: "local", ownerId: owner.id, visibility: "private" }).returning();
  const [iss] = await db.insert(issue).values({ workspaceId: ws!.id, title: "Private", creatorType: "member", creatorId: owner.id, number: 1 }).returning();
  const mention = `[@Sec](mention://agent/${ag!.id})`;
  const mk = async (uid: string) => (await db.insert(comment).values({ issueId: iss!.id, workspaceId: ws!.id, authorType: "member", authorId: uid, content: mention, type: "comment" }).returning())[0]!;

  try {
    // Plain member (not owner/admin, not the agent owner) → blocked.
    const denied = await enqueueMentionedAgentTasks(db, iss!, await mk(plain.id), "member", plain.id);
    expect(denied.length).toBe(0);
    // The agent's owner → allowed.
    const allowed = await enqueueMentionedAgentTasks(db, iss!, await mk(owner.id), "member", owner.id);
    expect(allowed.length).toBe(1);
  } finally {
    await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
    await db.delete(comment).where(eq(comment.issueId, iss!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, owner.id));
    await db.delete(user).where(eq(user.id, plain.id));
    await close();
  }
});

test.skipIf(!reachable)(
  "a member comment wakes the agent assignee without an @; agent author and dedup do not",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-act-${stamp}@bytedance.com`, cfg);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "ACT WS", slug: `bun-act-${stamp}`, issuePrefix: "ACT", issueCounter: 0 })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" })
      .returning();
    const [ag] = await db
      .insert(agent)
      .values({ workspaceId: ws!.id, name: "Ada", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id })
      .returning();
    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Assigned",
        creatorType: "member",
        creatorId: u.id,
        assigneeType: "agent",
        assigneeId: ag!.id,
        status: "in_review",
        number: 1,
      })
      .returning();
    const mkComment = async (content: string, authorType = "member", authorId = u.id) => {
      const [c] = await db
        .insert(comment)
        .values({ workspaceId: ws!.id, issueId: iss!.id, authorType, authorId, content, type: "comment" })
        .returning();
      return c!;
    };

    try {
      // 1. Plain member comment (no @) → queued task with the trigger comment id.
      const c1 = await mkComment("真的嘛?");
      const id1 = await enqueueAssigneeOnComment(db, iss!, c1, "member", u.id);
      expect(id1).toBeTruthy();
      const [t1] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, id1!));
      expect(t1!.agentId).toBe(ag!.id);
      expect(t1!.triggerCommentId).toBe(c1.id);
      expect(t1!.status).toBe("queued");

      // 2. Second comment while the task is queued → deduped.
      const c2 = await mkComment("是吗?");
      expect(await enqueueAssigneeOnComment(db, iss!, c2, "member", u.id)).toBeNull();

      // 3. The agent's own report never re-triggers it.
      await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
      const c3 = await mkComment("done.", "agent", ag!.id);
      expect(await enqueueAssigneeOnComment(db, iss!, c3, "agent", ag!.id)).toBeNull();
    } finally {
      await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
      await db.delete(comment).where(eq(comment.issueId, iss!.id));
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
