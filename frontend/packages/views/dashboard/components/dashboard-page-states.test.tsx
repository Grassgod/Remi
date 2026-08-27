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

// Keep UsageDiagnosticsNotice real so dashboard-specific filtering is covered.
// The dialog itself is outside this suite's scope and need not mount its form.
vi.mock("../../runtimes/components/custom-pricing-dialog", () => ({
  CustomPricingDialog: () => null,
}));

import { useUsageDiagnosticsStore } from "@multiremi/core/runtimes/usage-diagnostics-store";
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
    total_tokens: 1_000_000,
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
  // The diagnostics strip's collapse state is a persisted global store, so
  // one test expanding it would leak into the next — through memory and
  // through localStorage.
  localStorage.clear();
  useUsageDiagnosticsStore.setState({ expanded: false });
  cleanup();
});

// A model the shipped table deliberately has no row for. `gpt-5.5-mini` is
// the resolver's own worked example of why there is no startsWith fallback:
// it must NOT inherit `gpt-5.5`'s rate. Using a real catalog SKU here would
// make these tests fail the moment that SKU gets a published price.
const UNPRICED_MODEL = "gpt-5.5-mini";

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
    expect(
      screen.getByText("Input 1M · Output 0 · Cache read 0 · Cache write 0"),
    ).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("shows total-only history without fabricating a cost", () => {
    const totalOnly = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 5_181_880,
      task_count: 27,
    };
    setStates({
      daily: { data: [usageRow(totalOnly)] },
      "by-agent": {
        data: [usageRow({ ...totalOnly, agent_id: "agent-1" })],
      },
      "agent-runtime": {
        data: [{ ...RUN_TIME_ROW, task_count: 27 }],
      },
      "runtime-daily": {
        data: [{ ...RUN_TIME_DAILY_ROW, task_count: 27 }],
      },
    });
    renderWithI18n(<DashboardPage />);

    expect(screen.getAllByText("5.2M").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("~5.2M")).toBeTruthy();
    // Collapsed by default (MUL-168): the summary line still names the
    // reason, and the full sentence is one click away.
    expect(
      screen.getByText(/5.2M historical tokens with no input\/output split/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText(/5.2M tokens recorded by older runtimes have totals only/)).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the total-only explanation reachable after collapsing, and the KPIs honest", () => {
    // The notice has no remedy — those rows were persisted without the
    // input/output dimension — so it must get out of the way instead of
    // nagging forever. MUL-164 did that with a one-way dismiss; MUL-168
    // makes it a collapse, because a user who reads "some tokens aren't
    // costed" a week later needs a way back to the reason (acceptance
    // criterion 4). Either way it is a display decision only: the tokens
    // still count toward volume and the cost tile still refuses to
    // fabricate a number.
    const totalOnly = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 5_181_880,
      task_count: 27,
    };
    setStates({
      daily: { data: [usageRow(totalOnly)] },
      "by-agent": {
        data: [usageRow({ ...totalOnly, agent_id: "agent-1" })],
      },
      "agent-runtime": { data: [{ ...RUN_TIME_ROW, task_count: 27 }] },
      "runtime-daily": { data: [{ ...RUN_TIME_DAILY_ROW, task_count: 27 }] },
    });
    renderWithI18n(<DashboardPage />);

    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(
      screen.getByText(/5.2M tokens recorded by older runtimes have totals only/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Hide/ }));
    expect(
      screen.queryByText(/5.2M tokens recorded by older runtimes have totals only/),
    ).toBeNull();
    expect(useUsageDiagnosticsStore.getState().expanded).toBe(false);

    // The way back: the collapsed strip still names the reason, and the
    // trigger is still there.
    expect(
      screen.getByText(/5.2M historical tokens with no input\/output split/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(
      screen.getByText(/5.2M tokens recorded by older runtimes have totals only/),
    ).toBeTruthy();

    expect(screen.getAllByText("5.2M").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("does not offer custom pricing for total-only usage on an unpriced model", () => {
    const totalOnly = {
      model: UNPRICED_MODEL,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 5_181_880,
      task_count: 27,
    };
    setStates({
      daily: { data: [usageRow(totalOnly)] },
      "by-agent": {
        data: [usageRow({ ...totalOnly, agent_id: "agent-1" })],
      },
      "agent-runtime": {
        data: [{ ...RUN_TIME_ROW, task_count: 27 }],
      },
      "runtime-daily": {
        data: [{ ...RUN_TIME_DAILY_ROW, task_count: 27 }],
      },
    });
    renderWithI18n(<DashboardPage />);

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      screen.getByText(/5.2M historical tokens with no input\/output split/),
    ).toBeTruthy();
    expect(screen.queryByText(/model without a price/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText(/5.2M tokens recorded by older runtimes have totals only/)).toBeTruthy();
    expect(screen.queryByText(/model has no maintained price/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Set custom prices" })).toBeNull();
  });

  it("keeps both reasons when an unpriced model has split and total-only usage", () => {
    const totalOnly = usageRow({
      model: UNPRICED_MODEL,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 5_181_880,
      task_count: 27,
    });
    const split = usageRow({
      model: UNPRICED_MODEL,
      input_tokens: 536,
      output_tokens: 174_228,
      cache_read_tokens: 24_578_049,
      cache_write_tokens: 763_702,
      total_tokens: 26_179_959,
      task_count: 12,
    });
    setStates({
      daily: { data: [totalOnly, split] },
      "by-agent": {
        data: [
          { ...totalOnly, agent_id: "agent-1" },
          { ...split, agent_id: "agent-1" },
        ],
      },
      "agent-runtime": {
        data: [{ ...RUN_TIME_ROW, task_count: 39 }],
      },
      "runtime-daily": {
        data: [{ ...RUN_TIME_DAILY_ROW, task_count: 39 }],
      },
    });
    renderWithI18n(<DashboardPage />);

    // One strip, two reasons — before MUL-168 these were two stacked banners
    // that between them owned the whole first screen.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      screen.getByText(
        /1 model without a price · 5.2M historical tokens with no input\/output split/,
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText(/5.2M tokens recorded by older runtimes have totals only/)).toBeTruthy();
    expect(screen.getByText(/1 model has no maintained price/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set custom prices" })).toBeTruthy();
  });

  it("persists the open/closed choice across a page reload", async () => {
    setStates({
      daily: { data: [usageRow({ model: UNPRICED_MODEL })] },
      "by-agent": {
        data: [usageRow({ model: UNPRICED_MODEL, agent_id: "agent-1" })],
      },
    });
    renderWithI18n(<DashboardPage />);

    // Collapsed on arrival — the KPI tiles, not the diagnostic, own the
    // first screen (MUL-168 acceptance criterion 3).
    expect(screen.queryByText(/1 model has no maintained price/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText(/1 model has no maintained price/)).toBeTruthy();
    expect(localStorage.getItem("multimira_usage_diagnostics")).toContain(
      '"expanded":true',
    );

    fireEvent.click(screen.getByRole("button", { name: /Hide/ }));
    const persisted = localStorage.getItem("multimira_usage_diagnostics") ?? "";
    expect(persisted).toContain('"expanded":false');

    // Simulate the reload the acceptance criterion is about: dirty the
    // in-memory copy, put back what was on disk, rehydrate, mount again.
    cleanup();
    useUsageDiagnosticsStore.setState({ expanded: true });
    localStorage.setItem("multimira_usage_diagnostics", persisted);
    await useUsageDiagnosticsStore.persist.rehydrate();
    renderWithI18n(<DashboardPage />);

    expect(screen.getByText(/1 model without a price/)).toBeTruthy();
    expect(screen.queryByText(/1 model has no maintained price/)).toBeNull();
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

  it("keeps a real $0.00 cost when unpriced models contributed no tokens", () => {
    // QA round-2 repro: a free-tier priced model (every rate 0) with real
    // tokens plus a zero-token unpriced row. Cost is genuinely $0.00 —
    // presence of an unpriced model name alone must not flip it to "—".
    setStates({
      daily: {
        data: [
          usageRow({ model: "glm-4.7-flash", input_tokens: 10_000 }),
          usageRow({
            model: "totally-unknown-model-xyz",
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total_tokens: 0,
            task_count: 0,
          }),
        ],
      },
      "by-agent": {
        data: [usageRow({ agent_id: "agent-1", model: "glm-4.7-flash", input_tokens: 10_000 })],
      },
      "agent-runtime": { data: [RUN_TIME_ROW] },
      "runtime-daily": { data: [RUN_TIME_DAILY_ROW] },
    });
    renderWithI18n(<DashboardPage />);

    expect(screen.getAllByText("$0.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/No pricing for the models used/)).toBeNull();
  });
});
