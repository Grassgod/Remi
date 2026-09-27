/**
 * daemon <-> server protocol v2 (MUL-401), the single source for every frame
 * name, limit, close code and error code. The normative prose lives in
 * `docs/daemon-protocol-v2.md`; this file is what the server, the daemon client
 * and the tests import instead of restating a string.
 *
 * Shape is a JSON text frame: `{ v, t, seq, ack, id, re, rt, ts, p }`.
 *
 *   v    protocol version, currently 2
 *   t    frame type, `domain.action` (see the unions below)
 *   seq  sender-assigned sequence on reliable event frames only
 *   ack  receiver's cumulative acknowledgement, piggybacked on any frame
 *   id   RPC request id
 *   re   the `id` this frame answers
 *   rt   runtime scope; present on runtime-scoped frames, absent on
 *        process-scoped ones (hello, platform.drain, runtime.update)
 *   ts   sender's wall clock in ms since epoch
 *   p    payload
 *
 * Six categories, and nothing else:
 *
 *   handshake     hello / welcome / reject - one exchange per connection
 *   best_effort   dropped when the socket is gone; no `seq`, no replay
 *   event         reliable, carries `seq`, replayed until acknowledged
 *   rpc           request, paired with a reply through `id` / `re`
 *   reply         `res`, the answer to an rpc frame
 *   ack           cumulative acknowledgement on its own
 *
 * The design draft described five categories because it folded `res` into the
 * rpc class and treated `hb` as the only best-effort frame. Both are wrong in
 * code: a reply has a different validation path than a request, and
 * `runtime.ready` / `concierge.status` are best effort for exactly the same
 * reason `hb` is - each is recomputed from local state, so losing one costs
 * nothing. A frame's category decides both its transport and its replay story,
 * so the classification lives here as data rather than in a comment.
 */

import type { TraceEvent } from "./trace.js";

export const DAEMON_PROTOCOL_VERSION = 2;

/**
 * Lowest protocol version this server accepts on `/api/daemon/ws`. A v1 daemon
 * is answered with a `reject` frame and close code 4426, then upgrades itself
 * through the HTTP heartbeat channel (`POST /api/daemon/heartbeat`), which stays
 * alive for exactly that purpose.
 */
export const DAEMON_PROTOCOL_MIN = 2;

/**
 * Lowest CLI version the server accepts on the v2 socket.
 *
 * PIN AT RELEASE: this must equal the first release tag that actually carries
 * protocol v2. The upgrade channel targets this value, so too high strands every
 * v1 daemon with no upgrade available, and too low admits a v1 daemon to a
 * v2-only server. 0.2.83 is the next patch release in this repository's cadence
 * and is the expected landing point; A-7 owns the enforcement and the release
 * that carries v2 confirms the value.
 */
export const DAEMON_MIN_CLI_VERSION = "0.2.83";

// ── Frames ──────────────────────────────────────────────────────────────────

/** Handshake frames, both directions. */
export type DaemonHandshakeFrameType = "hello" | "welcome" | "reject";

/** Best-effort liveness. Never `seq`'d, never replayed. */
export type DaemonHeartbeatFrameType = "hb";

/** RPC reply. Always answers a `rpc` frame's `id` through `re`. */
export type DaemonReplyFrameType = "res";

/** Cumulative acknowledgement. May also ride along as the `ack` field. */
export type DaemonAckFrameType = "ack";

/**
 * daemon -> server reliable events. Buffered in the daemon's local SQLite
 * outbox and replayed from it until the server returns a successful `res`.
 */
export const DAEMON_UPLINK_EVENT_FRAMES = [
  "task.start",
  "task.prompt",
  "task.session_pin",
  "task.progress",
  "task.usage",
  "task.workspace",
  "task.complete",
  "task.fail",
  "runtime.update_result",
  "runtime.command_result",
  "runtime.model_list_result",
  "runtime.local_skills_result",
  "runtime.directory_scan_result",
  "runtime.local_skill_import_result",
  "runtime.bot_menu_result",
  "feishu.outbound_result",
  "plugin.state",
  "runtime.archive_sessions_result",
] as const;

