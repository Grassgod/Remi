/**
 * Comment action routes — PUT/DELETE /api/comments/:commentId plus the
 * reactions and resolve subresources (port of Go UpdateComment, DeleteComment,
 * AddReaction, RemoveReaction, ResolveComment, UnresolveComment).
 *
 * DB-gated like the other suites: probes the local Postgres and skips when
 * unreachable. Fixtures use unique epoch-millis suffixes; teardown deletes in
 * reverse FK order in a finally block.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import {
  agent,
  agentRuntime,
  agentTaskQueue,
  attachment,
  comment,
  commentReaction,
  issue,
  member,
  user,
  workspace,
} from "../src/db/schema.js";
import { commentActionsRoutes } from "../src/http/routes/commentActions.js";
import { bus, type BusEvent } from "../src/realtime/bus.js";
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

type TestDb = ReturnType<typeof createDb>["db"];

/** The routes declare absolute /api/comments/* paths; mount at the root. */
function makeApp(db: TestDb) {
  const app = createApp(cfg, db);
  app.route("/", commentActionsRoutes(db));
  return app;
}

/**
 * Full fixture chain: owner u1 + plain member u2, workspace, runtime, agent
 * (owned by u1), one issue. Comments are created per test. cleanup() deletes
 * children → parents (reverse FK order).
 */
async function setupFixture(db: TestDb, slug: string) {
  const { user: u1 } = await findOrCreateUser(db, `${slug}-a@bytedance.com`, cfg);
  const { user: u2 } = await findOrCreateUser(db, `${slug}-b@bytedance.com`, cfg);
  const token1 = await issueJWT({ sub: u1.id, email: u1.email, name: u1.name }, SECRET);
  const token2 = await issueJWT({ sub: u2.id, email: u2.email, name: u2.name }, SECRET);

  const [ws] = await db
    .insert(workspace)
    .values({ name: "CommentActions WS", slug, issuePrefix: "CAC" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u1.id, role: "owner" });
  await db.insert(member).values({ workspaceId: ws!.id, userId: u2.id, role: "member" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" })
    .returning();
  const [ag] = await db
    .insert(agent)
    .values({
      workspaceId: ws!.id,
      name: "Worker",
      runtimeId: rt!.id,
      runtimeMode: "local",
      instructions: "do work",
      ownerId: u1.id,
    })
    .returning();
  const [iss] = await db
    .insert(issue)
    .values({
      workspaceId: ws!.id,
      title: "Comment actions issue",
      status: "in_progress",
      priority: "none",
      creatorType: "member",
      creatorId: u1.id,
      number: 1,
    })
    .returning();

  const cleanup = async () => {
    await db.delete(commentReaction).where(eq(commentReaction.workspaceId, ws!.id));
    await db.delete(attachment).where(eq(attachment.workspaceId, ws!.id));
    await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, ag!.id));
    await db.delete(comment).where(eq(comment.workspaceId, ws!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u1.id));
    await db.delete(user).where(eq(user.id, u2.id));
  };

  return { u1, u2, token1, token2, ws: ws!, rt: rt!, ag: ag!, iss: iss!, cleanup };
}

function authHeaders(token: string, wsId: string) {
  return { Authorization: `Bearer ${token}`, "X-Workspace-ID": wsId, "Content-Type": "application/json" };
}

async function insertComment(db: TestDb, wsId: string, issueId: string, authorId: string, content: string, parentId?: string) {
  const [c] = await db
    .insert(comment)
    .values({
      issueId,
      workspaceId: wsId,
      authorType: "member",
      authorId,
      content,
      type: "comment",
      ...(parentId ? { parentId } : {}),
    })
    .returning();
  return c!;
}

