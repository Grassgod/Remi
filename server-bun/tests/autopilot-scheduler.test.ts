/**
 * The schedule sweep fires a due schedule trigger (dispatching its autopilot)
 * and advances next_run_at to the future so it won't immediately re-fire.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { sweepDueAutopilotTriggers } from "../src/agent/autopilotScheduler.js";
import {
  user, member, workspace, issue, agent, agentRuntime, agentTaskQueue,
  autopilot, autopilotRun, autopilotTrigger,
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

test.skipIf(!reachable)("sweep fires a due schedule trigger and advances next_run_at", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-aps-${stamp}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "APS WS", slug: `bun-aps-${stamp}`, issuePrefix: "APS", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" })
    .returning();
  const [ag] = await db
    .insert(agent)
    .values({ workspaceId: ws!.id, name: "Cronbot", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id })
    .returning();
  const [ap] = await db
    .insert(autopilot)
    .values({
      workspaceId: ws!.id,
      title: "Scheduled autopilot",
      assigneeType: "agent",
      assigneeId: ag!.id,
      executionMode: "create_issue",
      issueTitleTemplate: "Cron issue",
      createdByType: "member",
      createdById: u.id,
    })
    .returning();
  const pastDue = new Date(Date.now() - 60_000).toISOString();
  const [trig] = await db
    .insert(autopilotTrigger)
    .values({
      autopilotId: ap!.id,
      kind: "schedule",
      enabled: true,
      cronExpression: "*/5 * * * *",
      timezone: "UTC",
      nextRunAt: pastDue,
    })
    .returning();

  try {
    const now = new Date();
    const fired = await sweepDueAutopilotTriggers(db, now);
    expect(fired).toBe(1);

    // A run was created for the autopilot.
    const runs = await db.select().from(autopilotRun).where(eq(autopilotRun.autopilotId, ap!.id));
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("issue_created");
    expect(runs[0]!.triggerId).toBe(trig!.id);

    // next_run_at advanced into the future.
    const [after] = await db.select().from(autopilotTrigger).where(eq(autopilotTrigger.id, trig!.id));
    expect(after!.nextRunAt).toBeTruthy();
    expect(new Date(after!.nextRunAt!).getTime()).toBeGreaterThan(now.getTime());

    // A second sweep at the same `now` finds nothing due (already advanced).
    const firedAgain = await sweepDueAutopilotTriggers(db, now);
    expect(firedAgain).toBe(0);
  } finally {
    const runIds = (await db.select({ id: autopilotRun.id }).from(autopilotRun).where(eq(autopilotRun.autopilotId, ap!.id))).map((r) => r.id);
    await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
    await db.delete(autopilotTrigger).where(eq(autopilotTrigger.autopilotId, ap!.id));
    await db.delete(autopilotRun).where(eq(autopilotRun.autopilotId, ap!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(autopilot).where(eq(autopilot.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    void runIds;
    await close();
  }
});
