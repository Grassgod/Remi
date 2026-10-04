import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "@multiremi/core/api";
import { issueKeys } from "@multiremi/core/issues/queries";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enIssues from "../../locales/en/issues.json";
import type { Issue } from "@multiremi/core/types";
import type { UseIssueActionsResult } from "../actions";
import type { IssueSessionSelection } from "../hooks/use-issue-session-selection";
import { NavigationProvider } from "../../navigation";
import { AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS, isRouteContentReadyForTest, resetAfterFirstScreenForTest, useAfterFirstScreen } from "@multiremi/core/platform/use-after-first-screen";

const activityCallbacks = vi.hoisted(() => ({ current: [] as Array<() => void> }));
const update = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/core/api", () => ({ api: {
  listIssueDependencies: vi.fn(), listMessages: vi.fn(),
} }));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/issues/mutations", () => ({ useUpdateIssue: () => ({ mutateAsync: update, isPending: false }) }));

vi.mock("./issue-detail-header", () => ({
  IssueDetailHeader: ({
    sessionSidebarOpen,
    onToggleSessionSidebar,
  }: {
    sessionSidebarOpen: boolean;
    onToggleSessionSidebar: () => void;
  }) => (
    <button
      type="button"
      aria-label="Toggle sessions"
      aria-pressed={sessionSidebarOpen}
      onClick={onToggleSessionSidebar}
    />
  ),
}));

vi.mock("./issue-session-list", () => ({
  IssueSessionList: ({ onSelectSession }: { onSelectSession: (id: string) => void }) => (
    <aside data-testid="session-sidebar">
      <button type="button" onClick={() => onSelectSession("session-review")}>Select session</button>
    </aside>
  ),
}));

vi.mock("./issue-description-section", () => ({
  IssueDescriptionSection: () => null,
}));

vi.mock("./issue-sub-issues-section", () => ({
  IssueSubIssuesSection: () => null,
}));

vi.mock("./issue-activity-section", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./issue-activity-section")>()),
  // The section is a stub here; its layout is exercised in `issue-detail.test`.
  IssueActivitySection: ({ onContentReady }: { onContentReady: () => void }) => {
    useEffect(() => { activityCallbacks.current.push(onContentReady); }, [onContentReady]);
    return <div data-tab-scroll-root>
      <button onClick={onContentReady}>Reveal activity</button>
      <div data-testid="activity-skeleton">Loading activity</div>
    </div>;
  },
}));

import { IssueDetailMain } from "./issue-detail-main";

function RouteGateProbe() {
  const ready = useAfterFirstScreen({ routeKey: "/test/issues/issue-1" });
  return <div data-testid="route-gate">{ready ? "open" : "closed"}</div>;
}

function DeferredAgentsProbe({ load }: { load: () => Promise<unknown> }) {
  const ready = useAfterFirstScreen({ routeKey: "/test/issues/issue-1" });
  useQuery({ queryKey: ["deferred-agents"], queryFn: load, enabled: ready });
  return null;
}

