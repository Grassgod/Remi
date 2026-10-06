---
title: 前端开发上下文
status: active
summary: Remi Web 控制台的包职责、认证与工作区接线、查询和实时数据流、测试入口。
---

# 前端开发上下文

规则见[前端 AGENTS.md](../../frontend/AGENTS.md)，环境和统一命令见[仓库开发入口](../../CLAUDE.md)，其他领域从[开发索引](README.md)进入。本文记录当前源码结构，不代表已启动服务或完成性能验证。

## 当前结构

前端属于[根 Bun workspace](../../package.json)，当前应用目录只有 `frontend/apps/web/`。`@multiremi/*` 是现有包名；包导出直接指向 TypeScript 源文件，由 [Next.js 配置](../../frontend/apps/web/next.config.ts)的 `transpilePackages` 编译。

前端从 `@multiremi/contracts` 根入口只能 `import type`；运行时的值走[子路径导出](../../packages/contracts/package.json)（如 `@multiremi/contracts/issue-activity`）。根入口是 `export * from "./x.js"` 的汇总，webpack 无法解析这些 `.js`，值导入会让 `next build` 失败，而单测和 `tsc` 都发现不了。[架构测试](../../tests/arch/frontend-contracts-root-imports.test.ts)会拦截这类导入。

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

Issue 详情页由 [server-log.ts](../../frontend/apps/web/features/issues/server-log.ts)在 800ms 预算内用 httpOnly cookie 读取详情、会话、最后 30 条日志、seq 0 和任务列表，注入同一棵 React 查询缓存；失败时只输出外壳，由 Bearer 客户端补齐。`?comment=<id>` 先经 `/log/locate` 找到所属会话与 seq，再取前后各 15 条的锚点窗口。任务列表同时供底部运行条和上方 `AgentLiveCard` 的首帧使用；SSR 不可用时，揭示只等待 Issue、会话和日志窗口；运行卡片用缓存与预留槽位首绘，active-task reconcile、订阅者和本地目录资源在揭示后读取，底部运行条在揭示后挂载并作为运行场景实际终点。尺寸已固定的图片不阻塞揭示；日志无尺寸图片由 SSR 和客户端统一预留 240px 固定框，晚到与失败都不改变行高，详见 ADR 0008。浏览器仍使用 Bearer 请求，不开启 cookieAuth；[IssueLogReplica](../../frontend/packages/core/session-log/issue-log.ts)把 SSR 窗口导入本地副本后继续订阅日志流，深链窗口两端按需分页，回到最新时换回尾部窗口。`body_html` 只消费服务端预渲染结果，缺失时由原客户端 Markdown 路径降级。

评论与会话日志的 [EntryHtml](../../frontend/packages/views/common/session-log/entry-html.tsx) 会把服务端 `div[data-type="fileCard"]` 增强成统一附件卡片。静态 [entry-html.css](../../frontend/packages/views/common/session-log/entry-html.css) 在首屏给每个槽位预留固定 40px（32px 卡片加上下各 4px 间距），普通和紧凑密度共用；图片与 HTML 文件也保持卡片外观，预览在弹窗中打开。附件记录通过 `attachments` 传入 provider，预览与下载按附件 ID 走现有链路；没有记录时使用 URL 模式，不合法 href 只显示文件名。

客户端 [file-cards.ts](../../frontend/packages/ui/markdown/file-cards.ts) 与服务端 [preprocess.ts](../../packages/server/src/render/preprocess.ts) 同步接受 `/api/attachments/<id>/content`，ID 限 `[A-Za-z0-9_-]`，可选查询串不得含 `)`、空白或 `..`。API href 必须整串精确匹配。Chat 直接交给共享 Markdown 渲染，两处附件列表显式使用 `dedupe="url"`：正文内联 URL 不再追加独立卡片，不同 URL 即使同名、同类型、同大小也各自保留并按各自附件 ID 下载。评论使用默认 `dedupe="file"`，保留按文件名、类型、大小隐藏重复上传的现有行为。MUL-518 保持 `RENDER_PIPELINE_REVISION = 1`；已有正文重渲染所需的版本提升由 MUL-513 负责，在其游标与节流回填就绪后处理。

