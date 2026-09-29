# ADR 0006: One conversation log per session; traces are owned by the daemon, then by a random-access session archive

## Status

Proposed (MUL-402, message architecture v2-B). Ships in the same release as
MUL-401 (daemon protocol v2) and MUL-403 (Live Hub and web). The four legacy
tables are dropped by a separately approved script after the release has run
in production; see "Consequences".

Five premises are still pending the product owner's confirmation (MUL-402
`cmt_dei9321q6reu`). The design below assumes the recommended answer for each,
and a different answer changes only the named sub-deliverable:

- **Q1** (unreadable hot trace): the turn card renders as usual; expanding the
  process record shows "the trace is on daemon <name>, currently offline" with a
  retry, or a permanent "lost with daemon retirement" state once the daemon is
  retired without archiving. No server-side copy.
- **Q2** (where an Issue final reply lives): it stays a standalone `message` row
  referenced by the turn card through `final_entry_id`; chat folds the reply into
  the card.
- **Q3** (switch window): the conversation backfill runs inside the new version's
  startup migration as one transaction; the trace backfill is a resumable
  operator script that runs after the deploy and shows "archive backfilling"
  while it is incomplete.
- **Q4** (rollback): a pre-deploy backup; rolling back restores the backup and the
  previous version, and conversation written after the switch is lost. The four
  legacy tables stay read-only until the drop script is approved.
- **Q5** (v1 archives): v1 rows are untouched; backfilled trace archives are
  additional `ready` rows instead of supersessions.

## Context

Conversation state is spread over three tables: `multiremi_chat_messages`,
`multiremi_issue_comments` and the append-only `multiremi_session_events`
(24K rows, 62 MB in production on 2026-09-26). Every issue comment that has a
session is mirrored into a `message` event (a `system` event for `type='system'`
comments) with `source_comment_id`, and
`backfillDefaultIssueSessions` re-establishes that mirror on every startup, so the
event `seq` is already a strict per-session order. Six agent comments from
2026-07-11/12 are the exception: they predate the mirroring mechanism, carry
`issue_session_id = NULL`, and therefore have neither a mirror event nor a session
to belong to, so the backfill cannot be driven by `session_events` alone. B7 takes
them from `issue_comments` instead and reports them as a separate
`orphan_comments` figure; its dry-run decides whether any of them can be attached
to a session after all, and "Consequences" records the expected outcome. Agent
read progress (`multiremi_session_agent_lanes.cursor_seq`),
side-session cutoffs, projection windows and delegation-return coverage checks all
store event `seq` values. Chat uses a separate `sequence` counter and never writes
session events.

Process messages (thinking, tool calls, usage) are posted by the daemon over HTTP
into `multiremi_task_messages`: 4.89M rows, 2.9 GB, 79% of the database. Per task,
p50/p90/p99 is 111/744/17,394 rows and 49 KB/425 KB/2.2 MB; 28 tasks exceed 8 MB
and every reader loads the full trace without a limit, which is what blocks the
PgBridge reply cap (MUL-386/MUL-398). The final answer shown in chat, in the
transcript dialog and in Feishu is derived from the trace (`phase=final` text),
not from `tasks.result`. The daemon keeps no durable local copy: its outbox is a
delivery queue that deletes rows on delivery.

Session Archive v1 (`multiremi.issue-sessions.v1`) is one gzip stream over a tar
of the Issue's `.runtime/<ises_*>` roots, produced only by the GC sweep for
terminal Issues, only on Linux (`/proc/self/fd` traversal), and never for chats,
one-shot tasks or before daemon retirement. Nothing on the server reads inside an
archive; there is no download endpoint. Multiple `ready` rows per Issue already
coexist because `superseded` only applies to non-ready rows or to the same
`source_revision` with a different hash, and the hard-delete barrier requires the
bound row to stay `ready`. Already-archived Issues still hold 1.57M task_messages
rows, so traces are stored twice.

