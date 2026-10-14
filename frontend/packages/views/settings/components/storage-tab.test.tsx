// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  StorageSettings,
  WorkspaceStorageDaemon,
  WorkspaceStorageResponse,
} from "@multiremi/core/storage";
import { renderWithI18n } from "../../test/i18n";

const HOUR = 3_600_000;

const fixtures = vi.hoisted(() => ({
  role: "owner" as "owner" | "admin" | "member",
  members: vi.fn(),
  policy: vi.fn(),
  daemons: vi.fn(),
  update: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "user-1" } }),
}));
vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: () => fixtures.members() }),
}));
vi.mock("@multiremi/core/storage", async () => {
  const actual = await vi.importActual<typeof import("@multiremi/core/storage")>("@multiremi/core/storage");
  return {
    ...actual,
    workspaceStorageOptions: () => ({ queryKey: ["storage-policy"], queryFn: () => fixtures.policy() }),
    workspaceStorageDaemonsOptions: () => ({ queryKey: ["storage-daemons"], queryFn: () => fixtures.daemons() }),
    useUpdateWorkspaceStorage: () => ({ mutate: fixtures.update, isPending: false }),
  };
});
vi.mock("sonner", () => ({ toast }));
vi.mock("../../runtimes/components/daemon-storage-card", () => ({
  DaemonStorageCard: ({ daemon, canManage }: { daemon: WorkspaceStorageDaemon; canManage: boolean }) => (
    <div data-testid="daemon-card">{daemon.name}:{canManage ? "manage" : "view"}</div>
  ),
}));

import { StorageTab } from "./storage-tab";

const settings: StorageSettings = {
  ttl_ms: 72 * HOUR,
  automation_ttl_ms: 24 * HOUR,
  max_retained: 50,
  orphan_ttl_ms: 72 * HOUR,
  snapshot_max_bytes: 256 * 1024 * 1024,
  chat_idle_days: 14,
};

function policy(overrides: Partial<WorkspaceStorageResponse> = {}): WorkspaceStorageResponse {
  return { settings, overrides: {}, ...overrides };
}

function daemon(name: string): WorkspaceStorageDaemon {
  return { daemon_id: name, name, runtime_ids: [`rt-${name}`], online: true, report: null, reported_at: null };
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <StorageTab />
    </QueryClientProvider>,
  );
}

async function field(label: string) {
  return (await screen.findByLabelText(label)) as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.role = "owner";
  fixtures.members.mockImplementation(async () => [{ user_id: "user-1", role: fixtures.role }]);
  fixtures.policy.mockResolvedValue(policy());
  fixtures.daemons.mockResolvedValue({ daemons: [daemon("host-a"), daemon("host-b")] });
});