/**
 * daemon -> server trace stream. Reliable and resumable, but deliberately NOT in
 * the outbox: the daemon's trace file is the only buffer, and the client resumes
 * from the head the server reports. See `docs/daemon-protocol-v2.md` §5.
 */
export const DAEMON_UPLINK_TRACE_FRAMES = [
  "trace.append",
] as const;

/**
 * daemon -> server best-effort frames. Dropped on the floor when the socket is
 * gone, which is correct: each one is recomputed from local state, so nothing
 * needs replaying.
 */
export const DAEMON_UPLINK_BEST_EFFORT_FRAMES = [
  "runtime.ready",
  "concierge.status",
] as const;

/** daemon -> server RPC requests, paired with a `res` by `id`. */
export const DAEMON_UPLINK_RPC_FRAMES = [
  "steer.consume",
  "human_request.create",
  "human_request.expire",
  "plugin.desired",
  "trace.head",
  "trace.subscribe",
  "trace.unsubscribe",
  "trace.fetch",
  "gc.check_issue",
  "gc.check_chat_session",
  "gc.check_autopilot_run",
  "gc.check_task",
  "gc.workspace_cleaned",
] as const;

/**
 * server -> daemon reliable events. Every one of these is derived from database
 * state on demand, so there is no server-side queue to persist: a reconnect is
 * served by re-deriving and resending a snapshot. Sequences are per connection
 * and restart at 1.
 */
export const DAEMON_DOWNLINK_EVENT_FRAMES = [
  "task.offer",
  "task.cancelled",
  "task.steer",
  "task.human_request.settled",
  "runtime.update",
  "runtime.command",
  "runtime.model_list",
  "runtime.local_skills",
  "runtime.directory_scan",
  "runtime.local_skill_import",
  "runtime.bot_menu",
  "runtime.profile",
  "feishu.outbound",
  "feishu.directive",
  "ssh_mesh.reconcile",
  "platform.drain",
  "plugin.desired_revision",
  "workspace.settings",
  "runtime.archive_sessions",
] as const;

/** server -> daemon RPC requests, paired with a `res` by `id`. */
export const DAEMON_DOWNLINK_RPC_FRAMES = [
  "trace.read",
] as const;

/** server -> daemon trace fan-out for subscribed tasks. Ordered per subscription. */
export const DAEMON_DOWNLINK_TRACE_FRAMES = [
  "trace.push",
] as const;

export type DaemonUplinkEventFrame = (typeof DAEMON_UPLINK_EVENT_FRAMES)[number];
export type DaemonUplinkTraceFrame = (typeof DAEMON_UPLINK_TRACE_FRAMES)[number];
export type DaemonUplinkBestEffortFrame = (typeof DAEMON_UPLINK_BEST_EFFORT_FRAMES)[number];
export type DaemonUplinkRpcFrame = (typeof DAEMON_UPLINK_RPC_FRAMES)[number];
export type DaemonDownlinkEventFrame = (typeof DAEMON_DOWNLINK_EVENT_FRAMES)[number];
export type DaemonDownlinkRpcFrame = (typeof DAEMON_DOWNLINK_RPC_FRAMES)[number];
export type DaemonDownlinkTraceFrame = (typeof DAEMON_DOWNLINK_TRACE_FRAMES)[number];

export type DaemonUplinkFrameType =
  | DaemonHandshakeFrameType
  | DaemonHeartbeatFrameType
  | DaemonReplyFrameType
  | DaemonAckFrameType
  | DaemonUplinkEventFrame
  | DaemonUplinkTraceFrame
  | DaemonUplinkBestEffortFrame
  | DaemonUplinkRpcFrame;

export type DaemonDownlinkFrameType =
  | DaemonHandshakeFrameType
  | DaemonReplyFrameType
  | DaemonAckFrameType
  | DaemonDownlinkEventFrame
  | DaemonDownlinkRpcFrame
  | DaemonDownlinkTraceFrame;

export type DaemonProtocolFrameType = DaemonUplinkFrameType | DaemonDownlinkFrameType;

