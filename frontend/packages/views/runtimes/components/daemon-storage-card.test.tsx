// @vitest-environment jsdom

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GcRunRequest,
  StoragePlanItem,
  StorageReport,
  WorkspaceStorageDaemon,
} from "@multiremi/core/storage";
import { renderWithI18n } from "../../test/i18n";

const run = vi.hoisted(() => ({
  mutate: vi.fn(),
  state: { isPending: false, variables: undefined as { mode: string } | undefined, data: undefined as unknown },
}));
const listDaemons = vi.hoisted(() => vi.fn());
const listRuntimes = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/acme/issues/${id}`,
    chat: (id: string) => `/acme/chat?session=${id}`,
  }),
}));
vi.mock("@multiremi/core/storage", async () => {
  const actual = await vi.importActual<typeof import("@multiremi/core/storage")>("@multiremi/core/storage");
  return {
    ...actual,
    workspaceStorageDaemonsOptions: () => ({ queryKey: ["storage-daemons"], queryFn: () => listDaemons() }),
    useRuntimeGcRun: () => ({ mutate: run.mutate, ...run.state }),
  };
});
vi.mock("@multiremi/core/runtimes/queries", () => ({
  runtimeListOptions: () => ({ queryKey: ["runtimes"], queryFn: () => listRuntimes() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { DaemonStorageCard, RuntimeStorageCard } from "./daemon-storage-card";

function makeReport(overrides: Partial<StorageReport> = {}): StorageReport {
  return {
    version: 1,
    generated_at: "2026-10-13T00:00:00Z",
    mode: "periodic",
    root: "/home/remi/workspaces",
    bytes: { work: 99 * 1024 ** 3, env: 60 * 1024 ** 3, traces: 300 * 1024 ** 2, shared: 22 * 1024 ** 3, legacy: 0 },
    bytes_measured_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    subjects: { total: 120, active: 30, ended: 70, reclaimed: 20 },
    // A reason from a newer daemon is not in the contract's union yet.
    retained: { running: 2, within_ttl: 40, snapshot_failed: 1, legacy_retained: 3, future_reason: 5 } as StorageReport["retained"],
    reclaimed_this_round: 4,
    forgotten_this_round: 1,
    freed_bytes: 2 * 1024 ** 3,
    plan: [],
    errors: [],
    ...overrides,
  };
}

function makeDaemon(overrides: Partial<WorkspaceStorageDaemon> = {}): WorkspaceStorageDaemon {
  return {
    daemon_id: "daemon-1",
    name: "n37-066-008",
    runtime_ids: ["rt-1", "rt-2"],
    online: true,
    report: makeReport(),
    reported_at: new Date().toISOString(),
    ...overrides,
  };
}

function item(overrides: Partial<StoragePlanItem> & { id?: string; kind?: "issue" | "chat" | "task" } = {}): StoragePlanItem {
  const { id = "iss_1", kind = "issue", ...rest } = overrides;
  return { subject: { kind, id }, action: "reclaim", reason: "ended_ttl", bytes: 1024 ** 3, unsaved_work: false, ...rest };
}

function renderCard(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  run.state = { isPending: false, variables: undefined, data: undefined };
  listRuntimes.mockResolvedValue([
    { id: "rt-1", status: "online" },
    { id: "rt-2", status: "online" },
  ]);
});

describe("DaemonStorageCard", () => {
  it("summarises disk usage, subjects, retention reasons and the last round", () => {
    renderCard(<DaemonStorageCard daemon={makeDaemon()} canManage />);

    const card = screen.getByRole("region", { name: "Storage on n37-066-008" });
    expect(within(card).getByText("Online")).toBeInTheDocument();
    expect(within(card).getByText("99 GB")).toBeInTheDocument();
    expect(within(card).getByText("Workspaces")).toBeInTheDocument();
    expect(within(card).getByText("300 MB")).toBeInTheDocument();
    expect(within(card).getByText("120")).toBeInTheDocument();
    expect(within(card).getByText("Within retention")).toBeInTheDocument();
    expect(within(card).getByText("Snapshot failed")).toBeInTheDocument();
    expect(within(card).getByText("Old layout worktree")).toBeInTheDocument();
    // The sizes come from the latest completed measurement, whenever it was taken.
    expect(within(card).getByText(/^Disk usage · Measured /)).toBeInTheDocument();
    // An unknown reason from a newer daemon is shown as reported.
    expect(within(card).getByText("future_reason")).toBeInTheDocument();
    expect(within(card).getByText("Freed 2.0 GB · reclaimed 4 · forgotten 1")).toBeInTheDocument();
  });

  it("says so when the machine has not reported or did not measure disk usage", () => {
    const { rerender } = renderCard(<DaemonStorageCard daemon={makeDaemon({ report: null, reported_at: null })} canManage />);
    expect(screen.getByText("This machine has not sent a storage report yet.")).toBeInTheDocument();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DaemonStorageCard daemon={makeDaemon({ report: makeReport({ bytes: null, bytes_measured_at: null }) })} canManage />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Disk usage has not been measured yet.")).toBeInTheDocument();
  });

  it("starts a dry run on the machine's first online runtime", async () => {
    renderCard(<DaemonStorageCard daemon={makeDaemon()} canManage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dry run" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
    expect(run.mutate).toHaveBeenCalledWith({ runtimeId: "rt-1", mode: "dry_run" }, expect.any(Object));
  });

  it("skips an offline runtime of the same machine", async () => {
    listRuntimes.mockResolvedValue([{ id: "rt-1", status: "offline" }, { id: "rt-2", status: "online" }]);
    renderCard(<DaemonStorageCard daemon={makeDaemon()} canManage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dry run" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
    expect(run.mutate).toHaveBeenCalledWith({ runtimeId: "rt-2", mode: "dry_run" }, expect.any(Object));
  });

  it("runs on the runtime being viewed when it is online", async () => {
    renderCard(<DaemonStorageCard daemon={makeDaemon()} canManage preferredRuntimeId="rt-2" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dry run" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
    expect(run.mutate).toHaveBeenCalledWith({ runtimeId: "rt-2", mode: "dry_run" }, expect.any(Object));
  });

  it("keeps the actions disabled when no runtime of the machine is online", async () => {
    listRuntimes.mockResolvedValue([{ id: "rt-1", status: "offline" }, { id: "rt-2", status: "offline" }]);
    renderCard(<DaemonStorageCard daemon={makeDaemon()} canManage />);
    await waitFor(() => expect(listRuntimes).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Dry run" })).toBeDisabled();
  });

  it("reports a failed run through a toast", async () => {
    renderCard(<DaemonStorageCard daemon={makeDaemon()} canManage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dry run" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
    run.mutate.mock.calls[0]![1].onError(new Error("daemon went away"));
    expect(toastError).toHaveBeenCalledWith("daemon went away");
  });

  it("asks for confirmation before reclaiming", async () => {
    renderCard(<DaemonStorageCard daemon={makeDaemon()} canManage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Reclaim now" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Reclaim now" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Reclaim storage on n37-066-008?")).toBeInTheDocument();
    expect(run.mutate).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(run.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reclaim now" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Reclaim now" }));
    expect(run.mutate).toHaveBeenCalledWith({ runtimeId: "rt-1", mode: "run" }, expect.any(Object));
  });

  it("hides the actions from people who cannot manage storage", () => {
    renderCard(<DaemonStorageCard daemon={makeDaemon()} canManage={false} />);
    expect(screen.queryByRole("button", { name: "Dry run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reclaim now" })).toBeNull();
  });

  it("disables the actions while the machine is offline", () => {
    renderCard(<DaemonStorageCard daemon={makeDaemon({ online: false })} canManage />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dry run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reclaim now" })).toBeDisabled();
    expect(screen.getByText("The machine must be online to run storage maintenance.")).toBeInTheDocument();
  });

  it("shows progress and blocks a second run while one is in flight", () => {
    run.state = { isPending: true, variables: { mode: "dry_run" }, data: undefined };
    renderCard(<DaemonStorageCard daemon={makeDaemon()} canManage />);
    expect(screen.getByRole("button", { name: "Running dry run…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reclaim now" })).toBeDisabled();
  });

  it("lists the dry-run plan with links, reasons and unsaved work, most important first", () => {
    const dryRun = makeReport({
      mode: "dry_run",
      generated_at: "2026-10-13T01:00:00Z",
      plan: [
        item({ id: "iss_keep", action: "keep", reason: "running", bytes: 9 * 1024 ** 3 }),
        item({ id: "chat_1", kind: "chat", bytes: 2 * 1024 ** 3, unsaved_work: true }),
        item({ id: "iss_big", bytes: 5 * 1024 ** 3, reason: "over_cap" }),
        item({ id: "tsk_1", kind: "task", action: "forget", reason: "orphan", bytes: null }),
      ],
    });
    run.state = { isPending: false, variables: undefined, data: { report: dryRun } as GcRunRequest };
    renderCard(<DaemonStorageCard daemon={makeDaemon()} canManage />);

    expect(screen.getByText("Dry run: what a reclaim would do")).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByText(/^(iss_|chat_|tsk_)/).textContent)).toEqual([
      "iss_big", "chat_1", "tsk_1", "iss_keep",
    ]);
    expect(screen.getByRole("link", { name: "iss_big" })).toHaveAttribute("href", "/acme/issues/iss_big");
    expect(screen.getByRole("link", { name: "chat_1" })).toHaveAttribute("href", "/acme/chat?session=chat_1");
    expect(screen.queryByRole("link", { name: "tsk_1" })).toBeNull();
    expect(within(rows[0]!).getByText("Over the retained limit")).toBeInTheDocument();
    // Nothing is snapshotted until the real round runs.
    expect(within(rows[1]!).getByText("Will be snapshotted")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Forget")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Deleted on the server")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Keep")).toBeInTheDocument();
  });

  it("states what happened to unsaved work for each action and report mode", () => {
    const plan = [
      item({ id: "iss_run", unsaved_work: true }),
      item({ id: "iss_kept", action: "keep", reason: "snapshot_failed", unsaved_work: true }),
    ];
    run.state = { isPending: false, variables: undefined, data: { report: makeReport({ mode: "run", plan }) } as GcRunRequest };
    renderCard(<DaemonStorageCard daemon={makeDaemon()} canManage />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Saved to snapshot")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Kept in place")).toBeInTheDocument();
  });

  it("prefers the daemon's newer scheduled report over an older run result", () => {
    run.state = {
      isPending: false,
      variables: undefined,
      data: { report: makeReport({ mode: "dry_run", generated_at: "2026-10-12T00:00:00Z", plan: [item({ id: "iss_old" })] }) } as GcRunRequest,
    };
    renderCard(
      <DaemonStorageCard
        daemon={makeDaemon({ report: makeReport({ generated_at: "2026-10-13T00:00:00Z", plan: [item({ id: "iss_new" })] }) })}
        canManage
      />,
    );
    expect(screen.getByText("iss_new")).toBeInTheDocument();
    expect(screen.queryByText("iss_old")).toBeNull();
  });

  it("caps a very long plan and says how much it left out", () => {
    const plan = Array.from({ length: 130 }, (_, index) => item({ id: `iss_${index}`, bytes: index }));
    renderCard(<DaemonStorageCard daemon={makeDaemon({ report: makeReport({ mode: "dry_run", plan }) })} canManage />);
    expect(screen.getAllByRole("row")).toHaveLength(101);
    expect(screen.getByText("Showing the first 100 of 130 items.")).toBeInTheDocument();
  });

  it("surfaces the daemon's errors", () => {
    renderCard(
      <DaemonStorageCard
        daemon={makeDaemon({ report: makeReport({ errors: [{ subject_id: "iss_9", message: "git status timed out" }] }) })}
        canManage
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("1 error");
    expect(screen.getByRole("alert")).toHaveTextContent("iss_9: git status timed out");
  });
});

describe("RuntimeStorageCard", () => {
  it("shows the card of the runtime's own machine", async () => {
    listDaemons.mockResolvedValue({
      daemons: [makeDaemon({ daemon_id: "other", name: "other-host" }), makeDaemon()],
    });
    renderCard(<RuntimeStorageCard daemonId="daemon-1" runtimeId="rt-1" canManage />);
    expect(await screen.findByRole("region", { name: "Storage on n37-066-008" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Storage on other-host" })).toBeNull();
  });

  it("renders nothing for a machine without a report row", async () => {
    listDaemons.mockResolvedValue({ daemons: [] });
    const { container } = renderCard(<RuntimeStorageCard daemonId="daemon-1" runtimeId="rt-1" canManage />);
    await waitFor(() => expect(listDaemons).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector("[aria-busy]")).toBeNull());
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("offers a retry when the reports cannot be loaded", async () => {
    listDaemons.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ daemons: [makeDaemon()] });
    renderCard(<RuntimeStorageCard daemonId="daemon-1" runtimeId="rt-1" canManage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load storage reports");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: "Storage on n37-066-008" })).toBeInTheDocument();
  });
});
