import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { IssueSession, SessionResult } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

const mockApiObj = vi.hoisted(() => ({
  listIssueSessionResults: vi.fn(),
}));

vi.mock("@multiremi/core/api", () => ({
  api: mockApiObj,
  getApi: () => mockApiObj,
  setApiInstance: vi.fn(),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (type: string, id: string) =>
      type === "agent" && id === "agent-1" ? "Claude Agent" : "Test User",
  }),
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/test/issues/${id}` }),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorType, actorId }: { actorType: string; actorId: string }) => (
    <span data-testid="actor-avatar">{actorType}:{actorId}</span>
  ),
}));

// ReadonlyContent drags in lowlight + KaTeX + Mermaid. The contract this file
// cares about is "the body goes through the Markdown renderer", so a stub that
// records what it received is enough.
vi.mock("../../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => (
    <div data-testid="readonly-content">{content}</div>
  ),
}));

import {
  IssueKeyResultsSection,
  IssueResultActivityLines,
} from "./issue-key-results-section";

const SESSIONS: IssueSession[] = [
  {
    id: "session-main",
    issue_id: "issue-1",
    workspace_id: "ws-1",
    title: "Main",
    status: "active",
    is_default: true,
    summary: null,
    created_by_type: "system",
    created_by_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    participants: [],
  },
];

function makeResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    id: "result-1",
    issue_id: "issue-1",
    source_session_id: "session-main",
    title: "Architecture decision",
    body: "Use an append-only canonical event log.",
    metadata: {},
    published_by_type: "agent",
    published_by_id: "agent-1",
    created_at: "2026-01-03T00:00:00Z",
    ...overrides,
  };
}

function renderSection(results: SessionResult[]) {
  mockApiObj.listIssueSessionResults.mockResolvedValue(results);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider resources={TEST_RESOURCES} locale="en">
        <IssueKeyResultsSection issueId="issue-1" sessions={SESSIONS} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function renderActivityLines(results: SessionResult[], onShowResults = vi.fn()) {
  mockApiObj.listIssueSessionResults.mockResolvedValue(results);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider resources={TEST_RESOURCES} locale="en">
        <IssueResultActivityLines issueId="issue-1" onShowResults={onShowResults} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return onShowResults;
}

describe("IssueKeyResultsSection", () => {
  it("stays hidden until the issue has a published result", async () => {
    renderSection([]);

    // Give the (empty) query a tick to settle before asserting absence.
    await vi.waitFor(() => expect(mockApiObj.listIssueSessionResults).toHaveBeenCalled());
    expect(screen.queryByText("Key results")).not.toBeInTheDocument();
  });

  it("files each result under the icon for its kind", async () => {
    const { container } = renderSection([
      makeResult({ id: "r-mr", title: "Merged the fix", metadata: { kind: "mr" } }),
      makeResult({ id: "r-deploy", title: "Shipped to prod", metadata: { kind: "deploy" } }),
      makeResult({ id: "r-doc", title: "Runbook", metadata: { kind: "doc" } }),
    ]);

    expect(await screen.findByText("Key results")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Merge request" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Deployment" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Document" })).toBeInTheDocument();
    // Distinct glyphs, not just distinct labels.
    expect(container.querySelector(".lucide-git-merge")).not.toBeNull();
    expect(container.querySelector(".lucide-rocket")).not.toBeNull();
    expect(container.querySelector(".lucide-file-text")).not.toBeNull();
  });

  it("degrades an unknown or absent kind to the generic icon", async () => {
    renderSection([
      makeResult({ id: "r-unknown", title: "From a newer server", metadata: { kind: "postmortem" } }),
      makeResult({ id: "r-none", title: "No metadata at all" }),
    ]);

    expect(await screen.findByText("From a newer server")).toBeInTheDocument();
    expect(screen.getByText("No metadata at all")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Result" })).toHaveLength(2);
  });

  it("renders refs as badges and drops malformed entries", async () => {
    renderSection([
      makeResult({
        metadata: {
          kind: "mr",
          refs: [
            { type: "issue", value: "MUL-12" },
            { type: "url", value: "https://example.test/mr/12" },
            { type: "dashboard", value: "ops-7" },
            { type: "task" },
            "issue:MUL-13",
          ],
        },
      }),
    ]);

    expect(await screen.findByText("MUL-12")).toBeInTheDocument();
    expect(screen.getByText("MUL-12").closest("a")).toHaveAttribute(
      "href",
      "/test/issues/MUL-12",
    );
    expect(screen.getByText("https://example.test/mr/12").closest("a")).toHaveAttribute(
      "href",
      "https://example.test/mr/12",
    );
    // Unknown ref type still renders, as plain text rather than a link.
    expect(screen.getByText("ops-7").closest("a")).toBeNull();
    expect(screen.queryByText("MUL-13")).not.toBeInTheDocument();
  });

  it("marks navigable refs apart from inert ones", async () => {
    const { container } = renderSection([
      makeResult({
        metadata: {
          refs: [
            { type: "issue", value: "MUL-12" },
            { type: "dashboard", value: "ops-7" },
          ],
        },
      }),
    ]);

    const linked = (await screen.findByText("MUL-12")).closest("[data-slot='badge']");
    const inert = screen.getByText("ops-7").closest("[data-slot='badge']");
    // The arrow glyph is the only thing that tells a user a badge navigates.
    expect(linked?.querySelector(".lucide-arrow-up-right")).not.toBeNull();
    expect(inert?.querySelector(".lucide-arrow-up-right")).toBeNull();
    expect(linked).toHaveClass("hover:bg-accent");
    expect(inert).not.toHaveClass("hover:bg-accent");
    // Truncated values stay readable on hover.
    expect(container.querySelector('[title="ops-7"]')).not.toBeNull();
  });

  it("opens the full result body from a card", async () => {
    renderSection([makeResult()]);

    // The card is a title-only summary; the body lives behind it.
    expect(await screen.findByText("Architecture decision")).toBeInTheDocument();
    expect(
      screen.queryByText("Use an append-only canonical event log."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Architecture decision/ }));

    expect(
      await screen.findByText("Use an append-only canonical event log."),
    ).toBeInTheDocument();
    expect(screen.getByText("From Main")).toBeInTheDocument();
  });

  it("renders the agent-written body as Markdown, not preformatted text", async () => {
    renderSection([
      makeResult({ body: "## Outcome\n\n- shipped\n- rolled back once" }),
    ]);

    fireEvent.click(await screen.findByRole("button", { name: /Architecture decision/ }));

    const rendered = await screen.findByTestId("readonly-content");
    expect(rendered).toHaveTextContent("## Outcome");
  });

  it("never leaks a raw session id when the source session can't be resolved", async () => {
    // Archived sessions are excluded from the sessions list, so the lookup
    // misses and the id would otherwise be printed verbatim.
    renderSection([makeResult({ source_session_id: "9f2a1c34-dead-beef-0000-000000000001" })]);

    fireEvent.click(await screen.findByRole("button", { name: /Architecture decision/ }));

    expect(await screen.findByText("From another session")).toBeInTheDocument();
    expect(
      screen.queryByText(/9f2a1c34-dead-beef-0000-000000000001/),
    ).not.toBeInTheDocument();
  });
});

describe("IssueResultActivityLines", () => {
  it("renders one light line per result and points at the panel section", async () => {
    const onShowResults = renderActivityLines([
      makeResult(),
      makeResult({ id: "result-2", title: "API contract", body: "Explicit results only." }),
    ]);

    expect(
      await screen.findByText('published the result "Architecture decision"'),
    ).toBeInTheDocument();
    expect(screen.getByText('published the result "API contract"')).toBeInTheDocument();
    // The body never appears in the timeline any more.
    expect(screen.queryByText("Explicit results only.")).not.toBeInTheDocument();
    expect(screen.getAllByText("Claude Agent")).toHaveLength(2);

    fireEvent.click(screen.getByText('published the result "API contract"'));
    expect(onShowResults).toHaveBeenCalledTimes(1);
  });

  it("falls back to a placeholder title for an untitled result", async () => {
    renderActivityLines([makeResult({ title: "" })]);

    expect(
      await screen.findByText('published the result "Untitled result"'),
    ).toBeInTheDocument();
  });
});
