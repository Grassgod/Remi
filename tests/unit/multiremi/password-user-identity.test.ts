import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

afterEach(resetMultiremiTestEnv);
const MASTER = "test-me-identity-master";

async function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const local = store.getCurrentUser();
  const users = [];
  for (const label of ["first", "second"]) {
    const email = `${label}@identity.example.test`;
    const password = `test-only-${crypto.randomUUID()}`;
    const account = await store.configurePasswordAccount({ email, password, name: `${label} test user` });
    const session = await store.loginWithPassword(email, password);
    users.push({ user: account.user, token: session!.token });
  }
  return { store, local, first: users[0]!, second: users[1]!, app: createMultiremiApp({ store, authToken: MASTER }) };
}

function request(app: ReturnType<typeof createMultiremiApp>, token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("current-user profile and onboarding identity", () => {
  it("keeps two password users' profile, questionnaire and completion writes separate", async () => {
    const { app, store, local, first, second } = await setup();
    for (const [actor, other, marker] of [[first, second, "first"], [second, first, "second"]] as const) {
      const untouched = store.getUser(other.user.id);
      const me = await request(app, actor.token, "GET", "/api/me");
      expect(me.status).toBe(200);
      expect((await me.json()).id).toBe(actor.user.id);
      const patched = await request(app, actor.token, "PATCH", "/api/me", {
        name: `${marker} updated`, profile_description: `${marker} biography`,
        id: "local", userId: other.user.id, user_id: other.user.id,
      });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({ id: actor.user.id, name: `${marker} updated`, profile_description: `${marker} biography` });
      const questionnaire = await request(app, actor.token, "PATCH", "/api/me/onboarding", {
        questionnaire: { purpose: marker }, user_id: other.user.id,
      });
      expect(questionnaire.status).toBe(200);
      expect(await questionnaire.json()).toMatchObject({ id: actor.user.id, onboarding_questionnaire: { purpose: marker } });
      const completed = await request(app, actor.token, "POST", "/api/me/onboarding/complete", { user_id: other.user.id });
      expect(completed.status).toBe(200);
      expect((await completed.json()).id).toBe(actor.user.id);
      expect(store.getUser(actor.user.id)?.onboardedAt).not.toBeNull();
      expect(store.getUser(other.user.id)).toEqual(untouched);
      expect(store.getCurrentUser()).toEqual(local);
    }
    expect(store.getUser(first.user.id)?.name).toBe("first updated");
    expect(store.getUser(second.user.id)?.name).toBe("second updated");
  });

  it("adds a cloud waitlist response only to the caller's questionnaire", async () => {
    const { app, store, local, first, second } = await setup();
    store.patchCurrentUserOnboarding({ existing: "first answer" }, first.user.id);
    const untouched = store.getUser(second.user.id);
    const response = await request(app, first.token, "POST", "/api/me/onboarding/cloud-waitlist", {
      email: "waitlist@identity.example.test", reason: "Test waitlist", user_id: second.user.id,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: first.user.id,
      onboarding_questionnaire: { existing: "first answer", cloud_waitlist_email: "waitlist@identity.example.test", cloud_waitlist_reason: "Test waitlist" },
    });
    expect(store.getUser(second.user.id)).toEqual(untouched);
    expect(store.getCurrentUser()).toEqual(local);
  });

  it("binds both bootstrap paths to the caller while preserving workspace guards", async () => {
    const { app, store, first, second } = await setup();
    const privateWorkspace = store.createWorkspace({ name: "Unrelated test workspace", slug: "unrelated-bootstrap-test" });
    expect((await request(app, first.token, "POST", "/api/me/onboarding/no-runtime-bootstrap", { workspace_id: privateWorkspace.id })).status).toBe(404);
    const runtime = store.registerRuntime({ id: "identity-test-runtime", name: "Test runtime", provider: "codex", workspaceId: "local", ownerId: first.user.id });
    // Direct fixture workspace creation completes its default local actor's
    // onboarding; measure isolation after that setup has finished.
    const local = store.getCurrentUser();
    const withRuntime = await request(app, first.token, "POST", "/api/me/onboarding/runtime-bootstrap", { workspace_id: "local", runtime_id: runtime.id });
    expect(withRuntime.status).toBe(200);
    const bootstrap = await withRuntime.json();
    expect(store.getAgent(bootstrap.agent_id)?.ownerId).toBe(first.user.id);
    expect(store.getUser(first.user.id)?.onboardedAt).not.toBeNull();
    expect(store.getUser(second.user.id)?.onboardedAt).toBeNull();
    expect(store.getCurrentUser()).toEqual(local);
    const firstAfter = store.getUser(first.user.id);
    const withoutRuntime = await request(app, second.token, "POST", "/api/me/onboarding/no-runtime-bootstrap", { workspace_id: "local" });
    expect(withoutRuntime.status).toBe(200);
    expect(store.getUser(second.user.id)?.onboardedAt).not.toBeNull();
    expect(store.getUser(first.user.id)).toEqual(firstAfter);
    expect(store.getCurrentUser()).toEqual(local);
  });

  it("preserves the password user's identity through CLI handoff", async () => {
    const { app, store, first } = await setup();
    const exchanged = await request(app, first.token, "POST", "/api/cli-token");
    expect(exchanged.status).toBe(200);
    const { token } = await exchanged.json();
    expect(await store.verifyAccessToken(token)).toMatchObject({ userId: first.user.id, purpose: "cli" });
    expect((await (await request(app, token, "GET", "/api/me")).json()).id).toBe(first.user.id);
    const masterExchange = await request(app, MASTER, "POST", "/api/cli-token");
    expect(await store.verifyAccessToken((await masterExchange.json()).token)).toMatchObject({ userId: "local" });
  });

  it("retains the local default for master requests and legacy store callers", async () => {
    const { app, store, first, second } = await setup();
    const updated = await request(app, MASTER, "PATCH", "/api/me", { name: "Local test owner" });
    expect(await updated.json()).toMatchObject({ id: "local", name: "Local test owner" });
    expect(store.updateCurrentUser({ profileDescription: "Legacy profile" }).id).toBe("local");
    expect(store.patchCurrentUserOnboarding({ legacy: true }).id).toBe("local");
    expect(store.markCurrentUserOnboarded().id).toBe("local");
    expect(store.getUser(first.user.id)).toEqual(first.user);
    expect(store.getUser(second.user.id)).toEqual(second.user);
  });

  it("rejects a missing authenticated identity before any profile or bootstrap write", async () => {
    const { app, store, local } = await setup();
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "test-me-identity-jwt";
    try {
      const ghost = signTestJwt({ sub: "usr_missing_test_identity", exp: Date.now() / 1000 + 60 }, process.env.JWT_SECRET);
      for (const [method, path, body] of [
        ["GET", "/api/me", undefined],
        ["PATCH", "/api/me", { name: "Must not be written" }],
        ["PATCH", "/api/me/onboarding", { questionnaire: { invalid: true } }],
        ["POST", "/api/me/onboarding/complete", {}],
        ["POST", "/api/me/onboarding/cloud-waitlist", { email: "missing@example.test" }],
        ["POST", "/api/me/onboarding/no-runtime-bootstrap", { workspace_id: "local" }],
      ] as const) {
        expect((await request(app, ghost, method, path, body)).status).toBe(401);
      }
      expect(store.getCurrentUser()).toEqual(local);
      expect(store.listIssues({ workspaceId: "local" })).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previous;
    }
  });
});
