import { createId, nowIso } from "@multiremi/ids.js";
import { createLogger } from "@shared/logger.js";
import type {
  CreateProjectDocInput,
  MultiremiProject,
  MultiremiProjectDoc,
  MultiremiProjectDocIndexEntry,
  MultiremiProjectDocRevision,
  MultiremiTaskWithAgent,
  MultiremiWorkspaceProjectDoc,
  UpdateProjectDocInput,
} from "@multiremi/contracts/types.js";
import { hasAnyField } from "@multiremi/store/helpers.js";
import {
  PROJECT_DOC_SCHEMA_SLUG,
  PROJECT_DOC_SCHEMA_TEMPLATE,
  PROJECT_DOC_SCHEMA_TITLE,
  normalizeProjectDocKind,
  normalizeProjectDocRefs,
  normalizeProjectDocTags,
  normalizeProjectWikiPath,
  projectDocSlug,
} from "@multiremi/store/repos/projects-repo.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import {
  decodeProjectKnowledgeBody,
  encodeProjectKnowledgeDocument,
  projectKnowledgeDocUri,
  projectKnowledgeKindUri,
  projectKnowledgeRetrievalTags,
  projectKnowledgeRootUri,
  projectKnowledgeSlugFromUri,
  sha256Text,
} from "./codec.js";
import { OpenVikingClient } from "./openviking-client.js";
import type {
  OpenVikingClientContract,
  ProjectKnowledgeDoc,
  ProjectKnowledgeMigrationResult,
  ProjectKnowledgeMigrationStatus,
  ProjectKnowledgeMode,
  ProjectKnowledgeRevision,
  ProjectKnowledgeSearchHit,
  ProjectKnowledgeSearchOptions,
  ProjectKnowledgeWorkspaceDoc,
} from "./types.js";

export interface ProjectKnowledgeServiceContract {
  readonly mode: ProjectKnowledgeMode;
  listProjectDocs(projectId: string, input?: { kind?: string | null }): Promise<ProjectKnowledgeDoc[]>;
  getProjectDocByRef(projectId: string, ref: string): Promise<ProjectKnowledgeDoc | null>;
  createProjectDoc(projectId: string, input: CreateProjectDocInput): Promise<ProjectKnowledgeDoc>;
  updateProjectDoc(projectId: string, ref: string, input: UpdateProjectDocInput): Promise<ProjectKnowledgeDoc>;
  deleteProjectDoc(projectId: string, ref: string, input?: { expectedVersion?: number | null }): Promise<ProjectKnowledgeDoc>;
  listProjectDocRevisions(projectId: string, ref: string): Promise<ProjectKnowledgeRevision[]>;
  searchProjectDocs(projectId: string, query: string, input?: ProjectKnowledgeSearchOptions): Promise<ProjectKnowledgeDoc[]>;
  recallProjectDocs(projectId: string, query: string, input?: ProjectKnowledgeSearchOptions): Promise<ProjectKnowledgeSearchHit[]>;
  listWorkspaceDocs(workspaceId: string, input?: { kind?: string | null; q?: string | null; limit?: number }): Promise<ProjectKnowledgeWorkspaceDoc[]>;
  backlinks(projectId: string, ref: string): Promise<ProjectKnowledgeDoc[]>;
  migrationStatus(workspaceId: string): Promise<ProjectKnowledgeMigrationStatus>;
  backfill(workspaceId: string, input?: { dryRun?: boolean; resume?: boolean; projectId?: string | null; statuses?: string[] }): Promise<ProjectKnowledgeMigrationResult>;
  verify(workspaceId: string, projectId?: string | null): Promise<ProjectKnowledgeMigrationResult>;
  hydrateTaskKnowledge(task: MultiremiTaskWithAgent): Promise<MultiremiTaskWithAgent>;
}

export class ProjectKnowledgeUnavailableError extends Error {}

const log = createLogger("project-knowledge");
// Hydration issues one OpenViking `read` per doc. Doing that sequentially is what
// pushed recall past Bun's socket idle timeout, so batch it. 68 concurrent reads
// finish in under a second in production, so this bound stays effectively parallel
// for realistic result sets while capping the worst case at 16 instead of 500.
const HYDRATE_CONCURRENCY = 16;

export class ProjectKnowledgeService implements ProjectKnowledgeServiceContract {
  constructor(
    private readonly store: MultiremiStore,
    private readonly client: OpenVikingClientContract | null,
    readonly mode: ProjectKnowledgeMode,
  ) {
    if (mode !== "sql" && !client) throw new Error(`OpenViking client is required in ${mode} mode`);
  }

