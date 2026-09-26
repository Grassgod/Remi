#!/usr/bin/env bun
/**
 * Jump recorder for the MUL-383 page-speed probe (MUL-384 S1).
 *
 * Two halves in one file, so the CI check (S7) can import it from the repository
 * root with plain relative imports:
 *
 *  1. `installJumpRecorder` runs inside the page, installed through
 *     `context.addInitScript`. It samples the DOM every animation frame and
 *     keeps the raw material in `window.__mul383Recorder`.
 *  2. The exported pure functions post-process that buffer on the Node side:
 *     first real content, jumps, the ready window, LayoutShift summaries,
 *     request waves / serial depth, `data-perf-state` timing and percentiles.
 *
 * The browser half is serialised by Playwright, so it must not reference module
 * scope: every helper it needs is declared inside, and all inputs arrive through
 * the config argument.
 *
 * DOM contract (prose version lives in `docs/dev/performance.md`):
 *  - `data-perf-scroll`  measured viewport (issue detail / chat)
 *  - `data-perf-item`    row holding real data; skeletons never carry it
 *  - `data-perf-key`     stable key for that row
 *  - `data-perf-anchor`  terminal element (`latest-comment`, `target-comment`, ...)
 *  - `data-perf-state`   written by S2's reveal hook; recorded here, never a terminal condition
 *
 * Read-only: nothing in this module mutates the measured page.
 */

import type { Page } from "@playwright/test";

/** Global the browser half installs; also read by the Node-side helpers. */
export const RECORDER_GLOBAL = "__mul383Recorder";

/** A frame counts as movement above this, absorbing sub-pixel rounding. */
export const JUMP_THRESHOLD_PX = 1;

/** A ready window is the first rule-satisfying frame followed by this much quiet. */
export const READY_QUIET_MS = 500;

/** A request started within this of a predecessor's end is treated as its successor. */
export const WAVE_TOLERANCE_MS = 8;

/** One round gives up after this long (MUL-367 used 60s, too slow for a peak window). */
export const ROUND_TIMEOUT_MS = 20_000;

/** Element budget per frame, shared by every profile sampled on that frame. */
export const MAX_ROWS_PER_FRAME = 60;

export type PerfProfileName = "contract" | "legacy";

/** How an anchor counts as on-screen: `contained` needs the whole rect, `top-visible` its top edge. */
export type AnchorVisibility = "contained" | "top-visible";

export interface PerfAnchorSpec {
  /** Reported name, e.g. `latest-comment`. */
  name: string;
  selector: string;
  /** `last` walks DOM order and keeps the final match (legacy anchors have no attribute to key on). */
  pick: "first" | "last";
  visibility: AnchorVisibility;
}

export type PerfReadyRule =
  | { kind: "anchor"; anchors: string[]; any?: boolean }
  | { kind: "heading" }
  | { kind: "items" };

export interface PerfProfileConfig {
  name: PerfProfileName;
  /** Measured viewport. */
  scrollRoot: string;
  /** Real data rows, evaluated inside the scroll root. Empty string disables row sampling. */
  items: string;
  /** Skeleton placeholder, evaluated inside the scroll root. */
  skeleton: string;
  anchors: PerfAnchorSpec[];
  rule: PerfReadyRule;
}

export interface PerfRecorderConfig {
  profiles: PerfProfileConfig[];
  maxRows?: number;
}

export interface PerfFrameItem {
  key: string;
  elId: number;
  /** Element rect top / bottom relative to the scroll root's top edge. */
  top: number;
  bottom: number;
}

export interface PerfFrameAnchor {
  name: string;
  elId: number | null;
  top: number | null;
  bottom: number | null;
  /** Entire rect inside the viewport (1px tolerance). */
  contained: boolean;
  /** Top edge inside the viewport: the deep-link rule for a target taller than the screen. */
  topVisible: boolean;
}

export interface PerfProfileFrame {
  rootFound: boolean;
  rootId: number | null;
  rootHeight: number;
  scrollTop: number | null;
  scrollHeight: number | null;
  skeletons: number;
  heading: string | null;
  items: PerfFrameItem[];
  anchors: PerfFrameAnchor[];
  /** `data-perf-state` on the scroll root, or null while absent. */
  state: string | null;
}

export interface PerfFrame {
  /** `performance.now()` at sampling time. */
  t: number;
  profiles: Partial<Record<PerfProfileName, PerfProfileFrame>>;
  /** Browser-side readiness verdict for that frame; the Node side recomputes it. */
  satisfied?: Partial<Record<PerfProfileName, boolean>>;
}

export interface PerfLayoutShift {
  t: number;
  value: number;
  hadRecentInput: boolean;
  /** Nearest `data-perf-item` / `data-perf-anchor` label per source node. */
  sources: string[];
}

export interface PerfClick {
  /** `performance.now()` of the click. */
  t: number;
  /** `a[href]` target, absolute when available. */
  href: string | null;
  label: string;
}

export interface PerfStateTransition {
  t: number;
  value: string;
}

export interface PerfRecorderBuffer {
  startedAt: number;
  stopped: boolean;
  frames: PerfFrame[];
  shifts: PerfLayoutShift[];
  clicks: PerfClick[];
  stateTransitions: PerfStateTransition[];
  errors: string[];
}

