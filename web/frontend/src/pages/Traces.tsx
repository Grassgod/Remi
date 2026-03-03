import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { ArcCard } from "../components/ArcCard";
import { HudPanel } from "../components/HudPanel";
import { WaterfallChart } from "../components/WaterfallChart";
import { useTracesStore } from "../stores/traces";
import type { TraceData } from "../api/types";

export function Traces() {
  const { traces, selectedTrace, loading, error, fetchTraces, fetchTrace, clearSelection } = useTracesStore();

  useEffect(() => {
    fetchTraces();
  }, []);

  const totalTraces = traces.length;
  const errorTraces = traces.filter(t => t.status === "ERROR").length;
  const avgDuration = totalTraces > 0 ? traces.reduce((s, t) => s + t.durationMs, 0) / totalTraces : 0;
  const maxDuration = totalTraces > 0 ? Math.max(...traces.map(t => t.durationMs)) : 0;

  return (
    <Layout title="Traces" subtitle="REQUEST TRACING">
      {/* Status Cards */}
      <div className="t-status-grid" style={{ display: "grid", gap: 12, marginBottom: 16 }}>
        <ArcCard label="Total Traces" value={String(totalTraces)} sub="Latest batch" color="default" />
        <ArcCard label="Errors" value={String(errorTraces)} sub={totalTraces > 0 ? `${((errorTraces / totalTraces) * 100).toFixed(1)}% error rate` : "—"} color={errorTraces > 0 ? "destructive" : "success"} />
        <ArcCard label="Avg Duration" value={avgDuration >= 1000 ? `${(avgDuration / 1000).toFixed(1)}s` : `${avgDuration.toFixed(0)}ms`} sub="Mean latency" color="default" />
        <ArcCard label="P95 Duration" value={maxDuration >= 1000 ? `${(maxDuration / 1000).toFixed(1)}s` : `${maxDuration.toFixed(0)}ms`} sub="Slowest" color={maxDuration > 30000 ? "warning" : "default"} />
      </div>

      {/* Waterfall Detail */}
      {selectedTrace && (
        <div style={{ marginBottom: 16 }}>
          <HudPanel
            title={`Trace: ${selectedTrace.traceId.slice(0, 12)}...`}
            icon={<IconTrace />}
            action={{ label: "Close", onClick: clearSelection }}
            maxHeight={600}
          >
            <div style={{ padding: "12px 8px" }}>
              <div style={{ display: "flex", gap: 16, marginBottom: 12, padding: "0 8px", flexWrap: "wrap" }}>
                <MiniStat label="Status" value={selectedTrace.status} color={selectedTrace.status === "ERROR" ? "var(--glow-red, #ef4444)" : "var(--glow-green, #22c55e)"} />
                <MiniStat label="Duration" value={selectedTrace.durationMs >= 1000 ? `${(selectedTrace.durationMs / 1000).toFixed(1)}s` : `${selectedTrace.durationMs}ms`} />
                <MiniStat label="Spans" value={String(selectedTrace.spans.length)} />
                <MiniStat label="Start" value={formatTime(selectedTrace.startTime)} />
                {selectedTrace.source && <MiniStat label="Source" value={selectedTrace.source} />}
              </div>
              <WaterfallChart spans={selectedTrace.spans} totalDurationMs={selectedTrace.durationMs} />
            </div>
          </HudPanel>
        </div>
      )}

      {/* Trace List */}
      <HudPanel
        title="Recent Traces"
        icon={<IconTrace />}
        action={{ label: loading ? "Loading..." : "Refresh", onClick: () => fetchTraces() }}
        maxHeight={500}
      >
        {error && (
          <div style={{ padding: "8px 16px", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--glow-red, #ef4444)" }}>
            {error}
          </div>
        )}
        {traces.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
            {loading ? "LOADING..." : "NO TRACES YET"}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            {/* Header */}
            <div className="t-table-row" style={{
              display: "grid", padding: "8px 16px", gap: 6,
              borderBottom: "1px solid var(--border-glow)",
              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1,
              textTransform: "uppercase", color: "var(--text-dim)",
            }}>
              <span>Time</span>
              <span>Operation</span>
              <span>Status</span>
              <span style={{ textAlign: "right" }}>Duration</span>
              <span style={{ textAlign: "right" }}>Spans</span>
            </div>

            {/* Rows */}
            {traces.map(trace => (
              <TraceRow key={trace.traceId} trace={trace} onClick={() => fetchTrace(trace.traceId)} selected={selectedTrace?.traceId === trace.traceId} />
            ))}
          </div>
        )}
      </HudPanel>

      <style>{`
        .t-status-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .t-table-row { grid-template-columns: 110px 1fr 70px 90px 60px; }
        @media (max-width: 768px) {
          .t-status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .t-table-row { grid-template-columns: 90px 1fr 60px 75px !important; }
          .t-table-row > :nth-child(5) { display: none; }
        }
        @media (max-width: 480px) {
          .t-status-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </Layout>
  );
}

// ── Sub-components ──

function TraceRow({ trace, onClick, selected }: { trace: TraceData; onClick: () => void; selected: boolean }) {
  const isError = trace.status === "ERROR";
  return (
    <div
      className="t-table-row"
      onClick={onClick}
      style={{
        display: "grid", padding: "6px 16px", gap: 6, cursor: "pointer",
        transition: "background 0.15s",
        borderLeft: `2px solid ${selected ? "var(--glow-primary, #06b6d4)" : "transparent"}`,
        background: selected ? "rgba(6,182,212,0.04)" : "transparent",
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
        {formatTime(trace.startTime)}
      </span>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-primary)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }} title={trace.rootSpan?.operationName ?? trace.traceId}>
        {trace.rootSpan?.operationName ?? trace.traceId.slice(0, 16)}
      </span>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 1, textTransform: "uppercase",
        padding: "1px 4px", borderRadius: 2, width: "fit-content",
        border: `1px solid ${isError ? "rgba(239,68,68,0.25)" : "rgba(34,197,94,0.25)"}`,
        color: isError ? "var(--glow-red, #ef4444)" : "var(--glow-green, #22c55e)",
      }}>
        {trace.status}
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", textAlign: "right" }}>
        {trace.durationMs >= 1000 ? `${(trace.durationMs / 1000).toFixed(1)}s` : `${trace.durationMs}ms`}
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", textAlign: "right" }}>
        {trace.spans.length}
      </span>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 1, textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color: color ?? "var(--text-primary)" }}>
        {value}
      </div>
    </div>
  );
}

function IconTrace() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M3 12h4l3-9 4 18 3-9h4" />
    </svg>
  );
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return ts.slice(0, 19);
  }
}
