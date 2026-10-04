# ADR 0005: Cross-issue delegation returns to the dispatcher's Issue Session

## Status

被 ADR 0013 修订：消息、收件箱与轮的当前模型取代旧命令和任务入口；下文保留决策史实。

Accepted (MUL-400 S1b, child issue MUL-456). Ships stacked on S2
(`docs/adr/0004-issue-dependency-semantics.md`), which ships on S1
(`docs/adr/0003-parent-status-derived-from-children.md`).

## Context

A squad leader can dispatch work with `remi task create --issue <child>` from
its own task credential. Before this change the delegation lineage was only
recorded when the target issue was the leader's own issue
(`sourceTask.issueId === issue.id`). A dispatch to a child or sibling issue got
no `delegation_id`, so when the teammate's task ended
`ensureDelegationWakeupWithinWorkspaceLock` fell into its silent branch: no
return task, no `delegation_return_triggered`, no `delegation_return_skipped`.
On MUL-383 five dispatched tasks finished and the leader waited about four
hours until a human woke it.

Two further behaviours were decided with the fix's reviewers:

1. **Return landing point.** The return must wake the leader in the Issue
   Session it was in when it dispatched, not in the child issue's Session.
   Otherwise a leader working from a named Session would receive the report in
   an unrelated context, and the E2 child-done round (which the S1 lineage built
   around the parent issue) would wake it a second time.
2. **No more silence, and no double wake.** A task-token dispatch that does not
   qualify as a delegation records why. A terminal delegated task returns
   exactly once, including when the teammate already woke the leader manually,
   and including when the child's own status change already queued the E2
   parent round.

## Decision

1. **Cross-issue delegation is a squad-leader dispatch within the source
   issue's tree.** `isSquadLeaderDelegation` returns a discriminated result. The
   same-issue branch is unchanged. The cross-issue branch requires: the author
   is the leader of the squad that owns the *source* issue; the target agent is
   an agent member of that squad and is not the author; the source task has an
   issue and a main (non-side) Session; and the target issue lies in the source
   issue's own subtree or in the subtree of the source issue's parent. The walk
   uses `parent_issue_id` with a visited set and a bound of 16 hops.

2. **`multiremi_tasks` carries the return target and the audit.**
   `delegated_from_issue_session_id` is the delegator's Session at dispatch
   time; a same-issue delegation stores its own Session there, and old rows read
   NULL, which keeps the legacy "return to the task's own Session" behaviour.
   `delegation_skip_reason` records why a task-token dispatch was not a
   delegation (`source_not_issue_task`, `source_side_session`,
   `source_not_squad_leader`, `target_not_squad_member`,
   `cross_issue_no_lineage`, `self_dispatch`). Both columns are added by
   `addColumnIfMissing`, so the migration is add-only on SQLite and PostgreSQL
   alike, as are the `delegated_from_issue_session_id` and `wake_source`
   columns added in the same batch. The public task shape strips both the return
   target and the skip reason, and `POST /api/multiremi/tasks` strips their
   request-body spellings along with the other server-owned fields.

3. **The terminal report lands in the dispatcher's Session.** When a delegated
   task reaches a terminal state, the same transaction that finalizes it
   appends one `delegation_report` session event to the return Session, carrying
   the source issue key, source task id, delegate agent id, terminal status,
   `result_comment_id` and delegation id. `requiredEventSeq` is that event's
   `seq`, so the existing lane-cursor, `projectionToSeq` and
   queued-projection-empty conventions apply unchanged. The drain selects
   sources by `COALESCE(delegated_from_issue_session_id, issue_session_id)` and
   accepts either the task's own terminal event or the bridge event.

4. **A returned report is exactly one round.** The return task is created in the
   return issue and Session with the delegator as agent, the source task as
   `parent_task_id` and the delegation id carried over. Later reports coalesce
   into the still-queued round. A delegation that cannot land
   (`delegator_unavailable`, `delegator_issue_closed`, `delegator_session_missing`)
   or a rejected dispatch writes `delegation_return_skipped` with its reason on
   the source issue, and on the dispatcher's issue as well whenever the two
   differ and the dispatcher can be expected to act on it. The current terminal
   task's own skip or coverage audit does not suppress the Session-wide drain:
   after recording that audit, every valid return Session still drains older
   terminal sources whose coverage pointer was cleared.

