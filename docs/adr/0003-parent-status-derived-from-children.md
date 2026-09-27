# ADR 0003: Parent issue status is derived from its children

## Status

Accepted (MUL-400 E1, child issue MUL-406). Ships with the S1 PR; S2 (dependency
gate and automatic promotion) extends the same hook.

## Context

Issue status was unconstrained: any writer could PATCH any value, and the task
terminal path derived `in_review` from the *tasks of that Issue* alone. Neither
writer knew about `parent_issue_id`. The observable failures were:

- a parent with a dozen live children showed `in_review` as soon as one of its
  own tasks finished (MUL-383), so "in review" no longer meant "the parent's work
  is finished";
- `done` was reachable while children were still open, which silently orphaned
  them;
- conversely, nothing ever pushed a parent *out* of `in_review` when a child
  changed, so the parent's status drifted away from its subtree.

At the same time, the parent owner only heard about a child that reached `done`,
and only on the direct Issue write path. A child that failed, blocked or was
cancelled was silent, and a parent owner who was busy had the notification
dropped (`active_task_exists`), so a parent could lose reports entirely.

## Decision

1. **Two guards, one re-derivation, in the store.** No status-machine table and
   no validation for Issues without children:
   - **Guard A** runs inside `updateIssueWithOutcome`'s Issue row lock. A target
     of `in_review` or `done` with `open_children > 0` is rejected with 409
     `issue_status_held` (`reason: children_open`, `open_children: N`). A `done`
     target additionally requires the final-summary signal (below), else 409
     `final_summary_missing`.
   - **Guard B** runs on the task-terminal derivation
     (`syncIssueStatusFromTaskWithinTransaction`). A derived `in_review`/`done`
     with open children is rewritten to `in_progress` and recorded as
     `parent_status_held`. `createTaskHumanRequest`'s transient `in_review` stays
     as-is: while an owner waits on a human answer the parked state is correct,
     and the resume path puts the Issue back.
   - **Re-derivation** happens when a child is created, re-parented or changes
     status: an `in_review` parent with open children returns to `in_progress`
     (`parent_status_derived`). A `done` or `cancelled` parent never moves —
     terminal states stay human decisions, matching the existing rule in the
     task sync path.
2. **`open_children` excludes only `done` and `cancelled`.** `blocked` counts as
   open: a parked child is precisely what a human must rule on, and treating it
   as finished would let the parent close over unresolved work.
3. **The final-summary signal (A1)** for `done` is: after the last child closes,
   the parent owner completed a round whose `result` carries non-empty output.
   It is skipped for member-owned parents (a human closing the Issue *is* the
   summary). The check reads the owner's tasks on the parent, so it needs no new
   column and no migration.
4. **`force` is member-only.** `UpdateIssueInput.force` passes the guards and
   records `issue_status_forced` (with the child count it overrode). A task
   identity sending `force` gets 403 on all three status writers (both PATCH
   routes and batch update), and A4 additionally rejects a task identity closing
   any Issue that has children (`parent_done_requires_member`). Workflow:
   attempt without `--force` to see the reason, then repeat with it.
   The system-only bypass is deliberately NOT a field on `UpdateIssueInput`: it
   is an `UpdateIssueOptions` argument passed positionally by the store, because
   the wire layer builds `UpdateIssueInput` straight from the request body, and
   any field on that shape is client-reachable. A body that sends a bypass-looking
   key is simply ignored, for members and task identities alike.
5. **Child endings always notify the parent owner through one hook.**
   `notifyChildStatusChange` is called post-commit by both Issue write paths, so
   `done`, `failed`, `blocked` and `cancelled` all report. Agent and squad owners
   get a `child_status_parent_notification` comment (`data.outcome` distinguishes
   a task failure from a human block) plus a round. A busy owner no longer
   suppresses the report: it is appended to that agent's queued round
   (`child_status_parent_coalesced`), and several child endings coalesce into one
   round because the workspace lock serialises the lookup and append. Human
   owners get the `child_issue_terminal` inbox type, warning for failed/blocked
   and info otherwise. A parent with no assignee keeps its historic comment and
   skip record and now also reaches subscribers.
   A child that ends while its parent is already `done`/`cancelled` is a
   different case: the parent's status is a settled human decision and nothing
   may be filed against a closed parent, so the ending is recorded as a single
   `child_status_after_parent_closed` activity (child id, key and outcome) and
   nothing else — no comment, no round, no status change. Silence would be the
   one outcome E2 forbids.
