import { DAEMON_OFFER_COOLDOWN_MS, DAEMON_OFFER_TIMEOUT_MS, type DaemonTurnInput } from "@multiremi/contracts/daemon-protocol.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { MultiremiTask, MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";
import { hydrateClaimKnowledge } from "@multiremi/project-knowledge/claim-hydration.js";
import type { ProjectKnowledgeServiceContract } from "@multiremi/project-knowledge/service.js";
import type { RepositoryWikiServiceContract } from "@multiremi/repository-wiki/service.js";
import { canonicalRepositoryRemote, resolveTaskRepositoryWikiRepositories } from "@multiremi/repository-wiki/task-scope.js";
import { invalidateRequestReadCache } from "@multiremi/store/request-read-cache.js";
import { daemonTaskClaimResponse, cleanString } from "../wire/index.js";
import { systemClock, type DaemonProtocolClock, type DaemonProtocolTimer } from "./clock.js";
import type { DaemonProtocolLayer } from "./index.js";
import { DaemonProtocolSession } from "./session.js";
import type { DaemonParsedFrame } from "./frames.js";
import { fitTaskOfferToBudget, useTaskSessionInput } from "./offer-budget.js";

export const DAEMON_OFFER_SWEEP_MS = 60_000;

/** S2 supplies the canonical turn input with the claimed attempt. */
export function daemonTurnOfferPayload(execution: Record<string, unknown>, input: DaemonTurnInput): Record<string, unknown> {
  const { id: _attemptId, prompt: _prompt, ...context } = execution;
  if (!input.turn_id || !input.attempt_id || !Number.isSafeInteger(input.input_from_seq)
    || !Number.isSafeInteger(input.input_to_seq) || input.input_from_seq < 0
    || input.input_to_seq < input.input_from_seq || !Array.isArray(input.input_messages)) {
    throw new Error("unified turn offer context missing");
  }
  return { ...context, turn_id: input.turn_id, attempt_id: input.attempt_id,
    input_from_seq: input.input_from_seq, input_to_seq: input.input_to_seq, input_messages: input.input_messages };
}

export async function prepareTaskOffer(store: MultiremiStore, task: MultiremiTaskWithAgent,
  project: ProjectKnowledgeServiceContract, repository: RepositoryWikiServiceContract,
  supportsWikiFetch = false,
  input: DaemonTurnInput = store.getDaemonTurnBridge().offerInput(task)): Promise<Record<string, unknown> | null> {
  // Validate canonical input before preparing the execution context and access token.
  daemonTurnOfferPayload({}, input);
  const remotes = new Set(task.repos.map(repo => canonicalRepositoryRemote(repo.url)));
  for (const repo of resolveTaskRepositoryWikiRepositories(store, task)) {
    if (!remotes.has(canonicalRepositoryRemote(repo.url))) {
      task.repos.push({ url: repo.url });
      remotes.add(canonicalRepositoryRemote(repo.url));
    }
  }
  const hydrated = await hydrateClaimKnowledge(task, project, repository, 5_000,
    undefined, supportsWikiFetch);
  invalidateRequestReadCache();
  const current = store.getTaskIdentity(task.id);
  if (current?.status !== "dispatched" || current.runtimeId !== task.runtimeId) return null;
  const response = daemonTaskClaimResponse(store, hydrated, store.getTaskTriggerMetadata(task));
  useTaskSessionInput(store, task, response);
  const runtime = store.getRuntimeLite(task.runtimeId!);
  const token = await store.createTaskAccessToken(task, cleanString(runtime?.ownerId) ?? "local");
  response.auth_token = token.token;
  return daemonTurnOfferPayload(response, input);
}

interface RuntimePump {
  running: Promise<void> | null;
  dirty: boolean;
  waiting: boolean;
  cooldownUntil: number;
  cooldownReason: string | null;
  cooldownTimer: DaemonProtocolTimer | null;
  preparing: string | null;
  pending: { taskId: string; agentId: string; inlineRead: { sessionId: string; seqs: number[]; toSeq: number; coldStart: boolean } | null;
    session: DaemonProtocolSession; seq: number; timer: DaemonProtocolTimer } | null;
  accepted: Set<string>;
  sweep: boolean;
}

