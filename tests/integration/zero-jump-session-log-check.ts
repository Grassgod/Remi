#!/usr/bin/env bun
/**
 * MUL-443 self-test: the flat session log does not move under the three
 * perturbations the acceptance names.
 *
 *   bun run tests/integration/zero-jump-session-log-check.ts
 *
 * What it does, all on 127.0.0.1 with no remote host and no database:
 *
 *   1. bundles the fixture page (`zero-jump-session-log-fixture.tsx`) with
 *      `Bun.build`, the same bundler the app uses;
 *   2. serves that bundle and a host document from a local HTTP server, so the
 *      page is a real document with a real origin;
 *   3. drives it with Playwright + Chromium and MUL-384's recorder installed
 *      through `addInitScript`, exactly as `zero-jump-check.ts` does;
 *   4. measures three scenarios — append 20 rows, grow a row above the viewport,
 *      resize the container — and judges each with `computeJumps`.
 *
 * The verdict is `jumps = 0` per scenario, from the same `jump-recorder`
 * post-processing the CI gate uses. `data-perf-state` / `data-perf-fresh` are
 * reported alongside, because "the probe saw no movement" and "the app said it
 * was ready" are different claims and the acceptance wants both.
 *
 * The report is written to `reports/performance/MUL-443-session-log-zero-jump.json`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  computeAppReadyMs,
  computeFirstRealMs,
  computeJumps,
  installRecorderOnContext,
  readRecorder,
  readRecorderSummary,
  resetRecorderAt,
  type PerfProfileConfig,
  type PerfProfileFrame,
  type PerfProfileName,
  type PerfFrame,
  type PerfRecorderBuffer,
} from "../../frontend/scripts/perf/lib/jump-recorder";
import { launchBrowser } from "../../frontend/scripts/perf/lib/harness";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const GLOBALS_CSS = join(REPO_ROOT, "frontend", "apps", "web", "app", "globals.css");
const FIXTURE_ENTRY = join(REPO_ROOT, "tests", "integration", "zero-jump-session-log-fixture.tsx");
const DEFAULT_OUT = join(REPO_ROOT, "reports", "performance", "MUL-443-session-log-zero-jump.json");
const VIEWPORT = { width: 1440, height: 900 } as const;
const REPETITIONS = 3;
const ROUND_TIMEOUT_MS = 20_000;
/** `useStickToBottom`'s re-pin threshold; a release has to clear it. */
const PIN_THRESHOLD_PX = 24;
/**
 * How far above the end the reader is parked for the measurement.
 *
 * Comfortably outside the pin threshold, and far enough that a wrong follow
 * would be a large, unmistakable movement rather than a rounding error.
 */
const RELEASE_SCROLL_OFFSET_PX = 300;

/**
 * The fixture's own DOM contract.
 *
 * `items` is the list's real row attribute, the anchor is the row the reveal
 * lands on, and the rule is the same shape the issue-detail probe uses: the
 * terminal anchor has to be inside the viewport with no skeleton up. Keeping
 * the rule identical means a `ready` here means what it means there.
 */
const PROFILE: PerfProfileConfig = {
  name: "contract",
  scrollRoot: "[data-session-log-scroll]",
  items: "[data-perf-item]",
  skeleton: '[data-slot="skeleton"]',
  anchors: [
    {
      name: "latest-message",
      selector: '[data-perf-anchor="latest-message"]',
      pick: "first",
      visibility: "contained",
    },
  ],
  rule: { kind: "anchor", anchors: ["latest-message"] },
};

type ScenarioKey =
  | "append-20"
  | "row-height-change"
  | "width-change"
  | "degraded-render"
  | "positive-control";

