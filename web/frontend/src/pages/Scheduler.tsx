import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { ArcCard } from "../components/ArcCard";
import { HudPanel } from "../components/HudPanel";
import { IconScheduler } from "../components/icons";
import { useSchedulerStore } from "../stores/scheduler";
import type { CronRunEntry, DailySchedulerSummary, SchedulerJobStatus } from "../api/types";

const STATUS_COLORS: Record<string, string> = {
  ok: "var(--glow-green, rgba(34,197,94,0.8))",
  error: "var(--glow-red, rgba(239,68,68,0.8))",
  skipped: "var(--glow-amber, rgba(245,158,11,0.8))",
};

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
      {/* Summary Cards */}
      <div className="sched-cards" style={{ display: "grid", gap: 12, marginBottom: 16 }}>
        <ArcCard
          label="Active Jobs"
          value={String(totalJobs)}
          sub={`${okCount} OK · ${errorCount} ERR`}
          color={errorCount > 0 ? "destructive" : "success"}
        />
        <ArcCard
          label="Health"
          value={totalJobs > 0 ? `${((okCount / totalJobs) * 100).toFixed(0)}%` : "—"}
          sub={`${okCount} OF ${totalJobs} HEALTHY`}
          color={errorCount > 0 ? "warning" : "success"}
        />
        <ArcCard
          label="Avg Duration"
          value={avgDuration > 0 ? formatDuration(avgDuration) : "—"}
          sub="RECENT RUNS"
          color="default"
        />
        <ArcCard
          label="Errors"
          value={String(enabledJobs.reduce((s, j) => s + j.consecutiveErrors, 0))}
          sub="CONSECUTIVE"
          color={errorCount > 0 ? "destructive" : "default"}
        />
      </div>

      {/* Job Status Table */}
      <HudPanel
        title="Job Registry"
        icon={<IconScheduler />}
        action={{ label: "Refresh", onClick: () => { fetchStatus(); fetchHistory(selectedJobId); } }}
        delay={0.1}
        maxHeight={400}
      >
        <JobTable jobs={enabledJobs} selectedJobId={selectedJobId} onSelectJob={setSelectedJobId} />
      </HudPanel>

      <div style={{ height: 14 }} />

      {/* 7-Day Trend */}
      <HudPanel title="7-Day Trend" icon={<IconScheduler />} delay={0.2} maxHeight={280}>
        <div style={{ padding: "12px 16px" }}>
          <TrendChart summary={summary} />
        </div>
      </HudPanel>

      <div style={{ height: 14 }} />

      {/* Recent Execution History */}
      <HudPanel
        title={selectedJobId ? `History — ${selectedJobId}` : "Recent Executions"}
        icon={<IconScheduler />}
        action={{
          label: selectedJobId ? "Show All" : "Refresh",
          onClick: () => {
            if (selectedJobId) setSelectedJobId(undefined);
            else fetchHistory();
          },
        }}
        delay={0.3}
        maxHeight={500}
      >
        <RunHistoryTable runs={history} />
      </HudPanel>

      <style>{`
        .sched-cards { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .sched-table-row { grid-template-columns: 1fr 100px 80px 80px 100px; }
        .sched-run-row { grid-template-columns: 140px 120px 65px 75px 1fr; }
        @media (max-width: 768px) {
          .sched-cards { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .sched-table-row { grid-template-columns: 1fr 80px 65px !important; }
          .sched-table-row > :nth-child(4), .sched-table-row > :nth-child(5) { display: none; }
          .sched-run-row { grid-template-columns: 120px 1fr 55px 65px !important; }
          .sched-run-row > :nth-child(5) { display: none; }
        }
        @media (max-width: 480px) {
          .sched-cards { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </Layout>
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
      <div style={{
        padding: "32px 16px", textAlign: "center",
        fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)",
      }}>
        NO JOBS REGISTERED
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      {/* Header */}
      <div className="sched-table-row" style={{
        display: "grid", padding: "8px 16px", gap: 6,
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1,
        textTransform: "uppercase", color: "var(--text-dim)",
      }}>
        <span>Job</span>
        <span>Schedule</span>
        <span style={{ textAlign: "center" }}>Status</span>
        <span style={{ textAlign: "right" }}>Last Run</span>
        <span style={{ textAlign: "right" }}>Next Run</span>
      </div>
      {jobs.map((job) => {
        const last = job.lastRun;
        const isSelected = selectedJobId === job.jobId;
        const scheduleStr = formatSchedule(job.schedule);
        return (
          <div
            key={job.jobId}
            className="sched-table-row"
            style={{
              display: "grid", padding: "6px 16px", gap: 6,
              cursor: "pointer",
              transition: "background 0.15s",
              borderLeft: `2px solid ${isSelected ? "rgba(34,197,94,0.5)" : "transparent"}`,
              background: isSelected ? "rgba(255,255,255,0.03)" : "transparent",
            }}
            onClick={() => onSelectJob(isSelected ? undefined : job.jobId)}
            onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
            onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <div style={{
                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: !last ? "rgba(255,255,255,0.2)" : last.status === "ok" ? "rgba(34,197,94,0.8)" : "rgba(239,68,68,0.8)",
              }} />
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-primary)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }} title={job.jobId}>
                {job.jobName}
              </span>
            </div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
              {scheduleStr}
            </span>
            <span style={{
              textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 8,
              letterSpacing: 1, textTransform: "uppercase", padding: "1px 4px", borderRadius: 2,
              border: `1px solid ${!last ? "rgba(255,255,255,0.1)" : last.status === "ok" ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}`,
              color: !last ? "var(--text-dim)" : last.status === "ok" ? "var(--glow-green, #22c55e)" : "var(--glow-red, #ef4444)",
            }}>
              {!last ? "—" : last.status === "ok" ? "OK" : last.status === "error" ? "ERR" : "SKIP"}
            </span>
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", textAlign: "right",
            }}>
              {last ? formatAgo(last.finishedAt) : "—"}
            </span>
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", textAlign: "right",
            }}>
              {job.nextRunAt ? formatAgo(job.nextRunAt, true) : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Run History Table ────────────────────────────────

function RunHistoryTable({ runs }: { runs: CronRunEntry[] }) {
  if (runs.length === 0) {
    return (
      <div style={{
        padding: "32px 16px", textAlign: "center",
        fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)",
      }}>
        NO EXECUTIONS
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <div className="sched-run-row" style={{
        display: "grid", padding: "8px 16px", gap: 6,
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1,
        textTransform: "uppercase", color: "var(--text-dim)",
      }}>
        <span>Time</span>
        <span>Job</span>
        <span style={{ textAlign: "center" }}>Status</span>
        <span style={{ textAlign: "right" }}>Duration</span>
        <span>Error</span>
      </div>
      {runs.map((run, i) => (
        <div
          key={`${run.ts}-${i}`}
          className="sched-run-row"
          style={{
            display: "grid", padding: "6px 16px", gap: 6,
            transition: "background 0.15s",
            borderLeft: "2px solid transparent",
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = "rgba(255,255,255,0.03)";
            e.currentTarget.style.borderLeftColor = run.status === "ok"
              ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)";
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.borderLeftColor = "transparent";
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
            {formatTime(run.ts)}
          </span>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-primary)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }} title={run.jobId ?? ""}>
            {run.jobId ?? "—"}
          </span>
          <span style={{
            textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 8,
            letterSpacing: 1, textTransform: "uppercase", padding: "1px 4px", borderRadius: 2,
            border: `1px solid ${run.status === "ok" ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}`,
            color: run.status === "ok" ? "var(--glow-green, #22c55e)" : "var(--glow-red, #ef4444)",
          }}>
            {run.status}
          </span>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", textAlign: "right",
          }}>
            {formatDuration(run.durationMs)}
          </span>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--glow-red, #ef4444)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }} title={run.error ?? ""}>
            {run.error ?? "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── 7-Day Trend Chart ───────────────────────────────

function TrendChart({ summary }: { summary: DailySchedulerSummary[] }) {
  if (summary.length === 0) {
    return (
      <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
        NO DATA
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
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h }}>
      <g transform={`translate(${margin.left},${margin.top})`}>
        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={0} y1={g.y} x2={chartW} y2={g.y} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} />
            <text x={-8} y={g.y + 3} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize={8} fontFamily="var(--font-mono)">
              {Math.round(g.val)}
            </text>
          </g>
        ))}

        {sorted.map((d, i) => {
          const x = i * (barW + gap);
          const okH = (d.ok / maxVal) * chartH;
          const errH = (d.error / maxVal) * chartH;
          const skipH = (d.skipped / maxVal) * chartH;
          const tooltip = `${d.date}\nTotal: ${d.total}\nOK: ${d.ok}\nError: ${d.error}\nSkipped: ${d.skipped}`;

          return (
            <g key={d.date}>
              <rect x={x} y={chartH - skipH} width={barW} height={Math.max(0, skipH)} fill="rgba(245,158,11,0.7)" rx={1}>
                <title>{tooltip}</title>
              </rect>
              <rect x={x} y={chartH - skipH - errH} width={barW} height={Math.max(0, errH)} fill="rgba(239,68,68,0.7)" rx={1}>
                <title>{tooltip}</title>
              </rect>
              <rect x={x} y={chartH - skipH - errH - okH} width={barW} height={Math.max(0, okH)} fill="rgba(34,197,94,0.7)" rx={1}>
                <title>{tooltip}</title>
              </rect>
              <text x={x + barW / 2} y={chartH + 16} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize={8} fontFamily="var(--font-mono)">
                {d.date.slice(5)}
              </text>
            </g>
          );
        })}
      </g>

      <g transform={`translate(${margin.left}, ${h - 6})`}>
        <rect x={0} y={-6} width={8} height={8} fill="rgba(34,197,94,0.7)" rx={1} />
        <text x={12} y={1} fill="rgba(255,255,255,0.4)" fontSize={8} fontFamily="var(--font-mono)">OK</text>
        <rect x={40} y={-6} width={8} height={8} fill="rgba(239,68,68,0.7)" rx={1} />
        <text x={52} y={1} fill="rgba(255,255,255,0.4)" fontSize={8} fontFamily="var(--font-mono)">Error</text>
        <rect x={90} y={-6} width={8} height={8} fill="rgba(245,158,11,0.7)" rx={1} />
        <text x={102} y={1} fill="rgba(255,255,255,0.4)" fontSize={8} fontFamily="var(--font-mono)">Skipped</text>
      </g>
    </svg>
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
  return "—";
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
