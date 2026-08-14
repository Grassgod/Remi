import type {
  RuntimeModel,
  RuntimeModelThinkingLevel,
} from "@multiremi/core/types";

export function getModelThinkingLevels(
  models: RuntimeModel[],
  model: string,
): RuntimeModelThinkingLevel[] {
  const selected = model
    ? models.find((entry) => entry.id === model)
    : models.find((entry) => entry.default);
  return selected?.thinking?.supported_levels ?? [];
}

export function supportsThinkingLevel(
  models: RuntimeModel[],
  model: string,
  thinkingLevel: string,
): boolean {
  if (!thinkingLevel) return true;
  return getModelThinkingLevels(models, model).some(
    (level) => level.value === thinkingLevel,
  );
}
