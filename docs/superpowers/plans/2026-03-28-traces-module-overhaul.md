# Traces Module Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake traces page with a real debugging tool — server-side stats, JSONL-based tool call timeline, graceful degradation.

**Architecture:** DB for list + stats (fast SQL aggregation), JSONL files for detail (tool call chain). Linked via `cli_session_id` + `[cli_round_start, cli_round_end]` time window.

**Tech Stack:** Bun SQLite, Hono API, React + Zustand + shadcn/ui, existing `parser.ts` JSONL helpers.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/conversation/tool-calls.ts` | Parse JSONL → tool call pairs with timing |
| Modify | `web/remi-data.ts:573-594` | Add `getTraceStats()`, `getTraceDetail()`, update `getTraces()` |
| Modify | `web/handlers/traces.ts` | Add `/stats` and `/:id/detail` routes, add `status` filter |
| Modify | `web/frontend/src/api/types.ts:113-138` | New types: `TraceStats`, `TraceDetail`, `ToolCallData`; simplify `TraceData` |
| Modify | `web/frontend/src/api/client.ts:108-111` | Add `getTraceStats()`, `getTraceDetail()` |
| Modify | `web/frontend/src/stores/traces.ts` | Add stats state, detail state, date/status filter |
| Rewrite | `web/frontend/src/pages/Traces.tsx` | New stats cards, new table columns, expandable detail panel |

---

## Task 1: JSONL Tool Call Parser

**Files:**
- Create: `src/conversation/tool-calls.ts`

- [ ] **Step 1: Create the parser module**

```typescript
// src/conversation/tool-calls.ts
import { readFileSync } from "node:fs";
import { findSessionJsonl } from "./parser.js";

export interface ToolCallData {
  name: string;
  input: Record<string, unknown>;
  output: string;
  durationMs: number;
  status: "ok" | "error";
}

/**
 * Extract tool_use → tool_result pairs from a JSONL file within a time window.
 * Returns them in chronological order with computed duration.
 */
export function extractToolCalls(
  sessionId: string,
  roundStart: string | null,
  roundEnd: string | null,
): { toolCalls: ToolCallData[]; jsonlAvailable: boolean } {
  const jsonlPath = findSessionJsonl(sessionId);
  if (!jsonlPath) return { toolCalls: [], jsonlAvailable: false };

  const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");

  const startMs = roundStart ? new Date(roundStart).getTime() : 0;
  const endMs = roundEnd ? new Date(roundEnd).getTime() : Infinity;

  // Collect tool_use events and their timestamps
  const pendingTools = new Map<string, { name: string; input: Record<string, unknown>; timestamp: number }>();
  const toolCalls: ToolCallData[] = [];

  for (const line of lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;

    // Skip events outside this round's time window
    if (ts < startMs - 5000 || ts > endMs + 5000) continue;

    if (obj.type === "assistant" && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === "tool_use" && block.id) {
          pendingTools.set(block.id, {
            name: block.name ?? "unknown",
            input: block.input ?? {},
            timestamp: ts,
          });
        }
      }
    }

    if (obj.type === "user" && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const pending = pendingTools.get(block.tool_use_id);
          if (!pending) continue;

          const outputRaw = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");

          toolCalls.push({
            name: pending.name,
            input: truncateObj(pending.input, 500),
            output: outputRaw.slice(0, 1000),
            durationMs: Math.max(0, ts - pending.timestamp),
            status: block.is_error ? "error" : "ok",
          });
          pendingTools.delete(block.tool_use_id);
        }
      }
    }
  }

  return { toolCalls, jsonlAvailable: true };
}

