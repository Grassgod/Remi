# MUL-395: Inline Archive Count Response Ordering

This fixes the blocking race reported in `cmt_zc35e10dvlqs`: a canceled grouped response could publish an old `archived_total` after a newer archive WS refetch. Both status-page and assignee-group queries now guard this cross-key write. List parameters, bucket reconciliation, later-page pagination and API-client 404 fallback are unchanged.

## Source And Ordering

- Before: `e13655427bce8d0cb0420757b3d4516abab5606b`.
- Tested product source: `b4954b18ffbd3a48be1648602459255d9d0b79ab`.
- Merged main: `01810898c7df0374d3784b8791a8f1ed72002b09`, including MUL-405, MUL-463 and MUL-478. The merge had no conflicts. Metrics auto-merges add process IDs; static status-pages routing remains intact.
- Each QueryClient/workspace has a latest request marker shared by status and assignee queries. Only that request may publish the count. This orders different filter keys without using wall-clock timestamps.
- Publication also checks cancellation and the count query's `dataUpdateCount` captured before the request. A subsequent optimistic restore or rollback write takes precedence, including writes in the same millisecond.
- The cancellation signal is read only when publishing. Consuming it at request start changes TanStack's cancellation policy for temporary observer removal and caused a second StrictMode request in a discarded trial. The final code and dedicated observer-removal tests preserve request sharing.
- A failed or canceled newest request does not authorize an older response to publish. The existing count remains until a later valid request or mutation updates it.

## Red/Green Evidence

The exact final test file was added to a locked detached worktree at the before SHA, keeping its query implementation unchanged. It produced **10 failed / 5 passed**. On the repaired source all **15 passed**.

| Case | Before | After |
| --- | --- | --- |
| Canceled old response after newer archive WS refetch, both writers | 2 fail: Expected 1 / Received 0 | 2 pass |
| Uncanceled out-of-order requests across different keys, all four writer combinations | 4 fail: Expected 1 / Received 0 | 4 pass |
| Explicit cancellation without a replacement request, both writers | 2 fail: Expected 1 / Received 0 | 2 pass |
| New optimistic count while a response is pending, both writers | 2 fail: Expected 0 / Received 1 | 2 pass |
| Normal opt-in count, archive and unarchive WS, both writers | 2 pass | 2 pass |
| Temporary observer removal retains one initial request, both writers | 2 pass | 2 pass |
| QueryClient/workspace isolation | 1 pass | 1 pass |

The QA schedule fails at `archive-total-races.test.ts:103`; the uncanceled schedule fails at `:123`. Both execute real QueryClient/QueryObserver query functions; uncanceled old queries finish successfully while their obsolete count writes are discarded.

```sh
# Run from frontend/packages/core.
env -u MULTIREMI_TOKEN bun run test issues/archive-total-races.test.ts --testTimeout 20000
env -u MULTIREMI_TOKEN bun run test issues/*.test.* --testTimeout 20000
```

## Browser Evidence

Same machine, same in-memory SQLite backend fixture, Next dev with routes compiled before measurement, 1440x900 viewport. Each context is fresh; warm samples enter through inbox and use in-app navigation. The existing repository S1 recorder and fixed visible issue row (`iss_pin_me`) are observed for 3000ms. Primary API delay is 300ms; deferred shell delay is 900ms. All browser/request timeouts remain 20000ms. This is a local regression check, not production latency or a p95 claim.

| Issues | Before n | After n | Row shift before/after | Recorder jump before/after | List requests before/after | Archive requests before/after | Final position p50 before/after (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Cold | 3 | 3 | 0 / 0 px | 0 / 0 px | 1 / 1 | 0 / 0 | 2694.4 / 2798.6 |
| Warm | 3 | 3 | 0 / 0 px | 0 / 0 px | 1 / 1 | 0 / 0 | 1594.4 / 1542.8 |

All 12 samples have zero disconnected/hidden frames. Total first-screen API requests remain cold 8 / 8 and warm 2 / 2. Timing variation is retained; this change makes no speed improvement claim. Raw frames and request paths are in `MUL-395-archive-count-before.json` and `MUL-395-archive-count-after.json`.

```sh
git worktree add --detach --lock /tmp/mul395-count-before e13655427bce8d0cb0420757b3d4516abab5606b
# In the detached worktree, install the fixed lockfile from the public registry.
bun install --offline --frozen-lockfile --ignore-scripts --registry https://registry.npmjs.org
# From the issue checkout; ports 18560, 18561 and 18572 must be free.
env -u MULTIREMI_TOKEN -u MULTIREMI_TEST_POSTGRES_URL bun run tests/manual/mul395-archive-count-browser.ts /tmp/mul395-count-before
git worktree unlock /tmp/mul395-count-before
git worktree remove /tmp/mul395-count-before
```

Next dev can regenerate `next-env.d.ts`; restore only that generated change before removing the detached worktree. The fixture authentication marker is random and held only in process memory. No browser auth state, trace or HAR is saved. The runner stops only the processes it starts.

## Local Validation

- Root TypeScript and all four frontend package typechecks: pass.
- Issues core: 143 pass across 11 files, including existing request counts and 404 fallback.
- Issues page: 18 pass.
- Required backend status-pages and CLI files: 62 pass on SQLite. With additional metrics and lock-order files: 88 pass / 13 PG-only skips / 0 fail; no local PG was started.
- Architecture: 108 pass. Development context validation: pass. Docs checker tests: 13 pass.
- No changes to CLI capability registration or API routes in this fix. Full regressions and frontend-zero-jump are checked on the final pushed SHA in CI; exact run links are recorded in the delivery comment.

PR #331 remains Draft. No merge, Ready transition, production access or release operation is performed.
