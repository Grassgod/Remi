import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, issue, attachment } from "../src/db/schema.js";
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

interface AttachmentResponse {
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
}

test.skipIf(!reachable)(
  "attachments read path: per-issue list (created_at ASC) + get by UUID, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-att-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Attachment WS", slug: `bun-att-${stamp}`, issuePrefix: "ATT" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    // issue_id is a NOT-NULL-on-insert FK target (REFERENCES issue ON DELETE
    // CASCADE) — the attachments must point at a real issue row.
    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Issue with files",
        status: "backlog",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        number: 1,
      })
      .returning();

    // Two attachments on the issue with distinct created_at so ASC ordering is
    // observable. uploader_id is polymorphic (no FK) — use the member's user id.
    const earlier = "2026-01-01T00:00:00.000Z";
    const later = "2026-02-01T00:00:00.000Z";
    const [attA] = await db
      .insert(attachment)
      .values({
        workspaceId: ws!.id,
        issueId: iss!.id,
        uploaderType: "member",
        uploaderId: u.id,
        filename: "second.txt",
        url: "https://cdn.example.com/second.txt",
        contentType: "text/plain",
        sizeBytes: 20,
        createdAt: later,
      })
      .returning();
    const [attB] = await db
      .insert(attachment)
      .values({
        workspaceId: ws!.id,
        issueId: iss!.id,
        uploaderType: "member",
        uploaderId: u.id,
        filename: "first.png",
        url: "https://cdn.example.com/first.png",
        contentType: "image/png",
        sizeBytes: 10,
        createdAt: earlier,
      })
      .returning();

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // per-issue list → array ordered created_at ASC (first.png before second.txt)
      const listRes = await app.request(`/api/attachments?issue_id=${iss!.id}`, { headers: auth });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as AttachmentResponse[];
      expect(list.length).toBe(2);
      expect(list[0]!.id).toBe(attB!.id); // earlier created_at first
      expect(list[1]!.id).toBe(attA!.id);
      expect(list[0]!.filename).toBe("first.png");
      expect(list[0]!.issue_id).toBe(iss!.id);
      expect(list[0]!.workspace_id).toBe(ws!.id);
      expect(list[0]!.comment_id).toBeNull();
      expect(list[0]!.chat_session_id).toBeNull();
      expect(list[0]!.chat_message_id).toBeNull();
      expect(list[0]!.download_url).toBe(`/api/attachments/${attB!.id}/download`);
      expect(list[0]!.content_type).toBe("image/png");
      expect(list[0]!.size_bytes).toBe(10);
      expect(list[0]!.uploader_type).toBe("member");
      expect(list[0]!.uploader_id).toBe(u.id);
      expect(list[0]!.url).toBe("https://cdn.example.com/first.png");

      // list with no issue_id → 400
      const noIssue = await app.request("/api/attachments", { headers: auth });
      expect(noIssue.status).toBe(400);

      // get by UUID → bare AttachmentResponse
      const getRes = await app.request(`/api/attachments/${attA!.id}`, { headers: auth });
      expect(getRes.status).toBe(200);
      const one = (await getRes.json()) as AttachmentResponse;
      expect(one.id).toBe(attA!.id);
      expect(one.filename).toBe("second.txt");
      expect(one.workspace_id).toBe(ws!.id);
      expect(one.download_url).toBe(`/api/attachments/${attA!.id}/download`);

      // unknown UUID → 404
      const missing = await app.request(
        "/api/attachments/11111111-1111-4111-8111-111111111111",
        { headers: auth },
      );
      expect(missing.status).toBe(404);

      // malformed id → 400
      const bad = await app.request("/api/attachments/not-a-uuid", { headers: auth });
      expect(bad.status).toBe(400);

      // missing workspace header → 400
      const noWs = await app.request(`/api/attachments/${attA!.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request(`/api/attachments/${attA!.id}`, {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(attachment).where(eq(attachment.workspaceId, ws!.id));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
