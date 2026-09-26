// MUL-384: the pure half of the jump recorder drives every number in the
// MUL-383 baseline reports, so its edge cases are pinned here: how frames merge
// into a single jump, the 1px threshold, the 500ms ready window, censored
// rounds, wave tolerance, `data-perf-state` timing and `--compare` pairing.
import { describe, expect, it } from "bun:test";
import {
  anchorSatisfied,
  computeAppReadyMs,
  computeFirstRealMs,
  computeJumps,
  computeReadyWindow,
  computeScenarioStats,
  computeSelectorEquivalence,
  computeWaves,
  frameMoved,
  nearestRankPercentile,
  pairForCompare,
  READY_QUIET_MS,
  WAVE_TOLERANCE_MS,
  type PerfAnchorSpec,
  type PerfFrame,
  type PerfProfileFrame,
  type PerfStateTransition,
} from "../../../frontend/scripts/perf/lib/jump-recorder";
import {
  LEGACY,
  profileFor,
  profilesFor,
  issueRowSelector,
  scrollRootFallbackSelector,
  scrollRootSelector,
} from "../../../frontend/scripts/perf/lib/selectors";

/** One sampled frame with a single visible row at `top`, relative to the scroll root. */
function view(top: number, options: { scrollTop?: number; skeleton?: boolean; key?: string } = {}): PerfProfileFrame {
  return {
    rootFound: true,
    rootId: 1,
    rootHeight: 900,
    scrollTop: options.scrollTop ?? 0,
    scrollHeight: 5000,
    skeletons: options.skeleton ? 1 : 0,
    heading: "MUL-384",
    items: [{ key: options.key ?? "c1", elId: 11, top, bottom: top + 40 }],
    anchors: [
      {
        name: "latest-comment",
        elId: 11,
        top,
        bottom: top + 40,
        contained: top >= -1 && top + 40 <= 901,
        topVisible: top >= -1 && top <= 901,
      },
    ],
    state: null,
  };
}

function frame(t: number, contract: PerfProfileFrame, legacy?: PerfProfileFrame): PerfFrame {
  return { t, profiles: legacy ? { contract, legacy } : { contract } };
}

const issueDetailProfile = profileFor({ mode: "contract", shape: "issue-detail" });

describe("computeJumps", () => {
  it("merges a run of consecutive moving frames into one jump", () => {
    const frames = [
      frame(100, view(0)),
      frame(116, view(50)),
      frame(132, view(100)),
      frame(148, view(150)),
      frame(164, view(150)),
    ];
    const result = computeJumps(frames, { profile: "contract", fromMs: 100 });
    expect(result.jumpCount).toBe(1);
    expect(result.jumps[0]!.startMs).toBe(116);
    expect(result.jumps[0]!.endMs).toBe(148);
    expect(result.jumps[0]!.px).toBe(150);
    expect(result.jumps[0]!.kind).toBe("content");
  });

  it("starts a new jump only after a still frame", () => {
    const frames = [
      frame(100, view(0)),
      frame(116, view(80)),
      frame(132, view(80)),
      frame(148, view(160)),
      frame(164, view(160)),
    ];
    const result = computeJumps(frames, { profile: "contract", fromMs: 100 });
    expect(result.jumpCount).toBe(2);
    expect(result.jumpPx).toBe(160);
  });

  it("ignores movement at or below the 1px threshold", () => {
    expect(frameMoved(view(10), view(11))).toBe(false);
    expect(frameMoved(view(10), view(11.5))).toBe(true);
  });

  it("counts scroll movement as a scroll-kind jump", () => {
    const frames = [
      frame(100, view(100, { scrollTop: 0 })),
      frame(116, view(60, { scrollTop: 40 })),
      frame(132, view(60, { scrollTop: 40 })),
    ];
    const result = computeJumps(frames, { profile: "contract", fromMs: 100 });
    expect(result.jumpCount).toBe(1);
    expect(result.jumps[0]!.kind).toBe("scroll");
    expect(result.jumps[0]!.scrollPx).toBe(40);
  });

  it("measures nothing before first real content", () => {
    const frames = [frame(100, view(600)), frame(116, view(500)), frame(132, view(400))];
    // firstRealMs is the frame at 100 (a row is already on screen), so all of it counts.
    const result = computeJumps(frames, { profile: "contract", fromMs: computeFirstRealMs(frames, "contract") });
    expect(result.jumpCount).toBe(1);
    expect(result.jumpPx).toBe(200);
  });
});

