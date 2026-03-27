# Remi Dashboard Redesign — shadcn/ui 迁移设计文档

**Date:** 2026-03-27
**Author:** Jack + Remi
**Status:** Draft

---

## 1. 设计目标

从"系统监控面板"转型为**"个人 AI 协作工作台 + 运维面板"**双重定位。

核心原则：
- **页面可以少，信息不能丢** — 合并页面但保留所有数据
- **使用者视角优先** — 首页展示"今天 Remi 帮你做了什么"，运维数据折叠到二级
- **shadcn/ui 设计语言** — 现代化卡片阴影、丰富色彩、Dark/Light 双主题
- **移动端响应式** — Mobile-first，Bottom Nav 适配

---

## 2. 页面结构（16 → 12）

### 2.1 页面清单

| # | 页面 | 类型 | 说明 |
|---|------|------|------|
| 1 | **Dashboard** | 增强 | Today 首页，双栏布局，吸收 Monitor + Auth + DB/Config/Symlinks 摘要 |
| 2 | **Conversations** | 新增 | 对话历史，从 Board 复用数据，独立全页详情 |
| 3 | **Missions** | 新增 | 看板，从 Board (8090) 整合进主 Dashboard |
| 4 | **Analytics** | 增强 | Token 用量/成本追踪 |
| 5 | **Traces** | 增强 | 请求追踪 + WaterfallChart |
| 6 | **Logs** | 增强 | 结构化日志 |
| 7 | **Scheduler** | 增强 | 定时任务监控 |
| 8 | **Memory** | 增强 | 实体 + MEMORY.md + 日志，MemoryEntity 改为 Sheet |
| 9 | **Wiki** | 新增 | 知识库浏览器（wiki + soul + agents + CLAUDE.md + git 版本） |
| 10 | **Sessions** | 保留 | 会话管理 |
| 11 | **Projects** | 保留 | 工作区别名 CRUD |
| 12 | **Bot Menu** | 保留 | 飞书菜单构建器 |

### 2.2 被合并的页面（信息零丢失）

| 原页面 | 信息去向 |
|--------|----------|
| **Monitor** | Dashboard 系统状态区：Uptime、Latency P50/P95、Error Rate、Top Operations |
| **Auth** | Dashboard Token 面板：增强版进度条 + 过期倒计时 |
| **Database** | Dashboard 系统状态区：DB Size、KV Entries、Embeddings 数量 |
| **Config** | Dashboard 系统状态区：Config 版本/最后修改时间，点击可展开查看 |
| **Symlinks** | Dashboard 系统状态区：Symlink 健康状态（OK/Broken 计数） |
| **MemoryEntity** | Memory 页 Sheet 侧滑子视图 |
| **MemoryDaily** | Memory 页 Tab 内联渲染 |

---

## 3. 导航结构

### 3.1 Sidebar 分组

```
Overview
  └─ Dashboard

Workspace
  ├─ Conversations
  ├─ Missions
  ├─ Memory
  └─ Wiki

Observability
  ├─ Analytics
  ├─ Traces
  ├─ Logs
  └─ Scheduler

System
  ├─ Sessions
  ├─ Projects
  └─ Bot Menu
```

### 3.2 Mobile Bottom Nav

**主 Tab（4 个）：** Dashboard / Conversations / Missions / Memory

**More Sheet（8 个）：** Wiki / Analytics / Traces / Logs / Scheduler / Sessions / Projects / Bot Menu

### 3.3 Header

- 左侧：页面标题
- 右侧：Daemon 状态点 + Token 状态点 + Dark/Light 切换按钮
- 移除时钟（低价值，增加视觉噪音）

---

## 4. 各页面详细设计

### 4.1 Dashboard（Today 首页）

**布局：双栏**
- 顶部：4 张统计卡片（Today Chats / Tokens Used / Missions Progress / System Status）
- 左栏（60%）：Recent Conversations + Missions 概览
- 右栏（40%）：Memory Updates + Token Budget + System Health

**左栏内容：**

**Recent Conversations 面板**
- 对话列表：话题名、时间、token 消耗、消息数
- 最多显示 8 条，"View All" 跳转 Conversations 页
- 点击单条 → 跳转 Conversations 全页详情

**Missions 概览面板**
- 按状态分组的任务计数（In Progress / Done / Pending）
- 最近活跃的 3-5 个 Mission 卡片
- "View Board" 跳转 Missions 看板

**右栏内容：**

**Memory Updates 面板**
- 今日记忆变更：新增实体、更新实体、搜索统计
- 格式：`+ learned: xxx` / `~ updated: xxx`
- "View All" 跳转 Memory 页

**Token Budget 面板**
- 今日消耗进度条（已用 / 限额）
- 按模型分布（小 donut 或 bar）
- 本周累计成本

