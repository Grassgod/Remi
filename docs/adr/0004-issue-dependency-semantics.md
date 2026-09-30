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
     `force: true`: the status change, `dependency_force_started` and the
     dispatch decision share the same transaction, and the dependency rows stay.
     A runnable agent or squad gets one round and `issue_assigned` in that
     transaction. A member-owned or unowned issue gets the requested status but
     no round, and records `dispatch_skipped` in the same transaction because
     there is no agent to run it. An archived owner or a squad with no runnable
     agent follows the same status-plus-`dispatch_skipped` rule rather than
     rolling the status back. There is no post-COMMIT call to `assignIssue`.
   - `POST /api/issues` with `blocked_by` — the issue row, its number, its
     dependency rows and the cycle/ancestor checks are **one transaction**, so a
     rejected prerequisite leaves nothing behind: no orphan issue and no
     consumed number. The body runs through `createIssueWithinTransaction`; the
     wrapper opens the transaction only when the caller does not already own one
     (Feishu ingestion and autopilots do), so the caller's `COMMIT` stays the only
     one and the creation's events wait for it; nested, the wrapper's
     `transaction()` would only be a `SAVEPOINT` (B1, MUL-426) and would publish
     before that `COMMIT`. An issue with an unmet prerequisite parks at `backlog`
     whatever status was requested.

   **The outermost owner holds the only transaction.** A flow that already owns
   the transaction passes its required child-status collector and commit-event
   queue into every `...WithinTransaction` writer; those writers never issue
   their own `BEGIN` or `COMMIT`, and the owner replays and drains only after its
   COMMIT (or drops both on rollback). Messaging follows the same rule:
   direct, approved and proposal owners call the transaction-internal outcome
   writer, while the standalone `recordOutcome` wrapper opens a transaction only
   for independent callers. This is required because a standalone wrapper
   publishes and replays right after its own `transaction()` returns; since B1
   (MUL-426) a nested `transaction()` on the PostgreSQL bridge is a `SAVEPOINT`,
   so that would happen before the owner's COMMIT and an outer rollback could
   not take it back.

   *Layer 2 — task creation (`createTaskWithinWorkspaceLock` in tasks-repo),
   the single funnel every task is born in:* creating the **first** task of a
   waiting issue is normally refused with
   `IssueDependencyError("dependencies_unmet")`. Because the check sits at the
   funnel rather than at each caller, a path that does not exist yet is covered
   too. The check runs after the issue is resolved and before any `INSERT`, so a
   refusal leaves no partial row.

   *Structural exemptions (never identity-based, and never request-supplied).* A
   round that continues an existing conversation is not the issue's first
   execution, so the funnel lets it through: a retry (`attempt > 1`), a
   continuation naming `continuedFromTaskId`, the E2 parent wake-up
   (`preserveIssueStatus`), and a delegation return (`delegationId` with
   `delegatedByAgentId === agentId`). Identity is deliberately not consulted —
   the funnel would otherwise have to trust the request body about who is
   calling — so the fields these exemptions read are stripped from every public
   task-creation request: the route removes `attempt`, `maxAttempts` /
   `max_attempts`, `preserveIssueStatus`, `continuedFromTaskId`, `delegationId`
   and `delegatedByAgentId` in both spellings, and only server paths (retry,
   continuation, the E2 wake-up, the delegation return) set them. A caller that
   supplies any of them gets the ordinary gate behaviour: 409
   `dependencies_unmet` and no round.

   *Credential-verified member actions.* A human comment, human agent mention or
   human rerun explicitly starts a waiting issue. The comment and rerun
   boundaries derive the actor from the credential, never the request body, and
   set the server-internal `dependencyForce` marker with source `comment`,
   `mention` or `rerun`. Public task creation strips `dependencyForce` and
   `dependency_force`, so callers cannot forge the marker. The funnel still
   makes no identity decision: it consumes the trusted marker and, in its task
   transaction, inserts the round, moves `backlog` to `todo`, and records one
   `dependency_force_started` with the member, source, comment/task ids and
   unmet prerequisites. The dispatched prompt warns that prerequisites remain
   unfinished. A mention dispatches only the mentioned agent; when that agent is
   not the issue owner, the activity records `assignee_dispatched: false`.

   Agent-authored comments and mentions do not receive the marker and remain
   held by the gate. Agent rerun, public task create and session task create also
   remain held. The other automatic paths remain unchanged:
   - an Autopilot `trigger_issue` on a waiting issue settles its run as
     `skipped` with reason `dependencies_unmet` and creates no task;
   - agent rerun, `POST /api/multiremi/tasks`, and session task creation answer
     409 `dependencies_unmet`.

   **The explicit status override remains a member's `force`.** It works through
   the audited status write — CLI
   `remi issue update <A> --status todo --force`, or the web "强制开工" button —
   which moves the issue out of `backlog` and records `dependency_force_started`.
   Once the issue is no longer waiting, both layers treat it as an ordinary
   running issue. The other status/assignment surfaces do not become overrides:
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
     batch `force` entirely keeps S1's documented behaviour intact;
   - a single forced start makes exactly one dispatch decision in the status
     transaction (see 3a): a runnable agent or squad gets `issue_assigned` and
     one round; a member, an unowned issue, an archived agent or a squad with no
     runnable agent gets `dispatch_skipped` and no round. The route does no
     second assign-on-update step for that request.

   **3a. The forced start is one transaction, and its audit names the record it
   really produced.** `updateIssueWithOutcome` owns the transaction and calls the
   transaction-internal status writer. Under the lock order used by
   `createTaskWithinTransaction` (`multiremi_workspaces` row first, then the
   Issue row), that writer records the status and force audit, makes the dispatch
   decision and, for a runnable agent or squad, writes `issue_assigned` and
   exactly one round. A member or an issue with no owner has no runnable agent:
   it writes the requested status and exactly one `dispatch_skipped`, but no task.
   An archived agent or a squad with no runnable agent is handled the same way.
   The skip row is part of the status transaction, so rollback leaves neither;
   an unexpected failure leaves the issue at `backlog` with no round and no
   activity.

   **A runnable agent or squad gets exactly one task row; every committed attempt
   gets exactly one start-classification record.** Which start record the lock
   chooses depends on the race, and all three are legitimate. `issue_assigned`
   and `dispatch_skipped` describe dispatch and are not additional start
   classifications:

   | When the force request took the row lock | Start record |
   | --- | --- |
   | prerequisites still unmet | `dependency_force_started` |
   | every prerequisite already `done` | the member's `issue_updated` (`backlog -> todo`), with no dependency start activity; dispatch is `issue_assigned` for a runnable agent/squad or `dispatch_skipped` otherwise |
   | the automatic start won the row first | `dependency_auto_started` |

   The middle row is the race ruling: a force request that finds the gate
   already open crosses nothing, so it is an ordinary member start and must not
   claim an override. Its `issue_updated` row is written in the same transaction
   as the `backlog -> todo` status change, including when the owner is a member or
   absent. Recording a `dependency_force_started` there would report an override
   that never happened; writing the activity after COMMIT would recreate a crash
   window in which the status survived with no start record. Keeping each of the
   three records with the state change makes the invariant literal: never zero
   start-classification records, never two.

   Before the status override became transaction-owned, a PATCH force raced
   through the post-COMMIT `assignIssue` path and could cancel a comment-driven
   round that had just committed. The transaction-owned path no longer calls
   `assignIssue`, so that cancellation window is absent on this baseline.
   Concurrent human actions still remain independent requests and are not
   coalesced by this decision.
