// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { Project, WorkspaceDoc } from "@multiremi/core/types";
import enCommon from "../locales/en/common.json";
import enProjects from "../locales/en/projects.json";

const TEST_RESOURCES = { en: { common: enCommon, projects: enProjects } };

const state = vi.hoisted(() => ({
  projects: [] as unknown[],
  docs: [] as unknown[],
  projectsPending: false,
  docsPending: false,
  projectsError: null as unknown,
  docsError: null as unknown,
}));
const refetchProjects = vi.hoisted(() => vi.fn());
const refetchDocs = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  queryOptions: <T,>(options: T) => options,
  useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: (options: { queryKey: string[] }) => {
    if (options.queryKey[0] === "repositories") {
      if (options.queryKey[2] === "atlas") {
        return {
          data: {
            state: "ready",
            configured: true,
            required_plugin: "code-to-wiki",
            plugin_id: "apl-1",
            plugin_bound: true,
            agent_id: "agent-atlas",
            repository_autopilot_id: "auto-repo",
            repository_trigger_id: "trigger-repo",
            project_autopilot_id: "auto-project",
            project_trigger_id: "trigger-project",
          },
          isPending: false,
          isError: false,
          error: null,
        };
      }
      const isWiki = options.queryKey[2] === "wiki-summaries";
      return { data: isWiki ? [] : { repositories: [], total: 0 }, isPending: false, isError: false, error: null, refetch: vi.fn() };
    }
    const isProjects = options.queryKey[0] === "projects";
    const pending = isProjects ? state.projectsPending : state.docsPending;
    const error = isProjects ? state.projectsError : state.docsError;
    return {
      data: pending ? undefined : isProjects ? state.projects : state.docs,
      isPending: pending,
      isError: error !== null,
      error,
      refetch: isProjects ? refetchProjects : refetchDocs,
    };
  },
}));

vi.mock("@multiremi/core/project-docs", () => ({
  workspaceDocListOptions: () => ({ queryKey: ["workspace-docs"] }),
}));

vi.mock("@multiremi/core/projects/queries", () => ({
  projectListOptions: () => ({ queryKey: ["projects"] }),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    projectWiki: (id: string) => `/ws/projects/${id}/wiki`,
    repositoryWiki: (id: string) => `/ws/repos/${id}/wiki`,
    plugins: () => "/ws/plugins",
    agentDetail: (id: string) => `/ws/agents/${id}`,
    autopilotDetail: (id: string) => `/ws/autopilots/${id}`,
  }),
}));

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (type: string, id: string) => `${type}:${id}`,
  }),
}));

vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid="actor-avatar">{actorId}</span>
  ),
}));

vi.mock("../projects/components/project-icon", () => ({
  ProjectIcon: ({ project }: { project: Project }) => (
    <span>{project.icon ?? "folder"}</span>
  ),
}));

vi.mock("../projects/components/labels", () => ({
  useFormatRelativeDate: () => (value: string) => `relative:${value}`,
}));

