# MUL-395: Archive Count Request Marker Lifetime

QA r2 (`cmt_wvtra3o8cp1g`) found that completed grouped requests retained a workspace marker in a module WeakMap. This rework releases the marker when the request ends and preserves the response-ordering guards from r1. Both the status-page and assignee-group writers use the same internal helper.

## Source And Cleanup

- Before: `a58efb085d13029c11af644136fc6a1a42f13266`.
- Tested product source: `de9fa9e809fc2772750b83bca5ebe2b1a6b0fb98`.
- Merged main: `889efdeb2bd68c5b1aca41f059a870d21039f7a7`, without conflicts. No incoming frontend issues changes overlap this fix.
- `finish()` deletes a workspace marker only if it still equals that request's symbol. An empty inner Map also removes the outer QueryClient entry. Repeated cleanup is harmless.
- An older request finishing first cannot delete the newer marker. After the newer request ends, the empty slot is `undefined`, which never equals the older symbol. No predecessor marker is restored.
- Both query functions call `finish()` in `finally`, covering success, failure, schema errors and discarded publications. The helper also attaches both fulfillment and rejection cleanup to TanStack's native `Query.promise`.
- Publication still requires its own current marker, the unchanged count-cache `dataUpdateCount`, and an un-aborted signal. The signal remains lazy and is read only at publication.
- `archive-total-requests.ts` is internal and absent from package exports. Its read-only test inspection returns the marker count and whether the outer client entry exists.

## Promise Lifetime Evidence

The installed `@tanstack/query-core` is **5.101.2**. Its source gives the following behavior:

| Operation | TanStack behavior | Marker cleanup |
| --- | --- | --- |
| Success or failure | queryFn settles | `finally`; native retryer callback is idempotent |
| `cancelQueries` | retryer rejects immediately | Native `Query.promise.then(finish, finish)` |
| `removeQueries` or `clear()` | QueryCache removes the query and calls `destroy()`, which cancels the retryer | Same native termination callback, even with a permanently pending transport |
| Initial observer unmount, lazy signal unread | `removeObserver` calls `cancelRetry()`, allowing the live request to complete and be shared on remount | `finally` when it completes; a later cancel/clear/remove also releases it |

Source locations: `query.ts:199` exposes the retryer promise; `query.ts:253` and `:259` implement cancellation/destruction; `query.ts:362` distinguishes cancel from cancelRetry on observer removal; `retryer.ts:88` rejects on cancel; `queryCache.ts:148` destroys removed queries; `queryClient.ts:632` clears caches. These refer to the installed dependency under `node_modules/@tanstack/query-core/src/`.

The HTTP queryFn promise itself is **not guaranteed to finish** on cancel, clear, remove or initial unmount: the grouped HTTP call does not consume the query cancellation signal. Therefore `finally` alone would not cover an indefinitely pending canceled transport. Native retryer termination handles that case without consuming the lazy signal early.

An unmount alone intentionally leaves an unfinished initial request alive for request sharing. Its marker remains only for that live request, until completion or later cancellation/removal; no finite cleanup deadline is claimed for an indefinitely pending unmount-only HTTP request. Clearing the client releases its marker independently of that HTTP promise. The tests distinguish this live-request state from the completed-request leak QA measured.

## Tests And Mutations

New `archive-total-lifecycle.test.ts`: **22 pass**, exercising both writer types. It covers ws_a -> ws_b -> ws_a, failures and recovery, cancellation, clear/remove with pending transports, unmount then completion, repeated same-key refetch, and both request completion orders. Completed requests leave **0 workspace markers and no outer client entry**. Existing `archive-total-races.test.ts`: **15 pass**, including archive/unarchive WS, optimistic writes and temporary remount request sharing.

QA r1 then r2 probe patches were applied to a locked detached worktree. Their 13 tests plus the 37 repository tests give **50 pass / 0 fail**. The extra SQLite boundary probe gives **3 pass / 0 fail**, 78 assertions. The real HTTP + real WS probe passes: archive count 21 -> 22, late canceled response leaves 22, unarchive returns 21; create/state/assignee changes converge without duplicates. The old CLI probe also succeeds against the new API.

| Temporary mutation | Actual failed assertion | Restored result |
| --- | --- | --- |
| (a) Remove end-of-request deletion | 22 fail. `archive-total-lifecycle.test.ts:46`: expected `{count: 0, hasClient: false}`, received `{count: 1, hasClient: true}` | 22 pass |
| (b) Delete without checking symbol ownership | 2 fail. `:117`: expected active newer marker count 1, received 0 | 2 pass; 20 filtered tests |
| (c) Clean only on success | 4 fail for failure/cancellation. `:46`: expected zero/false, received one/true | Final combined 50 pass |

