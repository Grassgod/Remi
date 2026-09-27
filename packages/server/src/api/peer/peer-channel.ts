/**
 * Cross-process realtime peer channel (MUL-462, MUL-455 §1.4).
 *
 * Two API processes can talk to each other over a loopback HTTP POST:
 * `POST /internal/peer/events` on the peer, authenticated with a shared secret
 * (`MULTIREMI_PEER_SECRET`, falling back to `MULTIREMI_TOKEN`).
 *
 * The sending half is a process-internal queue with one serial flush chain:
 * batching (`setTimeout(flush, 0)`) is what keeps a busy workspace from turning
 * every store write into a request, and the single chain is what keeps order —
 * the next POST only starts after the previous one returned, so `task:message`
 * rows arrive in `seq` order.
 *
 * Three size rules keep one write from becoming an unbounded or slow frame:
 *
 *   - a single event is serialized on its own and must fit `PEER_MAX_EVENT_BYTES`.
 *     A `task_messages` append is split one message per event first (each message
 *     is capped at 256 KiB by the store), so the daemon's 256 × 256 KiB batch
 *     becomes 256 small events instead of one 64 MiB stringify;
 *   - an event that is still too large is degraded to a task reference when the
 *     event kind allows it (the receiver shares the database and re-reads the
 *     row); anything else is dropped, counted, and logged without its payload;
 *   - a batch body — wrapper, topic, separators and all — must fit one POST, and
 *     the batching loop measures the real serialized bytes rather than
 *     estimating from event sizes.
 *
 * Delivery is at-least-once with retry: a failed flush puts its batch back at the
 * head of the queue and backs off 1s → 10s, and the batch keeps its number. The
 * receiver remembers the highest `batch_seq` it has handled per `epoch`, so a
 * retry that the sender never saw the response for is answered `duplicate` and
 * not delivered twice. A receiver restart clears that memory (the old browser
 * sockets are gone with it and reconnecting clients refetch), which is the one
 * window where a batch can be delivered twice.
 *
 * The receiving half delivers to local subscribers only. It never re-publishes
 * to the peer: that would let two processes echo one event forever.
 *
 * `MULTIREMI_PEER_URL` unset means "no channel": nothing is published, the
 * routes answer 401 rather than advertising that this process has no peer, and
 * the API behaves exactly as it did before the split.
 *
 * This is also the transport MUL-403's `HubTransport` `kind: "peer"` adapter
 * builds on: `publish(topic, payload)` / `subscribe(topic, handler)` are
 * deliberately topic-generic, `realtime` is just the first topic.
 */
import { randomUUID } from "node:crypto";
import { parsePeerEventEnvelope, type PeerEventKind } from "@multiremi/contracts/peer-events.js";
import {
  recordPeerBatch,
  recordPeerDegraded,
  recordPeerDropped,
  recordPeerDuplicate,
  recordPeerFailure,
  recordPeerOversizeDropped,
} from "../../observability/request-metrics.js";

/** Topic the realtime fanout publishes on. */
export const PEER_REALTIME_TOPIC = "realtime";

/**
 * Hard ceiling for one POST body: the wrapper, the topic, the dedupe pair, the
 * separators and every serialized event together.
 */
export const PEER_MAX_BATCH_BYTES = 1_048_576;

/** Ceiling for one serialized event. Half the batch, so two of them plus wrapper still fit. */
export const PEER_MAX_EVENT_BYTES = 512 * 1024;

/**
 * Events per POST, kept from the original plan alongside the byte budget: a
 * batch is parsed in one go by the receiver, and 64 small events bound that
 * parse even when every one of them is well under the size limit.
 */
export const PEER_MAX_BATCH_EVENTS = 64;

