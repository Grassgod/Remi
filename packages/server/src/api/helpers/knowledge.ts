import type { Context } from "hono";
import type {
  CreateProjectDocInput,
  CreateRepositoryWikiDocInput,
  MultiremiAgent,
  MultiremiIssue,
  MultiremiKnowledgeCompilationMode,
  MultiremiKnowledgeCompilationRun,
  MultiremiKnowledgeScope,
  MultiremiKnowledgeSubmission,
  MultiremiProjectDoc,
  MultiremiRepositoryWikiDoc,
  MultiremiTask,
  UpdateProjectDocInput,
  UpdateRepositoryWikiDocInput,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { currentTaskAccessToken } from "../wire/index.js";
import { agentHasKnowledgePublishCapability } from "@multiremi/knowledge/capability.js";
import { resolveTaskRepositoryWikiRepositories } from "@multiremi/repository-wiki/task-scope.js";

export interface KnowledgeWriteActor {
  kind: "member" | "agent";
  task: MultiremiTask | null;
  issue: MultiremiIssue | null;
  agent: MultiremiAgent | null;
  canPublish: boolean;
  sourceRevision: string | null;
}

export class KnowledgeWritePolicyError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 403) {
    super(message);
  }
}

export function resolveKnowledgeWriteActor(c: Context, store: MultiremiStore): KnowledgeWriteActor {
  const token = currentTaskAccessToken(c);
  if (!token) {
    return {
      kind: "member",
      task: null,
      issue: null,
      agent: null,
      canPublish: true,
      sourceRevision: null,
    };
  }
  if (!token.taskId || !token.agentId) {
    throw new KnowledgeWritePolicyError("task token is missing its bound task or agent");
  }
  const task = store.getTask(token.taskId);
  const agent = store.getAgent(token.agentId);
  if (!task || task.agentId !== token.agentId || task.workspaceId !== token.workspaceId) {
    throw new KnowledgeWritePolicyError("task token binding is invalid");
  }
  if (!agent || agent.workspaceId !== token.workspaceId) {
    throw new KnowledgeWritePolicyError("task token agent is unavailable");
  }
  return {
    kind: "agent",
    task,
    issue: task.issueId ? store.getIssue(task.issueId) : null,
    agent,
    canPublish: agentHasKnowledgePublishCapability(store, agent),
    sourceRevision: task.scmRevision ?? null,
  };
}

export function assertProjectKnowledgeTarget(actor: KnowledgeWriteActor, projectId: string): void {
  if (!actor.task) return;
  if (!actor.issue || actor.issue.projectId !== projectId) {
    throw new KnowledgeWritePolicyError("task knowledge target does not match its issue project");
  }
}

export function assertRepositoryKnowledgeTarget(
  actor: KnowledgeWriteActor,
  store: MultiremiStore,
  repositoryId: string,
): void {
  if (!actor.task) return;
  const task = store.getTaskWithAgent(actor.task.id);
  if (!task || !resolveTaskRepositoryWikiRepositories(store, task).some((repository) => repository.id === repositoryId)) {
    throw new KnowledgeWritePolicyError("task knowledge target does not match its repository scope");
  }
}

export function createProjectMutationSubmission(input: {
  store: MultiremiStore;
  actor: KnowledgeWriteActor;
  projectId: string;
  operation: "create" | "update" | "delete";
  body: CreateProjectDocInput | UpdateProjectDocInput;
  current?: MultiremiProjectDoc | null;
}): { submission: MultiremiKnowledgeSubmission; deduplicated: boolean } {
  const kind = input.current?.kind ?? (input.body as CreateProjectDocInput).kind ?? "wiki";
  const scope: MultiremiKnowledgeScope = kind === "memory" ? "memory" : "project_wiki";
  const proposedPath = clean(input.body.path) ?? input.current?.path ?? null;
  const proposedSlug = clean((input.body as CreateProjectDocInput).slug) ?? input.current?.slug ?? null;
  const proposedBody = input.operation === "delete"
    ? input.current?.body ?? ""
    : input.body.body === undefined
    ? input.current?.body ?? ""
    : String(input.body.body ?? "");
  return input.store.createKnowledgeSubmission({
    workspaceId: input.actor.task!.workspaceId,
    projectId: input.projectId,
    scope,
    sourceType: "agent",
    proposedPath,
    proposedSlug,
    body: proposedBody,
    patch: JSON.stringify({ operation: input.operation, input: safeProjectMutation(input.body) }),
    baseRevision: input.current ? String(input.current.version) : null,
    sourceTaskId: input.actor.task!.id,
    sourceIssueId: input.actor.issue?.id ?? null,
    sourceRevision: input.actor.sourceRevision,
    authorAgentId: input.actor.agent!.id,
  });
}

