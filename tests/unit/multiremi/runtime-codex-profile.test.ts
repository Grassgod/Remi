import { runtimeProviderProfileCases } from "./runtime-provider-profile-cases.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

const profile = { name: "private", base_url: "http://127.0.0.1:8000/v1", model: "custom-model", env_key: "REMI_CODEX_TEST_KEY", auth_mode: "env" as const };
const apiProfile = { ...profile, env_key: "", auth_mode: "api_key" as const };

function setup() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ id: "rt_custom", name: "Custom", provider: "codex", daemonId: "custom-daemon", workspaceId: "local", ownerId: "local", metadata: { codex_profiles: 1 } });
  return { store, runtime };
}

runtimeProviderProfileCases("codex");

describe("Runtime Codex profile-only retry rules", () => {
  const originalKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  afterEach(() => {
    if (originalKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
    else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalKey;
    resetMultiremiTestEnv();
  });
  it("rechecks current thinking against the frozen model before claiming a profile retry", () => {
    const { store, runtime } = setup();
    store.setRuntimeCodexProfile(runtime.id, profile);
    store.updateRuntimeModels(runtime.id, [{ id: "custom-alternative", label: "Alternative", provider: "codex",
      default: false, thinking: { supportedLevels: [{ value: "low", label: "Low" }] } }], profile);
    const agent = store.createAgent({ name: "Custom", provider: "codex", model: "custom-alternative", thinkingLevel: "low" });
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "First" }).task;
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.failTask(first.id, { error: "Runtime unavailable", failureReason: "runtime_offline" });
    const retry = store.listTasks().find(task => task.parentTaskId === first.id)!;
    store.updateAgent(agent.id, { thinkingLevel: "high" });
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(retry.id)?.status).toBe("queued");
    store.updateAgent(agent.id, { thinkingLevel: "low" });
    expect(store.claimTask(runtime.id)).toMatchObject({
      id: retry.id, codexProfile: { ...profile, model: "custom-alternative" }, agent: { thinkingLevel: "low" },
    });
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

});
