// MUL-384: the pure half of the jump recorder drives every number in the
// MUL-383 baseline reports, so its edge cases are pinned here: how frames merge
// into a single jump, the 1px threshold, the 500ms ready window, censored
// rounds, wave tolerance, `data-perf-state` timing and `--compare` pairing.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  installJumpRecorder,
  JUMP_THRESHOLD_PX,
  nearestRankPercentile,
  pairForCompare,
  READY_QUIET_MS,
  ROUND_TIMEOUT_MS,
  WAVE_TOLERANCE_MS,
  type PerfAnchorSpec,
  type PerfFrame,
  type PerfProfileFrame,
  type PerfStateTransition,
} from "../../../frontend/scripts/perf/lib/jump-recorder";
import {
  inboxDomRowIndex,
  isEntryFailure,
  LEGACY,
  profileFor,
  profilesFor,
  issueRowSelector,
  scrollRootFallbackSelector,
  scrollRootSelector,
} from "../../../frontend/scripts/perf/lib/selectors";
import {
  buildCompare,
  buildCompareByPath,
  buildHtml,
  buildMarkdown,
  REPORT_SCHEMA,
} from "../../../frontend/scripts/perf/lib/report";
import {
  computeRoundMeasurement,
  entryQuietVerdict,
  roundSummary,
  type RoundMeasurement,
} from "../../../frontend/scripts/perf/lib/round-measurement";
import type { ResourceEntry } from "../../../frontend/scripts/perf/lib/harness";
import { computeApiPathStats } from "../../../frontend/scripts/perf/lib/jump-recorder";
import { sanitizePath } from "../../../frontend/scripts/perf/lib/harness";
import {
  collectExcludedRunningIssueIds,
  DEFAULT_ENTRY_QUIET_MS,
  ENTRY_QUIET_CAP_MS,
  parseArgs,
  usageLines,
} from "../../../frontend/scripts/perf/lib/options";
import {
  injectInboxTarget,
  isInboxReadStateEndpoint,
  isStubbedWrite,
  rewriteInboxReadState,
  STUBBED_WRITES,
  stubLoopNotTerminated,
  stubbedReadResponseBody,
  stubbedWriteItemId,
} from "../../../frontend/scripts/perf/lib/stub-writes";
import {
  rankDeepLinkCandidates,
  unreadIdsInRow,
  type InboxCandidateInput,
} from "../../../frontend/scripts/perf/lib/deeplink-target";

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
    fresh: null,
  };
}

function frame(t: number, contract: PerfProfileFrame, legacy?: PerfProfileFrame): PerfFrame {
  return { t, profiles: legacy ? { contract, legacy } : { contract } };
}

const issueDetailProfile = profileFor({ mode: "contract", shape: "issue-detail" });

