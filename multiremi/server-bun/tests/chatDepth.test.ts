/**
 * Chat depth endpoints (port of the Go GetChatSession / ListChatMessagesPage /
 * GetPendingChatTask): single-session fetch with creator-only access, keyset-
 * paged transcript with cursor round-trip + attachment enrichment, and the
 * pending-task poll the widget uses to recover in-flight state after refresh.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import type { Db } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { chatDepthRoutes } from "../src/http/routes/chatDepth.js";
import {
  user,
  member,
  workspace,
  agent,
  agentRuntime,
  agentTaskQueue,
  attachment,
  chatSession,
  chatMessage,
} from "../src/db/schema.js";
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

/** App with the JWT gate stubbed to a fixed subject (the factory declares
 *  absolute /api/* paths, so it mounts at "/"). */
function appFor(db: Db, sub: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => {
    c.set("user", { sub } as never);
    await n();
  });
  app.route("/", chatDepthRoutes(db));
  return app;
}

interface Fixture {
  db: Db;
  close: () => Promise<void>;
  uId: string;
  u2Id: string;
  wsId: string;
  agId: string;
  rtId: string;
  sessionId: string;
  hdr: Record<string, string>;
}

/** workspace → members (owner + plain member) → runtime → agent → session. */
async function makeFixture(tag: string): Promise<Fixture> {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-${tag}-a-${stamp}@bytedance.com`, cfg);
  const { user: u2 } = await findOrCreateUser(db, `bun-${tag}-b-${stamp}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "ChatDepth WS", slug: `bun-${tag}-${stamp}`, issuePrefix: "CD", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  await db.insert(member).values({ workspaceId: ws!.id, userId: u2.id, role: "member" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" })
    .returning();
  const [ag] = await db
    .insert(agent)
    .values({ workspaceId: ws!.id, name: "DepthBot", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id })
    .returning();
  const [cs] = await db
    .insert(chatSession)
    .values({ workspaceId: ws!.id, agentId: ag!.id, creatorId: u.id, title: "Depth", runtimeId: rt!.id })
    .returning();
  return {
    db,
    close,
    uId: u.id,
    u2Id: u2.id,
    wsId: ws!.id,
    agId: ag!.id,
    rtId: rt!.id,
    sessionId: cs!.id,
    hdr: { "Content-Type": "application/json", "X-Workspace-ID": ws!.id },
  };
}

/** Reverse-order teardown (leaf rows first). */
async function teardown(f: Fixture): Promise<void> {
  const { db } = f;
  await db.delete(attachment).where(eq(attachment.workspaceId, f.wsId));
  await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, f.agId));
  await db.delete(chatMessage).where(eq(chatMessage.chatSessionId, f.sessionId));
  await db.delete(chatSession).where(eq(chatSession.workspaceId, f.wsId));
  await db.delete(agent).where(eq(agent.workspaceId, f.wsId));
  await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, f.wsId));
  await db.delete(member).where(eq(member.workspaceId, f.wsId));
  await db.delete(workspace).where(eq(workspace.id, f.wsId));
  await db.delete(user).where(inArray(user.id, [f.uId, f.u2Id]));
  await f.close();
}

test.skipIf(!reachable)("GET single session: Go shape for the creator; 403 non-owner; 404 unknown; 400 bad id", async () => {
  const f = await makeFixture("cds");
  try {
    const app = appFor(f.db, f.uId);

    const res = await app.request(`/api/chat/sessions/${f.sessionId}`, { headers: f.hdr });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(f.sessionId);
    expect(body.workspace_id).toBe(f.wsId);
    expect(body.agent_id).toBe(f.agId);
    expect(body.creator_id).toBe(f.uId);
    expect(body.title).toBe("Depth");
    expect(body.status).toBe("active");
    expect(body.has_unread).toBe(false);
    expect(body.created_at).toBeTruthy();
    expect(body.updated_at).toBeTruthy();

    // Another member of the same workspace is not the creator → 403 (Go
    // "not your chat session" — sessions are private to their creator).
    const asOther = await appFor(f.db, f.u2Id).request(`/api/chat/sessions/${f.sessionId}`, { headers: f.hdr });
    expect(asOther.status).toBe(403);

    // Unknown session in this workspace → 404; malformed id → 400.
    const missing = await app.request("/api/chat/sessions/00000000-0000-4000-8000-000000000000", { headers: f.hdr });
    expect(missing.status).toBe(404);
    const malformed = await app.request("/api/chat/sessions/not-a-uuid", { headers: f.hdr });
    expect(malformed.status).toBe(400);
  } finally {
    await teardown(f);
  }
});

