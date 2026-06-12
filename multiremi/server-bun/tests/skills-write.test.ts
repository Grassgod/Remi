import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, skill, skillFile } from "../src/db/schema.js";
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

interface SkillBody {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  content: string;
  config: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  files: Array<{ id: string; skill_id: string; path: string }>;
}

test.skipIf(!reachable)(
  "POST /api/skills creates a workspace-scoped skill (201) and rejects missing name (400)",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-skc-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Skill Create WS", slug: `bun-skc-${stamp}`, issuePrefix: "SKC" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    try {
      const res = await app.request("/api/skills", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "Deploy", description: "ship it", content: "# Deploy\nsteps" }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as SkillBody;
      expect(created.name).toBe("Deploy");
      expect(created.description).toBe("ship it");
      expect(created.content).toBe("# Deploy\nsteps");
      expect(created.workspace_id).toBe(ws!.id);
      expect(created.created_by).toBe(u.id);
      expect(created.config).toEqual({}); // defaults to {} (mirrors decodeSkillConfig)
      expect(created.files).toEqual([]); // new skill has no supporting files
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);

      // missing name → 400
      const bad = await app.request("/api/skills", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ description: "no name" }),
      });
      expect(bad.status).toBe(400);

      // duplicate name in same workspace → 409 (UNIQUE(workspace_id, name))
      const dup = await app.request("/api/skills", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "Deploy" }),
      });
      expect(dup.status).toBe(409);

      // missing workspace header → 400
      const noWs = await app.request("/api/skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Orphan" }),
      });
      expect(noWs.status).toBe(400);

      // non-member of a foreign workspace → 404 (multi-tenancy gate)
      const foreign = await app.request("/api/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Workspace-ID": "99999999-9999-4999-8999-999999999999",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Sneaky" }),
      });
      expect(foreign.status).toBe(404);

      // database not configured → 503
      const noDbApp = createApp(cfg, undefined);
      const down = await noDbApp.request("/api/skills", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "X" }),
      });
      expect(down.status).toBe(503);
    } finally {
      // children before parents: skill_file cascades when its skill is deleted,
      // so deleting skills clears any files; member/workspace/user follow.
      await db.delete(skill).where(eq(skill.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "PUT /api/skills/:id partially updates (200) and DELETE removes it (204), workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-sku-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Skill Update WS", slug: `bun-sku-${stamp}`, issuePrefix: "SKU" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    // Seed a skill (with a supporting file) directly so we can verify the
    // detail response keeps existing files on update.
    const [seed] = await db
      .insert(skill)
      .values({
        workspaceId: ws!.id,
        name: "Original",
        description: "orig desc",
        content: "orig content",
        config: { kind: "test" },
        createdBy: u.id,
      })
      .returning();
    await db.insert(skillFile).values({ skillId: seed!.id, path: "ref.md", content: "see also" });

    try {
      // partial update: only description changes; name/content/config preserved
      const upd = await app.request(`/api/skills/${seed!.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ description: "updated desc" }),
      });
      expect(upd.status).toBe(200);
      const after = (await upd.json()) as SkillBody;
      expect(after.description).toBe("updated desc");
      expect(after.name).toBe("Original"); // untouched
      expect(after.content).toBe("orig content"); // untouched
      expect(after.config).toEqual({ kind: "test" }); // untouched
      expect(after.files.map((f) => f.path)).toEqual(["ref.md"]); // existing files preserved

      // update by non-UUID id → 400
      const badId = await app.request("/api/skills/not-a-uuid", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ name: "X" }),
      });
      expect(badId.status).toBe(400);

      // update a non-existent (but well-formed) id → 404
      const missing = await app.request("/api/skills/99999999-9999-4999-8999-999999999999", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ name: "X" }),
      });
      expect(missing.status).toBe(404);

      // delete by UUID → 204, then 404 on re-fetch
      const del = await app.request(`/api/skills/${seed!.id}`, { method: "DELETE", headers: auth });
      expect(del.status).toBe(204);
      const gone = await app.request(`/api/skills/${seed!.id}`, { headers: auth });
      expect(gone.status).toBe(404);

      // delete again → 404 (already removed)
      const delAgain = await app.request(`/api/skills/${seed!.id}`, { method: "DELETE", headers: auth });
      expect(delAgain.status).toBe(404);
    } finally {
      await db.delete(skillFile).where(eq(skillFile.skillId, seed!.id));
      await db.delete(skill).where(eq(skill.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "skill write endpoints emit skill.created / skill.updated / skill.deleted on the realtime bus",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-skb-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Skill Bus WS", slug: `bun-skb-${stamp}`, issuePrefix: "SKB" })
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
        await app.request("/api/skills", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ name: "Bus skill" }),
        })
      ).json()) as SkillBody;
      await app.request(`/api/skills/${created.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ description: "now updated" }),
      });
      await app.request(`/api/skills/${created.id}`, { method: "DELETE", headers: auth });

      expect(events).toContain("skill.created");
      expect(events).toContain("skill.updated");
      expect(events).toContain("skill.deleted");
    } finally {
      unsub();
      await db.delete(skill).where(eq(skill.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
