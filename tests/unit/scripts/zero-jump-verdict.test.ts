/**
 * Unit tests for the MUL-394 allowlist verdict.
 *
 * The four rules the ruling fixes are the four `describe` blocks below. They are
 * pure, so the check's gate can be pinned here — against a browser-free fixture —
 * instead of only through a 9-scenario Chromium run.
 */
import { describe, expect, it } from "bun:test";
import {
  judgeZeroJumpRun,
  validateZeroJumpAllowlist,
  zeroJumpPairKey,
  type ZeroJumpAllowlist,
  type ZeroJumpRowResult,
} from "../../../frontend/scripts/perf/lib/zero-jump-verdict";

/** One row of a run: the kinds each repetition showed. */
function row(key: string, mode: string, perRepetition: ZeroJumpRowResult["observed"]): ZeroJumpRowResult {
  return { key, mode, repetitions: perRepetition.length, observed: perRepetition };
}

function allowlist(...rows: ZeroJumpAllowlist["rows"]): ZeroJumpAllowlist {
  return { rows };
}

const LISTED = allowlist({
  key: "detail-long",
  mode: "cold",
  violations: ["jumps", "perf-state"],
  reason: "MUL-443 owns the reveal; nothing writes data-perf-state on main yet",
  owner: "MUL-443",
});

describe("zero jump verdict — rule a: an unlisted row that violates fails", () => {
  it("fails a row the allowlist does not cover", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-short", "cold", [["jumps"], [], []])],
      allowlist: LISTED,
      strict: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatchObject({
      rule: "unlisted-violation",
      key: "detail-short",
      mode: "cold",
      violations: ["jumps"],
    });
  });

  it("passes an unlisted row that never violates", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-short", "cold", [[], [], []])],
      allowlist: LISTED,
      strict: false,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("treats a single repetition of one kind as a violation", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-short", "warm", [[], ["skeleton"], []])],
      allowlist: allowlist(),
      strict: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]!.violations).toEqual(["skeleton"]);
  });
});

describe("zero jump verdict — rule b: a listed row may only show the kinds it lists", () => {
  it("fails when a listed row shows a kind its row does not list", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-long", "cold", [["jumps"], ["anchor", "perf-state"], ["jumps", "perf-state"]])],
      allowlist: LISTED,
      strict: false,
    });
    expect(verdict.ok).toBe(false);
    // Only rule b: both listed kinds appear somewhere, so rule c stays quiet.
    expect(verdict.failures.map((failure) => failure.rule)).toEqual(["unexpected-kind"]);
    expect(verdict.failures[0]!.violations).toEqual(["anchor"]);
  });

  it("passes when the listed row only shows the kinds it lists", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-long", "cold", [["jumps"], ["jumps", "perf-state"], []])],
      allowlist: LISTED,
      strict: false,
    });
    expect(verdict.ok).toBe(true);
  });

  it("narrows to the unexpected kind when a listed one also appears", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-long", "cold", [["jumps", "anchor", "perf-state"], ["jumps"], ["perf-state"]])],
      allowlist: LISTED,
      strict: false,
    });
    const failure = verdict.failures.find((candidate) => candidate.rule === "unexpected-kind");
    expect(failure?.violations).toEqual(["anchor"]);
  });
});

describe("zero jump verdict — rule c: a listed kind that never appears is stale", () => {
  it("fails when a listed kind did not appear in any repetition", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-long", "cold", [["jumps"], ["jumps"], ["jumps"]])],
      allowlist: LISTED,
      strict: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatchObject({ rule: "stale-kind", staleViolations: ["perf-state"] });
    expect(verdict.failures[0]!.message).toContain("remove the perf-state kind");
  });

  it("does not trip on a partial appearance", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-long", "cold", [["jumps"], ["perf-state"], []])],
      allowlist: LISTED,
      strict: false,
    });
    expect(verdict.ok).toBe(true);
  });

  it("asks for the whole row to be deleted once every kind is stale", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-long", "cold", [[], [], []])],
      allowlist: LISTED,
      strict: false,
    });
    expect(verdict.failures[0]).toMatchObject({ rule: "stale-kind", staleViolations: ["jumps", "perf-state"] });
  });
});