export const PEER_REQUEST_TIMEOUT_MS = 2_000;
export const PEER_MIN_BACKOFF_MS = 1_000;
export const PEER_MAX_BACKOFF_MS = 10_000;
export const PEER_QUEUE_LIMIT = 10_000;
/**
 * Byte budget for the send queue, measured over the *backlog*.
 *
 * The distinction is load-bearing. One legal store write can be larger than the
 * budget by itself: the daemon may append 256 messages of 256 KiB in a single
 * call, which is ~64 MiB of events, and the contract says a legal report arrives
 * complete and in `seq` order. Cutting that burst apart would break the very
 * ordering the channel exists to preserve.
 *
 * So both caps are enforced per produce call, against everything queued *before*
 * that call: the backlog is evicted oldest-first until it fits, and the call that
 * triggered the eviction is then admitted whole. The invariants are:
 *
 *   - any single legal produce call is delivered complete, in order;
 *   - a peer that stays down cannot accumulate backlog — each new call first
 *     evicts the backlog down to the caps;
 *   - the queue never exceeds `cap + one produce burst`, rather than growing with
 *     however many writes happen to land in the same tick.
 */
export const PEER_MAX_QUEUE_BYTES = 32 * 1_048_576;

/**
 * The outbound envelope's own weight, measured on a real envelope with an empty
 * payload. Used only to refuse an opaque (non-realtime) payload that could never
 * fit one body; the batch loop measures the final body exactly.
 */
const ENVELOPE_WEIGHT_BYTES = Buffer.byteLength(JSON.stringify({
  v: 1,
  origin: "00000000-0000-0000-0000-000000000000",
  kind: "workspace_event",
  payload: {},
}));

export interface PeerChannelStats {
  /** Whether a peer URL is configured. `false` means the channel is inert. */
  enabled: boolean;
  origin: string;
  /** Events still waiting to be sent. */
  queued: number;
  /** Serialized bytes still waiting to be sent. */
  queued_bytes: number;
  /** Events successfully POSTed to the peer. */
  sent: number;
  /** Successful POSTs. */
  batches: number;
  /** Events discarded by queue overflow or by a single-event size limit. */
  dropped: number;
  /** Events discarded because one event alone exceeded the event budget. */
  oversize_dropped: number;
  /** Events the sender slimmed down to a task reference. */
  degraded: number;
  /** Failed POST attempts (one per retry, not per event). */
  failed: number;
  /** Events accepted from the peer and delivered locally. */
  received: number;
  /** Inbound events refused (bad envelope, or our own origin echoed back). */
  rejected: number;
  /** Batches recognized as a retry and answered without re-delivering. */
  duplicates: number;
  /** Inbound events that arrived as a degraded task reference. */
  degraded_received: number;
  /** Round-trip p95 of this process's successful POSTs, milliseconds. */
  rtt_p95_ms: number;
}

export interface PeerChannelSubscription {
  unsubscribe(): void;
}

/** What `receive` did with one inbound batch. */
export interface PeerReceiveResult {
  accepted: number;
  rejected: number;
  duplicate: boolean;
}

export interface PeerChannel {
  readonly enabled: boolean;
  readonly origin: string;
  /**
   * Enqueue one opaque payload. Used for topics whose framing the channel does
   * not know (MUL-403's `hub`); the realtime path uses `forwardRealtime` so it
   * gets splitting and degradation.
   */
  publish(topic: string, payload: unknown): void;
  /**
   * Enqueue one realtime event, splitting or degrading it as the kind allows.
   * `payload` is the same shape the receiver's delivery path consumes.
   */
  forwardRealtime(kind: PeerEventKind, payload: Record<string, unknown>): void;
  /** Subscribe to payloads the peer sent us under `topic`. */
  subscribe(topic: string, handler: (payload: unknown) => void): PeerChannelSubscription;
  /**
   * Accept one inbound batch from the peer. Local subscribers only — an inbound
   * event is never published back.
   */
  receive(topic: string, events: unknown[], dedupe?: { epoch: string; batchSeq: number }): PeerReceiveResult;
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
  /** This process's identity; a peer drops an envelope that carries it back. */
  origin?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: PeerFetch;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  maxEventBytes?: number;
  requestTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  queueLimit?: number;
  maxQueueBytes?: number;
  /** Test seam for the drop warning; defaults to `console.warn`. */
  onOversizeDrop?: (info: { topic: string; kind: string | null; bytes: number }) => void;
}

