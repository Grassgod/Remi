// Tasks domain (task lifecycle, claiming/dispatch, task messages, human requests, usage and the
// terminal-state fan-out into issues/sessions/autopilots), extracted verbatim from MultiremiStore
// (the facade delegates every public method here).
import { createHash } from "node:crypto";
import { createId, nowIso } from "@multiremi/ids.js";
import { canonicalJson } from "@multiremi/agent-plugins/import.js";
import {
  cleanOptionalString,
  daemonRuntimeId,
  isActiveTaskStatus,
  normalizePositiveInt,
  normalizeTaskUsageEntries,
  nullableString,
  parseJson,
  parseTaskUsageEntries,
  resolveOptionalStringField,
  toJson,
  type RuntimeUsageEntry,
} from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import { PROJECT_REF_MAX_DEPTH } from "@multiremi/store/repos/projects-repo.js";
import { runtimeDaemonAliases } from "@multiremi/store/runtime-affinity.js";
import { createLogger } from "@shared/logger.js";
import type {
  CreateTaskHumanRequestInput,
  CreateTaskInput,
  MultiremiAgent,
  MultiremiAgentActivityBucket,
  MultiremiAgentRunCount,
  MultiremiChatSession,
  MultiremiIssue,
  MultiremiIssueComment,
  MultiremiProjectResource,
  MultiremiRepoData,
  MultiremiRuntime,
  MultiremiSessionAgentLane,
  MultiremiTask,
  MultiremiTaskHumanRequest,
  MultiremiTaskHumanRequestKind,
  MultiremiTaskHumanRequestStatus,
  MultiremiTaskMessage,
  MultiremiTaskPluginSnapshotEntry,
  MultiremiTaskStatus,
  MultiremiTaskTriggerMetadata,
  MultiremiTaskWithAgent,
  TaskMessageInput,
  TaskUsageEntry,
} from "@multiremi/contracts/types.js";

const log = createLogger("multiremi-store");

type Row = Record<string, unknown>;

const AUTO_RETRY_FAILURE_REASONS = new Set([
  "runtime_offline",
  "runtime_recovery",
  "timeout",
  "codex_semantic_inactivity",
  "agent_error.stale_session",
]);
const RESUME_UNSAFE_FAILURE_REASONS = new Set([
  "iteration_limit",
  "agent_fallback_message",
  "api_invalid_request",
  "codex_semantic_inactivity",
  "agent_error.stale_session",
]);
const CLAIM_RESPONSE_RECOVERY_MS = 90 * 1000;
const TRIGGER_SUMMARY_MAX_LENGTH = 200;
const ISSUE_WORKSPACE_MIN_CLI_VERSION = [0, 2, 26] as const;

class AgentPluginReadinessChangedError extends Error {}

function runtimeSupportsIssueWorkspaces(runtime: MultiremiRuntime): boolean {
  const rawVersion = runtime.metadata.cli_version ?? runtime.metadata.cliVersion;
  if (typeof rawVersion !== "string" || !rawVersion.trim()) return true;
  const match = rawVersion.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return true;
  const version = match.slice(1, 4).map(Number);
  for (let index = 0; index < ISSUE_WORKSPACE_MIN_CLI_VERSION.length; index += 1) {
    const delta = version[index] - ISSUE_WORKSPACE_MIN_CLI_VERSION[index];
    if (delta !== 0) return delta > 0;
  }
  return true;
}

export class TasksRepo {
  constructor(private ctx: StoreContext) {}

