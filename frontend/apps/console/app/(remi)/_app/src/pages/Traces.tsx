import { Component, useEffect, useState, type ReactNode } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { Activity, RefreshCw, AlertTriangle, Clock, Layers, ChevronRight, ChevronDown, MessageSquare } from "lucide-react";
import { cn } from "~remiadmin/lib/utils";
import { useTracesStore } from "../stores/traces";
import type { TraceDetail, ToolCallData } from "../api/types";

// ── Helpers ──

function formatTime(ts: string): string {
  try {
    const normalized = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return ts.slice(0, 19);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return ts.slice(0, 19);
  }
}

function formatDuration(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
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

const SPAN_COLORS: Record<string, string> = {
  memory: "#22c55e",
  provider: "#f59e0b",
  tool: "#a855f7",
  connector: "#3b82f6",
  core: "#06b6d4",
};

function spanColor(name: string): string {
  const prefix = name.split(".")[0];
  return SPAN_COLORS[prefix] ?? "#64748b";
}

const SPAN_LABELS: Record<string, string> = {
  "provider.chat": "Claude Processing",
  "memory.assemble": "Context Assembly",
};

function spanDisplayName(name: string): string {
  if (SPAN_LABELS[name]) return SPAN_LABELS[name];
  // tool.Read → Read, tool.Bash → Bash
  if (name.startsWith("tool.")) return name.slice(5);
  return name;
}

// ── Page ──

export function Traces() {
  const {
    traces, stats, loading, loadingMore, hasMore, error, date, statusFilter, search,
    selectedId, detail, detailLoading,
    setDate, setStatusFilter, setSearch, fetchTraces, loadMore, fetchDetail, clearSelection,
  } = useTracesStore();
  const [searchInput, setSearchInput] = useState("");

  useEffect(() => {
    fetchTraces();
    // Auto-load detail if traceId is in URL hash (from Logs page TRACE click)
    const hash = window.location.hash;
    const match = hash.match(/[?&]traceId=([^&]+)/);
    if (match) {
      const traceId = decodeURIComponent(match[1]);
      fetchDetail(traceId);
    }
    // Auto-open trace from sessionStorage (set by Conversations page)
    const highlight = sessionStorage.getItem("trace-highlight");
    if (highlight) {
      sessionStorage.removeItem("trace-highlight");
      fetchDetail(parseInt(highlight, 10));
    }
  }, []);

  const handleSearch = () => { setSearch(searchInput); };

  return (
    <Layout title="Traces" subtitle="DEBUG ANALYSIS">
      {/* ─── Filters ─── */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-[150px] text-xs"
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
        <div className="flex gap-1">
          <Input
            placeholder="Search message or ID..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="h-7 w-[200px] text-xs"
          />
          {search && (
            <Button variant="ghost" size="sm" onClick={() => { setSearchInput(""); setSearch(""); }} className="h-7 text-xs">
              Clear
            </Button>
          )}
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
          <StatCard icon={<Activity className="h-4 w-4" />} label="Total Traces"
            value={String(stats.total)} sub={stats.processing > 0 ? `${stats.processing} processing` : "Today"} />
          <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="Errors"
            value={String(stats.errors)} sub={`${stats.errorRate}% error rate`}
            variant={stats.errors > 0 ? "destructive" : "success"} />
          <StatCard icon={<Clock className="h-4 w-4" />} label="Avg Duration"
            value={formatDuration(stats.avgDurationMs)} sub="Completed only" />
          <StatCard icon={<Layers className="h-4 w-4" />} label="P95 Duration"
            value={formatDuration(stats.p95DurationMs)} sub="95th percentile"
            variant={stats.p95DurationMs > 30000 ? "warning" : undefined} />
        </div>
      )}

      {/* ─── Trace List ─── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-muted-foreground" /> Traces
          </CardTitle>
          <span className="text-xs text-muted-foreground">{traces.length} loaded</span>
        </CardHeader>
        <CardContent className="p-0">
          {error && <div className="px-4 py-2 font-mono text-xs text-destructive">{error}</div>}
          {traces.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {loading ? "Loading..." : "No traces"}
            </div>
          ) : (
            <ScrollArea className="max-h-[600px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]">ID</TableHead>
                    <TableHead className="w-[90px]">Time</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead className="w-[70px]">Status</TableHead>
                    <TableHead className="w-[70px] text-right">Duration</TableHead>
                    <TableHead className="hidden w-[80px] text-right lg:table-cell">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {traces.map(trace => (
                    <TableRow
                      key={trace.id}
                      onClick={() => fetchDetail(trace.id)}
                      className={cn(
                        "cursor-pointer border-l-2",
                        selectedId === trace.id ? "border-l-primary bg-primary/5" : "border-l-transparent"
                      )}
                    >
                      <TableCell className="font-mono text-[11px] text-muted-foreground">{trace.id}</TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">{formatTime(trace.createdAt)}</TableCell>
                      <TableCell className="max-w-0">
                        <div className="truncate text-xs">{trace.userMessage || "-"}</div>
                        {trace.chatId && (
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {trace.chatId.slice(-12)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(trace.status)} className="text-[9px] uppercase">{statusLabel(trace.status)}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">{formatDuration(trace.durationMs)}</TableCell>
                      <TableCell className="hidden text-right font-mono text-xs text-muted-foreground lg:table-cell">
                        {formatCost(trace.costUsd)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {/* Load more */}
              {hasMore && (
                <div className="p-3 text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="h-7 text-xs"
                  >
                    {loadingMore ? "Loading..." : "Load more"}
                  </Button>
                </div>
              )}
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* ─── Detail Sheet (right drawer) ─── */}
      <Sheet open={selectedId != null} onOpenChange={(open) => { if (!open) clearSelection(); }}>
        <SheetContent side="right" onClose={clearSelection} className="w-[700px] max-w-[90vw] overflow-y-auto p-0">
          <SheetHeader className="p-4 pb-2">
            <SheetTitle className="text-sm">Trace #{selectedId}</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            {detailLoading ? (
              <div className="py-12 text-center text-xs text-muted-foreground">Loading...</div>
            ) : detail ? (
              <ErrorBoundary>
                <TraceDetailView detail={detail} />
              </ErrorBoundary>
            ) : (
              <div className="py-12 text-center text-xs text-muted-foreground">Failed to load</div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Layout>
  );
}

