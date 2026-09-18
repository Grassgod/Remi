import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { PasswordLoginLimiter } from "@multiremi/api/helpers/password-login.js";
import { AccessTokensRepo } from "@multiremi/store/repos/access-tokens-repo.js";
import { createStore, db, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

const MASTER = "test-password-auth-master";
const envKeys = ["MULTIREMI_ALLOW_PASSWORD_LOGIN", "NODE_ENV", "JWT_SECRET"] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
beforeEach(() => {
  process.env.MULTIREMI_ALLOW_PASSWORD_LOGIN = "1";
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-password-auth-jwt";
});
afterEach(() => {
  resetMultiremiTestEnv();
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

function setup(authToken = MASTER) {
  const store = createStore();
  store.ensureLocalWorkspace();
  return { store, app: createMultiremiApp({ store, authToken }) };
}

function post(app: ReturnType<typeof createMultiremiApp>, path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

const password = () => `test-only-${crypto.randomUUID()}`;
const credentialCount = () => (db!.query("SELECT count(*) AS total FROM multiremi_password_credentials").get() as { total: number }).total;
const userCount = () => (db!.query("SELECT count(*) AS total FROM multiremi_users").get() as { total: number }).total;
const configure = (app: ReturnType<typeof createMultiremiApp>, secret: string, extra = {}) =>
  post(app, "/api/auth/password-accounts", { email: "tester@localhost", password: secret, ...extra }, MASTER);

describe("password accounts", () => {
  it("is disabled by default without changing other authentication", async () => {
    delete process.env.MULTIREMI_ALLOW_PASSWORD_LOGIN;
    const { app } = setup();
    expect((await post(app, "/auth/password", {})).status).toBe(403);
    expect((await app.request("/api/me", { headers: { Authorization: `Bearer ${MASTER}` } })).status).toBe(200);
  });

  it("requires the exact master credential for configuration", async () => {
    const { app, store } = setup();
    const user = store.getOrCreateUser({ email: "other@example.test" });
    const pat = await store.createAccessToken({ name: "test PAT", userId: user.id });
    const daemon = await store.createAccessToken({ name: "test daemon", type: "daemon" });
    const task = await store.createAccessToken({ name: "test task", type: "task", taskId: "test-task", agentId: "test-agent" });
    const jwt = signTestJwt({ sub: "local", exp: Date.now() / 1000 + 60 }, process.env.JWT_SECRET);
    const input = { email: "tester@localhost", password: password() };
    expect((await post(app, "/api/auth/password-accounts", input)).status).toBe(401);
    for (const token of [pat.token, daemon.token, task.token, jwt]) {
      expect((await post(app, "/api/auth/password-accounts", input, token)).status).toBe(403);
    }
    expect((await app.request("/api/auth/password-accounts", {
      method: "POST", headers: { Cookie: `multimira_auth=${MASTER}`, "Content-Type": "application/json" }, body: JSON.stringify(input),
    })).status).toBe(401);
    expect(credentialCount()).toBe(0);
  });

  it("allows unauthenticated configuration only in explicit open local mode", async () => {
    const { app } = setup("");
    const input = { email: "open@example.test", password: password() };
    process.env.NODE_ENV = "production";
    expect((await post(app, "/api/auth/password-accounts", input)).status).toBe(403);
    process.env.NODE_ENV = "development";
    expect((await post(app, "/api/auth/password-accounts", input)).status).toBe(201);
  });

  it("stores only a private Argon2id hash and returns the real session identity after reload", async () => {
    const { app, store } = setup();
    const secret = password();
    const beforeOwner = store.listWorkspaceMembers("local").find((m) => m.userId === "local");
    const configured = await configure(app, secret);
    expect(configured.status).toBe(201);
    const account = await configured.json();
    expect(account).toMatchObject({ workspaceId: "local", role: "owner" });
    expect(account.user.id).toStartWith("usr_");
    expect(store.getUserRoleInWorkspace(account.user.id, "local")).toBe("owner");
    expect(store.getWorkspaceMember(beforeOwner!.id)).toEqual(beforeOwner!);
    const credential = db!.query("SELECT password_hash FROM multiremi_password_credentials WHERE user_id = ?").get(account.user.id) as { password_hash: string };
    expect(credential.password_hash).toStartWith("$argon2id$");
    expect(JSON.stringify(account).includes(credential.password_hash)).toBe(false);
    expect(JSON.stringify(account).includes(secret)).toBe(false);
    store.migrate();
    const login = await post(app, "/auth/password", { email: " TESTER@LOCALHOST ", password: secret });
    expect(login.status).toBe(200);
    const session = await login.json();
    expect(session.user.id).toBe(account.user.id);
    expect(await store.verifyAccessToken(session.token)).toMatchObject({ type: "pat", purpose: "session", userId: account.user.id });
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    const reloaded = await app.request("/api/me", { headers: { Cookie: cookie.split(";")[0]! } });
    expect(reloaded.status).toBe(200);
    expect((await reloaded.json()).id).toBe(account.user.id);
    expect((await post(app, "/auth/logout", {}, session.token)).status).toBe(200);
  });

  it("preserves one user across configured workspaces and denies unrelated workspaces", async () => {
    const { app, store } = setup();
    const secret = password();
    const secondary = store.createWorkspace({ name: "Second test", slug: "second-test" });
    const hidden = store.createWorkspace({ name: "Private test", slug: "private-test" });
    const first = await (await configure(app, secret)).json();
    const second = await (await configure(app, secret, { workspaceId: secondary.id })).json();
    expect(second.user.id).toBe(first.user.id);
    const session = await (await post(app, "/auth/password", { email: "tester@localhost", password: secret })).json();
    const headers = { Authorization: `Bearer ${session.token}` };
    const workspaces = await (await app.request("/api/workspaces", { headers })).json();
    expect(workspaces.map((w: { id: string }) => w.id).sort()).toEqual(["local", secondary.id].sort());
    expect((await app.request(`/api/workspaces/${secondary.id}`, { headers })).status).toBe(200);
    expect((await app.request(`/api/workspaces/${hidden.id}`, { headers })).status).toBe(404);
  });

  it("reuses an unambiguous real SSO user without changing their identity", async () => {
    const { app, store } = setup();
    const existing = store.getOrCreateUser({ externalId: "test-sso-identity", email: "tester@localhost", name: "Existing test user" });
    const configured = await (await configure(app, password(), { name: "Different name" })).json();
    expect(configured.user).toEqual(existing);
    expect((db!.query("SELECT count(*) AS total FROM multiremi_users WHERE lower(email) = ?").get("tester@localhost") as { total: number }).total).toBe(1);
  });

  it("refuses legacy or ambiguous identities without storing credentials", async () => {
    const { app, store } = setup();
    const secret = password();
    expect((await configure(app, secret, { email: store.getCurrentUser().email })).status).toBe(409);
    const a = store.getOrCreateUser({ email: "first@example.test" });
    const b = store.getOrCreateUser({ email: "second@example.test" });
    db!.run("UPDATE multiremi_users SET email = ? WHERE id IN (?, ?)", ["ambiguous@example.test", a.id, b.id]);
    expect((await configure(app, secret, { email: "ambiguous@example.test" })).status).toBe(409);
    expect(credentialCount()).toBe(0);
  });

  it("validates configuration before changing users or memberships", async () => {
    const { app } = setup();
    const usersBefore = userCount();
    expect((await configure(app, "x".repeat(5))).status).toBe(400);
    expect((await configure(app, password(), { email: "invalid-email" })).status).toBe(400);
    expect((await configure(app, password(), { workspaceId: "absent-test-workspace" })).status).toBe(404);
    expect(userCount()).toBe(usersBefore);
  });

  it("resets only the configured account and revokes its existing sessions", async () => {
    const { app, store } = setup();
    const oldSecret = password();
    const newSecret = password();
    const configured = await (await configure(app, oldSecret)).json();
    const login = await (await post(app, "/auth/password", { email: "tester@localhost", password: oldSecret })).json();
    const personal = await store.createAccessToken({ name: "Test personal credential", userId: configured.user.id, purpose: "personal" });
    expect((await configure(app, newSecret)).status).toBe(201);
    expect(await store.verifyAccessToken(login.token)).toBeNull();
    expect(await store.verifyAccessToken(personal.token)).not.toBeNull();
    expect((await post(app, "/auth/password", { email: "tester@localhost", password: oldSecret })).status).toBe(401);
    expect((await post(app, "/auth/password", { email: "tester@localhost", password: newSecret })).status).toBe(200);
  });

  it("fails uniformly without creating users, leaking hashes, or retaining failed capacity", async () => {
    const { app, store } = setup();
    const secret = password();
    const account = await (await configure(app, secret)).json();
    const unknown = await post(app, "/auth/password", { email: "missing@example.test", password: secret });
    const wrong = await post(app, "/auth/password", { email: "tester@localhost", password: password() });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
    expect(store.getUserByEmail("missing@example.test")).toBeNull();
    db!.run("UPDATE multiremi_password_credentials SET password_hash = ? WHERE user_id = ?", ["corrupt-test-hash", account.user.id]);
    expect(await (await post(app, "/auth/password", { email: "tester@localhost", password: secret })).json()).toEqual({ error: "invalid email or password" });
    const failing = spyOn(store, "loginWithPassword").mockRejectedValueOnce(new Error("test internal failure"));
    try {
      expect(await (await post(app, "/auth/password", { email: "tester@localhost", password: secret })).json()).toEqual({ error: "invalid email or password" });
    } finally { failing.mockRestore(); }
    expect((await configure(app, secret)).status).toBe(201);
    expect((await post(app, "/auth/password", { email: "tester@localhost", password: secret })).status).toBe(200);
  });

  it("limits repeated password guesses and returns a retry interval", async () => {
    const { app } = setup();
    for (let i = 0; i < 8; i++) {
      expect((await post(app, "/auth/password", { email: "missing@example.test", password: password() })).status).toBe(401);
    }
    const limited = await post(app, "/auth/password", { email: "missing@example.test", password: password() });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("does not mint a session when the password changes during asynchronous token creation", async () => {
    const { app } = setup();
    const secret = password();
    const configured = await (await configure(app, secret)).json();
    const original = AccessTokensRepo.prototype.createAccessToken;
    const resetDuringMint = spyOn(AccessTokensRepo.prototype, "createAccessToken").mockImplementation(function (this: AccessTokensRepo, input, beforeInsert, scopes) {
      db!.run("UPDATE multiremi_password_credentials SET password_hash = ? WHERE user_id = ?", ["changed-test-hash", configured.user.id]);
      return original.call(this, input, beforeInsert, scopes);
    });
    try {
      expect((await post(app, "/auth/password", { email: "tester@localhost", password: secret })).status).toBe(401);
      expect((db!.query("SELECT count(*) AS total FROM multiremi_access_tokens WHERE user_id = ?").get(configured.user.id) as { total: number }).total).toBe(0);
    } finally { resetDuringMint.mockRestore(); }
  });

  it("bounds concurrent hashing, total attempts, and limiter lifetime", () => {
    const limiter = new PasswordLoginLimiter();
    for (let i = 0; i < 4; i++) expect(limiter.enter(100_000)).toBe(true);
    expect(limiter.enter(100_000)).toBe(false);
    for (let i = 0; i < 4; i++) limiter.leave();
    for (let i = 0; i < 56; i++) { expect(limiter.enter(100_000)).toBe(true); limiter.leave(); }
    expect(limiter.enter(100_000)).toBe(false);
    expect(limiter.enter(160_000)).toBe(true);
    limiter.leave();
    for (let i = 0; i < 8; i++) expect(limiter.allowAccount("test-account", 100_000)).toBe(true);
    expect(limiter.allowAccount("test-account", 100_000)).toBe(false);
    expect(limiter.allowAccount("test-account", 160_000)).toBe(true);
  });
});
