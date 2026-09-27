/**
 * @vitest-environment jsdom
 *
 * MUL-472 b: the app-shell queries must not leave the browser before the
 * current route's first content commit + idle window. This drives the real
 * `WorkspacePresencePrefetch` against a real QueryClient and a controlled
 * `requestIdleCallback`, so it fails if a gate is dropped anywhere between the
 * option factory and the mount.
 */
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "@multiremi/core/api";
import type { ApiClient } from "@multiremi/core/api/client";
import { WorkspacePresencePrefetch } from "./workspace-presence-prefetch";

const listAgents = vi.hoisted(() => vi.fn(async () => []));
const listSquads = vi.hoisted(() => vi.fn(async () => []));
const getAgentTaskSnapshot = vi.hoisted(() => vi.fn(async () => []));
const listRuntimes = vi.hoisted(() => vi.fn(async () => []));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../navigation", () => ({
  useNavigation: () => ({
    pathname: "/acme/issues",
    searchParams: new URLSearchParams(),
    push: vi.fn(),
    replace: vi.fn(),
    getShareableUrl: (path: string) => path,
  }),
}));

type IdleHandle = { callback: () => void; options?: { timeout?: number } };
let idleQueue: IdleHandle[] = [];

function flushIdle(): void {
  const queued = idleQueue;
  idleQueue = [];
  for (const handle of queued) handle.callback();
}

beforeEach(() => {
  idleQueue = [];
  listAgents.mockClear();
  listSquads.mockClear();
  getAgentTaskSnapshot.mockClear();
  listRuntimes.mockClear();
  setApiInstance({
    listAgents,
    listSquads,
    getAgentTaskSnapshot,
    listRuntimes,
  } as unknown as ApiClient);
  (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (
    callback: () => void,
    options?: { timeout?: number },
  ) => {
    idleQueue.push({ callback, options });
    return idleQueue.length;
  };
  (window as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = vi.fn();
});

afterEach(() => {
  delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
  delete (window as unknown as { cancelIdleCallback?: unknown }).cancelIdleCallback;
});

describe("shell queries wait for the first screen (MUL-472 b)", () => {
  it("sends nothing before the idle callback, then warms agents/squads/snapshot", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspacePresencePrefetch />
      </QueryClientProvider>,
    );

    expect(idleQueue).toHaveLength(1);
    expect(listAgents).not.toHaveBeenCalled();
    expect(listSquads).not.toHaveBeenCalled();
    expect(getAgentTaskSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      flushIdle();
    });

    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(1));
    expect(listAgents).toHaveBeenCalledWith({ workspace_id: "ws-1", include_archived: true });
    await waitFor(() => expect(listSquads).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getAgentTaskSnapshot).toHaveBeenCalledTimes(1));
  });

  it("keeps the runtimes list on its normal lifecycle", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspacePresencePrefetch />
      </QueryClientProvider>,
    );

    // The sidebar's runtime indicator reads this outside the deferred set.
    await waitFor(() => expect(listRuntimes).toHaveBeenCalledTimes(1));
  });
});
