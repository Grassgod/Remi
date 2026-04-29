# Project Init — 完整流程设计

**Date:** 2026-03-30
**Author:** Jack / Remi
**Status:** Draft

## 概述

在 Dashboard Projects 页面实现一键创建项目的完整流程：创建飞书项目群 → 创建/关联本地工作目录 → 写入配置 → 注册 DB。全程通过 Stepper UI 展示进度，状态持久化到 DB，支持关页面后恢复、失败重试。

## 需求确认

| 项 | 决策 |
|----|------|
| 触发方式 | Dashboard Projects 页「新建项目」按钮 |
| 进度 UI | Stepper 步骤条（CI pipeline 风格） |
| 飞书群成员 | 仅 Remi Bot + Jack |
| 本地目录 | 两种模式：从 GitHub clone / 选已有目录 |
| 错误处理 | 幂等步骤 + 从失败步恢复重试 |
| 状态持久化 | 每步状态写 DB，关页面后可恢复 |
| 数据存储 | 复用/新建 `projects` 表，不加新表 |

## 数据模型

### projects 表（新建）

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,                -- slug/alias，如 "larkparser"
  name TEXT NOT NULL,                 -- 显示名称，如 "LarkParser TS"
  chat_id TEXT,                       -- 飞书项目群 ID
  repo_url TEXT,                      -- GitHub 仓库地址
  cwd TEXT,                           -- 本地代码路径
  pipeline_config TEXT,               -- JSON，流水线配置（可选）
  init_status TEXT DEFAULT 'pending', -- pending | running | completed | failed
  init_steps TEXT,                    -- JSON: InitStep[]
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### InitStep 类型

```typescript
interface InitStep {
  name: "create_chat" | "setup_dir" | "write_config" | "register_complete";
  label: string;           // 显示文本
  status: "pending" | "running" | "done" | "error";
  result?: string;         // 成功时的摘要（如 chatId、cwd 路径）
  error?: string;          // 失败时的错误信息
  startedAt?: string;
  completedAt?: string;
}
```

### ProjectInitInput（前端表单提交）

```typescript
interface ProjectInitInput {
  alias: string;           // 项目 slug
  name: string;            // 显示名称
  repoUrl?: string;        // GitHub 仓库 URL（可选）
  dirMode: "clone" | "existing";
  parentDir?: string;      // clone 模式：clone 到哪个父目录
  existingPath?: string;   // existing 模式：已有目录路径
}
```

### 兼容性

- `projects` 表是新的权威数据源
- 同时写入 `remi.toml` 的 `[projects]` section，保持 Claude Code `/project` 命令兼容
- 现有 `getProjects()` API 改为从 DB 读取，toml 作为同步写入目标
- 迁移：首次启动时，将 toml 中已有的 projects 导入 DB

## Init 流程（4 步）

### Step 1: 创建飞书项目群

- 调用飞书 Open API `POST /open-apis/im/v1/chats`
- 群名：`[Remi] {name}`（如 `[Remi] LarkParser TS`）
- 成员：Remi Bot (通过 app 身份自动在群内) + Owner (open_id 来自 `feishu.trigger_user_ids[0]`)
- 产出：`chatId`
- 幂等：执行前查 DB，若 `chat_id` 已存在则跳过

### Step 2: 创建/关联本地工作目录

- **clone 模式**：`git clone {repoUrl} {parentDir}/{alias}`，产出 clone 后的绝对路径
- **existing 模式**：检查 `existingPath` 是否存在，产出该路径
- 幂等：目录已存在且是 git repo → 跳过 clone（`git pull` 也不做，避免冲突）

### Step 3: 写入 remi.toml

- 在 `[projects]` section 写入 `alias = "cwd_path"`
- 复用现有 `RemiData.saveProject()` 逻辑
- 幂等：已有同名 alias → 覆盖更新

### Step 4: 注册完成

- 将所有产出（chatId、cwd、repoUrl）写入 `projects` 表
- 更新 `init_status = "completed"`
- 幂等：`INSERT OR REPLACE`

## 后端 API

### 新增 endpoints

```
POST   /api/v1/projects/init          → 启动 init 流程
GET    /api/v1/projects/init/:id       → 获取 init 状态（轮询/恢复用）
POST   /api/v1/projects/init/:id/retry → 从失败步重试
GET    /api/v1/projects/init/:id/stream → SSE 实时进度推送
```

### POST /api/v1/projects/init

请求体：`ProjectInitInput`

行为：
1. 在 DB 创建 `projects` 记录（`init_status = "running"`，`init_steps` 含 4 个 pending 步骤）
2. 异步启动编排函数，逐步执行
3. 立即返回 `{ id: "larkparser", status: "running" }`
4. 编排函数每完成一步更新 DB + 推送 SSE

### GET /api/v1/projects/init/:id/stream (SSE)

事件格式：

```
event: step
data: {"step":"create_chat","status":"running"}

event: step
data: {"step":"create_chat","status":"done","result":"oc_xxxxx"}

event: step
data: {"step":"setup_dir","status":"error","error":"git clone failed: ..."}

event: done
data: {"status":"completed"}
```

### GET /api/v1/projects/init/:id

返回完整 project 记录（含 `init_steps` JSON），用于页面恢复。

### POST /api/v1/projects/init/:id/retry

行为：读取 `init_steps`，找到第一个 `status = "error"` 的步骤，从该步继续执行。

### 改造现有 endpoints

- `GET /api/v1/projects` — 改为从 DB 读取，返回 `Project[]`（含 init_status 等完整字段）
- `DELETE /api/v1/projects/:alias` — 同时删 DB + toml；半初始化项目删除时可选清理飞书群

