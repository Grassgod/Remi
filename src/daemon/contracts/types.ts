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
 * Behavior is unchanged — these are type-only declarations.
 */

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
  chatSessionId: string | null;
  autopilotRunId: string | null;
  completedAt: string | null;
  createdAt: string;

  agent: AgentTaskAgent | null;
  issue: AgentTaskIssue | null;
  project: AgentTaskProject | null;
  projectResources: AgentTaskProjectResource[];
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

export type SkillImportSource = "github" | "skills_sh" | "clawhub";

export interface SkillImportFile {
  id?: string;
  skillId?: string;
  path: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateSkillInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  name: string;
  description?: string;
  content?: string;
  config?: Record<string, unknown> | null;
  files?: SkillImportFile[];
  createdBy?: string | null;
  created_by?: string | null;
}

export interface ImportSkillInput {
  url?: string;
  sourceUrl?: string;
  source_url?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  name?: string | null;
  description?: string | null;
  createdBy?: string | null;
  created_by?: string | null;
}

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

export interface RunAutopilotInput {
  source?: string;
  prompt?: string | null;
  payload?: unknown | null;
}

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
