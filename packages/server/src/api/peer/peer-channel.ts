/**
 * Cross-process realtime peer channel (MUL-462, MUL-455 §1.4).
 *
 * Two API processes can talk to each other over a loopback HTTP POST:
 * `POST /internal/peer/events` on the peer, authenticated with a shared secret
 * (`MULTIREMI_PEER_SECRET`, falling back to `MULTIREMI_TOKEN`).
 *
 * The sending half is a process-internal queue with one serial flush chain:
 * batching (`setTimeout(flush, 0)`, at most 64 events or 1 MiB per POST) is what
 * keeps a busy workspace from turning every store write into a request, and the
 * single chain is what keeps order — the next POST only starts after the
 * previous one returned, so `task:message` rows arrive in `seq` order. A failed
 * flush puts its batch back at the head of the queue and backs off 1s → 10s.
 * The queue is capped at 10 000 events; overflow drops the oldest and counts it,
 * which is what keeps a dead peer from turning into unbounded memory growth.
 *
 * The receiving half delivers to local subscribers only. It never re-publishes
 * to the peer: that would let two processes echo one event forever.
 *
 * `MULTIREMI_PEER_URL` unset means "no channel": nothing is published, the
 * routes answer 503, and the API behaves exactly as it did before the split.
 *
 * This is also the transport MUL-403's `HubTransport` `kind: "peer"` adapter
 * builds on: `publish(topic, payload)` / `subscribe(topic, handler)` are
 * deliberately topic-generic, `realtime` is just the first topic.
 */
import { randomUUID } from "node:crypto";
import { parsePeerEventEnvelope } from "@multiremi/contracts/peer-events.js";
import {
  recordPeerBatch,
  recordPeerDropped,
  recordPeerFailure,
} from "../../observability/request-metrics.js";

/** Topic the realtime fanout publishes on. */
export const PEER_REALTIME_TOPIC = "realtime";

/** Defaults fixed by the MUL-455 plan (§1.4 item 2). */
export const PEER_MAX_BATCH_EVENTS = 64;
export const PEER_MAX_BATCH_BYTES = 1_048_576;
export const PEER_REQUEST_TIMEOUT_MS = 2_000;
export const PEER_MIN_BACKOFF_MS = 1_000;
export const PEER_MAX_BACKOFF_MS = 10_000;
export const PEER_QUEUE_LIMIT = 10_000;

export interface PeerChannelStats {
  /** Whether a peer URL is configured. `false` means the channel is inert. */
  enabled: boolean;
  origin: string;
  /** Events still waiting to be sent. */
  queued: number;
  /** Events successfully POSTed to the peer. */
  sent: number;
  /** Successful POSTs. */
  batches: number;
  /** Events discarded by queue overflow. */
  dropped: number;
  /** Failed POST attempts (one per retry, not per event). */
  failed: number;
  /** Events accepted from the peer and delivered locally. */
  received: number;
  /** Inbound events refused (bad envelope, or our own origin echoed back). */
  rejected: number;
  /** Round-trip p95 of this process's successful POSTs, milliseconds. */
  rtt_p95_ms: number;
}

export interface PeerChannelSubscription {
  unsubscribe(): void;
}

export interface PeerChannel {
  readonly enabled: boolean;
  readonly origin: string;
  /** Enqueue `payload` for the peer, under `topic`. Local delivery is the caller's job. */
  publish(topic: string, payload: unknown): void;
  /** Subscribe to payloads the peer sent us under `topic`. */
  subscribe(topic: string, handler: (payload: unknown) => void): PeerChannelSubscription;
  /**
   * Accept one inbound batch from the peer. Local subscribers only — an inbound
   * event is never published back.
   */
  receive(topic: string, events: unknown[]): { accepted: number; rejected: number };
  stats(): PeerChannelStats;
  /** True while no flush attempt is failing and the channel is open. */
  healthy(): boolean;
  close(): void;
}

export interface PeerChannelOptions {
  /** Peer base URL, e.g. `http://api-runtime:6120`. Null/undefined disables the channel. */
  url?: string | null;
  /** Shared secret. Empty means the route refuses everything. */
  secret?: string | null;
  /** This process's identity; echoed peers use it to drop their own events. */
  origin?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: PeerFetch;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  requestTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  queueLimit?: number;
}

interface QueuedPeerEvent {
  topic: string;
  /** Pre-serialized payload: batching a batch never re-encodes the events. */
  json: string;
  bytes: number;
}

