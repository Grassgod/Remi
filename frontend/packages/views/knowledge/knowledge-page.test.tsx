// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { WorkspaceDoc } from "@multiremi/core/types";
import enCommon from "../locales/en/common.json";
import enProjects from "../locales/en/projects.json";

const TEST_RESOURCES = {
  en: { common: enCommon, projects: enProjects },
};

const state = vi.hoisted(() => ({
  docs: [] as unknown[],
  isPending: false,
  isError: false,
  error: null as unknown,
}));
const refetch = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: state.isPending ? undefined : state.docs,
    isPending: state.isPending,
    isError: state.isError,
    error: state.error,
    refetch,
  }),
}));

// The shared MemoryCard comes from the wiki section, which pulls the
// per-project options in through the same module.
vi.mock("@multiremi/core/project-docs", () => ({
  workspaceDocListOptions: () => ({ queryKey: ["workspace-docs"] }),
  projectDocListOptions: () => ({ queryKey: ["project-docs"] }),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/ws/issues/${id}`,
    projectWiki: (id: string) => `/ws/projects/${id}/wiki`,
    projectWikiPage: (id: string, ref: string) =>
      `/ws/projects/${id}/wiki/${ref}`,
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

vi.mock("../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => (
    <div data-testid="doc-body">{content}</div>
  ),
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

function doc(
  partial: Partial<WorkspaceDoc> & { id: string },
): WorkspaceDoc {
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
    state.docs = [];
    state.isPending = false;
    state.isError = false;
    state.error = null;
    refetch.mockClear();
  });

  it("shows a skeleton while the docs query is still pending, never the empty state", () => {
    state.isPending = true;

    renderPage();

    expect(screen.getByTestId("knowledge-loading")).toBeInTheDocument();
    expect(screen.queryByText("No knowledge yet")).not.toBeInTheDocument();
  });

  it("shows a retryable error state when the docs query fails", () => {
    state.isError = true;
    state.error = new Error("network down");

    renderPage();

    expect(
      screen.getByText("Couldn't load the knowledge base"),
    ).toBeInTheDocument();
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.queryByText("No knowledge yet")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the generic hint when the error carries no message", () => {
    state.isError = true;
    state.error = "boom";

    renderPage();

    expect(
      screen.getByText(
        "Something went wrong fetching this workspace's wiki and memory.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the empty state when the workspace has no knowledge yet", () => {
    renderPage();

    expect(screen.getByText("No knowledge yet")).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Search all knowledge..."),
    ).not.toBeInTheDocument();
  });

  it("groups docs by project in response order, each header linking to that project's wiki", () => {
    state.docs = [
      doc({ id: "d1", project_id: "proj-2", project_title: "Borealis" }),
      doc({ id: "d2", slug: "runbook", title: "Runbook" }),
      doc({ id: "d3", project_id: "proj-2", project_title: "Borealis" }),
      doc({ id: "d4", kind: "memory", title: "Build takes 4 minutes" }),
    ];

    renderPage();

    const headers = screen.getAllByRole("link", { name: /Borealis|Apollo/ });
    expect(headers.map((el) => el.textContent)).toEqual([
      "Borealis",
      "Apollo",
    ]);
    expect(headers.map((el) => el.getAttribute("href"))).toEqual([
      "/ws/projects/proj-2/wiki",
      "/ws/projects/proj-1/wiki",
    ]);
    // The project a doc belongs to decides its group, not the section it is
    // rendered under: both Borealis rows sit above the Apollo ones.
    expect(screen.getByText("Build takes 4 minutes")).toBeInTheDocument();
  });

  it("deep-links every wiki row, _schema included, falling back to the id when the slug is empty", () => {
    state.docs = [
      doc({
        id: "d1",
        slug: "_schema",
        title: "Wiki Schema",
        summary: "How pages are structured",
      }),
      doc({ id: "d2", slug: "", title: "Slugless" }),
    ];

    renderPage();

    expect(screen.getByRole("link", { name: /Wiki Schema/ })).toHaveAttribute(
      "href",
      "/ws/projects/proj-1/wiki/_schema",
    );
    expect(screen.getByText("How pages are structured")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Slugless" })).toHaveAttribute(
      "href",
      "/ws/projects/proj-1/wiki/d2",
    );
  });

  it("renders memory entries through the shared memory card, resolving [[slug]] against the same project", () => {
    state.docs = [
      doc({
        id: "d1",
        kind: "memory",
        title: "Build takes 4 minutes",
        body: "Deploy steps live in [[runbook]].",
        pinned: true,
        author_type: "agent",
        author_id: "agent-7",
        source_issue_id: "MUL-42",
      }),
      doc({ id: "d2", slug: "runbook", title: "Runbook" }),
    ];

    renderPage();

    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("agent:agent-7")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Source issue" })).toHaveAttribute(
      "href",
      "/ws/issues/MUL-42",
    );
    expect(screen.getByTestId("doc-body").textContent).toBe(
      "Deploy steps live in [Runbook](/ws/projects/proj-1/wiki/runbook).",
    );
  });

  it("filters on title, summary, body and tags, and says so when nothing matches", async () => {
    const user = userEvent.setup();
    state.docs = [
      doc({ id: "d1", slug: "runbook", title: "Runbook" }),
      doc({ id: "d2", slug: "arm", title: "CI", summary: "The box is arm64" }),
      doc({ id: "d3", kind: "memory", title: "Note", body: "arm64 only" }),
      doc({ id: "d4", slug: "tagged", title: "Tagged", tags: ["arm64"] }),
    ];

    renderPage();

    const input = screen.getByPlaceholderText("Search all knowledge...");
    await user.type(input, "ARM64");

    expect(screen.getByRole("link", { name: /CI/ })).toBeInTheDocument();
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tagged" })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Runbook" }),
    ).not.toBeInTheDocument();
    // The project header survives as long as one of its docs matches.
    expect(screen.getByRole("link", { name: "Apollo" })).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "nothing here");

    expect(screen.getByText("Nothing matches your search")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Apollo" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a [[slug]] link alive while the page it points at is filtered out", async () => {
    const user = userEvent.setup();
    state.docs = [
      doc({
        id: "d1",
        kind: "memory",
        title: "Deploy note",
        body: "See [[runbook]].",
      }),
      doc({ id: "d2", slug: "runbook", title: "Runbook" }),
    ];

    renderPage();

    await user.type(
      screen.getByPlaceholderText("Search all knowledge..."),
      "deploy",
    );

    expect(screen.queryByRole("link", { name: "Runbook" })).not.toBeInTheDocument();
    expect(screen.getByTestId("doc-body").textContent).toBe(
      "See [Runbook](/ws/projects/proj-1/wiki/runbook).",
    );
  });
});
