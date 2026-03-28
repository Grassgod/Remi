# Logs Module Full Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Logs dashboard page with monitoring stat cards, hourly distribution chart, full-text search, inline detail expansion with JSON highlighting, and auto-refresh — zero new dependencies.

**Architecture:** Backend gets a new `/api/v1/logs/stats` aggregation endpoint and a `search` param on the existing logs endpoint. Frontend adds stat cards, a pure CSS hourly chart component, enhanced filter bar, and accordion log detail rows. All state managed in the existing Zustand store.

**Tech Stack:** TypeScript, Hono (backend), React + Zustand + Tailwind + shadcn/ui (frontend), Bun runtime.

**Branch:** `dashboard-redesign`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `web/remi-data.ts` | Modify | Add `getLogStats()` method, add `search` filter to `getLogs()` |
| `web/handlers/logs.ts` | Modify | Register `/api/v1/logs/stats` route, pass `search` param |
| `web/frontend/src/api/types.ts` | Modify | Add `LogStats` interface |
| `web/frontend/src/api/client.ts` | Modify | Add `getLogStats()` function, add `search` to `getLogs()` |
| `web/frontend/src/stores/logs.ts` | Modify | Add stats, search, autoRefresh, expandedIndex state + actions |
| `web/frontend/src/components/HourlyChart.tsx` | Create | Pure CSS hourly distribution bar chart |
| `web/frontend/src/pages/Logs.tsx` | Modify | Full page rewrite with stat cards, chart, enhanced filters, accordion detail |

---

### Task 1: Backend — `getLogStats()` data method

**Files:**
- Modify: `web/remi-data.ts` (after `getLogModules()` method, around line 640)

- [ ] **Step 1: Add `getLogStats()` method to `RemiData` class**

Insert this method right after the `getLogModules()` method in the `RemiData` class:

```typescript
  getLogStats(date?: string): {
    total: number;
    levels: { DEBUG: number; INFO: number; WARN: number; ERROR: number };
    hourly: Array<{ hour: number; count: number; errors: number }>;
    moduleCount: number;
    topModules: string[];
    lastError: string | null;
    lastErrorModule: string | null;
  } {
    const logsDir = join(this.root, "logs");
    const d = date ?? new Date().toISOString().slice(0, 10);
    const entries = readLogEntries(d, logsDir);

    const levels = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
    const hourly: Array<{ hour: number; count: number; errors: number }> = Array.from(
      { length: 24 }, (_, i) => ({ hour: i, count: 0, errors: 0 })
    );
    const moduleCounts: Record<string, number> = {};
    let lastError: string | null = null;
    let lastErrorModule: string | null = null;

    for (const e of entries) {
      // Level counts
      if (e.level in levels) levels[e.level as keyof typeof levels]++;

      // Hourly distribution
      try {
        const hour = new Date(e.ts).getHours();
        if (hour >= 0 && hour < 24) {
          hourly[hour].count++;
          if (e.level === "ERROR") hourly[hour].errors++;
        }
      } catch { /* skip entries with unparseable timestamps */ }

      // Module counts
      moduleCounts[e.module] = (moduleCounts[e.module] ?? 0) + 1;

      // Track last error
      if (e.level === "ERROR") {
        if (!lastError || e.ts > lastError) {
          lastError = e.ts;
          lastErrorModule = e.module;
        }
      }
    }

    // Top 5 modules by count
    const topModules = Object.entries(moduleCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    return {
      total: entries.length,
      levels,
      hourly,
      moduleCount: Object.keys(moduleCounts).length,
      topModules,
      lastError,
      lastErrorModule,
    };
  }
```

- [ ] **Step 2: Verify no syntax errors**