function truncateObj(obj: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  const str = JSON.stringify(obj);
  if (str.length <= maxChars) return obj;
  try { return JSON.parse(str.slice(0, maxChars) + '..."}}'); } catch {
    return { _truncated: str.slice(0, maxChars) };
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /data00/home/hehuajie/project/remi && bun build src/conversation/tool-calls.ts --no-bundle 2>&1 | head -5`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/conversation/tool-calls.ts
git commit -m "feat(traces): add JSONL tool call parser"
```

---

## Task 2: Backend — Stats + Detail APIs

**Files:**
- Modify: `web/remi-data.ts:573-594`
- Modify: `web/handlers/traces.ts`

- [ ] **Step 1: Add `getTraceStats()` and `getTraceDetail()` to RemiData**

Add the import at the top of `web/remi-data.ts`:

```typescript
import { extractToolCalls, type ToolCallData } from "../src/conversation/tool-calls.js";
```

Add after the existing `getTrace()` method at line 594:

```typescript
  getTraceStats(date: string): {
    total: number;
    processing: number;
    errors: number;
    errorRate: number;
    avgDurationMs: number;
    p95DurationMs: number;
  } {
    const db = getDb();
    const row = db.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as errors,
        AVG(CASE WHEN status = 'completed' THEN duration_ms END) as avg_duration
      FROM conversations
      WHERE DATE(created_at) = ?
    `).get(date) as any;

    // P95: get the duration at the 95th percentile of completed rows
    const completedCount = (row.total ?? 0) - (row.processing ?? 0) - (row.errors ?? 0);
    let p95 = 0;
    if (completedCount > 0) {
      const offset = Math.max(0, Math.ceil(completedCount * 0.95) - 1);
      const p95Row = db.query(`
        SELECT duration_ms FROM conversations
        WHERE DATE(created_at) = ? AND status = 'completed' AND duration_ms IS NOT NULL
        ORDER BY duration_ms ASC
        LIMIT 1 OFFSET ?
      `).get(date, offset) as any;
      p95 = p95Row?.duration_ms ?? 0;
    }

    const total = row.total ?? 0;
    const errors = row.errors ?? 0;
    return {
      total,
      processing: row.processing ?? 0,
      errors,
      errorRate: total > 0 ? Math.round((errors / total) * 10000) / 100 : 0,
      avgDurationMs: Math.round(row.avg_duration ?? 0),
      p95DurationMs: p95,
    };
  }

  getTraceDetail(id: number): {
    meta: {
      status: string;
      durationMs: number;
      model: string | null;
      costUsd: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      connector: string | null;
      chatId: string;
      senderName: string | null;
    };
    userMessage: string | null;
    toolCalls: ToolCallData[];
    jsonlAvailable: boolean;
    remiSpans: Array<{ op: string; ms: number }>;
  } | null {
    const db = getDb();
    const row = db.query(`
      SELECT id, status, error, chat_id, sender_id, connector,
             cli_session_id, cost_usd, duration_ms, model,
             input_tokens, output_tokens, spans, user_message,
             created_at, cli_round_start, cli_round_end
      FROM conversations WHERE id = ?
    `).get(id) as any | null;
    if (!row) return null;

    // Parse Remi spans from DB
    let remiSpans: Array<{ op: string; ms: number }> = [];
    try { remiSpans = JSON.parse(row.spans ?? "[]"); } catch {}

    // Extract tool calls from JSONL
    let toolCalls: ToolCallData[] = [];
    let jsonlAvailable = false;
    if (row.cli_session_id) {
      const result = extractToolCalls(row.cli_session_id, row.cli_round_start, row.cli_round_end);
      toolCalls = result.toolCalls;
      jsonlAvailable = result.jsonlAvailable;
    }

    return {
      meta: {
        status: row.status,
        durationMs: row.duration_ms ?? 0,
        model: row.model,
        costUsd: row.cost_usd,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        connector: row.connector,
        chatId: row.chat_id,
        senderName: row.sender_id,
      },
      userMessage: row.user_message,
      toolCalls,
      jsonlAvailable,
      remiSpans,
    };
  }
```

- [ ] **Step 2: Update `getTraces()` to accept status filter and return flat data**

Replace the existing `getTraces()` method at line 575:

```typescript
  getTraces(date: string, limit: number, status?: string): Array<{
    id: number;
    status: string;
    durationMs: number;
    model: string | null;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    connector: string | null;
    createdAt: string;
  }> {
    const db = getDb();
    let sql = `
      SELECT id, status, duration_ms, model, cost_usd,
             input_tokens, output_tokens, connector, created_at
      FROM conversations
      WHERE DATE(created_at) = ?
    `;
    const params: any[] = [date];

    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = db.query(sql).all(...params) as any[];
    return rows.map(r => ({
      id: r.id,
      status: r.status,
      durationMs: r.duration_ms ?? 0,
      model: r.model,
      costUsd: r.cost_usd,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      connector: r.connector,
      createdAt: r.created_at,
    }));
  }