test.skipIf(!reachable)("PUT /api/comments/:id — author edits own; owner edits others; non-author member 403", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const fx = await setupFixture(db, `bun-cact-edit-${Date.now()}`);
  const events: BusEvent[] = [];
  const unsub = bus.subscribe(fx.ws.id, (e) => events.push(e));

  try {
    const c1 = await insertComment(db, fx.ws.id, fx.iss.id, fx.u1.id, "owner's comment");
    const c2 = await insertComment(db, fx.ws.id, fx.iss.id, fx.u2.id, "member's comment");

    // author (plain member) edits own comment → 200, full Go CommentResponse shape
    const r1 = await app.request(`/api/comments/${c2.id}`, {
      method: "PUT",
      headers: authHeaders(fx.token2, fx.ws.id),
      body: JSON.stringify({ content: "edited by author" }),
    });
    expect(r1.status).toBe(200);
    const edited = (await r1.json()) as Record<string, unknown>;
    expect(edited.id).toBe(c2.id);
    expect(edited.issue_id).toBe(fx.iss.id);
    expect(edited.content).toBe("edited by author");
    expect(edited.author_type).toBe("member");
    expect(edited.author_id).toBe(fx.u2.id);
    expect(edited.parent_id).toBeNull();
    expect(edited.resolved_at).toBeNull();
    expect(edited.reactions).toEqual([]);
    expect(edited.attachments).toEqual([]);
    // updated_at moved past the insert-time value
    expect(edited.updated_at).not.toBe(c2.updatedAt);
    // realtime: comment:updated carrying the full comment payload
    const updEvent = events.find((e) => e.type === "comment:updated");
    expect(updEvent).toBeDefined();
    expect((updEvent!.payload as { comment: { id: string } }).comment.id).toBe(c2.id);

    // non-author plain member editing someone else's comment → 403
    const r2 = await app.request(`/api/comments/${c1.id}`, {
      method: "PUT",
      headers: authHeaders(fx.token2, fx.ws.id),
      body: JSON.stringify({ content: "hijack" }),
    });
    expect(r2.status).toBe(403);
    expect(((await r2.json()) as { error: string }).error).toBe("only comment author or admin can edit");

    // workspace owner editing the member's comment → 200 (admin path)
    const r3 = await app.request(`/api/comments/${c2.id}`, {
      method: "PUT",
      headers: authHeaders(fx.token1, fx.ws.id),
      body: JSON.stringify({ content: "edited by owner" }),
    });
    expect(r3.status).toBe(200);
    expect(((await r3.json()) as { content: string }).content).toBe("edited by owner");

    // empty content → 400
    const r4 = await app.request(`/api/comments/${c2.id}`, {
      method: "PUT",
      headers: authHeaders(fx.token2, fx.ws.id),
      body: JSON.stringify({ content: "" }),
    });
    expect(r4.status).toBe(400);
    expect(((await r4.json()) as { error: string }).error).toBe("content is required");

    // malformed comment id → 400; unknown but valid → 404
    const bad = await app.request("/api/comments/not-a-uuid", {
      method: "PUT",
      headers: authHeaders(fx.token2, fx.ws.id),
      body: JSON.stringify({ content: "x" }),
    });
    expect(bad.status).toBe(400);
    const missing = await app.request("/api/comments/99999999-9999-4999-8999-999999999999", {
      method: "PUT",
      headers: authHeaders(fx.token2, fx.ws.id),
      body: JSON.stringify({ content: "x" }),
    });
    expect(missing.status).toBe(404);
  } finally {
    unsub();
    await fx.cleanup();
    await close();
  }
});

