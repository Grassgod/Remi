/**
 * Clock seam for the connection layer (MUL-417).
 *
 * The acknowledgement deadline is the one part of A-1 whose behaviour is defined
 * by the passage of time, so it is the one part that cannot be tested honestly
 * against the real clock: a test that really waited 15 s would be too slow to
 * run, and one that shortened the constant would stop testing the constant. The
 * session therefore reads time and schedules deadlines through this interface,
 * and the tests install a manual clock.
 */

export interface DaemonProtocolClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): DaemonProtocolTimer;
  clearTimeout(timer: DaemonProtocolTimer): void;
}

/** Opaque timer handle, so the real and fake implementations stay interchangeable. */
export type DaemonProtocolTimer = ReturnType<typeof setTimeout> | number;

export const systemClock: DaemonProtocolClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** A clock the test drives by hand: no timer fires until `advance` says so. */
export class ManualDaemonProtocolClock implements DaemonProtocolClock {
  private current: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; handler: () => void }>();

  constructor(startMs = 1_000_000) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  setTimeout(handler: () => void, ms: number): DaemonProtocolTimer {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + Math.max(0, ms), handler });
    return id as unknown as DaemonProtocolTimer;
  }

  clearTimeout(timer: DaemonProtocolTimer): void {
    this.timers.delete(timer as unknown as number);
  }

  /** Move time forward, firing every timer that comes due in due order. */
  advance(ms: number): void {
    const target = this.current + Math.max(0, ms);
    for (;;) {
      let nextId = 0;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (!nextId) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.current = timer.at;
      timer.handler();
    }
    this.current = target;
  }

  get pendingTimerCount(): number {
    return this.timers.size;
  }
}
