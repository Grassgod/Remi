/**
 * Misc single-resource action routes: label get/update/delete, issue
 * subscribe/unsubscribe, issue rerun, inbox archive, attachment delete +
 * content preview, task transcript, bare task cancel, /api/tokens aliases.
 * Live-DB tests gated on a reachable Postgres (skipIf), with fixtures inserted
 * via Drizzle and torn down in reverse order in finally (mirrors
 * tests/issueTasks.test.ts).
 *
 * miscActionsRoutes declares absolute /api/* paths and is not yet mounted in
 * app.ts, so each test mounts it onto the createApp shell (the JWT gate
 * registered by createApp still applies to routes added afterwards).
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http/app.js";
import { miscActionsRoutes } from "../src/http/routes/miscActions.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { bus, type BusEvent } from "../src/realtime/bus.js";
import { LocalStorage } from "../src/storage/local.js";
import type { Storage } from "../src/storage/storage.js";
import {
  user,
  member,
  workspace,
  issue,
  agent,
  agentRuntime,
  agentTaskQueue,
  taskMessage,
  issueLabel,
  issueSubscriber,
  inboxItem,
  attachment,
  squad,
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

type TestDb = ReturnType<typeof createDb>["db"];

/** Build the full fixture chain. Returns ids + a cleanup fn (children → parents). */
async function setupFixture(db: TestDb, slug: string) {
  const { user: u } = await findOrCreateUser(db, `${slug}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "MiscActions WS", slug, issuePrefix: "MSC", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
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
      ownerId: u.id,
    })
    .returning();
  const [iss] = await db
    .insert(issue)
    .values({
      workspaceId: ws!.id,
      title: "misc issue",
      creatorType: "member",
      creatorId: u.id,
      number: 1,
      priority: "high",
    })
    .returning();

  const cleanup = async () => {
    const wsAgents = db.select({ id: agent.id }).from(agent).where(eq(agent.workspaceId, ws!.id));
    const wsTasks = db
      .select({ id: agentTaskQueue.id })
      .from(agentTaskQueue)
      .where(inArray(agentTaskQueue.agentId, wsAgents));
    const wsIssues = db.select({ id: issue.id }).from(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(taskMessage).where(inArray(taskMessage.taskId, wsTasks));
    await db.delete(agentTaskQueue).where(inArray(agentTaskQueue.agentId, wsAgents));
    await db.delete(issueSubscriber).where(inArray(issueSubscriber.issueId, wsIssues));
    await db.delete(issueLabel).where(eq(issueLabel.workspaceId, ws!.id));
    await db.delete(inboxItem).where(eq(inboxItem.workspaceId, ws!.id));
    await db.delete(attachment).where(eq(attachment.workspaceId, ws!.id));
    await db.delete(squad).where(eq(squad.workspaceId, ws!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(personalAccessToken).where(eq(personalAccessToken.userId, u.id));
    await db.delete(user).where(eq(user.id, u.id));
  };

  return { u, ws: ws!, rt: rt!, ag: ag!, iss: iss!, cleanup };
}

function makeApp(db: TestDb, storage?: Storage) {
  const app = createApp(cfg, db);
  app.route("/", miscActionsRoutes(db, storage));
  return app;
}

async function authFor(db: TestDb, u: { id: string; email: string; name: string }, wsId: string) {
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  return { Authorization: `Bearer ${token}`, "X-Workspace-ID": wsId };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test.skipIf(!reachable)("GET/PUT/DELETE /api/labels/:id — full single-label lifecycle + 409 + cross-workspace 404", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, cleanup } = await setupFixture(db, `bun-msc-lb-${stamp}`);
  const auth = await authFor(db, u, ws.id);

  const [bug] = await db
    .insert(issueLabel)
    .values({ workspaceId: ws.id, name: "bug", color: "#ff0000" })
    .returning();
  const [feat] = await db
    .insert(issueLabel)
    .values({ workspaceId: ws.id, name: "feature", color: "#00ff00" })
    .returning();

  const events: BusEvent[] = [];
  const unsubscribe = bus.subscribe(ws.id, (e) => events.push(e));

  try {
    // GET — snake_case shape (Go LabelResponse).
    const got = await app.request(`/api/labels/${bug!.id}`, { headers: auth });
    expect(got.status).toBe(200);
    const gotBody = (await got.json()) as Record<string, unknown>;
    expect(gotBody.id).toBe(bug!.id);
    expect(gotBody.workspace_id).toBe(ws.id);
    expect(gotBody.name).toBe("bug");
    expect(gotBody.color).toBe("#ff0000");
    expect(typeof gotBody.created_at).toBe("string");
    expect(typeof gotBody.updated_at).toBe("string");

    // PUT — partial update; color is normalized to lowercase + leading '#'.
    const put = await app.request(`/api/labels/${bug!.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "defect", color: "3B82F6" }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as Record<string, unknown>;
    expect(putBody.name).toBe("defect");
    expect(putBody.color).toBe("#3b82f6");
    expect(events.filter((e) => e.type === "label:updated").length).toBe(1);

    // PUT name-only leaves color untouched (Go COALESCE semantics).
    const nameOnly = await app.request(`/api/labels/${bug!.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "defect2" }),
    });
    expect(nameOnly.status).toBe(200);
    expect(((await nameOnly.json()) as { color: string }).color).toBe("#3b82f6");

    // Duplicate name within the workspace → 409 (unique on lower(name)).
    const dup = await app.request(`/api/labels/${feat!.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "DEFECT2" }),
    });
    expect(dup.status).toBe(409);

    // Bad color → 400; bad id → 400.
    const badColor = await app.request(`/api/labels/${bug!.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ color: "red" }),
    });
    expect(badColor.status).toBe(400);
    const badId = await app.request(`/api/labels/not-a-uuid`, { headers: auth });
    expect(badId.status).toBe(400);

    // A member of another workspace can't see or delete this label → 404.
    const { u: u2, ws: ws2, cleanup: cleanup2 } = await setupFixture(db, `bun-msc-lb2-${stamp}`);
    try {
      const auth2 = await authFor(db, u2, ws2.id);
      const foreignGet = await app.request(`/api/labels/${bug!.id}`, { headers: auth2 });
      expect(foreignGet.status).toBe(404);
      const foreignDel = await app.request(`/api/labels/${bug!.id}`, {
        method: "DELETE",
        headers: auth2,
      });
      expect(foreignDel.status).toBe(404);
    } finally {
      await cleanup2();
    }

    // DELETE → 204, row gone, label:deleted published; second delete → 404.
    const del = await app.request(`/api/labels/${bug!.id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(204);
    const [gone] = await db.select().from(issueLabel).where(eq(issueLabel.id, bug!.id));
    expect(gone).toBeUndefined();
    const delEvents = events.filter((e) => e.type === "label:deleted");
    expect(delEvents.length).toBe(1);
    expect(delEvents[0]!.payload).toEqual({ label_id: bug!.id });
    const again = await app.request(`/api/labels/${bug!.id}`, { method: "DELETE", headers: auth });
    expect(again.status).toBe(404);
  } finally {
    unsubscribe();
    await cleanup();
    await close();
  }
});

