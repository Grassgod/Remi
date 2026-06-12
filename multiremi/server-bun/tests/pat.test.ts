import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, personalAccessToken } from "../src/db/schema.js";
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
  "PAT create returns plaintext token once + stores a hash; list is user-scoped, newest first",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-pat-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    // A second, unrelated user proves the list is user-scoped (no leakage).
    const { user: other } = await findOrCreateUser(db, `bun-pat-other-${stamp}@bytedance.com`, cfg);
    const otherToken = await issueJWT(
      { sub: other.id, email: other.email, name: other.name },
      SECRET,
    );
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    try {
      // create — returns the plaintext token exactly once
      const r1 = await app.request("/api/personal-access-tokens", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "CI token", expires_in_days: 30 }),
      });
      expect(r1.status).toBe(201);
      const created = (await r1.json()) as {
        id: string;
        name: string;
        token_prefix: string;
        token: string;
        expires_at: string | null;
        last_used_at: string | null;
        created_at: string;
      };
      expect(created.name).toBe("CI token");
      // Go format: "mul_" + 40 hex chars; prefix is the first 12 chars.
      expect(created.token).toMatch(/^mul_[0-9a-f]{40}$/);
      expect(created.token_prefix).toBe(created.token.slice(0, 12));
      expect(created.expires_at).not.toBeNull();
      expect(created.last_used_at).toBeNull();

      // the stored row holds the SHA-256 hash of the plaintext, never the plaintext
      const [row] = await db
        .select()
        .from(personalAccessToken)
        .where(eq(personalAccessToken.id, created.id));
      const expectedHash = createHash("sha256").update(created.token).digest("hex");
      expect(row!.tokenHash).toBe(expectedHash);
      expect(row!.tokenHash).not.toBe(created.token);

      // a second token to verify newest-first ordering
      const r2 = await app.request("/api/personal-access-tokens", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "second token" }),
      });
      expect(r2.status).toBe(201);
      const second = (await r2.json()) as { id: string; expires_at: string | null };
      // no expires_in_days → never-expiring (NULL)
      expect(second.expires_at).toBeNull();

      // list — user-scoped, newest first; never includes the plaintext token
      const listRes = await app.request("/api/personal-access-tokens", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<{
        id: string;
        name: string;
        token_prefix: string;
        token?: string;
      }>;
      expect(list.length).toBe(2);
      expect(list[0]!.id).toBe(second.id); // created_at DESC
      expect(list[1]!.id).toBe(created.id);
      expect(list[0]!.token).toBeUndefined();

      // the other user sees none of this user's tokens
      const otherList = await app.request("/api/personal-access-tokens", {
        headers: { Authorization: `Bearer ${otherToken}` },
      });
      expect(otherList.status).toBe(200);
      expect(((await otherList.json()) as unknown[]).length).toBe(0);

      // missing name → 400
      const noName = await app.request("/api/personal-access-tokens", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "   " }),
      });
      expect(noName.status).toBe(400);
    } finally {
      await db.delete(personalAccessToken).where(eq(personalAccessToken.userId, u.id));
      await db.delete(personalAccessToken).where(eq(personalAccessToken.userId, other.id));
      await db.delete(user).where(eq(user.id, u.id));
      await db.delete(user).where(eq(user.id, other.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "DELETE revokes a token (soft, owner-scoped) and is idempotent",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-patd-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      const created = (await (
        await app.request("/api/personal-access-tokens", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ name: "to revoke" }),
        })
      ).json()) as { id: string };

      // revoke
      const del = await app.request(`/api/personal-access-tokens/${created.id}`, {
        method: "DELETE",
        headers: auth,
      });
      expect(del.status).toBe(204);

      // soft delete: the row still exists but is marked revoked
      const [row] = await db
        .select()
        .from(personalAccessToken)
        .where(eq(personalAccessToken.id, created.id));
      expect(row!.revoked).toBe(true);

      // revoked tokens drop out of the list
      const list = (await (
        await app.request("/api/personal-access-tokens", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json()) as unknown[];
      expect(list.length).toBe(0);

      // idempotent: a second DELETE (now no matching active row) still 204s
      const del2 = await app.request(`/api/personal-access-tokens/${created.id}`, {
        method: "DELETE",
        headers: auth,
      });
      expect(del2.status).toBe(204);

      // unknown-but-valid UUID → still 204 (idempotent, no leak)
      const unknown = await app.request(
        "/api/personal-access-tokens/99999999-9999-4999-8999-999999999999",
        { method: "DELETE", headers: auth },
      );
      expect(unknown.status).toBe(204);

      // malformed id → 400
      const bad = await app.request("/api/personal-access-tokens/not-a-uuid", {
        method: "DELETE",
        headers: auth,
      });
      expect(bad.status).toBe(400);
    } finally {
      await db.delete(personalAccessToken).where(eq(personalAccessToken.userId, u.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
