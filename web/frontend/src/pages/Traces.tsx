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
import type { TraceDetail, ToolCallData } from "../api/types";

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

  useEffect(() => {
    fetchTraces();
    // Auto-load detail if traceId is in URL hash (from Logs page TRACE click)
    const hash = window.location.hash;
    const match = hash.match(/[?&]traceId=([^&]+)/);
    if (match) {
      const traceId = decodeURIComponent(match[1]);
      fetchDetail(traceId);
    }
  }, []);

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
