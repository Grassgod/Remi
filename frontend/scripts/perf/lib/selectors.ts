/**
 * Every selector the MUL-383 page-speed probe uses, in one place.
 *
 * Two tables, same elements:
 *  - `contract` — the `data-perf-*` attributes MUL-384 adds. Preferred.
 *  - `legacy`   — the pre-MUL-384 DOM. Production runs the probe before S2's
 *                 reveal hook ships, so the first baselines measure this table.
 *
 * `--selectors auto` decides per round: a page carrying `[data-perf-scroll]`
 * uses contract, otherwise legacy. A contract round also samples the legacy table
 * on the same DOM, so `selectorEquivalence` can prove the tables agree before any
 * contract-mode number is trusted.
 *
 * Deleting the legacy table needs two things: S2 merged, and at least one
 * contract-mode baseline published. See `docs/dev/performance.md`.
 */

import type { PerfAnchorSpec, PerfProfileConfig, PerfReadyRule, PerfProfileName } from "./jump-recorder";
// The inbox page's own row order. Imported rather than re-derived so the probe's
// idea of "which row to click" cannot drift from the page's grouping.
import {
  deduplicateInboxItems,
  filterInboxItemsBySource,
  groupInboxItemsByDate,
} from "../../../packages/core/inbox/grouping";
import type { InboxItem } from "../../../packages/core/types/inbox";

export type SelectorMode = PerfProfileName;
export type SelectorModeOption = "auto" | SelectorMode;

/** Which measurement the script is driving: it selects the scroll root and the terminal rule. */
export type PageShape = "issue-detail" | "chat" | "list";

export type PerfAnchorName = "latest-comment" | "agent-stream" | "target-comment" | "latest-message";

export type PerfItemType =
  | "comment"
  | "activity"
  | "resolved-bar"
  | "message"
  | "issue"
  | "inbox"
  | "sub-issue";

export const CONTRACT = {
  /** Any measured viewport (used to detect whether the contract DOM is deployed). */
  scrollRoot: "[data-perf-scroll]",
  scrollRootIssueDetail: '[data-perf-scroll="issue-detail"]',
  scrollRootChat: '[data-perf-scroll="chat"]',
  /** Real data rows; skeletons never carry this attribute. */
  items: "[data-perf-item]",
  skeleton: '[data-slot="skeleton"]',
  anchor: (name: PerfAnchorName): string => `[data-perf-anchor="${name}"]`,
  item: (type: PerfItemType): string => `[data-perf-item="${type}"]`,
  /** Written by S2's reveal hook; this probe only reads the transitions. */
  state: "[data-perf-state]",
} as const;

export const LEGACY = {
  scrollRoot: "[data-tab-scroll-root]",
  /**
   * List pages carry no scroll root of their own. MUL-367 measured them inside
   * the content region, and that region is still where their rows live, so both
   * tables root a list round here.
   */
  listRoot: '[data-slot="sidebar-inset"]',
  /** Timeline rows carry `id="comment-<id>"`; DOM order is chronological. */
  items: '[data-tab-scroll-root] [id^="comment-"]',
  /** Anchors are matched inside the scroll root, so the id-only form is enough. */
  anyComment: '[id^="comment-"]',
  skeleton: '[data-slot="skeleton"]',
  targetComment: (commentId: string): string => `[id="comment-${cssEscape(commentId)}"]`,
  /** Issue rows: the row link points at the issue detail route. */
  issueRowLink: (issueId: string): string =>
    `[data-slot="sidebar-inset"] a[href$="/issues/${cssEscape(issueId)}"]`,
  /**
   * Inbox rows are the focusable role=button elements inside the content region.
   *
   * UNRELIABLE: QA measured this matching toolbar buttons rather than
   * notification rows on 209 (MUL-384 cmt_3d2bb3s7ceeh). It stays in the table
   * because selectorEquivalence samples both tables on the same DOM, but no
   * flow may be driven by it; see LEGACY_INBOX_ROW_RELIABLE.
   */
  // Scoped to the date-group sections, which are what actually contain the
  // notification rows; the unscoped form also matched toolbar buttons on 209.
  inboxRow: 'section[aria-labelledby^="inbox-group-"] div[role="button"][tabindex="0"]',
} as const;

