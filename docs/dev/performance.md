---
title: 性能热路径与基线采集
status: active
summary: 当前性能相关实现、必须保留的语义，以及复用现有工具采集可比较基线的方法。
---

# 性能热路径与基线采集

本页是 2026-09-05 对当前工作树的静态核查，不是历史架构决议。**本轮基线未测**：本次文档核对没有采集延迟、吞吐、CPU、内存或浏览器性能数据。下文区分已经存在的优化与待测成本；已有报告必须结合其生成时间、提交和环境判断，不能作为当前版本的实测结果。

## 三条优先关注的热路径

### 1. 任务列表：页面请求展开 → 列表与计数 → PostgreSQL 同步桥

- **实现事实：** [issues/queries.ts](../../frontend/packages/core/issues/queries.ts) 的 `fetchFirstPages` 用一次 `GET /api/issues/status-pages` 请求当前 [BOARD_STATUSES](../../frontend/packages/core/issues/config/status.ts) 的 6 个状态，每状态各 50 条、各自 total。各桶来自同一服务端读快照，第二页及以后仍用单状态列表和已加载条数作为 offset。[Store](../../packages/server/src/store/repos/issues-repo.ts) 在 SQLite 下显式使用 deferred 读事务，使其他连接可在 WAL 模式下提交写入；[事务包装](../../packages/server/src/store/request-read-cache.ts)仍为写路径默认使用 immediate，并为读事务保留缓存、提交后回调和回滚处理。PostgreSQL 使用 repeatable-read read-only 事务。列表 query key 与 `{ byStatus }` 缓存形状不变，失效后也使用分组首页。
- **实现事实：** `fetchAllMyFirstPages` 保留 assignee、creator、involves 三种人员关系的合并顺序和 issue ID 去重，因此“我的全部任务”的状态列表首次执行是 **3 个分组请求**，其他单一关系页签是 1 个。这是查询层请求数，不是页面总请求实测；缓存命中、重试和其他查询会改变网络记录。[MyIssuesPage](../../frontend/packages/views/my-issues/components/my-issues-page.tsx) 的负责人看板使用另一条 assignee grouped 查询分支，不能套用该数量。
- **实现事实：** 工作区列表显式请求 `include_archived_total=true`，用响应的 `archived_total` 更新原有归档计数缓存；计数订阅本身不发 HTTP。工作区负责人看板在其活跃的 `/api/issues/grouped` 响应中携带同一可选字段，避免订阅隐藏的状态列表。计数是整个工作区的归档总数，不受列表筛选影响；不传参数时服务端不额外 COUNT。API 返回 404 时，一个 API client 会记住不支持 status-pages，使用旧的逐状态请求；新会话重新探测。
- **实现事实：** [issues router](../../packages/server/src/api/routers/issues.ts) 的列表响应调用 `listIssues` 和 `countIssues`。[PgBridge.request](../../packages/server/src/store/db/postgres.ts) 使用 `Atomics.wait` 等待 worker，醒来后仍检查当前请求的完成状态，避免上一条请求的延迟通知暴露旧响应；多次唤醒共用原有 60 秒期限。worker 以 [Bun.SQL 的 `max: 1`](../../packages/server/src/store/db/pg-worker.ts) 保证事务语句共用连接。该限制是每个桥实例的连接数，不是整个部署只能有一个连接。
- **风险推断：** 并行 HTTP 请求无法自动消除主线程同步数据库等待；额外 SQL 往返和较大的响应序列化可能放大排队，影响同进程其他请求。吞吐拐点与 PostgreSQL 网络延迟的影响尚未测量。
- **采集重点：** 冷/热页面请求数量、单请求 SQL 数与响应 bytes、列表可操作时间，以及 API 并发升高时的 p50/p95、错误率和事件循环延迟。

### 2. 搜索：候选 issue → 逐 issue 搜评论 → 过滤与分页

- **实现事实：** [IssuesRepo.searchIssues / searchIssueCommentSnippet](../../packages/server/src/store/repos/issues-repo.ts) 先调用 `listIssues({ includeArchived: true })`；启用评论正文搜索时逐 issue 查询评论，再在 JavaScript 中筛 workspace、匹配字段、排序和截取页面。`includeCommentBodies` 默认启用，传 `false` 才跳过评论查询。
- **风险推断：** 工作量随候选 issue 数和评论体积增长，返回 20 条并不意味着只读取 20 条。当前步骤还会处理最终不属于目标 workspace 的候选；不能只看返回条数评估 SQL 与内存成本。
- **采集重点：** 用无命中词、标题命中词、评论命中词分别测量；固定目标 workspace，再增加其他 workspace 的数据，记录 SQL 次数、结果 bytes、p50/p95。真实用户可见结果与权限语义需保持不变。

### 3. 实时任务：SessionLog 与 trace → 展示与重连

- **实现事实：** Chat/Issue 正文由 [SessionReplica](../../frontend/packages/core/replica/browser.ts) 的 `log:` 流同步；运行中的工具摘要由 [use-task-trace.ts](../../frontend/packages/views/common/task-transcript/use-task-trace.ts) 分页读取 trace，并按 seq 合并实时帧。任务结束后不再占用 trace socket。
- **实现事实：** [createIssueHandlers](../../frontend/packages/core/realtime/sync/issues.ts) 做 issue 精确缓存更新；[createPrefixRefresh](../../frontend/packages/core/realtime/sync/prefix-refresh.ts) 排除已有专门处理器的事件。[TaskTraceDialog](../../frontend/packages/views/common/task-transcript/task-trace-dialog.tsx) 只在打开时读取完整 trace。
- **风险推断：** 长 trace 的分页、全数组派生与 DOM 成本仍可能随事件数增长；断线补读可能与当前帧追赶叠加。需要用请求数、长任务和 React commit 测量实际成本。
- **采集重点：** 固定事件数、平均文本长度、工具/子 agent 比例和每秒事件数；记录首次打开、滚动、实时追加与断线重连期间的请求数、长任务、React commit 时长与内存。

## Daemon 保活与事件唤醒边界

保活写入与业务变化通知分开：机器人相同状态报告仍更新 `reported_at`，SSH 相同状态心跳
仍刷新在线时间，但不会因此重建全工作区下行或空派活。SSH 端点/密钥轮换改变配置 revision
时继续下发整个 mesh。已知 Runtime 的 pending、模型和插件变化定向唤醒；任务输入仍保留
任务宿主与 bot 可能不在同机的接收范围。事件入口见
[workspace-wakeups.ts](../../packages/server/src/api/daemon-protocol/workspace-wakeups.ts)，
协议边界见 [daemon 协议](../daemon-protocol-v2.md)。

责任 resolver 只读取路由事实列，不水合 Issue 标签或 Agent Skills。活 AUQ 答复复用
事务锁保护的 Q 投影，卡片更新意图由答案事务写入一次；原回复路径已派生来源 Issue
时不重复派生。下行只为声明插件协议的宿主读取插件 desired 状态。

派活锁前使用 `getRuntimeLite`，锁后使用 `getRuntimeForDispatch` 保留模型、执行组和协议读取，
不计算历史用量。CLI 排空、重试时点、任务下发的宿主所有者信息与飞书卡片能力判断也不附带统计；用户侧统计继续使用
规范化台账的原查询。空派活仍有锁、资格和恢复检查，不能把“没有聚合”理解为“没有 SQL”。

