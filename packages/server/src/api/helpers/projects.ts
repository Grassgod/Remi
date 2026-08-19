// Project resource and project-doc request plumbing: the mutation guards and the create/update
// input builders that fold in the caller and the resolved workspace.
import type { Context } from "hono";
import { MultiremiStore } from "@multiremi/store/store.js";
import { currentTaskAccessToken } from "../wire/index.js";
import type {
  CreateProjectDocInput,
  MultiremiProject,
  MultiremiProjectResource,
  UpdateProjectDocInput,
  UpdateProjectInput,
} from "@multiremi/contracts/types.js";
import { denyCurrentUserWorkspaceAccess, denyTaskTokenProjectAccess } from "./auth-guards.js";
import { issueSubscriberCaller } from "./issues.js";

export const MAX_PROJECT_INSTRUCTIONS_LENGTH = 4_000;

export function validateProjectInstructions(c: Context, value: unknown): Response | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return c.json({ error: "instructions must be a string" }, 400);
  if (Array.from(value).length > MAX_PROJECT_INSTRUCTIONS_LENGTH) {
    return c.json({ error: `instructions must be ${MAX_PROJECT_INSTRUCTIONS_LENGTH} characters or fewer` }, 400);
  }
  return null;
}

export function validateProjectInstructionsUpdate(c: Context, input: UpdateProjectInput): Response | null {
  const instructionsError = validateProjectInstructions(c, input.instructions);
  if (instructionsError || input.instructions === undefined) return instructionsError;
  if (
    input.expectedInstructionsRevision !== undefined
    && input.expected_instructions_revision !== undefined
    && input.expectedInstructionsRevision !== input.expected_instructions_revision
  ) {
    return c.json({ error: "expected instructions revisions must match" }, 400);
  }
  const expectedRevision = input.expectedInstructionsRevision ?? input.expected_instructions_revision;
  if (expectedRevision === undefined) {
    return c.json({ error: "expected_instructions_revision is required when instructions is provided" }, 400);
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return c.json({ error: "expected_instructions_revision must be a non-negative integer" }, 400);
  }
  return null;
}

export function loadProjectResourceForMutation(
  c: Context,
  store: MultiremiStore,
  projectId: string,
  resourceId: string,
): MultiremiProjectResource | Response {
  if (!store.getProject(projectId)) return c.json({ error: "project not found" }, 404);
  const resource = store.getProjectResource(resourceId);
  if (!resource || resource.projectId !== projectId) return c.json({ error: "project resource not found" }, 404);
  return resource;
}

export function loadProjectForDocs(c: Context, store: MultiremiStore, projectId: string): MultiremiProject | Response {
  const project = store.getProject(projectId);
  if (!project) return c.json({ error: "project not found" }, 404);
  const denied = denyCurrentUserWorkspaceAccess(c, store, project.workspaceId);
  if (denied) return denied;
  const taskDenied = denyTaskTokenProjectAccess(c, store, project.id);
  if (taskDenied) return taskDenied;
  return project;
}

export function loadProjectForHumanMutation(
  c: Context,
  store: MultiremiStore,
  projectId: string,
): MultiremiProject | Response {
  const project = loadProjectForDocs(c, store, projectId);
  if (project instanceof Response) return project;
  if (currentTaskAccessToken(c)) {
    return c.json({ error: "this endpoint is only available to human actors" }, 403);
  }
  return project;
}

/**
 * Stamps a doc write with who made it: a task token writes as its agent,
 * everyone else as the requesting member. Provenance is never taken from the
 * body — the task id comes from the caller's own task token and the issue
 * behind it is resolved server-side, so a caller can neither claim someone
 * else's task nor smuggle a foreign issue id onto the doc. A member has no
 * task, so member writes carry no provenance at all. `id` is dropped for the
 * same reason: the primary key is the server's to mint. Both spellings are
 * written because the store falls back camel → snake.
 */
export function projectDocCreateInput(c: Context, store: MultiremiStore, input: CreateProjectDocInput): CreateProjectDocInput {
  const caller = issueSubscriberCaller(c);
  const sourceTaskId = currentTaskAccessToken(c)?.taskId ?? null;
  const task = sourceTaskId ? store.getTask(sourceTaskId) : null;
  const sourceIssueId = task?.issueId ?? null;
  return {
    ...input,
    id: undefined,
    authorType: caller.actorType,
    author_type: caller.actorType,
    authorId: caller.actorId,
    author_id: caller.actorId,
    sourceTaskId,
    source_task_id: sourceTaskId,
    sourceIssueId,
    source_issue_id: sourceIssueId,
  };
}

export function projectDocUpdateInput(c: Context, input: UpdateProjectDocInput): UpdateProjectDocInput {
  const caller = issueSubscriberCaller(c);
  return {
    ...input,
    updatedByType: caller.actorType,
    updated_by_type: caller.actorType,
    updatedById: caller.actorId,
    updated_by_id: caller.actorId,
  };
}