/** Compact per-poll view of one profile. The driver waits on this. */
export interface PerfProfileSummary {
  name: PerfProfileName;
  rootFound: boolean;
  skeletons: number;
  heading: string | null;
  itemCount: number;
  visibleItems: number;
  /** Rule currently holds (anchor on screen, skeleton-free). */
  satisfied: boolean;
  /** Start of the current unbroken rule-satisfying run. */
  satisfiedSinceT: number | null;
  /** Set when the current run has already lasted `READY_QUIET_MS`. */
  ready: boolean;
  readyMs: number | null;
  firstRealItemT: number | null;
  lastMoveT: number | null;
  lastUnsatisfiedT: number | null;
  state: string | null;
}

export interface PerfRecorderSummary {
  /** `performance.now()` of the newest sampled frame. */
  t: number;
  frameCount: number;
  stopped: boolean;
  profiles: Record<string, PerfProfileSummary>;
}

// ── Browser half (runs inside the page) ──────────────────────────────────────

/**
 * Installs the recorder. Pass this function itself to `addInitScript`:
 *
 *   await context.addInitScript(installJumpRecorder, config);
 *
 * Self-contained by design: Playwright serialises the source, so nothing here
 * may reference module scope.
 */
export function installJumpRecorder(config: PerfRecorderConfig): void {
  type Item = { key: string; elId: number; top: number; bottom: number };
  type Anchor = {
    name: string;
    elId: number | null;
    top: number | null;
    bottom: number | null;
    contained: boolean;
    topVisible: boolean;
  };
  type Profile = {
    rootFound: boolean;
    rootId: number | null;
    rootHeight: number;
    scrollTop: number | null;
    scrollHeight: number | null;
    skeletons: number;
    heading: string | null;
    items: Item[];
    anchors: Anchor[];
    state: string | null;
  };
  type Frame = { t: number; profiles: Record<string, Profile>; satisfied: Record<string, boolean> };
  type Shift = { t: number; value: number; hadRecentInput: boolean; sources: string[] };
  type Click = { t: number; href: string | null; label: string };
  type Transition = { t: number; value: string };

  const MAX_ROWS = typeof config.maxRows === "number" && config.maxRows > 0 ? config.maxRows : 60;
  const THRESHOLD_PX = 1;
  const QUIET_MS = 500;
  const MAX_FRAMES = 6000;

  const w = window as unknown as {
    __mul383Recorder?: Record<string, unknown>;
    __mul383ElIds?: WeakMap<Element, number>;
    requestAnimationFrame?: (cb: (t: number) => void) => number;
  };

  const elIds: WeakMap<Element, number> = w.__mul383ElIds ?? new WeakMap<Element, number>();
  w.__mul383ElIds = elIds;
  let nextElId = 1;
  const idOf = (el: Element): number => {
    const existing = elIds.get(el);
    if (existing !== undefined) return existing;
    const id = nextElId++;
    elIds.set(el, id);
    return id;
  };

  const state = {
    startedAt: performance.now(),
    stopped: false,
    frames: [] as Frame[],
    shifts: [] as Shift[],
    clicks: [] as Click[],
    stateTransitions: [] as Transition[],
    errors: [] as string[],
  };

  const labelFor = (node: Element | null): string => {
    if (!node) return "unknown";
    const item = node.closest("[data-perf-item]");
    if (item) return `item:${item.getAttribute("data-perf-key") ?? item.getAttribute("data-perf-item") ?? "?"}`;
    const anchor = node.closest("[data-perf-anchor]");
    if (anchor) return `anchor:${anchor.getAttribute("data-perf-anchor") ?? "?"}`;
    return "other";
  };

  const isVisible = (el: Element): boolean => {
    const check = (el as unknown as { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    if (typeof check === "function") {
      try {
        return check.call(el, { visibilityProperty: true });
      } catch {
        return true;
      }
    }
    return el.getClientRects().length > 0;
  };

  // One rect cache per frame: contract and legacy profiles usually point at the
  // same nodes, and re-reading a rect is the expensive half of sampling.
  let rectCache = new WeakMap<Element, { top: number; bottom: number }>();

  const ruleSatisfied = (profile: PerfProfileConfig, view: Profile): boolean => {
    if (!view.rootFound || view.skeletons > 0) return false;
    if (profile.rule.kind === "heading") return !!view.heading;
    if (profile.rule.kind === "items") {
      return view.items.some((item) => item.top < view.rootHeight && item.bottom > 0);
    }
    const verdicts = profile.rule.anchors.map((name) => {
      const spec = profile.anchors.find((candidate) => candidate.name === name);
      const anchor = view.anchors.find((candidate) => candidate.name === name);
      if (!spec || !anchor) return false;
      return anchorOk(spec, anchor, view.rootHeight);
    });
    return profile.rule.any === false ? verdicts.every(Boolean) : verdicts.some(Boolean);
  };

  // An anchor counts as on screen when its whole rect is visible. A target
  // taller than the viewport can never satisfy that, so the plan's exception
  // applies: its top edge being visible is the strongest reachable state.
  // Keep in sync with `anchorSatisfied` on the Node side.
  const anchorOk = (spec: PerfAnchorSpec, anchor: Anchor, rootHeight: number): boolean => {
    if (spec.visibility === "top-visible") return anchor.topVisible;
    if (anchor.contained) return true;
    const height = (anchor.bottom ?? 0) - (anchor.top ?? 0);
    return height > rootHeight && anchor.topVisible;
  };

  const sample = (): void => {
    const t = performance.now();
    const rects = rectCache;
    rectCache = new WeakMap<Element, { top: number; bottom: number }>();
    const profiles: Record<string, Profile> = {};
    const satisfied: Record<string, boolean> = {};
    let budget = MAX_ROWS;

    for (const profile of config.profiles) {
      const root = document.querySelector(profile.scrollRoot) as HTMLElement | null;
      const entry: Profile = {
        rootFound: !!root,
        rootId: root ? idOf(root) : null,
        rootHeight: root ? Math.round(root.getBoundingClientRect().height * 10) / 10 : 0,
        scrollTop: root ? Math.round(root.scrollTop * 10) / 10 : null,
        scrollHeight: root ? Math.round(root.scrollHeight * 10) / 10 : null,
        skeletons: root ? root.querySelectorAll(profile.skeleton).length : 0,
        heading: root ? ((root.querySelector("h1")?.textContent ?? "").trim() || null) : null,
        items: [],
        anchors: [],
        state: root ? root.getAttribute("data-perf-state") : null,
      };

      const rootTop = root ? root.getBoundingClientRect().top : 0;
      const rectOf = (el: Element): { top: number; bottom: number } => {
        const cached = rects.get(el);
        if (cached) return cached;
        const rect = el.getBoundingClientRect();
        const value = {
          top: Math.round((rect.top - rootTop) * 10) / 10,
          bottom: Math.round((rect.bottom - rootTop) * 10) / 10,
        };
        rects.set(el, value);
        return value;
      };

      if (root && profile.items && budget > 0) {
        for (const row of root.querySelectorAll(profile.items)) {
          if (entry.items.length >= budget) break;
          if (!isVisible(row)) continue;
          const rect = rectOf(row);
          entry.items.push({
            key: row.getAttribute("data-perf-key") || row.id || `el:${idOf(row)}`,
            elId: idOf(row),
            top: rect.top,
            bottom: rect.bottom,
          });
        }
        budget -= entry.items.length;
      }

      for (const spec of profile.anchors) {
        const matches = root ? root.querySelectorAll(spec.selector) : [];
        const el = matches.length === 0
          ? null
          : spec.pick === "last"
            ? matches[matches.length - 1]!
            : matches[0]!;
        if (!el || !root) {
          entry.anchors.push({
            name: spec.name,
            elId: null,
            top: null,
            bottom: null,
            contained: false,
            topVisible: false,
          });
          continue;
        }
        const rect = rectOf(el);
        entry.anchors.push({
          name: spec.name,
          elId: idOf(el),
          top: rect.top,
          bottom: rect.bottom,
          contained: rect.top >= -1 && rect.bottom <= entry.rootHeight + 1,
          topVisible: rect.top >= -1 && rect.top <= entry.rootHeight + 1 && rect.bottom > 0,
        });
      }

      satisfied[profile.name] = ruleSatisfied(profile, entry);
      profiles[profile.name] = entry;
    }

    state.frames.push({ t, profiles, satisfied });
    if (state.frames.length > MAX_FRAMES) state.frames.shift();
  };

  /** Rows shared by two frames moved more than 1px, or the scroll position did. */
  const frameMoved = (previous: Profile, current: Profile): boolean => {
    const before = new Map<string, number>();
    for (const item of previous.items) before.set(`${item.key}:${item.elId}`, item.top);
    let dTop = 0;
    for (const item of current.items) {
      const previousTop = before.get(`${item.key}:${item.elId}`);
      if (previousTop === undefined) continue;
      dTop = Math.max(dTop, Math.abs(item.top - previousTop));
    }
    if (dTop > THRESHOLD_PX) return true;
    return Math.abs((current.scrollTop ?? 0) - (previous.scrollTop ?? 0)) > THRESHOLD_PX;
  };

  const summary = (): {
    t: number;
    frameCount: number;
    stopped: boolean;
    profiles: Record<string, PerfProfileSummary>;
  } => {
    const out: Record<string, PerfProfileSummary> = {};
    for (const profile of config.profiles) {
      let firstRealItemT: number | null = null;
      let lastMoveT: number | null = null;
      let lastUnsatisfiedT: number | null = null;
      let satisfiedSinceT: number | null = null;
      let previous: Profile | null = null;
      let lastProfile: Profile | null = null;

      for (const frame of state.frames) {
        const current = frame.profiles[profile.name];
        if (!current) continue;
        lastProfile = current;
        const isSatisfied = frame.satisfied[profile.name] === true;
        if (!isSatisfied) {
          lastUnsatisfiedT = frame.t;
          satisfiedSinceT = null;
          previous = current;
          continue;
        }
        if (satisfiedSinceT === null) {
          satisfiedSinceT = frame.t;
        } else if (previous && firstRealItemT !== null && frameMoved(previous, current)) {
          // A move restarts the quiet window: `readyMs` is the start of the
          // window that survived, not the first moment the rule held.
          satisfiedSinceT = frame.t;
        }
        if (firstRealItemT === null && current.items.some((item) => item.top < current.rootHeight && item.bottom > 0)) {
          firstRealItemT = frame.t;
        }
        if (previous && firstRealItemT !== null && frameMoved(previous, current)) lastMoveT = frame.t;
        previous = current;
      }

      const newestT = state.frames.length > 0 ? state.frames[state.frames.length - 1]!.t : performance.now();
      const ready = satisfiedSinceT !== null && newestT - satisfiedSinceT >= QUIET_MS;
      out[profile.name] = {
        name: profile.name,
        rootFound: lastProfile?.rootFound ?? false,
        skeletons: lastProfile?.skeletons ?? 0,
        heading: lastProfile?.heading ?? null,
        itemCount: lastProfile?.items.length ?? 0,
        visibleItems: lastProfile
          ? lastProfile.items.filter((item) => item.top < lastProfile.rootHeight && item.bottom > 0).length
          : 0,
        satisfied: lastProfile ? ruleSatisfied(profile, lastProfile) : false,
        satisfiedSinceT,
        ready,
        readyMs: ready ? satisfiedSinceT : null,
        firstRealItemT,
        lastMoveT,
        lastUnsatisfiedT,
        state: lastProfile?.state ?? null,
      };
    }
    return {
      t: state.frames.length > 0 ? state.frames[state.frames.length - 1]!.t : performance.now(),
      frameCount: state.frames.length,
      stopped: state.stopped,
      profiles: out,
    };
  };

  let shiftObserver: PerformanceObserver | null = null;
  let stateObserver: MutationObserver | null = null;

  try {
    shiftObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value?: number;
          hadRecentInput?: boolean;
          sources?: Array<{ node?: Node | null }>;
        };
        state.shifts.push({
          t: Math.round(entry.startTime * 10) / 10,
          value: typeof shift.value === "number" ? shift.value : 0,
          hadRecentInput: shift.hadRecentInput === true,
          sources: (shift.sources ?? [])
            .map((source) => (source.node && source.node.nodeType === 1 ? labelFor(source.node as Element) : null))
            .filter((value): value is string => typeof value === "string"),
        });
      }
    });
    shiftObserver.observe({ type: "layout-shift", buffered: true });
  } catch (error) {
    state.errors.push(`layout-shift observer: ${(error as Error).message}`);
  }

  try {
    stateObserver = new MutationObserver((records) => {
      for (const record of records) {
        const value = (record.target as Element).getAttribute("data-perf-state");
        if (value === null) continue;
        const last = state.stateTransitions[state.stateTransitions.length - 1];
        if (last && last.value === value) continue;
        state.stateTransitions.push({ t: Math.round(performance.now() * 10) / 10, value });
      }
    });
    // `addInitScript` runs at document-start, where `documentElement` can still
    // be null; observing a missing node throws and would silently disable the
    // whole `data-perf-state` path.
    const startObserving = (): void => {
      const target = document.documentElement ?? document.body;
      if (!target || !stateObserver) return;
      stateObserver.observe(target, {
        attributes: true,
        attributeFilter: ["data-perf-state"],
        subtree: true,
      });
    };
    startObserving();
    if (!document.documentElement) {
      document.addEventListener("readystatechange", startObserving, { once: true });
    }
    // A back-navigation can arrive with the attribute already set, so seed the
    // list from the current DOM as well.
    for (const el of document.querySelectorAll("[data-perf-state]")) {
      const value = el.getAttribute("data-perf-state");
      if (value) state.stateTransitions.push({ t: Math.round(performance.now() * 10) / 10, value });
    }
  } catch (error) {
    state.errors.push(`state observer: ${(error as Error).message}`);
  }

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      const link = (target?.closest?.("a[href]") ?? null) as HTMLAnchorElement | null;
      const button = target?.closest?.('[role="button"],button') ?? null;
      const el = link ?? button;
      if (!el) return;
      state.clicks.push({
        t: Math.round(performance.now() * 10) / 10,
        href: link ? link.href : null,
        label: (el.textContent ?? "").trim().slice(0, 60),
      });
    },
    true,
  );

  let rafHandle = 0;
  let lastSampleT = performance.now();
  const tick = (): void => {
    try {
      if (!state.stopped) sample();
    } catch (error) {
      state.errors.push(`sample: ${(error as Error).message}`);
    }
    lastSampleT = performance.now();
    rafHandle = requestAnimationFrame(tick);
  };

  try {
    rafHandle = requestAnimationFrame(tick);
  } catch {
    rafHandle = 0;
  }

  // If rAF stops (hidden tab, throttled renderer), a timer keeps the buffer
  // moving. The 100ms guard is generous so a busy frame cannot switch modes.
  const intervalHandle = window.setInterval(() => {
    if (performance.now() - lastSampleT <= 100) return;
    try {
      if (!state.stopped) sample();
    } catch (error) {
      state.errors.push(`interval sample: ${(error as Error).message}`);
    }
    lastSampleT = performance.now();
  }, 100);

  w.__mul383Recorder = {
    startedAt: state.startedAt,
    stop: () => {
      state.stopped = true;
    },
    resume: () => {
      state.stopped = false;
    },
    reset: (visibleFrom?: number) => {
      state.frames = [];
      state.shifts = [];
      state.clicks = [];
      state.stateTransitions = [];
      state.errors = [];
      state.stopped = false;
      state.startedAt = typeof visibleFrom === "number" ? visibleFrom : performance.now();
      lastSampleT = performance.now();
    },
    summary,
    read: () => ({
      startedAt: state.startedAt,
      stopped: state.stopped,
      frames: state.frames,
      shifts: state.shifts,
      clicks: state.clicks,
      stateTransitions: state.stateTransitions,
      errors: state.errors,
    }),
    teardown: () => {
      state.stopped = true;
      if (rafHandle) cancelAnimationFrame(rafHandle);
      window.clearInterval(intervalHandle);
      shiftObserver?.disconnect();
      stateObserver?.disconnect();
    },
  };
}