成本检查要计入排队的下行和派活及 `WITH` 查询，不能在同步 heartbeat handler 返回时停止。
[多 Runtime 回归](../../tests/unit/multiremi/daemon-heartbeat-fanout-cost.test.ts)用 8 个 Runtime、
初始 0 个任务覆盖相同报告、真实变化、目标范围与活动记录；新增任务用例验证入队立即推送，
容量释放后在冷却到期前重试且只检查同一 daemon。默认 SQLite，显式
`MULTIREMI_TEST_POSTGRES_URL` 则创建并清理独立 PostgreSQL 测试库，连接失败不回落。
这是 SQL 成本与行为检查，不提供生产延迟、吞吐或恢复时间结论。

## 收件箱已具备的加载边界

- [InboxPage](../../frontend/packages/views/inbox/components/inbox-page.tsx)通过统一 `/api/inbox` 读取消息页、`unread_count`、`attention_count` 和 `next_cursor`；HTTP 每页默认 100、最多 500 条。计数覆盖当前读者游标之后的所有可见消息，正文只读取当前页。旧通知 selection/timezone 折叠不参与这两个计数。
- [listReaderMessageInbox](../../packages/server/src/store/inbox/operations.ts)在 SQL 中应用工作区、会话、私有来源及 Question 通知权限，再聚合计数和按 `created_at DESC, id DESC` 分页。定点通知的授权不会扩大其原私聊或执行轨迹的读取权；关联答复与编辑记录继承同一限制，不能在分页之后才去掉隐藏消息。
- [Question 通知过滤](../../packages/server/src/store/inbox/question-notification-visibility.ts)用 `CASE` 仅为处理/呈现通知执行关联原 Q 的查询。普通消息跳过该分支，保留 PostgreSQL 对原题、当前路由和实际通知执行范围的校验。功能、查询数及过桥字节边界由 [首屏回归](../../tests/unit/multiremi/first-screen-hotspots-inbox-attachments.test.ts)和 [通知权限回归](../../tests/unit/multiremi/question-notification-access.test.ts)检查；单次诊断耗时不作为生产延迟基线。
- 测量时分别记录首屏、追加页、较后页原问题定位、已读写入及 mutation/WS 失效后的刷新；默认页大小不代表一次页面交互的总读取量。

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

- 单次回包 `len > 1 MiB` 时输出一行 `api_large_db_reply`，不新增事件、不限频；带路由模式、方法、字节数以及配置阈值、例外与拒绝模式：

```json
{"event":"api_large_db_reply","ts":"2026-09-29T09:12:03.771Z","method":"GET","route":"/api/knowledge/submissions","bytes":12085257,"limit_bytes":8388608,"exempt":true,"enforced":false}
```

- 只有拒绝模式下，单次回包超过有效上限才在 `TextDecoder`/`JSON.parse` **之前**抛错，并输出 `api_db_reply_rejected`（`event/ts/method/route/bytes/max_bytes`）。消息形如 `postgres reply of N bytes exceeds M bytes bridge limit; paginate or project columns`。64 MiB 物理缓冲限制始终保留，worker 对超物理上限的错误不等于配置阈值拒绝。
- **阈值默认 8 MiB，拒绝默认关闭**（MUL-398 C-1，2026-09-28 贺华杰授权及 Senior 裁决 B `cmt_q2m2lomd48pm`）：`MULTIREMI_PG_REPLY_MAX_BYTES` 未设置或为空时是 `8388608`；显式 `0` 关闭配置阈值。只接受一个十进制整数（可带前后空格）；带换行、十六进制、科学计数、负数、小数或不安全整数都回落默认，在缓存解析时输出一行告警；除 env 原值外不带可变信息。显式非负整数按字节解释。
- `MULTIREMI_PG_REPLY_ENFORCE` 未设置、空或 `0` 时只告警；`1` 才拒绝表外超阈值回包。非法值回落到只告警，并输出一行只带原值的告警。C-2 翻转代码默认值需贺华杰当次授权，C-1 不在生产强制任何 HTTP 子集。
- `bun test` preload（[hermetic-env.ts](../../tests/setup/hermetic-env.ts)）剥离宿主 `MULTIREMI_*` 后设置 `MAX_BYTES=8388608`、`ENFORCE=1`，让无界读在 CI 暴露。阈值默认两边相等，拒绝模式测试显式开启；[hermetic-env-policy.ts](../../tests/setup/hermetic-env-policy.ts) 和架构守卫分别断言这两项，不能删除守卫。
- 过渡例外集中在 [request-metrics.ts](../../packages/server/src/observability/request-metrics.ts) 的 `DB_REPLY_TRANSITION_EXCEPTIONS`，键为 `METHOD route-pattern`，HEAD 按 Hono 分发使用 GET key，日志仍保留 HEAD。`exempt` 表示命中集中表（含独立 `<background>` 项），`enforced` 表示开关模式，`limit_bytes` 始终是配置阈值。有效上限：`exempt || !enforced || limit_bytes == 0` 时为 64 MiB，否则为 `min(limit_bytes, 64 MiB)`。`postgresReplyMaxBytes()`、桥拒绝和 MUL-462 分页共用该值；生产只告警时每页保持 8 行。配置缓存，每次查询只读一次上下文并查一次 Set；关闭指标仍保留路由上下文。
- 两条日志与 `api_slow_request` 共用同一套脱敏口径：只有路由模式、方法、字节数，没有 SQL 文本、参数、原始 path 或 query。没有请求上下文的后台任务记为 `<background>`。
- 硬上限的错误消息会向上冒泡，可能进入 HTTP 响应体，因此 `PgBridge.exec` 不为它拼接 SQL 片段（其它错误仍会追加 SQL 前 400 字符用于排查）。
- 原来「等待 MUL-402 和一周观测后做 C」已被授权替换。C-1 执行阈值翻转和观测机制，拒绝默认翻转挪到 C-2：读路径投影或写入限界后，生产单次数据至少三天（含工作日高峰）满足 <6 MiB，再申请贺华杰当次授权。D 的 Bun UA shim 不属于 C-1。发布冻结在 v0.2.83，不把代码默认值当作生产现状。

**例外来源与收回**：Explorer 的 MUL-398 `cmt_5ncm70lxe805` 确认 209 为 v0.2.83，没有单次回包埋点。零条事件不能作为安全证据。例外来源是 **18 条慢请求总 DB 字节 ≥6 MiB 的保守超集 ∪ 代码审计 ∪ `<background>` ∪ daemon POST messages / HTTP peer**。慢请求只覆盖 >500ms，`db_bytes` 是所有 SQL 回包的总和，不能当作单次回包；快请求由审计兜住。发布冻结期间合入前以 v0.2.83 慢请求总量再核对，含单次埋点的版本实际部署后再按路由逐条收回。

