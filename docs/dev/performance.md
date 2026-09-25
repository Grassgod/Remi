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
- **实现事实：** [TasksRepo.appendTaskMessages](../../packages/server/src/store/repos/tasks-repo.ts) 对同一 `(task_id, seq)` 的相同内容重试跳过更新和通知，内容变化仍覆盖原行；[notifyBrowserTaskMessages](../../packages/server/src/api/realtime.ts) 在每批消息内复用可见性判断，不跨批缓存权限。daemon outbox 在超时后仍会重试，因此这里的幂等处理和私有任务权限过滤都需要保持。
- **风险推断：** 长 transcript 的载荷、全数组派生与 DOM 成本可能随消息数增长；80 ms 合并已减少频率，但不能证明每次处理足够快。重连时的刷新展开可能与消息追赶叠加。其他视图是否虚拟化需逐处确认。
- **采集重点：** 固定消息数、平均文本长度、工具/子 agent 比例和每秒事件数；记录首次打开、排序/过滤、滚动、实时追加和断线重连期间的请求数、长任务、React commit 时长与内存。

## 收件箱已具备的加载边界

- [InboxPage](../../frontend/packages/views/inbox/components/inbox-page.tsx) 通过 [inboxPageOptions](../../frontend/packages/core/inbox/queries.ts) 每页读取 50 条；[listInboxItemsPage](../../packages/server/src/store/repos/issues-repo.ts) 按 `created_at DESC, id DESC` 使用游标，SQL 读取 `limit + 1` 判断后续页，服务端上限 100。`hydrateInboxRows` 已按最多 400 个 issue ID 批量补全关联对象，不能再将收件箱描述为逐行 `getIssue`。
- 侧栏和页内计数复用 `/api/inbox/summary`，摘要不返回正文、不补全 Issue，仅成功自动运行保留分组所需的 `details`。但服务端仍读取该成员所有未归档精简行，在 JavaScript 中去重和计数；分页并未把这部分成本变成常数。旧 `/api/inbox` 全量接口仍存在，页面已使用分页入口。
- 测量时分别记录首屏、摘要、追加页、定位较后页通知，以及 mutation/WS 失效后的刷新。来源筛选和展示折叠仅处理已加载项；URL 定位可能连续读取多页，不能把 50 条默认页大小当作每次页面交互的总工作量。当前没有这些场景的延迟或内存基线。

## 请求级观测：Server-Timing 与两类日志（MUL-367）

自 MUL-367 起后端自带按请求的耗时数据，不必再用 nginx 临时日志或人工采样 PG。实现位于 [request-metrics.ts](../../packages/server/src/observability/request-metrics.ts)，入口有两处：[createMultiremiApp](../../packages/server/src/api/server.ts) 里**第一个**注册的中间件，以及 [startMultiremiServer](../../packages/server/src/api/server.ts) 里带 `unref()` 的汇总 timer。中间件顺序是硬约束：Hono 只包裹注册在其后的 handler，排在鉴权之后就会漏掉 `verifyAccessToken` 的查库时间。

**响应头** `Server-Timing`（浏览器 DevTools 的 Network → Timing 直接可见）：

```text
Server-Timing: total;dur=12.3, db;dur=4.5, dbp;dur=0.2, dbq;desc="7", dbb;desc="12345"
```

| 指标 | 含义 |
| --- | --- |
| `total` | 请求总耗时，包含鉴权与路由处理 |
| `db` | 在 [PgBridge](../../packages/server/src/store/db/postgres.ts) 的 `Atomics.wait` 上阻塞的累计时间 |
| `dbp` | 主线程 `TextDecoder` + `JSON.parse` 解析桥回包的累计时间，是 MUL-366「序列化 + GC」假设的直接证据 |
| `dbq` / `dbb` | 该请求的 SQL 条数与过桥字节数；计数不是时长，因此放在 `desc` |

耗时保留 1 位小数。404、`onError` 返回的 500、以及 handler 抛出但被 Hono 转成 500 的请求同样带这个头。`route` 始终是 Hono 路由模式（如 `/api/shares/:token`），绝不记录原始 path 或 query —— 后者的 path 段就带凭证；未匹配到路由时为 `<unmatched>`。

