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

Issue 详情页由 [server-log.ts](../../frontend/apps/web/features/issues/server-log.ts)在 800ms 预算内用 httpOnly cookie 读取详情、会话、最后 30 条日志、seq 0 和 `/api/turns?issue=...` 轮列表，注入同一棵 React 查询缓存；失败时只输出外壳，由 Bearer 客户端补齐。`?comment=<id>` 先经 `/log/locate` 找到所属会话与 seq，再取前后各 15 条的锚点窗口。任务列表同时供底部运行条和上方 `AgentLiveCard` 的首帧使用；SSR 不可用时，列表等运行卡片首次查询结束再显现，避免卡片插入造成位移。浏览器仍使用 Bearer 请求，不开启 cookieAuth；[IssueLogReplica](../../frontend/packages/core/session-log/issue-log.ts)把 SSR 窗口导入本地副本后继续订阅日志流，深链窗口两端按需分页，回到最新时换回尾部窗口。`body_html` 只消费服务端预渲染结果，缺失时由原客户端 Markdown 路径降级。

## 统一消息与轮展示

对话消息头使用 [MessageHeader](../../frontend/packages/views/common/message-header.tsx) 显示收件人/角色、message_kind 与实际 wake_applied，wake_reason 用作提示；未知显示枚举保留原字符串。Issue 与 Chat 优先识别 canonical 消息头，保留的 metadata.envelope 不会把正常消息变成系统详情。Chat 乐观发送以 canonical dedupe_key 匹配日志行；日志确认后只显示服务端正文，编辑替换正文，删除或隐藏不会复活本地草稿。Issue 与 Chat 的轮行消费服务端从 multiremi_turns 投影的卡片，卡片不自行制造工作轮或用户消息。

Chat 列表和详情的未读数来自创建者对应的 workspace member lane：只计 cursor_seq 之后、发给该成员且 shown/未删除的消息。自动已读经统一 inbox/read 推进同一游标，随后刷新会话列表保持已读；新消息到达后才再次标读。

[TurnControls](../../frontend/packages/views/common/turn-controls.tsx) 展开时才读取 attempts，查看日志时传选中 attempt_id；历史日志与当前尝试独立。失败/取消轮可以暖重试或冷重试，服务端返回同一 turn.id 和新的 current_attempt_id。输入弹窗按需读取 turn input 的完整 `(from_seq,to_seq]` 消息与 legacy_prompt，不在首屏逐行展开。

Chat 队列读取发给当前 agent、位于实际 cursor_seq 之后的消息；编辑/删除使用 message ID，不提供 prioritize。删除帧的 `fields.deleted_at` 会立即移除副本显示行并保留 revision 水位；IssueLogReplica 以 C7 快照决定行是否存在，只为仍在快照中的行保留已补齐的显示字段，避免旧窗口合并回已删正文。HTTP/SSR 窗口导入完成后才应用完整快照，避免 seq 0 和正文分批写入时丢失首屏行；live entry 的成功回读若已找不到该行，则传递最小隐藏标记，保留同批其他帧，网络与接口失败仍上报错误。重连重放或刷新回填的旧行不能恢复正文，主消息区也过滤带 `deleted_at` 的 canonical 消息。409 消费冲突会刷新队列并保留草稿供复制。消息附件发送后固定，编辑正文不会静默重绑附件；只有原发送人显示编辑/删除入口。回归见 [ChatWindow 日志链路集成测试](../../frontend/packages/views/chat/components/chat-window-log.integration.test.tsx)和 [IssueLogReplica 测试](../../frontend/packages/core/session-log/issue-log.test.ts)。

