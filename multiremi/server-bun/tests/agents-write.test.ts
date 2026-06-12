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

/**
 * Stand up a workspace with an owner member and one agent_runtime row, so the
 * agent.runtime_id FK (→ agent_runtime, ON DELETE RESTRICT) always references a
 * real row. runtime_mode is CHECK-constrained to {local, cloud}; provider is
 * NOT NULL but unconstrained. Returns the auth headers + ids the tests need.
 */
async function setup(db: ReturnType<typeof createDb>["db"], slugTag: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { user: u } = await findOrCreateUser(db, `bun-${slugTag}-${stamp}@bytedance.com`, cfg);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const [ws] = await db
    .insert(workspace)
    .values({ name: `Agent WS ${slugTag}`, slug: `bun-${slugTag}-${stamp}`, issuePrefix: "AGT" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({
      workspaceId: ws!.id,
      name: "Local Runtime",
      runtimeMode: "local", // CHECK: must be 'local' | 'cloud'
      provider: "claude",
      ownerId: u.id,
    })
    .returning();
  const auth = {
    Authorization: `Bearer ${token}`,
    "X-Workspace-ID": ws!.id,
    "Content-Type": "application/json",
  };
  return { u, ws: ws!, rt: rt!, auth };
}

/** Tear down children before parents: agent → agent_runtime → member → workspace → user. */
async function cleanup(db: ReturnType<typeof createDb>["db"], wsId: string, userId: string) {
  await db.delete(agent).where(eq(agent.workspaceId, wsId));
  await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, wsId));
  await db.delete(member).where(eq(member.workspaceId, wsId));
  await db.delete(workspace).where(eq(workspace.id, wsId));
  await db.delete(user).where(eq(user.id, userId));
}

test.skipIf(!reachable)(
  "POST /api/agents creates a workspace-scoped agent (owner, runtime_mode copied, jsonb defaults)",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const { u, ws, rt, auth } = await setup(db, "agc");
    try {
      const res = await app.request("/api/agents", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "Builder",
          instructions: "Do the thing",
          runtime_id: rt.id,
          custom_args: ["--flag"],
          custom_env: { TOKEN: "secret" },
          model: "claude-sonnet",
        }),
      });
      expect(res.status).toBe(201);
      const a = (await res.json()) as {
        id: string;
        workspace_id: string;
        runtime_id: string;
        owner_id: string;
        runtime_mode: string;
        visibility: string;
        max_concurrent_tasks: number;
        name: string;
        instructions: string;
        model: string;
        custom_args: string[];
        has_custom_env: boolean;
        custom_env_key_count: number;
        runtime_config: Record<string, unknown>;
        archived_at: string | null;
      };
      expect(a.name).toBe("Builder");
      expect(a.instructions).toBe("Do the thing");
      expect(a.workspace_id).toBe(ws.id);
      expect(a.runtime_id).toBe(rt.id);
      expect(a.owner_id).toBe(u.id); // creator/owner = requesting user
      expect(a.runtime_mode).toBe("local"); // copied from the runtime
      expect(a.visibility).toBe("private"); // default
      expect(a.max_concurrent_tasks).toBe(6); // default
      expect(a.model).toBe("claude-sonnet");
      expect(a.custom_args).toEqual(["--flag"]);
      // custom_env values are never serialized — only coarse metadata (MUL-2600).
      expect(a.has_custom_env).toBe(true);
      expect(a.custom_env_key_count).toBe(1);
      expect(a.runtime_config).toEqual({});
      expect(a.archived_at).toBeNull();

      // the row actually persisted
      const [row] = await db.select().from(agent).where(eq(agent.id, a.id));
      expect(row?.name).toBe("Builder");
    } finally {
      await cleanup(db, ws.id, u.id);
      await close();
    }
  },
);

