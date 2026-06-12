import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, agent, agentRuntime, squad, squadMember } from "../src/db/schema.js";
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

/**
 * Build a fresh tenant with an owner user + one or two agents. Every NOT-NULL
 * FK is satisfied: agent.runtime_id → a real agent_runtime row (whose
 * runtime_mode/status obey the CHECK constraints). Returns everything the test
 * needs plus a cleanup() that drops children before parents.
 */
async function setup(db: ReturnType<typeof createDb>["db"], slug: string) {
  const { user: u } = await findOrCreateUser(db, `${slug}@bytedance.com`, cfg);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

  const [ws] = await db
    .insert(workspace)
    .values({ name: "Squad WS", slug, issuePrefix: "SQD" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

  // agent.runtime_id is NOT NULL → insert a runtime first. runtime_mode ∈
  // {local,cloud}; status ∈ {online,offline}; visibility ∈ {private,public}.
  const [rt] = await db
    .insert(agentRuntime)
    .values({ workspaceId: ws!.id, name: "rt", runtimeMode: "local", provider: "claude", status: "offline" })
    .returning();

  // agent.runtime_mode ∈ {local,cloud}; visibility ∈ {workspace,private};
  // status ∈ {idle,working,blocked,error,offline}.
  const [leader] = await db
    .insert(agent)
    .values({ workspaceId: ws!.id, name: "Leader Bot", runtimeMode: "local", runtimeId: rt!.id })
    .returning();
  const [other] = await db
    .insert(agent)
    .values({ workspaceId: ws!.id, name: "Worker Bot", runtimeMode: "local", runtimeId: rt!.id })
    .returning();

  const auth = {
    Authorization: `Bearer ${token}`,
    "X-Workspace-ID": ws!.id,
    "Content-Type": "application/json",
  };

  async function cleanup() {
    // Children before parents: squad_member → squad → agent → agent_runtime → member → workspace → user.
    const squads = await db.select({ id: squad.id }).from(squad).where(eq(squad.workspaceId, ws!.id));
    for (const s of squads) await db.delete(squadMember).where(eq(squadMember.squadId, s.id));
    await db.delete(squad).where(eq(squad.workspaceId, ws!.id));
    await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
  }

  return { u, token, ws: ws!, leader: leader!, other: other!, auth, cleanup };
}

test.skipIf(!reachable)("POST /api/squads creates a squad, auto-adds the leader, and emits squad.created", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { u, ws, leader, auth, cleanup } = await setup(db, `bun-sqc-${stamp}`);
  const events: string[] = [];
  const unsub = bus.subscribe(ws.id, (e) => events.push(e.type));
  try {
    // missing name → 400
    const noName = await app.request("/api/squads", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ leader_id: leader.id }),
    });
    expect(noName.status).toBe(400);

    // missing leader_id → 400
    const noLeader = await app.request("/api/squads", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Alpha" }),
    });
    expect(noLeader.status).toBe(400);

    // leader not an agent in this workspace → 400
    const badLeader = await app.request("/api/squads", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Alpha", leader_id: "99999999-9999-4999-8999-999999999999" }),
    });
    expect(badLeader.status).toBe(400);

    const res = await app.request("/api/squads", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Alpha", description: "first squad", leader_id: leader.id }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      workspace_id: string;
      name: string;
      description: string;
      leader_id: string;
      creator_id: string;
      member_count: number;
      member_preview: Array<{ member_type: string; member_id: string; role: string }>;
    };
    expect(created.name).toBe("Alpha");
    expect(created.description).toBe("first squad");
    expect(created.workspace_id).toBe(ws.id);
    expect(created.leader_id).toBe(leader.id);
    expect(created.creator_id).toBe(u.id);
    // Leader auto-added as a member with role "leader".
    expect(created.member_count).toBe(1);
    expect(created.member_preview[0]).toEqual({ member_type: "agent", member_id: leader.id, role: "leader" });
    expect(events).toContain("squad.created");

    // It is now visible via GET (shared workspace gate).
    const getRes = await app.request(`/api/squads/${created.id}`, { headers: auth });
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { name: string }).name).toBe("Alpha");
  } finally {
    unsub();
    await cleanup();
    await close();
  }
});

test.skipIf(!reachable)("PUT /api/squads/:id partial-updates and re-pointing the leader auto-adds the new agent", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { ws, leader, other, auth, cleanup } = await setup(db, `bun-squ-${stamp}`);
  const events: string[] = [];
  const unsub = bus.subscribe(ws.id, (e) => events.push(e.type));
  try {
    const created = (await (
      await app.request("/api/squads", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "Beta", description: "orig", leader_id: leader.id }),
      })
    ).json()) as { id: string };

    // Partial update: only name changes; description preserved.
    const upd = await app.request(`/api/squads/${created.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "Beta v2", instructions: "be helpful" }),
    });
    expect(upd.status).toBe(200);
    const after = (await upd.json()) as { name: string; description: string; instructions: string };
    expect(after.name).toBe("Beta v2");
    expect(after.description).toBe("orig");
    expect(after.instructions).toBe("be helpful");
    expect(events).toContain("squad.updated");

    // Re-point the leader to the other agent → it must be auto-added as a member.
    const reLead = await app.request(`/api/squads/${created.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ leader_id: other.id }),
    });
    expect(reLead.status).toBe(200);
    const afterLead = (await reLead.json()) as {
      leader_id: string;
      member_count: number;
      member_preview: Array<{ member_id: string }>;
    };
    expect(afterLead.leader_id).toBe(other.id);
    // Original leader + new leader are both members now.
    expect(afterLead.member_count).toBe(2);
    expect(afterLead.member_preview.some((m) => m.member_id === other.id)).toBe(true);

    // Invalid new leader → 400.
    const badLead = await app.request(`/api/squads/${created.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ leader_id: "99999999-9999-4999-8999-999999999999" }),
    });
    expect(badLead.status).toBe(400);

    // Unknown squad → 404.
    const missing = await app.request(`/api/squads/99999999-9999-4999-8999-999999999999`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "x" }),
    });
    expect(missing.status).toBe(404);
  } finally {
    unsub();
    await cleanup();
    await close();
  }
});

test.skipIf(!reachable)("DELETE /api/squads/:id archives (204), then re-delete is 400; emits squad.deleted", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { ws, leader, auth, cleanup } = await setup(db, `bun-sqd-${stamp}`);
  const events: string[] = [];
  const unsub = bus.subscribe(ws.id, (e) => events.push(e.type));
  try {
    const created = (await (
      await app.request("/api/squads", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "Gamma", leader_id: leader.id }),
      })
    ).json()) as { id: string };

    const del = await app.request(`/api/squads/${created.id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(204);
    expect(events).toContain("squad.deleted");

    // The row is soft-deleted (archived_at set), not physically removed.
    const [row] = await db.select().from(squad).where(eq(squad.id, created.id));
    expect(row?.archivedAt).toBeTruthy();

    // Re-deleting an already-archived squad → 400.
    const again = await app.request(`/api/squads/${created.id}`, { method: "DELETE", headers: auth });
    expect(again.status).toBe(400);
  } finally {
    unsub();
    await cleanup();
    await close();
  }
});

