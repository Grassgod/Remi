// Wire serializers for the projects domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import type {
  CreateLabelInput,
  CreateProjectInput,
  MultiremiLabel,
  MultiremiPinnedItem,
  MultiremiProject,
  MultiremiProjectDoc,
  MultiremiProjectDocIndexEntry,
  MultiremiProjectDocRevision,
  MultiremiProjectResource,
  MultiremiProjectSearchResult,
  UpdateProjectInput,
} from "@multiremi/contracts/types.js";
import type { Context } from "hono";
import { ProjectInstructionsRevisionConflictError } from "@multiremi/store/repos/projects-repo.js";
import { currentRequestUserId } from "./context.js";

export function projectCompatibilityResponse(project: MultiremiProject): Record<string, unknown> {
  return {
    ...projectCompatibilitySummaryResponse(project),
    instructions: project.instructions,
    delta_instructions: project.deltaInstructions,
    instructions_revision: project.instructionsRevision,
    instructions_updated_at: project.instructionsUpdatedAt,
    instructions_updated_by: project.instructionsUpdatedBy,
  };
}

export function projectCompatibilitySummaryResponse(project: MultiremiProject): Record<string, unknown> {
  return {
    id: project.id,
    workspace_id: project.workspaceId,
    title: project.title,
    description: project.description,
    icon: project.icon,
    status: project.status,
    priority: project.priority,
    lead_type: project.leadType,
    lead_id: project.leadId,
    default_assignee_type: project.defaultAssigneeType,
    default_assignee_id: project.defaultAssigneeId,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    issue_count: project.issueCount,
    done_count: project.doneCount,
    resource_count: project.resourceCount,
    archived_at: project.archivedAt,
  };
}

export function projectNativeSummaryResponse(project: MultiremiProject): Record<string, unknown> {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    title: project.title,
    description: project.description,
    icon: project.icon,
    status: project.status,
    priority: project.priority,
    leadType: project.leadType,
    leadId: project.leadId,
    defaultAssigneeType: project.defaultAssigneeType,
    defaultAssigneeId: project.defaultAssigneeId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    issueCount: project.issueCount,
    doneCount: project.doneCount,
    resourceCount: project.resourceCount,
    archivedAt: project.archivedAt,
  };
}

export function projectSearchNativeResponse(project: MultiremiProjectSearchResult): Record<string, unknown> {
  const response = {
    ...projectNativeSummaryResponse(project),
    matchSource: project.matchSource,
  };
  if (project.matchedSnippet !== undefined) {
    return { ...response, matchedSnippet: project.matchedSnippet };
  }
  return response;
}

export function projectCreateCompatibilityInput(c: Context, input: CreateProjectInput): CreateProjectInput {
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    instructions: input.instructions,
    deltaInstructions: input.delta_instructions ?? input.deltaInstructions,
    icon: input.icon,
    workspaceId: input.workspace_id ?? c.req.query("workspace_id") ?? "local",
    status: input.status,
    priority: input.priority,
    leadType: input.lead_type === undefined && input.lead_id === undefined ? "member" : input.lead_type,
    leadId: input.lead_type === undefined && input.lead_id === undefined ? currentRequestUserId(c) : input.lead_id,
    defaultAssigneeType: input.default_assignee_type,
    defaultAssigneeId: input.default_assignee_id,
    resources: input.resources,
  };
}

export function projectCreateInputWithDefaultLead(c: Context, input: CreateProjectInput): CreateProjectInput {
  if (input.leadType !== undefined || input.lead_type !== undefined || input.leadId !== undefined || input.lead_id !== undefined) {
    return input;
  }
  return { ...input, leadType: "member", leadId: currentRequestUserId(c) };
}

export function projectUpdateCompatibilityInput(input: UpdateProjectInput): UpdateProjectInput {
  return {
    title: input.title,
    description: input.description,
    instructions: input.instructions,
    deltaInstructions: input.deltaInstructions ?? input.delta_instructions,
    expectedInstructionsRevision: input.expectedInstructionsRevision ?? input.expected_instructions_revision,
    icon: input.icon,
    status: input.status,
    priority: input.priority,
    leadType: input.lead_type,
    leadId: input.lead_id,
    defaultAssigneeType: input.default_assignee_type,
    defaultAssigneeId: input.default_assignee_id,
  };
}

