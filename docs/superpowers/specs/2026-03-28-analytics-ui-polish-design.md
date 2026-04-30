# Analytics Module UI/UX Polish — Design Spec

**Date:** 2026-03-28
**Branch:** dashboard-redesign
**Scope:** UI/UX improvements only, no new features

## Overview

Address 7 UI/UX issues found in the Analytics page during review. Fixes light mode compatibility, improves interaction feedback, and polishes visual details.

## Changes

### 1. SVG Chart Light Mode Fix (P0)

`SvgBarChart` and `SvgDonut` hardcode white-family colors, making text and grid lines invisible in light mode.

**Replace hardcoded colors with CSS variables:**

| Hardcoded | Replace with | Usage |
|-----------|-------------|-------|
| `rgba(255,255,255,0.3)` | `var(--muted-foreground)` | Axis labels, legend text |
| `rgba(255,255,255,0.4)` | `var(--muted-foreground)` | Legend text |
| `rgba(255,255,255,0.06)` | `var(--border)` | Grid lines |
| `rgba(255,255,255,0.04)` | `var(--muted)` | Donut background ring |
| `var(--text-bright)` | `var(--foreground)` | Donut center value (text-bright undefined) |
| `var(--text-dim)` | `var(--muted-foreground)` | Empty state text (text-dim undefined) |

Data segment colors (cyan, green, amber) remain unchanged — visible in both themes.

**Files:** `SvgBarChart.tsx`, `SvgDonut.tsx`

### 2. Refresh Button Consolidation + Loading State (P1)

**Problem:** Two identical Refresh buttons (14-Day Chart, Recent Requests) both trigger full data refresh. `fetchRecent` doesn't set `loading: true`, so table has no refresh feedback.

**Solution:**
- Remove both local Refresh buttons
- Add one global Refresh button in page header (Layout title area, right side)
- Store changes in `analytics.ts`:
  - `fetchRecent` sets `loading: true` at start
  - Add `refreshing: boolean` state to distinguish initial load vs manual refresh
- Visual feedback:
  - Initial load: show "LOADING..." (existing behavior)
  - Manual refresh: keep current data visible, spinner on Refresh button, no content flash

**Files:** `Analytics.tsx`, `stores/analytics.ts`

### 3. Est. Cost Card — Remove Threshold Coloring

**Problem:** `todayCost > 5` hardcoded warning is meaningless for subscription usage.

**Solution:** Remove variant logic from Est. Cost StatCard entirely. Always use default foreground color. Cost is informational only.

**Files:** `Analytics.tsx`

### 4. Bar Chart Hover Tooltip

**Problem:** SVG `<title>` tooltip is slow, ugly, and doesn't work on mobile.

**Solution:** Custom React tooltip using state:
- `hoveredBar: { index, x, y } | null` state in SvgBarChart
- On mouse enter bar → set state, show floating div above bar
- Content: date, Input/Output/Cache/Total values formatted
- Style: `bg-popover text-popover-foreground shadow-md rounded-md`, font-mono 10px
- Mobile: tap to show, tap elsewhere to dismiss
- Remove all `<title>` elements
- Tooltip positioned via `foreignObject` or absolute-positioned div overlay

**Files:** `SvgBarChart.tsx`

### 5. StatCard + Table + Badge Polish

**5a. StatCard hover enhancement**
- Replace `hover:bg-accent/30` with `hover:border-primary/20`
- Add `transition-all duration-200`
- Border-based feedback is more visible than near-invisible background shift

**5b. Table row hover**
- Add `hover:bg-muted/50` to `<TableRow>` in Recent Requests body

**5c. Badge variant fix**
- `remi` source → `outline` (unchanged)
- Other sources → `secondary` (neutral) instead of `warning` (alarming)

**Files:** `Analytics.tsx`

### 6. Mobile Donut Responsiveness

- Donut size: 140px desktop, 120px mobile
- Detection: use a simple `useIsMobile()` hook (or existing one if available) based on `window.innerWidth < 640`
- Legend gap: reduce to `4px 10px` on mobile
- No component API changes — size prop passed from Analytics page

**Files:** `Analytics.tsx` (size prop), `SvgDonut.tsx` (legend gap responsive)

### 7. "unknown" Model Gray Color

- When building `modelSegments`, if model name is `"unknown"` or empty string, use `rgba(128,128,128,0.5)` instead of cycling MODEL_COLORS
- Sort unknown/empty to end of segments array

**Files:** `Analytics.tsx`

## Files Affected (Summary)

| File | Changes |
|------|---------|
| `SvgBarChart.tsx` | CSS vars, tooltip |
| `SvgDonut.tsx` | CSS vars, legend gap |
| `Analytics.tsx` | Refresh consolidation, cost card, StatCard hover, table hover, badge, donut size, unknown model color |
| `stores/analytics.ts` | loading/refreshing state |

## Out of Scope

- No new features (date picker, filters, export)
- No backend changes
- No data accuracy fixes
- No changes to Subscription Usage card logic
