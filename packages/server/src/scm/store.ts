import type {
  AdvanceScmEntitySnapshotResult,
  ClaimScmSyncStreamInput,
  MultiremiScmConnection,
  MultiremiScmConnectionCredential,
  MultiremiScmEntitySnapshot,
  MultiremiScmEntityType,
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
import type { ScmIngestionStore, ScmRecordResult } from "./types.js";

/** The MultiremiStore facade prefixes SCM methods to avoid domain-name collisions. */
export interface ScmStoreFacade {
  listScmConnections(input?: {
    workspaceId?: string;
    provider?: MultiremiScmProvider;
    enabled?: boolean;
  }): MultiremiScmConnection[];
  getScmConnection(id: string): MultiremiScmConnection | null;
  getScmConnectionCredential(id: string): MultiremiScmConnectionCredential | null;
  listScmRepositoryBindings(input?: {
    connectionId?: string;
    workspaceId?: string;
    enabled?: boolean;
  }): MultiremiScmRepositoryBinding[];
  getScmSyncCursor(
    connectionId: string,
    repositoryId: string,
    stream: MultiremiScmSyncStream,
  ): MultiremiScmSyncCursor | null;
  upsertScmSyncCursor(input: UpsertScmSyncCursorInput): MultiremiScmSyncCursor;
  claimScmSyncStream(input: ClaimScmSyncStreamInput): MultiremiScmSyncCursor | null;
  updateClaimedScmSyncCursor(input: UpdateClaimedScmSyncCursorInput): MultiremiScmSyncCursor | null;
  releaseScmSyncStream(input: ReleaseScmSyncStreamInput): boolean;
  getScmEntitySnapshot(
    connectionId: string,
    repositoryId: string,
    entityType: MultiremiScmEntityType,
    externalId: string,
  ): MultiremiScmEntitySnapshot | null;
  upsertScmEntitySnapshot(input: UpsertScmEntitySnapshotInput): MultiremiScmEntitySnapshot;
  advanceScmEntitySnapshot(input: UpsertScmEntitySnapshotInput): AdvanceScmEntitySnapshotResult;
  recordScmCanonicalEvent(input: RecordScmCanonicalEventInput): ScmRecordResult;
}

export function scmIngestionStore(facade: ScmStoreFacade): ScmIngestionStore {
  return {
    listConnections: (input) => facade.listScmConnections(input),
    getConnection: (id) => facade.getScmConnection(id),
    getConnectionCredential: (id) => facade.getScmConnectionCredential(id),
    listRepositoryBindings: (input) => facade.listScmRepositoryBindings(input),
    getSyncCursor: (connectionId, repositoryId, stream) =>
      facade.getScmSyncCursor(connectionId, repositoryId, stream),
    upsertSyncCursor: (input) => facade.upsertScmSyncCursor(input),
    claimSyncStream: (input) => facade.claimScmSyncStream(input),
    updateClaimedSyncCursor: (input) => facade.updateClaimedScmSyncCursor(input),
    releaseSyncStream: (input) => facade.releaseScmSyncStream(input),
    getEntitySnapshot: (connectionId, repositoryId, entityType, externalId) =>
      facade.getScmEntitySnapshot(connectionId, repositoryId, entityType, externalId),
    upsertEntitySnapshot: (input) => facade.upsertScmEntitySnapshot(input),
    advanceEntitySnapshot: (input) => facade.advanceScmEntitySnapshot(input),
    recordCanonicalEvent: (input) => facade.recordScmCanonicalEvent(input),
  };
}
