import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { PlatformOperation, PlatformStatus } from "@multiremi/core/platform-lifecycle";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const statusRef = vi.hoisted(() => ({
  current: null as PlatformStatus | null,
  pending: false,
  refetchError: false,
}));
const createMutationRef = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(),
  mutate: vi.fn(),
}));
const cancelMutationRef = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(),
}));
const settingsMutationRef = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: statusRef.current,
    isPending: statusRef.pending,
    isRefetchError: statusRef.refetchError,
  }),
}));
vi.mock("@multiremi/core/platform-lifecycle", () => ({
  platformStatusOptions: () => ({ queryKey: ["platform-lifecycle", "status"] }),
  useCreatePlatformOperation: () => createMutationRef,
  useCancelPlatformOperation: () => cancelMutationRef,
  useUpdatePlatformSettings: () => settingsMutationRef,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PlatformTab } from "./platform-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

function platformOperation(overrides: Partial<PlatformOperation> = {}): PlatformOperation {
  return {
    id: "pop-1",
    kind: "update",
    status: "queued",
    driver: "docker_compose",
    targetVersion: "v0.2.47",
    targetRef: "v0.2.47",
    targetManifest: {},
    progress: { message: "", drain: null },
    cancelRequested: false,
    requestedBy: "user-1",
    output: null,
    error: null,
    previousRelease: null,
    resultRelease: null,
    createdAt: "2026-08-23T01:00:00.000Z",
    updatedAt: "2026-08-23T01:00:00.000Z",
    startedAt: "2026-08-23T01:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function platformStatus(overrides: Partial<PlatformStatus> = {}): PlatformStatus {
  return {
    canManage: true,
    driver: "docker_compose",
    currentRelease: {
      version: "v0.2.46",
      ref: "v0.2.46",
      publishedAt: null,
      releaseUrl: null,
      manifestUrl: null,
      apiImage: null,
      webImage: null,
    },
    latestRelease: null,
    updateAvailable: false,
    autoUpdateStable: false,
    updaterStatus: "ready",
    updaterHeartbeatAt: null,
    services: [],
    activeOperation: null,
    lastOperation: null,
    maintenance: {
      mode: "normal",
      generation: 0,
      operationId: null,
      startedAt: null,
      expiresAt: null,
      reason: null,
    },
    recentReleases: [],
    ...overrides,
  };
}

describe("PlatformTab upgrade lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusRef.pending = false;
    statusRef.refetchError = false;
    createMutationRef.isPending = false;
    cancelMutationRef.isPending = false;
    settingsMutationRef.isPending = false;
    cancelMutationRef.mutateAsync.mockResolvedValue(platformOperation({ status: "cancelled" }));
    statusRef.current = platformStatus();
  });

  it("renders daemon acknowledgements and active task drain progress", () => {
    statusRef.current = platformStatus({
      activeOperation: platformOperation({
        status: "draining",
        progress: {
          message: "Waiting for 2 running tasks",
          drain: {
            generation: 3,
            online_daemons: 5,
            acked_daemons: 3,
            active_tasks: 2,
            waited_ms: 120_000,
            timeout_ms: 900_000,
            state: "waiting",
          },
        },
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText("Pausing new tasks (3/5 daemons acknowledged)")).toBeInTheDocument();
    expect(screen.getByText("Waiting for 2 running tasks to finish (2 min elapsed)")).toBeInTheDocument();
  });

  it.each([
    ["queued", "Preparing update"],
    ["preparing", "Preparing update"],
    ["pulling", "Pulling images"],
    ["switching", "Switching services"],
    ["verifying", "Verifying"],
  ])("renders the %s upgrade stage", (operationStatus, expectedLabel) => {
    statusRef.current = platformStatus({
      activeOperation: platformOperation({ status: operationStatus }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });

  it("requests cancellation from a cancellable stage", async () => {
    const user = userEvent.setup();
    statusRef.current = platformStatus({
      activeOperation: platformOperation({ status: "draining" }),
    });
    render(<PlatformTab />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: "Cancel upgrade" }));

    await waitFor(() => expect(cancelMutationRef.mutateAsync).toHaveBeenCalledWith("pop-1"));
  });

  it("hides cancellation once service switching begins", () => {
    statusRef.current = platformStatus({
      activeOperation: platformOperation({ status: "switching" }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText("Switching services")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel upgrade" })).not.toBeInTheDocument();
  });

  it("shows the recent drain timeout result after scheduling is restored", () => {
    statusRef.current = platformStatus({
      lastOperation: platformOperation({
        status: "failed",
        error: null,
        finishedAt: new Date().toISOString(),
        progress: {
          message: "Drain timeout",
          drain: {
            generation: 3,
            online_daemons: 5,
            acked_daemons: 5,
            active_tasks: 1,
            waited_ms: 900_000,
            timeout_ms: 900_000,
            state: "timeout",
          },
        },
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText(
      "Drain timed out. Upgrade not performed; tasks kept running and scheduling resumed.",
    )).toBeInTheDocument();
    expect(screen.getByTestId("platform-operation-status")).toHaveAttribute("data-state", "timeout");
  });

  it("recognizes a drain timeout reported in the operation error", () => {
    statusRef.current = platformStatus({
      lastOperation: platformOperation({
        status: "failed",
        error: "platform drain timed out after 900000ms",
        finishedAt: new Date().toISOString(),
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText(
      "Drain timed out. Upgrade not performed; tasks kept running and scheduling resumed.",
    )).toBeInTheDocument();
  });

  it.each([
    ["succeeded", "Task scheduling restored"],
    ["cancelled", "Upgrade cancelled. Task scheduling resumed."],
  ])("renders the recent %s operation result", (operationStatus, expectedLabel) => {
    statusRef.current = platformStatus({
      lastOperation: platformOperation({
        status: operationStatus,
        finishedAt: new Date().toISOString(),
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });

  it("does not render a terminal operation result after 30 minutes", () => {
    statusRef.current = platformStatus({
      lastOperation: platformOperation({
        status: "succeeded",
        finishedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.queryByText("Task scheduling restored")).not.toBeInTheDocument();
  });

  it("keeps a long drain wait active instead of rendering it as a failure", () => {
    statusRef.current = platformStatus({
      activeOperation: platformOperation({
        status: "draining",
        progress: {
          message: "Waiting for 1 running task",
          drain: {
            generation: 3,
            online_daemons: 5,
            acked_daemons: 5,
            active_tasks: 1,
            waited_ms: 840_000,
            timeout_ms: 900_000,
            state: "waiting",
          },
        },
      }),
      lastOperation: platformOperation({
        status: "failed",
        error: "drain timeout",
        finishedAt: new Date().toISOString(),
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText("Waiting for 1 running task to finish (14 min elapsed)")).toBeInTheDocument();
    expect(screen.queryByText(/Drain timed out/)).not.toBeInTheDocument();
    expect(screen.getByTestId("platform-operation-status")).toHaveAttribute("data-state", "active");
    expect(screen.getByTestId("platform-operation-status")).not.toHaveClass("text-destructive");
  });

  it("omits the active task line once draining reaches zero tasks", () => {
    statusRef.current = platformStatus({
      activeOperation: platformOperation({
        status: "draining",
        progress: {
          message: "Ready to switch",
          drain: {
            generation: 3,
            online_daemons: 5,
            acked_daemons: 5,
            active_tasks: 0,
            waited_ms: 180_000,
            timeout_ms: 900_000,
            state: "ready",
          },
        },
      }),
    });

    render(<PlatformTab />, { wrapper: Wrapper });

    expect(screen.getByText("Pausing new tasks (5/5 daemons acknowledged)")).toBeInTheDocument();
    expect(screen.queryByText(/running task/)).not.toBeInTheDocument();
  });
});
