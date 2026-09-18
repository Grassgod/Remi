import { afterEach, describe, expect, it } from "bun:test";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const WAIT_PREFIX = "等待冻结执行连接恢复：";

describe("invalid historical frozen task snapshots", () => {
  for (const provider of ["codex", "claude"] as const) {
    for (const raw of ["{", "null", "false", "0", "[]", "{}"] as const) {
      it(`${provider}: rejects stored ${JSON.stringify(raw)} without falling back to a native connection`, () => {
        const store = createLocalStore();
        const runtime = store.registerRuntime({ name: "Available host", provider, metadata: { [`${provider}_profiles`]: 1 } });
        const agent = store.createAgent({ name: "Historical worker", provider });
        const broken = store.createTask({ agentId: agent.id, prompt: "retain the historical connection", priority: 100 });
        const healthy = store.createTask({ agentId: agent.id, prompt: "ordinary native work" });
        db!.run(`UPDATE multiremi_tasks SET provider = ?, execution_fingerprint = 'frozen',
          ${provider}_profile = ?, execution_runtime_id = ? WHERE id = ?`, [provider, raw, runtime.id, broken.id]);

        expect(store.claimTask(runtime.id)?.id).toBe(healthy.id);
        expect(store.getTask(broken.id)).toMatchObject({
          status: "queued", waitReason: expect.stringContaining(WAIT_PREFIX),
        });
        expect(() => store.refreshQueuedCapabilityWaitReasons()).not.toThrow();
        expect(store.getTask(broken.id)?.waitReason).toContain("快照无法识别");
        expect(db!.query(`SELECT ${provider}_profile AS profile FROM multiremi_tasks WHERE id = ?`).get(broken.id))
          .toEqual({ profile: raw });
      });
    }
  }

  for (const fingerprint of [
    "chat-workspace-transition-%E0%A4:frozen",
    "chat-workspace-transition-%ZZ:frozen",
    "chat-workspace-transition-rt_unproven",
  ]) {
    for (const isChat of [false, true]) {
      it(`does not let malformed ${isChat ? "Chat" : "task"} provenance ${JSON.stringify(fingerprint)} authorize migration or poison a sweep`, () => {
        const store = createLocalStore();
        const runtime = store.registerRuntime({ name: "Available host", provider: "codex", metadata: { codex_profiles: 1 } });
        const agent = store.createAgent({ name: "Historical worker", provider: "codex" });
        const chat = isChat ? store.createChatSession({ agentId: agent.id }) : null;
        const broken = store.createTask({ agentId: agent.id, chatSessionId: chat?.id,
          prompt: "retain my unknown original connection", priority: 100 });
        const healthy = store.createTask({ agentId: agent.id, prompt: "ordinary native work" });
        const profile = JSON.stringify({ name: "original", base_url: "https://original.example/v1", model: "frozen-model", env_key: "REMI_CODEX_FROZEN" });
        db!.run(`UPDATE multiremi_tasks SET provider = 'codex', execution_fingerprint = ?,
          codex_profile = ?, execution_runtime_id = NULL WHERE id = ?`, [fingerprint, profile, broken.id]);

        expect(() => store.refreshQueuedCapabilityWaitReasons()).not.toThrow();
        expect(store.getTask(broken.id)).toMatchObject({
          status: "queued", waitReason: expect.stringContaining(WAIT_PREFIX),
        });
        expect(store.claimTask(runtime.id)?.id).toBe(healthy.id);
        expect(store.getTask(broken.id)?.status).toBe("queued");
        expect(db!.query("SELECT codex_profile, execution_fingerprint, execution_runtime_id FROM multiremi_tasks WHERE id = ?").get(broken.id))
          .toEqual({ codex_profile: profile, execution_fingerprint: fingerprint, execution_runtime_id: null });
      });
    }
  }
});
