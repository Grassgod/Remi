/**
 * Lark installations list endpoint tests — DB-gated. Drives the standalone
 * larkInstallationsRoutes(db) factory (absolute path, mounted at "/").
 *
 * The crucial behavior: with no Feishu at-rest key configured the endpoint
 * returns an EMPTY list ({installations: [], configured: false}) — never an
 * error — so the Integrations tab renders for every deployment. With the key
 * set, rows come back in Go's LarkInstallationResponse shape (snake_case,
 * tenant_key omitted when NULL, no app_secret_encrypted leak).
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { larkInstallationsRoutes } from "../src/http/routes/larkInstallations.js";
import type { AppEnv } from "../src/http/types.js";
import {
  user,
  member,
  workspace,
  agent,
  agentRuntime,
  larkInstallation,
} from "../src/db/schema.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const ENV_KEY = "MULTIMIRA_LARK_SECRET_KEY";

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip when no DB */
}

test.skipIf(!reachable)(
  "lark installations: unconfigured -> empty list (not an error); configured -> rows in Go shape",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();
    const originalEnv = process.env[ENV_KEY];

    // FK order: workspace -> member -> agent_runtime -> agent -> installation.
    const [u] = await db
      .insert(user)
      .values({ email: `bun-larkinst-${stamp}@bytedance.com`, name: "Lark Tester" })
      .returning();
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Lark WS", slug: `bun-larkinst-${stamp}`, issuePrefix: "LRK" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u!.id, role: "member" });
    const [rt] = await db
      .insert(agentRuntime)
      .values({ workspaceId: ws!.id, name: "rt", runtimeMode: "local", provider: "claude" })
      .returning();
    const [a] = await db
      .insert(agent)
      .values({ workspaceId: ws!.id, name: "Feishu Bot Agent", runtimeMode: "local", runtimeId: rt!.id })
      .returning();

    const app = new Hono<AppEnv>();
    app.use("*", async (c, n) => {
      c.set("user", { sub: u!.id } as AppEnv["Variables"]["user"]);
      await n();
    });
    app.route("/", larkInstallationsRoutes(db));

    const path = `/api/workspaces/${ws!.id}/lark/installations`;

    try {
      // ── No key configured → empty list, NOT an error ────────────────────
      delete process.env[ENV_KEY];
      const unconfigured = await app.request(path);
      expect(unconfigured.status).toBe(200);
      expect(await unconfigured.json()).toEqual({
        installations: [],
        configured: false,
        install_supported: false,
      });

      // ── Key configured, no rows yet → still an empty list ───────────────
      process.env[ENV_KEY] = randomBytes(32).toString("base64");
      const emptyConfigured = await app.request(path);
      expect(emptyConfigured.status).toBe(200);
      expect(await emptyConfigured.json()).toEqual({
        installations: [],
        configured: true,
        install_supported: false,
      });

      // ── A row appears in the Go wire shape ──────────────────────────────
      const [inst] = await db
        .insert(larkInstallation)
        .values({
          workspaceId: ws!.id,
          agentId: a!.id,
          appId: `cli_${stamp}`,
          appSecretEncrypted: Buffer.from("sealed-secret"),
          botOpenId: "ou_bot_test",
          installerUserId: u!.id,
        })
        .returning();
      const withRow = await app.request(path);
      expect(withRow.status).toBe(200);
      const body = (await withRow.json()) as {
        installations: Array<Record<string, unknown>>;
        configured: boolean;
        install_supported: boolean;
      };
      expect(body.configured).toBe(true);
      expect(body.install_supported).toBe(false);
      expect(body.installations.length).toBe(1);
      const row = body.installations[0]!;
      expect(row.id).toBe(inst!.id);
      expect(row.workspace_id).toBe(ws!.id);
      expect(row.agent_id).toBe(a!.id);
      expect(row.app_id).toBe(`cli_${stamp}`);
      expect(row.bot_open_id).toBe("ou_bot_test");
      expect(row.installer_user_id).toBe(u!.id);
      expect(row.status).toBe("active");
      expect(row.region).toBe("feishu");
      expect(row.installed_at).toBeTruthy();
      expect(row.created_at).toBeTruthy();
      expect(row.updated_at).toBeTruthy();
      // tenant_key is omitempty (NULL here) and the encrypted secret + WS
      // lease columns must never cross the wire.
      expect("tenant_key" in row).toBe(false);
      expect("app_secret_encrypted" in row).toBe(false);
      expect("ws_lease_token" in row).toBe(false);

      // ── Gates ───────────────────────────────────────────────────────────
      const badId = await app.request("/api/workspaces/not-a-uuid/lark/installations");
      expect(badId.status).toBe(400);
      const foreign = await app.request(
        "/api/workspaces/99999999-9999-4999-8999-999999999999/lark/installations",
      );
      expect(foreign.status).toBe(404);
    } finally {
      if (originalEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = originalEnv;
      await db.delete(larkInstallation).where(eq(larkInstallation.workspaceId, ws!.id));
      await db.delete(agent).where(eq(agent.workspaceId, ws!.id));
      await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u!.id));
      await close();
    }
  },
);
