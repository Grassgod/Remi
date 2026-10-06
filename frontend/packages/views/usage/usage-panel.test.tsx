import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "@multiremi/contracts/usage-accounting";
import locale from "../locales/en/usage.json";
import { usageMetrics, usageReport } from "./test-fixtures";
import { UsagePanel } from "./usage-panel";

const state = vi.hoisted(() => ({ report: null as UsageReport | null, error: false, refetch: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ queryOptions: (options: unknown) => options, useQuery: (options: { queryKey: readonly unknown[] }) => options.queryKey[0] === "usage-accounting"
  ? { data: state.report, isError: state.error, isLoading: false, isFetching: false, refetch: state.refetch }
  : { data: [], isError: false, isLoading: false } }));
vi.mock("../i18n", () => ({ useT: () => ({ t: (selector: (value: typeof locale) => string) => selector(locale) }) }));
vi.mock("../common/use-viewing-timezone", () => ({ useViewingTimezone: () => "UTC" }));
vi.mock("../runtimes/components/charts/stacked-bar-chart", () => ({ StackedBarChart: ({ data }: { data: unknown }) => <div data-testid="trend">{JSON.stringify(data)}</div> }));
vi.mock("../runtimes/components/custom-pricing-dialog", () => ({ UsagePricingDialog: ({ initial }: { initial: unknown }) => <div role="dialog">{JSON.stringify(initial)}</div> }));
afterEach(() => { cleanup(); state.error = false; state.report = null; vi.clearAllMocks(); });

describe("Unified usage panel", () => {
  it("shows unallocated multi-model charges without displaying a model's missing amount as zero", () => {
    state.report = usageReport({ by_model: [
      { ...usageMetrics({ known_cost_by_currency: {}, cost_allocation_complete: false, complete: false }), provider: "claude", model: "opus", requested_model: null, model_source: "reported", model_provenance: "provider_reported", connection_id: null },
      { ...usageMetrics({ actual_input_tokens: 0, actual_output_tokens: 0, actual_total_tokens: 0, priced_tokens: 0, known_cost_by_currency: { USD: 0.25 }, cost_allocation_complete: false, complete: false }), provider: "claude", model: null, requested_model: null, model_source: "unknown", model_provenance: "unallocated_cost", connection_id: null },
    ] });
    render(<UsagePanel wsId="ws" />);
    fireEvent.click(screen.getByRole("button", { name: locale.views.models }));
    const modelRow = screen.getByText("claude · opus").closest("tr")!;
    expect(within(modelRow).getAllByText("—").length).toBeGreaterThan(0);
    expect(within(modelRow).queryByText("USD 0.00")).toBeNull();
    expect(screen.getAllByText(locale.price.allocation_unknown).length).toBe(2);
    expect(screen.getByText(`claude · ${locale.price.unallocated_cost}`)).toBeVisible();
    expect(within(screen.getByRole("table")).getByText("USD 0.25")).toBeVisible();
  });
  it("keeps published references and SDK estimates separate from known subtotals", () => {
    state.report = usageReport({ summary: usageMetrics({ known_cost_by_currency: {}, reference_cost_by_currency: { USD: 1 }, sdk_estimate_cost_by_currency: { USD: 2 }, priced_tokens: 0, unpriced_tokens: 150, complete: false }) });
    render(<UsagePanel wsId="ws" />);
    expect(screen.getByText(locale.summary.reference_cost)).toBeVisible();
    expect(screen.getByText(locale.summary.sdk_estimate)).toBeVisible();
    expect(screen.getByText("USD 1.00")).toBeVisible();
    expect(screen.getByText("USD 2.00")).toBeVisible();
    expect(screen.queryByText("USD 3.00")).toBeNull();
  });
  it("retains historical requested models with an explicit actual-model uncertainty label", () => {
    state.report = usageReport({ by_model: [{ ...usageMetrics(), provider: "codex", model: null, requested_model: "retired-gpt", model_source: "requested", model_provenance: "session_acknowledged", connection_id: "old-connection" }] });
    render(<UsagePanel wsId="ws" />);
    fireEvent.click(screen.getByRole("button", { name: locale.views.models }));
    expect(screen.getByText("codex · retired-gpt")).toBeVisible();
    expect(screen.getByText(locale.price.requested_model)).toBeVisible();
    expect(screen.getByText("old-connection")).toBeVisible();
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: locale.price.open }));
    expect(screen.getByRole("dialog")).toHaveTextContent('"requested_model_alias":true');
  });
  it("keeps task lifecycle trends independent of consumption dates", () => {
    state.report = usageReport({ task_daily: [{ date: "2026-10-03", task_count: 1, total_seconds: 120, status_counts: { completed: 0, failed: 1, cancelled: 0, active: 0, queued: 0 } }] });
    render(<UsagePanel wsId="ws" />);
    fireEvent.change(screen.getByLabelText(locale.trend.title), { target: { value: "tasks" } });
    expect(screen.getByTestId("trend")).toHaveTextContent("2026-10-03");
    expect(screen.getByTestId("trend")).not.toHaveTextContent("2026-10-01");
    expect(screen.getByRole("button", { name: locale.common.export_csv })).toBeVisible();
  });
  it("shows unknown actual consumption without replacing it with zero or context occupancy", () => {
    const unknown = usageMetrics({ actual_input_tokens: 0, actual_output_tokens: 0, actual_cache_read_tokens: 0, actual_cache_write_tokens: 0, actual_unsplit_tokens: 0, actual_total_tokens: 0, priced_tokens: 0, unpriced_tokens: 0, unknown_task_count: 1, known_cost_by_currency: {}, complete: false });
    state.report = usageReport({ summary: unknown, daily: [{ ...unknown, date: "2026-10-01" }] });
    render(<UsagePanel wsId="ws" />);
    expect(screen.getByText(locale.trend.unknown)).toBeVisible();
    expect(within(screen.getByRole("table")).getAllByText("—")).toHaveLength(8);
    expect(screen.getByText(locale.summary.context_hint)).toBeVisible();
  });
  it("renders a retryable failure without successful-looking zero totals", () => {
    state.error = true;
    render(<UsagePanel wsId="ws" />);
    expect(screen.getByRole("alert")).toHaveTextContent(locale.error.body);
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: locale.error.retry }));
    expect(state.refetch).toHaveBeenCalledOnce();
  });
});
