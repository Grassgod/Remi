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
import { Database } from "bun:sqlite";
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
import { seedZeroJumpFixture, type ZeroJumpFixture } from "./zero-jump-fixture";

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
  key: string;
  mode: "cold" | "warm";
  path: string;
  /** Entry page for a warm round; the round clicks a real row there. */
  entry: "issues-list" | "inbox";
  /** Issue row to click, or the inbox row id for the deep link. */
  clickIssueId: string | null;
  inboxItemId: string | null;
  targetCommentId: string | null;
  /** Seeds a non-default sidebar width before any app code runs. */
  sidebarWidth: string | null;
  /** The issue the warm click must select; the deep link's `/inbox` click sets it. */
  expectIssueId: string | null;
}

function buildScenarios(fixture: ZeroJumpFixture, options: Options): Scenario[] {
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
    ...detail("detail-short", fixture.shortIssueId),
    ...detail("detail-long", fixture.longIssueId),
    ...detail("detail-running", fixture.runningIssueId),
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
interface RoundResult {
  key: string;
  mode: string;
  round: number;
  url: string;
  readyMs: number | null;
  readyTimeout: boolean;
  firstRealMs: number | null;
  anchorName: string | null;
  anchorRectAtReady: { top: number; bottom: number; height: number; rootHeight: number } | null;
  jumps: Array<{ startMs: number; endMs: number; px: number; scrollPx: number; kind: string; frames: number }>;
  jumpCount: number;
  jumpPx: number;
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

/** Which structural assertions this round violated. */
function violationsForRound(round: RoundResult): ZeroJumpViolation[] {
  const violations: ZeroJumpViolation[] = [];
  if (round.error) {
    // A round that could not be driven is not a pass: it never measured the page
    // the scenario asked for, and silently scoring it green is how a broken
    // fixture turns into a green gate. Reported as every kind it could have hit.
    return ["jumps", "anchor", "skeleton", "perf-state"];
  }
  if (round.jumpCount > 0) violations.push("jumps");
  if (round.readyTimeout || round.readyMs === null) violations.push("anchor");
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
      await route.continue();
      return;
    }
    const allowed = allowedOrigins.some((origin) => url.startsWith(origin));
    if (allowed) {
      await route.continue();
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
  scenario: Scenario;
  round: number;
}): Promise<RoundResult> {
  const { browser, token, webOrigin, apiOrigin, slug, scenario, round } = input;
  // The scenario's own profile: a deep link's terminal element is the target
  // comment, not the newest one. Installing the generic profile and
  // post-processing with it silently reported `readyTimeout` for every deep
  // link, because the rule it evaluated could never name the anchor the page
  // actually shows.
  const profile: PerfProfileConfig = profileFor({
    mode: "contract",
    shape: "issue-detail",
    targetCommentId: scenario.targetCommentId,
  });
  const targetUrl = `${webOrigin}/${slug}${scenario.path}`;
  const result: RoundResult = {
    key: scenario.key,
    mode: scenario.mode,
    round,
    url: targetUrl,
    readyMs: null,
    readyTimeout: true,
    firstRealMs: null,
    anchorName: null,
    anchorRectAtReady: null,
    jumps: [],
    jumpCount: 0,
    jumpPx: 0,
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

  const context: BrowserContext = await mktContext(browser, token, [], webOrigin);
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
  result.foreignRequests = await blockForeignRequests(page, [webOrigin]);

  try {
    if (scenario.mode === "cold") {
      await page.goto(targetUrl, { waitUntil: "commit", timeout: ROUND_TIMEOUT_MS });
    } else {
      const entryPath = scenario.entry === "inbox" ? "/inbox" : "/issues";
      await page.goto(`${webOrigin}/${slug}${entryPath}`, { waitUntil: "commit", timeout: ROUND_TIMEOUT_MS });
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
        await page.evaluate(([name, from]) => {
          const recorder = (window as unknown as Record<string, { reset?: (t?: number) => void }>)[name as string];
          recorder?.reset?.(from as number);
        }, [RECORDER_GLOBAL, clickT] as const);
      }
    }
    await waitForRecorderReady(page, profile.name, ROUND_TIMEOUT_MS);
  } catch (error) {
    result.error = (error as Error).message.split("\n")[0] ?? String(error);
  }

  const summary = await readRecorderSummary(page).catch(() => null);
  const buffer: PerfRecorderBuffer | null = await readRecorder(page).catch(() => null);
  await page.route("**/api/**", (route) => route.abort()).catch(() => {});
  result.blockedWrites = collectors.blockedWrites.reduce((sum, write) => sum + write.attempts, 0);
  result.stubbedWrites = collectors.stubbedWrites.reduce((sum, write) => sum + write.attempts, 0);
  result.inboxInjected = collectors.inboxInjected;

  const frames = buffer?.frames ?? [];
  if (buffer && frames.length > 0) {
    const firstRealMs = computeFirstRealMs(frames, profile.name);
    const ready = computeReadyWindow(frames, { profile, firstRealMs });
    const jumps = computeJumps(frames, { profile: profile.name, fromMs: firstRealMs, toMs: ready.readyMs ?? undefined });
    result.firstRealMs = firstRealMs;
    result.readyMs = ready.readyMs;
    result.readyTimeout = ready.readyTimeout;
    result.anchorName = ready.anchorName;
    result.anchorRectAtReady = ready.anchorRectAtReady;
    result.jumps = jumps.jumps;
    result.jumpCount = jumps.jumpCount;
    result.jumpPx = jumps.jumpPx;
    const appReady = computeAppReadyMs(buffer.stateTransitions);
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

  if (violationsForRound(result).length > 0) {
    const shotDir = join(tmpdir(), "mul394-zero-jump");
    ensureDir(shotDir);
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
    ? inboxRowSelector("contract")
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
  database = new Database(":memory:");
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

  apiServer = startMultiremiServer({
    store,
    port: apiPort,
    hostname: "127.0.0.1",
    authToken: null,
    backgroundJobs: false,
  });
  await waitForHttp(`http://127.0.0.1:${apiPort}/health`, 30_000);
  log(`api ready; fixture: ${fixture.counts.longComments} long comments, ${fixture.counts.sessions} sessions, inbox ${fixture.inboxItemId}`);

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
    env: { ...process.env, PORT: String(webPort) },
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
  const scenarios = buildScenarios(fixture, options);
  const rounds: RoundResult[] = [];
  for (const scenario of scenarios) {
    for (let round = 1; round <= options.rounds; round += 1) {
      const result = await runRound({
        browser,
        token,
        webOrigin,
        apiOrigin: `http://127.0.0.1:${apiPort}`,
        slug: fixture.workspaceSlug,
        scenario,
        round,
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
  process.env.MULTIREMI_UPLOAD_DIR = uploadDir;
}

export { violationsForRound, groupResults, buildScenarios, type RoundResult, type Scenario };

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
