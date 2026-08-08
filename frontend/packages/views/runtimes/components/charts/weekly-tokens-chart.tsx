import { formatTokens, type WeeklyTokenData } from "../../utils";
import { useT } from "../../../i18n";
import { TOKEN_SERIES, tokenStackConfig } from "./daily-tokens-chart";
import { StackedBarChart } from "./stacked-bar-chart";

const localeTotal = (total: number) => total.toLocaleString();

/**
 * Mirror of DailyTokensChart's four-segment stack — same series and colours
 * keep the Weekly view legible as a coarser cut of the Daily one.
 */
export function WeeklyTokensChart({ data }: { data: WeeklyTokenData[] }) {
  const { t } = useT("runtimes");
  return (
    <StackedBarChart
      data={data}
      config={tokenStackConfig}
      series={TOKEN_SERIES}
      stackId="tokens"
      yAxisWidth={50}
      yAxisTickFormatter={formatTokens}
      formatValue={formatTokens}
      totalLabel={t(($) => $.charts.tooltip_total)}
      formatTotal={localeTotal}
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
