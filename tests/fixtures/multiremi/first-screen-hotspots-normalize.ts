// MUL-473: response scrubbing for the first-screen hotspot goldens.
//
// The fixture pins every id it can, but the store still mints task ids from the
// seeded PRNG and stamps wall-clock timestamps on rows it inserts. The golden
// therefore compares *shape and order* — every field name, value type, id
// relation, position in the list and count — with those two classes of value
// replaced by stable placeholders.
import type { FirstScreenHotspotsFixture } from "./first-screen-hotspots-fixture.js";

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/**
 * Pin id generation and the clock so a fixture capture and a later
 * implementation capture are comparable. Returns a restore function.
 *
 * Mirrors `installDeterministicIds` from the MUL-385 fixture: one clock tick per
 * read gives stable ordering with no ties, and the PRNG is fixed so task ids
 * repeat across runs.
 */
export function installFirstScreenHotspotIds(): () => void {
  // Restore the exact function object; a bound copy leaks identity changes.
  const realGetRandomValues = globalThis.crypto.getRandomValues;
  const RealDate = globalThis.Date;
  let clock = Date.UTC(2026, 8, 26, 9, 0, 0);
  class FixtureDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock++);
      else super(...(args as []));
    }
    static now(): number {
      return clock++;
    }
  }
  (globalThis as { Date: unknown }).Date = FixtureDate;
  let state = 0x473_c0de;
  const nextByte = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 24) & 0xff;
  };
  (globalThis.crypto as { getRandomValues: unknown }).getRandomValues = (array: ArrayLike<number> & { length: number }) => {
    for (let index = 0; index < array.length; index += 1) {
      (array as unknown as number[])[index] = nextByte();
    }
    return array;
  };
  return () => {
    (globalThis as { Date: unknown }).Date = RealDate;
    (globalThis.crypto as { getRandomValues: unknown }).getRandomValues = realGetRandomValues;
  };
}

/**
 * Replace the values the fixture cannot pin: ISO timestamps become
 * `<timestamp>`, and task ids become `<task:N>` where N is the index of that
 * task in the fixture's creation order. Replacing task ids by *position* rather
 * than by id keeps the ordering assertion meaningful — a reordered response
 * produces a different sequence of placeholders.
 */
export function normalizeFirstScreenHotspotResponse(
  value: unknown,
  fixture: FirstScreenHotspotsFixture,
): unknown {
  const taskIds = new Map(fixture.taskIds.map((id, index) => [id, `<task:${index}>`]));
  const turnIds = new Map([...new Set(fixture.turnIds)].map((id,index)=>[id,`<turn:${index}>`]));
  const scrub = (input: unknown, key: string | null): unknown => {
    if (typeof input === "string") {
      const placeholder = taskIds.get(input);
      if (placeholder && (key === "task_id" || key === "id" || key === "current_attempt_id")) return placeholder;
      if(turnIds.has(input)) return turnIds.get(input)!;
      return input.replace(ISO_RE, "<timestamp>");
    }
    if (Array.isArray(input)) return input.map((entry) => scrub(entry, null));
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [entryKey, entry] of Object.entries(input as Record<string, unknown>)) {
        out[entryKey] = scrub(entry, entryKey);
      }
      return out;
    }
    return input;
  };
  return scrub(value, null);
}