```

- [ ] **Step 3: Update handlers**

Rewrite `web/handlers/traces.ts`:

```typescript
import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerTracesHandlers(app: Hono, data: RemiData) {
  // Stats (server-side aggregation)
  app.get("/api/v1/traces/stats", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    return c.json(data.getTraceStats(date));
  });

  // List (flat rows, no fake spans)
  app.get("/api/v1/traces", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
    const status = c.req.query("status") || undefined;
    return c.json(data.getTraces(date, limit, status));
  });

  // Detail (DB meta + JSONL tool calls)
  app.get("/api/v1/traces/:id/detail", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const detail = data.getTraceDetail(id);
    if (!detail) return c.json({ error: "Trace not found" }, 404);
    return c.json(detail);
  });
}
```

- [ ] **Step 4: Verify backend compiles**

Run: `cd /data00/home/hehuajie/project/remi && bun build web/handlers/traces.ts --no-bundle 2>&1 | head -10`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add web/remi-data.ts web/handlers/traces.ts
git commit -m "feat(traces): add stats and detail APIs with JSONL parsing"
```

---

## Task 3: Frontend Types + API Client

**Files:**
- Modify: `web/frontend/src/api/types.ts:113-138`
- Modify: `web/frontend/src/api/client.ts:108-111`

- [ ] **Step 1: Replace trace types in `types.ts`**

Replace lines 113-138 (the `// Traces` section, both `SpanData` and `TraceData` interfaces) with:

```typescript
// Traces — list item (flat, from DB)
export interface TraceListItem {
  id: number;
  status: string;
  durationMs: number;
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  connector: string | null;
  createdAt: string;
}

// Traces — stats (server-side aggregation)
export interface TraceStats {
  total: number;
  processing: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
}

// Traces — tool call from JSONL
export interface ToolCallData {
  name: string;
  input: Record<string, unknown>;
  output: string;
  durationMs: number;
  status: "ok" | "error";
}

// Traces — detail (DB meta + JSONL tool calls)
export interface TraceDetail {
  meta: {
    status: string;
    durationMs: number;
    model: string | null;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    connector: string | null;
    chatId: string;
    senderName: string | null;
  };
  userMessage: string | null;
  toolCalls: ToolCallData[];
  jsonlAvailable: boolean;
  remiSpans: Array<{ op: string; ms: number }>;
}
```

- [ ] **Step 2: Update API client functions**

Replace lines 107-111 (the `// Traces` section) in `client.ts` with:

```typescript
// Traces
export const getTraceStats = (date?: string) =>
  request<import("./types").TraceStats>(`/api/v1/traces/stats${date ? `?date=${date}` : ""}`);
export const getTraces = (date?: string, limit = 50, status?: string) => {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  params.set("limit", String(limit));
  if (status) params.set("status", status);
  return request<import("./types").TraceListItem[]>(`/api/v1/traces?${params}`);
};
export const getTraceDetail = (id: number) =>
  request<import("./types").TraceDetail>(`/api/v1/traces/${id}/detail`);
```

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/api/types.ts web/frontend/src/api/client.ts
git commit -m "feat(traces): update frontend types and API client"
```

---

## Task 4: Zustand Store

**Files:**
- Rewrite: `web/frontend/src/stores/traces.ts`

- [ ] **Step 1: Rewrite the store**

```typescript
import { create } from "zustand";
import type { TraceListItem, TraceStats, TraceDetail } from "../api/types";
import * as api from "../api/client";

interface TracesState {
  // List
  traces: TraceListItem[];
  stats: TraceStats | null;
  loading: boolean;
  error: string | null;
  // Filters
  date: string; // YYYY-MM-DD
  statusFilter: string; // "" = all, "completed", "failed", "processing"
  // Detail
  selectedId: number | null;
  detail: TraceDetail | null;
  detailLoading: boolean;
  // Actions
  setDate: (date: string) => void;
  setStatusFilter: (status: string) => void;
  fetchTraces: () => Promise<void>;
  fetchDetail: (id: number) => Promise<void>;
  clearSelection: () => void;
}