**System Health 面板（折叠式 Collapsible）**
- 默认状态：全部健康检查通过时收起，任何异常时自动展开
- 一行状态摘要：`All systems healthy` 或 `⚠ 2 issues`
- 点击可手动展开/收起，展开后显示：
  - Daemon: UP 3d 12h / PID
  - Auth Tokens: 3/3 valid, nearest expiry in 2d
  - Scheduler: 5/5 jobs healthy, 0 errors
  - Latency: P50 1.2s / P95 3.8s
  - DB: 12.3MB, 45 KV, 128 embeddings
  - Symlinks: 12 OK, 0 broken
  - Config: remi.toml, last modified 2h ago
  - Top Operations 表（从 Monitor 继承）

**刷新策略：** 10s 自动刷新系统数据，对话/任务列表 30s 刷新

### 4.2 Conversations（对话历史）

**列表视图（默认）：**
- 对话卡片列表：话题名、参与者（Jack ↔ Remi）、时间、消息数、token 消耗、状态（active/completed）
- 搜索：按话题名或内容搜索
- 筛选：按日期范围、项目
- 排序：最近活跃 / token 消耗最多

**详情视图（独立全页）：**
- 顶部 Breadcrumb：Conversations > 话题名
- 元数据栏：总 token、消息数、持续时间、关联项目
- 消息流：类聊天界面
  - Jack 消息：左对齐，浅色背景
  - Remi 消息：右对齐，品牌色背景
  - 时间戳、token 标注
- 支持长对话滚动

**数据源：** 复用 Board 的消息获取逻辑（Feishu API + CLI JSONL + DB 关联）。Board 的 `server.ts` 中 `/api/missions/:id/messages` 已实现消息聚合，迁移到主 Dashboard 的 handler 中。

### 4.3 Missions（看板）

**看板视图：**
- 从 Board (8090) 完整迁移
- 拖拽列：Backlog / In Progress / Done（@dnd-kit）
- Mission 卡片：标题、状态 Badge、最近活动时间、关联对话数
- 点击 Mission → 展开详情（Sheet 或全页，复用 Conversations 详情组件）

**数据源：** Board 的 MissionStore + Feishu API。合并 Board 的后端 handler 到主 web server。

**废弃 Board 独立端口 (8090)：** 迁移完成后关闭 8090 端口服务，删除 `web/board/` 启动入口。原 Board 的公开项目看板功能不再保留（Remi 为单用户系统，无公开需求）。

### 4.4 Analytics（Token 用量/成本）

**保留现有功能，shadcn/ui 视觉升级：**
- 4 张统计卡片 → shadcn Card
- Donut 图（Model Distribution, Token Breakdown）→ 保留自定义 SVG，更新 CSS 变量色
- 14 天 Bar Chart → 保留自定义 SVG
- Recent Requests 表 → shadcn Table
- Quota 进度条 → shadcn Progress

**修复：**
- Cache hit rate 计算溢出问题
- 内联 `style={{}}` 全部迁移到 Tailwind

### 4.5 Traces（请求追踪）

**保留现有功能，shadcn/ui 视觉升级：**
- 4 张统计卡片 → shadcn Card
- Trace 列表 → shadcn Table + Badge
- WaterfallChart → 保留自定义 SVG，更新色值

**修复：**
- P95 计算 bug（当前用 `Math.max`，应为真正的 95th percentile）
- 内联样式迁移到 Tailwind

### 4.6 Logs（结构化日志）

**保留现有功能，shadcn/ui 视觉升级：**
- 筛选控件 → shadcn Input / Select
- 日志表 → shadcn Table
- Level 色彩编码保留

**修复：**
- 内联 `<style>` 块迁移到 Tailwind

### 4.7 Scheduler（定时任务）

**保留现有功能，shadcn/ui 视觉升级：**
- 4 张统计卡片 → shadcn Card
- Job 表 + History 表 → shadcn Table
- 7 Day Trend → 保留自定义 SVG

### 4.8 Memory（实体 + MEMORY.md + 日志）

**Tab 结构：** Entities / MEMORY.md / Daily Logs

**Entities Tab：**
- 搜索 + 类型筛选（shadcn Input + Badge 筛选器）
- 实体卡片列表（shadcn Card）
- 点击实体 → shadcn Sheet 侧滑面板显示详情（替代独立 MemoryEntity 页面）
- Sheet 内容：元数据网格 + 完整内容 + 删除按钮

**MEMORY.md Tab：**
- 保留文本编辑器（后续可升级为 Markdown 预览）
- 保存按钮

**Daily Logs Tab：**
- 日期选择器（shadcn 按钮组，替代所有日期一次性显示）
- 选中日期内联显示日志内容（替代独立 MemoryDaily 页面）

### 4.9 Wiki（知识库浏览器）— 新增

