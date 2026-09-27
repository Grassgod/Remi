#!/usr/bin/env bun
/**
 * Standalone read-only page-speed probe (MUL-383 S1 / plan §2).
 *
 * Measures how long the Issue detail, deep-link, chat and list pages take to
 * settle into their final position, how far they jump on the way there, and what
 * the first screen costs in API requests. Scenarios are `detail-short`,
 * `detail-long`, `detail-running` and `deeplink`, each in a cold-start and an
 * in-app-navigation variant, plus the eleven MUL-367 pages in both variants.
 *
 * Read-only guarantee: every non-GET/HEAD `/api/**` request is aborted inside
 * `page.route()` and reported under `blockedWrites`, so this can run against
 * production. `verifyWriteGuard` proves the guard itself works first.
 *
 * Credentials: the token comes from `MULTIREMI_QA_WEB_TOKEN` only. It is written
 * into the target origin's `localStorage` and never printed, logged, stored in
 * an output file or passed through argv.
 *
 * Usage:
 *   MULTIREMI_QA_WEB_TOKEN=... bun run frontend/scripts/perf/page-speed.ts \
 *     --base-url http://n37-117-209.byted.org --window peak --rounds 5 \
 *     --name MUL-383-baseline-peak-<date>
 *
 * Compare against an earlier schema-2 baseline (pairing is by key + mode):
 *   ... --compare reports/performance/MUL-383-baseline-offpeak-<date>.json
 *
 * Rule definitions and the selector tables: `docs/dev/performance.md`.
 */

import type { Browser, BrowserContext, Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, hostname, platform, release as osRelease, totalmem } from "node:os";
import { join, resolve } from "node:path";
import {
  computeApiPathStats,
  computeScenarioStats,
  installRecorderOnContext,
  ROUND_TIMEOUT_MS,
  type PerfApiEntry,
  type PerfProfileName,
  type PerfRecorderBuffer,
  type PerfRecorderSummary,
} from "./lib/jump-recorder";
import {
  computeRoundMeasurement,
  entryQuietVerdict,
  roundSummary,
  type RoundMeasurement,
} from "./lib/round-measurement";
import {
  ambientProbe,
  attachCollectors,
  launchBrowser,
  median,
  mktContext,
  readDeployedVersion,
  readResourceEntries,
  readWebVitals,
  resolveIdentity,
  sanitizePath,
  TOKEN_ENV,
  VIEWPORT,
  verifyWriteGuard,
  type ApiCollectors,
  type BlockedWrite,
  type StubbedWrite,
} from "./lib/harness";
import {
  anchorPlan,
  isEntryFailure,
  inboxDomRowIndex,
  inboxRowSelector,
  issueRowSelector,
  LEGACY,
  profilesFor,
  type PageShape,
  type SelectorMode,
  type SelectorModeOption,
} from "./lib/selectors";
import {
  rankDeepLinkCandidates,
  selectsByIssue,
  unreadIdsInRow,
  type DeepLinkCandidate,
  type InboxCandidateInput,
} from "./lib/deeplink-target";
import { injectInboxTarget, STUBBED_WRITES, stubLoopNotTerminated } from "./lib/stub-writes";
import {
  collectExcludedRunningIssueIds,
  ENTRY_API_POLL_MS,
  ENTRY_QUIET_CAP_MS,
  EXCLUDED_RUNNING_ISSUE_PARENTS,
  parseArgs,
  usageLines,
  type Options,
} from "./lib/options";
import type { InboxItem } from "../../packages/core/types/inbox";
import {
  buildCompare,
  buildHtml,
  buildMarkdown,
  fmtMs,
  REPORT_SCHEMA,
  type CompareRow,
  type CompareWarning,
  type ReportScenario,
} from "./lib/report";

/** Page size for the deep-link probe reads; 100 is the server's maximum. */
const INBOX_PROBE_PAGE_SIZE = 100;

const RECORDER_GLOBAL = "__mul383Recorder";
/** Entry-page rows appear only after the route's data lands; dev servers also compile on first hit. */
const WARM_ENTRY_TIMEOUT_MS = 15_000;
/** After the click, the app still has to route and mount the target page. */
const WARM_NAV_TIMEOUT_MS = 10_000;
/**
 * Bound on the click -> `?issue=` commit, as a correctness check on the click.
 *
 * The commit is asynchronous and, while the guard fulfils the auto mark-read, it
 * can take seconds: measured on 209 at ~5 s when the mark-read was aborted, and
 * ~181 ms when it was fulfilled (MUL-384 `cmt_cxrxocj4vp3q`). Ten seconds covers a
 * long timeline starving the transition; it never feeds into `readyMs`.
 */
const URL_COMMIT_TIMEOUT_MS = 10_000;

