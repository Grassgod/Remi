import { nowIso } from "@multiremi/ids.js";
import { nullableString } from "@multiremi/store/helpers.js";
import type { StoreContext } from "@multiremi/store/context.js";

type Row = Record<string, unknown>;

export interface DaemonProfile {
  workspaceId: string;
  daemonId: string;
  displayName: string;
  displayNameCustomized: boolean;
  updatedBy: string | null;
  updatedAt: string;
}

export class DaemonProfilesRepo {
  constructor(private readonly ctx: StoreContext) {}

  get(workspaceId: string, daemonId: string): DaemonProfile | null {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_daemon_profiles
       WHERE workspace_id = ? AND daemon_id = ?`,
    ).get(workspaceId, daemonId) as Row | null;
    return row ? toDaemonProfile(row) : null;
  }

  list(workspaceId: string): DaemonProfile[] {
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_daemon_profiles
       WHERE workspace_id = ? ORDER BY updated_at DESC, daemon_id ASC`,
    ).all(workspaceId) as Row[]).map(toDaemonProfile);
  }

  upsertDisplayName(
    workspaceId: string,
    daemonId: string,
    displayName: string,
    options: { customized: boolean; updatedBy?: string | null },
  ): DaemonProfile {
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_daemon_profiles (
        workspace_id, daemon_id, display_name, display_name_customized,
        updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, daemon_id) DO UPDATE SET
        display_name = excluded.display_name,
        display_name_customized = excluded.display_name_customized,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
      WHERE multiremi_daemon_profiles.display_name_customized = 0
         OR excluded.display_name_customized = 1`,
      [
        workspaceId,
        daemonId,
        displayName,
        options.customized ? 1 : 0,
        options.updatedBy ?? null,
        now,
      ],
    );
    return this.get(workspaceId, daemonId)!;
  }
}

function toDaemonProfile(row: Row): DaemonProfile {
  return {
    workspaceId: String(row.workspace_id),
    daemonId: String(row.daemon_id),
    displayName: String(row.display_name),
    displayNameCustomized: Number(row.display_name_customized ?? 0) === 1,
    updatedBy: nullableString(row.updated_by),
    updatedAt: String(row.updated_at),
  };
}
