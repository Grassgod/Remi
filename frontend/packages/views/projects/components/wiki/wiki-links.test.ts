import { describe, expect, it } from "vitest";
import { replaceWikiLinkMarkers } from "./wiki-links";

// Stands in for the section's page lookup: known slugs resolve to a title and
// a route, everything else is a dead link.
const PAGES: Record<string, { title: string; href: string }> = {
  runbook: { title: "Runbook", href: "/acme/projects/p1/wiki/runbook" },
};

function resolve(slug: string) {
  return PAGES[slug] ?? null;
}

describe("replaceWikiLinkMarkers", () => {
  it("rewrites a resolved marker into a markdown link to the target's route", () => {
    expect(
      replaceWikiLinkMarkers("Deploy steps live in [[runbook]].", resolve),
    ).toBe("Deploy steps live in [Runbook](/acme/projects/p1/wiki/runbook).");
  });

  it("trims whitespace inside the marker before resolving", () => {
    expect(replaceWikiLinkMarkers("See [[  runbook  ]].", resolve)).toBe(
      "See [Runbook](/acme/projects/p1/wiki/runbook).",
    );
  });

  it("degrades an unresolved marker to an inline code span, never a dead link", () => {
    const rendered = replaceWikiLinkMarkers("See [[missing]].", resolve);

    expect(rendered).toBe("See `missing`.");
    expect(rendered).not.toContain("](");
  });

  it("leaves fenced blocks and inline code byte-for-byte alone", () => {
    const body = [
      "Prose links to [[runbook]].",
      "```bash",
      'if [[ -f deploy.sh ]]; then echo "[[runbook]]"; fi',
      "```",
      "Inline `[[ $x == y ]]` is a bash test, not a link.",
    ].join("\n");

    const rendered = replaceWikiLinkMarkers(body, resolve);

    expect(rendered).toContain(
      "Prose links to [Runbook](/acme/projects/p1/wiki/runbook).",
    );
    expect(rendered).toContain(
      'if [[ -f deploy.sh ]]; then echo "[[runbook]]"; fi',
    );
    expect(rendered).toContain("Inline `[[ $x == y ]]` is a bash test");
  });

  it("escapes brackets and backslashes in the title so the link text cannot break out", () => {
    const rendered = replaceWikiLinkMarkers("See [[weird]].", () => ({
      title: "Runbook [draft] \\ v2",
      href: "/acme/projects/p1/wiki/weird",
    }));

    expect(rendered).toBe(
      "See [Runbook \\[draft\\] \\\\ v2](/acme/projects/p1/wiki/weird).",
    );
  });
});