export type DaemonProtocolFrameCategory =
  | "handshake"
  | "best_effort"
  | "event"
  | "rpc"
  | "reply"
  | "ack";

const HANDSHAKE_TYPES: ReadonlySet<string> = new Set(["hello", "welcome", "reject"]);
const UPLINK_EVENT_TYPES: ReadonlySet<string> = new Set(DAEMON_UPLINK_EVENT_FRAMES);
const UPLINK_TRACE_TYPES: ReadonlySet<string> = new Set(DAEMON_UPLINK_TRACE_FRAMES);
const UPLINK_BEST_EFFORT_TYPES: ReadonlySet<string> = new Set(DAEMON_UPLINK_BEST_EFFORT_FRAMES);
const UPLINK_RPC_TYPES: ReadonlySet<string> = new Set(DAEMON_UPLINK_RPC_FRAMES);
const DOWNLINK_EVENT_TYPES: ReadonlySet<string> = new Set(DAEMON_DOWNLINK_EVENT_FRAMES);
const DOWNLINK_RPC_TYPES: ReadonlySet<string> = new Set(DAEMON_DOWNLINK_RPC_FRAMES);
const DOWNLINK_TRACE_TYPES: ReadonlySet<string> = new Set(DAEMON_DOWNLINK_TRACE_FRAMES);

/** The category a frame type belongs to, or null when it is not a known frame. */
export function daemonFrameCategory(type: string): DaemonProtocolFrameCategory | null {
  if (HANDSHAKE_TYPES.has(type)) return "handshake";
  if (UPLINK_BEST_EFFORT_TYPES.has(type) || type === "hb") return "best_effort";
  if (type === "res") return "reply";
  if (type === "ack") return "ack";
  if (UPLINK_EVENT_TYPES.has(type) || DOWNLINK_EVENT_TYPES.has(type)) return "event";
  if (UPLINK_TRACE_TYPES.has(type) || DOWNLINK_TRACE_TYPES.has(type)) return "event";
  if (UPLINK_RPC_TYPES.has(type) || DOWNLINK_RPC_TYPES.has(type)) return "rpc";
  return null;
}

/**
 * Whether a frame must be replayed until the peer acknowledges it.
 *
 * `trace.append` and `trace.push` are reliable too, but they resume from a trace
 * head instead of a sliding window, so they are not window-managed; see
 * {@link daemonFrameUsesOutboxWindow}.
 */
export function daemonFrameIsReliable(type: string): boolean {
  return UPLINK_EVENT_TYPES.has(type)
    || DOWNLINK_EVENT_TYPES.has(type)
    || UPLINK_TRACE_TYPES.has(type)
    || DOWNLINK_TRACE_TYPES.has(type);
}

/** Whether the frame carries a sender-assigned `seq`. */
export function daemonFrameUsesSeq(type: string): boolean {
  return daemonFrameIsReliable(type);
}

/**
 * Frames the daemon's outbox pumps through the sliding window. `trace.append`
 * is excluded on purpose: it streams from the trace file, which is the buffer.
 */
export function daemonFrameUsesOutboxWindow(type: string): boolean {
  return UPLINK_EVENT_TYPES.has(type);
}

// ── Wire envelope ───────────────────────────────────────────────────────────

export interface DaemonProtocolFrame {
  v: number;
  t: DaemonProtocolFrameType;
  seq?: number;
  ack?: number;
  id?: string;
  re?: string;
  rt?: string;
  ts: number;
  p?: unknown;
}

/** `res` payload on success. Extra keys are frame-specific. */
export interface DaemonProtocolOkReply {
  ok: true;
}

/** `res` payload on failure. `retryable` tells the sender whether to replay. */
export interface DaemonProtocolErrorReply {
  ok: false;
  code: DaemonProtocolErrorCode;
  message: string;
  retryable: boolean;
}

export type DaemonProtocolReply = DaemonProtocolOkReply | DaemonProtocolErrorReply;

// ── Handshake payloads ──────────────────────────────────────────────────────

