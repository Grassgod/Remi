# MUL-398 C-1 预检：触发停止条件，待裁决

日期：2026-09-28。任务：`tsk_6rvnkp92vwdj`。审计与实测基线：`e47b7759`（包含 A/A2 与 MUL-462）。

## 结论与状态

C-1 **未实现、未达到交付门槛**。按任务给出的停止规则，停止默认翻转：

1. 消息分页副作用超过阈值。50 条/批时，桥调用 65 → 108，成对额外耗时 p95 **41.33ms > 5ms**；两组 p95 之差也为 **26.90ms > 5ms**。
2. 已用本地真实 PG 复现 `<background>` 单条回包 **10,495,571 B**：原 64MiB 行为正常，8MiB 拒绝。HTTP method + route-pattern 例外无法覆盖该调用。

2026-09-28 中途 steer 已接受新的例外来源：**18 条慢请求总量候选 ∪ 代码审计**，该取证缺口不再单独阻断。上面两条停止条件仍生效。完整读取 Explorer 的 `cmt_5ncm70lxe805`，未把零条单次事件理解成安全。

本 PR 只保存预检脚本和报告。`DEFAULT_DB_REPLY_MAX_BYTES` 仍为 0；未修改默认值、桥、分页算法、hermetic 守卫、部署模板或 Wiki。没有一张已经实施的过渡例外表。

## 口径

- 本机独立 PostgreSQL 17.5；仅绑定 loopback，端口 55498，数据目录含 MUL-398 与任务 id。目标以环境变量在内存中传入；报告只使用 `postgres://…` 占位。
- 脚本：`tests/manual/bench-pg-reply-c1-preflight.ts`。同一个 main 实现、同一数据库与任务，对比上限关闭和显式 8MiB；**这是默认翻转的预检模拟，不是已实现 C-1 的 before/after 验收**。
- 每档 warmup 3 + n=31；交替执行顺序，逐批成对比较。每条消息约 1KiB；每次修改已固定的 seq，保证发生真实 upsert 和回读。
- 通过真实 API 请求 `POST /api/daemon/tasks/:taskId/messages`，读取生产 `Server-Timing` 的 `dbq`，耗时包含请求处理、真实 PG 桥和响应读取。
- 额外耗时 p95 = 31 个 `(8MiB 耗时 - 关闭上限耗时)` 的 nearest-rank p95；另列两组 p95 差值，避免混用口径。共享主机负载会影响耗时；新增桥调用次数稳定，50 条档两种口径均超过阈值。
- 调用未注册远端 peer 消费者；本表量的是 daemon upsert 与回读。由于已经触发停止条件，peer 扇出与正式 C-1 新 head 测量尚未执行。

## 分页副作用

| 每批消息 | 原上限桥调用 | 8MiB 桥调用 | 原 p50/p95 ms | 8MiB p50/p95 ms | 成对额外 p95 ms | 两组 p95 差值 ms |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 10 | 10 | 6.17 / 12.26 | 6.77 / 11.58 | 5.80 | -0.68 |
| 10 | 20 | 28 | 14.30 / 23.48 | 21.03 / 27.26 | 17.05 | 3.78 |
| 50 | 65 | 108 | 32.81 / 64.04 | 41.32 / 90.94 | 41.33 | 26.90 |

MUL-462 的 `taskMessagePageRows`：Postgres 有效上限 64MiB → 8 行；8MiB → 1 行（4MiB 最坏单行预算，加 64KiB wrapper 保留）。50 条回读需要 7 → 50 次 SELECT，多 43 次，与实测桥调用差值相符。1 条档桥调用相同，成对尾延迟反映共享主机噪声，不能把它单独解释为分页退化。

## 后台读取复现

调用链：`packages/daemon/src/scheduler.ts:95` 的 `Scheduler.sync()` → `store.advanceScheduledTargetRuns()` → `AutopilotsRepo.advanceScheduledTargetRuns()`。

`autopilots-repo.ts:462` 在校验 queued target 之前执行：

```sql
SELECT * FROM multiremi_autopilot_runs
WHERE autopilot_id = ? AND status = 'queued' AND schedule_batch_id IS NOT NULL
ORDER BY created_at, schedule_batch_id, schedule_position
```

该语句无 LIMIT，也无大列投影。合成长样本为 20 个 queued run，每个 `schedule_prompt` 512KiB，`payload` 为 `{}`。**这不是 209 实测，也不是声称生产当前已有此批次**；它证明现有读取契约可让后台一次回包超限。样本直接 seed queued 行，未通过生产或调度写入接口。