test.skipIf(!reachable)("POST /api/agents validation: name + runtime_id required, runtime must exist in ws", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const { u, ws, rt, auth } = await setup(db, "agv");
  try {
    // missing name → 400
    const noName = await app.request("/api/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ runtime_id: rt.id }),
    });
    expect(noName.status).toBe(400);

    // missing runtime_id → 400
    const noRt = await app.request("/api/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "X" }),
    });
    expect(noRt.status).toBe(400);

    // runtime_id that doesn't exist in this workspace → 400
    const badRt = await app.request("/api/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "X", runtime_id: "99999999-9999-4999-8999-999999999999" }),
    });
    expect(badRt.status).toBe(400);

    // missing workspace header → 400; foreign workspace → 404 (multi-tenancy gate)
    const noWs = await app.request("/api/agents", {
      method: "POST",
      headers: { Authorization: auth.Authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X", runtime_id: rt.id }),
    });
    expect(noWs.status).toBe(400);
    const foreign = await app.request("/api/agents", {
      method: "POST",
      headers: {
        Authorization: auth.Authorization,
        "Content-Type": "application/json",
        "X-Workspace-ID": "99999999-9999-4999-8999-999999999999",
      },
      body: JSON.stringify({ name: "X", runtime_id: rt.id }),
    });
    expect(foreign.status).toBe(404);
  } finally {
    await cleanup(db, ws.id, u.id);
    await close();
  }
});

test.skipIf(!reachable)("PUT /api/agents/:id partially updates; untouched fields preserved", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const { u, ws, rt, auth } = await setup(db, "agu");
  try {
    const created = (await (
      await app.request("/api/agents", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "orig", instructions: "keep me", runtime_id: rt.id }),
      })
    ).json()) as { id: string };

    const upd = await app.request(`/api/agents/${created.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "renamed", max_concurrent_tasks: 3 }),
    });
    expect(upd.status).toBe(200);
    const after = (await upd.json()) as {
      name: string;
      instructions: string;
      max_concurrent_tasks: number;
      runtime_id: string;
    };
    expect(after.name).toBe("renamed");
    expect(after.max_concurrent_tasks).toBe(3);
    expect(after.instructions).toBe("keep me"); // untouched field preserved
    expect(after.runtime_id).toBe(rt.id); // untouched

    // not found → 404
    const gone = await app.request("/api/agents/99999999-9999-4999-8999-999999999999", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "nope" }),
    });
    expect(gone.status).toBe(404);
  } finally {
    await cleanup(db, ws.id, u.id);
    await close();
  }
});

test.skipIf(!reachable)("POST /api/agents/:id/archive sets archived_at/archived_by; 409 when already archived", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const { u, ws, rt, auth } = await setup(db, "aga");
  try {
    const created = (await (
      await app.request("/api/agents", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "to-archive", runtime_id: rt.id }),
      })
    ).json()) as { id: string };

    const arch = await app.request(`/api/agents/${created.id}/archive`, {
      method: "POST",
      headers: auth,
    });
    expect(arch.status).toBe(200);
    const a = (await arch.json()) as { archived_at: string | null; archived_by: string | null };
    expect(a.archived_at).not.toBeNull();
    expect(a.archived_by).toBe(u.id);

    // archiving again → 409
    const again = await app.request(`/api/agents/${created.id}/archive`, {
      method: "POST",
      headers: auth,
    });
    expect(again.status).toBe(409);

    // archived agent is excluded from the default list, included with ?include_archived
    const def = (await (await app.request("/api/agents", { headers: auth })).json()) as Array<{
      id: string;
    }>;
    expect(def.some((x) => x.id === created.id)).toBe(false);
    const all = (await (
      await app.request("/api/agents?include_archived=true", { headers: auth })
    ).json()) as Array<{ id: string }>;
    expect(all.some((x) => x.id === created.id)).toBe(true);
  } finally {
    await cleanup(db, ws.id, u.id);
    await close();
  }
});

test.skipIf(!reachable)("create + update emit agent.created / agent.updated on the realtime bus", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const { u, ws, rt, auth } = await setup(db, "agb");
  const events: string[] = [];
  const unsub = bus.subscribe(ws.id, (e) => events.push(e.type));
  try {
    const created = (await (
      await app.request("/api/agents", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "bus-agent", runtime_id: rt.id }),
      })
    ).json()) as { id: string };
    expect(events).toContain("agent.created");

    await app.request(`/api/agents/${created.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "bus-agent-2" }),
    });
    expect(events).toContain("agent.updated");
  } finally {
    unsub();
    await cleanup(db, ws.id, u.id);
    await close();
  }
});