export interface DaemonHelloRuntime {
  runtime_id: string;
  provider: string;
  max_concurrency: number;
  /** Tasks this process is executing right now; used to reconcile after a reconnect. */
  active_task_ids: string[];
}

/** `hello`, daemon -> server, once per connection, before anything else. */
export interface DaemonHelloPayload {
  protocol: number;
  daemon_id: string;
  cli_version: string;
  /** "desktop" daemons refuse CLI-initiated updates; the server must not offer one. */
  launched_by: string | null;
  runtimes: DaemonHelloRuntime[];
  caps: DaemonProtocolCap[];
}

export interface DaemonWelcomeLimits {
  /** Largest single frame the server will accept, in bytes. */
  frame_bytes: number;
  /** Sliding-window size for reliable uplink frames. */
  window_frames: number;
  window_bytes: number;
}

/** `welcome`, server -> daemon. */
export interface DaemonWelcomePayload {
  protocol: number;
  server_version: string;
  min_cli_version: string;
  session_id: string;
  hb_interval_ms: number;
  limits: DaemonWelcomeLimits;
  /**
   * Highest trace seq the server already holds per task. The daemon resumes each
   * task's `trace.append` from `head + 1`; a head of 0 means the server is cold
   * (a fresh process) and the daemon replays its tail.
   */
  trace_heads: Record<string, number>;
  caps: DaemonProtocolCap[];
}

/** `reject`, server -> daemon, followed immediately by a close. */
export interface DaemonRejectPayload {
  code: DaemonProtocolErrorCode;
  min_protocol: number;
  min_cli_version: string;
  /** Operator-facing sentence, safe to log verbatim. */
  hint: string;
}

// ── Payloads ────────────────────────────────────────────────────────────────

/**
 * The `trace` block on `task.complete` / `task.fail` (MUL-402 ruling 5).
 *
 * `closed` is always true here by construction: these frames are sent after the
 * daemon closed the trace, so a receiver that sees this block knows the trace it
 * names is final. It is spelled out rather than omitted so the card and the pointer
 * both read the same field name as `TraceStoreHead.closed`.
 *
 * `head` and `event_count` are separate numbers on purpose. A freshly written trace
 * is dense, so they are equal; a **backfilled** historical trace keeps its original
 * sparse sequences and `head > event_count` (A11). Reconciliation must use
 * `event_count` for historical members and `head` only for live ones.
 */
export interface DaemonTaskCompletionTrace {
  head: number;
  event_count: number;
  closed: true;
  /** Count of `tool_use` events. */
  tool_call_count: number;
  /** Bucketed by `(type, tool)`; `tool` is non-null only for tool frames (A11). */
  type_histogram: DaemonTraceHistogramBucket[];
}

export interface DaemonTraceHistogramBucket {
  type: string;
  tool: string | null;
  count: number;
}

/** Identifies the model that produced a turn. */
export interface DaemonTaskCompletionModel {
  provider: string;
  model: string;
}

/** Fields `task.complete` and `task.fail` add to the existing report payloads. */
export interface DaemonTaskCompletionFields {
  trace: DaemonTaskCompletionTrace;
  /** Markdown of the turn's final answer, or null when the turn produced none. */
  final_reply_md: string | null;
  /** From the last `execution` event's meta, or null when unknown. */
  model: DaemonTaskCompletionModel | null;
}

/**
 * `runtime.archive_sessions`, server -> daemon.
 *
 * Replaces the plan to reuse the heartbeat's `pending_command`: that field is a
 * general shell channel (`{ command, args, timeout_ms }` executed directly), so
 * archiving through it would mean remote shell execution for a structured request.
 * The entity id (and so the dedupe key) is `request_id`, and the backing table is
 * MUL-402's `multiremi_session_archive_requests`.
 */
export interface DaemonArchiveSessionsPayload {
  request_id: string;
  subjects: DaemonArchiveSubject[];
}

export interface DaemonArchiveSubject {
  kind: "issue" | "chat" | "task";
  id: string;
}

