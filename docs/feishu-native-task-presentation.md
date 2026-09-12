# Feishu Task presentation

New inbound chats, Issue topic replies and proactive Task reports use
`FeishuTaskPresentation`. Agent execution, Chat Session identity, Task messages
and human responses remain on the existing Task pipeline.

| Stage | Transport | Visible content |
| --- | --- | --- |
| Process | `POST /open-apis/im/v1/message_cot`, then `PUT` on the same resource | Native process text, reasoning events exposed by the provider, tools and terminal state; no result footer or mentions |
| Human request | Independent interactive message | Approval or per-question checkbox rows and custom text; immediate mention of the requester (or resolved group recipient); no model subtitle |
| Human response | Existing Task human-response API, then card patch | Retained receipt with buttons and mention removed; web responses/expiry are reflected too |
| Result | Independent interactive message after terminal Task snapshot | Final answer, compact execution subtitle, then mention/duration/context/tools using the existing footer renderer |

Native creation returns both `cot_id` and `message_id`. Updates contain at most
50 events, each with a JSON-encoded `content` string and decimal millisecond
`timestamp`. Text chunks are limited to 4096 bytes, and consecutive chunks append
to the same native text message. The Task event mapper preserves explicit
`commentary`/`final` phases. For providers without phases, text before a subsequent
tool/thought is process commentary; the tail is held for the final result.
Subagent text never replaces the main Agent's answer. A direct answer without
process events sends only the result, without an empty process placeholder.

## Semantic process timeline

The display follows aiden-bot's native CoT protocol and timeline conventions
(reviewed at `8c4e7e49b6d1e403b918e2f5068aea330b87f0fb`), adapted to Remi's
canonical Task events rather than its SDK-specific event feed:

- Narrative uses segmented `REASONING_MESSAGE_*` events. A tool/plan separates
  the surrounding paragraphs into distinct groups, preserving chronological order.
  Only provider-exposed process text is consumed; no hidden reasoning is retrieved.
- Tool titles prefer the supplied description, with semantic read/search/write/
  skill/task/agent icons. ACP placeholders and subsequent argument updates share
  one invocation. Incomplete titles buffer for at most one second; a Task sequence
  is never acknowledged while its buffered invocation is still unsent.
- `TOOL_CALL_END` closes the invocation display, as in aiden-bot; it does not
  declare the underlying operation complete. Ordinary successful tool logs are
  omitted. The full transcript remains in the workbench. Failures show a short
  indication; todo/plan results use native `list` items with explicit status
  (pending / in progress / completed). Only completed items use the checked
  `task` icon; other items omit it and the plan heading uses a neutral `doc`
  icon. The checklist has no `plaintext`
  code panel or emoji checklist. Long plans show an explicit overflow count
  and refer to the complete plan in the workbench.
  Native result `content` is itself a JSON string containing the typed text/list object.
- Subagent invocations and available Codex activity/collaboration updates become
  named steps. Launch acknowledgments do not imply completion. Nested child prose
  stays in the workbench. Remi cannot show SDK-specific lifecycle events that the
  Task transcript does not contain; an unresolved background child is labeled as
  unresolved when the main turn ends, never fabricated as successful.
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

The existing outbound queue stores `presentation_checkpoint` and
`interaction_open_id`. The checkpoint contains the renderer version, native IDs,
acknowledged Task sequence, final message ID and request-to-card mapping. Updates
require the current runtime and unexpired claim token; acknowledged IDs and
receipt states cannot be discarded. Inbound event deduplication and queue
insertion commit together. Callback recovery reconstructs handlers from the
original Task request and saved card ID; operator/app/chat/message are checked,
and the canonical server compare-and-set accepts only the first human response.

Native CoT creation/append has no verified idempotency parameter. A durable
write intent precedes those requests. If a crash leaves an ambiguous write, the
delivery retains the known IDs and stops replaying the process, while the final
result is still delivered. Result and interaction creation use stable message
UUIDs scoped to delivery, Task and request. Explicit transient API failures are
retried at most three times per operation; ambiguous native writes are not
replayed. The outbox stops known permanent refusals immediately and other
delivery failures after six claims. A CoT rejection cannot block the result.

Deploy the server migration before a protocol-v5 daemon. A v4 daemon cannot
claim a native checkpoint. Already-sent v4 cards continue on their legacy patch
path; new deliveries use native CoT. Task/Agent/Session/workspace data does not
need migration. Rollback daemons leave native deliveries queued for a capable
daemon instead of rendering a second ordinary process card. The API extensions
are internal daemon protocol fields on existing CLI-exempt routes; no new user
API or command is introduced.

The semantic timeline adds optional renderer/waiting markers to that existing
checkpoint JSON; it requires no SQL or Task/Session migration. If a daemon upgrade
finds an active process created by the earlier native renderer, it closes that
display with `reason=timeout` and preserves the request/result lanes. This avoids
appending incompatible text IDs to the old message. New deliveries use the
semantic timeline; existing finished messages are not rewritten.

## Verification

Unit tests cover native POST/PUT payloads and topic origin, direct answers,
text/final isolation, context and timing, restart checkpoints, result UUIDs,
approval callbacks, multiple questions/custom answers, identity checks, web
completion, expiration, lease ownership, protocol compatibility and bounded
delivery retries.

`tests/manual/feishu-native-task-replay.ts` replays a terminal Task fixture through
the production presenter with the selected `lark-cli` bot identity. It requires
explicit `--send`, `--fixture`, `--app-id` and `--chat-id`; use a private test chat
and mark the fixture text as historical replay. Keep real transcripts and
credentials outside git. It does not start an Agent or execute recorded tools.

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
