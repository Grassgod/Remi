import { createId, nowIso } from "@multiremi/ids.js";
import { createLogger } from "@shared/logger.js";
import { abortable, deadlineClient } from "./deadline.js";
import type {
  CreateRepositoryWikiDocInput,
  MultiremiRepositoryWikiDoc,
  MultiremiRepositoryWikiDocRevision,
  MultiremiTaskWithAgent,
  RepositoryWikiBatchOperation,
  RepositoryWikiBatchResult,
  UpdateRepositoryWikiDocInput,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import {
  normalizeRepositoryWikiPath,
  type RepositoryWikiStorageJob,
  type RepositoryWikiStorageJobInput,
  type RepositoryWikiStoreBatchOperation,
} from "@multiremi/store/repos/repository-wiki-repo.js";
import { OpenVikingClient } from "@multiremi/project-knowledge/openviking-client.js";
import type { OpenVikingClientContract, ProjectKnowledgeMode } from "@multiremi/project-knowledge/types.js";
import {
  decodeRepositoryWikiBody,
  encodeRepositoryWikiDocument,
  canonicalRepositoryWikiBody,
  repositoryWikiDocUri,
  repositoryWikiRetrievalTags,
  repositoryWikiRootUri,
  repositoryWikiStorageRootUri,
  sha256Text,
} from "./codec.js";
import {
  canonicalRepositoryRemote,
  resolveTaskRepositoryWikiRepositories,
} from "./task-scope.js";
import {
  assertNoIntroducedRepositoryWikiLinks,
  repositoryWikiBacklinks,
  rewriteRepositoryWikiLinks,
  type RepositoryWikiGraphDoc,
} from "./links.js";

export interface RepositoryWikiMigrationOptions {
  expectedVersion?: number;
  updatedByType?: MultiremiRepositoryWikiDoc["updatedByType"];
  updatedById?: string | null;
}

export interface RepositoryWikiRestoreTarget {
  ref: string;
  expected_version: number;
  snapshot_oid: string;
  content_sha256: string;
}

export interface RepositoryWikiRestoreResult {
  id: string;
  path: string;
  version: number;
  content_uri: string;
  snapshot_oid: string;
  content_sha256: string;
  body_bytes: number;
  state: "missing" | "present" | "restored";
}

export interface RepositoryWikiRestoreReport {
  dry_run: boolean;
  results: RepositoryWikiRestoreResult[];
  recovery_snapshot_oid: string | null;
  repository_readable: boolean;
  unreadable: Array<{ id: string; path: string }>;
}

export interface RepositoryWikiLogRepairInput {
  body: string;
  expectedVersion: number;
  expectedBodySha256: string;
  reason: string;
  updatedByType?: MultiremiRepositoryWikiDoc["updatedByType"];
  updatedById?: string | null;
  sourceRevision?: string | null;
}

export interface RepositoryWikiLogRepairReport {
  doc: MultiremiRepositoryWikiDoc;
  audit: {
    reason: string;
    before: { version: number; body_sha256: string; content_sha256: string | null };
    after: { version: number; body_sha256: string; content_sha256: string | null };
  };
}

export class RepositoryWikiRestoreConflictError extends Error {}
export class RepositoryWikiRestoreInputError extends Error {}
export class RepositoryWikiLogRepairConflictError extends Error {}
export class RepositoryWikiLogRepairInputError extends Error {}
export class RepositoryWikiLogHistoryError extends Error {}

export interface RepositoryWikiServiceContract {
  readonly mode: ProjectKnowledgeMode;
  list(workspaceId: string, repositoryId: string): Promise<MultiremiRepositoryWikiDoc[]>;
  listStrict(workspaceId: string, repositoryId: string): Promise<MultiremiRepositoryWikiDoc[]>;
  listWorkspace(workspaceId: string): Promise<MultiremiRepositoryWikiDoc[]>;
  get(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDoc | null>;
  create(workspaceId: string, repositoryId: string, input: CreateRepositoryWikiDocInput): Promise<MultiremiRepositoryWikiDoc>;
  update(workspaceId: string, repositoryId: string, ref: string, input: UpdateRepositoryWikiDocInput): Promise<MultiremiRepositoryWikiDoc>;
  delete(workspaceId: string, repositoryId: string, ref: string, expectedVersion?: number | null): Promise<MultiremiRepositoryWikiDoc>;
  applyBatch(workspaceId: string, repositoryId: string, operations: readonly RepositoryWikiBatchOperation[]): Promise<RepositoryWikiBatchResult[]>;
  move(workspaceId: string, repositoryId: string, ref: string, path: string, options?: RepositoryWikiMigrationOptions): Promise<RepositoryWikiBatchResult[]>;
  merge(workspaceId: string, repositoryId: string, targetRef: string, sourceRefs: readonly string[], options?: RepositoryWikiMigrationOptions): Promise<RepositoryWikiBatchResult[]>;
  restore(workspaceId: string, repositoryId: string, targets: readonly RepositoryWikiRestoreTarget[], options: {
    dryRun: boolean; auditId: string; onProgress?: (results: RepositoryWikiRestoreResult[]) => void;
  }): Promise<RepositoryWikiRestoreReport>;
  repairLog(workspaceId: string, repositoryId: string, input: RepositoryWikiLogRepairInput): Promise<RepositoryWikiLogRepairReport>;
  revisions(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDocRevision[]>;
  search(workspaceId: string, repositoryId: string, query: string, limit?: number): Promise<MultiremiRepositoryWikiDoc[]>;
  backlinks(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDoc[]>;
  hydrateTaskWiki(task: MultiremiTaskWithAgent, signal?: AbortSignal): Promise<MultiremiTaskWithAgent>;
  startStorageWorker?(): void;
  stopStorageWorker?(): void;
}

export class RepositoryWikiUnavailableError extends Error {}
export const REPOSITORY_WIKI_BATCH_LIMIT = 256;
const STORAGE_WRITE_CONCURRENCY = 4;
const PROMOTION_CHECKPOINT_SIZE = 8;

/** Unknown outgoing links cannot be checked when an existing target moves or disappears. */
export function assertRepositoryWikiPathChangesReadable(
  before: readonly RepositoryWikiGraphDoc[],
  after: readonly RepositoryWikiGraphDoc[],
): void {
  const nextPaths = new Map(after.map(doc => [doc.id, doc.path]));
  if (!before.some(doc => nextPaths.get(doc.id) !== doc.path)) return;
  const unavailable = before.filter(doc => doc.bodyUnavailable);
  if (unavailable.length) {
    throw new RepositoryWikiUnavailableError(
      `Repository wiki path changes and deletes require all bodies to be readable; unavailable: ${unavailable.map(doc => `${doc.path} (${doc.id})`).join(", ")}`,
    );
  }
}

/** Preserve the root publication log across every ordinary write path. */
function assertRepositoryWikiLogHistory(
  before: readonly RepositoryWikiGraphDoc[],
  after: readonly RepositoryWikiGraphDoc[],
  internal: RepositoryWikiBatchInternalOptions = {},
): void {
  const current = before.find(doc => doc.path === REPOSITORY_WIKI_LOG_PATH);
  if (!current) return;
  const next = after.find(doc => doc.id === current.id);
  if (!next || next.path !== REPOSITORY_WIKI_LOG_PATH) {
    throw new RepositoryWikiLogHistoryError("Repository wiki log.md is append-only and cannot be moved or deleted");
  }
  const previousBody = canonicalRepositoryWikiBody(current.body);
  const nextBody = canonicalRepositoryWikiBody(next.body);
  if (previousBody === nextBody) return;
  if (internal.logRepairDocId === current.id) return;
  const rewritten = internal.logLinkRewriteBodies?.get(current.id);
  if (rewritten !== undefined && canonicalRepositoryWikiBody(rewritten) === nextBody) return;
  if (!previousBody || nextBody.startsWith(`${previousBody}\n`)) return;
  throw new RepositoryWikiLogHistoryError(
    "Repository wiki log.md is append-only; use the audited repair-log operation for historical repair",
  );
}

const log = createLogger("repository-wiki");
const REPOSITORY_WIKI_LOG_PATH = "log.md";

interface RepositoryWikiBatchInternalOptions {
  /** Exact bodies generated by the service's own move/merge link rewriter. */
  logLinkRewriteBodies?: ReadonlyMap<string, string>;
  /** One repair authorized only after locked version + baseline hash checks. */
  logRepairDocId?: string;
}

export class RepositoryWikiService implements RepositoryWikiServiceContract {
  private readonly writeQueues = new Map<string, Promise<void>>();
  private storageTimer: ReturnType<typeof setTimeout> | null = null;
  private storageAbort: AbortController | null = null;
  private storageRun: Promise<void> | null = null;
  private readonly cleanupConcurrency: number;
  private readonly writeTimeoutMs: number;
  private readonly storageJobTimeoutMs: number;
  private readonly operationSignal?: AbortSignal;

  constructor(
    private readonly store: MultiremiStore,
    private readonly client: OpenVikingClientContract | null,
    readonly mode: ProjectKnowledgeMode,
    options: { cleanupConcurrency?: number; writeTimeoutMs?: number; storageJobTimeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    const concurrency = options.cleanupConcurrency ?? Number(process.env.MULTIREMI_WIKI_CLEANUP_CONCURRENCY ?? 8);
    this.cleanupConcurrency = Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 32 ? concurrency : 8;
    this.writeTimeoutMs = Math.max(1, options.writeTimeoutMs ?? positiveInt(process.env.MULTIREMI_WIKI_WRITE_TIMEOUT_MS, 120_000));
    this.storageJobTimeoutMs = Math.max(1, options.storageJobTimeoutMs ?? 60_000);
    this.operationSignal = options.signal;
  }

  startStorageWorker(): void {
    if (this.mode === "sql" || this.storageAbort) return;
    const abort = new AbortController();
    this.storageAbort = abort;
    const tick = async () => {
      try { await this.runStorageJobs(abort.signal); }
      catch (error) { if (!abort.signal.aborted) log.warn(`Wiki storage worker failed: ${safeError(error)}`); }
      if (!abort.signal.aborted) {
        this.storageTimer = setTimeout(tick, 5_000);
        this.storageTimer.unref?.();
      }
    };
    void tick();
  }

  stopStorageWorker(): void {
    this.storageAbort?.abort();
    this.storageAbort = null;
    if (this.storageTimer) clearTimeout(this.storageTimer);
    this.storageTimer = null;
  }

  runStorageJobs(signal?: AbortSignal, now = Date.now()): Promise<void> {
    if (this.storageRun) return this.storageRun;
    const run = (async () => {
      if (this.mode === "sql") return;
      for (const workspace of this.store.listWorkspaces()) {
        for (const job of this.store.listWorkspaceRepositoryWikiStorageJobs(workspace.id)) {
          if (signal?.aborted) return;
          const backoff = job.lastError ? Math.min(300_000, 5_000 * 2 ** Math.min(job.attemptCount, 6)) : 0;
          if (now - Date.parse(job.updatedAt) < backoff) continue;
          await this.withWriteLock(job.workspaceId, job.repositoryId, service => service.processStorageJobUnlocked(job, true, signal));
        }
      }
    })();
    this.storageRun = run.finally(() => { this.storageRun = null; });
    return this.storageRun;
  }

  async list(workspaceId: string, repositoryId: string): Promise<MultiremiRepositoryWikiDoc[]> {
    const docs = this.store.listRepositoryWikiDocs(workspaceId, repositoryId);
    if (this.mode === "sql") return docs;
    return Promise.all(docs.map((doc) => this.hydrateTolerant(doc)));
  }

  private async hydrateTolerant(doc: MultiremiRepositoryWikiDoc): Promise<MultiremiRepositoryWikiDoc & { bodyUnavailable?: boolean }> {
    try {
      return await this.hydrate(doc);
    } catch (error) {
      this.operationSignal?.throwIfAborted();
      const message = repositoryWikiHydrationError(doc, error);
      log.warn(message);
      return {
        ...doc,
        body: "",
        bodyUnavailable: true,
        status: "failed",
        statusMessage: message,
        syncStatus: "failed",
        syncError: message,
      };
    }
  }

  async listStrict(workspaceId: string, repositoryId: string): Promise<MultiremiRepositoryWikiDoc[]> {
    const docs = this.store.listRepositoryWikiDocs(workspaceId, repositoryId);
    return this.hydrateStrict(docs);
  }

  async listWorkspace(workspaceId: string): Promise<MultiremiRepositoryWikiDoc[]> {
    // Summaries must never join the storage repair/write lock. Return committed
    // control-plane metadata; target-specific reads/writes still retry repairs.
    return this.store.listWorkspaceRepositoryWikiDocs(workspaceId);
  }

  async get(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDoc | null> {
    const doc = this.store.getRepositoryWikiDocByRef(workspaceId, repositoryId, ref);
    if (!doc) return null;
    return this.mode === "sql" ? doc : this.hydrate(doc);
  }

  async create(workspaceId: string, repositoryId: string, input: CreateRepositoryWikiDocInput): Promise<MultiremiRepositoryWikiDoc> {
    return this.withWriteLock(workspaceId, repositoryId, async service => {
      const result = await service.applyBatchUnlocked(workspaceId, repositoryId, [{ kind: "create", input }]);
      return result[0]!.doc;
    });
  }

  async update(
    workspaceId: string,
    repositoryId: string,
    ref: string,
    input: UpdateRepositoryWikiDocInput,
  ): Promise<MultiremiRepositoryWikiDoc> {
    return this.withWriteLock(workspaceId, repositoryId, async service => {
      const current = await service.requireDocUnlocked(workspaceId, repositoryId, ref);
      const expectedVersion = input.expectedVersion ?? input.expected_version ?? current.version;
      const result = await service.applyBatchUnlocked(workspaceId, repositoryId, [{
        kind: "update",
        ref: current.id,
        input: { ...input, expectedVersion, expected_version: expectedVersion },
      }]);
      return result[0]!.doc;
    });
  }

  async delete(workspaceId: string, repositoryId: string, ref: string, expectedVersion?: number | null): Promise<MultiremiRepositoryWikiDoc> {
    return this.withWriteLock(workspaceId, repositoryId, async service => {
      const current = await service.requireDocUnlocked(workspaceId, repositoryId, ref);
      const version = expectedVersion ?? current.version;
      const result = await service.applyBatchUnlocked(workspaceId, repositoryId, [{
        kind: "delete",
        ref: current.id,
        expectedVersion: version,
        expected_version: version,
      }]);
      return result[0]!.doc;
    });
  }

  async applyBatch(
    workspaceId: string,
    repositoryId: string,
    operations: readonly RepositoryWikiBatchOperation[],
  ): Promise<RepositoryWikiBatchResult[]> {
    return this.withWriteLock(workspaceId, repositoryId, service =>
      service.applyBatchUnlocked(workspaceId, repositoryId, operations));
  }

  async restore(workspaceId: string, repositoryId: string, targets: readonly RepositoryWikiRestoreTarget[], options: {
    dryRun: boolean; auditId: string; onProgress?: (results: RepositoryWikiRestoreResult[]) => void;
  }): Promise<RepositoryWikiRestoreReport> {
    return this.withWriteLock(workspaceId, repositoryId, async service => {
      if (service.mode === "sql") throw new Error("Repository wiki restore requires OpenViking storage");
      if (!Array.isArray(targets) || !targets.length || targets.length > 32) {
        throw new RepositoryWikiRestoreInputError("Repository wiki restore requires 1 to 32 targets");
      }
      // Do not race a pending promotion/cleanup or implicitly repair anything
      // outside the operator's explicit target list.
      if (service.store.listRepositoryWikiStorageJobs(workspaceId, repositoryId).length) {
        throw new RepositoryWikiUnavailableError("Repository wiki storage repair is still pending");
      }
      const client = service.requireClient();
      const root = repositoryWikiRootUri(workspaceId, repositoryId);
      const ids = new Set<string>();
      const plan: Array<{ doc: MultiremiRepositoryWikiDoc; raw: string; result: RepositoryWikiRestoreResult }> = [];
      // Preflight the ENTIRE batch, including existing objects, before any write.
      for (const target of targets) {
        if (!target || typeof target.ref !== "string" || !target.ref.trim()
          || !Number.isSafeInteger(target.expected_version) || target.expected_version < 1
          || typeof target.snapshot_oid !== "string" || !target.snapshot_oid.trim()
          || typeof target.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(target.content_sha256)) {
          throw new RepositoryWikiRestoreInputError("Restore targets require ref, positive expected_version, snapshot_oid and SHA-256 content_sha256");
        }
        const doc = service.store.getRepositoryWikiDocByRef(workspaceId, repositoryId, target.ref);
        if (!doc) throw new Error(`repository wiki doc not found: ${target.ref}`);
        if (ids.has(doc.id)) throw new RepositoryWikiRestoreInputError(`Duplicate restore target: ${doc.id}`);
        ids.add(doc.id);
        if (doc.version !== target.expected_version || doc.snapshotOid !== target.snapshot_oid
          || doc.contentSha256 !== target.content_sha256) {
          throw new RepositoryWikiRestoreConflictError(`Restore metadata conflict for ${doc.path} (${doc.id})`);
        }
        const uri = repositoryWikiDocUri(workspaceId, repositoryId, doc.path);
        if (doc.storageBackend !== "openviking" || doc.syncStatus !== "ready" || doc.contentUri !== uri) {
          throw new RepositoryWikiRestoreConflictError(`Restore requires a ready canonical OpenViking record: ${doc.id}`);
        }
        const raw = await client.show(target.snapshot_oid, uri);
        if (sha256Text(raw) !== target.content_sha256) {
          throw new RepositoryWikiRestoreConflictError(`Snapshot checksum mismatch for ${doc.path} (${doc.id})`);
        }
        const body = decodeRepositoryWikiBody(raw, doc);
        const present = await client.exists(uri);
        if (present && sha256Text(await client.read(uri)) !== target.content_sha256) {
          throw new RepositoryWikiRestoreConflictError(`Existing object checksum mismatch; refusing to overwrite ${doc.path} (${doc.id})`);
        }
        plan.push({ doc, raw, result: {
          id: doc.id, path: doc.path, version: doc.version, content_uri: uri,
          snapshot_oid: target.snapshot_oid, content_sha256: target.content_sha256,
          body_bytes: Buffer.byteLength(body, "utf8"), state: present ? "present" : "missing",
        } });
      }
      let recoverySnapshot: string | null = null;
      if (!options.dryRun) {
        for (const entry of plan) {
          service.operationSignal?.throwIfAborted();
          // Recheck metadata after remote reads, before writing the pinned URI.
          const current = service.store.getRepositoryWikiDocByRef(workspaceId, repositoryId, entry.doc.id);
          if (!current || current.version !== entry.doc.version || current.contentUri !== entry.doc.contentUri
            || current.contentSha256 !== entry.doc.contentSha256 || current.snapshotOid !== entry.doc.snapshotOid) {
            throw new RepositoryWikiRestoreConflictError(`Restore metadata changed for ${entry.doc.id}`);
          }
          if (entry.result.state === "missing") {
            await service.ensureUriDirectories(root, entry.result.content_uri);
            try {
              await client.create(entry.result.content_uri, root, entry.raw);
              entry.result.state = "restored";
            } catch (error) {
              service.operationSignal?.throwIfAborted();
              // A concurrent create or an ambiguous response can be successful.
              // Read back; never fall back to replace or remove.
              if (!await client.exists(entry.result.content_uri)) throw error;
              if (sha256Text(await client.read(entry.result.content_uri)) !== entry.result.content_sha256) {
                throw new RepositoryWikiRestoreConflictError(`Concurrent object checksum mismatch for ${entry.doc.id}`);
              }
              entry.result.state = "present";
            }
          }
          if (sha256Text(await client.read(entry.result.content_uri)) !== entry.result.content_sha256) {
            throw new RepositoryWikiRestoreConflictError(`Restored object checksum mismatch for ${entry.doc.id}`);
          }
          // Retrying after tag/commit failure completes these ancillary steps.
          await client.setTags(entry.result.content_uri, repositoryWikiRetrievalTags(entry.doc));
          options.onProgress?.(plan.map(item => ({ ...item.result })));
        }
        recoverySnapshot = await client.commit(`repository wiki restore ${options.auditId}`, plan.map(entry => entry.result.content_uri));
        if (!recoverySnapshot) throw new RepositoryWikiUnavailableError("Restore snapshot commit returned no oid");
      }
      // Preserve all document/revision metadata, including original provenance.
      let unreadable: Array<{ id: string; path: string }> = [];
      try {
        await service.listStrict(workspaceId, repositoryId);
      } catch {
        service.operationSignal?.throwIfAborted();
        const docs = await service.list(workspaceId, repositoryId);
        unreadable = docs.filter(doc => doc.syncStatus === "failed").map(({ id, path }) => ({ id, path }));
        // A transient failure in the strict pass must not be advertised as a
        // successful strict verification even if a subsequent read recovers.
        if (!unreadable.length) throw new RepositoryWikiUnavailableError("Repository strict verification failed; retry verification");
      }
      return { dry_run: options.dryRun, results: plan.map(entry => entry.result),
        recovery_snapshot_oid: recoverySnapshot, repository_readable: unreadable.length === 0, unreadable };
    });
  }

  async repairLog(
    workspaceId: string,
    repositoryId: string,
    input: RepositoryWikiLogRepairInput,
  ): Promise<RepositoryWikiLogRepairReport> {
    return this.withWriteLock(workspaceId, repositoryId, async service => {
      const reason = String(input.reason ?? "").trim();
      if (!reason || reason.length > 4_000) {
        throw new RepositoryWikiLogRepairInputError("Log repair reason must be non-empty and at most 4000 characters");
      }
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new RepositoryWikiLogRepairInputError("Log repair requires a positive expected_version");
      }
      if (!/^[a-f0-9]{64}$/.test(input.expectedBodySha256)) {
        throw new RepositoryWikiLogRepairInputError("Log repair requires a lowercase SHA-256 expected_body_sha256");
      }
      const current = await service.requireDocUnlocked(workspaceId, repositoryId, REPOSITORY_WIKI_LOG_PATH);
      const beforeBodySha256 = sha256Text(canonicalRepositoryWikiBody(current.body));
      if (current.version !== input.expectedVersion || beforeBodySha256 !== input.expectedBodySha256) {
        throw new RepositoryWikiLogRepairConflictError("Repository wiki log repair baseline conflict");
      }
      const [result] = await service.applyBatchUnlocked(workspaceId, repositoryId, [{
        kind: "update",
        ref: current.id,
        input: {
          body: input.body,
          expectedVersion: input.expectedVersion,
          sourceRevision: input.sourceRevision,
          updatedByType: input.updatedByType,
          updatedById: input.updatedById,
        },
      }], { logRepairDocId: current.id });
      if (!result || result.kind === "delete") throw new Error("Repository wiki log repair produced no document");
      return {
        doc: result.doc,
        audit: {
          reason,
          before: { version: current.version, body_sha256: beforeBodySha256, content_sha256: current.contentSha256 },
          after: {
            version: result.doc.version,
            body_sha256: sha256Text(canonicalRepositoryWikiBody(result.doc.body)),
            content_sha256: result.doc.contentSha256,
          },
        },
      };
    });
  }

  async revisions(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDocRevision[]> {
    const current = await this.requireDoc(workspaceId, repositoryId, ref);
    const rows = this.store.listRepositoryWikiDocRevisions(current.id);
    if (this.mode === "sql") return rows;
    return Promise.all(rows.map(async (revision) => {
      if (!revision.snapshotOid || !revision.contentUri) return revision;
      const content = await this.requireClient().show(revision.snapshotOid, revision.contentUri);
      return { ...revision, body: decodeRepositoryWikiBody(content, { ...current, path: revision.path }) };
    }));
  }

  async move(workspaceId: string, repositoryId: string, ref: string, path: string, options: RepositoryWikiMigrationOptions = {}): Promise<RepositoryWikiBatchResult[]> {
    return this.withWriteLock(workspaceId, repositoryId, async service => {
      // Migration promises complete reference rewriting, so unknown outgoing
      // links are a blocker here (unlike ordinary edits on readable documents).
      const before = await service.listStrict(workspaceId, repositoryId);
      const target = resolveBatchDocument(ref, before);
      if (!target) throw new Error(`repository wiki doc not found: ${ref}`);
      assertMigrationVersion(target, options.expectedVersion);
      const nextPath = normalizeRepositoryWikiPath(path);
      if (target.path === REPOSITORY_WIKI_LOG_PATH || nextPath === REPOSITORY_WIKI_LOG_PATH) {
        throw new Error("Repository wiki log.md cannot be moved");
      }
      const after = before.map(doc => doc.id === target.id ? { ...doc, path: nextPath } : doc);
      assertUniqueRepositoryWikiPaths(after);
      const operations: RepositoryWikiBatchOperation[] = [];
      const logLinkRewriteBodies = new Map<string, string>();
      for (const doc of before) {
        const next = after.find(candidate => candidate.id === doc.id)!;
        const body = rewriteRepositoryWikiLinks(doc.body, doc.path, next.path, before, after);
        if (next.path === doc.path && body === doc.body) continue;
        if (doc.path === REPOSITORY_WIKI_LOG_PATH) logLinkRewriteBodies.set(doc.id, body);
        operations.push({ kind: "update", ref: doc.id, input: {
          path: next.path, body, expectedVersion: doc.version,
          updatedByType: options.updatedByType, updatedById: options.updatedById,
        } });
      }
      return operations.length
        ? service.applyBatchUnlocked(workspaceId, repositoryId, operations, { logLinkRewriteBodies })
        : [];
    });
  }

  async merge(workspaceId: string, repositoryId: string, targetRef: string, sourceRefs: readonly string[], options: RepositoryWikiMigrationOptions = {}): Promise<RepositoryWikiBatchResult[]> {
    return this.withWriteLock(workspaceId, repositoryId, async service => {
      if (!sourceRefs.length) throw new Error("repository wiki merge sources are required");
      const before = await service.listStrict(workspaceId, repositoryId);
      const target = resolveBatchDocument(targetRef, before);
      if (!target) throw new Error(`repository wiki doc not found: ${targetRef}`);
      assertMigrationVersion(target, options.expectedVersion);
      const sources = sourceRefs.map(ref => {
        const source = resolveBatchDocument(ref, before);
        if (!source) throw new Error(`repository wiki doc not found: ${ref}`);
        return source;
      });
      if ([target, ...sources].some(doc => doc.path === REPOSITORY_WIKI_LOG_PATH)) {
        throw new Error("Repository wiki log.md cannot be a merge source or target");
      }
      const sourceIds = new Set(sources.map(source => source.id));
      if (sourceIds.has(target.id) || sourceIds.size !== sources.length) throw new Error("repository wiki merge requires distinct source and target documents");
      const mergedIds = new Map(sources.map(source => [source.id, target.id]));
      const after = before.filter(doc => !sourceIds.has(doc.id));
      const operations: RepositoryWikiBatchOperation[] = sources.map(source => ({
        kind: "delete", ref: source.id, expectedVersion: source.version,
      }));
      const logLinkRewriteBodies = new Map<string, string>();
      for (const doc of after) {
        let body = rewriteRepositoryWikiLinks(doc.body, doc.path, doc.path, before, after, mergedIds);
        if (doc.id === target.id) {
          for (const source of sources) {
            const content = rewriteRepositoryWikiLinks(source.body, source.path, target.path, before, after, mergedIds);
            body += `\n\n## ${source.title}\n\n${content}`;
          }
        }
        if (body === doc.body && doc.id !== target.id) continue;
        if (doc.path === REPOSITORY_WIKI_LOG_PATH) logLinkRewriteBodies.set(doc.id, body);
        operations.push({ kind: "update", ref: doc.id, input: {
          body, expectedVersion: doc.version,
          ...(doc.id === target.id ? {
            tags: [...new Set([doc, ...sources].flatMap(entry => entry.tags))],
            refs: [...new Map([doc, ...sources].flatMap(entry => entry.refs).map(ref => [JSON.stringify(ref), ref])).values()],
          } : {}),
          updatedByType: options.updatedByType, updatedById: options.updatedById,
        } });
      }
      return service.applyBatchUnlocked(workspaceId, repositoryId, operations, { logLinkRewriteBodies });
    });
  }

  async search(workspaceId: string, repositoryId: string, query: string, limit = 20): Promise<MultiremiRepositoryWikiDoc[]> {
    const term = query.trim();
    if (!term) return [];
    if (this.mode !== "openviking") {
      const normalized = term.toLowerCase();
      return (await this.list(workspaceId, repositoryId)).filter((doc) =>
        [doc.title, doc.summary ?? "", doc.body, doc.path, ...doc.tags].some((value) => value.toLowerCase().includes(normalized))
      ).slice(0, clampLimit(limit));
    }
    const hits = await this.requireClient().find(term, repositoryWikiRootUri(workspaceId, repositoryId), clampLimit(limit) * 3, [
      `workspace_id=${encodeURIComponent(workspaceId)}`,
      `repository_id=${encodeURIComponent(repositoryId)}`,
    ]);
    const byUri = new Map(this.store.listRepositoryWikiDocs(workspaceId, repositoryId).map((doc) => [doc.contentUri, doc]));
    const docs: MultiremiRepositoryWikiDoc[] = [];
    for (const hit of hits) {
      const doc = byUri.get(hit.uri);
      if (doc) docs.push(await this.hydrate(doc));
      if (docs.length >= clampLimit(limit)) break;
    }
    return docs;
  }

  async backlinks(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDoc[]> {
    const target = this.store.getRepositoryWikiDocByRef(workspaceId, repositoryId, ref);
    if (!target) throw new Error("repository wiki doc not found");
    const documents = await this.list(workspaceId, repositoryId);
    return repositoryWikiBacklinks(target, documents);
  }

  async hydrateTaskWiki(task: MultiremiTaskWithAgent, signal?: AbortSignal): Promise<MultiremiTaskWithAgent> {
    if (signal && this.client?.withSignal) {
      return new RepositoryWikiService(this.store, this.client.withSignal(signal), this.mode).hydrateTaskWiki(task);
    }
    const selected = resolveTaskRepositoryWikiRepositories(this.store, task);
    if (!selected.length) return task;
    const contexts = await Promise.all(selected.map(async (repository) => ({
      repository,
      docs: await this.list(task.workspaceId, repository.id),
    })));
    const repos = [...task.repos];
    const knownRemotes = new Set(repos.map((repo) => canonicalRepositoryRemote(repo.url)));
    for (const repository of selected) {
      if (!knownRemotes.has(canonicalRepositoryRemote(repository.url))) repos.push({ url: repository.url });
    }
    return { ...task, repos, repositoryWikiContexts: contexts };
  }

  private async applyBatchUnlocked(
    workspaceId: string,
    repositoryId: string,
    operations: readonly RepositoryWikiBatchOperation[],
    internal: RepositoryWikiBatchInternalOptions = {},
  ): Promise<RepositoryWikiBatchResult[]> {
    if (!operations.length) throw new Error("repository wiki batch operations are required");
    if (operations.length > REPOSITORY_WIKI_BATCH_LIMIT) throw new Error(`repository wiki batch supports at most ${REPOSITORY_WIKI_BATCH_LIMIT} operations`);

    await this.repairDeferredCanonicalUnlocked(workspaceId, repositoryId);
    if (this.store.listRepositoryWikiStorageJobs(workspaceId, repositoryId).length) {
      throw new RepositoryWikiUnavailableError("Repository wiki storage repair is still pending");
    }
    const metadata = this.store.listRepositoryWikiDocs(workspaceId, repositoryId);
    const requiredIds = new Set(operations.flatMap((operation) => {
      if (operation.kind === "create") return [];
      const current = resolveBatchDocument(operation.ref, metadata);
      if (!current) throw new Error(`repository wiki doc not found: ${operation.ref}`);
      return [current.id];
    }));
    // Missing unrelated objects must not block content edits or creates.
    // Keep their identities in the graph, but never treat an unreadable body as
    // a successfully read empty page. Every mutated document remains strict.
    const before = this.mode === "sql" ? metadata : await Promise.all(metadata.map((doc) =>
      requiredIds.has(doc.id) ? this.hydrate(doc) : this.hydrateTolerant(doc)));
    const afterById = new Map(before.map((doc) => [doc.id, doc]));
    const touched = new Set<string>();
    const storeOperations: RepositoryWikiStoreBatchOperation[] = [];

    for (const operation of operations) {
      if (operation.kind === "create") {
        const prepared = prepareNew(workspaceId, repositoryId, operation.input);
        if (afterById.has(prepared.id) || touched.has(prepared.id)) {
          throw new Error(`repository wiki document already exists: ${prepared.id}`);
        }
        touched.add(prepared.id);
        afterById.set(prepared.id, prepared);
        storeOperations.push({
          kind: "create",
          workspaceId,
          repositoryId,
          input: { ...operation.input, id: prepared.id, path: prepared.path },
        });
        continue;
      }

      const current = resolveBatchDocument(operation.ref, before);
      if (!current) throw new Error(`repository wiki doc not found: ${operation.ref}`);
      if (touched.has(current.id)) throw new Error(`repository wiki batch touches document more than once: ${current.id}`);
      touched.add(current.id);
      const expectedVersion = operation.kind === "update"
        ? operation.input.expectedVersion ?? operation.input.expected_version
        : operation.expectedVersion ?? operation.expected_version;
      if (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) {
        throw new Error(`expected_version is required for repository wiki ${operation.kind}`);
      }
      if (current.version !== Number(expectedVersion)) throw new Error("repository wiki version conflict");

      if (operation.kind === "delete") {
        afterById.delete(current.id);
        storeOperations.push({ kind: "delete", current, expectedVersion: Number(expectedVersion) });
        continue;
      }

      const input: UpdateRepositoryWikiDocInput = {
        ...operation.input,
        expectedVersion: Number(expectedVersion),
        expected_version: Number(expectedVersion),
      };
      const prepared = prepareUpdate(current, input);
      afterById.set(current.id, prepared);
      storeOperations.push({ kind: "update", current, input });
    }

    const after = [...afterById.values()];
    // Check the normalized graph, not the presence of a path/slug input:
    // explicitly keeping the same path remains a tolerant content update.
    assertRepositoryWikiPathChangesReadable(before, after);
    assertUniqueRepositoryWikiPaths(after);
    assertNoIntroducedRepositoryWikiLinks(before, after);
    assertRepositoryWikiLogHistory(before, after, internal);
    this.operationSignal?.throwIfAborted();
    if (this.mode === "sql") return this.store.applyRepositoryWikiBatch(storeOperations);
    return this.applyOpenVikingBatch(workspaceId, repositoryId, storeOperations, afterById);
  }

  private async applyOpenVikingBatch(
    workspaceId: string,
    repositoryId: string,
    operations: readonly RepositoryWikiStoreBatchOperation[],
    afterById: ReadonlyMap<string, MultiremiRepositoryWikiDoc>,
  ): Promise<RepositoryWikiBatchResult[]> {
    const client = this.requireClient();
    const storageRootUri = repositoryWikiStorageRootUri(workspaceId, repositoryId);
    const batchId = createId("rwbatch");
    const staged = operations.flatMap((operation) => {
      if (operation.kind === "delete") return [];
      const id = operation.kind === "create" ? String(operation.input.id) : operation.current.id;
      const doc = afterById.get(id)!;
      const uri = repositoryWikiBatchContentUri(storageRootUri, batchId, doc);
      const content = encodeRepositoryWikiDocument(doc);
      return [{ id, doc, uri, content }];
    });
    const stagedUris = staged.map((entry) => entry.uri);
    const promotions = staged.map((entry) => ({
      docId: entry.id,
      version: entry.doc.version,
      stagedUri: entry.uri,
      finalUri: repositoryWikiDocUri(workspaceId, repositoryId, entry.doc.path),
      contentSha256: sha256Text(entry.content),
    }));
    const finalUriSet = new Set(promotions.map((entry) => entry.finalUri));
    const obsoleteUris = operations.flatMap((operation) => {
      if (operation.kind === "create") return [];
      return [operation.current.contentUri
        ?? repositoryWikiDocUri(workspaceId, repositoryId, operation.current.path)];
    }).filter((uri) => !finalUriSet.has(uri));
    const storageJob: RepositoryWikiStorageJobInput = {
      id: createId("rwjob"),
      workspaceId,
      repositoryId,
      batchId,
      manifest: {
        promotions,
        cleanupUris: [...new Set([...stagedUris, ...obsoleteUris])],
      },
    };

    let snapshotOid: string | null = null;
    let stored: RepositoryWikiBatchResult[];
    try {
      await forEachStorageEntry(staged, async (entry) => {
        await this.ensureUriDirectories(storageRootUri, entry.uri);
        await client.create(entry.uri, storageRootUri, entry.content);
        await client.setTags(entry.uri, repositoryWikiRetrievalTags(entry.doc));
      });
      if (staged.length) {
        snapshotOid = requireSnapshot(await client.commit(`repository_wiki_batch:${batchId}`, stagedUris));
      }

      const stagedById = new Map(staged.map((entry) => [entry.id, entry]));
      const controlled = operations.map((operation): RepositoryWikiStoreBatchOperation => {
        if (operation.kind === "delete") return operation;
        const id = operation.kind === "create" ? String(operation.input.id) : operation.current.id;
        const entry = stagedById.get(id)!;
        const control = {
          contentUri: entry.uri,
          contentSha256: sha256Text(entry.content),
          snapshotOid,
        };
        return operation.kind === "create"
          ? { ...operation, control }
          : { ...operation, control };
      });
      this.operationSignal?.throwIfAborted();
      stored = this.store.applyRepositoryWikiBatch(controlled, storageJob).map((result) => ({
        ...result,
        doc: result.kind === "delete"
          ? result.doc
          : { ...result.doc, body: afterById.get(result.doc.id)!.body },
      }));

    } catch (error) {
      await this.cleanupUris(client, stagedUris, `repository_wiki_batch:${batchId}:rollback`);
      throw error;
    }

    await this.processStorageJobUnlocked({
      ...storageJob,
      state: "pending",
      attemptCount: 0,
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const refreshed = new Map(this.store.listRepositoryWikiDocs(workspaceId, repositoryId)
      .map((doc) => [doc.id, doc]));
    stored = stored.map((result) => result.kind === "delete" ? result : {
      ...result,
      doc: { ...refreshed.get(result.doc.id)!, body: afterById.get(result.doc.id)!.body },
    });
    return stored;
  }

  private async restoreCanonicalUris(
    client: OpenVikingClientContract,
    rootUri: string,
    previous: ReadonlyMap<string, string | null>,
    batchId: string,
  ): Promise<void> {
    const restored: string[] = [];
    for (const [uri, content] of previous) {
      try {
        const exists = await client.exists(uri);
        if (content === null) {
          if (exists) await client.remove(uri);
        } else if (exists) {
          const current = await client.read(uri);
          if (current !== content) await client.replace(uri, rootUri, content, sha256Text(current));
        } else {
          await client.create(uri, rootUri, content);
        }
        restored.push(uri);
      } catch (error) {
        log.warn(`OpenViking canonical rollback deferred for ${uri}: ${safeError(error)}`);
      }
    }
    if (restored.length) {
      await client.commit(`repository_wiki_batch:${batchId}:promote_rollback`, restored).catch((error) => {
        log.warn(`OpenViking canonical rollback snapshot failed: ${safeError(error)}`);
      });
    }
  }

  private async repairDeferredCanonicalUnlocked(workspaceId: string, repositoryId: string): Promise<void> {
    if (this.mode === "sql") return;
    for (const job of this.store.listRepositoryWikiStorageJobs(workspaceId, repositoryId)) {
      if (!await this.processStorageJobUnlocked(job, true)) break;
    }
  }

  private async processStorageJobUnlocked(job: RepositoryWikiStorageJob, cleanup = false, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const token = createId("rwlease");
    const until = () => new Date(Date.now() + 120_000).toISOString();
    if (!this.store.claimRepositoryWikiStorageJob(job.id, token, until(), nowIso())) return false;
    // Reload after claiming: another worker may have checkpointed or promoted it.
    const currentJob = this.store.listRepositoryWikiStorageJobs(job.workspaceId, job.repositoryId).find(j => j.id === job.id);
    if (!currentJob) return false;
    job = currentJob;
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(new RepositoryWikiUnavailableError("Repository wiki storage job deadline exceeded")), this.storageJobTimeoutMs);
    const scopedSignal = AbortSignal.any([abort.signal, ...[signal, this.operationSignal].filter((value): value is AbortSignal => Boolean(value))]);
    const assertLease = () => {
      scopedSignal.throwIfAborted();
      if (!this.store.renewRepositoryWikiStorageJob(job.id, token, until())) {
        abort.abort();
        throw new Error("Repository Wiki storage lease lost");
      }
    };
    const renewal = setInterval(() => { try { assertLease(); } catch { abort.abort(); } }, 20_000);
    const baseClient = this.requireClient();
    const client = deadlineClient(baseClient, scopedSignal);
    const rootUri = repositoryWikiRootUri(job.workspaceId, job.repositoryId);
    const storageRootUri = repositoryWikiStorageRootUri(job.workspaceId, job.repositoryId);
    const previousCanonical = new Map<string, string | null>();
    let phase = job.state;
    try {
      if (phase === "pending") {
        // The manifest contains only unfinished promotions. Each checkpoint
        // atomically advances doc/revision pointers and removes its entries.
        const entries = job.manifest.promotions.map((promotion) => {
          if (!isRepositoryWikiStagingUri(storageRootUri, promotion.stagedUri)) {
            throw new RepositoryWikiUnavailableError(`Invalid Repository Wiki staging URI for ${promotion.docId}`);
          }
          const doc = this.store.getRepositoryWikiDocByRef(job.workspaceId, job.repositoryId, promotion.docId);
          if (!doc || doc.version !== promotion.version) throw new Error("repository wiki version conflict");
          const expectedFinalUri = repositoryWikiDocUri(job.workspaceId, job.repositoryId, doc.path);
          if (promotion.finalUri !== expectedFinalUri) {
            throw new RepositoryWikiUnavailableError(`Invalid Repository Wiki final URI for ${promotion.docId}`);
          }
          return { doc, ...promotion };
        });

        for (let offset = 0; offset < entries.length; offset += PROMOTION_CHECKPOINT_SIZE) {
          const chunk = entries.slice(offset, offset + PROMOTION_CHECKPOINT_SIZE);
          await forEachStorageEntry(chunk, async (entry) => {
            assertLease();
            const content = await client.read(entry.stagedUri);
            if (sha256Text(content) !== entry.contentSha256) {
              throw new RepositoryWikiUnavailableError(`Repository wiki checksum mismatch for ${entry.docId}`);
            }
            await this.ensureUriDirectories(rootUri, entry.finalUri, client);
            const exists = await client.exists(entry.finalUri);
            const previous = exists ? await client.read(entry.finalUri) : null;
            previousCanonical.set(entry.finalUri, previous);
            if (previous === null) {
              await client.create(entry.finalUri, rootUri, content);
            } else if (previous !== content) {
              await client.replace(entry.finalUri, rootUri, content, sha256Text(previous));
            }
            await client.setTags(entry.finalUri, repositoryWikiRetrievalTags(entry.doc));
          });

          const snapshotOid = requireSnapshot(await client.commit(
            `repository_wiki_batch:${job.batchId}:promote`, chunk.map(entry => entry.finalUri),
          ));
          assertLease();
          this.store.finalizeRepositoryWikiBatchStorage(chunk.map((entry) => ({
            docId: entry.docId,
            version: entry.version,
            control: { contentUri: entry.finalUri, contentSha256: entry.contentSha256, snapshotOid },
          })), job.id);
          // Never roll back a durable checkpoint when a later chunk fails.
          previousCanonical.clear();
        }
        if (!entries.length) {
          assertLease();
          this.store.finalizeRepositoryWikiBatchStorage([], job.id);
        }
        phase = "cleanup";
      }
      if (!cleanup) return true;
      await this.cleanupJob(client, job, token, assertLease);
      assertLease();
      this.store.completeRepositoryWikiStorageJob(job.id);
      log.info(`OpenViking storage job completed for ${job.workspaceId}/${job.repositoryId} (${job.id})`);
      return true;
    } catch (error) {
      if (phase === "pending" && !scopedSignal.aborted) {
        await this.restoreCanonicalUris(client, rootUri, previousCanonical, job.batchId);
      }
      const message = safeError(error);
      this.store.recordRepositoryWikiStorageJobFailure(job.id, message);
      log.warn(`OpenViking storage job deferred for ${job.workspaceId}/${job.repositoryId}: ${message}`);
      return false;
    } finally {
      clearTimeout(deadline);
      clearInterval(renewal);
      this.store.releaseRepositoryWikiStorageJob(job.id, token);
    }
  }

  private async cleanupJob(
    client: OpenVikingClientContract,
    job: RepositoryWikiStorageJob,
    token: string,
    assertLease: () => void,
  ): Promise<void> {
    const uniqueUris = [...new Set(job.manifest.cleanupUris)];
    const completed = new Set(job.manifest.completedCleanupUris ?? []);
    const remaining = uniqueUris.filter(uri => !completed.has(uri));
    const roots = [repositoryWikiRootUri(job.workspaceId, job.repositoryId),
      `${repositoryWikiStorageRootUri(job.workspaceId, job.repositoryId)}/batches/${job.batchId}`];
    const liveUris = new Set(this.store.listRepositoryWikiDocs(job.workspaceId, job.repositoryId).map(d => d.contentUri));
    for (const uri of remaining) {
      if (!roots.some(root => uri.startsWith(`${root}/`)) || !uri.endsWith(".md")
        || uri.split("/").some(part => part === ".." || part === "." || part.includes("%") || part.includes("\\"))
        || liveUris.has(uri)) throw new RepositoryWikiUnavailableError(`Unsafe Wiki cleanup target: ${uri}`);
    }
    const failures: string[] = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(this.cleanupConcurrency, remaining.length) }, async () => {
      while (cursor < remaining.length) {
        const uri = remaining[cursor++]!;
        try {
          assertLease();
          if (await client.exists(uri)) await client.remove(uri, { wait: false });
          assertLease();
          this.store.recordRepositoryWikiCleanupProgress(job.id, token, uri);
        } catch (error) {
          failures.push(`${uri}: ${safeError(error)}`);
        }
      }
    }));
    if (failures.length) throw new RepositoryWikiUnavailableError(failures.join("; "));
    assertLease();
    if (uniqueUris.length) await client.commit(`repository_wiki_batch:${job.batchId}:cleanup`, uniqueUris);
  }

  private async cleanupUris(
    client: OpenVikingClientContract,
    uris: readonly string[],
    commitMessage: string,
  ): Promise<void> {
    const removed: string[] = [];
    for (const uri of [...new Set(uris)]) {
      try {
        if (!await client.exists(uri)) continue;
        await client.remove(uri);
        removed.push(uri);
      } catch (error) {
        log.warn(`OpenViking cleanup deferred for ${uri}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (removed.length) {
      await client.commit(commitMessage, removed).catch((error) => {
        log.warn(`OpenViking cleanup snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private async withWriteLock<T>(
    workspaceId: string,
    repositoryId: string,
    operation: (service: RepositoryWikiService) => Promise<T>,
  ): Promise<T> {
    const key = `${workspaceId}\u0000${repositoryId}`;
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.writeQueues.set(key, tail);
    // A queued caller can time out before the preceding writer exits. Keep
    // that predecessor in the lane until the entire tail has actually settled.
    void tail.then(() => { if (this.writeQueues.get(key) === tail) this.writeQueues.delete(key); });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new RepositoryWikiUnavailableError("Repository wiki write deadline exceeded")), this.writeTimeoutMs);
    const scoped = new RepositoryWikiService(this.store, this.client ? deadlineClient(this.client, abort.signal) : null, this.mode, {
      cleanupConcurrency: this.cleanupConcurrency, writeTimeoutMs: this.writeTimeoutMs, signal: abort.signal,
      storageJobTimeoutMs: this.storageJobTimeoutMs,
    });
    try {
      await abortable(previous, abort.signal);
      abort.signal.throwIfAborted();
      return await operation(scoped);
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  private async hydrate(doc: MultiremiRepositoryWikiDoc): Promise<MultiremiRepositoryWikiDoc> {
    if (doc.syncStatus !== "ready" || !doc.contentUri) throw new RepositoryWikiUnavailableError(`Repository wiki content is not ready for ${doc.id}`);
    const content = await this.requireClient().read(doc.contentUri);
    if (doc.contentSha256 && sha256Text(content) !== doc.contentSha256) throw new RepositoryWikiUnavailableError(`Repository wiki checksum mismatch for ${doc.id}`);
    return { ...doc, body: decodeRepositoryWikiBody(content, doc) };
  }

  private async hydrateStrict(docs: readonly MultiremiRepositoryWikiDoc[]): Promise<MultiremiRepositoryWikiDoc[]> {
    return this.mode === "sql" ? [...docs] : Promise.all(docs.map(async (doc) => {
      try {
        return await this.hydrate(doc);
      } catch (error) {
        this.operationSignal?.throwIfAborted();
        throw new RepositoryWikiUnavailableError(repositoryWikiHydrationError(doc, error));
      }
    }));
  }

  private async requireDoc(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDoc> {
    const doc = await this.get(workspaceId, repositoryId, ref);
    if (!doc) throw new Error("repository wiki doc not found");
    return doc;
  }

  private async requireDocUnlocked(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDoc> {
    const doc = this.store.getRepositoryWikiDocByRef(workspaceId, repositoryId, ref);
    if (!doc) throw new Error("repository wiki doc not found");
    return this.mode === "sql" ? doc : this.hydrate(doc);
  }

  private requireClient(): OpenVikingClientContract {
    if (!this.client) throw new RepositoryWikiUnavailableError("OpenViking is not configured");
    return this.client;
  }

  private async ensureUriDirectories(root: string, uri: string, client = this.requireClient()): Promise<void> {
    await client.ensureDirectory(root);
    const relative = uri.startsWith(`${root}/`) ? uri.slice(root.length + 1) : "";
    const parts = relative.split("/").slice(0, -1).filter(Boolean);
    let current = root;
    for (const part of parts) {
      current += `/${part}`;
      await client.ensureDirectory(current);
    }
  }
}

/** Drain in-flight writers before rollback/checkpoint; stop scheduling after failure. */
async function forEachStorageEntry<T>(entries: readonly T[], operation: (entry: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  let failed = false;
  const results = await Promise.allSettled(Array.from({ length: Math.min(STORAGE_WRITE_CONCURRENCY, entries.length) }, async () => {
    while (!failed && cursor < entries.length) {
      const entry = entries[cursor++]!;
      try { await operation(entry); }
      catch (error) { failed = true; throw error; }
    }
  }));
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

function resolveBatchDocument(
  ref: string,
  documents: readonly MultiremiRepositoryWikiDoc[],
): MultiremiRepositoryWikiDoc | null {
  const value = String(ref ?? "").trim();
  if (!value) return null;
  const byId = documents.find((document) => document.id === value);
  if (byId) return byId;
  const path = normalizeRepositoryWikiPath(value);
  return documents.find((document) => document.path === path) ?? null;
}

function assertMigrationVersion(doc: MultiremiRepositoryWikiDoc, expected?: number): void {
  if (expected !== undefined && (!Number.isInteger(expected) || expected !== doc.version)) {
    throw new Error("repository wiki version conflict");
  }
}

function assertUniqueRepositoryWikiPaths(documents: readonly MultiremiRepositoryWikiDoc[]): void {
  const byPath = new Map<string, string>();
  for (const document of documents) {
    const previous = byPath.get(document.path);
    if (previous && previous !== document.id) {
      throw new Error(`repository wiki path already exists: ${document.path}`);
    }
    byPath.set(document.path, document.id);
  }
}

function repositoryWikiBatchContentUri(
  storageRootUri: string,
  batchId: string,
  document: MultiremiRepositoryWikiDoc,
): string {
  return `${storageRootUri}/batches/${encodeURIComponent(batchId)}/${encodeURIComponent(document.id)}-v${document.version}.md`;
}

function isRepositoryWikiStagingUri(storageRootUri: string, uri: string | null | undefined): boolean {
  return Boolean(uri?.startsWith(`${storageRootUri}/batches/`));
}

export function createRepositoryWikiServiceFromEnv(store: MultiremiStore): RepositoryWikiService {
  const mode = parseMode(process.env.MULTIREMI_PROJECT_KNOWLEDGE_MODE);
  if (mode === "sql") return new RepositoryWikiService(store, null, mode);
  const apiKey = process.env.MULTIREMI_OPENVIKING_API_KEY?.trim() || process.env.OPENVIKING_API_KEY?.trim();
  if (!apiKey) throw new Error(`OpenViking API key is required when MULTIREMI_PROJECT_KNOWLEDGE_MODE=${mode}`);
  return new RepositoryWikiService(store, new OpenVikingClient({
    baseUrl: process.env.MULTIREMI_OPENVIKING_URL?.trim() || "http://127.0.0.1:1933",
    apiKey,
    timeoutMs: positiveInt(process.env.MULTIREMI_OPENVIKING_TIMEOUT_MS, 30_000),
    maxRetries: positiveInt(process.env.MULTIREMI_OPENVIKING_MAX_RETRIES, 2),
  }), mode);
}

function prepareNew(workspaceId: string, repositoryId: string, input: CreateRepositoryWikiDocInput): MultiremiRepositoryWikiDoc {
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("title is required");
  const id = input.id ?? createId("rwdoc");
  const path = normalizeRepositoryWikiPath(input.path ?? input.slug ?? `${id}.md`);
  const now = nowIso();
  return {
    id, workspaceId, repositoryId, path, slug: path.replace(/\.md$/i, ""), title,
    summary: clean(input.summary), body: String(input.body ?? ""), tags: normalizeStrings(input.tags),
    refs: Array.isArray(input.refs) ? input.refs : [], sourceTaskId: clean(input.sourceTaskId ?? input.source_task_id),
    sourceIssueId: clean(input.sourceIssueId ?? input.source_issue_id),
    authorType: clean(input.authorType ?? input.author_type) as MultiremiRepositoryWikiDoc["authorType"],
    authorId: clean(input.authorId ?? input.author_id), updatedByType: clean(input.authorType ?? input.author_type) as MultiremiRepositoryWikiDoc["updatedByType"],
    updatedById: clean(input.authorId ?? input.author_id), sourceRevision: clean(input.sourceRevision ?? input.source_revision),
    status: "healthy", statusMessage: null, version: 1, storageBackend: "openviking", contentUri: null,
    contentSha256: null, syncStatus: "pending", syncError: null, snapshotOid: null, createdAt: now, updatedAt: now,
  };
}

function prepareUpdate(current: MultiremiRepositoryWikiDoc, input: UpdateRepositoryWikiDocInput): MultiremiRepositoryWikiDoc {
  const title = input.title === undefined ? current.title : String(input.title ?? "").trim();
  if (!title) throw new Error("title is required");
  const pathValue = input.path !== undefined ? input.path : input.slug !== undefined ? input.slug : current.path;
  const path = normalizeRepositoryWikiPath(pathValue);
  return {
    ...current, path, slug: path.replace(/\.md$/i, ""), title,
    summary: input.summary === undefined ? current.summary : clean(input.summary),
    body: input.body === undefined ? current.body : String(input.body ?? ""),
    tags: input.tags === undefined ? current.tags : normalizeStrings(input.tags),
    refs: input.refs === undefined || input.refs === null ? current.refs : input.refs,
    sourceRevision: input.sourceRevision === undefined && input.source_revision === undefined ? current.sourceRevision : clean(input.sourceRevision ?? input.source_revision),
    status: input.status ?? current.status,
    statusMessage: input.statusMessage === undefined && input.status_message === undefined ? current.statusMessage : clean(input.statusMessage ?? input.status_message),
    updatedByType: clean(input.updatedByType ?? input.updated_by_type) as MultiremiRepositoryWikiDoc["updatedByType"],
    updatedById: clean(input.updatedById ?? input.updated_by_id), version: current.version + 1, updatedAt: nowIso(),
  };
}

function clean(value: unknown): string | null { const text = String(value ?? "").trim(); return text || null; }
function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function normalizeStrings(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.map(String).map((v) => v.trim()).filter(Boolean))] : []; }
function clampLimit(value: number): number { return Math.max(1, Math.min(100, Math.floor(Number(value) || 20))); }
function positiveInt(value: string | undefined, fallback: number): number { const parsed = Number.parseInt(String(value ?? ""), 10); return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback; }
function parseMode(value: string | undefined): ProjectKnowledgeMode { const mode = String(value ?? "sql").toLowerCase(); if (mode === "sql" || mode === "shadow" || mode === "openviking") return mode; throw new Error("invalid knowledge mode"); }
function requireSnapshot(value: string | null): string { if (!value) throw new RepositoryWikiUnavailableError("OpenViking snapshot commit returned no OID"); return value; }
function repositoryWikiHydrationError(doc: MultiremiRepositoryWikiDoc, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Repository wiki body unavailable for ${doc.id} (${doc.path}): ${detail}`.slice(0, 1_000);
}