vi.mock("../navigation", () => ({
  AppLink: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { KnowledgePage } from "./knowledge-page";

function project(partial: Partial<Project> & { id: string }): Project {
  return {
    workspace_id: "ws-1",
    title: "Untitled",
    description: null,
    instructions: "",
    instructions_revision: 0,
    instructions_updated_at: null,
    instructions_updated_by: null,
    icon: null,
    status: "planned",
    priority: "none",
    lead_type: null,
    lead_id: null,
    default_assignee_type: null,
    default_assignee_id: null,
    archived_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    issue_count: 0,
    done_count: 0,
    resource_count: 0,
    ...partial,
  };
}

function doc(partial: Partial<WorkspaceDoc> & { id: string }): WorkspaceDoc {
  return {
    project_id: "proj-1",
    project_title: "Apollo",
    workspace_id: "ws-1",
    kind: "wiki",
    slug: partial.id,
    title: "Untitled",
    summary: null,
    body: "",
    tags: [],
    pinned: false,
    refs: [],
    source_task_id: null,
    source_issue_id: null,
    author_type: null,
    author_id: null,
    updated_by_type: null,
    updated_by_id: null,
    version: 1,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...partial,
  };
}

function renderPage() {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <KnowledgePage />
    </I18nProvider>,
  );
}

describe("KnowledgePage", () => {
  beforeEach(() => {
    state.projects = [];
    state.docs = [];
    state.projectsPending = false;
    state.docsPending = false;
    state.projectsError = null;
    state.docsError = null;
    refetchProjects.mockClear();
    refetchDocs.mockClear();
  });

  it("keeps the loading state until both queries resolve", () => {
    state.docsPending = true;
    state.projects = [project({ id: "proj-1", title: "Apollo" })];
    renderPage();
    expect(screen.getByTestId("knowledge-loading")).toBeInTheDocument();
    expect(screen.queryByText("Apollo")).not.toBeInTheDocument();
  });

  it("shows either query error and retries both data sources", () => {
    state.projectsError = new Error("network down");
    renderPage();
    expect(screen.getByText("Couldn't load the knowledge base")).toBeInTheDocument();
    expect(screen.getByText("network down")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetchProjects).toHaveBeenCalledTimes(1);
    expect(refetchDocs).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state only when the workspace has no projects", () => {
    renderPage();
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Search projects, Wiki, or memory..."),
    ).not.toBeInTheDocument();
  });

  it("renders one linked summary row per project, including projects without knowledge", () => {
    state.projects = [
      project({
        id: "proj-1",
        title: "Apollo",
        lead_type: "member",
        lead_id: "member-7",
      }),
      project({ id: "proj-2", title: "Borealis" }),
    ];
    state.docs = [
      doc({ id: "schema", slug: "_schema" }),
      doc({ id: "memory-1", kind: "memory" }),
      doc({ id: "memory-2", kind: "memory" }),
    ];
    renderPage();

    const apollo = screen.getByTestId("knowledge-project-proj-1");
    expect(apollo).toHaveAttribute("href", "/ws/projects/proj-1/wiki");
    expect(apollo).toHaveTextContent("Apollo");
    expect(apollo).toHaveTextContent("member:member-7");
    expect(within(apollo).getAllByLabelText("Wiki: 0")).toHaveLength(2);
    expect(within(apollo).getAllByLabelText("Agent memory: 2")).toHaveLength(2);
    expect(screen.getByTestId("knowledge-project-proj-2")).toHaveTextContent(
      "Borealis",
    );
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("orders projects by latest knowledge and keeps empty projects last", () => {
    state.projects = [
      project({ id: "proj-1", title: "Apollo" }),
      project({ id: "proj-2", title: "Borealis" }),
      project({ id: "proj-3", title: "Cygnus" }),
    ];
    state.docs = [
      doc({ id: "old", updated_at: "2026-07-01T00:00:00Z" }),
      doc({
        id: "new",
        project_id: "proj-2",
        project_title: "Borealis",
        updated_at: "2026-07-03T00:00:00Z",
      }),
    ];
    renderPage();

    let rows = screen.getAllByTestId(/knowledge-project-/);
    expect(rows[0]).toHaveTextContent("Borealis");
    expect(rows[1]).toHaveTextContent("Apollo");
    expect(rows[2]).toHaveTextContent("Cygnus");

    fireEvent.click(screen.getByRole("button", { name: "Recently updated" }));
    rows = screen.getAllByTestId(/knowledge-project-/);
    expect(rows[0]).toHaveTextContent("Apollo");
    expect(rows[1]).toHaveTextContent("Borealis");
    expect(rows[2]).toHaveTextContent("Cygnus");
  });

  it("searches project fields and document content without expanding documents", async () => {
    const user = userEvent.setup();
    state.projects = [
      project({ id: "proj-1", title: "Apollo" }),
      project({ id: "proj-2", title: "Borealis" }),
    ];
    state.docs = [
      doc({ id: "runbook", title: "Deployment runbook" }),
      doc({
        id: "memory",
        project_id: "proj-2",
        project_title: "Borealis",
        kind: "memory",
        title: "ARM builder",
        body: "Runs on arm64",
      }),
    ];
    renderPage();

    const input = screen.getByPlaceholderText("Search projects, Wiki, or memory...");
    await user.type(input, "arm64");
    expect(screen.getByText("Borealis")).toBeInTheDocument();
    expect(screen.queryByText("Apollo")).not.toBeInTheDocument();
    expect(screen.queryByText("ARM builder")).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "nothing here");
    expect(screen.getByText("Nothing matches your search")).toBeInTheDocument();
  });
});
