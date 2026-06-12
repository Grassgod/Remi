/** Lark (Feishu) inbound minimal loop: url_verification handshake + an inbound
 *  message creating an issue in the installation's workspace. */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { larkRoutes } from "../src/http/routes/lark.js";
import {
  user, member, workspace, issue, agent, agentRuntime, larkInstallation,
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

test("url_verification handshake echoes the challenge (no DB needed)", async () => {
  const app = new Hono();
  app.route("/api/lark", larkRoutes(undefined));
  const res = await app.request("/api/lark/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "url_verification", challenge: "abc123", token: "t" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ challenge: "abc123" });
});

test.skipIf(!reachable)("an inbound Feishu message creates an issue in the bound workspace", async () => {
  const { db, close } = createDb(DB_URL);
  const app = new Hono();
  app.route("/api/lark", larkRoutes(db));
  const stamp = Date.now();
  const appId = `cli_test_${stamp}`;
  const { user: u } = await findOrCreateUser(db, `bun-lark-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "Lark WS", slug: `bun-lark-${stamp}`, issuePrefix: "LRK", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();
  const [ag] = await db.insert(agent).values({ workspaceId: ws!.id, name: "Bot", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id }).returning();
  await db.insert(larkInstallation).values({
    workspaceId: ws!.id,
    agentId: ag!.id,
    appId,
    appSecretEncrypted: Buffer.from("encrypted-secret"),
    botOpenId: "ou_bot",
    installerUserId: u.id,
  });

  try {
    const res = await app.request("/api/lark/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", app_id: appId, tenant_key: "tk" },
        event: { message: { content: JSON.stringify({ text: "@_user_1 Fix the login bug" }), chat_id: "oc_1" } },
      }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; issue_id?: string; number?: number };
    expect(out.ok).toBe(true);
    expect(out.issue_id).toBeTruthy();

    const [created] = await db.select().from(issue).where(eq(issue.id, out.issue_id!));
    expect(created!.title).toBe("Fix the login bug"); // mention stripped, text used
    expect(created!.originType).toBe("lark_chat");
    expect(created!.workspaceId).toBe(ws!.id);
  } finally {
    await db.delete(larkInstallation).where(eq(larkInstallation.workspaceId, ws!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