  async listProjectDocs(projectId: string, input: { kind?: string | null } = {}): Promise<ProjectKnowledgeDoc[]> {
    const docs = this.store.listProjectDocs(projectId, input);
    if (this.mode !== "openviking") return docs.map(asKnowledgeDoc);
    return Promise.all(docs.filter(isReadyOpenVikingDoc).map((doc) => this.hydrate(doc)));
  }

  async getProjectDocByRef(projectId: string, ref: string): Promise<ProjectKnowledgeDoc | null> {
    const doc = this.store.getProjectDocByRef(projectId, ref);
    if (!doc) return null;
    if (this.mode !== "openviking") return asKnowledgeDoc(doc);
    return this.hydrate(doc);
  }

  async createProjectDoc(projectId: string, input: CreateProjectDocInput): Promise<ProjectKnowledgeDoc> {
    if (normalizeProjectDocKind(input.kind ?? "wiki") === "memory" && !String(input.body ?? "").trim()) {
      throw new Error("memory body is required");
    }
    if (this.mode === "sql") return asKnowledgeDoc(this.store.createProjectDoc(projectId, input));
    if (this.mode === "shadow") {
      const created = this.store.createProjectDoc(projectId, input);
      await this.mirrorShadowDoc(created);
      const schema = this.store.getProjectDocByRef(projectId, PROJECT_DOC_SCHEMA_SLUG);
      if (schema && schema.id !== created.id && schema.syncStatus !== "ready") await this.mirrorShadowDoc(schema);
      return asKnowledgeDoc(this.store.getProjectDoc(created.id)!);
    }
    if (String(input.slug ?? "") !== PROJECT_DOC_SCHEMA_SLUG) await this.ensureOpenVikingSchema(projectId);
    return this.createOpenVikingDoc(projectId, input);
  }

  async updateProjectDoc(projectId: string, ref: string, input: UpdateProjectDocInput): Promise<ProjectKnowledgeDoc> {
    if (this.mode === "sql") return asKnowledgeDoc(this.store.updateProjectDoc(projectId, ref, input));
    if (this.mode === "shadow") {
      const updated = this.store.updateProjectDoc(projectId, ref, input);
      await this.mirrorShadowDoc(updated);
      return asKnowledgeDoc(this.store.getProjectDoc(updated.id)!);
    }
    const current = await this.requireDoc(projectId, ref);
    const expectedVersion = input.expectedVersion ?? input.expected_version;
    if (expectedVersion != null && Number(expectedVersion) !== current.version) {
      throw new Error("project doc version conflict");
    }
    const prepared = prepareUpdatedDoc(current, input);
    const oldUri = this.docUri(current);
    const newUri = this.docUri(prepared);
    const encoded = encodeProjectKnowledgeDocument(prepared);
    const hash = sha256Text(encoded);
    const client = this.requireClient();
    let previousContent: string | null = null;
    let metadata: MultiremiProjectDoc;
    try {
      await this.ensureDirectories(prepared);
      if (oldUri === newUri) {
        previousContent = await client.read(oldUri);
        await client.replace(newUri, projectKnowledgeRootUri(prepared.workspaceId, prepared.projectId), encoded, sha256Text(previousContent));
      } else {
        if (await client.exists(newUri)) throw new Error("a doc with this slug already exists");
        await client.create(newUri, projectKnowledgeRootUri(prepared.workspaceId, prepared.projectId), encoded);
      }
      await client.setTags(newUri, projectKnowledgeRetrievalTags(prepared));
      const snapshotOid = requireSnapshotOid(
        await client.commit(`project_doc:${prepared.id}:v${prepared.version}`, [newUri]),
      );
      metadata = this.store.replaceProjectDocMetadataExact(prepared, {
        contentUri: newUri,
        contentSha256: hash,
        snapshotOid,
      });
    } catch (error) {
      if (oldUri !== newUri) {
        await client.remove(newUri).catch(() => undefined);
      } else if (previousContent !== null) {
        const currentContent = await client.read(oldUri).catch(() => null);
        if (currentContent !== null && currentContent !== previousContent) {
          await client.replace(
            oldUri,
            projectKnowledgeRootUri(prepared.workspaceId, prepared.projectId),
            previousContent,
            sha256Text(currentContent),
          ).catch(() => undefined);
          await client.setTags(oldUri, projectKnowledgeRetrievalTags(current)).catch(() => undefined);
          await client.commit(`project_doc:${prepared.id}:rollback:v${prepared.version}`, [oldUri]).catch(() => undefined);
        }
      }
      throw error;
    }
    if (oldUri !== newUri && await client.exists(oldUri)) {
      await client.remove(oldUri);
      await client.commit(`project_doc:${prepared.id}:move:v${prepared.version}`, [oldUri, newUri]);
    }
    return { ...asKnowledgeDoc(metadata), body: prepared.body };
  }

