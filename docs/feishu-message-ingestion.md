# Feishu message ingestion

Feishu is one channel of the Messaging Core. The Core owns scheduling,
deduplication, cursors, retention, and outcomes; a Provider owns everything
channel-specific. `LarkCliMessageProvider` is the Provider for Feishu, and it
reaches Feishu by running `lark-cli` with argv — no shell, no HTTP service, no
long-lived credential in Remi's own storage.

A workspace wires a channel in two objects:

- a **Connection** names a Provider and holds its configuration. For lark-cli
  the configuration is which executable to run and how long to wait; the
  credential belongs to lark-cli, not to the Connection.
- a **Source** binds a Connection to a set of conversations, plus the allowlist,
  poll interval, and retention.

```bash
remi messaging connection add --provider lark_cli --name "Feishu (personal)"
remi messaging source add --connection <connection> --name "Team chats"
```

The older `remi feishu ...` commands and the `/feishu` API still work: they are
the same workflow bound to one channel and the legacy id space, kept for shipped
clients.

## 机器人发送者白名单

机器人默认使用 `sender_access_policy=agent`：能与机器人聊天的人，都可以使用回复 Agent 已开放的能力，无需绑定空间成员或单独审批发送人。Agent 自身的提议审批要求以及独立的任务策略仍然有效。升级后已有机器人同样默认采用此规则；已记录账号的 `allowed=false` 不再限制现有 Chat、子任务或由其触发的自动化建单。无需把 owner 或其他账号补进白名单。

需要额外限制发送人时，空间管理者可在设置的「集成」中主动开启白名单（`sender_access_policy=allowlist`）。只有此模式下才检查下面的账号授权。修改访问策略会在下一次 API 请求生效；任务凭证不能修改此配置。普通配置保存省略此字段时保留已选策略。

机器人收到请求时，按当前应用的 `(app_id, open_id)` 自动记录发送者并去重，保存显示名称、首次和最近请求时间；账号记录不等于建单权限。白名单模式下，新账号默认「待授权」。空间管理者可「加入白名单」或「移出白名单」，不需要关联 Remi 用户，也不创建空间成员。更换机器人应用后按新应用的账号范围重新管理。

账号列表会从机器人已接收消息的发送者信息补全姓名和英文名（`with_sender_name=true`），不要求额外的通讯录资料权限。Web 展示姓名、英文名、Open ID，并可展开查看 Union ID；CLI `sender list` 同步返回这些资料。列表每次最多刷新 10 个账号，单次网络查询最多 4 秒，同一账号 10 分钟内复用结果；查询失败保留已知姓名及原有授权。刷新只更新资料，不改变授权、首次或最近请求时间。无法读取姓名时，页面用账号 ID 后缀区分用户。

白名单控制该账号通过机器人 Chat 创建 Issue 的权限，未允许的账号仍可对话。Issue 创建时重新检查来源账号；允许后可继续当前 Chat，移出后该 Chat 及其子任务的下一次创建会被拒绝。同一 Chat 已收到多名发送者的请求时，全部来源账号都需允许。Agent 自身的提议审批策略仍独立生效；白名单不会将普通聊天中的「同意」当作审批，也不会追溯撤销已经建立的独立定时自动化。

已配置群话题的自动 Issue 创建同样检查白名单和 Agent 提议策略；已有 Chat 必须满足全部来源账号均已允许，才会在后续群消息到达时创建并绑定 Issue。群聊路由仍决定负责该 Issue 的 Agent。

旧版本已写入任务的 `issueCreationRestricted` 不会自动清除；历史任务缺少可可靠归因的发送者记录。遇到此类旧受限会话，加入白名单后需在飞书使用 `/new` 开始新会话，再发送请求。

未授权任务创建的持久 Agent 或 Autopilot 配置仍继承已有的提议审批策略，后续给账号授权不会自动清除这些配置上的策略；需要空间管理者另行调整。白名单的动态恢复针对 Chat 与普通任务来源链，不等于重写已保存的自动化权限。

[管理 API](../packages/server/src/api/routers/feishu-bot.ts)仅允许已登录的空间管理者读取和更新账号授权，task/daemon 身份不能自行授权。对应 [CLI](../apps/remi/cli/commands/workspace.ts)使用明确的位置参数，`sender` 为列表返回的账号记录 ID：

