# MUL-427: wake-up read inventory

Baseline: main `1653b038289f9eae79b426f1b8cd0577ce4d31ae` plus parent
`a4b913c2cc8a132d2159a70cd486dbe9eda9b848`. No later main is merged.
Authority: `cmt_gestk2r6imjh` (e)-(h), `cmt_o1oocq58vsbg` (s),
`cmt_9z7t6hwo3xuh` (u). This is the first published W inventory;
the proposal's W4/W10 labels are references, not an earlier complete numbering.
Paths below are relative to `packages/server/src/store/`. Positions are source
anchors, updated after the B7 cutover.

## W inventory

| Item | Location | Previous source | New source / unchanged predicate | Proof | Proposal label |
| --- | --- | --- | --- | --- | --- |
| W1 | `context.ts:1227`, `getLogIssueComment` | Raw `issue_comments` shared lookup | Log comment id, issue-session join, message/system, no tombstone | comment task / rule parity / delegation | |
| W2 | `helpers.ts:11`, `chatTaskRetryParentSql` | Chat user-row existence | Log message/member in a chat session; old startup migration explicitly keeps legacy source | chat store migration / queue / lineage | |
| W3 | `repos/agent-issue-updates-repo.ts:191`, `flushOneWithinTransaction` | Aggregation state, then writes a chat system row | Same aggregation/state/debounce; B1 mirrors the same system row and delivery metadata | agent issue updates / pending delivery | W10 |
| W4 | `repos/chat-repo.ts:478`, task projection | `chat_messages` ordered sequence/id | Log excluding head/tombstones; identical role/body mapping and queued-input lineage filter | chat store / queue / projection | |
| W5 | `repos/chat-repo.ts:642`, prepare delivery | Pending chat system rows | Log system message metadata: pending plus no delivery task; same batch limit/order | pending delivery / agent issue updates | |
| W6 | `repos/chat-repo.ts:666`, complete delivery | System rows for delivery task | Log metadata delivery task; legacy flag write retained and log metadata patched | pending delivery / agent issue updates | |
| W7 | `repos/chat-repo.ts:680`, discard delivery | Pending system rows | Log pending metadata; both flag writers remain atomic | pending delivery / agent issue updates | |
| W8 | `repos/issue-sessions-repo.ts:35`, inherited count | Session events count through cutoff | Log count, head/seq 0 excluded, same cutoff | follow / side sessions / head regression | |
| W9 | `repos/issue-sessions-repo.ts:135`, fork cutoff | Event max seq | Log max seq excluding head, empty means 0 | issue sessions / head regression | |
| W10 | `repos/issue-sessions-repo.ts:489`, legacy events reader | Events with since/to bounds | Startup B7 backfill precedes cutover; log hidden markers retained | B7 mixed old/new events and boundary tests | |
| W11 | `repos/issue-sessions-repo.ts:545`, own projection | Events via legacy reader | All log rows including hidden; reconstruct immutable original bodies | byte-equal edit/delete projection / frozen goldens | |
| W12 | `repos/issue-sessions-repo.ts:591`, inherited projection | Parent events through inherited/follow cutoff | Same log projection adapter and identical bounds | follow / side-session delegation / frozen goldens | |
| W13 | `repos/issue-sessions-repo.ts:768`, parent max | Parent event max seq | Log max excluding head, no cursor remapping | follow / lane lifecycle / head regression | |
| W14 | `repos/issues-repo.ts:1245`, materialized session | Event existence | Non-head log existence, participants/lanes unchanged | head regression / workspace lineage | |
| W15 | `repos/issues-repo.ts:1544`, owner summary acceptance | Agent ordinary comments after child close | Current undeleted log comments, same issue/author/time/body predicate | parent status / decisions | |
| W16 | `repos/issues-repo.ts:3106`, deferred mention comment | Hydrated legacy comment | Current log comment lookup | merge fixes / automatic reply / delegation | |
| W17 | `repos/issues-repo.ts:3112`, deferred mention seq | Event source_comment_id | Log comment row id at the same seq | merge fixes / delegation | |
| W18 | `repos/tasks-repo.ts:724`, task trigger lookup | Raw comment | W1 log lookup, same task/session/parent inference | delegation / mention / task metadata | |
| W19 | `repos/tasks-repo.ts:1515`, trigger metadata | Raw comment | W1 current log lookup | mention / delegation / rule parity | |
| W20 | `repos/tasks-repo.ts:2366`, queued chat affinity | User chat row for task | Log message/member plus chat-session join, no tombstone | chat queue / migration / affinity | |
| W21 | `repos/tasks-repo.ts:3594`, thread root | Raw parent comments | W1 current log parents, same cycle guard | delegation / mention | |
| W22 | `repos/tasks-repo.ts:3623`, new comment count | Issue comments after anchor, other author | Log message/system comments, same time/id/SQL NULL semantics, no tombstone | task trigger / delegation | |
| W23 | `repos/tasks-repo.ts:3732,3896`, coverage decision | Stored task projection_to_seq and terminal event seq | Guard unchanged: projection_to_seq >= requiredEventSeq; W24/W25 supply terminal row seq, not turn seq | delegation return / rule parity | W4 |
| W24 | `repos/tasks-repo.ts:3802`, delegation terminal max | Terminal event MAX(seq) | Log terminal kind and same task, MAX(seq) unchanged | delegation return / lane lifecycle / rule parity | |
| W25 | `repos/tasks-repo.ts:3814`, delegation terminal existence | Terminal event existence | Log terminal kind and same task; same report filtering | delegation return / lane lifecycle / rule parity | |
| W26 | `repos/tasks-repo.ts:4624`, reply parent | Hydrated trigger comment | W1 log parent, same reply/mention dispatch | automatic reply / merge fixes | |
| W27 | `repos/tasks-repo.ts:4662`, agentCommentedSince | Ordinary agent comment by issue/author/task/time | Log message comment by all issue sessions, same author/task/time, no tombstone | 15-case dual-backend equivalence / completion count = 1 | |

