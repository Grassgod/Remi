import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, notificationPreference } from "../src/db/schema.js";
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

test.skipIf(!reachable)(
  "notification-preferences read/write path: get (empty → upsert) + validation, workspace + member gated",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-notif-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Notif WS", slug: `bun-notif-${stamp}`, issuePrefix: "NTF" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };
    const jsonAuth = { ...auth, "Content-Type": "application/json" };

    try {
      // GET with no row yet → empty preferences map (Go pgx.ErrNoRows path).
      const emptyRes = await app.request("/api/notification-preferences", { headers: auth });
      expect(emptyRes.status).toBe(200);
      const empty = (await emptyRes.json()) as {
        workspace_id: string;
        preferences: Record<string, string>;
      };
      expect(empty.workspace_id).toBe(ws!.id);
      expect(empty.preferences).toEqual({});

      // PUT valid prefs → echoed back.
      const putRes = await app.request("/api/notification-preferences", {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify({ preferences: { assignments: "all", comments: "muted" } }),
      });
      expect(putRes.status).toBe(200);
      const put = (await putRes.json()) as {
        workspace_id: string;
        preferences: Record<string, string>;
      };
      expect(put.workspace_id).toBe(ws!.id);
      expect(put.preferences).toEqual({ assignments: "all", comments: "muted" });

      // GET now returns the stored prefs.
      const getRes = await app.request("/api/notification-preferences", { headers: auth });
      expect(getRes.status).toBe(200);
      const got = (await getRes.json()) as { preferences: Record<string, string> };
      expect(got.preferences).toEqual({ assignments: "all", comments: "muted" });

      // PUT again upserts (replaces) the prefs on the same (ws, user) row.
      const put2 = await app.request("/api/notification-preferences", {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify({ preferences: { system_notifications: "muted" } }),
      });
      expect(put2.status).toBe(200);
      const put2body = (await put2.json()) as { preferences: Record<string, string> };
      expect(put2body.preferences).toEqual({ system_notifications: "muted" });

      // invalid group → 400
      const badGroup = await app.request("/api/notification-preferences", {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify({ preferences: { not_a_group: "all" } }),
      });
      expect(badGroup.status).toBe(400);

      // invalid value → 400
      const badValue = await app.request("/api/notification-preferences", {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify({ preferences: { assignments: "sometimes" } }),
      });
      expect(badValue.status).toBe(400);

      // missing preferences field → 400
      const noPrefs = await app.request("/api/notification-preferences", {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify({}),
      });
      expect(noPrefs.status).toBe(400);

      // missing workspace header → 400
      const noWs = await app.request("/api/notification-preferences", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/notification-preferences", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(notificationPreference).where(eq(notificationPreference.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
