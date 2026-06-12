import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace } from "../src/db/schema.js";
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

type MemberResp = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: string;
  name: string;
  email: string;
  avatar_url: string | null;
};

test.skipIf(!reachable)(
  "members read path: list with user join via :id and via X-Workspace-ID, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();

    // Requesting user (a member) + a second user in the same workspace.
    const { user: u } = await findOrCreateUser(db, `bun-mbr-${stamp}@bytedance.com`, cfg);
    const [u2] = await db
      .insert(user)
      .values({
        name: "Avatar User",
        email: `bun-mbr2-${stamp}@bytedance.com`,
        avatarUrl: "https://example.com/a.png",
      })
      .returning();
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Member WS", slug: `bun-mbr-${stamp}`, issuePrefix: "MBR" })
      .returning();
    // Insert the requester first so created_at ASC ordering is deterministic.
    const [m1] = await db
      .insert(member)
      .values({ workspaceId: ws!.id, userId: u.id, role: "owner" })
      .returning();
    const [m2] = await db
      .insert(member)
      .values({ workspaceId: ws!.id, userId: u2!.id, role: "member" })
      .returning();

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // GET /api/workspaces/:id/members — canonical Go route (member-level).
      const byUrl = await app.request(`/api/workspaces/${ws!.id}/members`, { headers: auth });
      expect(byUrl.status).toBe(200);
      const list = (await byUrl.json()) as MemberResp[];
      expect(list.length).toBe(2);

      // Ordered by created_at ASC → requester (owner) first.
      expect(list[0]!.id).toBe(m1!.id);
      expect(list[0]!.user_id).toBe(u.id);
      expect(list[0]!.role).toBe("owner");
      expect(list[0]!.workspace_id).toBe(ws!.id);
      expect(list[0]!.email).toBe(u.email);
      expect(list[0]!.name).toBe(u.name);
      expect(list[0]!.avatar_url).toBeNull();

      // Second member carries the joined user's name/email/avatar.
      expect(list[1]!.id).toBe(m2!.id);
      expect(list[1]!.user_id).toBe(u2!.id);
      expect(list[1]!.role).toBe("member");
      expect(list[1]!.name).toBe("Avatar User");
      expect(list[1]!.email).toBe(u2!.email);
      expect(list[1]!.avatar_url).toBe("https://example.com/a.png");

      // GET /api/members — header-routed variant returns the same payload.
      const byHeader = await app.request("/api/members", { headers: auth });
      expect(byHeader.status).toBe(200);
      const list2 = (await byHeader.json()) as MemberResp[];
      expect(list2.map((m) => m.id)).toEqual([m1!.id, m2!.id]);

      // Missing workspace header on /api/members → 400.
      const noWs = await app.request("/api/members", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // Non-member of the target workspace → 404 (multi-tenancy gate), both routes.
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreignHeader = await app.request("/api/members", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreignHeader.status).toBe(404);

      const foreignUrl = await app.request(`/api/workspaces/${otherWsId}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(foreignUrl.status).toBe(404);

      // No auth at all → 401 (the /api/* gate).
      const noAuth = await app.request(`/api/workspaces/${ws!.id}/members`);
      expect(noAuth.status).toBe(401);
    } finally {
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await db.delete(user).where(eq(user.id, u2!.id));
      await close();
    }
  },
);
