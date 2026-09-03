// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { ProjectDoc } from "@multiremi/core/types";
import enCommon from "../../../locales/en/common.json";
import enProjects from "../../../locales/en/projects.json";

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
  queryOptions: <T,>(options: T) => options,
  useQuery: (options: { queryKey?: readonly unknown[] }) => options.queryKey?.[0] === "project-docs" ? ({
    data: state.isPending ? undefined : state.docs,
    isPending: state.isPending,
    isError: state.isError,
    error: state.error,
    refetch,
  }) : ({
    data: options.queryKey?.[0] === "repositories" ? { repositories: [], total: 0 } : [],
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@multiremi/core/project-docs", () => ({
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
    repositoryWiki: (id: string) => `/ws/repos/${id}/wiki`,
  }),
}));

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (type: string, id: string) => `${type}:${id}`,
  }),
}));

vi.mock("../../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid="actor-avatar">{actorId}</span>
  ),
}));

// The markdown pipeline is exercised in editor/readonly-content.test.tsx;
// stubbing it keeps this suite on what the wiki pane feeds the renderer —
// notably the [[slug]] rewrite.
vi.mock("../../../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => (
    <div data-testid="wiki-body">{content}</div>
  ),
}));

vi.mock("../../../navigation", () => ({
  // Props are spread through: rows and chips carry their styling on the link
  // itself now, and the assertions below read it back.
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

import { MemoryCard, ProjectWikiSection } from "./project-wiki-section";

function doc(partial: Partial<ProjectDoc> & { id: string }): ProjectDoc {
  return {
    project_id: "proj-1",
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
    path: partial.path ?? `${partial.id}.md`,
    compilation_run_id: partial.compilation_run_id ?? null,
  };
}

function renderSection(selectedRef?: string) {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ProjectWikiSection projectId="proj-1" selectedRef={selectedRef} />
    </I18nProvider>,
  );
}

function renderMemoryCard(memoryDoc: ProjectDoc, pages: ProjectDoc[] = []) {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <MemoryCard doc={memoryDoc} pages={pages} />
    </I18nProvider>,
  );
}

describe("ProjectWikiSection", () => {
  beforeEach(() => {
    state.docs = [];
    state.isPending = false;
    state.isError = false;
    state.error = null;
    refetch.mockClear();
  });

  it("shows a skeleton while the docs query is still pending, never the empty state", () => {
    state.isPending = true;

    renderSection();

    expect(screen.getByTestId("wiki-loading")).toBeInTheDocument();
    expect(
      screen.queryByText("No knowledge entries yet"),
    ).not.toBeInTheDocument();
  });

  it("shows a retryable error state when the docs query fails", () => {
    state.isError = true;
    state.error = new Error("network down");

    renderSection();

    expect(
      screen.getByText("Couldn't load the knowledge base"),
    ).toBeInTheDocument();
    expect(screen.getByText("network down")).toBeInTheDocument();
    // The lie the empty state would have told instead.
    expect(
      screen.queryByText("No knowledge entries yet"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the generic hint when the error carries no message", () => {
    state.isError = true;
    state.error = "boom";

    renderSection();

    expect(
      screen.getByText(
        "Something went wrong fetching this project's wiki and memory.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the empty state when the project has no knowledge yet", () => {
    renderSection();

    expect(screen.getByText("No knowledge entries yet")).toBeInTheDocument();
    expect(screen.queryByText("Agent Memory")).not.toBeInTheDocument();
  });

  it("lists wiki pages newest-first and hides the internal _schema page", () => {
    state.docs = [
      doc({
        id: "d1",
        slug: "_schema",
        title: "Wiki Schema",
        updated_at: "2026-07-02T00:00:00Z",
      }),
      doc({
        id: "d2",
        slug: "runbook",
        title: "Runbook",
        updated_at: "2026-07-09T00:00:00Z",
      }),
      doc({ id: "d3", kind: "memory", title: "Build takes 4 minutes" }),
    ];

    renderSection();

    const rows = within(screen.getByRole("navigation", { name: "Wiki" }))
      .getAllByRole("link");
    expect(rows.map((el) => el.textContent)).toEqual([
      "Agent Memory1",
      "Build takes 4 minutes",
      "Wiki pages1",
      "Runbook",
    ]);
    expect(screen.queryByText("Wiki Schema")).not.toBeInTheDocument();
    // The Wiki root opens the newest page; its nested row remains directly
    // shareable and cmd-clickable.
    expect(rows.map((el) => el.getAttribute("href"))).toEqual([
      "/ws/projects/proj-1/wiki",
      "/ws/projects/proj-1/wiki/d3",
      "/ws/projects/proj-1/wiki/runbook",
      "/ws/projects/proj-1/wiki/runbook",
    ]);
  });

  it("shows an empty Wiki page group when _schema is the only page", () => {
    state.docs = [
      doc({ id: "schema", slug: "_schema", title: "Wiki Schema" }),
      doc({ id: "memory", kind: "memory", title: "One fact" }),
    ];

    renderSection();

    const wikiRoot = screen.getByText("Wiki pages").parentElement;
    expect(wikiRoot).toHaveAttribute("aria-disabled", "true");
    expect(wikiRoot).toHaveAttribute("title", "No pages yet");
    expect(wikiRoot).toHaveTextContent("Wiki pages--");
    expect(screen.queryByText("Wiki Schema")).not.toBeInTheDocument();
  });

  it("falls back to the doc id in the row href when the doc has no slug", () => {
    state.docs = [doc({ id: "d1", slug: "", title: "Slugless" })];

    renderSection();

    expect(screen.getByRole("link", { name: "Slugless" })).toHaveAttribute(
      "href",
      "/ws/projects/proj-1/wiki/d1",
    );
  });

  it("resolves the ref by id first, then by slug — the server's order", () => {
    // Alpha's id equals Bravo's slug, so "runbook" is ambiguous on purpose.
    state.docs = [
      doc({
        id: "runbook",
        slug: "ops",
        title: "Alpha page",
        updated_at: "2026-07-09T00:00:00Z",
      }),
      doc({
        id: "d2",
        slug: "runbook",
        title: "Bravo page",
        updated_at: "2026-07-08T00:00:00Z",
      }),
    ];

    // An id match beats another doc's slug match.
    renderSection("runbook");
    expect(
      screen.getByRole("heading", { name: "Alpha page" }),
    ).toBeInTheDocument();

    // No id matches — the slug fallback kicks in.
    cleanup();
    renderSection("ops");
    expect(
      screen.getByRole("heading", { name: "Alpha page" }),
    ).toBeInTheDocument();

    // The doc whose slug is shadowed stays reachable by its id.
    cleanup();
    renderSection("d2");
    expect(
      screen.getByRole("heading", { name: "Bravo page" }),
    ).toBeInTheDocument();
  });

  it("shows a not-found pane with a way back when the ref matches no page", () => {
    state.docs = [doc({ id: "d1", slug: "runbook", title: "Runbook" })];

    renderSection("deleted-page");

    expect(screen.getByText("Page not found")).toBeInTheDocument();
    expect(
      screen.getByText("This wiki page does not exist or was deleted."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to project wiki" }),
    ).toHaveAttribute("href", "/ws/projects/proj-1/wiki");
    // The memory stream must not stand in for the page that was asked for.
    expect(
      screen.queryByText(
        "Durable facts agents learned while working on this project.",
      ),
    ).not.toBeInTheDocument();
  });

  it("opens on the memory stream: title, body, author, pinned marker, source issue", () => {
    state.docs = [
      doc({
        id: "d1",
        kind: "memory",
        title: "Build takes 4 minutes",
        body: "Cold cache doubles it.",
        pinned: true,
        author_type: "agent",
        author_id: "agent-7",
        source_issue_id: "MUL-42",
      }),
    ];

    renderSection();

    expect(screen.getAllByText("Build takes 4 minutes")).toHaveLength(2);
    expect(screen.getByTestId("wiki-body")).toHaveTextContent(
      "Cold cache doubles it.",
    );
    expect(screen.getByRole("img", { name: "Pinned" })).toBeInTheDocument();
    expect(screen.getByText("agent:agent-7")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Source issue" }),
    ).toHaveAttribute("href", "/ws/issues/MUL-42");
    expect(
      screen.getAllByRole("link", { name: "Build takes 4 minutes" })
        .some((link) => link.getAttribute("href") === "/ws/projects/proj-1/wiki/d1"),
    ).toBe(true);
  });

  it("renders compact pinned and unverified markers with accessible names", () => {
    renderMemoryCard(
      doc({
        id: "memory-markers",
        kind: "memory",
        title: "Historical pinned fact",
        pinned: true,
        compilation_run_id: null,
      }),
    );

    expect(screen.getByRole("img", { name: "Pinned" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Unverified history" }),
    ).toBeInTheDocument();
    // The badge text is gone from the row; only the icons carry the meaning.
    expect(screen.queryByText("Unverified history")).not.toBeInTheDocument();
  });

  it("resolves a memory slug from the URL and renders its detail after refresh", () => {
    state.docs = [
      doc({
        id: "d1",
        kind: "memory",
        slug: "summary-only",
        title: "Summary only",
        summary: "The CI box is arm64.",
        body: "",
      }),
      doc({
        id: "d2",
        kind: "memory",
        slug: "body-wins",
        title: "Body wins",
        summary: "Never shown.",
        body: "The body is authoritative.",
      }),
    ];

    renderSection("summary-only");

    expect(screen.getByTestId("memory-detail")).toBeInTheDocument();
    expect(screen.getByTestId("wiki-body")).toHaveTextContent(
      "The CI box is arm64.",
    );
    expect(
      within(screen.getByRole("navigation", { name: "Wiki" }))
        .getByRole("link", { name: "Summary only" }),
    ).toHaveAttribute("href", "/ws/projects/proj-1/wiki/summary-only");
    expect(
      screen.queryByRole("button", { name: "Summary only" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("memory-overview")).not.toBeInTheDocument();

    cleanup();
    renderSection("body-wins");

    expect(screen.getByTestId("wiki-body")).toHaveTextContent(
      "The body is authoritative.",
    );
    expect(screen.queryByText("Never shown.")).not.toBeInTheDocument();
  });

  it("uses one sidebar search for memory and Wiki pages, grouped by type", () => {
    state.docs = [
      doc({
        id: "d1",
        kind: "memory",
        slug: "deploy-fact",
        title: "Deploy fact",
        body: "Use the release job.",
      }),
      doc({
        id: "d2",
        kind: "memory",
        title: "Local database",
        body: "Runs on port 5432.",
      }),
      doc({
        id: "d3",
        slug: "deploy-runbook",
        title: "Deploy runbook",
      }),
      doc({
        id: "d4",
        slug: "architecture",
        title: "Architecture",
      }),
    ];

    renderSection();

    fireEvent.change(screen.getByRole("textbox", {
      name: "Search memory and Wiki pages...",
    }), {
      target: { value: "deploy" },
    });

    const sidebar = within(screen.getByRole("navigation", { name: "Wiki" }));
    expect(sidebar.getByRole("link", { name: "Deploy fact" })).toHaveAttribute(
      "href",
      "/ws/projects/proj-1/wiki/deploy-fact",
    );
    expect(sidebar.getByRole("link", { name: /^Deploy runbook/ })).toHaveAttribute(
      "href",
      "/ws/projects/proj-1/wiki/deploy-runbook",
    );
    expect(sidebar.queryByRole("link", { name: "Local database" }))
      .not.toBeInTheDocument();
    expect(sidebar.queryByRole("link", { name: /^Architecture/ }))
      .not.toBeInTheDocument();
    expect(sidebar.getByText("Agent Memory")).toBeInTheDocument();
    expect(sidebar.getByText("Wiki pages")).toBeInTheDocument();
  });

  it("keeps pinned memory first, then sorts the sidebar by latest update", () => {
    state.docs = [
      doc({
        id: "pinned",
        kind: "memory",
        title: "Pinned fact",
        body: "Important detail",
        pinned: true,
        updated_at: "2026-06-01T00:00:00Z",
      }),
      doc({
        id: "new",
        kind: "memory",
        title: "Newest fact",
        body: "New detail",
        updated_at: "2026-07-09T00:00:00Z",
      }),
      doc({
        id: "old",
        kind: "memory",
        title: "Oldest fact",
        body: "Old detail",
        updated_at: "2026-07-01T00:00:00Z",
      }),
    ];

    renderSection();

    const links = within(screen.getByRole("navigation", { name: "Wiki" }))
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href") !== "/ws/projects/proj-1/wiki");
    expect(links.map((link) => link.textContent)).toEqual([
      "Pinned fact",
      "Newest fact",
      "Oldest fact",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/ws/projects/proj-1/wiki/pinned",
      "/ws/projects/proj-1/wiki/new",
      "/ws/projects/proj-1/wiki/old",
    ]);
  });

  it("collapses and expands memory entries within the sidebar", () => {
    state.docs = [
      doc({
        id: "memory-1",
        kind: "memory",
        slug: "release-process",
        title: "Release process",
      }),
    ];

    renderSection();

    const sidebar = within(screen.getByRole("navigation", { name: "Wiki" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse memory" }));
    expect(sidebar.queryByRole("link", { name: "Release process" }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand memory" }));
    expect(sidebar.getByRole("link", { name: "Release process" })).toHaveAttribute(
      "href",
      "/ws/projects/proj-1/wiki/release-process",
    );
  });

  it("renders a selected wiki page with its body and last-updated footer", () => {
    state.docs = [
      doc({
        id: "d1",
        slug: "runbook",
        title: "Runbook",
        summary: "How to deploy",
        body: "Step 1. Ship it.",
        version: 3,
        updated_by_type: "member",
        updated_by_id: "user-2",
      }),
    ];

    renderSection("runbook");

    expect(screen.getByRole("heading", { name: "Runbook" })).toBeInTheDocument();
    expect(screen.getByText("How to deploy")).toBeInTheDocument();
    expect(screen.getByTestId("wiki-body")).toHaveTextContent("Step 1. Ship it.");
    expect(screen.getByText("Last updated by")).toBeInTheDocument();
    expect(screen.getByText("member:user-2")).toBeInTheDocument();
    expect(screen.getByText("v3")).toBeInTheDocument();
  });

  it("renders refs as badges — issue links, http url opens externally, task and unknown types stay text", () => {
    state.docs = [
      doc({
        id: "d1",
        slug: "runbook",
        title: "Runbook",
        refs: [
          { type: "issue", value: "MUL-42" },
          { type: "url", value: "https://example.com/runbook" },
          { type: "url", value: "javascript:alert(1)" },
          { type: "task", value: "task_9" },
          { type: "dashboard", value: "grafana-7" },
        ],
      }),
    ];

    renderSection("runbook");

    expect(screen.getByRole("link", { name: /MUL-42/ })).toHaveAttribute(
      "href",
      "/ws/issues/MUL-42",
    );
    const external = screen.getByRole("link", { name: /example\.com/ });
    expect(external).toHaveAttribute("href", "https://example.com/runbook");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");
    // A non-http value never becomes an href — it would run on click.
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /javascript/ }),
    ).not.toBeInTheDocument();
    // Tasks have no page of their own, unknown types resolve to nothing:
    // both render as plain badges.
    expect(screen.getByText("task_9")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /task_9/ })).not.toBeInTheDocument();
    expect(screen.getByText("grafana-7")).toBeInTheDocument();
    // Sidebar rows are links too, so count only what the ref row produced.
    const refLinks = screen
      .getAllByRole("link")
      .filter((el) => !el.getAttribute("href")!.startsWith("/ws/projects/"));
    expect(refLinks).toHaveLength(2);
  });

  it("rewrites [[slug]] into a link to that page, and its chip points at the same route", () => {
    state.docs = [
      doc({
        id: "d1",
        slug: "index",
        title: "Index",
        body: "Deploy steps live in [[runbook]].",
        updated_at: "2026-07-09T00:00:00Z",
      }),
      doc({
        id: "d2",
        slug: "runbook",
        title: "Runbook",
        body: "Step 1. Ship it.",
        updated_at: "2026-07-08T00:00:00Z",
      }),
    ];

    renderSection("index");

    // The raw wiki syntax never reaches the reader — a markdown link does.
    expect(screen.getByTestId("wiki-body").textContent).toBe(
      "Deploy steps live in [Runbook](/ws/projects/proj-1/wiki/runbook).",
    );

    // Chip row: the last "Runbook" link is the chip (the first is the sidebar
    // row), and it deep-links to the same page.
    const runbookLinks = screen.getAllByRole("link", { name: "Runbook" });
    expect(runbookLinks[runbookLinks.length - 1]).toHaveAttribute(
      "href",
      "/ws/projects/proj-1/wiki/runbook",
    );
  });

  it("leaves [[...]] inside fenced and inline code alone", () => {
    state.docs = [
      doc({
        id: "d1",
        slug: "index",
        title: "Index",
        body: [
          "Prose links to [[runbook]].",
          "",
          "```bash",
          'if [[ -f deploy.sh ]]; then echo "[[runbook]]"; fi',
          "```",
          "",
          "Inline `[[ $x == y ]]` is a bash test, not a link.",
        ].join("\n"),
        updated_at: "2026-07-09T00:00:00Z",
      }),
      doc({
        id: "d2",
        slug: "runbook",
        title: "Runbook",
        updated_at: "2026-07-08T00:00:00Z",
      }),
    ];

    renderSection("index");

    const rendered = screen.getByTestId("wiki-body").textContent!;
    // The prose link is rewritten; both code regions survive byte-for-byte.
    expect(rendered).toContain(
      "Prose links to [Runbook](/ws/projects/proj-1/wiki/runbook).",
    );
    expect(rendered).toContain('if [[ -f deploy.sh ]]; then echo "[[runbook]]"; fi');
    expect(rendered).toContain("Inline `[[ $x == y ]]` is a bash test");

    // Only the prose link becomes a chip — bash tests are not wiki pages.
    const chipRow = screen.getAllByRole("link", { name: "Runbook" });
    expect(chipRow).toHaveLength(2); // sidebar row + one chip
    expect(screen.queryByTitle("No Wiki page matches this reference")).not.toBeInTheDocument();
  });

  it("leaves a [[slug]] with no page as a non-clickable chip showing the slug", () => {
    state.docs = [
      doc({
        id: "d1",
        slug: "index",
        title: "Index",
        body: "See [[missing-page]] once it exists.",
      }),
    ];

    renderSection("index");

    expect(screen.getByTestId("wiki-body").textContent).toBe(
      'See <code title="No Wiki page matches this reference">missing-page</code> once it exists.',
    );
    const chip = screen.getByTitle("No Wiki page matches this reference");
    expect(chip).toHaveTextContent("missing-page");
    expect(
      screen.queryByRole("link", { name: "missing-page" }),
    ).not.toBeInTheDocument();
  });

  it("renders memory bodies through the markdown pipeline with [[slug]] rewritten", () => {
    state.docs = [
      doc({ id: "d1", slug: "runbook", title: "Runbook" }),
      doc({
        id: "d2",
        kind: "memory",
        title: "Deploy note",
        body: "- see [[runbook]]\n- and `[[ -f x ]]`",
      }),
    ];

    renderSection();

    // Same renderer + same [[slug]] rewrite the wiki page pane uses — the raw
    // marker and the markdown list syntax never reach the reader as text.
    expect(screen.getByTestId("wiki-body").textContent).toBe(
      "- see [Runbook](/ws/projects/proj-1/wiki/runbook)\n- and `[[ -f x ]]`",
    );
  });

  it("clamps a long memory body behind a toggle and expands it on demand", () => {
    renderMemoryCard(
      doc({
        id: "d1",
        kind: "memory",
        title: "Long note",
        body: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"),
      }),
    );

    expect(screen.getByTestId("wiki-body").parentElement).toHaveClass(
      "max-h-40",
    );

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.getByTestId("wiki-body").parentElement).not.toHaveClass(
      "max-h-40",
    );
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });

  it("leaves a short memory body unclamped and toggle-free", () => {
    renderMemoryCard(
      doc({ id: "d1", kind: "memory", title: "Short", body: "one line" }),
    );

    expect(screen.getByTestId("wiki-body").parentElement).not.toHaveClass(
      "max-h-40",
    );
    expect(
      screen.queryByRole("button", { name: "Show more" }),
    ).not.toBeInTheDocument();
  });

  it("bounds a long wiki-link chip and keeps the full title on hover", () => {
    const longTitle = "运行手册与灾难恢复流程".repeat(6);
    state.docs = [
      doc({
        id: "d1",
        slug: "index",
        title: "Index",
        body: "See [[runbook]].",
        updated_at: "2026-07-09T00:00:00Z",
      }),
      doc({
        id: "d2",
        slug: "runbook",
        title: longTitle,
        updated_at: "2026-07-08T00:00:00Z",
      }),
    ];

    renderSection("index");

    // Sidebar row first, chip last.
    const links = screen.getAllByRole("link", { name: longTitle });
    const chip = links[links.length - 1]!;
    expect(chip).toHaveClass("max-w-64");
    expect(chip).toHaveAttribute("title", longTitle);
  });

  it("keeps a truncated sidebar page title recoverable on hover", () => {
    const longTitle = "A very long agent-written wiki page title";
    state.docs = [doc({ id: "d1", slug: "runbook", title: longTitle })];

    renderSection();

    const label = screen.getByTitle(longTitle);
    expect(label.tagName).toBe("SPAN");
    expect(label).toHaveClass("truncate");
  });

  it("forces the mobile Wiki drawer to the specified 280px width", () => {
    state.docs = [doc({ id: "d1", slug: "runbook", title: "Runbook" })];
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Wiki" }));

    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveClass("!w-[280px]");
  });
});
