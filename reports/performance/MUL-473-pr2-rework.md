# MUL-473 PR2 rework: immutable upload objects and runtime ties

PR: https://github.com/Grassgod/Remi/pull/310 (Draft, main, title `MUL-473`).
QA baseline: `25e613dc41761102742825880809af3dbe56cd82`, rejection `cmt_7ek38b3tgtit`.
Main merged: `60c057be78e30e845d4a8f9c66c143e8dedf7125`, merge `417bcac8`, no conflicts.
Product rework: `f71f94554ca1787accfa6485f31738f463a6dd10`.

The confirmed summary semantics, content authorization/cache behavior, runtime batch hydration, workspace predicate and PR1 query budgets are unchanged. No access-token-repository diff against main; e remains owned by its separate change. Untyped assignee lookup executes Agent -> Member -> Squad, then checks the combined matches for ambiguity, with the accepted <=9 budget. Typed member/agent <=7 and empty-result <=8 guards remain intact.

## R1: exclusive writes and owned cleanup

The previous delivery's "no overwrite path" conclusion was wrong. At the QA baseline ordinary uploads called non-exclusive `writeFile` before INSERT. A colliding generated id could replace old bytes even when the attachment primary key subsequently rejected the new row. Task and daemon uploads already used `wx`, but recorded a cleanup path before exclusive creation, allowing an EEXIST failure to unlink an original file. The original performance report now explicitly corrects this finding.

All three writers call `persistUploadedAttachments` (`api/helpers/uploads.ts:20`):

| Writer | Call site | Existing row transaction |
|---|---|---|
| Current Chat task | `api/routers/attachments.ts:55` | `sendChatAttachments`: whole batch, assistant message and outbox remain atomic |
| Ordinary upload | `api/routers/attachments.ts:133` | `createAttachment`: one INSERT |
| Daemon inbound upload | `api/routers/daemon.ts:704` | `createFeishuBotInboundAttachment`: attachment and inbound scope remain atomic |

The helper opens each file with `wx`, records ownership only after successful exclusive creation, writes and closes it, then calls the row-insertion callback. Chat file buffers are read sequentially, not all copied simultaneously. On failure it removes only files created by this attempt. EEXIST and the SQLite/PostgreSQL attachment primary-key errors regenerate ids and retry the batch, at most three total attempts. Other INSERT errors clean up once without retrying. Exhaustion returns the explicit error `attachment id collision after 3 upload attempts`. Cleanup failures other than ENOENT are not silently ignored.

`tests/arch/attachment-upload-writers.test.ts` scans every server source file for upload paths combined with filesystem writers, including imported aliases and `Bun.write`; only the unified helper is allowed. It also requires `wx` and calls from both routers. This is a source guard against ordinary bypasses, not a proof against arbitrary dynamically constructed code.

### Deletion and id validation

`IssuesRepo.deleteAttachment` (`store/repos/issues-repo.ts:5614`) hard-deletes the row. The DELETE route (`api/routers/attachments.ts:192-196`) unlinks the corresponding local file; no deleted-id tombstone exists. New locally uploaded ids therefore use the complete UUID with hyphens removed: `att_` plus 32 hexadecimal characters instead of 12. Existing ids, rows, URLs and ETags are not rewritten. Legacy 12-character upload ids are no longer generated, including after deletion. This uses the requested full-UUID allocation policy, not a permanent tombstone scheme or a content hash.

No validator was loosened. Audit:

| Surface | Existing acceptance |
|---|---|
| Attachment, shared-attachment and daemon routes | Hono `:id` / `:attachmentId`, passed to exact TEXT-id lookup; no fixed-length regex |
| Server upload paths and wire serializers | String concatenation/path construction; no id-length bound |
| CLI `commands/collaboration.ts` and `multiremi/commands/attachment.ts:23` | Opaque nonempty positional string, URL encoded; no length/prefix restriction |
| Frontend `api/schemas/attachments.ts:10`, `api/schemas/primitives.ts:49`, shared attachment schema | `z.string()`, no fixed-length validation |
| Frontend endpoints, paths and preview route | String/encoded dynamic id, no fixed-length route constraint |
| Contracts `types.ts:3031/3074` | `id: string` / `id?: string` |
| Contracts `attachments.ts:1` | `att_[A-Za-z0-9_]+`, accepts old and full UUID ids |
| Store/migrations | TEXT primary key and parameterized lookup; attachment URL extraction uses the same contracts parser |
| Worker client/download/materialization | Opaque string and URL encoding; no fixed-length validation |

