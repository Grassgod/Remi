/**
 * Issue-subscriber route tests — DB-gated. Drives the standalone
 * subscriberRoutes(db) factory directly: a bare Hono app stamps the authed
 * user (bypassing the JWT gate) and mounts the factory at "/". Exercises the
 * full subscribe -> list -> unsubscribe -> list cycle against a real issue in a
 * real workspace, asserting both the HTTP response shapes (Go parity) and the
 * persisted rows.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { subscriberRoutes } from "../src/http/routes/subscribers.js";
import type { AppEnv } from "../src/http/types.js";
import {
  user,
  member,
  workspace,
  issue,
  issueSubscriber,
} from "../src/db/schema.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip when no DB */
}

test.skipIf(!reachable)(
  "subscribe -> list -> unsubscribe cycle for the current member, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();

    // FK order: user/workspace -> member -> issue -> (leaf subscriber rows).
    const [u] = await db
      .insert(user)
      .values({ email: `bun-sub-${stamp}@bytedance.com`, name: "Sub Tester" })
      .returning();
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Subscriber WS", slug: `bun-sub-${stamp}`, issuePrefix: "SUB" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u!.id, role: "owner" });
    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Watchable issue",
        status: "backlog",
        priority: "none",
        creatorType: "member",
        creatorId: u!.id,
        number: 1,
      })
      .returning();

    // Bare app: stamp the authed user, then mount the route factory at "/".
    const app = new Hono<AppEnv>();
    app.use("*", async (c, n) => {
      c.set("user", { sub: u!.id } as AppEnv["Variables"]["user"]);
      await n();
    });
    app.route("/", subscriberRoutes(db));

    const headers = { "X-Workspace-ID": ws!.id, "Content-Type": "application/json" };

    try {
      // Subscribe (resolves the issue by human identifier "SUB-1").
      const sub = await app.request("/api/issues/SUB-1/subscribers", {
        method: "POST",
        headers,
      });
      expect(sub.status).toBe(200);
      expect((await sub.json()) as { subscribed: boolean }).toEqual({ subscribed: true });

      // The composite row landed: (issue_id, member, user_id) with reason "manual".
      const afterSub = await db
        .select()
        .from(issueSubscriber)
        .where(
          and(eq(issueSubscriber.issueId, iss!.id), eq(issueSubscriber.userId, u!.id)),
        );
      expect(afterSub.length).toBe(1);
      expect(afterSub[0]!.userType).toBe("member");
      expect(afterSub[0]!.reason).toBe("manual");

      // Idempotent: a second subscribe also succeeds and does not duplicate.
      const subAgain = await app.request(`/api/issues/${iss!.id}/subscribers`, {
        method: "POST",
        headers,
      });
      expect(subAgain.status).toBe(200);
      const dedup = await db
        .select()
        .from(issueSubscriber)
        .where(eq(issueSubscriber.issueId, iss!.id));
      expect(dedup.length).toBe(1);

      // List: the member is present, snake_case shape (Go parity).
      const list = await app.request(`/api/issues/${iss!.id}/subscribers`, {
        method: "GET",
        headers,
      });
      expect(list.status).toBe(200);
      const rows = (await list.json()) as Array<{
        issue_id: string;
        user_type: string;
        user_id: string;
        reason: string;
        created_at: string;
      }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.issue_id).toBe(iss!.id);
      expect(rows[0]!.user_type).toBe("member");
      expect(rows[0]!.user_id).toBe(u!.id);
      expect(rows[0]!.reason).toBe("manual");
      expect(typeof rows[0]!.created_at).toBe("string");

      // Unsubscribe.
      const unsub = await app.request(`/api/issues/${iss!.id}/subscribers`, {
        method: "DELETE",
        headers,
      });
      expect(unsub.status).toBe(200);
      expect((await unsub.json()) as { subscribed: boolean }).toEqual({ subscribed: false });

      // The row is gone, both in the DB and in the list.
      const afterUnsub = await db
        .select()
        .from(issueSubscriber)
        .where(eq(issueSubscriber.issueId, iss!.id));
      expect(afterUnsub.length).toBe(0);

      const emptyList = await app.request(`/api/issues/${iss!.id}/subscribers`, {
        method: "GET",
        headers,
      });
      expect(emptyList.status).toBe(200);
      expect(((await emptyList.json()) as unknown[]).length).toBe(0);

      // Missing workspace header -> 400 (workspace gate).
      const noWs = await app.request(`/api/issues/${iss!.id}/subscribers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(noWs.status).toBe(400);

      // A member of another workspace -> 404 (multi-tenancy gate).
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request(`/api/issues/${iss!.id}/subscribers`, {
        method: "GET",
        headers: { "X-Workspace-ID": otherWsId, "Content-Type": "application/json" },
      });
      expect(foreign.status).toBe(404);

      // Unknown issue -> 404.
      const noIssue = await app.request("/api/issues/SUB-999/subscribers", {
        method: "GET",
        headers,
      });
      expect(noIssue.status).toBe(404);
    } finally {
      // Reverse FK order. The issue delete cascades any leftover subscriber rows.
      await db.delete(issueSubscriber).where(eq(issueSubscriber.issueId, iss!.id));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u!.id));
      await close();
    }
  },
);
