# ADR 0012: Unified inbox on the conversation log, one pending turn per lane, wakes commit with state

- Status: accepted (MUL-404, 2026-09-28; supersedes the per-path coalescing in ADR 0005 decisions 3–6 and amends ADR 0003 decision 8)
- Deciders: 贺华杰 (scope), Senior大哥 (design), 带头大哥 (split)

## Context

Three wake paths grew independently: delegation returns
(`drainDelegationReturnsWithinWorkspaceLock`), child terminal notifications
(MUL-400 E2), and comment mentions. Each has its own "find the queued task"
predicate, its own prompt-append coalescing, and its own lock coverage; the
predicates disagree (delegation ignores `continued_from_task_id`, E2 ignores
`projection_to_seq` and execution scope), and nothing in the database prevents
two queued rounds for the same agent on the same session. E2, the E3
notifications, and E4 run their wake in a post-commit hook that opens a second
transaction, so a process exit between the two commits loses the wake (ADR 0004
§5 "known crash window"). Agents wake to a JSONL projection with no table of
contents, no priority, and bodies cut at 4,000 characters.

MUL-402 B1 made `multiremi_conversation_log` the single per-session log, with
`multiremi_session_agent_lanes.cursor_seq` as each agent's read position
(ADR 0006). MUL-427 moved the wake readers onto that log. MUL-452 replays E3
automatic starts from `multiremi_system_events` and explicitly leaves the
notification wakes to this decision.

## Decision

1. **The inbox is the recipient's conversation log read from its lane cursor.**
   There is no inbox table. Every cross-agent message is an entry in the
   recipient's session log carrying `metadata.envelope` (`kind`, `wake`,
   `dedupe_key`, `reply_to`, `grant_ref`, `priority`, `source`). On Issue
   sessions the entry is a system comment (`kind = system`); on chat sessions it
   is a system message. Delegation reports and decision answers, which today live
   only in task prompts or `session_events`, become such entries.
2. **`sendEnvelopeWithinTransaction` is the only writer.** It resolves the
   role address, dedupes by a deterministic entry id under the session head lock
   (no seq is allocated for a duplicate), appends the entry, and calls
   `ensurePendingTurnWithinTransaction`. The five wake paths (E2, E3 failure
   notice, E3 readiness notice, E4, delegation return, mention) call it and
   nothing else. Message content is never appended to a task prompt.
3. **The pending turn is the queued `multiremi_tasks` row, one per lane.**
   `multiremi_tasks.execution_scope` becomes a stored column. Two partial unique
   indexes enforce at most one `status = 'queued'` row per
   `(issue_session_id, agent_id, execution_scope)` and per
   `(chat_session_id, agent_id)`. The key equals the lane primary key on purpose:
   the lane says how far the agent has read, the pending turn says that it will
   read again. Writers still look before they insert under the workspace row
   lock; the index is the invariant, not the control flow.
4. **Wakes commit with the state change.** `ensurePendingTurn` asserts it is
   inside the caller's transaction. ADR 0003 decision 8 ("every guarded path runs
   at transaction depth 1") stands; what changes is what may remain post-commit:
   only pushes (`emitCommitEvents`, `notifyTaskEnqueued`) and the E3 automatic
   start, which must lock a second Issue and is replayed by MUL-452. Crash
   injection before the turn write, after it, and after commit must observe
   either nothing or everything, on PostgreSQL and SQLite.
5. **`wake` has three meanings.** `now`: ensure a pending turn; if the turn ends
   with such entries still unread, ring again (re-ring). `next_turn`: no turn is
   created while one is queued or running; the entry rides along and never
   re-rings. `inbox_only`: never rings; it appears in the table of contents only.
6. **Receipts are best effort and coarse.** At claim time the turn card receives
   `metadata.inbox.delivered_to_seq`, written after the claim commit; failure
   is logged and does not affect the message. "Delivered" for a single entry is
   derived from the recipient lane cursor and turn coverage, never stored per
   entry.
7. **The unread projection gets a table of contents and folding.** Entries are
   ranked human decision > failed/stuck > done > notice, from
   `envelopePriority(entry)`; bodies over the fold threshold are summarised
   deterministically (head + heading outline) with an expand command instead of
   being cut.

## Consequences

- Four coalescing implementations and their prompt-append helpers are deleted.
  Skip/coalesce audit moves to `pending_turn_created | pending_turn_coalesced |
  pending_turn_skipped`; the lineage reasons in `DelegationSkipReason` stay.
- A human mention while a round is queued no longer creates a second queued
  task; it is read by the queued round. A continuation task is the pending turn
  for its lane like any other queued task.
- Delegation reports and decision answers become visible system comments in the
  recipient session.
- The migration collapses existing duplicate queued rows (keeps the oldest,
  appends the newer prompts, cancels the newer rows) before creating the indexes.
- The relay agent (转述 Remi) reads the Issue log through a lane of its own
  (`execution_scope = relay:<chat_session_id>`) instead of the latest-only
  aggregate in `multiremi_agent_issue_update_state`; that table is dropped after
  the v2 switch-over, not here.
- Until this lands, the E2/E4 crash window from ADR 0004 §5 remains and is
  covered by the parent's per-round inventory of children.

## Alternatives considered

A separate inbox table; a separate pending-turn table; the Live Hub as the
wake carrier; `multiremi_system_events` replay for E2/E4; a new log kind
`envelope`. All rejected for the reasons in the MUL-404 plan §5.
