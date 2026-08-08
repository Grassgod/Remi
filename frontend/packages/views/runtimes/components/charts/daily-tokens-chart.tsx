import type { ChartConfig } from "@multiremi/ui/components/ui/chart";
import { formatTokens, type DailyTokenData } from "../../utils";
import { useT } from "../../../i18n";
import { StackedBarChart } from "./stacked-bar-chart";

// Four-segment stack — input / output / cache read / cache write. Unlike the
// cost chart, cache reads ARE visible here: a typical day on Claude shows
// cache reads dominating raw token counts (often 10×+ input), so the user
// only sees the real shape of usage when reads are stacked in. The cost
// chart drops them for the opposite reason (their dollar contribution is
// two orders of magnitude smaller and would be visually invisible).
//
// Series → CSS chart token: stack reads bottom-up as chart-1 (deepest brand
// blue, "input") → chart-2 (mid) → chart-4 (cache read) → chart-3 (lightest,
// "cache write"). Cache read gets chart-4 so the two cache series are
// visually adjacent and tonally distinct from input/output.
export const tokenStackConfig = {
  input: { label: "Input", color: "var(--chart-1)" },
  output: { label: "Output", color: "var(--chart-2)" },
  cacheRead: { label: "Cache read", color: "var(--chart-4)" },
  cacheWrite: { label: "Cache write", color: "var(--chart-3)" },
} satisfies ChartConfig;

export const TOKEN_SERIES = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
] as const;

const localeTotal = (total: number) => total.toLocaleString();

export function DailyTokensChart({ data }: { data: DailyTokenData[] }) {
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
    />
  );
}
