import { createId, nowIso } from "@multiremi/ids.js";
import { createLogger } from "@shared/logger.js";
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
} from "./links.js";

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
  revisions(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDocRevision[]>;
  search(workspaceId: string, repositoryId: string, query: string, limit?: number): Promise<MultiremiRepositoryWikiDoc[]>;
  backlinks(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDoc[]>;
  hydrateTaskWiki(task: MultiremiTaskWithAgent): Promise<MultiremiTaskWithAgent>;
}

export class RepositoryWikiUnavailableError extends Error {}

const log = createLogger("repository-wiki");

export class RepositoryWikiService implements RepositoryWikiServiceContract {
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly store: MultiremiStore,
    private readonly client: OpenVikingClientContract | null,
    readonly mode: ProjectKnowledgeMode,
  ) {}

  async list(workspaceId: string, repositoryId: string): Promise<MultiremiRepositoryWikiDoc[]> {
    await this.repairDeferredCanonical(workspaceId, repositoryId);
    const docs = this.store.listRepositoryWikiDocs(workspaceId, repositoryId);
    if (this.mode === "sql") return docs;
    return Promise.all(docs.map(async (doc) => {
      try {
        return await this.hydrate(doc);
      } catch (error) {
        const message = repositoryWikiHydrationError(doc, error);
        log.warn(message);
        return {
          ...doc,
          body: "",
          status: "failed",
          statusMessage: message,
          syncStatus: "failed",
          syncError: message,
        };
      }
    }));
  }

  async listStrict(workspaceId: string, repositoryId: string): Promise<MultiremiRepositoryWikiDoc[]> {
    await this.repairDeferredCanonical(workspaceId, repositoryId);
    const docs = this.store.listRepositoryWikiDocs(workspaceId, repositoryId);
    return this.hydrateStrict(docs);
  }

  async listWorkspace(workspaceId: string): Promise<MultiremiRepositoryWikiDoc[]> {
    if (this.mode === "openviking") {
      const repositoryIds = [...new Set(this.store.listWorkspaceRepositoryWikiStorageJobs(workspaceId)
        .map((job) => job.repositoryId))];
      await Promise.all(repositoryIds.map((repositoryId) =>
        this.repairDeferredCanonical(workspaceId, repositoryId)));
    }
    // Workspace summaries only need control-plane metadata. Avoid loading every
    // repository page body from OpenViking for the Knowledge overview.
    return this.store.listWorkspaceRepositoryWikiDocs(workspaceId);
  }

  async get(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDoc | null> {
    await this.repairDeferredCanonical(workspaceId, repositoryId);
    const doc = this.store.getRepositoryWikiDocByRef(workspaceId, repositoryId, ref);
    if (!doc) return null;
    return this.mode === "sql" ? doc : this.hydrate(doc);
  }

  async create(workspaceId: string, repositoryId: string, input: CreateRepositoryWikiDocInput): Promise<MultiremiRepositoryWikiDoc> {
    return this.withWriteLock(workspaceId, repositoryId, async () => {
      const result = await this.applyBatchUnlocked(workspaceId, repositoryId, [{ kind: "create", input }]);
      return result[0]!.doc;
    });
  }

  async update(
    workspaceId: string,
    repositoryId: string,
    ref: string,
    input: UpdateRepositoryWikiDocInput,
  ): Promise<MultiremiRepositoryWikiDoc> {
    return this.withWriteLock(workspaceId, repositoryId, async () => {
      const current = await this.requireDocUnlocked(workspaceId, repositoryId, ref);
      const expectedVersion = input.expectedVersion ?? input.expected_version ?? current.version;
      const result = await this.applyBatchUnlocked(workspaceId, repositoryId, [{
        kind: "update",
        ref: current.id,
        input: { ...input, expectedVersion, expected_version: expectedVersion },
      }]);
      return result[0]!.doc;
    });
  }

  async delete(workspaceId: string, repositoryId: string, ref: string, expectedVersion?: number | null): Promise<MultiremiRepositoryWikiDoc> {
    return this.withWriteLock(workspaceId, repositoryId, async () => {
      const current = await this.requireDocUnlocked(workspaceId, repositoryId, ref);
      const version = expectedVersion ?? current.version;
      const result = await this.applyBatchUnlocked(workspaceId, repositoryId, [{
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
    return this.withWriteLock(workspaceId, repositoryId, () =>
      this.applyBatchUnlocked(workspaceId, repositoryId, operations));
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

  async search(workspaceId: string, repositoryId: string, query: string, limit = 20): Promise<MultiremiRepositoryWikiDoc[]> {
    const term = query.trim();
    if (!term) return [];
    if (this.mode !== "openviking") {
      const normalized = term.toLowerCase();
      return (await this.list(workspaceId, repositoryId)).filter((doc) =>
        [doc.title, doc.summary ?? "", doc.body, doc.path, ...doc.tags].some((value) => value.toLowerCase().includes(normalized))
      ).slice(0, clampLimit(limit));
    }
    await this.repairDeferredCanonical(workspaceId, repositoryId);
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
    const target = await this.requireDoc(workspaceId, repositoryId, ref);
    const documents = await this.listStrict(workspaceId, repositoryId);
    return repositoryWikiBacklinks(target, documents);
  }

  async hydrateTaskWiki(task: MultiremiTaskWithAgent): Promise<MultiremiTaskWithAgent> {
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
  ): Promise<RepositoryWikiBatchResult[]> {
    if (!operations.length) throw new Error("repository wiki batch operations are required");
    if (operations.length > 256) throw new Error("repository wiki batch supports at most 256 operations");

    await this.repairDeferredCanonicalUnlocked(workspaceId, repositoryId);
    if (this.store.listRepositoryWikiStorageJobs(workspaceId, repositoryId).length) {
      throw new RepositoryWikiUnavailableError("Repository wiki storage repair is still pending");
    }
    const before = await this.hydrateStrict(this.store.listRepositoryWikiDocs(workspaceId, repositoryId));
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
    assertUniqueRepositoryWikiPaths(after);
    assertNoIntroducedRepositoryWikiLinks(before, after);
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
      for (const entry of staged) {
        await this.ensureUriDirectories(storageRootUri, entry.uri);
        await client.create(entry.uri, storageRootUri, entry.content);
        await client.setTags(entry.uri, repositoryWikiRetrievalTags(entry.doc));
      }
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

  private async repairDeferredCanonical(workspaceId: string, repositoryId: string): Promise<void> {
    if (this.mode !== "openviking") return;
    if (!this.store.listRepositoryWikiStorageJobs(workspaceId, repositoryId).length) return;
    await this.withWriteLock(workspaceId, repositoryId, () =>
      this.repairDeferredCanonicalUnlocked(workspaceId, repositoryId));
  }

  private async repairDeferredCanonicalUnlocked(workspaceId: string, repositoryId: string): Promise<void> {
    if (this.mode !== "openviking") return;
    for (const job of this.store.listRepositoryWikiStorageJobs(workspaceId, repositoryId)) {
      if (!await this.processStorageJobUnlocked(job)) break;
    }
  }

  private async processStorageJobUnlocked(job: RepositoryWikiStorageJob): Promise<boolean> {
    const client = this.requireClient();
    const rootUri = repositoryWikiRootUri(job.workspaceId, job.repositoryId);
    const storageRootUri = repositoryWikiStorageRootUri(job.workspaceId, job.repositoryId);
    const previousCanonical = new Map<string, string | null>();
    let phase = job.state;
    try {
      if (phase === "pending") {
        const entries = await Promise.all(job.manifest.promotions.map(async (promotion) => {
          if (!isRepositoryWikiStagingUri(storageRootUri, promotion.stagedUri)) {
            throw new RepositoryWikiUnavailableError(`Invalid Repository Wiki staging URI for ${promotion.docId}`);
          }
          const doc = this.store.getRepositoryWikiDocByRef(job.workspaceId, job.repositoryId, promotion.docId);
          if (!doc || doc.version !== promotion.version) throw new Error("repository wiki version conflict");
          const expectedFinalUri = repositoryWikiDocUri(job.workspaceId, job.repositoryId, doc.path);
          if (promotion.finalUri !== expectedFinalUri) {
            throw new RepositoryWikiUnavailableError(`Invalid Repository Wiki final URI for ${promotion.docId}`);
          }
          const content = await client.read(promotion.stagedUri);
          if (sha256Text(content) !== promotion.contentSha256) {
            throw new RepositoryWikiUnavailableError(`Repository wiki checksum mismatch for ${promotion.docId}`);
          }
          return { doc, content, ...promotion };
        }));

        for (const entry of entries) {
          await this.ensureUriDirectories(rootUri, entry.finalUri);
          const exists = await client.exists(entry.finalUri);
          const previous = exists ? await client.read(entry.finalUri) : null;
          previousCanonical.set(entry.finalUri, previous);
          if (previous === null) {
            await client.create(entry.finalUri, rootUri, entry.content);
          } else {
            await client.replace(entry.finalUri, rootUri, entry.content, sha256Text(previous));
          }
          await client.setTags(entry.finalUri, repositoryWikiRetrievalTags(entry.doc));
        }

        const finalUris = entries.map((entry) => entry.finalUri);
        const snapshotOid = entries.length
          ? requireSnapshot(await client.commit(`repository_wiki_batch:${job.batchId}:promote`, finalUris))
          : null;
        this.store.finalizeRepositoryWikiBatchStorage(entries.map((entry) => ({
          docId: entry.docId,
          version: entry.version,
          control: {
            contentUri: entry.finalUri,
            contentSha256: entry.contentSha256,
            snapshotOid,
          },
        })), job.id);
        phase = "cleanup";
      }

      await this.cleanupUrisStrict(
        client,
        job.manifest.cleanupUris,
        `repository_wiki_batch:${job.batchId}:cleanup`,
      );
      this.store.completeRepositoryWikiStorageJob(job.id);
      log.info(`OpenViking storage job completed for ${job.workspaceId}/${job.repositoryId} (${job.id})`);
      return true;
    } catch (error) {
      if (phase === "pending") {
        await this.restoreCanonicalUris(client, rootUri, previousCanonical, job.batchId);
      }
      const message = safeError(error);
      this.store.recordRepositoryWikiStorageJobFailure(job.id, message);
      log.warn(`OpenViking storage job deferred for ${job.workspaceId}/${job.repositoryId}: ${message}`);
      return false;
    }
  }

  private async cleanupUrisStrict(
    client: OpenVikingClientContract,
    uris: readonly string[],
    commitMessage: string,
  ): Promise<void> {
    const uniqueUris = [...new Set(uris)];
    const failures: string[] = [];
    for (const uri of uniqueUris) {
      try {
        if (!await client.exists(uri)) continue;
        await client.remove(uri);
      } catch (error) {
        failures.push(`${uri}: ${safeError(error)}`);
      }
    }
    if (uniqueUris.length) await client.commit(commitMessage, uniqueUris);
    if (failures.length) throw new RepositoryWikiUnavailableError(failures.join("; "));
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
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${workspaceId}\u0000${repositoryId}`;
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.writeQueues.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.writeQueues.get(key) === tail) this.writeQueues.delete(key);
    }
  }

  private async hydrate(doc: MultiremiRepositoryWikiDoc): Promise<MultiremiRepositoryWikiDoc> {
    if (doc.syncStatus !== "ready" || !doc.contentUri) throw new RepositoryWikiUnavailableError(`Repository wiki content is not ready for ${doc.id}`);
    const content = await this.requireClient().read(doc.contentUri);
    if (doc.contentSha256 && sha256Text(content) !== doc.contentSha256) throw new RepositoryWikiUnavailableError(`Repository wiki checksum mismatch for ${doc.id}`);
    return { ...doc, body: decodeRepositoryWikiBody(content, doc) };
  }

  private async hydrateStrict(docs: readonly MultiremiRepositoryWikiDoc[]): Promise<MultiremiRepositoryWikiDoc[]> {
    return this.mode === "sql" ? [...docs] : Promise.all(docs.map((doc) => this.hydrate(doc)));
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

  private async ensureUriDirectories(root: string, uri: string): Promise<void> {
    const client = this.requireClient();
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
  return `Repository wiki body unavailable for ${doc.id}: ${detail}`.slice(0, 1_000);
}
