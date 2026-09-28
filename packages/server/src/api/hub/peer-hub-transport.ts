import { parseHubStreamKey, type HubStreamKey } from "@multiremi/contracts/live-hub.js";
import type { PeerChannel } from "../peer/peer-channel.js";
import { HUMAN_REQUEST_EVENT_TYPES, type HumanRequestEvent } from "./live-hub.js";
import type {
  HubPeerLink,
  HubPeerLossReason,
  HubPeerStatus,
  HubTransport,
  HubTransportPublishInput,
} from "./hub-transport.js";

export const HUB_PEER_TOPIC = "hub";
export const HUB_PEER_HEARTBEAT_MS = 5_000;
export const HUB_PEER_STALE_MS = 15_000;

type PeerHubPayload =
  | { kind: "head"; key: HubStreamKey; head: number; log_version: number | null; changed_seq?: number }
  | { kind: "human_request"; event: HumanRequestEvent }
  | { kind: "hb" };
type PeerHubFrame = PeerHubPayload & { sender_epoch: string; hub_seq: number };

function isPeerHubFrame(payload: unknown): payload is PeerHubFrame {
  if (!payload || typeof payload !== "object") return false;
  const frame = payload as Record<string, unknown>;
  if (typeof frame.sender_epoch !== "string" || !frame.sender_epoch) return false;
  if (!Number.isSafeInteger(frame.hub_seq) || (frame.hub_seq as number) < 1) return false;
  if (frame.kind === "hb") return true;
  if (frame.kind === "head") {
    return typeof frame.key === "string" && parseHubStreamKey(frame.key)?.stream === "log"
      && Number.isSafeInteger(frame.head) && (frame.head as number) >= 0
      && (frame.log_version === null || Number.isSafeInteger(frame.log_version))
      && (frame.changed_seq === undefined || (Number.isSafeInteger(frame.changed_seq)
        && (frame.changed_seq as number) >= 0 && (frame.changed_seq as number) <= (frame.head as number)));
  }
  if (frame.kind === "human_request") {
    const event = frame.event as Record<string, unknown> | null;
    return Boolean(event && typeof event === "object"
      && typeof event.workspace_id === "string"
      && typeof event.request_id === "string"
      && typeof event.task_id === "string"
      && HUMAN_REQUEST_EVENT_TYPES.includes(event.type as HumanRequestEvent["type"])
      && typeof event.at === "string");
  }
  return false;
}

export interface PeerHubTransportOptions {
  peer: PeerChannel;
  now?: () => number;
  heartbeatMs?: number;
  staleMs?: number;
  onError?: (error: unknown) => void;
}