test.skipIf(!reachable)("squad member add/remove: 201 add, 409 dup, 404 remove-missing, 400 remove-leader, 204 remove", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { u, ws, leader, other, auth, cleanup } = await setup(db, `bun-sqm-${stamp}`);
  try {
    const created = (await (
      await app.request("/api/squads", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "Delta", leader_id: leader.id }),
      })
    ).json()) as { id: string };

    // Add an agent member → 201.
    const add = await app.request(`/api/squads/${created.id}/members`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ member_type: "agent", member_id: other.id, role: "worker" }),
    });
    expect(add.status).toBe(201);
    const sm = (await add.json()) as { squad_id: string; member_type: string; member_id: string; role: string };
    expect(sm.squad_id).toBe(created.id);
    expect(sm.member_type).toBe("agent");
    expect(sm.member_id).toBe(other.id);
    expect(sm.role).toBe("worker");

    // Add a human member (the owner user) → 201.
    const addHuman = await app.request(`/api/squads/${created.id}/members`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ member_type: "member", member_id: u.id, role: "reviewer" }),
    });
    expect(addHuman.status).toBe(201);

    // Duplicate add → 409.
    const dup = await app.request(`/api/squads/${created.id}/members`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ member_type: "agent", member_id: other.id, role: "worker" }),
    });
    expect(dup.status).toBe(409);

    // Bad member_type → 400.
    const badType = await app.request(`/api/squads/${created.id}/members`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ member_type: "robot", member_id: other.id }),
    });
    expect(badType.status).toBe(400);

    // Agent not in this workspace → 400.
    const badAgent = await app.request(`/api/squads/${created.id}/members`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ member_type: "agent", member_id: "99999999-9999-4999-8999-999999999999" }),
    });
    expect(badAgent.status).toBe(400);

    // Cannot remove the leader → 400.
    const rmLeader = await app.request(`/api/squads/${created.id}/members`, {
      method: "DELETE",
      headers: auth,
      body: JSON.stringify({ member_type: "agent", member_id: leader.id }),
    });
    expect(rmLeader.status).toBe(400);

    // Remove the non-leader agent → 204.
    const rm = await app.request(`/api/squads/${created.id}/members`, {
      method: "DELETE",
      headers: auth,
      body: JSON.stringify({ member_type: "agent", member_id: other.id }),
    });
    expect(rm.status).toBe(204);

    // Removing again → 404 (no rows).
    const rmGone = await app.request(`/api/squads/${created.id}/members`, {
      method: "DELETE",
      headers: auth,
      body: JSON.stringify({ member_type: "agent", member_id: other.id }),
    });
    expect(rmGone.status).toBe(404);
  } finally {
    await cleanup();
    await close();
  }
});

test.skipIf(!reachable)("write routes enforce owner/admin role: a plain member gets 404, no DB row created", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { ws, leader, cleanup } = await setup(db, `bun-sqr-${stamp}`);
  // A second user who is only a plain "member" of the same workspace.
  const { user: u2 } = await findOrCreateUser(db, `bun-sqr2-${stamp}@bytedance.com`, cfg);
  const token2 = await issueJWT({ sub: u2.id, email: u2.email, name: u2.name }, SECRET);
  await db.insert(member).values({ workspaceId: ws.id, userId: u2.id, role: "member" });
  const auth2 = {
    Authorization: `Bearer ${token2}`,
    "X-Workspace-ID": ws.id,
    "Content-Type": "application/json",
  };
  try {
    const res = await app.request("/api/squads", {
      method: "POST",
      headers: auth2,
      body: JSON.stringify({ name: "Forbidden", leader_id: leader.id }),
    });
    expect(res.status).toBe(404);
    const rows = await db.select().from(squad).where(eq(squad.workspaceId, ws.id));
    expect(rows.length).toBe(0);

    // !db path → 503 (router built without a db).
    const appNoDb = createApp(cfg, undefined);
    const noDb = await appNoDb.request("/api/squads", {
      method: "POST",
      headers: auth2,
      body: JSON.stringify({ name: "x", leader_id: leader.id }),
    });
    expect(noDb.status).toBe(503);
  } finally {
    await db.delete(member).where(eq(member.userId, u2.id));
    await db.delete(user).where(eq(user.id, u2.id));
    await cleanup();
    await close();
  }
});
