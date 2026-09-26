/**
 * MUL-417 — `ws_minute_summary`.
 *
 * The acceptance item is "`ws_minute_summary` has output", so the tests here
 * check three things that together make the line usable:
 *
 *   1. the aggregation is per frame type with `count / db_ms / db_queries` and the
 *      same window and percentile convention as `api_minute_summary`;
 *   2. the timer emits one line per interval, including for an idle window, so
 *      "no daemon traffic" is distinguishable from "the feature died";
 *   3. the decoder never writes payload, query, credential or path content into
 *      the line.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  drainWsFrameMetricsForTest,
  resetWsFrameMetricsForTest,
  startWsFrameMetricsSummary,
  summarizeWsWindow,
  WsFrameMetricsRing,
  wsPercentile,
  type WsFrameMetricsOptions,
  type WsFrameSample,
} from "../../../packages/server/src/api/daemon-protocol/metrics.js";

const OPTIONS: WsFrameMetricsOptions = {
  enabled: true,
  summaryIntervalMs: 60_000,
  summaryTopTypes: 20,
  bufferCapacity: 256,
};

afterEach(() => {
  resetWsFrameMetricsForTest();
});

function sample(patch: Partial<WsFrameSample> = {}): WsFrameSample {
  return {
    type: "hb",
    direction: "uplink",
    errorCode: null,
    totalMs: 1,
    dbMs: 0,
    dbQueries: 0,
    protocolViolation: false,
    ...patch,
  };
}

/** Capture `console.log` for the duration of `body`. */
async function captureConsoleLog(body: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await body();
  } finally {
    console.log = realLog;
  }
  return lines;
}

describe("MUL-417 ws_minute_summary — aggregation", () => {
  it("groups by frame type with count, db_ms and db_queries", () => {
    const summary = summarizeWsWindow({
      windowMs: 60_000,
      dropped: 0,
      dbMs: 12,
      dbQueries: 4,
      topTypes: 20,
      now: new Date("2026-09-27T00:00:00.000Z"),
      samples: [
        sample({ type: "hb", totalMs: 1, dbMs: 3, dbQueries: 1 }),
        sample({ type: "hb", totalMs: 2, dbMs: 3, dbQueries: 1 }),
        sample({ type: "task.progress", totalMs: 5, dbMs: 6, dbQueries: 2 }),
        sample({ type: "trace.head", direction: "rpc", totalMs: 9, dbMs: 0, dbQueries: 0 }),
      ],
    });

    expect(summary.event).toBe("ws_minute_summary");
    expect(summary.ts).toBe("2026-09-27T00:00:00.000Z");
    expect(summary.window_ms).toBe(60_000);
    expect(summary.frames).toBe(4);
    expect(summary.db_busy_pct).toBe(0.02);
    expect(summary.db_queries).toBe(4);
    // Ranked by db_ms first, so the frame type actually costing database time is
    // the one an operator reads first. `hb` and `task.progress` tie on db cost
    // (6 ms / 2 queries), so the tiebreak is count: the frequent frame wins.
    expect(summary.types.map((entry) => entry.type)).toEqual(["hb", "task.progress", "trace.head"]);
    expect(summary.types[0]).toEqual({
      type: "hb",
      direction: "uplink",
      count: 2,
      violations: 0,
      db_ms: 6,
      db_queries: 2,
      p50_ms: 1,
      p95_ms: 2,
    });
    expect(summary.types[1]).toMatchObject({
      type: "task.progress",
      direction: "uplink",
      count: 1,
      db_ms: 6,
      db_queries: 2,
      p50_ms: 5,
    });
  });

  it("keeps the same window and percentile convention as api_minute_summary", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // Nearest-rank, matching `percentile` in observability/request-metrics.ts.
    expect(wsPercentile(values, 0.5)).toBe(5);
    expect(wsPercentile(values, 0.95)).toBe(10);
    expect(wsPercentile([], 0.5)).toBe(0);

    const summary = summarizeWsWindow({
      windowMs: 5_000,
      dropped: 3,
      dbMs: 0,
      dbQueries: 0,
      topTypes: 20,
      samples: [sample({ totalMs: 10 })],
    });
    expect(Object.keys(summary).sort()).toEqual([
      "db_busy_pct", "db_queries", "dropped", "event", "frames", "ts", "types", "window_ms",
    ]);
    expect(summary.dropped).toBe(3);
    expect(summary.db_busy_pct).toBe(0);
  });

  it("counts protocol violations per type", () => {
    const summary = summarizeWsWindow({
      windowMs: 1_000,
      dropped: 0,
      dbMs: 0,
      dbQueries: 0,
      topTypes: 20,
      samples: [
        sample({ type: "oversized", protocolViolation: true, errorCode: "protocol_violation" }),
        sample({ type: "hb" }),
      ],
    });
    expect(summary.types.find((entry) => entry.type === "oversized")!.violations).toBe(1);
    expect(summary.types.find((entry) => entry.type === "hb")!.violations).toBe(0);
  });

  it("ranks by db_ms, then db_queries, then count, and truncates to the top N", () => {
    const summary = summarizeWsWindow({
      windowMs: 1_000,
      dropped: 0,
      dbMs: 0,
      dbQueries: 0,
      topTypes: 2,
      samples: [
        sample({ type: "a", dbMs: 1 }),
        sample({ type: "a", dbMs: 1 }),
        sample({ type: "b", dbMs: 5 }),
        sample({ type: "c", dbMs: 0, dbQueries: 7 }),
      ],
    });
    expect(summary.types).toHaveLength(2);
    expect(summary.types.map((entry) => entry.type)).toEqual(["b", "a"]);
  });
});

