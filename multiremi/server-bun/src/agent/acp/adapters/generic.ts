/**
 * GenericAcpAdapter — for agents that speak standard ACP without vendor quirks
 * (hermes, kimi, kiro, and other native-ACP CLIs). This collapses the per-agent
 * ACP logic that lived in the Go backend's hermes.go / kimi.go / kiro.go into a
 * single parameterized adapter (agentType + executable [+ optional _meta key]).
 */

import type {
  ToolCallUpdate,
  ToolCallProgressUpdate,
  NewSessionMeta,
} from "../protocol.js";
import type { AgentAdapter, AgentSessionOptions, AskUserQuestionData } from "./base.js";

export interface GenericAdapterConfig {
  agentType: string;
  executable: string;
  /** Launch args (e.g. ["--experimental-acp"] for gemini's ACP mode). */
  args?: string[];
  /** Wrap model/permission options under this _meta key on session/new. */
  metaKey?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export class GenericAcpAdapter implements AgentAdapter {
  readonly agentType: string;
  private readonly executable: string;
  private readonly args: string[];
  private readonly metaKey?: string;

  constructor(cfg: GenericAdapterConfig) {
    this.agentType = cfg.agentType;
    this.executable = cfg.executable;
    this.args = cfg.args ?? [];
    this.metaKey = cfg.metaKey;
  }

  resolveToolName(update: ToolCallUpdate | ToolCallProgressUpdate): string {
    const meta = asRecord(update._meta);
    const metaName = meta && typeof meta.toolName === "string" ? meta.toolName : undefined;
    const direct = (update as { toolName?: string | null }).toolName;
    return (
      metaName ??
      (typeof direct === "string" ? direct : undefined) ??
      update.title ??
      "unknown"
    );
  }

  extractToolInput(
    update: ToolCallUpdate | ToolCallProgressUpdate,
  ): Record<string, unknown> | undefined {
    return asRecord(update.rawInput);
  }

  extractResultPreview(update: ToolCallProgressUpdate): string | undefined {
    let preview: string | undefined;
    if (typeof update.rawOutput === "string") {
      preview = update.rawOutput;
    } else if (update.rawOutput != null) {
      try {
        preview = JSON.stringify(update.rawOutput);
      } catch {
        /* non-serializable output — fall through to content */
      }
    }
    if (!preview && Array.isArray(update.content)) {
      preview = update.content
        .map((c) => {
          const r = asRecord(c);
          const inner = asRecord(r?.content);
          if (inner && inner.type === "text" && typeof inner.text === "string") return inner.text;
          if (r && r.type === "text" && typeof r.text === "string") return r.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (!preview) return undefined;
    return preview.length > 800 ? preview.slice(0, 800) + "\n... (truncated)" : preview;
  }

  extractAskUserQuestion(toolCall: ToolCallProgressUpdate): AskUserQuestionData | null {
    if (this.resolveToolName(toolCall) !== "AskUserQuestion") return null;
    const input = asRecord(toolCall.rawInput);
    if (!input || !Array.isArray(input.questions)) return null;
    return { questions: input.questions as AskUserQuestionData["questions"] };
  }

  isExitPlanMode(toolCall: ToolCallProgressUpdate): boolean {
    return this.resolveToolName(toolCall) === "ExitPlanMode";
  }

  buildSessionMeta(options: AgentSessionOptions): NewSessionMeta | undefined {
    if (!this.metaKey) return undefined;
    const opts: Record<string, unknown> = {};
    if (options.model) opts.model = options.model;
    if (options.permissionMode) opts.permissionMode = options.permissionMode;
    if (Object.keys(opts).length === 0) return undefined;
    return { [this.metaKey]: { options: opts } } as unknown as NewSessionMeta;
  }

  defaultExecutable(): string {
    return this.executable;
  }

  defaultArgs(): string[] {
    return this.args;
  }
}
