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

One reader stays strict on purpose and is outside this change: the
inbound-message path (`submitMessage`). It is `origin/main` behavior, and a config
that reaches it has already been rejected at save time; the queue is where the
outage actually showed up.

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