// ── Node half: driver helpers ────────────────────────────────────────────────

/** Installs the recorder for every document this context creates. */
export async function installRecorderOnContext(
  context: { addInitScript: (script: unknown, arg?: unknown) => Promise<void> },
  config: PerfRecorderConfig,
): Promise<void> {
  await context.addInitScript(installJumpRecorder, config);
}

export async function resetRecorder(page: Page, visibleFrom?: number): Promise<void> {
  await page.evaluate(
    ([name, from]) => {
      const recorder = (window as unknown as Record<string, { reset?: (t?: number) => void }>)[name as string];
      recorder?.reset?.(typeof from === "number" ? from : undefined);
    },
    [RECORDER_GLOBAL, visibleFrom ?? null] as const,
  );
}

/** Stops sampling, so reading the buffer is one serialisation instead of a moving target. */
/** Clears the buffer and returns the page's own timestamp for the new window. */
export async function resetRecorderAt(page: Page): Promise<number> {
  return page.evaluate((name) => {
    const recorder = (window as unknown as Record<string, { reset?: (t?: number) => void }>)[name];
    recorder?.reset?.();
    return performance.now();
  }, RECORDER_GLOBAL);
}

export async function freezeRecorder(page: Page): Promise<void> {
  await page.evaluate((name) => {
    (window as unknown as Record<string, { stop?: () => void }>)[name]?.stop?.();
  }, RECORDER_GLOBAL);
}

