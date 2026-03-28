import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  Clock, RefreshCw, AlertTriangle, Check, Play,
  Timer, Activity, XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSchedulerStore } from "../stores/scheduler";
import type { CronRunEntry, DailySchedulerSummary, SchedulerJobStatus } from "../api/types";

export function Scheduler() {
  const { status, history, summary, selectedJobId, fetchStatus, fetchHistory, fetchSummary, setSelectedJobId } = useSchedulerStore();

  useEffect(() => {
    fetchStatus();
    fetchHistory();
    fetchSummary(7);
  }, []);

  const enabledJobs = status?.jobs.filter(j => j.enabled) ?? [];
  const okCount = enabledJobs.filter(j => j.lastRun?.status === "ok").length;
  const errorCount = enabledJobs.filter(j => j.lastRun?.status === "error").length;
  const totalJobs = enabledJobs.length;
  const avgDuration = history.length > 0
    ? history.reduce((sum, e) => sum + e.durationMs, 0) / history.length
    : 0;

  return (
    <Layout title="Scheduler" subtitle="CRON ENGINE">
      {/* ── Top Stats ── */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Play className="h-4 w-4" />}
          label="Active Jobs"
          value={String(totalJobs)}
          sub={`${okCount} OK \u00b7 ${errorCount} ERR`}
          variant={errorCount > 0 ? "destructive" : "success"}
        />
        <StatCard
          icon={<Activity className="h-4 w-4" />}
          label="Health"
          value={totalJobs > 0 ? `${((okCount / totalJobs) * 100).toFixed(0)}%` : "\u2014"}
          sub={`${okCount} of ${totalJobs} healthy`}
          variant={errorCount > 0 ? "warning" : "success"}
        />
        <StatCard
          icon={<Timer className="h-4 w-4" />}
          label="Avg Duration"
          value={avgDuration > 0 ? formatDuration(avgDuration) : "\u2014"}
          sub="Recent runs"
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Errors"
          value={String(enabledJobs.reduce((s, j) => s + j.consecutiveErrors, 0))}
          sub="Consecutive"
          variant={errorCount > 0 ? "destructive" : undefined}
        />
      </div>

      {/* ── Job Registry ── */}
      <Card className="mb-3">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Job Registry
          </CardTitle>
          <Button
            variant="ghost" size="sm"
            onClick={() => { fetchStatus(); fetchHistory(selectedJobId); }}
            className="h-7 text-xs text-muted-foreground"
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="max-h-[400px]">
            <JobTable jobs={enabledJobs} selectedJobId={selectedJobId} onSelectJob={setSelectedJobId} />
          </ScrollArea>
        </CardContent>
      </Card>

      {/* ── Job Config (shown when a job is selected) ── */}
      {selectedJobId && (() => {
        const selectedJob = enabledJobs.find(j => j.jobId === selectedJobId);
        if (!selectedJob?.config) return null;
        return (
          <Card className="mb-3">
            <CardHeader className="space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Config — {selectedJob.jobName}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ConfigDetail config={selectedJob.config} />
            </CardContent>
          </Card>
        );
      })()}

      {/* ── 7-Day Trend ── */}
      <Card className="mb-3">
        <CardHeader className="space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-muted-foreground" />
            7-Day Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TrendChart summary={summary} />
        </CardContent>
      </Card>

      {/* ── Recent Executions ── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4 text-muted-foreground" />
            {selectedJobId ? `History \u2014 ${selectedJobId}` : "Recent Executions"}
          </CardTitle>
          <Button
            variant="ghost" size="sm"
            onClick={() => {
              if (selectedJobId) setSelectedJobId(undefined);
              else fetchHistory();
            }}
            className="h-7 text-xs text-muted-foreground"
          >
            {selectedJobId ? "Show All" : (
              <>
                <RefreshCw className="mr-1 h-3 w-3" />
                Refresh
              </>
            )}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="max-h-[500px]">
            <RunHistoryTable runs={history} />
          </ScrollArea>
        </CardContent>
      </Card>
    </Layout>
  );
}

// ── Stat Card ────────────────────────────────────────

function StatCard({ icon, label, value, sub, variant }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  variant?: "success" | "warning" | "destructive";
}) {
  return (
    <Card className="transition-colors hover:bg-accent/30" style={{ animation: "fade-in 0.3s ease-out both" }}>
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

// ── Job Table ────────────────────────────────────────

function JobTable({ jobs, selectedJobId, onSelectJob }: {
  jobs: SchedulerJobStatus[];
  selectedJobId: string | undefined;
  onSelectJob: (id: string | undefined) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div className="p-8 text-center text-xs text-muted-foreground">
        No jobs registered
      </div>
    );
  }

  const systemJobs = jobs.filter(j => j.handler.startsWith("builtin:") || j.handler.startsWith("agent:"));
  const skillJobs = jobs.filter(j => !j.handler.startsWith("builtin:") && !j.handler.startsWith("agent:"));

  const renderJobRow = (job: SchedulerJobStatus) => {
    const last = job.lastRun;
    const isSelected = selectedJobId === job.jobId;
    return (
      <TableRow
        key={job.jobId}
        className={cn(
          "cursor-pointer border-l-2",
          isSelected
            ? "border-l-success/50 bg-accent/30"
            : "border-l-transparent"
        )}
        onClick={() => onSelectJob(isSelected ? undefined : job.jobId)}
      >
        <TableCell>
          <div className="flex items-center gap-2">
            <div className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              !last ? "bg-muted-foreground" :
              last.status === "ok" ? "bg-success" : "bg-destructive"
            )} />
            <span className="truncate font-mono text-xs" title={job.jobId}>
              {job.jobName}
            </span>
          </div>
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">
          {formatSchedule(job.schedule)}
        </TableCell>
        <TableCell className="text-center">
          <Badge
            variant={
              !last ? "outline" :
              last.status === "ok" ? "success" : "destructive"
            }
            className="text-[9px]"
          >
            {!last ? "\u2014" : last.status === "ok" ? "OK" : last.status === "error" ? "ERR" : "SKIP"}
          </Badge>
        </TableCell>
        <TableCell className="hidden text-right font-mono text-xs text-muted-foreground sm:table-cell">
          {last ? formatAgo(last.finishedAt) : "\u2014"}
        </TableCell>
        <TableCell className="hidden text-right font-mono text-xs text-muted-foreground sm:table-cell">
          {job.nextRunAt ? formatAgo(job.nextRunAt, true) : "\u2014"}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Job</TableHead>
          <TableHead>Schedule</TableHead>
          <TableHead className="text-center">Status</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Last Run</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Next Run</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {systemJobs.length > 0 && (
          <>
            <TableRow>
              <TableCell colSpan={5} className="bg-muted/50 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                System Tasks
              </TableCell>
            </TableRow>
            {systemJobs.map(renderJobRow)}
          </>
        )}
        {skillJobs.length > 0 && (
          <>
            <TableRow>
              <TableCell colSpan={5} className="bg-muted/50 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Skill Tasks
              </TableCell>
            </TableRow>
            {skillJobs.map(renderJobRow)}
          </>
        )}
      </TableBody>
    </Table>
  );
}

// ── Run History Table ────────────────────────────────

function RunHistoryTable({ runs }: { runs: CronRunEntry[] }) {
  if (runs.length === 0) {
    return (
      <div className="p-8 text-center text-xs text-muted-foreground">
        No executions
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Job</TableHead>
          <TableHead className="text-center">Status</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="hidden sm:table-cell">Error</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run, i) => (
          <TableRow
            key={`${run.ts}-${i}`}
            className={cn(
              "border-l-2 border-l-transparent",
              "hover:border-l-primary/30"
            )}
          >
            <TableCell className="font-mono text-xs text-muted-foreground">
              {formatTime(run.ts)}
            </TableCell>
            <TableCell className="max-w-[120px] truncate font-mono text-xs" title={run.jobId ?? ""}>
              {run.jobId ?? "\u2014"}
            </TableCell>
            <TableCell className="text-center">
              <div className="flex items-center justify-center gap-1">
                <Badge
                  variant={run.status === "ok" ? "success" : "destructive"}
                  className="text-[9px]"
                >
                  {run.status === "ok" ? (
                    <><Check className="mr-0.5 h-2.5 w-2.5" />{run.status}</>
                  ) : (
                    <><XCircle className="mr-0.5 h-2.5 w-2.5" />{run.status}</>
                  )}
                </Badge>
                {run.phase && (
                  <span className="rounded bg-muted px-1 py-0.5 text-[8px] font-medium uppercase text-muted-foreground">
                    {run.phase === "generate" ? "GEN" : run.phase === "push" ? "PUSH" : run.phase}
                  </span>
                )}
              </div>
            </TableCell>
            <TableCell className="text-right font-mono text-xs text-muted-foreground">
              {formatDuration(run.durationMs)}
            </TableCell>
            <TableCell className="hidden max-w-[200px] truncate text-xs text-destructive sm:table-cell" title={run.error ?? ""}>
              {run.error ?? "\u2014"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── 7-Day Trend Chart ───────────────────────────────

function TrendChart({ summary }: { summary: DailySchedulerSummary[] }) {
  if (summary.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">
        No data
      </div>
    );
  }

  const sorted = [...summary].sort((a, b) => a.date.localeCompare(b.date));
  const w = 500;
  const h = 200;
  const margin = { top: 10, right: 10, bottom: 30, left: 40 };
  const chartW = w - margin.left - margin.right;
  const chartH = h - margin.top - margin.bottom;

  const maxVal = Math.max(1, ...sorted.map(d => d.total));
  const barW = Math.max(8, (chartW / sorted.length) * 0.6);
  const gap = (chartW / sorted.length) * 0.4;

  const yTicks = 4;
  const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const val = (maxVal / yTicks) * i;
    const y = chartH - (val / maxVal) * chartH;
    return { val, y };
  });

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[200px] w-full">
      <g transform={`translate(${margin.left},${margin.top})`}>
        {/* Grid lines */}
        {gridLines.map((g, i) => (
          <g key={i}>
            <line
              x1={0} y1={g.y} x2={chartW} y2={g.y}
              className="stroke-border" strokeWidth={0.5}
            />
            <text
              x={-8} y={g.y + 3} textAnchor="end"
              className="fill-muted-foreground text-[8px]" fontFamily="var(--font-mono)"
            >
              {Math.round(g.val)}
            </text>
          </g>
        ))}

        {/* Bars */}
        {sorted.map((d, i) => {
          const x = i * (barW + gap);
          const okH = (d.ok / maxVal) * chartH;
          const errH = (d.error / maxVal) * chartH;
          const skipH = (d.skipped / maxVal) * chartH;
          const tooltip = `${d.date}\nTotal: ${d.total}\nOK: ${d.ok}\nError: ${d.error}\nSkipped: ${d.skipped}`;

          return (
            <g key={d.date}>
              {/* Skipped (bottom) */}
              <rect
                x={x} y={chartH - skipH}
                width={barW} height={Math.max(0, skipH)}
                className="fill-warning/70" rx={1}
              >
                <title>{tooltip}</title>
              </rect>
              {/* Error (middle) */}
              <rect
                x={x} y={chartH - skipH - errH}
                width={barW} height={Math.max(0, errH)}
                className="fill-destructive/70" rx={1}
              >
                <title>{tooltip}</title>
              </rect>
              {/* OK (top) */}
              <rect
                x={x} y={chartH - skipH - errH - okH}
                width={barW} height={Math.max(0, okH)}
                className="fill-success/70" rx={1}
              >
                <title>{tooltip}</title>
              </rect>
              {/* Date label */}
              <text
                x={x + barW / 2} y={chartH + 16} textAnchor="middle"
                className="fill-muted-foreground text-[8px]" fontFamily="var(--font-mono)"
              >
                {d.date.slice(5)}
              </text>
            </g>
          );
        })}
      </g>

      {/* Legend */}
      <g transform={`translate(${margin.left}, ${h - 6})`}>
        <rect x={0} y={-6} width={8} height={8} className="fill-success/70" rx={1} />
        <text x={12} y={1} className="fill-muted-foreground text-[8px]" fontFamily="var(--font-mono)">OK</text>
        <rect x={40} y={-6} width={8} height={8} className="fill-destructive/70" rx={1} />
        <text x={52} y={1} className="fill-muted-foreground text-[8px]" fontFamily="var(--font-mono)">Error</text>
        <rect x={90} y={-6} width={8} height={8} className="fill-warning/70" rx={1} />
        <text x={102} y={1} className="fill-muted-foreground text-[8px]" fontFamily="var(--font-mono)">Skipped</text>
      </g>
    </svg>
  );
}

