import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, agent, agentRuntime, skill, agentSkill } from "../src/db/schema.js";
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

const RUNTIME_ID = "11111111-1111-4111-8111-111111111111";

test.skipIf(!reachable)(
  "agents read path: list (skills + env metadata + archived filter) and get by UUID, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-agt-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Agent WS", slug: `bun-agt-${stamp}`, issuePrefix: "AGT" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    // agent.runtime_id is NOT NULL with an FK → create the runtime first.
    await db.insert(agentRuntime).values({
      id: RUNTIME_ID,
      workspaceId: ws!.id,
      name: "Test Runtime",
      runtimeMode: "cloud",
      provider: "codex",
    });

    // A skill bound to the agent, to exercise the embedded summary + N+1 batch.
    const [sk] = await db
      .insert(skill)
      .values({ workspaceId: ws!.id, name: "Deploy", description: "ships it", content: "" })
      .returning();

    const [a] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: "Builder",
        description: "builds things",
        instructions: "be helpful",
        runtimeId: RUNTIME_ID,
        runtimeMode: "cloud",
        ownerId: u.id,
        customEnv: { API_KEY: "secret", DB_PASS: "secret" },
        customArgs: ["--verbose"],
        model: "gpt-5",
        thinkingLevel: "high",
      })
      .returning();
    await db.insert(agentSkill).values({ agentId: a!.id, skillId: sk!.id });

    // An archived agent — excluded by default, included with include_archived=true.
    const [archived] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: "Retired",
        runtimeId: RUNTIME_ID,
        runtimeMode: "cloud",
        archivedAt: new Date().toISOString(),
        archivedBy: u.id,
      })
      .returning();

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // list — archived excluded by default
      const listRes = await app.request("/api/agents", { headers: auth });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<{
        id: string;
        name: string;
        has_custom_env: boolean;
        custom_env_key_count: number;
        custom_args: string[];
        model: string;
        thinking_level: string;
        owner_id: string | null;
        skills: Array<{ id: string; name: string; description: string }>;
        archived_at: string | null;
        mcp_config: unknown;
      }>;
      expect(list.some((x) => x.id === a!.id)).toBe(true);
      expect(list.some((x) => x.id === archived!.id)).toBe(false);

      const mine = list.find((x) => x.id === a!.id)!;
      expect(mine.name).toBe("Builder");
      // custom_env values are NOT serialized — only coarse metadata (MUL-2600).
      expect("custom_env" in mine).toBe(false);
      expect(mine.has_custom_env).toBe(true);
      expect(mine.custom_env_key_count).toBe(2);
      expect(mine.custom_args).toEqual(["--verbose"]);
      expect(mine.model).toBe("gpt-5");
      expect(mine.thinking_level).toBe("high");
      expect(mine.owner_id).toBe(u.id);
      expect(mine.mcp_config).toBeNull();
      // embedded skill summary
      expect(mine.skills.length).toBe(1);
      expect(mine.skills[0]!.name).toBe("Deploy");
      expect(mine.skills[0]!.description).toBe("ships it");

      // list with include_archived=true — archived now present
      const allRes = await app.request("/api/agents?include_archived=true", { headers: auth });
      expect(allRes.status).toBe(200);
      const all = (await allRes.json()) as Array<{ id: string; archived_at: string | null }>;
      expect(all.some((x) => x.id === archived!.id)).toBe(true);
      expect(all.find((x) => x.id === archived!.id)!.archived_at).not.toBeNull();

      // get by UUID
      const byId = await app.request(`/api/agents/${a!.id}`, { headers: auth });
      expect(byId.status).toBe(200);
      const got = (await byId.json()) as {
        id: string;
        name: string;
        skills: Array<{ name: string }>;
        workspace_id: string;
      };
      expect(got.id).toBe(a!.id);
      expect(got.name).toBe("Builder");
      expect(got.workspace_id).toBe(ws!.id);
      expect(got.skills[0]!.name).toBe("Deploy");

      // get unknown UUID → 404
      const missing = "22222222-2222-4222-8222-222222222222";
      const notFound = await app.request(`/api/agents/${missing}`, { headers: auth });
      expect(notFound.status).toBe(404);

      // missing workspace header → 400
      const noWs = await app.request("/api/agents", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // a member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/agents", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(agentSkill).where(eq(agentSkill.agentId, a!.id));
      await db.delete(skill).where(eq(skill.workspaceId, ws!.id));
      await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
