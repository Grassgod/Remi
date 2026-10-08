# ADR 0015: Issue activity stays outside the conversation log; the window read attaches it by time span

## Status

Accepted (MUL-501, 2026-10-04). Step 2a implements the activity sidecar and
presentation grouping. Step 2b's first segment derives display layers on read
and repairs the unified-model presentation regressions. Filtered paging remains
reserved for the next segment; no layer column or backfill is required.
Extends ADR 0006 (one log per session) and ADR 0007 (browser replica).

## Context

Issue property changes (status, assignee, priority, start and due date,
labels, title) are recorded in `multiremi_issue_activity` by
`appendIssueActivity` (`packages/server/src/store/context.ts`). The table is
keyed by `(issue_id, created_at)`; it has no `seq` and no session id. The
comment area, since MUL-402/403, renders one seq-paged window of
`multiremi_conversation_log` per Issue session through `IssueLogReplica`,
`SessionLogList` and a browser replica that persists rows by `(session_id,
seq)` and treats seq coverage as truth.

The product decision for MUL-501 (贺华杰, 2026-10-04) puts these changes back
into the comment area as one-line events, folded into "N 条动态" groups when
three or more are consecutive, mixed with the delegation lines, visible only in
the Issue's default session.

Two facts constrain the design:

- **Seq is dense and already allocated.** Historical activity cannot be given a
  seq that interleaves with existing rows; ADR 0006 rejected renumbering. Any
  design that stores activity in the log therefore starts empty for every Issue
  that exists today.
- **Shown log rows are also the agents' view.** `listConversationLogShown`
  feeds the session projection, the wake-up sweep and the relay projection
  (`tasks-repo.ts`, `wire/tasks.ts`, `session-projection.ts`). A new shown kind
  changes what every agent reads; that is MUL-493's protocol, not a display fix.

Note on the stated baseline: since MUL-249 (2026-09-05) the session-scoped
timeline excluded activity on the server (`listIssueTimelinePage`:
`activityRows = sessionId ? [] : …`) and the v0.2.83 `activity:created` handler
returned early when a session was selected. v0.2.83 therefore did not show
these lines in a session view; the UI code (`activity-block.tsx`) remains in
the tree, unused.

## Decision

1. **The activity table stays the single source.** No activity row is written
   to `multiremi_conversation_log`, neither as a shown kind nor as a hidden
   marker. Agents' projections, wake-ups and the hub streams are unchanged.

2. **The window read attaches the activity that falls in its time span.**
   `GET /api/sessions/:sessionId/log?with_activity=1` answers, for the Issue's
   **default** session only, with `activities` beside `entries`. The span is
   tiled so each activity belongs to exactly one window:

   - `prev_entry_created_at` = `created_at` of the newest shown row older than
     `entries[0]` (null when none). `window()` already looks that row up for
     `has_more_before`; it now returns the timestamp.
   - An activity `a` belongs to the window when
     `prev_entry_created_at <= a.created_at < entries[-1].created_at`, with the
     lower bound open when there is no older row and the upper bound open when
     `has_more_after` is false (the tail).
   - The client places `a` after every row whose `created_at <= a.created_at`.
     Adjacent windows therefore merge by set union with no gap and no overlap.
   - At most the newest 200 activities per window, returned chronologically;
     `activities_truncated` indicates that older matching activities were capped.

   Chats and non-default Issue sessions ignore the flag and return no
   `activities` key.

3. **The browser keeps activity beside the replica, not inside it.**
   `IssueLogReplica` carries `activities` on its presentation window and merges
   them on `earlier`, `newer`, `loadAround` and `refreshVisible` by id. Live
   `activity:created` frames (already broadcast by `appendIssueActivity`) are
   appended only when the window is the tail. The OPFS replica, its coverage
   and its freshness rule are untouched.

4. **Display layers are derived from message headers and turn provenance,
   never stored in a new column.** `conversationLogLayer` in contracts puts
   member/agent messages in `conversation` and platform/timer messages in
   `system`, including canonical envelopes now stored as `kind=message`.
   Turns with a null/missing source or `human_sender`, `agent_dispatch`,
   `mention` or `relay` belong to `conversation`; all other sources belong to
   `system`. A legacy prompt starting with `读收件箱` also belongs to `system`.
   Every `WakeReason` is explicitly classified, with an exhaustive test.
   Head rows remain in `conversation`; other kinds belong to `system`.

   Only the `/api/sessions/:sessionId/log` display responses (window and
   entry) carry `wake_source` and `trigger_message_id` from
   `multiremi_turns` and attach a derived `layer`. Shared card/log
   materialization, message ranges, agent JSONL and Hub payloads retain the
   main `8d761976` wire bytes. Issue and Chat use the same function for cached rows that
   lack `layer`. A system turn displays "X 查看新消息" even when its prompt is
   an English report. Reply previews of system parents reuse the same human
   summary in both system-detail modes. `workspace_move_cleared` is a conversation activity;
   its platform message follows the system rule. No schema change, writer
   layer, migration or backfill is needed.

   **Reserved for the next 2b segment:** `window()` and `/log?layer=conversation`
   filtering, response window-layer echo, SSR wiring and SQL/function parity
   tests. Page sizes, counts and `visibility` are unchanged in this segment.

   The planned filtering has three read rules. Replica fills (`readRange`,
   frame hydration) always read every layer. A presentation window keeps one layer for its lifetime:
   `loadTail` and its pages use the effective display layer; a deep-link visit
   (`loadAround` and its pages) always uses `all`, because the target may be a
   system row and the activity spans of adjacent pages are only exact under one
   predicate; any change of the effective layer reloads the window instead of
   merging. SSR reads `conversation` for a plain visit and `all` for a deep
   link; the reveal gate additionally requires the window's layer to equal the
   effective display layer, so a reader whose saved preference is "show system
   details" pays one re-read before the first frame rather than seeing rows
   appear afterwards. The client-side filter remains the authority for what is
   drawn.

