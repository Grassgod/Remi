import { describe, expect, it } from "vitest";
import {
  LIVE_TIMER,
  formatElapsedMs,
  formatElapsedSecs,
  formatElapsedSince,
  formatTokens,
} from "./format";

describe("formatElapsedSecs", () => {
  it("prints bare seconds under a minute", () => {
    expect(formatElapsedSecs(0)).toBe("0s");
    expect(formatElapsedSecs(38)).toBe("38s");
    expect(formatElapsedSecs(59)).toBe("59s");
  });

  it("collapses a round minute by default so timers stay in lockstep", () => {
    expect(formatElapsedSecs(60)).toBe("1m");
    expect(formatElapsedSecs(180)).toBe("3m");
    expect(formatElapsedSecs(95)).toBe("1m 35s");
  });

  it("keeps the seconds segment when the caller asks", () => {
    expect(formatElapsedSecs(60, { collapseZeroSeconds: false })).toBe("1m 0s");
    expect(formatElapsedSecs(95, { collapseZeroSeconds: false })).toBe("1m 35s");
  });

  it("zero-pads for column alignment", () => {
    expect(
      formatElapsedSecs(65, { collapseZeroSeconds: false, pad: true })
    ).toBe("1m 05s");
    expect(
      formatElapsedSecs(95, { collapseZeroSeconds: false, pad: true })
    ).toBe("1m 35s");
  });

  it("rolls into an hours tier only when asked", () => {
    expect(formatElapsedSecs(3780, { collapseZeroSeconds: false })).toBe(
      "63m 0s"
    );
    expect(
      formatElapsedSecs(3780, { collapseZeroSeconds: false, hours: true })
    ).toBe("1h 3m");
    expect(
      formatElapsedSecs(3780, {
        collapseZeroSeconds: false,
        hours: true,
        pad: true,
      })
    ).toBe("1h 03m");
  });

  it("always prints minutes in the hours tier", () => {
    expect(formatElapsedSecs(3600, { hours: true, pad: true })).toBe("1h 00m");
  });
});

describe("formatElapsedMs", () => {
  it("rounds to the nearest second by default", () => {
    expect(formatElapsedMs(1500)).toBe("2s");
    expect(formatElapsedMs(1400)).toBe("1s");
  });

  it("floors for ticking timers so the reading never runs ahead", () => {
    expect(formatElapsedMs(1900, { rounding: "floor" })).toBe("1s");
    expect(formatElapsedMs(59_999, { rounding: "floor" })).toBe("59s");
  });

  it("clamps negative deltas to zero rather than printing '-1s'", () => {
    expect(formatElapsedMs(-5000)).toBe("0s");
  });

  it("carries the LIVE_TIMER preset used by every second-by-second timer", () => {
    expect(formatElapsedMs(180_000, LIVE_TIMER)).toBe("3m 0s");
    expect(formatElapsedMs(95_900, LIVE_TIMER)).toBe("1m 35s");
  });
});

describe("formatElapsedSince", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const startMs = Date.parse(start);

  it("measures from an ISO timestamp to the supplied now", () => {
    expect(formatElapsedSince(start, startMs + 45_000)).toBe("45s");
    expect(formatElapsedSince(start, startMs + 125_000, LIVE_TIMER)).toBe(
      "2m 5s"
    );
  });

  it("reads as 'no reading' rather than 'NaNs' for a broken timestamp", () => {
    expect(formatElapsedSince("not-a-date", startMs)).toBe("");
  });
});

describe("formatTokens", () => {
  it("prints small counts in full", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(842)).toBe("842");
  });

  it("drops the decimal on near-integer thousands", () => {
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(2_040)).toBe("2K");
    expect(formatTokens(1_500)).toBe("1.5K");
  });

  it("has a millions tier — 2.4M must not render as 2400.0k", () => {
    expect(formatTokens(2_400_000)).toBe("2.4M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });
});
