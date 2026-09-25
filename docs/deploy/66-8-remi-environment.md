---
title: Daemon 环境与工作区 Feishu bot 配置
status: active
summary: 说明 daemon 进程配置、工作区 bot 的控制面分配、凭据获取、交接及验证入口。
---

# Daemon 环境与工作区 Feishu bot 配置

[环境模板](66-8-remi.env.example)用于 Linux systemd daemon 进程。文件名沿用部署标识，不代表已验证某台机器的实际配置。当前启动解析见[resolveWorkerDaemons](../../apps/remi/cli/multiremi.ts)，运行默认值见[daemon.ts](../../packages/server/src/worker/daemon.ts)。

## Daemon 进程配置

| 变量 | 当前作用与默认行为 |
|---|---|
| `MULTIREMI_SERVER_URL` | 控制面地址。CLI 选项优先，其次环境变量、保存的 CLI 配置；均未提供时为 `http://127.0.0.1:6120`。 |
| `MULTIREMI_TOKEN` | daemon 使用的控制面鉴权凭据，也可由保存的 CLI 配置提供。实际权限由 API 验证；不要把用户管理配置的身份与 runtime token 混为一谈。 |
| `MULTIREMI_WORKSPACE_ID` | 注册目标工作区；可由 CLI 选项/保存配置提供，最终默认 `local`。部署时应显式指定目标。 |
| `MULTIREMI_PROVIDER` | 可选，指定 provider；未指定时探测本机健康 provider。至少一个 provider 可执行且已认证，前台 daemon 才能启动。 |
| `MULTIREMI_WORKSPACES_ROOT` | 工作目录根，默认 `~/.remi/multiremi/workspaces`；不要放在临时发版 checkout 中。 |
| `MULTIREMI_DAEMON_PORT` | 本机 daemon 控制端口，默认 6131；多 provider 时分配相邻端口。 |
| `MULTIREMI_GC_ENABLED` | 默认 true；是否运行周期性 workspace GC。 |
| `MULTIREMI_GC_INTERVAL_MS` / `MULTIREMI_GC_TTL_MS` | 启动默认分别为 900000 / 259200000 ms。工作区 `settings.session_archive` 可覆盖有效间隔和 TTL，见[GC policy](../../packages/daemon/src/agent-runtime/workspace/gc-policy.ts)。 |
| `MULTIREMI_HEARTBEAT_INTERVAL_MS` | 普通心跳间隔，默认 10000 ms。**只覆盖普通间隔**：被控制面分配到 Feishu concierge 的那台 daemon 固定用 3000 ms（`pending_feishu_outbound` 只通过 heartbeat ack 下发），不随此变量变大。是否属于「那台」按 supervisor 的实际状态判断，而不是「有没有挂 concierge host」——每台常驻 daemon 都会挂 host，否则所有机器都会停在 3 s。 |
| `MULTIREMI_CLAIM_IDLE_MAX_MS` | 空闲 claim 的退避上限，默认 30000 ms；退避从 3000 ms 起翻倍到该值。 |
| `MULTIREMI_PLUGIN_DESIRED_REFRESH_MS` | 只在 server 未在 heartbeat ack 里返回 desired revision 时生效的兜底刷新间隔，默认 30000 ms。 |
| `MULTIREMI_AUTHORITY_PROBE_MAX_MS` | terminal authority 之后 register 探测的间隔上限，默认 900000 ms（15 分钟）。 |

bot 的 Agent、承载 Runtime、App ID、App Secret 和 domain 从控制面配置获取，不在本机环境文件中指定。共享配置层仍支持一些 Feishu/OAuth 相关环境变量，但当前 bot 启动的身份由 assignment 覆盖；设置本地应用凭据不会创建或启用工作区 bot。

将填好的环境文件放在服务账户下，例如 `~/.config/remi/66-8-remi.env`，限制为该账户可读，并在对应 user unit 中引用：

```ini
[Service]
EnvironmentFile=%h/.config/remi/66-8-remi.env
```

systemd 环境文件权限示例为 `0600`。不要提交填入凭据的文件。安装/管理服务使用 [CLI service 实现](../../apps/remi/cli/multiremi/service.ts)；安装器不把命令行 token 写进 service 文件。完成 unit 后执行 `systemd-analyze verify <unit-path>`，再按部署流程启用服务。

## Heartbeats and network recovery

Runtime availability is derived from control-plane heartbeats and the
[freshness window](../../packages/contracts/src/runtime-health.ts), not from SSH
connectivity or whether the machine is powered on. A ready local `/health`
response does not prove that the control plane is still receiving heartbeats.

The [daemon client](../../packages/server/src/worker/client.ts) applies a default
30-second deadline to control-plane JSON requests, including connection setup,
response headers, and body reads for both successful and error responses. This
bounds heartbeat, plugin configuration, and task claim requests that would
otherwise block subsequent polling. Archive content uploads retain their
separate timeout budget.

The running [poll loop](../../packages/server/src/worker/daemon.ts) logs transient
failures and retries at the heartbeat interval. Timeout errors identify the
method, path, and deadline. The same daemon resumes polling when the connection
recovers; the HTTP client does not automatically replay writes.

