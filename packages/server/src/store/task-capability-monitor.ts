import { createLogger } from "@shared/logger.js";

const log = createLogger("task-capability-monitor");
export const QUEUED_CAPABILITY_SWEEP_MS = 60_000;

export class TaskCapabilityMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(private readonly refresh: ((now: number) => unknown) | readonly ((now: number) => unknown)[]) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), QUEUED_CAPABILITY_SWEEP_MS);
    this.timer.unref?.();
    this.sweep();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sweep(): void {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      for (const job of typeof this.refresh === "function" ? [this.refresh] : this.refresh) {
        try { job(now); }
        catch { log.warn("task maintenance sweep failed"); }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