| 来源 | 例外 / 原因 | C-2 收回条件 |
| --- | --- | --- |
| 209 请求总量超集 | GET dashboard 的 usage/by-agent、agent-runtime、runtime/daily、usage/daily；GET knowledge/submissions、knowledge/runs；GET projects/:id/knowledge/recall、projects/:id/docs；GET workspaces/:id/repository-wikis；GET issues/:id、inbox、tasks/:id/inspection、tasks/:taskId/messages、multiremi/tasks；POST autopilots/:id/trigger、daemon/tasks/:taskId/fail、complete、daemon/runtimes/:runtimeId/tasks/claim。完整模式带 `/api/` 前缀，18 条全部保留 | 修复随同包或更早上线；有埋点的单次回包按路由 <6 MiB，至少三天并含一个工作日高峰；Explorer 只读复核，带头大哥派单逐条收回 |
| 审计 | 全量 task/chat messages、inspection 别名、issue share、session events/results、comments/timeline、task 集合、run payload/result/schedule_prompt、SQL 文档与 revision 正文、迁移/发布、task/project/agent 指令、skill/file 正文及相应 write 回读/actor scope。agent lite 仍整读 agent 行，只跳过文件水合；行数 LIMIT 或 TS 读后分页不等于字节有界。完整键及逐条解析调用方依据见常量和本单报告 | 先做对应投影/有界读（messages 等待 MUL-402），再满足上行单次数据条件 |
| C-1 续做裁定与 Senior `cmt_tvxpad98uqtz` | 当时的 POST `/api/daemon/tasks/:taskId/messages` 因 MUL-462 回读 8 行列入例外；该路由在 daemon v2 已退役。POST `/internal/peer/events` 仍在使用，其同步消费会继承 HTTP 上下文 | 清理已退役路由的例外；peer 回读改为按实际行宽有界后收回其例外，不必等三天观测 |
| C-1 后台裁定 | `<background> <background>` 为独立、可一行删除的例外。Scheduler.sync → advanceScheduledTargetRuns 仍无界读 queued run 的 schedule_prompt/payload/result；独立 peer 消费也保留 8 行 | queued run 读取有界之后，且含埋点版本实际上线后后台单次数据 <6 MiB，才收回；本 PR 不修改 autopilots-repo.ts |

repository-wikis 的 A/A2（`d905961b`、`d6714966`）已在 main、晚于 v0.2.84，与 C-1 同包或更早上线；本轮保守保留其例外并复测 209 行数模型，未声称 A/A2 已在取证时的生产版本生效。旧 task messages 的 22.7MB / 28 个任务数据来自 MUL-386 `cmt_cecxmzj19eea` 的行 JSON 估算，与桥 bytes 不混用。dashboard 的 58.42 MiB 是请求总量；单次接近/超过 64 MiB 的情况应单列报告，本 PR 不修。

`advanceScheduledTargetRuns` 也可由 canonical trigger、三个 multiremi run/trigger 别名及 repository wiki build 触发；这些 HTTP 例外的收回也要求 queued 读有界。请求内未等待完成的异步工作会继承该请求的 ALS 上下文，同一函数由 timer 触发时则为 `<background>`；C-2 要按触发方看数据。后台收回清单还包括 SCM/issue-title/messaging scheduler、outbound-dispatcher sweep、task-capability-monitor、repository-wiki storage job、WS 消息处理和启动迁移，不能只修 queued run 就移除整个后台例外。归档/trace 正文在外部文件存储；SQL 归档 metadata 无字节上限，相关归档读与回读同样保守进表。

回滚 C-1 合并用 `git revert -m 1 <merge>`；若有人显式开启拒绝，应急设 `MULTIREMI_PG_REPLY_ENFORCE=0` 或 `MULTIREMI_PG_REPLY_MAX_BYTES=0`。物理上限仍为 64 MiB，209 配置变更由贺华杰决定。

新增路由可能通过鉴权、回读或调用链触及项目/agent 指令、skill 正文等大列，慢请求日志不能覆盖快请求。变更这些路径时运行 `env -u MULTIREMI_TOKEN bun tests/manual/audit-pg-reply-c1-callers.ts --list-missing`；脚本从运行时 Hono 路由和 schema 扫描出保守候选。分类尚未完成，架构测试目前只守卫清单与扫描可执行，候选差异只输出报告；不得把绿灯当作例外完整性证明。真实 PG 全路由 GET/HEAD 对照入口是 `tests/manual/probe-pg-reply-c1-routes.ts`。Hono 的 HEAD 复用 GET handler，例外查找也按 GET key 计算有效上限。静态分析与合成样本都不能代替 C-2 的生产单次回包数据。

MUL-479 的 context-window 写路由会经 `gatewayReasoningLevels` 读取无 SQL 字节上限的 `multiremi_gateway_models.models`。其调用路径和 QA r1 授权的 15 条 messaging/Feishu 已入表；表冻结在 `84101310` 的 418 条 HTTP + 独立 `<background>`。21 条 workspace context、8 条 source allowlist 以及 MUL-487 的 human request card 整行读均不再扩表，作为 C-2 的列级风险。推荐 repo 投影掉不需要的大列或给写入限界。全路由门禁运行两遍：默认只告警与 main GET/HEAD 状态码差异须为 0；`ENFORCE=1` 输出按根因列分组的拦截清单，作为 C-2 种子，不是例外表。脚本、最大单次字节、非成功/跳过原因和写入限制见 [裁决 B 实测报告](../../reports/performance/MUL-398-c1-b.md)。

**环境变量**（都在 [api.env.example](../../deploy/docker/api.env.example) 有登记）：`MULTIREMI_API_ROLE`（`all` | `ui` | `runtime`，**默认 `all`**；未设置、空串和无法识别的值都解析为 `all`。`ui` 服务页面请求，对 `/api/daemon/*` 和 trace 读取返回 421；`runtime` 服务 daemon 协议、trace 读取、`/health*`、`/readyz`、`/healthz`、`/internal/*`，其余返回 421。`/api/daemons/:id` 复数前缀是浏览器路由；实现与守卫表见 [api-role.ts](../../packages/server/src/config/api-role.ts)）、`MULTIREMI_REQUEST_METRICS`（默认开，`0/false/off` 关闭指标采集、指标日志和响应头；PG 回包护栏与其日志仍独立生效）、`MULTIREMI_SLOW_REQUEST_MS`（默认 500，设 0 可让每个请求都打一行，适合短时冒烟）、`MULTIREMI_METRICS_SUMMARY_INTERVAL_MS`（默认 60000）、`MULTIREMI_METRICS_SUMMARY_TOP_N`（默认 10）、`MULTIREMI_METRICS_BUFFER_SIZE`（默认 4096）、`MULTIREMI_PG_REPLY_MAX_BYTES`（**默认 8388608 = 8 MiB**；未设置/空串使用默认，非法值告警后回落；显式 `0` 关闭可配置上限，集中例外保留 64 MiB）。

**观测与验证入口**：

`MULTIREMI_PG_REPLY_ENFORCE` 已在同一 env 示例登记，代码默认 `0`；`MAX_BYTES` 是阈值而不是开启拒绝的开关。C-2 必须先修读/写边界并取得生产单次回包证据，再申请当次翻转授权。

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

**只读保证**：所有非 GET/HEAD 的 `/api/**` 请求都在浏览器里被 abort，唯一例外是 `POST /api/inbox/read` 的浏览器本地 stub，仍不发送到服务端。护栏自检对 `/api/messages/__guard__/resolve` 发 POST 并核对它被拦截，不使用真实资源 ID。凭证和数据安全边界保持原样。

### 游标读取的浏览器本地 stub

[stub-writes.ts](../../frontend/scripts/perf/lib/stub-writes.ts) 只接受 `{session_id,to_seq?}` 或 `{all:true}`，返回 `{session_id,cursor_seq}` / `{conversations_read}`。同一对话的 stub 游标只前进；GET `/api/inbox` 的响应移除该游标以前的消息，保留后续消息与原 opaque cursor。没有旧 InboxItem 的 `read` / `archived` 状态或旧业务路由。