/** The database is the queue; memory holds only leases, deadlines and single-flight state. */
export class DaemonTaskOffers {
  private readonly pumps = new Map<string, RuntimePump>();
  private readonly clock: DaemonProtocolClock;
  private readonly heartbeatCounts = new Map<string, number>();
  private stopped = false;
  private sweepTimer: DaemonProtocolTimer | null = null;
  private readonly retryTimers = new Map<string, DaemonProtocolTimer>();

  constructor(private readonly options: {
    store: MultiremiStore;
    layer: DaemonProtocolLayer;
    prepare(task: MultiremiTaskWithAgent, supportsWikiFetch?: boolean): Promise<Record<string, unknown> | null>;
    clock?: DaemonProtocolClock;
    sweepMs?: number;
    onRuntimeReady?(runtimeId: string, activeTaskIds: string[]): void;
  }) {
    this.clock = options.clock ?? systemClock;
    options.layer.registerSessionHooks({
      stop: () => {
        this.stopped = true;
        if (this.sweepTimer !== null) this.clock.clearTimeout(this.sweepTimer);
        for (const timer of this.retryTimers.values()) this.clock.clearTimeout(timer);
        this.retryTimers.clear();
        for (const pump of this.pumps.values()) {
          if (pump.cooldownTimer !== null) this.clock.clearTimeout(pump.cooldownTimer);
          if (pump.pending) this.clock.clearTimeout(pump.pending.timer);
        }
      },
      hello: (session, hello) => {
        for (const rt of session.runtimeIds) {
          options.store.reconcileQuestionWaits(rt, hello.runtimes.find(r => r.runtimeId === rt)?.activeQuestionWaits ?? []);
          for (const retry of options.store.taskOfferRetryDeadlines(rt)) {
            if (Date.parse(retry.at) > this.clock.now()) this.scheduleRetry(retry.taskId, retry.runtimeId, Date.parse(retry.at));
          }
          this.kick(rt);
        }
      },
      heartbeat: (session, hb) => {
        const count = hb.payload.active_task_count;
        if (typeof count !== "number" || this.heartbeatCounts.get(session.sessionId) === count) return;
        this.heartbeatCounts.set(session.sessionId, count);
        for (const rt of session.runtimeIds) {
          const pump = this.pumps.get(rt);
          if (pump?.cooldownReason === "capacity" && this.clock.now() < pump.cooldownUntil) {
            if (pump.cooldownTimer !== null) this.clock.clearTimeout(pump.cooldownTimer);
            pump.cooldownTimer = null;
            pump.cooldownUntil = 0;
            pump.cooldownReason = null;
          }
          this.kick(rt);
        }
      },
      reply: (session, frame) => this.reply(session, frame),
      ack: session => this.resume(session),
      drain: session => this.resume(session),
      close: session => this.closed(session),
    });
    options.layer.registerBestEffortHandler("runtime.ready", (frame, session) => this.ready(frame, session));
    const sweepMs = options.sweepMs ?? (process.env.NODE_ENV === "test" ? 2_147_483_647 : DAEMON_OFFER_SWEEP_MS);
    const sweep = () => {
      if (this.stopped) return;
      for (const session of options.layer.registry.listSessions()) {
        for (const rt of session.runtimeIds) this.kick(rt, true);
      }
      this.sweepTimer = this.clock.setTimeout(sweep, sweepMs);
      (this.sweepTimer as ReturnType<typeof setTimeout>).unref?.();
    };
    this.sweepTimer = this.clock.setTimeout(sweep, sweepMs);
    (this.sweepTimer as ReturnType<typeof setTimeout>).unref?.();
  }