/**
 * The slice of `fetch` this channel uses.
 *
 * Deliberately narrower than `typeof fetch`: Bun's global carries static helpers
 * (`preconnect`) that a test double has no reason to implement.
 */
export type PeerFetch = (url: string, init: RequestInit) => Promise<Response>;

const RTT_SAMPLE_LIMIT = 256;

/** Read `MULTIREMI_PEER_URL` / `MULTIREMI_PEER_SECRET` for this process. */
export function resolvePeerSecret(env: Record<string, string | undefined> = process.env): string {
  return env.MULTIREMI_PEER_SECRET?.trim() || env.MULTIREMI_TOKEN?.trim() || "";
}

export function resolvePeerUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.MULTIREMI_PEER_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/** The peer channel the API process uses. Null when `MULTIREMI_PEER_URL` is unset. */
export function createPeerChannelFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: PeerChannelOptions = {},
): PeerChannel | null {
  const url = options.url === undefined ? resolvePeerUrl(env) : options.url;
  if (!url) return null;
  return createPeerChannel({
    ...options,
    url,
    secret: options.secret === undefined ? resolvePeerSecret(env) : options.secret,
  });
}

export function createPeerChannel(options: PeerChannelOptions = {}): PeerChannel {
  return new HttpPeerChannel(options);
}

export function percentilesForPeerRtt(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[index]!;
}

class HttpPeerChannel implements PeerChannel {
  readonly origin: string;
  private readonly url: string;
  private readonly secret: string;
  private readonly maxBatchEvents: number;
  private readonly maxBatchBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly queueLimit: number;
  private readonly fetchImpl: PeerFetch;
  private readonly subscribers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly rttSamples: number[] = [];

  private queue: QueuedPeerEvent[] = [];
  private queuedBytes = 0;
  private scheduled = false;
  private flushing = false;
  private consecutiveFailures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private sent = 0;
  private batches = 0;
  private dropped = 0;
  private failed = 0;
  private received = 0;
  private rejected = 0;

