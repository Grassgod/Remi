# MUL-427: wake-up read inventory

Baseline: main `1653b038289f9eae79b426f1b8cd0577ce4d31ae` plus parent
`a4b913c2cc8a132d2159a70cd486dbe9eda9b848`. No later main is merged.
Authority: `cmt_gestk2r6imjh` (e)-(h). This is the first published W inventory;
the proposal's W4/W10 labels are references, not an earlier complete numbering.
Paths below are relative to `packages/server/src/store/`. Positions are source
anchors; the final delivery records the merged-head line numbers.

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
| W10 | `repos/issue-sessions-repo.ts:489`, legacy events reader | Events with since/to bounds | Switch only in B7 after startup backfill; log hidden markers retained | B7 mixed old/new events and boundary tests | |
| W11 | `repos/issue-sessions-repo.ts:551`, own projection | Events via legacy reader | All log rows including hidden; reconstruct immutable original bodies | byte-equal edit/delete projection / frozen goldens | |
| W12 | `repos/issue-sessions-repo.ts:597`, inherited projection | Parent events through inherited/follow cutoff | Same log projection adapter and identical bounds | follow / side-session delegation / frozen goldens | |
| W13 | `repos/issue-sessions-repo.ts:776`, parent max | Parent event max seq | Log max excluding head, no cursor remapping | follow / lane lifecycle / head regression | |
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
task descriptors plus projections. It normalizes only newly generated ids and
wall-clock timestamps. `conversation-log-wakeup.test.ts` additionally compares
the complete projection bytes, then perturbs the legacy source to verify that
the online reader no longer depends on it. B7 adds the same proof on backfilled
head/edited/tombstone data.

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
The following lists every remaining SQL read at the first-part head. Literal
names in declarations, comments, indexes and foreign keys are not reads. The
final B7 head repeats this scan and updates the two deferred event reads.

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
| `repos/issue-sessions-repo.ts:495,498` | Legacy /events since/to reads | W10 deferred until B7 migration, then switched |
| `repos/issues-repo.ts:1329` | Search result comment snippet | Old wire retained to MUL-432 third section |
| `repos/issues-repo.ts:3389,3401` | Comment get/list legacy shape joined with current log state | Old wire retained to MUL-432 third section |
| `repos/issues-repo.ts:3655` | Timeline comment page | Old wire retained to MUL-432 third section |
| `repos/issues-repo.ts:4118` | Reaction list existence join | Old wire retained to MUL-432 third section |
| `repos/issues-repo.ts:4270` | Attachment list existence join | Old wire retained to MUL-432 third section |
| `repos/issues-repo.ts:4642` | Descendant ids before hard delete | Write path |
| `migrations.ts:3568,3572,3583,3586,3603` | Default issue-session/comment mirror rebuild | Backfill source |
| `migrations.ts:4104` | Chat sequence initialization | Backfill source |
| `migrations.ts:4607` | Markdown attachment ownership backfill | Backfill source |

All INSERT/UPDATE/DELETE references in these modules remain write paths. The
legacy tables still receive every event, including resolve/unresolve and
follow_frozen. No production data was read or exported.

## First-part verification

- SQLite plus real PostgreSQL selection: 196 pass, 0 skip, 0 fail; 1,609
  assertions across 18 files, 123.04 seconds. Includes the full concurrency
  file, both malformed-worker-source tests and all first-part dual-backend tests.
- `bunx tsc --noEmit -p .`: passed.
- `bun run docs:check` and `git diff --check`: passed.
- Known B5 failures, isolated separately: SQLite transaction-depth 18, PG
  transaction-depth 6, PG decisions 1; all expect max=1 and observe 2/3. The
  three files are unmodified, with no other failures in that selection.
- Final merged-head full checks and B7 reconciliation remain pending here;
  the final migration report supplies those results.
