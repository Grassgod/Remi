import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { ArcCard } from "../components/ArcCard";
import { HudPanel } from "../components/HudPanel";
import { SvgBarChart } from "../components/SvgBarChart";
import { SvgDonut } from "../components/SvgDonut";
import { IconAnalytics } from "../components/icons";
import { useAnalyticsStore } from "../stores/analytics";
import type { DailySummary } from "../api/types";

const MODEL_COLORS = [
  "rgba(6,182,212,0.8)",     // cyan
  "rgba(34,197,94,0.8)",     // green
  "rgba(168,85,247,0.8)",    // purple
  "rgba(245,158,11,0.8)",    // amber
  "rgba(239,68,68,0.8)",     // red
  "rgba(59,130,246,0.8)",    // blue
];

export function Analytics() {
  const { summary, recentMetrics, loading, fetchSummary, fetchRecent } = useAnalyticsStore();

  useEffect(() => {
    fetchSummary();
    fetchRecent(50);
  }, []);

  const today = summary?.today;
  const week = summary?.week;
  const dailyHistory = summary?.dailyHistory ?? [];

  // Compute values for cards
  const todayTokens = (today?.totalIn ?? 0) + (today?.totalOut ?? 0);
  const todayCacheRead = today?.totalCacheRead ?? 0;
  const todayTotalIn = today?.totalIn ?? 0;
  const cacheHitRate = todayTotalIn > 0 ? ((todayCacheRead / (todayTotalIn + todayCacheRead)) * 100) : 0;
  const todayRequests = today?.requestCount ?? 0;
  const todayCost = today?.totalCost ?? 0;

  // Last 14 days for bar chart
  const last14 = dailyHistory
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-14);

  // Model distribution from week summary
  const modelSegments = Object.entries(week?.models ?? {}).map(([name, data], i) => ({
    label: shortenModel(name),
    value: data.in + data.out,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
  }));

  // Cache analysis from week
  const weekCacheRead = week?.totalCacheRead ?? 0;
  const weekCacheCreate = week?.totalCacheCreate ?? 0;
  const weekIn = week?.totalIn ?? 0;
  const weekOut = week?.totalOut ?? 0;
  const cacheSegments = [
    { label: "Input", value: weekIn, color: "rgba(6,182,212,0.7)" },
    { label: "Output", value: weekOut, color: "rgba(34,197,94,0.7)" },
    { label: "Cache Read", value: weekCacheRead, color: "rgba(59,130,246,0.7)" },
    { label: "Cache Create", value: weekCacheCreate, color: "rgba(245,158,11,0.7)" },
  ];

  const usageQuotas = summary?.usage ?? [];

  return (
    <Layout title="Analytics" subtitle="TOKEN USAGE">
      {/* Status Cards */}
      <div className="a-status-grid" style={{ display: "grid", gap: 12, marginBottom: 16 }}>
        <ArcCard
          label="Today Tokens"
          value={formatNum(todayTokens)}
          sub={`IN ${formatNum(today?.totalIn ?? 0)} · OUT ${formatNum(today?.totalOut ?? 0)}`}
          color="cyan"
          delay={0}
        />
        <ArcCard
          label="Cache Hit Rate"
          value={`${cacheHitRate.toFixed(1)}%`}
          sub={`CACHE READ ${formatNum(todayCacheRead)}`}
          color={cacheHitRate > 50 ? "green" : "amber"}
          delay={0.06}
        />
        <ArcCard
          label="Requests"
          value={String(todayRequests)}
          sub={`7D TOTAL: ${week?.requestCount ?? 0}`}
          color="cyan"
          delay={0.12}
        />
        <ArcCard
          label="Est. Cost"
          value={todayCost > 0 ? `$${todayCost.toFixed(2)}` : "—"}
          sub={`7D: $${(week?.totalCost ?? 0).toFixed(2)}`}
          color={todayCost > 5 ? "amber" : "green"}
          delay={0.18}
        />
      </div>

      {/* Subscription Usage + Donut Charts — side by side */}
      {usageQuotas.length > 0 && (
        <div className="a-usage-row" style={{ display: "grid", gap: 14, marginBottom: 14 }}>
          {/* Usage Quotas */}
          <HudPanel title="Subscription Usage" icon={<IconAnalytics />} delay={0.2} maxHeight={260}>
            <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
              {usageQuotas.map((q, i) => {
                const label = QUOTA_LABELS[q.rateLimitType] ?? q.rateLimitType;
                const util = q.utilization ?? 0;
                const isLimited = q.status === "rate_limited";
                const barColor = isLimited ? "var(--glow-red)" : util > 80 ? "var(--glow-amber)" : util > 50 ? "var(--glow-primary)" : "var(--glow-green)";
                return (
                  <div key={i}>
                    <div style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      marginBottom: 6,
                    }}>
                      <span style={{
                        fontFamily: "var(--font-body)", fontSize: 12, fontWeight: 500,
                        color: "var(--text-bright)",
                      }}>{label}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {q.resetsAt && (
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-dim)", letterSpacing: 0.5 }}>
                            resets {formatResetTime(q.resetsAt)}
                          </span>
                        )}
                        <span style={{
                          fontFamily: "var(--font-display)", fontSize: 13, fontWeight: 700,
                          color: barColor,
                          textShadow: `0 0 8px ${barColor}40`,
                          minWidth: 38, textAlign: "right",
                        }}>
                          {util > 0 ? `${util.toFixed(0)}%` : isLimited ? "LIM" : "OK"}
                        </span>
                      </div>
                    </div>
                    <div style={{
                      height: 5, borderRadius: 3,
                      background: "rgba(255,255,255,0.04)",
                      overflow: "hidden",
                    }}>
                      <div style={{
                        height: "100%", borderRadius: 3,
                        width: `${Math.min(util, 100)}%`,
                        background: `linear-gradient(90deg, ${barColor}cc, ${barColor})`,
                        boxShadow: `0 0 6px ${barColor}40`,
                        transition: "width 0.6s cubic-bezier(0.4,0,0.2,1)",
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </HudPanel>

          {/* Model Distribution Donut */}
          <HudPanel title="Model Distribution" icon={<IconAnalytics />} delay={0.26} maxHeight={260}>
            <div style={{ padding: "8px 12px", display: "flex", justifyContent: "center" }}>
              <SvgDonut
                segments={modelSegments}
                centerLabel="MODELS"
                centerValue={String(Object.keys(week?.models ?? {}).length)}
                size={140}
              />
            </div>
          </HudPanel>

          {/* Token Breakdown Donut */}
          <HudPanel title="Token Breakdown" icon={<IconAnalytics />} delay={0.32} maxHeight={260}>
            <div style={{ padding: "8px 12px", display: "flex", justifyContent: "center" }}>
              <SvgDonut
                segments={cacheSegments}
                centerLabel="7D TOTAL"
                centerValue={formatNum(weekIn + weekOut + weekCacheRead + weekCacheCreate)}
                size={140}
              />
            </div>
          </HudPanel>
        </div>
      )}

      {/* If no usage quotas, show donuts in their own row */}
      {usageQuotas.length === 0 && (
        <div className="a-donut-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <HudPanel title="Model Distribution" icon={<IconAnalytics />} delay={0.26} maxHeight={260}>
            <div style={{ padding: "8px 12px", display: "flex", justifyContent: "center" }}>
              <SvgDonut segments={modelSegments} centerLabel="MODELS" centerValue={String(Object.keys(week?.models ?? {}).length)} size={140} />
            </div>
          </HudPanel>
          <HudPanel title="Token Breakdown" icon={<IconAnalytics />} delay={0.32} maxHeight={260}>
            <div style={{ padding: "8px 12px", display: "flex", justifyContent: "center" }}>
              <SvgDonut segments={cacheSegments} centerLabel="7D TOTAL" centerValue={formatNum(weekIn + weekOut + weekCacheRead + weekCacheCreate)} size={140} />
            </div>
          </HudPanel>
        </div>
      )}

      {/* Bar Chart — Full width */}
      <HudPanel
        title="14-Day Usage Trend"
        icon={<IconAnalytics />}
        delay={0.36}
        maxHeight={300}
      >
        <div style={{ padding: "12px 16px" }}>
          <SvgBarChart data={last14} height={220} />
        </div>
      </HudPanel>

      {/* Spacer */}
      <div style={{ height: 14 }} />

      {/* Recent Requests Table */}
      <HudPanel
        title="Recent Requests"
        icon={<IconAnalytics />}
        action={{ label: "Refresh", onClick: () => { fetchSummary(); fetchRecent(50); } }}
        delay={0.42}
        maxHeight={420}
      >
        {recentMetrics.length === 0 ? (
          <div style={{
            padding: "32px 16px", textAlign: "center",
            fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)",
          }}>
            {loading ? "LOADING..." : "NO METRICS DATA"}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            {/* Table header */}
            <div className="a-table-row" style={{
              display: "grid",
              padding: "8px 16px", gap: 6,
              borderBottom: "1px solid var(--border-glow)",
              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1,
              textTransform: "uppercase", color: "var(--text-dim)",
            }}>
              <span>Time</span>
              <span>Model</span>
              <span style={{ textAlign: "right" }}>In</span>
              <span style={{ textAlign: "right" }}>Out</span>
              <span style={{ textAlign: "right" }}>Cache</span>
              <span style={{ textAlign: "right" }}>Duration</span>
              <span style={{ textAlign: "center" }}>Src</span>
            </div>

            {/* Table rows */}
            {recentMetrics.map((m, i) => (
              <div
                key={i}
                className="a-table-row"
                style={{
                  display: "grid",
                  padding: "6px 16px", gap: 6,
                  transition: "background 0.15s",
                  borderLeft: "2px solid transparent",
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.04)";
                  e.currentTarget.style.borderLeftColor = "rgba(var(--glow-primary-rgb), 0.3)";
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.borderLeftColor = "transparent";
                }}
              >
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
                  {formatTime(m.ts)}
                </span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-primary)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }} title={m.model ?? ""}>
                  {shortenModel(m.model ?? "—")}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--glow-primary)", textAlign: "right" }}>
                  {m.in.toLocaleString()}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--glow-green)", textAlign: "right" }}>
                  {m.out.toLocaleString()}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--glow-amber)", textAlign: "right" }}>
                  {(m.cacheRead + m.cacheCreate) > 0 ? (m.cacheRead + m.cacheCreate).toLocaleString() : "—"}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", textAlign: "right" }}>
                  {m.dur ? `${(m.dur / 1000).toFixed(1)}s` : "—"}
                </span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 1,
                  textTransform: "uppercase", textAlign: "center",
                  padding: "1px 4px", borderRadius: 2,
                  border: `1px solid ${m.src === "remi" ? "rgba(var(--glow-primary-rgb), 0.25)" : "rgba(var(--glow-amber-rgb), 0.25)"}`,
                  color: m.src === "remi" ? "var(--glow-primary)" : "var(--glow-amber)",
                }}>
                  {m.src}
                </span>
              </div>
            ))}
          </div>
        )}
      </HudPanel>

      {/* Responsive Styles */}
      <style>{`
        .a-status-grid {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }
        .a-usage-row {
          grid-template-columns: 1.2fr 0.9fr 0.9fr;
        }
        .a-table-row {
          grid-template-columns: 90px 1fr 70px 70px 80px 65px 45px;
        }
        @media (max-width: 900px) {
          .a-usage-row { grid-template-columns: 1fr 1fr !important; }
          .a-usage-row > :first-child { grid-column: 1 / -1; }
        }
        @media (max-width: 768px) {
          .a-status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .a-usage-row { grid-template-columns: 1fr !important; }
          .a-donut-row { grid-template-columns: 1fr !important; }
          .a-table-row { grid-template-columns: 80px 1fr 60px 60px 70px 55px 40px !important; }
        }
        @media (max-width: 480px) {
          .a-status-grid { grid-template-columns: 1fr !important; }
          .a-table-row { grid-template-columns: 70px 1fr 55px 55px 65px !important; }
          .a-table-row > :nth-child(6),
          .a-table-row > :nth-child(7) { display: none; }
        }
      `}</style>
    </Layout>
  );
}

// ── Helpers ──────────────────────────────────────

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return ts.slice(0, 16);
  }
}

function shortenModel(model: string): string {
  return model
    .replace("claude-", "")
    .replace("-20250", "")
    .replace("-latest", "");
}

const QUOTA_LABELS: Record<string, string> = {
  five_hour: "Current Session",
  seven_day: "Weekly (All Models)",
  seven_day_sonnet: "Weekly (Sonnet)",
  seven_day_opus: "Weekly (Opus)",
  overage: "Extra Usage",
};

function formatResetTime(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    if (diffMs <= 0) return "now";
    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.floor((diffMs % 3600000) / 60000);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h`;
    }
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  } catch {
    return iso.slice(0, 16);
  }
}
