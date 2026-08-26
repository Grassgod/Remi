// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// recharts needs real layout to render an SVG, which jsdom has none of.
// Stub the primitives down to inspectable markers: the value of this
// component is which props reach which primitive, and that survives.
vi.mock("recharts", () => ({
  BarChart: ({ children }: { children: ReactNode }) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: ({
    dataKey,
    stackId,
    fill,
    radius,
    children,
  }: {
    dataKey: string;
    stackId?: string;
    fill: string;
    radius: number[];
    children?: ReactNode;
  }) => (
    <div
      data-testid="bar"
      data-key={dataKey}
      data-stack={stackId ?? ""}
      data-fill={fill}
      data-radius={radius.join(",")}
    >
      {children}
    </div>
  ),
  Cell: ({ fillOpacity }: { fillOpacity: number }) => (
    <div data-testid="cell" data-opacity={String(fillOpacity)} />
  ),
  XAxis: ({ dataKey }: { dataKey: string }) => (
    <div data-testid="x-axis" data-key={dataKey} />
  ),
  YAxis: ({
    width,
    allowDecimals,
    tickFormatter,
  }: {
    width: number;
    allowDecimals?: boolean;
    tickFormatter?: (v: number) => string;
  }) => (
    <div
      data-testid="y-axis"
      data-width={String(width)}
      data-allow-decimals={String(allowDecimals)}
      data-tick={tickFormatter ? tickFormatter(1500) : ""}
    />
  ),
  CartesianGrid: () => <div data-testid="grid" />,
}));

vi.mock("@multiremi/ui/components/ui/chart", () => ({
  ChartContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="chart-container">{children}</div>
  ),
  ChartTooltip: ({ content }: { content: ReactNode }) => (
    <div data-testid="tooltip">{content}</div>
  ),
  ChartTooltipContent: (props: Record<string, unknown>) => {
    const formatter = props.formatter as
      | ((v: unknown, n: string) => unknown)
      | undefined;
    const footer = props.footer as
      | ((p: { value: number }[]) => ReactNode)
      | undefined;
    const labelFormatter = props.labelFormatter as
      | ((l: unknown, p: { payload: unknown }[]) => ReactNode)
      | undefined;
    return (
      <div data-testid="tooltip-content" data-label-key={String(props.labelKey)}>
        <span data-testid="formatted">{String(formatter?.(12, "Input"))}</span>
        <span data-testid="formatted-nonnumeric">
          {String(formatter?.("n/a", "Input"))}
        </span>
        <span data-testid="footer">
          {footer ? footer([{ value: 2 }, { value: 3 }]) : "no-footer"}
        </span>
        <span data-testid="label">
          {labelFormatter
            ? labelFormatter("x", [{ payload: { partial: true } }])
            : "no-label-formatter"}
        </span>
      </div>
    );
  },
}));

vi.mock("../../../i18n", () => ({
  useT: () => ({ t: () => "Total only" }),
}));

import { StackedBarChart } from "./stacked-bar-chart";
import { DailyTokensChart } from "./daily-tokens-chart";
import { WeeklyTokensChart } from "./weekly-tokens-chart";
import type { DailyTokenData, WeeklyTokenData } from "../../utils";

const CONFIG = {
  input: { label: "Input", color: "var(--chart-1)" },
  output: { label: "Output", color: "var(--chart-2)" },
};

interface Row {
  label: string;
  partial: boolean;
  weekStart: string;
  input: number;
  output: number;
}

const ROWS: Row[] = [
  { label: "5/4", partial: false, weekStart: "2026-05-04", input: 1, output: 2 },
  { label: "5/11", partial: true, weekStart: "2026-05-11", input: 3, output: 4 },
];

const DAILY_TOKENS: DailyTokenData = {
  date: "2026-08-26",
  label: "8/26",
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  totalOnly: 0,
};

const WEEKLY_TOKENS: WeeklyTokenData = {
  weekStart: "2026-08-24",
  weekEnd: "2026-08-30",
  label: "Aug 24",
  rangeLabel: "Aug 24 - Aug 30",
  partial: true,
  daysCovered: 3,
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  totalOnly: 0,
};

afterEach(() => cleanup());

