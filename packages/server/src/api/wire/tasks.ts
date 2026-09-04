// Wire serializers for the tasks domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import type {
  MultiremiChatMessage,
  MultiremiDaemonHeartbeatAck,
  MultiremiTask,
  MultiremiTaskMessage,
  MultiremiTaskQueueBlocker,
  MultiremiTaskTriggerMetadata,
  MultiremiTaskWithAgent,
} from "@multiremi/contracts/types.js";

type InternalTaskField =
  | "delegationId"
  | "delegation_id"
  | "delegatedByAgentId"
  | "delegated_by_agent_id"
  | "issueCreationRestricted"
  | "issue_creation_restricted";

export function taskPublicResponse<T extends MultiremiTask>(task: T): Omit<T, InternalTaskField> {
  const {
    delegationId: _delegationId,
    delegation_id: _delegationIdSnake,
    delegatedByAgentId: _delegatedByAgentId,
    delegated_by_agent_id: _delegatedByAgentIdSnake,
    issueCreationRestricted: _issueCreationRestricted,
    issue_creation_restricted: _issueCreationRestrictedSnake,
    ...publicTask
  } = task;
  return publicTask;
}
import type { MultiremiStore } from "@multiremi/store/store.js";
import { autopilotRunSourceRevision } from "@multiremi/store/repos/autopilots-repo.js";
import { createLogger } from "@shared/logger.js";
import { readWorkspacePromptSettings } from "../../prompts/workspace-settings.js";
import { resolveRepositoryWikiAutomation } from "../../repository-wiki/automation.js";
import { daemonClaimAgentResponse } from "./agents.js";
import { issueCompatibilityResponse } from "./issues.js";
import { attachmentCompatibilityResponse } from "./attachments.js";
import {
  projectCompatibilityResponse,
  projectDocCompatibilityResponse,
  projectResourceCompatibilityResponse,
} from "./projects.js";

const log = createLogger("multiremi-api");

export function daemonHeartbeatHttpResponse(ack: MultiremiDaemonHeartbeatAck): Record<string, unknown> {
  const response: Record<string, unknown> = { status: ack.status };
  if (ack.pending_update) response.pending_update = ack.pending_update;
  if (ack.pending_model_list) response.pending_model_list = ack.pending_model_list;
  if (ack.pending_local_skills) response.pending_local_skills = ack.pending_local_skills;
  if (ack.pending_directory_scan) response.pending_directory_scan = ack.pending_directory_scan;
  if (ack.pending_local_skill_import) response.pending_local_skill_import = ack.pending_local_skill_import;
  if (ack.pending_local_skill_imports?.length) response.pending_local_skill_imports = ack.pending_local_skill_imports;
  if (ack.pending_command) response.pending_command = ack.pending_command;
  if (ack.ssh_mesh) response.ssh_mesh = ack.ssh_mesh;
  if (ack.drain) response.drain = ack.drain;
  return response;
}

export function taskMessageRealtimePayload(message: MultiremiTaskMessage, task: MultiremiTask): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    task_id: message.taskId,
    issue_id: task.issueId,
    seq: message.seq,
    type: message.type,
    created_at: message.createdAt,
  };
  if (task.chatSessionId) payload.chat_session_id = task.chatSessionId;
  if (task.issueSessionId) payload.issue_session_id = task.issueSessionId;
  if (message.tool) payload.tool = message.tool;
  if (message.content) payload.content = message.content;
  if (message.input) payload.input = message.input;
  if (message.output) payload.output = message.output;
  if (message.toolCallId) payload.tool_call_id = message.toolCallId;
  if (message.status) payload.status = message.status;
  if (message.meta) payload.meta = message.meta;
  return payload;
}

