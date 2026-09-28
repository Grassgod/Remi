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
} from "./port";
export {
  ROW_HEIGHT_WIDTH_BUCKET_PX,
  renderVariant,
  rowHeightKey,
  widthBucket,
} from "./port";
export {
  MemorySessionReplica,
  memoryReplicaWith,
  type MemorySessionReplicaSeed,
} from "./memory";

/**
 * C7 (MUL-442): the persistent replica behind the same port.
 *
 * `ReplicaEngine` runs the six-step sync protocol over a `ReplicaStorage`;
 * `SqlReplicaStorage` is that storage on SQLite (the Worker's `opfs-sahpool`
 * database, or `node:sqlite` in tests) and `MemoryReplicaStorage` is the no-OPFS
 * fallback. `openBrowserReplica` is the entry point the app calls, and the port it
 * returns is C8's `SessionReplicaPort` — either `ReplicaView` (the leader's
 * synchronous read cache) or `ReplicaFollower` (a reader tab's).
 */
export {
  ReplicaEngine,
  type ReplicaClearEvent,
  type ReplicaSessionView,
} from "./engine";
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
} from "./protocol";
export { addRange, contiguousTail, coversSeq, highestCoveredSeq, normalizeRanges, type SeqRange } from "./ranges";
export {
  MemoryReplicaStorage,
  type ReplicaStorage,
} from "./storage";
export { SqlReplicaStorage } from "./sql-store";
export { wasmSqlDatabase, type SqlDatabase, type SqlStatement, type SqlValue, type WasmDatabase } from "./sql";
export {
  META_SCHEMA_VERSION,
  META_USER_ID,
  META_WORKSPACE_ID,
  REPLICA_SCHEMA_SQL,
  REPLICA_SCHEMA_VERSION,
  SQL,
} from "./schema";
export { REPLICA_CHANNEL, REPLICA_LOCK_PREFIX, replicaLockName } from "./channel";
export { ReplicaLeader, type ReplicaLeaderOptions } from "./leader";
export { ReplicaFollower, type ReplicaFollowerOptions } from "./follower";
export { ReplicaView, type SessionViewState } from "./view";
export type {
  ReplicaChannelMessage,
  ReplicaRowHeightMessage,
  ReplicaQueryMessage,
  ReplicaQueryResultMessage,
  ReplicaOpenMessage,
  ReplicaAppendedMessage,
  ReplicaClearedMessage,
  ReplicaLeaderChangedMessage,
  ReplicaAckMessage,
} from "./channel";
export type { BrowserReplicaEnv, ReplicaWorkerLike } from "./browser";
export type {
  ReplicaWorkerRequest,
  ReplicaWorkerResponse,
  ReplicaWorkerStorage,
} from "./worker-protocol";
export { openBrowserReplica, type BrowserReplica, type BrowserReplicaOptions } from "./browser";
