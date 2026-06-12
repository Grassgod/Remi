import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, issue, activityLog } from "../src/db/schema.js";
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

type ActivityEntry = {
  type: string;
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
};

test.skipIf(!reachable)(
  "activity read path: per-issue (ASC) + per-workspace (DESC), workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-act-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Activity WS", slug: `bun-act-${stamp}`, issuePrefix: "ACT" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    // Two issues in the workspace; activities seeded on the first.
    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Tracked issue",
        status: "backlog",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        number: 1,
      })
      .returning();
    const [other] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Other issue",
        status: "backlog",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        number: 2,
      })
      .returning();

    // Three activities on `iss` with ascending timestamps, plus one on `other`.
    const base = Date.now() - 5 * 60_000;
    const ts = (m: number) => new Date(base + m * 60_000).toISOString();
    await db.insert(activityLog).values([
      {
        workspaceId: ws!.id,
        issueId: iss!.id,
        actorType: "member",
        actorId: u.id,
        action: "status_changed",
        details: { from: "backlog", to: "in_progress" },
        createdAt: ts(0),
      },
      {
        workspaceId: ws!.id,
        issueId: iss!.id,
        actorType: "member",
        actorId: u.id,
        action: "priority_changed",
        details: { from: "none", to: "high" },
        createdAt: ts(1),
      },
      {
        workspaceId: ws!.id,
        issueId: iss!.id,
        actorType: "agent",
        actorId: null,
        action: "commented",
        details: {},
        createdAt: ts(2),
      },
      {
        workspaceId: ws!.id,
        issueId: other!.id,
        actorType: "member",
        actorId: u.id,
        action: "status_changed",
        details: { from: "backlog", to: "done" },
        createdAt: ts(3),
      },
    ]);

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // per-issue → ASC by created_at, only this issue's rows
      const issueRes = await app.request(`/api/activity/issues/${iss!.id}`, { headers: auth });
      expect(issueRes.status).toBe(200);
      const entries = (await issueRes.json()) as ActivityEntry[];
      expect(entries.length).toBe(3);
      expect(entries.map((e) => e.action)).toEqual([
        "status_changed",
        "priority_changed",
        "commented",
      ]);
      expect(entries[0]!.type).toBe("activity");
      expect(entries[0]!.actor_type).toBe("member");
      expect(entries[0]!.actor_id).toBe(u.id);
      expect(entries[0]!.details).toEqual({ from: "backlog", to: "in_progress" });
      // null actor downgrades cleanly (actor_type kept, actor_id null)
      expect(entries[2]!.actor_type).toBe("agent");
      expect(entries[2]!.actor_id).toBeNull();
      expect(entries[2]!.details).toEqual({});

      // resolve by human identifier ("ACT-1") too
      const byIdent = await app.request(`/api/activity/issues/ACT-1`, { headers: auth });
      expect(byIdent.status).toBe(200);
      expect(((await byIdent.json()) as ActivityEntry[]).length).toBe(3);

      // per-workspace → DESC by created_at, all 4 rows across both issues
      const wsRes = await app.request("/api/activity", { headers: auth });
      expect(wsRes.status).toBe(200);
      const all = (await wsRes.json()) as ActivityEntry[];
      expect(all.length).toBe(4);
      // newest first: the `other` issue row (ts 3) leads, "commented" (ts 2) next
      expect(all[0]!.action).toBe("status_changed");
      expect(all[1]!.action).toBe("commented");

      // unknown issue → 404
      const missing = await app.request(
        "/api/activity/issues/11111111-1111-4111-8111-111111111111",
        { headers: auth },
      );
      expect(missing.status).toBe(404);

      // missing workspace header → 400
      const noWs = await app.request("/api/activity", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/activity", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(activityLog).where(eq(activityLog.workspaceId, ws!.id));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