5. **Manual wake-ups suppress the automatic return.** If the delegate already
   created a task for the delegator with `parent_task_id = source.id` in the
   return Session, the source is stamped with that task as its
   `delegation_return_task_id` and the skip reason is
   `covered_by_delegate_wakeup`. Only `parent_task_id` carries the lineage;
   because that predicate is trusted, `parent_task_id` itself is
   credential-owned. On every task-creation surface a verified request
   (member PAT, login session, task token, daemon token) supplies it from the
   credential — its own task id for a task token, otherwise `null` — and the
   route strips both body spellings (`parentTaskId`, `parent_task_id`) before
   stamping, so no nested or alias spelling can outrank it. The store reads a
   present camelCase key as authoritative *including an explicit `null`*
   (`resolveCamelOrSnakeString`) instead of the historical
   `camel ?? snake` fallback. The store's older fallback to a trigger comment's
   run id also stays off once the caller has supplied an explicit lineage key,
   which every public route now does; a delegated run's own comment carries that
   run's task id and is readable, so leaving the fallback steerable would reopen
   the same forgery through `triggerCommentId`. Comment bodies obey the same
   rule: a comment's
   `task_id` links it to its run, and the mention dispatcher and assignee
   auto-response read that link back as `parent_task_id`, so only the task-token
   branch of `issueCommentCreateInput` may set it. Anonymous compatibility
   (auth disabled, or the deployment master token) is deliberately unchanged.
   `trigger_comment_id` is not consulted.
   Because the E2 child-status round also
   sets `parent_task_id`, server-generated wake rounds carry
   `wake_source = 'child_status'` and the de-duplication query requires
   `wake_source IS NULL`. `wake_source` is a server-owned column: retries,
   redispatch and `task continue` copy it, and the public task-creation route
   strips both `wakeSource` and `wake_source`. NULL means "not a server wake
   round", so future server rounds can add their own value without touching the
   de-duplication rule. A cancelled manual wake-up does not suppress the
   automatic return.

6. **The E2 parent round follows the dispatcher's Session.** The child-done
   hook selects the return Session from the triggering task's
   `delegated_from_issue_session_id` when that Session belongs to the parent
   issue, and falls back to the parent's default Session otherwise, matching
   the D2 ruling. Both chains therefore race for the same queued round and only
   one wake survives.

7. **The cross-issue result comment id is resolved once.** For a cross-issue
   report, `result_comment_id` is the newest comment on the target issue whose
   `task_id` is the source task, read inside the terminal transaction. Exactly
   one such SELECT runs per terminal transaction: the value resolved for the
   bridge metadata is threaded into the return-prompt construction, so the two
   cannot disagree even if a later comment commits in between (comment writes
   do not take the workspace lifecycle lock). That bridge value is the source
   task's terminal snapshot: every later drain reads it from the newest
   `delegation_report` event, and a present `result_comment_id: null` is
   authoritative rather than a reason to query comments again. The newest event
   is used to match the drain's existing maximum-event-sequence coverage rule
   and the bridge writer's existing latest-event lookup if historical data
   contains duplicate reports. A cross-issue report without the metadata key
   falls back to the legacy latest-comment lookup for compatibility. New
   cross-issue terminal reports always include the key. No existing event is
   rewritten and no fallback value is persisted. It is never back-filled: the
   automatic result comment is posted after that transaction commits, so a
   report with no in-run comment carries `result_comment_id: null` and the
   prompt line
   `Result comment: none at completion (the final reply is posted as a comment
   after this report; result text follows)`. The report body is always the task
   result, truncated to 16000 characters, which is the primary content.
   Same-issue reports keep their pre-MUL-456 assembly: they do not query a
   result comment and do not render a `Result comment:` line.

8. **The dependency gate is unchanged.** A return task is a self-delegation
   (`delegation_id` set, `delegated_by_agent_id === agent_id`) and an E2 round
   uses `preserveIssueStatus`, so both are structural exemptions in
   `assertIssueDispatchable` (ADR 0004). The gate is not loosened for anything
   else, and the fields it reads stay stripped from public requests.

## Consequences

- A leader that dispatches on a child or sibling issue is called back on the
  child's terminal state, in the Session it dispatched from. The MUL-383
  scenario (five children, sequential HTTP dispatch and completion) ends with
  one queued return carrying all five reports, no silent loss and no repeated
  wake-up.
- Cross-issue dispatches that do not qualify now leave an explicit
  `delegation_return_skipped` row instead of nothing, and the seven new reasons
  are localized in the issue timeline for all four languages.
- The task table gains three nullable columns and one index in an add-only
  migration. Existing rows keep their legacy behaviour.
- An archived return Session keeps receiving the bridge and the queued return:
  the Session's `status` is a list filter, not a lifecycle end, and the
  dispatcher's deliverables are visible on the Issue either way. The round
  stays claimable, so the daemon drains it normally.
- The return task still relies on the existing delegation machinery: the
  return cannot bounce, a retry chain reports once, and the parent status guard
  does not reopen a closed parent.
- Residual risk: the automatic result comment is still best-effort and
  published after commit. When it fails, the return prompt carries the fallback
  line and the result text; no comment id is invented and no session event is
  rewritten.
