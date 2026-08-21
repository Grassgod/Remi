import type {
  MultiremiScmCanonicalEvent,
  MultiremiScmConnection,
  MultiremiScmConnectionCredential,
  MultiremiScmEntitySnapshot,
  MultiremiScmProvider,
  MultiremiScmRepositoryBinding,
  MultiremiScmSyncCursor,
  RecordScmCanonicalEventInput,
  UpsertScmEntitySnapshotInput,
  UpsertScmSyncCursorInput,
} from "@multiremi/contracts/types.js";
import type { ScmIngestionStore, ScmRecordResult } from "@multiremi/scm/types.js";

export function scmConnection(overrides: Partial<MultiremiScmConnection> = {}): MultiremiScmConnection {
  return {
    id: "scm_1",
    workspaceId: "local",
    name: "GitHub",
    provider: "github",
    mode: "hybrid",
    baseUrl: "https://github.com",
    apiBaseUrl: "https://api.github.com",
    enabled: true,
    pollIntervalSeconds: 60,
    accessTokenSet: true,
    accessTokenHint: "ghp_...",
    webhookSecretSet: true,
    webhookSecretHint: "sec...",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

export function scmBinding(overrides: Partial<MultiremiScmRepositoryBinding> = {}): MultiremiScmRepositoryBinding {
  return {
    id: "srb_1",
    workspaceId: "local",
    connectionId: "scm_1",
    repositoryId: "repo_1",
    repositoryUrl: "https://github.com/acme/widgets.git",
    externalId: "101",
    owner: "acme",
    name: "widgets",
    defaultBranch: "main",
    enabled: true,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

export class MemoryScmIngestionStore implements ScmIngestionStore {
  connections: MultiremiScmConnection[] = [scmConnection()];
  bindings: MultiremiScmRepositoryBinding[] = [scmBinding()];
  credentials = new Map<string, MultiremiScmConnectionCredential>([["scm_1", { accessToken: "token", webhookSecret: "secret" }]]);
  cursors = new Map<string, MultiremiScmSyncCursor>();
  snapshots = new Map<string, MultiremiScmEntitySnapshot>();
  events = new Map<string, MultiremiScmCanonicalEvent>();
  evidences = new Set<string>();
  recordInputs: RecordScmCanonicalEventInput[] = [];

  listConnections(input: { workspaceId?: string; provider?: MultiremiScmProvider; enabled?: boolean } = {}) {
    return this.connections.filter((connection) =>
      (input.workspaceId === undefined || connection.workspaceId === input.workspaceId)
      && (input.provider === undefined || connection.provider === input.provider)
      && (input.enabled === undefined || connection.enabled === input.enabled)
    );
  }

  getConnection(id: string) {
    return this.connections.find((connection) => connection.id === id) ?? null;
  }

  getConnectionCredential(id: string) {
    return this.credentials.get(id) ?? null;
  }

  listRepositoryBindings(input: { connectionId?: string; workspaceId?: string; enabled?: boolean } = {}) {
    return this.bindings.filter((binding) =>
      (input.connectionId === undefined || binding.connectionId === input.connectionId)
      && (input.workspaceId === undefined || binding.workspaceId === input.workspaceId)
      && (input.enabled === undefined || binding.enabled === input.enabled)
    );
  }

  getSyncCursor(connectionId: string, repositoryId: string, stream: MultiremiScmSyncCursor["stream"]) {
    return this.cursors.get(`${connectionId}:${repositoryId}:${stream}`) ?? null;
  }

  upsertSyncCursor(input: UpsertScmSyncCursorInput): MultiremiScmSyncCursor {
    const key = `${input.connectionId}:${input.repositoryId}:${input.stream}`;
    const current = this.cursors.get(key);
    const value: MultiremiScmSyncCursor = {
      connectionId: input.connectionId,
      repositoryId: input.repositoryId,
      stream: input.stream,
      cursor: input.cursor === undefined ? current?.cursor ?? null : input.cursor,
      watermark: input.watermark === undefined ? current?.watermark ?? null : input.watermark,
      baselineCompletedAt: input.baselineCompletedAt === undefined ? current?.baselineCompletedAt ?? null : input.baselineCompletedAt,
      lastStartedAt: input.lastStartedAt === undefined ? current?.lastStartedAt ?? null : input.lastStartedAt,
      lastCompletedAt: input.lastCompletedAt === undefined ? current?.lastCompletedAt ?? null : input.lastCompletedAt,
      lastError: input.lastError === undefined ? current?.lastError ?? null : input.lastError,
      updatedAt: new Date().toISOString(),
    };
    this.cursors.set(key, value);
    return value;
  }

  getEntitySnapshot(connectionId: string, repositoryId: string, entityType: MultiremiScmEntitySnapshot["entityType"], externalId: string) {
    return this.snapshots.get(`${connectionId}:${repositoryId}:${entityType}:${externalId}`) ?? null;
  }

  upsertEntitySnapshot(input: UpsertScmEntitySnapshotInput): MultiremiScmEntitySnapshot {
    const key = `${input.connectionId}:${input.repositoryId}:${input.entityType}:${input.externalId}`;
    const current = this.snapshots.get(key);
    const now = input.observedAt ?? new Date().toISOString();
    const value: MultiremiScmEntitySnapshot = {
      connectionId: input.connectionId,
      repositoryId: input.repositoryId,
      entityType: input.entityType,
      externalId: input.externalId,
      version: input.version ?? null,
      contentHash: input.contentHash,
      payload: input.payload,
      observedAt: now,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.snapshots.set(key, value);
    return value;
  }

  recordCanonicalEvent(input: RecordScmCanonicalEventInput): ScmRecordResult {
    this.recordInputs.push(input);
    const current = this.events.get(input.logicalKey);
    const created = !current;
    const connection = this.getConnection(input.connectionId)!;
    const now = input.observedAt ?? new Date().toISOString();
    const event: MultiremiScmCanonicalEvent = current ?? {
      id: `sce_${this.events.size + 1}`,
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      repositoryId: input.repositoryId,
      provider: connection.provider,
      type: input.type,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      logicalKey: input.logicalKey,
      primarySource: input.evidence.source,
      fidelity: input.fidelity,
      occurredAt: input.occurredAt ?? null,
      observedAt: now,
      payload: input.payload,
      status: "pending",
      attemptCount: 0,
      availableAt: now,
      leaseUntil: null,
      lastError: null,
      processedAt: null,
      createdAt: now,
    };
    this.events.set(input.logicalKey, event);
    const evidenceKey = `${event.id}:${input.evidence.dedupeKey}`;
    const evidenceCreated = !this.evidences.has(evidenceKey);
    this.evidences.add(evidenceKey);
    return { event, created, evidenceCreated };
  }
}

