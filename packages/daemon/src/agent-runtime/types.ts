import type { IncomingMessage } from "@connectors/base.js";
import type { MediaAttachment } from "@shared/contracts/acp-protocol.js";
import type { AgentResponse, ProviderEvent } from "@shared/contracts/provider-types.js";
import type { SessionRow } from "@shared/db/sessions.js";
import type { MultiremiAgent } from "@multiremi/contracts/types.js";
import type { AgentTask } from "@daemon/contracts/types.js";
import type { LocalPathLocker } from "./workspace/ephemeral.js";
import type { AcpMcpServer } from "./mcp/ephemeral.js";
import type { PreparedAgentPluginRuntime } from "./agent-plugins/types.js";
import type { IssueSessionProviderHome } from "./workspace/session-home.js";

// ── AgentSessionConfig ───────────────────────────────────

export interface AgentSessionConfig {
  agentType: string;
  executable?: string;
  customArgs?: string[];
  model?: string | null;
  /** Reasoning effort for this turn (agent `thinking_level`); undefined = leave the agent's default. */
  effort?: string | null;
  cwd: string;
  env?: Record<string, string>;
  mcpServers: AcpMcpServer[];
  allowedTools?: string[];
  systemPrompt?: string;
  context?: string;
  sessionId?: string;
  chatId: string;
  media?: MediaAttachment[];
  addDirs?: string[];
  permissionMode: string | null;
  traceId?: string;
  signal?: AbortSignal;
  recovery?: RecoveryConfig;
  /** Provider-native Agent Plugin roots prepared for this execution. */
  pluginPaths?: string[];
  /** Immutable Plugin-set fingerprint; ACP session reuse requires an exact match. */
  pluginFingerprint?: string;
  /** Isolated Codex process home prepared beside the Issue worktrees. */
  codexHome?: string;
}

export interface RecoveryConfig {
  retryOnStaleSession: boolean;
  retryOnPromptTooLong: boolean;
  fallbackAgentType?: string | null;
  /**
   * Called when a recovery reset happens, before the provider session is
   * cleared — lets the caller drop any external session mapping it owns (e.g.
   * Remi's session DB). The provider's own session is cleared regardless.
   */
  onSessionReset?: () => void | Promise<void>;
}

// ── Runtime contexts ─────────────────────────────────────

export interface PersistentContext {
  kind: "persistent";
  message: IncomingMessage;
  agent: MultiremiAgent;
  sessionRow?: SessionRow | null;
  sessionKey: string;
  /** Deterministic Feishu topic directory, used only after stronger cwd sources. */
  topicCwd?: string | null;
}

export interface EphemeralContext {
  kind: "ephemeral";
  task: AgentTask;
  daemonOptions: EphemeralDaemonOptions;
  workDir: string;
  signal: AbortSignal;
  /** "ask" surfaces permission prompts to a human via the server; default is self-approved. */
  approvalMode?: "auto" | "ask";
  /** Async cache/materialization result prepared before synchronous assembly. */
  pluginRuntime?: PreparedAgentPluginRuntime;
  /** Provider-native config/session root owned by this Issue Session lane. */
  providerHome?: IssueSessionProviderHome;
  /** In-memory endpoint/auth overlay for an isolated provider home. */
  providerEnv?: Record<string, string>;
}

export interface EphemeralDaemonOptions {
  daemonPort: number;
  serverUrl: string;
  workspacesRoot: string;
}

export type RuntimeContext = PersistentContext | EphemeralContext;

// ── Capability block ─────────────────────────────────────

export interface CapabilityBlock {
  name: string;
  persistent?(ctx: PersistentContext): Partial<AgentSessionConfig>;
  ephemeral?(ctx: EphemeralContext): Partial<AgentSessionConfig>;
}

// ── AgentSession result ──────────────────────────────────

export interface AgentRunResult {
  response: AgentResponse | null;
  sessionId: string | null;
  text: string;
  thinking: string;
  /** Set when an auto-recovery retry happened (for tracing/observability). */
  recovered?: "prompt_too_long" | "stale_session" | null;
}
