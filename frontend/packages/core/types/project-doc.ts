// Project knowledge base — one table, two kinds:
//   - "memory": agent-authored operational facts. `title` is the one-line
//     fact, `body` optional detail. Pinned by default (enters the prompt
//     injection index).
//   - "wiki": a documentation page. `title` + markdown `body`.
//
// Both carry provenance (source_task_id / source_issue_id, soft references —
// tasks get GC'd, the knowledge must not) and an author. Every write lands a
// revision row.
export type ProjectDocKind = "wiki" | "memory";

export type ProjectDocAuthorType = "member" | "agent";

/**
 * A source the doc was distilled from. `type` is open on purpose ("issue",
 * "task", "comment", "url", "file" today) — the writer is an agent, and an
 * unknown type must render as plain text rather than disappear.
 */
export interface ProjectDocRef {
  type: string;
  value: string;
}

export interface ProjectDoc {
  id: string;
  project_id: string;
  workspace_id: string;
  kind: ProjectDocKind;
  slug: string;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
  pinned: boolean;
  refs: ProjectDocRef[];
  source_task_id: string | null;
  source_issue_id: string | null;
  author_type: ProjectDocAuthorType | null;
  author_id: string | null;
  updated_by_type: ProjectDocAuthorType | null;
  updated_by_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * A doc from the workspace-wide listing (`GET /api/project-docs`), which joins
 * the owning project so the aggregated view can group rows without a second
 * request.
 */
export interface WorkspaceDoc extends ProjectDoc {
  project_title: string;
}

export interface ProjectDocRevision {
  id: string;
  doc_id: string;
  version: number;
  title: string;
  summary: string | null;
  body: string;
  author_type: ProjectDocAuthorType | null;
  author_id: string | null;
  created_at: string;
}

export interface ListProjectDocsResponse {
  docs: ProjectDoc[];
}

export interface ListWorkspaceDocsResponse {
  docs: WorkspaceDoc[];
}

export interface ListProjectDocRevisionsResponse {
  revisions: ProjectDocRevision[];
}
