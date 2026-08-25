// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, cleanup } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";

// ---------------------------------------------------------------------------
// MUL-93 — the usage dashboard must keep four states distinguishable:
//   1. normal values           → real numbers render;
//   2. real zero               → all series succeeded and empty: explicit
//                                "no usage yet, zeros are real" empty state;
//   3. missing / not collected → tasks ran but no token usage recorded:
//                                "—" + reason, never 0 / $0.00;
//   4. fetch failure           → error state with a retry entry point,
//                                never a silent fall-through to zeros.
// Plus: cost with unpriced models renders "—", not a fabricated $0.00.
// ---------------------------------------------------------------------------

type QueryState = {
  data?: unknown;
  isLoading?: boolean;
  isError?: boolean;
  isSuccess?: boolean;
};

const queryStates = vi.hoisted(() => new Map<string, QueryState>());
const refetchCalls = vi.hoisted(() => [] as string[]);

// Each dashboard query-options builder is mocked to a `{kind}` tag; the
// useQuery mock routes the canned per-kind state and records refetches.
vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>(
      "@tanstack/react-query",
    );
  return {
    ...actual,
    useQuery: (opts: { kind?: string }) => {
      const kind = opts?.kind ?? "unknown";
      const state = queryStates.get(kind) ?? { data: [], isSuccess: true };
      const isLoading = state.isLoading ?? false;
      const isError = state.isError ?? false;
      return {
        data: state.data,
        isLoading,
        isError,
        isSuccess: state.isSuccess ?? (!isLoading && !isError),
        refetch: () => {
          refetchCalls.push(kind);
        },
      };
    },
  };
});

vi.mock("@multiremi/core/dashboard", () => ({
  dashboardUsageDailyOptions: () => ({ kind: "daily" }),
  dashboardUsageByAgentOptions: () => ({ kind: "by-agent" }),
  dashboardAgentRunTimeOptions: () => ({ kind: "agent-runtime" }),
  dashboardRunTimeDailyOptions: () => ({ kind: "runtime-daily" }),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/workspace/queries", () => ({
  agentListOptions: () => ({ kind: "agents" }),
}));

vi.mock("@multiremi/core/projects/queries", () => ({
  projectListOptions: () => ({ kind: "projects" }),
}));

vi.mock("@multiremi/core/runtimes/custom-pricing-store", () => {
  const state = { pricings: {} as Record<string, unknown> };
  const useCustomPricingStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { useCustomPricingStore, getCustomPricing: () => undefined };
});

vi.mock("../../common/use-viewing-timezone", () => ({
  useViewingTimezone: () => "UTC",
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="avatar" />,
}));

// Charts are recharts-heavy; the states under test live outside them.
vi.mock("../../runtimes/components/charts", () => ({
  DailyCostChart: () => <div data-testid="chart" />,
  DailyTokensChart: () => <div data-testid="chart" />,
  DailyTimeChart: () => <div data-testid="chart" />,
  DailyTasksChart: () => <div data-testid="chart" />,
  WeeklyCostChart: () => <div data-testid="chart" />,
  WeeklyTokensChart: () => <div data-testid="chart" />,
  WeeklyTimeChart: () => <div data-testid="chart" />,
  WeeklyTasksChart: () => <div data-testid="chart" />,
}));

// The pricing-gap banner has its own tests on the runtime page; stub it so
// this suite doesn't drag the whole usage-section module graph in.
vi.mock("../../runtimes/components/usage-section", () => ({
  UnmappedPricingNotice: () => null,
}));

import { DashboardPage } from "./dashboard-page";

const TODAY = new Date().toISOString().slice(0, 10);

function usageRow(overrides: Record<string, unknown> = {}) {
  return {
    date: TODAY,
    model: "claude-sonnet-4-6",
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    task_count: 2,
    ...overrides,
  };
}

const RUN_TIME_ROW = {
  agent_id: "agent-1",
  total_seconds: 600,
  task_count: 2,
  failed_count: 0,
};

const RUN_TIME_DAILY_ROW = {
  date: TODAY,
  total_seconds: 600,
  task_count: 2,
  failed_count: 0,
};

const KINDS = ["daily", "by-agent", "agent-runtime", "runtime-daily"] as const;

function setStates(overrides: Partial<Record<string, QueryState>> = {}) {
  queryStates.clear();
  for (const kind of [...KINDS, "agents", "projects"]) {
    queryStates.set(kind, { data: [], isSuccess: true });
  }
  for (const [kind, state] of Object.entries(overrides)) {
    queryStates.set(kind, state!);
  }
}

beforeEach(() => {
  refetchCalls.length = 0;
  cleanup();
});

describe("DashboardPage — normal values", () => {
  it("renders real measurements for all four KPIs", () => {
    setStates({
      daily: { data: [usageRow()] },
      "by-agent": { data: [usageRow({ agent_id: "agent-1" })] },
      "agent-runtime": { data: [RUN_TIME_ROW] },
      "runtime-daily": { data: [RUN_TIME_DAILY_ROW] },
    });
    renderWithI18n(<DashboardPage />);

    // claude-sonnet-4-6 input: 1M × $3/M = $3.00. Values appear in the KPI
    // row and again in the leaderboard, so assert presence, not uniqueness.
    expect(screen.getAllByText("$3.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("1M").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("10m").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Across 2 tasks")).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
  });
});

