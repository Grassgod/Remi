import { postgresReplyMaxBytes, type SqlDatabase } from "./db/postgres.js";

export const TASK_MESSAGE_PAGE_MAX_ROWS = 8;
// 640 KiB of capped text/JSON fields, escaped at up to 6x, plus row metadata.
export const TASK_MESSAGE_ROW_REPLY_BYTES = 4 * 1_048_576;
const REPLY_WRAPPER_RESERVE_BYTES = 64 * 1024;

export function taskMessagePageRows(db: SqlDatabase): number {
  const ceiling = db.dialect === "postgres" ? postgresReplyMaxBytes() : 64 * 1_048_576;
  return Math.max(1, Math.min(TASK_MESSAGE_PAGE_MAX_ROWS,
    Math.floor((ceiling - REPLY_WRAPPER_RESERVE_BYTES) / TASK_MESSAGE_ROW_REPLY_BYTES)));
}