  async deleteProjectDoc(
    projectId: string,
    ref: string,
    input: { expectedVersion?: number | null } = {},
  ): Promise<ProjectKnowledgeDoc> {
    const existing = this.store.getProjectDocByRef(projectId, ref);
    if (!existing) throw new Error(`Project doc not found: ${ref}`);
    if (input.expectedVersion != null && input.expectedVersion !== existing.version) {
      throw new Error("project doc version conflict");
    }
    if (this.mode !== "sql") {
      const client = this.requireClient();
      const uri = this.docUri(existing);
      this.store.setProjectDocSyncState(existing.id, { syncStatus: "deleting", syncError: null });
      try {
        if (await client.exists(uri)) await client.remove(uri);
      } catch (error) {
        const stillExists = await client.exists(uri).catch(() => true);
        if (stillExists) {
          this.store.setProjectDocSyncState(existing.id, {
            syncStatus: "failed",
            syncError: safeError(error),
          });
          throw error;
        }
      }
      try {
        await client.commit(`project_doc:${existing.id}:delete:v${existing.version}`, [uri]);
      } catch (error) {
        // The content is already absent. Keep deletion idempotent and do not
        // retain a control-plane tombstone solely because snapshotting failed.
        log.warn(`snapshot commit skipped while deleting ${existing.id}: ${safeError(error)}`);
      }
    }
    this.store.deleteProjectDoc(projectId, ref);
    return asKnowledgeDoc(existing);
  }

  async listProjectDocRevisions(projectId: string, ref: string): Promise<ProjectKnowledgeRevision[]> {
    const doc = await this.requireDoc(projectId, ref);
    const revisions = this.store.listProjectDocRevisions(doc.id).map(asKnowledgeRevision);
    if (this.mode !== "openviking") return revisions;
    const client = this.requireClient();
    return Promise.all(revisions.map(async (revision) => {
      if (!revision.snapshotOid) return revision;
      const contentUri = revision.contentUri ?? this.docUri(doc);
      const content = await client.show(revision.snapshotOid, contentUri);
      const slug = projectKnowledgeSlugFromUri(contentUri, doc);
      return { ...revision, body: decodeProjectKnowledgeBody(content, { ...doc, slug }) };
    }));
  }

  async searchProjectDocs(
    projectId: string,
    query: string,
    input: ProjectKnowledgeSearchOptions = {},
  ): Promise<ProjectKnowledgeDoc[]> {
    const hits = await this.recallProjectDocs(projectId, query, input);
    if (this.mode !== "openviking") return hits.map((hit) => hit.doc);
    return this.hydrateBounded(hits.map((hit) => hit.doc), "search hit", (doc) => doc);
  }

  async recallProjectDocs(
    projectId: string,
    query: string,
    input: ProjectKnowledgeSearchOptions = {},
  ): Promise<ProjectKnowledgeSearchHit[]> {
    const term = query.trim();
    if (!term) return [];
    const project = this.requireProject(projectId);
    const kind = input.kind ? normalizeProjectDocKind(input.kind) : null;
    const limit = clampLimit(input.limit, 20, 100);
    if (this.mode !== "openviking") {
      return this.store.searchProjectDocs(projectId, term, { kind, limit }).map((doc) => ({
        doc: asKnowledgeDoc(doc),
        score: null,
        snippet: doc.summary,
        uri: doc.contentUri ?? this.docUri(doc),
      }));
    }
    const target = kind
      ? projectKnowledgeKindUri(project.workspaceId, project.id, kind)
      : projectKnowledgeRootUri(project.workspaceId, project.id);
    const hits = await this.requireClient().find(term, target, Math.min(500, limit * 3), [
      `workspace_id=${encodeURIComponent(project.workspaceId)}`,
      `project_id=${encodeURIComponent(project.id)}`,
      ...(kind ? [`kind=${kind}`] : []),
    ]);
    const output: ProjectKnowledgeSearchHit[] = [];
    for (const hit of hits) {
      if (!hit.uri.endsWith(".md") || hit.uri.endsWith("/.abstract.md")) continue;
      const metadata = this.findDocByUri(projectId, hit.uri);
      if (!metadata || (kind && metadata.kind !== kind)) continue;
      output.push({ doc: asKnowledgeDoc(metadata), score: hit.score, snippet: hit.abstract, uri: hit.uri });
    }
    return output.slice(0, limit);
  }

