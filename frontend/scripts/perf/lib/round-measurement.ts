/**
 * The pure half of one round's measurement: rebasing the recorder's timestamps
 * onto the round's own time origin, then deriving every reported number.
 *
 * Why this is its own module (MUL-395 S9-0): the arithmetic used to live inside
 * `page-speed.ts`, which calls `main()` at import time and therefore cannot be
 * unit-tested. The time-base bug the plan found — warm rounds reporting
 * `readyMs`/`firstRealMs`/`jumps[].startMs` from the *entry* page's document
 * origin — was invisible to the test suite for exactly that reason.
 *
 * Time base: the recorder timestamps everything with `performance.now()` of the
 * document it sampled. A cold round's document *is* the measured page, so its
 * origin is the right zero. A warm round lands on an entry page first and then
 * clicks into the measured page, and `reset(visibleFrom)` deliberately keeps the
 * clock (`jump-recorder.ts`); the click timestamp is therefore the correct zero.
 * Subtracting it here, once, before any other arithmetic, is what makes the two
 * variants comparable.
 */

import {
  computeAppReadyMs,
  computeFirstRealMs,
  computeJumps,
  computeReadyWindow,
  computeSelectorEquivalence,
  computeWaves,
  frameAt,
  round1,
  summarizeLayoutShifts,
  ROUND_TIMEOUT_MS,
  type PerfAnchorRect,
  type PerfApiEntry,
  type PerfFrame,
  type PerfJump,
  type PerfLayoutShift,
  type PerfProfileConfig,
  type PerfProfileName,
  type PerfSelectorEquivalence,
  type PerfStateTransition,
} from "./jump-recorder";
import { anchorPlan, type PageShape } from "./selectors";
// `parseServerTiming` is pure, but it lives with the other Server-Timing plumbing
// in `harness.ts`; `ResourceEntry` is the shape `readResourceEntries` returns.
import { parseServerTiming, type ResourceEntry } from "./harness";
import type { ReportRoundSummary } from "./report";
import type { RenderMeasurement } from "./render-measurement";

/** Everything one round contributes to the report, derived from the raw buffer. */
export interface RoundComputation {
  selectorMode: PerfProfileName;
  anchorRule: string;
  firstRealMs: number | null;
  firstRealKeys?: string[];
  observedFrames?: number;
  anchorVisibleMs: number | null;
  anchorName: string | null;
  anchorRectAtReady: PerfAnchorRect | null;
  readyMs: number | null;
  readyTimeout: boolean;
  jumpCount: number | null;
  jumpPx: number | null;
  jumpScrollPx: number | null;
  jumps: PerfJump[];
  layoutShiftCount: number;
  cls: number;
  appReadyMs: number | null;
  appReadyForced: boolean;
  dataFreshAtReady: boolean;
  serialDepth: number;
  serialChain: string[];
  apiCallsTotal: number;
  apiFirstScreen: number;
  apiFirstScreenEntries: PerfApiEntry[];
  chunksLoaded: number;
  chunkBytes: number;
  slowestServerTotalMs: number | null;
  selectorEquivalence: PerfSelectorEquivalence | null;
}

/** The readiness profile used for one measurement, in the mode that actually matched. */
export function profileForMeasurement(
  mode: PerfProfileName,
  shape: PageShape,
  targetCommentId: string | null,
  requireAgentStream = false,
): { anchorName: string; anchorRule: string; config: PerfProfileConfig } {
  const plan = anchorPlan({ mode, shape, targetCommentId, requireAgentStream });
  return {
    anchorName: plan.anchorName,
    anchorRule: plan.anchorRule,
    config: {
      name: mode,
      scrollRoot: "",
      items: "",
      skeleton: "",
      anchors: plan.specs,
      rule: plan.rule,
    },
  };
}

/**
 * The entry-page quiet rule's decision for one poll.
 *
 * Pulled out of the driver so the rule is testable without a browser: the plan
 * fixes both the window (no new `/api` request within `quietMs`) and the cap
 * (`ENTRY_QUIET_CAP_MS`, after which the click goes ahead and the round records
 * `entrySettled: false` — plan §0 item 1, §4.5).
 *
 * `sinceLastApiMs` is null until the entry page has made its first `/api` call,
 * so an idle-looking page cannot satisfy the rule before anything happened.
 */
export type EntryQuietVerdict = "settled" | "waiting" | "timeout";

