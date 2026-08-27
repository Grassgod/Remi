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

/**
 * Compact token count: `1.5K` / `2M` / `1.4B` / `1T` / `842`. Near-integer
 * readings drop the decimal ("2K", not "2.0K") because the extra digit is
 * noise at that scale.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000_000_000) {
    const t = n / 1_000_000_000_000;
    return t % 1 < 0.05 ? `${Math.round(t)}T` : `${t.toFixed(1)}T`;
  }
  if (n >= 1_000_000_000) {
    const b = n / 1_000_000_000;
    return b % 1 < 0.05 ? `${Math.round(b)}B` : `${b.toFixed(1)}B`;
  }
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m % 1 < 0.05 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k % 1 < 0.05 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  return n.toLocaleString();
}
