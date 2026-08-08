// Throttling and timer plumbing for the Feishu streaming session (audit S17 split).
//
// FeishuStreamingSession ran four independent setTimeout subsystems (safety
// timeout, heartbeat, streaming-window renewal, degraded flush) plus a
// per-element throttle map, each with its own nullable field and clear helper.
// TimerSlot owns that field/clear dance once; ElementThrottler owns the map and
// the throttle-window arithmetic.
//
// Nothing here knows about cards, HTTP or session state: the session passes in
// the work to run (`fn` / `emit`) and the liveness predicates it wants honoured.

/** Independent throttle per element — thinking and content don't interfere. */
export const ELEMENT_THROTTLE_MS = 300;

/** Safety timeout: auto-close abandoned cards. */
export const SAFETY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Heartbeat: periodic status update when no events arrive. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Switch to degraded at 9.5 min, before Feishu's 10 min streaming hard limit. */
export const STREAMING_RENEW_MS = 9.5 * 60 * 1000;

export const DEGRADED_FLUSH_MS = 3000;
export const PERMISSION_FLUSH_MS = 100;

/**
 * One nullable setTimeout handle with the clear-before-rearm dance the session
 * repeated four times.
 */
export class TimerSlot {
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** (Re)start the slot, cancelling whatever was pending. */
  arm(delayMs: number, fn: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(fn, delayMs);
  }

  /** Start the slot only if nothing is already scheduled. */
  armIfIdle(delayMs: number, fn: () => void): void {
    if (this.timer) return;
    this.timer = setTimeout(fn, delayMs);
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// ── Per-element throttle state ──────────────────────────────

interface ElementThrottle {
  lastSendTime: number;
  pending: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Per-element send throttle. `schedule()` either emits immediately (throttle
 * window elapsed) or stores the content as pending and arms a deferred flush;
 * the caller supplies `emit`, which is what actually talks to Feishu.
 */
export class ElementThrottler {
  private throttles = new Map<string, ElementThrottle>();

  constructor(private throttleMs: number = ELEMENT_THROTTLE_MS) {}

  private _getThrottle(elementId: string): ElementThrottle {
    if (!this.throttles.has(elementId)) {
      this.throttles.set(elementId, {
        lastSendTime: 0,
        pending: null,
        timer: null,
      });
    }
    return this.throttles.get(elementId)!;
  }

  /**
   * Throttled update for a specific element. `emit` is invoked synchronously
   * when the window has elapsed, otherwise from the deferred timer (which
   * bails out first if `isStopped()` reports the session is gone).
   */
  schedule(
    elementId: string,
    content: string,
    isStopped: () => boolean,
    emit: (text: string) => void,
  ): void {
    const throttle = this._getThrottle(elementId);
    const now = Date.now();

    if (now - throttle.lastSendTime >= this.throttleMs) {
      throttle.pending = null;
      throttle.lastSendTime = now;
      emit(content);
    } else {
      // Within throttle window — store pending and schedule deferred flush
      throttle.pending = content;
      if (!throttle.timer) {
        const delay = this.throttleMs - (now - throttle.lastSendTime);
        throttle.timer = setTimeout(() => {
          throttle.timer = null;
          if (isStopped()) return;

          const text = throttle.pending;
          if (text === null) return;
          throttle.pending = null;
          throttle.lastSendTime = Date.now();
          emit(text);
        }, delay);
      }
    }
  }

  /**
   * Cancel every scheduled timer and hand any pending content back to `emit`.
   * `canFlush` is re-checked per element, matching the session's `this.state`
   * guard: when it is false the content stays pending.
   */
  flush(canFlush: () => boolean, emit: (elementId: string, text: string) => void): void {
    for (const [elementId, throttle] of this.throttles) {
      // Cancel any scheduled timer
      if (throttle.timer) {
        clearTimeout(throttle.timer);
        throttle.timer = null;
      }
      // Send any pending content
      if (throttle.pending !== null && canFlush()) {
        const text = throttle.pending;
        throttle.pending = null;
        emit(elementId, text);
      }
    }
  }
}