The global API route snapshot is regenerated with its unchanged sampler; exactly six id/URL values in the normal upload response grow to 32 hex characters. No route or scrubber is added or relaxed.

### Formal tests and mutations

`attachment-upload-immutability.test.ts` contains 12 tests and selects real PG when configured, otherwise SQLite. It reuses the QA collision pattern through all three actual upload routes. Each route covers preexisting-file EEXIST and a different-suffix upload that reaches a real backend primary-key INSERT collision. Successful retries preserve original bytes, row and ETag, return a different full UUID id, and leave exactly the original files plus the new object. Further tests cover both collision types exhausting three attempts, a real non-primary-key NOT NULL INSERT failure with no retry, whole Chat-batch rollback/cleanup, old/new URL extraction, and hard deletion followed by a UUID sharing the old id's 12-character prefix.

Initial combined PG and SQLite directed runs: 18 pass / 0 fail (upload cases plus existing shape/dbq/auth and the new tied-runtime test). The additional legacy-delete case passed on real PG; the completed 12-case upload file passed on SQLite. Final-head full regression and CI results are recorded in the delivery comment rather than borrowed from the old head.

Temporary mutations on real PG, each immediately restored; `git diff --exit-code -- packages/server/src` returned 0 after every restore:

```text
Remove wx (open with w):
  (fail) ordinary upload retries a file collision without changing old bytes or leaving files
  error: the original attachment file must survive
  Expected: true
  Received: false
  0 pass / 1 fail

Remove failed-attempt cleanup:
  (fail) cleans a real non-collision INSERT failure without retrying or deleting preexisting bytes
  expect(diskFiles()).toEqual(filesBefore)
  Received: original files plus one orphan attachment PDF
  Expected: original files only
  0 pass / 1 fail
```

## R2: explicit ties on both list queries

Both runtime-array queries in `runtimes-repo.ts` use `ORDER BY runtime.updated_at DESC, runtime.id DESC`:

- `listRuntimes`, SQL at line 535, old per-runtime hydration path.
- `listRuntimesForWorkspace`, SQL at line 556, scoped batch path.

Other runtime-table reads are single-object selection, counts, migration/maintenance inputs, daemon-id inventories or nested membership queries, not the public runtime-array list contract; their selection rules are not changed.

The new formal case in `first-screen-hotspots-pr2-golden.test.ts` creates 10 local and 50 foreign runtimes with the same timestamp. Both store lists and the HTTP scoped list must follow id DESC; the latter contains no foreign rows and still performs six warm statements. Local order is exactly the former PG QA order: `rt_pr2_9` through `rt_pr2_1`, then `rt_hotspot`.

Old SQL had no tie-break rule. SQLite's prior tied order is intentionally allowed to change to this explicit rule. Non-tied input still matches the untouched wire golden byte for byte.

```text
Remove id DESC from only the workspace query, real PG:
  (fail) orders equal-timestamp runtimes by id DESC on both list paths, excluding foreign rows
  expect(listRuntimesForWorkspace("local").map(runtime => runtime.id)).toEqual(expected)
  Expected: rt_pr2_9, rt_pr2_8, ..., rt_pr2_1, rt_hotspot
  Received: rt_hotspot, rt_pr2_1, ..., rt_pr2_8, rt_pr2_9
  0 pass / 1 fail
```

A separate mutation removing the tie-break from the old list also fails its full-list descending-id assertion. Both mutations were restored, with source diff exit 0.

## Same-method PG rework comparison

