#!/usr/bin/env bun
/**
 * MUL-394 (S7): the CI zero-jump check.
 *
 * What it proves: opening an Issue detail page — cold, and through a real
 * in-app click — never moves content after first paint. The assertion is
 * structural only (`jumps = 0`, anchor visible, no skeleton, the app's own
 * `data-perf-state`), never a millisecond budget: this check exists to catch a
 * jump, not to grade speed.
 *
 * How it runs, all on 127.0.0.1 with no remote host involved:
 *   1. an API from `startMultiremiServer` over an in-memory SQLite store, seeded
 *      by `zero-jump-fixture.ts`;
 *   2. the production web build (`next build` + `next start`) proxying `/api/*`
 *      to that API. The build has to happen *after* the API port is known: Next
 *      bakes the rewrite destination into the routes manifest at build time, so
 *      a `next start` with a different `REMOTE_API_URL` still proxied to the
 *      build-time value (measured while writing this check);
 *   3. Playwright + Chromium with the MUL-384 recorder installed, three
 *      repetitions per scenario, no fixed sleeps.
 *
 *   bun run tests/integration/zero-jump-check.ts                 # allowlist mode
 *   bun run tests/integration/zero-jump-check.ts --strict        # ignore the allowlist
 *
 * Strict mode is what proves the check can fail: run it against unfixed code and
 * every violation is reported. Default mode is what CI gates on, and it consults
 * `zero-jump-known-failures.json` — see `lib/zero-jump-verdict.ts` for the rules.
 *
 * Localhost only. The check never reads MULTIREMI_QA_WEB_TOKEN (it mints its own
 * in-memory PAT) and never prints one.
 */
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { startMultiremiServer } from "../../packages/server/src/api/server.js";
import {
  computeAppReadyMs,
  computeFirstRealMs,
  computeJumps,
  computeReadyWindow,
  installRecorderOnContext,
  readRecorder,
  readRecorderSummary,
  RECORDER_GLOBAL,
  type PerfProfileConfig,
  type PerfProfileName,
  type PerfRecorderBuffer,
} from "../../frontend/scripts/perf/lib/jump-recorder";
import {
  inboxRowSelector,
  issueRowSelector,
  LEGACY,
  profileFor,
} from "../../frontend/scripts/perf/lib/selectors";
import { attachCollectors, launchBrowser, mktContext } from "../../frontend/scripts/perf/lib/harness";
import {
  judgeZeroJumpRun,
  validateZeroJumpAllowlist,
  zeroJumpPairKey,
  ZERO_JUMP_VIOLATIONS,
  type ZeroJumpAllowlist,
  type ZeroJumpRowResult,
  type ZeroJumpViolation,
} from "../../frontend/scripts/perf/lib/zero-jump-verdict";
import { measureLogRender, type RenderMeasurement } from "../../frontend/scripts/perf/lib/render-measurement";
import { seedZeroJumpFixture, type ZeroJumpFixture } from "./zero-jump-fixture";
import { seedImageCases, installImageBarrier, imageObservationFailure, type ImageCase, type ImageObservation } from "./zero-jump-image-cases";
import { computeInFlightWaves, preRevealWaveFailure } from "./zero-jump-waves";
import { startSsrProbe } from "./zero-jump-ssr-proxy";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const WEB_APP_DIR = join(REPO_ROOT, "frontend", "apps", "web");
const DEFAULT_ALLOWLIST = join(REPO_ROOT, "tests", "integration", "zero-jump-known-failures.json");
const DEFAULT_OUT = join(REPO_ROOT, "reports", "performance", "MUL-394-zero-jump.json");

/** The plan's fixed repetition count; the ruling's rule (c) counts against it. */
const REPETITIONS = 3;
const ROUND_TIMEOUT_MS = 25_000;
const ENTRY_TIMEOUT_MS = 20_000;
/** Viewport and motion settings the plan fixes, so a run is comparable run to run. */
const VIEWPORT = { width: 1440, height: 900 } as const;
/**
 * Where failing rounds write their screenshot.
 *
 * Overridable because the CI job uploads this directory as an artifact, and
 * `os.tmpdir()` (usually `/tmp`) is not `${{ runner.temp }}` on a GitHub runner;
 * a hard-coded `/tmp` path uploads nothing and reads as "no failure frames".
 */
const SHOT_DIR_ENV = "MUL394_ZERO_JUMP_SHOT_DIR";
/** A deliberately non-default sidebar width, to exercise the localStorage restore. */
const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar_width";
const NON_DEFAULT_SIDEBAR_WIDTH = "360";

interface Options {
  strict: boolean;
  only: string[];
  out: string;
  allowlist: string;
  rounds: number;
  /** Reuse an already-started web+API pair; the ports come from these flags. */
  skipBuild: boolean;
  apiPort: number | null;
  webPort: number | null;
  keep: boolean;
  ssrCookie: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    strict: false,
    only: [],
    out: DEFAULT_OUT,
    allowlist: DEFAULT_ALLOWLIST,
    rounds: REPETITIONS,
    skipBuild: false,
    apiPort: null,
    webPort: null,
    keep: false,
    ssrCookie: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--strict") options.strict = true;
    else if (arg === "--only") options.only.push(next());
    else if (arg === "--out") options.out = next();
    else if (arg === "--allowlist") options.allowlist = next();
    else if (arg === "--rounds") options.rounds = Number(next());
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--api-port") options.apiPort = Number(next());
    else if (arg === "--web-port") options.webPort = Number(next());
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--ssr-cookie") options.ssrCookie = true;
    else if (arg === "--no-ssr-cookie") options.ssrCookie = false;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "usage: bun run tests/integration/zero-jump-check.ts [options]",
        "  --strict           ignore the allowlist; every violation fails (the unfixed-code evidence mode)",
        "  --only <key>       run one scenario key (repeatable)",
        "  --rounds <n>       repetitions per scenario (default 3)",
        "  --out <path>       report path (default reports/performance/MUL-394-zero-jump.json)",
        "  --allowlist <path> known-failures file",
        "  --skip-build       reuse an existing .next build instead of running next build",
        "  --api-port <n>     pin the API port (default: a free one)",
        "  --web-port <n>     pin the web port (default: a free one)",
        "  --keep             leave the servers up (for manual follow-up)",
        "  --no-ssr-cookie    verify CSR without document/RSC auth cookies (default SSR cookie on)",
      ].join("\n") + "\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** First free port at or above `start`, so a stray server cannot poison a run. */
function findFreePort(start: number): number {
  for (let port = start; port < start + 200; port += 1) {
    try {
      const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") });
      probe.stop(true);
      return port;
    } catch {
      continue;
    }
  }
  throw new Error(`no free port in ${start}..${start + 200}`);
}

interface Scenario {
  ssrTimeout?: boolean;
  parentEntryIssueId?: string;
  /** F398 also verifies that all deferred rows remain reachable inside the slot. */
  queuedTasks?: number;
  activityPreference?: boolean;
  key: string;
  taskCacheEmpty?: boolean;
  imageCase?: ImageCase;
  mode: "cold" | "warm";
  path: string;
  /** Entry page for a warm round; the round clicks a real row there. */
  entry: "issues-list" | "inbox" | "parent-issue";
  /** Issue row to click, or the inbox row id for the deep link. */
  clickIssueId: string | null;
  inboxItemId: string | null;
  targetCommentId: string | null;
  /** Seeds a non-default sidebar width before any app code runs. */
  sidebarWidth: string | null;
  /** The issue the warm click must select; the deep link's `/inbox` click sets it. */
  expectIssueId: string | null;
  seededParentIssueId?: string;
}

