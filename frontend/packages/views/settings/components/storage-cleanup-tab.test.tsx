import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" as "owner" | "admin" | "member" }],
  pending: false,
  error: false,
}));
const statusRef = vi.hoisted(() => ({
  current: {
    config: {
      backend: "local",
      root_hint: "~/.remi/multiremi/session-archives",
      require_archive: true,
      max_bytes: 2_147_483_648,
      min_free_bytes: 10_737_418_240,
      workspace_ttl_ms: 259_200_000,
      gc_interval_ms: 900_000,
    },
    usage: {
      total_archives: 3,
      ready_archives: 2,
      pending_archives: 0,
      failed_archives: 1,
      total_bytes: 1_024,
    },
    last_failure: null as null | {
      archive_id: string;
      issue_id: string;
      issue_key: string | null;
      error: string;
      updated_at: string;
    },
  },
  pending: false,
  error: false,
}));
const mockUpdateConfig = vi.hoisted(() => vi.fn());
const mockSetQueryData = vi.hoisted(() => vi.fn());
const mockRefetch = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = JSON.stringify(options.queryKey ?? []);
    if (key.includes("session-archives")) {
      return {
        data: statusRef.error ? undefined : statusRef.current,
        isPending: statusRef.pending,
        isError: statusRef.error,
        refetch: mockRefetch,
      };
    }
    return {
      data: membersRef.error ? undefined : membersRef.current,
      isPending: membersRef.pending,
      isError: membersRef.error,
      refetch: mockRefetch,
    };
  },
  useQueryClient: () => ({ setQueryData: mockSetQueryData }),
  queryOptions: <T,>(options: T) => options,
}));
vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
}));
vi.mock("@multiremi/core/session-archives", () => ({
  sessionArchiveKeys: {
    workspaceStatus: (workspaceId: string) => ["session-archives", "workspace", workspaceId, "status"],
  },
  workspaceSessionArchiveStatusOptions: (workspaceId: string) => ({
    queryKey: ["session-archives", "workspace", workspaceId, "status"],
    queryFn: vi.fn(),
  }),
}));
vi.mock("@multiremi/core/api", () => ({
  api: { updateWorkspaceSessionArchiveConfig: mockUpdateConfig },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  StorageCleanupTab,
  validateSessionArchiveTiming,
} from "./storage-cleanup-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };
function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

describe("StorageCleanupTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    membersRef.current = [{ user_id: "user-1", role: "owner" }];
    membersRef.pending = false;
    membersRef.error = false;
    statusRef.pending = false;
    statusRef.error = false;
    statusRef.current.config.workspace_ttl_ms = 259_200_000;
    statusRef.current.config.gc_interval_ms = 900_000;
    statusRef.current.last_failure = null;
    mockUpdateConfig.mockResolvedValue(statusRef.current);
  });

  it("shows the effective backend, usage, and cleanup timings", () => {
    render(<StorageCleanupTab />, { wrapper: Wrapper });

    expect(screen.getByText("Local disk")).toBeInTheDocument();
    expect(screen.getByText("~/.remi/multiremi/session-archives")).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace retention")).toHaveValue(72);
    expect(screen.getByLabelText("Cleanup scan interval")).toHaveValue(15);
  });

  it("saves exact millisecond values through the controlled endpoint", async () => {
    const user = userEvent.setup();
    render(<StorageCleanupTab />, { wrapper: Wrapper });

    const retention = screen.getByLabelText("Workspace retention");
    await user.clear(retention);
    await user.type(retention, "48");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalledWith("workspace-1", {
        workspace_ttl_ms: 172_800_000,
        gc_interval_ms: 900_000,
      });
    });
    expect(mockSetQueryData).toHaveBeenCalled();
  });

  it("blocks a scan interval longer than the retention period", async () => {
    const user = userEvent.setup();
    render(<StorageCleanupTab />, { wrapper: Wrapper });

    const interval = screen.getByLabelText("Cleanup scan interval");
    await user.clear(interval);
    await user.type(interval, "5000");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The scan interval cannot exceed the workspace retention period.",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the readable issue key for the latest archive failure", () => {
    statusRef.current.last_failure = {
      archive_id: "archive-1",
      issue_id: "iss_internal",
      issue_key: "MUL-55",
      error: "archive upload failed",
      updated_at: "2026-08-19T01:00:00Z",
    };
    render(<StorageCleanupTab />, { wrapper: Wrapper });

    expect(screen.getByText(/MUL-55/)).toBeInTheDocument();
    expect(screen.queryByText(/iss_internal/)).not.toBeInTheDocument();
  });

  it("does not expose settings to a regular workspace member", () => {
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    render(<StorageCleanupTab />, { wrapper: Wrapper });

    expect(screen.getByText(/Only workspace owners and admins/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace retention")).not.toBeInTheDocument();
  });

  it("reports a member lookup failure instead of mislabeling the user as unauthorized", async () => {
    const user = userEvent.setup();
    membersRef.error = true;
    render(<StorageCleanupTab />, { wrapper: Wrapper });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load storage and cleanup settings",
    );
    expect(screen.queryByText(/Only workspace owners and admins/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRefetch).toHaveBeenCalledOnce();
  });
});

describe("validateSessionArchiveTiming", () => {
  it("enforces the server timing boundaries", () => {
    expect(validateSessionArchiveTiming({ workspaceTtlHours: 0, gcIntervalMinutes: 1 })).toBe("ttl_min");
    expect(validateSessionArchiveTiming({ workspaceTtlHours: 8_761, gcIntervalMinutes: 1 })).toBe("ttl_max");
    expect(validateSessionArchiveTiming({ workspaceTtlHours: 1, gcIntervalMinutes: 0 })).toBe("interval_min");
    expect(validateSessionArchiveTiming({ workspaceTtlHours: 1, gcIntervalMinutes: 61 })).toBe("interval_gt_ttl");
    expect(validateSessionArchiveTiming({ workspaceTtlHours: 1, gcIntervalMinutes: 60 })).toBeNull();
  });
});
