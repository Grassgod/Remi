/**
 * One daemon's v2 connection (MUL-417, spec §1-§2, §8).
 *
 * A session owns everything that is per-connection and in memory:
 *
 *   - the handshake (`hello` -> `welcome` | `reject`), including the per-runtime
 *     authorization that decides 4401/4403/4410;
 *   - the downlink sequence, which starts at 1 on every connection and is never
 *     persisted - the downlink is re-derived from the database on reconnect
 *     (ADR 0005), so a queue here would be a second source of truth;
 *   - the acknowledgement deadline: every reliable downlink frame records its
 *     send time, and a frame unacknowledged for `DAEMON_ACK_TIMEOUT_MS` closes
 *     the connection with 4000;
 *   - backpressure, driven by the `ws.send` return value;
 *   - serialized frame processing.
 *
 * SERIALIZATION. Bun calls `message` without awaiting the previous call, so two
 * frames can interleave at every `await`. The session keeps one promise chain and
 * appends each inbound frame to it, so a handler always observes the state left
 * by the frame before it. The chain never rejects: a rejected chain would
 * silently stop processing every later frame on that connection.
 *
 * BACKPRESSURE. `ws.send` answers with the bytes sent (> 0), `-1` (queued, the
 * socket is behind) or `0` (dropped - the connection is gone). `-1` pauses the
 * pausable traffic and is cleared by the socket's `drain` callback rather than by
 * the next successful send, because a small successful send does not prove the
 * queue caught up. `res` and `ack` are never paused: they release the peer's
 * window, and stalling them deadlocks both sides. `0` unregisters the connection.
 */

import {
  DAEMON_ACK_TIMEOUT_MS,
  DAEMON_FRAME_MAX_BYTES,
  DAEMON_HEARTBEAT_INTERVAL_MS,
  DAEMON_MIN_CLI_VERSION,
  DAEMON_PROTOCOL_CLOSE_CODES,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_UPLINK_WINDOW_BYTES,
  DAEMON_UPLINK_WINDOW_FRAMES,
  daemonFrameCategory,
  type DaemonProtocolCap,
  type DaemonWelcomePayload,
} from "@multiremi/contracts/daemon-protocol.js";
import {
  daemonFrameBytes,
  daemonFrameText,
  encodeDaemonProtocolFrame,
  parseDaemonProtocolFrame,
  readInteger,
  type DaemonParsedFrame,
} from "./frames.js";
import type { DaemonSessionRegistry } from "./session-registry.js";
import {
  checkHandshakeVersion,
  daemonRejectPayload,
  parseDaemonHello,
  type DaemonHandshakeRejection,
} from "./handshake.js";
import { systemClock, type DaemonProtocolClock, type DaemonProtocolTimer } from "./clock.js";
import type { WsFrameSample } from "./metrics.js";
import type { MultiremiAccessToken } from "@multiremi/contracts/types.js";

/** A frame this session sends out, before encoding. */
export interface DaemonSessionOutboundFrame {
  t: string;
  seq?: number;
  ack?: number;
  id?: string;
  re?: string;
  rt?: string;
  p?: unknown;
}

export type DaemonSessionSendOutcome =
  | { status: "sent"; bytes: number }
  | { status: "backpressure" }
  | { status: "dropped" }
  | { status: "closed" };

/**
 * Why a reliable downlink frame was not sent.
 *
 * The three refusals are separate values rather than one `null` because the
 * caller's next move differs: `window_full` means "wait for an ack and push
 * again from the database", `paused` means "wait for drain", and `closed` means
 * "give up on this connection". A single null would leave an offer pump guessing.
 */
export type DaemonSessionSendRefusal = "closed" | "paused" | "window_full";

export type DaemonSessionSendResult =
  | { ok: true; seq: number }
  | { ok: false; reason: DaemonSessionSendRefusal };

/** The socket, narrowed to exactly what this layer uses. Fakes implement this. */
export interface DaemonProtocolSocket {
  send(text: string): number;
  close(code?: number, reason?: string): void;
  /** Queued-but-unsent bytes. Optional: fakes may omit it. */
  readonly bufferedAmount?: number;
}

/**
 * Per-runtime authorization, produced by the caller before `welcome` is sent.
 *
 * `scope` is what decides the consequence, and it is required rather than
 * inferred from the status so every branch has to state its intent:
 *
 *   - `"daemon"` - a fact about the whole connection (retired, invalid
 *     credential, wrong workspace, owner no longer a member). The session closes.
 *   - `"runtime"` - a fact about one runtime out of the many this socket serves
 *     (its row is gone, or it belongs to another daemon). The session keeps the
 *     connection, drops that runtime from what it serves, and reports it as
 *     `runtime_gone` on the next heartbeat so the daemon can register it again.
 *
 * The distinction is the whole reason a daemon-level socket can be safe: closing
 * on a runtime-level fact would strand every healthy runtime on the machine.
 */
