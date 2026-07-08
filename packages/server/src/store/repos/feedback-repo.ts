// Feedback CRUD + rate limiting, extracted verbatim from MultiremiStore (delegated).
import { type SqlDatabase } from "@multiremi/store/db/sql-database.js";
import { createId, nowIso } from "@multiremi/ids.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import type {
  CreateFeedbackInput,
  MultiremiFeedback,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

const FEEDBACK_MAX_MESSAGE_LENGTH = 10_000;
const FEEDBACK_HOURLY_RATE_LIMIT = 10;

export class FeedbackRepo {
  constructor(private db: SqlDatabase) {}

  createFeedback(input: CreateFeedbackInput): MultiremiFeedback {
    const message = String(input.message ?? "").trim();
    if (!message) throw new Error("message is required");
    if (message.length > FEEDBACK_MAX_MESSAGE_LENGTH) throw new Error("message too long");
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const memberId = cleanOptionalString(input.memberId ?? input.member_id);
    const userId = cleanOptionalString(input.userId ?? input.user_id) ?? memberId ?? "local";
    const recentCount = this.countRecentFeedbackByUser(userId);
    if (recentCount >= FEEDBACK_HOURLY_RATE_LIMIT) {
      throw new Error("too many feedback submissions, please try again later");
    }
    const metadata = normalizeFeedbackMetadata({
      ...(input.metadata ?? {}),
      ...(input.url != null ? { url: input.url } : {}),
    });
    const id = input.id ?? createId("fdb");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_feedback (
        id, workspace_id, user_id, member_id, message, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, userId, memberId, message, toJson(metadata), now],
    );
    return this.getFeedback(id)!;
  }

  getFeedback(id: string): MultiremiFeedback | null {
    const row = this.db.query("SELECT * FROM multiremi_feedback WHERE id = ?").get(id) as Row | null;
    return row ? toFeedback(row) : null;
  }

  listFeedback(workspaceId?: string | null): MultiremiFeedback[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multiremi_feedback WHERE workspace_id = ? ORDER BY created_at DESC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multiremi_feedback ORDER BY created_at DESC").all() as Row[];
    return rows.map(toFeedback);
  }

  countRecentFeedbackByUser(userId: string, since = new Date(Date.now() - 60 * 60 * 1000).toISOString()): number {
    const row = this.db.query(
      "SELECT COUNT(*) AS count FROM multiremi_feedback WHERE user_id = ? AND created_at >= ?",
    ).get(userId, since) as Row | null;
    return Number(row?.count ?? 0);
  }
}

function toFeedback(row: Row): MultiremiFeedback {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    userId: String(row.user_id ?? "local"),
    memberId: nullableString(row.member_id),
    message: String(row.message ?? ""),
    metadata: parseJson(row.metadata, {}),
    createdAt: String(row.created_at),
  };
}

function normalizeFeedbackMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const cleanKey = key.trim();
    if (!cleanKey) continue;
    if (
      typeof rawValue === "string"
      || typeof rawValue === "number"
      || typeof rawValue === "boolean"
      || rawValue === null
    ) {
      metadata[cleanKey] = rawValue;
    }
  }
  if (Buffer.byteLength(toJson(metadata), "utf8") > 8 * 1024) {
    throw new Error("metadata exceeds the 8KB size limit");
  }
  return metadata;
}
