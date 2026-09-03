// @vitest-environment jsdom

import type { ReactNode } from "react";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../test/i18n";
import { WikiDocumentContent, type WikiLinkDocument } from "./wiki-document-content";

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    projectWikiPage: (projectId: string, ref: string) => `/ws/projects/${projectId}/wiki/${ref}`,
    repositoryWikiPage: (repositoryId: string, path: string) => `/ws/repos/${repositoryId}/wiki/${path}`,
  }),
}));

vi.mock("../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => <div data-testid="wiki-body">{content}</div>,
}));

vi.mock("../navigation", () => ({
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

function page(overrides: Partial<WikiLinkDocument> & { id: string }): WikiLinkDocument {
  return {
    slug: overrides.id,
    path: `${overrides.id}.md`,
    title: overrides.id,
    body: "",
    ...overrides,
  };
}

describe("WikiDocumentContent", () => {
  it("resolves hierarchical Project Wiki links and shows both relation directions", () => {
    const pages = [
      page({
        id: "index-id",
        slug: "index",
        path: "index.md",
        title: "Home",
        body: "See [[architecture/runbook.md#deploy|Deployment]]. Jump [[#summary|Summary]]. `[[ignored]]`.",
      }),
      page({
        id: "runbook-id",
        slug: "runbook",
        path: "architecture/runbook.md",
        title: "Runbook",
        body: "Return to [[index]].",
      }),
    ];

    renderWithI18n(
      <WikiDocumentContent
        doc={pages[0]!}
        pages={pages}
        scope={{ kind: "project", projectId: "project-1" }}
      />,
    );

    expect(screen.getByTestId("wiki-body")).toHaveTextContent(
      "See [Deployment](/ws/projects/project-1/wiki/runbook#deploy). Jump [Summary](#summary). `[[ignored]]`.",
    );
    const outgoing = screen.getByRole("group", { name: "References" });
    expect(within(outgoing).getByRole("link", { name: "Runbook" })).toHaveAttribute(
      "href",
      "/ws/projects/project-1/wiki/runbook",
    );
    expect(within(outgoing).getByRole("link", { name: "Runbook" })).toHaveAttribute(
      "title",
      "Runbook",
    );
    expect(within(screen.getByRole("group", { name: "Referenced by" }))
      .getByRole("link", { name: "Runbook" })).toHaveAttribute(
      "href",
      "/ws/projects/project-1/wiki/runbook",
    );
  });

  it("uses Repository Wiki locality, preserves code, and never guesses missing or ambiguous refs", () => {
    const source = page({
      id: "overview",
      slug: "overview",
      path: "operations/overview.md",
      title: "Overview",
      body: [
        "See [[runbook.md]], [[guide.md]], [[shared.md]], and [[missing.md]].",
        "Jump to [[#checks|Checks]].",
        "```bash",
        "echo '[[runbook.md]]'",
        "```",
      ].join("\n"),
    });
    const pages = [
      source,
      page({ id: "local", slug: "local", path: "operations/runbook.md", title: "Local runbook" }),
      page({ id: "guide", slug: "guide", path: "guides/guide.md", title: "Unique guide" }),
      page({ id: "shared-a", slug: "shared-a", path: "a/shared.md", title: "Shared A" }),
      page({ id: "shared-b", slug: "shared-b", path: "b/shared.md", title: "Shared B" }),
      page({ id: "backlink", slug: "backlink", path: "notes/backlink.md", title: "Change note", body: "See [[operations/overview.md]]." }),
    ];

    renderWithI18n(
      <WikiDocumentContent
        doc={source}
        pages={pages}
        scope={{ kind: "repository", repositoryId: "repo-1" }}
      />,
    );

    const body = screen.getByTestId("wiki-body").textContent ?? "";
    expect(body).toContain("[Local runbook](/ws/repos/repo-1/wiki/operations/runbook.md)");
    expect(body).toContain("[Unique guide](/ws/repos/repo-1/wiki/guides/guide.md)");
    expect(body).toContain('<code title="More than one Wiki page matches; use the full path">shared.md</code>');
    expect(body).toContain('<code title="No Wiki page matches this reference">missing.md</code>');
    expect(body).toContain("[Checks](#checks)");
    expect(body).toContain("echo '[[runbook.md]]'");

    expect(screen.getByRole("link", { name: "Change note" })).toHaveAttribute(
      "href",
      "/ws/repos/repo-1/wiki/notes/backlink.md",
    );
    expect(screen.getByTitle("More than one Wiki page matches; use the full path")).toHaveTextContent("shared.md");
    expect(screen.getByTitle("No Wiki page matches this reference")).toHaveTextContent("missing.md");
    expect(screen.queryByRole("link", { name: "shared.md" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "missing.md" })).not.toBeInTheDocument();
  });

  it("does not flash an empty backlink state while lazy relations are loading", () => {
    const source = page({ id: "overview", title: "Overview" });
    renderWithI18n(
      <WikiDocumentContent
        doc={source}
        pages={[source]}
        scope={{ kind: "project", projectId: "project-1" }}
        backlinks={[]}
        backlinksPending
      />,
    );

    const row = screen.getByRole("group", { name: "Referenced by" });
    expect(row).toHaveAttribute("aria-busy", "true");
    expect(within(row).queryByText("None")).not.toBeInTheDocument();
  });
});