describe("scoring constants", () => {
  // These are the figures MUL-384's design section fixes, and the report's
  // "口径" table quotes them. They are asserted here because the behavioural tests
  // alone would stay green if someone widened the threshold or the quiet window —
  // the runner would simply score a different contract than the one documented.
  it("matches the documented jump threshold, quiet window and round timeout", () => {
    expect(JUMP_THRESHOLD_PX).toBe(1);
    expect(READY_QUIET_MS).toBe(500);
    expect(ROUND_TIMEOUT_MS).toBe(20_000);
  });
});

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
    expect(computeAppReadyMs(transitions)).toEqual({ appReadyMs: 480.2, forced: false, readyForced: false });
  });

  it("flags the S2 fallback path and stays null when the app never reports", () => {
    expect(computeAppReadyMs([{ t: 900, value: "ready-forced" }]))
      .toEqual({ appReadyMs: 900, forced: true, readyForced: true });
    expect(computeAppReadyMs([{ t: 40, value: "pending" }]))
      .toEqual({ appReadyMs: null, forced: false, readyForced: false });
    expect(computeAppReadyMs([])).toEqual({ appReadyMs: null, forced: false, readyForced: false });
  });

  it("prefers ready over an earlier forced value and sorts out-of-order entries", () => {
    const result = computeAppReadyMs([
      { t: 900, value: "ready" },
      { t: 300, value: "pending" },
    ]);
    expect(result.appReadyMs).toBe(900);
    expect(result.forced).toBe(false);
  });

  // MUL-443's `data-perf-fresh` contract: once the app publishes the freshness
  // attribute, a bare `ready` is not enough — it has to say `fresh=1` too.
  it("ignores a ready the app published before its data was fresh", () => {
    const result = computeAppReadyMs([
      { t: 200, value: "ready", fresh: "0" },
      { t: 640, value: "ready", fresh: "1" },
    ]);
    expect(result.appReadyMs).toBe(640);
    expect(result.forced).toBe(false);
  });

  // A reset opens a measurement window (the click of a warm round). The app can
  // publish its own `data-perf-state` transition inside the same task as that
  // click — on a warm deep link the inbox already points at the issue, so the
  // detail mounts, reveals and writes `ready` before the reset request arrives
  // over CDP. The window therefore keeps what reaches the start of the
  // measurement and drops the entry page's own publish; dropping everything
  // reported `appReadyMs: null` for a clean round (MUL-390).
  //
  // The filter lives inside the browser half, which Playwright serialises into
  // the page. Asserted from the serialised source on purpose: a helper call
  // there is a `ReferenceError` in the browser, not a compile error, and it
  // silently failed every warm round at once.
  const resetFilterSource = (): string => {
    const source = installJumpRecorder.toString();
    const start = source.indexOf("reset: (visibleFrom");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start);
    return body.slice(0, body.indexOf("lastSampleT"));
  };

  it("keeps the transitions the reset window already earned", () => {
    const filter = resetFilterSource();
    // The comparison is by the window's start, inclusive, so a transition that
    // lands in the same millisecond as the click survives.
    expect(filter).toContain("transition.t >= visibleFrom");
    expect(filter).not.toContain("transitionsFrom");
  });

  it("starts an unbounded reset window empty", () => {
    // No `visibleFrom` (a cold reset) means the window opens now, so nothing
    // already in the buffer belongs to it.
    const filter = resetFilterSource();
    expect(filter).toContain('typeof visibleFrom === "number"');
    expect(filter).toContain(": [];");
  });

  it("keeps the pre-fresh reading while the attribute is absent", () => {
    const result = computeAppReadyMs([
      { t: 200, value: "ready", fresh: null },
      { t: 640, value: "ready", fresh: "1" },
    ]);
    expect(result.appReadyMs).toBe(200);
  });

  it("never treats a fresh ready-forced as a loaded page, but still reports it", () => {
    const onlyForced = computeAppReadyMs([{ t: 900, value: "ready-forced", fresh: "1" }]);
    expect(onlyForced.appReadyMs).toBe(900);
    expect(onlyForced.forced).toBe(true);
    expect(onlyForced.readyForced).toBe(true);

    // A round that forced first and then settled properly reports the settled
    // time and still flags that the fallback fired.
    const recovered = computeAppReadyMs([
      { t: 900, value: "ready-forced", fresh: "1" },
      { t: 1500, value: "ready", fresh: "1" },
    ]);
    expect(recovered.appReadyMs).toBe(1500);
    expect(recovered.forced).toBe(false);
    expect(recovered.readyForced).toBe(true);
  });

  it("falls back to ready-forced when fresh never becomes 1", () => {
    const result = computeAppReadyMs([
      { t: 300, value: "ready", fresh: "0" },
      { t: 900, value: "ready-forced", fresh: "0" },
    ]);
    expect(result.appReadyMs).toBe(900);
    expect(result.forced).toBe(true);
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

/** Minimal inbox row for the grouping-based DOM row index. */
function inboxItem(
  id: string,
  options: { type?: string; issueId?: string | null; createdAt?: string; details?: Record<string, unknown> } = {},
) {
  return {
    id,
    workspace_id: "ws-1",
    recipient_type: "member" as const,
    recipient_id: "mem-1",
    actor_type: "member" as const,
    actor_id: "mem-1",
    type: (options.type ?? "comment_mention") as never,
    severity: "info" as const,
    issue_id: options.issueId === undefined ? `iss_${id}` : options.issueId,
    title: id,
    body: null,
    issue_status: null,
    read: false,
    archived: false,
    created_at: options.createdAt ?? new Date().toISOString(),
    details: (options.details ?? {}) as never,
  };
}

describe("inboxDomRowIndex", () => {
  it("is not the API array index when successful autopilot runs collapse", () => {
    // Production shape: 50 API records rendered as 8 rows. Several successful
    // runs of one autopilot occupy one row, so an API index lands elsewhere.
    const items = [
      inboxItem("inb_run_1", { type: "autopilot_run_completed", details: { autopilot_id: "auto_1" } }),
      inboxItem("inb_run_2", { type: "autopilot_run_completed", details: { autopilot_id: "auto_1" } }),
      inboxItem("inb_run_3", { type: "autopilot_run_completed", details: { autopilot_id: "auto_1" } }),
      inboxItem("inb_target"),
    ];
    // API array index of the target is 3; the rendered row is 1.
    expect(items.findIndex((item) => item.id === "inb_target")).toBe(3);
    expect(inboxDomRowIndex(items as never, "inb_target")).toBe(1);
    // The collapsed run row is addressed by its newest member.
    expect(inboxDomRowIndex(items as never, "inb_run_1")).toBe(0);
  });

  it("maps every notification of one issue to that issue's single row", () => {
    const items = [
      inboxItem("inb_old", { issueId: "iss_same", createdAt: "2026-09-26T00:00:00.000Z" }),
      inboxItem("inb_new", { issueId: "iss_same", createdAt: "2026-09-26T01:00:00.000Z" }),
    ];
    // `deduplicateInboxItems` keeps only the newest notification per selection
    // key, so the newest is the rendered row and the older one is not rendered at
    // all — the probe must therefore pick the newest per issue, which it does.
    expect(inboxDomRowIndex(items as never, "inb_new")).toBe(0);
    expect(inboxDomRowIndex(items as never, "inb_old")).toBeNull();
  });

  it("returns null for an item that is not rendered", () => {
    const items = [inboxItem("inb_present")];
    expect(inboxDomRowIndex(items as never, "inb_absent")).toBeNull();
  });
});

describe("isEntryFailure", () => {
  it("treats a missing entry row and a stale URL as skips, not timeouts", () => {
    // Both mean the measured page was never opened; waiting out the ready budget
    // would report a 20 s timeout for a screen the run never reached.
    expect(isEntryFailure("warm target not found for detail-short")).toBe(true);
    expect(isEntryFailure("deeplink warm: url issue=iss_other expected iss_wanted")).toBe(true);
  });

  it("leaves real timing failures alone", () => {
    expect(isEntryFailure(undefined)).toBe(false);
    expect(isEntryFailure("")).toBe(false);
    expect(isEntryFailure("goto: Timeout 20000ms exceeded.")).toBe(false);
    expect(isEntryFailure("page.click: Timeout 5000ms exceeded.")).toBe(false);
  });
});

describe("report rendering", () => {
  const round = {
    round: 1,
    readyMs: 100,
    readyTimeout: false,
    firstRealMs: 90,
    anchorVisibleMs: 100,
    anchorName: "latest-comment",
    anchorRule: "legacy-latest-comment",
    appReadyMs: null,
    appReadyForced: false,
    dataFreshAtReady: false,
    jumpCount: 0,
    jumpPx: 0,
    jumps: [],
    layoutShiftCount: 0,
    cls: 0,
    serialDepth: 3,
    apiCallsTotal: 5,
    apiFirstScreen: 5,
    chunksLoaded: 4,
    chunkBytes: 1024,
    lcpMs: 80,
    slowestServerTotalMs: 12,
    blockedWrites: 0,
    heapBytes: null,
    anchorRectAtReady: { top: 10, bottom: 20, height: 10, rootHeight: 800 },
    targetDepth: { timelineRequests: 0, targetIndexFromLatest: null },
    selectorEquivalence: null,
  };
  const scenario = {
    key: "detail-short",
    mode: "cold" as const,
    target: { identifier: "MUL-67", note: "20 条评论" },
    rule: "rule",
    anchorRule: "legacy-latest-comment",
    selectorMode: "legacy" as const,
    skipped: false,
    skipReason: null,
    hoverLeadMs: null,
    rounds: [round],
    stats: {
      n: 1, timeouts: 0, readyP50: 100, readyP75: 100, readyP95: 100, readyMax: 100,
      firstRealP50: 90, jumpsMax: 0, jumpPxMax: 0, serialDepthMax: 3,
      apiFirstScreenP50: 5, slowestServerTotalP50: 12,
    },
    timelineEntries: 60,
  };

  it("keeps the HTML summary header and body cell counts equal", () => {
    // The header was missing its status cell, so every body row rendered one
    // column to the right of its heading.
    const html = buildHtml({ meta: {}, scenarios: [scenario] as never, blockedWrites: [] });
    // Compare each table against its own header: a single shared header count
    // would compare the summary table's header with the detail table's rows.
    const tables = [...html.matchAll(/<table>(.*?)<\/table>/gs)].map((match) => match[1] ?? "");
    expect(tables.length).toBeGreaterThan(0);
    let checked = 0;
    for (const table of tables) {
      // `<th class="num">` and `<td class="num">` carry attributes, so count the
      // opening tags rather than the bare `<th`/`<td` prefixes.
      const headerCells = (table.match(/<th[\s>]/g) ?? []).length;
      const firstRow = /<tbody>\s*<tr>(.*?)<\/tr>/s.exec(table)?.[1] ?? "";
      const bodyCells = (firstRow.match(/<td[\s>]/g) ?? []).length;
      if (headerCells === 0 || bodyCells === 0) continue;
      expect(bodyCells).toBe(headerCells);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("renders the skipped status and the fixture row count in both formats", () => {
    const skipped = { ...scenario, skipped: true, skipReason: "fixture-archived", rounds: [], stats: { ...scenario.stats, n: 0, timeouts: 0 } };
    const md = buildMarkdown({ meta: {}, scenarios: [skipped] as never, blockedWrites: [], compare: null });
    expect(md).toContain("skipped: fixture-archived");
    const html = buildHtml({ meta: {}, scenarios: [skipped] as never, blockedWrites: [] });
    expect(html).toContain("skipped: fixture-archived");
  });

  it("carries the anchor rect into the round detail", () => {
    const md = buildMarkdown({ meta: {}, scenarios: [scenario] as never, blockedWrites: [], compare: null });
    expect(md).toContain("10/20/10/800");
  });
});

/** One inbox notification row, as `/api/inbox/page` returns it. */
function inboxRow(id: string, overrides: Partial<InboxCandidateInput> = {}): InboxCandidateInput {
  return {
    id,
    issue_id: `iss_${id}`,
    type: "comment_mention",
    read: false,
    archived: false,
    details: { comment_id: `cmt_${id}`, issue_session_id: `ises_${id}` },
    ...overrides,
  };
}

describe("report write-counter columns", () => {
  const baseRound = {
    round: 1,
    readyMs: 100,
    readyTimeout: false,
    firstRealMs: 90,
    anchorVisibleMs: 100,
    anchorName: "latest-comment",
    anchorRule: "legacy-latest-comment",
    appReadyMs: null,
    appReadyForced: false,
    dataFreshAtReady: false,
    jumpCount: 0,
    jumpPx: 0,
    jumps: [],
    layoutShiftCount: 0,
    cls: 0,
    serialDepth: 3,
    apiCallsTotal: 5,
    apiFirstScreen: 5,
    chunksLoaded: 4,
    chunkBytes: 1024,
    lcpMs: 80,
    slowestServerTotalMs: 12,
    blockedWrites: 2,
    stubbedWrites: 1,
    urlCommitMs: 880,
    inboxInjected: true,
    inboxPageRequestsBeforeStub: 1,
    heapBytes: null,
    anchorRectAtReady: null,
    targetDepth: { timelineRequests: 0, targetIndexFromLatest: null },
    selectorEquivalence: null,
  };
  const scenario = {
    key: "deeplink",
    mode: "warm" as const,
    target: { identifier: "iss_x" },
    rule: "rule",
    anchorRule: "legacy-target-comment",
    selectorMode: "legacy" as const,
    skipped: false,
    skipReason: null,
    hoverLeadMs: 150,
    rounds: [baseRound],
    stats: {
      n: 1, timeouts: 0, readyP50: 100, readyP75: 100, readyP95: 100, readyMax: 100,
      firstRealP50: 90, jumpsMax: 0, jumpPxMax: 0, serialDepthMax: 3,
      apiFirstScreenP50: 5, slowestServerTotalP50: 12,
    },
  };
  const stubs = [{ page: "deeplink", method: "POST", path: "/api/inbox/:id/read", attempts: 1 }];

  it("reports aborted and stubbed writes in separate columns in MD", () => {
    const md = buildMarkdown({ meta: {}, scenarios: [scenario] as never, blockedWrites: [], stubbedWrites: stubs as never, compare: null });
    expect(md).toContain("| 拦截写请求 | 桩写请求 | URL 提交 ms | 目标前置 | 前置前 inbox 请求 | 点击行文本 | error |");
    expect(md).toContain("被允许表接管的写请求");
    // The round row carries both counters and the URL commit.
    expect(md).toMatch(/\| deeplink \| warm \| 1 \|.*\| 2 \| 1 \| 880\.0 \| 注入 \| 1 \|/);
  });

  it("keeps every HTML table's header and body cell counts equal", () => {
    const html = buildHtml({ meta: {}, scenarios: [scenario] as never, blockedWrites: [], stubbedWrites: stubs as never });
    expect(html).toContain("桩写请求");
    const tables = [...html.matchAll(/<table>(.*?)<\/table>/gs)].map((match) => match[1] ?? "");
    let checked = 0;
    for (const table of tables) {
      const headerCells = (table.match(/<th[\s>]/g) ?? []).length;
      const firstRow = /<tbody>\s*<tr>(.*?)<\/tr>/s.exec(table)?.[1] ?? "";
      const bodyCells = (firstRow.match(/<td[\s>]/g) ?? []).length;
      if (headerCells === 0 || bodyCells === 0) continue;
      expect(bodyCells).toBe(headerCells);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("rankDeepLinkCandidates", () => {
  it("prefers an unread row over a read one", () => {
    // The third review round's ruling: an unread target exercises the auto
    // mark-read path a user almost always takes, and the allow-list makes it
    // completable. A read target skips that round trip entirely.
    const page = [
      inboxRow("read_first", { read: true }),
      inboxRow("unread_second", { read: false }),
    ];
    const ranked = rankDeepLinkCandidates(page, new Set());
    expect(ranked[0]!.inboxItemId).toBe("unread_second");
    expect(ranked[0]!.groupHasUnread).toBe(true);
    expect(ranked[1]!.groupHasUnread).toBe(false);
  });

  it("still prefers a quiet issue over a running one, ahead of read state", () => {
    const page = [
      inboxRow("running_unread", { read: false, issue_id: "iss_running" }),
      inboxRow("quiet_read", { read: true, issue_id: "iss_quiet" }),
    ];
    const ranked = rankDeepLinkCandidates(page, new Set(["iss_running"]));
    expect(ranked[0]!.inboxItemId).toBe("quiet_read");
    expect(ranked[0]!.issueHasRunningTask).toBe(false);
  });

  it("keeps one candidate per issue, newest first", () => {
    const page = [
      inboxRow("newest", { issue_id: "iss_same" }),
      inboxRow("older", { issue_id: "iss_same" }),
    ];
    const ranked = rankDeepLinkCandidates(page, new Set());
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.inboxItemId).toBe("newest");
  });

  it("treats a row as unread when any notification on it is unread", () => {
    // `?issue=` renders one row per issue, and the auto mark-read effect marks
    // every notification on that row, so read state is a property of the issue.
    const page = [
      inboxRow("read_item", { issue_id: "iss_mixed", read: true }),
      inboxRow("unread_item", { issue_id: "iss_mixed", read: false }),
    ];
    const ranked = rankDeepLinkCandidates(page, new Set());
    expect(ranked[0]!.groupHasUnread).toBe(true);
    expect(unreadIdsInRow(page, "iss_mixed")).toEqual(["unread_item"]);
  });

  it("rejects ledger rows and rows without a comment or session", () => {
    const page = [
      inboxRow("ledger", { type: "autopilot_run_completed" }),
      inboxRow("no_comment", { details: { issue_session_id: "ises_x" } }),
      inboxRow("no_session", { details: { comment_id: "cmt_x" } }),
      inboxRow("good"),
    ];
    const ranked = rankDeepLinkCandidates(page, new Set());
    expect(ranked.map((candidate) => candidate.inboxItemId)).toEqual(["good"]);
  });
});

describe("injectInboxTarget", () => {
  const target = { id: "inb_target", issue_id: "iss_1", read: false, created_at: "2026-09-27T00:00:00.000Z" };
  const other = { id: "inb_other", issue_id: "iss_2", read: false, created_at: "2026-09-27T01:00:00.000Z" };

  it("adds the target to a first-page body", () => {
    // Without this the measured round would page the UI to reach a target the
    // probe found on page 2+, which would fold the target's age into readyMs.
    const body = { items: [other], limit: 50, has_more: true };
    const injected = injectInboxTarget(body, target, { hasCursor: false }) as { items: unknown[]; has_more?: boolean };
    expect(injected.items).toHaveLength(2);
    expect(injected.items).toContainEqual(target);
    expect(injected.has_more).toBe(true);
  });

  it("leaves a first-page body alone when the target is already there", () => {
    const body = { items: [other, target], limit: 50 };
    expect(injectInboxTarget(body, target, { hasCursor: false })).toBe(body);
  });

  it("removes the target from a cursor page so the client cannot load it twice", () => {
    const body = { items: [other, target], limit: 50 };
    const injected = injectInboxTarget(body, target, { hasCursor: true }) as { items: unknown[] };
    expect(injected.items).toEqual([other]);
  });

  it("treats the bare-array endpoint like a first page", () => {
    const injected = injectInboxTarget([other], target, { hasCursor: false }) as unknown[];
    expect(injected).toHaveLength(2);
    // Already present: the input is returned untouched.
    const present = [other, target];
    expect(injectInboxTarget(present, target, { hasCursor: false })).toBe(present);
  });

  it("never mutates the input, because the caller reuses it as the item snapshot", () => {
    const items = [other];
    const body = { items };
    injectInboxTarget(body, target, { hasCursor: false });
    expect(items).toEqual([other]);
    const cursorBody = { items: [other, target] };
    injectInboxTarget(cursorBody, target, { hasCursor: true });
    expect(cursorBody.items).toHaveLength(2);
  });

  it("is a no-op without a target or with an id-less target", () => {
    const body = { items: [other] };
    expect(injectInboxTarget(body, null, { hasCursor: false })).toBe(body);
    expect(injectInboxTarget(body, { issue_id: "iss_1" }, { hasCursor: false })).toBe(body);
  });
});

describe("stub-writes allow-list", () => {
  it("allows exactly the mark-read endpoint and nothing else", () => {
    expect(isStubbedWrite("POST", "https://host/api/inbox/inb_1/read")).toBe(true);
    expect(isStubbedWrite("POST", "https://host/api/inbox/inb_1/archive")).toBe(false);
    expect(isStubbedWrite("POST", "https://host/api/inbox/unread-count")).toBe(false);
    expect(isStubbedWrite("GET", "https://host/api/inbox/inb_1/read")).toBe(false);
    expect(STUBBED_WRITES).toHaveLength(1);
  });

  it("extracts the item id from the allowed path", () => {
    expect(stubbedWriteItemId("https://host/api/inbox/inb_9/read")).toBe("inb_9");
    expect(stubbedWriteItemId("https://host/api/inbox/inb_9/archive")).toBeNull();
  });

  it("rewrites only the inbox read-state endpoints", () => {
    expect(isInboxReadStateEndpoint("GET", "https://host/api/inbox/page?limit=50")).toBe(true);
    expect(isInboxReadStateEndpoint("GET", "https://host/api/inbox")).toBe(true);
    // The badge endpoints are deliberately untouched.
    expect(isInboxReadStateEndpoint("GET", "https://host/api/inbox/unread-count")).toBe(false);
    expect(isInboxReadStateEndpoint("GET", "https://host/api/inbox/summary")).toBe(false);
    expect(isInboxReadStateEndpoint("POST", "https://host/api/inbox/page")).toBe(false);
  });

  it("marks the stubbed item read without mutating the input", () => {
    const items = [
      { id: "inb_1", read: false, title: "a" },
      { id: "inb_2", read: false, title: "b" },
    ];
    const rewritten = rewriteInboxReadState({ items, limit: 50, has_more: false }, new Set(["inb_1"])) as {
      items: Array<{ id: string; read: boolean }>;
      limit: number;
    };
    expect(rewritten.items[0]!.read).toBe(true);
    expect(rewritten.items[1]!.read).toBe(false);
    expect(rewritten.limit).toBe(50);
    // The original body is the caller's "before" snapshot; it must not change.
    expect(items[0]!.read).toBe(false);
  });

  it("handles the bare-array shape and the empty allow set", () => {
    const bare = [{ id: "inb_1", read: false }];
    expect((rewriteInboxReadState(bare, new Set(["inb_1"])) as Array<{ read: boolean }>)[0]!.read).toBe(true);
    // Nothing stubbed yet: the body passes through untouched.
    expect(rewriteInboxReadState(bare, new Set())).toBe(bare);
  });

  it("bounds the stub loop at twice the row's unread ids", () => {
    // One POST per unread id, plus one retry each, is legitimate.
    expect(stubLoopNotTerminated(2, 1)).toBe(false);
    expect(stubLoopNotTerminated(3, 1)).toBe(true);
    expect(stubLoopNotTerminated(0, 0)).toBe(false);
    expect(stubLoopNotTerminated(1, 0)).toBe(true);
  });

  it("answers the stubbed POST with the snapshot item marked read", () => {
    const snapshot = new Map([["inb_1", { id: "inb_1", read: false, title: "a" }]]);
    expect(stubbedReadResponseBody("inb_1", snapshot)).toEqual({ id: "inb_1", read: true, title: "a" });
    // Unknown id still answers with legal JSON, because the body is never read.
    expect(stubbedReadResponseBody("inb_missing", snapshot)).toEqual({ id: "inb_missing", read: true });
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

// ── MUL-395 S9-0: the warm time base, the first-screen lower bound, and the
//    per-request persistence every later S9 item is graded on.

/** One Resource Timing row, as `readResourceEntries` returns it. */
function api(
  index: number,
  path: string,
  startMs: number,
  responseEndMs: number,
  options: { serverTiming?: string | null; initiatorType?: string; encodedBytes?: number; method?: string } = {},
): ResourceEntry {
  return {
    index,
    name: `http://host${path}`,
    path,
    startMs,
    responseEndMs,
    durationMs: Math.round((responseEndMs - startMs) * 10) / 10,
    encodedBytes: options.encodedBytes ?? 512,
    decodedBytes: options.encodedBytes ?? 512,
    transferBytes: options.encodedBytes ?? 512,
    serverTiming: options.serverTiming ?? null,
    method: options.method ?? "GET",
    status: 200,
    initiatorType: options.initiatorType ?? "fetch",
  };
}

/**
 * A warm-shaped recorder buffer: every timestamp is an absolute
 * `performance.now()` on the entry page's document, i.e. it includes the time
 * spent on the entry page before the click.
 */
function warmBuffer(clickT: number): {
  frames: PerfFrame[];
  shifts: Array<{ t: number; value: number; hadRecentInput: boolean; sources: string[] }>;
  stateTransitions: PerfStateTransition[];
} {
  return {
    frames: [
      // Entry page content, before the click. It must not leak into any number.
      frame(clickT - 800, view(0, { key: "entry" })),
      // Target page: first content at click + 200, settled from click + 900.
      frame(clickT + 200, view(0, { key: "target" })),
      frame(clickT + 400, view(300, { key: "target" })),
      frame(clickT + 900, view(300, { key: "target" })),
      frame(clickT + 1_600, view(300, { key: "target" })),
    ],
    shifts: [
      { t: clickT - 500, value: 0.5, hadRecentInput: false, sources: ["entry"] },
      { t: clickT + 300, value: 0.1, hadRecentInput: false, sources: ["target"] },
    ],
    stateTransitions: [
      { t: clickT - 400, value: "ready" },
      { t: clickT + 950, value: "ready" },
    ],
  };
}

describe("computeRoundMeasurement — warm time base", () => {
  const clickT = 1_800;

  it("re-bases frames, jumps, shifts and app-ready on the click", () => {
    const buffer = warmBuffer(clickT);
    const result = computeRoundMeasurement({
      mode: "contract",
      shape: "issue-detail",
      targetCommentId: null,
      navStartMs: clickT,
      frames: buffer.frames,
      shifts: buffer.shifts,
      stateTransitions: buffer.stateTransitions,
      resources: [],
      quietMs: READY_QUIET_MS,
      profileReady: true,
    });
    // Entry-page frames sat at absolute 1000..; after rebasing the target page's
    // first content is 200 and its settled window starts at 400.
    expect(result.firstRealMs).toBe(200);
    expect(result.readyMs).toBe(400);
    expect(result.anchorVisibleMs).toBe(200);
    // The jump at absolute click+400 is reported relative to the click.
    expect(result.jumps).toHaveLength(1);
    expect(result.jumps[0]!.startMs).toBe(400);
    // The pre-click layout shift is filtered out by `fromMs` after rebasing; only
    // the target page's own shift counts.
    expect(result.layoutShiftCount).toBe(1);
    expect(result.appReadyMs).toBe(950);
    expect(result.dataFreshAtReady).toBe(true);
  });

  it("keeps a cold round (navStartMs = 0) numerically identical", () => {
    // A cold round's document *is* the measured page, so its frames already start
    // at the document origin and subtracting zero must change nothing.
    const frames = [
      frame(200, view(0, { key: "target" })),
      frame(400, view(300, { key: "target" })),
      frame(900, view(300, { key: "target" })),
      frame(1_600, view(300, { key: "target" })),
    ];
    const cold = computeRoundMeasurement({
      mode: "contract",
      shape: "issue-detail",
      targetCommentId: null,
      navStartMs: 0,
      frames,
      shifts: [{ t: 300, value: 0.1, hadRecentInput: false, sources: ["target"] }],
      stateTransitions: [{ t: 950, value: "ready" }],
      resources: [api(0, "/api/issues/:id", 210, 260)],
      quietMs: READY_QUIET_MS,
      profileReady: true,
    });
    expect(cold.firstRealMs).toBe(200);
    expect(cold.readyMs).toBe(400);
    expect(cold.appReadyMs).toBe(950);
    expect(cold.layoutShiftCount).toBe(1);
    expect(cold.apiFirstScreen).toBe(1);
    expect(cold.apiFirstScreenEntries[0]!.startMs).toBe(210);
  });

  it("ignores the entry page's trailing requests in the first-screen set", () => {
    const buffer = warmBuffer(clickT);
    const resources = [
      // Started before the click, finished after it: entry-page work.
      api(0, "/api/inbox/summary", clickT - 300, clickT + 50),
      api(1, "/api/issues", clickT - 100, clickT + 20),
      // Started after the click: target-page work.
      api(2, "/api/issues/:id", clickT + 30, clickT + 80),
      api(3, "/api/issues/:id/comments", clickT + 90, clickT + 300),
      // Settled after the ready frame: not first screen.
      api(4, "/api/late", clickT + 500, clickT + 600),
    ];
    const result = computeRoundMeasurement({
      mode: "contract",
      shape: "issue-detail",
      targetCommentId: null,
      navStartMs: clickT,
      frames: buffer.frames,
      shifts: [],
      stateTransitions: [],
      resources,
      quietMs: READY_QUIET_MS,
      profileReady: true,
    });
    expect(result.apiFirstScreenEntries.map((entry) => entry.path)).toEqual([
      "/api/issues/:id",
      "/api/issues/:id/comments",
    ]);
    expect(result.apiFirstScreen).toBe(2);
    // `apiCallsTotal` shares the lower bound but keeps its old upper one: it is
    // every call from the click onwards, so the late request counts here while
    // the two entry-page ones (started before the click) do not.
    expect(result.apiCallsTotal).toBe(3);
  });

  it("bounds chunks below by the click as well", () => {
    const buffer = warmBuffer(clickT);
    const result = computeRoundMeasurement({
      mode: "contract",
      shape: "issue-detail",
      targetCommentId: null,
      navStartMs: clickT,
      frames: buffer.frames,
      shifts: [],
      stateTransitions: [],
      resources: [
        api(0, "/_next/static/entry.js", clickT - 500, clickT - 400, { initiatorType: "script", encodedBytes: 9_000 }),
        api(1, "/_next/static/target.js", clickT + 100, clickT + 150, { initiatorType: "script", encodedBytes: 1_000 }),
      ],
      quietMs: READY_QUIET_MS,
      profileReady: true,
    });
    expect(result.chunksLoaded).toBe(1);
    expect(result.chunkBytes).toBe(1_000);
  });

  it("persists wave, after, Server-Timing and gap for every first-screen request", () => {
    const buffer = warmBuffer(clickT);
    const result = computeRoundMeasurement({
      mode: "contract",
      shape: "issue-detail",
      targetCommentId: null,
      navStartMs: clickT,
      frames: buffer.frames,
      shifts: [],
      stateTransitions: [],
      resources: [
        api(0, "/api/issues/:id", clickT + 10, clickT + 60, {
          serverTiming: "total;dur=20.5, db;dur=3, dbp;dur=1, dbq;dur=4, dbb;dur=2048",
        }),
        api(1, "/api/issues/:id/comments", clickT + 90, clickT + 300, {
          serverTiming: "total;dur=180, db;dur=40, dbq;dur=9, dbb;dur=900",
        }),
      ],
      quietMs: READY_QUIET_MS,
      profileReady: true,
    });
    const [first, second] = result.apiFirstScreenEntries;
    // `startMs`/`responseEndMs` stay on the page's absolute clock; `navStartMs` is
    // persisted next to them, so `startMs - navStartMs` is the round-relative
    // value a reader compares against `readyMs`.
    expect(first).toMatchObject({
      path: "/api/issues/:id",
      method: "GET",
      wave: 1,
      after: null,
      startMs: clickT + 10,
      responseEndMs: clickT + 60,
      durationMs: 50,
      encodedBytes: 512,
      serverTiming: { total: 20.5, db: 3, dbp: 1, dbq: 4, dbb: 2048 },
      gapMs: 29.5,
    });
    expect(first!.startMs - clickT).toBe(10);
    // The second request starts after the first ended, so it is wave 2 and names
    // its predecessor by position in this same table.
    expect(second).toMatchObject({ wave: 2, after: 0, gapMs: 30 });
    expect(result.serialChain).toEqual(["/api/issues/:id", "/api/issues/:id/comments"]);
    expect(result.serialDepth).toBe(2);
  });

  it("leaves gapMs null when the response carried no Server-Timing", () => {
    const buffer = warmBuffer(clickT);
    const result = computeRoundMeasurement({
      mode: "contract",
      shape: "issue-detail",
      targetCommentId: null,
      navStartMs: clickT,
      frames: buffer.frames,
      shifts: [],
      stateTransitions: [],
      resources: [api(0, "/api/issues", clickT + 10, clickT + 60)],
      quietMs: READY_QUIET_MS,
      profileReady: true,
    });
    expect(result.apiFirstScreenEntries[0]!.gapMs).toBeNull();
    expect(result.apiFirstScreenEntries[0]!.serverTiming).toEqual({
      total: null, db: null, dbp: null, dbq: null, dbb: null,
    });
  });
});

describe("computeApiPathStats", () => {
  const timing = (total: number | null, extra: { db?: number; dbq?: number; dbb?: number } = {}): ResourceEntry["serverTiming"] =>
    `total;dur=${total ?? 0}${extra.db !== undefined ? `, db;dur=${extra.db}` : ""}${extra.dbq !== undefined ? `, dbq;dur=${extra.dbq}` : ""}${extra.dbb !== undefined ? `, dbb;dur=${extra.dbb}` : ""}`;

  it("aggregates per path across rounds, not per round", () => {
    const rounds = [
      { apiFirstScreenEntries: [
        entry("/api/inbox/summary", 120, { total: 300, db: 20, dbq: 6, dbb: 5_200_000 }),
        entry("/api/issues", 40, { total: 60, db: 10, dbq: 80, dbb: 100 }),
      ] },
      { apiFirstScreenEntries: [
        entry("/api/inbox/summary", 90, { total: 200, db: 15, dbq: 4, dbb: 4_900_000 }),
      ] },
    ];
    const stats = computeApiPathStats(rounds);
    const summary = stats.find((row) => row.path === "/api/inbox/summary")!;
    expect(summary.count).toBe(2);
    expect(summary.rounds).toBe(2);
    expect(summary.totalP50).toBe(200);
    expect(summary.totalP95).toBe(300);
    expect(summary.dbP95).toBe(20);
    expect(summary.dbqMax).toBe(6);
    expect(summary.dbbMax).toBe(5_200_000);
    const issues = stats.find((row) => row.path === "/api/issues")!;
    expect(issues.count).toBe(1);
    expect(issues.rounds).toBe(1);
    expect(issues.dbqMax).toBe(80);
    // Sorted by total p95 descending, so the worst path leads the table.
    expect(stats[0]!.path).toBe("/api/inbox/summary");
  });

  it("keeps distinct methods apart and tolerates rounds without entries", () => {
    const stats = computeApiPathStats([
      { apiFirstScreenEntries: [entry("/api/issues", 10, { total: 5 }, "POST")] },
      { apiFirstScreenEntries: [entry("/api/issues", 20, { total: 7 }, "GET")] },
      { apiFirstScreenEntries: null },
      {},
    ]);
    expect(stats).toHaveLength(2);
    expect(stats.map((row) => row.method).sort()).toEqual(["GET", "POST"]);
    const get = stats.find((row) => row.method === "GET")!;
    expect(get.count).toBe(1);
    expect(get.rounds).toBe(1);
    expect(get.totalP50).toBe(7);
  });

  it("returns no rows for a scenario with nothing measured", () => {
    expect(computeApiPathStats([])).toEqual([]);
    expect(computeApiPathStats([{ apiFirstScreenEntries: [] }])).toEqual([]);
  });
});

/** One persisted first-screen entry, with sensible defaults per test. */
function entry(
  path: string,
  startMs: number,
  timing: { total?: number | null; db?: number; dbq?: number; dbb?: number },
  method = "GET",
): {
  path: string;
  method: string;
  wave: number;
  after: number | null;
  startMs: number;
  responseEndMs: number;
  durationMs: number;
  encodedBytes: number;
  serverTiming: { total: number | null; db: number | null; dbp: number | null; dbq: number | null; dbb: number | null };
  gapMs: number | null;
} {
  const total = timing.total === undefined ? 10 : timing.total;
  const db = timing.db ?? null;
  const dbq = timing.dbq ?? null;
  const dbb = timing.dbb ?? null;
  return {
    path,
    method,
    wave: 1,
    after: null,
    startMs,
    responseEndMs: startMs + 50,
    durationMs: 50,
    encodedBytes: 100,
    serverTiming: { total, db, dbp: null, dbq, dbb },
    gapMs: total === null ? null : 50 - total,
  };
}

describe("entryQuietVerdict", () => {
  it("settles only after a full quiet window with no new API request", () => {
    expect(entryQuietVerdict({ sinceLastApiMs: 499, quietMs: 500, waitedMs: 600, capMs: 5_000 })).toBe("waiting");
    expect(entryQuietVerdict({ sinceLastApiMs: 500, quietMs: 500, waitedMs: 600, capMs: 5_000 })).toBe("settled");
  });

  it("does not settle before the entry page has made any API call", () => {
    // "Idle because nothing has started yet" is not quiet: the first load's
    // requests are exactly what the rule waits for.
    expect(entryQuietVerdict({ sinceLastApiMs: null, quietMs: 500, waitedMs: 1_000, capMs: 5_000 })).toBe("waiting");
  });

  it("caps the wait and then clicks anyway", () => {
    expect(entryQuietVerdict({ sinceLastApiMs: 10, quietMs: 500, waitedMs: 5_000, capMs: 5_000 })).toBe("timeout");
    // A page that went quiet exactly as the cap expired did satisfy the rule.
    expect(entryQuietVerdict({ sinceLastApiMs: 500, quietMs: 500, waitedMs: 5_000, capMs: 5_000 })).toBe("settled");
  });
});

describe("roundSummary persistence", () => {
  const measurement = (): RoundMeasurement => {
    const computed = computeRoundMeasurement({
      mode: "contract",
      shape: "issue-detail",
      targetCommentId: null,
      navStartMs: 1_800,
      frames: warmBuffer(1_800).frames,
      shifts: [],
      stateTransitions: warmBuffer(1_800).stateTransitions,
      resources: [
        api(0, "/api/issues/:id", 1_810, 1_860, { serverTiming: "total;dur=20, db;dur=3, dbq;dur=4, dbb;dur=2" }),
      ],
      quietMs: READY_QUIET_MS,
      profileReady: true,
    });
    return {
      ...computed,
      round: 1,
      url: "http://host/local/issues/iss_x",
      navStartMs: 1_800,
      clickT: 1_800,
      entryReadyMs: 1_200,
      entryInflightAtClick: 2,
      entrySettled: false,
      blockedWrites: 0,
      stubbedWrites: 0,
      urlCommitMs: 150,
      clickedRowText: "row",
      inboxInjected: false,
      inboxPageRequestsBeforeStub: null,
      timelineRequests: 1,
      targetIndexFromLatest: 3,
      entryFailed: false,
      lcpMs: 900,
    };
  };

  it("carries the time base, entry state, serial chain and per-request table", () => {
    const summary = roundSummary(measurement());
    expect(summary.navStartMs).toBe(1_800);
    expect(summary.clickT).toBe(1_800);
    expect(summary.entryReadyMs).toBe(1_200);
    expect(summary.entryInflightAtClick).toBe(2);
    expect(summary.entrySettled).toBe(false);
    expect(summary.serialChain).toEqual(["/api/issues/:id"]);
    expect(summary.apiFirstScreenEntries).toHaveLength(1);
    expect(summary.apiFirstScreenEntries[0]).toMatchObject({ path: "/api/issues/:id", wave: 1, gapMs: 30 });
    // The count field is kept next to the table so the two can be cross-checked.
    expect(summary.apiFirstScreen).toBe(1);
    expect(JSON.parse(JSON.stringify(summary)).navStartMs).toBe(1_800);
  });
});

describe("report schema and per-path output", () => {
  const roundSummaryFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    round: 1,
    navStartMs: 1_800,
    clickT: 1_800,
    readyMs: 400,
    readyTimeout: false,
    firstRealMs: 200,
    anchorVisibleMs: 200,
    anchorName: "latest-comment",
    anchorRule: "legacy-latest-comment",
    appReadyMs: 950,
    appReadyForced: false,
    dataFreshAtReady: true,
    jumpCount: 0,
    jumpPx: 0,
    jumps: [],
    layoutShiftCount: 0,
    cls: 0,
    serialDepth: 2,
    serialChain: ["/api/issues/:id", "/api/issues/:id/comments"],
    apiCallsTotal: 3,
    apiFirstScreen: 2,
    apiFirstScreenEntries: [
      entry("/api/issues/:id", 1_810, { total: 20, dbq: 4 }),
      entry("/api/issues/:id/comments", 1_890, { total: 120, dbq: 9 }),
    ],
    chunksLoaded: 1,
    chunkBytes: 2_048,
    lcpMs: 900,
    slowestServerTotalMs: 120,
    blockedWrites: 0,
    stubbedWrites: 0,
    urlCommitMs: 150,
    entryReadyMs: 1_200,
    entryInflightAtClick: 2,
    entrySettled: false,
    inboxInjected: false,
    inboxPageRequestsBeforeStub: null,
    clickedRowText: "row",
    heapBytes: null,
    anchorRectAtReady: null,
    targetDepth: { timelineRequests: 1, targetIndexFromLatest: 3 },
    selectorEquivalence: null,
    ...overrides,
  });

  const scenarioFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    key: "detail-short",
    mode: "warm",
    target: { identifier: "MUL-67" },
    rule: "rule",
    anchorRule: "legacy-latest-comment",
    selectorMode: "legacy",
    skipped: false,
    skipReason: null,
    hoverLeadMs: 150,
    rounds: [roundSummaryFixture()],
    stats: {
      n: 1, timeouts: 0, readyP50: 400, readyP75: 400, readyP95: 400, readyMax: 400,
      firstRealP50: 200, jumpsMax: 0, jumpPxMax: 0, serialDepthMax: 2,
      apiFirstScreenP50: 2, slowestServerTotalP50: 120,
      apiByPath: computeApiPathStats([{ apiFirstScreenEntries: [entry("/api/issues/:id", 1_810, { total: 20, dbq: 4 })] }]),
    },
    ...overrides,
  });

  it("declares schema 3 in the artifact header", () => {
    expect(REPORT_SCHEMA).toBe(3);
    const md = buildMarkdown({ meta: {}, scenarios: [scenarioFixture()] as never, blockedWrites: [], compare: null });
    expect(md).toContain("schema 3");
    const html = buildHtml({ meta: {}, scenarios: [scenarioFixture()] as never, blockedWrites: [] });
    expect(html).toContain("schema 3");
  });

  it("renders one first-screen API table per scenario in both formats", () => {
    const scenarios = [scenarioFixture(), scenarioFixture({ key: "page-issues", mode: "cold" })];
    const md = buildMarkdown({ meta: {}, scenarios: scenarios as never, blockedWrites: [], compare: null });
    expect(md).toContain("## 首屏 API 表（按 path 聚合，跨本场景各轮）");
    expect(md).toContain("### detail-short（warm）");
    expect(md).toContain("### page-issues（cold）");
    expect(md).toMatch(/total p95/);
    const html = buildHtml({ meta: {}, scenarios: scenarios as never, blockedWrites: [] });
    expect(html).toContain("首屏 API 表（按 path 聚合）");
    expect(html.match(/<h3>detail-short（warm）<\/h3>/g)).toHaveLength(1);
  });

  it("states the entry-quiet threshold and the off switch in both formats", () => {
    // The threshold changes what a warm number means, so it is part of the report
    // header rather than only the JSON meta.
    const on = buildMarkdown({
      meta: { entryQuietMs: 500, entryQuietCapMs: 5_000 },
      scenarios: [scenarioFixture()] as never,
      blockedWrites: [],
      compare: null,
    });
    expect(on).toContain("入口页安静（MUL-383 A1");
    expect(on).toContain("500");

    const off = buildMarkdown({ meta: { entryQuietMs: null }, scenarios: [scenarioFixture()] as never, blockedWrites: [], compare: null });
    expect(off).toContain("入口页安静：**关闭**");

    const html = buildHtml({
      meta: { entryQuietMs: 500, entryQuietCapMs: 5_000 },
      scenarios: [scenarioFixture()] as never,
      blockedWrites: [],
    });
    expect(html).toContain("入口页安静");
    expect(html).toContain("500 ms 无新");
    const htmlOff = buildHtml({ meta: { entryQuietMs: null }, scenarios: [scenarioFixture()] as never, blockedWrites: [] });
    expect(htmlOff).toContain("入口页安静规则关闭");
  });

  it("reports the round's time base and serial chain in the Markdown detail", () => {
    const md = buildMarkdown({ meta: {}, scenarios: [scenarioFixture()] as never, blockedWrites: [], compare: null });
    expect(md).toContain("## 逐轮时基与串行链");
    expect(md).toMatch(/\| detail-short \| warm \| 1 \| 1800\.0 \| 1800\.0 \| 1200\.0 \| 2 \| 超时 \|/);
    expect(md).toContain("/api/issues/:id → /api/issues/:id/comments");
  });
});

describe("buildCompare schema handling", () => {
  /**
   * `readyMs` is the field the review used to expose the defect (a schema 2 warm
   * row at 4000ms against a schema 3 warm row at 500ms printed `-3500.0`), so it
   * is a parameter here rather than a constant.
   */
  const scenario = (
    key: string,
    mode: "cold" | "warm",
    schema: number,
    readyMs = 100,
  ): Record<string, unknown> => ({
    key,
    mode,
    target: { identifier: "MUL-67" },
    selectorMode: "legacy",
    skipped: false,
    skipReason: null,
    hoverLeadMs: mode === "warm" ? 150 : null,
    rounds: [],
    stats: {
      n: 1, timeouts: 0, readyP50: readyMs, readyP75: readyMs, readyP95: readyMs, readyMax: readyMs,
      firstRealP50: 90, jumpsMax: 0, jumpPxMax: 0, serialDepthMax: 3,
      apiFirstScreenP50: 5, slowestServerTotalP50: 12,
      apiByPath: computeApiPathStats([{ apiFirstScreenEntries: [entry("/api/inbox/summary", 10, { total: 300, dbq: 6, dbb: 5_200_000 })] }]),
    },
    meta: { schema },
  });

  it("pairs cold rows but withholds every number on the warm row of a schema 2 baseline", () => {
    // A2: the 09-27 baseline's warm rows measured from the entry page's document
    // origin, so their readyMs is not the quantity a schema 3 warm row reports.
    const baseline = {
      meta: { schema: 2 },
      scenarios: [scenario("detail-short", "cold", 2, 1000), scenario("detail-short", "warm", 2, 4000)],
    };
    const current = {
      meta: { schema: 3 },
      scenarios: [scenario("detail-short", "cold", 3, 900), scenario("detail-short", "warm", 3, 500)],
    };
    const compare = buildCompare(baseline as never, current as never);

    const cold = compare.rows.find((row) => row.mode === "cold")!;
    expect(cold.comparable).toBe(true);
    expect(cold.beforeReadyP75).toBe(1000);
    expect(cold.afterReadyP75).toBe(900);

    const warm = compare.rows.find((row) => row.mode === "warm")!;
    expect(warm.comparable).toBe(false);
    expect(warm.notComparableReason).toContain("作废");
    // Every numeric field is null, so no consumer — Markdown, HTML or a script
    // reading compare.rows out of the JSON — has a delta to compute.
    for (const value of [
      warm.beforeReadyP75, warm.afterReadyP75, warm.beforeReadyP95, warm.afterReadyP95,
      warm.beforeJumpsMax, warm.afterJumpsMax, warm.beforeSerialDepthMax, warm.afterSerialDepthMax,
      warm.beforeApiFirstScreenP50, warm.afterApiFirstScreenP50,
      warm.beforeTimelineRequests, warm.afterTimelineRequests,
    ]) {
      expect(value).toBeNull();
    }

    // One warning, naming the invalidation; nothing else is reported for the row.
    const warmWarnings = compare.warnings.filter((warning) => warning.mode === "warm");
    expect(warmWarnings).toHaveLength(1);
    expect(warmWarnings[0]!.message).toContain("作废");
    expect(compare.warnings.filter((warning) => warning.mode === "cold")).toHaveLength(0);
  });

  it("withholds every per-path number of a schema 2 warm pairing", () => {
    const baseline = {
      meta: { schema: 2 },
      scenarios: [scenario("detail-short", "cold", 2, 1000), scenario("detail-short", "warm", 2, 4000)],
    };
    const current = {
      meta: { schema: 3 },
      scenarios: [scenario("detail-short", "cold", 3, 900), scenario("detail-short", "warm", 3, 500)],
    };
    const pathRows = buildCompareByPath(baseline as never, current as never);
    const warmRows = pathRows.filter((row) => row.mode === "warm");
    expect(warmRows.length).toBeGreaterThan(0);
    for (const row of warmRows) {
      expect(row.comparable).toBe(false);
      // Counts are withheld as well: the schema 2 count also carried the entry
      // page's trailing requests, so a "5 → 3" cell would put a corrected number
      // next to an uncorrected one.
      expect(row.beforeCount).toBeNull();
      expect(row.afterCount).toBeNull();
      expect(row.beforeTotalP50).toBeNull();
      expect(row.afterTotalP50).toBeNull();
      expect(row.beforeTotalP95).toBeNull();
      expect(row.afterTotalP95).toBeNull();
      expect(row.beforeGapP50).toBeNull();
      expect(row.afterGapP50).toBeNull();
      expect(row.beforeDbqMax).toBeNull();
      expect(row.afterDbqMax).toBeNull();
      expect(row.beforeDbbMax).toBeNull();
      expect(row.afterDbbMax).toBeNull();
    }
    const coldRows = pathRows.filter((row) => row.mode === "cold");
    expect(coldRows.every((row) => row.comparable)).toBe(true);
    expect(coldRows.some((row) => row.beforeTotalP95 !== null)).toBe(true);
    expect(coldRows.some((row) => row.beforeCount !== null)).toBe(true);
  });

  it("prints no warm delta anywhere in the Markdown of a schema 2 comparison", () => {
    const baseline = {
      meta: { schema: 2 },
      scenarios: [scenario("detail-short", "cold", 2, 1000), scenario("detail-short", "warm", 2, 4000)],
    };
    const current = {
      meta: { schema: 3 },
      scenarios: [scenario("detail-short", "cold", 3, 900), scenario("detail-short", "warm", 3, 500)],
    };
    const compare = buildCompare(baseline as never, current as never);

    // The exact number the review caught.
    expect(compare.markdown).not.toContain("-3500.0");
    // Nor any delta at all on a warm line.
    const warmLines = compare.markdown.split("\n").filter((line) => line.includes("| warm |"));
    expect(warmLines.length).toBeGreaterThan(0);
    for (const line of warmLines) {
      expect(line).toContain("不可比（schema 2 warm 已作废）");
      // No "100.0 → 200.0" pairs and no signed delta anywhere on the line.
      expect(line).not.toMatch(/\d+\.\d+\s*→\s*\d+\.\d+/);
      expect(line).not.toMatch(/[+-]\d+\.\d/);
    }
    // The cold row still carries its numbers.
    const coldLine = compare.markdown.split("\n").find((line) => line.includes("| cold |"))!;
    expect(coldLine).toContain("1000.0 → 900.0");
    expect(coldLine).toContain("-100.0");
    // And the warning explains why the warm row is blank.
    expect(compare.markdown).toContain("作废");
  });

  it("withholds a warm row that only exists on the new side of a schema 2 baseline", () => {
    // `detail-xlong` is new in schema 3, so a schema 2 baseline has no counterpart
    // for it. Its current numbers are still schema 3 warm numbers sitting in a
    // table whose other half is an invalidated time base: printing them alone
    // would read as "the after half of a comparison".
    const baseline = {
      meta: { schema: 2 },
      scenarios: [scenario("detail-short", "warm", 2, 4000)],
    };
    const current = {
      meta: { schema: 3 },
      scenarios: [scenario("detail-short", "warm", 3, 500), scenario("detail-xlong", "warm", 3, 700)],
    };
    const compare = buildCompare(baseline as never, current as never);
    const xlong = compare.rows.find((row) => row.key === "detail-xlong")!;
    expect(xlong.comparable).toBe(false);
    expect(xlong.afterReadyP75).toBeNull();
    expect(xlong.beforeReadyP75).toBeNull();
    // The paired warm row is withheld the same way, and both warnings are emitted.
    expect(compare.rows.find((row) => row.key === "detail-short")!.comparable).toBe(false);
    expect(compare.warnings.filter((warning) => warning.mode === "warm")).toHaveLength(2);
    // No numbers anywhere on a warm line.
    for (const line of compare.markdown.split("\n").filter((l) => l.includes("| warm |"))) {
      expect(line).toContain("不可比（schema 2 warm 已作废）");
      expect(line).not.toMatch(/[+-]\d+\.\d/);
    }
    // And a cold row added on one side is unaffected: cold is comparable either way.
    const coldOnly = buildCompare(
      { meta: { schema: 2 }, scenarios: [scenario("detail-short", "cold", 2, 1000)] } as never,
      {
        meta: { schema: 3 },
        scenarios: [scenario("detail-short", "cold", 3, 900), scenario("detail-xlong", "cold", 3, 800)],
      } as never,
    );
    expect(coldOnly.rows.every((row) => row.comparable)).toBe(true);
  });

  it("keeps both rows comparable when both sides are schema 3", () => {
    const baseline = {
      meta: { schema: 3 },
      scenarios: [scenario("detail-short", "cold", 3, 1000), scenario("detail-short", "warm", 3, 4000)],
    };
    const current = {
      meta: { schema: 3 },
      scenarios: [scenario("detail-short", "cold", 3, 900), scenario("detail-short", "warm", 3, 500)],
    };
    const compare = buildCompare(baseline as never, current as never);
    expect(compare.rows.every((row) => row.comparable)).toBe(true);
    expect(compare.rows.every((row) => row.notComparableReason === null)).toBe(true);
    const warm = compare.rows.find((row) => row.mode === "warm")!;
    expect(warm.beforeReadyP75).toBe(4000);
    expect(warm.afterReadyP75).toBe(500);
    expect(compare.warnings.filter((warning) => warning.message.includes("作废"))).toHaveLength(0);
    // The warm delta is the whole point of a same-schema comparison.
    const warmLine = compare.markdown.split("\n").find((line) => line.includes("| warm |"))!;
    expect(warmLine).toContain("-3500.0");
  });

  it("still pairs a schema 2 cold row and warns about nothing", () => {
    const coldOnly = buildCompare(
      { meta: { schema: 2 }, scenarios: [scenario("detail-short", "cold", 2, 1000)] } as never,
      { meta: { schema: 3 }, scenarios: [scenario("detail-short", "cold", 3, 900)] } as never,
    );
    expect(coldOnly.warnings).toHaveLength(0);
    expect(coldOnly.rows).toHaveLength(1);
    expect(coldOnly.rows[0]!.comparable).toBe(true);
    expect(coldOnly.rows[0]!.beforeReadyP75).toBe(1000);
  });

  it("treats a missing baseline meta.schema as comparable, and a schema 1 as not", () => {
    // No schema at all: nothing says the time base differs, so rows pair. (Schema 1
    // is reported as incomparable below; an absent field predates the flag and is
    // the more conservative reading only for cold, so warm falls back to pairing —
    // the plan's rule names schema 2 specifically.)
    const missing = buildCompare(
      { scenarios: [scenario("detail-short", "warm", 3, 4000)] } as never,
      { meta: { schema: 3 }, scenarios: [scenario("detail-short", "warm", 3, 500)] } as never,
    );
    expect(missing.rows[0]!.comparable).toBe(true);

    // Schema 1 (MUL-367) predates the warm round entirely; its warm rows are not
    // this quantity either, so the same rule applies.
    const schema1 = buildCompare(
      { meta: { schema: 1 }, scenarios: [scenario("detail-short", "warm", 1, 4000)] } as never,
      { meta: { schema: 3 }, scenarios: [scenario("detail-short", "warm", 3, 500)] } as never,
    );
    expect(schema1.rows[0]!.comparable).toBe(false);
    expect(schema1.warnings[0]!.message).toContain("schema 1");
  });

  it("pairs per-path deltas on key::mode::path and reports vanished paths", () => {
    const baseline = {
      meta: { schema: 3 },
      scenarios: [
        {
          ...scenario("detail-short", "warm", 3),
          stats: {
            ...(scenario("detail-short", "warm", 3).stats as Record<string, unknown>),
            apiByPath: computeApiPathStats([{ apiFirstScreenEntries: [
              entry("/api/inbox/summary", 10, { total: 300, dbq: 6 }),
              entry("/api/issues", 20, { total: 40 }),
            ] }]),
          },
        },
      ],
    };
    const current = {
      meta: { schema: 3 },
      scenarios: [
        {
          ...scenario("detail-short", "warm", 3),
          stats: {
            ...(scenario("detail-short", "warm", 3).stats as Record<string, unknown>),
            apiByPath: computeApiPathStats([{ apiFirstScreenEntries: [entry("/api/inbox/summary", 10, { total: 30, dbq: 2 })] }]),
          },
        },
      ],
    };
    const compare = buildCompare(baseline as never, current as never);
    const summary = compare.pathRows.find((row) => row.path === "/api/inbox/summary")!;
    expect(summary.beforeTotalP95).toBe(300);
    expect(summary.afterTotalP95).toBe(30);
    expect(summary.beforeDbqMax).toBe(6);
    expect(summary.afterDbqMax).toBe(2);
    // A path that the change removed still shows up, with a blank right column:
    // "the request is gone" is exactly the result S9-1 is graded on.
    const issues = compare.pathRows.find((row) => row.path === "/api/issues")!;
    expect(issues.beforeCount).toBe(1);
    expect(issues.afterCount).toBeNull();
    expect(compare.markdown).toContain("### 按 path 对比");
    // The helper is also exported on its own, for readers that only want the paths.
    expect(buildCompareByPath(baseline as never, current as never)).toHaveLength(2);
  });

  it("renders the per-path comparison in HTML", () => {
    const html = buildHtml({
      meta: {},
      scenarios: [scenarioFixtureForCompare()] as never,
      blockedWrites: [],
      compareTable: [],
      comparePathTable: [{
        key: "detail-short",
        mode: "warm",
        path: "/api/inbox/summary",
        method: "GET",
        comparable: true,
        beforeCount: 5,
        afterCount: 1,
        beforeTotalP50: 120,
        afterTotalP50: 40,
        beforeTotalP95: 300,
        afterTotalP95: 30,
        beforeGapP50: 90,
        afterGapP50: 20,
        beforeDbqMax: 6,
        afterDbqMax: 2,
        beforeDbbMax: 5_200_000,
        afterDbbMax: 90_000,
      }],
    });
    expect(html).toContain("与基线对比：按 path");
    expect(html).toContain("/api/inbox/summary");
    expect(html).toContain("-270.0");
  });

  it("renders a withheld comparison row without any numbers in HTML", () => {
    // The HTML side of A2: the phrase appears, and the numeric cells are gone
    // (the row spans them with one cell) so no delta can be read off.
    const html = buildHtml({
      meta: {},
      scenarios: [scenarioFixtureForCompare()] as never,
      blockedWrites: [],
      compareTable: [{
        key: "detail-short",
        mode: "warm",
        comparable: false,
        notComparableReason: "schema 2 的 warm 行已作废",
        beforeMode: "legacy",
        afterMode: "contract",
        beforeReadyP75: null,
        afterReadyP75: null,
        beforeReadyP95: null,
        afterReadyP95: null,
        beforeJumpsMax: null,
        afterJumpsMax: null,
        beforeSerialDepthMax: null,
        afterSerialDepthMax: null,
        beforeApiFirstScreenP50: null,
        afterApiFirstScreenP50: null,
        beforeTimelineRequests: null,
        afterTimelineRequests: null,
      }],
      comparePathTable: [{
        key: "detail-short",
        mode: "warm",
        path: "/api/inbox/summary",
        method: "GET",
        comparable: false,
        beforeCount: 5,
        afterCount: 5,
        beforeTotalP50: null,
        afterTotalP50: null,
        beforeTotalP95: null,
        afterTotalP95: null,
        beforeGapP50: null,
        afterGapP50: null,
        beforeDbqMax: null,
        afterDbqMax: null,
        beforeDbbMax: null,
        afterDbbMax: null,
      }],
    });
    expect(html).toContain("不可比（schema 2 warm 已作废）");
    expect(html).toContain('class="withheld"');
    // Two withheld rows, and neither carries a numeric delta cell.
    const withheld = html.split('class="withheld"').slice(1);
    expect(withheld).toHaveLength(2);
    for (const fragment of withheld) {
      const row = fragment.slice(0, fragment.indexOf("</tr>"));
      expect(row).not.toMatch(/[+-]\d+\.\d/);
      expect(row).toContain("不可比（schema 2 warm 已作废）");
    }
  });

  function scenarioFixtureForCompare(): Record<string, unknown> {
    return {
      key: "detail-short",
      mode: "warm",
      target: { identifier: "MUL-67" },
      rule: "rule",
      anchorRule: "legacy-latest-comment",
      selectorMode: "legacy",
      skipped: false,
      skipReason: null,
      hoverLeadMs: 150,
      rounds: [],
      stats: {
        n: 1, timeouts: 0, readyP50: 100, readyP75: 100, readyP95: 100, readyMax: 100,
        firstRealP50: 90, jumpsMax: 0, jumpPxMax: 0, serialDepthMax: 3,
        apiFirstScreenP50: 5, slowestServerTotalP50: 12, apiByPath: [],
      },
    };
  }
});

// ── MUL-395 S9-0 follow-up: the A1 default (entry-quiet on) and A3's new
//    fixture/scenario wiring.

describe("probe options", () => {
  it("turns the entry quiet rule on by default at 500ms with a 5s cap", () => {
    const opts = parseArgs([]);
    expect(opts.entryQuietMs).toBe(DEFAULT_ENTRY_QUIET_MS);
    expect(opts.entryQuietMs).toBe(500);
    expect(ENTRY_QUIET_CAP_MS).toBe(5_000);
  });

  it("keeps the entry quiet rule overridable and treats 0 as off", () => {
    expect(parseArgs(["--entry-quiet-ms", "250"]).entryQuietMs).toBe(250);
    // 0 is the documented off switch; keeping it as a 0ms window would still pay
    // a poll per round and report `entrySettled`.
    expect(parseArgs(["--entry-quiet-ms", "0"]).entryQuietMs).toBeNull();
    expect(() => parseArgs(["--entry-quiet-ms", "-1"])).toThrow();
  });

  it("pins detail-long to MUL-70 and detail-xlong to MUL-454 by default", () => {
    const opts = parseArgs([]);
    expect(opts.issueLong).toBe("iss_enbrunyg86jc");
    expect(opts.issueXlong).toBe("iss_o2skonppbq2u");
    expect(opts.issueShort).toBe("iss_in41j1x1dq66");
  });

  it("lets --issue-xlong drop the scenario without touching the other keys", () => {
    expect(parseArgs(["--issue-xlong", ""]).issueXlong).toBeNull();
    expect(parseArgs(["--issue-xlong", "none"]).issueXlong).toBeNull();
    expect(parseArgs(["--issue-xlong", "iss_other"]).issueXlong).toBe("iss_other");
    // `--issue-long` is unaffected: MUL-395's comparison fixture stays pinned.
    expect(parseArgs(["--issue-xlong", ""]).issueLong).toBe("iss_enbrunyg86jc");
  });

  it("rejects unknown flags and keeps the documented defaults", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    const opts = parseArgs([]);
    expect(opts.rounds).toBe(3);
    expect(opts.selectors).toBe("auto");
    expect(opts.hoverLeadMs).toBe(150);
    expect(opts.inboxProbePages).toBe(10);
    expect(opts.window).toBe("offpeak");
  });

  it("returns from --help instead of parsing the rest of the line", () => {
    const opts = parseArgs(["--help", "--nonsense"]);
    expect(opts.help).toBe(true);
    expect(usageLines().join("\n")).toContain("--entry-quiet-ms");
  });

  it("documents every flag it accepts", () => {
    const usage = usageLines().join("\n");
    for (const flag of [
      "--base-url", "--rounds", "--window", "--selectors", "--issue-short", "--issue-long",
      "--issue-xlong", "--issue-running", "--inbox-item", "--inbox-probe-pages",
      "--hover-lead-ms", "--entry-quiet-ms", "--out", "--name", "--compare", "--only", "--warmup",
    ]) {
      expect(usage).toContain(flag);
    }
  });
});

describe("running-issue exclusions", () => {
  it("always excludes MUL-454, so the long fixture cannot become detail-running", () => {
    // MUL-454 stays in progress and unassigned by design; without this the probe
    // would pick it up as "some running task's issue" and measure it twice.
    const excluded = collectExcludedRunningIssueIds();
    expect(excluded.has("iss_o2skonppbq2u")).toBe(true);
    // MUL-383 itself stays excluded too.
    expect(excluded.has("iss_j67lb0r8djw4")).toBe(true);
  });

  it("adds the MUL-383 children the API reports on top of the constants", () => {
    const excluded = collectExcludedRunningIssueIds(["iss_child_a", "iss_child_b"]);
    expect(excluded.has("iss_o2skonppbq2u")).toBe(true);
    expect(excluded.has("iss_child_a")).toBe(true);
    expect(excluded.has("iss_child_b")).toBe(true);
    expect(excluded.size).toBe(4);
  });
});

// ── MUL-395 review `cmt_tf79501ls2zg` §4: fixtures write ids by hand
//    (`iss_zerojump_short`), and those have to normalize like generated ones.

describe("sanitizePath", () => {
  it("normalizes fixture ids whose suffix contains underscores", () => {
    // The local end-to-end report still showed `/api/issues/iss_zerojump_short`
    // because the suffix pattern stopped at `[A-Za-z0-9]+`.
    expect(sanitizePath("http://host/api/issues/iss_zerojump_short", "http://host", [])).toBe("/api/issues/:id");
    expect(sanitizePath("http://host/api/issues/iss_o2skonppbq2u/timeline", "http://host", [])).toBe("/api/issues/:id/timeline");
    expect(sanitizePath("/api/issues/iss_local_long", "http://host", [])).toBe("/api/issues/:id");
    expect(sanitizePath("http://host/api/inbox/inb_page2_ledger_17", "http://host", [])).toBe("/api/inbox/:id");
    // The rule the plan asks for is letters, digits and underscores after the
    // prefix. A hyphen is deliberately not part of it: no id in the repository
    // uses one, and widening it would start matching static segments such as
    // `agent-task-snapshot`.
    expect(sanitizePath("http://host/api/tasks/tsk_running_issue_1", "http://host", [])).toBe("/api/tasks/:id");
  });

  it("does not treat a hyphenated static-looking segment as an id", () => {
    // The boundary the wider underscore rule must not cross.
    expect(sanitizePath("/api/multiremi/agent-task-snapshot", "http://host", [])).toBe("/api/multiremi/agent-task-snapshot");
    expect(sanitizePath("/api/chat/pending-tasks", "http://host", [])).toBe("/api/chat/pending-tasks");
  });

  it("still normalizes generated ids and masks known identifiers by value", () => {
    expect(sanitizePath("http://host/api/issues/iss_abc123XYZ", "http://host", [])).toBe("/api/issues/:id");
    expect(sanitizePath("http://host/api/attachments/att_0f464c58dc2a/content", "http://host", [])).toBe("/api/attachments/:id/content");
    // `iss_in41j1x1dq66` is a real MUL-67 id, and the workspace slug has no shape
    // of its own, so both rely on the value list.
    expect(sanitizePath("http://host/api/issues/iss_in41j1x1dq66", "http://host", [])).toBe("/api/issues/:id");
    expect(sanitizePath("http://host/local/api/issues", "http://host", ["local"])).toBe("/:id/api/issues");
    // A key in `KEY-123` form (the issue identifier) is also id-like.
    expect(sanitizePath("http://host/api/issues/MUL-395", "http://host", [])).toBe("/api/issues/:id");
  });

  it("never writes the query string into the path", () => {
    // The token/secret carrier on every S1 request is the query string, so it must
    // not survive normalization.
    const path = sanitizePath(
      "http://host/api/issues/iss_zerojump_short?token=super-secret&cursor=abc123&x=1",
      "http://host",
      [],
    );
    expect(path).toBe("/api/issues/:id");
    expect(path).not.toContain("super-secret");
    expect(path).not.toContain("cursor");
    expect(path).not.toContain("?");
  });

  it("leaves static route segments alone", () => {
    // Two real static segments that carry a separator or a prefix-like shape.
    expect(sanitizePath("http://host/api/chat/pending-tasks", "http://host", [])).toBe("/api/chat/pending-tasks");
    expect(sanitizePath("http://host/api/multiremi/agent-task-snapshot", "http://host", [])).toBe("/api/multiremi/agent-task-snapshot");
    // Multi-segment static paths stay intact end to end.
    expect(sanitizePath("http://host/api/inbox/unread-count", "http://host", [])).toBe("/api/inbox/unread-count");
    expect(sanitizePath("http://host/api/issues/grouped", "http://host", [])).toBe("/api/issues/grouped");
  });

  it("cannot swallow any static segment of the real route table", () => {
    // The wider `<prefix>_...` rule was checked against the generated route table:
    // no static segment contains an underscore at all, so the rule can only ever
    // match an id. This test re-does that check from the repository's own snapshot
    // rather than trusting the earlier manual scan.
    const golden = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../../scripts/api-routes.golden.json"), "utf8"),
    ) as { routes: string[] } | string[];
    const routeList = Array.isArray(golden) ? golden : golden.routes;
    const segments = new Set<string>();
    for (const route of routeList) {
      const path = route.split(" ").pop() ?? "";
      for (const part of path.split("/")) {
        if (part && !part.startsWith(":")) segments.add(part);
      }
    }
    expect(segments.size).toBeGreaterThan(100);
    const swallowed = [...segments].filter((segment) => sanitizePath(`/api/${segment}`, "http://host", []) === "/api/:id");
    expect(swallowed).toEqual([]);
    // And every static segment survives unchanged, not merely "not an id".
    for (const segment of [...segments].slice(0, 200)) {
      expect(sanitizePath(`/api/${segment}`, "http://host", [])).toBe(`/api/${segment}`);
    }
  });
});
