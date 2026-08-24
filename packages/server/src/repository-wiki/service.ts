import { createId, nowIso } from "@multiremi/ids.js";
import type {
  CreateRepositoryWikiDocInput,
  MultiremiRepositoryWikiDoc,
  MultiremiRepositoryWikiDocRevision,
  MultiremiTaskWithAgent,
  MultiremiTaskRepositoryWikiContext,
  UpdateRepositoryWikiDocInput,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { normalizeRepositoryWikiPath } from "@multiremi/store/repos/repository-wiki-repo.js";
import { OpenVikingClient } from "@multiremi/project-knowledge/openviking-client.js";
import type { OpenVikingClientContract, ProjectKnowledgeMode } from "@multiremi/project-knowledge/types.js";
import {
  decodeRepositoryWikiBody,
  encodeRepositoryWikiDocument,
  repositoryWikiDocUri,
  repositoryWikiRetrievalTags,
  repositoryWikiRootUri,
  sha256Text,
} from "./codec.js";

export interface RepositoryWikiServiceContract {
  readonly mode: ProjectKnowledgeMode;
  list(workspaceId: string, repositoryId: string): Promise<MultiremiRepositoryWikiDoc[]>;
  listWorkspace(workspaceId: string): Promise<MultiremiRepositoryWikiDoc[]>;
  get(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDoc | null>;
  create(workspaceId: string, repositoryId: string, input: CreateRepositoryWikiDocInput): Promise<MultiremiRepositoryWikiDoc>;
  update(workspaceId: string, repositoryId: string, ref: string, input: UpdateRepositoryWikiDocInput): Promise<MultiremiRepositoryWikiDoc>;
  delete(workspaceId: string, repositoryId: string, ref: string, expectedVersion?: number | null): Promise<MultiremiRepositoryWikiDoc>;
  revisions(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDocRevision[]>;
  search(workspaceId: string, repositoryId: string, query: string, limit?: number): Promise<MultiremiRepositoryWikiDoc[]>;
  hydrateTaskWiki(task: MultiremiTaskWithAgent): Promise<MultiremiTaskWithAgent>;
}

export class RepositoryWikiUnavailableError extends Error {}

export class RepositoryWikiService implements RepositoryWikiServiceContract {
  constructor(
    private readonly store: MultiremiStore,
    private readonly client: OpenVikingClientContract | null,
    readonly mode: ProjectKnowledgeMode,
  ) {}

  async list(workspaceId: string, repositoryId: string): Promise<MultiremiRepositoryWikiDoc[]> {
    const docs = this.store.listRepositoryWikiDocs(workspaceId, repositoryId);
    return this.mode === "sql" ? docs : Promise.all(docs.map((doc) => this.hydrate(doc)));
  }

  async listWorkspace(workspaceId: string): Promise<MultiremiRepositoryWikiDoc[]> {
    // Workspace summaries only need control-plane metadata. Avoid loading every
    // repository page body from OpenViking for the Knowledge overview.
    return this.store.listWorkspaceRepositoryWikiDocs(workspaceId);
  }

  async get(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDoc | null> {
    const doc = this.store.getRepositoryWikiDocByRef(workspaceId, repositoryId, ref);
    if (!doc) return null;
    return this.mode === "sql" ? doc : this.hydrate(doc);
  }

  async create(workspaceId: string, repositoryId: string, input: CreateRepositoryWikiDocInput): Promise<MultiremiRepositoryWikiDoc> {
    if (this.mode === "sql") return this.store.createRepositoryWikiDoc(workspaceId, repositoryId, input);
    const prepared = prepareNew(workspaceId, repositoryId, input);
    const client = this.requireClient();
    const uri = repositoryWikiDocUri(workspaceId, repositoryId, prepared.path);
    const encoded = encodeRepositoryWikiDocument(prepared);
    await this.ensureDirectories(prepared);
    await client.create(uri, repositoryWikiRootUri(workspaceId, repositoryId), encoded);
    try {
      await client.setTags(uri, repositoryWikiRetrievalTags(prepared));
      const snapshotOid = requireSnapshot(await client.commit(`repository_wiki:${prepared.id}:v1`, [uri]));
      const metadata = this.store.createRepositoryWikiDoc(workspaceId, repositoryId, {
        ...input,
        id: prepared.id,
        path: prepared.path,
      }, {
        contentUri: uri,
        contentSha256: sha256Text(encoded),
        snapshotOid,
      });
      return { ...metadata, body: prepared.body };
    } catch (error) {
      await client.remove(uri).catch(() => undefined);
      throw error;
    }
  }

  async update(
    workspaceId: string,
    repositoryId: string,
    ref: string,
    input: UpdateRepositoryWikiDocInput,
  ): Promise<MultiremiRepositoryWikiDoc> {
    const current = await this.requireDoc(workspaceId, repositoryId, ref);
    if (this.mode === "sql") return this.store.updateRepositoryWikiDoc(current, input);
    const prepared = prepareUpdate(current, input);
    const client = this.requireClient();
    const oldUri = repositoryWikiDocUri(workspaceId, repositoryId, current.path);
    const newUri = repositoryWikiDocUri(workspaceId, repositoryId, prepared.path);
    const encoded = encodeRepositoryWikiDocument(prepared);
    const previous = await client.read(oldUri);
    await this.ensureDirectories(prepared);
    if (oldUri === newUri) {
      await client.replace(oldUri, repositoryWikiRootUri(workspaceId, repositoryId), encoded, sha256Text(previous));
    } else {
      if (await client.exists(newUri)) throw new Error("repository wiki path already exists");
      await client.create(newUri, repositoryWikiRootUri(workspaceId, repositoryId), encoded);
    }
    try {
      await client.setTags(newUri, repositoryWikiRetrievalTags(prepared));
      const snapshotOid = requireSnapshot(await client.commit(`repository_wiki:${current.id}:v${prepared.version}`, [newUri]));
      const stored = this.store.updateRepositoryWikiDoc(current, input, {
        contentUri: newUri,
        contentSha256: sha256Text(encoded),
        snapshotOid,
      });
      if (oldUri !== newUri) {
        // The new URI is the source of truth once the control-plane update
        // succeeds. Cleanup must not turn a successful move into a missing
        // document if OpenViking fails while removing the old path.
        await client.remove(oldUri).then(
          () => client.commit(`repository_wiki:${current.id}:move:v${prepared.version}`, [oldUri, newUri]),
          () => null,
        ).catch(() => null);
      }
      return { ...stored, body: prepared.body };
    } catch (error) {
      if (oldUri === newUri) {
        const changed = await client.read(oldUri).catch(() => null);
        if (changed !== null) await client.replace(oldUri, repositoryWikiRootUri(workspaceId, repositoryId), previous, sha256Text(changed)).catch(() => undefined);
      } else {
        await client.remove(newUri).catch(() => undefined);
      }
      throw error;
    }
  }

  async delete(workspaceId: string, repositoryId: string, ref: string, expectedVersion?: number | null): Promise<MultiremiRepositoryWikiDoc> {
    const current = await this.requireDoc(workspaceId, repositoryId, ref);
    if (expectedVersion != null && current.version !== expectedVersion) throw new Error("repository wiki version conflict");
    if (this.mode !== "sql") {
      const client = this.requireClient();
      const uri = repositoryWikiDocUri(workspaceId, repositoryId, current.path);
      if (await client.exists(uri)) {
        await client.remove(uri);
        await client.commit(`repository_wiki:${current.id}:delete:v${current.version}`, [uri]);
      }
    }
    return this.store.deleteRepositoryWikiDoc(workspaceId, repositoryId, ref);
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

  async hydrateTaskWiki(task: MultiremiTaskWithAgent): Promise<MultiremiTaskWithAgent> {
    const workspace = this.store.getWorkspace(task.workspaceId);
    if (!workspace) return task;
    const repositories = workspace.repos.flatMap((value) => normalizeWorkspaceRepository(value));
    const selectedIds = new Set<string>();
    const resourceKeys = new Set(task.projectResources.flatMap((resource) => {
      if (resource.resourceType !== "github_repo") return [];
      const url = resource.resourceRef.url;
      return typeof url === "string" && url.trim() ? [canonicalRemote(url)] : [];
    }));
    for (const repository of repositories) {
      if (resourceKeys.has(canonicalRemote(repository.url))) selectedIds.add(repository.id);
    }

    // SCM automations run without an Issue or Project. Resolve their target
    // from the server-owned canonical event instead of trusting prompt data.
    // This gives Atlas exactly one checked-out repository and its Wiki while
    // preserving the workspace boundary enforced by the recorded event.
    if (task.assignmentSourceEventId) {
      const event = this.store.getScmCanonicalEvent(task.assignmentSourceEventId);
      if (event?.workspaceId === task.workspaceId) selectedIds.add(event.repositoryId);
    }

    // Manual bootstrap runs are server-authored. The repository is still
    // resolved against this workspace's registry below before it is exposed.
    if (task.autopilotRunId) {
      const run = this.store.getAutopilotRun(task.autopilotRunId);
      const payload = record(run?.payload);
      const repositoryId = clean(payload?.atlas_repository_id);
      if (run && repositoryId) {
        const autopilot = this.store.getAutopilot(run.autopilotId);
        if (autopilot?.workspaceId === task.workspaceId && autopilot.title === "Atlas · Repository Wiki") {
          selectedIds.add(repositoryId);
        }
      }
    }

    const selected = repositories.filter((repository) => selectedIds.has(repository.id));
    if (!selected.length) return task;
    const contexts = await Promise.all(selected.map(async (repository) => ({
      repository,
      docs: await this.list(task.workspaceId, repository.id),
    })));
    const repos = [...task.repos];
    const knownRemotes = new Set(repos.map((repo) => canonicalRemote(repo.url)));
    for (const repository of selected) {
      if (!knownRemotes.has(canonicalRemote(repository.url))) repos.push({ url: repository.url });
    }
    return { ...task, repos, repositoryWikiContexts: contexts };
  }

  private async hydrate(doc: MultiremiRepositoryWikiDoc): Promise<MultiremiRepositoryWikiDoc> {
    if (doc.syncStatus !== "ready" || !doc.contentUri) throw new RepositoryWikiUnavailableError(`Repository wiki content is not ready for ${doc.id}`);
    const content = await this.requireClient().read(doc.contentUri);
    if (doc.contentSha256 && sha256Text(content) !== doc.contentSha256) throw new RepositoryWikiUnavailableError(`Repository wiki checksum mismatch for ${doc.id}`);
    return { ...doc, body: decodeRepositoryWikiBody(content, doc) };
  }

  private async requireDoc(workspaceId: string, repositoryId: string, ref: string): Promise<MultiremiRepositoryWikiDoc> {
    const doc = await this.get(workspaceId, repositoryId, ref);
    if (!doc) throw new Error("repository wiki doc not found");
    return doc;
  }

  private requireClient(): OpenVikingClientContract {
    if (!this.client) throw new RepositoryWikiUnavailableError("OpenViking is not configured");
    return this.client;
  }

  private async ensureDirectories(doc: MultiremiRepositoryWikiDoc): Promise<void> {
    const root = repositoryWikiRootUri(doc.workspaceId, doc.repositoryId);
    const client = this.requireClient();
    await client.ensureDirectory(root);
    const parts = doc.path.split("/").slice(0, -1);
    let current = root;
    for (const part of parts) {
      current += `/${encodeURIComponent(part)}`;
      await client.ensureDirectory(current);
    }
  }
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
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function normalizeStrings(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.map(String).map((v) => v.trim()).filter(Boolean))] : []; }
function clampLimit(value: number): number { return Math.max(1, Math.min(100, Math.floor(Number(value) || 20))); }
function positiveInt(value: string | undefined, fallback: number): number { const parsed = Number.parseInt(String(value ?? ""), 10); return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback; }
function parseMode(value: string | undefined): ProjectKnowledgeMode { const mode = String(value ?? "sql").toLowerCase(); if (mode === "sql" || mode === "shadow" || mode === "openviking") return mode; throw new Error("invalid knowledge mode"); }
function requireSnapshot(value: string | null): string { if (!value) throw new RepositoryWikiUnavailableError("OpenViking snapshot commit returned no OID"); return value; }

function normalizeWorkspaceRepository(value: unknown): MultiremiTaskRepositoryWikiContext["repository"][] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  const id = clean(row.id);
  const name = clean(row.name);
  const url = clean(row.url);
  if (!id || !name || !url) return [];
  return [{ id, name, url, defaultBranch: clean(row.default_branch ?? row.defaultBranch) }];
}

function canonicalRemote(value: string): string {
  const trimmed = value.trim();
  const scp = trimmed.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase().replace(/\.git$/i, "").replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    return `${url.hostname}${url.pathname}`.toLowerCase().replace(/\.git$/i, "").replace(/\/+$/, "");
  } catch {
    return trimmed.toLowerCase().replace(/\.git$/i, "").replace(/\/+$/, "");
  }
}
