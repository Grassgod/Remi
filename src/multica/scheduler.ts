import { Cron } from "croner";
import { createLogger } from "../logger.js";
import { MulticaStore } from "./store.js";
import type { MulticaAutopilot, MulticaAutopilotRun } from "./types.js";

const log = createLogger("multica-scheduler");

interface ScheduledAutopilotJob {
  expression: string;
  job: Cron;
}

export interface MulticaSchedulerOptions {
  store: MulticaStore;
  pollIntervalMs?: number;
}

export class MulticaScheduler {
  private store: MulticaStore;
  private pollIntervalMs: number;
  private jobs = new Map<string, ScheduledAutopilotJob>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: MulticaSchedulerOptions) {
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.sync();
    this.timer = setInterval(() => this.sync(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const entry of this.jobs.values()) entry.job.stop();
    this.jobs.clear();
  }

  sync(): void {
    const active = new Map(
      this.store.listAutopilots()
        .filter(isSchedulable)
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

  trigger(autopilotId: string): MulticaAutopilotRun | null {
    return this.runScheduledAutopilot(autopilotId);
  }

  private addJob(autopilot: MulticaAutopilot): void {
    const expression = autopilot.cronExpression;
    if (!expression) return;
    try {
      const job = new Cron(expression, {
        catch: (err) => log.warn(`Scheduled autopilot failed: ${(err as Error).message}`),
        name: `multica:${autopilot.id}`,
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

  private runScheduledAutopilot(autopilotId: string): MulticaAutopilotRun | null {
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
}

function isSchedulable(autopilot: MulticaAutopilot): boolean {
  return autopilot.status === "active"
    && autopilot.triggerKind === "schedule"
    && Boolean(autopilot.cronExpression?.trim());
}