describe("zero jump verdict — rule d: strict ignores the allowlist", () => {
  it("fails a listed row exactly like an unlisted one", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-long", "cold", [["jumps"], ["jumps"], ["jumps"]])],
      allowlist: LISTED,
      strict: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toMatchObject({ rule: "unlisted-violation", violations: ["jumps"] });
    expect(verdict.failures[0]!.message).toContain("strict");
  });

  it("passes a clean run even in strict mode", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-long", "cold", [[], [], []])],
      allowlist: LISTED,
      strict: true,
    });
    expect(verdict.ok).toBe(true);
  });

  it("does not raise rule-c staleness in strict mode", () => {
    const verdict = judgeZeroJumpRun({
      results: [row("detail-long", "cold", [[], [], []])],
      allowlist: LISTED,
      strict: true,
    });
    expect(verdict.failures).toEqual([]);
  });
});

describe("zero jump verdict — the shipped allowlist", () => {
  // The ruling's consistency requirement: the allowlist and a strict run must
  // describe the same rows with the same kinds, or the default job goes red
  // (unlisted violation) or trips rule c (stale kind). These two files are the
  // pair that has to agree, so the agreement is asserted here rather than only
  // by eye.
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const allowlistPath = `${repoRoot}tests/integration/zero-jump-known-failures.json`;
  const strictReportPath =
    `${repoRoot}reports/performance/MUL-394-zero-jump-strict-main-2026-09-26.json`;

  it("is a well-formed debt record", async () => {
    const allowlist = JSON.parse(await Bun.file(allowlistPath).text()) as ZeroJumpAllowlist;
    expect(allowlist.rows.length).toBeGreaterThan(0);
    expect(validateZeroJumpAllowlist(allowlist)).toEqual([]);
    // Every row names the issue that owns its fix.
    for (const row of allowlist.rows) {
      expect(row.owner.trim()).not.toBe("");
      expect(row.reason.trim()).not.toBe("");
    }
  });

  it("matches the strict run on main one-to-one", async () => {
    const allowlist = JSON.parse(await Bun.file(allowlistPath).text()) as ZeroJumpAllowlist;
    const report = JSON.parse(await Bun.file(strictReportPath).text()) as {
      strict: boolean;
      rows: Array<{ pair: string; observed: string[][] }>;
    };
    expect(report.strict).toBe(true);

    const strictPairs = new Map<string, Set<string>>();
    for (const row of report.rows) {
      const kinds = new Set(row.observed.flat());
      strictPairs.set(row.pair, kinds);
    }
    const allowlistPairs = new Map(
      allowlist.rows.map((row) => [zeroJumpPairKey(row), new Set<string>(row.violations)]),
    );

    expect([...strictPairs.keys()].sort()).toEqual([...allowlistPairs.keys()].sort());
    for (const [pair, kinds] of strictPairs) {
      expect([...kinds].sort()).toEqual([...(allowlistPairs.get(pair) ?? new Set<string>())].sort());
    }
  });

  it("keys the deep link and the sidebar round as their own rows", async () => {
    const allowlist = JSON.parse(await Bun.file(allowlistPath).text()) as ZeroJumpAllowlist;
    const pairs = allowlist.rows.map((row) => zeroJumpPairKey(row));
    // The sidebar round shares an issue with `detail-long` but must not share
    // its row, or the allowlist could not say which mechanism is fixed.
    expect(pairs).toContain("detail-long-sidebar::cold");
    expect(pairs).toContain("detail-long::cold");
    expect(pairs).not.toContain("detail-long-sidebar::warm");
  });
});

describe("zero jump verdict — allowlist integrity", () => {
  it("reports a duplicate pair, a missing owner or reason, and an unknown kind", () => {
    const problems = validateZeroJumpAllowlist(allowlist(
      { key: "detail-long", mode: "cold", violations: ["jumps"], reason: "", owner: "MUL-443" },
      { key: "detail-long", mode: "cold", violations: ["nonsense" as never], reason: "r", owner: "" },
    ));
    expect(problems.some((problem) => problem.includes("missing reason"))).toBe(true);
    expect(problems.some((problem) => problem.includes("duplicate"))).toBe(true);
    expect(problems.some((problem) => problem.includes("missing owner"))).toBe(true);
    expect(problems.some((problem) => problem.includes("unknown violation kind"))).toBe(true);
  });

  it("accepts a well-formed row", () => {
    expect(validateZeroJumpAllowlist(LISTED)).toEqual([]);
  });

  it("keys rows exactly like the report's compare pairing does", () => {
    expect(zeroJumpPairKey({ key: "detail-deeplink", mode: "cold" })).toBe("detail-deeplink::cold");
  });
});
