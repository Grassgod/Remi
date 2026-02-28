import { useEffect } from "react";
import { useLocation } from "wouter";
import { Layout } from "../components/Layout";
import { ArcCard } from "../components/ArcCard";
import { HudPanel } from "../components/HudPanel";
import { IconActivity, IconAuth, IconMemory, IconScheduler } from "../components/icons";
import { useAppStore } from "../stores/app";
import { useMemoryStore } from "../stores/memory";

export function Dashboard() {
  const { status, tokens, fetchStatus, fetchTokens, fetchSessions } = useAppStore();
  const { entities, dailyDates, dailyContent, fetchEntities, fetchDailyDates, fetchDaily } = useMemoryStore();
  const [, setLocation] = useLocation();

  useEffect(() => {
    fetchStatus();
    fetchTokens();
    fetchSessions();
    fetchEntities();
    fetchDailyDates();
  }, []);

  // Load today's daily when dates are available
  useEffect(() => {
    if (dailyDates.length > 0) {
      fetchDaily(dailyDates[0].date); // most recent date first
    }
  }, [dailyDates]);

  // Parse daily content into feed items
  const feedItems = parseDailyFeed(dailyContent);

  const nextExpiry = status?.tokens.nextExpiry ?? "—";

  return (
    <Layout title="Dashboard" subtitle="SYSTEM OVERVIEW">
      {/* Status Cards */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 12, marginBottom: 20,
      }} className="status-grid">
        <ArcCard
          label="Daemon Status"
          value={status?.daemon.alive ? "ONLINE" : "OFFLINE"}
          sub={status?.daemon.pid ? `PID ${status.daemon.pid}` : "NOT RUNNING"}
          color={status?.daemon.alive ? "cyan" : "red"}
          delay={0}
        />
        <ArcCard
          label="Active Sessions"
          value={String(status?.sessions.total ?? 0)}
          sub={`${status?.sessions.main ?? 0} MAIN · ${status?.sessions.threads ?? 0} THREADS`}
          color="cyan"
          delay={0.06}
        />
        <ArcCard
          label="Auth Tokens"
          value={`${status?.tokens.valid ?? 0}/${status?.tokens.total ?? 0}`}
          sub={`NEXT EXPIRY ${nextExpiry}`}
          color={status?.tokens.valid === status?.tokens.total ? "green" : "amber"}
          delay={0.12}
        />
        <ArcCard
          label="Memory Entities"
          value={String(status?.memory.entities ?? 0)}
          sub={entityTypeSummary(entities)}
          color="cyan"
          delay={0.18}
        />
      </div>

      {/* Panels */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1.2fr 0.8fr",
        gap: 14,
      }} className="panels-grid">
        {/* Activity Feed */}
        <HudPanel
          title="Activity Stream"
          icon={<IconActivity />}
          action={{ label: "View All", onClick: () => setLocation("/memory/daily") }}
          delay={0.24}
        >
          <div className="feed-scan">
            {feedItems.length === 0 ? (
              <div style={{
                padding: "20px 16px", textAlign: "center",
                fontFamily: "var(--font-mono)", fontSize: 10,
                color: "var(--text-dim)",
              }}>NO ACTIVITY DATA</div>
            ) : (
              feedItems.map((item, i) => (
                <div key={i} style={{
                  display: "flex", padding: "9px 16px", gap: 12,
                  alignItems: "baseline", transition: "background 0.15s",
                  borderLeft: "2px solid transparent",
                }} onMouseEnter={e => {
                  e.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.03)";
                  e.currentTarget.style.borderLeftColor = "rgba(var(--glow-primary-rgb), 0.2)";
                }} onMouseLeave={e => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.borderLeftColor = "transparent";
                }}>
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 10,
                    color: "var(--text-dim)", minWidth: 36, flexShrink: 0,
                  }}>{item.time}</span>
                  <span className="desktop-only" style={{
                    fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 1,
                    textTransform: "uppercase", padding: "2px 6px", borderRadius: 2,
                    border: "1px solid rgba(var(--glow-primary-rgb), 0.2)",
                    color: "var(--glow-accent)", flexShrink: 0, display: "inline-block",
                  }}>{item.tag}</span>
                  <span style={{
                    fontFamily: "var(--font-body)", fontSize: 12.5, fontWeight: 400,
                    color: "var(--text-primary)", flex: 1, minWidth: 0,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>{item.msg}</span>
                </div>
              ))
            )}
          </div>
        </HudPanel>

        {/* Right Column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Tokens */}
          <HudPanel
            title="Auth Tokens"
            icon={<IconAuth />}
            action={{ label: "Refresh", onClick: fetchTokens }}
            delay={0.3}
          >
            {tokens.length === 0 ? (
              <div style={{
                padding: "16px", textAlign: "center",
                fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)",
              }}>NO TOKENS</div>
            ) : (
              tokens.map((t, i) => (
                <div key={i} style={{
                  display: "grid", gridTemplateColumns: "1fr auto auto",
                  alignItems: "center", padding: "10px 16px", gap: 10,
                  transition: "background 0.15s",
                }} onMouseEnter={e => {
                  e.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.03)";
                }} onMouseLeave={e => {
                  e.currentTarget.style.background = "transparent";
                }}>
                  <div>
                    <div style={{
                      fontFamily: "var(--font-body)", fontSize: 12, fontWeight: 600,
                      color: "var(--text-bright)", letterSpacing: 0.5,
                    }}>{t.service}</div>
                    <div style={{
                      fontFamily: "var(--font-mono)", fontSize: 9,
                      color: "var(--text-dim)", letterSpacing: 0.5,
                    }}>{t.type}</div>
                  </div>
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 10, textAlign: "right",
                    color: t.valid ? "var(--glow-green)" : "var(--glow-red)",
                    textShadow: t.valid ? "0 0 6px rgba(var(--glow-green-rgb), 0.3)" : "none",
                  }}>{t.expiresIn}</span>
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 1,
                    textTransform: "uppercase", padding: "2px 8px", borderRadius: 2,
                    border: `1px solid ${t.valid ? "rgba(var(--glow-green-rgb), 0.3)" : "rgba(var(--glow-red-rgb), 0.3)"}`,
                    color: t.valid ? "var(--glow-green)" : "var(--glow-red)",
                    background: t.valid ? "rgba(var(--glow-green-rgb), 0.06)" : "rgba(var(--glow-red-rgb), 0.06)",
                  }}>{t.valid ? "VALID" : "EXPIRED"}</span>
                </div>
              ))
            )}
          </HudPanel>

          {/* Entities */}
          <HudPanel
            title="Memory Entities"
            icon={<IconMemory />}
            action={{ label: "Manage", onClick: () => setLocation("/memory") }}
            delay={0.36}
          >
            {entities.length === 0 ? (
              <div style={{
                padding: "16px", textAlign: "center",
                fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)",
              }}>NO ENTITIES</div>
            ) : (
              entities.map((e, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", padding: "8px 16px",
                  gap: 10, cursor: "pointer", transition: "background 0.15s",
                }} onClick={() => setLocation(`/memory/entity/${e.type}/${encodeURIComponent(e.name)}`)}
                onMouseEnter={ev => {
                  ev.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.03)";
                }} onMouseLeave={ev => {
                  ev.currentTarget.style.background = "transparent";
                }}>
                  <span className={`entity-badge-${e.type}`} style={{
                    fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 0.8,
                    textTransform: "uppercase", padding: "2px 7px", borderRadius: 2,
                    minWidth: 56, textAlign: "center", flexShrink: 0,
                  }}>{e.type}</span>
                  <span style={{
                    fontFamily: "var(--font-body)", fontSize: 13, fontWeight: 500,
                    color: "var(--text-bright)", flex: 1, letterSpacing: 0.3,
                  }}>{e.name}</span>
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-dim)",
                  }}>{e.updatedAt ? e.updatedAt.slice(5, 10) : ""}</span>
                </div>
              ))
            )}
          </HudPanel>

          {/* Scheduler */}
          <HudPanel title="Scheduler" icon={<IconScheduler />} delay={0.42}>
            {[
              { name: "Heartbeat", freq: "5m", color: "var(--glow-green)" },
              { name: "Compaction", freq: "03:00", color: "var(--glow-primary)" },
              { name: "Cleanup", freq: "post", color: "var(--glow-amber)" },
            ].map((job, i) => (
              <div key={i} style={{
                display: "grid", gridTemplateColumns: "1fr auto",
                alignItems: "center", padding: "9px 16px", gap: 8,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
                    background: job.color,
                    boxShadow: `0 0 6px ${job.color}80`,
                  }} />
                  <span style={{
                    fontFamily: "var(--font-body)", fontSize: 12.5, fontWeight: 500,
                    color: "var(--text-bright)", letterSpacing: 0.3,
                  }}>{job.name}</span>
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 9,
                    color: "var(--text-dim)", marginLeft: 4,
                  }}>{job.freq}</span>
                </div>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-muted)",
                }}>—</span>
              </div>
            ))}
          </HudPanel>
        </div>
      </div>

      {/* Responsive style override */}
      <style>{`
        @media (max-width: 768px) {
          .status-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .panels-grid { grid-template-columns: 1fr !important; }
          .main-content { padding: 14px !important; padding-bottom: calc(var(--bottom-nav-height) + var(--safe-bottom) + 14px) !important; }
        }
        @media (max-width: 360px) {
          .status-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </Layout>
  );
}

// Helpers
function parseDailyFeed(content: string): { time: string; tag: string; msg: string }[] {
  if (!content) return [];
  const items: { time: string; tag: string; msg: string }[] = [];
  for (const line of content.split("\n")) {
    // Format: - [HH:MM] [connector] sender: message
    const m = line.match(/^- \[(\d{2}:\d{2})\]\s*\[(\w+)\]\s*(.+)/);
    if (m) {
      items.push({ time: m[1], tag: m[2], msg: m[3] });
    }
  }
  return items.slice(0, 12);
}

function entityTypeSummary(entities: { type: string }[]): string {
  const types = [...new Set(entities.map(e => e.type.toUpperCase()))];
  return types.length > 0 ? types.join(" · ") : "NO ENTITIES";
}
