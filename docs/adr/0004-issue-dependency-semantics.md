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
   time, so no migration is required. `related` keeps its current meaning (none)
   and is reported with `direction: null` from either end: it is neither a
   prerequisite nor a dependent, so assigning it a direction would let a client
   render a peer link as a wait. Every other dependency row returned to a caller
   carries a computed `direction` relative to the issue being read.
2. **Satisfied means `done`.** `in_review`, `blocked` and `cancelled` are unmet:
   the gate exists so a dependent never starts on half-finished work, and a
   parked or abandoned prerequisite is exactly what a human must rule on.
3. **The gate has two layers: the status transitions and the task-creation
   funnel.** Crucially, nothing is added to `claim`: the gate decides before a
   task exists, so an already-queued task is never silently dropped, and a
   daemon never sees a half-rejected claim.

   *Layer 1 — status transitions (three places, all in the store):*
   - `assignIssue` — the funnel for every "start this issue" call. The gate
     holds an issue only when it is **waiting**: `status = backlog` with an unmet
     prerequisite. Such an issue records the assignee, keeps its status, creates
     no task, and writes `dispatch_skipped` with `dependencies_unmet`. An issue
     that is already `todo`/`in_progress` carries the dependency as information
     only — the plan's rule that adding a dependency to a running issue is just
     information — so re-assigning or dispatching it proceeds normally. That is
     also the rescue path for a row the pre-fix force path stranded at `todo`
     with nothing queued.
   - `updateIssueWithOutcome` — `backlog -> todo`/`in_progress` with an unmet
     prerequisite is a 409 `dependencies_unmet`. A member may override with
     `force: true`: the status change commits, `dependency_force_started` is
     recorded, the rows stay, and the store then dispatches through
     `assignIssue` with the internal force option, so an agent- or squad-owned
     issue really gets a round. A member-owned or unowned issue is a status
     change only, because there is no agent to run it. A dispatch that cannot run
     (archived owner, no runnable agent) is reported as `dispatch_skipped`
     rather than rolled back, matching assign-on-update.
   - `POST /api/issues` with `blocked_by` — the issue row, its number, its
     dependency rows and the cycle/ancestor checks are **one transaction**, so a
     rejected prerequisite leaves nothing behind: no orphan issue and no
     consumed number. The body runs through `createIssueWithinTransaction`; the
     wrapper opens the transaction only when the caller does not already own one
     (Feishu ingestion and autopilots do), because Postgres has no savepoints on
     this bridge. An issue with an unmet prerequisite parks at `backlog`
     whatever status was requested.

   *Layer 2 — task creation (`createTaskWithinWorkspaceLock` in tasks-repo),
   the single funnel every task is born in:* creating the **first** task of a
   waiting issue is refused with `IssueDependencyError("dependencies_unmet")`,
   regardless of who is asking. Because the check sits at the funnel rather than
   at each caller, a path that does not exist yet is covered too. The check runs
   after the issue is resolved and before any `INSERT`, so a refusal leaves no
   partial row.

   *Structural exemptions (never identity-based, and never request-supplied).* A
   round that continues an existing conversation is not the issue's first
   execution, so the funnel lets it through: a retry (`attempt > 1`), a
   continuation naming `continuedFromTaskId`, the E2 parent wake-up
   (`preserveIssueStatus`), and a delegation return (`delegationId` with
   `delegatedByAgentId === agentId`). Identity is deliberately not consulted —
   the funnel would otherwise have to trust the request body about who is
   calling — so the fields these exemptions read are stripped from every public
   task-creation request: the route removes `attempt`, `maxAttempts`,
   `preserveIssueStatus`, `continuedFromTaskId`, `delegationId` and
   `delegatedByAgentId` in both spellings, and only server paths (retry,
   continuation, the E2 wake-up, the delegation return) set them. A caller that
   supplies any of them gets the ordinary gate behaviour: 409
   `dependencies_unmet` and no round. The dispatch behaviour around these
   exemptions is:
   - a comment-driven dispatch on a waiting issue records the hold and does not
     create a task — `dispatch_skipped` with `dependencies_unmet` for the
     assignee auto-response, `comment_mention_skipped` with the same reason for
     an agent mention — and **the comment itself is still persisted**;
   - an Autopilot `trigger_issue` on a waiting issue settles its run as
     `skipped` with reason `dependencies_unmet` and creates no task;
   - `POST /api/multiremi/tasks` and `POST /api/issues/:id/rerun` answer 409
     `dependencies_unmet`, with a message telling the caller to force-start.

   **There is exactly one way across the dependency: a member's `force`.** It
   works only through the audited status write — CLI
   `remi issue update <A> --status todo --force`, or the web "强制开工" button —
   which moves the issue out of `backlog` and records `dependency_force_started`.
   Once the issue is no longer waiting, both layers treat it as an ordinary
   running issue. There is no second override:
   - the **assign route** does not accept one: `force` is a server-internal
     parameter (`AssignIssueOptions`, mirroring `UpdateIssueOptions`), never a
     field of the request-bound `AssignIssueInput`, so a request body that
     supplies it is ignored;
   - the **two batch routes** are not an override for this gate either. They
     still honour `force` for the *parent-status* guard (S1's member override,
     `issue_status_forced`), but the store moves that value into a
     server-internal option the dependency gate never reads, so a waiting issue
     targeted by a batch keeps its status, gets no round, and is reported
     per-row as skipped with `dependencies_unmet`. Choosing this over dropping
     batch `force` entirely keeps S1's documented behaviour intact while
     satisfying the ruling's "exactly one entrance";
   - a single forced start dispatches exactly once: the status write commits,
     the store's `dispatchForcedStart` queues the round, and the route's
     assign-on-update step is skipped for that request, so no round is created
     and immediately cancelled.
   An override therefore always leaves exactly one `dependency_force_started`
   and exactly one task row.