export async function resumeRecorder(page: Page): Promise<void> {
  await page.evaluate((name) => {
    (window as unknown as Record<string, { resume?: () => void }>)[name]?.resume?.();
  }, RECORDER_GLOBAL);
}

export async function readRecorderSummary(page: Page): Promise<PerfRecorderSummary | null> {
  return page.evaluate(
    (name) =>
      (window as unknown as Record<string, { summary?: () => PerfRecorderSummary }>)[name]?.summary?.() ?? null,
    RECORDER_GLOBAL,
  );
}

export async function readRecorder(page: Page): Promise<PerfRecorderBuffer | null> {
  return page.evaluate(
    (name) =>
      (window as unknown as Record<string, { read?: () => PerfRecorderBuffer }>)[name]?.read?.() ?? null,
    RECORDER_GLOBAL,
  );
}

export async function teardownRecorder(page: Page): Promise<void> {
  await page
    .evaluate((name) => {
      (window as unknown as Record<string, { teardown?: () => void }>)[name]?.teardown?.();
    }, RECORDER_GLOBAL)
    .catch(() => {});
}

// ── Node half: pure post-processing ─────────────────────────────────────────

/**
 * Nearest-rank percentile, the convention used by `request-metrics.ts` and the
 * other baseline scripts. Null for an empty sample, so the report can tell "no
 * data" apart from 0 ms.
 */