```bash
remi workspace feishu-bot sender list <workspace>
remi workspace feishu-bot sender allow <workspace> <sender>
remi workspace feishu-bot sender revoke <workspace> <sender>
```

这份账号白名单属于机器人对话链路，与下面 Messaging Source 的会话采集 allowlist 分开维护。

## 机器人消息回应

- **消息回应**：原消息收到后保留 🤔（`THINKING`）；任务正常完成且结果卡已确认发送后移除本机器人的处理中回应，不再添加 `DONE`；失败或取消仍替换为 ❌（`CROSSMARK`）。入队和 steer 返回不清除回应；最终任务快照携带全部原消息 ID，确保执行期间追加的消息也能更新。失败替换先添加新回应，再删除旧状态；成功清理也兼容旧版本的 `DONE`，保留其他人、其他应用及非回执类表情。本进程记录最近完成的消息，避免迟到的 received 回调恢复处理中；跨重启的入站事件由接收去重处理，投递重试则依据已持久化的结果卡 ID 跳过处理中回应。终态回应清理的可重试错误由持久化 outbox 重试，已确认的结果卡不重复发送，Runtime 交接不标记失败。实现见[回应状态](../packages/connectors/src/feishu/message-receipt.ts)与[任务投递](../packages/connectors/src/feishu/task-presentation.ts)。本次回执修复需要升级承载机器人的 Runtime。

## Deployment

There is no ingestion service, port, or endpoint registry. `lark-cli` is baked
into the API image at a pinned version whose archive digest is verified during
the build (`LARK_CLI_VERSION` and the two `LARK_CLI_SHA256_*` args in
`deploy/docker/Dockerfile.api`), and the API server spawns it in its own
container. `LARK_CLI_MINIMUM_VERSION` in the Provider is the floor the image
must stay at or above; a lower version reports the Connection as
`incompatible` rather than failing at some later call.

Authorize it once, inside the API container:

```bash
docker compose exec api lark-cli login
```

lark-cli writes its credential under `$HOME`, which in the API container is the
`REMI_HOME_DIR` bind mount. It therefore survives image upgrades, stays under
the operator's control, and never appears in Compose, an env file, a log line,
or Git. No Remi component reads or writes that file.

The Connection reports what it finds, so each failure mode is a visible status
rather than a silent stall:

| Situation | Connection status | Error code |
| --- | --- | --- |
| lark-cli not on PATH | `unavailable` | `provider_unavailable` |
| Not logged in, or the credential expired | `unauthenticated` | `unauthenticated` |
| Version below the Provider's floor | `incompatible` | `provider_incompatible` |
| Required subcommand missing | `incompatible` | `capability_unsupported` |
| Feishu throttled the call | `ready` | `rate_limited` (retried with backoff) |
| Command exceeded its timeout | `ready` | `timeout` (retried) |

`rate_limited` and `timeout` are retryable and never disable a Source; the
others need an operator and say which one.

An access token that has aged out is **not** one of these. lark-cli reports it
as `needs_refresh` and mints a new one on the next call, so the Connection stays
`ready`. Only a dead *refresh* token — roughly a week without use — reads as
`unauthenticated`, and only that needs a new `lark-cli login`.

### What lark-cli 1.0.90 cannot do yet

Constraints the Provider works within, verified against a live CLI by
`tests/integration/lark-cli-message-provider.test.ts`:

- **Page sizes are capped per subcommand** — 50 for `im +messages-search`, 100
  for `im +chat-search`. A Source configured for more gets the cap, not an
  error.
- **Timestamps arrive as a zoneless `YYYY-MM-DD HH:MM`**, rendered in the CLI's
  own timezone and with no seconds. The Provider runs lark-cli with `TZ=UTC` so
  the value means one instant everywhere; do not override `TZ` for the API
  container without changing the Provider to match. Ordering within a minute is
  not recoverable, which is why message identity is `(connection, message id)`
  rather than anything time-based.
- **Attachments are not addressable.** lark-cli renders them into the message
  text (`[Image: img_v3_…]`) and exposes no file key, so ingested messages carry
  their text but no attachment refs. Recovering the key by parsing that string
  would mean reading human-facing output, which this Provider does not do —
  closing the gap needs a structured attachment field in lark-cli.

