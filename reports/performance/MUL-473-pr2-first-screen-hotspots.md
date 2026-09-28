# MUL-473 PR2: inbox, attachment content and runtimes

Baseline: main `58bf5cc067811d15bef254a6cb48e32452c0b33f`, merged in `33b65788` after initially fast-forwarding from `c7be1916` to `7bd32800`. Product implementation: `dd4f2fc56c7384fafb946ed22186828321891c3c`. PR: https://github.com/Grassgod/Remi/pull/310 (Draft, target main, title MUL-473).

The final pre-push fetch also found main `0c2b3865` (MUL-449); it was merged without conflicts in `bb1fd15a`. Its task-claim and private-temp changes do not edit these three route implementations. The baseline replay commands below remain pinned to the actual pre-PR2 capture version. Performance samples were taken at `ae88ac9b`; final directed and whole-suite regression also run after the `0c2b3865` merge.

## Scope and recovered work

The resumed checkout was on `agent/MUL-473`, with no unpushed PR2 commits. Its ahead commits were already part of main; c/d/f were uncommitted. `stash@{0}` had already been applied cleanly by the interrupted run and remains retained. It was not applied a second time. The initial merge to `c7be1916` and the merge to `7bd32800` were fast-forwards, with no conflicts. The inbox summary body was unchanged between the stash base and the post-MUL-409 main. `inbox-routing.ts`, `messaging-repo.ts`, and their transaction behavior were inspected without replacing their post-409 changes. Both subsequent main merges (`58bf5cc0`, including MUL-451/458/474, then `0c2b3865`) also had no conflicts. The auto-merged `context.ts`, `store.ts`, and `issues-repo.ts` retain both sides; the task-message subject and token throttling are unchanged from main.

- c: `issues-repo.ts` changes only the `getInboxSummary` body, current lines **5263-5320** (method 5253-5323). No shared helper, `listIssues`, visibility construction, or `api/helpers/issues.ts` change. A window function retains the newest row per issue/ledger selection; `COUNT(DISTINCT ...)` counts unread and attention across all unarchived rows. Only `autopilot_run_completed` reads `details`; the existing date-group helper and unread OR grouping are retained.
- d: `/api/attachments/:id/content` finishes bearer authentication and `denyAttachmentAccess` before calling the file helper. An id ETag, `private, max-age=31536000, immutable`, and bodyless 304 are added. Content bytes stream through `Bun.file`. Content-Disposition stays `attachment`. Other helper callers retain their existing no-store headers and do not gain conditional responses.
- f: `listRuntimesForWorkspace` pushes `COALESCE(workspace_id, 'local')` into SQL. Usage, execution-group membership, and models each use **one workspace-scoped query**, without id-list bind limits. Usage is accumulated with the existing `addTaskUsage` parser. Single-runtime reads keep their existing PostgreSQL settled-usage cache. Workspace lists read scoped task usage once per request, so their query count remains flat; their usage payload still depends on workspace task history.
- g: not implemented. These lower-priority routes would require additional response, authorization, and scale goldens; this PR delivers the three required hotspots and the PR1 guard improvements.
- e: excluded. `git diff origin/main -- packages/server/src/store/repos/access-tokens-repo.ts` is empty. The recovered e implementation, tests, and benchmark cases are absent from the PR. The retained historical stash is not part of the PR.

## Attachment immutability and authorization

All on-disk upload writers were checked: `attachments.ts` task upload (lines 59-63), ordinary upload (142-148), and daemon inbound upload (`daemon.ts` 705-709). Each mints a fresh `createUploadAttachmentId()` before writing. Task and daemon uploads use `wx`; ordinary uploads write a newly minted path. Chat send attaches existing bytes rather than overwriting a file. `UPDATE multiremi_attachments` in issue/chat/Feishu repositories and migrations changes parent links/workspace association, not file bytes or filenames. There is no upload path that overwrites bytes under an existing id; the id is therefore the content version.

