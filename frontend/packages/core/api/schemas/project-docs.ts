import { z } from "zod";
import type {
  ListProjectDocRevisionsResponse,
  ListProjectDocsResponse,
  ListWorkspaceDocsResponse,
  ProjectDoc,
} from "../../types";

// ---------------------------------------------------------------------------
// Project docs — the project knowledge base (`kind` = wiki page | agent
// memory entry). Read-only surface today, so leniency matters more than
// precision: `kind` / `author_type` stay `z.string()` so a server-side
// addition renders through the generic branch, `tags` and `pinned` default
// rather than failing the row, and `body` / `summary` tolerate absence (a
// skeleton page created by the CLI has neither).
// ---------------------------------------------------------------------------

// A citation on a doc. `type` stays open (issue / task / comment / url / file
// today) so an unknown type renders as plain text instead of failing the row.
const ProjectDocRefSchema = z.object({
  type: z.string().default(""),
  value: z.string().default(""),
}).loose();

const ProjectDocSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  workspace_id: z.string().default(""),
  kind: z.string(),
  slug: z.string().default(""),
  path: z.string().default(""),
  title: z.string(),
  summary: z.string().nullable().default(null),
  body: z.string().default(""),
  tags: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  // Citations are decoration on top of the doc: a server that doesn't send
  // them yet (or sends null / a JSON string it forgot to parse) must still
  // show the page, so anything non-array degrades to no badges, and a
  // non-object entry is dropped rather than failing the whole list.
  refs: z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((entry) => typeof entry === "object" && entry !== null)
        : [],
    z.array(ProjectDocRefSchema),
  ),
  source_task_id: z.string().nullable().default(null),
  source_issue_id: z.string().nullable().default(null),
  author_type: z.string().nullable().default(null),
  author_id: z.string().nullable().default(null),
  updated_by_type: z.string().nullable().default(null),
  updated_by_id: z.string().nullable().default(null),
  compilation_run_id: z.string().nullable().catch(null).default(null),
  version: z.number().default(1),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

export const ListProjectDocsResponseSchema = z.object({
  docs: z.array(ProjectDocSchema).default([]),
}).loose();

export const EMPTY_LIST_PROJECT_DOCS_RESPONSE: ListProjectDocsResponse = {
  docs: [],
};

// The workspace-wide listing joins the owning project's title. It defaults to
// "" rather than failing the row: a doc whose project title didn't come back
// still belongs in the list, just under an unnamed group.
const WorkspaceDocSchema = ProjectDocSchema.extend({
  project_title: z.string().default(""),
});

export const ListWorkspaceDocsResponseSchema = z.object({
  // One drifted row must not blank the whole Knowledge page (an array-level
  // fallback amplifying single-row drift is exactly the issue-timeline
  // incident): rows that fail the schema are dropped, the rest survive.
  docs: z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((entry) => WorkspaceDocSchema.safeParse(entry).success)
        : [],
    z.array(WorkspaceDocSchema),
  ),
}).loose();

export const EMPTY_LIST_WORKSPACE_DOCS_RESPONSE: ListWorkspaceDocsResponse = {
  docs: [],
};

export const EMPTY_PROJECT_DOC: ProjectDoc = {
  id: "",
  project_id: "",
  workspace_id: "",
  kind: "wiki",
  slug: "",
  path: "",
  title: "",
  summary: null,
  body: "",
  tags: [],
  pinned: false,
  refs: [],
  source_task_id: null,
  source_issue_id: null,
  author_type: null,
  author_id: null,
  updated_by_type: null,
  updated_by_id: null,
  compilation_run_id: null,
  version: 1,
  created_at: "",
  updated_at: "",
};

export const ProjectDocResponseSchema = z.object({
  doc: ProjectDocSchema,
}).loose();

const ProjectDocRevisionSchema = z.object({
  id: z.string(),
  doc_id: z.string(),
  version: z.number(),
  title: z.string(),
  summary: z.string().nullable().default(null),
  body: z.string().default(""),
  author_type: z.string().nullable().default(null),
  author_id: z.string().nullable().default(null),
  compilation_run_id: z.string().nullable().catch(null).default(null),
  created_at: z.string().default(""),
}).loose();

export const ListProjectDocRevisionsResponseSchema = z.object({
  revisions: z.array(ProjectDocRevisionSchema).default([]),
}).loose();

export const EMPTY_LIST_PROJECT_DOC_REVISIONS_RESPONSE: ListProjectDocRevisionsResponse = {
  revisions: [],
};