test.skipIf(!reachable)("messages/page: cursor walks newest→oldest windows, chronological within each; attachments surface", async () => {
  const f = await makeFixture("cdp");
  try {
    const app = appFor(f.db, f.uId);

    // Five messages at distinct seconds so windowing is deterministic.
    const base = "2026-01-01T00:00:0";
    const inserted: { id: string }[] = [];
    for (let i = 1; i <= 5; i++) {
      const [m] = await f.db
        .insert(chatMessage)
        .values({
          chatSessionId: f.sessionId,
          role: i % 2 === 1 ? "user" : "assistant",
          content: `m${i}`,
          createdAt: `${base}${i}Z`,
        })
        .returning();
      inserted.push({ id: m!.id });
    }
    // File card on the newest message.
    await f.db.insert(attachment).values({
      workspaceId: f.wsId,
      uploaderType: "member",
      uploaderId: f.uId,
      filename: "spec.pdf",
      url: "/files/spec.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      chatSessionId: f.sessionId,
      chatMessageId: inserted[4]!.id,
    });

    type Msg = { id: string; content: string; role: string; attachments?: { filename: string }[] };
    type Page = { messages: Msg[]; limit: number; has_more: boolean; next_cursor?: { created_at: string; id: string } };

    // Page 1 (no cursor): the two newest, chronological within the window.
    const p1res = await app.request(`/api/chat/sessions/${f.sessionId}/messages/page?limit=2`, { headers: f.hdr });
    expect(p1res.status).toBe(200);
    const p1 = (await p1res.json()) as Page;
    expect(p1.messages.map((m) => m.content)).toEqual(["m4", "m5"]);
    expect(p1.limit).toBe(2);
    expect(p1.has_more).toBe(true);
    // next_cursor anchors at the window's OLDEST row (m4).
    expect(p1.next_cursor?.id).toBe(p1.messages[0]!.id);
    // Attachment enrichment: m5 carries its file card; m4 has no key (omitempty).
    expect(p1.messages[1]!.attachments?.map((a) => a.filename)).toEqual(["spec.pdf"]);
    expect("attachments" in p1.messages[0]!).toBe(false);

    // Page 2: round-trip the cursor verbatim.
    const q2 = new URLSearchParams({
      limit: "2",
      before_created_at: p1.next_cursor!.created_at,
      before_id: p1.next_cursor!.id,
    });
    const p2 = (await (
      await app.request(`/api/chat/sessions/${f.sessionId}/messages/page?${q2}`, { headers: f.hdr })
    ).json()) as Page;
    expect(p2.messages.map((m) => m.content)).toEqual(["m2", "m3"]);
    expect(p2.has_more).toBe(true);

    // Page 3: the final window — has_more false, next_cursor omitted.
    const q3 = new URLSearchParams({
      limit: "2",
      before_created_at: p2.next_cursor!.created_at,
      before_id: p2.next_cursor!.id,
    });
    const p3 = (await (
      await app.request(`/api/chat/sessions/${f.sessionId}/messages/page?${q3}`, { headers: f.hdr })
    ).json()) as Page;
    expect(p3.messages.map((m) => m.content)).toEqual(["m1"]);
    expect(p3.has_more).toBe(false);
    expect("next_cursor" in p3).toBe(false);

    // Prepending pages reconstructs the full transcript exactly once, in order.
    const all = [...p3.messages, ...p2.messages, ...p1.messages].map((m) => m.content);
    expect(all).toEqual(["m1", "m2", "m3", "m4", "m5"]);

    // Default limit is 50: one page, everything, no cursor.
    const dflt = (await (
      await app.request(`/api/chat/sessions/${f.sessionId}/messages/page`, { headers: f.hdr })
    ).json()) as Page;
    expect(dflt.limit).toBe(50);
    expect(dflt.has_more).toBe(false);
    expect(dflt.messages.length).toBe(5);

    // Param validation mirrors Go: limit out of [1,100] / non-integer → 400
    // "invalid limit"; a half cursor or garbage timestamp → 400 "invalid cursor".
    for (const bad of ["limit=0", "limit=101", "limit=abc"]) {
      const res = await app.request(`/api/chat/sessions/${f.sessionId}/messages/page?${bad}`, { headers: f.hdr });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid limit");
    }
    const half = await app.request(
      `/api/chat/sessions/${f.sessionId}/messages/page?before_id=${inserted[0]!.id}`,
      { headers: f.hdr },
    );
    expect(half.status).toBe(400);
    expect(((await half.json()) as { error: string }).error).toBe("invalid cursor");
    const badTs = await app.request(
      `/api/chat/sessions/${f.sessionId}/messages/page?before_created_at=garbage&before_id=${inserted[0]!.id}`,
      { headers: f.hdr },
    );
    expect(badTs.status).toBe(400);
  } finally {
    await teardown(f);
  }
});

test.skipIf(!reachable)("pending-task: {} when idle; ignores terminal tasks; returns the newest in-flight one", async () => {
  const f = await makeFixture("cdt");
  try {
    const app = appFor(f.db, f.uId);
    const url = `/api/chat/sessions/${f.sessionId}/pending-task`;

    // No tasks at all → empty object (not an error).
    const empty = await app.request(url, { headers: f.hdr });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({});

    // A terminal task does not count as pending.
    await f.db.insert(agentTaskQueue).values({
      agentId: f.agId,
      runtimeId: f.rtId,
      chatSessionId: f.sessionId,
      status: "completed",
      createdAt: "2026-01-01T00:00:01Z",
    });
    expect(await (await app.request(url, { headers: f.hdr })).json()).toEqual({});

    // Two in-flight tasks → the newest one wins.
    await f.db.insert(agentTaskQueue).values({
      agentId: f.agId,
      runtimeId: f.rtId,
      chatSessionId: f.sessionId,
      status: "queued",
      createdAt: "2026-01-01T00:00:02Z",
    });
    const [running] = await f.db
      .insert(agentTaskQueue)
      .values({
        agentId: f.agId,
        runtimeId: f.rtId,
        chatSessionId: f.sessionId,
        status: "running",
        createdAt: "2026-01-01T00:00:03Z",
      })
      .returning();
    const pending = (await (await app.request(url, { headers: f.hdr })).json()) as {
      task_id: string;
      status: string;
      created_at: string;
    };
    expect(pending.task_id).toBe(running!.id);
    expect(pending.status).toBe("running");
    expect(pending.created_at).toBeTruthy();

    // Creator-only access applies here too.
    expect((await appFor(f.db, f.u2Id).request(url, { headers: f.hdr })).status).toBe(403);
  } finally {
    await teardown(f);
  }
});
