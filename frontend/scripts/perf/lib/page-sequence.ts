/**
 * The MUL-367 page list and where each page's warm round starts from.
 *
 * Extracted from `page-speed.ts` (MUL-395 S9-0.1) for the same reason as
 * `options.ts`: that file calls `main()` at import time, so a mapping defined
 * inside it cannot be asserted. The warm entry is exactly the kind of thing that
 * goes wrong silently — `page-issues` used to enter from the issues list and then
 * click the issues link, so the round measured a click on the page it was already
 * on, and the report still looked like a normal warm number
 * (MUL-395 S9-0.1, `cmt_5i93scwhgzw2`).
 */

/** Where a warm round starts from before it clicks into the measured page. */
export type WarmEntry = "issues-list" | "inbox";

/** The eleven MUL-367 pages, in the order one round visits them. */
export const PAGE_SEQUENCE = [
  { key: "issues", path: "/issues" },
  { key: "my-issues", path: "/my-issues" },
  { key: "chat", path: "/chat" },
  { key: "inbox", path: "/inbox" },
  { key: "agents", path: "/agents" },
  { key: "runtimes", path: "/runtimes" },
  { key: "projects", path: "/projects" },
  { key: "workbench", path: "/workbench" },
  { key: "settings", path: "/settings" },
  { key: "autopilots", path: "/autopilots" },
  { key: "skills", path: "/skills" },
] as const;

export type PageKey = (typeof PAGE_SEQUENCE)[number]["key"];

/**
 * Entry page for one warm page round.
 *
 * The issues list is the one page that cannot start from itself: entering from
 * `issues-list` and clicking the sidebar's issues link is a same-page click, which
 * measures the page it was already on rather than a navigation into it. Every
 * other list page keeps the shared issues-list entry, so their numbers stay
 * comparable with the ones already recorded.
 */
export function warmEntryForPage(pageKey: string): WarmEntry {
  return pageKey === "issues" ? "inbox" : "issues-list";
}

/** The entry page's URL path, relative to the workspace slug. */
export function entryPathFor(entry: WarmEntry): string {
  return entry === "inbox" ? "/inbox" : "/issues";
}

export interface WarmRoute {
  entry: WarmEntry;
  entryPath: string;
  /** The URL path the round is supposed to arrive at. */
  targetPath: string;
}

/**
 * The full entry -> target route of one warm page round, so the "the click has to
 * leave the entry page" property is a value the tests can assert rather than a
 * claim about a literal.
 */
export function warmRouteForPage(page: { key: string; path: string }): WarmRoute {
  const entry = warmEntryForPage(page.key);
  return { entry, entryPath: entryPathFor(entry), targetPath: page.path };
}
