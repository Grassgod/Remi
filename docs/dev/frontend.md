---
title: 前端开发上下文
status: active
summary: Remi Web 控制台的包职责、认证与工作区接线、查询和实时数据流、测试入口。
---

# 前端开发上下文

规则见[前端 AGENTS.md](../../frontend/AGENTS.md)，环境和统一命令见[仓库开发入口](../../CLAUDE.md)，其他领域从[开发索引](README.md)进入。本文记录当前源码结构，不代表已启动服务或完成性能验证。

## 当前结构

前端属于[根 Bun workspace](../../package.json)，当前应用目录只有 `frontend/apps/web/`。`@multiremi/*` 是现有包名；包导出直接指向 TypeScript 源文件，由 [Next.js 配置](../../frontend/apps/web/next.config.ts)的 `transpilePackages` 编译。

| 位置 | 职责与入口 |
| --- | --- |
| [apps/web/app/](../../frontend/apps/web/app/) | Next.js 路由和布局；页面接线到业务组件 |
| [apps/web/platform/navigation.tsx](../../frontend/apps/web/platform/navigation.tsx) | `WebNavigationProvider`：框架导航适配 |
| [packages/core/](../../frontend/packages/core/) | API、类型、Query 配置、Zustand store、认证与实时数据 |
| [packages/views/](../../frontend/packages/views/) | 按任务、工作台、收件箱、项目等领域组织的业务组件 |
| [packages/ui/](../../frontend/packages/ui/) | 基础组件、Markdown 渲染、[样式 token](../../frontend/packages/ui/styles/tokens.css)与公共样式 |
| [packages/tsconfig/](../../frontend/packages/tsconfig/)、[packages/eslint-config/](../../frontend/packages/eslint-config/) | TypeScript 与 ESLint 共享配置 |
| [根 packages/server/src/api/](../../packages/server/src/api/) | Bun + Hono API；页面依赖的接口实现在这里 |

## 页面启动与工作区

1. [根 layout](../../frontend/apps/web/app/layout.tsx)加载语言资源、主题与 `WebProviders`。
2. [WebProviders](../../frontend/apps/web/components/web-providers.tsx)注入 API/WS 地址、导航和语言适配器。当前显式使用 token 认证（`cookieAuth = false`）。
3. [CoreProvider](../../frontend/packages/core/platform/core-provider.tsx)初始化 `ApiClient`、认证和聊天 store，挂载 `QueryProvider`、`AuthInitializer`、`WSProvider`。
4. [工作区 layout](../../frontend/apps/web/app/%5BworkspaceSlug%5D/layout.tsx)从 URL slug 解析工作区，再调用 `setCurrentWorkspace(slug, id)`；它同时控制认证、加载和无访问权页面。当前不强制经过旧 onboarding 向导。
5. [workspace-storage.ts](../../frontend/packages/core/platform/workspace-storage.ts)维护 slug/id 对及持久化命名空间，通知 WS 和 store 重载。请求头由 [HttpClient](../../frontend/packages/core/api/http.ts)读取当前 slug 生成。

API 代理目标由 [resolveRemoteApiUrl](../../frontend/apps/web/config/runtime-urls.ts)解析；[next.config.ts](../../frontend/apps/web/next.config.ts)配置 `/api`、`/ws` 等代理路径。改连接配置时同时核对服务端代理目标和浏览器侧 `WebProviders`，不要只改其中一端。

## 一次任务读取与更新

```text
页面 / 组件
  → core/<领域>/queries.ts、mutations.ts
  → ApiClient → api/endpoints/<领域>.ts → HttpClient
  → 根 packages/server 的 API
  → 端点响应处理 → Query cache → 组件

WSClient → useRealtimeSync → sync/<领域>.ts
         → 更新 / 失效 Query cache → 组件
```