  listTasksForIssue(issueId: string): MultiremiTask[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at DESC",
    ).all(issueId) as Row[];
    return rows.map(toTask);
  }

  createTask(input: CreateTaskInput): MultiremiTask {
    const agent = this.ctx.agents().getAgent(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
    if (agent.archivedAt) throw new Error(`Agent is archived: ${input.agentId}`);
    const inheritedPluginSnapshot = taskPluginSnapshotInput(input);
    const inheritedExecutionFingerprint = cleanOptionalString(
      input.executionFingerprint ?? input.execution_fingerprint,
    );
    const currentPluginSnapshot = inheritedPluginSnapshot ?? this.ctx.agentPlugins().resolveAgentPluginSnapshot(agent.id);
    const expectedExecutionFingerprint = inheritedExecutionFingerprint
      ?? this.ctx.agentPlugins().getAgentPluginCapabilityRevision(agent.id);
    const triggerCommentId = cleanOptionalString(input.triggerCommentId ?? input.trigger_comment_id);
    const triggerComment = triggerCommentId ? this.ctx.getRawIssueComment(triggerCommentId) : null;
    if (triggerCommentId && !triggerComment) throw new Error(`Comment not found: ${triggerCommentId}`);
    const issueId = input.issueId ?? triggerComment?.issueId ?? null;
    const issue = issueId ? this.ctx.issues().getIssue(issueId) : null;
    if (issueId && !issue) throw new Error(`Issue not found: ${issueId}`);
    if (triggerComment && issue && triggerComment.issueId !== issue.id) throw new Error("Trigger comment does not belong to task issue");
    const chatSession = input.chatSessionId ? this.ctx.chat().getChatSession(input.chatSessionId) : null;
    if (input.chatSessionId && !chatSession) throw new Error(`Chat session not found: ${input.chatSessionId}`);
    if (chatSession && chatSession.agentId !== input.agentId) throw new Error("Chat session agent does not match task agent");
    // The task always runs in the agent's workspace (stamped below). Reject any
    // issue / chat session from a DIFFERENT workspace so we never create a task
    // in workspace B linked to an issue/project in workspace A (a cross-tenant
    // reference that would drive B's agent + machine + credentials from A).
    if (issue && issue.workspaceId !== agent.workspaceId) throw new Error("Issue workspace does not match agent workspace");
    if (chatSession && chatSession.workspaceId !== agent.workspaceId) throw new Error("Chat session workspace does not match agent workspace");
    const requestedIssueSessionId = cleanOptionalString(input.issueSessionId ?? input.issue_session_id)
      ?? triggerComment?.issueSessionId
      ?? (issue && !chatSession ? this.ctx.issueSessions().getOrCreateDefaultIssueSession(issue.id).id : null);
    const issueSession = requestedIssueSessionId ? this.ctx.issueSessions().getIssueSession(requestedIssueSessionId) : null;
    if (requestedIssueSessionId && !issueSession) throw new Error(`Issue session not found: ${requestedIssueSessionId}`);
    if (issueSession && issueSession.issueId !== issueId) throw new Error("Issue session does not belong to task issue");
    if (issueSession && issueSession.workspaceId !== agent.workspaceId) throw new Error("Issue session workspace does not match agent workspace");
    let runtimeId = resolveOptionalStringField(input, "runtimeId", "runtime_id", agent.runtimeId);
    if (runtimeId && !this.ctx.runtimes().getRuntime(runtimeId)) throw new Error(`Runtime not found: ${runtimeId}`);
    // Pool scheduling: tasks stay unbound so any provider-matching runtime can
    // claim them. Two machine-local realities still force a stamp: a promoted
    // provider session lives on the machine that ran it, and a local_directory
    // project resource only exists on its daemon.
    //
    // resetProviderSession (a resume-unsafe chat retry) means the caller has
    // deliberately given up the provider session — passing null runtime/
    // session/work_dir. Because null reads as "unspecified" to the `??`
    // fallbacks below, honour the intent explicitly: skip chat-session runtime
    // affinity and session/work_dir inheritance, but keep local_directory
    // affinity (the directory constraint is independent of the session).
    let inheritChatSession = !input.resetProviderSession;
    // Always compute affinity — a strong machine affinity (promoted session /
    // local_directory) must OVERRIDE an explicit runtimeId, not just fill in
    // when one is absent. Otherwise a caller could pin a directory task to the
    // wrong machine (it would run in a scratch checkout of the wrong repo) or
    // carry another machine's provider session. An explicit runtimeId is only
    // honoured when there is no strong affinity to respect.
    const affinity = this.resolveTaskAffinity(
      agent,
      input.resetProviderSession ? null : chatSession,
      issue,
      expectedExecutionFingerprint,
      currentPluginSnapshot.length > 0,
    );
    if (affinity.runtimeId) runtimeId = affinity.runtimeId;
    if (!input.resetProviderSession) inheritChatSession = affinity.inheritChatSession;

    // Product-session affinity is per (session, agent), not per Issue and not
    // shared with other agents. A valid lane pins this task to the runtime that
    // owns the ACP lineage. If a local-directory constraint points elsewhere,
    // or the provider/runtime drifted, abandon the cache atomically and cold
    // bootstrap from the canonical event log.
    let issueLane: MultiremiSessionAgentLane | null = null;
    let inheritIssueLane = false;
    if (issueSession) {
      issueLane = this.ctx.issueSessions().getOrCreateSessionAgentLane(issueSession.id, agent.id);
      const laneRuntime = issueLane.runtimeId ? this.ctx.runtimes().getRuntime(issueLane.runtimeId) : null;
      const laneResumable =
        !input.resetProviderSession
        && !!issueLane.providerSessionId
        && issueLane.provider === agent.provider
        && executionFingerprintResumable(
          issueLane.executionFingerprint,
          expectedExecutionFingerprint,
          currentPluginSnapshot.length > 0,
        )
        && laneRuntime != null
        && this.ctx.runtimes().runtimeCanRunAgent(laneRuntime, agent);
      const runtimeConflict = Boolean(affinity.runtimeId && issueLane.runtimeId && affinity.runtimeId !== issueLane.runtimeId);
      if (laneResumable && !runtimeConflict) {
        runtimeId = issueLane.runtimeId;
        inheritIssueLane = true;
      } else if (issueLane.providerSessionId || issueLane.cursorSeq > 0) {
        this.resetSessionAgentLane(issueSession.id, agent.id);
        issueLane = this.ctx.issueSessions().getOrCreateSessionAgentLane(issueSession.id, agent.id);
      }
    }

    const id = input.id ?? createId("tsk");
    const now = nowIso();
    const attempt = normalizePositiveInt(input.attempt, 1);
    const maxAttempts = Math.max(attempt, normalizePositiveInt(input.maxAttempts, 3));
    const triggerSummary = normalizeTriggerSummary(input.triggerSummary ?? input.trigger_summary ?? triggerComment?.body ?? null);
    this.ctx.db.run(
      `INSERT INTO multiremi_tasks (
        id, agent_id, runtime_id, issue_id, issue_session_id, chat_session_id,
        trigger_comment_id, trigger_summary, workspace_id, status, priority, prompt,
        attempt, max_attempts, parent_task_id, assignment_event_id,
        provider, plugin_snapshot, execution_fingerprint,
        session_id, work_dir, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.agentId,
        runtimeId,
        issueId,
        issueSession?.id ?? null,
        input.chatSessionId ?? null,
        triggerCommentId,
        triggerSummary,
        // A task ALWAYS belongs to its agent's workspace — never the
        // caller-supplied one. Otherwise a member could create a task in
        // their own workspace referencing another workspace's agent, then
        // claim it from their own runtime and receive that agent's
        // custom_env / mcp_config. (Pre-pool the agent's runtime binding
        // blocked this; unbinding reopened it.)
        agent.workspaceId,
        input.priority ?? 0,
        input.prompt,
        attempt,
        maxAttempts,
        cleanOptionalString(input.parentTaskId ?? input.parent_task_id),
        cleanOptionalString(input.assignmentEventId ?? input.assignment_event_id),
        cleanOptionalString(input.provider),
        toJson(inheritedPluginSnapshot ?? []),
        inheritedExecutionFingerprint,
        // The inheritChatSession gate applies only to a task that HAS a chat
        // session: when false the promoted session belongs to a machine we
        // can't return to (engine switched / runtime gone) — dropped, even if a
        // chat send re-sends the old fields. A task WITHOUT a chat session
        // (e.g. an issue-only resume-safe retry) carries its session explicitly,
        // already gated by maybeRetryFailedTask, so honour it directly.
        issueSession
          ? (
            inheritIssueLane
              ? issueLane?.providerSessionId ?? null
              : input.resetProviderSession
                ? null
                : input.sessionId ?? null
          )
          : chatSession
          ? (inheritChatSession ? (input.sessionId ?? chatSession.sessionId ?? null) : null)
          : (input.sessionId ?? null),
        // Only a machine-affine work_dir is stamped here: a session/directory
        // work_dir reaches only the machine pinned to run it. agent.cwd is NOT
        // applied — it is a machine-local path that would ride along on an
        // unpinned pool task and could point nowhere on the claiming machine.
        // The daemon owns the agent.cwd fallback and guards it against the
        // local filesystem (resolveWorkDir), then reports the resolved dir back
        // via pinTaskSession, so session promotion still records the real path.
        issueSession
          ? (
            inheritIssueLane
              ? issueLane?.workDir ?? null
              : input.resetProviderSession
                ? null
                : input.workDir ?? null
          )
          : chatSession
          ? (inheritChatSession ? (input.workDir ?? chatSession.workDir ?? null) : null)
          : (input.workDir ?? null),
        now,
        now,
      ],
    );
    if (inheritedPluginSnapshot) this.replaceTaskPluginSnapshotIndex(id, inheritedPluginSnapshot, now);
    if (issueSession) {
      this.ctx.issueSessions().addSessionParticipant(issueSession.id, {
        participantType: "agent",
        participantId: agent.id,
      });
      if (!cleanOptionalString(input.assignmentEventId ?? input.assignment_event_id)) {
        const assignment = this.ctx.issueSessions().appendSessionEvent(issueSession.id, {
          authorType: input.assignmentAuthorType ?? input.assignment_author_type ?? "system",
          authorId: input.assignmentAuthorId ?? input.assignment_author_id ?? null,
          kind: "task_assigned",
          body: input.prompt,
          taskId: id,
          metadata: {
            assignee_agent_id: agent.id,
            source_event_id: input.assignmentSourceEventId ?? input.assignment_source_event_id ?? null,
            attempt,
            parent_task_id: cleanOptionalString(input.parentTaskId ?? input.parent_task_id),
          },
        });
        this.ctx.db.run(
          "UPDATE multiremi_tasks SET assignment_event_id = ?, updated_at = ? WHERE id = ?",
          [assignment.id, nowIso(), id],
        );
      }
    }
    const task = this.getTask(id)!;
    const parentTaskId = cleanOptionalString(input.parentTaskId ?? input.parent_task_id);
    if (task.issueId && !parentTaskId && !this.hasInFlightTaskForIssue(task.issueId)) {
      this.syncIssueStatusFromTask(task, "todo");
    }
    this.ctx.notifyTaskEnqueued(task);
    return task;
  }

  resetSessionAgentLane(sessionId: string, agentId: string): MultiremiSessionAgentLane | null {
    const lane = this.ctx.issueSessions().getSessionAgentLane(sessionId, agentId);
    // A legacy task can predate lane creation, and an agent may already have
    // been archived as part of runtime teardown. In both cases there is no
    // resumable cache to clear, so terminal handling must remain a no-op.
    if (!lane) return null;
    this.ctx.db.run(
      `UPDATE multiremi_session_agent_lanes
       SET provider_session_id = NULL,
           runtime_id = NULL,
           provider = NULL,
           execution_fingerprint = NULL,
           work_dir = NULL,
           cursor_seq = 0,
           generation = generation + 1,
           last_task_id = NULL,
           updated_at = ?
       WHERE session_id = ? AND agent_id = ?`,
      [nowIso(), sessionId, agentId],
    );
    return this.ctx.issueSessions().getSessionAgentLane(sessionId, agentId) ?? lane;
  }

  /**
   * Where a pooled task should be pinned, and whether it may inherit the chat
   * session's promoted provider session. `inheritChatSession` goes false when
   * the session was produced by a different provider than the agent now runs
   * (the user switched engines): that session id / work_dir belong to the old
   * engine's runtime and must not be handed to the new one.
   */
  private resolveTaskAffinity(
    agent: MultiremiAgent,
    chatSession: MultiremiChatSession | null,
    issue: MultiremiIssue | null,
    executionFingerprint: string,
    hasPlugins: boolean,
  ): { runtimeId: string | null; inheritChatSession: boolean } {
    // local_directory affinity is checked FIRST and outranks session affinity:
    // the directory only exists on that daemon (a hard data constraint), while
    // a provider session is a soft constraint that can be restarted elsewhere.
    // A task carrying both a chat session and a directory issue must go to the
    // directory's machine; the session is only inherited if that machine is
    // also where the session lives.
    if (issue?.projectId) {
      for (const resource of this.ctx.projects().listProjectResources(issue.projectId)) {
        if (resource.resourceType !== "local_directory") continue;
        const daemonId = String(resource.resourceRef.daemonId ?? resource.resourceRef.daemon_id ?? "").trim();
        if (!daemonId) continue;
        const runtime = this.ctx.runtimes().getRuntimeByDaemonAndProvider(daemonId, agent.provider);
        // Always pin to the machine that holds the directory, even if it can't
        // currently run this agent (turned private / wrong owner). Leaving it
        // unpinned would let a provider-matching machine WITHOUT the directory
        // claim it and silently run in a scratch checkout of the wrong repo.
        // No runtime row yet → the deterministic id its runtime WILL get on
        // registration, so the task waits for that machine.
        const dirRuntimeId = runtime ? runtime.id : daemonRuntimeId(daemonId, agent.provider);
        // Inherit the session only if it was produced on THIS directory machine
        // AND by the agent's current engine (see sessionResumable).
        const inheritChatSession = this.sessionResumable(
          chatSession,
          agent,
          executionFingerprint,
          hasPlugins,
        ) && chatSession?.sessionRuntimeId === dirRuntimeId;
        return { runtimeId: dirRuntimeId, inheritChatSession };
      }
    }
    if (chatSession?.sessionId) {
      // Resume the session on the machine that produced it — but only when that
      // machine can still run this agent AND the session's recorded engine
      // matches the agent's current one. Otherwise abandon the session and
      // re-pool (the claim predicate would reject a stale/foreign pin forever).
      if (this.sessionResumable(chatSession, agent, executionFingerprint, hasPlugins) && chatSession.sessionRuntimeId) {
        const runtime = this.ctx.runtimes().getRuntime(chatSession.sessionRuntimeId);
        if (runtime && this.ctx.runtimes().runtimeCanRunAgent(runtime, agent)) {
          return { runtimeId: runtime.id, inheritChatSession: true };
        }
      }
      return { runtimeId: null, inheritChatSession: false };
    }
    return { runtimeId: null, inheritChatSession: true };
  }

  /**
   * Can this chat session's promoted provider session be resumed by the agent
   * as it stands now? The session id is specific to the engine that produced
   * it, recorded as session_provider — so it only resumes when the agent's
   * current provider still matches (an engine switch voids it). Sessions from
   * before this metadata existed (null session_provider) are treated as
   * non-resumable to stay safe.
   */
  private sessionResumable(
    chatSession: MultiremiChatSession | null,
    agent: MultiremiAgent,
    executionFingerprint: string,
    hasPlugins: boolean,
  ): boolean {
    return !!chatSession?.sessionId
      && chatSession.sessionProvider === agent.provider
      && executionFingerprintResumable(
        chatSession.sessionExecutionFingerprint,
        executionFingerprint,
        hasPlugins,
      );
  }

  getTask(id: string): MultiremiTask | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_tasks WHERE id = ?").get(id) as Row | null;
    return row ? this.withTaskAutopilotRun(toTask(row)) : null;
  }

  getTaskByRef(ref: string, input: { issueId?: string | null } = {}): MultiremiTask | null {
    const value = ref.trim();
    if (!value) return null;
    const exact = this.getTask(value);
    if (exact && (!input.issueId || exact.issueId === input.issueId)) return exact;
    if (!/^tsk_[a-z0-9_]+$/i.test(value)) return null;
    const rows = input.issueId
      ? this.ctx.db.query("SELECT * FROM multiremi_tasks WHERE issue_id = ? AND id LIKE ? ORDER BY created_at DESC").all(input.issueId, `${value}%`) as Row[]
      : this.ctx.db.query("SELECT * FROM multiremi_tasks WHERE id LIKE ? ORDER BY created_at DESC").all(`${value}%`) as Row[];
    if (rows.length !== 1) return null;
    return this.withTaskAutopilotRun(toTask(rows[0]!));
  }

  getTaskWithAgent(id: string): MultiremiTaskWithAgent | null {
    const task = this.getTask(id);
    if (!task) return null;
    const issue = task.issueId ? this.ctx.issues().getIssue(task.issueId) : null;
    const project = issue?.projectId ? this.ctx.projects().getProject(issue.projectId) : null;
    const projectResources = project ? this.ctx.projects().listProjectResources(project.id) : [];
    return {
      ...task,
      agent: this.ctx.agents().getAgent(task.agentId),
      issue,
      project,
      projectResources,
      projectDocs: project ? this.ctx.projects().getProjectDocsIndex(project.id) : null,
      repos: this.resolveTaskRepos(task.workspaceId, projectResources),
    };
  }

  getTaskTriggerMetadata(task: MultiremiTask): MultiremiTaskTriggerMetadata | null {
    if (!task.triggerCommentId) return null;
    const comment = this.ctx.getRawIssueComment(task.triggerCommentId);
    if (!comment) return null;

    const lastStartedAt = this.getLastTaskStartedAtForIssueAndAgent(task.issueId ?? comment.issueId, task.agentId, task.id);
    const newCommentCount = lastStartedAt
      ? this.countNewCommentsSince(comment.issueId, lastStartedAt, comment.id, task.agentId)
      : 0;
    return {
      triggerThreadId: this.getThreadRootCommentId(comment),
      triggerCommentContent: comment.body,
      triggerAuthorType: comment.authorType,
      triggerAuthorName: this.getCommentAuthorName(comment),
      newCommentCount,
      newCommentsSince: newCommentCount > 0 ? lastStartedAt : null,
    };
  }

  private resolveTaskRepos(workspaceId: string, projectResources: MultiremiProjectResource[]): MultiremiRepoData[] {
    const ownProjectId = projectResources[0]?.projectId ?? null;
    const refs: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    if (ownProjectId) visited.add(ownProjectId);
    // Own github_repo refs plus those of referenced projects, walked
    // recursively. The visited set is the real cycle defense (write-time
    // validation has a TOCTOU gap); dangling targets are silently skipped and
    // referenced projects' local_directory resources are never pulled.
    const collect = (resources: MultiremiProjectResource[], depth: number): void => {
      for (const resource of resources) {
        if (resource.resourceType === "github_repo") {
          refs.push(resource.resourceRef);
        } else if (resource.resourceType === "project_ref") {
          if (depth >= PROJECT_REF_MAX_DEPTH) continue;
          const targetId = String(resource.resourceRef.projectId ?? resource.resourceRef.project_id ?? "").trim();
          if (!targetId || visited.has(targetId)) continue;
          visited.add(targetId);
          if (!this.ctx.projects().getProject(targetId)) continue;
          collect(this.ctx.projects().listProjectResources(targetId), depth + 1);
        }
      }
    };
    collect(projectResources, 0);
    const projectRepos = normalizeRepos(refs);
    if (projectRepos.length) return projectRepos;
    return normalizeRepos(this.ctx.workspaces().getWorkspace(workspaceId)?.repos ?? []);
  }

  listTasks(status?: MultiremiTaskStatus): MultiremiTask[] {
    const rows = status
      ? this.ctx.db.query("SELECT * FROM multiremi_tasks WHERE status = ? ORDER BY created_at DESC").all(status) as Row[]
      : this.ctx.db.query("SELECT * FROM multiremi_tasks ORDER BY created_at DESC").all() as Row[];
    return this.withTaskAutopilotRuns(rows.map(toTask));
  }

  listAgentTasks(agentId: string): MultiremiTask[] {
    if (!this.ctx.agents().getAgent(agentId)) throw new Error(`Agent not found: ${agentId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_tasks WHERE agent_id = ? ORDER BY created_at DESC",
    ).all(agentId) as Row[];
    return this.withTaskAutopilotRuns(rows.map(toTask));
  }

  listWorkspaceAgentTaskSnapshot(workspaceId = "local"): MultiremiTask[] {
    const tasks = this.listTasks().filter((task) => task.workspaceId === workspaceId);
    const snapshot = new Map<string, MultiremiTask>();
    for (const task of tasks) {
      if (isActiveTaskStatus(task.status)) {
        snapshot.set(task.id, task);
      }
    }
    const latestOutcomeByAgent = new Map<string, MultiremiTask>();
    for (const task of tasks.filter((item) => item.status === "completed" || item.status === "failed")) {
      const current = latestOutcomeByAgent.get(task.agentId);
      if (!current || outcomeTime(task) > outcomeTime(current)) latestOutcomeByAgent.set(task.agentId, task);
    }
    for (const task of latestOutcomeByAgent.values()) snapshot.set(task.id, task);
    return [...snapshot.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  listWorkspaceAgentRunCounts(workspaceId = "local", days = 30): MultiremiAgentRunCount[] {
    const since = trailingWindowStart(days);
    const rows = this.ctx.db.query(
      `SELECT agent_id, COUNT(*) AS run_count
       FROM multiremi_tasks
       WHERE workspace_id = ? AND created_at > ?
       GROUP BY agent_id
       ORDER BY agent_id ASC`,
    ).all(workspaceId, since) as Row[];
    return rows.map((row) => {
      const agentId = String(row.agent_id);
      const runCount = Number(row.run_count ?? 0);
      return { agentId, agent_id: agentId, runCount, run_count: runCount };
    });
  }

  listWorkspaceAgentActivity30d(workspaceId = "local"): MultiremiAgentActivityBucket[] {
    const since = trailingWindowStart(30);
    const rows = this.ctx.db.query(
      `SELECT
         agent_id,
         substr(completed_at, 1, 10) AS bucket_date,
         COUNT(*) AS task_count,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
       FROM multiremi_tasks
       WHERE workspace_id = ?
         AND completed_at IS NOT NULL
         AND completed_at > ?
       GROUP BY agent_id, bucket_date
       ORDER BY agent_id ASC, bucket_date ASC`,
    ).all(workspaceId, since) as Row[];
    return rows.map((row) => {
      const agentId = String(row.agent_id);
      const bucketAt = `${String(row.bucket_date)}T00:00:00.000Z`;
      const taskCount = Number(row.task_count ?? 0);
      const failedCount = Number(row.failed_count ?? 0);
      return {
        agentId,
        agent_id: agentId,
        bucketAt,
        bucket_at: bucketAt,
        taskCount,
        task_count: taskCount,
        failedCount,
        failed_count: failedCount,
      };
    });
  }

  claimTask(runtimeId: string): MultiremiTaskWithAgent | null {
    const tx = this.ctx.db.transaction(() => {
      const runtime = this.ctx.runtimes().getRuntime(runtimeId);
      if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
      // Serialize concurrent claims per workspace. Postgres evaluates each
      // statement on its own snapshot, so two runtimes claiming at once could
      // both pass an agent's max_concurrent_tasks / issue-serialization
      // guards before either commits. Taking the workspace row lock first
      // makes the second claimant wait and re-read committed state. On
      // SQLite the single writer already guarantees this; the self-write is
      // a no-op there.
      this.ctx.db.run(
        "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?",
        [runtime.workspaceId ?? "local"],
      );
      // Plugin bindings/version activation and Agent provider updates use the
      // same workspace lock. Holding it through claim + snapshot prevents a
      // mutable capability change from slipping between dispatch and freeze.
      this.ctx.agentPlugins().lockAgentPluginWorkspace(runtime.workspaceId ?? "local");
      this.ctx.runtimes().heartbeatRuntime(runtimeId, { claimPending: false });

      const stale = this.reclaimStaleDispatchedTaskForRuntime(runtimeId);
      if (stale) return this.snapshotTaskExecution(stale, runtime);

      const claimed = this.claimNextTaskForRuntime(runtime);
      return claimed ? this.snapshotTaskExecution(claimed, runtime) : null;
    });
    try {
      return tx();
    } catch (error) {
      // A Plugin binding/version may change between the claim candidate SQL
      // and the exact snapshot read under PostgreSQL READ COMMITTED. Rolling
      // the transaction back leaves the task queued for the next reconcile.
      if (error instanceof AgentPluginReadinessChangedError) return null;
      throw error;
    }
  }

  /**
   * Record the engine this task is executing under, at claim time. A concrete
   * runtime fixes the engine; an "any" runtime runs whatever the agent's
   * provider is right now. The promoted session's engine (session_provider)
   * comes from this snapshot, not the agent's later-mutable provider.
   */
  private snapshotTaskExecution(task: MultiremiTaskWithAgent, runtime: MultiremiRuntime): MultiremiTaskWithAgent {
    // Serialize the final snapshot with provider/archival mutations. If an
    // Agent update committed first we observe it below; if it starts later it
    // waits until this claim commits, then its rescheduler can cancel/re-home
    // the now-frozen dispatched task.
    this.ctx.db.run(
      "UPDATE multiremi_agents SET updated_at = updated_at WHERE id = ?",
      [task.agentId],
    );
    const currentAgent = this.ctx.agents().getAgent(task.agentId);
    if (!currentAgent || currentAgent.archivedAt) {
      throw new AgentPluginReadinessChangedError("claimed Agent is no longer executable");
    }
    const provider = runtime.provider !== "any" ? runtime.provider : currentAgent.provider;
    if (runtime.provider !== "any" && runtime.provider !== currentAgent.provider) {
      throw new AgentPluginReadinessChangedError("Agent provider changed during task claim");
    }
    if (task.executionFingerprint && task.provider && task.provider !== currentAgent.provider) {
      throw new AgentPluginReadinessChangedError("frozen task provider no longer matches Agent provider");
    }
    // A stale dispatch and an automatic infrastructure retry already own an
    // immutable snapshot. Never resolve mutable Agent bindings again.
    if (task.executionFingerprint) {
      if (provider && !task.provider) {
        this.ctx.db.run("UPDATE multiremi_tasks SET provider = ? WHERE id = ?", [provider, task.id]);
        return { ...task, provider };
      }
      return task;
    }

    const pluginSnapshot = this.ctx.agentPlugins().resolveAgentPluginSnapshot(currentAgent.id);
    const executionFingerprint = createHash("sha256")
      .update(canonicalJson(pluginSnapshot))
      .digest("hex");
    if (!this.runtimeHasReadyPluginSnapshot(runtime.id, pluginSnapshot)) {
      throw new AgentPluginReadinessChangedError("Agent Plugin readiness changed during task claim");
    }
    let keepProviderSession = true;
    if (task.sessionId && task.chatSessionId) {
      const chat = this.ctx.chat().getChatSession(task.chatSessionId);
      keepProviderSession = executionFingerprintResumable(
        chat?.sessionExecutionFingerprint ?? null,
        executionFingerprint,
        pluginSnapshot.length > 0,
      );
    } else if (task.sessionId && task.issueSessionId) {
      const lane = this.ctx.issueSessions().getSessionAgentLane(task.issueSessionId, task.agentId);
      keepProviderSession = executionFingerprintResumable(
        lane?.executionFingerprint ?? null,
        executionFingerprint,
        pluginSnapshot.length > 0,
      );
    }
    this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET provider = ?, plugin_snapshot = ?, execution_fingerprint = ?,
           session_id = CASE WHEN ? = 1 THEN session_id ELSE NULL END,
           work_dir = CASE WHEN ? = 1 THEN work_dir ELSE NULL END,
           updated_at = ?
       WHERE id = ?`,
      [
        provider,
        toJson(pluginSnapshot),
        executionFingerprint,
        keepProviderSession ? 1 : 0,
        keepProviderSession ? 1 : 0,
        nowIso(),
        task.id,
      ],
    );
    this.replaceTaskPluginSnapshotIndex(task.id, pluginSnapshot);
    return this.getTaskWithAgent(task.id)!;
  }

  private replaceTaskPluginSnapshotIndex(
    taskId: string,
    snapshot: MultiremiTaskPluginSnapshotEntry[],
    createdAt = nowIso(),
  ): void {
    this.ctx.db.run("DELETE FROM multiremi_task_plugin_snapshots WHERE task_id = ?", [taskId]);
    for (const entry of snapshot) {
      this.ctx.db.run(
        `INSERT INTO multiremi_task_plugin_snapshots (
           task_id, binding_id, plugin_id, version_id, provider, digest, artifact_url, snapshot, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          taskId,
          entry.bindingId,
          entry.pluginId,
          entry.versionId,
          entry.provider,
          entry.digest,
          entry.artifactUrl,
          toJson(entry),
          createdAt,
        ],
      );
    }
  }

  private runtimeHasReadyTaskPlugins(runtimeId: string, task: MultiremiTask): boolean {
    if (!task.executionFingerprint) {
      return this.ctx.agentPlugins().runtimeHasReadyAgentPlugins(runtimeId, task.agentId);
    }
    return this.runtimeHasReadyPluginSnapshot(runtimeId, task.pluginSnapshot);
  }

  private runtimeHasReadyPluginSnapshot(
    runtimeId: string,
    snapshot: MultiremiTaskPluginSnapshotEntry[],
  ): boolean {
    for (const entry of snapshot) {
      const row = this.ctx.db.query(
        `SELECT s.status, s.desired, s.observed_digest, v.artifact_digest
         FROM multiremi_agent_plugin_versions v
         LEFT JOIN multiremi_agent_plugin_runtime_states s
           ON s.runtime_id = ? AND s.plugin_version_id = v.id
         WHERE v.id = ?`,
      ).get(runtimeId, entry.versionId) as Row | null;
      if (!row
        || Number(row.desired) !== 1
        || row.status !== "ready"
        || row.observed_digest !== row.artifact_digest) {
        return false;
      }
    }
    return true;
  }

  private reclaimStaleDispatchedTaskForRuntime(runtimeId: string): MultiremiTaskWithAgent | null {
    const cutoff = new Date(Date.now() - CLAIM_RESPONSE_RECOVERY_MS).toISOString();
    const now = nowIso();
    const row = this.ctx.db.query(
      `UPDATE multiremi_tasks
       SET dispatched_at = ?, updated_at = ?
       WHERE id = (
         SELECT id
         FROM multiremi_tasks
         WHERE runtime_id = ?
           AND status = 'dispatched'
           AND started_at IS NULL
           AND dispatched_at IS NOT NULL
           AND dispatched_at < ?
         ORDER BY priority DESC, dispatched_at ASC
         LIMIT 1
       )
       AND status = 'dispatched'
       AND started_at IS NULL
       RETURNING *`,
    ).get(now, now, runtimeId, cutoff) as Row | null;
    if (!row) return null;
    const task = this.getTaskWithAgent(String(row.id));
    // The re-claim above matches only on runtime_id, so a task whose agent or
    // runtime changed while it sat dispatched could be handed back to a runtime
    // that may no longer run it. Re-check the full eligibility the normal claim
    // enforces — the agent must still exist, be unarchived, and be runnable by
    // this runtime. If not, don't return it here.
    const runtime = this.ctx.runtimes().getRuntime(runtimeId);
    const eligible = task?.agent != null
      && !task.agent.archivedAt
      && runtime != null
      && this.ctx.runtimes().runtimeCanRunAgent(runtime, task.agent)
      && this.runtimeHasReadyTaskPlugins(runtime.id, task)
      && (!task.issueId || runtimeSupportsIssueWorkspaces(runtime));
    if (task && !eligible) {
      const now = nowIso();
      const repool = () =>
        this.ctx.db.run(
          "UPDATE multiremi_tasks SET status = 'queued', runtime_id = NULL, session_id = NULL, work_dir = NULL, dispatched_at = NULL, updated_at = ? WHERE id = ?",
          [now, String(row.id)],
        );
      // local_directory is checked FIRST, before archived/agent-missing — the
      // directory pin must survive even while the agent is archived (archived_at
      // keeps the normal claim from picking it up; if the agent is restored the
      // task must still land on the machine that holds the directory, not a
      // scratch checkout elsewhere).
      const daemonId = task.agent ? this.ctx.localDirectoryDaemonForTask(row) : null;
      if (daemonId && task.agent) {
        const rt = this.ctx.runtimes().getRuntimeByDaemonAndProvider(daemonId, task.agent.provider);
        const newRuntimeId = rt ? rt.id : daemonRuntimeId(daemonId, task.agent.provider);
        this.ctx.db.run(
          "UPDATE multiremi_tasks SET status = 'queued', runtime_id = ?, session_id = NULL, dispatched_at = NULL, updated_at = ? WHERE id = ?",
          [newRuntimeId, now, String(row.id)],
        );
      } else if (!task.agent || task.agent.archivedAt || !runtime) {
        // No agent / archived agent / runtime gone, and no directory pin to
        // preserve — re-pool; the normal claim's archived guard parks it.
        repool();
      } else if ((runtime.workspaceId ?? "local") !== (task.agent.workspaceId ?? "local")) {
        // The agent moved workspace while dispatched — cancel it (it picks up
        // fresh work in its new workspace; re-pooling into a foreign workspace
        // would strand it).
        this.cancelTask(String(row.id));
      } else {
        repool(); // owner/provider drift — another eligible machine can take it
      }
      return null;
    }
    return task;
  }

  private claimNextTaskForRuntime(runtime: MultiremiRuntime): MultiremiTaskWithAgent | null {
    const now = nowIso();
    // Always constrain by workspace, COALESCE(...,'local') so a runtime with
    // NULL workspace only claims local-workspace tasks instead of every
    // workspace's (the old `runtime.workspaceId ? ... : ""` dropped the filter
    // entirely for NULL-workspace runtimes, letting one claim across tenants).
    const workspaceFilter = "AND COALESCE(t.workspace_id, 'local') = ?";
    const daemonAliases = runtimeDaemonAliases(runtime);
    const daemonAliasPlaceholders = daemonAliases.map(() => "?").join(", ");
    const params = [
      runtime.id,
      now,
      now,
      runtime.id,
      runtime.maxConcurrency,
      runtime.workspaceId ?? "local",
      runtimeSupportsIssueWorkspaces(runtime) ? 1 : 0,
      ...daemonAliases,
      ...daemonAliases,
      ...daemonAliases,
      runtime.id,
      runtime.id,
      runtime.provider,
      runtime.provider,
      runtime.visibility,
      runtime.ownerId,
      runtime.id,
      runtime.id,
    ];
    // Ownership guard: a private runtime only executes its owner's agents — a
    // claim hands the runtime the agent's custom_env / mcp_config. Owner match
    // uses COALESCE(...,'local') so a single-machine deployment (runtime owner
    // NULL, agent owner 'local') still pairs, while a NULL-owner PRIVATE
    // runtime in a multi-user workspace no longer sweeps up every member's
    // agents. NOT relaxed for tasks stamped to this runtime: the /tasks API
    // lets any member stamp an arbitrary agent+runtime (a stamp is not proof
    // of authorization). Kept as a JS comment, not inline SQL: an apostrophe
    // in an in-string `--` comment corrupts the sqlite→pg placeholder scanner.
    const row = this.ctx.db.query(
      `UPDATE multiremi_tasks
       SET status = 'dispatched', runtime_id = ?, dispatched_at = ?, updated_at = ?
       WHERE id = (
         SELECT t.id
         FROM multiremi_tasks t
         JOIN multiremi_agents a ON a.id = t.agent_id
         WHERE t.status = 'queued'
           AND a.archived_at IS NULL
           AND a.workspace_id = t.workspace_id
           AND (
             SELECT COUNT(*)
             FROM multiremi_tasks runtime_active
             WHERE runtime_active.runtime_id = ?
               AND runtime_active.status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
           ) < ?
           ${workspaceFilter}
           AND (t.issue_id IS NULL OR ? = 1)
           AND (
             t.issue_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM multiremi_issue_workspaces issue_workspace
               WHERE issue_workspace.issue_id = t.issue_id
                 AND issue_workspace.status <> 'cleaned'
             )
             OR EXISTS (
               SELECT 1 FROM multiremi_issue_workspaces issue_workspace
               LEFT JOIN multiremi_runtimes issue_workspace_runtime
                 ON issue_workspace_runtime.id = issue_workspace.runtime_id
               WHERE issue_workspace.issue_id = t.issue_id
                 AND issue_workspace.status <> 'cleaned'
                 AND (
                   issue_workspace.runtime_id IN (${daemonAliasPlaceholders})
                   OR issue_workspace_runtime.daemon_id IN (${daemonAliasPlaceholders})
                   OR issue_workspace_runtime.legacy_daemon_id IN (${daemonAliasPlaceholders})
                 )
             )
           )
           AND (t.runtime_id IS NULL OR t.runtime_id = ?)
           AND (a.runtime_id IS NULL OR a.runtime_id = ?)
           AND (? = 'any' OR a.provider = ?)
           AND (? = 'public' OR COALESCE(CAST(? AS TEXT), 'local') = COALESCE(a.owner_id, 'local'))
           AND NOT EXISTS (
             SELECT 1
             FROM multiremi_task_plugin_snapshots task_plugin
             JOIN multiremi_agent_plugin_versions task_plugin_version
               ON task_plugin_version.id = task_plugin.version_id
             LEFT JOIN multiremi_agent_plugin_runtime_states task_plugin_state
               ON task_plugin_state.runtime_id = ?
              AND task_plugin_state.plugin_version_id = task_plugin.version_id
              AND task_plugin_state.desired = 1
             WHERE task_plugin.task_id = t.id
               AND (
                 task_plugin_state.id IS NULL
                 OR task_plugin_state.status <> 'ready'
                 OR task_plugin_state.observed_digest IS NULL
                 OR task_plugin_state.observed_digest <> task_plugin_version.artifact_digest
               )
           )
           AND (
             EXISTS (SELECT 1 FROM multiremi_task_plugin_snapshots frozen_plugin WHERE frozen_plugin.task_id = t.id)
             OR NOT EXISTS (
               SELECT 1
               FROM multiremi_agent_plugin_bindings agent_plugin
               JOIN multiremi_agent_plugins plugin ON plugin.id = agent_plugin.plugin_id
               LEFT JOIN multiremi_agent_plugin_versions plugin_version
                 ON plugin_version.id = CASE
                   WHEN agent_plugin.version_policy = 'pinned' THEN agent_plugin.version_id
                   ELSE plugin.active_version_id
                 END
               LEFT JOIN multiremi_agent_plugin_runtime_states plugin_state
                 ON plugin_state.runtime_id = ?
                AND plugin_state.plugin_version_id = plugin_version.id
                AND plugin_state.desired = 1
               WHERE agent_plugin.agent_id = a.id
                 AND agent_plugin.enabled = 1
                 AND plugin.archived_at IS NULL
                 AND (
                   plugin_version.id IS NULL
                   OR plugin_state.id IS NULL
                   OR plugin_state.status <> 'ready'
                   OR plugin_state.observed_digest IS NULL
                   OR plugin_state.observed_digest <> plugin_version.artifact_digest
                 )
             )
           )
           AND (
             SELECT COUNT(*)
             FROM multiremi_tasks running
             WHERE running.agent_id = t.agent_id
               AND running.status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
           ) < a.max_concurrent_tasks
           AND NOT EXISTS (
             SELECT 1 FROM multiremi_tasks active
             WHERE active.status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
               AND (
                 (t.issue_id IS NOT NULL AND active.issue_id = t.issue_id)
                 OR (active.agent_id = t.agent_id AND t.chat_session_id IS NOT NULL AND active.chat_session_id = t.chat_session_id)
                 OR (
                   active.agent_id = t.agent_id
                   AND
                   t.issue_id IS NULL
                   AND t.chat_session_id IS NULL
                   AND active.issue_id IS NULL
                   AND active.chat_session_id IS NULL
                 )
               )
           )
         ORDER BY t.priority DESC, t.created_at ASC
         LIMIT 1
       )
       AND status = 'queued'
       RETURNING *`,
    ).get(...params) as Row | null;
    if (!row) return null;

    const task = this.getTaskWithAgent(String(row.id));
    if (task) this.ctx.notifyTaskEvent("task:dispatch", task);
    return task;
  }

  startTask(taskId: string): MultiremiTask {
    const now = nowIso();
    const result = this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET status = 'running', started_at = COALESCE(started_at, ?), wait_reason = NULL, updated_at = ?
       WHERE id = ? AND status IN ('dispatched', 'waiting_local_directory')`,
      [now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or not dispatched: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.syncIssueStatusFromTask(task, "in_progress");
    this.ctx.notifyTaskEvent("task:running", task);
    return task;
  }

  markTaskWaitingLocalDirectory(taskId: string, reason?: string | null): MultiremiTask {
    const cleanReason = cleanOptionalString(reason);
    const now = nowIso();
    const result = this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET status = 'waiting_local_directory',
           wait_reason = ?,
           progress_summary = ?,
           updated_at = ?
       WHERE id = ? AND status = 'dispatched'`,
      [
        cleanReason,
        cleanReason ? `Waiting for local directory: ${cleanReason}` : "Waiting for local directory",
        now,
        taskId,
      ],
    );
    if (result.changes === 0) throw new Error(`Task not found or not dispatched: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.ctx.notifyTaskEvent("task:waiting_local_directory", task);
    return task;
  }

  createTaskHumanRequest(input: CreateTaskHumanRequestInput): MultiremiTaskHumanRequest {
    const id = input.id ?? createId("hrq");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_task_human_requests (id, task_id, kind, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [id, input.taskId, input.kind, JSON.stringify(input.payload ?? {}), now],
    );
    const reason = input.kind === "permission" ? "Waiting for permission approval" : "Waiting for a human answer";
    const transition = this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET status = 'awaiting_human', wait_reason = ?, progress_summary = ?, updated_at = ?
       WHERE id = ? AND status IN ('dispatched', 'running')`,
      [reason, reason, now, input.taskId],
    );
    if (transition.changes > 0) {
      const task = this.getTask(input.taskId);
      if (task) {
        this.syncIssueStatusFromTask(task, "in_review");
        this.ctx.notifyTaskEvent("task:awaiting_human", task);
      }
    }
    return this.getTaskHumanRequest(id)!;
  }

  getTaskHumanRequest(requestId: string): MultiremiTaskHumanRequest | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_task_human_requests WHERE id = ?").get(requestId) as Row | null;
    return row ? toTaskHumanRequest(row) : null;
  }

  listTaskHumanRequests(taskId: string): MultiremiTaskHumanRequest[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_task_human_requests WHERE task_id = ? ORDER BY created_at ASC, id ASC",
    ).all(taskId) as Row[];
    return rows.map(toTaskHumanRequest);
  }

  /** Atomic first-write-wins: returns null when the request is no longer pending. */
  respondTaskHumanRequest(
    requestId: string,
    input: { response: Record<string, unknown>; respondedBy?: string | null },
  ): MultiremiTaskHumanRequest | null {
    const now = nowIso();
    const result = this.ctx.db.run(
      `UPDATE multiremi_task_human_requests
       SET status = 'responded', response = ?, responded_by = ?, responded_at = ?
       WHERE id = ? AND status = 'pending'`,
      [JSON.stringify(input.response ?? {}), input.respondedBy ?? null, now, requestId],
    );
    if (result.changes === 0) return null;
    const request = this.getTaskHumanRequest(requestId)!;
    this.resumeTaskFromAwaitingHuman(request.taskId);
    return request;
  }

  /** Worker-initiated terminal transition (timeout, or task aborted while pending). */
  expireTaskHumanRequest(requestId: string, status: "timeout" | "cancelled"): MultiremiTaskHumanRequest | null {
    const result = this.ctx.db.run(
      `UPDATE multiremi_task_human_requests
       SET status = ?, responded_at = ?
       WHERE id = ? AND status = 'pending'`,
      [status, nowIso(), requestId],
    );
    if (result.changes === 0) return null;
    const request = this.getTaskHumanRequest(requestId)!;
    this.resumeTaskFromAwaitingHuman(request.taskId);
    return request;
  }

  private resumeTaskFromAwaitingHuman(taskId: string): void {
    const pending = this.ctx.db.query(
      "SELECT COUNT(*) AS n FROM multiremi_task_human_requests WHERE task_id = ? AND status = 'pending'",
    ).get(taskId) as { n: number } | null;
    if (pending && Number(pending.n) > 0) return;
    const result = this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET status = 'running', wait_reason = NULL, updated_at = ?
       WHERE id = ? AND status = 'awaiting_human'`,
      [nowIso(), taskId],
    );
    if (result.changes > 0) {
      const task = this.getTask(taskId);
      if (task) {
        this.syncIssueStatusFromTask(task, "in_progress");
        this.ctx.notifyTaskEvent("task:running", task);
      }
    }
  }

  reportProgress(taskId: string, summary: string, step?: number | null, total?: number | null): MultiremiTask {
    const result = this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET progress_summary = ?, progress_step = ?, progress_total = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [summary, step ?? null, total ?? null, nowIso(), taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    return this.getTask(taskId)!;
  }

  pinTaskSession(taskId: string, sessionId?: string | null, workDir?: string | null): MultiremiTask {
    if (!this.getTask(taskId)) throw new Error(`Task not found: ${taskId}`);
    this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET session_id = COALESCE(?, session_id), work_dir = COALESCE(?, work_dir), updated_at = ?
       WHERE id = ? AND status IN ('dispatched', 'running')`,
      [sessionId ?? null, workDir ?? null, nowIso(), taskId],
    );
    return this.getTask(taskId)!;
  }

  appendTaskMessages(taskId: string, messages: TaskMessageInput[]): MultiremiTaskMessage[] {
    if (messages.length === 0) return [];
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const current = this.ctx.db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM multiremi_task_messages WHERE task_id = ?")
      .get(taskId) as { seq: number } | null;
    let nextSeq = Number(current?.seq ?? 0) + 1;
    const insertedSeqs: number[] = [];
    const insert = this.ctx.db.prepare(
      `INSERT INTO multiremi_task_messages (
        id, task_id, seq, type, tool, content, input, output, tool_call_id, status, meta, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, seq) DO UPDATE SET
        type = excluded.type,
        tool = excluded.tool,
        content = excluded.content,
        input = excluded.input,
        output = excluded.output,
        tool_call_id = excluded.tool_call_id,
        status = excluded.status,
        meta = excluded.meta`,
    );
    const tx = this.ctx.db.transaction(() => {
      for (const message of messages) {
        const seq = message.seq ?? nextSeq++;
        insertedSeqs.push(seq);
        const id = createId("msg");
        insert.run(
          id,
          taskId,
          seq,
          message.type,
          truncateUtf8(cleanTaskMessageField(message.tool), TASK_MESSAGE_TOOL_MAX),
          truncateUtf8(cleanTaskMessageField(message.content), TASK_MESSAGE_TEXT_MAX),
          message.input == null ? null : truncateUtf8(toJson(sanitizeTaskMessageJson(message.input)), TASK_MESSAGE_INPUT_MAX),
          truncateUtf8(cleanTaskMessageField(message.output), TASK_MESSAGE_OUTPUT_MAX),
          cleanTaskMessageField(message.toolCallId),
          normalizeTaskMessageStatus(message.status),
          message.meta == null ? null : truncateUtf8(toJson(sanitizeTaskMessageJson(message.meta)), TASK_MESSAGE_META_MAX),
          nowIso(),
        );
      }
      this.ctx.db.run("UPDATE multiremi_tasks SET updated_at = ? WHERE id = ?", [nowIso(), taskId]);
    });
    tx();
    const inserted: MultiremiTaskMessage[] = [];
    for (const seq of insertedSeqs) {
      const row = this.ctx.db.query(
        "SELECT * FROM multiremi_task_messages WHERE task_id = ? AND seq = ?",
      ).get(taskId, seq) as Row | null;
      if (row) inserted.push(toTaskMessage(row));
    }
    // Re-read the task so listeners see the bumped updated_at, then broadcast
    // the actual persisted rows (post-truncation / post-upsert).
    this.ctx.notifyTaskMessages(this.getTask(taskId) ?? task, inserted);
    return inserted;
  }

  listTaskMessages(taskId: string, sinceSeq?: number | null): MultiremiTaskMessage[] {
    const since = sinceSeq == null ? null : Math.floor(Number(sinceSeq));
    const rows = since != null && Number.isFinite(since)
      ? this.ctx.db.query(
        "SELECT * FROM multiremi_task_messages WHERE task_id = ? AND seq > ? ORDER BY seq ASC",
      ).all(taskId, since) as Row[]
      : this.ctx.db.query(
        "SELECT * FROM multiremi_task_messages WHERE task_id = ? ORDER BY seq ASC",
      ).all(taskId) as Row[];
    return rows.map(toTaskMessage);
  }

  completeTask(taskId: string, input: {
    output: string;
    branchName?: string | null;
    sessionId?: string | null;
    workDir?: string | null;
  }): MultiremiTask {
    const now = nowIso();
    const storedResult = toJson(taskCompletionResultPayload(input));
    const result = this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET status = 'completed',
           result = ?,
           branch_name = ?,
           session_id = COALESCE(?, session_id),
           work_dir = COALESCE(?, work_dir),
           wait_reason = NULL,
           failure_reason = NULL,
           completed_at = ?,
           updated_at = ?
       WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')`,
      [storedResult, input.branchName ?? null, input.sessionId ?? null, input.workDir ?? null, now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "completed", input.output);
    this.ctx.notifyTaskEvent("task:completed", task);
    return task;
  }

  failTask(taskId: string, input: {
    error: string;
    sessionId?: string | null;
    workDir?: string | null;
    failureReason?: string | null;
    failure_reason?: string | null;
  }): MultiremiTask {
    const now = nowIso();
    const failureReason = cleanOptionalString(input.failureReason ?? input.failure_reason) ?? "agent_error";
    const result = this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET status = 'failed',
           error = ?,
           failure_reason = ?,
           session_id = COALESCE(?, session_id),
           work_dir = COALESCE(?, work_dir),
           wait_reason = NULL,
           completed_at = ?,
           failed_at = ?,
           updated_at = ?
       WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')`,
      [input.error, failureReason, input.sessionId ?? null, input.workDir ?? null, now, now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "failed", input.error);
    this.ctx.notifyTaskEvent("task:failed", task);
    return task;
  }

  cancelTask(taskId: string): MultiremiTask {
    const now = nowIso();
    const result = this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET status = 'cancelled', wait_reason = NULL, failure_reason = NULL, completed_at = ?, cancelled_at = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [now, now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "cancelled", null);
    this.ctx.notifyTaskEvent("task:cancelled", task);
    return task;
  }

  getTaskStatus(taskId: string): MultiremiTaskStatus {
    const row = this.ctx.db.query("SELECT status FROM multiremi_tasks WHERE id = ?").get(taskId) as { status: string } | null;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    return row.status as MultiremiTaskStatus;
  }

  reportTaskUsage(taskId: string, usage: TaskUsageEntry[]): MultiremiTask {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const merged = new Map<string, RuntimeUsageEntry>();
    for (const entry of parseTaskUsageEntries(task.usage)) {
      merged.set(`${entry.provider}\u0000${entry.model}`, entry);
    }
    for (const entry of normalizeTaskUsageEntries(usage)) {
      merged.set(`${entry.provider}\u0000${entry.model}`, entry);
    }
    this.ctx.db.run(
      "UPDATE multiremi_tasks SET usage = ?, updated_at = ? WHERE id = ?",
      [toJson([...merged.values()]), nowIso(), taskId],
    );
    return this.getTask(taskId)!;
  }

  recoverOrphans(runtimeId: string): { orphaned: number; retried: number } {
    const orphanRows = this.ctx.db.query(
      "SELECT id FROM multiremi_tasks WHERE runtime_id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')",
    ).all(runtimeId) as Array<{ id: string }>;
    if (!orphanRows.length) return { orphaned: 0, retried: 0 };

    const now = nowIso();
    const orphanIds = orphanRows.map((row) => String(row.id));
    const placeholders = orphanIds.map(() => "?").join(", ");
    this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET status = 'failed',
           error = 'daemon restarted while task was in flight',
           failure_reason = 'runtime_recovery',
           wait_reason = NULL,
           completed_at = ?,
           failed_at = ?,
           updated_at = ?
       WHERE id IN (${placeholders})`,
      [now, now, now, ...orphanIds],
    );
    const failedRows = this.ctx.db.query(`SELECT * FROM multiremi_tasks WHERE id IN (${placeholders})`).all(...orphanIds) as Row[];
    const failedTasks = this.withTaskAutopilotRuns(failedRows.map(toTask));
    let retried = 0;

    for (const task of failedTasks) {
      const retry = this.afterTaskTerminal(task, "failed", task.error);
      this.ctx.notifyTaskEvent("task:failed", task);
      if (retry) retried++;
    }

    return { orphaned: orphanIds.length, retried };
  }

  private maybeRetryFailedTask(parent: MultiremiTask): MultiremiTask | null {
    if (parent.status !== "failed") return null;
    if (!parent.failureReason || !AUTO_RETRY_FAILURE_REASONS.has(parent.failureReason)) return null;
    if (parent.attempt >= parent.maxAttempts) return null;
    if (parent.autopilotRunId) return null;
    if (!parent.issueId && !parent.chatSessionId) return null;

    // Resume-safe only if the parent's machine can STILL run this agent. If the
    // agent switched engine/owner (or the runtime changed) since the parent ran,
    // its session/runtime are void — degrade to resume-unsafe so the retry
    // re-pools and starts fresh instead of being pinned to a machine the claim
    // predicate would reject forever.
    const agent = this.ctx.agents().getAgent(parent.agentId);
    const parentRuntime = parent.runtimeId ? this.ctx.runtimes().getRuntime(parent.runtimeId) : null;
    // A resume carries the parent's provider session and work_dir — both are
    // machine-local files. It is only safe when we KNOW that machine and it can
    // still run the agent: the parent must be pinned to a live runtime, that
    // runtime must still be able to run the agent, AND the engine the parent
    // EXECUTED under (provider snapshot — an 'any' runtime passes
    // runtimeCanRunAgent for every provider, so the snapshot is what actually
    // guards a mid-run engine switch) must still match. A missing pin or a
    // missing/mismatched snapshot can't be proven machine-safe, so it fails
    // closed to a fresh re-pool that clears session/work_dir. (A resume-unsafe
    // parent with no session takes the same fresh-re-pool path here.)
    const parentRuntimeUsable =
      parent.runtimeId != null
      && parentRuntime != null
      && agent != null
      && parent.provider != null
      && parent.provider === agent.provider
      && this.ctx.runtimes().runtimeCanRunAgent(parentRuntime, agent);
    const resumeSafe = !RESUME_UNSAFE_FAILURE_REASONS.has(parent.failureReason) && parentRuntimeUsable;
    // If the Agent changed provider before this failure was reported, the old
    // provider/plugin snapshot can no longer be executed with the Agent's
    // current native config. Treat this as a fresh retry. When the retry was
    // already created before a later provider change, updateAgent cancels it
    // atomically instead, so neither ordering can mix providers.
    const inheritExecutionSnapshot = agent != null && parent.provider === agent.provider;
    if (resumeSafe && parent.issueSessionId) this.promoteSessionAgentLane(parent);
    const retry = this.createTask({
      agentId: parent.agentId,
      provider: inheritExecutionSnapshot ? parent.provider : null,
      pluginSnapshot: inheritExecutionSnapshot ? parent.pluginSnapshot : undefined,
      executionFingerprint: inheritExecutionSnapshot ? parent.executionFingerprint : null,
      // Resume-safe failures must go back to the machine holding the session;
      // once the session is abandoned, any pool machine may pick up the retry.
      runtimeId: resumeSafe ? parent.runtimeId : null,
      issueId: parent.issueId,
      issueSessionId: parent.issueSessionId,
      chatSessionId: parent.chatSessionId,
      triggerCommentId: parent.triggerCommentId,
      triggerSummary: parent.triggerSummary,
      workspaceId: parent.workspaceId,
      priority: parent.priority,
      prompt: parent.prompt,
      sessionId: resumeSafe ? parent.sessionId : null,
      workDir: resumeSafe ? parent.workDir : null,
      // Without this, createTask would re-derive the session/work_dir/runtime
      // from the chat session and silently resume the failed session anyway.
      resetProviderSession: !resumeSafe,
      attempt: parent.attempt + 1,
      maxAttempts: parent.maxAttempts,
      parentTaskId: parent.id,
    });
    if (retry.chatSessionId) {
      this.ctx.db.run(
        "UPDATE multiremi_chat_sessions SET latest_task_id = ?, updated_at = ? WHERE id = ?",
        [retry.id, nowIso(), retry.chatSessionId],
      );
    }
    return retry;
  }

  private getThreadRootCommentId(comment: MultiremiIssueComment): string {
    let current = comment;
    const seen = new Set<string>();
    while (current.parentId && !seen.has(current.parentId)) {
      seen.add(current.id);
      const parent = this.ctx.getRawIssueComment(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  private getCommentAuthorName(comment: MultiremiIssueComment): string | null {
    if (!comment.authorId) return null;
    if (comment.authorType === "agent") return this.ctx.agents().getAgent(comment.authorId)?.name ?? null;
    if (comment.authorType === "member") {
      return this.ctx.workspaces().getWorkspaceMember(comment.authorId)?.name ?? this.ctx.workspaces().getUser(comment.authorId)?.name ?? null;
    }
    return this.ctx.workspaces().getUser(comment.authorId)?.name ?? null;
  }

  private getLastTaskStartedAtForIssueAndAgent(issueId: string, agentId: string, excludingTaskId: string): string | null {
    const row = this.ctx.db.query(
      `SELECT started_at FROM multiremi_tasks
       WHERE issue_id = ? AND agent_id = ? AND id <> ? AND started_at IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1`,
    ).get(issueId, agentId, excludingTaskId) as { started_at: string | null } | null;
    return nullableString(row?.started_at);
  }

  private countNewCommentsSince(issueId: string, since: string, anchorCommentId: string, agentId: string): number {
    const row = this.ctx.db.query(
      `SELECT COUNT(*) AS count
       FROM multiremi_issue_comments
       WHERE issue_id = ?
         AND created_at > ?
         AND id <> ?
         AND NOT (author_type = 'agent' AND author_id = ?)`,
    ).get(issueId, since, anchorCommentId, agentId) as { count: number } | null;
    return Number(row?.count ?? 0);
  }

  private afterTaskTerminal(task: MultiremiTask, status: "completed" | "failed" | "cancelled", body: string | null): MultiremiTask | null {
    const now = nowIso();
    const retry = status === "failed" ? this.maybeRetryFailedTask(task) : null;
    this.ctx.accessTokens().revokeTaskAccessTokens(task.id);
    if (task.chatSessionId && (status === "completed" || (status === "failed" && !retry))) {
      const role = "assistant";
      const messageBody = status === "completed" ? (body || "Task completed.") : (body || `Task ${status}`);
      const failureReason = status === "failed" ? task.failureReason : null;
      const elapsedMs = computeChatElapsedMs(task);
      const messageId = createId("msg");
      this.ctx.db.run(
        `INSERT INTO multiremi_chat_messages (
          id, chat_session_id, task_id, role, body, failure_reason, elapsed_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [messageId, task.chatSessionId, task.id, role, messageBody, failureReason, elapsedMs, now],
      );
      // Promote the session ATOMICALLY as one unit — session_id together with
      // its machine (runtime) and engine (provider) — and ONLY when this task
      // actually produced a new session id. Otherwise a task that promotes but
      // carries no sessionId (e.g. a non-retryable failure) would leave the old
      // session_id in place while overwriting session_runtime_id/provider with
      // this task's, mislabelling the old session's engine. The engine comes
      // from the task's execution snapshot (task.provider), not the agent's
      // now-mutable provider. Snapshot missing → derive from a concrete runtime,
      // else leave null (fail-closed: an unknown-engine session isn't resumed).
      const promoteSession =
        (status !== "failed" || !RESUME_UNSAFE_FAILURE_REASONS.has(task.failureReason ?? "")) &&
        !!cleanOptionalString(task.sessionId);
      const runtimeProvider = task.runtimeId ? this.ctx.runtimes().getRuntime(task.runtimeId)?.provider : null;
      const sessionProvider = task.provider ?? (runtimeProvider && runtimeProvider !== "any" ? runtimeProvider : null);
      this.ctx.db.run(
        `UPDATE multiremi_chat_sessions
         SET session_id = CASE WHEN ? = 1 THEN ? ELSE session_id END,
             work_dir = CASE WHEN ? = 1 THEN ? ELSE work_dir END,
             session_runtime_id = CASE WHEN ? = 1 THEN ? ELSE session_runtime_id END,
             session_provider = CASE WHEN ? = 1 THEN ? ELSE session_provider END,
             session_execution_fingerprint = CASE WHEN ? = 1 THEN ? ELSE session_execution_fingerprint END,
             latest_task_id = ?,
             unread_since = COALESCE(unread_since, ?),
             updated_at = ?
         WHERE id = ?`,
        [
          promoteSession ? 1 : 0, task.sessionId ?? null,
          promoteSession ? 1 : 0, task.workDir ?? null,
          promoteSession ? 1 : 0, task.runtimeId ?? null,
          promoteSession ? 1 : 0, sessionProvider,
          promoteSession ? 1 : 0, task.executionFingerprint,
          task.id, now, now, task.chatSessionId,
        ],
      );
      if (status === "completed") {
        const session = this.ctx.chat().getChatSession(task.chatSessionId);
        this.ctx.emitWorkspaceEvent({
          type: "chat:done",
          workspaceId: session?.workspaceId ?? task.workspaceId,
          chatSessionId: task.chatSessionId,
          actorType: "system",
          actorId: "",
          payload: {
            chat_session_id: task.chatSessionId,
            task_id: task.id,
            message_id: messageId,
            content: messageBody,
            elapsed_ms: elapsedMs,
            created_at: now,
          },
        });
      }
    }

    if (task.issueId) {
      const issueStatus = this.nextIssueStatusAfterTaskTerminal(task, status);
      const issue = this.ctx.issues().getIssue(task.issueId);
      if (issueStatus) this.syncIssueStatusFromTask(task, issueStatus);
      this.ctx.appendIssueActivity(task.issueId, {
        actorType: "agent",
        actorId: task.agentId,
        type: `task_${status}`,
        body,
        data: { taskId: task.id, runtimeId: task.runtimeId },
      });
      if (status === "completed") this.postAgentReplyComment(task, body);
      if (task.issueSessionId) {
        this.ctx.issueSessions().appendSessionEvent(task.issueSessionId, {
          authorType: status === "completed" ? "agent" : "system",
          authorId: status === "completed" ? task.agentId : null,
          kind: `task_${status}`,
          body: status === "completed" ? "" : body ?? "",
          taskId: task.id,
          metadata: {
            status,
            assignee_agent_id: task.agentId,
            result_available: status === "completed" && Boolean(body?.trim()),
            failure_reason: task.failureReason,
          },
        });
        if (status === "completed") this.promoteSessionAgentLane(task);
        else if (!retry) this.resetSessionAgentLane(task.issueSessionId, task.agentId);
      }
      if (issue?.projectId) this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, issue.projectId]);
    }

    const runRow = this.ctx.db.query(
      "SELECT id FROM multiremi_autopilot_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(task.id) as { id: string } | null;
    if (runRow) {
      const runStatus = status === "completed" ? "completed" : "failed";
      const failureReason = autopilotTaskFailureReason(status, task);
      this.ctx.db.run(
        `UPDATE multiremi_autopilot_runs
         SET status = ?, completed_at = ?, failure_reason = ?, result = ?
         WHERE id = ?`,
        [
          runStatus,
          now,
          runStatus === "failed" ? failureReason : null,
          toJson({ taskId: task.id, status, output: task.result, error: task.error }),
          runRow.id,
        ],
      );
      const run = this.ctx.autopilots().getAutopilotRun(runRow.id);
      const autopilot = run ? this.ctx.autopilots().getAutopilot(run.autopilotId) : null;
      if (run && autopilot) {
        if (runStatus === "completed") this.ctx.analytics().recordAutopilotRunCompletedAnalytics(autopilot, run);
        else this.ctx.analytics().recordAutopilotRunFailedAnalytics(autopilot, run, failureReason);
      }
    }
    return retry;
  }

  private promoteSessionAgentLane(task: MultiremiTask): void {
    if (!task.issueSessionId || !task.sessionId || !task.runtimeId || !task.provider) return;
    const cursorSeq = Math.max(0, task.projectionToSeq ?? 0);
    const now = nowIso();
    const lane = this.ctx.issueSessions().getOrCreateSessionAgentLane(task.issueSessionId, task.agentId);
    // The provider lineage and its cursor are one checkpoint. For a warm turn,
    // only the lineage used by the task may advance; for a cold turn the lane
    // must still be empty. This prevents a late completion from overwriting a
    // manually reset or replaced lane.
    const expectedProviderSessionId = task.projectionMode === "delta" ? task.sessionId : null;
    const update = `UPDATE multiremi_session_agent_lanes
      SET provider_session_id = ?,
          runtime_id = ?,
          provider = ?,
          execution_fingerprint = ?,
          work_dir = ?,
          cursor_seq = ?,
          last_task_id = ?,
          updated_at = ?
      WHERE session_id = ? AND agent_id = ?`;
    const params = [
      task.sessionId,
      task.runtimeId,
      task.provider,
      task.executionFingerprint,
      task.workDir,
      cursorSeq,
      task.id,
      now,
      task.issueSessionId,
      task.agentId,
    ];
    // Keep the NULL comparison out of a placeholder expression: SQLite accepts
    // `? IS NULL`, while Postgres cannot infer that placeholder's data type.
    if (expectedProviderSessionId == null) {
      this.ctx.db.run(`${update} AND provider_session_id IS NULL`, params);
    } else {
      this.ctx.db.run(`${update} AND provider_session_id = ?`, [...params, expectedProviderSessionId]);
    }
    // Keep the lane row created above even when the guarded update intentionally
    // loses a race; callers can inspect it to diagnose lineage replacement.
    void lane;
  }

  // Post the agent's final reply as an issue comment so the outcome is visible
  // in the issue thread, not only inside the run transcript. Threads under the
  // triggering comment when the task came from an @mention. Legacy daemons
  // still report the "Task completed." placeholder — skip it, it says nothing.
  private postAgentReplyComment(task: MultiremiTask, output: string | null): void {
    if (!task.issueId || !task.agentId) return;
    const body = (output ?? "").trim();
    if (!body || body === "Task completed.") return;
    try {
      // If the agent already posted its own comment during this run (the normal
      // path for @mention/comment-triggered tasks — it replies in-thread via a
      // tool), don't also post the accumulated transcript text: that double-posts
      // and the auto-reply is the lower-quality, narration-heavy version. The
      // auto-reply stays for direct assignments where the agent doesn't comment.
      if (this.agentCommentedSince(task.issueId, task.agentId, task.dispatchedAt ?? task.startedAt ?? task.createdAt)) {
        return;
      }
      const parent = task.triggerCommentId ? this.ctx.issues().getIssueComment(task.triggerCommentId) : null;
      this.ctx.issues().createIssueComment(task.issueId, {
        issueSessionId: task.issueSessionId,
        authorType: "agent",
        authorId: task.agentId,
        // Links the reply to its run so the chat stream can open the transcript.
        taskId: task.id,
        parentId: parent && parent.issueId === task.issueId ? parent.id : null,
        body,
      });
    } catch (err) {
      // Task completion must never fail because the reply couldn't be posted.
      log.warn(`agent reply comment skipped for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private agentCommentedSince(issueId: string, agentId: string, since: string | null): boolean {
    // Branch on `since` in JS rather than `(? IS NULL OR …)` in SQL: Postgres
    // cannot infer the type of a placeholder that only appears in IS NULL and
    // rejects the whole query ("could not determine data type of parameter").
    const base = `SELECT 1 AS present FROM multiremi_issue_comments
       WHERE issue_id = ? AND author_type = 'agent' AND author_id = ? AND type = 'comment'`;
    const row = (since == null
      ? this.ctx.db.query(`${base} LIMIT 1`).get(issueId, agentId)
      : this.ctx.db.query(`${base} AND created_at >= ? LIMIT 1`).get(issueId, agentId, since)) as { present: number } | null;
    return Boolean(row);
  }

  private nextIssueStatusAfterTaskTerminal(
    task: MultiremiTask,
    status: "completed" | "failed" | "cancelled",
  ): string | null {
    if (!task.issueId) return null;

    // A terminal task must not overwrite the state implied by sibling work.
    // This also covers auto-retries: maybeRetryFailedTask creates the queued
    // child before this method runs, so a retry correctly leaves the issue in
    // todo until a daemon actually starts it.
    const remainingStatus = this.issueStatusForRemainingTasks(task.issueId);
    if (remainingStatus) return remainingStatus;

    if (status === "completed") return "in_review";
    const issue = this.ctx.issues().getIssue(task.issueId);
    if (
      (issue?.status === "in_progress" || issue?.status === "in_review") &&
      !this.hasActiveTaskForIssue(task.issueId)
    ) return "todo";
    return null;
  }

  private issueStatusForRemainingTasks(issueId: string): string | null {
    const rows = this.ctx.db.query(
      `SELECT status FROM multiremi_tasks
       WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
    ).all(issueId) as Array<{ status: string }>;
    const statuses = new Set(rows.map((row) => row.status));
    if (statuses.has("awaiting_human")) return "in_review";
    if (
      statuses.has("running") ||
      statuses.has("dispatched") ||
      statuses.has("waiting_local_directory")
    ) return "in_progress";
    if (statuses.has("queued")) return "todo";
    return null;
  }

  private syncIssueStatusFromTask(task: MultiremiTask, status: string): void {
    if (!task.issueId) return;
    const issue = this.ctx.issues().getIssue(task.issueId);
    // Explicit issue terminal states are user decisions. A late worker event
    // (or a cancellation racing with it) must not reopen accepted/cancelled
    // work; only a direct issue mutation may leave these states.
    if (issue?.status === "done" || issue?.status === "cancelled") return;
    if (!issue || issue.status === status) return;
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_issues SET status = ?, updated_at = ? WHERE id = ?",
      [status, now, task.issueId],
    );
    // Task lifecycle writes bypass the HTTP layer, so publish the same partial
    // patch that issue pages and boards already consume from realtime updates.
    this.ctx.emitWorkspaceEvent({
      type: "issue:updated",
      workspaceId: issue.workspaceId,
      actorType: "agent",
      actorId: task.agentId,
      payload: {
        issue: { id: task.issueId, status, updated_at: now },
        status_changed: true,
        prev_status: issue.status,
      },
    });
  }

  private hasInFlightTaskForIssue(issueId: string): boolean {
    const row = this.ctx.db.query(
      `SELECT 1 AS present FROM multiremi_tasks
       WHERE issue_id = ?
         AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
       LIMIT 1`,
    ).get(issueId) as { present: number } | null;
    return Boolean(row);
  }

  private hasActiveTaskForIssue(issueId: string): boolean {
    const row = this.ctx.db.query(
      `SELECT 1 AS present FROM multiremi_tasks
       WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
       LIMIT 1`,
    ).get(issueId) as { present: number } | null;
    return Boolean(row);
  }

  private withTaskAutopilotRun(task: MultiremiTask): MultiremiTask {
    const row = this.ctx.db.query(
      "SELECT id FROM multiremi_autopilot_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(task.id) as { id: string } | null;
    return { ...task, autopilotRunId: row?.id ?? task.autopilotRunId ?? null };
  }

  private withTaskAutopilotRuns(tasks: MultiremiTask[]): MultiremiTask[] {
    if (!tasks.length) return tasks;
    const placeholders = tasks.map(() => "?").join(", ");
    const rows = this.ctx.db.query(
      `SELECT task_id, id
       FROM multiremi_autopilot_runs
       WHERE task_id IN (${placeholders})
       ORDER BY created_at DESC`,
    ).all(...tasks.map((task) => task.id)) as Row[];
    const runByTask = new Map<string, string>();
    for (const row of rows) {
      const taskId = nullableString(row.task_id);
      const runId = nullableString(row.id);
      if (taskId && runId && !runByTask.has(taskId)) runByTask.set(taskId, runId);
    }
    return tasks.map((task) => ({ ...task, autopilotRunId: runByTask.get(task.id) ?? task.autopilotRunId ?? null }));
  }
}

