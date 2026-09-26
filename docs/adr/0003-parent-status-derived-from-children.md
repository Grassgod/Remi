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
6. **The wakeup round carries `preserveIssueStatus`,** which stops
   `createTaskWithinWorkspaceLock` from parking the parent at `todo` when a
   member edits a child by hand.
7. **No backfill.** Existing parents are not rewritten in bulk. A parent sitting
   at `in_review` with open children moves the next time a child event fires, and
   each move leaves a `parent_status_derived` record. `MULTIREMI_PARENT_STATUS_GUARD`
   (default on) is the emergency switch.

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
