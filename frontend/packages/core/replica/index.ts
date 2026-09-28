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
