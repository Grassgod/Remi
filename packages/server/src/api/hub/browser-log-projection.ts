import type { HubFrame } from "@multiremi/contracts/live-hub.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { ReadPool } from "@multiremi/store/db/read-pool.js";
import { toConversationLogEntry } from "@multiremi/store/repos/conversation-log-repo.js";
import type { MultiremiWebSocketClient } from "../helpers/realtime-types.js";
import { conversationEntrySource, stripCardTokenFields, type ConversationVisibilityEntry } from "../helpers/conversations.js";
import { canUserViewTaskMessages, createTaskAuthMemo } from "../helpers/auth-guards.js";
import { createPostgresStreamAuthReader, decideTraceSubscription } from "./stream-auth.js";

/** The Hub ring is shared. Project at the socket boundary for each recipient. */
export function createBrowserLogProjection(store: MultiremiStore, pool: ReadPool | null) {
  const postgres = pool?.postgres ? pool : null;
  const auth = postgres ? createPostgresStreamAuthReader(postgres) : null;
  return async (client: MultiremiWebSocketClient, sessionId: string, frames: readonly HubFrame[]): Promise<HubFrame[]> => {
    if (client.data.kind !== "browser" || !client.data.authenticated) return [];
    const subject = { userId: client.data.userId, workspaceId: client.data.workspaceId };
    const seqs = [...new Set(frames.map(frame => frame.seq))];
    const rows = postgres
      ? (await postgres.query<Record<string, unknown>>(
        `SELECT * FROM multiremi_conversation_log WHERE session_id=? AND seq IN (${seqs.map(() => "?").join(",")})`,
        [sessionId, ...seqs])).map(toConversationLogEntry)
      : seqs.flatMap(seq => store.getConversationLogEntry(sessionId, seq) ?? []);
    const bySeq = new Map(rows.map(row => [row.seq, row]));
    const byId = new Map(rows.map(row => [row.id, row]));
    const replies = [...new Set(rows.flatMap(row => row.parent_id ? [row.parent_id] : []))];
    const targets = [...new Set(rows.flatMap(row => Number.isSafeInteger(row.metadata.target_seq) ? [Number(row.metadata.target_seq)] : []))];
    if (replies.length || targets.length) {
      const related = postgres
        ? (await postgres.query<Record<string, unknown>>(
          `SELECT * FROM multiremi_conversation_log WHERE session_id=? AND (${[
            ...(replies.length ? [`id IN (${replies.map(() => "?").join(",")})`] : []),
            ...(targets.length ? [`seq IN (${targets.map(() => "?").join(",")})`] : []),
          ].join(" OR ")})`, [sessionId, ...replies, ...targets])).map(toConversationLogEntry)
        : [...replies.flatMap(id => store.getConversationLogEntryById(id) ?? []),
          ...targets.flatMap(seq => store.getConversationLogEntry(sessionId, seq) ?? [])];
      for (const row of related) { byId.set(row.id, row); bySeq.set(row.seq, row); }
    }
    const allowed = new Map<string, boolean>(), memo = createTaskAuthMemo();
    const visible = async (entry: ConversationVisibilityEntry) => {
      const sourceId = conversationEntrySource(entry, id => byId.get(id), seq => bySeq.get(seq));
      if (sourceId === undefined) return true;
      if (!sourceId) return false;
      if (!allowed.has(sourceId)) {
        if (postgres) {
          const turn = await postgres.queryOne<{ current_attempt_id: string | null }>(
            `SELECT current_attempt_id FROM multiremi_turns WHERE id=?
              OR id=(SELECT turn_id FROM multiremi_turn_attempts WHERE id=?)`, [sourceId, sourceId]);
          const result = turn?.current_attempt_id ? await auth!.traceFacts(turn.current_attempt_id, subject) : null;
          if (result && !result.ok) throw new Error("Source visibility unavailable");
          allowed.set(sourceId, !!result && result.ok && decideTraceSubscription(subject, result.facts).ok);
        } else {
          const turn = store.getTurn(sourceId) ?? store.getTurnForAttempt(sourceId);
          const task = turn?.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
          allowed.set(sourceId, !!task && task.workspaceId === subject.workspaceId
            && canUserViewTaskMessages(store, subject.userId, task, memo));
        }
      }
      return allowed.get(sourceId)!;
    };
    const projected: HubFrame[] = [];
    for (const frame of frames) {
      const row = bySeq.get(frame.seq);
      const payload = frame.payload as Record<string, any>;
      const candidate = row && (frame.kind === "patch" ? { ...row, ...payload.fields } : payload);
      // Check committed facts as well as the event: a partial patch or an old
      // retained frame cannot remove the source check. Missing rows fail closed.
      if (!row || !candidate || !await visible(row) || !await visible(candidate as ConversationVisibilityEntry)) {
        projected.push({ seq: frame.seq, kind: "entry", payload: {
          session_id: sessionId, seq: frame.seq, revision: Math.max(row?.revision ?? 1, Number(payload.revision) || 1), visibility: "hidden",
        } });
      } else {
        projected.push({ ...frame, payload: stripCardTokenFields(payload) });
      }
    }
    return projected;
  };
}
