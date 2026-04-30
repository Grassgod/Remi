# 项目/群组配置 DB 单源化设计

> 将项目和群组配置统一为 DB 单源，废弃 TOML 多源，并建设 Dashboard 可视化管理。

## 现状问题

三个配置源并存，维护困难：

| 配置源 | 管理内容 | 问题 |
|--------|----------|------|
| `remi.toml` `[feishu]` | allowed_groups, monitor_groups | 静态，改了要重启 |
| `remi.toml` `[[bots]]` | BotProfile: cwd, reply_mode, tools, provider | 散落在配置文件，无法可视化 |
| DB `projects` 表 | id, name, chat_id, cwd, repo_url | 只存基础信息，不含回复配置 |

daemon 群过滤和 cwd 路由两头读（config + DB），逻辑分散。

## 目标

1. **DB 为唯一配置源** — 群过滤、cwd 路由、回复模式、tools 全部从 DB 读取
2. **群为一等公民** — `group_configs` 表以 chat_id 为主键，存储所有群级配置
3. **一次性迁移** — 启动时把 TOML 中的 bots/groups 配置迁入 DB
4. **废弃 TOML 群配置** — `[[bots]]`、`allowed_groups`、`monitor_groups` 不再使用
5. **Dashboard 可视化管理** — 群配置的增删改查全在 Web UI 完成

## 数据模型

### projects 表（微调）

保持现有结构，**移除 `chat_id` 字段**（群关联由 `group_configs` 管理）。

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,               -- alias, e.g. "larkparser-ts"
  name TEXT NOT NULL,
  repo_url TEXT,
  cwd TEXT,
  pipeline_config TEXT,
  init_status TEXT DEFAULT 'pending',
  init_steps TEXT,
  deleted INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

> `chat_id` 列保留但不再写入，避免破坏性 ALTER。新代码不读取此字段。

### group_configs 表（新建）

```sql
CREATE TABLE IF NOT EXISTS group_configs (
  chat_id TEXT PRIMARY KEY,                    -- 飞书群 ID，唯一主键
  project_id TEXT DEFAULT 'global',            -- 关联项目 ID，默认 global
  name TEXT DEFAULT '',                        -- 群名备注（方便 Dashboard 展示）
  monitor INTEGER DEFAULT 0,                   -- 1=自动回复所有消息，0=需@mention
  reply_mode TEXT DEFAULT 'thread',            -- 'thread' | 'direct'
  system_prompt TEXT DEFAULT '',               -- 自定义系统提示词
  allowed_tools TEXT DEFAULT '[]',             -- JSON array of tool names
  add_dirs TEXT DEFAULT '[]',                  -- JSON array of additional dirs
  provider TEXT,                               -- 'claude_cli' | 'aiden_cli' | null(使用默认)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gc_project ON group_configs(project_id);
```

### 实体关系

```
projects (1) ←── (N) group_configs    一个项目关联多个群
projects (1) ←── (N) missions         一个项目有多个任务（看板）
group_configs (1) ←── (N) missions    任务在某个群中创建
```

### global 项目

迁移时自动创建 `id='global'` 的项目，挂载没有明确项目关联的群：

```sql
INSERT OR IGNORE INTO projects (id, name, cwd, init_status)
VALUES ('global', 'Global', NULL, 'completed');
```

## 查询路径

### 消息进入时的群配置查询

```sql
SELECT gc.*, p.cwd, p.id as proj_id
FROM group_configs gc
LEFT JOIN projects p ON gc.project_id = p.id AND (p.deleted = 0 OR p.deleted IS NULL)
WHERE gc.chat_id = ?
```

- 有结果 → allowed，使用返回的配置
- 无结果 → rejected，不响应

### TypeScript 接口

```typescript
interface GroupConfig {
  chatId: string;
  projectId: string;
  name: string;
  monitor: boolean;
  replyMode: 'thread' | 'direct';
  systemPrompt: string;
  allowedTools: string[];
  addDirs: string[];
  provider?: string;
  // JOIN 来的
  cwd?: string;
}
```

## 启动迁移逻辑

在 `getDb()` 中执行，与现有迁移模式一致（检查表/列是否存在，幂等执行）。

### 迁移步骤

```
1. 建 group_configs 表（CREATE TABLE IF NOT EXISTS）
2. 检查表是否为空（SELECT COUNT(*) = 0）
   - 非空 → 跳过迁移（已执行过）
   - 空 → 执行以下步骤
3. 创建 global 项目（INSERT OR IGNORE）
4. 遍历 config.bots（TOML [[bots]]）：
   a. 按 cwd 匹配已有 project，或创建新 project
   b. 为每个 bot.groups[] 中的 chat_id：
      INSERT INTO group_configs (chat_id, project_id, reply_mode,
        system_prompt, allowed_tools, add_dirs, provider)
      VALUES (?, matched_project_id, bot.replyMode, bot.systemPrompt,
        JSON(bot.allowedTools), JSON(bot.addDirs), bot.provider)
5. 遍历 config.feishu.allowedGroups：
   - 不在 group_configs 中的 → INSERT (chat_id, project_id='global', monitor=0)
6. 遍历 config.feishu.monitorGroups：
   - UPDATE group_configs SET monitor=1 WHERE chat_id IN (...)
7. 遍历已有 projects 表中 chat_id 非空的行：
   - 确保 group_configs 中有对应记录（INSERT OR IGNORE）
8. 输出日志：迁移了 X 个群配置，Y 个项目
```