// ---------------------------------------------------------------------------
// Subscribe / unsubscribe
// ---------------------------------------------------------------------------

test.skipIf(!reachable)("POST /api/issues/:id/subscribe + /unsubscribe — self-subscription, 403 non-member target", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, iss, cleanup } = await setupFixture(db, `bun-msc-sub-${stamp}`);
  const auth = await authFor(db, u, ws.id);

  const events: BusEvent[] = [];
  const unsubscribe = bus.subscribe(ws.id, (e) => events.push(e));

  try {
    // Subscribe self (empty body) → { subscribed: true }, reason "manual".
    const sub = await app.request(`/api/issues/${iss.id}/subscribe`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(sub.status).toBe(200);
    expect(await sub.json()).toEqual({ subscribed: true });
    const rows = await db
      .select()
      .from(issueSubscriber)
      .where(eq(issueSubscriber.issueId, iss.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.userType).toBe("member");
    expect(rows[0]!.userId).toBe(u.id);
    expect(rows[0]!.reason).toBe("manual");
    const added = events.filter((e) => e.type === "subscriber:added");
    expect(added.length).toBe(1);
    expect(added[0]!.payload).toEqual({
      issue_id: iss.id,
      user_type: "member",
      user_id: u.id,
      reason: "manual",
    });

    // Idempotent: a second subscribe doesn't duplicate (ON CONFLICT DO NOTHING).
    const subAgain = await app.request(`/api/issues/${iss.id}/subscribe`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(subAgain.status).toBe(200);
    expect(
      (await db.select().from(issueSubscriber).where(eq(issueSubscriber.issueId, iss.id))).length,
    ).toBe(1);

    // The :id param also accepts the human identifier ("MSC-1").
    const byIdent = await app.request(`/api/issues/MSC-1/unsubscribe`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(byIdent.status).toBe(200);
    expect(await byIdent.json()).toEqual({ subscribed: false });
    expect(
      (await db.select().from(issueSubscriber).where(eq(issueSubscriber.issueId, iss.id))).length,
    ).toBe(0);
    expect(events.filter((e) => e.type === "subscriber:removed").length).toBe(1);

    // A target user_id that is not in the workspace → 403.
    const forbidden = await app.request(`/api/issues/${iss.id}/subscribe`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ user_id: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(forbidden.status).toBe(403);

    // Unknown issue → 404.
    const missing = await app.request(`/api/issues/00000000-0000-4000-8000-000000000000/subscribe`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(404);
  } finally {
    unsubscribe();
    await cleanup();
    await close();
  }
});

// ---------------------------------------------------------------------------
// Rerun
// ---------------------------------------------------------------------------

test.skipIf(!reachable)("POST /api/issues/:id/rerun — re-dispatches to the agent assignee, cancels prior tasks", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, rt, ag, iss, cleanup } = await setupFixture(db, `bun-msc-rr-${stamp}`);
  const auth = await authFor(db, u, ws.id);

  // Assign the issue to the agent and seed a running task that must be
  // collaterally cancelled by the rerun.
  await db
    .update(issue)
    .set({ assigneeType: "agent", assigneeId: ag.id })
    .where(eq(issue.id, iss.id));
  const [running] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "running" })
    .returning();

  const events: BusEvent[] = [];
  const unsubscribe = bus.subscribe(ws.id, (e) => events.push(e));

  try {
    const res = await app.request(`/api/issues/${iss.id}/rerun`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.agent_id).toBe(ag.id);
    expect(body.runtime_id).toBe(rt.id);
    expect(body.issue_id).toBe(iss.id);
    expect(body.workspace_id).toBe(ws.id);
    expect(body.status).toBe("queued");
    expect(body.priority).toBe(3); // issue.priority "high" → 3
    expect(body.kind).toBe("direct");

    // A NEW agent_task_queue row exists for the assignee, fresh-session flagged.
    const [created] = await db
      .select()
      .from(agentTaskQueue)
      .where(eq(agentTaskQueue.id, body.id as string));
    expect(created).toBeDefined();
    expect(created!.agentId).toBe(ag.id);
    expect(created!.status).toBe("queued");
    expect(created!.forceFreshSession).toBe(true);
    expect(created!.isLeaderTask).toBe(false);

    // The prior running task was cancelled, and both frames went out.
    const [prior] = await db
      .select()
      .from(agentTaskQueue)
      .where(eq(agentTaskQueue.id, running!.id));
    expect(prior!.status).toBe("cancelled");
    expect(events.filter((e) => e.type === "task:cancelled").length).toBe(1);
    const queuedEvents = events.filter((e) => e.type === "task:queued");
    expect(queuedEvents.length).toBe(1);
    expect(queuedEvents[0]!.payload?.task_id).toBe(created!.id);

    // Squad assignee → the rerun targets the leader with is_leader_task=true.
    const [sq] = await db
      .insert(squad)
      .values({ workspaceId: ws.id, name: `sq-${stamp}`, leaderId: ag.id, creatorId: u.id })
      .returning();
    const [iss2] = await db
      .insert(issue)
      .values({
        workspaceId: ws.id,
        title: "squad issue",
        creatorType: "member",
        creatorId: u.id,
        number: 2,
        assigneeType: "squad",
        assigneeId: sq!.id,
      })
      .returning();
    const squadRes = await app.request(`/api/issues/${iss2!.id}/rerun`, {
      method: "POST",
      headers: auth,
    });
    expect(squadRes.status).toBe(202);
    const squadBody = (await squadRes.json()) as Record<string, unknown>;
    expect(squadBody.agent_id).toBe(ag.id);
    const [leaderTask] = await db
      .select()
      .from(agentTaskQueue)
      .where(eq(agentTaskQueue.id, squadBody.id as string));
    expect(leaderTask!.isLeaderTask).toBe(true);
    expect(leaderTask!.forceFreshSession).toBe(true);

    // Guard: an unassigned issue can't be rerun → 400.
    const [bare] = await db
      .insert(issue)
      .values({ workspaceId: ws.id, title: "bare", creatorType: "member", creatorId: u.id, number: 3 })
      .returning();
    const unassigned = await app.request(`/api/issues/${bare!.id}/rerun`, {
      method: "POST",
      headers: auth,
    });
    expect(unassigned.status).toBe(400);
    expect(((await unassigned.json()) as { error: string }).error).toBe(
      "issue is not assigned to an agent or squad",
    );

    // Guard: a source task from a different issue → 400.
    const crossSource = await app.request(`/api/issues/${iss.id}/rerun`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ task_id: leaderTask!.id }),
    });
    expect(crossSource.status).toBe(400);
    expect(((await crossSource.json()) as { error: string }).error).toBe(
      "source task does not belong to this issue",
    );
  } finally {
    unsubscribe();
    await cleanup();
    await close();
  }
});

