export function formatSlashCommandLabel(label: unknown): string {
  return typeof label === "string" && label.trim().length > 0 ? label : "?";
}

/** What a chip reads as: its invocation (`/compact`, `$deploy`), or `/label` for an old skill chip. */
export function slashCommandChipText(attrs: { invocation?: unknown; label?: unknown }): string {
  return typeof attrs.invocation === "string" && attrs.invocation
    ? attrs.invocation
    : `/${formatSlashCommandLabel(attrs.label)}`;
}
