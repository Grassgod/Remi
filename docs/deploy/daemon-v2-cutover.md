---
title: Daemon v2 fleet 切换清单
status: active
summary: v2 集成发版的只读核对、逐台升级与 B 删表前后回滚门禁；本单不执行生产操作。
---

# Daemon v2 fleet 切换清单

依据 [协议 §7](../daemon-protocol-v2.md#7-版本协商与升级通道)。此清单供整条 v2 集成链路
完成后切换使用，不表示 MUL-418 第二段已部署。发版、drain、镜像切换、服务重启、升级/降级
请求、环境变量清理都是另行授权的写步骤，本文只给核对用的只读命令；本段不执行生产操作。
不可逆删表由 B 单独审批并先备份。操作负责人在 MUL-401 记录每一步的时间、版本、daemon、
runtime、请求 ID、核对结论及脱敏错误，不记录 token、凭据、完整环境或带凭据的进程参数。
命令需要机器已有的 `remi`，JSON 自动核对另需 `jq`。工具缺失时只读查看原始 JSON 并逐项
人工核对、记录缺失原因；不得把未执行的过滤命令算作通过，本段不在生产安装工具。

## 切换前核对

1. 带头大哥在 `v2-integration` 合入 main 时，把 `DAEMON_MIN_CLI_VERSION` 从占位的
   `"0.2.83"` 改为第一个真正携带 v2 的 release tag。本段保持占位值，不把 v0.2.83 当成已发布 v2。
   只读核对：`rg -n 'DAEMON_MIN_CLI_VERSION' packages/contracts/src/daemon-protocol.ts`、
   `gh release view <目标-tag> --json tagName,publishedAt,assets`、
   `gh run list --workflow release-build-check.yml --commit <目标-main-SHA> --json status,conclusion,headSha`。
   通过条件：最低版本、目标 tag、release 资产和目标 SHA 一致，目标提交的完整 build check 成功。
2. `remi runtime list --json`、`remi daemon list --json`、`remi platform status --json`。
   通过条件：切换当天重新确认 4 个物理 daemon、8 个 runtime（不以文档名单替代实际清单），
   两个 provider 的归属和最新心跳正确，平台无冲突操作。将这 8 个 runtime ID 记在 MUL-401。
   记录各行 `protocol`、`metadata.cli_version` 和 `launched_by`；Desktop CLI 更新会按既有逻辑
   拒绝，若出现必须停在此步向负责人确认，不能另写一套忙闲/升级逻辑。
3. 各 daemon 主机本地运行 `remi daemon status --json`。只选取所需字段核对：

   ```bash
   remi daemon status --json | jq '(if has("daemons") then .daemons else [.] end) | map({runtime_id, provider, cli_version, protocol, active_task_count, claims_paused_by_drain, outbox})'
   ```

   通过条件：端口上的进程、provider 与平台登记一致。源码运行而未设置 `MULTIREMI_VERSION`
   的 daemon 会报 `0.2.26`，连 v2 后进入 `upgrade_wait`。逐台标记这种启动方式；其处理口径归
   MUL-418 第三段，不在本段修改默认回退。只看到安装的二进制版本，不能证明正在运行的进程版本。
4. 各机器只检查废弃环境变量是否存在，不打印其他变量或其值。Linux 上对已核实的 daemon PID：

   ```bash
   awk 'BEGIN { RS="\0" } /^MULTIREMI_HEARTBEAT_INTERVAL_MS=/ { found=1 } END { print found ? "deprecated heartbeat variable: present" : "deprecated heartbeat variable: absent" }' /proc/<daemon-pid>/environ
   ```

   对已核实的 systemd 环境文件或 launchd plist 可用
   `rg -l 'MULTIREMI_HEARTBEAT_INTERVAL_MS' <已核实的环境文件或-plist>`，只输出文件名。
   macOS 用 `launchctl getenv MULTIREMI_HEARTBEAT_INTERVAL_MS | awk 'END { print NR ? "deprecated heartbeat variable: present" : "deprecated heartbeat variable: absent" }'`
   检查 launchd 全局环境；这不能代替 plist/实际启动来源核对。源码已不读取该变量，存在就标记为
   切换后待清理；无读取权限或启动来源不明不是通过，交负责人补充。不要用 `env`、`ps e` 或
   未过滤的 `systemctl show Environment` 导出凭据。
5. 只读核对 209 容器：在已授权的只读连接里运行
   `docker compose -f /data00/home/hehuajie/Services/remi-platform/container/compose.application.yml ps`，
   并运行 `remi platform health --json`、`remi platform ready --json`、`remi platform status --json`。
   通过条件：API/Web 健康、updater 正常、当前 release 记录与镜像切换计划一致。拆进程时
   UI/runtime 必须共用数据库，daemon 指向 runtime API；指向 UI 的 `/api/daemon/*` 会返回 421。
   本单没有连接 209，也不改变地址、镜像或 Compose。

## 发版与逐台升级

顺序固定：完成发版门禁并发布正式产物，授权负责人发起 drain，等 running tasks 和 outbox
排空，再切 API/Web 镜像，逐台走升级通道升级 daemon。切镜像开始计时，30 分钟内逐一核对
8 个 runtime；任何一项不达标先记录并停止推进，不靠忽略错误或延长窗口算成功。

| 步骤 | 只读核对命令 | 通过条件 |
|---|---|---|
| drain 已应用 | `remi platform status --json`；各主机 `remi daemon status --json` | maintenance 为 draining；全部 lane 的 `claims_paused_by_drain=true`、`drain_ack_generation` 等于该 generation、active/draining task count 为 0；再执行下节 outbox 门禁 |
| 镜像切换完成 | `remi platform status --json`；`remi platform health --json`；`remi platform ready --json`；上节 Compose ps | 目标 release、API/Web 镜像与发布清单一致，服务健康；不在 209 手工构建替代产物 |
| 升级通道已建请求 | `remi runtime get <runtime-id> --json`；知道请求 ID 后 `remi runtime release status <runtime-id> <request-id> --json` | `protocol.state=upgrade_pending`；CLI scope、目标版本为服务端自身 release；同 runtime 最多一条 pending/running；忙时继续等既有空闲判定 |
| daemon 升级完成 | 本地 `remi daemon status --json`；`remi runtime get <runtime-id> --json` | 实际进程版本为目标 tag 对应版本；本地 protocol connected，平台 `protocol.version=2,state=ok,last_error=null`，新心跳在 freshness 窗口内；不能只用 SSH 可达算在线 |
| 8 个 runtime 收尾 | `remi runtime list --json`；`remi platform status` | 30 分钟内逐个记录两 provider 的 v2 正常状态，汇总 `待升级 0 台 / 失败 0 台`；负责人确认后解除 drain |

`pending_update` 的 HTTP ack 收窄、v1 claim 空桩和其他路由 426 需要后续阶段完成；不要仅凭
本 PR 上线就执行最终切换。升级请求/排队沿用现有表和空闲判定，失败后下次心跳会重建，
每个失败请求 ID 和错误都应及时记下，不能只保留后来成功的一次。

### 升级失败行增长监控

升级失败后，下一次探测会重建请求；60s 探测持续失败时约增长 **60 行 / runtime / 小时**。
失败历史必须保留，本清单不授权删行。切换期间每分钟核对，首次新增失败即告警；同 runtime
10 分钟内新增失败 >= 10 行，或一小时 >= 60 行，升级为持续失败告警，暂停推进并在 MUL-401
记录请求 ID、增长量及脱敏根因。不得以一条 pending 的唯一性推断失败历史不增长。

`remi runtime release status` 只能读取已知请求 ID，CLI 暂无历史失败计数能力。下列命令仅供
授权运维使用**预先配置的只读 PG 监控 service**；本段不执行生产 DB 查询、不创建 service 或
复制凭据。不把带密码的 URL 放入命令、日志或评论；service/psql 不可用时记为未核对并停下，
不能用当前 `protocol.state` 代替行增长统计。

```bash
PGOPTIONS='-c default_transaction_read_only=on' psql 'service=multiremi-monitor' -X --set ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SELECT runtime_id,
       COUNT(*) FILTER (WHERE updated_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '10 minutes') AS failed_10m,
       COUNT(*) AS failed_1h,
       MAX(updated_at) AS latest_failure_at
FROM multiremi_runtime_update_requests
WHERE scope = 'cli' AND status = 'failed'
  AND updated_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
GROUP BY runtime_id
ORDER BY failed_1h DESC, runtime_id;
COMMIT;
SQL
```

通过条件：命令退出 0，切换窗口内没有新增 CLI 升级失败；每分钟保存脱敏计数差值，历史已有
失败不能被当成此次新增。出现任一告警先查对应 runtime 与失败请求，不清表、不重跑到无失败
再覆盖记录。这里仅监控 CLI scope，ACP 更新失败另行调查。

| daemon/主机 | 服务管理 | 路径与只读核对 |
|---|---|---|
| n37-066-008-hehuajie / 008 | systemd user unit | 先升级通道；`systemctl --user status <切换当天确认的-daemon-unit> --no-pager`、本地 daemon status 与两个 runtime get 核对。失败时负责人授权 SSH 兜底 |
| n37-206-133-hehuajie / 133 | systemd user unit | 同 008；不得从其他机器复制凭据 |
| GrassgodMBP / dmn_5d98ad65… | launchd `dev.remi.multiremi.daemon` | 先升级通道；WireGuard/SSH 连接后本地 daemon status、`launchctl list dev.remi.multiremi.daemon` 核对 PID/退出状态。服务定义和日志路径切换当天确认 |
| 贺华杰 / dmn_40119cf7… | 切换当天核对 | 计入全部 daemon v2 验收；`rt_1wfnlsb`（claude）、`rt_1wlrzjc`（codex）；先升级通道，失败 SSH mesh 别名 212 兜底 |

## dmn_40119 升级失败的兜底

开发期间不登录这台机器。切换当天获得贺华杰授权后，以下每一步均先/后记在 MUL-401：

1. `remi runtime get rt_1wfnlsb --json`、`remi runtime get rt_1wlrzjc --json`、
   `remi runtime release status <runtime-id> <失败-request-id> --json`，记录失败错误及时间。
   通过条件：确实是这台 daemon 的 CLI 升级失败，不能把 ACP 更新或临时忙当成另一种协议问题。
2. `ssh -G 212 | awk '$1 == "hostname" || $1 == "user" || $1 == "port" { print }'` 只读核对 mesh
   别名的实际主机归属。再由授权负责人连接 212；本地 `remi daemon status --json` 与平台记录
   对上 PID/provider/版本，核对实际服务管理方式，不凭历史猜 unit。
3. 用对应服务管理器只读 status 和已确认的日志定位下载、安装、权限或 Desktop 拒绝原因；
   `remi daemon logs --lines 100` 的输出可能含业务内容，只摘录脱敏错误，不整段发布。
   通过条件：根因和实际运行产物明确；若不能确认，停止并问负责人。
4. 由负责人决定并执行升级修复、安装目标正式产物及必要重启。这些是写操作，此清单不提供
   自动执行命令，本单不执行。先完成 drain/outbox 门禁并记录可回退旧产物，不能删共享 outbox。
5. 再运行步骤 1 的 runtime get 与本地 daemon status，两个 runtime 都达到 v2 ok、CLI 目标
   版本且心跳新鲜才算恢复；记录过程、结果和剩余风险。依据：MUL-401 Q5 `cmt_70sumd6bces1`。

## Outbox 排空门禁

MUL-421 按 MUL-401 `cmt_4tqrwtr7nn83` ② 将各 provider outbox 合并成进程共享的一个。
**v1 读不到共享 outbox 尚未送达的行**，只检查 active tasks 为 0 或 socket 已断开不足以证明
可降级。在每个 daemon 主机、该 daemon 服务账户下执行下面的只读核对，不在 UI 进程查表：

```bash
set -o pipefail
remi daemon status --json | jq -e '
  (if has("daemons") then .daemons else [.] end) as $lanes
  | ($lanes | length) > 0 and all($lanes[];
      .claims_paused_by_drain == true
      and .active_task_count == 0 and .draining_task_count == 0
      and (.outbox | type) == "object"
      and .outbox.pending == 0 and .outbox.blocked == 0
      and .outbox.pendingTerminal == 0 and .outbox.pendingNonTerminal == 0)
'
```

通过条件：每台已登记 daemon 都能返回全部 lane 的健康统计、命令输出 `true` 且退出码为 0，
drain 保持生效，送达未 ack 的行也仍计入 pending/blocked 而不是提前删除。切换前需对照
MUL-421 合入后的实现确认 `/health.outbox` 覆盖共享库及未 ack 行，并重新核对旧 provider 库
的迁移结果；本段不能替尚未合入的泵实现宣称这一点已经验证。重复两次检查并记录时间，
在 drain 不解除的情况下紧接着停止/降级，避免新任务或后台上报重开队列。

如果 daemon 已停、主机不可达、统计缺失/null、只覆盖某 provider 或不能证明未 ack 行计入，
**无法通过现有只读 CLI 证明共享 outbox 已排空**：不得用空响应、文件大小或 v1 的统计代替，
不得删除/迁移未送达行来凑零。停止回滚并在 MUL-401 记录原因，等待负责人批准恢复 v2 连通性
继续排空或指定经审查的本地只读核对方式。不直接查询 Multiremi 生产库。

## 回滚：B 删表之前

1. 负责人确认 B 尚未删表、保留的 v1 镜像与 daemon 正式产物可用，记录当前/旧 release。
   只读核对 `remi platform status --json` 与 B 审批/执行记录；不靠猜表是否存在决定时点。
2. **回滚前对每个 daemon 执行上节 outbox 排空命令**，必须全部 `true`/退出 0 并保持 drain。
   v1 不能读取共享未送达行；有 pending/blocked 或无法只读证明时禁止降级，按上节原因上报。
3. 授权负责人回退服务端镜像；v2 daemon 收到旧 ready 后进入 upgrade_wait，以 60s HTTP
   升级通道逐台发送降级请求到旧正式版本，使用既有 `runtime release start` JSON 输入能力，
   不改协议、不删 outbox。只读核对 `remi runtime release status <runtime-id> <request-id> --json`、
   本地 `remi daemon status --json` 和平台 health/ready/status；请求成功、实际进程旧版、心跳
   新鲜且两 provider 都恢复才算完成。每台短暂断供目标不超过 2 分钟，超出立即记录处置。
4. 确认整 fleet 和服务端均匹配后，负责人决定解除 drain。新增的可空 runtime 列由旧代码忽略，
   无须删列；此回滚不包括未经批准的删表、恢复数据库或改生产配置。

## 回滚：B 删表之后

1. **不允许回退到 v1，只能前向修复**。先核对 B 审批/执行记录及
   `remi platform status --json`，记录当前 release 与故障，不把旧镜像可启动当成可回退。
2. **任何产物替换/恢复计划前仍对所有 daemon 执行上节 outbox 排空命令**，通过条件同样是
   每台全部 lane `true`/退出 0、pending/blocked/未 ack 为 0 且 drain 生效。无法证明时记录原因，
   保留共享 outbox 并停在此步；不得以恢复 v1 来试读数据。此门禁不授权 B 后降级。
3. 负责人保持 v2，修复连通性与故障、发布新的 v2 产物，按上面的逐台核对验证 8 个 runtime。
   只读命令为 platform health/ready/status、runtime get/release status 和本地 daemon status。
   通过条件是目标 v2 版本、协议 ok、最新心跳、任务/outbox 排空且平台无失败升级。
   数据恢复或进一步删表需要另行批准和备份，不在 MUL-418 第二段执行。
