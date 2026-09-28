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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "@multiremi/core/api";
import type { ApiClient } from "@multiremi/core/api/client";
import { createAuthStore, registerAuthStore } from "@multiremi/core/auth";
import { createChatStore, registerChatStore, useChatStore } from "@multiremi/core/chat";
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
const getInboxSummary = vi.hoisted(() => vi.fn(async () => ({ unread: 0, attention: 0 })));
const getLatestCliVersion = vi.hoisted(() => vi.fn(async () => "1.0.0"));
const listIssues = vi.hoisted(() => vi.fn(async () => ({ issues: [], total: 0 })));
const listChatSessions = vi.hoisted(() => vi.fn(async () => []));
const listPendingChatTasks = vi.hoisted(() => vi.fn(async () => ({ tasks: [] })).mockName("listPendingChatTasks"));
const listWorkspaces = vi.hoisted(() => vi.fn(async () => [{ id: "ws-1", name: "Acme", slug: "acme" }]));

const navigation = vi.hoisted(() => ({ pathname: "/acme/issues" }));

// Isolate the WS transport only; all query observers and shell children are real.
vi.mock("@multiremi/core/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multiremi/core/realtime")>()),
  useChatScopeSubscription: () => {},
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
  idleQueue = [];
  resetAfterFirstScreenForTest();
  configureAfterFirstScreenForTest({ idleTimeoutMs: 1000, contentFallbackMs: 2000 });
  navigation.pathname = "/acme/issues";
  for (const spy of [
    listAgents, listSquads, getAgentTaskSnapshot, listRuntimes, listMyInvitations,
    listPins, getInboxSummary, getLatestCliVersion, listIssues, listChatSessions,
    listPendingChatTasks, listWorkspaces,
  ]) spy.mockClear();
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
    getInboxSummary,
    getLatestCliVersion,
    listIssues,
    listChatSessions,
    listPendingChatTasks,
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
  return <DashboardLayout extra={<><ChatFab /><ChatWindow /></>}><PendingPage /></DashboardLayout>;
}

describe("complete shell observer guard (MUL-472 R1)", () => {
  it("keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate", async () => {
    const client = newClient();
    const view = render(<Shell />, { wrapper: wrapper(client) });
    await act(async () => { flushIdle(); });
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());
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
    client.clear();
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
