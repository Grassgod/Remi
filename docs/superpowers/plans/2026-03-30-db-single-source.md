# DB Single-Source: Project/Group Config Unification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify project/group configuration into a single DB source (group_configs table), deprecate TOML [[bots]]/allowed_groups/monitor_groups, and build Dashboard UI for visual management.

**Architecture:** New `group_configs` table with `chat_id` as primary key stores all per-group config (monitor, reply_mode, tools, provider, etc.) and links to projects for cwd. Daemon reads exclusively from DB for group filtering and routing. One-time startup migration moves TOML config to DB.

**Tech Stack:** SQLite (bun:sqlite), TypeScript, React 19, Tailwind/shadcn, Hono API

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db/index.ts` | Modify | Add group_configs table creation + migration logic |
| `src/group/model.ts` | Create | GroupConfig interface + types |
| `src/group/store.ts` | Create | GroupConfigStore — CRUD for group_configs table |
| `src/group/migrate.ts` | Create | One-time TOML → DB migration logic |
| `src/connectors/feishu/receive.ts` | Modify | Replace allowedGroups/monitorGroups filtering with DB lookup |
| `src/core.ts` | Modify | Replace _resolveBotProfile/_getProjectCwd with GroupConfig |
| `src/project/init.ts` | Modify | Write group_configs instead of TOML on init |
| `web/handlers/groups.ts` | Create | REST API for group_configs CRUD |
| `web/server.ts` | Modify | Register group handlers |
| `web/handlers/projects.ts` | Modify | Remove TOML writes, add group count |
| `web/frontend/src/api/types.ts` | Modify | Add GroupConfig type |
| `web/frontend/src/api/client.ts` | Modify | Add groups API functions |
| `web/frontend/src/pages/Projects.tsx` | Modify | Add Groups tab with full config UI |

---

### Task 1: group_configs Table + Model

**Files:**
- Create: `src/group/model.ts`
- Modify: `src/db/index.ts:137-152` (after projects table creation)

- [ ] **Step 1: Create GroupConfig model**

Create `src/group/model.ts`:

```typescript
/**
 * GroupConfig — per-group configuration stored in DB.
 * chat_id is the primary key; each group optionally links to a project.
 */

export interface GroupConfig {
  chatId: string;
  projectId: string;
  name: string;
  monitor: boolean;
  replyMode: "thread" | "direct";
  systemPrompt: string;
  allowedTools: string[];
  addDirs: string[];
  provider?: string;
  createdAt: string;
  updatedAt: string;
  /** Joined from projects table — not stored in group_configs */
  cwd?: string;
}

