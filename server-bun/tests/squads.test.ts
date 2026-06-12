import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import {
  user,
  member,
  workspace,
  agent,
  agentRuntime,
  squad,
  squadMember,
} from "../src/db/schema.js";
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
  "squads read path: list (with member preview) + get by UUID, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-squad-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Squad WS", slug: `bun-squad-${stamp}`, issuePrefix: "SQD" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    // agent.runtime_id is NOT-NULL → insert an agent_runtime first.
    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "rt",
        runtimeMode: "local",
        provider: "claude",
      })
      .returning();

    // Leader agent + two more agents to exercise the >3 preview cap.
    const [leader] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: "Leader",
        runtimeMode: "local",
        runtimeId: rt!.id,
      })
      .returning();
    const [a2] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: "Worker2",
        runtimeMode: "local",
        runtimeId: rt!.id,
      })
      .returning();
    const [a3] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: "Worker3",
        runtimeMode: "local",
        runtimeId: rt!.id,
      })
      .returning();
    const [a4] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: "Worker4",
        runtimeMode: "local",
        runtimeId: rt!.id,
      })
      .returning();

    // squad.leader_id + creator_id are NOT-NULL.
    const [sq] = await db
      .insert(squad)
      .values({
        workspaceId: ws!.id,
        name: "Alpha",
        description: "First squad",
        instructions: "Be excellent",
        leaderId: leader!.id,
        creatorId: u.id,
      })
      .returning();

    // An archived squad in the same workspace must NOT appear in the list.
    const [archived] = await db
      .insert(squad)
      .values({
        workspaceId: ws!.id,
        name: "Ghost",
        leaderId: leader!.id,
        creatorId: u.id,
        archivedAt: new Date().toISOString(),
        archivedBy: u.id,
      })
      .returning();

    // Four members: leader (added second to prove leader-first ordering) plus
    // three workers → member_count=4, preview capped at 3 with leader first.
    await db.insert(squadMember).values([
      { squadId: sq!.id, memberType: "agent", memberId: a2!.id, role: "member" },
      { squadId: sq!.id, memberType: "agent", memberId: leader!.id, role: "leader" },
      { squadId: sq!.id, memberType: "agent", memberId: a3!.id, role: "member" },
      { squadId: sq!.id, memberType: "agent", memberId: a4!.id, role: "member" },
    ]);

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // list → SquadResponse[] (non-archived only), with member preview.
      const listRes = await app.request("/api/squads", { headers: auth });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as Array<{
        id: string;
        name: string;
        workspace_id: string;
        description: string;
        instructions: string;
        leader_id: string;
        creator_id: string;
        avatar_url: string | null;
        archived_at: string | null;
        member_count: number;
        member_preview: Array<{ member_type: string; member_id: string; role: string }>;
      }>;
      // Only the non-archived squad is listed.
      expect(body.length).toBe(1);
      const mine = body[0]!;
      expect(mine.id).toBe(sq!.id);
      expect(mine.name).toBe("Alpha");
      expect(mine.workspace_id).toBe(ws!.id);
      expect(mine.leader_id).toBe(leader!.id);
      expect(mine.instructions).toBe("Be excellent");
      expect(mine.avatar_url).toBeNull();
      // Full count is 4; preview is capped at 3 and leads with the leader.
      expect(mine.member_count).toBe(4);
      expect(mine.member_preview.length).toBe(3);
      expect(mine.member_preview[0]!.member_id).toBe(leader!.id);
      expect(mine.member_preview[0]!.role).toBe("leader");

      // get by UUID → bare SquadResponse with the same preview.
      const getRes = await app.request(`/api/squads/${sq!.id}`, { headers: auth });
      expect(getRes.status).toBe(200);
      const one = (await getRes.json()) as {
        id: string;
        name: string;
        member_count: number;
        member_preview: Array<{ member_id: string; role: string }>;
      };
      expect(one.id).toBe(sq!.id);
      expect(one.name).toBe("Alpha");
      expect(one.member_count).toBe(4);
      expect(one.member_preview.length).toBe(3);
      expect(one.member_preview[0]!.member_id).toBe(leader!.id);

      // get an archived squad by UUID → still resolves (GetSquadInWorkspace
      // does not filter archived).
      const archRes = await app.request(`/api/squads/${archived!.id}`, { headers: auth });
      expect(archRes.status).toBe(200);
      const archBody = (await archRes.json()) as { id: string; archived_at: string | null };
      expect(archBody.id).toBe(archived!.id);
      expect(archBody.archived_at).not.toBeNull();

      // unknown UUID → 404
      const missing = await app.request(
        "/api/squads/11111111-1111-4111-8111-111111111111",
        { headers: auth },
      );
      expect(missing.status).toBe(404);

      // malformed squad id → 400
      const badId = await app.request("/api/squads/not-a-uuid", { headers: auth });
      expect(badId.status).toBe(400);

      // missing workspace header → 400
      const noWs = await app.request("/api/squads", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // a member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/squads", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(squadMember).where(eq(squadMember.squadId, sq!.id));
      await db.delete(squad).where(eq(squad.workspaceId, ws!.id));
      await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
