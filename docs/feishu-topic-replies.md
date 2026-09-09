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