export function nearestRankPercentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export function round1(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
}

function orderedFrames(frames: PerfFrame[]): PerfFrame[] {
  return frames.length === 0 ? [] : [...frames].sort((left, right) => left.t - right.t);
}

/** First frame holding at least one real row intersecting the viewport. */
export function computeFirstRealMs(frames: PerfFrame[], profile: PerfProfileName): number | null {
  for (const frame of orderedFrames(frames)) {
    const view = frame.profiles[profile];
    if (!view || !view.rootFound) continue;
    if (view.items.some((item) => item.top < view.rootHeight && item.bottom > 0)) return frame.t;
  }
  return null;
}

/** Rows present in both frames, keyed by key+element so a recycled row never pairs up. */
function sharedRows(previous: PerfProfileFrame, current: PerfProfileFrame): Array<{ before: number; after: number }> {
  const before = new Map<string, number>();
  for (const item of previous.items) before.set(`${item.key}:${item.elId}`, item.top);
  const pairs: Array<{ before: number; after: number }> = [];
  for (const item of current.items) {
    const previousTop = before.get(`${item.key}:${item.elId}`);
    if (previousTop === undefined) continue;
    pairs.push({ before: previousTop, after: item.top });
  }
  return pairs;
}

/**
 * A frame "moved" when a row present in both frames shifted more than
 * `thresholdPx`, or the scroll position itself moved that far. Scrolling counts
 * because it moves every visible row on screen; `computeJumps` then separates
 * the two contributions by `kind`.
 */
export function frameMoved(
  previous: PerfProfileFrame,
  current: PerfProfileFrame,
  thresholdPx: number = JUMP_THRESHOLD_PX,
): boolean {
  const dTop = sharedRows(previous, current).reduce(
    (max, pair) => Math.max(max, Math.abs(pair.after - pair.before)),
    0,
  );
  if (dTop > thresholdPx) return true;
  return Math.abs((current.scrollTop ?? 0) - (previous.scrollTop ?? 0)) > thresholdPx;
}

export interface PerfJump {
  startMs: number;
  endMs: number;
  /** Summed row movement inside this run of moving frames. */
  px: number;
  /** Summed scroll movement inside the same run. */
  scrollPx: number;
  kind: "scroll" | "content";
  frames: number;
}

export interface PerfJumpResult {
  jumps: PerfJump[];
  jumpCount: number;
  jumpPx: number;
  jumpScrollPx: number;
}

/**
 * One jump = one run of consecutive moving frames, so a smooth scroll is a
 * single jump whose `px` is the total travel rather than one entry per frame.
 */