// ---------------------------------------------------------------------------
// Inbox archive
// ---------------------------------------------------------------------------

test.skipIf(!reachable)("POST /api/inbox/:id/archive — archives the item + issue siblings; foreign recipient 404", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, iss, cleanup } = await setupFixture(db, `bun-msc-ib-${stamp}`);
  const auth = await authFor(db, u, ws.id);

  const [item1] = await db
    .insert(inboxItem)
    .values({
      workspaceId: ws.id,
      recipientType: "member",
      recipientId: u.id,
      type: "issue_done",
      title: "agent finished",
      issueId: iss.id,
    })
    .returning();
  const [sibling] = await db
    .insert(inboxItem)
    .values({
      workspaceId: ws.id,
      recipientType: "member",
      recipientId: u.id,
      type: "comment_mention",
      title: "you were mentioned",
      issueId: iss.id,
    })
    .returning();
  const [unrelated] = await db
    .insert(inboxItem)
    .values({
      workspaceId: ws.id,
      recipientType: "member",
      recipientId: u.id,
      type: "generic",
      title: "no issue link",
    })
    .returning();

  const events: BusEvent[] = [];
  const unsubscribe = bus.subscribe(ws.id, (e) => events.push(e));

  try {
    const res = await app.request(`/api/inbox/${item1!.id}/archive`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(item1!.id);
    expect(body.archived).toBe(true);
    expect(body.issue_id).toBe(iss.id);
    expect(body.issue_status).toBe("backlog"); // enriched from the issue row
    expect(body.recipient_id).toBe(u.id);

    // Sibling item for the same issue is swept; the unrelated one is not.
    const [sib] = await db.select().from(inboxItem).where(eq(inboxItem.id, sibling!.id));
    expect(sib!.archived).toBe(true);
    const [other] = await db.select().from(inboxItem).where(eq(inboxItem.id, unrelated!.id));
    expect(other!.archived).toBe(false);

    const archEvents = events.filter((e) => e.type === "inbox:archived");
    expect(archEvents.length).toBe(1);
    expect(archEvents[0]!.payload).toEqual({
      item_id: item1!.id,
      issue_id: iss.id,
      recipient_id: u.id,
    });

    // An item addressed to a different member is invisible to the caller → 404.
    const { user: u2 } = await findOrCreateUser(db, `bun-msc-ib2-${stamp}@bytedance.com`, cfg);
    await db.insert(member).values({ workspaceId: ws.id, userId: u2.id, role: "member" });
    const [foreignItem] = await db
      .insert(inboxItem)
      .values({
        workspaceId: ws.id,
        recipientType: "member",
        recipientId: u2.id,
        type: "generic",
        title: "not yours",
      })
      .returning();
    const foreign = await app.request(`/api/inbox/${foreignItem!.id}/archive`, {
      method: "POST",
      headers: auth,
    });
    expect(foreign.status).toBe(404);
    await db.delete(inboxItem).where(eq(inboxItem.id, foreignItem!.id));
    await db.delete(member).where(eq(member.userId, u2.id));
    await db.delete(user).where(eq(user.id, u2.id));
  } finally {
    unsubscribe();
    await cleanup();
    await close();
  }
});

