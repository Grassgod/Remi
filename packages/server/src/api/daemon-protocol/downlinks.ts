import type { DaemonProtocolLayer } from "./index.js";
import { DaemonProtocolSession } from "./session.js";
import { systemClock, type DaemonProtocolClock, type DaemonProtocolTimer } from "./clock.js";

export interface DaemonDownlinkEntity {
  key: string;
  type: string;
  payload: Record<string, unknown>;
  claimed?(): void;
  discard?(): void;
}

interface RuntimeDownlinks {
  session: DaemonProtocolSession;
  running: Promise<void> | null;
  dirty: boolean;
  delivered: Set<string>;
  sent: Map<number, { key: string; claimed?: () => void }>;
  activeTaskIds: Set<string>;
  ack: number;
  wake: DaemonProtocolTimer | null;
}

/** Payloads are derived from DB every run; only sent seq and entity identity stay in memory. */
export class DaemonDownlinks {
  private readonly runtimes = new Map<string, RuntimeDownlinks>();
  private stopped = false;
  private readonly clock: DaemonProtocolClock;

  constructor(private readonly options: {
    layer: DaemonProtocolLayer;
    snapshot(runtimeId: string, session: DaemonProtocolSession, activeTaskIds: ReadonlySet<string>): DaemonDownlinkEntity[];
    nextWakeAt?(runtimeId: string): number | null;
    clock?: DaemonProtocolClock;
  }) {
    this.clock = options.clock ?? systemClock;
    options.layer.registerSessionHooks({
      hello: (session, hello) => {
        for (const runtime of hello.runtimes) {
          if (!session.runtimeIds.includes(runtime.runtimeId)) continue;
          this.kick(runtime.runtimeId);
          this.runtimes.get(runtime.runtimeId)!.activeTaskIds = new Set(runtime.activeTaskIds);
        }
      },
      ack: (session, ack) => {
        for (const rt of session.runtimeIds) {
          const state = this.runtimes.get(rt);
          if (!state || state.session !== session) continue;
          state.ack = Math.max(state.ack, ack);
          // Claim synchronously before a result arriving on another transport.
          try { this.claimAcknowledged(state); } catch { this.schedule(rt, state, this.clock.now() + 1_000); }
          this.kick(rt);
        }
      },
      drain: session => { for (const rt of session.runtimeIds) this.kick(rt); },
      close: session => {
        for (const rt of session.runtimeIds) {
          const state = this.runtimes.get(rt);
          if (state?.session !== session) continue;
          if (state.wake !== null) this.clock.clearTimeout(state.wake);
          this.runtimes.delete(rt);
        }
      },
      stop: () => {
        this.stopped = true;
        for (const state of this.runtimes.values()) if (state.wake !== null) this.clock.clearTimeout(state.wake);
        this.runtimes.clear();
      },
    });
  }

  taskChanged(runtimeId: string | null, taskId: string): void {
    if (!runtimeId) return;
    this.kick(runtimeId);
    this.runtimes.get(runtimeId)?.activeTaskIds.add(taskId);
  }

  runtimeReady(runtimeId: string, activeTaskIds: string[]): void {
    this.kick(runtimeId);
    const state = this.runtimes.get(runtimeId);
    if (state) state.activeTaskIds = new Set(activeTaskIds);
  }

  forgetTask(runtimeId: string, taskId: string): void { this.runtimes.get(runtimeId)?.activeTaskIds.delete(taskId); }

  kickWorkspace(workspaceId: string, runtimeWorkspace: (runtimeId: string) => string | undefined): void {
    for (const session of this.options.layer.registry.listSessions()) {
      for (const rt of session.runtimeIds) if (runtimeWorkspace(rt) === workspaceId) this.kick(rt);
    }
  }

  kick(runtimeId: string): void {
    if (this.stopped) return;
    const session = this.options.layer.registry.sessionForRuntime(runtimeId);
    if (!(session instanceof DaemonProtocolSession) || session.isClosed) return;
    let state = this.runtimes.get(runtimeId);
    if (!state || state.session !== session) {
      state = { session, running: null, dirty: false, delivered: new Set(), sent: new Map(), activeTaskIds: new Set(), ack: 0, wake: null };
      this.runtimes.set(runtimeId, state);
    }
    state.dirty = true;
    if (state.running) return;
    const current = state;
    const run = Promise.resolve().then(() => {
      do {
        current.dirty = false;
        if (this.stopped || this.runtimes.get(runtimeId) !== current || session.isClosed || !session.isHandshakeComplete) return;
        this.claimAcknowledged(current);
        const entities = this.options.snapshot(runtimeId, session, current.activeTaskIds);
        if (current.wake !== null) this.clock.clearTimeout(current.wake);
        current.wake = null;
        const nextWake = this.options.nextWakeAt?.(runtimeId);
        if (nextWake !== null && nextWake !== undefined) this.schedule(runtimeId, current, nextWake);
        const keys = new Set(entities.map(entity => entity.key));
        for (const key of current.delivered) if (!keys.has(key)) current.delivered.delete(key);
        const inflight = new Set([...current.sent.values()].map(entity => entity.key));
        for (const entity of entities) {
          if (current.delivered.has(entity.key) || inflight.has(entity.key)) continue;
          const result = session.sendEvent({ t: entity.type, rt: runtimeId, p: entity.payload }, { pausable: true });
          if (!result.ok) {
            if (result.reason === "too_large") {
              current.delivered.add(entity.key);
              entity.discard?.();
              console.warn(JSON.stringify({ event: "daemon_downlink_too_large", runtime_id: runtimeId,
                entity_id: entity.key, type: entity.type }));
              continue;
            }
            // window_full/paused resume from DB on ack/drain; closed resumes at hello.
            return;
          }
          current.sent.set(result.seq, { key: entity.key, claimed: entity.claimed });
          inflight.add(entity.key);
        }
      } while (current.dirty);
    }).catch(error => {
      console.warn(JSON.stringify({ event: "daemon_downlink_snapshot_failed", runtime_id: runtimeId,
        error_class: error instanceof Error ? error.name : typeof error }));
      current.dirty = false;
      this.schedule(runtimeId, current, this.clock.now() + 1_000);
    }).finally(() => {
      current.running = null;
      if (current.dirty && this.runtimes.get(runtimeId) === current) this.kick(runtimeId);
    });
    current.running = run;
    this.options.layer.trackBackground(run);
  }

  private claimAcknowledged(state: RuntimeDownlinks): void {
    for (const [seq, entity] of state.sent) {
      if (seq > state.ack) continue;
      entity.claimed?.();
      state.sent.delete(seq);
      state.delivered.add(entity.key);
    }
  }

  private schedule(runtimeId: string, state: RuntimeDownlinks, at: number): void {
    if (this.stopped || this.runtimes.get(runtimeId) !== state) return;
    if (state.wake !== null) this.clock.clearTimeout(state.wake);
    state.wake = this.clock.setTimeout(() => {
      state.wake = null;
      this.kick(runtimeId);
    }, Math.max(1, at - this.clock.now()));
    (state.wake as ReturnType<typeof setTimeout>).unref?.();
  }
}
