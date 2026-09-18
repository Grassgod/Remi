import { afterEach, describe, expect, it } from "bun:test";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const originalEncryptionKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalEncryptionKey;
  resetMultiremiTestEnv();
});

const FROZEN_MODEL = "frozen-selection";
const CURRENT_MODEL = "current-selection";
const thinking = { status: "supported" as const, supportedLevels: [{ value: "high", label: "High" }] };
type Provider = "codex" | "claude";

function fixture(provider: Provider, destinationModel: string, customDestination: boolean) {
  const store = createLocalStore();
  const metadata = { codex_profiles: 1, claude_profiles: 1, agent_plugin_protocol: 1 };
  const previous = store.registerRuntime({ name: "Previous", provider, daemonId: "previous", metadata });
  const destination = store.registerRuntime({ name: "Destination", provider, daemonId: "destination", metadata });
  const profile = {
    name: "previous", base_url: "https://previous.example/v1", model: FROZEN_MODEL,
    env_key: provider === "codex" ? "REMI_CODEX_TRANSITION_TEST" : "REMI_CLAUDE_TRANSITION_TEST",
    auth_mode: "env" as const,
  };
  const saved = provider === "codex"
    ? store.setRuntimeCodexProfile(previous.id, profile)!
    : store.setRuntimeClaudeProfile(previous.id, profile)!;
  store.updateRuntimeModels(previous.id, [{ id: FROZEN_MODEL, label: FROZEN_MODEL, provider, default: true, thinking }], saved);
  const nextProfile = customDestination ? { ...profile, name: "destination", base_url: "https://destination.example/v1", model: "destination-default" } : null;
  const nextSaved = provider === "codex"
    ? store.setRuntimeCodexProfile(destination.id, nextProfile)
    : store.setRuntimeClaudeProfile(destination.id, nextProfile);
  store.updateRuntimeModels(destination.id, [{
    id: destinationModel, label: destinationModel, provider, default: true, thinking, catalog: { status: "ready" },
  }], nextSaved);

  const agent = store.createAgent({ name: "Chat", provider, model: FROZEN_MODEL, thinkingLevel: "high" });
  const project = store.createProject({ title: "Project" });
  store.createProjectDevice(project.id, { daemonId: "previous" });
  store.updateDaemonDedicated("local", "previous", true, "local");
  const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
  const first = store.sendChatMessage(chat.id, { body: "First" }).task;
  expect(store.claimTask(previous.id)?.id).toBe(first.id);
  store.startTask(first.id);
  store.failTask(first.id, { error: "Runtime unavailable", failureReason: "runtime_offline", sessionId: "old-provider", workDir: "/abs/old" });
  const retry = store.listTasks().find(task => task.parentTaskId === first.id)!;
  expect(retry.codexProfile ?? retry.claudeProfile).toEqual(saved);
  store.updateAgent(agent.id, { model: CURRENT_MODEL });
  store.archiveProject(project.id);
  return { store, destination, agent, retry, nextSaved };
}

