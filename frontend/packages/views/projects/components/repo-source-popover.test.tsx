// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { CreateProjectResourceRequest } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enProjects from "../../locales/en/projects.json";

const TEST_RESOURCES = {
  en: { common: enCommon, projects: enProjects },
};

const mockResolveRuntimeDirectoryScan = vi.hoisted(() => vi.fn());
const mockRuntimeListOptions = vi.hoisted(() => vi.fn());
const mockProjectListOptions = vi.hoisted(() => vi.fn());
const mockIsDesktopShell = vi.hoisted(() => vi.fn(() => false));
const mockUseLocalDaemonStatus = vi.hoisted(() =>
  vi.fn(
    (): { daemonId: string | null; deviceName: string | null; running: boolean } => ({
      daemonId: null,
      deviceName: null,
      running: false,
    }),
  ),
);

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "ws-1", name: "WS", slug: "ws", repos: [] }),
}));

vi.mock("@multiremi/core/runtimes", () => ({
  runtimeListOptions: (...args: unknown[]) => mockRuntimeListOptions(...args),
  resolveRuntimeDirectoryScan: (...args: unknown[]) =>
    mockResolveRuntimeDirectoryScan(...args),
}));

vi.mock("@multiremi/core/projects/queries", () => ({
  projectListOptions: (...args: unknown[]) => mockProjectListOptions(...args),
}));

vi.mock("../../platform", () => ({
  isDesktopShell: () => mockIsDesktopShell(),
  useLocalDaemonStatus: () => mockUseLocalDaemonStatus(),
  pickDirectory: vi.fn(),
  validateLocalDirectory: vi.fn(),
}));

import { RepoSourcePopover } from "./repo-source-popover";

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

const MOCK_RUNTIME = {
  id: "runtime-1",
  workspace_id: "ws-1",
  daemon_id: "daemon-1",
  name: "Claude (MacBook)",
  runtime_mode: "local",
  provider: "claude",
  launch_header: "",
  status: "online",
  device_info: "",
  metadata: {},
  owner_id: "user-1",
  last_seen_at: null,
  created_at: "2026-04-16T00:00:00Z",
  updated_at: "2026-04-16T00:00:00Z",
};

const REMOTE_CANDIDATE = {
  path: "/home/dev/api",
  name: "api",
  remote_url: "git@github.com:org/api.git",
  current_branch: "main",
  is_dirty: null,
};

const LOCAL_CANDIDATE = {
  path: "/home/dev/notes",
  name: "notes",
  remote_url: null,
  current_branch: "main",
  is_dirty: null,
};

function renderPopover(
  props: Partial<{
    resources: CreateProjectResourceRequest[];
    onAdd: (r: CreateProjectResourceRequest) => void;
    onRemove: (r: CreateProjectResourceRequest) => void;
    currentProjectId: string;
  }> = {},
) {
  const onAdd = props.onAdd ?? vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <I18nWrapper>
      <QueryClientProvider client={queryClient}>
        <RepoSourcePopover
          resources={props.resources ?? []}
          onAdd={onAdd}
          onRemove={props.onRemove}
          currentProjectId={props.currentProjectId}
        />
      </QueryClientProvider>
    </I18nWrapper>,
  );
  return { onAdd };
}

async function openFleetTabAndScan() {
  fireEvent.click(screen.getByRole("button", { name: /From fleet/i }));
  const scanButton = await screen.findByRole("button", { name: /^Scan$/i });
  await waitFor(() => expect(scanButton).not.toBeDisabled());
  fireEvent.click(scanButton);
}

