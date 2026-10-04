# ADR 0014: Every agent dispatch is a delegation

## Status

Accepted (MUL-510). Depends on ADR 0013 / PR #353 (MUL-498).
Amended by [ADR 0016](0016-unified-message-inbox-and-turn.md) (MUL-493): decisions 5–6 change from a 409 /
`comment_mention_skipped` to a stored message downgraded to the next turn
(`wake_reason=pair_round_trip_limit`); the notice and activity stay.
Supersedes ADR 0005 decision 1 and revises its dispatch skip reasons.

## Context

Tasks created by an agent in an unassigned Issue did not reliably return their
results. The squad-leader check excluded ordinary agents, agents outside the
squad and unrelated Issues. `session task create` bypassed that check entirely.
The return machinery already supports any dispatcher with an Issue Session.

## Decision

1. `resolveAgentDelegation` derives dispatch lineage from the authenticated
   source task. `task create`, `session task create`, agent `issue rerun` and
   task-linked rich mentions use the same resolver. The target runs in its
   requested Session; `delegated_from_issue_session_id` always names the source
   task's Session. No squad membership, assignee or Issue subtree is required.
   Existing workspace authorization and side-session dispatch guards remain.
   Continue preserves its delegation and existing authorization/Session checks,
   and checks the pair limit before creating a new requested round.
2. Self dispatch records `self_dispatch`; Chat/no Issue Session sources record
   `source_not_issue_task`; targets without an Issue record
   `target_not_issue_task`. These tasks do not return and retain terminal skip
   audits. Unlinked agent comments cannot dispatch. Ordinary human/autopilot
   tasks have neither delegation fields nor skip-audit noise. Old squad/tree
   reasons remain readable for historical rows.
3. Agent-created Issue/assignment first rounds keep their existing parent
   ancestry and child-status notifications without acquiring delegation fields.
   Retry and redispatch are successors, inherit the original delegation and
   report only the final attempt. A delegate mentioning its dispatcher reports
   progress through the existing return branch before any new dispatch check.
4. `MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT` is a positive integer, default 5;
   unset, zero, negative, nonnumeric or fractional values fall back to 5.
   `countDelegationPairHops` follows the current source task's `parent_task_id`
   chain, bounded to `2 * L` reads and guarded against cycles. Each counted task
   must have delegation id/dispatcher, belong to the source workspace, strictly
   alternate within the source/target pair, and be newer than the last member
   log entry in the source Session S0. Missing lineage, repeated agent or a
   third agent ends the segment. A member message in another Session does not
   reset S0; agent/system messages never supply the cutoff.
5. Existing hops `h >= 2 * L` reject the next dispatch. A real dispatch and its
   return consume two hops: the default sixth dispatch is refused, or the third
   at L=2 / second at L=1. Direct creation, Session creation, rerun and continue
   return HTTP 409 `code=pair_round_trip_limit` before target work is created.
   Rich mentions persist the comment and audit
   `comment_mention_skipped(reason=pair_round_trip_limit)`, without waking the
   target or adding input to its pending turn. Already dispatched work and
   terminal returns still complete normally.
6. Refusal writes a system notice in S0 using the existing `lifecycle` envelope
   kind and `wake=inbox_only`, with dedupe key
   `pair_round_trip_limit:<sourceTaskId>:<targetAgentId>`. It names both agents,
   the limit, source task and hop count, and asks for human intervention. It
   does not create a pending turn. `delegation_round_trip_limited` activity is
   recorded on the source Issue and, for cross-Issue dispatch, the target Issue.
   Direct-request rejection rolls back task creation first, then commits this
   notice and audit in a separate transaction. Mention refusal records them in
   the comment's dispatch transaction. No schema migration is required.
7. ADR 0013's short doorbell and real result-comment reference remain the
   delivery contract. Cross-Issue doorbells name the delegate's Issue with the
   ADR 0013 `来源：<KEY>` line immediately after `Status:` (the result-comment
   line already carries the Issue id); same-Issue doorbells omit it. Return destination,
   once-only coverage, successor handling and cancelled-summary behavior remain
   owned by the existing terminal/return machinery. System envelopes do not
   parse their body as agent dispatch.

## Consequences

An agent assigned by a human can subsequently delegate work and receive one
return. Task-linked rich mentions now request work regardless of squad roles;
the daemon prompt explains that behavior, while Chat topic dispatch retains its
existing relay reporting. The server behavior takes effect independently of
daemon CLI upgrades. Chat return support and the later request/reply message
model belong to MUL-493.

Implementation: [resolver](../../packages/server/src/store/repos/issues-repo.ts),
[counter, refusal audit and doorbell](../../packages/server/src/store/repos/tasks-repo.ts),
[Session creation](../../packages/server/src/store/repos/issue-sessions-repo.ts),
[rerun](../../packages/server/src/api/helpers/store-bridge.ts).
Long-term contract cases use SQLite and optional isolated real PostgreSQL in
[universal delegation tests](../../tests/unit/multiremi/multiremi-universal-delegation.test.ts).
Unconfigured PostgreSQL is a skipped check, never a passing backend result.
