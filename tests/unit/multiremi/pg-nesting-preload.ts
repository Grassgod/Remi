/**
 * MUL-400 S1 QA round 3: report every nested `transaction()` opened while a
 * Postgres transaction is already open, across a whole test run.
 *
 * Run it as a preload so it is installed before any store exists:
 *
 *   MULTIREMI_TEST_POSTGRES_URL=… MUL406_NESTING_REPORT=/tmp/nesting.json \
 *     bun test --preload ./tests/unit/multiremi/pg-nesting-preload.ts tests/unit/multiremi/
 *
 * Only `PostgresSyncDatabase` is wrapped; the SQLite handle has savepoint-like
 * nested semantics and is not the risk this scan exists for. Nothing in
 * `packages/` imports this file.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { StoreContext } from "@multiremi/store/context.js";

/** Frames that are noise in a nesting report. */
const NOISE = /(node_modules|bun:sqlite|bun:internal|pg-nesting-preload|\.test\.ts|helpers\.ts)/;
/** Cap the recorded signatures: a scan only needs enough to classify causes. */
const MAX_HITS = 400;

const stacks: string[] = [];
const emissions: string[] = [];
let installed = false;
let depth = 0;
/** True while a Postgres transaction is open, for the event-emission scan. */
function inTransaction(): boolean {
  return depth > 0;
}

/** Emit a machine-readable `kind` + first meaningful frame. */
function frame(kind: string): string {
  const frames = (new Error(kind).stack ?? "")
    .split("\n")
    .slice(3)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NOISE.test(line))
    .slice(0, 6);
  return `${kind}\n${frames.join("\n")}`;
}

function captureStack(): string {
  const frames = (new Error("nested").stack ?? "")
    .split("\n")
    .slice(2)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NOISE.test(line))
    .slice(0, 16);
  return frames.join("\n");
}

if (!installed) {
  installed = true;
  const proto = PostgresSyncDatabase.prototype as unknown as {
    transaction: (fn: (...args: never[]) => unknown) => (...args: unknown[]) => unknown;
  };
  const original = proto.transaction;
  proto.transaction = function transaction(this: PostgresSyncDatabase, fn: (...args: never[]) => unknown) {
    const run = original.call(this, fn);
    return (...args: unknown[]) => {
      depth += 1;
      if (depth > 1 && stacks.length < MAX_HITS) {
        const stack = captureStack();
        stacks.push(stack);
        appendHit(stack, "nested_transaction");
      }
      try {
        return run(...args);
      } finally {
        depth -= 1;
      }
    };
  };
}

/**
 * MUL-400 S1 QA round 3: flag every outward event published while a transaction
 * is still open. Those reach clients before the row is durable (Postgres is
 * synchronous here) and, on rollback, describe a row that never existed.
 */
function installEmissionScan(): void {
  const proto = StoreContext.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const watched = [
    "emitWorkspaceEvent",
    "emitChatEvent",
    "notifyTaskEnqueued",
    "notifyTaskEvent",
    "notifyTaskMessages",
    "notifyChildStatusChange",
  ] as const;
  for (const name of watched) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = function watched(this: StoreContext, ...args: unknown[]) {
      if (inTransaction() && emissions.length < MAX_HITS) {
        const hit = frame(`event_in_transaction:${name}`);
        emissions.push(hit);
        appendHit(hit, "event_in_transaction");
      }
      return original.apply(this, args);
    };
  }
}

installEmissionScan();

function report(): string {
  const counts = new Map<string, number>();
  for (const stack of stacks) counts.set(stack, (counts.get(stack) ?? 0) + 1);
  const signatures = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([stack, count]) => ({ count, stack }));
  const emissionCounts = new Map<string, number>();
  for (const emission of emissions) emissionCounts.set(emission, (emissionCounts.get(emission) ?? 0) + 1);
  const emissionSignatures = [...emissionCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([stack, count]) => ({ count, stack }));
  return JSON.stringify({
    total: stacks.length,
    signatures,
    emissionTotal: emissions.length,
    emissionSignatures,
  }, null, 2);
}

(globalThis as unknown as { __mul406NestingReport: () => string }).__mul406NestingReport = report;

/**
 * Append each hit as it happens. Bun test may not run `process.on("exit")`
 * handlers reliably, and an incremental log survives a crashing run — which is
 * exactly when a nesting report is most useful.
 */
function appendHit(stack: string, kind: "nested_transaction" | "event_in_transaction" = "nested_transaction"): void {
  const target = process.env.MUL406_NESTING_REPORT;
  if (!target) return;
  try {
    appendFileSync(target, `${JSON.stringify({ kind, stack })}\n`);
  } catch {
    // best-effort reporting
  }
}

const startedTarget = process.env.MUL406_NESTING_REPORT;
if (startedTarget) {
  try {
    writeFileSync(startedTarget, "");
  } catch {
    // best-effort reporting
  }
}