  async listWorkspaceDocs(
    workspaceId: string,
    input: { kind?: string | null; q?: string | null; limit?: number } = {},
  ): Promise<ProjectKnowledgeWorkspaceDoc[]> {
    const query = String(input.q ?? "").trim();
    if (this.mode !== "openviking" || !query) {
      const docs = this.store.listWorkspaceDocs(workspaceId, this.mode === "openviking" ? { ...input, q: null } : input);
      const available = this.mode === "openviking" ? docs.filter(isReadyOpenVikingDoc) : docs;
      const limited = available.slice(0, clampLimit(input.limit, 200, 500));
      if (this.mode !== "openviking") return limited.map(asWorkspaceKnowledgeDoc);
      return this.hydrateBounded(limited, "workspace doc", (doc, source) => ({ ...doc, projectTitle: source.projectTitle }));
    }
    const projects = this.store.listProjects(workspaceId);
    const roots = projects.map((project) => input.kind
      ? projectKnowledgeKindUri(workspaceId, project.id, normalizeProjectDocKind(input.kind))
      : projectKnowledgeRootUri(workspaceId, project.id));
    if (!roots.length) return [];
    const limit = clampLimit(input.limit, 200, 500);
    const hits = await this.requireClient().find(query, roots, Math.min(500, limit * 3), [`workspace_id=${encodeURIComponent(workspaceId)}`]);
    // Resolve every hit against a single snapshot of the workspace index, then trim
    // to `limit` before hydrating. Looking the index up per hit re-read the whole
    // workspace once per candidate, and hydrating before the slice fetched bodies
    // for up to 500 docs only to discard all but `limit` of them.
    const byId = new Map(projects.map((project) => [project.id, project]));
    const byUri = new Map(this.store.listProjectDocsForMigration(workspaceId).map((doc) => [doc.contentUri, doc]));
    const matched: MultiremiWorkspaceProjectDoc[] = [];
    for (const hit of hits) {
      if (matched.length >= limit) break;
      if (!hit.uri.endsWith(".md") || hit.uri.endsWith("/.abstract.md")) continue;
      const metadata = byUri.get(hit.uri);
      if (!metadata || !isReadyOpenVikingDoc(metadata)) continue;
      const project = byId.get(metadata.projectId);
      if (!project) continue;
      matched.push({ ...metadata, projectTitle: project.title });
    }
    return this.hydrateBounded(matched, "workspace search hit", (doc, source) => ({ ...doc, projectTitle: source.projectTitle }));
  }

  /**
   * Hydrate docs in bounded-concurrency batches, dropping (and logging) individual
   * docs whose OpenViking content cannot be read so one bad doc cannot fail the
   * whole listing.
   */
  private async hydrateBounded<S extends MultiremiProjectDoc, T>(
    docs: S[],
    label: string,
    map: (doc: ProjectKnowledgeDoc, source: S) => T,
  ): Promise<T[]> {
    const output: T[] = [];
    for (let offset = 0; offset < docs.length; offset += HYDRATE_CONCURRENCY) {
      const batch = docs.slice(offset, offset + HYDRATE_CONCURRENCY);
      const hydrated = await Promise.all(batch.map(async (source) => {
        try {
          return { ok: true as const, value: map(await this.hydrate(source), source) };
        } catch (error) {
          log.warn(`skipping unreadable OpenViking ${label} ${source.id}: ${safeError(error)}`);
          return { ok: false as const };
        }
      }));
      for (const entry of hydrated) if (entry.ok) output.push(entry.value);
    }
    return output;
  }

  async backlinks(projectId: string, ref: string): Promise<ProjectKnowledgeDoc[]> {
    const target = await this.requireDoc(projectId, ref);
    const needle = `[[${target.slug}]]`;
    const docs = await this.listProjectDocs(projectId);
    return docs.filter((doc) => doc.id !== target.id && doc.body.includes(needle));
  }

  async migrationStatus(workspaceId: string): Promise<ProjectKnowledgeMigrationStatus> {
    const docs = this.store.listProjectDocsForMigration(workspaceId);
    const count = (status: string) => docs.filter((doc) => (doc.syncStatus ?? "sql") === status).length;
    let openviking: ProjectKnowledgeMigrationStatus["openviking"] = "not_configured";
    if (this.client) {
      try {
        await this.client.health();
        openviking = "ready";
      } catch {
        openviking = "unavailable";
      }
    }
    return {
      mode: this.mode,
      workspaceId,
      openviking,
      total: docs.length,
      sql: count("sql"),
      pending: count("pending"),
      ready: count("ready"),
      failed: count("failed"),
      deleting: count("deleting"),
    };
  }