Constraints: the end state is required in one release with no compatibility
layer; wake-up rules are ported 1:1 (rule changes belong to MUL-404); the schema
is written once in SQLite dialect and translated for Postgres, foreign keys are
not enforced on either backend. Postgres nested transactions use savepoints.

## Decision

1. **One log table per session.** `multiremi_conversation_log(session_id, seq)`
   holds every display unit for both Issue sessions (`ises_*`) and chats
   (`chat_*`): `head` at seq 0 (Issue title and description, or chat title),
   `message` (human and agent comments; chat user and system messages),
   `system` (the `type='system'` comments the mirror writes) and `turn` (one card
   per agent turn), plus `result_published` for published results. Row ids are
   the source ids (`cmt_*`, chat message ids, `sevt_*`), so threads, reactions,
   attachments and inbox deep links keep working.
   `multiremi_conversation_heads` allocates `seq` with an atomic
   `head_seq = head_seq + 1` update and carries `log_version` for replicas.
2. **Hidden markers share the seq axis.** The lifecycle facts that agents'
   projections and the wake-up rules depend on today are appended as
   `visibility = 'hidden'` rows with a `target_seq`: `task_completed`,
   `task_failed`, `task_cancelled`, `session_created`, `task_steer`,
   `message_edited`, `message_deleted`, `thread_resolved` and `thread_unresolved`.
   Shown rows also include `follow_frozen`. `delegation_report` (ADR 0005) is
   hidden too, under its own name: it lands in the delegator's session with the
   delegated child's `task_id`, which has no `turn` row there, so like
   `session_created` it has no `target_seq`. Together they cover every kind main
   has a producer for, under their existing names. In-place updates of shown rows bump
   `revision`. The hidden markers are also the change feed for the Live Hub and
   the browser replica. A row with `kind = 'head'` is not an event: every
   seq-range read (wake-up, projection, delegation drain) excludes it, and
   `cursor_seq = 0` still means "nothing read".
3. **Issue seq numbers are preserved.** The backfill copies `session_events`
   row-for-row at the same `seq`, joining comment bodies through
   `source_comment_id`. Lane cursors, `inherit_cutoff_seq`, `follow_frozen_seq`,
   task projection windows, `assignment_event_id` and stored `requiredEventSeq`
   values stay valid without remapping. Chat seq is `chat_messages.sequence`,
   verified unique during the backfill.
4. **The turn card replaces `task_assigned` and carries the completion report.**
   It is appended when the task is created (id = the former assignment event id,
   body = prompt), and updated in place through queued → running → terminal.
   Terminal fields are `final_reply_md` (chat) or `final_entry_id` (Issue, where
   the reply stays a threadable `message`), `summary`, `tool_call_count`,
   `event_count`, `type_histogram` bucketed by `(type, tool)` (matching what the
   organizer computes today; `tool` is null outside `tool_use`/`tool_result`),
   `usage` and `model`. `final_reply_md` is the task's result text as the
   daemon reports it in `output` (every `text` event concatenated,
   `Task completed.` when empty), the same text today's chat message and the
   auto-posted Issue reply carry; the historical backfill copies the assistant
   message body verbatim. `deriveFinalReply` is the Feishu CoT timeline's answer
   rule and is not a card field; the `final_reply_md` on `task.complete` /
   `task.fail` is not written to any card. The four trace figures on historical
   cards are recomputed from `task_messages` with the same `trace-derive`
   functions the daemon uses. The figures arrive in the daemon's completion
   report; the server never derives them from the trace. The terminal lifecycle
   events keep their own names and seq, as decision 2 requires.
