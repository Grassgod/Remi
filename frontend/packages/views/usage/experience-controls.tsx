"use client";

import type { UsageReport } from "@multiremi/contracts/usage-accounting";
import { Button } from "@multiremi/ui/components/ui/button";
import { useEffect, useMemo, useState } from "react";
import {
  calendarWindows,
  nullableValue,
  type ConsumptionMetrics,
} from "@multiremi/core/usage/view-model";
import { useT } from "../i18n";
import { formatTokens } from "../common/format";
import { formatKnownCost, tokenCoverage, usageCsv } from "./utils";

export type UsagePeriod = number | "all";
export type UsageMetric = "tokens" | "cost" | "time" | "tasks";
export function TokenBreakdownHint({
  metrics,
}: {
  metrics: ConsumptionMetrics;
}) {
  const { t } = useT("usage");
  const tokens = nullableValue(metrics, "tokens");
  if (tokens.value === null)
    return <span>{t(($) => $.experience.not_collected)}</span>;
  return (
    <span data-testid="token-breakdown">
      {t(($) => $.table.input)} {formatTokens(metrics.actual_input_tokens)} ·{" "}
      {t(($) => $.table.output)} {formatTokens(metrics.actual_output_tokens)} ·{" "}
      {t(($) => $.experience.cache_tokens)}{" "}
      {formatTokens(
        metrics.actual_cache_read_tokens + metrics.actual_cache_write_tokens,
      )}
      {metrics.actual_unsplit_tokens > 0 && (
        <>
          {" "}
          · {t(($) => $.table.unsplit)}{" "}
          {formatTokens(metrics.actual_unsplit_tokens)}
        </>
      )}
      {tokens.state === "subtotal" && <> · {t(($) => $.experience.subtotal)}</>}
    </span>
  );
}
export function useUsageCalendar(days: UsagePeriod, tz: string) {
  const [asOf, setAsOf] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setAsOf(new Date().toISOString()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return useMemo(() => calendarWindows(asOf, tz, days), [asOf, tz, days]);
}
export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { label: string; value: T }[];
  label: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex flex-wrap items-center gap-0.5 rounded-md bg-muted p-0.5 ${disabled ? "opacity-50" : ""}`}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-sm px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed ${value === option.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PeriodControl({
  days,
  weekly,
  onChange,
  runtime = false,
}: {
  days: UsagePeriod;
  weekly: boolean;
  onChange: (days: UsagePeriod) => void;
  runtime?: boolean;
}) {
  const { t } = useT("usage");
  const periods = (
    weekly ? [30, 90, 180] : runtime ? [7, 30, 90] : [1, 7, 30, 90]
  ).map((value) => ({ label: `${value}d`, value: value as UsagePeriod }));
  if (days === "all" || days === 365)
    periods.push({
      label: days === "all" ? t(($) => $.filter.all_history) : "365d",
      value: days,
    });
  return (
    <Segmented
      value={days}
      onChange={onChange}
      options={periods}
      label={t(($) => $.experience.period)}
    />
  );
}

export function UsageMore({
  report,
  onPrice,
  onRefresh,
  fetching,
  onPeriod,
}: {
  report?: UsageReport;
  onPrice: () => void;
  onRefresh: () => void;
  fetching?: boolean;
  onPeriod: (days: UsagePeriod) => void;
}) {
  const { t } = useT("usage");
  const [group, setGroup] = useState<
    "daily" | "agents" | "models" | "runtimes"
  >("daily");
  const download = () => {
    if (!report) return;
    const rows =
      group === "daily"
        ? report.daily.map((m) => ({ label: m.date, metrics: m }))
        : group === "agents"
          ? report.by_agent.map((m) => ({
              key: m.agent_id,
              label: m.agent_id,
              metrics: m,
            }))
          : group === "runtimes"
            ? report.by_runtime.map((m) => ({
                key: m.runtime_id ?? "",
                label: m.runtime_id ?? t(($) => $.common.no_runtime),
                metrics: m,
              }))
            : report.by_model.map((m) => ({
                key: JSON.stringify([
                  m.provider,
                  m.model,
                  m.requested_model,
                  m.model_provenance,
                  m.purpose,
                  m.connection_id,
                ]),
                label:
                  m.model ??
                  m.requested_model ??
                  t(($) => $.price.unknown_model),
                metrics: m,
                provider: m.provider,
                actualModel: m.model,
                requested: m.requested_model,
                modelProvenance: m.model_provenance,
                purpose: m.purpose,
                connection: m.connection_id,
              }));
    const url = URL.createObjectURL(
      new Blob(["\uFEFF", usageCsv(rows)], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `usage-${group}-${report.as_of.slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <details className="relative text-xs">
      <summary className="cursor-pointer rounded-md border px-2.5 py-1.5 text-muted-foreground">
        {t(($) => $.experience.more)}
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-64 space-y-3 rounded-lg border bg-popover p-3 shadow-md">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onPeriod(365)}>
            365d
          </Button>
          <Button size="sm" variant="outline" onClick={() => onPeriod("all")}>
            {t(($) => $.filter.all_history)}
          </Button>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={onPrice}
        >
          {t(($) => $.price.open)}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="w-full"
          onClick={onRefresh}
          disabled={fetching}
        >
          {t(($) => $.common.refresh)}
        </Button>
        <label className="block space-y-1">
          {t(($) => $.experience.csv_group)}
          <select
            className="h-8 w-full rounded-md border bg-background px-2"
            value={group}
            onChange={(e) => setGroup(e.target.value as typeof group)}
          >
            <option value="daily">{t(($) => $.views.daily)}</option>
            <option value="agents">{t(($) => $.views.agents)}</option>
            <option value="models">{t(($) => $.views.models)}</option>
            <option value="runtimes">{t(($) => $.views.runtimes)}</option>
          </select>
        </label>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={download}
          disabled={!report}
        >
          {t(($) => $.common.export_csv)}
        </Button>
      </div>
    </details>
  );
}

