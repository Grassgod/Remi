# Feishu Issue Topic Replies

When Issue topic synchronization is enabled, the configured group `chat_id`
accepts human messages without mentioning the bot, including new top-level
messages and replies inside topics. Existing topic replies continue their bound
Chat Session. Other groups still require a bot mention or a slash command.
Messages authored by bots and messages directed only at other people are ignored.
Sender identity and workspace permission checks in the Task API are unchanged.

Replies to human group messages mention that message's sender in the card footer,
using the bot-scoped `senderOpenId` already supplied by the incoming event. The
initial card and all progress patches omit the mention. Only the final patch adds
it to the footer, including failed/cancelled terminal cards. This sends no separate
notification message and never substitutes the Issue creator or mentions everyone.
Private replies do not infer a recipient.

Proactive work-round reports in the configured Issue notification group default
to mentioning the group owner. Workspace owners/admins may instead select one
bot-scoped open ID (`person`) or disable mentions (`none`) in Issue topic settings.
Other groups, private conversations, and the initial topic-root message are not
given a default recipient. Notification settings do not grant workspace access.

The bot-hosting daemon queries the owner through the same bot application's
`GET /open-apis/im/v1/chats/:chat_id?user_id_type=open_id`. Each new report reads
the current owner. Lookup is bounded to five seconds; missing owners (including
bot-owned groups), missing permissions, and network failures omit the mention
with a sanitized warning, without blocking the report.

Recipient policy is snapshotted on the first delivery claim. Before sending the
initial card, the daemon checkpoints the resolved open ID (or explicit null)
using `status: prepared` on the existing outbound result endpoint. Lease/runtime/
workspace checks and a compare-and-set keep the first resolution immutable.
The saved ID is only rendered on the final card; retries neither re-query the
owner nor change recipients when settings or ownership change. A failed checkpoint
does not send a card. Old cards already sent without a checkpoint stay unmentioned.
PATCH updates the card's mention markup; actual client notification behavior
requires live Feishu acceptance and is not guaranteed by renderer tests.

The subtitle is a single native Feishu header line: Agent name, engine, and
compact model name, for example `Remi Claude opus5`. It uses the acknowledged
ACP session selection (including default and resumed sessions), not the Agent's
mutable configured default. Full model IDs remain in persisted `execution`
Task messages; only the card display removes redundant prefixes and separators.
Unknown models are omitted and long subtitles use Feishu's native ellipsis.

The common footer orders its columns as sender mention, elapsed time, context
used/limit, and tool count. Existing clock, context, and tool icons are preserved;
`flow` layout wraps columns on narrow screens. Context is the latest root-session
`usage` message's `used/size`, never the sum of Task billing entries. Compaction
can decrease it, model changes clear stale samples, and absent limits display
`used/—`. No context sample means no context column. Completion, cancellation,
failure, and durable replay keep the same rendering rules and PATCH transport.

These display events use the existing Task message API and CLI:
`remi task message list <taskId> --json`. No new Provider execution path is
required. Upgrade the executing daemon as well as the
bot-hosting daemon to get model metadata; older Task transcripts omit missing
metadata rather than guessing. Billing and cost accounting are unchanged.

The selected bot runtime receives the exact group policy on each heartbeat.
Changing `chat_id` removes the old group from this policy; disabling synchronization
removes it entirely. No process restart or bot credential change is necessary.
The existing CLI commands remain the configuration entry points:

```bash
remi workspace issue-topics get
remi workspace issue-topics set --enabled --chat-id oc_example
remi workspace issue-topics set --disabled
remi workspace issue-topics set --enabled --chat-id oc_example --notify group_owner
remi workspace issue-topics set --enabled --chat-id oc_example --notify person --notify-open-id ou_reviewer
remi workspace issue-topics set --enabled --chat-id oc_example --notify none
```

Proactive work-round reports use the same persisted Task messages and card
renderer as interactive replies. A v4 concierge consumes events while the Task
is queued/running, renders tool steps and human requests, then finalizes the same
card. Card delivery never invokes a Provider directly. It runs independently of
the daemon heartbeat/claim loop and renews its delivery lease while waiting.