决定面板按需查各 Issue 对话的 decision 消息；选项提交 value，答复携带原 decision 的 reply_to_id 和它的 session_id。权限/提问表单发送结构化 response，不走退役的 task/issue 答复端点。回答与记录通过 canonical reply 消息展示；表单失败保留输入，解决不自动标读。

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
| 收件箱的游标分页、未读计数与阅读位置 | [inbox/queries.ts](../../frontend/packages/core/inbox/queries.ts) 的 `inboxPageOptions` / `inboxSummaryOptions`、[inbox-page.tsx](../../frontend/packages/views/inbox/components/inbox-page.tsx) |
| Issue 飞书话题设置 | [issue-topic-section.tsx](../../frontend/packages/views/settings/components/issue-topic-section.tsx)、[feishu-bot/queries.ts](../../frontend/packages/core/feishu-bot/queries.ts)、[workspaces router](../../packages/server/src/api/routers/workspaces.ts) 的 `/api/workspaces/:id/issue-topics` |
| 平铺会话日志（切片、行高缓存、副本端口） | [session-log-list.tsx](../../frontend/packages/views/common/session-log/session-log-list.tsx)、[entry-html.tsx](../../frontend/packages/views/common/session-log/entry-html.tsx)、[use-row-heights.ts](../../frontend/packages/views/common/session-log/use-row-heights.ts)、[core/replica/port.ts](../../frontend/packages/core/replica/port.ts) |
| 执行过程弹窗 | [task-trace-dialog.tsx](../../frontend/packages/views/common/task-transcript/task-trace-dialog.tsx)、[build-timeline.ts](../../frontend/packages/views/common/task-transcript/build-timeline.ts)、[agent-transcript-dialog.tsx](../../frontend/packages/views/common/task-transcript/agent-transcript-dialog.tsx)；点击后从 task trace API 分页读取，运行中由 trace socket 续传 |

收件箱的 `inbox:new {index_only:true}` 由专用 handler 刷新；read/batch-read 由通用 prefix 合批刷新，二者均使同工作区的 inbox 和 message-detail 缓存失效。决定事件同样刷新详情，所以已读深链和读后仍停留详情会跟随外部答复重取。Chat 消息提交成功后，补充 turn 读取失败仍保留消息成功结果，由 pending 轮查询补齐状态。

响应解析由各端点负责，目前并非所有历史方法都已调用 schema helper；新增或修改消费逻辑遵循前端规则。[createQueryClient](../../frontend/packages/core/query-client.ts)默认使用 `staleTime: Infinity`，列表是否更新依赖 mutation、WS 和重连处理，排查陈旧数据时应先核对这些路径。

执行时间线的旧消息与 trace 读取路径共用“过滤 usage/execution → 合并文字分片 → 脱敏”处理；合并不会跨越不同的 `meta.parent_tool_call_id`。Chat 在此结果上只额外过滤 compaction。弹窗事件数基于处理后的时间线，上下文标签独立读取 seq 最新的 usage（兼容旧 JSON content），与任务累计 input/output 用量分开显示。验证入口为 [build-timeline.test.ts](../../frontend/packages/views/common/task-transcript/build-timeline.test.ts)、[task-trace-dialog.test.tsx](../../frontend/packages/views/common/task-transcript/task-trace-dialog.test.tsx) 和 [chat-timeline.test.ts](../../frontend/packages/views/chat/lib/chat-timeline.test.ts)。

任务列表包含按状态分页的缓存结构；详情只需要已有列表中的某个对象时，使用 `findCachedIssue`，避免为查缓存额外挂载完整列表查询。列表、看板、我的单的「显示子单」偏好由各自的 view store 持久化，默认关闭；查询键与请求都包含服务端 `top_level_only` 过滤值，不能在客户端裁掉子单。父单进度从服务端 child-progress buckets 显示。工作台复用查询缓存区分待人工输入与待验收，不能只根据单个任务的完成状态自行推导整个 issue 的展示。

Issue 顶部提示只使用详情响应的 `pending_decision_count` 和 `blocked_by`，没有提示时不挂载提示槽。横条渲染不依赖 decisions / dependencies 的响应。侧栏未完成前置单计数和横条共用 `blocked_by`，保留固定高度槽位；兼容详情仅在 backlog 查询未完成前置单，其他状态返回空数组。非子单首屏没有 dependencies 请求；子单允许编辑器发一次，读取包括已完成项的完整依赖列表。负责人自己拍板和已回答记录不触发横条；依赖编辑和强制开始失效详情缓存，WS 的部分更新保留详情独有字段。

