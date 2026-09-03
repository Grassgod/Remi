import { createId, nowIso } from "@multiremi/ids.js";
import { cleanOptionalString, hasAnyField, parseJson, toJson } from "@multiremi/store/helpers.js";
import type { StoreContext } from "@multiremi/store/context.js";
import type {
  CreateRepositoryWikiDocInput,
  MultiremiProjectDocRef,
  MultiremiRepositoryWikiDoc,
  MultiremiRepositoryWikiDocRevision,
  MultiremiRepositoryWikiStatus,
  RepositoryWikiBatchResult,
  UpdateRepositoryWikiDocInput,
} from "@multiremi/contracts/types.js";
import { normalizeWikiPath } from "@multiremi/contracts/wiki-path";

type Row = Record<string, unknown>;

export interface RepositoryWikiWriteControl {
  contentUri: string;
  contentSha256: string;
  snapshotOid: string | null;
  syncStatus?: "pending" | "ready" | "failed" | "deleting";
  syncError?: string | null;
}

export interface RepositoryWikiStorageFinalization {
  docId: string;
  version: number;
  control: RepositoryWikiWriteControl;
}

export interface RepositoryWikiStoragePromotion {
  docId: string;
  version: number;
  stagedUri: string;
  finalUri: string;
  contentSha256: string;
}

export interface RepositoryWikiStorageJobManifest {
  promotions: RepositoryWikiStoragePromotion[];
  cleanupUris: string[];
}

export interface RepositoryWikiStorageJobInput {
  id: string;
  workspaceId: string;
  repositoryId: string;
  batchId: string;
  manifest: RepositoryWikiStorageJobManifest;
}

export interface RepositoryWikiStorageJob extends RepositoryWikiStorageJobInput {
  state: "pending" | "cleanup";
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RepositoryWikiStoreBatchOperation =
  | {
      kind: "create";
      workspaceId: string;
      repositoryId: string;
      input: CreateRepositoryWikiDocInput;
      control?: RepositoryWikiWriteControl;
    }
  | {
      kind: "update";
      current: MultiremiRepositoryWikiDoc;
      input: UpdateRepositoryWikiDocInput;
      control?: RepositoryWikiWriteControl;
    }
  | {
      kind: "delete";
      current: MultiremiRepositoryWikiDoc;
      expectedVersion: number;
    };

export class RepositoryWikiRepo {
  constructor(private readonly ctx: StoreContext) {}