The private-chat regression uses a valid member credential with the correct ETag for someone else's attachment. The baseline and optimized route both return **403**, body `{"error":"not your chat session"}`, without an ETag. Unsigned requests with a correct validator return 401. Authorized exact, weak, list, and wildcard validators return 304 with an empty body and no Content-Length; a stale validator returns the original bytes. Unknown attachments and missing files retain their 404 errors.

Cacheable content responses also carry `Vary: Authorization, Cookie` on 200 and 304, separating bearer and login-cookie cache entries. `private` alone only forbids shared caching; the nominated request fields supply the cache-key distinction ([RFC 9111 section 4.1](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.1)). Other helper callers retain no-store and do not gain this header.

## Golden replay

Fixture: 50 sessions, 20 agents, 300 inbox rows plus 6 explicit sentinels, 20 local and 30 foreign runtimes. Sentinels include archived attention, an old unread item, read/unread completed runs spanning date groups, and malformed details. The wire golden includes four timezone offsets (0/480/-300/840), raw JSON response strings, attachment bytes and pre-existing content headers, private/unsigned errors, runtime order and owner filter, and legacy per-runtime hydration. Only ISO timestamps are replaced by `<timestamp>`; ids and ordering remain stable. The newly specified ETag/cache headers and 304 behavior are separately asserted, since the baseline does not have them.

Run these commands from the PR checkout. The same unmodified capture script runs against **baseline product code** and PR product code; no legacy implementation is injected into the routes and no output is edited afterward.

```bash
MUL473_REPO="$PWD"
MUL473_REPLAY="$(mktemp -d /tmp/mul473-pr2-replay.XXXXXX)"
git worktree add --detach --lock "$MUL473_REPLAY/base" 58bf5cc067811d15bef254a6cb48e32452c0b33f
ln -s "$MUL473_REPO/node_modules" "$MUL473_REPLAY/base/node_modules"
cp tests/fixtures/multiremi/first-screen-hotspots-database.ts \
   tests/fixtures/multiremi/first-screen-hotspots-pr2-fixture.ts \
   tests/fixtures/multiremi/capture-first-screen-hotspots-pr2-golden.ts \
   "$MUL473_REPLAY/base/tests/fixtures/multiremi/"
cd "$MUL473_REPLAY/base"
env -u MULTIREMI_TEST_POSTGRES_URL bun run --preload ./tests/setup/hermetic-env.ts \
  tests/fixtures/multiremi/capture-first-screen-hotspots-pr2-golden.ts --out "$MUL473_REPLAY/before.json"
cd "$MUL473_REPO"
env -u MULTIREMI_TEST_POSTGRES_URL bun run --preload ./tests/setup/hermetic-env.ts \
  tests/fixtures/multiremi/capture-first-screen-hotspots-pr2-golden.ts --out "$MUL473_REPLAY/after.json"
cmp "$MUL473_REPLAY/before.json" tests/fixtures/multiremi/first-screen-hotspots-pr2-golden.json
cmp "$MUL473_REPLAY/after.json" tests/fixtures/multiremi/first-screen-hotspots-pr2-golden.json
env -u MULTIREMI_TEST_POSTGRES_URL bun run --preload ./tests/setup/hermetic-env.ts \
  tests/fixtures/multiremi/capture-first-screen-hotspots-pr2-golden.ts --dbq --out "$MUL473_REPLAY/dbq.json"
cmp "$MUL473_REPLAY/dbq.json" tests/fixtures/multiremi/first-screen-hotspots-pr2-dbq-golden.json
sha256sum "$MUL473_REPLAY/before.json" "$MUL473_REPLAY/after.json" "$MUL473_REPLAY/dbq.json"
git worktree unlock "$MUL473_REPLAY/base"
git worktree remove --force "$MUL473_REPLAY/base"
```

Observed: all three `cmp` commands exit **0**.

| File | SHA-256 (capture and committed file identical) |
|---|---|
| response golden | `43682d067ebe74bc7cd1d4b9376e299abf585a69ae73b09e1855c39991a6641e` |
| dbq golden | `4245fc7e24508f44f765e46b574c6a368dc73110800b73ba6022390c4462df2a` |

