import type { ChartConfig } from "@multiremi/ui/components/ui/chart";
import { StackedBarChart } from "./stacked-bar-chart";

// Single-series bar — total daily run time in seconds. The y-axis tick
// formatter and tooltip both use the same `formatDuration` so the user
// reads the same unit ladder (h / m / s) everywhere.
export const timeChartConfig = {
  totalSeconds: { label: "Run time", color: "var(--chart-1)" },
} satisfies ChartConfig;

export const TIME_SERIES = ["totalSeconds"] as const;

export interface DailyTimeData {
  date: string;
  label: string;
  totalSeconds: number;
}

export function DailyTimeChart({
  data,
  formatY,
  formatTooltip,
}: {
  data: DailyTimeData[];
  // Caller passes a `formatDuration`-style fn so the chart stays UI-string
  // agnostic (the "< 1m" fallback label is localized by the parent).
  formatY: (seconds: number) => string;
  formatTooltip: (seconds: number) => string;
}) {
  return (
    <StackedBarChart
      data={data}
      config={timeChartConfig}
      series={TIME_SERIES}
      yAxisWidth={56}
      yAxisTickFormatter={formatY}
      formatValue={formatTooltip}
    />
  );
}
