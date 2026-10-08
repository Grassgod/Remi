import type { SessionLogEntry } from "@multiremi/core/replica";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import { isInboxTurn, metadataRecord } from "../../common/session-log/event-summary";

export function isSystemDetail(entry: SessionLogEntry): boolean {
  if (entry.seq === 0) return false;
  const row = entry as SessionLogRow;
  const metadata = metadataRecord(row.metadata);
  // Canonical messages may retain envelope metadata from their write adapter.
  if (row.kind === "message" && (row.message_kind || row.sender_type)) return false;
  if (metadata.envelope) return true;
  if (metadata.type === "workspace_move_cleared") return false;
  if (row.kind === "message" && (!!row.message_kind || row.author_type === "member" || (row.sender_type ?? row.author_type) === "agent")) return false;
  return row.kind !== "turn" || isInboxTurn(row.body_md);
}

export function firstTaskResponses(entries: readonly SessionLogRow[]): Map<string, SessionLogRow> {
  const turns = new Map<string, SessionLogRow>();
  const responses = new Map<string, SessionLogRow>();
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const row of entries) {
    if (row.task_id && row.kind === "turn" && !isSystemDetail(row)) counts.set(row.task_id, (counts.get(row.task_id) ?? 0) + 1);
  }
  for (const row of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (!row.task_id) continue;
    if (row.kind === "turn" && !isSystemDetail(row) && counts.get(row.task_id) === 1) {
      turns.set(row.task_id, row);
    } else if (row.kind === "message" && (row.sender_type ?? row.author_type) === "agent" && !row.metadata.envelope) {
      const turn = turns.get(row.task_id);
      if (turn && (row.sender_id ?? row.author_id) === turn.metadata.assignee_agent_id && !seen.has(row.task_id)) {
        responses.set(row.id, turn);
        seen.add(row.task_id);
      }
    }
  }
  return responses;
}

export function assignmentAuthor(row: SessionLogRow): { type: string; id: string } | null {
  if (typeof row.metadata.delegated_by_agent_id === "string" && row.metadata.delegated_by_agent_id) {
    return { type: "agent", id: row.metadata.delegated_by_agent_id };
  }
  const type = row.sender_type ?? row.author_type;
  const id = row.sender_id ?? row.author_id;
  return (type === "member" || type === "agent") && id ? { type, id } : null;
}
