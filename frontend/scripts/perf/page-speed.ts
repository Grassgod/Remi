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
  computeAppReadyMs,
  computeFirstRealMs,
  computeJumps,
  computeReadyWindow,
  computeScenarioStats,
  computeSelectorEquivalence,
  computeWaves,
  frameAt,
  installRecorderOnContext,
  ROUND_TIMEOUT_MS,
  summarizeLayoutShifts,
  type PerfFrame,
  type PerfLayoutShift,
  type PerfProfileConfig,
  type PerfProfileName,
  type PerfRecorderBuffer,
  type PerfRecorderSummary,
} from "./lib/jump-recorder";
import {
  ambientProbe,
  attachCollectors,
  launchBrowser,
  median,
  mktContext,
  parseServerTiming,
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
} from "./lib/harness";
import {
  anchorPlan,
  inboxRowSelector,
  issueRowSelector,
  profilesFor,
  type PageShape,
  type SelectorMode,
  type SelectorModeOption,
} from "./lib/selectors";
import {
  buildCompare,
  buildHtml,
  buildMarkdown,
  fmtMs,
  type CompareRow,
  type CompareWarning,
  type ReportRoundSummary,
  type ReportScenario,
} from "./lib/report";

const DEFAULT_BASE_URL = "http://n37-117-209.byted.org";
const DEFAULT_ROUNDS = 3;
const DEFAULT_OUT_DIR = "reports/performance";
const DEFAULT_QUIET_MS = 500;
const DEFAULT_HOVER_LEAD_MS = 150;
const RECORDER_GLOBAL = "__mul383Recorder";
/** Entry-page rows appear only after the route's data lands; dev servers also compile on first hit. */
const WARM_ENTRY_TIMEOUT_MS = 15_000;
/** After the click, the app still has to route and mount the target page. */
const WARM_NAV_TIMEOUT_MS = 10_000;

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

/** MUL-383 and every child of it: excluded from the running-issue pick. */
const EXCLUDED_RUNNING_ISSUES = ["iss_j67lb0r8djw4"];

/**
 * Inbox notification types that render `AutopilotRunReport` instead of an issue
 * timeline, so a deep link into them would not exercise the timeline path.
 */
const AUTOPILOT_INBOX_TYPES = ["autopilot_run", "autopilot_run_report", "autopilot"];

const READING_RULE =
  "详情/深链：anchor（agent-stream 优先，否则最新一条评论；深链为 target-comment）可见 + 骨架 0 + 之后 500ms 无移动帧。列表：区域内无骨架且至少 1 个真实行可见 + 500ms 安静。chat：最新一条消息可见 + 500ms 安静；legacy 下 chat/列表退回 H1+无骨架。";

interface Options {
  baseUrl: string;
  rounds: number;
  outDir: string;
  name: string | null;
  compare: string | null;
  quietMs: number;
  window: "peak" | "offpeak";
  selectors: SelectorModeOption;
  issueShort: string;
  issueLong: string;
  issueRunning: string | null;
  inboxItem: string | null;
  hoverLeadMs: number;
  only: string | null;
  /**
   * Visit every scenario once before measuring. Only for a `next dev` server,
   * which compiles a route the first time it is requested; a warmup keeps that
   * one-off cost out of the numbers. Production runs a built image, so the
   * baselines are collected without it.
   */
  warmup: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    baseUrl: DEFAULT_BASE_URL,
    rounds: DEFAULT_ROUNDS,
    outDir: DEFAULT_OUT_DIR,
    name: null,
    compare: null,
    quietMs: DEFAULT_QUIET_MS,
    window: "offpeak",
    selectors: "auto",
    issueShort: "iss_1or5ray9rrj8",
    issueLong: "iss_8vhk0frd8thl",
    issueRunning: null,
    inboxItem: null,
    hoverLeadMs: DEFAULT_HOVER_LEAD_MS,
    only: null,
    warmup: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--base-url":
        opts.baseUrl = next().replace(/\/+$/, "");
        break;
      case "--rounds":
        opts.rounds = Number.parseInt(next(), 10);
        break;
      case "--out":
        opts.outDir = next();
        break;
      case "--name":
        opts.name = next();
        break;
      case "--compare":
        opts.compare = next();
        break;
      case "--quiet-ms":
        opts.quietMs = Number.parseInt(next(), 10);
        break;
      case "--window": {
        const value = next();
        if (value !== "peak" && value !== "offpeak") throw new Error("--window must be peak or offpeak");
        opts.window = value;
        break;
      }
      case "--selectors": {
        const value = next();
        if (value !== "auto" && value !== "contract" && value !== "legacy") {
          throw new Error("--selectors must be auto, contract or legacy");
        }
        opts.selectors = value;
        break;
      }
      case "--issue-short":
        opts.issueShort = next();
        break;
      case "--issue-long":
        opts.issueLong = next();
        break;
      case "--issue-running":
        opts.issueRunning = next();
        break;
      case "--inbox-item":
        opts.inboxItem = next();
        break;
      case "--hover-lead-ms":
        opts.hoverLeadMs = Number.parseInt(next(), 10);
        break;
      case "--only":
        opts.only = next();
        break;
      case "--warmup":
        opts.warmup = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.rounds) || opts.rounds < 1) throw new Error("--rounds must be >= 1");
  return opts;
}

