# 209 数据副本上的统一模型迁移演练

本页及脚本为准备材料，未在 209 执行，未取得真实数据耗时或验收结论。执行须先由贺华杰批准，并由 **Remi-CC** 操作。开发 agent 不连接 209，不读取生产环境文件，不连接生产库。本流程只处理已备好的脱敏数据副本，不启动 API、Web、scheduler、daemon、bot、provider 或 updater。

沿用 [Chat / Issue 解耦迁移的 isolated real-data rehearsal](chat-issue-decoupling.md#audit-before-deployment-authorization) 方法：一致备份 → 隔离恢复 → 使用实际迁移代码 → 对账和抽样 → 测量恢复 → 再请求生产窗口批准。使用[统一模型切换手册](../deploy/unified-model-cutover.md)的完整 `runMigrations` 入口；不以 SQLite 合成数据结果替代真实 PG 数据副本演练。

## 执行前的审批材料

Remi-CC 将以下具体内容提交给贺华杰，批准后把评论 ID 保存为 `--approval-ref`。该参数只是证据引用，填写字符串本身不构成授权。

- 副本来源、快照时间、脱敏范围、备份校验值；源副本必须是 v0.2.87/#384 用量启动已完成、统一模型尚未迁移的状态：有 `20261006_usage_accounting_v2` 和 `20261006_usage_accounting_startup_v1` 两个标记，尚未应用 `20261004_unified_message_turn_lane`。旧镜像及回滚点须匹配快照版本，不能用 v0.2.86 或已迁移的草稿库代替。
- 候选完整 SHA、API 镜像 digest 和 OCI revision；旧版完整 SHA、可恢复的旧 API 镜像 digest；PG 服务端主版本和匹配的工具镜像 digest。镜像在执行前由负责人准备并加载，脚本不拉取镜像、不构建或发版。
- 209 上全新演练目录、所需磁盘空间（源备份、工作副本、回滚备份、两个 api-home 和报告）、时间预算及操作者 Remi-CC 的宿主 UID/GID。执行必须使用非 root 账号；目录不位于生产数据卷或部署目录内。
- 副本四项阻塞预检均为 0 的证据。若原快照有 awaiting_human、所属任务未结束（或任务缺失）的未消费 steer、running 回填组或 running/dispatched task，脚本拒绝；先申请新的、正常 drain 后取得的副本，不删行、不改状态来造绿。所属任务为 completed/failed/cancelled 的未消费 steer 不阻塞，单独报告数量、ID、任务状态和正文摘要，原行与 consumed_at 保持不变。
- 需抽样的 Issue 和读进度类型、负责人、缺失覆盖如何补充。没有部分消费记录时明确记为“真实副本无此样本”，不能写成通过。

不使用生产 `api.env` / `application.env`、生产 URL、Docker Compose 名称、既有卷或网络。备份输入为已验证的**数据副本**导出目录，含 `platform.pgdump`、脱敏 `api-home.tar.gz` 和 `SHA256SUMS`。api-home 副本不携带 bot/provider/SSH/SSO 凭据；消息正文、数据库备份和诊断保存在私有目录，不直接贴评论。备份生成与校验方式参考[切换手册第 3 步](../deploy/unified-model-cutover.md#切换顺序)，其数据库环境只能指向另行隔离的数据副本。

## 计划预览与执行命令

脚本 [rehearse-unified-model-copy.sh](../../scripts/rehearse-unified-model-copy.sh) 默认只输出计划，不执行 Docker 或数据库操作。需要 Bash、Docker 本地 Unix socket、Python 3、tar、sha256sum、sed、cmp。PG 镜像提供 pg_dump/pg_restore/psql；API 镜像包含固定 Bun 和仓库源码。候选镜像须包含本页两个演练脚本；旧镜像须包含 `packages/server/src/store/migrations.ts` 和同步 PG adapter。

以下命令中的路径、digest、SHA、PG 主版本均由 Remi-CC 在审批材料里填定；不是当前生产值。不要将连接串或密码放入参数。

```bash
bash scripts/rehearse-unified-model-copy.sh \
  --copy-backup-dir /data00/remi-rehearsal/input/<approved-copy> \
  --work-dir /data00/remi-rehearsal/runs/<new-run> \
  --pg-image 'postgres:<matching-version>@sha256:<digest>' --pg-major <major> \
  --candidate-image 'ghcr.io/grassgod/remi-api@sha256:<candidate-digest>' \
  --candidate-sha <approved-full-sha> \
  --old-image 'ghcr.io/grassgod/remi-api@sha256:<old-digest>' --old-sha <old-full-sha>
```

收到贺华杰对上述具体材料的批准后，**仅 Remi-CC** 在同一命令追加：

```bash
--execute --operator Remi-CC --approval-ref <approval-comment-id>
```

脚本在任何 Docker 操作及工作目录创建前拒绝宿主 UID 0；不要用 sudo 执行。非 root 操作者须已获准访问本地 Docker socket，并将其 UID/GID 纳入审批材料。旧版与候选 job 均固定使用执行开始时读取的该 UID/GID，写入 `authorization.txt`，新目录和解包文件也归该账号所有。

脚本固定使用 `unix:///var/run/docker.sock`，忽略远程 Docker context；若 209 的本地 Docker 入口不同，停下交给负责人核对，不替换成远程入口。每次执行新建带随机后缀的内部网络、PG 容器和空数据卷；不发布端口、不加入生产网络、不挂载生产目录或 Docker socket 到容器。PG 的 trust 认证只用于该隔离网络和新建的副本容器。候选 job 非 root、只读镜像、丢弃全部 capabilities，只挂载本次新目录。没有对生产对象执行任何修改命令。

## 脚本执行顺序与产物

1. 校验输入备份的 SHA256SUMS、archive 路径、候选/旧镜像 revision。工作目录必须不存在，禁止复用已有数据库或数据卷。恢复到新建的 `mul493_rehearsal` PG，核对主版本。源备份只读，永不改写。
2. 旧镜像仅运行 `runMigrations`，不启动服务，确认副本能由匹配的旧代码幂等打开。比较启动前后完整 schema + data 的 dump 哈希，任何变化均停止，不能让旧启动改写待检快照以绕过预检。保存哈希作为回滚基线。
3. 对该工作副本执行 pg_dump custom-format 备份和 api-home tar 备份，保存恢复清单、`ROLLBACK-SHA256SUMS`，不备份生产库。它们是本次候选迁移之前的回滚点。
4. 候选镜像运行 [rehearse-unified-model-copy.ts](../../scripts/rehearse-unified-model-copy.ts)。脚本仅接受指定隔离 PG 的主机/端口/库名/角色，并连接后再次核对身份；不读取 `MULTIREMI_DATABASE_URL`。保存只读预检与业务/用量基线后，按 `serve` 的数据库顺序执行角色锁 → 新数据库连接 → `runMigrations`（含 schema 锁等待）→ `prepareUsageAccountingStartup` → `ensureUsageAccountingStartup`（含用量锁等待）。首启依次跑 api、api-runtime，重启再各跑一次；每次关闭连接并释放角色锁，不启动 HTTP 或后台任务，不连接 peer/daemon，不发送飞书，不投递 outbox。角色锁只尝试一次，失败直接退出，不加演练重试。随后以 repeatable-read 只读事务对账。预检失败保留具体数量及私有诊断。
5. 无论候选检查成功还是失败，都在**本次副本 PG** 中删除并新建演练库，校验并恢复回滚备份，将迁移后的 api-home 移到 `migrated-api-home` 留证，恢复旧 api-home。比对完整 schema/data 哈希，再用旧镜像重启并再次比对。候选失败即使回滚成功也返回失败。
6. 退出时清理仅由此次执行创建、且已记录 ID 的 PG 容器、数据卷和网络。私有备份、日志、迁移后 api-home 及报告保留在本次新目录；不运行全局 prune、不操作生产 Compose。若被 SIGKILL 或宿主重启中断，Remi-CC 按 `remi.rehearsal=MUL-493` 标签及本次名称人工核对后只清理本次对象。

主要产物均在新工作目录的 `evidence/` 内，权限默认 0600：

| 产物 | 用途 |
|---|---|
| `authorization.txt` | 操作者及宿主 UID/GID、批准引用、两版 SHA、PG 主版本 |
| `docker-resources.txt` | 本次新建对象 ID/名称，中断后只按这些对象清理 |
| `rollback.pgdump`、`rollback-api-home.tar.gz`、恢复清单和校验文件 | 工作副本的回滚点及恢复验证 |
| `durations-ms.tsv` | 源副本恢复、旧代码启动、副本备份、候选容器、回滚数据库和 home 恢复、旧版重启分别耗时 |
| `source-copy-data.sha256`、`pre-cutover-data.sha256`、`restored-data.sha256`、`old-restart-data.sha256` | 原副本、旧启动、恢复及旧版重新启动后的完整 schema/data 一致性 |
| `migrations/preflight.json`、`copy-baseline.json` | 四项预检、全表行数、原 Issue 状态、agent checkpoint、实际读进度 |
| `migrations/20261004_unified_message_turn_lane-before.json`、`-after.json` | 核心统一模型迁移报告，含 `orphan_steer.count/ids/by_task_status/entries/body_location`，正文不写入报告 |
| `migrations/copy-usage-before.json`、`copy-usage-reconciliation.json` | 两个 #384 标记、全部 usage 表的列/行数/完整内容 SHA256、attempt 归属孤儿计数、actual/context/unknown/金额/覆盖状态证据；迁移后及四次角色启动的前后对账 |
| `migrations/copy-startup.json` | 各角色首启/重启的 `steps_ms`、`database_total_ms`、成功/失败阶段与未测范围；失败也保留已测步骤 |
| `migrations/copy-reconciliation.json`、`copy-timing.json` | 最终启动状态对账、Issue 样本、部分消费计数、迁移/重启及两角色数据库步骤耗时、用量 mismatch |
| `*.private.log` | 失败诊断，只能脱敏摘要后交付 |

## 核对项与人工抽样

行数对账由脚本检查：历史 task 数量及 ID digest = attempts；retry chain = turns 且分组不变；Issue、Issue Session、Chat、autopilot 行数不变；历史消息和 pending decision 不丢失；存活 attempt/turn/当前指针/回复/会话 head 不产生孤儿。报告列出全部物理表行数，不能要求旧表和新表逐项相等，也不能把旧 inbox 行数作为新通知行数的期望。

孤儿 steer 追加为 `multiremi_conversation_log` 的历史 message，ID 为 `msg_migrated_steer_<steer-id>`，正文在 `body_md`，`session_id/seq` 定位所在会话，metadata 保留原 steer ID、原 task/attempt ID、终态和 kind；retry attempt 的历史消息归到所属 turn。消息 `to_type=none`、`wake_applied=inbox_only`，不会唤醒任务。before/after 对比各条正文 SHA256 与身份；原 steer 行不消费、不删除，后续获批删除退休表后仍可按 message_id 查正文。209 只读核对发现的 12 条（9 cancelled、3 failed）是待演练输入事实，不是本脚本的实测结果。

用量摘要由 [unified-model-copy-usage.ts](../../scripts/unified-model-copy-usage.ts) 按主键排序、重建长 JSON 后逐行哈希，覆盖 runs/units/receipts/scopes、legacy audit/sources/versions/startup progress、request/meter owners、identity conflicts、cost coverage、prices/revisions 等全部 `multiremi_usage_*` 表。task_id 保持原 attempt ID，不能换成链首 turn ID；owner_task_id 也检查存活归属。`unit_evidence` 是按 source/accuracy/currency/cost_source/coverage 分组的标量证据，保留 unknown 与 NULL，不把 reported/context 总量当成 actual。它不替代产品完整用量报表。以 #384 已完成的副本为起点，所有表内容、标记时间和标量证据预期不变；任何变化均为 mismatch，先查 sources/versions/progress 与投影视图匹配原因，不能忽略变化继续切换。

读进度自动核对分两层：旧 agent lane 的 checkpoint 与 `provider_cursor_seq`、provider session/work_dir/generation、父游标和 wake/sweep 水位原样保留；`conversation_heads.agent_read_state` 的真实 `seq + offset` 精确进入默认 execution scope 的 agent lane，包含部分消费。非默认 scope 不套用全局 receipt。人的 lane 初始化到迁移后 head，历史通知不再出现未读卡。

原始核心迁移 before 报告的 agent `cursor_seq` 代表 provider checkpoint；完整启动还会迁移实际读进度，因此不能要求最终消费 cursor 等于旧 checkpoint。演练脚本保留原报告，按实际读进度构造最终对账期望，并单独核对 provider checkpoint。最终结果不删 mismatch、不放宽身份/行数/链分组守卫。重启报告也不等于读完新消息；后续功能验收仍须覆盖真实完整/部分消费。

Issue 状态迁移时保留旧值，状态推导仍由业务事件触发。`issue_samples` 按状态、指派类型、父子结构取样，另包含 retry、决定及父单样本。Remi-CC 会同 QA 对照 [issue-status.ts](../../packages/server/src/store/inbox/issue-status.ts) 和[父单守卫](../adr/0003-parent-status-derived-from-children.md)逐条填写“样本 ID、原值、turn/owner/decision/children 输入、事件后期望值、核对结论”；保留记录到批准评论，不把脚本 exit 0 当成人工验收。

| 抽样输入 | 应核对的推导 |
|---|---|
| 人或 agent 派活触发的 pending turn | todo；平台通知 pending 本身不足以改状态 |
| awaiting_human 或 owner 的未答决定 | in_review；非 owner 的决定不能替代 owner 判断 |
| owner 最新 completed / failed / cancelled turn | 分别 in_review / blocked / todo，且没有优先级更高的活跃 turn |
| 基础重试、redispatch/recovery 多 attempt | 仍是一轮，不因 attempt 数量改变 Issue 状态；显式 continuation 是另一个 turn |
| Chat turn、非 owner turn、平台通知 | 按实际排除/触发规则核对，不以任意一次执行状态覆盖 Issue |
| done/cancelled 单、仍有 open child 的父单 | 终态保护与父单 hold/exempt 守卫保持；手动终态及父子关系不被迁移改写 |

四项预检阻止真实 running/awaiting_human 历史快照通过，因此本次副本中缺少这些状态的迁移样本是正常的；动态推导行为由 QA 在独立合成环境覆盖，不能在真实历史副本上造状态以伪称真实数据验证。

## 时间预算、失败与回滚

每轮从相同不可变输入备份恢复到全新目录，建议至少两轮，记录机器、PG/Bun 版本、数据大小、缓存条件；不在已迁移库上重复计时冒充首启。`copy-timing.json` 的 migrationMs/restartMs 保留为 api 首启/重启的 `runMigrations` 耗时（含锁等待、迁移自身报告 IO、事务提交）。`startup` 分别列出 api（all + peer 配置对应 ui 锁）与 api-runtime（runtime 锁）的 `role_lock/database_open/run_migrations/prepare_usage/ensure_usage` 毫秒数，`database_total_ms` 为这些步骤总和，额外对账报告 IO 与连接清理排除。api 首启完成迁移后再测 api-runtime 的首次启动，因此后者是已迁移共享库上的角色首启，不能声称两角色同时冷启动的实测。外层容器耗时单列。暂不填真实数值。

后续生产窗口的计划为：drain + 最终备份 + 至少两倍最慢副本两角色首启数据库步骤总耗时 + 未测启动/readback + 人工核对预算；回滚截止点 = 获批窗口末尾 − 已测 DB/home 恢复及旧版启动/readback。两倍系数是余量，不是性能保证；不能沿用 0.2.85 那次耗时或 SQLite 小夹具数字。报告 `http_ready_measured=false` 和 `unmeasured` 明确列出 HTTP listener/readyz、模块/进程冷启动、Store facade 构造、read pool/Live Hub/peer 初始化、后台任务及生产竞争/并发启动；副本仅测 ready 前数据库步骤，锁等待包含在对应步骤中，不单独分离纯执行时间。不能把 `database_total_ms` 称为生产冷启动到 ready 总耗时；fleet 升级、bot 卡片、网页及未测部分由切换负责人和 QA 另行核对。

预检、迁移、对账、人工抽样或恢复验证任一失败都不申请继续切换；保留私有证据并修复原因，用新副本再跑。脚本不删退休表，不放宽预检；删表仍需运行 7 天、另行授权。生产回滚须另行批准并沿用[切换手册回滚](../deploy/unified-model-cutover.md#回滚)：暂停写入、恢复 DB 与 api-home、恢复旧镜像，再处理 daemon 降级；直接用旧代码打开新 schema 不算回滚。恢复备份会丢掉切换后新写入，这项取舍必须在生产窗口审批里明确。

交付真实演练结果时，提交脱敏行数/ID digest、0 mismatch 报告、Issue 抽样结论、真实读进度覆盖、全部时间预算与恢复校验；缺失项列明未验证。本任务只准备这些入口和要求。
