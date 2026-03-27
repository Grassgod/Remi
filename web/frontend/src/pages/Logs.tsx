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
              placeholder="All Levels"
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

      {/* ─── Hourly Chart ─── */}
      {stats && (
        <HourlyChart data={stats.hourly} currentHour={currentHour} />
      )}

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