  constructor(options: PeerChannelOptions) {
    this.url = `${options.url ?? ""}`.trim().replace(/\/+$/, "");
    this.secret = options.secret?.trim() ?? "";
    this.origin = options.origin?.trim() || randomUUID();
    this.maxBatchEvents = Math.max(1, Math.trunc(options.maxBatchEvents ?? PEER_MAX_BATCH_EVENTS));
    this.maxBatchBytes = Math.max(1, Math.trunc(options.maxBatchBytes ?? PEER_MAX_BATCH_BYTES));
    this.requestTimeoutMs = Math.max(1, Math.trunc(options.requestTimeoutMs ?? PEER_REQUEST_TIMEOUT_MS));
    this.minBackoffMs = Math.max(1, Math.trunc(options.minBackoffMs ?? PEER_MIN_BACKOFF_MS));
    this.maxBackoffMs = Math.max(this.minBackoffMs, Math.trunc(options.maxBackoffMs ?? PEER_MAX_BACKOFF_MS));
    this.queueLimit = Math.max(1, Math.trunc(options.queueLimit ?? PEER_QUEUE_LIMIT));
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get enabled(): boolean {
    return this.url.length > 0 && !this.closed;
  }

  publish(topic: string, payload: unknown): void {
    if (!this.enabled || !topic) return;
    let json: string;
    try {
      json = JSON.stringify(payload);
    } catch {
      // A non-serializable payload (cycle) is a caller bug; dropping it keeps
      // the store write that produced it from failing.
      this.dropped += 1;
      recordPeerDropped(1);
      return;
    }
    const bytes = Buffer.byteLength(json, "utf8");
    while (this.queue.length >= this.queueLimit) {
      const evicted = this.queue.shift();
      if (!evicted) break;
      this.queuedBytes -= evicted.bytes;
      this.dropped += 1;
      recordPeerDropped(1);
    }
    this.queue.push({ topic, json, bytes });
    this.queuedBytes += bytes;
    this.schedule();
  }

  subscribe(topic: string, handler: (payload: unknown) => void): PeerChannelSubscription {
    let handlers = this.subscribers.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(topic, handlers);
    }
    handlers.add(handler);
    return {
      unsubscribe: () => {
        const current = this.subscribers.get(topic);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) this.subscribers.delete(topic);
      },
    };
  }

  receive(topic: string, events: unknown[]): { accepted: number; rejected: number } {
    let accepted = 0;
    let rejected = 0;
    const handlers = [...(this.subscribers.get(topic) ?? [])];
    for (const event of events) {
      // Only the realtime topic has a contracted envelope today; other topics
      // (MUL-403's `hub`) bring their own shape and are delivered as-is.
      if (topic === PEER_REALTIME_TOPIC) {
        const envelope = parsePeerEventEnvelope(event);
        if (!envelope || envelope.origin === this.origin) {
          rejected += 1;
          continue;
        }
      } else if (event === null || event === undefined) {
        rejected += 1;
        continue;
      }
      accepted += 1;
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // A subscriber that throws must not stop the rest of the batch.
        }
      }
    }
    this.received += accepted;
    this.rejected += rejected;
    return { accepted, rejected };
  }

  stats(): PeerChannelStats {
    return {
      enabled: this.enabled,
      origin: this.origin,
      queued: this.queue.length,
      sent: this.sent,
      batches: this.batches,
      dropped: this.dropped,
      failed: this.failed,
      received: this.received,
      rejected: this.rejected,
      rtt_p95_ms: Math.round(percentilesForPeerRtt(this.rttSamples) * 10) / 10,
    };
  }

  healthy(): boolean {
    return !this.closed && this.consecutiveFailures === 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.scheduled = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.queue.length > 0) {
      this.dropped += this.queue.length;
      recordPeerDropped(this.queue.length);
      this.queue = [];
      this.queuedBytes = 0;
    }
    this.subscribers.clear();
  }

  /** Coalesce everything enqueued in this tick into one flush pass. */
  private schedule(): void {
    if (this.scheduled || this.flushing || this.closed || this.retryTimer) return;
    this.scheduled = true;
    const timer = setTimeout(() => {
      this.scheduled = false;
      void this.flush();
    }, 0);
    timer.unref?.();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    const delay = this.consecutiveFailures <= 1
      ? this.minBackoffMs
      : Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** (this.consecutiveFailures - 1));
    const timer = setTimeout(() => {
      this.retryTimer = null;
      this.schedule();
    }, delay);
    timer.unref?.();
    this.retryTimer = timer;
  }

  /** Take the longest run of same-topic events that fits one POST. */
  private takeBatch(): QueuedPeerEvent[] {
    const first = this.queue[0]!;
    const batch: QueuedPeerEvent[] = [first];
    let bytes = first.bytes;
    for (let index = 1; index < this.queue.length; index += 1) {
      if (batch.length >= this.maxBatchEvents) break;
      const candidate = this.queue[index]!;
      if (candidate.topic !== first.topic) break;
      if (bytes + candidate.bytes > this.maxBatchBytes) break;
      batch.push(candidate);
      bytes += candidate.bytes;
    }
    this.queue.splice(0, batch.length);
    this.queuedBytes -= batch.reduce((total, event) => total + event.bytes, 0);
    return batch;
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const batch = this.takeBatch();
        const body = `{"topic":${JSON.stringify(batch[0]!.topic)},"events":[${batch.map((event) => event.json).join(",")}]}`;
        const startedAt = performance.now();
        try {
          await this.post(body);
        } catch {
          // Put the batch back at the head so ordering survives the retry, then
          // enforce the cap again (the burst may have grown while we waited).
          this.queue.unshift(...batch);
          this.queuedBytes += batch.reduce((total, event) => total + event.bytes, 0);
          this.trimOverflow();
          this.failed += 1;
          this.consecutiveFailures += 1;
          recordPeerFailure();
          this.scheduleRetry();
          return;
        }
        this.consecutiveFailures = 0;
        this.sent += batch.length;
        this.batches += 1;
        const rtt = performance.now() - startedAt;
        this.rttSamples.push(rtt);
        if (this.rttSamples.length > RTT_SAMPLE_LIMIT) this.rttSamples.shift();
        recordPeerBatch({ events: batch.length, rttMs: rtt });
      }
    } finally {
      this.flushing = false;
    }
  }

  private trimOverflow(): void {
    while (this.queue.length > this.queueLimit) {
      const evicted = this.queue.shift();
      if (!evicted) break;
      this.queuedBytes -= evicted.bytes;
      this.dropped += 1;
      recordPeerDropped(1);
    }
  }

  private async post(body: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(`${this.url}/internal/peer/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.secret}`,
        },
        body,
        signal: controller.signal,
        // The runtime pools connections by default; `keepalive` keeps this true
        // on runtimes that implement it per-request instead.
        keepalive: true,
      });
      if (!response.ok) throw new Error(`peer responded ${response.status}`);
      // Drain the body so the pooled connection can be reused.
      await response.arrayBuffer().catch(() => new ArrayBuffer(0));
    } finally {
      clearTimeout(timeout);
    }
  }
}