test.skipIf(!reachable)("PUT attachment_ids — omitted preserves links; present replaces the set; [] unlinks all", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const fx = await setupFixture(db, `bun-cact-att-${Date.now()}`);

  try {
    const c1 = await insertComment(db, fx.ws.id, fx.iss.id, fx.u1.id, "with attachments");
    const mkAtt = async (linked: boolean) => {
      const [a] = await db
        .insert(attachment)
        .values({
          workspaceId: fx.ws.id,
          issueId: fx.iss.id,
          commentId: linked ? c1.id : null,
          uploaderType: "member",
          uploaderId: fx.u1.id,
          filename: "f.txt",
          url: "att/f.txt",
          contentType: "text/plain",
          sizeBytes: 4,
        })
        .returning();
      return a!;
    };
    const a1 = await mkAtt(true); // linked, will be dropped on replace
    const a2 = await mkAtt(true); // linked, kept
    const a3 = await mkAtt(false); // unlinked, added on replace

    const linkedIds = async () => {
      const rows = await db
        .select({ id: attachment.id })
        .from(attachment)
        .where(and(eq(attachment.workspaceId, fx.ws.id), eq(attachment.commentId, c1.id)));
      return rows.map((r) => r.id).sort();
    };

    // attachment_ids omitted (older client) → links preserved
    const keep = await app.request(`/api/comments/${c1.id}`, {
      method: "PUT",
      headers: authHeaders(fx.token1, fx.ws.id),
      body: JSON.stringify({ content: "edited, attachments untouched" }),
    });
    expect(keep.status).toBe(200);
    const keptBody = (await keep.json()) as { attachments: Array<{ id: string; download_url: string }> };
    expect(keptBody.attachments.length).toBe(2);
    expect(await linkedIds()).toEqual([a1.id, a2.id].sort());

    // attachment_ids [a2, a3] → a1 unlinked, a2 kept, a3 linked
    const replace = await app.request(`/api/comments/${c1.id}`, {
      method: "PUT",
      headers: authHeaders(fx.token1, fx.ws.id),
      body: JSON.stringify({ content: "replaced set", attachment_ids: [a2.id, a3.id] }),
    });
    expect(replace.status).toBe(200);
    const replacedBody = (await replace.json()) as { attachments: Array<{ id: string; download_url: string }> };
    expect(replacedBody.attachments.map((a) => a.id).sort()).toEqual([a2.id, a3.id].sort());
    expect(replacedBody.attachments[0]!.download_url).toBe(`/api/attachments/${replacedBody.attachments[0]!.id}/download`);
    expect(await linkedIds()).toEqual([a2.id, a3.id].sort());
    // a1 is unlinked, not deleted
    const [a1Row] = await db.select().from(attachment).where(eq(attachment.id, a1.id));
    expect(a1Row!.commentId).toBeNull();

    // attachment_ids [] → everything unlinked
    const clear = await app.request(`/api/comments/${c1.id}`, {
      method: "PUT",
      headers: authHeaders(fx.token1, fx.ws.id),
      body: JSON.stringify({ content: "cleared set", attachment_ids: [] }),
    });
    expect(clear.status).toBe(200);
    expect(((await clear.json()) as { attachments: unknown[] }).attachments).toEqual([]);
    expect(await linkedIds()).toEqual([]);

    // malformed attachment id → 400
    const badIds = await app.request(`/api/comments/${c1.id}`, {
      method: "PUT",
      headers: authHeaders(fx.token1, fx.ws.id),
      body: JSON.stringify({ content: "x", attachment_ids: ["nope"] }),
    });
    expect(badIds.status).toBe(400);
  } finally {
    await fx.cleanup();
    await close();
  }
});

