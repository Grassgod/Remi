import { useT } from "../../../i18n";
import { TIME_SERIES, timeChartConfig } from "./daily-time-chart";
import { StackedBarChart } from "./stacked-bar-chart";

export interface WeeklyTimeData {
  weekStart: string;
  weekEnd: string;
  label: string;
  rangeLabel: string;
  partial: boolean;
  daysCovered: number;
  totalSeconds: number;
}

/**
 * Weekly counterpart of DailyTimeChart — same single-series bar, but each bar
 * represents Mon–Sun run-time totals. Partial weeks render at half opacity
 * and tag their tooltip with "(partial · N / 7 days)" so the user can't
 * misread an in-progress week as a sudden drop.
 */
export function WeeklyTimeChart({
  data,
  formatY,
  formatTooltip,
}: {
  data: WeeklyTimeData[];
  formatY: (seconds: number) => string;
  formatTooltip: (seconds: number) => string;
}) {
  const { t } = useT("usage");
  return (
    <StackedBarChart
      data={data}
      config={timeChartConfig}
      series={TIME_SERIES}
      yAxisWidth={56}
      yAxisTickFormatter={formatY}
      formatValue={formatTooltip}
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