Interactive replies and proactive reports both create an ordinary interactive
message and update it exclusively through `im.message.patch`. Neither uses
CardKit, per-element updates, or native streaming mode. Text, status, and tool
events are coalesced on the same three-second interval. Human-request forms and
the final result are patched immediately. One serialized queue prevents a slow
progress update from overwriting the final result.

Durable delivery metadata supplies the message identity, recipient snapshot, and
lease-owned lifetime; it does not select a different update transport.
The Feishu message ID is persisted before event consumption; retries replay into
that card, with the delivery UUID deduplicating initial sends. Delivery failures
remain retryable. Settled human requests are not reopened during replay.

## Decision Cards For Human Requests

An Issue task that asks a human for input no longer wakes a relay Agent to ask in
prose. The control plane builds the card itself and queues it as a
`decision_card` outbound delivery; the bot host resolves the @, sends it,
registers the click, and later rewrites it. `buildTaskInteractionCard` and the
`encodeDecisionCardBody`/`decodeDecisionCardBody` pair live in
`packages/shared/src/feishu-task-card.ts`, so the writer and the reader cannot
disagree about the body shape.

The lane is gated on the host's own declaration: a daemon that reports
`feishu_decision_card: 1` on its heartbeat gets cards, and one that does not keeps
the previous relay-wake behavior. Silence is an answer, so a downgraded build
stops receiving cards on its next heartbeat. A host that lacks the flag skips only
card rows; the claim filter is part of the query, so ordinary deliveries queueing
behind a card still go out.

Who may press the button comes from the topic's `notifyMode`. `person` names the
open ID in `interaction_open_id` before the delivery is queued; `group_owner` is
resolved by the host with the bot token, and the recipient it used is
checkpointed when it reports the send; `none` never produces a card. A click is
accepted only when the callback's chat matches and the operator's open ID equals
the checkpointed recipient — anyone else gets the 「请由卡片中指定的处理人提交」
toast.

The click handler lives in the bot host process. Since this lane has no Task
stream, there is no presentation checkpoint to replay: the host registers a card
as it sends it, and rebuilds its registrations after a restart from
`GET /api/daemon/runtimes/:runtimeId/feishu-bot/decision-cards`, which lists the
pending requests whose cards it sent. The route answers in the daemon protocol's
snake_case shape (`request_id`, `task_id`, `chat_id`, `message_id`,
`recipient_open_id`) and is readable only by that Runtime's own daemon token.

The heartbeat's `pending_feishu_outbound` carries the same decision fields as the
recovery route — `kind`, `human_request_id`, `human_request_task_id`,
`target_message_id`, `expires_at` and `degraded` — because it is the path a host
actually receives work on. A missing `human_request_task_id` left a freshly sent
card unclickable until the next restart, and a missing `degraded` made an
already-plain-text row look like a malformed card worth retrying.

`multiremi_task_human_requests.expires_at` carries the deadline (the server
defaults to one hour when an older daemon sends no `timeout_ms`). The lifecycle
feeds three delivery kinds, keyed by request id: `decision_card` (send),
`decision_card_patch` (rewrite in place after a response, timeout, or
cancellation) and `decision_reminder` (one text nudge that @s the person who was
asked). MUL-403 replaces the event source — the request write plus host polling
today, a Live Hub subscription later — without changing these kinds or the
checkpoint fields.

A reminder is due at `expires_at - min(10min, half the request's lifetime)`, so a
five-minute unattended request is not already due the moment its card is sent. It
is materialized inside the claim transaction and deduplicated by
`reminder_sent_at`; a request whose card has not gone out yet does not consume
that one slot, so a host that was offline across the window still delivers exactly
one nudge after it returns.

The one floor on that: a reminder is only worth sending while it leaves the reader
time to act. With less than a minute of lifetime left the nudge is suppressed
entirely — the same predicate gates the normal window and the catch-up, and it is
evaluated inside the claim transaction so SQLite and Postgres agree.