  list(workspaceId: string, repositoryId: string): MultiremiRepositoryWikiDoc[] {
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_repository_wiki_docs
       WHERE workspace_id = ? AND repository_id = ? ORDER BY path`,
    ).all(workspaceId, repositoryId) as Row[]).map(toRepositoryWikiDoc);
  }

  listWorkspace(workspaceId: string): MultiremiRepositoryWikiDoc[] {
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_repository_wiki_docs
       WHERE workspace_id = ? ORDER BY updated_at DESC`,
    ).all(workspaceId) as Row[]).map(toRepositoryWikiDoc);
  }

  getByRef(workspaceId: string, repositoryId: string, ref: string): MultiremiRepositoryWikiDoc | null {
    const value = String(ref ?? "").trim();
    if (!value) return null;
    const byId = this.ctx.db.query(
      `SELECT * FROM multiremi_repository_wiki_docs
       WHERE workspace_id = ? AND repository_id = ? AND id = ?`,
    ).get(workspaceId, repositoryId, value) as Row | null;
    if (byId) return toRepositoryWikiDoc(byId);
    const path = normalizeRepositoryWikiPath(value);
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_repository_wiki_docs
       WHERE workspace_id = ? AND repository_id = ? AND path = ?`,
    ).get(workspaceId, repositoryId, path) as Row | null;
    return row ? toRepositoryWikiDoc(row) : null;
  }

  create(
    workspaceId: string,
    repositoryId: string,
    input: CreateRepositoryWikiDocInput,
    control?: RepositoryWikiWriteControl,
  ): MultiremiRepositoryWikiDoc {
    return this.ctx.db.transaction(() => this.createWithinTransaction(workspaceId, repositoryId, input, control))();
  }

  private createWithinTransaction(
    workspaceId: string,
    repositoryId: string,
    input: CreateRepositoryWikiDocInput,
    control?: RepositoryWikiWriteControl,
  ): MultiremiRepositoryWikiDoc {
    const title = String(input.title ?? "").trim();
    if (!title) throw new Error("title is required");
    const id = input.id ?? createId("rwdoc");
    const path = normalizeRepositoryWikiPath(input.path ?? input.slug ?? `${slugify(title) || id}.md`);
    const now = nowIso();
    const authorType = cleanOptionalString(input.authorType ?? input.author_type) as "member" | "agent" | null;
    const authorId = cleanOptionalString(input.authorId ?? input.author_id);
    const body = control ? "" : String(input.body ?? "");
    const storageBackend = control ? "openviking" : "sql";
    const syncStatus = control?.syncStatus ?? (control ? "ready" : "sql");
    this.ctx.db.run(
        `INSERT INTO multiremi_repository_wiki_docs (
          id, repository_id, workspace_id, path, title, summary, body, tags, refs,
          source_task_id, source_issue_id, author_type, author_id, updated_by_type, updated_by_id,
          source_revision, status, status_message, version, storage_backend, content_uri,
          content_sha256, sync_status, sync_error, snapshot_oid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy', NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, repositoryId, workspaceId, path, title, cleanOptionalString(input.summary), body,
          toJson(normalizeTags(input.tags)), toJson(normalizeRefs(input.refs)),
          cleanOptionalString(input.sourceTaskId ?? input.source_task_id),
          cleanOptionalString(input.sourceIssueId ?? input.source_issue_id), authorType, authorId,
          authorType, authorId, cleanOptionalString(input.sourceRevision ?? input.source_revision),
          storageBackend, control?.contentUri ?? null, control?.contentSha256 ?? null,
          syncStatus, control?.syncError ?? null, control?.snapshotOid ?? null, now, now,
        ],
    );
    this.insertRevision(id, 1, path, title, cleanOptionalString(input.summary), body,
      cleanOptionalString(input.sourceRevision ?? input.source_revision), authorType, authorId, now, control);
    return this.getByRef(workspaceId, repositoryId, id)!;
  }

  replaceExact(
    current: MultiremiRepositoryWikiDoc,
    input: UpdateRepositoryWikiDocInput,
    control?: RepositoryWikiWriteControl,
  ): MultiremiRepositoryWikiDoc {
    return this.ctx.db.transaction(() => this.replaceExactWithinTransaction(current, input, control))();
  }

  private replaceExactWithinTransaction(
    current: MultiremiRepositoryWikiDoc,
    input: UpdateRepositoryWikiDocInput,
    control?: RepositoryWikiWriteControl,
  ): MultiremiRepositoryWikiDoc {
    const expectedVersion = input.expectedVersion ?? input.expected_version;
    if (expectedVersion != null && Number(expectedVersion) !== current.version) {
      throw new Error("repository wiki version conflict");
    }
    const title = hasAnyField(input, "title") ? String(input.title ?? "").trim() : current.title;
    if (!title) throw new Error("title is required");
    const pathValue = hasAnyField(input, "path") ? input.path : hasAnyField(input, "slug") ? input.slug : current.path;
    const path = normalizeRepositoryWikiPath(pathValue ?? current.path);
    const summary = hasAnyField(input, "summary") ? cleanOptionalString(input.summary) : current.summary;
    const body = hasAnyField(input, "body") ? String(input.body ?? "") : current.body;
    const tags = hasAnyField(input, "tags") ? normalizeTags(input.tags) : current.tags;
    const refs = hasAnyField(input, "refs") ? normalizeRefs(input.refs) : current.refs;
    const updatedByType = cleanOptionalString(input.updatedByType ?? input.updated_by_type) as "member" | "agent" | null;
    const updatedById = cleanOptionalString(input.updatedById ?? input.updated_by_id);
    const sourceRevision = hasAnyField(input, "sourceRevision") || hasAnyField(input, "source_revision")
      ? cleanOptionalString(input.sourceRevision ?? input.source_revision)
      : current.sourceRevision;
    const status = normalizeStatus(input.status ?? current.status);
    const statusMessage = hasAnyField(input, "statusMessage") || hasAnyField(input, "status_message")
      ? cleanOptionalString(input.statusMessage ?? input.status_message)
      : current.statusMessage;
    const version = current.version + 1;
    const now = nowIso();
    const storedBody = control ? "" : body;
    const result = this.ctx.db.run(
        `UPDATE multiremi_repository_wiki_docs SET
          path = ?, title = ?, summary = ?, body = ?, tags = ?, refs = ?, updated_by_type = ?,
          updated_by_id = ?, source_revision = ?, status = ?, status_message = ?, version = ?,
          storage_backend = ?, content_uri = ?, content_sha256 = ?, sync_status = ?, sync_error = ?,
          snapshot_oid = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          path, title, summary, storedBody, toJson(tags), toJson(refs), updatedByType, updatedById,
          sourceRevision, status, statusMessage, version, control ? "openviking" : current.storageBackend,
          control?.contentUri ?? current.contentUri, control?.contentSha256 ?? current.contentSha256,
          control?.syncStatus ?? current.syncStatus, control?.syncError ?? current.syncError,
          control?.snapshotOid ?? current.snapshotOid, now, current.id, current.version,
        ],
    );
    if (result.changes !== 1) throw new Error("repository wiki version conflict");
    this.insertRevision(current.id, version, path, title, summary, storedBody, sourceRevision,
      updatedByType, updatedById, now, control);
    return this.getByRef(current.workspaceId, current.repositoryId, current.id)!;
  }

  delete(workspaceId: string, repositoryId: string, ref: string): MultiremiRepositoryWikiDoc {
    const current = this.getByRef(workspaceId, repositoryId, ref);
    if (!current) throw new Error("repository wiki doc not found");
    this.ctx.db.transaction(() => this.deleteWithinTransaction(current))();
    return current;
  }

  applyBatch(
    operations: readonly RepositoryWikiStoreBatchOperation[],
    storageJob?: RepositoryWikiStorageJobInput,
  ): RepositoryWikiBatchResult[] {
    if (!operations.length) return [];
    return this.ctx.db.transaction(() => {
      const touched = new Set<string>();
      for (const operation of operations) {
        if (operation.kind === "create") continue;
        if (touched.has(operation.current.id)) throw new Error(`repository wiki batch touches document more than once: ${operation.current.id}`);
        touched.add(operation.current.id);
        const locked = this.getByRef(operation.current.workspaceId, operation.current.repositoryId, operation.current.id);
        if (!locked || locked.version !== operation.current.version) throw new Error("repository wiki version conflict");
        if (operation.kind === "delete" && operation.expectedVersion !== locked.version) {
          throw new Error("repository wiki version conflict");
        }
      }

      const batchId = createId("rwbatch");
      for (const operation of operations) {
        if (operation.kind !== "update") continue;
        const nextPath = normalizeRepositoryWikiPath(operation.input.path ?? operation.input.slug ?? operation.current.path);
        if (nextPath === operation.current.path) continue;
        const temporaryPath = normalizeRepositoryWikiPath(`__batch/${batchId}/${operation.current.id}.md`);
        const moved = this.ctx.db.run(
          "UPDATE multiremi_repository_wiki_docs SET path = ? WHERE id = ? AND version = ?",
          [temporaryPath, operation.current.id, operation.current.version],
        );
        if (moved.changes !== 1) throw new Error("repository wiki version conflict");
      }

      const results = new Map<number, RepositoryWikiBatchResult>();
      for (const [index, operation] of operations.entries()) {
        if (operation.kind !== "delete") continue;
        this.deleteWithinTransaction(operation.current);
        results.set(index, { kind: "delete", doc: operation.current });
      }
      for (const [index, operation] of operations.entries()) {
        if (operation.kind !== "update") continue;
        results.set(index, {
          kind: "update",
          doc: this.replaceExactWithinTransaction(operation.current, operation.input, operation.control),
        });
      }
      for (const [index, operation] of operations.entries()) {
        if (operation.kind !== "create") continue;
        results.set(index, {
          kind: "create",
          doc: this.createWithinTransaction(operation.workspaceId, operation.repositoryId, operation.input, operation.control),
        });
      }
      if (storageJob) this.createStorageJobWithinTransaction(storageJob);
      return operations.map((_, index) => results.get(index)!);
    })();
  }

  finalizeBatchStorage(
    entries: readonly RepositoryWikiStorageFinalization[],
    storageJobId?: string,
  ): MultiremiRepositoryWikiDoc[] {
    if (!entries.length && !storageJobId) return [];
    return this.ctx.db.transaction(() => {
      const docs = entries.map((entry) => {
      const result = this.ctx.db.run(
        `UPDATE multiremi_repository_wiki_docs SET
           storage_backend = 'openviking', content_uri = ?, content_sha256 = ?, sync_status = ?,
           sync_error = ?, snapshot_oid = ? WHERE id = ? AND version = ?`,
        [
          entry.control.contentUri,
          entry.control.contentSha256,
          entry.control.syncStatus ?? "ready",
          entry.control.syncError ?? null,
          entry.control.snapshotOid,
          entry.docId,
          entry.version,
        ],
      );
      if (result.changes !== 1) throw new Error("repository wiki version conflict");
      this.ctx.db.run(
        `UPDATE multiremi_repository_wiki_doc_revisions SET
           content_uri = ?, content_sha256 = ?, snapshot_oid = ?
         WHERE doc_id = ? AND version = ?`,
        [
          entry.control.contentUri,
          entry.control.contentSha256,
          entry.control.snapshotOid,
          entry.docId,
          entry.version,
        ],
      );
      return this.getById(entry.docId)!;
      });
      if (storageJobId) {
        const updated = this.ctx.db.run(
          `UPDATE multiremi_repository_wiki_storage_jobs
           SET state = 'cleanup', last_error = NULL, updated_at = ?
           WHERE id = ?`,
          [nowIso(), storageJobId],
        );
        if (updated.changes !== 1) throw new Error("repository wiki storage job not found");
      }
      return docs;
    })();
  }

  listStorageJobs(workspaceId: string, repositoryId: string): RepositoryWikiStorageJob[] {
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_repository_wiki_storage_jobs
       WHERE workspace_id = ? AND repository_id = ? ORDER BY created_at, id`,
    ).all(workspaceId, repositoryId) as Row[]).map(toRepositoryWikiStorageJob);
  }

  listWorkspaceStorageJobs(workspaceId: string): RepositoryWikiStorageJob[] {
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_repository_wiki_storage_jobs
       WHERE workspace_id = ? ORDER BY repository_id, created_at, id`,
    ).all(workspaceId) as Row[]).map(toRepositoryWikiStorageJob);
  }

  recordStorageJobFailure(id: string, error: string): void {
    this.ctx.db.run(
      `UPDATE multiremi_repository_wiki_storage_jobs
       SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ? WHERE id = ?`,
      [error.slice(0, 1_000), nowIso(), id],
    );
  }

  completeStorageJob(id: string): void {
    this.ctx.db.run("DELETE FROM multiremi_repository_wiki_storage_jobs WHERE id = ?", [id]);
  }

  private createStorageJobWithinTransaction(input: RepositoryWikiStorageJobInput): void {
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_repository_wiki_storage_jobs (
         id, workspace_id, repository_id, batch_id, state, manifest, attempt_count,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', ?, 0, NULL, ?, ?)`,
      [input.id, input.workspaceId, input.repositoryId, input.batchId, toJson(input.manifest), now, now],
    );
  }

  private getById(id: string): MultiremiRepositoryWikiDoc | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_repository_wiki_docs WHERE id = ?").get(id) as Row | null;
    return row ? toRepositoryWikiDoc(row) : null;
  }

  revisions(docId: string): MultiremiRepositoryWikiDocRevision[] {
    return (this.ctx.db.query(
      "SELECT * FROM multiremi_repository_wiki_doc_revisions WHERE doc_id = ? ORDER BY version DESC",
    ).all(docId) as Row[]).map(toRepositoryWikiRevision);
  }

  private insertRevision(
    docId: string,
    version: number,
    path: string,
    title: string,
    summary: string | null,
    body: string,
    sourceRevision: string | null,
    authorType: string | null,
    authorId: string | null,
    createdAt: string,
    control?: RepositoryWikiWriteControl,
  ): void {
    this.ctx.db.run(
      `INSERT INTO multiremi_repository_wiki_doc_revisions (
        id, doc_id, version, path, title, summary, body, source_revision, author_type, author_id,
        content_uri, content_sha256, snapshot_oid, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [createId("rwrev"), docId, version, path, title, summary, body, sourceRevision, authorType, authorId,
        control?.contentUri ?? null, control?.contentSha256 ?? null, control?.snapshotOid ?? null, createdAt],
    );
  }

  private deleteWithinTransaction(current: MultiremiRepositoryWikiDoc): void {
    this.ctx.db.run("DELETE FROM multiremi_repository_wiki_doc_revisions WHERE doc_id = ?", [current.id]);
    const result = this.ctx.db.run(
      "DELETE FROM multiremi_repository_wiki_docs WHERE id = ? AND version = ?",
      [current.id, current.version],
    );
    if (result.changes !== 1) throw new Error("repository wiki version conflict");
  }
}

export function normalizeRepositoryWikiPath(value: unknown): string {
  try {
    return normalizeWikiPath(value);
  } catch {
    throw new Error("invalid repository wiki path");
  }
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, 50);
}

function normalizeRefs(value: unknown): MultiremiProjectDocRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MultiremiProjectDocRef[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const type = String(row.type ?? "").trim();
    const refValue = String(row.value ?? "").trim();
    return type && refValue ? [{ type, value: refValue }] : [];
  }).slice(0, 50);
}

function normalizeStatus(value: unknown): MultiremiRepositoryWikiStatus {
  const status = String(value ?? "healthy");
  return status === "unbuilt" || status === "building" || status === "stale" || status === "failed"
    ? status
    : "healthy";
}

function toRepositoryWikiDoc(row: Row): MultiremiRepositoryWikiDoc {
  const path = String(row.path ?? "");
  return {
    id: String(row.id), repositoryId: String(row.repository_id), workspaceId: String(row.workspace_id),
    path, slug: path.replace(/\.md$/i, ""), title: String(row.title),
    summary: cleanOptionalString(row.summary), body: String(row.body ?? ""),
    tags: parseJson(String(row.tags ?? "[]"), []), refs: parseJson(String(row.refs ?? "[]"), []),
    sourceTaskId: cleanOptionalString(row.source_task_id), sourceIssueId: cleanOptionalString(row.source_issue_id),
    authorType: cleanOptionalString(row.author_type) as MultiremiRepositoryWikiDoc["authorType"],
    authorId: cleanOptionalString(row.author_id),
    updatedByType: cleanOptionalString(row.updated_by_type) as MultiremiRepositoryWikiDoc["updatedByType"],
    updatedById: cleanOptionalString(row.updated_by_id), sourceRevision: cleanOptionalString(row.source_revision),
    status: normalizeStatus(row.status), statusMessage: cleanOptionalString(row.status_message),
    version: Number(row.version ?? 1), storageBackend: row.storage_backend === "openviking" ? "openviking" : "sql",
    contentUri: cleanOptionalString(row.content_uri), contentSha256: cleanOptionalString(row.content_sha256),
    syncStatus: normalizeSyncStatus(row.sync_status), syncError: cleanOptionalString(row.sync_error),
    snapshotOid: cleanOptionalString(row.snapshot_oid), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    compilationRunId: cleanOptionalString(row.compilation_run_id),
  };
}

function toRepositoryWikiRevision(row: Row): MultiremiRepositoryWikiDocRevision {
  return {
    id: String(row.id), docId: String(row.doc_id), version: Number(row.version), path: String(row.path),
    title: String(row.title), summary: cleanOptionalString(row.summary), body: String(row.body ?? ""),
    sourceRevision: cleanOptionalString(row.source_revision),
    authorType: cleanOptionalString(row.author_type) as MultiremiRepositoryWikiDocRevision["authorType"],
    authorId: cleanOptionalString(row.author_id), contentUri: cleanOptionalString(row.content_uri),
    contentSha256: cleanOptionalString(row.content_sha256), snapshotOid: cleanOptionalString(row.snapshot_oid),
    createdAt: String(row.created_at),
    compilationRunId: cleanOptionalString(row.compilation_run_id),
  };
}

function normalizeSyncStatus(value: unknown): MultiremiRepositoryWikiDoc["syncStatus"] {
  const status = String(value ?? "sql");
  return status === "pending" || status === "ready" || status === "failed" || status === "deleting" ? status : "sql";
}

function toRepositoryWikiStorageJob(row: Row): RepositoryWikiStorageJob {
  const manifest = parseJson(
    String(row.manifest ?? "{}"),
    { promotions: [], cleanupUris: [] },
  ) as RepositoryWikiStorageJobManifest;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    repositoryId: String(row.repository_id),
    batchId: String(row.batch_id),
    state: row.state === "cleanup" ? "cleanup" : "pending",
    manifest: {
      promotions: Array.isArray(manifest.promotions) ? manifest.promotions : [],
      cleanupUris: Array.isArray(manifest.cleanupUris) ? manifest.cleanupUris.map(String) : [],
    },
    attemptCount: Number(row.attempt_count ?? 0),
    lastError: cleanOptionalString(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