test.skipIf(!reachable)("edit cancels stale trigger tasks and re-parses mentions; DELETE cancels and removes", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const fx = await setupFixture(db, `bun-cact-del-${Date.now()}`);
  const events: BusEvent[] = [];
  const unsub = bus.subscribe(fx.ws.id, (e) => events.push(e));

  try {
    const c1 = await insertComment(db, fx.ws.id, fx.iss.id, fx.u1.id, "please look at this");
    // Simulate the create-path trigger: a queued task carrying this comment.
    const [t1] = await db
      .insert(agentTaskQueue)
      .values({ agentId: fx.ag.id, runtimeId: fx.rt.id, issueId: fx.iss.id, status: "queued", triggerCommentId: c1.id })
      .returning();

    // Edit that adds a mention → stale task cancelled, fresh task enqueued.
    const mention = `[@Worker](mention://agent/${fx.ag.id})`;
    const r1 = await app.request(`/api/comments/${c1.id}`, {
      method: "PUT",
      headers: authHeaders(fx.token1, fx.ws.id),
      body: JSON.stringify({ content: `now for you ${mention}` }),
    });
    expect(r1.status).toBe(200);
    const [t1After] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, t1!.id));
    expect(t1After!.status).toBe("cancelled");
    expect(t1After!.completedAt).not.toBeNull();
    expect(events.some((e) => e.type === "task:cancelled" && (e.payload as { task_id: string }).task_id === t1!.id)).toBe(true);
    const fresh = await db
      .select()
      .from(agentTaskQueue)
      .where(and(eq(agentTaskQueue.triggerCommentId, c1.id), eq(agentTaskQueue.status, "queued")));
    expect(fresh.length).toBe(1);
    expect(fresh[0]!.agentId).toBe(fx.ag.id);

    // non-author plain member delete → 403
    const forbidden = await app.request(`/api/comments/${c1.id}`, {
      method: "DELETE",
      headers: authHeaders(fx.token2, fx.ws.id),
    });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: string }).error).toBe("only comment author or admin can delete");

    // author delete → 204; row gone; the re-triggered task is cancelled too
    const del = await app.request(`/api/comments/${c1.id}`, {
      method: "DELETE",
      headers: authHeaders(fx.token1, fx.ws.id),
    });
    expect(del.status).toBe(204);
    const remaining = await db.select().from(comment).where(eq(comment.id, c1.id));
    expect(remaining.length).toBe(0);
    const [freshAfter] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, fresh[0]!.id));
    expect(freshAfter!.status).toBe("cancelled");
    const delEvent = events.find((e) => e.type === "comment:deleted");
    expect(delEvent).toBeDefined();
    expect(delEvent!.payload).toEqual({ comment_id: c1.id, issue_id: fx.iss.id });

    // delete again → 404
    const gone = await app.request(`/api/comments/${c1.id}`, {
      method: "DELETE",
      headers: authHeaders(fx.token1, fx.ws.id),
    });
    expect(gone.status).toBe(404);
  } finally {
    unsub();
    await fx.cleanup();
    await close();
  }
});

