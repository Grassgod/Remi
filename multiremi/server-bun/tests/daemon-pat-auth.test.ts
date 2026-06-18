/**
 * PAT auth on the /api/* gate + the daemon register endpoint. A remote `remi`
 * daemon authenticates with a `mul_` personal access token (no DB creds) and
 * registers its runtimes. Live-DB gated (skipIf), fixtures torn down in finally.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { createPersonalAccessToken, hashPatToken } from "../src/db/queries/pat.js";
import { user, member, workspace, agentRuntime, personalAccessToken } from "../src/db/schema.js";
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

/** Insert a PAT row and return the plaintext `mul_` token. */
async function makePat(
  db: ReturnType<typeof createDb>["db"],
  userId: string,
  raw: string,
  expiresAt: string | null,
): Promise<void> {
  await createPersonalAccessToken(db, {
    userId,
    name: "remi",
    tokenHash: hashPatToken(raw),
    tokenPrefix: raw.slice(0, 12),
    expiresAt,
  });
}

test.skipIf(!reachable)("PAT auth on /api/* + daemon register upsert", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-pat-${stamp}@bytedance.com`, cfg);
  const [ws] = await db
    .insert(workspace)
    .values({ name: "PAT WS", slug: `bun-pat-${stamp}`, issuePrefix: "PAT", issueCounter: 0 })
    .returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

  const valid = `mul_${stamp.toString(16)}aaaa`;
  const expired = `mul_${stamp.toString(16)}bbbb`;
  const revoked = `mul_${stamp.toString(16)}cccc`;
  await makePat(db, u.id, valid, null);
  await makePat(db, u.id, expired, new Date(Date.now() - 60_000).toISOString());
  await makePat(db, u.id, revoked, null);
  await db
    .update(personalAccessToken)
    .set({ revoked: true })
    .where(eq(personalAccessToken.tokenHash, hashPatToken(revoked)));

  const app = createApp(cfg, db);
  const wsHeader = { "X-Workspace-ID": ws!.id, "Content-Type": "application/json" };
  const body = JSON.stringify({
    daemon_id: `daemon-${stamp}`,
    device_name: "test-box",
    cli_version: "v0.2.20-1-g0000000",
    runtimes: [{ type: "claude" }],
  });

  try {
    // Valid PAT registers a runtime.
    const ok = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { ...wsHeader, Authorization: `Bearer ${valid}` },
      body,
    });
    expect(ok.status).toBe(200);
    const okJson = (await ok.json()) as { runtimes: { id: string; provider: string }[] };
    expect(okJson.runtimes).toHaveLength(1);
    expect(okJson.runtimes[0]!.provider).toBe("claude");
    const firstId = okJson.runtimes[0]!.id;

    // Re-register with the same daemon_id+provider → same row (upsert).
    const again = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { ...wsHeader, Authorization: `Bearer ${valid}` },
      body,
    });
    const againJson = (await again.json()) as { runtimes: { id: string }[] };
    expect(againJson.runtimes[0]!.id).toBe(firstId);

    // Expired + revoked PATs are rejected at the gate.
    for (const tok of [expired, revoked]) {
      const res = await app.request("/api/daemon/register", {
        method: "POST",
        headers: { ...wsHeader, Authorization: `Bearer ${tok}` },
        body,
      });
      expect(res.status).toBe(401);
    }

    // A garbage mul_ token is rejected too.
    const bad = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { ...wsHeader, Authorization: `Bearer mul_deadbeef` },
      body,
    });
    expect(bad.status).toBe(401);

    // JWT still authenticates (regression guard).
    const jwt = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const viaJwt = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { ...wsHeader, Authorization: `Bearer ${jwt}` },
      body,
    });
    expect(viaJwt.status).toBe(200);
  } finally {
    await db.delete(personalAccessToken).where(eq(personalAccessToken.userId, u.id));
    await db.delete(agentRuntime).where(eq(agentRuntime.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
