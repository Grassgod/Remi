# Analytics UI/UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix light mode compatibility, consolidate refresh UX, add bar chart tooltips, and polish visual details across the Analytics page.

**Architecture:** All changes are frontend-only on the `dashboard-redesign` branch. Four files modified: two SVG chart components get CSS variable colors, the analytics store gains a `refreshing` flag, and the Analytics page gets consolidated refresh + visual polish. No backend changes.

**Tech Stack:** React, TypeScript, Zustand, Tailwind CSS, SVG

---

### Task 1: SvgDonut — CSS Variable Colors

**Files:**
- Modify: `web/frontend/src/components/SvgDonut.tsx`

- [ ] **Step 1: Replace hardcoded colors with CSS variables**

Replace the entire file content of `SvgDonut.tsx` with:

```tsx
interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface SvgDonutProps {
  segments: DonutSegment[];
  centerLabel: string;
  centerValue: string;
  size?: number;
}

export function SvgDonut({ segments, centerLabel, centerValue, size = 160 }: SvgDonutProps) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) {
    return (
      <div style={{ height: size, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted-foreground)" }}>
        NO DATA
      </div>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.35;
  const strokeWidth = size * 0.12;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Background ring */}
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke="var(--muted)" strokeWidth={strokeWidth} />

        {/* Segments */}
        {segments.map((seg, i) => {
          const pct = seg.value / total;
          const dash = pct * circumference;
          const currentOffset = offset;
          offset += dash;

          return (
            <circle
              key={i}
              cx={cx} cy={cy} r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-currentOffset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ transition: "stroke-dasharray 0.5s ease" }}
            >
              <title>{`${seg.label}: ${seg.value.toLocaleString()} (${(pct * 100).toFixed(1)}%)`}</title>
            </circle>
          );
        })}

        {/* Center text */}
        <text x={cx} y={cy - 6} textAnchor="middle" fill="var(--muted-foreground)" fontSize={8} fontFamily="var(--font-mono)" letterSpacing={1}>
          {centerLabel}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="var(--foreground)" fontSize={16} fontFamily="var(--font-display)" fontWeight={700}>
          {centerValue}
        </text>
      </svg>

      {/* Legend */}
      <div className="donut-legend" style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", justifyContent: "center" }}>
        {segments.filter(s => s.value > 0).map((seg, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: seg.color, flexShrink: 0 }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--muted-foreground)" }}>
              {seg.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

Changes from original:
- `var(--text-dim)` → `var(--muted-foreground)` in empty state
- `rgba(255,255,255,0.04)` → `var(--muted)` for background ring
- `rgba(255,255,255,0.3)` → `var(--muted-foreground)` for center label
- `var(--text-bright)` → `var(--foreground)` for center value
- `var(--text-muted)` → `var(--muted-foreground)` for legend text
- Added `className="donut-legend"` to legend div (used in Task 6 for mobile gap)

- [ ] **Step 2: Visual verification**

Open `http://10.37.66.8:5199/#/analytics` and toggle between dark/light mode. Verify:
- Donut center text is visible in both modes
- Background ring is subtle but visible in both modes
- Legend text is readable in both modes
- Segment colors (cyan, green, blue, amber) remain vivid in both modes

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/components/SvgDonut.tsx
git commit -m "fix(analytics): use CSS variables in SvgDonut for light mode support"
```

---

### Task 2: SvgBarChart — CSS Variable Colors + Custom Tooltip

**Files:**
- Modify: `web/frontend/src/components/SvgBarChart.tsx`

- [ ] **Step 1: Rewrite SvgBarChart with CSS variables and custom tooltip**

Replace the entire file content of `SvgBarChart.tsx` with:

```tsx
import { useState, useRef } from "react";
import type { DailySummary } from "../api/types";

interface SvgBarChartProps {
  data: DailySummary[];
  height?: number;
}

interface TooltipData {
  date: string;
  totalIn: number;
  totalOut: number;
  totalCacheCreate: number;
  total: number;
  x: number;
  y: number;
}

