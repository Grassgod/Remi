import { normalizeDaemonRuntimeInput, type MultiremiDaemonHeartbeatConfigAck } from "./client.js";
import type { DaemonProtocolClient } from "./daemon-protocol-client.js";

const pendingFields = {
  "runtime.update": "pending_update",
  "runtime.command": "pending_command",
  "runtime.model_list": "pending_model_list",
  "runtime.local_skills": "pending_local_skills",
  "runtime.directory_scan": "pending_directory_scan",
  "runtime.local_skill_import": "pending_local_skill_import",
  "runtime.bot_menu": "pending_bot_menu",
  "feishu.outbound": "pending_feishu_outbound",
} as const;

export function registerDaemonRuntimeDownlinks(client: DaemonProtocolClient, runtimeId: () => string | null,
  apply: (rt: string, input: MultiremiDaemonHeartbeatConfigAck) => Promise<unknown>,
  desired: (rt: string, revision: string) => Promise<void>): () => Promise<void> {
  const maintenance = new Set<Promise<unknown>>();
  for (const [type, field] of Object.entries(pendingFields)) client.registerFrameHandler(type, async frame => {
    if (!frame.rt || frame.rt !== runtimeId() || typeof frame.payload.id !== "string") return;
    const key = `${frame.rt}:${frame.payload.id}${type === "feishu.outbound" ? `:${frame.payload.claim_token}` : ""}`;
    if (!client.dedupe.claim(type, key)) return;
    try {
      // Ack precedes result reports, including the temporary HTTP reporters.
      client.send({ t: "ack", p: {} });
      const run = apply(frame.rt, normalizeDaemonRuntimeInput(frame.rt, { [field]: frame.payload }));
      if (type !== "runtime.update") maintenance.add(run);
      try { await run; } finally { maintenance.delete(run); }
    } catch (error) { client.dedupe.release(type, key); throw error; }
  });
  const configs = {
    "runtime.profile": (payload: Record<string, unknown>) => payload,
    "platform.drain": (payload: Record<string, unknown>) => ({ drain: payload }),
    "workspace.settings": (payload: Record<string, unknown>) => ({ workspace_settings: payload.settings }),
    "workspace.relay": (payload: Record<string, unknown>) => ({ relay: payload.relay }),
    "feishu.directive": (payload: Record<string, unknown>) => ({ feishu_bot: payload }),
    "ssh_mesh.reconcile": (payload: Record<string, unknown>) => ({ ssh_mesh: payload }),
  };
  for (const [type, input] of Object.entries(configs)) client.registerFrameHandler(type, async frame => {
    if (!frame.rt || frame.rt !== runtimeId()) return;
    await apply(frame.rt, normalizeDaemonRuntimeInput(frame.rt, input(frame.payload) as Partial<MultiremiDaemonHeartbeatConfigAck>));
  });
  client.registerFrameHandler("plugin.desired_revision", async frame => {
    if (frame.rt && frame.rt === runtimeId() && typeof frame.payload.revision === "string") await desired(frame.rt, frame.payload.revision);
  });
  // An update must not abort maintenance accepted alongside it; exclude the
  // update itself so its restart can wait without waiting on its own handler.
  return async () => { await Promise.allSettled([...maintenance]); };
}
