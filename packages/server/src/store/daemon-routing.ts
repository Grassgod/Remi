import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

export function canonicalizeDaemonRoutingWithinTransaction(
  db: SqlDatabase,
  workspaceId: string,
  legacyDaemonId: string,
  canonicalDaemonId: string,
  now: string,
): void {
  const legacy = legacyDaemonId.trim();
  const canonical = canonicalDaemonId.trim();
  if (!legacy || !canonical || legacy === canonical) return;
  db.run(
    "UPDATE multiremi_runtime_workspaces SET daemon_id = ?, updated_at = ? WHERE workspace_id = ? AND daemon_id = ?",
    [canonical, now, workspaceId, legacy],
  );

  db.run(
    `INSERT INTO multiremi_project_devices (
       project_id, daemon_id, workspace_id, created_at, created_by
     )
     SELECT project_id, ?, workspace_id, created_at, created_by
     FROM multiremi_project_devices
     WHERE workspace_id = ? AND daemon_id = ?
     ON CONFLICT(project_id, daemon_id) DO NOTHING`,
    [canonical, workspaceId, legacy],
  );
  db.run(
    "DELETE FROM multiremi_project_devices WHERE workspace_id = ? AND daemon_id = ?",
    [workspaceId, legacy],
  );

  db.run(
    `INSERT INTO multiremi_daemon_profiles (
       workspace_id, daemon_id, display_name, display_name_customized,
       dedicated, updated_by, updated_at
     )
     SELECT workspace_id, ?, display_name, display_name_customized,
            dedicated, updated_by, ?
     FROM multiremi_daemon_profiles
     WHERE workspace_id = ? AND daemon_id = ?
     ON CONFLICT(workspace_id, daemon_id) DO UPDATE SET
       display_name = CASE
         WHEN multiremi_daemon_profiles.display_name_customized = 0
          AND excluded.display_name_customized = 1
         THEN excluded.display_name
         ELSE multiremi_daemon_profiles.display_name
       END,
       display_name_customized = CASE
         WHEN multiremi_daemon_profiles.display_name_customized = 1
           OR excluded.display_name_customized = 1
         THEN 1 ELSE 0
       END,
       dedicated = CASE
         WHEN multiremi_daemon_profiles.dedicated = 1 OR excluded.dedicated = 1
         THEN 1 ELSE 0
       END,
       updated_by = CASE
         WHEN multiremi_daemon_profiles.display_name_customized = 0
          AND excluded.display_name_customized = 1
         THEN excluded.updated_by
         ELSE COALESCE(multiremi_daemon_profiles.updated_by, excluded.updated_by)
       END,
       updated_at = excluded.updated_at`,
    [canonical, now, workspaceId, legacy],
  );
  db.run(
    "DELETE FROM multiremi_daemon_profiles WHERE workspace_id = ? AND daemon_id = ?",
    [workspaceId, legacy],
  );
}
