import matter from "gray-matter";
import type { MultiremiRepositoryWikiDoc } from "@multiremi/contracts/types.js";
import { knowledgeUriSegment, sha256Text } from "@multiremi/project-knowledge/codec.js";
import { normalizeRepositoryWikiPath } from "@multiremi/store/repos/repository-wiki-repo.js";

const ROOT = "viking://resources/multiremi";

export { sha256Text };

export function repositoryWikiRootUri(workspaceId: string, repositoryId: string): string {
  return `${ROOT}/workspaces/${knowledgeUriSegment(workspaceId, "workspaceId")}/repositories/${knowledgeUriSegment(repositoryId, "repositoryId")}/knowledge/wiki`;
}

export function repositoryWikiStorageRootUri(workspaceId: string, repositoryId: string): string {
  return `${ROOT}/internal/repository-wiki/${knowledgeUriSegment(workspaceId, "workspaceId")}/${knowledgeUriSegment(repositoryId, "repositoryId")}`;
}

export function repositoryWikiDocUri(workspaceId: string, repositoryId: string, path: string): string {
  const encodedPath = normalizeRepositoryWikiPath(path)
    .split("/")
    .map((part) => knowledgeUriSegment(part, "path"))
    .join("/");
  return `${repositoryWikiRootUri(workspaceId, repositoryId)}/${encodedPath}`;
}

export function repositoryWikiRetrievalTags(doc: MultiremiRepositoryWikiDoc): string[] {
  return [
    "app=multiremi",
    `workspace_id=${encodeURIComponent(doc.workspaceId)}`,
    `repository_id=${encodeURIComponent(doc.repositoryId)}`,
    "kind=wiki",
    `doc_id=${encodeURIComponent(doc.id)}`,
    `path=${encodeURIComponent(doc.path)}`,
    ...doc.tags.map((tag) => `label=${encodeURIComponent(tag)}`),
  ];
}

export function encodeRepositoryWikiDocument(doc: MultiremiRepositoryWikiDoc): string {
  return matter.stringify(normalizeBody(doc.body), {
    schema_version: 1,
    id: doc.id,
    workspace_id: doc.workspaceId,
    repository_id: doc.repositoryId,
    path: doc.path,
    title: doc.title,
    summary: doc.summary,
    tags: doc.tags,
    refs: doc.refs,
    source_task_id: doc.sourceTaskId,
    source_issue_id: doc.sourceIssueId,
    source_revision: doc.sourceRevision,
    author_type: doc.authorType,
    author_id: doc.authorId,
    updated_by_type: doc.updatedByType,
    updated_by_id: doc.updatedById,
    status: doc.status,
    version: doc.version,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  }).replace(/^---\n/, "---\n");
}

export function decodeRepositoryWikiBody(content: string, expected: MultiremiRepositoryWikiDoc): string {
  const parsed = matter(content);
  const data = parsed.data as Record<string, unknown>;
  const checks: Array<[string, string]> = [
    ["id", expected.id],
    ["workspace_id", expected.workspaceId],
    ["repository_id", expected.repositoryId],
    ["path", expected.path],
  ];
  for (const [field, value] of checks) {
    if (String(data[field] ?? "") !== value) throw new Error(`OpenViking repository wiki metadata mismatch for ${field}`);
  }
  return parsed.content.replace(/^\n/, "").replace(/\n$/, "");
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
}
