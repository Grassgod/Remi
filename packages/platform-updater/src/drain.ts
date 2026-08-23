import type { ReportPlatformOperationInput } from "@multiremi/contracts";
import { PlatformDrainLostError, type PlatformDrainStatusWire, type PlatformUpdaterClient } from "./client.js";

export const DEFAULT_DRAIN_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_DRAIN_POLL_MS = 5_000;
export const DEFAULT_DRAIN_LEASE_TTL_MS = 120_000;

/** Base for drain outcomes that abort the operation BEFORE any switch ran. */
export class DrainAbortedError extends Error {}

/** Drain wait ended without the platform reaching zero active tasks. */
export class DrainTimeoutError extends DrainAbortedError {
  constructor(readonly status: PlatformDrainStatusWire | null, timeoutMs: number) {
    super(
      `platform drain timed out after ${Math.round(timeoutMs / 1000)}s; the container switch was NOT executed and task scheduling has been restored`
      + (status ? ` (${status.acked_daemons}/${status.online_daemons} daemons acknowledged, ${status.active_tasks} tasks still active)` : ""),
    );
    this.name = "DrainTimeoutError";
  }
}

/** The operator cancelled the operation before the switch phase. */
export class DrainCancelledError extends DrainAbortedError {
  constructor() {
    super("platform operation was cancelled before the container switch; task scheduling has been restored");
    this.name = "DrainCancelledError";
  }
}

/**
 * Gate handed to deployment drivers: block until the platform is drained
 * (claims paused everywhere, zero in-flight tasks). The coordinator renews the
 * drain lease on every poll, so an updater crash releases the platform via the
 * server-side TTL. On timeout/cancel the drain is released before throwing;
 * on success the drain stays held (the switch runs under it) until release().
 */
export interface PlatformDrainGate {
  waitUntilDrained(
    report: (input: ReportPlatformOperationInput) => Promise<void>,
  ): Promise<void>;
  release(): Promise<void>;
}

export interface PlatformDrainCoordinatorOptions {
  timeoutMs?: number;
  pollMs?: number;
  leaseTtlMs?: number;
  reason?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class PlatformDrainCoordinator implements PlatformDrainGate {
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly leaseTtlMs: number;
  private readonly reason: string | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly client: PlatformUpdaterClient,
    private readonly operationId: string,
    options: PlatformDrainCoordinatorOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_DRAIN_POLL_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_DRAIN_LEASE_TTL_MS;
    this.reason = options.reason ?? null;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = options.now ?? (() => Date.now());
  }

  async waitUntilDrained(
    report: (input: ReportPlatformOperationInput) => Promise<void>,
  ): Promise<void> {
    await this.client.drainBegin(this.operationId, this.reason, this.leaseTtlMs);
    const startedAt = this.now();
    let lastStatus: PlatformDrainStatusWire | null = null;
    for (;;) {
      let renewal;
      try {
        renewal = await this.client.drainRenew(this.operationId, this.leaseTtlMs);
      } catch (error) {
        if (error instanceof PlatformDrainLostError) {
          // The lease expired (long API outage) or was released elsewhere.
          // Re-acquire instead of switching without protection.
          await this.client.drainBegin(this.operationId, this.reason, this.leaseTtlMs);
          continue;
        }
        throw error;
      }
      lastStatus = renewal.status;
      const waitedMs = this.now() - startedAt;
      if (renewal.cancel_requested) {
        await this.release();
        throw new DrainCancelledError();
      }
      if (renewal.status.ready) {
        await report({
          status: "draining",
          progress: {
            message: "All daemons paused and no tasks are running; switching now",
            drain: drainProgress(renewal.status, waitedMs, this.timeoutMs, "ready"),
          },
        });
        return;
      }
      if (waitedMs >= this.timeoutMs) {
        await report({
          status: "draining",
          progress: {
            message: "Drain timed out; the switch was not executed",
            drain: drainProgress(renewal.status, waitedMs, this.timeoutMs, "timeout"),
          },
        });
        await this.release();
        throw new DrainTimeoutError(lastStatus, this.timeoutMs);
      }
      await report({
        status: "draining",
        progress: {
          message: renewal.status.active_tasks > 0
            ? `Waiting for ${renewal.status.active_tasks} running task(s) to finish`
            : `Waiting for daemons to pause claims (${renewal.status.acked_daemons}/${renewal.status.online_daemons} acknowledged)`,
          drain: drainProgress(renewal.status, waitedMs, this.timeoutMs, "waiting"),
        },
      });
      await this.sleep(this.pollMs);
    }
  }

  async release(): Promise<void> {
    await this.client.drainRelease(this.operationId);
  }
}

function drainProgress(
  status: PlatformDrainStatusWire,
  waitedMs: number,
  timeoutMs: number,
  state: "waiting" | "ready" | "timeout",
): Record<string, unknown> {
  return {
    generation: status.generation,
    online_daemons: status.online_daemons,
    acked_daemons: status.acked_daemons,
    active_tasks: status.active_tasks,
    pending_runtimes: status.pending_runtimes,
    waited_ms: waitedMs,
    timeout_ms: timeoutMs,
    state,
  };
}
