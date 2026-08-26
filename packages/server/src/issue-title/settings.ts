export const ISSUE_AUTO_TITLE_DEFAULT_MODEL = "gpt-5.6-luna";
const MODEL_ID_MAX_LENGTH = 200;

export interface IssueAutoTitleSettings {
  enabled: boolean;
  model: string;
}

export function resolveIssueAutoTitleSettings(
  settings: Record<string, unknown> | null | undefined,
): IssueAutoTitleSettings {
  const raw = settings?.issue_auto_title;
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const model = typeof value.model === "string" ? value.model.trim() : "";
  return {
    enabled: value.enabled !== false,
    model: model && model.length <= MODEL_ID_MAX_LENGTH ? model : ISSUE_AUTO_TITLE_DEFAULT_MODEL,
  };
}

export function sanitizeIssueAutoTitleSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(settings, "issue_auto_title")) return settings;
  const resolved = resolveIssueAutoTitleSettings(settings);
  return {
    ...settings,
    issue_auto_title: resolved,
  };
}