Heartbeat, desired-state refresh, and task claim run on separate timers:

- **Heartbeat**: 10 s by default. The Runtime the control plane actually
  *assigned* the workspace Feishu concierge to runs 3 s, because its ack carries
  proactive replies. Being able to host the bot is not the same thing: every
  long-running daemon is offered the host so the bot can be handed to any of
  them, and only `FeishuConciergeSupervisor.snapshot().state !== "stopped"`
  (starting, online, failed) selects the fast lane. Assignment and handover
  re-apply the cadence immediately, so a Runtime receiving the bot does not wait
  out a pending 10 s interval, and one that hands it back returns to 10 s.
  `MULTIREMI_HEARTBEAT_INTERVAL_MS` replaces the normal interval only; the
  assigned Runtime keeps 3 s. `/health` reports `heartbeat_interval_ms`. Runtime
  liveness tolerates this easily — the stale window is 5 minutes, see
  [runtime-health](../../packages/contracts/src/runtime-health.ts).
- **Desired Agent Plugins**: fetched when the heartbeat ack reports a revision
  that differs from the cached one, forced every 10 minutes as a backstop, and
  fetched at most every `MULTIREMI_PLUGIN_DESIRED_REFRESH_MS` against a server
  that does not report a revision at all. A matching revision still re-runs the
  local reconcile so retry deadlines and setup re-checks stay on schedule.
- **Task claim**: an empty claim doubles the wait from 3 s up to
  `MULTIREMI_CLAIM_IDLE_MAX_MS` (30 s). Claiming work, finishing a task, a drain
  release, an update-pause release, and a `daemon:task_available` frame all reset
  it to 3 s.

The daemon subscribes to `GET /api/daemon/ws?runtime_ids=<runtimeId>` only to
receive `daemon:task_available`, which is what keeps the 30 s claim ceiling from
becoming task-start latency. It is an accelerator, never a control channel: no
liveness, heartbeat, or task state travels over it, and if the upgrade cannot be
established the polling backoff alone still delivers work. `/health` reports
`claim_wake_ws` with `state` (`connected` / `connecting` / `disconnected` /
`disabled`), `connected_since`, `last_error`, `reconnect_attempts`,
`next_reconnect_at`, and `suspended`, plus `claim_idle_next_at`. `connected` is
set by the socket's `open` event, so a socket still completing its handshake
reports `connecting` rather than a false `connected`. Reconnects back off
exponentially (1 s to 30 s) with jitter, and a replaced Runtime id tears the old
socket down without letting its late `close` corrupt the new one or schedule a
second reconnect.

Authority failures such as 401, 403, and 410 still enter terminal cleanup,
including when their response headers arrive but the error body times out or is
interrupted. A long-running daemon then stays alive and probes
`POST /api/daemon/register` on a widening schedule (30 s, 1 m, 2 m, 4 m, 8 m,
then `MULTIREMI_AUTHORITY_PROBE_MAX_MS`) instead of exiting: exiting hands the
retry cadence to the service manager's restart policy, which is what turned a
revoked credential into a request every few seconds. The first failure is logged
at ERROR, later probes at WARN with the next probe time, and `/health` exposes
`authority_probe: { attempts, next_probe_at }`. A successful probe requests a
process restart through the existing restart channel, and the wake-up socket
also stops reconnecting while authority is revoked (`claim_wake_ws.suspended`)
so a refused credential does not produce a handshake attempt every 30 s. `--once`
still surfaces request failures to its caller.

Stopping the daemon cancels pending heartbeat and plugin configuration requests.
Cancelling the initial plugin query also finishes startup cleanly; workspace
ownership loss and other startup failures still propagate to the caller.
Task claims, execution, and durable reports keep their existing drain semantics.
These deadlines do not resolve operating-system network permissions, service
launch configuration, or synchronous event-loop blocking.

The [client tests](../../tests/unit/multiremi/multiremi-daemon-client.test.ts),
[poll cadence tests](../../tests/unit/daemon/poll-cadence.test.ts),
[authority probe tests](../../tests/unit/daemon/authority-probe.test.ts), and
[HTTP recovery tests](../../tests/integration/multiremi-daemon-heartbeat.test.ts)
cover connection loss/reopening, stalled headers and bodies, stalled plugin
queries and claims, 503 responses, the cadence and wake-up rules above, and
shutdown cancellation using isolated databases and directories without
contacting a production Runtime.

## 工作区 bot 配置与启动

当前配置由[Feishu bot API](../../packages/server/src/api/routers/feishu-bot.ts)管理，存于 `multiremi_feishu_bot_configs`，每工作区一条，关联 agent_id/runtime_id；不是 `workspace.settings.botMenu`。botMenu 是独立的菜单配置。

1. 启动连接目标工作区的 daemon，确认其 provider 可用，并上报 concierge 配置协议。持续运行的前台 daemon 安装 concierge host；`--once` 不安装它。
2. 工作区 owner/admin 在设置中选择 Agent、兼容且支持配置协议的 Runtime，录入应用身份或使用扫码创建入口。普通成员只读取 bot 可用性，不读取部署配置或密钥。
3. 测试凭据，保存配置并 deploy；以 status 返回的实际状态确认是否 online。仅保存或测试成功不表示连接器已经启动。

