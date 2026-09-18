# Inbox vs. Workbench — routing and reading boundaries

This document describes the current routing rules, stored-event boundaries, paginated
reading model, and badge counts. Implementation entry points are the
[routing registry](../packages/server/src/store/inbox-routing.ts),
[inbox API](../packages/server/src/api/routers/inbox.ts), and
[frontend grouping](../frontend/packages/core/inbox/grouping.ts).

## The two surfaces

| | Workbench (工作台) | Inbox (收件箱) |
|---|---|---|
| Question it answers | *What is waiting on me right now?* | *What happened while I wasn't looking?* |
| Storage | none — live query over `GET /api/issues?status=…` | `multiremi_inbox_items`, durable rows |
| Read state | none | read / archived per row |
| Freshness | real-time, self-clearing when the issue moves on | durable events, with read/archive state changed by the human |
| Grain | one row per **issue** | one row per **event** |
| Attention cost | primary badge, meant to be checked continuously | secondary, meant to be checked periodically |

The workbench sections are `in_review` (split into *awaiting reply* / *awaiting review*
via the `awaiting_human` agent-task snapshot), `blocked`, and `in_progress`
(`frontend/packages/core/issues/workbench.ts`). Call these the
**workbench-visible statuses**.

## The rule

Answer the four questions in order. The first `yes` decides the route; nothing downstream
gets a second vote.

**R1 — Is the event *addressed to me personally*?**
(assigned to me, `@`-mentioned me, review requested from me)
→ **Inbox, action lane.** Unconditional. The workbench works at issue grain and can only
say "this issue is waiting"; it can never say *who called your name and why*. A directed
event is never absorbed by issue-level visibility.

**R2 — Is it a broadcast about the state or progress of an issue that is currently in a
workbench-visible status?**
→ **Workbench only. Do not write an inbox row.** The workbench already shows that issue,
live, and opening it shows the full context. An inbox row here is pure duplication — it is
the thing this issue set out to remove. The event still lands in the issue activity feed,
the session timeline, and the `comment:created` realtime event; nothing is lost, it just
stops competing for attention twice.

**R3 — Is it the *conclusion of an automated run* that belongs to no human processing
queue?**
(autopilot / scheduled-task terminal status, inspection-bot report, system anomaly)
→ **Inbox, ledger lane.** This is the inbox's headline job: the user asked to be able to
confirm "did the scheduled job run, and how did it go" without opening the workbench.

**R4 — Anything else**
→ **Activity feed only.** No inbox row, no badge.

### Registering a new source

Every inbox `type` must have a row in `INBOX_ROUTING`
(`packages/server/src/store/inbox-routing.ts`) naming its lane and the rule that put it
there. `inboxRouteFor()` returns `activity_only` for an unregistered type, so a producer
added without a registry entry is silently dropped rather than silently spamming — and a
unit test enumerates every `createInboxItem` call site to make that failure loud in CI.
The registry also owns the default severity used by `createInboxItem`; any explicit
producer override is tested against that registered value.

Routes that depend on the issue's status at emit time (R2) pass it in:
`inboxRouteFor(type, { issueStatus })`.

## Where the existing producers landed

| Producer | Site | Rule | Route | Why |
|---|---|---|---|---|
| `comment_created` | `issues-repo.ts` `notifySubscribedMembers` | R2 | **removed from inbox** when the issue is workbench-visible | The issue creator is auto-subscribed to every issue they create, so in the single-operator setup *every* agent progress comment minted an inbox row — for an issue sitting in the workbench's *in progress* / *awaiting review* section at that exact moment. This is the duplication the user felt. Falls back to R1/R4 otherwise: a **human** comment on an issue in a non-workbench status (`todo`, `backlog`, `done`) still notifies, because nothing else would. |
| `issue_assigned` | `issues-repo.ts` `assignIssue` | R1 | **kept**, severity `info` | Re-checked against the code: assigning to a *member* leaves the issue in its current status (only an agent assignee forces `todo`), and none of `todo`/`backlog` is a workbench section — so the workbench does **not** cover this today. It is a directed, low-urgency "you now own this". Kept, but demoted so it no longer drives the badge. |
| `comment_mention` | `issues-repo.ts` `triggerMemberMentions` | R1 | **kept** | Directed at a person, at comment grain. The workbench cannot express it at any status. |
| `autopilot_paused` | `autopilots-repo.ts` `emitAutopilotPausedNotifications` | R3 | **kept**, severity `attention` | A durable automation event. |

## Automation outcomes (R3)

Emitted from the autopilot-run terminal handler in
`packages/server/src/store/repos/tasks-repo.ts` (`afterTaskTerminal`, the block that flips
`multiremi_autopilot_runs.status`), so every scheduled and event-triggered run reports its
own conclusion:

- `autopilot_run_completed` — severity `info`. Title carries the autopilot name and the
  outcome; body carries duration, trigger kind and a result summary.
- `autopilot_run_failed` — severity `attention`. Body carries the failure reason.

