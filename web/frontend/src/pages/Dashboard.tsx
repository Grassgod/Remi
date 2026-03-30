import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "../components/ui/collapsible";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  MessageSquare, Coins, KanbanSquare, Shield, ChevronRight,
  ChevronDown, ChevronUp, Brain, Clock, Activity, Database,
  Link2, Settings, AlertTriangle, Check, RefreshCw, MemoryStick,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "../stores/app";
import { useMemoryStore } from "../stores/memory";
import { useSchedulerStore } from "../stores/scheduler";
import * as api from "../api/client";
import type { MonitorStats, DbStats, SymlinksStatus, AnalyticsSummary } from "../api/types";

export function Dashboard() {
  const { status, tokens, fetchStatus, fetchTokens } = useAppStore();
  const { entities, fetchEntities } = useMemoryStore();
  const { status: schedulerStatus, fetchStatus: fetchSchedulerStatus } = useSchedulerStore();
  const [, setLocation] = useLocation();

  // Additional data for merged panels
  const [monitorStats, setMonitorStats] = useState<MonitorStats | null>(null);
  const [dbStats, setDbStats] = useState<DbStats | null>(null);
  const [symlinksStatus, setSymlinksStatus] = useState<SymlinksStatus | null>(null);
  const [analyticsSummary, setAnalyticsSummary] = useState<AnalyticsSummary | null>(null);
  const [healthOpen, setHealthOpen] = useState(false);

  useEffect(() => {
    fetchStatus();
    fetchTokens();
    fetchEntities();
    fetchSchedulerStatus();
    api.getMonitorStats().then(setMonitorStats).catch(() => {});
    api.getDbStats().then(setDbStats).catch(() => {});
    api.getSymlinksStatus().then(setSymlinksStatus).catch(() => {});
    api.getAnalyticsSummary().then(setAnalyticsSummary).catch(() => {});
  }, []);

  // Auto-refresh system data
  useEffect(() => {
    const interval = setInterval(() => {
      fetchStatus();
      fetchSchedulerStatus();
      api.getMonitorStats().then(setMonitorStats).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const todayTokens = analyticsSummary?.today;
  const hasIssues = !status?.daemon.alive ||
    (status?.tokens.valid ?? 0) < (status?.tokens.total ?? 0) ||
    (symlinksStatus?.stats.broken ?? 0) > 0;

  // Auto-expand health panel if there are issues
  useEffect(() => {
    if (hasIssues) setHealthOpen(true);
  }, [hasIssues]);

  return (
    <Layout title="Dashboard" subtitle="Today">
      {/* ─── Top Stats ─── */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={<MessageSquare className="h-4 w-4" />}
          label="Today Chats"
          value={String(monitorStats?.requestsToday ?? 0)}
          sub={`${monitorStats?.requestsLastHour ?? 0} last hour`}
        />
        <StatCard
          icon={<Coins className="h-4 w-4" />}
          label="Tokens Used"
          value={formatTokens(todayTokens?.totalIn ?? 0, todayTokens?.totalOut ?? 0)}
          sub={todayTokens?.totalCost ? `$${todayTokens.totalCost.toFixed(2)} today` : "no data"}
        />
        <StatCard
          icon={<KanbanSquare className="h-4 w-4" />}
          label="Sessions"
          value={String(status?.sessions.total ?? 0)}
          sub={`${status?.sessions.main ?? 0} main · ${status?.sessions.threads ?? 0} threads`}
        />
        <StatCard
          icon={<Shield className="h-4 w-4" />}
          label="System"
          value={hasIssues ? "Issues" : "Healthy"}
          sub={hasIssues ? `${countIssues(status, symlinksStatus)} issue(s)` : "All systems OK"}
          variant={hasIssues ? "warning" : "success"}
        />
      </div>

      {/* ─── Two Column Layout ─── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* ─── Left Column ─── */}
        <div className="flex flex-col gap-3">
          {/* Token Budget */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Coins className="h-4 w-4 text-muted-foreground" />
                Token Budget
              </CardTitle>
              <Button
                variant="ghost" size="sm"
                onClick={() => setLocation("/analytics")}
                className="h-7 text-xs text-muted-foreground"
              >
                Details <ChevronRight className="h-3 w-3" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {analyticsSummary?.usage && analyticsSummary.usage.length > 0 ? (
                analyticsSummary.usage.map((quota, i) => (
                  <div key={i}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{QUOTA_LABELS[quota.rateLimitType] ?? quota.rateLimitType}</span>
                      <span className={cn("font-medium",
                        quota.utilization > 80 ? "text-destructive" : quota.utilization > 50 ? "text-warning" : "text-success"
                      )}>
                        {quota.utilization.toFixed(0)}%
                      </span>
                    </div>
                    <Progress
                      value={quota.utilization}
                      indicatorClassName={cn(
                        quota.utilization > 80 ? "bg-destructive" : quota.utilization > 50 ? "bg-warning" : "bg-success"
                      )}
                    />
                  </div>
                ))
              ) : (
                <EmptyState text="No quota data" />
              )}
              {todayTokens && (
                <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border pt-2">
                  <MiniStat label="Today Cost" value={`$${todayTokens.totalCost.toFixed(2)}`} />
                  <MiniStat label="Requests" value={String(todayTokens.requestCount)} />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Auth Tokens */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Shield className="h-4 w-4 text-muted-foreground" />
                Auth Tokens
              </CardTitle>
              <Button
                variant="ghost" size="sm"
                onClick={fetchTokens}
                className="h-7 text-xs text-muted-foreground"
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[280px]">
                {tokens.length === 0 ? (
                  <EmptyState text="No tokens" />
                ) : (
                  tokens.map((t, i) => (
                    <div key={i} className="flex items-center gap-2 px-4 py-2.5 transition-colors hover:bg-accent/30">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium">{t.service}</div>
                        <div className="truncate text-[10px] text-muted-foreground">{t.type}</div>
                      </div>
                      <span className="hidden text-[10px] text-muted-foreground sm:inline">{t.expiresIn}</span>
                      <Badge variant={t.valid ? "success" : "destructive"} className="text-[9px]">
                        {t.valid ? "VALID" : "EXPIRED"}
                      </Badge>
                    </div>
                  ))
                )}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Memory Entities */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Brain className="h-4 w-4 text-muted-foreground" />
                Memory Entities
                <Badge variant="secondary" className="ml-1 text-[10px]">{entities.length}</Badge>
              </CardTitle>
              <Button
                variant="ghost" size="sm"
                onClick={() => setLocation("/memory")}
                className="h-7 text-xs text-muted-foreground"
              >
                Manage <ChevronRight className="h-3 w-3" />
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[480px]">
                {entities.length === 0 ? (
                  <EmptyState text="No entities" />
                ) : (
                  entities.slice(0, 20).map((e, i) => (
                    <div
                      key={i}
                      className="flex cursor-pointer items-center gap-2 px-4 py-2 transition-colors hover:bg-accent/30"
                      onClick={() => setLocation(`/memory/entity/${e.type}/${encodeURIComponent(e.name)}`)}
                    >
                      <Badge
                        variant="outline"
                        className={cn("min-w-[52px] justify-center text-[9px] uppercase", entityBadgeClass(e.type))}
                      >
                        {e.type}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{e.name}</span>
                      <span className="hidden text-[10px] text-muted-foreground sm:inline">
                        {e.updatedAt ? e.updatedAt.slice(5, 10) : ""}
                      </span>
                    </div>
                  ))
                )}
              </ScrollArea>
            </CardContent>
          </Card>

        </div>

        {/* ─── Right Column (System) ─── */}
        <div className="flex flex-col gap-3">
          {/* System Health — Collapsible */}
          <Card>
            <Collapsible open={healthOpen} onOpenChange={setHealthOpen}>
              <CardHeader className="space-y-0 pb-2">
                <CollapsibleTrigger className="flex w-full items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                    System Health
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    {hasIssues ? (
                      <Badge variant="warning" className="text-[9px]">
                        <AlertTriangle className="mr-1 h-3 w-3" />
                        {countIssues(status, symlinksStatus)} issue(s)
                      </Badge>
                    ) : (
                      <Badge variant="success" className="text-[9px]">
                        <Check className="mr-1 h-3 w-3" />
                        All healthy
                      </Badge>
                    )}
                    {healthOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </div>
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                <CardContent className="space-y-2 pt-0">
                  <HealthRow
                    icon={<Shield className="h-3.5 w-3.5" />}
                    label="Daemon"
                    value={status?.daemon.alive ? `UP · PID ${status.daemon.pid}` : "OFFLINE"}
                    ok={status?.daemon.alive ?? false}
                  />
                  {monitorStats && (
                    <>
                      <HealthRow
                        icon={<Clock className="h-3.5 w-3.5" />}
                        label="Uptime"
                        value={formatUptime(monitorStats.uptime)}
                        ok
                      />
                      <HealthRow
                        icon={<Activity className="h-3.5 w-3.5" />}
                        label="Latency"
                        value={`P50 ${ms(monitorStats.latencyP50)} · P95 ${ms(monitorStats.latencyP95)}`}
                        ok={(monitorStats.latencyP95 ?? 0) < 10000}
                      />
                      <HealthRow
                        icon={<AlertTriangle className="h-3.5 w-3.5" />}
                        label="Error Rate"
                        value={`${(monitorStats.errorRate * 100).toFixed(1)}% (${monitorStats.errorsToday} today)`}
                        ok={monitorStats.errorRate < 0.05}
                      />
                      {monitorStats.pm2Memory != null && (
                        <HealthRow
                          icon={<MemoryStick className="h-3.5 w-3.5" />}
                          label="Memory"
                          value={`${(monitorStats.pm2Memory / 1024 / 1024).toFixed(0)}MB`}
                          ok={(monitorStats.pm2Memory / 1024 / 1024) < 512}
                        />
                      )}
                      {monitorStats.pm2Restarts != null && monitorStats.pm2Restarts > 0 && (
                        <HealthRow
                          icon={<RefreshCw className="h-3.5 w-3.5" />}
                          label="Restarts"
                          value={`${monitorStats.pm2Restarts} total`}
                          ok={monitorStats.pm2Restarts < 10}
                        />
                      )}
                    </>
                  )}
                  <HealthRow
                    icon={<Shield className="h-3.5 w-3.5" />}
                    label="Auth"
                    value={`${status?.tokens.valid ?? 0}/${status?.tokens.total ?? 0} valid${status?.tokens.nextExpiry ? ` · next ${status.tokens.nextExpiry}` : ""}`}
                    ok={(status?.tokens.valid ?? 0) === (status?.tokens.total ?? 0)}
                  />
                  {schedulerStatus && (
                    <HealthRow
                      icon={<Clock className="h-3.5 w-3.5" />}
                      label="Scheduler"
                      value={`${schedulerStatus.jobs.filter(j => j.enabled).length} jobs · ${schedulerStatus.jobs.filter(j => j.lastRun?.status === "error").length} errors`}
                      ok={schedulerStatus.jobs.filter(j => j.lastRun?.status === "error").length === 0}
                    />
                  )}
                  {dbStats && (
                    <HealthRow
                      icon={<Database className="h-3.5 w-3.5" />}
                      label="Database"
                      value={`${(dbStats.dbSizeBytes / 1024 / 1024).toFixed(1)}MB · ${(Array.isArray(dbStats.tables) ? dbStats.tables.find((t: any) => t.name === "kv")?.rowCount : (dbStats.tables as any)?.kv?.count) ?? 0} KV · ${(Array.isArray(dbStats.tables) ? dbStats.tables.find((t: any) => t.name === "embeddings")?.rowCount : (dbStats.tables as any)?.embeddings?.count) ?? 0} embeds`}
                      ok
                    />
                  )}
                  {symlinksStatus && (
                    <HealthRow
                      icon={<Link2 className="h-3.5 w-3.5" />}
                      label="Symlinks"
                      value={`${symlinksStatus.stats.ok} OK · ${symlinksStatus.stats.broken} broken`}
                      ok={symlinksStatus.stats.broken === 0}
                    />
                  )}
                  <HealthRow
                    icon={<Settings className="h-3.5 w-3.5" />}
                    label="Config"
                    value="remi.toml loaded"
                    ok
                  />

                  {/* Top Operations */}
                  {monitorStats?.topOperations && monitorStats.topOperations.length > 0 && (
                    <div className="mt-3 border-t border-border pt-3">
                      <div className="mb-2 text-[10px] font-medium uppercase text-muted-foreground">Top Operations</div>
                      {monitorStats.topOperations.slice(0, 5).map((op, i) => (
                        <div key={i} className="flex items-center justify-between py-1 text-xs">
                          <span className="truncate text-muted-foreground">{op.name}</span>
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-[10px]">{op.count}x</span>
                            <span className="font-mono text-[10px] text-muted-foreground">{op.avgMs.toFixed(0)}ms</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>

        </div>

        {/* ─── Right Column (Data) ─── */}
        <div className="flex flex-col gap-3">
          {/* Scheduler Quick Status */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Scheduler
              </CardTitle>
              <Button
                variant="ghost" size="sm"
                onClick={() => setLocation("/scheduler")}
                className="h-7 text-xs text-muted-foreground"
              >
                Details <ChevronRight className="h-3 w-3" />
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[200px]">
                {(!schedulerStatus || schedulerStatus.jobs.length === 0) ? (
                  <EmptyState text="No scheduler data" />
                ) : (
                  schedulerStatus.jobs.filter(j => j.enabled).map((job, i) => {
                    const last = job.lastRun;
                    return (
                      <div key={i} className="flex items-center gap-2 px-4 py-2 transition-colors hover:bg-accent/30">
                        <div className={cn("h-2 w-2 shrink-0 rounded-full",
                          !last ? "bg-muted-foreground" : last.status === "ok" ? "bg-success" : "bg-destructive"
                        )} />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{job.jobName}</span>
                        <span className="hidden text-[10px] text-muted-foreground sm:inline">
                          {last ? formatAgo(last.finishedAt) : "—"}
                        </span>
                        <Badge
                          variant={last?.status === "ok" ? "success" : last?.status === "error" ? "destructive" : "outline"}
                          className="text-[9px]"
                        >
                          {!last ? "—" : last.status === "ok" ? "OK" : last.status === "error" ? "FAIL" : "SKIP"}
                        </Badge>
                      </div>
                    );
                  })
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}

// ─── Sub-components ─────────────────────────

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

function HealthRow({ icon, label, value, ok }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/30">
      <span className={ok ? "text-success" : "text-destructive"}>{icon}</span>
      <span className="w-20 shrink-0 font-medium text-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{value}</span>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="p-6 text-center text-xs text-muted-foreground">{text}</div>
  );
}

// ─── Helpers ────────────────────────────────

function formatTokens(input: number, output: number): string {
  const total = input + output;
  if (total > 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total > 1_000) return `${(total / 1_000).toFixed(0)}K`;
  return String(total);
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ms(val: number | null): string {
  if (val === null) return "—";
  return val > 1000 ? `${(val / 1000).toFixed(1)}s` : `${val.toFixed(0)}ms`;
}

function formatAgo(isoStr: string): string {
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 0) return "just now";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function entityBadgeClass(type: string): string {
  const map: Record<string, string> = {
    person: "border-blue-500/30 text-blue-500 bg-blue-500/5",
    project: "border-green-500/30 text-green-500 bg-green-500/5",
    service: "border-purple-500/30 text-purple-500 bg-purple-500/5",
    platform: "border-indigo-500/30 text-indigo-500 bg-indigo-500/5",
    organization: "border-amber-500/30 text-amber-500 bg-amber-500/5",
    decision: "border-red-500/30 text-red-500 bg-red-500/5",
    software: "border-cyan-500/30 text-cyan-500 bg-cyan-500/5",
  };
  return map[type] ?? "";
}

const QUOTA_LABELS: Record<string, string> = {
  five_hour: "Current Session",
  seven_day: "Weekly (All Models)",
  seven_day_sonnet: "Weekly (Sonnet)",
  seven_day_opus: "Weekly (Opus)",
  overage: "Extra Usage",
};

function countIssues(
  status: { daemon: { alive: boolean }; tokens: { valid: number; total: number } } | null,
  symlinks: SymlinksStatus | null
): number {
  let count = 0;
  if (!status?.daemon.alive) count++;
  if ((status?.tokens.valid ?? 0) < (status?.tokens.total ?? 0)) count++;
  if ((symlinks?.stats.broken ?? 0) > 0) count++;
  return count;
}
