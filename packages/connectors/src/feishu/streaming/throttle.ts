/** Coalesce ordinary text, status and tool changes into one full-card patch. */
export const PATCH_INTERVAL_MS = 3000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const SAFETY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export class TimerSlot {
  private timer: ReturnType<typeof setTimeout> | null = null;

  arm(delayMs: number, fn: () => void): void {
    this.clear();
    this.timer = setTimeout(fn, delayMs);
  }

  armIfIdle(delayMs: number, fn: () => void): void {
    if (this.timer) return;
    this.timer = setTimeout(fn, delayMs);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
