/** Exact live claude-agent-acp `system/informational` text formatting. */
export function claudeInformationalText(record: Record<string, any>): string | undefined {
  if (record.type !== "system" || record.subtype !== "informational") return undefined;
  if (typeof record.content !== "string" || typeof record.level !== "string" || !record.level.length) {
    throw new Error("invalid_native_informational_record");
  }
  return record.level === "info" ? record.content : `**${record.level[0]!.toUpperCase()}${record.level.slice(1)}:** ${record.content}`;
}
