import type { IncomingMessage } from "@connectors/base.js";
import type { MediaAttachment, RequestPermissionParams, PermissionOutcome, ElicitationCreateParams, ElicitationResult } from "@shared/contracts/acp-protocol.js";
import type { AgentResponse, ProviderEvent } from "@shared/contracts/provider-types.js";
import type { RemiConfig } from "@shared/config.js";
import type { SessionRow } from "@shared/db/sessions.js";
import type { GroupConfig } from "@remi/group/model.js";
import type { MemoryStore } from "@memory/store.js";
import type { AgentTask } from "@daemon/contracts/types.js";
import type { LocalPathLocker } from "./workspace/ephemeral.js";
import type { AcpMcpServer } from "./mcp/ephemeral.js";

// ── Capability output types ──────────────────────────────

export type PermissionHandler = (params: RequestPermissionParams) => Promise<PermissionOutcome>;
export type ElicitationHandler = (params: ElicitationCreateParams) => Promise<ElicitationResult>;

// ── AgentSessionConfig ───────────────────────────────────

export interface AgentSessionConfig {
  agentType: string;
  executable?: string;
  model?: string | null;
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
  permissionHandler: PermissionHandler | null;
  elicitationHandler: ElicitationHandler | null;
  traceId?: string;
  signal?: AbortSignal;
  recovery?: RecoveryConfig;
}

export interface RecoveryConfig {
  retryOnStaleSession: boolean;
  retryOnPromptTooLong: boolean;
  fallbackAgentType?: string | null;
}

// ── Runtime contexts ─────────────────────────────────────

export interface PersistentContext {
  kind: "persistent";
  message: IncomingMessage;
  config: RemiConfig;
  groupConfig?: GroupConfig | null;
  memory: MemoryStore;
  sessionRow?: SessionRow | null;
  sessionKey: string;
}

export interface EphemeralContext {
  kind: "ephemeral";
  task: AgentTask;
  daemonOptions: EphemeralDaemonOptions;
  workDir: string;
  signal: AbortSignal;
}

export interface EphemeralDaemonOptions {
  daemonPort: number;
  serverUrl: string;
  fallbackToken?: string | null;
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
}
