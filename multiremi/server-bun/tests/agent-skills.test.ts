/**
 * Agent skill assignment: PUT replaces the agent's skill set, GET lists it, the
 * add endpoint unions in more, and a skill id from another workspace is rejected.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { agentSkillRoutes } from "../src/http/routes/agentSkills.js";
import { user, member, workspace, agent, agentRuntime, agentSkill, skill } from "../src/db/schema.js";
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

test.skipIf(!reachable)("set/list/add agent skills; reject a cross-workspace skill", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-as-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "AS WS", slug: `bun-as-${stamp}`, issuePrefix: "AS", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();
  const [ag] = await db.insert(agent).values({ workspaceId: ws!.id, name: "Worker", runtimeId: rt!.id, runtimeMode: "local", ownerId: u.id }).returning();
  const [s1] = await db.insert(skill).values({ workspaceId: ws!.id, name: "Lint", description: "lint code", createdBy: u.id }).returning();
  const [s2] = await db.insert(skill).values({ workspaceId: ws!.id, name: "Test", description: "write tests", createdBy: u.id }).returning();
  // A skill in a DIFFERENT workspace — must be rejected.
  const [ws2] = await db.insert(workspace).values({ name: "Other", slug: `bun-as2-${stamp}`, issuePrefix: "OT", issueCounter: 0 }).returning();
  const [foreign] = await db.insert(skill).values({ workspaceId: ws2!.id, name: "Foreign", description: "x", createdBy: u.id }).returning();

  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => { c.set("user", { sub: u.id } as never); await n(); });
  app.route("/", agentSkillRoutes(db));
  const hdr = { "Content-Type": "application/json", "X-Workspace-ID": ws!.id };
  const skillsPath = `/api/agents/${ag!.id}/skills`;

  try {
    // PUT sets {s1}.
    const put = await app.request(skillsPath, { method: "PUT", headers: hdr, body: JSON.stringify({ skill_ids: [s1!.id] }) });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any[]).map((s) => s.id)).toEqual([s1!.id]);

    // GET reflects it.
    const get = await app.request(skillsPath, { headers: hdr });
    expect(((await get.json()) as any[]).map((s) => s.id)).toEqual([s1!.id]);

    // add unions in s2 → {s1, s2}.
    const add = await app.request(`${skillsPath}/add`, { method: "POST", headers: hdr, body: JSON.stringify({ skill_ids: [s2!.id] }) });
    expect(add.status).toBe(200);
    expect(new Set(((await add.json()) as any[]).map((s) => s.id))).toEqual(new Set([s1!.id, s2!.id]));

    // PUT replaces with just {s2}.
    const put2 = await app.request(skillsPath, { method: "PUT", headers: hdr, body: JSON.stringify({ skill_ids: [s2!.id] }) });
    expect(((await put2.json()) as any[]).map((s) => s.id)).toEqual([s2!.id]);
    const rows = await db.select().from(agentSkill).where(eq(agentSkill.agentId, ag!.id));
    expect(rows.length).toBe(1);

    // A cross-workspace skill id is rejected 400.
    const bad = await app.request(skillsPath, { method: "PUT", headers: hdr, body: JSON.stringify({ skill_ids: [foreign!.id] }) });
    expect(bad.status).toBe(400);
  } finally {
    await db.delete(agentSkill).where(eq(agentSkill.agentId, ag!.id));
    await db.delete(skill).where(eq(skill.workspaceId, ws!.id));
    await db.delete(skill).where(eq(skill.workspaceId, ws2!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws2!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
