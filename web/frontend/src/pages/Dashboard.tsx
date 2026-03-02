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

  useEffect(() => {
    if (dailyDates.length > 0) {
      fetchDaily(dailyDates[0].date);
    }
  }, [dailyDates]);

  const feedItems = parseDailyFeed(dailyContent);
  const nextExpiry = status?.tokens.nextExpiry ?? "—";

  return (
    <Layout title="Dashboard" subtitle="SYSTEM OVERVIEW">
      {/* Status Cards */}
      <div className="status-grid mb-3 grid grid-cols-2 gap-2 sm:mb-5 sm:grid-cols-4 sm:gap-3">
        <ArcCard
          label="Daemon Status"
          value={status?.daemon.alive ? "ONLINE" : "OFFLINE"}
          sub={status?.daemon.pid ? `PID ${status.daemon.pid}` : "NOT RUNNING"}
          color={status?.daemon.alive ? "default" : "destructive"}
        />
        <ArcCard
          label="Active Sessions"
          value={String(status?.sessions.total ?? 0)}
          sub={`${status?.sessions.main ?? 0} MAIN · ${status?.sessions.threads ?? 0} THREADS`}
          color="default"
        />
        <ArcCard
          label="Auth Tokens"
          value={`${status?.tokens.valid ?? 0}/${status?.tokens.total ?? 0}`}
          sub={`NEXT EXPIRY ${nextExpiry}`}
          color={status?.tokens.valid === status?.tokens.total ? "success" : "warning"}
        />
        <ArcCard
          label="Memory Entities"
          value={String(status?.memory.entities ?? 0)}
          sub={entityTypeSummary(entities)}
          color="default"
        />
      </div>

      {/* Panels */}
      <div className="panels-grid grid grid-cols-1 gap-2.5 sm:grid-cols-[1.2fr_0.8fr] sm:gap-3.5">
        {/* Activity Feed */}
        <HudPanel
          title="Activity Stream"
          icon={<IconActivity />}
          action={{ label: "View All", onClick: () => setLocation("/memory/daily") }}
        >
          <div>
            {feedItems.length === 0 ? (
              <div className="p-5 text-center font-mono text-[10px] text-muted-foreground">
                NO ACTIVITY DATA
              </div>
            ) : (
              feedItems.map((item, i) => (
                <div
                  key={i}
                  className="flex items-baseline gap-2 border-l-2 border-transparent px-3 py-1.5 transition-colors hover:border-l-border hover:bg-accent/30 sm:gap-3 sm:px-4 sm:py-2"
                >
                  <span className="min-w-[32px] shrink-0 font-mono text-[10px] text-muted-foreground sm:min-w-[36px]">
                    {item.time}
                  </span>
                  <span className="desktop-only inline-block shrink-0 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide text-muted-foreground">
                    {item.tag}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {item.msg}
                  </span>
                </div>
              ))
            )}
          </div>
        </HudPanel>

        {/* Right Column */}
        <div className="flex flex-col gap-2.5 sm:gap-3.5">
          {/* Tokens */}
          <HudPanel
            title="Auth Tokens"
            icon={<IconAuth />}
            action={{ label: "Refresh", onClick: fetchTokens }}
          >
            {tokens.length === 0 ? (
              <div className="p-4 text-center font-mono text-[10px] text-muted-foreground">
                NO TOKENS
              </div>
            ) : (
              tokens.map((t, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-1.5 px-3 py-2 transition-colors hover:bg-accent/30 sm:gap-2.5 sm:px-4 sm:py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-foreground">{t.service}</div>
                    <div className="truncate font-mono text-[9px] text-muted-foreground">{t.type}</div>
                  </div>
                  <span className={`hidden font-mono text-[10px] sm:inline ${t.valid ? "text-success" : "text-destructive"}`}>
                    {t.expiresIn}
                  </span>
                  <span className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide sm:px-2
                    ${t.valid
                      ? "border-success/30 bg-success/[0.06] text-success"
                      : "border-destructive/30 bg-destructive/[0.06] text-destructive"
                    }`}>
                    {t.valid ? "VALID" : "EXPIRED"}
                  </span>
                </div>
              ))
            )}
          </HudPanel>

          {/* Entities */}
          <HudPanel
            title="Memory Entities"
            icon={<IconMemory />}
            action={{ label: "Manage", onClick: () => setLocation("/memory") }}
          >
            {entities.length === 0 ? (
              <div className="p-4 text-center font-mono text-[10px] text-muted-foreground">
                NO ENTITIES
              </div>
            ) : (
              entities.map((e, i) => (
                <div
                  key={i}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors hover:bg-accent/30 sm:gap-2.5 sm:px-4 sm:py-2"
                  onClick={() => setLocation(`/memory/entity/${e.type}/${encodeURIComponent(e.name)}`)}
                >
                  <span className={`entity-badge-${e.type} min-w-[48px] shrink-0 rounded-sm px-1.5 py-0.5 text-center font-mono text-[8px] uppercase tracking-wide sm:min-w-[56px]`}>
                    {e.type}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {e.name}
                  </span>
                  <span className="hidden font-mono text-[9px] text-muted-foreground sm:inline">
                    {e.updatedAt ? e.updatedAt.slice(5, 10) : ""}
                  </span>
                </div>
              ))
            )}
          </HudPanel>

          {/* Scheduler */}
          <HudPanel title="Scheduler" icon={<IconScheduler />}>
            {[
              { name: "Heartbeat", freq: "5m", cls: "bg-success" },
              { name: "Compaction", freq: "03:00", cls: "bg-foreground" },
              { name: "Cleanup", freq: "post", cls: "bg-warning" },
            ].map((job, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto] items-center px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${job.cls}`} />
                  <span className="text-xs font-medium text-foreground">{job.name}</span>
                  <span className="ml-1 font-mono text-[9px] text-muted-foreground">{job.freq}</span>
                </div>
                <span className="font-mono text-[9px] text-muted-foreground">—</span>
              </div>
            ))}
          </HudPanel>
        </div>
      </div>

      <style>{`
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
