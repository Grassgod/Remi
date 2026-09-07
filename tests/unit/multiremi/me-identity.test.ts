import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { AUTH_COOKIE_NAME, localAuthResponse } from "@multiremi/api/helpers/login.js";
import { createStore, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const MASTER = "test-me-identity-master";

async function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const first = await localAuthResponse(store, {
    externalId: "ou_identity_first", email: "first@identity.example.test", name: "First user",
  });
  const second = await localAuthResponse(store, {
    externalId: "ou_identity_second", email: "second@identity.example.test", name: "Second user",
  });
  expect(first.user.id).not.toBe("local");
  expect(second.user.id).not.toBe(first.user.id);
  expect(first.user.onboardedAt).toBeNull();
  expect(second.user.onboardedAt).toBeNull();
  return { store, first, second, local: store.getCurrentUser(), app: createMultiremiApp({ store, authToken: MASTER }) };
}

function request(app: ReturnType<typeof createMultiremiApp>, token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("current-user profile and onboarding identity", () => {
  it("reads each user's own profile through Bearer and Cookie authentication", async () => {
    const { app, first, second } = await setup();
    for (const actor of [first, second]) {
      for (const headers of [
        new Headers({ Authorization: `Bearer ${actor.token}` }),
        new Headers({ Cookie: `${AUTH_COOKIE_NAME}=${actor.token}` }),
      ] as const) {
        const response = await app.request("/api/me", { headers });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          id: actor.user.id, name: actor.user.name, email: actor.user.email,
        });
      }
    }
  });

  it("updates only the authenticated profile even when the body names another user", async () => {
    const { app, store, local, first, second } = await setup();
    for (const [actor, other, marker] of [[first, second, "first"], [second, first, "second"]] as const) {
      const untouched = store.getUser(other.user.id);
      const response = await request(app, actor.token, "PATCH", "/api/me", {
        name: `${marker} updated`, profile_description: `${marker} biography`,
        id: "local", userId: other.user.id, user_id: other.user.id,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: actor.user.id, name: `${marker} updated`, profile_description: `${marker} biography`,
      });
      expect(store.getUser(actor.user.id)).toMatchObject({ name: `${marker} updated`, profileDescription: `${marker} biography` });
      expect(store.getUser(other.user.id)).toEqual(untouched);
      expect(store.getCurrentUser()).toEqual(local);
    }
  });

  it("keeps questionnaire writes separate for both users", async () => {
    const { app, store, local, first, second } = await setup();
    for (const [actor, other] of [[first, second], [second, first]]) {
      const untouched = store.getUser(other.user.id);
      const response = await request(app, actor.token, "PATCH", "/api/me/onboarding", {
        questionnaire: { purpose: actor.user.email }, userId: other.user.id, user_id: other.user.id,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: actor.user.id, onboarding_questionnaire: { purpose: actor.user.email },
      });
      expect(store.getUser(actor.user.id)?.onboardingQuestionnaire).toEqual({ purpose: actor.user.email });
      expect(store.getUser(other.user.id)).toEqual(untouched);
      expect(store.getCurrentUser()).toEqual(local);
    }
  });

  it("completes onboarding only for the caller", async () => {
    const { app, store, local, first, second } = await setup();
    for (const [actor, other] of [[first, second], [second, first]]) {
      const untouched = store.getUser(other.user.id);
      expect(store.getUser(actor.user.id)?.onboardedAt).toBeNull();
      const response = await request(app, actor.token, "POST", "/api/me/onboarding/complete", {
        userId: other.user.id, user_id: other.user.id,
      });
      expect(response.status).toBe(200);
      expect((await response.json()).id).toBe(actor.user.id);
      expect(store.getUser(actor.user.id)?.onboardedAt).toEqual(expect.any(String));
      expect(store.getUser(other.user.id)).toEqual(untouched);
      expect(store.getCurrentUser()).toEqual(local);
    }
  });

  it("adds waitlist answers to the caller's existing questionnaire", async () => {
    const { app, store, local, first, second } = await setup();
    for (const [actor, other] of [[first, second], [second, first]]) {
      const untouched = store.getUser(other.user.id);
      const questionnaire = await request(app, actor.token, "PATCH", "/api/me/onboarding", {
        questionnaire: { existing: actor.user.name },
      });
      expect(questionnaire.status).toBe(200);
      const response = await request(app, actor.token, "POST", "/api/me/onboarding/cloud-waitlist", {
        email: actor.user.email, reason: actor.user.name, userId: other.user.id, user_id: other.user.id,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: actor.user.id,
        onboarding_questionnaire: {
          existing: actor.user.name, cloud_waitlist_email: actor.user.email, cloud_waitlist_reason: actor.user.name,
        },
      });
      expect(store.getUser(actor.user.id)?.onboardingQuestionnaire).toEqual({
        existing: actor.user.name, cloud_waitlist_email: actor.user.email, cloud_waitlist_reason: actor.user.name,
      });
      expect(store.getUser(other.user.id)).toEqual(untouched);
      expect(store.getCurrentUser()).toEqual(local);
    }
  });

  it("keeps bootstrap workspace guards and attributes successful onboarding to the caller", async () => {
    const { app, store, first, second } = await setup();
    for (const { user } of [first, second]) {
      store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: user.name, email: user.email, role: "member" });
    }
    const privateWorkspace = store.createWorkspace({ name: "Unrelated workspace", slug: "unrelated-identity" });
    const runtime = store.registerRuntime({
      id: "identity-runtime", name: "Test runtime", provider: "codex", workspaceId: "local", ownerId: first.user.id,
    });
    // Workspace creation updates its default local owner; take the snapshot
    // after setup, while both ordinary users are still awaiting onboarding.
    const local = store.getCurrentUser();
    for (const path of ["runtime-bootstrap", "no-runtime-bootstrap"]) {
      const response = await request(app, first.token, "POST", `/api/me/onboarding/${path}`, {
        workspace_id: privateWorkspace.id, runtime_id: runtime.id,
      });
      expect(response.status).toBe(404);
    }
    expect(store.listIssues({ workspaceId: privateWorkspace.id })).toHaveLength(0);
    expect(store.getUser(first.user.id)?.onboardedAt).toBeNull();
    expect(store.getUser(second.user.id)?.onboardedAt).toBeNull();

    const withRuntime = await request(app, first.token, "POST", "/api/me/onboarding/runtime-bootstrap", {
      workspace_id: "local", runtime_id: runtime.id, userId: second.user.id, user_id: second.user.id,
    });
    expect(withRuntime.status).toBe(200);
    const bootstrap = await withRuntime.json();
    expect(store.getAgent(bootstrap.agent_id)?.ownerId).toBe(first.user.id);
    expect(store.getIssue(bootstrap.issue_id)?.createdBy).toBe(first.user.id);
    expect(store.getUser(first.user.id)?.onboardedAt).toEqual(expect.any(String));
    expect(store.getUser(second.user.id)).toEqual(second.user);
    const firstAfter = store.getUser(first.user.id);

    const withoutRuntime = await request(app, second.token, "POST", "/api/me/onboarding/no-runtime-bootstrap", {
      workspace_id: "local", userId: first.user.id, user_id: first.user.id,
    });
    expect(withoutRuntime.status).toBe(200);
    expect(store.getIssue((await withoutRuntime.json()).issue_id)?.createdBy).toBe(second.user.id);
    expect(store.getUser(second.user.id)?.onboardedAt).toEqual(expect.any(String));
    expect(store.getUser(first.user.id)).toEqual(firstAfter);
    expect(store.getCurrentUser()).toEqual(local);
  });

  it("preserves each user's identity and workspace permissions when issuing CLI tokens", async () => {
    const { app, store, first, second } = await setup();
    const firstWorkspace = store.createWorkspace({ name: "First workspace", slug: "identity-first" }, first.user.id);
    const secondWorkspace = store.createWorkspace({ name: "Second workspace", slug: "identity-second" }, second.user.id);
    for (const [actor, other, owned, forbidden] of [
      [first, second, firstWorkspace, secondWorkspace],
      [second, first, secondWorkspace, firstWorkspace],
    ] as const) {
      const exchanged = await request(app, actor.token, "POST", "/api/cli-token", { userId: other.user.id, user_id: other.user.id });
      expect(exchanged.status).toBe(200);
      const { token } = await exchanged.json();
      expect(await store.verifyAccessToken(token)).toMatchObject({ userId: actor.user.id, type: "pat", purpose: "cli" });
      const me = await request(app, token, "GET", "/api/me");
      expect(me.status).toBe(200);
      expect((await me.json()).id).toBe(actor.user.id);
      const workspaces = await request(app, token, "GET", "/api/workspaces");
      expect(workspaces.status).toBe(200);
      expect((await workspaces.json()).map((workspace: { id: string }) => workspace.id)).toEqual([owned.id]);
      expect((await request(app, token, "GET", `/api/workspaces/${owned.id}`)).status).toBe(200);
      expect((await request(app, token, "GET", `/api/workspaces/${forbidden.id}`)).status).toBe(404);
      expect((await request(app, token, "GET", "/api/workspaces/local")).status).toBe(404);
    }
  });

  it("retains local identity for master requests and legacy store callers", async () => {
    const { app, store, first, second } = await setup();
    const me = await request(app, MASTER, "GET", "/api/me");
    expect(me.status).toBe(200);
    expect((await me.json()).id).toBe("local");
    expect(me.headers.get("Set-Cookie")).toBeNull();
    const updated = await request(app, MASTER, "PATCH", "/api/me", { name: "Local owner", user_id: first.user.id });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: "local", name: "Local owner" });
    expect(store.updateCurrentUser({ profileDescription: "Legacy profile" }).id).toBe("local");
    expect(store.patchCurrentUserOnboarding({ legacy: true }).id).toBe("local");
    expect(store.markCurrentUserOnboarded().id).toBe("local");
    const exchanged = await request(app, MASTER, "POST", "/api/cli-token");
    expect(exchanged.status).toBe(200);
    const { token } = await exchanged.json();
    expect(await store.verifyAccessToken(token)).toMatchObject({ userId: "local", purpose: "cli" });
    expect((await (await request(app, token, "GET", "/api/me")).json()).id).toBe("local");
    expect(store.getUser(first.user.id)).toEqual(first.user);
    expect(store.getUser(second.user.id)).toEqual(second.user);
  });

  it("rejects missing JWT users before profile, bootstrap or CLI token side effects", async () => {
    const { app, store, local, first, second } = await setup();
    const tokensBefore = store.listAccessTokens();
    const agentsBefore = store.listAgents();
    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "test-me-identity-jwt";
    try {
      const ghost = signTestJwt({ sub: "usr_missing_identity", exp: Math.floor(Date.now() / 1000) + 60 }, process.env.JWT_SECRET);
      const statuses: number[] = [];
      for (const [method, path, body] of [
        ["GET", "/api/me", undefined],
        ["PATCH", "/api/me", { name: "Must not be written" }],
        ["PATCH", "/api/me/onboarding", { questionnaire: { invalid: true } }],
        ["POST", "/api/me/onboarding/complete", {}],
        ["POST", "/api/me/onboarding/cloud-waitlist", { email: "missing@example.test" }],
        ["POST", "/api/me/onboarding/runtime-bootstrap", { workspace_id: "local", runtime_id: "missing-runtime" }],
        ["POST", "/api/me/onboarding/no-runtime-bootstrap", { workspace_id: "local" }],
        ["POST", "/api/cli-token", {}],
      ] as const) {
        statuses.push((await request(app, ghost, method, path, body)).status);
      }
      expect(statuses).toEqual(Array(8).fill(401));
      expect(store.getCurrentUser()).toEqual(local);
      expect(store.getUser(first.user.id)).toEqual(first.user);
      expect(store.getUser(second.user.id)).toEqual(second.user);
      expect(store.listAccessTokens()).toEqual(tokensBefore);
      expect(store.listAgents()).toEqual(agentsBefore);
      expect(store.listIssues({ workspaceId: "local" })).toHaveLength(0);
    } finally {
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    }
  });
});
