/**
 * Per-call byte bound of the archive trace read bench
 * (`tests/manual/bench-archive-trace-read.ts`, MUL-432 item 10): one
 * `readTrace` call may read at most its member's compressed size plus 64 KiB
 * from the archive file. Kept apart from the bench so a unit test can drive
 * it without building a corpus.
 */
export const TRACE_READ_BYTE_SLACK = 64 * 1024;

/** Exit status of the bench when a read failed validation or a call broke the bound. */
export const BENCH_EXIT_FAILED = 3;

export function traceReadCallWithinBound(callBytes: number, compressedSize: number, slack = TRACE_READ_BYTE_SLACK): boolean {
  return callBytes <= compressedSize + slack;
}

export interface TraceReadByteBoundReport {
  rule: string;
  slack_bytes: number;
  calls: number;
  violations: number;
  max_excess_over_compressed_bytes: number | null;
  min_excess_over_compressed_bytes: number | null;
  violation_samples: Array<{ task_id: string; call_bytes: number; compressed_size: number }>;
}

/** Checks every call and keeps the counts; `reset` drops what the warm-up recorded. */
export class TraceReadByteGuard {
  private calls = 0;
  private violations = 0;
  private maxExcess = -Infinity;
  private minExcess = Infinity;
  private samples: TraceReadByteBoundReport["violation_samples"] = [];

  constructor(private readonly slack = TRACE_READ_BYTE_SLACK, private readonly sampleLimit = 20) {}

  check(taskId: string, callBytes: number, compressedSize: number): boolean {
    const excess = callBytes - compressedSize;
    this.calls++;
    this.maxExcess = Math.max(this.maxExcess, excess);
    this.minExcess = Math.min(this.minExcess, excess);
    if (traceReadCallWithinBound(callBytes, compressedSize, this.slack)) return true;
    this.violations++;
    if (this.samples.length < this.sampleLimit) {
      this.samples.push({ task_id: taskId, call_bytes: callBytes, compressed_size: compressedSize });
    }
    return false;
  }

  reset(): void {
    this.calls = 0;
    this.violations = 0;
    this.maxExcess = -Infinity;
    this.minExcess = Infinity;
    this.samples = [];
  }

  report(): TraceReadByteBoundReport {
    return {
      rule: `every readTrace call reads <= member compressed_size + ${this.slack} bytes from the archive file`,
      slack_bytes: this.slack,
      calls: this.calls,
      violations: this.violations,
      max_excess_over_compressed_bytes: this.calls ? this.maxExcess : null,
      min_excess_over_compressed_bytes: this.calls ? this.minExcess : null,
      violation_samples: [...this.samples],
    };
  }
}

/** 3 when any read failed validation or any call broke the bound, else 0. */
export function benchExitCode(backends: ReadonlyArray<{ validationFailures: number; violations: number }>): number {
  return backends.some((backend) => backend.validationFailures > 0 || backend.violations > 0) ? BENCH_EXIT_FAILED : 0;
}
