import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@multiremi/ui/components/ui/chart";

/**
 * The usage charts' shared recharts scaffolding.
 *
 * Cost, tokens, tasks and run time each ship a daily and a weekly chart —
 * eight files that were 65-80% the same ChartContainer/BarChart/CartesianGrid/
 * XAxis/YAxis/ChartTooltip/Bar tree. Everything they actually differ on is a
 * prop here: which series stack, how a value reads, whether a tooltip footer
 * totals the stack, and (weekly only) the range label and the half-opacity
 * treatment for the in-progress bucket.
 *
 * Every chart bins on a `label` field, so the x-axis key is fixed rather than
 * configurable — a chart binned on something else is a different chart, not a
 * variation of this one.
 *
 * No internal empty-state: the parent decides what to show in place of the
 * chart (often a diagnostic explaining *why* there's no data). Letting
 * recharts render an empty axis would be both ugly and uninformative.
 *
 * The legend is likewise the parent's job — it lives in the chart card
 * header, top-right, so the chart body keeps the full vertical real estate.
 */
export function StackedBarChart<Row>({
  data,
  config,
  series,
  stackId,
  yAxisWidth,
  yAxisTickFormatter,
  yAxisAllowDecimals,
  formatValue,
  totalLabel,
  formatTotal,
  tooltipLabel,
  barOpacity,
  rowKey,
}: {
  data: Row[];
  config: ChartConfig;
  /** Data keys, bottom-up. The topmost one gets the rounded cap. */
  series: readonly string[];
  /** Omit for single-series charts so the bar is not stacked. */
  stackId?: string;
  yAxisWidth: number;
  yAxisTickFormatter?: (value: number) => string;
  yAxisAllowDecimals?: boolean;
  /** Renders one series' value in a tooltip row. Raw value when omitted. */
  formatValue?: (value: number) => string;
  /** Both are needed for the tooltip footer; omit for no footer. */
  totalLabel?: string;
  formatTotal?: (total: number) => string;
  /** Weekly charts relabel the tooltip header with the covered date range. */
  tooltipLabel?: (row: Row) => string;
  /** Weekly charts dim the in-progress bucket. */
  barOpacity?: (row: Row) => number;
  /** Stable per-row key. Required whenever `barOpacity` is set. */
  rowKey?: (row: Row) => string;
}) {
  return (
    <ChartContainer config={config} className="aspect-[3/1] w-full">
      <BarChart data={data} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval="preserveStartEnd"
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={yAxisTickFormatter}
          allowDecimals={yAxisAllowDecimals}
          width={yAxisWidth}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelKey={tooltipLabel ? "rangeLabel" : undefined}
              labelFormatter={
                tooltipLabel
                  ? (_label, payload) => {
                      const row = payload[0]?.payload as Row | undefined;
                      return row ? tooltipLabel(row) : "";
                    }
                  : undefined
              }
              formatter={(value, name) =>
                typeof value === "number" && formatValue
                  ? `${formatValue(value)} ${name}`
                  : `${value} ${name}`
              }
              footer={
                formatTotal
                  ? (payload) => {
                      const total = payload.reduce(
                        (sum, item) =>
                          sum +
                          (typeof item.value === "number" ? item.value : 0),
                        0,
                      );
                      return (
                        <div className="flex items-center justify-between gap-2 font-medium">
                          <span>{totalLabel}</span>
                          <span className="font-mono tabular-nums">
                            {formatTotal(total)}
                          </span>
                        </div>
                      );
                    }
                  : undefined
              }
            />
          }
        />
        {series.map((key, index) => (
          <Bar
            key={key}
            dataKey={key}
            stackId={stackId}
            fill={`var(--color-${key})`}
            radius={index === series.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
          >
            {barOpacity
              ? data.map((row, rowIndex) => (
                  <Cell
                    key={rowKey ? `${rowKey(row)}-${key}` : rowIndex}
                    fillOpacity={barOpacity(row)}
                  />
                ))
              : null}
          </Bar>
        ))}
      </BarChart>
    </ChartContainer>
  );
}
