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
      if (opts?.kind === "usage") {
        const s = usageState.current;
        return {
          data: s.data,
          isLoading: s.isLoading ?? false,
          isError: s.isError ?? false,
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

    // The cost KPI shows "—" (the $0.00 still on screen belongs to the
    // cache-savings card, which is a separate metric).
    expect(screen.getByText("—")).toBeTruthy();
    expect(
      screen.getByText(/No pricing for the models used/),
    ).toBeTruthy();
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