| 要定位的行为 | 先读的文件与符号 |
| --- | --- |
| API 方法来自哪里 | [api/client.ts](../../frontend/packages/core/api/client.ts) 的 `ENDPOINT_FACTORIES`；[endpoints/issues.ts](../../frontend/packages/core/api/endpoints/issues.ts) 的 `IssuesEndpoints` |
| 响应校验与错误降级 | [api/schema.ts](../../frontend/packages/core/api/schema.ts) 的 `parseWithFallback`、`parseStrictResponse`；[schemas/issues.ts](../../frontend/packages/core/api/schemas/issues.ts) |
| 任务列表、分页、详情缓存 | [issues/queries.ts](../../frontend/packages/core/issues/queries.ts) 的 `issueKeys`、`issueListOptions`、`findCachedIssue`；[issues/mutations.ts](../../frontend/packages/core/issues/mutations.ts) 的 `useLoadMoreByStatus` |
| 任务列表 UI | [issues-page.tsx](../../frontend/packages/views/issues/components/issues-page.tsx) 的 `IssuesPage`，以及同目录 `board-view.tsx`、`list-view.tsx`、`swimlane-view.tsx` |
| 任务详情与执行会话 | [issue-detail.tsx](../../frontend/packages/views/issues/components/issue-detail.tsx)、[issue-detail-main.tsx](../../frontend/packages/views/issues/components/issue-detail-main.tsx)、[session-mutations.ts](../../frontend/packages/core/issues/session-mutations.ts) |
| 工作台待输入 / 待验收 / 失败恢复 | [issues/workbench.ts](../../frontend/packages/core/issues/workbench.ts) 的 `workbenchIssuesOptions`、`partitionReviewIssues`；[workbench-page.tsx](../../frontend/packages/views/workbench/components/workbench-page.tsx) |
| 收件箱的分页、摘要与展示分组 | [inbox/queries.ts](../../frontend/packages/core/inbox/queries.ts) 的 `inboxPageOptions` / `inboxSummaryOptions`、[inbox/grouping.ts](../../frontend/packages/core/inbox/grouping.ts)、[inbox-page.tsx](../../frontend/packages/views/inbox/components/inbox-page.tsx) |
| Issue 飞书话题设置 | [issue-topic-section.tsx](../../frontend/packages/views/settings/components/issue-topic-section.tsx)、[feishu-bot/queries.ts](../../frontend/packages/core/feishu-bot/queries.ts)、[workspaces router](../../packages/server/src/api/routers/workspaces.ts) 的 `/api/workspaces/:id/issue-topics` |
| 执行消息与 transcript | [chat/queries.ts](../../frontend/packages/core/chat/queries.ts)、[build-timeline.ts](../../frontend/packages/views/common/task-transcript/build-timeline.ts)、[agent-transcript-dialog.tsx](../../frontend/packages/views/common/task-transcript/agent-transcript-dialog.tsx) |

响应解析由各端点负责，目前并非所有历史方法都已调用 schema helper；新增或修改消费逻辑遵循前端规则。[createQueryClient](../../frontend/packages/core/query-client.ts)默认使用 `staleTime: Infinity`，列表是否更新依赖 mutation、WS 和重连处理，排查陈旧数据时应先核对这些路径。

任务列表包含按状态分页的缓存结构；详情只需要已有列表中的某个对象时，使用 `findCachedIssue`，避免为查缓存额外挂载完整列表查询。工作台复用查询缓存区分待人工输入与待验收，不能只根据单个任务的完成状态自行推导整个 issue 的展示。

收件箱页面使用 `useInfiniteQuery` 按游标每次读取 50 条；侧栏关注数与页内未读数来自独立的 `/api/inbox/summary`，摘要查询 `staleTime` 为 30 秒，不需要加载完整列表。筛选、日期分组及成功自动运行的折叠应用于已加载页；链接指向尚未加载的通知时，页面继续加载后续页，读取失败不能当作通知不存在。读/归档 mutation 和 WS 更新同时维护旧列表缓存与分页缓存，并刷新摘要；具体分组和计数契约见[收件箱边界](../inbox-workbench-boundary.md)。