/** The eleven MUL-367 pages, in the order one round visits them. */
const PAGE_SEQUENCE = [
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

type PageKey = (typeof PAGE_SEQUENCE)[number]["key"];

/**
 * Inbox notification types that render `AutopilotRunReport` instead of an issue
 * timeline, so a deep link into them would not exercise the timeline path.
 */
const AUTOPILOT_INBOX_TYPES = ["autopilot_run", "autopilot_run_report", "autopilot"];

const READING_RULE =
  "详情/深链：anchor（agent-stream 优先，否则最新一条评论；深链为 target-comment）可见 + 骨架 0 + 之后 500ms 无移动帧。列表：区域内无骨架且至少 1 个真实行可见 + 500ms 安静。chat：最新一条消息可见 + 500ms 安静；legacy 下 chat/列表退回 H1+无骨架。";

// ── Scenario model ───────────────────────────────────────────────────────────

/** Where a warm round starts from before it clicks into the measured page. */
type WarmEntry = "issues-list" | "inbox";

interface Scenario {
  key: string;
  mode: "cold" | "warm";
  shape: PageShape;
  /** Cold-start URL path, relative to the workspace slug. */
  path: string;
  targetCommentId: string | null;
  entry: WarmEntry;
  /** Issue id for the matching list row; null for the sidebar-nav pages. */
  clickIssueId: string | null;
  /** Sidebar href to click for the MUL-367 pages. */
  sidebarPath: string | null;
  /** Inbox row index, resolved by the deep-link probe. */
  inboxRowIndex: number | null;
  inboxItemId: string | null;
  /** Issue id the warm deep link must land on, asserted through `?issue=`. */
  expectIssueId: string | null;
  /** Reported identifier of that issue, checked against the clicked row's text. */
  expectIdentifier: string | null;
  /**
   * Unread notification ids in the deep-link target's rendered row. This is the
   * auto mark-read effect's working set, so it bounds the stub self-check; empty
   * for every non-deep-link scenario.
   */
  inboxUnreadIds: string[];
  /**
   * The raw inbox row the browser's first page must contain, or null when the
   * scenario does not need the response rewrite. See `injectInboxTarget`.
   */
  inboxTarget: Record<string, unknown> | null;
  target: { identifier: string; note?: string };
  targetSelection: string | null;
  /**
   * Set when this scenario cannot be measured. The row is still emitted, so a
   * reader can tell "intentionally skipped" from "the script never covered it"
   * — the two used to look identical in the artifacts.
   */
  skipReason: string | null;
}

interface DeepLinkTarget extends DeepLinkCandidate {
  issueIdentifier: string;
  /** DOM row to click, derived from the page's own grouping functions. */
  rowIndex: number;
  /** Unread notification ids in this target's rendered row, for the stub bound. */
  unreadIdsInRow: string[];
  /** The raw API row, injected into the browser's first page and used as the stub body. */
  raw: InboxPageItem;
  /** 1-based API page the probe found this target on. */
  apiPage: number;
}

interface RunningIssue {
  issueId: string;
  identifier: string;
  taskCount: number;
}

/**
 * Copies the guard's counters onto the round.
 *
 * Both come from the collectors rather than from `blankRound`, and the aggregate is
 * the sum of these, so the two always agree.
 */
function recordWriteCounts(measurement: RoundMeasurement, collectors: ApiCollectors): void {
  measurement.blockedWrites = collectors.blockedWrites.reduce((sum, write) => sum + write.attempts, 0);
  measurement.stubbedWrites = collectors.stubbedWrites.reduce((sum, write) => sum + write.attempts, 0);
  measurement.inboxInjected = collectors.inboxInjected;
  measurement.inboxPageRequestsBeforeStub = collectors.inboxPageRequestsAtFirstStub;
}

function workspaceUrl(baseUrl: string, slug: string, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}/${encodeURIComponent(slug)}${suffix}`;
}

// ── Probing: deep-link target and running issue ──────────────────────────────

interface InboxPageItem {
  id?: string;
  issue_id?: string | null;
  type?: string;
  read?: boolean;
  archived?: boolean;
  created_at?: string;
  details?: { comment_id?: string | null; issue_session_id?: string | null } | null;
}

/**
 * Picks the deep-link target from the recent inbox pages.
 *
 * Reading more than one API page is what keeps this scenario measurable: page one
 * covers only a few hours on a busy account, so a page-one-only rule skipped the
 * whole scenario whenever no recent mention existed (MUL-384 `cmt_sr7dl2nrdyq7`).
 *
 * The extra pages are *only* used to choose a target. The measured round still
 * exercises "the target is on the first screen", because `lib/harness.ts` injects
 * the chosen item into the browser's first-page response — paging the UI would mix
 * how old the newest mention happens to be into `readyMs`, and a row whose page
 * number changes between runs cannot be compared (MUL-384 `cmt_lkj0gsgtkfey`).
 *
 * The selected key is an *issue*, not a notification id: `inboxItemSelectionKind`
 * sends every notification carrying an `issue_id` to `?issue=<issueId>&session=`,
 * which resolves to that issue's newest notification in the loaded list. Only
 * ledger rows (autopilot runs, organizer actions) select by `?item=`, and those
 * render `AutopilotRunReport` instead of an issue timeline, so they are not
 * eligible here anyway.
 *
 * `--inbox-item` remains an explicit override and must be inside the probe window.
 */
async function probeDeepLinkTarget(options: {
  baseUrl: string;
  token: string;
  pinnedItemId: string | null;
  runningIssueIds: Set<string>;
  probePages: number;
}): Promise<{ target: DeepLinkTarget | null; skipped: string | null }> {
  const { baseUrl, token, pinnedItemId, runningIssueIds, probePages } = options;

  const headers = { Authorization: `Bearer ${token}` };
  const pages: Array<{ items: InboxPageItem[]; hasCursor: boolean }> = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < probePages; page++) {
      const query = new URLSearchParams({ limit: String(INBOX_PROBE_PAGE_SIZE) });
      if (cursor) query.set("cursor", cursor);
      const res = await fetch(`${baseUrl}/api/inbox/page?${query.toString()}`, { headers });
      if (!res.ok) break;
      const body = (await res.json()) as { items?: InboxPageItem[]; next_cursor?: string | null; has_more?: boolean };
      const items = Array.isArray(body.items) ? body.items : [];
      pages.push({ items, hasCursor: page > 0 });
      cursor = typeof body.next_cursor === "string" ? body.next_cursor : null;
      if (!cursor || body.has_more === false) break;
    }
  } catch {
    // Reported as "no eligible item" below.
  }

  // Newest-first across pages: page order already reflects the keyset cursor.
  const allItems: Array<InboxPageItem & { __page?: number }> = pages.flatMap((entry, index) =>
    entry.items.map((item) => ({ ...item, __page: index + 1 })),
  );
  // The first page drives the injection decision and the row index; it is the page
  // the browser actually receives unmodified.
  const firstPage = pages[0]?.items ?? [];

  if (pinnedItemId) {
    const candidate = rankDeepLinkCandidates(allItems, runningIssueIds)
      .find((entry) => entry.inboxItemId === pinnedItemId);
    if (!candidate) {
      const raw = allItems.find((item) => item.id === pinnedItemId);
      // Distinguish "not in the probe window" from "in the window but ineligible":
      // the two need different follow-ups.
      return {
        target: null,
        skipped: raw ? "inbox-item-has-no-comment" : "inbox-item-not-found-within-probe-depth",
      };
    }
    return finishDeepLinkTarget(candidate, firstPage, allItems);
  }

  const candidates = rankDeepLinkCandidates(allItems, runningIssueIds);
  if (candidates.length === 0) return { target: null, skipped: "no-eligible-inbox-item" };
  for (const candidate of candidates) {
    const finished = finishDeepLinkTarget(candidate, firstPage, allItems);
    if (finished.target) return finished;
  }
  return { target: null, skipped: "no-eligible-inbox-item-in-dom" };
}

/**
 * True when the real first page already carries a newer notification for the
 * target's issue.
 *
 * `?issue=` selects that issue's *newest* notification, so a newer one on page one
 * would be selected instead of the probed item: the measured landing point would
 * differ from the reported target. Reported as a skip rather than measured as
 * something else.
 */
function isTargetSuperseded(firstPage: InboxPageItem[], targetIssueId: string, targetCreatedAt: string): boolean {
  return firstPage.some(
    (item) =>
      item.issue_id === targetIssueId
      // A ledger row selects by `?item=`, so it never competes for the `?issue=`
      // selection and cannot supersede the target.
      && selectsByIssue(item as InboxCandidateInput)
      && typeof item.created_at === "string"
      && item.created_at > targetCreatedAt,
  );
}

/**
 * Attaches the click-time facts to a ranked candidate: the DOM row the page will
 * actually render it in, and the unread ids that a click will auto-mark-read.
 *
 * The row comes from the page's own grouping functions, and the unread ids are the
 * auto mark-read effect's working set — both are needed before the click, one to
 * find the row and one to bound the stub self-check.
 */
function finishDeepLinkTarget(
  candidate: DeepLinkCandidate,
  firstPage: InboxPageItem[],
  allItems: InboxPageItem[],
): { target: DeepLinkTarget | null; skipped: string | null } {
  const raw = allItems[candidate.apiIndex] as (InboxPageItem & { __page?: number }) | undefined;
  if (!raw) return { target: null, skipped: "no-eligible-inbox-item" };
  const apiPage = typeof raw.__page === "number" ? raw.__page : 1;
  const createdAt = typeof raw.created_at === "string" ? raw.created_at : "";
  // A newer notification for the same issue on the real first page would win the
  // `?issue=` selection, so the measured landing point would not be this target.
  if (createdAt && isTargetSuperseded(firstPage, candidate.issueId, createdAt)) {
    return { target: null, skipped: "inbox-target-superseded" };
  }
  // The row index and the unread set are computed on the page the browser will
  // actually receive: the real first page with the target injected. Anything else
  // would describe a list the measured round never renders.
  const prepared = injectInboxTarget(
    { items: firstPage },
    raw as unknown as Record<string, unknown>,
    { hasCursor: false },
  );
  const preparedItems = (prepared as { items: InboxPageItem[] }).items;
  const rowIndex = inboxDomRowIndex(preparedItems as unknown as InboxItem[], candidate.inboxItemId);
  if (rowIndex === null) return { target: null, skipped: "no-eligible-inbox-item-in-dom" };
  return {
    target: {
      ...candidate,
      issueIdentifier: candidate.issueId,
      rowIndex,
      unreadIdsInRow: unreadIdsInRow(preparedItems as unknown as InboxCandidateInput[], candidate.issueId),
      raw,
      apiPage,
    },
    skipped: null,
  };
}

interface FixtureState {
  identifier: string;
  status: string | null;
  archived: boolean;
  commentCount: number | null;
  timelineEntries: number | null;
  /** Why this fixture cannot be measured, or null when it can. */
  skipReason: string | null;
}

/**
 * Everything the report needs about one fixture, in one read-only call each.
 *
 * The fixtures are designated by comment count and must be enterable from the
 * default issues list, which lists neither archived nor cancelled issues. Finding
 * that out by clicking is what burned a 20 s round on production, so the state is
 * checked up front and surfaced as an explicit skip.
 *
 * `commentCount` counts timeline entries whose wire `type` is `comment`; the
 * timeline also carries `activity` entries, so the raw array length is not the
 * comment count. `timelineEntries` keeps that total separately.
 */
async function probeFixture(baseUrl: string, token: string, issueId: string): Promise<FixtureState> {
  const headers = { Authorization: `Bearer ${token}` };
  const issue = await fetchJson<{ identifier?: string; status?: string; archived_at?: string | null }>(
    `${baseUrl}/api/issues/${encodeURIComponent(issueId)}`,
    headers,
  ).catch(() => null);
  const timeline = await fetchJson<{ entries?: Array<{ type?: string }> } | Array<{ type?: string }>>(
    `${baseUrl}/api/issues/${encodeURIComponent(issueId)}/timeline`,
    headers,
  ).catch(() => null);
  // The no-cursor form answers with a bare array; the paged form wraps it in
  // `entries`. Both are legitimate shapes for this endpoint.
  const entries = Array.isArray(timeline)
    ? timeline
    : Array.isArray(timeline?.entries)
      ? timeline.entries
      : null;
  const commentCount = entries
    ? entries.filter((entry) => entry && typeof entry === "object" && entry.type === "comment").length
    : null;
  const archived = Boolean(issue?.archived_at);
  const status = issue?.status ?? null;
  const skipReason = !issue
    ? "fixture-unreadable"
    : archived
      ? "fixture-archived"
      : status === "cancelled"
        ? "fixture-cancelled"
        : null;
  return {
    identifier: issue?.identifier ?? issueId,
    status,
    archived,
    commentCount,
    timelineEntries: entries ? entries.length : null,
    skipReason,
  };
}

/** Resolves an identifier for reporting without needing the issue detail endpoint. */
async function resolveIdentifiers(
  baseUrl: string,
  token: string,
  issueIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const headers = { Authorization: `Bearer ${token}` };
  for (const issueId of issueIds) {
    try {
      const res = await fetch(`${baseUrl}/api/issues/${issueId}`, { headers });
      if (!res.ok) continue;
      const body = (await res.json()) as { identifier?: string; title?: string };
      if (body.identifier) out.set(issueId, body.identifier);
    } catch {
      // Falls back to the raw id in the report.
    }
  }
  return out;
}

/**
 * Finds an issue with an agent currently running, excluding MUL-383 and all of
 * its children. Returns null when there is none, which is not a failure: the
 * scenario is reported as skipped.
 */
/**
 * The task list speaks camelCase (`issueId`); the snake_case form only appears on
 * some older serializers. Reading one name silently matched nothing and reported
 * `0 running task(s)` for a task that was running, so accept both.
 */
interface TaskListRow {
  issueId?: string | null;
  issue_id?: string | null;
}

function taskIssueId(task: TaskListRow): string | null {
  return task.issueId ?? task.issue_id ?? null;
}

/**
 * Every issue that currently has a running task, regardless of which one the
 * `detail-running` scenario picked.
 *
 * The deep-link probe ranks candidates by this: a running issue can append a
 * comment inside the 500 ms quiet window, which would be recorded as a jump that
 * has nothing to do with the landing position. One read-only call, shared by both
 * users, instead of two list requests.
 */
async function loadRunningIssueIds(baseUrl: string, token: string): Promise<Set<string>> {
  const body = await fetchJson<{ tasks?: Array<TaskListRow> }>(
    `${baseUrl}/api/multiremi/tasks?status=running&limit=200`,
    { Authorization: `Bearer ${token}` },
  ).catch(() => null);
  const ids = new Set<string>();
  for (const task of body?.tasks ?? []) {
    const issueId = taskIssueId(task);
    if (issueId) ids.add(issueId);
  }
  return ids;
}

async function probeRunningIssue(options: {
  baseUrl: string;
  token: string;
  explicitIssueId: string | null;
  excludedIssueIds: Set<string>;
}): Promise<RunningIssue | null> {
  const { baseUrl, token, explicitIssueId, excludedIssueIds } = options;
  const headers = { Authorization: `Bearer ${token}` };

  if (explicitIssueId) {
    if (excludedIssueIds.has(explicitIssueId)) return null;
    // The explicit target is trusted even when the task list has not caught up:
    // a caller pinning `--issue-running` is asserting the issue is live, and a
    // zero count here would otherwise silently drop the scenario.
    const tasks = await fetchJson<{ tasks?: Array<TaskListRow> }>(
      `${baseUrl}/api/multiremi/tasks?status=running&limit=200`,
      headers,
    ).catch(() => null);
    const count = (tasks?.tasks ?? []).filter((task) => taskIssueId(task) === explicitIssueId).length;
    return { issueId: explicitIssueId, identifier: explicitIssueId, taskCount: count };
  }

  const body = await fetchJson<{ tasks?: Array<TaskListRow> }>(
    `${baseUrl}/api/multiremi/tasks?status=running&limit=200`,
    headers,
  ).catch(() => null);
  const counts = new Map<string, number>();
  for (const task of body?.tasks ?? []) {
    const issueId = taskIssueId(task);
    if (!issueId) continue;
    if (excludedIssueIds.has(issueId)) continue;
    counts.set(issueId, (counts.get(issueId) ?? 0) + 1);
  }
  for (const [issueId, taskCount] of counts) {
    return { issueId, identifier: issueId, taskCount };
  }
  return null;
}

/** Every issue id that must stay out of the running-issue pick: MUL-383 and its children. */
async function loadExcludedIssueIds(baseUrl: string, token: string): Promise<Set<string>> {
  const headers = { Authorization: `Bearer ${token}` };
  const children: string[] = [];
  for (const parentId of EXCLUDED_RUNNING_ISSUE_PARENTS) {
    try {
      const res = await fetch(`${baseUrl}/api/issues/children?parent_ids=${encodeURIComponent(parentId)}`, {
        headers,
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { issues?: Array<{ id?: string }> };
      for (const child of body.issues ?? []) if (child.id) children.push(child.id);
    } catch {
      // The parent itself remains excluded; a failure here only widens the pick.
    }
  }
  // Leaves and parents are fixed constants (MUL-454 is the ≥200-comment fixture
  // and must never become `detail-running`'s target); the children come from the
  // API because new MUL-383 sub-issues appear over time.
  return collectExcludedRunningIssueIds(children);
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── Measurement ──────────────────────────────────────────────────────────────

function blankRound(round: number, url: string): RoundMeasurement {
  return {
    round,
    url,
    selectorMode: "legacy",
    anchorRule: "",
    readyMs: null,
    readyTimeout: false,
    firstRealMs: null,
    anchorVisibleMs: null,
    anchorName: null,
    anchorRectAtReady: null,
    appReadyMs: null,
    appReadyForced: false,
    dataFreshAtReady: false,
    jumpCount: 0,
    jumpPx: 0,
    jumpScrollPx: 0,
    jumps: [],
    layoutShiftCount: 0,
    cls: 0,
    serialDepth: 0,
    serialChain: [],
    apiCallsTotal: 0,
    apiFirstScreen: 0,
    apiFirstScreenEntries: [],
    chunksLoaded: 0,
    chunkBytes: 0,
    slowestServerTotalMs: null,
    selectorEquivalence: null,
    lcpMs: null,
    navStartMs: 0,
    clickT: null,
    entryReadyMs: null,
    entryInflightAtClick: null,
    entrySettled: null,
    blockedWrites: 0,
    stubbedWrites: 0,
    urlCommitMs: null,
    clickedRowText: null,
    inboxInjected: false,
    inboxPageRequestsBeforeStub: null,
    timelineRequests: 0,
    targetIndexFromLatest: null,
    entryFailed: false,
  };
}

async function recorderSummary(page: Page): Promise<PerfRecorderSummary | null> {
  return page
    .evaluate((name) => {
      const recorder = (window as unknown as Record<string, { summary?: () => unknown }>)[name];
      return (recorder?.summary?.() ?? null) as never;
    }, RECORDER_GLOBAL)
    .catch(() => null);
}

async function freezeRecorder(page: Page): Promise<void> {
  await page
    .evaluate((name) => {
      (window as unknown as Record<string, { stop?: () => void }>)[name]?.stop?.();
    }, RECORDER_GLOBAL)
    .catch(() => {});
}

async function readRecorderBuffer(page: Page): Promise<PerfRecorderBuffer | null> {
  return page
    .evaluate((name) => {
      const recorder = (window as unknown as Record<string, { read?: () => unknown }>)[name];
      return (recorder?.read?.() ?? null) as never;
    }, RECORDER_GLOBAL)
    .catch(() => null);
}

async function resetRecorderAt(page: Page, from: number | null): Promise<number | null> {
  return page
    .evaluate(
      (args) => {
        const [name, value] = args;
        const recorder = (window as unknown as Record<string, { reset?: (t?: number) => void }>)[name];
        recorder?.reset?.(typeof value === "number" ? value : undefined);
        return performance.now();
      },
      [RECORDER_GLOBAL, from] as const,
    )
    .catch(() => null);
}

/**
 * Waits for the ready window of whichever profile this page actually has.
 *
 * The mode comes from the DOM generation (`contractDom`: does the document carry
 * a `[data-perf-scroll]`?), never from which profile reached ready first. A list
 * page satisfies the heading rule in *both* tables because they share the
 * content-region root, so readiness alone cannot say which DOM was measured; the
 * old "first profile to be ready wins" rule therefore reported `contract` for a
 * production legacy round. Both profiles are polled in one loop, so a legacy
 * round never pays a contract timeout first.
 */
async function waitForReady(
  page: Page,
  deadlineMs: number,
  requested: SelectorModeOption,
): Promise<{ summary: PerfRecorderSummary | null; profile: PerfProfileName | null }> {
  const started = Date.now();
  let last: PerfRecorderSummary | null = null;
  // `auto` follows the DOM generation; an explicit `--selectors` overrides it, so
  // the same production page can be measured through either table on purpose.
  const resolveMode = (summary: PerfRecorderSummary): PerfProfileName =>
    requested === "auto" ? (summary.contractDom ? "contract" : "legacy") : requested;
  while (Date.now() - started < deadlineMs) {
    const summary = await recorderSummary(page);
    if (summary) {
      last = summary;
      const mode = resolveMode(summary);
      if (summary.profiles[mode]?.ready) return { summary, profile: mode };
    }
    await page.waitForTimeout(50);
  }
  if (!last) return { summary: null, profile: null };
  const mode = resolveMode(last);
  return { summary: last, profile: last.profiles[mode]?.rootFound ? mode : null };
}

/**
 * Runs one measured round in a fresh context.
 *
 * Cold rounds `goto` the target URL. Warm rounds land on the entry page, hover
 * the target row for `hoverLeadMs` (so `AppLink`'s route prefetch and any data
 * prefetch can run), then click it; `navStart` is the in-page click timestamp,
 * which avoids the CDP round-trip error a Node clock would add.
 */
async function measureRound(options: {
  browser: Browser;
  token: string;
  baseUrl: string;
  slug: string;
  scenario: Scenario;
  round: number;
  opts: Options;
  knownIds: string[];
}): Promise<{
  round: RoundMeasurement;
  blocked: BlockedWrite[];
  stubbed: StubbedWrite[];
  collectors: ApiCollectors;
}> {
  const { browser, baseUrl, slug, scenario, round, opts, knownIds } = options;
  const targetUrl = workspaceUrl(baseUrl, slug, scenario.path);
  const cold = scenario.mode === "cold";
  const measurement = blankRound(round, targetUrl);

  // Both tables are sampled, always: the contract one is the target, and the
  // legacy one provides the equivalence evidence and the fallback for a DOM
  // that predates MUL-384. Sampling is installed before any document exists, so
  // a warm in-app navigation is covered without re-injecting.
  const context = await mktContext(browser, options.token, [], baseUrl);
  await installRecorderOnContext(context, {
    profiles: profilesFor({ modes: ["contract", "legacy"], shape: scenario.shape, targetCommentId: scenario.targetCommentId }),
  });
  const page = await context.newPage();
  const collectors = attachCollectors(page, round, scenario.key, knownIds, {
    // Only the deep link needs the response rewrite: its target has to be on the
    // browser's first inbox page even when the probe found it further down.
    inboxTarget: scenario.inboxTarget,
  });

  // Attached before the first navigation: an entry-page request that starts
  // during the initial load still has to count as activity, and the tracker has to
  // see it start rather than only its settled response.
  const activity = trackEntryApiActivity(page);

  try {
    if (cold) {
      await page.goto(targetUrl, { waitUntil: "commit", timeout: ROUND_TIMEOUT_MS });
    } else {
      const entryUrl = workspaceUrl(baseUrl, slug, scenario.entry === "inbox" ? "/inbox" : "/issues");
      const entryStartedAt = Date.now();
      const entryNavigate = page.goto(entryUrl, { waitUntil: "commit", timeout: ROUND_TIMEOUT_MS });
      await entryNavigate;
      // The row poll inside `clickWarmTarget` is the entry page's readiness
      // condition: a rendered row in a skeleton-free content region. The recorder
      // cannot judge this page, because it samples the *target* page's shape.
      const warm = await clickWarmTarget(page, scenario, opts, options.token, activity, entryStartedAt);
      measurement.urlCommitMs = warm.urlCommitMs;
      measurement.clickedRowText = warm.clickedRowText;
      measurement.entryReadyMs = warm.entryReadyMs;
      measurement.entrySettled = warm.entrySettled;
      measurement.entryInflightAtClick = warm.inflightAtClick;
      const clickT = await page
        .evaluate((name) => {
          const recorder = (window as unknown as Record<string, { read?: () => { clicks: Array<{ t: number }> } }>)[name];
          const clicks = recorder?.read?.().clicks ?? [];
          return clicks.length > 0 ? clicks[clicks.length - 1]!.t : null;
        }, RECORDER_GLOBAL)
        .catch(() => null);
      measurement.clickT = clickT;
      measurement.navStartMs = clickT ?? 0;
      // The click has to be in the buffer before the app can navigate; resetting
      // at its timestamp keeps the reported clock on the page's own timeline.
      if (measurement.clickT !== null) await resetRecorderAt(page, measurement.clickT);
    }
  } catch (error) {
    measurement.error = (error as Error).message;
    // An entry that cannot be driven is a skip, not a slow page: waiting out the
    // ready budget would report a timeout for a round that never left the entry
    // page. Close the context and report the reason.
    if (!cold && isEntryFailure(measurement.error)) {
      measurement.entryFailed = true;
      recordWriteCounts(measurement, collectors);
      await page.close();
      return {
        round: buildRoundMeasurement({
          measurement,
          scenario,
          summary: null,
          measuredProfile: null,
          buffer: null,
          vitals: { lcpMs: null },
          resources: [],
          collectors,
          quietMs: opts.quietMs,
        }),
        blocked: [...collectors.blockedWrites],
        stubbed: [...collectors.stubbedWrites],
        collectors,
      };
    }
  }

  const { summary, profile: measuredProfile } = await waitForReady(page, ROUND_TIMEOUT_MS, opts.selectors);

  // Freeze the page before reading the guard's counters: a request that lands while
  // the round is being wrapped up would otherwise be counted here but not in the
  // aggregate (the two used to differ by three attempts).
  await page.route("**/api/**", (route) => route.abort()).catch(() => {});
  recordWriteCounts(measurement, collectors);

  // Self-check: every stubbed mark-read should settle its item, so more than
  // `2 x` the row's unread ids means the response rewrite did not take effect and
  // the page is still looping. Abandon the round rather than measure inside the
  // failure loop (MUL-384 `cmt_5857w2m9uiyi`).
  const unreadIds = scenario.inboxUnreadIds ?? [];
  if (stubLoopNotTerminated(measurement.stubbedWrites, unreadIds.length)) {
    measurement.error = "stub-loop-not-terminated";
    await page.close();
    return {
      round: buildRoundMeasurement({
        measurement,
        scenario,
        summary: null,
        measuredProfile: null,
        buffer: null,
        vitals: { lcpMs: null },
        resources: [],
        collectors,
        quietMs: opts.quietMs,
      }),
      blocked: [...collectors.blockedWrites],
      stubbed: [...collectors.stubbedWrites],
      collectors,
    };
  }

  await freezeRecorder(page);
  const buffer = await readRecorderBuffer(page);
  const vitals = await readWebVitals(page);
  const resources = await readResourceEntries(page, baseUrl, knownIds);
  await page.close();

  return {
    round: buildRoundMeasurement({
      measurement,
      scenario,
      summary,
      measuredProfile,
      buffer,
      vitals,
      resources,
      collectors,
      quietMs: opts.quietMs,
    }),
    blocked: [...collectors.blockedWrites],
    stubbed: [...collectors.stubbedWrites],
    collectors,
  };
}

/**
 * How many timeline responses a round made, and where the deep-link target sits
 * among them. Both come from the `/comments`-side bodies the collector already
 * captured, so nothing extra is requested.
 */
function timelineInfo(bodies: Map<string, unknown>, targetCommentId: string | null): {
  requests: number;
  targetIndexFromLatest: number | null;
} {
  const requests = bodies.size;
  if (!targetCommentId || requests === 0) return { requests, targetIndexFromLatest: null };
  let best: number | null = null;
  for (const body of bodies.values()) {
    const entries = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { entries?: unknown }).entries)
        ? (body as { entries: unknown[] }).entries
        : [];
    const index = entries.findIndex((entry) => {
      const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : null;
      return typeof id === "string" && id === targetCommentId;
    });
    if (index < 0) continue;
    const fromLatest = entries.length - 1 - index;
    best = best === null ? fromLatest : Math.min(best, fromLatest);
  }
  return { requests, targetIndexFromLatest: best };
}

/**
 * The entry page's API activity, as seen by the driver itself.
 *
 * Resource Timing cannot answer "was a request still in flight at the click": an
 * entry only lands in the buffer once the response settled. Playwright's own
 * request lifecycle can, and it fires on the driver's clock, so both the quiet
 * rule and the in-flight count come from here. Requests the write guard aborts
 * are included — an aborted request is still the entry page doing work.
 */
function trackEntryApiActivity(page: Page): {
  /** Requests started but not yet finished or failed. */
  inflight: () => number;
  /** `Date.now()` when the last `/api/**` request started; 0 when none has. */
  lastStartAt: () => number;
} {
  const inflight = new Set<unknown>();
  let lastStartAt = 0;
  page.on("request", (request) => {
    if (!request.url().includes("/api/")) return;
    inflight.add(request);
    lastStartAt = Date.now();
  });
  const settle = (request: unknown): void => {
    inflight.delete(request);
  };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
  return { inflight: () => inflight.size, lastStartAt: () => lastStartAt };
}