5. **Grouping is decided once per group.** A run of three or more consecutive
   second-layer items (delegation lines and activity lines) folds into one row.
   The newest group is expanded when it first appears; no group changes its
   state without a user click, so a later comment never collapses the group
   above it.

## Alternatives considered

- **Mirror activity into the log as a new shown kind.** One seq axis, no new
  read path. Rejected: historical activity cannot be interleaved (every
  existing Issue would show nothing), every agent projection would carry the
  new kind, the session to write to is fixed at write time, and rollback has to
  delete persisted rows out of OPFS caches.
- **Mirror as a hidden marker and merge at read time.** Hidden rows are
  excluded from the window read by design; it is the second alternative with
  extra steps.
- **Second request from the frontend (`/api/issues/:id/activity`).** Same
  client model, but a second first-screen request, a new route to register in
  the CLI, and the client has to compute the time spans that the server already
  knows from the window it is answering.
- **Interleave activity into `entries` with pseudo seqs.** Breaks seq
  coverage, the replica's primary key and the hub's dedupe rule.
- **Over-fetch instead of a `layer` filter.** Keeps the server untouched but
  leaves "还有 N 条更早" overcounting and costs a second window read before the
  first reveal on busy sessions.

## Consequences

- **Positive:** existing Issue activity is available without a backfill, subject
  to the per-window cap; the
  log, the hub and the agents' views do not change; rollback is a frontend
  revert (the query flag becomes dead and harmless).
- **Positive:** one first-screen request, same as step 1; the extra server work
  is one indexed range read on `(issue_id, created_at)`.
- **Negative:** ordering between an activity and a log row is by `created_at`,
  not by seq. Two writes in the same millisecond, or rows whose `created_at`
  does not increase with seq, can place a line one slot away from where a seq
  would have put it. The placement is deterministic and bounded by the window.
- **Negative:** the "N 条新消息" chip is derived from `head_seq` and does not
  count activity that arrives while the reader is released.
- **Negative:** a group's id is its earliest member; loading an older page can
  merge a group at the top of the window into a larger one, which resets a
  manual expand or collapse of that group.
- **Negative:** `issue_updated` rows store only the new values (`data` is the
  update input), so historical lines read "把状态改为 X" without the previous
  value; new rows carry a `previous` snapshot.
- **Positive:** changing a layer rule requires only a code change; rollback
  does not leave a new column or backfilled values behind.

## Step-2a implementation

- The allowlist and activity details shape live in `packages/contracts/src/issue-activity.ts`.
  Ordinary comment audits never repeat their log rows; mention/replay
  notifications belong to system details. Step 2b's first segment includes
  `workspace_move_cleared` activity and hides its platform message by default.
  Each cleared reference keeps its own field/name; these activities are not
  coalesced, and names render as literal text rather than Markdown summaries.
- New `issue_updated` records carry only changed fields in `data.previous`.
  Historical records without it use new-value-only wording. Metadata, position
  and archive-only updates produce no visible property line.
- Agent assignment audits are suppressed when a loaded delegation turn has
  the same agent within ten seconds and the same author. A system-authored turn
  matches by agent and time only. Member assignments and unassignments remain.
- Activity trailers use the existing log row height cache. Their member IDs,
  revisions/content, expansion and truncation choices enter `render_version`.
  Both expansion and the eight-row default truncation are fixed on first sight;
  a later comment cannot expand or collapse an existing group.
- Default-session SSR reads include the sidecar in the same log response.
  Live activities append only at the tail; midstream views wait for navigation
  back to the latest window. No activities are persisted in C7 or given seqs.
- HTTP readers opt in with `/log?with_activity=1`; the former
  `remi session log window` command was retired by the unified model.
  Side sessions and Chats ignore the flag. The existing entries and counts keep
  their log meaning. Hidden log rows still consume the 2a page size until 2b.

## Reversal conditions

Reopen this ADR if (a) the product asks for activity in side sessions or in
agents' context, which makes the log the right home and MUL-493 the right
issue; or (b) measured tail windows on production carry more than 200
activities often enough that the cap is visible to users.
