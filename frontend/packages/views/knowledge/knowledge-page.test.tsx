// @vitest-environment jsdom

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type {
  KnowledgeRunDetail,
  KnowledgeSubmission,
  Project,
  RepositoryWikiSummary,
  WorkspaceDoc,
  WorkspaceRepository,
} from "@multiremi/core/types";
import enCommon from "../locales/en/common.json";
import enProjects from "../locales/en/projects.json";

const TEST_RESOURCES = { en: { common: enCommon, projects: enProjects } };

const state = vi.hoisted(() => ({
  projects: [] as unknown[],
  docs: [] as unknown[],
  memoryDocs: [] as unknown[],
  repositories: [] as unknown[],
  summaries: [] as unknown[],
  projectDetails: {} as Record<string, unknown>,
  backlinks: {} as Record<string, unknown[]>,
  repositoryDocs: {} as Record<string, unknown[]>,
  submissions: [] as unknown[],
  runs: [] as unknown[],
  runDetail: null as unknown,
  basePending: false,
  submissionsPending: false,
  runsPending: false,
  runDetailPending: false,
  baseError: null as unknown,
  submissionsError: null as unknown,
  runsError: null as unknown,
  observedQueries: [] as Array<{ key: readonly unknown[]; enabled: boolean | undefined }>,
}));
const refetchBase = vi.hoisted(() => vi.fn());
const refetchSubmissions = vi.hoisted(() => vi.fn());
const refetchRuns = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: (options: { queryKey: readonly unknown[] }) => {
    const key = options.queryKey;
    state.observedQueries.push({ key, enabled: (options as { enabled?: boolean }).enabled });
    if (key[0] === "knowledge") {
      const submissions = key[2] === "submissions";
      const runDetail = key[2] === "runs" && key.length > 3;
      return {
        data: submissions ? state.submissions : runDetail ? state.runDetail : state.runs,
        isPending: submissions ? state.submissionsPending : runDetail ? state.runDetailPending : state.runsPending,
        isError: (submissions ? state.submissionsError : state.runsError) !== null,
        error: submissions ? state.submissionsError : state.runsError,
        refetch: submissions ? refetchSubmissions : refetchRuns,
      };
    }
    if (key[0] === "repositories") {
      const summaries = key[2] === "wiki-summaries";
      const docs = key[3] === "wiki";
      return {
        data: summaries
          ? state.summaries
          : docs
            ? state.repositoryDocs[String(key[2])] ?? []
            : { repositories: state.repositories, total: state.repositories.length },
        isPending: state.basePending,
        isError: state.baseError !== null,
        error: state.baseError,
        refetch: refetchBase,
      };
    }
    if (key[0] === "project-docs") {
      return {
        data: state.projectDetails[String(key.at(-1))],
        isPending: state.basePending,
        isError: state.baseError !== null,
        error: state.baseError,
        refetch: refetchBase,
      };
    }
    if (key[0] === "wiki-backlinks") {
      return {
        data: state.backlinks[`${String(key[2])}:${String(key[3])}:${String(key[4])}`] ?? [],
        isPending: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    const projects = key[0] === "projects";
    const memoryDocs = key[0] === "workspace-docs" && key[1] === "memory";
    return {
      data: projects ? state.projects : memoryDocs ? state.memoryDocs : state.docs,
      isPending: state.basePending,
      isError: state.baseError !== null,
      error: state.baseError,
      refetch: refetchBase,
    };
  },
}));

