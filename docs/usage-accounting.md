---
title: 统一用量与价格契约
status: active
summary: 从可靠采集到规范化事实、SQL 报表、价格版本和可恢复历史迁移的当前实现与边界。
---

# 统一用量与价格

共享类型在 [usage-accounting.ts](../packages/contracts/src/usage-accounting.ts)，写入和 schema 在 [store/usage-accounting.ts](../packages/server/src/store/usage-accounting.ts)，报表与价格 SQL 在 [UsageAccountingRepo](../packages/server/src/store/repos/usage-accounting-repo.ts)。Web 的 Dashboard、Runtime 用量页和 Runtime 列表费用单元格共同读取 `GET /api/usage/report`。浏览器不维护模型价格表，也不从 localStorage 读取计价事实。

## 消费、上下文与未知

`actual_total_tokens` 只等于已记录的 input、output、cache read、cache write 和 `actual_unsplit_tokens` 之和。拆分不可得但确有实际累计消费证据时，采集器可以保留 actual unsplit；不会用上下文占用补出拆分。`reportedTotalTokens` 是原始报告证据，不再次相加。`contextTokens` 独立记录上下文占用；报表只取 `context_peak_tokens` 最大值，不求和、不计费。

字段的 `null` 表示未知，明确上报的 `0` 才表示已知零。SQL 汇总返回已知小计和 `unknown_task_count`，前端对没有消费观测的零小计显示 `—`，保留已知正数小计和缺失提示。只有 context 或没有 telemetry 的 task 属于未知消费。存在独立 context 观测不会使已有完整消费观测变成未知。旧 task JSON 的 total 语义不确定：仅保留为 reported total 和原始审计，不能直接解释为消费或上下文峰值。

模型表保留实际 `model`、`requested_model` 和 `model_provenance`。实际模型未上报时显示请求模型及明确提示；不会读取当前 Agent 配置伪造历史实际模型。未知实际 SKU 不匹配公开价格。只有管理员明确设置 `requested_model_alias=true` 的 configured 价格，才可以按同连接的请求模型计价。

## 可靠写入与运行归属

[采集器](../packages/acp/src/usage-collector.ts)输出可计量单位，[task usage ledger](../packages/server/src/worker/task-usage-ledger.ts)为一次执行建立稳定 run ID，`task.start` 携带 `usage_run_id`，服务端在接受开始的同一事务固化认证 Runtime、执行项目和当前 active run。daemon 只有收到 `execution_authorized:true` 的 start ACK 才进入 provider 执行；首次 ACK 丢失后旧 run 可排出历史重放，但换机、终态或 active run 已变时返回 false，不重新运行模型。网络不可用期间暂停 provider 启动；等待有超时与取消，不因超时继续执行。可靠报告通过 daemon outbox 发送 `usageSnapshot`；换机后原 Runtime 的 start 重放和迟到用量按不可变 run 绑定授权，不允许另一个 Runtime 冒报。失败、取消和正常结束前已有消费都可检查点持久化。验证或相同 revision 内容冲突不可重试，数据库等基础设施故障可重试。

换机后过期 execution 报告收到 `authority_revoked` 时，outbox 丢弃同任务后续 execution 报告并保留 usage，让每个用量帧独立通过当前 daemon 身份与不可变 run 授权。单个 usage 帧被拒绝时仅持久阻塞该帧，不将拒绝伪装为送达，也不阻塞其他已绑定 run 的用量。重启可以恢复旧版因 execution 拒绝而封锁的 usage，但不绕过服务端全局身份撤权。

不可重试的 `invalid_report` 只持久停放该 usage 或 execution payload，并向等待者返回真实拒绝；后续 usage 仍单独接受鉴权与验证。批量 message payload 被拒绝时，其全部参与记录保留为诊断。重启可重新逐帧检查旧版由明确 `invalid_report` RPC 封锁的任务分区，HTTP 身份撤权造成的分区屏障保持生效。

