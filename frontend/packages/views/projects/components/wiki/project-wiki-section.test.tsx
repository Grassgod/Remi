// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { ProjectDoc } from "@multiremi/core/types";
import enCommon from "../../../locales/en/common.json";
import enProjects from "../../../locales/en/projects.json";

const TEST_RESOURCES = {
  en: { common: enCommon, projects: enProjects },
};

const state = vi.hoisted(() => ({ docs: [] as unknown[] }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: state.docs }),
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
  AppLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { ProjectWikiSection } from "./project-wiki-section";

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
  };
}

function renderSection() {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ProjectWikiSection projectId="proj-1" />
    </I18nProvider>,
  );
}

describe("ProjectWikiSection", () => {
  beforeEach(() => {
    state.docs = [];
  });

  it("shows the empty state when the project has no knowledge yet", () => {
    renderSection();

    expect(screen.getByText("No knowledge entries yet")).toBeInTheDocument();
    expect(screen.queryByText("Agent Memory")).not.toBeInTheDocument();
  });

  it("lists wiki pages newest-first below the Agent Memory node, _schema included", () => {
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

    const rows = screen.getAllByRole("button").map((el) => el.textContent);
    expect(rows).toEqual(["Agent Memory1", "Runbook", "Wiki Schema"]);
  });

  it("opens on the memory stream: title, body, author, pinned badge, source issue", () => {
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

    expect(screen.getByText("Build takes 4 minutes")).toBeInTheDocument();
    expect(screen.getByText("Cold cache doubles it.")).toBeInTheDocument();
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("agent:agent-7")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Source issue" })).toHaveAttribute(
      "href",
      "/ws/issues/MUL-42",
    );
  });

  it("falls back to the summary for a memory entry stored without a body", () => {
    state.docs = [
      doc({
        id: "d1",
        kind: "memory",
        title: "Summary only",
        summary: "The CI box is arm64.",
        body: "",
      }),
      doc({
        id: "d2",
        kind: "memory",
        title: "Body wins",
        summary: "Never shown.",
        body: "The body is authoritative.",
      }),
    ];

    renderSection();

    expect(screen.getByText("The CI box is arm64.")).toBeInTheDocument();
    expect(screen.getByText("The body is authoritative.")).toBeInTheDocument();
    expect(screen.queryByText("Never shown.")).not.toBeInTheDocument();
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

    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Runbook" }));

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

    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Runbook" }));

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
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("rewrites [[slug]] to the target title and its chip selects that page", () => {
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

    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Index" }));

    // The raw wiki syntax never reaches the reader — the target's title does.
    expect(screen.getByTestId("wiki-body").textContent).toBe(
      "Deploy steps live in `Runbook`.",
    );

    // Chip row: the last "Runbook" button is the chip (the first is the
    // sidebar row); clicking it opens that page.
    const runbookButtons = screen.getAllByRole("button", { name: "Runbook" });
    fireEvent.click(runbookButtons[runbookButtons.length - 1]!);

    expect(screen.getByRole("heading", { name: "Runbook" })).toBeInTheDocument();
    expect(screen.getByTestId("wiki-body")).toHaveTextContent("Step 1. Ship it.");
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

    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Index" }));

    const rendered = screen.getByTestId("wiki-body").textContent!;
    // The prose link is rewritten; both code regions survive byte-for-byte.
    expect(rendered).toContain("Prose links to `Runbook`.");
    expect(rendered).toContain('if [[ -f deploy.sh ]]; then echo "[[runbook]]"; fi');
    expect(rendered).toContain("Inline `[[ $x == y ]]` is a bash test");

    // Only the prose link becomes a chip — bash tests are not wiki pages.
    const chipRow = screen.getAllByRole("button", { name: "Runbook" });
    expect(chipRow).toHaveLength(2); // sidebar row + one chip
    expect(screen.queryByTitle("No page with this slug yet")).not.toBeInTheDocument();
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

    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Index" }));

    expect(screen.getByTestId("wiki-body").textContent).toBe(
      "See `missing-page` once it exists.",
    );
    const chip = screen.getByTitle("No page with this slug yet");
    expect(chip).toHaveTextContent("missing-page");
    expect(
      screen.queryByRole("button", { name: "missing-page" }),
    ).not.toBeInTheDocument();
  });
});