单对话 stub 只能知道本 context 已加载的消息，计数减去这些已知条目；它不是服务端全局计数验证。read-all stub 把本地未读/关注计数归零。真实计数和权限验收须由 QA 在隔离环境直接调用真实接口。

深链测量使用 `deeplink-message`，URL 为 `/{slug}/inbox?item=<message_id>`，测 canonical 消息详情的 `[data-inbox-detail]` 滚动容器和 `[data-inbox-message]` 锚点。新 key 避免与旧 `deeplink` 的 Issue 通知详情基线直接配对；旧报告保留原有意义。Issue 首屏和 Issue `?comment=` 的日志窗口协议保持原样。

探测从 GET `/api/inbox?limit=100` 的返回 cursor 续页，候选按 API 顺序以 message ID 去重，不按 Issue 合并。目标来自较后页时，`injectInboxTarget` 仅把它放入浏览器第一页，后页移除同 ID，避免把翻页成本混入详情就绪时间。DOM 行序与页面的 message ID 去重一致；选中消息不会自动写读游标。

`blockedWrites` 与 `stubbedWrites` 分列记录。深链选择轮要求桩写为 0；其他页面每个不同的显式游标读取最多允许一次重试，超出记录 `stub-loop-not-terminated`。Chat 打开可触发自己的读游标写入，由同一允许表在浏览器中接管。URL 断言只检查选中 message ID，不计入 readyMs。

运行中 Issue 的选择使用 GET `/api/turns?status=running&limit=200`，按 opaque cursor 读取所有页，以 canonical `issue_id` 计数，不再调用 `/api/multiremi/tasks`。

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
| `data-perf-scroll` | 被测量的滚动根：issue 详情、chat；列表页的就绪标记（MUL-472 第 5 项） | `issue-detail` \| `chat` \| `list` | S1 打标；`list` 由 [use-list-perf-marker.ts](../../frontend/packages/views/common/use-list-perf-marker.ts) 在该页自己的列表请求返回后写上 |
| `data-perf-item` | 真实数据行（timeline 行、chat 消息、issue 行、board card、inbox 行、子单行） | `comment` \| `activity` \| `resolved-bar` \| `message` \| `issue` \| `inbox` \| `sub-issue` | S1 打标 |
| `data-perf-key` | 同一行 | 行自身的稳定 id | S1 打标 |
| `data-perf-anchor` | 该页面口径的终点元素 | `latest-comment` \| `agent-stream` \| `target-comment` \| `latest-message` | S1 打标 |
| `data-perf-state` | `data-tab-scroll-root` | `pending` \| `ready` \| `ready-forced` | `useAnchoredReveal`（[frontend/packages/views/common/use-anchored-reveal.ts](../../frontend/packages/views/common/use-anchored-reveal.ts)），S1 与 `useStickToBottom` 不写 |
| `data-perf-fresh` | 同上 | `0` \| `1` | 同上；消费方传 `fresh`（`undefined` 时不写并移除该属性） |

`data-perf-state` 是**只读**契约：S1 应用侧不写它（没有 hook 就写死 `ready` 是假数据，会让 S7 的断言空过）。记录器在浏览器内用 `MutationObserver` 抓它的变化时间戳，不从 Node 侧轮询；属性不存在时 `appReadyMs` 为 `null`，且**永远不作为终点**。写入方无权改名、改宿主或改取值。

`data-perf-fresh` 是**新鲜度**位，只有 `useAnchoredReveal` 写它，消费方传 `fresh`；`undefined` 时不写并移除该属性（今天 main 上还没有任何消费方传它）。记录器按「属性在不在」分两套口径：

- **属性存在**时，只有 `data-perf-state = ready` **且** `data-perf-fresh = 1` 的帧才算加载完成；`ready` 但 `fresh = 0` 不算，`ready-forced` 也不算通过，但会在报告里**单独列出**（`appReadyForced`）。
- **属性不存在**时，维持原逻辑（只看 `data-perf-state`），所以 MUL-443 上线前后同一份清单都可用。

### Snapshot 数据裁剪（MUL-395 S9-6）

两个 agent-task-snapshot 路由把 Chat 创建者/任务凭证可见性下推到 SQL。仍先选每个 Agent 的最新 completed/failed，再过滤权限；无权最新结果不会让较旧结果补位。请求身份版本仅投影公开任务响应需要的列，保留 prompt/result/plugin/usage，省去内部执行配置及委派状态；内部无身份调用仍返回原任务对象。

### 判定口径