/**
 * `runtime.archive_sessions_result`, daemon -> server, partitioned under `rt:<id>`.
 *
 * The upload itself still travels over HTTP; this frame only reports the outcome.
 */
export interface DaemonArchiveSessionsResultPayload {
  request_id: string;
  status: DaemonArchiveSessionsResultStatus;
  archive_ids: string[];
  /** Present when `status` is `failed`. */
  error?: string;
}

export type DaemonArchiveSessionsResultStatus = "completed" | "failed";

/**
 * `trace.append`, daemon -> server.
 *
 * `closed` travels with the batch so the server can flip its own completeness flag
 * without waiting for the completion frame, which is a separate uplink event and
 * may arrive after the last append.
 */
export interface DaemonTraceAppendPayload {
  task_id: string;
  events: TraceEvent[];
  closed: boolean;
}

/** `trace.push`, server -> daemon, for a task this daemon subscribed to. */
export interface DaemonTracePushPayload {
  task_id: string;
  events: TraceEvent[];
  closed: boolean;
}

/** `trace.read` request, server -> daemon. */
export interface DaemonTraceReadPayload {
  task_id: string;
  after_seq: number;
  limit: number;
  max_bytes: number;
}

/** `trace.read` / `trace.fetch` reply payload, on success. */
export interface DaemonTraceReadReplyPayload {
  ok: true;
  events: TraceEvent[];
  next_after_seq: number;
  head: number;
  eof: boolean;
  closed: boolean;
}

/** `trace.fetch` request, daemon -> server: fill a gap from the server's copy. */
export interface DaemonTraceFetchPayload {
  task_id: string;
  after_seq: number;
  limit: number;
}

/** `trace.subscribe` / `trace.unsubscribe` request payloads. */
export interface DaemonTraceSubscribePayload {
  task_id: string;
  from_seq: number;
}

export interface DaemonTraceUnsubscribePayload {
  task_id: string;
}

/**
 * `trace.subscribe` / `trace.fetch` reply payloads.
 *
 * `first_seq` is the oldest sequence the server can serve for the task; a
 * subscriber asking for anything older gets `gap: true` and must fill from the
 * daemon's file.
 */
export interface DaemonTraceSubscribeReplyPayload {
  ok: true;
  first_seq: number;
  head: number;
  closed: boolean;
  gap: boolean;
}

// ── Error codes ─────────────────────────────────────────────────────────────

/**
 * Every `res` error code, plus the two handshake-level ones.
 *
 * The report codes replace the HTTP status vocabulary: `authority_revoked`
 * covers 401/403/410 (the daemon stops that partition instead of retrying),
 * `invalid_report` covers the other deterministic 4xx, and `start_replayed`
 * covers the one 400 that means success - a `task.start` for a task that already
 * left `dispatched`.
 */
export const DAEMON_PROTOCOL_ERROR_CODES = [
  // handshake
  "daemon_protocol_upgrade_required",
  "daemon_cli_upgrade_required",
  // uplink reports
  "task_not_found",
  "authority_revoked",
  "invalid_report",
  "start_replayed",
  // offer rejections and dispatch
  "capacity",
  "claims_paused",
  "draining",
  "binary_skill_files_unsupported",
  "task_not_offered",
  // trace reads
  "daemon_unreachable",
  "daemon_timeout",
  "daemon_busy",
  "trace_not_hot",
  // transport
  "ack_timeout",
  "protocol_violation",
] as const;

export type DaemonProtocolErrorCode = (typeof DAEMON_PROTOCOL_ERROR_CODES)[number];

/** Codes the sender may retry unchanged; everything else is deterministic. */
export const DAEMON_RETRYABLE_ERROR_CODES = [
  "daemon_busy",
  "daemon_timeout",
] as const satisfies readonly DaemonProtocolErrorCode[];

/** Codes that end a partition permanently on the daemon (mirrors today's terminal HTTP statuses). */
export const DAEMON_TERMINAL_ERROR_CODES = [
  "authority_revoked",
  "task_not_found",
  "invalid_report",
] as const satisfies readonly DaemonProtocolErrorCode[];