用量表的 `task_id` 是 MUL-493 的执行尝试 ID，外键指向 `multiremi_turn_attempts`；`run_id` 区分该尝试内的 provider 执行，轮身份从尝试的 `turn_id` 获取。启动时先完成轮/尝试模型迁移，再建立用量表，不恢复旧任务表或退休接口。

单位主键是 `(task_id, run_id, unit_id)`。更高 unit revision 替换，同 revision 同内容重放忽略、不同内容拒绝，较低 revision 忽略。整个 snapshot revision 只控制 run 的 complete/revision 元数据：较旧 snapshot 中不同的新单位仍可接受，未包含的单位不会删除。分块终态报告允许同 snapshot revision 的 complete 从 false 单调升级为 true，不允许同 revision 回退。不同 run 中已证明独立的执行消费相加。旧报告边界在任务锁内用上一 revision 加一，不把毫秒时间戳写入 PostgreSQL INTEGER。

`multiremi_usage_unit_receipts` 持久保存单位的最高 revision、规范化不可变字段和 accepted/parked disposition。即使重复事实被撤下或冲突更新仅停放，更旧重放也不能重新插入消费；同 revision 改变事实仍拒绝。升级已有冲突审计时懒恢复停放水位。已建立强请求或 meter owner 的更新发生竞争时，保留此前已接受的小计与 owner 区间，并审计停放新版。只有同一稳定单位的旧弱证据没有强身份、且消费与金额分量一致，补出的强证据明确识别其为已有 owner 的重复时，才撤下该弱事实；不以任意冲突更新删除已确认消费。

真实上游 `providerSessionId` 与 `providerRequestId` 建立跨 task/run 的请求身份；调用引擎、工作区、连接也是命名空间。同请求的 token 与独立金额证据可以在同一 owner run 保存，跨归属竞争不能再加一份消费。两个明确不同连接可区分；未知连接不能证明独立，因此与相同 session/request 的已知连接竞争。PostgreSQL 在 domain 写入前按稳定顺序取得身份事务锁，持久 owner 保证并发只认领一次。竞争证据及此前弱证据写入 `multiremi_usage_identity_conflicts`，报表保留规范 owner 的已知小计，双方显示 `identity_conflict_task_count` 和 incomplete，不把归属争议伪成零消费。上下文和 legacy 聚合不能认领请求身份。

Codex 累计通知使用 `identityKind=cumulative_meter`，真实 session、`providerObservationId` 和 `meterEvidence` 保留 epoch、before/after 及可用 last 的五类规范计数；turn ID 不是 request ID。相同 meter namespace/epoch 内相邻 `(before,after]` 区间可累计，重叠观察跨 run 只保留审计而不另加消费。不同形式的 compaction 时间戳与 item/turn 身份可能指向同一次重置，重叠时保守判为竞争。没有可靠 session、baseline 或 epoch 的证据不建立强身份。计量器 owner 用标量区间检索，证据 JSON 供审计，不用于正常报表逐行解析。

用量报告按字节与单位数分块，避免长任务超过 daemon 的 1 MiB frame 上限。单个 turn 金额关联的请求列表也可分块：`coverageExpectedCount` 和 `coverageSha256` 固定完整排序列表的数量与 SHA-256（UTF-8 `JSON.stringify(sortedIds)`），各块保留同 unit/revision、金额和不可变事实，仅发送列表子集。同 revision 的列表块幂等追加，更新 revision 清空旧关联；较旧 revision 不回退。数量及哈希验证完成前金额只保留诊断，不能提前计入已知费用或与配置估价相加。所有块持久化后才发送 run 完整标记。采集器在金额观测与 turn settle 时关联覆盖，避免每个请求写入不断增长的完整列表。

单位 `purpose` 默认 `agent`，辅助进度摘要使用 `progress_summary`，与主执行共享已认证的 run 和 ledger。辅助请求保留它真实返回的 provider/model；独立连接未知时不套用主云友连接费率。模型表按 purpose 分组并展示摘要用途，CSV 保留该字段。已有消费与辅助请求尚未结束时不能提前将 run 标为完整。

