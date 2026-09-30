/**
 * @vitest-environment jsdom
 *
 * MUL-472 b rework: the app-shell queries must not leave the browser before the
 * current route's main content settled and the browser had an idle slot — and
 * the shell class must not close again on a later navigation (that would
 * re-issue expired requests and cost more than the pre-MUL-472 baseline).
 *
 * Drives the real components against a real QueryClient so a gate dropped
 * anywhere between the option factory and the mount fails here.
 */
import type { ReactNode } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "@multiremi/core/api";
import type { ApiClient } from "@multiremi/core/api/client";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import { createAuthStore, registerAuthStore } from "@multiremi/core/auth";
import { createChatStore, registerChatStore, useChatStore, useRecentContextStore } from "@multiremi/core/chat";
import { chatKeys } from "@multiremi/core/chat/queries";
import { workspaceKeys } from "@multiremi/core/workspace/queries";
import { agentTaskSnapshotKeys } from "@multiremi/core/agents/queries";
import { pinKeys } from "@multiremi/core/pins/queries";
import { inboxKeys } from "@multiremi/core/inbox/queries";
import { runtimeKeys } from "@multiremi/core/runtimes/queries";
import { issueKeys } from "@multiremi/core/issues/queries";
import { projectKeys } from "@multiremi/core/projects/queries";
import { workbenchKeys } from "@multiremi/core/issues/workbench";
import {
  configureAfterFirstScreenForTest,
  markRouteContentReady,
  resetAfterFirstScreenForTest,
  useRouteContentReady,
} from "@multiremi/core/platform/use-after-first-screen";
import { ChatFab } from "../chat/components/chat-fab";
import { ChatWindow } from "../chat/components/chat-window";
import { DashboardLayout } from "./dashboard-layout";

const listAgents = vi.hoisted(() => vi.fn(async () => []));
const listSquads = vi.hoisted(() => vi.fn(async () => []));
const getAgentTaskSnapshot = vi.hoisted(() => vi.fn(async () => []));
const listRuntimes = vi.hoisted(() => vi.fn(async () => []));
const listMyInvitations = vi.hoisted(() => vi.fn(async () => []));
const listPins = vi.hoisted(() => vi.fn(async () => []));
const getIssue = vi.hoisted(() => vi.fn(async () => ({ id: "iss_guard_pin", title: "Cached pin", status: "todo" })));
const getProject = vi.hoisted(() => vi.fn(async () => ({ id: "prj_guard_pin", title: "Cached project", icon: null })));
const getInboxSummary = vi.hoisted(() => vi.fn(async () => ({ unread: 0, attention: 0 })));
const getLatestCliVersion = vi.hoisted(() => vi.fn(async () => "1.0.0"));
const listIssues = vi.hoisted(() => vi.fn(async () => ({ issues: [], total: 0 })));
const listChatSessions = vi.hoisted(() => vi.fn(async () => []));
const listPendingChatTasks = vi.hoisted(() => vi.fn(async () => ({ tasks: [] })).mockName("listPendingChatTasks"));
const getTaskTrace = vi.hoisted(() => vi.fn(async () => ({ events: [], eof: true, state: "ok", next_after_seq: 0 })).mockName("getTaskTrace"));
const listTaskHumanRequests = vi.hoisted(() => vi.fn(async () => []).mockName("listTaskHumanRequests"));
const listChatMessagesPage = vi.hoisted(() => vi.fn(async () => ({ messages: [], has_more: false, next_cursor: null })));
const getSessionLog = vi.hoisted(() => vi.fn(async (_sessionId: string, _params: { anchor?: number }) => ({ entries: [] as SessionLogRow[], head_seq: 0, log_version: 1, has_more_before: false, has_more_after: false })));
const subscribeStream = vi.hoisted(() => vi.fn(() => ({ unsubscribe: vi.fn() })));
const wsTransport = vi.hoisted(() => ({ subscribeStream, onReconnect: () => () => {} }));
const getPendingChatTask = vi.hoisted(() => vi.fn(async () => ({ task_id: "tsk_guard_live", status: "running" })));
const listWorkspaces = vi.hoisted(() => vi.fn(async () => [{ id: "ws-1", name: "Acme", slug: "acme" }]));