/**
 * Waits for the entry page to go quiet: no new `/api/**` request started within
 * `quietMs`, capped at {@link ENTRY_QUIET_CAP_MS}.
 *
 * Off by default (`--entry-quiet-ms`), because clicking as soon as a row renders
 * versus waiting for the entry page to settle measure different things and the
 * choice is a contract change the issue owner owns (plan §0 item 1). Timed out
 * is not an error: the click goes ahead and the round records
 * `entrySettled: false`, so the reader can tell a quiet click from a busy one.
 */
async function waitForEntryQuiet(
  page: Page,
  activity: { lastStartAt: () => number },
  quietMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    const lastStartAt = activity.lastStartAt();
    const verdict = entryQuietVerdict({
      sinceLastApiMs: lastStartAt > 0 ? Date.now() - lastStartAt : null,
      quietMs,
      waitedMs: Date.now() - startedAt,
      capMs: ENTRY_QUIET_CAP_MS,
    });
    if (verdict === "settled") return true;
    if (verdict === "timeout") return false;
    await page.waitForTimeout(ENTRY_API_POLL_MS);
  }
}

/**
 * Hovers then clicks the row that opens this scenario's page.
 *
 * The click target lives on the *entry* page (the issues list or the inbox),
 * whose DOM may or may not carry the MUL-384 attributes, so both tables are
 * tried. A row that is not in the first render of the list is a hard skip rather
 * than a reason to fall back to another entry path: the warm scenario exists to
 * exercise `ListRow`'s hover prefetch, and measuring a different route would
 * report a number for a code path S3 does not touch.
 */
