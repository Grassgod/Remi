import { isTraceEvent, type TraceEvent, type TraceTurn } from "@multiremi/contracts/trace.js";
import { executionModel, readContextUsage, type AgentExecutionDisplay, type ContextUsage } from "@shared/agent-execution.js";
import { isToolItem } from "@shared/turn-trace.js";
import { formatCardStats, formatExecutionSubtitle } from "./card-metadata.js";

/**
 * Provider of the synthetic turn a host command reply (`/new`, `/stop`, ...)
 * is wrapped in. The bot host answers it itself, so the card names no engine.
 */
export const FEISHU_COMMAND_PROVIDER = "remi-command";

/**
 * Result-card footer and subtitle from the turn: model and context from
 * `turn.started` / `turn.updated` / `turn.completed`, the tool count from
 * `turn.stats.tool_call_count`. Small display projection: never retains trace
 * text, tool arguments or output.
 */
export class FeishuTaskMetadata {
  private execution: AgentExecutionDisplay;
  private context: ContextUsage | null = null;
  /** Tool item IDs at any depth, for a trace that closes without `turn.completed`. */
  private readonly tools = new Set<string>();
  private toolCallCount: number | null = null;
  private durationMs: number | null = null;
  private turnCompleted = false;

  constructor(agentName?: string | null) { this.execution = { agentName }; }
  get agentName() { return this.execution.agentName; }
  /** True once `turn.completed` supplied the final model, context and tool count. */
  get completed(): boolean { return this.turnCompleted; }
  /** Attempt duration from `turn.completed`, in whole seconds. */
  get durationSeconds(): number | undefined {
    return this.durationMs === null ? undefined : Math.round(this.durationMs / 1000);
  }

  accept(event: TraceEvent): void {
    if (!isTraceEvent(event)) return;
    switch (event.type) {
      case "turn.started":
        this.adopt(event.turn);
        break;
      case "turn.updated": {
        const patch = event.patch;
        if (typeof patch.agent_name === "string") this.execution = { ...this.execution, agentName: patch.agent_name };
        if (patch.model !== undefined) this.execution = { ...this.execution, model: executionModel(patch.model), modelName: null };
        if (patch.context_usage !== undefined) this.context = readContextUsage(patch.context_usage);
        break;
      }
      case "turn.completed":
        this.adopt(event.turn);
        this.toolCallCount = event.turn.stats.tool_call_count;
        this.durationMs = event.turn.duration_ms;
        this.turnCompleted = true;
        break;
      default:
        if (event.type !== "item.delta" && isToolItem(event.item)) this.tools.add(event.item.id);
    }
  }

  private adopt(turn: TraceTurn): void {
    this.execution = {
      agentName: turn.agent_name ?? this.execution.agentName,
      provider: turn.provider === FEISHU_COMMAND_PROVIDER ? null : turn.provider,
      model: executionModel(turn.model),
      modelName: null,
    };
    this.context = readContextUsage(turn.context_usage);
  }

  render(elapsed: number) {
    return { agentName: this.execution.agentName, subtitle: formatExecutionSubtitle(this.execution),
      stats: formatCardStats(elapsed, this.context, this.toolCallCount ?? this.tools.size) };
  }
}
