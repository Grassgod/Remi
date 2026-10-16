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
 *   rpc           request, paired through `id` / `re`; trace resumes by head
 *   reply         `res`, the answer to an rpc frame
 *   ack           cumulative acknowledgement on its own
 *
 * The design draft described five categories because it folded `res` into the
 * rpc class and treated `hb` as the only best-effort frame. Both are wrong in
 * code: a reply has a different validation path than a request, and
 * `runtime.ready` and the legacy `concierge.status` are best effort. New
 * concierge status reports use `concierge.status_report` RPC: outbound delivery
 * is gated on the persisted online state, so losing one is not harmless.
 * Category decides the envelope; trace-head reliability is separate
 * from the event sequence and window, so the classification lives here as data.
 */

import type { GcRunMode, StorageReport, StorageSubjectRef, SubjectSnapshot } from "./storage.js";
import type {
  TraceBackgroundTaskStopRequest,
  TraceBackgroundTaskUsage,
  TraceContextUsage,
  TraceEvent,
  TraceEventPage,
  TraceLateSubagent,
  TraceTurnPage,
} from "./trace.js";
import type { MultiremiChatSessionStatus, MultiremiDaemonHeartbeatAck, MultiremiDaemonSshMeshStatus } from "./types.js";
import type {
  BackgroundLaneReleaseReason,
  BackgroundLaneState,
  BackgroundTaskDoorbellMetadata,
  BackgroundTaskReportedStatus,
  BackgroundTaskStopReason,
  DecisionOption,
  UnifiedMessage,
} from "./unified-model.js";

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
 * First turn + items trace release: v0.2.90 (PR 2, ADR 0019). Released v0.2.89
 * and earlier daemons write fragment traces and answer `trace.read` without a
 * view, so they must upgrade; a v0.2.90 daemon refuses a server that still
 * advertises an older gate. Before publishing, the release owner must verify the
 * v0.2.90 tag, package.json, prepared dependency snapshot and target main SHA.
 * The version gate does not mean the fleet has upgraded.
 */
export const DAEMON_MIN_CLI_VERSION = "0.2.90";

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
  // Decode persisted retired reports only to return report_shape_retired.
  "task.complete",
  "turn.complete",
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
  "runtime.gc_run_result",
] as const;

/**
 * daemon -> server trace RPC. Paired by id/re, reliable through task trace heads,
 * and deliberately NOT in the outbox or the sequence window. The daemon's trace
 * file is the buffer. See `docs/daemon-protocol-v2.md` §5.
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
  "gc.storage_report",
  "task.activity",
  "lane.background_tasks",
] as const;

/** Non-trace-stream daemon -> server RPC requests, paired with a `res` by `id`. */
export const DAEMON_UPLINK_RPC_FRAMES = [
  "concierge.status_report",
  "turn.input",
  "turn.decision",
  "turn.decision.get",
  "turn.decision.expire",
  "turn.decision.consume",
  "plugin.desired",
  "trace.head",
  "trace.subscribe",
  "trace.unsubscribe",
  "trace.fetch",
  "gc.check_issue",
  "gc.check_chat_session",
  "gc.check_task",
  "gc.subject_reclaimed",
  "lane.background_wake",
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
  "turn.message",
  "turn.wrap_up",
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
  "runtime.gc_run",
  "lane.background_stop",
  "lane.background_release",
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
export type DaemonUplinkRpcFrame = (typeof DAEMON_UPLINK_RPC_FRAMES)[number] | DaemonUplinkTraceFrame;
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
  if (DOWNLINK_TRACE_TYPES.has(type)) return "event";
  if (UPLINK_TRACE_TYPES.has(type)) return "rpc";
  if (UPLINK_RPC_TYPES.has(type) || DOWNLINK_RPC_TYPES.has(type)) return "rpc";
  return null;
}

/**
 * Whether a frame must be replayed until the peer acknowledges it.
 *
 * `trace.append` resumes through task trace heads, not its RPC envelope. It is
 * reliable without a sender sequence; `trace.push` remains a sequenced event.
 */
export function daemonFrameIsReliable(type: string): boolean {
  return UPLINK_EVENT_TYPES.has(type)
    || DOWNLINK_EVENT_TYPES.has(type)
    || UPLINK_TRACE_TYPES.has(type)
    || DOWNLINK_TRACE_TYPES.has(type);
}