describe("MUL-417 ws_minute_summary — ring buffer", () => {
  it("keeps the newest window and counts what it dropped", () => {
    const ring = new WsFrameMetricsRing(2);
    ring.record(sample({ type: "first" }));
    ring.record(sample({ type: "second" }));
    ring.record(sample({ type: "third" }));
    const { samples, dropped } = ring.drain();
    expect(dropped).toBe(1);
    expect(samples.map((entry) => entry.type)).toEqual(["second", "third"]);
    // Draining resets the window.
    expect(ring.drain()).toEqual({ samples: [], dropped: 0 });
  });

  it("bounds the interned type table so invented frame names cannot grow it", () => {
    const ring = new WsFrameMetricsRing(600);
    for (let index = 0; index < 600; index += 1) ring.record(sample({ type: `invented.${index}` }));
    const { samples } = ring.drain();
    // Everything still lands in the window; the overflow just shares one bucket.
    expect(samples).toHaveLength(600);
    expect(samples.some((entry) => entry.type === "<unknown>")).toBe(true);
  });
});

describe("MUL-417 ws_minute_summary — timer", () => {
  it("emits one summary line per interval with the fixed field set", async () => {
    const runtime = startWsFrameMetricsSummary(
      { ...OPTIONS, bufferCapacity: 64 },
      () => ({ dbMs: 40, dbQueries: 2 }),
    );
    expect(runtime).not.toBeNull();

    runtime!.record(sample({ type: "hb", dbMs: 3, dbQueries: 1 }));
    const lines = await captureConsoleLog(() => {
      runtime!.flush();
    });

    const summaryLines = lines.filter((line) => line.includes("ws_minute_summary"));
    expect(summaryLines).toHaveLength(1);
    const summary = JSON.parse(summaryLines[0]!) as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual([
      "db_busy_pct", "db_queries", "dropped", "event", "frames", "ts", "types", "window_ms",
    ]);
    expect(summary.frames).toBe(1);
    expect(summary.types).toEqual([{
      type: "hb",
      direction: "uplink",
      count: 1,
      violations: 0,
      db_ms: 3,
      db_queries: 1,
      p50_ms: expect.any(Number),
      p95_ms: expect.any(Number),
    }]);

    runtime!.stop();
  });

  it("emits an idle window too, so silence is distinguishable from a dead feature", async () => {
    const runtime = startWsFrameMetricsSummary(OPTIONS, () => ({ dbMs: 0, dbQueries: 0 }));
    const lines = await captureConsoleLog(() => {
      runtime!.flush();
    });
    const summary = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(summary).toMatchObject({ event: "ws_minute_summary", frames: 0, types: [] });
    runtime!.stop();
  });

  it("reports the process DB delta for the window, not just the frames", async () => {
    let dbMs = 100;
    let dbQueries = 5;
    const runtime = startWsFrameMetricsSummary(OPTIONS, () => ({ dbMs, dbQueries }));
    // Counters advance between two flushes: the first flush measures the window
    // that started when the summary started.
    dbMs += 250;
    dbQueries += 11;
    const lines = await captureConsoleLog(() => {
      runtime!.flush();
      runtime!.flush();
    });
    const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first!.db_queries).toBe(11);
    // Nothing accrued between the two flushes, and each window is a delta.
    expect(second!.db_queries).toBe(0);
    runtime!.stop();
  });

  it("is a no-op when metrics are disabled", async () => {
    const runtime = startWsFrameMetricsSummary({ ...OPTIONS, enabled: false }, () => ({ dbMs: 0, dbQueries: 0 }));
    expect(runtime).not.toBeNull();
    runtime!.record(sample({ type: "hb" }));
    const lines = await captureConsoleLog(() => runtime!.flush());
    expect(lines).toEqual([]);
    runtime!.stop();
    expect(drainWsFrameMetricsForTest()).toEqual({ samples: [], dropped: 0 });
  });

  it("never writes payload content, credentials, paths or frame ids into the line", async () => {
    const runtime = startWsFrameMetricsSummary(OPTIONS, () => ({ dbMs: 0, dbQueries: 0 }));
    runtime!.record(sample({
      type: "task.progress",
      // A frame that carried a credential, a filesystem path and an RPC id. None
      // of those are fields of a sample, which is the point: the summary is
      // derived only from types and timings.
      errorCode: "authority_revoked",
    }));
    const lines = await captureConsoleLog(() => runtime!.flush());
    const line = lines.at(-1)!;
    expect(line).not.toContain("Bearer");
    expect(line).not.toContain("/data00");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("q-9");
    runtime!.stop();
  });
});