export function taskRealtimePayload(task: MultiremiTask): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    task_id: task.id,
    agent_id: task.agentId,
    issue_id: task.issueId,
    runtime_id: task.runtimeId,
    workspace_id: task.workspaceId,
    status: task.status,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
  if (task.chatSessionId) payload.chat_session_id = task.chatSessionId;
  if (task.autopilotRunId) payload.autopilot_run_id = task.autopilotRunId;
  if (task.waitReason) payload.wait_reason = task.waitReason;
  if (task.sessionId) payload.session_id = task.sessionId;
  if (task.workDir) payload.work_dir = task.workDir;
  if (task.error) payload.error = task.error;
  if (task.failureReason) payload.failure_reason = task.failureReason;
  if (task.result) payload.result = task.result;
  return payload;
}

export function taskCompatibilityResponse(
  task: MultiremiTask,
  triggerMetadata: MultiremiTaskTriggerMetadata | null = null,
  queueBlocker: MultiremiTaskQueueBlocker | null = null,
): Omit<
  MultiremiTask,
  "result" | InternalTaskField
> & {
  result: unknown | null;
  agent_id: string;
  runtime_id: string | null;
  issue_id: string | null;
  issue_session_id: string | null;
  chat_session_id: string | null;
  autopilot_run_id: string | null;
  trigger_comment_id: string | null;
  trigger_summary: string | null;
  trigger_thread_id?: string;
  trigger_comment_content?: string;
  trigger_author_type?: string;
  trigger_author_name?: string;
  new_comment_count?: number;
  new_comments_since?: string;
  workspace_id: string;
  max_attempts: number;
  parent_task_id: string | null;
  failure_reason: string | null;
  branch_name: string | null;
  session_id: string | null;
  work_dir: string | null;
  progress_summary: string | null;
  progress_step: number | null;
  progress_total: number | null;
  wait_reason: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
} {
  const publicTask = taskPublicResponse(task);
  const response: Omit<
    MultiremiTask,
    "result" | InternalTaskField
  > & {
    result: unknown | null;
    agent_id: string;
    runtime_id: string | null;
    issue_id: string | null;
    issue_session_id: string | null;
    chat_session_id: string | null;
    autopilot_run_id: string | null;
    trigger_comment_id: string | null;
    trigger_summary: string | null;
    trigger_thread_id?: string;
    trigger_comment_content?: string;
    trigger_author_type?: string;
    trigger_author_name?: string;
    new_comment_count?: number;
    new_comments_since?: string;
    workspace_id: string;
    max_attempts: number;
    parent_task_id: string | null;
    failure_reason: string | null;
    branch_name: string | null;
    session_id: string | null;
    work_dir: string | null;
    progress_summary: string | null;
    progress_step: number | null;
    progress_total: number | null;
    wait_reason: string | null;
    created_at: string;
    updated_at: string;
    dispatched_at: string | null;
    started_at: string | null;
    completed_at: string | null;
    failed_at: string | null;
    cancelled_at: string | null;
  } = {
    // These trigger compat snake-fields are typed `string | null` on MultiremiTask
    // but are never set on stored tasks; they are assigned below from triggerMetadata
    // as `string`. Omit them from the spread's type so the strict response type holds.
    ...(publicTask as Omit<
      typeof publicTask,
      "trigger_thread_id" | "trigger_comment_content" | "trigger_author_type" | "trigger_author_name" | "new_comment_count" | "new_comments_since"
    >),
    result: taskResultWireValue(task),
    agent_id: task.agentId,
    runtime_id: task.runtimeId,
    issue_id: task.issueId,
    issue_session_id: task.issueSessionId,
    chat_session_id: task.chatSessionId,
    autopilot_run_id: task.autopilotRunId,
    trigger_comment_id: task.triggerCommentId,
    trigger_summary: task.triggerSummary,
    workspace_id: task.workspaceId,
    max_attempts: task.maxAttempts,
    parent_task_id: task.parentTaskId,
    failure_reason: task.failureReason,
    branch_name: task.branchName,
    session_id: task.sessionId,
    work_dir: task.workDir,
    progress_summary: task.progressSummary,
    progress_step: task.progressStep,
    progress_total: task.progressTotal,
    wait_reason: task.waitReason,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    dispatched_at: task.dispatchedAt,
    started_at: task.startedAt,
    completed_at: task.completedAt,
    failed_at: task.failedAt,
    cancelled_at: task.cancelledAt,
  };
  if (triggerMetadata?.triggerThreadId) response.trigger_thread_id = triggerMetadata.triggerThreadId;
  if (triggerMetadata?.triggerCommentContent) response.trigger_comment_content = triggerMetadata.triggerCommentContent;
  if (triggerMetadata?.triggerAuthorType) response.trigger_author_type = triggerMetadata.triggerAuthorType;
  if (triggerMetadata?.triggerAuthorName) response.trigger_author_name = triggerMetadata.triggerAuthorName;
  if (triggerMetadata?.newCommentCount) {
    response.new_comment_count = triggerMetadata.newCommentCount;
    if (triggerMetadata.newCommentsSince) response.new_comments_since = triggerMetadata.newCommentsSince;
  }
  if (queueBlocker) {
    (response as Record<string, unknown>).queue_blocker = {
      task_id: queueBlocker.taskId,
      agent_id: queueBlocker.agentId,
      agent_name: queueBlocker.agentName,
      issue_session_id: queueBlocker.issueSessionId,
      issue_session_title: queueBlocker.issueSessionTitle,
      reason: queueBlocker.reason,
    };
  }
  return response;
}