vi.mock("@multiremi/core/project-docs", () => ({
  workspaceDocListOptions: (_workspaceId: string, input?: { kind?: string; includeBody?: boolean }) => ({
    queryKey: ["workspace-docs", input?.kind ?? "all", input?.includeBody ? "body" : "metadata"],
  }),
  projectDocDetailOptions: (_workspaceId: string, projectId: string, ref: string) => ({
    queryKey: ["project-docs", "ws-1", projectId, "detail", ref],
  }),
}));
vi.mock("@multiremi/core/knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/knowledge")>();
  return {
    ...actual,
    knowledgeSubmissionsOptions: () => ({ queryKey: ["knowledge", "ws-1", "submissions"] }),
    knowledgeRunsOptions: () => ({ queryKey: ["knowledge", "ws-1", "runs"] }),
    knowledgeRunOptions: (_workspaceId: string, runId: string | null | undefined) => ({
      queryKey: ["knowledge", "ws-1", "runs", runId ?? ""],
      enabled: Boolean(runId),
    }),
  };
});
vi.mock("@multiremi/core/projects/queries", () => ({
  projectListOptions: () => ({ queryKey: ["projects"] }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/ws/issues/${id}`,
    projectWiki: (id: string) => `/ws/projects/${id}/wiki`,
    projectWikiPage: (id: string, ref: string) => `/ws/projects/${id}/wiki/${ref}`,
    repositoryWiki: (id: string) => `/ws/repos/${id}/wiki`,
    repositoryWikiPage: (id: string, path: string) => `/ws/repos/${id}/wiki/${path}`,
    autopilotDetail: (id: string) => `/ws/autopilots/${id}`,
  }),
}));
vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (type: string, id: string) => `${type}:${id}`,
    getAgentName: (id: string) => `agent:${id}`,
  }),
}));
vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid="actor-avatar">{actorId}</span>,
}));
vi.mock("../common/task-transcript", () => ({
  TranscriptButton: ({ title }: { title: string }) => <button type="button">{title}</button>,
}));
vi.mock("../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => <div data-testid="wiki-body">{content}</div>,
}));
vi.mock("../projects/components/project-icon", () => ({
  ProjectIcon: ({ project }: { project: Project }) => <span>{project.icon ?? "folder"}</span>,
}));
vi.mock("../projects/components/labels", () => ({
  useFormatRelativeDate: () => (value: string) => `relative:${value}`,
}));
vi.mock("../projects/components/wiki/project-wiki-section", () => ({
  MemoryMarkers: ({ pinned, unverified }: { pinned: boolean; unverified: boolean }) => (
    <span>
      {pinned && <span role="img" aria-label="Pinned" />}
      {unverified && <span role="img" aria-label="Unverified history" />}
    </span>
  ),
}));
vi.mock("../navigation", () => ({
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@multiremi/ui/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));

import { KnowledgePage } from "./knowledge-page";

function project(partial: Partial<Project> & { id: string }): Project {
  return {
    workspace_id: "ws-1", title: "Untitled", description: null, instructions: "",
    instructions_revision: 0, instructions_updated_at: null, instructions_updated_by: null,
    icon: null, status: "planned", priority: "none", lead_type: null, lead_id: null,
    default_assignee_type: null, default_assignee_id: null, archived_at: null,
    created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
    issue_count: 0, done_count: 0, resource_count: 0, ...partial,
  };
}

function doc(partial: Partial<WorkspaceDoc> & { id: string }): WorkspaceDoc {
  return {
    project_id: "proj-1", project_title: "Apollo", workspace_id: "ws-1", kind: "wiki",
    slug: partial.id, path: `${partial.id}.md`, title: "Untitled", summary: null, body: "",
    tags: [], pinned: false, refs: [], source_task_id: null, source_issue_id: null,
    author_type: null, author_id: null, updated_by_type: null, updated_by_id: null,
    version: 1, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
    ...partial,
    compilation_run_id: partial.compilation_run_id ?? null,
  };
}

function repository(partial: Partial<WorkspaceRepository> & { id: string }): WorkspaceRepository {
  return {
    name: "repo", url: "https://example.com/repo.git", source: "github", description: null,
    default_branch: "main", imported_at: null, updated_at: null, ...partial,
  };
}

function summary(partial: Partial<RepositoryWikiSummary> & { repository_id: string }): RepositoryWikiSummary {
  return {
    repository_name: "repo", status: "healthy", status_message: null, source_revision: null,
    page_count: 0, updated_at: null, build: null, ...partial,
  };
}

function submission(partial: Partial<KnowledgeSubmission> & { id: string }): KnowledgeSubmission {
  return {
    workspace_id: "ws-1", project_id: "proj-1", repository_id: null, scope: "memory",
    source_type: "agent", proposed_path: null, proposed_slug: null, body: "raw body", patch: null,
    base_revision: null, source_task_id: null, source_issue_id: null, source_revision: null,
    author_agent_id: null, content_sha256: "sha", status: "pending",
    created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z",
    source_issue: null, author_agent: null, source_task: null, ...partial,
  };
}

function runDetail(partial: Partial<KnowledgeRunDetail> = {}): KnowledgeRunDetail {
  return {
    run: {
      id: "krun-1", workspace_id: "ws-1", project_id: "proj-1", repository_id: null,
      task_id: "task-atlas", agent_id: "agent-atlas", autopilot_run_id: null,
      mode: "issue_ingest", status: "published", result_summary: "Merged two Raw inputs",
      dedupe_key: "batch-1", created_at: "2026-08-31T01:00:00Z", completed_at: "2026-08-31T01:01:00Z",
      agent: { id: "agent-atlas", name: "Atlas" }, provenance: null,
    },
    sources: [],
    outputs: [],
    ...partial,
  };
}

function renderPage() {
  return render(<I18nProvider locale="en" resources={TEST_RESOURCES}><KnowledgePage /></I18nProvider>);
}

describe("KnowledgePage", () => {
  beforeEach(() => {
    Object.assign(state, {
      projects: [], docs: [], memoryDocs: [], repositories: [], summaries: [], projectDetails: {}, backlinks: {}, repositoryDocs: {},
      submissions: [], runs: [], runDetail: null,
      basePending: false, submissionsPending: false, runsPending: false, runDetailPending: false,
      baseError: null, submissionsError: null, runsError: null,
    });
    refetchBase.mockClear();
    refetchSubmissions.mockClear();
    refetchRuns.mockClear();
    state.observedQueries.length = 0;
  });

  it("renders four peer knowledge views", () => {
    renderPage();
    expect(screen.getByRole("tab", { name: /Wiki/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Raw/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Memory/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Compilation runs/ })).toBeInTheDocument();
  });

  it("does not request Raw or compilation data on the Wiki landing view", () => {
    renderPage();
    expect(state.observedQueries.find(({ key }) => key[0] === "knowledge" && key[2] === "submissions")?.enabled).toBe(false);
    expect(state.observedQueries.find(({ key }) => key[0] === "knowledge" && key[2] === "runs")?.enabled).toBe(false);
    expect(state.observedQueries.some(({ key, enabled }) => (
      key[0] === "workspace-docs" && key[2] === "body" && enabled !== false
    ))).toBe(false);
  });

  it("keeps the Wiki pane loading until its formal sources resolve", () => {
    state.basePending = true;
    renderPage();
    expect(screen.getByTestId("knowledge-loading")).toBeInTheDocument();
  });

  it("browses Project Wiki and Repository Wiki as separate formal sources", () => {
    state.projects = [project({ id: "proj-1", title: "Apollo" })];
    state.docs = [
      doc({ id: "schema", slug: "_schema", title: "Schema" }),
      doc({ id: "memory", kind: "memory", title: "Agent-only memory" }),
      doc({ id: "index", slug: "index", path: "index.md", title: "Reading map", body: "" }),
      doc({ id: "runbook", slug: "runbook", path: "operations/runbook.md", title: "Deployment runbook", body: "" }),
    ];
    state.projectDetails.index = doc({ id: "index", slug: "index", path: "index.md", title: "Reading map", body: "Project Wiki index body. See [[operations/runbook.md]]." });
    state.projectDetails.runbook = doc({ id: "runbook", slug: "runbook", path: "operations/runbook.md", title: "Deployment runbook", body: "Return to [[index]]." });
    state.backlinks["project:proj-1:index"] = [state.projectDetails.runbook!];
    state.repositories = [repository({ id: "repo-1", name: "web" })];
    state.summaries = [summary({ repository_id: "repo-1", page_count: 3 })];
    state.repositoryDocs["repo-1"] = [
      doc({ id: "repo-index", slug: "index", path: "index.md", title: "Repository map", body: "Repository Wiki index body. See [[overview.md]]." }),
      doc({ id: "repo-overview", slug: "overview", path: "overview.md", title: "Overview", body: "Return to [[index.md]]." }),
      doc({ id: "repo-log", slug: "log", path: "log.md", title: "Change log" }),
    ];
    renderPage();

    const projectSource = screen.getByTestId("knowledge-project-proj-1");
    expect(projectSource).toHaveTextContent("Apollo");
    expect(projectSource).toHaveTextContent("2");
    expect(screen.getByTestId("wiki-body")).toHaveTextContent(
      "Project Wiki index body. See [Deployment runbook](/ws/projects/proj-1/wiki/runbook).",
    );
    expect(screen.getByRole("group", { name: "References" })).toHaveTextContent("Deployment runbook");
    expect(screen.getByRole("group", { name: "Referenced by" })).toHaveTextContent("Deployment runbook");
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Repositories")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Full page/ })).toHaveAttribute("href", "/ws/projects/proj-1/wiki/index");
    expect(screen.queryByText("Agent-only memory")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("knowledge-repository-repo-1"));
    expect(screen.getByTestId("wiki-body")).toHaveTextContent(
      "Repository Wiki index body. See [Overview](/ws/repos/repo-1/wiki/overview.md).",
    );
    expect(screen.getByRole("group", { name: "References" })).toHaveTextContent("Overview");
    expect(screen.getByRole("group", { name: "Referenced by" })).toHaveTextContent("Overview");
    expect(screen.getByRole("link", { name: /Full page/ })).toHaveAttribute("href", "/ws/repos/repo-1/wiki/index.md");
  });

  it("groups same-named project and repository sources under distinct headings", () => {
    state.projects = [project({ id: "proj-remi", title: "Remi" })];
    state.docs = [
      doc({ id: "project-index", project_id: "proj-remi", project_title: "Remi", path: "index.md" }),
    ];
    state.projectDetails["project-index"] = state.docs[0];
    state.repositories = [repository({ id: "repo-remi", name: "Remi" })];
    state.summaries = [summary({ repository_id: "repo-remi", page_count: 1 })];

    renderPage();

    const scope = screen.getByText("Knowledge scope").parentElement!;
    expect(within(scope).getByText("Projects")).toBeInTheDocument();
    expect(within(scope).getByText("Repositories")).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-project-proj-remi")).toHaveTextContent("Remi");
    expect(screen.getByTestId("knowledge-repository-repo-remi")).toHaveTextContent("Remi");
  });

  it("shows only formal memory in Memory and keeps memory Raw in Raw", () => {
    state.projects = [project({ id: "proj-1", title: "Apollo" })];
    state.memoryDocs = [doc({ id: "formal", kind: "memory", title: "Formal memory" })];
    state.submissions = [submission({ id: "raw-memory", body: "Memory waiting for Atlas" })];
    renderPage();

    fireEvent.click(screen.getByRole("tab", { name: /Memory/ }));
    expect(screen.getByRole("heading", { name: "Formal memory" })).toBeInTheDocument();
    expect(screen.queryByText("Memory waiting for Atlas")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Raw/ }));
    expect(screen.getByRole("button", { name: "Memory waiting for Atlas" })).toBeInTheDocument();
    expect(screen.queryByText("Formal memory")).not.toBeInTheDocument();
  });

  it("renders memory scope, directory, and full detail with Wiki links resolved", () => {
    const longBody = `Read [[runbook]].\n${"Full memory detail. ".repeat(30)}`;
    state.projects = [
      project({ id: "proj-1", title: "Apollo" }),
      project({ id: "proj-empty", title: "Empty project" }),
    ];
    state.docs = [
      doc({ id: "wiki-runbook", slug: "runbook", title: "Runbook", body: "" }),
    ];
    state.memoryDocs = [
      doc({
        id: "memory-full",
        kind: "memory",
        slug: "full-memory",
        title: "Full memory",
        summary: "A concise summary",
        body: longBody,
        pinned: true,
        source_issue_id: "issue-7",
        version: 3,
      }),
    ];

    const { container } = renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Memory/ }));

    expect(screen.getByTestId("knowledge-memory-project-proj-1")).toHaveTextContent("Apollo1");
    expect(screen.queryByTestId("knowledge-memory-project-proj-empty")).not.toBeInTheDocument();
    const directory = screen.getByRole("navigation", { name: "Directory" });
    expect(within(directory).getByRole("button", { name: "Full memory" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Full memory" })).toBeInTheDocument();
    expect(screen.getByText("A concise summary")).toBeInTheDocument();
    expect(screen.getByTestId("wiki-body")).toHaveTextContent("[Runbook](/ws/projects/proj-1/wiki/runbook)");
    expect(screen.getByTestId("wiki-body")).toHaveTextContent("Full memory detail.");
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Full page/ })).toHaveAttribute("href", "/ws/projects/proj-1/wiki/full-memory");
    expect(screen.getByRole("link", { name: "Source issue" })).toHaveAttribute("href", "/ws/issues/issue-7");
    expect(container.querySelector(".lg\\:grid-cols-\\[220px_280px_minmax\\(0\\,1fr\\)\\]")).toBeInTheDocument();
    expect(state.observedQueries.some(({ key, enabled }) => (
      key[0] === "workspace-docs"
      && key[1] === "all"
      && key[2] === "metadata"
      && enabled === true
    ))).toBe(true);
  });

  it("switches the memory detail when another directory entry is selected", () => {
    state.projects = [project({ id: "proj-1", title: "Apollo" })];
    state.memoryDocs = [
      doc({
        id: "memory-first",
        kind: "memory",
        title: "Pinned memory",
        body: "Pinned body",
        pinned: true,
        updated_at: "2026-07-01T00:00:00Z",
      }),
      doc({
        id: "memory-second",
        kind: "memory",
        title: "Recent memory",
        body: "Recent body",
        updated_at: "2026-07-09T00:00:00Z",
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Memory/ }));
    expect(screen.getByTestId("wiki-body")).toHaveTextContent("Pinned body");

    fireEvent.click(screen.getByRole("button", { name: "Recent memory" }));

    expect(screen.getByRole("heading", { name: "Recent memory" })).toBeInTheDocument();
    expect(screen.getByTestId("wiki-body")).toHaveTextContent("Recent body");
  });

  it("filters only the memory directory and restores it when search is cleared", async () => {
    const user = userEvent.setup();
    state.projects = [project({ id: "proj-1", title: "Apollo" })];
    state.memoryDocs = [
      doc({ id: "memory-deploy", kind: "memory", title: "Deploy fact", body: "Use the release job." }),
      doc({ id: "memory-local", kind: "memory", title: "Local database", body: "Port 5432." }),
    ];

    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Memory/ }));
    const input = screen.getByPlaceholderText("Search formal memory...");
    const directory = screen.getByRole("navigation", { name: "Directory" });

    await user.type(input, "database");
    expect(screen.getByTestId("knowledge-memory-project-proj-1")).toBeInTheDocument();
    expect(within(directory).queryByRole("button", { name: "Deploy fact" })).not.toBeInTheDocument();
    expect(within(directory).getByRole("button", { name: "Local database" })).toBeInTheDocument();
    expect(screen.getByTestId("wiki-body")).toHaveTextContent("Port 5432.");

    await user.clear(input);
    await user.type(input, "missing");
    expect(within(directory).getByText("Nothing matches your search")).toBeInTheDocument();

    await user.clear(input);
    expect(within(directory).getByRole("button", { name: "Deploy fact" })).toBeInTheDocument();
    expect(within(directory).getByRole("button", { name: "Local database" })).toBeInTheDocument();
  });

  it("renders Raw source, issue, agent, proposed target, and status", () => {
    state.submissions = [submission({
      id: "ksub-1", scope: "project_wiki", proposed_path: "guides/deploy.md", status: "processing",
      source_issue_id: "issue-1", source_issue: { id: "issue-1", key: "MUL-213", title: "Knowledge chain" },
      author_agent_id: "agent-1", author_agent: { id: "agent-1", name: "Executor" },
    })];
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Raw/ }));

    expect(screen.getByText("agent")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "MUL-213" })).toHaveAttribute("href", "/ws/issues/issue-1");
    expect(screen.getByText("Executor")).toBeInTheDocument();
    expect(screen.getByText("guides/deploy.md")).toBeInTheDocument();
    expect(screen.getByText("processing")).toBeInTheDocument();
  });

  it("pairs the truncated Raw preview with its complete tooltip content", () => {
    const body = "A complete Raw submission body that is intentionally longer than the table preview.";
    state.submissions = [submission({ id: "ksub-long", body })];
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Raw/ }));

    const preview = screen.getByRole("button", { name: body });
    expect(preview).toHaveClass("truncate");
    expect(screen.getByRole("tooltip")).toHaveTextContent(body);
  });

  it("renders a compilation run with multiple Raw inputs and multiple outputs", () => {
    const detail = runDetail({
      run: {
        ...runDetail().run,
        provenance: {
          automation_id: "auto-wiki",
          automation_title: "Repository Wiki maintenance",
          automation_run_id: "run-auto-1",
          automation_source: "scm_event",
          event_type: "change.merged",
          repository_id: "repo-1",
          repository_name: "web",
          change_number: 42,
          change_title: "Refresh architecture docs",
          change_url: "https://example.com/pull/42",
          target_branch: "main",
          source_revision: "abcdef123456",
          occurred_at: "2026-08-31T00:59:00Z",
        },
      },
      sources: [
        { id: "src-1", run_id: "krun-1", submission_id: "raw-1", source_type: "submission", source_ref: null, metadata: {}, created_at: "", submission: null },
        { id: "src-2", run_id: "krun-1", submission_id: "raw-2", source_type: "submission", source_ref: null, metadata: {}, created_at: "", submission: null },
      ],
      outputs: [
        { id: "out-1", run_id: "krun-1", artifact_scope: "project_wiki", doc_id: "doc-1", revision_id: "rev-1", version: 2, action: "merge", content_sha256: null, created_at: "", artifact: { id: "doc-1", title: "Overview", path: "overview.md" } },
        { id: "out-2", run_id: "krun-1", artifact_scope: "memory", doc_id: "doc-2", revision_id: "rev-2", version: 1, action: "split", content_sha256: null, created_at: "", artifact: { id: "doc-2", title: "Runtime fact", path: "runtime-fact.md" } },
      ],
    });
    state.runs = [detail];
    state.runDetail = {
      ...detail,
      sources: detail.sources.map((source, index) => ({
        ...source,
        submission: submission({ id: source.submission_id ?? `raw-${index}`, body: `Complete Raw input ${index + 1}` }),
      })),
    };
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Compilation runs/ }));

    expect(screen.getByText("Atlas")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Repository Wiki maintenance" })).toHaveAttribute("href", "/ws/autopilots/auto-wiki");
    expect(screen.getByRole("link", { name: "#42 Refresh architecture docs" })).toHaveAttribute("href", "https://example.com/pull/42");
    expect(screen.getByText("main · abcdef1")).toBeInTheDocument();
    expect(screen.getByText("PR/MR merged")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View run log" })).toBeInTheDocument();
    expect(screen.getByText("raw-1")).toBeInTheDocument();
    expect(screen.getByText("raw-2")).toBeInTheDocument();
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("Runtime fact")).toBeInTheDocument();
    expect(screen.getByText("Merged two Raw inputs")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View run log" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Run details");
    expect(screen.getByRole("dialog")).toHaveTextContent("Repository Wiki maintenance");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Code to Wiki");
    expect(screen.getByRole("dialog")).toHaveTextContent("Complete Raw input 1");
    expect(screen.getByRole("dialog")).toHaveTextContent("Agent transcript");
    expect(screen.getByRole("dialog")).toHaveTextContent("Formal outputs · 2");
  });

  it("searches within the active formal view", async () => {
    const user = userEvent.setup();
    state.projects = [project({ id: "proj-1", title: "Apollo" }), project({ id: "proj-2", title: "Borealis" })];
    state.docs = [
      doc({ id: "runbook", path: "operations/deploy.md", title: "Deployment runbook" }),
      doc({ id: "release", path: "operations/release.md", title: "Release checklist" }),
      doc({ id: "borealis", project_id: "proj-2", project_title: "Borealis", path: "index.md", title: "Borealis index" }),
    ];
    state.projectDetails.runbook = doc({ id: "runbook", path: "operations/deploy.md", title: "Deployment runbook" });
    renderPage();
    const input = screen.getByPlaceholderText("Search Project or Repository Wiki...");
    await user.type(input, "deployment");
    expect(screen.getByText("Apollo")).toBeInTheDocument();
    expect(screen.getByText("Borealis")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Deployment runbook/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Release checklist/ })).not.toBeInTheDocument();
    expect(state.observedQueries.some(({ key, enabled }) => (
      key[0] === "workspace-docs" && key[2] === "body" && enabled !== false
    ))).toBe(false);
  });

  it("retries only the active control-plane query", () => {
    state.submissionsError = new Error("raw unavailable");
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Raw/ }));
    expect(screen.getByText("raw unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetchSubmissions).toHaveBeenCalledTimes(1);
    expect(refetchBase).not.toHaveBeenCalled();
  });
});