  async backfill(
    workspaceId: string,
    input: { dryRun?: boolean; resume?: boolean; projectId?: string | null; statuses?: string[] } = {},
  ): Promise<ProjectKnowledgeMigrationResult> {
    if (!input.dryRun) this.requireClient();
    const statuses = input.statuses ?? (input.resume ? ["sql", "pending", "failed", "ready"] : []);
    let docs = this.store.listProjectDocsForMigration(workspaceId, statuses);
    if (input.projectId) docs = docs.filter((doc) => doc.projectId === input.projectId);
    const result: ProjectKnowledgeMigrationResult = {
      dryRun: Boolean(input.dryRun),
      scanned: docs.length,
      migrated: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    };
    for (const doc of docs) {
      if (input.dryRun) {
        if (doc.syncStatus === "ready" && doc.contentSha256) result.skipped++;
        else result.migrated++;
        continue;
      }
      try {
        const migrated = await this.migrateSqlDoc(doc);
        if (migrated) result.migrated++;
        else result.skipped++;
      } catch (error) {
        const message = safeError(error);
        this.store.setProjectDocSyncState(doc.id, { syncStatus: "failed", syncError: message });
        result.failed++;
        result.failures.push({ docId: doc.id, error: message });
      }
    }
    return result;
  }

  async verify(workspaceId: string, projectId?: string | null): Promise<ProjectKnowledgeMigrationResult> {
    const client = this.requireClient();
    let docs = this.store.listProjectDocsForMigration(workspaceId);
    if (projectId) docs = docs.filter((doc) => doc.projectId === projectId);
    const result: ProjectKnowledgeMigrationResult = {
      dryRun: true,
      scanned: docs.length,
      migrated: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    };
    for (const doc of docs) {
      try {
        if (!doc.contentUri || !doc.contentSha256) throw new Error("document has not been backfilled");
        const content = await client.read(doc.contentUri);
        if (sha256Text(content) !== doc.contentSha256) throw new Error("OpenViking content checksum mismatch");
        decodeProjectKnowledgeBody(content, doc);
        for (const revision of this.store.listProjectDocRevisions(doc.id)) {
          if (!revision.contentUri || !revision.contentSha256 || !revision.snapshotOid) {
            throw new Error(`revision ${revision.version} has not been backfilled`);
          }
          const historical = await client.show(revision.snapshotOid, revision.contentUri);
          if (sha256Text(historical) !== revision.contentSha256) {
            throw new Error(`revision ${revision.version} checksum mismatch`);
          }
          const slug = projectKnowledgeSlugFromUri(revision.contentUri, doc);
          decodeProjectKnowledgeBody(historical, { ...doc, slug });
        }
        result.migrated++;
      } catch (error) {
        result.failed++;
        result.failures.push({ docId: doc.id, error: safeError(error) });
      }
    }
    return result;
  }

  async hydrateTaskKnowledge(task: MultiremiTaskWithAgent): Promise<MultiremiTaskWithAgent> {
    if (this.mode !== "openviking") return task;
    const next = { ...task };
    if (task.project) {
      const docs = await this.listProjectDocs(task.project.id);
      next.projectDocs = projectDocsIndex(docs);
      next.projectWikiDocs = docs.filter((doc) => doc.kind === "wiki");
    }
    if (task.projectContexts.length) {
      next.projectContexts = await Promise.all(task.projectContexts.map(async (context) => ({
        ...context,
        docs: await this.listProjectDocs(context.project.id),
      })));
    }
    return next;
  }

  private async ensureOpenVikingSchema(projectId: string): Promise<void> {
    if (this.store.getProjectDocByRef(projectId, PROJECT_DOC_SCHEMA_SLUG)) return;
    await this.createOpenVikingDoc(projectId, {
      kind: "wiki",
      slug: PROJECT_DOC_SCHEMA_SLUG,
      title: PROJECT_DOC_SCHEMA_TITLE,
      body: PROJECT_DOC_SCHEMA_TEMPLATE,
      pinned: false,
    });
  }

