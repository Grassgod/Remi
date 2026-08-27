import type { MultiremiStore } from "@multiremi/store/store.js";
import type { FeishuIngestionStore } from "./types.js";

export function feishuIngestionStore(store: MultiremiStore): FeishuIngestionStore {
  return {
    listSources: (input) => store.listFeishuSources(input),
    getSyncCursor: (sourceId, stream) => store.getFeishuSyncCursor(sourceId, stream),
    claimSyncStream: (input) => store.claimFeishuSyncStream(input),
    updateClaimedSyncCursor: (input) => store.updateClaimedFeishuSyncCursor(input),
    releaseSyncStream: (sourceId, stream, leaseToken) =>
      store.releaseFeishuSyncStream(sourceId, stream, leaseToken),
    ingestBatch: (sourceId, messages) => store.ingestFeishuBatch(sourceId, messages),
    recordConnectionSuccess: (sourceId, completedAt) =>
      store.recordFeishuConnectionSuccess(sourceId, completedAt),
    recordConnectionFailure: (sourceId, errorCode, failedAt) =>
      store.recordFeishuConnectionFailure(sourceId, errorCode, failedAt),
    hasDueUnprocessedMessages: (sourceId, now) => store.hasDueUnprocessedFeishuMessages(sourceId, now),
    reconcileUnprocessedMessages: (sourceId, now, limit) =>
      store.reconcileUnprocessedFeishuMessages(sourceId, now, limit),
    deleteExpiredMessages: (now) => store.deleteExpiredFeishuMessages(now),
  };
}
