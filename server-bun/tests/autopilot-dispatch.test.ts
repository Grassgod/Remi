/**
 * Autopilot dispatch: firing a create_issue autopilot assigned to an agent
 * records a dispatched run, creates an autopilot-origin issue, and enqueues a
 * queued agent task linked to that issue.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { dispatchAutopilot } from "../src/agent/autopilot.js";
import {
  user, member, workspace, issue, agent, agentRuntime, agentTaskQueue, autopilot, autopilotRun,
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

test.skipIf(!reachable)("dispatching a create_issue autopilot creates an issue + queued agent task", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-ap-${stamp}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "AP WS", slug: `bun-ap-${stamp}`, issuePrefix: "AP", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" })
    .returning();
  const [ag] = await db
    .insert(agent)
    .values({ workspaceId: ws!.id, name: "Sweeper", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id })
    .returning();
  const [ap] = await db
    .insert(autopilot)
    .values({
      workspaceId: ws!.id,
      title: "Nightly autopilot",
      assigneeType: "agent",
      assigneeId: ag!.id,
      executionMode: "create_issue",
      issueTitleTemplate: "Nightly sweep",
      createdByType: "member",
      createdById: u.id,
    })
    .returning();

  try {
    const res = await dispatchAutopilot(db, { autopilotId: ap!.id, source: "schedule" });
    expect(res.runId).toBeTruthy();
    expect(res.issueId).toBeTruthy();
    expect(res.taskId).toBeTruthy();

    const [run] = await db.select().from(autopilotRun).where(eq(autopilotRun.id, res.runId));
    expect(run!.status).toBe("issue_created");
    expect(run!.issueId).toBe(res.issueId!);

    const [iss] = await db.select().from(issue).where(eq(issue.id, res.issueId!));
    expect(iss!.title).toBe("Nightly sweep");
    expect(iss!.originType).toBe("autopilot");
    expect(iss!.assigneeType).toBe("agent");
    expect(iss!.assigneeId).toBe(ag!.id);

    const [task] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, res.taskId!));
    expect(task!.status).toBe("queued");
    expect(task!.issueId).toBe(res.issueId!);
    expect(task!.agentId).toBe(ag!.id);
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
});