function printUsage(): void {
  process.stdout.write(
    [
      `Read-only MUL-383 page-speed probe. Token comes from ${TOKEN_ENV} only.`,
      "",
      `  --base-url <url>       target origin (default ${DEFAULT_BASE_URL})`,
      `  --rounds <n>           repetitions per scenario, each in a fresh context (default ${DEFAULT_ROUNDS})`,
      `  --window peak|offpeak  label recorded in the report (default offpeak)`,
      "  --selectors auto|contract|legacy   DOM contract to use (default auto)",
      "  --issue-short <id>     short issue for detail-short (default iss_1or5ray9rrj8)",
      "  --issue-long <id>      long issue for detail-long (default iss_8vhk0frd8thl)",
      "  --issue-running <id>   agent-running issue; auto-selected when omitted",
      "  --inbox-item <id>      deep-link inbox item; auto-selected from page one when omitted",
      `  --hover-lead-ms <n>    hover lead before an in-app click (default ${DEFAULT_HOVER_LEAD_MS})`,
      `  --out <dir>            output directory (default ${DEFAULT_OUT_DIR})`,
      "  --name <stem>          output file stem (default mul383-page-speed-<timestamp>)",
      "  --compare <baseline>   also emit a before/after comparison",
      "  --only <prefix>        run only scenarios whose key starts with this prefix",
      "  --warmup               visit every scenario once first (for a `next dev` server; not for baselines)",
      "",
    ].join("\n"),
  );
}

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
  target: { identifier: string; note?: string };
  targetSelection: string | null;
}

interface DeepLinkTarget {
  inboxItemId: string;
  commentId: string;
  sessionId: string | null;
  issueId: string;
  issueIdentifier: string;
  read: boolean;
  rowIndex: number;
  type: string;
}

interface RunningIssue {
  issueId: string;
  identifier: string;
  taskCount: number;
}

/** One measured round. */
interface RoundMeasurement {
  round: number;
  url: string;
  selectorMode: SelectorMode;
  readyMs: number | null;
  readyTimeout: boolean;
  firstRealMs: number | null;
  anchorVisibleMs: number | null;
  anchorName: string | null;
  anchorRule: string;
  appReadyMs: number | null;
  appReadyForced: boolean;
  dataFreshAtReady: boolean;
  jumpCount: number;
  jumpPx: number;
  jumpScrollPx: number;
  jumps: Array<{ startMs: number; endMs: number; px: number; scrollPx: number; kind: string; frames: number }>;
  layoutShiftCount: number;
  cls: number;
  serialDepth: number | null;
  serialChain: string[];
  apiCallsTotal: number;
  apiFirstScreen: number;
  chunksLoaded: number;
  chunkBytes: number;
  blockedWrites: number;
  selectorEquivalence: ReturnType<typeof computeSelectorEquivalence>;
  navStartMs: number;
  clickT: number | null;
  timelineRequests: number;
  targetIndexFromLatest: number | null;
  slowestServerTotalMs: number | null;
  lcpMs: number | null;
  error?: string;
}

