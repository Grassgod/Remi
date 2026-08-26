// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentRuntime } from "@multiremi/core/types";
import type { DaemonInventoryEntry } from "@multiremi/core/runtimes";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";

const BUSY_ERROR =
  "CLI update blocked: providers are busy: codex (2 active tasks); retry when all providers are idle";

const fixture = vi.hoisted(() => ({
  runtimes: [] as AgentRuntime[],
  daemons: [] as DaemonInventoryEntry[],
  searchParams: new URLSearchParams(),
}));

const apiMocks = vi.hoisted(() => ({
  getLatestCliVersion: vi.fn(),
  initiateUpdate: vi.fn(),
  getUpdateResult: vi.fn(),
}));

vi.mock("@multiremi/core/api", () => ({ api: apiMocks }));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>(
      "@tanstack/react-query",
    );
  return {
    ...actual,
    useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      const key = queryKey.join(":");
      if (key === "runtimes:ws-1:list") {
        return { data: fixture.runtimes, isLoading: false };
      }
      if (key === "runtimes:daemons:inventory:ws-1") {
        return {
          data: { workspace_id: "ws-1", daemons: fixture.daemons },
          isLoading: false,
        };
      }
      if (key === "workspaces:ws-1:members") {
        return { data: [{ user_id: "user-1", role: "owner" }] };
      }
      return { data: [] };
    },
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ isLoading: false, user: { id: "user-1" } }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/realtime", () => ({ useWSEvent: vi.fn() }));
vi.mock("@multiremi/core/runtimes/hooks", () => ({
  useUpdatableRuntimeIds: () => new Set<string>(),
}));
vi.mock("@multiremi/ui/hooks/use-mobile", () => ({ useIsMobile: () => true }));
vi.mock("../../navigation", async () => {
  const actual =
    await vi.importActual<typeof import("../../navigation")>("../../navigation");
  return {
    ...actual,
    useNavigation: () => ({ searchParams: fixture.searchParams }),
  };
});
vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: vi.fn(),
  }),
}));
vi.mock("./provider-logo", () => ({ ProviderLogo: () => null }));
vi.mock("./runtime-list", async () => {
  const actual =
    await vi.importActual<typeof import("./runtime-list")>("./runtime-list");
  return { ...actual, RuntimeList: () => <div data-testid="runtime-list" /> };
});
vi.mock("./connect-remote-dialog", () => ({ ConnectRemoteDialog: () => null }));
vi.mock("./cloud-runtime-dialog", () => ({ CloudRuntimeDialog: () => null }));
vi.mock("./retire-daemon-dialog", () => ({ RetireDaemonDialog: () => null }));

import { RuntimesPage } from "./runtimes-page";

const resources = { en: { common: enCommon, runtimes: enRuntimes } };

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  const now = new Date().toISOString();
  return {
    id: "runtime-a",
    workspace_id: "ws-1",
    daemon_id: "daemon-a",
    name: "Claude (host-a)",
    runtime_mode: "local",
    provider: "claude",
    launch_header: "",
    status: "online",
    device_info: "host-a",
    metadata: { cli_version: "0.3.0" },
    owner_id: "user-1",
    visibility: "private",
    last_seen_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <I18nProvider locale="en" resources={resources}>
      <RuntimesPage />
    </I18nProvider>,
  );
}

async function selectMachine(name: string) {
  const row = screen
    .getAllByRole("button")
    .find((el) => el.textContent?.includes(name));
  if (!row) throw new Error(`machine row not found: ${name}`);
  fireEvent.click(row);
  await act(async () => Promise.resolve());
}

describe("RuntimesPage machine switching isolates the CLI update flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.searchParams = new URLSearchParams();
    const now = new Date().toISOString();
    fixture.runtimes = [
      makeRuntime(),
      makeRuntime({
        id: "runtime-b",
        daemon_id: "daemon-b",
        name: "Claude (host-b)",
        device_info: "host-b",
      }),
    ];
    fixture.daemons = [
      { daemon_id: "daemon-a", runtime_count: 1, token_count: 1, last_seen: now, name: "host-a" },
      { daemon_id: "daemon-b", runtime_count: 1, token_count: 1, last_seen: now, name: "host-b" },
    ];
    apiMocks.getLatestCliVersion.mockResolvedValue("0.3.1");
    apiMocks.initiateUpdate.mockResolvedValue({ id: "update-1" });
    apiMocks.getUpdateResult.mockResolvedValue({
      status: "failed",
      output: null,
      error: BUSY_ERROR,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not carry a failed update from one machine to the next, and never retries against the newly selected machine", async () => {
    vi.useFakeTimers();
    renderPage();
    await act(async () => Promise.resolve());

    // Machine A: start an update and let it poll through to "failed".
    await selectMachine("host-a");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await act(async () => Promise.resolve());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(apiMocks.initiateUpdate).toHaveBeenCalledWith("runtime-a", "0.3.1");
    expect(
      screen.getByRole("button", { name: "Update failed" }),
    ).toBeInTheDocument();

    // Switching machines must present machine B's own state, not A's failure.
    await selectMachine("host-b");
    expect(
      screen.queryByRole("button", { name: "Update failed" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();

    // The retry that belonged to A must never fire against B.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(apiMocks.initiateUpdate).toHaveBeenCalledTimes(1);
    expect(apiMocks.initiateUpdate).not.toHaveBeenCalledWith(
      "runtime-b",
      expect.anything(),
    );
  });

  it("drops an update whose initiate resolves after the machine was switched away", async () => {
    vi.useFakeTimers();
    let resolveInitiate: (update: { id: string }) => void = () => {};
    apiMocks.initiateUpdate.mockImplementation(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveInitiate = resolve;
        }),
    );

    renderPage();
    await act(async () => Promise.resolve());

    // Machine A: start an update and leave initiate() in flight. No poll
    // interval exists yet, so unmount cleanup has nothing to clear.
    await selectMachine("host-a");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await act(async () => Promise.resolve());
    expect(apiMocks.initiateUpdate).toHaveBeenCalledWith("runtime-a", "0.3.1");

    await selectMachine("host-b");
    const timersBeforeResolve = vi.getTimerCount();

    // A's request lands after its control is gone: it must not install a poll.
    await act(async () => {
      resolveInitiate({ id: "update-1" });
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(apiMocks.getUpdateResult).not.toHaveBeenCalled();
    expect(apiMocks.initiateUpdate).toHaveBeenCalledTimes(1);
    expect(apiMocks.initiateUpdate).not.toHaveBeenCalledWith(
      "runtime-b",
      expect.anything(),
    );
    // No orphaned timer outlives the discarded run.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBeforeResolve);
  });
});