interface Scenario {
  key: ScenarioKey;
  /** What the reader would see happening, for the report. */
  what: string;
  /**
   * Where the reader is when the perturbation lands. Each scenario picks the
   * state in which the mechanism it tests is actually load-bearing; a state
   * where nothing should move would report `jumps = 0` no matter how broken the
   * code is.
   */
  reader: "released" | "pinned" | "reveal-window";
  /**
   * Perturb the page. The pre-reveal case is armed at document start so it
   * cannot race the reveal while Playwright reads its baseline. Each goes through one of the fixture's
   * `*BetweenFrames` methods, so the mutation lands strictly between two
   * recorded frames; see the comment on those methods.
   */
  perturb: (page: Page) => Promise<void>;
  /**
   * Rows the scenario is expected to add, when it adds any. Used only to assert
   * the perturbation actually happened: a scenario that silently did nothing
   * would report `jumps = 0` and mean nothing.
   */
  expectRowsAdded: number | null;
  /** Container width the scenario ends at, when it resizes. */
  expectWidth: number | null;
  /**
   * Scroll movement the perturbation is expected to cause, for the control.
   * Scenario perturbations must not move the reader; the control must.
   */
  expectScrollDeltaPx?: number;
  /**
   * Degraded-render count the perturbation should raise. The degraded row is
   * below the viewport, so the content height need not change and
   * `scrollHeight` is not a usable "did it apply" signal for it.
   */
  expectDegradedCount?: number;
}

const SCENARIOS: Scenario[] = [
  {
    key: "append-20",
    what: "20 rows appended while the reader is parked above the end",
    /**
     * The reader has scrolled up, so new content must arrive without touching
     * their position. This is the regression the old `followOutput` +
     * `startReached` pair caused: any auto-follow drags a released reader to the
     * end. A pinned append would be trivially still (the content lands below the
     * viewport and the list follows), so it would measure nothing.
     */
    reader: "released",
    perturb: async (page) => {
      await page.evaluate(() => window.__mul443SessionLog!.appendBetweenFrames(20));
    },
    expectRowsAdded: 20,
    expectWidth: null,
  },
  {
    key: "row-height-change",
    what: "a row grows below the reader's viewport, moving the content end",
    /**
     * What a late image, a resolved Shiki pass or a taller revision does to the
     * layout. The growth is below the viewport on purpose.
     *
     * Growth *above* the viewport is not measurable with this probe: holding the
     * reader still there requires `useStickToBottom` to increase `scrollTop` by
     * exactly the growth, and `jump-recorder` counts any `scrollTop` movement
     * above 1px as a jump by construction (`frameMoved`). The probe cannot tell
     * a compensated pin from a real jump, so a scenario asserting `jumps = 0`
     * for that case would be asserting something it cannot observe. The
     * compensation itself is covered by MUL-450's own hook tests, and
     * `use-row-heights.test.ts` covers the reservation path.
     *
     * What this scenario does assert, and what the report shows, is the pair that
     * makes the claim meaningful: the content end moved by `contentGrowthPx`
     * (`> 0`, so the perturbation is real) and the reader's rows and scroll
     * position did not move at all.
     */
    reader: "released",
    perturb: async (page) => {
      await page.evaluate(() => window.__mul443SessionLog!.growRowBetweenFrames());
    },
    expectRowsAdded: null,
    expectWidth: null,
  },
  {
    key: "width-change",
    what: "the container is resized while the reveal is still deciding",
    /**
     * Perturbed *inside* the reveal window: the container changes before the app
     * has said `ready`, so the resize has to be measured and the final position
     * applied once. Waiting for the reveal first would move the surprise past the
     * gate and measure nothing, and the width bucket in the height-cache key
     * exists for exactly this case.
     */
    reader: "reveal-window",
    perturb: async (page) => {
      await page.evaluate(() => window.__mul443SessionLog!.setWidthBetweenFrames(640));
    },
    expectRowsAdded: null,
    expectWidth: 640,
  },
  {
    key: "degraded-render",
    what: "a row's body_html disappears (backfill window), so it renders on the client",
    /**
     * The plan's `degraded_render` path. The row that degrades is below the
     * reader, and the assertion is the pair again: the row really did fall back
     * (the fixture's own counter goes up) and the reader did not move.
     */
    reader: "released",
    perturb: async (page) => {
      const before = await page.evaluate(() => window.__mul443SessionLog!.state().degraded);
      // The last row: below the reader's viewport at the 300px release offset,
      // so its fallback cannot move what they are looking at.
      await page.evaluate((seq: number) => window.__mul443SessionLog!.degradeRowBetweenFrames(seq), 60);
      await page.waitForFunction(
        (expected: number) => window.__mul443SessionLog!.state().degraded > expected,
        before,
        { timeout: 5_000 },
      );
    },
    expectRowsAdded: null,
    expectWidth: null,
    expectDegradedCount: 1,
  },
];