### 幂等保证

- `CREATE TABLE IF NOT EXISTS` — 表已存在不报错
- `COUNT(*) = 0` 检查 — 只在首次执行
- `INSERT OR IGNORE` — chat_id 已存在不覆盖

## Daemon 改造

### receive.ts — 群过滤

**废弃：**
- `_isProjectChat()` 函数
- `opts.allowedGroups` / `opts.monitorGroups` 参数传递

**替换为：**

```typescript
function getGroupConfig(chatId: string): GroupConfig | null {
  const row = getDb().query(`
    SELECT gc.*, p.cwd
    FROM group_configs gc
    LEFT JOIN projects p ON gc.project_id = p.id
      AND (p.deleted = 0 OR p.deleted IS NULL)
    WHERE gc.chat_id = ?
  `).get(chatId);
  if (!row) return null;
  return {
    chatId: row.chat_id,
    projectId: row.project_id,
    name: row.name,
    monitor: !!row.monitor,
    replyMode: row.reply_mode,
    systemPrompt: row.system_prompt,
    allowedTools: JSON.parse(row.allowed_tools || '[]'),
    addDirs: JSON.parse(row.add_dirs || '[]'),
    provider: row.provider || undefined,
    cwd: row.cwd || undefined,
  };
}
```

**群过滤决策树（简化后）：**

```
消息到达 (chatType === 'group')
  → getGroupConfig(chatId)
  → null → 拒绝
  → 有配置:
    - @bot 或 slash command → 响应
    - config.monitor === true 且无特定 @mention → 响应（monitored=true）
    - 有 triggerUser @mention（顶级消息） → 响应
    - 其他 → 拒绝
```

`trigger_user_ids` 继续从 TOML config 读取（全局设置）。

### core.ts — 路由

**废弃：**
- `_resolveBotProfile()` — 不再需要 BotProfile 匹配
- `_getProjectCwd()` — 合并到 GroupConfig 查询中

**替换为：**

`GroupConfig` 已包含 cwd、provider、addDirs 等全部信息，直接使用。

CWD 优先级简化：
```
1. GroupConfig.cwd（来自关联 project）
2. Session.cwd（用户通过 /project 命令设置）
3. Message metadata.cwd
4. undefined（CLI 默认）
```

### config.ts — 类型清理

- `BotProfile` interface 标记为 deprecated（迁移仍需读取）
- `RemiConfig.bots` 字段标记为 deprecated
- `FeishuConfig.allowedGroups` / `monitorGroups` 标记为 deprecated
- 新增 `getGroupConfig()` / `listGroupConfigs()` 查询函数

## Dashboard UI

### 页面结构

Projects 页拆分为两个 Tab：

**Tab 1: 项目 (Projects)**
- 现有项目列表（移除 chat_id 列）
- 新增"关联群数"列（COUNT from group_configs）
- 新建/编辑/删除不变

**Tab 2: 群配置 (Groups)**

| 列 | 说明 |
|----|------|
| 群 ID | chat_id，不可编辑 |
| 群名 | 备注名，可编辑 |
| 关联项目 | 下拉选择 projects，可选 global |
| Monitor | 开关 toggle |
| 回复模式 | thread / direct 下拉 |
| Provider | claude_cli / aiden_cli / 默认 |
| Tools | 多选或文本输入 |
| 操作 | 编辑 / 删除 |

**新增群弹窗：**
- 输入 chat_id（必填）
- 选择关联项目（默认 global）
- 配置 monitor、reply_mode、provider
- 高级展开：system_prompt、allowed_tools、add_dirs

### API 端点

```
GET    /api/v1/groups              — 列表（JOIN projects 拿项目名和 cwd）
POST   /api/v1/groups              — 新增群配置
PUT    /api/v1/groups/:chatId      — 更新群配置
DELETE /api/v1/groups/:chatId      — 删除群配置
```

## TOML 变更

### 迁移后 remi.toml 最终形态

```toml
[feishu]
app_id = "cli_xxx"
app_secret = "xxx"
trigger_user_ids = ["ou_xxx"]    # 保留，全局设置

# ❌ 以下字段废弃，迁移后不再读取
# allowed_groups = [...]
# monitor_groups = [...]

# ❌ [[bots]] 整个 section 废弃
# [[bots]]
# id = "larkparser"
# groups = [...]

[[cron.jobs]]                     # 保留，调度任务
name = "daily-briefing"
schedule = "15 10 * * *"
# ...
```

## 不变的部分

- `trigger_user_ids` — 保留在 TOML，全局设置
- `feishu.app_id / app_secret` — 保留在 TOML / env
- `[[cron.jobs]]` — 保留在 TOML（已由 remi.toml 单源管理）
- `missions` 表 — 不改动
- `sessions` 表 — 不改动
- `conversations` 表 — 不改动
- Project init 流程 — Step 3 (Write Config) 改为写 group_configs 行（chat_id + project_id），不再写 TOML [[bots]]；Step 1 创建群后直接 INSERT group_configs

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 迁移丢数据 | 幂等迁移 + 不删除 TOML 原文件 |
| 群配置查询性能 | chat_id 是主键，单行查询 O(1) |
| 回滚困难 | TOML 文件不修改，保留为备份；代码可快速回退到读 TOML |
| Dashboard 操作失误 | 软删除（或者 DELETE 前确认弹窗） |
