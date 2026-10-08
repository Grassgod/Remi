"use client";

import { useMemo, useState } from "react";
import { AlertCircle, BarChart3, FolderKanban } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { UsageReport } from "@multiremi/contracts/usage-accounting";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { agentListOptions } from "@multiremi/core/workspace/queries";
import { projectListOptions } from "@multiremi/core/projects/queries";
import { runtimeListOptions } from "@multiremi/core/runtimes/queries";
import { usageReportOptions } from "@multiremi/core/usage/queries";
import {
  nullableValue,
  trendRows,
  taskTrendRows,
} from "@multiremi/core/usage/view-model";
import { Button } from "@multiremi/ui/components/ui/button";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import { PageHeader } from "../../layout/page-header";
import { ProjectIcon } from "../../projects/components/project-icon";
import { ActorAvatar } from "../../common/actor-avatar";
import { useViewingTimezone } from "../../common/use-viewing-timezone";
import { formatTokens } from "../../common/format";
import { KpiCard } from "../../runtimes/components/shared";
import { UsageChart, formatRunTime } from "../../runtimes/components/charts";
import { UsagePricingDialog } from "../../runtimes/components/custom-pricing-dialog";
import {
  CurrencyControl,
  PeriodControl,
  Segmented,
  TokenBreakdownHint,
  UsageDiagnostics,
  UsageMore,
  useUsageCalendar,
  type UsageMetric,
  type UsagePeriod,
} from "../../usage/experience-controls";
import { useT } from "../../i18n";

