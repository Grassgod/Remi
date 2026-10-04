# ADR 0013: Deliverables are comments; wakeups are doorbells

## Status

Accepted for MUL-498. The latest user decision replaces inbox directories and
inline unread history with triggering messages and one complete unread-range
read. It also supersedes the earlier `offer_too_large` failure fallback: payload
size must not fail a task or block its Issue. No schema migration is required.

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
  A failed write leaves task output available through the task CLI.
- The unified envelope writer clamps every envelope to 4 KiB. Terminal reports
  target less than 2 KiB and keep the English first line, `Status:` line, child
  Issue prefixes and envelope metadata used by the parallel MUL-501 frontend.
- Task session input contains all triggering messages, one unread range and one
  command. It excludes other unread bodies, titles, summaries and own history.
  Trigger messages normally have an 8,000-character allowance and carry explicit
  omitted counts and an expansion command when folded. Cold starts read from 0.
- The existing session-log get command and endpoint accept a range. The CLI reads
  all pages and rejoins long entries. Task-token reads emit structured diagnostics
  without contents or credentials; reading is encouraged, never enforced.
- The `wiki.fetch` hello capability separates Wiki downloads from task offers.
  Updated daemons use existing task-authorized HTTP read endpoints and verified
  baseline caches. Unchanged pages reuse their body; failed reads retain the last
  successful version and warn. Old daemons receive unavailable markers and read
  hints rather than large bodies.
- Offers are measured and reduced at the server send boundary against a 512 KiB
  soft budget. Knowledge bodies go first, followed by trigger allowances, long
  descriptions and large optional context. A still-oversized transport frame
  remains queued with cooldown and a per-field size diagnostic. Neither task
  failure nor an Issue blocked transition follows from its size.

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
- Fail irreducibly large offers: rejected by the latest user instruction. Retaining
  queued work keeps the Issue recoverable, although an oversized mandatory field
  may need intervention at its source.

## Consequences and Rollback

Agents spend an extra CLI read on unread context. Updated CLI flags are required
for range reads; deployment and daemon/CLI upgrade remain separate operations.
Large optional tool context may be omitted with a warning. Server hydration still
loads Wiki bodies before producing metadata, so this change bounds the dispatch
packet rather than eliminating server-side knowledge-read cost.

Local verification covers deterministic result boundaries, terminal comment
references, offers, range pagination/permissions and Wiki caching/failure.
PPE testing with current and isolated 0.2.85 daemons and final-head CI remain
separate acceptance gates. Revert the implementation commits to roll back;
there are no database migrations or data rewrites to undo.

## Implementation

- `packages/server/src/worker/last-assistant-message.ts`
- `packages/server/src/store/envelope-body.ts`
- `packages/server/src/store/repos/tasks-repo.ts`
- `packages/server/src/store/task-session-input.ts`
- `packages/server/src/api/daemon-protocol/offer-budget.ts`
- `packages/server/src/api/session-log-range.ts`
- `packages/daemon/src/agent-runtime/workspace/wiki-fetch.ts`
- [Protocol details](../daemon-protocol-v2.md)
