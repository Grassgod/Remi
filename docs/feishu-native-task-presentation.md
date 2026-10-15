# Feishu Task presentation

New inbound chats, Issue topic replies and proactive Task reports use
`FeishuTaskPresentation`. Agent execution, Chat Session identity, trace events
and human responses remain on the existing Task pipeline.

The co-resident connector consumes `daemon.subscribeTrace(taskId, fromSeq,
onEvents)`: the turn + items trace (`multiremi.trace.v2`, typed in the
[trace contract](../packages/contracts/src/trace.ts)), folded by the shared
reducer in
[`turn-trace`](../packages/shared/src/turn-trace.ts), the same fold the daemon,
the web and the CLI use. A new or recovered presentation replays canonical
history from zero to reconstruct answer text, tool identity and statistics. Its
saved `presentation_checkpoint.throughSeq` suppresses native events already
acknowledged; it is not used to skip the state needed to reconstruct the final
answer. Replay also resumes a saved interaction card whose receipt or waiting
step is unfinished, without repeating its card or waiting announcement.
An acknowledged receipt with no unfinished waiting step is not read or sent
again during historical replay.
Replay is consumed in bounded pages with consumer backpressure.
The established subscription still owns cursor-based reconnect replay and gap
filling. The connector performs no messages or status polling, and reads a final
display snapshot once after `closed`.
`FeishuCotTimeline` accepts canonical `TraceEvent`s. The subscription itself is
opaque, so a v1 trace still delivers its legacy fragment lines; the timeline,
like the shared reducer, skips those and any unknown event type, and only its
cursor advances. Every native sample is a pure function of the event prefix and
every native ID derives from an item ID, so a replay from seq 0 regenerates
exactly what a checkpoint acknowledged. A tool row is written once, from the
item's `item.completed`, when its command, actions or changes are final; nothing
waits for late arguments, so the checkpoint no longer carries `deferredToolIds`
(a value an earlier renderer saved is dropped on resume). Every presentation
replays from seq 0, so nothing is inferred about events before its checkpoint.
An unpinned provider session remains unnamed until the final snapshot arrives.

The independent `result_card` lane reads canonical trace from seq 0 on the host
to build its footer with `FeishuTaskMetadata`, shared with the bundled renderer.
The agent name, engine and model come from `turn.started` / `turn.updated` /
`turn.completed`, the context from the turn's `context_usage`, and the tool count
from `turn.stats.tool_call_count` (tool items at any depth, counted once each);
until `turn.completed` arrives, unique tool item IDs stand in for it. Subagent
usage and model reports never reach the turn, and billing token totals are not
context occupancy. The host read stops at `turn.completed`; a v1 trace, which has
none, ends at its terminal snapshot. The card's duration is the queued body's
Task time, else the turn's duration. A host command reply (`/new`, `/stop`, …) is
a synthetic one-item turn whose provider names no engine. The server queues the
durable terminal answer without reading the legacy Task-message table. The
optional metadata read is bounded to five seconds, so an offline trace cannot
prevent the final answer from being sent. This metadata subscription is separate
from native CoT and does not re-send its process events.

Human-request updates for the separate interaction lane still use the existing
750 ms read loop. E5's `subscribeHumanRequests` is API-process local (MUL-436),
and the daemon's declared `task.human_request.settled` frame currently has no
producer or receiver. Removing that loop requires the existing event transport
to be wired into the connector process; this change adds no protocol or contract.

Every presenter (bundled interaction card, split CoT waiting step and replay
resume) identifies a request by the `message_id` of its `permission` /
`question` item: the decision message returned by `turn.decision`.
`getHumanRequest`, card preparation and answers are keyed by that ID and the
checkpoint's `interactions` map uses it too; the item's own ID (`perm:…` /
`q:…`) is never a request key. A request item is presented once, on the first of
its events this presentation sees, and an item without `message_id` is not
presented.

| Stage | Transport | Visible content |
| --- | --- | --- |
| Process | `POST /open-apis/im/v1/message_cot`, then `PUT` on the same resource | Native process text, reasoning events exposed by the provider, tools and terminal state; no result footer or mentions |
| Human request | Independent interactive message | Approval or per-question checkbox rows and custom text; immediate mention of the requester (or resolved group recipient); no model subtitle |
| Human response | Existing Task human-response API, then card patch | Retained receipt with buttons and mention removed; web responses/expiry are reflected too |
| Result | Independent interactive message after terminal Task snapshot | Final answer, compact execution subtitle, then mention/duration/context/tools using the existing footer renderer |

