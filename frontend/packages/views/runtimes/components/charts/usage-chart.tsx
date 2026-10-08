import type { ChartConfig } from "@multiremi/ui/components/ui/chart";
import { formatTokens } from "../../../common/format";
import { useT } from "../../../i18n";
import { StackedBarChart } from "./stacked-bar-chart";
import type { UsageMetric } from "../../../usage/experience-controls";

export interface UsageChartRow {
  label: string;
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  unsplit?: number | null;
  cost?: number | null;
  seconds?: number;
  completed?: number;
  failed?: number;
  cancelled?: number;
  active?: number;
  queued?: number;
  partial?: boolean;
  daysCovered?: number;
  rangeLabel?: string;
}

export function UsageChart({
  data,
  metric,
  weekly = false,
  currency = "USD",
}: {
  data: UsageChartRow[];
  metric: UsageMetric;
  weekly?: boolean;
  currency?: string;
}) {
  const { t } = useT("usage");
  const config: ChartConfig =
    metric === "tokens"
      ? {
          input: { label: t(($) => $.table.input), color: "var(--chart-1)" },
          output: { label: t(($) => $.table.output), color: "var(--chart-2)" },
          cacheRead: {
            label: t(($) => $.table.cache_read),
            color: "var(--chart-4)",
          },
          cacheWrite: {
            label: t(($) => $.table.cache_write),
            color: "var(--chart-3)",
          },
          unsplit: {
            label: t(($) => $.experience.unsplit),
            color: "var(--chart-5)",
          },
        }
      : metric === "cost"
        ? {
            cost: {
              label: `${t(($) => $.experience.subtotal)} · ${currency}`,
              color: "var(--chart-1)",
            },
          }
        : metric === "time"
          ? {
              seconds: {
                label: t(($) => $.experience.time),
                color: "var(--chart-1)",
              },
            }
          : {
              completed: {
                label: t(($) => $.statuses.completed),
                color: "var(--chart-1)",
              },
              failed: {
                label: t(($) => $.statuses.failed),
                color: "var(--chart-3)",
              },
              cancelled: {
                label: t(($) => $.statuses.cancelled),
                color: "var(--chart-2)",
              },
              active: {
                label: t(($) => $.statuses.active),
                color: "var(--chart-4)",
              },
              queued: {
                label: t(($) => $.statuses.queued),
                color: "var(--chart-5)",
              },
            };
  const series =
    metric === "tokens"
      ? [
          "input",
          "output",
          "cacheRead",
          "cacheWrite",
          ...(data.some((r) => (r.unsplit ?? 0) > 0) ? ["unsplit"] : []),
        ]
      : metric === "cost"
        ? ["cost"]
        : metric === "time"
          ? ["seconds"]
          : ["completed", "failed", "cancelled", "active", "queued"];
  const format =
    metric === "tokens"
      ? formatTokens
      : metric === "cost"
        ? (n: number) => `${currency} ${n.toFixed(2)}`
        : metric === "time"
          ? formatRunTime
          : (n: number) => n.toLocaleString();
  return (
    <StackedBarChart
      data={data}
      config={config}
      series={series}
      stackId={series.length > 1 ? metric : undefined}
      yAxisWidth={metric === "time" ? 56 : 50}
      yAxisAllowDecimals={metric !== "tasks"}
      yAxisTickFormatter={format}
      formatValue={format}
      totalLabel={t(($) => $.table.total)}
      formatTotal={metric === "time" ? undefined : format}
      tooltipLabel={
        weekly
          ? (row) =>
              row.partial
                ? t(($) => $.experience.partial_week, {
                    range: row.rangeLabel ?? row.label,
                    covered: row.daysCovered ?? 0,
                  })
                : (row.rangeLabel ?? row.label)
          : undefined
      }
      barOpacity={weekly ? (row) => (row.partial ? 0.5 : 1) : undefined}
      rowKey={(row) => row.label}
    />
  );
}

export function formatRunTime(seconds: number): string {
  if (seconds === 0) return "0m";
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
    : `${minutes}m`;
}

/** The old chart legend stays in the card header, leaving the plot its space. */
export function UsageChartLegend({
  metric,
  unsplit = false,
  currency = "USD",
}: {
  metric: "tokens" | "cost";
  unsplit?: boolean;
  currency?: string;
}) {
  const { t } = useT("usage");
  const items =
    metric === "cost"
      ? [
          {
            label: `${t(($) => $.experience.subtotal)} · ${currency}`,
            color: 1,
          },
        ]
      : [
          { label: t(($) => $.table.input), color: 1 },
          { label: t(($) => $.table.output), color: 2 },
          { label: t(($) => $.table.cache_read), color: 4 },
          { label: t(($) => $.table.cache_write), color: 3 },
          ...(unsplit
            ? [{ label: t(($) => $.experience.unsplit), color: 5 }]
            : []),
        ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-sm"
            style={{ background: `var(--chart-${item.color})` }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
