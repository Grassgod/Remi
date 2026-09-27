# MUL-409 — dependency chain end to end on real PostgreSQL

Acceptance 2 of MUL-400 E3: *build one parent and three serially dependent
children, dispatch only the first, let the whole chain finish by itself, and
check that the parent cannot reach `in_review` before the last child is done.*

## What runs

- **Real server code**: `MultiremiStore` over `PostgresSyncDatabase` (the
  production Postgres bridge) plus the real HTTP app from
  `createMultiremiApp`. Creation, status writes and the page reads all go
  through the routes, not through the store in isolation.
- **Real PostgreSQL**: a throwaway database on a local PostgreSQL 18.4 server,
  dropped after the run. No SQLite fallback.
- **Test doubles**: the execution agent and the worker only. The platform never
  runs a provider here; a "round" is driven by walking the task the platform
  itself queued through `claimTask` → `startTask` → `completeTask`, which is the
  state machine a daemon drives.

Script: [`MUL-409-dependency-chain-e2e.ts`](MUL-409-dependency-chain-e2e.ts).
Raw output: [`MUL-409-dependency-chain-e2e.json`](MUL-409-dependency-chain-e2e.json).

```bash
MULTIREMI_TEST_POSTGRES_URL=postgres://<user>@127.0.0.1:5432/postgres \
  bun run reports/dependencies/MUL-409-dependency-chain-e2e.ts
```

## What it asserts

| Step | Expectation |
| --- | --- |
| Create the chain | Parent plus `C1`; `C2` declares `blocked_by C1`, `C3` declares `blocked_by C2`; all three created with `status: todo` |
| Creation gate | `C1` is `todo` and dispatched; `C2`/`C3` park at `backlog` and report `dispatch_skipped_reason: dependencies_unmet` |
| Dispatch gate | Only `C1` owns a task |
| Waiting page data | `child-progress` reports `waiting: 2`, `active: 1`; `C3`'s detail lists its unmet prerequisite; each child row carries its `blocked_by` key |
| Parent hold | `PATCH {status: in_review}` on the parent answers 409 while children are open |
| Auto start | `C1` reaching `done` starts `C2` by itself (`dependency_auto_started`); `C3` stays `backlog` until `C2` is done |
| Parent stays open | The parent remains `in_progress` through every child round |
| Last child | Only after `C3` is done does the parent accept `in_review` (200) |
| Idempotency | Replaying `done → in_review → done` on `C1` creates no second round and leaves the dependent `done` |
| Forced start (MUL-409 fix) | A member `PATCH {status: todo, force: true}` on a parked child leaves exactly one round, keeps the dependency row, and records `dependency_force_started`; the prerequisite finishing later adds no second round |
| Creation rollback (MUL-409 fix) | Depending on an ancestor answers 409 `dependency_on_ancestor` with no orphan issue, no child row and no consumed issue number; a successful creation with a prerequisite stays a single transaction (`maxTransactionDepth === 1`) |
| Readiness report (MUL-409 fix) | A shared-parent dependent becoming ready adds no extra round; the line is merged into the prerequisite's report, which names both issues, and the dependent records the merge flag |
| Forged exemptions (MUL-409 fix round 3) | `attempt`, `preserveIssueStatus` and `preserve_issue_status` supplied in a task-create body are all refused with 409 `dependencies_unmet` and create no round |
| Batch force (MUL-409 fix round 3) | A batch update carrying `force` leaves a waiting issue parked, creates no round and writes no override record |
| Task-creation gate (MUL-409 fix round 2) | Rerun and task create on a waiting issue both answer 409 `dependencies_unmet` and leave no round; an assign carrying a body `force` still parks the issue and writes no override record; the member `PATCH {status: todo, force: true}` dispatches exactly one round and records `dependency_force_started` exactly once; a comment still lands; the prerequisite finishing later adds no second round |

## Result

`PASS` — 33 steps, 0 failures, on PostgreSQL 18.4 (2026-09-27).

Defects this run has found and driven to a fix:

1. `listPrerequisites` read only the `blocked_by` spelling and reported the
   dependent as its own prerequisite for legacy `blocks` rows; the gate never
   opened for the chain. Fixed to resolve both spellings and report the correct
   pair — including `issueId`, which QA caught still naming the prerequisite.
2. `child-progress` counted `waiting` children as `active` as well, so a parked
   child looked like work in flight. The buckets are now disjoint.
3. A member forced start only moved the status: the issue landed in `todo` with
   no queued round, and neither the gate nor the automatic start would look at
   it again. The override now dispatches through `assignIssue`, and the gate
   only holds issues that are actually waiting (`backlog` + unmet prerequisite).
4. A rejected `blocked_by` left an orphan issue behind, because creation ran
   outside a transaction. Creation is now one transaction on both backends, and
   the Postgres bridge reports the nesting depth so the assertion is explicit.
5. Two prerequisites finishing concurrently on separate Postgres connections
   each queued a round, because both readers saw the dependent as `backlog`. The
   automatic start now claims the transition with a conditional
   `UPDATE ... WHERE status = 'backlog'`, so exactly one contender dispatches;
   the same claim arbitrates a forced start racing the automatic one.
6. A task-create body could forge a structural exemption (`attempt: 2`,
   `preserveIssueStatus: true`), and the batch routes could carry `force` across
   the dependency gate. The public task route now strips those fields, and the
   batch routes move `force` into a server-internal option that only the
   parent-status guard reads.
