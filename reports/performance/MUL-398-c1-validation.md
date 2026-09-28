# MUL-398 C-1: 8 MiB 默认与 64 MiB 过渡例外

日期：2026-09-29。任务 `tsk_499cfoxcyliw` 续跑。PR [#318](https://github.com/Grassgod/Remi/pull/318)，保持 Draft，等待 QA 与带头大哥合入。数据库目标仅本地 `postgres://…`；本报告不是 209 实测或上线证明。

## 基线、授权与停止条件解决

- 在受管 `agent/MUL-398` 上从 `4c077d60` fetch 后 merge `origin/main b95dd2fa`，合并提交 `4d370c6b`，无冲突。未创建/切换/重置分支，没有 rebase/force push。
- 网关中断后补审计提交 `439a42cc`，随后 merge `origin/main a30a8817`（含MUL-412/459/466），合并提交 `84831dd0`，无冲突；在合并后的代码上重跑调用链审计并补两条新daemon decision入口。
- [预检停止报告](MUL-398-c1-preflight-stop.md) 与原脚本保留；预检 main `e47b7759` 的结果不是本轮 before。本轮 before 是 main `b95dd2fa`，env `0`；after 是 C-1 实现，env 未设置。
- 预检两项停止条件按续做裁定及 Senior `cmt_tvxpad98uqtz` 解决：独立 `<background>` 项保留64 MiB；daemon POST messages 与 HTTP peer 也保留64 MiB，分页算法不改。
- 完整读过 MUL-398「授权更新」「范围 C」「验收3」、Explorer `cmt_5ncm70lxe805`、停止评论 `cmt_ivh834b1tmc0`、裁决请求 `cmt_w4doexd8w1w6` 和正式裁决 `cmt_tvxpad98uqtz`。

## 机制与环境语义

`DEFAULT_DB_REPLY_MAX_BYTES = RECOMMENDED_DB_REPLY_MAX_BYTES = 8,388,608`。未设置/空值使用8 MiB；显式 `0` 关闭可配置上限；非整数、负数、不安全整数回落默认值，缓存解析时打一行告警，只有原 env 值是可变内容。显式非负整数按字节解释。物理共享缓冲仍是64 MiB，`0` 不扩大它。

集中 `DB_REPLY_TRANSITION_EXCEPTIONS` 的键为 `METHOD route-pattern`，命中时有效上限为现有 `RESULT_BUFFER_BYTES`（67,108,864）。没有新增 env 开关。env 解析仍缓存；每次有效值计算多一次上下文读取和一次 Set 查找。`postgresReplyMaxBytes()`、桥拒绝判断与 MUL-462 页大小使用同一个有效值。

桥仍在 `TextDecoder` / `JSON.parse` 前抛 `PostgresReplyTooLargeError`，输出 `api_db_reply_rejected`；错误不拼接SQL。关闭指标仍运行 `requestContext.run(state, next)`，只停止计数、Server-Timing 与请求指标日志，护栏日志仍可输出。这样 HTTP 请求不会因关指标被误分类为后台。`api_large_db_reply.exempt` 布尔字段**未做，留 C-2**。

请求内 fire-and-forget 的异步工作会继承路由 ALS 上下文；同一函数由 HTTP 触发和由 timer 触发可能获得不同有效上限。C-2 必须按触发方看数据，不能仅按函数名撤销例外。

## 审计与最终例外表

完整逐条审计见 [394项例外表](MUL-398-c1-exception-audit.md)：每条列出 method+实际Hono模式、来源、表/大列、LIMIT/投影、具体调用方、进表理由及收回条件。集中常量由生成脚本读取，正式用例逐项验证393条HTTP模式真实注册和 `currentDbReplyOrigin()` 产出；没有前缀改写、参数名替换、消失条目或静默丢弃。

来源为 **209请求总量18条超集 ∪ 审计 ∪ 后台裁定 ∪ daemon POST / HTTP peer分页裁定**。209仍为v0.2.83，缺少单次回包埋点；零条事件不代表安全。旧日志只覆盖 >500ms 慢请求，请求 `db_bytes` 是所有SQL回包总和。快请求风险由代码审计补足，行数 LIMIT 或读后裁剪不能证明字节有界。

覆盖 task/chat messages、autopilot payload/result/schedule_prompt、knowledge、SQL文档/修订正文、task prompts、session events/results、comments/timeline、归档metadata及相关actor/getter/写后回读。Trace/归档文件正文在外部存储；SQL归档metadata仍无字节cap，因此归档相关路径也保守进表。本轮没有排除已识别风险项，repository-wikis 的原18候选亦保留。

补全审计发现原166项遗漏项目指令、agent指令、skill正文以及鉴权/写后回读的辅助路径。`ProjectsRepo` 的 `p.*` 含无字节cap的instructions/delta_instructions；`AgentsSkillsRepo` 的lite只跳过skill文件水合，agent行仍为`SELECT *`；skill/file集合正文也无总字节界。使用 [解析调用链脚本](../../tests/manual/audit-pg-reply-c1-callers.ts) 通过TypeScript checker解析实际声明和import别名，对706个字面量handler记录366条可能大列读取，见 [callers.json](MUL-398-c1-callers.json)，补入226条原表未覆盖的HTTP入口，再补新main两条daemon decision入口。条件、鉴权和回调路径保守纳入，不是228条生产超限证据；未根据静态分析排除任何路由。正式PG护栏用例也覆盖新增projects/agents/skills例外的24 MiB回复。

四条附加HTTP入口来源明确为 `advanceScheduledTargetRuns` 无界读：multiremi run、run-scheduled、trigger 与 repository wiki build。收回条件与后台项相同。另有 canonical autopilot trigger 已在18条内。**Senior对真实规模的判断是该读远小于6 MiB（按autopilot分组）；20×512 KiB只是契约演示，不是209生产风险实测。** 本轮未访问209、未重新查库验证该规模判断。

一般HTTP例外：读有界/投影修复同包或更早上线后，有埋点单次回包<6 MiB，至少三天含一个工作日高峰，Explorer复核后逐条收回。daemon POST messages 和 HTTP peer：MUL-402去掉该读路径，或另单按实际行宽算法，任一成立即收回，不必等待三天。本 PR 不改MUL-462算法。

### 后台读者收回清单

以下是Senior要求核查的九类，不声称本轮逐个长样本测量。独立peer直调也无HTTP上下文；真实拆进程peer接收走HTTP例外。

| 读者 / 调用方 | C-2 要核查的读取 |
|---|---|
| Scheduler.sync → advanceScheduledTargetRuns | active/queued run 的 schedule_prompt/payload/result 全行集合，queued读有界是收回前置 |
| ScmPollingScheduler | SCM polling 的事件、run与触发辅助读取 |
| IssueTitleScheduler | issue/session/message 上下文读取 |
| messaging scheduler | 消息会话、历史和绑定读取 |
| outbound-dispatcher sweep | outbound队列/投递payload读取 |
| task-capability-monitor | 活动任务与能力检查 |
| repository-wiki storage job | SQL文档/修订正文及迁移辅助读取 |
| WS message处理器 | browser订阅scope校验、daemon heartbeat及任务辅助读取 |
| 启动迁移 | 如 migrations.ts 的 feishu 整表回填，未拥有请求上下文 |

后台收回必须先使queued读有界，并取得v0.2.84之后后台单次回包<6 MiB数据；修一个queued读不等于其余八类自动安全。常量中的后台项独立、可一行删除，没有别处分散特判。`autopilots-repo.ts` 未改。

### 分页调用方逐一对照

| API / 调用方 | 实际上下文 | before / after PG页大小 | 说明 |
|---|---|---:|---|
| postgresReplyMaxBytes → PgBridge SQL回复检查 | 每次SQL当前请求，或无上下文后台 | 64 MiB / 表外8 MiB、例外64 MiB | 同一个有效值，不另建桥上限 |
| taskMessagePageRows → TasksRepo.getTaskMessagePageRows | 继承调用方上下文 | 按上下文 | SQLite恒8行 |
| TasksRepo.appendTaskMessages 内 this.getTaskMessagePageRows | 唯一HTTP入口 POST /api/daemon/tasks/:taskId/messages | 8 / 8 | 例外保留MUL-462回读 |
| MultiremiStore.getTaskMessagePageRows | 纯转发到TasksRepo | 按调用方 | 不引入新上下文 |
| realtime-fanout reference subscriber → store.getTaskMessagePageRows | peer.receive同步调用：POST /internal/peer/events | 8 / 8 | 单独HTTP例外，不能误写成后台 |
| 同一reference subscriber独立直调 | 无请求上下文，<background> | 8 / 8 | 后台独立项保护 |
| 非例外HTTP正式用例 | fixture GET /api/c1/nonexception | 8 / 1 | 没有另一个产品分页调用方；若以后新增，静态守卫失败 |

`postgresReplyMaxBytes` 产品调用仅桥和 `taskMessagePageRows`；页大小的实际业务消费者仅append回读与peer引用消费。静态AST守卫同时固定store纯转发位置，新增消费者须同时处理例外或算法。审计未发现另一非例外业务消费者，因此没有遗漏需要单独量的缩页路径。

## 分页副作用实测

PostgreSQL17.5、Bun1.3.14、本机独立loopback实例。相同脚本/fixture、同版本PG，两进程分别导入main和本PR实现，warmup3+n31，交替执行顺序，p95为nearest-rank；额外p95为31个成对after-before值。原始每对数据在 [measurements.json](MUL-398-c1-measurements.json)。

daemon消息约1 KiB。peer引用读取相同50条消息，每条正文列合计589,822 B（>512 KiB）；降级事件本身只带task_id/seq_start/seq_end，不把巨大正文塞回引用。两侧始终交付N个browser帧，页大小8，消息 SELECT=ceil(N/8)。总桥调用还包含每页scope/identity查询，故不是仅消息SELECT数。

| 路径 | N | 总桥调用 before → after | 消息SELECT | before p50/p95 ms | after p50/p95 ms | 成对额外p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| daemon POST | 1 | 10 → 10 | 正式页大小断言8 | 10.36 / 13.45 | 9.64 / 12.26 | 6.07 |
| daemon POST | 10 | 20 → 20 | 同上 | 15.38 / 22.08 | 15.05 / 24.00 | 8.51 |
| daemon POST | 50 | 65 → 65 | 同上 | 43.74 / 61.67 | 42.90 / 60.13 | 27.75 |
| 独立peer / background | 1 | 4 → 4 | 1 → 1 | 5.87 / 7.85 | 6.34 / 8.05 | 2.52 |
| 独立peer / background | 10 | 7 → 7 | 2 → 2 | 27.22 / 30.90 | 26.28 / 29.98 | 3.33 |
| 独立peer / background | 50 | 22 → 22 | 7 → 7 | 126.10 / 150.38 | 126.04 / 144.24 | 26.49 |
| HTTP peer | 1 | 4 → 4 | 1 → 1 | 6.01 / 7.88 | 5.38 / 7.15 | 2.86 |
| HTTP peer | 10 | 7 → 7 | 2 → 2 | 25.69 / 30.26 | 26.34 / 31.07 | 5.45 |
| HTTP peer | 50 | 22 → 22 | 7 → 7 | 124.92 / 141.42 | 124.18 / 154.10 | 32.51 |

**不声称尾延迟严格≤5ms**：成对p95有超线档位，主机同时有其他开发/QA；即使daemon 1条查询相同也有6.07ms成对尾差。daemon三档p50略降、50条两组p95也下降；HTTP peer 50条两组p95差12.68ms。页大小和查询次数在全部31对样本完全相同，没有预检的43次新增SELECT。按续做指令「共享主机噪声时以查询次数相同为主证据」交付原值，不能把它改写为≤5ms或单凭尾差证明回归；最终验收由QA判断。

## 24 MiB长消息与护栏

96条×256 KiB content=25,165,824 B（24 MiB）。固定ID、seq、时间、fixture随机源，两个版本各自真实API +真实PG桥；before env0，after env未设置。下表所有status均200，原始响应体SHA-256完全相同，db_bytes逐字节相同；没有按key规范化替换原始字节比较。

| GET实际路由模式 | 响应B | db_bytes before=after | dbq | SHA-256 before=after |
|---|---:|---:|---:|---|
| /api/tasks/:taskId/messages（无since_seq） | 25,185,688 | 25,189,256 | 6 | 076b74e8a4645ab32e105ff5c4ed603f1f44435305060b8e9c0834c83004992d |
| /api/multiremi/tasks/:id/messages | 25,185,701 | 25,189,256 | 6 | 47947f30825d963faa3cdcf2aaa95c8e699570336695e2336f17e3110e2fd42e |
| /api/daemon/tasks/:taskId/messages | 25,178,488 | 25,187,343 | 4 | 6ab5dfc7871caf759702bfbcd7430f5b684ea4dd6b2398c0980a2cf6c07dbb32 |
| /api/shares/:token | 25,191,557 | 25,203,186 | 37 | 06a419dbbcb90cf0d4e8c83df85fd7e41f3a9c25c7bf8a6805ddf25da7724061 |

单次消息SQL回复25,186,092 B，8–64 MiB被例外放行。非例外证据使用测试fixture HTTP路由 `GET /api/c1/nonexception`（没有增加产品API），真实 `SELECT repeat(...)` 单次回复9,437,216 B：main200，after500，并输出 `api_db_reply_rejected` / max_bytes8,388,608；总db_bytes9,437,659。正式测试同时在metrics=1/0两种环境下验证24 MiB例外放行和9 MiB非例外拒绝，enabled时 `dbp=0.0` 证明拒绝未进入decode/parse计时。

预检同样20×512 KiB queued prompt，单次回复10,495,571 B；before/after均完成、无rejected，页大小8。它只是合成契约长样本，未把它描述为生产当前批次。

### Repository-wikis模型复测

引用 [A2报告](MUL-398-repository-wikis-a2-db-bytes.md) 的1842观测/1443构建行、26/46/92仓库模型；A/A2已在main（d905961b/d6714966），晚于v0.2.84，与C-1同包或更早上线。不能声称Explorer取证时生产已生效。

现有scale脚本的MeteredDb补透传dialect，避免新迁移把PG当SQLite；两侧用相同脚本，不改产品查询。warmup1+n5，after默认env未设置；本轮仍保留该路由64 MiB例外，但每次请求所有SQL总量<1 MB，所以每条SQL亦<6 MiB且符合8 MiB。原始同口径数据在 [wiki-measurements.json](MUL-398-c1-wiki-measurements.json)。

| 仓库数 | db_bytes before → after | dbq | before p50/max ms | after p50/max ms | db_parse_ms before → after |
|---|---:|---:|---:|---:|---:|
| 26 | 661,146 → 661,146 | 136 | 146.77 / 150.17 | 135.79 / 143.51 | 4.4 → 4.1 |
| 46 | 763,247 → 763,247 | 236 | 242.34 / 256.58 | 246.95 / 261.21 | 5.9 → 4.7 |
| 92 | 998,077 → 998,077 | 466 | 423.57 / 478.32 | 435.39 / 502.32 | 10.1 → 9.1 |

比A2历史989,981 B略大；当前main已有后续改动，本轮以相同main基线与fixture比较，C-1本身前后没有变化，未单独归因历史差值。92档离1,000,000 B只余1,923 B，不能外推更多仓库仍<1 MB。26档保存的响应按key排序完全相同，SHA-256 `704b69e098b787b71727474fb753496cb41bd9b3534545c269cf6c5fcbda8829`；脚本只保存第一档完整响应，不声称另两档执行了完整响应SHA对比。

### 单次接近/超过64 MiB

本轮测量未发现单次接近或≥64 MiB；最长消息约24 MiB，queued约10 MiB。209 dashboard58.42 MiB为请求总量，不能当作单次。无界读增长超物理64 MiB仍是既有风险，C-1不修，也没有把env0描述成无限共享缓冲。

## 正式测试与变异

新增正式用例涵盖env取值/非法告警、393条真实注册Hono模式、background独立项、三上下文8行/普通1行、metrics0真实PG护栏、queued长样本。生产/测试默认一致的hermetic守卫保留；新增AST调用方守卫。

静态调用链审计在CI中以 `bun tests/manual/audit-pg-reply-c1-callers.ts --check` 运行，当前实测8.4秒；新增候选必须进表。删去新main的一条daemon decision例外后架构测试1 pass/1 fail，报缺少该route key；恢复后重新验证。

首轮PG全量为3898 pass / 2 fail，均是既有peer小上限探针：原来没有请求上下文，现在会命中已授权的后台64 MiB例外。保留其原断言与样本，将小上限探针包在非例外fixture请求上下文中，真实peer入口的8行由C-1正式用例单独覆盖。该文件随后7 pass / 0 fail；128 KiB探针仍拒绝262,384 B回包并发送header-only refetch，未改分页算法、未跳过用例或放宽断言。最终全量结果以下述最终head检查为准。

| 变异（运行后立即还原） | 正式失败证据 |
|---|---|
| 删background项 | 4 pass / 2 fail；后台有效值Expected67,108,864 Received8,388,608；20×512 KiB queued样本抛PostgresReplyTooLargeError |
| getter忽略上下文只用env | 1 pass / 5 fail；例外HTTP Expected200 Received500；queued长样本拒绝；例外页大小/值断言失败 |
| 指标关闭时return next() | 4 pass / 2 fail；非例外真实PG Expected500 Received200，关闭指标页大小8而非1 |

最终提交后的串行验证与最新SHA的CI结果以MUL-398交付评论/PR checks记录为准：tsc、arch、docs:test/check、CLI checker、snapshot，以及真实PG全量和SQLite全量（默认hermetic8 MiB、不额外设置replylimit）。报告不把仍未执行的最终检查写成通过。

## 范围与回滚

产品改动仅 `observability/request-metrics.ts` 和 `store/db/postgres.ts`；分页/queued run实现不改。其他为测试、测量脚本、docs/dev/performance.md、deploy/docker/api.env.example与报告。没有迁移、新配置开关、D shim或Wiki改动。

正式合并后回滚：`git revert -m 1 <merge>`。应急：`MULTIREMI_PG_REPLY_MAX_BYTES=0`，仍受原64 MiB物理缓冲约束。改209配置由贺华杰决定，本轮不执行。PR不转Ready、不合入；合入前新的单次生产数据由带头大哥/Explorer补证，可追加集中常量与对应正式用例。