Whichever side decides it, the degradation lands on the Issue as one
`decision_card_degraded` activity with the same fields (`request_id`,
`source_task_id`, `delivery_id`, `kind`, `reason`), written once per delivery. The
control plane writes it when it already knows there is nobody to ask; the host
writes it when its own lookup or the send fails. Every reverse lookup of an Issue
from a binding, Task or request goes through one workspace check, so the pointer
being stale or wrong cannot aim the activity at another workspace: the delivery's
own binding counts only when the Issue it names is in the delivery's workspace,
the fallback to the asking Task requires the Task and its Issue to agree, the
push itself refuses a Task whose `issue_id` belongs elsewhere, and the reminder
resolves its Issue the same way before it spends `reminder_sent_at` — a CAS that
ran first would burn the one reminder on a row it then skipped.

Degradations all end in the same place — plain text carrying the question, its
numbered options and the parent Issue's workbench link, with no internal ids and
no @. Three cases reach it: `notifyMode = none`, an unusable `person` target, and
a `group_owner` the host cannot resolve. Those rows are written as `decision_card`
with a `degraded` reason, so the host posts text and the control plane skips both
the terminal patch and the reminder's @. A fourth case is decided at send time: a
non-retryable Feishu rejection replaces the card with the same text twin and
reports `send_failed`. Retryable failures stay on the outbox backoff.

An Issue whose topic has no seed message gets no delivery at all and records the
`decision_card_skipped` activity, so the request is visible on the web workbench
only.

A stored topic config that the current validation would reject — most often a
`person` mode whose `notify_open_id` is missing or malformed, which a database
written before that validation existed can still hold — is read leniently rather
than throwing. Save-time validation is unchanged, and such a config degrades to
the text delivery above instead of producing a request that reaches nobody.

That leniency has to cover every reader a daemon request runs through, not only
the delivery writes. The directive is read on every heartbeat, before the
outbound claim, so a strict read there answered 500 and the text delivery the
same request had already queued never reached the host. The directive uses only
`enabled` and `chatId`, so it reads the config the same forgiving way: a rejected
`person` target, a missing field, a wrong type or a settings blob that is not JSON
all leave the host running with an empty `no_mention_chat_ids` rather than
failing the heartbeat. The claim derives the `@` for an older relay row (a Task
id with no stored mention) from the same config, and that read sits ahead of every
delivery in the batch: a rejection there stranded the whole queue, so it tolerates
exactly `IssueTopicConfigError` — the old row goes out as plain text with no `@`,
and the next row still ships. Any other failure still propagates.

Inbound messages (`submitMessage`) also use the lenient reader. Invalid stored
notification settings produce a warning containing only the workspace ID; they
do not block message acceptance or automatic Issue creation when `enabled` and
`chatId` match. Invalid `projectIds` are treated as no project selection.
The settings GET returns HTTP 200 with the recovered `config` and an optional
`invalid: { code, message }` containing static validation details. Valid configs
keep the previous response shape. The settings page shows the validation reason
and asks the user to correct and save the configuration. PUT reads the previous
config leniently but still validates the new config strictly: replacing an invalid
recipient is allowed, while retaining an invalid `person` target returns HTTP 400.

An expired request is never an approval: the terminal card reads
「已超时，未回答」and the task takes the existing cancel path. The decision lanes
carry no receipt or reaction target (`task_id` is NULL), so their failure modes do
not exist here. The tests hold that down at the transport rather than the handler
surface: the lane is driven through a real `FeishuConnector` with the Lark SDK's
own HTTP layer pointed at a recorder, and the assertion is over the requests that
crossed the wire. Recording only the mocked card/text/patch methods missed a
request inserted straight into the transport.

A retryable send failure stays on the outbox: the row returns to `pending`, its
`attempt_count` is not reset, `last_error` records the Feishu code, and
`available_at` moves out by the exponential backoff, so the next claim after that
moment picks up the same delivery instead of a second card.

An additive nullable `mention_snapshot` column on outbound deliveries stores
recipient policy/resolution. Existing settings default to `group_owner`, with no
history backfill or resend. Old v2/v3 daemons keep receiving final-body deliveries
only; older v4 daemons ignore the optional mention plan. Upgrade the API and
bot-hosting daemon together to enable proactive mentions and final-only timing.

Issue-associated Chat tasks keep their Chat directory and provider session.
Only genuine Issue discussion tasks require an Issue Session lifecycle lock.

