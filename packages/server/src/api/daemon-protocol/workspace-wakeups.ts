import type { PeerWorkspaceEvent } from "@multiremi/contracts/peer-events.js";
import type { DaemonDownlinks } from "./downlinks.js";
import type { DaemonTaskOffers } from "./task-offers.js";

/** Store and peer events use the same scope, independently of which API owns the socket. */
export function wakeDaemonWorkspaceEvent(event: PeerWorkspaceEvent, options: {
  downlinks: DaemonDownlinks;
  offers: DaemonTaskOffers;
  runtimeWorkspace(runtimeId: string): string | null;
}): void {
  // These notify browsers; neither changes a daemon's desired input or eligibility.
  if (event.type === "daemon:heartbeat" || event.type === "activity:created") return;
  const runtime = event.type.startsWith("runtime:") ? event.payload.runtime : undefined;
  const state = event.type.startsWith("agent_plugin:runtime_") ? event.payload.state : undefined;
  const nested = runtime ?? state;
  const object = typeof nested === "object" && nested !== null ? nested as Record<string, unknown> : {};
  const id = event.payload.runtime_id ?? (runtime ? object.id : object.runtime_id);
  const runtimeId = typeof id === "string" && id.length ? id : null;
  const workspace = runtimeId ? options.runtimeWorkspace(runtimeId) : null;
  if (workspace !== null && workspace !== event.workspaceId) return;
  const downlink = (mode: "full" | "pending" = "full") => runtimeId
    ? options.downlinks.kick(runtimeId, mode)
    : options.downlinks.kickWorkspace(event.workspaceId, rt => options.runtimeWorkspace(rt) ?? "local", mode);
  const offer = () => runtimeId
    ? options.offers.kick(runtimeId)
    : options.offers.kickWorkspace(event.workspaceId);

  switch (event.type) {
    case "daemon:task_input":
      // Human-request settlement is consumed by both the task runtime and its bot host.
      // They can be different machines; retain the workspace scope for this multi-recipient input.
      options.downlinks.kickWorkspace(event.workspaceId, rt => options.runtimeWorkspace(rt) ?? "local", "pending");
      return;
    case "message:created":
    case "message:updated":
    case "decision:created":
    case "decision:updated":
      downlink("pending");
      return;
    case "issue:updated":
      downlink("pending");
      offer();
      return;
    case "daemon:pending_changed":
    case "daemon:feishu_changed":
    case "daemon:ssh_mesh_changed":
      // Pending commands, bot delivery and mesh configuration do not create task capacity.
      downlink();
      return;
    case "daemon:models_updated":
    case "daemon:dispatch_conditions_changed":
    case "agent_plugin:runtime_state":
    case "agent_plugin:runtime_capability":
      downlink();
      offer();
      return;
    default:
      // Keep workspace-wide business/configuration changes and maintenance recovery reliable.
      // Runtime-bearing events can use their known target; unscoped mutations retain fanout.
      downlink();
      if (/^(agent:|agent_plugin:|runtime:|project:|execution_group:|daemon:|issue:)/.test(event.type)) offer();
  }
}
