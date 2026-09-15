import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { parseRuntimeCodexProfile } from "@multiremi/contracts/codex-profile";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const profile = { name: "private", base_url: "http://127.0.0.1:8000/v1", model: "custom-model", env_key: "REMI_CODEX_TEST_KEY", auth_mode: "env" as const };
const apiProfile = { ...profile, env_key: "", auth_mode: "api_key" as const };
const originalKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalKey;
  resetMultiremiTestEnv();
});

function setup() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ id: "rt_custom", name: "Custom", provider: "codex", daemonId: "custom-daemon", workspaceId: "local", ownerId: "local", metadata: { codex_profiles: 1 } });
  return { store, runtime };
}

describe("Runtime Codex profiles", () => {
  it("allows Runtime-local URLs and rejects credentials or unrelated environment references", () => {
    expect(parseRuntimeCodexProfile(profile)).toEqual(profile);
    for (const patch of [
      { base_url: "https://user:secret@example.com/v1" }, { base_url: "https://example.com?api_key=secret" },
      { base_url: "file:///tmp/config" }, { env_key: "MULTIREMI_TOKEN" }, { name: "../outside" },
      { api_key: "inline-secret" }, { model: "" }, { auth_mode: "other" },
    ]) expect(() => parseRuntimeCodexProfile({ ...profile, ...patch })).toThrow();
  });

  it("preserves connection configuration across registration and stale model reports", () => {
    const { store, runtime } = setup();
    store.setRuntimeCodexProfile(runtime.id, profile);
    store.registerRuntime({ id: runtime.id, name: runtime.name, provider: "codex", daemonId: runtime.daemonId, workspaceId: "local", ownerId: "local", metadata: { codex_profiles: 1 } });
    store.updateRuntimeModels(runtime.id, [{ id: "old-default", label: "Old", provider: "codex", default: true }]);
    expect(store.getRuntimeCodexProfile(runtime.id)).toEqual(profile);
    expect(store.listRuntimeModels(runtime.id).map(model => model.id)).toEqual([profile.model]);
    store.setRuntimeCodexProfile(runtime.id, null);
    expect(store.getRuntimeCodexProfile(runtime.id)).toBeNull();
    expect(store.listRuntimeModels(runtime.id)).toEqual([]);
  });

  it("gates old daemons and other engines", () => {
    const { store, runtime } = setup();
    store.updateRuntime(runtime.id, { metadata: { codex_profiles: 0 } });
    expect(() => store.setRuntimeCodexProfile(runtime.id, profile)).toThrow("Update and restart");
    const other = store.registerRuntime({ name: "Claude", provider: "claude" });
    expect(() => store.setRuntimeCodexProfile(other.id, profile)).toThrow("Codex Runtime");
  });

  it("keeps a stable chat session, then bootstraps after a connection change or clear", () => {
    const { store, runtime } = setup();
    store.setRuntimeCodexProfile(runtime.id, profile);
    const agent = store.createAgent({ name: "Custom", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "first" }).task;
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(first.id);
    expect(claimed.codexProfile).toEqual(profile);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "first", sessionId: "custom-session" });
    const second = store.sendChatMessage(chat.id, { body: "second" }).task;
    expect(second.sessionId).toBe("custom-session");
    expect(store.claimTask(runtime.id)?.sessionId).toBe("custom-session");
    store.startTask(second.id);
    store.completeTask(second.id, { output: "second", sessionId: "custom-session" });
    store.setRuntimeCodexProfile(runtime.id, { ...profile, base_url: "https://changed.example/v1" });
    const third = store.sendChatMessage(chat.id, { body: "third" }).task;
    expect(third.sessionId).toBeNull();
    const changed = store.claimTask(runtime.id)!;
    expect(changed.executionFingerprint).not.toBe(claimed.executionFingerprint);
    expect(changed.sessionId).toBeNull();
    store.startTask(third.id);
    store.completeTask(third.id, { output: "third", sessionId: "new-session" });
    store.setRuntimeCodexProfile(runtime.id, null);
    const cleared = store.sendChatMessage(chat.id, { body: "fourth" }).task;
    expect(cleared.sessionId).toBeNull();
    expect(store.claimTask(runtime.id)?.codexProfile).toBeNull();
  });

  it("freezes routing and credential versions for retries, including resume-unsafe failures", () => {
    const { store, runtime } = setup();
    process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const saved = store.setRuntimeCodexProfile(runtime.id, apiProfile, "first-private-key")!;
    const agent = store.createAgent({ name: "Custom", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, issueId: store.createIssue({ title: "Retry profile" }).id, prompt: "work" });
    const claimed = store.claimTask(runtime.id)!;
    store.startTask(task.id);
    store.setRuntimeCodexProfile(runtime.id, { ...apiProfile, base_url: "https://new.example/v1" }, "replacement-key");
    expect(store.getTask(task.id)?.codexProfile).toEqual(saved);
    store.failTask(task.id, { error: "stalled", failureReason: "codex_semantic_inactivity" });
    const retry = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
    expect(retry.codexProfile).toEqual(saved);
    expect(retry.runtimeId).toBe(runtime.id);
    expect(retry.executionFingerprint).toBe(claimed.executionFingerprint);
    expect(store.getRuntimeCodexProfileKey(runtime.id, retry.codexProfile!.credential_id!)).toBe("first-private-key");
    expect(store.claimTask(runtime.id)?.codexProfile).toEqual(saved);
  });

  for (const provider of ["codex", "claude"] as const) {
    for (const change of ["provider", "runtime-owner"] as const) {
      it(`re-pools ${provider} profile retries after ${change} changes make the original Runtime incompatible`, () => {
        const store = createLocalStore();
        process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
        const runtime = store.registerRuntime({ name: "Original", provider, ownerId: "local", metadata: { [`${provider}_profiles`]: 1 } });
        const nextProvider = change === "provider" ? (provider === "codex" ? "claude" : "codex") : provider;
        const replacement = store.registerRuntime({ name: "Replacement", provider: nextProvider, ownerId: "local", metadata: { [`${nextProvider}_profiles`]: 1 } });
        if (provider === "codex") store.setRuntimeCodexProfile(runtime.id, apiProfile, "original-runtime-key");
        else store.setRuntimeClaudeProfile(runtime.id, apiProfile, "original-runtime-key");
        const agent = store.createAgent({ name: "Custom", provider });
        const chat = store.createChatSession({ agentId: agent.id });
        const task = store.sendChatMessage(chat.id, { body: "work" }).task;
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);
        store.startTask(task.id);
        if (change === "provider") store.updateAgent(agent.id, { provider: nextProvider });
        else store.updateRuntime(runtime.id, { ownerId: "other-owner" });
        store.failTask(task.id, { error: "stale session", failureReason: "agent_error.stale_session" });
        const retry = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
        expect(retry.runtimeId).toBeNull();
        expect(retry.codexProfile).toBeNull();
        expect(retry.claudeProfile).toBeNull();
        expect(retry.executionFingerprint).toBeNull();
        expect(store.claimTask(runtime.id)).toBeNull();
        const claimed = store.claimTask(replacement.id)!;
        expect(claimed.id).toBe(retry.id);
        expect(claimed.provider).toBe(nextProvider);
        expect(claimed.codexProfile).toBeNull();
        expect(claimed.claudeProfile).toBeNull();
      });
    }
  }

  it("encrypts keys and restricts delivery to the bound daemon, never browser or task credentials", async () => {
    const { store, runtime } = setup();
    process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    store.createWorkspaceMember({ id: "profile-member", userId: "profile-member", workspaceId: "local", name: "Member", role: "member" });
    const owner = await store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "local" });
    const member = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "profile-member" });
    const daemon = await store.createAccessToken({ name: "Daemon", type: "daemon", workspaceId: "local", daemonId: "custom-daemon", userId: "local" });
    const wrongDaemon = await store.createAccessToken({ name: "Other", type: "daemon", workspaceId: "local", daemonId: "another-daemon", userId: "local" });
    const agent = store.createAgent({ name: "Task", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "work" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "profile-master" });
    const request = (path: string, token: string, body?: unknown) => app.request(path, { method: body ? "PUT" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const path = `/api/runtimes/${runtime.id}/codex-profile`;
    const body = { profile: apiProfile, api_key: "super-private-provider-key" };
    expect((await request(path, member.token, body)).status).toBe(403);
    expect((await request(path, taskToken.token, body)).status).toBe(403);
    expect((await request(path, daemon.token, body)).status).toBe(403);
    const saved = await request(path, owner.token, body);
    expect(saved.status).toBe(200);
    const wire = await saved.json();
    expect(JSON.stringify(wire)).not.toContain(body.api_key);
    expect(JSON.stringify(db!.query("SELECT * FROM multiremi_runtime_provider_credentials").all())).not.toContain(body.api_key);
    const secretPath = `/api/daemon/runtimes/${runtime.id}/codex-profile-key?credential_id=${wire.profile.credential_id}`;
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
    store.setRuntimeCodexProfile(runtime.id, profile);
    const agent = store.createAgent({ name: "Custom", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, issueId: store.createIssue({ title: "Downgrade retry" }).id, prompt: "work" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.failTask(task.id, { error: "stalled", failureReason: "codex_semantic_inactivity" });
    const retry = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
    store.setRuntimeCodexProfile(runtime.id, null);
    store.updateRuntime(runtime.id, { metadata: { codex_profiles: 0 } });
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(retry.id)?.status).toBe("queued");
    store.updateRuntime(runtime.id, { metadata: { codex_profiles: 1 } });
    expect(store.claimTask(runtime.id)?.codexProfile).toEqual(profile);
  });

  it("rebinds encrypted credential versions when Runtime identities are merged", () => {
    const { store, runtime } = setup();
    process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const first = store.setRuntimeCodexProfile(runtime.id, apiProfile, "historical-key")!;
    const current = store.setRuntimeCodexProfile(runtime.id, apiProfile, "current-key")!;
    const replacement = store.registerRuntime({ id: "rt_replacement", name: "Replacement", provider: "codex", daemonId: runtime.daemonId, workspaceId: "local", ownerId: "local", metadata: { codex_profiles: 1 } });
    store.mergeRuntimeInto(runtime.id, replacement.id);
    expect(store.getRuntimeCodexProfile(replacement.id)).toEqual(current);
    expect(store.getRuntimeCodexProfileKey(replacement.id, first.credential_id!)).toBe("historical-key");
    expect(store.getRuntimeCodexProfileKey(replacement.id, current.credential_id!)).toBe("current-key");
    expect(store.getRuntimeCodexProfileKey(runtime.id, current.credential_id!)).toBeNull();
  });

  it("removes configuration and historical keys with the Runtime", () => {
    const { store, runtime } = setup();
    process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    store.setRuntimeCodexProfile(runtime.id, apiProfile, "delete-key");
    store.registerRuntime({ name: "Other engine", provider: "claude", daemonId: runtime.daemonId, workspaceId: "local", ownerId: "local" });
    expect(store.deleteRuntime(runtime.id)).toBe(true);
    expect(db!.query("SELECT * FROM multiremi_runtime_provider_credentials").all()).toEqual([]);
    expect(db!.query("SELECT * FROM multiremi_runtime_codex_profiles").all()).toEqual([]);
  });
});