## 真人验收步骤

前置条件（每一步都适用，不再重复）：

- 一个 workspace 已配置飞书机器人并在线，话题群已通过
  `remi workspace issue-topics set --enabled --chat-id <chat>` 绑定，`notifyMode`
  为此处的默认值 `group_owner`，父单在该 workspace 里有一个可执行任务。
- bot host 已经换成本分支的 daemon（heartbeat 上报 `feishu_decision_card = 1`），
  API 侧也是同一版本；老 host 会退回转述唤醒，看不到卡片。
- 「谁来操作」列写的是机器或人：**发起人**负责让父单任务提问，**被问的人**是
  卡片上被 @ 的那个人，**第二个人**是任意另一个飞书成员。
- 「父单活动」指父单详情页时间线或 `remi issue timeline <issue-id> --json` 里的
  `activity` 条目；`degraded` 指投递行
  `multiremi_feishu_bot_outbound_deliveries.degraded` 的取值。

| # | 谁来操作 | 操作 | 飞书上看到什么 | 父单活动 / `degraded` |
|---|---|---|---|---|
| 1 | 发起人 | 让父单任务问一个 AskUserQuestion（`notifyMode=group_owner`，话题已有 seed） | 话题里出现一张**独立卡片**：头部 Agent 名与时间、原问题、编号选项、自定义输入框、提交按钮 | `decision_card_queued`（`kind=decision_card`）；`degraded` 为 NULL |
| 2 | 第二个人，然后被问的人 | 第二个人点提交；被问的人再点提交 | 第二个人得到 toast「请由卡片中指定的处理人提交」，卡片不变、问题仍在；被问的人点后提示「已提交」，同一张卡片**原地**变为终态（答案、答者、时间），不新增消息 | 第二个人点击不写活动；被问的人提交后请求变 `responded`，卡片走后一条 `decision_card_patch` 投递；`degraded=NULL` |
| 3 | 发起人，在被问的人之外 | 再问一次，这次在 Remi 工作台（网页）回答 | 飞书那张卡片同样**原地**变终态，并回显原问题 | 同第 2 步：`decision_card_patch`，无新增卡片；`degraded=NULL` |
| 4 | 发起人 | 再问一次，放着不答；需要快速看到结果时用较短的 `timeout_ms` | 提醒时刻为 `expires_at − min(10 分钟, 总时长的一半)`：默认 60 分钟超时即 T−10min，15 分钟超时即 T−7.5min。话题里出现**一条 @ 被问的人**的文字提醒，且只出现一次；到点后卡片变「已超时，未回答」，任务按既有 cancel 结果继续，授权类请求不会被自动批准 | `decision_card_reminder` 恰一条；卡片终态仍走 `decision_card_patch`；正常卡片与提醒行 `degraded=NULL` |
| 5 | **不执行**（自动化覆盖） | — | — | 见下方说明 |
| 6 | 发起人 | `remi workspace issue-topics set --enabled --chat-id <chat> --notify none`，再问一次 | **只有文字**、不出卡片、不 @ 任何人，文字含问题、编号选项与父单网页链接 | `decision_card_degraded`，`reason=notify_none`；`degraded=notify_none` |
| 7 | 发起人 + 被问的人 | 发一张卡片后，在 bot host 机器上重启该 runtime 的 daemon（或 kill 掉让平台重拉），等它重新上线，再由被问的人点之前那张卡片的提交按钮 | 重启后旧卡片仍然可点：提交成功、卡片**原地**变终态 | 恢复来自 `GET /api/daemon/runtimes/:runtimeId/feishu-bot/decision-cards`；活动同第 2 步；`degraded=NULL` |

第 4 步的提醒时刻按公式算，不要按固定 T−10min 期待。

### 第 5 步：自动化覆盖，真人不执行

原第 5 步要求「把话题指向一个 bot 没有发言权限的 chat」，预期卡片被拒后改发
文字。这一步**无法按原样执行**：卡片被拒后，文字仍发往同一个
`delivery.chatId`（`apps/remi/cli/multiremi.ts:754-761,775-788`），bot 对那个
chat 没有发言权限时文字同样会被拒，而 `onDecisionSent` 只在文字发送成功后才
调用，所以拿不到「文字已送达、活动为 `send_failed`」的预期结果。

