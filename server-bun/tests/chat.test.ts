import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import {
  user,
  member,
  workspace,
  agent,
  agentRuntime,
  chatSession,
  chatMessage,
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

/**
 * Seed a workspace with the user as owner, plus an agent (needs an
 * agent_runtime parent for the NOT NULL runtime_id FK). Returns the ids needed
 * to build chat fixtures + clean up.
 */
async function seedWorkspace(db: ReturnType<typeof createDb>["db"], stamp: number, userId: string) {
  const [ws] = await db
    .insert(workspace)
    .values({ name: "Chat WS", slug: `bun-chat-${stamp}`, issuePrefix: "CHT" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId, role: "owner" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({
      workspaceId: ws!.id,
      name: "rt",
      runtimeMode: "local",
      provider: "claude",
      status: "online",
    })
    .returning();
  const [ag] = await db
    .insert(agent)
    .values({
      workspaceId: ws!.id,
      name: `Agent ${stamp}`,
      runtimeMode: "local",
      runtimeId: rt!.id,
    })
    .returning();
  return { wsId: ws!.id, agentId: ag!.id };
}

async function cleanup(db: ReturnType<typeof createDb>["db"], wsId: string, userId: string) {
  // chat_message cascades from chat_session, but delete explicitly for clarity.
  const sessions = await db.select({ id: chatSession.id }).from(chatSession).where(eq(chatSession.workspaceId, wsId));
  for (const s of sessions) {
    await db.delete(chatMessage).where(eq(chatMessage.chatSessionId, s.id));
  }
  await db.delete(chatSession).where(eq(chatSession.workspaceId, wsId));
  await db.delete(agent).where(eq(agent.workspaceId, wsId));
  await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, wsId));
  await db.delete(member).where(eq(member.workspaceId, wsId));
  await db.delete(workspace).where(eq(workspace.id, wsId));
  await db.delete(user).where(eq(user.id, userId));
}

test.skipIf(!reachable)(
  "chat read path: list active sessions (creator-scoped, has_unread) + 400/404 gates",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-chl-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const { wsId, agentId } = await seedWorkspace(db, stamp, u.id);

    // An active session with unread replies, an active read session, and an
    // archived one that must NOT appear in the default list.
    const [unread] = await db
      .insert(chatSession)
      .values({
        workspaceId: wsId,
        agentId,
        creatorId: u.id,
        title: "Unread session",
        status: "active",
        unreadSince: new Date().toISOString(),
      })
      .returning();
    const [read] = await db
      .insert(chatSession)
      .values({ workspaceId: wsId, agentId, creatorId: u.id, title: "Read session", status: "active" })
      .returning();
    await db
      .insert(chatSession)
      .values({ workspaceId: wsId, agentId, creatorId: u.id, title: "Archived session", status: "archived" })
      .returning();

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": wsId };

    try {
      const listRes = await app.request("/api/chat/sessions", { headers: auth });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<{
        id: string;
        title: string;
        status: string;
        has_unread: boolean;
        workspace_id: string;
        agent_id: string;
        creator_id: string;
      }>;
      // Only the two active sessions; the archived one is filtered out.
      expect(list.length).toBe(2);
      const ids = list.map((s) => s.id);
      expect(ids).toContain(unread!.id);
      expect(ids).toContain(read!.id);
      const unreadRow = list.find((s) => s.id === unread!.id)!;
      expect(unreadRow.has_unread).toBe(true);
      expect(unreadRow.workspace_id).toBe(wsId);
      expect(unreadRow.agent_id).toBe(agentId);
      expect(unreadRow.creator_id).toBe(u.id);
      expect(list.find((s) => s.id === read!.id)!.has_unread).toBe(false);

      // missing workspace header → 400
      const noWs = await app.request("/api/chat/sessions", { headers: { Authorization: `Bearer ${token}` } });
      expect(noWs.status).toBe(400);

      // a member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/chat/sessions", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await cleanup(db, wsId, u.id);
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "chat read path: list messages chronologically, creator-only access",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-chm-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    // A second user who owns nothing here — used to prove the creator-only gate.
    const { user: other } = await findOrCreateUser(db, `bun-chx-${stamp}@bytedance.com`, cfg);
    const otherToken = await issueJWT({ sub: other.id, email: other.email, name: other.name }, SECRET);
    const { wsId, agentId } = await seedWorkspace(db, stamp, u.id);
    // The other user is also a member of the workspace (passes the ws gate) but
    // is NOT the session creator (must be denied at the ownership check).
    await db.insert(member).values({ workspaceId: wsId, userId: other.id, role: "member" });

    const [session] = await db
      .insert(chatSession)
      .values({ workspaceId: wsId, agentId, creatorId: u.id, title: "Transcript", status: "active" })
      .returning();
    await db.insert(chatMessage).values([
      {
        chatSessionId: session!.id,
        role: "user",
        content: "first",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        chatSessionId: session!.id,
        role: "assistant",
        content: "second",
        createdAt: "2026-01-01T00:00:01.000Z",
        failureReason: "boom",
        elapsedMs: 1234,
      },
    ]);

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": wsId };

    try {
      const res = await app.request(`/api/chat/sessions/${session!.id}/messages`, { headers: auth });
      expect(res.status).toBe(200);
      const msgs = (await res.json()) as Array<{
        id: string;
        chat_session_id: string;
        role: string;
        content: string;
        task_id: string | null;
        failure_reason: string | null;
        elapsed_ms: number | null;
      }>;
      // ORDER BY created_at ASC → "first" before "second".
      expect(msgs.map((m) => m.content)).toEqual(["first", "second"]);
      expect(msgs[0]!.role).toBe("user");
      expect(msgs[0]!.chat_session_id).toBe(session!.id);
      expect(msgs[0]!.task_id).toBeNull();
      expect(msgs[1]!.failure_reason).toBe("boom");
      expect(msgs[1]!.elapsed_ms).toBe(1234);

      // invalid (non-UUID) session id → 400
      const bad = await app.request("/api/chat/sessions/not-a-uuid/messages", { headers: auth });
      expect(bad.status).toBe(400);

      // unknown session id → 404
      const missing = "88888888-8888-4888-8888-888888888888";
      const notFound = await app.request(`/api/chat/sessions/${missing}/messages`, { headers: auth });
      expect(notFound.status).toBe(404);

      // another member of the same workspace is NOT the creator → 404
      const foreign = await app.request(`/api/chat/sessions/${session!.id}/messages`, {
        headers: { Authorization: `Bearer ${otherToken}`, "X-Workspace-ID": wsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(member).where(eq(member.userId, other.id));
      await cleanup(db, wsId, u.id);
      await db.delete(user).where(eq(user.id, other.id));
      await close();
    }
  },
);
