/**
 * Connector protocol and shared types.
 */

import type { AgentResponse, ProviderEvent } from "@shared/provider-types.js";
import type { MediaAttachment } from "@shared/acp-protocol.js";

/** A message received from any connector. */
export interface IncomingMessage {
  text: string;
  chatId: string;
  sender?: string;
  connectorName?: string;
  media?: MediaAttachment[];
  metadata?: Record<string, unknown>;
}

/** Callback type: core Remi.handleMessage (blocking, returns full response) */
export type MessageHandler = (msg: IncomingMessage) => Promise<AgentResponse>;

/**
 * Callback type: core Remi.handleMessageStream (real-time streaming).
 * Uses callback pattern so the lane lock covers the entire consumer lifecycle
 * (including card close + notifications), preventing concurrent message overlap.
 */
/** Metadata passed alongside the stream to the consumer. */
export interface StreamMeta {
  /** Existing sessionId if resuming, null for brand-new sessions. */
  sessionId?: string | null;
  /** Display name from session registry (e.g. "好奇的 Remi·Vulpes"). */
  displayName?: string | null;
  /** Selected provider name, e.g. "acp:claude" or "acp:codex". */
  providerName?: string | null;
  /** ACP agent type used by the selected provider, e.g. "claude" or "codex". */
  agentType?: string | null;
  /** Permission / approval mode, e.g. "auto", "plan", "bypassPermissions". */
  mode?: string | null;
  /** Register a handler for permission requests (tool approval, AskUserQuestion, ExitPlanMode). */
  setPermissionHandler?: (handler: (params: import("../providers/acp/protocol.js").RequestPermissionParams) => Promise<import("../providers/acp/protocol.js").PermissionOutcome>) => void;
  /** Register a handler for form elicitation requests (AskUserQuestion on Claude ACP >= 0.44.0). */
  setElicitationHandler?: (handler: (params: import("../providers/acp/protocol.js").ElicitationCreateParams) => Promise<import("../providers/acp/protocol.js").ElicitationResult>) => void;
}

export type StreamingHandler = (
  msg: IncomingMessage,
  consumer: (stream: AsyncIterable<ProviderEvent>, meta: StreamMeta) => Promise<void>,
) => Promise<void>;

/** Protocol that all input connectors must implement. */
export interface Connector {
  readonly name: string;

  /** Start listening for messages. Receives both blocking and streaming handlers. */
  start(handler: MessageHandler, streamHandler?: StreamingHandler): Promise<void>;

  /** Gracefully stop the connector. */
  stop(): Promise<void>;

  /** Send a response back to the given chat. */
  reply(chatId: string, response: AgentResponse): Promise<void>;
}