/**
 * The positive control: the same page, the same recorder, one deliberate
 * movement.
 *
 * A green run only means something if the instrument could have shown red. This
 * round scrolls the list by a known amount inside one frame and requires the
 * probe to report it; the check fails when the control does not register. It runs
 * last so its movement cannot contaminate a scenario, and it is reported as its
 * own row.
 */
const CONTROL_SCROLL_PX = 200;

interface RoundResult {
  key: ScenarioKey | "positive-control";
  round: number;
  what: string;
  /** The fixture's own state when the reveal settled, before the perturbation. */
  settled: FixtureState;
  /** Rows the reader could see at that moment. */
  settledVisibleRows: number;
  /** The fixture's state after the perturbation. */
  after: FixtureState;
  perfState: string | null;
  perfFresh: string | null;
  /** The app's own verdict, from `data-perf-state` transitions. */
  appReadyMs: number | null;
  appReadyForced: boolean;
  readyMs: number | null;
  firstRealMs: number | null;
  jumpCount: number | null;
  jumpPx: number | null;
  jumpScrollPx: number | null;
  jumps: ReturnType<typeof computeJumps>["jumps"];
  /** Recorder timestamps of the window's two ends, for the report. */
  scrollWindowStart: number;
  perturbAt: number;
  /** Diagnostic: largest movement of a *visible* row, in pixels. */
  maxRowTranslationPx: number;
  /** Diagnostic: total scroll movement across the window, in pixels. */
  scrollDeltaPx: number;
  /** Diagnostic: how much the content grew, in pixels. */
  contentGrowthPx: number;
  perturbationApplied: boolean;
  /** Distance from the end of the content when the measurement window opened. */
  releasedFromBottomPx: number;
  /**
   * Which assertions this round violated, in the same vocabulary the CI gate
   * uses. Empty is a pass.
   */
  violations: string[];
  error: string | null;
}

interface FixtureState {
  head: number | null;
  rows: number;
  revisionOfFirst: number | null;
  width: number;
  perfState: string | null;
  perfFresh: string | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
  newMessages: string | null;
  /** Rows that fell back to the client renderer (`degraded_render`). */
  degraded: number;
  /**
   * Distance from the end of the content, in pixels. The scenarios park the
   * reader in the released state, so this is how the driver proves the state it
   * claims to be measuring is the state it is in (the stick hook's threshold is
   * 24px).
   */
  bottomDistance: number;
}

declare global {
  interface Window {
    __mul443WidthChange?: { settled: FixtureState; startedAt: number; applied: boolean; pendingAtApply?: boolean };
    __mul443SessionLog?: {
      append(count: number): void;
      growRow(seq?: number, revision?: number): void;
      setWidth(px: number): void;
      setFresh(ready: boolean): void;
      state(): FixtureState;
      appendBetweenFrames(count: number): Promise<void>;
      growRowBetweenFrames(seq?: number, revision?: number): Promise<void>;
      setWidthBetweenFrames(px: number): Promise<void>;
      /** The positive control: a deliberate scroll, which must register as a jump. */
      scrollByBetweenFrames(deltaPx: number): Promise<void>;
      degradeRowBetweenFrames(seq: number): Promise<void>;
    };
  }
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Current HEAD, or null outside a git checkout (the report just omits it). */
function readHeadCommit(): string | null {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT });
    const value = result.stdout.toString().trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Compile the application's own stylesheet.
 *
 * The list's scroll root is `overflow-y-auto` and its rows are `relative`; with
 * no stylesheet the fixture page has no scroll box at all, no scroll range, and
 * every scenario trivially reports zero movement — a green check that measures
 * nothing. Compiling the real `globals.css` (Tailwind + the UI tokens) is what
 * makes this page lay out the way the app does. It costs about half a second.
 */
async function buildStylesheet(): Promise<string> {
  const source = readFileSync(GLOBALS_CSS, "utf8");
  const result = await postcss([tailwind()]).process(source, { from: GLOBALS_CSS });
  return String(result.css);
}

