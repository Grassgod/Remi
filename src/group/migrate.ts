/**
 * One-time migration: TOML bots/allowed_groups/monitor_groups → group_configs table.
 * Runs at DB init time. Idempotent — skips if group_configs already has data.
 */

import type { Database } from "bun:sqlite";
import type { RemiConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("migrate");

export function migrateGroupConfigs(db: Database, config: RemiConfig): void {
  // Only run if table is empty (first-time migration)
  const count = db
    .query("SELECT COUNT(*) as cnt FROM group_configs")
    .get() as { cnt: number };
  if (count.cnt > 0) return;

  log.info("Starting group_configs migration from TOML...");

  // 1. Ensure 'global' project exists
  db.run(
    `INSERT OR IGNORE INTO projects (id, name, cwd, init_status, created_at, updated_at)
     VALUES ('global', 'Global', NULL, 'completed', datetime('now'), datetime('now'))`,
  );

  const now = new Date().toISOString();
  let migrated = 0;

  // 2. Migrate [[bots]] — each bot profile becomes group_configs rows
  for (const bot of config.bots) {
    // Try to find a matching project by cwd
    let projectId = "global";
    if (bot.cwd) {
      const proj = db
        .query("SELECT id FROM projects WHERE cwd = ? AND (deleted = 0 OR deleted IS NULL) LIMIT 1")
        .get(bot.cwd) as { id: string } | null;
      if (proj) {
        projectId = proj.id;
      } else {
        // Create a project from bot profile
        const alias = bot.id.replace(/^project-/, "");
        db.run(
          `INSERT OR IGNORE INTO projects (id, name, cwd, init_status, created_at, updated_at)
           VALUES (?, ?, ?, 'completed', ?, ?)`,
          [alias, bot.name || alias, bot.cwd, now, now],
        );
        projectId = alias;
      }
    }

    for (const chatId of bot.groups) {
      db.run(
        `INSERT OR IGNORE INTO group_configs
          (chat_id, project_id, name, monitor, reply_mode, system_prompt, allowed_tools, add_dirs, provider, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chatId,
          projectId,
          "",
          bot.replyMode ?? "thread",
          bot.systemPrompt ?? "",
          JSON.stringify(bot.allowedTools ?? []),
          JSON.stringify(bot.addDirs ?? []),
          bot.provider ?? null,
          now,
          now,
        ],
      );
      migrated++;
    }
  }

  // 3. Migrate allowed_groups — groups not yet in group_configs go to 'global'
  for (const chatId of config.feishu.allowedGroups ?? []) {
    db.run(
      `INSERT OR IGNORE INTO group_configs
        (chat_id, project_id, name, monitor, reply_mode, created_at, updated_at)
       VALUES (?, 'global', '', 0, 'thread', ?, ?)`,
      [chatId, now, now],
    );
    migrated++;
  }

  // 4. Mark monitor_groups
  const monitorGroups = config.feishu.monitorGroups ?? [];
  if (monitorGroups.length > 0) {
    const placeholders = monitorGroups.map(() => "?").join(",");
    db.run(
      `UPDATE group_configs SET monitor = 1 WHERE chat_id IN (${placeholders})`,
      monitorGroups,
    );
  }

  // 5. Migrate existing projects with chat_id
  const projectsWithChat = db
    .query("SELECT id, chat_id FROM projects WHERE chat_id IS NOT NULL AND chat_id != '' AND (deleted = 0 OR deleted IS NULL)")
    .all() as Array<{ id: string; chat_id: string }>;
  for (const p of projectsWithChat) {
    db.run(
      `INSERT OR IGNORE INTO group_configs
        (chat_id, project_id, name, monitor, reply_mode, created_at, updated_at)
       VALUES (?, ?, '', 1, 'thread', ?, ?)`,
      [p.chat_id, p.id, now, now],
    );
    migrated++;
  }

  log.info(`Migration complete: ${migrated} group configs created`);
}
