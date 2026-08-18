/**
 * Agent-runtime environment injector.
 *
 * Builds the environment variable map handed to the spawned ACP process for a
 * task (Multiremi daemon/workspace coordinates merged over the agent's custom
 * env) and sanitizes a process env into a string-only record for Bun.spawn.
 * Extracted verbatim from src/multiremi/worker/daemon.ts in D6 (behavior
 * unchanged).
 */

import type { AgentTask } from "@daemon/contracts/types.js";
import type { IssueSessionProviderHome } from "../workspace/session-home.js";

export interface BuildTaskEnvOptions {
  /** Port of the daemon's local repo-checkout server. */
  daemonPort: number;
  /** Multiremi server URL forwarded to the agent. */
  serverUrl: string;
  /** Token used when the task carries none of its own. */
  fallbackToken?: string | null;
  /** Resolved task workspace, independent of the agent's current repo cwd. */
  workDir?: string;
  /** Issue Session-scoped provider config/history root. */
  providerHome?: IssueSessionProviderHome;
  /** Daemon-resolved provider endpoint/auth; never persisted in the workspace. */
  providerEnv?: Record<string, string>;
}

/**
 * Build the spawn env for a task's agent process.
 *
 * The workspace env (claim payload) is the base, the agent's custom env is
 * layered over it, and the Multiremi coordinates go on top (so they win on key
 * clashes). Merged over the daemon machine env at spawn, this yields the
 * documented precedence: agent customEnv > workspace env > machine env. The
 * token key is only set when a token is available.
 */
export function buildTaskEnv(task: AgentTask, opts: BuildTaskEnvOptions): Record<string, string> {
  const agent = task.agent;
  const taskAuthToken = task.authToken ?? task.auth_token ?? opts.fallbackToken;
  return {
    ...(task.workspaceEnv ?? task.workspace_env),
    ...agent?.customEnv,
    ...opts.providerEnv,
    MULTIREMI_DAEMON_PORT: String(opts.daemonPort),
    MULTIREMI_WORKSPACE_ID: task.workspaceId,
    MULTIREMI_AGENT_NAME: agent?.name ?? "",
    MULTIREMI_TASK_ID: task.id,
    ...(task.project?.id ? { MULTIREMI_PROJECT_ID: task.project.id } : {}),
    ...((task.issueId ?? task.issue_id) ? { MULTIREMI_ISSUE_ID: String(task.issueId ?? task.issue_id) } : {}),
    ...((task.issueSessionId ?? task.issue_session_id)
      ? { MULTIREMI_ISSUE_SESSION_ID: String(task.issueSessionId ?? task.issue_session_id) }
      : {}),
    ...(opts.workDir ? { MULTIREMI_WORKSPACE_ROOT: opts.workDir } : {}),
    MULTIREMI_SERVER_URL: opts.serverUrl,
    ...(opts.providerHome?.provider === "claude"
      ? { CLAUDE_CONFIG_DIR: opts.providerHome.home }
      : opts.providerHome?.provider === "codex"
        ? { CODEX_HOME: opts.providerHome.home }
        : {}),
    ...(taskAuthToken ? { MULTIREMI_TOKEN: taskAuthToken } : {}),
  };
}

/** Drop undefined values so the result is a string-only env for Bun.spawn. */
export function cleanProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) next[key] = value;
  }
  return next;
}
