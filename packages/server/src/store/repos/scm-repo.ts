import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { decryptScmCredential, encryptScmCredential } from "@multiremi/scm/credentials.js";
import { assertScmRepositoryMatchesConnection } from "@multiremi/scm/repository-url.js";
import type {
  AdvanceScmEntitySnapshotResult,
  ClaimScmSyncStreamInput,
  CreateScmConnectionInput,
  MultiremiAutopilotRun,
  MultiremiAutopilotScmEventConfig,
  MultiremiScmCanonicalEvent,
  MultiremiScmCanonicalEventType,
  MultiremiScmConnection,
  MultiremiScmConnectionCredential,
  MultiremiScmEntitySnapshot,
  MultiremiScmEntityType,
  MultiremiScmEventEvidence,
  MultiremiScmEventDelivery,
  MultiremiScmEventSource,
  MultiremiScmProvider,
  MultiremiScmRepositoryBinding,
  MultiremiScmSyncCursor,
  MultiremiScmSyncMode,
  MultiremiScmSyncStream,
  RecordScmCanonicalEventInput,
  ReleaseScmSyncStreamInput,
  UpdateScmConnectionInput,
  UpdateClaimedScmSyncCursorInput,
  UpsertScmEntitySnapshotInput,
  UpsertScmRepositoryBindingInput,
  UpsertScmSyncCursorInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export interface ScmConnectionWithRepositories extends MultiremiScmConnection {
  repositories: MultiremiScmRepositoryBinding[];
}

export interface RecordScmCanonicalEventResult {
  event: MultiremiScmCanonicalEvent;
  created: boolean;
  evidenceCreated: boolean;
}

export class ScmRepo {
  constructor(private readonly ctx: StoreContext) {}

  listConnections(input: {
    workspaceId?: string | null;
    provider?: MultiremiScmProvider | null;
    enabled?: boolean;
  } = {}): MultiremiScmConnection[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (input.workspaceId) {
      clauses.push("workspace_id = ?");
      args.push(input.workspaceId);
    }
    if (input.provider) {
      clauses.push("provider = ?");
      args.push(input.provider);
    }
    if (input.enabled !== undefined) {
      clauses.push("enabled = ?");
      args.push(input.enabled ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_scm_connections ${where} ORDER BY created_at ASC, id ASC`,
    ).all(...args) as Row[];
    return rows.map(toScmConnection);
  }

  listConnectionsWithRepositories(input: {
    workspaceId?: string | null;
    provider?: MultiremiScmProvider | null;
    enabled?: boolean;
  } = {}): ScmConnectionWithRepositories[] {
    return this.listConnections(input).map((connection) => ({
      ...connection,
      repositories: this.listRepositoryBindings({ connectionId: connection.id }),
    }));
  }

  getConnection(id: string): MultiremiScmConnection | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_scm_connections WHERE id = ?").get(id) as Row | null;
    return row ? toScmConnection(row) : null;
  }

  getConnectionWithRepositories(id: string): ScmConnectionWithRepositories | null {
    const connection = this.getConnection(id);
    return connection ? { ...connection, repositories: this.listRepositoryBindings({ connectionId: id }) } : null;
  }

  createConnection(input: CreateScmConnectionInput): ScmConnectionWithRepositories {
    const workspaceId = cleanOptionalString(input.workspaceId ?? input.workspace_id) ?? "local";
    const workspace = workspaceId === "local"
      ? this.ctx.workspaces().getWorkspace("local")
      : this.ctx.workspaces().getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const provider = normalizeProvider(input.provider);
    const mode = normalizeMode(input.mode ?? "poll");
    const name = requiredString(input.name, "SCM connection name");
    const id = input.id ?? createId("scm");
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? input.base_url, provider);
    const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl ?? input.api_base_url, provider, baseUrl);
    const pollIntervalSeconds = normalizePollInterval(input.pollIntervalSeconds ?? input.poll_interval_seconds);
    const accessToken = optionalSecret(input.accessToken ?? input.access_token, "access token");
    const webhookSecret = optionalSecret(input.webhookSecret ?? input.webhook_secret, "webhook secret");
    const now = nowIso();
    const repositoryIds = uniqueStrings(input.repositoryIds ?? input.repository_ids ?? []);

    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT INTO multiremi_scm_connections (
          id, workspace_id, name, provider, mode, base_url, api_base_url, enabled,
          poll_interval_seconds, access_token_encrypted, access_token_hint,
          webhook_secret_encrypted, webhook_secret_hint, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          workspaceId,
          name,
          provider,
          mode,
          baseUrl,
          apiBaseUrl,
          input.enabled === false ? 0 : 1,
          pollIntervalSeconds,
          accessToken ? encryptScmCredential(accessToken, { workspaceId, connectionId: id, field: "access_token" }) : null,
          secretHint(accessToken),
          webhookSecret ? encryptScmCredential(webhookSecret, { workspaceId, connectionId: id, field: "webhook_secret" }) : null,
          secretHint(webhookSecret),
          now,
          now,
        ],
      );
      for (const repositoryId of repositoryIds) {
        const repository = findWorkspaceRepository(workspace.repos, repositoryId);
        if (!repository) throw new Error(`Repository not found in workspace: ${repositoryId}`);
        this.upsertRepositoryBindingLocked({
          workspaceId,
          connectionId: id,
          repositoryId,
          repositoryUrl: repository.url,
          repositorySource: repository.source,
          name: repository.name,
          defaultBranch: repository.defaultBranch,
        });
      }
    })();
    return this.getConnectionWithRepositories(id)!;
  }

  updateConnection(id: string, input: UpdateScmConnectionInput): ScmConnectionWithRepositories {
    const current = this.getConnection(id);
    if (!current) throw new Error(`SCM connection not found: ${id}`);
    const replaceAccessToken = input.accessToken !== undefined || input.access_token !== undefined;
    const clearAccessToken = Boolean(input.clearAccessToken ?? input.clear_access_token);
    const replaceWebhookSecret = input.webhookSecret !== undefined || input.webhook_secret !== undefined;
    const clearWebhookSecret = Boolean(input.clearWebhookSecret ?? input.clear_webhook_secret);
    if (replaceAccessToken && clearAccessToken) throw new Error("accessToken and clearAccessToken cannot be used together");
    if (replaceWebhookSecret && clearWebhookSecret) throw new Error("webhookSecret and clearWebhookSecret cannot be used together");

    const accessToken = replaceAccessToken
      ? requiredSecret(input.accessToken ?? input.access_token, "access token")
      : null;
    const webhookSecret = replaceWebhookSecret
      ? requiredSecret(input.webhookSecret ?? input.webhook_secret, "webhook secret")
      : null;
    const baseUrl = input.baseUrl !== undefined || input.base_url !== undefined
      ? normalizeBaseUrl(input.baseUrl ?? input.base_url, current.provider)
      : current.baseUrl;
    const apiBaseUrl = input.apiBaseUrl !== undefined || input.api_base_url !== undefined
      ? normalizeApiBaseUrl(input.apiBaseUrl ?? input.api_base_url, current.provider, baseUrl)
      : current.apiBaseUrl;
    for (const binding of this.listRepositoryBindings({ connectionId: id })) {
      assertScmRepositoryMatchesConnection(binding.repositoryUrl, baseUrl);
    }
    const now = nowIso();
    this.ctx.db.run(
      `UPDATE multiremi_scm_connections SET
        name = ?, mode = ?, base_url = ?, api_base_url = ?, enabled = ?, poll_interval_seconds = ?,
        access_token_encrypted = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE access_token_encrypted END,
        access_token_hint = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE access_token_hint END,
        webhook_secret_encrypted = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE webhook_secret_encrypted END,
        webhook_secret_hint = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE webhook_secret_hint END,
        updated_at = ?
       WHERE id = ?`,
      [
        input.name === undefined ? current.name : requiredString(input.name, "SCM connection name"),
        input.mode === undefined ? current.mode : normalizeMode(input.mode),
        baseUrl,
        apiBaseUrl,
        input.enabled === undefined ? (current.enabled ? 1 : 0) : (input.enabled ? 1 : 0),
        input.pollIntervalSeconds === undefined && input.poll_interval_seconds === undefined
          ? current.pollIntervalSeconds
          : normalizePollInterval(input.pollIntervalSeconds ?? input.poll_interval_seconds),
        replaceAccessToken ? 1 : 0,
        accessToken ? encryptScmCredential(accessToken, { workspaceId: current.workspaceId, connectionId: id, field: "access_token" }) : null,
        clearAccessToken ? 1 : 0,
        replaceAccessToken ? 1 : 0,
        secretHint(accessToken),
        clearAccessToken ? 1 : 0,
        replaceWebhookSecret ? 1 : 0,
        webhookSecret ? encryptScmCredential(webhookSecret, { workspaceId: current.workspaceId, connectionId: id, field: "webhook_secret" }) : null,
        clearWebhookSecret ? 1 : 0,
        replaceWebhookSecret ? 1 : 0,
        secretHint(webhookSecret),
        clearWebhookSecret ? 1 : 0,
        now,
        id,
      ],
    );
    return this.getConnectionWithRepositories(id)!;
  }

  deleteConnection(id: string): boolean {
    return this.ctx.db.transaction(() => {
      const locked = this.ctx.db.query(
        "UPDATE multiremi_scm_connections SET updated_at = updated_at WHERE id = ? RETURNING id",
      ).get(id) as Row | null;
      if (!locked) return false;
      const eventCount = this.ctx.db.query(
        "SELECT COUNT(*) AS count FROM multiremi_scm_events WHERE connection_id = ?",
      ).get(id) as { count?: number } | null;
      if (Number(eventCount?.count ?? 0) > 0) {
        throw new Error("SCM connection has event history; disable it instead of deleting it");
      }
      this.ctx.db.run("DELETE FROM multiremi_scm_sync_cursors WHERE connection_id = ?", [id]);
      this.ctx.db.run("DELETE FROM multiremi_scm_entity_snapshots WHERE connection_id = ?", [id]);
      this.ctx.db.run("DELETE FROM multiremi_scm_repository_bindings WHERE connection_id = ?", [id]);
      return this.ctx.db.run("DELETE FROM multiremi_scm_connections WHERE id = ?", [id]).changes > 0;
    })();
  }

  getConnectionCredential(id: string): MultiremiScmConnectionCredential | null {
    const row = this.ctx.db.query(
      `SELECT workspace_id, access_token_encrypted, webhook_secret_encrypted
       FROM multiremi_scm_connections WHERE id = ?`,
    ).get(id) as Row | null;
    if (!row) return null;
    const workspaceId = String(row.workspace_id ?? "local");
    const accessTokenEncrypted = nullableString(row.access_token_encrypted);
    const webhookSecretEncrypted = nullableString(row.webhook_secret_encrypted);
    return {
      accessToken: accessTokenEncrypted
        ? decryptScmCredential(accessTokenEncrypted, { workspaceId, connectionId: id, field: "access_token" })
        : null,
      webhookSecret: webhookSecretEncrypted
        ? decryptScmCredential(webhookSecretEncrypted, { workspaceId, connectionId: id, field: "webhook_secret" })
        : null,
    };
  }

  listRepositoryBindings(input: {
    connectionId?: string | null;
    workspaceId?: string | null;
    enabled?: boolean;
  } = {}): MultiremiScmRepositoryBinding[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (input.connectionId) {
      clauses.push("connection_id = ?");
      args.push(input.connectionId);
    }
    if (input.workspaceId) {
      clauses.push("workspace_id = ?");
      args.push(input.workspaceId);
    }
    if (input.enabled !== undefined) {
      clauses.push("enabled = ?");
      args.push(input.enabled ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_scm_repository_bindings ${where} ORDER BY created_at ASC, id ASC`,
    ).all(...args) as Row[]).map(toRepositoryBinding);
  }

  getRepositoryBinding(connectionId: string, repositoryId: string): MultiremiScmRepositoryBinding | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_scm_repository_bindings WHERE connection_id = ? AND repository_id = ?",
    ).get(connectionId, repositoryId) as Row | null;
    return row ? toRepositoryBinding(row) : null;
  }

  findRepositoryBindingByUrl(workspaceId: string, repositoryUrl: string): MultiremiScmRepositoryBinding | null {
    const target = canonicalGitUrl(repositoryUrl);
    return this.listRepositoryBindings({ workspaceId, enabled: true })
      .find((binding) => canonicalGitUrl(binding.repositoryUrl) === target) ?? null;
  }

  upsertRepositoryBinding(input: UpsertScmRepositoryBindingInput): MultiremiScmRepositoryBinding {
    return this.ctx.db.transaction(() => this.upsertRepositoryBindingLocked(input))();
  }

  private upsertRepositoryBindingLocked(input: UpsertScmRepositoryBindingInput): MultiremiScmRepositoryBinding {
      const connection = this.lockConnection(input.connectionId);
      if (connection.workspaceId !== input.workspaceId) throw new Error("SCM connection belongs to another workspace");
      const repositorySource = normalizeRepositorySource(input.repositorySource ?? input.repository_source);
      if (repositorySource !== "unknown" && repositorySource !== connection.provider) {
        throw new Error(`Repository source ${repositorySource} does not match SCM connection provider ${connection.provider}`);
      }
      const repositoryUrl = requiredString(input.repositoryUrl, "repository URL");
      assertScmRepositoryMatchesConnection(repositoryUrl, connection.baseUrl);
      const existing = this.ctx.db.query(
        "SELECT connection_id FROM multiremi_scm_repository_bindings WHERE workspace_id = ? AND repository_id = ?",
      ).get(input.workspaceId, input.repositoryId) as Row | null;
      if (existing && String(existing.connection_id) !== input.connectionId) {
        throw new Error("Repository is already bound to another SCM connection; unbind it before moving providers");
      }
      const coordinates = repositoryCoordinatesFromUrl(repositoryUrl);
      const id = createId("srb");
      const now = nowIso();
      this.ctx.db.run(
      `INSERT INTO multiremi_scm_repository_bindings (
        id, workspace_id, connection_id, repository_id, repository_url, external_id,
        owner, name, default_branch, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, repository_id) DO UPDATE SET
        repository_url = excluded.repository_url,
        external_id = excluded.external_id,
        owner = excluded.owner,
        name = excluded.name,
        default_branch = excluded.default_branch,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at`,
      [
        id,
        input.workspaceId,
        input.connectionId,
        requiredString(input.repositoryId, "repository ID"),
        repositoryUrl,
        cleanOptionalString(input.externalId),
        cleanOptionalString(input.owner) ?? coordinates.owner,
        requiredString(input.name, "repository name"),
        cleanOptionalString(input.defaultBranch),
        input.enabled === false ? 0 : 1,
        now,
        now,
        ],
      );
      return this.getRepositoryBinding(input.connectionId, input.repositoryId)!;
  }

  deleteRepositoryBinding(connectionId: string, repositoryId: string): boolean {
    return this.ctx.db.transaction(() => {
      const connection = this.ctx.db.query(
        "UPDATE multiremi_scm_connections SET updated_at = updated_at WHERE id = ? RETURNING id",
      ).get(connectionId) as Row | null;
      if (!connection) return false;
      const binding = this.ctx.db.query(
        `UPDATE multiremi_scm_repository_bindings SET updated_at = updated_at
         WHERE connection_id = ? AND repository_id = ? RETURNING id`,
      ).get(connectionId, repositoryId) as Row | null;
      if (!binding) return false;
      this.ctx.db.run(
        "DELETE FROM multiremi_scm_sync_cursors WHERE connection_id = ? AND repository_id = ?",
        [connectionId, repositoryId],
      );
      this.ctx.db.run(
        "DELETE FROM multiremi_scm_entity_snapshots WHERE connection_id = ? AND repository_id = ?",
        [connectionId, repositoryId],
      );
      return this.ctx.db.run(
        "DELETE FROM multiremi_scm_repository_bindings WHERE connection_id = ? AND repository_id = ?",
        [connectionId, repositoryId],
      ).changes > 0;
    })();
  }

  getSyncCursor(connectionId: string, repositoryId: string, stream: MultiremiScmSyncStream): MultiremiScmSyncCursor | null {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_scm_sync_cursors
       WHERE connection_id = ? AND repository_id = ? AND stream = ?`,
    ).get(connectionId, repositoryId, stream) as Row | null;
    return row ? toSyncCursor(row) : null;
  }

  upsertSyncCursor(input: UpsertScmSyncCursorInput): MultiremiScmSyncCursor {
    return this.ctx.db.transaction(() => {
      this.lockConnectionAndBinding(input.connectionId, input.repositoryId);
      const current = this.getSyncCursor(input.connectionId, input.repositoryId, input.stream);
      const now = nowIso();
      this.ctx.db.run(
      `INSERT INTO multiremi_scm_sync_cursors (
        connection_id, repository_id, stream, cursor, watermark, baseline_completed_at,
        last_started_at, last_completed_at, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, repository_id, stream) DO UPDATE SET
        cursor = excluded.cursor,
        watermark = excluded.watermark,
        baseline_completed_at = excluded.baseline_completed_at,
        last_started_at = excluded.last_started_at,
        last_completed_at = excluded.last_completed_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at`,
      [
        input.connectionId,
        input.repositoryId,
        input.stream,
        toNullableJson(input.cursor === undefined ? current?.cursor ?? null : input.cursor),
        input.watermark === undefined ? current?.watermark ?? null : input.watermark,
        input.baselineCompletedAt === undefined ? current?.baselineCompletedAt ?? null : input.baselineCompletedAt,
        input.lastStartedAt === undefined ? current?.lastStartedAt ?? null : input.lastStartedAt,
        input.lastCompletedAt === undefined ? current?.lastCompletedAt ?? null : input.lastCompletedAt,
        input.lastError === undefined ? current?.lastError ?? null : input.lastError,
        now,
        ],
      );
      return this.getSyncCursor(input.connectionId, input.repositoryId, input.stream)!;
    })();
  }

  claimSyncStream(input: ClaimScmSyncStreamInput): MultiremiScmSyncCursor | null {
    const owner = requiredString(input.owner, "SCM sync lease owner");
    const claimedAt = normalizeIsoTimestamp(input.now ?? nowIso(), "SCM sync lease time");
    const leaseMs = normalizeLeaseMs(input.leaseMs);
    const leaseUntil = new Date(Date.parse(claimedAt) + leaseMs).toISOString();
    const leaseToken = createId("scl", 24);
    return this.ctx.db.transaction(() => {
      this.lockConnectionAndBinding(input.connectionId, input.repositoryId);
      this.ctx.db.run(
        `INSERT OR IGNORE INTO multiremi_scm_sync_cursors (
          connection_id, repository_id, stream, cursor, watermark, baseline_completed_at,
          last_started_at, last_completed_at, last_error, lease_owner, lease_until, lease_token, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
        [input.connectionId, input.repositoryId, input.stream, claimedAt],
      );
      const row = this.ctx.db.query(
        `UPDATE multiremi_scm_sync_cursors
         SET lease_owner = ?, lease_until = ?, lease_token = ?, updated_at = ?
         WHERE connection_id = ? AND repository_id = ? AND stream = ?
           AND (lease_token IS NULL OR lease_until IS NULL OR lease_until <= ?)
         RETURNING *`,
      ).get(
        owner,
        leaseUntil,
        leaseToken,
        claimedAt,
        input.connectionId,
        input.repositoryId,
        input.stream,
        claimedAt,
      ) as Row | null;
      return row ? toSyncCursor(row) : null;
    })();
  }

  updateClaimedSyncCursor(input: UpdateClaimedScmSyncCursorInput): MultiremiScmSyncCursor | null {
    const leaseToken = requiredString(input.leaseToken, "SCM sync lease token");
    const now = nowIso();
    const leaseUntil = input.leaseUntil === undefined
      ? null
      : normalizeIsoTimestamp(input.leaseUntil, "SCM sync lease expiry");
    const row = this.ctx.db.query(
      `UPDATE multiremi_scm_sync_cursors SET
        cursor = CASE WHEN ? = 1 THEN ? ELSE cursor END,
        watermark = CASE WHEN ? = 1 THEN ? ELSE watermark END,
        baseline_completed_at = CASE WHEN ? = 1 THEN ? ELSE baseline_completed_at END,
        last_started_at = CASE WHEN ? = 1 THEN ? ELSE last_started_at END,
        last_completed_at = CASE WHEN ? = 1 THEN ? ELSE last_completed_at END,
        last_error = CASE WHEN ? = 1 THEN ? ELSE last_error END,
        lease_until = CASE WHEN ? = 1 THEN ? ELSE lease_until END,
        updated_at = ?
       WHERE connection_id = ? AND repository_id = ? AND stream = ? AND lease_token = ?
       RETURNING *`,
    ).get(
      input.cursor === undefined ? 0 : 1,
      input.cursor === undefined ? null : toNullableJson(input.cursor),
      input.watermark === undefined ? 0 : 1,
      input.watermark ?? null,
      input.baselineCompletedAt === undefined ? 0 : 1,
      input.baselineCompletedAt ?? null,
      input.lastStartedAt === undefined ? 0 : 1,
      input.lastStartedAt ?? null,
      input.lastCompletedAt === undefined ? 0 : 1,
      input.lastCompletedAt ?? null,
      input.lastError === undefined ? 0 : 1,
      input.lastError ?? null,
      input.leaseUntil === undefined ? 0 : 1,
      leaseUntil,
      now,
      input.connectionId,
      input.repositoryId,
      input.stream,
      leaseToken,
    ) as Row | null;
    return row ? toSyncCursor(row) : null;
  }

  releaseSyncStream(input: ReleaseScmSyncStreamInput): boolean {
    const leaseToken = requiredString(input.leaseToken, "SCM sync lease token");
    return this.ctx.db.run(
      `UPDATE multiremi_scm_sync_cursors
       SET lease_owner = NULL, lease_until = NULL, lease_token = NULL, updated_at = ?
       WHERE connection_id = ? AND repository_id = ? AND stream = ? AND lease_token = ?`,
      [nowIso(), input.connectionId, input.repositoryId, input.stream, leaseToken],
    ).changes > 0;
  }

  getEntitySnapshot(
    connectionId: string,
    repositoryId: string,
    entityType: MultiremiScmEntityType,
    externalId: string,
  ): MultiremiScmEntitySnapshot | null {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_scm_entity_snapshots
       WHERE connection_id = ? AND repository_id = ? AND entity_type = ? AND external_id = ?`,
    ).get(connectionId, repositoryId, entityType, externalId) as Row | null;
    return row ? toEntitySnapshot(row) : null;
  }

  upsertEntitySnapshot(input: UpsertScmEntitySnapshotInput): MultiremiScmEntitySnapshot {
    return this.advanceEntitySnapshot(input).snapshot;
  }

  advanceEntitySnapshot(input: UpsertScmEntitySnapshotInput): AdvanceScmEntitySnapshotResult {
    const now = nowIso();
    const observedAt = normalizeIsoTimestamp(input.observedAt ?? now, "snapshot observation time");
    const revisionAt = normalizeIsoTimestamp(input.revisionAt ?? observedAt, "snapshot revision time");
    const contentHash = requiredString(input.contentHash, "snapshot content hash");
    const revision = requiredString(input.revision ?? cleanOptionalString(input.version) ?? contentHash, "snapshot revision");
    return this.ctx.db.transaction(() => {
      this.lockConnectionAndBinding(input.connectionId, input.repositoryId);
      const values = [
        input.connectionId,
        input.repositoryId,
        input.entityType,
        requiredString(input.externalId, "external entity ID"),
        cleanOptionalString(input.version),
        revisionAt,
        revision,
        contentHash,
        toJson(input.payload),
        observedAt,
        now,
        now,
      ];
      const inserted = this.ctx.db.query(
        `INSERT INTO multiremi_scm_entity_snapshots (
          connection_id, repository_id, entity_type, external_id, version, revision_at,
          revision, content_hash, payload, observed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, repository_id, entity_type, external_id) DO NOTHING
        RETURNING *`,
      ).get(...values) as Row | null;
      if (inserted) return { applied: true, previous: null, snapshot: toEntitySnapshot(inserted) };

      // A no-op UPDATE is portable across SQLite/Postgres and holds the entity
      // row lock until this transaction commits. The returned row is therefore
      // the exact predecessor used to derive a state transition.
      const locked = this.ctx.db.query(
        `UPDATE multiremi_scm_entity_snapshots SET updated_at = updated_at
         WHERE connection_id = ? AND repository_id = ? AND entity_type = ? AND external_id = ?
         RETURNING *`,
      ).get(input.connectionId, input.repositoryId, input.entityType, input.externalId) as Row | null;
      if (!locked) throw new Error("SCM snapshot compare-and-set could not lock the current row");
      const previous = toEntitySnapshot(locked);
      if (
        revisionAt < previous.revisionAt
        || (revisionAt === previous.revisionAt && revision <= previous.revision)
      ) {
        return { applied: false, previous, snapshot: previous };
      }
      const updated = this.ctx.db.query(
        `UPDATE multiremi_scm_entity_snapshots SET
          version = ?, revision_at = ?, revision = ?, content_hash = ?, payload = ?,
          observed_at = ?, updated_at = ?
         WHERE connection_id = ? AND repository_id = ? AND entity_type = ? AND external_id = ?
         RETURNING *`,
      ).get(
        cleanOptionalString(input.version),
        revisionAt,
        revision,
        contentHash,
        toJson(input.payload),
        observedAt,
        now,
        input.connectionId,
        input.repositoryId,
        input.entityType,
        input.externalId,
      ) as Row | null;
      if (!updated) throw new Error("SCM snapshot compare-and-set lost its locked row");
      return { applied: true, previous, snapshot: toEntitySnapshot(updated) };
    })();
  }

  recordCanonicalEvent(input: RecordScmCanonicalEventInput): RecordScmCanonicalEventResult {
    const logicalKey = requiredString(input.logicalKey, "SCM logical event key");
    const evidenceDedupeKey = requiredString(input.evidence.dedupeKey, "SCM evidence dedupe key");
    const observedAt = input.observedAt ?? nowIso();
    const eventId = createId("sce");
    const evidenceId = createId("scv");
    let created = false;
    let evidenceCreated = false;

    const event = this.ctx.db.transaction(() => {
      const { connection } = this.lockConnectionAndBinding(input.connectionId, input.repositoryId);
      if (connection.workspaceId !== input.workspaceId) throw new Error("SCM connection belongs to another workspace");
      const inserted = this.ctx.db.run(
        `INSERT OR IGNORE INTO multiremi_scm_events (
          id, workspace_id, connection_id, repository_id, provider, type, subject_type,
          subject_id, logical_key, primary_source, fidelity, occurred_at, observed_at,
          payload, status, attempt_count, available_at, lease_until, last_error, processed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?)`,
        [
          eventId,
          input.workspaceId,
          input.connectionId,
          input.repositoryId,
          connection.provider,
          input.type,
          requiredString(input.subjectType, "SCM event subject type"),
          requiredString(input.subjectId, "SCM event subject ID"),
          logicalKey,
          input.evidence.source,
          input.fidelity,
          input.occurredAt ?? null,
          observedAt,
          toJson(input.payload),
          observedAt,
          observedAt,
        ],
      );
      created = inserted.changes > 0;
      const row = this.ctx.db.query(
        "SELECT * FROM multiremi_scm_events WHERE connection_id = ? AND logical_key = ?",
      ).get(input.connectionId, logicalKey) as Row;
      const canonical = toCanonicalEvent(row);
      if (!created && input.fidelity === "exact" && canonical.fidelity === "inferred") {
        this.ctx.db.run(
          `UPDATE multiremi_scm_events
           SET fidelity = 'exact', occurred_at = COALESCE(?, occurred_at), payload = ?
           WHERE id = ?`,
          [input.occurredAt ?? null, toJson(input.payload), canonical.id],
        );
      }
      const evidenceInsert = this.ctx.db.run(
        `INSERT OR IGNORE INTO multiremi_scm_event_evidence (
          id, event_id, source, provider_event_id, dedupe_key, payload, raw_body, observed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          evidenceId,
          canonical.id,
          input.evidence.source,
          cleanOptionalString(input.evidence.providerEventId),
          evidenceDedupeKey,
          input.evidence.payload == null ? null : toJson(input.evidence.payload),
          input.evidence.rawBody ?? null,
          observedAt,
          nowIso(),
        ],
      );
      evidenceCreated = evidenceInsert.changes > 0;
      if (created) this.ensureEventDeliveriesInitialized(canonical, observedAt);
      return this.getCanonicalEvent(canonical.id)!;
    })();
    return { event, created, evidenceCreated };
  }

  getCanonicalEvent(id: string): MultiremiScmCanonicalEvent | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_scm_events WHERE id = ?").get(id) as Row | null;
    return row ? toCanonicalEvent(row) : null;
  }

  listCanonicalEvents(input: {
    workspaceId: string;
    repositoryId?: string | null;
    connectionId?: string | null;
    type?: MultiremiScmCanonicalEventType | null;
    after?: string | null;
    limit?: number;
  }): MultiremiScmCanonicalEvent[] {
    const clauses = ["workspace_id = ?"];
    const args: unknown[] = [input.workspaceId];
    if (input.repositoryId) {
      clauses.push("repository_id = ?");
      args.push(input.repositoryId);
    }
    if (input.connectionId) {
      clauses.push("connection_id = ?");
      args.push(input.connectionId);
    }
    if (input.type) {
      clauses.push("type = ?");
      args.push(input.type);
    }
    if (input.after) {
      const afterEvent = this.getCanonicalEvent(input.after);
      if (afterEvent) {
        if (
          afterEvent.workspaceId !== input.workspaceId
          || (input.repositoryId && afterEvent.repositoryId !== input.repositoryId)
          || (input.connectionId && afterEvent.connectionId !== input.connectionId)
          || (input.type && afterEvent.type !== input.type)
        ) {
          throw new Error("SCM event cursor does not match the requested scope");
        }
        clauses.push("(observed_at > ? OR (observed_at = ? AND id > ?))");
        args.push(afterEvent.observedAt, afterEvent.observedAt, afterEvent.id);
      } else {
        if (input.after.startsWith("sce_")) throw new Error("SCM event cursor is invalid");
        clauses.push("observed_at > ?");
        args.push(input.after);
      }
    }
    // The API asks for one look-ahead row to produce a stable next cursor.
    args.push(Math.max(1, Math.min(201, Math.floor(input.limit ?? 50))));
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_scm_events WHERE ${clauses.join(" AND ")}
       ORDER BY observed_at ASC, id ASC LIMIT ?`,
    ).all(...args) as Row[]).map(toCanonicalEvent);
  }

  listEventEvidence(eventId: string): MultiremiScmEventEvidence[] {
    return (this.ctx.db.query(
      "SELECT * FROM multiremi_scm_event_evidence WHERE event_id = ? ORDER BY observed_at ASC, id ASC",
    ).all(eventId) as Row[]).map(toEventEvidence);
  }

  listEventDeliveries(eventId: string): MultiremiScmEventDelivery[] {
    return (this.ctx.db.query(
      "SELECT * FROM multiremi_scm_event_deliveries WHERE event_id = ? ORDER BY created_at ASC, id ASC",
    ).all(eventId) as Row[]).map(toEventDelivery);
  }

  claimPendingEvents(now: Date = new Date(), limit = 25): MultiremiScmCanonicalEvent[] {
    const claimedAt = now.toISOString();
    const leaseUntil = new Date(now.getTime() + 60_000).toISOString();
    const rows = this.ctx.db.query(
      `UPDATE multiremi_scm_events
       SET status = 'processing', attempt_count = attempt_count + 1, lease_until = ?, last_error = NULL
       WHERE id IN (
         SELECT id FROM multiremi_scm_events
         WHERE (status = 'pending' AND available_at <= ?)
            OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?)
         ORDER BY observed_at ASC, id ASC
         LIMIT ?
       )
       AND ((status = 'pending' AND available_at <= ?)
         OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?))
       RETURNING *`,
    ).all(
      leaseUntil,
      claimedAt,
      claimedAt,
      Math.max(1, Math.min(100, Math.floor(limit))),
      claimedAt,
      claimedAt,
    ) as Row[];
    return rows.map(toCanonicalEvent);
  }

  dispatchPendingEvents(now: Date = new Date(), limit = 25): MultiremiAutopilotRun[] {
    const runs: MultiremiAutopilotRun[] = [];
    for (const event of this.claimPendingEvents(now, limit)) {
      this.ctx.db.transaction(() => this.ensureEventDeliveriesInitialized(event, now.toISOString()))();
      let deliveries = this.listEventDeliveries(event.id);

      for (const persisted of deliveries) {
        if (persisted.status === "delivered" || persisted.status === "failed" || persisted.status === "skipped") continue;
        const target = this.deliveryTarget(persisted.triggerId);
        if (!target || !target.triggerEnabled || target.autopilotStatus !== "active") {
          const reason = !target
            ? "SCM delivery cancelled because its trigger no longer exists"
            : !target.triggerEnabled
              ? "SCM delivery cancelled because its trigger is disabled"
              : "SCM delivery cancelled because its automation is not active";
          this.ctx.db.run(
            `UPDATE multiremi_scm_event_deliveries
             SET status = 'skipped', lease_until = NULL, last_error = ?, delivered_at = ?, updated_at = ?
             WHERE id = ? AND status IN ('pending', 'processing')`,
            [reason, now.toISOString(), nowIso(), persisted.id],
          );
          continue;
        }
        const delivery = this.claimDelivery(event.id, persisted.triggerId, now);
        if (!delivery) {
          continue;
        }
        try {
          const run = this.ctx.autopilots().runAutopilot(target.autopilotId, {
            source: "scm_event",
            triggerId: persisted.triggerId,
            eventId: event.id,
            payload: {
              event: {
                id: event.id,
                type: event.type,
                provider: event.provider,
                connectionId: event.connectionId,
                repositoryId: event.repositoryId,
                subjectType: event.subjectType,
                subjectId: event.subjectId,
                occurredAt: event.occurredAt,
                observedAt: event.observedAt,
                fidelity: event.fidelity,
              },
              data: event.payload,
            },
          });
          runs.push(run);
          this.ctx.db.run(
            `UPDATE multiremi_scm_event_deliveries
             SET status = ?, autopilot_run_id = ?, lease_until = NULL, last_error = NULL,
                 delivered_at = ?, updated_at = ?
             WHERE id = ? AND status = 'processing'`,
            [run.status === "skipped" ? "skipped" : "delivered", run.id, nowIso(), nowIso(), delivery.id],
          );
          this.ctx.db.run(
            "UPDATE multiremi_autopilot_triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?",
            [nowIso(), nowIso(), persisted.triggerId],
          );
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
          const terminal = delivery.attemptCount >= 8;
          const nextAttempt = new Date(now.getTime() + retryDelayMs(delivery.attemptCount)).toISOString();
          this.ctx.db.run(
            `UPDATE multiremi_scm_event_deliveries
             SET status = ?, available_at = ?, lease_until = NULL, last_error = ?, updated_at = ?
             WHERE id = ? AND status = 'processing'`,
            [terminal ? "failed" : "pending", nextAttempt, message, nowIso(), delivery.id],
          );
        }
      }

      deliveries = this.listEventDeliveries(event.id);
      const hasPending = deliveries.some((delivery) => delivery.status === "pending" || delivery.status === "processing");
      const hasFailed = deliveries.some((delivery) => delivery.status === "failed");
      if (hasPending) {
        this.ctx.db.run(
          `UPDATE multiremi_scm_events SET status = 'pending', available_at = ?, lease_until = NULL,
           last_error = ? WHERE id = ? AND status = 'processing'`,
          [new Date(now.getTime() + retryDelayMs(event.attemptCount)).toISOString(), "one or more deliveries are pending", event.id],
        );
      } else {
        this.ctx.db.run(
          `UPDATE multiremi_scm_events SET status = ?, processed_at = ?, lease_until = NULL,
           last_error = ? WHERE id = ? AND status = 'processing'`,
          [hasFailed ? "failed" : "processed", nowIso(), hasFailed ? "one or more deliveries failed" : null, event.id],
        );
      }
    }
    return runs;
  }

  private matchingTriggersForEvent(event: MultiremiScmCanonicalEvent): Array<{
    id: string;
    autopilotId: string;
  }> {
    const eventTime = normalizeComparableEventTime(event.occurredAt) ?? event.observedAt;
    const rows = this.ctx.db.query(
      `SELECT t.id, t.autopilot_id, t.event_config
       FROM multiremi_autopilot_triggers t
       JOIN multiremi_autopilots a ON a.id = t.autopilot_id
       WHERE t.kind = 'scm_event'
         AND t.enabled = 1
         AND a.status = 'active'
         AND a.workspace_id = ?
         AND t.created_at <= ?
       ORDER BY t.created_at ASC, t.id ASC`,
    ).all(event.workspaceId, eventTime) as Row[];
    return rows.flatMap((row) => {
      const config = parseScmTriggerConfig(row.event_config);
      if (!config || !scmEventMatchesConfig(event, config)) return [];
      return [{ id: String(row.id), autopilotId: String(row.autopilot_id) }];
    });
  }

  private ensureEventDeliveriesInitialized(event: MultiremiScmCanonicalEvent, availableAt: string): void {
    const state = this.ctx.db.query(
      "SELECT targets_initialized FROM multiremi_scm_events WHERE id = ?",
    ).get(event.id) as Row | null;
    if (!state || Boolean(Number(state.targets_initialized ?? 0))) return;
    const createdAt = nowIso();
    for (const trigger of this.matchingTriggersForEvent(event)) {
      this.ctx.db.run(
        `INSERT OR IGNORE INTO multiremi_scm_event_deliveries (
          id, event_id, trigger_id, autopilot_run_id, status, attempt_count,
          available_at, lease_until, last_error, delivered_at, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)`,
        [createId("sdl"), event.id, trigger.id, availableAt, createdAt, createdAt],
      );
    }
    this.ctx.db.run(
      "UPDATE multiremi_scm_events SET targets_initialized = 1 WHERE id = ? AND targets_initialized = 0",
      [event.id],
    );
  }

  private claimDelivery(eventId: string, triggerId: string, now: Date): MultiremiScmEventDelivery | null {
    const claimedAt = now.toISOString();
    const leaseUntil = new Date(now.getTime() + 60_000).toISOString();
    const row = this.ctx.db.query(
      `UPDATE multiremi_scm_event_deliveries
       SET status = 'processing', attempt_count = attempt_count + 1,
           lease_until = ?, last_error = NULL, updated_at = ?
       WHERE event_id = ? AND trigger_id = ?
         AND ((status = 'pending' AND available_at <= ?)
           OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?))
       RETURNING *`,
    ).get(leaseUntil, nowIso(), eventId, triggerId, claimedAt, claimedAt) as Row | null;
    return row ? toEventDelivery(row) : null;
  }

  private deliveryTarget(triggerId: string): {
    autopilotId: string;
    triggerEnabled: boolean;
    autopilotStatus: string;
  } | null {
    const row = this.ctx.db.query(
      `SELECT t.autopilot_id, t.enabled AS trigger_enabled, a.status AS autopilot_status
       FROM multiremi_autopilot_triggers t
       JOIN multiremi_autopilots a ON a.id = t.autopilot_id
       WHERE t.id = ?`,
    ).get(triggerId) as Row | null;
    return row
      ? {
        autopilotId: String(row.autopilot_id),
        triggerEnabled: Boolean(Number(row.trigger_enabled ?? 0)),
        autopilotStatus: String(row.autopilot_status ?? ""),
      }
      : null;
  }

  private lockConnectionAndBinding(
    connectionId: string,
    repositoryId: string,
  ): { connection: MultiremiScmConnection; binding: MultiremiScmRepositoryBinding } {
    const connection = this.lockConnection(connectionId);
    const bindingRow = this.ctx.db.query(
      `UPDATE multiremi_scm_repository_bindings SET updated_at = updated_at
       WHERE connection_id = ? AND repository_id = ? RETURNING *`,
    ).get(connectionId, repositoryId) as Row | null;
    if (!bindingRow) throw new Error(`Repository is not bound to SCM connection: ${repositoryId}`);
    return { connection, binding: toRepositoryBinding(bindingRow) };
  }

  private lockConnection(connectionId: string): MultiremiScmConnection {
    const row = this.ctx.db.query(
      "UPDATE multiremi_scm_connections SET updated_at = updated_at WHERE id = ? RETURNING *",
    ).get(connectionId) as Row | null;
    if (!row) throw new Error(`SCM connection not found: ${connectionId}`);
    return toScmConnection(row);
  }
}

function toScmConnection(row: Row): MultiremiScmConnection {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name ?? ""),
    provider: normalizeProvider(row.provider),
    mode: normalizeMode(row.mode),
    baseUrl: String(row.base_url ?? ""),
    apiBaseUrl: String(row.api_base_url ?? ""),
    enabled: Boolean(Number(row.enabled ?? 1)),
    pollIntervalSeconds: Number(row.poll_interval_seconds ?? 60),
    accessTokenSet: Boolean(nullableString(row.access_token_encrypted)),
    accessTokenHint: nullableString(row.access_token_hint),
    webhookSecretSet: Boolean(nullableString(row.webhook_secret_encrypted)),
    webhookSecretHint: nullableString(row.webhook_secret_hint),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRepositoryBinding(row: Row): MultiremiScmRepositoryBinding {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    connectionId: String(row.connection_id),
    repositoryId: String(row.repository_id),
    repositoryUrl: String(row.repository_url),
    externalId: nullableString(row.external_id),
    owner: nullableString(row.owner),
    name: String(row.name ?? ""),
    defaultBranch: nullableString(row.default_branch),
    enabled: Boolean(Number(row.enabled ?? 1)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSyncCursor(row: Row): MultiremiScmSyncCursor {
  return {
    connectionId: String(row.connection_id),
    repositoryId: String(row.repository_id),
    stream: row.stream as MultiremiScmSyncStream,
    cursor: parseJson(nullableString(row.cursor), null),
    watermark: nullableString(row.watermark),
    baselineCompletedAt: nullableString(row.baseline_completed_at),
    lastStartedAt: nullableString(row.last_started_at),
    lastCompletedAt: nullableString(row.last_completed_at),
    lastError: nullableString(row.last_error),
    leaseOwner: nullableString(row.lease_owner),
    leaseUntil: nullableString(row.lease_until),
    leaseToken: nullableString(row.lease_token),
    updatedAt: String(row.updated_at),
  };
}

function toEntitySnapshot(row: Row): MultiremiScmEntitySnapshot {
  return {
    connectionId: String(row.connection_id),
    repositoryId: String(row.repository_id),
    entityType: row.entity_type as MultiremiScmEntityType,
    externalId: String(row.external_id),
    version: nullableString(row.version),
    revisionAt: String(row.revision_at ?? row.observed_at),
    revision: String(row.revision ?? row.version ?? row.content_hash),
    contentHash: String(row.content_hash),
    payload: parseJson(String(row.payload ?? "{}"), {}),
    observedAt: String(row.observed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toCanonicalEvent(row: Row): MultiremiScmCanonicalEvent {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    connectionId: String(row.connection_id),
    repositoryId: String(row.repository_id),
    provider: normalizeProvider(row.provider),
    type: row.type as MultiremiScmCanonicalEventType,
    subjectType: String(row.subject_type),
    subjectId: String(row.subject_id),
    logicalKey: String(row.logical_key),
    primarySource: row.primary_source as MultiremiScmEventSource,
    fidelity: row.fidelity === "exact" ? "exact" : "inferred",
    occurredAt: nullableString(row.occurred_at),
    observedAt: String(row.observed_at),
    payload: parseJson(String(row.payload ?? "{}"), {}),
    status: row.status as MultiremiScmCanonicalEvent["status"],
    attemptCount: Number(row.attempt_count ?? 0),
    availableAt: String(row.available_at),
    leaseUntil: nullableString(row.lease_until),
    lastError: nullableString(row.last_error),
    processedAt: nullableString(row.processed_at),
    createdAt: String(row.created_at),
  };
}

function toEventEvidence(row: Row): MultiremiScmEventEvidence {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    source: row.source as MultiremiScmEventSource,
    providerEventId: nullableString(row.provider_event_id),
    dedupeKey: String(row.dedupe_key),
    payload: row.payload == null ? null : parseJson(String(row.payload), null),
    rawBody: nullableString(row.raw_body),
    observedAt: String(row.observed_at),
    createdAt: String(row.created_at),
  };
}

function toEventDelivery(row: Row): MultiremiScmEventDelivery {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    triggerId: String(row.trigger_id),
    autopilotRunId: nullableString(row.autopilot_run_id),
    status: row.status as MultiremiScmEventDelivery["status"],
    attemptCount: Number(row.attempt_count ?? 0),
    availableAt: String(row.available_at),
    leaseUntil: nullableString(row.lease_until),
    lastError: nullableString(row.last_error),
    deliveredAt: nullableString(row.delivered_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseScmTriggerConfig(value: unknown): MultiremiAutopilotScmEventConfig | null {
  const parsed = parseJson<Record<string, unknown> | null>(value, null);
  if (!parsed || parsed.resource !== "scm" || !Array.isArray(parsed.events)) return null;
  const events = parsed.events.filter((event): event is MultiremiScmCanonicalEventType => typeof event === "string") as MultiremiScmCanonicalEventType[];
  if (!events.length) return null;
  const repositoryIdsValue = parsed.repositoryIds ?? parsed.repository_ids;
  const repositoryIds = Array.isArray(repositoryIdsValue)
    ? repositoryIdsValue.filter((id): id is string => typeof id === "string")
    : [];
  const connectionId = cleanOptionalString(parsed.connectionId ?? parsed.connection_id) ?? null;
  const branch = cleanOptionalString(parsed.branch) ?? null;
  return { resource: "scm", events, connectionId, repositoryIds, branch };
}

function scmEventMatchesConfig(event: MultiremiScmCanonicalEvent, config: MultiremiAutopilotScmEventConfig): boolean {
  if (!config.events.includes(event.type)) return false;
  const connectionId = config.connectionId ?? config.connection_id ?? null;
  if (connectionId && connectionId !== event.connectionId) return false;
  const repositoryIds = config.repositoryIds ?? config.repository_ids ?? [];
  if (repositoryIds.length && !repositoryIds.includes(event.repositoryId)) return false;
  if (!config.branch) return true;
  const payloadBranch = cleanOptionalString(
    event.payload.branch
      ?? event.payload.defaultBranch
      ?? event.payload.default_branch
      ?? event.payload.targetBranch
      ?? event.payload.target_branch
      ?? event.payload.baseBranch
      ?? event.payload.base_branch,
  );
  return payloadBranch === config.branch;
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(5 * 60_000, 1_000 * (2 ** Math.max(0, attemptCount - 1)));
}

function normalizeProvider(value: unknown): MultiremiScmProvider {
  if (value === "github" || value === "codebase") return value;
  throw new Error("SCM provider must be github or codebase");
}

function normalizeMode(value: unknown): MultiremiScmSyncMode {
  if (value === "poll" || value === "webhook" || value === "hybrid") return value;
  throw new Error("SCM sync mode must be poll, webhook, or hybrid");
}

function normalizeRepositorySource(value: unknown): MultiremiScmProvider | "unknown" {
  if (value == null || value === "unknown") return "unknown";
  if (value === "github" || value === "codebase") return value;
  throw new Error("Repository source must be github, codebase, or unknown");
}

function normalizeLeaseMs(value: unknown): number {
  const leaseMs = value == null ? 60_000 : Math.floor(Number(value));
  if (!Number.isFinite(leaseMs) || leaseMs < 5_000 || leaseMs > 15 * 60_000) {
    throw new Error("SCM sync leaseMs must be between 5000 and 900000");
  }
  return leaseMs;
}

function normalizeIsoTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function normalizeComparableEventTime(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizePollInterval(value: unknown): number {
  const seconds = value == null ? 60 : Math.floor(Number(value));
  if (!Number.isFinite(seconds) || seconds < 15 || seconds > 3_600) {
    throw new Error("pollIntervalSeconds must be between 15 and 3600");
  }
  return seconds;
}

function normalizeBaseUrl(value: unknown, provider: MultiremiScmProvider): string {
  return normalizeHttpUrl(value, provider === "github" ? "https://github.com" : "https://code.byted.org", "base URL");
}

function normalizeApiBaseUrl(value: unknown, provider: MultiremiScmProvider, baseUrl: string): string {
  const base = new URL(baseUrl);
  const fallback = provider === "github"
    ? base.hostname.toLowerCase() === "github.com"
      ? "https://api.github.com"
      : `${base.origin}/api/v3`
    : base.hostname.toLowerCase() === "code.byted.org"
      ? "https://codebase-api.byted.org/v2"
      : `${base.origin}/api/v2`;
  const normalized = normalizeHttpUrl(value, fallback, "API base URL");
  assertTrustedApiUrl(provider, base, new URL(normalized));
  return normalized;
}

function normalizeHttpUrl(value: unknown, fallback: string, label: string): string {
  const raw = cleanOptionalString(value) ?? fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`SCM ${label} is invalid`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`SCM ${label} must not contain user information`);
  }
  if (parsed.protocol !== "https:" && process.env.MULTIREMI_SCM_ALLOW_INSECURE_HTTP !== "1") {
    throw new Error(`SCM ${label} must use HTTPS`);
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/u, "");
}

function assertTrustedApiUrl(provider: MultiremiScmProvider, base: URL, api: URL): void {
  const baseHost = base.hostname.toLowerCase();
  const apiHost = api.hostname.toLowerCase();
  const explicitHosts = new Set(
    (process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  if (isSensitiveApiHost(apiHost) && !explicitHosts.has(apiHost)) {
    throw new Error("SCM API host is loopback or link-local; add it to MULTIREMI_SCM_ALLOWED_API_HOSTS only for an intentional deployment");
  }
  const knownProviderPair = provider === "github"
    ? baseHost === "github.com" && apiHost === "api.github.com"
    : baseHost === "code.byted.org" && apiHost === "codebase-api.byted.org";
  if (!knownProviderPair && !explicitHosts.has(apiHost)) {
    throw new Error("Custom SCM API hosts must be explicitly allowed by MULTIREMI_SCM_ALLOWED_API_HOSTS");
  }
}

function isSensitiveApiHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "0.0.0.0"
    || hostname.startsWith("127.")
    || hostname.startsWith("10.")
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(hostname)
    || hostname.startsWith("192.168.")
    || hostname === "::1"
    || hostname === "[::1]"
    || hostname.startsWith("169.254.")
    || hostname.startsWith("[fe80:")
    || hostname.startsWith("[fc")
    || hostname.startsWith("[fd");
}

function requiredString(value: unknown, label: string): string {
  const clean = cleanOptionalString(value);
  if (!clean) throw new Error(`${label} is required`);
  return clean;
}

function optionalSecret(value: unknown, label: string): string | null {
  if (value == null) return null;
  return requiredSecret(value, label);
}

function requiredSecret(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`SCM ${label} cannot be empty`);
  return value.trim();
}

function secretHint(value: string | null): string | null {
  return value ? value.slice(-4) : null;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function toNullableJson(value: unknown | null): string | null {
  return value == null ? null : toJson(value);
}

function findWorkspaceRepository(repos: unknown, id: string): {
  id: string;
  name: string;
  url: string;
  source: MultiremiScmProvider | "unknown";
  defaultBranch: string | null;
} | null {
  if (!Array.isArray(repos)) return null;
  for (const value of repos) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (String(row.id ?? "") !== id) continue;
    const url = cleanOptionalString(row.url);
    if (!url) return null;
    return {
      id,
      name: cleanOptionalString(row.name) ?? repositoryNameFromUrl(url),
      url,
      source: normalizeRepositorySource(row.source),
      defaultBranch: cleanOptionalString(row.default_branch ?? row.defaultBranch),
    };
  }
  return null;
}

function repositoryNameFromUrl(value: string): string {
  return repositoryCoordinatesFromUrl(value).name ?? "repository";
}

function repositoryCoordinatesFromUrl(value: string): { owner: string | null; name: string | null } {
  const trimmed = value.trim();
  const scpStyle = trimmed.match(/^(?:ssh:\/\/)?[^@\s]+@[^:/\s]+[:/](.+)$/u);
  let path = scpStyle?.[1] ?? "";
  if (!path) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      path = trimmed.includes(":") && !trimmed.includes("://")
        ? trimmed.slice(trimmed.indexOf(":") + 1)
        : trimmed;
    }
  }
  const parts = path.replace(/^\/+|\/+$/gu, "").split("/").filter(Boolean);
  if (!parts.length) return { owner: null, name: null };
  const name = parts.pop()!.replace(/\.git$/iu, "");
  return { owner: parts.join("/") || null, name: name || null };
}

function canonicalGitUrl(value: string): string {
  const trimmed = value.trim().replace(/\.git\/?$/iu, "").replace(/\/$/u, "");
  const ssh = trimmed.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/iu);
  if (ssh) return `${ssh[1]!.toLowerCase()}/${ssh[2]!.toLowerCase()}`;
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/+|\/+$/gu, "").toLowerCase()}`;
  } catch {
    return trimmed.toLowerCase();
  }
}
