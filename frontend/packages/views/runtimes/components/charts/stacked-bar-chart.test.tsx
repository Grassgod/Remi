// @vitest-environment jsdom

import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import locale from "../../../locales/en/usage.json";
import { trendRows } from "@multiremi/core/usage/view-model";
import { usageMetrics, usageReport } from "../../../usage/test-fixtures";
import { UsageChart, type UsageChartRow } from "./usage-chart";

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
    t: (selector: (translations: TestTranslations & typeof locale) => string) =>
      selector(translations),
  }),
}));

const translations: TestTranslations & typeof locale = {
  ...locale,
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
  {
    label: "5/4",
    partial: false,
    weekStart: "2026-05-04",
    input: 1,
    output: 2,
  },
  {
    label: "5/11",
    partial: true,
    weekStart: "2026-05-11",
    input: 3,
    output: 4,
  },
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

beforeEach(() => {
  rechartsState.tooltipLabel = "5/11";
  rechartsState.tooltipPayload = [
    tooltipEntry("input", 12),
    tooltipEntry("output", 3),
  ];
});

describe("Canonical usage tooltip states", () => {
  function payload(
    row: UsageChartRow,
    keys = ["input", "output", "cacheRead", "cacheWrite"],
  ) {
    rechartsState.tooltipPayload = keys.map((key) => ({
      name: key,
      dataKey: key,
      value: row[key as keyof UsageChartRow],
      payload: row,
    }));
  }
  const zero = usageMetrics({
    actual_input_tokens: 0,
    actual_output_tokens: 0,
    actual_cache_read_tokens: 0,
    actual_cache_write_tokens: 0,
    actual_unsplit_tokens: 0,
    actual_total_tokens: 0,
    priced_tokens: 0,
    unpriced_tokens: 0,
    known_cost_by_currency: { USD: 0 },
  });
  const unknown = {
    ...zero,
    unknown_task_count: 1,
    complete: false,
    known_cost_by_currency: {},
  };
  it("labels a zero-plus-unknown week and a positive partial week as known subtotals", () => {
    const rows = trendRows(
      usageReport({
        daily: [
          { ...zero, date: "2026-09-01" },
          { ...unknown, date: "2026-09-02" },
        ],
      }),
      true,
      "USD",
    );
    expect(rows[0]?.tokenState).toBe("subtotal");
    payload(rows[0]!);
    const r = render(<UsageChart data={rows} metric="tokens" weekly />);
    expect(
      r.getByText(locale.experience.subtotal).parentElement,
    ).toHaveTextContent(`${locale.experience.subtotal}0`);
    expect(r.queryByText(locale.table.total)).toBeNull();
    const positive = trendRows(
      usageReport({
        daily: [
          {
            ...zero,
            actual_input_tokens: 12,
            actual_total_tokens: 12,
            date: "2026-09-01",
          },
          { ...unknown, date: "2026-09-02" },
        ],
      }),
      true,
      "USD",
    );
    payload(positive[0]!);
    r.rerender(<UsageChart data={positive} metric="tokens" weekly />);
    expect(
      r.getByText(locale.experience.subtotal).parentElement,
    ).toHaveTextContent(`${locale.experience.subtotal}12`);
  });
  it("preserves confirmed token zero and leaves entirely unknown token and cost totals blank", () => {
    const rows = trendRows(
      usageReport({ daily: [{ ...zero, date: "2026-09-01" }] }),
      false,
      "USD",
    );
    payload(rows[0]!);
    const r = render(<UsageChart data={rows} metric="tokens" />);
    expect(r.getByText(locale.table.total).parentElement).toHaveTextContent(
      `${locale.table.total}0`,
    );
    const missing = trendRows(
      usageReport({ daily: [{ ...unknown, date: "2026-09-01" }] }),
      false,
      "USD",
    );
    payload(missing[0]!);
    r.rerender(<UsageChart data={missing} metric="tokens" />);
    expect(
      r.getByText(locale.experience.token_unknown).parentElement,
    ).toHaveTextContent(`${locale.experience.token_unknown}—`);
    expect(r.queryByText(locale.table.total)).toBeNull();
    payload(missing[0]!, ["cost"]);
    r.rerender(<UsageChart data={missing} metric="cost" />);
    expect(r.getByText(locale.table.cost).parentElement).toHaveTextContent(
      `${locale.table.cost}—`,
    );
    expect(r.queryByText("USD 0.00")).toBeNull();
    expect(r.queryByText(locale.experience.token_unknown)).toBeNull();
  });
  it("does not apply token subtotal labels to task or duration tooltips", () => {
    const row = {
      label: "2026-09-01",
      tokenState: "subtotal" as const,
      completed: 1,
      failed: 0,
      cancelled: 0,
      active: 0,
      queued: 0,
      seconds: 60,
    };
    payload(row, ["completed", "failed", "cancelled", "active", "queued"]);
    const r = render(<UsageChart data={[row]} metric="tasks" />);
    expect(
      r.getByText(locale.experience.tasks).parentElement,
    ).toHaveTextContent(`${locale.experience.tasks}1`);
    expect(r.queryByText(locale.experience.subtotal)).toBeNull();
    payload(row, ["seconds"]);
    r.rerender(<UsageChart data={[row]} metric="time" />);
    expect(r.getByText("1m")).toBeTruthy();
    expect(r.queryByText(locale.experience.subtotal)).toBeNull();
    expect(r.queryByText(locale.experience.token_unknown)).toBeNull();
  });
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
      />,
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
      />,
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
      />,
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
      />,
    );

    // Two series × two rows, with the partial row halved in both.
    expect(getAllByTestId("cell").map((c) => c.dataset.opacity)).toEqual([
      "1",
      "0.5",
      "1",
      "0.5",
    ]);
  });

  it("bins on the shared `label` field", () => {
    const { getByTestId } = render(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
      />,
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
      />,
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
      />,
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
      />,
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
      />,
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
      />,
    );
    expect(getByText("Total").parentElement?.textContent).toBe("Total$5.00");

    rerender(
      <StackedBarChart
        data={ROWS}
        config={CONFIG}
        series={["input"]}
        yAxisWidth={40}
      />,
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
      />,
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
      />,
    );

    expect(getByText("5/11")).toBeTruthy();
    expect(queryByText("in progress")).toBeNull();
  });
});
