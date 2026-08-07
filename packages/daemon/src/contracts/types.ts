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
  MultiremiSkillFile,
  MultiremiSkillImportSource,
  RunAutopilotInput,
} from "@multiremi/contracts/types.js";

// --- Task shape (prompts/ephemeral.ts, skills/ephemeral.ts) ----------------

/** Agent attached to a task (prompt + skill materialization). */
export interface AgentTaskAgent {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  instructions: string;
  skills: AgentTaskSkill[];

  // Spawn-context fields (workspace/ephemeral.ts cwd, env/injector.ts).
  cwd: string | null;
  executable: string | null;
  allowedTools: string[];
  customEnv: Record<string, string>;

  // Ephemeral per-task MCP servers (mcp/ephemeral.ts). Standard .mcp.json shape
  // (`{ mcpServers: {...} }`); parsed defensively. Optional + unknown so the
  // concrete MultiremiAgent stays structurally assignable.
  mcpConfig?: unknown | null;
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

/** Issue attached to a task. */
export interface AgentTaskIssue {
  id: string;
  key: string;
  title: string;
  description: string | null;
  metadata: Record<string, string | number | boolean>;
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
  repos: AgentTaskRepo[];

  // Workspace + spawn-context fields (workspace/persistent.ts, env/injector.ts).
  workDir: string | null;
  runtimeId: string | null;
  authToken?: string | null;
  auth_token?: string | null;

  // Claim-context fields (read via stringField/arrayField/unknownField).
  workspaceContext?: string | null;
  workspace_context?: string | null;
  requestingUserName?: string | null;
  requesting_user_name?: string | null;
  requestingUserProfileDescription?: string | null;
  requesting_user_profile_description?: string | null;
  chatMessage?: string | null;
  chat_message?: string | null;
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

/** Store surface the scheduler depends on (8 methods). */
export interface AutopilotStore {
  recoverLostScheduleTriggers(now?: Date): number;
  listAutopilots(workspaceId?: string | null): Autopilot[];
  listAutopilotTriggers(autopilotId: string): AutopilotTrigger[];
  claimDueScheduleTriggers(now?: Date): AutopilotTrigger[];
  advanceScheduleTriggerNextRun(triggerId: string, from?: Date): AutopilotTrigger | null;
  getAutopilot(id: string): Autopilot | null;
  runAutopilot(autopilotId: string, input?: RunAutopilotInput): AutopilotRun;
  pauseAutopilotsExceedingFailureThreshold(
    options?: AutopilotFailureThresholdOptions,
  ): AutopilotFailureThresholdCandidate[];
}