async function clickWarmTarget(
  page: Page,
  scenario: Scenario,
  opts: Options,
  token: string,
  activity: { inflight: () => number; lastStartAt: () => number },
  entryStartedAt: number,
): Promise<{
  urlCommitMs: number | null;
  clickedRowText: string | null;
  entryReadyMs: number;
  inflightAtClick: number | null;
  entrySettled: boolean | null;
}> {
  const selectors: string[] = [];
  if (scenario.shape === "issue-detail" && scenario.inboxItemId !== null) {
    selectors.push(inboxRowSelector("contract"), inboxRowSelector("legacy"));
  } else if (scenario.clickIssueId) {
    selectors.push(issueRowSelector("contract", scenario.clickIssueId), issueRowSelector("legacy", scenario.clickIssueId));
  } else if (scenario.sidebarPath) {
    // Sidebar nav buttons render as anchors; the link text is localized, so the
    // href the paths module builds is the stable hook.
    selectors.push(`[data-slot="sidebar"] a[href$="${scenario.sidebarPath}"]`);
    selectors.push(`a[href$="${scenario.sidebarPath}"]`);
  }

  // A warm round lands on the entry page and then clicks a real row, so the row has
  // to exist before the click. The row poll below is also the entry page's
  // readiness condition — a rendered row in a skeleton-free content region — so no
  // fixed sleep is needed. The recorder cannot judge this page, because it samples
  // the *target* page's shape.
  const deadline = Date.now() + WARM_ENTRY_TIMEOUT_MS;
  let chosen: { selector: string; index: number; count: number } | null = null;
  while (chosen === null && Date.now() < deadline) {
    const skeletons = await page
      .locator(`${LEGACY.listRoot} [data-slot="skeleton"]`)
      .count()
      .catch(() => 0);
    if (skeletons === 0) {
      // The inbox row index is recomputed here, at click time, from the list the
      // page has actually rendered. A probe-time index goes stale: the production
      // inbox is a rolling window and the four detail rounds in between took about
      // a minute, which moved the target from row 7 to row 8 and made the click
      // land on an unrelated notification (MUL-384 `cmt_cxrxocj4vp3q`).
      for (const selector of selectors) {
        const count = await page.locator(selector).count().catch(() => 0);
        if (count === 0) continue;
        const fresh = await resolveWarmRowIndex(scenario, opts, token, count);
        if (fresh === null) continue;
        chosen = { selector, index: fresh, count };
        break;
      }
    }
    // Keep polling until the deadline: "no skeleton" is true before the rows mount,
    // so a missing row is only a verdict once the whole entry budget is spent.
    if (chosen === null) await page.waitForTimeout(200);
  }
  if (chosen === null) {
    throw new Error(`warm target not found for ${scenario.key}`);
  }
  const entryReadyMs = Date.now() - entryStartedAt;

  // Entry-page quiet rule (`--entry-quiet-ms`), off by default. It has to run
  // after the row exists — the row is the entry page's readiness condition — and
  // before the hover lead, so the hover's own prefetch does not read as activity.
  let entrySettled: boolean | null = null;
  if (opts.entryQuietMs !== null) {
    entrySettled = await waitForEntryQuiet(page, activity, opts.entryQuietMs);
  }
  const inflightAtClick = activity.inflight();

  let lastError: string | null = null;
  let clickedRowText: string | null = null;
  let clicked = false;
  for (const selector of [chosen.selector, ...selectors.filter((candidate) => candidate !== chosen!.selector)]) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    const index = await resolveWarmRowIndex(scenario, opts, token, count) ?? Math.min(chosen.index, count - 1);
    const row = locator.nth(index);
    try {
      await row.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      await row.hover({ timeout: 5_000 });
      await page.waitForTimeout(opts.hoverLeadMs);
      const text = await row.innerText().catch(() => "");
      await row.click({ timeout: 5_000 });
      clickedRowText = text.slice(0, 200);
      clicked = true;
      break;
    } catch (error) {
      lastError = (error as Error).message;
      continue;
    }
  }
  if (!clicked) {
    throw new Error(`warm target not found for ${scenario.key}${lastError ? `: ${lastError.split("\n")[0]}` : ""}`);
  }

  // The click only counts once the app has selected the intended issue. The URL
  // commit is asynchronous (`replace` runs inside `startTransition`) and, while the
  // guard is fulfilling the auto mark-read, it can take seconds; 10 s is the agreed
  // bound. This is a correctness check on the click, never part of `readyMs`.
  if (scenario.expectIssueId === null) {
    return { urlCommitMs: null, clickedRowText, entryReadyMs, inflightAtClick, entrySettled };
  }
  const startedAt = Date.now();
  const issueParam = await waitForUrlIssue(page, scenario.expectIssueId, URL_COMMIT_TIMEOUT_MS);
  const urlCommitMs = Date.now() - startedAt;
  if (issueParam !== scenario.expectIssueId) {
    throw new Error(
      `deeplink warm: url issue=${issueParam ?? "(none)"} expected ${scenario.expectIssueId}`,
    );
  }
  return { urlCommitMs, clickedRowText, entryReadyMs, inflightAtClick, entrySettled };
}

