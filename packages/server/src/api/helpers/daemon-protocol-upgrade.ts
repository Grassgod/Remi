import { meetsDaemonMinCliVersion } from "@multiremi/contracts/daemon-protocol.js";
import type { MultiremiDaemonHeartbeatAck } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { multiremiVersion } from "@multiremi/version.js";

/** The HTTP heartbeat remains the upgrade channel; its existing ack shape stays intact. */
export function ensureDaemonProtocolUpgrade(store: MultiremiStore, runtimeId: string, ack: MultiremiDaemonHeartbeatAck): void {
  const runtime = store.getRuntimeLite(runtimeId);
  if (!runtime || ack.status !== "ok") return;
  // HTTP probes from a rejected v2 daemon do not erase its last negotiated
  // version. Legacy rows without a successful hello are read as protocol v1.
  const cliVersion = runtime.metadata.cli_version ?? runtime.metadata.cliVersion;
  if (meetsDaemonMinCliVersion(typeof cliVersion === "string" ? cliVersion : "")) return;
  try {
    // createRuntimeUpdateRequest checks pending/running under the workspace lifecycle
    // database lock, including across independent PostgreSQL connections.
    store.createRuntimeUpdateRequest(runtimeId, { scope: "cli", targetVersion: multiremiVersion });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "an update is already in progress for this runtime") throw error;
  }
  if (ack.pending_update) return;
  // Reuse the queue's physical-daemon drain/idle gate; do not invent another one.
  const pending = store.claimRuntimeUpdateRequest(runtimeId);
  if (pending) ack.pending_update = { id: pending.id, target_version: pending.targetVersion, scope: pending.scope };
}
