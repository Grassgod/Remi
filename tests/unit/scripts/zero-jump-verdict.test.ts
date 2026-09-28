/**
 * Unit tests for the MUL-394 allowlist verdict.
 *
 * The four rules the ruling fixes are the four `describe` blocks below. They are
 * pure, so the check's gate can be pinned here — against a browser-free fixture —
 * instead of only through a 9-scenario Chromium run.
 */
import { describe, expect, it } from "bun:test";
import {
  allowlistWithinBaseline,
  judgeZeroJumpRun,
  validateZeroJumpAllowlist,
  zeroJumpPairKey,
  type ZeroJumpAllowlist,
  type ZeroJumpRowResult,
  type ZeroJumpViolation,
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
    // The row count is deliberately not asserted to be positive: shrinking the
    // record is the documented direction, and MUL-390 took it to zero by fixing
    // all nine rows. Well-formedness is what this test owns — a row that exists
    // must still name its owner and its reason.
    expect(Array.isArray(allowlist.rows)).toBe(true);
    expect(validateZeroJumpAllowlist(allowlist)).toEqual([]);
    // Every row names the issue that owns its fix.
    for (const row of allowlist.rows) {
      expect(row.owner.trim()).not.toBe("");
      expect(row.reason.trim()).not.toBe("");
    }
  });

  // "Does this run match its allowlist?" is enforced by the check itself on every
  // CI run (rules a-c, judgeZeroJumpRun). What no run can enforce is the ratchet:
  // the debt record must never *grow* past the frozen baseline. Kept one-way on
  // purpose — equality would fail the moment anyone fixes a kind and deletes it,
  // which is exactly the flow the allowlist exists to carry.
  it("only narrows the strict baseline", async () => {
    const allowlist = JSON.parse(await Bun.file(allowlistPath).text()) as ZeroJumpAllowlist;
    const report = JSON.parse(await Bun.file(strictReportPath).text()) as {
      strict: boolean;
      rows: Array<{ pair: string; observed: string[][] }>;
    };
    expect(report.strict).toBe(true);

    const baselineRows = report.rows.map((row) => ({
      pair: row.pair,
      violations: [...new Set(row.observed.flat())] as ZeroJumpViolation[],
    }));
    expect(baselineRows.length).toBeGreaterThan(0);
    expect(allowlistWithinBaseline(allowlist, baselineRows)).toEqual([]);

    // The shipped allowlist covered every baseline row when it was written, and
    // a stricter reading was meaningful then: nothing had been silently dropped.
    // A shrink is the documented direction and MUL-390 took it all the way to an
    // empty record, so the size assertion is gone on purpose; what survives is
    // the invariant that anything still listed must be a baseline pair.
    const baselinePairs = new Set(baselineRows.map((row) => row.pair));
    const allowlistPairs = new Set(allowlist.rows.map((row) => zeroJumpPairKey(row)));
    for (const pair of allowlistPairs) expect(baselinePairs.has(pair)).toBe(true);
  });

  it("allows the documented shrink of a kind and of a whole row", async () => {
    const allowlist = JSON.parse(await Bun.file(allowlistPath).text()) as ZeroJumpAllowlist;
    const report = JSON.parse(await Bun.file(strictReportPath).text()) as {
      rows: Array<{ pair: string; observed: string[][] }>;
    };
    const baselineRows = report.rows.map((row) => ({
      pair: row.pair,
      violations: [...new Set(row.observed.flat())] as ZeroJumpViolation[],
    }));

    // Drop the deep link's `jumps` and one whole row: both are legitimate.
    const narrowed: ZeroJumpAllowlist = {
      rows: allowlist.rows
        .filter((row) => !(row.key === "detail-long" && row.mode === "cold"))
        .map((row) => row.key === "detail-deeplink" && row.mode === "cold"
          ? { ...row, violations: row.violations.filter((kind) => kind !== "jumps") }
          : row),
    };
    expect(allowlistWithinBaseline(narrowed, baselineRows)).toEqual([]);
  });

  // The sidebar round shares an issue with `detail-long` but is a different
  // mechanism, so the harness has to key it separately or the debt record could
  // not say which of the two is fixed. Asserted against the frozen baseline,
  // which is where "the harness produced these keys" is a stable fact; asserting
  // it against the allowlist would forbid dropping a row once it is fixed.
  it("keys the deep link and the sidebar round as their own rows", async () => {
    const report = JSON.parse(await Bun.file(strictReportPath).text()) as {
      rows: Array<{ pair: string }>;
    };
    const baselinePairs = report.rows.map((row) => row.pair);
    expect(baselinePairs).toContain("detail-long-sidebar::cold");
    expect(baselinePairs).toContain("detail-long::cold");
    expect(baselinePairs).toContain("detail-deeplink::cold");
    // The sidebar round is cold-only, so its warm shape must never appear.
    expect(baselinePairs).not.toContain("detail-long-sidebar::warm");

    // Whatever the allowlist still carries must keep those keys distinct: a row
    // keyed `detail-long-sidebar` may only be the cold round.
    const allowlist = JSON.parse(await Bun.file(allowlistPath).text()) as ZeroJumpAllowlist;
    for (const row of allowlist.rows) {
      if (row.key !== "detail-long-sidebar") continue;
      expect(row.mode).toBe("cold");
      expect(zeroJumpPairKey(row)).toBe("detail-long-sidebar::cold");
    }
  });
});

describe("zero jump verdict — the baseline ratchet", () => {
  // Synthetic data, so the three directions are pinned without depending on what
  // main happens to look like today.
  const baseline = [
    { pair: "detail-deeplink::cold", violations: ["jumps", "perf-state"] as ZeroJumpViolation[] },
    { pair: "detail-long::cold", violations: ["perf-state"] as ZeroJumpViolation[] },
  ];

  it("passes when a row drops a kind the baseline had", () => {
    const narrowed = allowlist({
      key: "detail-deeplink",
      mode: "cold",
      violations: ["perf-state"],
      reason: "r",
      owner: "MUL-393",
    });
    expect(allowlistWithinBaseline(narrowed, baseline)).toEqual([]);
  });

  it("passes when a whole row is dropped", () => {
    const narrowed = allowlist({
      key: "detail-long",
      mode: "cold",
      violations: ["perf-state"],
      reason: "r",
      owner: "MUL-443",
    });
    expect(allowlistWithinBaseline(narrowed, baseline)).toEqual([]);
  });

  it("passes for an empty allowlist", () => {
    expect(allowlistWithinBaseline(allowlist(), baseline)).toEqual([]);
  });

  it("fails when the allowlist adds a row the baseline never had", () => {
    const grown = allowlist({
      key: "detail-short",
      mode: "cold",
      violations: ["perf-state"],
      reason: "r",
      owner: "MUL-443",
    });
    const problems = allowlistWithinBaseline(grown, baseline);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("detail-short::cold");
    expect(problems[0]).toContain("not in the strict baseline");
  });

  it("fails when a row adds a kind the baseline never had for it", () => {
    const grown = allowlist({
      key: "detail-long",
      mode: "cold",
      violations: ["perf-state", "skeleton"],
      reason: "r",
      owner: "MUL-443",
    });
    const problems = allowlistWithinBaseline(grown, baseline);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("detail-long::cold");
    expect(problems[0]).toContain("skeleton");
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