export function entryQuietVerdict(input: {
  /** Milliseconds since the last `/api` request started, or null for "none yet". */
  sinceLastApiMs: number | null;
  quietMs: number;
  /** Milliseconds spent waiting for the rule so far. */
  waitedMs: number;
  capMs: number;
}): EntryQuietVerdict {
  // Quiet wins at the boundary: a page that settled exactly as the cap expired
  // did satisfy the rule, and reporting a timeout there would be wrong.
  if (input.sinceLastApiMs !== null && input.sinceLastApiMs >= input.quietMs) return "settled";
  if (input.waitedMs >= input.capMs) return "timeout";
  return "waiting";
}

/**
 * Rebase and reduce one round.
 *
 * `navStartMs` is 0 for cold rounds, so their numbers are unchanged. For warm
 * rounds it is the in-page click timestamp: frames, layout shifts and
 * `data-perf-state` transitions are all shifted by it, and the first-screen set
 * is bounded below by it (`startMs >= navStartMs`) so the entry page's trailing
 * requests can never be counted as the target page's first screen.
 */
export function computeRoundMeasurement(input: {
  mode: PerfProfileName;
  shape: PageShape;
  targetCommentId: string | null;
  requireAgentStream?: boolean;
  navStartMs: number;
  frames: PerfFrame[];
  shifts: PerfLayoutShift[];
  stateTransitions: PerfStateTransition[];
  resources: ResourceEntry[];
  quietMs: number;
  /** The recorder's own verdict for this profile at the end of the round. */
  profileReady: boolean | null;
  timeoutMs?: number;
}): RoundComputation {
  const navStartMs = Number.isFinite(input.navStartMs) ? input.navStartMs : 0;
  // Drop anything stamped before the round's origin, then rebase. The recorder
  // already clears its buffer at the click, but `reset(visibleFrom)` deliberately
  // keeps the clock and MUL-390 widens what survives there, so the origin is
  // enforced here instead of assumed: a leftover pre-click sample would otherwise
  // become a negative `firstRealMs` and a phantom jump. Cold rounds are untouched
  // (every `t` is already >= 0 and `navStartMs` is 0).
  const afterOrigin = <T extends { t: number }>(entry: T): boolean => entry.t >= navStartMs;
  const rebase = <T extends { t: number }>(entry: T): T => ({ ...entry, t: entry.t - navStartMs });
  const frames = input.frames.filter(afterOrigin).map(rebase);
  const shifts = input.shifts.filter(afterOrigin).map(rebase);
  const stateTransitions = input.stateTransitions.filter(afterOrigin).map(rebase);
  const timeoutMs = input.timeoutMs ?? ROUND_TIMEOUT_MS;

  const profile = profileForMeasurement(input.mode, input.shape, input.targetCommentId, input.requireAgentStream);
  const firstRealMs = computeFirstRealMs(frames, input.mode);
  const ready = computeReadyWindow(frames, {
    profile: profile.config,
    quietMs: input.quietMs,
    firstRealMs,
  });
  const readyMs = ready.readyMs;
  const readyTimeout = ready.readyTimeout || (!readyMs && input.profileReady !== true);

  const jumps = computeJumps(frames, {
    profile: input.mode,
    fromMs: firstRealMs,
    toMs: readyMs ?? undefined,
  });
  const shiftSummary = summarizeLayoutShifts(shifts, { fromMs: firstRealMs, toMs: readyMs ?? undefined });
  const appReady = computeAppReadyMs(stateTransitions);

  // The first-screen window: from the round's own origin (document load for cold,
  // the click for warm) to the ready frame. The lower bound is what the plan's
  // §4.2 asks for; without it a warm round folds the entry page's requests into
  // the target page's count.
  //
  // Resource entries carry the page's *absolute* clock — the same one the frames
  // used before rebasing — so the upper bound is the (relative) readiness shifted
  // back by `navStartMs`. The persisted entries keep their absolute timestamps and
  // `navStartMs` alongside them, so a reader recovers the round's own clock with a
  // single subtraction.
  const readinessMs = readyMs ?? firstRealMs ?? timeoutMs;
  const readinessAt = readinessMs + navStartMs;
  const apiCalls = input.resources.filter(
    (entry) => entry.path.startsWith("/api") && entry.startMs >= navStartMs,
  );
  const apiEntries = apiCalls.filter((entry) => entry.startMs <= readinessAt);
  const waves = computeWaves(
    apiEntries.map((entry) => ({
      index: entry.index,
      path: entry.path,
      startMs: entry.startMs,
      responseEndMs: entry.responseEndMs,
    })),
  );
  const waveByIndex = new Map(waves.rows.map((row) => [row.index, row]));
  // `after` is the predecessor's position *in this table* (0-based), so a reader
  // can follow the serial chain without knowing the resource-entry indices. The
  // wave-1 requests have no predecessor and store null.
  const positionByIndex = new Map(apiEntries.map((entry, position) => [entry.index, position]));
  const apiFirstScreenEntries: PerfApiEntry[] = apiEntries.map((entry) => {
    const timing = parseServerTiming(entry.serverTiming);
    const row = waveByIndex.get(entry.index);
    const afterIndex = row?.after ?? null;
    return {
      path: entry.path,
      method: entry.method,
      wave: row?.wave ?? 1,
      after: afterIndex === null ? null : positionByIndex.get(afterIndex) ?? null,
      startMs: entry.startMs,
      responseEndMs: entry.responseEndMs,
      durationMs: entry.durationMs,
      encodedBytes: entry.encodedBytes,
      serverTiming: timing,
      // Client-observed duration minus the server's own `total` (plan §3): the
      // part of the wait that happened outside the handler, i.e. connection and
      // queueing. Null when the response carried no usable `Server-Timing`.
      gapMs: timing.total === null ? null : round1(Math.max(0, entry.durationMs - timing.total)),
    };
  });

  const chunks = input.resources.filter(
    (entry) => entry.initiatorType === "script" && entry.startMs >= navStartMs,
  );

  let slowest = 0;
  for (const entry of apiEntries) {
    const timing = parseServerTiming(entry.serverTiming);
    if (timing.total !== null && timing.total > slowest) slowest = timing.total;
  }

  const computed: RoundComputation = {
    selectorMode: input.mode,
    anchorRule: profile.anchorRule,
    firstRealMs,
    firstRealKeys: frameAt(frames, firstRealMs)?.profiles[input.mode]?.items.filter(item => item.top < (frameAt(frames, firstRealMs)?.profiles[input.mode]?.rootHeight ?? 0) && item.bottom > 0).map(item => item.key) ?? [],
    observedFrames: frames.filter(frame => firstRealMs !== null && frame.t >= firstRealMs && (readyMs === null || frame.t <= readyMs + input.quietMs)).length,
    anchorVisibleMs: ready.anchorVisibleMs,
    anchorName: ready.anchorName ?? profile.anchorName,
    anchorRectAtReady: ready.anchorRectAtReady,
    readyMs,
    readyTimeout,
    jumpCount: jumps.jumpCount,
    jumpPx: jumps.jumpPx,
    jumpScrollPx: jumps.jumpScrollPx,
    jumps: jumps.jumps,
    layoutShiftCount: shiftSummary.layoutShiftCount,
    cls: shiftSummary.cls,
    appReadyMs: appReady.appReadyMs,
    appReadyForced: appReady.forced,
    // `data-perf-state` is the app's own verdict; comparing it with the probe's
    // ready window is the cross-check the plan asks for.
    dataFreshAtReady: appReady.appReadyMs !== null && readyMs !== null && Math.abs(appReady.appReadyMs - readyMs) < 1_000,
    serialDepth: waves.serialDepth,
    serialChain: waves.chain.map((index) => apiEntries.find((entry) => entry.index === index)?.path ?? String(index)),
    // Every API request the round made from its own origin onwards, ready or not.
    apiCallsTotal: apiCalls.length,
    apiFirstScreen: apiEntries.length,
    apiFirstScreenEntries,
    chunksLoaded: chunks.length,
    chunkBytes: chunks.reduce((sum, entry) => sum + entry.encodedBytes, 0),
    slowestServerTotalMs: slowest > 0 ? Math.round(slowest * 10) / 10 : null,
    // Contract/legacy agreement, taken at the ready frame. Only meaningful when
    // both profiles sampled the same DOM.
    selectorEquivalence: input.mode === "contract"
      ? computeSelectorEquivalence(frameAt(frames, readyMs ?? ready.anchorVisibleMs))
      : null,
  };
  return computed;
}