export const useTracesStore = create<TracesState>((set, get) => ({
  traces: [],
  stats: null,
  loading: false,
  error: null,
  date: new Date().toISOString().slice(0, 10),
  statusFilter: "",
  selectedId: null,
  detail: null,
  detailLoading: false,

  setDate: (date) => {
    set({ date, selectedId: null, detail: null });
    get().fetchTraces();
  },

  setStatusFilter: (statusFilter) => {
    set({ statusFilter, selectedId: null, detail: null });
    get().fetchTraces();
  },

  fetchTraces: async () => {
    const { date, statusFilter } = get();
    set({ loading: true });
    try {
      const [traces, stats] = await Promise.all([
        api.getTraces(date, 200, statusFilter || undefined),
        api.getTraceStats(date),
      ]);
      set({ traces, stats, loading: false, error: null });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fetchDetail: async (id) => {
    set({ selectedId: id, detailLoading: true });
    try {
      const detail = await api.getTraceDetail(id);
      set({ detail, detailLoading: false });
    } catch (e: any) {
      set({ error: e.message, detailLoading: false });
    }
  },

  clearSelection: () => set({ selectedId: null, detail: null }),
}));
```

- [ ] **Step 2: Commit**

```bash
git add web/frontend/src/stores/traces.ts
git commit -m "feat(traces): rewrite store with stats, filters, and detail"
```

---

## Task 5: Traces Page Rewrite

**Files:**
- Rewrite: `web/frontend/src/pages/Traces.tsx`

- [ ] **Step 1: Rewrite the page**

```tsx
import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Activity, RefreshCw, AlertTriangle, Clock, Layers, ChevronDown, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTracesStore } from "../stores/traces";
import type { TraceListItem, TraceDetail, ToolCallData } from "../api/types";

// ── Helpers ──

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return ts.slice(0, 19);
  }
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}