**目标：** 统一浏览所有定义 Remi 行为的文档，带 git 版本历史。

**左侧文件树：**
```
Wiki
├─ README.md
├─ remi/
│   ├─ overview.md
│   └─ details.md
├─ architecture/
│   ├─ overview.md
│   └─ details.md
└─ memory-v3-design/
    ├─ overview.md
    └─ details.md

Soul & Agents
├─ soul.md
├─ agents/memory-audit/CLAUDE.md
├─ agents/memory-extract/CLAUDE.md
├─ agents/memory-rerank/CLAUDE.md
└─ agents/wiki-curate/CLAUDE.md

Project Config
├─ CLAUDE.md (project root)
└─ docs/memory-system-v2-design.md
```

**右侧内容区：**
- Markdown 渲染（只读）
- 元数据栏：最后修改时间、git commit hash、修改者

**版本历史面板（底部或侧边）：**
- 文件的 git log（时间、commit message、author）
- 点击 commit → 显示 diff（行级 diff 高亮）
- 支持两个 repo 的历史：
  - 主 repo (`project/remi/`) 中的文件
  - `~/.remi/` repo 中的文件

**后端 API 需新增：**
- `GET /api/v1/wiki/tree` — 文件树结构
- `GET /api/v1/wiki/file?path=xxx` — 文件内容
- `GET /api/v1/wiki/history?path=xxx` — git log for file
- `GET /api/v1/wiki/diff?path=xxx&commit=xxx` — 单次 commit diff

**数据源：**
- Wiki 文件：`~/.remi/projects/-data00-home-hehuajie-project-remi/wiki/`
- Soul：`~/.remi/soul.md`
- Agent CLAUDE.md：`project/remi/agents/*/.claude/CLAUDE.md`
- 项目 CLAUDE.md：`project/remi/CLAUDE.md`
- Git 历史：`git log --follow -- <path>` 和 `git diff <commit> -- <path>`

### 4.10 Sessions（会话管理）

**shadcn/ui 升级：**
- 表格 → shadcn Table
- 删除确认 → shadcn AlertDialog（替代 `window.confirm()`）
- 批量清除 → shadcn AlertDialog

### 4.11 Projects（工作区别名）

**shadcn/ui 升级：**
- 表单 → shadcn Input + Button
- 表格 → shadcn Table
- 统一语言为中文（修复中英混杂）

### 4.12 Bot Menu（飞书菜单构建器）

**shadcn/ui 升级：**
- 输入控件 → shadcn Input / Select / Button
- 树结构保持自定义（shadcn 无树组件）
- 同步状态 → shadcn Badge

---

## 5. 技术方案

### 5.1 shadcn/ui 集成

**初始化：**
- `@/` 路径别名（tsconfig.json + vite.config.ts）
- `npx shadcn@latest init -t vite`
- `cn()` 工具函数（clsx + tailwind-merge）
- 基础色调：`neutral`（匹配现有 oklch 调色板）
- 风格：`default`（非 new-york）

**组件清单：**
```
button, card, badge, avatar, table, tabs, separator,
input, select, dropdown-menu, tooltip, sheet, dialog,
alert-dialog, progress, scroll-area, toggle, switch
```

**图标：** `lucide-react`（shadcn 默认，tree-shakeable）

### 5.2 组件映射

| 现有组件 | → 替换 | 处理方式 |
|----------|--------|----------|
| ArcCard (StatCard) | shadcn Card | 重写为 Card 包装器 |
| HudPanel (Panel) | shadcn Card + CardHeader | 重写 |
| 手动 Tab | shadcn Tabs | Memory 页 |
| `window.confirm()` | shadcn AlertDialog | Sessions/Projects |
| 自定义底部弹窗 | shadcn Sheet | BottomNav More |
| 内联状态标记 | shadcn Badge | 全局替换 |
| 自定义输入框 | shadcn Input / Select | Logs/Projects |
| 自定义进度条 | shadcn Progress | Dashboard Token |

**保留不变：**
- WaterfallChart — 自定义 SVG，仅更新色值引用为 CSS 变量
- SvgDonut / SvgBarChart — 自定义 SVG，比 Recharts 轻 200KB
- Zustand stores — 纯数据层，与 UI 解耦
- Wouter 路由 — 1.3KB，够用
- Hono 后端 — 无需变动

### 5.3 Dark/Light Mode

- 当前：`<html class="dark">` 硬编码
- 改为：`useTheme` hook，读写 `localStorage`，切换 `<html>` 的 `dark` class
- 默认 dark（保持现有行为）
- Header 添加 Sun/Moon 切换按钮
- SVG 图表颜色全部改为 `var(--foreground)` 等 CSS 变量

### 5.4 CSS 变量补齐

现有 index.css 已 90% 兼容 shadcn。需补充：
- `--popover` / `--popover-foreground`
- `--chart-1` 到 `--chart-5`（图表主题色）