/**
 * The slice of `fetch` this channel uses.
 *
 * Deliberately narrower than `typeof fetch`: Bun's global carries static helpers
 * (`preconnect`) that a test double has no reason to implement.
 */
export type PeerFetch = (url: string, init: RequestInit) => Promise<Response>;

interface QueuedPeerEvent {
  topic: string;
  /** Pre-serialized payload: batching a batch never re-encodes the events. */
  json: string;
  bytes: number;
}

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

/** Byte length of `value` once serialized as JSON. Throws on a cyclic value. */
function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

class HttpPeerChannel implements PeerChannel {
  readonly origin: string;
  private readonly url: string;
  private readonly secret: string;
  private readonly maxBatchEvents: number;
  private readonly maxBatchBytes: number;
  private readonly maxEventBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly queueLimit: number;
  private readonly maxQueueBytes: number;
  private readonly fetchImpl: PeerFetch;
  private readonly onOversizeDrop: (info: { topic: string; kind: string | null; bytes: number }) => void;
  private readonly subscribers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly rttSamples: number[] = [];
  /** Highest handled `batch_seq` per peer epoch. One entry per live peer. */
  private readonly handledBatches = new Map<string, number>();

  private queue: QueuedPeerEvent[] = [];
  private queuedBytes = 0;
  /**
   * How many entries at the head of the queue are eligible for eviction, i.e.
   * backlog that was already waiting when this flush cycle started. Entries
   * beyond it belong to the burst being flushed right now and are exempt.
   */
  private droppableCount = 0;
  private scheduled = false;
  private flushing = false;
  /** Number handed to the batch currently in flight; retries reuse it. */
  private inflightBatchSeq: number | null = null;
  private nextBatchSeq = 1;
  private consecutiveFailures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private sent = 0;
  private batches = 0;
  private dropped = 0;
  private oversizeDropped = 0;
  private degraded = 0;
  private failed = 0;
  private received = 0;
  private rejected = 0;
  private duplicates = 0;
  private degradedReceived = 0;