describe("RepoSourcePopover — fleet import tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDesktopShell.mockReturnValue(false);
    mockUseLocalDaemonStatus.mockReturnValue({
      daemonId: null,
      deviceName: null,
      running: false,
    });
    mockRuntimeListOptions.mockReturnValue({
      queryKey: ["runtimes", "ws-1", "list"],
      queryFn: () => Promise.resolve([MOCK_RUNTIME]),
    });
    mockProjectListOptions.mockReturnValue({
      queryKey: ["projects", "ws-1", "list"],
      queryFn: () => Promise.resolve([]),
    });
    mockResolveRuntimeDirectoryScan.mockResolvedValue({
      id: "rds-1",
      runtime_id: "runtime-1",
      status: "completed",
      params: { root: "~" },
      candidates: [REMOTE_CANDIDATE, LOCAL_CANDIDATE],
      supported: true,
      error: null,
      run_started_at: null,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
    });
  });

  it("scans the selected runtime and lists the discovered repos", async () => {
    renderPopover();
    await openFleetTabAndScan();

    expect(
      await screen.findByText("/home/dev/api", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("/home/dev/notes")).toBeInTheDocument();
    expect(mockResolveRuntimeDirectoryScan).toHaveBeenCalledWith("runtime-1", {
      root: "~",
    });
  });

  it("maps a candidate with a remote to a github_repo resource", async () => {
    const { onAdd } = renderPopover();
    await openFleetTabAndScan();

    const row = (await screen.findByText("/home/dev/api")).closest("button")!;
    fireEvent.click(row);

    expect(onAdd).toHaveBeenCalledWith({
      resource_type: "github_repo",
      resource_ref: { url: "git@github.com:org/api.git" },
    });
  });

  it("maps a candidate without a remote to a daemon-pinned local_directory", async () => {
    const { onAdd } = renderPopover();
    await openFleetTabAndScan();

    const row = (await screen.findByText("/home/dev/notes")).closest("button")!;
    fireEvent.click(row);

    expect(onAdd).toHaveBeenCalledWith({
      resource_type: "local_directory",
      resource_ref: {
        local_path: "/home/dev/notes",
        daemon_id: "daemon-1",
        label: "notes",
      },
    });
  });

  it("caps local directories at one per daemon and disables further no-remote rows", async () => {
    const { onAdd } = renderPopover({
      resources: [
        {
          resource_type: "local_directory",
          resource_ref: {
            local_path: "/home/dev/existing",
            daemon_id: "daemon-1",
          },
        },
      ],
    });
    await openFleetTabAndScan();

    const localRow = (
      await screen.findByText("/home/dev/notes")
    ).closest("button")!;
    expect(localRow).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(localRow);
    expect(onAdd).not.toHaveBeenCalled();

    // The per-daemon cap only applies to local_directory rows; a candidate
    // with a remote still imports as a github_repo (no cap).
    const remoteRow = screen.getByText("/home/dev/api").closest("button")!;
    expect(remoteRow).not.toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText(
        "Only one local directory per computer can be attached to a project.",
      ),
    ).toBeInTheDocument();
  });

  it("disables the desktop directory picker when this machine already has a local directory", async () => {
    mockIsDesktopShell.mockReturnValue(true);
    mockUseLocalDaemonStatus.mockReturnValue({
      daemonId: "daemon-local",
      deviceName: "MacBook",
      running: true,
    });
    renderPopover({
      resources: [
        {
          resource_type: "local_directory",
          resource_ref: {
            local_path: "/home/dev/existing",
            daemon_id: "daemon-local",
          },
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /From fleet/i }));

    const pickButton = await screen.findByRole("button", {
      name: /Choose a directory/i,
    });
    expect(pickButton).toBeDisabled();
    expect(
      screen.getByText(
        "Only one local directory per computer can be attached to a project.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the empty state when the scan finds nothing", async () => {
    mockResolveRuntimeDirectoryScan.mockResolvedValue({
      id: "rds-1",
      runtime_id: "runtime-1",
      status: "completed",
      params: {},
      candidates: [],
      supported: true,
      error: null,
      run_started_at: null,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
    });
    renderPopover();
    await openFleetTabAndScan();

    expect(
      await screen.findByText("No git repositories found."),
    ).toBeInTheDocument();
  });

  it("surfaces the update-daemon copy when the scan times out", async () => {
    mockResolveRuntimeDirectoryScan.mockRejectedValue(
      new Error("runtime directory scan timed out"),
    );
    renderPopover();
    await openFleetTabAndScan();

    expect(
      await screen.findByText(
        "The scan timed out. The fleet daemon may need updating to the latest version.",
      ),
    ).toBeInTheDocument();
  });
});

describe("RepoSourcePopover — reference project tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDesktopShell.mockReturnValue(false);
    mockUseLocalDaemonStatus.mockReturnValue({
      daemonId: null,
      deviceName: null,
      running: false,
    });
    mockRuntimeListOptions.mockReturnValue({
      queryKey: ["runtimes", "ws-1", "list"],
      queryFn: () => Promise.resolve([]),
    });
    mockProjectListOptions.mockReturnValue({
      queryKey: ["projects", "ws-1", "list"],
      queryFn: () =>
        Promise.resolve([
          { id: "proj-self", title: "Current", icon: "📁" },
          { id: "proj-other", title: "Design System", icon: "🎨" },
        ]),
    });
  });

  it("references another project and excludes the current one", async () => {
    const { onAdd } = renderPopover({ currentProjectId: "proj-self" });
    fireEvent.click(screen.getByRole("button", { name: /Reference project/i }));

    const target = await screen.findByRole("button", { name: /Design System/i });
    // The current project is filtered out of the reference picker.
    expect(
      screen.queryByRole("button", { name: /^Current$/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(target);
    expect(onAdd).toHaveBeenCalledWith({
      resource_type: "project_ref",
      resource_ref: { project_id: "proj-other" },
    });
  });
});
