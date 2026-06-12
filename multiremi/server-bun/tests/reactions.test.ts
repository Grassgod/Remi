import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, issue, issueReaction } from "../src/db/schema.js";
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
  "POST /api/issues/:id/reactions adds a reaction (idempotent) + DELETE removes it, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rxn-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Reaction WS", slug: `bun-rxn-${stamp}`, issuePrefix: "RXN" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Reactable issue",
        status: "backlog",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        number: 7,
      })
      .returning();

    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    try {
      // add a reaction (resolves the issue by human identifier "RXN-7")
      const add = await app.request("/api/issues/RXN-7/reactions", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ emoji: "👍" }),
      });
      expect(add.status).toBe(201);
      const r1 = (await add.json()) as {
        id: string;
        issue_id: string;
        actor_type: string;
        actor_id: string;
        emoji: string;
        created_at: string;
      };
      expect(r1.issue_id).toBe(iss!.id);
      expect(r1.actor_type).toBe("member");
      expect(r1.actor_id).toBe(u.id);
      expect(r1.emoji).toBe("👍");
      expect(typeof r1.created_at).toBe("string");

      // idempotent: re-adding the same reaction returns the existing row (201, same id)
      const addAgain = await app.request(`/api/issues/${iss!.id}/reactions`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ emoji: "👍" }),
      });
      expect(addAgain.status).toBe(201);
      const r2 = (await addAgain.json()) as { id: string };
      expect(r2.id).toBe(r1.id);

      // exactly one row persisted (the unique key held)
      const rowsAfterAdd = await db
        .select()
        .from(issueReaction)
        .where(eq(issueReaction.issueId, iss!.id));
      expect(rowsAfterAdd.length).toBe(1);

      // missing emoji → 400
      const noEmoji = await app.request(`/api/issues/${iss!.id}/reactions`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      });
      expect(noEmoji.status).toBe(400);

      // unknown issue → 404
      const noIssue = await app.request("/api/issues/RXN-999/reactions", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ emoji: "👍" }),
      });
      expect(noIssue.status).toBe(404);

      // remove the reaction
      const del = await app.request(`/api/issues/${iss!.id}/reactions`, {
        method: "DELETE",
        headers: auth,
        body: JSON.stringify({ emoji: "👍" }),
      });
      expect(del.status).toBe(204);
      const rowsAfterDel = await db
        .select()
        .from(issueReaction)
        .where(eq(issueReaction.issueId, iss!.id));
      expect(rowsAfterDel.length).toBe(0);

      // missing workspace header → 400
      const noWs = await app.request(`/api/issues/${iss!.id}/reactions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: "👍" }),
      });
      expect(noWs.status).toBe(400);

      // a member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request(`/api/issues/${iss!.id}/reactions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Workspace-ID": otherWsId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ emoji: "👍" }),
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(issueReaction).where(eq(issueReaction.workspaceId, ws!.id));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