The mutation changes were restored, and `git diff --exit-code` for the product helper and query file returned 0. QA patches are temporary probe files and are removed before worktree cleanup. No mutation or probe file is committed.

```sh
# From frontend/packages/core:
env -u MULTIREMI_TOKEN bun run test issues/archive-total-lifecycle.test.ts issues/archive-total-races.test.ts --testTimeout 20000
# After applying QA r1 and then r2 patches in a locked detached worktree:
env -u MULTIREMI_TOKEN bun run test issues/mul395-qa.test.ts issues/mul395-r2-qa.test.ts issues/archive-total-lifecycle.test.ts issues/archive-total-races.test.ts --testTimeout 20000
# From that probe checkout:
env -u MULTIREMI_TOKEN -u MULTIREMI_TEST_POSTGRES_URL MUL395_QA_LIVE_RACE=1 bun run tests/manual/mul395-qa-live.ts
```

The supplied QA probe imports legacy modules from a detached checkout at `5f696786d573986858914246f9f66fe0051b2e19`, located at `/tmp/mul395-qa-before-5f696786`. It was recreated at that fixed SHA with a locked worktree; probe assertions were unchanged.

## Browser Comparison

Same machine, local SQLite fixture, Chromium 1440x900 and repository S1 recorder with a fixed real issue row. Next dev routes were compiled before sampling. Primary/deferred API delay: 300/900ms; observation: 3000ms; browser/request timeout: 20000ms. Before is the fixed a58efb08 checkout; after uses the product source above. Three pages, cold/warm, three rounds per phase: **36 samples total**, with at least 171 actual row frames per sample.

**36/36 actual row shift = 0px, recorder jump = 0px, disconnected frames = 0.** Every sample retains Issues / My Issues default / All list request counts **1 / 1 / 3**, and independent archive-count requests **0**. All's three relationship filters remain separate requests.

| Page | Mode | n before/after | List before/after | Archive before/after | All first-screen API before/after | Final row position p50 before/after (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| Issues | Cold | 3 / 3 | 1 / 1 | 0 / 0 | 8 / 8 | 2660.2 / 2791.7 |
| Issues | Warm | 3 / 3 | 1 / 1 | 0 / 0 | 2 / 2 | 1542.3 / 1613.5 |
| My Issues default | Cold | 3 / 3 | 1 / 1 | 0 / 0 | 8 / 8 | 2618.0 / 2618.5 |
| My Issues default | Warm | 3 / 3 | 1 / 1 | 0 / 0 | 13 / 13 | 1619.5 / 1569.3 |
| My Issues All | Cold | 3 / 3 | 3 / 3 | 0 / 0 | 10 / 10 | 2640.4 / 2668.7 |
| My Issues All | Warm | 3 / 3 | 3 / 3 | 0 / 0 | 15 / 15 | 1561.9 / 1648.4 |

This is a local regression comparison. Timing variation is retained; no production latency or improvement claim is made. Raw samples and sanitized request paths are in `MUL-395-archive-marker-before.json` and `MUL-395-archive-marker-after.json`. Existing 404 and temporary unsubscribe/remount guards stay green.

```sh
git worktree add --detach --lock /tmp/mul395-marker-before a58efb085d13029c11af644136fc6a1a42f13266
# In the baseline checkout:
bun install --offline --frozen-lockfile --ignore-scripts --registry https://registry.npmjs.org
# In the issue checkout, with 18560, 18561 and 18572 free:
env -u MULTIREMI_TOKEN -u MULTIREMI_TEST_POSTGRES_URL bun run tests/manual/mul395-archive-count-browser.ts /tmp/mul395-marker-before --lifecycle
# Restore only Next's generated next-env.d.ts import if it changed, then:
git worktree unlock /tmp/mul395-marker-before
git worktree remove /tmp/mul395-marker-before
```

## Local Regression And Hygiene

- Root TypeScript and all four frontend package typechecks: pass.
- Core issues: **165 pass / 0 fail**, 12 files; Issues page: **18 pass / 0 fail**.
- Required status-pages and CLI files on SQLite: **62 pass / 0 fail**, 1503 assertions.
- Architecture: **108 pass / 0 fail**, 11 files, 3937 assertions.
- Development context and docs checks: pass; docs checker tests: **13 pass**.
- Backend/Bun tests clear MULTIREMI_TOKEN; Bun/Vitest timeouts stay 20000ms. No local PG instance is started for this rework.
- Exact pushed-head full regressions and frontend-zero-jump run in CI. Head, tree ID and CI links are recorded in the delivery comment.
- Browser, fixture and Next processes are owned by this runner and stopped in its `finally`. Ports 18560, 18561 and 18572 are confirmed released. Credentials, browser storage, trace and HAR are absent from measurement artifacts.
- Only this task's three locked detached worktrees are unlocked and removed. PR #331 stays Draft; no merge, Ready transition, production access or release operation occurs.