  kick(runtimeId?: string | null, sweep = false): void {
    if (this.stopped) return;
    if (!runtimeId) {
      for (const session of this.options.layer.registry.listSessions()) for (const rt of session.runtimeIds) this.kick(rt, sweep);
      return;
    }
    const pump = this.pump(runtimeId);
    if (sweep && (pump.running || pump.waiting || pump.pending || this.clock.now() < pump.cooldownUntil)) return;
    pump.sweep = sweep;
    pump.dirty = true;
    if (pump.running || pump.waiting || pump.pending || this.clock.now() < pump.cooldownUntil) return;
    // hello's callback precedes welcome. Start on the next microtask, after the handshake commits.
    const run = Promise.resolve().then(async () => {
      do {
        pump.dirty = false;
        const fromSweep = pump.sweep;
        pump.sweep = false;
        await this.run(runtimeId, pump, fromSweep);
      } while (pump.dirty && !pump.waiting && !pump.pending && this.clock.now() >= pump.cooldownUntil);
    }).catch(error => {
      console.warn(JSON.stringify({ event: "daemon_offer_failed", runtime_id: runtimeId,
        error_class: error instanceof Error ? error.name : typeof error }));
    }).finally(() => {
      pump.running = null;
      if (pump.dirty && !pump.waiting && !pump.pending && this.clock.now() >= pump.cooldownUntil) this.kick(runtimeId);
    });
    pump.running = run;
    this.options.layer.trackBackground(run);
  }

  kickWorkspace(workspaceId: string): void {
    for (const session of this.options.layer.registry.listSessions()) {
      for (const rt of session.runtimeIds) {
        if ((this.options.store.getRuntimeLite(rt)?.workspaceId ?? "local") === workspaceId) this.kick(rt);
      }
    }
  }

  enqueued(task: MultiremiTask): void {
    this.kick(task.runtimeId);
    if (!task.nextRetryAt) return;
    this.scheduleRetry(task.id, task.runtimeId, Date.parse(task.nextRetryAt));
  }

  private scheduleRetry(taskId: string, runtimeId: string | null, deadline: number): void {
    const previous = this.retryTimers.get(taskId);
    if (previous !== undefined) this.clock.clearTimeout(previous);
    if (!Number.isFinite(deadline)) return;
    const timer = this.clock.setTimeout(() => {
      this.retryTimers.delete(taskId);
      this.kick(runtimeId);
    }, Math.max(0, deadline - this.clock.now()));
    (timer as ReturnType<typeof setTimeout>).unref?.();
    this.retryTimers.set(taskId, timer);
  }

  terminal(taskId: string, runtimeId: string | null): void {
    const timer = this.retryTimers.get(taskId);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.retryTimers.delete(taskId);
    this.options.store.releaseTaskOfferLease(taskId);
    if (runtimeId) this.pumps.get(runtimeId)?.accepted.delete(taskId);
    const task = this.options.store.getTaskIdentity(taskId);
    if (task) this.kickWorkspace(task.workspaceId);
    else this.kick(runtimeId);
  }

  private pump(runtimeId: string): RuntimePump {
    let pump = this.pumps.get(runtimeId);
    if (!pump) {
      pump = { running: null, dirty: false, waiting: false, cooldownUntil: 0, cooldownReason: null, cooldownTimer: null,
        preparing: null, pending: null, accepted: new Set(), sweep: false };
      this.pumps.set(runtimeId, pump);
    }
    return pump;
  }

  private session(runtimeId: string): DaemonProtocolSession | null {
    const session = this.options.layer.registry.sessionForRuntime(runtimeId);
    return session instanceof DaemonProtocolSession && session.isHandshakeComplete && !session.isClosed ? session : null;
  }

