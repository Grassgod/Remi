/**
 * The remote `remi` daemon client (src/daemon/client.ts) driven over REAL HTTP
 * against the live Hono app served on an ephemeral port — register → claim →
 * report round-trip, authenticated only with a `mul_` PAT (no DB creds on the
 * client side). Live-DB gated; fixtures torn down in finally.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { createPersonalAccessToken, hashPatToken } from "../src/db/queries/pat.js";
import { DaemonClient } from "../src/daemon/client.js";
import {
  user,
  member,
  workspace,
  issue,
  agent,
  agentRuntime,
  agentTaskQueue,
  personalAccessToken,
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

test.skipIf(!reachable)("remi client register → claim → report over HTTP (PAT auth)", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-rc-${stamp}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "RC WS", slug: `bun-rc-${stamp}`, issuePrefix: "RC", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

  const raw = `mul_${stamp.toString(16)}rc`;
  await createPersonalAccessToken(db, {
    userId: u.id,
    name: "remi",
    tokenHash: hashPatToken(raw),
    tokenPrefix: raw.slice(0, 12),
    expiresAt: null,
  });

  const app = createApp(cfg, db);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const client = new DaemonClient({
    serverUrl: `http://localhost:${server.port}`,
    token: raw,
    workspaceId: ws!.id,
  });

  let agId: string | undefined;
  try {
    // Register a single claude runtime.
    const runtimes = await client.register(`daemon-${stamp}`, "rc-box", ["claude"]);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.provider).toBe("claude");
    const rtId = runtimes[0]!.id;

    // Heartbeat a live runtime → true; a bogus one → false.
    expect(await client.heartbeat(rtId)).toBe(true);
    expect(await client.heartbeat("00000000-0000-4000-8000-000000000000")).toBe(false);

    // Empty queue → claim returns null.
    expect(await client.claim(rtId)).toBeNull();

    // Queue a task, then claim + report it through the client.
    const [ag] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: "Worker",
        runtimeId: rtId,
        runtimeMode: "local",
        instructions: "do the thing",
        ownerId: u.id,
      })
      .returning();
    agId = ag!.id;
    const [iss] = await db
      .insert(issue)
      .values({ workspaceId: ws!.id, title: "rc task", creatorType: "member", creatorId: u.id, number: 1 })
      .returning();
    const [task] = await db
      .insert(agentTaskQueue)
      .values({ agentId: ag!.id, runtimeId: rtId, issueId: iss!.id, status: "queued" })
      .returning();

    const claimed = await client.claim(rtId);
    expect(claimed?.id).toBe(task!.id);
    expect(claimed?.instructions).toBe("do the thing");

    await client.report(task!.id, { status: "completed", text: "done", sessionId: "sess-1" });
    const [after] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, task!.id));
    expect(after!.status).toBe("completed");
  } finally {
    server.stop(true);
    if (agId) await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, agId));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(personalAccessToken).where(eq(personalAccessToken.userId, u.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