/** Whether the frame carries a sender-assigned `seq`. */
export function daemonFrameUsesSeq(type: string): boolean {
  return UPLINK_EVENT_TYPES.has(type) || DOWNLINK_EVENT_TYPES.has(type) || DOWNLINK_TRACE_TYPES.has(type);
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

/** feishu.outbound_result acknowledges stale leases without blocking the queue. */
export type DaemonFeishuOutboundOkReply = DaemonProtocolOkReply & {
  mention_open_id?: string | null;
  lease_lost?: true;
};

/** `res` payload on failure. `retryable` tells the sender whether to replay. */
export interface DaemonProtocolErrorReply {
  ok: false;
  code: DaemonProtocolErrorCode;
  message: string;
  retryable: boolean;
}

/** Only gc.* replies retain the business error from the former HTTP endpoint. */
export type DaemonGcErrorReply = DaemonProtocolErrorReply & {
  operation_error?: { status: number; code: string | null; message: string };
};

export type DaemonProtocolReply = DaemonProtocolOkReply | DaemonProtocolErrorReply;

// ── Handshake payloads ──────────────────────────────────────────────────────

/** Per-runtime capability fields use the same names and versions as the HTTP heartbeat. */
export interface DaemonRuntimeCapabilities {
  supports_batch_import?: boolean;
  supports_directory_scan?: boolean;
  supports_skill_directory?: boolean;
  supports_bot_menu?: boolean;
  agent_plugin_protocol?: number;
  feishu_concierge_protocol?: number;
  feishu_decision_card?: number;
  feishu_issue_decision_card?: number;
}

export interface DaemonHelloRuntime {
  runtime_id: string;
  provider: string;
  max_concurrency: number;
  /** Tasks this process is executing right now; used to reconcile after a reconnect. */
  active_task_ids: string[];
  /** Only provider callbacks still held by this process; durable outbox tasks are excluded. */
  active_question_waits?: DaemonQuestionWait[];
  /** Missing fields explicitly mean unsupported, including after a restart. */
  capabilities?: DaemonRuntimeCapabilities;
  /**
   * Lanes whose bridge process this daemon keeps alive between attempts (PR 6
   * §5.2), sent with the `lane.background` cap. The server marks this
   * runtime's other running registry rows `stopped` (`daemon_restart`) unless
   * an active task still owns them. Absent from daemons without the cap.
   */
  parked_lanes?: DaemonParkedLane[];
}

export interface DaemonQuestionWait { message_id: string; attempt_id: string; wait_id: string }

/** A Chat lane: one agent's line of work in one session and execution scope. */
export interface DaemonLaneRef {
  session_id: string;
  agent_id: string;
  execution_scope: string;
}

export interface DaemonParkedLane extends DaemonLaneRef {
  provider_session_id: string;
  /** Tasks the parked process still runs. */
  task_ids: string[];
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
  /** Tool items (`TRACE_TOOL_ITEM_TYPES`) at any depth: the single tool-count rule. */
  tool_call_count: number;
  /** Bucketed by `(item type, tool)`; `tool` is non-null only for items that name a tool. */
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

/**
 * Fields `task.complete` and `task.fail` add to the existing report payloads.
 * Daemons must send them; servers tolerate missing or malformed card metadata
 * with a blank card so that it can never block the terminal state transition.
 */
export interface DaemonTaskCompletionFields {
  trace: DaemonTaskCompletionTrace;
  /** Markdown of the turn's final answer, or null when the turn produced none. */
  final_reply_md: string | null;
  /** The trace turn's `provider` and last reported `model`, or null when unknown. */
  model: DaemonTaskCompletionModel | null;
  /**
   * Turn + items traces (PR 2). The daemon sends these three on `task.fail` as
   * well; a receiver reads a malformed value as null and never blocks the
   * terminal report on it.
   *
   * Last context-window occupancy the bridge reported for the turn.
   */
  context_usage: TraceContextUsage | null;
  /** `final_started_at - started_at` of the trace turn ("Worked for"), or null without a final reply. */
  worked_ms: number | null;
  /** Top-level items the Chat fold renders: every item but the final reply, user messages, permissions and questions. */
  process_item_count: number | null;
  /**
   * Top-level subagents that ended after the final reply started, at most 5
   * (PR 5); null when none did. Optional: older daemons omit it, and a
   * receiver reads a missing or malformed value as null.
   */
  late_subagents?: TraceLateSubagent[] | null;
}

/** Turn input travels as messages; attempt ids remain trace/outbox keys. */
export interface DaemonTurnInput {
  turn_id: string;
  attempt_id: string;
  input_from_seq: number;
  input_to_seq: number;
  input_messages: UnifiedMessage[];
}

export interface DaemonTurnMessagePayload {
  turn_id: string;
  attempt_id: string;
  message: UnifiedMessage;
  attachments?: import("./types.js").MultiremiAttachment[];
}

export interface DaemonTurnWrapUpPayload {
  turn_id: string;
  attempt_id: string;
  requested_at: string;
}

export interface DaemonTurnCompletePayload {
  turn_id: string;
  attempt_id: string;
  input_to_seq: number;
  reply: { body_md: string; message_kind: "reply" | "final" };
  session_id?: string | null;
  work_dir?: string | null;
}

/** ACP questions and permissions create decision messages + awaiting_human via S2; replies use reply_to_id. */
export interface DaemonTurnDecisionPayload {
  turn_id: string;
  attempt_id: string;
  dedupe_key: string;
  /** Stable original-Q id when replaying the native request. */
  message_id?: string;
  /** Process-local callback nonce; a new daemon process cannot claim an old wait. */
  wait_id: string;
  body_md: string;
  options: DecisionOption[];
  metadata: Record<string, unknown>;
  timeout_ms?: number;
}

/**
 * `gc.check_chat_session` reply on success. The daemon decides whether a Chat
 * has ended and how long to keep its workspace from these fields.
 */
export interface DaemonGcCheckChatSessionReply {
  ok: true;
  status: MultiremiChatSessionStatus;
  updated_at: string;
  pinned: boolean;
  /** Set for Chats opened by an automation run; those use the shorter retention. */
  origin: { autopilot_id: string; run_id: string } | null;
  last_activity_at: string | null;
}

/**
 * `gc.subject_reclaimed`, daemon -> server RPC: the daemon deleted a subject's
 * workspace. The server records the snapshot and resets the subject's native
 * sessions on this daemon so the next execution starts a fresh generation.
 * The reply is `{ ok: true }`.
 */
export interface DaemonGcSubjectReclaimedPayload {
  runtime_id: string;
  subject: StorageSubjectRef;
  snapshot: SubjectSnapshot | null;
  unsaved_work: boolean;
  /** Free space the workspaces filesystem gained while this subject was reclaimed. */
  freed_bytes: number;
}

/**
 * `gc.storage_report`, daemon -> server, best effort: the report of a periodic round (also one that only
 * plans, under `MULTIREMI_GC_DRY_RUN`). An operator's dry run answers through `runtime.gc_run_result`
 * instead. The report's lists are bounded to fit one frame.
 */
export interface DaemonGcStorageReportPayload {
  runtime_id: string;
  report: StorageReport;
}

/**
 * `task.activity`, daemon -> server, best effort (PR 5): how many subagents a
 * running attempt has open, recomputed from the daemon's trace fold. A lost
 * frame is replaced by the next change or the periodic refresh, and a server
 * that has no handler for it ignores it.
 */
export interface DaemonTaskActivityPayload {
  task_id: string;
  runtime_id?: string;
  /** Running top-level subagents, else running nested ones; 0 when none runs. */
  running_subagents: number;
  /**
   * Background tasks the attempt has running or paused, at any depth (PR 6).
   * Optional: older daemons omit it, and a missing value is not a 0.
   */
  running_background_tasks?: number;
}

// ── Background tasks (PR 6 §5.2). All gated by the `lane.background` cap ─────

/** One task of a lane snapshot, as the daemon's provider registry holds it. */
export interface DaemonLaneBackgroundTask {
  task_id: string;
  task_type: string;
  name: string;
  /** The command a shell runs, when it is not already the name. */
  command?: string | null;
  origin_attempt_id: string;
  /** The task's trace item in the origin attempt (`bg:<task_id>`), when it has one. */
  origin_item_id: string | null;
  status: BackgroundTaskReportedStatus;
  can_stop: boolean;
  stop_request?: TraceBackgroundTaskStopRequest | null;
  stop_reason?: BackgroundTaskStopReason | null;
  /** ISO 8601. */
  started_at: string;
  ended_at?: string | null;
  duration_ms?: number | null;
  summary?: string | null;
  /** At most `TRACE_BACKGROUND_TASK_OUTPUT_TAIL_MAX_BYTES`. */
  output_tail?: string | null;
  /**
   * The task's output file exists but the daemon cannot read it (permissions,
   * a link, not a regular file); absent otherwise, a missing file included.
   */
  output_unreadable?: boolean;
  usage?: TraceBackgroundTaskUsage | null;
}

/**
 * `lane.background_tasks`, daemon -> server, best effort: the whole task list
 * of one lane, recomputed from local state. Sent debounced on change, repeated
 * while any task runs, sent again on reconnect; a `closed` snapshot is
 * repeated (see the `DAEMON_LANE_BACKGROUND_*` timings). The server keeps the
 * highest `revision` per lane and ignores older ones; a `closed` snapshot ends
 * any row it still holds running as `lost`. At most
 * {@link DAEMON_LANE_BACKGROUND_MAX_TASKS} tasks and
 * {@link DAEMON_LANE_BACKGROUND_MAX_BYTES} per frame.
 */
export interface DaemonLaneBackgroundTasksPayload extends DaemonLaneRef {
  runtime_id: string;
  provider_session_id: string;
  /** Per-daemon monotonic counter. */
  revision: number;
  state: BackgroundLaneState;
  /** The attempt the process serves while `in_attempt`. */
  attempt_id?: string | null;
  /** ISO 8601: the keep-alive cap, while `parked`. */
  parked_until?: string | null;
  tasks: DaemonLaneBackgroundTask[];
}

/**
 * `lane.background_wake`, daemon -> server RPC: a parked Claude task ended
 * (`completed` / `failed`), and Claude will start a turn of its own. The
 * server writes the doorbell (a platform `status` message to the agent, wake
 * `now`, deduplicated per task) and lets the lane machine create, merge or
 * steer a turn (PR 6 §2.5).
 */
export interface DaemonLaneBackgroundWakePayload extends DaemonLaneRef {
  provider_session_id: string;
  task: Omit<BackgroundTaskDoorbellMetadata, "provider_session_id" | "origin_turn_id"> & {
    summary?: string | null;
    duration_ms?: number | null;
  };
}

/** The `lane.background_wake` success reply; a repeated call answers the first call's outcome. */
export interface DaemonLaneBackgroundWakeReply {
  ok: true;
  /** A new pending turn, merged into the pending one, or delivered as a steer to the running one. */
  outcome: "created" | "merged" | "delivered";
  turn_id: string;
  /** The attempt the doorbell reached; null while the turn has none yet. */
  attempt_id: string | null;
}

/** Rejections of `lane.background_wake`: the lane moved or its session closed. The daemon cancels the cycle and releases. */
export type DaemonLaneBackgroundWakeErrorCode = Extract<DaemonProtocolErrorCode, "lane_moved" | "session_closed">;

/** `task_id` of a `lane.background_stop` that stops every task of the lane. */
export const DAEMON_LANE_BACKGROUND_STOP_ALL = "*";

/**
 * `lane.background_stop`, server -> daemon reliable event, derived from the
 * registry's stop requests and resent at `hello`; keyed by
 * `lane:task:requested_at`.
 */
export interface DaemonLaneBackgroundStopPayload extends DaemonLaneRef {
  /** One task, or {@link DAEMON_LANE_BACKGROUND_STOP_ALL}. */
  task_id: string;
  requested_at: string;
}

/**
 * `lane.background_release`, server -> daemon reliable event, derived from the
 * registry's live rows and the lane, Chat and agent state: stop the lane's
 * tasks and close its bridge.
 */
export interface DaemonLaneBackgroundReleasePayload extends DaemonLaneRef {
  provider_session_id: string;
  reason: BackgroundLaneReleaseReason;
}

/**
 * `runtime.gc_run`, server -> daemon, pending-request mechanics of
 * `runtime.directory_scan`: the daemon runs one reclaim round in `mode`.
 */
export interface DaemonGcRunPayload {
  id: string;
  mode: GcRunMode;
}

/** `runtime.gc_run_result`, daemon -> server, partitioned under `rt:<id>`. */
export interface DaemonGcRunResultPayload {
  request_id: string;
  runtime_id: string;
  status: "completed" | "failed";
  report: StorageReport | null;
  error: string | null;
}

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

/**
 * `hb`, daemon -> server (spec §4).
 *
 * Best-effort liveness for one daemon process: losing a heartbeat costs nothing
 * because the next one recomputes the same facts. The payload is deliberately
 * A live socket proves reachability. Each runtime also re-advertises its
 * capabilities because a host can gain or lose one after the initial hello.
 */
export interface DaemonHeartbeatPayload {
  /** Tasks this process is executing right now, across every runtime it serves. */
  active_task_count: number;
  /** Local outbox pressure, so an operator can see a daemon that cannot drain. */
  outbox?: DaemonHeartbeatOutboxStats;
  /** Drain generation this daemon has applied; absent means "none observed yet". */
  drain_ack_generation?: number;
  runtimes?: Array<{
    runtime_id: string;
    capabilities?: DaemonRuntimeCapabilities;
    /** Omitted by older v2 daemons; zero explicitly reports no mesh support. */
    ssh_mesh_protocol?: number;
    ssh_mesh_status?: MultiremiDaemonSshMeshStatus;
  }>;
}

/**
 * The daemon's own outbox counters, split by partition.
 *
 * `pending` counts rows not yet sent, `unacked` counts rows sent but not yet
 * acknowledged by the server. Both are the daemon's numbers, reported for
 * observability only: the server never drives the outbox from them.
 */
export interface DaemonHeartbeatOutboxStats {
  pending: number;
  unacked: number;
  /** Newest outbox row id, so a gap in what the server has seen is visible. */
  head_seq?: number;
}

/**
 * The server's answer to one `hb`.
 *
 * `runtime_acks` is one entry per runtime the `hello` advertised, and it carries
 * the SAME structure the v1 HTTP heartbeat returned (`MultiremiDaemonHeartbeatAck`
 * in `./types.js`), including `status: "runtime_gone"` with `runtime_gone: true`
 * for a runtime whose row no longer exists.
 *
 * Why per-runtime and not one status for the connection: a socket serves every
 * runtime of one daemon process, so a missing runtime row is a fact about that
 * runtime only. The daemon reacts to `runtime_gone` by registering again (its
 * existing recovery path), so the server must report it WITHOUT closing the
 * socket - closing would strand the daemon's other, healthy runtimes.
 *
 * Drained runtimes are skipped here rather than reported as gone: a shutdown that
 * deleted them said so directly, and the daemon must not treat that as "register
 * me again".
 */
export interface DaemonHeartbeatReplyPayload {
  runtime_acks: MultiremiDaemonHeartbeatAck[];
}

/** `trace.push`, server -> daemon, for a task this daemon subscribed to. */
export interface DaemonTracePushPayload {
  task_id: string;
  events: TraceEvent[];
  closed: boolean;
}

/**
 * `trace.read` request, server -> daemon (PR 2): the server picks a view.
 * `turn` pages the fold (running) or the persisted snapshot (closed) from
 * `item_cursor`; `events` pages raw stored lines after `after_seq`, which is also
 * the only view that shows a v1 file's lines. A payload without a known `view`
 * is a protocol violation: the daemon release gate (`DAEMON_MIN_CLI_VERSION`)
 * keeps servers that did not send one away from daemons that require it.
 */
export type DaemonTraceReadPayload = DaemonTraceReadTurnPayload | DaemonTraceReadEventsPayload;

export interface DaemonTraceReadTurnPayload {
  task_id: string;
  view: "turn";
  /** Index of the first item to return; 0 for the first page. */
  item_cursor: number;
  /** At most this many items. */
  limit: number;
  /** Serialized-size budget for the page; at least one item is always returned. */
  max_bytes: number;
}

export interface DaemonTraceReadEventsPayload {
  task_id: string;
  view: "events";
  /** Exclusive cursor: the first line returned has `seq > after_seq`. */
  after_seq: number;
  limit: number;
  max_bytes: number;
}

/**
 * `trace.read` success reply, shaped by the request's `view`. A v1 file answers
 * `format: "legacy"`: no turn and no items for `turn`, its raw lines for `events`.
 */
export type DaemonTraceReadReplyPayload = DaemonTraceReadTurnReplyPayload | DaemonTraceReadEventsReplyPayload;
export type DaemonTraceReadTurnReplyPayload = { ok: true } & TraceTurnPage;
export type DaemonTraceReadEventsReplyPayload = { ok: true } & TraceEventPage;

/** `trace.fetch` reply on success: the server reads the daemon's `events` view. */
export type DaemonTraceFetchReplyPayload = DaemonTraceReadEventsReplyPayload;

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
  "report_shape_retired",
  "turn_input_pending",
  "start_replayed",
  "steer_pending",
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
  // lane.background_wake (PR 6)
  "lane_moved",
  "session_closed",
  // transport
  "ack_timeout",
  "protocol_violation",
  // server fault
  "server_error",
] as const;

export type DaemonProtocolErrorCode = (typeof DAEMON_PROTOCOL_ERROR_CODES)[number];

/** Codes the sender may retry unchanged; everything else is deterministic. */
export const DAEMON_RETRYABLE_ERROR_CODES = [
  "daemon_busy",
  "daemon_timeout",
  "server_error",
] as const satisfies readonly DaemonProtocolErrorCode[];

/** Codes that end a partition permanently on the daemon (mirrors today's terminal HTTP statuses). */
export const DAEMON_TERMINAL_ERROR_CODES = [
  "authority_revoked",
  "task_not_found",
  "invalid_report",
  "report_shape_retired",
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
  /**
   * The peer broke the protocol in a way no reply can address: a frame before the
   * handshake, a malformed `hello`, unparseable JSON, or an oversized frame that
   * carries neither `seq` nor `id` to answer.
   *
   * Deliberately NOT 4426. 4426 means "you are the wrong version, go and upgrade",
   * which parks the daemon in `upgrade_wait` and stops it claiming work - wrong for
   * a client bug or a race where no upgrade is coming. Deliberately not 4001
   * either, so an operator can tell an ordinary deploy apart from a peer that is
   * sending rubbish; both are retryable, so the difference is diagnostics only.
   */
  protocol_violation: 4002,
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
 * or changing its payload semantics is gated by min_cli_version.
 */
export const DAEMON_PROTOCOL_CAPS = [
  /** daemon accepts `task.offer` / `task.cancelled` instead of HTTP claim. */
  "offer",
  /** daemon accepts unified turn inputs and reports replies as messages. */
  "turn.message",
  /** daemon answers `trace.read` for its hot tasks. */
  "trace.read",
  /** daemon accepts `trace.subscribe` / `trace.fetch` and emits `trace.push`. */
  "trace.subscribe",
  /** daemon fetches Wiki bodies through existing HTTP read endpoints after offer. */
  "wiki.fetch",
  /**
   * PR 6: daemon keeps a Chat lane's process alive while background tasks run
   * and speaks the `lane.background_*` frames. A server that supports them
   * echoes the bit in `welcome.caps`; the daemon parks only when both sides
   * hold it, and otherwise stops tasks at the attempt's end.
   */
  "lane.background",
] as const;

export type DaemonProtocolCap = (typeof DAEMON_PROTOCOL_CAPS)[number];

// ── Limits and timings ──────────────────────────────────────────────────────

/** Largest protocol payload either side emits, in bytes. */
export const DAEMON_FRAME_MAX_BYTES = 1024 * 1024;
export const DAEMON_OFFER_BUDGET_BYTES = 512 * 1024;

/** `Bun.serve` `maxPayloadLength`; above the protocol cap so a violation is readable. */
export const DAEMON_WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
/** One oversized normalized trace event may use the socket ceiling; ordinary frames keep 1 MiB. */
export const DAEMON_TRACE_FRAME_MAX_BYTES = DAEMON_WS_MAX_PAYLOAD_BYTES;

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

/** `lane.background_tasks` bounds: tasks per snapshot and serialized payload bytes. */
export const DAEMON_LANE_BACKGROUND_MAX_TASKS = 32;
export const DAEMON_LANE_BACKGROUND_MAX_BYTES = 256 * 1024;
/** A change is reported after this quiet period; a lane with a running task is re-reported at the refresh cadence. */
export const DAEMON_LANE_BACKGROUND_DEBOUNCE_MS = 1_000;
export const DAEMON_LANE_BACKGROUND_REFRESH_MS = 30_000;
/** A `closed` snapshot is sent this many times, this far apart. */
export const DAEMON_LANE_BACKGROUND_CLOSED_REPEATS = 3;
export const DAEMON_LANE_BACKGROUND_CLOSED_REPEAT_MS = 10_000;

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
