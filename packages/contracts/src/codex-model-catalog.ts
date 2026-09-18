/** Native fields consumed by the selector and capability snapshot after validation. */
export interface CodexNativeModel extends Record<string, unknown> {
  slug: string;
  display_name: string;
  visibility: string;
  supported_in_api: boolean;
}

/**
 * Server discovery and the daemon must agree on whether Codex can load a native
 * catalog. One invalid entry rejects the entire document, even when that entry
 * is hidden, because model_catalog_json replaces the complete bundled catalog.
 * This only validates: callers keep the original document and all future fields.
 */
export function validCodexNativeCatalog(value: unknown): value is { models: CodexNativeModel[] } {
  return isPlainObject(value) && Array.isArray(value.models) && value.models.length > 0
    && value.models.every(validCodexNativeModel);
}

/** Check native required fields before Codex can discard the whole invalid config. */
function validCodexNativeModel(model: unknown): model is CodexNativeModel {
  if (!isPlainObject(model)) return false;
  for (const key of ["slug", "display_name", "shell_type", "visibility"]) {
    if (typeof model[key] !== "string" || !(model[key] as string).trim()) return false;
  }
  if (typeof model.supported_in_api !== "boolean" || typeof model.support_verbosity !== "boolean"
    || !Number.isInteger(model.priority)) return false;
  const policy = model.truncation_policy;
  if (!isPlainObject(policy) || typeof policy.mode !== "string" || !Number.isInteger(policy.limit)) return false;
  if (!Array.isArray(model.experimental_supported_tools) || !model.experimental_supported_tools.every(tool => typeof tool === "string")) return false;
  if (!Array.isArray(model.supported_reasoning_levels) || !model.supported_reasoning_levels.every(level =>
    isPlainObject(level) && typeof level.effort === "string" && Boolean(level.effort.trim())
      && typeof level.description === "string")) return false;
  if (model.default_reasoning_level != null && typeof model.default_reasoning_level !== "string") return false;
  if (model.context_window != null && !Number.isInteger(model.context_window)) return false;
  if (model.input_modalities !== undefined
    && (!Array.isArray(model.input_modalities) || !model.input_modalities.every(modality => typeof modality === "string"))) return false;
  if (model.base_instructions !== undefined && typeof model.base_instructions !== "string") return false;
  if (model.model_messages != null && !isPlainObject(model.model_messages)) return false;
  const messages = isPlainObject(model.model_messages) ? model.model_messages : {};
  if (messages.instructions_template !== undefined && typeof messages.instructions_template !== "string") return false;
  return typeof model.base_instructions === "string" || typeof messages.instructions_template === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
