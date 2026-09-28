import { afterEach, describe, expect, it } from "bun:test";
import { startMultiremiServer } from "../../fixtures/daemon-protocol.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import type { DaemonProtocolSession } from "@multiremi/api/daemon-protocol/session.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error("Config push did not arrive"); await Bun.sleep(1); }
}

const rt = "rt_config_push";
const profile = { name: "push", base_url: "http://127.0.0.1:8000/v1", model: "push-model",
  env_key: "REMI_CODEX_TEST_KEY", auth_mode: "env" as const };
const claudeProfile = { ...profile, env_key: "REMI_CLAUDE_TEST_KEY", auth_header: "bearer" as const };
type Config = { name: string; provider?: "codex" | "claude"; type: string;
  change(store: MultiremiStore): void; assert(payload: Record<string, any>, store: MultiremiStore): void };
const configs: Config[] = [
  { name: "codex profile", provider: "codex", type: "runtime.profile",
    change: store => { store.setRuntimeCodexProfile(rt, profile); },
    assert: payload => { expect(payload.codex_profile).toEqual(profile); } },
  { name: "claude profile", type: "runtime.profile",
    change: store => { store.setRuntimeClaudeProfile(rt, claudeProfile); },
    assert: payload => { expect(payload.claude_profile).toEqual(claudeProfile); } },
  { name: "workspace settings", type: "workspace.settings",
    change: store => { store.updateWorkspace("local", { settings: { github_enabled: true } }); },
    assert: payload => { expect(payload.settings.github_enabled).toBe(true); } },
  { name: "workspace relay", type: "workspace.relay",
    change: store => { store.upsertRelayConfig("local", "codex", { fragment: 'model = "push-model"', tokenOp: "clear" }); },
    assert: payload => { expect(JSON.stringify(payload.relay)).toContain("push-model"); } },
  { name: "plugin revision", type: "plugin.desired_revision",
    change: store => {
      const agent = store.createAgent({ name: "Push plugin", provider: "claude", runtimeId: rt });
      const plugin = store.importAgentPlugin({ provider: "claude", manifest: { name: "push-plugin", version: "1.0.0" },
        files: [{ path: "skills/push/SKILL.md", content: "# Push" }] });
      store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    },
    assert: (payload, store) => { expect(payload.revision).toBe(store.getRuntimeAgentPluginDesiredSnapshot(rt).revision);
      expect(store.getRuntimeAgentPluginDesiredSnapshot(rt).plugins).toHaveLength(1); } },
  { name: "drain", type: "platform.drain",
    change: store => { store.beginPlatformDrain({ operationId: "push-config-drain", ttlMs: 60_000 }); },
    assert: payload => { expect(payload).toMatchObject({ mode: "draining", generation: 1 }); } },
  { name: "ssh mesh", type: "ssh_mesh.reconcile",
    change: store => { store.setSshMeshEnabled("local", true, { privateKey: "fixture-private-key",
      publicKey: "ssh-ed25519 Zml4dHVyZQ== fixture", fingerprint: "SHA256:fixture" }, "local"); },
    assert: payload => { expect(payload).toMatchObject({ enabled: true, key_version: 1 });
      expect(JSON.stringify(payload)).not.toContain("fixture-private-key"); } },
  { name: "feishu directive", type: "feishu.directive",
    change: store => {
      const agent = store.createAgent({ name: "Push concierge", provider: "claude", runtimeId: rt });
      store.upsertFeishuBotConfig("local", { agentId: agent.id, runtimeId: rt,
        appId: "cli_fixture_push", appSecret: "fixture-app-secret", appSecretOp: "set", domain: "feishu", enabled: true });
    },
    assert: payload => { expect(payload).toMatchObject({ desired_state: "running", config_available: true });
      expect(JSON.stringify(payload)).not.toContain("fixture-app-secret"); } },
];

describe("A-4 configuration snapshots", () => {
  for (const config of configs) it(`${config.name}: write pushes, pre-ACK disconnect replays and repeated ACK is inert`, async () => {
    const store = createLocalStore();
    const oldMeshKey = process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY;
    const oldFeishuKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY = Buffer.alloc(32, 51).toString("base64");
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 52).toString("base64");
    store.registerRuntime({ id: rt, name: rt, provider: config.provider ?? "claude", workspaceId: "local",
      daemonId: "dmn_config_push", ownerId: "local", metadata: { codex_profiles: 1, claude_profiles: 1, agent_plugin_protocol: 1 } });
    store.heartbeatRuntime(rt, { supportsFeishuBotConfig: true, claimPending: false });
    store.recordSshMeshHeartbeat(rt, 1, { status: "disabled" });
    let layer!: DaemonProtocolLayer;
    const server = startMultiremiServer({ store, authToken: "config-push-test", hostname: "127.0.0.1", port: 0,
      onDaemonProtocol: value => { layer = value; } });
    const sockets = new Set<WebSocket>();
    const connect = async () => {
      const frames: Array<Record<string, any>> = [];
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
        { headers: { Authorization: "Bearer config-push-test" } } as never);
      sockets.add(socket);
      socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
      await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Config socket failed")), { once: true }); });
      socket.send(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2, daemon_id: "dmn_config_push",
        cli_version: DAEMON_MIN_CLI_VERSION, caps: [], runtimes: [{ runtime_id: rt,
          provider: config.provider ?? "claude", max_concurrency: 1, active_task_ids: [] }] } }));
      await waitFor(() => frames.some(frame => frame.t === "welcome")); await layer.drain();
      return { socket, frames };
    };
    const close = async (socket: WebSocket) => {
      if (socket.readyState !== WebSocket.CLOSED) await new Promise<void>(resolve => {
        socket.addEventListener("close", () => resolve(), { once: true }); socket.close();
      });
      sockets.delete(socket); await waitFor(() => layer.registry.sessionForRuntime(rt) === null); await layer.drain();
    };
    try {
      const first = await connect(); const head = (layer.registry.sessionForRuntime(rt)! as DaemonProtocolSession).lastSentSeq;
      first.socket.send(JSON.stringify({ v: 2, t: "ack", ack: head, p: {} }));
      config.change(store);
      const changed = () => first.frames.filter(frame => frame.t === config.type && frame.seq > head);
      await waitFor(() => changed().length > 0);
      const pushed = changed().at(-1)!; config.assert(pushed.p, store);
      await close(first.socket);
      const second = await connect();
      await waitFor(() => second.frames.some(frame => frame.t === config.type));
      const replay = second.frames.filter(frame => frame.t === config.type).at(-1)!;
      expect(replay.p).toEqual(pushed.p); config.assert(replay.p, store);
      const count = second.frames.filter(frame => frame.t === config.type).length;
      const ack = JSON.stringify({ v: 2, t: "ack", ack: (layer.registry.sessionForRuntime(rt)! as DaemonProtocolSession).lastSentSeq, p: {} });
      second.socket.send(ack); second.socket.send(ack); await layer.drain(); await Bun.sleep(10);
      expect(second.frames.filter(frame => frame.t === config.type)).toHaveLength(count);
      await close(second.socket);
    } finally {
      for (const socket of sockets) await close(socket);
      layer.closeAll(); await layer.drain(); server.stop(true);
      if (oldMeshKey === undefined) delete process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY; else process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY = oldMeshKey;
      if (oldFeishuKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = oldFeishuKey;
    }
  });
});