### 5.5 Board 整合方案

**后端：**
- 将 Board 的 `server.ts` 中的 API handler 迁移到主 web server 的 `handlers/` 目录
- 新增 `handlers/conversations.ts`：对话列表 + 详情
- 新增 `handlers/missions.ts`：Mission CRUD + 看板操作
- 复用 Board 的消息聚合逻辑（Feishu API + CLI JSONL + DB）

**前端：**
- 新增 `pages/Conversations.tsx`：对话列表 + 全页详情
- 新增 `pages/Missions.tsx`：看板视图（迁移 Board 的 KanbanBoard + MissionCard）
- 新增 `stores/conversations.ts`：对话数据
- 新增 `stores/missions.ts`：看板数据（从 Board 的 board.ts 迁移）
- @dnd-kit 依赖移到主 frontend package

**废弃：**
- Board 独立端口 (8090) 在迁移完成后关闭
- `web/board/` 目录保留但标记为 deprecated

### 5.6 Wiki 后端方案

新增 `handlers/wiki.ts`：

```
GET /api/v1/wiki/tree
  → 扫描 wiki + soul + agents 文件路径，返回树结构

GET /api/v1/wiki/file?path=<relative_path>
  → 读取文件内容，返回 { content, lastModified, gitInfo }

GET /api/v1/wiki/history?path=<relative_path>&limit=20
  → git log --follow -- <resolved_path>
  → 返回 [{ hash, message, author, date }]

GET /api/v1/wiki/diff?path=<relative_path>&commit=<hash>
  → git diff <hash>~1 <hash> -- <resolved_path>
  → 返回 diff 文本
```

路径映射：
- `wiki/*` → `~/.remi/projects/-data00-home-hehuajie-project-remi/wiki/*`
- `soul.md` → `~/.remi/soul.md`
- `agents/*` → `project/remi/agents/*/`
- `project/*` → `project/remi/*`

双 repo 支持：根据路径前缀决定在哪个 git repo 执行 `git log/diff`。

---

## 6. 信息归属完整性验证

| 原页面 | 原信息项 | 新位置 | 展示方式 |
|--------|----------|--------|----------|
| Monitor | Uptime | Dashboard System Health | 折叠面板内 |
| Monitor | Active Sessions | Dashboard 统计卡片 | 顶部卡片 |
| Monitor | Requests Today / Hour | Dashboard System Health | 折叠面板内 |
| Monitor | Error Rate | Dashboard System Health | 折叠面板内 |
| Monitor | Latency P50/P95/Avg | Dashboard System Health | 折叠面板内 |
| Monitor | Top Operations | Dashboard System Health | 折叠面板内表格 |
| Monitor | Data Volume (traces/logs) | Dashboard System Health | 折叠面板内 |
| Auth | Token 列表 + 状态 | Dashboard Token Budget 面板 | 右栏面板 |
| Auth | 过期进度条 | Dashboard Token Budget 面板 | Progress 组件 |
| Auth | 30s 自动刷新 | Dashboard | 继承 |
| Database | DB Size | Dashboard System Health | 折叠面板内 |
| Database | KV Entries 数量 | Dashboard System Health | 折叠面板内 |
| Database | Embeddings 数量 | Dashboard System Health | 折叠面板内 |
| Database | KV 详情列表 | 删除（API 仍可用） | — |
| Database | Embeddings 详情列表 | 删除（API 仍可用） | — |
| Config | remi.toml 内容 | Dashboard System Health | 最后修改时间 + 可展开 |
| Symlinks | 总数/OK/Broken | Dashboard System Health | 折叠面板内 |
| Symlinks | Fix All 按钮 | Dashboard System Health | 折叠面板内 |
| Symlinks | 详情表格 | 删除（API 仍可用） | — |
| MemoryEntity | 实体详情 | Memory 页 Sheet | 侧滑面板 |
| MemoryDaily | 日志内容 | Memory 页 Tab | 内联渲染 |

---

## 7. 移动端适配

- **Layout：** Sidebar 隐藏，Bottom Nav 显示
- **Bottom Nav：** 4 主 Tab + More Sheet（shadcn Sheet）
- **Dashboard：** 双栏 → 单列堆叠
- **Missions 看板：** 横向滚动列，或切换为列表视图
- **Conversations 详情：** 全宽聊天界面
- **Wiki：** 文件树改为顶部下拉选择器
- **Safe Area：** 保留 `env(safe-area-inset-bottom)` 适配刘海屏

---

## 8. 不在本次范围内

- MEMORY.md Markdown 预览编辑器（保持纯文本编辑）
- 实体编辑功能（当前只有查看/删除）
- 日志实时流模式（Live Tail）
- 多用户支持
- 国际化（保持中文为主，英文标签混用现状）
