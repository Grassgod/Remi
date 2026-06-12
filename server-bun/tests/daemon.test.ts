/**
 * End-to-end agent scheduling on the Bun rewrite: a queued task is claimed
 * atomically by a runtime and run through the unified ACP executor.
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { AcpProvider } from "../src/agent/acp/index.js";
import { claimAndRun, claimNextTask } from "../src/agent/daemon.js";
import { user, member, workspace, issue, agent, agentRuntime, agentTaskQueue } from "../src/db/schema.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = { port: 0, jwtSecret: "x", authTokenTtlSeconds: 3600, databaseUrl: DB_URL, allowedEmailDomains: [] };

const MOCK = join(import.meta.dir, "fixtures", "mock-acp-agent.ts");
chmodSync(MOCK, 0o755);

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

test.skipIf(!reachable)("claimAndRun claims a queued task and runs it through ACP; empty queue → null", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-dmn-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "Dmn WS", slug: `bun-dmn-${stamp}`, issuePrefix: "DMN", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();
  const [ag] = await db.insert(agent).values({ workspaceId: ws!.id, name: "W", runtimeId: rt!.id, runtimeMode: "local", instructions: "work", ownerId: u.id }).returning();
  const [iss] = await db.insert(issue).values({ workspaceId: ws!.id, title: "task issue", creatorType: "member", creatorId: u.id, number: 1 }).returning();
  const [task] = await db.insert(agentTaskQueue).values({ agentId: ag!.id, runtimeId: rt!.id, issueId: iss!.id, status: "queued" }).returning();

  try {
    // claim + run
    const ran = await claimAndRun(db, new AcpProvider(), rt!.id, { executable: MOCK });
    expect(ran).not.toBeNull();
    expect(ran!.taskId).toBe(task!.id);
    expect(ran!.outcome.status).toBe("completed");

    const [after] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, task!.id));
    expect(after!.status).toBe("completed");
    expect(after!.sessionId).toBeTruthy();

    // queue now empty for this runtime → null
    expect(await claimNextTask(db, rt!.id)).toBeNull();
    // and a different runtime never sees it
    expect(await claimNextTask(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  } finally {
    await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

import { drainQueue } from "../src/agent/daemon.js";

test.skipIf(!reachable)("drainQueue processes all queued tasks for a runtime", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-drain-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "Drain WS", slug: `bun-drain-${stamp}`, issuePrefix: "DRN", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();
  const [ag] = await db.insert(agent).values({ workspaceId: ws!.id, name: "W", runtimeId: rt!.id, runtimeMode: "local", instructions: "go", ownerId: u.id }).returning();
  await db.insert(agentTaskQueue).values([
    { agentId: ag!.id, runtimeId: rt!.id, status: "queued" },
    { agentId: ag!.id, runtimeId: rt!.id, status: "queued" },
  ]);
  try {
    const n = await drainQueue(db, new AcpProvider(), rt!.id, { executable: MOCK });
    expect(n).toBe(2);
    // a second drain finds nothing
    expect(await drainQueue(db, new AcpProvider(), rt!.id, { executable: MOCK })).toBe(0);
  } finally {
    await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