/**
 * Row index to click for a warm round.
 *
 * Every non-deep-link scenario clicks the first matching row. The deep link is the
 * only one that needs a specific row, and its index must be computed *now*: the
 * probe's snapshot is taken before the detail rounds run, and the production inbox
 * is a rolling window, so a probe-time index is routinely stale by click time
 * (MUL-384 `cmt_cxrxocj4vp3q`: `domRow=7` clicked an unrelated notification while
 * the target had moved to row 8).
 *
 * Returns null when the target is not in the current snapshot, which the caller
 * reports as `skipped: warm-target-not-in-list` rather than clicking a clamped
 * index.
 */
async function resolveWarmRowIndex(
  scenario: Scenario,
  opts: Options,
  token: string,
  count: number,
): Promise<number | null> {
  // Only the deep link needs a specific row: every other scenario clicks the first
  // matching issue row (or the sidebar link it already selected).
  if (scenario.inboxItemId === null) return 0;
  const fresh = await fetchInboxPageItems(opts.baseUrl, token);
  if (fresh.length === 0) return null;
  // The row index has to describe the list the browser actually received: the real
  // first page with the target injected. Indexing the un-injected page would point
  // at a different notification whenever the probe read past page one.
  const prepared = scenario.inboxTarget
    ? injectInboxTarget({ items: fresh }, scenario.inboxTarget, { hasCursor: false })
    : { items: fresh };
  const preparedItems = (prepared as { items: Array<Record<string, unknown>> }).items;
  const index = inboxDomRowIndex(preparedItems as unknown as InboxItem[], scenario.inboxItemId);
  if (index === null || index >= count) return null;
  return index;
}

