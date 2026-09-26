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
(24K rows, 62 MB in production on 2026-09-26). Every issue comment is mirrored
into a `message` event with `source_comment_id`, and `backfillDefaultIssueSessions`
re-establishes that mirror on every startup, so the event `seq` is already a
strict per-session order. Agent read progress (`multiremi_session_agent_lanes.cursor_seq`),
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
not enforced on either backend, and Postgres transactions have no savepoints.

## Decision

1. **One log table per session.** `multiremi_conversation_log(session_id, seq)`
   holds every display unit for both Issue sessions (`ises_*`) and chats
   (`chat_*`): `head` at seq 0 (Issue title and description, or chat title),
   `message` (human, agent and system comments; chat user and system messages),
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
   `message_edited` and `message_deleted` — the kinds production actually
   writes, under their existing names. In-place updates of shown rows bump
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
   `usage` and `model`. `final_reply_md` comes from a shared `deriveFinalReply`
   helper, which the historical backfill reuses so old and new cards reconcile.
   The figures arrive in the daemon's completion report; the server never derives
   them from the trace. The terminal lifecycle events keep their own names and
   seq, as decision 2 requires.
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
6. **Session Archive v2 is a ZIP with an offset index.** Each member is deflated
   independently; `index.json` records `data_offset`, sizes and sha256 per member
   and marks trace members with their `task_id`, `head`, `event_count` and
   `closed`. Reading one task is one `pread` plus inflate. `source_revision`
   stays the hash of the content manifest and the archive `sha256` stays the hash
   of the blob, so the GC and hard-delete barriers are unchanged. Archives gain a
   subject (`issue`, `chat`, `task`) and a `format`; ingest validates the index
   against the central directory and writes the task pointers in the same
   transaction that marks the row `ready`. The writer uses `lstat`-based
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
   byte-for-byte against the stored row, which may already be truncated, records
   per-subject progress and per-task digests, and never writes back to a daemon.
   Both steps have read-only reconciliation scripts (count, order, content hash
   per session and per task).

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
- **Neutral / open:** window-read shape (`entries + patches` vs inlined updated
  rows), whether replicas key freshness on `log_version`, the Feishu catch-up
  cursor and the `trace.read` limit are settled with MUL-401/MUL-403.
- **Neutral / open:** rollback after the switch is "restore the pre-deploy backup
  and run the previous version"; conversation written after the switch is lost.
  The four legacy tables remain read-only until the drop script is approved.