describe("computeFirstRealMs", () => {
  it("waits for a real row, not a heading", () => {
    const frames = [
      frame(100, { ...view(0, { skeleton: true }), items: [] }),
      frame(200, { ...view(0), items: [] }),
      frame(300, view(0)),
    ];
    expect(computeFirstRealMs(frames, "contract")).toBe(300);
  });

  it("counts a frame carrying real rows even while other skeletons remain", () => {
    // `data-perf-item` only ever marks real data, so its presence is enough to
    // start the jump clock; the readiness rule still waits for skeletons to clear.
    const frames = [frame(100, view(0, { skeleton: true }))];
    expect(computeFirstRealMs(frames, "contract")).toBe(100);
  });
});

describe("computeReadyWindow", () => {
  it("takes the start of the 500ms quiet window, after the last move", () => {
    const frames = [
      frame(100, view(200)),
      frame(200, view(600)),
      frame(700, view(600)),
      frame(900, view(600)),
      frame(1150, view(600)),
    ];
    const result = computeReadyWindow(frames, { profile: issueDetailProfile, firstRealMs: 100 });
    expect(result.readyTimeout).toBe(false);
    expect(result.anchorVisibleMs).toBe(100);
    // The 200ms move restarts the window, so 200 — not the first paint at 100 —
    // is the reported time. Frames exist past 200 + 500ms, so the window closed.
    expect(result.readyMs).toBe(200);
    expect(frames[frames.length - 1]!.t).toBeGreaterThanOrEqual(200 + READY_QUIET_MS);
  });

  it("restarts the window when the page moves again", () => {
    const frames = [
      frame(100, view(600)),
      frame(700, view(600)),
      frame(800, view(300)),
      frame(1400, view(300)),
    ];
    const result = computeReadyWindow(frames, { profile: issueDetailProfile, firstRealMs: 100 });
    expect(result.readyMs).toBe(800);
  });

  it("reports a timeout while the anchor never settles", () => {
    const frames = [frame(100, view(0)), frame(120, view(50))];
    const result = computeReadyWindow(frames, { profile: issueDetailProfile, firstRealMs: 100 });
    expect(result.readyTimeout).toBe(true);
    expect(result.readyMs).toBeNull();
  });

  it("waits for skeletons to clear", () => {
    const frames = [
      frame(100, view(600, { skeleton: true })),
      frame(800, view(600)),
      frame(1400, view(600)),
    ];
    const result = computeReadyWindow(frames, { profile: issueDetailProfile, firstRealMs: 800 });
    expect(result.readyMs).toBe(800);
  });
});

/** A row taller than the 900px root used by `view`, at the given position. */
function tallView(top: number, bottom: number): PerfProfileFrame {
  const base = view(top);
  return {
    ...base,
    items: [{ key: "long-comment", elId: 11, top, bottom }],
    anchors: [
      {
        name: "latest-comment",
        elId: 11,
        top,
        bottom,
        contained: top >= -1 && bottom <= 901,
        topVisible: top >= -1 && top <= 901,
      },
    ],
  };
}