Issue 的 seq 0 是标题与描述的例外：[IssueLogHead](../../frontend/packages/views/issues/components/issue-log-head.tsx) 用详情标题渲染只读标题，按同一 head 行的 `metadata.title` 精确移除一次 Markdown 前缀，避免改标题时混用版本。描述交给 `ReadonlyContent`，复用已有附件查询缓存并启用普通代码块复制；冷缓存只在下载点击时加载附件列表，按 URL 找到 ID 后调用已有下载入口刷新签名，首屏不请求附件列表。编辑和保存都只包含描述，不消费带标题的 `body_html`。服务端与 agent 的日志契约不变。

收件箱使用 `GET /api/inbox` 的统一消息，每页 50 条，续页只使用服务端 opaque cursor。页内未读数与侧栏关注数分别来自响应的 `unread_count`、`attention_count`，覆盖所有可见对话；摘要读取同一端点的 limit=1，不拼合加载页计算。选择消息不会自动标读；「读到这里」以 session_id/to_seq 推进当前人的读游标，「全部已读」只发一次 `{all:true}`。没有逐条归档或归档批处理。深链接通过 message ID 读取详情，读游标写入失败保留原状态；查询键按工作区隔离，写入完成只刷新发起工作区。WS inbox 索引信号和可见会话日志帧触发缓存失效，前台 10 秒轮询提供恢复路径。

集成设置中的 Issue 话题表单维护工作区 `settings.issueTopics`，与 concierge bot 配置分开：成员可读，owner/admin 可保存启用状态、目标群和项目范围。API 的 `project_ids: null` 表示不限制项目；UI 开启项目限制时要求至少选择一项，服务端仍校验项目归属。保存后失效当前工作区的 `feishu-bot` 查询树；端点经过 schema 解析。验证入口为[表单测试](../../frontend/packages/views/settings/components/issue-topic-section.test.tsx)和[端点测试](../../frontend/packages/core/api/endpoints/feishu-bot.test.ts)。

Issue 活动区默认显示普通评论、固定单行的派活、字段动态和 `workspace_move_cleared` 日志。派活和被派 agent 的首条回应引用在点击后打开既有任务弹窗，初始停在「输入 Prompt」，评论流内不展开正文。回应关联只用当前窗口中唯一的同 task 派活记录，首次出现时确定，翻页不向已显示的评论追加引用；任务列表只在点击时复用缓存或读取。系统细节开关按用户和工作区在本地同步持久化，渲染前过滤结果发布、信封、收件箱唤醒及未知非评论类型。SSR 列表在本地偏好 hydration 完成前保持隐藏，定位脚本通过 `data-ssr-display-ready` 门禁等待最终显示集合，避免默认集合先显现再变化；用户切换开关时在绘制前保持 released 阅读锚点或 pinned 贴底。打开后 [IssueLogEventRow](../../frontend/packages/views/issues/components/issue-log-event-row.tsx) 显示固定一行人话，发布结果使用已有结果列表并打开右侧结果面板。信封按 `dedupeKey` 来源优先、`kind/to.role` 次之分类，永不使用正文兜底。Chat 永久过滤内部条目，无系统细节开关；普通评论交互和用户/assistant 气泡沿用原路径。

默认 Issue 会话的展示窗口增加 `with_activity=1`，同一个响应附带 `activities`、`activities_truncated` 和 `prev_entry_created_at`；侧会话和 Chat 无活动字段。活动仍来自活动表，不占 seq、不进入 C7。范围按「上一条日志时间（含）到本窗口末条时间（不含）」切分，尾窗上界开放；每窗保留最近 200 条。SSR 与客户端走同一窗口读法，无独立首屏活动请求；旧响应缺活动字段时保持兼容。[ADR 0015](../adr/0015-issue-activity-outside-the-conversation-log.md)记录 2a 契约及另一个 PR 实施的 2b 分层分页计划。

