/**
 * Adapt a {@link ReplicaEngine} to C8's read-only {@link SessionReplicaPort}.
 *
 * The port was defined by C8's first commit (`port.ts`, the tie-break the plan
 * calls for: 谁先合入谁定稿), so this file adds no interface of its own — it is
 * the seam that lets `SessionLogList` and the zero-jump fixture page run against
 * the persistent replica and the in-memory one through one spelling.
 *
 * The reads are synchronous even though the replica persists asynchronously:
 * the engine keeps its window in memory and writes through, so a reader never
 * waits on SQLite. That is also why `subscribe` here is a plain listener set
 * rather than a storage callback — the storage layer has no notification.
 */

import { ReplicaEngine } from "./engine";
import type { SessionLogEntry, SessionReplicaPort, SessionReplicaSnapshot } from "./port";

export interface ReplicaPortOptions {
  /** Sessions to open eagerly, so their windows and heights are warm. */
  sessions?: readonly string[];
  userId: string;
  workspaceId: string;
}

/**
 * Wrap an engine as the port the list consumes.
 *
 * The wrapper is deliberately thin: every method forwards to the engine, and the
 * only logic is `getSnapshot`'s memoization, which the engine already does. A
 * second memo here would be a second cache to invalidate.
 */
export function createReplicaPort(
  engine: ReplicaEngine,
  options: ReplicaPortOptions,
): SessionReplicaPort {
  for (const sessionId of options.sessions ?? []) {
    engine.openSession({ sessionId, userId: options.userId, workspaceId: options.workspaceId });
  }

  return {
    getSnapshot(sessionId: string): SessionReplicaSnapshot & { entries: readonly SessionLogEntry[] } {
      // `ReplicaEngine.snapshot` is already memoized per session and returns the
      // flat shape the port defines, so this forwards rather than rebuilding a
      // second cache that would need invalidating in step with the first.
      return engine.snapshot(sessionId);
    },
    subscribe(sessionId: string, listener: () => void): () => void {
      return engine.subscribe(sessionId, listener);
    },
    readRowHeight(sessionId: string, seq: number, key: string): number | null {
      return engine.readRowHeight(sessionId, seq, key);
    },
    writeRowHeight(sessionId: string, seq: number, key: string, height: number): void {
      engine.writeRowHeight(sessionId, seq, key, height);
    },
  };
}