describe("frozen retry destination model during explicit chat workspace migration", () => {
  for (const provider of ["codex", "claude"] as const) {
    it(`${provider}: an explicit Runtime identity merge retains a pending transition's frozen upstream and credential`, () => {
      process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 43).toString("base64");
      const store = createLocalStore();
      const metadata = { codex_profiles: 1, claude_profiles: 1, agent_plugin_protocol: 1 };
      const previous = store.registerRuntime({ name: "Original identity", provider, daemonId: "same-host", metadata });
      const profile = { name: "original", base_url: "https://original.example/v1", model: FROZEN_MODEL,
        env_key: "", auth_mode: "api_key" as const };
      const setProfile = (value: typeof profile, key: string) => provider === "codex"
        ? store.setRuntimeCodexProfile(previous.id, value, key)!
        : store.setRuntimeClaudeProfile(previous.id, value, key)!;
      const frozen = setProfile(profile, "frozen-fixture-key");
      const agent = store.createAgent({ name: "Frozen transition", provider, model: FROZEN_MODEL });
      const project = store.createProject({ title: "Archived project" });
      store.createProjectDevice(project.id, { daemonId: "same-host" });
      const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
      const first = store.sendChatMessage(chat.id, { body: "First" }).task;
      expect(store.claimTask(previous.id)?.id).toBe(first.id);
      store.startTask(first.id);
      store.failTask(first.id, { error: "Runtime unavailable", failureReason: "runtime_offline" });
      const retry = store.listTasks().find(task => task.parentTaskId === first.id)!;

      // Let the normal workspace reconciliation create the pending transition,
      // using a provider-incompatible observer that cannot claim this retry.
      store.archiveProject(project.id);
      const observer = store.registerRuntime({ name: "Observer", provider: provider === "codex" ? "claude" : "codex", metadata });
      expect(store.claimTask(observer.id)).toBeNull();
      expect(store.getTask(retry.id)?.executionFingerprint)
        .toStartWith(`chat-workspace-transition-${encodeURIComponent(previous.id)}:`);

      const current = setProfile({ ...profile, base_url: "https://replacement.example/v1" }, "current-fixture-key");
      const replacement = store.registerRuntime({ name: "New identity", provider, daemonId: "same-host", metadata });
      store.mergeRuntimeInto(previous.id, replacement.id);
      expect(db!.query("SELECT execution_runtime_id FROM multiremi_tasks WHERE id = ?").get(retry.id))
        .toEqual({ execution_runtime_id: replacement.id });
      expect(store.getRuntimeExecutionProfile(replacement.id, provider)).toEqual(current);
      const claimed = store.claimTask(replacement.id);
      expect(claimed?.id).toBe(retry.id);
      expect(claimed?.codexProfile ?? claimed?.claudeProfile).toEqual(frozen);
      const key = provider === "codex"
        ? store.getRuntimeCodexProfileKey(replacement.id, frozen.credential_id!)
        : store.getRuntimeClaudeProfileKey(replacement.id, frozen.credential_id!);
      expect(key).toBe("frozen-fixture-key");
      expect(claimed?.codexProfile?.credential_id ?? claimed?.claudeProfile?.credential_id)
        .not.toBe(current.credential_id);
    });

    it(`${provider}: a native destination accepts its supported current Agent model`, () => {
      const { store, destination, retry } = fixture(provider, CURRENT_MODEL, false);
      const claimed = store.claimTask(destination.id);
      expect(claimed?.id).toBe(retry.id);
      expect(claimed?.codexProfile).toBeNull();
      expect(claimed?.claudeProfile).toBeNull();
      expect(claimed?.agent?.model).toBe(CURRENT_MODEL);
      expect(claimed?.sessionId).toBeNull();
      expect(claimed?.workDir).toBeNull();
    });

    it(`${provider}: a native destination rejects an unsupported current model even if it supports the frozen model`, () => {
      const { store, destination, retry } = fixture(provider, FROZEN_MODEL, false);
      expect(store.claimTask(destination.id)).toBeNull();
      expect(store.getTask(retry.id)?.status).toBe("queued");
    });

    it(`${provider}: a custom destination preserves the frozen model while replacing host-local connection fields`, () => {
      const { store, destination, agent, retry, nextSaved } = fixture(provider, FROZEN_MODEL, true);
      expect(store.runtimeSupportsAgentModel(store.getRuntime(destination.id)!, store.getAgent(agent.id)!)).toBe(false);
      const claimed = store.claimTask(destination.id);
      expect(claimed?.id).toBe(retry.id);
      expect(claimed?.codexProfile ?? claimed?.claudeProfile).toEqual({ ...nextSaved!, model: FROZEN_MODEL });
      expect(claimed?.sessionId).toBeNull();
      expect(claimed?.workDir).toBeNull();
    });
  }
});
