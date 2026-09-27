/**
 * MUL-400 S1 QA round 3: find every place that opens a database transaction
 * while another one is already open.
 *
 * `PostgresSyncDatabase.transaction()` is a bare BEGIN/COMMIT with no savepoints,
 * so a nested call commits the outer transaction early, releases its locks and
 * makes the outer ROLLBACK a no-op. Production code must never do it; the store's
 * convention is that the outermost caller owns the only transaction and
 * everything under it uses a `...WithinTransaction` variant.
 *
 * This helper wraps a real `SqlDatabase.transaction` and records the stack of
 * each nested call. It is test-only: nothing in `packages/` imports it.
 */
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

export interface NestingRecord {
  /** Deepest observed depth (1 = no nesting). */
  maxDepth: number;
  /** One entry per nested `transaction()` call, with a trimmed stack. */
  stacks: string[];
}

/** Frames that are noise in a nesting report. */
const NOISE = /(node_modules|bun:sqlite|bun:internal|pg-nesting-detector|\.test\.ts)/;

export function createNestingDetector(database: SqlDatabase): {
  record: NestingRecord;
  reset(): void;
  /** Distinct stack signatures, sorted, each with the number of hits. */
  signatures(): Array<{ count: number; stack: string }>;
} {
  const record: NestingRecord = { maxDepth: 0, stacks: [] };
  const target = database as unknown as {
    transaction: (fn: (...args: never[]) => unknown) => (...args: unknown[]) => unknown;
  };
  const original = target.transaction;
  let depth = 0;
  target.transaction = (fn: (...args: never[]) => unknown) => {
    const run = original.call(target, fn);
    return (...args: unknown[]) => {
      depth += 1;
      record.maxDepth = Math.max(record.maxDepth, depth);
      if (depth > 1) {
        const frames = (new Error("nested transaction").stack ?? "")
          .split("\n")
          .slice(2)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !NOISE.test(line))
          .slice(0, 14);
        record.stacks.push(frames.join("\n"));
      }
      try {
        return run(...args);
      } finally {
        depth -= 1;
      }
    };
  };
  return {
    record,
    reset() {
      record.maxDepth = 0;
      record.stacks = [];
    },
    signatures() {
      const counts = new Map<string, number>();
      for (const stack of record.stacks) counts.set(stack, (counts.get(stack) ?? 0) + 1);
      return [...counts.entries()]
        .map(([stack, count]) => ({ count, stack }))
        .sort((a, b) => b.count - a.count || a.stack.localeCompare(b.stack));
    },
  };
}