function roundSummary(round: RoundMeasurement): ReportRoundSummary {
  return {
    round: round.round,
    readyMs: round.readyMs,
    readyTimeout: round.readyTimeout,
    firstRealMs: round.firstRealMs,
    anchorVisibleMs: round.anchorVisibleMs,
    anchorName: round.anchorName,
    anchorRule: round.anchorRule,
    appReadyMs: round.appReadyMs,
    appReadyForced: round.appReadyForced,
    dataFreshAtReady: round.dataFreshAtReady,
    jumpCount: round.jumpCount,
    jumpPx: round.jumpPx,
    layoutShiftCount: round.layoutShiftCount,
    cls: round.cls,
    serialDepth: round.serialDepth,
    apiCallsTotal: round.apiCallsTotal,
    apiFirstScreen: round.apiFirstScreen,
    blockedWrites: round.blockedWrites,
    heapBytes: null,
    // Only the deep link has a target inside the timeline; every other scenario
    // leaves both fields at zero/null so the JSON shape stays uniform.
    targetDepth: {
      timelineRequests: round.timelineRequests,
      targetIndexFromLatest: round.targetIndexFromLatest,
    },
    selectorEquivalence: round.selectorEquivalence,
  };
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
  details?: { comment_id?: string | null; issue_session_id?: string | null } | null;
}

/**
 * Picks the deep-link target from the first inbox page.
 *
 * A fixed item would defeat the measurement: `inbox-page.tsx` walks pages until
 * it finds `?item=`, so an item at position ~769 turns a cold deep link into a
 * paging test. The probe therefore uses a row that is on page one, is not an
 * autopilot-run notification (those render a report instead of a timeline) and
 * carries both a comment id and a session id.
 *
 * `--inbox-item` is an explicit override; if it is not on page one the scenario
 * is skipped rather than measured as paging.
 */
async function probeDeepLinkTarget(options: {
  baseUrl: string;
  token: string;
  slug: string;
  browser: Browser;
  pinnedItemId: string | null;
  excludedIssueIds: Set<string>;
  round: number;
  knownIds: string[];
  selectors: SelectorModeOption;
}): Promise<{ target: DeepLinkTarget | null; skipped: string | null }> {
  const { baseUrl, token, slug, browser, pinnedItemId, excludedIssueIds, round, knownIds, selectors } = options;

  // Read the rendered rows' item ids from the DOM where possible. Each row
  // carries `data-perf-key=<inboxItemId>` once MUL-384 is deployed; on a legacy
  // DOM the id is learned by clicking the row, which the app reflects into
  // `?item=`. That walk is capped at a handful of rows — clicking all of page
  // one makes the probe slower than the measurement it prepares.
  const context = await mktContext(browser, token, [], baseUrl);
  const page = await context.newPage();
  const collectors = attachCollectors(page, round, "inbox-probe", knownIds);
  let rowItemIds: string[] = [];
  try {
    await page.goto(workspaceUrl(baseUrl, slug, "/inbox"), { waitUntil: "commit", timeout: ROUND_TIMEOUT_MS });
    await page.waitForTimeout(1_500);
    const selector = inboxRowSelector("legacy");
    const count = await page.locator(selector).count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 3); index++) {
      const row = page.locator(selector).nth(index);
      await row.click({ timeout: 3_000 }).catch(() => {});
      const match = /[?&]item=([^&]+)/.exec(page.url());
      if (match) rowItemIds.push(decodeURIComponent(match[1]!));
      await page.goBack({ waitUntil: "commit", timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(200);
    }
    rowItemIds = rowItemIds.filter((id) => id.length > 0);
  } catch {
    // The API probe below still has a chance to resolve the target.
  } finally {
    await context.close();
  }
  void selectors;

  const headers = { Authorization: `Bearer ${token}` };
  let firstPage: InboxPageItem[] = [];
  try {
    const res = await fetch(`${baseUrl}/api/inbox/page?limit=50`, { headers });
    if (res.ok) {
      const body = (await res.json()) as { items?: InboxPageItem[] };
      firstPage = Array.isArray(body.items) ? body.items : [];
    }
  } catch {
    // Reported as "no eligible item" below.
  }

  if (pinnedItemId) {
    const index = firstPage.findIndex((item) => item.id === pinnedItemId);
    if (index < 0) return { target: null, skipped: "inbox-item-not-on-first-page" };
    const item = firstPage[index]!;
    const candidate = toDeepLinkTarget(item, pinnedItemId, index, excludedIssueIds);
    if (!candidate) return { target: null, skipped: "inbox-item-has-no-comment" };
    return { target: candidate, skipped: null };
  }

  // Prefer a row we actually saw rendered: its index is what the warm round
  // clicks, and a mismatch between the DOM order and the API page would
  // otherwise silently measure a different notification.
  const preferred: number[] = [];
  for (const itemId of rowItemIds) {
    const index = firstPage.findIndex((item) => item.id === itemId);
    if (index >= 0 && !preferred.includes(index)) preferred.push(index);
  }
  const order = [...preferred, ...firstPage.map((_, index) => index).filter((index) => !preferred.includes(index))];
  for (const index of order) {
    const item = firstPage[index]!;
    const candidate = toDeepLinkTarget(item, item.id ?? "", index, excludedIssueIds);
    if (candidate) return { target: candidate, skipped: null };
  }
  return { target: null, skipped: "no-eligible-inbox-item" };
}

