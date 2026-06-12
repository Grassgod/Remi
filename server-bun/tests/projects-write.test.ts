import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, project } from "../src/db/schema.js";
import { bus } from "../src/realtime/bus.js";
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
  "POST /api/projects creates a workspace-scoped project with defaults + validation",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-pjc-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Proj Create WS", slug: `bun-pjc-${stamp}`, issuePrefix: "PJC" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    try {
      // create with explicit fields
      const r1 = await app.request("/api/projects", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          title: "Roadmap",
          description: "Q3 plan",
          status: "in_progress",
          priority: "high",
        }),
      });
      expect(r1.status).toBe(201);
      const p1 = (await r1.json()) as {
        id: string;
        workspace_id: string;
        title: string;
        description: string;
        status: string;
        priority: string;
        issue_count: number;
        done_count: number;
        resource_count: number;
      };
      expect(p1.title).toBe("Roadmap");
      expect(p1.workspace_id).toBe(ws!.id);
      expect(p1.description).toBe("Q3 plan");
      expect(p1.status).toBe("in_progress");
      expect(p1.priority).toBe("high");
      expect(p1.issue_count).toBe(0);
      expect(p1.done_count).toBe(0);
      expect(p1.resource_count).toBe(0);

      // create with defaults (status → planned, priority → none)
      const r2 = await app.request("/api/projects", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ title: "Minimal" }),
      });
      expect(r2.status).toBe(201);
      const p2 = (await r2.json()) as { status: string; priority: string; description: string | null };
      expect(p2.status).toBe("planned");
      expect(p2.priority).toBe("none");
      expect(p2.description).toBeNull();

      // missing title → 400
      const bad = await app.request("/api/projects", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ title: "   " }),
      });
      expect(bad.status).toBe(400);

      // missing workspace header → 400
      const noWs = await app.request("/api/projects", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      expect(noWs.status).toBe(400);

      // member of another workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Workspace-ID": otherWsId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "x" }),
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(project).where(eq(project.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "PUT /api/projects/:id partial-updates and DELETE removes it, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-pju-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Proj Upd WS", slug: `bun-pju-${stamp}`, issuePrefix: "PJU" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    try {
      const created = (await (
        await app.request("/api/projects", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            title: "orig",
            description: "keep",
            status: "planned",
            priority: "low",
          }),
        })
      ).json()) as { id: string };

      // partial update: only title + status, leaving priority + description intact
      const upd = await app.request(`/api/projects/${created.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ title: "updated", status: "completed" }),
      });
      expect(upd.status).toBe(200);
      const after = (await upd.json()) as {
        title: string;
        status: string;
        priority: string;
        description: string;
      };
      expect(after.title).toBe("updated");
      expect(after.status).toBe("completed");
      expect(after.priority).toBe("low"); // untouched field preserved
      expect(after.description).toBe("keep"); // absent key preserved

      // present-key-null clears a nullable column
      const cleared = await app.request(`/api/projects/${created.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ description: null }),
      });
      expect(cleared.status).toBe(200);
      expect(((await cleared.json()) as { description: string | null }).description).toBeNull();

      // update of a missing id → 404
      const missingId = "11111111-1111-4111-8111-111111111111";
      const missing = await app.request(`/api/projects/${missingId}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ title: "nope" }),
      });
      expect(missing.status).toBe(404);

      // malformed id → 400
      const badId = await app.request("/api/projects/not-a-uuid", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ title: "nope" }),
      });
      expect(badId.status).toBe(400);

      // delete
      const del = await app.request(`/api/projects/${created.id}`, { method: "DELETE", headers: auth });
      expect(del.status).toBe(204);
      const gone = await app.request(`/api/projects/${created.id}`, { headers: auth });
      expect(gone.status).toBe(404);

      // delete of an already-gone id → 404
      const delAgain = await app.request(`/api/projects/${created.id}`, {
        method: "DELETE",
        headers: auth,
      });
      expect(delAgain.status).toBe(404);
    } finally {
      await db.delete(project).where(eq(project.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "project write endpoints emit project.created/updated/deleted on the realtime bus",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-pjr-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Proj RT WS", slug: `bun-pjr-${stamp}`, issuePrefix: "PJR" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };
    const events: string[] = [];
    const unsub = bus.subscribe(ws!.id, (e) => events.push(e.type));
    try {
      const created = (await (
        await app.request("/api/projects", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ title: "rt" }),
        })
      ).json()) as { id: string };
      expect(events).toContain("project.created");

      await app.request(`/api/projects/${created.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ title: "rt2" }),
      });
      expect(events).toContain("project.updated");

      await app.request(`/api/projects/${created.id}`, { method: "DELETE", headers: auth });
      expect(events).toContain("project.deleted");
    } finally {
      unsub();
      await db.delete(project).where(eq(project.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
