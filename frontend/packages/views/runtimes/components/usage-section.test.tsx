import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "@multiremi/contracts/usage-accounting";
import type { AgentRuntime } from "@multiremi/core/types";
import locale from "../../locales/en/usage.json";
import { usageMetrics, usageReport } from "../../usage/test-fixtures";
import { UsageSection } from "./usage-section";

const state = vi.hoisted(() => ({
  report: null as UsageReport | null,
  previous: null as UsageReport | null,
  longReport: null as UsageReport | null,
  echoWindows: false,
  error: false,
  ws: "ws",
  options: [] as { queryKey: unknown[]; enabled?: boolean }[],
  detailEnabled: false,
  detailParams: null as Record<string, unknown> | null,
  detailRows: [] as unknown[],
  hasNext: false,
  refetch: vi.fn(),
  next: vi.fn(),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => state.ws }));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (o: unknown) => o,
  infiniteQueryOptions: (o: unknown) => o,
  useQuery: (o: { queryKey: unknown[]; enabled?: boolean }) => {
    state.options.push(o);
    const params = o.queryKey.at(-1) as Record<string, unknown>;
    const isLongWindow =
      typeof params.since === "string" &&
      typeof params.until === "string" &&
      Date.parse(params.until) - Date.parse(params.since) > 100 * 86_400_000;
    const base =
      isLongWindow && state.longReport
        ? state.longReport
        : params.days === undefined && state.previous
          ? state.previous
          : state.report;
    const data =
      base && state.echoWindows
        ? {
            ...base,
            window: {
              ...base.window,
              since: params.since ?? null,
              until: params.until ?? null,
              tz: params.tz,
              runtime_id: params.runtime_id,
              project_id: params.project_id ?? null,
              days: params.days ?? null,
            },
          }
        : base;
    return o.queryKey[0] === "usage-accounting"
      ? {
          data: o.enabled === false ? undefined : data,
          isError: state.error && o.enabled !== false,
          isLoading: false,
          isFetching: false,
          refetch: state.refetch,
        }
      : { data: [{ id: "agent-old", name: "Historical agent" }] };
  },
  useInfiniteQuery: (o: { enabled: boolean; queryKey: unknown[] }) => {
    state.detailEnabled = o.enabled;
    state.detailParams = o.queryKey.at(-2) as Record<string, unknown>;
    return {
      data: o.enabled
        ? {
            pages: [
              {
                day_model: {
                  rows: state.detailRows,
                  next_cursor: state.hasNext ? "next" : null,
                },
              },
            ],
          }
        : undefined,
      isLoading: false,
      isError: false,
      hasNextPage: state.hasNext,
      isFetchingNextPage: false,
      fetchNextPage: state.next,
      refetch: state.refetch,
    };
  },
}));
vi.mock("../../i18n", () => ({
  useT: () => ({
    t: (s: (v: typeof locale) => string, p?: Record<string, string | number>) =>
      s(locale).replace(/\{\{(\w+)\}\}/g, (_, key) => String(p?.[key] ?? key)),
  }),
}));
vi.mock("../../common/use-viewing-timezone", () => ({
  useViewingTimezone: () => "UTC",
}));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({
    actorId,
    enableHoverCard,
  }: {
    actorId: string;
    enableHoverCard: boolean;
  }) => (
    <span data-testid="avatar" data-hover={String(enableHoverCard)}>
      {actorId}
    </span>
  ),
}));
vi.mock("./charts/stacked-bar-chart", () => ({
  StackedBarChart: ({ data, series }: { data: unknown; series: string[] }) => (
    <div data-testid="trend" data-series={series.join(",")}>
      {JSON.stringify(data)}
    </div>
  ),
}));
vi.mock("./custom-pricing-dialog", () => ({
  UsagePricingDialog: ({ initial }: { initial: unknown }) => (
    <div role="dialog">{JSON.stringify(initial)}</div>
  ),
}));
const runtime = { id: "rt" } as AgentRuntime;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"));
  state.report = usageReport();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.error = false;
  state.ws = "ws";
  state.options = [];
  state.detailRows = [];
  state.previous = null;
  state.longReport = null;
  state.echoWindows = false;
  state.hasNext = false;
  vi.clearAllMocks();
});

