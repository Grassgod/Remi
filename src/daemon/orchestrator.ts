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
