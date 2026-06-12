import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, issue, inboxItem } from "../src/db/schema.js";
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

interface InboxResponseItem {
  id: string;
  workspace_id: string;
  recipient_type: string;
  recipient_id: string;
  type: string;
  severity: string;
  issue_id: string | null;
  title: string;
  body: string | null;
  read: boolean;
  archived: boolean;
  created_at: string;
  issue_status: string | null;
  actor_type: string | null;
  actor_id: string | null;
  details: Record<string, unknown>;
}

test.skipIf(!reachable)(
  "inbox read path: list (recipient-scoped, archived hidden, issue_status joined) + unread-count + mark-read",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-inbox-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    // A second user — their inbox items must never leak into u's list.
    const { user: other } = await findOrCreateUser(db, `bun-inbox-other-${stamp}@bytedance.com`, cfg);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Inbox WS", slug: `bun-inbox-${stamp}`, issuePrefix: "INB" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    // An issue so the LEFT JOIN exposes issue_status on the linked inbox item.
    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Linked issue",
        status: "in_progress",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        number: 1,
      })
      .returning();

    // Items for u: one unread+linked, one read (standalone), one archived (must be hidden).
    const [unreadItem] = await db
      .insert(inboxItem)
      .values({
        workspaceId: ws!.id,
        recipientType: "member",
        recipientId: u.id,
        type: "assigned",
        severity: "action_required",
        issueId: iss!.id,
        title: "You were assigned",
        body: "Take a look",
        read: false,
        archived: false,
      })
      .returning();
    await db.insert(inboxItem).values({
      workspaceId: ws!.id,
      recipientType: "member",
      recipientId: u.id,
      type: "mention",
      severity: "info",
      title: "Already read",
      read: true,
      archived: false,
    });
    await db.insert(inboxItem).values({
      workspaceId: ws!.id,
      recipientType: "member",
      recipientId: u.id,
      type: "status_changed",
      severity: "info",
      title: "Archived item",
      read: false,
      archived: true,
    });
    // An item addressed to the OTHER user — must not appear in u's list/count.
    const [foreignItem] = await db
      .insert(inboxItem)
      .values({
        workspaceId: ws!.id,
        recipientType: "member",
        recipientId: other.id,
        type: "mention",
        severity: "info",
        title: "Not yours",
        read: false,
        archived: false,
      })
      .returning();

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // list → recipient-scoped, archived hidden, newest first, issue_status joined.
      const listRes = await app.request("/api/inbox", { headers: auth });
      expect(listRes.status).toBe(200);
      const items = (await listRes.json()) as InboxResponseItem[];
      // unread + read items only (archived + foreign excluded) → 2.
      expect(items.length).toBe(2);
      expect(items.every((it) => it.recipient_id === u.id)).toBe(true);
      expect(items.every((it) => it.archived === false)).toBe(true);
      const linked = items.find((it) => it.id === unreadItem!.id)!;
      expect(linked).toBeDefined();
      expect(linked.workspace_id).toBe(ws!.id);
      expect(linked.recipient_type).toBe("member");
      expect(linked.type).toBe("assigned");
      expect(linked.severity).toBe("action_required");
      expect(linked.issue_id).toBe(iss!.id);
      expect(linked.issue_status).toBe("in_progress");
      expect(linked.body).toBe("Take a look");
      expect(linked.read).toBe(false);
      // an unlinked item has null issue_status.
      const standalone = items.find((it) => it.title === "Already read")!;
      expect(standalone.issue_status).toBeNull();
      expect(standalone.issue_id).toBeNull();

      // unread-count → only the single unread, non-archived item → 1.
      const countRes = await app.request("/api/inbox/unread-count", { headers: auth });
      expect(countRes.status).toBe(200);
      const countBody = (await countRes.json()) as { count: number };
      expect(countBody.count).toBe(1);

      // mark-read → flips read=true, returns the enriched item.
      const readRes = await app.request(`/api/inbox/${unreadItem!.id}/read`, {
        method: "POST",
        headers: auth,
      });
      expect(readRes.status).toBe(200);
      const marked = (await readRes.json()) as InboxResponseItem;
      expect(marked.id).toBe(unreadItem!.id);
      expect(marked.read).toBe(true);
      expect(marked.issue_status).toBe("in_progress");

      // unread-count now 0.
      const count2 = await app.request("/api/inbox/unread-count", { headers: auth });
      const count2Body = (await count2.json()) as { count: number };
      expect(count2Body.count).toBe(0);

      // mark-read on another user's item → 404 (recipient gate).
      const foreignRead = await app.request(`/api/inbox/${foreignItem!.id}/read`, {
        method: "POST",
        headers: auth,
      });
      expect(foreignRead.status).toBe(404);

      // mark-read on an unknown UUID → 404.
      const missing = await app.request(
        "/api/inbox/11111111-1111-4111-8111-111111111111/read",
        { method: "POST", headers: auth },
      );
      expect(missing.status).toBe(404);

      // malformed inbox id → 400.
      const badId = await app.request("/api/inbox/not-a-uuid/read", {
        method: "POST",
        headers: auth,
      });
      expect(badId.status).toBe(400);

      // missing workspace header → 400.
      const noWs = await app.request("/api/inbox", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);
    } finally {
      await db.delete(inboxItem).where(eq(inboxItem.workspaceId, ws!.id));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await db.delete(user).where(eq(user.id, other.id));
      await close();
    }
  },
);