`provider` 表示调用来源/执行引擎或协议族（如 codex、claude、openai），不代表底层模型厂商；同模型经不同协议和连接调用可有不同计价键。辅助摘要独立连接使用 `runtime:<runtimeId>:progress-summary:<claude|openai>`，只有明确共用 workspace relay 时才复用它原有 engine 的连接标识。

`multiremi_usage_run_scopes` 固化每个 run 的 workspace、Agent、Runtime 和执行项目，单位保存同样的标量归属及 runtime/project provenance。现场项目解析顺序为 Issue、项目型 schedule target、Chat；独立 Runtime 工作区不附加项目。报表按单位保存的 Runtime、项目和 Agent 分组、过滤，旧 run 重放不能改归属。任务生命周期 scope 跟随新 active run，已结束任务和旧 run 重放不能移动它。尚无 scope 的排队任务可以使用当前任务绑定描述生命周期；已有未知 scope 不从当前 Issue 猜测项目。

历史恢复保留已有证据：不可变 autopilot schedule target 和 Chat 项目绑定可以恢复项目；未标记 cross-switch 的 attempt=1 task 优先采用已保存 trace owner，其次采用已有 started_at 的 task.runtime_id，标为 `trace_owner` 或 `task_record`，不是当前 Agent 配置。重试或跨 Runtime 痕迹无法区分请求归属时保留 unknown。维护计划可以传入更强的 archive manifest/原始报告 scope 证据。缺证据才保存 null；Runtime 表展示 recorded owner、trace/archive owner、未知或混合出处，不把 recorded owner 误称每个请求均已独立证明的执行者。

## 报表与两条时间轴

[路由](../packages/server/src/api/routers/usage-accounting.ts)按 workspace 鉴权，并验证 Runtime/项目过滤器属于该工作区。参数为 `workspace_id`、`days`（默认 30，支持 `all`）、`since`、`until`、`project_id`、`runtime_id` 和 IANA `tz`。范围起点包含、终点不包含；天数按查看者时区的日历日，支持夏令时。

Runtime 列表/详情和 task/status/Issue 用量兼容响应同样只从规范化标量单位聚合；旧 task JSON 仅在迁移审计和弃用客户端的幂等上报入口读取。旧形状的 consumption 日/小时接口按单位 occurred_at、固化 Runtime/项目过滤；任务活动与时长接口按生命周期过滤。完整的未知覆盖、参考金额和出处使用 report 接口，不能从旧形状缺失字段推断已知零。

消费和金额按 unit 的 `occurredAt` 过滤、分日，但时间证据并不总是逐请求时间。`time_provenance` 区分上游时间 `provider_timestamp`、采集时间 `observed_at`、历史任务归属时间 `task_attributed`、未知或混合。旧 task 聚合没有逐请求时间时保留任务结束/已有记录归属日，不拆成虚构的逐日请求；报表返回 `task_attributed_tokens` 与 `task_attributed_task_count`，`time_basis.historical_aggregates=task_attribution_at`，页面显示明显历史归属日提示，CSV 同步保留时间出处。完成、失败、取消任务按各自生命周期时间统计；时间缺失时回退到已有 updated/created 时间，不能据此推断精确结束时刻。`task_daily` 独立承载任务趋势和已结束任务耗时。active、queued 描述当前状态快照，不代表已完成。响应 `time_basis` 声明这些口径。

`summary.task_count` 是当前报告范围内相关轮的 distinct 数；同轮重试的所有尝试保留消费，但生命周期只计当前尝试，时长从轮开始到最终结束。一个 task 可以跨日、跨模型、跨 Runtime，因此各组 task count 不可加总；状态与耗时也不能由 token 日期推导。actual token 分量、priced/unpriced tokens、同币种已知金额是可对账的加性指标；context peak、task count 和比例不是。每日 token 表中没有消费的生命周期日可以只出现在 `task_daily`。

