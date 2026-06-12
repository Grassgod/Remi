import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { user } from "../src/db/schema.js";
import { onboardingRoutes } from "../src/http/routes/onboarding.js";
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

// Probe the DB once; skip the whole suite if it's unreachable.
let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

/** Mount only onboardingRoutes, with a middleware that injects the authed user. */
function mountApp(db: ReturnType<typeof createDb>["db"], userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { sub: userId } as AppEnv["Variables"]["user"]);
    await next();
  });
  // onboardingRoutes declares absolute paths, so mount it at the root.
  app.route("/", onboardingRoutes(db));
  return app;
}

type CompleteResponse = {
  id: string;
  onboarded_at: string | null;
  onboarding_questionnaire: unknown;
  email: string;
};

test.skipIf(!reachable)(
  "POST /api/me/onboarding/complete marks the user onboarded and is idempotent",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { user: u } = await findOrCreateUser(db, `bun-onboard-${stamp}@bytedance.com`, cfg);
    const app = mountApp(db, u.id);
    const headers = { "Content-Type": "application/json" };
    try {
      // Precondition: a fresh user has not completed onboarding.
      const [before] = await db.select().from(user).where(eq(user.id, u.id));
      expect(before?.onboardedAt).toBeNull();

      // First complete: flips onboarded_at from null to a timestamp; returns the
      // Go user shape with onboarded_at set.
      const first = await app.request("/api/me/onboarding/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({ completion_path: "full" }),
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as CompleteResponse;
      expect(firstBody.id).toBe(u.id);
      expect(firstBody.onboarded_at).not.toBeNull();
      // Response is the Go-shaped user row.
      expect(firstBody.email).toBe(u.email);
      expect(firstBody.onboarding_questionnaire).toEqual({});

      // The row actually persisted the flag.
      const [afterFirst] = await db.select().from(user).where(eq(user.id, u.id));
      expect(afterFirst?.onboardedAt).not.toBeNull();
      const firstTimestamp = afterFirst!.onboardedAt;

      // Second complete: still 200, no error, idempotent — onboarded_at is
      // preserved (COALESCE), not overwritten.
      const second = await app.request("/api/me/onboarding/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as CompleteResponse;
      expect(secondBody.onboarded_at).not.toBeNull();

      // The stored timestamp did not change on the repeat call.
      const [afterSecond] = await db.select().from(user).where(eq(user.id, u.id));
      expect(afterSecond?.onboardedAt).toBe(firstTimestamp);

      // An empty body is also a legal call and stays idempotent / 200.
      const third = await app.request("/api/me/onboarding/complete", { method: "POST" });
      expect(third.status).toBe(200);
      const [afterThird] = await db.select().from(user).where(eq(user.id, u.id));
      expect(afterThird?.onboardedAt).toBe(firstTimestamp);
    } finally {
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "POST /api/me/onboarding/complete rejects a malformed workspace_id with 400",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { user: u } = await findOrCreateUser(db, `bun-onboard-bad-${stamp}@bytedance.com`, cfg);
    const app = mountApp(db, u.id);
    try {
      const res = await app.request("/api/me/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: "not-a-uuid" }),
      });
      expect(res.status).toBe(400);
      // The bad request must not have flipped onboarding state.
      const [row] = await db.select().from(user).where(eq(user.id, u.id));
      expect(row?.onboardedAt).toBeNull();
    } finally {
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
