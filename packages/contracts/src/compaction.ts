/**
 * claude-agent-acp@0.66.0 emits compaction status updates as unmarked
 * `agent_message_chunk` text (dist/acp-agent.js:1790-1828). The bridge provides
 * no subtype or metadata, so exact whole-chunk text matching is the only signal.
 */
export function isCompactionChunk(text: string): boolean {
  const trimmed = String(text ?? "").trim();
  return trimmed === "Compacting..."
    || trimmed === "Compacting completed."
    || trimmed === "Compacting failed."
    || trimmed.startsWith("Compacting failed:");
}

/** True when every non-empty line is a standalone bridge compaction status. */
export function isCompactionOutput(text: string): boolean {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every(isCompactionChunk);
}
