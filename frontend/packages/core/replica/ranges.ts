/**
 * Sparse seq ranges (MUL-403 C7 §4).
 *
 * A replica never holds a contiguous `[1, head]` window: a deep link writes a
 * 31-row window around one seq, the tail arrives from the stream, and the rows
 * between them are fetched only if someone scrolls there. `ranges` is that
 * coverage map, and "is `seq` held" has exactly one definition here so the
 * stream writer and the window reader cannot disagree.
 *
 * Ranges are inclusive `[from, to]` and stored sorted, disjoint and
 * non-adjacent: touching ranges are merged on insert, so "the newest contiguous
 * run" is always the last range rather than something a caller reconstructs.
 */

export interface SeqRange {
  from: number;
  to: number;
}

/** Sort and merge a set of ranges into sorted, disjoint, non-adjacent form. */
export function normalizeRanges(ranges: readonly SeqRange[]): SeqRange[] {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.from) && Number.isFinite(range.to) && range.to >= range.from)
    .map((range) => ({ from: range.from, to: range.to }))
    .sort((left, right) => left.from - right.from || left.to - right.to);

  const merged: SeqRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    // `last.to + 1 >= range.from` also merges adjacent ranges (e.g. [1,5]+[6,9]),
    // which keeps "contiguous" a property of one range rather than of a pair.
    if (last && range.from <= last.to + 1) {
      if (range.to > last.to) last.to = range.to;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

/** Add one inclusive range, merging it into any it touches. */
export function addRange(ranges: readonly SeqRange[], from: number, to: number): SeqRange[] {
  return normalizeRanges([...ranges, { from, to }]);
}

/** Drop all coverage below `from` (used when `log_version` changed and rows are re-read). */
export function dropRangesBelow(ranges: readonly SeqRange[], from: number): SeqRange[] {
  return normalizeRanges(ranges.filter((range) => range.to >= from));
}

/** Whether `seq` is inside any held range. */
export function coversSeq(ranges: readonly SeqRange[], seq: number): boolean {
  return ranges.some((range) => seq >= range.from && seq <= range.to);
}

/**
 * The newest contiguous run ending at `head`, or null when the replica holds
 * nothing ending at the head.
 *
 * `log_version` equality alone cannot see an in-place update, so freshness also
 * compares `head_seq`; this function is what makes the "newest contiguous run"
 * the thing that head is compared against, instead of the newest row of any
 * sparse window.
 */
export function contiguousTail(ranges: readonly SeqRange[], head: number): SeqRange | null {
  const last = normalizeRanges(ranges).findLast((range) => range.to === head);
  return last ? { ...last } : null;
}

/** Highest `seq` covered by any range, or null when empty. */
export function highestCoveredSeq(ranges: readonly SeqRange[]): number | null {
  const normalized = normalizeRanges(ranges);
  const last = normalized[normalized.length - 1];
  return last ? last.to : null;
}