function parseJsonValue(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function autopilotTaskFailureReason(status: "completed" | "failed" | "cancelled", task: MultiremiTask): string {
  if (status === "failed") return task.error || "task failed";
  if (status === "cancelled") return task.error || "task cancelled";
  return "";
}

function trailingWindowStart(days: number): string {
  const capped = Math.max(1, Math.min(365, Math.floor(days)));
  return new Date(Date.now() - capped * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeTriggerSummary(value: unknown): string | null {
  const text = cleanOptionalString(value)?.replace(/[\n\r\t]/g, " ").trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length <= TRIGGER_SUMMARY_MAX_LENGTH) return text;
  return `${chars.slice(0, TRIGGER_SUMMARY_MAX_LENGTH).join("")}\u2026`;
}

function taskPluginSnapshotInput(input: CreateTaskInput): MultiremiTaskPluginSnapshotEntry[] | null {
  const value = input.pluginSnapshot ?? input.plugin_snapshot;
  return Array.isArray(value) ? value.map((entry) => ({ ...entry, config: { ...entry.config } })) : null;
}

function executionFingerprintResumable(
  storedFingerprint: string | null | undefined,
  expectedFingerprint: string,
  hasPlugins: boolean,
): boolean {
  const stored = cleanOptionalString(storedFingerprint);
  // Sessions created before Plugin fingerprints existed remain compatible only
  // while the Agent still has no Plugins. Once capabilities are attached we
  // fail closed and start a fresh provider session.
  return stored ? stored === expectedFingerprint : !hasPlugins;
}

function outcomeTime(task: MultiremiTask): number {
  return Date.parse(task.completedAt ?? task.failedAt ?? task.updatedAt ?? task.createdAt);
}

function normalizeRepos(rawRepos: unknown[]): MultiremiRepoData[] {
  const repos: MultiremiRepoData[] = [];
  const seen = new Set<string>();
  for (const raw of rawRepos) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const description = typeof record.description === "string" ? record.description : "";
    repos.push(description ? { url, description } : { url });
  }
  return repos;
}

function toTask(row: Row): MultiremiTask {
  const taskResult = normalizeStoredTaskResult(row.result);
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    runtimeId: nullableString(row.runtime_id),
    provider: nullableString(row.provider),
    pluginSnapshot: parseJson<MultiremiTaskPluginSnapshotEntry[]>(row.plugin_snapshot, []),
    plugin_snapshot: parseJson<MultiremiTaskPluginSnapshotEntry[]>(row.plugin_snapshot, []),
    executionFingerprint: nullableString(row.execution_fingerprint),
    execution_fingerprint: nullableString(row.execution_fingerprint),
    issueId: nullableString(row.issue_id),
    issueSessionId: nullableString(row.issue_session_id),
    issue_session_id: nullableString(row.issue_session_id),
    chatSessionId: nullableString(row.chat_session_id),
    autopilotRunId: nullableString(row.autopilot_run_id),
    triggerCommentId: nullableString(row.trigger_comment_id),
    triggerSummary: nullableString(row.trigger_summary),
    workspaceId: String(row.workspace_id ?? "local"),
    status: String(row.status) as MultiremiTaskStatus,
    priority: Number(row.priority ?? 0),
    prompt: String(row.prompt ?? ""),
    attempt: Number(row.attempt ?? 1),
    maxAttempts: Number(row.max_attempts ?? 3),
    parentTaskId: nullableString(row.parent_task_id),
    assignmentEventId: nullableString(row.assignment_event_id),
    assignment_event_id: nullableString(row.assignment_event_id),
    projectionFromSeq: row.projection_from_seq == null ? null : Number(row.projection_from_seq),
    projection_from_seq: row.projection_from_seq == null ? null : Number(row.projection_from_seq),
    projectionToSeq: row.projection_to_seq == null ? null : Number(row.projection_to_seq),
    projection_to_seq: row.projection_to_seq == null ? null : Number(row.projection_to_seq),
    projectionMode: nullableString(row.projection_mode) as MultiremiTask["projectionMode"],
    projection_mode: nullableString(row.projection_mode) as MultiremiTask["projectionMode"],
    result: taskResult.output,
    error: nullableString(row.error),
    failureReason: nullableString(row.failure_reason),
    failure_reason: nullableString(row.failure_reason),
    branchName: nullableString(row.branch_name) ?? taskResult.prUrl,
    sessionId: nullableString(row.session_id) ?? taskResult.sessionId,
    workDir: nullableString(row.work_dir) ?? taskResult.workDir,
    progressSummary: nullableString(row.progress_summary),
    progressStep: row.progress_step == null ? null : Number(row.progress_step),
    progressTotal: row.progress_total == null ? null : Number(row.progress_total),
    waitReason: nullableString(row.wait_reason),
    wait_reason: nullableString(row.wait_reason),
    usage: parseJson(row.usage, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    dispatchedAt: nullableString(row.dispatched_at),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    failedAt: nullableString(row.failed_at),
    cancelledAt: nullableString(row.cancelled_at),
  };
}

function taskCompletionResultPayload(input: {
  output: string;
  branchName?: string | null;
  sessionId?: string | null;
  workDir?: string | null;
}): { pr_url: string; output: string; session_id: string; work_dir: string } {
  return {
    pr_url: input.branchName ?? "",
    output: input.output,
    session_id: input.sessionId ?? "",
    work_dir: input.workDir ?? "",
  };
}

function normalizeStoredTaskResult(value: unknown): {
  output: string | null;
  prUrl: string | null;
  sessionId: string | null;
  workDir: string | null;
} {
  const raw = nullableString(value);
  if (raw == null) return { output: null, prUrl: null, sessionId: null, workDir: null };
  const parsed = parseJsonValue(raw);
  if (typeof parsed === "string") {
    return { output: parsed, prUrl: null, sessionId: null, workDir: null };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const result = parsed as Record<string, unknown>;
    return {
      output: nullableString(result.output),
      prUrl: nullableString(result.pr_url),
      sessionId: nullableString(result.session_id),
      workDir: nullableString(result.work_dir),
    };
  }
  return { output: raw, prUrl: null, sessionId: null, workDir: null };
}

function toTaskMessage(row: Row): MultiremiTaskMessage {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    seq: Number(row.seq),
    type: String(row.type),
    tool: nullableString(row.tool),
    content: nullableString(row.content),
    input: row.input == null ? null : parseJson(row.input, null),
    output: nullableString(row.output),
    toolCallId: nullableString(row.tool_call_id),
    status: nullableString(row.status),
    meta: row.meta == null ? null : parseJson(row.meta, null),
    createdAt: String(row.created_at),
  };
}

