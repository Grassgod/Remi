/**
 * Lark outbound reply: an inbound message that creates an issue triggers a
 * best-effort confirmation back into the chat. Verifies the installation's
 * encrypted app_secret is decrypted (secretbox) and handed to the replier with
 * the chat id and a confirmation referencing the new issue's identifier.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { larkRoutes, type LarkReplier } from "../src/http/routes/lark.js";
import { Box, KEY_SIZE } from "../src/util/secretbox.js";
import { user, member, workspace, issue, agent, agentRuntime, larkInstallation } from "../src/db/schema.js";
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

test.skipIf(!reachable)("an inbound message decrypts the app secret and replies into the chat", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();

  // Configure the secret key + seal a real app secret with it.
  const key = randomBytes(KEY_SIZE);
  process.env.MULTIMIRA_LARK_SECRET_KEY = key.toString("base64");
  const appSecret = "app-secret-plaintext";
  const sealed = new Box(key).seal(appSecret);

  const appId = `cli_reply_${stamp}`;
  const { user: u } = await findOrCreateUser(db, `bun-larkreply-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "Reply WS", slug: `bun-larkreply-${stamp}`, issuePrefix: "RPL", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();
  const [ag] = await db.insert(agent).values({ workspaceId: ws!.id, name: "Bot", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id }).returning();
  await db.insert(larkInstallation).values({
    workspaceId: ws!.id,
    agentId: ag!.id,
    appId,
    appSecretEncrypted: Buffer.from(sealed),
    botOpenId: "ou_bot",
    installerUserId: u.id,
  });

  const calls: { appId: string; secret: string; chatId: string; text: string }[] = [];
  const replier: LarkReplier = {
    async reply(a, s, chat, text) {
      calls.push({ appId: a, secret: s, chatId: chat, text });
    },
  };

  const app = new Hono();
  app.route("/lark", larkRoutes(db, replier));

  try {
    const res = await app.request("/lark/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", app_id: appId },
        event: { message: { content: JSON.stringify({ text: "Ship the release" }), chat_id: "oc_reply_1" } },
      }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; number?: number };
    expect(out.ok).toBe(true);

    // The replier was invoked with the DECRYPTED secret, the chat id, and a
    // confirmation that references the workspace-prefixed identifier.
    expect(calls.length).toBe(1);
    expect(calls[0]!.appId).toBe(appId);
    expect(calls[0]!.secret).toBe(appSecret);
    expect(calls[0]!.chatId).toBe("oc_reply_1");
    expect(calls[0]!.text).toContain(`RPL-${out.number}`);
    expect(calls[0]!.text).toContain("Ship the release");
  } finally {
    delete process.env.MULTIMIRA_LARK_SECRET_KEY;
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