export function DashboardPage() {
  const wsId = useWorkspaceId();
  return <DashboardContent key={wsId} wsId={wsId} />;
}
function DashboardContent({ wsId }: { wsId: string }) {
  const { t } = useT("usage"),
    tz = useViewingTimezone();
  const [weekly, setWeekly] = useState(false),
    [days, setDays] = useState<UsagePeriod>(30),
    [projectValue, setProject] = useState(""),
    [runtimeValue, setRuntime] = useState("");
  const [metric, setMetric] = useState<UsageMetric>("tokens"),
    [currency, setCurrency] = useState("USD"),
    [pricing, setPricing] = useState(false);
  const projects = useQuery(projectListOptions(wsId)).data ?? [],
    agents = useQuery(agentListOptions(wsId)).data ?? [],
    runtimes = useQuery(runtimeListOptions(wsId)).data ?? [];
  const project = projects.find((p) => p.id === projectValue),
    runtime = runtimes.find((r) => r.id === runtimeValue);
  const windows = useUsageCalendar(days, tz);
  const query = useQuery(
    usageReportOptions(wsId, {
      days,
      tz,
      project_id: project?.id ?? null,
      runtime_id: runtime?.id ?? null,
      ...windows.current,
    }),
  );
  const report = query.data;
  const effectiveCurrency =
    report && !(currency in report.summary.known_cost_by_currency)
      ? (Object.keys(report.summary.known_cost_by_currency).sort()[0] ??
        currency)
      : currency;
  const trends = useMemo(
    () =>
      report
        ? metric === "time" || metric === "tasks"
          ? taskTrendRows(report, weekly)
          : trendRows(report, weekly, effectiveCurrency)
        : [],
    [report, metric, weekly, effectiveCurrency],
  );
  const models =
    report?.by_model.map((m) => ({
      provider: m.provider,
      model: m.model ?? m.requested_model,
      connection_id: m.connection_id,
      requested_model_alias: m.model === null,
    })) ?? [];
  const changeDimension = (next: "daily" | "weekly") => {
    setWeekly(next === "weekly");
    if (
      days !== "all" &&
      days !== 365 &&
      ((next === "weekly" && days < 30) || (next === "daily" && days > 90))
    )
      setDays(next === "weekly" ? 90 : 30);
  };
  const changePeriod = (next: UsagePeriod) => {
    setDays(next);
    if (next === "all" || next >= 180) setWeekly(true);
  };
  const value = (kind: UsageMetric) =>
    report
      ? nullableValue(report.summary, kind, effectiveCurrency)
      : { value: null, state: "unknown" as const };
  const text = (kind: UsageMetric) => {
    const v = value(kind).value;
    return v === null
      ? "—"
      : kind === "cost"
        ? `${effectiveCurrency} ${v.toFixed(2)}`
        : kind === "tokens"
          ? formatTokens(v)
          : kind === "time"
            ? formatRunTime(v)
            : String(v);
  };
  const canDraw =
    report &&
    (metric === "time" || metric === "tasks"
      ? trends.length > 0
      : trends.some((r) =>
          metric === "cost"
            ? "cost" in r && r.cost !== null
            : "input" in r && r.input !== null,
        ));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader className="h-auto min-h-12 flex-wrap justify-between gap-y-1.5 px-5 py-1.5 sm:py-0">
        <div className="flex min-w-0 items-center gap-2">
          <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-sm font-medium">{t(($) => $.title)}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={project?.id ?? "__all__"}
            onValueChange={(v) => setProject(v === "__all__" ? "" : (v ?? ""))}
          >
            <SelectTrigger
              size="sm"
              className="min-w-[180px]"
              aria-label={t(($) => $.filter.project)}
            >
              <SelectValue>
                {() => (
                  <>
                    {project ? (
                      <ProjectIcon project={project} size="sm" />
                    ) : (
                      <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">
                      {project?.title ?? t(($) => $.filter.all_projects)}
                    </span>
                  </>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              align="start"
              alignItemWithTrigger={false}
              className="max-h-72"
            >
              <SelectItem value="__all__">
                <FolderKanban className="h-3.5 w-3.5" />
                {t(($) => $.filter.all_projects)}
              </SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <ProjectIcon project={p} size="sm" />
                  {p.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={runtime?.id ?? "__all__"}
            onValueChange={(v) => setRuntime(v === "__all__" ? "" : (v ?? ""))}
          >
            <SelectTrigger
              size="sm"
              className="max-w-44"
              aria-label={t(($) => $.filter.runtime)}
            >
              <SelectValue>
                {() => runtime?.name ?? t(($) => $.filter.all_runtimes)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              align="start"
              alignItemWithTrigger={false}
              className="max-h-72"
            >
              <SelectItem value="__all__">
                {t(($) => $.filter.all_runtimes)}
              </SelectItem>
              {runtimes.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Segmented
            value={weekly ? "weekly" : "daily"}
            onChange={changeDimension}
            options={[
              { label: t(($) => $.experience.daily), value: "daily" },
              { label: t(($) => $.experience.weekly), value: "weekly" },
            ]}
            label={t(($) => $.experience.dimension)}
          />
          <PeriodControl days={days} weekly={weekly} onChange={changePeriod} />
          <UsageMore
            report={report}
            onPeriod={changePeriod}
            onPrice={() => setPricing(true)}
            onRefresh={() => query.refetch()}
            fetching={query.isFetching}
          />
        </div>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
          <p className="text-xs text-muted-foreground">
            {t(($) => $.experience.subtitle)}
          </p>
          {query.isLoading ? (
            <div className="space-y-5">
              <Skeleton className="h-28" />
              <Skeleton className="h-56" />
              <Skeleton className="h-48" />
            </div>
          ) : query.isError ? (
            <div
              role="alert"
              className="rounded-lg border border-dashed p-12 text-center"
            >
              <AlertCircle className="mx-auto h-6 w-6 text-warning" />
              <p className="mt-3 text-sm">{t(($) => $.error.body)}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => query.refetch()}
              >
                {t(($) => $.error.retry)}
              </Button>
            </div>
          ) : (
            report && (
              <>
                {report.summary.task_count === 0 && (
                  <p className="rounded-lg border border-dashed py-8 text-center text-xs text-muted-foreground">
                    {t(($) => $.experience.empty)}
                  </p>
                )}
                <UsageDiagnostics
                  report={report}
                  onPrice={() => setPricing(true)}
                />
                <div className="grid grid-cols-1 divide-y rounded-lg border bg-card sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
                  <KpiCard
                    label={t(($) => $.experience.cost)}
                    value={text("cost")}
                    hint={
                      <>
                        {value("cost").state === "subtotal" && (
                          <span>{t(($) => $.experience.subtotal)} · </span>
                        )}
                        {t(($) => $.experience.including_today)}
                      </>
                    }
                  />
                  <KpiCard
                    label={t(($) => $.experience.tokens)}
                    value={text("tokens")}
                    hint={<TokenBreakdownHint metrics={report.summary} />}
                  />
                  <KpiCard
                    label={t(($) => $.experience.time)}
                    value={text("time")}
                    hint={t(($) => $.experience.period_tasks, {
                      count: report.summary.task_count,
                    })}
                  />
                  <KpiCard
                    label={t(($) => $.experience.tasks)}
                    value={text("tasks")}
                    hint={t(($) => $.experience.failed, {
                      count: report.summary.status_counts.failed,
                    })}
                  />
                </div>
                <div className="rounded-lg border bg-card p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <h4 className="text-sm font-semibold">
                      {weekly
                        ? t(($) => $.experience.weekly)
                        : t(($) => $.experience.daily)}{" "}
                      · {t(($) => $.experience[metric])}
                    </h4>
                    <div className="flex flex-wrap items-center justify-end gap-3">
                      <CurrencyControl
                        report={report}
                        value={effectiveCurrency}
                        onChange={setCurrency}
                      />
                      <Segmented
                        value={metric}
                        onChange={setMetric}
                        options={(
                          ["tokens", "cost", "time", "tasks"] as const
                        ).map((m) => ({
                          label: t(($) => $.experience[m]),
                          value: m,
                        }))}
                        label={t(($) => $.trend.title)}
                      />
                    </div>
                  </div>
                  <div className="min-h-[240px]">
                    {canDraw ? (
                      <UsageChart
                        data={trends}
                        metric={metric}
                        weekly={weekly}
                        currency={effectiveCurrency}
                      />
                    ) : (
                      <p className="flex aspect-[3/1] items-center justify-center rounded-md border border-dashed bg-muted/20 p-6 text-center text-xs text-muted-foreground">
                        {metric === "cost"
                          ? t(($) => $.experience.cost_unknown)
                          : metric === "tokens" &&
                              report.summary.unknown_task_count
                            ? t(($) => $.experience.not_collected)
                            : t(($) => $.experience.empty)}
                      </p>
                    )}
                  </div>
                </div>
                <Leaderboard
                  report={report}
                  agents={agents}
                  currency={effectiveCurrency}
                />
              </>
            )
          )}
        </div>
      </div>
      {pricing && (
        <UsagePricingDialog
          wsId={wsId}
          models={models}
          onClose={() => setPricing(false)}
        />
      )}
    </div>
  );
}

function Leaderboard({
  report,
  agents,
  currency,
}: {
  report: UsageReport;
  agents: { id: string; name: string }[];
  currency: string;
}) {
  const { t } = useT("usage");
  const [sort, setSort] = useState<UsageMetric>("tokens");
  const rows = [...report.by_agent].sort((a, b) => {
    const x = nullableValue(a, sort, currency).value,
      y = nullableValue(b, sort, currency).value;
    return x === null ? (y === null ? 0 : 1) : y === null ? -1 : y - x;
  });
  const max = Math.max(
    0,
    ...rows.map((row) => nullableValue(row, sort, currency).value ?? 0),
  );
  const cellClass = (m: UsageMetric) =>
    `text-right text-xs tabular-nums ${m === sort ? "font-medium text-foreground" : "text-muted-foreground"}`;
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 pt-4 pb-3">
        <h4 className="text-sm font-semibold">
          {t(($) => $.experience.ranking)}
        </h4>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            value={sort}
            onChange={setSort}
            label={t(($) => $.experience.ranking)}
            options={(["tokens", "cost", "time", "tasks"] as const).map(
              (m) => ({ label: t(($) => $.experience[m]), value: m }),
            )}
          />
          <span className="text-xs text-muted-foreground">
            {t(($) => $.experience.agents_count, { count: rows.length })}
          </span>
        </div>
      </div>
      {rows.some(
        (r) => nullableValue(r, sort, currency).state === "subtotal",
      ) && (
        <p className="px-4 pt-2 text-[11px] text-muted-foreground">
          {t(($) => $.experience.partial_rank)}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted-foreground">
          {t(($) => $.experience.empty)}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_5rem_6rem_5rem_4rem] items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
              <span>{t(($) => $.experience.agent)}</span>
              <span />
              {(["tokens", "cost", "time", "tasks"] as const).map((m) => (
                <span key={m} className={cellClass(m)}>
                  {t(($) => $.experience[m])}
                </span>
              ))}
            </div>
            <div className="divide-y">
              {rows.map((row) => {
                const v = nullableValue(row, sort, currency),
                  name =
                    agents.find((a) => a.id === row.agent_id)?.name ??
                    row.agent_id;
                return (
                  <div
                    key={row.agent_id}
                    data-testid="leaderboard-row"
                    className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_5rem_6rem_5rem_4rem] items-center gap-3 px-4 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <ActorAvatar
                        actorType="agent"
                        actorId={row.agent_id}
                        size={22}
                        enableHoverCard
                      />
                      <span
                        className="truncate text-sm font-medium"
                        title={name}
                      >
                        {name}
                      </span>
                    </div>
                    <div className="relative h-2 overflow-hidden rounded-full bg-muted">
                      {v.value !== null && (
                        <div
                          data-testid="ranking-bar"
                          className="h-full rounded-full bg-chart-1 transition-[width] duration-300"
                          style={{
                            width: `${max > 0 ? (v.value / max) * 100 : 0}%`,
                          }}
                        />
                      )}
                    </div>
                    {(["tokens", "cost", "time", "tasks"] as const).map((m) => {
                      const n = nullableValue(row, m, currency);
                      return (
                        <div
                          key={m}
                          className={cellClass(m)}
                          title={
                            n.state === "subtotal"
                              ? t(($) => $.experience.subtotal)
                              : undefined
                          }
                        >
                          {n.value === null
                            ? "—"
                            : m === "cost"
                              ? `${currency} ${n.value.toFixed(2)}`
                              : m === "time"
                                ? formatRunTime(n.value)
                                : m === "tokens"
                                  ? formatTokens(n.value)
                                  : n.value}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
