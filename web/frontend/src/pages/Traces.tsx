import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import { Activity, RefreshCw, X, AlertTriangle, Clock, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { WaterfallChart } from "../components/WaterfallChart";
import { useTracesStore } from "../stores/traces";
import type { TraceData } from "../api/types";

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

function calculateP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Page ──

export function Traces() {
  const { traces, selectedTrace, loading, error, fetchTraces, fetchTrace, clearSelection } = useTracesStore();

  useEffect(() => {
    fetchTraces();
  }, []);

  const totalTraces = traces.length;
  const errorTraces = traces.filter(t => t.status === "ERROR").length;
  const avgDuration = totalTraces > 0 ? traces.reduce((s, t) => s + t.durationMs, 0) / totalTraces : 0;
  const p95Duration = totalTraces > 0 ? calculateP95(traces.map(t => t.durationMs)) : 0;

  return (
    <Layout title="Traces" subtitle="REQUEST TRACING">
      {/* ─── Stat Cards ─── */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Activity className="h-4 w-4" />}
          label="Total Traces"
          value={String(totalTraces)}
          sub="Latest batch"
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Errors"
          value={String(errorTraces)}
          sub={totalTraces > 0 ? `${((errorTraces / totalTraces) * 100).toFixed(1)}% error rate` : "---"}
          variant={errorTraces > 0 ? "destructive" : "success"}
        />
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          label="Avg Duration"
          value={formatDuration(avgDuration)}
          sub="Mean latency"
        />
        <StatCard
          icon={<Layers className="h-4 w-4" />}
          label="P95 Duration"
          value={formatDuration(p95Duration)}
          sub="95th percentile"
          variant={p95Duration > 30000 ? "warning" : undefined}
        />
      </div>

      {/* ─── Waterfall Detail ─── */}
      {selectedTrace && (
        <Card className="mb-4">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="h-4 w-4 text-muted-foreground" />
              Trace: {selectedTrace.traceId.slice(0, 12)}...
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={clearSelection} className="h-7 text-xs text-muted-foreground">
              <X className="mr-1 h-3 w-3" />
              Close
            </Button>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex flex-wrap gap-4">
              <MiniStat
                label="Status"
                value={selectedTrace.status}
                className={selectedTrace.status === "ERROR" ? "text-destructive" : "text-success"}
              />
              <MiniStat label="Duration" value={formatDuration(selectedTrace.durationMs)} />
              <MiniStat label="Spans" value={String(selectedTrace.spans.length)} />
              <MiniStat label="Start" value={formatTime(selectedTrace.startTime)} />
              {selectedTrace.source && <MiniStat label="Source" value={selectedTrace.source} />}
            </div>
            <WaterfallChart spans={selectedTrace.spans} totalDurationMs={selectedTrace.durationMs} />
          </CardContent>
        </Card>
      )}

      {/* ─── Trace List ─── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Recent Traces
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchTraces()}
            disabled={loading}
            className="h-7 text-xs text-muted-foreground"
          >
            <RefreshCw className={cn("mr-1 h-3 w-3", loading && "animate-spin")} />
            {loading ? "Loading..." : "Refresh"}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <div className="px-4 py-2 font-mono text-xs text-destructive">
              {error}
            </div>
          )}
          {traces.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {loading ? "Loading..." : "No traces yet"}
            </div>
          ) : (
            <ScrollArea className="max-h-[500px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px]">Time</TableHead>
                    <TableHead>Operation</TableHead>
                    <TableHead className="w-[80px]">Status</TableHead>
                    <TableHead className="w-[90px] text-right">Duration</TableHead>
                    <TableHead className="hidden w-[60px] text-right sm:table-cell">Spans</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {traces.map(trace => (
                    <TraceRow
                      key={trace.traceId}
                      trace={trace}
                      onClick={() => fetchTrace(trace.traceId)}
                      selected={selectedTrace?.traceId === trace.traceId}
                    />
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

function TraceRow({ trace, onClick, selected }: {
  trace: TraceData;
  onClick: () => void;
  selected: boolean;
}) {
  const isError = trace.status === "ERROR";
  return (
    <TableRow
      onClick={onClick}
      className={cn(
        "cursor-pointer border-l-2",
        selected
          ? "border-l-primary bg-primary/5"
          : "border-l-transparent"
      )}
    >
      <TableCell className="font-mono text-[11px] text-muted-foreground">
        {formatTime(trace.startTime)}
      </TableCell>
      <TableCell
        className="max-w-0 truncate font-mono text-xs"
        title={trace.rootSpan?.operationName ?? trace.traceId}
      >
        {trace.rootSpan?.operationName ?? trace.traceId.slice(0, 16)}
      </TableCell>
      <TableCell>
        <Badge
          variant={isError ? "destructive" : "success"}
          className="text-[9px] uppercase"
        >
          {trace.status}
        </Badge>
      </TableCell>
      <TableCell className="text-right font-mono text-xs text-muted-foreground">
        {formatDuration(trace.durationMs)}
      </TableCell>
      <TableCell className="hidden text-right font-mono text-xs text-muted-foreground sm:table-cell">
        {trace.spans.length}
      </TableCell>
    </TableRow>
  );
}

function MiniStat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("text-sm font-semibold", className)}>
        {value}
      </div>
    </div>
  );
}