export function SvgBarChart({ data, height = 200 }: SvgBarChartProps) {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  if (data.length === 0) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted-foreground)" }}>
        NO DATA
      </div>
    );
  }

  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));

  const margin = { top: 10, right: 10, bottom: 30, left: 50 };
  const w = 500;
  const chartW = w - margin.left - margin.right;
  const chartH = height - margin.top - margin.bottom;

  const maxVal = Math.max(1, ...sorted.map(d => d.totalIn + d.totalOut + d.totalCacheCreate));
  const barW = Math.max(4, (chartW / sorted.length) * 0.7);
  const gap = (chartW / sorted.length) * 0.3;

  const yTicks = 4;
  const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const val = (maxVal / yTicks) * i;
    const y = chartH - (val / maxVal) * chartH;
    return { val, y };
  });

  const handleBarHover = (d: DailySummary, barIndex: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const svgW = rect.width;
    const scale = svgW / w;
    const x = (margin.left + barIndex * (barW + gap) + barW / 2) * scale;
    const total = d.totalIn + d.totalOut + d.totalCacheCreate;
    const barTop = chartH - (total / maxVal) * chartH;
    const y = (margin.top + barTop) * scale;
    setTooltip({ date: d.date, totalIn: d.totalIn, totalOut: d.totalOut, totalCacheCreate: d.totalCacheCreate, total, x, y });
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }} onClick={() => setTooltip(null)}>
      <svg viewBox={`0 0 ${w} ${height}`} style={{ width: "100%", height }}>
        <g transform={`translate(${margin.left},${margin.top})`}>
          {/* Grid lines */}
          {gridLines.map((g, i) => (
            <g key={i}>
              <line x1={0} y1={g.y} x2={chartW} y2={g.y} stroke="var(--border)" strokeWidth={0.5} />
              <text x={-8} y={g.y + 3} textAnchor="end" fill="var(--muted-foreground)" fontSize={8} fontFamily="var(--font-mono)">
                {formatTokenCount(g.val)}
              </text>
            </g>
          ))}

          {/* Bars */}
          {sorted.map((d, i) => {
            const x = i * (barW + gap);
            const inH = (d.totalIn / maxVal) * chartH;
            const outH = (d.totalOut / maxVal) * chartH;
            const cacheH = (d.totalCacheCreate / maxVal) * chartH;

            return (
              <g
                key={d.date}
                onMouseEnter={() => handleBarHover(d, i)}
                onMouseLeave={() => setTooltip(null)}
                onClick={(e) => { e.stopPropagation(); handleBarHover(d, i); }}
                style={{ cursor: "pointer" }}
              >
                {/* Invisible hit area for easier hovering */}
                <rect x={x - gap / 2} y={0} width={barW + gap} height={chartH} fill="transparent" />
                {/* Cache create (bottom) */}
                <rect x={x} y={chartH - cacheH} width={barW} height={Math.max(0, cacheH)} fill="rgba(245,158,11,0.7)" rx={1} />
                {/* Input (middle) */}
                <rect x={x} y={chartH - cacheH - inH} width={barW} height={Math.max(0, inH)} fill="rgba(6,182,212,0.7)" rx={1} />
                {/* Output (top) */}
                <rect x={x} y={chartH - cacheH - inH - outH} width={barW} height={Math.max(0, outH)} fill="rgba(34,197,94,0.7)" rx={1} />

                {/* X label */}
                {(i % Math.max(1, Math.floor(sorted.length / 7)) === 0 || i === sorted.length - 1) && (
                  <text x={x + barW / 2} y={chartH + 16} textAnchor="middle" fill="var(--muted-foreground)" fontSize={8} fontFamily="var(--font-mono)">
                    {d.date.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* Legend */}
        <g transform={`translate(${margin.left}, ${height - 6})`}>
          <rect x={0} y={-6} width={8} height={8} fill="rgba(6,182,212,0.7)" rx={1} />
          <text x={12} y={1} fill="var(--muted-foreground)" fontSize={8} fontFamily="var(--font-mono)">Input</text>
          <rect x={50} y={-6} width={8} height={8} fill="rgba(34,197,94,0.7)" rx={1} />
          <text x={62} y={1} fill="var(--muted-foreground)" fontSize={8} fontFamily="var(--font-mono)">Output</text>
          <rect x={110} y={-6} width={8} height={8} fill="rgba(245,158,11,0.7)" rx={1} />
          <text x={122} y={1} fill="var(--muted-foreground)" fontSize={8} fontFamily="var(--font-mono)">Cache Create</text>
        </g>
      </svg>

      {/* Custom Tooltip */}
      {tooltip && (
        <div
          style={{
            position: "absolute",
            left: tooltip.x,
            top: tooltip.y,
            transform: "translate(-50%, -100%) translateY(-8px)",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <div
            style={{
              background: "var(--popover)",
              color: "var(--popover-foreground)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 10px",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              lineHeight: 1.6,
              whiteSpace: "nowrap",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{tooltip.date}</div>
            <div><span style={{ color: "rgba(6,182,212,0.9)" }}>Input:</span> {tooltip.totalIn.toLocaleString()}</div>
            <div><span style={{ color: "rgba(34,197,94,0.9)" }}>Output:</span> {tooltip.totalOut.toLocaleString()}</div>
            <div><span style={{ color: "rgba(245,158,11,0.9)" }}>Cache:</span> {tooltip.totalCacheCreate.toLocaleString()}</div>
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 2, paddingTop: 2, fontWeight: 600 }}>
              Total: {tooltip.total.toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}
```

Key changes from original:
- All `rgba(255,255,255,...)` → CSS variables (`var(--border)`, `var(--muted-foreground)`)
- `var(--text-dim)` → `var(--muted-foreground)` in empty state
- Removed all `<title>` elements from bars
- Added `tooltip` state with `TooltipData` interface
- Added `containerRef` for coordinate calculation
- Added invisible hit area rect for easier hover targeting
- Added `onMouseEnter`/`onMouseLeave`/`onClick` handlers on bar groups
- Added custom tooltip div overlay positioned absolutely above hovered bar
- Mobile: tap bar to show tooltip, tap outside to dismiss (`onClick` on container clears)

- [ ] **Step 2: Visual verification**

Open `http://10.37.66.8:5199/#/analytics`:
- Hover bars → tooltip appears above with date + breakdown
- Move away → tooltip disappears
- Toggle light/dark mode → grid lines, axis labels, legend text visible in both
- On mobile viewport (375px): tap a bar → tooltip shows, tap elsewhere → dismisses

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/components/SvgBarChart.tsx
git commit -m "fix(analytics): CSS variables + custom hover tooltip for SvgBarChart"
```

---

### Task 3: Analytics Store — Loading State for fetchRecent

**Files:**
- Modify: `web/frontend/src/stores/analytics.ts`

- [ ] **Step 1: Add refreshing state and fix fetchRecent loading**

Replace the entire file content of `stores/analytics.ts` with:

```ts
import { create } from "zustand";
import type { AnalyticsSummary, TokenMetricEntry } from "../api/types";
import * as api from "../api/client";

interface AnalyticsState {
  summary: AnalyticsSummary | null;
  recentMetrics: TokenMetricEntry[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;

  fetchSummary: () => Promise<void>;
  fetchRecent: (limit?: number) => Promise<void>;
  refreshAll: () => Promise<void>;
}

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
  summary: null,
  recentMetrics: [],
  loading: false,
  refreshing: false,
  error: null,

  fetchSummary: async () => {
    set({ loading: true });
    try {
      const summary = await api.getAnalyticsSummary();
      set({ summary, loading: false, error: null });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fetchRecent: async (limit = 50) => {
    set({ loading: true });
    try {
      const recentMetrics = await api.getRecentMetrics(limit);
      set({ recentMetrics, loading: false, error: null });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  refreshAll: async () => {
    set({ refreshing: true });
    try {
      const [summary, recentMetrics] = await Promise.all([
        api.getAnalyticsSummary(),
        api.getRecentMetrics(50),
      ]);
      set({ summary, recentMetrics, refreshing: false, error: null });
    } catch (e: any) {
      set({ error: e.message, refreshing: false });
    }
  },
}));
```

Changes from original:
- Added `refreshing: boolean` to state interface and initial state
- `fetchRecent` now sets `loading: true` at start and `loading: false` on completion
- Added `refreshAll()` method that fetches both in parallel, uses `refreshing` flag instead of `loading` (keeps existing data visible during manual refresh)

- [ ] **Step 2: Commit**

```bash
git add web/frontend/src/stores/analytics.ts
git commit -m "feat(analytics): add refreshing state and refreshAll to analytics store"
```

---

### Task 4: Layout + Header — Action Slot for Global Refresh

**Files:**
- Modify: `web/frontend/src/components/Layout.tsx`
- Modify: `web/frontend/src/components/Header.tsx`

- [ ] **Step 1: Add actions prop to Header**

In `Header.tsx`, add an `actions` prop and render it before the status indicators:

```tsx
import type { ReactNode } from "react";
import { Sun, Moon } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

interface HeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  daemonAlive?: boolean;
  tokensValid?: number;
  tokensTotal?: number;
}

export function Header({ title, subtitle, actions, daemonAlive, tokensValid, tokensTotal }: HeaderProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="flex h-[var(--header-height)] shrink-0 items-center gap-2 border-b border-border bg-card/50 px-4 sm:gap-4 sm:px-6">
      <span className="text-sm font-semibold text-foreground">
        {title}
      </span>
      {subtitle && (
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {subtitle}
        </span>
      )}
      <div className="flex-1" />

      {/* Page-specific actions */}
      {actions}

      {/* Status indicators */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
          <div
            className={cn("h-2 w-2 rounded-full", daemonAlive ? "bg-success" : "bg-destructive")}
            title="Daemon"
          />
          {tokensTotal !== undefined && (
            <span className="text-[10px] text-muted-foreground">
              {tokensValid ?? 0}/{tokensTotal} tokens
            </span>
          )}
        </div>

        {/* Theme toggle */}
        <Button variant="ghost" size="icon" onClick={toggleTheme} className="h-8 w-8">
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </Button>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Pass actions through Layout**

In `Layout.tsx`, add the `actions` prop and forward to Header:

```tsx
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { BottomNav } from "./BottomNav";
import { Header } from "./Header";
import { useAppStore } from "../stores/app";

interface LayoutProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function Layout({ title, subtitle, actions, children }: LayoutProps) {
  const status = useAppStore(s => s.status);

  return (
    <div className="relative z-[1] flex h-dvh">
      <Sidebar daemonPid={status?.daemon.pid ?? null} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          title={title}
          subtitle={subtitle}
          actions={actions}
          daemonAlive={status?.daemon.alive}
          tokensValid={status?.tokens.valid}
          tokensTotal={status?.tokens.total}
        />
        <div className="main-content flex-1 overflow-y-auto p-5">
          {children}
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/components/Header.tsx web/frontend/src/components/Layout.tsx
git commit -m "feat(layout): add actions slot to Header and Layout"
```

---

### Task 5: Analytics Page — Consolidate Refresh + All Polish

**Files:**
- Modify: `web/frontend/src/pages/Analytics.tsx`

- [ ] **Step 1: Rewrite Analytics.tsx with all polish changes**

Replace the entire file content of `Analytics.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  BarChart3, RefreshCw, Coins, Zap, Hash, DatabaseZap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SvgBarChart } from "../components/SvgBarChart";
import { SvgDonut } from "../components/SvgDonut";
import { useAnalyticsStore } from "../stores/analytics";

const MODEL_COLORS = [
  "rgba(6,182,212,0.8)",     // cyan
  "rgba(34,197,94,0.8)",     // green
  "rgba(168,85,247,0.8)",    // purple
  "rgba(245,158,11,0.8)",    // amber
  "rgba(239,68,68,0.8)",     // red
  "rgba(59,130,246,0.8)",    // blue
];

const UNKNOWN_COLOR = "rgba(128,128,128,0.5)";

function useIsMobile() {
  const [mobile, setMobile] = useState(window.innerWidth < 640);
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return mobile;
}

export function Analytics() {
  const { summary, recentMetrics, loading, refreshing, fetchSummary, fetchRecent, refreshAll } = useAnalyticsStore();
  const isMobile = useIsMobile();

  useEffect(() => {
    fetchSummary();
    fetchRecent(50);
  }, []);

  const today = summary?.today;
  const week = summary?.week;
  const dailyHistory = summary?.dailyHistory ?? [];

  // Compute values for cards
  const todayTokens = (today?.totalIn ?? 0) + (today?.totalOut ?? 0);
  const todayCacheRead = today?.totalCacheRead ?? 0;
  const todayTotalIn = today?.totalIn ?? 0;
  const cacheHitRate = todayTotalIn + todayCacheRead > 0
    ? Math.min(100, Math.max(0, (todayCacheRead / (todayTotalIn + todayCacheRead)) * 100))
    : 0;
  const todayRequests = today?.requestCount ?? 0;
  const todayCost = today?.totalCost ?? 0;

  // Last 14 days for bar chart
  const last14 = dailyHistory
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-14);

  // Model distribution from week summary — unknown/empty sorted last, gray color
  const modelSegments = Object.entries(week?.models ?? {})
    .sort(([a], [b]) => {
      const aUnknown = !a || a === "unknown";
      const bUnknown = !b || b === "unknown";
      if (aUnknown && !bUnknown) return 1;
      if (!aUnknown && bUnknown) return -1;
      return 0;
    })
    .map(([name, data], i) => {
      const isUnknown = !name || name === "unknown";
      return {
        label: shortenModel(name || "unknown"),
        value: data.in + data.out,
        color: isUnknown ? UNKNOWN_COLOR : MODEL_COLORS[i % MODEL_COLORS.length],
      };
    });

  // Cache analysis from week
  const weekCacheRead = week?.totalCacheRead ?? 0;
  const weekCacheCreate = week?.totalCacheCreate ?? 0;
  const weekIn = week?.totalIn ?? 0;
  const weekOut = week?.totalOut ?? 0;
  const cacheSegments = [
    { label: "Input", value: weekIn, color: "rgba(6,182,212,0.7)" },
    { label: "Output", value: weekOut, color: "rgba(34,197,94,0.7)" },
    { label: "Cache Read", value: weekCacheRead, color: "rgba(59,130,246,0.7)" },
    { label: "Cache Create", value: weekCacheCreate, color: "rgba(245,158,11,0.7)" },
  ];

  const usageQuotas = summary?.usage ?? [];

  const donutSize = isMobile ? 120 : 140;

  // Global refresh button for header
  const refreshButton = (
    <Button
      variant="ghost" size="sm"
      onClick={refreshAll}
      disabled={refreshing}
      className="h-7 text-xs text-muted-foreground"
    >
      <RefreshCw className={cn("mr-1 h-3 w-3", refreshing && "animate-spin")} />
      {refreshing ? "Refreshing..." : "Refresh"}
    </Button>
  );

  return (
    <Layout title="Analytics" subtitle="TOKEN USAGE" actions={refreshButton}>
      {/* ─── Top Stat Cards ─── */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Zap className="h-4 w-4" />}
          label="Today Tokens"
          value={formatNum(todayTokens)}
          sub={`IN ${formatNum(today?.totalIn ?? 0)} · OUT ${formatNum(today?.totalOut ?? 0)}`}
        />
        <StatCard
          icon={<DatabaseZap className="h-4 w-4" />}
          label="Cache Hit Rate"
          value={`${cacheHitRate.toFixed(1)}%`}
          sub={`CACHE READ ${formatNum(todayCacheRead)}`}
          variant={cacheHitRate > 50 ? "success" : "warning"}
        />
        <StatCard
          icon={<Hash className="h-4 w-4" />}
          label="Requests"
          value={String(todayRequests)}
          sub={`7D TOTAL: ${week?.requestCount ?? 0}`}
        />
        <StatCard
          icon={<Coins className="h-4 w-4" />}
          label="Est. Cost"
          value={todayCost > 0 ? `$${todayCost.toFixed(2)}` : "\u2014"}
          sub={`7D: $${(week?.totalCost ?? 0).toFixed(2)}`}
        />
      </div>

      {/* ─── Usage Quotas + Donut Charts ─── */}
      {usageQuotas.length > 0 ? (
        <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {/* Subscription Usage */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Subscription Usage
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {usageQuotas.map((q, i) => {
                const label = QUOTA_LABELS[q.rateLimitType] ?? q.rateLimitType;
                const util = q.utilization ?? 0;
                const isLimited = q.status === "rate_limited";
                return (
                  <div key={i}>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-xs font-medium">{label}</span>
                      <div className="flex items-center gap-2">
                        {q.resetsAt && (
                          <span className="text-[10px] text-muted-foreground">
                            resets {formatResetTime(q.resetsAt)}
                          </span>
                        )}
                        <span className={cn(
                          "text-xs font-bold",
                          isLimited ? "text-destructive" :
                          util > 80 ? "text-destructive" :
                          util > 50 ? "text-warning" :
                          "text-success"
                        )}>
                          {util > 0 ? `${util.toFixed(0)}%` : isLimited ? "LIM" : "OK"}
                        </span>
                      </div>
                    </div>
                    <Progress
                      value={Math.max(Math.min(util, 100), 2)}
                      indicatorClassName={cn(
                        isLimited ? "bg-destructive" :
                        util > 80 ? "bg-destructive" :
                        util > 50 ? "bg-warning" :
                        "bg-success"
                      )}
                    />
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Model Distribution Donut */}
          <Card>
            <CardHeader className="space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Model Distribution
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-center py-2">
              <SvgDonut
                segments={modelSegments}
                centerLabel="MODELS"
                centerValue={String(Object.keys(week?.models ?? {}).length)}
                size={donutSize}
              />
            </CardContent>
          </Card>

          {/* Token Breakdown Donut */}
          <Card>
            <CardHeader className="space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Token Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-center py-2">
              <SvgDonut
                segments={cacheSegments}
                centerLabel="7D TOTAL"
                centerValue={formatNum(weekIn + weekOut + weekCacheRead + weekCacheCreate)}
                size={donutSize}
              />
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader className="space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Model Distribution
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-center py-2">
              <SvgDonut
                segments={modelSegments}
                centerLabel="MODELS"
                centerValue={String(Object.keys(week?.models ?? {}).length)}
                size={donutSize}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Token Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-center py-2">
              <SvgDonut
                segments={cacheSegments}
                centerLabel="7D TOTAL"
                centerValue={formatNum(weekIn + weekOut + weekCacheRead + weekCacheCreate)}
                size={donutSize}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* ─── 14-Day Usage Trend ─── */}
      <Card className="mb-3">
        <CardHeader className="space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            14-Day Usage Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SvgBarChart data={last14} height={220} />
        </CardContent>
      </Card>

      {/* ─── Recent Requests Table ─── */}
      <Card>
        <CardHeader className="space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            Recent Requests
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recentMetrics.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {loading ? "LOADING..." : "NO METRICS DATA"}
            </div>
          ) : (
            <ScrollArea className="max-h-[420px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[90px]">Time</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">In</TableHead>
                    <TableHead className="text-right">Out</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Cache</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Duration</TableHead>
                    <TableHead className="text-center">Src</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentMetrics.map((m, i) => (
                    <TableRow key={i} className="hover:bg-muted/50">
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {formatTime(m.ts)}
                      </TableCell>
                      <TableCell
                        className="max-w-[140px] truncate font-mono text-[11px]"
                        title={m.model ?? ""}
                      >
                        {shortenModel(m.model ?? "\u2014")}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] text-cyan-500">
                        {m.in.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] text-green-500">
                        {m.out.toLocaleString()}
                      </TableCell>
                      <TableCell className="hidden text-right font-mono text-[11px] text-amber-500 sm:table-cell">
                        {(m.cacheRead + m.cacheCreate) > 0
                          ? (m.cacheRead + m.cacheCreate).toLocaleString()
                          : "\u2014"}
                      </TableCell>
                      <TableCell className="hidden text-right font-mono text-[11px] text-muted-foreground md:table-cell">
                        {m.dur ? `${(m.dur / 1000).toFixed(1)}s` : "\u2014"}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge
                          variant={m.src === "remi" ? "outline" : "secondary"}
                          className="text-[9px] uppercase"
                        >
                          {m.src}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}

// ─── Sub-components ─────────────────────────

function StatCard({ icon, label, value, sub, variant }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  variant?: "success" | "warning" | "destructive";
}) {
  return (
    <Card className="border transition-all duration-200 hover:border-primary/20">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          {icon}
          <span className="text-[10px] font-medium uppercase tracking-wider">{label}</span>
        </div>
        <div className={cn("mt-2 text-xl font-bold leading-none tracking-tight sm:text-2xl",
          variant === "success" ? "text-success" :
          variant === "warning" ? "text-warning" :
          variant === "destructive" ? "text-destructive" :
          "text-foreground"
        )}>
          {value}
        </div>
        <div className="mt-1.5 truncate text-[10px] text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}

// ─── Helpers ─────────────────────────────────

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return ts.slice(0, 16);
  }
}

function shortenModel(model: string): string {
  return model
    .replace("claude-", "")
    .replace("-20250", "")
    .replace("-latest", "");
}

const QUOTA_LABELS: Record<string, string> = {
  five_hour: "Current Session",
  seven_day: "Weekly (All Models)",
  seven_day_sonnet: "Weekly (Sonnet)",
  seven_day_opus: "Weekly (Opus)",
  overage: "Extra Usage",
};

function formatResetTime(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    if (diffMs <= 0) return "now";
    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.floor((diffMs % 3600000) / 60000);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h`;
    }
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  } catch {
    return iso.slice(0, 16);
  }
}
```

Summary of all changes in this file vs original:

| Change | What |
|--------|------|
| Refresh consolidation | Removed both local Refresh buttons, added `refreshButton` rendered via `Layout actions` prop |
| Store usage | Destructure `refreshing` and `refreshAll` from store instead of local `useState` |
| Est. Cost card | Removed `variant={todayCost > 5 ? "warning" : "success"}` — no variant prop |
| StatCard hover | `hover:bg-accent/30` → `border transition-all duration-200 hover:border-primary/20` |
| Table row hover | Added `className="hover:bg-muted/50"` to body `<TableRow>` |
| Badge variant | `"warning"` → `"secondary"` for non-remi sources |
| Donut size | `size={140}` → `size={donutSize}` (140 desktop, 120 mobile) |
| useIsMobile | Added inline hook at top of file |
| Unknown model color | Sort unknown/empty to end, use `UNKNOWN_COLOR` gray |
| 14-Day CardHeader | Removed `flex-row items-center justify-between` (no more local refresh button) |
| Recent CardHeader | Removed `flex-row items-center justify-between` and Refresh button |

- [ ] **Step 2: Visual verification checklist**

Open `http://10.37.66.8:5199/#/analytics` and verify:
1. Single Refresh button in page header — spinner on click, data stays visible
2. Est. Cost card shows default foreground color (no green/yellow)
3. StatCard border highlights on hover
4. Table rows highlight on hover
5. "unknown" model segment is gray and sorted last in donut
6. Donut size shrinks on 375px mobile viewport
7. Non-remi badges use neutral `secondary` variant instead of yellow `warning`

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/pages/Analytics.tsx
git commit -m "feat(analytics): consolidate refresh, polish StatCard/table/badge, responsive donuts, unknown model gray"
```

---

### Task 6: Mobile Donut Legend Gap

**Files:**
- Modify: `web/frontend/src/styles/index.css`

- [ ] **Step 1: Add responsive legend gap via CSS**

Add the following at the end of `index.css` (before the closing of any existing section, or at the very end):

```css
/* Donut legend responsive gap */
@media (max-width: 639px) {
  .donut-legend {
    gap: 4px 10px !important;
  }
}
```

This targets the `donut-legend` className added to SvgDonut in Task 1.

- [ ] **Step 2: Verify on mobile viewport**

Set viewport to 375px width. Donut legends should have tighter spacing than desktop.

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/styles/index.css
git commit -m "style(analytics): tighter donut legend gap on mobile"
```

---

### Task 7: Final Integration Test

- [ ] **Step 1: Build check**

```bash
cd /data00/home/hehuajie/project/remi/web/frontend && bun run build
```

Expected: no TypeScript errors, clean build output.

- [ ] **Step 2: Full visual test — dark mode desktop**

Open `http://10.37.66.8:5199/#/analytics` at 1440px width in dark mode. Verify all 7 changes visually.

- [ ] **Step 3: Full visual test — light mode desktop**

Toggle to light mode. Verify:
- Bar chart grid lines, axis labels, legend text visible
- Donut background ring, center text, legend text visible
- All cards, table, badges readable

- [ ] **Step 4: Full visual test — mobile**

Set viewport to 375px. Verify:
- Donut size is 120px, legend gap is tight
- Bar chart tooltip works on tap
- Table scrolls horizontally if needed
- Refresh button accessible in header

- [ ] **Step 5: Commit all remaining changes (if any)**

```bash
git add -A && git status
# If clean, nothing to commit. If there are fixes from testing:
git commit -m "fix(analytics): address integration test findings"
```
