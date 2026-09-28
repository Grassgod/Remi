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
{"event":"api_slow_request","ts":"2026-09-24T11:14:49.392Z","role":"all","method":"GET","route":"/health","status":200,"total_ms":1.3,"db_ms":0,"db_parse_ms":0,"db_queries":0,"db_bytes":0}
```

不含 query、header、body、原始 path、user 或 token。这里用 `console.log(JSON.stringify(...))` 而不是 `createLogger`：后者的 INFO 才走 stdout（WARN/ERROR 走 stderr）、带人读前缀使一行不是一个 JSON 对象，且在 `initLogPersistence()` 之后每条都会 `appendFileSync`，等于在请求路径上做同步磁盘 IO。

**每分钟汇总**（`api_minute_summary`，同样只写 stdout、不写 DB、不做同步 IO）：

```json
{"event":"api_minute_summary","ts":"2026-09-24T11:14:54.369Z","window_ms":5001,"requests":3,"status_5xx":0,"slow":3,"dropped":0,"db_busy_pct":0,"db_queries":0,"event_loop_lag_max_ms":2.7,"role":"all","routes":[{"method":"GET","route":"/health","count":1,"p50_ms":1.3,"p95_ms":1.3,"sum_ms":1.3}]}
```

- 数据源是固定容量的内存环形缓冲区（typed array，route 字符串 intern 成整数 id）。写满后覆盖最旧样本并把次数记进 `dropped`，缓冲区不随流量增长。
- `routes` 按 `sum_ms` 取前 N（默认 10）。分位数用最近秩法，与 [bench-task-list-pagination.ts](../../tests/manual/bench-task-list-pagination.ts) 和 API baseline 脚本一致，因此这些数字可以和既有报告对照。
- `db_busy_pct` = 该窗口内**进程级** DB 阻塞时间 / 窗口时长。进程级计数包含没有请求上下文的调用，所以后台 job 的 DB 时间也算进去，这正是「DB 忙碌占比」需要的分母口径。
- `event_loop_lag_max_ms` 用 250 ms 间隔的 `setInterval` 漂移测量并取窗口内最大值；同步 PG 桥阻塞主线程时会直接体现为晚 tick。
- `role`（MUL-461）= 该进程的 API 角色，取值 `all` | `ui` | `runtime`，来自 `MULTIREMI_API_ROLE`（默认 `all`）。两类日志事件都带这个字段，所以两个容器共用一个日志流时仍能分开看：`jq 'select(.event=="api_minute_summary") | {role, ts, event_loop_lag_max_ms, db_busy_pct}'`。同一次拆进程另一条分进程依据是 MUL-405 加的 `pid`；两者互不替代（重建容器后 `pid` 会变，`role` 不会）。字段只描述本进程角色，不是请求属性。

**PG 桥回包护栏**（MUL-386 C.1）。同步桥的单次回包体积直接决定主线程被阻塞多久，所以除了慢请求日志之外，桥本身对超体积回包有两条独立规则：

- 单次回包 `len > 1 MB` 时输出一行 `api_large_db_reply`，只带路由模式、方法与字节数：

```json
{"event":"api_large_db_reply","ts":"2026-09-26T09:12:03.771Z","method":"GET","route":"/api/knowledge/submissions","bytes":12085257}
```

- 单次回包超过硬上限时在 `TextDecoder`/`JSON.parse` **之前**抛错，并输出一行 `api_db_reply_rejected`（字段同上，另加 `max_bytes`）。消息形如 `postgres reply of N bytes exceeds M bytes bridge limit; paginate or project columns`。
- **默认关闭**（MUL-386 裁决）：`MULTIREMI_PG_REPLY_MAX_BYTES` 未设置、空串、非数字或负数都解析为 `0`，即不设上限；`8388608`（8 MiB）是 MUL-398 落地后的目标值，不是当前默认。现有兜底是桥自身的 64 MB 共享缓冲（`postgres.ts` 的 `RESULT_BUFFER_BYTES`，超限由 worker 直接回错）。
- 测试套件反向配置：`bun test` 的 preload（[hermetic-env.ts](../../tests/setup/hermetic-env.ts)）在剥离宿主 `MULTIREMI_*` 之后固定设置 `MULTIREMI_PG_REPLY_MAX_BYTES=8388608`，让护栏在 CI 里继续抓无界读——它已经抓到过 `/tasks/pending` 读整张任务表。生产默认与测试默认是分开的两件事，改动其一时 [hermetic-env-policy.ts](../../tests/setup/hermetic-env-policy.ts) 的 `HERMETIC_ENV_DEFAULTS` 与架构守卫会一起失败。
- 两条日志与 `api_slow_request` 共用同一套脱敏口径：只有路由模式、方法、字节数，没有 SQL 文本、参数、原始 path 或 query。没有请求上下文的后台任务记为 `<background>`。
- 硬上限的错误消息会向上冒泡，可能进入 HTTP 响应体，因此 `PgBridge.exec` 不为它拼接 SQL 片段（其它错误仍会追加 SQL 前 400 字符用于排查）。
- 翻转默认的条件（MUL-398 验收）：A 类 repository-wikis 两条 `SELECT r.*` 改列投影、B 类 task messages 改有界读并各自发版后，观测一周 `api_large_db_reply` 中 `bytes > 8388608` 的路由集合为空，再把默认值改为 `8388608` 并同步本文与 env 示例。

**已知未修的大回包路径**（生产只读复核，MUL-386 评论 `cmt_cecxmzj19eea`），也是上面「默认关闭」的依据：`repositoryWikiObservability` 的 `SELECT r.* FROM multiremi_autopilot_runs`（单 workspace 约 12.2 MB）与 `listLatestRepositoryAutopilotRuns`（约 10.8 MB），都用于 `GET /api/workspaces/:id/repository-wikis`；不带 `since_seq` 的 task messages（单任务最大约 22.7 MB，28 个任务超过 8 MB），对应 `/api/tasks/:taskId/messages` 与 `/api/multiremi/tasks/:id/messages`。另有两条当前量级未触线但同为无 LIMIT 整读、长期需投影的路径：`ProjectsRepo.listProjectDocsForMigration` 与 `RepositoryWikiRepo.listWorkspace`。

**环境变量**（都在 [api.env.example](../../deploy/docker/api.env.example) 有登记）：`MULTIREMI_API_ROLE`（`all` | `ui` | `runtime`，**默认 `all`**；未设置、空串和无法识别的值都解析为 `all`，也就是 main 的行为。`ui` 只服务页面请求、对 `/api/daemon/*` 返回 421，`runtime` 只服务 daemon 协议 `/health*`、`/readyz`、`/healthz`、`/internal/*`、其余全部 421。注意 `/api/daemons/:id` 复数前缀是浏览器路由；实现与守卫表见 [api-role.ts](../../packages/server/src/config/api-role.ts)）、`MULTIREMI_REQUEST_METRICS`（默认开，`0/false/off` 整体关闭，关闭后不加响应头也不写任何日志）、`MULTIREMI_SLOW_REQUEST_MS`（默认 500，设 0 可让每个请求都打一行，适合短时冒烟）、`MULTIREMI_METRICS_SUMMARY_INTERVAL_MS`（默认 60000）、`MULTIREMI_METRICS_SUMMARY_TOP_N`（默认 10）、`MULTIREMI_METRICS_BUFFER_SIZE`（默认 4096）、`MULTIREMI_PG_REPLY_MAX_BYTES`（**默认 0 = 关闭**；未设置/空串/非法值也视为关闭。设成 `8388608` 才启用 8 MiB 硬上限，MUL-398 落地后才是目标默认）。
上述五项请求指标设置同时管 `ws_minute_summary`，见下一节。

**观测与验证入口**：

```bash
# 生产容器里的四类日志（209 上的 API 容器）
docker logs multiremi-platform-app-api-1 | grep api_minute_summary
docker logs multiremi-platform-app-api-1 | grep api_slow_request
docker logs multiremi-platform-app-api-1 | grep api_large_db_reply
docker logs multiremi-platform-app-api-1 | grep api_db_reply_rejected

# 单元测试：并发归属、Server-Timing 格式、慢请求日志脱敏、汇总器、桥回包护栏
bun test tests/unit/multiremi/request-metrics.test.ts

# 真实 HTTP 冒烟：起一个本地实例，读 Server-Timing + 两类日志
bun run tests/manual/smoke-request-metrics.ts
```

冒烟脚本默认用 0 ms 阈值和 5 s 汇总间隔以便一次跑完就同时看到两个事件；`MUL367_SMOKE_PORT` / `MUL367_SMOKE_SUMMARY_MS` 可覆盖。它只连 127.0.0.1 的临时实例和内存 SQLite，不读凭证、不碰生产。上线后需要真实基线数字时，按本文档开头「复现顺序与记录」的模板记录环境、并发和样本数，**不要**把本页的示例行情当作实测结论。

## WebSocket 帧汇总：`ws_minute_summary`（MUL-417）

daemon 的流量从 HTTP 轮询搬到协议 v2 的 socket 之后，它的 DB 时间不再落在任何 HTTP 路由上，
逐路由的口径会看不到这一段。`ws_minute_summary` 就是把 daemon 的那份**按帧类型**补回来。

**它不报进程级 DB 总量，两者也不能相加。** 进程级计数器（`db_busy_pct` / `db_ms` /
`db_queries`）只在 `api_minute_summary` 里出现一次；它统计的是**所有**跨 PG 桥的语句，本来就
包含 WebSocket 帧处理期间发出的那些。也就是说换通道不会让 `db_busy_pct` 下降——同一份 DB 工作
只是换了归属。两行相加会把同一批语句算两遍，这正是这一版把 WS 侧总量字段删掉的原因。

- **实现**：[api/daemon-protocol/metrics.ts](../../packages/server/src/api/daemon-protocol/metrics.ts)。
  固定容量的 typed-array 环形缓冲区，帧类型 intern 成整数 id；写满后覆盖最旧样本并记进
  `dropped`，缓冲区不随流量增长。
- **同一个窗**：窗口参数（开关、间隔、前 N、缓冲容量）由 HTTP 那一份配置派生，不在 WS 侧再读一次
  环境变量。两者独立解析时，只要有一方被显式覆盖（`startMultiremiServer({ requestMetrics })`，
  测试与冒烟脚本都这么做）就会错位。两行并排读时窗口才能对齐。
- **归因**：每条帧按**帧类型 + 方向**汇总 `count / db_ms / db_queries`，另带 `violations`
  （超长帧、未知帧、无法解析的帧）。`db_ms` 是处理该帧前后进程级计数器的差，所以它回答的是
  「这段时间的 DB 时间大致归哪个帧类型」。**它只是归因参考**：进程计数器是同步的，异步帧会在两个
  采样点之间混入并发工作，因此不要把它当成进程总量的分解，也不要和 `api_minute_summary` 相加。
  A-8 的 DB 阻塞报告用 `api_minute_summary` 的进程级 `db_busy_pct` 做前后对比，本行只做归因。
- **不写内容**：与 `api_minute_summary` 一样只写 stdout 的一行 JSON，不含 query、header、payload、
  原始 path、user 或 token；帧类型是唯一的字符串来源。

```json
{"event":"ws_minute_summary","ts":"2026-09-27T13:02:11.482Z","window_ms":2001,"frames":4,"dropped":0,"types":[{"type":"hb","direction":"uplink","count":3,"violations":0,"db_ms":0,"db_queries":0,"p50_ms":0.3,"p95_ms":2},{"type":"hello","direction":"uplink","count":1,"violations":0,"db_ms":0,"db_queries":0,"p50_ms":1.5,"p95_ms":1.5}]}
```

`types` 按 `db_ms`、`db_queries`、`count` 排序，取前 N（默认 20，且不低于 HTTP 侧的 N）；分位数用
与 [bench-task-list-pagination.ts](../../tests/manual/bench-task-list-pagination.ts) 相同的最近秩法。
空闲窗口同样每分钟一行，`frames: 0`，这样「没有 daemon 流量」和「这条线死了」可以区分。

**观测与验证入口**：

```bash
# 生产容器里同时看两条汇总线
docker logs multiremi-platform-app-api-1 | grep -E 'api_minute_summary|ws_minute_summary'

# 单元测试：汇总口径、环形缓冲、计时器、脱敏
bun test tests/unit/daemon/daemon-protocol-metrics.test.ts

# 真实 socket 冒烟：起一个本地实例，握手 + 3 个 hb，读两条汇总线（两者各自一条，不可相加）
bun run tests/manual/smoke-ws-minute-summary.ts
```

与 `api_minute_summary` 一样，上面示例行里的数字是冒烟运行的输出，不是生产基线。

## 页面测速脚本与基线（MUL-367）

[frontend/scripts/perf/page-speed.ts](../../frontend/scripts/perf/page-speed.ts) 用仓库既有的 `@playwright/test` 打开主要页面，记录每页的就绪时间、API 调用数、API 字节、最慢 API 及 `Server-Timing`。它**不是** e2e 套件，位于 `frontend/e2e` 之外，不会被默认 e2e 扫到；依赖已有 `@playwright/test`，不新增依赖。

**只读保证**：脚本在 `page.route('**/api/**')` 里阻止所有非 GET/HEAD 请求，所以它可以在生产上对着真实账号跑。打开 inbox 页面本身不会写数据（实测 0 个写请求）；点击某一行会触发 `POST /api/inbox/:id/read`。每次运行还会先做一次护栏自检（对 `/api/inbox/unread-count` 发 POST，必须被阻止），自检结果是报告的一部分——否则“页面从未写数据”和“护栏静默失效”无法区分。

### 允许表：一个被 fulfill 而不是被 abort 的端点

写请求只有一条被放行（允许表），读响应有两处改写（`meta.inboxResponseRewrites`）：

| 改写 | 作用 | 为什么 |
| --- | --- | --- |
| `target-injection` | 在 deeplink 轮把探测到的目标条目并入浏览器收到的**无 cursor 第一页**响应，并从有 cursor 的页里删掉它 | 生产首页只覆盖数小时，只看首页会让 deeplink 整天选不到目标；而把翻页放进测量窗口会让 `readyMs` 混入「目标有多旧」（MUL-384 `cmt_lkj0gsgtkfey`）。并入位置不影响渲染顺序：页面按 `created_at` 分组排序 |
| `read-state` | 把已桩过的 id 标成 `read: true` | `useMarkInboxItemsRead` 没有 `onSuccess`，只有 refetch 回来的 `read` 为真，重试循环才会停 |

[frontend/scripts/perf/lib/stub-writes.ts](../../frontend/scripts/perf/lib/stub-writes.ts) 维护一张显式允许表，目前只有一项：

| 方法 | path | 处理 | 为什么 |
| --- | --- | --- | --- |
| `POST` | `/api/inbox/:id/read` | 在浏览器内 `route.fulfill(200)`，响应体取本次 context 见过的该 item 且 `read: true` | 点中任何未读通知都会自动触发它；abort 之后前端会 `POST → abort → 回滚 → refetch → 再 POST` 循环 55–100 次，把 `?issue=` 的提交从 181ms 拖到约 5s（209 实测，MUL-384 `cmt_cxrxocj4vp3q`） |

- **生产仍然零写入**：`fulfill` 不出浏览器。允许表改变的是「一律 abort」这个手段，不是「生产只读」这个目的。
- 同一 context 内改写 `GET /api/inbox/page*` 与 `GET /api/inbox` 的响应：先 `injectInboxTarget`（仅 deeplink 轮），再 `rewriteInboxReadState`。`unread-count` / `summary` 不改写（只影响角标）。两个改写都是纯函数、都不修改输入对象，各有单测。deeplink 轮对所有 inbox 读态请求一律 `route.fetch()` + fulfill（不只等到有桩之后），这样每轮的固定开销一致；其他场景保持原行为。
- **计数分列**：被 abort 的仍计入 `blockedWrites`（MD/HTML 列名「拦截写请求」），被允许表接管的计入 `stubbedWrites`（「桩写请求」），两者不混。每轮与聚合严格相等（读 collectors 之前先冻结页面路由）。
- **新自检**：每轮 `stubbedWrites` 不得超过 `2 ×` 目标所在行的未读 id 数（一次成功 + 至多一次重试）。超过说明改写没生效、循环仍在，该轮记 `error: stub-loop-not-terminated` 并结束。非 deeplink 轮的未读数为 0，因此不得出现桩写请求。
- **验收口径（§2.9 修订）**：`blockedWrites` 全部为 abort；`stubbedWrites` 只含 `/api/inbox/:id/read`，且每轮次数不超过 `2 × 未读 id 数`。`meta.stubbedWriteAllowList` 记录当前允许表。
- URL 断言窗口 10s，只用于检查「点对了行」，**不参与 readyMs**；每轮记 `urlCommitMs`。

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
| path 脱敏 | 去掉 query；ID 形状的段换成 `:id`；已知的 workspace id / slug / member id 按值掩码，否则 `local`、`remi` 这种没有形状特征的标识会漏出去。`<前缀>_` 规则接受后缀里的**字母、数字、下划线**（`iss_zerojump_short`、`iss_local_long` 这类手写 fixture id 与生成 id 归一方式一致）；下划线不是静态路由段的字符——`scripts/api-routes.golden.json` 的 307 个静态段无一含下划线，所以宽化后的规则不会吞掉真实路由 |
| 环境参照 | 运行前后各采 7 次 `/api/config`，记中位耗时。生产是共享环境，复跑对比前先核对这个参照 |

今天的生产基线是 [reports/performance/MUL-367-page-speed-baseline-2026-09-24.json](../../reports/performance/MUL-367-page-speed-baseline-2026-09-24.json)（原始数据）、同名 `.md`（表格）与同名 `.html`（自包含单文件，可直接挂到 Issue 评论）。运行机器、Chromium、API 版本与护栏自检结果都写在报告的 `meta` 里。**明天复跑必须在同一台机器上**，否则机器差异会混进前后对比。

采集当天生产本身处于劣化状态：运行前后各 7 次 `/api/config` 的中位耗时是 1886 ms / 3735 ms（同一窗口里还混着 1.2–2.7 s 的样本，说明不是链路固定延迟，而是服务端在排队）。11 个页面里有 1 次 `issues` 加载在 60 s 就绪等待内没有满足口径，报告把它标出来且不计入中位数。因此这组数字是**劣化态记录**，既不能当稳态性能，也不适合直接拿来定优化目标。改报告格式时只能重新采集——MUL-384 重写后的脚本不再提供「只重渲染已有 JSON」的开关，JSON/MD/HTML 三份产物是一次运行一起写出的。

### 已定口径（MUL-383 待决项 A1/A2/B4，2026-09-27）

| 项 | 决定 | 落点 |
| --- | --- | --- |
| A1 入口页安静 | **默认开启**：warm 轮点击前等入口页 500 ms 内没有新的 `/api/**` 请求开始，上限 5 s，超时照点并记 `entrySettled=false`；同时记录点击时在途数 `entryInflightAtClick`。`--entry-quiet-ms` 保留，默认 500，传 0 关闭；上限是常量 `ENTRY_QUIET_CAP_MS` | `lib/options.ts`、`page-speed.ts`；`meta.entryQuietMs/CapMs` |
| A2 09-27 基线 warm 行 | **作废**（时基错误），cold 行保留。不改原始报告文件；本 PR 合入后由 QA 低峰重跑 n=5。`--compare` 对 schema 2 的 warm 行**只警告、不配对**：`comparable: false`、数值全 null、表格显示「不可比（schema 2 warm 已作废）」 | 见下节「基线有效性」与「输出与复核方式」 |
| A3 长样本 | 前后对比固定 MUL-70（`--issue-long` 默认值不变）；「长（≥200）」语义由 MUL-454（`iss_o2skonppbq2u`）承担，新增 `detail-xlong` 场景并把该单加进 running 目标的排除名单 | `lib/options.ts`、`page-speed.ts` |
| B4 高峰验收窗口 | **只看 13–14 点**，不要求 20–21 点 | 本页与父单验收口径 |

### 基线有效性

2026-09-27 的低峰基线（`reports/performance/` 与 `.mul383-evidence/perf/MUL-383-baseline-offpeak-2026-09-27.json`，`schema: 2`）里 **15 行 warm 数据无效**：`readyMs`、首屏请求数与串行深度都从**入口页文档**开始累计，没有减点击时刻 `navStartMs`，量的是「从一个还在加载的页面切走」。**cold 行有效**，两边都以文档 origin 起算。原始 JSON/MD/HTML 保持原样不改写，读取时按 `meta.schema` 判断。修正后的口径从 `schema: 3` 开始，warm 数字由 QA 低峰重跑 n=5 产出。

S9-0.1（2026-09-28）之前的两处同样按「旧报告照原样保留、读取时按版本判断」处理，**不升 `meta.schema`**：

- **`dbq` 一栏不可用。** 采集器把浏览器解析过的 Server-Timing 拼回字符串时，对只有 `desc` 的指标也写上了浏览器合成的 `dur=0.0`，`dbq`/`dbb` 于是全部读成 0。**`total`/`dbms`/`dbp` 不受影响**（它们本来就走 `dur`）。S9-2 的验收看 `dbq`，所以该修正之前（含 2026-09-28 凌晨那份上线前参照 `cmt_wahkjyxosv33`）的报告里 `dbq`/`dbb` 一律当作缺失，不要与修正后的数字比较。
- **`page-issues::warm` 一行不作数。** 它从 issues 列表进入再点侧栏的 issues 链接，是同页点击，量的是它已经打开的那一页。修正后该行改为从 inbox 进入；其余十个 `page-*::warm` 行入口不变，可继续配对。

## 内容到最终位置的口径（MUL-384 / MUL-383 S1）

MUL-367 的脚本量的是「H1 出现、骨架归零」，因此它看不见内容先出现、随后被顶开的过程。[frontend/scripts/perf/page-speed.ts](../../frontend/scripts/perf/page-speed.ts) 现在按父单（MUL-383）口径重写：终点是**内容停在最终位置**，跳动单独计数。MUL-367 的 profile（11 个页面）保留为同一脚本里的列表场景。

### DOM 契约：五个属性

应用侧只加属性、不改行为。前四个由 S1 打标，后两个由共享 hook `useAnchoredReveal` 写入：

| 属性 | 宿主 | 取值 | 写入方 |
| --- | --- | --- | --- |
| `data-perf-scroll` | 被测量的滚动根：issue 详情、chat | `issue-detail` \| `chat` | S1 打标 |
| `data-perf-item` | 真实数据行（timeline 行、chat 消息、issue 行、board card、inbox 行、子单行） | `comment` \| `activity` \| `resolved-bar` \| `message` \| `issue` \| `inbox` \| `sub-issue` | S1 打标 |
| `data-perf-key` | 同一行 | 行自身的稳定 id | S1 打标 |
| `data-perf-anchor` | 该页面口径的终点元素 | `latest-comment` \| `agent-stream` \| `target-comment` \| `latest-message` | S1 打标 |
| `data-perf-state` | `data-tab-scroll-root` | `pending` \| `ready` \| `ready-forced` | `useAnchoredReveal`（[frontend/packages/views/common/use-anchored-reveal.ts](../../frontend/packages/views/common/use-anchored-reveal.ts)），S1 与 `useStickToBottom` 不写 |
| `data-perf-fresh` | 同上 | `0` \| `1` | 同上；消费方传 `fresh`（`undefined` 时不写并移除该属性） |

`data-perf-state` 是**只读**契约：S1 应用侧不写它（没有 hook 就写死 `ready` 是假数据，会让 S7 的断言空过）。记录器在浏览器内用 `MutationObserver` 抓它的变化时间戳，不从 Node 侧轮询；属性不存在时 `appReadyMs` 为 `null`，且**永远不作为终点**。写入方无权改名、改宿主或改取值。

`data-perf-fresh` 是**新鲜度**位，只有 `useAnchoredReveal` 写它，消费方传 `fresh`；`undefined` 时不写并移除该属性（今天 main 上还没有任何消费方传它）。记录器按「属性在不在」分两套口径：

- **属性存在**时，只有 `data-perf-state = ready` **且** `data-perf-fresh = 1` 的帧才算加载完成；`ready` 但 `fresh = 0` 不算，`ready-forced` 也不算通过，但会在报告里**单独列出**（`appReadyForced`）。
- **属性不存在**时，维持原逻辑（只看 `data-perf-state`），所以 MUL-443 上线前后同一份清单都可用。

### 判定口径

| 项 | 口径 |
| --- | --- |
| 终点 | 详情/深链：anchor（agent-stream 优先，否则最新一条评论；深链为 target-comment）可见 + 骨架 0 + 之后 500 ms 无移动帧。列表：区域内无骨架且至少 1 个真实行可见 + 500 ms 安静。chat：最新一条消息可见 + 500 ms 安静 |
| 超高行 | 行高 > 根高时，`covers`（top ≤ 1 且 bottom ≥ 根高 − 1）或 `bottomVisible`（0 ≤ bottom ≤ 根高 + 1）任一成立即算可见；`target-comment` 为 `topVisible \| (tall && covers)`，因为 `scrollIntoView({ block: "center" })` 会把超高目标的顶边推出视口。每轮在就绪帧记原始 `anchorRectAtReady: { top, bottom, height, rootHeight }`（根相对坐标，只记数不下结论） |
| 列表页滚动根 | 11 个列表页既没有 `[data-tab-scroll-root]` 也没有自己 `data-perf-scroll`，两种模式都以 `[data-slot="sidebar-inset"]`（MUL-367 的 `READY_SELECTOR`）为根；空 chat 的 legacy heading 规则也用这个回退根（它渲染 `EmptyState`，没有 chat 滚动根） |
| 跳动 | 首次出现真实内容之后，相邻帧中同一 `data-perf-key` 的可见行位移 > 1 px（或 scrollTop 位移 > 1 px）即移动帧；连续移动帧合并为**一次**跳动。`jumps = 0` 才合格 |
| readyMs | 取 500 ms 安静窗口的**起点**，不是终点 |
| 超时 | 单轮 20 s；超时轮记 `readyTimeout`，**不进任何分位数** |
| 分位数 | 最近秩法，与 API baseline / `bench-task-list-pagination.ts` 一致 |
| 冷启动 | `page.goto` 整页加载，全新 context；时基是文档 origin（`navStartMs = 0`） |
| 应用内切页 | 先 hover 150 ms，再真实 click；`navStartMs` 取**页面内记录的 click 时间戳**（避免 CDP 往返误差）。warm 轮的帧、跳动、`Server-Timing` 与首屏集合**一律先减 `navStartMs`**，即全部从 click 起算 |
| 入口页安静（**已定口径**，`--entry-quiet-ms`，默认 500 ms） | warm 轮在点中行出现之后再等「入口页 500 ms 内没有新的 `/api/**` 请求开始」，上限 5 s；超时照点并记 `entrySettled=false`，同时在途请求数记 `entryInflightAtClick`。`--entry-quiet-ms 0` 关闭（回到「行一出现就点」的旧行为）。依据：MUL-383 待决项 A1，2026-09-27 答复；`meta.entryQuietMs` / `meta.entryQuietCapMs` 记录本轮实际用的阈值与上限 |
| 首屏集合 | `startMs ≥ navStartMs` 且不晚于就绪帧的 `/api/**` 请求；`apiCallsTotal`、chunks 共用同一下界，所以入口页的尾请求不计入目标页 |
| 串行深度 | `wave = 1 + max(wave(p) \| p.responseEnd ≤ start + 8ms)`；`Server-Timing` 从 resource timing 同源读取。口径未变，只多存 `serialChain` 与逐请求 `wave/after` |
| gap | `gapMs = 客户端 duration − Server-Timing total`，即请求在 handler 之外等待的部分（连接与排队）。服务端没有 `total` 时为 null |
| 深链目标 | 冷启动与应用内切页用**同一条**首屏通知。候选从探测窗口（最多 `--inbox-probe-pages` 页 × `limit=100`）取，按 `issue_id` 归并（`?issue=` 命中的是该 issue 最新一条）；合格项必须非 ledger 类且同时有 `details.comment_id` 与 `details.issue_session_id`，其中当前没有 running task 的 issue 优先，其次按 API 顺序。选中的条目会被并入浏览器的第一页（见下节），所以四种场景测的都是「目标在首屏」。记 `{ issueId, issueIdentifier, inboxItemId, commentId, issueHasRunningTask, inboxApiPage, rowIndex, targetRead }`；都选不到则 `skipped: no-eligible-inbox-item`。`--inbox-item` 必须在探测窗口内，否则 `skipped: inbox-item-not-found-within-probe-depth` |
| 深链 URL | `/{slug}/inbox?issue=<issueId>&session=<issue_session_id>`。只带 `issue_id` 的通知走 `?issue=`（`inboxItemSelectionKind`），`?item=` 只属于 ledger 类通知，而 ledger 渲染 `AutopilotRunReport` 不测 timeline |
| 深链 warm | DOM 行序由 `inboxDomRowIndex`（`lib/selectors.ts`）给出：它 import `core/inbox/grouping.ts` 的 `deduplicateInboxItems → filterInboxItemsBySource(…, "all") → groupInboxItemsByDate`，取 `flatMap(g => g.entries)` 的下标。**API 数组下标不是 DOM 行号**：生产上首页 50 条经归并只剩 8 行，成功的 autopilot run 会合并成一行。**行号在点击前一刻重算**，且算在「真实第一页 + 注入目标」这份快照上——那才是浏览器渲染的列表。目标不在当前列表里时记 `skipped: warm-target-not-in-list`。点击后等 URL 的 `issue` 参数变成选中 issueId（`replace` 在 `startTransition` 里，异步提交，轮询上限 10s）并记 `urlCommitMs`；不匹配则立刻结束该轮并写 `error: deeplink warm: url issue=<实际值> expected <id>`。被点中行的文本记入 `clickedRowText`，用来核对点的就是目标 issue |
| 深链目标读态 | 候选在同等条件下**优先选未读**（所在分组条目里至少一条 `read=false`）。未读目标会走「自动已读成功 → refetch → 渲染」这条真实用户最常见的路径，而允许表保证它可完成；报告记 `targetRead` 与 `targetGroupHasUnread` |
| 目标深度 | `targetDepth: { timelineRequests, targetIndexFromLatest }`，从本轮已捕获的 `/comments` 响应计算，不额外预查 |

**warmup 也挂护栏**：`--warmup` 会访问每个被测路由，其中包含深链的 `?issue=` URL，而该 URL 会自动把目标标为已读。warmup 页与测量轮使用同一套护栏与允许表，否则预热会改变后续测量读到的 fixture 状态。

参数：`--base-url`、`--rounds`（默认 3）、`--window peak|offpeak`、`--name`、`--out`、`--compare`、`--selectors auto|contract|legacy`、`--only <prefix>`、`--warmup`、`--issue-short`（默认 `iss_in41j1x1dq66`，MUL-67）、`--issue-long`（默认 `iss_enbrunyg86jc`，MUL-70；**MUL-395 前后对比固定用这一条**）、`--issue-xlong`（默认 `iss_o2skonppbq2u`，MUL-454；≥200 条评论的 `detail-xlong`，传空串跳过该场景）、`--issue-running`（默认现场选取，排除 MUL-383 `iss_j67lb0r8djw4` 及其全部子单，以及 MUL-454 `iss_o2skonppbq2u`；选不到则 `skipped: all-running-issues-in-mul383-family`）、`--inbox-item`（默认在探测窗口内自动选取）、`--inbox-probe-pages`（默认 10）、`--hover-lead-ms`（默认 150）、`--entry-quiet-ms`（默认 500，0 关闭）。`targetSelection` 取 `auto | pinned | none`。

`detail-running` 的排除名单分两段：**叶子常量**（MUL-454 这条永不完成的夹具单，故意保持进行中且未指派，否则会被选成 running 目标）与**运行时拉取**的 MUL-383 子单（见 `lib/options.ts` 的 `EXCLUDED_RUNNING_ISSUE_IDS` / `EXCLUDED_RUNNING_ISSUE_PARENTS`）。

**场景矩阵新增 `detail-xlong`（MUL-454，≥200 条评论）**，与 `detail-long` 并列而不是替换它：MUL-395 的前后对比基线锚在 MUL-70，改掉 `--issue-long` 会让所有历史配对失效。已有场景 key 一律不改，`--compare` 的配对依赖它。

**测速数据**：cold 与 warm 用同一 fixture，且必须是**非 archived、非 cancelled** 的 issue，否则默认 `/issues` 列表不渲染 `ListRow`，warm 找不到入口。报告标注实际评论条数（按 timeline 里 `type === "comment"` 计数；`timelineEntries` 另记条目总数，两者不同）。warm 目标行不在首批渲染里时记 `skipped: warm-target-not-in-list`，不改走搜索或 archived 手风琴（那些不是 S3 的验收入口）。参考量级：short ≤ 20 条、long ≥ 41 条（把「首页 40 条 + has_more」的分页路径踩到）；MUL-249 之后打开路径成本与总条数基本无关，≥200 的口径由 S7 的 250 条 fixture 与 S6 深链覆盖。

**fixture 选择约束**：非 archived、非 cancelled，且 `completed_at` 为空或远新于归档 TTL。`issues-repo.ts` 的 `archiveEligibleIssues` 会把 `completed_at` 超过 TTL（约 72h）的 done / cancelled issue **自动归档**——MUL-353 就是这样在选定后几小时被归档的，于是 warm 找不到入口。脚本在跑之前对两个 fixture 各做一次只读预检，状态不对就直接输出 `skipped: fixture-archived` / `fixture-cancelled` / `fixture-unreadable`，**不再等满 20s**。`warm-target-not-in-list` 同样立即以 skipped 结束。
| 目标深度 | `targetDepth: { timelineRequests, targetIndexFromLatest }`，从本轮已捕获的 `/comments` 响应计算，不额外预查 |

**为什么深链不用固定 `inb_...`**：[inbox-page.tsx](../../frontend/packages/views/inbox/components/inbox-page.tsx) 对不在已加载页里的 `?item=` 会逐页 `fetchNextPage()` 直到找到，页大小 50；固定项在第 769 位左右 ⇒ 冷启动先串行拉约 16 页，测到的是翻页而不是深链落点。

### 选择器回退：contract / legacy

生产在本单合入并发布之前没有 `data-perf-*`，所以 [frontend/scripts/perf/lib/selectors.ts](../../frontend/scripts/perf/lib/selectors.ts) 维护两套选择器，`--selectors auto|contract|legacy`（默认 `auto`：页面存在 `[data-perf-scroll]` 即用 contract，否则 legacy）。**所有选择器都集中在这个模块里**，不散落在脚本各处。每一轮都记 `selectorMode`。

| 用途 | legacy 选择器 / 规则 |
| --- | --- |
| 滚动根 | `[data-tab-scroll-root]`；列表页用 `[data-slot="sidebar-inset"]`（见上） |
| timeline 行 | `[data-tab-scroll-root] [id^="comment-"]` |
| latest-comment | DOM 顺序中最后一个 `[id^="comment-"]` |
| target-comment | `#comment-<id>` |
| 骨架 | `[data-slot="skeleton"]` |
| issue 列表行 | `[data-slot="sidebar-inset"] a[href$="/issues/<issueId>"]` |
| inbox 行 | `section[aria-labelledby^="inbox-group-"] div[role="button"][tabindex="0"]`。**不可靠**：QA 在 209 上实测未加作用域的形式匹配到工具栏按钮（`cmt_3d2bb3s7ceeh`）；该表只保留给等价性比对，**不得用它驱动点击**，深链 warm 的行序由 `core/inbox/grouping.ts` 的纯函数给出 |
| agent-stream | **没有稳定钩子**，禁止用 class 选择器凑：legacy 下 `detail-running` 以 latest-comment 为 anchor，记 `anchorRule: legacy-latest-comment` |
| chat | 退回 `h1-no-skeleton`，记 `anchor: none` |

**等价性证明**不用比较两次运行的时间（噪声太大），而是比较**同一 DOM 上元素的同一性**：contract 模式的每一轮在就绪时刻同时用 legacy 表求值，记 `selectorEquivalence: { scrollRoot, anchor: same|differs, itemsContractOnly, itemsLegacyOnly }`，元素用 `===` 比较。两个门槛：

1. 本地端到端：除 `detail-running`（anchor 已知不同）外全部 `anchor: same` 且 `itemsLegacyOnly = 0`，否则不推送。
2. 209 上第一次 contract 运行（高峰基线或终验）由 QA 复核同一字段；不通过则对应场景的 legacy 基线标 `invalid` 并重跑。

两版基线按实际 `selectorMode` 如实标注；`--compare` 遇到模式不同**只警告不拒绝**。

**legacy 表的删除条件**：满足两条才删——S2 已合入，且已有一版 contract 模式的基线。删表时同步删掉本节这张表与 `selectors.ts` 里的 `LEGACY`。

### 深链目标：探测可以翻页，测量不翻页

探测轮按 `next_cursor` 读 `/api/inbox/page?limit=100`，最多 `--inbox-probe-pages` 页（默认 10，约最近 1000 条），在整个窗口上按「无 running → 未读优先 → API 顺序」排序取第一个合格目标。选中的条目随后被并入浏览器的第一页，所以 cold 与 warm 始终测「目标在首屏」这一种形态，全部进同一个 p75。

报告里 `inboxApiPage` 记目标来自第几页（供读者判断），`inboxInjected` 记真实首页是否本来没有它，`inboxPageRequestsBeforeStub` 记首个桩写之前浏览器发了几次 `GET /api/inbox/page`（预期 1）。真实首页若有同一 issue 且更新的**按 issue 选中**的通知，`?issue=` 会选中它而不是探测目标，该轮记 `skipped: inbox-target-superseded`；ledger 行按 `?item=` 选中，不参与这个判断。

### 场景矩阵与参数

详情页 `detail-short` / `detail-long` / `detail-running` / `deeplink` × {cold, warm}，外加 MUL-367 的 11 个页面 × {cold, warm}。

```bash
# 本地/生产只读基线（token 只从 MULTIREMI_QA_WEB_TOKEN 读）
bun run frontend/scripts/perf/page-speed.ts   --base-url http://n37-117-209.byted.org --rounds 5   --window offpeak --out reports/performance --name MUL-383-baseline-offpeak-<日期>

# 与另一份 JSON 对比：按 key + mode 配对（warm 行另按 key::mode::path 比 path）
bun run frontend/scripts/perf/page-speed.ts   --base-url http://n37-117-209.byted.org --rounds 5   --out reports/performance --name MUL-383-baseline-peak-<日期>   --compare reports/performance/MUL-383-baseline-offpeak-<日期>.json
```

### 输出与复核方式

JSON 用 `schema: 3`（MUL-395 S9-0 起）。相对 schema 2 的字段变化：

| 位置 | 字段 | 说明 |
| --- | --- | --- |
| `meta` | `schema: 3` | 时基与首屏集合口径变了，旧 warm 行不可直接对比 |
| `meta` | `entryQuietMs` / `entryQuietCapMs` / `entryQuietNote` | 本轮用的入口页安静阈值与上限；关闭时为 `null` |
| `meta` | `timeBase` | 冷/热各自的起算点（文档 origin / click） |
| `rounds[]` | `navStartMs` / `clickT` | 该轮的时间原点；cold 为 `0` / `null`，warm 为页面内 click 时间戳 |
| `rounds[]` | `entryReadyMs` / `entryInflightAtClick` / `entrySettled` | 入口页就绪耗时、点击时在途 `/api` 请求数、是否等到了安静窗口 |
| `rounds[]` | `serialChain` | 产生 `serialDepth` 的那条链，最深在最后 |
| `rounds[]` | `apiFirstScreenEntries[]` | 首屏逐请求：`{ path, method, wave, after, startMs, responseEndMs, durationMs, encodedBytes, serverTiming:{total,db,dbp,dbq,dbb}, gapMs }`。`startMs`/`responseEndMs` 是页面绝对时钟，减 `navStartMs` 即本轮相对时间；`after` 是同一张表里前驱的下标 |
| `stats` | `apiByPath[]` | 场景级按 path 聚合：每轮次数、`total` p50/p95、`db` p95、`dbq` max、`dbb` max、`gap` p50 |

`apiFirstScreen` 计数保留，与 `apiFirstScreenEntries.length` 应相等，可交叉核对。MD 与 HTML 每个场景多一张「首屏 API 表」（按 path 聚合），HTML 另把逐请求表按场景折叠；`--compare` 除原有的按 `key::mode` 配对表外，多一张按 `key::mode::path` 配对的差值表（只在单侧出现的 path 也列出，右列为空——「请求消失了」正是 S9-1 要证明的结果）。

JSON 里的 `compare` 段带 `warnings`：`selectorMode` 不同、`target.identifier` 不同、`targetSelection` 不同、`timelineRequests` 不同都会警告，但都不阻断配对。

**唯一阻断数字的是 warm 时基不匹配。** 基线 `meta.schema < 3` 时，它的 warm 行从入口页文档起算，而 schema 3 从 click 起算：`readyMs`、首屏数、串行深度、逐 path 的 `total`/`gap` 全都不是同一个量。这类配对：

- `compare.rows[]` 里 `comparable: false`，`notComparableReason` 写明原因，**所有数值字段为 null**——不是「渲染时藏起来」，读 JSON 的下游同样拿不到可减的数；
- `compare.pathRows[]` 里这些 `key::mode` 的每一行同样 `comparable: false`，**数值与 `n` 计数全为 null**——schema 2 的计数含入口页尾部请求（本轮下界正是把它去掉），半修正的数字不能与修正后的数字并排放；
- MD/HTML 的表格里这类行显示 `不可比（schema 2 warm 已作废）`，**不出现任何数字或差值**；
- 只保留一条「已作废、不可比」的警告，不再报选择器/目标之类的次级差异（无数字可解释）；
- 只出现在新一侧的 warm 行（例如 schema 3 才有的 `detail-xlong`）同样 `comparable: false`：基线那一半仍是作废的时基，单独打印新数字会被读成「对比的后一半」。该行自己的数字在场景的 `rounds[]`/`stats` 里（同一轮 schema 3 运行），不受影响；cold 行不在此列。

schema 2 的 **cold** 行两边都以文档 origin 起算，照常配对；两侧都是 schema 3 时 warm 行也照常配对。这条规则由单测固定，并用「临时恢复 warm 配对」的变异验证过会失败。

基线产物放 `reports/performance/`，HTML 用 `remi comment add --attachment` 同时挂到本单和父单。

本地端到端（不需要生产凭证）用 [tests/manual/mul384-perf-harness.ts](../../tests/manual/mul384-perf-harness.ts)：起内存 SQLite 的 API + 本地 web，铸造本地 PAT 注入 `MULTIREMI_QA_WEB_TOKEN`，跑完全部场景并 grep 产物确认 0 个 token 泄漏。**不要把生产凭证用于本地。** 它跑的是 `next dev`：首个访问的路由要现场编译（实测 `/[slug]/inbox` 首次 17.6 s），会撞 20 s 的单轮超时，所以 harness 传 `--warmup`，先对每个场景各访问一次再开始测量。**`--warmup` 只是本地 dev 服务器的让步**：209 跑的是构建产物，没有现场编译，生产基线的数字不含这一步。

## CI 零跳动检查（MUL-394 / MUL-383 S7）

[tests/integration/zero-jump-check.ts](../../tests/integration/zero-jump-check.ts) 把上面这套口径搬进 CI：内存 SQLite 起 API（`startMultiremiServer`，fixture 见 [tests/integration/zero-jump-fixture.ts](../../tests/integration/zero-jump-fixture.ts)：短 issue 3 条评论、长 issue 250 条含 20 个代码块与 5 张图片并分 3 个 session、一个带消息的 running task、一条指向长 issue 第 40 条评论的 inbox 深链），`next build` + `next start` 起 web，Playwright + Chromium 驱动同一个浏览器侧记录器，每行跑 3 次。**只断言结构量**（`jumps = 0`、anchor 完整可见、骨架为 0、就绪状态合格），不断言毫秒数。

两条容易踩的实现事实：

- **`REMOTE_API_URL` 是构建期烘焙的。** Next 把 `/api/*` 的 rewrite 目标写进 `.next/routes-manifest.json`，`next start` 时再设 env 不会改变它。所以检查必须**先固定 API 端口、再 build、最后 start**（写完第一版后才实测到：`next start` 带着新 `REMOTE_API_URL` 仍代理到 build 时的端口，所有 API 都是 500）。
- **深链冷启动的 URL 是 `/{slug}/inbox?issue=…&session=…`**，不是 `/issues/:id`。`highlightCommentId` 只在 inbox 面板里被传给 `IssueDetail`（`inbox-page.tsx`），因此 `target-comment` 这个 anchor 只在深链 URL 上存在；改成 issue 详情路由会让该 anchor 永远找不到。

### 已知失败清单与判定规则

曾经必然失败的行写在 [tests/integration/zero-jump-known-failures.json](../../tests/integration/zero-jump-known-failures.json)：**行 = `<场景 key>::<cold|warm>`**（沿用 `report.ts` 里 `--compare` 的配对键），每行显式列出它还被允许出现的违例类型（`jumps` / `anchor` / `skeleton` / `perf-state`）。判定是纯函数（[lib/zero-jump-verdict.ts](../../frontend/scripts/perf/lib/zero-jump-verdict.ts)），四条规则：

1. 行不在清单，出现任何违例 → 失败。
2. 行在清单，出现该行没列出的类型 → 失败（「已经过的部分」由此立刻受保护）。
3. 行在清单，某个列出的类型 3 次都没出现 → 失败，提示从该行删掉这个类型、类型删空就删整行。只出现 2/3 次不触发。
4. `--strict` 忽略清单，所有行都按规则 1 判。

**清单对冻结基线的方向是单向的：只能收紧，不能放宽。** `allowlistWithinBaseline()`（[lib/zero-jump-verdict.ts](../../frontend/scripts/perf/lib/zero-jump-verdict.ts)）逐行检查：清单里的 `key::mode` 必须出现在 strict 基线报告里，且该行的 `violations` 必须是基线中该行类型的**子集**；少行、少类型都允许。反向（新增一行、给已有行加一个基线里没有的类型）会失败。

- 收紧（修好一个类型就删掉它、类型删空就删整行）**不需要**改基线报告，单测保持绿——这正是规则 3 要推动的动作，由「清理者」在修复合入的 PR 里顺手做掉。
- 要**新增**行或类型，必须在同批提交里附上新的 strict 报告（`reports/performance/MUL-394-zero-jump-strict-main-<日期>.json`），并更新 `tests/unit/scripts/zero-jump-verdict.test.ts` 里引用的基线路径。否则棘轮会拦住它。

「与当轮运行是否一致」由检查本体在每次 CI 运行时判定（规则 a–c，`judgeZeroJumpRun`）；单测只防清单超出基线，不重复前者。规则 3 只在默认模式生效——它就是「MUL-443 / MUL-393 修好之后顺手清掉自己那几行」的机制。

**清单现在是空的**（MUL-390，2026-09-27）。`useAnchoredReveal` 接入详情页后，9 行在 strict 下全部 0 违例，于是按规则 3 删掉整份清单，删空的记录留在 `tests/integration/zero-jump-known-failures.json` 的 `empty` 字段里。此后任何一行出现任何违例都会按规则 1 直接让 job 变红；新增行必须同批附新的 strict 基线报告。`rows` 为空是清单的终态，`tests/unit/scripts/zero-jump-verdict.test.ts` 里对应两处「行数必须为正」的断言因此删除（MUL-390 执行方案 2/3 的 R1）。

「localStorage 里有非默认侧栏布局」那一轮刻意用**独立的 `detail-long-sidebar::cold`**，不与 `detail-long` 共键：它触发的是另一条机制（[sidebar.tsx](../../frontend/packages/ui/components/ui/sidebar.tsx) 在 `useEffect` 里恢复宽度，首帧之后才改正文宽度），共键会让清单表达不了「长 issue 已修、侧栏轮还没修」。

**这一轮只跑 cold，不跑 warm。** 侧栏宽度是在整页加载时从 `localStorage` 恢复的；warm 轮先进的是列表页，那时侧栏已经按非默认宽度恢复好了，进入详情页不再发生宽度变化，因此 warm 轮等价于 `detail-long::warm`，测不到这个机制。QA 另起探针按同一记录器口径实测 3 次 warm（`sidebar_width=360`，真实点击进入长 issue）：`jumps = 0/0/0`、骨架 0、宽度三轮都保持 360（MUL-394 `cmt_48kfa37phg9x`）。结论一致，故不把 warm 加进矩阵。

### 运行方式

```text
bun run tests/integration/zero-jump-check.ts                      # 默认：清单模式，CI 门禁用
bun run tests/integration/zero-jump-check.ts --strict             # 忽略清单：证明「未修复代码上会失败」
bun run tests/integration/zero-jump-check.ts --only detail-long --rounds 1   # 单场景排查
```

`--skip-build` 复用已有 `.next`；`--api-port` / `--web-port` 固定端口（注意上面的构建期烘焙）；`--out` 指定报告路径。报告是记录器 JSON，含每轮 `jumps` / `anchorRectAtReady` / `skeleton` 数与清单判定结论。

**当前 strict 实测**（MUL-390 分支：`43d75571` + MUL-450 合入 main 后的 `3b2406e4`，3 次/行）存于 [reports/performance/MUL-390-zero-jump-strict-2026-09-27.json](../../reports/performance/MUL-390-zero-jump-strict-2026-09-27.json)：9 个 `key::mode` 行、27 轮全部 `jumps=0`、anchor 完整可见、骨架 0、`data-perf-state=ready`，没有任何 `ready-forced`。该 JSON 同时是 MUL-443 / MUL-444 / MUL-393 前后对比的「后」基线；本单合入 main 后它即 main 的 strict 基线。（报告里的 `commit` 是记录它时分支的 head。）

同一分支的默认（清单）模式在本地与 CI 各跑一次，都是 9 行 × 3 轮 0 违例：本地 [reports/performance/MUL-390-zero-jump-default-local-2026-09-27.json](../../reports/performance/MUL-390-zero-jump-default-local-2026-09-27.json)，CI 的 `frontend-zero-jump` job 产物 [reports/performance/MUL-390-zero-jump-default-ci-2026-09-27.json](../../reports/performance/MUL-390-zero-jump-default-ci-2026-09-27.json)。

**前基线**（`4248ef07`）仍存于 [reports/performance/MUL-394-zero-jump-strict-main-2026-09-26.json](../../reports/performance/MUL-394-zero-jump-strict-main-2026-09-26.json)：9 行全部失败，其中 8 行只有 `perf-state`，`detail-deeplink::cold` 另有 `jumps`（每次 1 跳、内容位移 8359.8 px、滚动 2450 px）。

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
| 仓库根 | `bun run tests/manual/bench-issue-detail-first-screen.ts --out <path>` | MUL-385 的 Issue 详情首屏三路由（`/api/issues/:id`、`/sessions`、`/timeline?issue_session_id=@default&limit=40`，外加只留档的 `/comments`）：每个路由的 `dbq`、db 耗时、**过桥字节**（按 worker 的 `JSON.stringify({ rows, count })` 口径模拟）、响应字节与 p50/p95，并附带 1/5/20 个 session 的查询数规模扫描和鉴权链查询数。fixture 是 MUL-307 规模（173 条评论 / 多个 session / 50+ task，见 `tests/fixtures/multiremi/issue-detail-first-screen-fixture.ts`）。默认内存 SQLite + `app.request()`；设置 `MULTIREMI_TEST_POSTGRES_URL` 指向可一次性创建的测试 PG 时改用真实桥，不可达时回落 SQLite 并在报告里注明。响应形状由 `tests/unit/multiremi/issue-detail-first-screen-query-count.test.ts` 对 golden 比对。改前数字用同一文件在父提交上运行。 |
| 仓库根 | `bun test tests/unit/multiremi/multiremi-store-issues.test.ts tests/unit/multiremi/multiremi-api-issues.test.ts` | 列表、搜索及 API 行为；功能测试不是性能基线。 |
| 仓库根 | `bun test tests/unit/multiremi/multiremi-api-search-inbox.test.ts` | 收件箱游标、摘要和原有读/归档契约；不产出性能数据。 |
| 仓库根 | `bun test tests/unit/multiremi/multiremi-postgres-store.test.ts` | SQL 翻译和真实 PG store 契约；`MULTIREMI_TEST_POSTGRES_URL` 指向可创建临时数据库的测试实例，**本地/Agent 会话必须显式设置，否则集成部分整片静默 skip**（CI 在 `release-build-check.yml` 的 backend suite 步骤显式声明），不可达时跳过并打印原因，须记录 skipped。 |
| 仓库根 | `MULTIREMI_TEST_POSTGRES_URL=postgres://… bun test tests/unit/multiremi/multiremi-task-list-postgres.test.ts` | MUL-357 的 PG 侧证据：迁移的两个分页索引真的建出且 `indexdef` 与 `ORDER BY created_at DESC, id DESC` 匹配、`EXPLAIN (ANALYZE)` 不出现 Seq Scan/全量 Sort、`?`→`$n` 的 status/游标/limit 绑定顺序、分页走遍后与未分页集合一致。UNSET 时默认落到 `postgres://multimira:multimira@localhost:5432/postgres`（即 CI service container），不可达时跳过并打印原因，须记录 skipped。 |
| `frontend/packages/core` | `bun run test issues/queries.test.ts issues/ws-updaters.test.ts realtime/sync/tasks.test.ts realtime/use-realtime-sync.test.ts` | 查询、精确缓存更新、实时排序/去重与刷新语义。 |
| `frontend/packages/views` | `bun run test common/task-transcript/build-timeline.test.ts common/task-transcript/agent-transcript-dialog.test.tsx` | 工具配对、子 agent 展示、终态和弹窗交互。 |
| `frontend/packages/core` / `frontend/packages/views` | 分别运行 `bun run test inbox/mutations.test.tsx` / `bun run test inbox/components/inbox-page.test.tsx` | 分页缓存 mutation、追加页、选择与折叠条目操作。 |

测量源码：[API baseline](../../scripts/bench-api-route-baseline.ts)、[报告渲染](../../scripts/render-api-route-audit-report.ts)、[搜索规模基准](../../tests/manual/bench-store-n-plus-one.ts)、[桥微基准](../../tests/manual/bench-pg-bridge-overhead.ts)。

## 复现顺序与记录

0. **高峰窗口（B4，2026-09-27 裁定）：只看北京时间 13–14 点这一个窗口**，不再要求 20–21 点；两个窗口的数字不可混在一张表里比较。低峰窗口沿用原定义。
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