function buildScenarios(fixture: ZeroJumpFixture, options: Options, imageCases: ImageCase[] = []): Scenario[] {
  const detail = (key: string, issueId: string, extra: Partial<Scenario> = {}): Scenario[] => [
    {
      key,
      mode: "cold",
      path: `/issues/${encodeURIComponent(issueId)}`,
      entry: "issues-list",
      clickIssueId: issueId,
      inboxItemId: null,
      targetCommentId: null,
      sidebarWidth: null,
      expectIssueId: issueId,
      ...extra,
    },
    {
      key,
      mode: "warm",
      path: `/issues/${encodeURIComponent(issueId)}`,
      entry: "issues-list",
      clickIssueId: issueId,
      inboxItemId: null,
      targetCommentId: null,
      sidebarWidth: null,
      expectIssueId: issueId,
      ...extra,
    },
  ];
  const scenarios: Scenario[] = [
    ...imageCases.flatMap(imageCase => detail(imageCase.key, imageCase.issueId, {
      imageCase,
      ...(imageCase.kind === "element" ? {
        path: `/issues/${imageCase.issueId}?comment=${imageCase.commentId}`, targetCommentId: imageCase.commentId,
      } : {}),
    }).filter(scenario => imageCase.kind !== "element" || scenario.mode === "cold")),
    ...(options.only.includes("detail-child") ? detail("detail-child", fixture.waitingChildIssueId, {
      seededParentIssueId: fixture.parentIssueId,
    }).filter(scenario => scenario.mode === "cold") : []),
    ...(options.only.includes("detail-child-warm") ? detail("detail-child-warm", fixture.waitingChildIssueId, {
      entry: "parent-issue", parentEntryIssueId: fixture.parentIssueId, seededParentIssueId: fixture.parentIssueId,
    }).filter(scenario => scenario.mode === "warm") : []),
    ...(options.only.includes("detail-ssr-timeout") ? detail("detail-ssr-timeout", fixture.shortIssueId, {
      ssrTimeout: true,
    }).filter(scenario => scenario.mode === "cold") : []),
    ...(options.only.includes("detail-parent") ? detail("detail-parent", fixture.parentIssueId) : []),
    ...(options.only.includes("detail-locate") ? detail("detail-locate", fixture.longIssueId, {
      path: `/issues/${encodeURIComponent(fixture.longIssueId)}?comment=${encodeURIComponent(fixture.deepLinkCommentId)}&session=${encodeURIComponent(fixture.deepLinkCommentSessionId)}`,
      targetCommentId: fixture.deepLinkCommentId,
    }).filter(scenario => scenario.mode === "cold") : []),
    ...(options.only.includes("detail-locate-default") ? detail("detail-locate-default", fixture.longIssueId, {
      path: `/issues/${encodeURIComponent(fixture.longIssueId)}?comment=${encodeURIComponent(fixture.deepLinkCommentId)}`,
      targetCommentId: fixture.deepLinkCommentId,
    }).filter(scenario => scenario.mode === "cold") : []),
    ...detail("detail-short", fixture.shortIssueId),
    ...detail("detail-f398", fixture.f398IssueId, { queuedTasks: fixture.counts.f398QueuedTasks, activityPreference: false })
      .filter(scenario => scenario.mode === "cold"),
    ...(options.only.includes("detail-f398-system-details") ? detail("detail-f398-system-details", fixture.f398IssueId,
      { queuedTasks: fixture.counts.f398QueuedTasks, activityPreference: true }).filter(scenario => scenario.mode === "cold") : []),
    ...detail("detail-long", fixture.longIssueId),
    ...detail("detail-xlong", fixture.xlongIssueId),
    ...detail("detail-running", fixture.runningIssueId),
    ...(options.only.includes("detail-running-empty-cache") ? detail("detail-running-empty-cache", fixture.runningIssueId, { taskCacheEmpty: true }).filter(row => row.mode === "cold") : []),
    // The deep link is the shape a notification produces, and its cold round
    // *is* the deep link: the URL has to be the inbox one, because that is where
    // the comment highlight and the target anchor come from. Navigating to
    // `/issues/:id` instead would measure the ordinary detail page and the
    // `target-comment` anchor would never exist.
    ...detail("detail-deeplink", fixture.longIssueId, {
      path: `/inbox?issue=${encodeURIComponent(fixture.longIssueId)}&session=${encodeURIComponent(fixture.longDefaultSessionId)}`,
      entry: "inbox",
      clickIssueId: null,
      inboxItemId: fixture.inboxItemId,
      targetCommentId: fixture.deepLinkCommentId,
      expectIssueId: fixture.longIssueId,
    }),
    // Its own key on purpose: a sidebar restored from localStorage after the
    // first frame is a different mechanism from the detail page's own reveal, so
    // conflating it with `detail-long` would make the allowlist unable to say
    // "long is fixed, the sidebar round is not".
    //
    // Cold only. The width is restored from localStorage while the page loads, so
    // the round has to *be* that whole-page load; a warm round enters through the
    // issues list, where the sidebar is already restored at the non-default width,
    // and then navigates in-app with no width change left to make. Its warm shape
    // is therefore just `detail-long::warm` and measures nothing extra.
    // Measured anyway by QA with a separate probe on the same recorder contract:
    // 3/3 warm rounds, jumps = 0, skeletons 0, width held at 360
    // (MUL-394 `cmt_48kfa37phg9x`). Kept out of the matrix rather than adding a
    // row that only re-measures `detail-long`.
    ...detail("detail-long-sidebar", fixture.longIssueId, { sidebarWidth: NON_DEFAULT_SIDEBAR_WIDTH }).filter(
      (scenario) => scenario.mode === "cold",
    ),
  ];
  const filtered = options.only.length > 0
    ? scenarios.filter((scenario) => options.only.includes(scenario.key))
    : scenarios;
  if (options.only.length > 0 && filtered.length === 0) {
    throw new Error(`--only matched no scenario: ${options.only.join(", ")}`);
  }
  return filtered;
}

/** Per-round outcome: the structural facts, before the allowlist is consulted. */
interface RoundResult extends RenderMeasurement {
  skeletonFlashFrames: number;
  ssrSeedStatus: string | null;
  legacySsrMarker: boolean;
  ssrApiReads: Array<{ path: string; query: string; startedAt: number }>;
  softNavigationSsrReads: Array<{ path: string; query: string; startedAt: number }>;
  navigationResponses: Array<{ rsc: boolean; prefetch: boolean; seedStatus: string | null;
    accept: string | null; destination: string | null;
    initialLog: boolean; initialData: boolean; startedAt: number; finishedAt: number }>;
  streamObservation?: {
    samples: Array<{ t: number; height: number; rows: number; state: string | null }>;
    rows: number;
    clientHeight: number;
    scrollHeight: number;
    lastRowReachable: boolean;
  };
  imageObservation?: ImageObservation;
  requests: Array<{ path: string; query: string; startMs: number; responseEndMs: number; transferBytes: number; encodedBytes: number; initiator: string; status: number | null; delivery: string | null }>;
  preRevealOptional: string[];
  cardSamples?: Array<{ t: number; height: number; contentHeight: number; textLength: number; state: string | null; scrollTop: number; anchorTop: number | null }>;
  preRevealWaves: number | null;
  preRevealWaveRows: ReturnType<typeof computeInFlightWaves>["rows"];
  preRevealWaveChain: number[];
  waveGate: "blocking" | "record-only";
  attachmentReads: Record<string, number>;
  settled: boolean;
  hubAckSeen: boolean;
  revealDispatchMs: number | null;
  fetchPhases: Array<{ path: string; t: number; state: string | null; fresh: string | null }>;
  logSingleRowReads: number;
  logRequests: Array<{ query: string; startMs: number; responseEndMs: number }>;
  ssrSeed: boolean;
  ssrSeedRereads: Array<{ path: string; query: string }>;
  key: string;
  mode: string;
  round: number;
  url: string;
  readyMs: number | null;
  anchorVisibleMs: number | null;
  navStartMs: number;
  readyTimeout: boolean;
  firstRealMs: number | null;
  anchorName: string | null;
  anchorRectAtReady: { top: number; bottom: number; height: number; rootHeight: number } | null;
  jumps: Array<{ startMs: number; endMs: number; px: number; scrollPx: number; kind: string; frames: number }>;
  jumpCount: number | null;
  jumpPx: number | null;
  skeletons: number;
  /** The app's own verdict read off `data-perf-state` / `data-perf-fresh`. */
  appReadyMs: number | null;
  appReadyForced: boolean;
  appReadyForcedSeen: boolean;
  perfState: string | null;
  perfFresh: string | null;
  blockedWrites: number;
  stubbedWrites: number;
  /** Non-local requests the round attempted; must be 0. */
  foreignRequests: string[];
  /** True when the browser's first inbox page had the deep-link target injected. */
  inboxInjected: boolean;
  error: string | null;
}

