import type { MultiremiIssueShare } from "@multiremi/contracts/types.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createId, nowIso } from "@multiremi/ids.js";
import { nullableString } from "@multiremi/store/helpers.js";

type Row = Record<string, unknown>;

export class IssueSharesRepo {
  constructor(private readonly db: SqlDatabase) {}

  get(id: string): MultiremiIssueShare | null {
    const row = this.db.query("SELECT * FROM multiremi_issue_shares WHERE id = ?").get(id) as Row | null;
    return row ? toIssueShare(row) : null;
  }

  getActiveForIssue(issueId: string): MultiremiIssueShare | null {
    const row = this.db.query(
      `SELECT * FROM multiremi_issue_shares
       WHERE issue_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    ).get(issueId, nowIso()) as Row | null;
    return row ? toIssueShare(row) : null;
  }

  ensure(issueId: string, workspaceId: string, createdBy: string, days = 60): MultiremiIssueShare {
    const current = this.getActiveForIssue(issueId);
    if (current) return current;
    const now = nowIso();
    const id = createId("shr", 16);
    const expiresAt = expiryFromNow(days);
    this.db.run(
      `INSERT INTO multiremi_issue_shares (
        id, issue_id, workspace_id, created_by, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, issueId, workspaceId, createdBy, expiresAt, now, now],
    );
    return this.get(id)!;
  }

  extend(id: string, days = 60): MultiremiIssueShare | null {
    const current = this.get(id);
    if (!current || current.revokedAt) return null;
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_issue_shares SET expires_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
      [expiryFromNow(days), now, id],
    );
    return this.get(id);
  }

  revoke(id: string): MultiremiIssueShare | null {
    const current = this.get(id);
    if (!current) return null;
    if (!current.revokedAt) {
      const now = nowIso();
      this.db.run(
        "UPDATE multiremi_issue_shares SET revoked_at = ?, updated_at = ? WHERE id = ?",
        [now, now, id],
      );
    }
    return this.get(id);
  }

  recordView(id: string): void {
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_issue_shares
       SET view_count = view_count + 1, last_viewed_at = ?, updated_at = ?
       WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
      [now, now, id, now],
    );
  }
}

function expiryFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function toIssueShare(row: Row): MultiremiIssueShare {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    workspaceId: String(row.workspace_id ?? "local"),
    createdBy: String(row.created_by),
    expiresAt: String(row.expires_at),
    revokedAt: nullableString(row.revoked_at),
    viewCount: Number(row.view_count ?? 0),
    lastViewedAt: nullableString(row.last_viewed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
