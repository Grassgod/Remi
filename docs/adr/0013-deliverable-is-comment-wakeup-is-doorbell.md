# ADR 0013: Deliverables are comments; wakeups are doorbells

## Status

Amended by [ADR 0015](0015-unified-message-inbox-and-turn.md) (MUL-493): the `agent_read_state` read progress moves into the session lane cursor.

Accepted for MUL-498. The latest user decision replaces inbox directories and
inline unread history with triggering messages and one complete unread-range
read. Text is truncated before dispatch. The latest review permits one exception:
an irreducible structure still exceeding the protocol hard limit fails once with
`offer_too_large`, reports byte sizes, and never blocks its Issue or runtime queue.
One nullable column stores actual read progress separately from provider checkpoints.

## Context

The daemon concatenated a turn's process output into its result. Delegation
reports copied that result into wakeup envelopes, which then entered another
task's prompt. A 120,898-character report, Wiki bodies and session history could
exceed the protocol's 1 MiB frame limit before an agent received any work.

Comments and trace already store the deliverable and execution history. Copying
them across successive wakeups creates growing packets and hides the source
of the result. Fleet versions differ, so server-side packet shaping must protect
existing daemon versions as well as the updated worker.

## Decision

- The worker retains the last top-level assistant message as task output.
  Top-level tools, compaction and steer delimit segments. Chunk order and final
  phase are preserved; nested agent messages never enter the result or fallback.
  Trace retention stays independent of result selection.
- A delegation terminal report contains identity, status, a conclusion-comment
  pointer and a bounded summary. Automatic replies use a reserved id and commit
  with the terminal transition. Only a successfully written comment is referenced.
  The terminal path calls the transaction-internal comment writer without opening
  another transaction frame (ADR 0011). On a comment write failure, the owning
  terminal transaction rolls back completely and retries once without an automatic
  reply; no partial comment or notification survives. Task output stays available
  through the task CLI. Dispatch and notifications follow the successful COMMIT.
- The unified envelope writer clamps every envelope to 4 KiB. Terminal reports
  target less than 2 KiB and keep the English first line, `Status:` line and
  envelope metadata used by the parallel MUL-501 frontend. Cross-issue reports
  keep one short `来源：<Issue key>` line; they do not copy the result body.
- Task session input contains all triggering messages, one unread range and one
  command. It excludes other unread bodies, titles, summaries and own history.
  Trigger messages normally have an 8,000-character allowance and carry explicit
  omitted counts and an expansion command when folded. Cold starts read from 0.
- The existing session-log get command and endpoint accept a range. The CLI reads
  all pages and rejoins long entries. Task-token reads emit structured diagnostics
  without contents or credentials; reading is encouraged, never enforced.
  Each agent's full-entry high-water and partial-entry offset are persisted in
  the session head's nullable `agent_read_state` JSON column, shared by Issue and
  Chat sessions. Existing participants/lanes have no suitable JSON field; the
  head's existing counter serializes updates without changing provider identity.
  Completion advances only the provider checkpoint. Actual high-water advances
  on contiguous range pages or accepted, fully inline contiguous triggers.
  On first access, initialize and persist each agent's state from its legacy
  Issue lane cursor or completed Chat projection checkpoint. Legacy projections
  were inline; agents without an old checkpoint start at 0. Persist even 0 so
  later provider completion cannot be mistaken for an initial checkpoint.
  A fresh provider bootstrap (including stale-session recovery) always offers
  a range from 0, since the new provider has no earlier memory. Accepting that
  offer resets the actual high-water before acknowledging contiguous inline
  triggers; preparing or rejecting the offer does not reset it. The next delta
  follows reads performed in this new provider session.
  Inline acknowledgement reads at most 100 metadata rows without loading bodies;
  range gap checks use an existence query rather than materializing the history.
  Folded triggers, rejected offers and out-of-order reads do not acknowledge gaps.
  Read logs include actual returned seqs, start/end offsets and persisted progress;
  `complete` means the final page, not proof that all preceding pages were read.
