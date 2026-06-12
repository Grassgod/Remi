/**
 * The agent task executor runs a queued task through the ONE unified ACP
 * provider and writes the result back — the Go daemon's 12 per-agent execution
 * paths collapsed to a single call. Driven here against the mock ACP agent.
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { AcpProvider } from "../src/agent/acp/index.js";
import { executeAgentTask } from "../src/agent/executor.js";
import {
  user,
  member,
  workspace,
  issue,
  project,
  projectResource,
  agent,
  agentRuntime,
  agentTaskQueue,
} from "../src/db/schema.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = {
  port: 0,
  jwtSecret: "x",
  authTokenTtlSeconds: 3600,
  databaseUrl: DB_URL,
  allowedEmailDomains: [],
};

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

test.skipIf(!reachable)("executeAgentTask drives a queued task through the unified ACP provider", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-exec-${stamp}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "Exec WS", slug: `bun-exec-${stamp}`, issuePrefix: "EXE", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({ workspaceId: ws!.id, name: "Codex RT", runtimeMode: "local", provider: "codex" })
    .returning();
  const [ag] = await db
    .insert(agent)
    .values({
      workspaceId: ws!.id,
      name: "Worker",
      runtimeId: rt!.id,
      runtimeMode: "local",
      instructions: "You are a helpful worker.",
      ownerId: u.id,
    })
    .returning();
  const [iss] = await db
    .insert(issue)
    .values({ workspaceId: ws!.id, title: "Do the thing", description: "carefully", creatorType: "member", creatorId: u.id, number: 1 })
    .returning();
  const [task] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag!.id, runtimeId: rt!.id, issueId: iss!.id, status: "queued" })
    .returning();

  try {
    const provider = new AcpProvider();
    const events: string[] = [];
    const outcome = await executeAgentTask(db, provider, task!.id, {
      executable: MOCK,
      onEvent: (e) => events.push(e.kind),
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(typeof outcome.sessionId).toBe("string");
    }

    // the task row is written back to completed with a result + session id
    const [after] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, task!.id));
    expect(after!.status).toBe("completed");
    expect(after!.sessionId).toBeTruthy();
    expect(after!.result).toBeTruthy();
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

async function gitInit(args: string[], cwd: string) {
  await Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exited;
}

test.skipIf(!reachable)("a task whose project has a github_repo resource runs in a checked-out worktree", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();

  // A real source repo to act as the project's github_repo (local path is a
  // valid git remote for clone --bare).
  const tmp = await mkdtemp(join(tmpdir(), "multimira-exec-repo-"));
  const srcRepo = join(tmp, "src");
  await mkdir(srcRepo, { recursive: true });
  await gitInit(["init", "-q", "-b", "main"], srcRepo);
  await gitInit(["config", "user.email", "t@t.com"], srcRepo);
  await gitInit(["config", "user.name", "t"], srcRepo);
  await Bun.write(join(srcRepo, "MARKER.txt"), "from the repo");
  await gitInit(["add", "."], srcRepo);
  await gitInit(["commit", "-q", "-m", "init"], srcRepo);
  const workBaseDir = join(tmp, "daemon");

  const { user: u } = await findOrCreateUser(db, `bun-exec-repo-${stamp}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "Repo WS", slug: `bun-exec-repo-${stamp}`, issuePrefix: "REP", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({ workspaceId: ws!.id, name: "Codex RT", runtimeMode: "local", provider: "codex" })
    .returning();
  const [ag] = await db
    .insert(agent)
    .values({ workspaceId: ws!.id, name: "Worker", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id })
    .returning();
  const [proj] = await db
    .insert(project)
    .values({ workspaceId: ws!.id, title: "Repo project" })
    .returning();
  await db.insert(projectResource).values({
    projectId: proj!.id,
    workspaceId: ws!.id,
    resourceType: "github_repo",
    resourceRef: { url: srcRepo },
  });
  const [iss] = await db
    .insert(issue)
    .values({ workspaceId: ws!.id, title: "Fix in repo", creatorType: "member", creatorId: u.id, number: 1, projectId: proj!.id })
    .returning();
  const [task] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag!.id, runtimeId: rt!.id, issueId: iss!.id, status: "queued" })
    .returning();

  try {
    const provider = new AcpProvider();
    const outcome = await executeAgentTask(db, provider, task!.id, { executable: MOCK, workBaseDir });

    expect(outcome.status).toBe("completed");
    // The mock agent reported its own process.cwd() — it must be the worktree
    // under workBaseDir, proving the executor checked out the repo and ran there.
    // (macOS realpath-resolves /var → /private/var, so match the path suffix.)
    const shortId = task!.id.replace(/-/g, "").slice(0, 8);
    const expectedWorkdir = join(workBaseDir, "work", shortId);
    if (outcome.status === "completed") {
      const reported = outcome.text.match(/cwd: (.+)/)?.[1] ?? "";
      expect(reported.endsWith(join("work", shortId))).toBe(true);
    }

    // The worktree path was persisted on the task row.
    const [after] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, task!.id));
    expect(after!.workDir).toBe(expectedWorkdir);
    // The worktree was torn down after the task completed.
    expect(existsSync(expectedWorkdir)).toBe(false);
  } finally {
    await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(projectResource).where(eq(projectResource.workspaceId, ws!.id));
    await db.delete(project).where(eq(project.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await rm(tmp, { recursive: true, force: true });
    await close();
  }
});