## Rule preservation

No lane cursor, assignment id, projection window, inheritance cutoff or required
event seq is rewritten. Only source reads change. Head is excluded from every
event-range read. Internal assignment kind is `turn`; the agent projection still
emits `task_assigned`, with unchanged golden files. Immutable event bodies and
metadata are reconstructed from hidden edit/delete markers, including
`previous_body`; current comment state is used only by current-comment readers.

`conversation-log-rule-parity.test.ts` runs the identical mention/delegation input
against the legacy and log readers in rolled-back transactions and compares
task descriptors plus Issue and Chat projections. It normalizes only newly generated ids and
wall-clock timestamps. `conversation-log-wakeup.test.ts` additionally compares
the complete projection bytes, then perturbs the legacy source to verify that
the online reader no longer depends on it. The backfilled variant includes
head/edited/tombstone data and a Chat-owned topic transport task. Both variants
retain its NULL issue session and zero Issue rows, and compare its Chat
projection with the legacy-message source.

## agentCommentedSince equivalence

Each result was compared with the actual legacy SQL and the new repo method on
SQLite and real PostgreSQL. `since` uses >=, and null omits the cutoff.

| Input | Legacy | Log | SQLite / PG |
| --- | --- | --- | --- |
| Ordinary same-agent/task comment | true | true | equal / equal |
| Member ordinary comment | false | false | equal / equal |
| Automatic agent reply | true | true | equal / equal |
| Task-linked system comment | false | false | equal / equal |
| Agent-authored system comment | false | false | equal / equal |
| Hard-deleted comment | false | false | equal / equal |
| Edited ordinary comment | true | true | equal / equal |
| Same-issue side session | true | true | equal / equal |
| Created before since | false | false | equal / equal |
| Created exactly at since | true | true | equal / equal |
| since = null, old comment | true | true | equal / equal |
| Different agent | false | false | equal / equal |
| Different task | false | false | equal / equal |
| Different issue | false | false | equal / equal |
| Bare message event, not a comment | false | false | equal / equal |

The completion end-to-end test keeps `actualCommentsAfterCompletion=1`, including
after the legacy comment task link is disturbed. The (e) tests verify
`logLookupMatches=1`, comment-linked log task ids, null legacy event/wire/projection
task ids and a null tombstone task id on both backends.

## Complete legacy-name scan

Command: `rg -n 'multiremi_session_events|multiremi_issue_comments|multiremi_chat_messages' packages/server/src`.
The following lists every remaining SQL read after B7. Literal names in
declarations, comments, indexes and foreign keys are not reads. W10 now has no
legacy-table read; both former /events reads are switched to the log.