日志中的 HTML 附件预览由 `DeferredContentContext` 延迟到实际揭示后读取，揭示前只显示固定槽位（默认 240px，已有 QueryClient 高度缓存时复用）。成功、错误与重挂载保持槽位高度；日志外的预览保留原高度和错误展示。正文、工具栏、弹窗和独立预览页共用带 workspace slug 与附件 ID 的内容 query key，保留 5 分钟 staleTime、30 分钟 gcTime、无自动重试及既有失效策略。SSR 播种的日志需等定位脚本确认 DOM 已揭示才启动这些可选读取。运行任务卡片使用 128px 可滚动槽位，避免缓存缺任务时后续卡片增高移动日志锚点。

搜索面板关闭时不读取成员或当前 Issue；打开后复用缓存，缺数据才读取。浮动 Chat 的当前上下文和成员查询同时等待主页面首屏就绪，避免新浏览器默认打开 Chat 时在详情页 SSR 缓存边界之外抢先发出补读；独立 Chat 页面仍立即读取。详情、父 Issue、成员、会话、子 Issue 和任务列表沿用既有缓存失效与实时更新策略，无 SSR seed 时仍由客户端获取主页面数据。

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
| 平铺会话日志（切片、行高缓存、副本端口） | [session-log-list.tsx](../../frontend/packages/views/common/session-log/session-log-list.tsx)、[entry-html.tsx](../../frontend/packages/views/common/session-log/entry-html.tsx)、[use-row-heights.ts](../../frontend/packages/views/common/session-log/use-row-heights.ts)、[core/replica/port.ts](../../frontend/packages/core/replica/port.ts) |
| 执行过程弹窗 | [task-trace-dialog.tsx](../../frontend/packages/views/common/task-transcript/task-trace-dialog.tsx)、[build-timeline.ts](../../frontend/packages/views/common/task-transcript/build-timeline.ts)、[agent-transcript-dialog.tsx](../../frontend/packages/views/common/task-transcript/agent-transcript-dialog.tsx)；点击后从 task trace API 分页读取，运行中由 trace socket 续传 |

响应解析由各端点负责，目前并非所有历史方法都已调用 schema helper；新增或修改消费逻辑遵循前端规则。[createQueryClient](../../frontend/packages/core/query-client.ts)默认使用 `staleTime: Infinity`，列表是否更新依赖 mutation、WS 和重连处理，排查陈旧数据时应先核对这些路径。

执行时间线的旧消息与 trace 读取路径共用“过滤 usage/execution → 合并文字分片 → 脱敏”处理；合并同时保留父调用、回答阶段和记录连续性的边界。[共享 trace 语义](../../packages/shared/src/trace-semantics.ts)供页面、Daemon 和飞书使用，工具按调用 ID 配对并去重计数，取消也是终态。上下文标签独立读取 seq 最新的有效 usage（兼容旧 JSON content），与任务累计 input/output 用量分开显示。

执行过程弹窗打开时读取一页，后续历史由用户继续加载；历史游标独立于 WS 尾部记录，实时帧不能跨过尚未加载的历史。浏览器的历史与实时窗口同时限制记录数和序列化字节数，具体上限集中在 [trace-window.ts](../../frontend/packages/core/api/trace-window.ts)。窗口回收只移除浏览器缓存，可回到历史开头重新分页读取。页面计数明确标示已加载范围，只有序号连续且完整时才从记录提取最终回复；不把某一页文字当作完整回答。切换任务重新创建窗口状态，旧请求不能写入新任务；订阅错误提供重试，`stream.closed` 在最终批次之后结束实时状态。

Issue 运行条读取已有任务状态、耗时和 `progress_summary`，详细 trace 在点击后读取；不为显示运行条自动下载历史记录，也不把有限窗口的工具计数标成全任务总数。已结束的 Chat 直接展示会话日志保存的最终答复、附件和失败信息，通过“执行过程”按钮查看 trace；复制正文不依赖 trace 是否在线。Chat 正在展示的执行时间线是单独的实时消费者，使用有限尾部窗口。验证入口为 [build-timeline.test.ts](../../frontend/packages/views/common/task-transcript/build-timeline.test.ts)、[task-trace-dialog.test.tsx](../../frontend/packages/views/common/task-transcript/task-trace-dialog.test.tsx)、[chat-message-list.test.tsx](../../frontend/packages/views/chat/components/chat-message-list.test.tsx) 和 [chat-timeline.test.ts](../../frontend/packages/views/chat/lib/chat-timeline.test.ts)。

