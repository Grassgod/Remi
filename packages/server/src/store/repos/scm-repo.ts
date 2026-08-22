import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { decryptScmCredential, encryptScmCredential } from "@multiremi/scm/credentials.js";
import { assertScmRepositoryMatchesConnection } from "@multiremi/scm/repository-url.js";
import type {
  ScmSnapshotEventFactory,
  ScmSnapshotEventWriteResult,
} from "@multiremi/scm/types.js";
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
  MultiremiScmChangeRequest,
  MultiremiScmEntitySnapshot,
  MultiremiScmEntityType,
  MultiremiScmEventEvidence,
  MultiremiScmEventDelivery,
  MultiremiScmEventSource,
  MultiremiScmIssueLink,
  MultiremiScmProvider,
  MultiremiScmRepositoryAssignmentOrigin,
  MultiremiScmRepositoryBinding,
  MultiremiScmRepositoryScope,
  MultiremiScmSyncCursor,
  MultiremiScmSyncMode,
  MultiremiScmSyncStream,
  MultiremiScmVerificationResult,
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

interface LockedSnapshotAdvanceResult {
  advance: AdvanceScmEntitySnapshotResult;
  projection: { changeRequestId: string; issueIds: string[] } | null;
  workspaceId: string;
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
    const provider = normalizeProvider(input.provider);
    const mode = normalizeMode(input.mode ?? "poll");
    const name = requiredString(input.name, "SCM connection name");
    const id = input.id ?? createId("scm");
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? input.base_url, provider);
    const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl ?? input.api_base_url, provider, baseUrl);
    const pollIntervalSeconds = normalizePollInterval(input.pollIntervalSeconds ?? input.poll_interval_seconds);
    const accessToken = optionalSecret(input.accessToken ?? input.access_token, "access token");
    const webhookSecret = optionalWebhookSecret(input.webhookSecret ?? input.webhook_secret);
    assertWebhookSecretForMode(mode, Boolean(webhookSecret));
    const now = nowIso();
    const repositoryIds = uniqueStrings(input.repositoryIds ?? input.repository_ids ?? []);
    const requestedScope = input.repositoryScope ?? input.repository_scope;
    let repositoryScope: MultiremiScmRepositoryScope = "selected";

    this.ctx.db.transaction(() => {
      const workspace = this.lockWorkspace(workspaceId);
      const existingAtOrigin = this.listConnections({ workspaceId, provider })
        .filter((connection) => connection.baseUrl === baseUrl);
      repositoryScope = requestedScope === undefined
        ? (existingAtOrigin.length === 0 ? "all" : "selected")
        : normalizeRepositoryScope(requestedScope);
      if (repositoryScope === "all" && existingAtOrigin.some((connection) => connection.isDefault)) {
        throw new Error("SCM default connection already exists for this provider and repository origin");
      }
      this.ctx.db.run(
        `INSERT INTO multiremi_scm_connections (
          id, workspace_id, name, provider, mode, base_url, api_base_url, enabled,
          poll_interval_seconds, repository_scope, is_default,
          access_token_encrypted, access_token_hint, webhook_secret_encrypted, webhook_secret_hint,
          verification_status, verified_repository_count, verified_repository_total,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', 0, 0, ?, ?)`,
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
          repositoryScope,
          repositoryScope === "all" ? 1 : 0,
          accessToken ? encryptScmCredential(accessToken, { workspaceId, connectionId: id, field: "access_token" }) : null,
          secretHint(accessToken),
          webhookSecret ? encryptScmCredential(webhookSecret, { workspaceId, connectionId: id, field: "webhook_secret" }) : null,
          secretHint(webhookSecret),
          now,
          now,
        ],
      );
      this.lockConnections(
        this.listConnections({ workspaceId }).map((connection) => connection.id),
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
          assignmentOrigin: "explicit",
          transfer: true,
        });
      }
      if (repositoryScope === "all") {
        this.reconcileDefaultBindingsLocked(id, workspace.repos);
      }
    })();
    return this.getConnectionWithRepositories(id)!;
  }

  updateConnection(id: string, input: UpdateScmConnectionInput): ScmConnectionWithRepositories {
    const current = this.getConnection(id);
    if (!current) throw new Error(`SCM connection not found: ${id}`);
    const replaceRepositoryIds = input.repositoryIds !== undefined || input.repository_ids !== undefined;
    const repositoryIdsInput = input.repositoryIds ?? input.repository_ids;
    if (replaceRepositoryIds && !Array.isArray(repositoryIdsInput)) {
      throw new Error("SCM repositoryIds must be an array");
    }
    const repositoryIds = uniqueStrings(repositoryIdsInput ?? []);
    const replaceAccessToken = input.accessToken !== undefined || input.access_token !== undefined;
    const clearAccessToken = Boolean(input.clearAccessToken ?? input.clear_access_token);
    const webhookSecretInput = input.webhookSecret ?? input.webhook_secret;
    const replaceWebhookSecret = typeof webhookSecretInput === "string" && Boolean(webhookSecretInput.trim());
    const clearWebhookSecret = Boolean(input.clearWebhookSecret ?? input.clear_webhook_secret);
    if (replaceAccessToken && clearAccessToken) throw new Error("accessToken and clearAccessToken cannot be used together");
    if (replaceWebhookSecret && clearWebhookSecret) throw new Error("webhookSecret and clearWebhookSecret cannot be used together");

    const accessToken = replaceAccessToken
      ? requiredSecret(input.accessToken ?? input.access_token, "access token")
      : null;
    const webhookSecret = replaceWebhookSecret
      ? requiredSecret(webhookSecretInput, "webhook secret")
      : null;
    this.ctx.db.transaction(() => {
      // Repository-list writes lock the workspace before touching bindings and
      // connections. Keep this order identical so Postgres cannot deadlock a
      // connection edit against an import/update/delete.
      const workspace = this.lockWorkspace(current.workspaceId);
      const lockedConnections = this.lockConnections(
        this.listConnections({ workspaceId: current.workspaceId }).map((connection) => connection.id),
      );
      const lockedCurrent = lockedConnections.get(id);
      if (!lockedCurrent) throw new Error(`SCM connection not found: ${id}`);
      if (lockedCurrent.workspaceId !== current.workspaceId) {
        throw new Error("SCM connection belongs to another workspace");
      }
      const nextMode = input.mode === undefined ? lockedCurrent.mode : normalizeMode(input.mode);
      assertWebhookSecretForMode(
        nextMode,
        replaceWebhookSecret || (!clearWebhookSecret && lockedCurrent.webhookSecretSet),
      );
      const baseUrl = input.baseUrl !== undefined || input.base_url !== undefined
        ? normalizeBaseUrl(input.baseUrl ?? input.base_url, lockedCurrent.provider)
        : lockedCurrent.baseUrl;
      const apiBaseUrl = input.apiBaseUrl !== undefined || input.api_base_url !== undefined
        ? normalizeApiBaseUrl(input.apiBaseUrl ?? input.api_base_url, lockedCurrent.provider, baseUrl)
        : lockedCurrent.apiBaseUrl;
      const repositoryScope = input.repositoryScope === undefined && input.repository_scope === undefined
        ? lockedCurrent.repositoryScope
        : normalizeRepositoryScope(input.repositoryScope ?? input.repository_scope);
      if (repositoryScope === "all" && replaceRepositoryIds) {
        throw new Error("SCM repositoryIds can only be replaced for selected repository scope");
      }
      const resetVerification = replaceAccessToken
        || clearAccessToken
        || baseUrl !== lockedCurrent.baseUrl
        || apiBaseUrl !== lockedCurrent.apiBaseUrl
        || repositoryScope !== lockedCurrent.repositoryScope;
      const now = nowIso();
      const desiredRepositories = repositoryIds.map((repositoryId) => {
        const repository = findWorkspaceRepository(workspace.repos, repositoryId);
        if (!repository) throw new Error(`Repository not found in workspace: ${repositoryId}`);
        if (repository.source !== "unknown" && repository.source !== lockedCurrent.provider) {
          throw new Error(`Repository source ${repository.source} does not match SCM connection provider ${lockedCurrent.provider}`);
        }
        assertScmRepositoryMatchesConnection(repository.url, baseUrl);
        return repository;
      });
      const desiredRepositoryIds = new Set(repositoryIds);
      for (const binding of this.listRepositoryBindings({ connectionId: id })) {
        if (replaceRepositoryIds && !desiredRepositoryIds.has(binding.repositoryId)) continue;
        assertScmRepositoryMatchesConnection(binding.repositoryUrl, baseUrl);
      }

      if (repositoryScope === "all") {
        const previousDefault = this.listConnections({ workspaceId: lockedCurrent.workspaceId, provider: lockedCurrent.provider })
          .find((connection) => connection.id !== id && connection.baseUrl === baseUrl && connection.isDefault);
        if (previousDefault) this.demoteAndTransferDefaultBindingsLocked(previousDefault.id, id, now);
      } else if (lockedCurrent.isDefault) {
        this.ctx.db.run(
          `UPDATE multiremi_scm_repository_bindings
           SET assignment_origin = 'explicit', updated_at = ?
           WHERE connection_id = ? AND assignment_origin = 'default'`,
          [now, id],
        );
      }

      this.ctx.db.run(
        `UPDATE multiremi_scm_connections SET
          name = ?, mode = ?, base_url = ?, api_base_url = ?, enabled = ?, poll_interval_seconds = ?,
          repository_scope = ?, is_default = ?,
          access_token_encrypted = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE access_token_encrypted END,
          access_token_hint = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE access_token_hint END,
          webhook_secret_encrypted = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE webhook_secret_encrypted END,
          webhook_secret_hint = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE webhook_secret_hint END,
          verification_status = CASE WHEN ? = 1 THEN 'unverified' ELSE verification_status END,
          verified_at = CASE WHEN ? = 1 THEN NULL ELSE verified_at END,
          verification_identity = CASE WHEN ? = 1 THEN NULL ELSE verification_identity END,
          verified_repository_count = CASE WHEN ? = 1 THEN 0 ELSE verified_repository_count END,
          verified_repository_total = CASE WHEN ? = 1 THEN 0 ELSE verified_repository_total END,
          verification_error_code = CASE WHEN ? = 1 THEN NULL ELSE verification_error_code END,
          verification_error = CASE WHEN ? = 1 THEN NULL ELSE verification_error END,
          verification_generation = verification_generation + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
          verification_run_id = CASE WHEN ? = 1 THEN NULL ELSE verification_run_id END,
          updated_at = ?
         WHERE id = ?`,
        [
          input.name === undefined ? lockedCurrent.name : requiredString(input.name, "SCM connection name"),
          nextMode,
          baseUrl,
          apiBaseUrl,
          input.enabled === undefined ? (lockedCurrent.enabled ? 1 : 0) : (input.enabled ? 1 : 0),
          input.pollIntervalSeconds === undefined && input.poll_interval_seconds === undefined
            ? lockedCurrent.pollIntervalSeconds
            : normalizePollInterval(input.pollIntervalSeconds ?? input.poll_interval_seconds),
          repositoryScope,
          repositoryScope === "all" ? 1 : 0,
          replaceAccessToken ? 1 : 0,
          accessToken ? encryptScmCredential(accessToken, { workspaceId: lockedCurrent.workspaceId, connectionId: id, field: "access_token" }) : null,
          clearAccessToken ? 1 : 0,
          replaceAccessToken ? 1 : 0,
          secretHint(accessToken),
          clearAccessToken ? 1 : 0,
          replaceWebhookSecret ? 1 : 0,
          webhookSecret ? encryptScmCredential(webhookSecret, { workspaceId: lockedCurrent.workspaceId, connectionId: id, field: "webhook_secret" }) : null,
          clearWebhookSecret ? 1 : 0,
          replaceWebhookSecret ? 1 : 0,
          secretHint(webhookSecret),
          clearWebhookSecret ? 1 : 0,
          ...Array.from({ length: 9 }, () => resetVerification ? 1 : 0),
          now,
          id,
        ],
      );
      if (repositoryScope === "all") {
        this.reconcileDefaultBindingsLocked(id, workspace.repos);
      } else if (replaceRepositoryIds) {
        for (const repository of desiredRepositories) {
          this.upsertRepositoryBindingLocked({
            workspaceId: lockedCurrent.workspaceId,
            connectionId: id,
            repositoryId: repository.id,
            repositoryUrl: repository.url,
            repositorySource: repository.source,
            name: repository.name,
            defaultBranch: repository.defaultBranch,
            assignmentOrigin: "explicit",
            transfer: true,
          });
        }
        for (const binding of this.listRepositoryBindings({ connectionId: id })) {
          if (desiredRepositoryIds.has(binding.repositoryId)) continue;
          this.deleteRepositorySyncStateLocked(id, binding.repositoryId);
          this.ctx.db.run(
            "DELETE FROM multiremi_scm_repository_bindings WHERE connection_id = ? AND repository_id = ?",
            [id, binding.repositoryId],
          );
        }
      }
    })();
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
      this.ctx.db.run(
        `DELETE FROM multiremi_scm_issue_links WHERE change_request_id IN (
          SELECT id FROM multiremi_scm_change_requests WHERE connection_id = ?
        )`,
        [id],
      );
      this.ctx.db.run("DELETE FROM multiremi_scm_change_requests WHERE connection_id = ?", [id]);
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
      `SELECT * FROM multiremi_scm_repository_bindings ${where} ORDER BY created_at ASC, repository_id ASC, id ASC`,
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
    return this.ctx.db.transaction(() => {
      const workspace = this.lockWorkspace(input.workspaceId);
      const repository = findWorkspaceRepository(workspace.repos, input.repositoryId);
      if (!repository) throw new Error(`Repository not found in workspace: ${input.repositoryId}`);
      const connection = this.getConnection(input.connectionId);
      if (!connection) throw new Error(`SCM connection not found: ${input.connectionId}`);
      if (connection.workspaceId !== input.workspaceId) {
        throw new Error("SCM connection belongs to another workspace");
      }
      this.lockConnections(
        this.listConnections({ workspaceId: input.workspaceId }).map((connection) => connection.id),
      );
      return this.upsertRepositoryBindingLocked({
        ...input,
        repositoryUrl: repository.url,
        repositorySource: repository.source,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
      });
    })();
  }

  private upsertRepositoryBindingLocked(input: UpsertScmRepositoryBindingInput): MultiremiScmRepositoryBinding {
    const connection = this.lockConnection(input.connectionId);
    if (connection.workspaceId !== input.workspaceId) throw new Error("SCM connection belongs to another workspace");
    const repositorySource = normalizeRepositorySource(input.repositorySource ?? input.repository_source);
    if (repositorySource !== "unknown" && repositorySource !== connection.provider) {
      throw new Error(`Repository source ${repositorySource} does not match SCM connection provider ${connection.provider}`);
    }
    const repositoryId = requiredString(input.repositoryId, "repository ID");
    const repositoryUrl = requiredString(input.repositoryUrl, "repository URL");
    assertScmRepositoryMatchesConnection(repositoryUrl, connection.baseUrl);
    const assignmentOrigin = normalizeAssignmentOrigin(input.assignmentOrigin ?? input.assignment_origin);
    const existingRow = this.ctx.db.query(
      `UPDATE multiremi_scm_repository_bindings SET updated_at = updated_at
       WHERE workspace_id = ? AND repository_id = ? RETURNING *`,
    ).get(input.workspaceId, repositoryId) as Row | null;
    const existing = existingRow ? toRepositoryBinding(existingRow) : null;
    if (existing && existing.connectionId !== input.connectionId) {
      if (assignmentOrigin === "default") return existing;
      if (input.transfer !== true) {
        throw new Error("Repository is already bound to another SCM connection; set transfer=true to move it atomically");
      }
      this.transferRepositorySyncStateLocked(existing.connectionId, input.connectionId, repositoryId);
    }
    const coordinates = repositoryCoordinatesFromUrl(repositoryUrl);
    const externalId = cleanOptionalString(input.externalId);
    const owner = cleanOptionalString(input.owner) ?? coordinates.owner;
    const name = requiredString(input.name, "repository name");
    const defaultBranch = cleanOptionalString(input.defaultBranch);
    const enabled = input.enabled !== false;
    const verificationChanged = !existing
      || existing.connectionId !== input.connectionId
      || existing.repositoryUrl !== repositoryUrl
      || existing.externalId !== externalId
      || existing.owner !== owner
      || existing.name !== name
      || existing.enabled !== enabled;
    const bindingId = existing?.id ?? createId("srb");
    const now = nowIso();
    const effectiveOrigin = assignmentOrigin === "explicit" || existing?.assignmentOrigin === "explicit"
      ? "explicit"
      : "default";
    this.ctx.db.run(
      `INSERT INTO multiremi_scm_repository_bindings (
        id, workspace_id, connection_id, repository_id, repository_url, external_id,
        owner, name, default_branch, enabled, assignment_origin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, repository_id) DO UPDATE SET
        connection_id = excluded.connection_id,
        repository_url = excluded.repository_url,
        external_id = excluded.external_id,
        owner = excluded.owner,
        name = excluded.name,
        default_branch = excluded.default_branch,
        enabled = excluded.enabled,
        assignment_origin = excluded.assignment_origin,
        updated_at = excluded.updated_at`,
      [
        bindingId,
        input.workspaceId,
        input.connectionId,
        repositoryId,
        repositoryUrl,
        externalId,
        owner,
        name,
        defaultBranch,
        enabled ? 1 : 0,
        effectiveOrigin,
        existing?.createdAt ?? now,
        now,
      ],
    );
    if (verificationChanged) this.invalidateConnectionVerificationLocked(input.connectionId);
    return this.getRepositoryBinding(input.connectionId, repositoryId)!;
  }

  reconcileRepositoryBindings(workspaceId: string): MultiremiScmRepositoryBinding[] {
    return this.ctx.db.transaction(() => {
      const workspace = this.lockWorkspace(workspaceId);
      return this.reconcileRepositoryBindingsWithinTransaction(workspaceId, workspace.repos);
    })();
  }

  /** Caller already owns the transaction that wrote the workspace repository list. */
  reconcileRepositoryBindingsWithinTransaction(
    workspaceId: string,
    repositories: unknown[],
  ): MultiremiScmRepositoryBinding[] {
    const connections = new Map(
      this.listConnections({ workspaceId })
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((connection) => {
          const locked = this.lockConnection(connection.id);
          return [locked.id, locked] as const;
        }),
    );
    for (const binding of this.listRepositoryBindings({ workspaceId })) {
      const repository = findWorkspaceRepository(repositories, binding.repositoryId);
      if (!repository) {
        this.deleteRepositorySyncStateLocked(binding.connectionId, binding.repositoryId);
        this.ctx.db.run(
          "DELETE FROM multiremi_scm_repository_bindings WHERE connection_id = ? AND repository_id = ?",
          [binding.connectionId, binding.repositoryId],
        );
        continue;
      }
      const connection = connections.get(binding.connectionId);
      if (!connection) throw new Error(`SCM connection not found: ${binding.connectionId}`);
      if (repository.source !== "unknown" && repository.source !== connection.provider) {
        throw new Error(`Repository source ${repository.source} does not match SCM connection provider ${connection.provider}`);
      }
      assertScmRepositoryMatchesConnection(repository.url, connection.baseUrl);
      this.ctx.db.run(
        `UPDATE multiremi_scm_repository_bindings
         SET repository_url = ?, name = ?, default_branch = ?, updated_at = ?
         WHERE connection_id = ? AND repository_id = ?`,
        [repository.url, repository.name, repository.defaultBranch, nowIso(), binding.connectionId, binding.repositoryId],
      );
      if (binding.repositoryUrl !== repository.url || binding.name !== repository.name) {
        this.invalidateConnectionVerificationLocked(binding.connectionId);
      }
    }
    for (const connection of connections.values()) {
      if (connection.isDefault && connection.repositoryScope === "all") {
        this.reconcileDefaultBindingsLocked(connection.id, repositories);
      }
    }
    return this.listRepositoryBindings({ workspaceId });
  }

  deleteRepositoryBindingsForWorkspaceRepository(workspaceId: string, repositoryId: string): number {
    return this.ctx.db.transaction(() => {
      this.lockWorkspace(workspaceId);
      this.lockConnections(
        this.listConnections({ workspaceId }).map((connection) => connection.id),
      );
      const bindings = this.listRepositoryBindings({ workspaceId })
        .filter((binding) => binding.repositoryId === repositoryId);
      for (const binding of bindings) {
        this.deleteRepositorySyncStateLocked(binding.connectionId, repositoryId);
      }
      return this.ctx.db.run(
        "DELETE FROM multiremi_scm_repository_bindings WHERE workspace_id = ? AND repository_id = ?",
        [workspaceId, repositoryId],
      ).changes;
    })();
  }

  markConnectionVerificationStarted(id: string): { connection: MultiremiScmConnection; runId: string } {
    const runId = createId("scv");
    const row = this.ctx.db.query(
      `UPDATE multiremi_scm_connections
       SET verification_status = 'verifying', verified_at = NULL, verification_identity = NULL,
           verified_repository_count = 0, verified_repository_total = 0,
           verification_error_code = NULL, verification_error = NULL,
           verification_generation = verification_generation + 1,
           verification_run_id = ?, updated_at = ?
       WHERE id = ? RETURNING *`,
    ).get(runId, nowIso(), id) as Row | null;
    if (!row) throw new Error(`SCM connection not found: ${id}`);
    return { connection: toScmConnection(row), runId };
  }

  recordConnectionVerification(
    id: string,
    result: MultiremiScmVerificationResult,
    runId: string,
  ): MultiremiScmConnection {
    const repositoryTotal = normalizeVerificationCount(result.repositoryTotal, "verification repository total");
    const repositoryCount = normalizeVerificationCount(result.repositoryCount, "verified repository count");
    if (repositoryCount > repositoryTotal) throw new Error("verified repository count cannot exceed repository total");
    const status = normalizeVerificationStatus(result.status);
    if (status === "unverified" || status === "verifying") {
      throw new Error("completed SCM verification must have a terminal status");
    }
    const args: unknown[] = [
      status,
      normalizeIsoTimestamp(result.verifiedAt, "SCM verification time"),
      cleanOptionalString(result.identity),
      repositoryCount,
      repositoryTotal,
      cleanOptionalString(result.errorCode),
      cleanVerificationError(result.error),
      nowIso(),
      id,
      requiredString(runId, "SCM verification run ID"),
    ];
    const row = this.ctx.db.query(
      `UPDATE multiremi_scm_connections SET
        verification_status = ?, verified_at = ?, verification_identity = ?,
        verified_repository_count = ?, verified_repository_total = ?,
        verification_error_code = ?, verification_error = ?,
        verification_run_id = NULL, updated_at = ?
       WHERE id = ? AND verification_run_id = ? RETURNING *`,
    ).get(...args) as Row | null;
    if (!row) {
      if (!this.getConnection(id)) throw new Error(`SCM connection not found: ${id}`);
      throw new Error("SCM connection changed while credentials were being verified; retry verification");
    }
    return toScmConnection(row);
  }

  deleteRepositoryBinding(connectionId: string, repositoryId: string): boolean {
    const current = this.getConnection(connectionId);
    if (!current) return false;
    return this.ctx.db.transaction(() => {
      this.lockWorkspace(current.workspaceId);
      const connections = this.lockConnections(
        this.listConnections({ workspaceId: current.workspaceId }).map((connection) => connection.id),
      );
      if (!connections.has(connectionId)) return false;
      const binding = this.ctx.db.query(
        `UPDATE multiremi_scm_repository_bindings SET updated_at = updated_at
         WHERE connection_id = ? AND repository_id = ? RETURNING id`,
      ).get(connectionId, repositoryId) as Row | null;
      if (!binding) return false;
      this.deleteRepositorySyncStateLocked(connectionId, repositoryId);
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
    const written = this.ctx.db.transaction(() => this.advanceEntitySnapshotLocked(input))();
    this.emitSnapshotProjection(written);
    return written.advance;
  }

  advanceEntitySnapshotWithEvents(
    input: UpsertScmEntitySnapshotInput,
    createEvents: ScmSnapshotEventFactory,
  ): ScmSnapshotEventWriteResult {
    const written = this.ctx.db.transaction(() => {
      const snapshot = this.advanceEntitySnapshotLocked(input);
      const events = createEvents(snapshot.advance).map((event) => this.recordCanonicalEventLocked(event));
      return { snapshot, events };
    })();
    this.emitSnapshotProjection(written.snapshot);
    for (const result of written.events) this.processPendingMergeEffects(result.event);
    return { advance: written.snapshot.advance, events: written.events };
  }

  private advanceEntitySnapshotLocked(input: UpsertScmEntitySnapshotInput): LockedSnapshotAdvanceResult {
    const now = nowIso();
    const observedAt = normalizeIsoTimestamp(input.observedAt ?? now, "snapshot observation time");
    const revisionAt = normalizeIsoTimestamp(input.revisionAt ?? observedAt, "snapshot revision time");
    const contentHash = requiredString(input.contentHash, "snapshot content hash");
    const revision = requiredString(input.revision ?? cleanOptionalString(input.version) ?? contentHash, "snapshot revision");
    let projected: { changeRequestId: string; issueIds: string[] } | null = null;
    const { connection, binding } = this.lockConnectionAndBinding(input.connectionId, input.repositoryId);
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
    if (inserted) {
      if (input.entityType === "change_request") {
        projected = this.upsertChangeRequestProjectionLocked(connection, binding, input.externalId, input.payload, now);
      }
      return {
        advance: { applied: true, previous: null, snapshot: toEntitySnapshot(inserted) },
        projection: projected,
        workspaceId: connection.workspaceId,
      };
    }

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
      return {
        advance: { applied: false, previous, snapshot: previous },
        projection: null,
        workspaceId: connection.workspaceId,
      };
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
    if (input.entityType === "change_request") {
      projected = this.upsertChangeRequestProjectionLocked(connection, binding, input.externalId, input.payload, now);
    }
    return {
      advance: { applied: true, previous, snapshot: toEntitySnapshot(updated) },
      projection: projected,
      workspaceId: connection.workspaceId,
    };
  }

  private emitSnapshotProjection(result: LockedSnapshotAdvanceResult): void {
    if (result.projection) this.emitChangeRequestUpdated(result.workspaceId, result.projection);
  }

  getChangeRequest(id: string): MultiremiScmChangeRequest | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_scm_change_requests WHERE id = ?").get(id) as Row | null;
    return row ? toChangeRequest(row) : null;
  }

  listChangeRequestsForIssue(issueId: string): MultiremiScmChangeRequest[] | null {
    const issue = this.ctx.issues().getIssue(issueId);
    if (!issue) return null;
    return (this.ctx.db.query(
      `SELECT cr.* FROM multiremi_scm_change_requests cr
       JOIN multiremi_scm_issue_links l ON l.change_request_id = cr.id
       WHERE l.issue_id = ? AND l.active = 1 AND cr.workspace_id = ?
       ORDER BY COALESCE(cr.provider_updated_at, cr.updated_at) DESC, cr.id ASC`,
    ).all(issueId, issue.workspaceId) as Row[]).map(toChangeRequest);
  }

  linkChangeRequestToIssue(issueId: string, changeRequestId: string): {
    changeRequest: MultiremiScmChangeRequest;
    link: MultiremiScmIssueLink;
  } {
    const result = this.ctx.db.transaction(() => {
      const issue = this.ctx.issues().getIssue(issueId);
      if (!issue) throw new Error(`Issue not found: ${issueId}`);
      const changeRequest = this.getChangeRequest(changeRequestId);
      if (!changeRequest) throw new Error(`SCM change request not found: ${changeRequestId}`);
      if (changeRequest.workspaceId !== issue.workspaceId) throw new Error("SCM change request belongs to another workspace");
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_scm_issue_links (
          id, workspace_id, change_request_id, issue_id, source, active,
          linked_at, unlinked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'manual', 1, ?, NULL, ?, ?)
        ON CONFLICT(change_request_id, issue_id) DO UPDATE SET
          source = 'manual', active = 1, linked_at = excluded.linked_at,
          unlinked_at = NULL, updated_at = excluded.updated_at`,
        [createId("sil"), issue.workspaceId, changeRequestId, issueId, now, now, now],
      );
      const linkRow = this.ctx.db.query(
        "SELECT * FROM multiremi_scm_issue_links WHERE change_request_id = ? AND issue_id = ?",
      ).get(changeRequestId, issueId) as Row;
      return { changeRequest, link: toIssueLink(linkRow) };
    })();
    this.emitChangeRequestUpdated(result.changeRequest.workspaceId, {
      changeRequestId: result.changeRequest.id,
      issueIds: this.activeIssueIds(result.changeRequest.id),
    });
    return result;
  }

  unlinkChangeRequestFromIssue(issueId: string, changeRequestId: string): boolean {
    const changeRequest = this.getChangeRequest(changeRequestId);
    if (!changeRequest) return false;
    const issue = this.ctx.issues().getIssue(issueId);
    if (!issue || issue.workspaceId !== changeRequest.workspaceId) return false;
    const changed = this.ctx.db.transaction(() => this.ctx.db.run(
      `UPDATE multiremi_scm_issue_links SET
         source = 'manual', active = 0, unlinked_at = ?, updated_at = ?
       WHERE change_request_id = ? AND issue_id = ? AND active = 1`,
      [nowIso(), nowIso(), changeRequestId, issueId],
    ).changes > 0)();
    if (changed) {
      this.emitChangeRequestUpdated(changeRequest.workspaceId, {
        changeRequestId,
        issueIds: this.activeIssueIds(changeRequestId),
      });
    }
    return changed;
  }

  recordCanonicalEvent(input: RecordScmCanonicalEventInput): RecordScmCanonicalEventResult {
    const result = this.ctx.db.transaction(() => this.recordCanonicalEventLocked(input))();
    this.processPendingMergeEffects(result.event);
    return result;
  }

  private recordCanonicalEventLocked(input: RecordScmCanonicalEventInput): RecordScmCanonicalEventResult {
    const logicalKey = requiredString(input.logicalKey, "SCM logical event key");
    const evidenceDedupeKey = requiredString(input.evidence.dedupeKey, "SCM evidence dedupe key");
    const observedAt = input.observedAt ?? nowIso();
    const eventId = createId("sce");
    const evidenceId = createId("scv");
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
    const created = inserted.changes > 0;
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
    const evidenceCreated = evidenceInsert.changes > 0;
    if (created) {
      this.ensureEventDeliveriesInitialized(canonical, observedAt);
      this.scheduleLinkedIssueMergeEffectsLocked(canonical);
    }
    const event = this.getCanonicalEvent(canonical.id)!;
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
      this.processPendingMergeEffects(event);
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
      const pendingEffect = this.ctx.db.query(
        `SELECT last_error FROM multiremi_scm_effects
         WHERE event_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
      ).get(event.id) as Row | null;
      const hasPending = Boolean(pendingEffect)
        || deliveries.some((delivery) => delivery.status === "pending" || delivery.status === "processing");
      const hasFailed = deliveries.some((delivery) => delivery.status === "failed");
      if (hasPending) {
        this.ctx.db.run(
          `UPDATE multiremi_scm_events SET status = 'pending', available_at = ?, lease_until = NULL,
           last_error = ? WHERE id = ? AND status = 'processing'`,
          [
            new Date(now.getTime() + retryDelayMs(event.attemptCount)).toISOString(),
            pendingEffect?.last_error ?? "one or more deliveries are pending",
            event.id,
          ],
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

  private reconcileDefaultBindingsLocked(connectionId: string, repositories: unknown[]): void {
    const connection = this.lockConnection(connectionId);
    if (!connection.isDefault || connection.repositoryScope !== "all" || !Array.isArray(repositories)) return;
    for (const value of repositories) {
      if (!value || typeof value !== "object") continue;
      const repositoryId = cleanOptionalString((value as Record<string, unknown>).id);
      if (!repositoryId) continue;
      const repository = findWorkspaceRepository(repositories, repositoryId);
      if (!repository || !repositoryMatchesConnection(repository, connection)) continue;
      const existingRow = this.ctx.db.query(
        "SELECT connection_id FROM multiremi_scm_repository_bindings WHERE workspace_id = ? AND repository_id = ?",
      ).get(connection.workspaceId, repositoryId) as Row | null;
      if (existingRow) {
        if (String(existingRow.connection_id) === connectionId) {
          const current = this.getRepositoryBinding(connectionId, repositoryId);
          this.ctx.db.run(
            `UPDATE multiremi_scm_repository_bindings
             SET repository_url = ?, name = ?, default_branch = ?, updated_at = ?
             WHERE workspace_id = ? AND repository_id = ?`,
            [repository.url, repository.name, repository.defaultBranch, nowIso(), connection.workspaceId, repositoryId],
          );
          if (current && (current.repositoryUrl !== repository.url || current.name !== repository.name)) {
            this.invalidateConnectionVerificationLocked(connectionId);
          }
        }
        continue;
      }
      this.upsertRepositoryBindingLocked({
        workspaceId: connection.workspaceId,
        connectionId,
        repositoryId,
        repositoryUrl: repository.url,
        repositorySource: repository.source,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        assignmentOrigin: "default",
      });
    }
  }

  private demoteAndTransferDefaultBindingsLocked(previousId: string, nextId: string, now: string): void {
    this.lockConnection(previousId);
    const bindings = this.listRepositoryBindings({ connectionId: previousId })
      .filter((binding) => binding.assignmentOrigin === "default");
    for (const binding of bindings) {
      this.transferRepositorySyncStateLocked(previousId, nextId, binding.repositoryId);
      this.ctx.db.run(
        `UPDATE multiremi_scm_repository_bindings
         SET connection_id = ?, updated_at = ?
         WHERE connection_id = ? AND repository_id = ? AND assignment_origin = 'default'`,
        [nextId, now, previousId, binding.repositoryId],
      );
    }
    this.ctx.db.run(
      `UPDATE multiremi_scm_connections
       SET repository_scope = 'selected', is_default = 0, updated_at = ?
       WHERE id = ?`,
      [now, previousId],
    );
  }

  private deleteRepositorySyncStateLocked(connectionId: string, repositoryId: string): void {
    this.ctx.db.run(
      `DELETE FROM multiremi_scm_issue_links WHERE change_request_id IN (
        SELECT id FROM multiremi_scm_change_requests WHERE connection_id = ? AND repository_id = ?
      )`,
      [connectionId, repositoryId],
    );
    this.ctx.db.run(
      "DELETE FROM multiremi_scm_change_requests WHERE connection_id = ? AND repository_id = ?",
      [connectionId, repositoryId],
    );
    this.ctx.db.run(
      "DELETE FROM multiremi_scm_sync_cursors WHERE connection_id = ? AND repository_id = ?",
      [connectionId, repositoryId],
    );
    this.ctx.db.run(
      "DELETE FROM multiremi_scm_entity_snapshots WHERE connection_id = ? AND repository_id = ?",
      [connectionId, repositoryId],
    );
    this.invalidateConnectionVerificationLocked(connectionId);
  }

  private transferRepositorySyncStateLocked(
    previousConnectionId: string,
    nextConnectionId: string,
    repositoryId: string,
  ): void {
    this.ctx.db.run(
      "DELETE FROM multiremi_scm_sync_cursors WHERE connection_id = ? AND repository_id = ?",
      [previousConnectionId, repositoryId],
    );
    this.ctx.db.run(
      "DELETE FROM multiremi_scm_entity_snapshots WHERE connection_id = ? AND repository_id = ?",
      [previousConnectionId, repositoryId],
    );
    this.ctx.db.run(
      `UPDATE multiremi_scm_change_requests
       SET connection_id = ?, updated_at = ?
       WHERE connection_id = ? AND repository_id = ?`,
      [nextConnectionId, nowIso(), previousConnectionId, repositoryId],
    );
    this.invalidateConnectionVerificationLocked(previousConnectionId);
    this.invalidateConnectionVerificationLocked(nextConnectionId);
  }

  private invalidateConnectionVerificationLocked(connectionId: string): void {
    this.ctx.db.run(
      `UPDATE multiremi_scm_connections SET
         verification_status = 'unverified', verified_at = NULL, verification_identity = NULL,
         verified_repository_count = 0, verified_repository_total = 0,
         verification_error_code = NULL, verification_error = NULL,
         verification_generation = verification_generation + 1,
         verification_run_id = NULL, updated_at = ?
       WHERE id = ?`,
      [nowIso(), connectionId],
    );
  }

  private upsertChangeRequestProjectionLocked(
    connection: MultiremiScmConnection,
    binding: MultiremiScmRepositoryBinding,
    externalId: string,
    payload: Record<string, unknown>,
    now: string,
  ): { changeRequestId: string; issueIds: string[] } {
    const number = finiteInteger(payload.number);
    const draft = payload.draft === true;
    const state = normalizeChangeRequestState(payload.state, draft);
    const existingByNumber = number == null ? null : this.ctx.db.query(
      `SELECT id FROM multiremi_scm_change_requests
       WHERE connection_id = ? AND repository_id = ? AND number = ?
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(connection.id, binding.repositoryId, number) as Row | null;
    const projectionId = existingByNumber ? String(existingByNumber.id) : createId("scr");
    if (!existingByNumber) this.ctx.db.run(
      `INSERT INTO multiremi_scm_change_requests (
        id, workspace_id, connection_id, repository_id, provider, external_id,
        number, title, body, state, draft, url, source_branch, target_branch,
        head_sha, base_sha, author, provider_created_at, provider_updated_at,
        closed_at, merged_at, merge_sha, mergeable_state, checks_conclusion,
        checks_passed, checks_failed, checks_pending, additions, deletions,
        changed_files, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, repository_id, external_id) DO UPDATE SET
        number = excluded.number,
        title = excluded.title,
        body = excluded.body,
        state = excluded.state,
        draft = excluded.draft,
        url = excluded.url,
        source_branch = excluded.source_branch,
        target_branch = excluded.target_branch,
        head_sha = excluded.head_sha,
        base_sha = excluded.base_sha,
        author = excluded.author,
        provider_created_at = excluded.provider_created_at,
        provider_updated_at = excluded.provider_updated_at,
        closed_at = excluded.closed_at,
        merged_at = excluded.merged_at,
        merge_sha = excluded.merge_sha,
        mergeable_state = excluded.mergeable_state,
        checks_conclusion = excluded.checks_conclusion,
        checks_passed = excluded.checks_passed,
        checks_failed = excluded.checks_failed,
        checks_pending = excluded.checks_pending,
        additions = excluded.additions,
        deletions = excluded.deletions,
        changed_files = excluded.changed_files,
        updated_at = excluded.updated_at`,
      [
        projectionId, connection.workspaceId, connection.id, binding.repositoryId, connection.provider,
        requiredString(externalId, "external change request ID"), number,
        stringField(payload.title), nullableField(payload.body), state, draft ? 1 : 0,
        nullableField(payload.url), nullableField(payload.source_branch), nullableField(payload.target_branch),
        nullableField(payload.head_sha), nullableField(payload.base_sha), nullableField(payload.author),
        nullableField(payload.created_at), nullableField(payload.updated_at), nullableField(payload.closed_at),
        nullableField(payload.merged_at), nullableField(payload.merge_sha), nullableField(payload.mergeable_state),
        nullableField(payload.checks_conclusion ?? payload.check_status), nonNegativeInteger(payload.checks_passed),
        nonNegativeInteger(payload.checks_failed), nonNegativeInteger(payload.checks_pending),
        nonNegativeInteger(payload.additions), nonNegativeInteger(payload.deletions),
        nonNegativeInteger(payload.changed_files), now, now,
      ],
    );
    if (existingByNumber) {
      this.ctx.db.run(
        `UPDATE multiremi_scm_change_requests SET
          external_id = ?, title = ?, body = ?, state = ?, draft = ?, url = ?,
          source_branch = ?, target_branch = ?, head_sha = ?, base_sha = ?, author = ?,
          provider_created_at = ?, provider_updated_at = ?, closed_at = ?, merged_at = ?,
          merge_sha = ?, mergeable_state = ?, checks_conclusion = ?, checks_passed = ?,
          checks_failed = ?, checks_pending = ?, additions = ?, deletions = ?, changed_files = ?,
          updated_at = ? WHERE id = ?`,
        [
          externalId, stringField(payload.title), nullableField(payload.body), state, draft ? 1 : 0,
          nullableField(payload.url), nullableField(payload.source_branch), nullableField(payload.target_branch),
          nullableField(payload.head_sha), nullableField(payload.base_sha), nullableField(payload.author),
          nullableField(payload.created_at), nullableField(payload.updated_at), nullableField(payload.closed_at),
          nullableField(payload.merged_at), nullableField(payload.merge_sha), nullableField(payload.mergeable_state),
          nullableField(payload.checks_conclusion ?? payload.check_status), nonNegativeInteger(payload.checks_passed),
          nonNegativeInteger(payload.checks_failed), nonNegativeInteger(payload.checks_pending),
          nonNegativeInteger(payload.additions), nonNegativeInteger(payload.deletions),
          nonNegativeInteger(payload.changed_files), now, projectionId,
        ],
      );
    }
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_scm_change_requests
       WHERE connection_id = ? AND repository_id = ?
         AND (external_id = ? OR (? IS NOT NULL AND number = ?))
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(connection.id, binding.repositoryId, externalId, number, number) as Row | null;
    if (!row) throw new Error("SCM change request projection could not be read after upsert");
    const changeRequest = toChangeRequest(row);
    if (this.ctx.workspaces().getWorkspace(connection.workspaceId)?.settings.scm_auto_link_enabled !== false) {
      const haystack = [changeRequest.title, changeRequest.sourceBranch ?? "", changeRequest.body ?? ""].join("\n");
      for (const issue of this.ctx.issues().listIssues({ workspaceId: connection.workspaceId })) {
        if (!issue.key || !new RegExp(`\\b${escapeRegExp(issue.key)}\\b`, "i").test(haystack)) continue;
        this.ctx.db.run(
          `INSERT INTO multiremi_scm_issue_links (
            id, workspace_id, change_request_id, issue_id, source, active,
            linked_at, unlinked_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'auto', 1, ?, NULL, ?, ?)
          ON CONFLICT(change_request_id, issue_id) DO NOTHING`,
          [createId("sil"), connection.workspaceId, changeRequest.id, issue.id, now, now, now],
        );
      }
    }
    return { changeRequestId: changeRequest.id, issueIds: this.activeIssueIds(changeRequest.id) };
  }

  private scheduleLinkedIssueMergeEffectsLocked(event: MultiremiScmCanonicalEvent): void {
    if (event.type !== "change.merged" || event.subjectType !== "change_request") return;
    const workspace = this.ctx.workspaces().getWorkspace(event.workspaceId);
    if (workspace?.settings.scm_complete_issue_on_merge_enabled !== true) return;
    const rows = this.ctx.db.query(
      `SELECT i.id FROM multiremi_scm_change_requests cr
       JOIN multiremi_scm_issue_links l ON l.change_request_id = cr.id AND l.active = 1
       JOIN multiremi_issues i ON i.id = l.issue_id
       WHERE cr.connection_id = ? AND cr.repository_id = ? AND cr.external_id = ?
         AND i.workspace_id = ? AND i.status <> 'done'`,
    ).all(event.connectionId, event.repositoryId, event.subjectId, event.workspaceId) as Row[];
    for (const row of rows) {
      const issueId = String(row.id);
      this.ctx.db.run(
        `INSERT OR IGNORE INTO multiremi_scm_effects (
          id, event_id, issue_id, effect_type, status, applied_at, last_error, created_at
        ) VALUES (?, ?, ?, 'complete_issue_on_merge', 'pending', NULL, NULL, ?)`,
        [createId("sfx"), event.id, issueId, nowIso()],
      );
    }
  }

  private processPendingMergeEffects(event: MultiremiScmCanonicalEvent): void {
    // The pending row is committed with the canonical event. Retrying after a
    // crash is safe: updateIssue emits status automation only on a real change.
    const rows = this.ctx.db.query(
      `SELECT id, issue_id FROM multiremi_scm_effects
       WHERE event_id = ? AND effect_type = 'complete_issue_on_merge' AND status = 'pending'
       ORDER BY created_at ASC, id ASC`,
    ).all(event.id) as Row[];
    for (const row of rows) {
      const effectId = String(row.id);
      const issueId = String(row.issue_id);
      try {
        const current = this.ctx.issues().getIssue(issueId);
        const updated = current && current.status !== "done"
          ? this.ctx.issues().updateIssue(issueId, { status: "done" })
          : null;
        this.ctx.db.run(
          "UPDATE multiremi_scm_effects SET status = 'applied', applied_at = ?, last_error = NULL WHERE id = ? AND status = 'pending'",
          [nowIso(), effectId],
        );
        if (updated) {
          this.ctx.emitWorkspaceEvent({
            type: "issue:updated",
            workspaceId: updated.workspaceId,
            actorType: "system",
            actorId: null,
            payload: { issue: updated },
          });
        }
      } catch (error) {
        this.ctx.db.run(
          "UPDATE multiremi_scm_effects SET last_error = ? WHERE id = ? AND status = 'pending'",
          [(error instanceof Error ? error.message : String(error)).slice(0, 1_000), effectId],
        );
      }
    }
  }

  private activeIssueIds(changeRequestId: string): string[] {
    return (this.ctx.db.query(
      "SELECT issue_id FROM multiremi_scm_issue_links WHERE change_request_id = ? AND active = 1 ORDER BY issue_id ASC",
    ).all(changeRequestId) as Row[]).map((row) => String(row.issue_id));
  }

  private emitChangeRequestUpdated(
    workspaceId: string,
    input: { changeRequestId: string; issueIds: string[] },
  ): void {
    this.ctx.emitWorkspaceEvent({
      type: "change_request:updated",
      workspaceId,
      actorType: "system",
      actorId: null,
      payload: {
        change_request_id: input.changeRequestId,
        issue_ids: input.issueIds,
      },
    });
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

  private lockWorkspace(workspaceId: string) {
    const row = this.ctx.db.query(
      "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ? RETURNING id",
    ).get(workspaceId) as Row | null;
    if (!row) throw new Error(`Workspace not found: ${workspaceId}`);
    const workspace = this.ctx.workspaces().getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }

  private lockConnection(connectionId: string): MultiremiScmConnection {
    const row = this.ctx.db.query(
      "UPDATE multiremi_scm_connections SET updated_at = updated_at WHERE id = ? RETURNING *",
    ).get(connectionId) as Row | null;
    if (!row) throw new Error(`SCM connection not found: ${connectionId}`);
    return toScmConnection(row);
  }

  private lockConnections(connectionIds: string[]): Map<string, MultiremiScmConnection> {
    return new Map(
      [...new Set(connectionIds)]
        .sort((left, right) => left.localeCompare(right))
        .map((connectionId) => {
          const connection = this.lockConnection(connectionId);
          return [connection.id, connection] as const;
        }),
    );
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
    repositoryScope: normalizeRepositoryScope(row.repository_scope ?? "selected"),
    isDefault: Boolean(Number(row.is_default ?? 0)),
    accessTokenSet: Boolean(nullableString(row.access_token_encrypted)),
    accessTokenHint: nullableString(row.access_token_hint),
    webhookSecretSet: Boolean(nullableString(row.webhook_secret_encrypted)),
    webhookSecretHint: nullableString(row.webhook_secret_hint),
    verificationStatus: normalizeVerificationStatus(row.verification_status ?? "unverified"),
    verifiedAt: nullableString(row.verified_at),
    verificationIdentity: nullableString(row.verification_identity),
    verifiedRepositoryCount: Number(row.verified_repository_count ?? 0),
    verifiedRepositoryTotal: Number(row.verified_repository_total ?? 0),
    verificationErrorCode: nullableString(row.verification_error_code),
    verificationError: nullableString(row.verification_error),
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
    assignmentOrigin: normalizeAssignmentOrigin(row.assignment_origin ?? "explicit"),
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

function toChangeRequest(row: Row): MultiremiScmChangeRequest {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    connectionId: String(row.connection_id),
    repositoryId: String(row.repository_id),
    provider: normalizeProvider(row.provider),
    externalId: String(row.external_id),
    number: row.number == null ? null : Number(row.number),
    title: String(row.title ?? ""),
    body: nullableString(row.body),
    state: normalizeChangeRequestState(row.state, Boolean(Number(row.draft ?? 0))),
    draft: Boolean(Number(row.draft ?? 0)),
    url: nullableString(row.url),
    sourceBranch: nullableString(row.source_branch),
    targetBranch: nullableString(row.target_branch),
    headSha: nullableString(row.head_sha),
    baseSha: nullableString(row.base_sha),
    author: nullableString(row.author),
    providerCreatedAt: nullableString(row.provider_created_at),
    providerUpdatedAt: nullableString(row.provider_updated_at),
    closedAt: nullableString(row.closed_at),
    mergedAt: nullableString(row.merged_at),
    mergeSha: nullableString(row.merge_sha),
    mergeableState: nullableString(row.mergeable_state),
    checksConclusion: nullableString(row.checks_conclusion),
    checksPassed: nonNegativeInteger(row.checks_passed),
    checksFailed: nonNegativeInteger(row.checks_failed),
    checksPending: nonNegativeInteger(row.checks_pending),
    additions: nonNegativeInteger(row.additions),
    deletions: nonNegativeInteger(row.deletions),
    changedFiles: nonNegativeInteger(row.changed_files),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toIssueLink(row: Row): MultiremiScmIssueLink {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    changeRequestId: String(row.change_request_id),
    issueId: String(row.issue_id),
    source: row.source === "manual" || row.source === "legacy" ? row.source : "auto",
    active: Boolean(Number(row.active ?? 1)),
    linkedAt: String(row.linked_at),
    unlinkedAt: nullableString(row.unlinked_at),
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

function normalizeRepositoryScope(value: unknown): MultiremiScmRepositoryScope {
  if (value === "all" || value === "selected") return value;
  throw new Error("SCM repository scope must be all or selected");
}

function normalizeAssignmentOrigin(value: unknown): MultiremiScmRepositoryAssignmentOrigin {
  if (value == null || value === "explicit") return "explicit";
  if (value === "default") return "default";
  throw new Error("SCM repository assignment origin must be default or explicit");
}

function normalizeVerificationStatus(value: unknown): MultiremiScmConnection["verificationStatus"] {
  if (
    value === "unverified"
    || value === "verifying"
    || value === "valid"
    || value === "partial"
    || value === "invalid"
    || value === "rate_limited"
    || value === "unreachable"
  ) return value;
  throw new Error("Invalid SCM verification status");
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

function normalizeVerificationCount(value: unknown, label: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) throw new Error(`${label} must be a non-negative integer`);
  return count;
}

function normalizeBaseUrl(value: unknown, provider: MultiremiScmProvider): string {
  const normalized = normalizeHttpUrl(
    value,
    provider === "github" ? "https://github.com" : "https://code.byted.org",
    "base URL",
  );
  return new URL(normalized).origin;
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

function stringField(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nullableField(value: unknown): string | null {
  return cleanOptionalString(value);
}

function finiteInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function nonNegativeInteger(value: unknown): number {
  return Math.max(0, finiteInteger(value) ?? 0);
}

function normalizeChangeRequestState(value: unknown, draft: boolean): MultiremiScmChangeRequest["state"] {
  if (value === "merged" || value === "closed") return value;
  if (draft || value === "draft") return "draft";
  return "open";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function optionalSecret(value: unknown, label: string): string | null {
  if (value == null) return null;
  return requiredSecret(value, label);
}

function optionalWebhookSecret(value: unknown): string | null {
  if (typeof value === "string" && !value.trim()) return null;
  return optionalSecret(value, "webhook secret");
}

function assertWebhookSecretForMode(mode: MultiremiScmSyncMode, webhookSecretSet: boolean): void {
  if ((mode === "webhook" || mode === "hybrid") && !webhookSecretSet) {
    throw new Error("SCM webhook secret is required when sync mode is webhook or hybrid");
  }
}

function requiredSecret(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`SCM ${label} cannot be empty`);
  return value.trim();
}

function secretHint(value: string | null): string | null {
  return value ? value.slice(-4) : null;
}

function cleanVerificationError(value: unknown): string | null {
  const error = cleanOptionalString(value);
  return error ? error.slice(0, 500) : null;
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

function repositoryMatchesConnection(
  repository: ReturnType<typeof findWorkspaceRepository> & {},
  connection: MultiremiScmConnection,
): boolean {
  if (repository.source !== "unknown" && repository.source !== connection.provider) return false;
  try {
    assertScmRepositoryMatchesConnection(repository.url, connection.baseUrl);
    return true;
  } catch {
    return false;
  }
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
