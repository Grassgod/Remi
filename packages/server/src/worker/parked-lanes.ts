/**
 * Keep-alive on demand (PR 6 §2): the daemon's registry of Chat lanes whose
 * bridge process outlives an attempt because background tasks still run.
 *
 * One record per lane `(conversation session, agent, execution scope)` while
 * its process lives: `in_attempt` while an attempt uses it, `parked` between
 * attempts, `claimed` while the next attempt prepares. At most one process per
 * lane: the next offer adopts the parked one (`claim` then `adopt`) or releases
 * it before spawning another (§2.4).
 *
 * The registry owns, per record:
 * - limits: at most `maxParkedLanes` parked (0 turns parking off), least
 *   recently active evicted first, never one whose doorbell is out;
 * - the keep-alive cap (U1) and the close once nothing runs (`done`);
 * - the lane snapshot `lane.background_tasks` (debounced, refreshed while a
 *   task runs, resent on reconnect, a `closed` one repeated);
 * - the doorbell `lane.background_wake` when a parked Claude task ends (§2.5);
 * - permission and question requests raised while parked, held for an
 *   attempt to attach (R7);
 * - stop and release downlinks (§6);
 * - the crash sweep: every parked process group and its start time is in
 *   `parked-bridges.json`, and a restarted daemon kills what is still there (R2).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ElicitationCreateParams, ElicitationResult, PermissionOutcome, RequestPermissionParams } from "@shared/contracts/acp-protocol.js";
import type { AsyncTaskSnapshot, ProviderReuseRejection } from "@shared/contracts/provider-types.js";
import type { TraceBackgroundTaskStopRequest } from "@multiremi/contracts/trace.js";
import type {
  BackgroundLaneReleaseReason,
  BackgroundLaneState,
  BackgroundTaskReportedStatus,
  BackgroundTaskStopReason,
} from "@multiremi/contracts/unified-model.js";
import {
  DAEMON_LANE_BACKGROUND_CLOSED_REPEATS,
  DAEMON_LANE_BACKGROUND_CLOSED_REPEAT_MS,
  DAEMON_LANE_BACKGROUND_DEBOUNCE_MS,
  DAEMON_LANE_BACKGROUND_MAX_BYTES,
  DAEMON_LANE_BACKGROUND_MAX_TASKS,
  DAEMON_LANE_BACKGROUND_REFRESH_MS,
  DAEMON_LANE_BACKGROUND_STOP_ALL,
  type DaemonLaneBackgroundReleasePayload,
  type DaemonLaneBackgroundStopPayload,
  type DaemonLaneBackgroundTask,
  type DaemonLaneBackgroundTasksPayload,
  type DaemonLaneBackgroundWakePayload,
  type DaemonLaneBackgroundWakeReply,
  type DaemonLaneRef,
  type DaemonParkedLane,
} from "@multiremi/contracts/daemon-protocol.js";
import { readBackgroundDoorbell, ringsBackgroundDoorbell } from "@shared/background-tasks.js";
import { backgroundTaskItemId } from "@shared/turn-trace.js";
import { AsyncTaskOutputTailer, OUTPUT_TAIL_ATTEMPT_MS, OUTPUT_TAIL_PARKED_MS, type OutputTail } from "./async-task-output.js";

/** Parked lanes per daemon by default (`REMI_MAX_PARKED_LANES`; 0 turns parking off, D11). */
export const DEFAULT_MAX_PARKED_LANES = 4;
/** Nothing runs and no doorbell is out: the process closes this long after the last task end (PR 5's idle wait). */
export const PARKED_IDLE_CLOSE_MS = 60_000;
/** A permission or question raised while parked waits this long for an attempt to attach (R7). */
export const PARKED_REQUEST_HOLD_MS = 60_000;
/** How long Remi's own stops of a lane's tasks may take before its process closes anyway. */
export const LANE_STOP_TIMEOUT_MS = 3_000;
/**
 * How long an attempt waits for the lane's previous attempt to park or close
 * before it gives up (§2.4: one process per lane). A cancelled attempt
 * normally finishes in seconds.
 */
export const LANE_SETTLE_TIMEOUT_MS = 120_000;
/** Doorbell RPC retry backoff on a transport error (doubling up to the max); a doorbell is never dropped for it. */
const DOORBELL_RETRY_MS = 2_000;
const DOORBELL_RETRY_MAX_MS = 30_000;

/** What a lane's process needs from its provider (a subset of `MultiremiTaskProvider`). */
export interface ParkableProvider {
  listAsyncTasks?(options: { chatId?: string | null }): AsyncTaskSnapshot[];
  stopAsyncTask?(taskId: string, options: { chatId?: string | null; timeoutMs?: number; by?: TraceBackgroundTaskStopRequest["by"] }): Promise<{ stopped: boolean }>;
  park?(chatId: string, on: boolean): void;
  adoptSession?(fromChatId: string, toChatId: string): boolean;
  processGroupId?(chatId: string): number | null;
  sessionAlive?(chatId: string): boolean;
  cancelIdle?(chatId: string): Promise<void>;
  setPermissionHandler?(handler: (params: RequestPermissionParams) => Promise<PermissionOutcome>): void;
  setElicitationHandler?(handler: (params: ElicitationCreateParams) => Promise<ElicitationResult>): void;
  close?(): Promise<void> | void;
}

/**
 * What a lane's process holds besides itself (§2.8): its private temp dir, the
 * execution-tracker hold that keeps reclaim off the subject and that dir, the
 * work directory's lock, and the materialized plugins. Disposed once, when the
 * process closes.
 */
export interface LaneResources {
  readonly privateTmpPath: string | null;
  readonly pluginFingerprint: string | null;
  dispose(): Promise<void>;
}

/** Calls into the attempt that uses the lane's process now (trace facts). */
export interface LaneAttemptHooks {
  stopRequested(taskId: string, request: Pick<TraceBackgroundTaskStopRequest, "by" | "requested_at">): void;
  stopResult(taskId: string, outcome: TraceBackgroundTaskStopRequest["outcome"]): void;
  output(taskId: string, tail: string | null, truncated: boolean): void;
}

export type LaneRecordState = "in_attempt" | "parked" | "claimed" | "closed";
export type DoorbellState = "none" | "sent" | "attached";
/** Why a lane is not adopted (§2.4): the provider's own reason, a changed launch, or another provider session. */
export type LaneReleaseCause = ProviderReuseRejection | "config_changed" | "lane_reset";

