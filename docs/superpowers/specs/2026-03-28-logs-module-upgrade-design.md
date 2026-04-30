# Logs Module Full Upgrade — Design Spec

**Date:** 2026-03-28
**Branch:** dashboard-redesign
**Status:** Draft

## Overview

Full upgrade of the Logs page in the Remi Dashboard: monitoring overview (stat cards + hourly distribution chart) on top, enhanced log stream with inline detail expansion below. Zero new runtime dependencies — pure CSS chart, existing shadcn/ui components.

## Architecture

```
┌─────────────────────────────────────────────────┐
│ GET /api/v1/logs/stats                          │  NEW
│   → { levels, hourly[], modules, lastError }    │
├─────────────────────────────────────────────────┤
│ GET /api/v1/logs?search=...                     │  ENHANCED (new param)
│   → { entries[], total, hasMore }               │
├─────────────────────────────────────────────────┤
│ GET /api/v1/logs/modules                        │  UNCHANGED
│   → string[]                                    │
└─────────────────────────────────────────────────┘
         ↓                    ↓
   Zustand store         Zustand store
   (stats slice)         (entries slice)
         ↓                    ↓
┌────────────────────────────────────────────────┐
│              Logs Page Layout                   │
│ ┌──────────────────────────────────────────┐   │
│ │  4x StatCard  (row)                      │   │
│ ├──────────────────────────────────────────┤   │
│ │  HourlyChart  (CSS bar chart)            │   │
│ ├──────────────────────────────────────────┤   │
│ │  FilterBar    (enhanced)                 │   │
│ ├──────────────────────────────────────────┤   │
│ │  LogTable + LogDetailRow (accordion)     │   │
│ └──────────────────────────────────────────┘   │
└────────────────────────────────────────────────┘
```

## 1. Backend Changes

### 1.1 New Endpoint: `GET /api/v1/logs/stats`

Returns aggregated statistics for a given date.

**Query params:** `date` (default: today)

**Response:**

```typescript
interface LogStats {
  total: number;
  levels: { DEBUG: number; INFO: number; WARN: number; ERROR: number };
  hourly: Array<{ hour: number; count: number; errors: number }>;
  moduleCount: number;
  topModules: string[];          // top 5 by count
  lastError: string | null;      // ISO timestamp of most recent ERROR
  lastErrorModule: string | null;
}
```

**Implementation:** Add `getLogStats(date)` method to `RemiData` class. Reads the same JSONL file as `getLogs()`, iterates once to compute all aggregates. Register handler in `web/handlers/logs.ts`.

### 1.2 Enhanced `GET /api/v1/logs` — `search` param

Add optional `search` query param. When provided, filters entries where `msg` contains the search string (case-insensitive substring match).

**Implementation:** Add `search` filter in `RemiData.getLogs()` after existing filters:

```typescript
if (query.search) {
  const s = query.search.toLowerCase();
  entries = entries.filter(e => e.msg.toLowerCase().includes(s));
}
```

### 1.3 No other backend changes

- `getLogModules()` unchanged
- No new dependencies
- No SSE/WebSocket (polling via frontend toggle)

## 2. Zustand Store Changes

### 2.1 New state fields in `useLogsStore`

```typescript
// Stats
stats: LogStats | null;
statsLoading: boolean;
fetchStats: () => Promise<void>;

// Search
search: string | null;

// Auto-refresh
autoRefresh: boolean;
toggleAutoRefresh: () => void;

// Expanded row
expandedIndex: number | null;
setExpandedIndex: (i: number | null) => void;
```

### 2.2 `fetchStats()`

Calls `GET /api/v1/logs/stats?date={date}`. Called on mount and when date filter changes.

### 2.3 `search` filter

Added to `setFilter()` and included in `fetchLogs()` API call as `search` query param.

### 2.4 Auto-refresh

`toggleAutoRefresh()` flips `autoRefresh` boolean. The component sets up a `setInterval(30000)` when `autoRefresh` is true, calling `fetchLogs()` + `fetchStats()`.

## 3. Frontend Components

### 3.1 StatCard (reuse from Traces page pattern)