因此第 5 步改为自动化覆盖，覆盖它的测试是
`tests/unit/multiremi/multiremi-feishu-decision-card.test.ts`
的 `step 5: a card Feishu rejects non-retryably becomes one sent text, once`。

该用例走完整回报链，而不是在发送之后手工写一条回报：真实
`MultiremiDaemon.handleHeartbeatAck` → 真实 `queueFeishuBotOutbound` →
`handleFeishuBotOutbound` → 真实 `deliverFeishuOutbound` → 真实 `sendDecisionLane`
（真实 `FeishuConnector`，只在 SDK 传输层把卡片的 `POST .../reply` 应答改为不可
重试错误码 `230001`、文字的应答放行）→ 真实 `MultiremiDaemonClient`
→ 真实 `POST /api/daemon/runtimes/:runtimeId/feishu-bot/outbound/:id/result`
回报路由 → 真实 `reportFeishuBotOutbound`。测试自己只提供两样东西：进程内
不存在的 Feishu channel handle（本例用真实 connector、只包一层记账），以及
HTTP 到测试内 API 的那一跳。

回报链跑完后它断言四件事——卡片被不可重试地拒绝、文字发送成功、父单活动恰好
一条且 `reason=send_failed`（`degraded=send_failed`）、这条投递变 `sent` 后不再
作为坏卡被重试（同一请求只有一条投递，也没有 `decision_card_patch`）。

`tests/unit/multiremi/feishu-concierge-host.test.ts` 的
`degrades a rejected decision card to its text twin instead of retrying it`
只断言 host 本地的 degrade 分支与它交给 `onDecisionSent` 的回执，不经过 daemon
回报链，因此与第 5 步不重复——完整回报链由第 5 步覆盖。

第 6 步（`notifyMode=none`）验证的是**预先降级**：控制面在建请求时就判定没人
可问，直接把文字行排进队列。它不经过「卡片被飞书拒绝」这条路径，因此**不能替代
第 5 步**。

## Decision Cards ("待你决定") in the Topic

An E4 decision handed to a person rides the same card pipeline as the human
requests above (MUL-412). The control plane writes one `decision_card` delivery
into the topic of the Issue the decision hangs on — the parent when there is
one, otherwise the source Issue — and the bot host sends it, registers the
submit button, and rewrites the same message when the decision settles.

Only two states get a card: `pending -> escalated` and a decision created
straight as `escalated`. A decision the parent's owner agent answers itself
never leaves the web workbench, and a decision whose Issue has no topic seed
message records `decision_card_skipped` with `reason = no_topic` and stays on
the web rather than being re-aimed at the source Issue's topic.

A decision has no deadline. There is no timeout state and no expiry column; the
card gets exactly one text nudge 50 minutes after it was sent, deduped on the
decision row's own `reminder_sent_at`, and that nudge @s the person the card was
addressed to. Answers and withdrawals — from the topic, the web workbench or the
CLI — all queue one `decision_card_patch` that rewrites the original message to
「已回答」or「已撤回」. A card that went out as plain text (`notifyMode = none`,
an unusable `person` target, or a Feishu rejection that retrying cannot fix)
gets neither a patch nor a reminder, because there is no card on screen to
rewrite.

Permissions follow the human-request lane, with one addition. Only the operator
named on the card, in the chat it was sent to, may submit; anyone else is told
「本次没有提交：这条只能由卡片上点名的人回答。请转告对方在卡片上回答；如果你也是
这张单的负责人，可以到网页端回答。」. The operator's Feishu `open_id` is then resolved
server-side to a live, non-archived, non-agent workspace member — one the users
table already knows through same-app SSO (`external_id`), or through a sender
row scoped to the same workspace + bot app + `open_id` whose `union_id` links a
user. An `open_id` is never compared directly with a `union_id`. Zero valid
members is refused with `decision_member_unmapped`; more than one is refused
with `decision_member_ambiguous`. The request body carries no answerer: it names the
operator that Feishu reported and nothing else, and the write goes through the
same store function as the HTTP answer route, so `history`, `answered_at`, the
`decision_answered` / `decision_received` activities, the inbox item and the
wakeup of the source Issue's owner are identical whichever surface answered.

