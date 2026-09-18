---
title: 性能热路径与基线采集
status: active
summary: 当前性能相关实现、必须保留的语义，以及复用现有工具采集可比较基线的方法。
---

# 性能热路径与基线采集

本页是 2026-09-05 对当前工作树的静态核查，不是历史架构决议。**本轮基线未测**：本次文档核对没有采集延迟、吞吐、CPU、内存或浏览器性能数据。下文区分已经存在的优化与待测成本；已有报告必须结合其生成时间、提交和环境判断，不能作为当前版本的实测结果。

## 三条优先关注的热路径

### 1. 任务列表：页面请求展开 → 列表与计数 → PostgreSQL 同步桥

- **实现事实：** [issues/queries.ts](../../frontend/packages/core/issues/queries.ts) 的 `fetchFirstPages` 对 `PAGINATED_STATUSES` 逐状态并行请求，每页 50 条；当前 [BOARD_STATUSES](../../frontend/packages/core/issues/config/status.ts) 有 6 个状态。
- **实现事实：** `fetchAllMyFirstPages` 合并 assignee、creator、involves 三种人员关系并按 issue ID 去重。因此“我的全部任务”的状态列表首次执行会展开为 **6 × 3 = 18 个列表请求**。这是代码推导，不是页面总请求实测；缓存命中、重试和其他查询会改变网络记录。[MyIssuesPage](../../frontend/packages/views/my-issues/components/my-issues-page.tsx) 的负责人看板使用另一条 grouped 查询分支，不能套用 18。
- **实现事实：** [issues router](../../packages/server/src/api/routers/issues.ts) 的列表响应调用 `listIssues` 和 `countIssues`。[PgBridge.request](../../packages/server/src/store/db/postgres.ts) 使用 `Atomics.wait` 等待 worker，worker 以 [Bun.SQL 的 `max: 1`](../../packages/server/src/store/db/pg-worker.ts) 保证事务语句共用连接。该限制是每个桥实例的连接数，不是整个部署只能有一个连接。
- **风险推断：** 并行 HTTP 请求无法自动消除主线程同步数据库等待；额外 SQL 往返和较大的响应序列化可能放大排队，影响同进程其他请求。吞吐拐点与 PostgreSQL 网络延迟的影响尚未测量。
- **采集重点：** 冷/热页面请求数量、单请求 SQL 数与响应 bytes、列表可操作时间，以及 API 并发升高时的 p50/p95、错误率和事件循环延迟。

### 2. 搜索：候选 issue → 逐 issue 搜评论 → 过滤与分页

- **实现事实：** [IssuesRepo.searchIssues / searchIssueCommentSnippet](../../packages/server/src/store/repos/issues-repo.ts) 先调用 `listIssues({ includeArchived: true })`；启用评论正文搜索时逐 issue 查询评论，再在 JavaScript 中筛 workspace、匹配字段、排序和截取页面。`includeCommentBodies` 默认启用，传 `false` 才跳过评论查询。
- **风险推断：** 工作量随候选 issue 数和评论体积增长，返回 20 条并不意味着只读取 20 条。当前步骤还会处理最终不属于目标 workspace 的候选；不能只看返回条数评估 SQL 与内存成本。
- **采集重点：** 用无命中词、标题命中词、评论命中词分别测量；固定目标 workspace，再增加其他 workspace 的数据，记录 SQL 次数、结果 bytes、p50/p95。真实用户可见结果与权限语义需保持不变。

### 3. 实时任务：消息缓存 → transcript 派生 → 渲染与重连刷新

- **实现事实：** [createTaskHandlers](../../frontend/packages/core/realtime/sync/tasks.ts) 已按 task 缓冲 `task:message`，约每 80 ms 合并一次；卸载时 flush。消息通过 [appendTaskMessagesToHydratedCache](../../frontend/packages/core/chat/queries.ts) 更新已加载缓存，保留排序和去重，不能宣称“每帧都触发整页 refetch”。
- **实现事实：** [createIssueHandlers](../../frontend/packages/core/realtime/sync/issues.ts) 已做 issue 精确缓存更新；[createPrefixRefresh](../../frontend/packages/core/realtime/sync/prefix-refresh.ts) 排除有专门处理器的事件并对其他刷新去抖；[useRealtimeSync](../../frontend/packages/core/realtime/use-realtime-sync.ts) 在重连时失效相关查询以补漏。
- **实现事实：** [TasksRepo.listTaskMessages](../../packages/server/src/store/repos/tasks-repo.ts) 支持 `sinceSeq` 增量读取，但没有 page size；初次读取可返回该 task 全部消息。[buildTimeline / buildEntries / nestEntries](../../frontend/packages/views/common/task-transcript/build-timeline.ts) 派生展示数据；[AgentTranscriptDialog](../../frontend/packages/views/common/task-transcript/agent-transcript-dialog.tsx) 用 `entries.map` 渲染事件列表，该弹窗目前没有列表虚拟化。
- **风险推断：** 长 transcript 的载荷、全数组派生与 DOM 成本可能随消息数增长；80 ms 合并已减少频率，但不能证明每次处理足够快。重连时的刷新展开可能与消息追赶叠加。其他视图是否虚拟化需逐处确认。
- **采集重点：** 固定消息数、平均文本长度、工具/子 agent 比例和每秒事件数；记录首次打开、排序/过滤、滚动、实时追加和断线重连期间的请求数、长任务、React commit 时长与内存。