/** The peer topic contains pointers and transitions; row and trace bodies stay local. */
export class PeerHubTransport implements HubTransport {
  readonly kind = "peer";
  private readonly peer: PeerChannel;
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly subscription: { unsubscribe(): void };
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly onError: (error: unknown) => void;
  private readonly headHandlers = new Set<(key: HubStreamKey, head: number, version: number | null, changedSeq?: number) => Promise<void>>();
  private readonly humanHandlers = new Set<(event: HumanRequestEvent) => void>();
  private readonly lossHandlers = new Set<(reason: HubPeerLossReason) => Promise<void>>();
  private readonly lastByEpoch = new Map<string, number>();
  private readonly retiredEpochs = new Set<string>();
  private activeEpoch: string | null = null;
  private lastReceivedAt: number;
  private nextSeq = 0;
  private duplicateDropped = 0;
  private delivery: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: PeerHubTransportOptions) {
    this.peer = options.peer;
    this.now = options.now ?? Date.now;
    this.staleMs = options.staleMs ?? HUB_PEER_STALE_MS;
    this.lastReceivedAt = this.now();
    this.onError = options.onError ?? (() => {});
    this.subscription = this.peer.subscribe(HUB_PEER_TOPIC, (payload) => {
      this.delivery = this.delivery.then(() => this.receive(payload)).catch(this.onError);
    });
    this.heartbeat = setInterval(() => this.send({ kind: "hb" }), options.heartbeatMs ?? HUB_PEER_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private send(payload: PeerHubPayload): void {
    if (this.closed || !this.peer.enabled) return;
    // Allocate before PeerChannel admission: an evicted event must leave a hole.
    this.peer.publish(HUB_PEER_TOPIC, {
      ...payload,
      sender_epoch: this.peer.origin,
      hub_seq: ++this.nextSeq,
    });
  }

  publish(input: HubTransportPublishInput): void {
    if (!input.key.startsWith("log:")) return;
    for (const frame of input.frames) {
      if (frame.kind === "trace") continue;
      this.send({ kind: "head", key: input.key, head: input.head ?? frame.seq, log_version: null,
        ...(frame.kind === "patch" ? { changed_seq: frame.seq } : {}) });
    }
  }

  publishHumanRequest(event: HumanRequestEvent): void {
    this.send({ kind: "human_request", event });
  }

  subscribe(_handler: (input: HubTransportPublishInput) => void): { unsubscribe(): void } {
    return { unsubscribe() {} };
  }

  onRemoteHead(handler: (key: HubStreamKey, head: number, version: number | null, changedSeq?: number) => Promise<void>): { unsubscribe(): void } {
    this.headHandlers.add(handler);
    return { unsubscribe: () => { this.headHandlers.delete(handler); } };
  }

  onHumanRequest(handler: (event: HumanRequestEvent) => void): { unsubscribe(): void } {
    this.humanHandlers.add(handler);
    return { unsubscribe: () => { this.humanHandlers.delete(handler); } };
  }

  onPossibleLoss(handler: (reason: HubPeerLossReason) => Promise<void>): { unsubscribe(): void } {
    this.lossHandlers.add(handler);
    return { unsubscribe: () => { this.lossHandlers.delete(handler); } };
  }

  peerStatus(): HubPeerStatus {
    const peer_link: HubPeerLink = !this.peer.enabled ? "disabled"
      : this.now() - this.lastReceivedAt >= this.staleMs ? "stale" : "healthy";
    return { peer_link, duplicate_dropped: this.duplicateDropped };
  }

  healthy(): boolean {
    return !this.closed && this.peerStatus().peer_link === "healthy";
  }

  async settled(): Promise<void> {
    await this.delivery;
  }

  private async receive(payload: unknown): Promise<void> {
    if (this.closed || !isPeerHubFrame(payload)) return;
    const frame = payload;
    if (frame.sender_epoch === this.peer.origin) return;
    this.lastReceivedAt = this.now();
    if (this.retiredEpochs.has(frame.sender_epoch)) {
      this.duplicateDropped += 1;
      return;
    }
    const last = this.lastByEpoch.get(frame.sender_epoch);
    if (last !== undefined && frame.hub_seq <= last) {
      this.duplicateDropped += 1;
      return;
    }
    let reason: HubPeerLossReason | null = null;
    if (this.activeEpoch === null) reason = "first_epoch";
    else if (this.activeEpoch !== frame.sender_epoch) {
      this.retiredEpochs.add(this.activeEpoch);
      reason = "epoch_change";
    } else if (last !== undefined && frame.hub_seq > last + 1) reason = "sequence_gap";
    this.activeEpoch = frame.sender_epoch;
    this.lastByEpoch.set(frame.sender_epoch, frame.hub_seq);
    if (reason) {
      for (const handler of this.lossHandlers) await handler(reason);
    }
    if (frame.kind === "head") {
      for (const handler of this.headHandlers) await handler(frame.key, frame.head, frame.log_version, frame.changed_seq);
    } else if (frame.kind === "human_request") {
      for (const handler of this.humanHandlers) handler(frame.event);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.subscription.unsubscribe();
    this.headHandlers.clear();
    this.humanHandlers.clear();
    this.lossHandlers.clear();
  }
}

export function createPeerHubTransport(options: PeerHubTransportOptions): PeerHubTransport {
  return new PeerHubTransport(options);
}