Native creation returns both `cot_id` and `message_id`. Updates contain at most
50 events, each with a JSON-encoded `content` string and decimal millisecond
`timestamp`. Text chunks are limited to 4096 bytes; one text item is one native
text message. The result card's answer is the turn's final item: the
`agent_message` named by `turn.final_item_id`, else the last top-level one with
`phase: "final"`, which the daemon's final-reply rule sets for every provider.
The terminal snapshot's result is only the fallback when the trace has none.
Subagent text (`parent_id` set) never replaces the main Agent's answer. A direct
answer without process events sends only the result, without an empty process
placeholder.

Ordinary private-chat turns send both native process messages and result cards
to the main chat, without a reply target. When `replyToMessageId` is present
(group/Issue topics or explicit private threads), native CoT creation includes
both `origin_message_id` and `reply_in_thread: true`, keeping the process in the
same reply thread as result and interaction cards. `origin_message_id` alone
associates the source message but does not place CoT in its thread (MUL-311).
Without a reply target, both fields are omitted, preserving ordinary private-chat
behavior.
A private result must not
rebind its Chat Session to the result message; only a standalone Issue topic seed
establishes a new topic root.

The incoming message's `THINKING` receipt remains through queue handoff, execution
and result delivery, including plain answers without process events. The existing
persistent receipt mechanism removes it on success, without adding `DONE`, after
the final card is acknowledged. Failure or cancellation still replaces it with
`CROSSMARK`. A delivery resumed from an acknowledged result checkpoint does not
add `THINKING` again; receipt cleanup can retry without resending the result.
When delivery fails before a result is acknowledged, `CROSSMARK` is best effort:
a refused reaction is only logged, and the original error is reported as the
delivery's `last_error` and decides whether the outbox retries (MUL-365).
Native CoT contains actual
provider process events; a silent wait is represented by the receipt.

## Semantic process timeline

The display follows aiden-bot's native CoT protocol and timeline conventions
(reviewed at `8c4e7e49b6d1e403b918e2f5068aea330b87f0fb`), adapted to Remi's
turn + items trace rather than its SDK-specific event feed. Step text is the
shared Codex-style copy in
[`trace-step-copy`](../packages/shared/src/trace-step-copy.ts) (`describeStep`,
zh table `STEP_COPY_ZH`), so Feishu and the web Chat read alike; the card layout
is unchanged:

- Narrative uses segmented `REASONING_MESSAGE_*` events: each `reasoning` item
  and each commentary `agent_message` is one paragraph, written when the item
  completes, in trace order. Only provider-exposed process text is consumed; no
  hidden reasoning is retrieved. A top-level agent message that may still be the
  answer (`final` or `unknown` phase) is held, following the shared final-reply
  rule (`selectFinalReply`): it becomes process text when a later message would
  replace it (any later message for an `unknown` one, only a later `final` for a
  `final` one), when a tool item or a question follows an `unknown` one (the
  rule's blockers; Claude's AskUserQuestion raises a question without a tool),
  or when a steer starts a new round. Reasoning, plan, compaction and notice
  steps, and tools after a `final` one, wait behind the held message and are
  written after it once it is process text, or without it when the turn ends
  and it is the final item.
  Known limitation: when a turn ends on a tool after its last text ("text →
  tool → end"), the rule still promotes that text to the answer (decision
  D-final), but the tool already made it process text, so it shows both in the
  CoT and in the result card.