describe("DashboardPage — real zero", () => {
  it("shows the empty state and says the zeros are real", () => {
    setStates(); // all series succeed with empty arrays
    renderWithI18n(<DashboardPage />);

    expect(screen.getByText("No usage yet")).toBeTruthy();
    expect(
      screen.getByText(/so these zeros are real measurements/),
    ).toBeTruthy();
    // The KPI tiles still render their genuine zeros alongside the
    // explainer — a real zero is DISPLAYED, not just described.
    expect(screen.getByText("$0.00")).toBeTruthy();
    expect(screen.getByText("0m")).toBeTruthy();
    // Tokens KPI and Tasks KPI both render a genuine "0".
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("No tasks in this window").length).toBe(2);
    expect(screen.queryByText("—")).toBeNull();
  });

  it("renders 0 tasks as a measurement when only usage exists elsewhere", () => {
    // Tokens exist (in-flight tasks) but no terminal runs: the run-time and
    // tasks KPIs are genuinely 0 and must say "no tasks", not "<1m across
    // 0 tasks".
    setStates({
      daily: { data: [usageRow()] },
      "by-agent": { data: [usageRow({ agent_id: "agent-1" })] },
    });
    renderWithI18n(<DashboardPage />);

    expect(screen.getByText("0m")).toBeTruthy();
    expect(screen.getAllByText("No tasks in this window").length).toBe(2);
    // The old fabricated caption must be gone.
    expect(screen.queryByText(/Across 0 tasks/)).toBeNull();
  });
});

describe("DashboardPage — usage missing / not collected", () => {
  it("renders — with a reason instead of 0 tokens / $0.00 when tasks ran", () => {
    setStates({
      "agent-runtime": {
        data: [{ ...RUN_TIME_ROW, task_count: 3, failed_count: 1 }],
      },
      "runtime-daily": {
        data: [{ ...RUN_TIME_DAILY_ROW, task_count: 3, failed_count: 1 }],
      },
    });
    renderWithI18n(<DashboardPage />);

    // Cost KPI, Tokens KPI, and the leaderboard token + cost cells all
    // show "—" (4 placeholders).
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
    expect(
      screen.getAllByText(/3 tasks ran, but no token usage was recorded/)
        .length,
    ).toBeGreaterThanOrEqual(1);
    // No fabricated $0.00 anywhere, and no fabricated 0-token cell — the
    // leaderboard row for the agent that ran 3 tasks must not claim a
    // measured "0" tokens.
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
    // Tasks KPI still shows the real count.
    expect(screen.getByText("1 failed")).toBeTruthy();
  });
});

describe("DashboardPage — fetch failure", () => {
  it("shows a full error state with retry when every series fails", () => {
    setStates({
      daily: { data: undefined, isError: true, isSuccess: false },
      "by-agent": { data: undefined, isError: true, isSuccess: false },
      "agent-runtime": { data: undefined, isError: true, isSuccess: false },
      "runtime-daily": { data: undefined, isError: true, isSuccess: false },
    });
    renderWithI18n(<DashboardPage />);

    expect(screen.getByText("Usage data unavailable")).toBeTruthy();
    // Never mistaken for the empty state.
    expect(screen.queryByText("No usage yet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect([...refetchCalls].sort()).toEqual(
      ["agent-runtime", "by-agent", "daily", "runtime-daily"].sort(),
    );
  });

  it("keeps loaded series and marks failed ones — on partial failure", () => {
    setStates({
      daily: { data: undefined, isError: true, isSuccess: false },
      "agent-runtime": { data: [RUN_TIME_ROW] },
      "runtime-daily": { data: [RUN_TIME_DAILY_ROW] },
    });
    renderWithI18n(<DashboardPage />);

    // Banner names the situation and owns retry.
    expect(
      screen.getByText(/Some usage series failed to load/),
    ).toBeTruthy();
    // Failed token series → "—", loaded run-time series → real values.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("10m").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText(/Failed to load — value unavailable, not zero/)
        .length,
    ).toBeGreaterThanOrEqual(2);

    // Two retry entry points exist here (the banner and the failed trend
    // chart placeholder) — either must refetch only the failed series.
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
    expect(refetchCalls).toEqual(["daily"]);
  });
});

describe("DashboardPage — leaderboard partial failure", () => {
  it("shows the failure instead of 'no agent activity' when one source failed and the other is empty", () => {
    setStates({
      "by-agent": { data: undefined, isError: true, isSuccess: false },
      // agent-runtime succeeds but has no rows — the failed by-agent
      // series may hold the missing agents, so "no agent activity" would
      // be a fabricated conclusion.
    });
    renderWithI18n(<DashboardPage />);

    expect(
      screen.getByText(/Leaderboard data failed to load/),
    ).toBeTruthy();
    expect(screen.queryByText("No agent activity in this window.")).toBeNull();
  });
});

describe("DashboardPage — cost without pricing", () => {
  it("renders — for cost when tokens exist but no model is priced", () => {
    setStates({
      daily: {
        data: [usageRow({ model: "totally-unknown-model-xyz", input_tokens: 5_000 })],
      },
      "by-agent": {
        data: [
          usageRow({
            agent_id: "agent-1",
            model: "totally-unknown-model-xyz",
            input_tokens: 5_000,
          }),
        ],
      },
      "agent-runtime": { data: [RUN_TIME_ROW] },
      "runtime-daily": { data: [RUN_TIME_DAILY_ROW] },
    });
    renderWithI18n(<DashboardPage />);

    // Tokens are real and render; cost is underivable and must not be $0.00.
    expect(screen.getAllByText("5K").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByText(/No pricing for the models used/).length,
    ).toBeGreaterThanOrEqual(1);
  });
});