6. **The merge-completion path respects the child count instead of bypassing it.**
   The SCM merge effect closes a linked Issue when the merge lands, and a merge
   that a human authorized is the confirmation guard A exists to obtain — so A1
   and A4 do not apply and no `issue_status_forced` row is written. But that
   authorization covers *the merge*, not the closure of a parent whose children
   are still running, so the effect branches on `open_children`:
   - **children still open** — the parent's status does not move. The effect
     records `parent_status_held` (with `requested: "done"`, `source:
     "scm_merge"`, and the change request's number and url) and marks itself
     applied. A hold is a settled outcome, not a retry, and it never re-closes
     the parent later: when the last child finishes, `done` is the human's call
     under E1. Without this branch, a *child's* PR — which routinely names the
     parent key in its title, and which auto-link matches by key word boundary —
     would close a parent with live children the moment that child merged.
   - **children all finished, or none** — the Issue closes, as before.

   The exemption itself never travels through the wire: it is a server-only
   argument on `updateIssue`, so no request body can reach it.
7. **No backfill.** Existing parents are not rewritten in bulk. A parent sitting
   at `in_review` with open children moves the next time a child event fires, and
   each move leaves a `parent_status_derived` record. `MULTIREMI_PARENT_STATUS_GUARD`
   (default on) is the emergency switch.

8. **Every guarded path runs at transaction depth 1.** `PostgresSyncDatabase.transaction()`
   is a bare `BEGIN`/`COMMIT` with no savepoint support, so a nested
   `transaction()` inside an open one commits the outer transaction early,
   releases its row locks, and turns the outer `ROLLBACK` into a no-op. The
   store therefore keeps its `...WithinTransaction` convention: the outermost
   caller owns the only transaction, and everything under it calls the variant
   that assumes an open transaction.
   - **The collector is a required parameter, not an option.** Every
     `...WithinTransaction` variant that can move an Issue (the Issue-status
     sync reached from `createTaskWithinTransaction`, `createTaskHumanRequest`,
     `startTask`, `respondTaskHumanRequest`, the terminal writers, `cancelTask`/
     `redispatch`/`cancelTasksByTriggerComments`/`recoverOrphans`, and the
     `chat`/`feishu-bot`/`autopilot` wrappers) takes a
     `ChildStatusChangeCollector` with no default and no `null` form. The
     compiler therefore forces each call site to answer one question: which
     transaction owns these writes? There is no way left to "run the hook here
     because nobody passed a collector".
   - **The outermost owner replays after it commits.** A transition collected
     inside a transaction is handed back to whoever committed it, and the E1/E2
     hook runs only then. The hook can itself produce a further transition — the
     round it queues for a parent moves that parent's status, which is a child
     event for ITS parent — and those come back as the hook's return value, so
     the replay is a drain loop that never nests a transaction. The loop is
     bounded by a `seen` set keyed on (issue, previous status, next status,
     task), so a parent/child status ping-pong terminates.
   - **Events publish only after the COMMIT.** The same rule covers what the
     writes push outward: `comment:created`, `issue:updated`, and task-enqueue
     wakeups. A caller-owned transaction collects them in a commit-event queue
     and flushes it once it has committed; on rollback the queue is dropped and
     nothing was ever sent. Postgres is synchronous here, so an event emitted
     mid-transaction would reach clients before the row was durable and, worse,
     would announce a row a later ROLLBACK erases.
   - `notifyChildStatusChange` opens the single transaction for a child report.
     The notification comment (with its Session event) and the parent's queued
     round are written inside it; the round is created through
     `TasksRepo.createTaskWithinTransaction`, so it still passes through the
     same creation entry point the rest of the product uses (S2's dependency
     gate lives there). `notifyTaskEnqueued` and the realtime `comment:created`
     broadcast are deferred until after the COMMIT.
   - `createSystemIssueComment` splits into a self-transactional wrapper and a
     `WithinTransaction` variant, chosen by whether the caller already owns one;
     its Session event uses `appendSessionEventWithinTransaction` for the same
     reason.
   - The task-terminal paths (`completeTask`, `failTask`, `cancelTask`,
     `redispatchTaskWithinTransaction`, `cancelTasksByTriggerComments`,
     `recoverOrphans`) and the organizer action facade collect their Issue
     transitions and replay the hook after their own commit. The same holds for
     the writers that derive an Issue status while creating or moving a task
     (`createTask`, `startTask`, `createTaskHumanRequest` and its respond/expire
     twins) and for the Chat / Feishu / Autopilot wrappers that create tasks
     inside their own transactions; each one owns a collector and replays it
     after it commits.
   - **A hook failure does not roll back the child's status.** By the time the
     hook runs, the child's transition is committed — that is the whole point of
     running post-commit. The hook's own writes are atomic: a failure inside it
     leaves no half-written round, comment or activity. The failure is visible at
     the call site when the caller owns the write (the direct Issue path
     rethrows, and the HTTP client sees 500) and is always logged with
     `log.warn` by `TasksRepo.runChildStatusChanges` for the terminal paths,
     which must not fail a completed run; `journalctl`/the `remi` log file
     carries the line `child status hook skipped for <issue id>: <message>`.
   - **Known compensation risk (accepted for now).** Because the status is
     committed before the hook runs, a hook failure on the direct write path
     answers 500 while the child's transition stays applied. A client that
     simply repeats the request will not re-enter the terminal transition, so
     that one parent report can be lost. There is no reliable retry in this
     issue: the fix needs a durable outbox for the hook's own writes (record the
     intended report in the same transaction, deliver it afterwards, retry on
     failure) rather than a synchronous best-effort call. Tracked as a
     follow-up candidate; the current behaviour is what the round-2/3 QA rounds
     measured, and it is unchanged from the previous commit.
   - `PostgresSyncDatabase.transaction()` is deliberately left alone. Teaching it
     savepoints is a platform-level change with its own blast radius (every
     caller, the worker bridge, and the SQLite backend's differing semantics),
     well outside this issue. The constraint is instead held by the call-site
     convention above and by the depth-counter regression tests.
   - Two nesting sites remain, both pre-existing on `main` and out of this
     issue's scope: `FeishuBotRepo.submitMessage`'s steer path
     (`feishu-bot-repo.ts`) and `MultiremiStore.updateAgent`'s role-change token
     revoke (`store.ts`). They are recorded here rather than fixed, and are
     tracked for a separate issue; the nesting scan in
     `tests/unit/multiremi/pg-nesting-preload.ts` reproduces them on a clean
     `origin/main` tree.
   - S2's dependency gate lives in this same hook. Its automatic start
     (`assignIssue`) opens its own transaction, so it must stay *outside* the
     report transaction — before it, committing separately — and only its
     returned readiness lines feed the report. Verified on a scratch merge of
     the two branches: the combined path still measures depth 1 on Postgres.
9. **A batch update is pre-flighted as a whole, then written row by row.** Before
   the first write, `batchUpdateIssues` evaluates guard A (A1 and A4 included)
   for every row and refuses the whole batch if any row would be rejected,
   returning the refused issue ids in `rejected_issue_ids`. This is what makes
   "refused" and "partially applied" distinguishable. The per-row guard still
   runs during the write, because a concurrent writer can move an Issue into a
   guarded state in the window between the pre-flight and the write; that
   residual race is accepted rather than solved with a global lock. The historic
   behaviour of silently skipping non-guard errors (missing or inaccessible
   rows) is unchanged, and a refusal in the write loop now surfaces as an error
   instead of a 200.
10. **Unchanged behaviours this ADR pins down.** Two things the second QA round
    raised are deliberate and stay as they are:
    - `batchUpdateIssues` still silently skips a row whose write fails for a
      reason other than the parent-status guard (a missing or inaccessible
      Issue, for instance). That is the historic batch contract and the `updated`
      count is what the caller uses; the guard is the one refusal that must
      surface. A caller should not read `updated` as "everything else succeeded".
    - `recoverOrphans` only produces an E2 report when the orphan's failure
      actually moves its Issue's status. A failed task whose Issue still has
      another live round leaves that Issue where it was, so there is no child
      ending to report and none is fabricated.

## Alternatives considered

- **Enforce in the HTTP layer.** The task-terminal path never goes through HTTP,
  so guard B would not exist and MUL-383 would persist. Put the rule where both
  writers meet.
- **A status-machine table with per-transition rules.** The only rule that needs
  enforcement is "parent with open children"; a general table would be a much
  larger surface for the same behaviour, and would start rejecting transitions
  today's users rely on.
- **Let the parent owner close over open children with a warning comment.** Keeps
  `done` reachable but leaves the children behind with no owner attention —
  exactly the failure this ADR removes. Members keep an explicit, audited
  override via `force` instead.
- **A terminal child status instead of a re-derivation.** Would require defining
  "finished enough" and would break the workbench surfaces that read
  `in_review`.
- **Drop the report when the owner is busy (status quo).** The reason the S1 issue
  exists; the coalescing design keeps one pending round per parent while losing
  no reports.

## Consequences

- **Positive:** a parent's status now matches its subtree; `in_review` means "the
  owner's own work is done"; `done` cannot strand children; no child ending is
  silently dropped; a busy owner receives at most one extra pending round per
  parent no matter how many children end.
- **Positive:** no migration, no schema change, no affected claim path
  (`claimTask` / `claimNextTaskForRuntime` are untouched).
- **Negative:** the guards are the first status validation for Issues, so scripts
  and agents that used to PATCH `done` directly now must either finish children
  first or `force` as a member. Team tooling that closes parents programmatically
  needs the member identity.
- **Negative:** `MULTIREMI_PARENT_STATUS_GUARD` is a behavioural switch inside the
  store; when off, guard A/B and the re-derivation are skipped but E2's
  notifications continue.
- **Neutral / open:** the round count is maintained by the workspace lock rather
  than a partial unique index; a durable "one pending round per (parent, agent)"
  constraint is left to a later issue if the lock-based guarantee proves
  insufficient.