export function daemonTaskWireResponse(
  task: MultiremiTask & { issue?: MultiremiTaskWithAgent["issue"] },
  triggerMetadata: MultiremiTaskTriggerMetadata | null = null,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: task.id,
    agent_id: task.agentId,
    runtime_id: task.runtimeId ?? "",
    issue_id: task.issueId ?? "",
    holds_workspace: task.holdsWorkspace,
    workspace_id: task.workspaceId,
    status: task.status,
    priority: task.priority,
    dispatched_at: task.dispatchedAt,
    started_at: task.startedAt,
    completed_at: task.completedAt,
    result: taskResultWireValue(task),
    error: task.error,
    attempt: task.attempt,
    max_attempts: task.maxAttempts,
    created_at: task.createdAt,
    kind: daemonTaskKind(task),
  };
  if (task.failureReason) response.failure_reason = task.failureReason;
  if (task.parentTaskId) response.parent_task_id = task.parentTaskId;
  if (task.waitReason) response.wait_reason = task.waitReason;
  if (task.progressSummary) response.progress_summary = task.progressSummary;
  if (task.progressStep != null) response.progress_step = task.progressStep;
  if (task.progressTotal != null) response.progress_total = task.progressTotal;
  if (task.chatSessionId) response.chat_session_id = task.chatSessionId;
  if (task.issueSessionId) response.issue_session_id = task.issueSessionId;
  if (task.issueSessionGeneration != null) response.issue_session_generation = task.issueSessionGeneration;
  if (task.autopilotRunId) response.autopilot_run_id = task.autopilotRunId;
  if (task.triggerCommentId) response.trigger_comment_id = task.triggerCommentId;
  if (task.triggerSummary) response.trigger_summary = task.triggerSummary;
  if (task.executionFingerprint || task.pluginSnapshot.length) response.plugin_snapshot = task.pluginSnapshot;
  if (task.executionFingerprint) response.execution_fingerprint = task.executionFingerprint;
  if (triggerMetadata?.triggerThreadId) response.trigger_thread_id = triggerMetadata.triggerThreadId;
  if (triggerMetadata?.triggerCommentContent) response.trigger_comment_content = triggerMetadata.triggerCommentContent;
  if (triggerMetadata?.triggerAuthorType) response.trigger_author_type = triggerMetadata.triggerAuthorType;
  if (triggerMetadata?.triggerAuthorName) response.trigger_author_name = triggerMetadata.triggerAuthorName;
  if (triggerMetadata?.newCommentCount) {
    response.new_comment_count = triggerMetadata.newCommentCount;
    if (triggerMetadata.newCommentsSince) response.new_comments_since = triggerMetadata.newCommentsSince;
  }
  if (task.workDir) {
    response.work_dir = task.workDir;
    const relative = daemonRelativeWorkDir(task.workDir, task.workspaceId, task.id);
    if (relative) response.relative_work_dir = relative;
  }
  return response;
}

