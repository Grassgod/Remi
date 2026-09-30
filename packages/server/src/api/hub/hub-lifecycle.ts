import type { ReadPool } from "@multiremi/store/db/read-pool.js";

export function stopHubReadResources(
  detachLogListener: () => void,
  ownedHub: { shutdown(): void } | null,
  readPool: Pick<ReadPool, "close"> | null,
): void {
  detachLogListener();
  ownedHub?.shutdown();
  void readPool?.close().catch(() => {
    // Shutdown is best-effort; the store handle is closed by its owner.
  });
}