  private async createOpenVikingDoc(projectId: string, input: CreateProjectDocInput): Promise<ProjectKnowledgeDoc> {
    const project = this.requireProject(projectId);
    const id = input.id ?? createId("pdoc");
    const title = String(input.title ?? "").trim();
    if (!title) throw new Error("title is required");
    const kind = normalizeProjectDocKind(input.kind ?? "wiki");
    const slug = projectDocSlug(input.slug, title, id);
    const uri = projectKnowledgeDocUri({ workspaceId: project.workspaceId, projectId, kind, slug });
    const metadata = this.store.createProjectDocMetadata(projectId, { ...input, id, kind, slug, body: "" }, {
      contentUri: uri,
      contentSha256: "",
      snapshotOid: null,
      syncStatus: "pending",
    });
    const prepared: MultiremiProjectDoc = { ...metadata, body: String(input.body ?? "") };
    const encoded = encodeProjectKnowledgeDocument(prepared);
    const hash = sha256Text(encoded);
    const client = this.requireClient();
    try {
      await this.ensureDirectories(prepared);
      await client.create(uri, projectKnowledgeRootUri(project.workspaceId, projectId), encoded);
      await client.setTags(uri, projectKnowledgeRetrievalTags(prepared));
      const snapshotOid = requireSnapshotOid(await client.commit(`project_doc:${id}:v1`, [uri]));
      const stored = this.store.setProjectDocSyncState(id, {
        storageBackend: "openviking",
        contentUri: uri,
        contentSha256: hash,
        syncStatus: "ready",
        syncError: null,
        snapshotOid,
      });
      this.store.setProjectDocRevisionStorage(id, 1, uri, hash, snapshotOid);
      return { ...asKnowledgeDoc(stored), body: prepared.body };
    } catch (error) {
      if (await client.exists(uri).catch(() => false)) await client.remove(uri).catch(() => undefined);
      this.store.deleteProjectDoc(projectId, id);
      throw error;
    }
  }

  private async hydrate(doc: MultiremiProjectDoc): Promise<ProjectKnowledgeDoc> {
    const control = asKnowledgeDoc(doc);
    if (!control.contentUri || control.syncStatus !== "ready") {
      throw new ProjectKnowledgeUnavailableError(`OpenViking content is not ready for project doc ${doc.id}`);
    }
    const content = await this.requireClient().read(control.contentUri);
    if (control.contentSha256 && sha256Text(content) !== control.contentSha256) {
      throw new ProjectKnowledgeUnavailableError(`OpenViking content checksum mismatch for project doc ${doc.id}`);
    }
    return { ...control, body: decodeProjectKnowledgeBody(content, doc) };
  }

  private async requireDoc(projectId: string, ref: string): Promise<ProjectKnowledgeDoc> {
    const doc = await this.getProjectDocByRef(projectId, ref);
    if (!doc) throw new Error(`Project doc not found: ${ref}`);
    return doc;
  }

