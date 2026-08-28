import { formatTokens, type WeeklyTokenData } from "../../utils";
import { useT } from "../../../i18n";
import { getTokenSeries, tokenStackConfig } from "./daily-tokens-chart";
import { StackedBarChart } from "./stacked-bar-chart";

/**
 * Mirror of DailyTokensChart's four regular segments and conditional
 * total-only segment. The same series and colours keep the Weekly view
 * legible as a coarser cut of the Daily one.
 */
export function WeeklyTokensChart({ data }: { data: WeeklyTokenData[] }) {
  const { t } = useT("runtimes");
  return (
    <StackedBarChart
      data={data}
      config={
        tokenStackConfig({
          input: t(($) => $.usage.legend_input),
          output: t(($) => $.usage.legend_output),
          cacheRead: t(($) => $.usage.legend_cache_read),
          cacheWrite: t(($) => $.usage.legend_cache_write),
          totalOnly: t(($) => $.usage.legend_total_only),
        })
      }
      series={getTokenSeries(data)}
      stackId="tokens"
      yAxisWidth={50}
      yAxisTickFormatter={formatTokens}
      formatValue={formatTokens}
      totalLabel={t(($) => $.charts.tooltip_total)}
      formatTotal={formatTokens}
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
