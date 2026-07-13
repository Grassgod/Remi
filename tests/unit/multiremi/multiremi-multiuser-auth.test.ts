import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";

// The deployment owner's stable Feishu open_id (see DEFAULT_OWNER_OPEN_ID in the store).
const OWNER_OPEN_ID = "ou_e6b7ffc662b392317275b817295c0b44";

let db: Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
  delete process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN;
  delete process.env.MULTIREMI_OWNER_OPEN_ID;
});

function freshStore(): MultiremiStore {
  db = new Database(":memory:");
  return new MultiremiStore(db);
}

// Reproduce the existing single-user deployment: the seed `local` user owns the
// local workspace, then the multi-user migration tags it with the owner open_id
// (backfillOwnerExternalId runs in migrate()).
function seedDeployment(): MultiremiStore {
  const store = freshStore();
  store.ensureLocalWorkspace(); // local workspace + owner member (user id "local")
  store.migrate(); // re-run migration on the now-populated db to tag the owner
  return store;
}

// Mirror the server's localAuthResponse: resolve/create the distinct user for a
// login identity and mint a token that carries that user's real id.
async function login(
  store: MultiremiStore,
  identity: { externalId?: string; email: string; name?: string },
): Promise<{ userId: string; token: string }> {
  const user = store.getOrCreateUser(identity);
  const created = await store.createLoginSessionToken({
    userId: user.id,
    name: `Login ${user.id}`,
    expiresInDays: 30,
  });
  return { userId: user.id, token: created.token };
}

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const jsonAuth = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

