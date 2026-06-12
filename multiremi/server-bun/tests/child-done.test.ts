/**
 * Sub-issue completion: marking a child issue done posts a system comment on its
 * agent/squad-assigned parent (mentioning the assignee); a member-assigned
 * parent is skipped, and a non-transition (already done) posts nothing.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { notifyParentOfChildDone } from "../src/agent/childDone.js";
import { updateIssue } from "../src/db/queries/issues.js";
import { user, member, workspace, issue, agent, agentRuntime, comment } from "../src/db/schema.js";
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

test.skipIf(!reachable)("child-done posts a system comment on an agent-assigned parent; member parent + non-transition skip", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-cd-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "CD WS", slug: `bun-cd-${stamp}`, issuePrefix: "CD", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();
  const [ag] = await db.insert(agent).values({ workspaceId: ws!.id, name: "Lead", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id }).returning();

  // Parent assigned to the agent; a child in progress.
  const [parent] = await db.insert(issue).values({ workspaceId: ws!.id, title: "Parent", creatorType: "member", creatorId: u.id, number: 1, status: "in_progress", assigneeType: "agent", assigneeId: ag!.id }).returning();
  const [child] = await db.insert(issue).values({ workspaceId: ws!.id, title: "Child A", creatorType: "member", creatorId: u.id, number: 2, status: "in_progress", parentIssueId: parent!.id }).returning();

  try {
    // Transition the child to done → one system comment on the parent mentioning the agent.
    const done = await updateIssue(db, child!.id, { status: "done" });
    await notifyParentOfChildDone(db, child!, done!);
    const comments = await db.select().from(comment).where(eq(comment.issueId, parent!.id));
    expect(comments.length).toBe(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.type).toBe("system");
    expect(comments[0]!.content).toContain(`mention://agent/${ag!.id}`);
    expect(comments[0]!.content).toContain("CD-2"); // child identifier

    // Re-running with prev already done (no transition) → no new comment.
    await notifyParentOfChildDone(db, done!, done!);
    expect((await db.select().from(comment).where(eq(comment.issueId, parent!.id))).length).toBe(1);

    // A member-assigned parent is skipped.
    await db.update(issue).set({ assigneeType: "member", assigneeId: u.id }).where(eq(issue.id, parent!.id));
    const [child2] = await db.insert(issue).values({ workspaceId: ws!.id, title: "Child B", creatorType: "member", creatorId: u.id, number: 3, status: "in_progress", parentIssueId: parent!.id }).returning();
    const done2 = await updateIssue(db, child2!.id, { status: "done" });
    await notifyParentOfChildDone(db, child2!, done2!);
    expect((await db.select().from(comment).where(eq(comment.issueId, parent!.id))).length).toBe(1); // unchanged
  } finally {
    await db.delete(comment).where(eq(comment.workspaceId, ws!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