金额按 `known_cost_by_currency`、公开参考价 `reference_cost_by_currency` 和 SDK 估算 `sdk_estimate_cost_by_currency` 三栏输出，不将参考价与 SDK 估算相加；范围未知的金额仅保留诊断证据，不同货币各自保留，未计价部分不当成零或换汇合并。`priced_tokens`/`unpriced_tokens` 和比例表示 token 数量覆盖，不表示金额覆盖。`complete` 同时检查未知消费、未计价 token 和所选 Runtime/项目范围内的逐 run 完整性；完成但空或仅有 context 的 run 仍是未知消费，不能被同 task 的另一轮已知用量掩盖。零实际消费的 token 覆盖比例为 `null`。模型行的状态与时长同样受生命周期窗口约束。

## 价格版本与金额来源

`GET/POST /api/usage/prices` 读取、追加版本，`PATCH /api/usage/prices/:id` 只允许关闭或缩短 `effective_to`。写操作要求 workspace 管理权限。精确价格键为 workspace/provider/model/connection/requested-alias；版本使用 `[effective_from,effective_to)`，重叠区间拒绝，追加较新版本可关闭更早的开放版本。原价格和起始时间不被覆盖，`pricing_revision` 随成功写入增加。

五类 per-million rate 独立允许 null 和明确零。缺价分量保留未计价 token；已有配置分量的金额作为已知小计。单位明确对应 request/turn 范围的 `costAmount` 与 `costCurrency` 另存 `costSource`：`provider_reported` 为提供商报告金额，仍不是实际支付/代理扣款凭证；`sdk_estimate` 只进入独立 SDK 估算栏，不提高计价覆盖率；`unknown` 不进入金额统计。不能把范围不明的会话总金额重复分配给多个 task。

独立的提供商金额单位通过 `coveredUnitIds` 明确关联同一 run 内被收费的 token 单位；金额与 token 在同一单位时隐式覆盖自身。覆盖关系保存在标量关联表，随金额单位 revision 原子替换。可确认且不重叠的提供商金额优先于其覆盖 token 的配置价，这些 token 仍计入计价覆盖率，配置价金额不再相加。缺少目标、调用来源/连接不一致或多笔金额覆盖同一 token 时，金额不进入已知小计，且报表保持不完整；不根据接收顺序、同模型或同一 turn 名称猜测关联。SDK 估算继续单列，不参与提供商金额优先级。

request 范围金额带有真实 session/request 身份时，其覆盖目标已有的强身份必须一致；不能用请求 A 的金额支付请求 B 的 token，或将 request 金额对应累计 meter 观察。矛盾关联作为诊断保留，不启用该金额或声称完整计价。该检查在报表 SQL 中使用当前规范证据，因此金额先到、token 先到及后续补出强身份均采用相同口径；turn 的多请求覆盖仍需明确关联，不猜请求级拆分。

长 turn 的覆盖关联可分块发送：每块保持同一金额单位与 revision，仅携带部分 `coveredUnitIds`，并同时声明完整集合的 `coverageExpectedCount` 与 `coverageSha256`。哈希为排序后全部 ID 数组的 JSON UTF-8 的 SHA-256。服务端持久化幂等追加同 revision 的关联，数量及哈希全部吻合后才启用该金额；缺块期间金额只保留诊断，报表不完整。较新单位 revision 重置覆盖集合，旧 revision 不参与新集合；不可变金额字段或承诺冲突拒绝写入。普通完整数组由服务端生成同一承诺，重放不能偷偷改变目标集合，金额始终只计一次。

最终哈希也按稳定游标每页最多 512 关联读取并增量计算，不一次拉回完整 ID 集合。持久化固定宽度 UTF-16 排序键并使用数据库二进制排序，确保 SQLite、PostgreSQL 与 JavaScript `sort()` 对合法 Unicode ID 的顺序一致；旧关联的排序键同样按有界页补齐。

费用覆盖目标只有一个模型分组时，金额归入该目标模型；turn 金额覆盖多个模型且未提供可验证分配时，保留独立 `model_provenance=unallocated_cost` 金额桶，不按 token 比例猜分配。被覆盖的各模型金额保持缺失，页面显示 `—`，并返回 `cost_allocation_complete=false`；token 覆盖 100% 不代表模型金额归属完整。未分配金额桶仍参与同币种对账，各模型行与该桶的金额之和等于报告已知小计。金额 SQL 只聚合非 null 数值，明确零金额可以显示为零。

