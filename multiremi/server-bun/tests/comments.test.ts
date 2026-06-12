import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, issue, comment } from "../src/db/schema.js";
import { commentRoutes } from "../src/http/routes/comments.js";
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
 * The comment routes are mounted at /api/issues/:id/comments by the orchestrator
 * in app.ts. createApp() does not know about them yet, so the test wires the
 * sub-router onto the produced app the same way app.ts will — this keeps the
 * test self-contained against the not-yet-registered route.
 */
function appWith(db: ReturnType<typeof createDb>["db"]) {
  const app = createApp(cfg, db);
  app.route("/api/issues/:id/comments", commentRoutes(db));
  return app;
}

test.skipIf(!reachable)("comments read path: list is workspace-scoped, chronological, resolves issue by MUL-N", async () => {
  const { db, close } = createDb(DB_URL);
  const app = appWith(db);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-cmt-${stamp}@bytedance.com`, cfg);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

  const [ws] = await db
    .insert(workspace)
    .values({ name: "Comment WS", slug: `bun-cmt-${stamp}`, issuePrefix: "CMT" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [iss] = await db
    .insert(issue)
    .values({
      workspaceId: ws!.id,
      title: "Issue with comments",
      status: "backlog",
      priority: "none",
      creatorType: "member",
      creatorId: u.id,
      number: 7,
    })
    .returning();
  // Two comments inserted out of chronological order to assert ordering.
  const [c2] = await db
    .insert(comment)
    .values({
      issueId: iss!.id,
      workspaceId: ws!.id,
      authorType: "member",
      authorId: u.id,
      content: "second",
      type: "comment",
      createdAt: new Date(stamp + 1000).toISOString(),
    })
    .returning();
  const [c1] = await db
    .insert(comment)
    .values({
      issueId: iss!.id,
      workspaceId: ws!.id,
      authorType: "member",
      authorId: u.id,
      content: "first",
      type: "comment",
      createdAt: new Date(stamp).toISOString(),
    })
    .returning();

  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

  try {
    // list by human identifier (MUL-N style) — resolves the issue in the workspace
    const listRes = await app.request("/api/issues/CMT-7/comments", { headers: auth });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{
      id: string;
      issue_id: string;
      content: string;
      author_type: string;
      author_id: string;
      type: string;
      parent_id: string | null;
      reactions: unknown[];
      attachments: unknown[];
    }>;
    expect(list.length).toBe(2);
    // chronological: oldest → newest
    expect(list[0]!.content).toBe("first");
    expect(list[1]!.content).toBe("second");
    expect(list[0]!.id).toBe(c1!.id);
    expect(list[1]!.id).toBe(c2!.id);
    // response shape (Go CommentResponse field names + empty arrays)
    expect(list[0]!.issue_id).toBe(iss!.id);
    expect(list[0]!.author_type).toBe("member");
    expect(list[0]!.author_id).toBe(u.id);
    expect(list[0]!.type).toBe("comment");
    expect(list[0]!.parent_id).toBeNull();
    expect(list[0]!.reactions).toEqual([]);
    expect(list[0]!.attachments).toEqual([]);

    // list by UUID also resolves the issue
    const byUuid = await app.request(`/api/issues/${iss!.id}/comments`, { headers: auth });
    expect(byUuid.status).toBe(200);
    expect(((await byUuid.json()) as unknown[]).length).toBe(2);

    // missing workspace header → 400
    const noWs = await app.request("/api/issues/CMT-7/comments", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(noWs.status).toBe(400);

    // member of no/other workspace → 404 (multi-tenancy gate)
    const otherWsId = "99999999-9999-4999-8999-999999999999";
    const foreign = await app.request("/api/issues/CMT-7/comments", {
      headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
    });
    expect(foreign.status).toBe(404);

    // unknown issue in this workspace → 404
    const noIssue = await app.request("/api/issues/CMT-999/comments", { headers: auth });
    expect(noIssue.status).toBe(404);
  } finally {
    await db.delete(comment).where(eq(comment.issueId, iss!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

test.skipIf(!reachable)("POST comment: creates as member, defaults type, validates content + parent_id", async () => {
  const { db, close } = createDb(DB_URL);
  const app = appWith(db);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-cmc-${stamp}@bytedance.com`, cfg);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "Comment Create WS", slug: `bun-cmc-${stamp}`, issuePrefix: "CMC" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [iss] = await db
    .insert(issue)
    .values({
      workspaceId: ws!.id,
      title: "Create comments here",
      status: "backlog",
      priority: "none",
      creatorType: "member",
      creatorId: u.id,
      number: 3,
    })
    .returning();
  // A second issue to assert cross-issue parent_id rejection.
  const [other] = await db
    .insert(issue)
    .values({
      workspaceId: ws!.id,
      title: "Other issue",
      status: "backlog",
      priority: "none",
      creatorType: "member",
      creatorId: u.id,
      number: 4,
    })
    .returning();
  const [otherComment] = await db
    .insert(comment)
    .values({
      issueId: other!.id,
      workspaceId: ws!.id,
      authorType: "member",
      authorId: u.id,
      content: "on other issue",
      type: "comment",
    })
    .returning();

  const auth = {
    Authorization: `Bearer ${token}`,
    "X-Workspace-ID": ws!.id,
    "Content-Type": "application/json",
  };

  try {
    // create a root comment — type defaults to "comment", author is the member
    const r1 = await app.request("/api/issues/CMC-3/comments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "Hello world" }),
    });
    expect(r1.status).toBe(201);
    const root = (await r1.json()) as {
      id: string;
      issue_id: string;
      content: string;
      type: string;
      author_type: string;
      author_id: string;
      parent_id: string | null;
      reactions: unknown[];
      attachments: unknown[];
    };
    expect(root.content).toBe("Hello world");
    expect(root.type).toBe("comment");
    expect(root.author_type).toBe("member");
    expect(root.author_id).toBe(u.id);
    expect(root.issue_id).toBe(iss!.id);
    expect(root.parent_id).toBeNull();
    expect(root.reactions).toEqual([]);
    expect(root.attachments).toEqual([]);

    // reply referencing the root on the same issue — accepted, non-default type
    // passed through verbatim (type enum is enforced by the DB check constraint,
    // matching the Go handler which also does not pre-validate the value)
    const r2 = await app.request("/api/issues/CMC-3/comments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "A reply", type: "progress_update", parent_id: root.id }),
    });
    expect(r2.status).toBe(201);
    const reply = (await r2.json()) as { parent_id: string | null; type: string };
    expect(reply.parent_id).toBe(root.id);
    expect(reply.type).toBe("progress_update");

    // empty content → 400
    const empty = await app.request("/api/issues/CMC-3/comments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "" }),
    });
    expect(empty.status).toBe(400);

    // malformed parent_id → 400
    const badParent = await app.request("/api/issues/CMC-3/comments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "x", parent_id: "not-a-uuid" }),
    });
    expect(badParent.status).toBe(400);

    // parent_id pointing at a comment on a different issue → 400
    const crossIssue = await app.request("/api/issues/CMC-3/comments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "x", parent_id: otherComment!.id }),
    });
    expect(crossIssue.status).toBe(400);

    // create against unknown issue → 404
    const noIssue = await app.request("/api/issues/CMC-999/comments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "x" }),
    });
    expect(noIssue.status).toBe(404);
  } finally {
    await db.delete(comment).where(eq(comment.workspaceId, ws!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
