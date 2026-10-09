# F01 deterministic ACP provider

This fixture qualifies **real daemon + test provider** consumption. It does not
qualify a real model. Untagged smoke prompts retain the original fixed response.

Send a unique `MUL-493/PROBE/<safe-id>` marker in a dedicated Chat or Issue request.
The fixture reads the current turn/attempt using the daemon-injected credential,
then executes canonical `remi message list <conversation> --from <seq> --to <seq>`.
It reads the persisted attempt again and requires an actual `input_read_seq`
covering the range with `input_read_offset=0`. A projection or successful CLI exit
without that receipt is an error. The final `PPE_PROBE_EVIDENCE` reply echoes the
marker, message ID/seq, body hash, read count, conversation, turn, attempt, runtime
and provider. QA must separately correlate it with daemon acceptance, terminal
turn/reply and queue disappearance in that same conversation.

Only dedicated markers, hashes and selected receipt/identity fields are stored.
Raw prompts, unrelated message text, credentials and CLI error output are omitted.
Evidence JSONL files have mode 0600; their directory defaults to
`/tmp/remi-ppe-acp-probes` and is configurable with `PPE_ACP_EVIDENCE_DIR`.
The `provider_input` event proves delivery to this process; `actual_read` records
the server receipt; `provider_complete` precedes the daemon terminal report and
does not itself establish terminal success. Repeated reads retain `read_count`.
`provider_cancelled` records the cancellation of an ACP prompt, not a failed
daemon turn. The final evidence includes actual reads across all ACP prompts in
the same attempt; a continuation starts at the last actual range read, while a
new attempt starts at its own projection. An inline input acknowledgement is
not substituted for an actual range read.

Set the test agent's `PPE_ACP_PAUSE` to any comma-separated subset of
`before-read,after-read,before-complete`. Each `paused` event advertises a unique
`control_file` and stage. Write that exact stage to the file to continue. Resuming
`after-read` or `before-complete` performs another real range read through the
current offered head, allowing QA to inject input, refresh the offer and observe
the new marker's receipt. Do not treat a fixed delay as a continuation signal.
The ACP test driver may alternatively call `ppe/resume` with `sessionId` and
`stage`; a wrong stage returns `resumed:false`. `session/cancel` cancels a pause
without publishing a successful reply. Unreleased pauses fail after 120 seconds;
`PPE_ACP_PAUSE_TIMEOUT_MS` can adjust that bound.

For queue editing, pause a blocker before reading, create the queued request,
edit/delete it through the normal UI/CLI, then resume the blocker and inspect the
next actual provider input. For running injection, pause after reading, inject a
new marker and wait for the offered head before resuming. The daemon may
soft-cancel that prompt and start a continuation in the same provider session.
Release each new `paused` event using its own advertised control file: the
cancelled prompt's file cannot release the continuation. Wait for its new
`actual_read` and `after-read` pause before releasing that file. Verify a single
read per marker across the attempt, the terminal reply and an empty agent queue;
a failed receipt blocks F01.

The fixture deliberately rejects overlapping `session/prompt` with
`ppe_session_busy`. Do not make it accept concurrent prompts to qualify F04.
[ACP cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)
finishes through the original prompt's response after pending operations and
updates drain. The daemon must await that response before its steering prompt.
The pinned [Codex ACP 2.1.1 implementation](https://github.com/agentclientprotocol/codex-acp/blob/v2.1.1/src/CodexAcpServer.ts)
likewise awaits the previous prompt's completion before starting an externally
triggered turn (`startNewTurnFromExternalPrompt`); cancellation waits for the
native `turn/completed` event. This fixture exercises that serial contract, not
the provider's separate steering extensions or a real model.

Local regression: `bun run test tests/integration/daemon-protocol-v2/running-chat-interrupts.test.ts`.

For the responsibility acceptance scenario, send `PR404/RESP/ASK` in the source
Issue request. The provider confirms an actual CLI range read, sends a real
`elicitation/create` JSON-RPC request, and keeps the original prompt open until
the daemon returns the human answer. It records the original Q ID by reading
that conversation and `remi message question get`; a later prompt in the same
product lane observes the saved answer without creating another Q.
The lookup uses the original provider message in `human_request.payload.message`
and the source turn/Agent identity. The daemon may repeat that text in the
rendered `body_md` when it combines the form message and question field; the
rendered body is not an exact provider-message identifier.

Add `PR404/RESP/PRESENTER` to the dedicated PPE Remi agent's instructions. A
presentation prompt must contain an actual `question_present_request`
notification in its authorized input range. The fixture reads the referenced
original Q, checks the notification's current route revision, and invokes
`remi message question present` under that attempt's task credential. It keeps
the original question and options intact. A stale notification cannot present
the current Q; inherited ASK text does not create another question. Presenter
prompts also ignore inherited SUBMIT markers: they only present the original Q
and leave formal delivery to the source execution.

`PR404/RESP/SUBMIT` invokes `remi issue delivery submit` for the current source
Issue/session with a stable attempt-specific dedupe key. It can accompany ASK
to submit only after the answer. The backend still enforces the actual
execution-owner permission. These branches never impersonate a human reviewer
or approve a delivery. `session/cancel` also releases a pending provider RPC
without a successful reply.

Responsibility evidence uses `PPE_RESPONSIBILITY_EVIDENCE` and a separate 0600
JSONL file containing receipt boundaries, Q/delivery IDs and actions; it omits
credentials and raw conversation text. This is a synthetic PPE provider
scenario. Correlate the Q and consumer turn with the real UI and daemon before
claiming product acceptance. Local coverage is
`bun run test tests/unit/scripts/ppe-fake-acp.test.ts`.

The PPE image runs the source CLI with Bun; the fixture detects
`/app/apps/remi/main.ts` and uses that same entry. Other environments use `remi`
on PATH. Local fixture tests may supply `PPE_ACP_REMI_BIN` and
`PPE_ACP_REMI_ENTRY` to execute this checkout's CLI with Bun.