`configured` 表示管理员确认的连接费率；`published` 表示有 source URL 的公开参考价，只有实际 provider-reported SKU 可以匹配。两者都通过服务器统一计算，但 published 结果仅进入参考金额，不提高覆盖率或宣告计价完整。公开 catalog 不自动等同代理价。服务层级、长上下文门槛、缓存时长、时段和代理倍率会改变适用价格；当前五类 flat rate 没有这些条件维度，不自动导入有条件 catalog 或把当前费率倒填未知历史。未确认适用的部分保持 unpriced。

## CLI 与受控历史迁移

用户命令由 [CommandRegistry](../apps/remi/cli/commands/operations.ts)注册：

```bash
remi dashboard usage report --workspace <id> --days all --tz Asia/Shanghai --json
remi dashboard usage report --workspace <id> --project <id> --runtime <id> --since <ISO> --until <ISO> --json
remi dashboard usage prices list --workspace <id> --json
remi dashboard usage prices set --workspace <id> --file <approved-price.json> --json
remi dashboard usage prices close <price-id> --workspace <id> --effective-to <ISO> --json
remi dashboard usage reconcile --workspace <id> --days all --tz Asia/Shanghai --json
```

`reconcile` 对一次服务端报告的日、Agent、模型、Runtime 加性消费指标及每个币种金额作对账；不对 distinct task count 求和。旧统计 API/CLI 路径保留兼容投影，但事实来自规范化表，Web 不使用旧统计查询。