export function UsageDiagnostics({
  report,
  onPrice,
}: {
  report: UsageReport;
  onPrice: () => void;
}) {
  const { t } = useT("usage");
  const metrics = report.summary;
  const coverage = tokenCoverage(metrics);
  return (
    <details
      className={`rounded-lg border px-3 py-2 text-xs ${metrics.complete ? "text-muted-foreground" : "border-warning/30 bg-warning/10"}`}
    >
      <summary className="cursor-pointer">
        {t(($) => $.experience.diagnostics)} · {t(($) => $.summary.coverage)}{" "}
        {coverage === null ? "—" : `${(coverage * 100).toFixed(1)}%`}
        {metrics.unknown_task_count > 0 &&
          ` · ${t(($) => $.summary.unknown)} ${metrics.unknown_task_count}`}
      </summary>
      <div className="space-y-2 pt-3">
        <p>
          {metrics.complete
            ? t(($) => $.summary.complete)
            : t(($) => $.summary.partial)}
        </p>
        <p>
          {t(($) => $.price.source)}: {t(($) => $.price[metrics.price_quality])}
        </p>
        <p>
          {t(($) => $.summary.context)}:{" "}
          {metrics.context_peak_tokens === null
            ? "—"
            : formatTokens(metrics.context_peak_tokens)}{" "}
          · {t(($) => $.summary.context_hint)}
        </p>
        <p>{t(($) => $.summary.time_hint)}</p>
        {!!metrics.task_attributed_task_count && (
          <p>{t(($) => $.summary.historical_date_hint)}</p>
        )}
        {!!metrics.identity_conflict_task_count && (
          <p>{t(($) => $.summary.identity_conflict_hint)}</p>
        )}
        {Object.keys(metrics.reference_cost_by_currency ?? {}).length > 0 && (
          <p>
            {t(($) => $.summary.reference_cost)}:{" "}
            {formatKnownCost({
              ...metrics,
              known_cost_by_currency: metrics.reference_cost_by_currency!,
            })}{" "}
            · {t(($) => $.summary.reference_hint)}
          </p>
        )}
        {Object.keys(metrics.sdk_estimate_cost_by_currency ?? {}).length >
          0 && (
          <p>
            {t(($) => $.summary.sdk_estimate)}:{" "}
            {formatKnownCost({
              ...metrics,
              known_cost_by_currency: metrics.sdk_estimate_cost_by_currency!,
            })}{" "}
            · {t(($) => $.summary.reference_hint)}
          </p>
        )}
        <p>
          {Object.entries(metrics.status_counts)
            .map(
              ([status, count]) =>
                `${t(($) => $.statuses[status as keyof typeof $.statuses])} ${count}`,
            )
            .join(" · ")}
        </p>
        <p>{t(($) => $.views.counts_hint)}</p>
        <p>
          {t(($) => $.common.updated)} {report.as_of} · {report.window.tz} ·{" "}
          {t(($) => $.common.price_revision)} {report.pricing_revision}
        </p>
        <Button size="sm" variant="outline" onClick={onPrice}>
          {t(($) => $.price.open)}
        </Button>
      </div>
    </details>
  );
}

export function CurrencyControl({
  report,
  value,
  onChange,
}: {
  report?: UsageReport;
  value: string;
  onChange: (currency: string) => void;
}) {
  const { t } = useT("usage");
  const currencies = Object.keys(
    report?.summary.known_cost_by_currency ?? {},
  ).sort();
  if (currencies.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {t(($) => $.experience.currency)}
      <select
        className="h-8 rounded-md border bg-background px-2 text-foreground"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {currencies.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    </label>
  );
}