| 上限 | 单条桥回包 | 结果 |
|---|---:|---|
| 原行为，env `0` | 10,495,571 B | `advanceScheduledTargetRuns()` 完成 |
| 显式 8MiB | 10,495,571 B | `PostgresReplyTooLargeError`，maxBytes=8,388,608 |

真实日志（仅保留 guardrail 必要字段）：

```json
{"event":"api_db_reply_rejected","method":"<background>","route":"<background>","bytes":10495571,"max_bytes":8388608}
{"event":"api_large_db_reply","method":"<background>","route":"<background>","bytes":10495571}
```

后台定时调用不拥有 HTTP 请求上下文。给某个 HTTP 路由添加 64MiB 例外不能恢复此路径；默认翻转后，scheduler 的 catch 只记录失败，queued target 本轮不会被派出。

## 停止时的代码审计

下表为停止前已定位的读取，**不是已定稿的完整例外表**。候选条目均需与生产证据取并集后定稿；未执行的长样本不能写成已经排除风险。行数 LIMIT 不等于字节上限。

| 类别 / method + route-pattern 或调用方 | 表与主要大列 | LIMIT / 投影现状 | 例外建议 / 依据 |
|---|---|---|---|
| GET `/api/tasks/:taskId/messages` | task_messages：content/input/output/meta | SELECT *，since_seq 仅筛选，不设 LIMIT | 必须候选；任务明列与 9/26 长样本 |
| GET `/api/multiremi/tasks/:id/messages` | 同上 | SELECT *，全量 | 必须候选；任务明列 |
| GET `/api/daemon/tasks/:taskId/messages` | 同上 | SELECT *，since 仅筛选，不设 LIMIT | 必须候选；任务明列 |
| GET `/api/tasks/:id/inspection`、GET `/api/multiremi/tasks/:id/inspection` | task_messages，同上 | organizerTaskInspection 全量 | 必须候选；helpers/organizer.ts:53 |
| GET `/api/shares/:token` | task_messages、session_events：body/metadata、issue_comments：content | shareResponse 全量消息、事件与 timeline | 必须候选；issue-shares.ts:157/161/166/173 |
| POST `/api/daemon/tasks/:taskId/messages` | task_messages，同上 | upsert 后按 taskMessagePageRows 回读 | 非例外预检已经超过耗时阈值；是否给写路由过渡例外待裁决，不能自行改算法 |
| `<background>`：Scheduler.sync → advanceScheduledTargetRuns | autopilot_runs：schedule_prompt/payload/result | active 与 queued 分别 SELECT *，均无 LIMIT | **已实测 10,495,571 B；需 Senior 裁决** |
| GET `/api/autopilots/:id/runs`、GET `/api/multiremi/autopilots/:id/runs`、GET `/api/multiremi/autopilots/:id` | autopilot_runs：payload/result/schedule_prompt | LIMIT 20（canonical runs 可至 100），仍 SELECT *；slim 是读取之后的映射 | 不能靠行数排除；字节长样本未完成 |
| GET `/api/autopilots/:id/runs/:runId`、GET `/api/daemon/autopilot-runs/:runId/gc-check` | autopilot_runs，同上 | id 单行，仍 SELECT * | 单行不代表字节安全；相关 auth/wire helpers 也会读取全行，需展开路由调用链 |
| GET `/api/knowledge/submissions`、GET `/api/knowledge/runs` | knowledge_submissions / compilation_runs | listPage LIMIT；列表已有大列投影；runs 还读 outputs | 不能以旧版请求总 db_bytes 认定当前单条超限；本地长样本未完成 |
| GET `/api/knowledge/runs/:id` | knowledge_run_sources：metadata；outputs；相关 docs | source/output 集合无 LIMIT；doc 全行辅助读取 | 候选，knowledge.ts:1213/1216/1231 |
| GET `/api/projects/:id/docs` | project_docs：body/tags/refs | listProjectDocs SELECT *，无 LIMIT；OpenViking shape 的 body 可为空 | SQL shape 必须保护；projects-repo.ts:701，不能只靠生产 body 为空 |
| GET `/api/projects/:id/docs/:ref/revisions` | project_doc_revisions：body | SELECT *，无 LIMIT | 候选；projects-repo.ts:1094 |
| service：migrationStatus/migrate 等 | project_docs：body 与 revisions | listProjectDocsForMigration SELECT *，无 LIMIT | 服务调用方上下文需继续归属；尚未当作已实测后台超限 |
| GET `/api/workspaces/:id/repos/:repositoryId/wiki` 及 batch / revisions | repository_wiki_docs / revisions：body | 部分路径元数据投影；legacy/include_body 与正文批量读取仍存在 | 正文、revision 路径仍需候选审计；D shim 未动 |
| GET `/api/workspaces/:id/repository-wikis` | run 标量、doc 元数据 | A/A2 投影与最新行筛选 | A2 历史真实 PG 模型 658,858 / 759,199 / 989,981 B；**当前 C-1 head 未复测，不能写成本轮排除证据** |
| GET `/api/issues/:id/sessions/:sessionId/events`、daemon claim 的 session projection | session_events：body/metadata | SELECT *，since/toSeq 仅筛选，无行数 LIMIT；projection budget 在读后 | 候选；issue-sessions-repo.ts:410/472，claim 路由需长样本 |
| GET `/api/issues/:id/comments`、GET `/api/multiremi/issues/:id/comments` | issue_comments：content/metadata | SQL 全量；CLI 过滤、slice 和 COMMENT_HARD_CAP 均在读后 | 必须候选；issues-repo.ts:4774/4787 |
| timeline | issue_comments / issue_activity | listIssueTimelinePage 在 SQL 分页；share 仍走全量 listIssueTimeline | 不能把 page 路径修复套到 share；长样本未完成 |
| GET `/api/tasks/:taskId/prompt` | task_prompts：prompt | task_id 单行；写入端 2MiB cap | 不能读全集；单行 JSON 6x escaping 的最坏场景仍需检查，不自行排除 |
| trace / attachment content | trace 正文未定位到独立 PG 全量正文表；attachment DB 保存元数据，正文由 uploads helper 返回 | 目前未发现 trace 直接 SELECT 集合正文 | 此项未构成放行证据；重启开发后继续核查 source/archive 入口 |