5. **Traces have one owner at a time.** While hot, the daemon appends a
   normalised JSONL file
   `<workspacesRoot>/.runtime/<session_id>/traces/<task_id>.jsonl`
   (`multiremi.trace.v1`): a header line, one `TraceEvent` per line, and a
   trailing end line. seq is contiguous per task and assigned by the daemon's
   trace store at the durable write; a repeated seq is corruption and the reader
   takes the first occurrence, and a half-written final line is discarded.
   Header and trailer lines carry no `seq` and never leave the file store, so no
   consumer has to special-case them; completeness is one `closed` boolean. The
   server-side size caps move into the daemon's trace store append, which becomes
   the single sanitization point for both the file and the live frames. After
   archiving, the trace lives only in the Session Archive on the server disk. The
   server keeps a pointer per task in `multiremi_task_traces`
   (`daemon(runtime_id)` | `archive(archive_id, member_path, data_offset,
   compressed_size, uncompressed_size, sha256)` | `none` | `lost` |
   `backfilling`, plus `head_seq` and `closed` from the trailer or the archive
   index). Web, share links, the Feishu concierge relay and the organizer all
   read through one `trace-reader` module that routes on the pointer. No copies,
   no share snapshots.
   Organizer inspection reads terminal counts from `findTurnEntry(task_id)`;
   missing card statistics or unavailable live reads retain the legacy-table
   fallback until MUL-432 removes that table.
   B5's page/share trace endpoints and CLI return the original `TraceEvent`.
   Multi-event pages stay within the serialized events-array budget (default
   1MiB, including brackets and commas). If the first event alone exceeds that
   budget, it is returned alone, byte-for-byte, even over 1MiB. No field is
   shortened or removed; `state=ok`, the cursor equals that event's `seq`,
   the real `head` is retained, and subsequent pages continue normally to `eof`.
   The share view displays the full event with its existing type/pre rendering,
   automatically pages to `eof`, and adds no size notice or controls.
   MUL-402 `cmt_9y4qvdn2ytng` and `cmt_1u7d8q41zsdp` revoke the read-time
   truncation in (n) and all of (t). The unpublished read projection fields and
   its minimum budget are removed; positive integer `maxBytes` remains required.

   `TRACE_SANITIZED_EVENT_MAX_BYTES` in
   [budget fixture](../../tests/unit/multiremi/trace-budget-fixtures.ts) computes the
   conditional bound of sanitized fields plus the JSON skeleton from
   [sanitize constants](../../packages/shared/src/trace-sanitize.ts):
   `6 * (TRACE_CONTENT_MAX_BYTES + TRACE_OUTPUT_MAX_BYTES + TRACE_TOOL_MAX_BYTES)`
   plus three serialized write-truncation markers (excluding their quotes),
   plus `TRACE_INPUT_MAX_BYTES + TRACE_META_MAX_BYTES`, plus the actual serialized
   skeleton (all field names, punctuation, quotes and the largest safe `seq`).
   Every nullable field uses the larger of `null` and `""` in the skeleton;
   each bounded field replaces that placeholder with its largest serialized
   representation, including the longest accepted `status`. String fields use UTF-8
   caps, so one-byte control characters escaping to six-byte JSON are the worst
   case. The marker is included because the existing write sanitizer appends it
   after its UTF-8 cut. Structured `input` and `meta` are capped by serialized
   JSON bytes; capped invalid JSON becomes null, so their caps are not multiplied
   by six. The conditional finite portion is **2,297,014 bytes**: assume the
   string contents of `type`, `tool_call_id` and `ts` are empty, and all other
   fields are maximal. Their names and quotes remain counted; a null
   `tool_call_id` counts four bytes. `traceFiniteEventBytes` subtracts only the
   escaped contents of those three strings from an actual event for comparison.
   At the largest safe `seq`, adding a 27-byte timestamp gives QA4's
   **2,297,041 bytes**; adding its legal 121-byte timestamp gives **2,297,135**.
   MUL-402 QA4 `cmt_1452lgej5n06` and ruling `cmt_zjfw9qrsbemk` establish this
   applicability condition and the nullable correction.
   A contract-limit fixture fills all five bounded fields, remains unchanged
   through A's sanitizer, and exceeds 1MiB; HTTP response size is checked against
   its actual serialized event bytes plus the existing 512-byte envelope margin.

   **Three gaps:** the write sanitizer does not bound `type` or `tool_call_id`,
   and A-0 uses the caller's `ts` verbatim. B4's timestamp validator accepts
   arbitrarily long fractional seconds, so `ts` has no fixed 27-byte limit.
   All three string contents are excluded from this conditional calculation;
   their actual escaped JSON bytes must be added when
   determining an event's total size. There is no universal finite event bound
   or read-time fallback for these fields. Oversized values are returned intact.
   A-0's store admits the first over-budget event and its daemon reader forwards
   it. `DAEMON_TRACE_READ_MAX_BYTES=1MiB` is the request budget; the declared WS
   maximum is 4MiB. Real A-6 RPC/WS validation, including the separately declared
   `DAEMON_FRAME_MAX_BYTES=1MiB`, is **integration-time verification**: no
   transport implementation enforces these constants on this parent baseline.
   If integration discards, splits or rejects the contract-limit event, stop
   and obtain an A-side ruling; B5 does not alter A's transport or sanitizer.