// ── Close codes ─────────────────────────────────────────────────────────────

/**
 * WebSocket close codes the daemon gives a specific meaning to. Any code NOT in
 * this table is an ordinary connection loss and must be retried with backoff.
 */
export const DAEMON_PROTOCOL_CLOSE_CODES = {
  /** Sender missed the 15 s acknowledgement deadline; the peer reconnects. */
  ack_timeout: 4000,
  /** Routine server shutdown (deploy, restart). Reconnect with backoff. */
  server_closing: 4001,
  /** Credential revoked or workspace access lost. Stop reconnecting. */
  authority_revoked: 4401,
  /** Token lacks the scope for the daemon socket. Stop reconnecting. */
  forbidden: 4403,
  /** Daemon retired. Stop reconnecting. */
  daemon_retired: 4410,
  /** Protocol v2 required; enter `upgrade_wait` and poll the upgrade channel. */
  protocol_upgrade_required: 4426,
} as const;

export type DaemonProtocolCloseCode =
  (typeof DAEMON_PROTOCOL_CLOSE_CODES)[keyof typeof DAEMON_PROTOCOL_CLOSE_CODES];

/**
 * The codes that stop the reconnect loop, rather than merely interrupting one
 * connection.
 *
 * Deliberately an explicit deny-list rather than an allow-list of "retryable"
 * codes. Defaulting to terminal is the dangerous direction: the close code a
 * daemon actually observes when the network drops or the server is killed is
 * **1006** (abnormal closure, sent by the client stack — the peer never emits it),
 * and 1011/1012/1013 and 1000/1001 are equally ordinary. An allow-list would make
 * every one of those "terminal", and a daemon that never reconnects is
 * unreachable until someone SSHes in. Defaulting to retry means a code nobody
 * anticipated costs a little reconnect churn instead.
 *
 * 4426 is on the list even though it is not permanent: the daemon must not retry
 * the socket, because the server will reject it again until the binary is
 * upgraded. It enters `upgrade_wait` and polls the HTTP upgrade channel instead —
 * see {@link daemonCloseCodeRequiresUpgrade}.
 */
export const DAEMON_TERMINAL_CLOSE_CODES = [
  DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked,
  DAEMON_PROTOCOL_CLOSE_CODES.forbidden,
  DAEMON_PROTOCOL_CLOSE_CODES.daemon_retired,
  DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required,
] as const;

export type DaemonTerminalCloseCode = (typeof DAEMON_TERMINAL_CLOSE_CODES)[number];

/**
 * Whether the daemon should reconnect this socket after it closes.
 *
 * Everything is retryable except {@link DAEMON_TERMINAL_CLOSE_CODES}. That
 * includes 1006/1011/1012/1013/1000/1001, which the WebSocket layer produces on
 * its own, and any code this protocol has never heard of.
 */
export function daemonCloseCodeIsRetryable(code: number): boolean {
  return !(DAEMON_TERMINAL_CLOSE_CODES as readonly number[]).includes(code);
}

/**
 * Whether this close means "upgrade the binary and come back", the one terminal
 * code that has a scheduled way forward. A-2 uses this to enter `upgrade_wait`
 * instead of merely stopping.
 */
export function daemonCloseCodeRequiresUpgrade(code: number): boolean {
  return code === DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required;
}

// ── Capability bits ─────────────────────────────────────────────────────────

/**
 * Additive capability bits. A new frame type that an older peer must not receive
 * gets a bit; adding a bit does not bump the protocol version. Removing a frame
 * or changing its meaning does.
 */
export const DAEMON_PROTOCOL_CAPS = [
  /** daemon accepts `task.offer` / `task.cancelled` instead of HTTP claim. */
  "offer",
  /** daemon accepts pushed `task.steer` and answers `steer.consume`. */
  "steer.push",
  /** daemon answers `trace.read` for its hot tasks. */
  "trace.read",
  /** daemon accepts `trace.subscribe` / `trace.fetch` and emits `trace.push`. */
  "trace.subscribe",
] as const;