/** The legacy inbox-row selector is comparison-only; never drive a click with it. */
export const LEGACY_INBOX_ROW_RELIABLE = false;

/** `CSS.escape` is browser-only; the Node side needs the same id-safe form. */
export function cssEscape(value: string): string {
  return value.replace(/([^\w-])/g, "\\$1");
}

export function scrollRootSelector(mode: SelectorMode, shape: PageShape): string {
  // A list page has neither data-tab-scroll-root nor a data-perf-scroll of its
  // own, so requiring either one left every list round structurally unable to
  // reach ready. Fall back to the content region MUL-367 measured inside.
  if (shape === "list") return LEGACY.listRoot;
  if (mode === "legacy") return LEGACY.scrollRoot;
  return shape === "chat" ? CONTRACT.scrollRootChat : CONTRACT.scrollRootIssueDetail;
}

/**
 * Root the profile falls back to when its primary one is missing.
 *
 * Only the legacy chat profile needs it: an empty chat renders EmptyState
 * instead of ChatMessageList, so data-tab-scroll-root is genuinely absent and
 * the heading rule could otherwise never fire. With messages present the
 * primary root wins, leaving the chat reading rule untouched.
 */
export function scrollRootFallbackSelector(mode: SelectorMode, shape: PageShape): string | null {
  if (shape === "chat" && mode === "legacy") return LEGACY.listRoot;
  return null;
}

/** Clickable row for one issue in the list, in either mode. */
export function issueRowSelector(mode: SelectorMode, issueId: string): string {
  return mode === "legacy"
    ? LEGACY.issueRowLink(issueId)
    : `${CONTRACT.item("issue")}[data-perf-key="${cssEscape(issueId)}"] a`;
}

/**
 * Inbox rows. Contract mode wraps the row in `data-perf-item="inbox"` and keeps
 * its inner link/button; legacy rows are the focusable role=button divs.
 */
export function inboxRowSelector(mode: SelectorMode): string {
  if (mode === "legacy") return LEGACY.inboxRow;
  return `${CONTRACT.item("inbox")} a, ${CONTRACT.item("inbox")} [role="button"], ${CONTRACT.item("inbox")}`;
}

export interface AnchorPlan {
  specs: PerfAnchorSpec[];
  rule: PerfReadyRule;
  /** Recorded in the report so a later reader can tell which rule produced the number. */
  anchorRule: string;
  /** Reported `anchor`; `none` for the heading rule. */
  anchorName: string;
}

/**
 * Terminal elements and the readiness rule for one page shape.
 *
 * Legacy has no stable hook for the agent stream or for chat, and the ruling
 * forbids substituting a class selector: `detail-running` therefore falls back
 * to the last timeline row, and chat to the MUL-367 heading rule.
 */
export function anchorPlan(options: {
  mode: SelectorMode;
  shape: PageShape;
  targetCommentId?: string | null;
}): AnchorPlan {
  const { mode, shape } = options;

  if (shape === "list" || (shape === "chat" && mode === "legacy")) {
    return { specs: [], rule: { kind: "heading" }, anchorRule: "h1-no-skeleton", anchorName: "none" };
  }

  if (shape === "chat") {
    return {
      specs: [
        {
          name: "latest-message",
          selector: CONTRACT.anchor("latest-message"),
          pick: "first",
          visibility: "contained",
        },
      ],
      rule: { kind: "anchor", anchors: ["latest-message"] },
      anchorRule: "latest-message",
      anchorName: "latest-message",
    };
  }

  if (mode === "legacy") {
    if (options.targetCommentId) {
      return {
        specs: [
          {
            name: "target-comment",
            selector: LEGACY.targetComment(options.targetCommentId),
            pick: "first",
            visibility: "top-visible",
          },
        ],
        rule: { kind: "anchor", anchors: ["target-comment"] },
        anchorRule: "legacy-target-comment",
        anchorName: "target-comment",
      };
    }
    return {
      specs: [
        { name: "latest-comment", selector: LEGACY.anyComment, pick: "last", visibility: "contained" },
      ],
      rule: { kind: "anchor", anchors: ["latest-comment"] },
      anchorRule: "legacy-latest-comment",
      anchorName: "latest-comment",
    };
  }

  if (options.targetCommentId) {
    return {
      specs: [
        {
          name: "target-comment",
          selector: CONTRACT.anchor("target-comment"),
          pick: "first",
          visibility: "top-visible",
        },
      ],
      rule: { kind: "anchor", anchors: ["target-comment"] },
      anchorRule: "target-comment",
      anchorName: "target-comment",
    };
  }

  // Browsing an issue: the agent stream row (when an agent is running) or the
  // newest comment. Both anchors are sampled; either one can satisfy the rule,
  // and the report records which one did.
  return {
    specs: [
      { name: "agent-stream", selector: CONTRACT.anchor("agent-stream"), pick: "first", visibility: "contained" },
      { name: "latest-comment", selector: CONTRACT.anchor("latest-comment"), pick: "first", visibility: "contained" },
    ],
    rule: { kind: "anchor", anchors: ["agent-stream", "latest-comment"] },
    anchorRule: "agent-stream|latest-comment",
    anchorName: "agent-stream",
  };
}

