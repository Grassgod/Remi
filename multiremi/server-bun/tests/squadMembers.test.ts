/**
 * Squad member endpoint tests — DB-gated. Drives the standalone
 * squadMembersRoutes(db) factory (GET list + GET status) mounted at "/",
 * alongside squadRoutes(db) mounted at "/api/squads" exactly like app.ts, so
 * the squad page's add/remove (POST/DELETE /api/squads/:id/members, which
 * live in squads.ts) is exercised end-to-end against the same app.
 *
 * The status fixture covers every derived bucket: idle (online runtime, no
 * task), working (active task — including a second no-issue task whose
 * fresher dispatch wins last_active_at), unstable (offline runtime seen <5min
 * ago), archived, and a human member (null status).
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { squadRoutes } from "../src/http/routes/squads.js";
import { squadMembersRoutes } from "../src/http/routes/squadMembers.js";
import type { AppEnv } from "../src/http/types.js";
import {
  user,
  member,
  workspace,
  agent,
  agentRuntime,
  agentTaskQueue,
  issue,
  squad,
  squadMember,
} from "../src/db/schema.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip when no DB */
}

interface MemberStatus {
  member_type: string;
  member_id: string;
  status: string | null;
  active_issues: Array<{ issue_id: string; identifier: string; title: string; issue_status: string }>;
  last_active_at: string | null;
}

const epoch = (s: string | null): number => new Date(s ?? "").getTime();