**慢请求日志**（阈值 `MULTIREMI_SLOW_REQUEST_MS`，默认 500 ms），每行一个 JSON 对象写到 **stdout**：

```json
{"event":"api_slow_request","ts":"2026-09-24T11:14:49.392Z","method":"GET","route":"/health","status":200,"total_ms":1.3,"db_ms":0,"db_parse_ms":0,"db_queries":0,"db_bytes":0}
```

不含 query、header、body、原始 path、user 或 token。这里用 `console.log(JSON.stringify(...))` 而不是 `createLogger`：后者的 INFO 才走 stdout（WARN/ERROR 走 stderr）、带人读前缀使一行不是一个 JSON 对象，且在 `initLogPersistence()` 之后每条都会 `appendFileSync`，等于在请求路径上做同步磁盘 IO。

**每分钟汇总**（`api_minute_summary`，同样只写 stdout、不写 DB、不做同步 IO）：

```json
{"event":"api_minute_summary","ts":"2026-09-24T11:14:54.369Z","window_ms":5001,"requests":3,"status_5xx":0,"slow":3,"dropped":0,"db_busy_pct":0,"db_queries":0,"event_loop_lag_max_ms":2.7,"routes":[{"method":"GET","route":"/health","count":1,"p50_ms":1.3,"p95_ms":1.3,"sum_ms":1.3}]}
```

- 数据源是固定容量的内存环形缓冲区（typed array，route 字符串 intern 成整数 id）。写满后覆盖最旧样本并把次数记进 `dropped`，缓冲区不随流量增长。
- `routes` 按 `sum_ms` 取前 N（默认 10）。分位数用最近秩法，与 [bench-task-list-pagination.ts](../../tests/manual/bench-task-list-pagination.ts) 和 API baseline 脚本一致，因此这些数字可以和既有报告对照。
- `db_busy_pct` = 该窗口内**进程级** DB 阻塞时间 / 窗口时长。进程级计数包含没有请求上下文的调用，所以后台 job 的 DB 时间也算进去，这正是「DB 忙碌占比」需要的分母口径。
- `event_loop_lag_max_ms` 用 250 ms 间隔的 `setInterval` 漂移测量并取窗口内最大值；同步 PG 桥阻塞主线程时会直接体现为晚 tick。

**环境变量**（都在 [api.env.example](../../deploy/docker/api.env.example) 有登记）：`MULTIREMI_REQUEST_METRICS`（默认开，`0/false/off` 整体关闭，关闭后不加响应头也不写任何日志）、`MULTIREMI_SLOW_REQUEST_MS`（默认 500，设 0 可让每个请求都打一行，适合短时冒烟）、`MULTIREMI_METRICS_SUMMARY_INTERVAL_MS`（默认 60000）、`MULTIREMI_METRICS_SUMMARY_TOP_N`（默认 10）、`MULTIREMI_METRICS_BUFFER_SIZE`（默认 4096）。

**观测与验证入口**：

```bash
# 生产容器里的两类日志（209 上的 API 容器）
docker logs multiremi-platform-app-api-1 | grep api_minute_summary
docker logs multiremi-platform-app-api-1 | grep api_slow_request

# 单元测试：并发归属、Server-Timing 格式、慢请求日志脱敏、汇总器
bun test tests/unit/multiremi/request-metrics.test.ts

# 真实 HTTP 冒烟：起一个本地实例，读 Server-Timing + 两类日志
bun run tests/manual/smoke-request-metrics.ts
```

冒烟脚本默认用 0 ms 阈值和 5 s 汇总间隔以便一次跑完就同时看到两个事件；`MUL367_SMOKE_PORT` / `MUL367_SMOKE_SUMMARY_MS` 可覆盖。它只连 127.0.0.1 的临时实例和内存 SQLite，不读凭证、不碰生产。上线后需要真实基线数字时，按本文档开头「复现顺序与记录」的模板记录环境、并发和样本数，**不要**把本页的示例行情当作实测结论。

## 页面测速脚本与基线（MUL-367）