function formatTokens(n: number | null): string {
  if (n == null) return "-";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function formatCost(usd: number | null): string {
  if (usd == null) return "-";
  return `$${usd.toFixed(2)}`;
}

function statusLabel(s: string): string {
  if (s === "completed") return "OK";
  if (s === "failed") return "Error";
  if (s === "processing") return "Processing";
  return s;
}

function statusVariant(s: string): "success" | "destructive" | "secondary" {
  if (s === "completed") return "success";
  if (s === "failed") return "destructive";
  return "secondary";
}

// ── Page ──

export function Traces() {
  const {
    traces, stats, loading, error, date, statusFilter,
    selectedId, detail, detailLoading,
    setDate, setStatusFilter, fetchTraces, fetchDetail, clearSelection,
  } = useTracesStore();

  useEffect(() => { fetchTraces(); }, []);

  return (
    <Layout title="Traces" subtitle="DEBUG ANALYSIS">
      {/* ─── Filters ─── */}
      <div className="mb-4 flex items-center gap-3">
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-[160px] text-xs"
        />
        <div className="flex gap-1">
          {["", "completed", "failed", "processing"].map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter(s)}
              className="h-7 text-xs"
            >
              {s === "" ? "All" : statusLabel(s)}
            </Button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fetchTraces()}
          disabled={loading}
          className="ml-auto h-7 text-xs text-muted-foreground"
        >
          <RefreshCw className={cn("mr-1 h-3 w-3", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* ─── Stat Cards ─── */}
      {stats && (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={<Activity className="h-4 w-4" />}
            label="Total Traces"
            value={String(stats.total)}
            sub={stats.processing > 0 ? `${stats.processing} processing` : "Today"}
          />
          <StatCard
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Errors"
            value={String(stats.errors)}
            sub={`${stats.errorRate}% error rate`}
            variant={stats.errors > 0 ? "destructive" : "success"}
          />
          <StatCard
            icon={<Clock className="h-4 w-4" />}
            label="Avg Duration"
            value={formatDuration(stats.avgDurationMs)}
            sub="Completed only"
          />
          <StatCard
            icon={<Layers className="h-4 w-4" />}
            label="P95 Duration"
            value={formatDuration(stats.p95DurationMs)}
            sub="95th percentile"
            variant={stats.p95DurationMs > 30000 ? "warning" : undefined}
          />
        </div>
      )}

      {/* ─── Trace List ─── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Traces
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <div className="px-4 py-2 font-mono text-xs text-destructive">{error}</div>
          )}
          {traces.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {loading ? "Loading..." : "No traces"}
            </div>
          ) : (
            <ScrollArea className="max-h-[500px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px]">Time</TableHead>
                    <TableHead className="w-[80px]">Status</TableHead>
                    <TableHead className="w-[90px] text-right">Duration</TableHead>
                    <TableHead className="hidden sm:table-cell">Model</TableHead>
                    <TableHead className="hidden w-[100px] text-right md:table-cell">Tokens</TableHead>
                    <TableHead className="hidden w-[70px] text-right md:table-cell">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {traces.map(trace => (
                    <TableRow
                      key={trace.id}
                      onClick={() => fetchDetail(trace.id)}
                      className={cn(
                        "cursor-pointer border-l-2",
                        selectedId === trace.id
                          ? "border-l-primary bg-primary/5"
                          : "border-l-transparent"
                      )}
                    >
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {formatTime(trace.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(trace.status)} className="text-[9px] uppercase">
                          {statusLabel(trace.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {formatDuration(trace.durationMs)}
                      </TableCell>
                      <TableCell className="hidden truncate font-mono text-xs text-muted-foreground sm:table-cell">
                        {trace.model?.replace("claude-", "")?.split("[")[0] ?? "-"}
                      </TableCell>
                      <TableCell className="hidden text-right font-mono text-xs text-muted-foreground md:table-cell">
                        {formatTokens(trace.inputTokens)} / {formatTokens(trace.outputTokens)}
                      </TableCell>
                      <TableCell className="hidden text-right font-mono text-xs text-muted-foreground md:table-cell">
                        {formatCost(trace.costUsd)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* ─── Detail Panel ─── */}
      {selectedId && (
        <Card className="mt-4">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm">Trace #{selectedId}</CardTitle>
            <Button variant="ghost" size="sm" onClick={clearSelection} className="h-7 text-xs text-muted-foreground">
              <X className="mr-1 h-3 w-3" /> Close
            </Button>
          </CardHeader>
          <CardContent>
            {detailLoading ? (
              <div className="py-6 text-center text-xs text-muted-foreground">Loading detail...</div>
            ) : detail ? (
              <TraceDetailPanel detail={detail} />
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">Failed to load</div>
            )}
          </CardContent>
        </Card>
      )}
    </Layout>
  );
}

// ── Detail Panel ──

function TraceDetailPanel({ detail }: { detail: TraceDetail }) {
  const { meta, userMessage, toolCalls, jsonlAvailable, remiSpans } = detail;
  return (
    <div className="space-y-4">
      {/* Meta */}
      <div className="flex flex-wrap gap-4 text-xs">
        <MiniStat label="Status" value={statusLabel(meta.status)}
          className={meta.status === "failed" ? "text-destructive" : "text-success"} />
        <MiniStat label="Duration" value={formatDuration(meta.durationMs)} />
        <MiniStat label="Model" value={meta.model?.replace("claude-", "") ?? "-"} />
        <MiniStat label="Cost" value={formatCost(meta.costUsd)} />
        <MiniStat label="Tokens" value={`${formatTokens(meta.inputTokens)} / ${formatTokens(meta.outputTokens)}`} />
        {meta.connector && <MiniStat label="Connector" value={meta.connector} />}
      </div>

      {/* User message */}
      {userMessage && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">User Message</div>
          <div className="rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{userMessage.slice(0, 500)}</div>
        </div>
      )}

      {/* Tool Calls */}
      {!jsonlAvailable ? (
        <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          JSONL session file not available — showing DB data only
        </div>
      ) : toolCalls.length === 0 ? (
        <div className="text-xs text-muted-foreground">No tool calls in this round</div>
      ) : (
        <div>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Tool Calls ({toolCalls.length})
          </div>
          <div className="space-y-1">
            {toolCalls.map((tc, i) => (
              <ToolCallRow key={i} tc={tc} />
            ))}
          </div>
        </div>
      )}

      {/* Remi Spans (supplementary) */}
      {remiSpans.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Remi Processing Steps
          </div>
          <div className="flex flex-wrap gap-2">
            {remiSpans.map((s, i) => (
              <span key={i} className="rounded bg-muted px-2 py-0.5 font-mono text-[11px]">
                {s.op} <span className="text-muted-foreground">{formatDuration(s.ms)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tool Call Row (collapsible) ──

function ToolCallRow({ tc }: { tc: ToolCallData }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50">
        <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
        <span className={cn("w-2 h-2 rounded-full", tc.status === "error" ? "bg-destructive" : "bg-success")} />
        <span className="flex-1 truncate font-mono">{tc.name}</span>
        <span className="font-mono text-muted-foreground">{formatDuration(tc.durationMs)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-7 mt-1 space-y-1">
        <div>
          <div className="text-[10px] text-muted-foreground">Input</div>
          <pre className="max-h-[120px] overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap">
            {JSON.stringify(tc.input, null, 2)}
          </pre>
        </div>
        {tc.output && (
          <div>
            <div className="text-[10px] text-muted-foreground">Output</div>
            <pre className="max-h-[120px] overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap">
              {tc.output}
            </pre>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Sub-components ──

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

function MiniStat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("text-sm font-semibold", className)}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: Remove WaterfallChart import (no longer used)**

The WaterfallChart component file can stay on disk but is no longer imported. The old `SpanData` and `TraceData` types it references are removed, so check for other imports:

Run: `cd /data00/home/hehuajie/project/remi && grep -r "WaterfallChart\|SpanData\|TraceData" web/frontend/src/ --include="*.tsx" --include="*.ts" | grep -v node_modules | grep -v "types.ts"`

If WaterfallChart is only imported in Traces.tsx (which we just rewrote), no further changes needed. If other files reference the old types, update them.

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/pages/Traces.tsx web/frontend/src/stores/traces.ts
git commit -m "feat(traces): rewrite page with real stats, JSONL detail, and filters"
```

---

## Task 6: Cleanup + Smoke Test

- [ ] **Step 1: Check for broken imports**

Run: `cd /data00/home/hehuajie/project/remi && grep -rn "rowToTraceData\|getTrace(" web/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "remi-data.ts" | grep -v "handlers/traces.ts"`

If `rowToTraceData` is still imported elsewhere, keep the function in `tracing.ts` but it's no longer used by the traces handlers. The old `getTrace()` method (returning `TraceData`) is replaced by `getTraceDetail()`.

- [ ] **Step 2: Build frontend**

Run: `cd /data00/home/hehuajie/project/remi/web/frontend && bun run build 2>&1 | tail -20`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 3: Start dev server and verify**

Run: `cd /data00/home/hehuajie/project/remi && bun run src/main.ts serve &`

Test endpoints:
```bash
curl -s http://localhost:5199/api/v1/traces/stats | head -1
# Should return JSON with total, processing, errors, etc.

curl -s "http://localhost:5199/api/v1/traces?limit=3" | head -1
# Should return array of {id, status, durationMs, model, ...}

curl -s http://localhost:5199/api/v1/traces/4914/detail | head -1
# Should return {meta, userMessage, toolCalls, jsonlAvailable, remiSpans}
```

- [ ] **Step 4: Fix any issues found**

Address compilation errors or runtime issues.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "fix(traces): cleanup broken imports and build fixes"
```

---

## Summary

| Task | What | Commits |
|------|------|---------|
| 1 | JSONL tool call parser | 1 |
| 2 | Backend stats + detail APIs | 1 |
| 3 | Frontend types + API client | 1 |
| 4 | Zustand store rewrite | 1 |
| 5 | Traces page rewrite | 1 |
| 6 | Cleanup + smoke test | 1 |

Total: 6 tasks, ~6 commits.