6. **Session Archive v2 is a ZIP with an offset index.** Each member is deflated
   independently; `index.json` records `data_offset`, sizes and sha256 per member
   and marks trace members with their `task_id`, `head`, `event_count` and
   `closed`. Reading one task is one `pread` plus inflate. `source_revision`
   stays the hash of the content manifest and the archive `sha256` stays the hash
   of the blob, so the GC and hard-delete barriers are unchanged. Archives gain a
   subject (`issue`, `chat`, `task`) and a `format`; ingest validates the index
   against the central directory and writes the task pointers in the same
   transaction that marks the row `ready`. A pointer moves by the rule of its
   source and never across sources: within a source a larger or equal `head`
   wins, a daemon archive replaces a backfilled one whatever the heads, and a
   backfilled archive never replaces a daemon one, because old-table seqs and
   daemon trace seqs are different axes (MUL-432). The writer uses `lstat`-based
   traversal so macOS daemons can archive.
7. **v1 rows are left untouched.** Backfilled trace archives are additional
   `ready` rows (`metadata.kind = "trace_backfill"`), not supersessions, because
   supersede never deletes files and the hard-delete barrier needs the bound v1
   row to remain `ready`. v1 files stay on disk until a separately approved
   cleanup.
8. **Every session is archived before its daemon copy is deleted.** Chat and
   one-shot task GC require a `ready` archive like Issues do. Daemon retirement
   gains a blocker "hot traces not archived" and an `archive_sessions` command: a
   typed WebSocket frame derived from `multiremi_session_archive_requests`
   (`pending` → `sent` → `acked` → `completed`/`failed`), so archiving is a typed
   request with a structured result rather than a shell command. `abandon` marks
   the affected pointers `lost`.
9. **Backfill in two steps.** The conversation backfill runs inside the new
   version's startup migration as one transaction (`runMigrationOnce`), so writes
   are paused only for the deploy restart. The task_messages backfill is a
   resumable operator script run inside the API container after the deploy; it
   groups rows by subject, writes a v2 archive per subject, verifies each member
   row by row against the stored row (which may already be truncated) with the
   canonical digest below, records
   per-subject progress and per-task digests, and never writes back to a daemon.
   Both steps have read-only reconciliation scripts (count, order, content hash
   per session and per task).

   Both sides of every comparison run the **same** canonical digest function.
   String columns (`content`, `output`, `tool`, `tool_call_id`, `status`, `type`)
   hash their raw bytes. JSON columns (`input`, `meta`) hash
   `canonical(JSON.parse(text))` — key-sorted, whitespace-free `JSON.stringify` —
   because the trace carries those fields as objects, and a byte comparison would
   depend on key order and escaping. Parsing happens in Bun; the backfill must not
   cast these columns in SQL (`::jsonb` rejects the `\u0000` escapes that are legal
   JSON and present in production). The dry run also checks that each JSON column
   round-trips (`JSON.stringify(JSON.parse(text)) === text`) and reports every
   mismatch as `json_nonroundtrip`, expected to be zero. Already-truncated members
   reconcile against the stored value, not against a re-truncated copy.
   A JSON column whose stored text does not parse (the write-path cap fired and
   left a `… [truncated]` prefix; 187 `input` rows and 0 `meta` rows at the
   2026-09-26 snapshot) is carried as `null`, the same value
   `parseStoredTraceJson` yields on the live path and the API answers today. The
   dry run counts them as `json_unparseable_input` / `json_unparseable_meta` and
   stops on any unparseable row that lacks the marker.