function toDeepLinkTarget(
  item: InboxPageItem,
  inboxItemId: string,
  rowIndex: number,
  excludedIssueIds: Set<string>,
): DeepLinkTarget | null {
  if (!inboxItemId) return null;
  const type = String(item.type ?? "");
  if (AUTOPILOT_INBOX_TYPES.some((candidate) => type === candidate || type.startsWith(`${candidate}_`))) return null;
  const commentId = item.details?.comment_id ?? null;
  const issueId = item.issue_id ?? null;
  if (!commentId || !issueId) return null;
  if (excludedIssueIds.has(issueId)) return null;
  return {
    inboxItemId,
    commentId,
    sessionId: item.details?.issue_session_id ?? null,
    issueId,
    issueIdentifier: issueId,
    read: item.read === true,
    rowIndex,
    type,
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
  const excluded = new Set(EXCLUDED_RUNNING_ISSUES);
  for (const parentId of EXCLUDED_RUNNING_ISSUES) {
    try {
      const res = await fetch(`${baseUrl}/api/issues/children?parent_ids=${encodeURIComponent(parentId)}`, {
        headers,
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { issues?: Array<{ id?: string }> };
      for (const child of body.issues ?? []) if (child.id) excluded.add(child.id);
    } catch {
      // The parent itself remains excluded; a failure here only widens the pick.
    }
  }
  return excluded;
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
    readyMs: null,
    readyTimeout: false,
    firstRealMs: null,
    anchorVisibleMs: null,
    anchorName: null,
    anchorRule: "",
    appReadyMs: null,
    appReadyForced: false,
    dataFreshAtReady: false,
    jumpCount: 0,
    jumpPx: 0,
    jumpScrollPx: 0,
    jumps: [],
    layoutShiftCount: 0,
    cls: 0,
    serialDepth: null,
    serialChain: [],
    apiCallsTotal: 0,
    apiFirstScreen: 0,
    chunksLoaded: 0,
    chunkBytes: 0,
    blockedWrites: 0,
    selectorEquivalence: null,
    navStartMs: 0,
    clickT: null,
    timelineRequests: 0,
    targetIndexFromLatest: null,
    slowestServerTotalMs: null,
    lcpMs: null,
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
 * Contract is preferred; a DOM that predates MUL-384 never populates it, so the
 * legacy profile carries the round instead. Both are polled in one loop, which
 * keeps a legacy round from paying the contract timeout first.
 */
async function waitForReady(
  page: Page,
  deadlineMs: number,
): Promise<{ summary: PerfRecorderSummary | null; profile: PerfProfileName | null }> {
  const started = Date.now();
  let last: PerfRecorderSummary | null = null;
  let legacyGraceUntil = started + 6_000;
  while (Date.now() - started < deadlineMs) {
    const summary = await recorderSummary(page);
    if (summary) {
      last = summary;
      const contract = summary.profiles.contract;
      const legacy = summary.profiles.legacy;
      if (contract?.ready) return { summary, profile: "contract" };
      if (legacy?.ready && (!contract?.rootFound || Date.now() > legacyGraceUntil)) {
        return { summary, profile: "legacy" };
      }
      // Once the contract table has been absent for the whole grace period, the
      // legacy profile is the only one this DOM can satisfy: stop preferring it.
      if (!contract?.rootFound && Date.now() > legacyGraceUntil) legacyGraceUntil = 0;
    }
    await page.waitForTimeout(50);
  }
  return { summary: last, profile: last?.profiles.contract?.rootFound ? "contract" : last?.profiles.legacy?.rootFound ? "legacy" : null };
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
}): Promise<{ round: RoundMeasurement; blocked: BlockedWrite[]; collectors: ApiCollectors }> {
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
  const collectors = attachCollectors(page, round, scenario.key, knownIds);

  try {
    if (cold) {
      await page.goto(targetUrl, { waitUntil: "commit", timeout: ROUND_TIMEOUT_MS });
    } else {
      const entryUrl = workspaceUrl(baseUrl, slug, scenario.entry === "inbox" ? "/inbox" : "/issues");
      await page.goto(entryUrl, { waitUntil: "commit", timeout: ROUND_TIMEOUT_MS });
      // Wait for the entry list to render before hunting for the row; the
      // selectors themselves are mode-agnostic so the contract rollout does not
      // decide whether the click works.
      await page.waitForTimeout(1_500);
      await clickWarmTarget(page, scenario, opts);
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
  }

  const { summary, profile: measuredProfile } = await waitForReady(page, ROUND_TIMEOUT_MS);

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
    blocked: collectors.blockedWrites,
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
 * Hovers then clicks the row that opens this scenario's page.
 *
 * Both selector tables are tried, because the click target lives on the *entry*
 * page (the issues list or the inbox), whose DOM may or may not carry the
 * MUL-384 attributes — and the entry page is not what the round measures.
 */
async function clickWarmTarget(page: Page, scenario: Scenario, opts: Options): Promise<void> {
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

  // A warm round lands on the entry page and then clicks a real row, so the row
  // has to exist before the click. A fixed sleep is not enough: the first hit on
  // a route can take seconds (dev compile, or a cold data fetch), and clicking
  // an empty list leaves the round on the entry page measuring the wrong screen.
  const deadline = Date.now() + WARM_ENTRY_TIMEOUT_MS;
  let chosen: { selector: string; index: number; count: number } | null = null;
  while (chosen === null && Date.now() < deadline) {
    for (const selector of selectors) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count === 0) continue;
      const index = scenario.inboxItemId !== null && typeof scenario.inboxRowIndex === "number"
        ? Math.min(scenario.inboxRowIndex, count - 1)
        : 0;
      chosen = { selector, index, count };
      break;
    }
    if (chosen === null) await page.waitForTimeout(200);
  }
  if (chosen === null) throw new Error(`warm target not found for ${scenario.key}`);

  let lastError: string | null = null;
  for (const selector of [chosen.selector, ...selectors.filter((candidate) => candidate !== chosen!.selector)]) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    const index = scenario.inboxItemId !== null && typeof scenario.inboxRowIndex === "number"
      ? Math.min(scenario.inboxRowIndex, count - 1)
      : Math.min(chosen.index, count - 1);
    const row = locator.nth(index);
    try {
      await row.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      await row.hover({ timeout: 5_000 });
      await page.waitForTimeout(opts.hoverLeadMs);
      await row.click({ timeout: 5_000 });
      return;
    } catch (error) {
      lastError = (error as Error).message;
      continue;
    }
  }
  throw new Error(`warm target not found for ${scenario.key}${lastError ? `: ${lastError.split("\n")[0]}` : ""}`);
}

/**
 * Post-processes one round's raw buffer into the reported numbers.
 *
 * All the arithmetic lives in `lib/jump-recorder.ts`; this function's job is to
 * pick the profile, feed the right windows and keep the report shape stable.
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
  const mode: SelectorMode = measuredProfile ?? (summary?.profiles.contract?.rootFound ? "contract" : "legacy");
  measurement.selectorMode = mode;
  const frames: PerfFrame[] = buffer?.frames ?? [];
  const profile = profileForMeasurement(mode, scenario.shape, scenario.targetCommentId);
  measurement.anchorRule = profile.anchorRule;

  const profileSummary = summary?.profiles[mode] ?? null;
  const firstRealMs = computeFirstRealMs(frames, mode);
  const ready = computeReadyWindow(frames, { profile: profile.config, quietMs, firstRealMs });

  measurement.firstRealMs = firstRealMs;
  measurement.anchorVisibleMs = ready.anchorVisibleMs;
  measurement.anchorName = ready.anchorName ?? profile.anchorName;
  measurement.readyMs = ready.readyMs;
  measurement.readyTimeout = ready.readyTimeout || !ready.readyMs && profileSummary?.ready !== true;

  const jumps = computeJumps(frames, { profile: mode, fromMs: firstRealMs, toMs: ready.readyMs ?? undefined });
  measurement.jumpCount = jumps.jumpCount;
  measurement.jumpPx = jumps.jumpPx;
  measurement.jumpScrollPx = jumps.jumpScrollPx;
  measurement.jumps = jumps.jumps.map((jump) => ({
    startMs: jump.startMs,
    endMs: jump.endMs,
    px: jump.px,
    scrollPx: jump.scrollPx,
    kind: jump.kind,
    frames: jump.frames,
  }));

  const shifts = summarizeLayoutShifts(buffer?.shifts ?? [], { fromMs: firstRealMs, toMs: ready.readyMs ?? undefined });
  measurement.layoutShiftCount = shifts.layoutShiftCount;
  measurement.cls = shifts.cls;

  const appReady = computeAppReadyMs(buffer?.stateTransitions ?? []);
  measurement.appReadyMs = appReady.appReadyMs;
  measurement.appReadyForced = appReady.forced;
  // `data-perf-state` is the app's own verdict; comparing it with the probe's
  // ready window is the cross-check the plan asks for.
  measurement.dataFreshAtReady = appReady.appReadyMs !== null
    && measurement.readyMs !== null
    && Math.abs(appReady.appReadyMs - measurement.readyMs) < 1_000;

  const readiness = ready.readyMs ?? measurement.readyMs ?? firstRealMs ?? ROUND_TIMEOUT_MS;
  const apiEntries = resources.filter(
    (entry) => entry.path.startsWith("/api") && entry.startMs <= readiness,
  );
  const waves = computeWaves(
    apiEntries.map((entry) => ({
      index: entry.index,
      path: entry.path,
      startMs: entry.startMs,
      responseEndMs: entry.responseEndMs,
    })),
  );
  measurement.serialDepth = waves.serialDepth;
  measurement.serialChain = waves.chain.map((index) => {
    const entry = apiEntries.find((candidate) => candidate.index === index);
    return entry ? entry.path : String(index);
  });
  measurement.apiFirstScreen = apiEntries.length;
  measurement.apiCallsTotal = resources.filter((entry) => entry.path.startsWith("/api")).length;

  const chunks = resources.filter((entry) => entry.initiatorType === "script");
  measurement.chunksLoaded = chunks.length;
  measurement.chunkBytes = chunks.reduce((sum, entry) => sum + entry.encodedBytes, 0);

  let slowest = 0;
  for (const entry of apiEntries) {
    const timing = parseServerTiming(entry.serverTiming);
    if (timing.total !== null && timing.total > slowest) slowest = timing.total;
  }
  measurement.slowestServerTotalMs = slowest > 0 ? Math.round(slowest * 10) / 10 : null;
  measurement.lcpMs = vitals.lcpMs;

  const timeline = timelineInfo(collectors.timelineBodies, scenario.targetCommentId);
  measurement.timelineRequests = timeline.requests;
  measurement.targetIndexFromLatest = timeline.targetIndexFromLatest;

  // Contract/legacy agreement, taken at the ready frame. Only meaningful when
  // both profiles sampled the same DOM.
  if (mode === "contract") {
    const referenceT = ready.readyMs ?? measurement.anchorVisibleMs;
    measurement.selectorEquivalence = computeSelectorEquivalence(frameAt(frames, referenceT));
  }

  if (buffer && buffer.errors.length > 0) {
    measurement.error = [...(measurement.error ? [measurement.error] : []), ...buffer.errors].join("; ");
  }
  return measurement;
}

/** The readiness profile used for one measurement, in the mode that actually matched. */
function profileForMeasurement(
  mode: SelectorMode,
  shape: PageShape,
  targetCommentId: string | null,
): { config: PerfProfileConfig; anchorName: string; anchorRule: string } {
  const plan = anchorPlan({ mode, shape, targetCommentId });
  return {
    config: {
      name: mode,
      scrollRoot: "",
      items: "",
      skeleton: "",
      anchors: plan.specs,
      rule: plan.rule,
    },
    anchorName: plan.anchorName,
    anchorRule: plan.anchorRule,
  };
}

// ── Scenario matrix ──────────────────────────────────────────────────────────

function buildScenarios(options: {
  deepLink: DeepLinkTarget | null;
  runningIssue: RunningIssue | null;
  issueShort: string;
  issueLong: string;
  issueShortIdentifier: string;
  issueLongIdentifier: string;
  pinnedInboxItem: string | null;
  deepLinkAuto: boolean;
}): Scenario[] {
  const scenarios: Scenario[] = [];
  const detailScenarios = [
    {
      key: "detail-short",
      issueId: options.issueShort,
      identifier: options.issueShortIdentifier,
      note: undefined as string | undefined,
    },
    {
      key: "detail-long",
      issueId: options.issueLong,
      identifier: options.issueLongIdentifier,
      note: "长（173 条）",
    },
  ];
  if (options.runningIssue) {
    detailScenarios.push({
      key: "detail-running",
      issueId: options.runningIssue.issueId,
      identifier: options.runningIssue.identifier,
      note: `运行中任务 ${options.runningIssue.taskCount}`,
    });
  }

  for (const detail of detailScenarios) {
    const path = `/issues/${encodeURIComponent(detail.issueId)}`;
    scenarios.push({
      key: detail.key,
      mode: "cold",
      shape: "issue-detail",
      path,
      targetCommentId: null,
      entry: "issues-list",
      clickIssueId: detail.issueId,
      sidebarPath: null,
      inboxRowIndex: null,
      inboxItemId: null,
      target: { identifier: detail.identifier, ...(detail.note ? { note: detail.note } : {}) },
      targetSelection: null,
    });
    scenarios.push({
      key: detail.key,
      mode: "warm",
      shape: "issue-detail",
      path,
      targetCommentId: null,
      entry: "issues-list",
      clickIssueId: detail.issueId,
      sidebarPath: null,
      inboxRowIndex: null,
      inboxItemId: null,
      target: { identifier: detail.identifier, ...(detail.note ? { note: detail.note } : {}) },
      targetSelection: null,
    });
  }

  if (options.deepLink) {
    const deepLink = options.deepLink;
    const path = `/inbox?item=${encodeURIComponent(deepLink.inboxItemId)}${
      deepLink.sessionId ? `&session=${encodeURIComponent(deepLink.sessionId)}` : ""
    }`;
    const targetSelection = options.pinnedInboxItem
      ? "pinned"
      : options.deepLinkAuto
        ? "auto-first-page"
        : "pinned";
    scenarios.push({
      key: "deeplink",
      mode: "cold",
      shape: "issue-detail",
      path,
      targetCommentId: deepLink.commentId,
      entry: "inbox",
      clickIssueId: null,
      sidebarPath: null,
      inboxRowIndex: deepLink.rowIndex,
      inboxItemId: deepLink.inboxItemId,
      target: { identifier: `${deepLink.inboxItemId} → ${deepLink.issueIdentifier}` },
      targetSelection,
    });
    scenarios.push({
      key: "deeplink",
      mode: "warm",
      shape: "issue-detail",
      path,
      targetCommentId: deepLink.commentId,
      entry: "inbox",
      clickIssueId: null,
      sidebarPath: null,
      inboxRowIndex: deepLink.rowIndex,
      inboxItemId: deepLink.inboxItemId,
      target: { identifier: `${deepLink.inboxItemId} → ${deepLink.issueIdentifier}` },
      targetSelection,
    });
  }

  for (const page of PAGE_SEQUENCE) {
    const shape: PageShape = page.key === "chat" ? "chat" : "list";
    scenarios.push({
      key: `page-${page.key}`,
      mode: "cold",
      shape,
      path: page.path,
      targetCommentId: null,
      entry: "issues-list",
      clickIssueId: null,
      sidebarPath: null,
      inboxRowIndex: null,
      inboxItemId: null,
      target: { identifier: page.key },
      targetSelection: null,
    });
    scenarios.push({
      key: `page-${page.key}`,
      mode: "warm",
      shape,
      path: page.path,
      targetCommentId: null,
      entry: "issues-list",
      clickIssueId: null,
      sidebarPath: page.path,
      inboxRowIndex: null,
      inboxItemId: null,
      target: { identifier: page.key },
      targetSelection: null,
    });
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

  try {
    process.stdout.write(
      `page-speed: ${opts.baseUrl} workspace=${identity.workspaceSlug} window=${opts.window} rounds=${opts.rounds} selectors=${opts.selectors}\n`,
    );

    const ambientBefore = await ambientProbe(opts.baseUrl);
    const guardSelfTest = await verifyWriteGuard(browser, token, opts.baseUrl);
    process.stdout.write(
      `  guard self-test: ${guardSelfTest.blocked ? "blocked" : "FAILED"} (${guardSelfTest.detail})\n`,
    );

    const phase = (label: string, startedAt: number): void => {
      process.stdout.write(`  ${label} took ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
    };

    let phaseStarted = Date.now();
    const excluded = await loadExcludedIssueIds(opts.baseUrl, token);
    phase("loadExcludedIssueIds", phaseStarted);

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
      slug: identity.workspaceSlug,
      browser,
      pinnedItemId: opts.inboxItem,
      excludedIssueIds: excluded,
      round: 0,
      knownIds,
      selectors: opts.selectors,
    });
    phase("probeDeepLinkTarget", phaseStarted);

    phaseStarted = Date.now();
    const identifierIds = new Set<string>([opts.issueShort, opts.issueLong]);
    if (running) identifierIds.add(running.issueId);
    if (deepLinkProbe.target) identifierIds.add(deepLinkProbe.target.issueId);
    const identifiers = await resolveIdentifiers(opts.baseUrl, token, [...identifierIds]);
    phase("resolveIdentifiers", phaseStarted);
    const label = (issueId: string): string => identifiers.get(issueId) ?? issueId;

    const scenarios = buildScenarios({
      deepLink: deepLinkProbe.target,
      runningIssue: running,
      issueShort: opts.issueShort,
      issueLong: opts.issueLong,
      issueShortIdentifier: label(opts.issueShort),
      issueLongIdentifier: label(opts.issueLong),
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
        `  deeplink: ${deepLinkProbe.target.inboxItemId} row=${deepLinkProbe.target.rowIndex} comment=${deepLinkProbe.target.commentId}${deepLinkProbe.target.sessionId ? " (session scoped)" : ""}\n`,
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
        scenarios: selected,
      });
      phase("warmup", phaseStarted);
    }

    const byScenario: ReportScenario[] = [];
    for (const scenario of selected) {
      if (scenario.key === "detail-running" && !running) {
        byScenario.push({
          key: scenario.key,
          mode: scenario.mode,
          target: scenario.target,
          rule: READING_RULE,
          anchorRule: anchorRulePreview(scenario),
          selectorMode: opts.selectors === "contract" ? "contract" : "legacy",
          skipped: "no running agent",
          hoverLeadMs: scenario.mode === "warm" ? opts.hoverLeadMs : null,
          rounds: [],
          stats: computeScenarioStats([]),
        });
        continue;
      }
      if (scenario.key === "deeplink" && !deepLinkProbe.target) {
        byScenario.push({
          key: scenario.key,
          mode: scenario.mode,
          target: { identifier: opts.inboxItem ?? "(auto)" },
          rule: READING_RULE,
          anchorRule: anchorRulePreview(scenario),
          selectorMode: opts.selectors === "contract" ? "contract" : "legacy",
          skipped: deepLinkProbe.skipped ?? "no eligible inbox item",
          hoverLeadMs: scenario.mode === "warm" ? opts.hoverLeadMs : null,
          rounds: [],
          stats: computeScenarioStats([]),
        });
        continue;
      }

      const rounds: RoundMeasurement[] = [];
      for (let round = 1; round <= opts.rounds; round++) {
        const { round: measured, blocked } = await measureRound({
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
      byScenario.push({
        key: scenario.key,
        mode: scenario.mode,
        target: scenario.target,
        rule: READING_RULE,
        anchorRule: rounds[0]?.anchorRule ?? anchorRulePreview(scenario),
        selectorMode: mode,
        skipped: null,
        ...(scenario.targetSelection ? { targetSelection: scenario.targetSelection } : {}),
        hoverLeadMs: scenario.mode === "warm" ? opts.hoverLeadMs : null,
        rounds: rounds.map(roundSummary),
        stats: computeScenarioStats(
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
      });
    }

    const ambientAfter = await ambientProbe(opts.baseUrl);
    const webVersions = [...new Set(deployed.webVersion ? [deployed.webVersion] : [])];
    const generatedAt = new Date().toISOString();
    const meta: Record<string, unknown> = {
      schema: 2,
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
      roundTimeoutMs: ROUND_TIMEOUT_MS,
      byteAccounting:
        "encodedBodySize=压缩后传输体积，decodedBodySize=解压后 JSON 体积，transferSize=含响应头的传输体积",
      lcpNote: "LCP 由 PerformanceObserver 类型条目读取；无候选时为 null",
      writeGuardSelfTest: guardSelfTest,
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
          JSON.parse(readFileSync(resolve(opts.compare), "utf8")) as { scenarios: ReportScenario[] },
          { scenarios: byScenario },
        )
      : null;

    const payload = {
      meta,
      scenarios: byScenario,
      blockedWrites: allBlocked,
      ...(compare ? { compare: { rows: compare.rows, warnings: compare.warnings } } : {}),
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
      buildMarkdown({ meta, scenarios: byScenario, blockedWrites: allBlocked, compare: compare?.markdown ?? null }),
      "utf8",
    );
    writeFileSync(
      htmlPath,
      buildHtml({
        meta,
        scenarios: byScenario,
        blockedWrites: allBlocked,
        compareTable: compare?.rows ?? null,
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