describe("StorageTab", () => {
  it("shows a card per machine and the effective policy in friendly units", async () => {
    renderTab();
    expect(await screen.findAllByTestId("daemon-card")).toHaveLength(2);
    expect(screen.getByText("host-a:manage")).toBeInTheDocument();
    expect((await field("Retention period")).value).toBe("72");
    expect((await field("Automation chat retention")).value).toBe("24");
    expect((await field("Retained workspace limit")).value).toBe("50");
    expect((await field("Orphaned data retention")).value).toBe("72");
    expect((await field("Snapshot size limit")).value).toBe("256");
    expect((await field("Chat auto-archive")).value).toBe("14");
    expect(screen.getAllByText(/Default: 72 hours/)).toHaveLength(2);
    expect(screen.getByText(/Default: 256 MB/)).toBeInTheDocument();
  });

  it("lets members read machines and policy but not change them", async () => {
    fixtures.role = "member";
    renderTab();
    expect(await screen.findByText("host-a:view")).toBeInTheDocument();
    expect(await field("Retention period")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("Only workspace owners and admins can change storage settings.")).toBeInTheDocument();
  });

  it("saves only the fields that were edited, converted to the wire units", async () => {
    renderTab();
    expect(await screen.findByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(await field("Retention period"), { target: { value: "48" } });
    fireEvent.change(await field("Snapshot size limit"), { target: { value: "512" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(fixtures.update).toHaveBeenCalledWith(
      { ttl_ms: 48 * HOUR, snapshot_max_bytes: 512 * 1024 * 1024 },
      expect.any(Object),
    );
    fixtures.update.mock.calls[0]![1].onSuccess(
      policy({ settings: { ...settings, ttl_ms: 48 * HOUR, snapshot_max_bytes: 512 * 1024 * 1024 } }),
    );
    expect(toast.success).toHaveBeenCalledWith("Storage settings saved");
    // The saved values are the new baseline, so there is nothing left to save.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  });

  it("does not resend a value that merely rounds differently when displayed", async () => {
    fixtures.policy.mockResolvedValue(policy({ settings: { ...settings, ttl_ms: 100 * 60_000 } }));
    renderTab();
    expect((await field("Retention period")).value).toBe("1.67");
    fireEvent.change(await field("Chat auto-archive"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fixtures.update).toHaveBeenCalledWith({ chat_idle_days: 7 }, expect.any(Object));
  });

  it.each([
    ["Retention period", "0.5", "Must be between 1 and 8760 hours."],
    ["Retained workspace limit", "2.5", "Enter a whole number."],
    ["Snapshot size limit", "", "Enter a number."],
    ["Chat auto-archive", "4000", "Must be between 0 and 3650 days."],
  ])("blocks saving %s = %j", async (label, value, message) => {
    renderTab();
    fireEvent.change(await field(label), { target: { value } });
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("allows 0 where it means unlimited", async () => {
    renderTab();
    fireEvent.change(await field("Retained workspace limit"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fixtures.update).toHaveBeenCalledWith({ max_retained: 0 }, expect.any(Object));
  });

  it("resets an overridden setting to the default with null once saved", async () => {
    fixtures.policy.mockResolvedValue(policy({ settings: { ...settings, chat_idle_days: 30 }, overrides: { chat_idle_days: 30 } }));
    renderTab();
    expect((await field("Chat auto-archive")).value).toBe("30");
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(fixtures.update).not.toHaveBeenCalled();
    expect((await field("Chat auto-archive")).value).toBe("14");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fixtures.update).toHaveBeenCalledWith({ chat_idle_days: null }, expect.any(Object));
  });

  it("keeps other unsaved edits when a setting is reset", async () => {
    fixtures.policy.mockResolvedValue(policy({ settings: { ...settings, chat_idle_days: 30 }, overrides: { chat_idle_days: 30 } }));
    renderTab();
    fireEvent.change(await field("Retention period"), { target: { value: "48" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect((await field("Retention period")).value).toBe("48");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fixtures.update).toHaveBeenCalledWith({ ttl_ms: 48 * HOUR, chat_idle_days: null }, expect.any(Object));
  });

  it("sends an edit after a reset as a value, not as null", async () => {
    fixtures.policy.mockResolvedValue(policy({ settings: { ...settings, chat_idle_days: 30 }, overrides: { chat_idle_days: 30 } }));
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Reset to default" }));
    fireEvent.change(await field("Chat auto-archive"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fixtures.update).toHaveBeenCalledWith({ chat_idle_days: 7 }, expect.any(Object));
  });

  it("reports a save failure with the server's message", async () => {
    renderTab();
    fireEvent.change(await field("Retention period"), { target: { value: "48" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fixtures.update.mock.calls[0]![1].onError(new Error("ttl_ms must be a number between 3600000 and 31536000000"));
    expect(toast.error).toHaveBeenCalledWith("ttl_ms must be a number between 3600000 and 31536000000");
  });

  it("says when no machine has connected", async () => {
    fixtures.daemons.mockResolvedValue({ daemons: [] });
    renderTab();
    expect(await screen.findByText("No machines have connected to this workspace yet.")).toBeInTheDocument();
  });

  it("retries the sections independently", async () => {
    fixtures.daemons.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ daemons: [daemon("host-a")] });
    renderTab();
    expect(await field("Retention period")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("host-a:manage")).toBeInTheDocument();
    await waitFor(() => expect(fixtures.daemons).toHaveBeenCalledTimes(2));
    expect(fixtures.policy).toHaveBeenCalledTimes(1);
  });

  it("shows an error with a retry when the members cannot be read", async () => {
    fixtures.members.mockRejectedValueOnce(new Error("boom"));
    renderTab();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load storage information");
    expect(screen.queryByTestId("daemon-card")).toBeNull();
  });
});
