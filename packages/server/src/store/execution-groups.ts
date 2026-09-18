import { createHash } from "node:crypto";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type { MultiremiExecutionGroup } from "@multiremi/contracts/types.js";

type RuntimeRow = { id: string; workspace_id: string | null; daemon_id: string | null; provider: string; execution_group_id: string | null };

export function syncRuntimeExecutionGroups(db: SqlDatabase, runtimeId: string): void {
  const runtime = db.query("SELECT id, workspace_id, daemon_id, provider, execution_group_id FROM multiremi_runtimes WHERE id = ?").get(runtimeId) as RuntimeRow | null;
  if (!runtime) return;
  const workspaceId = runtime.workspace_id ?? "local";
  const customId = runtime.execution_group_id;
  if (customId && (customId.startsWith("eg_") || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(customId))) throw new Error("Invalid execution group identifier (eg_ is reserved)");
  if (customId && runtime.provider === "any") throw new Error("Custom execution groups require a concrete Runtime provider");
  const providers = runtime.provider === "any" ? ["claude", "codex", "antigravity"] : [runtime.provider];
  // A pre-daemon registration gaining its machine identity is still the same
  // target. Preserve its ID, or migrate references to an already known identity.
  if (runtime.daemon_id) {
    for (const provider of providers) {
      const previous = db.query(`SELECT id, machine_id FROM multiremi_execution_groups
        WHERE workspace_id = ? AND machine_id = ? AND provider = ?`).get(workspaceId, runtime.id, provider) as { id: string; machine_id: string | null } | null;
      if (previous?.machine_id !== runtime.id || runtime.daemon_id === runtime.id) continue;
      const canonical = db.query("SELECT id FROM multiremi_execution_groups WHERE workspace_id = ? AND machine_id = ? AND provider = ?")
        .get(workspaceId, runtime.daemon_id, provider) as { id: string } | null;
      if (canonical) {
        db.run("UPDATE multiremi_agents SET execution_group_id = ? WHERE workspace_id = ? AND execution_group_id = ?", [canonical.id, workspaceId, previous.id]);
      } else {
        db.run("UPDATE multiremi_execution_groups SET machine_id = ? WHERE workspace_id = ? AND id = ?", [runtime.daemon_id, workspaceId, previous.id]);
      }
    }
  }
  db.run("DELETE FROM multiremi_execution_group_members WHERE runtime_id = ?", [runtimeId]);
  for (const provider of providers) {
    const machineId = runtime.daemon_id ?? runtime.id;
    const existingDefault = !customId ? db.query("SELECT id FROM multiremi_execution_groups WHERE workspace_id = ? AND machine_id = ? AND provider = ?")
      .get(workspaceId, machineId, provider) as { id: string } | null : null;
    const id = customId ?? existingDefault?.id ?? `eg_${createHash("sha256").update(JSON.stringify([workspaceId, machineId, provider])).digest("hex").slice(0, 32)}`;
    db.run(`INSERT INTO multiremi_execution_groups (id, workspace_id, provider, machine_id, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO NOTHING`, [id, workspaceId, provider, customId ? null : machineId, new Date().toISOString()]);
    const group = db.query("SELECT provider FROM multiremi_execution_groups WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as { provider: string };
    if (group.provider !== provider) throw new Error("Execution group provider does not match Runtime provider");
    db.run("INSERT INTO multiremi_execution_group_members (runtime_id, provider, workspace_id, group_id) VALUES (?, ?, ?, ?)", [runtime.id, provider, workspaceId, id]);
  }
}

export function getExecutionGroup(db: SqlDatabase, id: string, workspaceId: string): MultiremiExecutionGroup | null {
  const row = db.query("SELECT * FROM multiremi_execution_groups WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as { id: string; workspace_id: string; provider: string; machine_id: string | null; created_at: string } | null;
  if (!row) return null;
  const members = db.query(`SELECT m.runtime_id FROM multiremi_execution_group_members m
    JOIN multiremi_runtimes r ON r.id = m.runtime_id
    WHERE m.workspace_id = ? AND m.group_id = ? ORDER BY m.runtime_id`).all(workspaceId, id) as { runtime_id: string }[];
  return { id: row.id, workspaceId: row.workspace_id, provider: row.provider, machineId: row.machine_id, createdAt: row.created_at, runtimeIds: members.map(member => member.runtime_id) };
}

export function listExecutionGroups(db: SqlDatabase, workspaceId: string): MultiremiExecutionGroup[] {
  const rows = db.query("SELECT id FROM multiremi_execution_groups WHERE workspace_id = ? ORDER BY id").all(workspaceId) as { id: string }[];
  return rows.map(row => getExecutionGroup(db, row.id, workspaceId)!);
}

export function runtimeExecutionGroupId(db: SqlDatabase, runtimeId: string, provider: string): string | null {
  const row = db.query("SELECT group_id FROM multiremi_execution_group_members WHERE runtime_id = ? AND provider = ?").get(runtimeId, provider) as { group_id: string } | null;
  return row?.group_id ?? null;
}
