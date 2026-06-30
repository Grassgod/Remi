/**
 * Daemon orchestration primitives.
 *
 * The reusable, product-agnostic seeds of the runtime orchestrator: per-lane
 * serialization (AsyncLock) and thread-aware session-key derivation. Extracted
 * verbatim from src/core.ts in D6.
 *
 * NOTE: the deep orchestration in the Remi class (message routing loop, provider
 * selection, lane dispatch, auto-recovery) reads/writes Remi instance state and
 * is NOT mechanically separable without a stateful refactor; it stays in the Remi
 * product (→ remi/ in D7) and a fuller Orchestrator extraction is deferred behind
 * characterization tests (see DIR-REDESIGN 铁律#5).
 */

import type { IncomingMessage } from "../connectors/base.js";

/** Simple promise-based mutex for per-lane serialization. */
export class AsyncLock {
  private _queue: Array<() => void> = [];
  private _locked = false;

  /** True when no one holds or waits for the lock. */
  get isIdle(): boolean {
    return !this._locked && this._queue.length === 0;
  }

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }
}

/**
 * Derive the session key for an incoming message.
 *
 * Thread messages (rootId present) share `${chatId}:thread:${rootId}`; group
 * messages without rootId start a new per-@mention session keyed by messageId;
 * P2P messages use plain `chatId` for continuous conversation.
 */
export function resolveSessionKey(msg: IncomingMessage): string {
  const rootId = msg.metadata?.rootId as string | undefined;
  if (rootId) {
    return `${msg.chatId}:thread:${rootId}`;
  }
  // Group messages without rootId: each @mention starts a new session
  // using messageId as thread key (Remi replies in thread, so subsequent
  // messages will have rootId = this messageId, matching this key)
  const chatType = msg.metadata?.chatType as string | undefined;
  const messageId = msg.metadata?.messageId as string | undefined;
  if (chatType === "group" && messageId) {
    return `${msg.chatId}:thread:${messageId}`;
  }
  return msg.chatId;
}

export interface LaneSchedulerOptions {
  /** Max work items running at once across all lanes. Falsy = unbounded. */
  maxConcurrency?: number;
}

/**
 * Bounded, lane-aware work scheduler.
 *
 * The shared concurrency model for both products: work in the **same lane**
 * (e.g. one chat session, keyed by {@link resolveSessionKey}) runs serially,
 * while different lanes run in parallel up to a global concurrency cap. The
 * monolith Remi feeds its message loop through this; the multiremi daemon
 * realizes the same model via its server-side SQL claim queue (per-runtime
 * maxConcurrency + per-issue/chat serialization), so it does not need an
 * in-process LaneScheduler on top.
 *
 * Composes {@link AsyncLock} (per-lane mutex) with a counting semaphore. A lane
 * lock is acquired *before* a global permit so a task waiting behind a same-lane
 * predecessor never holds one of the scarce permits.
 */
export class LaneScheduler {
  private _lanes = new Map<string, AsyncLock>();
  private readonly _limit: number; // 0 = unbounded
  private _active = 0;
  private _permitWaiters: Array<() => void> = [];

  constructor(options: LaneSchedulerOptions = {}) {
    const n = Number(options.maxConcurrency);
    this._limit = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
  }

  /** Number of tasks currently running (past the global permit). */
  get activeCount(): number {
    return this._active;
  }

  /** Run `fn` under lane `laneKey`, respecting per-lane serialization and the global cap. */
  async run<T>(laneKey: string, fn: () => Promise<T>): Promise<T> {
    const lane = this._getLane(laneKey);
    await lane.acquire();
    await this._acquirePermit();
    try {
      return await fn();
    } finally {
      this._releasePermit();
      lane.release();
      if (lane.isIdle) this._lanes.delete(laneKey);
    }
  }

  private _getLane(laneKey: string): AsyncLock {
    let lane = this._lanes.get(laneKey);
    if (!lane) {
      lane = new AsyncLock();
      this._lanes.set(laneKey, lane);
    }
    return lane;
  }

  private async _acquirePermit(): Promise<void> {
    if (this._limit === 0 || this._active < this._limit) {
      this._active++;
      return;
    }
    // At capacity: wait for a permit to be handed to us directly (no increment
    // on wake — the releaser keeps `_active` at the cap during the handoff).
    await new Promise<void>((resolve) => this._permitWaiters.push(resolve));
  }

  private _releasePermit(): void {
    const next = this._permitWaiters.shift();
    if (next) {
      next();
    } else {
      this._active = Math.max(0, this._active - 1);
    }
  }
}