## B1 implementation boundary (MUL-426)

The B1 branch creates the log and heads tables, mirrors new Issue and Chat
writes in the same transaction, and exposes `GET /api/sessions/:id/log` and
`/log/locate` through `remi session log window|locate`. Window reads use seq,
exclude hidden markers and deleted rows, and cap the older visible count at
1,000. The existing Chat `/messages/page` route pages by log seq while keeping
its timestamp-and-id cursor wire.

Legacy writers remain active until MUL-432 removes the old tables. Resolve and
unresolve update the comment row in place and append hidden `thread_resolved`
and `thread_unresolved` markers with the target comment's seq in the log.
Explicitly created Issue
sessions append `session_created`. The implicit default Issue session gets its
seq-0 head without a creation marker, preserving the existing first event seq
and stored follow/delegation cursors. MUL-427 / B7 backfills older rows in the
startup transaction before readers switch to the log. The legacy `/events`
adapter excludes head, includes hidden markers, renames assignment wire kind to
`turn`, and adds marker `target_seq`; the agent projection keeps its existing
`task_assigned` wire and immutable event bodies.

The B7 migration runs after `backfillDefaultIssueSessions`, copies every source
seq, skips existing rows, and only fills a NULL comment task association without
changing its revision or update time (ruling (f)). Chat-owned topic transport
tasks retain NULL Issue sessions and no Issue log rows (ruling (s)); their Chat
message associations are reconciled separately. The read-only
[reconciliation command](../../scripts/reconcile-conversation-log.ts) reports
counts and per-session digests without constructing a Store. The
[synthetic benchmark](../../scripts/benchmark-conversation-log.ts) exercises
SQLite and local PostgreSQL at the specified historical scale. Only JSON and
Markdown evidence is committed under `reports/migrations/`; the self-contained
HTML preview is a delivery-comment attachment.

Issue comment log rows take `task_id` from the comment, including system
comments; the legacy mirror event keeps its NULL task association. Deletion
clears the tombstone's `task_id`. The agent projection and legacy `/events`
wire output NULL whenever `source_comment_id` is present, preserving their
existing shape (MUL-427, ruling (e)).

The five self-transactional comment operations own a commit-event queue when
the caller has not supplied one. Workspace pushes and triggered-task enqueue
notifications are released only after their transaction commits; rollback
discards them. Update and delete cancel comment-triggered tasks after the
comment transaction, so cancellation's workspace lifecycle lock and terminal
notifications cannot run inside that transaction.

## MUL-432 trace backfill: what the operator confirms, and what is still open

This section is written for the later request to 贺华杰 for production backfill
authorization. It records facts, not decisions. It covers three things:

- what the operator confirms before `scripts/backfill-task-traces.ts --execute`;
- a side effect of a new `ready` archive becoming the latest one;
- the points the specification leaves open.

Sources:

- MUL-432 segment 1 QA round 3, suggestion 2 (`cmt_hdwibkbvfv2b`);
- ruling (ao) `cmt_tzwxfqleb2ch`;
- ruling D `cmt_yyn3uxliyzfm`.

Line numbers are as of the MUL-432 segment 2 merge. The read-latency numbers are
in the [MUL-432 read-latency report](../../reports/performance/MUL-402-archive-trace-read-2026-09-29.md).

### Cross-switch tasks (ruling D)

A cross-switch task is a terminal task that has old-table rows and whose trace
may continue on a daemon. The daemon's seq restarts at 1; the old table's seq
does not. `crossSwitchReasons` (`scripts/lib/task-trace-backfill.ts:1046`)
decides this. A task counts once for each reason it meets:

- `ended_at_or_after_cutoff` and `ended_at_unknown`, evaluated only when
  `--old-table-stopped-at` is given;
- `daemon_archive_pointer`: the task's pointer already reads a daemon's archive.

- **Count list.** The dry run prints `cross_switch` with the fields `cutoff_evaluated`,
  `count`, `by_reason`, the full sorted `task_ids` and `ack`:
  - the type is at `task-trace-backfill.ts:239`;
  - the fields are filled at `:1159-1164`, sorted at `:1219` and reported at `:1368`.

  Execute stops with `cross_switch_tasks` unless `--cross-switch-ack=<n>` equals
  `count`, so a wrong number also stops the run (`:1514-1529`). Execute requires
  `--old-table-stopped-at`, so the acknowledged count has to come from a dry run
  with the same moment. Without the moment, only `daemon_archive_pointer` is
  counted. `cmt_84uiax9lh5f8` found that if the cutover runbook drains running
  tasks and the outbox, this set is empty.
- **Only the daemon's suffix is shown.** The backfill still writes the old rows
  of these tasks into the backfilled archive, as a prefix backup. The pointer
  follows its source (Decision 6):
  - A daemon archive takes the pointer or keeps it, whichever lands first.
  - The backfill never replaces a daemon archive's pointer. The rejection reason
    is `daemon_owned` (`packages/server/src/store/repos/task-traces-repo.ts:249-255`).

  The normal read path then shows only the daemon's suffix. The prefix can be
  read only from the backfilled archive member and from the backup taken before
  the old table is dropped. If the backfill lands first, the task reads the old
  prefix until the daemon's `ready` archive takes over.

  A task with no daemon trace keeps reading the old rows through the backfill
  pointer. This covers a task claimed by a v1 daemon, or one whose in-memory
  daemon trace was lost.

  `tests/unit/multiremi/trace-backfill-cross-switch.test.ts` pins this:
  - T1 and T2 in both orders;
  - T3 for the v1 task.
- **Lost stays lost.** The dry run counts `lost` pointers in
  `source.tasks_with_lost_pointer` (`task-trace-backfill.ts:201`, `:1156`). The
  swap rule never moves a `lost` pointer: the rejection reason is `lost`, and the
  run counts it in `pointers_kept.lost` (`scripts/backfill-task-traces.ts:320`).
  These tasks keep reading as lost, although the archive holds their rows.
- **Skipped cards.** A cross-switch task's `turn` card describes its whole run,
  so the backfill does not rewrite its event count, tool call count, histogram
  or model. Each group's execution result counts these cards as
  `turn_cards_skipped_cross_switch` (`scripts/backfill-task-traces.ts:280-283`).
  T1 and T2 assert that the card is unchanged. The read-latency corpus has no
  history cards, so its `turn_cards_skipped_cross_switch: 0` says nothing about
  this count. The real count comes from the production dry run and execution.

### A new `ready` archive becomes the subject's latest

A subject's archives are listed by `updated_at DESC, id DESC` (`listSubject`,
`packages/server/src/store/repos/session-archives-repo.ts:183`). The status that
the UI and daemons read takes the first row as `latest` (`subjectStatus`, `:323`).
This rule already applies to daemon archives. A backfilled archive is a new
`ready` row, so it becomes the `latest` of a subject that may still hold older
`failed` rows. Then:

- **Sidebar header.** The Issue sidebar's Session archives header shows the
  status and retry state of `latest` only
  (`frontend/packages/views/issues/components/issue-session-archives-section.tsx:62`,
  `:103`). An older `failed`, retries-exhausted or backoff state no longer shows
  there.