## Explorer 交接限制

依据：MUL-398 评论 `cmt_5ncm70lxe805`。209 v0.2.83 / `922b332c` 未包含 MUL-386 埋点；Docker 主窗口 2026-09-27 08:03:42.878 → 2026-09-28 18:41:42.879 +0800，单次事件 0 条。Explorer 另列 18 个慢请求总 db_bytes ≥6MiB 的候选，但**请求内多条 SQL 的总量不能代替单次最大值，也不保证集合完整**。

中途 steer 已明确授权使用上述 18 条请求总量候选的保守超集，并上代码审计。v0.2.84 含埋点；A/A2 不在 v0.2.84，但已在 main，C-1 最早随 v0.2.85 同包或更晚上线。合入前 Explorer 将补一个工作日白天的单次证据；执行者未访问 209。

## 18 条候选与 main 注册模式对照

全部来源于 `cmt_5ncm70lxe805` 的慢请求总 DB 字节 ≥6MiB，按中途 steer 保留。以下是 `e47b7759` 中注册源码的模式；相关 router 与 server 未发现 `.route()` 或 `.basePath()` 前缀改写。18 条均存在，参数名均相同，没有删除或静默丢弃条目。停止阶段尚未在最终机制中逐条测量 currentDbReplyOrigin。

| 日志候选 method + 模式 | main 注册模式 | 状态 |
|---|---|---|
| GET `/api/dashboard/usage/by-agent` | 同左，dashboard.ts:23 | 保留 |
| GET `/api/dashboard/agent-runtime` | 同左，dashboard.ts:34 | 保留 |
| GET `/api/dashboard/runtime/daily` | 同左，dashboard.ts:42 | 保留 |
| GET `/api/dashboard/usage/daily` | 同左，dashboard.ts:15 | 保留 |
| GET `/api/knowledge/submissions` | 同左，knowledge.ts:356 | 保留 |
| GET `/api/projects/:id/knowledge/recall` | 同左，projects.ts:667 | 保留 |
| GET `/api/projects/:id/docs` | 同左，projects.ts:474 | 保留 |
| GET `/api/workspaces/:id/repository-wikis` | 同左，workspaces.ts:501 | 暂保留；当前 head 尚无 <6MiB 长样本复测，不主张排除 |
| GET `/api/knowledge/runs` | 同左，knowledge.ts:398 | 保留 |
| GET `/api/issues/:id` | 同左，issues.ts:979 | 保留 |
| POST `/api/autopilots/:id/trigger` | 同左，autopilots.ts:424 | 保留 |
| POST `/api/daemon/tasks/:taskId/fail` | 同左，daemon.ts:1276 | 保留 |
| POST `/api/daemon/tasks/:taskId/complete` | 同左，daemon.ts:1247 | 保留 |
| GET `/api/inbox` | 同左，inbox.ts:34 | 保留 |
| GET `/api/tasks/:id/inspection` | 同左，tasks.ts:421 | 保留 |
| GET `/api/tasks/:taskId/messages` | 同左，tasks.ts:507 | 保留 |
| POST `/api/daemon/runtimes/:runtimeId/tasks/claim` | 同左，daemon.ts:939 | 保留 |
| GET `/api/multiremi/tasks` | 同左，tasks.ts:63 | 保留 |