| 项 | 口径 |
| --- | --- |
| 终点 | 详情/深链：anchor（detail-running 必须 agent-stream，非运行详情为 latest-comment；深链为 target-comment）可见 + 骨架 0 + 之后 500 ms 无移动帧。列表：区域内无骨架且至少 1 个真实行可见 + 500 ms 安静。chat：最新一条消息可见 + 500 ms 安静 |
| 超高行 | 行高 > 根高时，`covers`（top ≤ 1 且 bottom ≥ 根高 − 1）或 `bottomVisible`（0 ≤ bottom ≤ 根高 + 1）任一成立即算可见；`target-comment` 为 `topVisible \| (tall && covers)`，因为 `scrollIntoView({ block: "center" })` 会把超高目标的顶边推出视口。每轮在就绪帧记原始 `anchorRectAtReady: { top, bottom, height, rootHeight }`（根相对坐标，只记数不下结论） |
| 列表页滚动根 | 11 个列表页没有自己的滚动根，两种模式都以 `[data-slot="sidebar-inset"]`（MUL-367 的 `READY_SELECTOR`）为根；空 chat 的 legacy heading 规则也用这个回退根（它渲染 `EmptyState`，没有 chat 滚动根）。列表 *根* 不在两种表之间分开，`selectorEquivalence.scrollRoot` 才能继续读 `same` |
| 列表页就绪标记（MUL-472 第 5 项） | issues / my-issues / inbox / projects / agents / runtimes / skills / autopilots / workbench 的列表容器由 [use-list-perf-marker.ts](../../frontend/packages/views/common/use-list-perf-marker.ts) 在自己那条列表请求 `status === "success"` 且不是 `keepPreviousData` 占位数据时才写 `data-perf-scroll="list"`。`--selectors auto` 从 `[data-perf-scroll]` 判定，所以带标记的列表轮从此记 `contract`（此前 09-28 两轮 32/32 行都是 `legacy`）；标记出现即代表「屏幕上的行是本轮自己那次请求的答案」，事件量是 `mounted && listPerfFresh(query)`，脚本无需再加时钟 |
| 首屏请求 gate（MUL-472 返工） | [use-after-first-screen.ts](../../frontend/packages/core/platform/use-after-first-screen.ts) 等当前路由主内容就绪，再经下一帧和 `requestIdleCallback({ timeout: 1000 })` 打开。列表由上述同一个标记条件发布，空成功、失败也发布；Issue 详情正常等 timeline reveal，空日志或失败立即发布，日志或会话持续 pending 时由详情自身在 2s 上限发布 ready，列表骨架与 reveal 仍独立。未接入发布者的路由从路由开始等 2s 再进 idle；其他有发布者的慢请求不会被共享兜底抢先打开。默认页面级每次切页关闭，首个 render 即 false；`scope: "shell"` 会话内只等一次。筛选依赖 snapshot 时立即取，数据未到不显示空列表，也不写就绪标记 |
| 跳动 | 首次出现目标页真实内容之后，相邻帧中同一 `data-perf-key` 且同一 DOM 元素的可见行位移 > 1 px（或 scrollTop 位移 > 1 px）即移动帧；连续移动帧合并为**一次**跳动。`jumps = 0` 才合格。入口页行换成目标页行是导航，不能把两个不同锚点的坐标差计作同一行的位移 |
| 缺观测（S9-6） | `firstRealMs = null` 时 jumpCount/jumpPx/jumpScrollPx 均为 null，MD/HTML/compare 显示「未观测」；stats 保留 jumpObserved/jumpUnobserved 和 n，不算作零跳动通过。contract 列表用 fresh 的 `[data-perf-scroll="list"] [data-perf-item]`，设置页标真实账号控件。Chat 使用现有 chat/session-log 滚动根、选有消息的会话并等待 latest-message，空 chat 单列跳过 |
| readyMs | 取 500 ms 安静窗口的**起点**，不是终点 |
| 超时 | 单轮 20 s；超时轮记 `readyTimeout`，**不进任何分位数** |
| 分位数 | 最近秩法，与 API baseline / `bench-task-list-pagination.ts` 一致 |
| 冷启动 | `page.goto` 整页加载，全新 context；时基是文档 origin（`navStartMs = 0`） |
| 应用内切页 | 先 hover 150 ms，再真实 click；`navStartMs` 取**页面内记录的 click 时间戳**（避免 CDP 往返误差）。warm 轮的帧、跳动、`Server-Timing` 与首屏集合**一律先减 `navStartMs`**，即全部从 click 起算 |
| 入口页安静（**已定口径**，`--entry-quiet-ms`，默认 500 ms） | warm 轮在点中行出现之后再等「入口页 500 ms 内没有新的 `/api/**` 请求开始」，上限 5 s；超时照点并记 `entrySettled=false`，同时在途请求数记 `entryInflightAtClick`。`--entry-quiet-ms 0` 关闭（回到「行一出现就点」的旧行为）。依据：MUL-383 待决项 A1，2026-09-27 答复；`meta.entryQuietMs` / `meta.entryQuietCapMs` 记录本轮实际用的阈值与上限 |
| 首屏集合 | `startMs ≥ navStartMs` 且不晚于就绪帧的 `/api/**` 请求；`apiCallsTotal`、chunks 共用同一下界，所以入口页的尾请求不计入目标页 |
| 串行深度 | `wave = 1 + max(wave(p) \| p.responseEnd ≤ start + 8ms)`；`Server-Timing` 从 resource timing 同源读取。口径未变，只多存 `serialChain` 与逐请求 `wave/after` |
| gap | `gapMs = 客户端 duration − Server-Timing total`，即请求在 handler 之外等待的部分（连接与排队）。服务端没有 `total` 时为 null |
| 深链目标 | GET `/api/inbox` 的 canonical message，包含 id / session_id，按服务端顺序选择；删除或缺字段的候选排除 |
| 深链 URL | `/{slug}/inbox?item=<message_id>`；选中消息不推进读游标 |
| 深链 warm | 页面 ID 去重后的消息行，点击前按新快照重算行号；URL `item` 必须等于选中 message ID，详情锚点为该 ID |
| 深链目标读态 | inbox API 只返回未读消息；深链选择不写入，真实游标验收另行执行 |
| 目标深度 | `targetDepth: { timelineRequests, targetIndexFromLatest }`，从本轮已捕获的 `/comments` 响应计算，不额外预查 |

页面 gate 的发布者在最后一个实例卸载时释放该次访问，取消 idle、兜底 timer；发布者自己的帧回调同时取消。同 pathname 重挂也从关闭开始，缓存内容仍在下一帧与 idle 后放行。无发布者时由最后一个消费者释放 registry；会话级 shell 标志保持打开。异步回调绑定 gate 实例，旧回调不能打开同路径的新实例。

聊天 aggregate pending 的两个 observer 是 ChatFab 和 [SessionDropdown](../../frontend/packages/views/chat/components/session-dropdown.tsx)。后者常驻于隐藏 ChatWindow，条件为 `chatVisible || shellGateOpen`：隐藏时等会话首 gate，用户打开窗口或进入聊天页面时立即查询。共享 key 的去重不能替代每个 observer 的 enabled；[壳层守卫](../../frontend/packages/views/layout/shell-deferred-queries.test.tsx)挂载完整 DashboardLayout、ChatFab 与真实隐藏 ChatWindow，核对门控前请求为 0。

隐藏聊天窗口的缓存子树同样需要门控：ChatMessageList 的 live/assistant 任务消息、HumanRequestDock 表单仅在 `chatVisible` 时 enabled，旧消息分页回调也检查可见性；无缓存会话时挂载的 WorkLocationPicker 项目候选同样继承聊天可见性，其他可见选择器保留默认立即查询。隐藏时包括 degraded task header 在内的 invalidate 只标 stale，重新打开立即正常 refetch；详情主体的执行行不受此可见性门控影响。壳层守卫预置 19 组 key 的缓存后逐 key invalidate，并经过真实 `createTaskHandlers`；虚拟列表提供测试尺寸并断言历史回复实际挂载，防止新 observer 从失效路径绕过门控。

**warmup 也挂护栏**：`--warmup` 与测量轮使用同一套写操作护栏。消息深链为 `?item=<message_id>`；选择消息不自动推进读游标。

参数：`--base-url`、`--rounds`（默认 3）、`--window peak|offpeak`、`--name`、`--out`、`--compare`、`--selectors auto|contract|legacy`、`--only <prefix>`、`--warmup`、`--issue-short`（默认 `iss_in41j1x1dq66`，MUL-67）、`--issue-long`（默认 `iss_enbrunyg86jc`，MUL-70；**MUL-395 前后对比固定用这一条**）、`--issue-xlong`（默认 `iss_o2skonppbq2u`，MUL-454；≥200 条评论的 `detail-xlong`，传空串跳过该场景）、`--issue-running`（默认现场选取，排除 MUL-383 `iss_j67lb0r8djw4` 及其全部子单，以及 MUL-454 `iss_o2skonppbq2u`；选不到则 `skipped: all-running-issues-in-mul383-family`）、`--inbox-item`（默认在探测窗口内自动选取）、`--inbox-probe-pages`（默认 10）、`--hover-lead-ms`（默认 150）、`--entry-quiet-ms`（默认 500，0 关闭）。`targetSelection` 取 `auto | pinned | none`。

`detail-running` 的排除名单分两段：**叶子常量**（MUL-454 这条永不完成的夹具单，故意保持进行中且未指派，否则会被选成 running 目标）与**运行时拉取**的 MUL-383 子单（见 `lib/options.ts` 的 `EXCLUDED_RUNNING_ISSUE_IDS` / `EXCLUDED_RUNNING_ISSUE_PARENTS`）。

**场景矩阵新增 `detail-xlong`（MUL-454，≥200 条评论）**，与 `detail-long` 并列而不是替换它：MUL-395 的前后对比基线锚在 MUL-70，改掉 `--issue-long` 会让所有历史配对失效。已有场景 key 一律不改，`--compare` 的配对依赖它。

