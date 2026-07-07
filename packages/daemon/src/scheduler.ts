import { Cron } from "croner";
import { createLogger } from "@shared/logger.js";
import type {
  AutopilotStore,
  AutopilotFailureThresholdCandidate,
  AutopilotFailureThresholdOptions,
  Autopilot,
  AutopilotRun,
  AutopilotTrigger,
} from "@daemon/contracts/types.js";

const log = createLogger("multiremi-scheduler");
const DEFAULT_FAILURE_MONITOR_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FAILURE_MONITOR_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FAILURE_MONITOR_MIN_RUNS = 50;
const DEFAULT_FAILURE_MONITOR_FAIL_RATIO = 0.9;
const DEFAULT_FAILURE_MONITOR_STARTUP_DELAY_MS = 60 * 1000;

interface ScheduledAutopilotJob {
  expression: string;
  job: Cron;
}

export interface MultiremiSchedulerOptions {
  store: AutopilotStore;
  pollIntervalMs?: number;
  failureMonitorIntervalMs?: number;
  failureMonitorLookbackMs?: number;
  failureMonitorMinRuns?: number;
  failureMonitorFailRatio?: number;
  failureMonitorStartupDelayMs?: number;
}

export class MultiremiScheduler {
  private store: AutopilotStore;
  private pollIntervalMs: number;
  private failureMonitorIntervalMs: number;
  private failureMonitorLookbackMs: number;
  private failureMonitorMinRuns: number;
  private failureMonitorFailRatio: number;
  private failureMonitorStartupDelayMs: number;
  private jobs = new Map<string, ScheduledAutopilotJob>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private failureMonitorStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private failureMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: MultiremiSchedulerOptions) {
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.failureMonitorIntervalMs = options.failureMonitorIntervalMs ?? DEFAULT_FAILURE_MONITOR_INTERVAL_MS;
    this.failureMonitorLookbackMs = options.failureMonitorLookbackMs ?? DEFAULT_FAILURE_MONITOR_LOOKBACK_MS;
    this.failureMonitorMinRuns = options.failureMonitorMinRuns ?? DEFAULT_FAILURE_MONITOR_MIN_RUNS;
    this.failureMonitorFailRatio = options.failureMonitorFailRatio ?? DEFAULT_FAILURE_MONITOR_FAIL_RATIO;
    this.failureMonitorStartupDelayMs = options.failureMonitorStartupDelayMs ?? DEFAULT_FAILURE_MONITOR_STARTUP_DELAY_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.store.recoverLostScheduleTriggers();
    this.sync();
    this.tickDueTriggers();
    this.timer = setInterval(() => this.sync(), this.pollIntervalMs);
    this.timer.unref?.();
    this.startFailureMonitor();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.failureMonitorStartupTimer) clearTimeout(this.failureMonitorStartupTimer);
    this.failureMonitorStartupTimer = null;
    if (this.failureMonitorTimer) clearInterval(this.failureMonitorTimer);
    this.failureMonitorTimer = null;
    for (const entry of this.jobs.values()) entry.job.stop();
    this.jobs.clear();
  }

  sync(): void {
    this.tickDueTriggers();
    const active = new Map(
      this.store.listAutopilots()
        .filter(isSchedulable)
        .filter((autopilot) => !hasScheduleTrigger(this.store, autopilot))
        .map((autopilot) => [autopilot.id, autopilot]),
    );

    for (const [id, entry] of this.jobs) {
      const autopilot = active.get(id);
      if (!autopilot || autopilot.cronExpression !== entry.expression) {
        entry.job.stop();
        this.jobs.delete(id);
      }
    }

    for (const autopilot of active.values()) {
      if (this.jobs.has(autopilot.id)) continue;
      this.addJob(autopilot);
    }
  }

  scheduledCount(): number {
    return this.jobs.size;
  }

  scheduledIds(): string[] {
    return [...this.jobs.keys()];
  }

  trigger(autopilotId: string): AutopilotRun | null {
    return this.runScheduledAutopilot(autopilotId);
  }

  tickDueTriggers(now: Date = new Date()): AutopilotRun[] {
    const runs: AutopilotRun[] = [];
    for (const trigger of this.store.claimDueScheduleTriggers(now)) {
      const run = this.runScheduleTrigger(trigger);
      if (run) runs.push(run);
    }
    return runs;
  }

  runFailureMonitorOnce(
    options: AutopilotFailureThresholdOptions = {},
  ): AutopilotFailureThresholdCandidate[] {
    const paused = this.store.pauseAutopilotsExceedingFailureThreshold({
      lookbackMs: this.failureMonitorLookbackMs,
      minRuns: this.failureMonitorMinRuns,
      failRatioThreshold: this.failureMonitorFailRatio,
      ...options,
    });
    if (paused.length) {
      log.info(`Autopilot failure monitor paused ${paused.length} autopilot(s)`);
    }
    return paused;
  }

  private startFailureMonitor(): void {
    if (this.failureMonitorIntervalMs <= 0) return;
    const run = () => {
      if (!this.running) return;
      this.runFailureMonitorOnce();
      this.failureMonitorTimer = setInterval(() => this.runFailureMonitorOnce(), this.failureMonitorIntervalMs);
      this.failureMonitorTimer.unref?.();
    };
    if (this.failureMonitorStartupDelayMs <= 0) {
      run();
      return;
    }
    this.failureMonitorStartupTimer = setTimeout(run, this.failureMonitorStartupDelayMs);
    this.failureMonitorStartupTimer.unref?.();
  }

  private addJob(autopilot: Autopilot): void {
    const expression = autopilot.cronExpression;
    if (!expression) return;
    try {
      const job = new Cron(expression, {
        catch: (err) => log.warn(`Scheduled autopilot failed: ${(err as Error).message}`),
        name: `multiremi:${autopilot.id}`,
        protect: true,
        unref: true,
      }, () => {
        this.runScheduledAutopilot(autopilot.id);
      });
      this.jobs.set(autopilot.id, { expression, job });
    } catch (err) {
      log.warn(`Invalid autopilot cron expression for ${autopilot.id}: ${(err as Error).message}`);
    }
  }

  private runScheduledAutopilot(autopilotId: string): AutopilotRun | null {
    const autopilot = this.store.getAutopilot(autopilotId);
    if (!autopilot || !isSchedulable(autopilot)) return null;
    try {
      return this.store.runAutopilot(autopilotId, {
        source: "schedule",
        payload: {
          cronExpression: autopilot.cronExpression,
          triggerLabel: autopilot.triggerLabel,
        },
      });
    } catch (err) {
      log.warn(`Scheduled autopilot ${autopilotId} skipped: ${(err as Error).message}`);
      return null;
    }
  }

  private runScheduleTrigger(trigger: AutopilotTrigger): AutopilotRun | null {
    try {
      return this.store.runAutopilot(trigger.autopilotId, {
        source: "schedule",
        payload: {
          cronExpression: trigger.cronExpression,
          triggerLabel: trigger.label,
          triggerId: trigger.id,
          trigger_id: trigger.id,
          timezone: trigger.timezone,
        },
      });
    } catch (err) {
      log.warn(`Scheduled autopilot trigger ${trigger.id} skipped: ${(err as Error).message}`);
      return null;
    } finally {
      this.store.advanceScheduleTriggerNextRun(trigger.id);
    }
  }
}

function isSchedulable(autopilot: Autopilot): boolean {
  return autopilot.status === "active"
    && autopilot.triggerKind === "schedule"
    && Boolean(autopilot.cronExpression?.trim());
}

function hasScheduleTrigger(store: AutopilotStore, autopilot: Autopilot): boolean {
  return store.listAutopilotTriggers(autopilot.id).some((trigger) => trigger.kind === "schedule" && Boolean(trigger.cronExpression?.trim()));
}
