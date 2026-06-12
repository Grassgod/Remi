/**
 * Lark binding + installation-admin endpoints (port of the Go
 * RedeemLarkBindingToken / BeginLarkInstall / GetLarkInstallStatus /
 * RevokeLarkInstallation): token redemption writes the lark_user_binding row
 * transactionally (consume + bind commit together), the device-flow install
 * mirrors Go's not-configured 503, and revoke flips the installation row
 * without needing Feishu credentials.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { and, eq, inArray } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import type { Db } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { larkBindingRoutes } from "../src/http/routes/larkBinding.js";
import { hashBindingToken } from "../src/db/queries/larkBinding.js";
import { bus, type BusEvent } from "../src/realtime/bus.js";
import {
  user,
  member,
  workspace,
  agent,
  agentRuntime,
  larkInstallation,
  larkBindingToken,
  larkUserBinding,
} from "../src/db/schema.js";
import type { AppEnv } from "../src/http/types.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = { port: 0, jwtSecret: "x", authTokenTtlSeconds: 3600, databaseUrl: DB_URL, allowedEmailDomains: [] };

const KEY_ENV = "MULTIMIRA_LARK_SECRET_KEY";
/** Any valid base64 32-byte key — the routes only probe "is it configured". */
const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

function appFor(db: Db, sub: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => {
    c.set("user", { sub } as never);
    await n();
  });
  app.route("/", larkBindingRoutes(db));
  return app;
}

const JSON_HDR = { "Content-Type": "application/json" };

interface Fixture {
  db: Db;
  close: () => Promise<void>;
  ownerId: string;
  memberId: string;
  outsiderId: string;
  wsId: string;
  agId: string;
  installationId: string;
}

/** workspace → members (owner + plain member; outsider has NO member row) →
 *  runtime → agent → lark_installation. */
