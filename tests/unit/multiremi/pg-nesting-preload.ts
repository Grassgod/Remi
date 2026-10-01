/**
 * Real-PG diagnostic preload. Only paths executed by the tests are covered.
 *
 * MULTIREMI_TEST_POSTGRES_URL=… MUL406_NESTING_REPORT=/tmp/nesting.jsonl \
 *   bun test --preload ./tests/unit/multiremi/pg-nesting-preload.ts tests/unit/multiremi/
 *
 * Use initdb -E UTF8 --no-locale for temporary instances; SQL_ASCII splits
 * Unicode characters in the backfill substring probes.
 *
 * event_in_transaction means a probe subscriber was actually called before
 * COMMIT. call_in_transaction preserves the old call-site signatures for
 * reference: calling an afterCommit-backed method inside a transaction is safe.
 * Nesting is checked on the invoked handle, so a new transaction in an
 * afterCommit callback is not mistaken for a nested transaction.
 *
 * All five StoreContext subscriber channels get independent probes, including
 * contexts whose tests never subscribe. Standard contexts install on analytics
 * registration; hand-built contexts install before their first notification.
 * No production module imports this file; bunfig.toml does not preload it.
 * Run ./pg-nesting-positive-control.ts separately with this preload before
 * accepting a clean scan. The manual fixture is not automatically discovered.
 * Raw nesting is never filtered: product callers and tests directly exercising
 * the DB primitive are reported separately (MUL-482 ruling cmt_oeqtip30sddu).
 * Construction and invocation stacks are both retained: a tail-called runner
 * can omit its product frame from Bun's invocation stack.
 * Any non-plumbing product frame in either complete stack counts as product.
 * Unknown caller locations fail closed. Only the exact savepoint signature
 * reviewed in cmt_ur542tq7q53w is exempt; raw counts and stacks remain intact.
 *
 * Reports append incrementally, surviving crashes even if Bun omits exit hooks.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { StoreContext } from "@multiremi/store/context.js";

const NOISE = /(node_modules|bun:sqlite|bun:internal|pg-nesting-preload)/;
type HitKind = "nested_transaction" | "event_in_transaction" | "call_in_transaction";
const hits: Record<HitKind, Map<string, number>> = {
  nested_transaction: new Map(),
  event_in_transaction: new Map(),
  call_in_transaction: new Map(),
};
const controls: Record<HitKind, Map<string, number>> = {
  nested_transaction: new Map(),
  event_in_transaction: new Map(),
  call_in_transaction: new Map(),
};
type NestingClass = "product_path" | "test_direct" | "unclassified";
const classified = new Map<string, NestingClass>();
const reviewed = new Map<string, string>();
// Fixed, reported transparent-frame list from cmt_oeqtip30sddu. Test wrappers
// never hide a product frame elsewhere in either complete stack.
const plumbing = [
  "tests/unit/multiremi/pg-nesting-preload.ts",
  "packages/server/src/store/db/**",
  "packages/server/src/store/request-read-cache.ts (transaction proxy)",
  "tests/** (including counting wrappers)",
] as const;
const approvedSavepoint = {
  id: "MUL-482-runAutopilot-captured-inner-failure",
  ruling: "cmt_ur542tq7q53w",
  adr: "docs/adr/0011-transaction-ownership-and-side-effect-timing.md#2",
  test: "captured inner failure leaves the outer transaction usable",
  // Exact construction and caller locations; edits that move either frame
  // require review, rather than silently widening this into a function allowlist.
  transaction: "packages/server/src/store/repos/autopilots-repo.ts:1375:29",
  invocation: "packages/server/src/store/repos/autopilots-repo.ts:1604:6",
  caller: "tests/unit/multiremi/mul405-nested-rollback.test.ts:573:19",
  outer: "tests/unit/multiremi/mul405-nested-rollback.test.ts:583:10",
} as const;

function productFrames(stack: string): string[] {
  return stack.split("\n").slice(1).filter(line => line.includes("/packages/")
    && !line.includes("/packages/server/src/store/db/")
    && !line.includes("/packages/server/src/store/request-read-cache.ts:"));
}

function frameAt(frame: string, location: string): boolean {
  return frame.endsWith(`/${location})`) || frame.endsWith(`/${location}`);
}

function reviewedSavepoint(invocation: string, origin?: string): string | null {
  if (!origin) return null;
  const owner = productFrames(origin)[0];
  const invoker = productFrames(invocation)[0];
  // The inner transaction must be constructed by this precise runAutopilot
  // frame, and BOTH stacks must reach the approved test's precise call site.
  return owner?.includes("runAutopilot") && frameAt(owner, approvedSavepoint.transaction)
    && invoker?.includes("runAutopilot") && frameAt(invoker, approvedSavepoint.invocation)
    && invocation.split("\n").some(frame => frameAt(frame, approvedSavepoint.caller))
    && origin.split("\n").some(frame => frameAt(frame, approvedSavepoint.caller))
    && invocation.split("\n").some(frame => frameAt(frame, approvedSavepoint.outer))
    && origin.split("\n").some(frame => frameAt(frame, approvedSavepoint.outer))
    ? approvedSavepoint.id : null;
}
let callDepth = 0;
let controlDepth = 0;
let probedContexts = 0;
let reportFailures = 0;
const handles = new Set<PostgresSyncDatabase>();
const probed = new WeakSet<StoreContext>();
const channels = [
  ["workspace", "workspaceEventListeners"],
  ["task_event", "taskEventListeners"],
  ["task_enqueued", "taskEnqueuedListeners"],
  ["task_messages", "taskMessagesListeners"],
  ["human_request", "humanRequestListeners"],
] as const;

const target = process.env.MUL406_NESTING_REPORT;
if (target) writeFileSync(target, "");

function append(entry: object): void {
  if (!target) return;
  try { appendFileSync(target, `${JSON.stringify(entry)}\n`); }
  catch (error) {
    reportFailures += 1;
    console.error("[pg-nesting] report_write_failed", error);
  }
}

function signature(label: string): string {
  const previousLimit = Error.stackTraceLimit;
  let raw: string;
  try {
    Error.stackTraceLimit = 100;
    raw = new Error(label).stack ?? "";
  } finally { Error.stackTraceLimit = previousLimit; }
  const frames = raw.split("\n").slice(2)
    .map(line => line.trim()).filter(line => line && !NOISE.test(line));
  return `${label}\n${frames.join("\n")}`;
}

function record(kind: HitKind, label: string, transactionOrigin?: string): void {
  const invocationStack = signature(label);
  const stack = transactionOrigin ? `${invocationStack}\n${transactionOrigin}` : invocationStack;
  const map = (controlDepth ? controls : hits)[kind];
  map.set(stack, (map.get(stack) ?? 0) + 1);
  if (kind === "nested_transaction") {
    // Inspect both COMPLETE stacks, including frames below the outer callback.
    // Never stop at postgres.ts or let a test wrapper determine the category.
    const category = productFrames(invocationStack).length || (transactionOrigin && productFrames(transactionOrigin).length)
      ? "product_path" : stack.includes("/tests/") ? "test_direct" : "unclassified";
    classified.set(stack, category);
    const exception = category === "product_path" ? reviewedSavepoint(invocationStack, transactionOrigin) : null;
    if (exception) reviewed.set(stack, exception);
  }
  append({ kind: controlDepth ? `positive_control_${kind}` : kind, stack,
    ...(kind === "nested_transaction" ? { classification: classified.get(stack), reviewedException: reviewed.get(stack) ?? null } : {}) });
}

/** The proxy forwards inTransaction to its real Postgres handle; no counter. */
export function installProbes(ctx: StoreContext): void {
  if (!(ctx.db instanceof PostgresSyncDatabase) || probed.has(ctx)) return;
  probed.add(ctx);
  probedContexts += 1;
  for (const [channel, field] of channels) {
    const listeners = ctx[field] as Set<(...args: never[]) => void>;
    listeners.add(() => {
      if (ctx.db.inTransaction) record("event_in_transaction", `event_in_transaction:${channel}`);
    });
  }
  append({ kind: "probe_installed", channels: channels.map(([name]) => name) });
}