function signTestJwt(payload: Record<string, unknown>, secret = "multiremi-dev-secret-change-in-production"): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("Multiremi multi-user auth", () => {
  it("returns the authenticated user from /api/me without replacing the legacy local user", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const localUser = store.getCurrentUser();
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });

    const response = await app.request("/api/me", bearer(b.token));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: b.userId,
      name: "B",
      email: "b@corp.com",
    });
    const masterResponse = await app.request("/api/me", bearer("root-secret"));
    expect(masterResponse.status).toBe(200);
    expect(await masterResponse.json()).toMatchObject({ id: "local", email: localUser.email });
    expect(store.getCurrentUser()).toEqual(localUser);
  });

  it("marks a real local-id login as a session without unscoping ordinary workspace PATs", async () => {
    process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN = "1";
    // On a fresh self-hosted install the first email login legitimately resolves
    // to the seed user whose stable id is `local`.
    const store = freshStore();
    store.ensureLocalWorkspace();
    const localUser = store.getCurrentUser();
    const workspace = store.createWorkspace({ name: "Owner Team", slug: "owner-team" }, localUser.id);
    const runtime = store.registerRuntime({
      id: "rt_owner_team",
      name: "Owner Team Runtime",
      provider: "codex",
      workspaceId: workspace.id,
      ownerId: localUser.id,
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const sent = await app.request("/auth/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: localUser.email }),
    });
    const { code } = await sent.json();
    const verified = await app.request("/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: localUser.email, code }),
    });
    const session = await verified.json();

    expect(verified.status).toBe(200);
    expect(session.user.id).toBe("local");
    const verifiedSession = await store.verifyAccessToken(session.token);
    expect(verifiedSession).toMatchObject({ purpose: "session", userId: "local" });
    expect((await app.request(`/api/workspaces/${workspace.id}`, bearer(session.token))).status).toBe(200);
    expect((await app.request(`/api/multiremi/runtimes/${runtime.id}`, bearer(session.token))).status).toBe(200);
    const cliResponse = await app.request("/api/cli-token", { method: "POST", ...bearer(session.token) });
    const cliToken = await store.verifyAccessToken((await cliResponse.json()).token);
    expect(cliToken).toMatchObject({ purpose: "workspace", userId: "local", workspaceId: "local" });
    const renewedSession = await store.renewAccessTokenExpiry(verifiedSession!.id, { thresholdDays: 31, extensionDays: 90 });
    expect(renewedSession?.token.purpose).toBe("session");

    const workspacePat = await store.createAccessToken({
      workspaceId: "local",
      userId: localUser.id,
      name: "Local workspace PAT",
      type: "pat",
    });
    expect(workspacePat.purpose).toBe("workspace");
    expect((await app.request(`/api/workspaces/${workspace.id}`, bearer(workspacePat.token))).status).toBe(404);
    expect((await app.request(`/api/multiremi/runtimes/${runtime.id}`, bearer(workspacePat.token))).status).toBe(404);
  });

  it("lets the migrated Feishu owner whose user id is local use their member workspaces", async () => {
    const store = seedDeployment();
    const localUser = store.getCurrentUser();
    const owner = await login(store, {
      externalId: OWNER_OPEN_ID,
      email: localUser.email,
      name: localUser.name,
    });
    const workspace = store.createWorkspace({ name: "Migrated Owner Team", slug: "migrated-owner-team" }, owner.userId);
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    expect(owner.userId).toBe("local");
    expect((await app.request(`/api/workspaces/${workspace.id}`, bearer(owner.token))).status).toBe(200);
  });

  it("keeps a non-local user's ordinary PAT scoped to its minted workspace", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const b = store.getOrCreateUser({ externalId: "ou_b", email: "b@corp.com", name: "B" });
    const first = store.createWorkspace({ name: "First", slug: "first" }, b.id);
    const second = store.createWorkspace({ name: "Second", slug: "second" }, b.id);
    const workspacePat = await store.createAccessToken({
      workspaceId: first.id,
      userId: b.id,
      name: "First workspace PAT",
      type: "pat",
    });

    expect((await app.request(`/api/workspaces/${first.id}`, bearer(workspacePat.token))).status).toBe(200);
    expect((await app.request(`/api/workspaces/${second.id}`, bearer(workspacePat.token))).status).toBe(404);
  });

  it("migrates historical access tokens as workspace-scoped instead of guessing sessions", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE multiremi_access_tokens (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        daemon_id TEXT,
        task_id TEXT,
        agent_id TEXT,
        user_id TEXT NOT NULL DEFAULT 'local',
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'pat',
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO multiremi_access_tokens (
        id, workspace_id, user_id, name, type, token_hash, token_prefix, created_at
      ) VALUES (
        'pat_legacy_login', 'local', 'local', 'Login for local@multiremi.local',
        'pat', 'legacy-hash', 'mul_legacy', '2026-01-01T00:00:00.000Z'
      );
    `);

    const store = new MultiremiStore(db);

    expect(store.getAccessToken("pat_legacy_login")?.purpose).toBe("workspace");
  });

  it("forces pre-purpose login tokens to reauthenticate instead of partially logging in", async () => {
    const store = seedDeployment();
    const user = store.getCurrentUser();
    const legacyLogin = await store.createAccessToken({
      workspaceId: "local",
      userId: user.id,
      name: `Login for ${user.email}`,
      type: "pat",
      expiresInDays: 30,
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/me", bearer(legacyLogin.token));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "login session must be refreshed",
      code: "reauth_required",
    });
  });

  it("updates only the authenticated user's profile through PATCH /api/me", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const localUser = store.getCurrentUser();
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });
    const workspace = store.createWorkspace({ name: "B Team", slug: "b-team" }, b.userId);
    const legacyWorkspace = store.createWorkspace({ name: "Legacy B Team", slug: "legacy-b-team" }, b.userId);
    const legacyMember = store.listWorkspaceMembers(legacyWorkspace.id).find((member) => member.userId === b.userId)!;
    db!.run("UPDATE multiremi_workspace_members SET user_id = NULL WHERE id = ?", [legacyMember.id]);

    const response = await app.request("/api/me", {
      method: "PATCH",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ name: "B Updated", language: "zh-Hans" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: b.userId, name: "B Updated", language: "zh-Hans" });
    expect(store.getUser(b.userId)).toMatchObject({ name: "B Updated", language: "zh-Hans" });
    expect(store.listWorkspaceMembers(workspace.id).find((member) => member.userId === b.userId)?.name).toBe("B Updated");
    expect(store.getWorkspaceMember(legacyMember.id)?.name).toBe("B Updated");
    expect(store.getCurrentUser()).toEqual(localUser);
  });

  it("updates only the authenticated user's onboarding questionnaire", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const localUser = store.getCurrentUser();
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });

    const response = await app.request("/api/me/onboarding", {
      method: "PATCH",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ questionnaire: { role: "builder" } }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: b.userId,
      onboarding_questionnaire: { role: "builder" },
    });
    expect(store.getUser(b.userId)?.onboardingQuestionnaire).toEqual({ role: "builder" });
    expect(store.getCurrentUser()).toEqual(localUser);
  });

  it("marks only the authenticated user as onboarded", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const localUser = store.getCurrentUser();
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });

    const response = await app.request("/api/me/onboarding/complete", {
      method: "POST",
      ...bearer(b.token),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: b.userId, onboarded_at: expect.any(String) });
    expect(store.getUser(b.userId)?.onboardedAt).toBeString();
    expect(store.getCurrentUser()).toEqual(localUser);
  });

  it("stores cloud waitlist data on the authenticated user", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const localUser = store.getCurrentUser();
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });

    const response = await app.request("/api/me/onboarding/cloud-waitlist", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ email: "b@example.com", reason: "cloud runtime" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: b.userId,
      onboarding_questionnaire: {
        cloud_waitlist_email: "b@example.com",
        cloud_waitlist_reason: "cloud runtime",
      },
    });
    expect(store.getCurrentUser()).toEqual(localUser);
  });

  it("attributes runtime onboarding resources to the authenticated user", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const localUser = store.getCurrentUser();
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });
    const workspace = store.createWorkspace({ name: "B Team", slug: "b-team" }, b.userId);
    const runtime = store.registerRuntime({
      id: "rt_b",
      name: "B Runtime",
      provider: "codex",
      workspaceId: workspace.id,
      ownerId: b.userId,
    });

    const response = await app.request("/api/me/onboarding/runtime-bootstrap", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ workspace_id: workspace.id, runtime_id: runtime.id }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(store.getAgent(body.agent_id)?.ownerId).toBe(b.userId);
    expect(store.getIssue(body.issue_id)?.createdBy).toBe(b.userId);
    expect(store.getUser(b.userId)?.onboardedAt).toBeString();
    expect(store.getCurrentUser()).toEqual(localUser);
  });

  it("attributes no-runtime onboarding to the authenticated user", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const localUser = store.getCurrentUser();
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });
    const workspace = store.createWorkspace({ name: "B Team", slug: "b-team" }, b.userId);

    const response = await app.request("/api/me/onboarding/no-runtime-bootstrap", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ workspace_id: workspace.id }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(store.getIssue(body.issue_id)?.createdBy).toBe(b.userId);
    expect(store.getUser(b.userId)?.onboardedAt).toBeString();
    expect(store.getCurrentUser()).toEqual(localUser);
  });

  it("blocks onboarding bootstrap writes to workspaces the authenticated user cannot access", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });
    const runtime = store.registerRuntime({
      id: "rt_local",
      name: "Local Runtime",
      provider: "codex",
      workspaceId: "local",
      ownerId: "local",
    });

    const runtimeResponse = await app.request("/api/me/onboarding/runtime-bootstrap", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ workspace_id: "local", runtime_id: runtime.id }),
    });
    const noRuntimeResponse = await app.request("/api/me/onboarding/no-runtime-bootstrap", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ workspace_id: "local" }),
    });

    expect(runtimeResponse.status).toBe(404);
    expect(noRuntimeResponse.status).toBe(404);
  });

  it("blocks members from bootstrapping agents on another user's private runtime", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const owner = await login(store, { externalId: "ou_owner", email: "owner@corp.com", name: "Owner" });
    const member = await login(store, { externalId: "ou_member", email: "member@corp.com", name: "Member" });
    const workspace = store.createWorkspace({ name: "Team", slug: "team" }, owner.userId);
    store.createWorkspaceMember({
      workspaceId: workspace.id,
      userId: member.userId,
      name: "Member",
      email: "member@corp.com",
      role: "member",
    });
    const runtime = store.registerRuntime({
      id: "rt_private",
      name: "Private Runtime",
      provider: "codex",
      workspaceId: workspace.id,
      ownerId: owner.userId,
      visibility: "private",
    });

    const response = await app.request("/api/me/onboarding/runtime-bootstrap", {
      method: "POST",
      headers: jsonAuth(member.token),
      body: JSON.stringify({ workspace_id: workspace.id, runtime_id: runtime.id }),
    });

    expect(response.status).toBe(403);
  });

  it("blocks task tokens from current-user profile endpoints", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });
    const victimToken = await store.createAccessToken({
      workspaceId: "local",
      userId: b.userId,
      name: "Victim workspace token",
      type: "pat",
    });
    const taskToken = await store.createAccessToken({
      workspaceId: "local",
      userId: b.userId,
      taskId: "tsk_profile_guard",
      agentId: "agt_profile_guard",
      name: "Task profile guard",
      type: "task",
    });

    const readResponse = await app.request("/api/me", bearer(taskToken.token));
    const writeResponse = await app.request("/api/me", {
      method: "PATCH",
      headers: jsonAuth(taskToken.token),
      body: JSON.stringify({ name: "Compromised" }),
    });
    const encodedWriteResponse = await app.request("/api/%6de", {
      method: "PATCH",
      headers: jsonAuth(taskToken.token),
      body: JSON.stringify({ name: "Compromised Encoded" }),
    });
    const onboardingResponses = await Promise.all([
      app.request("/api/me/onboarding", {
        method: "PATCH",
        headers: jsonAuth(taskToken.token),
        body: JSON.stringify({ questionnaire: { compromised: true } }),
      }),
      app.request("/api/me/onboarding/complete", { method: "POST", ...bearer(taskToken.token) }),
      app.request("/api/me/onboarding/cloud-waitlist", {
        method: "POST",
        headers: jsonAuth(taskToken.token),
        body: JSON.stringify({ email: "task@example.com" }),
      }),
      app.request("/api/me/onboarding/runtime-bootstrap", {
        method: "POST",
        headers: jsonAuth(taskToken.token),
        body: JSON.stringify({ workspace_id: "local", runtime_id: "rt_missing" }),
      }),
      app.request("/api/me/onboarding/no-runtime-bootstrap", {
        method: "POST",
        headers: jsonAuth(taskToken.token),
        body: JSON.stringify({ workspace_id: "local" }),
      }),
    ]);
    const tokenMintResponses = await Promise.all([
      app.request("/api/tokens?workspace_id=local", bearer(taskToken.token)),
      app.request("/api/multiremi/tokens?workspace_id=local", bearer(taskToken.token)),
      app.request("/api/cli-token", { method: "POST", ...bearer(taskToken.token) }),
      app.request("/api/tokens", {
        method: "POST",
        headers: jsonAuth(taskToken.token),
        body: JSON.stringify({ name: "persist task access" }),
      }),
      app.request("/api/%74okens", {
        method: "POST",
        headers: jsonAuth(taskToken.token),
        body: JSON.stringify({ name: "encoded persist task access" }),
      }),
      app.request("/api/tokens/", {
        method: "POST",
        headers: jsonAuth(taskToken.token),
        body: JSON.stringify({ name: "trailing-slash persist task access" }),
      }),
      app.request("/api/tokens/current/renew", { method: "POST", ...bearer(taskToken.token) }),
      app.request("/api/multiremi/tokens", {
        method: "POST",
        headers: jsonAuth(taskToken.token),
        body: JSON.stringify({ name: "native persist task access", workspaceId: "local" }),
      }),
      app.request("/api/multiremi/install/daemon", {
        method: "POST",
        headers: jsonAuth(taskToken.token),
        body: JSON.stringify({ workspaceId: "local" }),
      }),
      app.request(`/api/tokens/${victimToken.id}`, { method: "DELETE", ...bearer(taskToken.token) }),
      app.request(`/api/%74okens/${victimToken.id}`, { method: "DELETE", ...bearer(taskToken.token) }),
      app.request(`/api/multiremi/tokens/${victimToken.id}`, { method: "DELETE", ...bearer(taskToken.token) }),
    ]);

    expect(readResponse.status).toBe(403);
    expect(writeResponse.status).toBe(403);
    expect(encodedWriteResponse.status).toBe(403);
    expect(onboardingResponses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
    expect(tokenMintResponses.map((response) => response.status)).toEqual([
      403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403,
    ]);
    expect(store.getAccessToken(victimToken.id)?.revokedAt).toBeNull();
    expect(store.getUser(b.userId)?.name).toBe("B");
  });

  it("does not treat an authenticated local JWT as the master user", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const b = store.getOrCreateUser({ externalId: "ou_b", email: "b@corp.com", name: "B" });
    const workspace = store.createWorkspace({ name: "B Team", slug: "b-team" }, b.id);
    const runtime = store.registerRuntime({
      id: "rt_b",
      name: "B Runtime",
      provider: "codex",
      workspaceId: workspace.id,
      ownerId: b.id,
    });
    const jwt = signTestJwt({ sub: "local", exp: Math.floor(Date.now() / 1000) + 60 });

    const response = await app.request("/api/me/onboarding/runtime-bootstrap", {
      method: "POST",
      headers: jsonAuth(jwt),
      body: JSON.stringify({ workspace_id: workspace.id, runtime_id: runtime.id }),
    });

    expect(response.status).toBe(404);
  });

  it("uses the JWT subject for current-user reads and writes", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const localUser = store.getCurrentUser();
    const b = store.getOrCreateUser({ externalId: "ou_b", email: "b@corp.com", name: "B" });
    const jwt = signTestJwt({ sub: b.id, exp: Math.floor(Date.now() / 1000) + 60 });

    const readResponse = await app.request("/api/me", bearer(jwt));
    const writeResponse = await app.request("/api/me", {
      method: "PATCH",
      headers: jsonAuth(jwt),
      body: JSON.stringify({ name: "B via JWT" }),
    });

    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({ id: b.id, name: "B" });
    expect(writeResponse.status).toBe(200);
    expect(await writeResponse.json()).toMatchObject({ id: b.id, name: "B via JWT" });
    expect(store.getCurrentUser()).toEqual(localUser);
  });

  it("isolates current-user state between two non-local PAT sessions", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const a = await login(store, { externalId: "ou_a", email: "a@corp.com", name: "A" });
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });

    const [aRead, bRead] = await Promise.all([
      app.request("/api/me", bearer(a.token)),
      app.request("/api/me", bearer(b.token)),
    ]);
    const aWrite = await app.request("/api/me", {
      method: "PATCH",
      headers: jsonAuth(a.token),
      body: JSON.stringify({ name: "A Updated" }),
    });
    const bOnboarding = await app.request("/api/me/onboarding", {
      method: "PATCH",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ questionnaire: { role: "reviewer" } }),
    });

    expect(await aRead.json()).toMatchObject({ id: a.userId, name: "A" });
    expect(await bRead.json()).toMatchObject({ id: b.userId, name: "B" });
    expect(await aWrite.json()).toMatchObject({ id: a.userId, name: "A Updated" });
    expect(await bOnboarding.json()).toMatchObject({
      id: b.userId,
      onboarding_questionnaire: { role: "reviewer" },
    });
    expect(store.getUser(a.userId)?.onboardingQuestionnaire).toEqual({});
    expect(store.getUser(b.userId)?.name).toBe("B");
  });

  it("keeps master-token current-user writes on the legacy local user", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/me", {
      method: "PATCH",
      headers: jsonAuth("root-secret"),
      body: JSON.stringify({ name: "Master Local" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "local", name: "Master Local" });
    expect(store.getCurrentUser().name).toBe("Master Local");
  });

  it("AC1/AC7: preserves the existing owner and creates a distinct user for a second login", async () => {
    const store = freshStore();
    store.getCurrentUser(); // seed the legacy single-user "local" record
    store.ensureLocalWorkspace(); // local workspace + owner member (user "local")
    // Reproduce the production bug where the owner's record got overwritten.
    store.updateCurrentUser({ name: "朱欣文", email: "zhuxinwen@corp.com" });

    // "Deploy" the multi-user migration onto the existing database.
    store.migrate();
    expect(store.getUser("local")?.externalId).toBe(OWNER_OPEN_ID);

    // A (hehuajie) logs in via Feishu -> matched to the existing owner by open_id.
    const a = store.getOrCreateUser({ externalId: OWNER_OPEN_ID, email: "hehuajie@corp.com", name: "贺华杰" });
    expect(a.id).toBe("local");
    expect(a.name).toBe("贺华杰");

    // B (zhuxinwen) logs in with a different open_id -> a distinct new user.
    const b = store.getOrCreateUser({ externalId: "ou_zhuxinwen", email: "z@feishu.local", name: "朱欣文" });
    expect(b.id).not.toBe("local");
    expect(b.id).not.toBe(a.id);

    // B does not overwrite A: two distinct records, A still named 贺华杰.
    expect(store.getUser("local")?.name).toBe("贺华杰");
    expect(store.getUserByExternalId("ou_zhuxinwen")?.id).toBe(b.id);
    expect(store.getUserRoleInWorkspace("local", "local")).toBe("owner");
    expect(store.getUserRoleInWorkspace(b.id, "local")).toBeNull();
  });

  it("AC2: a non-member cannot see the workspace or its runtimes", async () => {
    const store = seedDeployment();
    store.registerRuntime({
      id: "rt_pub", name: "Public", provider: "codex",
      workspaceId: "local", ownerId: "local", visibility: "public",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const b = await login(store, { externalId: "ou_b", email: "b@feishu.local", name: "B" });

    const ws = await app.request("/api/workspaces", bearer(b.token));
    expect(ws.status).toBe(200);
    expect(await ws.json()).toEqual([]);

    expect((await app.request("/api/workspaces/local", bearer(b.token))).status).toBe(404);
    expect((await app.request("/api/multiremi/runtimes", bearer(b.token))).status).toBe(404);
    expect((await app.request("/api/multiremi/runtimes/rt_pub", bearer(b.token))).status).toBe(404);
  });

  it("AC3: the owner sees the workspace and all runtimes", async () => {
    const store = seedDeployment();
    store.registerRuntime({ id: "rt_pub", name: "Public", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "public" });
    store.registerRuntime({ id: "rt_priv", name: "Private", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "private" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const a = await login(store, { externalId: OWNER_OPEN_ID, email: "hehuajie@feishu.local", name: "贺华杰" });
    expect(a.userId).toBe("local");

    const ws = await app.request("/api/workspaces", bearer(a.token));
    expect((await ws.json()).map((w: { id: string }) => w.id)).toContain("local");

    const runtimes = await app.request("/api/multiremi/runtimes", bearer(a.token));
    expect(runtimes.status).toBe(200);
    const ids = (await runtimes.json()).runtimes.map((r: { id: string }) => r.id).sort();
    expect(ids).toEqual(["rt_priv", "rt_pub"]);
  });

  it("AC4: an invited member sees the workspace; public runtime usable, private blocked", async () => {
    const store = seedDeployment();
    store.registerRuntime({ id: "rt_pub", name: "Public", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "public" });
    store.registerRuntime({ id: "rt_priv", name: "Private", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "private" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const owner = await login(store, { externalId: OWNER_OPEN_ID, email: "hehuajie@feishu.local", name: "贺华杰" });
    const b = await login(store, { externalId: "ou_b", email: "b@corp.com", name: "B" });

    // Before invite: B is a non-member and sees nothing.
    expect((await (await app.request("/api/workspaces", bearer(b.token))).json())).toEqual([]);

    // Owner invites B by email.
    const invite = await app.request("/api/workspaces/local/members", {
      method: "POST",
      headers: jsonAuth(owner.token),
      body: JSON.stringify({ email: "b@corp.com", role: "member" }),
    });
    expect(invite.status).toBe(201);
    const invitation = await invite.json();

    // B accepts the invitation as themselves.
    const accept = await app.request(`/api/invitations/${invitation.id}/accept`, { method: "POST", ...bearer(b.token) });
    expect(accept.status).toBe(200);

    // B now sees the workspace.
    const ws = await app.request("/api/workspaces", bearer(b.token));
    expect((await ws.json()).map((w: { id: string }) => w.id)).toContain("local");
    expect(store.getUserRoleInWorkspace(b.userId, "local")).toBe("member");

    // B can use the public runtime.
    const usePublic = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ runtimeId: "rt_pub", workspaceId: "local", provider: "codex" }),
    });
    expect([200, 201]).toContain(usePublic.status);

    // B is blocked from the private runtime.
    const usePrivate = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ runtimeId: "rt_priv", workspaceId: "local", provider: "codex" }),
    });
    expect(usePrivate.status).toBe(403);
    expect((await usePrivate.json()).error).toContain("private");
  });

  it("transcript messages of a private agent's task are owner/admin-only, not workspace-wide", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const owner = await login(store, { externalId: OWNER_OPEN_ID, email: "hehuajie@feishu.local", name: "贺华杰" });
    const b = await login(store, { externalId: "ou_b2", email: "b2@corp.com", name: "B" });

    // B joins the workspace as a plain member.
    const invite = await app.request("/api/workspaces/local/members", {
      method: "POST", headers: jsonAuth(owner.token), body: JSON.stringify({ email: "b2@corp.com", role: "member" }),
    });
    const invitation = await invite.json();
    await app.request(`/api/invitations/${invitation.id}/accept`, { method: "POST", ...bearer(b.token) });

    // Owner's PRIVATE agent runs a task that records transcript messages.
    const agent = store.createAgent({ name: "Secret", provider: "claude", workspaceId: "local", ownerId: "local", visibility: "private" });
    const issue = store.createIssue({ title: "secret work", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "x" });
    store.appendTaskMessages(task.id, [{ type: "tool_use", tool: "Bash", input: { command: "cat ~/.aws/credentials" } }]);

    // B (member, not owner/admin) is denied; owner sees the messages.
    const bResp = await app.request(`/api/tasks/${task.id}/messages`, bearer(b.token));
    expect(bResp.status).toBe(403);
    const ownerResp = await app.request(`/api/tasks/${task.id}/messages`, bearer(owner.token));
    expect(ownerResp.status).toBe(200);
    expect((await ownerResp.json()).length).toBe(1);
  });

  it("FR4: a new user creates a workspace, becomes its owner, and can open it with their login token", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const b = await login(store, { externalId: "ou_b", email: "b@feishu.local", name: "B" });

    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ name: "B Team" }),
    });
    expect(created.status).toBe(201);
    const workspace = await created.json();

    // The creator — not the legacy "local" owner — owns the new workspace.
    expect(store.getUserRoleInWorkspace(b.userId, workspace.id)).toBe("owner");
    expect(store.getUserRoleInWorkspace("local", workspace.id)).toBeNull();

    // The workspace shows up in their list and opens with the login token
    // (which was minted under the "local" workspace before this one existed).
    const list = await app.request("/api/workspaces", bearer(b.token));
    expect((await list.json()).map((w: { id: string }) => w.id)).toEqual([workspace.id]);
    expect((await app.request(`/api/workspaces/${workspace.id}`, bearer(b.token))).status).toBe(200);

    // Membership stays the authority: the legacy local workspace is still hidden.
    expect((await app.request("/api/workspaces/local", bearer(b.token))).status).toBe(404);
  });

  it("add computer: a new user mints a real setup token for their own workspace", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const b = await login(store, { externalId: "ou_b", email: "b@feishu.local", name: "B" });
    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ name: "B Team" }),
    });
    const workspace = await created.json();

    // Mimic the dashboard dialog exactly: no workspace in the body, the current
    // workspace only present as the X-Workspace-Slug header.
    const minted = await app.request("/api/tokens", {
      method: "POST",
      headers: { ...jsonAuth(b.token), "X-Workspace-Slug": workspace.slug },
      body: JSON.stringify({ name: "Remi daemon 2026-07-06", expires_in_days: 365 }),
    });
    expect(minted.status).toBe(201);
    const token = await minted.json();
    expect(token.token).toStartWith("mul_");
    // Bound to the requester and their workspace — never a user-less admin token,
    // even if the body tries to spoof another identity.
    expect(token.userId).toBe(b.userId);
    expect(token.workspaceId).toBe(workspace.id);
    const spoofed = await app.request("/api/tokens", {
      method: "POST",
      headers: { ...jsonAuth(b.token), "X-Workspace-Slug": workspace.slug },
      body: JSON.stringify({ name: "spoof", userId: "local", purpose: "session" }),
    });
    expect(await spoofed.json()).toMatchObject({ userId: b.userId, purpose: "workspace" });
    const nativeSpoofed = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ name: "native spoof", workspaceId: workspace.id, userId: "local", purpose: "session" }),
    });
    expect(await nativeSpoofed.json()).toMatchObject({
      token: { userId: b.userId, workspaceId: workspace.id, purpose: "workspace" },
    });
    expect((await app.request("/api/cli-token", { method: "POST", ...bearer(b.token) })).status).toBe(404);

    // Without any workspace context the default is still the local workspace,
    // which stays members-only.
    const noContext = await app.request("/api/tokens", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ name: "no context" }),
    });
    expect(noContext.status).toBe(404);
  });

  it("AC6: email-code login is disabled by default and enabled by flag; Feishu SSO stays reachable", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const disabled = await app.request("/auth/send-code", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "anyone@example.com" }),
    });
    expect(disabled.status).toBe(403);

    // The Feishu SSO url endpoint stays public (reachable without auth); it is
    // just unconfigured in tests, so it answers 503 rather than 401/403.
    const larkUrl = await app.request("/auth/lark/url?redirect_uri=https%3A%2F%2Fx");
    expect(larkUrl.status).toBe(503);

    process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN = "1";
    const enabled = await app.request("/auth/send-code", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "anyone@example.com" }),
    });
    expect(enabled.status).toBe(200);
  });

  it("FR8: a daemon token owns the runtimes it registers, and re-registration never hijacks the owner", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    // A daemon token minted for a specific user (as `remi setup` would).
    const daemonToken = await store.createAccessToken({
      workspaceId: "local",
      userId: "usr_setup_user",
      daemonId: "daemon-1",
      name: "Daemon 1",
      type: "daemon",
    });

    const first = await app.request("/api/daemon/register", {
      method: "POST",
      headers: jsonAuth(daemonToken.token),
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-1", runtimes: [{ type: "codex", version: "1.0.0" }] }),
    });
    expect(first.status).toBe(200);
    const runtimeId = (await first.json()).runtimes[0].id;
    expect(store.getRuntime(runtimeId)?.ownerId).toBe("usr_setup_user");

    // A different daemon token (owned by someone else) re-registers the same
    // runtime; ownership must not change.
    const otherDaemon = await store.createAccessToken({
      workspaceId: "local", userId: "usr_other", daemonId: "daemon-1", name: "Daemon other", type: "daemon",
    });
    const second = await app.request("/api/daemon/register", {
      method: "POST",
      headers: jsonAuth(otherDaemon.token),
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-1", runtimes: [{ type: "codex", version: "1.0.1" }] }),
    });
    expect(second.status).toBe(200);
    expect(store.getRuntime(runtimeId)?.ownerId).toBe("usr_setup_user");
  });
});