test.skipIf(!reachable)("reactions — add (upsert) + remove round-trip with realtime events", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const fx = await setupFixture(db, `bun-cact-react-${Date.now()}`);
  const events: BusEvent[] = [];
  const unsub = bus.subscribe(fx.ws.id, (e) => events.push(e));

  try {
    const c1 = await insertComment(db, fx.ws.id, fx.iss.id, fx.u1.id, "react to me");

    // add → 201 with the Go ReactionResponse shape
    const add = await app.request(`/api/comments/${c1.id}/reactions`, {
      method: "POST",
      headers: authHeaders(fx.token2, fx.ws.id),
      body: JSON.stringify({ emoji: "👍" }),
    });
    expect(add.status).toBe(201);
    const reaction = (await add.json()) as Record<string, unknown>;
    expect(reaction.comment_id).toBe(c1.id);
    expect(reaction.actor_type).toBe("member");
    expect(reaction.actor_id).toBe(fx.u2.id);
    expect(reaction.emoji).toBe("👍");
    expect(typeof reaction.id).toBe("string");
    expect(typeof reaction.created_at).toBe("string");

    // realtime payload carries issue context for inbox notifications
    const addEvent = events.find((e) => e.type === "reaction:added");
    expect(addEvent).toBeDefined();
    const addPayload = addEvent!.payload as Record<string, unknown>;
    expect(addPayload.issue_id).toBe(fx.iss.id);
    expect(addPayload.issue_title).toBe("Comment actions issue");
    expect(addPayload.issue_status).toBe("in_progress");
    expect(addPayload.comment_id).toBe(c1.id);
    expect(addPayload.comment_author_type).toBe("member");
    expect(addPayload.comment_author_id).toBe(fx.u1.id);

    // duplicate add → upsert no-op returning the same row
    const dup = await app.request(`/api/comments/${c1.id}/reactions`, {
      method: "POST",
      headers: authHeaders(fx.token2, fx.ws.id),
      body: JSON.stringify({ emoji: "👍" }),
    });
    expect(dup.status).toBe(201);
    expect(((await dup.json()) as { id: string }).id).toBe(reaction.id);

    // the comment response now embeds the reaction (edit round-trip)
    const edit = await app.request(`/api/comments/${c1.id}`, {
      method: "PUT",
      headers: authHeaders(fx.token1, fx.ws.id),
      body: JSON.stringify({ content: "react to me!" }),
    });
    const withReactions = (await edit.json()) as { reactions: Array<{ emoji: string; actor_id: string }> };
    expect(withReactions.reactions.length).toBe(1);
    expect(withReactions.reactions[0]!.emoji).toBe("👍");

    // emoji required → 400
    const noEmoji = await app.request(`/api/comments/${c1.id}/reactions`, {
      method: "POST",
      headers: authHeaders(fx.token2, fx.ws.id),
      body: JSON.stringify({}),
    });
    expect(noEmoji.status).toBe(400);
    expect(((await noEmoji.json()) as { error: string }).error).toBe("emoji is required");

    // remove → 204, row gone, reaction:removed published
    const rm = await app.request(`/api/comments/${c1.id}/reactions`, {
      method: "DELETE",
      headers: authHeaders(fx.token2, fx.ws.id),
      body: JSON.stringify({ emoji: "👍" }),
    });
    expect(rm.status).toBe(204);
    const rows = await db.select().from(commentReaction).where(eq(commentReaction.commentId, c1.id));
    expect(rows.length).toBe(0);
    const rmEvent = events.find((e) => e.type === "reaction:removed");
    expect(rmEvent).toBeDefined();
    expect(rmEvent!.payload).toEqual({
      comment_id: c1.id,
      issue_id: fx.iss.id,
      emoji: "👍",
      actor_type: "member",
      actor_id: fx.u2.id,
    });
  } finally {
    unsub();
    await fx.cleanup();
    await close();
  }
});

test.skipIf(!reachable)("resolve + unresolve — idempotent round-trip; replies cannot be resolved", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const fx = await setupFixture(db, `bun-cact-res-${Date.now()}`);
  const events: BusEvent[] = [];
  const unsub = bus.subscribe(fx.ws.id, (e) => events.push(e));

  try {
    const root = await insertComment(db, fx.ws.id, fx.iss.id, fx.u1.id, "root thread");
    const reply = await insertComment(db, fx.ws.id, fx.iss.id, fx.u2.id, "a reply", root.id);

    // any member may resolve (no author gate in Go)
    const res = await app.request(`/api/comments/${root.id}/resolve`, {
      method: "POST",
      headers: authHeaders(fx.token2, fx.ws.id),
    });
    expect(res.status).toBe(200);
    const resolved = (await res.json()) as Record<string, unknown>;
    expect(resolved.resolved_at).not.toBeNull();
    expect(resolved.resolved_by_type).toBe("member");
    expect(resolved.resolved_by_id).toBe(fx.u2.id);
    expect(events.filter((e) => e.type === "comment:resolved").length).toBe(1);

    // re-resolve by a different member → 200, original resolver kept, no second event
    const again = await app.request(`/api/comments/${root.id}/resolve`, {
      method: "POST",
      headers: authHeaders(fx.token1, fx.ws.id),
    });
    expect(again.status).toBe(200);
    const reResolved = (await again.json()) as Record<string, unknown>;
    expect(reResolved.resolved_by_id).toBe(fx.u2.id);
    expect(reResolved.resolved_at).toBe(resolved.resolved_at);
    expect(events.filter((e) => e.type === "comment:resolved").length).toBe(1);

    // replies are not resolvable
    const replyRes = await app.request(`/api/comments/${reply.id}/resolve`, {
      method: "POST",
      headers: authHeaders(fx.token1, fx.ws.id),
    });
    expect(replyRes.status).toBe(400);
    expect(((await replyRes.json()) as { error: string }).error).toBe("only root comments can be resolved");

    // unresolve → 200 with cleared fields + one comment:unresolved event
    const unres = await app.request(`/api/comments/${root.id}/resolve`, {
      method: "DELETE",
      headers: authHeaders(fx.token1, fx.ws.id),
    });
    expect(unres.status).toBe(200);
    const cleared = (await unres.json()) as Record<string, unknown>;
    expect(cleared.resolved_at).toBeNull();
    expect(cleared.resolved_by_type).toBeNull();
    expect(cleared.resolved_by_id).toBeNull();
    expect(events.filter((e) => e.type === "comment:unresolved").length).toBe(1);

    // unresolve again → idempotent no-op, no second event
    const unresAgain = await app.request(`/api/comments/${root.id}/resolve`, {
      method: "DELETE",
      headers: authHeaders(fx.token1, fx.ws.id),
    });
    expect(unresAgain.status).toBe(200);
    expect(events.filter((e) => e.type === "comment:unresolved").length).toBe(1);
  } finally {
    unsub();
    await fx.cleanup();
    await close();
  }
});

