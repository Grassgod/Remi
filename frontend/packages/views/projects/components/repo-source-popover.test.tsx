// @vitest-environment jsdom

import { useState, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

// Mutable so a test can seed workspace-level repos (the detail-flow row needs a
// rendered git row to mark as already-added).
const mockWorkspaceRepos = vi.hoisted(() => ({ current: [] as { url: string }[] }));

vi.mock("@multiremi/core/paths", () => ({
  useCurrentWorkspace: () => ({
    id: "ws-1",
    name: "WS",
    slug: "ws",
    repos: mockWorkspaceRepos.current,
  }),
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

// Self-managing wrapper: the selected bar and its two-way sync only make sense
// when the parent owns the resource list, so mirror the create-project flow.
function StatefulPopover({
  initial = [],
}: {
  initial?: CreateProjectResourceRequest[];
}) {
  const [resources, setResources] = useState<CreateProjectResourceRequest[]>(initial);
  return (
    <RepoSourcePopover
      resources={resources}
      onAdd={(r) => setResources((prev) => [...prev, r])}
      onRemove={(r) => setResources((prev) => prev.filter((x) => x !== r))}
    />
  );
}

function renderStateful(initial?: CreateProjectResourceRequest[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <I18nWrapper>
      <QueryClientProvider client={queryClient}>
        <StatefulPopover initial={initial} />
      </QueryClientProvider>
    </I18nWrapper>,
  );
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

  it("renders an already-referenced project as a checked, toggle-off row in the create flow", async () => {
    const onRemove = vi.fn();
    const resource: CreateProjectResourceRequest = {
      resource_type: "project_ref",
      resource_ref: { project_id: "proj-other" },
    };
    renderPopover({ resources: [resource], onRemove, currentProjectId: "proj-self" });
    fireEvent.click(screen.getByRole("button", { name: /Reference project/i }));

    // The referenced project stays in the list as a checked row rather than
    // vanishing on selection. Scope to the row's checkbox — the create flow's
    // selected bar also renders a "Design System" chip.
    const checkbox = await screen.findByRole("checkbox");
    expect(checkbox).toBeChecked();
    const row = checkbox.closest("button")!;
    expect(within(row).getByText("Design System")).toBeInTheDocument();
    expect(row).not.toHaveAttribute("aria-disabled", "true");

    // Clicking it in the create flow toggles the reference back off.
    fireEvent.click(row);
    expect(onRemove).toHaveBeenCalledWith(resource);
  });

  it("locks an already-referenced project row with an Added hint in the detail flow", async () => {
    const resource: CreateProjectResourceRequest = {
      resource_type: "project_ref",
      resource_ref: { project_id: "proj-other" },
    };
    const { onAdd } = renderPopover({
      resources: [resource],
      currentProjectId: "proj-self",
    });
    fireEvent.click(screen.getByRole("button", { name: /Reference project/i }));

    const row = (await screen.findByText("Design System")).closest("button")!;
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByText("Added")).toBeInTheDocument();
    fireEvent.click(row);
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("RepoSourcePopover — selected resources bar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceRepos.current = [];
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

  it("adds a chip when a scanned repo is checked", async () => {
    renderStateful();
    await openFleetTabAndScan();

    const row = (await screen.findByText("/home/dev/api")).closest("button")!;
    fireEvent.click(row);

    // The chip labels the repo by its basename, not the full remote URL.
    expect(
      await screen.findByRole("button", { name: "Remove api" }),
    ).toBeInTheDocument();
  });

  it("removing a chip drops the resource and unchecks the source row", async () => {
    renderStateful();
    await openFleetTabAndScan();

    const row = (await screen.findByText("/home/dev/api")).closest("button")!;
    fireEvent.click(row);

    const chipRemove = await screen.findByRole("button", { name: "Remove api" });
    expect(within(row).getByRole("checkbox")).toBeChecked();

    fireEvent.click(chipRemove);

    expect(
      screen.queryByRole("button", { name: "Remove api" }),
    ).not.toBeInTheDocument();
    expect(within(row).getByRole("checkbox")).not.toBeChecked();
  });

  it("keeps chips when switching tabs", async () => {
    renderStateful();

    // Attach an ad-hoc repo from the git tab's custom-URL form.
    const urlInput = screen.getByPlaceholderText(/owner\/repo/i);
    fireEvent.change(urlInput, {
      target: { value: "https://github.com/org/web.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(
      await screen.findByRole("button", { name: "Remove web" }),
    ).toBeInTheDocument();

    // The bar lives above the tabs, so the chip survives a tab switch.
    fireEvent.click(screen.getByRole("button", { name: /Reference project/i }));
    expect(
      screen.getByRole("button", { name: "Remove web" }),
    ).toBeInTheDocument();
  });

  const manyRepos = (n: number): CreateProjectResourceRequest[] =>
    Array.from({ length: n }, (_, i) => ({
      resource_type: "github_repo",
      resource_ref: { url: `https://github.com/org/repo-${i}.git` },
    }));

  it("folds overflow behind a +N affordance on the narrow tabs and collapses again", () => {
    renderStateful(manyRepos(8));

    // The default (git) tab is narrow, so only three chips render inline; the
    // remaining five collapse into "+5 more".
    expect(screen.getByRole("button", { name: "+5 more" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove repo-7" }),
    ).not.toBeInTheDocument();

    // Expanding reveals every chip plus a Collapse affordance...
    fireEvent.click(screen.getByRole("button", { name: "+5 more" }));
    expect(
      screen.getByRole("button", { name: "Remove repo-7" }),
    ).toBeInTheDocument();

    // ...and Collapse folds them back behind "+5 more".
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.getByRole("button", { name: "+5 more" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove repo-7" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a wider six-chip budget on the fleet tab", () => {
    renderStateful(manyRepos(8));

    // Git tab (narrow) collapses at three; switching to the wide fleet tab
    // lifts the inline budget to six, so only two overflow.
    expect(screen.getByRole("button", { name: "+5 more" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /From fleet/i }));
    expect(screen.getByRole("button", { name: "+2 more" })).toBeInTheDocument();
  });

  it("resets the expanded state when removals bring the list back within budget", () => {
    renderStateful(manyRepos(4));

    // Four repos overflow the narrow three-chip budget. Expand, then remove one
    // chip so only three remain (within budget).
    fireEvent.click(screen.getByRole("button", { name: "+1 more" }));
    expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove repo-0" }));

    // No overflow affordance while within budget.
    expect(
      screen.queryByRole("button", { name: "Collapse" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /more$/ }),
    ).not.toBeInTheDocument();

    // Re-adding a fourth repo starts collapsed again — the stale expanded state
    // was reset, so we see "+1 more" rather than the fully-expanded list.
    const urlInput = screen.getByPlaceholderText(/owner\/repo/i);
    fireEvent.change(urlInput, {
      target: { value: "https://github.com/org/repo-9.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("button", { name: "+1 more" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove repo-9" }),
    ).not.toBeInTheDocument();
  });
});

describe("RepoSourcePopover — detail flow (already attached)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceRepos.current = [{ url: "https://github.com/org/api.git" }];
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
      queryFn: () => Promise.resolve([]),
    });
  });

  it("marks an already-attached repo row as added and non-toggleable when onRemove is absent", () => {
    const onAdd = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <I18nWrapper>
        <QueryClientProvider client={queryClient}>
          <RepoSourcePopover
            resources={[
              {
                resource_type: "github_repo",
                resource_ref: { url: "https://github.com/org/api.git" },
              },
            ]}
            onAdd={onAdd}
          />
        </QueryClientProvider>
      </I18nWrapper>,
    );

    // Detail flow: no chips bar (onRemove omitted), and the attached row is
    // locked with an "Added" hint.
    const badge = screen.getByText("Added");
    const row = badge.closest("button")!;
    expect(row).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(row);
    expect(onAdd).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /^Remove / }),
    ).not.toBeInTheDocument();
  });

  it("marks an already-attached fleet scan row as added and non-toggleable when onRemove is absent", async () => {
    mockRuntimeListOptions.mockReturnValue({
      queryKey: ["runtimes", "ws-1", "list"],
      queryFn: () => Promise.resolve([MOCK_RUNTIME]),
    });
    mockResolveRuntimeDirectoryScan.mockResolvedValue({
      id: "rds-1",
      runtime_id: "runtime-1",
      status: "completed",
      params: { root: "~" },
      candidates: [REMOTE_CANDIDATE],
      supported: true,
      error: null,
      run_started_at: null,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
    });
    const onAdd = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <I18nWrapper>
        <QueryClientProvider client={queryClient}>
          <RepoSourcePopover
            resources={[
              {
                resource_type: "github_repo",
                resource_ref: { url: "git@github.com:org/api.git" },
              },
            ]}
            onAdd={onAdd}
          />
        </QueryClientProvider>
      </I18nWrapper>,
    );
    await openFleetTabAndScan();

    const row = (await screen.findByText("/home/dev/api")).closest("button")!;
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByText("Added")).toBeInTheDocument();
    fireEvent.click(row);
    expect(onAdd).not.toHaveBeenCalled();
  });
});