// ---------------------------------------------------------------------------
// Attachments: delete + content preview
// ---------------------------------------------------------------------------

test.skipIf(!reachable)("DELETE /api/attachments/:id + GET /:id/content — uploader delete, 403 other member, 415 binary", async () => {
  const { db, close } = createDb(DB_URL);
  // createApp now wires miscActionsRoutes itself with defaultStorage(), and
  // those routes register first (shadowing this test's mount). Point the
  // default at the same temp dir so both instances read the same blobs.
  const dir = await mkdtemp(join(tmpdir(), "msc-att-"));
  const prevStorageDir = process.env.MULTIMIRA_STORAGE_DIR;
  process.env.MULTIMIRA_STORAGE_DIR = dir;
  const storage = new LocalStorage(dir);
  const app = makeApp(db, storage);
  if (prevStorageDir === undefined) delete process.env.MULTIMIRA_STORAGE_DIR;
  else process.env.MULTIMIRA_STORAGE_DIR = prevStorageDir;
  const stamp = Date.now();
  const { u, ws, cleanup } = await setupFixture(db, `bun-msc-att-${stamp}`);
  const auth = await authFor(db, u, ws.id);

  // A markdown blob in storage + its metadata row, uploaded by `u`.
  const text = "# hello\npreview me";
  const key = crypto.randomUUID();
  const url = await storage.upload(key, new TextEncoder().encode(text), "text/markdown", "notes.md");
  const [att] = await db
    .insert(attachment)
    .values({
      id: key,
      workspaceId: ws.id,
      uploaderType: "member",
      uploaderId: u.id,
      filename: "notes.md",
      url,
      contentType: "text/markdown",
      sizeBytes: text.length,
    })
    .returning();

  // A binary attachment (no blob needed — the 415 fires before storage).
  const [png] = await db
    .insert(attachment)
    .values({
      workspaceId: ws.id,
      uploaderType: "member",
      uploaderId: u.id,
      filename: "pic.png",
      url: "local://missing",
      contentType: "image/png",
      sizeBytes: 9,
    })
    .returning();

  try {
    // Content: 200, body verbatim, text/plain re-wrap + original MIME header.
    const content = await app.request(`/api/attachments/${att!.id}/content`, { headers: auth });
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(text);
    expect(content.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(content.headers.get("X-Original-Content-Type")).toBe("text/markdown");
    expect(content.headers.get("Cache-Control")).toBe("no-store");

    // Content on a non-previewable type → 415.
    const binary = await app.request(`/api/attachments/${png!.id}/content`, { headers: auth });
    expect(binary.status).toBe(415);

    // Delete by a plain member who isn't the uploader → 403.
    const { user: u2 } = await findOrCreateUser(db, `bun-msc-att2-${stamp}@bytedance.com`, cfg);
    await db.insert(member).values({ workspaceId: ws.id, userId: u2.id, role: "member" });
    const auth2 = await authFor(db, { ...u2 }, ws.id);
    const forbidden = await app.request(`/api/attachments/${att!.id}`, {
      method: "DELETE",
      headers: auth2,
    });
    expect(forbidden.status).toBe(403);

    // Delete by the uploader → 204 and the row is gone; repeat → 404.
    const del = await app.request(`/api/attachments/${att!.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(del.status).toBe(204);
    const [gone] = await db.select().from(attachment).where(eq(attachment.id, att!.id));
    expect(gone).toBeUndefined();
    const again = await app.request(`/api/attachments/${att!.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(again.status).toBe(404);

    await db.delete(member).where(eq(member.userId, u2.id));
    await db.delete(user).where(eq(user.id, u2.id));
  } finally {
    await cleanup();
    await close();
  }
});

// ---------------------------------------------------------------------------
// Task transcript
// ---------------------------------------------------------------------------

test.skipIf(!reachable)("GET /api/tasks/:taskId/messages — transcript shape, since=, cross-workspace 404", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, rt, ag, iss, cleanup } = await setupFixture(db, `bun-msc-tm-${stamp}`);
  const auth = await authFor(db, u, ws.id);

  const [task] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "running" })
    .returning();
  await db.insert(taskMessage).values([
    { taskId: task!.id, seq: 1, type: "text", content: "thinking..." },
    { taskId: task!.id, seq: 2, type: "tool_use", tool: "bash", input: { command: "ls" } },
    { taskId: task!.id, seq: 3, type: "tool_result", tool: "bash", output: "ok" },
  ]);

  try {
    const res = await app.request(`/api/tasks/${task!.id}/messages`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.length).toBe(3);
    expect(body.map((m) => m.seq)).toEqual([1, 2, 3]);
    const textMsg = body[0]!;
    expect(textMsg.task_id).toBe(task!.id);
    expect(textMsg.issue_id).toBe(iss.id);
    expect(textMsg.type).toBe("text");
    expect(textMsg.content).toBe("thinking...");
    // omitempty: no tool/input/output keys on a text message
    expect("tool" in textMsg).toBe(false);
    expect("input" in textMsg).toBe(false);
    expect("output" in textMsg).toBe(false);
    const toolUse = body[1]!;
    expect(toolUse.tool).toBe("bash");
    expect(toolUse.input).toEqual({ command: "ls" });
    expect("content" in toolUse).toBe(false);
    const toolResult = body[2]!;
    expect(toolResult.output).toBe("ok");

    // since=1 → only seq > 1.
    const since = await app.request(`/api/tasks/${task!.id}/messages?since=1`, { headers: auth });
    expect(since.status).toBe(200);
    expect(((await since.json()) as { seq: number }[]).map((m) => m.seq)).toEqual([2, 3]);

    // Malformed since → 400; malformed id → 400; unknown id → 404.
    expect(
      (await app.request(`/api/tasks/${task!.id}/messages?since=abc`, { headers: auth })).status,
    ).toBe(400);
    expect((await app.request(`/api/tasks/nope/messages`, { headers: auth })).status).toBe(400);
    expect(
      (
        await app.request(`/api/tasks/00000000-0000-4000-8000-000000000000/messages`, {
          headers: auth,
        })
      ).status,
    ).toBe(404);

    // A member of another workspace can't read this task's transcript → 404.
    const { u: u2, ws: ws2, cleanup: cleanup2 } = await setupFixture(db, `bun-msc-tm2-${stamp}`);
    try {
      const auth2 = await authFor(db, u2, ws2.id);
      const foreign = await app.request(`/api/tasks/${task!.id}/messages`, { headers: auth2 });
      expect(foreign.status).toBe(404);
    } finally {
      await cleanup2();
    }
  } finally {
    await cleanup();
    await close();
  }
});