/** One task of a lane, as the registry keeps it past its provider registry's lifetime. */
interface LaneTask {
  snapshot: AsyncTaskSnapshot;
  originAttemptId: string;
  /** Remi's own reason when it stopped the task (the lane's, §2.7). */
  stopReason: BackgroundTaskStopReason | null;
  outputTail: string | null;
  /** The output file is there but cannot be read (`output_unreadable`). */
  outputUnreadable: boolean;
  /** The doorbell for this task's end: owed (`pending`) until the wake RPC took it, one per task. */
  doorbell: "none" | "pending" | "delivered";
  /** Live when the current attempt handed its tasks to the lane (it will park). */
  handedOff: boolean;
}

export interface LaneRecord {
  readonly key: string;
  readonly lane: DaemonLaneRef;
  provider: ParkableProvider;
  /** The provider pool key the session is filed under now (the attempt that last adopted it). */
  poolChatId: string;
  providerSessionId: string | null;
  readonly wakesModel: boolean;
  launchFingerprint: string;
  resources: LaneResources;
  state: LaneRecordState;
  /** The attempt using the process while `in_attempt` or `claimed`. */
  attemptId: string | null;
  /** The last attempt that used the process: a task it started while parked is credited to it. */
  lastAttemptId: string;
  parkedAt: number | null;
  parkedUntil: number | null;
  lastActivityAt: number;
  doorbell: DoorbellState;
  /** The server asked to release the lane while an attempt used it: it closes at the attempt's end. */
  releaseAfterAttempt: BackgroundLaneReleaseReason | null;
  readonly tasks: Map<string, LaneTask>;
}

interface RecordInternals {
  hooks: LaneAttemptHooks | null;
  permission: ((params: RequestPermissionParams) => Promise<PermissionOutcome>) | null;
  elicitation: ((params: ElicitationCreateParams) => Promise<ElicitationResult>) | null;
  attachWaiters: Set<() => void>;
  keepAliveTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  refreshTimer: ReturnType<typeof setInterval> | null;
  closedRepeats: number;
  closedTimer: ReturnType<typeof setTimeout> | null;
  /** A snapshot was sent for this lane (so its close is reported). */
  reported: boolean;
  pgid: { pgid: number; startTime: string } | null;
  closing: Promise<void> | null;
  /** The close in progress (or done) leaves the resources to its caller. */
  closeKeepsResources: boolean;
  /** A doorbell delivery loop runs; `doorbellWake` cuts its current wait short. */
  ringing: boolean;
  doorbellWake: (() => void) | null;
}

export interface ParkedLanesOptions {
  /** Parked lanes at most; 0 turns parking off. */
  maxParkedLanes: number;
  /** The keep-alive cap (U1), from the end of the lane's latest attempt. */
  keepAliveMs: number;
  idleCloseMs?: number;
  requestHoldMs?: number;
  stopTimeoutMs?: number;
  debounceMs?: number;
  refreshMs?: number;
  closedRepeats?: number;
  closedRepeatMs?: number;
  doorbellRetryMs?: number;
  doorbellRetryMaxMs?: number;
  /** `parked-bridges.json`; null keeps no crash-sweep record. */
  stateFile: string | null;
  runtimeId(): string | null;
  /** Both sides hold `lane.background` on the current connection. */
  sharesCap(): boolean;
  sendSnapshot(payload: DaemonLaneBackgroundTasksPayload): void;
  /** `lane.background_wake`; throws `{ code }` on a rejection. */
  wake(payload: DaemonLaneBackgroundWakePayload): Promise<DaemonLaneBackgroundWakeReply>;
  log: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
  /** A process's start time (`ps -o lstart=`), for the crash sweep; null when it does not run. */
  processStartTime?: (pid: number) => string | null;
  killProcessGroup?: (pgid: number) => void;
  outputTailer?: AsyncTaskOutputTailer;
  now?: () => number;
}

export interface BeginLaneInput {
  lane: DaemonLaneRef;
  provider: ParkableProvider;
  poolChatId: string;
  attemptId: string;
  providerSessionId: string | null;
  wakesModel: boolean;
  launchFingerprint: string;
  resources: LaneResources;
}

export interface AdoptVerdict {
  adopt: boolean;
  /** Why not, as a stop reason for its tasks (§2.7) and the cause for the log. */
  reason?: BackgroundTaskStopReason;
  cause?: LaneReleaseCause;
}

/**
 * Whether a message is a background-task doorbell (§2.5). Its
 * `metadata.background_task` decides whenever the key is there (a malformed
 * one is no doorbell); only a message without it, as an offer projection that
 * drops message metadata gives, falls back to `byText`.
 */
export function isBackgroundDoorbellMessage(metadata: unknown, byText: () => boolean): boolean {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && "background_task" in metadata) {
    return readBackgroundDoorbell(metadata) !== null;
  }
  return byText();
}

