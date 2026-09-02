// @vitest-environment jsdom

import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../navigation", () => ({
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { displayWikiTitle, WikiDirectoryTree } from "./wiki-directory-tree";

const pages = [
  { id: "current", path: "architecture/services/catalog.md", title: "Architecture Services Catalog" },
  { id: "peer", path: "architecture/services/runtime.md", title: "Architecture Services Runtime" },
  { id: "ops-a", path: "operations/deploy.md", title: "Operations Deploy" },
  { id: "ops-b", path: "operations/release.md", title: "Operations Release" },
];

describe("WikiDirectoryTree", () => {
  it("opens only the selected path and removes redundant directory prefixes", () => {
    render(
      <WikiDirectoryTree
        pages={pages}
        selectedId="current"
        hrefFor={(page) => `/wiki/${page.path}`}
        noMatches="No matches"
      />,
    );

    expect(screen.getByRole("button", { name: /architecture/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /services/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /operations/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("link", { name: "Catalog" })).toHaveAttribute("aria-current", "page");
    expect(displayWikiTitle(pages[0]!)).toBe("Catalog");
  });

  it("flattens search results and shows their parent paths", async () => {
    const user = userEvent.setup();
    const view = render(
      <WikiDirectoryTree
        pages={pages}
        selectedId="current"
        hrefFor={(page) => `/wiki/${page.path}`}
        noMatches="No matches"
      />,
    );
    await user.click(screen.getByRole("button", { name: /operations/i }));
    view.rerender(
      <WikiDirectoryTree
        pages={pages}
        selectedId="current"
        filter="release"
        hrefFor={(page) => `/wiki/${page.path}`}
        noMatches="No matches"
      />,
    );

    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Release/ })).toBeInTheDocument();
    expect(screen.getByText("operations")).toBeInTheDocument();
  });

  it("selects a page in place when no route builder is provided", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <WikiDirectoryTree
        pages={pages}
        selectedId="current"
        onSelect={onSelect}
        noMatches="No matches"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Runtime" }));
    expect(onSelect).toHaveBeenCalledWith(pages[1]);
    expect(screen.queryByRole("link", { name: "Runtime" })).not.toBeInTheDocument();
  });
});