/** One recorder profile: which elements to sample and when the page counts as ready. */
export function profileFor(options: {
  mode: SelectorMode;
  shape: PageShape;
  targetCommentId?: string | null;
}): PerfProfileConfig {
  const plan = anchorPlan(options);
  const fallback = scrollRootFallbackSelector(options.mode, options.shape);
  return {
    name: options.mode,
    scrollRoot: scrollRootSelector(options.mode, options.shape),
    ...(fallback ? { scrollRootFallback: fallback } : null),
    items: options.shape === "list" ? "" : options.mode === "legacy" ? LEGACY.items : CONTRACT.items,
    skeleton: options.mode === "legacy" ? LEGACY.skeleton : CONTRACT.skeleton,
    anchors: plan.specs,
    rule: plan.rule,
  };
}

/**
 * Profiles to install for one measurement. Contract rounds also sample the
 * legacy table, which is what makes the equivalence evidence possible; legacy
 * rounds only need their own.
 */
export function profilesFor(options: {
  modes: SelectorMode[];
  shape: PageShape;
  targetCommentId?: string | null;
}): PerfProfileConfig[] {
  return options.modes.map((mode) => profileFor({ ...options, mode }));
}

/**
 * DOM row index of one inbox item, in the order `inbox-page.tsx` renders rows.
 *
 * The page does not render the API page verbatim: it dedupes by selection key,
 * applies the source filter, buckets by date and merges successful autopilot runs
 * into one row each (`inbox-page.tsx:144-155`, `502-509`). On production that
 * turned 50 API records into 8 rows, so an API array index addressed a different
 * notification. Reusing the page's own pure functions keeps the two in step; it
 * lives beside `inboxRowSelector` for the same reason.
 *
 * Returns null when the item is not in the rendered list, which the caller
 * reports as a skip rather than clicking a clamped index.
 */
export function inboxDomRowIndex(items: InboxItem[], targetItemId: string): number | null {
  const rows = groupInboxItemsByDate(filterInboxItemsBySource(deduplicateInboxItems(items), "all"))
    .flatMap((group) => group.entries);
  const index = rows.findIndex((entry) => entry.items.some((item) => item.id === targetItemId));
  return index >= 0 ? index : null;
}

/**
 * True when a warm round could not drive its entry page, which is a skip rather
 * than a timing result.
 *
 * Two shapes reach here: the target row is not in the entry list at all
 * (`warm target not found`), and the click happened but the app never selected
 * the intended issue (`deeplink warm: url issue=...`). Both mean the measured
 * page was never opened, so waiting out the ready budget would only report a
 * timeout for a screen the run never reached — the failure mode QA had to
 * re-derive from the DOM on 209.
 */
export function isEntryFailure(message: string | undefined): boolean {
  if (!message) return false;
  return message.startsWith("warm target not found") || message.startsWith("deeplink warm: url issue=");
}

/** True when the page already carries the MUL-384 DOM contract. */
export function detectContractDom(): boolean {
  return typeof document !== "undefined" && document.querySelector(CONTRACT.scrollRoot) !== null;
}