## 收件箱已具备的加载边界

- [InboxPage](../../frontend/packages/views/inbox/components/inbox-page.tsx) 通过 [inboxPageOptions](../../frontend/packages/core/inbox/queries.ts) 每页读取 50 条；[listInboxItemsPage](../../packages/server/src/store/repos/issues-repo.ts) 按 `created_at DESC, id DESC` 使用游标，SQL 读取 `limit + 1` 判断后续页，服务端上限 100。`hydrateInboxRows` 已按最多 400 个 issue ID 批量补全关联对象，不能再将收件箱描述为逐行 `getIssue`。
- 侧栏和页内计数复用 `/api/inbox/summary`，摘要不返回正文、不补全 Issue，仅成功自动运行保留分组所需的 `details`。但服务端仍读取该成员所有未归档精简行，在 JavaScript 中去重和计数；分页并未把这部分成本变成常数。旧 `/api/inbox` 全量接口仍存在，页面已使用分页入口。
- 测量时分别记录首屏、摘要、追加页、定位较后页通知，以及 mutation/WS 失效后的刷新。来源筛选和展示折叠仅处理已加载项；URL 定位可能连续读取多页，不能把 50 条默认页大小当作每次页面交互的总工作量。当前没有这些场景的延迟或内存基线。

## 优化不能破坏的约束

- 数据库层必须保持 SQLite/PostgreSQL 行为一致；`transaction` 的原子性和回滚语义不能因连接池化或 async 改造丢失，不能仅把 `max: 1` 调大。
- 列表合并必须保留人员关系的 OR 语义、按 ID 去重、状态桶、排序及分页。当前“全部”桶的 `total` 是合并后已加载长度，并非完整服务端总数；改变此语义需同时改调用方。
- 搜索要保留 workspace/权限边界、关闭和归档筛选、评论片段、排序及分页语义；下推 SQL 时应以现有结果契约验证，而不是只比较速度。
- 实时消息保留 task/seq 身份、去重、顺序、卸载尾部 flush、未加载缓存保护和重连补漏；不可用扩大 `staleTime` 或删除失效逻辑掩盖请求量。
- transcript 保留工具调用与结果配对、子 agent 分组、seq 定位、脱敏、终态及用户主动滚动的位置。虚拟化只能减少 DOM，不能代替数据派生和加载边界优化。
- 收件箱保留游标的稳定排序、成员隔离、摘要跨所有未归档记录计数，以及自动运行分组、读/归档操作和链接定位语义；摘要数不能改成已加载页的局部计数。
- 新增用户侧批量 API 或查询能力时，按根 [AGENTS.md](../../AGENTS.md) 同批对齐 CLI；本页维护不新增用户能力。

## 已有验证和测量入口

以下命令是验证和测量入口；实际执行结果应记录在对应任务或 PR，不能从入口存在推断检查已通过。Bun 版本遵循根 `package.json`；Node 不能替代 `bun:sqlite`、`Bun.SQL` 或 Bun Worker 执行这些入口。

