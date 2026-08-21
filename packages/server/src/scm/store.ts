import type {
  MultiremiScmConnection,
  MultiremiScmConnectionCredential,
  MultiremiScmEntitySnapshot,
  MultiremiScmEntityType,
  MultiremiScmProvider,
  MultiremiScmRepositoryBinding,
  MultiremiScmSyncCursor,
  MultiremiScmSyncStream,
  RecordScmCanonicalEventInput,
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
  getScmEntitySnapshot(
    connectionId: string,
    repositoryId: string,
    entityType: MultiremiScmEntityType,
    externalId: string,
  ): MultiremiScmEntitySnapshot | null;
  upsertScmEntitySnapshot(input: UpsertScmEntitySnapshotInput): MultiremiScmEntitySnapshot;
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
    getEntitySnapshot: (connectionId, repositoryId, entityType, externalId) =>
      facade.getScmEntitySnapshot(connectionId, repositoryId, entityType, externalId),
    upsertEntitySnapshot: (input) => facade.upsertScmEntitySnapshot(input),
    recordCanonicalEvent: (input) => facade.recordScmCanonicalEvent(input),
  };
}
