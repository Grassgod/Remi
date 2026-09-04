/**
 * Daemon-local contracts (L2).
 *
 * Dependency inversion: the daemon agent-runtime (prompts/skills/repo ephemeral
 * writers, scheduler) consumes task / repo / autopilot / store shapes, but must
 * not import upward from multiremi (L3). These interfaces capture EXACTLY what
 * the daemon code reads. The concrete multiremi types (MultiremiTaskWithAgent,
 * MultiremiStore, ...) structurally satisfy them at the injection sites, so no
 * multiremi runtime/import changes are needed.
 *
 * Shapes that are already single-sourced in @multiremi/contracts (the L0
 * protocol package, not the multiremi server) are re-exported from here rather
 * than redeclared, so the daemon and the server never drift apart.
 *
 * Behavior is unchanged — these are type-only declarations.
 */

import type {
  CreateSkillInput,
  ImportSkillInput,
  MultiremiBoundIssue,
  MultiremiSkillFile,
  MultiremiSkillImportSource,
  RunAutopilotInput,
} from "@multiremi/contracts/types.js";
import type { AgentPluginSnapshot } from "../agent-runtime/agent-plugins/types.js";

// --- Task shape (prompts/ephemeral.ts, skills/ephemeral.ts) ----------------

/** Agent attached to a task (prompt + skill materialization). */
export interface AgentTaskAgent {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  /**
   * Runtime-native reasoning effort (`thinking_level` on the wire), applied
   * through the agent's effort config option. `""`/null means "no override".
   */
  thinkingLevel?: string | null;
  instructions: string;
  skills: AgentTaskSkill[];

  // Spawn-context fields; workspace resolution owns the working directory.
  executable: string | null;
  allowedTools: string[];
  customEnv: Record<string, string>;
  customArgs?: string[];

  // Ephemeral per-task MCP servers (mcp/ephemeral.ts). Standard .mcp.json shape
  // (`{ mcpServers: {...} }`); parsed defensively. Optional + unknown so the
  // concrete MultiremiAgent stays structurally assignable.
  mcpConfig?: unknown | null;

  // Wire convenience only. Task execution must prefer AgentTask.pluginSnapshot,
  // which the server freezes atomically when the task is claimed.
  plugins?: AgentPluginSnapshot[];
}

/** Skill materialized into the task workdir. */
export interface AgentTaskSkill {
  name: string;
  description?: string;
  content: string;
  files?: AgentTaskSkillFile[];
}

export interface AgentTaskSkillFile {
  path: string;
  content?: string;
}

export interface AgentTaskAttachment {
  id: string;
  filename?: string;
  contentType?: string;
  content_type?: string;
  sizeBytes?: number;
  size_bytes?: number;
}

/** Issue attached to a task. */
export interface AgentTaskIssue {
  id: string;
  key: string;
  title: string;
  description: string | null;
  metadata: Record<string, string | number | boolean>;
  issueKind?: "execution" | "intake";
  sourceIssueId?: string | null;
  attachments?: AgentTaskAttachment[];
}

export interface AgentTaskIssueSession {
  id: string;
  issueId?: string;
  issue_id?: string;
  title: string;
  summary?: string | null;
}

export interface AgentTaskSessionProjection {
  sessionId?: string;
  session_id?: string;
  targetAgentId?: string;
  target_agent_id?: string;
  mode: "bootstrap" | "delta";
  fromSeq?: number;
  from_seq?: number;
  toSeq?: number;
  to_seq?: number;
  jsonl: string;
  truncated?: boolean;
  omittedEvents?: number;
  omitted_events?: number;
  estimatedTokens?: number;
  estimated_tokens?: number;
}

export interface AgentTaskIssueSessionResult {
  id: string;
  sourceSessionId?: string;
  source_session_id?: string;
  title?: string;
  body: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  created_at?: string;
}

/** Project attached to a task. */
export interface AgentTaskProject {
  id: string;
  title: string;
  description: string | null;
  /** Project-level rules injected only when bootstrapping a provider session. */
  instructions?: string;
  /** Project-level rules injected on subsequent provider-session turns. */
  deltaInstructions?: string;
  delta_instructions?: string;
}

/** Project resource entry (github_repo / local_directory / ...). */
export interface AgentTaskProjectResource {
  id: string;
  resourceType: string;
  resourceRef: Record<string, unknown>;
  label: string | null;
}

/** Project knowledge entry (wiki page / memory fact) injected into the prompt. */
export interface AgentTaskProjectDocEntry {
  id: string;
  slug: string;
  path?: string;
  title: string;
  summary?: string | null;
  /** memory entries carry a trimmed body; wiki entries are null. */
  body?: string | null;
  kind: string;
  pinned?: boolean;
  sourceIssueId?: string | null;
  source_issue_id?: string | null;
  updatedAt?: string;
  updated_at?: string;
}

/** Project knowledge index attached to task dispatch. */
export interface AgentTaskProjectDocsIndex {
  memory: AgentTaskProjectDocEntry[];
  wiki: AgentTaskProjectDocEntry[];
  /** Trimmed body of the project's `_schema` wiki page; null when the project has none. */
  schema?: string | null;
}

