export function hasOneMillionContext(model: string): boolean {
  return /\[1m\]$/i.test(model.trim());
}

export function resolveClaudeContextSelection(
  model: string | null,
  oneMillionModels: readonly string[] = [],
): { customModelOption: string | null } {
  const id = model?.trim();
  return {
    customModelOption: id && !hasOneMillionContext(id) && oneMillionModels.includes(id)
      ? `${id}[1m]`
      : null,
  };
}
