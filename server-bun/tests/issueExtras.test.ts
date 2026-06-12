/**
 * issueExtras routes — children, issue↔label attach/detach/list, and the
 * per-issue attachment list. Mounted bare (factory + injected user) like the
 * issue-metadata test, so the routes are exercised without the JWT gate.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueExtrasRoutes } from "../src/http/routes/issueExtras.js";
import { bus, type BusEvent } from "../src/realtime/bus.js";
import { user, member, workspace, issue, issueLabel, issueToLabel, attachment } from "../src/db/schema.js";
import type { AppEnv } from "../src/http/types.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = {
  port: 0,
  jwtSecret: "test-secret-0123456789",
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

/** Bare app: mount only the factory and inject the authed user. */
function bareApp(db: ReturnType<typeof createDb>["db"], userId: string, email: string, name: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => {
    c.set("user", { sub: userId, email, name });
    await n();
  });
  app.route("/", issueExtrasRoutes(db));
  return app;
}

test.skipIf(!reachable)("children: ordered by position, identifier from prefix, 404 unknown", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-ixc-${stamp}@bytedance.com`, cfg);

  const [ws] = await db
    .insert(workspace)
    .values({ name: "Extras Children WS", slug: `bun-ixc-${stamp}`, issuePrefix: "IXC" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

  const base = {
    workspaceId: ws!.id,
    status: "backlog",
    priority: "none",
    creatorType: "member",
    creatorId: u.id,
  };
  const [parent] = await db.insert(issue).values({ ...base, title: "Parent", number: 1 }).returning();
  // Insert children out of position order to prove ORDER BY position ASC.
  await db.insert(issue).values([
    { ...base, title: "Child B", number: 3, parentIssueId: parent!.id, position: 2 },
    { ...base, title: "Child A", number: 2, parentIssueId: parent!.id, position: 1 },
  ]);

  const app = bareApp(db, u.id, u.email, u.name);
  const headers = { "X-Workspace-ID": ws!.id };

  try {
    const res = await app.request(`/api/issues/${parent!.id}/children`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issues: Array<{
        id: string;
        workspace_id: string;
        identifier: string;
        title: string;
        parent_issue_id: string;
        position: number;
        metadata: Record<string, unknown>;
      }>;
    };
    expect(body.issues.length).toBe(2);
    expect(body.issues.map((i) => i.title)).toEqual(["Child A", "Child B"]);
    expect(body.issues[0]!.identifier).toBe("IXC-2");
    expect(body.issues[0]!.parent_issue_id).toBe(parent!.id);
    expect(body.issues[0]!.workspace_id).toBe(ws!.id);
    expect(body.issues[0]!.metadata).toEqual({});

    // Parent resolvable by human identifier too.
    const byIdent = await app.request(`/api/issues/IXC-1/children`, { headers });
    expect(byIdent.status).toBe(200);
    const identBody = (await byIdent.json()) as { issues: unknown[] };
    expect(identBody.issues.length).toBe(2);

    // A leaf issue has no children -> empty array, not an error.
    const leaf = await app.request(`/api/issues/IXC-2/children`, { headers });
    expect(((await leaf.json()) as { issues: unknown[] }).issues).toEqual([]);

    // Unknown issue -> 404.
    const missing = await app.request(`/api/issues/99999999-9999-4999-8999-999999999999/children`, { headers });
    expect(missing.status).toBe(404);
  } finally {
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

test.skipIf(!reachable)("labels: attach/list/detach lifecycle, validation, cross-ws 404, bus event", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-ixl-${stamp}@bytedance.com`, cfg);

  const [ws] = await db
    .insert(workspace)
    .values({ name: "Extras Labels WS", slug: `bun-ixl-${stamp}`, issuePrefix: "IXL" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [iss] = await db
    .insert(issue)
    .values({
      workspaceId: ws!.id,
      title: "Labeled issue",
      status: "backlog",
      priority: "none",
      creatorType: "member",
      creatorId: u.id,
      number: 1,
    })
    .returning();
  const [lbl] = await db
    .insert(issueLabel)
    .values({ workspaceId: ws!.id, name: "bug", color: "#ef4444" })
    .returning();

  // A label in a different workspace must be invisible to attach/detach.
  const [ws2] = await db
    .insert(workspace)
    .values({ name: "Extras Foreign WS", slug: `bun-ixl2-${stamp}`, issuePrefix: "IXF" })
    .returning();
  const [foreignLbl] = await db
    .insert(issueLabel)
    .values({ workspaceId: ws2!.id, name: "foreign", color: "#000000" })
    .returning();

  const events: BusEvent[] = [];
  const unsubscribe = bus.subscribe(ws!.id, (e) => events.push(e));

  const app = bareApp(db, u.id, u.email, u.name);
  const headers = { "X-Workspace-ID": ws!.id, "Content-Type": "application/json" };

  try {
    // Initially empty.
    const empty = await app.request(`/api/issues/${iss!.id}/labels`, { headers });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { labels: unknown[] }).labels).toEqual([]);

    // Attach -> 200 { labels: [bug] } with the snake_case label shape.
    const attach = await app.request(`/api/issues/${iss!.id}/labels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label_id: lbl!.id }),
    });
    expect(attach.status).toBe(200);
    const attached = (await attach.json()) as {
      labels: Array<{ id: string; workspace_id: string; name: string; color: string; created_at: string; updated_at: string }>;
    };
    expect(attached.labels.length).toBe(1);
    expect(attached.labels[0]!.id).toBe(lbl!.id);
    expect(attached.labels[0]!.workspace_id).toBe(ws!.id);
    expect(attached.labels[0]!.name).toBe("bug");
    expect(attached.labels[0]!.color).toBe("#ef4444");
    expect(typeof attached.labels[0]!.created_at).toBe("string");

    // Broadcast issue_labels:changed with { issue_id, labels }.
    const evt = events.find((e) => e.type === "issue_labels:changed");
    expect(evt).toBeDefined();
    expect(evt!.payload?.issue_id).toBe(iss!.id);
    expect((evt!.payload?.labels as unknown[]).length).toBe(1);

    // Re-attach is idempotent (ON CONFLICT DO NOTHING) -> still one label.
    const again = await app.request(`/api/issues/${iss!.id}/labels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label_id: lbl!.id }),
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { labels: unknown[] }).labels.length).toBe(1);

    // List reflects the attach, resolvable via the human identifier too.
    const list = await app.request(`/api/issues/IXL-1/labels`, { headers });
    expect(((await list.json()) as { labels: Array<{ name: string }> }).labels.map((l) => l.name)).toEqual(["bug"]);

    // Missing label_id -> 400; non-UUID -> 400.
    const noId = await app.request(`/api/issues/${iss!.id}/labels`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(noId.status).toBe(400);
    const badId = await app.request(`/api/issues/${iss!.id}/labels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label_id: "not-a-uuid" }),
    });
    expect(badId.status).toBe(400);

    // A label from another workspace -> 404 (attach and detach alike).
    const cross = await app.request(`/api/issues/${iss!.id}/labels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label_id: foreignLbl!.id }),
    });
    expect(cross.status).toBe(404);
    const crossDetach = await app.request(`/api/issues/${iss!.id}/labels/${foreignLbl!.id}`, {
      method: "DELETE",
      headers,
    });
    expect(crossDetach.status).toBe(404);

    // Detach -> 200 { labels: [] }, row gone.
    const detach = await app.request(`/api/issues/${iss!.id}/labels/${lbl!.id}`, {
      method: "DELETE",
      headers,
    });
    expect(detach.status).toBe(200);
    expect(((await detach.json()) as { labels: unknown[] }).labels).toEqual([]);
    const rows = await db.select().from(issueToLabel).where(eq(issueToLabel.issueId, iss!.id));
    expect(rows.length).toBe(0);
  } finally {
    unsubscribe();
    await db.delete(issueToLabel).where(eq(issueToLabel.issueId, iss!.id));
    await db.delete(issueLabel).where(eq(issueLabel.workspaceId, ws!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(issueLabel).where(eq(issueLabel.workspaceId, ws2!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws2!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

test.skipIf(!reachable)("attachments: per-issue list returns a top-level array, scoped to the issue", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-ixa-${stamp}@bytedance.com`, cfg);

  const [ws] = await db
    .insert(workspace)
    .values({ name: "Extras Attach WS", slug: `bun-ixa-${stamp}`, issuePrefix: "IXA" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const base = {
    workspaceId: ws!.id,
    status: "backlog",
    priority: "none",
    creatorType: "member",
    creatorId: u.id,
  };
  const [iss] = await db.insert(issue).values({ ...base, title: "Has files", number: 1 }).returning();
  const [other] = await db.insert(issue).values({ ...base, title: "No files", number: 2 }).returning();

  const [att] = await db
    .insert(attachment)
    .values({
      workspaceId: ws!.id,
      issueId: iss!.id,
      uploaderType: "member",
      uploaderId: u.id,
      filename: "spec.pdf",
      url: `https://files.example.com/${stamp}/spec.pdf`,
      contentType: "application/pdf",
      sizeBytes: 1234,
    })
    .returning();
  // An attachment on a different issue must not leak into the list.
  await db.insert(attachment).values({
    workspaceId: ws!.id,
    issueId: other!.id,
    uploaderType: "member",
    uploaderId: u.id,
    filename: "other.txt",
    url: `https://files.example.com/${stamp}/other.txt`,
    contentType: "text/plain",
    sizeBytes: 5,
  });

  const app = bareApp(db, u.id, u.email, u.name);
  const headers = { "X-Workspace-ID": ws!.id };

  try {
    const res = await app.request(`/api/issues/${iss!.id}/attachments`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      workspace_id: string;
      issue_id: string | null;
      comment_id: string | null;
      chat_session_id: string | null;
      chat_message_id: string | null;
      uploader_type: string;
      uploader_id: string;
      filename: string;
      url: string;
      download_url: string;
      content_type: string;
      size_bytes: number;
      created_at: string;
    }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0]!.id).toBe(att!.id);
    expect(body[0]!.workspace_id).toBe(ws!.id);
    expect(body[0]!.issue_id).toBe(iss!.id);
    expect(body[0]!.comment_id).toBeNull();
    expect(body[0]!.uploader_type).toBe("member");
    expect(body[0]!.uploader_id).toBe(u.id);
    expect(body[0]!.filename).toBe("spec.pdf");
    expect(body[0]!.download_url).toBe(`/api/attachments/${att!.id}/download`);
    expect(body[0]!.content_type).toBe("application/pdf");
    expect(body[0]!.size_bytes).toBe(1234);

    // Resolvable by identifier; the other issue lists only its own file.
    const otherRes = await app.request(`/api/issues/IXA-2/attachments`, { headers });
    const otherBody = (await otherRes.json()) as Array<{ filename: string }>;
    expect(otherBody.map((a) => a.filename)).toEqual(["other.txt"]);

    // Unknown issue -> 404.
    const missing = await app.request(`/api/issues/99999999-9999-4999-8999-999999999999/attachments`, { headers });
    expect(missing.status).toBe(404);
  } finally {
    await db.delete(attachment).where(eq(attachment.workspaceId, ws!.id));
    await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
