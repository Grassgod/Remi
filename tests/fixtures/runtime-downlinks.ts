import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonDownlinks } from "@multiremi/api/daemon-protocol/downlinks.js";
import { runtimeInputSnapshot } from "@multiremi/api/daemon-protocol/runtime-input-snapshot.js";
import { taskInputSnapshot } from "@multiremi/api/daemon-protocol/task-input-snapshot.js";
import { registerTaskInputRpcs } from "@multiremi/api/daemon-protocol/task-input-rpcs.js";
import type { DaemonProtocolIdentity } from "@multiremi/api/daemon-protocol/index.js";
import { DAEMON_MIN_CLI_VERSION, type DaemonRuntimeCapabilities, type DaemonQuestionWait } from "@multiremi/contracts/daemon-protocol.js";
import {
  FEISHU_CONCIERGE_CONFIG_CAPABILITY,
  FEISHU_CONCIERGE_PROTOCOL_VERSION,
  FEISHU_DECISION_CARD_CAPABILITY,
  FEISHU_DECISION_CARD_PROTOCOL_VERSION,
  FEISHU_ISSUE_DECISION_CARD_CAPABILITY,
  FEISHU_ISSUE_DECISION_CARD_PROTOCOL_VERSION,
  type MultiremiDaemonRuntimeInput,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { normalizeDaemonRuntimeInput } from "@multiremi/worker/client.js";

function configuredRuntimeCapabilities(metadata: Record<string, unknown>): DaemonRuntimeCapabilities {
  return {
    supports_batch_import: metadata.supports_batch_import === true,
    supports_directory_scan: metadata.supports_directory_scan === true,
    supports_skill_directory: metadata.supports_skill_directory === true,
    supports_bot_menu: metadata.feishu_bot_menu === true,
    agent_plugin_protocol: Number(metadata.agent_plugin_protocol) || 0,
    feishu_concierge_protocol: metadata[FEISHU_CONCIERGE_CONFIG_CAPABILITY] === true
      ? FEISHU_CONCIERGE_PROTOCOL_VERSION : 0,
    feishu_decision_card: metadata[FEISHU_DECISION_CARD_CAPABILITY] === 1
      ? FEISHU_DECISION_CARD_PROTOCOL_VERSION : 0,
    feishu_issue_decision_card: metadata[FEISHU_ISSUE_DECISION_CARD_CAPABILITY] === 1
      ? FEISHU_ISSUE_DECISION_CARD_PROTOCOL_VERSION : 0,
  };
}

export async function openRuntimeDownlinks(store: MultiremiStore, runtimeId: string,
  options: { identity?: DaemonProtocolIdentity; activeTaskIds?: string[]; activeQuestionWaits?: DaemonQuestionWait[]; capabilities?: DaemonRuntimeCapabilities } = {}) {
  const runtime = store.getRuntimeLite(runtimeId);
  if (!runtime) throw new Error("Runtime not found");
  const layer = new DaemonProtocolLayer({ store });
  const downlinks = new DaemonDownlinks({ layer, snapshot: (rt, session, active) => [
    ...runtimeInputSnapshot(store, rt, session), ...taskInputSnapshot(store, rt, session.daemonId, active, id => downlinks.forgetTask(rt, id)),
  ] });
  registerTaskInputRpcs(layer, store, rt => downlinks.kick(rt));
  const frames: Array<{ t: string; seq?: number; re?: string; p: Record<string, any> }> = [];
  let closeCode: number | undefined;
  const session = layer.openSession({ send(text) { frames.push(JSON.parse(text)); return text.length; }, close(code) { closeCode = code; } },
    options.identity ?? { accessToken: null, masterToken: true });
  await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2,
    daemon_id: runtime.daemonId ?? "dmn_downlinks_unit", cli_version: DAEMON_MIN_CLI_VERSION, caps: [],
    runtimes: [{ runtime_id: runtimeId, provider: runtime.provider, max_concurrency: 1,
      active_task_ids: options.activeTaskIds ?? [], active_question_waits: options.activeQuestionWaits ?? [], capabilities: options.capabilities }] } }));
  await layer.drain();
  let rpcId = 0;
  return { frames, layer, session, downlinks,
    get closeCode() { return closeCode; },
    async rpc(type: string, payload: Record<string, unknown>) {
      const id = `unit_rpc_${++rpcId}`;
      await session.handleMessage(JSON.stringify({ v: 2, t: type, id, rt: runtimeId, p: payload }));
      await layer.drain();
      const reply = frames.find(frame => frame.t === "res" && frame.re === id);
      if (!reply) throw new Error(`No RPC reply for ${type}`);
      return reply.p;
    },
    async ack(seq = session.lastSentSeq) {
      await session.handleMessage(JSON.stringify({ v: 2, t: "ack", ack: seq, p: {} }));
      await layer.drain();
    },
    async kick() { downlinks.kick(runtimeId); await layer.drain(); },
    async close() { layer.closeAll(); layer.stop(); await layer.drain(); },
  };
}