/** Only reads already supplied by the Issue SSR bootstrap are redundant. */
function findSsrSeedRereads(input: {
  ssrSeed: boolean;
  workspaceId: string;
  issueId: string;
  parentIssueId?: string;
  sessionId: string | null;
  requests: Array<{ path: string; query: string }>;
}): Array<{ path: string; query: string }> {
  if (!input.ssrSeed) return [];
  const issuePath = `/api/issues/${encodeURIComponent(input.issueId)}`;
  const seededPaths = new Set([
    issuePath, `${issuePath}/sessions`, `${issuePath}/children`, `${issuePath}/task-runs`,
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/members`,
    ...(input.parentIssueId ? [`/api/issues/${encodeURIComponent(input.parentIssueId)}`] : []),
  ]);
  return input.requests.filter(request => seededPaths.has(request.path)
    || (request.path === `/api/sessions/${input.sessionId}/log`
      && new URLSearchParams(request.query).get("before") === "1"))
    .map(({ path, query }) => ({ path, query }));
}

/** Which structural assertions this round violated. */
function violationsForRound(round: RoundResult): ZeroJumpViolation[] {
  const violations: ZeroJumpViolation[] = [];
  if (round.error) {
    // A round that could not be driven is not a pass: it never measured the page
    // the scenario asked for, and silently scoring it green is how a broken
    // fixture turns into a green gate. Reported as every kind it could have hit.
    return ["jumps", "anchor", "skeleton", "perf-state"];
  }
  if ((round.jumpCount ?? 0) > 0) violations.push("jumps");
  if (round.readyTimeout || round.readyMs === null || round.firstRealMs === null) violations.push("anchor");
  if (round.skeletons > 0) violations.push("skeleton");
  // The plan's assertion is `data-perf-state === "ready"` with `ready-forced`
  // explicitly not a pass, and only `ready` + `fresh=1` once MUL-443 publishes
  // the freshness bit. `computeAppReadyMs` already applies both rules.
  if (round.appReadyMs === null || round.appReadyForced) violations.push("perf-state");
  return violations;
}

function groupResults(rounds: RoundResult[]): ZeroJumpRowResult[] {
  const byPair = new Map<string, ZeroJumpRowResult>();
  for (const round of rounds) {
    const pair = `${round.key}::${round.mode}`;
    const entry = byPair.get(pair) ?? { key: round.key, mode: round.mode, repetitions: 0, observed: [] };
    entry.repetitions += 1;
    entry.observed.push(violationsForRound(round));
    byPair.set(pair, entry);
  }
  return [...byPair.values()];
}

// ── process plumbing ─────────────────────────────────────────────────────────

interface ProcessHandle {
  kill: () => void;
}

const running: ProcessHandle[] = [];
let apiServer: ReturnType<typeof startMultiremiServer> | null = null;
let database: Database | null = null;
let browser: Browser | null = null;

function shutdown(): void {
  for (const child of running) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  browser?.close().catch(() => {});
  apiServer?.stop(true);
  database?.close();
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Fails a round's navigation on anything that is not the local web origin. */
async function blockForeignRequests(page: Page, allowedOrigins: string[]): Promise<string[]> {
  const foreign: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) {
      await route.fallback();
      return;
    }
    const allowed = allowedOrigins.some((origin) => url.startsWith(origin));
    if (allowed) {
      // Let the API collectors and the SSR/CSR document handler run too.
      await route.fallback();
      return;
    }
    // The plan's guard: an external font/script/image would make the measured
    // page depend on the network, and would also mean the page is not
    // self-contained. Record it and fail the request.
    foreign.push(url);
    await route.abort();
  });
  return foreign;
}

/**
 * The inbox row the deep link follows, read straight from the API.
 *
 * `attachCollectors` needs the row object itself (not just its id) to put it on
 * the browser's first page, because the page renders the item's own fields.
 */
async function readInboxItem(
  apiOrigin: string,
  token: string,
  itemId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${apiOrigin}/api/inbox?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    const items = Array.isArray(body) ? body : ((body as { items?: unknown[] }).items ?? []);
    const hit = items.find((item) => !!item && typeof item === "object"
      && (item as Record<string, unknown>).id === itemId);
    return (hit as Record<string, unknown> | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Waits for the recorder to report a ready window, then returns its summary. */
async function waitForRecorderReady(page: Page, profile: PerfProfileName, deadlineMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const summary = await readRecorderSummary(page).catch(() => null);
    if (summary?.profiles[profile]?.ready) return;
    await page.waitForTimeout(50);
  }
}

/** One measured round: a fresh context, a cold `goto` or a real row click. */
async function runRound(input: {
  browser: Browser;
  token: string;
  webOrigin: string;
  apiOrigin: string;
  slug: string;
  workspaceId: string;
  scenario: Scenario;
  round: number;
  ssrCookie: boolean;
  userId: string;
  ssrProbe: ReturnType<typeof startSsrProbe>;
}): Promise<RoundResult> {
  const { browser, token, webOrigin, apiOrigin, slug, scenario, round } = input;
  const ssrReadStart = input.ssrProbe.reads.length;
  input.ssrProbe.setTimeoutIssue(scenario.ssrTimeout ? scenario.expectIssueId ?? undefined : undefined);
  // The scenario's own profile: a deep link's terminal element is the target
  // comment, not the newest one. Installing the generic profile and
  // post-processing with it silently reported `readyTimeout` for every deep
  // link, because the rule it evaluated could never name the anchor the page
  // actually shows.
  const profile: PerfProfileConfig = profileFor({
    mode: "contract",
    shape: "issue-detail",
    targetCommentId: scenario.targetCommentId,
    requireAgentStream: scenario.key.startsWith("detail-running"),
  });
  const targetUrl = `${webOrigin}/${slug}${scenario.path}`;
  const result: RoundResult = {
    requests: [], preRevealOptional: [], preRevealWaves: null, preRevealWaveRows: [], preRevealWaveChain: [], waveGate: scenario.mode === "warm" && !(["detail-running", "detail-deeplink"].includes(scenario.key)) ? "blocking" : "record-only", attachmentReads: {}, settled: false, hubAckSeen: false, revealDispatchMs: null, fetchPhases: [],
    renderMs: null, renderSource: "unobserved", renderReason: "not measured", windowResponseEndMs: null,
    logSingleRowReads: 0,
    logRequests: [],
    ssrSeed: false,
    ssrSeedRereads: [],
    ssrSeedStatus: null, legacySsrMarker: false, ssrApiReads: [], softNavigationSsrReads: [], navigationResponses: [], skeletonFlashFrames: 0,
    key: scenario.key,
    mode: scenario.mode,
    round,
    url: targetUrl,
    readyMs: null,
    anchorVisibleMs: null, navStartMs: 0,
    readyTimeout: true,
    firstRealMs: null,
    anchorName: null,
    anchorRectAtReady: null,
    jumps: [],
    jumpCount: null,
    jumpPx: null,
    skeletons: 0,
    appReadyMs: null,
    appReadyForced: false,
    appReadyForcedSeen: false,
    perfState: null,
    perfFresh: null,
    blockedWrites: 0,
    stubbedWrites: 0,
    foreignRequests: [],
    inboxInjected: false,
    error: null,
  };

  const ssrCookie = input.ssrCookie && !scenario.taskCacheEmpty;
  const context: BrowserContext = await mktContext(browser, token, [], webOrigin, ssrCookie);
  // Fulfilled documents have no server IP for Chromium's address-space check.
  // Permit this local origin's WS handshake while the CSR probe strips cookies.
  if (!ssrCookie) await context.grantPermissions(["local-network-access"], { origin: webOrigin });
  if (scenario.activityPreference !== undefined) await context.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify({ state: { showSystemDetails: value }, version: 0 }));
  }, { key: `multimira_issue_activity:${input.userId}:${input.workspaceId}`, value: scenario.activityPreference });
  if (scenario.queuedTasks) await context.addInitScript(() => {
    const samples: NonNullable<RoundResult["streamObservation"]>["samples"] = [];
    (window as unknown as { __s7StreamSamples: typeof samples }).__s7StreamSamples = samples;
    const sample = () => {
      const root = document.querySelector('[data-perf-scroll="issue-detail"]');
      const slot = root?.querySelector<HTMLElement>("[data-agent-stream-slot]");
      if (slot) {
        const next = { t: performance.now(), height: slot.getBoundingClientRect().height,
          rows: slot.querySelectorAll('[data-perf-anchor="agent-stream"] > button').length,
          state: root!.getAttribute("data-perf-state") };
        const previous = samples.at(-1);
        if (next.height > 0 && (!previous || previous.height !== next.height || previous.rows !== next.rows || previous.state !== next.state)) samples.push(next);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  if (!ssrCookie) await context.route("**/*", async route => {
    const request = route.request();
    if (request.isNavigationRequest() || new URL(request.url()).searchParams.has("_rsc")) {
      const headers = { ...request.headers() };
      headers.cookie = (headers.cookie ?? "").split(";").filter(part => !part.trim().startsWith("multimira_auth=")).join(";");
      // Use a reader without a browser cookie jar: Cookie cannot be overridden
      // by Chromium's continue(), and context-owned fetches may restore it.
      const response = await fetch(request.url(), { headers, redirect: "manual" });
      const responseHeaders = new Headers(response.headers);
      for (const name of ["content-length", "content-encoding", "transfer-encoding"]) responseHeaders.delete(name);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(responseHeaders), body: Buffer.from(await response.arrayBuffer()) });
    } else await route.continue();
  });
  await context.addInitScript(() => {
    const skeletonFrames: number[] = [];
    (window as unknown as { __s7SkeletonFrames: number[] }).__s7SkeletonFrames = skeletonFrames;
    const sampleSkeletons = () => {
      if ([...document.querySelectorAll<HTMLElement>('[data-issue-page] [data-slot="skeleton"]')].some(element =>
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) skeletonFrames.push(performance.now());
      requestAnimationFrame(sampleSkeletons);
    };
    requestAnimationFrame(sampleSkeletons);
    performance.setResourceTimingBufferSize(10_000);
    const phases = { reveals: [] as number[], fetches: [] as Array<{path: string; t: number; state: string | null; fresh: string | null}> };
    (window as unknown as { __s7Phases: typeof phases }).__s7Phases = phases;
    const originalAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      originalAttribute.call(this, name, value);
      if ((name === "data-perf-state" || name === "data-perf-fresh") && this.getAttribute("data-perf-scroll") === "issue-detail"
        && this.getAttribute("data-perf-state") === "ready" && this.getAttribute("data-perf-fresh") === "1") phases.reveals.push(performance.now());
    };
    const observeSeed = () => {
      const confirm = () => {
        for (const root of document.querySelectorAll('[data-perf-scroll="issue-detail"][data-ssr-positioned="1"][data-perf-state="ready"]')) {
          if (root.getAttribute("data-perf-fresh") === "1" && !phases.reveals.length) phases.reveals.push(performance.now());
        }
      };
      new MutationObserver(confirm).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-ssr-positioned", "data-perf-state"] });
      confirm();
    };
    if (document.documentElement) observeSeed(); else document.addEventListener("DOMContentLoaded", observeSeed, { once: true });
    const originalFetch = window.fetch;
    window.fetch = function(this: Window, input: RequestInfo | URL, init?: RequestInit) {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      if (path.startsWith("/api/")) {
        const root = [...document.querySelectorAll('[data-perf-scroll="issue-detail"]')].at(-1);
        phases.fetches.push({ path, t: performance.now(), state: root?.getAttribute("data-perf-state") ?? null, fresh: root?.getAttribute("data-perf-fresh") ?? null });
      }
      return originalFetch.call(this, input, init);
    } as typeof window.fetch;
  });
  if (scenario.taskCacheEmpty) await context.addInitScript(() => {
    const samples: NonNullable<RoundResult["cardSamples"]> = [];
    (window as unknown as { __s7CardSamples: typeof samples }).__s7CardSamples = samples;
    const observe = () => new MutationObserver(() => {
      const slot = document.querySelector<HTMLElement>("[data-agent-card-slot]");
      const root = document.querySelector<HTMLElement>('[data-perf-scroll="issue-detail"]');
      if (!slot || !root || root.getAttribute("data-perf-state") !== "ready") return;
      const anchor = root.querySelector<HTMLElement>('[data-perf-anchor="latest-comment"]');
      const sample = { t: performance.now(), height: slot.getBoundingClientRect().height,
        contentHeight: slot.firstElementChild?.getBoundingClientRect().height ?? 0,
        textLength: slot.textContent?.trim().length ?? 0, state: root.getAttribute("data-perf-state"),
        scrollTop: root.scrollTop, anchorTop: anchor?.getBoundingClientRect().top ?? null };
      if (sample.height > 0 && (!samples.length || samples.at(-1)!.textLength !== sample.textLength)) samples.push(sample);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    if (document.documentElement) observe(); else document.addEventListener("DOMContentLoaded", observe, { once: true });
  });
  await context.setDefaultTimeout(ROUND_TIMEOUT_MS);
  await installRecorderOnContext(context, { profiles: [profile] });
  if (scenario.sidebarWidth !== null) {
    // Seeds the non-default sidebar width before any app code runs, which is
    // exactly the state a returning user has: the value is only read in an
    // effect, so the app paints at the default width first.
    await context.addInitScript(
      ([key, value]: [string, string]) => window.localStorage.setItem(key, value),
      [SIDEBAR_WIDTH_STORAGE_KEY, scenario.sidebarWidth] as [string, string],
    );
  }

  const page = await context.newPage();
  const pendingApi = new Set<unknown>();
  const pendingNavigation = new Set<unknown>();
  let lastApiChange = performance.now(), lastHubChange = performance.now();
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) { pendingApi.add(request); lastApiChange = performance.now(); } });
  const finishRequest = (request: unknown) => {
    if (pendingApi.delete(request) || pendingNavigation.delete(request)) lastApiChange = performance.now();
  };
  page.on("requestfinished", finishRequest); page.on("requestfailed", finishRequest);
  page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    if (!["/ws", "/api/realtime/ws"].includes(new URL(socket.url()).pathname)) return;
    lastHubChange = performance.now();
    try { const frame = JSON.parse(String(payload)); if (frame.type === "stream.ack") result.hubAckSeen = true; } catch {}
  }));
  const seedReads: Promise<void>[] = [];
  const navigationStarts = new Map<unknown, number>();
  const rscStarts: number[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === new URL(targetUrl).pathname) {
      pendingNavigation.add(request);
      navigationStarts.set(request, Date.now());
      if (request.headers().rsc === "1") rscStarts.push(Date.now());
    }
  });
  page.on("response", response => {
    if (new URL(response.url()).pathname === new URL(targetUrl).pathname
      && (response.request().isNavigationRequest() || new URL(response.url()).searchParams.has("_rsc"))) {
      seedReads.push(response.text().then(async body => {
        const requestHeaders = await response.request().allHeaders();
        const decoded = body.replaceAll('\\"', '"');
        result.navigationResponses.push({
          rsc: response.request().headers().rsc === "1", prefetch: response.request().headers()["next-router-prefetch"] === "1",
          accept: requestHeaders.accept ?? null, destination: requestHeaders["sec-fetch-dest"] ?? null,
          seedStatus: /"data-ssr-seed"\s*:\s*"([a-z-]+)"/.exec(decoded)?.[1] ?? /data-ssr-seed="([a-z-]+)"/.exec(decoded)?.[1] ?? null,
          initialLog: /"initialLog":(?!"\$undefined")/.test(decoded),
          initialData: /"initialData":(?!"\$undefined")/.test(decoded),
          startedAt: navigationStarts.get(response.request()) ?? Date.now(), finishedAt: Date.now(),
        });
      }).catch(() => {}));
    }
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  // The inbox row has to be on the browser's first page for the warm click to
  // find it and for the cold deep link to open the notification rather than fall
  // back to the bare issue page. `attachCollectors` rewrites the first-page
  // response to carry the target; later pages drop it so the row is not loaded
  // twice. Its `record` writes were already reduced to SQL before this point.
  const inboxTarget = scenario.inboxItemId === null
    ? null
    : await readInboxItem(apiOrigin, token, scenario.inboxItemId);
  const collectors = attachCollectors(page, round, scenario.key, [slug], { inboxTarget });
  if (scenario.taskCacheEmpty) await page.route("**/api/issues/*/task-runs", async route => {
    // Functional fault injection only: hold the real task response until the
    // first normal reveal has exposed the empty card. Then resume the same
    // request so the genuine running task also reaches the stream row.
    await page.waitForFunction(() => (window as unknown as {
      __s7CardSamples: NonNullable<RoundResult["cardSamples"]>;
    }).__s7CardSamples?.some(sample => sample.textLength === 0));
    await route.continue();
  });
  const observeImage = scenario.imageCase ? await installImageBarrier(page, scenario.imageCase) : null;
  result.foreignRequests = await blockForeignRequests(page, [webOrigin]);

  let navStartMs = 0;
  try {
    if (scenario.mode === "cold") {
      await page.goto(targetUrl, { waitUntil: "commit", timeout: ROUND_TIMEOUT_MS });
    } else {
      const entryPath = scenario.entry === "parent-issue" ? `/issues/${scenario.parentEntryIssueId}`
        : scenario.entry === "inbox" ? "/inbox" : "/issues";
      await page.goto(`${webOrigin}/${slug}${entryPath}`, { waitUntil: "commit", timeout: ROUND_TIMEOUT_MS });
      if (scenario.entry === "parent-issue") await page.locator('[data-perf-scroll="issue-detail"][data-perf-state="ready"]').waitFor();
      await clickEntryRow(page, scenario, slug);
      // The click has to be in the buffer before the app can navigate; resetting
      // at its timestamp keeps the reported clock on the page's own timeline.
      const clickT = await page
        .evaluate((name) => {
          const recorder = (window as unknown as Record<string, { read?: () => { clicks: Array<{ t: number }> } }>)[name];
          const clicks = recorder?.read?.().clicks ?? [];
          return clicks.length > 0 ? clicks[clicks.length - 1]!.t : null;
        }, RECORDER_GLOBAL)
        .catch(() => null);
      if (clickT !== null) {
        navStartMs = clickT;
        await page.evaluate(([name, from]) => {
          const recorder = (window as unknown as Record<string, { reset?: (t?: number) => void }>)[name as string];
          recorder?.reset?.(from as number);
        }, [RECORDER_GLOBAL, clickT] as const);
      }
    }
    await waitForRecorderReady(page, profile.name, ROUND_TIMEOUT_MS);
    // Finish the entire deferred/Hub phase, rather than truncating at reveal.
    const settleDeadline = performance.now() + ROUND_TIMEOUT_MS;
    while (performance.now() < settleDeadline) {
      if (result.hubAckSeen && pendingApi.size === 0 && pendingNavigation.size === 0
        && performance.now() - Math.max(lastApiChange, lastHubChange) >= 500) { result.settled = true; break; }
      await page.waitForTimeout(50);
    }
    if (!result.settled) result.error = `deferred API / Hub phase did not settle (ack=${result.hubAckSeen}, pending=${pendingApi.size})`;
  } catch (error) {
    result.error = (error as Error).message.split("\n")[0] ?? String(error);
  }

  const summary = await readRecorderSummary(page).catch(() => null);
  const buffer: PerfRecorderBuffer | null = await readRecorder(page).catch(() => null);
  await Promise.all(seedReads);
  // CSR warm wave depth is a target after moving the window earlier; all
  // other structural checks remain blocking on both paths.
  // The actual rendered log supplies the seed evidence; a cookie or unrelated
  // serialized head id does not prove this detail used SSR.
  result.ssrSeedStatus = await page.locator('[data-issue-page]').getAttribute("data-ssr-seed").catch(() => null);
  result.legacySsrMarker = await page.locator('[data-perf-scroll="issue-detail"][data-ssr-initial]').count() > 0;
  result.ssrSeed = result.ssrSeedStatus === "ok";
  result.ssrApiReads = input.ssrProbe.reads.slice(ssrReadStart);
  const rscResponses = result.navigationResponses.filter(response => response.rsc);
  // Include cancelled prefetches and late SSR work, not just completed responses.
  result.softNavigationSsrReads = rscStarts.length ? result.ssrApiReads.filter(read => read.startedAt >= Math.min(...rscStarts)) : [];
  if (!result.ssrSeed) result.waveGate = "record-only";
  const allRequests = await page.evaluate(() => (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter(entry => new URL(entry.name).pathname.startsWith("/api/"))
    .map(entry => ({ path: new URL(entry.name).pathname, query: new URL(entry.name).search, startMs: entry.startTime, responseEndMs: entry.responseEnd,
      transferBytes: entry.transferSize, encodedBytes: entry.encodedBodySize, initiator: entry.initiatorType,
      status: (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus ?? null,
      delivery: (entry as PerformanceResourceTiming & { deliveryType?: string }).deliveryType ?? null })));
  result.requests = allRequests.filter(request => request.startMs >= navStartMs);
  result.logRequests = await page.evaluate(() => (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter(entry => /\/sessions\/[^/]+\/log\?/.test(entry.name))
    .map(entry => {
      const url = new URL(entry.name), query = new URLSearchParams();
      for (const key of ["anchor", "before", "after"]) { const value = url.searchParams.get(key); if (value !== null && /^\d+$/.test(value)) query.set(key, value); }
      return { query: query.toString(), startMs: entry.startTime, responseEndMs: entry.responseEnd };
    }));
  const targetSessionId = await page.locator('[data-perf-scroll="issue-detail"]').first().getAttribute("data-session-log-id").catch(() => null);
  result.ssrSeedRereads = findSsrSeedRereads({
    ssrSeed: result.ssrSeed,
    workspaceId: input.workspaceId,
    issueId: scenario.expectIssueId ?? "",
    parentIssueId: scenario.seededParentIssueId,
    sessionId: targetSessionId,
    requests: result.requests,
  });
  Object.assign(result, measureLogRender({ navStartMs, ssrSeed: result.ssrSeed, states: buffer?.stateTransitions ?? [],
    windows: result.requests.filter(request => request.path === `/api/sessions/${targetSessionId}/log`).filter(request => { const query = new URLSearchParams(request.query); return Number(query.get("before")) > 1 || Number(query.get("after")) > 1; }) }));
  result.logSingleRowReads = result.logRequests.filter(request => {
    const query = new URLSearchParams(request.query);
    return query.get("before") === "1" && query.get("after") === "0";
  }).length;
  if (result.logSingleRowReads) result.error = `${result.error ? result.error + "; " : ""}single-row log rereads: ${result.logSingleRowReads}`;
  await page.route("**/api/**", (route) => route.abort()).catch(() => {});
  result.blockedWrites = collectors.blockedWrites.reduce((sum, write) => sum + write.attempts, 0);
  result.stubbedWrites = collectors.stubbedWrites.reduce((sum, write) => sum + write.attempts, 0);
  result.inboxInjected = collectors.inboxInjected;

  result.navStartMs = navStartMs;
  result.skeletonFlashFrames = await page.evaluate(from =>
    (window as unknown as { __s7SkeletonFrames: number[] }).__s7SkeletonFrames.filter(t => t >= from).length, navStartMs);
  const frames = (buffer?.frames ?? []).filter(frame => frame.t >= navStartMs).map(frame => ({ ...frame, t: frame.t - navStartMs }));
  if (buffer && frames.length > 0) {
    const firstRealMs = computeFirstRealMs(frames, profile.name);
    const ready = computeReadyWindow(frames, { profile, firstRealMs });
    const jumps = computeJumps(frames, { profile: profile.name, fromMs: firstRealMs, toMs: frames.at(-1)?.t });
    result.firstRealMs = firstRealMs;
    result.readyMs = ready.readyMs;
    result.anchorVisibleMs = ready.anchorVisibleMs;
    result.readyTimeout = ready.readyTimeout;
    result.anchorName = ready.anchorName;
    result.anchorRectAtReady = ready.anchorRectAtReady;
    result.jumps = jumps.jumps;
    result.jumpCount = jumps.jumpCount;
    result.jumpPx = jumps.jumpPx;
    const appReady = computeAppReadyMs(buffer.stateTransitions.filter(state => state.t >= navStartMs).map(state => ({ ...state, t: state.t - navStartMs })));
    result.appReadyMs = appReady.appReadyMs;
    result.appReadyForced = appReady.forced;
    result.appReadyForcedSeen = appReady.readyForced;
    const profileSummary = summary?.profiles[profile.name];
    result.skeletons = profileSummary?.skeletons ?? 0;
    result.perfState = profileSummary?.state ?? null;
    result.perfFresh = profileSummary?.fresh ?? null;
  } else if (!result.error) {
    result.error = "recorder produced no frames";
  }

  const phases = await page.evaluate(() => (window as unknown as { __s7Phases: { reveals: number[]; fetches: RoundResult["fetchPhases"] } }).__s7Phases);
  result.revealDispatchMs = phases.reveals.find(t => t >= navStartMs) ?? null;
  result.fetchPhases = phases.fetches.filter(fetch => fetch.t >= navStartMs);
  const revealAt = result.revealDispatchMs;
  const preReveal = revealAt === null ? [] : result.requests.filter(request => request.startMs < revealAt);
  result.preRevealOptional = result.fetchPhases.filter(request => /\/(active-task|subscribers|resources)$/.test(request.path) && (request.state !== "ready" || request.fresh !== "1")).map(request => request.path);
  const waves = computeInFlightWaves(preReveal.map((request, index) => ({ ...request, index })));
  result.preRevealWaves = revealAt === null ? null : waves.serialDepth;
  result.preRevealWaveRows = waves.rows;
  result.preRevealWaveChain = waves.chain;
  const aliases = new Map<string, string>();
  for (const request of result.requests) {
    const id = /\/attachments\/([^/]+)\/content$/.exec(request.path)?.[1];
    if (id) {
      if (!aliases.has(id)) aliases.set(id, `attachment-${aliases.size + 1}`);
      const alias = aliases.get(id)!; result.attachmentReads[alias] = (result.attachmentReads[alias] ?? 0) + 1;
    }
  }
  const attachmentPath = (path: string) => path.replace(/(\/attachments\/)([^/]+)(\/content$)/,
    (_match, prefix, id, suffix) => `${prefix}${aliases.get(id) ?? id}${suffix}`);
  result.requests = result.requests.map(request => ({ ...request, path: attachmentPath(request.path) }));
  result.preRevealWaveRows = result.preRevealWaveRows.map(request => ({ ...request, path: attachmentPath(request.path) }));
  result.fetchPhases = result.fetchPhases.map(request => ({ ...request, path: attachmentPath(request.path) }));
  if (scenario.taskCacheEmpty) result.cardSamples = await page.evaluate(() => (window as unknown as { __s7CardSamples: NonNullable<RoundResult["cardSamples"]> }).__s7CardSamples);
  const emptyCard = result.cardSamples?.find(sample => sample.textLength === 0);
  const filledCard = result.cardSamples?.find(sample => sample.textLength > 0);
  if (observeImage) result.imageObservation = await observeImage().catch(() => undefined);
  if (scenario.queuedTasks) result.streamObservation = await page.evaluate(() => {
    // Run after recording the measured frames. This explicit user-style scroll
    // tests reachability, and does not enter the zero-jump measurement.
    const slot = document.querySelector<HTMLElement>("[data-agent-stream-slot]");
    const buttons = slot?.querySelectorAll<HTMLElement>('[data-perf-anchor="agent-stream"] > button');
    if (slot) slot.scrollTop = slot.scrollHeight;
    const slotRect = slot?.getBoundingClientRect(), lastRect = buttons?.[buttons.length - 1]?.getBoundingClientRect();
    return { samples: (window as unknown as { __s7StreamSamples: NonNullable<RoundResult["streamObservation"]>["samples"] }).__s7StreamSamples,
      rows: buttons?.length ?? 0, clientHeight: slot?.clientHeight ?? 0, scrollHeight: slot?.scrollHeight ?? 0,
      lastRowReachable: Boolean(slotRect && lastRect && lastRect.top >= slotRect.top && lastRect.bottom <= slotRect.bottom) };
  });
  const stream = result.streamObservation;
  const failures = [
    scenario.entry !== "inbox" && result.ssrSeedStatus !== (scenario.mode === "warm" ? "soft-nav"
      : !ssrCookie ? "no-cookie" : scenario.ssrTimeout ? "timeout" : "ok")
      ? `unexpected SSR seed status: ${result.ssrSeedStatus}` : null,
    scenario.entry !== "inbox" && result.legacySsrMarker !== result.ssrSeed ? "legacy SSR marker contradicts seed status" : null,
    scenario.entry !== "inbox" && (scenario.mode === "cold" || result.navigationResponses.some(response => response.seedStatus))
      && !result.navigationResponses.some(response => response.seedStatus === result.ssrSeedStatus
      && response.initialLog === result.ssrSeed && response.initialData === result.ssrSeed)
      ? "Flight/document seed props contradict the result marker" : null,
    scenario.entry !== "inbox" && scenario.mode === "warm" && (!rscResponses.length || result.softNavigationSsrReads.length)
      ? `soft navigation SSR GETs: ${result.softNavigationSsrReads.length}, RSC responses: ${rscResponses.length}` : null,
    scenario.mode === "warm" && result.skeletonFlashFrames ? `visible warm skeleton frames: ${result.skeletonFlashFrames}` : null,
    result.ssrSeedRereads.length ? `SSR seed rereads: ${JSON.stringify(result.ssrSeedRereads)}` : null,
    scenario.queuedTasks && (!stream || !stream.samples.length || !stream.samples.some(sample => sample.rows === 0)
      || !stream.samples.some(sample => sample.rows === scenario.queuedTasks) || stream.rows !== scenario.queuedTasks
      || stream.samples.some(sample => sample.height !== stream.samples[0]!.height)
      || stream.scrollHeight <= stream.clientHeight || !stream.lastRowReachable)
      ? "deferred queued stream changed slot height, dropped rows or made the last row unreachable" : null,
    scenario.imageCase ? result.imageObservation ? imageObservationFailure(result.imageObservation) : "image observation missing" : null,
    scenario.taskCacheEmpty && (!emptyCard || !filledCard || filledCard.contentHeight <= 0 || emptyCard.height !== filledCard.height
      || (emptyCard.anchorTop !== null && filledCard.anchorTop !== null && Math.abs(emptyCard.anchorTop - filledCard.anchorTop) > .5))
      ? "cache-miss agent card changed its reserved slot / anchor or was not observed" : null,
    result.anchorVisibleMs !== result.readyMs ? `anchorVisibleMs ${result.anchorVisibleMs} != readyMs ${result.readyMs}` : null,
    result.preRevealOptional.length ? `optional before reveal: ${result.preRevealOptional.join(", ")}` : null,
    preRevealWaveFailure(result.waveGate, result.preRevealWaves),
    Object.values(result.attachmentReads).some(count => count > 1) ? `duplicate attachment content: ${JSON.stringify(result.attachmentReads)}` : null,
  ].filter(Boolean);
  if (failures.length) result.error = [result.error, ...failures].filter(Boolean).join("; ");
  if (violationsForRound(result).length > 0) {
    const shotDir = process.env[SHOT_DIR_ENV] ?? join(tmpdir(), "mul394-zero-jump");
    ensureDir(shotDir);
    if (buffer) writeFileSync(join(shotDir, `${scenario.key}-${scenario.mode}-${round}.frames.json`), JSON.stringify({
      frames: buffer.frames, shifts: buffer.shifts, stateTransitions: buffer.stateTransitions,
    }));
    await page.screenshot({ path: join(shotDir, `${scenario.key}-${scenario.mode}-${round}.png`) }).catch(() => {});
  }
  await context.close().catch(() => {});
  return result;
}

/**
 * Drives the warm entry page: waits for a skeleton-free row, then clicks it.
 *
 * There is no fixed sleep — the row's presence in a skeleton-free content region
 * *is* the entry page's readiness condition.
 */
async function clickEntryRow(page: Page, scenario: Scenario, slug: string): Promise<void> {
  const deadline = Date.now() + ENTRY_TIMEOUT_MS;
  const isInbox = scenario.entry === "inbox";
  const selector = isInbox
    ? inboxRowSelector("contract", scenario.inboxItemId ?? undefined)
    : scenario.entry === "parent-issue" ? `a[href="/${slug}/issues/${scenario.clickIssueId}"]`
    : issueRowSelector("contract", scenario.clickIssueId ?? "");
  while (Date.now() < deadline) {
    const skeletons = await page.locator(`${LEGACY.listRoot} [data-slot="skeleton"]`).count().catch(() => 0);
    if (skeletons === 0) {
      const rows = page.locator(selector);
      const count = await rows.count().catch(() => 0);
      if (count > 0) {
        const row = rows.first();
        await row.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
        await row.hover({ timeout: 5_000 }).catch(() => {});
        // Give `AppLink`'s route prefetch the same lead the probe uses, so the
        // warm round measures the detail page rather than a chunk fetch.
        await page.waitForTimeout(150);
        await row.click({ timeout: 5_000 });
        // The click only counts once the app has selected the intended issue:
        // the inbox commits its selection inside `startTransition`, so the URL
        // updates a tick after the click. Without this the round could measure
        // whatever page it happened to be on.
        const expected = scenario.expectIssueId;
        if (expected) {
          await page.waitForURL((url) => url.href.includes(expected), { timeout: ENTRY_TIMEOUT_MS });
        } else if (scenario.entry === "issues-list") {
          await page.waitForURL(
            (url) => url.pathname.endsWith(`/issues/${scenario.clickIssueId}`),
            { timeout: ENTRY_TIMEOUT_MS },
          );
        }
        return;
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`warm entry row not found for ${scenario.key} (${slug})`);
}

/** Waits for a URL to answer below 500, so a dead server fails fast. */
async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      if (res.status < 500) return;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const apiPort = options.apiPort ?? findFreePort(17400);
  const webPort = options.webPort ?? findFreePort(17500);
  const webOrigin = `http://localhost:${webPort}`;

  log(`zero-jump check: api=${apiPort} web=${webPort} strict=${options.strict} rounds=${options.rounds}`);

  // ── API + fixture ────────────────────────────────────────────────────────
  const uploadDir = join(tmpdir(), `mul394-zero-jump-uploads-${process.pid}`);
  ensureDir(uploadDir);
  database = openSqliteDatabase(":memory:");
  const store = new MultiremiStore(database);
  const fixture = await seedZeroJumpFixture(store);
  const minted = await store.createAccessToken({
    name: "MUL-394 zero-jump check",
    type: "pat",
    purpose: "personal",
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    expiresInDays: 1,
  });
  const token = minted.token;
  // The images in the long issue's markdown resolve to real attachment files;
  // they live in a temp dir this process owns and removes nothing else.
  writeFixtureImages(uploadDir, fixture);
  const imageCases = await seedImageCases(store, fixture, uploadDir);

  apiServer = startMultiremiServer({
    store,
    port: apiPort,
    hostname: "127.0.0.1",
    authToken: null,
    backgroundJobs: false,
  });
  await waitForHttp(`http://127.0.0.1:${apiPort}/health`, 30_000);
  log(`api ready; fixture: ${fixture.counts.longComments} long comments, ${fixture.counts.sessions} sessions, inbox ${fixture.inboxItemId}`);
  const ssrProbe = startSsrProbe(`http://127.0.0.1:${apiPort}`, findFreePort(Math.max(apiPort, webPort) + 1));
  running.push({ kill: () => ssrProbe.stop() });

  // ── web build + start ────────────────────────────────────────────────────
  if (!options.skipBuild) {
    log("building the web app (next build)…");
    const build = Bun.spawn({
      cmd: ["bun", "run", "build"],
      cwd: WEB_APP_DIR,
      env: {
        ...process.env,
        REMOTE_API_URL: `http://127.0.0.1:${apiPort}`,
        NEXT_BUILD_CPUS: process.env.NEXT_BUILD_CPUS ?? "8",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const buildExit = await build.exited;
    if (buildExit !== 0) {
      const err = await new Response(build.stderr).text();
      throw new Error(`next build failed (${buildExit}): ${err.split("\n").slice(-12).join("\n")}`);
    }
    log("web build complete");
  }

  const webLog = join(tmpdir(), `mul394-zero-jump-web-${webPort}.log`);
  const logFd = await Bun.file(webLog).writer();
  const web = Bun.spawn({
    cmd: ["bun", "x", "next", "start", "--port", String(webPort)],
    cwd: WEB_APP_DIR,
    env: { ...process.env, PORT: String(webPort), REMOTE_API_URL: ssrProbe.origin },
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push({ kill: () => web.kill() });
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of web.stdout as ReadableStream<Uint8Array>) await logFd.write(decoder.decode(chunk));
  })().catch(() => {});
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of web.stderr as ReadableStream<Uint8Array>) await logFd.write(decoder.decode(chunk));
  })().catch(() => {});
  await waitForHttp(`${webOrigin}/login`, 60_000);
  log(`web ready at ${webOrigin}`);

  // ── browser ──────────────────────────────────────────────────────────────
  browser = await launchBrowser();
  // Read complete Flight independently of browser-cancelled session redirects.
  // Both requests run against the production Next server with a real cookie.
  const directRscChecks = [];
  for (const prefetch of [false, true]) {
    const before = ssrProbe.reads.length;
    const response = await fetch(`${webOrigin}/${fixture.workspaceSlug}/issues/${fixture.shortIssueId}`, {
      headers: { RSC: "1", Accept: "*/*", Cookie: `multimira_auth=${encodeURIComponent(token)}`,
        ...(prefetch ? { "Next-Router-Prefetch": "1" } : {}) },
    });
    const body = await response.text();
    const status = /"data-ssr-seed"\s*:\s*"([a-z-]+)"/.exec(body)?.[1] ?? null;
    const initialLog = /"initialLog":(?!"\$undefined")/.test(body);
    const initialData = /"initialData":(?!"\$undefined")/.test(body);
    const reads = ssrProbe.reads.slice(before);
    directRscChecks.push({ prefetch, status, initialLog, initialData, ssrGets: reads.length, httpStatus: response.status });
    if (reads.length || initialLog || initialData || (status !== "soft-nav" && !(prefetch && status === null))) {
      throw new Error(`direct RSC/prefetch bootstrap gate failed: ${JSON.stringify(directRscChecks.at(-1))}`);
    }
  }
  const scenarios = buildScenarios(fixture, options, imageCases);
  const rounds: RoundResult[] = [];
  for (const scenario of scenarios) {
    for (let round = 1; round <= options.rounds; round += 1) {
      const result = await runRound({
        browser,
        token,
        webOrigin,
        apiOrigin: `http://127.0.0.1:${apiPort}`,
        slug: fixture.workspaceSlug,
        workspaceId: fixture.workspaceId,
        scenario,
        round,
        ssrCookie: options.ssrCookie,
        userId: fixture.userId,
        ssrProbe,
      });
      rounds.push(result);
      const violations = violationsForRound(result);
      log(
        `  ${scenario.key}::${scenario.mode} #${round}: `
        + `jumps=${result.jumpCount} anchor=${result.readyMs === null ? "none" : "visible"} `
        + `skeletons=${result.skeletons} state=${result.perfState ?? "absent"}`
        + `${result.appReadyForcedSeen ? " (forced seen)" : ""}`
        + `${violations.length > 0 ? ` VIOLATIONS=${violations.join("+")}` : " ok"}`
        + `${result.error ? ` error=${result.error}` : ""}`,
      );
    }
  }
  // ── verdict ──────────────────────────────────────────────────────────────
  const grouped = groupResults(rounds);
  const allowlistRaw = JSON.parse(readFileSync(options.allowlist, "utf8")) as ZeroJumpAllowlist;
  const allowlistProblems = validateZeroJumpAllowlist(allowlistRaw);
  if (allowlistProblems.length > 0) {
    for (const problem of allowlistProblems) log(`  allowlist problem: ${problem}`);
  }
  const verdict = judgeZeroJumpRun({ results: grouped, allowlist: allowlistRaw, strict: options.strict });

  ensureDir(resolve(options.out, ".."));
  writeFileSync(options.out, `${JSON.stringify({
    kind: "mul394-zero-jump",
    strict: options.strict,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    commit: currentCommit(),
    fixture: fixture.counts,
    imageFixture: { width: 640, height: 240, cases: imageCases.map(({ key, kind }) => ({ key, kind })) },
    ssrCookie: options.ssrCookie,
    directRscChecks,
    rounds,
    rows: grouped.map((row) => ({
      ...row,
      pair: zeroJumpPairKey(row),
      violations: row.observed.map((kinds) => kindList(kinds)),
    })),
    verdict: {
      ok: verdict.ok,
      checkedPairs: verdict.checkedPairs,
      failures: verdict.failures,
    },
  }, null, 2)}\n`);

  log(`\nreport: ${options.out}`);
  log(`failure frames (written only for failing rounds): ${process.env[SHOT_DIR_ENV] ?? join(tmpdir(), "mul394-zero-jump")}`);
  log(`rows: ${grouped.map((row) => zeroJumpPairKey(row)).join(", ")}`);
  if (verdict.ok) {
    log(`\nOK: ${grouped.length} row(s) × ${options.rounds} repetition(s), no unlisted violation${options.strict ? "" : " and no stale allowlist entry"}.`);
  } else {
    log(`\nFAIL: ${verdict.failures.length} problem(s)${options.strict ? " (strict)" : ""}:`);
    for (const failure of verdict.failures) log(`  - ${failure.message}`);
  }

  process.exitCode = verdict.ok && allowlistProblems.length === 0 ? 0 : 1;
}

/** Canonical ordering, so the JSON reads like the verdict does. */
function kindList(kinds: ZeroJumpViolation[]): ZeroJumpViolation[] {
  const set = new Set(kinds);
  return ZERO_JUMP_VIOLATIONS.filter((kind) => set.has(kind));
}

function currentCommit(): string | null {
  try {
    const result = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: REPO_ROOT });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/** Writes the 1x1 PNGs the fixture's markdown points at, into the temp upload dir. */
function writeFixtureImages(uploadDir: string, fixture: ZeroJumpFixture): void {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  ensureDir(join(uploadDir, fixture.workspaceId));
  for (let index = 0; index < fixture.counts.longImages; index += 1) {
    writeFileSync(join(uploadDir, fixture.workspaceId, `att_zerojump_img_${index}.png`), png);
  }
  writeFileSync(join(uploadDir, fixture.workspaceId, `${fixture.htmlAttachmentId}.html`),
    "<!doctype html><html><body><h1>Fixture HTML preview</h1><p>" + "safe preview text ".repeat(3000) + "</p></body></html>");
  process.env.MULTIREMI_UPLOAD_DIR = uploadDir;
}

export { violationsForRound, groupResults, buildScenarios, findSsrSeedRereads, type RoundResult, type Scenario };

if (import.meta.main) {
  const keepOpen = process.argv.includes("--keep");
  // `process.exit` rather than a natural drain: `next start` inherits pipes this
  // process reads from, and those handles keep the event loop alive after the
  // verdict is written. The exit code is set before exiting, so CI still sees a
  // failure.
  main()
    .catch((error) => {
      process.stderr.write(`\nFAIL: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      if (keepOpen) return;
      shutdown();
      process.exit(process.exitCode ?? 0);
    });
}