[frontend/scripts/perf/page-speed.ts](../../frontend/scripts/perf/page-speed.ts) 用仓库既有的 `@playwright/test` 打开主要页面，记录每页的就绪时间、API 调用数、API 字节、最慢 API 及 `Server-Timing`。它**不是** e2e 套件，位于 `frontend/e2e` 之外，不会被默认 e2e 扫到；依赖已有 `@playwright/test`，不新增依赖。

**只读保证**：脚本在 `page.route('**/api/**')` 里 abort 所有非 GET/HEAD 请求，并把这些请求按 `method + 脱敏 path` 记进 `blockedWrites`，所以它可以在生产上对着真实账号跑。打开 inbox 页面本身不会写数据（实测 0 个写请求）；点击某一行会触发 `POST /api/inbox/:id/read`，只读探针会把它拦下来并记录尝试次数，**不会**真的标记已读。每次运行还会先做一次护栏自检（对 `/api/inbox/unread-count` 发 POST，必须被拦截），自检结果是报告的一部分——否则“页面从未写数据”和“护栏静默失效”无法区分。

**凭证**：token 只从 `MULTIREMI_QA_WEB_TOKEN` 读取，写进目标 origin 的 `localStorage.multimira_token`，不打印、不落盘、不进 argv、不进报告。输出文件里只有 method、脱敏 path、status、耗时和字节。

```bash
# 生产只读基线（在持有 MULTIREMI_QA_WEB_TOKEN 的机器上，headless 运行）
bun run frontend/scripts/perf/page-speed.ts \
  --base-url http://n37-117-209.byted.org --rounds 3 \
  --out reports/performance --name MUL-367-page-speed-baseline-<日期>

# 发布后复跑并输出前后对比表
bun run frontend/scripts/perf/page-speed.ts \
  --base-url http://n37-117-209.byted.org --rounds 3 \
  --out reports/performance --name MUL-367-page-speed-after-<日期> \
  --compare reports/performance/MUL-367-page-speed-baseline-<日期>.json
```

**口径**（报告里也写了一遍，改脚本时必须同步改）：

| 项 | 口径 |
| --- | --- |
| 页面集合 | issues、my-issues、chat、inbox、agents、runtimes、projects、workbench、settings、autopilots、skills |
| 就绪时间 | 从 `page.goto` 起算，到主内容区域出现 H1 且区域内 `data-slot="skeleton"` 归零 |
| 加载方式 | 每轮一个全新 browser context，逐页 `page.goto` 整页加载；每轮第一页（issues）含 app shell 冷启动，同轮后续页面复用该 shell |
| LCP | 由 `addInitScript` 里预装的 `PerformanceObserver` 采集（不在导航前注册就取不到条目） |
| 字节 | `encodedBodySize`（压缩后）、`decodedBodySize`（解压后 JSON）、`transferSize`（含响应头） |
| path 脱敏 | 去掉 query；ID 形状的段换成 `:id`；已知的 workspace id / slug / member id 按值掩码，否则 `local`、`remi` 这种没有形状特征的标识会漏出去 |
| 环境参照 | 运行前后各采 7 次 `/api/config`，记中位耗时。生产是共享环境，复跑对比前先核对这个参照 |

今天的生产基线是 [reports/performance/MUL-367-page-speed-baseline-2026-09-24.json](../../reports/performance/MUL-367-page-speed-baseline-2026-09-24.json)（原始数据）、同名 `.md`（表格）与同名 `.html`（自包含单文件，可直接挂到 Issue 评论）。运行机器、Chromium、API 版本与护栏自检结果都写在报告的 `meta` 里。**明天复跑必须在同一台机器上**，否则机器差异会混进前后对比。