A bot host may read and answer only decisions on an Issue that has an active
topic binding under its own app; creating, escalating and withdrawing stay with
the executing side and the human surfaces. The capability flag
(`feishu_issue_decision_card`) is declared separately from the human-request
one, so a host that predates decisions is handed no decision card at all — the
decision simply stays on the web workbench, exactly as it did before.

### 真人与第二个人验收（D6）

前置条件与上一节相同，另加两条：decision 挂在**父单**上（子单里 `remi issue
decision request` 出来的是子单自己的父单），且 bot host 的 heartbeat 报
`feishu_issue_decision_card = 1`。清单里的「网页」指父单详情页的「待你决定」
区域，或 `remi issue decision list <parent>`。

第 2 步的「第二个人」必须先由**第二个人本人**建立可信映射：任选其一，用飞书
SSO 登录一次 Remi 网页端，或先在本次测试话题给 bot 发一条消息。操作员随后在
209 上只读核验：以本 workspace、当前 bot `app_id` 和第二个人的 `open_id` 查询
`multiremi_feishu_bot_senders`，再用其 `union_id` 关联 `multiremi_users` 和未归档的
`multiremi_workspace_members`；走 SSO 时，仅当 API 容器的
`MULTIREMI_LARK_APP_ID` 与当前 bot `app_id` 相同，才用 `users.external_id = open_id`
查询。排除 member id 同名的 agent 后，查询结果必须**恰好一条**。这可以在 API
容器中用现有 `MULTIREMI_DATABASE_URL` 执行只含 `SELECT` 的查询完成，不打印连接串
或凭证，也不写库；同时用 `remi member list --output json` 核对该 member 属于本
workspace。结果为 0 或多于 1 时，不进入第 2 步。

核验前先确认 SSO secret 已配置；只记录「已配置」，不写值。下面是只读查询模板，
`$1` 到 `$4` 依次为 workspace id、bot app id、第二个人的 open_id，以及 SSO app
是否与 bot app 相同。最终只数 `DISTINCT member.id`，不要把同一 member 的 sender
与 SSO 两条证据误数成两个人：

```sql
WITH candidate_user AS (
  SELECT users.id
  FROM multiremi_users AS users
  WHERE $4::boolean AND users.external_id = $3
  UNION
  SELECT users.id
  FROM multiremi_feishu_bot_senders AS sender
  JOIN multiremi_users AS users ON users.feishu_union_id = sender.union_id
  WHERE sender.workspace_id = $1
    AND sender.app_id = $2
    AND sender.open_id = $3
)
SELECT DISTINCT member.id
FROM candidate_user AS candidate
JOIN multiremi_workspace_members AS member ON member.user_id = candidate.id
WHERE member.workspace_id = $1
  AND member.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM multiremi_agents AS agent WHERE agent.id = member.id
  );
```

下面 7 步每一步都新建一条 decision；不得复用上一步已经回答、撤回或用于降级
验证的 decision。