// ── Task-message sanitization / size caps ──────────────────────────────────
// The daemon POST path is untrusted-ish (a compromised or buggy agent could
// send megabytes). These are the server-side backstop; the API layer also
// caps total request size. Byte counts, not code-point counts, because SQLite
// TEXT is bytes and that's what actually bloats the DB / WS frames.

const TASK_MESSAGE_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);
const TASK_MESSAGE_TOOL_MAX = 512;
const TASK_MESSAGE_TEXT_MAX = 256 * 1024;
const TASK_MESSAGE_OUTPUT_MAX = 64 * 1024;
const TASK_MESSAGE_INPUT_MAX = 256 * 1024;
const TASK_MESSAGE_META_MAX = 64 * 1024;
const TASK_MESSAGE_JSON_MAX_DEPTH = 8;
const TASK_MESSAGE_JSON_MAX_ARRAY = 256;

function cleanTaskMessageField(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s.length > 0 ? s : null;
}

function normalizeTaskMessageStatus(value: unknown): string | null {
  const s = cleanTaskMessageField(value);
  return s && TASK_MESSAGE_STATUSES.has(s) ? s : null;
}

function truncateUtf8(value: string | null, maxBytes: number): string | null {
  if (value == null) return null;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  // Cut on a char boundary at or below the limit, then flag the truncation.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const head = decoder.decode(bytes.slice(0, maxBytes)).replace(/�+$/, "");
  return head + "… [truncated]";
}