export function computeJumps(
  frames: PerfFrame[],
  options: {
    profile: PerfProfileName;
    fromMs: number | null;
    toMs?: number | null;
    thresholdPx?: number;
  },
): PerfJumpResult {
  const ordered = orderedFrames(frames);
  const threshold = options.thresholdPx ?? JUMP_THRESHOLD_PX;
  const jumps: PerfJump[] = [];
  if (options.fromMs === null) return { jumps, jumpCount: 0, jumpPx: 0, jumpScrollPx: 0 };
  const toMs = options.toMs ?? Number.POSITIVE_INFINITY;

  let active: PerfJump | null = null;
  for (let i = 1; i < ordered.length; i++) {
    const previousView = ordered[i - 1]!.profiles[options.profile];
    const currentView = ordered[i]!.profiles[options.profile];
    const currentT = ordered[i]!.t;
    if (!previousView || !currentView) continue;
    if (currentT < options.fromMs || currentT > toMs) continue;
    const dTop = sharedRows(previousView, currentView).reduce(
      (max, pair) => Math.max(max, Math.abs(pair.after - pair.before)),
      0,
    );
    const dScroll = Math.abs((currentView.scrollTop ?? 0) - (previousView.scrollTop ?? 0));
    if (dTop <= threshold && dScroll <= threshold) {
      if (active) {
        jumps.push(active);
        active = null;
      }
      continue;
    }
    if (active) {
      active.endMs = currentT;
      active.px += dTop;
      active.scrollPx += dScroll;
      active.frames += 1;
    } else {
      active = { startMs: currentT, endMs: currentT, px: dTop, scrollPx: dScroll, kind: "content", frames: 1 };
    }
  }
  if (active) jumps.push(active);
  for (const jump of jumps) {
    jump.px = Math.round(jump.px * 10) / 10;
    jump.scrollPx = Math.round(jump.scrollPx * 10) / 10;
    jump.kind = jump.scrollPx >= jump.px / 2 ? "scroll" : "content";
  }
  return {
    jumps,
    jumpCount: jumps.length,
    jumpPx: Math.round(jumps.reduce((sum, jump) => sum + jump.px, 0) * 10) / 10,
    jumpScrollPx: Math.round(jumps.reduce((sum, jump) => sum + jump.scrollPx, 0) * 10) / 10,
  };
}

export interface PerfReadyResult {
  /** Start of the quiet window that survived to the end of the sample. */
  readyMs: number | null;
  /** First moment the rule held, before the quiet wait. */
  anchorVisibleMs: number | null;
  /** Which anchor name satisfied the rule at `anchorVisibleMs`. */
  anchorName: string | null;
  readyTimeout: boolean;
}

/**
 * Is this anchor on screen? A whole rect inside the viewport, or — for a target
 * taller than the viewport, which can never be contained — its top edge. Mirrors
 * the browser half so both agree on the same frame.
 */
export function anchorSatisfied(spec: PerfAnchorSpec, anchor: PerfFrameAnchor, rootHeight: number): boolean {
  if (spec.visibility === "top-visible") return anchor.topVisible;
  if (anchor.contained) return true;
  const height = (anchor.bottom ?? 0) - (anchor.top ?? 0);
  return height > rootHeight && anchor.topVisible;
}

/** Rules resolved against one frame: which anchors pass, and whether the rule as a whole holds. */
export function evaluateRule(
  frame: PerfFrame,
  profile: PerfProfileConfig,
): { satisfied: boolean; anchorName: string | null } {
  const view = frame.profiles[profile.name];
  if (!view || !view.rootFound || view.skeletons > 0) return { satisfied: false, anchorName: null };
  if (profile.rule.kind === "heading") {
    return { satisfied: !!view.heading, anchorName: null };
  }
  if (profile.rule.kind === "items") {
    return {
      satisfied: view.items.some((item) => item.top < view.rootHeight && item.bottom > 0),
      anchorName: null,
    };
  }
  let satisfied = false;
  let anchorName: string | null = null;
  for (const name of profile.rule.anchors) {
    const spec = profile.anchors.find((candidate) => candidate.name === name);
    const anchor = view.anchors.find((candidate) => candidate.name === name);
    const passes = !!spec && !!anchor && anchorSatisfied(spec, anchor, view.rootHeight);
    if (passes && anchorName === null) anchorName = name;
    satisfied = satisfied || passes;
  }
  if (profile.rule.any === false) {
    const all = profile.rule.anchors.every((name) => {
      const spec = profile.anchors.find((candidate) => candidate.name === name);
      const anchor = view.anchors.find((candidate) => candidate.name === name);
      return !!spec && !!anchor && anchorSatisfied(spec, anchor, view.rootHeight);
    });
    return { satisfied: all, anchorName };
  }
  return { satisfied, anchorName };
}

/**
 * The ready window: the start of the first unbroken run of rule-satisfying
 * frames that lasts `quietMs` without a moving frame. A page that jumps right
 * after first paint therefore reports the later, settled time; the window
 * restarts after every move.
 */