任务列表包含按状态分页的缓存结构；详情只需要已有列表中的某个对象时，使用 `findCachedIssue`，避免为查缓存额外挂载完整列表查询。列表、看板、我的单的「显示子单」偏好由各自的 view store 持久化，默认关闭；查询键与请求都包含服务端 `top_level_only` 过滤值，不能在客户端裁掉子单。父单进度从服务端 child-progress buckets 显示。工作台复用查询缓存区分待人工输入与待验收，不能只根据单个任务的完成状态自行推导整个 issue 的展示。

Issue 顶部提示只使用详情响应的 `pending_decision_count` 和 `blocked_by`，没有提示时不挂载提示槽。横条渲染不依赖 decisions / dependencies 的响应。侧栏未完成前置单计数和横条共用 `blocked_by`，保留固定高度槽位；兼容详情仅在 backlog 查询未完成前置单，其他状态返回空数组。非子单首屏没有 dependencies 请求；子单允许编辑器发一次，读取包括已完成项的完整依赖列表。负责人自己拍板和已回答记录不触发横条；依赖编辑和强制开始失效详情缓存，WS 的部分更新保留详情独有字段。

Issue 的 seq 0 是标题与描述的例外：[IssueLogHead](../../frontend/packages/views/issues/components/issue-log-head.tsx) 用详情标题渲染只读标题，按同一 head 行的 `metadata.title` 精确移除一次 Markdown 前缀，避免改标题时混用版本。描述交给 `ReadonlyContent`，复用已有附件查询缓存并启用普通代码块复制；冷缓存只在下载点击时加载附件列表，按 URL 找到 ID 后调用已有下载入口刷新签名，首屏不请求附件列表。编辑和保存都只包含描述，不消费带标题的 `body_html`。服务端与 agent 的日志契约不变。

收件箱页面使用 `useInfiniteQuery` 按游标每次读取 50 条；侧栏关注数与页内未读数来自独立的 `/api/inbox/summary`，摘要查询 `staleTime` 为 30 秒，不需要加载完整列表。筛选、日期分组、成功自动运行及同父单通知的折叠应用于已加载页；父单元数据由服务端投影提供，但只投影通知所属工作区内仍存在的父单，组内失败、卡住、待决定通知优先。父单分组头不提供整组归档，展开后逐条归档；行内操作始终保留固定宽度，悬停只改变可见性。链接指向尚未加载的通知时，页面继续加载后续页，读取失败不能当作通知不存在。读/归档 mutation 和 WS 更新同时维护旧列表缓存与分页缓存，并刷新摘要；具体分组和计数契约见[收件箱边界](../inbox-workbench-boundary.md)。

集成设置中的 Issue 话题表单维护工作区 `settings.issueTopics`，与 concierge bot 配置分开：成员可读，owner/admin 可保存启用状态、目标群和项目范围。API 的 `project_ids: null` 表示不限制项目；UI 开启项目限制时要求至少选择一项，服务端仍校验项目归属。保存后失效当前工作区的 `feishu-bot` 查询树；端点经过 schema 解析。验证入口为[表单测试](../../frontend/packages/views/settings/components/issue-topic-section.test.tsx)和[端点测试](../../frontend/packages/core/api/endpoints/feishu-bot.test.ts)。

Issue 活动区默认显示普通评论、固定单行的派活、字段动态和 `workspace_move_cleared` 日志。派活和被派 agent 的首条回应引用在点击后打开既有任务弹窗，初始停在「输入 Prompt」，评论流内不展开正文。回应关联只用当前窗口中唯一的同 task 派活记录，首次出现时确定，翻页不向已显示的评论追加引用；任务列表只在点击时复用缓存或读取。系统细节开关按用户和工作区在本地同步持久化，渲染前过滤结果发布、信封、收件箱唤醒及未知非评论类型。SSR 列表在本地偏好 hydration 完成前保持隐藏，定位脚本通过 `data-ssr-display-ready` 门禁等待最终显示集合，避免默认集合先显现再变化；用户切换开关时在绘制前保持 released 阅读锚点或 pinned 贴底。打开后 [IssueLogEventRow](../../frontend/packages/views/issues/components/issue-log-event-row.tsx) 显示固定一行人话，发布结果使用已有结果列表并打开右侧结果面板。信封按 `dedupeKey` 来源优先、`kind/to.role` 次之分类，永不使用正文兜底。Chat 永久过滤内部条目，无系统细节开关；普通评论交互和用户/assistant 气泡沿用原路径。

