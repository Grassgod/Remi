// https://code.claude.com/docs/en/model-config#extended-context
// Keep this list explicit: aliases and gateway IDs can resolve to older models.
const ONE_MILLION_MODELS = new Set([
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
]);

export function hasOneMillionContext(model: string): boolean {
  return /\[1m\]$/i.test(model.trim());
}

export function resolveClaudeContextModel(model: string | null, disableOneMillion?: string): string | null {
  if (!model || hasOneMillionContext(model) || disableOneMillion === "1") return model;
  const trimmed = model.trim();
  return ONE_MILLION_MODELS.has(trimmed.toLowerCase()) ? `${trimmed}[1m]` : model;
}
