import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, issue, project, projectResource } from "../src/db/schema.js";
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
  "projects read path: list (with counts) + get by UUID, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-proj-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Project WS", slug: `bun-proj-${stamp}`, issuePrefix: "PRJ" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    const [proj] = await db
      .insert(project)
      .values({
        workspaceId: ws!.id,
        title: "Launch",
        description: "Ship it",
        icon: "rocket",
        status: "planned",
        priority: "high",
      })
      .returning();

    // Two issues on the project: one done (terminal) → done_count=1, total=2.
    await db.insert(issue).values([
      {
        workspaceId: ws!.id,
        title: "Todo issue",
        status: "backlog",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        projectId: proj!.id,
        number: 1,
      },
      {
        workspaceId: ws!.id,
        title: "Finished issue",
        status: "done",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        projectId: proj!.id,
        number: 2,
      },
    ]);

    // One attached resource → resource_count=1.
    await db.insert(projectResource).values({
      projectId: proj!.id,
      workspaceId: ws!.id,
      resourceType: "link",
      resourceRef: { url: "https://example.com" },
    });

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // list → { projects: [...], total }
      const listRes = await app.request("/api/projects", { headers: auth });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as {
        projects: Array<{
          id: string;
          title: string;
          workspace_id: string;
          status: string;
          priority: string;
          issue_count: number;
          done_count: number;
          resource_count: number;
        }>;
        total: number;
      };
      expect(body.total).toBe(1);
      const mine = body.projects.find((p) => p.id === proj!.id)!;
      expect(mine).toBeDefined();
      expect(mine.title).toBe("Launch");
      expect(mine.workspace_id).toBe(ws!.id);
      expect(mine.issue_count).toBe(2);
      expect(mine.done_count).toBe(1);
      expect(mine.resource_count).toBe(1);

      // status filter that excludes the project → empty
      const filtered = await app.request("/api/projects?status=completed", { headers: auth });
      expect(filtered.status).toBe(200);
      const fbody = (await filtered.json()) as { projects: unknown[]; total: number };
      expect(fbody.total).toBe(0);

      // get by UUID → bare ProjectResponse with counts
      const getRes = await app.request(`/api/projects/${proj!.id}`, { headers: auth });
      expect(getRes.status).toBe(200);
      const one = (await getRes.json()) as {
        id: string;
        title: string;
        issue_count: number;
        done_count: number;
        resource_count: number;
        icon: string | null;
      };
      expect(one.id).toBe(proj!.id);
      expect(one.title).toBe("Launch");
      expect(one.icon).toBe("rocket");
      expect(one.issue_count).toBe(2);
      expect(one.done_count).toBe(1);
      expect(one.resource_count).toBe(1);

      // unknown UUID → 404
      const missing = await app.request(
        "/api/projects/11111111-1111-4111-8111-111111111111",
        { headers: auth },
      );
      expect(missing.status).toBe(404);

      // missing workspace header → 400
      const noWs = await app.request("/api/projects", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // a member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/projects", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(projectResource).where(eq(projectResource.workspaceId, ws!.id));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(project).where(eq(project.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
