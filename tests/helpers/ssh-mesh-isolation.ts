import type { MultiremiDaemonSshMeshRuntime } from "@multiremi/daemon.js";

/** Daemon tests must explicitly opt out of reconciling the user's SSH files. */
export function disabledSshMeshRuntime(): MultiremiDaemonSshMeshRuntime {
  return {
    getHeartbeatStatus: () => ({ status: "disabled" }),
    reconcile: async () => {},
    cleanupForRetirement: async () => {},
  };
}
