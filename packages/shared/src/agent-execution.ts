/** Execution display data carried by persisted Task messages, not billing usage. */
export interface AgentExecutionDisplay {
  agentName?: string | null;
  provider?: string | null;
  model?: string | null;
  modelName?: string | null;
}

export interface ContextUsage {
  used: number;
  size: number | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function executionModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model && !["default", "auto", "unknown"].includes(model.toLowerCase()) ? model : null;
}

/** Accept both bridge config snapshots and the legacy single-option update. */
export function readExecutionModel(update: Record<string, unknown>): AgentExecutionDisplay | null {
  const options = Array.isArray(update.configOptions) ? update.configOptions : [];
  const option = options.map(record).find(item => item?.category === "model" || item?.id === "model");
  if (option) {
    const model = executionModel(option.currentValue);
    const choices = Array.isArray(option.options) ? option.options.flatMap(value => {
      const item = record(value);
      return Array.isArray(item?.options) ? item.options : [value];
    }) : [];
    const selected = choices.map(record).find(item => item?.value === model);
    return { model, modelName: model && typeof selected?.name === "string" ? selected.name : null };
  }
  if (update.id === "model") return { model: executionModel(update.value), modelName: null };
  if (update.sessionUpdate === "current_model_update") {
    return { model: executionModel(update.currentModelId), modelName: null };
  }
  return null;
}

/** ACP used/size is a latest snapshot; input/output/total tokens are NOT context. */
export function readContextUsage(value: unknown): ContextUsage | null {
  const meta = record(value);
  const usage = meta?.used !== undefined ? meta : record(meta?.usage) ?? meta;
  if (!usage || typeof usage.used !== "number" || !Number.isFinite(usage.used) || usage.used < 0) return null;
  const size = typeof usage.size === "number" && Number.isFinite(usage.size) && usage.size > 0 ? usage.size : null;
  return { used: usage.used, size };
}