// ---------------------------------------------------------------------------
// Bare task cancel
// ---------------------------------------------------------------------------

test.skipIf(!reachable)("POST /api/tasks/:taskId/cancel — cancels with private-agent gate, idempotent", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, rt, ag, iss, cleanup } = await setupFixture(db, `bun-msc-cx-${stamp}`);
  const auth = await authFor(db, u, ws.id);

  // The fixture agent is private (schema default) and owned by `u`.
  const [task] = await db
    .insert(agentTaskQueue)
    .values({ agentId: ag.id, runtimeId: rt.id, issueId: iss.id, status: "running" })
    .returning();

  const events: BusEvent[] = [];
  const unsubscribe = bus.subscribe(ws.id, (e) => events.push(e));

  try {
    // A plain member (not the owner, not admin) is blocked by the
    // private-agent gate → 403.
    const { user: u2 } = await findOrCreateUser(db, `bun-msc-cx2-${stamp}@bytedance.com`, cfg);
    await db.insert(member).values({ workspaceId: ws.id, userId: u2.id, role: "member" });
    const auth2 = await authFor(db, { ...u2 }, ws.id);
    const forbidden = await app.request(`/api/tasks/${task!.id}/cancel`, {
      method: "POST",
      headers: auth2,
    });
    expect(forbidden.status).toBe(403);
    const [stillRunning] = await db
      .select()
      .from(agentTaskQueue)
      .where(eq(agentTaskQueue.id, task!.id));
    expect(stillRunning!.status).toBe("running");

    // The agent's owner cancels → 200, row terminal, task:cancelled frame.
    const res = await app.request(`/api/tasks/${task!.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(task!.id);
    expect(body.status).toBe("cancelled");
    expect(body.workspace_id).toBe(ws.id);
    expect(events.filter((e) => e.type === "task:cancelled").length).toBe(1);

    // Idempotent: cancelling again returns the row without a second event.
    const again = await app.request(`/api/tasks/${task!.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("cancelled");
    expect(events.filter((e) => e.type === "task:cancelled").length).toBe(1);

    // A task UUID from another workspace 404s through the agent-join guard.
    const { u: u3, ws: ws3, cleanup: cleanup3 } = await setupFixture(db, `bun-msc-cx3-${stamp}`);
    try {
      const auth3 = await authFor(db, u3, ws3.id);
      const foreign = await app.request(`/api/tasks/${task!.id}/cancel`, {
        method: "POST",
        headers: auth3,
      });
      expect(foreign.status).toBe(404);
    } finally {
      await cleanup3();
    }

    await db.delete(member).where(eq(member.userId, u2.id));
    await db.delete(user).where(eq(user.id, u2.id));
  } finally {
    unsubscribe();
    await cleanup();
    await close();
  }
});