const navigation = vi.hoisted(() => ({ pathname: "/acme/issues" }));

// Isolate the WS transport only; all query observers and shell children are real.
vi.mock("@multiremi/core/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multiremi/core/realtime")>()),
  useTraceStreamSubscription: () => {},
  useWS: () => wsTransport,
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/paths")>();
  return {
    ...actual,
    useCurrentWorkspace: () => ({ id: "ws-1", name: "Acme", slug: "acme" }),
    useWorkspacePaths: () => actual.paths.workspace("acme"),
  };
});
vi.mock("../navigation", () => ({
  useIsNavigating: () => false,
  useNavigation: () => ({
    pathname: navigation.pathname,
    searchParams: new URLSearchParams(),
    push: vi.fn(),
    replace: vi.fn(),
    getShareableUrl: (path: string) => path,
  }),
  AppLink: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

type IdleHandle = { callback: () => void };
let idleQueue: IdleHandle[] = [];
function cachedReplyRow(sessionId: string, taskId: string): SessionLogRow {
  return {
    session_id: sessionId, seq: 1, id: "msg_guard", revision: 1, kind: "turn",
    visibility: "shown", author_type: "agent", author_id: "agt_guard", task_id: taskId,
    parent_id: null, body_md: "Cached reply", body_html: null, render_version: null,
    resolved_at: null, resolved_by_type: null, resolved_by_id: null,
    metadata: { final_reply_md: "Cached reply", elapsed_ms: 1, attachments: [] },
    created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z", deleted_at: null,
  };
}

function flushIdle(): void {
  const queued = idleQueue;
  idleQueue = [];
  for (const handle of queued) handle.callback();
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

beforeEach(() => {
  // The sidebar and the FAB read the real stores; register throwaway instances
  // rather than mocking the modules, so the wiring under test is the real one.
  const auth = createAuthStore({
      storage: memoryStorage(),
      api: { getMe: async () => ({ id: "user-1" }) } as never,
    });
  auth.setState({ user: { id: "user-1", name: "Test user", email: "test@example.test" } as never, isLoading: false });
  registerAuthStore(auth);
  const chat = createChatStore({ storage: memoryStorage() });
  chat.getState().setOpen(false);
  registerChatStore(chat);
  useRecentContextStore.setState({ byWorkspace: {} });
  listPins.mockResolvedValue([]);
  idleQueue = [];
  resetAfterFirstScreenForTest();
  configureAfterFirstScreenForTest({ idleTimeoutMs: 1000, contentFallbackMs: 2000 });
  navigation.pathname = "/acme/issues";
  for (const spy of [
    listAgents, listSquads, getAgentTaskSnapshot, listRuntimes, listMyInvitations,
    listPins, getInboxSummary, getLatestCliVersion, listIssues, listChatSessions,
    listPendingChatTasks, listWorkspaces, getTaskTrace, listTaskHumanRequests,
    listChatMessagesPage, getSessionLog, subscribeStream, getPendingChatTask, getIssue, getProject,
  ]) spy.mockClear();
  getSessionLog.mockImplementation(async (sessionId: string, params: { anchor?: number }) => {
    const entries = sessionId === "cs_guard_cached" && params.anchor !== 0
      ? [cachedReplyRow(sessionId, "tsk_guard_live")] : [];
    return { entries, head_seq: entries.length, log_version: 1, has_more_before: false, has_more_after: false };
  });
  setApiInstance({
    getBaseUrl: () => "http://127.0.0.1:8080",
    acceptInvitation: vi.fn(),
    declineInvitation: vi.fn(),
    listAgents,
    listSquads,
    getAgentTaskSnapshot,
    listRuntimes,
    listMyInvitations,
    listPins,
    getIssue,
    getProject,
    getInboxSummary,
    getLatestCliVersion,
    listIssues,
    listChatSessions,
    listPendingChatTasks,
    getTaskTrace,
    listTaskHumanRequests,
    listChatMessagesPage,
    getSessionLog,
    getPendingChatTask,
    listWorkspaces,
    listMembers: async () => [],
    listProjects: async () => ({ projects: [] }),
    listRuntimeWorkspaces: async () => [],
    listRecentIssues: async () => [],
  } as unknown as ApiClient);
  (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (
    callback: () => void,
  ) => {
    idleQueue.push({ callback });
    return idleQueue.length;
  };
  (window as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = vi.fn();
});

afterEach(() => {
  resetAfterFirstScreenForTest();
  Reflect.deleteProperty(window, "requestIdleCallback");
  Reflect.deleteProperty(window, "cancelIdleCallback");
});

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
}

describe("chat FAB shell gate (MUL-472 b)", () => {
  it("waits for the route's content and then stays open across navigations", async () => {
    const queryClient = newClient();
    const { rerender } = render(<ChatFab />, { wrapper: wrapper(queryClient) });

    await act(async () => {
      flushIdle();
    });
    expect(listChatSessions).not.toHaveBeenCalled();
    expect(listPendingChatTasks).not.toHaveBeenCalled();

    act(() => {
      markRouteContentReady("/acme/issues");
    });
    await act(async () => {
      flushIdle();
    });
    await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listPendingChatTasks).toHaveBeenCalledTimes(1));

    navigation.pathname = "/acme/inbox";
    await act(async () => {
      rerender(<ChatFab />);
    });
    await act(async () => {
      flushIdle();
    });
    expect(listChatSessions).toHaveBeenCalledTimes(1);
    expect(listPendingChatTasks).toHaveBeenCalledTimes(1);
  });
});

function PendingPage() {
  useRouteContentReady(navigation.pathname, false);
  return <div>Pending main content</div>;
}

function Shell() {
  return (
    <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 60 }}>
      <DashboardLayout extra={<><ChatFab /><ChatWindow /></>}><PendingPage /></DashboardLayout>
    </VirtuosoMockContext.Provider>
  );
}

function isDeferredShellKey(key: readonly unknown[]): boolean {
  if (["chat", "pins", "invitations", "task-messages", "task-human-requests"].includes(String(key[0]))) return true;
  if (key[0] === "workspaces") return ["agents", "squads", "agent-task-snapshot", "members"].includes(String(key[2]));
  if (key[0] === "inbox") return key[2] === "summary";
  if (key[0] === "runtimes") return key[1] === "latestVersion";
  if (key[0] === "issues") return ["workbench", "child-progress", "detail"].includes(String(key[2]));
  return key[0] === "projects" && ["detail", "list"].includes(String(key[2]));
}

describe("complete shell observer guard (MUL-472 R1)", () => {
  it("loads and subscribes to the session log only when an uncached chat opens", async () => {
    const client = newClient();
    act(() => { useChatStore.getState().setActiveSession("cs_uncached"); });
    const view = render(<Shell />, { wrapper: wrapper(client) });
    try {
      await act(async () => {});
      expect(getSessionLog).not.toHaveBeenCalled();
      expect(subscribeStream).not.toHaveBeenCalled();
      act(() => { useChatStore.getState().setOpen(true); });
      await waitFor(() => expect(getSessionLog).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(subscribeStream).toHaveBeenCalledTimes(1));
      expect(getSessionLog.mock.calls.map(([, params]) => params)).toEqual([
        { before: 30 }, { anchor: 0, before: 1 },
      ]);
      expect(listChatMessagesPage).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });

  it("keeps a cached task trace dormant while chat is hidden", async () => {
    const client = newClient();
    const sessionId = "cs_qa_refetch";
    const taskId = "tsk_qa_refetch";
    client.setQueryData(chatKeys.sessions("ws-1"), [{
      id: sessionId, agent_id: "agt_refetch", status: "active", title: "QA chat",
      created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z",
    }]);
    client.setQueryData(chatKeys.pendingTask(sessionId), { task_id: taskId, status: "running" });
    client.setQueryData(["task-trace", taskId], []);
    act(() => { useChatStore.getState().setActiveSession(sessionId); useChatStore.getState().setOpen(true); });
    const view = render(<Shell />, { wrapper: wrapper(client) });
    try {
      await act(async () => {});
      await waitFor(() => expect(client.getQueryCache().find({ queryKey: ["task-trace", taskId] })?.isActive()).toBe(true));
      act(() => { useChatStore.getState().setOpen(false); });
      await act(async () => {});
      expect(client.getQueryCache().find({ queryKey: ["task-trace", taskId] })?.isActive()).toBe(false);
      act(() => { useChatStore.getState().setOpen(true); });
      await waitFor(() => expect(client.getQueryCache().find({ queryKey: ["task-trace", taskId] })?.isActive()).toBe(true));
      expect(idleQueue).toHaveLength(0);
    } finally {
      view.unmount(); client.clear();
    }
  });
  it("QA: an initially hidden cached chat does not refetch before page readiness", async () => {
    const client = newClient();
    const sessionId = "cs_qa_hidden";
    const taskId = "tsk_qa_hidden";
    client.setQueryData(chatKeys.sessions("ws-1"), [{ id: sessionId, agent_id: "agt_refetch", status: "active", title: "QA chat" }]);
    client.setQueryData(chatKeys.pendingTask(sessionId), { task_id: taskId, status: "running" });
    client.setQueryData(["task-trace", taskId], []);
    act(() => { useChatStore.getState().setActiveSession(sessionId); });
    const view = render(<Shell />, { wrapper: wrapper(client) });
    try {
      await act(async () => {});
      expect(listPendingChatTasks).not.toHaveBeenCalled();
      expect(getTaskTrace).not.toHaveBeenCalled();
      expect(useChatStore.getState().isOpen).toBe(false);
    } finally {
      view.unmount(); client.clear();
    }
  });
  it("keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate", async () => {
    const client = newClient();
    const startedKeys: Array<readonly unknown[]> = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "fetch" && isDeferredShellKey(event.query.queryKey)) {
        startedKeys.push(event.query.queryKey);
      }
    });
    const view = render(<Shell />, { wrapper: wrapper(client) });
    await act(async () => { flushIdle(); });
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());
    expect(startedKeys).toEqual([]);
    for (const request of [listAgents, listSquads, getAgentTaskSnapshot, listMyInvitations,
      listPins, getInboxSummary, getLatestCliVersion, listIssues, listChatSessions, listPendingChatTasks]) {
      expect(request).not.toHaveBeenCalled();
    }
    act(() => { markRouteContentReady(navigation.pathname); });
    await act(async () => { flushIdle(); });
    await waitFor(() => {
      for (const request of [listAgents, listSquads, getAgentTaskSnapshot, listMyInvitations,
        listPins, getInboxSummary, getLatestCliVersion, listIssues, listChatSessions, listPendingChatTasks]) {
        expect(request).toHaveBeenCalledTimes(1);
      }
    });
    view.unmount();
    unsubscribe();
    client.clear();
  });

  it("keeps cached deferred keys quiet on invalidation, including a real degraded header", async () => {
    const client = newClient();
    const sessionId = "cs_guard_cached";
    const taskId = "tsk_guard_live";
    const pins = [
      { id: "pin_guard_issue", item_type: "issue", item_id: "iss_guard_pin" },
      { id: "pin_guard_project", item_type: "project", item_id: "prj_guard_pin" },
    ];
    listPins.mockResolvedValue(pins as never);
    useRecentContextStore.getState().recordVisit("ws-1", { type: "issue", id: "iss_guard_pin" });
    useRecentContextStore.getState().recordVisit("ws-1", { type: "project", id: "prj_guard_pin" });
    const cached: Array<[readonly unknown[], unknown]> = [
      [workspaceKeys.agents("ws-1"), []], [workspaceKeys.squads("ws-1"), []],
      [workspaceKeys.members("ws-1"), []], [projectKeys.list("ws-1"), { projects: [] }],
      [agentTaskSnapshotKeys.list("ws-1"), []], [pinKeys.list("ws-1", "user-1"), pins],
      [workspaceKeys.myInvitations(), []], [runtimeKeys.latestVersion(), "1.0.0"],
      [inboxKeys.summary("ws-1"), { unread: 0, attention: 0 }],
      [workbenchKeys.pendingCount("ws-1"), { issues: [], total: 0 }],
      [issueKeys.childProgress("ws-1"), {}],
      [issueKeys.detail("ws-1", "iss_guard_pin"), { id: "iss_guard_pin", title: "Cached pin", status: "todo" }],
      [projectKeys.detail("ws-1", "prj_guard_pin"), { id: "prj_guard_pin", title: "Cached project", icon: null }],
      [chatKeys.sessions("ws-1"), [{ id: sessionId, agent_id: "agt_guard", status: "active", title: "Cached chat" }]],
      [chatKeys.pendingTasks("ws-1"), { tasks: [] }],
      [chatKeys.pendingTask(sessionId), { task_id: taskId, status: "running" }],
      [["task-trace", taskId], []], [chatKeys.humanRequests(taskId), []],
    ];
    for (const [key, data] of cached) client.setQueryData(key, data);
    act(() => { useChatStore.getState().setActiveSession(sessionId); });
    act(() => { useChatStore.getState().setOpen(true); });
    const startedKeys: Array<readonly unknown[]> = [];
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type === "updated" && event.action.type === "fetch" && isDeferredShellKey(event.query.queryKey)) {
        startedKeys.push(event.query.queryKey);
      }
    });
    const view = render(<Shell />, { wrapper: wrapper(client) });
    try {
      await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());
      // A persisted reply suppresses the live observer, so this guards the
      // nested historical observer with the real virtualized row mounted.
      await waitFor(() => expect(getSessionLog).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(view.getByText("Cached reply")).toBeTruthy());
      act(() => { useChatStore.getState().setOpen(false); });
      await act(async () => {});
      getSessionLog.mockClear();
      subscribeStream.mockClear();
      await act(async () => {
        for (const [queryKey] of cached) await client.invalidateQueries({ queryKey, exact: true });
      });
      expect(startedKeys).toEqual([]);
      expect(getTaskTrace).not.toHaveBeenCalled();
      expect(listTaskHumanRequests).not.toHaveBeenCalled();
      expect(getIssue).not.toHaveBeenCalled();
      expect(getProject).not.toHaveBeenCalled();
      act(() => { markRouteContentReady(navigation.pathname); });
      await act(async () => { flushIdle(); });
      await waitFor(() => expect(listPendingChatTasks).toHaveBeenCalledTimes(1));
      await waitFor(() => {
        expect(getIssue).toHaveBeenCalledTimes(1);
        expect(getProject).toHaveBeenCalledTimes(1);
      });
      // The message/form observers need an open window even after the shell gate.
      expect(getTaskTrace).not.toHaveBeenCalled();
      expect(listTaskHumanRequests).not.toHaveBeenCalled();
      expect(getSessionLog).not.toHaveBeenCalled();
      expect(subscribeStream).not.toHaveBeenCalled();
      for (const queryKey of [workspaceKeys.members("ws-1"), projectKeys.list("ws-1")]) {
        expect(client.getQueryCache().find({ queryKey })?.isActive()).toBe(false);
      }
      act(() => { useChatStore.getState().setOpen(true); });
      await waitFor(() => {
        expect(getTaskTrace).toHaveBeenCalledTimes(1);
        expect(listTaskHumanRequests).toHaveBeenCalledTimes(1);
        expect(subscribeStream).toHaveBeenCalledTimes(1);
        expect(getPendingChatTask).toHaveBeenCalledTimes(1);
        for (const queryKey of [workspaceKeys.members("ws-1"), projectKeys.list("ws-1")]) {
          expect(client.getQueryCache().find({ queryKey })?.isActive()).toBe(true);
        }
      });
      // The 444 replica keeps its window across minimisation; reopening only
      // reconnects the stream and never falls back to the removed page API.
      expect(getSessionLog).not.toHaveBeenCalled();
      expect(listChatMessagesPage).not.toHaveBeenCalled();
    } finally {
      view.unmount(); unsubscribe(); client.clear();
    }
  });

  it("loads aggregate pending immediately when the user opens chat before the gate", async () => {
    const client = newClient();
    const view = render(<Shell />, { wrapper: wrapper(client) });
    expect(listPendingChatTasks).not.toHaveBeenCalled();
    act(() => { useChatStore.getState().setOpen(true); });
    await waitFor(() => expect(listPendingChatTasks).toHaveBeenCalledTimes(1));
    expect(idleQueue).toHaveLength(0);
    view.unmount();
    client.clear();
  });
});