**测速数据**：cold 与 warm 用同一 fixture，且必须是**非 archived、非 cancelled** 的 issue，否则默认 `/issues` 列表不渲染 `ListRow`，warm 找不到入口。报告标注实际评论条数（按 timeline 里 `type === "comment"` 计数；`timelineEntries` 另记条目总数，两者不同）。warm 目标行不在首批渲染里时记 `skipped: warm-target-not-in-list`，不改走搜索或 archived 手风琴（那些不是 S3 的验收入口）。参考量级：short ≤ 20 条、long ≥ 41 条（把「首页 40 条 + has_more」的分页路径踩到）；MUL-249 之后打开路径成本与总条数基本无关，≥200 的口径由 S7 的 250 条 fixture 与 S6 深链覆盖。

**fixture 选择约束**：非 archived、非 cancelled，且 `completed_at` 为空或远新于归档 TTL。`issues-repo.ts` 的 `archiveEligibleIssues` 会把 `completed_at` 超过 TTL（约 72h）的 done / cancelled issue **自动归档**——MUL-353 就是这样在选定后几小时被归档的，于是 warm 找不到入口。脚本在跑之前对两个 fixture 各做一次只读预检，状态不对就直接输出 `skipped: fixture-archived` / `fixture-cancelled` / `fixture-unreadable`，**不再等满 20s**。`warm-target-not-in-list` 同样立即以 skipped 结束。
| 目标深度 | `targetDepth: { timelineRequests, targetIndexFromLatest }`，从本轮已捕获的 `/comments` 响应计算，不额外预查 |

**为什么深链不用固定 `inb_...`**：[inbox-page.tsx](../../frontend/packages/views/inbox/components/inbox-page.tsx) 对不在已加载页里的 `?item=` 会逐页 `fetchNextPage()` 直到找到，页大小 50；固定项在第 769 位左右 ⇒ 冷启动先串行拉约 16 页，测到的是翻页而不是深链落点。

### 选择器回退：contract / legacy

当前前端已经提供 `data-perf-*`；为读取历史基线， [frontend/scripts/perf/lib/selectors.ts](../../frontend/scripts/perf/lib/selectors.ts) 维护两套选择器，`--selectors auto|contract|legacy`（默认 `auto`：页面存在 `[data-perf-scroll]` 即用 contract，否则 legacy；列表页的标记见上表，`CONTRACT.listMarker` 就是它）。**所有选择器都集中在这个模块里**，不散落在脚本各处。每一轮都记 `selectorMode`。

| 用途 | legacy 选择器 / 规则 |
| --- | --- |
| 滚动根 | `[data-tab-scroll-root]`；列表页用 `[data-slot="sidebar-inset"]`（见上） |
| timeline 行 | `[data-tab-scroll-root] [id^="comment-"]` |
| latest-comment | DOM 顺序中最后一个 `[id^="comment-"]` |
| target-comment | `#comment-<id>` |
| 骨架 | `[data-slot="skeleton"]` |
| issue 列表行 | `[data-slot="sidebar-inset"] a[href$="/issues/<issueId>"]` |
| inbox 行 | `section[aria-labelledby^="inbox-group-"] div[role="button"][tabindex="0"]`。**不可靠**：QA 在 209 上实测未加作用域的形式匹配到工具栏按钮（`cmt_3d2bb3s7ceeh`）；该表只保留给等价性比对，**不得用它驱动点击**，深链 warm 直接按目标通知 `data-perf-key` 选择行根，不用 API 行号或子链接驱动点击 |
| agent-stream | `detail-running` 两种采样表均要求现有 `[data-perf-anchor="agent-stream"]`，缺失记 anchor-mismatch；目标预选先核对实际可见运行行，不能降级 latest-comment |
| chat | 退回 `h1-no-skeleton`，记 `anchor: none` |

**等价性证明**不用比较两次运行的时间（噪声太大），而是比较**同一 DOM 上元素的同一性**：contract 模式的每一轮在就绪时刻同时用 legacy 表求值，记 `selectorEquivalence: { scrollRoot, anchor: same|differs, itemsContractOnly, itemsLegacyOnly }`，元素用 `===` 比较。两个门槛：

1. 本地端到端：详情/深链核对 anchor 对应元素；列表 contract 真实行与 legacy H1 是不同口径，`anchor: absent`、`itemsContractOnly > 0` 是预期，必须独立验证真实行。两种列表采样仍共享滚动根。
2. 209 上第一次 contract 运行（高峰基线或终验）由 QA 复核同一字段；不通过则对应场景的 legacy 基线标 `invalid` 并重跑。

两版基线按实际 `selectorMode` 如实标注；`--compare` 遇到模式不同**只警告不拒绝**。

**legacy 表的删除条件**：满足两条才删——S2 已合入，且已有一版 contract 模式的基线。删表时同步删掉本节这张表与 `selectors.ts` 里的 `LEGACY`。

### 深链目标：探测可以翻页，测量不翻页

探测按原 opaque next_cursor 分页；测量只使用已准备第一页的 message ID。报告记录 inboxApiPage、inboxInjected、inboxApiIndex 与 inboxDomRowIndex。点击不发已读请求，所以 inboxPageRequestsBeforeStub 在没有桩写时为 null，不能解释为 0 次加载。

CI 的 `detail-deeplink` 通过 `/inbox?item=<messageId>` 打开消息详情，读取 `/api/messages/:id`，以 `[data-inbox-message]` 为锚点。该页面使用工作区事件连接，不订阅 Issue 的 `log:` 流；收尾必须收到真实的 `auth_ack`，其他 Issue 详情场景仍必须收到 `stream.ack`。报告的 `hubAckType` 记录本轮要求的确认帧，`hubAckSeen` 记录是否收到；两类场景均继续要求 API 无在途请求、API/WS 连续静默 500 ms，并保留零跳动、目标锚点、无骨架及 `ready/fresh=1` 检查。

`detail-f398` 的溢出夹具使用 20 个独立 agent 的排队轮，避免同一 agent/session 的请求按单一待处理轮规则合并。检查仍要求全部 20 行在固定槽内呈现且最后一行可滚动到达。

### 场景矩阵与参数

详情页 `detail-short` / `detail-long` / `detail-running` / `deeplink-message` × {cold, warm}，外加 MUL-367 的 11 个页面 × {cold, warm}。

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

基线产物放 `reports/performance/`，HTML 用 `remi message send <issue> --attachment` 同时挂到本单和父单。

本地端到端（不需要生产凭证）用 [tests/manual/mul384-perf-harness.ts](../../tests/manual/mul384-perf-harness.ts)：起内存 SQLite 的 API + 本地 web，铸造本地 PAT 注入 `MULTIREMI_QA_WEB_TOKEN`，跑完全部场景并 grep 产物确认 0 个 token 泄漏。**不要把生产凭证用于本地。** 它跑的是 `next dev`：首个访问的路由要现场编译（实测 `/[slug]/inbox` 首次 17.6 s），会撞 20 s 的单轮超时，所以 harness 传 `--warmup`，先对每个场景各访问一次再开始测量。**`--warmup` 只是本地 dev 服务器的让步**：209 跑的是构建产物，没有现场编译，生产基线的数字不含这一步。

## CI 零跳动检查（MUL-394 / MUL-383 S7）

