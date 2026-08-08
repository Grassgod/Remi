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
} from "@multiremi/contracts/types.js";
import { denyCurrentUserWorkspaceAccess, denyTaskTokenProjectAccess } from "./auth-guards.js";
import { issueSubscriberCaller } from "./issues.js";

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
