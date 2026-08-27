/**
 * The workspace's elapsed-duration and token-count formatters.
 *
 * Both used to exist as half a dozen private copies each, which is how the
 * same number ended up rendering three different ways depending on which
 * panel the user was looking at. Everything here is one implementation with
 * options for the differences that are real (padded columns, an hours tier,
 * whether a round minute prints as "3m" or "3m 0s").
 */

export interface ElapsedFormatOptions {
  /**
   * Print a round minute as "3m" rather than "3m 0s". Default `true` — the
   * chat timers collapse so the live pill and the final caption read the
   * same. Fixed-width columns and always-ticking timers pass `false`.
   */
  collapseZeroSeconds?: boolean;
  /** Zero-pad the trailing unit ("2m 05s", "1h 03m") so columns align. */
  pad?: boolean;
  /** Roll past 60 minutes into "1h 03m" instead of "63m 12s". */
  hours?: boolean;
}

function pad2(n: number, pad: boolean): string {
  return pad && n < 10 ? `0${n}` : String(n);
}

/**
 * Format an elapsed whole-seconds value as `Ns`, `Nm Ms` or (with `hours`)
 * `Nh Mm`.
 */
export function formatElapsedSecs(
  secs: number,
  { collapseZeroSeconds = true, pad = false, hours = false }: ElapsedFormatOptions = {}
): string {
  if (secs < 60) return `${secs}s`;
  const totalMinutes = Math.floor(secs / 60);
  if (hours && totalMinutes >= 60) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    // The hours tier always prints minutes: "1h 00m" reads as a duration,
    // "1h" reads as a rounded estimate.
    return `${h}h ${pad2(m, pad)}m`;
  }
  const s = secs % 60;
  if (collapseZeroSeconds && s === 0) return `${totalMinutes}m`;
  return `${totalMinutes}m ${pad2(s, pad)}s`;
}

/**
 * Same formatting, but the input is milliseconds (server-stored `elapsed_ms`,
 * or a `Date.now()` delta).
 *
 * `rounding` decides how the millisecond remainder collapses into whole
 * seconds. Timers that count up from a start instant floor, so the reading
 * never jumps ahead of the wall clock; persisted totals round to nearest.
 */
export function formatElapsedMs(
  ms: number,
  {
    rounding = "nearest",
    ...opts
  }: ElapsedFormatOptions & { rounding?: "nearest" | "floor" } = {}
): string {
  const safeMs = Math.max(0, ms);
  const secs =
    rounding === "floor"
      ? Math.floor(safeMs / 1000)
      : Math.round(safeMs / 1000);
  return formatElapsedSecs(secs, opts);
}

/**
 * The flavour every second-by-second ticking timer uses: floor, so the reading
 * never runs ahead of the wall clock, and keep the seconds segment on round
 * minutes — "3m" next to a live "3m 1s" looks frozen.
 */
export const LIVE_TIMER: ElapsedFormatOptions & { rounding: "floor" } = {
  rounding: "floor",
  collapseZeroSeconds: false,
};

/**
 * Elapsed time since an ISO timestamp. Returns `""` for an unparseable
 * timestamp rather than "NaNs" — a broken date should read as "no reading",
 * not as a number.
 */
export function formatElapsedSince(
  startedAt: string,
  nowMs: number = Date.now(),
  opts: ElapsedFormatOptions & { rounding?: "nearest" | "floor" } = {}
): string {
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return "";
  return formatElapsedMs(nowMs - start, opts);
}

/** Compact-notation tiers, largest first. */
const TOKEN_TIERS = [
  { unit: 1_000_000_000_000, suffix: "T" },
  { unit: 1_000_000_000, suffix: "B" },
  { unit: 1_000_000, suffix: "M" },
  { unit: 1_000, suffix: "K" },
] as const;

/**
 * Compact token count: `1.5K` / `2M` / `1.4B` / `1T` / `842`.
 *
 * The tier is chosen from the *rounded* reading, not the raw magnitude, so a
 * value that rounds up past its tier promotes instead of overflowing it —
 * 999,999,999 reads "1B", never "1000.0M". Rounding is also what decides the
 * decimal: a reading that lands on an integer from either side drops it ("2B",
 * not "2.0B"), because the extra digit is noise at that scale.
 */
export function formatTokens(n: number): string {
  for (let i = 0; i < TOKEN_TIERS.length; i++) {
    const tier = TOKEN_TIERS[i]!;
    if (n < tier.unit) continue;
    const reading = Math.round((n / tier.unit) * 10) / 10;
    // Overflowed this tier — re-read it one tier up, where it fits.
    if (reading >= 1000 && i > 0) {
      const up = TOKEN_TIERS[i - 1]!;
      const promoted = Math.round((n / up.unit) * 10) / 10;
      return `${promoted}${up.suffix}`;
    }
    return Number.isInteger(reading)
      ? `${reading}${tier.suffix}`
      : `${reading.toFixed(1)}${tier.suffix}`;
  }
  return n.toLocaleString();
}