采集当天生产本身处于劣化状态：运行前后各 7 次 `/api/config` 的中位耗时是 1886 ms / 3735 ms（同一窗口里还混着 1.2–2.7 s 的样本，说明不是链路固定延迟，而是服务端在排队）。11 个页面里有 1 次 `issues` 加载在 60 s 就绪等待内没有满足口径，报告把它标出来且不计入中位数。因此这组数字是**劣化态记录**，既不能当稳态性能，也不适合直接拿来定优化目标。改报告格式时用 `--render-only <json>` 重渲染，不必重新采集。

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
| 仓库根 | `bun run frontend/scripts/perf/page-speed.ts --base-url <url> --rounds 3 --out reports/performance --name <stem>` | 真实生产（或任意已部署实例）的浏览器侧基线：11 个主页面各自的就绪时间、API 调用数/字节、最慢 API 与 `Server-Timing`。headless Chromium，只读（所有非 GET/HEAD 的 `/api/**` 被 abort 并列出）。需要 `MULTIREMI_QA_WEB_TOKEN`；不测并发、不测多个 viewport。 |
| 仓库根 | `bun run scripts/bench-api-route-baseline.ts` | 内存 SQLite、Hono `app.request()`；5 次预热、30 次串行样本；输出 SQL 数、p50/p95、响应 bytes、seed 和查询计划。无真实 HTTP/PG/浏览器测量。 |
| 仓库根 | `bun run scripts/render-api-route-audit-report.ts` | 将上一命令 JSON 渲染为 HTML；脚本内原因标签/建议有静态文字，复用时仍需回读源码核实。 |
| 仓库根 | `bun run tests/manual/bench-store-n-plus-one.ts "IssuesRepo.searchIssues(includeCommentBodies=true)"` | SQLite 的 0/50/200/500 规模 SQL 数和 11 次样本 p50；输出路径由 `MUL175_BENCH_OUTPUT` 指定，不产出 p95。 |
| 仓库根 | `bun run tests/manual/bench-pg-bridge-overhead.ts` | 用 echo worker 隔离桥开销，产出微基准 p50/p95；没有访问 PostgreSQL，脚本末尾的固定 SQL 数外推不代表当前实现。 |
| 仓库根 | `MUL357_TASKS=6000 bun run tests/manual/bench-task-list-pagination.ts --out <path>` | `GET /api/multiremi/tasks` 的 `limit` / 无 limit / 带 status / 普通成员四类请求在 6000 条种子数据下的 p50/p95、响应字节、SQL 条数与序列化耗时。内存 SQLite + `app.request()`，不含真实 HTTP 与 PostgreSQL；改前数字用同一文件在父提交上运行。 |
| 仓库根 | `MULTIREMI_TEST_POSTGRES_URL=postgres://… MUL357_TASKS=6000 bun run tests/manual/bench-task-list-pagination-pg.ts --out <path>` | 同一接口在**真实 PostgreSQL** 上的对照：混合分布与两个尾部最坏分布（可见集中在最新 / 最旧）各跑一遍，输出 p50/p95、响应字节、SQL 条数、以及**过桥字节**（worker 序列化回主线程的 JSON 体积，`SELECT *` 与窄投影的差别就体现在这里）。改前数字用同一文件在父提交上运行；需要可创建临时库的 PG 实例。 |
| 仓库根 | `bun test tests/unit/multiremi/multiremi-store-issues.test.ts tests/unit/multiremi/multiremi-api-issues.test.ts` | 列表、搜索及 API 行为；功能测试不是性能基线。 |
| 仓库根 | `bun test tests/unit/multiremi/multiremi-api-search-inbox.test.ts` | 收件箱游标、摘要和原有读/归档契约；不产出性能数据。 |
| 仓库根 | `bun test tests/unit/multiremi/multiremi-postgres-store.test.ts` | SQL 翻译和真实 PG store 契约；`MULTIREMI_TEST_POSTGRES_URL` 指向可创建临时数据库的测试实例，**本地/Agent 会话必须显式设置，否则集成部分整片静默 skip**（CI 在 `release-build-check.yml` 的 backend suite 步骤显式声明），不可达时跳过并打印原因，须记录 skipped。 |
| 仓库根 | `MULTIREMI_TEST_POSTGRES_URL=postgres://… bun test tests/unit/multiremi/multiremi-task-list-postgres.test.ts` | MUL-357 的 PG 侧证据：迁移的两个分页索引真的建出且 `indexdef` 与 `ORDER BY created_at DESC, id DESC` 匹配、`EXPLAIN (ANALYZE)` 不出现 Seq Scan/全量 Sort、`?`→`$n` 的 status/游标/limit 绑定顺序、分页走遍后与未分页集合一致。UNSET 时默认落到 `postgres://multimira:multimira@localhost:5432/postgres`（即 CI service container），不可达时跳过并打印原因，须记录 skipped。 |
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