| 工作目录 | 命令 | 用途与限制 |
| --- | --- | --- |
| 仓库根 | `bun run scripts/bench-api-route-baseline.ts` | 内存 SQLite、Hono `app.request()`；5 次预热、30 次串行样本；输出 SQL 数、p50/p95、响应 bytes、seed 和查询计划。无真实 HTTP/PG/浏览器测量。 |
| 仓库根 | `bun run scripts/render-api-route-audit-report.ts` | 将上一命令 JSON 渲染为 HTML；脚本内原因标签/建议有静态文字，复用时仍需回读源码核实。 |
| 仓库根 | `bun run tests/manual/bench-store-n-plus-one.ts "IssuesRepo.searchIssues(includeCommentBodies=true)"` | SQLite 的 0/50/200/500 规模 SQL 数和 11 次样本 p50；输出路径由 `MUL175_BENCH_OUTPUT` 指定，不产出 p95。 |
| 仓库根 | `bun run tests/manual/bench-pg-bridge-overhead.ts` | 用 echo worker 隔离桥开销，产出微基准 p50/p95；没有访问 PostgreSQL，脚本末尾的固定 SQL 数外推不代表当前实现。 |
| 仓库根 | `bun test tests/unit/multiremi/multiremi-store-issues.test.ts tests/unit/multiremi/multiremi-api-issues.test.ts` | 列表、搜索及 API 行为；功能测试不是性能基线。 |
| 仓库根 | `bun test tests/unit/multiremi/multiremi-api-search-inbox.test.ts` | 收件箱游标、摘要和原有读/归档契约；不产出性能数据。 |
| 仓库根 | `bun test tests/unit/multiremi/multiremi-postgres-store.test.ts` | SQL 翻译和真实 PG store 契约；`MULTIREMI_TEST_POSTGRES_URL` 指向可创建临时数据库的测试实例，不可达时集成部分跳过，须记录 skipped。 |
| `frontend/packages/core` | `bun run test issues/queries.test.ts issues/ws-updaters.test.ts realtime/sync/tasks.test.ts realtime/use-realtime-sync.test.ts` | 查询、精确缓存更新、实时排序/去重与刷新语义。 |
| `frontend/packages/views` | `bun run test common/task-transcript/build-timeline.test.ts common/task-transcript/agent-transcript-dialog.test.tsx` | 工具配对、子 agent 展示、终态和弹窗交互。 |
| `frontend/packages/core` / `frontend/packages/views` | 分别运行 `bun run test inbox/mutations.test.tsx` / `bun run test inbox/components/inbox-page.test.tsx` | 分页缓存 mutation、追加页、选择与折叠条目操作。 |

测量源码：[API baseline](../../scripts/bench-api-route-baseline.ts)、[报告渲染](../../scripts/render-api-route-audit-report.ts)、[搜索规模基准](../../tests/manual/bench-store-n-plus-one.ts)、[桥微基准](../../tests/manual/bench-pg-bridge-overhead.ts)。

## 复现顺序与记录

1. 记录 `git rev-parse HEAD`、`git status --short`、Bun/OS/CPU/内存、进程数量和数据库版本/位置。dirty 工作树另存差异摘要，不能只记 SHA。数据只用测试 fixture 或脱敏副本。
2. 先复用 API baseline，不新造同类采集器。脚本覆盖固定的 `reports/performance/MUL-176-api-route-baseline.json`，renderer 覆盖同目录 HTML；每次运行后复制为带时间与 SHA 的独立产物，连同 console 输出和环境记录保存。
3. API baseline 使用固定 `/tmp` 工作目录且会清理，顺序运行于支持 Bun 的隔离测试 checkout（优先 Linux/WSL），不与其他实例共用这些临时目录。保存输出中的实际 seed、状态码和 probe 数；脚本报错属于采集失败，不能当零延迟。
4. 使用搜索规模基准定位 SQL 增长，单独保存 `MUL175_BENCH_OUTPUT`；桥微基准仅报告桥耗时。二者均不能外推 PG 吞吐或端到端 p95。需要新数据规模时记录 fixture 变更，基线与改动版使用相同版本。
5. PG/真实 HTTP 基线尚无本页确认的统一负载入口：后续在隔离服务上固定读请求序列，按并发 1/4/16、每组至少 100 次完整响应分别采集；保存负载脚本和参数，再谈比较。记录 SQL 数、bytes、延迟、错误率及服务进程事件循环延迟；不记录凭证或原始敏感响应。
6. 浏览器使用相同构建模式、窗口尺寸与 fixture：分别打开“我的全部任务”状态列表和固定 transcript，记录 Network/HAR 与 Performance trace；实时场景固定事件速率并执行一次断线重连。比较初次加载与同一页面重复进入，计数仅包含指定时间窗口。
7. **cold/warm 必须定义：** 新浏览器上下文/空 Query 缓存是浏览器冷启动，不代表 PG 缓存冷；进程重启和数据库缓存状态分开记录。现有 API baseline 只有 warm 串行结果。采用同一分位数算法，对每个场景和并发单独报告，失败样本另计，不混算平均值。

复制以下模板填写；未知值留 `未测`，不要填 0：

```text
日期 / 操作者：
commit / dirty 差异摘要 / fixture 版本：
OS / CPU / 内存 / Bun / 前端构建模式：
数据库类型、版本、位置 / API 进程数 / 网络条件：
workspace、issue、comment、task、message 数 / 典型正文 bytes：
场景 / 请求参数或页面分支 / 事件速率 / 并发：
cold/warm 定义 / warmup 次数 / 有效样本数 / 分位数算法：
HTTP 或 app.request p50/p95（ms） / 错误率 / SQL数 / 响应 bytes：
页面可操作时间 / 长任务 / React commit / 事件循环延迟 / 内存：
原始 JSON、日志、HAR、trace 路径 / 失败或 skipped：
结论（已测事实） / 风险推断 / 下一项待测：
```

与基线比较时先证明结果、权限和事件语义一致，再报告相同环境下的差值；没有数据时只能提出待验证假设。