- Tool rows come from `item.completed`: one per command action (the daemon
  parses each shell command once with
  [`command-parse`](../packages/shared/src/command-parse.ts)), one per changed
  file, otherwise one per item. Titles are the done-state copy, such as
  "已读取 app.ts", "已在 src 中搜索“foo”" or "已运行 bun test"; a native title
  cannot be rewritten, which is why rows wait for the finished item. Icons follow
  the action: read, search (searches and listings), bash (any other command),
  write (file changes), search (web), doc/find-app/default for other tools.
  `TOOL_CALL_ARGS` carries `$ <command>`, else the path, query or URL. A compound
  or unparsable script stays one `unknown` action, so a trailing filter such as
  `grep -v INFO` cannot turn an unrelated command into a search. A command the
  model labelled (`command.title`, Claude's Bash description) is one row titled
  with that label ("已停止 <label>" once stopped), its command still in the args,
  as in Chat.
- `TOOL_CALL_END` closes the invocation display, as in aiden-bot. Ordinary tool
  output is omitted; the full transcript remains in the workbench. A row whose
  copy cannot carry the outcome gets a short result: "执行失败" for a failed
  command, "已停止" or "已拒绝" where the copy still reads done; a later
  `item.completed` that changes the status (a refused approval re-closes its
  tool) adds that result to the written row instead of a second start. The plan
  item is redrawn from every snapshot whose entries changed, as native `list`
  items with explicit status (pending / in progress / completed). Only completed
  items use the checked `task` icon; other items omit it and the plan heading
  uses a neutral `doc` icon. The checklist has no `plaintext` code panel or emoji
  checklist. Long plans show an explicit overflow count and refer to the complete
  plan in the workbench. Closing the turn re-completes the plan unchanged, which
  draws nothing.
  Native result `content` is itself a JSON string containing the typed text/list object.
- A `subagent` item is a named step from its start ("正在运行子代理：…") to its
  end ("子代理已完成：…", "子代理已停止：…", "子代理执行失败：…"). Claude's first
  Agent frame carries only the "Task" placeholder, so the row and step open on
  the first event with a real title or prompt, else on the first child item or
  at completion. Its child items stay in the workbench. A background subagent
  (`background: true`) is named "后台运行中：…" while it runs. The daemon keeps
  an async launch in progress past the launch acknowledgment and completes it
  when the turn closes (ADR 0019 decision 10), so its completion is the child's
  real end; a subagent step still open when the presentation finishes is
  labeled as unresolved, never fabricated as successful. A `compaction` item is a step from "正在压缩上下文" to its outcome
  (one reported only once finished still opens it), and a `notice` item a step
  named by its title.
- Questions and approvals keep the existing cards and callbacks. The same native
  process gets a waiting step, then a matching finish step when the original
  request is answered, expires or is cancelled. Neither process text nor running
  steps contain a mention, model subtitle, duration or context footer.
- Success sends `RUN_FINISHED(done)`; cancellation sends `RUN_FINISHED(interrupted)`.
  Failure sends `RUN_ERROR`, then explicitly closes the process with
  `POST /open-apis/im/v1/message_cot/complete/{cot_id}` (`message_id`, `reason=error`).
  A completion failure cannot prevent delivery of the independent result card.

Writes remain serialized, with at most 50 events per request and at least 65ms
between batches. Payload limits account for UTF-8 and both JSON escaping layers.
The existing permanent-refusal and ambiguous-write policies still apply.

Official references:
[message_cot API](https://open.larkoffice.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message_cot/create)
and [SDK model](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/lark_oapi/api/im/v1/model/message_cot.py),
the request shape was confirmed with bot-authenticated POST/PUT requests. Native CoT does not
replace interactive question/approval forms; those use `card.action.trigger`.

## Recovery and rollout

MUL-440 splits newly claimed Tasks into server-written `cot`,
`interaction_card`, `result_card`, and `receipt` deliveries. Each row has its
own claim token, lease, backoff and six-attempt budget. `previous_delivery_id`
orders rows; failure propagates only through `cascade_failure=1` edges. The
result waits for its CoT delivery to finish or fail, without inheriting failure.
Receipts never serve as predecessors. Final receipt failure records an audit
and log; it changes neither the result nor the binding. The split CoT renderer
keeps native waiting steps while independent interaction handlers own the forms.

A daemon declares `feishu_outbound_kinds: 1` on its claiming heartbeat and
receives `pending_feishu_outbounds`. Undeclared daemons retain the original
singular response and bundled Task handler. The first successful carrier lease
pins a Task to legacy or split for its entire delivery, including retries and
handover; previously attempted rows stay legacy. See
[schema, compatibility and rollback](feishu-outbound-kind-migration.md).

The outbound queue stores `presentation_checkpoint` and
`interaction_open_id`. The checkpoint contains the renderer version, native IDs,
acknowledged Task sequence, and (for legacy Tasks) final message ID and
request-to-card mapping. Split result/interaction rows persist their own message
IDs rather than changing the legacy checkpoint fields. Updates
require the current runtime and unexpired claim token; acknowledged IDs and
receipt states cannot be discarded. Inbound event deduplication and queue
insertion commit together. Callback recovery reconstructs handlers from the
original Task request and saved card ID; operator/app/chat/message are checked,
and the canonical server compare-and-set accepts only the first human response.

The bot host daemon may differ from the daemon executing the Task. For Tasks of
Chats bound to the enabled bot, it may read Task status, messages and a single
human request, and submit a response. Creating or expiring a human request and
every execution mutation stay with the executing daemon (MUL-321, MUL-365).
An Issue task has no Chat session, so a second predicate covers it (MUL-407):
when the Task's Issue has a live topic binding on the bot's chat, the host may
read that request and submit a response. The same two verbs are the whole grant —
creating and expiring an Issue human request still belong to the executing daemon.

Native CoT creation/append has no verified idempotency parameter. A durable
write intent precedes those requests. If a crash leaves an ambiguous write, the
delivery retains the known IDs and stops replaying the process, while the final
result is still delivered. Result and interaction creation use stable message
UUIDs scoped to delivery, Task and request. Explicit transient API failures are
retried at most three times per operation; ambiguous native writes are not
replayed. The outbox stops known permanent refusals immediately and other
delivery failures after six claims. A CoT rejection cannot block the result.

Deploy the server migration before a protocol-v5 daemon. A v4 daemon cannot
claim a native checkpoint. The v4 streaming-card renderer is gone: a delivery
that still holds the message ID of an already-sent v4 card but no presentation
checkpoint finishes through `FeishuTaskPresentation` with the result card only.
No native process is opened for it, and its first checkpoint records the CoT as
disabled (`legacy_card_final_only`), so a retry stays final-only. After the
result is sent, the old card is patched once to a closed state ("执行过程已结束，
结果见下一条消息。") so its progress spinner does not stay; the marker becomes
`legacy_card_closed`, and a refused patch is only logged. Check the outbox for
such rows before deploying.
Task/Agent/Session/workspace data does not need migration. Rollback daemons
leave native deliveries queued for a capable daemon instead of rendering a
second ordinary process card. The API extensions are internal daemon protocol
fields on existing CLI-exempt routes; no new user API or command is introduced.

The renderer tag and waiting markers are optional fields of that existing
checkpoint JSON; they require no SQL or Task/Session migration. The turn + items
renderer tags its native process `cot.presentation: "items_v1"`. If a daemon
upgrade finds an active process with any other tag (the fragment-event
`semantic_v1`, or none), it closes that display once with `reason=timeout`
(`legacy_cot_closed_on_upgrade`) and preserves the request/result lanes. This
avoids appending incompatible native IDs to the old message. New deliveries use
the current renderer; existing finished messages are not rewritten.

## Verification

The live Feishu runs recorded below predate the turn + items trace: they
exercised the fragment-event renderer it replaced. The item-based presenter is
covered by the unit and local integration tests only; no live run of it has been
made yet.

`tests/manual/feishu-cot-thread-probe.ts` checks MUL-311 in an explicitly selected
ordinary test group. Inject `FEISHU_APP_ID` and `FEISHU_APP_SECRET` securely into
the process environment; optionally set `FEISHU_DOMAIN` to `feishu`, `lark` or
`bytedance`. Run:

```bash
bun tests/manual/feishu-cot-thread-probe.ts --send --chat-id oc_TEST_GROUP
```

`FEISHU_TEST_CHAT_ID` can replace `--chat-id`. The probe requires `chat_mode=group`
and `group_message_type=chat` (topic mode or missing metadata blocks sending),
sends a labeled ordinary message A, then creates two native CoTs with A as
`origin_message_id`: one omits `reply_in_thread`, the other sets it to `true`.
It prints each request's API code/message and reads back `thread_id`, `root_id`
and `parent_id` for both CoTs and A. It completes its own CoTs and retains their
messages for client inspection. Writes are never retried; an ambiguous response
requires inspection before another run. No production configuration is changed.
A zero API code alone does not establish that the parameter was honored; a
rejection alone does not establish lack of support (check auth/scopes first).

On 2026-09-17, the probe ran in an authorized ordinary test group
(`chat_mode=group`, `group_message_type=chat`). With the same origin message A,
both creates returned code 0:

- Without `reply_in_thread`, the CoT readback had no `thread_id`, even though
  `root_id` and `parent_id` pointed to A.
- With `reply_in_thread: true`, the CoT and A both read back the same new
  `thread_id`. The field changed thread placement; it was neither rejected nor
  silently ignored.

Concrete chat, message and thread IDs are deliberately omitted here: this
repository is public, and those identifiers point at a private group. The raw
probe output lives in the MUL-311 issue thread.

This selects native threading (branch A) for MUL-311. Evidence was reported in
issue comments `cmt_lyh5qp2j3p27` and `cmt_i7qx9edic2ey`; client visual acceptance
is separate from API readback. The earlier missing-credentials report was a
configuration-loading gap: `@shared/config.js` reads environment variables,
not the legacy local `~/.remi/remi.toml` `[feishu]` credentials. If using that
local file for a manual run, parse it and pass credentials only through the
child process environment; never print secrets or commit credential files.

Thread routing is applied only at native creation. Resuming a checkpoint with
acknowledged native IDs reuses that process, without recreating or relocating
it; ambiguous-write and legacy-renderer recovery policies remain unchanged.

The updated `FeishuTaskPresentation` was then exercised in the same group on
2026-09-17 against `https://open.feishu.cn`. A synthetic commentary/final Task
stream plus terminal snapshot went through the real presenter, native transport,
SDK and result sender, with checkpoint saving and the origin's receipt enabled.
This was a code-path regression, not another direct `message_cot` parameter probe.

The origin message, the native CoT and the result card all read back one and the
same `thread_id`; both replies also had the origin as `root_id` and `parent_id`. The presenter
sent one native create with `origin_message_id` and `reply_in_thread: true`,
three native writes ending in `RUN_FINISHED`, and one result reply. All calls
returned code 0; its checkpoint reached `cot.status=finished`. `THINKING` was
added and removed after the result. Replaying the same stream with that terminal
checkpoint reused the result ID and issued zero writes. The test retained the
three messages for inspection. It did not exercise inbound @ handling, an actual
Agent execution, or client UI rendering; those remain for end-to-end/QA acceptance.

Unit tests cover native POST/PUT payloads and topic origin, direct answers,
text/final isolation and the final-reply rule across steer rounds, rows built
from item fixtures (actions, file changes, statuses), plan/subagent/compaction
steps, context and timing from turn events, restart checkpoints, result UUIDs,
approval callbacks keyed by `message_id`, multiple questions/custom answers,
identity checks, web completion, expiration, lease ownership, the final-only
legacy delivery, protocol compatibility and bounded delivery retries.

`tests/manual/feishu-native-task-replay.ts` replays a terminal Task fixture through
the production presenter with the selected `lark-cli` bot identity. The fixture
holds the terminal snapshot and the Task's stored v2 trace lines
(`{ snapshot, events }`). It requires explicit `--send`, `--fixture`, `--app-id`
and `--chat-id`; use a private test chat and mark the fixture text as historical
replay. Keep real transcripts and credentials outside git. It does not start an
Agent or execute recorded tools.

On 2026-09-12, a completed production Task containing 25 events and three tools
was replayed to the existing private test chat: native creation, seven native
writes (including completion), and one independent result all returned code 0.
This verifies transport delivery; human client presentation/interaction acceptance
is separate from the automated assertions.

`tests/manual/feishu-cot-experience.ts` provides a complete opt-in private-chat
demonstration through the same production presenter: narration, categorized
tools, plan updates, a child task, multiple questions with custom answers,
approval, result, and separate failure/cancellation scenarios. It verifies the
selected bot and P2P recipient first and starts a bounded callback consumer before
the cards. Demo requests expire after 60 seconds without automatic answers or
approval. All simulated data is labeled; no actual Agent, tool or Task is started.
Only callbacks belonging to this run's cards are handled. The original result
and interaction card renderers are reused without layout changes.
When another event connection already owns the production bot, explicit
`--replay-responses` avoids starting a competing consumer. It labels the cards
and replays synthetic callback payloads through the same handler after ten
seconds. These are simulated decisions, not live user callbacks or real
authorizations; successful sending does not prove production callback delivery.

The semantic-timeline live replay on 2026-09-12 delivered three native processes,
three results and two interaction cards to the existing Remi private chat. All
21 native writes, both receipt patches and the error `complete` call returned
code 0; all eight messages were read back with Remi as sender. The normal/error
native summaries read back as `Completed`/`Task failed`; the cancelled native
message's generic readback summary is also `Completed`, although it was sent
`status=interrupted` and its result card says cancelled. Client visual acceptance
of that interrupted state remains separate from transport acceptance. Question
and approval callbacks used the explicitly labeled synthetic mode because the
production app already had an event connection; no competing listener was started.
