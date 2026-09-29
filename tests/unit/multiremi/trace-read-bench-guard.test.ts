/**
 * MUL-432 item 10: the per-call byte bound of the archive trace read bench.
 * The guard itself, and the bench process end to end — exit status 3 and the
 * true violation count when every call reads past the bound. No database
 * server: the bench runs on SQLite only here.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BENCH_EXIT_FAILED,
  benchExitCode,
  TRACE_READ_BYTE_SLACK,
  TraceReadByteGuard,
  traceReadCallWithinBound,
} from "../../manual/archive-trace-read-guard.js";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const BENCH = join(REPO_ROOT, "tests/manual/bench-archive-trace-read.ts");
const TIMEOUT = 120_000;

describe("trace read byte guard", () => {
  it("allows a call up to the member's compressed size plus 64 KiB and no byte more", () => {
    expect(TRACE_READ_BYTE_SLACK).toBe(64 * 1024);
    expect(traceReadCallWithinBound(0, 1_000)).toBe(true);
    expect(traceReadCallWithinBound(1_000, 1_000)).toBe(true);
    expect(traceReadCallWithinBound(1_000 + TRACE_READ_BYTE_SLACK, 1_000)).toBe(true);
    expect(traceReadCallWithinBound(1_000 + TRACE_READ_BYTE_SLACK + 1, 1_000)).toBe(false);
    expect(traceReadCallWithinBound(11, 10, 1)).toBe(true);
    expect(traceReadCallWithinBound(12, 10, 1)).toBe(false);
  });

  it("counts every call and every violation, keeps a few samples and forgets the warm-up on reset", () => {
    const guard = new TraceReadByteGuard(100, 2);
    expect(guard.report()).toMatchObject({
      slack_bytes: 100, calls: 0, violations: 0,
      max_excess_over_compressed_bytes: null, min_excess_over_compressed_bytes: null, violation_samples: [],
    });
    expect(guard.check("tsk_warm", 5_000, 1_000)).toBe(false);
    guard.reset();
    expect(guard.report()).toMatchObject({ calls: 0, violations: 0, violation_samples: [] });

    expect(guard.check("tsk_a", 1_000, 1_000)).toBe(true);
    expect(guard.check("tsk_b", 1_100, 1_000)).toBe(true);
    expect(guard.check("tsk_c", 1_101, 1_000)).toBe(false);
    expect(guard.check("tsk_d", 900, 1_000)).toBe(true);
    expect(guard.check("tsk_e", 2_000, 1_000)).toBe(false);
    expect(guard.check("tsk_f", 3_000, 1_000)).toBe(false);
    expect(guard.report()).toEqual({
      rule: "every readTrace call reads <= member compressed_size + 100 bytes from the archive file",
      slack_bytes: 100,
      calls: 6,
      violations: 3,
      max_excess_over_compressed_bytes: 2_000,
      min_excess_over_compressed_bytes: -100,
      violation_samples: [
        { task_id: "tsk_c", call_bytes: 1_101, compressed_size: 1_000 },
        { task_id: "tsk_e", call_bytes: 2_000, compressed_size: 1_000 },
      ],
    });
  });

  it("fails the bench when any backend has a violation or a failed read", () => {
    expect(BENCH_EXIT_FAILED).toBe(3);
    expect(benchExitCode([])).toBe(0);
    expect(benchExitCode([{ validationFailures: 0, violations: 0 }, { validationFailures: 0, violations: 0 }])).toBe(0);
    expect(benchExitCode([{ validationFailures: 0, violations: 0 }, { validationFailures: 0, violations: 1 }])).toBe(3);
    expect(benchExitCode([{ validationFailures: 2, violations: 0 }, { validationFailures: 0, violations: 0 }])).toBe(3);
  });
});

interface BenchRun {
  exitCode: number;
  stderr: string;
  report: { backends: Array<{ byte_bound: { calls: number; violations: number; violation_samples: unknown[] }; validation_failures: string[] }> } | null;
}

/** Two p50-sized tasks, no warm-up: four reads of one call each per task. */
function runBench(...args: string[]): BenchRun {
  const dir = mkdtempSync(join(tmpdir(), "m432-bench-guard-"));
  try {
    const out = join(dir, "report.json");
    const spawned = Bun.spawnSync([
      "bun", BENCH, "--backends=sqlite", "--tiers=p50", "--per-tier=2", "--warmup=0", `--work-dir=${join(dir, "work")}`, "--out", out, ...args,
    ], { cwd: REPO_ROOT, env: { ...process.env, MULTIREMI_TEST_POSTGRES_URL: "" }, stdout: "pipe", stderr: "pipe" });
    const stderr = spawned.stderr.toString();
    let report: BenchRun["report"] = null;
    try {
      report = JSON.parse(readFileSync(out, "utf8"));
    } catch {
      report = null;
    }
    return { exitCode: spawned.exitCode ?? -1, stderr, report };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "linux")("archive trace read bench exit status", () => {
  it("exits 0 when every call stays within the bound", () => {
    const run = runBench();
    expect(run.exitCode, run.stderr).toBe(0);
    const [sqlite] = run.report!.backends;
    expect(sqlite!.validation_failures).toEqual([]);
    expect(sqlite!.byte_bound).toMatchObject({ calls: 8, violations: 0, violation_samples: [] });
  }, TIMEOUT);

  it("exits 3 and reports every violation when each call reads past the bound", () => {
    const run = runBench(`--inject-extra-read-bytes=${TRACE_READ_BYTE_SLACK + 4_464}`);
    expect(run.exitCode, run.stderr).toBe(BENCH_EXIT_FAILED);
    const [sqlite] = run.report!.backends;
    expect(sqlite!.validation_failures).toEqual([]);
    expect(sqlite!.byte_bound.calls).toBe(8);
    expect(sqlite!.byte_bound.violations).toBe(8);
    expect(sqlite!.byte_bound.violation_samples).toHaveLength(8);
    expect(run.stderr).toContain("byte-bound violations 8 of 8 calls");
  }, TIMEOUT);
});