## Production rollout runbook

Each step needs explicit per-session authorization from the platform owner.
Nothing here runs as part of ordinary development.

1. **Stage first.** Deploy the new API image to a non-production stack and run
   `docker compose exec api lark-cli --version`, then `lark-cli login`.
2. **Add the Connection and check it.** `remi messaging connection add
   --provider lark_cli`, then `remi messaging connection check <connection>`
   must report `ready`.
   Assert that no response body contains a credential path or a command line.
3. **Create the source disabled with an empty allowlist.** An empty allowlist
   ingests nothing, which is the intended state until the owner picks chats.
4. **Enable chats, then the source.** Confirm the activation watermark by
   checking that no message older than the enable time is stored, then verify
   ingestion, cursor advance, deduplication, and the Inbox/proposal paths on a
   low-traffic chat before adding busy ones.

### Upgrading from the retired sidecar

Installations before this release ran ingestion in a `feishu-sidecar` container
that shared the API container's network namespace. Nothing needs to be migrated
by hand:

- Existing sources, messages, outcomes, and cursors are carried over by the
  `20260831_messaging_core_v1` migration, which maps each legacy source to a
  Connection and re-keys messages by `(connection, external message id)`. It
  copies rather than moves, so history is not re-processed and nothing is lost
  if the release is rolled back.
- `DockerComposeDriver` removes the leftover sidecar container before it
  replaces the API container — Docker would otherwise refuse the switch, since
  the sidecar borrowed that namespace. Its named data volumes are left alone;
  deleting them is the operator's call.
- The pre-existing `personal-automation` deployment, if any, is untouched and
  needs no restoration step. It is no longer a runtime dependency.

### Rollback

1. Disable the source in the control panel. Ingestion stops immediately; stored
   messages and outcomes are retained.
2. Roll the API image back through the platform updater. Legacy rows were copied,
   not moved, so the previous release finds its own data where it left it.
3. To stop ingestion without a rollback, delete the Connection. The Sources bound
   to it stop polling and their stored messages stay readable.

## Processing guarantees

- An empty allowlist means zero ingestion in both the scheduler and storage
  layer.
- Enabling a chat records an activation watermark rounded conservatively to the
  next whole minute. Messages in that minute can be skipped, by at most about 60
  seconds, so no message from before authorization is retained.
- `processed_at` on each message is the processing source of truth. Unresolved
  messages are retried after 15 minutes by default. After three retries, the
  system records a terminal `dismissed` outcome with reason
  `unprocessed_timeout`.
- `notify` and `draft-reply` use the dedicated `feishu_messages` notification
  preference group and create Inbox items only. Ingestion never sends a Feishu
  message; a draft still requires a separate human-approved send path. When the
  recipient explicitly mutes this group, the system records a terminal
  `dismissed` outcome with reason `recipient_muted` instead of retrying and
  eventually reporting an unrelated processing timeout.
- `propose-issue` creates a non-blocking Inbox proposal and audited
  `issue_proposed` outcome. Only a human workspace admin can approve or reject
  it; approval creates the Issue and `issue_created` outcome atomically and
  idempotently, while rejection records `dismissed/proposal_rejected`.
- Configure the Feishu watcher agent with
  `remi agent update <agent> --issue-creation-requires-proposal`. This
  human-managed, default-off policy blocks that task identity from every direct
  and Autopilot-mediated Issue creation path while leaving ordinary collaboration
  agents unchanged. The caller-specific CLI capability response also marks
  `issue.create` and `issue.quick-create` unavailable for the restricted agent.
- The direct `create-issue` command is human-only. Task tokens cannot approve,
  reject, or bypass the proposal flow.
- Source status exposes the most recent successful ingestion, last sanitized
  error code, connection lag, consecutive failures, unresolved backlog, and
  timeout count, muted-delivery count, and pending Issue proposal count through
  `remi feishu source status <source>`.
- After three consecutive connection failures, the workspace owner receives a
  deduplicated Inbox alert in the `system_notifications` group, independently
  from Feishu message reminder preferences. Further failures do not create more
  alerts until a successful poll resets the failure episode.