export function computeReadyWindow(
  frames: PerfFrame[],
  options: {
    profile: PerfProfileConfig;
    quietMs?: number;
    firstRealMs?: number | null;
  },
): PerfReadyResult {
  const ordered = orderedFrames(frames);
  const quietMs = options.quietMs ?? READY_QUIET_MS;
  const firstRealMs = options.firstRealMs ?? null;

  let anchorVisibleMs: number | null = null;
  let anchorName: string | null = null;
  let satisfiedSinceT: number | null = null;
  let previous: PerfProfileFrame | null = null;

  for (const frame of ordered) {
    const verdict = evaluateRule(frame, options.profile);
    const current = frame.profiles[options.profile.name] ?? null;
    if (anchorVisibleMs === null && verdict.satisfied) {
      anchorVisibleMs = frame.t;
      anchorName = verdict.anchorName;
    }
    if (!verdict.satisfied || !current) {
      satisfiedSinceT = null;
      previous = current;
      continue;
    }
    if (satisfiedSinceT === null) {
      satisfiedSinceT = frame.t;
    } else if (previous) {
      const moved = firstRealMs === null || frame.t >= firstRealMs ? frameMoved(previous, current) : false;
      if (moved) satisfiedSinceT = frame.t;
    }
    previous = current;
  }

  const newestT = ordered.length > 0 ? ordered[ordered.length - 1]!.t : 0;
  if (satisfiedSinceT !== null && newestT - satisfiedSinceT >= quietMs) {
    return { readyMs: satisfiedSinceT, anchorVisibleMs, anchorName, readyTimeout: false };
  }
  return { readyMs: null, anchorVisibleMs, anchorName, readyTimeout: true };
}

export interface PerfLayoutShiftSummary {
  layoutShiftCount: number;
  cls: number;
  entries: PerfLayoutShift[];
}

/** LayoutShift entries after first paint, as a cross-check on the scrollTop sampling. */
export function summarizeLayoutShifts(
  shifts: PerfLayoutShift[],
  options: { fromMs: number | null; toMs?: number | null },
): PerfLayoutShiftSummary {
  const toMs = options.toMs ?? Number.POSITIVE_INFINITY;
  const entries = shifts
    .filter((entry) => !entry.hadRecentInput)
    .filter((entry) => options.fromMs === null || entry.t >= options.fromMs)
    .filter((entry) => entry.t <= toMs)
    .sort((left, right) => left.t - right.t);
  return {
    layoutShiftCount: entries.length,
    cls: Math.round(entries.reduce((sum, entry) => sum + entry.value, 0) * 1000) / 1000,
    entries,
  };
}

export interface PerfWaveEntry {
  /** Index into the caller's entry list; the reported chain uses these. */
  index: number;
  path: string;
  startMs: number;
  responseEndMs: number;
}

export interface PerfWaveRow extends PerfWaveEntry {
  wave: number;
  /** Index of the predecessor that set this wave, or null for a wave-1 request. */
  after: number | null;
}

export interface PerfWaveResult {
  rows: PerfWaveRow[];
  serialDepth: number;
  /** Root-to-deepest indices: the chain that produced `serialDepth`. */
  chain: number[];
}

/**
 * Waves and serial depth for the first-screen request set: a request sits one
 * wave deeper than the latest request that finished before it started, with an
 * 8ms tolerance for browser scheduling jitter.
 */
export function computeWaves(entries: PerfWaveEntry[], toleranceMs: number = WAVE_TOLERANCE_MS): PerfWaveResult {
  const ordered = [...entries].sort((left, right) => left.startMs - right.startMs || left.index - right.index);
  const rows: PerfWaveRow[] = [];
  for (const entry of ordered) {
    let wave = 1;
    let after: number | null = null;
    for (const candidate of rows) {
      if (candidate.responseEndMs <= entry.startMs + toleranceMs && candidate.wave + 1 > wave) {
        wave = candidate.wave + 1;
        after = candidate.index;
      }
    }
    rows.push({ ...entry, wave, after });
  }
  let serialDepth = 0;
  let deepest: PerfWaveRow | null = null;
  for (const row of rows) {
    if (row.wave > serialDepth) {
      serialDepth = row.wave;
      deepest = row;
    }
  }
  const byIndex = new Map(rows.map((row) => [row.index, row]));
  const chain: number[] = [];
  let cursor: PerfWaveRow | null = deepest;
  while (cursor) {
    chain.unshift(cursor.index);
    cursor = cursor.after === null ? null : byIndex.get(cursor.after) ?? null;
  }
  return { rows, serialDepth, chain };
}

export interface PerfAppReadyResult {
  appReadyMs: number | null;
  /** True when the app only ever reached `ready-forced` (S2's fallback path). */
  forced: boolean;
}

/**
 * `appReadyMs` from the `data-perf-state` transitions the MutationObserver
 * recorded. The application owns that attribute; this is a cross-check that is
 * never used as a terminal condition.
 */
export function computeAppReadyMs(transitions: PerfStateTransition[]): PerfAppReadyResult {
  const ordered = [...transitions].sort((left, right) => left.t - right.t);
  const ready = ordered.find((transition) => transition.value === "ready");
  if (ready) return { appReadyMs: ready.t, forced: false };
  const forced = ordered.find((transition) => transition.value === "ready-forced");
  if (forced) return { appReadyMs: forced.t, forced: true };
  return { appReadyMs: null, forced: false };
}

export interface PerfSelectorEquivalence {
  /** Both selector tables resolved to the very same element. */
  scrollRoot: "same" | "differs" | "absent";
  anchor: "same" | "differs" | "absent";
  /** Rows only the contract table found. Push gate: must be 0. */
  itemsContractOnly: number;
  /** Rows only the legacy table found. Push gate: must be 0. */
  itemsLegacyOnly: number;
}