beforeEach(() => {
  resetAfterFirstScreenForTest();
  activityCallbacks.current = [];
  update.mockReset().mockResolvedValue({});
});
afterEach(() => {
  resetAfterFirstScreenForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function controlledGateClock() {
  vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>();
  const idle = new Map<number, () => void>();
  let nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
    const id = ++nextId;
    idle.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelIdleCallback", (id: number) => idle.delete(id));
  return {
    async flush() {
      await act(async () => {
        const nextFrames = [...frames.values()];
        frames.clear();
        for (const callback of nextFrames) callback(performance.now());
        const nextIdle = [...idle.values()];
        idle.clear();
        for (const callback of nextIdle) callback();
      });
    },
  };
}

interface MainOptions {
  issue?: Partial<Issue>;
  canForceStart?: boolean;
  sessionId?: string;
  highlightCommentId?: string;
  sessionsPending?: boolean;
  loadAgents?: () => Promise<unknown>;
}

function renderMain(
  sessionSidebarOpen: boolean,
  onToggleSessionSidebar = vi.fn(),
  isMobile = false,
  options: MainOptions = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (current: MainOptions) => {
    const issue = { id: "issue-1", title: "Issue title", project_id: null, parent_issue_id: null,
      status: "in_progress", pending_decision_count: 0, blocked_by: [], ...current.issue } as Issue;
    const sessions: IssueSessionSelection = {
      list: [],
      activeId: current.sessionId ?? "",
      active: null,
      select: vi.fn(),
      pending: current.sessionsPending ?? false,
      fetching: false,
      refetch: vi.fn(),
    };
    return <QueryClientProvider client={queryClient}>
    <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
    <NavigationProvider value={{ pathname: "/test/issues/issue-1", searchParams: new URLSearchParams(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), getShareableUrl: (path) => path }}>
    <RouteGateProbe />
    {current.loadAgents && <DeferredAgentsProbe load={current.loadAgents} />}
    <IssueDetailMain
      issue={issue}
      issueId={issue.id}
      parentIssue={null}
      breadcrumbProject={null}
      actions={{} as UseIssueActionsResult}
      sidebarOpen
      onToggleSidebar={vi.fn()}
      isMobile={isMobile}
      sessionSidebarOpen={sessionSidebarOpen}
      onToggleSessionSidebar={onToggleSessionSidebar}
      sessions={sessions}
      members={[]}
      agents={[]}
      canModerateComments={false}
      getActorName={(_type, id) => id}
      onShowKeyResults={vi.fn()}
      onScrollContainerRef={vi.fn()}
      scrollContainerEl={null}
      canForceStart={current.canForceStart}
      highlightCommentId={current.highlightCommentId}
    />
    </NavigationProvider>
    </I18nProvider>
    </QueryClientProvider>;
  };
  const result = render(view(options));

  return { ...result, queryClient, onToggleSessionSidebar, rerenderMain: (next: MainOptions) => result.rerender(view(next)) };
}

describe("MUL-496 first-screen notices", () => {
  it("omits an empty slot and makes no first-screen decision or dependency requests", async () => {
    const dependencies = vi.spyOn(api, "listIssueDependencies");
    const decisions = vi.spyOn(api, "listMessages");
    const { queryClient, rerenderMain } = renderMain(false);
    queryClient.setQueryData(issueKeys.decisions("ws-1", "issue-1"), [
      { id: "owner", message_kind: "decision", resolved_at: null },
      { id: "answered", message_kind: "decision", resolved_at: "2026-10-01" },
    ]);
    rerenderMain({});
    await act(async () => {});
    expect(document.querySelector("[data-issue-notice-slot]")).toBeNull();
    expect(dependencies).not.toHaveBeenCalled();
    expect(decisions).not.toHaveBeenCalled();
  });

  it("renders a pending decision on the first frame and gives it priority over waiting", () => {
    renderMain(false, vi.fn(), false, { issue: { pending_decision_count: 2,
      status: "backlog", parent_issue_id: "parent", blocked_by: ["MUL-1"] } });
    expect(document.querySelector("[data-issue-notice-slot]")).toHaveClass("h-10");
    expect(document.querySelector("[data-issue-decision-banner]")).toHaveTextContent("Waiting for your decision · 2");
    expect(screen.queryByText(/Waiting for MUL-1/)).toBeNull();
  });

  it("shows backlog prerequisites immediately and hides them after starting", () => {
    const issue: Partial<Issue> = { status: "backlog", parent_issue_id: "parent", blocked_by: ["MUL-1"] };
    const { rerenderMain } = renderMain(false, vi.fn(), false, { issue });
    expect(document.querySelector("[data-issue-notice-slot]")).toHaveTextContent("MUL-1");
    rerenderMain({ issue: { ...issue, status: "todo" } });
    expect(document.querySelector("[data-issue-notice-slot]")).toBeNull();
  });

  it("allows a new pending decision to add the slot after a real state change", () => {
    const { rerenderMain } = renderMain(false);
    expect(document.querySelector("[data-issue-notice-slot]")).toBeNull();
    rerenderMain({ issue: { pending_decision_count: 2 } });
    expect(document.querySelector("[data-issue-notice-slot]")).toHaveClass("h-10");
    expect(document.querySelector("[data-issue-decision-banner]")).not.toBeNull();
  });

  it("refreshes the first-screen detail after confirmed force start", async () => {
    const { queryClient } = renderMain(false, vi.fn(), false, { canForceStart: true,
      issue: { status: "backlog", parent_issue_id: "parent", blocked_by: ["MUL-1"] } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(screen.getByRole("button", { name: "Start anyway" }));
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Start anyway" }).at(-1)!);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ id: "issue-1", status: "todo", force: true }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: issueKeys.detail("ws-1", "issue-1") }));
  });
});

describe("IssueDetailMain session sidebar", () => {
  it("opens deferred route queries only after the activity body is revealed", async () => {
    renderMain(false);
    expect(screen.getByTestId("route-gate")).toHaveTextContent("closed");
    fireEvent.click(screen.getByRole("button", { name: "Reveal activity" }));
    await waitFor(() => expect(screen.getByTestId("route-gate")).toHaveTextContent("open"));
  });

  it("renders the session sidebar only while its preference is open", () => {
    const { unmount } = renderMain(true);
    expect(screen.getByTestId("session-sidebar")).toBeInTheDocument();

    unmount();
    renderMain(false);
    expect(screen.queryByTestId("session-sidebar")).not.toBeInTheDocument();
  });

  it("forwards the persistent sidebar toggle to the header control", () => {
    const onToggleSessionSidebar = vi.fn();
    renderMain(false, onToggleSessionSidebar);

    fireEvent.click(screen.getByRole("button", { name: "Toggle sessions" }));
    expect(onToggleSessionSidebar).toHaveBeenCalledOnce();
  });

  it("renders the mobile session list in a left sheet and closes it after selection", () => {
    const onToggleSessionSidebar = vi.fn();
    renderMain(true, onToggleSessionSidebar, true);

    const rail = screen.getByTestId("session-sidebar");
    const scrollRoot = document.querySelector<HTMLElement>("[data-tab-scroll-root]");
    expect(rail.closest('[data-slot="sheet-content"]')).not.toBeNull();
    expect(scrollRoot?.parentElement?.contains(rail)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Select session" }));
    expect(onToggleSessionSidebar).toHaveBeenCalledOnce();
  });
});

describe("IssueDetailMain route readiness", () => {
  const route = "/test/issues/issue-1";

  it("opens after 2000ms when the log never resolves, without revealing the list", async () => {
    const clock = controlledGateClock();
    const loadAgents = vi.fn(async () => []);
    renderMain(false, vi.fn(), false, { sessionId: "session-main", loadAgents });

    act(() => vi.advanceTimersByTime(AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS - 1));
    await clock.flush();
    expect(isRouteContentReadyForTest(route)).toBe(false);
    expect(loadAgents).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(loadAgents).not.toHaveBeenCalled();
    await clock.flush();
    expect(isRouteContentReadyForTest(route)).toBe(true);
    expect(screen.getByTestId("route-gate")).toHaveTextContent("open");
    expect(loadAgents).toHaveBeenCalledOnce();
    expect(screen.getByTestId("activity-skeleton")).toBeInTheDocument();
  });

  it("publishes a normal reveal before the timeout and does not repeat the deferred query", async () => {
    const clock = controlledGateClock();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const loadAgents = vi.fn(async () => []);
    renderMain(false, vi.fn(), false, { sessionId: "session-main", loadAgents });
    const timerIndex = setTimeoutSpy.mock.calls.findIndex(call => call[1] === AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS);
    const timer = setTimeoutSpy.mock.results[timerIndex]?.value;
    expect(timer).toBeDefined();

    act(() => vi.advanceTimersByTime(500));
    expect(isRouteContentReadyForTest(route)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reveal activity" }));
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    await clock.flush();
    expect(isRouteContentReadyForTest(route)).toBe(true);
    expect(loadAgents).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS));
    await clock.flush();
    expect(loadAgents).toHaveBeenCalledOnce();
  });

  it.each(["session", "deep link"])("restarts the full timeout on %s change and ignores the old reveal", async (change) => {
    const clock = controlledGateClock();
    const { rerenderMain } = renderMain(false, vi.fn(), false, { sessionId: "session-main" });
    const oldReveal = activityCallbacks.current.at(-1)!;

    act(() => vi.advanceTimersByTime(1000));
    rerenderMain({ sessionId: change === "session" ? "session-review" : "session-main",
      highlightCommentId: change === "deep link" ? "comment-2" : undefined });
    act(() => oldReveal());
    act(() => vi.advanceTimersByTime(AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS - 1));
    await clock.flush();
    expect(isRouteContentReadyForTest(route)).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    await clock.flush();
    expect(isRouteContentReadyForTest(route)).toBe(true);
  });

  it("bounds a pending sessions query without removing its skeleton", async () => {
    const clock = controlledGateClock();
    renderMain(false, vi.fn(), false, { sessionsPending: true });

    act(() => vi.advanceTimersByTime(AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS - 1));
    await clock.flush();
    expect(isRouteContentReadyForTest(route)).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    await clock.flush();
    expect(isRouteContentReadyForTest(route)).toBe(true);
    expect(screen.getByTestId("activity-skeleton")).toBeInTheDocument();
  });

  it("clears the pending ready timer on unmount", () => {
    controlledGateClock();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const view = renderMain(false, vi.fn(), false, { sessionsPending: true });
    const timerIndex = setTimeoutSpy.mock.calls.findIndex(call => call[1] === AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS);
    const timer = setTimeoutSpy.mock.results[timerIndex]?.value;
    expect(timer).toBeDefined();
    view.unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
  });
});