export function createRepositoryMutationSubmission(input: {
  store: MultiremiStore;
  actor: KnowledgeWriteActor;
  workspaceId: string;
  repositoryId: string;
  operation: "create" | "update" | "delete";
  body: CreateRepositoryWikiDocInput | UpdateRepositoryWikiDocInput;
  current?: MultiremiRepositoryWikiDoc | null;
}): { submission: MultiremiKnowledgeSubmission; deduplicated: boolean } {
  const proposedPath = clean(input.body.path ?? input.body.slug) ?? input.current?.path ?? null;
  const proposedBody = input.operation === "delete"
    ? input.current?.body ?? ""
    : input.body.body === undefined
    ? input.current?.body ?? ""
    : String(input.body.body ?? "");
  return input.store.createKnowledgeSubmission({
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    scope: "repository_wiki",
    sourceType: "agent",
    proposedPath,
    body: proposedBody,
    patch: JSON.stringify({ operation: input.operation, input: safeRepositoryMutation(input.body) }),
    baseRevision: input.current ? String(input.current.version) : null,
    sourceTaskId: input.actor.task!.id,
    sourceIssueId: input.actor.issue?.id ?? null,
    sourceRevision: input.actor.sourceRevision,
    authorAgentId: input.actor.agent!.id,
  });
}

export function createFormalWriteRun(input: {
  store: MultiremiStore;
  actor: KnowledgeWriteActor;
  workspaceId: string;
  projectId?: string | null;
  repositoryId?: string | null;
  scope: MultiremiKnowledgeScope;
  dedupeKey?: string | null;
}): MultiremiKnowledgeCompilationRun {
  const mode: MultiremiKnowledgeCompilationMode = input.actor.kind === "member"
    ? "manual_edit"
    : input.scope === "repository_wiki"
    ? "repository_update"
    : input.scope === "memory"
    ? "memory_curate"
    : "issue_ingest";
  return input.store.createKnowledgeCompilationRun({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    taskId: input.actor.task?.id,
    agentId: input.actor.agent?.id,
    autopilotRunId: input.actor.task?.autopilotRunId,
    mode,
    status: "validating",
    dedupeKey: input.dedupeKey,
  }).run;
}

export function rawSubmissionResponse(result: {
  submission: MultiremiKnowledgeSubmission;
  deduplicated: boolean;
}): Record<string, unknown> {
  return {
    submission_id: result.submission.id,
    status: result.submission.status,
    scope: result.submission.scope,
    deduplicated: result.deduplicated,
    message: "waiting for Atlas compilation",
  };
}

export function knowledgePolicyErrorResponse(c: Context, error: unknown): Response | null {
  if (error instanceof KnowledgeWritePolicyError) {
    return c.json({ error: error.message }, error.status);
  }
  return null;
}

function safeProjectMutation(input: CreateProjectDocInput | UpdateProjectDocInput): Record<string, unknown> {
  return compact({
    kind: (input as CreateProjectDocInput).kind,
    slug: input.slug,
    path: input.path,
    title: input.title,
    summary: input.summary,
    body: input.body,
    tags: input.tags,
    pinned: input.pinned,
    refs: input.refs,
    expected_version: (input as UpdateProjectDocInput).expectedVersion
      ?? (input as UpdateProjectDocInput).expected_version,
  });
}

function safeRepositoryMutation(
  input: CreateRepositoryWikiDocInput | UpdateRepositoryWikiDocInput,
): Record<string, unknown> {
  return compact({
    slug: input.slug,
    path: input.path,
    title: input.title,
    summary: input.summary,
    body: input.body,
    tags: input.tags,
    refs: input.refs,
    source_revision: input.sourceRevision ?? input.source_revision,
    expected_version: (input as UpdateRepositoryWikiDocInput).expectedVersion
      ?? (input as UpdateRepositoryWikiDocInput).expected_version,
  });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function clean(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}
