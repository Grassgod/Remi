import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { InboxItem } from "@multiremi/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enInbox from "../../locales/en/inbox.json";

const getRun = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/test/issues/${id}`,
    issueSession: (id: string, sessionId: string) => `/test/issues/${id}?session=${sessionId}`,
    autopilotDetail: (id: string) => `/test/autopilots/${id}`,
  }),
}));
vi.mock("@multiremi/core/autopilots/queries", () => ({
  autopilotRunOptions: (_wsId: string, autopilotId: string, runId: string, options?: { enabled?: boolean }) => ({
    queryKey: ["autopilots", autopilotId, runId],
    queryFn: getRun,
    enabled: options?.enabled ?? true,
    retry: false,
  }),
}));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("../../common/markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div data-testid="markdown-output">{children}</div>,
}));
vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (_type: string, id: string) => id }),
}));
vi.mock("../../issues/components", () => ({ StatusIcon: () => null, PriorityIcon: () => null }));

import { AutopilotRunReport, autopilotRunOutput } from "./autopilot-run-report";

function runItem(
  id = "inbox-1",
  action: "none" | "review" | "retry" | "investigate" = "investigate",
  branch = "main",
): InboxItem {
  return {
    id,
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "member-1",
    actor_type: "system",
    actor_id: null,
    type: action === "retry" ? "autopilot_run_failed" : "autopilot_run_completed",
    severity: action === "retry" ? "attention" : "info",
    issue_id: "issue-1",
    issue_status: null,
    title: "Server fallback",
    body: "Server fallback body",
    read: false,
    archived: false,
    created_at: "2026-08-28T05:28:37.614Z",
    details: {
      autopilot_id: "autopilot-1",
      autopilot_title: "Atlas · Repository Wiki",
      run_id: id.replace("inbox", "run"),
      task_id: "task-1",
      issue_id: "issue-1",
      issue_session_id: "session-1",
      trigger: "scm_event",
      triggered_at: "2026-08-28T05:28:37.614Z",
      duration_seconds: 137,
      trigger_object: {
        event_type: "default_branch.updated",
        repository_id: "repo-1",
        repository_name: "Remi",
        change_number: null,
        change_title: "Update notification body",
        target_branch: branch,
        source_revision: "84edaab6555f6ed6bbc4068055df7976cb57f005",
        occurred_at: "2026-08-28T05:28:37.614Z",
        wiki_build: true,
      },
      outcome: {
        kind: action === "retry" ? "failed" : action === "review" ? "changes" : "unknown",
        text: action === "retry" ? "503 No available accounts." : "Published the repository report.",
        links: action === "review"
          ? [{ kind: "pull_request", url: "https://github.com/Grassgod/Remi/pull/80", number: 80 }]
          : [],
        counts: action === "review" ? { changes: 1 } : null,
        risks: action === "investigate" || action === "retry" ? ["Repository checkout failed."] : [],
        action: { kind: action, text: action === "none" || action === "review" ? null : "Repository checkout failed." },
      },
    },
  };
}

function renderReport(item = runItem(), groupedItems: InboxItem[] = [item], onSelectItem = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    onSelectItem,
    ...render(
      <I18nProvider locale="en" resources={{ en: { inbox: enInbox } }}>
        <QueryClientProvider client={queryClient}>
          <AutopilotRunReport item={item} groupedItems={groupedItems} onSelectItem={onSelectItem} />
        </QueryClientProvider>
      </I18nProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getRun.mockResolvedValue({ result: { output: "## Result\n\nPublished the report." }, failure_reason: null });
});

describe("AutopilotRunReport", () => {
  it.each([
    ["none", "No action needed"],
    ["review", "Review changes"],
    ["retry", "Retry recommended"],
    ["investigate", "Needs investigation"],
  ] as const)("shows the %s action as %s", (action, label) => {
    renderReport(runItem("inbox-1", action));
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("shows structured facts, risks, outputs, and explicit Issue/Session links", () => {
    renderReport(runItem("inbox-1", "investigate"));
    expect(screen.getByText("Needs investigation")).toBeInTheDocument();
    expect(screen.getByText("Repository checkout failed.")).toBeInTheDocument();
    expect(screen.getByText("default_branch.updated")).toBeInTheDocument();
    expect(screen.getByText("84edaab6555f6ed6bbc4068055df7976cb57f005")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Issue/ })).toHaveAttribute("href", "/test/issues/issue-1");
    expect(screen.getByRole("link", { name: /Open Agent session/ })).toHaveAttribute(
      "href",
      "/test/issues/issue-1?session=session-1",
    );
  });

  it("fetches and renders the full result only after the output is expanded", async () => {
    renderReport();
    expect(getRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Expand"));
    expect(await screen.findByTestId("markdown-output")).toHaveTextContent("Published the report.");
    expect(getRun).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Plain text" }));
    expect(screen.queryByTestId("markdown-output")).not.toBeInTheDocument();
    expect(screen.getByText(/## Result/)).toBeInTheDocument();
  });

  it("falls back to plain text without mounting markdown for very large output", async () => {
    getRun.mockResolvedValue({ result: { output: "x".repeat(100_001) }, failure_reason: null });
    renderReport();
    fireEvent.click(screen.getByText("Expand"));

    expect(await screen.findByText(/over 100,000 characters/)).toBeInTheDocument();
    expect(screen.queryByTestId("markdown-output")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Markdown" })).not.toBeInTheDocument();
  });

  it("shows a stable missing-run state for a deleted run", async () => {
    getRun.mockRejectedValue(new Error("404 run not found"));
    renderReport();
    fireEvent.click(screen.getByText("Expand"));
    expect(await screen.findByText("This run is no longer available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("shows an explicit empty-result state", async () => {
    getRun.mockResolvedValue({ result: null, failure_reason: null });
    renderReport();
    fireEvent.click(screen.getByText("Expand"));
    expect(await screen.findByText("This run did not return output.")).toBeInTheDocument();
  });

  it("shows a retryable state when the request fails", async () => {
    getRun.mockRejectedValue(new Error("503 upstream unavailable"));
    renderReport();
    fireEvent.click(screen.getByText("Expand"));
    expect(await screen.findByText("Run output could not be loaded.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
  });

  it("expands a grouped report and lets the user open an individual run", () => {
    const latest = runItem("inbox-latest", "review", "main");
    const earlier = runItem("inbox-earlier", "none", "release");
    const onSelectItem = vi.fn();
    renderReport(latest, [latest, earlier], onSelectItem);

    expect(screen.getByText(/2 successful runs/)).toHaveTextContent("Runs with outputs: 1");
    fireEvent.click(screen.getByText("Show every run"));
    expect(screen.getByText("Atlas · Repository Wiki · Remi@release")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Remi@release/ }));
    expect(onSelectItem).toHaveBeenCalledWith(earlier);
  });
});

describe("autopilotRunOutput", () => {
  it("prefers structured output and falls back to failure_reason", () => {
    expect(autopilotRunOutput({ result: { output: "Done" }, failure_reason: "Failed" })).toBe("Done");
    expect(autopilotRunOutput({ result: null, failure_reason: "Failed" })).toBe("Failed");
  });
});