/** Serve the built bundle, the stylesheet and the host document from one local origin. */
async function startFixtureServer(bundleJs: string, stylesheetCss: string): Promise<{ origin: string; stop: () => void }> {
  const document = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8" /><title>MUL-443 session log fixture</title>',
    // The list and the row markup rely on box sizing; the real app gets this
    // from its stylesheet, and this page has none.
    '<link rel="stylesheet" href="/fixture.css" />',
    "<style>",
    "html,body,#root{margin:0;padding:0}",
    // The contract under test is the app's own: `useStickToBottom` compensates
    // inside a ResizeObserver so growth above the viewport never shows. Chrome
    // separately implements scroll anchoring, which would keep the viewport
    // still through a mechanism the app cannot rely on (Safari has none) — and
    // because the recorder only sees `scrollTop`, an anchored correction is
    // indistinguishable from a real scroll. Turning it off is what makes this
    // page measure the hook instead of the browser. Measured: with anchoring on,
    // `row-height-change` reported a 144px scroll jump in 1 of 3 rounds.
    "[data-session-log-scroll]{overflow-anchor:none}",
    "</style>",
    "</head><body><div id=\"root\"></div>",
    '<script type="module" src="/fixture.js"></script>',
    "</body></html>",
  ].join("\n");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.css") {
        return new Response(stylesheetCss, { headers: { "content-type": "text/css; charset=utf-8" } });
      }
      if (url.pathname === "/fixture.js") {
        return new Response(bundleJs, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      }
      if (url.pathname === "/" || url.pathname === "/fixture") {
        return new Response(document, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** How many `data-perf-item` rows were inside the scroll root at that frame. */
async function countVisibleRows(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.querySelector("[data-session-log-scroll]") as HTMLElement | null;
    if (!root) return 0;
    const viewport = root.getBoundingClientRect();
    return [...root.querySelectorAll("[data-perf-item]")].filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    }).length;
  });
}

interface TranslationSummary {
  /** Largest movement of a row the reader could see, in pixels. */
  maxRowPx: number;
  /** Total scroll movement across the window. */
  scrollDeltaPx: number;
  /** How much the content grew, in pixels. */
  contentGrowthPx: number;
}

/**
 * Translate the recorded frames into "did the reader's view move?".
 *
 * `computeJumps` is the CI gate and stays the verdict. This is the diagnostic
 * behind it, and it answers the two questions `jumps` cannot: movement of rows
 * the reader could see (as opposed to content growing below them), and how much
 * the content grew (which is what makes the perturbation real).
 */
function measureTranslation(frames: readonly PerfFrame[], profile: PerfProfileName): TranslationSummary {
  const ordered = [...frames].sort((left, right) => left.t - right.t);
  let maxRowPx = 0;
  let scrollDeltaPx = 0;
  let contentGrowthPx = 0;
  let previous: PerfProfileFrame | null = null;
  for (const frame of ordered) {
    const current = frame.profiles[profile];
    if (!current) continue;
    if (previous) {
      const before = new Map<string, number>();
      for (const item of previous.items) {
        if (item.top >= previous.rootHeight || item.bottom <= 0) continue;
        before.set(`${item.key}:${item.elId}`, item.top);
      }
      for (const item of current.items) {
        if (item.top >= current.rootHeight || item.bottom <= 0) continue;
        const was = before.get(`${item.key}:${item.elId}`);
        if (was === undefined) continue;
        maxRowPx = Math.max(maxRowPx, Math.abs(item.top - was));
      }
      scrollDeltaPx += Math.abs((current.scrollTop ?? 0) - (previous.scrollTop ?? 0));
      if ((current.scrollHeight ?? 0) > (previous.scrollHeight ?? 0)) {
        contentGrowthPx += (current.scrollHeight ?? 0) - (previous.scrollHeight ?? 0);
      }
    }
    previous = current;
  }
  return {
    maxRowPx: Math.round(maxRowPx * 10) / 10,
    scrollDeltaPx: Math.round(scrollDeltaPx * 10) / 10,
    contentGrowthPx: Math.round(contentGrowthPx * 10) / 10,
  };
}