// Drop image/base64 payloads and cap depth/array width so a huge structured
// input/meta blob can't blow up the DB or the WS broadcast.
function sanitizeTaskMessageJson(value: unknown, depth = 0): unknown {
  if (depth > TASK_MESSAGE_JSON_MAX_DEPTH) return "[depth-limited]";
  if (value == null || typeof value !== "object") {
    if (typeof value === "string" && value.length > 4096 && /^[A-Za-z0-9+/=]+$/.test(value)) {
      return "[base64-elided]";
    }
    return value;
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, TASK_MESSAGE_JSON_MAX_ARRAY).map((v) => sanitizeTaskMessageJson(v, depth + 1));
    if (value.length > TASK_MESSAGE_JSON_MAX_ARRAY) out.push(`[+${value.length - TASK_MESSAGE_JSON_MAX_ARRAY} more]`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sanitizeTaskMessageJson(v, depth + 1);
  }
  return out;
}

function toTaskHumanRequest(row: Row): MultiremiTaskHumanRequest {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    kind: normalizeHumanRequestKind(row.kind),
    payload: parseJson(row.payload, {} as Record<string, unknown>) ?? {},
    status: normalizeHumanRequestStatus(row.status),
    response: row.response == null ? null : parseJson(row.response, null),
    respondedBy: nullableString(row.responded_by),
    createdAt: String(row.created_at),
    respondedAt: nullableString(row.responded_at),
  };
}

function normalizeHumanRequestKind(value: unknown): MultiremiTaskHumanRequestKind {
  return String(value ?? "") === "question" ? "question" : "permission";
}

function normalizeHumanRequestStatus(value: unknown): MultiremiTaskHumanRequestStatus {
  const status = String(value ?? "").trim();
  if (status === "pending" || status === "responded" || status === "timeout" || status === "cancelled") return status;
  return "cancelled";
}

function computeChatElapsedMs(task: MultiremiTask): number | null {
  const completedAt = task.completedAt ? Date.parse(task.completedAt) : Number.NaN;
  const createdAt = Date.parse(task.createdAt);
  if (!Number.isFinite(completedAt) || !Number.isFinite(createdAt)) return null;
  return Math.max(0, completedAt - createdAt);
}