export interface AgentTaskProjectDoc {
  id: string;
  projectId?: string;
  workspaceId?: string;
  kind: "wiki" | "memory";
  slug: string;
  path?: string;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
  pinned: boolean;
  refs?: Array<{ type: string; value: string }>;
  version?: number;
  updatedAt: string;
}

export interface AgentTaskProjectContext {
  project: AgentTaskProject;
  resources: AgentTaskProjectResource[];
  docs: AgentTaskProjectDoc[];
  repos: AgentTaskRepo[];
}

export interface AgentTaskRepositoryWikiDoc {
  id: string;
  repositoryId?: string;
  workspaceId?: string;
  path: string;
  slug: string;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
  refs?: Array<{ type: string; value: string }>;
  sourceRevision?: string | null;
  status?: string;
  statusMessage?: string | null;
  status_message?: string | null;
  syncStatus?: string | null;
  sync_status?: string | null;
  syncError?: string | null;
  sync_error?: string | null;
  version?: number;
  updatedAt: string;
}

export interface AgentTaskRepositoryWikiContext {
  repository: {
    id: string;
    name: string;
    url: string;
    defaultBranch: string | null;
  };
  docs: AgentTaskRepositoryWikiDoc[];
}

export interface AgentTaskSquadContext {
  id: string;
  name: string;
  leaderAgentId: string;
  instructions?: string | null;
  members: Array<{
    agentId: string;
    name: string;
    role: string;
    description?: string | null;
  }>;
}

/** Repo available to a task. */
export interface AgentTaskRepo {
  url: string;
  description?: string;
}

/**
 * Task shape consumed by the daemon agent-runtime.
 *
 * Every field below is read directly or addressed via the camelCase/snake_case
 * field helpers in prompts/ephemeral.ts — `keyof AgentTask` must therefore
 * include every key those helpers pass. Optional where the daemon guards with
 * `?.` / `??`, matching the concrete MultiremiTaskWithAgent so it stays
 * structurally assignable.
 */
export interface AgentTask {
  id: string;
  workspaceId: string;
  prompt: string;

  issueId: string | null;
  issue_id?: string | null;
  issueSessionId?: string | null;
  issue_session_id?: string | null;
  issueSessionGeneration?: number | null;
  issue_session_generation?: number | null;
  /** Whether this task owns the shared Issue workspace. Missing means true for older servers. */
  holdsWorkspace?: boolean;
  holds_workspace?: boolean;
  chatSessionId: string | null;
  autopilotRunId: string | null;
  completedAt: string | null;
  createdAt: string;

  agent: AgentTaskAgent | null;
  issue: AgentTaskIssue | null;
  issueSession?: AgentTaskIssueSession | null;
  issue_session?: AgentTaskIssueSession | null;
  sessionProjection?: AgentTaskSessionProjection | null;
  session_projection?: AgentTaskSessionProjection | null;
  issueSessionResults?: AgentTaskIssueSessionResult[];
  issue_session_results?: AgentTaskIssueSessionResult[];
  project: AgentTaskProject | null;
  projectResources: AgentTaskProjectResource[];
  projectDocs?: AgentTaskProjectDocsIndex | null;
  project_docs?: AgentTaskProjectDocsIndex | null;
  /** Full Wiki bodies transported outside the prompt for local workspace materialization. */
  projectWikiDocs?: AgentTaskProjectDoc[];
  project_wiki_docs?: AgentTaskProjectDoc[];
  repositoryWikiContexts?: AgentTaskRepositoryWikiContext[];
  repository_wiki_contexts?: AgentTaskRepositoryWikiContext[];
  projectContexts?: AgentTaskProjectContext[];
  project_contexts?: AgentTaskProjectContext[];
  squadContext?: AgentTaskSquadContext | null;
  squad_context?: AgentTaskSquadContext | null;
  repos: AgentTaskRepo[];

  /** Exact immutable Agent Plugin versions frozen for this execution. */
  pluginSnapshot?: AgentPluginSnapshot[];
  plugin_snapshot?: AgentPluginSnapshot[];
  /** Capability fingerprint frozen by the server; snake_case accepted on wire. */
  executionFingerprint?: string | null;
  execution_fingerprint?: string | null;

  // Workspace + spawn-context fields (workspace/persistent.ts, env/injector.ts).
  workDir: string | null;
  runtimeId: string | null;
  authToken?: string | null;
  auth_token?: string | null;