[活动展示纯函数](../../frontend/packages/views/issues/utils/issue-activity-presentation.ts)先过滤系统层，再按时间放置字段动态与派活；三条及以上连续事件合组，评论和可见系统行打断。默认只首次展开最新组，展开和最近八条的选择不会因新评论改变。动态挂在前一日志行的 trailer，成员/内容/展开签名进入行高缓存键，沿用现有揭示和贴底门禁。窗口翻页按 ID 合并活动，回尾部替换；实时 `activity:created` 仅在默认会话的尾窗追加，不计入新消息 chip。指派给 agent 的 `issue_assigned` 若能按被派 agent、十秒窗口和操作人匹配已加载 turn，就只保留派活；system 作者仅比较 agent 与时间。字段更新逐字段拆行，新 `previous` 提供旧值，历史仅显示新值；评论审计与 `workspace_move_cleared` 活动不重复，mention/replay 通知保留系统层规则。验证入口为 [活动窗口性质测试](../../tests/unit/multiremi/issue-activity-window.test.ts)、[放置与分组测试](../../frontend/packages/views/issues/utils/issue-activity-presentation.test.ts)及下面的窗口、Issue 和 SSR 回归。

派活和回应引用提供原始 turn 给任务弹窗：输入 Prompt 请求只有返回 404（未记录执行输入）时才显示该 turn 的派活说明，优先使用 `body_html`，缺失时渲染完整 `body_md`，两条路径都使用紧凑正文样式限制标题大小。提示依据 turn 的 `metadata.status`：`queued`、`dispatched` 和等待目录锁的 `waiting_local_directory` 显示「任务尚未开始执行」，其他或未知状态显示「未记录执行输入」；四语言同步。200 仍展示完整审计输入，网络或服务端错误仍保留错误态；没有 turn 的执行过程等入口沿用原空态。验证入口为 [派活弹窗测试](../../frontend/packages/views/issues/components/issue-task-prompt-dialog.test.tsx)、[执行弹窗测试](../../frontend/packages/views/common/task-transcript/task-trace-dialog.test.tsx)和 [输入 Prompt 测试](../../frontend/packages/views/common/task-transcript/agent-transcript-dialog.test.tsx)。

固定摘要通过 `transformEntries` 使用新的行高缓存 `render_version`，不重用旧全文或展开态测量，也不更改副本日志。开关切换由用户触发，弹窗不增加评论流高度，姓名和标题更新只替换单行文字。回归入口为 [摘要测试](../../frontend/packages/views/common/session-log/event-summary.test.ts)、[Issue 日志行测试](../../frontend/packages/views/issues/components/issue-log-event-row.test.tsx)、[偏好测试](../../frontend/packages/core/issues/stores/activity-preferences-store.test.ts)、现有 Chat、任务弹窗及滚动 hook/list 测试；这些测试不代替真实浏览器首屏性能验收。前端隐藏日志仍占服务端分页条数；显示层分页属于后续 2b 改动。

深链目标属于系统细节时，本次访问临时开启显示且不写偏好，开关显示为开启；目标未加载时揭示门禁继续等待，用户手动切换后以其选择为准并持久化，离开该深链访问后恢复保存值。SSR 与客户端在渲染前使用同一目标分类，首个可见帧即可定位和高亮；验证入口为 [Issue 深链回归](../../frontend/packages/views/issues/components/issue-detail.test.tsx)和 [SSR 定位脚本回归](../../frontend/apps/web/app/issue-log-ssr-position.test.ts)。

`/log/locate` 返回 404 时，已删除或不存在的评论深链回退到该会话尾部；未指定会话时，所有会话均返回 404 才回退到默认会话。回退窗口与缺失目标状态一起就绪，渲染前取消锚点、高亮和临时系统细节，首个可见帧沿用普通浏览的贴底状态。SSR 用 `missingCommentId` 标记尾部 seed；旧 SSR seed 的目标不在窗口时，客户端重新定位后按同一规则回退。网络错误、5xx 和尾部读取失败仍保留错误态与重试。验证入口为 [日志窗口回归](../../frontend/packages/core/session-log/issue-log.test.ts)、上述 Issue 深链回归与 [SSR 读取回归](../../frontend/apps/web/features/issues/server-log.test.ts)。

