import type {
  AdvanceScmEntitySnapshotResult,
  ClaimScmSyncStreamInput,
  MultiremiScmCanonicalEvent,
  MultiremiScmCanonicalEventType,
  MultiremiScmConnection,
  MultiremiScmConnectionCredential,
  MultiremiScmEntitySnapshot,
  MultiremiScmEntityType,
  MultiremiScmEventFidelity,
  MultiremiScmProvider,
  MultiremiScmRepositoryBinding,
  MultiremiScmSyncCursor,
  MultiremiScmSyncStream,
  RecordScmCanonicalEventInput,
  ReleaseScmSyncStreamInput,
  UpdateClaimedScmSyncCursorInput,
  UpsertScmEntitySnapshotInput,
  UpsertScmSyncCursorInput,
} from "@multiremi/contracts/types.js";

export interface ScmStreamCapability {
  poll: boolean;
  webhook: boolean;
  pollFidelity: MultiremiScmEventFidelity | null;
  webhookFidelity: MultiremiScmEventFidelity | null;
  limitations: string[];
}

export interface ScmProviderCapabilities {
  provider: MultiremiScmProvider;
  streams: Record<MultiremiScmSyncStream, ScmStreamCapability>;
  supportsDeleteTombstones: boolean;
  supportsConditionalRequests: boolean;
}

export type ScmNormalizedState = Record<string, unknown>;

/** A provider-neutral entity as observed during one poll. */
export interface ScmEntityObservation {
  stream: MultiremiScmSyncStream;
  entityType: MultiremiScmEntityType;
  externalId: string;
  version: string | null;
  occurredAt: string | null;
  observedAt: string;
  payload: ScmNormalizedState;
}

export interface ScmPollPage {
  observations: ScmEntityObservation[];
  /** Provider-specific continuation state. Null means the stream starts at page one next time. */
  cursor: Record<string, unknown> | null;
  /** High-water timestamp used with an overlap window on the next run. */
  watermark: string | null;
  done: boolean;
}

export interface ScmPollContext {
  connection: MultiremiScmConnection;
  credential: MultiremiScmConnectionCredential;
  binding: MultiremiScmRepositoryBinding;
  stream: MultiremiScmSyncStream;
  cursor: MultiremiScmSyncCursor | null;
  now: Date;
  signal?: AbortSignal;
  heartbeat?: () => void;
}

export interface ScmCanonicalCandidate {
  type: MultiremiScmCanonicalEventType;
  subjectType: string;
  subjectId: string;
  logicalVersion: string;
  occurredAt: string | null;
  payload: Record<string, unknown>;
}

export interface ScmWebhookRequest {
  connection: MultiremiScmConnection;
  credential: MultiremiScmConnectionCredential;
  headers: Record<string, string>;
  rawBody: string;
  body: Record<string, unknown>;
  observedAt: string;
}

export interface ScmWebhookCandidate extends ScmCanonicalCandidate {
  repositoryExternalId: string | null;
  repositoryOwner: string | null;
  repositoryName: string | null;
  providerEventId: string | null;
  /** The provider-neutral snapshot that polling would observe for this event. */
  snapshotObservation?: ScmEntityObservation | null;
}

export interface ScmWebhookParseResult {
  providerEvent: string;
  deliveryId: string | null;
  candidates: ScmWebhookCandidate[];
  ignoredReason: string | null;
}

export interface ScmProviderAdapter {
  readonly provider: MultiremiScmProvider;
  readonly capabilities: ScmProviderCapabilities;
  poll(context: ScmPollContext): Promise<ScmPollPage>;
  verifyWebhook(request: ScmWebhookRequest): boolean;
  parseWebhook(request: ScmWebhookRequest): ScmWebhookParseResult;
}

export interface ScmRecordResult {
  event: MultiremiScmCanonicalEvent;
  created: boolean;
  evidenceCreated: boolean;
}

export interface ScmSnapshotEventWriteResult {
  advance: AdvanceScmEntitySnapshotResult;
  events: ScmRecordResult[];
}

export type ScmSnapshotEventFactory = (
  advance: AdvanceScmEntitySnapshotResult,
) => RecordScmCanonicalEventInput[];

/** Structural store contract shared by the poller and webhook ingestor. */
export interface ScmIngestionStore {
  listConnections(input?: {
    workspaceId?: string;
    provider?: MultiremiScmProvider;
    enabled?: boolean;
  }): MultiremiScmConnection[];
  getConnection(id: string): MultiremiScmConnection | null;
  getConnectionCredential(id: string): MultiremiScmConnectionCredential | null;
  listRepositoryBindings(input?: {
    connectionId?: string;
    workspaceId?: string;
    enabled?: boolean;
  }): MultiremiScmRepositoryBinding[];
  getSyncCursor(
    connectionId: string,
    repositoryId: string,
    stream: MultiremiScmSyncStream,
  ): MultiremiScmSyncCursor | null;
  upsertSyncCursor(input: UpsertScmSyncCursorInput): MultiremiScmSyncCursor;
  claimSyncStream(input: ClaimScmSyncStreamInput): MultiremiScmSyncCursor | null;
  updateClaimedSyncCursor(input: UpdateClaimedScmSyncCursorInput): MultiremiScmSyncCursor | null;
  releaseSyncStream(input: ReleaseScmSyncStreamInput): boolean;
  getEntitySnapshot(
    connectionId: string,
    repositoryId: string,
    entityType: MultiremiScmEntityType,
    externalId: string,
  ): MultiremiScmEntitySnapshot | null;
  upsertEntitySnapshot(input: UpsertScmEntitySnapshotInput): MultiremiScmEntitySnapshot;
  advanceEntitySnapshot(input: UpsertScmEntitySnapshotInput): AdvanceScmEntitySnapshotResult;
  advanceEntitySnapshotWithEvents(
    input: UpsertScmEntitySnapshotInput,
    createEvents: ScmSnapshotEventFactory,
  ): ScmSnapshotEventWriteResult;
  recordCanonicalEvent(input: RecordScmCanonicalEventInput): ScmRecordResult;
}

export const SCM_SYNC_STREAMS: readonly MultiremiScmSyncStream[] = [
  "default_branch",
  "change_requests",
  "comments",
  "reviews",
  "pipelines",
];
