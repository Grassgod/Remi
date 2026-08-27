import type {
  MultiremiFeishuSource,
  MultiremiFeishuSyncCursor,
} from "@multiremi/contracts/types.js";
import type {
  ClaimFeishuSyncStreamInput,
  IngestedFeishuMessageInput,
  IngestFeishuBatchResult,
  ReconcileFeishuUnprocessedResult,
  UpdateClaimedFeishuSyncCursorInput,
} from "@multiremi/store/repos/feishu-ingest-repo.js";

export interface FeishuPollPage {
  messages: IngestedFeishuMessageInput[];
  cursor: Record<string, unknown> | null;
  done: boolean;
}

export interface FeishuPollContext {
  source: MultiremiFeishuSource;
  endpoint: string;
  cursor: Record<string, unknown> | null;
  start: Date;
  end: Date;
  signal?: AbortSignal;
  heartbeat?: () => void;
}

export interface FeishuSourceAdapter {
  readonly type: MultiremiFeishuSource["type"];
  poll(context: FeishuPollContext): Promise<FeishuPollPage>;
}

export interface FeishuIngestionStore {
  listSources(input?: { workspaceId?: string; enabled?: boolean }): MultiremiFeishuSource[];
  getSyncCursor(sourceId: string, stream: string): MultiremiFeishuSyncCursor | null;
  claimSyncStream(input: ClaimFeishuSyncStreamInput): MultiremiFeishuSyncCursor | null;
  updateClaimedSyncCursor(input: UpdateClaimedFeishuSyncCursorInput): MultiremiFeishuSyncCursor | null;
  releaseSyncStream(sourceId: string, stream: string, leaseToken: string): boolean;
  ingestBatch(sourceId: string, messages: readonly IngestedFeishuMessageInput[]): IngestFeishuBatchResult;
  recordConnectionSuccess(sourceId: string, completedAt: string): void;
  recordConnectionFailure(sourceId: string, errorCode: string, failedAt: string): void;
  hasDueUnprocessedMessages(sourceId: string, now: Date): boolean;
  reconcileUnprocessedMessages(sourceId: string, now: Date, limit?: number): ReconcileFeishuUnprocessedResult;
  deleteExpiredMessages(now?: Date): number;
}
