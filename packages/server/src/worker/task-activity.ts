/**
 * The `task.activity` best-effort frame (PR 5 §3.8, §4.4): how many subagents a
 * running attempt has open, for the Chat sidebar badge, and (PR 6) how many
 * background tasks it runs. The counts are recomputed from the attempt's trace
 * fold, so a lost frame is simply replaced: by the next change (debounced), by
 * the periodic refresh while a count is above 0, and on reconnect. The
 * attempt's end reports 0 once anything else was sent.
 */
export const TASK_ACTIVITY_DEBOUNCE_MS = 500;
export const TASK_ACTIVITY_REFRESH_MS = 30_000;

export interface TaskActivityReporterOptions {
  debounceMs?: number;
  refreshMs?: number;
}

export class TaskActivityReporter {
  private value = 0;
  /** Running background tasks; null when the attempt does not track them (the field is then omitted). */
  private tasks: number | null = null;
  /** The last counts sent; 0 before the first. */
  private sent = 0;
  private sentTasks = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private refresh: ReturnType<typeof setInterval> | null = null;
  private finished = false;
  private readonly debounceMs: number;
  private readonly refreshMs: number;

  constructor(private readonly send: (running: number, backgroundTasks: number | null) => void, options: TaskActivityReporterOptions = {}) {
    this.debounceMs = Math.max(0, options.debounceMs ?? TASK_ACTIVITY_DEBOUNCE_MS);
    this.refreshMs = Math.max(1, options.refreshMs ?? TASK_ACTIVITY_REFRESH_MS);
  }

  /** The running count changed; `backgroundTasks` is the attempt's running background tasks, when tracked. */
  update(running: number, backgroundTasks?: number): void {
    if (this.finished) return;
    this.value = Math.max(0, Math.floor(running));
    if (backgroundTasks !== undefined) this.tasks = Math.max(0, Math.floor(backgroundTasks));
    if (this.debounce) return;
    this.debounce = setTimeout(() => this.flush(), this.debounceMs);
    (this.debounce as { unref?: () => void }).unref?.();
  }

  /** The connection came back: the server may have missed the last frame. */
  resend(): void {
    if (this.finished || (this.sent === 0 && this.sentTasks === 0 && this.value === 0 && !this.tasks)) return;
    this.flush();
  }

  /** The attempt ended: stop the timers and clear a count the server may still show. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    if (this.sent > 0 || this.sentTasks > 0) {
      this.value = 0;
      if (this.tasks !== null) this.tasks = 0;
      this.emit();
    }
  }

  private flush(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    if (this.finished) return;
    const active = this.value > 0 || (this.tasks ?? 0) > 0;
    if (!active) this.stopRefresh();
    if (!active && this.sent === 0 && this.sentTasks === 0) return;
    this.emit();
    if (active && !this.refresh) {
      this.refresh = setInterval(() => this.tick(), this.refreshMs);
      (this.refresh as { unref?: () => void }).unref?.();
    }
  }

  /** The periodic refresh: only a count above 0 is repeated; 0 goes out once, through the debounce. */
  private tick(): void {
    if (this.value > 0 || (this.tasks ?? 0) > 0) this.emit();
    else this.stopRefresh();
  }

  private stopRefresh(): void {
    if (this.refresh) clearInterval(this.refresh);
    this.refresh = null;
  }

  private emit(): void {
    this.sent = this.value;
    this.sentTasks = this.tasks ?? 0;
    try {
      this.send(this.value, this.tasks);
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