test.skipIf(!reachable)(
  "squad members: GET list + GET status (idle/working/unstable/archived/human) + add/remove cycle",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();

    // FK order: workspace -> member -> agent_runtime -> agent -> squad ->
    // (issue, squad_member, agent_task_queue leaf rows).
    const [u] = await db
      .insert(user)
      .values({ email: `bun-sqm-${stamp}@bytedance.com`, name: "Squad Member Tester" })
      .returning();
    const [ws] = await db
      .insert(workspace)
      .values({ name: "SquadMember WS", slug: `bun-sqm-${stamp}`, issuePrefix: "SQM" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u!.id, role: "owner" });

    const nowMs = Date.now();
    // Online runtime: hosts the idle leader + the working agent.
    const [rtOnline] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "rt-online",
        runtimeMode: "local",
        provider: "claude",
        status: "online",
        lastSeenAt: new Date(nowMs - 10_000).toISOString(),
      })
      .returning();
    // Offline runtime seen 60s ago → its agent reads "unstable" (<5min).
    const [rtStale] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "rt-stale",
        runtimeMode: "local",
        provider: "claude",
        status: "offline",
        lastSeenAt: new Date(nowMs - 60_000).toISOString(),
      })
      .returning();

    const newAgent = (name: string, runtimeId: string, archivedAt?: string) =>
      db
        .insert(agent)
        .values({ workspaceId: ws!.id, name, runtimeMode: "local", runtimeId, archivedAt })
        .returning();
    const [leader] = await newAgent("Leader", rtOnline!.id);
    const [worker] = await newAgent("Worker", rtOnline!.id);
    const [shaky] = await newAgent("Shaky", rtStale!.id);
    const [ghost] = await newAgent("Ghost", rtOnline!.id, new Date(nowMs - 3_600_000).toISOString());

    const [sq] = await db
      .insert(squad)
      .values({ workspaceId: ws!.id, name: "Status Squad", leaderId: leader!.id, creatorId: u!.id })
      .returning();

    // Insert members sequentially so created_at preserves insertion order.
    const addMember = (memberType: string, memberId: string, role: string) =>
      db.insert(squadMember).values({ squadId: sq!.id, memberType, memberId, role });
    await addMember("agent", leader!.id, "leader");
    await addMember("agent", worker!.id, "member");
    await addMember("agent", shaky!.id, "member");
    await addMember("agent", ghost!.id, "member");
    await addMember("member", u!.id, "member");

    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Port the endpoints",
        status: "in_progress",
        priority: "none",
        creatorType: "member",
        creatorId: u!.id,
        number: 7,
      })
      .returning();

    // Worker has TWO active tasks: a running one bound to the issue, and a
    // fresher dispatched chat task with NO issue. The no-issue task still
    // counts for "working" and its dispatch wins last_active_at.
    const issueTaskDispatch = new Date(nowMs - 120_000).toISOString();
    const chatTaskDispatch = new Date(nowMs - 30_000).toISOString();
    await db.insert(agentTaskQueue).values({
      agentId: worker!.id,
      runtimeId: rtOnline!.id,
      status: "running",
      issueId: iss!.id,
      dispatchedAt: issueTaskDispatch,
    });
    await db.insert(agentTaskQueue).values({
      agentId: worker!.id,
      runtimeId: rtOnline!.id,
      status: "dispatched",
      issueId: null,
      dispatchedAt: chatTaskDispatch,
    });

    // Mirror the app.ts wiring: squadRoutes under /api/squads (owns the
    // member write paths), squadMembersRoutes at "/" (absolute GET paths).
    const app = new Hono<AppEnv>();
    app.use("*", async (c, n) => {
      c.set("user", { sub: u!.id } as AppEnv["Variables"]["user"]);
      await n();
    });
    app.route("/api/squads", squadRoutes(db));
    app.route("/", squadMembersRoutes(db));

    const headers = { "X-Workspace-ID": ws!.id, "Content-Type": "application/json" };

    try {
      // ── GET /api/squads/:id/members — bare array, insertion order ──────
      const listRes = await app.request(`/api/squads/${sq!.id}/members`, { headers });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<{
        id: string;
        squad_id: string;
        member_type: string;
        member_id: string;
        role: string;
        created_at: string;
      }>;
      expect(list.length).toBe(5);
      expect(list[0]!.member_id).toBe(leader!.id);
      expect(list[0]!.member_type).toBe("agent");
      expect(list[0]!.role).toBe("leader");
      expect(list[0]!.squad_id).toBe(sq!.id);
      expect(list[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(list[0]!.created_at).toBeTruthy();
      expect(list[4]!.member_type).toBe("member");
      expect(list[4]!.member_id).toBe(u!.id);

      // ── GET /api/squads/:id/members/status — derived buckets ───────────
      const statusRes = await app.request(`/api/squads/${sq!.id}/members/status`, { headers });
      expect(statusRes.status).toBe(200);
      const { members } = (await statusRes.json()) as { members: MemberStatus[] };
      expect(members.length).toBe(5);
      // SQL order preserved: insertion order by squad_member.created_at.
      expect(members.map((m) => m.member_id)).toEqual([
        leader!.id,
        worker!.id,
        shaky!.id,
        ghost!.id,
        u!.id,
      ]);
      const byId = new Map(members.map((m) => [m.member_id, m]));

      // Idle: online runtime, no active task; heartbeat fills last_active_at.
      const leaderRow = byId.get(leader!.id)!;
      expect(leaderRow.status).toBe("idle");
      expect(leaderRow.active_issues).toEqual([]);
      expect(epoch(leaderRow.last_active_at)).toBe(nowMs - 10_000);

      // Working: the no-issue task counts; only the issue task renders a
      // brief; the freshest dispatch wins last_active_at.
      const workerRow = byId.get(worker!.id)!;
      expect(workerRow.status).toBe("working");
      expect(workerRow.active_issues).toEqual([
        { issue_id: iss!.id, identifier: "SQM-7", title: "Port the endpoints", issue_status: "in_progress" },
      ]);
      expect(epoch(workerRow.last_active_at)).toBe(epoch(chatTaskDispatch));

      // Unstable: offline runtime seen less than 5 minutes ago.
      const shakyRow = byId.get(shaky!.id)!;
      expect(shakyRow.status).toBe("unstable");
      expect(epoch(shakyRow.last_active_at)).toBe(nowMs - 60_000);

      // Archived wins over any leftover runtime state.
      expect(byId.get(ghost!.id)!.status).toBe("archived");

      // Human member: member_type only, null status / last_active_at.
      const humanRow = byId.get(u!.id)!;
      expect(humanRow.member_type).toBe("member");
      expect(humanRow.status).toBeNull();
      expect(humanRow.active_issues).toEqual([]);
      expect(humanRow.last_active_at).toBeNull();

      // ── Gates ───────────────────────────────────────────────────────────
      const badId = await app.request("/api/squads/not-a-uuid/members", { headers });
      expect(badId.status).toBe(400);
      const missing = await app.request(
        "/api/squads/11111111-1111-4111-8111-111111111111/members/status",
        { headers },
      );
      expect(missing.status).toBe(404);
      const foreign = await app.request(`/api/squads/${sq!.id}/members`, {
        headers: { "X-Workspace-ID": "99999999-9999-4999-8999-999999999999" },
      });
      expect(foreign.status).toBe(404);

      // ── Add/remove round-trip (write paths live in squads.ts) ──────────
      const [newbie] = await newAgent("Newbie", rtOnline!.id);
      const add = await app.request(`/api/squads/${sq!.id}/members`, {
        method: "POST",
        headers,
        body: JSON.stringify({ member_type: "agent", member_id: newbie!.id, role: "member" }),
      });
      expect(add.status).toBe(201);
      const added = (await add.json()) as { member_id: string; squad_id: string; role: string };
      expect(added.member_id).toBe(newbie!.id);
      expect(added.squad_id).toBe(sq!.id);
      expect(added.role).toBe("member");

      const afterAdd = await app.request(`/api/squads/${sq!.id}/members`, { headers });
      expect(((await afterAdd.json()) as unknown[]).length).toBe(6);
      // The fresh agent has no runtime heartbeat issues — it shows up in the
      // status list too (idle: it shares the online runtime).
      const statusAfterAdd = await app.request(`/api/squads/${sq!.id}/members/status`, { headers });
      const afterAddMembers = ((await statusAfterAdd.json()) as { members: MemberStatus[] }).members;
      expect(afterAddMembers.length).toBe(6);
      expect(afterAddMembers[5]!.member_id).toBe(newbie!.id);
      expect(afterAddMembers[5]!.status).toBe("idle");

      const rm = await app.request(`/api/squads/${sq!.id}/members`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ member_type: "agent", member_id: newbie!.id }),
      });
      expect(rm.status).toBe(204);
      const afterRm = await app.request(`/api/squads/${sq!.id}/members`, { headers });
      expect(((await afterRm.json()) as unknown[]).length).toBe(5);
    } finally {
      await db.delete(agentTaskQueue).where(eq(agentTaskQueue.agentId, worker!.id));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(squadMember).where(eq(squadMember.squadId, sq!.id));
      await db.delete(squad).where(eq(squad.id, sq!.id));
      await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
      await db
        .delete(agentRuntime)
        .where(inArray(agentRuntime.id, [rtOnline!.id, rtStale!.id]));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u!.id));
      await close();
    }
  },
);
