import { createId, nowIso } from "@multiremi/ids.js";
import { cleanOptionalString, hasAnyField, parseJson, toJson } from "@multiremi/store/helpers.js";
import type { StoreContext } from "@multiremi/store/context.js";
import type {
  CreateRepositoryWikiDocInput,
  MultiremiProjectDocRef,
  MultiremiRepositoryWikiDoc,
  MultiremiRepositoryWikiDocRevision,
  MultiremiRepositoryWikiStatus,
  UpdateRepositoryWikiDocInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export interface RepositoryWikiWriteControl {
  contentUri: string;
  contentSha256: string;
  snapshotOid: string | null;
  syncStatus?: "pending" | "ready" | "failed" | "deleting";
  syncError?: string | null;
}

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
    const tx = this.ctx.db.transaction(() => {
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
    });
    return tx();
  }

  replaceExact(
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
    return this.ctx.db.transaction(() => {
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
    })();
  }

  delete(workspaceId: string, repositoryId: string, ref: string): MultiremiRepositoryWikiDoc {
    const current = this.getByRef(workspaceId, repositoryId, ref);
    if (!current) throw new Error("repository wiki doc not found");
    this.ctx.db.transaction(() => {
      this.ctx.db.run("DELETE FROM multiremi_repository_wiki_doc_revisions WHERE doc_id = ?", [current.id]);
      this.ctx.db.run("DELETE FROM multiremi_repository_wiki_docs WHERE id = ?", [current.id]);
    })();
    return current;
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
}

export function normalizeRepositoryWikiPath(value: unknown): string {
  const text = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!text || text.length > 512 || text.includes("\0")) throw new Error("invalid repository wiki path");
  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("invalid repository wiki path");
  const normalized = parts.join("/");
  return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
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
  };
}

function normalizeSyncStatus(value: unknown): MultiremiRepositoryWikiDoc["syncStatus"] {
  const status = String(value ?? "sql");
  return status === "pending" || status === "ready" || status === "failed" || status === "deleting" ? status : "sql";
}
