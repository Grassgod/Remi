"use client";

import { useMemo, useState } from "react";
import { AlertCircle, ChevronRight } from "lucide-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { AgentRuntime } from "@multiremi/core/types";
import type { UsageReport } from "@multiremi/contracts/usage-accounting";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { agentListOptions } from "@multiremi/core/workspace/queries";
import {
  usageDayModelOptions,
  usageReportOptions,
} from "@multiremi/core/usage/queries";
import {
  compareCost,
  modelKey,
  nullableValue,
  trendRows,
} from "@multiremi/core/usage/view-model";
import { Button } from "@multiremi/ui/components/ui/button";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { ActorAvatar } from "../../common/actor-avatar";
import { formatTokens } from "../../common/format";
import { useViewingTimezone } from "../../common/use-viewing-timezone";
import {
  CurrencyControl,
  PeriodControl,
  Segmented,
  TokenBreakdownHint,
  UsageDiagnostics,
  UsageMore,
  useUsageCalendar,
  useUsageKpiLabel,
  type UsagePeriod,
} from "../../usage/experience-controls";
import { ModelLabel } from "../../usage/model-label";
import { KpiCard } from "./shared";
import { ActivityHeatmap, UsageChart, UsageChartLegend } from "./charts";
import { UsagePricingDialog } from "./custom-pricing-dialog";
import { useT } from "../../i18n";