- **Daemon retry gate.** The daemon's retry gate also reads `latest`.
  - Issues: `ensureIssueSessionArchive` passes `preflightStatus.latest` to
    `shouldDeferIssueSessionArchive` (`packages/server/src/worker/daemon.ts:2825`,
    `:2957`). That function defers only when `latest` is `pending`, `uploading`
    or `failed` and is in backoff or exhausted.
  - Chat and one-shot Task archives use the same gate:
    `ensureSubjectSessionArchive` (`daemon.ts:3016`) calls into
    `packages/server/src/worker/subject-session-archive.ts:86` and `:166`.

  When `latest` is `ready`, the daemon no longer waits for an older row's
  backoff or stops at its exhaustion. It prepares and uploads again the next
  time it archives the subject.
- **What stays visible.** Older rows are not deleted:
  - The expanded list still shows every row with its own state and an inline
    retry (`issue-session-archives-section.tsx:196`, `:210`, `:227`).
  - The workspace storage settings count failed and exhausted rows across all
    rows, not only the latest (`session-archives-repo.ts:269-300`,
    `frontend/packages/views/settings/components/storage-cleanup-tab.tsx:229`).

### Open for the production authorization

These points are not asked this round (ruling (ah) `cmt_aek4ct5ieqcd`, ruling (ao)).
The specification does not settle any of them.

1. **The masking by `latest`, described above.** The specification does not say
   whether the header or the daemon's retry gate should change.
2. **Empty Runtime or daemon identity.**
   - Which Runtime is recorded: a backfilled archive records the Runtime of the
     subject's most recent task whose Runtime still exists, and that Runtime's
     daemon (`scripts/lib/task-trace-backfill.ts:1204-1209`).
   - Empty values are counted: if no task has a Runtime, the Runtime is empty
     and the plan counts it in `archive_runtime_missing`. A Runtime with no daemon
     is counted in `archive_daemon_missing` (`:1210-1213`).
   - What is shown: the archive API returns the recorded `runtime_id` and
     `daemon_id` (`packages/server/src/api/routers/session-archives.ts:69-70`).
     The Issue sidebar's archive rows show neither. The specification does not
     say how an empty identity should show.
   - Retry after a failure: the inline retry (`retry`,
     `session-archives-repo.ts:846`) sets the row back to `pending` for its
     recorded Runtime. Only that Runtime's daemon can upload it again. The daemon
     uploads from its own local session state, and that state does not contain
     the old-table rows. So a daemon retry cannot be counted on to restore a
     backfilled archive. With an empty Runtime, there is no daemon to retry it
     at all.
3. **Monitoring and handling of verification failures.** What the repository
   does today:
   - Before each commit, the backfill re-reads and verifies every staged member
     (`scripts/backfill-task-traces.ts:398`, `:407`).
   - After each group, it reconciles that group and stops on any mismatch
     (`:203-213`).
   - A rerun resumes from the per-subject progress (`:232-238`).
   - `scripts/reconcile-task-traces.ts` is a read-only check, by sample or in
     full. It exits 0 when there is no mismatch, 3 on a mismatch and 1 on an
     error.
   - Later, someone can verify a `ready` archive by hand (`verify`,
     `packages/server/src/session-archive/service.ts:1119`). On a sha256 or size
     mismatch the row becomes `failed` (`session-archives-repo.ts:818`). The
     archive reader refuses a row that is not ready
     (`packages/server/src/session-archive/reader.ts:141`). The trace read then
     returns `unreachable` with reason `archive_read_failed`
     (`packages/server/src/trace/trace-reader.ts:96`).

   There is no scheduled verification, alert or automatic re-backfill. The
   specification names no plan for production monitoring, backup or handling.
4. **Production peak, WAL, headroom and p99.** What the read-latency report
   covers:
   - It times synthetic size tiers in process, without HTTP, on a shared
     machine. Its numbers are not an SLO.
   - Its disk figures are estimates plus synthetic measurements. The PostgreSQL
     size comes from `pg_database_size`, which excludes the shared `pg_wal`, so
     it does not give a production peak.
   - p99 tier, whole read (about 35 pages of 500 events, from seq 0 to eof):
     3.06 s to 3.87 s per read, from the smallest p50 to the largest max across
     both backends, cold and warm. This is not a first-screen time.
   - p99 tier, tail window of 100: 86 ms to 122 ms per read.

   What was not measured:
   - the production compression ratio;
   - peak disk and WAL during the run;
   - free space on 209;
   - production read latency. The report defers it to after an authorized
     backfill.

   The specification sets no threshold for any of these.

