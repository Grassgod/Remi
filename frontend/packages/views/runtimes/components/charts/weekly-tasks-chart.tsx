import { useT } from "../../../i18n";
import { TASKS_SERIES, localeTotal, tasksChartConfig } from "./daily-tasks-chart";
import { StackedBarChart } from "./stacked-bar-chart";

export interface WeeklyTasksData {
  weekStart: string;
  weekEnd: string;
  label: string;
  rangeLabel: string;
  partial: boolean;
  daysCovered: number;
  completed: number;
  failed: number;
}

/**
 * Weekly counterpart of DailyTasksChart — same completed/failed stacked bar,
 * but each bar groups a Mon–Sun calendar week. Partial-week bars at half
 * opacity match WeeklyCostChart / WeeklyTokensChart so the in-progress week
 * reads as visually subordinate everywhere.
 */
export function WeeklyTasksChart({ data }: { data: WeeklyTasksData[] }) {
  const { t } = useT("usage");
  const { t: tRuntimes } = useT("runtimes");
  return (
    <StackedBarChart
      data={data}
      config={tasksChartConfig}
      series={TASKS_SERIES}
      stackId="tasks"
      yAxisWidth={40}
      yAxisAllowDecimals={false}
      totalLabel={tRuntimes(($) => $.charts.tooltip_total)}
      formatTotal={localeTotal}
      tooltipLabel={(row) =>
        row.partial
          ? t(($) => $.weekly.partial_label, {
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