describe("anchorSatisfied on a row taller than the viewport", () => {
  const spec: PerfAnchorSpec = { name: "latest-comment", selector: "x", pick: "first", visibility: "contained" };
  /** QA measured MUL-307's newest comment as 3065px tall inside an 836px root. */
  const ROOT = 836;
  const anchorOf = (top: number, bottom: number) => ({
    name: "latest-comment",
    elId: 11,
    top,
    bottom,
    contained: top >= -1 && bottom <= ROOT + 1,
    topVisible: top >= -1 && top <= ROOT + 1,
  });

  it("accepts a tall row whose bottom edge is on screen", () => {
    // `bottomVisible`: S2 settles with the composer in view, which puts the row's
    // bottom edge inside the root even though its top is far above.
    expect(anchorSatisfied(spec, anchorOf(-2173, 800), ROOT)).toBe(true);
    expect(anchorSatisfied(spec, anchorOf(0, ROOT + 1), ROOT)).toBe(true);
  });

  it("accepts the production shape that overshoots the bottom by 56px", () => {
    // top=-2173 / bottom=892 in an 836px root spans the viewport, so `covers`
    // accepts it; the overshoot stays in `anchorRectAtReady` for S2 instead of
    // being turned into a timeout.
    expect(anchorSatisfied(spec, anchorOf(-2173, 892), ROOT)).toBe(true);
  });

  it("accepts a tall row that covers the viewport", () => {
    expect(anchorSatisfied(spec, anchorOf(-10, ROOT + 10), ROOT)).toBe(true);
  });

  it("still rejects a tall row entirely above or below the viewport", () => {
    expect(anchorSatisfied(spec, anchorOf(-3000, -2000), ROOT)).toBe(false);
    expect(anchorSatisfied(spec, anchorOf(900, 3000), ROOT)).toBe(false);
  });

  it("keeps the contained rule for rows that fit", () => {
    expect(anchorSatisfied(spec, anchorOf(100, 200), ROOT)).toBe(true);
    expect(anchorSatisfied(spec, anchorOf(700, 900), ROOT)).toBe(false);
  });

  it("lets a deep-link target taller than the root pass while it covers the viewport", () => {
    // `scrollIntoView({ block: "center" })` pushes the top edge out of view for an
    // oversized target, so `topVisible` alone can never be satisfied.
    const target: PerfAnchorSpec = { ...spec, visibility: "top-visible" };
    expect(anchorSatisfied(target, anchorOf(-282, ROOT + 282), ROOT)).toBe(true);
    expect(anchorSatisfied(target, anchorOf(-500, 400), ROOT)).toBe(false);
    expect(anchorSatisfied(target, anchorOf(-5000, -100), ROOT)).toBe(false);
  });
});