describe("StackedBarChart", () => {
  it("renders one bar per series, stacked, with only the top bar capped", () => {
    const { getAllByTestId } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input", "output"]}
        stackId="cost"
        yAxisWidth={50}
      />
    );

    const bars = getAllByTestId("bar");
    expect(bars.map((b) => b.dataset.key)).toEqual(["input", "output"]);
    expect(bars.map((b) => b.dataset.stack)).toEqual(["cost", "cost"]);
    expect(bars.map((b) => b.dataset.fill)).toEqual([
      "var(--color-input)",
      "var(--color-output)",
    ]);
    expect(bars.map((b) => b.dataset.radius)).toEqual(["0,0,0,0", "3,3,0,0"]);
  });

  it("leaves single-series charts unstacked and capped", () => {
    const { getAllByTestId } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={56}
      />
    );

    const bars = getAllByTestId("bar");
    expect(bars).toHaveLength(1);
    expect(bars[0]!.dataset.stack).toBe("");
    expect(bars[0]!.dataset.radius).toBe("3,3,0,0");
  });

  it("emits no cells until a caller asks for per-row opacity", () => {
    const { queryAllByTestId } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input", "output"]}
        stackId="cost"
        yAxisWidth={50}
      />
    );
    expect(queryAllByTestId("cell")).toHaveLength(0);
  });

  it("dims the in-progress bucket in every series when asked", () => {
    const { getAllByTestId } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input", "output"]}
        stackId="cost"
        yAxisWidth={50}
        barOpacity={(row) => (row.partial ? 0.5 : 1)}
        rowKey={(row) => row.weekStart}
      />
    );

    // Two series × two rows, with the partial row halved in both.
    expect(
      getAllByTestId("cell").map((c) => c.dataset.opacity)
    ).toEqual(["1", "0.5", "1", "0.5"]);
  });

  it("bins on the shared `label` field", () => {
    const { getByTestId } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
      />
    );
    expect(getByTestId("x-axis").dataset.key).toBe("label");
  });

  it("forwards the y-axis width, decimals flag and tick formatter", () => {
    const { getByTestId } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
        yAxisAllowDecimals={false}
        yAxisTickFormatter={(v) => `$${v}`}
      />
    );

    const axis = getByTestId("y-axis");
    expect(axis.dataset.width).toBe("40");
    expect(axis.dataset.allowDecimals).toBe("false");
    expect(axis.dataset.tick).toBe("$1500");
  });

  it("formats numeric tooltip values and passes anything else through", () => {
    const { getByTestId } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
        formatValue={(v) => `$${v.toFixed(2)}`}
      />
    );

    expect(getByTestId("formatted").textContent).toBe("$12.00 Input");
    expect(getByTestId("formatted-nonnumeric").textContent).toBe("n/a Input");
  });

  it("totals the stack in the tooltip footer, and omits it when unasked", () => {
    const { getByTestId, rerender } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
        totalLabel="Total"
        formatTotal={(t) => `$${t.toFixed(2)}`}
      />
    );
    expect(getByTestId("footer").textContent).toBe("Total$5.00");

    rerender(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
      />
    );
    expect(getByTestId("footer").textContent).toBe("no-footer");
  });

  it("relabels the tooltip header from the row when a weekly chart asks", () => {
    const { getByTestId } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
        tooltipLabel={(row) => (row.partial ? "in progress" : "done")}
      />
    );

    expect(getByTestId("tooltip-content").dataset.labelKey).toBe("rangeLabel");
    expect(getByTestId("label").textContent).toBe("in progress");
  });

  it("leaves the tooltip header alone for daily charts", () => {
    const { getByTestId } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
      />
    );

    expect(getByTestId("tooltip-content").dataset.labelKey).toBe("undefined");
    expect(getByTestId("label").textContent).toBe("no-label-formatter");
  });
});

describe("token charts", () => {
  it.each([
    ["daily", <DailyTokensChart key="daily-zero" data={[DAILY_TOKENS]} />],
    ["weekly", <WeeklyTokensChart key="weekly-zero" data={[WEEKLY_TOKENS]} />],
  ])("omits the zero total-only series from the %s chart", (_name, chart) => {
    const { getAllByTestId } = render(chart);

    const bars = getAllByTestId("bar");
    expect(bars.map((bar) => bar.dataset.key)).toEqual([
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
    ]);
    expect(bars).toHaveLength(4);
    expect(bars.at(-1)?.dataset.radius).toBe("3,3,0,0");
    // Recharts builds tooltip entries from rendered Bars, so no totalOnly
    // Bar also means no spurious "Total only 0" tooltip entry.
    expect(bars.map((bar) => bar.dataset.key)).not.toContain("totalOnly");
  });

  it.each([
    [
      "daily",
      <DailyTokensChart
        key="daily-total-only"
        data={[{ ...DAILY_TOKENS, totalOnly: 5_181_880 }]}
      />,
    ],
    [
      "weekly",
      <WeeklyTokensChart
        key="weekly-total-only"
        data={[{ ...WEEKLY_TOKENS, totalOnly: 5_181_880 }]}
      />,
    ],
  ])("adds the non-zero total-only series to the %s chart", (_name, chart) => {
    const { getAllByTestId } = render(chart);

    const bars = getAllByTestId("bar");
    expect(bars.map((bar) => bar.dataset.key)).toEqual([
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalOnly",
    ]);
    expect(bars.at(-1)?.dataset.radius).toBe("3,3,0,0");
  });
});