Compose 更新前会校验 API 的 `healthcheck.start_period >= 迁移预算 + 60 s`、宿主更新器等待 `>= start_period`，即默认 `300 s + 60 s <= 360 s <= 360 s`。调大预算时要同步调大后两者；宿主 compose 文件先更新，再安装新版更新器。大数据集推荐先用新版 API 镜像运行 `scripts/migrate-usage-accounting.ts --execute` 准备标量迁移。配置、上线顺序和 Docker 复现入口统一见[部署切换说明](../deploy/README.md#usage-accounting-startup-cutover)。

启动先创建 schema，释放全局 migration 锁后自动执行必需的标量迁移；UI/runtime 两个 API 进程都在迁移完成后才开启后台任务、HTTP listener 和 `/readyz`。每批默认 500 task、最多 5000，每个 task 独立提交，持久化游标和源版本检查点支持中断恢复；失败或默认五分钟启动预算耗尽会使启动失败，不会把未完成迁移当作就绪。空库同样自动完成切换，已就绪启动仍在数据库内检查 pending task ID，复检旧 writer 或镜像回滚后的来源变化，不向进程读取全部旧 JSON。v2-only 任务的旧字段为 null 或默认 `[]` 时，不因缺少旧来源检查点或生命周期变化生成空 legacy run。启动不扫描 archive、trace 或原始 telemetry，常规报表仍只读规范化账本。配置与部署边界见[部署切换说明](../deploy/README.md#usage-accounting-startup-cutover)。

`multiremi_usage_legacy_audit` 保留第一次审计的原始值；`multiremi_usage_legacy_versions` 保存所有实际观察到的源版本。维护脚本可提前进行标量预回填，但不会写启动切换标记；新代码每次启动都检查旧来源变化。迁移只替换自身创建的 provisional legacy aggregate。任意 run 下已有计量的 native 消费或提供商金额（包括普通已认证 v2 run 和 historical 恢复）时，变化的旧累计无法证明与这些事实独立：弃用上报入口返回不可重试 `invalid_report`，保留原 canonical 和 outbox payload；相同已处理旧快照重放不改事实或 revision。迁移观察到此类来源变化时，提交新源审计、撤销就绪标记并失败，既不推进 processed source，也不相加或自动覆盖消费，需受审查证据修复。没有已处理基线的非空旧来源与 native 消费并存时同样需要审查；拒绝审计与任意既有 legacy run 的组合也不是接受证明。没有检查点的原预迁移或旧入口来源，只有规范化后与已接受的非空 legacy units 的单位身份和全部事实字段一致，才能建立等价检查点；比较不含 revision 和随任务生命周期变化的发生时间。空 modern/historical run 或仅 context 的历史观测没有已计消费，不阻止明确旧 split 被规范化。新 run 的 start ACK 或部分请求证据不证明其覆盖旧聚合，不能据此删除旧消费；只有经审核的身份与覆盖证据才能退休旧聚合。

生产准备允许先创建本范围 schema；历史 evidence 回填必须在停止旧 writers、排空旧上报并完成新代码切换后，重新生成和审核 source cohort 与恢复计划。仅写 JSON 的旧镜像不得与回填并行；若自动回滚后修改了受保护历史来源，下次新代码启动同样失败关闭。恢复演练与源码合入不代表已经部署、发版或在线修复。

首次 attempt 的新 queued task 若旧来源为空、没有 dispatch/start/terminal 时间或此前执行 run，仅审计旧来源，不创建缺失消费的 legacy run。实际失败重试创建新 task ID，以 `parentTaskId` 指向前一任务；attempt 是链上的序号。相同 workspace/Agent、直接父子 attempt 连续、父任务已 failed/cancelled，且父任务有完整、绑定 Runtime 的 live v2 run 时，前一执行消费属于父 task。这样的新 retry 在排队启动或已有完整 v2 消费后重启，都不额外产生旧执行 run；父子消费各计一次。缺少这些归属证据的旧 retry 仍保留 unknown，不增加 token 小计，也不能凭空确认先前消费为零。

下面是数据库维护脚本，不是普通 API 的隐式写操作。先备份并在恢复克隆演练；`MULTIREMI_DATABASE_URL` 由维护环境显式设置，不通过 API 传数据库凭据。

```bash
bun run scripts/migrate-usage-accounting.ts --batch-size=500
bun run scripts/migrate-usage-accounting.ts --batch-size=500 --execute
bun run scripts/reconcile-task-usage.ts --archive-root=<archives> --out=<review-plan.json>
bun run scripts/reconcile-task-usage.ts --apply-plan=<review-plan.json> --execute --confirm=USAGE_EVIDENCE_V2
bun run scripts/reconcile-task-usage.ts --verify-plan=<review-plan.json>
```

不带 execute 的 legacy migration 只读计数；native/raw 恢复先生成只读计划，再按审核过的计划执行。恢复读取 v2 ZIP 索引和 v1 tar.gz 的有限大小原生成员，按全部竞争任务的时间边界归属，`--task-id` 仅筛选输出。已有 modern live run 和非终态任务不进入历史证据应用队列；legacy schema 迁移仍处理所有任务。部分原生请求不能证明覆盖旧聚合，因此旧 split 消费保持计量地位，完整请求证据单独存 reconciliation evidence，不能与聚合相加；只有旧消费未知时才补入请求 subtotal，coverage 仍为 partial。相邻相等计数不证明重复，去重使用可验证请求身份；Codex replay 和无重置证据的下降不改变累计差分基线，仅 thread/session 身份变化或明确成功压缩后的有效下降建立新 epoch。原生 `compacted`、`context_compacted` 记录提供压缩证据，total-only 估计不成为消费。恢复按 task 原子检查点保存原事实和旧 usage 校验哈希，复检任务终态及无 modern live run，变化的源拒绝应用，重复应用同一计划恢复进度而不双计。后续计划必须保留已建立的请求身份、已知计数及费用关联，空或较窄扫描不能撤销事实；追加证据的完整超集可以重新应用，并审计原事实。计划生成读取持久 receipts、单位与 run 水位，为修订的单位和重建的 legacy 明确分配更高 revision，保留 receipts 防止旧事实复活。应用复检生成时的水位哈希，水位变化则拒绝并要求重新生成；相同计划的已完成检查点仍幂等恢复，verify 校验计划中的实际 revision。不可恢复项有明确原因。旧 `backfill-codex-task-usage.ts` 不再执行 sum-used 写入。计划、日志和 archive 可能包含敏感证据，应放在维护输出目录，避免在公共日志输出正文或凭据。

## 验证和性能边界

任务进度摘要的 Anthropic、OpenAI-compatible 和 Claude CLI 调用同样进入主任务的用量，`purpose=progress_summary` 单列辅助消费；实际返回的 model 与配置请求模型分开。每个传输 attempt（包括自动 fallback）有独立稳定身份，缺失响应的调用保留未知消费证据。CLI 读取 JSON result 的 usage/modelUsage，SDK 总费只进入估算桶。辅助调用与主执行共享已认证的 run，只有 start ACK 明确允许执行后才进入模型；摘要仍异步进行，主执行结束后迟到的摘要 usage 仍可交付，所有辅助调用关闭之前 run 的 complete 保持 false。

常规报表只读规范化标量表，通过 SQL 聚合和 distinct 计数，不逐任务解析旧 JSON 或读取 trace。单位有 workspace/time、Runtime/time、project/time 和 model 索引；价格有精确键/有效期索引。run 的实际消费观测与完整性先聚合一次，不逐个诊断单位反复扫描同一 run。相同 task、日期、模型与金额出处的事实先合并，SUM 保留加性指标，MAX 保留上下文峰值与未知标志；所有视图复用一次 materialized SQL 事实。PostgreSQL 用 GROUPING SETS 同时聚合五种维度，SQLite 在同一 SQL 中复用事实的聚合分支；只把分组结果送过 DB bridge。价格以受控不重叠有效区间直接关联，保留实际 SKU、请求模型 alias 和连接条件。

2026-10-06 在隔离恢复库实测：11,320 task、135,419 canonical unit（local workspace 134,770 unit）。该工作区全历史报告包含 11,267 distinct task，原查询独立样本 52.45 秒；现实现重复样本约 3.85–3.88 秒，30 天 Asia/Shanghai 约 3.26–3.29 秒。全历史完整 summary 与原查询逐字段一致，30 天消费与原相同时区窗口一致；API golden 未变，各维度字段和加性指标对账专项通过。诊断-heavy 的 135,211 个事实行先合并为 21,338 行，五维度 totals/durations 合计返回 254 个聚合行。该恢复库没有价格记录，费用/价格版本/货币等语义另由 SQLite 与真实 PG 专项验证；该测量不是生产吞吐或 p95，也不是更大规模的延迟保证。

PostgreSQL 报表在只读 Repeatable Read 事务中取一致快照；SQL bigint/count/sum 明确转换为契约 number。该交互查询仅在自身事务内 SET LOCAL jit=off：实测编译耗时数秒，关闭后执行耗时更低；事务结束恢复原设置，不改变服务全局配置或一致性。SQLite 在同一事务读取，金额和时长使用保留浮点精度的聚合传输；非 UTC 分日依据有效日期边界生成 CASE，长历史范围的边界构造成本需要实测。底层同步 Store/PgBridge 的线程阻塞和事务约束见[架构](ARCHITECTURE.md#存储与事务)；尚未记录统一报告的生产吞吐或 p95 基线。

验证入口为 [标量写入/价格/跨日/跨 Runtime 项目测试](../tests/unit/multiremi/store-usage-accounting.test.ts)、[真实 PostgreSQL 测试](../tests/unit/multiremi/usage-accounting-postgres.test.ts)、[历史恢复检查点测试](../tests/unit/scripts/usage-reconciliation-store.test.ts)、[CLI 测试](../tests/unit/remi/cli-operations.test.ts)、[严格前端边界](../frontend/packages/core/api/endpoints/usage-accounting.test.ts)、[页面测试](../frontend/packages/views/usage/usage-panel.test.tsx)和[价格编辑测试](../frontend/packages/views/runtimes/components/custom-pricing-dialog.test.tsx)。PG 测试需显式 `MULTIREMI_TEST_POSTGRES_URL`，会创建并删除独立测试库；不要指向生产数据库。构建、浏览器和生产性能验收另按 [TESTING.md](../TESTING.md)，文档检查不替代这些验证。
