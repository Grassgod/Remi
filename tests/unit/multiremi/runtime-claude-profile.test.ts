import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { parseRuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const profile = { name: "private", base_url: "http://127.0.0.1:8000/v1", model: "custom-model", env_key: "REMI_CLAUDE_TEST_KEY", auth_mode: "env" as const, auth_header: "bearer" as const };
const apiProfile = { ...profile, env_key: "", auth_mode: "api_key" as const };
const originalKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalKey;
  resetMultiremiTestEnv();
});

function setup() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ id: "rt_custom", name: "Custom", provider: "claude", daemonId: "custom-daemon", workspaceId: "local", ownerId: "local", metadata: { claude_profiles: 1 } });
  return { store, runtime };
}

describe("Runtime Claude profiles", () => {
  it("allows Runtime-local URLs and rejects credentials or unrelated environment references", () => {
    expect(parseRuntimeClaudeProfile(profile)).toEqual(profile);
    for (const patch of [
      { base_url: "https://user:secret@example.com/v1" }, { base_url: "https://example.com?api_key=secret" },
      { base_url: "file:///tmp/config" }, { env_key: "MULTIREMI_TOKEN" }, { name: "../outside" },
      { api_key: "inline-secret" }, { model: "" }, { auth_mode: "other" },
    ]) expect(() => parseRuntimeClaudeProfile({ ...profile, ...patch })).toThrow();
  });

  it("preserves discovered models and the configured default across registration", () => {
    const { store, runtime } = setup();
    store.setRuntimeClaudeProfile(runtime.id, profile);
    store.registerRuntime({ id: runtime.id, name: runtime.name, provider: "claude", daemonId: runtime.daemonId, workspaceId: "local", ownerId: "local", metadata: { claude_profiles: 1 } });
    store.updateRuntimeModels(runtime.id, [{ id: "old-default", label: "Old", provider: "claude", default: true }], profile);
    expect(store.getRuntimeClaudeProfile(runtime.id)).toEqual(profile);
    expect(store.listRuntimeModels(runtime.id).map(model => [model.id, model.default])).toEqual([[profile.model, true], ["old-default", false]]);
    expect(store.listWorkspaceClaudeProfileModels("local").sort()).toEqual([profile.model, "old-default"].sort());
    store.setRuntimeClaudeProfile(runtime.id, null);
    expect(store.getRuntimeClaudeProfile(runtime.id)).toBeNull();
    expect(store.listRuntimeModels(runtime.id)).toEqual([]);
  });

  it("ignores stale and legacy model reports across connection changes and clearing", () => {
    const { store, runtime } = setup();
    store.setRuntimeClaudeProfile(runtime.id, profile);
    const discovered = [{ id: "custom-alternative", label: "Alternative", provider: "claude", default: false }];
    store.updateRuntimeModels(runtime.id, discovered, profile);
    const catalog = store.listRuntimeModels(runtime.id);
    store.updateRuntimeModels(runtime.id, [{ id: "legacy", label: "Legacy", provider: "claude", default: false }]);
    store.updateRuntimeModels(runtime.id, [{ id: "native", label: "Native", provider: "claude", default: false }], null);
    expect(store.listRuntimeModels(runtime.id)).toEqual(catalog);
    const changed = { ...profile, base_url: "https://changed.example/v1" };
    store.setRuntimeClaudeProfile(runtime.id, changed);
    store.updateRuntimeModels(runtime.id, discovered, profile);
    expect(store.listRuntimeModels(runtime.id).map(model => model.id)).toEqual([profile.model]);
    const refresh = store.createRuntimeModelListRequest(runtime.id);
    const rejected = store.reportRuntimeModelListResult(runtime.id, refresh.id, { status: "completed", models: discovered, model_profile: profile });
    expect(rejected.status).toBe("failed");
    expect(rejected.error).toContain("connection changed");
    store.updateRuntimeModels(runtime.id, discovered, changed);
    expect(store.listRuntimeModels(runtime.id).map(model => model.id)).toEqual([profile.model, "custom-alternative"]);
    store.setRuntimeClaudeProfile(runtime.id, null);
    store.updateRuntimeModels(runtime.id, discovered, changed);
    expect(store.listRuntimeModels(runtime.id)).toEqual([]);
    store.updateRuntimeModels(runtime.id, [{ id: "native", label: "Native", provider: "claude", default: false }], null);
    expect(store.listRuntimeModels(runtime.id).map(model => model.id)).toEqual(["native"]);
  });

  it("reports the full refreshed catalog to task credentials and accepts a discovered model", async () => {
    const { store, runtime } = setup();
    store.setRuntimeClaudeProfile(runtime.id, profile);
    const refresh = store.createRuntimeModelListRequest(runtime.id);
    store.reportRuntimeModelListResult(runtime.id, refresh.id, {
      status: "completed", supported: true, model_profile: profile,
      models: [{ id: "custom-alternative", label: "Alternative", provider: "claude", default: true }],
    });
    expect(store.getRuntimeModelListRequest(runtime.id, refresh.id)?.models).toEqual(store.listRuntimeModels(runtime.id));
    const assistant = store.createAgent({ name: "Assistant", provider: "claude" });
    const task = store.createTask({ agentId: assistant.id, prompt: "list models" });
    const token = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "profile-master" });
    const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
    const listed = await app.request(`/api/runtimes/${runtime.id}/models`, { headers });
    expect(listed.status).toBe(200);
    expect((await listed.json()).models.map((model: { id: string }) => model.id)).toEqual([profile.model, "custom-alternative"]);
    store.setRelayModelDiscovery("local", true);
    const revision = store.upsertRelayConfig("local", "claude", {
      fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } }),
      tokenOp: "set", authToken: "test-token",
    });
    store.saveGatewayModels("local", "claude", { sourceRevision: revision, models: [{ id: "gateway-model", label: "Gateway" }] });
    const fleet = await (await app.request("/api/models", { headers })).json();
    expect(fleet.providers.find((entry: { provider: string }) => entry.provider === "claude").models.map((model: { id: string }) => model.id).sort())
      .toEqual([profile.model, "custom-alternative", "gateway-model"].sort());
    const created = await app.request("/api/agents", {
      method: "POST", headers,
      body: JSON.stringify({ name: "Selected alternative", provider: "claude", model: "custom-alternative" }),
    });
    expect(created.status).toBe(201);
  });

  it("freezes the selected model and restarts the session when the selection changes", () => {
    const { store, runtime } = setup();
    store.setRuntimeClaudeProfile(runtime.id, profile);
    store.updateRuntimeModels(runtime.id, [{ id: "custom-alternative", label: "Alternative", provider: "claude", default: false }], profile);
    const agent = store.createAgent({ name: "Custom", provider: "claude", model: "custom-alternative" });
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "first" }).task;
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.claudeProfile).toEqual({ ...profile, model: "custom-alternative" });
    expect(store.getRuntimeClaudeProfile(runtime.id)).toEqual(profile);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "first", sessionId: "alternative-session" });
    const second = store.sendChatMessage(chat.id, { body: "second" }).task;
    expect(second.sessionId).toBe("alternative-session");
    store.updateAgent(agent.id, { model: null });
    const changed = store.claimTask(runtime.id)!;
    expect(changed.id).toBe(second.id);
    expect(changed.sessionId).toBeNull();
    expect(changed.claudeProfile).toEqual(profile);
    expect(changed.executionFingerprint).not.toBe(claimed.executionFingerprint);
    expect(store.getTask(first.id)?.claudeProfile).toEqual({ ...profile, model: "custom-alternative" });
  });

  it("gates old daemons and other engines", () => {
    const { store, runtime } = setup();
    store.updateRuntime(runtime.id, { metadata: { claude_profiles: 0 } });
    expect(() => store.setRuntimeClaudeProfile(runtime.id, profile)).toThrow("Update and restart");
    const other = store.registerRuntime({ name: "Claude", provider: "codex" });
    expect(() => store.setRuntimeClaudeProfile(other.id, profile)).toThrow("Claude Code Runtime");
  });

  it("keeps a stable chat session, then bootstraps after a connection change or clear", () => {
    const { store, runtime } = setup();
    store.setRuntimeClaudeProfile(runtime.id, profile);
    const agent = store.createAgent({ name: "Custom", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "first" }).task;
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(first.id);
    expect(claimed.claudeProfile).toEqual(profile);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "first", sessionId: "custom-session" });
    const second = store.sendChatMessage(chat.id, { body: "second" }).task;
    expect(second.sessionId).toBe("custom-session");
    expect(store.claimTask(runtime.id)?.sessionId).toBe("custom-session");
    store.startTask(second.id);
    store.completeTask(second.id, { output: "second", sessionId: "custom-session" });
    store.setRuntimeClaudeProfile(runtime.id, { ...profile, base_url: "https://changed.example/v1" });
    const third = store.sendChatMessage(chat.id, { body: "third" }).task;
    expect(third.sessionId).toBeNull();
    const changed = store.claimTask(runtime.id)!;
    expect(changed.executionFingerprint).not.toBe(claimed.executionFingerprint);
    expect(changed.sessionId).toBeNull();
    store.startTask(third.id);
    store.completeTask(third.id, { output: "third", sessionId: "new-session" });
    store.setRuntimeClaudeProfile(runtime.id, null);
    const cleared = store.sendChatMessage(chat.id, { body: "fourth" }).task;
    expect(cleared.sessionId).toBeNull();
    expect(store.claimTask(runtime.id)?.claudeProfile).toBeNull();
  });

  it("freezes routing and credential versions for retries, including resume-unsafe failures", () => {
    const { store, runtime } = setup();
    process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const saved = store.setRuntimeClaudeProfile(runtime.id, apiProfile, "first-private-key")!;
    store.updateRuntimeModels(runtime.id, [{ id: "custom-alternative", label: "Alternative", provider: "claude", default: false }], saved);
    const agent = store.createAgent({ name: "Custom", provider: "claude", model: "custom-alternative" });
    const frozen = { ...saved, model: "custom-alternative" };
    const task = store.createTask({ agentId: agent.id, issueId: store.createIssue({ title: "Retry profile" }).id, prompt: "work" });
    const claimed = store.claimTask(runtime.id)!;
    store.startTask(task.id);
    store.updateAgent(agent.id, { model: "another-model" });
    store.setRuntimeClaudeProfile(runtime.id, { ...apiProfile, base_url: "https://new.example/v1" }, "replacement-key");
    expect(store.getTask(task.id)?.claudeProfile).toEqual(frozen);
    store.failTask(task.id, { error: "stalled", failureReason: "agent_error.stale_session" });
    const retry = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
    expect(retry.claudeProfile).toEqual(frozen);
    expect(retry.runtimeId).toBe(runtime.id);
    expect(retry.executionFingerprint).toBe(claimed.executionFingerprint);
    expect(store.getRuntimeClaudeProfileKey(runtime.id, retry.claudeProfile!.credential_id!)).toBe("first-private-key");
    const later = store.createTask({ agentId: agent.id, prompt: "Needs the new model", priority: 10 });
    expect(store.claimTask(runtime.id)?.claudeProfile).toEqual(frozen);
    expect(store.getTask(later.id)?.status).toBe("queued");
  });

  it("encrypts keys and restricts delivery to the bound daemon, never browser or task credentials", async () => {
    const { store, runtime } = setup();
    process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    store.createWorkspaceMember({ id: "profile-member", userId: "profile-member", workspaceId: "local", name: "Member", role: "member" });
    const owner = await store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "local" });
    const member = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "profile-member" });
    const daemon = await store.createAccessToken({ name: "Daemon", type: "daemon", workspaceId: "local", daemonId: "custom-daemon", userId: "local" });
    const wrongDaemon = await store.createAccessToken({ name: "Other", type: "daemon", workspaceId: "local", daemonId: "another-daemon", userId: "local" });
    const agent = store.createAgent({ name: "Task", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "work" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "profile-master" });
    const request = (path: string, token: string, body?: unknown) => app.request(path, { method: body ? "PUT" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const path = `/api/runtimes/${runtime.id}/claude-profile`;
    const body = { profile: apiProfile, api_key: "super-private-provider-key" };
    expect((await request(path, member.token, body)).status).toBe(403);
    expect((await request(path, taskToken.token, body)).status).toBe(403);
    expect((await request(path, daemon.token, body)).status).toBe(403);
    const saved = await request(path, owner.token, body);
    expect(saved.status).toBe(200);
    const wire = await saved.json();
    expect(JSON.stringify(wire)).not.toContain(body.api_key);
    expect(JSON.stringify(db!.query("SELECT * FROM multiremi_runtime_provider_credentials").all())).not.toContain(body.api_key);
    const secretPath = `/api/daemon/runtimes/${runtime.id}/claude-profile-key?credential_id=${wire.profile.credential_id}`;
    for (const token of [owner.token, member.token, taskToken.token, wrongDaemon.token]) expect((await request(secretPath, token)).status).toBe(403);
    const key = await request(secretPath, daemon.token);
    expect(key.status).toBe(200);
    expect(key.headers.get("cache-control")).toBe("no-store");
    expect(await key.json()).toEqual({ api_key: body.api_key });
    expect((await request(path, taskToken.token)).status).toBe(403);
    expect(await (await request(path, owner.token, { profile: { ...apiProfile, credential_id: "rck_forged" } })).json()).toEqual(wire);
    expect((await request(secretPath.replace(wire.profile.credential_id, "rck_missing"), daemon.token)).status).toBe(404);
  });

  it("does not let a downgraded daemon claim a frozen custom-profile retry after configuration is cleared", () => {
    const { store, runtime } = setup();
    store.setRuntimeClaudeProfile(runtime.id, profile);
    const agent = store.createAgent({ name: "Custom", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, issueId: store.createIssue({ title: "Downgrade retry" }).id, prompt: "work" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.failTask(task.id, { error: "stalled", failureReason: "agent_error.stale_session" });
    const retry = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
    store.setRuntimeClaudeProfile(runtime.id, null);
    store.updateRuntime(runtime.id, { metadata: { claude_profiles: 0 } });
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(retry.id)?.status).toBe("queued");
    store.updateRuntime(runtime.id, { metadata: { claude_profiles: 1 } });
    expect(store.claimTask(runtime.id)?.claudeProfile).toEqual(profile);
  });

  it("rebinds encrypted credential versions when Runtime identities are merged", () => {
    const { store, runtime } = setup();
    process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const first = store.setRuntimeClaudeProfile(runtime.id, apiProfile, "historical-key")!;
    const current = store.setRuntimeClaudeProfile(runtime.id, apiProfile, "current-key")!;
    const replacement = store.registerRuntime({ id: "rt_replacement", name: "Replacement", provider: "claude", daemonId: runtime.daemonId, workspaceId: "local", ownerId: "local", metadata: { claude_profiles: 1 } });
    store.mergeRuntimeInto(runtime.id, replacement.id);
    expect(store.getRuntimeClaudeProfile(replacement.id)).toEqual(current);
    expect(store.getRuntimeClaudeProfileKey(replacement.id, first.credential_id!)).toBe("historical-key");
    expect(store.getRuntimeClaudeProfileKey(replacement.id, current.credential_id!)).toBe("current-key");
    expect(store.getRuntimeClaudeProfileKey(runtime.id, current.credential_id!)).toBeNull();
  });

  it("removes configuration and historical keys with the Runtime", () => {
    const { store, runtime } = setup();
    process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    store.setRuntimeClaudeProfile(runtime.id, apiProfile, "delete-key");
    store.registerRuntime({ name: "Other engine", provider: "claude", daemonId: runtime.daemonId, workspaceId: "local", ownerId: "local" });
    expect(store.deleteRuntime(runtime.id)).toBe(true);
    expect(db!.query("SELECT * FROM multiremi_runtime_provider_credentials").all()).toEqual([]);
    expect(db!.query("SELECT * FROM multiremi_runtime_claude_profiles").all()).toEqual([]);
  });
});
