/**
 * Agent adapter interface — abstracts agent-specific differences
 * (meta format, tool name resolution, session options) from the generic ACP layer.
 */

import type {
  ToolCallUpdate,
  ToolCallProgressUpdate,
  NewSessionMeta,
} from "../protocol.js";

export interface AgentAdapter {
  readonly agentType: string;

  /** Resolve the canonical tool name from an ACP tool_call event. */
  resolveToolName(update: ToolCallUpdate | ToolCallProgressUpdate): string;

  /** Extract structured tool input from an ACP event for display. */
  extractToolInput(update: ToolCallUpdate | ToolCallProgressUpdate): Record<string, unknown> | undefined;

  /** Extract a preview string from a completed tool_call_update. */
  extractResultPreview(update: ToolCallProgressUpdate): string | undefined;

  /** Check if a request_permission is an AskUserQuestion. */
  extractAskUserQuestion(toolCall: ToolCallProgressUpdate): AskUserQuestionData | null;

  /** Check if a request_permission is an ExitPlanMode. */
  isExitPlanMode(toolCall: ToolCallProgressUpdate): boolean;

  /** Build agent-specific _meta for session/new. */
  buildSessionMeta(options: AgentSessionOptions): NewSessionMeta | undefined;

  /** Default executable name for this agent type. */
  defaultExecutable(): string;

  /**
   * Default launch args for this agent type. Native-ACP CLIs that gate ACP
   * behind a flag (e.g. `gemini --experimental-acp`) return that flag here;
   * agents whose binary speaks ACP directly (bridges, hermes/kimi/kiro)
   * return [] / omit it.
   */
  defaultArgs?(): string[];
}

export interface AskUserQuestionData {
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

export interface AgentSessionOptions {
  model?: string | null;
  allowedTools?: string[];
  permissionMode?: string | null;
  additionalDirectories?: string[];
  [key: string]: unknown;
}