默认 Issue 会话的展示窗口增加 `with_activity=1`，同一个响应附带 `activities`、`activities_truncated` 和 `prev_entry_created_at`；侧会话和 Chat 无活动字段。活动仍来自活动表，不占 seq、不进入 C7。范围按「上一条日志时间（含）到本窗口末条时间（不含）」切分，尾窗上界开放；每窗保留最近 200 条。SSR 与客户端走同一窗口读法，无独立首屏活动请求；旧响应缺活动字段时保持兼容。[ADR 0015](../adr/0015-issue-activity-outside-the-conversation-log.md)记录 2a 契约及另一个 PR 实施的 2b 分层分页计划。

[活动展示纯函数](../../frontend/packages/views/issues/utils/issue-activity-presentation.ts)先过滤系统层，再按时间放置字段动态与派活；三条及以上连续事件合组，评论和可见系统行打断。默认只首次展开最新组，展开和最近八条的选择不会因新评论改变。动态挂在前一日志行的 trailer，成员/内容/展开签名进入行高缓存键，沿用现有揭示和贴底门禁。窗口翻页按 ID 合并活动，回尾部替换；实时 `activity:created` 仅在默认会话的尾窗追加，不计入新消息 chip。指派给 agent 的 `issue_assigned` 若能按被派 agent、十秒窗口和操作人匹配已加载 turn，就只保留派活；system 作者仅比较 agent 与时间。字段更新逐字段拆行，新 `previous` 提供旧值，历史仅显示新值；评论审计与 `workspace_move_cleared` 活动不重复，mention/replay 通知保留系统层规则。验证入口为 [活动窗口性质测试](../../tests/unit/multiremi/issue-activity-window.test.ts)、[放置与分组测试](../../frontend/packages/views/issues/utils/issue-activity-presentation.test.ts)及下面的窗口、Issue 和 SSR 回归。

派活和回应引用提供原始 turn 给任务弹窗：输入 Prompt 请求只有返回 404（未记录执行输入）时才显示该 turn 的派活说明，优先使用 `body_html`，缺失时渲染完整 `body_md`，两条路径都使用紧凑正文样式限制标题大小。提示依据 turn 的 `metadata.status`：`queued`、`dispatched` 和等待目录锁的 `waiting_local_directory` 显示「任务尚未开始执行」，其他或未知状态显示「未记录执行输入」；四语言同步。200 仍展示完整审计输入，网络或服务端错误仍保留错误态；没有 turn 的执行过程等入口沿用原空态。验证入口为 [派活弹窗测试](../../frontend/packages/views/issues/components/issue-task-prompt-dialog.test.tsx)、[执行弹窗测试](../../frontend/packages/views/common/task-transcript/task-trace-dialog.test.tsx)和 [输入 Prompt 测试](../../frontend/packages/views/common/task-transcript/agent-transcript-dialog.test.tsx)。

固定摘要通过 `transformEntries` 使用新的行高缓存 `render_version`，不重用旧全文或展开态测量，也不更改副本日志。开关切换由用户触发，弹窗不增加评论流高度，姓名和标题更新只替换单行文字。回归入口为 [摘要测试](../../frontend/packages/views/common/session-log/event-summary.test.ts)、[Issue 日志行测试](../../frontend/packages/views/issues/components/issue-log-event-row.test.tsx)、[偏好测试](../../frontend/packages/core/issues/stores/activity-preferences-store.test.ts)、现有 Chat、任务弹窗及滚动 hook/list 测试；这些测试不代替真实浏览器首屏性能验收。前端隐藏日志仍占服务端分页条数；显示层分页属于后续 2b 改动。

深链目标属于系统细节时，本次访问临时开启显示且不写偏好，开关显示为开启；目标未加载时揭示门禁继续等待，用户手动切换后以其选择为准并持久化，离开该深链访问后恢复保存值。SSR 与客户端在渲染前使用同一目标分类，首个可见帧即可定位和高亮；验证入口为 [Issue 深链回归](../../frontend/packages/views/issues/components/issue-detail.test.tsx)和 [SSR 定位脚本回归](../../frontend/apps/web/app/issue-log-ssr-position.test.ts)。