export function laneKeyOf(lane: DaemonLaneRef): string {
  return `${lane.session_id}\u0000${lane.agent_id}\u0000${lane.execution_scope}`;
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isLive(state: AsyncTaskSnapshot["state"]): boolean {
  return state === "running" || state === "paused";
}

/** The lane registry of one provider daemon. */
export class ParkedLanes {
  private readonly records = new Map<string, LaneRecord>();
  private readonly internals = new WeakMap<LaneRecord, RecordInternals>();
  private readonly byChatId = new Map<string, LaneRecord>();
  /** Attempts waiting for a lane's current attempt to park or close (§2.4). */
  private readonly laneWaiters = new Map<string, Set<() => void>>();
  private revision = 0;
  private readonly now: () => number;
  private readonly tailer: AsyncTaskOutputTailer;
  /** Parking is refused (daemon stopping, draining). */
  private disabledReason: string | null = null;

  constructor(private readonly options: ParkedLanesOptions) {
    this.now = options.now ?? (() => Date.now());
    this.tailer = options.outputTailer ?? new AsyncTaskOutputTailer();
  }

  // ── Provider callbacks (AcpProviderOptions.onAsyncTaskChange / onSessionLost) ──

  /** A pooled session's task changed; `chatId` is its current pool key. */
  readonly onAsyncTaskChange = (chatId: string, task: AsyncTaskSnapshot): void => {
    const record = this.byChatId.get(chatId);
    if (!record || record.state === "closed") return;
    this.taskChanged(record, task);
  };

  /** A pooled session's process died: its tasks are lost (§2.7). */
  readonly onSessionLost = (chatId: string, reason: string, tasks: AsyncTaskSnapshot[]): void => {
    const record = this.byChatId.get(chatId);
    if (!record || record.state === "closed") return;
    for (const task of tasks) this.taskChanged(record, task, false);
    for (const task of record.tasks.values()) {
      if (isLive(task.snapshot.state)) {
        task.snapshot = { ...task.snapshot, state: "stopped", endedAt: this.now() };
        task.stopReason = "lost";
      }
    }
    this.options.log.warn("Background lane process died", { event: "background_lane_lost", lane: record.lane, reason });
    // An attempt sees the death itself and ends; a parked lane closes now. A claimed lane is its claiming
    // attempt's to release: it sees the dead process and keeps the resources (§2.8).
    if (record.state === "parked") void this.close(record, "lost", { skipStops: true });
  };

  // ── Lifecycle ──────────────────────────────────────────────────

  /** An attempt of an eligible Chat lane started a process (or adopted one): track it `in_attempt`. */
  begin(input: BeginLaneInput): LaneRecord {
    const key = laneKeyOf(input.lane);
    const existing = this.records.get(key);
    if (existing && existing.state !== "closed" && existing.poolChatId !== input.poolChatId) {
      // §2.4's invariant: one process per lane. `acquire` waits for the old one, so this is a defect;
      // never leave it untracked: stop its tasks and close it.
      this.options.log.warn("A lane already has a live process; closing it", { event: "parked_lane_conflict", lane: input.lane });
      void this.close(existing, "lane_reset");
    }
    const record: LaneRecord = {
      key, lane: input.lane, provider: input.provider, poolChatId: input.poolChatId, providerSessionId: input.providerSessionId,
      wakesModel: input.wakesModel, launchFingerprint: input.launchFingerprint, resources: input.resources,
      state: "in_attempt", attemptId: input.attemptId, lastAttemptId: input.attemptId, parkedAt: null, parkedUntil: null, lastActivityAt: this.now(),
      doorbell: "none", releaseAfterAttempt: null, tasks: new Map(),
    };
    this.records.set(key, record);
    this.internals.set(record, this.freshInternals());
    this.byChatId.set(input.poolChatId, record);
    this.installRouters(record);
    return record;
  }

  get(key: string): LaneRecord | null {
    const record = this.records.get(key);
    return record && record.state !== "closed" ? record : null;
  }

  /** A parked lane whose offer may skip the capacity check (D5); one that is closing is not. */
  isParked(key: string): boolean {
    const record = this.records.get(key);
    return record?.state === "parked" && !this.internals.get(record)?.closing;
  }

  get parkedCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (record.state === "parked") count++;
    return count;
  }

  /** Every lane whose process lives, for the hello's `parked_lanes` (§5.2). */
  helloLanes(): DaemonParkedLane[] {
    return [...this.records.values()].filter((record) => record.state !== "closed" && record.providerSessionId)
      .map((record) => ({ ...record.lane, provider_session_id: record.providerSessionId!,
        task_ids: [...record.tasks.values()].filter((task) => isLive(task.snapshot.state)).map((task) => task.snapshot.id) }));
  }

  /** Parking refused from now on (daemon stop, update, platform drain); null allows it again. */
  disable(reason: string | null): void {
    this.disabledReason = reason;
  }

  /**
   * The attempt ends with tasks running and will park the lane (§2.2): they
   * are the lane's now. One that ends before the lane is parked still rings.
   */
  handOff(record: LaneRecord): void {
    for (const task of record.tasks.values()) if (isLive(task.snapshot.state)) task.handedOff = true;
  }

  /** Remi stops these tasks at the attempt's end for `reason` (§2.2): the registry reports it. */
  noteStopReason(record: LaneRecord, taskIds: readonly string[], reason: BackgroundTaskStopReason): void {
    for (const id of taskIds) {
      const task = record.tasks.get(id);
      if (task && !task.stopReason) task.stopReason = reason;
    }
  }

  /** The lane's provider session became known (a first attempt creates it). */
  setProviderSession(record: LaneRecord, providerSessionId: string | null): void {
    if (!providerSessionId || record.providerSessionId === providerSessionId) return;
    record.providerSessionId = providerSessionId;
    this.scheduleSnapshot(record, false);
  }

  /** The attempt's trace hooks and human-request handlers (null when it ends). */
  attach(record: LaneRecord, hooks: LaneAttemptHooks | null): void {
    const internal = this.internals.get(record);
    if (!internal) return;
    internal.hooks = hooks;
    if (!hooks) {
      internal.permission = null;
      internal.elicitation = null;
    }
    this.watchOutputs(record);
  }

  /**
   * A sink for `attachHumanInputHandlers`: the attempt's handlers are kept on
   * the record, so a request raised while parked waits for the next attempt.
   */
  handlerSink(record: LaneRecord): Pick<ParkableProvider, "setPermissionHandler" | "setElicitationHandler"> {
    return {
      setPermissionHandler: (handler) => {
        const internal = this.internals.get(record);
        if (internal) { internal.permission = handler; this.wakeAttachWaiters(record); }
      },
      setElicitationHandler: (handler) => {
        const internal = this.internals.get(record);
        if (internal) { internal.elicitation = handler; this.wakeAttachWaiters(record); }
      },
    };
  }

  /** Whether an attempt ending now could park this lane (eligibility, room or an evictable lane). */
  canPark(record: LaneRecord): { park: true } | { park: false; reason: BackgroundTaskStopReason | null } {
    // A stopping or draining daemon ends its lanes, saying why (§2.7).
    if (this.disabledReason) return { park: false, reason: "daemon_restart" };
    if (this.options.maxParkedLanes <= 0 || !this.options.sharesCap()) return { park: false, reason: null };
    if (record.releaseAfterAttempt) return { park: false, reason: record.releaseAfterAttempt };
    if (record.state !== "in_attempt" || !record.provider.sessionAlive?.(record.poolChatId)) return { park: false, reason: null };
    if (this.parkedCount < this.options.maxParkedLanes || this.evictionCandidate(record)) return { park: true };
    return { park: false, reason: "no_capacity" };
  }

  /**
   * Park the lane at its attempt's end (§2.2): evict the least recently active
   * lane when full, start the keep-alive cap, suspend the provider's idle
   * cleanup, record the process group for the crash sweep. False when it
   * cannot park now; the caller then closes it.
   */
  async park(record: LaneRecord): Promise<{ parked: true } | { parked: false; reason: BackgroundTaskStopReason }> {
    const allowed = this.canPark(record);
    if (!allowed.park) return { parked: false, reason: allowed.reason ?? "turn_end" };
    if (this.parkedCount >= this.options.maxParkedLanes) {
      const victim = this.evictionCandidate(record);
      if (!victim) return { parked: false, reason: "no_capacity" };
      this.options.log.info("Evicting a parked lane", { event: "background_lane_evicted", lane: victim.lane });
      await this.close(victim, "evicted");
    }
    const internal = this.internals.get(record)!;
    const now = this.now();
    record.state = "parked";
    record.attemptId = null;
    record.parkedAt = now;
    record.parkedUntil = now + this.options.keepAliveMs;
    record.lastActivityAt = now;
    record.doorbell = "none";
    internal.hooks = null;
    internal.permission = null;
    internal.elicitation = null;
    record.provider.park?.(record.poolChatId, true);
    const pgid = record.provider.processGroupId?.(record.poolChatId) ?? null;
    const startTime = pgid ? this.options.processStartTime?.(pgid) ?? null : null;
    internal.pgid = pgid && startTime ? { pgid, startTime } : null;
    this.writeStateFile();
    internal.keepAliveTimer = setTimeout(() => {
      this.options.log.info("A parked lane reached its keep-alive cap", { event: "background_lane_keepalive_cap", lane: record.lane });
      void this.close(record, "keepalive_cap");
    }, Math.max(0, record.parkedUntil - now));
    (internal.keepAliveTimer as { unref?: () => void }).unref?.();
    this.watchOutputs(record);
    // §2.5: a handed-off task that ended while the attempt was still finishing rings now; its cycle stayed captured.
    let owed = false;
    for (const task of record.tasks.values()) {
      if (task.handedOff && task.doorbell === "none" && !isLive(task.snapshot.state)
        && ringsBackgroundDoorbell({ wakesModel: record.wakesModel }, task.snapshot.state)) {
        task.doorbell = "pending";
        owed = true;
      }
    }
    if (owed) void this.deliverDoorbells(record);
    this.scheduleIdleClose(record);
    this.scheduleSnapshot(record, true);
    this.notifyLane(record.key);
    return { parked: true };
  }

  /**
   * The next attempt of this lane, before it prepares anything (§2.4): wait
   * until no other attempt uses the lane (an attempt still finishing, a
   * stopped one included, parks or closes first), then claim the parked
   * process, or null when none is left. Throws when `signal` aborts, or
   * after {@link LANE_SETTLE_TIMEOUT_MS}.
   */
  async acquire(key: string, attemptId: string, signal?: AbortSignal, timeoutMs = LANE_SETTLE_TIMEOUT_MS): Promise<LaneRecord | null> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const record = this.records.get(key);
      if (!record) return null;
      const closing = this.internals.get(record)?.closing;
      if (closing) {
        // Its process exits and its resources go before this attempt prepares anything of its own (§2.8).
        await closing.catch(() => {});
        if (this.records.get(key) === record) this.records.delete(key);
        continue;
      }
      if (record.state === "closed") return null;
      if (record.state === "parked") return this.claim(key, attemptId);
      if (record.attemptId === attemptId) return null;
      if (this.now() >= deadline) {
        throw new Error("[lane_busy] the lane's previous attempt is still finishing; this attempt does not start a second process");
      }
      this.options.log.info("Waiting for the lane's previous attempt to park or close", { event: "background_lane_wait",
        lane: record.lane, attemptId: record.attemptId });
      await this.waitForLane(key, Math.max(0, deadline - this.now()), signal);
    }
  }

  /**
   * The next attempt of this lane takes the parked process for its
   * preparation: no doorbell, eviction or cap while it decides (§2.4). Null
   * when nothing is parked for the lane.
   */
  claim(key: string, attemptId: string): LaneRecord | null {
    const record = this.records.get(key);
    if (!record || record.state !== "parked") return null;
    const internal = this.internals.get(record)!;
    // A lane whose close (cap, eviction, release) is stopping its tasks is going: never hand it out.
    if (internal.closing) return null;
    this.clearTimer(internal, "keepAliveTimer");
    this.clearTimer(internal, "idleTimer");
    record.state = "claimed";
    record.attemptId = attemptId;
    record.lastActivityAt = this.now();
    return record;
  }

  /** The claiming attempt failed before using the process: it parks again under its old cap. */
  unclaim(record: LaneRecord): void {
    if (record.state !== "claimed") return;
    const internal = this.internals.get(record)!;
    record.state = "parked";
    record.attemptId = null;
    if (!record.provider.sessionAlive?.(record.poolChatId)) {
      // Its process died while claimed: nothing is left to park.
      void this.close(record, "lost", { skipStops: true });
      return;
    }
    const remaining = Math.max(0, (record.parkedUntil ?? this.now()) - this.now());
    internal.keepAliveTimer = setTimeout(() => void this.close(record, "keepalive_cap"), remaining);
    (internal.keepAliveTimer as { unref?: () => void }).unref?.();
    this.scheduleIdleClose(record);
    this.wakeAttachWaiters(record);
    this.notifyLane(record.key);
  }

  /**
   * Whether the claiming attempt may adopt the process (§2.4): the same
   * provider session, the same launch, and the provider's own staleness rule.
   */
  adoptVerdict(record: LaneRecord, input: { providerSessionId: string | null; launchFingerprint: string;
    reuse: { reuse: true } | { reuse: false; reason: ProviderReuseRejection } | null }): AdoptVerdict {
    if (!input.providerSessionId || input.providerSessionId !== record.providerSessionId) {
      return { adopt: false, reason: "lane_reset", cause: "lane_reset" };
    }
    if (input.launchFingerprint !== record.launchFingerprint) return { adopt: false, reason: "config_changed", cause: "config_changed" };
    if (!input.reuse || !input.reuse.reuse) {
      const cause = input.reuse && !input.reuse.reuse ? input.reuse.reason : "no_session";
      return { adopt: false, reason: cause === "process_dead" || cause === "no_session" ? "lost" : "config_changed", cause };
    }
    return { adopt: true };
  }

  /**
   * The claiming attempt adopts the process: the pool entry moves to its
   * chat id, the lane is `in_attempt` again, and a doorbell out is now
   * attached. False when the provider could not move it.
   */
  adopt(record: LaneRecord, attemptId: string, chatId: string): boolean {
    if (record.state !== "claimed" || !record.provider.adoptSession?.(record.poolChatId, chatId)) return false;
    this.byChatId.delete(record.poolChatId);
    record.poolChatId = chatId;
    this.byChatId.set(chatId, record);
    record.provider.park?.(chatId, false);
    record.state = "in_attempt";
    record.attemptId = attemptId;
    record.lastAttemptId = attemptId;
    record.parkedAt = null;
    record.parkedUntil = null;
    record.lastActivityAt = this.now();
    if (record.doorbell === "sent") record.doorbell = "attached";
    // The adopting attempt sees its tasks' ends itself until it hands them off again; a doorbell
    // still owed (the socket was down) is answered by this attempt.
    for (const task of record.tasks.values()) {
      task.handedOff = false;
      if (task.doorbell === "pending") task.doorbell = "delivered";
    }
    const internal = this.internals.get(record)!;
    internal.pgid = null;
    this.writeStateFile();
    this.scheduleSnapshot(record, true);
    return true;
  }

  /**
   * Stop the lane's tasks with `reason`, close its process and wait for it to
   * exit (§2.4 release, §2.7). With `keepResources` the caller takes the
   * resources over (a release before spawning in the same lane); otherwise
   * they are disposed. Idempotent. `keptResources` is false when an earlier
   * close disposed them: the caller must not use them.
   */
  async release(record: LaneRecord, reason: BackgroundTaskStopReason, options: { keepResources?: boolean } = {}): Promise<{ keptResources: boolean }> {
    await this.close(record, reason, options);
    return { keptResources: this.internals.get(record)?.closeKeepsResources === true };
  }

  /** The attempt using the lane ended without parking: its process closes, nothing else (its tasks were stopped). */
  async endAttempt(record: LaneRecord, reason: BackgroundTaskStopReason | null): Promise<void> {
    await this.close(record, reason ?? "turn_end");
  }

  /** Close every lane: daemon stop, update or drain (§2.7 `daemon_restart`). */
  async closeAll(reason: BackgroundTaskStopReason): Promise<void> {
    await Promise.allSettled([...this.records.values()].filter((record) => record.state === "parked" || record.state === "claimed")
      .map((record) => this.close(record, reason)));
  }

  /** The connection came back: report every live lane again, and ring the doorbells it could not. */
  resendAll(): void {
    for (const record of this.records.values()) {
      if (record.state !== "closed" && record.tasks.size) this.scheduleSnapshot(record, true);
      if ([...record.tasks.values()].some((task) => task.doorbell === "pending")) void this.deliverDoorbells(record);
    }
  }

  // ── Downlinks (§6) ─────────────────────────────────────────────

  /** `lane.background_stop`: a person stops one task or all of the lane's. */
  async handleStop(payload: DaemonLaneBackgroundStopPayload): Promise<void> {
    const record = this.get(laneKeyOf(payload));
    if (!record) return;
    const ids = payload.task_id === DAEMON_LANE_BACKGROUND_STOP_ALL
      ? [...record.tasks.values()].filter((task) => isLive(task.snapshot.state)).map((task) => task.snapshot.id)
      : [payload.task_id];
    await Promise.allSettled(ids.map((taskId) => this.stopTask(record, taskId, "user", "user")));
    record.lastActivityAt = this.now();
  }

  /** `lane.background_release`: the server saw the lane die (cold retry, archive, a moved agent). */
  async handleRelease(payload: DaemonLaneBackgroundReleasePayload): Promise<void> {
    const record = this.get(laneKeyOf(payload));
    if (!record || (record.providerSessionId && payload.provider_session_id !== record.providerSessionId)) return;
    if (record.state === "in_attempt" || record.state === "claimed") {
      // The attempt in progress ends it: it does not park.
      record.releaseAfterAttempt = payload.reason;
      return;
    }
    await this.close(record, payload.reason);
  }

  // ── Crash safety (R2) ──────────────────────────────────────────

  /**
   * At startup, before claiming anything: kill every process group a previous
   * run of this daemon left parked, when its start time still matches (a
   * reused pid is left alone), then forget them.
   */
  sweepCrashedBridges(): number {
    const path = this.options.stateFile;
    if (!path) return 0;
    let entries: Array<{ pgid?: unknown; startTime?: unknown }> = [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { bridges?: unknown };
      if (Array.isArray(parsed.bridges)) entries = parsed.bridges as typeof entries;
    } catch {
      return 0;
    }
    let killed = 0;
    for (const entry of entries) {
      const pgid = entry.pgid;
      if (typeof pgid !== "number" || !Number.isSafeInteger(pgid) || pgid <= 1 || typeof entry.startTime !== "string") continue;
      const current = this.options.processStartTime?.(pgid) ?? null;
      if (current === null || current !== entry.startTime) continue;
      try {
        this.options.killProcessGroup?.(pgid);
        killed++;
      } catch {
        // Already gone.
      }
    }
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
    if (killed) this.options.log.warn(`Killed ${killed} bridge process group(s) a previous daemon left parked`, { event: "parked_bridges_swept" });
    return killed;
  }

  // ── Internals ──────────────────────────────────────────────────

  private freshInternals(): RecordInternals {
    return { hooks: null, permission: null, elicitation: null, attachWaiters: new Set(), keepAliveTimer: null, idleTimer: null,
      debounceTimer: null, refreshTimer: null, closedRepeats: 0, closedTimer: null, reported: false, pgid: null, closing: null,
      closeKeepsResources: false, ringing: false, doorbellWake: null };
  }

  /** The provider's handlers route through the record: an attempt's, or a hold while parked (R7). */
  private installRouters(record: LaneRecord): void {
    record.provider.setPermissionHandler?.((params) => this.routeRequest(record, "permission", params,
      (handler) => handler(params), { outcome: "cancelled" } as PermissionOutcome));
    record.provider.setElicitationHandler?.((params) => this.routeRequest(record, "elicitation", params,
      (handler) => handler(params), { action: "cancel" } as ElicitationResult));
  }

  private async routeRequest<P, R>(record: LaneRecord, kind: "permission" | "elicitation", _params: P,
    call: (handler: (params: P) => Promise<R>) => Promise<R>, cancelled: R): Promise<R> {
    const current = () => {
      const internal = this.internals.get(record);
      if (!internal || record.state !== "in_attempt") return null;
      return (kind === "permission" ? internal.permission : internal.elicitation) as ((params: P) => Promise<R>) | null;
    };
    const ready = current();
    if (ready) return call(ready);
    // Raised while parked: a doorbell attempt normally attaches within seconds.
    const deadline = this.now() + (this.options.requestHoldMs ?? PARKED_REQUEST_HOLD_MS);
    while (this.now() < deadline && record.state !== "closed") {
      await new Promise<void>((resolve) => {
        const internal = this.internals.get(record);
        const timer = setTimeout(resolve, Math.min(1_000, Math.max(0, deadline - this.now())));
        internal?.attachWaiters.add(() => { clearTimeout(timer); resolve(); });
      });
      const handler = current();
      if (handler) return call(handler);
    }
    this.options.log.info("A request raised while parked found no attempt", { event: "parked_request_cancelled", kind, lane: record.lane });
    return cancelled;
  }

  /** Resolves when the lane's record changes hands (parks, unclaims, closes), after `timeoutMs`, or on abort. */
  private waitForLane(key: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let waiters = this.laneWaiters.get(key);
      if (!waiters) this.laneWaiters.set(key, waiters = new Set());
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        waiters!.delete(done);
        if (!waiters!.size && this.laneWaiters.get(key) === waiters) this.laneWaiters.delete(key);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      signal?.addEventListener("abort", done, { once: true });
      waiters.add(done);
    });
  }

  private notifyLane(key: string): void {
    for (const wake of [...this.laneWaiters.get(key) ?? []]) wake();
  }

  private wakeAttachWaiters(record: LaneRecord): void {
    const internal = this.internals.get(record);
    if (!internal) return;
    const waiters = [...internal.attachWaiters];
    internal.attachWaiters.clear();
    for (const wake of waiters) wake();
  }

  private evictionCandidate(except: LaneRecord): LaneRecord | null {
    let victim: LaneRecord | null = null;
    for (const record of this.records.values()) {
      if (record === except || record.state !== "parked" || record.doorbell !== "none" || this.internals.get(record)?.closing) continue;
      if (!victim || record.lastActivityAt < victim.lastActivityAt) victim = record;
    }
    return victim;
  }

  private taskChanged(record: LaneRecord, snapshot: AsyncTaskSnapshot, report = true): void {
    const previous = record.tasks.get(snapshot.id);
    const task: LaneTask = previous ?? {
      snapshot, originAttemptId: record.attemptId ?? record.lastAttemptId,
      stopReason: null, outputTail: null, outputUnreadable: false, doorbell: "none", handedOff: false,
    };
    const wasLive = previous ? isLive(previous.snapshot.state) : false;
    task.snapshot = snapshot;
    if (!previous) record.tasks.set(snapshot.id, task);
    if (snapshot.state === "stopped" && !task.stopReason && snapshot.stop?.by === "user") task.stopReason = "user";
    record.lastActivityAt = this.now();
    const internal = this.internals.get(record);
    if (internal?.hooks && snapshot.stop && previous?.snapshot.stop?.outcome !== snapshot.stop.outcome && snapshot.stop.outcome !== "pending") {
      internal.hooks.stopResult(snapshot.id, snapshot.stop.outcome);
    }
    if (!report) return;
    this.watchOutputs(record);
    const ended = wasLive && !isLive(snapshot.state);
    if (ended) this.tailer.finish(`${record.key}\u0000${snapshot.id}`);
    // §2.5: a parked Claude task that ended on its own rings; a stop never does.
    if (ended && (record.state === "parked" || record.state === "claimed") && task.doorbell === "none"
      && ringsBackgroundDoorbell({ wakesModel: record.wakesModel }, snapshot.state)) {
      task.doorbell = "pending";
      void this.deliverDoorbells(record);
    }
    this.scheduleIdleClose(record);
    this.scheduleSnapshot(record, false);
  }

  /** Remi's or a person's stop of one task: the request, the trace, the snapshot. */
  private async stopTask(record: LaneRecord, taskId: string, by: TraceBackgroundTaskStopRequest["by"],
    reason: BackgroundTaskStopReason, timeoutMs?: number): Promise<void> {
    const task = record.tasks.get(taskId);
    if (task && isLive(task.snapshot.state) && !task.stopReason) task.stopReason = reason;
    const internal = this.internals.get(record);
    if (task && isLive(task.snapshot.state)) internal?.hooks?.stopRequested(taskId, { by, requested_at: new Date(this.now()).toISOString() });
    const result = await record.provider.stopAsyncTask?.(taskId, { chatId: record.poolChatId, by, timeoutMs }).catch(() => ({ stopped: false }));
    if (!result?.stopped && task && !isLive(task.snapshot.state)) {
      // An ended or unknown task answers `not_running` (§6.1).
      task.snapshot = { ...task.snapshot, stop: { requestedAt: this.now(), by, outcome: "not_running" } };
    }
    this.scheduleSnapshot(record, false);
  }

  /**
   * Deliver the lane's owed doorbells, one task at a time (§2.5): retried with
   * backoff while the RPC fails, and held while the socket is down (the
   * reconnect's `resendAll` resumes it). Owed doorbells keep the lane from
   * its idle close and eviction; only the keep-alive cap (or another close)
   * bounds them. An attempt that adopts the process meanwhile sees the ends
   * itself. One delivery loop per lane.
   */
  private async deliverDoorbells(record: LaneRecord): Promise<void> {
    const internal = this.internals.get(record);
    if (!internal) return;
    if (internal.ringing) {
      internal.doorbellWake?.();
      return;
    }
    internal.ringing = true;
    const base = this.options.doorbellRetryMs ?? DOORBELL_RETRY_MS;
    const max = Math.max(base, this.options.doorbellRetryMaxMs ?? DOORBELL_RETRY_MAX_MS);
    let delay = base;
    let warned = false;
    try {
      for (;;) {
        if (internal.closing || (record.state !== "parked" && record.state !== "claimed")) return;
        const task = [...record.tasks.values()].find((candidate) => candidate.doorbell === "pending");
        if (!task) return;
        // Owed: no idle close or eviction until it is delivered.
        record.doorbell = "sent";
        this.clearTimer(internal, "idleTimer");
        if (!record.providerSessionId || !this.options.sharesCap()) {
          await this.doorbellPause(internal, max);
          continue;
        }
        try {
          const reply = await this.options.wake(this.doorbellPayload(record, task));
          task.doorbell = "delivered";
          delay = base;
          this.options.log.info("Background doorbell rang", { event: "background_doorbell", lane: record.lane,
            outcome: reply.outcome, turnId: reply.turn_id });
        } catch (error) {
          const code = (error as { code?: unknown })?.code;
          if (code === "lane_moved" || code === "session_closed") {
            task.doorbell = "delivered";
            // §2.5 step 4: nobody will attach; end the cycle and let the lane go.
            this.options.log.warn("The doorbell was rejected; the cycle stays unattached", { event: "background_cycle_unattached",
              lane: record.lane, code });
            if (record.state === "parked") {
              await record.provider.cancelIdle?.(record.poolChatId).catch(() => {});
              await this.close(record, "session_closed");
            } else {
              record.releaseAfterAttempt = "session_closed";
            }
            return;
          }
          if (!warned) {
            warned = true;
            this.options.log.warn("The doorbell is not delivered yet; retrying", { event: "background_doorbell_retry", lane: record.lane });
          }
          await this.doorbellPause(internal, delay);
          delay = Math.min(delay * 2, max);
        }
      }
    } finally {
      internal.ringing = false;
      internal.doorbellWake = null;
    }
  }

  /** Wait `ms`, or until the connection comes back (`resendAll`). */
  private doorbellPause(internal: RecordInternals, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { internal.doorbellWake = null; resolve(); }, ms);
      (timer as { unref?: () => void }).unref?.();
      internal.doorbellWake = () => { clearTimeout(timer); internal.doorbellWake = null; resolve(); };
    });
  }

  private doorbellPayload(record: LaneRecord, task: LaneTask): DaemonLaneBackgroundWakePayload {
    const snapshot = task.snapshot;
    return {
      ...record.lane, provider_session_id: record.providerSessionId!,
      task: { task_id: snapshot.id, name: snapshot.name, task_type: snapshot.taskType, status: snapshot.state as "completed" | "failed",
        origin_attempt_id: task.originAttemptId, summary: snapshot.summary,
        duration_ms: snapshot.endedAt !== null ? Math.max(0, snapshot.endedAt - snapshot.startedAt) : null },
    };
  }

  /** Nothing runs and no doorbell is out: close as `done` after `idleCloseMs` (§2.3). */
  private scheduleIdleClose(record: LaneRecord): void {
    const internal = this.internals.get(record);
    if (!internal) return;
    this.clearTimer(internal, "idleTimer");
    if (record.state !== "parked" || record.doorbell !== "none") return;
    if ([...record.tasks.values()].some((task) => isLive(task.snapshot.state))) return;
    internal.idleTimer = setTimeout(() => void this.close(record, "done"), this.options.idleCloseMs ?? PARKED_IDLE_CLOSE_MS);
    (internal.idleTimer as { unref?: () => void }).unref?.();
  }

  private watchOutputs(record: LaneRecord): void {
    const intervalMs = record.state === "parked" ? OUTPUT_TAIL_PARKED_MS : OUTPUT_TAIL_ATTEMPT_MS;
    for (const task of record.tasks.values()) {
      const key = `${record.key}\u0000${task.snapshot.id}`;
      if (!isLive(task.snapshot.state) || !task.snapshot.outputFilePath || record.state === "closed") continue;
      this.tailer.watch(key, { path: task.snapshot.outputFilePath, taskId: task.snapshot.id,
        privateTmpDirectory: record.resources.privateTmpPath, intervalMs,
        onTail: (tail: OutputTail) => {
          task.outputTail = tail.tail;
          task.outputUnreadable = tail.unreadable === true;
          this.internals.get(record)?.hooks?.output(task.snapshot.id, tail.tail, tail.truncated);
          this.scheduleSnapshot(record, false);
        } });
    }
  }

  private async close(record: LaneRecord, reason: BackgroundTaskStopReason | "done",
    options: { keepResources?: boolean; skipStops?: boolean } = {}): Promise<void> {
    const internal = this.internals.get(record);
    if (!internal) return;
    if (internal.closing) return internal.closing;
    internal.closeKeepsResources = options.keepResources === true;
    internal.closing = (async () => {
      this.clearTimer(internal, "keepAliveTimer");
      this.clearTimer(internal, "idleTimer");
      const stopReason: BackgroundTaskStopReason = reason === "done" ? "turn_end" : reason;
      const live = [...record.tasks.values()].filter((task) => isLive(task.snapshot.state));
      if (!options.skipStops && live.length && record.provider.sessionAlive?.(record.poolChatId)) {
        await Promise.allSettled(live.map((task) => this.stopTask(record, task.snapshot.id, "remi", stopReason,
          this.options.stopTimeoutMs ?? LANE_STOP_TIMEOUT_MS)));
      }
      // The process takes whatever still runs with it.
      for (const task of record.tasks.values()) {
        if (!isLive(task.snapshot.state)) continue;
        task.snapshot = { ...task.snapshot, state: "stopped", endedAt: this.now() };
        task.stopReason ??= stopReason;
      }
      record.state = "closed";
      this.wakeAttachWaiters(record);
      for (const task of record.tasks.values()) this.tailer.unwatch(`${record.key}\u0000${task.snapshot.id}`);
      try {
        await record.provider.close?.();
      } catch (error) {
        this.options.log.warn(`Closing a lane's process failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.byChatId.delete(record.poolChatId);
      if (this.records.get(record.key) === record) this.records.delete(record.key);
      internal.pgid = null;
      this.writeStateFile();
      this.notifyLane(record.key);
      if (!options.keepResources) {
        await record.resources.dispose().catch((error) => {
          this.options.log.warn(`Releasing a lane's resources failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      this.options.log.info("Background lane closed", { event: "background_lane_closed", lane: record.lane, reason });
      if (internal.reported || record.tasks.size) this.sendClosed(record);
    })();
    return internal.closing;
  }

  private clearTimer(internal: RecordInternals, key: "keepAliveTimer" | "idleTimer" | "debounceTimer" | "closedTimer"): void {
    const timer = internal[key];
    if (timer) clearTimeout(timer);
    internal[key] = null;
  }

  // ── Snapshots (§5.2) ───────────────────────────────────────────

  /** Debounced (or now), then refreshed while any task runs. */
  private scheduleSnapshot(record: LaneRecord, immediate: boolean): void {
    const internal = this.internals.get(record);
    if (!internal || record.state === "closed" || !record.tasks.size) return;
    if (immediate) {
      this.clearTimer(internal, "debounceTimer");
      this.sendSnapshotNow(record);
      return;
    }
    if (internal.debounceTimer) return;
    internal.debounceTimer = setTimeout(() => {
      internal.debounceTimer = null;
      this.sendSnapshotNow(record);
    }, this.options.debounceMs ?? DAEMON_LANE_BACKGROUND_DEBOUNCE_MS);
    (internal.debounceTimer as { unref?: () => void }).unref?.();
  }

  private sendSnapshotNow(record: LaneRecord): void {
    const internal = this.internals.get(record);
    if (!internal || record.state === "closed") return;
    this.emit(record, record.state === "parked" ? "parked" : "in_attempt");
    const running = [...record.tasks.values()].some((task) => isLive(task.snapshot.state));
    if (running && !internal.refreshTimer) {
      internal.refreshTimer = setInterval(() => {
        if (record.state === "closed" || ![...record.tasks.values()].some((task) => isLive(task.snapshot.state))) {
          if (internal.refreshTimer) clearInterval(internal.refreshTimer);
          internal.refreshTimer = null;
          if (record.state !== "closed") this.sendSnapshotNow(record);
          return;
        }
        this.emit(record, record.state === "parked" ? "parked" : "in_attempt");
      }, this.options.refreshMs ?? DAEMON_LANE_BACKGROUND_REFRESH_MS);
      (internal.refreshTimer as { unref?: () => void }).unref?.();
    }
  }

  /** A `closed` snapshot, repeated (the registry is best effort). */
  private sendClosed(record: LaneRecord): void {
    const internal = this.internals.get(record)!;
    this.clearTimer(internal, "debounceTimer");
    if (internal.refreshTimer) clearInterval(internal.refreshTimer);
    internal.refreshTimer = null;
    internal.closedRepeats = 0;
    const repeat = () => {
      this.emit(record, "closed");
      internal.closedRepeats++;
      if (internal.closedRepeats >= (this.options.closedRepeats ?? DAEMON_LANE_BACKGROUND_CLOSED_REPEATS)) return;
      internal.closedTimer = setTimeout(repeat, this.options.closedRepeatMs ?? DAEMON_LANE_BACKGROUND_CLOSED_REPEAT_MS);
      (internal.closedTimer as { unref?: () => void }).unref?.();
    };
    repeat();
  }

  private emit(record: LaneRecord, state: BackgroundLaneState): void {
    const runtimeId = this.options.runtimeId();
    const internal = this.internals.get(record);
    if (!runtimeId || !record.providerSessionId || !this.options.sharesCap() || !internal) return;
    const tasks = [...record.tasks.values()]
      // Running tasks first, then the most recent ends, at most the frame's limit.
      .sort((left, right) => Number(isLive(right.snapshot.state)) - Number(isLive(left.snapshot.state))
        || (right.snapshot.endedAt ?? right.snapshot.startedAt) - (left.snapshot.endedAt ?? left.snapshot.startedAt))
      .slice(0, DAEMON_LANE_BACKGROUND_MAX_TASKS)
      .map((task) => this.wireTask(task));
    let payload: DaemonLaneBackgroundTasksPayload = {
      ...record.lane, runtime_id: runtimeId, provider_session_id: record.providerSessionId, revision: ++this.revision, state,
      attempt_id: state === "in_attempt" ? record.attemptId : null,
      parked_until: state === "parked" ? iso(record.parkedUntil) : null, tasks,
    };
    // Output tails go first when the frame would be too large.
    if (Buffer.byteLength(JSON.stringify(payload)) > DAEMON_LANE_BACKGROUND_MAX_BYTES) {
      payload = { ...payload, tasks: payload.tasks.map((task) => ({ ...task, output_tail: null })) };
    }
    try {
      this.options.sendSnapshot(payload);
      internal.reported = true;
    } catch {
      // Best effort: the next change, refresh or reconnect replaces it.
    }
  }

  private wireTask(task: LaneTask): DaemonLaneBackgroundTask {
    const snapshot = task.snapshot;
    const status = snapshot.state as BackgroundTaskReportedStatus;
    const command = snapshot.taskType === "shell" && snapshot.description && snapshot.description !== snapshot.name ? snapshot.description : null;
    return {
      task_id: snapshot.id, task_type: snapshot.taskType, name: snapshot.name, command,
      origin_attempt_id: task.originAttemptId, origin_item_id: backgroundTaskItemId(snapshot.id), status, can_stop: snapshot.canStop,
      stop_request: snapshot.stop ? { requested_at: new Date(snapshot.stop.requestedAt).toISOString(), by: snapshot.stop.by,
        outcome: snapshot.stop.outcome } : null,
      stop_reason: status === "stopped" ? task.stopReason ?? (snapshot.stop?.by === "user" ? "user" : null) : null,
      started_at: new Date(snapshot.startedAt).toISOString(), ended_at: iso(snapshot.endedAt),
      duration_ms: snapshot.endedAt !== null ? Math.max(0, snapshot.endedAt - snapshot.startedAt) : null,
      summary: snapshot.summary, output_tail: task.outputTail, ...(task.outputUnreadable ? { output_unreadable: true } : {}),
      usage: snapshot.usage ? { total_tokens: snapshot.usage.totalTokens, tool_uses: snapshot.usage.toolUses,
        duration_ms: snapshot.usage.durationMs } : null,
    };
  }

  // ── parked-bridges.json ────────────────────────────────────────

  private writeStateFile(): void {
    const path = this.options.stateFile;
    if (!path) return;
    const bridges = [...this.records.values()].flatMap((record) => {
      const pgid = this.internals.get(record)?.pgid;
      return record.state === "parked" && pgid ? [{ ...pgid, lane: record.lane, provider_session_id: record.providerSessionId }] : [];
    });
    try {
      if (!bridges.length) {
        rmSync(path, { force: true });
        return;
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, bridges }), { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      this.options.log.warn(`Recording parked bridges failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** A process's start time as `ps` reports it (stable for its life); null when it does not run (POSIX only). */
export function processStartTime(pid: number): string | null {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return null;
    const text = result.stdout.toString().trim();
    return text || null;
  } catch {
    return null;
  }
}

/** SIGKILL a whole process group (the bridge and the shells it started). */
export function killProcessGroup(pgid: number): void {
  if (process.platform === "win32" || pgid <= 1) return;
  process.kill(-pgid, "SIGKILL");
}

/** `REMI_MAX_PARKED_LANES`: a non-negative integer, else the default. */
export function resolveMaxParkedLanes(raw: string | undefined): number {
  const value = raw !== undefined && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_MAX_PARKED_LANES;
}