| Location | Read | Classification |
| --- | --- | --- |
| `context.ts:1222` | Raw comment for edit/delete/resolve, reactions and attachment mutation | Write path / old wire retained to MUL-432 third section |
| `helpers.ts:13`, called only by `migrations.ts:5106` with legacy source | Retry user input before log backfill exists | Backfill source |
| `repos/chat-repo.ts:41,43,45,47` | Chat list summary count/latest body/role/time | Old wire retained to MUL-432 third section |
| `repos/chat-repo.ts:256` | Attachment ids before deleting chat | Write path |
| `repos/chat-repo.ts:297` | User message ids before deleting task input attachments | Write path |
| `repos/chat-repo.ts:342` | Legacy chat message list | Old wire retained to MUL-432 third section |
| `repos/chat-repo.ts:351,354` | Chat pagination legacy shape and pre-backfill fallback | Old wire retained to MUL-432 third section |
| `repos/chat-repo.ts:374` | Legacy chat cursor id/sequence lookup | Old wire retained to MUL-432 third section |
| `repos/chat-repo.ts:381,385` | Chat locate legacy shape and pre-backfill fallback | Old wire retained to MUL-432 third section |
| `repos/chat-repo.ts:448` | Just-inserted chat row for B1 mirror | Write path |
| `repos/chat-repo.ts:709` | Chat message hydration after writer | Write path / old wire retained to MUL-432 third section |
| `repos/conversation-log-repo.ts:119` | Legacy max seq while allocating mirrored writes | Write path / backfill source |
| `repos/issue-sessions-repo.ts:431,443` | Just-inserted legacy event returned/mirrored | Write path |
| `repos/issue-sessions-repo.ts:447` | Comment task id for (e) mirror | Write path |
| `repos/issues-repo.ts:1329` | Search result comment snippet | Old wire retained to MUL-432 third section |
| `repos/issues-repo.ts:3389,3401` | Comment get/list legacy shape joined with current log state | Old wire retained to MUL-432 third section |
| `repos/issues-repo.ts:3655` | Timeline comment page | Old wire retained to MUL-432 third section |
| `repos/issues-repo.ts:4118` | Reaction list existence join | Old wire retained to MUL-432 third section |
| `repos/issues-repo.ts:4270` | Attachment list existence join | Old wire retained to MUL-432 third section |
| `repos/issues-repo.ts:4642` | Descendant ids before hard delete | Write path |
| `migrations.ts:3548,3572,3576,3587,3590,3607` | Default issue-session/comment mirror rebuild | Backfill source / write path |
| `migrations.ts:4108` | Chat sequence initialization | Backfill source |
| `migrations.ts:4611` | Markdown attachment ownership backfill | Backfill source |
| `migrations.ts:5235` | Dependent Chat table copy during ownership migration | Backfill source |
| `conversation-log-backfill.ts:98,107,137,139` | Comments, orphan absence and immutable events | Backfill / reconciliation source |
| `conversation-log-backfill.ts:214,239` | Chat messages and tasks without assistant messages | Backfill / reconciliation source |
| `conversation-log-backfill.ts:250` | Assert Chat-owned topic tasks have no Issue events | Backfill / reconciliation diagnostic source |

All INSERT/UPDATE/DELETE references in these modules remain write paths. The
legacy tables still receive every event, including resolve/unresolve and
follow_frozen. No production data was read or exported.

## NULL-session boundary

Ruling (s) accepts the previous audit, narrowed to all comments and tasks with
`issue_id IS NOT NULL AND chat_session_id IS NULL`. No production NULL-session
writer was found in that scope. Ordinary comments resolve a session before
`repos/issues-repo.ts:3005`; system comments do so before `:2586`; public task
creation resolves the default session at `repos/tasks-repo.ts:774` before the
INSERT at `:943`. Retry, redispatch, autopilot and API inputs use that task
creation path. Startup repair uses the same non-Chat predicate at
`migrations.ts:3557`; it runs at `:3360`, before B7 at `:3363`.

Chat-owned topic transport is intentionally exempt: `repos/chat-repo.ts:549`
passes both Issue and Chat ownership without an Issue session. No Issue event
or log row is introduced. The old-first-startup test, both rule-parity variants
and the reconciliation counters independently cover this boundary.

## First-part verification

- SQLite plus real PostgreSQL selection: 196 pass, 0 skip, 0 fail; 1,609
  assertions across 18 files, 123.04 seconds. Includes the full concurrency
  file, both malformed-worker-source tests and all first-part dual-backend tests.
- `bunx tsc --noEmit -p .`: passed.
- `bun run docs:check` and `git diff --check`: passed.
- Known B5 failures, isolated separately: SQLite transaction-depth 18, PG
  transaction-depth 6, PG decisions 1; all expect max=1 and observe 2/3. The
  three files are unmodified, with no other failures in that selection.
- B7 plus rule-parity selection: 17 pass, 0 skip, 0 fail; 246 assertions,
  26.80 seconds. Includes both first-startup variants, both read-only CLI
  variants, full fixtures, rollback/retry and the real-worker large-text case.
- The final migration JSON/MD report supplies reconciliation and cold-start
  numbers; the delivery attachment `MUL-427-verification.md` records the final
  check matrix, not an additional committed report.

## Ruling (u): kind and consumer review