export interface GroupConfigInput {
  chatId: string;
  projectId?: string;
  name?: string;
  monitor?: boolean;
  replyMode?: "thread" | "direct";
  systemPrompt?: string;
  allowedTools?: string[];
  addDirs?: string[];
  provider?: string;
}
```

- [ ] **Step 2: Add group_configs table to DB schema**

In `src/db/index.ts`, add after the projects table CREATE (after line 152):

```sql
-- Group configs (per-group settings, replaces toml bots/allowed_groups/monitor_groups)
CREATE TABLE IF NOT EXISTS group_configs (
  chat_id TEXT PRIMARY KEY,
  project_id TEXT DEFAULT 'global',
  name TEXT DEFAULT '',
  monitor INTEGER DEFAULT 0,
  reply_mode TEXT DEFAULT 'thread',
  system_prompt TEXT DEFAULT '',
  allowed_tools TEXT DEFAULT '[]',
  add_dirs TEXT DEFAULT '[]',
  provider TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gc_project ON group_configs(project_id);
```

- [ ] **Step 3: Verify table is created**

Run: `bun run src/main.ts --help` (triggers getDb())
Then verify: `sqlite3 ~/.remi/remi.db ".schema group_configs"`

Expected: The CREATE TABLE statement above.

- [ ] **Step 4: Commit**

```bash
git add src/group/model.ts src/db/index.ts
git commit -m "feat: add group_configs table and GroupConfig model"
```

---

### Task 2: GroupConfigStore — CRUD

**Files:**
- Create: `src/group/store.ts`

- [ ] **Step 1: Create GroupConfigStore**

Create `src/group/store.ts`:

```typescript
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
        (chat_id, project_id, name, monitor, reply_mode, system_prompt, allowed_tools, add_dirs, provider, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        monitor = excluded.monitor,
        reply_mode = excluded.reply_mode,
        system_prompt = excluded.system_prompt,
        allowed_tools = excluded.allowed_tools,
        add_dirs = excluded.add_dirs,
        provider = excluded.provider,
        updated_at = excluded.updated_at`,
      [
        input.chatId,
        input.projectId ?? "global",
        input.name ?? "",
        input.monitor ? 1 : 0,
        input.replyMode ?? "thread",
        input.systemPrompt ?? "",
        JSON.stringify(input.allowedTools ?? []),
        JSON.stringify(input.addDirs ?? []),
        input.provider ?? null,
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
    if (fields.replyMode !== undefined) { sets.push("reply_mode = ?"); vals.push(fields.replyMode); }
    if (fields.systemPrompt !== undefined) { sets.push("system_prompt = ?"); vals.push(fields.systemPrompt); }
    if (fields.allowedTools !== undefined) { sets.push("allowed_tools = ?"); vals.push(JSON.stringify(fields.allowedTools)); }
    if (fields.addDirs !== undefined) { sets.push("add_dirs = ?"); vals.push(JSON.stringify(fields.addDirs)); }
    if (fields.provider !== undefined) { sets.push("provider = ?"); vals.push(fields.provider || null); }

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
      replyMode: (row.reply_mode as "thread" | "direct") ?? "thread",
      systemPrompt: (row.system_prompt as string) ?? "",
      allowedTools: JSON.parse((row.allowed_tools as string) || "[]"),
      addDirs: JSON.parse((row.add_dirs as string) || "[]"),
      provider: (row.provider as string) || undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      cwd: (row.project_cwd as string) || undefined,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/group/store.ts
git commit -m "feat: add GroupConfigStore with CRUD operations"
```

---

### Task 3: TOML → DB Migration

**Files:**
- Create: `src/group/migrate.ts`
- Modify: `src/db/index.ts:220-227` (add migration call)

- [ ] **Step 1: Create migration module**

Create `src/group/migrate.ts`:

```typescript
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
```

- [ ] **Step 2: Wire migration into getDb()**

In `src/db/index.ts`, add after the projects table migration (after line 227), import and call:

At the top of the file, add import:
```typescript
import { migrateGroupConfigs } from "../group/migrate.js";
```

After line 227 (the projects deleted column migration), add:
```typescript
  // Group configs migration — requires config, deferred to first call with config
  // The actual migration is triggered in serve.ts after config is loaded
```

Actually, `getDb()` doesn't have access to config. Instead, we'll call migration from `serve.ts`.

- [ ] **Step 3: Call migration from serve.ts**

In `src/cli/serve.ts`, after `Remi.boot(config)` and before `remi.start()`, add:

```typescript
import { migrateGroupConfigs } from "../group/migrate.js";

// After config loaded and db initialized:
migrateGroupConfigs(getDb(), config);
```

- [ ] **Step 4: Commit**

```bash
git add src/group/migrate.ts src/db/index.ts src/cli/serve.ts
git commit -m "feat: one-time TOML → DB migration for group configs"
```

---

### Task 4: Daemon — Replace Group Filtering in receive.ts

**Files:**
- Modify: `src/connectors/feishu/receive.ts:18-28` (replace `_isProjectChat`)
- Modify: `src/connectors/feishu/receive.ts:441-479` (replace filtering logic)
- Modify: `src/connectors/feishu/receive.ts:557-613` (simplify WebSocket listener)

- [ ] **Step 1: Replace _isProjectChat with getGroupConfig import**

At top of `src/connectors/feishu/receive.ts`, replace the `_isProjectChat` function (lines 18-28) with:

```typescript
import { GroupConfigStore } from "../../group/store.js";
import type { GroupConfig } from "../../group/model.js";

/** Cached store instance (created lazily). */
let _gcStore: GroupConfigStore | undefined;
function gcStore(): GroupConfigStore {
  return (_gcStore ??= new GroupConfigStore());
}
```

Remove the old `_isProjectChat` function entirely.

- [ ] **Step 2: Replace group filtering logic in processFeishuMessageEvent**

Replace the group filtering block (lines 441-479) in `processFeishuMessageEvent()`. The function signature changes — remove `allowedGroups`/`monitorGroups` from opts, keep only `triggerUserIds`:

Change the opts parameter type (line 425):
```typescript
  opts?: { triggerUserIds?: string[] },
```

Replace the group filtering block:
```typescript
  let monitored = false;
  if (ctx.chatType === "group") {
    // DB-based group filtering — group must exist in group_configs
    const groupConfig = gcStore().getByChatId(ctx.chatId);
    if (!groupConfig) {
      log.info(`blocked group message ${messageId} (chatId=${ctx.chatId}, not in group_configs)`);
      return null;
    }

    const isMonitor = groupConfig.monitor;
    const mentions = event.message.mentions ?? [];
    const directedAtOthers = mentions.length > 0 && !ctx.mentionedBot;
    const isInThread = !!event.message.root_id;
    const mentionedTriggerUser = opts?.triggerUserIds?.length
      ? mentions.some((m) => opts.triggerUserIds!.includes(m.id.open_id ?? ""))
      : false;
    const isSlashCommand = /^\/\w+/i.test(ctx.content.trim());

    if (ctx.mentionedBot || isSlashCommand) {
      // Always respond when bot is @mentioned or slash command
    } else if (directedAtOthers && !mentionedTriggerUser) {
      log.info(`skipped group message ${messageId} (directed at other users, not bot)`);
      return null;
    } else if (mentionedTriggerUser && isInThread) {
      log.info(`skipped group message ${messageId} (triggerUser mentioned in thread, not top-level)`);
      return null;
    } else if (!isMonitor && !mentionedTriggerUser) {
      log.info(`skipped group message ${messageId} (chatId=${ctx.chatId}, not mentioned, not monitored)`);
      return null;
    } else if (isMonitor && directedAtOthers) {
      log.info(`skipped group message ${messageId} (monitor group but directed at other users)`);
      return null;
    }
    monitored = (isMonitor || mentionedTriggerUser) && !ctx.mentionedBot;
  }
```

- [ ] **Step 3: Simplify startWebSocketListener**

In `startWebSocketListener()` (line 557+):

Remove `allowedGroups`/`monitorGroups` local variables (lines 572-573). Remove `_updateGroupLists` function (lines 577-588).

Simplify the processFeishuMessageEvent call (line 613) to only pass `triggerUserIds`:
```typescript
const msg = await processFeishuMessageEvent(client, event, botOpenId, { triggerUserIds });
```

The `_updateGroupLists` function on the returned handle can become a no-op or be removed, since group additions now go directly to DB.

- [ ] **Step 4: Verify no compile errors**

Run: `bun build src/connectors/feishu/receive.ts --no-bundle 2>&1 | head -20`

- [ ] **Step 5: Commit**

```bash
git add src/connectors/feishu/receive.ts
git commit -m "refactor: replace TOML-based group filtering with DB lookup"
```

---

### Task 5: Daemon — Replace BotProfile/CWD Routing in core.ts

**Files:**
- Modify: `src/core.ts:175-200` (replace `_resolveBotProfile` and `_getProjectCwd`)
- Modify: `src/core.ts:283-337` (replace routing logic in `_processStream`)
- Modify: `src/core.ts:955-968` (simplify Remi.boot feishu setup)

- [ ] **Step 1: Replace _resolveBotProfile and _getProjectCwd**

Add import at top of `src/core.ts`:
```typescript
import { GroupConfigStore } from "./group/store.js";
import type { GroupConfig } from "./group/model.js";
```

Replace `_resolveBotProfile()` (lines 181-188) and `_getProjectCwd()` (lines 191-200) with a single method:

```typescript
  /** Look up group config from DB by chatId. Returns all routing info in one query. */
  private _getGroupConfig(chatId: string): GroupConfig | null {
    try {
      const store = new GroupConfigStore();
      return store.getByChatId(chatId);
    } catch {
      return null;
    }
  }
```

- [ ] **Step 2: Update _processStream to use GroupConfig**

In `_processStream()` (around line 302-336), replace:

```typescript
    const botProfile = this._resolveBotProfile(msg);
    const projectCwd = this._getProjectCwd(msg.chatId);
    const cwd = projectCwd || botProfile?.cwd || sessDb.getSession(sessionKey)?.cwd || (msg.metadata?.cwd as string) || undefined;
```

With:

```typescript
    const groupConfig = this._getGroupConfig(msg.chatId);
    const cwd = groupConfig?.cwd || sessDb.getSession(sessionKey)?.cwd || (msg.metadata?.cwd as string) || undefined;
```

Update `streamOptions` (around line 316-327) — replace `botProfile` references:

```typescript
    const streamOptions = {
      systemPrompt: groupConfig?.systemPrompt || undefined,
      chatId: this._resolveSessionKey(msg),
      sessionId: existingSessionId,
      cwd: cwd ?? undefined,
      media: msg.media,
      allowedTools: groupConfig?.allowedTools?.length ? groupConfig.allowedTools : undefined,
      addDirs: groupConfig?.addDirs?.length ? groupConfig.addDirs : undefined,
      permissionMode: sessRow?.mode ?? undefined,
      traceId: msgTraceId,
      signal: abortController.signal,
    };
```

Update provider selection (around line 333-336):

```typescript
    const providerName =
      groupConfig?.provider                              // group-level config (DB)
      ?? sessRow?.provider                               // P2P user choice
      ?? null;                                           // fall through to default
```

Update the log line (around line 309) — replace `botProfile` reference:

```typescript
    _log.info(`session lookup: key="${sessionKey}" → ${existingSessionId ? `resume="${existingSessionId.slice(0, 12)}..."` : "new session"}${groupConfig ? ` [group: ${groupConfig.projectId}]` : ""}`);
```

- [ ] **Step 3: Simplify Remi.boot() feishu setup**

In `Remi.boot()` (around lines 955-968), remove the bot profile groups → allowedGroups loop:

```typescript
    // 3. Feishu connector
    if (hasFeishuCreds) {
      const feishuConfig = { ...config.feishu };
      // No longer need to merge bot profile groups into allowedGroups —
      // group filtering is now DB-based via group_configs table.

      const feishu = new FeishuConnector(feishuConfig);
```

Remove `feishu.setBotProfiles(config.bots)` call (line 968) if the method is only used for filtering. Check if FeishuConnector uses botProfiles for anything else — if only for the old filtering, remove.

- [ ] **Step 4: Verify no compile errors**

Run: `bun build src/core.ts --no-bundle 2>&1 | head -20`

- [ ] **Step 5: Commit**

```bash
git add src/core.ts
git commit -m "refactor: replace BotProfile/CWD routing with GroupConfig DB lookup"
```

---

### Task 6: Update Project Init Flow

**Files:**
- Modify: `src/project/init.ts:148-166` (Step 3: write group_configs instead of TOML)
- Modify: `src/project/init.ts:94-108` (Step 1: add group to DB after creating chat)

- [ ] **Step 1: Add GroupConfigStore import**

At top of `src/project/init.ts`, add:
```typescript
import { GroupConfigStore } from "../group/store.js";
```

- [ ] **Step 2: Update Step 1 (create_chat) — add group to DB**

After the chat is created and chat_id is stored (around line 104-108), add group_configs insertion:

```typescript
  const step1 = await runStep(store, projectId, "create_chat", async () => {
    // ... existing chat creation logic ...

    // After storing chatId in projects table, also add to group_configs
    const gcStore = new GroupConfigStore();
    gcStore.upsert({
      chatId: chatId,  // the newly created chat's ID
      projectId: projectId,
      monitor: true,  // project groups auto-reply by default
      replyMode: "thread",
    });

    return chatId;  // existing return
  });
```

- [ ] **Step 3: Replace Step 3 (write_config) — no more TOML writes**

Replace the write_config step (lines 149-166):

```typescript
  const step3 = await runStep(store, projectId, "write_config", async () => {
    const project = store.getById(projectId)!;

    // Ensure group_configs has an entry for this project's chat
    if (project.chatId) {
      const gcStore = new GroupConfigStore();
      gcStore.upsert({
        chatId: project.chatId,
        projectId: projectId,
        monitor: true,
        replyMode: "thread",
      });
    }

    return "group config registered";
  });
```

Remove the `remiData.saveProject()` and `remiData.addBotProfile()` calls entirely from init flow.

- [ ] **Step 4: Update retryProjectInit if needed**

The retry function (line 181) calls `runProjectInit` which will now use the updated steps. No additional changes needed.

- [ ] **Step 5: Commit**

```bash
git add src/project/init.ts
git commit -m "refactor: project init writes group_configs instead of TOML"
```

---

### Task 7: Groups REST API

**Files:**
- Create: `web/handlers/groups.ts`
- Modify: `web/server.ts` (register handler)

- [ ] **Step 1: Create groups handler**

Create `web/handlers/groups.ts`:

```typescript
import type { Hono } from "hono";
import { GroupConfigStore } from "../../src/group/store.js";

export function registerGroupHandlers(app: Hono) {
  const store = new GroupConfigStore();

  // List all group configs
  app.get("/api/v1/groups", (c) => {
    return c.json(store.list());
  });

  // Get single group config
  app.get("/api/v1/groups/:chatId", (c) => {
    const chatId = decodeURIComponent(c.req.param("chatId"));
    const config = store.getByChatId(chatId);
    if (!config) return c.json({ error: "not found" }, 404);
    return c.json(config);
  });

  // Create group config
  app.post("/api/v1/groups", async (c) => {
    const body = await c.req.json();
    if (!body.chatId) return c.json({ error: "chatId required" }, 400);
    store.upsert(body);
    return c.json({ ok: true });
  });

  // Update group config
  app.put("/api/v1/groups/:chatId", async (c) => {
    const chatId = decodeURIComponent(c.req.param("chatId"));
    const body = await c.req.json();
    const ok = store.update(chatId, body);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // Delete group config
  app.delete("/api/v1/groups/:chatId", (c) => {
    const chatId = decodeURIComponent(c.req.param("chatId"));
    const ok = store.delete(chatId);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // Count groups per project (for Projects tab display)
  app.get("/api/v1/groups/count-by-project", (c) => {
    return c.json(store.countByProject());
  });
}
```

- [ ] **Step 2: Register in server.ts**

In `web/server.ts`, add import and registration:

```typescript
import { registerGroupHandlers } from "./handlers/groups.js";
```

Add after `registerProjectHandlers(app, data)`:
```typescript
registerGroupHandlers(app);
```

- [ ] **Step 3: Commit**

```bash
git add web/handlers/groups.ts web/server.ts
git commit -m "feat: add Groups REST API (/api/v1/groups)"
```

---

### Task 8: Update Projects Handler — Remove TOML Writes

**Files:**
- Modify: `web/handlers/projects.ts`

- [ ] **Step 1: Remove TOML write calls**

In `web/handlers/projects.ts`, remove `data.saveProject()` and `data.deleteProject()` calls. The handler should only write to DB:

```typescript
import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { ProjectStore } from "../../src/project/store.js";
import { GroupConfigStore } from "../../src/group/store.js";

export function registerProjectHandlers(app: Hono, _data: RemiData) {
  const store = new ProjectStore();
  const gcStore = new GroupConfigStore();

  // List all projects with group counts
  app.get("/api/v1/projects", (c) => {
    const projects = store.list();
    const groupCounts = gcStore.countByProject();
    return c.json(
      projects.map((p) => ({
        ...p,
        groupCount: groupCounts[p.id] ?? 0,
      })),
    );
  });

  // Simple create (alias + path, for backward compat)
  app.post("/api/v1/projects", async (c) => {
    const { alias, path } = (await c.req.json()) as { alias: string; path: string };
    if (!alias || !path) return c.json({ error: "alias and path required" }, 400);

    const existing = store.getById(alias);
    if (existing) {
      store.updateField(alias, "cwd", path);
    } else {
      store.create({
        alias,
        name: alias,
        dirMode: "existing",
        existingPath: path,
      });
      store.updateInitStatus(alias, "completed");
    }
    return c.json({ ok: true });
  });

  // Update path
  app.put("/api/v1/projects/:alias", async (c) => {
    const alias = decodeURIComponent(c.req.param("alias"));
    const { path } = (await c.req.json()) as { path: string };
    if (!path) return c.json({ error: "path required" }, 400);

    const existing = store.getById(alias);
    if (!existing) return c.json({ error: "not found" }, 404);

    store.updateField(alias, "cwd", path);
    return c.json({ ok: true });
  });

  // Delete (soft)
  app.delete("/api/v1/projects/:alias", (c) => {
    const alias = decodeURIComponent(c.req.param("alias"));
    const ok = store.delete(alias);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add web/handlers/projects.ts
git commit -m "refactor: remove TOML writes from projects handler, add group counts"
```

---

### Task 9: Frontend — Types + API Client

**Files:**
- Modify: `web/frontend/src/api/types.ts`
- Modify: `web/frontend/src/api/client.ts`

- [ ] **Step 1: Add GroupConfig types**

In `web/frontend/src/api/types.ts`, add:

```typescript
export interface GroupConfig {
  chatId: string;
  projectId: string;
  name: string;
  monitor: boolean;
  replyMode: "thread" | "direct";
  systemPrompt: string;
  allowedTools: string[];
  addDirs: string[];
  provider?: string;
  createdAt: string;
  updatedAt: string;
  cwd?: string;
  projectName?: string;
}

export interface GroupConfigInput {
  chatId: string;
  projectId?: string;
  name?: string;
  monitor?: boolean;
  replyMode?: "thread" | "direct";
  systemPrompt?: string;
  allowedTools?: string[];
  addDirs?: string[];
  provider?: string;
}
```

Add `groupCount` to the Project type:
```typescript
// Add to existing Project interface:
groupCount?: number;
```

- [ ] **Step 2: Add groups API functions**

In `web/frontend/src/api/client.ts`, add:

```typescript
// ── Groups ──
export const getGroups = () =>
  request<GroupConfig[]>("/api/v1/groups");

export const createGroup = (input: GroupConfigInput) =>
  request<{ ok: true }>("/api/v1/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const updateGroup = (chatId: string, fields: Partial<GroupConfigInput>) =>
  request<{ ok: true }>(`/api/v1/groups/${encodeURIComponent(chatId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });

export const deleteGroup = (chatId: string) =>
  request<{ ok: true }>(`/api/v1/groups/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
  });
```

Add import for the new types at the top of client.ts.

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/api/types.ts web/frontend/src/api/client.ts
git commit -m "feat: add GroupConfig frontend types and API client"
```

---

### Task 10: Frontend — Groups Tab in Projects Page

**Files:**
- Modify: `web/frontend/src/pages/Projects.tsx`

This is the largest frontend change. Add a tab system with the existing Projects tab and a new Groups tab.

- [ ] **Step 1: Add tab state and Groups tab structure**

At the top of the Projects component, add tab state:

```typescript
const [activeTab, setActiveTab] = useState<"projects" | "groups">("projects");
const [groups, setGroups] = useState<GroupConfig[]>([]);
const [showGroupDialog, setShowGroupDialog] = useState(false);
const [editingGroup, setEditingGroup] = useState<GroupConfig | null>(null);
```

Add fetch function:
```typescript
const fetchGroups = async () => {
  try {
    const data = await getGroups();
    setGroups(data);
  } catch (e) {
    console.error("Failed to fetch groups:", e);
  }
};

useEffect(() => {
  if (activeTab === "groups") fetchGroups();
}, [activeTab]);
```

- [ ] **Step 2: Add tab buttons above the content**

Before the project table, add tab navigation:

```tsx
<div className="flex gap-2 mb-4">
  <button
    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      activeTab === "projects"
        ? "bg-zinc-800 text-white"
        : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
    }`}
    onClick={() => setActiveTab("projects")}
  >
    Projects
  </button>
  <button
    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      activeTab === "groups"
        ? "bg-zinc-800 text-white"
        : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
    }`}
    onClick={() => setActiveTab("groups")}
  >
    Groups
  </button>
</div>
```

- [ ] **Step 3: Create Groups table**

Wrap existing projects content in `{activeTab === "projects" && (...)}`, then add:

```tsx
{activeTab === "groups" && (
  <Card>
    <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
      <h3 className="text-sm font-medium text-zinc-300">Group Configurations</h3>
      <Button size="sm" onClick={() => { setEditingGroup(null); setShowGroupDialog(true); }}>
        Add Group
      </Button>
    </div>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Chat ID</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Project</TableHead>
          <TableHead>Monitor</TableHead>
          <TableHead>Reply Mode</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead className="w-20">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((g) => (
          <TableRow key={g.chatId}>
            <TableCell className="font-mono text-xs">{g.chatId}</TableCell>
            <TableCell>{g.name || "—"}</TableCell>
            <TableCell>
              <Badge variant={g.projectId === "global" ? "secondary" : "default"}>
                {g.projectName || g.projectId}
              </Badge>
            </TableCell>
            <TableCell>
              <button
                onClick={async () => {
                  await updateGroup(g.chatId, { monitor: !g.monitor });
                  fetchGroups();
                }}
                className={`w-8 h-4 rounded-full transition-colors ${
                  g.monitor ? "bg-emerald-500" : "bg-zinc-600"
                }`}
              >
                <span className={`block w-3 h-3 rounded-full bg-white transition-transform ${
                  g.monitor ? "translate-x-4" : "translate-x-0.5"
                }`} />
              </button>
            </TableCell>
            <TableCell>{g.replyMode}</TableCell>
            <TableCell>{g.provider || "default"}</TableCell>
            <TableCell>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => { setEditingGroup(g); setShowGroupDialog(true); }}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" className="text-red-400" onClick={async () => {
                  if (confirm(`Remove group ${g.chatId}?`)) {
                    await deleteGroup(g.chatId);
                    fetchGroups();
                  }
                }}>
                  Delete
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
        {groups.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} className="text-center text-zinc-500 py-8">
              No group configs found. Run migration or add groups manually.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  </Card>
)}
```

- [ ] **Step 4: Create Group edit/create dialog**

Add a dialog component (inside the Projects page component):

```tsx
{showGroupDialog && (
  <Dialog open={showGroupDialog} onOpenChange={setShowGroupDialog}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{editingGroup ? "Edit Group" : "Add Group"}</DialogTitle>
      </DialogHeader>
      <GroupForm
        initial={editingGroup}
        projects={projects}
        onSave={async (input) => {
          if (editingGroup) {
            await updateGroup(editingGroup.chatId, input);
          } else {
            await createGroup(input);
          }
          setShowGroupDialog(false);
          fetchGroups();
        }}
        onCancel={() => setShowGroupDialog(false)}
      />
    </DialogContent>
  </Dialog>
)}
```

Create the `GroupForm` as a local component within the same file:

```tsx
function GroupForm({ initial, projects, onSave, onCancel }: {
  initial: GroupConfig | null;
  projects: Project[];
  onSave: (input: GroupConfigInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [chatId, setChatId] = useState(initial?.chatId ?? "");
  const [projectId, setProjectId] = useState(initial?.projectId ?? "global");
  const [name, setName] = useState(initial?.name ?? "");
  const [monitor, setMonitor] = useState(initial?.monitor ?? false);
  const [replyMode, setReplyMode] = useState(initial?.replyMode ?? "thread");
  const [provider, setProvider] = useState(initial?.provider ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [allowedTools, setAllowedTools] = useState(initial?.allowedTools?.join(", ") ?? "");
  const [addDirs, setAddDirs] = useState(initial?.addDirs?.join(", ") ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm text-zinc-400">Chat ID</label>
        <Input value={chatId} onChange={(e) => setChatId(e.target.value)} disabled={!!initial} placeholder="oc_xxxxxxx" />
      </div>
      <div>
        <label className="text-sm text-zinc-400">Name (optional)</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Group display name" />
      </div>
      <div>
        <label className="text-sm text-zinc-400">Project</label>
        <select
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="global">Global (no project)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
          ))}
        </select>
      </div>
      <div className="flex gap-4">
        <div className="flex items-center gap-2">
          <input type="checkbox" checked={monitor} onChange={(e) => setMonitor(e.target.checked)} />
          <label className="text-sm text-zinc-400">Monitor (auto-reply)</label>
        </div>
        <div>
          <select
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
            value={replyMode}
            onChange={(e) => setReplyMode(e.target.value as "thread" | "direct")}
          >
            <option value="thread">Thread</option>
            <option value="direct">Direct</option>
          </select>
        </div>
      </div>
      <div>
        <label className="text-sm text-zinc-400">Provider</label>
        <select
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="">Default</option>
          <option value="claude_cli">Claude CLI</option>
          <option value="aiden_cli">Aiden CLI</option>
        </select>
      </div>

      <button className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setShowAdvanced(!showAdvanced)}>
        {showAdvanced ? "Hide" : "Show"} Advanced
      </button>

      {showAdvanced && (
        <div className="space-y-3 border-t border-zinc-800 pt-3">
          <div>
            <label className="text-sm text-zinc-400">System Prompt</label>
            <textarea
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm min-h-[80px]"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm text-zinc-400">Allowed Tools (comma-separated)</label>
            <Input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder="Read, Write, Bash" />
          </div>
          <div>
            <label className="text-sm text-zinc-400">Additional Dirs (comma-separated)</label>
            <Input value={addDirs} onChange={(e) => setAddDirs(e.target.value)} placeholder="/path/to/dir" />
          </div>
        </div>
      )}

      <div className="flex gap-2 justify-end pt-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSave({
          chatId,
          projectId,
          name,
          monitor,
          replyMode,
          provider: provider || undefined,
          systemPrompt,
          allowedTools: allowedTools ? allowedTools.split(",").map((s) => s.trim()).filter(Boolean) : [],
          addDirs: addDirs ? addDirs.split(",").map((s) => s.trim()).filter(Boolean) : [],
        })}>
          {initial ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add necessary imports**

Add to the imports at top of Projects.tsx:

```typescript
import { getGroups, createGroup, updateGroup, deleteGroup } from "@/api/client";
import type { GroupConfig, GroupConfigInput } from "@/api/types";
```

- [ ] **Step 6: Build and verify**

Run: `cd web/frontend && npm run build 2>&1 | tail -10`
Expected: Build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add web/frontend/src/pages/Projects.tsx web/frontend/src/api/types.ts web/frontend/src/api/client.ts
git commit -m "feat: add Groups tab to Dashboard with full config management UI"
```

---

### Task 11: Integration Verification

- [ ] **Step 1: Start the daemon and verify migration**

```bash
bun run src/main.ts serve
```

Check logs for: "Starting group_configs migration from TOML..." and "Migration complete: X group configs created"

- [ ] **Step 2: Verify DB state**

```bash
sqlite3 ~/.remi/remi.db "SELECT chat_id, project_id, monitor, reply_mode FROM group_configs"
```

Expected: All previous TOML groups are now in the table.

- [ ] **Step 3: Verify Dashboard**

Open Dashboard → Projects → Groups tab. Verify all migrated groups are visible with correct config.

- [ ] **Step 4: Test group filtering**

Send a message in a configured group — should respond.
Send a message in an unconfigured group — should be blocked.

- [ ] **Step 5: Test adding a new group via Dashboard**

Add a group config via Dashboard UI → verify it appears in DB → send message in that group → should respond.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete DB single-source migration for project/group configs"
```