Run: `cd /data00/home/hehuajie/project/remi && bun build web/remi-data.ts --no-bundle 2>&1 | head -20`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add web/remi-data.ts
git commit -m "feat(logs): add getLogStats() aggregation method"
```

---

### Task 2: Backend — Add `search` filter to `getLogs()`

**Files:**
- Modify: `web/remi-data.ts` (inside `getLogs()` method)

- [ ] **Step 1: Add `search` to query type and filter logic**

In `getLogs()`, update the query parameter type to include `search`:

```typescript
  getLogs(query: { date: string; level?: string | null; module?: string | null; traceId?: string | null; search?: string | null; limit: number; offset: number }): { entries: LogEntry[]; total: number; hasMore: boolean } {
```

Add the search filter after the existing `traceId` filter block:

```typescript
    if (query.search) {
      const s = query.search.toLowerCase();
      entries = entries.filter(e => e.msg.toLowerCase().includes(s));
    }
```

- [ ] **Step 2: Verify no syntax errors**

Run: `cd /data00/home/hehuajie/project/remi && bun build web/remi-data.ts --no-bundle 2>&1 | head -20`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add web/remi-data.ts
git commit -m "feat(logs): add search param to getLogs() for message filtering"
```

---

### Task 3: Backend — Register new routes in handler

**Files:**
- Modify: `web/handlers/logs.ts`

- [ ] **Step 1: Add `/api/v1/logs/stats` route and `search` param to existing route**

Replace the entire file content with:

```typescript
import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerLogsHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/logs", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    const level = c.req.query("level") ?? null;
    const module = c.req.query("module") ?? null;
    const traceId = c.req.query("traceId") ?? null;
    const search = c.req.query("search") ?? null;
    const limit = Math.min(parseInt(c.req.query("limit") ?? "200", 10), 1000);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    return c.json(data.getLogs({ date, level, module, traceId, search, limit, offset }));
  });

  app.get("/api/v1/logs/stats", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    return c.json(data.getLogStats(date));
  });

  app.get("/api/v1/logs/modules", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    return c.json(data.getLogModules(date));
  });
}
```

Note: `/api/v1/logs/stats` must be registered **before** `/api/v1/logs/modules` and the base `/api/v1/logs` route. Hono matches routes in registration order, and `/api/v1/logs/stats` is more specific. (In practice Hono's trie router handles this correctly, but explicit ordering is safer.)

- [ ] **Step 2: Verify backend builds**

Run: `cd /data00/home/hehuajie/project/remi && bun build web/handlers/logs.ts --no-bundle --external hono 2>&1 | head -20`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add web/handlers/logs.ts
git commit -m "feat(logs): register /api/v1/logs/stats endpoint and search param"
```

---

### Task 4: Frontend — API types and client

**Files:**
- Modify: `web/frontend/src/api/types.ts`
- Modify: `web/frontend/src/api/client.ts`

- [ ] **Step 1: Add `LogStats` interface to types.ts**

Add after the existing `LogQueryResult` interface (around line 162):

```typescript
export interface LogStats {
  total: number;
  levels: { DEBUG: number; INFO: number; WARN: number; ERROR: number };
  hourly: Array<{ hour: number; count: number; errors: number }>;
  moduleCount: number;
  topModules: string[];
  lastError: string | null;
  lastErrorModule: string | null;
}
```

- [ ] **Step 2: Add `getLogStats()` and `search` param to client.ts**

In the `// Logs` section of `client.ts`, replace the existing `getLogs` function and add `getLogStats`:

```typescript
// Logs
export const getLogs = (params: { date?: string; level?: string; module?: string; traceId?: string; search?: string; limit?: number; offset?: number }) => {
  const qs = new URLSearchParams();
  if (params.date) qs.set("date", params.date);
  if (params.level) qs.set("level", params.level);
  if (params.module) qs.set("module", params.module);
  if (params.traceId) qs.set("traceId", params.traceId);
  if (params.search) qs.set("search", params.search);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  return request<import("./types").LogQueryResult>(`/api/v1/logs?${qs.toString()}`);
};
export const getLogStats = (date?: string) =>
  request<import("./types").LogStats>(`/api/v1/logs/stats${date ? `?date=${date}` : ""}`);
export const getLogModules = (date?: string) =>
  request<string[]>(`/api/v1/logs/modules${date ? `?date=${date}` : ""}`);
```

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/api/types.ts web/frontend/src/api/client.ts
git commit -m "feat(logs): add LogStats type and getLogStats() client function"
```

---

### Task 5: Frontend — Upgrade Zustand store

**Files:**
- Modify: `web/frontend/src/stores/logs.ts`

- [ ] **Step 1: Replace entire store file**

```typescript
import { create } from "zustand";
import type { LogEntry, LogStats } from "../api/types";
import * as api from "../api/client";

interface LogsState {
  entries: LogEntry[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  modules: string[];

  // Stats
  stats: LogStats | null;
  statsLoading: boolean;

  // Filters
  date: string;
  level: string | null;
  module: string | null;
  traceId: string | null;
  search: string | null;

  // UI state
  autoRefresh: boolean;
  expandedIndex: number | null;

  // Actions
  fetchLogs: () => Promise<void>;
  fetchModules: () => Promise<void>;
  fetchStats: () => Promise<void>;
  setFilter: (key: "date" | "level" | "module" | "traceId" | "search", value: string | null) => void;
  loadMore: () => Promise<void>;
  toggleAutoRefresh: () => void;
  setExpandedIndex: (i: number | null) => void;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

export const useLogsStore = create<LogsState>((set, get) => ({
  entries: [],
  total: 0,
  hasMore: false,
  loading: false,
  error: null,
  modules: [],

  stats: null,
  statsLoading: false,

  date: todayStr(),
  level: null,
  module: null,
  traceId: null,
  search: null,

  autoRefresh: false,
  expandedIndex: null,

  fetchLogs: async () => {
    const { date, level, module, traceId, search } = get();
    set({ loading: true });
    try {
      const result = await api.getLogs({
        date,
        level: level ?? undefined,
        module: module ?? undefined,
        traceId: traceId ?? undefined,
        search: search ?? undefined,
        limit: 200,
        offset: 0,
      });
      set({ entries: result.entries, total: result.total, hasMore: result.hasMore, loading: false, error: null });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fetchModules: async () => {
    try {
      const modules = await api.getLogModules(get().date);
      set({ modules });
    } catch { /* ignore */ }
  },

  fetchStats: async () => {
    set({ statsLoading: true });
    try {
      const stats = await api.getLogStats(get().date);
      set({ stats, statsLoading: false });
    } catch {
      set({ statsLoading: false });
    }
  },

  setFilter: (key, value) => {
    set({ [key]: value, expandedIndex: null } as any);
  },

  loadMore: async () => {
    const { date, level, module, traceId, search, entries } = get();
    try {
      const result = await api.getLogs({
        date,
        level: level ?? undefined,
        module: module ?? undefined,
        traceId: traceId ?? undefined,
        search: search ?? undefined,
        limit: 200,
        offset: entries.length,
      });
      set({
        entries: [...entries, ...result.entries],
        total: result.total,
        hasMore: result.hasMore,
      });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  toggleAutoRefresh: () => {
    set((s) => ({ autoRefresh: !s.autoRefresh }));
  },

  setExpandedIndex: (i) => {
    set((s) => ({ expandedIndex: s.expandedIndex === i ? null : i }));
  },
}));
```

- [ ] **Step 2: Commit**

```bash
git add web/frontend/src/stores/logs.ts
git commit -m "feat(logs): upgrade store with stats, search, autoRefresh, expandedIndex"
```

---

### Task 6: Frontend — HourlyChart component

**Files:**
- Create: `web/frontend/src/components/HourlyChart.tsx`

- [ ] **Step 1: Create HourlyChart component**

```typescript
import { Card, CardContent } from "./ui/card";
import { cn } from "@/lib/utils";

interface HourlyChartProps {
  data: Array<{ hour: number; count: number; errors: number }>;
  currentHour?: number;
}

const LABEL_HOURS = [0, 6, 12, 18, 23];

export function HourlyChart({ data, currentHour }: HourlyChartProps) {
  const maxCount = Math.max(...data.map(d => d.count), 1);

  return (
    <Card className="mb-4">
      <CardContent className="px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Hourly Distribution
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            00:00 — 23:00
          </span>
        </div>

        {/* Bars */}
        <div className="flex items-end gap-[2px]" style={{ height: 48 }}>
          {data.map((d) => {
            const heightPct = (d.count / maxCount) * 100;
            const errorPct = d.count > 0 ? (d.errors / d.count) * 100 : 0;
            const isFuture = currentHour !== undefined && d.hour > currentHour;

            return (
              <div
                key={d.hour}
                className="group relative flex-1"
                style={{ height: "100%" }}
                title={`${String(d.hour).padStart(2, "0")}:00 — ${d.count} entries${d.errors > 0 ? `, ${d.errors} errors` : ""}`}
              >
                {/* Bar container, bottom-aligned */}
                <div className="absolute bottom-0 left-0 right-0 overflow-hidden rounded-t-[2px]"
                  style={{ height: `${heightPct}%` }}
                >
                  {/* Normal portion */}
                  <div
                    className={cn(
                      "absolute bottom-0 left-0 right-0",
                      isFuture ? "bg-muted/30" : "bg-primary/60",
                    )}
                    style={{ height: "100%" }}
                  />
                  {/* Error overlay at top */}
                  {errorPct > 0 && !isFuture && (
                    <div
                      className="absolute left-0 right-0 top-0 bg-destructive/80"
                      style={{ height: `${errorPct}%` }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Hour labels */}
        <div className="mt-1 flex justify-between">
          {LABEL_HOURS.map((h) => (
            <span key={h} className="font-mono text-[9px] text-muted-foreground/60">
              {String(h).padStart(2, "0")}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/frontend/src/components/HourlyChart.tsx
git commit -m "feat(logs): add HourlyChart pure CSS bar chart component"
```

---

### Task 7: Frontend — Full Logs page rewrite

**Files:**
- Modify: `web/frontend/src/pages/Logs.tsx`

- [ ] **Step 1: Replace entire Logs.tsx with the new implementation**

```typescript
import { useEffect, useRef, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  FileText, RefreshCw, Search, Filter, ChevronDown,
  AlertTriangle, Layers, Clock, BarChart3, Copy, ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { HourlyChart } from "../components/HourlyChart";
import { useLogsStore } from "../stores/logs";
import type { LogEntry } from "../api/types";

// ── Constants ──

const LEVEL_BADGE_VARIANT: Record<string, "outline" | "secondary" | "warning" | "destructive"> = {
  DEBUG: "outline",
  INFO: "secondary",
  WARN: "warning",
  ERROR: "destructive",
};

// ── Page ──

export function Logs() {
  const {
    entries, total, hasMore, loading, error, modules,
    date, level, module, traceId, search, stats, statsLoading,
    autoRefresh, expandedIndex,
    fetchLogs, fetchModules, fetchStats, setFilter, loadMore,
    toggleAutoRefresh, setExpandedIndex,
  } = useLogsStore();

  const [searchInput, setSearchInput] = useState(search ?? "");
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // Initial fetch
  useEffect(() => {
    fetchLogs();
    fetchModules();
    fetchStats();
  }, []);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      fetchLogs();
      fetchStats();
    }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, date, level, module, search, traceId]);

  const handleFilterChange = (key: "date" | "level" | "module" | "traceId", value: string | null) => {
    setFilter(key, value);
    setTimeout(() => {
      useLogsStore.getState().fetchLogs();
      useLogsStore.getState().fetchStats();
    }, 0);
    if (key === "date") {
      setTimeout(() => useLogsStore.getState().fetchModules(), 0);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setFilter("search", value || null);
      setTimeout(() => useLogsStore.getState().fetchLogs(), 0);
    }, 300);
  };

  // Stat computations
  const errorCount = stats?.levels.ERROR ?? 0;
  const errorRate = stats && stats.total > 0 ? ((errorCount / stats.total) * 100).toFixed(1) : "0.0";
  const lastErrorAgo = stats?.lastError ? formatTimeAgo(stats.lastError) : null;
  const currentHour = new Date().getHours();

  return (
    <Layout title="Logs" subtitle="STRUCTURED LOGS">

      {/* ─── Stat Cards ─── */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<FileText className="h-4 w-4" />}
          label="Total Entries"
          value={stats ? String(stats.total) : "—"}
          sub="Today"
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Errors"
          value={stats ? String(errorCount) : "—"}
          sub={`${errorRate}% error rate`}
          variant={errorCount > 0 ? "destructive" : undefined}
        />
        <StatCard
          icon={<Layers className="h-4 w-4" />}
          label="Active Modules"
          value={stats ? String(stats.moduleCount) : "—"}
          sub={stats?.topModules.slice(0, 3).join(", ") ?? "—"}
        />
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          label="Last Error"
          value={lastErrorAgo ?? "None"}
          sub={stats?.lastErrorModule ? `${lastErrorAgo} · ${stats.lastErrorModule}` : "No errors today"}
          variant={lastErrorAgo ? "warning" : undefined}
        />
      </div>

      {/* ─── Hourly Chart ─── */}
      {stats && (
        <HourlyChart data={stats.hourly} currentHour={currentHour} />
      )}

      {/* ─── Filter Bar ─── */}
      <Card className="mb-4">
        <CardContent className="p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="hidden h-4 w-4 text-muted-foreground sm:block" />

            <Input
              type="date"
              value={date}
              onChange={e => handleFilterChange("date", e.target.value)}
              className="h-8 w-auto font-mono text-xs"
            />

            <Select
              value={level ?? ""}
              onChange={e => handleFilterChange("level", (e.target as HTMLSelectElement).value || null)}
              placeholder="All Levels (≥)"
              options={[
                { value: "DEBUG", label: "DEBUG" },
                { value: "INFO", label: "INFO" },
                { value: "WARN", label: "WARN" },
                { value: "ERROR", label: "ERROR" },
              ]}
              className="h-8 w-[140px] font-mono text-xs"
            />

            <Select
              value={module ?? ""}
              onChange={e => handleFilterChange("module", (e.target as HTMLSelectElement).value || null)}
              placeholder="All Modules"
              options={modules.map(m => ({ value: m, label: m }))}
              className="h-8 w-[150px] font-mono text-xs"
            />

            {/* Search messages */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search messages..."
                value={searchInput}
                onChange={e => handleSearchChange(e.target.value)}
                className="h-8 w-[160px] pl-7 font-mono text-xs"
              />
            </div>

            {/* Trace ID */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Trace ID..."
                value={traceId ?? ""}
                onChange={e => handleFilterChange("traceId", e.target.value || null)}
                className="h-8 w-[140px] pl-7 font-mono text-xs"
              />
            </div>

            {/* Right side: count + auto-refresh + refresh */}
            <div className="ml-auto flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {total} entries
              </span>

              <Button
                variant={autoRefresh ? "default" : "outline"}
                size="sm"
                className="h-8 gap-1.5 font-mono text-xs"
                onClick={toggleAutoRefresh}
              >
                {autoRefresh && (
                  <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                )}
                Auto 30s
              </Button>

              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={loading}
                onClick={() => { fetchLogs(); fetchModules(); fetchStats(); }}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                Refresh
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Logs Table ─── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            Log Entries
          </CardTitle>
        </CardHeader>

        <CardContent className="p-0">
          {error && (
            <div className="px-4 py-2 font-mono text-xs text-destructive">
              {error}
            </div>
          )}

          {entries.length === 0 ? (
            <div className="px-4 py-12 text-center font-mono text-xs text-muted-foreground">
              {loading ? "LOADING..." : "NO LOG ENTRIES"}
            </div>
          ) : (
            <ScrollArea className="max-h-[600px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[100px] font-mono text-[10px] uppercase tracking-wider">Time</TableHead>
                    <TableHead className="w-[80px] font-mono text-[10px] uppercase tracking-wider">Level</TableHead>
                    <TableHead className="hidden w-[110px] font-mono text-[10px] uppercase tracking-wider sm:table-cell">Module</TableHead>
                    <TableHead className="font-mono text-[10px] uppercase tracking-wider">Message</TableHead>
                    <TableHead className="hidden w-[120px] font-mono text-[10px] uppercase tracking-wider md:table-cell">Trace</TableHead>
                    <TableHead className="w-[50px]" />
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {entries.map((entry, i) => (
                    <LogRow
                      key={i}
                      entry={entry}
                      index={i}
                      expanded={expandedIndex === i}
                      onToggle={() => setExpandedIndex(i)}
                    />
                  ))}
                </TableBody>
              </Table>

              {/* Load More */}
              {hasMore && (
                <div className="border-t border-border p-0">
                  <Button
                    variant="ghost"
                    className="h-auto w-full rounded-none py-2.5 font-mono text-xs text-primary"
                    onClick={loadMore}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                    LOAD MORE ({total - entries.length} remaining)
                  </Button>
                </div>
              )}
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}

// ── LogRow with accordion detail ──

function LogRow({ entry, index, expanded, onToggle }: {
  entry: LogEntry; index: number; expanded: boolean; onToggle: () => void;
}) {
  return (
    <>
      <TableRow
        className={cn(
          "cursor-pointer",
          entry.level === "ERROR" && "border-l-2 border-l-destructive/40",
          entry.level === "WARN" && "border-l-2 border-l-warning/30",
          expanded && "bg-accent/30",
        )}
        onClick={onToggle}
      >
        <TableCell className="py-1.5 font-mono text-[11px] text-muted-foreground">
          {formatLogTime(entry.ts)}
        </TableCell>
        <TableCell className="py-1.5">
          <Badge
            variant={LEVEL_BADGE_VARIANT[entry.level] ?? "outline"}
            className={cn(
              "font-mono text-[10px]",
              entry.level === "INFO" && "border-chart-1/30 bg-chart-1/10 text-chart-1",
            )}
          >
            {entry.level}
          </Badge>
        </TableCell>
        <TableCell className="hidden truncate py-1.5 font-mono text-[11px] text-muted-foreground sm:table-cell">
          {entry.module}
        </TableCell>
        <TableCell className="max-w-0 truncate py-1.5 font-mono text-[11px]" title={entry.msg}>
          {entry.msg}
        </TableCell>
        <TableCell className="hidden py-1.5 md:table-cell">
          {entry.traceId ? (
            <button
              className="truncate font-mono text-[10px] text-primary hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                window.location.hash = `#/traces?traceId=${entry.traceId}`;
              }}
            >
              {entry.traceId.slice(0, 12)}
            </button>
          ) : (
            <span className="font-mono text-[10px] text-muted-foreground/40">—</span>
          )}
        </TableCell>
        <TableCell className="py-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={(e) => {
              e.stopPropagation();
              copyToClipboard(JSON.stringify(entry, null, 2));
            }}
            title="Copy entry"
          >
            <Copy className="h-3 w-3 text-muted-foreground" />
          </Button>
        </TableCell>
      </TableRow>

      {/* Expanded detail row */}
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell
            colSpan={6}
            className={cn(
              "bg-accent/10 p-0",
              entry.level === "ERROR" && "border-l-2 border-l-destructive/40",
              entry.level === "WARN" && "border-l-2 border-l-warning/30",
            )}
          >
            <LogDetail entry={entry} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ── Log Detail Panel ──

function LogDetail({ entry }: { entry: LogEntry }) {
  return (
    <div className="space-y-3 px-4 py-3">
      {/* Top row: Full message + Metadata */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            Full Message
          </div>
          <div className={cn(
            "font-mono text-[11px] leading-relaxed",
            entry.level === "ERROR" && "text-destructive",
            entry.level === "WARN" && "text-warning",
          )}>
            {entry.msg}
          </div>
        </div>
        <div>
          <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            Metadata
          </div>
          <div className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
            <div><span className="text-muted-foreground/60">Module:</span> {entry.module}</div>
            {entry.traceId && (
              <div>
                <span className="text-muted-foreground/60">Trace:</span>{" "}
                <button
                  className="text-primary hover:underline"
                  onClick={() => { window.location.hash = `#/traces?traceId=${entry.traceId}`; }}
                >
                  {entry.traceId} →
                </button>
              </div>
            )}
            {entry.spanId && (
              <div><span className="text-muted-foreground/60">Span:</span> {entry.spanId}</div>
            )}
            <div><span className="text-muted-foreground/60">Time:</span> {entry.ts}</div>
          </div>
        </div>
      </div>

      {/* Data JSON */}
      {entry.data && Object.keys(entry.data).length > 0 && (
        <div>
          <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            Data (JSON)
          </div>
          <pre className="overflow-x-auto rounded-md border border-border bg-background p-2 font-mono text-[10px] leading-relaxed">
            <code dangerouslySetInnerHTML={{ __html: highlightJson(entry.data) }} />
          </pre>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        {entry.data && Object.keys(entry.data).length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-[10px]"
            onClick={() => copyToClipboard(JSON.stringify(entry.data, null, 2))}
          >
            <Copy className="h-3 w-3" /> Copy JSON
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-[10px]"
          onClick={() => copyToClipboard(JSON.stringify(entry, null, 2))}
        >
          <Copy className="h-3 w-3" /> Copy Full Entry
        </Button>
        {entry.traceId && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 border-primary/30 text-[10px] text-primary"
            onClick={() => { window.location.hash = `#/traces?traceId=${entry.traceId}`; }}
          >
            <ExternalLink className="h-3 w-3" /> View Trace
          </Button>
        )}
      </div>
    </div>
  );
}

// ── StatCard (matches Traces page pattern) ──

function StatCard({ icon, label, value, sub, variant }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  variant?: "success" | "warning" | "destructive";
}) {
  return (
    <Card className="transition-colors hover:bg-accent/30">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          {icon}
          <span className="text-[10px] font-medium uppercase tracking-wider">{label}</span>
        </div>
        <div className={cn(
          "mt-2 text-xl font-bold leading-none tracking-tight sm:text-2xl",
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

// ── Helpers ──

function formatLogTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return ts.slice(11, 19);
  }
}

function formatTimeAgo(ts: string): string {
  try {
    const diff = Date.now() - new Date(ts).getTime();
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  } catch {
    return ts.slice(11, 16);
  }
}

function highlightJson(data: Record<string, unknown>): string {
  const json = JSON.stringify(data, null, 2);
  return json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Keys
    .replace(/"([^"]+)"(?=\s*:)/g, '<span class="text-green-400">"$1"</span>')
    // String values
    .replace(/:\s*"([^"]*?)"/g, ': <span class="text-blue-400">"$1"</span>')
    // Numbers
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="text-yellow-400">$1</span>')
    // Booleans & null
    .replace(/:\s*(true|false|null)/g, ': <span class="text-purple-400">$1</span>');
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {
    // Fallback for non-HTTPS
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  });
}
```

- [ ] **Step 2: Verify the frontend builds**

Run: `cd /data00/home/hehuajie/project/remi/web/frontend && npx vite build 2>&1 | tail -10`

Expected: Build success with no TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/pages/Logs.tsx
git commit -m "feat(logs): full page rewrite with stat cards, chart, search, accordion detail"
```

---

### Task 8: Manual verification

- [ ] **Step 1: Start the dev server**

Run: `cd /data00/home/hehuajie/project/remi && git checkout dashboard-redesign && bun run web/server.ts`

Or if the server is already running on port 5199, just refresh the browser.

- [ ] **Step 2: Verify in browser**

Open `http://10.37.66.8:5199/#/logs` and verify:

1. **Stat cards** — 4 cards showing Total Entries, Errors, Active Modules, Last Error
2. **Hourly chart** — Bar chart showing distribution, red overlay for error hours, future hours muted
3. **Filter bar** — Date, Level (with ≥ hint), Module, Search messages, Trace ID, entry count, Auto 30s toggle, Refresh button
4. **Search** — Type in "Search messages..." input, 300ms debounce, results filter
5. **Auto-refresh** — Click "Auto 30s", green dot appears and pulses, data refreshes every 30s
6. **Log table** — Click a row to expand detail: full message, metadata, JSON with syntax highlighting
7. **Action buttons** — Copy JSON, Copy Full Entry, View Trace (navigates to traces page)
8. **Responsive** — Resize browser: cards reflow, columns hide on smaller screens

- [ ] **Step 3: Final commit — all changes together if any fixups**

```bash
git add -A
git commit -m "fix(logs): address review fixes from manual testing"
```

Only commit this if there are actual fixups needed from manual testing.