Commands: `rg -n 'task_assigned|listSessionEvents' frontend packages scripts`,
`rg -n '/events' frontend packages scripts apps/remi/cli`, plus inspection of
every session-event caller. The actual CLI lives in `apps/remi/cli`, so it is
included in addition to the requested directories. No production consumer
outside the approved /events reader, share bundle and projection depends on
the legacy assignment kind. No frontend or CLI assignment-kind literal exists.

Every `task_assigned` hit in the requested directories:

| Location | Classification | Reason |
| --- | --- | --- |
| `packages/contracts/src/conversation-log.ts:10` | Mapping documentation | Source kind is renamed to turn |
| `packages/server/src/api/helpers/issues.ts:79` | Write documentation | Author attribution before task creation |
| `packages/server/src/api/routers/tasks.ts:254` | Write documentation | Assignment-author producer contract |
| `packages/server/src/store/conversation-log-mirror.ts:7,58` | Mapping | Shared legacy-to-log mapping, used by B1 and B7 |
| `packages/server/src/store/conversation-log-backfill.ts:141` | Mapping / backfill source | Historical assignment seq supplies marker target_seq |
| `packages/server/src/store/session-projection.ts:44,302` | Mapping / approved projection | Normalize legacy input and retain agent JSONL output |
| `packages/server/src/store/repos/tasks-repo.ts:1053` | Write | Legacy dual-write producer remains unchanged |
| `scripts/benchmark-conversation-log.ts:43` | Write / synthetic input | Generates historical assignment rows in isolated fixtures |
| `scripts/api-routes.golden.json:4266,5419` | Mapping / test snapshot | Frozen agent JSONL examples, not a runtime consumer |

All non-test `listSessionEvents` and session `/events` consumers:

| Location | Classification | Result |
| --- | --- | --- |
| `packages/server/src/store/repos/issue-sessions-repo.ts:489` | Read / implementation | Log adapter, excludes head, includes hidden markers |
| `packages/server/src/store/store.ts:3874,3875` | Read / facade | Delegates without filtering kind |
| `packages/server/src/api/routers/issues.ts:1610,1622` | Read / approved endpoint | Since/to bounds; compatibility wire mapping |
| `packages/server/src/api/routers/issue-shares.ts:161` | Read / approved share bundle | Same adapter; every event retained |
| `frontend/packages/core/api/endpoints/comments.ts:167,168,170` | Read / API wrapper | No assignment-kind filter; no other UI caller |
| `apps/remi/cli/commands/collaboration.ts:320` | Read / CLI | Renders raw session.event.list response, no kind filter |
| `scripts/generate-cli-capabilities.ts:404` | Mapping | Maps endpoint to the registered CLI command |
| `scripts/api-routes.golden.json:233,1001,15518,15519,15520` | Mapping / test snapshot | Route inventories and synthetic endpoint snapshot |

Other `/events` grep hits are SCM/knowledge endpoints, WebSocket type imports,
or audit-report labels; none consumes Issue session events. The share renderer
at `frontend/packages/views/share/shared-issue-page.tsx:171` maps every event to
author/time/body without reading kind.

`conversation-log-share-parity.test.ts` fetches the real share API with the
backfill fixture on both SQLite and PostgreSQL, replacing only the event reader
for the legacy comparison. Both versions perform the normal default-session
and missing-comment-mirror startup repair first. Therefore both bundles have
18 Issue events (the raw pre-startup fixture has 17 plus one live orphan).
Counts, order, author, created_at and original body are exactly equal, including
edited comments and tombstones. Differences are restricted to task_assigned ->
turn, comment event id -> comment id and hidden marker target_seq. Comment wire
task_id stays NULL on both sides. No share row is added or removed.

The four main helpers were synchronized in their own (u) commit. Names, length,
authorType/authorId and provenance assertions are unchanged. A TypeScript
printer with comments removed proves the entire before/after file differs only
by `event.kind === "task_assigned"` -> `event.kind === "turn"`.

| File | Before pass / skip / fail | After pass / skip / fail | Before / after time |
| --- | --- | --- | --- |
| `multiremi-credential-identity.test.ts` | 7 / 0 / 3 | 10 / 0 / 0 | 2.43 / 2.44 s |
| `multiremi-credential-identity-pg.test.ts` | 2 / 0 / 2 | 4 / 0 / 0 | 3.08 / 3.01 s |
| `multiremi-task-assignment-author.test.ts` | 5 / 0 / 5 | 10 / 0 / 0 | 2.49 / 2.38 s |
| `multiremi-task-assignment-author-pg.test.ts` | 1 / 0 / 2 | 3 / 0 / 0 | 3.04 / 2.96 s |

The PG variants actually ran against the isolated local cluster; no PG skip is
counted as coverage. Share parity: 2 pass / 0 skip / 0 fail, 190 assertions.
