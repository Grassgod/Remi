// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  const scanButton = await screen.findByRole("button", {
    name: /Scan this directory/i,
  });
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

  it("collapses a computer's runtimes into one option and scans its online runtime", async () => {
    // Two runtimes, same daemon (one machine): the offline one would be picked
    // first by id order, but the scan must target the online runtime.
    const offlineClaude = {
      ...MOCK_RUNTIME,
      id: "rt-claude",
      status: "offline",
      name: "claude (n37-206-133-hehuajie)",
    };
    const onlineCodex = {
      ...MOCK_RUNTIME,
      id: "rt-codex",
      provider: "codex",
      status: "online",
      name: "codex (n37-206-133-hehuajie)",
    };
    mockRuntimeListOptions.mockReturnValue({
      queryKey: ["runtimes", "ws-1", "list"],
      queryFn: () => Promise.resolve([offlineClaude, onlineCodex]),
    });
    const user = userEvent.setup();
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /From fleet/i }));

    // The picker lists the machine by its parsed device name, exactly once.
    const trigger = await screen.findByRole("combobox");
    expect(trigger.textContent).toContain("n37-206-133-hehuajie");
    await user.click(trigger);
    expect(await screen.findAllByRole("option")).toHaveLength(1);
    // Close the popup before interacting with the scan button.
    await user.keyboard("{Escape}");

    const scanButton = await screen.findByRole("button", {
      name: /Scan this directory/i,
    });
    await waitFor(() => expect(scanButton).not.toBeDisabled());
    fireEvent.click(scanButton);

    await waitFor(() =>
      expect(mockResolveRuntimeDirectoryScan).toHaveBeenCalledWith("rt-codex", {
        root: "~",
      }),
    );
  });

  it("browses child directories and descends into a subdirectory", async () => {
    mockResolveRuntimeDirectoryScan.mockImplementation(
      (_id: string, params?: { root?: string; mode?: string }) => {
        if (params?.mode === "browse") {
          const base = params.root === "~" || !params.root ? "/home/dev" : params.root;
          return Promise.resolve({
            id: "rds-b",
            runtime_id: "runtime-1",
            status: "completed",
            params: { root: params.root, mode: "browse" },
            candidates: [
              {
                path: `${base}/projects`,
                name: "projects",
                remote_url: null,
                current_branch: null,
                is_dirty: null,
                is_git_repo: false,
              },
              {
                path: `${base}/api`,
                name: "api",
                remote_url: "git@github.com:org/api.git",
                current_branch: "main",
                is_dirty: null,
                is_git_repo: true,
              },
            ],
            supported: true,
            error: null,
            run_started_at: null,
            created_at: "2026-04-16T00:00:00Z",
            updated_at: "2026-04-16T00:00:00Z",
          });
        }
        return Promise.resolve({
          id: "rds-s",
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
      },
    );
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /From fleet/i }));
    const browseButton = await screen.findByRole("button", { name: /^Browse$/i });
    await waitFor(() => expect(browseButton).not.toBeDisabled());
    fireEvent.click(browseButton);

    // Both a plain directory and a git repo child show up.
    expect(await screen.findByText("/home/dev/projects")).toBeInTheDocument();
    expect(screen.getByText("/home/dev/api")).toBeInTheDocument();
    expect(mockResolveRuntimeDirectoryScan).toHaveBeenCalledWith("runtime-1", {
      root: "~",
      mode: "browse",
    });

    // Clicking the plain directory descends into it and re-browses.
    fireEvent.click(screen.getByText("/home/dev/projects").closest("button")!);
    await waitFor(() =>
      expect(mockResolveRuntimeDirectoryScan).toHaveBeenCalledWith("runtime-1", {
        root: "/home/dev/projects",
        mode: "browse",
      }),
    );
  });

  it("shows the resolved absolute dir and an Up button on an empty browse listing", async () => {
    // An empty listing (e.g. a home dir with only dot-dirs) must still render
    // the expanded absolute root and let the user ascend — the candidates array
    // is empty, so the current dir has to come from params.resolved_root.
    mockResolveRuntimeDirectoryScan.mockResolvedValue({
      id: "rds-b",
      runtime_id: "runtime-1",
      status: "completed",
      params: { root: "~", mode: "browse", resolved_root: "/home/svc" },
      candidates: [],
      supported: true,
      error: null,
      run_started_at: null,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
    });
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /From fleet/i }));
    const browseButton = await screen.findByRole("button", { name: /^Browse$/i });
    await waitFor(() => expect(browseButton).not.toBeDisabled());
    fireEvent.click(browseButton);

    // The expanded absolute path is shown, not the literal "~".
    expect(await screen.findByText("/home/svc")).toBeInTheDocument();
    expect(
      screen.getByText("This directory has no subdirectories."),
    ).toBeInTheDocument();
    // The Up button ascends to the parent of the resolved root.
    fireEvent.click(screen.getByRole("button", { name: /Up one level/i }));
    await waitFor(() =>
      expect(mockResolveRuntimeDirectoryScan).toHaveBeenCalledWith("runtime-1", {
        root: "/home",
        mode: "browse",
      }),
    );
  });

  it("imports a git repo directly from browse results", async () => {
    mockResolveRuntimeDirectoryScan.mockResolvedValue({
      id: "rds-b",
      runtime_id: "runtime-1",
      status: "completed",
      params: { root: "~", mode: "browse" },
      candidates: [
        {
          path: "/home/dev/api",
          name: "api",
          remote_url: "git@github.com:org/api.git",
          current_branch: "main",
          is_dirty: null,
          is_git_repo: true,
        },
      ],
      supported: true,
      error: null,
      run_started_at: null,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
    });
    const { onAdd } = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /From fleet/i }));
    const browseButton = await screen.findByRole("button", { name: /^Browse$/i });
    await waitFor(() => expect(browseButton).not.toBeDisabled());
    fireEvent.click(browseButton);

    const checkbox = await screen.findByRole("checkbox", { name: "api" });
    fireEvent.click(checkbox);

    expect(onAdd).toHaveBeenCalledWith({
      resource_type: "github_repo",
      resource_ref: { url: "git@github.com:org/api.git" },
    });
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