4 cards in a responsive grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`):

| Card | Value | Sub | Variant |
|------|-------|-----|---------|
| Total Entries | `stats.total` | "Today" | default |
| Errors | `stats.levels.ERROR` | `{errorRate}% error rate` | destructive if > 0 |
| Active Modules | `stats.moduleCount` | top 3 module names | default |
| Last Error | relative time | `{timeAgo} · {module}` | warning |

### 3.2 HourlyChart (new component)

Pure CSS bar chart in a Card. No chart library dependency.

- 24 bars (one per hour), flex layout
- Bar height proportional to `hourly[i].count / max(counts)`
- Error portion shown as red overlay at bar top: `errors / count` ratio
- Future hours rendered with muted background
- Hour labels at 00, 06, 12, 18, 23

**Component:** `web/frontend/src/components/HourlyChart.tsx`

**Props:**
```typescript
interface HourlyChartProps {
  data: Array<{ hour: number; count: number; errors: number }>;
  currentHour?: number;
}
```

### 3.3 Enhanced FilterBar

Wrapped in a Card. Single row with flex-wrap:

1. **Filter icon** (hidden on mobile)
2. **Date input** — `<Input type="date">`, unchanged behavior
3. **Level select** — `<Select>` with `(>=)` suffix hint in placeholder to communicate hierarchical filtering
4. **Module select** — `<Select>`, unchanged behavior
5. **Search input** — NEW: `<Input>` with search icon, debounced 300ms, filters by `msg` content
6. **Trace ID input** — `<Input>` with search icon prefix
7. **Entry count** — `{total} entries`, right-aligned
8. **Auto-refresh toggle** — Button with green dot when active, "Auto 30s" label
9. **Refresh button** — Manual refresh with spinning icon when loading

### 3.4 LogTable with Accordion Detail

Replace current flat table with expandable rows.

**Table columns** (unchanged widths, responsive hiding preserved):
- Time (100px)
- Level (80px) — Badge component with variant mapping
- Module (110px, hidden sm)
- Message (1fr, truncated)
- Trace (120px, hidden md) — clickable link to traces page
- Actions (50px) — copy button

**Click behavior:** Clicking a row toggles `expandedIndex`. If already expanded, collapses. Only one row expanded at a time.

**LogDetailRow** (expanded content below the clicked row):

Two-column grid layout:
- **Left:** Full message text (no truncation)
- **Right:** Metadata (module, trace link, span ID)
- **Bottom full-width:** JSON `data` field with syntax highlighting (manual color spans, no dependency)
- **Action buttons:** Copy JSON, Copy Full Entry, View Trace (navigates to `#/traces?traceId=...`)

**Syntax highlighting:** Simple manual coloring:
- String values: blue
- Number values: yellow
- Keys: green
- Punctuation: gray

Uses `JSON.stringify(data, null, 2)` then regex-based span wrapping. No external library.

### 3.5 Responsive Behavior

Maintained via Tailwind responsive classes (same approach as current):
- `< sm`: Hide Module and Trace columns
- `< md`: Hide Trace column only
- StatCards: `grid-cols-1` on mobile, `grid-cols-2` on sm, `grid-cols-4` on lg
- HourlyChart: Full width, bar labels hidden on mobile

### 3.6 Auto-refresh Implementation

```typescript
useEffect(() => {
  if (!autoRefresh) return;
  const id = setInterval(() => {
    fetchLogs();
    fetchStats();
  }, 30_000);
  return () => clearInterval(id);
}, [autoRefresh, date, level, module, search, traceId]);
```

Interval resets when any filter changes. Toggle button shows green dot + "Auto 30s" when active.

## 4. API Client Changes

### 4.1 New function

```typescript
export const getLogStats = (date?: string) =>
  request<LogStats>(`/api/v1/logs/stats${date ? `?date=${date}` : ""}`);
```

### 4.2 Enhanced getLogs

Add `search` to params:

```typescript
export const getLogs = (params: {
  date?: string; level?: string; module?: string;
  traceId?: string; search?: string;  // NEW
  limit?: number; offset?: number;
}) => request<LogQueryResult>(`/api/v1/logs?${qs.toString()}`);
```

### 4.3 New type

Add `LogStats` interface to `web/frontend/src/api/types.ts`.

## 5. Files to Create / Modify

| File | Action | Description |
|------|--------|-------------|
| `web/remi-data.ts` | Modify | Add `getLogStats()` method |
| `web/handlers/logs.ts` | Modify | Register `/api/v1/logs/stats`, add `search` param to `/api/v1/logs` |
| `web/frontend/src/api/types.ts` | Modify | Add `LogStats` interface |
| `web/frontend/src/api/client.ts` | Modify | Add `getLogStats()`, add `search` to `getLogs()` |
| `web/frontend/src/stores/logs.ts` | Modify | Add stats, search, autoRefresh, expandedIndex state |
| `web/frontend/src/components/HourlyChart.tsx` | Create | Pure CSS hourly distribution chart |
| `web/frontend/src/pages/Logs.tsx` | Modify | Full rewrite with new layout |

## 6. Non-Goals

- No SSE / WebSocket real-time push (polling is sufficient for Remi's log volume)
- No cross-day query (single date per view)
- No chart library dependency (Recharts etc.)
- No virtual scrolling (log volume doesn't warrant it)
- No keyboard navigation shortcuts

## 7. Design Mockup

See `.superpowers/brainstorm/` for the interactive HTML mockup showing the complete page layout with all sections.