/**
 * Driver-owned state attached to one measured round.
 *
 * These are not derived from the recorder buffer — they come from the click, the
 * write guard and the collectors — so they are declared here and filled in by
 * `page-speed.ts`, which owns the browser.
 */
export interface RoundDriverState {
  round: number;
  url: string;
  finalUrl?: string;
  clickedRowKey?: string | null;
  /**
   * Time origin this round's numbers are relative to: 0 for a cold round, the
   * in-page click timestamp for a warm one. Persisted because the 09-27 baseline
   * could not be re-based after the fact — `clickT` was never written down
   * (MUL-395 `cmt_3zf9gx474mh8` §4.3).
   */
  navStartMs: number;
  /** Raw in-page click timestamp, or null for a cold round. */
  clickT: number | null;
  /** Milliseconds from arriving on the entry page to finding the target row. */
  entryReadyMs: number | null;
  /** API requests still in flight at the click, or null when there was no click. */
  entryInflightAtClick: number | null;
  /**
   * Whether the entry page was quiet before the click. Null when the rule was
   * off or the round had no click; false when the 5s cap expired and the click
   * went ahead anyway.
   */
  entrySettled: boolean | null;
  /** Writes the guard stopped. Always aborted, never sent. */
  blockedWrites: number;
  /** Writes the allow-list fulfilled inside the browser (see lib/stub-writes). */
  stubbedWrites: number;
  /** Milliseconds from the click to the URL committing `?issue=`; null when N/A. */
  urlCommitMs: number | null;
  /** Text of the row the warm click targeted, for post-hoc attribution. */
  clickedRowText: string | null;
  /** True when the browser's first page had to have the target injected. */
  inboxInjected: boolean;
  /** GET `/api/inbox/page` responses served before the first stubbed write. */
  inboxPageRequestsBeforeStub: number | null;
  timelineRequests: number;
  targetIndexFromLatest: number | null;
  /** Set when the round never left its entry page, so it is a skip not a timeout. */
  entryFailed: boolean;
  /** Largest Contentful Paint from the page's own PerformanceObserver. */
  lcpMs: number | null;
  error?: string;
}

