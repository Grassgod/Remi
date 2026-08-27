/**
 * Bridge compaction status text that arrives as an unmarked `agent_message_chunk`
 * — indistinguishable from real model prose at the protocol level, so exact
 * whole-chunk matching is the only available signal. Two bridges do this:
 *
 * - claude-agent-acp@0.66.0 (`dist/acp-agent.js:1790-1828`): the `system` /
 *   `status` compaction frames are re-emitted as bare text, no `_meta`, no subtype.
 * - codex-acp@1.1.14 (`dist/index.js:23726,24056`): the `thread/compacted`
 *   notification maps to `createContextCompactedEvent()`, likewise bare text.
 *   Codex's *other* compaction path — the `contextCompaction` thread item
 *   (`dist/index.js:22924-22951`) — is a proper `tool_call` carrying
 *   `_meta: { contextCompaction: true }` and never reaches this predicate.
 */
export function isCompactionChunk(text: string): boolean {
  const trimmed = String(text ?? "").trim();
  return trimmed === "Compacting..."
    || trimmed === "Compacting completed."
    || trimmed === "Compacting failed."
    || trimmed.startsWith("Compacting failed:")
    || trimmed === "*Context compacted to fit the model's context window.*";
}

/** True when every non-empty line is a standalone bridge compaction status. */
export function isCompactionOutput(text: string): boolean {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every(isCompactionChunk);
}