| # | 谁来操作 | 操作 | 飞书上看到什么 | 预期活动 / 数据 |
|---|---|---|---|---|
| 1 | 发起人 | 在子单里提一个 `production_change`（`remi issue decision request <child> --kind production_change --title "..." --option 是 --option 否`），或让父单负责人 agent 把一个 `merge` 上交给人 | 父单话题里出现一张**独立卡片**：标题、正文、编号选项、自定义回答框、提交按钮，并 @ 被问的人 | 父单活动 `decision_escalated` 与 `decision_card_queued`（`kind=decision_card`）；投递行 `decision.degraded` 为 NULL |
| 2 | 第二个人 | 点卡片上的提交 | 第二个人只看到 toast「本次没有提交：这条只能由卡片上点名的人回答。请转告对方在卡片上回答；如果你也是这张单的负责人，可以到网页端回答。」，卡片不变、问题仍在 | 不写任何活动；decision 仍为 `escalated` |
| 3 | 贺华杰（被问的人） | 在卡片里选一项或填自定义回答并提交 | 提示「已提交」，**同一张卡片原地**变成终态：答案、答者、时间，不新增消息 | decision 变 `answered`，压入一条 `history`；父单 `decision_answered`、来源单 `decision_received` 各一条；来源单负责人的排队任务被唤醒；投递走后一条 `decision_card_patch` |
| 4 | 发起人 | 另提一个 decision，然后在 Remi 工作台网页答掉 | 飞书那张卡片同样**原地**变终态（答案与答者取自网页那次回答） | 与第 3 步相同的一组活动；`decision_card_patch` 只有一条 |
| 5 | 发起人 | 再提一个 decision，然后撤回（`remi issue decision withdraw <parent> <decision>`） | 卡片**原地**变成「已撤回」，不出现「已超时」字样，也不再可点 | decision 变 `withdrawn`；同样一条 `decision_card_patch`；没有任何 timeout 状态写入 |
| 6 | 发起人 | 提一个 decision，确认卡片实际发出后再从该发出时刻计时 50 分钟，全程不答 | 话题里出现**一条 @ 被问的人**的文字提醒，且只出现一次；卡片仍是等待回答，不会超时 | 以成功投递行的 `sent_at + 50 分钟` 为到期点；decision 行 `reminder_sent_at` 写入一次；父单活动 `decision_card_reminder` 恰一条；再等不会出现第二条 |
| 7 | 发起人 | 删掉/改掉话题配置使该话题没有 seed（或在没有 seed 的新单上提 decision）；另将 `remi workspace issue-topics set --notify none` 后提一个 decision | 前者话题里**什么也不出现**；后者只出现**文字**（标题、正文、编号选项、父单网页链接），不出卡片、不 @ 任何人 | 前者 `decision_card_skipped`（`reason=no_topic`）；后者 `decision_card_degraded`（`reason=notify_none`）且投递行 `degraded=notify_none`；两者 decision 本身照常出现在网页与收件箱 |

第 7 步的两种降级必须分别做：`no_topic` 是**不发**（只在网页），`notify_none`
是**发文字**，两项都在 209 现场验。不可重试的发送失败降级为文字由自动化用例
验收，不在 209 上人工制造飞书发送失败。降级为文字的不会收到 50 分钟提醒，和
S5a 一致。跑这一步之前不要在 209 上改任何配置；
这是本单交付后由带头大哥安排的实测步骤。

已知产品口径：S4 兜底可能给多位 owner 发收件箱，但飞书卡只点名一个人。
其他 owner 在网页或收件箱回答，不在飞书卡上回答；这不是本期缺陷。

## Continuing Issue Work From a Topic

The bound-topic prompt teaches Remi to distinguish a progress question or an
automatic round report from an explicit user request to continue execution.
Questions and reports remain read-only. Quoted approvals are not fresh authority.

For an execution request, Remi refreshes the Issue, resolves its responsible
agent (the leader for a squad), and identifies the existing active Issue Session.
It lists that Session's tasks, excluding Chat/report tasks, before choosing:

- Amend existing work: `remi task steer <task> --content "<instruction>"`.
- Continue after completion or queue separate next-round work:
  `remi session task create <issue> <session> --agent <agent> --prompt "<request>"`.

The handoff includes the user's constraints and artifact references because the
Issue executor does not share the topic's Chat transcript. It must not silently
change the assignee, reset/create a Session, or perform the code work in the Chat
directory. Missing/ambiguous assignees or Sessions require clarification.

Remi reads back the created Task (and the directive ID for a steer) before saying
work was arranged. Its reply identifies the Issue, executing agent, Task ID, and
actual queued/running/terminal state. Ordinary Agent comments do not dispatch
work and cannot serve as a successful handoff. Permission failures are reported;
unknown write outcomes are reconciled by reading before any retry.

After handoff, Remi finishes its Chat turn. The existing responsible-agent round
completion path reports back to the same topic; no new polling or notification
channel is added. These are prompt instructions using existing CLI/API behavior,
not an automatic intent parser or a transactional exactly-once handoff service.
They apply to bootstrap and delta prompts after upgrading the bot-hosting daemon;
no database or historical Session migration is needed.