Both put `autopilot_id`, `autopilot_title`, `run_id`, `task_id`, `trigger`,
`duration_seconds` and `issue_id` in `details`, so the list row is self-explanatory without
opening it.

`autopilot_run_overdue` (scheduled window elapsed without a run reaching a terminal state)
is registered in `INBOX_ROUTING` as an R3 ledger type but has **no producer yet** — it needs
the inspection bot, which is a separate issue. The registry entry is the seam it plugs into.

## Attention budget

The two badges must not mean the same thing.

- **Workbench badge** — unchanged: `in_review.total + blocked.total`, primary style. "Do
  something now."
- **Inbox badge** — counts unread visible notifications at severity
  `attention` or higher only, rendered in a muted style. `info` rows (run completed,
  assignment) still show as unread inside the page but never raise a badge. "Read this when
  you get around to it."

Both inbox counts come from `GET /api/inbox/summary`, independently of loaded pages.
`attention` counts unread `attention` / `action_required` entries after issue-level
deduplication. `unread` additionally collapses successful runs of the same autopilot
within each date group, counting the group as unread if any covered event is unread.
The client sends its `Date.getTimezoneOffset()` value as `timezone_offset` for date
grouping. The [summary query](../frontend/packages/core/inbox/queries.ts) has a 30-second
stale time; mutations and realtime events invalidate the relevant cache. The legacy
`/api/inbox/unread-count` endpoint counts raw rows and is not the sidebar's count source.

## Browsing model

The [inbox page](../frontend/packages/views/inbox/components/inbox-page.tsx) reads
`GET /api/inbox/page?limit=50&cursor=…` through an infinite query. The API returns
`items`, `limit`, `has_more`, and `next_cursor`; the server caps the page size at 100
and uses `created_at DESC, id DESC` cursor order. The original `/api/inbox` full-list
endpoint remains for compatibility. A Load more button appends pages.

Display transformations apply to the loaded pages:

- rows grouped by day (Today / Yesterday / This week / Earlier);
- a source filter (All / Message stream / Automation / Mentions / Assignments);
- **mark this group read** in addition to the existing mark-all-read;
- R3 ledger events retain one stored row and selection identity per event. Successful
  runs of the same autopilot within a date group collapse into one display entry;
  failures remain separate. R1/R2 action notifications retain the latest row per issue;
- every row shows a one-line self-contained summary from `details`, so a sweep down the
  list is enough to know what happened.

Reading or archiving a collapsed entry updates every loaded event represented by it;
date-group operations likewise use loaded items. Mark-all and archive-all operations
act on the member's full server-side inbox. Source filters do not query unseen pages,
so an empty filtered view does not prove the full inbox has no matching notification.

Links to entries beyond the loaded pages trigger further page reads before deciding
the entry is unavailable. A failed page request does not trigger a missing-item redirect.
After all pages are exhausted, an unresolved `?issue=` link can fall back to the issue
page; an unresolved `?item=` link remains in the inbox with an unavailable state.
[Mutations](../frontend/packages/core/inbox/mutations.ts) and
[WS updaters](../frontend/packages/core/inbox/ws-updaters.ts) maintain both the legacy
list cache and paginated cache, and refresh summary counts.

## Issue deletion lifecycle

Deleting an issue must not erase the automation history that the ledger exists to retain.
The service handles inbox rows explicitly instead of relying on database foreign-key
cascades: R3 ledger rows remain, their live `issue_id` link is set to `NULL`, and the
original source id remains in `details.issue_id` as historical context. R1/R2 action rows
are deleted because their target no longer exists and they have no standalone ledger
value. Realtime cache updates apply the same rule, so rows do not disappear and reappear
after a refetch. A detached ledger row renders its self-contained title, type, time and
body without offering a broken issue link.

## Invariants

- The workbench stays a storage-free, read-state-free live query. No inbox row, read state,
  or badge logic may leak into `frontend/packages/core/issues/workbench.ts` or
  `workbench-page.tsx`. Sections, ordering and badge arithmetic are unchanged.
- Inbox changes must preserve `nextIssueStatusAfterTaskTerminal`
  (`packages/server/src/store/repos/tasks-repo.ts`) and issue-status transition semantics.
- `member_id` on an inbox row is a **member** id (`mem_<workspace>_<user>`), while the auth
  context carries a **user** id. Every read and write converts explicitly — see
  `resolveWorkspaceMemberForNotification` and the note in `api/helpers/auth-guards.ts`.

## Verification

The [API tests](../tests/unit/multiremi/multiremi-api-search-inbox.test.ts) cover cursor
pages and summary counts; [page tests](../frontend/packages/views/inbox/components/inbox-page.test.tsx)
and [mutation tests](../frontend/packages/core/inbox/mutations.test.tsx) cover loading
and operations on represented rows. These are verification entry points, not a claim
that they ran during this documentation update. Performance limits and measurement
conditions are documented in [the performance guide](dev/performance.md).

## Out of scope

Outbound delivery (Lark, email) and per-channel routing in the notification preferences —
tracked separately. This change only decides *what earns a row* and *how it is read*.
