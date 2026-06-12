import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, skill, skillFile } from "../src/db/schema.js";
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
  "skills read path: list (summaries, no content) + get by UUID with files, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-skill-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Skill WS", slug: `bun-skill-${stamp}`, issuePrefix: "SKL" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    // Two skills so we can assert ASC-by-name ordering and summary shape.
    const [skBeta] = await db
      .insert(skill)
      .values({
        workspaceId: ws!.id,
        name: "beta-skill",
        description: "Second alphabetically",
        content: "# Beta\nbeta body",
        config: { origin: { type: "manual" } },
        createdBy: u.id,
      })
      .returning();
    const [skAlpha] = await db
      .insert(skill)
      .values({
        workspaceId: ws!.id,
        name: "alpha-skill",
        description: "First alphabetically",
        content: "# Alpha\nalpha body",
        config: {},
        createdBy: u.id,
      })
      .returning();

    // One supporting file on alpha → detail endpoint should return it.
    await db.insert(skillFile).values({
      skillId: skAlpha!.id,
      path: "reference/notes.md",
      content: "supporting content",
    });

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // list → array of summaries, ASC by name, WITHOUT `content`
      const listRes = await app.request("/api/skills", { headers: auth });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as Array<{
        id: string;
        workspace_id: string;
        name: string;
        description: string;
        config: unknown;
        created_by: string | null;
        created_at: string;
        updated_at: string;
        content?: unknown;
      }>;
      expect(body.length).toBe(2);
      expect(body.map((s) => s.name)).toEqual(["alpha-skill", "beta-skill"]);
      const alphaSummary = body[0]!;
      expect(alphaSummary.id).toBe(skAlpha!.id);
      expect(alphaSummary.workspace_id).toBe(ws!.id);
      expect(alphaSummary.created_by).toBe(u.id);
      // summary omits content
      expect(alphaSummary.content).toBeUndefined();
      // config defaults to {} object, never null
      expect(alphaSummary.config).toEqual({});

      // get by UUID → full SkillResponse + files
      const getRes = await app.request(`/api/skills/${skAlpha!.id}`, { headers: auth });
      expect(getRes.status).toBe(200);
      const one = (await getRes.json()) as {
        id: string;
        name: string;
        content: string;
        config: unknown;
        created_by: string | null;
        files: Array<{ id: string; skill_id: string; path: string; content: string }>;
      };
      expect(one.id).toBe(skAlpha!.id);
      expect(one.name).toBe("alpha-skill");
      expect(one.content).toBe("# Alpha\nalpha body");
      expect(one.created_by).toBe(u.id);
      expect(one.files.length).toBe(1);
      expect(one.files[0]!.path).toBe("reference/notes.md");
      expect(one.files[0]!.skill_id).toBe(skAlpha!.id);
      expect(one.files[0]!.content).toBe("supporting content");

      // get a skill with no files → empty files array
      const betaRes = await app.request(`/api/skills/${skBeta!.id}`, { headers: auth });
      expect(betaRes.status).toBe(200);
      const betaBody = (await betaRes.json()) as { files: unknown[]; content: string };
      expect(betaBody.files).toEqual([]);
      expect(betaBody.content).toBe("# Beta\nbeta body");

      // non-UUID id → 400
      const badId = await app.request("/api/skills/not-a-uuid", { headers: auth });
      expect(badId.status).toBe(400);

      // unknown UUID → 404
      const missing = await app.request(
        "/api/skills/11111111-1111-4111-8111-111111111111",
        { headers: auth },
      );
      expect(missing.status).toBe(404);

      // missing workspace header → 400
      const noWs = await app.request("/api/skills", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // a member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/skills", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(skillFile).where(eq(skillFile.skillId, skAlpha!.id));
      await db.delete(skill).where(eq(skill.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