The database helper uses in-memory SQLite when `MULTIREMI_TEST_POSTGRES_URL` is absent. When set, it creates a fresh real PostgreSQL database, preserves the driver dialect/type through instrumentation, and always drops the scratch database. Explicit PG failures never fall back to SQLite. Test/capture output does not include credentials or connection strings.

| Inbox rows | Local / foreign runtimes | Summary dbq | Content dbq | Runtimes dbq |
|---:|---:|---:|---:|---:|
| 306 | 1 / 1 | 7 | 3 | 6 |
| 606 | 20 / 30 | 7 | 3 | 6 |
| 906 | 60 / 100 | 7 | 3 | 6 |

These same query counts match on SQLite and real PG. Each runtime scale also asserts one usage, one execution-group, and one model read. Goldens check both the HTTP responses and legacy per-runtime hydration; a task usage update is immediately reflected by the new list.

The capture issues summary first with a fresh credential, then content and runtimes. Main's MUL-474 throttle removes a subsequent `last_used_at` write, so those counts changed from 4/7 to 3/6 after merging main. The response golden differs from the original `7bd32800` capture only in its generated `source` label. The runtime growth test primes authentication once before both measurements, so both use the same warm state; its equality assertion is unchanged. No e implementation or throttle test was added by this PR.

## PR1 guard changes

`mem_`/`agt_`: **<=8 -> <=7** at 1/60/300 issues. Untyped refs (user id, usr_-shaped agent name, ordinary agent name) now run at **1/60/300**, retaining **<=9**. Empty ref remains **<=8**. Each hit has a nonempty page at every scale, with exactly N issues: the first existing issue is reassigned for each measurement rather than adding an N+1th issue. No resolver behavior changed.

## Mutations (never committed)

Each mutation was followed immediately by restoration. After each restoration, `git diff --exit-code -- packages/server/src` exited **0**.

- c, replace full unarchived aggregation with the newest 50 rows: wire golden fails, expected `{"unread":79,"attention":76}`, received `{"unread":26,"attention":20}` (UTC). The earlier archive-predicate mutation also failed: expected 79/76, received 80/77.
- d, compare ETag before `denyAttachmentAccess`: the submitted private attachment test fails `expect(received).toEqual(expected)`, expected status **403** and `{"error":"not your chat session"}`, received status **304** and empty body.
- f, remove workspace predicate (keep a dummy bind to test semantics rather than a binding error): wire golden fails `expect(received).toBe(expected)`, with foreign runtime ids added to the raw response. Query count stays constant, but the response golden detects the leaked rows.

## Performance measurements

Same fixture and unchanged `tests/manual/bench-first-screen-hotspots-pr2.ts` on main `58bf5cc0` and the PR. In-process `app.request`, serial requests, 5 warmups and 20 samples, nearest-rank p50/p95. 50 sessions / 20 agents / 306 inbox rows / 20 local + 30 foreign runtimes; content file is 262144 bytes. PG is an independent local PostgreSQL 18.4 instance. Database time includes synchronous bridge/parse wall time, not EXPLAIN execution time. Bytes are UTF-8 `JSON.stringify({rows,count})` for nonempty row replies; empty reply overhead is excluded consistently. These are fixture measurements, not a production latency claim. The final before/after reports were recaptured after the main merge so that main's token throttling affects both sides equally.

```bash
bun run --preload ./tests/setup/hermetic-env.ts tests/manual/bench-first-screen-hotspots-pr2.ts --out <report.json>
```

Run without the PG input for SQLite; run with the test PG input supplied only in the process environment for PG. For baseline, copy the benchmark and the three fixture dependencies above into the baseline checkout. The conditional request sends the same id validator on both versions: baseline returns 200, PR returns 304.

