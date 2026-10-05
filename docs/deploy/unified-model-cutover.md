# 统一模型切换手册

本手册供全部存储、收件箱、daemon、接口与网页改接合入后使用。当前分支已接入存储迁移，尚未进行生产切换。209 操作、切换窗口、发版与删表均由负责人另行授权；本单只在本地 SQLite 与 PostgreSQL 验证脚本。完整 fleet 与 outbox 门禁沿用 [daemon v2 切换清单](daemon-v2-cutover.md)，运行时名单从平台动态获取。

## 切换顺序

1. 发布负责人集成时，将 `packages/contracts/src/daemon-protocol.ts` 的 `DAEMON_MIN_CLI_VERSION` 从 `999.0.0-unreleased-mul507` 替换为第一个包含 MUL-507 的正式版本，并同步协议说明；`0.2.86` 留给 MUL-496 补丁。确认占位值已移除、版本门与正式 tag 一致、目标版本全部集成，按集成时有效的发布门禁验证正式 main 提交。当前 release-build-check 已停用，不等待该检查；保留 Developer context 与相关定向测试证据，正式发布门禁由发布负责人核对。

   目前保留占位值，不猜测正式版号。版号确定后，在仓库根目录将以下命令的 `<正式版本，不带 v>` 换成已批准的版本再执行。命令只填写协议常量及协议说明，不改 package 版本、不打 tag、不发布；正常发版仍由发布负责人执行。

   ```bash
   MUL493_RELEASE_VERSION='<正式版本，不带 v>' python3 - <<'PY'
   import os, re
   from pathlib import Path
   version = os.environ['MUL493_RELEASE_VERSION']
   assert re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version), '需要稳定 SemVer，不带 v'
   assert version not in ('0.2.86', '999.0.0'), '不得使用保留版号或占位版号'
   edits = {
       'packages/contracts/src/daemon-protocol.ts': (
           'export const DAEMON_MIN_CLI_VERSION = "999.0.0-unreleased-mul507";',
           f'export const DAEMON_MIN_CLI_VERSION = "{version}";'),
       'docs/daemon-protocol-v2.md': (
           '当前 `DAEMON_MIN_CLI_VERSION` 为明显的未发布占位值 `999.0.0-unreleased-mul507`。',
           f'当前 `DAEMON_MIN_CLI_VERSION` 为首个包含 MUL-507 的正式版本 `{version}`。'),
   }
   prepared = []
   for name, (old, new) in edits.items():
       path = Path(name)
       text = path.read_text()
       assert text.count(old) == 1, f'{name}: 原值已变，请人工核对'
       prepared.append((path, text.replace(old, new)))
   for path, text in prepared:
       path.write_text(text)
   PY
   ```

   同一提交还需将常量上方的 `RELEASE PLACEHOLDER` 注释改为正式版门槛说明，并将 [协议说明 §7.4b](../daemon-protocol-v2.md#74b-daemon_min_cli_version-与载荷发布版本) 的后续占位提醒改为实际 tag 和目标 main SHA 的核对要求。此步骤的替换示例可保留作操作说明；检查占位是否残留应针对常量赋值和协议当前值，不能把手册示例误判成仍在使用占位。

   测试无需批量换字符串：接入成功的夹具从 `DAEMON_MIN_CLI_VERSION` 导入，旧版拒绝用例保留原版号。复核并定向运行以下文件：

   | 文件 | 必须保持的检查 |
   |---|---|
   | `tests/unit/daemon/daemon-protocol.test.ts` | 最低版本和更高版本可接入；旧 fleet 版本拒绝 |
   | `tests/unit/daemon/daemon-protocol-client.test.ts` | reject 后等待升级，不认领任务；welcome 后正常运行 |
   | `tests/unit/multiremi/runtime-protocol.test.ts` | 版本守卫、升级状态、正式版本接入 |
   | `tests/unit/multiremi/daemon-task-offers.test.ts` | 使用最低版本的握手及 offer 仍可执行 |

   ```bash
   bun run test tests/unit/daemon/daemon-protocol.test.ts tests/unit/daemon/daemon-protocol-client.test.ts tests/unit/multiremi/runtime-protocol.test.ts tests/unit/multiremi/daemon-task-offers.test.ts
   bunx tsc --noEmit
   npm run docs:test
   npm run docs:check
   git diff --check
   ```

   若正式版号不高于拒绝用例中的旧版号，停止填写并核对发布方案，不放宽断言。发布前核对 `package.json`、正式 tag、Release 资产、常量及目标 main SHA；此处定向检查不替代发布负责人确认的发版门禁。
2. 历史 trace 回填完成，或停在组边界；进度表不能存在 running 组。备份脱敏副本供 QA 演练，不允许开发 agent 连接生产库。
3. Remi-CC 执行数据库与 api-home 备份，保留校验文件和恢复清单。备份脚本需要 Bash、匹配服务端主版本的 pg_dump/pg_restore、tar 和 sha256sum。API 镜像目前没有 pg_dump；由运维选择已具备客户端的 PostgreSQL 工具容器，挂载 api-home 与备份目录，注入已有连接环境变量。不要为执行备份临时修改生产 API 镜像。

   ```bash
   bash scripts/backup-platform-db.sh --output-dir /backup --api-home /api-home --database-env MULTIREMI_DATABASE_URL
   ```

   脚本产出 `platform.pgdump`、`api-home.tar.gz`、`restore-list.txt` 与 `SHA256SUMS`。URL 必须来自环境，不放在命令行；失败诊断保存为权限受限文件，不能直接贴到 Issue。恢复时用 pg_restore 先恢复到隔离空库，再校验业务记录与 api-home。
4. 授权负责人启动 updater drain；核对所有运行任务与 outbox 排空。四项启动预检分别检查 awaiting_human、未消费 steer、running 回填组、running/dispatched 任务。必须完成等待人工答复的处理，不能通过删行绕过门禁。
5. updater 切换正式镜像，API 启动执行单事务迁移。读取 `reports/migrations/20261004_unified_message_turn_lane-before.json` 和 `-after.json`。预检失败时打印具体名称与数量，按旧镜像回滚；事务中途失败时模型改写回滚。报告目录通过 `MULTIREMI_MIGRATION_REPORT_DIR` 配置，默认 `reports/migrations`；切换时指定 api-home 持久卷内目录并使用相同路径运行对账。重启不会重新执行旧结构的 DDL。
6. 只读运行对账，记录 counts、mismatches、各会话 head 和游标。迁移前报告用于核对 attempt 身份及链分组；日常对账不再要求人的 cursor 等于当前 head。

   ```bash
   bun run scripts/reconcile-unified-model.ts --postgres-env MULTIREMI_DATABASE_URL --before reports/migrations/20261004_unified_message_turn_lane-before.json --out reports/migrations/unified-model-reconciliation.json
   ```

   SQLite 副本改用 `--sqlite /path/to/copy.db`。命令不创建 Store，不跑迁移；SQLite 以 readonly 打开，PG 使用 repeatable-read 只读事务。身份与迁移初始数量核对只能在切换后、恢复写入前执行；平台恢复写入后使用不带 `--before` 的日常完整性检查。
7. 按既有版本门观察 fleet 自动升级，确认待升级为 0、各 Runtime 心跳与协议正常。平台数据提示词先 dry-run，负责人核对后再 execute；该脚本归接口/CLI阶段，不属于数据库启动迁移。
8. QA 核对消息、收件箱、pending 合并、插话、决定答复、重试、换机与网页卡片；通过后由负责人解除 drain。记录版本、时间、对账报告与每台 Runtime 的证据。

## QA 核对项目

| 场景 | 预期 |
|---|---|
| SQLite / 真 PG，空库与历史库 | 启动切换一次完成，再次启动幂等 |
| task 重试链、显式 continuation | 重试链一轮多尝试；continuation 是另一轮；tsk_ 不变 |
| 无产品对话的历史执行 | 进入 auto_*，历史输入可追溯 |
| envelope、system、delegation_report | 消息头为列；系统消息与可见 report 使用 message 行 |
| 未答复决定 | 追加 decision，保留时间、选项和一次性令牌 |
| agent lane、人 lane | agent 检查点原样；人 cursor 为迁移后 head，不迁历史通知 |
| 四项预检 | 各项单独失败均拒绝且不改写模型数据 |
| retry、redispatch、recoverOrphans | 只增加尝试；轮数与 Issue 状态不变 |
| 三张旧对话表 | 新操作不产生 INSERT / UPDATE / DELETE |
| 删表与备份 | 默认 dry-run；两组独立演练；备份恢复检查成功 |

本地测试结果以本单评论和 PR 为准，不用上述预期自证 QA 验收通过。209 脱敏样本与真实容器备份演练需由 Remi-CC 提供证据。

## 物理删表

新版本运行满 7 天，两组表一次报批，获得贺华杰明确授权后先备份，再执行。脚本默认 dry-run，要求 24 小时内生成、与当前数据库匹配且无 mismatch 的对账报告；执行还要求非空备份文件与两个显式开关。

```bash
bun run scripts/drop-retired-tables.ts --set mul432 --postgres-env MULTIREMI_DATABASE_URL --report reports/migrations/unified-model-reconciliation.json
bun run scripts/drop-retired-tables.ts --set mul493 --postgres-env MULTIREMI_DATABASE_URL --report reports/migrations/unified-model-reconciliation.json
```

第一组为 session_events、issue_comments、chat_messages、task_messages；第二组为 steer、human_requests、issue_decisions、inbox_items、agent_issue_update_state、task_prompts。每组在一个事务内执行，不使用 CASCADE；存活约束会阻止删除。确认批准后，在对应命令追加 `--execute --confirm-drop --backup /backup/platform.pgdump`。两组选项可分开演练，但不意味着分开获得生产授权。

## 回滚

删表前：负责人停止新写入、恢复数据库与 api-home 备份、回旧镜像，再通过已有 Runtime release 通道降级 daemon。切换后新增消息会随恢复旧备份丢失，须在窗口决定中接受。删表后：只能前向修复，不把旧表的缺失当作可以直接回旧镜像的状态。