`/log/locate` 返回 404 时，已删除或不存在的评论深链回退到该会话尾部；未指定会话时，所有会话均返回 404 才回退到默认会话。回退窗口与缺失目标状态一起就绪，渲染前取消锚点、高亮和临时系统细节，首个可见帧沿用普通浏览的贴底状态。SSR 用 `missingCommentId` 标记尾部 seed；旧 SSR seed 的目标不在窗口时，客户端重新定位后按同一规则回退。网络错误、5xx 和尾部读取失败仍保留错误态与重试。验证入口为 [日志窗口回归](../../frontend/packages/core/session-log/issue-log.test.ts)、上述 Issue 深链回归与 [SSR 读取回归](../../frontend/apps/web/features/issues/server-log.test.ts)。

## 实时更新与性能定位

Dashboard、Runtime 用量详情和列表费用共同读取[统一用量 report](../usage-accounting.md)，接线在 [usage/queries.ts](../../frontend/packages/core/usage/queries.ts)、[严格响应 schema](../../frontend/packages/core/api/schemas/usage-accounting.ts) 和 [UsagePanel](../../frontend/packages/views/usage/usage-panel.tsx)。query key 包含 workspace、范围、项目、Runtime 和查看时区；工作区切换重置筛选与价格草稿。未知消费/费用显示 `—`，上下文只显示独立 peak；已知金额按货币分开，保留 token 覆盖率和未知任务数。模型表保留历史模型和请求/实际模型出处，重复来源提示与相同 requested/actual 行不重复显示，完整字段仍供 CSV 导出。日/周 token 与金额趋势按单位时间证据归属；没有逐请求时间的历史聚合明确提示任务归属日。任务与耗时趋势读取 `task_daily` 生命周期轴；各模型或日期任务数不可加总。CSV 保留未知空值、各币种金额、时间出处和身份归属争议指标。价格管理读取服务端历史版本，失败保留草稿，保存成功失效当前 workspace 全部用量视图；task 事件也会失效，前台另以 60 秒周期刷新。Runtime 列表所有行共享一份 7 日报告，不为每行扫描旧 JSON，不在前端计价。

