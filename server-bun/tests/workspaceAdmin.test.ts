/**
 * Workspace admin endpoint tests — the Go workspace settings write path
 * (GET/PATCH/DELETE /api/workspaces/:id, POST /:id/leave, PATCH/DELETE
 * /:id/members/:memberId) ported in src/http/routes/workspaceAdmin.ts.
 *
 * DB-gated: probes `select 1` once and skips when unreachable. Each test
 * creates its own epoch-millis-suffixed fixtures and tears down in reverse.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { workspaceAdminRoutes } from "../src/http/routes/workspaceAdmin.js";
import { bus, type BusEvent } from "../src/realtime/bus.js";
import {
  agent,
  agentRuntime,
  agentTaskQueue,
  daemonToken,
  member,
  user,
  workspace,
} from "../src/db/schema.js";
import type { AppEnv } from "../src/http/types.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = {
  port: 0,
  jwtSecret: "test-secret-0123456789",
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

/** Mount workspaceAdminRoutes on a bare app whose c.get("user").sub is `userId`. */
function appForUser(db: ReturnType<typeof createDb>["db"], userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => {
    c.set("user", { sub: userId, email: "", name: "" });
    await n();
  });
  app.route("/", workspaceAdminRoutes(db));
  return app;
}

type WorkspaceResp = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  context: string | null;
  settings: Record<string, unknown>;
  repos: unknown[];
  issue_prefix: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
};

type MemberResp = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: string;
  name: string;
  email: string;
  avatar_url: string | null;
};

