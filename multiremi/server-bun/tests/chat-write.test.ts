/**
 * Chat write path: create a session with an agent, send a user message (which
 * enqueues a session-bound agent task and marks the session unread), mark it
 * read, rename, and delete.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { chatRoutes } from "../src/http/routes/chat.js";
import { user, member, workspace, agent, agentRuntime, agentTaskQueue, chatSession, chatMessage } from "../src/db/schema.js";
import type { AppEnv } from "../src/http/types.js";
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

test.skipIf(!reachable)("create session, send message (enqueues task + unread), read, rename, delete", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-chat-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "Chat WS", slug: `bun-chat-${stamp}`, issuePrefix: "CH", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();
  const [ag] = await db.insert(agent).values({ workspaceId: ws!.id, name: "Chatbot", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id }).returning();

  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => { c.set("user", { sub: u.id } as never); await n(); });
  app.route("/api/chat", chatRoutes(db));
  const hdr = { "Content-Type": "application/json", "X-Workspace-ID": ws!.id };

  let sessionId = "";
  try {
    // Create session.
    const create = await app.request("/api/chat/sessions", { method: "POST", headers: hdr, body: JSON.stringify({ agent_id: ag!.id, title: "Help" }) });
    expect(create.status).toBe(201);
    const session = (await create.json()) as { id: string; agent_id: string; title: string; has_unread: boolean };
    sessionId = session.id;
    expect(session.agent_id).toBe(ag!.id);
    expect(session.has_unread).toBe(false);

    // Send a user message → user message + a queued session-bound task.
    const send = await app.request(`/api/chat/sessions/${sessionId}/messages`, { method: "POST", headers: hdr, body: JSON.stringify({ content: "fix the build" }) });
    expect(send.status).toBe(201);
    const sent = (await send.json()) as { message: { role: string; content: string }; task_id: string };
    expect(sent.message.role).toBe("user");
    expect(sent.task_id).toBeTruthy();
    const [task] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, sent.task_id));
    expect(task!.status).toBe("queued");
    expect(task!.chatSessionId).toBe(sessionId);

    // Sending marked the session unread.
    const list1 = (await (await app.request("/api/chat/sessions", { headers: hdr })).json()) as { id: string; has_unread: boolean }[];
    expect(list1.find((s) => s.id === sessionId)!.has_unread).toBe(true);

    // Read clears it.
    expect((await app.request(`/api/chat/sessions/${sessionId}/read`, { method: "POST", headers: hdr })).status).toBe(204);
    const list2 = (await (await app.request("/api/chat/sessions", { headers: hdr })).json()) as { id: string; has_unread: boolean }[];
    expect(list2.find((s) => s.id === sessionId)!.has_unread).toBe(false);

    // Transcript shows the user message.
    const msgs = (await (await app.request(`/api/chat/sessions/${sessionId}/messages`, { headers: hdr })).json()) as { content: string }[];
    expect(msgs.map((m) => m.content)).toEqual(["fix the build"]);

    // Rename.
    const patch = await app.request(`/api/chat/sessions/${sessionId}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ title: "Build help" }) });
    expect(((await patch.json()) as { title: string }).title).toBe("Build help");

    // Delete → 204, messages gone (CASCADE), task chat_session_id nulled (SET NULL).
    expect((await app.request(`/api/chat/sessions/${sessionId}`, { method: "DELETE", headers: hdr })).status).toBe(204);
    expect((await db.select().from(chatMessage).where(eq(chatMessage.chatSessionId, sessionId))).length).toBe(0);
    expect((await db.select().from(chatSession).where(eq(chatSession.id, sessionId))).length).toBe(0);
  } finally {
    await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
    if (sessionId) await db.delete(chatMessage).where(eq(chatMessage.chatSessionId, sessionId));
    await db.delete(chatSession).where(eq(chatSession.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
