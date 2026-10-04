import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { executionModel, readContextUsage, type AgentExecutionDisplay, type ContextUsage } from "@shared/agent-execution.js";
import { formatCardStats, formatExecutionSubtitle } from "./card-metadata.js";

/** Small display projection: never retains trace text, tool arguments or output. */
export class FeishuTaskMetadata {
  private execution: AgentExecutionDisplay;
  private context: ContextUsage | null = null;
  private readonly tools = new Set<string>();

  constructor(agentName?: string | null) { this.execution = { agentName }; }
  get agentName() { return this.execution.agentName; }

  accept(event: TraceEvent): void {
    // A resumed bundled stream can start at a result after its invocation was
    // acknowledged. Count that stable ID without counting its later deltas twice.
    if (event.type === "tool_use" || (event.type === "tool_result" && event.tool_call_id)) {
      this.tools.add(event.tool_call_id || `seq:${event.seq}`);
    }
    if (event.meta?.parent_tool_call_id) return;
    if (event.type === "usage") this.context = readContextUsage(event.meta) ?? this.context;
    if (event.type === "execution") {
      const info = event.meta ?? {};
      const model = Object.hasOwn(info, "model") ? executionModel(info.model) : undefined;
      if (model !== undefined && this.execution.model !== undefined && model !== this.execution.model) this.context = null;
      this.execution = { ...this.execution,
        ...(typeof info.agentName === "string" ? { agentName: info.agentName } : {}),
        ...(typeof info.provider === "string" ? { provider: info.provider } : {}),
        ...(model !== undefined ? { model, modelName: typeof info.modelName === "string" ? info.modelName : null } : {}) };
    }
  }

  render(elapsed: number) {
    return { agentName: this.execution.agentName, subtitle: formatExecutionSubtitle(this.execution),
      stats: formatCardStats(elapsed, this.context, this.tools.size) };
  }
}
