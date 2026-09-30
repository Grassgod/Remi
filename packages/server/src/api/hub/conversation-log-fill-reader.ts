import type { HubFrame, HubStreamKey } from "@multiremi/contracts/live-hub.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { ReadPool } from "@multiremi/store/db/read-pool.js";
import {
  CONVERSATION_LOG_HEAD_SQL,
  CONVERSATION_LOG_RANGE_PAGE_SQL,
  toConversationLogEntry,
} from "@multiremi/store/repos/conversation-log-repo.js";
import { HUB_MAX_FILL_FRAMES, type HubFillReader } from "./hub-core.js";

const PAGE_SIZE = 100;

export function createConversationLogFillReader(store: MultiremiStore, readPool: ReadPool | null): HubFillReader {
  const postgres = readPool?.postgres ? readPool : null;
  return {
    async logHead(sessionId) {
      if (!postgres) {
        const head = store.getConversationLogHead(sessionId);
        return head ? { head: head.headSeq, log_version: head.logVersion } : null;
      }
      const row = await postgres.queryOne<Record<string, unknown>>(CONVERSATION_LOG_HEAD_SQL, [sessionId]);
      return row ? { head: Number(row.head_seq), log_version: Number(row.log_version) } : null;
    },
    async traceHead() { return null; },
    async readRange(key: HubStreamKey, afterSeq, toSeq): Promise<HubFrame[]> {
      if (!key.startsWith("log:") || toSeq <= afterSeq) return [];
      const sessionId = key.slice(4);
      const frames: HubFrame[] = [];
      let cursor = afterSeq;
      while (cursor < toSeq && frames.length < HUB_MAX_FILL_FRAMES) {
        const limit = Math.min(PAGE_SIZE, HUB_MAX_FILL_FRAMES - frames.length);
        const rows = postgres
          ? (await postgres.query<Record<string, unknown>>(
            CONVERSATION_LOG_RANGE_PAGE_SQL, [sessionId, cursor, toSeq, limit],
          )).map(toConversationLogEntry)
          : store.listConversationLogRangePage(sessionId, cursor, toSeq, limit);
        for (const row of rows) frames.push({ seq: row.seq, kind: "entry", payload: row });
        if (rows.length < limit) break;
        cursor = rows[rows.length - 1]!.seq;
      }
      return frames;
    },
  };
}