4. **Waiting state is `backlog` + unmet prerequisite.** No new status is added,
   so every surface that already understands `backlog` shows waiting issues
   correctly, and `GET /api/issues/child-progress` reports them as `waiting`.
5. **Automatic start is one transaction: the claim, the status write and the
   round commit together.** When B enters `done`, each dependent still in
   `backlog` whose own prerequisites are all satisfied is dispatched by the
   server (`dependency_auto_started`) if its owner is an agent or a squad.
   Because two prerequisites can finish concurrently on separate connections
   (and a member can force the issue at the same moment), the server locks the
   issue row after the workspace lock, then rechecks `backlog`, no unmet
   prerequisites and no active task. PostgreSQL uses `SELECT ... FOR UPDATE`;
   SQLite's workspace-row write holds its single-writer lock. The start is
   claimed with a conditional `UPDATE ... WHERE status = 'backlog'`, and only
   the transaction whose update reports one changed row dispatches. The losers
   do nothing — no task, no second
   `dependency_auto_started`. A member's forced start competes for the same row
   and settles by the same rule (see 3a): whichever transaction takes the lock
   first owns the single start record, and the other one either finds the row
   already off `backlog` or loses the conditional `UPDATE`.

   The claim, the status write, the round and both audit rows (`issue_assigned`,
   `dependency_auto_started`) are a **single transaction**, taken after
   `lockWorkspaceRuntimeLifecycle(workspaceId)` so the lock order matches
   `createTaskWithinTransaction` (`workspaces` row, then the Issue row). Round 3
   shipped two separate steps here, and both were reachable:

   - `backlog -> todo` committed first and the round was created afterwards, so a
     process that died in between stranded the issue at `todo` with no round, no
     activity and no automatic path back (only a manual assign recovered it);
   - a failure *after* the round was inserted ran an unconditional
     `todo -> backlog` "release", producing `backlog` + a queued round — a
     waiting issue with work running.

   Both are gone. The dispatch decision is made under the locks before any write,
   as in 3a: an owner that cannot run writes exactly one
   `dependency_auto_start_skipped` (`reason: dispatch_failed`) in the same
   transaction, with no status change; a skip already recorded for the same check
   event suppresses a second one. A later `done` of the same prerequisite is a
   new event with a new key and is attempted again. Each triggering event records
   at most one outcome per dependent, so a dependent whose prerequisites finish
   within the replay window may carry one skip per prerequisite. Any other failure
   is unexpected: the transaction rolls back with nothing written, the
   post-commit path only logs it, and the `dependency_auto_start_check` replay
   retries it. The prerequisite's own `done` stays committed. A `backlog` issue
   that already owns an active round is not claimed: its status stays `backlog`, no
   task or auto-start activity is added, and the existing round moves it to
   `in_progress` when execution starts.

   Sequencing after the COMMIT: the task wakeup and the `issue:updated` event
   (with `status_changed: true`, `prev_status: "backlog"`) are emitted only once
   the transaction has committed, because a client must never be told about a
   state a rollback could erase. A crash in that window therefore loses only the
   live notification; a refresh reads the correct `todo` with its queued round.

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
   **Crash recovery (MUL-452).** The prerequisite's `done` transaction also
   writes an independent `issue/dependency_auto_start_check` system event,
   available after five seconds. The background system-event consumer retries
   only E3 automatic starts: the prerequisite must still be `done`, and the
   dependent must still be `backlog`, have every prerequisite satisfied, have
   an agent/squad owner, and have no `dependency_auto_start_skipped` activity
   for the same check event. That check runs inside the auto-start transaction
   under the workspace and issue locks, keyed by the `dependency_auto_start_check`
   event id: the `done` transaction returns it to the post-commit hook and the
   replay reads it from the event row, so both attempts of one `done` share one
   key and no wall-clock comparison is involved.
   Existing workspace/issue locks and the conditional `backlog -> todo` update
   arbitrate competing attempts; the event
   id is recorded as `dependency_check_event_id` on skip and auto-start activities;
   `replayed: true` appears only on replayed starts.
   The replay does not catch: business outcomes are return values written in the
   transaction, so every throw is treated as infrastructure and goes back to the
   outbox (eight attempts with exponential backoff, then `failed` with
   `last_error`; no activity is written for an exhausted replay, and the manual
   assign/status paths remain). Recovery has its own lease and retry budget and
   does not trigger autopilots or replay notifications. E2/E4 and E3
   readiness/failure notifications belong
   to MUL-404's atomic state-and-inbox acceptance. Background jobs must be
   enabled for automatic recovery; the public assign/status paths remain
   available for manual recovery. No schema migration is required.

   Structurally exempt tasks (retry, continuation, redispatch, delegation return
   and E2 parent wake-up) can still be created while the issue waits. Each such
   creation records `dependency_gate_exempted`; starting the task moves the
   issue to `in_progress` under the existing rules. These structural
   continuations are separate from the explicit member actions above.

   Two details the audit depends on, both pinned by cases:

   - `previousTaskId` / `previous_task_id` name the round the exempt creation
     actually continues. `continuedFromTaskId` wins over `parentTaskId`, because
     a leader-token continuation carries both: the delegating leader's turn as
     the parent, and the delegated round being continued. Reading the parent
     first reported the leader.
   - A refused session task leaves the session untouched. Creating a round for
     an Issue Session also enrols the agent as a participant, which creates its
     lane; the participant, the lane and the round share one transaction, so a
     409 `dependencies_unmet` — or any other failure in task creation — leaves
     `participants`, `lanes` and `tasks` exactly as they were. A pre-check of the
     gate under the same lock was rejected instead: the gate is only one of the
     ways that write can fail, and a mirror of a funnel that already owns the
     decision would drift from it.
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