/**
 * Waits until the scroll position stops changing.
 *
 * A dispatched `WheelEvent` scrolls the page asynchronously; the position it
 * lands on is the reader's own movement and must be outside the measurement
 * window. This is a settle wait rather than a fixed sleep: it returns as soon as
 * three consecutive samples agree.
 */
async function waitForScrollToSettle(page: Page): Promise<void> {
  let previous = Number.NaN;
  let stable = 0;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && stable < 3) {
    const current = await page.evaluate(() => {
      const root = document.querySelector("[data-session-log-scroll]") as HTMLElement | null;
      return root?.scrollTop ?? 0;
    });
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    await page.waitForTimeout(30);
  }
}

/** Waits for the app's own reveal to settle, then for the quiet window to close. */
async function waitForReady(page: Page): Promise<void> {
  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const summary = await readRecorderSummary(page).catch(() => null);
    if (summary?.profiles.contract?.ready) return;
    await page.waitForTimeout(50);
  }
}

/**
 * The app's own reveal verdict, read from the recorder's state transitions.
 *
 * This has to be read *before* the measurement window is reset for a scenario:
 * `reset()` drops the recorded transitions, and the reveal is a page-load fact,
 * not a scenario fact. For `width-change`, which perturbs before the reveal, it
 * is read afterwards instead. Reading it in the wrong window is why the first
 * version of this check reported `perf-ready` for every round of correct code.
 */
async function readAppReady(page: Page): Promise<{ appReadyMs: number | null; forced: boolean }> {
  const buffer = await readRecorder(page).catch(() => null);
  const result = computeAppReadyMs(buffer?.stateTransitions ?? []);
  return { appReadyMs: result.appReadyMs, forced: result.forced };
}

/**
 * Waits until the fixture page has mounted its control surface.
 *
 * `goto` resolves at `commit`, so a round that perturbs before the reveal (the
 * width change) would otherwise race the bundle and find no control object at
 * all.
 */
async function waitForFixture(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__mul443SessionLog !== undefined, undefined, {
    timeout: ROUND_TIMEOUT_MS,
  });
}

/** The fixture state before anything is measured, so a failed round still reports. */
const EMPTY_STATE: FixtureState = {
  head: null,
  rows: 0,
  revisionOfFirst: null,
  width: 0,
  perfState: null,
  perfFresh: null,
  scrollTop: 0,
  scrollHeight: 0,
  clientHeight: 0,
  clientWidth: 0,
  newMessages: null,
  degraded: 0,
  bottomDistance: 0,
};

/**
 * The control round's scenario: no data change, just a deliberate scroll of a
 * known size inside one frame. It runs with the reader released, like the
 * scenarios it validates.
 */
const CONTROL_SCENARIO: Scenario = {
  key: "positive-control",
  what: `a deliberate ${CONTROL_SCROLL_PX}px scroll, which the probe must report`,
  reader: "released",
  perturb: async (page) => {
    await page.evaluate((amount: number) => window.__mul443SessionLog!.scrollByBetweenFrames(amount), CONTROL_SCROLL_PX);
  },
  expectRowsAdded: null,
  expectWidth: null,
  expectScrollDeltaPx: CONTROL_SCROLL_PX,
};

/**
 * One measured round.
 *
 * Every scenario shares the same baseline: the reveal settles, the reader is
 * parked well above the end, and the perturbation lands in a deliberate one of
 * two windows.
 *
 * - `append-20` and `row-height-change` perturb *after* the reveal, with the
 *   measurement window opened at a t=0 the recorder itself reported. A later
 *   window cannot be used: the fixture's `scrollTop` is non-zero, so
 *   `computeFirstRealMs` starts the measured range at the first frame where a
 *   row is visible — i.e. one frame before whichever change happens next — and
 *   a perturbation that arrived earlier would already have been absorbed.
 * - `width-change` perturbs *inside* the reveal window, before the app has said
 *   `ready`, so the resize has to be measured and the final position applied
 *   once. Waiting for the reveal first would move the surprise past the gate and
 *   measure nothing at all.
 */