export interface DaemonSessionRuntimeAuthorization {
  runtimeId: string;
  ok: boolean;
  scope: "daemon" | "runtime";
  /** HTTP-shaped status the guard answered with; drives the terminal close code. */
  status?: number;
  code?: string | null;
  message?: string | null;
}

export interface DaemonSessionHello {
  daemonId: string;
  cliVersion: string;
  launchedBy: string | null;
  runtimes: Array<{
    runtimeId: string;
    provider: string;
    maxConcurrency: number;
    activeTaskIds: string[];
  }>;
  caps: DaemonProtocolCap[];
}

export interface DaemonSessionHeartbeat {
  daemonId: string;
  /** Runtimes this session serves. Only these may be dispatched to or stamped. */
  runtimeIds: string[];
  /**
   * Runtimes the `hello` advertised that this session does NOT serve, in the
   * order they were advertised. Reported back as `runtime_gone`; the session must
   * never touch their rows, because one of them may belong to another daemon.
   */
  unavailableRuntimeIds: string[];
  /**
   * Every runtime the `hello` advertised, in advertised order. The heartbeat reply
   * is built from this so the daemon still gets one ack per runtime it named,
   * whether or not this session serves it.
   */
  advertisedRuntimeIds: string[];
  payload: Record<string, unknown>;
}

export interface DaemonSessionOptions {
  sessionId: string;
  socket: DaemonProtocolSocket;
  registry: DaemonSessionRegistry;
  /** Server version reported in `welcome`. */
  serverVersion: string;
  /**
   * The credential this connection authenticated with, kept so a later heartbeat
   * can re-check that the daemon's owner is still a workspace member.
   */
  ownerAccessToken?: MultiremiAccessToken | null;
  /**
   * Per-runtime authorization; called once per runtime the `hello` advertises.
   * The daemon id comes from the `hello` payload, and is passed in rather than
   * read back off the session, because this runs before the handshake completes.
   */
  authorizeRuntime(daemonId: string, runtimeId: string): Promise<DaemonSessionRuntimeAuthorization>;
  /** `hello` accepted. A-3 records the daemon's caps and active tasks from here. */
  onHello?(hello: DaemonSessionHello): void;
  /** Highest known trace head per task. A-6 fills it; A-1 answers `{}`. */
  traceHeads?(): Record<string, number>;
  /**
   * `hb` accepted. Returning a payload sends it back as `res`; returning nothing
   * (or undefined) answers in kind with `{ ok: true }`.
   *
   * A best-effort frame still gets an answer because `hb` is the daemon's only
   * way to learn per-runtime facts it must act on - `runtime_gone` above all - and
   * "no reply" would leave a re-registration waiting on a timeout.
   */
  onHeartbeat?(heartbeat: DaemonSessionHeartbeat): unknown | void;
  /** A cumulative acknowledgement was observed (standalone or piggybacked). */
  onAck?(ack: number): void;
  /** A `res` frame arrived, already matched against `re`. */
  onReply?(frame: DaemonParsedFrame): void;
  /** Dispatch an uplink RPC frame. Returning null means "not wired here". */
  onRpc?(frame: DaemonParsedFrame): Promise<unknown | null> | unknown | null;
  /** Observability hook, called once per dispatched frame. */
  onFrame?(sample: WsFrameSample): void;
  /** Connection ended, for any reason. Called at most once. */
  onClose?(): void;
  /** Time seam. Defaults to the real clock; tests install a manual one. */
  clock?: DaemonProtocolClock;
}

/** A pending reliable downlink frame awaiting its acknowledgement. */
interface PendingAck {
  seq: number;
  sentAt: number;
  /** Encoded size, so the window can be enforced in bytes as well as frames. */
  bytes: number;
}

const unknownFrameType = "unknown_frame";

export class DaemonProtocolSession {
  readonly sessionId: string;
  /** Set once `hello` is accepted; empty before that. */
  daemonId = "";

  private readonly options: DaemonSessionOptions;
  private readonly registry: DaemonSessionRegistry;
  private readonly socket: DaemonProtocolSocket;
  private readonly clock: DaemonProtocolClock;
  /** The credential this connection authenticated with; read by the heartbeat guard. */
  readonly ownerAccessToken: MultiremiAccessToken | null;

  /** Runtimes this session serves. Registered, dispatched to, and stamped by `hb`. */
  private runtimeIdList: string[] = [];
  /** Advertised but not served: reported `runtime_gone` on `hb`, never touched. */
  private unavailableRuntimeIdList: string[] = [];
  /** Every advertised runtime, in advertised order. */
  private advertisedRuntimeIdList: string[] = [];
  private handshakeComplete = false;
  private closed = false;
  private registered = false;

