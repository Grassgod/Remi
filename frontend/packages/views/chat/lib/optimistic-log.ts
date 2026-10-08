import type { SessionLogEntry } from "@multiremi/core/replica";
import type { Attachment } from "@multiremi/core/types";

export interface OptimisticChatRow {
  clientId: string;
  sessionId: string;
  content: string;
  attachmentIds?: string[];
  attachments?: Attachment[];
  createdAt: string;
  localSeq: number;
  status: "sending" | "sent" | "failed" | "hidden";
  confirmedAt?: number;
}

export function clientIdOf(entry: SessionLogEntry): string | null {
  const metadata = (entry as SessionLogEntry & { metadata?: Record<string, unknown> }).metadata;
  const dedupe = (entry as SessionLogEntry & { dedupe_key?: unknown }).dedupe_key;
  return typeof dedupe === "string" ? dedupe : typeof metadata?.client_id === "string" ? metadata.client_id : null;
}

/** Keep the local row's DOM identity when the authoritative entry arrives. */
export function mergeOptimisticChatRows(
  serverEntries: readonly SessionLogEntry[],
  localRows: readonly OptimisticChatRow[],
): SessionLogEntry[] {
  const localById = new Map(localRows.map((row) => [row.clientId, row]));
  const matched = new Set<string>();
  const rows: SessionLogEntry[] = [];
  for (const entry of serverEntries) {
    const clientId = clientIdOf(entry);
    const local = clientId ? localById.get(clientId) : undefined;
    if (!local) {
      rows.push(entry);
      continue;
    }
    if (matched.has(clientId!)) continue;
    matched.add(clientId!);
    rows.push({ ...entry, seq: local.localSeq, id: `optimistic-${clientId}` });
  }
  for (const local of localRows) {
    if (matched.has(local.clientId)) continue;
    // Once observed in the log, only the authoritative row may supply its body.
    // Deletes, hidden markers and window changes must not revive the draft.
    if (local.confirmedAt !== undefined) continue;
    rows.push({
      session_id: local.sessionId,
      seq: local.localSeq,
      id: `optimistic-${local.clientId}`,
      revision: 0,
      kind: "message",
      body_html: null,
      render_version: null,
      body_md: local.content,
      metadata: { client_id: local.clientId, attachments: local.attachments ?? [] },
      author_type: "member",
      created_at: local.createdAt,
      task_id: null,
    } as SessionLogEntry);
  }
  return rows.sort((left, right) => left.seq - right.seq);
}
