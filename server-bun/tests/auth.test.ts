import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { checkSignupAllowed, findOrCreateUser, SignupError } from "../src/auth/users.js";
import { createDb } from "../src/db/client.js";
import { user } from "../src/db/schema.js";
import type { Config } from "../src/config.js";

const SECRET = "test-secret-0123456789";
const baseCfg: Config = {
  port: 0,
  jwtSecret: SECRET,
  authTokenTtlSeconds: 3600,
  databaseUrl: "",
  allowedEmailDomains: [],
};

test("GET /auth/lark/url → 503 when Feishu is not configured", async () => {
  delete process.env.LARK_SSO_APP_ID;
  delete process.env.LARK_SSO_APP_SECRET;
  const res = await createApp(baseCfg).request("/auth/lark/url?redirect_uri=http://x/cb");
  expect(res.status).toBe(503);
});

test("checkSignupAllowed gates new signups by domain, lets existing users in", () => {
  const cfg: Config = { ...baseCfg, allowedEmailDomains: ["bytedance.com"] };
  // existing user: always allowed regardless of domain
  expect(() => checkSignupAllowed("x@gmail.com", false, cfg)).not.toThrow();
  // new user, allowed domain
  expect(() => checkSignupAllowed("y@bytedance.com", true, cfg)).not.toThrow();
  // new user, disallowed domain
  expect(() => checkSignupAllowed("z@gmail.com", true, cfg)).toThrow(SignupError);
});

// ── Live DB ────────────────────────────────────────────────────────────────
const DB_URL =
  process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip live test */
}

test.skipIf(!reachable)("findOrCreateUser creates then reuses the same user (live DB)", async () => {
  const { db, close } = createDb(DB_URL);
  const email = `bun-auth-${Date.now()}@bytedance.com`;
  try {
    const first = await findOrCreateUser(db, email, baseCfg);
    expect(first.isNew).toBe(true);
    expect(first.user.name).toBe(email.slice(0, email.indexOf("@")));

    const second = await findOrCreateUser(db, email.toUpperCase(), baseCfg);
    expect(second.isNew).toBe(false);
    expect(second.user.id).toBe(first.user.id);

    await db.delete(user).where(eq(user.id, first.user.id));
  } finally {
    await close();
  }
});

test.skipIf(!reachable)(
  "findOrCreateUser honors displayName/avatarUrl for new users (live DB)",
  async () => {
    const { db, close } = createDb(DB_URL);
    const email = `bun-auth-name-${Date.now()}@bytedance.com`;
    try {
      const created = await findOrCreateUser(db, email, baseCfg, {
        displayName: "张三",
        avatarUrl: "https://example.com/a.png",
      });
      expect(created.isNew).toBe(true);
      expect(created.user.name).toBe("张三");
      expect(created.user.avatarUrl).toBe("https://example.com/a.png");
      await db.delete(user).where(eq(user.id, created.user.id));
    } finally {
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "POST /auth/lark/callback falls back to a synthetic identity when Feishu returns no email",
  async () => {
    process.env.LARK_SSO_APP_ID = "cli_test";
    process.env.LARK_SSO_APP_SECRET = "secret_test";
    const { db, close } = createDb(DB_URL);
    const openId = `ou_test_${Date.now()}`;
    const realFetch = globalThis.fetch;
    // The route reaches Feishu via global fetch; app.request() dispatches
    // in-process so only the two Feishu calls hit this mock.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/open-apis/authen/v2/oauth/token")) {
        return Response.json({ access_token: "t_mock" });
      }
      if (url.includes("/open-apis/authen/v1/user_info")) {
        return Response.json({ data: { open_id: openId, name: "扫码用户" } });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const app = createApp(baseCfg, db);
      const res = await app.request("/auth/lark/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "c_mock", redirect_uri: "http://x/cb" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token?: string; user?: { id: string; email: string; name: string } };
      expect(body.token).toBeTruthy();
      expect(body.user?.email).toBe(`${openId.toLowerCase()}@lark.local`);
      expect(body.user?.name).toBe("扫码用户");
      if (body.user?.id) await db.delete(user).where(eq(user.id, body.user.id));
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.LARK_SSO_APP_ID;
      delete process.env.LARK_SSO_APP_SECRET;
      await close();
    }
  },
);

test("dev-login is hard-disabled in production even with the flag on", async () => {
  const prevEnv = process.env.APP_ENV;
  const prevFlag = process.env.MULTIMIRA_DEV_LOGIN;
  process.env.APP_ENV = "production";
  process.env.MULTIMIRA_DEV_LOGIN = "1";
  try {
    const res = await createApp(baseCfg).request("/auth/dev-login?email=x@y.com");
    expect(res.status).toBe(404);
  } finally {
    if (prevEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = prevEnv;
    if (prevFlag === undefined) delete process.env.MULTIMIRA_DEV_LOGIN;
    else process.env.MULTIMIRA_DEV_LOGIN = prevFlag;
  }
});