## Alternatives considered

- **Immutable append-only log with reader-side folding** — every SSR and replica
  read would fold edits and terminal updates, and "rows = display units" is what
  makes the count/order/hash reconciliation meaningful.
- **In-place updates without hidden markers** — breaks the delegation-return
  coverage check (`projection_to_seq ≥ requiredEventSeq`) and hides edits from
  agent projections, so it is not a 1:1 port.
- **Renumbering seq during the backfill** — requires remapping eight kinds of
  stored references for no benefit.
- **A closed enum of normalised event kinds** — four of the kinds proposed for
  the enum have no producer in the code, and the backfill would become a lossy
  mapping; the frontend and the Feishu timeline already treat the type as an open
  string, so the constant list exists only for switch exhaustiveness and
  histogram bucketing.
- **Folding the Issue final reply into the turn card** — the reply is a threadable
  comment referenced by `parent_id`, reactions, attachments and inbox items;
  moving it means remapping all of those for 20K historical comments.
- **Provider-native history as the trace** — format varies by provider, contains
  credentials and unrelated files, and Antigravity has none.
- **Outbox SQLite as the hot copy** — it is a delivery queue: rows are deleted on
  delivery and the 256 MiB cap silently drops the oldest rows.
- **tar with per-member gzip and a sidecar index** — non-standard; no tool reads it.
- **zstd seekable format** — Bun 1.3.14's zlib has no zstd; a new dependency for
  no functional gain over deflate.
- **Server-side carry-forward merge into one archive per session** — several
  `ready` rows per subject are already allowed and pointers reference a specific
  row, so rewriting 100 MB files on every upload buys nothing.
- **One archive per task** — an Issue-level blob keeps the GC barrier and the
  existing flow intact and stores the trace next to the provider history.
- **Server-side tail copy for offline daemons** — violates "no copies"; the
  turn card already carries summary, final reply and counts.

## Consequences

- **Positive:** the trace leaves the database (79% of its size) and every
  remaining route is bounded, which lets MUL-398 turn on the reply cap; one log
  serves the web, Feishu, agents and the browser replica with one seq axis;
  Issue wake-up state needs no migration.
- **Positive:** reading one task from an archive is one positioned read, and
  archives now cover chats, one-shot tasks, retirement and macOS daemons.
- **Negative:** a trace on an offline or retired daemon is unreadable until that
  daemon archives it; the card renders, the expansion shows an explicit
  unreachable or lost state. Frequently-offline laptops make this a steady state.
- **Negative:** a new archive revision duplicates the trace members of earlier
  revisions of the same subject; superseded and v1 files are never deleted by
  this change, so disk grows until a separate cleanup is approved.
- **Negative:** `tasks.updated_at` no longer moves with every process message;
  consumers that used it as "last activity" must read the turn card.
- **Negative:** the daemon must send the final reply, counts and histogram in the
  completion report; a daemon that omits them leaves cards without those fields.
- **Negative:** the six comments whose Issue no longer exists are not carried into
  the log; they survive only in the pre-drop backup.
- **Negative:** JSON columns that no longer parse are backfilled as `null`; the
  truncated prefixes of those rows survive only in the pre-drop backup.
- **Neutral / open:** window-read shape (`entries + patches` vs inlined updated
  rows), whether replicas key freshness on `log_version`, the Feishu catch-up
  cursor and the `trace.read` limit are settled with MUL-401/MUL-403.
- **Neutral / open:** rollback after the switch is "restore the pre-deploy backup
  and run the previous version"; conversation written after the switch is lost.
  The four legacy tables remain read-only until the drop script is approved.