describe("computeScenarioStats", () => {
  it("keeps timed-out rounds out of every percentile", () => {
    const stats = computeScenarioStats([
      { readyMs: 100, readyTimeout: false, firstRealMs: 50, jumpCount: 1, jumpPx: 300, serialDepth: 3, apiCallsTotal: 4, slowestServerTotalMs: 120 },
      { readyMs: null, readyTimeout: true, firstRealMs: 50, jumpCount: 1, jumpPx: 300, serialDepth: 3, apiCallsTotal: 4, slowestServerTotalMs: 120 },
      { readyMs: 200, readyTimeout: false, firstRealMs: 60, jumpCount: 0, jumpPx: 0, serialDepth: 2, apiCallsTotal: 6, slowestServerTotalMs: 90 },
    ]);
    expect(stats.n).toBe(3);
    expect(stats.timeouts).toBe(1);
    // Only the two measured rounds enter: [100, 200]. Nearest-rank p50 of two
    // samples is the lower one, and p95 is the max — the request-metrics convention.
    expect(stats.readyP50).toBe(100);
    expect(stats.readyMax).toBe(200);
    expect(stats.readyP95).toBe(200);
  });

  it("uses nearest-rank percentiles", () => {
    expect(nearestRankPercentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(nearestRankPercentile([10, 20, 30, 40], 0.75)).toBe(30);
    expect(nearestRankPercentile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(nearestRankPercentile([], 0.5)).toBeNull();
  });
});

describe("computeWaves", () => {
  it("chains requests into waves with an 8ms tolerance", () => {
    const result = computeWaves([
      { index: 0, path: "/api/issues", startMs: 0, responseEndMs: 50 },
      // Ends 2ms before this one starts: still the predecessor.
      { index: 1, path: "/api/sessions", startMs: 52, responseEndMs: 90 },
      { index: 2, path: "/api/comments", startMs: 95, responseEndMs: 200 },
    ]);
    expect(result.serialDepth).toBe(3);
    expect(result.chain).toEqual([0, 1, 2]);
    expect(result.rows.map((row) => row.wave)).toEqual([1, 2, 3]);
  });

  it("does not chain a request that started before its predecessor finished", () => {
    const result = computeWaves([
      { index: 0, path: "/api/issues", startMs: 0, responseEndMs: 100 },
      { index: 1, path: "/api/sessions", startMs: 20, responseEndMs: 60 },
      { index: 2, path: "/api/comments", startMs: 25, responseEndMs: 80 },
    ]);
    expect(result.serialDepth).toBe(1);
  });

  it("tolerates up to the wave tolerance but not beyond it", () => {
    // The tolerance absorbs jitter where a sequential pair slightly overlaps in
    // recorded timing: the predecessor may end up to 8ms after the successor starts.
    const atTolerance = computeWaves([
      { index: 0, path: "/a", startMs: 0, responseEndMs: 100 },
      { index: 1, path: "/b", startMs: 100 - WAVE_TOLERANCE_MS, responseEndMs: 200 },
    ]);
    expect(atTolerance.serialDepth).toBe(2);
    const pastTolerance = computeWaves([
      { index: 0, path: "/a", startMs: 0, responseEndMs: 100 },
      { index: 1, path: "/b", startMs: 100 - WAVE_TOLERANCE_MS - 0.5, responseEndMs: 200 },
    ]);
    expect(pastTolerance.serialDepth).toBe(1);
  });
});

describe("computeAppReadyMs", () => {
  it("reads the ready transition out of a recorded attribute sequence", () => {
    const transitions: PerfStateTransition[] = [
      { t: 130.5, value: "pending" },
      { t: 480.2, value: "ready" },
    ];
    expect(computeAppReadyMs(transitions)).toEqual({ appReadyMs: 480.2, forced: false });
  });

  it("flags the S2 fallback path and stays null when the app never reports", () => {
    expect(computeAppReadyMs([{ t: 900, value: "ready-forced" }])).toEqual({ appReadyMs: 900, forced: true });
    expect(computeAppReadyMs([{ t: 40, value: "pending" }])).toEqual({ appReadyMs: null, forced: false });
    expect(computeAppReadyMs([])).toEqual({ appReadyMs: null, forced: false });
  });

  it("prefers ready over an earlier forced value and sorts out-of-order entries", () => {
    const result = computeAppReadyMs([
      { t: 900, value: "ready" },
      { t: 300, value: "pending" },
    ]);
    expect(result.appReadyMs).toBe(900);
    expect(result.forced).toBe(false);
  });
});

describe("computeSelectorEquivalence", () => {
  it("proves the two tables resolve to the same elements", () => {
    const shared = frame(500, view(600), view(600));
    expect(computeSelectorEquivalence(shared)).toEqual({
      scrollRoot: "same",
      anchor: "same",
      itemsContractOnly: 0,
      itemsLegacyOnly: 0,
    });
  });

  it("counts rows only one table can see", () => {
    const legacy = view(600);
    legacy.items = [...legacy.items, { key: "c2", elId: 99, top: 700, bottom: 740 }];
    expect(computeSelectorEquivalence(frame(500, view(600), legacy))).toMatchObject({
      itemsContractOnly: 0,
      itemsLegacyOnly: 1,
    });
  });
});

describe("pairForCompare", () => {
  it("pairs by key and mode instead of position", () => {
    const baseline = [
      { key: "detail-short", mode: "cold", readyP75: 100 },
      { key: "detail-short", mode: "warm", readyP75: 80 },
    ];
    const current = [
      { key: "detail-short", mode: "warm", readyP75: 60 },
      { key: "detail-long", mode: "cold", readyP75: 200 },
    ];
    const pairs = pairForCompare(baseline, current);
    expect(pairs.map((pair) => `${pair.key}/${pair.mode}`)).toEqual([
      "detail-short/cold",
      "detail-short/warm",
      "detail-long/cold",
    ]);
    expect(pairs[0]!.after).toBeNull();
    expect(pairs[1]!.before?.readyP75).toBe(80);
    expect(pairs[1]!.after?.readyP75).toBe(60);
    expect(pairs[2]!.before).toBeNull();
  });
});

describe("selectors", () => {
  it("builds both tables for the same targets", () => {
    expect(issueRowSelector("legacy", "iss_1")).toBe('[data-slot="sidebar-inset"] a[href$="/issues/iss_1"]');
    expect(issueRowSelector("contract", "iss_1")).toBe('[data-perf-item="issue"][data-perf-key="iss_1"] a');
  });

  it("falls back to the heading rule where legacy has no stable hook", () => {
    expect(profileFor({ mode: "legacy", shape: "chat" }).rule).toEqual({ kind: "heading" });
    expect(profileFor({ mode: "legacy", shape: "list" }).rule).toEqual({ kind: "heading" });
    expect(profileFor({ mode: "contract", shape: "chat" }).rule).toEqual({
      kind: "anchor",
      anchors: ["latest-message"],
    });
  });

  it("uses the last timeline row as the legacy anchor and the target id for deep links", () => {
    const running = profileFor({ mode: "legacy", shape: "issue-detail" });
    expect(running.anchors[0]).toMatchObject({ name: "latest-comment", pick: "last" });
    const deepLink = profileFor({ mode: "legacy", shape: "issue-detail", targetCommentId: "cmt_1" });
    expect(deepLink.anchors[0]!.selector).toBe('[id="comment-cmt_1"]');
  });

  it("roots list pages in the content region for both tables", () => {
    // Neither `[data-tab-scroll-root]` nor `data-perf-scroll` exists on the 11
    // list pages, so requiring either one left them structurally unable to ready.
    expect(scrollRootSelector("legacy", "list")).toBe(LEGACY.listRoot);
    expect(scrollRootSelector("contract", "list")).toBe(LEGACY.listRoot);
    expect(profileFor({ mode: "contract", shape: "list" }).scrollRoot).toBe('[data-slot="sidebar-inset"]');
    expect(profileFor({ mode: "legacy", shape: "list" }).scrollRoot).toBe('[data-slot="sidebar-inset"]');
  });

  it("falls back to the content region for an empty legacy chat", () => {
    // An empty chat renders `EmptyState`, so the chat scroll root is genuinely
    // absent and the MUL-367 heading rule needs another root to see a heading.
    expect(scrollRootFallbackSelector("legacy", "chat")).toBe(LEGACY.listRoot);
    expect(profileFor({ mode: "legacy", shape: "chat" }).scrollRootFallback).toBe('[data-slot="sidebar-inset"]');
    // Issue detail keeps its own root, and contract chat has a real one.
    expect(profileFor({ mode: "legacy", shape: "issue-detail" }).scrollRootFallback).toBeUndefined();
    expect(profileFor({ mode: "contract", shape: "chat" }).scrollRootFallback).toBeUndefined();
  });

  it("samples the legacy table alongside the contract one so equivalence is provable", () => {
    const profiles = profilesFor({ modes: ["contract", "legacy"], shape: "issue-detail" });
    expect(profiles.map((profile) => profile.name)).toEqual(["contract", "legacy"]);
    const contract = profiles[0]!;
    const legacy = profiles[1]!;
    expect(contract.anchors.map((anchor) => anchor.name)).toEqual(["agent-stream", "latest-comment"]);
    expect(legacy.anchors.map((anchor) => anchor.name)).toEqual(["latest-comment"]);
  });
});