[tests/integration/zero-jump-check.ts](../../tests/integration/zero-jump-check.ts) 把上面这套口径搬进 CI：内存 SQLite 起 API（`startMultiremiServer`，fixture 见 [tests/integration/zero-jump-fixture.ts](../../tests/integration/zero-jump-fixture.ts)：短 issue 3 条评论、长 issue 250 条含 20 个代码块与 5 张图片并分 3 个 session、一个带消息的 running task、一条指向长 issue 第 40 条评论的 inbox 深链），`next build` + `next start` 起 web，Playwright + Chromium 驱动同一个浏览器侧记录器，每行跑 3 次。**只断言结构量**（`jumps = 0`、anchor 完整可见、骨架为 0、就绪状态合格），不断言毫秒数。

两条容易踩的实现事实：

MUL-395 的图片回归由 [zero-jump-image-cases.ts](../../tests/integration/zero-jump-image-cases.ts) 扩展 fixture：真实 640×240 PNG 的晚到、404、canonical 元素锚点，以及有尺寸/快速加载对照。晚到请求以第一次正常揭示为条件屏障释放，图片和行高前后必须一致；位置仍由原收集器和零跳动判定检查。五类用例默认进入 CI，`--only detail-image-late` 等可以定向运行，关闭 SSR cookie 可复核 CSR。不改原 fixture 延迟或 allowlist。

`detail-f398::cold` 默认进入同一 CI：带 `#` 标题的长描述、20 段正文、4 条评论、20 条 queued dispatch、60 次标题/优先级更新，覆盖延后挂载的多任务 footer。任务槽保持 64px，更多任务在槽内滚动，避免揭示后的挂载触发外层贴底补偿。回归沿用完整锚点与零跳动判定，并验证空槽和 20 行挂载后的高度相同、所有行保留且末行可滚到。活动偏好关闭是默认；`--only detail-f398-system-details` 验证打开偏好，`--no-ssr-cookie` 验证 CSR。

- **`REMOTE_API_URL` 是构建期烘焙的。** Next 把 `/api/*` 的 rewrite 目标写进 `.next/routes-manifest.json`，`next start` 时再设 env 不会改变它。所以检查必须**先固定 API 端口、再 build、最后 start**（写完第一版后才实测到：`next start` 带着新 `REMOTE_API_URL` 仍代理到 build 时的端口，所有 API 都是 500）。
- **消息深链的 URL 为 `/{slug}/inbox?item=<message_id>`**，使用 `target-message` anchor。独立详情深链使用 `/issues/:id?comment=…`，由 SSR/CSR locate 窗口提供目标锚点；`detail-locate` 和 `detail-image-element` 单独验证该路径。

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

### 会话日志列表自己的零跳动检查（MUL-443）

[tests/integration/zero-jump-session-log-check.ts](../../tests/integration/zero-jump-session-log-check.ts) 测的是新的平铺会话日志列表（`frontend/packages/views/common/session-log/`），不是详情页。它对应用例里点名的三种扰动各跑 3 轮：

| 场景 | 读者状态 | 扰动 | 断言 |
|---|---|---|---|
| `append-20` | `released`（停在末尾上方 300px） | 尾部追加 20 行 | 读者行与 `scrollTop` 都不动 |
| `row-height-change` | `released` | 视口下方的一行变高 | 同上，且 `contentGrowthPx > 0` |
| `width-change` | 揭示窗口内（尚未 `ready`） | 容器 800 → 640px | 揭示只定位一次，`jumps = 0` |

另外每轮都断言 `data-perf-state=ready` 且 `data-perf-fresh=1`：只报 `jumps = 0` 而不看应用自己的判定，一个「从未揭示、内容直接可见」的页面同样会全绿。检查末尾另跑一条**阳性对照**（帧内故意滚动 200px，探针必须报出），对照不成立时整个检查失败——否则「全绿」只证明没测到东西。

页面的构成：`Bun.build` 打包夹具（真实 `SessionLogList` + 内存副本端口），本地 HTTP 服务同时提供**应用自己的 `globals.css`**（PostCSS 编译；Tailwind 的 `@source` 不扫 `tests/`，少了它夹具的滚动根高度会是内容高度，等于没有可观测的滚动范围），Playwright + Chromium 装同一个记录器。

```text
bun run tests/integration/zero-jump-session-log-check.ts
```

报告写在 `reports/performance/MUL-443-session-log-zero-jump.json`。三条踩过的坑写在检查文件头注释里：合成 `WheelEvent` 只触发监听、不产生滚动；Chrome 自身的 scroll anchoring 会冒充应用的同帧补偿（夹具显式 `overflow-anchor:none`）；在两次 `page.evaluate` 之间做的扰动落在下一帧采样之前，记录器永远看不到变化（扰动改为在 rAF 回调里做）。还有一个探测能力边界：`jump-recorder` 把任何 >1px 的 `scrollTop` 变化都记为跳动，因此它无法区分「补偿式贴底」与「真跳动」；贴底补偿由 MUL-450 的 hook 单测覆盖，本检查不去断言它。

**前基线**（`4248ef07`）仍存于 [reports/performance/MUL-394-zero-jump-strict-main-2026-09-26.json](../../reports/performance/MUL-394-zero-jump-strict-main-2026-09-26.json)：9 行全部失败，其中 8 行只有 `perf-state`，`detail-deeplink::cold` 另有 `jumps`（每次 1 跳、内容位移 8359.8 px、滚动 2450 px）。

## 优化不能破坏的约束

- 数据库层必须保持 SQLite/PostgreSQL 行为一致；`transaction` 的原子性和回滚语义不能因连接池化或 async 改造丢失，不能仅把 `max: 1` 调大。
- 列表合并必须保留人员关系的 OR 语义、按 ID 去重、状态桶、排序及分页。当前“全部”桶的 `total` 是合并后已加载长度，并非完整服务端总数；改变此语义需同时改调用方。
- 搜索要保留 workspace/权限边界、关闭和归档筛选、评论片段、排序及分页语义；下推 SQL 时应以现有结果契约验证，而不是只比较速度。
- 实时消息保留 task/seq 身份、去重、顺序、卸载尾部 flush、未加载缓存保护和重连补漏；不可用扩大 `staleTime` 或删除失效逻辑掩盖请求量。
- transcript 保留工具调用与结果配对、子 agent 分组、seq 定位、脱敏、终态及用户主动滚动的位置。虚拟化只能减少 DOM，不能代替数据派生和加载边界优化。
- 收件箱保留稳定排序、成员隔离、全局未读/关注计数、人的读游标和 message ID 深链；真实摘要不能改成已加载页的局部计数。
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
| 仓库根 | `bun run --preload ./tests/setup/hermetic-env.ts tests/manual/bench-first-screen-hotspots-pr2.ts --out <path>` | inbox 摘要、附件内容（完整响应与条件请求）、workspace Runtime 列表的同口径 dbq、db、过桥字节及响应字节。显式 `MULTIREMI_TEST_POSTGRES_URL` 启用真实 PG，否则使用 SQLite；PG 失败不回落。摘要按全部未归档 selection 聚合，附件 `/content` 在鉴权后比较 id ETag；三条上传路径统一排他创建，使用完整 UUID id，碰撞最多重试三次，失败只清理本次创建的文件。Runtime usage/group/model 各一次批量读，两条列表查询固定按 `updated_at DESC, id DESC` 排序。基线与 golden 复现见 `reports/performance/MUL-473-pr2-first-screen-hotspots.md`。 |
| 仓库根 | `env -u MULTIREMI_TOKEN bun run tests/manual/bench-mul395-s9-5.ts --out <path>` | S9-5 Chat 列表、Runtime/执行组/模型列表和 updater heartbeat；必须显式配置一次性 PG，失败不回落 SQLite。250 Chats、10 runtimes，`MUL395_TASKS` 控制历史任务规模；实际桥计数、最大单回复字节和连续 timer 的不可让出区间逐轮留样。sample 0 是各路由首读，随后预热 5 次、正式 20 次；当前 Runtime 统计走规范化台账 SQL 聚合，旧缓存版本的数据按生成提交解释。 |
| 仓库根 | `bun test tests/unit/multiremi/multiremi-postgres-store.test.ts` | SQL 翻译和真实 PG store 契约；`MULTIREMI_TEST_POSTGRES_URL` 指向可创建临时数据库的测试实例，**本地/Agent 会话必须显式设置，否则集成部分整片静默 skip**（CI 在 `release-build-check.yml` 的 backend suite 步骤显式声明），不可达时跳过并打印原因，须记录 skipped。 |
| 仓库根 | `MULTIREMI_TEST_POSTGRES_URL=postgres://… bun test tests/unit/multiremi/multiremi-task-list-postgres.test.ts` | MUL-357 的 PG 侧证据：迁移的两个分页索引真的建出且 `indexdef` 与 `ORDER BY created_at DESC, id DESC` 匹配、`EXPLAIN (ANALYZE)` 不出现 Seq Scan/全量 Sort、`?`→`$n` 的 status/游标/limit 绑定顺序、分页走遍后与未分页集合一致。UNSET 时默认落到 `postgres://multimira:multimira@localhost:5432/postgres`（即 CI service container），不可达时跳过并打印原因，须记录 skipped。 |
| `frontend/packages/core` | `bun run test issues/queries.test.ts issues/ws-updaters.test.ts realtime/sync/tasks.test.ts realtime/use-realtime-sync.test.ts` | 查询、精确缓存更新、实时排序/去重与刷新语义。 |