export function daemonTaskClaimResponse(
  store: MultiremiStore,
  task: MultiremiTaskWithAgent,
  triggerMetadata: MultiremiTaskTriggerMetadata | null = null,
): Record<string, unknown> {
  const response = daemonTaskWireResponse(task, triggerMetadata);
  let projectionMode: "bootstrap" | "delta" | null = null;
  response.prompt = task.prompt;
  if (task.sessionId) {
    response.session_id = task.sessionId;
    response.prior_session_id = task.sessionId;
  }
  if (task.branchName) response.branch_name = task.branchName;
  if (task.workDir) response.prior_work_dir = task.workDir;
  if (task.agent) response.agent = daemonClaimAgentResponse(task.agent);
  if (task.issue) {
    response.issue = {
      ...issueCompatibilityResponse(task.issue, { includeLabels: true }),
      attachments: store.listAttachmentsForIssue(task.issue.id).map(attachmentCompatibilityResponse),
    };
  }
  if (task.triggerCommentId && store.getIssueComment(task.triggerCommentId)) {
    response.trigger_comment_attachments = store.listAttachmentsForComment(task.triggerCommentId)
      .map(attachmentCompatibilityResponse);
  }
  if (task.issueSessionId || task.chatSessionId) {
    const projection = store.buildTaskSessionProjection(task.id);
    if (projection) {
      projectionMode = projection.mode;
      response.session_projection = {
        session_id: projection.sessionId,
        target_agent_id: projection.targetAgentId,
        mode: projection.mode,
        from_seq: projection.fromSeq,
        to_seq: projection.toSeq,
        jsonl: projection.jsonl,
        truncated: projection.truncated,
        omitted_events: projection.omittedEvents,
        estimated_tokens: projection.estimatedTokens,
      };
    }
  }
  if (task.issueSessionId) {
    const issueSession = store.getIssueSession(task.issueSessionId);
    if (issueSession) {
      response.issue_session = issueSession;
      if (task.issueSessionGeneration == null) {
        const lane = store.getSessionAgentLane(task.issueSessionId, task.agentId);
        if (lane) response.issue_session_generation = lane.generation;
      }
    }
    if (task.issueId) {
      const since = projectionMode === "delta"
        ? latestRecordedPromptForLane(store, task)?.assembledAt ?? null
        : null;
      response.issue_session_results = store.listIssueSessionResults(task.issueId)
        .filter((result) => result.sourceSessionId !== task.issueSessionId)
        // Millisecond timestamps can tie. Re-sending one result is safer than
        // dropping a result published at the exact prompt assembly instant.
        .filter((result) => !since || result.createdAt >= since)
        .map((result) => ({
          id: result.id,
          source_session_id: result.sourceSessionId,
          title: result.title,
          body: result.body,
          metadata: result.metadata,
          created_at: result.createdAt,
        }));
    }
  }
  if (task.project) {
    response.project_id = task.project.id;
    response.project_title = task.project.title;
    response.project = projectCompatibilityResponse(task.project);
  }
  if (task.projectResources.length) {
    response.project_resources = task.projectResources.map(projectResourceCompatibilityResponse);
  }
  if (task.projectWikiDocs?.length) {
    response.project_wiki_docs = task.projectWikiDocs.map(projectDocCompatibilityResponse);
  }
  if (task.repositoryWikiContexts?.length) {
    response.repository_wiki_contexts = task.repositoryWikiContexts.map((context) => ({
      repository: {
        id: context.repository.id,
        name: context.repository.name,
        url: context.repository.url,
        default_branch: context.repository.defaultBranch,
      },
      docs: context.docs.map((doc) => ({
        id: doc.id,
        repository_id: doc.repositoryId,
        workspace_id: doc.workspaceId,
        path: doc.path,
        slug: doc.slug,
        title: doc.title,
        summary: doc.summary,
        body: doc.body,
        tags: doc.tags,
        refs: doc.refs,
        source_revision: doc.sourceRevision,
        status: doc.status,
        status_message: doc.statusMessage,
        sync_status: doc.syncStatus,
        sync_error: doc.syncError,
        version: doc.version,
        updated_at: doc.updatedAt,
      })),
    }));
  }
  if (task.projectContexts.length) {
    response.project_contexts = task.projectContexts.map((context) => ({
      project: projectCompatibilityResponse(context.project),
      resources: context.resources.map(projectResourceCompatibilityResponse),
      docs: context.docs.map(projectDocCompatibilityResponse),
      repos: context.repos.map((repo) => ({
        url: repo.url,
        ...(repo.description ? { description: repo.description } : {}),
      })),
    }));
  }
  if (task.repos.length) {
    response.repos = task.repos.map((repo) => ({
      url: repo.url,
      ...(repo.description ? { description: repo.description } : {}),
    }));
  }
  appendDaemonClaimSquadContext(store, task, response);
  appendDaemonClaimExecutionContext(store, task, response);
  return response;
}

