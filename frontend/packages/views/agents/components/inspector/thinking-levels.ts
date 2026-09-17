import type {
  RuntimeModel,
  RuntimeModelThinkingLevel,
  RuntimeModelThinking,
} from "@multiremi/core/types";
import { modelThinkingLevels } from "@multiremi/core/runtimes";

export function getModelThinkingLevels(
  models: RuntimeModel[],
  model: string,
  defaultThinking?: RuntimeModelThinking,
): RuntimeModelThinkingLevel[] {
  return modelThinkingLevels(models, model, defaultThinking);
}

export function supportsThinkingLevel(
  models: RuntimeModel[],
  model: string,
  thinkingLevel: string,
  defaultThinking?: RuntimeModelThinking,
): boolean {
  if (!thinkingLevel) return true;
  return getModelThinkingLevels(models, model, defaultThinking).some(
    (level) => level.value === thinkingLevel,
  );
}
