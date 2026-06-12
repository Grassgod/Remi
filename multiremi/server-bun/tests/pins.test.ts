import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, issue, project, pinnedItem } from "../src/db/schema.js";
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

interface PinResponse {
  id: string;
  workspace_id: string;
  user_id: string;
  item_type: string;
  item_id: string;
  position: number;
  created_at: string;
}

test.skipIf(!reachable)(
  "pins read path: list (user + workspace-scoped) + pin / unpin",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-pin-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Pin WS", slug: `bun-pin-${stamp}`, issuePrefix: "PIN" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    // A real issue + project so the POST existence check passes (item_id has no
    // FK, but the route verifies the item lives in the workspace first).
    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Pinnable issue",
        status: "backlog",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        number: 1,
      })
      .returning();
    const [proj] = await db
      .insert(project)
      .values({ workspaceId: ws!.id, title: "Pinnable project", status: "planned", priority: "none" })
      .returning();

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };
    const jsonAuth = { ...auth, "Content-Type": "application/json" };

    try {
      // initially empty
      const empty = await app.request("/api/pins", { headers: auth });
      expect(empty.status).toBe(200);
      expect((await empty.json()) as PinResponse[]).toEqual([]);

      // pin an issue → 201, position appended at max+1 (= 1)
      const pinIssueRes = await app.request("/api/pins", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ item_type: "issue", item_id: iss!.id }),
      });
      expect(pinIssueRes.status).toBe(201);
      const pinned = (await pinIssueRes.json()) as PinResponse;
      expect(pinned.item_type).toBe("issue");
      expect(pinned.item_id).toBe(iss!.id);
      expect(pinned.workspace_id).toBe(ws!.id);
      expect(pinned.user_id).toBe(u.id);
      expect(pinned.position).toBe(1);

      // pin a project → 201, appended at max+1 (= 2)
      const pinProjRes = await app.request("/api/pins", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ item_type: "project", item_id: proj!.id }),
      });
      expect(pinProjRes.status).toBe(201);
      const pinnedProj = (await pinProjRes.json()) as PinResponse;
      expect(pinnedProj.position).toBe(2);

      // list → both pins, ordered by position ASC
      const listRes = await app.request("/api/pins", { headers: auth });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as PinResponse[];
      expect(list.length).toBe(2);
      expect(list[0]!.item_id).toBe(iss!.id);
      expect(list[1]!.item_id).toBe(proj!.id);

      // duplicate pin → 409
      const dup = await app.request("/api/pins", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ item_type: "issue", item_id: iss!.id }),
      });
      expect(dup.status).toBe(409);

      // bad item_type → 400
      const badType = await app.request("/api/pins", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ item_type: "comment", item_id: iss!.id }),
      });
      expect(badType.status).toBe(400);

      // pin a non-existent issue → 404
      const missingItem = await app.request("/api/pins", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ item_type: "issue", item_id: "11111111-1111-4111-8111-111111111111" }),
      });
      expect(missingItem.status).toBe(404);

      // unpin the issue → 204
      const unpin = await app.request(`/api/pins/issue/${iss!.id}`, {
        method: "DELETE",
        headers: auth,
      });
      expect(unpin.status).toBe(204);

      // list → only the project pin remains
      const afterUnpin = await app.request("/api/pins", { headers: auth });
      const remaining = (await afterUnpin.json()) as PinResponse[];
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.item_id).toBe(proj!.id);

      // missing workspace header → 400
      const noWs = await app.request("/api/pins", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // a member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/pins", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(pinnedItem).where(eq(pinnedItem.workspaceId, ws!.id));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(project).where(eq(project.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
