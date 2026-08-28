import { createHash } from "node:crypto";
import matter from "gray-matter";
import type { MultiremiProjectDoc, MultiremiProjectDocKind } from "@multiremi/contracts/types.js";

const ROOT = "viking://resources/multiremi";

export function projectKnowledgeRootUri(workspaceId: string, projectId: string): string {
  return `${ROOT}/workspaces/${knowledgeUriSegment(workspaceId, "workspaceId")}/projects/${knowledgeUriSegment(projectId, "projectId")}/knowledge`;
}

export function projectKnowledgeKindUri(
  workspaceId: string,
  projectId: string,
  kind: MultiremiProjectDocKind,
): string {
  return `${projectKnowledgeRootUri(workspaceId, projectId)}/${kind}`;
}

export function projectKnowledgeDocUri(input: {
  workspaceId: string;
  projectId: string;
  kind: MultiremiProjectDocKind;
  slug: string;
}): string {
  return `${projectKnowledgeKindUri(input.workspaceId, input.projectId, input.kind)}/${knowledgeUriSegment(input.slug, "slug")}.md`;
}

export function projectKnowledgeSlugFromUri(
  uri: string,
  expected: Pick<MultiremiProjectDoc, "workspaceId" | "projectId" | "kind">,
): string {
  const prefix = `${projectKnowledgeKindUri(expected.workspaceId, expected.projectId, expected.kind)}/`;
  if (!uri.startsWith(prefix)) throw new Error("OpenViking document URI is outside the expected project scope");
  const encoded = uri.slice(prefix.length);
  if (!encoded.endsWith(".md") || encoded.slice(0, -3).includes("/")) {
    throw new Error("invalid OpenViking document URI");
  }
  const slug = decodeURIComponent(encoded.slice(0, -3));
  if (`${knowledgeUriSegment(slug, "slug")}.md` !== encoded) throw new Error("invalid OpenViking document URI");
  return slug;
}

export function projectKnowledgeRetrievalTags(doc: MultiremiProjectDoc): string[] {
  return [
    "app=multiremi",
    `workspace_id=${tagValue(doc.workspaceId)}`,
    `project_id=${tagValue(doc.projectId)}`,
    `kind=${doc.kind}`,
    `doc_id=${tagValue(doc.id)}`,
    `slug=${tagValue(doc.slug)}`,
    ...doc.tags.map((tag) => `label=${tagValue(tag)}`),
  ];
}

export function encodeProjectKnowledgeDocument(doc: MultiremiProjectDoc): string {
  const metadata = {
    schema_version: 1,
    id: doc.id,
    workspace_id: doc.workspaceId,
    project_id: doc.projectId,
    kind: doc.kind,
    slug: doc.slug,
    path: doc.path,
    title: doc.title,
    summary: doc.summary,
    tags: doc.tags,
    pinned: doc.pinned,
    refs: doc.refs,
    source_task_id: doc.sourceTaskId,
    source_issue_id: doc.sourceIssueId,
    author_type: doc.authorType,
    author_id: doc.authorId,
    updated_by_type: doc.updatedByType,
    updated_by_id: doc.updatedById,
    version: doc.version,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
  return matter.stringify(normalizeBody(doc.body), metadata).replace(/^---\n/, "---\n");
}

export function decodeProjectKnowledgeBody(
  content: string,
  expected: Pick<MultiremiProjectDoc, "id" | "workspaceId" | "projectId" | "kind" | "slug">,
): string {
  const parsed = matter(content);
  const data = parsed.data as Record<string, unknown>;
  const checks: Array<[string, string]> = [
    ["id", expected.id],
    ["workspace_id", expected.workspaceId],
    ["project_id", expected.projectId],
    ["kind", expected.kind],
    ["slug", expected.slug],
  ];
  for (const [field, value] of checks) {
    if (String(data[field] ?? "") !== value) {
      throw new Error(`OpenViking document metadata mismatch for ${field}`);
    }
  }
  return parsed.content.replace(/^\n/, "").replace(/\n$/, "");
}

export function sha256Text(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function knowledgeUriSegment(value: string, field: string): string {
  const text = value.trim();
  if (!text || text === "." || text === ".." || /[\/\\\0]/.test(text)) {
    throw new Error(`invalid ${field} for OpenViking URI`);
  }
  return encodeURIComponent(text);
}

function tagValue(value: string): string {
  return encodeURIComponent(value.trim());
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
}
