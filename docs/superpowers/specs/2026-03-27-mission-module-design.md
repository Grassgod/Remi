# Mission Module Redesign — Design Spec

**Date:** 2026-03-27
**Branch:** dashboard-redesign
**Style:** Linear-inspired, minimal engineering aesthetic

## Overview

Redesign the Mission module with three view modes (Kanban, List, Detail), focusing on visual polish while reusing existing data layer and APIs.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Visual style | Linear-inspired (clean, engineering) | User preference |
| List view layout | Grouped list by status | Better visual hierarchy than flat table |
| Detail page content | Basic info + conversation flow | Sufficient without execution logs |
| Summary stats cards | Remove | Info already visible in list/kanban |

## View Modes

### 1. List View (Default) — Grouped by Status

**Toggle:** Top-level `Kanban / List` button group.

**Group order** (active first):
1. Blocked (red `#f87171`)
2. In Progress (orange `#fb923c`)
3. Inbox (gray `#a1a1aa`)
4. In Review (purple `#a78bfa`)
5. Approved (blue `#60a5fa`)
6. Done (green `#4ade80`) — collapsed by default
7. Rejected (red `#f87171`) — collapsed by default

**Group header:** Status dot + label + count + divider line.

**Row card:**
- Left color bar (3px, status color)
- Title (13px, font-weight 500)
- Subtitle: `project · step · createdByName`
- PR badge (if mrUrl exists): green for open, orange for review
- Cost ($x.xx)
- Relative time
- Right arrow `›` → navigates to detail page

**Interactions:**
- Click row → navigate to `/missions/:id`
- Click group header → toggle collapse/expand

### 2. Kanban View

Existing 4-column layout, restyled to match Linear aesthetic:
- Columns: Inbox | In Progress | In Review | Done
- Other statuses in separate "Other" card below
- Cards use same Badge/color system as List view
- Remove top summary stat cards (redundant)
- Click card → navigate to `/missions/:id`

### 3. Detail Page — `/missions/:id`

**Layout:** Two-column, 70/30 split.

**Left column (main):**
- Back button (`← Missions`)
- Title (h2) + description
- Pipeline progress bar: `intake → rfc → decompose → execute → eval → summary`
  - Completed steps: filled dot + green
  - Current step: pulsing dot + accent color
  - Future steps: hollow dot + muted
- Conversation flow section:
  - Fetched from `GET /api/v1/conversations/:chatId/messages?threadId=xxx`
  - Rendered as chat bubbles (user vs bot)
  - Timestamps between message groups

**Right column (sidebar):**
- Status badge (large, with color)
- Current step badge
- Project name
- Created by (name)
- MR link (clickable, shows status icon)
- Stats: Token count, Cost ($), Duration
- Contract section:
  - List of acceptance criteria
  - Verification results (pass/fail per case) if available
- Timestamps: created, updated, completed

## Routes

| Route | Component | Description |
|-------|-----------|-------------|
| `/missions` | `MissionsPage` | List/Kanban toggle view |
| `/missions/:id` | `MissionDetail` | Detail page |

## File Structure (new/modified)

```
web/frontend/src/
├── pages/
│   ├── Missions.tsx          # Refactor: add view toggle, list view
│   └── MissionDetail.tsx     # NEW: detail page
├── components/
│   └── missions/
│       ├── MissionListView.tsx    # NEW: grouped list component
│       ├── MissionKanbanView.tsx  # NEW: extracted kanban component
│       ├── MissionCard.tsx        # NEW: shared card component
│       └── PipelineProgress.tsx   # NEW: step progress bar
├── api/
│   └── client.ts             # May need: getConversationMessages()
└── api/
    └── types.ts              # May need: ConversationMessage type
```

## Color System

Reuse existing Tailwind + OKLch CSS variables. Status-specific colors:

```
inbox:       #a1a1aa (zinc-400)
approved:    #60a5fa (blue-400)
in_progress: #fb923c (orange-400)
in_review:   #a78bfa (violet-400)
done:        #4ade80 (green-400)
blocked:     #f87171 (red-400)
rejected:    #f87171 (red-400)
```

## API Dependencies

All APIs already exist:
- `GET /api/v1/missions` — list with filters
- `GET /api/v1/missions/:id` — single detail
- `PATCH /api/v1/missions/:id` — update status
- `GET /api/v1/conversations/:chatId/messages?threadId=xxx` — conversation flow

## Out of Scope

- Drag-and-drop reordering
- Approve/reject buttons (not yet implemented in backend)
- WebSocket real-time updates
- Execution logs / Trace integration
- Skill feedback records
