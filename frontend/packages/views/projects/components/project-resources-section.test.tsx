// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { ProjectResource } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enProjects from "../../locales/en/projects.json";

const TEST_RESOURCES = {
  en: { common: enCommon, projects: enProjects },
};

const state = vi.hoisted(() => ({
  resources: [] as unknown[],
  projects: [] as unknown[],
  projectsLoaded: true,
}));
const mockDelete = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options?: { queryKey?: readonly unknown[] }) => {
    const key = options?.queryKey;
    if (Array.isArray(key) && key[0] === "projects") {
      return { data: state.projects, isSuccess: state.projectsLoaded };
    }
    return { data: state.resources };
  },
}));

vi.mock("@multiremi/core/projects", () => ({
  projectResourcesOptions: () => ({ queryKey: ["projectResources"] }),
  useCreateProjectResource: () => ({ mutateAsync: vi.fn() }),
  useUpdateProjectResource: () => ({ mutateAsync: vi.fn() }),
  useDeleteProjectResource: () => ({ mutateAsync: mockDelete }),
}));

vi.mock("@multiremi/core/projects/queries", () => ({
  projectListOptions: () => ({ queryKey: ["projects"] }),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    projectDetail: (id: string) => `/ws/projects/${id}`,
  }),
}));

vi.mock("../../platform", () => ({
  isDesktopShell: () => false,
  useLocalDaemonStatus: () => ({
    daemonId: null,
    deviceName: null,
    running: false,
  }),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// The add-flow popover is exercised in repo-source-popover.test.tsx; stub it
// so this suite stays focused on how attached rows render.
vi.mock("./repo-source-popover", () => ({
  RepoSourcePopover: () => <div data-testid="repo-source-popover" />,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ProjectResourcesSection } from "./project-resources-section";

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function projectRefResource(projectId: string, id = "res-1"): ProjectResource {
  return {
    id,
    project_id: "proj-self",
    workspace_id: "ws-1",
    resource_type: "project_ref",
    resource_ref: { project_id: projectId },
    label: null,
    position: 0,
    created_at: "2026-04-16T00:00:00Z",
    created_by: null,
  };
}

function renderSection() {
  render(
    <I18nWrapper>
      <ProjectResourcesSection projectId="proj-self" />
    </I18nWrapper>,
  );
}

describe("ProjectResourcesSection — project_ref rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.resources = [];
    state.projects = [];
    state.projectsLoaded = true;
  });

  it("renders a project_ref row linking to the referenced project", () => {
    state.resources = [projectRefResource("proj-target")];
    state.projects = [{ id: "proj-target", title: "Backend", icon: "🛠️" }];

    renderSection();

    const link = screen.getByRole("link", { name: "Backend" });
    expect(link).toHaveAttribute("href", "/ws/projects/proj-target");
  });

  it("falls back to a deleted label when the referenced project is gone", () => {
    state.resources = [projectRefResource("proj-missing")];
    state.projects = []; // target was deleted
    state.projectsLoaded = true; // query resolved — the id is genuinely absent

    renderSection();

    expect(screen.getByText("Deleted project")).toBeInTheDocument();
    // A dangling reference is still removable.
    expect(screen.getByTitle("Remove")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows a loading placeholder, not the deleted label, before the project list resolves", () => {
    state.resources = [projectRefResource("proj-target")];
    state.projects = []; // cold cache — list hasn't resolved yet
    state.projectsLoaded = false;

    renderSection();

    // A live ref must not flash "Deleted project" while the list is loading.
    expect(screen.queryByText("Deleted project")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    // A muted placeholder stands in until the query succeeds.
    expect(screen.getByTestId("project-ref-loading")).toBeInTheDocument();
    // The row stays removable while loading.
    expect(screen.getByTitle("Remove")).toBeInTheDocument();
  });

  it("removes a project_ref through the trash button", async () => {
    state.resources = [projectRefResource("proj-target", "res-42")];
    state.projects = [{ id: "proj-target", title: "Backend", icon: "🛠️" }];

    renderSection();

    fireEvent.click(screen.getByTitle("Remove"));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("res-42"));
  });
});