/** One page of inbox rows, read straight from the API. */
async function fetchInboxPageItems(baseUrl: string, token: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${baseUrl}/api/inbox/page?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const body = (await res.json().catch(() => null)) as { items?: unknown[] } | null;
  const items = Array.isArray(body?.items) ? body.items : [];
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

/** `?issue=` currently in the URL, or null when the parameter is absent. */
async function selectedIssueInUrl(page: Page): Promise<string | null> {
  const url = page.url();
  const match = /[?&]issue=([^&]+)/.exec(url);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * Waits for the URL's `issue` parameter to become `expected`, and returns
 * whatever it holds when the wait gives up (so the caller can report the actual
 * value). The inbox commits its selection inside `startTransition`, so the URL
 * updates a tick after the click rather than synchronously.
 */
async function waitForUrlIssue(page: Page, expected: string, timeoutMs = 3_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await selectedIssueInUrl(page);
    if (current === expected || Date.now() >= deadline) return current;
    await page.waitForTimeout(100);
  }
}

/**
 * Applies {@link computeRoundMeasurement} to a round and stamps the driver's own
 * counters onto it.
 *
 * The arithmetic lives in `lib/round-measurement.ts` (pure, unit-tested); this
 * function only supplies the browser-side inputs and keeps the report shape
 * stable.
 */
function buildRoundMeasurement(input: {
  measurement: RoundMeasurement;
  scenario: Scenario;
  summary: PerfRecorderSummary | null;
  measuredProfile: PerfProfileName | null;
  buffer: PerfRecorderBuffer | null;
  vitals: { lcpMs: number | null };
  resources: Awaited<ReturnType<typeof readResourceEntries>>;
  collectors: ApiCollectors;
  quietMs: number;
}): RoundMeasurement {
  const { measurement, scenario, summary, measuredProfile, buffer, vitals, resources, collectors, quietMs } = input;
  const mode: SelectorMode = measuredProfile ?? (summary?.contractDom ? "contract" : "legacy");
  const computed = computeRoundMeasurement({
    mode,
    shape: scenario.shape,
    targetCommentId: scenario.targetCommentId,
    navStartMs: measurement.navStartMs,
    frames: buffer?.frames ?? [],
    shifts: buffer?.shifts ?? [],
    stateTransitions: buffer?.stateTransitions ?? [],
    resources,
    quietMs,
    profileReady: summary?.profiles[mode]?.ready ?? null,
  });
  Object.assign(measurement, computed);
  measurement.lcpMs = vitals.lcpMs;

  const timeline = timelineInfo(collectors.timelineBodies, scenario.targetCommentId);
  measurement.timelineRequests = timeline.requests;
  measurement.targetIndexFromLatest = timeline.targetIndexFromLatest;

  if (buffer && buffer.errors.length > 0) {
    measurement.error = [...(measurement.error ? [measurement.error] : []), ...buffer.errors].join("; ");
  }
  return measurement;
}

// ── Scenario matrix ──────────────────────────────────────────────────────────

function buildScenarios(options: {
  deepLink: DeepLinkTarget | null;
  deepLinkSkip: string | null;
  runningIssue: RunningIssue | null;
  runningSkip: string;
  issueShort: string;
  issueLong: string;
  /** The ≥200-comment fixture for `detail-xlong`, or null to skip that scenario. */
  issueXlong: string | null;
  /** Fixture state from the API: identifiers, comment counts and eligibility. */
  shortFixture: FixtureState;
  longFixture: FixtureState;
  xlongFixture: FixtureState;
  pinnedInboxItem: string | null;
  deepLinkAuto: boolean;
}): Scenario[] {
  const scenarios: Scenario[] = [];
  const withCount = (note: string | undefined, count: number | null): string | undefined => {
    if (count === null) return note;
    return note ? `${note}，${count} 条评论` : `${count} 条评论`;
  };
  const detailScenarios = [
    {
      key: "detail-short",
      issueId: options.issueShort,
      identifier: options.shortFixture.identifier,
      note: withCount(undefined, options.shortFixture.commentCount),
      skipReason: options.shortFixture.skipReason,
    },
    {
      key: "detail-long",
      issueId: options.issueLong,
      identifier: options.longFixture.identifier,
      note: withCount("长", options.longFixture.commentCount),
      skipReason: options.longFixture.skipReason,
    },
  ];
  // The ≥200-comment scenario (MUL-454). It is a sibling of `detail-long`, not a
  // replacement: MUL-395's before/after comparison is pinned to MUL-70, and
  // existing scenario keys must keep pairing. `--issue-xlong ''` drops the row.
  if (options.issueXlong !== null) {
    detailScenarios.push({
      key: "detail-xlong",
      issueId: options.issueXlong,
      identifier: options.xlongFixture.identifier,
      note: withCount("超长", options.xlongFixture.commentCount),
      skipReason: options.xlongFixture.skipReason,
    });
  }
  detailScenarios.push({
    key: "detail-running",
    issueId: options.runningIssue?.issueId ?? "",
    identifier: options.runningIssue?.identifier ?? "(none)",
    note: options.runningIssue ? `运行中任务 ${options.runningIssue.taskCount}` : undefined,
    skipReason: options.runningIssue ? null : options.runningSkip,
  });

  for (const detail of detailScenarios) {
    // The cold scenario always has a URL worth loading; a skipped scenario
    // simply never measures it.
    const path = `/issues/${encodeURIComponent(detail.issueId || "none")}`;
    for (const mode of ["cold", "warm"] as const) {
      scenarios.push({
        key: detail.key,
        mode,
        shape: "issue-detail" as PageShape,
        path,
        targetCommentId: null,
        entry: "issues-list" as WarmEntry,
        clickIssueId: detail.issueId || null,
        sidebarPath: null,
        inboxRowIndex: null,
        inboxItemId: null,
        expectIssueId: null,
        expectIdentifier: null,
        inboxUnreadIds: [],
        inboxTarget: null,
        target: { identifier: detail.identifier, ...(detail.note ? { note: detail.note } : {}) },
        targetSelection: null,
        skipReason: detail.skipReason,
      });
    }
  }

  const deepLink = options.deepLink;
  {
    // `?issue=` is the form every notification carrying an issue resolves to:
    // `inboxItemSelectionKind` keeps `?item=` for ledger rows only, and those
    // render a report rather than a timeline. See `probeDeepLinkTarget`.
    const path = deepLink
      ? `/inbox?issue=${encodeURIComponent(deepLink.issueId)}${
        deepLink.sessionId ? `&session=${encodeURIComponent(deepLink.sessionId)}` : ""
      }`
      : "/inbox";
    // `none` when the probe produced no target: the old ternary folded that case
    // into `pinned`, so a skipped row claimed a pinned target it never had
    // (MUL-384 `cmt_sr7dl2nrdyq7`).
    const targetSelection = options.pinnedInboxItem
      ? "pinned"
      : options.deepLinkAuto
        ? "auto"
        : "none";
    for (const mode of ["cold", "warm"] as const) {
      scenarios.push({
        key: "deeplink",
        mode,
        shape: "issue-detail" as PageShape,
        path,
        targetCommentId: deepLink?.commentId ?? null,
        entry: "inbox" as WarmEntry,
        clickIssueId: null,
        sidebarPath: null,
        inboxRowIndex: deepLink?.rowIndex ?? null,
        inboxItemId: deepLink?.inboxItemId ?? null,
        expectIssueId: deepLink?.issueId ?? null,
        expectIdentifier: deepLink?.issueIdentifier ?? null,
        inboxUnreadIds: deepLink?.unreadIdsInRow ?? [],
        inboxTarget: (deepLink?.raw as Record<string, unknown> | undefined) ?? null,
        target: {
          identifier: deepLink
            ? `${deepLink.issueId}${deepLink.issueHasRunningTask ? "（running）" : ""}`
            : options.pinnedInboxItem ?? "(auto)",
        },
        targetSelection,
        skipReason: deepLink ? null : options.deepLinkSkip ?? "no-eligible-inbox-item",
      });
    }
  }

  for (const page of PAGE_SEQUENCE) {
    const shape: PageShape = page.key === "chat" ? "chat" : "list";
    for (const mode of ["cold", "warm"] as const) {
      scenarios.push({
        key: `page-${page.key}`,
        mode,
        shape,
        path: page.path,
        targetCommentId: null,
        entry: "issues-list" as WarmEntry,
        clickIssueId: null,
        sidebarPath: mode === "warm" ? page.path : null,
        inboxRowIndex: null,
        inboxItemId: null,
        expectIssueId: null,
        expectIdentifier: null,
        inboxUnreadIds: [],
        inboxTarget: null,
        target: { identifier: page.key },
        targetSelection: null,
        skipReason: null,
      });
    }
  }
  return scenarios;
}

/**
 * Visits every scenario once so a `next dev` server compiles each route before
 * the measured rounds start. Nothing here is measured or reported: dev servers
 * compile a route on first request (17 s for the inbox in one local run), which
 * would otherwise burn the whole 20 s round budget and hide the page's real
 * behavior. The production baselines run against a built image and pass no
 * `--warmup`.
 */
async function warmupScenarios(options: {
  browser: Browser;
  token: string;
  baseUrl: string;
  slug: string;
  scenarios: Scenario[];
}): Promise<void> {
  const { browser, token, baseUrl, slug, scenarios } = options;
  const context = await mktContext(browser, token, [], baseUrl);
  await installRecorderOnContext(context, {
    profiles: profilesFor({ modes: ["legacy"], shape: "issue-detail", targetCommentId: null }),
  });
  const page = await context.newPage();
  // Warmup visits the measured routes, which includes the deep-link `?issue=` URL.
  // That URL auto-marks its target read, so without the guard here the warmup would
  // change the fixture state the measured rounds then read. Attach the same guard the
  // rounds use; the warmup's own counters are discarded.
  attachCollectors(page, 0, "warmup", []);
  // Warm the entry pages once: both the issues list and the inbox are the
  // starting point of every warm round.
  const entries = new Set<string>();
  for (const scenario of scenarios) entries.add(scenario.entry);
  try {
    for (const entry of entries) {
      const entryPath = entry === "inbox" ? "/inbox" : "/issues";
      await page.goto(workspaceUrl(baseUrl, slug, entryPath), { waitUntil: "load", timeout: ROUND_TIMEOUT_MS }).catch(() => {});
      // Let the client finish its first data fetch before moving on: a route is
      // only compiled past the point the compiler has seen it.
      await page.waitForTimeout(1_500);
    }
    for (const scenario of scenarios) {
      await page
        .goto(workspaceUrl(baseUrl, slug, scenario.path), { waitUntil: "load", timeout: ROUND_TIMEOUT_MS })
        .catch(() => {});
      await page.waitForTimeout(500);
      process.stdout.write(`  warmup ${scenario.key.padEnd(18)} ${scenario.mode.padEnd(4)} ok\n`);
    }
  } finally {
    await context.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${usageLines().join("\n")}\n`);
    return;
  }
  const token = process.env[TOKEN_ENV];
  if (!token) {
    throw new Error(
      `${TOKEN_ENV} is empty. This probe reads the token from that variable only; ` +
        "provide it through the QA Agent Custom Env and never paste it into a command line.",
    );
  }

  const identity = await resolveIdentity(opts.baseUrl, token);
  const knownIds = [identity.workspaceId, identity.workspaceSlug, identity.memberId].filter(
    (value): value is string => typeof value === "string" && value.length > 2,
  );
  const deployed = await readDeployedVersion(opts.baseUrl, token);
  const runner = `${hostname()} (${platform()} ${osRelease()} ${arch()}, ${cpus().length} vCPU, ${Math.round(totalmem() / 1024 ** 3)} GiB RAM)`;
  const browser = await launchBrowser();
  const allBlocked: BlockedWrite[] = [];
  const allStubbed: StubbedWrite[] = [];

  try {
    process.stdout.write(
      `page-speed: ${opts.baseUrl} workspace=${identity.workspaceSlug} window=${opts.window} rounds=${opts.rounds} selectors=${opts.selectors}\n`,
    );

    const ambientBefore = await ambientProbe(opts.baseUrl);
    const guardSelfTest = await verifyWriteGuard(browser, token, opts.baseUrl);
    process.stdout.write(
      `  guard self-test: ${guardSelfTest.blocked ? "blocked" : "FAILED"} (${guardSelfTest.detail})\n`,
    );
    // A guard that cannot stop a deliberate POST is not a read-only guarantee:
    // measuring production with it would risk real writes. Refuse to start, and
    // write no artifact, so a broken guard can never be mistaken for a baseline.
    if (!guardSelfTest.blocked) {
      throw new Error(
        `write guard self-test FAILED (${guardSelfTest.detail}); refusing to run any scenario`,
      );
    }

    const phase = (label: string, startedAt: number): void => {
      process.stdout.write(`  ${label} took ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
    };

    let phaseStarted = Date.now();
    const excluded = await loadExcludedIssueIds(opts.baseUrl, token);
    phase("loadExcludedIssueIds", phaseStarted);

    phaseStarted = Date.now();
    const allRunningIssueIds = await loadRunningIssueIds(opts.baseUrl, token);
    phase("loadRunningIssueIds", phaseStarted);

    phaseStarted = Date.now();
    const running = await probeRunningIssue({
      baseUrl: opts.baseUrl,
      token,
      explicitIssueId: opts.issueRunning,
      excludedIssueIds: excluded,
    });
    phase("probeRunningIssue", phaseStarted);

    phaseStarted = Date.now();
    const deepLinkProbe = await probeDeepLinkTarget({
      baseUrl: opts.baseUrl,
      token,
      pinnedItemId: opts.inboxItem,
      runningIssueIds: allRunningIssueIds,
      probePages: opts.inboxProbePages,
    });
    phase("probeDeepLinkTarget", phaseStarted);

    phaseStarted = Date.now();
    // One read per fixture gives the identifier, the comment count and whether
    // the fixture is still enterable from the default list.
    const [shortFixture, longFixture, xlongFixture] = await Promise.all([
      probeFixture(opts.baseUrl, token, opts.issueShort),
      probeFixture(opts.baseUrl, token, opts.issueLong),
      opts.issueXlong === null
        ? Promise.resolve<FixtureState>({
          identifier: "(skipped)",
          status: null,
          archived: false,
          commentCount: null,
          timelineEntries: null,
          skipReason: "scenario-disabled",
        })
        : probeFixture(opts.baseUrl, token, opts.issueXlong),
    ]);
    phase("probeFixtures", phaseStarted);
    for (const [key, fixture] of [
      ["detail-short", shortFixture],
      ["detail-long", longFixture],
      ["detail-xlong", xlongFixture],
    ] as const) {
      process.stdout.write(
        `  ${key}: ${fixture.identifier}${fixture.skipReason ? ` SKIPPED (${fixture.skipReason})` : ""}` +
          `, ${fixture.commentCount ?? "?"} comment(s), ${fixture.timelineEntries ?? "?"} timeline entries\n`,
      );
    }

    const identifierIds = new Set<string>();
    if (running) identifierIds.add(running.issueId);
    if (deepLinkProbe.target) identifierIds.add(deepLinkProbe.target.issueId);
    const identifiers = await resolveIdentifiers(opts.baseUrl, token, [...identifierIds]);
    const label = (issueId: string): string => identifiers.get(issueId) ?? issueId;

    const fixtureByScenario = new Map<string, FixtureState>([
      ["detail-short", shortFixture],
      ["detail-long", longFixture],
      ["detail-xlong", xlongFixture],
    ]);

    const scenarios = buildScenarios({
      deepLink: deepLinkProbe.target,
      deepLinkSkip: deepLinkProbe.skipped,
      runningIssue: running,
      runningSkip: "all-running-issues-in-mul383-family",
      issueShort: opts.issueShort,
      issueLong: opts.issueLong,
      issueXlong: opts.issueXlong,
      shortFixture,
      longFixture,
      xlongFixture,
      pinnedInboxItem: opts.inboxItem,
      deepLinkAuto: deepLinkProbe.target !== null,
    });

    if (running) {
      process.stdout.write(`  detail-running: ${label(running.issueId)} (${running.taskCount} running task(s))\n`);
    } else {
      process.stdout.write("  detail-running: skipped (no running agent)\n");
    }
    if (deepLinkProbe.target) {
      process.stdout.write(
        `  deeplink: ${deepLinkProbe.target.inboxItemId} apiIndex=${deepLinkProbe.target.apiIndex} domRow=${deepLinkProbe.target.rowIndex} issue=${deepLinkProbe.target.issueId} comment=${deepLinkProbe.target.commentId}${deepLinkProbe.target.sessionId ? " (session scoped)" : ""}\n`,
      );
    } else {
      process.stdout.write(`  deeplink: skipped (${deepLinkProbe.skipped ?? "unknown"})\n`);
    }

    const selected = opts.only
      ? scenarios.filter((scenario) => scenario.key.startsWith(opts.only!))
      : scenarios;

    if (opts.warmup) {
      phaseStarted = Date.now();
      await warmupScenarios({
        browser,
        token,
        baseUrl: opts.baseUrl,
        slug: identity.workspaceSlug,
        // Skipped scenarios are never measured, so warming their pages only spends
        // the compile budget on a route this run will not visit.
        scenarios: selected.filter((scenario) => scenario.skipReason === null),
      });
      phase("warmup", phaseStarted);
    }

    const byScenario: ReportScenario[] = [];
    for (const scenario of selected) {
      // A skipped scenario still produces a row, so a reader can tell "the rule
      // excluded this" from "the script never looked". Both used to collapse into
      // a missing row, which is exactly what QA flagged on 209.
      if (scenario.skipReason !== null) {
        byScenario.push({
          key: scenario.key,
          mode: scenario.mode,
          target: scenario.target,
          rule: READING_RULE,
          anchorRule: anchorRulePreview(scenario),
          selectorMode: opts.selectors === "contract" ? "contract" : "legacy",
          skipped: true,
          skipReason: scenario.skipReason,
          hoverLeadMs: scenario.mode === "warm" ? opts.hoverLeadMs : null,
          rounds: [],
          stats: { ...computeScenarioStats([]), apiByPath: [] },
          ...(fixtureByScenario.has(scenario.key)
            ? { timelineEntries: fixtureByScenario.get(scenario.key)!.timelineEntries }
            : null),
          ...deepLinkScenarioFields(scenario, deepLinkProbe.target),
        });
        continue;
      }

      const rounds: RoundMeasurement[] = [];
      for (let round = 1; round <= opts.rounds; round++) {
        const { round: measured, blocked, stubbed } = await measureRound({
          browser,
          token,
          baseUrl: opts.baseUrl,
          slug: identity.workspaceSlug,
          scenario,
          round,
          opts,
          knownIds,
        });
        allBlocked.push(...blocked);
        allStubbed.push(...stubbed);
        rounds.push(measured);
        process.stdout.write(
          `  ${scenario.key.padEnd(18)} ${scenario.mode.padEnd(4)} round ${round}: ` +
            `ready=${fmtMs(measured.readyMs)}ms firstReal=${fmtMs(measured.firstRealMs)}ms ` +
            `jumps=${measured.jumpCount}(${fmtMs(measured.jumpPx)}px) depth=${measured.serialDepth ?? "-"} ` +
            `api=${measured.apiFirstScreen}/${measured.apiCallsTotal} mode=${measured.selectorMode}` +
            `${measured.readyTimeout ? " TIMEOUT" : ""}${measured.error ? ` ERROR=${measured.error.slice(0, 80)}` : ""}\n`,
        );
        if (measured.selectorMode === "contract" && measured.selectorEquivalence) {
          process.stdout.write(
            `    equivalence scrollRoot=${measured.selectorEquivalence.scrollRoot} anchor=${measured.selectorEquivalence.anchor} ` +
              `contractOnly=${measured.selectorEquivalence.itemsContractOnly} legacyOnly=${measured.selectorEquivalence.itemsLegacyOnly}\n`,
          );
        }
      }

      const mode: SelectorMode = rounds.some((round) => round.selectorMode === "contract") ? "contract" : "legacy";
      // An entry failure means the measured page was never opened, so the row is
      // reported as skipped with the reason instead of as a 20 s timeout. The
      // round detail is still carried, because it holds the error text.
      const entryFailure = rounds.find((round) => round.entryFailed) ?? null;
      byScenario.push({
        key: scenario.key,
        mode: scenario.mode,
        target: scenario.target,
        rule: READING_RULE,
        anchorRule: rounds[0]?.anchorRule ?? anchorRulePreview(scenario),
        selectorMode: mode,
        skipped: entryFailure !== null,
        skipReason: entryFailure
          ? (scenario.expectIssueId !== null ? "warm-target-url-mismatch" : "warm-target-not-in-list")
          : null,
        ...(scenario.targetSelection ? { targetSelection: scenario.targetSelection } : {}),
        ...(fixtureByScenario.has(scenario.key)
          ? { timelineEntries: fixtureByScenario.get(scenario.key)!.timelineEntries }
          : null),
        // Deep-link bookkeeping for a measured row: which notification was used,
        // where it sat in the API page and which DOM row the click targeted.
        ...deepLinkScenarioFields(scenario, deepLinkProbe.target),
        hoverLeadMs: scenario.mode === "warm" ? opts.hoverLeadMs : null,
        rounds: rounds.map(roundSummary),
        stats: {
          ...computeScenarioStats(
            rounds.map((round) => ({
              readyMs: round.readyMs,
              readyTimeout: round.readyTimeout,
              firstRealMs: round.firstRealMs,
              jumpCount: round.jumpCount,
              jumpPx: round.jumpPx,
              serialDepth: round.serialDepth,
              apiCallsTotal: round.apiFirstScreen,
              slowestServerTotalMs: round.slowestServerTotalMs,
            })),
          ),
          // Per path, not per round: the acceptance rule is stated per path, and a
          // round-level "slowest API" cannot answer "did /api/inbox/summary get
          // faster" (plan §9).
          apiByPath: computeApiPathStats(rounds.map((round) => ({ apiFirstScreenEntries: round.apiFirstScreenEntries }))),
        },
      });
    }

    const ambientAfter = await ambientProbe(opts.baseUrl);
    const webVersions = [...new Set(deployed.webVersion ? [deployed.webVersion] : [])];
    const generatedAt = new Date().toISOString();
    const meta: Record<string, unknown> = {
      schema: REPORT_SCHEMA,
      issue: "MUL-383",
      task: "MUL-384",
      generatedAt,
      beijingTime: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
      window: opts.window,
      baseUrl: opts.baseUrl,
      workspaceSlug: identity.workspaceSlug,
      workspaceName: identity.workspaceName,
      memberName: identity.memberName,
      rounds: opts.rounds,
      runner,
      mode: "headless Chromium (no desktop session) via frontend/scripts/perf/page-speed.ts",
      viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
      readingRule: READING_RULE,
      selectorMode: opts.selectors,
      hoverLeadMs: opts.hoverLeadMs,
      quietMs: opts.quietMs,
      // The entry-page quiet rule (MUL-383 pending item A1, answered 2026-09-27)
      // is on by default: a warm round waits for the entry page to go quiet before
      // clicking. The meta records the exact window and cap this run used, so a
      // reader can tell an A1 run from a pre-A1 one, and `--entry-quiet-ms 0`
      // records null.
      entryQuietMs: opts.entryQuietMs,
      entryQuietCapMs: ENTRY_QUIET_CAP_MS,
      entryQuietNote:
        "warm 轮点击前等入口页在阈值内没有新的 /api 请求开始；超过上限照点并记 entrySettled=false。0/关闭时 entryQuietMs 为 null。",
      timeBase:
        "cold 从文档 origin 起算；warm 从页面内记录的 click（navStartMs）起算。帧、跳动、首屏集合都先减 navStartMs，首屏集合另有 startMs >= navStartMs 下界。",
      roundTimeoutMs: ROUND_TIMEOUT_MS,
      byteAccounting:
        "encodedBodySize=压缩后传输体积，decodedBodySize=解压后 JSON 体积，transferSize=含响应头的传输体积",
      lcpNote: "LCP 由 PerformanceObserver 类型条目读取；无候选时为 null",
      writeGuardSelfTest: guardSelfTest,
      // The allow-list is part of the measurement contract, so the report states
      // exactly which writes were stubbed rather than aborted.
      stubbedWriteAllowList: STUBBED_WRITES.map((rule) => ({
        method: rule.method,
        label: rule.label,
        reason: rule.reason,
      })),
      // The response rewrites are part of the measurement contract: the first puts
      // the deep-link target on the browser's first page, the second stops the
      // mark-read retry loop.
      inboxResponseRewrites: ["target-injection", "read-state"],
      ambientLatency: { before: ambientBefore, after: ambientAfter },
      ambientNote:
        "生产为共享环境：同一台机器复跑时，先看 /api/config 的中位耗时是否与本次接近，再比较页面数字。",
      apiVersion: deployed.apiVersion ?? null,
      apiRef: deployed.apiRef ?? null,
      ...deployed,
    };
    void webVersions;

    const compare = opts.compare
      ? buildCompare(
          JSON.parse(readFileSync(resolve(opts.compare), "utf8")) as {
            scenarios: ReportScenario[];
            meta?: { schema?: number };
          },
          { scenarios: byScenario, meta },
        )
      : null;

    const payload = {
      meta,
      scenarios: byScenario,
      blockedWrites: allBlocked,
      stubbedWrites: allStubbed,
      ...(compare
        ? { compare: { rows: compare.rows, pathRows: compare.pathRows, warnings: compare.warnings } }
        : {}),
    };

    const outDir = resolve(opts.outDir);
    mkdirSync(outDir, { recursive: true });
    const stem = opts.name ?? `mul383-page-speed-${generatedAt.replace(/[:.]/g, "-")}`;
    const jsonPath = join(outDir, `${stem}.json`);
    const mdPath = join(outDir, `${stem}.md`);
    const htmlPath = join(outDir, `${stem}.html`);
    writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    writeFileSync(
      mdPath,
      buildMarkdown({
        meta,
        scenarios: byScenario,
        blockedWrites: allBlocked,
        stubbedWrites: allStubbed,
        compare: compare?.markdown ?? null,
      }),
      "utf8",
    );
    writeFileSync(
      htmlPath,
      buildHtml({
        meta,
        scenarios: byScenario,
        blockedWrites: allBlocked,
        stubbedWrites: allStubbed,
        compareTable: compare?.rows ?? null,
        comparePathTable: compare?.pathRows ?? null,
      }),
      "utf8",
    );
    process.stdout.write(`\nwrote ${jsonPath}\nwrote ${mdPath}\nwrote ${htmlPath}\n`);
    if (compare && compare.warnings.length > 0) {
      process.stdout.write(`  ${compare.warnings.length} compare warning(s):\n`);
      for (const warning of compare.warnings) {
        process.stdout.write(`    ${warning.key} (${warning.mode}): ${warning.message}\n`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Deep-link bookkeeping for a report row.
 *
 * Which notification and which DOM row were used is what makes two runs
 * comparable, and a skipped deep link needs it just as much as a measured one:
 * the reason it was skipped is usually "the target was not on the rendered page".
 */
function deepLinkScenarioFields(
  scenario: Scenario,
  target: DeepLinkTarget | null,
): {
  targetSelection?: string;
  inboxItemId?: string | null;
  issueHasRunningTask?: boolean;
  inboxApiIndex?: number | null;
  inboxDomRowIndex?: number | null;
  targetRead?: boolean;
  targetGroupHasUnread?: boolean;
  /** 1-based API page the probe read the target from. */
  inboxApiPage?: number | null;
} {
  if (scenario.key !== "deeplink") return {};
  if (!target) return scenario.targetSelection ? { targetSelection: scenario.targetSelection } : {};
  return {
    targetSelection: scenario.targetSelection ?? undefined,
    inboxItemId: target.inboxItemId,
    issueHasRunningTask: target.issueHasRunningTask,
    inboxApiIndex: target.apiIndex,
    inboxDomRowIndex: target.rowIndex,
    // The probe prefers an unread target, because selecting one is the path a user
    // almost always takes and it therefore exercises the auto mark-read. Reporting
    // `targetRead` makes the choice visible, and `targetGroupHasUnread` says whether
    // a mark-read was expected at all (the stub self-check's denominator).
    targetRead: target.read,
    targetGroupHasUnread: target.groupHasUnread,
    inboxApiPage: target.apiPage,
  };
}

/** Anchor rule without a measured frame: used for the skipped-scenario rows. */
function anchorRulePreview(scenario: Scenario): string {
  const plan = anchorPlan({
    mode: "contract",
    shape: scenario.shape,
    targetCommentId: scenario.targetCommentId,
  });
  return plan.anchorRule;
}

void main().catch((error: unknown) => {
  process.stderr.write(`page-speed failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