// ---------------------------------------------------------------------------
// /api/tokens aliases
// ---------------------------------------------------------------------------

test.skipIf(!reachable)("/api/tokens — list/create/revoke at the path the frontend calls", async () => {
  const { db, close } = createDb(DB_URL);
  const app = makeApp(db);
  const stamp = Date.now();
  const { u, ws, cleanup } = await setupFixture(db, `bun-msc-tok-${stamp}`);
  // PATs are user-scoped: no workspace header required.
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const auth = { Authorization: `Bearer ${token}` };
  void ws;

  try {
    const created = await app.request(`/api/tokens`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "cli", expires_in_days: 30 }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody.name).toBe("cli");
    expect(String(createdBody.token)).toStartWith("mul_");
    expect(String(createdBody.token_prefix)).toBe(String(createdBody.token).slice(0, 12));
    expect(createdBody.expires_at).not.toBeNull();

    const list = await app.request(`/api/tokens`, { headers: auth });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as Record<string, unknown>[];
    expect(listBody.some((t) => t.id === createdBody.id)).toBe(true);
    // The raw token is never returned by the list endpoint.
    expect(listBody.every((t) => !("token" in t))).toBe(true);

    const del = await app.request(`/api/tokens/${createdBody.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(del.status).toBe(204);
    const after = await app.request(`/api/tokens`, { headers: auth });
    const afterBody = (await after.json()) as Record<string, unknown>[];
    expect(afterBody.some((t) => t.id === createdBody.id)).toBe(false);

    // Revoke is idempotent (missing row still 204), bad id → 400.
    expect(
      (
        await app.request(`/api/tokens/${createdBody.id}`, { method: "DELETE", headers: auth })
      ).status,
    ).toBe(204);
    expect((await app.request(`/api/tokens/nope`, { method: "DELETE", headers: auth })).status).toBe(
      400,
    );
  } finally {
    await cleanup();
    await close();
  }
});
