import type { ChartConfig } from "@multiremi/ui/components/ui/chart";
import { useT } from "../../../i18n";
import { StackedBarChart } from "./stacked-bar-chart";

// Two-segment stack — completed runs at the bottom (chart-1, primary
// brand), failed runs on top (chart-5 for distinct emphasis). Lets the
// user see day-over-day failure-rate trend without a separate chart.
export const tasksChartConfig = {
  completed: { label: "Completed", color: "var(--chart-1)" },
  failed: { label: "Failed", color: "var(--chart-5)" },
} satisfies ChartConfig;

export const TASKS_SERIES = ["completed", "failed"] as const;

export const localeTotal = (total: number) => total.toLocaleString();

export interface DailyTasksData {
  date: string;
  label: string;
  completed: number;
  failed: number;
}

export function DailyTasksChart({ data }: { data: DailyTasksData[] }) {
  const { t } = useT("runtimes");
  return (
    <StackedBarChart
      data={data}
      config={tasksChartConfig}
      series={TASKS_SERIES}
      stackId="tasks"
      yAxisWidth={40}
      yAxisAllowDecimals={false}
      totalLabel={t(($) => $.charts.tooltip_total)}
      formatTotal={localeTotal}
    />
  );
}
