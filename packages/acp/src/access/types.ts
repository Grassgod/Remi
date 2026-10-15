/**
 * Access configs (ARCH §3.2): per-agent launch, environment and capability
 * facts the provider consults instead of branching on an agent name. Only
 * agents whose integration differs from the npm bridges declare one; Claude and
 * Codex keep their existing adapter-driven paths.
 */

export interface AcpLaunchCommand {
  executable: string;
  args: string[];
}

export interface AcpAccessEnvInput {
  /** The session (lane) provider home; native transcripts and settings live here. */
  home: string;
  /** Loopback gateway base URL the agent calls instead of the real gateway. */
  shimUrl: string;
  model: string | null;
  /** The environment the agent process would otherwise inherit (the daemon's). */
  daemonEnv: NodeJS.ProcessEnv;
  /** The pinned launch, when Remi resolved it (not an Agent `executable` override). */
  launch?: AcpLaunchCommand | null;
}

export interface AcpAccessConfig {
  readonly agentType: string;
  /** Pinned launch when the Agent has no `executable` override; throws with instructions when absent. */
  launch(): AcpLaunchCommand;
  /** The fast, spawn-free daemon-start health check of the pinned launch: a reason, or null. */
  healthProblem(): string | null;
  /** Agent `executable` basenames that point at a retired integration. */
  readonly retiredExecutables: readonly string[];
  /** The process environment overlay; applied after the Agent's own env, so it wins. */
  buildEnv(input: AcpAccessEnvInput): Record<string, string>;
  /** Used when neither the task nor the Agent names a permission mode. */
  readonly defaultPermissionMode: string;
  /** An explicit model the agent cannot select fails instead of running another model. */
  readonly strictModel: boolean;
  /** A turn without any model fails: the agent would silently pick one. */
  readonly modelRequired: boolean;
  /** `none`: this access mode has no effort selector, so an explicit effort fails. */
  readonly effort: "selector" | "none";
  /** `gateway-shim`: billing and context come from shim observations, never from native `usage_update`. */
  readonly usage: "bridge" | "gateway-shim";
  /** Native context window to assume until the agent reports one. */
  readonly defaultContextWindow: number;
  /** Single-choice questions the agent sends as `session/request_permission` become elicitations. */
  readonly permissionQuestions: boolean;
  /** Workspace-trust prompts (repository hooks) are answered `deny`. */
  readonly denyWorkspaceTrust: boolean;
  /** Vendor service messages in `agent_message_chunk` become typed failures or notices. */
  readonly serviceMessages: boolean;
  /** The provider home is required: the environment builder derives the agent home from it. */
  readonly requiresHome: boolean;
  /**
   * Fail a turn that shows no agent update, no model call in flight, no
   * blocking tool call and no pending permission or question for this long;
   * null disables the watchdog. Needs the gateway shim (model calls in flight).
   */
  readonly turnStallTimeoutMs: number | null;
}