  constructor(options: PeerChannelOptions) {
    this.url = `${options.url ?? ""}`.trim().replace(/\/+$/, "");
    this.secret = options.secret?.trim() ?? "";
    this.origin = options.origin?.trim() || randomUUID();
    this.maxBatchEvents = Math.max(1, Math.trunc(options.maxBatchEvents ?? PEER_MAX_BATCH_EVENTS));
    this.maxBatchBytes = Math.max(64, Math.trunc(options.maxBatchBytes ?? PEER_MAX_BATCH_BYTES));
    this.maxEventBytes = Math.max(16, Math.trunc(options.maxEventBytes ?? PEER_MAX_EVENT_BYTES));
    this.requestTimeoutMs = Math.max(1, Math.trunc(options.requestTimeoutMs ?? PEER_REQUEST_TIMEOUT_MS));
    this.minBackoffMs = Math.max(1, Math.trunc(options.minBackoffMs ?? PEER_MIN_BACKOFF_MS));
    this.maxBackoffMs = Math.max(this.minBackoffMs, Math.trunc(options.maxBackoffMs ?? PEER_MAX_BACKOFF_MS));
    this.queueLimit = Math.max(1, Math.trunc(options.queueLimit ?? PEER_QUEUE_LIMIT));
    this.maxQueueBytes = Math.max(this.maxBatchBytes, Math.trunc(options.maxQueueBytes ?? PEER_MAX_QUEUE_BYTES));
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.onOversizeDrop = options.onOversizeDrop ?? ((info) => {
      // Never the payload: the size is the interesting part, the body is not.
      console.warn(
        `[peer-channel] dropped oversize event: topic=${info.topic} kind=${info.kind ?? "unknown"} bytes=${info.bytes}`,
      );
    });
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
      this.dropEvent(1);
      return;
    }
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes + ENVELOPE_WEIGHT_BYTES > this.maxEventBytes) {
      // An opaque topic (the hub) cannot be degraded or split here.
      this.dropOversize(topic, null, bytes);
      return;
    }
    this.enqueueBurst(topic, [{ json, bytes }]);
  }

  forwardRealtime(kind: PeerEventKind, payload: Record<string, unknown>): void {
    if (!this.enabled) return;
    // Split before serializing: a `task_messages` append can carry a quarter
    // megabyte per message and 256 of them at once, and stringify of the whole
    // thing would block this process for tens of milliseconds.
    const events: Array<{ json: string; bytes: number }> = [];
    for (const part of splitRealtimePayload(kind, payload)) {
      const event = this.buildRealtimeEvent(kind, part);
      if (event) events.push(event);
    }
    this.enqueueBurst(PEER_REALTIME_TOPIC, events);
  }

  /**
   * Serialize one realtime event, degrading it to a task reference when it does
   * not fit. Returns null when even the degraded form cannot be sent.
   */
  private buildRealtimeEvent(kind: PeerEventKind, payload: Record<string, unknown>): { json: string; bytes: number } | null {
    const full = this.trySerialize(kind, payload);
    if (full) return full;
    const degraded = degradeRealtimePayload(kind, payload);
    if (degraded) {
      const slim = this.trySerialize(kind, degraded);
      if (slim) {
        this.degraded += 1;
        recordPeerDegraded();
        return slim;
      }
    }
    this.dropOversize(PEER_REALTIME_TOPIC, kind, this.measure(kind, payload));
    return null;
  }

  private trySerialize(kind: PeerEventKind, payload: Record<string, unknown>): { json: string; bytes: number } | null {
    const envelope = {
      v: 1 as const,
      origin: this.origin,
      kind,
      payload,
    };
    let json: string;
    try {
      json = JSON.stringify(envelope);
    } catch {
      return null;
    }
    const bytes = Buffer.byteLength(json, "utf8");
    return bytes <= this.maxEventBytes ? { json, bytes } : null;
  }

  /** Serialized size of a payload we are about to reject, for the warning. */
  private measure(kind: PeerEventKind, payload: Record<string, unknown>): number {
    try {
      return Buffer.byteLength(JSON.stringify({ v: 1, origin: this.origin, kind, payload }), "utf8");
    } catch {
      return 0;
    }
  }

  /**
   * Admit one produce call's events as a unit.
   *
   * The backlog is trimmed before the burst is added and the burst itself is
   * never trimmed, which is what keeps a legal multi-message report whole while
   * still bounding what a slow peer can accumulate. See PEER_MAX_QUEUE_BYTES.
   */
  private enqueueBurst(topic: string, parts: ReadonlyArray<{ json: string; bytes: number }>): void {
    if (parts.length === 0) return;
    this.trimOverflow();
    for (const part of parts) {
      this.queue.push({ topic, json: part.json, bytes: part.bytes });
      this.queuedBytes += part.bytes;
    }
    // Everything now queued is backlog for the next produce call.
    this.droppableCount = this.queue.length;
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

  receive(topic: string, events: unknown[], dedupe?: { epoch: string; batchSeq: number }): PeerReceiveResult {
    if (dedupe && !this.markHandled(dedupe.epoch, dedupe.batchSeq)) {
      // Already delivered under this epoch: answer success so the sender drops
      // its retry instead of resending forever.
      this.duplicates += 1;
      recordPeerDuplicate();
      return { accepted: 0, rejected: 0, duplicate: true };
    }

    let accepted = 0;
    let rejected = 0;
    const handlers = [...(this.subscribers.get(topic) ?? [])];
    if (handlers.length === 0) {
      // Nobody in this process listens to that topic (a typo, or a stream this
      // role does not hold). Count it as refused rather than silently accepted:
      // the sender still makes progress, but the counters say what happened.
      this.rejected += events.length;
      return { accepted: 0, rejected: events.length, duplicate: false };
    }
    for (const event of events) {
      // Only the realtime topic has a contracted envelope today; other topics
      // (MUL-403's `hub`) bring their own shape and are delivered as-is.
      if (topic === PEER_REALTIME_TOPIC) {
        const envelope = parsePeerEventEnvelope(event);
        if (!envelope || envelope.origin === this.origin) {
          rejected += 1;
          continue;
        }
        if (isDegradedEnvelope(envelope)) this.degradedReceived += 1;
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
    return { accepted, rejected, duplicate: false };
  }

  /**
   * Record `batchSeq` as handled. Returns false when this epoch had already
   * reached that number, which is what makes an ACK-losing retry a no-op.
   */
  private markHandled(epoch: string, batchSeq: number): boolean {
    const highest = this.handledBatches.get(epoch) ?? 0;
    if (batchSeq <= highest) return false;
    this.handledBatches.set(epoch, batchSeq);
    return true;
  }

  stats(): PeerChannelStats {
    return {
      enabled: this.enabled,
      origin: this.origin,
      queued: this.queue.length,
      queued_bytes: this.queuedBytes,
      sent: this.sent,
      batches: this.batches,
      dropped: this.dropped,
      oversize_dropped: this.oversizeDropped,
      degraded: this.degraded,
      failed: this.failed,
      received: this.received,
      rejected: this.rejected,
      duplicates: this.duplicates,
      degraded_received: this.degradedReceived,
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
      this.dropEvent(this.queue.length);
      this.queue = [];
      this.queuedBytes = 0;
    }
    this.subscribers.clear();
    this.handledBatches.clear();
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

  /**
   * Take the longest run of same-topic events that fits one POST, numbered
   * `batchSeq`.
   *
   * Two limits stop a batch: the plan's 64 events, and the byte budget, which is
   * compared against the bytes the body actually occupies — wrapper, topic,
   * dedupe pair, separators and every event — not against a sum of event sizes.
   * Sizes are accumulated as events are appended so a large queue never gets
   * re-measured per candidate.
   */
  private takeBatch(batchSeq: number): { batch: QueuedPeerEvent[]; body: string } | null {
    const first = this.queue[0];
    if (!first) return null;
    const prefix = batchPrefix(first.topic, this.origin, batchSeq);
    // The closing `]}`.
    const suffixBytes = 2;
    const prefixBytes = Buffer.byteLength(prefix, "utf8");
    if (prefixBytes + first.bytes + suffixBytes > this.maxBatchBytes) {
      // Not even alone: refuse it here rather than POST a body the peer rejects.
      this.queue.shift();
      this.queuedBytes -= first.bytes;
      this.dropOversize(first.topic, null, first.bytes);
      return null;
    }

    const batch: QueuedPeerEvent[] = [first];
    const parts: string[] = [first.json];
    let bytes = prefixBytes + first.bytes;
    for (let index = 1; index < this.queue.length; index += 1) {
      if (batch.length >= this.maxBatchEvents) break;
      const candidate = this.queue[index]!;
      if (candidate.topic !== first.topic) break;
      // +1 for the separator before the candidate.
      if (bytes + 1 + candidate.bytes + suffixBytes > this.maxBatchBytes) break;
      bytes += 1 + candidate.bytes;
      batch.push(candidate);
      parts.push(candidate.json);
    }

    this.queue.splice(0, batch.length);
    this.queuedBytes -= batch.reduce((total, event) => total + event.bytes, 0);
    this.droppableCount = Math.max(0, this.droppableCount - batch.length);
    return { batch, body: `${prefix}${parts.join(",")}]}` };
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        // Retries keep the number the first attempt used; only a batch taken for
        // the first time advances the counter.
        const batchSeq = this.inflightBatchSeq ?? this.nextBatchSeq;
        const taken = this.takeBatch(batchSeq);
        if (!taken) continue;
        const { batch, body } = taken;
        const startedAt = performance.now();
        try {
          await this.post(body);
        } catch {
          // Put the batch back at the head so ordering survives the retry. It is
          // already backlog — the caps were applied when it was enqueued — so no
          // re-trim here; that would let a failing peer eat the very events it is
          // retrying.
          this.inflightBatchSeq = batchSeq;
          this.queue.unshift(...batch);
          this.queuedBytes += batch.reduce((total, event) => total + event.bytes, 0);
          this.droppableCount += batch.length;
          this.failed += 1;
          this.consecutiveFailures += 1;
          recordPeerFailure();
          this.scheduleRetry();
          return;
        }
        this.inflightBatchSeq = null;
        this.nextBatchSeq += 1;
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

  /**
   * Enforce both caps, oldest first, over the droppable backlog only.
   *
   * Whichever limit is reached first wins. The burst a produce call is adding
   * right now is not droppable, so a legal multi-message report is never cut
   * apart; it becomes droppable as soon as the next produce call arrives (see
   * PEER_MAX_QUEUE_BYTES).
   */
  private trimOverflow(): void {
    while (this.droppableCount > 0
      && (this.queue.length > this.queueLimit || this.queuedBytes > this.maxQueueBytes)) {
      const evicted = this.queue.shift();
      if (!evicted) break;
      this.queuedBytes -= evicted.bytes;
      this.droppableCount -= 1;
      this.dropEvent(1);
    }
  }

  private dropEvent(count: number): void {
    if (count <= 0) return;
    this.dropped += count;
    recordPeerDropped(count);
  }

  private dropOversize(topic: string, kind: string | null, bytes: number): void {
    this.oversizeDropped += 1;
    this.dropEvent(1);
    recordPeerOversizeDropped();
    try {
      this.onOversizeDrop({ topic, kind, bytes });
    } catch {
      // A noisy reporter must not break the store write that produced this.
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
      // The ack is read, not just drained: a peer that recognized this batch as a
      // duplicate says so, and the counters should show why the frame count and
      // the delivery count disagree.
      const ack = await response.json().catch(() => null) as { duplicate?: boolean } | null;
      if (ack?.duplicate === true) {
        this.duplicates += 1;
        recordPeerDuplicate();
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function batchPrefix(topic: string, origin: string, batchSeq: number): string {
  return `{"topic":${JSON.stringify(topic)},"epoch":${JSON.stringify(origin)},"batch_seq":${batchSeq},"events":[`;
}

/** True when the sender replaced the task body with a reference. */
export function isDegradedEnvelope(envelope: {
  kind: string;
  payload: unknown;
}): boolean {
  const payload = envelope.payload as { degraded?: unknown } | null;
  return typeof payload === "object" && payload !== null && payload.degraded === true;
}

/**
 * Split one realtime payload into the events the channel should send.
 *
 * `task_messages` is the only kind that appends many records at once, and the
 * store caps each message at 256 KiB, so one message per event is what turns a
 * 64 MiB daemon report into events that each fit the budget.
 */
export function splitRealtimePayload(
  kind: PeerEventKind,
  payload: Record<string, unknown>,
): Record<string, unknown>[] {
  if (kind !== "task_messages") return [payload];
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length <= 1) return [payload];
  return messages.map((message) => ({ ...payload, messages: [message] }));
}

/**
 * Slim an event that will not fit the budget down to a task reference.
 *
 * Returns null for kinds where the receiver cannot rebuild the frame, which
 * means the event is dropped and counted instead (`task_messages` is here
 * because dropping one message would break the seq order the browser relies on:
 * it degrades its task header instead, and is dropped only if a single message
 * alone cannot fit).
 */
export function degradeRealtimePayload(
  kind: PeerEventKind,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const taskId = taskIdOf(payload);
  if (!taskId) return null;
  switch (kind) {
    case "task_enqueued":
    case "task_event": {
      const degraded: Record<string, unknown> = { task_id: taskId, degraded: true };
      if (typeof payload.type === "string") degraded.type = payload.type;
      return degraded;
    }
    case "task_messages":
      // The message list stays; only the (possibly 2 MiB) task header goes.
      return { task_id: taskId, degraded: true, messages: payload.messages };
    default:
      return null;
  }
}

function taskIdOf(payload: Record<string, unknown>): string | null {
  const task = payload.task;
  if (typeof task === "object" && task !== null) {
    const id = (task as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  const direct = payload.task_id;
  return typeof direct === "string" && direct ? direct : null;
}