These are **rework-before `25e613dc` versus rework-after `f71f9455`**, not new main-versus-PR optimization claims. Both use the identical existing benchmark, 5 warmups/20 serial samples, Bun 1.3.14, PG 18.4, 50 sessions/20 agents/306 inbox rows/20 local+30 foreign runtimes/262144-byte content. The same isolated test PG disables fsync, synchronous_commit and full_page_writes to reduce concurrent-host fixture setup load; these timings do not characterize default durable PG or production.

| Route | dbq before -> after | DB bytes | Response bytes | DB p50 ms | Total p95 ms |
|---|---|---|---|---|---|
| summary | 6 -> 6 | 10084 -> 10084 | 28 -> 28 | 3.737 -> 3.031 | 5.660 -> 5.862 |
| content, no validator | 3 -> 3 | 1566 -> 1566 | 262144 -> 262144 | 1.625 -> 1.303 | 4.677 -> 4.608 |
| content, matching validator | 3 -> 3 | 1566 -> 1566 | 0 -> 0 | 1.310 -> 1.119 | 4.581 -> 3.086 |
| runtimes | 6 -> 6 | 27728 -> 27728 | 9875 -> 9875 | 3.562 -> 3.039 | 6.410 -> 5.955 |

Raw files: `MUL-473-pr2-rework-before-postgres.json` and `MUL-473-pr2-rework-after-postgres.json`. The benchmark does not freeze generated user ids or wall-clock timestamps, so runtime raw-body hashes are not an equivalence gate. The deterministic wire capture is the byte-for-byte gate and remains unchanged. Other three benchmark response hashes match. Query counts, reply bytes and response sizes match for all four routes; small timing differences are local-load observations only.

Reproduce from the selected revision with PG supplied privately in the process environment:

```bash
env -u MULTIREMI_TOKEN bun run --preload ./tests/setup/hermetic-env.ts \
  tests/manual/bench-first-screen-hotspots-pr2.ts --out <report.json>
env -u MULTIREMI_TOKEN bun run --preload ./tests/setup/hermetic-env.ts \
  tests/fixtures/multiremi/capture-first-screen-hotspots-pr2-golden.ts --out <response.json>
env -u MULTIREMI_TOKEN bun run --preload ./tests/setup/hermetic-env.ts \
  tests/fixtures/multiremi/capture-first-screen-hotspots-pr2-golden.ts --dbq --out <dbq.json>
cmp <response.json> tests/fixtures/multiremi/first-screen-hotspots-pr2-golden.json
cmp <dbq.json> tests/fixtures/multiremi/first-screen-hotspots-pr2-dbq-golden.json
```

Committed goldens unchanged: response SHA-256 `43682d067ebe74bc7cd1d4b9376e299abf585a69ae73b09e1855c39991a6641e`; dbq SHA-256 `4245fc7e24508f44f765e46b574c6a368dc73110800b73ba6022390c4462df2a`. Each scale retains 50 sessions/20 agents, and summary/content/runtime queries stay 7/3/6. The summary count includes cold authentication, unlike the warm benchmark's 6.

Final verification commands (PG first, SQLite second, never concurrent) are run with `MULTIREMI_TOKEN` absent before Bun starts:

```bash
env -u MULTIREMI_TOKEN bunx tsc --noEmit
env -u MULTIREMI_TOKEN bun test tests/arch/ --timeout 20000
env -u MULTIREMI_TOKEN npm run docs:test
env -u MULTIREMI_TOKEN npm run docs:check
env -u MULTIREMI_TOKEN npm run cli:capabilities:check
env -u MULTIREMI_TOKEN bun run scripts/snapshot-api-routes.ts --check
env -u MULTIREMI_TOKEN bun test tests/unit/multiremi/ --timeout 20000
env -u MULTIREMI_TOKEN -u MULTIREMI_TEST_POSTGRES_URL bun test tests/unit/multiremi/ --timeout 20000
```

The actual final-head counts, status and exact-SHA CI are in the rework delivery comment. No production/209, frontend E2E, traces/HAR, shared-process termination, Wiki writes or new child issues are part of this rework.