function latestRecordedPromptForLane(
  store: MultiremiStore,
  task: MultiremiTaskWithAgent,
) {
  if (!task.issueId || !task.issueSessionId) return null;
  let latest: ReturnType<MultiremiStore["getTaskPrompt"]> = null;
  for (const candidate of store.listTasksForIssue(task.issueId)) {
    if (
      candidate.id === task.id
      || candidate.agentId !== task.agentId
      || candidate.issueSessionId !== task.issueSessionId
    ) continue;
    const artifact = store.getTaskPrompt(candidate.id);
    if (artifact && (!latest || artifact.assembledAt > latest.assembledAt)) latest = artifact;
  }
  // Upgraded installations may have a resumable provider lane but no prompt
  // audit row for its prior task. The caller then includes all published
  // results once so an upgrade cannot silently lose collaboration context.
  return latest;
}

function appendDaemonClaimSquadContext(
  store: MultiremiStore,
  task: MultiremiTaskWithAgent,
  response: Record<string, unknown>,
): void {
  if (task.issue?.assigneeType !== "squad" || !task.issue.assigneeId || !task.agent) return;
  const squad = store.getSquad(task.issue.assigneeId);
  if (!squad || squad.archivedAt || squad.leaderId !== task.agent.id) return;
  const members = store.listSquadMembers(squad.id)
    .filter((member) => member.memberType === "agent")
    .map((member) => ({ member, agent: store.getAgent(member.memberId) }))
    .filter(({ agent }) => Boolean(agent && !agent.archivedAt))
    .map(({ member, agent }) => ({
      agentId: agent!.id,
      name: agent!.name,
      role: member.role,
      description: agent!.description,
    }));
  response.squad_context = {
    id: squad.id,
    name: squad.name,
    leaderAgentId: task.agent.id,
    instructions: squad.instructions,
    members,
  };
}

function appendDaemonClaimExecutionContext(
  store: MultiremiStore,
  task: MultiremiTaskWithAgent,
  response: Record<string, unknown>,
): void {
  appendDaemonClaimWorkspaceContext(store, task, response);
  appendDaemonClaimChatContext(store, task, response);
  appendDaemonClaimBoundIssue(store, task, response);
  appendDaemonClaimBoundIssueUpdates(store, task, response);
  appendDaemonClaimAutopilotContext(store, task, response);

  const quickCreatePrompt = daemonQuickCreatePrompt(task);
  if (quickCreatePrompt) response.quick_create_prompt = quickCreatePrompt;
}