const pgProto = PostgresSyncDatabase.prototype;
const transaction = pgProto.transaction;
pgProto.transaction = function<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
  handles.add(this);
  const origin = signature("transaction_origin");
  const run = transaction.call(this, fn) as (...args: any[]) => T;
  return (...args: any[]): T => {
    // Check before calling the runner, not while its post-commit callbacks drain.
    if (this.inTransaction) record("nested_transaction", "nested_transaction", origin);
    callDepth += 1;
    try { return run(...args); }
    finally { callDepth -= 1; }
  };
};

const ctxProto = StoreContext.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const registerAnalytics = ctxProto.registerAnalytics!;
ctxProto.registerAnalytics = function(this: StoreContext, ...args: unknown[]) {
  installProbes(this);
  return registerAnalytics.apply(this, args);
};
for (const name of [
  "emitWorkspaceEvent", "emitChatEvent", "notifyTaskEnqueued",
  "notifyTaskEvent", "notifyTaskMessages", "notifyHumanRequest",
]) {
  const original = ctxProto[name]!;
  ctxProto[name] = function(this: StoreContext, ...args: unknown[]) {
    installProbes(this);
    // Keep the earlier counter-based measurement as reference only.
    if (callDepth > 0 || [...handles].some(handle => handle.inTransaction)) {
      record("call_in_transaction", `call_in_transaction:${name}`);
    }
    return original.apply(this, args);
  };
}

