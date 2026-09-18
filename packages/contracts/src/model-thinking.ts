interface ThinkingLevel {
  value: string;
  label: string;
  description?: string;
}

interface Thinking {
  status?: "supported" | "unsupported" | "unknown" | "error";
  supported_levels: ThinkingLevel[];
}

interface Model {
  id: string;
  default?: boolean;
  thinking?: Thinking;
}

export function commonThinkingLevels(sets: ThinkingLevel[][]): ThinkingLevel[] {
  return (sets[0] ?? []).filter((level) =>
    sets.every((levels) => levels.some((candidate) => candidate.value === level.value)),
  );
}

/** Shared by API validation and UI selection, including older daemon catalogs. */
export function modelThinkingLevels(models: Model[], model: string, providerDefault?: Thinking): ThinkingLevel[] {
  if (model) return usableLevels(models.find((entry) => entry.id === model)?.thinking);
  // An explicitly empty capability is authoritative, not a missing report.
  if (providerDefault) return usableLevels(providerDefault);
  const selected = models.find((entry) => entry.default);
  if (selected) return usableLevels(selected.thinking);
  // Older bridges omitted the default selector. Offer only common advertised
  // efforts, without inferring a model ID. Models without metadata are unknown;
  // the live bridge still validates the actual default before sending a prompt.
  const capable = models.flatMap((entry) => usableLevels(entry.thinking).length
    ? [usableLevels(entry.thinking)] : []);
  return commonThinkingLevels(capable);
}

function usableLevels(thinking?: Thinking): ThinkingLevel[] {
  if (thinking?.status && thinking.status !== "supported") return [];
  return thinking?.supported_levels ?? [];
}