function appendDaemonClaimBoundIssue(
  store: MultiremiStore,
  task: MultiremiTaskWithAgent,
  response: Record<string, unknown>,
): void {
  if (!task.chatSessionId) return;
  try {
    const chat = store.getChatSession(task.chatSessionId);
    const issueId = task.issueId ?? chat?.issueId ?? null;
    const issue = issueId ? store.getIssue(issueId) : null;
    if (!issue) return;
    response.bound_issue = {
      id: issue.id,
      key: issue.key,
      title: issue.title,
      status: issue.status,
    };
  } catch (error) {
    log.debug(
      `Failed to load bound Issue for claimed task ${task.id}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function appendDaemonClaimWorkspaceContext(store: MultiremiStore, task: MultiremiTaskWithAgent, response: Record<string, unknown>): void {
  const workspace = store.getWorkspace(task.workspaceId);
  if (workspace?.context?.trim()) response.workspace_context = workspace.context.trim();
  if (workspace) {
    const prompts = readWorkspacePromptSettings(workspace);
    if (prompts.bootstrapPrompt.trim()) response.workspace_bootstrap_prompt = prompts.bootstrapPrompt.trim();
    if (prompts.deltaPrompt.trim()) response.workspace_delta_prompt = prompts.deltaPrompt.trim();
  }

  // Read at claim time so a saved workspace env applies to the next dispatched
  // task without a daemon restart. Precedence is resolved daemon-side:
  // agent customEnv > workspace env > daemon machine env.
  const workspaceEnv = store.getWorkspaceEnv(task.workspaceId);
  if (Object.keys(workspaceEnv).length) response.workspace_env = workspaceEnv;

  const runtime = task.runtimeId ? store.getRuntime(task.runtimeId) : null;
  const owner = runtime?.ownerId ? store.getUser(runtime.ownerId) : null;
  const requestingUserName = task.requestingUserName?.trim() || owner?.name?.trim();
  const requestingUserProfile = task.requestingUserProfileDescription?.trim() || owner?.profileDescription?.trim();
  if (requestingUserName) response.requesting_user_name = requestingUserName;
  if (requestingUserProfile) response.requesting_user_profile_description = requestingUserProfile;
}

function appendDaemonClaimChatContext(store: MultiremiStore, task: MultiremiTaskWithAgent, response: Record<string, unknown>): void {
  if (!task.chatSessionId) return;
  try {
    const allMessages = store.listChatMessages(task.chatSessionId);
    const messages = trailingDaemonUserMessages(allMessages);
    const chatMessage = messages.map((message) => message.body.trim()).filter(Boolean).join("\n\n");
    if (chatMessage) response.chat_message = chatMessage;
  } catch (error) {
    log.debug(`Failed to load chat context for claimed task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function appendDaemonClaimBoundIssueUpdates(
  store: MultiremiStore,
  task: MultiremiTaskWithAgent,
  response: Record<string, unknown>,
): void {
  if (!task.chatSessionId) return;
  try {
    const pending = store.preparePendingAgentIssueUpdatesForTask(task.chatSessionId, task.id);
    if (pending.messages.length) {
      response.bound_issue_updates = pending.messages.map((message) => message.body);
    }
    if (pending.omittedCount > 0) {
      response.bound_issue_updates_omitted_count = pending.omittedCount;
    }
  } catch (error) {
    log.debug(
      `Failed to load bound Issue updates for claimed task ${task.id}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function appendDaemonClaimAutopilotContext(store: MultiremiStore, task: MultiremiTaskWithAgent, response: Record<string, unknown>): void {
  if (!task.autopilotRunId) return;
  const run = store.getAutopilotRun(task.autopilotRunId);
  if (!run) return;
  response.autopilot_id = run.autopilotId;
  response.autopilot_source = run.source;
  if (run.payload != null) response.autopilot_trigger_payload = run.payload;
  const autopilot = store.getAutopilot(run.autopilotId);
  const repositoryWikiRun = resolveRepositoryWikiAutomation(store, task.workspaceId)?.id === run.autopilotId;
  if (repositoryWikiRun && task.repositoryWikiContexts?.length) {
    const scmRevision = autopilotRunSourceRevision(run);
    if (scmRevision) response.scm_revision = scmRevision;
  }

  if (!autopilot) return;
  response.autopilot_title = autopilot.title;
  if (autopilot.description) response.autopilot_description = autopilot.description;
}

function trailingDaemonUserMessages(messages: MultiremiChatMessage[]): MultiremiChatMessage[] {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== "user") {
      start = index + 1;
      break;
    }
  }
  return messages.slice(start).filter((message) => message.role === "user");
}

function daemonQuickCreatePrompt(task: MultiremiTaskWithAgent): string | null {
  for (const ref of task.issue?.contextRefs ?? []) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
    const data = ref as { type?: unknown; prompt?: unknown };
    if (data.type === "quick_create" && typeof data.prompt === "string" && data.prompt.trim()) {
      return data.prompt.trim();
    }
  }
  if (!task.issueId && !task.chatSessionId && !task.autopilotRunId && task.prompt.trim()) return task.prompt.trim();
  return null;
}

function taskResultWireValue(task: MultiremiTask): unknown | null {
  if (task.result == null) return null;
  if (task.status !== "completed") return task.result;
  return {
    pr_url: task.branchName ?? "",
    output: task.result,
    session_id: task.sessionId ?? "",
    work_dir: task.workDir ?? "",
  };
}

export function daemonTaskMessageWireResponse(message: MultiremiTaskMessage, task: MultiremiTask): Record<string, unknown> {
  const response: Record<string, unknown> = {
    task_id: message.taskId,
    seq: message.seq,
    type: message.type,
    created_at: message.createdAt,
  };
  if (task.issueId) response.issue_id = task.issueId;
  if (message.tool) response.tool = message.tool;
  if (message.content) response.content = message.content;
  if (message.input) response.input = message.input;
  if (message.output) response.output = message.output;
  if (message.toolCallId) response.tool_call_id = message.toolCallId;
  if (message.status) response.status = message.status;
  if (message.meta) response.meta = message.meta;
  return response;
}

function daemonTaskKind(
  task: MultiremiTask & { issue?: MultiremiTaskWithAgent["issue"] },
): "chat" | "autopilot" | "quick_create" | "comment" | "direct" {
  if (task.chatSessionId) return "chat";
  if (task.autopilotRunId) return "autopilot";
  if (task.taskKind === "quick_create" || !task.issueId || task.issue?.issueKind === "intake") return "quick_create";
  if (task.triggerCommentId) return "comment";
  return "direct";
}

function daemonRelativeWorkDir(workDir: string, workspaceId: string, taskId: string): string {
  const normalized = workDir.replaceAll("\\", "/");
  const envRootSuffix = `${workspaceId}/${shortDaemonTaskId(taskId)}`;
  const suffixIndex = normalized.indexOf(envRootSuffix);
  if (suffixIndex >= 0) return normalized.slice(suffixIndex);

  const homeMatch = /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+(?:\/(.*))?$/i.exec(normalized);
  if (homeMatch) return homeMatch[1] ?? "";

  return daemonBasename(normalized);
}

function shortDaemonTaskId(taskId: string): string {
  return taskId.replaceAll("-", "").slice(0, 8);
}

function daemonBasename(path: string): string {
  const trimmed = path.replace(/\/+$/g, "");
  if (!trimmed) return "";
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}