  // Claim-context fields (read via stringField/arrayField/unknownField).
  workspaceContext?: string | null;
  workspace_context?: string | null;
  workspaceBootstrapPrompt?: string | null;
  workspace_bootstrap_prompt?: string | null;
  workspaceDeltaPrompt?: string | null;
  workspace_delta_prompt?: string | null;
  /** Workspace-level env (env/injector.ts): below agent customEnv, above machine env. */
  workspaceEnv?: Record<string, string>;
  workspace_env?: Record<string, string>;
  requestingUserName?: string | null;
  requesting_user_name?: string | null;
  requestingUserProfileDescription?: string | null;
  requesting_user_profile_description?: string | null;
  chatMessage?: string | null;
  chat_message?: string | null;
  boundIssueUpdates?: string[];
  bound_issue_updates?: string[];
  boundIssueUpdatesOmittedCount?: number;
  bound_issue_updates_omitted_count?: number;
  /** Safe identity of the Issue attached to this Chat, not task ownership. */
  boundIssue?: MultiremiBoundIssue | null;
  bound_issue?: MultiremiBoundIssue | null;
  chatBootstrapTranscript?: string | null;
  chat_bootstrap_transcript?: string | null;
  chatMessageAttachments?: unknown[];
  chat_message_attachments?: unknown[];
  autopilotTitle?: string | null;
  autopilot_title?: string | null;
  autopilotDescription?: string | null;
  autopilot_description?: string | null;
  autopilotSource?: string | null;
  autopilot_source?: string | null;
  autopilotTriggerPayload?: unknown | null;
  autopilot_trigger_payload?: unknown | null;
  scmRevision?: string | null;
  scm_revision?: string | null;
  quickCreatePrompt?: string | null;
  quick_create_prompt?: string | null;

  // Triggering-comment fields.
  triggerCommentId: string | null;
  trigger_comment_id?: string | null;
  triggerThreadId?: string | null;
  trigger_thread_id?: string | null;
  triggerCommentContent?: string | null;
  trigger_comment_content?: string | null;
  triggerSummary: string | null;
  trigger_summary?: string | null;
  triggerAuthorType?: string | null;
  trigger_author_type?: string | null;
  triggerAuthorName?: string | null;
  trigger_author_name?: string | null;
  triggerCommentAttachments?: unknown[];
  trigger_comment_attachments?: unknown[];
  newCommentsSince?: string | null;
  new_comments_since?: string | null;
  newCommentCount?: number | null;
  new_comment_count?: number | null;
  priorSessionId?: string | null;
  prior_session_id?: string | null;
  sessionId: string | null;
  session_id?: string | null;
}

// --- Repo cache shape (repo/checkout.ts) -----------------------------------

/** Repo to materialize into the repo cache / worktree. */
export interface RepoSpec {
  url: string;
  description?: string;
}

// --- Skill import (skills/skill-import.ts) ---------------------------------

export type {
  CreateSkillInput,
  ImportSkillInput,
  MultiremiSkillFile as SkillImportFile,
  MultiremiSkillImportSource as SkillImportSource,
};

// --- Autopilot + store shapes (scheduler.ts) -------------------------------

export interface Autopilot {
  id: string;
  status: string;
  triggerKind: string;
  triggerLabel: string | null;
  cronExpression: string | null;
}

export interface AutopilotTrigger {
  id: string;
  autopilotId: string;
  kind: string;
  cronExpression: string | null;
  timezone: string | null;
  label: string | null;
}

export interface AutopilotRun {
  id: string;
  autopilotId: string;
  source: string;
  status: string;
  issueId: string | null;
  taskId: string | null;
  triggerId: string | null;
  eventId: string | null;
  issueSessionId: string | null;
  triggeredAt: string;
  completedAt: string | null;
  failureReason: string | null;
  payload: unknown | null;
  result: unknown | null;
  createdAt: string;
}

export interface AutopilotFailureThresholdOptions {
  since?: Date | string;
  lookbackMs?: number;
  minRuns?: number;
  failRatioThreshold?: number;
  workspaceId?: string | null;
}

export interface AutopilotFailureThresholdCandidate {
  autopilot: Autopilot;
  totalRuns: number;
  failedRuns: number;
  failRatio: number;
}

export type { RunAutopilotInput };

/** Store surface the scheduler depends on. */
export interface AutopilotStore {
  recoverLostScheduleTriggers(now?: Date): number;
  recoverLostRuntimeProvisionSchedules(now?: Date): number;
  listAutopilots(workspaceId?: string | null): Autopilot[];
  listAutopilotTriggers(autopilotId: string): AutopilotTrigger[];
  claimDueScheduleTriggers(now?: Date): AutopilotTrigger[];
  advanceScheduleTriggerNextRun(triggerId: string, from?: Date): AutopilotTrigger | null;
  claimDueRuntimeProvisions(now?: Date): Array<{ id: string }>;
  enqueueWorkspaceRuntimeProvision(provisionId: string): number;
  advanceRuntimeProvisionNextRun(provisionId: string, from?: Date): { id: string } | null;
  getAutopilot(id: string): Autopilot | null;
  runAutopilot(autopilotId: string, input?: RunAutopilotInput): AutopilotRun;
  dispatchPendingSystemEvents(now?: Date, limit?: number): AutopilotRun[];
  dispatchPendingScmEvents(now?: Date, limit?: number): AutopilotRun[];
  pauseAutopilotsExceedingFailureThreshold(
    options?: AutopilotFailureThresholdOptions,
  ): AutopilotFailureThresholdCandidate[];
  archiveEligibleIssues(now?: Date): Array<{ id: string }>;
  issueArchiveSweepIntervalMs(): number;
}
