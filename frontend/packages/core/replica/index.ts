/**
 * Browser-replica seam (MUL-403 C8 §5).
 *
 * `port.ts` is the interface C7 (MUL-442) also implements; `memory.ts` is the
 * in-memory implementation C8 ships so the flat list, its tests and the
 * zero-jump fixture page can run without a Worker or OPFS.
 */
export type {
  SessionLogEntry,
  SessionLogEntryLike,
  SessionReplicaPort,
  SessionReplicaSnapshot,
  RowHeightKeyInput,
} from "./port.js";
export {
  ROW_HEIGHT_WIDTH_BUCKET_PX,
  renderVariant,
  rowHeightKey,
  widthBucket,
} from "./port.js";
export {
  MemorySessionReplica,
  memoryReplicaWith,
  type MemorySessionReplicaSeed,
} from "./memory.js";

/**
 * C7 (MUL-442): the persistent replica behind the same port.
 *
 * `ReplicaEngine` runs the six-step sync protocol over a `ReplicaStorage`;
 * `SqlReplicaStorage` is that storage on SQLite (the Worker's `opfs-sahpool`
 * database, or `node:sqlite` in tests) and `MemoryReplicaStorage` is the no-OPFS
 * fallback. `createReplicaPort` adapts the engine to the C8 port so a caller can
 * swap the two without changing the list.
 */
export {
  ReplicaEngine,
  type ReplicaClearEvent,
  type ReplicaSessionView,
} from "./engine.js";
export {
  applyFrames,
  computeFresh,
  contiguousHead,
  decideAck,
  emptyReplicaState,
  firstHole,
  subscribeFromSeq,
  type AckDecision,
  type FrameApplyResult,
  type ReplicaState,
} from "./protocol.js";
export { addRange, contiguousTail, coversSeq, highestCoveredSeq, normalizeRanges, type SeqRange } from "./ranges.js";
export {
  MemoryReplicaStorage,
  type ReplicaStorage,
} from "./storage.js";
export { SqlReplicaStorage } from "./sql-store.js";
export { wasmSqlDatabase, type SqlDatabase, type SqlStatement, type SqlValue, type WasmDatabase } from "./sql.js";
export {
  META_SCHEMA_VERSION,
  META_USER_ID,
  META_WORKSPACE_ID,
  REPLICA_SCHEMA_SQL,
  REPLICA_SCHEMA_VERSION,
  SQL,
} from "./schema.js";
export { createReplicaPort, type ReplicaPortOptions } from "./port-adapter.js";
export { REPLICA_CHANNEL, REPLICA_LOCK_PREFIX, replicaLockName, type ReplicaChannelMessage } from "./channel.js";
export { ReplicaLeader, type ReplicaLeaderOptions } from "./leader.js";
export { openBrowserReplica, type BrowserReplica, type BrowserReplicaOptions } from "./browser.js";
