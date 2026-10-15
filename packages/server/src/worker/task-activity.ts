/**
 * The `task.activity` best-effort frame (PR 5 §3.8, §4.4): how many subagents a
 * running attempt has open, for the Chat sidebar badge. The count is recomputed
 * from the attempt's trace fold, so a lost frame is simply replaced: by the
 * next change (debounced), by the periodic refresh while the count is above 0,
 * and on reconnect. The attempt's end reports 0 once anything else was sent.
 */
export const TASK_ACTIVITY_DEBOUNCE_MS = 500;
export const TASK_ACTIVITY_REFRESH_MS = 30_000;

export interface TaskActivityReporterOptions {
  debounceMs?: number;
  refreshMs?: number;
}

export class TaskActivityReporter {
  private value = 0;
  /** The last count sent; 0 before the first. */
  private sent = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private refresh: ReturnType<typeof setInterval> | null = null;
  private finished = false;
  private readonly debounceMs: number;
  private readonly refreshMs: number;

  constructor(private readonly send: (running: number) => void, options: TaskActivityReporterOptions = {}) {
    this.debounceMs = Math.max(0, options.debounceMs ?? TASK_ACTIVITY_DEBOUNCE_MS);
    this.refreshMs = Math.max(1, options.refreshMs ?? TASK_ACTIVITY_REFRESH_MS);
  }

  /** The running count changed. */
  update(running: number): void {
    if (this.finished) return;
    this.value = Math.max(0, Math.floor(running));
    if (this.debounce) return;
    this.debounce = setTimeout(() => this.flush(), this.debounceMs);
    (this.debounce as { unref?: () => void }).unref?.();
  }

  /** The connection came back: the server may have missed the last frame. */
  resend(): void {
    if (this.finished || (this.sent === 0 && this.value === 0)) return;
    this.flush();
  }

  /** The attempt ended: stop the timers and clear a count the server may still show. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    if (this.sent > 0) this.emit(0);
  }

  private flush(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    if (this.finished) return;
    if (this.value === 0) this.stopRefresh();
    if (this.value === this.sent && this.value === 0) return;
    this.emit(this.value);
    if (this.value > 0 && !this.refresh) {
      this.refresh = setInterval(() => this.tick(), this.refreshMs);
      (this.refresh as { unref?: () => void }).unref?.();
    }
  }

  /** The periodic refresh: only a count above 0 is repeated; 0 goes out once, through the debounce. */
  private tick(): void {
    if (this.value > 0) this.emit(this.value);
    else this.stopRefresh();
  }

  private stopRefresh(): void {
    if (this.refresh) clearInterval(this.refresh);
    this.refresh = null;
  }

  private emit(running: number): void {
    this.sent = running;
    try {
      this.send(running);
    } catch {
      // Best effort: the next change or refresh replaces a frame that failed.
    }
  }

  private clearTimers(): void {
    if (this.debounce) clearTimeout(this.debounce);
    if (this.refresh) clearInterval(this.refresh);
    this.debounce = null;
    this.refresh = null;
  }
}
