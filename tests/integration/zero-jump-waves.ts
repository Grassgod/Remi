import type { PerfWaveEntry, PerfWaveResult, PerfWaveRow } from "../../frontend/scripts/perf/lib/jump-recorder";

/**
 * CI reveal gate only: overlapping in-flight intervals belong to one wave,
 * including overlaps through another request. A new wave starts only once
 * every request in the previous wave has finished. S1 keeps computeWaves and
 * its historical scheduling tolerance.
 */
export function computeInFlightWaves(entries: PerfWaveEntry[]): PerfWaveResult {
  const ordered = [...entries].sort((left, right) => left.startMs - right.startMs || left.index - right.index);
  const rows: PerfWaveRow[] = [];
  let closing: PerfWaveRow | null = null;
  let wave = 0;
  let after: number | null = null;
  for (const entry of ordered) {
    if (!closing || entry.startMs >= closing.responseEndMs) {
      after = closing?.index ?? null;
      wave += 1;
      closing = null;
    }
    const row: PerfWaveRow = { ...entry, wave, after };
    rows.push(row);
    if (!closing || row.responseEndMs > closing.responseEndMs) closing = row;
  }
  const byIndex = new Map(rows.map(row => [row.index, row]));
  const chain: number[] = [];
  let cursor = closing;
  while (cursor) {
    chain.unshift(cursor.index);
    cursor = cursor.after === null ? null : byIndex.get(cursor.after) ?? null;
  }
  return { rows, serialDepth: wave, chain };
}

/** The existing blocking limit, shared with the serial-chain regression. */
export function preRevealWaveFailure(gate: "blocking" | "record-only", depth: number | null): string | null {
  return gate === "blocking" && (depth ?? 99) > 2 ? `pre-reveal waves: ${depth}` : null;
}
