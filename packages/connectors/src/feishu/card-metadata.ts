import type { AgentExecutionDisplay, ContextUsage } from "@shared/agent-execution.js";

export function compactModelName(model: string): string {
  return model.trim().replace(/^anthropic[/:]/i, "").replace(/^claude[-\s]+/i, "")
    .replace(/[-\s]+/g, "").toLowerCase();
}

export function formatExecutionSubtitle(info: AgentExecutionDisplay): string | null {
  const provider = info.provider?.replace(/^acp:/, "");
  const engine = provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider;
  const model = info.model ? compactModelName(info.modelName || info.model) : "";
  return [info.agentName, engine, model].filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || null;
}

function formatCount(value: number): string {
  return value >= 1_000_000 ? `${Math.round(value / 100_000) / 10}M`
    : value >= 1_000 ? `${Math.round(value / 1_000)}k` : `${value}`;
}

export function formatCardStats(elapsed: number, context: ContextUsage | null, tools: number): string | null {
  return [
    elapsed > 0 ? `${elapsed}s` : "",
    context ? `${formatCount(context.used)}/${context.size == null ? "—" : formatCount(context.size)}` : "",
    tools > 0 ? `${tools} tools` : "",
  ].filter(Boolean).join(" · ") || null;
}
