/**
 * Transport seam for the Live Hub (MUL-403 §1, ADR 0007 decision 1).
 *
 * Local fan-out stays in the hub. The peer adapter publishes only log head
 * pointers and human-request transitions over MUL-462's shared channel.
 */

import type { HubFrame, HubStreamKey } from "@multiremi/contracts/live-hub.js";
import type { HumanRequestEvent } from "./live-hub.js";

/**
 * Every transport adapter that exists today. A cross-process bus (C2's
 * LISTEN/NOTIFY) appends its own kind here, which is what `/health` and the tests
 * read to notice that a second process became possible.
 *
 * `HubTransport.kind` is a plain string on purpose: an adapter added outside this
 * package must be able to name itself without editing this list. The census is
 * the thing that is checked, not the type.
 */
export const HUB_TRANSPORT_KINDS = ["local", "peer"] as const;

export type HubTransportKind = (typeof HUB_TRANSPORT_KINDS)[number];

/** Wall-clock ms since epoch. Injected so tests do not have to freeze the clock. */
export type HubClock = () => number;

export interface HubTransportPublishInput {
  key: HubStreamKey;
  frames: readonly HubFrame[];
  head?: number;
}

export type HubPeerLossReason = "first_epoch" | "epoch_change" | "sequence_gap";
export type HubPeerLink = "disabled" | "healthy" | "stale";

export interface HubPeerStatus {
  peer_link: HubPeerLink;
  duplicate_dropped: number;
}

export interface HubTransport {
  /** Stable identifier for logs, metrics and `/health`. */
  readonly kind: string;

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

  /** Peer adapters deliver pointers, never log row bodies or trace frames. */
  onRemoteHead?(handler: (key: HubStreamKey, head: number, logVersion: number | null, changedSeq?: number) => Promise<void>): { unsubscribe(): void };
  onHumanRequest?(handler: (event: HumanRequestEvent) => void): { unsubscribe(): void };
  publishHumanRequest?(event: HumanRequestEvent): void;
  onPossibleLoss?(handler: (reason: HubPeerLossReason) => Promise<void>): { unsubscribe(): void };
  peerStatus?(): HubPeerStatus;

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