  private async run(runtimeId: string, pump: RuntimePump, fromSweep: boolean): Promise<void> {
    const { store } = this.options;
    const session = this.session(runtimeId);
    if (this.stopped || !session || pump.pending || this.clock.now() < pump.cooldownUntil) return;
    const maintenance = store.getPlatformMaintenance();
    if (maintenance.mode === "draining") {
      if (maintenance.expiresAt) this.scheduleRetry("platform-drain", null, Date.parse(maintenance.expiresAt));
      return;
    }
    const runtime = store.getRuntimeLite(runtimeId);
    // Status/input notifications do not create work. Avoid a locked claim and
    // heartbeat write when this workspace has no queued or offered turn.
    if (!runtime || !store.hasPendingTaskOffers(runtime.workspaceId ?? "local")) return;
    const task = store.claimTask(runtimeId, { supportsBinarySkillFiles: true });
    if (!task) return;
    pump.preparing = task.id;
    try {
      const payload = await this.options.prepare(task, session.supportsWikiFetch);
      invalidateRequestReadCache();
      const current = store.getTaskIdentity(task.id);
      if (!payload || current?.status !== "dispatched" || current.runtimeId !== runtimeId) return;
      if (this.session(runtimeId) !== session) { this.rescind(runtimeId, pump, task.id); return; }
      const budgeted = fitTaskOfferToBudget(payload, runtimeId, undefined, session.supportsWikiFetch);
      console.info(JSON.stringify({ event: "daemon_offer_budget", task_id: task.id, runtime_id: runtimeId, ...budgeted.report }));
      let report = budgeted.report;
      const failSize = () => {
        const parts = Object.entries(report.parts).sort((a, b) => b[1] - a[1]);
        const error = `offer_too_large: bytes=${report.bytes}; parts=${parts.map(([key, size]) => `${key}:${size}`).join(",")}`;
        store.failTask(task.id, { error, failureReason: "offer_too_large" });
        pump.dirty = true;
      };
      let sent = session.sendEvent({ t: "task.offer", rt: runtimeId, p: payload }, { pausable: true });
      if (!sent.ok && sent.reason === "too_large") {
        const compact = fitTaskOfferToBudget(payload, runtimeId, 16 * 1024, session.supportsWikiFetch);
        report = compact.report;
        console.warn(JSON.stringify({ event: "daemon_offer_transport_capacity", task_id: task.id, ...compact.report }));
        sent = session.sendEvent({ t: "task.offer", rt: runtimeId, p: compact.response }, { pausable: true });
      }
      if (!sent.ok) {
        if (sent.reason === "too_large") failSize();
        else if (sent.reason === "closed") this.rescind(runtimeId, pump, task.id);
        else {
          pump.waiting = true;
          store.requeueTaskOffer(task.id, runtimeId);
        }
        return;
      }
      store.recordTaskOffered(task.id, runtimeId, new Date(this.clock.now()).toISOString());
      if (fromSweep) {
        console.warn(JSON.stringify({ event: "daemon_offer_sweep_recovered", runtime_id: runtimeId, task_id: task.id }));
        this.options.layer.recordOfferSweepRecovery();
      }
      const timer = this.clock.setTimeout(() => this.rescind(runtimeId, pump, task.id), DAEMON_OFFER_TIMEOUT_MS);
      (timer as ReturnType<typeof setTimeout>).unref?.();
      const projection = payload.session_projection as { session_id?: string; to_seq: number; jsonl?: string; mode?: string } | undefined;
      const inlineRead = projection?.session_id && projection.jsonl ? { sessionId: projection.session_id, toSeq: projection.to_seq,
        coldStart: projection.mode === "bootstrap",
        seqs: projection.jsonl.split("\n").filter(Boolean).map(line => JSON.parse(line))
          .filter(entry => entry.type === "triggering_message" && !entry.body_folded && !entry.body_omitted_chars)
          .map(entry => Number(entry.seq)) } : null;
      pump.pending = { taskId: task.id, agentId: task.agentId, inlineRead, session, seq: sent.seq, timer };
    } catch (error) {
      const current = store.getTaskIdentity(task.id);
      if (current?.status === "dispatched" && current.runtimeId === runtimeId) this.rescind(runtimeId, pump, task.id);
      throw error;
    } finally { pump.preparing = null; }
  }

