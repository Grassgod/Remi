/**
 * The pure verdict half of the MUL-394 zero-jump check.
 *
 * The check's job is to fail CI the moment a page moves during load. On main
 * today several `key::mode` rows are *known* to violate (MUL-403's C8/C9/C9b
 * own the fixes, and nothing writes `data-perf-state` yet), so a hard gate
 * would be red from the first commit and protect nothing. Instead main carries
 * a reviewed allowlist of debt: one row per known-failing `key::mode`, naming
 * exactly which violation kinds it is allowed to show. Everything outside that
 * list fails immediately, and the listed kinds may only shrink.
 *
 * Kept pure and separate from the driver so the four rules below are unit
 * tested without a browser, a build or a server.
 *
 * Rules, in the order the review names them:
 *   a. A row that is not listed and violates → fail.
 *   b. A listed row that shows a kind it did not list → fail.
 *   c. A listed kind that does not appear in any of the repetitions → fail,
 *      telling the reader to drop the kind (and the row once it is empty).
 *      Partial appearances (2 of 3) do not trip this: only 0 of N does.
 *   d. `--strict` ignores the allowlist: every row is judged by rule a.
 */

/** One violation kind a `key::mode` row can carry. */
export type ZeroJumpViolation = "jumps" | "anchor" | "skeleton" | "perf-state";

export const ZERO_JUMP_VIOLATIONS: readonly ZeroJumpViolation[] = ["jumps", "anchor", "skeleton", "perf-state"];

/** The pair key the report's `--compare` already uses, so the two stay in step. */
export function zeroJumpPairKey(row: { key: string; mode: string }): string {
  return `${row.key}::${row.mode}`;
}

export interface ZeroJumpAllowlistRow {
  key: string;
  mode: string;
  /** Violation kinds this row is still allowed to show. Must be non-empty. */
  violations: ZeroJumpViolation[];
  /** Why the row is still allowed to fail. */
  reason: string;
  /** The issue that owns the fix. Not read by the verdict logic. */
  owner: string;
  /** The `key::mode` pair this row covers, derived so the two cannot drift. */
  pair?: string;
}

export interface ZeroJumpAllowlist {
  rows: ZeroJumpAllowlistRow[];
}

/**
 * Violation kinds observed for one `key::mode` across its repetitions.
 *
 * `observed` is per repetition so rule c can tell "never seen" (0 of N) from
 * "seen once" (1 of N) — the ruling only trips on the former.
 */
export interface ZeroJumpRowResult {
  key: string;
  mode: string;
  repetitions: number;
  /** Violation kinds in each repetition, in repetition order. */
  observed: ZeroJumpViolation[][];
}

export interface ZeroJumpRowFailure {
  key: string;
  mode: string;
  /** The rule that produced this failure, for the message and the tests. */
  rule: "unlisted-violation" | "unexpected-kind" | "stale-kind";
  /** Violation kinds the row showed that it was not allowed to show. */
  violations: ZeroJumpViolation[];
  /** Violation kinds the allowlist expected but that never appeared (rule c). */
  staleViolations: ZeroJumpViolation[];
  message: string;
}

export interface ZeroJumpVerdict {
  ok: boolean;
  failures: ZeroJumpRowFailure[];
  /** Rows the allowlist covers that were present in the run, for the log line. */
  checkedPairs: string[];
}

/** Kinds in `row.violations` order, so messages and tests read predictably. */
function sortedKinds(kinds: Iterable<ZeroJumpViolation>): ZeroJumpViolation[] {
  const set = new Set(kinds);
  return ZERO_JUMP_VIOLATIONS.filter((kind) => set.has(kind));
}

/**
 * Decide one run against the allowlist.
 *
 * `strict` is rule d: the allowlist is ignored entirely and every violation is
 * reported, which is the mode that must fail on unfixed code.
 */
export function judgeZeroJumpRun(input: {
  results: ZeroJumpRowResult[];
  allowlist: ZeroJumpAllowlist;
  strict: boolean;
}): ZeroJumpVerdict {
  const { results, strict } = input;
  const allowlist = strict ? { rows: [] } : input.allowlist;
  const byPair = new Map(allowlist.rows.map((row) => [zeroJumpPairKey(row), row]));
  const failures: ZeroJumpRowFailure[] = [];
  const checkedPairs: string[] = [];

  for (const result of results) {
    const pair = zeroJumpPairKey(result);
    const perRepetition = result.observed.map((kinds) => sortedKinds(kinds));
    const everSeen = sortedKinds(perRepetition.flat());
    const row = byPair.get(pair);

    if (!row) {
      // Rule a (and rule d, which routes every row here).
      if (everSeen.length > 0) {
        failures.push({
          key: result.key,
          mode: result.mode,
          rule: "unlisted-violation",
          violations: everSeen,
          staleViolations: [],
          message: strict
            ? `${pair} violated ${everSeen.join(", ")} — strict mode ignores the allowlist`
            : `${pair} violated ${everSeen.join(", ")} and is not in tests/integration/zero-jump-known-failures.json`,
        });
      }
      continue;
    }

    checkedPairs.push(pair);
    const allowed = new Set(row.violations);

    // Rule b: a kind this row did not list.
    const unexpected = everSeen.filter((kind) => !allowed.has(kind));
    if (unexpected.length > 0) {
      failures.push({
        key: result.key,
        mode: result.mode,
        rule: "unexpected-kind",
        violations: unexpected,
        staleViolations: [],
        message: `${pair} showed ${unexpected.join(", ")}, which its allowlist row does not list`,
      });
    }

    // Rule c: a listed kind that never appeared. Only 0 of N trips this.
    const seen = new Set(everSeen);
    const stale = row.violations.filter((kind) => !seen.has(kind));
    if (stale.length > 0) {
      failures.push({
        key: result.key,
        mode: result.mode,
        rule: "stale-kind",
        violations: [],
        staleViolations: sortedKinds(stale),
        message: `${pair} did not show ${stale.join(", ")} in any of its ${result.repetitions} repetition(s): `
          + `${stale.length === row.violations.length
            ? "remove the whole row"
            : `remove the ${stale.join(", ")} kind, and remove the whole row if that empties its list`} `
          + "from tests/integration/zero-jump-known-failures.json",
      });
    }
  }

  return { ok: failures.length === 0, failures, checkedPairs };
}

/**
 * Fail loudly on an allowlist that cannot be judged: a row without a reason or
 * owner, a duplicate pair, or an unknown violation kind. A broken debt record
 * must not read as "nothing to check".
 */
export function validateZeroJumpAllowlist(allowlist: ZeroJumpAllowlist): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of allowlist.rows) {
    const pair = zeroJumpPairKey(row);
    if (seen.has(pair)) problems.push(`${pair}: duplicate row`);
    seen.add(pair);
    if (!row.reason?.trim()) problems.push(`${pair}: missing reason`);
    if (!row.owner?.trim()) problems.push(`${pair}: missing owner`);
    if (row.violations.length === 0) problems.push(`${pair}: empty violations list`);
    for (const kind of row.violations) {
      if (!ZERO_JUMP_VIOLATIONS.includes(kind)) problems.push(`${pair}: unknown violation kind ${String(kind)}`);
    }
  }
  return problems;
}