  /** Downlink sequence, per connection, starting at 1. */
  private downlinkSeq = 0;
  /** Reliable frames sent but not yet acknowledged, keyed by seq. */
  private readonly pendingAcks = new Map<number, PendingAck>();
  private ackTimer: DaemonProtocolTimer | null = null;

  /**
   * Highest cumulative acknowledgement from the peer: "everything with
   * `seq <= peerAck` arrived", which is what lets one number retire a whole run.
   */
  private peerAck = 0;

  /** True while offers and non-critical pushes must stay paused. */
  private paused = false;

  /** Server-issued RPCs awaiting a reply, keyed by request id. */
  private readonly pendingRpc = new Map<string, DaemonSessionOutboundFrame>();

  /** Serialized frame processing. */
  private processing: Promise<void> = Promise.resolve();

  constructor(options: DaemonSessionOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.registry = options.registry;
    this.socket = options.socket;
    this.clock = options.clock ?? systemClock;
    this.ownerAccessToken = options.ownerAccessToken ?? null;
  }

  get runtimeIds(): readonly string[] {
    return this.runtimeIdList;
  }

  /** Advertised but not served, in advertised order. */
  get unavailableRuntimeIds(): readonly string[] {
    return this.unavailableRuntimeIdList;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isHandshakeComplete(): boolean {
    return this.handshakeComplete;
  }

  get unacknowledgedFrameCount(): number {
    return this.pendingAcks.size;
  }

  get lastSentSeq(): number {
    return this.downlinkSeq;
  }

  get pendingRequestCount(): number {
    return this.pendingRpc.size;
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  /** Handle one inbound frame, serialized behind every earlier frame. */
  handleMessage(message: string | ArrayBuffer | Uint8Array): Promise<void> {
    if (this.closed) return Promise.resolve();
    const text = daemonFrameText(message);
    const bytes = daemonFrameBytes(message);
    const run = this.processing.then(() => this.processFrame(text, bytes));
    this.processing = run.then(
      () => undefined,
      () => undefined,
    );
    return this.processing;
  }

  /**
   * The socket reported it drained. Resuming is unconditional because a paused
   * session that is never resumed stalls offers until the ack deadline fires.
   */
  handleDrain(): void {
    if (this.closed) return;
    this.paused = false;
  }

  /** Socket-level close: the peer disconnected. Nothing to send back. */
  handleSocketClose(): void {
    this.markClosed();
  }

  /** A newer connection for this daemon took over. Always 4001. */
  closeForReplacement(): void {
    if (this.closed) return;
    this.close(DAEMON_PROTOCOL_CLOSE_CODES.server_closing, "replaced by a newer daemon connection");
  }

  /** Server shutdown: 4001 as well, so every daemon retries with backoff. */
  closeForServerShutdown(): void {
    this.close(DAEMON_PROTOCOL_CLOSE_CODES.server_closing, "server shutting down");
  }

  /** Close on a protocol violation whose code the caller already knows. */
  closeWithCode(code: number, reason: string): void {
    this.close(code, reason);
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  /**
   * Send a reliable downlink event, assigning the next sequence.
   *
   * The window that `welcome` advertises is enforced here, not merely announced:
   * a refusal consumes no sequence, so the caller can retry the same slot once an
   * ack frees room. There is deliberately no in-memory queue behind this - the
   * protocol's rule is that the database is the queue, and the pusher re-derives
   * what is still owed (ADR 0005).
   *
   * `pausable` traffic is additionally held while the socket is behind.
   */
  sendEvent(frame: DaemonSessionOutboundFrame, options: { pausable?: boolean } = {}): DaemonSessionSendResult {
    if (this.closed) return { ok: false, reason: "closed" };
    if (options.pausable && this.paused) return { ok: false, reason: "paused" };

    const encoded = encodeDaemonProtocolFrame({ ...frame, seq: this.downlinkSeq + 1 }, this.clock.now());
    const bytes = Buffer.byteLength(encoded, "utf8");
    // `frame_bytes` is the single-frame ceiling the daemon was told about; a frame
    // over it could never be delivered, so it is refused rather than sent.
    if (bytes > DAEMON_FRAME_MAX_BYTES) return { ok: false, reason: "window_full" };
    const inFlight = this.windowUsage();
    if (
      this.pendingAcks.size + 1 > DAEMON_UPLINK_WINDOW_FRAMES
      || inFlight.bytes + bytes > DAEMON_UPLINK_WINDOW_BYTES
    ) {
      return { ok: false, reason: "window_full" };
    }

    const seq = this.downlinkSeq + 1;
    const outcome = this.writeEncoded(encoded);
    if (outcome.status === "closed" || outcome.status === "dropped") {
      return { ok: false, reason: "closed" };
    }
    this.downlinkSeq = seq;
    // A backpressured frame is still queued in the socket, so it is genuinely
    // outstanding and belongs in the window.
    this.pendingAcks.set(seq, { seq, sentAt: this.clock.now(), bytes });
    this.armAckTimer();
    return { ok: true, seq };
  }

  /** Frames and bytes currently inside the downlink window. */
  windowUsage(): { frames: number; bytes: number } {
    let bytes = 0;
    for (const pending of this.pendingAcks.values()) bytes += pending.bytes;
    return { frames: this.pendingAcks.size, bytes };
  }

  /** Send a frame that is never paused and never carries a sequence. */
  sendDirect(frame: DaemonSessionOutboundFrame): boolean {
    if (this.closed) return false;
    const outcome = this.write(frame);
    return outcome.status === "sent" || outcome.status === "backpressure";
  }

  /** Answer an RPC frame. `re` is always the request's `id`. */
  sendReply(requestId: string, payload: unknown): boolean {
    return this.sendDirect({ t: "res", ...(requestId ? { re: requestId } : {}), p: payload });
  }

  /** Issue a server -> daemon RPC and remember it until the reply arrives. */
  request(rpcId: string, frame: Omit<DaemonSessionOutboundFrame, "id">): string | null {
    if (this.closed) return null;
    const outbound: DaemonSessionOutboundFrame = { ...frame, id: rpcId };
    const outcome = this.write(outbound);
    if (outcome.status === "closed" || outcome.status === "dropped") return null;
    this.pendingRpc.set(rpcId, outbound);
    return rpcId;
  }

  /** Forget a server-issued RPC: the reply arrived, or it timed out. */
  settleRequest(rpcId: string): boolean {
    return this.pendingRpc.delete(rpcId);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private write(frame: DaemonSessionOutboundFrame): DaemonSessionSendOutcome {
    if (this.closed) return { status: "closed" };
    return this.writeEncoded(encodeDaemonProtocolFrame(frame, this.clock.now()));
  }

  private writeEncoded(encoded: string): DaemonSessionSendOutcome {
    if (this.closed) return { status: "closed" };
    let status: number;
    try {
      status = this.socket.send(encoded);
    } catch {
      this.markClosed();
      return { status: "closed" };
    }
    if (status === 0) {
      // Dropped: the socket is gone. Unregister rather than pretend the frame
      // was delivered; the peer re-derives its downlink snapshot on reconnect.
      this.close(DAEMON_PROTOCOL_CLOSE_CODES.server_closing, "socket dropped a frame");
      return { status: "dropped" };
    }
    if (status === -1) {
      this.paused = true;
      return { status: "backpressure" };
    }
    return { status: "sent", bytes: status };
  }

  private async processFrame(text: string, bytes: number): Promise<void> {
    if (this.closed) return;
    const startedAt = performance.now();
    const dbBefore = this.options.onFrame ? readDbCounters() : { dbMs: 0, dbQueries: 0 };

    const parsed = parseDaemonProtocolFrame(text);

    // ── oversized frames ─────────────────────────────────────────────────────
    // `maxPayloadLength` is 4 MiB precisely so a frame over the 1 MiB protocol cap
    // arrives whole and can be answered. Closing instead would be a reconnect loop:
    // the daemon replays the same unacknowledged outbox row, sends the same
    // oversized frame, and is disconnected again, forever.
    //
    // The daemon's own isolation point is the outbox row, so the answer has to name
    // that row. A reliable event names it with `seq`, an RPC with `id`.
    if (bytes > DAEMON_FRAME_MAX_BYTES) {
      const addressable = parsed.ok ? (parsed.frame.seq ?? null) : null;
      const rpcId = parsed.ok ? parsed.frame.id : null;
      if (addressable !== null || rpcId !== null) {
        this.sendReply(String(addressable ?? rpcId), {
          ok: false,
          code: "protocol_violation",
          message: `frame exceeds the ${DAEMON_FRAME_MAX_BYTES} byte protocol limit`,
          retryable: false,
        });
        this.emitFrameSample(parsed.ok ? parsed.frame.type : "oversized", startedAt, dbBefore, {
          errorCode: "protocol_violation",
          violation: true,
        });
        return;
      }
      // Nothing to address: no reply could tell the peer which row to isolate, and
      // the daemon side cannot reference it either (A-5 blocks it before the
      // outbox). A retryable close is the honest answer.
      this.emitFrameSample("oversized", startedAt, dbBefore, { errorCode: "protocol_violation", violation: true });
      this.close(DAEMON_PROTOCOL_CLOSE_CODES.protocol_violation, "oversized frame that names no outbox row");
      return;
    }

    if (!parsed.ok) {
      // Unparseable, so nothing can be addressed. 4002 rather than 4001: the peer
      // is not merely unlucky, it is sending rubbish, and an operator needs to see
      // that. Still retryable, so a transient corruption costs a reconnect.
      this.emitFrameSample("malformed", startedAt, dbBefore, { errorCode: "protocol_violation", violation: true });
      this.close(DAEMON_PROTOCOL_CLOSE_CODES.protocol_violation, "malformed frame");
      return;
    }

    const frame = parsed.frame;
    try {
      if (!this.handshakeComplete) {
        const code = await this.handleHandshakeFrame(frame);
        this.emitFrameSample(frame.type, startedAt, dbBefore, { errorCode: code, violation: false });
        return;
      }

      if (frame.ack !== null) this.acknowledge(frame.ack);

      const category = daemonFrameCategory(frame.type);
      if (category === null) {
        // The spec's answer for an unrecognised frame: a reply the sender can act
        // on, not a dead socket. `unknown_frame` is deliberately not one of
        // DAEMON_PROTOCOL_ERROR_CODES - no retry policy should read it as a
        // business outcome.
        this.sendReply(frame.id ?? "", {
          ok: false,
          code: unknownFrameType,
          message: `unknown frame type: ${frame.type}`,
          retryable: false,
        });
        this.emitFrameSample(frame.type, startedAt, dbBefore, { errorCode: unknownFrameType, violation: false });
        return;
      }

      let errorCode: string | null = null;
      let direction: "uplink" | "rpc" = category === "rpc" ? "rpc" : "uplink";
      switch (category) {
        case "best_effort":
          errorCode = this.handleBestEffort(frame);
          break;
        case "ack": {
          // A standalone `ack` frame carries the number in its payload; the
          // envelope field is the piggybacked form and was already consumed above.
          const standalone = readInteger(frame.payload.ack);
          if (standalone !== null) this.acknowledge(standalone);
          errorCode = null;
          break;
        }
        case "reply":
          errorCode = this.handleReply(frame);
          break;
        case "rpc":
          errorCode = await this.handleRpc(frame);
          break;
        case "event":
          errorCode = this.handleEvent(frame);
          break;
        case "handshake":
          direction = "uplink";
          errorCode = "protocol_violation";
          this.sendReply(frame.id ?? "", {
            ok: false,
            code: "protocol_violation",
            message: "handshake frame after the handshake completed",
            retryable: false,
          });
          break;
        default:
          direction = "uplink";
          errorCode = unknownFrameType;
          break;
      }
      this.emitFrameSample(frame.type, startedAt, dbBefore, { errorCode, violation: false, direction });
    } catch (error) {
      this.handleFrameFailure(frame, startedAt, dbBefore, error);
    }
  }

  /**
   * A frame handler threw.
   *
   * The old behaviour swallowed the rejection: the serialization chain continued
   * but the peer got no answer, so an RPC caller waited out its timeout for a
   * request the server had already failed. Now the fault is logged, reported to
   * the peer as a retryable `server_error`, and counted in the frame summary.
   *
   * A failure during the handshake has no `id`/`seq` to answer through, so it
   * closes 4001 - retryable, and the daemon comes back with a fresh session.
   */
  private handleFrameFailure(
    frame: DaemonParsedFrame,
    startedAt: number,
    dbBefore: { dbMs: number; dbQueries: number },
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const replyTo = frame.re ?? frame.id ?? null;
    try {
      console.warn(JSON.stringify({
        event: "daemon_protocol_frame_failed",
        session_id: this.sessionId,
        daemon_id: this.daemonId || null,
        frame_type: frame.type,
        handshake_complete: this.handshakeComplete,
        // The message only. A payload can carry task content and credentials, and
        // this line goes to stdout where it would be persisted.
        error: message,
      }));
    } catch {
      // A hostile console is not worth failing the connection over.
    }

    if (!this.handshakeComplete) {
      this.emitFrameSample(frame.type, startedAt, dbBefore, { errorCode: "server_error", violation: false });
      this.close(DAEMON_PROTOCOL_CLOSE_CODES.server_closing, "handshake handler failed");
      return;
    }
    if (replyTo) {
      this.sendReply(replyTo, {
        ok: false,
        code: "server_error",
        message: "the server failed while handling this frame",
        retryable: true,
      });
    }
    this.emitFrameSample(frame.type, startedAt, dbBefore, { errorCode: "server_error", violation: false });
  }

  private async handleHandshakeFrame(frame: DaemonParsedFrame): Promise<string | null> {
    if (frame.type !== "hello") {
      // Anything else first is a protocol error: the peer cannot know the
      // negotiated limits before it greets, and guessing lets a version-skewed
      // client run with the wrong assumptions.
      //
      // 4002, not 4426. 4426 tells the daemon "you are the wrong version, go
      // upgrade and wait", which parks it in `upgrade_wait` and stops it claiming
      // work. A frame arriving out of order is a client bug or a race, and no
      // upgrade is coming to fix it - the daemon should reconnect with backoff.
      this.close(
        DAEMON_PROTOCOL_CLOSE_CODES.protocol_violation,
        "expected hello as the first frame",
      );
      return "protocol_violation";
    }
    const parsed = parseDaemonHello(frame.payload);
    if (!parsed.ok) {
      // Same reasoning as above: a hello missing its required fields is a client
      // fault, not a version mismatch. A daemon that really is too old is caught
      // by `checkHandshakeVersion` below, which is the only 4426 path.
      this.close(
        DAEMON_PROTOCOL_CLOSE_CODES.protocol_violation,
        "malformed hello; protocol and cli_version are required",
      );
      return "protocol_violation";
    }
    const versionRejection = checkHandshakeVersion(parsed.hello);
    if (versionRejection) {
      this.rejectHandshake(versionRejection);
      return versionRejection.errorCode;
    }

    // Authorization runs before registration and before `welcome`, so a session
    // that fails never appears in the registry and no limits leak to a
    // credential that is about to be refused.
    //
    // Only a daemon-level failure closes the connection. A runtime-level failure
    // excludes that one runtime: the daemon's other runtimes keep working, and the
    // next heartbeat tells the daemon `runtime_gone` so it can register the
    // runtime again. Closing here would be terminal (4403) and would take the whole
    // machine down with one stale id - exactly the scenario of a daemon
    // reconnecting after its runtime row was deleted.
    const serving: string[] = [];
    const unavailable: string[] = [];
    for (const runtime of parsed.hello.runtimes) {
      const authorization = await this.options.authorizeRuntime(
        parsed.hello.daemon_id,
        runtime.runtime_id,
      );
      if (authorization.ok) {
        serving.push(runtime.runtime_id);
        continue;
      }
      if (authorization.scope === "daemon") {
        const code = daemonAuthorizationCloseCode(authorization.status, authorization.code);
        this.close(code, authorization.message ?? "runtime authorization failed");
        return authorization.code ?? "authority_revoked";
      }
      unavailable.push(runtime.runtime_id);
    }

    this.daemonId = parsed.hello.daemon_id;
    this.advertisedRuntimeIdList = parsed.hello.runtimes.map((runtime) => runtime.runtime_id);
    this.runtimeIdList = serving;
    this.unavailableRuntimeIdList = unavailable;
    this.handshakeComplete = true;
    this.registered = true;
    // The registry is the authority on who owns a runtime right now: it may report
    // that another live daemon already holds one of ours. That is a runtime-level
    // fact like any other, so it joins the unavailable list rather than evicting the
    // other machine's connection (the pre-handshake ownership check catches the
    // common case; this covers rows with no `daemonId`).
    const registration = this.registry.register(this);
    if (registration.conflictedRuntimeIds.length > 0) {
      const conflicted = new Set(registration.conflictedRuntimeIds);
      this.runtimeIdList = this.runtimeIdList.filter((runtimeId) => !conflicted.has(runtimeId));
      this.unavailableRuntimeIdList = [...this.unavailableRuntimeIdList, ...registration.conflictedRuntimeIds];
    }
    this.options.onHello?.({
      daemonId: parsed.hello.daemon_id,
      cliVersion: parsed.hello.cli_version,
      launchedBy: parsed.hello.launched_by,
      runtimes: parsed.hello.runtimes.map((runtime) => ({
        runtimeId: runtime.runtime_id,
        provider: runtime.provider,
        maxConcurrency: runtime.max_concurrency,
        activeTaskIds: runtime.active_task_ids,
      })),
      caps: parsed.hello.caps,
    });

    const welcome: DaemonWelcomePayload = {
      protocol: DAEMON_PROTOCOL_VERSION,
      server_version: this.options.serverVersion,
      min_cli_version: DAEMON_MIN_CLI_VERSION,
      session_id: this.sessionId,
      hb_interval_ms: DAEMON_HEARTBEAT_INTERVAL_MS,
      limits: {
        frame_bytes: DAEMON_FRAME_MAX_BYTES,
        window_frames: DAEMON_UPLINK_WINDOW_FRAMES,
        window_bytes: DAEMON_UPLINK_WINDOW_BYTES,
      },
      // A-6 fills this once the trace stream is wired. A-1 answers an empty map
      // rather than omitting the field, so the daemon has one shape to read.
      trace_heads: this.options.traceHeads?.() ?? {},
      caps: [],
    };
    this.sendDirect({ t: "welcome", p: welcome });
    return null;
  }

  private rejectHandshake(rejection: DaemonHandshakeRejection): void {
    this.sendDirect({ t: "reject", p: daemonRejectPayload(rejection) });
    this.close(rejection.code, rejection.hint);
  }

  private handleBestEffort(frame: DaemonParsedFrame): string | null {
    if (frame.type === "hb") {
      const reply = this.options.onHeartbeat?.({
        daemonId: this.daemonId,
        runtimeIds: [...this.runtimeIdList],
        unavailableRuntimeIds: [...this.unavailableRuntimeIdList],
        advertisedRuntimeIds: [...this.advertisedRuntimeIdList],
        payload: frame.payload,
      });
      this.sendReply(frame.id ?? "", reply ?? { ok: true });
      return null;
    }
    // `runtime.ready` and `concierge.status` belong to A-3/A-4. Accepting them
    // here keeps the transport from rejecting a frame a later sub-issue owns.
    return null;
  }

  private handleReply(frame: DaemonParsedFrame): string | null {
    if (frame.re) this.options.onReply?.(frame);
    return null;
  }

  private async handleRpc(frame: DaemonParsedFrame): Promise<string | null> {
    const handler = this.options.onRpc;
    // A handler that throws propagates to `processFrame`, which logs it and
    // answers `server_error` (retryable). Swallowing it here is what left RPC
    // callers waiting out a timeout for a request that had already failed.
    if (!handler) {
      this.sendReply(frame.id ?? "", {
        ok: false,
        code: "protocol_violation",
        message: `no handler is registered for ${frame.type} yet`,
        retryable: false,
      });
      return "protocol_violation";
    }
    const reply = await handler(frame);
    if (reply === null || reply === undefined) {
      // No handler answered. Replying "not wired yet" is deliberate: an RPC left
      // unanswered burns the caller's whole timeout and hides which layer is
      // missing, while a deterministic refusal tells it not to retry.
      const notWired = {
        ok: false,
        code: "invalid_report",
        message: `${frame.type} is not wired on this server yet`,
        retryable: false,
      };
      this.sendReply(frame.id ?? "", notWired);
      return "invalid_report";
    }
    this.sendReply(frame.id ?? "", reply);
    const errorCode = reply && typeof reply === "object" && (reply as { ok?: unknown }).ok === false
      ? String((reply as { code?: unknown }).code ?? "invalid_report")
      : null;
    return errorCode;
  }

  private handleEvent(frame: DaemonParsedFrame): string | null {
    // A-1 carries no business frames: the uplink events and `trace.append` arrive
    // here, and the transport-level exchange A-1 owns is the sequence and the
    // reply. The honest answer today is a deterministic refusal the sender can tell
    // apart from a transport failure (A-5 wires the outbox window, A-6 the trace
    // stream).
    //
    // `re` references the reliable frame's `seq`, not an RPC `id`: the daemon's
    // outbox row is identified by its sequence, and A-5 deletes or blocks that row
    // based on this reply. Answering with an empty `re` (or an `id` that reliable
    // events never carry) would leave the row unretired and replaying forever.
    const replyTo = frame.seq !== null ? String(frame.seq) : frame.id;
    if (replyTo) {
      this.sendReply(replyTo, {
        ok: false,
        code: "invalid_report",
        message: `${frame.type} is not wired on this server yet`,
        retryable: false,
      });
      return "invalid_report";
    }
    return null;
  }

  /**
   * Advance the peer's cumulative acknowledgement and retire what it covers.
   *
   * A stale or absurd ack is ignored rather than fatal: the peer may be
   * replaying an ack it queued before reconnecting, and closing over a benign
   * duplicate turns it into an outage.
   */
  private acknowledge(ack: number): void {
    if (!Number.isSafeInteger(ack) || ack < 1 || ack <= this.peerAck) return;
    if (ack > this.downlinkSeq) return;
    this.peerAck = ack;
    for (const [seq] of this.pendingAcks) {
      if (seq <= this.peerAck) this.pendingAcks.delete(seq);
    }
    if (this.pendingAcks.size === 0) this.disarmAckTimer();
    else this.armAckTimer();
    this.options.onAck?.(ack);
  }

  /**
   * Arm the acknowledgement deadline.
   *
   * One timer covers the whole window: it fires when the oldest outstanding
   * frame passes the deadline, and expires the session if so; otherwise it
   * re-arms against the new oldest. A timer per frame would read more directly
   * and allocate on every reliable send.
   */
  private armAckTimer(): void {
    if (this.closed) return;
    const oldest = this.oldestPending();
    if (!oldest) {
      this.disarmAckTimer();
      return;
    }
    if (this.ackTimer !== null) this.clock.clearTimeout(this.ackTimer);
    const delay = Math.max(0, oldest.sentAt + DAEMON_ACK_TIMEOUT_MS - this.clock.now());
    this.ackTimer = this.clock.setTimeout(() => {
      this.ackTimer = null;
      if (this.closed) return;
      const now = this.clock.now();
      for (const pending of this.pendingAcks.values()) {
        if (now - pending.sentAt >= DAEMON_ACK_TIMEOUT_MS) {
          this.close(
            DAEMON_PROTOCOL_CLOSE_CODES.ack_timeout,
            "downlink frame was not acknowledged within the deadline",
          );
          return;
        }
      }
      this.armAckTimer();
    }, delay);
  }

  private disarmAckTimer(): void {
    if (this.ackTimer === null) return;
    this.clock.clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private oldestPending(): PendingAck | null {
    let oldest: PendingAck | null = null;
    for (const pending of this.pendingAcks.values()) {
      if (!oldest || pending.seq < oldest.seq) oldest = pending;
    }
    return oldest;
  }

  /** Close and unregister, telling the peer why. Idempotent. */
  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.disarmAckTimer();
    this.pendingAcks.clear();
    this.pendingRpc.clear();
    if (this.registered) this.registry.unregister(this);
    try {
      this.socket.close(code, reason);
    } catch {
      // The socket may already be gone; the session state is what matters.
    }
    this.options.onClose?.();
  }

  /** Peer-initiated close: nothing to send back, just forget the session. */
  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.disarmAckTimer();
    this.pendingAcks.clear();
    this.pendingRpc.clear();
    if (this.registered) this.registry.unregister(this);
    this.options.onClose?.();
  }

  private emitFrameSample(
    type: string,
    startedAt: number,
    dbBefore: { dbMs: number; dbQueries: number },
    details: { errorCode: string | null; violation: boolean; direction?: "uplink" | "rpc" },
  ): void {
    if (!this.options.onFrame) return;
    const dbAfter = readDbCounters();
    this.options.onFrame({
      type,
      direction: details.direction ?? "uplink",
      errorCode: details.errorCode,
      totalMs: performance.now() - startedAt,
      dbMs: Math.max(0, dbAfter.dbMs - dbBefore.dbMs),
      dbQueries: Math.max(0, dbAfter.dbQueries - dbBefore.dbQueries),
      protocolViolation: details.violation,
    });
  }
}

/**
 * Process-wide DB counters, installed by the wiring.
 *
 * The session may not import the observation stack (that would make the
 * transport untestable without it), so the counters arrive as a hook. When no
 * hook is installed the sampler answers zeros, which is honest: a session with
 * no store attached spends no DB time.
 */
let dbCounterReader: () => { dbMs: number; dbQueries: number } = () => ({ dbMs: 0, dbQueries: 0 });

export function setDaemonProtocolDbCounters(reader: () => { dbMs: number; dbQueries: number }): void {
  dbCounterReader = reader;
}

function readDbCounters(): { dbMs: number; dbQueries: number } {
  try {
    return dbCounterReader();
  } catch {
    return { dbMs: 0, dbQueries: 0 };
  }
}

/**
 * The ONE mapping from a daemon-level refusal to the close code the daemon acts
 * on. Both the session's own refusals and the upgrade-time HTTP answers go through
 * it, so the same fact cannot produce two different codes depending on how far
 * the connection got before it was noticed.
 *
 * `status` is the HTTP status the guard answered with (or would have answered
 * with); `code` is the finer-grained code when the caller has one. Membership loss
 * is checked by `code` first and is always 4401 regardless of status: 4401 is
 * "workspace access lost", which is what an owner leaving means, while 4403 is
 * "this credential never had the scope for this socket". The two need different
 * operator fixes, which is the only reason they are separate terminal codes.
 */
export function daemonAuthorizationCloseCode(
  status: number | undefined,
  code: string | null | undefined,
): number {
  if (code === "daemon_retired" || status === 410) return DAEMON_PROTOCOL_CLOSE_CODES.daemon_retired;
  if (code === "daemon_owner_membership_required") return DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked;
  if (status === 401) return DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked;
  // A daemon-identity problem (wrong daemon_id, wrong workspace, not a daemon
  // token) is the "never had the scope" case, whichever status carried it.
  return DAEMON_PROTOCOL_CLOSE_CODES.forbidden;
}
