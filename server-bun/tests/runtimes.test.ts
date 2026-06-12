import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, agentRuntime } from "../src/db/schema.js";
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
  "runtimes read path: list (created_at ASC, owner filter) + get by UUID, workspace-scoped",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-rt-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Runtime WS", slug: `bun-rt-${stamp}`, issuePrefix: "RNT" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    // Two runtimes: one owned by the caller (claude), one unowned (codex).
    // Insert the owned one second but with an explicitly older created_at so we
    // can assert ASC ordering (oldest first), independent of insert order.
    const [owned] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "My Mac",
        runtimeMode: "local",
        provider: "claude",
        status: "online",
        deviceInfo: "macOS",
        metadata: { arch: "arm64" },
        ownerId: u.id,
        visibility: "private",
        createdAt: "2020-01-01T00:00:00.000Z",
      })
      .returning();
    const [unowned] = await db
      .insert(agentRuntime)
      .values({
        workspaceId: ws!.id,
        name: "Shared Box",
        runtimeMode: "local",
        provider: "codex",
        status: "offline",
        visibility: "public",
        createdAt: "2021-01-01T00:00:00.000Z",
      })
      .returning();

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // list → bare array, oldest first (created_at ASC)
      const listRes = await app.request("/api/runtimes", { headers: auth });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as Array<{
        id: string;
        name: string;
        workspace_id: string;
        provider: string;
        launch_header: string;
        status: string;
        device_info: string;
        metadata: Record<string, unknown>;
        owner_id: string | null;
        visibility: string;
        daemon_id: string | null;
        last_seen_at: string | null;
      }>;
      expect(body.length).toBe(2);
      expect(body[0]!.id).toBe(owned!.id); // 2020 < 2021
      expect(body[1]!.id).toBe(unowned!.id);

      const ownedResp = body.find((rt) => rt.id === owned!.id)!;
      expect(ownedResp.name).toBe("My Mac");
      expect(ownedResp.workspace_id).toBe(ws!.id);
      expect(ownedResp.provider).toBe("claude");
      expect(ownedResp.launch_header).toBe("claude (stream-json)");
      expect(ownedResp.status).toBe("online");
      expect(ownedResp.device_info).toBe("macOS");
      expect(ownedResp.metadata).toEqual({ arch: "arm64" });
      expect(ownedResp.owner_id).toBe(u.id);
      expect(ownedResp.visibility).toBe("private");
      expect(ownedResp.daemon_id).toBeNull();
      expect(ownedResp.last_seen_at).toBeNull();

      // unowned runtime: metadata defaults to {}, codex launch header
      const unownedResp = body.find((rt) => rt.id === unowned!.id)!;
      expect(unownedResp.launch_header).toBe("codex app-server");
      expect(unownedResp.metadata).toEqual({});
      expect(unownedResp.owner_id).toBeNull();

      // ?owner=me → only the caller's runtime
      const mineRes = await app.request("/api/runtimes?owner=me", { headers: auth });
      expect(mineRes.status).toBe(200);
      const mineBody = (await mineRes.json()) as Array<{ id: string }>;
      expect(mineBody.length).toBe(1);
      expect(mineBody[0]!.id).toBe(owned!.id);

      // get by UUID → bare AgentRuntimeResponse
      const getRes = await app.request(`/api/runtimes/${owned!.id}`, { headers: auth });
      expect(getRes.status).toBe(200);
      const one = (await getRes.json()) as { id: string; name: string; launch_header: string };
      expect(one.id).toBe(owned!.id);
      expect(one.name).toBe("My Mac");
      expect(one.launch_header).toBe("claude (stream-json)");

      // unknown UUID → 404
      const missing = await app.request(
        "/api/runtimes/11111111-1111-4111-8111-111111111111",
        { headers: auth },
      );
      expect(missing.status).toBe(404);

      // malformed id → 400
      const bad = await app.request("/api/runtimes/not-a-uuid", { headers: auth });
      expect(bad.status).toBe(400);

      // missing workspace header → 400
      const noWs = await app.request("/api/runtimes", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // a member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/runtimes", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);
    } finally {
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