## 实时更新与性能定位

Runtime 详情的 Codex / Claude Code 连接页通过 [provider-profile.ts](../../frontend/packages/core/runtimes/provider-profile.ts) 与[共享表单](../../frontend/packages/views/runtimes/components/runtime-provider-profile-tab.tsx)读取和保存单个 Runtime 的 provider 配置；查询键包含 workspace/runtime ID，响应严格校验。表单支持 API Key（保存后清空，留空保留）和本机环境变量；Claude 还支持 Bearer / x-api-key 请求鉴权；未声明对应 `codex_profiles: 1` 或 `claude_profiles: 1` 的旧 daemon 只能查看更新提示。保存后失效 Runtime 和模型目录缓存；鉴权与隔离契约见 [Codex Runtime](../design/acp-codex-via-codex-acp.md#runtime-自定义连接)和 [Claude Code Runtime](../design/acp-claude-via-claude-agent-acp.md)。

- [useRealtimeSync](../../frontend/packages/core/realtime/use-realtime-sync.ts)负责订阅生命周期和断线重连后的缓存恢复；领域处理器集中在 [realtime/sync/](../../frontend/packages/core/realtime/sync/)。
- [issues/ws-updaters.ts](../../frontend/packages/core/issues/ws-updaters.ts)补写可确定的任务列表和详情，对派生列表做失效处理。改任务响应字段时同时检查这里和 mutation 的缓存处理。
- [prefix-refresh.ts](../../frontend/packages/core/realtime/sync/prefix-refresh.ts)按事件前缀合并刷新；`SPECIFIC_EVENTS` 排除已有精确处理器的事件，避免重复失效。
- 浮动 Chat 在 [FloatingPanelLayout](../../frontend/packages/views/layout/floating-panel-layout.tsx) 中预留展开的 Issue 属性栏宽度；右栏缩放和折叠通过 ResizeObserver 更新布局，普通与展开的浮窗均限制在剩余文档区域，不提高属性按钮层级。
- Chat/Issue 正文由 [SessionReplica](../../frontend/packages/core/replica/browser.ts) 的 `log:` 流驱动；运行中的简要工具状态由 [use-task-trace.ts](../../frontend/packages/views/common/task-transcript/use-task-trace.ts) 读取并订阅 `trace:`，结束任务只读分页结果，不继续占用 trace socket。
- 排查慢页面先区分网络请求扇出、API 延迟、缓存失效范围和 React 渲染成本；保留测量场景与前后结果。以上文件提供定位入口，不把静态代码形态直接当成已证实的性能瓶颈。

## 验证入口

浏览器本地副本在 [replica/browser.ts](../../frontend/packages/core/replica/browser.ts)。Web Lock、BroadcastChannel、OPFS SAH pool 名和目录都使用同一个 `(user_id, workspace_id)` 分区键；频道消息再核对该键。leader 持有 Worker 和 socket，follower 通过频道查询；没有 OPFS 或 Web Locks 时，每页的 Memory 副本复用同一个 leader 请求队列和同步语义。

页面句柄显式 open/close，每个 tab 对同一 session 只声明一次兴趣；leader 按 tab 去重，最后一个 close 才退订。新 leader 宣告接管后，各存活页面重新声明，cursor 来自数据库的连续 head。dispose 终止 Worker 并结束 Web Lock 回调，使下一页可以接管。

副本 schema v3 包含 `revision_watermarks`，Memory 也保存同样的 `(session_id, seq) → revision` 水位。删除或隐藏只移除展示行，不移除水位；浏览器 log 出口的最小隐藏标记只带 session_id、seq、revision 和 visibility，同 revision 也移除已缓存正文，仍记录 coverage 并推进连续 head，不生成展示卡片或重复补洞。流帧和 HTTP 窗口都拒绝不高于水位的 revision，交接重开后仍有效。水位随删除行数增长，不按 coverage 回收；session/log_version 重置、身份切换和整库清除同时删除水位。旧版缓存无法还原已丢失的删除 revision，因此按既有 schema_upgrade 路径清库并重新同步。

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