/** Encoded v2 delivery and ACK, without calling the daemon business handler. */
export async function receiveRuntimeInputs(store: MultiremiStore, runtimeId: string,
  options: { identity?: DaemonProtocolIdentity } = {}): Promise<MultiremiDaemonRuntimeInput> {
  const metadata = store.getRuntimeLite(runtimeId)?.metadata ?? {};
  // This fixture models a capable daemon. The hello is its first heartbeat;
  // a separate store heartbeat would advance plugin reconciliation twice.
  // Bare openRuntimeDownlinks still omits capabilities for missing-field tests.
  const capabilities: DaemonRuntimeCapabilities = {
    ...configuredRuntimeCapabilities(metadata),
    supports_batch_import: true,
    supports_directory_scan: true,
    supports_skill_directory: true,
    supports_bot_menu: true,
    agent_plugin_protocol: 1,
  };
  const connection = await openRuntimeDownlinks(store, runtimeId, { ...options, capabilities });
  const fields: Record<string, string> = { "runtime.update": "pending_update", "runtime.model_list": "pending_model_list",
    "runtime.local_skills": "pending_local_skills", "runtime.directory_scan": "pending_directory_scan",
    "runtime.local_skill_import": "pending_local_skill_import", "runtime.command": "pending_command",
    "runtime.bot_menu": "pending_bot_menu", "plugin.desired_revision": "agent_plugins",
    "platform.drain": "drain", "feishu.directive": "feishu_bot", "ssh_mesh.reconcile": "ssh_mesh",
    "feishu.outbound": "pending_feishu_outbound" };
  try {
    const input: Record<string, unknown> = { runtime_id: runtimeId, status: "ok" };
    const imports: Record<string, unknown>[] = [];
    for (const frame of connection.frames) {
      if (frame.t === "runtime.profile") Object.assign(input, frame.p);
      if (frame.t === "workspace.settings") input.workspace_settings = frame.p.settings;
      if (frame.t === "workspace.relay") input.relay = frame.p.relay;
      const field = fields[frame.t];
      if (!field) continue;
      if (!(field in input)) input[field] = frame.p;
      if (frame.t === "runtime.local_skill_import") imports.push(frame.p);
    }
    if (imports.length) input.pending_local_skill_imports = imports;
    await connection.ack();
    return input as unknown as MultiremiDaemonRuntimeInput;
  } finally { await connection.close(); }
}

export async function receiveNormalizedRuntimeInputs(store: MultiremiStore, runtimeId: string,
  options: { identity?: DaemonProtocolIdentity } = {}) {
  return normalizeDaemonRuntimeInput(runtimeId, await receiveRuntimeInputs(store, runtimeId, options));
}

export async function requestRuntimeRpc(store: MultiremiStore, runtimeId: string, type: string,
  payload: Record<string, unknown> = {}, token = "root-secret", authToken = "root-secret"): Promise<Record<string, any>> {
  const resolver = new DaemonProtocolLayer({ store });
  const identity = await resolver.resolveIdentity(new Request("http://local/api/daemon/ws?protocol=2",
    { headers: { Authorization: `Bearer ${token}` } }), authToken);
  resolver.stop();
  if ("response" in identity) return { ok: false, transport_status: identity.response.status, ...await identity.response.json() };
  const capabilities = configuredRuntimeCapabilities(store.getRuntimeLite(runtimeId)?.metadata ?? {});
  const connection = await openRuntimeDownlinks(store, runtimeId, { identity: identity.identity, capabilities });
  try {
    if (connection.session.isClosed) {
      if (!connection.closeCode) throw new Error("RPC handshake closed without a protocol close code");
      return { ok: false, close_code: connection.closeCode };
    }
    return await connection.rpc(type, payload);
  }
  finally { await connection.close(); }
}

/** Keep unrelated pushed frames while waiting for one correlated response. */
export function watchRuntimeFrames(socket: WebSocket) {
  const frames: Array<Record<string, any>> = [];
  const listeners = new Set<() => void>();
  const onMessage = (event: MessageEvent) => {
    frames.push(JSON.parse(String(event.data)));
    for (const listener of listeners) listener();
  };
  socket.addEventListener("message", onMessage);
  return {
    frames,
    next(type: string, re?: string): Promise<Record<string, any>> {
      return new Promise((resolve, reject) => {
        const finish = () => {
          const index = frames.findIndex(frame => frame.t === type && (re === undefined || frame.re === re));
          if (index < 0) return;
          clearTimeout(timer); listeners.delete(finish);
          resolve(frames.splice(index, 1)[0]!);
        };
        const timer = setTimeout(() => { listeners.delete(finish); reject(new Error(`Timed out waiting for v2 ${type}`)); }, 2_000);
        listeners.add(finish);
        finish();
      });
    },
    close() { socket.removeEventListener("message", onMessage); },
  };
}