async function runRound(input: {
  browser: Browser;
  origin: string;
  scenario: Scenario;
  round: number;
}): Promise<RoundResult> {
  const { browser, origin, scenario, round } = input;
  const result: RoundResult = {
    key: scenario.key,
    round,
    what: scenario.what,
    settled: { ...EMPTY_STATE },
    settledVisibleRows: 0,
    after: { ...EMPTY_STATE },
    perfState: null,
    perfFresh: null,
    appReadyMs: null,
    appReadyForced: false,
    readyMs: null,
    firstRealMs: null,
    jumpCount: null,
    jumpPx: null,
    jumpScrollPx: null,
    jumps: [],
    scrollWindowStart: 0,
    perturbAt: 0,
    maxRowTranslationPx: 0,
    scrollDeltaPx: 0,
    contentGrowthPx: 0,
    perturbationApplied: false,
    releasedFromBottomPx: 0,
    violations: [],
    error: null,
  };

  const context: BrowserContext = await browser.newContext({ viewport: VIEWPORT });
  await context.setDefaultTimeout(ROUND_TIMEOUT_MS);
  await installRecorderOnContext(context, { profiles: [PROFILE] });
  if (scenario.reader === "reveal-window") {
    // Arm inside the renderer before mount. IPC reads plus a later rAF used to
    // let the reveal's second stable frame win, testing a visible resize instead
    // of the declared pre-reveal scenario. Do not reset or weaken the recorder.
    await context.addInitScript(() => {
      const observer = new MutationObserver(() => {
        const root = document.querySelector("[data-session-log-scroll]");
        const control = window.__mul443SessionLog;
        if (!root || !control || !root.getAttribute("data-perf-state")) return;
        observer.disconnect();
        const probe = { settled: control.state(), startedAt: performance.now(), applied: false, pendingAtApply: false };
        window.__mul443WidthChange = probe;
        void control.setWidthBetweenFrames(640).then(() => {
          probe.pendingAtApply = root.getAttribute("data-perf-state") === "pending";
          probe.applied = true;
        });
      });
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-perf-state"] });
    });
  }
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });

  try {
    await page.goto(`${origin}/fixture`, { waitUntil: "commit", timeout: ROUND_TIMEOUT_MS });
    await waitForFixture(page);
    const perturbsBeforeReveal = scenario.reader === "reveal-window";
    if (!perturbsBeforeReveal) await waitForReady(page);

    if (scenario.reader === "released") {
      // Park the reader above the end. The scroll is written directly rather
      // than dispatched as a `WheelEvent`: a synthetic wheel event runs the
      // hook's listener but performs no default action, so it would release the
      // pin and leave the position at the bottom.
      await page.evaluate((offset: number) => {
        const root = document.querySelector("[data-session-log-scroll]") as HTMLElement | null;
        if (!root) return;
        root.scrollTop = Math.max(0, root.scrollHeight - root.clientHeight - offset);
      }, RELEASE_SCROLL_OFFSET_PX);
      await waitForScrollToSettle(page);
    }

    if (!perturbsBeforeReveal) {
      const appReady = await readAppReady(page);
      result.appReadyMs = appReady.appReadyMs;
      result.appReadyForced = appReady.forced;
    }

    const widthChange = perturbsBeforeReveal ? await (async () => {
      await page.waitForFunction(() => window.__mul443WidthChange?.applied, undefined, { timeout: ROUND_TIMEOUT_MS });
      return page.evaluate(() => window.__mul443WidthChange!);
    })() : null;
    if (widthChange && (widthChange.settled.perfState !== "pending" || !widthChange.pendingAtApply)) {
      throw new Error("width-change must be applied while the reveal is pending");
    }
    const settled = widthChange?.settled ?? await page.evaluate(() => window.__mul443SessionLog!.state());
    result.settled = settled;
    result.releasedFromBottomPx = settled.bottomDistance;
    result.settledVisibleRows = await countVisibleRows(page);
    if (scenario.reader === "released" && settled.bottomDistance <= PIN_THRESHOLD_PX) {
      // The scenario did not reach the state it claims to measure.
      result.error = `the pin never released (bottom distance ${settled.bottomDistance}px)`;
    }
    if (scenario.reader === "pinned" && settled.bottomDistance > PIN_THRESHOLD_PX) {
      result.error = `the list was not pinned (bottom distance ${settled.bottomDistance}px)`;
    }

    // A measurement window the recorder itself timestamps: t=0 here, exactly.
    //
    // The released scenarios need `reset()` because the reader's own scroll is
    // outside the window. The reveal-window scenario does not: there is no reader
    // scroll to exclude, and `reset()` would drop the reveal's own
    // `data-perf-state` transitions — which are exactly what that scenario
    // asserts. Measured: resetting there reported `perf-ready` for every round of
    // correct code.
    const windowStart = widthChange?.startedAt ?? await resetRecorderAt(page);
    const perturbAt = widthChange?.startedAt ?? await page.evaluate(() => performance.now());
    if (!widthChange) await scenario.perturb(page);
    if (perturbsBeforeReveal) {
      await waitForReady(page);
      const appReady = await readAppReady(page);
      result.appReadyMs = appReady.appReadyMs;
      result.appReadyForced = appReady.forced;
    }
    const after = await page.evaluate(() => window.__mul443SessionLog!.state());
    result.after = after;
    result.perfState = after.perfState;
    result.perfFresh = after.perfFresh;

    // Let the frames that carry the change be sampled before reading.
    await page.waitForTimeout(250);

    const scrollMovedPx = Math.abs(after.scrollTop - settled.scrollTop);
    result.perturbationApplied = scenario.expectRowsAdded !== null
      ? after.rows - settled.rows === scenario.expectRowsAdded
      : scenario.expectWidth !== null
        ? Math.round(after.width) === scenario.expectWidth
        : scenario.expectScrollDeltaPx !== undefined
          ? Math.abs(scrollMovedPx - scenario.expectScrollDeltaPx) <= 1
          : scenario.expectDegradedCount !== undefined
            ? after.degraded - settled.degraded === scenario.expectDegradedCount
            : after.scrollHeight !== settled.scrollHeight;
    if (!result.perturbationApplied) {
      result.error = result.error ?? "the scenario's perturbation did not take effect";
    }

    const buffer: PerfRecorderBuffer | null = await readRecorder(page).catch(() => null);
    const frames = (buffer?.frames ?? []).filter((frame) => frame.t >= windowStart);
    if (frames.length === 0) {
      result.error = result.error ?? "recorder produced no frames inside the measurement window";
    } else {
      const firstRealMs = computeFirstRealMs(frames, PROFILE.name);
      const jumps = computeJumps(frames, { profile: PROFILE.name, fromMs: firstRealMs });
      const translation = measureTranslation(frames, PROFILE.name);
      result.firstRealMs = firstRealMs;
      result.perturbAt = Math.round(perturbAt * 10) / 10;
      result.scrollWindowStart = Math.round(windowStart * 10) / 10;
      result.jumpCount = jumps.jumpCount;
      result.jumpPx = jumps.jumpPx;
      result.jumpScrollPx = jumps.jumpScrollPx;
      result.jumps = jumps.jumps;
      result.maxRowTranslationPx = translation.maxRowPx;
      result.scrollDeltaPx = translation.scrollDeltaPx;
      result.contentGrowthPx = translation.contentGrowthPx;
      const summary = await readRecorderSummary(page).catch(() => null);
      result.readyMs = summary?.profiles.contract?.readyMs ?? null;
    }
  } catch (error) {
    result.error = (error as Error).message.split("\n")[0] ?? String(error);
  }

  // The app's own verdict, which is the same assertion the CI gate makes
  // (`data-perf-state=ready` with `data-perf-fresh=1`, never `ready-forced`).
  // Without it a page that never revealed at all — no `data-perf-state`
  // attribute, content simply visible — would report `jumps = 0` for every
  // scenario and mean nothing. Measured: disabling the reveal entirely still
  // produced nine clean rounds before this assertion existed.
  // Only the scenarios assert on the app's verdict. The control is about the
  // instrument: it says "a deliberate 200px scroll was reported as a jump", and
  // folding the app's state into it would blur the two claims.
  if (result.error === null && result.key !== "positive-control") {
    if (result.perfState !== "ready") {
      result.violations.push(`data-perf-state=${result.perfState ?? "absent"}`);
    }
    if (result.perfFresh !== "1") {
      result.violations.push(`data-perf-fresh=${result.perfFresh ?? "absent"}`);
    }
    if (result.appReadyMs === null || result.appReadyForced) {
      result.violations.push("perf-ready");
    }
  }
  if (result.violations.length > 0) {
    result.error = result.error ?? `violations: ${result.violations.join(", ")}`;
  }

  await context.close().catch(() => {});
  return result;
}

