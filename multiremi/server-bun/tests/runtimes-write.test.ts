import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, agent, agentRuntime } from "../src/db/schema.js";
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

type RuntimeResp = {
  id: string;
  workspace_id: string;
  name: string;
  runtime_mode: string;
  provider: string;
  status: string;
  device_info: string;
  owner_id: string | null;
  visibility: string;
};

test.skipIf(!reachable)(
  "POST /api/runtimes registers a workspace runtime owned by the caller",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rtc-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "RT Create", slug: `bun-rtc-${stamp}`, issuePrefix: "RTC" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    try {
      const res = await app.request("/api/runtimes", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "My Mac",
          runtime_mode: "local",
          provider: "claude",
          device_info: "MacBook Pro",
        }),
      });
      expect(res.status).toBe(201);
      const rt = (await res.json()) as RuntimeResp;
      expect(rt.name).toBe("My Mac");
      expect(rt.runtime_mode).toBe("local");
      expect(rt.provider).toBe("claude");
      expect(rt.device_info).toBe("MacBook Pro");
      expect(rt.workspace_id).toBe(ws!.id);
      expect(rt.owner_id).toBe(u.id);
      // A freshly-registered runtime starts offline (schema default) until a
      // heartbeat marks it online.
      expect(rt.status).toBe("offline");
      expect(rt.visibility).toBe("private");

      // It is now listed for the workspace.
      const listRes = await app.request("/api/runtimes", { headers: auth });
      const list = (await listRes.json()) as RuntimeResp[];
      expect(list.some((x) => x.id === rt.id)).toBe(true);

      // missing name → 400
      const noName = await app.request("/api/runtimes", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ runtime_mode: "local", provider: "claude" }),
      });
      expect(noName.status).toBe(400);

      // bad runtime_mode → 400 (CHECK constraint values local|cloud)
      const badMode = await app.request("/api/runtimes", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "x", runtime_mode: "remote", provider: "claude" }),
      });
      expect(badMode.status).toBe(400);

      // missing provider → 400
      const noProvider = await app.request("/api/runtimes", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "x", runtime_mode: "cloud" }),
      });
      expect(noProvider.status).toBe(400);
    } finally {
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "PUT /api/runtimes/:id updates name/visibility/status (partial), 400 on bad values",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rtu-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "RT Update", slug: `bun-rtu-${stamp}`, issuePrefix: "RTU" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "orig",
        runtimeMode: "local",
        provider: "claude",
        ownerId: u.id,
      })
      .returning();
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": ws!.id,
      "Content-Type": "application/json",
    };

    try {
      // partial update: change name + visibility, leave status untouched
      const upd = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ name: "renamed", visibility: "public" }),
      });
      expect(upd.status).toBe(200);
      const after = (await upd.json()) as RuntimeResp;
      expect(after.name).toBe("renamed");
      expect(after.visibility).toBe("public");
      expect(after.status).toBe("offline"); // untouched field preserved

      // update status
      const statusUpd = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ status: "online" }),
      });
      expect(statusUpd.status).toBe(200);
      expect(((await statusUpd.json()) as RuntimeResp).status).toBe("online");

      // bad visibility → 400
      const badVis = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ visibility: "secret" }),
      });
      expect(badVis.status).toBe(400);

      // bad status → 400
      const badStatus = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ status: "busy" }),
      });
      expect(badStatus.status).toBe(400);

      // empty name → 400
      const emptyName = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ name: "   " }),
      });
      expect(emptyName.status).toBe(400);

      // unknown id → 404
      const missing = await app.request(
        "/api/runtimes/99999999-9999-4999-8999-999999999999",
        { method: "PUT", headers: auth, body: JSON.stringify({ name: "x" }) },
      );
      expect(missing.status).toBe(404);
    } finally {
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "DELETE /api/runtimes/:id removes a runtime (204), then 404",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rtd-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "RT Delete", slug: `bun-rtd-${stamp}`, issuePrefix: "RTD" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "to-delete",
        runtimeMode: "cloud",
        provider: "codex",
        ownerId: u.id,
      })
      .returning();
    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      const del = await app.request(`/api/runtimes/${rt!.id}`, { method: "DELETE", headers: auth });
      expect(del.status).toBe(204);

      const gone = await app.request(`/api/runtimes/${rt!.id}`, { headers: auth });
      expect(gone.status).toBe(404);

      // deleting again → 404
      const delAgain = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "DELETE",
        headers: auth,
      });
      expect(delAgain.status).toBe(404);
    } finally {
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "a runtime with a bound agent: write fixture FK references a real runtime row",
  async () => {
    // This exercises the agent.runtime_id NOT-NULL FK: an agent must reference a
    // real agent_runtime row. We insert the runtime first, then the agent, and
    // clean up children (agent) before parents (runtime) in finally.
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rtf-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const [ws] = await db
      .insert(workspace)
      .values({ name: "RT FK", slug: `bun-rtf-${stamp}`, issuePrefix: "RTF" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "host runtime",
        runtimeMode: "local",
        provider: "claude",
        ownerId: u.id,
      })
      .returning();
    // agent.runtime_id → real runtime; runtime_mode CHECK ∈ {local,cloud}.
    const [ag] = await db
      .insert(agent)
      .values({
        workspaceId: ws!.id,
        name: `Agent ${stamp}`,
        runtimeMode: "local",
        runtimeId: rt!.id,
        ownerId: u.id,
      })
      .returning();
    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    const events: string[] = [];
    const unsub = bus.subscribe(ws!.id, (e) => events.push(e.type));
    try {
      // The runtime is visible and updatable while an agent is bound to it.
      const get = await app.request(`/api/runtimes/${rt!.id}`, { headers: auth });
      expect(get.status).toBe(200);
      expect(((await get.json()) as RuntimeResp).id).toBe(rt!.id);

      const upd = await app.request(`/api/runtimes/${rt!.id}`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(upd.status).toBe(200);
      expect(events).toContain("runtime.updated");
    } finally {
      unsub();
      // Children (agent) before parents (runtime) — agent.runtime_id is
      // ON DELETE RESTRICT, so the runtime cannot drop while the agent exists.
      await db.delete(agent).where(eq(agent.id, ag!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
