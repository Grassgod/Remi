import type { WeeklyCostStackData } from "../../utils";
import { useT } from "../../../i18n";
import { COST_SERIES, costStackConfig } from "./daily-cost-chart";
import { StackedBarChart } from "./stacked-bar-chart";

const dollars = (v: number) => `$${v}`;
const dollarsWithCents = (v: number) => `$${v.toFixed(2)}`;

/**
 * Same three-segment stack as DailyCostChart — series, colours and ordering
 * are the shared `costStackConfig` so the user reads "Weekly" as a coarser
 * cut of the same chart, not a different chart. Partial-week bars render at
 * half-opacity so "this week is in progress" is visually obvious without a
 * separate legend.
 */
export function WeeklyCostChart({ data }: { data: WeeklyCostStackData[] }) {
  const { t } = useT("runtimes");
  return (
    <StackedBarChart
      data={data}
      config={costStackConfig}
      series={COST_SERIES}
      stackId="cost"
      yAxisWidth={50}
      yAxisTickFormatter={dollars}
      formatValue={dollarsWithCents}
      totalLabel={t(($) => $.charts.tooltip_total)}
      formatTotal={dollarsWithCents}
      tooltipLabel={(row) =>
        row.partial
          ? t(($) => $.usage.weekly_partial_label, {
              range: row.rangeLabel,
              covered: row.daysCovered,
            })
          : row.rangeLabel
      }
      barOpacity={(row) => (row.partial ? 0.5 : 1)}
      rowKey={(row) => row.weekStart}
    />
  );
}