/** One measured round: the derived numbers plus the driver's own state. */
export type RoundMeasurement = RoundComputation & RoundDriverState & Partial<RenderMeasurement> & { ssrSeed?: boolean; ssrSeedSource?: string };

/**
 * The persistence projection of one round.
 *
 * Every field the driver records has to survive into the JSON, because the
 * artifact is the only evidence a later comparison has: the 09-27 baseline
 * stored neither `navStartMs` nor a per-request table, so the warm rows could
 * not be re-based or attributed after the run (MUL-395 §4.3).
 */
export function roundSummary(round: RoundMeasurement): ReportRoundSummary {
  return {
    round: round.round,
    navStartMs: round.navStartMs,
    clickT: round.clickT,
    readyMs: round.readyMs,
    renderMs: round.renderMs,
    renderSource: round.renderSource,
    renderReason: round.renderReason,
    windowResponseEndMs: round.windowResponseEndMs,
    ssrSeed: round.ssrSeed,
    ssrSeedSource: round.ssrSeedSource,
    readyTimeout: round.readyTimeout,
    firstRealMs: round.firstRealMs,
    firstRealKeys: round.firstRealKeys,
    observedFrames: round.observedFrames,
    finalUrl: round.finalUrl,
    clickedRowKey: round.clickedRowKey,
    anchorVisibleMs: round.anchorVisibleMs,
    anchorName: round.anchorName,
    anchorRule: round.anchorRule,
    appReadyMs: round.appReadyMs,
    appReadyForced: round.appReadyForced,
    dataFreshAtReady: round.dataFreshAtReady,
    jumpCount: round.jumpCount,
    jumpPx: round.jumpPx,
    jumps: round.jumps,
    layoutShiftCount: round.layoutShiftCount,
    cls: round.cls,
    serialDepth: round.serialDepth,
    serialChain: round.serialChain,
    apiCallsTotal: round.apiCallsTotal,
    apiFirstScreen: round.apiFirstScreen,
    apiFirstScreenEntries: round.apiFirstScreenEntries,
    chunksLoaded: round.chunksLoaded,
    chunkBytes: round.chunkBytes,
    lcpMs: round.lcpMs,
    slowestServerTotalMs: round.slowestServerTotalMs,
    ...(round.error ? { error: round.error } : null),
    blockedWrites: round.blockedWrites,
    stubbedWrites: round.stubbedWrites,
    urlCommitMs: round.urlCommitMs,
    entryReadyMs: round.entryReadyMs,
    entryInflightAtClick: round.entryInflightAtClick,
    entrySettled: round.entrySettled,
    inboxInjected: round.inboxInjected,
    inboxPageRequestsBeforeStub: round.inboxPageRequestsBeforeStub,
    clickedRowText: round.clickedRowText,
    heapBytes: null,
    anchorRectAtReady: round.anchorRectAtReady,
    // Only the deep link has a target inside the timeline; every other scenario
    // leaves both fields at zero/null so the JSON shape stays uniform.
    targetDepth: {
      timelineRequests: round.timelineRequests,
      targetIndexFromLatest: round.targetIndexFromLatest,
    },
    selectorEquivalence: round.selectorEquivalence,
  };
}
