import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "@multiremi/contracts/usage-accounting";
import locale from "../../locales/en/usage.json";
import { usageMetrics, usageReport } from "../../usage/test-fixtures";
import { DashboardPage } from "./dashboard-page";

const state = vi.hoisted(() => ({
  report: null as UsageReport | null,
  error: false,
  wsId: "ws",
  options: [] as { queryKey: unknown[] }[],
  refetch: vi.fn(),
  agents: [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "unknown", name: "Unknown" },
  ],
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => state.wsId }));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (o: unknown) => o,
  useQuery: (o: { queryKey: unknown[] }) => {
    state.options.push(o);
    const key = o.queryKey[0];
    return key === "usage-accounting"
      ? {
          data: state.report,
          isError: state.error,
          isLoading: false,
          isFetching: false,
          refetch: state.refetch,
        }
      : {
          data:
            key === "workspaces"
              ? state.agents
              : key === "projects"
                ? [{ id: "p", title: "Project", icon: null }]
                : [{ id: "r", name: "Runtime" }],
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
vi.mock("../../runtimes/components/charts/stacked-bar-chart", () => ({
  StackedBarChart: ({ data, series }: { data: unknown; series: string[] }) => (
    <div data-testid="trend" data-series={series.join(",")}>
      {JSON.stringify(data)}
    </div>
  ),
}));
vi.mock("../../runtimes/components/custom-pricing-dialog", () => ({
  UsagePricingDialog: () => <div role="dialog">Prices</div>,
}));
beforeEach(() => {
  state.report = usageReport({
    by_agent: [
      {
        ...usageMetrics({
          actual_total_tokens: 200,
          known_cost_by_currency: { USD: 1 },
          total_seconds: 120,
        }),
        agent_id: "a",
      },
      {
        ...usageMetrics({
          actual_total_tokens: 100,
          known_cost_by_currency: { USD: 5 },
          total_seconds: 300,
        }),
        agent_id: "b",
      },
      {
        ...usageMetrics({
          actual_total_tokens: 0,
          unknown_task_count: 1,
          known_cost_by_currency: {},
          complete: false,
        }),
        agent_id: "unknown",
      },
    ],
  });
});
afterEach(() => {
  cleanup();
  state.error = false;
  state.wsId = "ws";
  state.options = [];
  vi.clearAllMocks();
});

describe("Restored canonical Dashboard", () => {
  it("restores four story KPIs and avatar ranking with metric sorting and proportional bars", () => {
    render(<DashboardPage />);
    expect(screen.getByTestId("token-breakdown")).toHaveTextContent(
      "Input 100 · Output 20 · Cache 15 · Actual unsplit 15",
    );
    const rows = screen.getAllByTestId("leaderboard-row");
    expect(rows[0]).toHaveTextContent("A");
    expect(rows[1]).toHaveTextContent("B");
    expect(rows[2]).toHaveTextContent("Unknown");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByTestId("ranking-bar")).toHaveStyle({
      width: "100%",
    });
    expect(within(rows[1]!).getByTestId("ranking-bar")).toHaveStyle({
      width: "50%",
    });
    expect(within(rows[2]!).queryByTestId("ranking-bar")).toBeNull();
    expect(
      screen.getAllByTestId("avatar").every((n) => n.dataset.hover === "true"),
    ).toBe(true);
    fireEvent.click(
      within(
        screen.getByRole("group", { name: locale.experience.ranking }),
      ).getByRole("button", { name: locale.experience.cost }),
    );
    expect(screen.getAllByTestId("leaderboard-row")[0]).toHaveTextContent("B");
    expect(
      within(screen.getAllByTestId("leaderboard-row")[1]!).getByTestId(
        "ranking-bar",
      ),
    ).toHaveStyle({ width: "20%" });
    expect(
      screen.getByText(`${locale.experience.time} · 30 days`, { selector: "div" }),
    ).toBeVisible();
    expect(
      screen.getByText(`${locale.experience.tasks} · 30 days`, { selector: "div" }),
    ).toBeVisible();
  });
  it("keeps lifecycle trend dates independent of consumption and stacks actual unsplit, never context", () => {
    state.report = usageReport({
      task_daily: [
        {
          date: "2026-10-03",
          task_count: 1,
          total_seconds: 120,
          status_counts: {
            completed: 0,
            failed: 1,
            cancelled: 0,
            active: 0,
            queued: 0,
          },
        },
      ],
    });
    render(<DashboardPage />);
    expect(screen.getByTestId("trend")).toHaveAttribute(
      "data-series",
      "input,output,cacheRead,cacheWrite,unsplit",
    );
    expect(screen.getByTestId("trend")).not.toHaveTextContent("8000");
    fireEvent.click(
      within(screen.getByRole("group", { name: locale.trend.title })).getByRole(
        "button",
        { name: locale.experience.tasks },
      ),
    );
    expect(screen.getByTestId("trend")).toHaveTextContent("2026-10-03");
    expect(screen.getByTestId("trend")).not.toHaveTextContent("2026-10-01");
  });
  it("retains compact project/runtime filters, segmented ranges, all history and resets on workspace switch", async () => {
    const user = userEvent.setup();
    const rendered = render(<DashboardPage />);
    await user.click(
      screen.getByRole("combobox", { name: locale.filter.project }),
    );
    await user.click(screen.getByRole("option", { name: "Project" }));
    expect(state.options.at(-1)?.queryKey).toEqual(
      expect.arrayContaining([expect.objectContaining({ project_id: "p" })]),
    );
    await user.click(
      screen.getByRole("combobox", { name: locale.filter.runtime }),
    );
    await user.click(screen.getByRole("option", { name: "Runtime" }));
    expect(state.options.at(-1)?.queryKey).toEqual(
      expect.arrayContaining([expect.objectContaining({ runtime_id: "r" })]),
    );
    fireEvent.click(screen.getByText(locale.experience.more));
    fireEvent.click(
      screen.getByRole("button", { name: locale.filter.all_history }),
    );
    expect(state.options.at(-1)?.queryKey).toEqual(
      expect.arrayContaining([expect.objectContaining({ days: "all" })]),
    );
    state.wsId = "ws-next";
    rendered.rerender(<DashboardPage />);
    expect(state.options.at(-1)?.queryKey).toEqual(
      expect.arrayContaining([
        "ws-next",
        expect.objectContaining({
          days: 30,
          project_id: null,
          runtime_id: null,
        }),
      ]),
    );
  });
  it("keeps KPI period labels synchronized with daily, annual and full-history controls", () => {
    state.report = usageReport({ summary: usageMetrics({ total_seconds: 12 }) });
    render(<DashboardPage />);
    expect(screen.getByText("Cost · 30 days")).toBeVisible();
    expect(screen.getByText("<1 minute")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(screen.getByText("Cost · 7 days")).toBeVisible();
    expect(screen.getByText("Tokens · 7 days")).toBeVisible();
    fireEvent.click(screen.getByText(locale.experience.more));
    fireEvent.click(screen.getByRole("button", { name: "365d" }));
    expect(screen.getByText("Cost · 365 days")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: locale.filter.all_history }));
    expect(screen.getByText(`Run time · ${locale.filter.all_history}`)).toBeVisible();
    expect(screen.getByText(`Tasks · ${locale.filter.all_history}`)).toBeVisible();
  });
  it("folds source, historical date and estimate diagnostics without adding them to the cost KPI", () => {
    state.report = usageReport({
      summary: usageMetrics({
        known_cost_by_currency: {},
        reference_cost_by_currency: { USD: 1 },
        sdk_estimate_cost_by_currency: { USD: 2 },
        task_attributed_task_count: 1,
        identity_conflict_task_count: 1,
        complete: false,
      }),
    });
    render(<DashboardPage />);
    const summary = screen.getByText(new RegExp(locale.experience.diagnostics));
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
    expect(screen.getByText(locale.summary.historical_date_hint)).toBeVisible();
    expect(
      screen.getByText(locale.summary.identity_conflict_hint),
    ).toBeVisible();
    expect(
      screen.getByText(new RegExp(locale.summary.reference_cost)),
    ).toHaveTextContent("USD 1.00");
    expect(
      screen.getByText(new RegExp(locale.summary.sdk_estimate)),
    ).toHaveTextContent("USD 2.00");
    expect(screen.queryByText("USD 3.00")).toBeNull();
  });
  it("preserves genuine zero while unknown consumption and failed loads never look like zero", () => {
    state.report = usageReport({
      summary: usageMetrics({
        actual_input_tokens: 0,
        actual_output_tokens: 0,
        actual_cache_read_tokens: 0,
        actual_cache_write_tokens: 0,
        actual_unsplit_tokens: 0,
        actual_total_tokens: 0,
        unknown_task_count: 1,
        known_cost_by_currency: {},
        complete: false,
      }),
      daily: [],
    });
    const r = render(<DashboardPage />);
    expect(
      screen.getAllByText(locale.experience.not_collected).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("USD 0.00")).toBeNull();
    state.report = usageReport({
      summary: usageMetrics({
        actual_total_tokens: 0,
        known_cost_by_currency: { USD: 0 },
      }),
    });
    r.rerender(<DashboardPage />);
    expect(screen.getByText("USD 0.00")).toBeVisible();
    state.error = true;
    r.rerender(<DashboardPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(locale.error.body);
    expect(screen.queryByText("USD 0.00")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: locale.error.retry }));
    expect(state.refetch).toHaveBeenCalledOnce();
  });
  it("exports full model groups with distinct connection identity, separate currencies and unknown blanks", async () => {
    state.report = usageReport({
      by_model: [
        {
          ...usageMetrics({ known_cost_by_currency: { USD: 1, EUR: 2 } }),
          provider: "codex",
          model: null,
          requested_model: "saved-model",
          model_source: "requested",
          model_provenance: "session_acknowledged",
          connection_id: "route-a",
          purpose: "agent",
        },
        {
          ...usageMetrics({
            actual_total_tokens: 0,
            unknown_task_count: 1,
            known_cost_by_currency: {},
            complete: false,
          }),
          provider: "codex",
          model: null,
          requested_model: "saved-model",
          model_source: "requested",
          model_provenance: "session_acknowledged",
          connection_id: "route-b",
          purpose: "progress_summary",
        },
      ],
    });
    let blob: Blob | undefined;
    const previousCreate = URL.createObjectURL,
      previousRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((value: Blob | MediaSource) => {
      blob = value as Blob;
      return "blob:test";
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    try {
      render(<DashboardPage />);
      fireEvent.click(screen.getByText(locale.experience.more));
      fireEvent.change(screen.getByLabelText(locale.experience.csv_group), {
        target: { value: "models" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: locale.common.export_csv }),
      );
      expect(blob).toBeDefined();
      expect(click).toHaveBeenCalledOnce();
      const csv = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob!);
      });
      const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('"known_cost_EUR","known_cost_USD"');
      expect(lines[1]).toContain('"route-a"');
      expect(lines[2]).toContain('"route-b"');
      expect(lines[2]).toContain('"progress_summary"');
      expect(lines[2]).toMatch(/,"",""$/);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
    } finally {
      click.mockRestore();
      URL.createObjectURL = previousCreate;
      URL.revokeObjectURL = previousRevoke;
    }
  });
});
