/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_HEARTBEAT_STALE_MS } from "@multiremi/contracts/runtime-health";
import type { Agent, AgentRuntime } from "../types";
import { RUNTIME_LIST_REFRESH_MS, runtimeKeys } from "../runtimes/queries";
import { workspaceKeys } from "../workspace/queries";
import { agentTaskSnapshotKeys } from "./queries";
import { PRESENCE_RUNTIME_LIST_MAX_AGE_MS, presenceClock } from "./derive-presence";
import type { AgentPresenceDetail } from "./types";

const mock = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listRuntimes: vi.fn(),
  getAgentTaskSnapshot: vi.fn(),
}));
vi.mock("../api", () => ({ api: mock }));

import { useAgentPresenceDetail, useWorkspacePresenceMap } from "./use-agent-presence";

const WS = "ws-1";
const MINUTE = 60_000;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1", workspace_id: WS, runtime_id: "rt-1", name: "Remi", description: "", instructions: "",
    avatar_url: null, runtime_mode: "local", runtime_config: {}, custom_args: [], visibility: "workspace",
    status: "idle", max_concurrent_tasks: 1, model: "", owner_id: null, skills: [],
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", archived_at: null, archived_by: null,
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "rt-1", workspace_id: WS, daemon_id: "daemon-1", name: "Laptop", runtime_mode: "local",
    provider: "claude", launch_header: "", status: "online", device_info: "", metadata: {},
    owner_id: null, visibility: "private", last_seen_at: new Date().toISOString(),
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const availability = (detail: AgentPresenceDetail | "loading") =>
  detail === "loading" ? "loading" : detail.availability;

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Seeds the three presence inputs; the runtime list as read at `readAt`. */
function seed(runtimes: AgentRuntime[], readAt: number, agents: Agent[] = [makeAgent()]) {
  qc.setQueryData(workspaceKeys.agents(WS), agents);
  qc.setQueryData(agentTaskSnapshotKeys.list(WS), []);
  qc.setQueryData(runtimeKeys.list(WS), runtimes, { updatedAt: readAt });
}

beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mock.listAgents.mockImplementation(async () => qc.getQueryData(workspaceKeys.agents(WS)) ?? []);
  mock.getAgentTaskSnapshot.mockResolvedValue([]);
});
afterEach(() => {
  qc.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe("presence judged from the runtime list's read", () => {
  it("keeps the judging window inside the heartbeat threshold and past the refresh interval", () => {
    const heartbeatCadenceMs = 15_000; // DAEMON_HEARTBEAT_INTERVAL_MS
    expect(PRESENCE_RUNTIME_LIST_MAX_AGE_MS).toBeGreaterThanOrEqual(2 * RUNTIME_LIST_REFRESH_MS);
    expect(PRESENCE_RUNTIME_LIST_MAX_AGE_MS + heartbeatCadenceMs).toBeLessThan(RUNTIME_HEARTBEAT_STALE_MS);
    expect(presenceClock(10 * MINUTE, { readAt: 0, failed: false })).toEqual({ at: PRESENCE_RUNTIME_LIST_MAX_AGE_MS, aged: true });
    expect(presenceClock(10 * MINUTE, { readAt: 0, failed: true })).toEqual({ at: 10 * MINUTE, aged: false });
    expect(presenceClock(30_000, { readAt: 0, failed: false })).toEqual({ at: 30_000, aged: false });
  });

  it("keeps an online agent online while a list cached across a hidden tab is re-read", async () => {
    const readAt = Date.now() - 10 * MINUTE;
    seed([makeRuntime({ last_seen_at: iso(readAt - 10_000) })], readAt);
    const reread = deferred<AgentRuntime[]>();
    mock.listRuntimes.mockReturnValue(reread.promise);

    const { result } = renderHook(() => useAgentPresenceDetail(WS, "agent-1", true), { wrapper });

    expect(availability(result.current)).toBe("online");
    await waitFor(() => expect(mock.listRuntimes).toHaveBeenCalled());
    expect(availability(result.current)).toBe("online");
    await act(async () => reread.resolve([makeRuntime({ last_seen_at: iso(Date.now() - 5_000) })]));
    await waitFor(() => expect(qc.getQueryState(runtimeKeys.list(WS))?.fetchStatus).toBe("idle"));
    expect(availability(result.current)).toBe("online");
  });

  it("does not establish offline from a list too old to judge; the re-read decides", async () => {
    const readAt = Date.now() - 10 * MINUTE;
    seed([makeRuntime({ status: "offline", last_seen_at: iso(readAt - 60 * MINUTE) })], readAt);
    const reread = deferred<AgentRuntime[]>();
    mock.listRuntimes.mockReturnValue(reread.promise);

    const { result } = renderHook(() => useAgentPresenceDetail(WS, "agent-1", true), { wrapper });

    expect(result.current).toBe("loading");
    await waitFor(() => expect(mock.listRuntimes).toHaveBeenCalled());
    expect(result.current).toBe("loading");
    await act(async () => reread.resolve([makeRuntime({ last_seen_at: iso(Date.now() - 5_000) })]));
    await waitFor(() => expect(availability(result.current)).toBe("online"));
  });

  it("reports offline once the re-read confirms it", async () => {
    const readAt = Date.now() - 10 * MINUTE;
    const gone = makeRuntime({ status: "offline", last_seen_at: iso(readAt - 60 * MINUTE) });
    seed([gone], readAt);
    mock.listRuntimes.mockResolvedValue([gone]);

    const { result } = renderHook(() => useAgentPresenceDetail(WS, "agent-1", true), { wrapper });

    await waitFor(() => expect(availability(result.current)).toBe("offline"));
  });

  it("reports offline at once from a fresh list", () => {
    seed([makeRuntime({ status: "offline", last_seen_at: iso(Date.now() - 60 * MINUTE) })], Date.now());

    const { result } = renderHook(() => useAgentPresenceDetail(WS, "agent-1", true), { wrapper });

    expect(availability(result.current)).toBe("offline");
    expect(mock.listRuntimes).not.toHaveBeenCalled();
  });

  it("judges the list a failed re-read left behind at the current time", async () => {
    const readAt = Date.now() - 10 * MINUTE;
    seed([makeRuntime({ last_seen_at: iso(readAt - 10_000) })], readAt);
    mock.listRuntimes.mockRejectedValue(new Error("unreachable"));

    const { result } = renderHook(() => useAgentPresenceDetail(WS, "agent-1", true), { wrapper });

    await waitFor(() => expect(availability(result.current)).toBe("offline"));
  });

  it("does not decay an online agent while the page is hidden, and re-reads the list on return", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    seed([makeRuntime({ last_seen_at: iso(Date.now() - 10_000) })], Date.now());
    mock.listRuntimes.mockImplementation(async () => [makeRuntime({ last_seen_at: iso(Date.now() - 5_000) })]);
    focusManager.setFocused(false);

    const { result } = renderHook(() => useAgentPresenceDetail(WS, "agent-1", true), { wrapper });
    expect(availability(result.current)).toBe("online");

    // Hidden for six minutes: the list's interval refresh is paused, the presence
    // tick keeps re-deriving. The cached heartbeat is now past the threshold.
    await act(async () => { vi.advanceTimersByTime(6 * MINUTE); });
    expect(mock.listRuntimes).not.toHaveBeenCalled();
    expect(availability(result.current)).toBe("online");

    await act(async () => { focusManager.setFocused(true); });
    await waitFor(() => expect(mock.listRuntimes).toHaveBeenCalledTimes(1));
    expect(availability(result.current)).toBe("online");
  });
});

describe("workspace presence map from an aged runtime list", () => {
  it("keeps last-known online rows and leaves rows it cannot judge loading until the re-read", async () => {
    const readAt = Date.now() - 10 * MINUTE;
    const agents = [
      makeAgent({ id: "agent-on", runtime_id: "rt-on" }),
      makeAgent({ id: "agent-off", runtime_id: "rt-off" }),
    ];
    const online = makeRuntime({ id: "rt-on", last_seen_at: iso(readAt - 10_000) });
    const gone = makeRuntime({ id: "rt-off", status: "offline", last_seen_at: iso(readAt - 60 * MINUTE) });
    seed([online, gone], readAt, agents);
    const reread = deferred<AgentRuntime[]>();
    mock.listRuntimes.mockReturnValue(reread.promise);

    const { result } = renderHook(() => useWorkspacePresenceMap(WS, true), { wrapper });

    expect(result.current.byAgent.get("agent-on")?.availability).toBe("online");
    expect(result.current.byAgent.has("agent-off")).toBe(false);
    await act(async () => reread.resolve([{ ...online, last_seen_at: iso(Date.now() - 5_000) }, gone]));
    await waitFor(() => expect(result.current.byAgent.get("agent-off")?.availability).toBe("offline"));
    expect(result.current.byAgent.get("agent-on")?.availability).toBe("online");
  });
});
