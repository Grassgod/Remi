const MODEL_ID_MAX_LENGTH = 200;
export type WorkspaceProgressSummaryTransport = "auto" | "api" | "cli" | "openai";
const TRANSPORTS = new Set<WorkspaceProgressSummaryTransport>(["auto", "api", "cli", "openai"]);

export interface WorkspaceProgressSummaryPolicy {
  transport?: WorkspaceProgressSummaryTransport;
  model?: string;
  openAiModel?: string;
}

/** Resolve the non-secret progress summary settings distributed to daemons. */
export function resolveWorkspaceProgressSummaryPolicy(
  settings: Record<string, unknown> | null | undefined,
): WorkspaceProgressSummaryPolicy {
  const progress = objectField(settings, "progress_summary")
    ?? objectField(settings, "progressSummary");
  if (!progress) return {};

  const transport = transportField(progress.transport);
  const model = modelField(progress.model);
  const openAiModel = modelField(progress.openai_model ?? progress.openAiModel);
  return {
    ...(transport ? { transport } : {}),
    ...(model ? { model } : {}),
    ...(openAiModel ? { openAiModel } : {}),
  };
}

/** Keep progress summary settings safe for persistence and daemon broadcast. */
export function sanitizeWorkspaceProgressSummarySettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  if (!hasOwn(settings, "progress_summary") && !hasOwn(settings, "progressSummary")) {
    return settings;
  }
  const policy = resolveWorkspaceProgressSummaryPolicy(settings);
  const sanitized = { ...settings };
  delete sanitized.progress_summary;
  delete sanitized.progressSummary;
  sanitized.progress_summary = {
    ...(policy.transport ? { transport: policy.transport } : {}),
    ...(policy.model ? { model: policy.model } : {}),
    ...(policy.openAiModel ? { openai_model: policy.openAiModel } : {}),
  };
  return sanitized;
}

function objectField(
  value: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const field = value?.[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? field as Record<string, unknown>
    : null;
}

function transportField(value: unknown): WorkspaceProgressSummaryTransport | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase() as WorkspaceProgressSummaryTransport;
  return TRANSPORTS.has(normalized) ? normalized : null;
}

function modelField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= MODEL_ID_MAX_LENGTH ? normalized : null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