export function UsageSection({ runtime }: { runtime: AgentRuntime }) {
  const wsId = useWorkspaceId();
  return (
    <RuntimeUsageContent
      key={`${wsId}:${runtime.id}`}
      wsId={wsId}
      runtimeId={runtime.id}
    />
  );
}
function RuntimeUsageContent({
  wsId,
  runtimeId,
}: {
  wsId: string;
  runtimeId: string;
}) {
  const { t } = useT("usage"),
    tz = useViewingTimezone();
  const [days, setDays] = useState<UsagePeriod>(30),
    [weekly, setWeekly] = useState(false),
    [metric, setMetric] = useState<"tokens" | "cost">("cost");
  const [heatmap, setHeatmap] = useState(false),
    [breakdown, setBreakdown] = useState(false),
    [costBy, setCostBy] = useState<"agent" | "model">("agent"),
    [currency, setCurrency] = useState("USD"),
    [heatmapCurrency, setHeatmapCurrency] = useState("USD");
  const [pricing, setPricing] = useState<{
    initial?: {
      provider: string;
      model: string | null;
      connection_id: string | null;
      requested_model_alias: boolean;
    };
  } | null>(null);
  const windows = useUsageCalendar(days, tz);
  const kpiLabel = useUsageKpiLabel(days);
  const query = useQuery(
    usageReportOptions(wsId, {
      days,
      tz,
      runtime_id: runtimeId,
      ...windows.current,
    }),
  );
  const report = query.data;
  const previous = useQuery({
    ...usageReportOptions(wsId, {
      tz,
      runtime_id: runtimeId,
      ...windows.previous,
    }),
    enabled: Boolean(wsId) && !!windows.previous && !!report,
  });
  const longView = useQuery({
    ...usageReportOptions(wsId, {
      tz,
      runtime_id: runtimeId,
      ...windows.heatmap,
    }),
    enabled: Boolean(wsId) && heatmap && !!report,
  });
  const detail = useInfiniteQuery(
    usageDayModelOptions(
      wsId,
      { days, tz, runtime_id: runtimeId, ...windows.current },
      breakdown,
    ),
  );
  const agents = useQuery(agentListOptions(wsId)).data ?? [];
  const effectiveCurrency =
    report && !(currency in report.summary.known_cost_by_currency)
      ? (Object.keys(report.summary.known_cost_by_currency).sort()[0] ??
        currency)
      : currency;
  const effectiveHeatmapCurrency =
    longView.data &&
    !(heatmapCurrency in longView.data.summary.known_cost_by_currency)
      ? (Object.keys(longView.data.summary.known_cost_by_currency).sort()[0] ??
        heatmapCurrency)
      : heatmapCurrency;
  const data = useMemo(
    () => (report ? trendRows(report, weekly, effectiveCurrency) : []),
    [report, weekly, effectiveCurrency],
  );
  const changePeriod = (next: UsagePeriod) => {
    setDays(next);
    if (next === "all" || next >= 180) setWeekly(true);
  };
  const changeDimension = (next: "daily" | "weekly") => {
    setWeekly(next === "weekly");
    if (
      days !== "all" &&
      days !== 365 &&
      ((next === "weekly" && days < 30) || (next === "daily" && days > 90))
    )
      setDays(next === "weekly" ? 90 : 30);
  };
  const models =
    report?.by_model.map((m) => ({
      provider: m.provider,
      model: m.model ?? m.requested_model,
      connection_id: m.connection_id,
      requested_model_alias: m.model === null,
    })) ?? [];
  const cost = report
      ? nullableValue(report.summary, "cost", effectiveCurrency)
      : null,
    tokens = report ? nullableValue(report.summary, "tokens") : null;
  const delta =
    report && previous.data
      ? compareCost(report, previous.data, effectiveCurrency)
      : null;
  const canDraw = data.some((row) =>
    metric === "cost" ? row.cost !== null : row.input !== null,
  );
  const detailRows =
    detail.data?.pages.flatMap((page) => page.day_model?.rows ?? []) ?? [];
  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            {t(($) => $.experience.dimension)}
          </span>
          <Segmented
            value={weekly ? "weekly" : "daily"}
            onChange={changeDimension}
            options={[
              { label: t(($) => $.experience.daily), value: "daily" },
              { label: t(($) => $.experience.weekly), value: "weekly" },
            ]}
            label={t(($) => $.experience.dimension)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PeriodControl
            days={days}
            weekly={weekly}
            onChange={changePeriod}
            runtime
          />
          <UsageMore
            report={report}
            onPeriod={changePeriod}
            onPrice={() => setPricing({})}
            onRefresh={() => query.refetch()}
            fetching={query.isFetching}
          />
        </div>
      </div>
      {query.isLoading ? (
        <div className="space-y-5">
          <Skeleton className="h-28" />
          <Skeleton className="h-56" />
          <Skeleton className="h-32" />
        </div>
      ) : query.isError ? (
        <div
          role="alert"
          className="rounded-lg border border-dashed py-8 text-center"
        >
          <AlertCircle className="mx-auto h-5 w-5 text-warning" />
          <p className="mt-2 text-xs">{t(($) => $.error.body)}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => query.refetch()}
          >
            {t(($) => $.error.retry)}
          </Button>
        </div>
      ) : (
        report && (
          <>
            <UsageDiagnostics report={report} onPrice={() => setPricing({})} />
            <div data-testid="runtime-usage-kpis" className="grid grid-cols-3 divide-x rounded-lg border bg-card">
              <KpiCard
                compact
                label={kpiLabel(t(($) => $.experience.cost))}
                value={
                  cost?.value === null || !cost
                    ? "—"
                    : `${effectiveCurrency} ${cost.value.toFixed(2)}`
                }
                hint={
                  <>
                    {cost?.state === "subtotal" && (
                      <span>{t(($) => $.experience.subtotal)} · </span>
                    )}
                    {delta !== null && (
                      <span
                        className={
                          delta > 0
                            ? "text-warning"
                            : delta < 0
                              ? "text-success"
                              : ""
                        }
                      >
                        {t(($) => $.experience.compare, {
                          sign: delta > 0 ? "+" : "",
                          pct: Math.round(delta),
                        })}{" "}
                        ·{" "}
                      </span>
                    )}
                    {t(($) => $.experience.including_today)}
                  </>
                }
              />
              <KpiCard
                compact
                label={kpiLabel(t(($) => $.experience.cache))}
                value="—"
                hint={
                  <>
                    {t(($) => $.experience.cache_unknown)}
                    <span className="block">
                      {t(($) => $.experience.cache_read, {
                        tokens:
                          tokens?.state === "unknown"
                            ? "—"
                            : formatTokens(
                                report.summary.actual_cache_read_tokens,
                              ),
                      })}
                    </span>
                  </>
                }
              />
              <KpiCard
                compact
                label={kpiLabel(t(($) => $.experience.tokens))}
                value={
                  tokens?.value === null || !tokens
                    ? "—"
                    : formatTokens(tokens.value)
                }
                hint={<TokenBreakdownHint metrics={report.summary} />}
              />
            </div>
            <div className="min-w-0 rounded-lg border bg-card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h4 className="text-sm font-semibold">
                    {t(($) => $.experience.trend)}
                  </h4>
                  {!heatmap && (
                    <Segmented
                      value={metric}
                      onChange={setMetric}
                      options={[
                        { label: t(($) => $.experience.cost), value: "cost" },
                        {
                          label: t(($) => $.experience.tokens),
                          value: "tokens",
                        },
                      ]}
                      label={t(($) => $.trend.title)}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setHeatmap((v) => !v)}
                    aria-pressed={heatmap}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${heatmap ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground"}`}
                  >
                    {t(($) => $.experience.heatmap)}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {!heatmap && (
                    <UsageChartLegend
                      metric={metric}
                      currency={effectiveCurrency}
                      unsplit={data.some((row) => (row.unsplit ?? 0) > 0)}
                    />
                  )}
                  <CurrencyControl
                    report={heatmap ? longView.data : report}
                    value={
                      heatmap ? effectiveHeatmapCurrency : effectiveCurrency
                    }
                    onChange={heatmap ? setHeatmapCurrency : setCurrency}
                  />
                </div>
              </div>
              {heatmap && (
                <p className="mb-2 text-center text-xs text-muted-foreground">
                  {t(($) => $.experience.heatmap_caption)}
                </p>
              )}
              <div className="min-h-[260px]">
                {heatmap ? (
                  longView.isLoading ? (
                    <Skeleton className="h-56" />
                  ) : longView.isError ? (
                    <div role="alert" className="py-10 text-center text-xs">
                      {t(($) => $.error.body)}{" "}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => longView.refetch()}
                      >
                        {t(($) => $.error.retry)}
                      </Button>
                    </div>
                  ) : (
                    longView.data && (
                      <ActivityHeatmap
                        report={longView.data}
                        windows={windows}
                        currency={effectiveHeatmapCurrency}
                      />
                    )
                  )
                ) : canDraw ? (
                  <UsageChart
                    data={data}
                    metric={metric}
                    weekly={weekly}
                    currency={effectiveCurrency}
                  />
                ) : (
                  <p className="flex aspect-[3/1] items-center justify-center rounded-md border border-dashed bg-muted/20 p-6 text-center text-xs text-muted-foreground">
                    {metric === "cost"
                      ? t(($) => $.experience.cost_unknown)
                      : report.summary.unknown_task_count
                        ? t(($) => $.experience.not_collected)
                        : t(($) => $.experience.empty)}
                  </p>
                )}
              </div>
            </div>
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
                <div className="flex items-center gap-3">
                  <h4 className="text-sm font-semibold">
                    {costBy === "agent"
                      ? t(($) => $.experience.by_agent)
                      : t(($) => $.experience.by_model)}
                  </h4>
                  <Segmented
                    value={costBy}
                    onChange={setCostBy}
                    label={t(($) => $.experience.ranking)}
                    options={[
                      {
                        label: t(($) => $.experience.by_agent),
                        value: "agent",
                      },
                      {
                        label: t(($) => $.experience.by_model),
                        value: "model",
                      },
                    ]}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {t(($) => $.experience.subtotal)} · {effectiveCurrency}
                </span>
              </div>
              <CostByList
                report={report}
                tab={costBy}
                agents={agents}
                currency={effectiveCurrency}
                onPrice={(m) =>
                  setPricing({
                    initial: {
                      provider: m.provider,
                      model: m.model ?? m.requested_model,
                      connection_id: m.connection_id,
                      requested_model_alias: m.model === null,
                    },
                  })
                }
              />
            </div>
            <div className="border-t pt-3">
              <button
                type="button"
                aria-expanded={breakdown}
                onClick={() => setBreakdown((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  className={`h-3 w-3 transition-transform ${breakdown ? "rotate-90" : ""}`}
                />
                {t(($) => $.experience.daily_detail)}
              </button>
              {breakdown && (
                <div className="mt-3 space-y-3 rounded-md border p-4">
                  {detail.isLoading ? (
                    <Skeleton className="h-32" />
                  ) : detail.isError ? (
                    <div role="alert" className="text-xs">
                      {t(($) => $.error.body)}{" "}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => detail.refetch()}
                      >
                        {t(($) => $.error.retry)}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="max-h-64 overflow-auto">
                        <table className="w-full min-w-[640px] text-xs">
                          <thead className="border-b">
                            <tr>
                              {[
                                t(($) => $.views.daily),
                                t(($) => $.price.model),
                                t(($) => $.table.input),
                                t(($) => $.table.output),
                                t(($) => $.table.cache_read),
                                t(($) => $.table.cache_write),
                                t(($) => $.table.unsplit),
                              ].map((label) => (
                                <th
                                  key={label}
                                  className="px-3 py-2 text-left font-medium text-muted-foreground"
                                >
                                  {label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {detailRows.map((row) => (
                              <tr
                                key={`${row.date}:${modelKey(row)}`}
                                className="border-b last:border-0"
                              >
                                <td className="whitespace-nowrap px-3 py-2">
                                  {row.date}
                                </td>
                                <td className="max-w-64 px-3 py-2">
                                  <ModelLabel model={row} />
                                </td>
                                {[
                                  row.actual_input_tokens,
                                  row.actual_output_tokens,
                                  row.actual_cache_read_tokens,
                                  row.actual_cache_write_tokens,
                                  row.actual_unsplit_tokens,
                                ].map((n, i) => (
                                  <td key={i} className="px-3 py-2 font-mono">
                                    {n === 0 && row.unknown_task_count > 0
                                      ? "—"
                                      : formatTokens(n)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {detailRows.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          {t(($) => $.experience.empty)}
                        </p>
                      )}
                      <p className="text-[11px] text-muted-foreground">
                        {t(($) => $.experience.loaded_only)}
                      </p>
                      {detail.hasNextPage && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={detail.isFetchingNextPage}
                          onClick={() => detail.fetchNextPage()}
                        >
                          {t(($) => $.experience.load_more)}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )
      )}
      {pricing && (
        <UsagePricingDialog
          wsId={wsId}
          models={models}
          initial={pricing.initial}
          onClose={() => setPricing(null)}
        />
      )}
    </div>
  );
}

function CostByList({
  report,
  tab,
  agents,
  currency,
  onPrice,
}: {
  report: UsageReport;
  tab: "agent" | "model";
  agents: { id: string; name: string }[];
  currency: string;
  onPrice: (model: UsageReport["by_model"][number]) => void;
}) {
  const { t } = useT("usage");
  const rows = (tab === "agent" ? report.by_agent : report.by_model)
    .map((metrics) => ({
      metrics,
      value: nullableValue(metrics, "cost", currency),
    }))
    .sort((a, b) =>
      a.value.value === null
        ? b.value.value === null
          ? 0
          : 1
        : b.value.value === null
          ? -1
          : b.value.value - a.value.value,
    );
  const max = Math.max(0, ...rows.map((r) => r.value.value ?? 0));
  return (
    <div className="pt-4">
      <div className="space-y-2">
        {rows.map(({ metrics, value }) => (
          <div
            key={"agent_id" in metrics ? metrics.agent_id : modelKey(metrics)}
            data-testid="cost-ranking-row"
            className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-x-3 gap-y-1 py-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_5rem_6rem] sm:gap-3"
          >
            <div className="col-start-1 row-start-1 min-w-0">
              {"agent_id" in metrics ? (
                <div className="flex min-w-0 items-center gap-2">
                  <ActorAvatar
                    actorType="agent"
                    actorId={metrics.agent_id}
                    size={22}
                    enableHoverCard
                  />
                  <span className="truncate text-sm font-medium">
                    {agents.find((a) => a.id === metrics.agent_id)?.name ??
                      metrics.agent_id}
                  </span>
                </div>
              ) : (
                <>
                  <ModelLabel model={metrics} />
                  {(metrics.model ?? metrics.requested_model) && (
                    <button
                      type="button"
                      className="mt-1 text-[11px] text-brand hover:underline"
                      onClick={() => onPrice(metrics)}
                    >
                      {t(($) => $.price.open)}
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="relative col-start-1 row-start-2 h-2 overflow-hidden rounded-full bg-muted sm:col-start-2 sm:row-start-1">
              {value.value !== null && (
                <div
                  className="h-full rounded-full bg-chart-1"
                  style={{
                    width: `${max > 0 ? (value.value / max) * 100 : 0}%`,
                  }}
                />
              )}
            </div>
            <div className="col-start-2 row-start-2 text-right text-xs tabular-nums text-muted-foreground sm:col-start-3 sm:row-start-1">
              {nullableValue(metrics, "tokens").value === null
                ? "—"
                : formatTokens(metrics.actual_total_tokens)}
            </div>
            <div
              className="col-start-2 row-start-1 text-right text-sm font-medium tabular-nums sm:col-start-4"
              title={
                value.state === "subtotal"
                  ? t(($) => $.experience.subtotal)
                  : undefined
              }
            >
              {value.value === null
                ? "—"
                : `${currency} ${value.value.toFixed(2)}`}
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {t(($) => $.experience.empty)}
          </p>
        )}
      </div>
    </div>
  );
}
