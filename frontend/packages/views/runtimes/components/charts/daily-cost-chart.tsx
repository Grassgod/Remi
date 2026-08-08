import type { ChartConfig } from "@multiremi/ui/components/ui/chart";
import type { DailyCostStackData } from "../../utils";
import { useT } from "../../../i18n";
import { StackedBarChart } from "./stacked-bar-chart";

// Three-segment stack (input / output / cache write) — keeps the user's
// attention on what's actually driving spend. Cache reads are excluded
// because their per-token rate is two orders of magnitude smaller and
// would be visually invisible in a stack; we surface their *savings*
// separately as a KPI.
//
// Series → CSS chart token: stack reads bottom-up as chart-1 (deepest brand
// blue, "input") → chart-2 (mid) → chart-3 (lightest, "cache write"), so the
// visual depth maps directly to "primary cost driver → secondary".
export const costStackConfig = {
  input: { label: "Input", color: "var(--chart-1)" },
  output: { label: "Output", color: "var(--chart-2)" },
  cacheWrite: { label: "Cache write", color: "var(--chart-3)" },
} satisfies ChartConfig;

export const COST_SERIES = ["input", "output", "cacheWrite"] as const;

const dollars = (v: number) => `$${v}`;
const dollarsWithCents = (v: number) => `$${v.toFixed(2)}`;

export function DailyCostChart({ data }: { data: DailyCostStackData[] }) {
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
    />
  );
}