例外收回条件按最新描述的 C-2：MUL-402 上线后，有埋点的单次回包按路由 <6MiB，至少观测三天且含一个工作日高峰，Explorer 只读复核后由带头大哥派单逐条收回。本轮没有排除任何一个候选。dashboard 的 58.42MiB 是请求总量；本轮没有发现或测得单条 ≥64MiB，不能把请求总量当单条结果。

## 待决定的选项

1. 对后台路径请 Senior 决定：是否给可识别的后台操作保留过渡 64MiB，或先修 queued run 的读取。后者需修改 autopilots-repo.ts，超出本轮产品代码授权范围。
2. 对分页副作用决定是否允许 `POST /api/daemon/tasks/:taskId/messages` 保留 64MiB，及怎样处理独立 peer 接收上下文；或者授权调整 MUL-462 分页策略。本轮未自行改算法或加入后台例外。

生产例外来源已按中途 steer 解决，继续实现时按 18 条超集与审计结果取并集集中写常量，不再等待单次取证作为开工前置。

## 验证与尚未执行项

- 已执行：真实 PG 预检，三档各 31 对样本，POST 均 200；后台原上限完成、8MiB 确定拒绝，并输出 rejected 行。
- 预检脚本类型检查：`env -u MULTIREMI_TOKEN bunx tsc --noEmit` 通过。自起 PG 已停止，交付前删除数据目录。
- 正式 C-1 机制、env 新语义、最终例外表、22–25MiB 各 GET/share 的 sha256 对比、peer 副作用、repository-wikis 当前 head 复测、PG/SQLite 全量与生产上线验证：**未执行，因触发停止条件**。
- 默认值与部署文档未翻转；不声称 C-1 严验通过。PR 保持 Draft，由带头大哥决定后续。
- 本预检不改变持久生产行为，无生产回滚需要。正式 C-1 以后若合入：约定回滚方式为 `git revert -m 1 <merge>`，应急方式为 `MULTIREMI_PG_REPLY_MAX_BYTES=0`，生产配置操作由贺华杰决定。

## 原始计时样本（ms）

各数组按同一 index 成对；已排除三个 warmup。保留原值以支持独立重算，数值不是生产数据。

