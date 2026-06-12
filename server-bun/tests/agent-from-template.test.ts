/**
 * Create-agent-from-template: materialises a catalog template into an agent
 * (instructions + skills), reuses a same-named workspace skill on a second
 * create rather than duplicating it, and 400s an unknown template.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { agentRoutes } from "../src/http/routes/agents.js";
import { getAgentTemplate } from "../src/agent/templates.js";
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

test.skipIf(!reachable)("from-template creates an agent with template instructions + skills; reuses by name", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-aft-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "AFT WS", slug: `bun-aft-${stamp}`, issuePrefix: "AF", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db.insert(agentRuntime).values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" }).returning();

  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => { c.set("user", { sub: u.id } as never); await n(); });
  app.route("/api/agents", agentRoutes(db));
  const hdr = { "Content-Type": "application/json", "X-Workspace-ID": ws!.id };

  // bug-fixer template has a skill (root-cause-tracing); summarizer has none.
  const bugFixer = getAgentTemplate("bug-fixer")!;
  const skillName = bugFixer.skills[0]!.cached_name;

  try {
    const res = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ template_slug: "bug-fixer", name: "Bugbot", runtime_id: rt!.id }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; name: string; instructions: string; skills: { name: string }[] };
    expect(created.name).toBe("Bugbot");
    expect(created.instructions).toBe(bugFixer.instructions);
    expect(created.skills.map((s) => s.name)).toContain(skillName);

    // The skill row was created once and linked to the agent.
    const wsSkills = await db.select().from(skill).where(and(eq(skill.workspaceId, ws!.id), eq(skill.name, skillName)));
    expect(wsSkills.length).toBe(1);
    expect((await db.select().from(agentSkill).where(eq(agentSkill.agentId, created.id))).length).toBe(1);

    // A second agent from the same template REUSES the skill (no duplicate row).
    const res2 = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ template_slug: "bug-fixer", name: "Bugbot 2", runtime_id: rt!.id }),
    });
    expect(res2.status).toBe(201);
    expect((await db.select().from(skill).where(and(eq(skill.workspaceId, ws!.id), eq(skill.name, skillName)))).length).toBe(1);

    // Unknown template → 400.
    const bad = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ template_slug: "nope", name: "X", runtime_id: rt!.id }),
    });
    expect(bad.status).toBe(400);
  } finally {
    const agents = await db.select({ id: agent.id }).from(agent).where(eq(agent.workspaceId, ws!.id));
    for (const a of agents) await db.delete(agentSkill).where(eq(agentSkill.agentId, a.id));
    await db.delete(skill).where(eq(skill.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