test.skipIf(!reachable)("cross-workspace access 404s on every endpoint; missing workspace header 400s", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const fx = await setupFixture(db, `bun-cact-xws-${stamp}`);
  // Second workspace where u1 is also a member — the gate passes but the
  // comment must not resolve (Go GetCommentInWorkspace tenant scope).
  const [ws2] = await db
    .insert(workspace)
    .values({ name: "Other WS", slug: `bun-cact-xws2-${stamp}`, issuePrefix: "XW2" })
    .returning();
  await db.insert(member).values({ workspaceId: ws2!.id, userId: fx.u1.id, role: "owner" });

  try {
    const c1 = await insertComment(db, fx.ws.id, fx.iss.id, fx.u1.id, "lives in ws1");
    const foreign = authHeaders(fx.token1, ws2!.id);

    const put = await app.request(`/api/comments/${c1.id}`, {
      method: "PUT",
      headers: foreign,
      body: JSON.stringify({ content: "x" }),
    });
    expect(put.status).toBe(404);
    const del = await app.request(`/api/comments/${c1.id}`, { method: "DELETE", headers: foreign });
    expect(del.status).toBe(404);
    const react = await app.request(`/api/comments/${c1.id}/reactions`, {
      method: "POST",
      headers: foreign,
      body: JSON.stringify({ emoji: "🎉" }),
    });
    expect(react.status).toBe(404);
    const unreact = await app.request(`/api/comments/${c1.id}/reactions`, {
      method: "DELETE",
      headers: foreign,
      body: JSON.stringify({ emoji: "🎉" }),
    });
    expect(unreact.status).toBe(404);
    const resolve = await app.request(`/api/comments/${c1.id}/resolve`, { method: "POST", headers: foreign });
    expect(resolve.status).toBe(404);
    const unresolve = await app.request(`/api/comments/${c1.id}/resolve`, { method: "DELETE", headers: foreign });
    expect(unresolve.status).toBe(404);

    // and the comment is untouched
    const [row] = await db.select().from(comment).where(eq(comment.id, c1.id));
    expect(row!.content).toBe("lives in ws1");
    expect(row!.resolvedAt).toBeNull();

    // missing X-Workspace-ID header → 400
    const noWs = await app.request(`/api/comments/${c1.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${fx.token1}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(noWs.status).toBe(400);
  } finally {
    await db.delete(member).where(eq(member.workspaceId, ws2!.id));
    await db.delete(workspace).where(eq(workspace.id, ws2!.id));
    await fx.cleanup();
    await close();
  }
});
