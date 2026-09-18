import { afterEach, describe, expect, it } from "bun:test";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture(provider: "codex" | "claude") {
  const store = createLocalStore();
  const runtime = store.registerRuntime({
    name: "Frozen protocol source", provider, metadata: { [`${provider}_profiles`]: 1 },
  });
  const profile = {
    name: "protocol-fixture", base_url: "https://protocol.example/v1", model: "frozen-model",
    auth_mode: "env" as const, env_key: provider === "codex" ? "REMI_CODEX_PROTOCOL_KEY" : "REMI_CLAUDE_PROTOCOL_KEY",
  };
  const saved = provider === "codex" ? store.setRuntimeCodexProfile(runtime.id, profile)!
    : store.setRuntimeClaudeProfile(runtime.id, profile)!;
  const agent = store.createAgent({ name: "Protocol worker", provider, model: profile.model });
  const task = store.createTask({ agentId: agent.id, issueId: store.createIssue({ title: "Protocol retry" }).id,
    prompt: "Keep the frozen connection", maxAttempts: 2 });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  store.startTask(task.id);
  store.failTask(task.id, { error: "lost worker", failureReason: "runtime_recovery" });
  const retry = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
  expect(retry).toBeDefined();
  return { store, runtime, retry, saved };
}

describe("frozen profile protocol readiness", () => {
  for (const provider of ["codex", "claude"] as const) {
    for (const advertised of [0, undefined] as const) {
      it(`${provider}: reports a missing protocol (${advertised}) and recovers without changing the snapshot`, () => {
        const { store, runtime, retry, saved } = fixture(provider);
        // Clearing the live connection does not erase the frozen task snapshot.
        if (provider === "codex") store.setRuntimeCodexProfile(runtime.id, null);
        else store.setRuntimeClaudeProfile(runtime.id, null);
        store.registerRuntime({ id: runtime.id, name: runtime.name, provider,
          metadata: advertised === undefined ? {} : { [`${provider}_profiles`]: advertised } });
        expect(store.claimTask(runtime.id)).toBeNull();
        store.refreshQueuedCapabilityWaitReasons(Date.now() + 180_000);
        expect(store.getTask(retry.id)).toMatchObject({
          status: "queued", waitReason: expect.stringContaining(`${provider}_profiles`),
        });
        // Subsequent monitor sweeps must not clear the reason while still blocked.
        store.refreshQueuedCapabilityWaitReasons(Date.now() + 240_000);
        expect(store.getTask(retry.id)?.waitReason).toContain("等待冻结执行连接恢复：");
        store.registerRuntime({ id: runtime.id, name: runtime.name, provider, metadata: { [`${provider}_profiles`]: 1 } });
        store.refreshQueuedCapabilityWaitReasons(Date.now() + 300_000);
        expect(store.getTask(retry.id)?.waitReason).toBeNull();
        const claimed = store.claimTask(runtime.id)!;
        expect(claimed.id).toBe(retry.id);
        expect(provider === "codex" ? claimed.codexProfile : claimed.claudeProfile).toEqual(saved);
      });
    }

    it(`${provider}: stale dispatch is repooled with an observable protocol wait`, () => {
      const { store, runtime, retry, saved } = fixture(provider);
      expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
      db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", [new Date(Date.now() - 120_000).toISOString(), retry.id]);
      if (provider === "codex") store.setRuntimeCodexProfile(runtime.id, null);
      else store.setRuntimeClaudeProfile(runtime.id, null);
      store.registerRuntime({ id: runtime.id, name: runtime.name, provider, metadata: { [`${provider}_profiles`]: 0 } });
      expect(store.claimTask(runtime.id)).toBeNull();
      store.refreshQueuedCapabilityWaitReasons(Date.now() + 180_000);
      expect(store.getTask(retry.id)).toMatchObject({
        status: "queued", waitReason: expect.stringContaining(`${provider}_profiles`),
      });
      store.registerRuntime({ id: runtime.id, name: runtime.name, provider, metadata: { [`${provider}_profiles`]: 1 } });
      const claimed = store.claimTask(runtime.id)!;
      expect(claimed.id).toBe(retry.id);
      expect(provider === "codex" ? claimed.codexProfile : claimed.claudeProfile).toEqual(saved);
    });
  }
});