- The `wiki.fetch` hello capability separates Wiki downloads from task offers.
  Its server path lists metadata without reading SQL or OpenViking bodies or
  calculating body hashes. Version is required; a body SHA is optional.
  Updated daemons use existing task-authorized HTTP read endpoints and verified
  baseline caches. Unchanged pages reuse their body; failed reads retain the last
  successful version and warn. Wiki failures produce at most one aggregate line
  in the prompt, without per-page diagnostics or a successful-fetch warning.
  Old daemons retain complete bodies while the offer fits its soft budget;
  only enough pages are omitted to meet that budget. Omitted repository pages
  retain unavailable markers so existing local copies are preserved.
  A not-yet-created workspace has no baseline cache. Fetching does not create
  that directory; workspace preparation still owns creation and path validation.
- Offers are measured and reduced at the server send boundary against a 512 KiB
  soft budget. Knowledge bodies go first, followed by trigger allowances, long
  descriptions and large optional context. If necessary, remaining text fields
  are truncated largest first with omitted-character counts and source read
  commands. JSONL remains parseable. Credentials, task/agent/Issue identifiers,
  Project resource execution bindings, Runtime workspace, frozen plugins/model
  connection profiles and provider resume identity remain intact for normal payloads. A final string pass may truncate
  pathological URLs/paths exceeding 8,000 characters. If structure alone still
  exceeds the encoder's 1 MiB hard limit, fail once with `offer_too_large` and
  per-part byte diagnostics. The failure reaches the delegator's bounded bell,
  leaves Issue status unchanged and continues the runtime queue. Neither size
  path waits for transport capacity, repeatedly requeues or enters cooldown.

No public route, command path or existing wire field is renamed. Additive range
flags, a hello capability and metadata use existing compatibility patterns.

## Alternatives Considered

- Keep concatenated results and truncate only envelopes: fixes one packet but
  still produces incorrect automatic replies and copies process notes as output.
- Put every unread message or its summary in the prompt: consumes packet budget
  and conflicts with the explicit unread-range contract. The agent reads the
  complete range when it needs context.
- Shape packets only in the daemon: cannot protect older daemons because their
  offer already fails before delivery.
- Put Wiki bodies in a second WebSocket frame or add a download API: unnecessary
  protocol/API surface; authenticated Wiki read endpoints already exist.
- Fail text-heavy offers or repeatedly queue oversized offers: truncate text
  first; only irreducible structural overflow is allowed to fail. Requeueing
  the same unshrinkable payload can indefinitely starve that runtime's queue.

## Consequences and Rollback

Agents spend an extra CLI read on unread context. Updated CLI flags are required
for range reads; deployment and daemon/CLI upgrade remain separate operations.
Large optional tool context may be omitted with a warning. Metadata-only Wiki
hydration avoids server body downloads for capable daemons. Legacy daemons
still hydrate bodies within the existing cap and update pages that fit; their
per-page unavailable-warning renderer remains a transitional limitation until
they upgrade. Updated daemons aggregate Project and Repository Wiki failures.

Local verification covers deterministic result boundaries, terminal comment
references, offers, range pagination/permissions and Wiki caching/failure.
Release build check has been disabled. Acceptance uses related-module local
tests with recorded commands/results, QA approval and no unresolved blocking
findings; skipped PostgreSQL cases are not counted as passing. PPE testing with
current and isolated 0.2.85 daemons remains a separate pre-merge gate.
Revert the implementation commits to roll back;
the nullable `agent_read_state` column may remain, as older images ignore it.
Provider checkpoint columns are unchanged. Missing per-agent state is initialized
once from the legacy inline projection checkpoint; genuinely new agents start
at 0. Saved read state is not reset or reseeded when provider checkpoints advance.
The migration leaves existing data intact; initialization is lazy on first access.

## Implementation

- `packages/server/src/worker/last-assistant-message.ts`
- `packages/server/src/store/envelope-body.ts`
- `packages/server/src/store/repos/tasks-repo.ts`
- `packages/server/src/store/task-session-input.ts`
- `packages/server/src/api/daemon-protocol/offer-budget.ts`
- `packages/server/src/api/session-log-range.ts`
- `packages/daemon/src/agent-runtime/workspace/wiki-fetch.ts`
- [Protocol details](../daemon-protocol-v2.md)