4. **Waiting state is `backlog` + unmet prerequisite.** No new status is added,
   so every surface that already understands `backlog` shows waiting issues
   correctly, and `GET /api/issues/child-progress` reports them as `waiting`.
5. **Automatic start is a post-commit hook on the prerequisite's own terminal
   write, and it claims the start atomically.** When B enters `done`, each
   dependent still in `backlog` whose own prerequisites are all satisfied is
   dispatched by the server (`dependency_auto_started`) if its owner is an agent
   or a squad. Because two prerequisites can finish concurrently on separate
   connections, reading the dependent is not enough: the start is claimed with a
   conditional `UPDATE ... WHERE status = 'backlog'`, and only the transaction
   whose update reports one changed row dispatches. The losers do nothing — no
   task, no second `dependency_auto_started` — and the claim is a single
   transaction on its own, so the dispatch still happens after the prerequisite's
   transaction committed and the nesting depth stays 1. A member's forced start
   moves the row off `backlog` first, so it wins the same race for the same
   reason.
   A dependent with no agent owner is **only reported**, never started, and the
   report must not cost the parent owner an extra round:
   - same parent as the prerequisite — the readiness line is folded into the
     prerequisite's E2 report (`dependency_satisfied` on the dependent carrying
     `mergedIntoPrerequisiteReport: true`), so the owner reads one round instead
     of two;
   - a different parent, or a prerequisite with no parent — the activity
     `dependency_satisfied` is written on that parent, and the line is appended
     to its owner's **already-queued** round when one exists. Nothing is created
     when no round is waiting, because the plan says the owner's *next* round;
   - no parent at all — the dependent's own member owner, or its subscribers,
     get an inbox item.
6. **A failing prerequisite is a report, not an automatic cancel.** When B
   enters `cancelled` or `blocked`, each **waiting** dependent (the same
   `backlog` + unmet definition the gate uses) records
   `dependency_prerequisite_failed` and the report that reaches A's owner (or
   A's parent owner) lists the three concrete ways out: re-plan with a
   replacement prerequisite, cancel A, or drop the dependency row. A dependent
   that is already `todo`/`in_progress` is deliberately not notified: the
   dependency is information for it, the platform is not holding it, and the
   prerequisite ending does not change what it should do.
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