test.skipIf(!reachable)(
  "workspace admin: GET + PATCH/PUT workspace (role gates, field semantics)",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();

    const { user: owner } = await findOrCreateUser(db, `bun-wsa-owner-${stamp}@bytedance.com`, cfg);
    const { user: admin } = await findOrCreateUser(db, `bun-wsa-admin-${stamp}@bytedance.com`, cfg);
    const { user: plain } = await findOrCreateUser(db, `bun-wsa-plain-${stamp}@bytedance.com`, cfg);
    const { user: outsider } = await findOrCreateUser(db, `bun-wsa-out-${stamp}@bytedance.com`, cfg);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Admin WS", slug: `bun-wsa-${stamp}`, issuePrefix: "AWS" })
      .returning();
    await db.insert(member).values([
      { workspaceId: ws!.id, userId: owner.id, role: "owner" },
      { workspaceId: ws!.id, userId: admin.id, role: "admin" },
      { workspaceId: ws!.id, userId: plain.id, role: "member" },
    ]);

    const ownerApp = appForUser(db, owner.id);
    const adminApp = appForUser(db, admin.id);
    const plainApp = appForUser(db, plain.id);
    const outsiderApp = appForUser(db, outsider.id);

    const events: BusEvent[] = [];
    const unsub = bus.subscribe(ws!.id, (e) => events.push(e));

    try {
      // --- GET ----------------------------------------------------------------
      const getRes = await plainApp.request(`/api/workspaces/${ws!.id}`);
      expect(getRes.status).toBe(200);
      const got = (await getRes.json()) as WorkspaceResp;
      expect(got.id).toBe(ws!.id);
      expect(got.name).toBe("Admin WS");
      expect(got.slug).toBe(`bun-wsa-${stamp}`);
      expect(got.issue_prefix).toBe("AWS");
      expect(got.description).toBeNull();
      expect(got.settings).toEqual({});
      expect(got.repos).toEqual([]);
      expect(got.avatar_url).toBeNull();
      expect(got.created_at).toBeTruthy();

      // Not a member → 404; malformed id → 400; valid-but-unknown UUID → 404.
      expect((await outsiderApp.request(`/api/workspaces/${ws!.id}`)).status).toBe(404);
      expect((await ownerApp.request("/api/workspaces/not-a-uuid")).status).toBe(400);
      expect(
        (await ownerApp.request("/api/workspaces/00000000-0000-0000-0000-000000000000")).status,
      ).toBe(404);

      // --- PATCH gates ---------------------------------------------------------
      // Plain member → 403 (owner/admin only); outsider → 404.
      const asPlain = await plainApp.request(`/api/workspaces/${ws!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Nope" }),
      });
      expect(asPlain.status).toBe(403);
      const asOutsider = await outsiderApp.request(`/api/workspaces/${ws!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Nope" }),
      });
      expect(asOutsider.status).toBe(404);

      // --- PATCH rename as owner ----------------------------------------------
      const rename = await ownerApp.request(`/api/workspaces/${ws!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed WS" }),
      });
      expect(rename.status).toBe(200);
      const renamed = (await rename.json()) as WorkspaceResp;
      expect(renamed.name).toBe("Renamed WS");
      expect(renamed.slug).toBe(`bun-wsa-${stamp}`); // slug untouched (immutable)

      // --- PATCH all fields as admin (admin allowed too) ------------------------
      const full = await adminApp.request(`/api/workspaces/${ws!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "the team",
          context: "ship it",
          settings: { theme: "dark" },
          repos: [{ name: "multimira" }],
          issue_prefix: "abc",
          avatar_url: "https://img.example/a.png",
        }),
      });
      expect(full.status).toBe(200);
      const updated = (await full.json()) as WorkspaceResp;
      expect(updated.name).toBe("Renamed WS"); // unspecified field kept (COALESCE)
      expect(updated.description).toBe("the team");
      expect(updated.context).toBe("ship it");
      expect(updated.settings).toEqual({ theme: "dark" });
      expect(updated.repos).toEqual([{ name: "multimira" }]);
      expect(updated.issue_prefix).toBe("ABC"); // uppercased like Go
      expect(updated.avatar_url).toBe("https://img.example/a.png");

      // --- field edge semantics --------------------------------------------------
      // Empty name → 400; JSON null name → leave unchanged (Go nil pointer).
      const empty = await ownerApp.request(`/api/workspaces/${ws!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  " }),
      });
      expect(empty.status).toBe(400);
      const nullName = await ownerApp.request(`/api/workspaces/${ws!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: null, description: "kept name" }),
      });
      expect(nullName.status).toBe(200);
      expect(((await nullName.json()) as WorkspaceResp).name).toBe("Renamed WS");

      // Blank issue_prefix is silently skipped (Go), not an error.
      const blankPrefix = await ownerApp.request(`/api/workspaces/${ws!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue_prefix: "   " }),
      });
      expect(blankPrefix.status).toBe(200);
      expect(((await blankPrefix.json()) as WorkspaceResp).issue_prefix).toBe("ABC");

      // Wrong-typed string field fails the decode like Go → 400.
      const wrongType = await ownerApp.request(`/api/workspaces/${ws!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: 123 }),
      });
      expect(wrongType.status).toBe(400);

      // --- PUT is wired to the same handler (Go router wires both verbs) --------
      const put = await ownerApp.request(`/api/workspaces/${ws!.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Final Name" }),
      });
      expect(put.status).toBe(200);
      expect(((await put.json()) as WorkspaceResp).name).toBe("Final Name");

      // workspace:updated published with the full workspace payload.
      const wsUpdated = events.filter((e) => e.type === "workspace:updated");
      expect(wsUpdated.length).toBeGreaterThan(0);
      const lastPayload = wsUpdated.at(-1)!.payload as { workspace: WorkspaceResp };
      expect(lastPayload.workspace.id).toBe(ws!.id);
      expect(lastPayload.workspace.name).toBe("Final Name");
    } finally {
      unsub();
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(inArray(user.id, [owner.id, admin.id, plain.id, outsider.id]));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "workspace admin: member role change rules (owner transitions, last-owner guard)",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();

    const { user: owner } = await findOrCreateUser(db, `bun-wsr-owner-${stamp}@bytedance.com`, cfg);
    const { user: admin } = await findOrCreateUser(db, `bun-wsr-admin-${stamp}@bytedance.com`, cfg);
    const { user: plain } = await findOrCreateUser(db, `bun-wsr-plain-${stamp}@bytedance.com`, cfg);
    const { user: stranger } = await findOrCreateUser(db, `bun-wsr-out-${stamp}@bytedance.com`, cfg);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Roles WS", slug: `bun-wsr-${stamp}`, issuePrefix: "RWS" })
      .returning();
    const rows = await db
      .insert(member)
      .values([
        { workspaceId: ws!.id, userId: owner.id, role: "owner" },
        { workspaceId: ws!.id, userId: admin.id, role: "admin" },
        { workspaceId: ws!.id, userId: plain.id, role: "member" },
      ])
      .returning();
    const ownerRow = rows.find((m) => m.userId === owner.id)!;
    const adminRow = rows.find((m) => m.userId === admin.id)!;
    const plainRow = rows.find((m) => m.userId === plain.id)!;

    // A second workspace to prove cross-workspace member ids 404.
    const [ws2] = await db
      .insert(workspace)
      .values({ name: "Other WS", slug: `bun-wsr2-${stamp}`, issuePrefix: "OWS" })
      .returning();
    const [foreignRow] = await db
      .insert(member)
      .values({ workspaceId: ws2!.id, userId: stranger.id, role: "owner" })
      .returning();

    const ownerApp = appForUser(db, owner.id);
    const adminApp = appForUser(db, admin.id);
    const plainApp = appForUser(db, plain.id);
    const strangerApp = appForUser(db, stranger.id);

    const patchRole = (
      app: ReturnType<typeof appForUser>,
      memberId: string,
      body: unknown,
    ) =>
      app.request(`/api/workspaces/${ws!.id}/members/${memberId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const events: BusEvent[] = [];
    const unsub = bus.subscribe(ws!.id, (e) => events.push(e));

    try {
      // Plain member (not owner/admin) → 403 at the route gate.
      expect((await patchRole(plainApp, plainRow.id, { role: "admin" })).status).toBe(403);
      // Non-member of the workspace → 404 (foreign access).
      expect((await patchRole(strangerApp, plainRow.id, { role: "admin" })).status).toBe(404);

      // Owner promotes member → admin; response is the joined member+user shape.
      const promote = await patchRole(ownerApp, plainRow.id, { role: "admin" });
      expect(promote.status).toBe(200);
      const promoted = (await promote.json()) as MemberResp;
      expect(promoted.id).toBe(plainRow.id);
      expect(promoted.role).toBe("admin");
      expect(promoted.user_id).toBe(plain.id);
      expect(promoted.email).toBe(`bun-wsr-plain-${stamp}@bytedance.com`);
      expect(promoted.name).toBeTruthy();
      expect(promoted.workspace_id).toBe(ws!.id);

      // member:updated published with the member payload.
      const memberUpdated = events.filter((e) => e.type === "member:updated");
      expect(memberUpdated.length).toBe(1);
      expect((memberUpdated[0]!.payload as { member: MemberResp }).member.role).toBe("admin");

      // Admin may manage non-owner roles: demote that admin back to member.
      expect((await patchRole(adminApp, plainRow.id, { role: "member" })).status).toBe(200);

      // Admin may NOT touch owner transitions, in either direction.
      expect((await patchRole(adminApp, plainRow.id, { role: "owner" })).status).toBe(403);
      expect((await patchRole(adminApp, ownerRow.id, { role: "member" })).status).toBe(403);

      // Sole owner cannot demote themselves (last-owner guard).
      const soleDemote = await patchRole(ownerApp, ownerRow.id, { role: "member" });
      expect(soleDemote.status).toBe(400);
      expect(((await soleDemote.json()) as { error: string }).error).toBe(
        "workspace must have at least one owner",
      );

      // Owner promotes a second owner, then may step down.
      expect((await patchRole(ownerApp, plainRow.id, { role: "owner" })).status).toBe(200);
      expect((await patchRole(ownerApp, ownerRow.id, { role: "member" })).status).toBe(200);

      // Body validation (as the remaining owner: plain).
      expect((await patchRole(plainApp, adminRow.id, {})).status).toBe(400); // role required
      expect((await patchRole(plainApp, adminRow.id, { role: "  " })).status).toBe(400);
      expect((await patchRole(plainApp, adminRow.id, { role: "superadmin" })).status).toBe(400);
      expect((await patchRole(plainApp, "not-a-uuid", { role: "member" })).status).toBe(400);

      // Member id from another workspace → 404 "member not found".
      const crossWs = await patchRole(plainApp, foreignRow!.id, { role: "member" });
      expect(crossWs.status).toBe(404);
      expect(((await crossWs.json()) as { error: string }).error).toBe("member not found");
    } finally {
      unsub();
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws2!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws2!.id));
      await db.delete(user).where(inArray(user.id, [owner.id, admin.id, plain.id, stranger.id]));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "workspace admin: remove member + leave (membership removed, guards enforced)",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();

    const { user: owner } = await findOrCreateUser(db, `bun-wsl-owner-${stamp}@bytedance.com`, cfg);
    const { user: admin } = await findOrCreateUser(db, `bun-wsl-admin-${stamp}@bytedance.com`, cfg);
    const { user: p1 } = await findOrCreateUser(db, `bun-wsl-p1-${stamp}@bytedance.com`, cfg);
    const { user: p2 } = await findOrCreateUser(db, `bun-wsl-p2-${stamp}@bytedance.com`, cfg);
    const { user: stranger } = await findOrCreateUser(db, `bun-wsl-out-${stamp}@bytedance.com`, cfg);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Leave WS", slug: `bun-wsl-${stamp}`, issuePrefix: "LWS" })
      .returning();
    const rows = await db
      .insert(member)
      .values([
        { workspaceId: ws!.id, userId: owner.id, role: "owner" },
        { workspaceId: ws!.id, userId: admin.id, role: "admin" },
        { workspaceId: ws!.id, userId: p1.id, role: "member" },
        { workspaceId: ws!.id, userId: p2.id, role: "member" },
      ])
      .returning();
    const ownerRow = rows.find((m) => m.userId === owner.id)!;
    const p1Row = rows.find((m) => m.userId === p1.id)!;

    const ownerApp = appForUser(db, owner.id);
    const adminApp = appForUser(db, admin.id);
    const p2App = appForUser(db, p2.id);
    const strangerApp = appForUser(db, stranger.id);

    const events: BusEvent[] = [];
    const unsub = bus.subscribe(ws!.id, (e) => events.push(e));

    try {
      // Admin kicks a plain member → 204; membership row gone.
      const kick = await adminApp.request(`/api/workspaces/${ws!.id}/members/${p1Row.id}`, {
        method: "DELETE",
      });
      expect(kick.status).toBe(204);
      expect((await db.select().from(member).where(eq(member.id, p1Row.id))).length).toBe(0);

      const removed = events.filter((e) => e.type === "member:removed");
      expect(removed.length).toBe(1);
      expect(removed[0]!.payload).toEqual({
        member_id: p1Row.id,
        workspace_id: ws!.id,
        user_id: p1.id,
      });

      // Admin cannot kick an owner → 403.
      expect(
        (
          await adminApp.request(`/api/workspaces/${ws!.id}/members/${ownerRow.id}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(403);

      // Owner cannot kick themselves while sole owner → 400 (last-owner guard).
      const selfKick = await ownerApp.request(`/api/workspaces/${ws!.id}/members/${ownerRow.id}`, {
        method: "DELETE",
      });
      expect(selfKick.status).toBe(400);

      // Sole owner cannot leave → 400.
      const ownerLeave = await ownerApp.request(`/api/workspaces/${ws!.id}/leave`, {
        method: "POST",
      });
      expect(ownerLeave.status).toBe(400);
      expect(((await ownerLeave.json()) as { error: string }).error).toBe(
        "workspace must have at least one owner",
      );

      // Plain member leaves → 204; row gone.
      const leave = await p2App.request(`/api/workspaces/${ws!.id}/leave`, { method: "POST" });
      expect(leave.status).toBe(204);
      expect(
        (await db.select().from(member).where(eq(member.userId, p2.id))).filter(
          (m) => m.workspaceId === ws!.id,
        ).length,
      ).toBe(0);

      // Non-member leave → 404; malformed/cross checks on DELETE.
      expect(
        (await strangerApp.request(`/api/workspaces/${ws!.id}/leave`, { method: "POST" })).status,
      ).toBe(404);
      expect(
        (
          await ownerApp.request(`/api/workspaces/${ws!.id}/members/nope`, { method: "DELETE" })
        ).status,
      ).toBe(400);
      expect(
        (
          await ownerApp.request(`/api/workspaces/${ws!.id}/members/${p1Row.id}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(404); // already removed → member not found
    } finally {
      unsub();
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db
        .delete(user)
        .where(inArray(user.id, [owner.id, admin.id, p1.id, p2.id, stranger.id]));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "workspace admin: leave revokes runtimes (agents archived, tasks cancelled, tokens deleted)",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();

    const { user: owner } = await findOrCreateUser(db, `bun-wrv-owner-${stamp}@bytedance.com`, cfg);
    const { user: leaver } = await findOrCreateUser(db, `bun-wrv-leaver-${stamp}@bytedance.com`, cfg);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Revoke WS", slug: `bun-wrv-${stamp}`, issuePrefix: "RVW" })
      .returning();
    const rows = await db
      .insert(member)
      .values([
        { workspaceId: ws!.id, userId: owner.id, role: "owner" },
        { workspaceId: ws!.id, userId: leaver.id, role: "member" },
      ])
      .returning();
    const leaverRow = rows.find((m) => m.userId === leaver.id)!;

    const daemonId = `bun-wrv-daemon-${stamp}`;
    const tokenHash = `bun-wrv-hash-${stamp}`;
    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "Leaver Runtime",
        runtimeMode: "local",
        provider: "codex",
        status: "online",
        ownerId: leaver.id,
        daemonId,
      })
      .returning();
    const [ag] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: `Leaver Agent ${stamp}`,
        runtimeMode: "local",
        runtimeId: rt!.id,
        ownerId: leaver.id,
      })
      .returning();
    const [task] = await db
      .insert(agentTaskQueue)
      .values({ agentId: ag!.id, runtimeId: rt!.id, status: "queued" })
      .returning();
    await db.insert(daemonToken).values({
      tokenHash,
      workspaceId: ws!.id,
      daemonId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const leaverApp = appForUser(db, leaver.id);
    const events: BusEvent[] = [];
    const unsub = bus.subscribe(ws!.id, (e) => events.push(e));

    try {
      const res = await leaverApp.request(`/api/workspaces/${ws!.id}/leave`, { method: "POST" });
      expect(res.status).toBe(204);

      // Membership gone.
      expect((await db.select().from(member).where(eq(member.id, leaverRow.id))).length).toBe(0);

      // Runtime forced offline.
      const [rtAfter] = await db.select().from(agentRuntime).where(eq(agentRuntime.id, rt!.id));
      expect(rtAfter!.status).toBe("offline");

      // Agent archived by the leaver themselves.
      const [agAfter] = await db.select().from(agent).where(eq(agent.id, ag!.id));
      expect(agAfter!.archivedAt).not.toBeNull();
      expect(agAfter!.archivedBy).toBe(leaver.id);

      // Active task cancelled (not failed) with completed_at stamped.
      const [taskAfter] = await db
        .select()
        .from(agentTaskQueue)
        .where(eq(agentTaskQueue.id, task!.id));
      expect(taskAfter!.status).toBe("cancelled");
      expect(taskAfter!.completedAt).not.toBeNull();

      // Daemon token deleted.
      expect(
        (await db.select().from(daemonToken).where(eq(daemonToken.tokenHash, tokenHash))).length,
      ).toBe(0);

      // Event fanout in the Go publishRevocation order:
      // task:cancelled → agent:archived → daemon:register → member:removed.
      const types = events.map((e) => e.type);
      const iTask = types.indexOf("task:cancelled");
      const iAgent = types.indexOf("agent:archived");
      const iDaemon = types.indexOf("daemon:register");
      const iMember = types.indexOf("member:removed");
      expect(iTask).toBeGreaterThanOrEqual(0);
      expect(iAgent).toBeGreaterThan(iTask);
      expect(iDaemon).toBeGreaterThan(iAgent);
      expect(iMember).toBeGreaterThan(iDaemon);

      const agentEvt = events[iAgent]!.payload as { agent: { id: string; archived_by: string } };
      expect(agentEvt.agent.id).toBe(ag!.id);
      expect(agentEvt.agent.archived_by).toBe(leaver.id);
      expect(events[iDaemon]!.payload).toEqual({ action: "revoke" });
      const taskEvt = events[iTask]!.payload as { task_id: string; status: string };
      expect(taskEvt.task_id).toBe(task!.id);
      expect(taskEvt.status).toBe("cancelled");
    } finally {
      unsub();
      await db.delete(daemonToken).where(eq(daemonToken.tokenHash, tokenHash));
      await db.delete(agentTaskQueue).where(eq(agentTaskQueue.id, task!.id));
      await db.delete(agent).where(eq(agent.id, ag!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.id, rt!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(inArray(user.id, [owner.id, leaver.id]));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "workspace admin: delete workspace is owner-only and cascades",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();

    const { user: owner } = await findOrCreateUser(db, `bun-wsd-owner-${stamp}@bytedance.com`, cfg);
    const { user: admin } = await findOrCreateUser(db, `bun-wsd-admin-${stamp}@bytedance.com`, cfg);
    const { user: plain } = await findOrCreateUser(db, `bun-wsd-plain-${stamp}@bytedance.com`, cfg);
    const { user: stranger } = await findOrCreateUser(db, `bun-wsd-out-${stamp}@bytedance.com`, cfg);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Doomed WS", slug: `bun-wsd-${stamp}`, issuePrefix: "DWS" })
      .returning();
    await db.insert(member).values([
      { workspaceId: ws!.id, userId: owner.id, role: "owner" },
      { workspaceId: ws!.id, userId: admin.id, role: "admin" },
      { workspaceId: ws!.id, userId: plain.id, role: "member" },
    ]);

    const ownerApp = appForUser(db, owner.id);
    const adminApp = appForUser(db, admin.id);
    const plainApp = appForUser(db, plain.id);
    const strangerApp = appForUser(db, stranger.id);

    const events: BusEvent[] = [];
    const unsub = bus.subscribe(ws!.id, (e) => events.push(e));

    try {
      // Admin and plain member are 403 (owner-only); outsider 404; malformed 400.
      expect(
        (await adminApp.request(`/api/workspaces/${ws!.id}`, { method: "DELETE" })).status,
      ).toBe(403);
      expect(
        (await plainApp.request(`/api/workspaces/${ws!.id}`, { method: "DELETE" })).status,
      ).toBe(403);
      expect(
        (await strangerApp.request(`/api/workspaces/${ws!.id}`, { method: "DELETE" })).status,
      ).toBe(404);
      expect(
        (await ownerApp.request("/api/workspaces/garbage", { method: "DELETE" })).status,
      ).toBe(400);

      // Owner deletes → 204; workspace + member rows gone (DB CASCADE).
      const del = await ownerApp.request(`/api/workspaces/${ws!.id}`, { method: "DELETE" });
      expect(del.status).toBe(204);
      expect((await db.select().from(workspace).where(eq(workspace.id, ws!.id))).length).toBe(0);
      expect((await db.select().from(member).where(eq(member.workspaceId, ws!.id))).length).toBe(0);

      const deleted = events.filter((e) => e.type === "workspace:deleted");
      expect(deleted.length).toBe(1);
      expect(deleted[0]!.payload).toEqual({ workspace_id: ws!.id });
    } finally {
      unsub();
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(inArray(user.id, [owner.id, admin.id, plain.id, stranger.id]));
      await close();
    }
  },
);
