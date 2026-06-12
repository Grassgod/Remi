import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, issueLabel } from "../src/db/schema.js";
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

test.skipIf(!reachable)("labels read path: list ordered by lower(name), workspace-scoped", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-lbl-${stamp}@bytedance.com`, cfg);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

  const [ws] = await db
    .insert(workspace)
    .values({ name: "Label WS", slug: `bun-lbl-${stamp}`, issuePrefix: "LBL" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

  // Insert out of alphabetical order to prove the LOWER(name) ASC ordering.
  await db.insert(issueLabel).values([
    { workspaceId: ws!.id, name: "Zebra", color: "#aaaaaa" },
    { workspaceId: ws!.id, name: "alpha", color: "#bbbbbb" },
  ]);

  const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

  try {
    // list
    const listRes = await app.request("/api/labels", { headers: auth });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      labels: Array<{ id: string; name: string; color: string; workspace_id: string }>;
      total: number;
    };
    expect(list.total).toBe(2);
    expect(list.labels.length).toBe(2);
    // LOWER(name) ASC → "alpha" before "Zebra".
    expect(list.labels.map((l) => l.name)).toEqual(["alpha", "Zebra"]);
    expect(list.labels[0]!.workspace_id).toBe(ws!.id);
    expect(list.labels[0]!.color).toBe("#bbbbbb");

    // missing workspace header → 400
    const noWs = await app.request("/api/labels", { headers: { Authorization: `Bearer ${token}` } });
    expect(noWs.status).toBe(400);

    // a member of no/other workspace → 404 (multi-tenancy gate)
    const otherWsId = "99999999-9999-4999-8999-999999999999";
    const foreign = await app.request("/api/labels", {
      headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
    });
    expect(foreign.status).toBe(404);
  } finally {
    await db.delete(issueLabel).where(eq(issueLabel.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});

test.skipIf(!reachable)("POST /api/labels validates name + normalizes color, 409 on dup", async () => {
  const { db, close } = createDb(DB_URL);
  const app = createApp(cfg, db);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-lbc-${stamp}@bytedance.com`, cfg);
  const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "Label Create WS", slug: `bun-lbc-${stamp}`, issuePrefix: "LBC" })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const auth = {
    Authorization: `Bearer ${token}`,
    "X-Workspace-ID": ws!.id,
    "Content-Type": "application/json",
  };
  try {
    // create — color without leading '#' is normalized to lowercase "#rrggbb"
    const r1 = await app.request("/api/labels", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "  Bug  ", color: "3B82F6" }),
    });
    expect(r1.status).toBe(201);
    const l1 = (await r1.json()) as { id: string; name: string; color: string; workspace_id: string };
    expect(l1.name).toBe("Bug");
    expect(l1.color).toBe("#3b82f6");
    expect(l1.workspace_id).toBe(ws!.id);

    // duplicate name (case-insensitive unique index) → 409
    const dup = await app.request("/api/labels", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "bug", color: "#000000" }),
    });
    expect(dup.status).toBe(409);

    // empty name → 400
    const noName = await app.request("/api/labels", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "   ", color: "#ffffff" }),
    });
    expect(noName.status).toBe(400);

    // invalid color → 400
    const badColor = await app.request("/api/labels", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Feature", color: "red" }),
    });
    expect(badColor.status).toBe(400);
  } finally {
    await db.delete(issueLabel).where(eq(issueLabel.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
