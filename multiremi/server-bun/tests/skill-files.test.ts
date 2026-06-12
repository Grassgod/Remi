/**
 * Skill files: PUT upserts (insert + content refresh on the same path), GET
 * lists, DELETE removes; a skill in another workspace is not reachable.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { skillFileRoutes } from "../src/http/routes/skillFiles.js";
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

test.skipIf(!reachable)("upsert/list/delete skill files; cross-workspace skill is 404", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-sf-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "SF WS", slug: `bun-sf-${stamp}`, issuePrefix: "SF", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [s] = await db.insert(skill).values({ workspaceId: ws!.id, name: "Deploy", description: "deploy skill", createdBy: u.id }).returning();
  const [ws2] = await db.insert(workspace).values({ name: "Other", slug: `bun-sf2-${stamp}`, issuePrefix: "OT", issueCounter: 0 }).returning();
  const [foreignSkill] = await db.insert(skill).values({ workspaceId: ws2!.id, name: "X", description: "x", createdBy: u.id }).returning();

  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => { c.set("user", { sub: u.id } as never); await n(); });
  app.route("/", skillFileRoutes(db));
  const hdr = { "Content-Type": "application/json", "X-Workspace-ID": ws!.id };
  const base = `/api/skills/${s!.id}/files`;

  try {
    // PUT two files.
    const put = await app.request(base, { method: "PUT", headers: hdr, body: JSON.stringify({ files: [{ path: "run.sh", content: "echo hi" }, { path: "README.md", content: "docs" }] }) });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any[]).length).toBe(2);

    // PUT again with the same path → content refreshed, not duplicated.
    const put2 = await app.request(base, { method: "PUT", headers: hdr, body: JSON.stringify({ files: [{ path: "run.sh", content: "echo bye" }] }) });
    const files2 = (await put2.json()) as any[];
    expect(files2.length).toBe(2); // still 2 distinct paths
    expect(files2.find((f) => f.path === "run.sh").content).toBe("echo bye");

    // GET lists them.
    const get = await app.request(base, { headers: hdr });
    const listed = (await get.json()) as any[];
    expect(listed.map((f) => f.path).sort()).toEqual(["README.md", "run.sh"]);

    // DELETE one.
    const target = listed.find((f) => f.path === "README.md");
    const del = await app.request(`${base}/${target.id}`, { method: "DELETE", headers: hdr });
    expect(del.status).toBe(204);
    expect((await db.select().from(skillFile).where(eq(skillFile.skillId, s!.id))).length).toBe(1);

    // A skill in another workspace is not reachable via this workspace.
    const cross = await app.request(`/api/skills/${foreignSkill!.id}/files`, { headers: hdr });
    expect(cross.status).toBe(404);
  } finally {
    await db.delete(skillFile).where(eq(skillFile.skillId, s!.id));
    await db.delete(skill).where(eq(skill.workspaceId, ws!.id));
    await db.delete(skill).where(eq(skill.workspaceId, ws2!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws2!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
