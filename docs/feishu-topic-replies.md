# Feishu Issue Topic Replies

When Issue topic synchronization is enabled, the configured group `chat_id`
accepts human messages without mentioning the bot, including new top-level
messages and replies inside topics. Existing topic replies continue their bound
Chat Session. Other groups still require a bot mention or a slash command.
Messages authored by bots and messages directed only at other people are ignored.
Sender identity and workspace permission checks in the Task API are unchanged.

The selected bot runtime receives the exact group policy on each heartbeat.
Changing `chat_id` removes the old group from this policy; disabling synchronization
removes it entirely. No process restart or bot credential change is necessary.
The existing CLI commands remain the configuration entry points:

```bash
remi workspace issue-topics get
remi workspace issue-topics set --enabled --chat-id oc_example
remi workspace issue-topics set --disabled
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

Durable delivery metadata only supplies the message identity for replay and
lease-owned lifetime; it does not select a different update transport.
The Feishu message ID is persisted before event consumption; retries replay into
that card, with the delivery UUID deduplicating initial sends. Delivery failures
remain retryable. Settled human requests are not reopened during replay.

The database schema is unchanged. Old v2/v3 daemons keep receiving final-body
deliveries only; upgrade both the API and the bot-hosting daemon for live cards
and the no-mention policy. Already-sent reports are not resent.

Issue-associated Chat tasks keep their Chat directory and provider session.
Only genuine Issue discussion tasks require an Issue Session lifecycle lock.