  private requireProject(projectId: string): MultiremiProject {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  private requireClient(): OpenVikingClientContract {
    if (!this.client) throw new ProjectKnowledgeUnavailableError("OpenViking is not configured");
    return this.client;
  }

  private docUri(doc: Pick<MultiremiProjectDoc, "workspaceId" | "projectId" | "kind" | "slug">): string {
    return projectKnowledgeDocUri(doc);
  }

  private findDocByUri(projectId: string, uri: string): MultiremiProjectDoc | null {
    return this.store.listProjectDocs(projectId).find((doc) => doc.contentUri === uri || this.docUri(doc) === uri) ?? null;
  }

  private async ensureDirectories(doc: Pick<MultiremiProjectDoc, "workspaceId" | "projectId" | "kind">): Promise<void> {
    const client = this.requireClient();
    await client.ensureDirectory(projectKnowledgeRootUri(doc.workspaceId, doc.projectId));
    await client.ensureDirectory(projectKnowledgeKindUri(doc.workspaceId, doc.projectId, doc.kind));
  }

  private async mirrorShadowDoc(doc: MultiremiProjectDoc): Promise<void> {
    try {
      await this.migrateSqlDoc(doc);
    } catch (error) {
      this.store.setProjectDocSyncState(doc.id, { syncStatus: "failed", syncError: safeError(error) });
    }
  }

  private async migrateSqlDoc(doc: MultiremiProjectDoc): Promise<boolean> {
    const client = this.requireClient();
    const uri = this.docUri(doc);
    const previousUri = doc.contentUri && doc.contentUri !== uri ? doc.contentUri : null;
    const revisions = this.store.listProjectDocRevisions(doc.id).sort((a, b) => a.version - b.version);
    const existingCommits = await client.log([uri], 500).catch(() => []);
    const commitByVersion = new Map<number, string>();
    for (const commit of existingCommits) {
      const match = commit.message.match(new RegExp(`^project_doc:${escapeRegExp(doc.id)}:v(\\d+)$`));
      if (match && commit.oid) commitByVersion.set(Number(match[1]), commit.oid);
    }
    let currentHash = await client.exists(uri) ? sha256Text(await client.read(uri)) : null;
    let currentRevisionSnapshotOid: string | null = null;
    let changed = false;
    await this.ensureDirectories(doc);
    for (const revision of revisions) {
      if (revision.snapshotOid) {
        if (revision.version === doc.version) currentRevisionSnapshotOid = revision.snapshotOid;
        continue;
      }
      const knownOid = commitByVersion.get(revision.version);
      if (knownOid) {
        const historical = await client.show(knownOid, uri);
        this.store.setProjectDocRevisionStorage(doc.id, revision.version, uri, sha256Text(historical), knownOid);
        if (revision.version === doc.version) currentRevisionSnapshotOid = knownOid;
        continue;
      }
      const historicalDoc: MultiremiProjectDoc = {
        ...doc,
        title: revision.title,
        summary: revision.summary,
        body: revision.body,
        version: revision.version,
        updatedByType: revision.authorType,
        updatedById: revision.authorId,
        updatedAt: revision.createdAt,
      };
      const content = encodeProjectKnowledgeDocument(historicalDoc);
      const hash = sha256Text(content);
      if (currentHash === null) await client.create(uri, projectKnowledgeRootUri(doc.workspaceId, doc.projectId), content);
      else if (currentHash !== hash) await client.replace(uri, projectKnowledgeRootUri(doc.workspaceId, doc.projectId), content, currentHash);
      currentHash = hash;
      const snapshotOid = requireSnapshotOid(await client.commit(`project_doc:${doc.id}:v${revision.version}`, [uri]));
      this.store.setProjectDocRevisionStorage(doc.id, revision.version, uri, hash, snapshotOid);
      if (revision.version === doc.version) currentRevisionSnapshotOid = snapshotOid;
      changed = true;
    }
    const current = encodeProjectKnowledgeDocument(doc);
    const expectedHash = sha256Text(current);
    if (currentHash === null) await client.create(uri, projectKnowledgeRootUri(doc.workspaceId, doc.projectId), current);
    else if (currentHash !== expectedHash) await client.replace(uri, projectKnowledgeRootUri(doc.workspaceId, doc.projectId), current, currentHash);
    await client.setTags(uri, projectKnowledgeRetrievalTags(doc));
    let snapshotOid = doc.snapshotOid ?? currentRevisionSnapshotOid;
    if (currentHash !== expectedHash || !snapshotOid) {
      snapshotOid = requireSnapshotOid(await client.commit(`project_doc:${doc.id}:v${doc.version}`, [uri]));
      changed = true;
    }
    this.store.setProjectDocSyncState(doc.id, {
      storageBackend: "openviking",
      contentUri: uri,
      contentSha256: expectedHash,
      syncStatus: "ready",
      syncError: null,
      snapshotOid,
    });
    this.store.setProjectDocRevisionStorage(doc.id, doc.version, uri, expectedHash, snapshotOid);
    if (previousUri && await client.exists(previousUri)) {
      await client.remove(previousUri);
      await client.commit(`project_doc:${doc.id}:move:v${doc.version}`, [previousUri, uri]);
    }
    return changed;
  }
}

export function createProjectKnowledgeServiceFromEnv(store: MultiremiStore): ProjectKnowledgeService {
  const mode = parseMode(process.env.MULTIREMI_PROJECT_KNOWLEDGE_MODE);
  if (mode === "sql") return new ProjectKnowledgeService(store, null, mode);
  const apiKey = process.env.MULTIREMI_OPENVIKING_API_KEY?.trim() || process.env.OPENVIKING_API_KEY?.trim();
  if (!apiKey) throw new Error(`OpenViking API key is required when MULTIREMI_PROJECT_KNOWLEDGE_MODE=${mode}`);
  const client = new OpenVikingClient({
    baseUrl: process.env.MULTIREMI_OPENVIKING_URL?.trim() || "http://127.0.0.1:1933",
    apiKey,
    timeoutMs: parsePositiveInt(process.env.MULTIREMI_OPENVIKING_TIMEOUT_MS, 30_000),
    maxRetries: parsePositiveInt(process.env.MULTIREMI_OPENVIKING_MAX_RETRIES, 2),
  });
  return new ProjectKnowledgeService(store, client, mode);
}

function prepareUpdatedDoc(current: ProjectKnowledgeDoc, input: UpdateProjectDocInput): MultiremiProjectDoc {
  const title = hasAnyField(input, "title") ? String(input.title ?? "").trim() : current.title;
  if (!title) throw new Error("title is required");
  return {
    ...current,
    slug: hasAnyField(input, "slug") ? projectDocSlug(input.slug, title, current.id) : current.slug,
    path: hasAnyField(input, "path") ? normalizeProjectWikiPath(input.path) : current.path,
    title,
    summary: hasAnyField(input, "summary") ? cleanOptional(input.summary) : current.summary,
    body: hasAnyField(input, "body") ? String(input.body ?? "") : current.body,
    tags: hasAnyField(input, "tags") ? normalizeProjectDocTags(input.tags) : current.tags,
    pinned: hasAnyField(input, "pinned") ? Boolean(input.pinned) : current.pinned,
    refs: hasAnyField(input, "refs") ? normalizeProjectDocRefs(input.refs) : current.refs,
    updatedByType: cleanOptional(input.updatedByType ?? input.updated_by_type) as MultiremiProjectDoc["updatedByType"],
    updatedById: cleanOptional(input.updatedById ?? input.updated_by_id),
    version: current.version + 1,
    updatedAt: nowIso(),
  };
}

function asKnowledgeDoc(doc: MultiremiProjectDoc): ProjectKnowledgeDoc {
  return {
    ...doc,
    storageBackend: doc.storageBackend === "openviking" ? "openviking" : "sql",
    contentUri: doc.contentUri ?? null,
    contentSha256: doc.contentSha256 ?? null,
    syncStatus: doc.syncStatus ?? "sql",
    syncError: doc.syncError ?? null,
    snapshotOid: doc.snapshotOid ?? null,
  };
}

function asWorkspaceKnowledgeDoc(doc: MultiremiWorkspaceProjectDoc): ProjectKnowledgeWorkspaceDoc {
  return { ...asKnowledgeDoc(doc), projectTitle: doc.projectTitle };
}

function asKnowledgeRevision(revision: MultiremiProjectDocRevision): ProjectKnowledgeRevision {
  return {
    ...revision,
    contentUri: revision.contentUri ?? null,
    contentSha256: revision.contentSha256 ?? null,
    snapshotOid: revision.snapshotOid ?? null,
  };
}

function projectDocsIndex(docs: ProjectKnowledgeDoc[]): { memory: MultiremiProjectDocIndexEntry[]; wiki: MultiremiProjectDocIndexEntry[]; schema: string | null } {
  const entries = docs.map((doc): MultiremiProjectDocIndexEntry => ({
    id: doc.id,
    slug: doc.slug,
    path: doc.path,
    title: doc.title,
    summary: trim(doc.summary, 160),
    body: doc.kind === "memory" ? trim(doc.body, 500) : null,
    kind: doc.kind,
    pinned: doc.pinned,
    sourceIssueId: doc.sourceIssueId,
    updatedAt: doc.updatedAt,
  }));
  return {
    memory: entries.filter((entry) => entry.kind === "memory").sort(indexOrder).slice(0, 50),
    wiki: entries.filter((entry) => entry.kind === "wiki" && entry.slug !== PROJECT_DOC_SCHEMA_SLUG).sort(indexOrder).slice(0, 100),
    schema: trim(docs.find((doc) => doc.slug === PROJECT_DOC_SCHEMA_SLUG)?.body ?? null, 1500),
  };
}

function isReadyOpenVikingDoc(doc: Pick<MultiremiProjectDoc, "storageBackend" | "syncStatus" | "contentUri">): boolean {
  return doc.storageBackend === "openviking" && doc.syncStatus === "ready" && Boolean(doc.contentUri);
}

function indexOrder(a: MultiremiProjectDocIndexEntry, b: MultiremiProjectDocIndexEntry): number {
  return Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt);
}

function trim(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function cleanOptional(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.floor(number));
}

function parseMode(value: string | undefined): ProjectKnowledgeMode {
  const mode = String(value ?? "sql").trim().toLowerCase();
  if (mode === "sql" || mode === "shadow" || mode === "openviking") return mode;
  throw new Error("MULTIREMI_PROJECT_KNOWLEDGE_MODE must be sql, shadow, or openviking");
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

function requireSnapshotOid(value: string | null): string {
  if (!value) throw new ProjectKnowledgeUnavailableError("OpenViking snapshot commit returned no OID");
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
