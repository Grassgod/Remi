/**
 * Transport seam for the Live Hub (MUL-403 §1, ADR 0007 decision 1).
 *
 * Today there is exactly one API process and one adapter, `local`: the hub fans
 * out straight from memory to whoever subscribed in this process. The
 * deployment guarantee for that single process is C1's `pg_try_advisory_lock`
 * guard, not this file.
 *
 * The seam exists so that C2's re-evaluation of per-role processes can add a
 * `LISTEN/NOTIFY` (or other cross-process) adapter without changing a single
 * subscription call site. Adding an adapter means: publish every frame that
 * entered a ring, and deliver every remote frame to the local ring first, so
 * ordering stays the hub's job rather than the bus's.
 *
 * C0 ships the interface plus the local adapter and nothing else. No production
 * module imports this file yet.
 */

import type { HubFrame, HubStreamKey } from "@multiremi/contracts/live-hub.js";

/**
 * Every transport adapter that exists today. A cross-process bus (C2's
 * LISTEN/NOTIFY) appends its own kind here, which is also what `/health` and the
 * tests read to notice that a second process became possible.
 */
export const HUB_TRANSPORT_KINDS = ["local"] as const;

export type HubTransportKind = (typeof HUB_TRANSPORT_KINDS)[number];

/** Wall-clock ms since epoch. Injected so tests do not have to freeze the clock. */
export type HubClock = () => number;

export interface HubTransportPublishInput {
  key: HubStreamKey;
  frames: readonly HubFrame[];
}

export interface HubTransport {
  /** Stable identifier for logs, metrics and `/health`. */
  readonly kind: HubTransportKind | string;

  /**
   * Hand frames that just entered a local ring to every other process.
   *
   * Called at enqueue time, before local fan-out, so a remote subscriber is not
   * ordered behind local work. With a single process this is a no-op and must
   * stay cheap: C1 calls it on the hot path.
   */
  publish(input: HubTransportPublishInput): void;

  /**
   * Receive frames published by another process.
   *
   * The handler must treat them exactly like locally appended frames (dedupe by
   * `seq`, then fan out); it must not assume they are contiguous with the local
   * ring, because a remote publisher may be ahead.
   */
  subscribe(handler: (input: HubTransportPublishInput) => void): { unsubscribe(): void };

  /** Optional readiness probe for `/health`; `local` is always ready. */
  healthy?(): boolean;

  close(): void;
}

/**
 * The only adapter that exists today: fan out inside this process.
 *
 * `publish` is deliberately a no-op rather than a synchronous callback into a
 * local handler list — the hub owns local fan-out, and a transport that
 * re-delivered to its own process would double-send every frame.
 */
export class LocalHubTransport implements HubTransport {
  readonly kind: HubTransportKind = "local";
  private closed = false;

  publish(_input: HubTransportPublishInput): void {
    // Single process: the hub already delivered these frames locally.
  }

  subscribe(_handler: (input: HubTransportPublishInput) => void): { unsubscribe(): void } {
    // Nothing can arrive from another process, so the subscription is inert by
    // construction. It still returns a real handle so a future adapter swap does
    // not change the caller's cleanup path.
    return { unsubscribe: () => {} };
  }

  healthy(): boolean {
    return !this.closed;
  }

  close(): void {
    this.closed = true;
  }
}

/** The transport the API process uses until a second process needs talking to. */
export function createLocalHubTransport(): HubTransport {
  return new LocalHubTransport();
}
