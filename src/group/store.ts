/**
 * GroupConfigStore — SQLite CRUD for the group_configs table.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.js";
import type { GroupConfig, GroupConfigInput } from "./model.js";

export class GroupConfigStore {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  /**
   * Look up a group's config by chat_id, JOINing projects for cwd.
   * This is the hot-path query — called on every incoming group message.
   */
  getByChatId(chatId: string): GroupConfig | null {
    const row = this.db
      .query(
        `SELECT gc.*, p.cwd as project_cwd
         FROM group_configs gc
         LEFT JOIN projects p ON gc.project_id = p.id
           AND (p.deleted = 0 OR p.deleted IS NULL)
         WHERE gc.chat_id = ?`,
      )
      .get(chatId) as Record<string, unknown> | null;
    return row ? this._toGroupConfig(row) : null;
  }

  /** List all group configs with project info. */
  list(): (GroupConfig & { projectName?: string })[] {
    const rows = this.db
      .query(
        `SELECT gc.*, p.cwd as project_cwd, p.name as project_name
         FROM group_configs gc
         LEFT JOIN projects p ON gc.project_id = p.id
           AND (p.deleted = 0 OR p.deleted IS NULL)
         ORDER BY gc.created_at DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      ...this._toGroupConfig(r),
      projectName: (r.project_name as string) || undefined,
    }));
  }

  /** List group configs for a specific project. */
  listByProject(projectId: string): GroupConfig[] {
    const rows = this.db
      .query(
        `SELECT gc.*, p.cwd as project_cwd
         FROM group_configs gc
         LEFT JOIN projects p ON gc.project_id = p.id
           AND (p.deleted = 0 OR p.deleted IS NULL)
         WHERE gc.project_id = ?
         ORDER BY gc.created_at DESC`,
      )
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this._toGroupConfig(r));
  }

  /** Count groups per project. */
  countByProject(): Record<string, number> {
    const rows = this.db
      .query("SELECT project_id, COUNT(*) as cnt FROM group_configs GROUP BY project_id")
      .all() as Array<{ project_id: string; cnt: number }>;
    const map: Record<string, number> = {};
    for (const r of rows) map[r.project_id] = r.cnt;
    return map;
  }

  /** Insert or update a group config. */
  upsert(input: GroupConfigInput): void {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO group_configs
        (chat_id, project_id, name, monitor, mission_enabled, reply_mode, system_prompt, allowed_tools, allowed_mcps, add_dirs, provider, cwd, launch_command, inject_chat_context, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        monitor = excluded.monitor,
        mission_enabled = excluded.mission_enabled,
        reply_mode = excluded.reply_mode,
        system_prompt = excluded.system_prompt,
        allowed_tools = excluded.allowed_tools,
        allowed_mcps = excluded.allowed_mcps,
        add_dirs = excluded.add_dirs,
        provider = excluded.provider,
        cwd = excluded.cwd,
        launch_command = excluded.launch_command,
        inject_chat_context = excluded.inject_chat_context,
        updated_at = excluded.updated_at`,
      [
        input.chatId,
        input.projectId ?? "global",
        input.name ?? "",
        input.monitor ? 1 : 0,
        input.missionEnabled ? 1 : 0,
        input.replyMode ?? "thread",
        input.systemPrompt ?? "",
        JSON.stringify(input.allowedTools ?? []),
        JSON.stringify(input.allowedMcps ?? []),
        JSON.stringify(input.addDirs ?? []),
        input.provider ?? null,
        input.cwd ?? null,
        input.launchCommand ?? null,
        input.injectChatContext ? 1 : 0,
        now,
        now,
      ],
    );
  }

  /** Update specific fields of an existing group config. */
  update(chatId: string, fields: Partial<GroupConfigInput>): boolean {
    const existing = this.getByChatId(chatId);
    if (!existing) return false;

    const sets: string[] = [];
    const vals: unknown[] = [];

    if (fields.projectId !== undefined) { sets.push("project_id = ?"); vals.push(fields.projectId); }
    if (fields.name !== undefined) { sets.push("name = ?"); vals.push(fields.name); }
    if (fields.monitor !== undefined) { sets.push("monitor = ?"); vals.push(fields.monitor ? 1 : 0); }
    if (fields.missionEnabled !== undefined) { sets.push("mission_enabled = ?"); vals.push(fields.missionEnabled ? 1 : 0); }
    if (fields.replyMode !== undefined) { sets.push("reply_mode = ?"); vals.push(fields.replyMode); }
    if (fields.systemPrompt !== undefined) { sets.push("system_prompt = ?"); vals.push(fields.systemPrompt); }
    if (fields.allowedTools !== undefined) { sets.push("allowed_tools = ?"); vals.push(JSON.stringify(fields.allowedTools)); }
    if (fields.allowedMcps !== undefined) { sets.push("allowed_mcps = ?"); vals.push(JSON.stringify(fields.allowedMcps)); }
    if (fields.addDirs !== undefined) { sets.push("add_dirs = ?"); vals.push(JSON.stringify(fields.addDirs)); }
    if (fields.provider !== undefined) { sets.push("provider = ?"); vals.push(fields.provider || null); }
    if (fields.cwd !== undefined) { sets.push("cwd = ?"); vals.push(fields.cwd || null); }
    if (fields.launchCommand !== undefined) { sets.push("launch_command = ?"); vals.push(fields.launchCommand || null); }
    if (fields.injectChatContext !== undefined) { sets.push("inject_chat_context = ?"); vals.push(fields.injectChatContext ? 1 : 0); }

    if (sets.length === 0) return true;
    sets.push("updated_at = datetime('now')");
    vals.push(chatId);

    this.db.run(`UPDATE group_configs SET ${sets.join(", ")} WHERE chat_id = ?`, vals);
    return true;
  }

  /** Delete a group config. */
  delete(chatId: string): boolean {
    const result = this.db.run("DELETE FROM group_configs WHERE chat_id = ?", [chatId]);
    return result.changes > 0;
  }

  /** Get name→chatId map for all groups (for conversations display). */
  getNameMap(): Map<string, string> {
    const rows = this.db
      .query("SELECT chat_id, name FROM group_configs WHERE name IS NOT NULL AND name != ''")
      .all() as Array<{ chat_id: string; name: string }>;
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.chat_id, r.name);
    return map;
  }

  /** Check if a chat_id exists in group_configs (fast allow check). */
  exists(chatId: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM group_configs WHERE chat_id = ? LIMIT 1")
      .get(chatId);
    return !!row;
  }

  private _toGroupConfig(row: Record<string, unknown>): GroupConfig {
    return {
      chatId: row.chat_id as string,
      projectId: (row.project_id as string) ?? "global",
      name: (row.name as string) ?? "",
      monitor: !!(row.monitor as number),
      missionEnabled: !!(row.mission_enabled as number),
      replyMode: (row.reply_mode as "thread" | "direct") ?? "thread",
      systemPrompt: (row.system_prompt as string) ?? "",
      allowedTools: JSON.parse((row.allowed_tools as string) || "[]"),
      allowedMcps: JSON.parse((row.allowed_mcps as string) || "[]"),
      addDirs: JSON.parse((row.add_dirs as string) || "[]"),
      provider: (row.provider as string) || undefined,
      cwd: (row.cwd as string) || undefined,
      launchCommand: (row.launch_command as string) || undefined,
      injectChatContext: !!(row.inject_chat_context as number),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      projectCwd: (row.project_cwd as string) || undefined,
    };
  }
}
