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
import { appendGitCredentialBrokerEnv } from "../repo/credential-broker.js";
import { isSideConversation, SIDE_CONVERSATION_INSTRUCTIONS } from "../prompts/side-conversation.js";

export interface BuildTaskEnvOptions {
  /** Port of the daemon's local repo-checkout server. */
  daemonPort: number;
  /** Multiremi server URL forwarded to the agent. */
  serverUrl: string;
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
  // The child agent must only receive the capability minted for this task.
  // The daemon credential remains in the supervisor process so it can keep
  // heartbeating/registering, but it is never a fallback child credential.
  const taskAuthToken = task.authToken ?? task.auth_token;
  const scmRevision = (task.scmRevision ?? task.scm_revision)?.trim();
  const env = {
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
    ...(scmRevision ? { MULTIREMI_SCM_REVISION: scmRevision } : {}),
    ...(opts.workDir ? { MULTIREMI_WORKSPACE_ROOT: opts.workDir } : {}),
    MULTIREMI_SERVER_URL: opts.serverUrl,
    ...(opts.providerHome?.provider === "claude"
      ? { CLAUDE_CONFIG_DIR: opts.providerHome.home }
      : opts.providerHome?.provider === "codex"
        ? { CODEX_HOME: opts.providerHome.home }
        : {}),
    ...(taskAuthToken ? { MULTIREMI_TOKEN: taskAuthToken } : {}),
  };
  const brokerEnv = appendGitCredentialBrokerEnv(env, {
    serverUrl: opts.serverUrl,
    token: taskAuthToken,
    workspaceId: task.workspaceId,
    taskId: task.id,
    repositoryUrls: task.repos.map((repo) => repo.url),
  });
  // AcpProvider merges this overlay on top of the daemon process environment.
  // Keep an explicit tombstone so an inherited daemon token cannot reappear.
  if (!taskAuthToken) brokerEnv.MULTIREMI_TOKEN = "";
  if (agent?.provider === "codex" && isSideConversation(task)) {
    preserveSideCodexInstructions(brokerEnv);
  }
  return cleanProcessEnv(brokerEnv);
}

/** ACP sends CODEX_CONFIG as per-thread overrides, ahead of private config.toml. */
function preserveSideCodexInstructions(env: NodeJS.ProcessEnv): void {
  // An explicit empty value disables the machine override and must stay empty.
  const raw = env.CODEX_CONFIG !== undefined ? env.CODEX_CONFIG : process.env.CODEX_CONFIG;
  if (raw === undefined || raw === "") return;
  let config: unknown;
  try {
    config = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    // JSON parser errors can contain source text and credentials. Never forward
    // the parser's message or the raw config to task logs.
    throw new Error("Side conversation CODEX_CONFIG must be a valid JSON object");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Side conversation CODEX_CONFIG must be a valid JSON object");
  }
  if (!Object.prototype.hasOwnProperty.call(config, "developer_instructions")) return;
  const overrides = config as Record<string, unknown>;
  if (typeof overrides.developer_instructions !== "string") {
    throw new Error("Side conversation CODEX_CONFIG developer_instructions must be a string");
  }
  overrides.developer_instructions = [overrides.developer_instructions, SIDE_CONVERSATION_INSTRUCTIONS]
    .filter(Boolean).join("\n\n");
  env.CODEX_CONFIG = JSON.stringify(overrides);
}

/** Drop undefined values so the result is a string-only env for Bun.spawn. */
export function cleanProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) next[key] = value;
  }
  return next;
}