```jsonl
{"batchSize":1,"baselineMs":[6.459145999999919,8.637612000000217,8.462461000000076,3.8214120000000094,8.083795999999893,6.165858000000071,9.682125999999926,12.26353999999992,9.008624000000054,3.641352000000097,9.895248000000038,4.371421999999939,5.379097000000002,3.387734999999793,7.954341999999997,7.05655999999999,4.234599999999773,4.662906000000021,3.565306000000419,4.132782000000134,2.734144000000015,10.291545999999926,8.911809999999605,6.638633999999911,4.9131469999997535,3.1811250000000655,14.553585999999996,3.374206999999842,3.5161779999998544,4.479779999999664,7.086261999999806],"probe8MiBMs":[11.926251000000093,6.472639000000072,6.467636000000084,10.771493999999848,10.024614000000156,6.9753420000001825,11.584133000000065,4.351096999999982,6.676701000000094,9.10842700000012,8.23136599999998,5.521411000000171,8.41228799999999,7.584843000000092,8.466812000000118,5.814013000000159,10.039088999999876,7.097846000000118,4.660687000000053,9.631192999999712,4.873393999999735,6.741782999999941,11.225134000000253,8.791907999999694,4.637568000000101,5.7547309999999925,3.033792999999605,6.774825999999848,4.014557999999852,6.395434000000023,3.404841999999917],"pairedExtraMs":[5.467105000000174,-2.1649730000001455,-1.9948249999999916,6.9500819999998384,1.940818000000263,0.8094840000001113,1.9020070000001397,-7.912442999999939,-2.3319229999999607,5.4670750000000226,-1.6638820000000578,1.1499890000002324,3.033190999999988,4.1971080000002985,0.5124700000001212,-1.2425469999998313,5.804489000000103,2.434940000000097,1.0953809999996338,5.498410999999578,2.13924999999972,-3.5497629999999845,2.313324000000648,2.153273999999783,-0.2755789999996523,2.573605999999927,-11.51979300000039,3.400619000000006,0.4983799999999974,1.9156540000003588,-3.681419999999889]}
{"batchSize":10,"baselineMs":[13.780681000000186,12.377527999999984,13.603384000000005,23.480097999999998,19.2383319999999,25.74073099999987,15.128959000000123,16.895718000000215,18.305511999999908,18.98363100000006,9.973559000000023,5.944770000000062,12.89917800000012,6.742402000000311,12.438919000000169,14.30243900000005,9.187802999999803,8.544084000000112,7.680174000000079,8.187443000000258,16.834519999999884,15.441645000000335,18.027300999999625,16.26167600000008,17.17481399999997,20.05423800000017,22.454137999999602,18.140066999999817,10.088394000000335,10.416488999999729,7.31599499999993],"probe8MiBMs":[21.714952000000267,18.062402999999904,12.195843999999852,23.574437999999645,24.695052000000032,25.652278000000024,26.876044000000093,25.336065999999846,24.452205999999933,28.38489699999991,27.263686000000234,16.92026799999985,21.034719000000223,17.865088999999898,11.511675000000196,16.445426999999654,17.511833000000024,12.150173999999879,18.163698000000295,16.1372709999996,10.963341000000128,13.067151000000194,9.132730000000265,23.33322700000008,25.07841099999996,22.63247500000034,26.51021400000036,24.033308000000034,27.14179299999978,18.121786999999586,13.476638000000094],"pairedExtraMs":[7.934271000000081,5.68487499999992,-1.4075400000001537,0.09433999999964726,5.456720000000132,-0.0884529999998449,11.74708499999997,8.44034799999963,6.146694000000025,9.40126599999985,17.29012700000021,10.975497999999789,8.135541000000103,11.122686999999587,-0.9272439999999733,2.1429879999996047,8.32403000000022,3.6060899999997673,10.483524000000216,7.949827999999343,-5.871178999999756,-2.3744940000001407,-8.89457099999936,7.0715509999999995,7.903596999999991,2.578237000000172,4.056076000000758,5.8932410000002164,17.053398999999445,7.705297999999857,6.160643000000164]}
{"batchSize":50,"baselineMs":[64.03933200000029,70.05069700000013,33.28375700000015,30.246126000000004,35.19364499999938,38.560927999999876,33.349560999999994,38.885503999999855,32.032900000000154,37.98908699999993,20.338526999999885,33.738728999999694,45.353783000000476,26.81416900000022,31.34105399999953,41.19364900000073,19.22469000000001,25.913305999999466,24.93689799999993,27.28282500000023,61.7648020000006,63.83161099999961,32.81419800000003,28.05816700000014,53.531778000000486,29.226308999999674,22.514400000000023,21.28857699999935,28.57668300000023,25.877838999999767,37.918220000000474],"probe8MiBMs":[77.42024899999979,81.82759699999997,74.61413799999991,64.14736300000004,73.14016600000014,40.46360699999968,37.8278879999998,40.22841100000005,41.317331000000195,38.11400500000036,42.59223500000007,48.38790699999936,42.396340999999666,40.15674500000023,26.348252000000684,37.34011999999984,33.024091000000226,32.1123979999993,45.6456819999994,96.99093399999947,90.93577000000005,81.14803200000006,29.606854999999996,29.94570300000032,64.97012199999972,32.17351500000041,44.37707000000046,37.17922400000043,34.89605699999993,46.7474200000006,41.062143999999535],"pairedExtraMs":[13.3809169999995,11.776899999999841,41.33038099999976,33.90123700000004,37.94652100000076,1.9026789999998073,4.478326999999808,1.3429070000001957,9.28443100000004,0.1249180000004344,22.253708000000188,14.649177999999665,-2.9574420000008104,13.342576000000008,-4.992801999998846,-3.85352900000089,13.799401000000216,6.199091999999837,20.70878399999947,69.70810899999924,29.170967999999448,17.316421000000446,-3.207343000000037,1.887536000000182,11.438343999999233,2.947206000000733,21.862670000000435,15.890647000001081,6.319373999999698,20.869581000000835,3.1439239999990605]}
```