// ── Config Detail ────────────────────────────────────

function ConfigDetail({ config }: { config: Record<string, unknown> }) {
  const renderValue = (val: unknown, depth = 0): React.ReactNode => {
    if (val === null || val === undefined) return <span className="text-muted-foreground">—</span>;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      return <span className="font-mono text-xs">{String(val)}</span>;
    }
    if (Array.isArray(val)) {
      return <span className="font-mono text-xs">[{val.join(", ")}]</span>;
    }
    if (typeof val === "object") {
      return (
        <div className={cn(depth > 0 && "ml-3 border-l border-border pl-2")}>
          {Object.entries(val as Record<string, unknown>).map(([k, v]) => (
            <div key={k} className="flex gap-2 py-0.5">
              <span className="shrink-0 text-xs text-muted-foreground">{k}:</span>
              {renderValue(v, depth + 1)}
            </div>
          ))}
        </div>
      );
    }
    return <span className="font-mono text-xs">{String(val)}</span>;
  };

  // Filter out internal fields
  const visible = Object.entries(config).filter(([k]) => !k.startsWith("_"));

  return (
    <div className="space-y-0.5">
      {visible.map(([key, val]) => (
        <div key={key} className="flex gap-2 py-0.5">
          <span className="shrink-0 text-xs font-medium text-muted-foreground">{key}:</span>
          {renderValue(val)}
        </div>
      ))}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────

function formatSchedule(schedule: { kind: string; expr?: string; intervalMs?: number; at?: string }): string {
  if (schedule.kind === "cron" && schedule.expr) return schedule.expr;
  if (schedule.kind === "every" && schedule.intervalMs) {
    const ms = schedule.intervalMs;
    if (ms < 60_000) return `${ms / 1000}s`;
    if (ms < 3_600_000) return `${ms / 60_000}m`;
    return `${ms / 3_600_000}h`;
  }
  if (schedule.kind === "at" && schedule.at) return schedule.at.slice(0, 16);
  return "\u2014";
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return ts.slice(0, 19);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatAgo(isoStr: string, future = false): string {
  const ms = future
    ? new Date(isoStr).getTime() - Date.now()
    : Date.now() - new Date(isoStr).getTime();
  if (ms < 0 && !future) return "just now";
  if (ms < 0 && future) return "overdue";
  const prefix = future ? "in " : "";
  const suffix = future ? "" : " ago";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${prefix}${secs}s${suffix}`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${prefix}${mins}m${suffix}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${prefix}${hours}h${suffix}`;
  return `${prefix}${Math.floor(hours / 24)}d${suffix}`;
}
