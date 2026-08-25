# Inbox vs. Workbench — routing boundary (MUL-108)

Two surfaces had grown into each other. This document fixes the split, gives a reusable
decision rule every future notification source must answer, and records where each
existing producer landed.

## The two surfaces

| | Workbench (工作台) | Inbox (收件箱) |
|---|---|---|
| Question it answers | *What is waiting on me right now?* | *What happened while I wasn't looking?* |
| Storage | none — live query over `GET /api/issues?status=…` | `multiremi_inbox_items`, durable rows |
| Read state | none | read / archived per row |
| Freshness | real-time, self-clearing when the issue moves on | append-only ledger, cleared by the human |
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
| `autopilot_paused` | `autopilots-repo.ts` `emitAutopilotPausedNotifications` | R3 | **kept**, severity `attention` | The canonical ledger event, and the only automation-outcome source that existed. |

## New producers (R3) — automation outcomes

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
- **Inbox badge** — no longer the raw unread count. Counts unread rows at severity
  `attention` or higher only, rendered in a muted style. `info` rows (run completed,
  assignment) still show as unread inside the page but never raise a badge. "Read this when
  you get around to it."

## Browsing model

The inbox is read in periodic batches, not one row at a time:

- rows grouped by day (Today / Yesterday / This week / Earlier);
- a source filter (All / Automation / Mentions / Assignments);
- **mark this group read** in addition to the existing mark-all-read;
- R3 ledger events remain one row per event even when several runs share an issue; R1/R2
  action notifications retain the existing one-row-per-issue grouping;
- every row shows a one-line self-contained summary from `details`, so a sweep down the
  list is enough to know what happened.

## Issue deletion lifecycle

Deleting an issue must not erase the automation history that the ledger exists to retain.
The service handles inbox rows explicitly instead of relying on database foreign-key
cascades: R3 ledger rows remain, their live `issue_id` link is set to `NULL`, and the
original source id remains in `details.issue_id` as historical context. R1/R2 action rows
are deleted because their target no longer exists and they have no standalone ledger
value. Realtime cache updates apply the same rule, so rows do not disappear and reappear
after a refetch. A detached ledger row renders its self-contained title, type, time and
body without offering a broken issue link.

## Invariants this change must not break

- The workbench stays a storage-free, read-state-free live query. No inbox row, read state,
  or badge logic may leak into `frontend/packages/core/issues/workbench.ts` or
  `workbench-page.tsx`. Sections, ordering and badge arithmetic are unchanged.
- `nextIssueStatusAfterTaskTerminal` (`packages/server/src/store/repos/tasks-repo.ts`) and
  the issue-status transitions around it are untouched.
- `member_id` on an inbox row is a **member** id (`mem_<workspace>_<user>`), while the auth
  context carries a **user** id. Every read and write converts explicitly — see
  `resolveWorkspaceMemberForNotification` and the note in `api/helpers/auth-guards.ts`.

## Out of scope

Outbound delivery (Lark, email) and per-channel routing in the notification preferences —
tracked separately. This change only decides *what earns a row* and *how it is read*.
