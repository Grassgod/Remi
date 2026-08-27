// @vitest-environment jsdom

import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const rechartsState = vi.hoisted(() => ({
  tooltipLabel: "5/11",
  tooltipPayload: [] as Array<Record<string, unknown>>,
}));

interface TestTranslations {
  charts: { tooltip_total: string };
  usage: {
    legend_input: string;
    legend_output: string;
    legend_cache_read: string;
    legend_cache_write: string;
    legend_total_only: string;
    weekly_partial_label: string;
  };
}

// recharts needs real layout to render an SVG, which jsdom has none of.
// Stub its layout primitives but render the real shared tooltip content.
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
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
  Tooltip: ({ content }: { content: ReactNode }) => {
    const renderedContent = isValidElement(content)
      ? cloneElement(content as ReactElement<Record<string, unknown>>, {
          active: true,
          label: rechartsState.tooltipLabel,
          payload: rechartsState.tooltipPayload,
        })
      : content;
    return <div data-testid="tooltip">{renderedContent}</div>;
  },
  Legend: () => null,
}));

vi.mock("../../../i18n", () => ({
  useT: () => ({
    t: (selector: (translations: TestTranslations) => string) =>
      selector(translations),
  }),
}));

const translations: TestTranslations = {
  charts: { tooltip_total: "Total" },
  usage: {
    legend_input: "Input",
    legend_output: "Output",
    legend_cache_read: "Cache read",
    legend_cache_write: "Cache write",
    legend_total_only: "Total only",
    weekly_partial_label: "In progress",
  },
};

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

function tooltipEntry(name: string, value: unknown) {
  return {
    name,
    dataKey: name,
    value,
    color: `var(--color-${name})`,
    payload: ROWS[1],
  };
}

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

beforeEach(() => {
  rechartsState.tooltipLabel = "5/11";
  rechartsState.tooltipPayload = [
    tooltipEntry("input", 12),
    tooltipEntry("output", 3),
  ];
});

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

  it("renders config labels instead of data keys and hides zero-value rows", () => {
    rechartsState.tooltipPayload = [
      tooltipEntry("input", 12),
      tooltipEntry("output", 0),
    ];

    const { getByText, queryByText } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input", "output"]}
        yAxisWidth={40}
        formatValue={(v) => `$${v.toFixed(2)}`}
      />
    );

    expect(getByText("Input")).toBeTruthy();
    expect(getByText("$12.00")).toBeTruthy();
    expect(queryByText("input")).toBeNull();
    expect(queryByText("Output")).toBeNull();
  });

  it("passes nonnumeric tooltip values through", () => {
    rechartsState.tooltipPayload = [tooltipEntry("input", "n/a")];

    const { getByText } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
        formatValue={(v) => `$${v.toFixed(2)}`}
      />
    );

    expect(getByText("n/a")).toBeTruthy();
  });

  it("falls back to all tooltip rows when every value is zero", () => {
    rechartsState.tooltipPayload = [
      tooltipEntry("input", 0),
      tooltipEntry("output", 0),
    ];

    const { getAllByText, getByText } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input", "output"]}
        yAxisWidth={40}
      />
    );

    expect(getByText("Input")).toBeTruthy();
    expect(getByText("Output")).toBeTruthy();
    expect(getAllByText("0")).toHaveLength(2);
  });

  it("totals the stack in the tooltip footer, and omits it when unasked", () => {
    rechartsState.tooltipPayload = [
      tooltipEntry("input", 2),
      tooltipEntry("output", 3),
    ];

    const { getByText, queryByText, rerender } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
        totalLabel="Total"
        formatTotal={(t) => `$${t.toFixed(2)}`}
      />
    );
    expect(getByText("Total").parentElement?.textContent).toBe("Total$5.00");

    rerender(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
      />
    );
    expect(queryByText("Total")).toBeNull();
  });

  it("relabels the tooltip header from the row when a weekly chart asks", () => {
    const { getByText } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
        tooltipLabel={(row) => (row.partial ? "in progress" : "done")}
      />
    );

    expect(getByText("in progress")).toBeTruthy();
  });

  it("leaves the tooltip header alone for daily charts", () => {
    const { getByText, queryByText } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
      />
    );

    expect(getByText("5/11")).toBeTruthy();
    expect(queryByText("in progress")).toBeNull();
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