function summarize(map: Map<string, number>) {
  const signatures = [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([stack, count]) => ({ count, stack }));
  return { total: signatures.reduce((sum, item) => sum + item.count, 0), signatures };
}

function nesting(map: Map<string, number>) {
  const group = (category: NestingClass) => summarize(new Map([...map].filter(([stack]) => classified.get(stack) === category)));
  const productPath = group("product_path");
  const unclassified = group("unclassified");
  const reviewedExceptions = summarize(new Map([...map].filter(([stack]) => reviewed.has(stack))));
  return {
    raw: summarize(map),
    productPath,
    testDirect: group("test_direct"),
    unclassified,
    reviewedExceptions,
    // Compatibility for earlier report consumers; contains only reviewed hits.
    adr0011Reuse: reviewedExceptions,
    productGate: { total: productPath.total - reviewedExceptions.total + unclassified.total,
      formula: "productPath - reviewedExceptions + unclassified" },
  };
}

export function report(): string {
  return JSON.stringify({
    total: summarize(hits.nested_transaction).total,
    nesting: nesting(hits.nested_transaction),
    signatures: summarize(hits.nested_transaction).signatures,
    emissionTotal: summarize(hits.event_in_transaction).total,
    emissionSignatures: summarize(hits.event_in_transaction).signatures,
    callSiteTotal: summarize(hits.call_in_transaction).total,
    callSiteSignatures: summarize(hits.call_in_transaction).signatures,
    positiveControl: {
      ...Object.fromEntries(Object.entries(controls).map(([kind, map]) => [kind, summarize(map)])),
      nesting: nesting(controls.nested_transaction),
    },
    probedContexts,
    reportFailures,
    channels: channels.map(([name]) => name),
    classificationRule: "any non-plumbing product frame in either complete stack",
    plumbing,
    approvedSavepoints: [approvedSavepoint],
  }, null, 2);
}
(globalThis as unknown as { __mul406NestingReport: () => string }).__mul406NestingReport = report;
append({ kind: "scan_installed", measurement: "subscriber_delivery", channels: channels.map(([name]) => name),
  classificationRule: "any non-plumbing product frame in either complete stack", plumbing, approvedSavepoints: [approvedSavepoint] });

export function withPositiveControl(fn: () => void): void {
  controlDepth += 1;
  try { fn(); } finally { controlDepth -= 1; }
}

export function positiveControlPassed(): void {
  append({ kind: "positive_control_passed", ...JSON.parse(report()).positiveControl,
    afterCommitInTransaction: false });
}