Runtime 详情的 Codex / Claude Code 连接页通过 [provider-profile.ts](../../frontend/packages/core/runtimes/provider-profile.ts) 与[共享表单](../../frontend/packages/views/runtimes/components/runtime-provider-profile-tab.tsx)读取和保存单个 Runtime 的 provider 配置；查询键包含 workspace/runtime ID，响应严格校验。表单支持 API Key（保存后清空，留空保留）和本机环境变量；Claude 还支持 Bearer / x-api-key 请求鉴权；未声明对应 `codex_profiles: 1` 或 `claude_profiles: 1` 的旧 daemon 只能查看更新提示。保存后失效 Runtime 和模型目录缓存；鉴权与隔离契约见 [Codex Runtime](../design/acp-codex-via-codex-acp.md#runtime-自定义连接)和 [Claude Code Runtime](../design/acp-claude-via-claude-agent-acp.md)。

- [useRealtimeSync](../../frontend/packages/core/realtime/use-realtime-sync.ts)负责订阅生命周期和断线重连后的缓存恢复；领域处理器集中在 [realtime/sync/](../../frontend/packages/core/realtime/sync/)。
- [issues/ws-updaters.ts](../../frontend/packages/core/issues/ws-updaters.ts)补写可确定的任务列表和详情，对派生列表做失效处理。改任务响应字段时同时检查这里和 mutation 的缓存处理。
- [prefix-refresh.ts](../../frontend/packages/core/realtime/sync/prefix-refresh.ts)按事件前缀合并刷新；`SPECIFIC_EVENTS` 排除已有精确处理器的事件，避免重复失效。
- 浮动 Chat 在 [FloatingPanelLayout](../../frontend/packages/views/layout/floating-panel-layout.tsx) 中预留展开的 Issue 属性栏宽度；右栏缩放和折叠通过 ResizeObserver 更新布局，普通与展开的浮窗均限制在剩余文档区域，不提高属性按钮层级。
- Chat/Issue 正文由 [SessionReplica](../../frontend/packages/core/replica/browser.ts) 的 `log:` 流驱动；打开的执行过程窗口和 Chat 可见的运行时间线按需订阅 `trace:`。关闭窗口只移除该消费者，最后一个消费者离开才关闭 trace socket；结束任务只读分页结果。
- 排查慢页面先区分网络请求扇出、API 延迟、缓存失效范围和 React 渲染成本；保留测量场景与前后结果。以上文件提供定位入口，不把静态代码形态直接当成已证实的性能瓶颈。

## 验证入口

浏览器本地副本在 [replica/browser.ts](../../frontend/packages/core/replica/browser.ts)。Web Lock、BroadcastChannel、OPFS SAH pool 名和目录都使用同一个 `(user_id, workspace_id)` 分区键；频道消息再核对该键。leader 持有 Worker 和 socket，follower 通过频道查询；没有 OPFS 或 Web Locks 时，每页的 Memory 副本复用同一个 leader 请求队列和同步语义。

页面句柄显式 open/close，每个 tab 对同一 session 只声明一次兴趣；leader 按 tab 去重，最后一个 close 才退订。新 leader 宣告接管后，各存活页面重新声明，cursor 来自数据库的连续 head。dispose 终止 Worker 并结束 Web Lock 回调，使下一页可以接管。

副本 schema v3 包含 `revision_watermarks`，Memory 也保存同样的 `(session_id, seq) → revision` 水位。删除或隐藏只移除展示行，不移除水位；流帧和 HTTP 窗口都拒绝不高于水位的 revision，交接重开后仍有效。水位随删除行数增长，不按 coverage 回收；session/log_version 重置、身份切换和整库清除同时删除水位。旧版缓存无法还原已丢失的删除 revision，因此按既有 schema_upgrade 路径清库并重新同步。

Worker 请求带 session 生命周期令牌和清库代次，窗口查询带唯一请求 ID。close、dispose、clear 使旧请求失效；清库从任意页转给 leader，删除全部表内容及旧 meta，并广播 cleared。仍挂载页面的引用计数保持连续，清后新数据可以重建副本；logout 的授权和 socket 退出由调用方处理。ack 的新鲜度传到所有页面，版本改变从重置后的 cursor 同步；逐洞补读等 Worker 写入确认后再响应。原夹具及 [QA 回归](../../tests/integration/replica-fixture/qa-run.ts)使用 C0 mock socket 和真实浏览器资源；离线场景在服务端订阅数为零之后追加数据。

统一命令维护在[根开发入口](../../CLAUDE.md)和[根 package.json](../../package.json)；针对某个文件运行时，使用所属包的 `test` 脚本传入测试路径，确保加载正确的 Vitest 配置。

| 范围 | 当前配置与用途 |
| --- | --- |
| core | [package.json](../../frontend/packages/core/package.json)、[vitest.config.ts](../../frontend/packages/core/vitest.config.ts)：Vitest 默认 Node；需要 DOM 的测试可按文件声明环境 |
| views | [package.json](../../frontend/packages/views/package.json)、[vitest.config.ts](../../frontend/packages/views/vitest.config.ts)：Vitest + jsdom、Testing Library，共享业务组件测试 |
| web | [package.json](../../frontend/apps/web/package.json)、[vitest.config.ts](../../frontend/apps/web/vitest.config.ts)：Vitest + jsdom，验证 Next.js 平台接线 |
| 类型检查 | 各包 `typecheck` 脚本；`ui` 也有独立类型检查，但没有独立 `test` 脚本 |
| 浏览器端到端 | [tests/integration/e2e-frontend-ours.ts](../../tests/integration/e2e-frontend-ours.ts)：仓库实际 E2E 入口，运行条件以该脚本为准 |

文案使用 [views/i18n/](../../frontend/packages/views/i18n/) 的 `useT`；语言资源在 [locales/](../../frontend/packages/views/locales/)，键一致性检查在 [parity.test.ts](../../frontend/packages/views/locales/parity.test.ts)，术语维护见 [glossary.md](../../frontend/packages/views/locales/glossary.md)。

Issue 的结果列表、代码工作区、用量、标签、归档和代码变更查询延后到当前详情揭示。结果发布行仍使用已有固定单行与 metadata 标题，缓存数据继续可读；查询晚到只更新该行文字。收件箱在同一路径切换选中 Issue 时，详情访问门单独重置，不能复用入口页已经开启的首屏门。DOM 布局、揭示预算及滚动锚定路径不变。

CSR 详情在 sessions 解出 activeId 后即启动 useIssueLog 的 tail/head 读取，不等待成员或 children 的既有渲染门；活动区复用同一个副本，不重新读取窗口。task-runs 与窗口独立并行，并与侧栏共用原查询键和策略。描述 reactions 用详情缓存里的完整 reactions 播种原 reactions 查询，保留 WS/重连失效与 mutation 行为，避免首屏再次读取同一 Issue。
