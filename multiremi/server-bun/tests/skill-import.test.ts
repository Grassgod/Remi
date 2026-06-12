/**
 * Skill import: a fetched skill (injected fetcher) is persisted as a skill row +
 * its files; a duplicate name → 409; a fetch failure → 422.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { skillRoutes, type SkillFetcher } from "../src/http/routes/skills.js";
import { user, member, workspace, skill, skillFile } from "../src/db/schema.js";
import type { AppEnv } from "../src/http/types.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = { port: 0, jwtSecret: "x", authTokenTtlSeconds: 3600, databaseUrl: DB_URL, allowedEmailDomains: [] };

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

test.skipIf(!reachable)("import persists a fetched skill + files; duplicate 409; fetch failure 422", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const skillName = `imported-skill-${stamp}`;
  const { user: u } = await findOrCreateUser(db, `bun-si-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "SI WS", slug: `bun-si-${stamp}`, issuePrefix: "SI", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

  const fetcher: SkillFetcher = {
    async fetch(url) {
      if (url.includes("broken")) throw new Error("404");
      return {
        name: skillName,
        description: "An imported capability",
        content: "# Skill\nDo the thing.",
        files: [{ path: "helper.sh", content: "echo hi" }],
        origin: { source_url: url },
      };
    },
  };

  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => { c.set("user", { sub: u.id } as never); await n(); });
  app.route("/api/skills", skillRoutes(db, fetcher));
  const hdr = { "Content-Type": "application/json", "X-Workspace-ID": ws!.id };

  try {
    // Import → 201, skill + file persisted, origin captured in config.
    const res = await app.request("/api/skills/import", { method: "POST", headers: hdr, body: JSON.stringify({ url: "https://example.com/skill" }) });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; name: string; content: string; config: any; files: { path: string }[] };
    expect(created.name).toBe(skillName);
    expect(created.content).toContain("Do the thing");
    expect(created.config.origin.source_url).toBe("https://example.com/skill");
    expect(created.files.map((f) => f.path)).toEqual(["helper.sh"]);
    expect((await db.select().from(skillFile).where(eq(skillFile.skillId, created.id))).length).toBe(1);

    // Re-import the same name → 409.
    const dup = await app.request("/api/skills/import", { method: "POST", headers: hdr, body: JSON.stringify({ url: "https://example.com/skill" }) });
    expect(dup.status).toBe(409);

    // Fetch failure → 422.
    const broken = await app.request("/api/skills/import", { method: "POST", headers: hdr, body: JSON.stringify({ url: "https://example.com/broken" }) });
    expect(broken.status).toBe(422);
  } finally {
    const skills = await db.select({ id: skill.id }).from(skill).where(eq(skill.workspaceId, ws!.id));
    for (const s of skills) await db.delete(skillFile).where(eq(skillFile.skillId, s.id));
    await db.delete(skill).where(eq(skill.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
