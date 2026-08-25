// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { AgentRuntime } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";

const TEST_RESOURCES = { en: { common: enCommon, runtimes: enRuntimes } };

// ---------------------------------------------------------------------------
// MUL-93 — the runtime usage section must not present "failed to load" as
// "no usage yet", and must not price unpriced tokens at $0.00.
// ---------------------------------------------------------------------------

type QueryState = {
  data?: unknown;
  isLoading?: boolean;
  isError?: boolean;
};

const usageState = vi.hoisted(() => ({ current: {} as QueryState }));
const byAgentState = vi.hoisted(() => ({ current: {} as QueryState }));
const refetchCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../common/use-viewing-timezone", () => ({
  useViewingTimezone: () => "UTC",
}));

vi.mock("@multiremi/core/runtimes/queries", () => ({
  runtimeUsageOptions: () => ({ kind: "usage" as const }),
  runtimeUsageByAgentOptions: () => ({ kind: "by-agent" as const }),
}));

vi.mock("@multiremi/core/workspace/queries", () => ({
  agentListOptions: () => ({ kind: "agents" as const }),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/runtimes/custom-pricing-store", () => {
  const state = { pricings: {} as Record<string, unknown> };
  const useCustomPricingStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { useCustomPricingStore, getCustomPricing: () => undefined };
});

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>(
      "@tanstack/react-query",
    );
  return {
    ...actual,
    useQuery: (opts: { kind?: string }) => {
      const routed =
        opts?.kind === "usage"
          ? usageState.current
          : opts?.kind === "by-agent"
            ? byAgentState.current
            : undefined;
      if (routed) {
        return {
          data: routed.data,
          isLoading: routed.isLoading ?? false,
          isError: routed.isError ?? false,
          refetch: () => {
            refetchCalls.count += 1;
          },
        };
      }
      return { data: [], isLoading: false, isError: false, refetch: () => {} };
    },
  };
});

vi.mock("./charts", () => ({
  DailyCostChart: () => <div data-testid="chart" />,
  DailyTokensChart: () => <div data-testid="chart" />,
  WeeklyCostChart: () => <div data-testid="chart" />,
  WeeklyTokensChart: () => <div data-testid="chart" />,
  ActivityHeatmap: () => <div data-testid="chart" />,
}));

vi.mock("./custom-pricing-dialog", () => ({
  CustomPricingDialog: () => null,
}));

// ActorAvatar drags in workspace member/squad queries irrelevant here.
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="avatar" />,
}));

import { UsageSection } from "./usage-section";