export function labelCreateCompatibilityInput(input: CreateLabelInput): CreateLabelInput {
  return {
    id: input.id,
    name: input.name,
    color: input.color,
    workspaceId: input.workspace_id ?? "local",
  };
}

export function projectSearchCompatibilityResponse(project: MultiremiProjectSearchResult): Record<string, unknown> {
  const response = {
    ...projectCompatibilitySummaryResponse(project),
    match_source: project.matchSource,
  };
  if (project.matchedSnippet !== undefined) {
    return { ...response, matched_snippet: project.matchedSnippet };
  }
  return response;
}

export function pinCompatibilityResponse(pin: MultiremiPinnedItem): Record<string, unknown> {
  return {
    id: pin.id,
    workspace_id: pin.workspaceId,
    user_id: pin.userId,
    item_type: pin.itemType,
    item_id: pin.itemId,
    position: pin.position,
    created_at: pin.createdAt,
  };
}

export function pinCompatibilityErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Item already pinned") return c.json({ error: "item already pinned" }, 409);
  if (message.startsWith("Issue not found")) return c.json({ error: "issue not found" }, 404);
  if (message.startsWith("Project not found")) return c.json({ error: "project not found" }, 404);
  if (message === "item_id is required" || message === "item_type must be 'issue' or 'project'") {
    return c.json({ error: message }, 400);
  }
  return c.json({ error: message }, 400);
}

export function labelCompatibilityResponse(label: MultiremiLabel): Record<string, unknown> {
  return {
    id: label.id,
    workspace_id: label.workspaceId,
    name: label.name,
    color: label.color,
    created_at: label.createdAt,
    updated_at: label.updatedAt,
  };
}

export function labelCompatibilityErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Label not found") || message === "Label belongs to another workspace") {
    return c.json({ error: "label not found" }, 404);
  }
  if (message.startsWith("Label already exists")) {
    return c.json({ error: "a label with that name already exists" }, 409);
  }
  if (message === "Label name is required") {
    return c.json({ error: "name is required" }, 400);
  }
  if (message === "Label name cannot exceed 32 characters") {
    return c.json({ error: "name must be 32 characters or fewer" }, 400);
  }
  if (message === "Label color must be a 6-digit hex color") {
    return c.json({ error: "color must be a 6-digit hex value like #3b82f6" }, 400);
  }
  return c.json({ error: message }, 400);
}

export function projectErrorResponse(c: Context, err: unknown): Response | null {
  if (err instanceof ProjectInstructionsRevisionConflictError) {
    return c.json({
      error: "project instructions changed after they were loaded",
      code: err.code,
      expected_revision: err.expectedRevision,
      current_revision: err.currentRevision,
    }, 409);
  }
  if (!(err instanceof Error)) return null;
  if (err.message === "Project title is required") return c.json({ error: "title is required" }, 400);
  if (err.message.startsWith("Project not found:")) return c.json({ error: "project not found" }, 404);
  // Default-assignee resolution failures (resolveAssigneeRef) are client errors.
  if (
    /^(Agent|Member|Squad|Assignee) not found:/.test(err.message)
    || err.message.startsWith("Ambiguous assignee reference:")
    || err.message === "Assignee id is required when assignee type is provided"
  ) {
    return c.json({ error: err.message }, 400);
  }
  return null;
}

export function projectSearchErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  if (err.message === "q parameter is required") return c.json({ error: "q parameter is required" }, 400);
  return null;
}

export function projectResourceCompatibilityResponse(resource: MultiremiProjectResource): Record<string, unknown> {
  return {
    id: resource.id,
    project_id: resource.projectId,
    workspace_id: resource.workspaceId,
    resource_type: resource.resourceType,
    resource_ref: projectResourceRefCompatibilityResponse(resource),
    label: resource.label,
    position: resource.position,
    created_at: resource.createdAt,
    created_by: resource.createdBy,
  };
}

