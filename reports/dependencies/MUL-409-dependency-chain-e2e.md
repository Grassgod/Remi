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

## Result

`PASS` — 33 steps, 0 failures, on PostgreSQL 18.4 (2026-09-27).

Two product defects were found by this run and fixed before it passed:

1. `listPrerequisites` read only the `blocked_by` spelling and reported the
   dependent as its own prerequisite for legacy `blocks` rows; the gate never
   opened for the chain. Fixed to resolve both spellings and report the correct
   pair.
2. `child-progress` counted `waiting` children as `active` as well, so a parked
   child looked like work in flight. The buckets are now disjoint.