当前 canonical 管理命令来自[工作区 CLI](../../apps/remi/cli/commands/workspace.ts)，工作区是位置参数：

```bash
remi workspace feishu-bot candidates <workspace>
remi workspace feishu-bot set <workspace> --help
remi workspace feishu-bot test <workspace>
remi workspace feishu-bot deploy <workspace>
remi workspace feishu-bot status <workspace>
remi workspace feishu-bot stop <workspace>
```

这些管理操作使用具备工作区管理权限的成员身份；daemon 凭据负责它自己的注册、心跳和受限 Runtime API。

App Secret 在 API 侧通过 [AES-256-GCM](../../packages/server/src/feishu-bot/credentials.ts)加密保存，并绑定 workspace/field。服务端可配置 `MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY`（base64 编码的 32 字节密钥）；实现也支持从 SCM、SSH Mesh 或控制面 master token 派生回退密钥。轮换可使用 `MULTIREMI_FEISHU_BOT_ENCRYPTION_PREVIOUS_KEYS` 保留旧解密密钥。以上是 **API 服务端配置**，不是 daemon 模板参数；实际配置及备份需要保持可恢复，不能只替换密钥后丢弃旧密钥。

## 实际分配、交接与消息执行

[daemon 心跳路由](../../packages/server/src/api/routers/daemon.ts)中的 bot 配置指令发送 revision、desired_state、config_available。选中的 Runtime 再使用绑定的 daemon 身份访问 `GET /api/daemon/runtimes/:runtimeId/feishu-bot`，获取本次启动的凭据与 Agent；其他 Runtime 无法获取该 assignment。明文凭据用于内存中的 transport，不持久化到本机环境文件。

支持出站投递协议的 Runtime 还会从心跳响应的 `pending_feishu_outbound` 领取待发送结果；[daemon](../../packages/server/src/worker/daemon.ts)通过 concierge host 发送后，将投递结果和 claim token 上报到 `POST /api/daemon/runtimes/:runtimeId/feishu-bot/outbound/:deliveryId/result`。这条结果推送链路独立于 bot 配置指令，过期投递租约会被服务端拒绝。

[FeishuBotRepo.directiveForRuntime](../../packages/server/src/store/repos/feishu-bot-repo.ts)给未选中的 Runtime 下发 stopped；新 Runtime 等待其他 host 的 online/starting 状态消失或超过当前 90 秒新鲜度窗口后才得到配置。这是基于状态上报的交接门控，不能描述为具备独立到期停机保证的强租约。[Supervisor](../../packages/server/src/worker/feishu-concierge.ts)串行启动/停止、上报状态并退避重试；新 revision 会重新尝试。

单机工作目录另由[process-owner](../../packages/daemon/src/agent-runtime/workspace/process-owner.ts)的 supervisor lease 保护，以进程存活判断所有权。它与 bot 跨 Runtime 的状态交接是不同机制，不能因为一次心跳延迟就移除仍存活的本机 owner。

[controlPlaneConciergeHost](../../apps/remi/cli/multiremi.ts)和[bootFeishuChannel](../../apps/remi/cli/agent.ts)只启动传输及卡片处理。消息提交到控制面 Chat/Task 链路：同事件去重，有活跃任务时 steer，否则创建关联 Chat Session 的 Task，执行仍走 Task → AgentSession → ACP。Agent instructions 使用该任务所选的 Agent row，不启动一份独立的人格运行时。

机器人按应用范围的 `(app_id, open_id)` 记录发送者，默认 `sender_access_policy=agent`，无需绑定工作区成员或额外授权即可使用 Agent 已开放能力。工作区管理者可主动改为 `allowlist`，通过 `remi workspace feishu-bot sender list|allow|revoke` 管理机器人 Chat 及其任务来源链的 Issue 创建权限；未授权账号仍可普通对话，Agent 自身的提议审批策略继续生效。具体策略与命令见[机器人发送者白名单](../feishu-message-ingestion.md#机器人发送者白名单)。它与 Messaging Source 的会话采集 allowlist 相互独立。

## 升级条件与检查

仅当旧安装仍有本地 bot-menu 数据时，按[菜单迁移](../migrations/remi-bot-menu-to-workspace-settings.md)审阅并转换；不要把迁移步骤当作新部署启动前置条件。GC 间隔决定检查频率，不保证固定时间内完成归档或清理；检查有效工作区 policy、归档状态和 daemon 日志。

```bash
bun test tests/unit/multiremi/multiremi-feishu-bot-config.test.ts tests/unit/multiremi/multiremi-feishu-bot-daemon.test.ts
bun test tests/unit/multiremi/feishu-concierge-supervisor.test.ts tests/unit/multiremi/feishu-concierge-host.test.ts
bun test tests/unit/multiremi/multiremi-feishu-bot-task-bridge.test.ts
```

这些是当前验证入口；实际执行结果应记录在对应任务或 PR，并分别说明 Bun 测试、服务重启、凭据测试和真实飞书消息收发的验证范围。
