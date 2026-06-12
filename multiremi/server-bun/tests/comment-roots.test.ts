/**
 * Comment roots_only mode: returns only top-level comments, each with
 * reply_count (subtree descendants, incl. nested) and last_activity_at
 * (MAX created_at over the subtree).
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { commentRoutes } from "../src/http/routes/comments.js";
import { user, member, workspace, issue, comment } from "../src/db/schema.js";
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

test.skipIf(!reachable)("roots_only returns top-level comments with subtree reply_count + last_activity", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-cr-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "CR WS", slug: `bun-cr-${stamp}`, issuePrefix: "CR", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [iss] = await db.insert(issue).values({ workspaceId: ws!.id, title: "Threaded", creatorType: "member", creatorId: u.id, number: 1 }).returning();

  const mk = async (content: string, parentId: string | null, atMs: number) =>
    (await db.insert(comment).values({ issueId: iss!.id, workspaceId: ws!.id, authorType: "member", authorId: u.id, content, type: "comment", parentId, createdAt: new Date(atMs).toISOString() }).returning())[0]!;

  // root A with a reply and a nested reply-to-reply; root B with no replies.
  const a = await mk("root A", null, stamp);
  const a1 = await mk("reply A1", a.id, stamp + 1000);
  await mk("reply A1.1", a1.id, stamp + 2000); // nested under A1
  const b = await mk("root B", null, stamp + 500);

  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => { c.set("user", { sub: u.id } as never); await n(); });
  app.route("/api/issues/:id/comments", commentRoutes(db));
  const hdr = { "X-Workspace-ID": ws!.id };

  try {
    const res = await app.request(`/api/issues/${iss!.id}/comments?roots_only=true`, { headers: hdr });
    expect(res.status).toBe(200);
    const roots = (await res.json()) as { id: string; reply_count: number; last_activity_at: string }[];
    // Only the two roots are returned (replies excluded).
    expect(roots.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    const rootA = roots.find((r) => r.id === a.id)!;
    const rootB = roots.find((r) => r.id === b.id)!;
    expect(rootA.reply_count).toBe(2); // A1 + A1.1 (nested counted)
    expect(rootB.reply_count).toBe(0);
    // last_activity reflects the newest descendant (A1.1 at +2000).
    expect(new Date(rootA.last_activity_at).getTime()).toBe(stamp + 2000);
    expect(new Date(rootB.last_activity_at).getTime()).toBe(stamp + 500);

    // Default mode still returns all 4 comments flat.
    const flat = (await (await app.request(`/api/issues/${iss!.id}/comments`, { headers: hdr })).json()) as unknown[];
    expect(flat.length).toBe(4);

    // since=<between A1 and A1.1> → only the comments created after the cursor.
    const cursor = new Date(stamp + 1500).toISOString();
    const sinceRes = await app.request(`/api/issues/${iss!.id}/comments?since=${encodeURIComponent(cursor)}`, { headers: hdr });
    const fresh = (await sinceRes.json()) as { content: string }[];
    expect(fresh.map((c) => c.content)).toEqual(["reply A1.1"]); // only the +2000 one
    // An invalid since → 400.
    expect((await app.request(`/api/issues/${iss!.id}/comments?since=not-a-date`, { headers: hdr })).status).toBe(400);
  } finally {
    await db.delete(comment).where(eq(comment.issueId, iss!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