| SQLite route | dbq before -> after | db bytes before -> after | db p50 ms before -> after | Response bytes before -> after |
|---|---:|---:|---:|---:|
| inbox summary | 5 -> 6 | 55292 -> 10080 | 0.371 -> 0.955 | 28 -> 28 |
| attachment cold | 3 -> 3 | 1566 -> 1566 | 0.054 -> 0.049 | 262144 -> 262144 |
| attachment conditional | 3 -> 3 | 1566 -> 1566 | 0.052 -> 0.034 | 262144 -> 0 |
| runtimes | 153 -> 6 | 55148 -> 27728 | 0.719 -> 0.275 | 9875 -> 9875 |

| PostgreSQL route | dbq before -> after | db bytes before -> after | db p50 ms before -> after | Response bytes before -> after | total p95 ms before -> after |
|---|---:|---:|---:|---:|---:|
| inbox summary | 5 -> 6 | 55292 -> 10084 | 3.346 -> 3.422 | 28 -> 28 | 6.844 -> 6.616 |
| attachment cold | 3 -> 3 | 1566 -> 1566 | 1.267 -> 1.209 | 262144 -> 262144 | 4.927 -> 4.493 |
| attachment conditional | 3 -> 3 | 1566 -> 1566 | 1.492 -> 1.119 | 262144 -> 0 | 5.156 -> 3.464 |
| runtimes | 153 -> 6 | 59968 -> 27728 | 63.379 -> 3.625 | 9875 -> 9875 | 75.869 -> 6.375 |

The small inbox fixture's db time is slightly higher after the extra aggregate query, while payload falls by about 82%; it meets dbb <100KB and total <30ms. The 906-row query golden and larger inbox payload guard also remain below 100KB. Runtimes fall from 153 statements to 6. Conditional attachment requests keep the full authorization cost (3 warm queries) while eliminating content transfer. Browser immutable-cache hits need no request, which this app.request harness does not simulate.

Raw reports: `MUL-473-pr2-{before,after}-{sqlite,postgres}.json` in this directory.

## Validation evidence

On the final main merge: directed SQLite **26 pass / 0 fail**; directed real PG **26 pass / 0 fail**; arch **92 pass / 0 fail**; TypeScript exit 0; docs:test **13 pass / 0 fail**; docs:check passed; capabilities **677 mapped / 92 exempt / 0 missing, 769 routes**; route snapshot matched. The serial whole-suite totals and final exact-head CI are published in the PR/issue delivery comments.

Full regression commands (supply the PG input privately in the process environment, never on disk):

```bash
env -u MULTIREMI_TOKEN bun test tests/unit/multiremi/ --timeout 20000
env -u MULTIREMI_TOKEN -u MULTIREMI_TEST_POSTGRES_URL bun test tests/unit/multiremi/ --timeout 20000
```

Run PG first and SQLite only after PG finishes. The directed run uses the same flags with `first-screen-hotspots-{query-count,pr2-golden,auth-runtimes,inbox-attachments}.test.ts` instead of the whole directory.

Load diagnosis: the PR1 1/50/200 chat count test once took 21.3s under a 20s limit; isolated PR rerun passed in 15.5s, while the same PG fixture on pure main hit the limit at 24.2s. The new three-scale golden also took about 20.5s, and its pure-main fixture took 20.7s. It is now three independent scale tests, retaining the same count and flat-growth assertions without raising the 20s per-test timeout; PG ran all six golden tests in 36s with zero failures.

Environment diagnosis: the initial PG full run inherited the task's `MULTIREMI_TOKEN`; the unrelated MUL-409 two-connection Worker test returned `unexpected force response 401`. The same isolated test also failed on pure main `7bd32800`. Starting Bun with a clean environment made both versions pass. Final PG runs unset `MULTIREMI_TOKEN` before Bun starts, as requested; product code and the race test were not changed to hide this failure.

CI diagnosis: the first implementation commit ran these now-PG-capable fixtures under CI's default 5s timeout, causing timeouts and subsequent bridge errors. The directed cases now explicitly use 20s, the same effective budget as the required local regression command. Assertions and fixture sizes are unchanged, and no workflow configuration was edited.