function projectResourceRefCompatibilityResponse(resource: MultiremiProjectResource): Record<string, unknown> {
  if (resource.resourceType === "github_repo") {
    const url = String(resource.resourceRef.url ?? "");
    const defaultBranchHint = String(resource.resourceRef.default_branch_hint ?? resource.resourceRef.defaultBranchHint ?? "").trim();
    return defaultBranchHint ? { url, default_branch_hint: defaultBranchHint } : { url };
  }
  if (resource.resourceType === "local_directory") {
    const localPath = String(resource.resourceRef.local_path ?? resource.resourceRef.localPath ?? "");
    const daemonId = String(resource.resourceRef.daemon_id ?? resource.resourceRef.daemonId ?? "");
    const label = String(resource.resourceRef.label ?? "").trim();
    return label
      ? { local_path: localPath, daemon_id: daemonId, label }
      : { local_path: localPath, daemon_id: daemonId };
  }
  if (resource.resourceType === "project_ref") {
    return { project_id: String(resource.resourceRef.projectId ?? resource.resourceRef.project_id ?? "") };
  }
  return resource.resourceRef;
}

export function projectResourceErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  const message = err.message;
  if (message.startsWith("Project not found")) return c.json({ error: "project not found" }, 404);
  if (message.startsWith("Project resource not found")) return c.json({ error: "project resource not found" }, 404);
  if (message.includes("UNIQUE constraint failed") || message.includes("duplicate key value violates unique constraint")) {
    return c.json({ error: "this resource is already attached to the project" }, 409);
  }
  if (
    message === "this daemon already has a local_directory attached to the project; remove it before adding another"
    || message === "another local_directory on this daemon is already attached to the project"
  ) {
    return c.json({ error: message }, 409);
  }
  if (
    message.includes("resource_type is required")
    || message.includes("unknown resource_type")
    || message.includes("github_repo")
    || message.includes("local_directory")
    || message.includes("project_ref")
    || message === "position must be an integer"
  ) {
    return c.json({ error: message }, 400);
  }
  return null;
}

export function projectDocCompatibilityResponse(doc: MultiremiProjectDoc): Record<string, unknown> {
  return {
    id: doc.id,
    project_id: doc.projectId,
    workspace_id: doc.workspaceId,
    kind: doc.kind,
    slug: doc.slug,
    title: doc.title,
    summary: doc.summary,
    body: doc.body,
    tags: doc.tags,
    pinned: doc.pinned,
    refs: doc.refs.map((ref) => ({ type: ref.type, value: ref.value })),
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
}

export function projectDocIndexEntryCompatibilityResponse(entry: MultiremiProjectDocIndexEntry): Record<string, unknown> {
  return {
    id: entry.id,
    slug: entry.slug,
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    kind: entry.kind,
    pinned: entry.pinned,
    source_issue_id: entry.sourceIssueId,
    updated_at: entry.updatedAt,
  };
}

export function projectDocRevisionCompatibilityResponse(revision: MultiremiProjectDocRevision): Record<string, unknown> {
  return {
    id: revision.id,
    doc_id: revision.docId,
    version: revision.version,
    title: revision.title,
    summary: revision.summary,
    body: revision.body,
    author_type: revision.authorType,
    author_id: revision.authorId,
    created_at: revision.createdAt,
  };
}

export function projectDocErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  const message = err.message;
  if (message.startsWith("Project not found")) return c.json({ error: "project not found" }, 404);
  if (message.startsWith("Project doc not found")) return c.json({ error: "project doc not found" }, 404);
  if (message === "title is required" || message.startsWith("unknown kind")) {
    return c.json({ error: message }, 400);
  }
  if (message === "project doc version conflict") return c.json({ error: message }, 409);
  // Both dialects report the (project_id, slug) UNIQUE violation differently.
  if (message.includes("UNIQUE constraint failed") || message.includes("duplicate key value violates unique constraint")) {
    return c.json({ error: "a doc with this slug already exists" }, 409);
  }
  return null;
}