S9-5 的 Chat API 列表在 SQL 排除 transport 会话，批量读取 agent 的权限所需字段；不改变 store 列表的默认选择或用户侧响应。Runtime 列表和单条读取均从规范化用量标量表执行 SQL 聚合，不读取旧 task usage JSON，不维护其 id/xmin 派生缓存。workspace 列表只返回每个 Runtime 的汇总列，过桥回包随 Runtime 数而非单位数增长；任务状态与持久化单位修订在下一次读取立即可见，事务内可读自己的写入。单位按执行时固化的 Runtime 归属，任务重派不会移动旧消费；任务状态计数按当前任务绑定独立聚合。SQLite 与 PostgreSQL 使用同一统计口径。原始非法数值仅在旧客户端输入边界规范化，原生单位验证安全非负整数，不能保留按旧 JSON/JS 加法顺序产生的溢出误差。真实 PG 一致快照、事务回滚、数量安全与列表回包边界见 runtime usage 专项测试；旧热缓存测量不能作为新事实源的性能结论。

Updater heartbeat 保留每次状态写入与活动发版检查；未到检查时点时跳过重复的自动更新检查。CLI 对齐使用 app 内的成功指纹，包含当前版本、daemon 身份/有效在线状态/CLI 版本/launch owner 和 CLI 请求记录；相同版本下新 daemon 或请求状态变化仍会执行对齐，发版活动期间不执行。对齐只读这些字段，不再附带 runtime usage、models、groups。首读、到点检查和创建 CLI 请求的费用独立报告，见 `reports/performance/MUL-395-s9-5-{A,B,C}.md`。未结束任务热缓存回包与首次版本对齐环境差异的追加证据见 `MUL-395-s9-5-r2-{B,C}.md`；复跑工具为 `tests/manual/bench-mul395-s9-5-open-cache.ts` 和 `tests/manual/bench-mul395-s9-5-bridge-pairs.ts`，只使用本地隔离 PG。
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

### S9-6：活跃 Issue 任务读

`GET /api/issues/:id/active-task` 先按活跃状态及 Chat creator/task capability 在 SQL 中筛选，再只读取完整公开任务字段；公开 prompt/result/usage/plugin 与 queue blocker、顺序保持原形状。Issue workspace 已授权且一致的行无需逐行重复权限读取，历史 workspace 不一致的行保留旧权限守卫。终态任务和私有执行 profile 不跨桥。正式测试 `first-screen-hotspots-s96-active.test.ts` 对双方言、状态、空/不存在/无权 Issue、Chat/非 Chat、任务凭证逐字段对拍。

### S9-6：Agent 列表批量水合

`GET /api/agents` 按 workspace/归档条件取未水合候选，先过滤可见 Agent，再批量读取技能关联（有界 IN 批次，不读 Skill files）；结构化技能优先、关联创建时间/名称排序和 inline fallback 去重不变。MCP 配置的 workspace 设置/角色每 workspace 只查一次，保留 X-Agent-ID、owner/admin、Agent owner 与 always_redact_env 规则；custom_env 仍只输出键数量。native 列表和单 Agent 详情保留原路径。双方言正式对拍覆盖角色、私有/其他 workspace、两种归档参数和脱敏。

### S9-6：Project 列表投影

`GET /api/projects` 使用专用摘要投影，保持原 issue/done/resource 聚合、排序、null/归档及权限行为；instructions、delta_instructions 和修订元数据不跨桥。详情、native 列表及搜索仍用完整 Project。正式双方言用例逐字段对拍，增大两条说明至各64KiB后摘要内容和回包字节不变，详情仍返回完整说明。


## S9-6 本地详情复核

S1 的 `--ssr-cookie` 默认开启，仅在目标 origin 的浏览器内存 context 设置 HttpOnly `multimira_auth`；`--no-ssr-cookie` 用于 CSR 对照。开关不代表播种成功，逐轮以实际日志 DOM 的 seed 标记报告 SSR/CSR。`renderMs` 只量目标 Session 的窗口 `responseEnd` 到首次正常 fresh 揭示，warm 沿用 click 原点；SSR seed 没有浏览器窗口 responseEnd，缺观测或 forced 揭示记 null 并说明原因。各来源单列分位数；compare 不对不同 Cookie/实际来源或混合来源做差。

S7 整轮等待延后 API 与真实 Hub `stream.ack` 处理安静后才统计回读、附件和跳动。CI 的揭示前波次由 [zero-jump-waves.ts](../../tests/integration/zero-jump-waves.ts) 按在飞区间分组：请求直接或经其他请求重叠时为同一波，上一波全部结束后发出的请求才开下一波，结束与开始同一时刻视为不重叠；链路用每波最后结束的请求连接。S1 测速的 `computeWaves` 与 8ms 容差保持原样，历史数字仍可对比，S7 的新波次不能与旧口径直接做差。SSR 普通详情 warm 的揭示前波次 ≤2 为阻塞项；日志提前与去重后的 CSR warm 以 ≤2 为目标，未达到时逐波保留链路与原因，10/9 生产 S1 决定最终达标。cold、运行中 warm 和收件箱未读通知深链 warm 的波次只记录，保留逐请求及逐波链路；这些场景的回读=0、同附件 content≤1、跳动=0 和非强制揭示仍严格检查。`detail-locate` 验证独立详情 `?comment`，`detail-child` 验证带父 Issue 的详情，均可分别跑 SSR/CSR。150ms 渲染目标仅记录，剩余同步布局/面板注册热点不在本批改动范围内。