  private reply(session: DaemonProtocolSession, frame: DaemonParsedFrame): void {
    for (const runtimeId of session.runtimeIds) {
      const pump = this.pumps.get(runtimeId);
      const pending = pump?.pending;
      if (!pump || !pending || pending.session !== session || String(pending.seq) !== frame.re) continue;
      if (frame.payload.ok !== true) {
        const reason = frame.payload.reason ?? frame.payload.code;
        this.rescind(runtimeId, pump, pending.taskId, typeof reason === "string" ? reason : null, frame.payload.ok === false);
        return;
      }
      this.clock.clearTimeout(pending.timer);
      pump.pending = null;
      if (this.options.store.acceptTaskOffer(pending.taskId, runtimeId, new Date(this.clock.now()).toISOString())) {
        pump.accepted.add(pending.taskId);
        if (pending.inlineRead) {
          try { this.options.store.recordSessionAgentInlineRead(pending.inlineRead.sessionId, pending.agentId,
            pending.inlineRead.seqs, pending.inlineRead.toSeq, pending.inlineRead.coldStart, pending.taskId); }
          catch { console.warn(JSON.stringify({ event: "session_log_read_progress_failed", task_id: pending.taskId })); }
        }
      }
      this.kick(runtimeId);
      return;
    }
  }

  private rescind(runtimeId: string, pump: RuntimePump, taskId: string, reason: string | null = null, rejected = false): void {
    if (pump.pending?.taskId === taskId) {
      this.clock.clearTimeout(pump.pending.timer);
      pump.pending = null;
    }
    if (pump.cooldownTimer !== null) this.clock.clearTimeout(pump.cooldownTimer);
    pump.cooldownReason = reason;
    pump.cooldownUntil = this.clock.now() + DAEMON_OFFER_COOLDOWN_MS;
    pump.cooldownTimer = this.clock.setTimeout(() => {
      pump.cooldownTimer = null;
      pump.cooldownReason = null;
      this.kick(runtimeId);
    }, DAEMON_OFFER_COOLDOWN_MS);
    (pump.cooldownTimer as ReturnType<typeof setTimeout>).unref?.();
    this.options.store.requeueTaskOffer(taskId, runtimeId, rejected ? "rejected" : "unknown");
  }

  private resume(session: DaemonProtocolSession): void {
    for (const runtimeId of session.runtimeIds) {
      const pump = this.pumps.get(runtimeId);
      if (pump) pump.waiting = false;
      this.kick(runtimeId);
    }
  }

  private closed(session: DaemonProtocolSession): void {
    this.heartbeatCounts.delete(session.sessionId);
    for (const runtimeId of session.runtimeIds) {
      const pump = this.pumps.get(runtimeId);
      if (!pump) continue;
      pump.waiting = false;
      const taskId = pump.pending?.session === session ? pump.pending.taskId : pump.preparing;
      if (taskId) this.rescind(runtimeId, pump, taskId);
      for (const id of pump.accepted) {
        this.options.store.releaseTaskOfferLease(id);
        const task = this.options.store.getTask(id);
        if (task?.status === "dispatched" && task.dispatchedAt) {
          this.scheduleRetry(id, runtimeId, Date.parse(task.dispatchedAt) + 90_000);
        }
      }
      pump.accepted.clear();
    }
  }

  private ready(frame: DaemonParsedFrame, session: DaemonProtocolSession): void {
    const runtimeId = frame.rt;
    const ids = frame.payload.active_task_ids;
    if (!runtimeId || !session.runtimeIds.includes(runtimeId) || !Array.isArray(ids) || ids.some(id => typeof id !== "string")) return;
    const waits = Array.isArray(frame.payload.active_question_waits) ? frame.payload.active_question_waits.filter((value): value is import('@multiremi/contracts/daemon-protocol.js').DaemonQuestionWait =>
      !!value && typeof value === 'object' && typeof value.message_id === 'string' && typeof value.attempt_id === 'string' && typeof value.wait_id === 'string' && value.wait_id.length >= 16) : [];
    this.options.store.reconcileQuestionWaits(runtimeId, waits);
    if (this.options.onRuntimeReady) this.options.onRuntimeReady(runtimeId, ids as string[]);
    else {
      for (const id of ids as string[]) {
        const task = this.options.store.getTaskIdentity(id);
        if (task?.runtimeId === runtimeId && ["completed", "failed", "cancelled"].includes(task.status)) {
          session.sendEvent({ t: "task.cancelled", rt: runtimeId, p: { task_id: id, status: task.status } });
        }
      }
    }
    this.options.store.recoverOrphans(runtimeId, ids as string[]);
    this.kick(runtimeId);
  }
}