/**
 * Contract-vs-legacy equality on the same DOM, taken at the ready frame so both
 * views describe the same instant. Element identity is what counts (`===`), not
 * selector text.
 */
export function computeSelectorEquivalence(frame: PerfFrame | null): PerfSelectorEquivalence | null {
  if (!frame) return null;
  const contract = frame.profiles.contract;
  const legacy = frame.profiles.legacy;
  if (!contract || !legacy) return null;

  const scrollRoot = contract.rootId !== null && legacy.rootId !== null
    ? contract.rootId === legacy.rootId
      ? "same"
      : "differs"
    : "absent";

  const contractAnchor = contract.anchors[contract.anchors.length - 1] ?? null;
  const legacyAnchor = legacy.anchors[legacy.anchors.length - 1] ?? null;
  const anchor = contractAnchor?.elId != null && legacyAnchor?.elId != null
    ? contractAnchor.elId === legacyAnchor.elId
      ? "same"
      : "differs"
    : "absent";

  const legacyItems = new Set(legacy.items.map((item) => item.elId));
  const contractItems = new Set(contract.items.map((item) => item.elId));
  return {
    scrollRoot,
    anchor,
    itemsContractOnly: [...contractItems].filter((id) => !legacyItems.has(id)).length,
    itemsLegacyOnly: [...legacyItems].filter((id) => !contractItems.has(id)).length,
  };
}

/** Frame at (or immediately before) the requested timestamp. */
export function frameAt(frames: PerfFrame[], t: number | null): PerfFrame | null {
  if (t === null || frames.length === 0) return null;
  let best: PerfFrame | null = null;
  for (const frame of orderedFrames(frames)) {
    if (frame.t > t) break;
    best = frame;
  }
  return best;
}

export interface PerfScenarioRound {
  readyMs: number | null;
  readyTimeout: boolean;
  firstRealMs: number | null;
  jumpCount: number;
  jumpPx: number;
  serialDepth: number | null;
  apiCallsTotal: number | null;
  slowestServerTotalMs: number | null;
}

export interface PerfScenarioStats {
  n: number;
  /** Rounds whose ready wait timed out; excluded from every percentile. */
  timeouts: number;
  readyP50: number | null;
  readyP75: number | null;
  readyP95: number | null;
  readyMax: number | null;
  firstRealP50: number | null;
  jumpsMax: number | null;
  jumpPxMax: number | null;
  serialDepthMax: number | null;
  apiFirstScreenP50: number | null;
  slowestServerTotalP50: number | null;
}

/**
 * Per-scenario stats. Timed-out rounds stay in the detail rows but never enter a
 * percentile — a 20s timeout is a censored observation, not a measurement.
 */
export function computeScenarioStats(rounds: PerfScenarioRound[]): PerfScenarioStats {
  const ready = rounds.map((round) => round.readyMs).filter((value): value is number => value !== null);
  const firstReal = rounds.map((round) => round.firstRealMs).filter((value): value is number => value !== null);
  const serialDepths = rounds.map((round) => round.serialDepth).filter((value): value is number => value !== null);
  const apiCounts = rounds.map((round) => round.apiCallsTotal).filter((value): value is number => value !== null);
  const serverTotals = rounds
    .map((round) => round.slowestServerTotalMs)
    .filter((value): value is number => value !== null);
  const jumpCounts = rounds.map((round) => round.jumpCount);
  const jumpPx = rounds.map((round) => round.jumpPx);

  return {
    n: rounds.length,
    timeouts: rounds.filter((round) => round.readyTimeout).length,
    readyP50: round1(nearestRankPercentile(ready, 0.5)),
    readyP75: round1(nearestRankPercentile(ready, 0.75)),
    readyP95: round1(nearestRankPercentile(ready, 0.95)),
    readyMax: ready.length > 0 ? round1(Math.max(...ready)) : null,
    firstRealP50: round1(nearestRankPercentile(firstReal, 0.5)),
    jumpsMax: jumpCounts.length > 0 ? Math.max(...jumpCounts) : null,
    jumpPxMax: jumpPx.length > 0 ? Math.max(...jumpPx) : null,
    serialDepthMax: serialDepths.length > 0 ? Math.max(...serialDepths) : null,
    apiFirstScreenP50: round1(nearestRankPercentile(apiCounts, 0.5)),
    slowestServerTotalP50: round1(nearestRankPercentile(serverTotals, 0.5)),
  };
}

export interface PerfComparePair<TRound> {
  key: string;
  mode: string;
  before: TRound | null;
  after: TRound | null;
}

/**
 * `--compare` pairs scenarios by `key + mode`, never by position: a run that
 * skipped a scenario must not shift every later pairing.
 */
export function pairForCompare<TRound extends { key: string; mode: string }>(
  baseline: TRound[],
  current: TRound[],
): PerfComparePair<TRound>[] {
  const pairKey = (round: { key: string; mode: string }): string => `${round.key}::${round.mode}`;
  const before = new Map(baseline.map((round) => [pairKey(round), round]));
  const after = new Map(current.map((round) => [pairKey(round), round]));
  const keys: string[] = [];
  for (const round of baseline) {
    const key = pairKey(round);
    if (!keys.includes(key)) keys.push(key);
  }
  for (const round of current) {
    const key = pairKey(round);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys.map((key) => {
    const [scenarioKey = "", mode = ""] = key.split("::");
    return {
      key: scenarioKey,
      mode,
      before: before.get(key) ?? null,
      after: after.get(key) ?? null,
    };
  });
}