集成设置中的 Issue 话题表单维护工作区 `settings.issueTopics`，与 concierge bot 配置分开：成员可读，owner/admin 可保存启用状态、目标群和项目范围。API 的 `project_ids: null` 表示不限制项目；UI 开启项目限制时要求至少选择一项，服务端仍校验项目归属。保存后失效当前工作区的 `feishu-bot` 查询树；端点经过 schema 解析。验证入口为[表单测试](../../frontend/packages/views/settings/components/issue-topic-section.test.tsx)和[端点测试](../../frontend/packages/core/api/endpoints/feishu-bot.test.ts)。

## 实时更新与性能定位

Runtime 详情的 Codex / Claude Code 连接页通过 [provider-profile.ts](../../frontend/packages/core/runtimes/provider-profile.ts) 与[共享表单](../../frontend/packages/views/runtimes/components/runtime-provider-profile-tab.tsx)读取和保存单个 Runtime 的 provider 配置；查询键包含 workspace/runtime ID，响应严格校验。表单支持 API Key（保存后清空，留空保留）和本机环境变量；Claude 还支持 Bearer / x-api-key 请求鉴权；未声明对应 `codex_profiles: 1` 或 `claude_profiles: 1` 的旧 daemon 只能查看更新提示。保存后失效 Runtime 和模型目录缓存；鉴权与隔离契约见 [Codex Runtime](../design/acp-codex-via-codex-acp.md#runtime-自定义连接)和 [Claude Code Runtime](../design/acp-claude-via-claude-agent-acp.md)。

- [useRealtimeSync](../../frontend/packages/core/realtime/use-realtime-sync.ts)负责订阅生命周期和断线重连后的缓存恢复；领域处理器集中在 [realtime/sync/](../../frontend/packages/core/realtime/sync/)。
- [issues/ws-updaters.ts](../../frontend/packages/core/issues/ws-updaters.ts)补写可确定的任务列表和详情，对派生列表做失效处理。改任务响应字段时同时检查这里和 mutation 的缓存处理。
- [prefix-refresh.ts](../../frontend/packages/core/realtime/sync/prefix-refresh.ts)按事件前缀合并刷新；`SPECIFIC_EVENTS` 排除已有精确处理器的事件，避免重复失效。
- [tasks.ts](../../frontend/packages/core/realtime/sync/tasks.ts)将 `task:message` 按任务缓冲，约每 80ms 批写已加载缓存，退出订阅时刷新尾部；流式消息不走通用前缀失效。
- 排查慢页面先区分网络请求扇出、API 延迟、缓存失效范围和 React 渲染成本；保留测量场景与前后结果。以上文件提供定位入口，不把静态代码形态直接当成已证实的性能瓶颈。

## 验证入口

统一命令维护在[根开发入口](../../CLAUDE.md)和[根 package.json](../../package.json)；针对某个文件运行时，使用所属包的 `test` 脚本传入测试路径，确保加载正确的 Vitest 配置。

| 范围 | 当前配置与用途 |
| --- | --- |
| core | [package.json](../../frontend/packages/core/package.json)、[vitest.config.ts](../../frontend/packages/core/vitest.config.ts)：Vitest 默认 Node；需要 DOM 的测试可按文件声明环境 |
| views | [package.json](../../frontend/packages/views/package.json)、[vitest.config.ts](../../frontend/packages/views/vitest.config.ts)：Vitest + jsdom、Testing Library，共享业务组件测试 |
| web | [package.json](../../frontend/apps/web/package.json)、[vitest.config.ts](../../frontend/apps/web/vitest.config.ts)：Vitest + jsdom，验证 Next.js 平台接线 |
| 类型检查 | 各包 `typecheck` 脚本；`ui` 也有独立类型检查，但没有独立 `test` 脚本 |
| 浏览器端到端 | [tests/integration/e2e-frontend-ours.ts](../../tests/integration/e2e-frontend-ours.ts)：仓库实际 E2E 入口，运行条件以该脚本为准 |

文案使用 [views/i18n/](../../frontend/packages/views/i18n/) 的 `useT`；语言资源在 [locales/](../../frontend/packages/views/locales/)，键一致性检查在 [parity.test.ts](../../frontend/packages/views/locales/parity.test.ts)，术语维护见 [glossary.md](../../frontend/packages/views/locales/glossary.md)。
