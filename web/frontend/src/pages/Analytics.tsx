import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  BarChart3, RefreshCw, Coins, Zap, Hash, DatabaseZap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SvgBarChart } from "../components/SvgBarChart";
import { SvgDonut } from "../components/SvgDonut";
import { useAnalyticsStore } from "../stores/analytics";

const MODEL_COLORS = [
  "rgba(6,182,212,0.8)",     // cyan
  "rgba(34,197,94,0.8)",     // green
  "rgba(168,85,247,0.8)",    // purple
  "rgba(245,158,11,0.8)",    // amber
  "rgba(239,68,68,0.8)",     // red
  "rgba(59,130,246,0.8)",    // blue
];

const UNKNOWN_COLOR = "rgba(128,128,128,0.5)";

function useIsMobile() {
  const [mobile, setMobile] = useState(window.innerWidth < 640);
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return mobile;
}

export function Analytics() {
  const { summary, recentMetrics, loading, refreshing, fetchSummary, fetchRecent, refreshAll } = useAnalyticsStore();
  const isMobile = useIsMobile();

  useEffect(() => {
    fetchSummary();
    fetchRecent(50);
  }, []);

  const today = summary?.today;
  const week = summary?.week;
  const allTime = summary?.allTime;
  const dailyHistory = summary?.dailyHistory ?? [];

  // Compute values for cards (all token types including cache)
  const sumTokens = (s: typeof today) => (s?.totalIn ?? 0) + (s?.totalOut ?? 0) + (s?.totalCacheRead ?? 0) + (s?.totalCacheCreate ?? 0);
  const todayTokens = sumTokens(today);
  const weekTokens = sumTokens(week);
  const allTimeTokens = sumTokens(allTime);
  const todayRequests = today?.requestCount ?? 0;
  const todayCost = today?.totalCost ?? 0;
  const allTimeCost = allTime?.totalCost ?? 0;

  // Last 14 days for bar chart
  const last14 = dailyHistory
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-14);

  // Model distribution from week summary — unknown/empty sorted last, gray color
  const modelSegments = Object.entries(week?.models ?? {})
    .sort(([a], [b]) => {
      const aUnknown = !a || a === "unknown";
      const bUnknown = !b || b === "unknown";
      if (aUnknown && !bUnknown) return 1;
      if (!aUnknown && bUnknown) return -1;
      return 0;
    })
    .map(([name, data], i) => {
      const isUnknown = !name || name === "unknown";
      return {
        label: shortenModel(name || "unknown"),
        value: data.in + data.out,
        color: isUnknown ? UNKNOWN_COLOR : MODEL_COLORS[i % MODEL_COLORS.length],
      };
    });

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

  const donutSize = isMobile ? 120 : 140;

  // Global refresh button for header
  const refreshButton = (
    <Button
      variant="ghost" size="sm"
      onClick={refreshAll}
      disabled={refreshing}
      className="h-7 text-xs text-muted-foreground"
    >
      <RefreshCw className={cn("mr-1 h-3 w-3", refreshing && "animate-spin")} />
      {refreshing ? "Refreshing..." : "Refresh"}
    </Button>
  );

  return (
    <Layout title="Analytics" subtitle="TOKEN USAGE" actions={refreshButton}>
      {/* ─── Top Stat Cards ─── */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Zap className="h-4 w-4" />}
          label="Today Tokens"
          value={formatNum(todayTokens)}
          sub={`IN ${formatNum(today?.totalIn ?? 0)} · OUT ${formatNum(today?.totalOut ?? 0)}`}
        />
        <StatCard
          icon={<DatabaseZap className="h-4 w-4" />}
          label="All-Time Tokens"
          value={formatNum(allTimeTokens)}
          sub={`TODAY: ${formatNum(todayTokens)} · 7D: ${formatNum(weekTokens)}`}
        />
        <StatCard
          icon={<Hash className="h-4 w-4" />}
          label="Requests"
          value={String(todayRequests)}
          sub={`7D TOTAL: ${week?.requestCount ?? 0}`}
        />
        <StatCard
          icon={<Coins className="h-4 w-4" />}
          label="Est. Cost"
          value={todayCost > 0 ? `$${todayCost.toFixed(2)}` : "\u2014"}
          sub={`7D: $${(week?.totalCost ?? 0).toFixed(2)} · ALL: $${allTimeCost.toFixed(2)}`}
        />
      </div>

      {/* ─── Usage Quotas + Donut Charts ─── */}
      {usageQuotas.length > 0 ? (
        <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {/* Subscription Usage */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Subscription Usage
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {usageQuotas.map((q, i) => {
                const label = QUOTA_LABELS[q.rateLimitType] ?? q.rateLimitType;
                const util = q.utilization ?? 0;
                const isLimited = q.status === "rate_limited";
                return (
                  <div key={i}>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-xs font-medium">{label}</span>
                      <div className="flex items-center gap-2">
                        {q.resetsAt && (
                          <span className="text-[10px] text-muted-foreground">
                            resets {formatResetTime(q.resetsAt)}
                          </span>
                        )}
                        <span className={cn(
                          "text-xs font-bold",
                          isLimited ? "text-destructive" :
                          util > 80 ? "text-destructive" :
                          util > 50 ? "text-warning" :
                          "text-success"
                        )}>
                          {util > 0 ? `${util.toFixed(0)}%` : isLimited ? "LIM" : "OK"}
                        </span>
                      </div>
                    </div>
                    <Progress
                      value={Math.max(Math.min(util, 100), 2)}
                      indicatorClassName={cn(
                        isLimited ? "bg-destructive" :
                        util > 80 ? "bg-destructive" :
                        util > 50 ? "bg-warning" :
                        "bg-success"
                      )}
                    />
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Model Distribution Donut */}
          <Card>
            <CardHeader className="space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Model Distribution
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-center py-2">
              <SvgDonut
                segments={modelSegments}
                centerLabel="MODELS"
                centerValue={String(Object.keys(week?.models ?? {}).length)}
                size={donutSize}
              />
            </CardContent>
          </Card>

          {/* Token Breakdown Donut */}
          <Card>
            <CardHeader className="space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Token Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-center py-2">
              <SvgDonut
                segments={cacheSegments}
                centerLabel="7D TOTAL"
                centerValue={formatNum(weekIn + weekOut + weekCacheRead + weekCacheCreate)}
                size={donutSize}
              />
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader className="space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Model Distribution
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-center py-2">
              <SvgDonut
                segments={modelSegments}
                centerLabel="MODELS"
                centerValue={String(Object.keys(week?.models ?? {}).length)}
                size={donutSize}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Token Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-center py-2">
              <SvgDonut
                segments={cacheSegments}
                centerLabel="7D TOTAL"
                centerValue={formatNum(weekIn + weekOut + weekCacheRead + weekCacheCreate)}
                size={donutSize}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* ─── 14-Day Usage Trend ─── */}
      <Card className="mb-3">
        <CardHeader className="space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            14-Day Usage Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SvgBarChart data={last14} height={220} />
        </CardContent>
      </Card>

      {/* ─── Recent Requests Table ─── */}
      <Card>
        <CardHeader className="space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            Recent Requests
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recentMetrics.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {loading ? "LOADING..." : "NO METRICS DATA"}
            </div>
          ) : (
            <ScrollArea className="max-h-[420px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[90px]">Time</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">In</TableHead>
                    <TableHead className="text-right">Out</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Cache</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Duration</TableHead>
                    <TableHead className="text-center">Src</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentMetrics.map((m, i) => (
                    <TableRow key={i} className="hover:bg-muted/50">
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {formatTime(m.ts)}
                      </TableCell>
                      <TableCell
                        className="max-w-[140px] truncate font-mono text-[11px]"
                        title={m.model ?? ""}
                      >
                        {shortenModel(m.model ?? "\u2014")}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] text-cyan-500">
                        {m.in.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] text-green-500">
                        {m.out.toLocaleString()}
                      </TableCell>
                      <TableCell className="hidden text-right font-mono text-[11px] text-amber-500 sm:table-cell">
                        {(m.cacheRead + m.cacheCreate) > 0
                          ? (m.cacheRead + m.cacheCreate).toLocaleString()
                          : "\u2014"}
                      </TableCell>
                      <TableCell className="hidden text-right font-mono text-[11px] text-muted-foreground md:table-cell">
                        {m.dur ? `${(m.dur / 1000).toFixed(1)}s` : "\u2014"}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge
                          variant={m.src === "remi" ? "outline" : "secondary"}
                          className="text-[9px] uppercase"
                        >
                          {m.src}
                        </Badge>
                      </TableCell>
                    </TableRow>
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

// ─── Sub-components ─────────────────────────

function StatCard({ icon, label, value, sub, variant }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  variant?: "success" | "warning" | "destructive";
}) {
  return (
    <Card className="border transition-all duration-200 hover:border-primary/20">
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

// ─── Helpers ─────────────────────────────────

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