export type DaemonProtocolCap = (typeof DAEMON_PROTOCOL_CAPS)[number];

// ── Limits and timings ──────────────────────────────────────────────────────

/** Largest protocol payload either side emits, in bytes. */
export const DAEMON_FRAME_MAX_BYTES = 1024 * 1024;

/** `Bun.serve` `maxPayloadLength`; above the protocol cap so a violation is readable. */
export const DAEMON_WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Sliding window for reliable uplink frames, whichever bound is hit first. */
export const DAEMON_UPLINK_WINDOW_FRAMES = 64;
export const DAEMON_UPLINK_WINDOW_BYTES = 1024 * 1024;

/** At most this many trace events, or bytes, per `trace.append`. */
export const DAEMON_TRACE_APPEND_MAX_EVENTS = 256;
export const DAEMON_TRACE_APPEND_MAX_BYTES = 256 * 1024;

/** Heartbeat cadence; replaces the 10 s HTTP heartbeat and the 3 s concierge heartbeat. */
export const DAEMON_HEARTBEAT_INTERVAL_MS = 15_000;

/** Downlink frames must be acknowledged inside this window or the server closes 4000. */
export const DAEMON_ACK_TIMEOUT_MS = 15_000;

/** An unanswered `task.offer` is rescinded after this long and the task requeued. */
export const DAEMON_OFFER_TIMEOUT_MS = 30_000;

/** After a reject or a timeout, the runtime is skipped for this long. */
export const DAEMON_OFFER_COOLDOWN_MS = 30_000;

/** Reconnect backoff bounds shared by the client. */
export const DAEMON_RECONNECT_BASE_MS = 1_000;
export const DAEMON_RECONNECT_MAX_MS = 30_000;

/** `upgrade_wait` probes the HTTP upgrade channel at this cadence. */
export const DAEMON_UPGRADE_PROBE_INTERVAL_MS = 60_000;

/** Sending pauses above the first threshold and resumes below the second. */
export const DAEMON_SEND_PAUSE_BYTES = 2 * 1024 * 1024;
export const DAEMON_SEND_RESUME_BYTES = 512 * 1024;

/** On a cold server, the daemon replays at most this much of a trace tail. */
export const DAEMON_TRACE_REPLAY_MAX_BYTES = 2 * 1024 * 1024;
export const DAEMON_TRACE_REPLAY_MAX_EVENTS = 2_000;

/** `trace.read` request limits. */
export const DAEMON_TRACE_READ_DEFAULT_LIMIT = 200;
export const DAEMON_TRACE_READ_MAX_LIMIT = 500;
export const DAEMON_TRACE_READ_MAX_BYTES = 1024 * 1024;
export const DAEMON_TRACE_READ_TIMEOUT_MS = 10_000;
/** Concurrent `trace.read` requests per connection, and the queue behind them. */
export const DAEMON_TRACE_READ_MAX_IN_FLIGHT = 4;
export const DAEMON_TRACE_READ_MAX_QUEUED = 32;

// ── Version comparison ──────────────────────────────────────────────────────

/**
 * Compare two dotted numeric versions, ignoring a leading `v` and any
 * `-pre`/`+build` suffix. Returns a negative number when `left < right`.
 *
 * Kept here rather than imported from the CLI so the server can make the
 * accept/reject decision without reaching into another package; the shape
 * matches `runtimeSupportsIssueWorkspaces` in `store/repos/tasks-repo.ts`.
 */
export function compareDaemonCliVersion(left: string, right: string): number {
  const parse = (value: string): number[] | null => {
    const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const a = parse(left);
  const b = parse(right);
  // An unparseable version is treated as older, so it must upgrade. That matches
  // the existing runtime gates, which fail closed on a version they cannot read.
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 0; index < 3; index += 1) {
    const delta = a[index]! - b[index]!;
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

/** Whether a daemon advertising `cliVersion` may use the v2 socket. */
export function meetsDaemonMinCliVersion(cliVersion: string): boolean {
  return compareDaemonCliVersion(cliVersion, DAEMON_MIN_CLI_VERSION) >= 0;
}
