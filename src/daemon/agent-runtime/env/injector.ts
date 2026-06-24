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

export interface BuildTaskEnvOptions {
  /** Port of the daemon's local repo-checkout server. */
  daemonPort: number;
  /** Multiremi server URL forwarded to the agent. */
  serverUrl: string;
  /** Token used when the task carries none of its own. */
  fallbackToken?: string | null;
}

/**
 * Build the spawn env for a task's agent process.
 *
 * The agent's custom env is the base; the Multiremi coordinates are layered on
 * top (so they win on key clashes, exactly as the inline code did). The token
 * key is only set when a token is available.
 */
export function buildTaskEnv(task: AgentTask, opts: BuildTaskEnvOptions): Record<string, string> {
  const agent = task.agent;
  const taskAuthToken = task.authToken ?? task.auth_token ?? opts.fallbackToken;
  return {
    ...agent?.customEnv,
    MULTIREMI_DAEMON_PORT: String(opts.daemonPort),
    MULTIREMI_WORKSPACE_ID: task.workspaceId,
    MULTIREMI_AGENT_NAME: agent?.name ?? "",
    MULTIREMI_TASK_ID: task.id,
    MULTIREMI_SERVER_URL: opts.serverUrl,
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