describe("Restored canonical Runtime usage", () => {
  it("keeps three story cards, the cache-savings slot and server cost/token toggles", () => {
    render(<UsageSection runtime={runtime} />);
    expect(screen.getByTestId("token-breakdown")).toHaveTextContent(
      "Input 100 · Output 20 · Cache 15 · Actual unsplit 15",
    );
    expect(screen.getByText(locale.experience.cache)).toBeVisible();
    expect(screen.getByText(locale.experience.cache_unknown)).toBeVisible();
    expect(screen.queryByText(/hit rate/i)).toBeNull();
    expect(screen.getByTestId("trend")).toHaveAttribute("data-series", "cost");
    expect(screen.getByTestId("trend")).not.toHaveTextContent("8000");
    fireEvent.click(
      within(screen.getByRole("group", { name: locale.trend.title })).getByRole(
        "button",
        { name: locale.experience.tokens },
      ),
    );
    expect(screen.getByTestId("trend")).toHaveAttribute(
      "data-series",
      "input,output,cacheRead,cacheWrite,unsplit",
    );
    expect(
      state.options
        .filter((o) => o.queryKey[0] === "usage-accounting")
        .every(
          (o) =>
            (o.queryKey.at(-1) as { runtime_id: string }).runtime_id === "rt",
        ),
    ).toBe(true);
  });
  it("requests fixed 26-week heatmap only after activation and keeps unknown, measured zero, no record and future distinct", () => {
    const unknown = usageMetrics({
      actual_total_tokens: 0,
      unknown_task_count: 1,
      known_cost_by_currency: {},
      complete: false,
    });
    state.report = usageReport({
      daily: [
        {
          ...usageMetrics({ known_cost_by_currency: { USD: 0 } }),
          date: "2026-10-05",
        },
        { ...unknown, date: "2026-10-06" },
      ],
    });
    const r = render(<UsageSection runtime={runtime} />);
    const longQuery = () =>
      state.options
        .filter(
          (o) =>
            o.queryKey[0] === "usage-accounting" &&
            (o.queryKey.at(-1) as { since?: string }).since ===
              "2026-04-13T00:00:00.000Z",
        )
        .at(-1);
    expect(longQuery()?.enabled).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: locale.experience.heatmap }),
    );
    expect(longQuery()?.enabled).toBe(true);
    const svg = screen.getByRole("img", { name: locale.experience.heatmap });
    expect(svg.querySelectorAll("rect")).toHaveLength(182);
    expect(svg.querySelector('[data-date="2026-10-05"]')).toHaveAttribute(
      "data-state",
      "known",
    );
    expect(svg.querySelector('[data-date="2026-10-06"]')).toHaveAttribute(
      "data-state",
      "unknown",
    );
    expect(svg.querySelector('[data-date="2026-10-04"]')).toHaveAttribute(
      "data-state",
      "empty",
    );
    expect(svg.querySelector('[data-date="2026-10-07"]')).toHaveAttribute(
      "data-state",
      "future",
    );
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(longQuery()?.enabled).toBe(true);
    expect((longQuery()?.queryKey.at(-1) as { since: string }).since).toBe(
      "2026-04-13T00:00:00.000Z",
    );
    state.ws = "next";
    r.rerender(<UsageSection runtime={runtime} />);
    expect(screen.queryByTestId("activity-heatmap")).toBeNull();
  });
  it("lazily opens true date/model details and loads additional pages without exporting a partial page as full history", () => {
    const model = state.report!.by_model[0]!;
    const {
      total_seconds: _seconds,
      status_counts: _counts,
      ...consumption
    } = model;
    state.detailRows = [{ ...consumption, date: "2026-10-02" }];
    state.hasNext = true;
    render(<UsageSection runtime={runtime} />);
    expect(state.detailEnabled).toBe(false);
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: locale.experience.daily_detail }),
    );
    expect(state.detailEnabled).toBe(true);
    expect(screen.getByRole("table")).toHaveTextContent("2026-10-02");
    expect(screen.getByRole("table")).toHaveTextContent("retired-model");
    expect(screen.getByText(locale.experience.loaded_only)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: locale.experience.load_more }),
    );
    expect(state.next).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: locale.experience.daily_detail }),
    );
    expect(state.detailEnabled).toBe(false);
  });
  it("preserves requested historical model identity and opens the precise server pricing key", () => {
    state.report = usageReport({
      by_model: [
        {
          ...usageMetrics(),
          provider: "codex",
          model: null,
          requested_model: "old-gpt",
          model_source: "requested",
          model_provenance: "session_acknowledged",
          connection_id: "saved-route",
        },
      ],
    });
    render(<UsageSection runtime={runtime} />);
    fireEvent.click(
      within(
        screen.getByRole("group", { name: locale.experience.ranking }),
      ).getByRole("button", { name: locale.experience.by_model }),
    );
    expect(screen.getByText("codex · old-gpt")).toBeVisible();
    expect(screen.getByText(locale.experience.requested_only)).toBeVisible();
    expect(
      screen.getByText(locale.experience.model_detail).closest("details"),
    ).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText(locale.experience.model_detail));
    expect(screen.getByText(locale.experience.requested_only)).toBeVisible();
    expect(screen.getByText("saved-route")).toBeVisible();
    fireEvent.click(
      within(screen.getByTestId("cost-ranking-row")).getByRole("button", {
        name: locale.price.open,
      }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      '"connection_id":"saved-route"',
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      '"requested_model_alias":true',
    );
  });
  it("retains a separate unallocated charge and never gives its covered model a fake zero amount", () => {
    state.report = usageReport({
      by_model: [
        {
          ...usageMetrics({
            known_cost_by_currency: {},
            cost_allocation_complete: false,
            complete: false,
          }),
          provider: "claude",
          model: "opus",
          requested_model: "opus",
          model_source: "reported",
          model_provenance: "provider_reported",
          connection_id: null,
        },
        {
          ...usageMetrics({
            actual_total_tokens: 0,
            known_cost_by_currency: { USD: 0.25 },
            cost_allocation_complete: false,
            complete: false,
          }),
          provider: "claude",
          model: null,
          requested_model: null,
          model_source: "unknown",
          model_provenance: "unallocated_cost",
          connection_id: null,
        },
      ],
    });
    render(<UsageSection runtime={runtime} />);
    fireEvent.click(
      within(
        screen.getByRole("group", { name: locale.experience.ranking }),
      ).getByRole("button", { name: locale.experience.by_model }),
    );
    const rows = screen.getAllByTestId("cost-ranking-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(locale.price.unallocated_cost);
    expect(rows[0]).toHaveTextContent("USD 0.25");
    expect(rows[1]).toHaveTextContent("—");
    expect(within(rows[1]!).queryByText("USD 0.00")).toBeNull();
    fireEvent.click(within(rows[1]!).getByText(locale.experience.model_detail));
    expect(
      within(rows[1]!).getAllByText(locale.price.reported_model),
    ).toHaveLength(1);
    expect(
      within(rows[1]!).queryByText(`${locale.price.requested}: opus`),
    ).toBeNull();
  });
  it("uses the selected currency independently and suppresses a misleading incomplete cost comparison", () => {
    state.report = usageReport({
      summary: usageMetrics({
        known_cost_by_currency: { USD: 1, EUR: 2 },
        complete: false,
      }),
      by_agent: [
        {
          ...usageMetrics({
            known_cost_by_currency: { USD: 1, EUR: 2 },
            complete: false,
          }),
          agent_id: "agent-old",
        },
      ],
    });
    render(<UsageSection runtime={runtime} />);
    fireEvent.change(screen.getByLabelText(locale.experience.currency), {
      target: { value: "EUR" },
    });
    expect(screen.getAllByText("EUR 2.00")).toHaveLength(2);
    expect(screen.queryByText(/vs previous period/)).toBeNull();
    expect(screen.queryByText("USD 3.00")).toBeNull();
  });
  it("shows confirmed historical CNY heatmap costs even when the selected short period has no costs", () => {
    state.report = usageReport({
      summary: usageMetrics({
        known_cost_by_currency: {},
        actual_total_tokens: 0,
        task_count: 0,
      }),
      daily: [],
    });
    const historical = usageMetrics({ known_cost_by_currency: { CNY: 3 } });
    state.longReport = usageReport({
      summary: historical,
      daily: [{ ...historical, date: "2026-08-07" }],
    });
    render(<UsageSection runtime={runtime} />);
    fireEvent.click(
      screen.getByRole("button", { name: locale.experience.heatmap }),
    );
    const heatmap = screen.getByTestId("activity-heatmap");
    expect(within(heatmap).getByText("CNY 3.00")).toBeVisible();
    expect(
      screen
        .getByRole("img", { name: locale.experience.heatmap })
        .querySelector('[data-date="2026-08-07"] title'),
    ).toHaveTextContent("CNY 3.00");
    expect(within(heatmap).queryByText("USD 0.00")).toBeNull();
  });
  it("keeps heatmap currency independent from current KPIs and stable when the period changes", () => {
    state.report = usageReport({
      summary: usageMetrics({ known_cost_by_currency: { USD: 1, EUR: 2 } }),
    });
    const historical = usageMetrics({
      known_cost_by_currency: { CNY: 3, EUR: 4 },
    });
    state.longReport = usageReport({
      summary: historical,
      daily: [{ ...historical, date: "2026-08-07" }],
    });
    render(<UsageSection runtime={runtime} />);
    fireEvent.change(screen.getByLabelText(locale.experience.currency), {
      target: { value: "EUR" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: locale.experience.heatmap }),
    );
    expect(screen.getByLabelText(locale.experience.currency)).toHaveValue(
      "CNY",
    );
    fireEvent.change(screen.getByLabelText(locale.experience.currency), {
      target: { value: "EUR" },
    });
    expect(
      within(screen.getByTestId("activity-heatmap")).getByText("EUR 4.00"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(screen.getByLabelText(locale.experience.currency)).toHaveValue(
      "EUR",
    );
    expect(
      within(screen.getByTestId("activity-heatmap")).getByText("EUR 4.00"),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: locale.experience.heatmap }),
    );
    expect(screen.getByLabelText(locale.experience.currency)).toHaveValue(
      "EUR",
    );
    expect(screen.getAllByText("EUR 2.00")).toHaveLength(1);
  });
  it("shows failed report loads as retryable errors without measured zeros", () => {
    state.error = true;
    render(<UsageSection runtime={runtime} />);
    expect(screen.getByRole("alert")).toHaveTextContent(locale.error.body);
    expect(screen.queryByTestId("trend")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: locale.error.retry }));
    expect(state.refetch).toHaveBeenCalledOnce();
  });
  it("compares contiguous calendar queries and reuses their exact scope for lazy details", () => {
    state.echoWindows = true;
    state.report = usageReport({
      summary: usageMetrics({ known_cost_by_currency: { USD: 2 } }),
    });
    state.previous = usageReport({
      summary: usageMetrics({ known_cost_by_currency: { USD: 1 } }),
    });
    render(<UsageSection runtime={runtime} />);
    expect(screen.getByText(/\+100% vs previous period/)).toBeVisible();
    const params = state.options
      .filter((o) => o.queryKey[0] === "usage-accounting")
      .map((o) => o.queryKey.at(-1));
    expect(params).toContainEqual(
      expect.objectContaining({
        days: 30,
        runtime_id: "rt",
        tz: "UTC",
        since: "2026-09-07T00:00:00.000Z",
        until: "2026-10-07T00:00:00.000Z",
      }),
    );
    expect(params).toContainEqual(
      expect.objectContaining({
        runtime_id: "rt",
        tz: "UTC",
        since: "2026-08-08T00:00:00.000Z",
        until: "2026-09-07T00:00:00.000Z",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: locale.experience.daily_detail }),
    );
    expect(state.detailParams).toEqual(
      expect.objectContaining({
        days: 30,
        runtime_id: "rt",
        tz: "UTC",
        since: "2026-09-07T00:00:00.000Z",
        until: "2026-10-07T00:00:00.000Z",
        detail_limit: 200,
      }),
    );
  });
  it("advances current, previous and detail calendar windows together across midnight", () => {
    vi.setSystemTime(new Date("2026-10-06T23:59:30.000Z"));
    render(<UsageSection runtime={runtime} />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const params = state.options
      .filter((o) => o.queryKey[0] === "usage-accounting")
      .map((o) => o.queryKey.at(-1));
    expect(params).toContainEqual(
      expect.objectContaining({
        days: 30,
        since: "2026-09-08T00:00:00.000Z",
        until: "2026-10-08T00:00:00.000Z",
      }),
    );
    expect(state.detailParams).toEqual(
      expect.objectContaining({
        since: "2026-09-08T00:00:00.000Z",
        until: "2026-10-08T00:00:00.000Z",
      }),
    );
  });
});