## 飞书建群实现

在 `src/connectors/feishu/` 下新增 `chat.ts`：

```typescript
export async function createProjectChat(
  client: LarkClient,
  name: string,
  ownerOpenId: string,
): Promise<string> {
  const res = await client.im.chat.create({
    data: {
      name: `[Remi] ${name}`,
      chat_mode: "group",
      chat_type: "private",
      user_id_list: [ownerOpenId],
    },
    params: { user_id_type: "open_id" },
  });
  return res.data!.chat_id!;
}
```

## 前端设计

### Projects 页面改造

现有 Projects 页面的「Add」按钮改为打开新的 Init Dialog（替代现有的 inline 表单）。

### Init Dialog（表单）

```
┌──────────────────────────────────────┐
│  New Project                         │
├──────────────────────────────────────┤
│                                      │
│  Alias *        [ larkparser-ts    ] │
│  Display Name * [ LarkParser TS    ] │
│  Repo URL       [ github.com/...   ] │
│                                      │
│  Directory Mode                      │
│  ○ Clone from GitHub                 │
│    Parent Dir   [ /data00/home/... ] │ ← DirPicker
│  ○ Use existing directory            │
│    Path         [ /data00/home/... ] │ ← DirPicker
│                                      │
│           [ Cancel ]  [ Create ]     │
└──────────────────────────────────────┘
```

- Clone 模式仅在填了 Repo URL 时可选
- DirPicker 复用现有组件

### Init 进度页面（Stepper）

提交后 Dialog 切换为进度视图（不跳转新页面，保持 Dialog 内）：

```
┌──────────────────────────────────────────┐
│  Initializing: LarkParser TS             │
├──────────────────────────────────────────┤
│                                          │
│  ● Create Feishu group ............. ✅  │
│    → oc_xxxxxxx                          │
│                                          │
│  ◐ Setup directory ................ ⏳  │
│    Cloning repository...                 │
│                                          │
│  ○ Write configuration ............. ─   │
│                                          │
│  ○ Register project ................ ─   │
│                                          │
│                              [ Cancel ]  │
└──────────────────────────────────────────┘
```

失败状态：

```
│  ● Create Feishu group ............. ✅  │
│    → oc_xxxxxxx                          │
│                                          │
│  ✗ Setup directory ................ ❌  │
│    Error: git clone failed: timeout      │
│                                          │
│  ○ Write configuration ............. ─   │
│  ○ Register project ................ ─   │
│                                          │
│                    [ Retry ]  [ Close ]   │
```

完成状态：

```
│  ● Create Feishu group ............. ✅  │
│  ● Setup directory ................. ✅  │
│  ● Write configuration ............. ✅  │
│  ● Register project ................ ✅  │
│                                          │
│  Project "larkparser-ts" is ready!       │
│                                          │
│            [ Go to Board ]  [ Close ]    │
```

### 项目列表展示

项目列表表格增加状态列：
- `completed` → 正常显示（无额外标记）
- `running` → 显示 spinner + "Initializing..."，可点击恢复进度视图
- `failed` → 红色 "Init failed"，可点击恢复进度视图重试

### 恢复逻辑

页面加载时 `GET /api/v1/projects` 返回所有项目含 `init_status`。如果有 `running` 或 `failed` 的项目，在列表中高亮显示，点击后打开进度 Dialog：
- `running` → 建立 SSE 连接继续监听
- `failed` → 展示已完成/失败步骤，提供 Retry 按钮

## 文件变更清单

### 新增

| 文件 | 说明 |
|------|------|
| `src/connectors/feishu/chat.ts` | 飞书建群 API 封装 |
| `src/project/store.ts` | ProjectStore — DB CRUD |
| `src/project/init.ts` | Init 编排器（4 步执行 + SSE 推送） |
| `src/project/model.ts` | Project 类型定义 |
| `web/handlers/project-init.ts` | Init API endpoints (init/stream/retry) |

### 修改

| 文件 | 说明 |
|------|------|
| `src/db/index.ts` | 添加 `projects` 表 DDL |
| `src/mission/model.ts` | 移除 `ProjectConfig`（迁移到 `src/project/model.ts`）|
| `web/handlers/projects.ts` | `GET /api/v1/projects` 改读 DB；保留 PUT/DELETE 兼容 |
| `web/remi-data.ts` | `saveProject()` 同时写 DB + toml |
| `web/frontend/src/pages/Projects.tsx` | 重写：Init Dialog + Stepper + 状态列 |
| `web/frontend/src/api/client.ts` | 新增 `initProject()`, `getInitStatus()`, `retryInit()` |
| `web/frontend/src/api/types.ts` | 新增 `Project`, `InitStep`, `ProjectInitInput` 类型 |
| `src/config.ts` | 启动时 toml→DB 迁移逻辑 |
| `src/core.ts` | `/project init` 改为调用 ProjectStore（保持 CLI 兼容）|

## 迁移策略

首次启动时执行一次性迁移：
1. 建 `projects` 表
2. 读 `remi.toml` 的 `[projects]`
3. 每个 entry 插入 DB：`id=alias, name=alias, cwd=path, init_status="completed"`
4. 迁移完成后 toml 保持不变（双写兼容）

## 不做的事

- 不做群成员管理 UI（后续手动拉人）
- 不做 repo 类型自动检测（GitHub/Codebase，手动填）
- 不做删除时自动解散飞书群（风险太高，手动处理）
- 不做 WebSocket（SSE 足够）
- 不做 `/project init` CLI 命令改造为完整流程（CLI 保持轻量，完整流程走 Dashboard）
