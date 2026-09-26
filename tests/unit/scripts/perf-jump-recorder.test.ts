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
import { buildHtml, buildMarkdown } from "../../../frontend/scripts/perf/lib/report";
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
    expect(md).toContain("| 拦截写请求 | 桩写请求 | URL 提交 ms | 目标前置 | 前置前 inbox 请求 | error |");
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
    const injected = injectInboxTarget(body, target, { hasCursor: false }) as { items: unknown[] };
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