// ── Detail View (inside Sheet) ──

function TraceDetailView({ detail }: { detail: TraceDetail }) {
  const { meta, userMessage, toolCalls, jsonlAvailable, timeline } = detail;

  return (
    <div className="space-y-5">
      {/* Meta stats */}
      <div className="grid grid-cols-3 gap-3">
        <MiniStat label="Status" value={statusLabel(meta.status)}
          className={meta.status === "failed" ? "text-destructive" : "text-success"} />
        <MiniStat label="Duration" value={formatDuration(meta.durationMs)} />
        <MiniStat label="Model" value={meta.model?.replace("claude-", "")?.split("[")[0] ?? "-"} />
        <MiniStat label="Cost" value={formatCost(meta.costUsd)} />
        <MiniStat label="Tokens" value={`${formatTokens(meta.inputTokens)} / ${formatTokens(meta.outputTokens)}`} />
        {meta.connector && <MiniStat label="Source" value={meta.connector} />}
        {meta.chatId && <CopyableId label="Chat ID" value={meta.chatId} />}
        {meta.sessionId && <CopyableId label="Session ID" value={meta.sessionId} />}
      </div>

      {/* Conversation link */}
      {meta.chatId && (
        <span
          onClick={() => {
            sessionStorage.setItem("conv-target", JSON.stringify({
              chatId: meta.chatId,
              threadId: meta.threadId,
            }));
            window.location.hash = "#/conversations";
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/50 px-3 py-1.5 text-xs cursor-pointer text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <MessageSquare className="h-3 w-3" />
          View Conversation
        </span>
      )}

      {/* User message */}
      {userMessage && (
        <div>
          <SectionLabel>User Message</SectionLabel>
          <CodeBlock>{userMessage.slice(0, 500)}</CodeBlock>
        </div>
      )}

      {/* Waterfall timeline */}
      {timeline && timeline.length > 0 && (
        <div>
          <SectionLabel>Timeline</SectionLabel>
          <WaterfallTimeline timeline={timeline} totalMs={meta.durationMs} toolCalls={toolCalls} />
        </div>
      )}

      {/* JSONL not available fallback */}
      {!jsonlAvailable && (
        <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
          JSONL session file not available
        </div>
      )}
    </div>
  );
}

// ── Waterfall Timeline ──

function WaterfallTimeline({ timeline, totalMs: metaTotalMs, toolCalls }: {
  timeline: TraceDetail["timeline"];
  totalMs: number;
  toolCalls: ToolCallData[];
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  // Use the actual max extent of timeline entries (they can exceed meta.durationMs)
  const totalMs = Math.max(metaTotalMs, ...timeline.map(e => e.startMs + e.durationMs));
  if (totalMs <= 0) return null;

  const barAreaWidth = 400;

  return (
    <div className="space-y-0.5">
      {/* Time axis */}
      <div className="mb-2 flex items-center">
        <div style={{ width: 140, minWidth: 140 }} />
        <div className="flex justify-between" style={{ width: barAreaWidth }}>
          {[0, 25, 50, 75, 100].map(pct => (
            <span key={pct} className="text-[9px] text-muted-foreground">
              {formatDuration(totalMs * pct / 100)}
            </span>
          ))}
        </div>
        <div style={{ width: 60 }} />
      </div>

      {/* Rows */}
      {timeline.map((entry, i) => {
        const left = (entry.startMs / totalMs) * barAreaWidth;
        const width = Math.max(2, (entry.durationMs / totalMs) * barAreaWidth);
        const color = spanColor(entry.name);
        const hasToolDetail = entry.toolIndex != null && toolCalls[entry.toolIndex];
        const isExpanded = expandedIdx === i;
        const tc = hasToolDetail ? toolCalls[entry.toolIndex!] : null;

        return (
          <div key={i}>
            <div
              className={cn(
                "flex items-center gap-1 rounded px-1 py-1 text-xs",
                hasToolDetail && "cursor-pointer hover:bg-muted/50"
              )}
              onClick={() => hasToolDetail && setExpandedIdx(isExpanded ? null : i)}
            >
              {/* Indent + icon */}
              <div className="flex items-center" style={{ width: 136, minWidth: 136, paddingLeft: entry.depth * 16 }}>
                {hasToolDetail ? (
                  isExpanded
                    ? <ChevronDown className="mr-1 h-3 w-3 text-muted-foreground" />
                    : <ChevronRight className="mr-1 h-3 w-3 text-muted-foreground" />
                ) : (
                  <span className="mr-1 inline-block h-3 w-3" />
                )}
                <span className="truncate font-mono text-[11px]" title={entry.name}>
                  {spanDisplayName(entry.name)}
                </span>
              </div>

              {/* Bar */}
              <div className="relative" style={{ width: barAreaWidth, height: 16 }}>
                <div
                  style={{
                    position: "absolute",
                    left,
                    width,
                    height: 14,
                    top: 1,
                    backgroundColor: color,
                    opacity: 0.7,
                    borderRadius: 3,
                  }}
                />
              </div>

              {/* Duration */}
              <span className="w-[60px] text-right font-mono text-[11px] text-muted-foreground">
                {formatDuration(entry.durationMs)}
              </span>
            </div>

            {/* Expanded tool call detail */}
            {isExpanded && tc && (
              <div className="mb-2 ml-8 mr-2 space-y-2 rounded-md border border-border/50 bg-muted/30 p-3">
                <div className="flex items-center gap-2 text-[10px]">
                  <span className={cn("h-1.5 w-1.5 rounded-full", tc.status === "error" ? "bg-destructive" : "bg-success")} />
                  <span className="font-medium">{tc.name}</span>
                  <span className="text-muted-foreground">{formatDuration(tc.durationMs)}</span>
                </div>
                <div>
                  <div className="mb-1 text-[10px] text-muted-foreground">Input</div>
                  <CodeBlock>{JSON.stringify(tc.input, null, 2)}</CodeBlock>
                </div>
                {tc.output && (
                  <div>
                    <div className="mb-1 text-[10px] text-muted-foreground">Output</div>
                    <CodeBlock maxH="150px">{tc.output}</CodeBlock>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Shared components ──

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{children}</div>;
}

function CodeBlock({ children, maxH = "120px" }: { children: ReactNode; maxH?: string }) {
  return (
    <pre className="overflow-auto rounded-md border border-border/50 bg-[hsl(var(--background))] p-2.5 font-mono text-[11px] leading-relaxed text-foreground/90 whitespace-pre-wrap"
      style={{ maxHeight: maxH }}>
      {children}
    </pre>
  );
}

function StatCard({ icon, label, value, sub, variant }: {
  icon: ReactNode; label: string; value: string; sub: string;
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
        )}>{value}</div>
        <div className="mt-1.5 truncate text-[10px] text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}

function CopyableId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="col-span-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 cursor-pointer group" onClick={copy} title="Click to copy">
        <code className="font-mono text-[11px] text-foreground/70 group-hover:text-foreground">{value}</code>
        <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
          {copied ? "Copied!" : "Copy"}
        </span>
      </div>
    </div>
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

// ── Error Boundary ──

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-xs">
          <div className="font-medium text-destructive">Render error</div>
          <pre className="mt-1 text-muted-foreground">{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
