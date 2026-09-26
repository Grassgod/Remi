# ADR 0004: Issue dependencies are a single directed `blocked_by` edge

## Status

Accepted (MUL-400 E3, child issue MUL-409). Ships with the S2 PR, stacked on
S1 (`docs/adr/0003-parent-status-derived-from-children.md`).

## Context

`multiremi_issue_dependencies` existed with three types (`blocks`,
`blocked_by`, `related`) and no behaviour attached to any of them. Nothing read
the table: a declared dependency was a comment in a description, and every
squad rule about ordering was prose. The observable failures were:

- a child that waited on a sibling was dispatched anyway, so two rounds ran
  against each other and the later one re-did or contradicted the earlier one;
- when the prerequisite finished, nothing started the dependent, so the chain
  stalled until a human noticed;
- when the prerequisite was cancelled or blocked, nobody was told, and the
  dependent sat in the queue forever;
- both `blocks` and `blocked_by` could describe the same pair, so "who waits for
  whom" depended on which writer created the row first.

## Decision

1. **One direction is stored.** The table keeps `blocked_by` rows only:
   `(issue_id = A, depends_on_issue_id = B, type = 'blocked_by')` reads "A waits
   for B". A write with `type: blocks` is normalized before storage by flipping
   the pair, and pre-existing `blocks` rows are interpreted reversed at read
   time, so no migration is required. `related` stays direction-free and keeps
   its current meaning (none). Every dependency row returned to a caller carries
   a computed `direction` relative to the issue being read.
2. **Satisfied means `done`.** `in_review`, `blocked` and `cancelled` are unmet:
   the gate exists so a dependent never starts on half-finished work, and a
   parked or abandoned prerequisite is exactly what a human must rule on.
3. **The gate lives in the status transitions, not in claim.** Three places, all
   in the store:
   - `assignIssue` — the funnel for every "start this issue" call. An issue with
     an unmet prerequisite records the assignee, keeps its status, creates no
     task, and writes `dispatch_skipped` with `dependencies_unmet`.
   - `updateIssueWithOutcome` — `backlog -> todo`/`in_progress` with an unmet
     prerequisite is a 409 `dependencies_unmet`. A member may override with
     `force: true`, which writes `dependency_force_started` and keeps the rows.
   - `POST /api/issues` with `blocked_by` — prerequisites are created in the same
     transaction as the issue, and an issue with an unmet prerequisite parks at
     `backlog` whatever status was requested.
   Keeping claim untouched means a task that is already queued is never silently
   dropped: the gate decides before the task exists.
4. **Waiting state is `backlog` + unmet prerequisite.** No new status is added,
   so every surface that already understands `backlog` shows waiting issues
   correctly, and `GET /api/issues/child-progress` reports them as `waiting`.
5. **Automatic start is a post-commit hook on the prerequisite's own terminal
   write.** When B enters `done`, each dependent still in `backlog` whose own
   prerequisites are all satisfied is dispatched by the server
   (`dependency_auto_started`) if its owner is an agent or a squad, and only
   reported (`dependency_satisfied`, reaching the parent owner or the member's
   inbox) if its owner is a human or nobody. The hook is idempotent: the second
   `done` finds no `backlog` dependent, and the gate inside `assignIssue` refuses
   a start that is not actually unblocked.
6. **A failing prerequisite is a report, not an automatic cancel.** When B
   enters `cancelled` or `blocked`, each waiting A records
   `dependency_prerequisite_failed` and the report that reaches A's owner (or
   A's parent owner) lists the three concrete ways out: re-plan with a
   replacement prerequisite, cancel A, or drop the dependency row.
7. **Cycles and ancestor dependencies are refused, not repaired.** A bounded
   depth-first walk (200 nodes) from the proposed prerequisite over the
   "waits for" graph answers 409 `dependency_cycle` with the key path, and
   depending on one of the dependent's own ancestors answers
   `dependency_on_ancestor`, because a parent always finishes after its children.
   The bounds matter: the graph is user-authored and an unbounded walk is a
   denial-of-service surface.
8. **`MULTIREMI_DEPENDENCY_GATE`** (default on) disables the gate, the automatic
   start and the failure reports in one step. Dependency rows survive the switch,
   so re-enabling it needs no repair.

## Consequences

- A dependency declared before this change read as `blocks` keeps working: it is
  interpreted reversed, and the surfaces show the same relation the author meant.
- The dependent side of an unmet prerequisite is visible instead of silent: the
  issue stays in `backlog`, `dispatch_skipped` says why, the detail payload
  carries `waiting_on`, the children payload carries `blocked_by`, and
  `child-progress` counts it as `waiting`.
- Automatic start creates tasks, so `max_concurrent_tasks` and the execution
  lane bound how fast a chain drains; a long chain does not burst.
- A human-owned dependent never starts itself. That is deliberate: the platform
  reports readiness and the human decides, matching the parent-status rules in
  ADR 0003.
- The stored direction is single, so a future "why is this blocked" query is one
  index-backed read instead of an ambiguity resolution.