const RUNTIME: AgentRuntime = {
  id: "r-1",
  workspace_id: "ws-1",
  daemon_id: null,
  name: "test-runtime",
  runtime_mode: "cloud",
  provider: "claude",
  launch_header: "",
  status: "online",
  device_info: "",
  metadata: {},
  owner_id: null,
  visibility: "private",
  last_seen_at: null,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

const TODAY = new Date().toISOString().slice(0, 10);

beforeEach(() => {
  refetchCalls.count = 0;
  usageState.current = {};
  byAgentState.current = { data: [] };
  cleanup();
});

describe("UsageSection — fetch failure vs empty (MUL-93)", () => {
  it("shows an error state with retry instead of the empty state", () => {
    usageState.current = { data: undefined, isError: true };
    render(<UsageSection runtime={RUNTIME} />, { wrapper: Wrapper });

    expect(screen.getByText("Usage data unavailable")).toBeTruthy();
    expect(screen.queryByText("No usage data yet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchCalls.count).toBe(1);
  });

  it("still shows the genuine empty state on a successful empty response", () => {
    usageState.current = { data: [] };
    render(<UsageSection runtime={RUNTIME} />, { wrapper: Wrapper });

    expect(screen.getByText("No usage data yet")).toBeTruthy();
    expect(screen.queryByText("Usage data unavailable")).toBeNull();
  });
});

describe("UsageSection — cost without pricing (MUL-93)", () => {
  it("renders — for the cost KPI when all recorded models are unpriced", () => {
    usageState.current = {
      data: [
        {
          runtime_id: "r-1",
          date: TODAY,
          provider: "anthropic",
          model: "totally-unknown-model-xyz",
          input_tokens: 5_000,
          output_tokens: 100,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      ],
    };
    render(<UsageSection runtime={RUNTIME} />, { wrapper: Wrapper });

    // The cost KPI shows "—". The cache-savings card may still show $0.00
    // here because no cache reads were recorded — that zero is a real
    // measurement (see the dedicated cache-read case below).
    expect(screen.getByText("—")).toBeTruthy();
    expect(
      screen.getByText(/No pricing for the models used — cost unavailable/),
    ).toBeTruthy();
  });

  it("renders — for cache savings when unpriced cache reads exist", () => {
    usageState.current = {
      data: [
        {
          runtime_id: "r-1",
          date: TODAY,
          provider: "anthropic",
          model: "totally-unknown-model-xyz",
          input_tokens: 5_000,
          output_tokens: 100,
          cache_read_tokens: 2_000,
          cache_write_tokens: 0,
        },
      ],
    };
    render(<UsageSection runtime={RUNTIME} />, { wrapper: Wrapper });

    // Cost KPI and Cache-savings KPI both show "—": with every model
    // unpriced, neither dollar figure is derivable, and $0.00 anywhere
    // would be fabricated.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(
      screen.getByText(/savings can't be calculated/),
    ).toBeTruthy();
  });

  it("keeps a real $0.00 cache savings when all cache reads are priced (free tier) despite an unpriced input-only model", () => {
    // QA round-2 minimal repro: glm-4.7-flash is priced with every rate at
    // 0, so its cache-read savings are genuinely $0.00. The unpriced model
    // contributed NO cache reads, so it must not flip cache savings to
    // "—" — only the Cost KPI (which its input tokens do pollute) may.
    usageState.current = {
      data: [
        {
          runtime_id: "r-1",
          date: TODAY,
          provider: "zai",
          model: "glm-4.7-flash",
          input_tokens: 10_000,
          output_tokens: 500,
          cache_read_tokens: 2_000,
          cache_write_tokens: 0,
        },
        {
          runtime_id: "r-1",
          date: TODAY,
          provider: "anthropic",
          model: "totally-unknown-model-xyz",
          input_tokens: 5_000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      ],
    };
    render(<UsageSection runtime={RUNTIME} />, { wrapper: Wrapper });

    // Cache savings: real $0.00 (all cache reads priced at a real rate of 0).
    expect(screen.getByText("$0.00")).toBeTruthy();
    expect(screen.queryByText(/savings can't be calculated/)).toBeNull();
    // Cost: unpriced input tokens contributed → genuinely underivable.
    expect(screen.getByText("—")).toBeTruthy();
    expect(
      screen.getByText(/No pricing for the models used — cost unavailable/),
    ).toBeTruthy();
  });

  it("keeps a real $0.00 cost when the only unpriced model is a zero-token row", () => {
    // A zero-token unpriced entry (the server does not drop all-zero usage
    // entries) must not poison the free-tier model's real $0.00.
    usageState.current = {
      data: [
        {
          runtime_id: "r-1",
          date: TODAY,
          provider: "zai",
          model: "glm-4.7-flash",
          input_tokens: 10_000,
          output_tokens: 500,
          cache_read_tokens: 2_000,
          cache_write_tokens: 0,
        },
        {
          runtime_id: "r-1",
          date: TODAY,
          provider: "anthropic",
          model: "totally-unknown-model-xyz",
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      ],
    };
    render(<UsageSection runtime={RUNTIME} />, { wrapper: Wrapper });

    // Cost KPI and cache-savings KPI both show the real $0.00; nothing on
    // the page claims unavailability.
    expect(screen.getAllByText("$0.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("—")).toBeNull();
  });

  it("keeps a priced $0-free window rendering the real dollar figure", () => {
    usageState.current = {
      data: [
        {
          runtime_id: "r-1",
          date: TODAY,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      ],
    };
    render(<UsageSection runtime={RUNTIME} />, { wrapper: Wrapper });

    expect(screen.getByText("$3.00")).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
  });
});

describe("UsageSection — Cost-by block honesty (MUL-93)", () => {
  const PRICED_USAGE_ROW = {
    runtime_id: "r-1",
    date: TODAY,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  it("shows an error with retry when the by-agent fetch fails", () => {
    usageState.current = { data: [PRICED_USAGE_ROW] };
    byAgentState.current = { data: undefined, isError: true };
    render(<UsageSection runtime={RUNTIME} />, { wrapper: Wrapper });

    // The by-agent tab must not read as "no usage in this period".
    expect(
      screen.getByText(/Usage data failed to load/),
    ).toBeTruthy();
    const before = refetchCalls.count;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchCalls.count).toBe(before + 1);
  });

  it("renders — instead of $0.00 for an agent whose tokens are all unpriced", () => {
    usageState.current = { data: [PRICED_USAGE_ROW] };
    byAgentState.current = {
      data: [
        {
          agent_id: "agent-unpriced",
          model: "totally-unknown-model-xyz",
          input_tokens: 9_000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          task_count: 1,
        },
      ],
    };
    render(<UsageSection runtime={RUNTIME} />, { wrapper: Wrapper });

    // The agent's row shows its real token count, and the page's only "—"
    // is that row's cost cell (the KPI row is fully priced here; the
    // cache-savings KPI legitimately shows $0.00 because no cache reads
    // were recorded — a real measurement).
    expect(screen.getByText("9K")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });
});
