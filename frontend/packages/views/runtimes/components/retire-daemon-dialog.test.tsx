// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { DaemonRetirementPlan } from "@multiremi/core/runtimes";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";

const { fetchPlan, retireDaemon } = vi.hoisted(() => ({
  fetchPlan: vi.fn(),
  retireDaemon: vi.fn(),
}));

vi.mock("@multiremi/core/runtimes", async () => {
  const actual =
    await vi.importActual<typeof import("@multiremi/core/runtimes")>(
      "@multiremi/core/runtimes",
    );
  return {
    ...actual,
    daemonRetirementPlanOptions: (wsId: string, daemonId: string) => ({
      queryKey: ["retirement-plan", wsId, daemonId],
      queryFn: () => fetchPlan(),
    }),
    useRetireDaemon: () => ({ mutateAsync: retireDaemon, isPending: false }),
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("./provider-logo", () => ({ ProviderLogo: () => null }));

import { RetireDaemonDialog } from "./retire-daemon-dialog";

const resources = {
  en: { common: enCommon, runtimes: enRuntimes },
};

function makePlan(overrides: Partial<DaemonRetirementPlan> = {}): DaemonRetirementPlan {
  return {
    workspace_id: "ws-1",
    daemon_id: "daemon-1",
    snapshot: "snapshot-1",
    already_retired: false,
    can_retire: true,
    can_abandon_issue_workspaces: false,
    blocking_reasons: [],
    runtimes: [
      { id: "runtime-1", name: "Claude host", provider: "claude", status: "online" },
    ],
    agents: [],
    active_tasks: [],
    queued_tasks: [],
    local_directory_resources: [],
    issue_workspaces: [],
    impact: {
      runtimes_removed: 1,
      agents_detached: 0,
      queued_tasks_requeued: 0,
      session_lanes_reset: 0,
      chat_sessions_reset: 0,
      issue_workspaces_abandoned: 0,
      tokens_revoked: 1,
    },
    ...overrides,
  };
}

function renderDialog(onRetired = vi.fn(), daemonId = "daemon-1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <I18nProvider locale="en" resources={resources}>
      <QueryClientProvider client={queryClient}>
        <RetireDaemonDialog
          open
          onOpenChange={vi.fn()}
          wsId="ws-1"
          daemonId={daemonId}
          machineName="Build host"
          onRetired={onRetired}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { onRetired, queryClient };
}

describe("RetireDaemonDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retireDaemon.mockResolvedValue({
      status: "retired",
      workspace_id: "ws-1",
      daemon_id: "daemon-1",
      retired_at: "2026-08-16T00:00:00.000Z",
      already_retired: false,
      impact: makePlan().impact,
    });
  });

  it("requires explicit acknowledgement before retiring the daemon", async () => {
    fetchPlan.mockResolvedValue(makePlan());
    const { onRetired } = renderDialog();

    const dialog = await screen.findByRole("alertdialog", {
      name: "Deactivate and remove this daemon?",
    });
    expect(dialog).toHaveAccessibleDescription(/remove every runtime it hosts/);
    expect(dialog).toHaveClass("z-[60]");
    expect(
      document.querySelector('[data-slot="alert-dialog-overlay"]'),
    ).toHaveClass("z-[60]");

    const submit = await screen.findByRole("button", {
      name: "Deactivate and remove",
    });
    expect(submit).toBeDisabled();

    fireEvent.click(
      await screen.findByText(/I understand this daemon ID and its access tokens/),
    );
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(retireDaemon).toHaveBeenCalledWith({
        daemonId: "daemon-1",
        expectedSnapshot: "snapshot-1",
        abandonIssueWorkspaces: false,
      });
      expect(onRetired).toHaveBeenCalledTimes(1);
    });
  });

  it("shows the complete daemon ID even when the machine title is shortened", async () => {
    const daemonId = "daemon-token-only-1234567890abcdef";
    fetchPlan.mockResolvedValue(makePlan({ daemon_id: daemonId }));
    renderDialog(vi.fn(), daemonId);

    const identity = await screen.findByText(daemonId);
    expect(identity).toBeInTheDocument();
    expect(identity.tagName).toBe("CODE");
  });

  it("clears acknowledgement when a refetch returns a new plan snapshot", async () => {
    fetchPlan
      .mockResolvedValueOnce(makePlan({ snapshot: "snapshot-a" }))
      .mockResolvedValueOnce(makePlan({ snapshot: "snapshot-b" }));
    const { queryClient } = renderDialog();

    const acknowledge = await screen.findByRole("checkbox");
    const submit = screen.getByRole("button", {
      name: "Deactivate and remove",
    });
    fireEvent.click(acknowledge);

    expect(acknowledge).toBeChecked();
    expect(submit).toBeEnabled();

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ["retirement-plan", "ws-1", "daemon-1"],
      });
    });

    await waitFor(() => expect(fetchPlan).toHaveBeenCalledTimes(2));
    expect(acknowledge).not.toBeChecked();
    expect(submit).toBeDisabled();
  });

  it("does not report success for a mismatched retirement response", async () => {
    fetchPlan.mockResolvedValue(makePlan());
    retireDaemon.mockResolvedValue({
      status: "retired",
      workspace_id: "ws-1",
      daemon_id: "another-daemon",
      retired_at: "2026-08-16T00:00:00.000Z",
      already_retired: false,
      impact: makePlan().impact,
    });
    const { onRetired } = renderDialog();

    fireEvent.click(
      await screen.findByText(/I understand this daemon ID and its access tokens/),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Deactivate and remove" }),
    );

    await waitFor(() => expect(retireDaemon).toHaveBeenCalledTimes(1));
    expect(onRetired).not.toHaveBeenCalled();
  });

  it("renders blockers and never enables the destructive action", async () => {
    fetchPlan.mockResolvedValue(
      makePlan({
        can_retire: false,
        can_abandon_issue_workspaces: true,
        blocking_reasons: ["active_tasks"],
        active_tasks: [
          {
            id: "task-1",
            status: "running",
            agent_id: "agent-1",
            runtime_id: "runtime-1",
            issue_id: "issue-1",
          },
        ],
      }),
    );
    renderDialog();

    expect(await screen.findByText("1 task is still running")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Deactivate and remove" }),
    ).toBeDisabled();
    expect(
      screen.queryByText(/I understand this daemon ID/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("issue-1")).toBeInTheDocument();
  });

  it("can explicitly abandon stale issue workspaces for an offline daemon", async () => {
    fetchPlan.mockResolvedValue(
      makePlan({
        can_retire: false,
        can_abandon_issue_workspaces: true,
        blocking_reasons: ["active_issue_workspaces"],
        issue_workspaces: [{
          issue_id: "issue-stale",
          status: "runtime_offline",
          runtime_id: "runtime-1",
          root_path: "/work/stale",
        }],
      }),
    );
    renderDialog();

    const submit = await screen.findByRole("button", {
      name: "Deactivate and remove",
    });
    expect(submit).toBeDisabled();
    fireEvent.click(await screen.findByRole("checkbox", {
      name: /Abandon these issue workspace records/,
    }));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByText(/I understand this daemon ID and its access tokens/));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(retireDaemon).toHaveBeenCalledWith({
      daemonId: "daemon-1",
      expectedSnapshot: "snapshot-1",
      abandonIssueWorkspaces: true,
    }));
  });

  it("rejects a conflict plan for another daemon", async () => {
    fetchPlan.mockResolvedValue(makePlan());
    retireDaemon.mockRejectedValue(
      new (await import("@multiremi/core/api")).ApiError(
        "plan changed",
        409,
        "Conflict",
        {
          code: "daemon_retirement_plan_changed",
          plan: makePlan({ daemon_id: "another-daemon", snapshot: "foreign-snapshot" }),
        },
      ),
    );
    const { onRetired } = renderDialog();

    fireEvent.click(
      await screen.findByText(/I understand this daemon ID and its access tokens/),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Deactivate and remove" }),
    );

    await waitFor(() => expect(retireDaemon).toHaveBeenCalledTimes(1));
    expect(onRetired).not.toHaveBeenCalled();
    expect(screen.queryByText(/workload changed/)).not.toBeInTheDocument();
  });
});
