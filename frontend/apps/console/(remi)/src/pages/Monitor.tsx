import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { ArcCard } from "../components/ArcCard";
import { HudPanel } from "../components/HudPanel";
import * as api from "../api/client";
import type { MonitorStats } from "../api/types";

export function Monitor() {
  const [stats, setStats] = useState<MonitorStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = async () => {
    try {
      const data = await api.getMonitorStats();
      setStats(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 10_000);
    return () => clearInterval(interval);
  }, []);

  const upHours = stats ? Math.floor(stats.uptime / 3600) : 0;
  const upMins = stats ? Math.floor((stats.uptime % 3600) / 60) : 0;

  return (
    <Layout title="Monitor" subtitle="SYSTEM HEALTH">
      {/* Status Cards */}
      <div className="m-status-grid" style={{ display: "grid", gap: 12, marginBottom: 16 }}>
        <ArcCard
          label="Uptime"
          value={stats ? `${upHours}h ${upMins}m` : "—"}
          sub={stats ? `PID active` : "Loading..."}
          color="success"
        />
        <ArcCard
          label="Active Sessions"
          value={String(stats?.activeSessions ?? 0)}
          sub="CLI processes"
          color="default"
        />
        <ArcCard
          label="Requests Today"
          value={String(stats?.requestsToday ?? 0)}
          sub={`Last hour: ${stats?.requestsLastHour ?? 0}`}
          color="default"
        />
        <ArcCard
          label="Error Rate"
          value={stats ? `${stats.errorRate.toFixed(1)}%` : "—"}
          sub={`Errors today: ${stats?.errorsToday ?? 0}`}
          color={stats && stats.errorRate > 10 ? "destructive" : stats && stats.errorRate > 5 ? "warning" : "success"}
        />
      </div>

      {/* Latency + Resources */}
      <div className="m-panel-row" style={{ display: "grid", gap: 14, marginBottom: 14 }}>
        <HudPanel title="Latency" icon={<IconMonitorSvg />} maxHeight={220}>
          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <LatencyBar label="P50" value={stats?.latencyP50} />
            <LatencyBar label="P95" value={stats?.latencyP95} />
            <LatencyBar label="Avg" value={stats?.latencyAvg} />
          </div>
        </HudPanel>

        <HudPanel title="Data Volume" icon={<IconMonitorSvg />} maxHeight={220}>
          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
            <DataRow label="Traces (today)" value={stats?.tracesCount ?? 0} />
            <DataRow label="Log entries (today)" value={stats?.logsCount ?? 0} />
          </div>
        </HudPanel>
      </div>

      {/* Top Operations */}
      <HudPanel
        title="Top Operations"
        icon={<IconMonitorSvg />}
        action={{ label: loading ? "..." : "Refresh", onClick: fetchStats }}
        maxHeight={400}
      >
        {error && (
          <div style={{ padding: "8px 16px", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--glow-red, #ef4444)" }}>
            {error}
          </div>
        )}
        {!stats || stats.topOperations.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
            {loading ? "LOADING..." : "NO OPERATIONS DATA"}
          </div>
        ) : (
          <div>
            {/* Header */}
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 80px 100px", padding: "8px 16px", gap: 6,
              borderBottom: "1px solid var(--border-glow)",
              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1,
              textTransform: "uppercase", color: "var(--text-dim)",
            }}>
              <span>Operation</span>
              <span style={{ textAlign: "right" }}>Count</span>
              <span style={{ textAlign: "right" }}>Avg Latency</span>
            </div>

            {stats.topOperations.map((op, i) => (
              <div key={i} style={{
                display: "grid", gridTemplateColumns: "1fr 80px 100px", padding: "6px 16px", gap: 6,
                transition: "background 0.15s",
              }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {op.name}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--glow-primary, #06b6d4)", textAlign: "right" }}>
                  {op.count}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", textAlign: "right" }}>
                  {op.avgMs >= 1000 ? `${(op.avgMs / 1000).toFixed(1)}s` : `${op.avgMs.toFixed(0)}ms`}
                </span>
              </div>
            ))}
          </div>
        )}
      </HudPanel>

      <style>{`
        .m-status-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .m-panel-row { grid-template-columns: 1fr 1fr; }
        @media (max-width: 768px) {
          .m-status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .m-panel-row { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 480px) {
          .m-status-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </Layout>
  );
}

// ── Sub-components ──

function LatencyBar({ label, value }: { label: string; value: number | null | undefined }) {
  const ms = value ?? 0;
  const maxMs = 60_000; // 60s max display
  const pct = Math.min((ms / maxMs) * 100, 100);
  const color = ms > 30000 ? "var(--glow-red, #ef4444)" : ms > 10000 ? "var(--glow-amber, #f59e0b)" : "var(--glow-primary, #06b6d4)";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>{label}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600, color }}>
          {value != null ? (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`) : "—"}
        </span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: "rgba(255,255,255,0.04)", overflow: "hidden" }}>
        <div style={{
          height: "100%", borderRadius: 3, width: `${pct}%`,
          background: `linear-gradient(90deg, ${color}cc, ${color})`,
          transition: "width 0.6s cubic-bezier(0.4,0,0.2,1)",
        }} />
      </div>
    </div>
  );
}

function DataRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--text-bright)" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 700, color: "var(--glow-primary, #06b6d4)" }}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function IconMonitorSvg() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}