/** Bundle the fixture page. Fails loudly rather than serving a broken page. */
async function buildFixture(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [FIXTURE_ENTRY],
    target: "browser",
    minify: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success || result.outputs.length === 0) {
    for (const message of result.logs) log(`  build: ${message.level}: ${message.message}`);
    throw new Error("the fixture bundle failed to build");
  }
  return await result.outputs[0]!.text();
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  log("MUL-443 session-log zero-jump check");
  const bundle = await buildFixture();
  log(`  fixture bundle: ${(bundle.length / 1024).toFixed(0)} KiB`);
  const stylesheet = await buildStylesheet();
  log(`  stylesheet: ${(stylesheet.length / 1024).toFixed(0)} KiB`);
  const server = await startFixtureServer(bundle, stylesheet);
  log(`  fixture origin: ${server.origin}`);
  const browser = await launchBrowser();
  const rounds: RoundResult[] = [];
  try {
    for (const scenario of SCENARIOS) {
      for (let round = 1; round <= REPETITIONS; round += 1) {
        const result = await runRound({ browser, origin: server.origin, scenario, round });
        rounds.push(result);
        const verdict = result.error
          ? `ERROR ${result.error}`
          : `jumps=${result.jumpCount} px=${result.jumpPx} state=${result.perfState} fresh=${result.perfFresh}`
            + ` grow=${result.contentGrowthPx} degraded=${result.after.degraded}`;
        log(`  ${scenario.key} #${round}: ${verdict}`);
      }
    }
    for (let round = 1; round <= REPETITIONS; round += 1) {
      const result = await runRound({ browser, origin: server.origin, scenario: CONTROL_SCENARIO, round });
      rounds.push(result);
      const verdict = result.error ? `ERROR ${result.error}` : `registered ${result.jumpPx}px`;
      log(`  positive-control #${round}: ${verdict}`);
    }
  } finally {
    await browser.close().catch(() => {});
    server.stop();
  }

  const scenarios = rounds.filter((round) => round.key !== "positive-control");
  const controls = rounds.filter((round) => round.key === "positive-control");
  const failures = scenarios.filter((round) => round.error !== null || round.jumpCount !== 0);
  // The control has to move: a run where the instrument cannot see a deliberate
  // 200px scroll would report `jumps = 0` for every scenario and mean nothing.
  const controlFailures = controls.filter(
    (round) => round.error !== null || (round.jumpPx === null || round.jumpPx < CONTROL_SCROLL_PX - 1),
  );
  const report = {
    kind: "mul443-session-log-zero-jump",
    startedAt,
    finishedAt: new Date().toISOString(),
    // The tree the numbers came from, read from git rather than passed in, so a
    // report cannot name a different commit than the one it ran on.
    commit: readHeadCommit(),
    fixture: { initialRows: 60, repetitions: REPETITIONS, controlScrollPx: CONTROL_SCROLL_PX },
    rounds,
    verdict: {
      ok: failures.length === 0 && controlFailures.length === 0,
      scenarioFailures: failures.length,
      controlFailures: controlFailures.length,
      controlObservedPx: controls.map((round) => round.jumpPx),
    },
  };
  mkdirSync(join(REPO_ROOT, "reports", "performance"), { recursive: true });
  writeFileSync(DEFAULT_OUT, `${JSON.stringify(report, null, 2)}\n`);
  log(`  report: ${DEFAULT_OUT}`);
  if (failures.length > 0 || controlFailures.length > 0) {
    if (failures.length > 0) {
      log(`FAIL: ${failures.length} of ${scenarios.length} scenario rounds moved or could not be driven`);
    }
    if (controlFailures.length > 0) {
      log(`FAIL: ${controlFailures.length} of ${controls.length} control rounds did not register the deliberate movement`);
    }
    process.exitCode = 1;
    return;
  }
  log(
    `PASS: ${scenarios.length} scenario rounds with jumps = 0, `
    + `control registered ${controls.map((round) => round.jumpPx).join("/")}px`,
  );
}

await main();