async function makeFixture(tag: string): Promise<Fixture> {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: owner } = await findOrCreateUser(db, `bun-${tag}-own-${stamp}@bytedance.com`, cfg);
  const { user: plain } = await findOrCreateUser(db, `bun-${tag}-mem-${stamp}@bytedance.com`, cfg);
  const { user: outsider } = await findOrCreateUser(db, `bun-${tag}-out-${stamp}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "LarkBind WS", slug: `bun-${tag}-${stamp}`, issuePrefix: "LB", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: owner.id, role: "owner" });
  await db.insert(member).values({ workspaceId: ws!.id, userId: plain.id, role: "member" });
  const [rt] = await db
    .insert(agentRuntime)
    .values({ workspaceId: ws!.id, name: "RT", runtimeMode: "local", provider: "codex" })
    .returning();
  const [ag] = await db
    .insert(agent)
    .values({ workspaceId: ws!.id, name: "FeishuBot", runtimeId: rt!.id, runtimeMode: "local", ownerId: owner.id })
    .returning();
  const [inst] = await db
    .insert(larkInstallation)
    .values({
      workspaceId: ws!.id,
      agentId: ag!.id,
      appId: `cli_bind_${stamp}`,
      appSecretEncrypted: Buffer.from("sealed"),
      botOpenId: "ou_bot",
      installerUserId: owner.id,
    })
    .returning();
  return {
    db,
    close,
    ownerId: owner.id,
    memberId: plain.id,
    outsiderId: outsider.id,
    wsId: ws!.id,
    agId: ag!.id,
    installationId: inst!.id,
  };
}

async function teardown(f: Fixture): Promise<void> {
  const { db } = f;
  await db.delete(larkUserBinding).where(eq(larkUserBinding.workspaceId, f.wsId));
  await db.delete(larkBindingToken).where(eq(larkBindingToken.workspaceId, f.wsId));
  await db.delete(larkInstallation).where(eq(larkInstallation.workspaceId, f.wsId));
  await db.delete(agent).where(eq(agent.workspaceId, f.wsId));
  await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, f.wsId));
  await db.delete(member).where(eq(member.workspaceId, f.wsId));
  await db.delete(workspace).where(eq(workspace.id, f.wsId));
  await db.delete(user).where(inArray(user.id, [f.ownerId, f.memberId, f.outsiderId]));
  await f.close();
}

/** Mint a binding-token row the way the Lark webhook flow would (only the
 *  SHA-256 hash is stored; the raw value is what the user's URL carries). */
async function mintToken(
  f: Fixture,
  raw: string,
  openId: string,
  expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(),
): Promise<void> {
  await f.db.insert(larkBindingToken).values({
    tokenHash: hashBindingToken(raw),
    workspaceId: f.wsId,
    installationId: f.installationId,
    larkOpenId: openId,
    expiresAt,
  });
}

test.skipIf(!reachable)("redeem: happy path binds + consumes; replay 410; same-user re-bind stays idempotent", async () => {
  const prevKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = VALID_KEY;
  const f = await makeFixture("lbh");
  try {
    const app = appFor(f.db, f.ownerId);
    const raw = `tok-happy-${Date.now()}`;
    await mintToken(f, raw, "ou_user_1");

    const res = await app.request("/api/lark/binding/redeem", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify({ token: raw }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace_id: f.wsId,
      installation_id: f.installationId,
      lark_open_id: "ou_user_1",
    });

    // The binding row landed for the session user, and the token is consumed.
    const bindings = await f.db
      .select()
      .from(larkUserBinding)
      .where(and(eq(larkUserBinding.installationId, f.installationId), eq(larkUserBinding.larkOpenId, "ou_user_1")));
    expect(bindings.length).toBe(1);
    expect(bindings[0]!.multimiraUserId).toBe(f.ownerId);
    const [tok] = await f.db
      .select()
      .from(larkBindingToken)
      .where(eq(larkBindingToken.tokenHash, hashBindingToken(raw)));
    expect(tok!.consumedAt).not.toBeNull();

    // Replaying the consumed token → 410 (single-use).
    const replay = await app.request("/api/lark/binding/redeem", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify({ token: raw }),
    });
    expect(replay.status).toBe(410);

    // A fresh token for the same (installation, open_id) redeemed by the SAME
    // user is an idempotent metadata refresh — still exactly one binding row.
    const raw2 = `tok-rebind-${Date.now()}`;
    await mintToken(f, raw2, "ou_user_1");
    const rebind = await app.request("/api/lark/binding/redeem", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify({ token: raw2 }),
    });
    expect(rebind.status).toBe(200);
    const after = await f.db
      .select()
      .from(larkUserBinding)
      .where(and(eq(larkUserBinding.installationId, f.installationId), eq(larkUserBinding.larkOpenId, "ou_user_1")));
    expect(after.length).toBe(1);
  } finally {
    if (prevKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prevKey;
    await teardown(f);
  }
});

test.skipIf(!reachable)("redeem: 400 missing token, 410 unknown/expired, 409 cross-user conflict (token kept), 403 non-member", async () => {
  const prevKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = VALID_KEY;
  const f = await makeFixture("lbf");
  try {
    const app = appFor(f.db, f.ownerId);
    const redeem = (a: Hono<AppEnv>, token: unknown) =>
      a.request("/api/lark/binding/redeem", {
        method: "POST",
        headers: JSON_HDR,
        body: JSON.stringify(token === undefined ? {} : { token }),
      });

    // Missing / empty token → 400; unknown token → 410 (opaque).
    expect((await redeem(app, undefined)).status).toBe(400);
    expect((await redeem(app, "")).status).toBe(400);
    expect((await redeem(app, "never-minted")).status).toBe(410);

    // Expired token → same opaque 410.
    const rawExpired = `tok-expired-${Date.now()}`;
    await mintToken(f, rawExpired, "ou_exp", new Date(Date.now() - 60 * 1000).toISOString());
    expect((await redeem(app, rawExpired)).status).toBe(410);

    // open_id already bound to a DIFFERENT user → 409, and the tx rolls back
    // so the token is NOT consumed (the rightful holder is not disrupted).
    await f.db.insert(larkUserBinding).values({
      workspaceId: f.wsId,
      multimiraUserId: f.memberId,
      installationId: f.installationId,
      larkOpenId: "ou_taken",
    });
    const rawConflict = `tok-conflict-${Date.now()}`;
    await mintToken(f, rawConflict, "ou_taken");
    expect((await redeem(app, rawConflict)).status).toBe(409);
    const [confTok] = await f.db
      .select()
      .from(larkBindingToken)
      .where(eq(larkBindingToken.tokenHash, hashBindingToken(rawConflict)));
    expect(confTok!.consumedAt).toBeNull();
    // ...and the binding still points at the original user.
    const [kept] = await f.db
      .select()
      .from(larkUserBinding)
      .where(and(eq(larkUserBinding.installationId, f.installationId), eq(larkUserBinding.larkOpenId, "ou_taken")));
    expect(kept!.multimiraUserId).toBe(f.memberId);

    // Redeemer who is not a workspace member trips the composite member FK → 403.
    const rawOutsider = `tok-outsider-${Date.now()}`;
    await mintToken(f, rawOutsider, "ou_outsider");
    expect((await redeem(appFor(f.db, f.outsiderId), rawOutsider)).status).toBe(403);
  } finally {
    if (prevKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prevKey;
    await teardown(f);
  }
});

test.skipIf(!reachable)("redeem: 503 when the at-rest key is not configured", async () => {
  const prevKey = process.env[KEY_ENV];
  delete process.env[KEY_ENV];
  const { db, close } = createDb(DB_URL);
  try {
    // No fixtures needed: the configured gate fires before any DB read.
    const app = appFor(db, "00000000-0000-4000-8000-000000000001");
    const res = await app.request("/api/lark/binding/redeem", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify({ token: "anything" }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("lark integration not configured");
  } finally {
    if (prevKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prevKey;
    await close();
  }
});

test.skipIf(!reachable)("install begin/status: admin-gated, then Go's not-configured 503 (no registration service in the Bun port)", async () => {
  const prevKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = VALID_KEY;
  const f = await makeFixture("lbi");
  try {
    const owner = appFor(f.db, f.ownerId);
    const beginUrl = `/api/workspaces/${f.wsId}/lark/install/begin?agent_id=${f.agId}&region=feishu`;
    const statusUrl = `/api/workspaces/${f.wsId}/lark/install/sess_abc/status`;

    // Admin reaches the handler → 503 "lark install not configured" for both.
    const begin = await owner.request(beginUrl, { method: "POST" });
    expect(begin.status).toBe(503);
    expect(((await begin.json()) as { error: string }).error).toBe("lark install not configured");
    const status = await owner.request(statusUrl);
    expect(status.status).toBe(503);
    expect(((await status.json()) as { error: string }).error).toBe("lark install not configured");

    // Gates fire before the 503: plain member → 403, non-member → 404,
    // malformed workspace id → 400.
    const plain = appFor(f.db, f.memberId);
    expect((await plain.request(beginUrl, { method: "POST" })).status).toBe(403);
    expect((await plain.request(statusUrl)).status).toBe(403);
    const outsider = appFor(f.db, f.outsiderId);
    expect((await outsider.request(beginUrl, { method: "POST" })).status).toBe(404);
    expect((await outsider.request(statusUrl)).status).toBe(404);
    expect((await owner.request("/api/workspaces/nope/lark/install/begin", { method: "POST" })).status).toBe(400);
  } finally {
    if (prevKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prevKey;
    await teardown(f);
  }
});

test.skipIf(!reachable)("revoke: flips status + publishes; tenant-scoped 404; role gate; 503 unconfigured", async () => {
  const prevKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = VALID_KEY;
  const f = await makeFixture("lbr");
  // A second workspace owned by the plain member — used to prove an admin of
  // ANOTHER workspace cannot revoke this one's installation by guessing its id.
  const [ws2] = await f.db
    .insert(workspace)
    .values({ name: "Other WS", slug: `bun-lbr2-${Date.now()}`, issuePrefix: "LB2", issueCounter: 0 })
    .returning();
  await f.db.insert(member).values({ workspaceId: ws2!.id, userId: f.memberId, role: "owner" });
  const events: BusEvent[] = [];
  const unsub = bus.subscribe(f.wsId, (e) => events.push(e));
  try {
    const owner = appFor(f.db, f.ownerId);
    const url = `/api/workspaces/${f.wsId}/lark/installations/${f.installationId}`;

    // Plain member (non-admin) → 403; cross-tenant admin → 404; bad id → 400;
    // unknown id → 404. The row is untouched throughout.
    const plain = appFor(f.db, f.memberId);
    expect((await plain.request(url, { method: "DELETE" })).status).toBe(403);
    const crossTenant = await plain.request(
      `/api/workspaces/${ws2!.id}/lark/installations/${f.installationId}`,
      { method: "DELETE" },
    );
    expect(crossTenant.status).toBe(404);
    expect((await owner.request(`/api/workspaces/${f.wsId}/lark/installations/nope`, { method: "DELETE" })).status).toBe(400);
    expect(
      (
        await owner.request(`/api/workspaces/${f.wsId}/lark/installations/00000000-0000-4000-8000-000000000000`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    const [untouched] = await f.db.select().from(larkInstallation).where(eq(larkInstallation.id, f.installationId));
    expect(untouched!.status).toBe("active");

    // Without the at-rest key the integration is off → 503 (mirrors Go's
    // nil InstallationService), and nothing is revoked.
    delete process.env[KEY_ENV];
    expect((await owner.request(url, { method: "DELETE" })).status).toBe(503);
    process.env[KEY_ENV] = VALID_KEY;

    // The real revoke: 204, row flipped (kept for audit), event published.
    const res = await owner.request(url, { method: "DELETE" });
    expect(res.status).toBe(204);
    const [after] = await f.db.select().from(larkInstallation).where(eq(larkInstallation.id, f.installationId));
    expect(after!.status).toBe("revoked");
    const revokedEvents = events.filter((e) => e.type === "lark_installation:revoked");
    expect(revokedEvents.length).toBe(1);
    expect(revokedEvents[0]!.payload).toEqual({ id: f.installationId });

    // Idempotent surface: the row still exists, so a second revoke is 204 again.
    expect((await owner.request(url, { method: "DELETE" })).status).toBe(204);
  } finally {
    unsub();
    if (prevKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prevKey;
    await f.db.delete(member).where(eq(member.workspaceId, ws2!.id));
    await f.db.delete(workspace).where(eq(workspace.id, ws2!.id));
    await teardown(f);
  }
});
