import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { instantiateCoResidentWorkerDaemons } from "../../../apps/remi/cli/multiremi.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import type { DaemonProtocolLayer, DaemonProtocolRpcHandler } from "@multiremi/api/daemon-protocol/index.js";
import type { DaemonProtocolSession } from "@multiremi/api/daemon-protocol/session.js";
import { daemonFrameText } from "@multiremi/api/daemon-protocol/frames.js";
import { registerDaemonReportHandlers } from "@multiremi/api/daemon-protocol/report-handlers.js";
import type { MultiremiDaemon, MultiremiDaemonOptions, MultiremiDaemonProviderFactory } from "@multiremi/daemon.js";
import type { DaemonProtocolSocketLike } from "@multiremi/worker/daemon-protocol-client.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import type { PeerChannel } from "../../../packages/server/src/api/peer/peer-channel.js";
import type { LiveHub } from "@multiremi/api/hub/live-hub.js";
import { openIntegrationDatabase, type IntegrationDatabase } from "../../helpers/integration-database.js";

export interface LedgerEntry {
  sessionId: string;
  partition: string;
  seq: number | null;
  type: string;
  frame: Record<string, any>;
}

/** A real Bun socket with an injection point before individual writes. */
export class InjectedSocket implements DaemonProtocolSocketLike {
  readonly native: WebSocket;
  readonly frames: Record<string, any>[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  closed = false;
  constructor(url: string, init: { headers: Record<string, string> }, private readonly inject?: (frame: Record<string, any>, socket: InjectedSocket) => boolean | void) {
    this.native = new WebSocket(url, init as never);
    this.native.addEventListener("close", () => { this.closed = true; });
    this.native.addEventListener("message", event => { this.frames.push(JSON.parse(String(event.data))); });
  }
  get bufferedAmount(): number { return this.native.bufferedAmount; }
  send(text: string): void { if (this.inject?.(JSON.parse(text), this) !== false) this.native.send(text); }
  close(code = 1000): void { this.native.close(code); }
  addEventListener(type: string, listener: (event: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
    this.native.addEventListener(type, listener);
  }
  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
    this.native.removeEventListener(type, listener);
  }
}

export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

/** Empty-load scaffold: real daemon, Bun API, SQLite and an inert ACP provider. */
export class DaemonProtocolHarness {
  readonly root = mkdtempSync(join(tmpdir(), "mul418-protocol-"));
  readonly db: import("@multiremi/store/db/postgres.js").SqlDatabase;
  // Unified cutover owns its outer transaction; business writes stay separate.
  readonly store: MultiremiStore;
  get databaseSource(): string { return this.database?.url ?? join(this.root, "server.db"); }
  constructor(private readonly database?: IntegrationDatabase) {
    this.db = database?.db ?? openSqliteDatabase(join(this.root, "server.db")) as unknown as import("@multiremi/store/db/postgres.js").SqlDatabase;
    this.store = new MultiremiStore(this.db);
  }
  readonly clock = new ManualDaemonProtocolClock();
  readonly sockets: InjectedSocket[] = [];
  readonly sessions: DaemonProtocolSession[] = [];
  readonly ledger: LedgerEntry[] = [];
  readonly effectiveLedger: LedgerEntry[] = [];
  readonly snapshotReadMs: number[] = [];
  readonly teardownSteps: string[] = [];
  readonly errors: Error[] = [];
  readonly received: Record<string, any>[] = [];
  layer!: DaemonProtocolLayer;
  server!: ReturnType<typeof startMultiremiServer>;
  daemons: MultiremiDaemon[] = [];
  private runs: Promise<void>[] = [];
  private readonly serverWork = new Set<Promise<void>>();
  private readonly clientExchanges = new Set<Promise<unknown>>();
  private disposed = false;
  private runError: unknown;
  private readonly readyProviders = new Set<string>();
  private createDaemons!: () => MultiremiDaemon[];
  private apiRole: "all" | "runtime" = "all";
  private peerChannel: PeerChannel | null = null;
  private peerSecret = "";
  private liveHub: LiveHub | undefined;
  private onRoundCard: ((taskId: string) => void) | null = null;
  get client() { return this.daemons[0]!.daemonProtocolClient(); }
  get daemon() { return this.daemons[0]!; }
  get url() { return `http://127.0.0.1:${this.server.port}`; }

  static async create(options: {
    database?: "sqlite";
    providers?: string[];
    runtimeId?: string;
    daemonOptions?: Pick<MultiremiDaemonOptions,
      "once" | "onceOfferTimeoutMs" | "maxConcurrency" | "providerFactory" | "requestTimeoutMs"
      | "gcEnabled" | "gcIntervalMs" | "inProcessRuntimeModelDiscoveryEnabled" | "runtimeModelRefreshIntervalMs">;
    runtimeIds?: string[];
    outboxBackoffMs?: number[];
    providerFactory?: MultiremiDaemonProviderFactory;
    beforeStart?: (harness: DaemonProtocolHarness) => void | Promise<void>;
    omitDaemonId?: boolean;
    cliVersion?: string;
    updateRunner?: (version: string) => Promise<string>;
    apiRole?: "all" | "runtime";
    peerChannel?: PeerChannel;
    peerSecret?: string;
    liveHub?: LiveHub;
    beforeSend?: (frame: Record<string, any>, socket: InjectedSocket, harness: DaemonProtocolHarness) => boolean | void;
    onReady?: (daemon: MultiremiDaemon, harness: DaemonProtocolHarness) => void;
    onRoundCard?: (taskId: string) => void;
  } = {}): Promise<DaemonProtocolHarness> {
    const h = new DaemonProtocolHarness(process.env.MULTIREMI_TEST_POSTGRES_URL && options.database !== "sqlite"
      ? await openIntegrationDatabase() : undefined);
    try {
      h.store.ensureLocalWorkspace();
      const daemonId = options.omitDaemonId ? "protocol-fixture-device" : "dmn_fixture";
      h.apiRole = options.apiRole ?? "all";
      h.peerChannel = options.peerChannel ?? null;
      h.peerSecret = options.peerSecret ?? "";
      h.liveHub = options.liveHub;
      h.onRoundCard = options.onRoundCard ?? null;
      if (h.onRoundCard) {
        const recordCard = h.store.recordTurnCardCompletionFieldsWithinTransaction.bind(h.store);
        h.store.recordTurnCardCompletionFieldsWithinTransaction = (taskId, fields) => {
          h.onRoundCard?.(taskId);
          return recordCard(taskId, fields);
        };
      }
      const token = await h.store.createAccessToken({ name: "protocol fixture", type: "daemon", workspaceId: "local", daemonId });
      h.startServer();
      h.createDaemons = () => {
        const daemons = instantiateCoResidentWorkerDaemons((options.providers ?? ["claude"]).map((provider, index) => ({
          serverUrl: h.url, token: token.token, ...(options.omitDaemonId ? {} : { daemonId }), runtimeId: options.runtimeIds?.[index] ?? options.runtimeId,
          deviceName: "protocol-fixture-device", ...(options.updateRunner ? { updateRunner: options.updateRunner } : {}),
          runtimeName: "protocol fixture", provider, workspaceId: "local", daemonPort: 0,
          workspacesRoot: join(h.root, "workspaces"), repoCacheRoot: join(h.root, "repos"),
          pluginCacheRoot: join(h.root, "plugins"), outboxPath: join(h.root, `${provider}-outbox.db`),
          outboxBackoffMs: options.outboxBackoffMs,
          gcEnabled: false, pollIntervalMs: 25, claimIdleMaxMs: 30_000,
          onReadyChange: ready => {
            if (ready) {
              h.readyProviders.add(provider);
              options.onReady?.(h.daemons.find(daemon => (daemon as any).options.provider === provider)!, h);
            }
          },
          providerFactory: options.providerFactory ?? (() => ({
            async *sendStream() { yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "fixture" }] } as any; },
            getLastResponse: () => ({ text: "fixture", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
            close: async () => {},
          })),
          sshMeshManager: { getHeartbeatStatus: () => ({ status: "disabled" }), reconcile: async () => {}, cleanupForRetirement: async () => {} },
          protocolClientOptions: {
            cliVersion: options.cliVersion ?? DAEMON_MIN_CLI_VERSION,
            clock: h.clock, random: () => 0.5, onError: error => h.errors.push(error),
            onFrame: frame => { h.received.push(frame.raw); },
            connect: (url, init) => {
              const socket = new InjectedSocket(url, init, (frame, socket) => options.beforeSend?.(frame, socket, h));
              h.sockets.push(socket);
              return socket;
            },
          },
          ...options.daemonOptions,
        })));
        for (const daemon of daemons) {
          // Inert providers have no installed CLI or ACP bridge to inspect.
          const versions = daemon as unknown as { acpVersion(): string | null; agentVersion(): string | null };
          versions.acpVersion = () => null;
          versions.agentVersion = () => null;
        }
        const client = daemons[0]!.daemonProtocolClient();
        const rpc = client.rpc.bind(client);
        const event = client.event.bind(client);
        client.rpc = (...args) => h.trackExchange(rpc(...args));
        client.event = (...args) => h.trackExchange(event(...args));
        return daemons;
      };
      h.daemons = h.createDaemons();
      await options.beforeStart?.(h);
      return h;
    } catch (error) { await h.dispose(); throw error; }
  }

  private startServer(port = 0): void {
    this.server = startMultiremiServer({
      store: this.store, scheduler: null, backgroundJobs: false, hostname: "127.0.0.1", port,
      authToken: "fixture-master", apiRole: this.apiRole,
      liveHub: this.liveHub,
      peerChannel: this.peerChannel, peerSecret: this.peerSecret,
      onDaemonProtocol: layer => {
        this.layer = layer;
        // Observe persisted business fields after successful handlers, not ingress or ACK receipt.
        const handlers = (layer as any).eventHandlers as Map<string, DaemonProtocolRpcHandler>;
        for (const type of ["task.start", "task.progress", "task.usage", "turn.complete"]) {
          const handle = handlers.get(type)!;
          const state = (id: string) => {
            const started = performance.now();
            const task = this.store.getTask(id);
            this.snapshotReadMs.push(performance.now() - started);
            return task ? { status: task.status, result: task.result, usage: task.usage,
              progress: [task.progressSummary, task.progressStep, task.progressTotal] } : null;
          };
          layer.registerEventHandler(type, async (frame, session) => {
            const partition = String(frame.payload.attempt_id ?? frame.payload.task_id ?? "");
            const before = state(partition);
            const reply = await handle(frame, session);
            if ((reply as { ok?: unknown } | null)?.ok === true && !isDeepStrictEqual(before, state(partition))) {
              this.effectiveLedger.push({ sessionId: session.sessionId, partition,
                seq: frame.seq, type: frame.type, frame: frame.raw });
            }
            return reply;
          });
        }
        const open = layer.openSession.bind(layer);
        layer.openSession = (...args) => {
          const session = open(...args);
          this.sessions.push(session);
          const handle = session.handleMessage.bind(session);
          session.handleMessage = message => {
            const frame = JSON.parse(daemonFrameText(message));
            // Record at the server ingress, not when the client attempts a write.
            this.ledger.push({ sessionId: session.sessionId, partition: frame.p?.attempt_id ?? frame.p?.task_id ?? (frame.rt ? `rt:${frame.rt}` : "daemon"), seq: frame.seq ?? null, type: frame.t, frame });
            const run = handle(message);
            this.serverWork.add(run);
            void run.finally(() => this.serverWork.delete(run));
            return run;
          };
          return session;
        };
      },
    });
  }

  async startDaemon(options: string | { waitForSocket?: boolean } = "connected"): Promise<void> {
    this.runError = null;
    this.readyProviders.clear();
    this.runs = this.daemons.map(daemon => daemon.start());
    for (const run of this.runs) void run.catch(error => { this.runError = error; });
    const waitForSocket = typeof options === "string" || options.waitForSocket !== false;
    const expectedState = typeof options === "string" ? options : "connected";
    await waitFor(() => (waitForSocket ? this.client.connectionState() === expectedState
      : this.daemons.every(daemon => (daemon as any).supervisorReady())) || !!this.runError, "daemon startup");
    if (this.runError) throw this.runError;
    if (waitForSocket && expectedState === "connected") {
      await waitFor(() => this.readyProviders.size === this.daemons.length && this.serverWork.size === 0
        && this.daemons.every(daemon => this.ledger.some(entry => entry.type === "runtime.ready"
          && entry.frame.rt === (daemon as any).options.runtimeId))
        || !!this.runError, "daemon readiness and initial runtime recovery");
      if (this.runError) throw this.runError;
    }
  }

  private trackExchange<T>(run: Promise<T>): Promise<T> {
    this.clientExchanges.add(run);
    void run.then(() => this.clientExchanges.delete(run), () => this.clientExchanges.delete(run));
    return run;
  }

  async settleHeartbeat(timeoutMs = 5_000): Promise<void> {
    // Await actual exchanges and queued lane work, not the 2 s polling default.
    // The failure deadline matches reporting's 5 s waits and the heartbeat integration suite.
    const drain = async () => {
      do {
        await Promise.allSettled([...this.clientExchanges]);
        await this.client.drain();
      } while (this.clientExchanges.size || this.client.diagnostics().background);
      if (this.client.diagnostics().pending_rpcs) throw new Error("Untracked daemon exchange during heartbeat settlement");
    };
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([drain(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for heartbeat and runtime callbacks: ${JSON.stringify(this.client.diagnostics())}`)), timeoutMs);
      })]);
    } finally { clearTimeout(timer!); }
  }

  async stopDaemon(): Promise<void> {
    for (const daemon of this.daemons) daemon.stop();
    await Promise.allSettled(this.runs);
    this.runs = [];
    if (this.daemons.length) await this.client.drain();
    await waitFor(() => this.sockets.every(socket => socket.closed), "daemon sockets to close");
    if (this.layer) await waitFor(() => this.layer.registry.size === 0, "server socket close callbacks");
  }

  async waitForDaemonExit(): Promise<void> {
    await Promise.all(this.runs);
    if (this.runError) throw this.runError;
  }

  async restartDaemon(): Promise<void> { await this.stopDaemon(); await this.startDaemon(); }

  async recreateDaemon(): Promise<void> {
    await this.stopDaemon();
    this.daemons = this.createDaemons();
    await this.startDaemon();
  }

  async disconnect(): Promise<void> {
    this.sockets.at(-1)!.close(4001);
    await waitFor(() => this.client.connectionState() === "disconnected", "socket disconnect");
  }

  async reconnect(): Promise<void> {
    this.clock.advance(1_000);
    await waitFor(() => this.client.connectionState() === "connected", "socket reconnect");
    await this.settleHeartbeat();
  }

  async restartServer(): Promise<void> {
    const port = this.server.port;
    // Bun 1.3.14's stop promise can retain an already-closed server-initiated WS.
    // Observe actual close callbacks instead; rebinding proves the listener stop.
    void this.server.stop(true);
    await waitFor(() => this.client.connectionState() === "disconnected", "server disconnect");
    await waitFor(() => this.sockets.every(socket => socket.closed) && this.layer.registry.size === 0, "server shutdown socket drain");
    this.startServer(port);
    await this.reconnect();
  }

  async health(): Promise<Record<string, any>> {
    return await (await fetch(`http://127.0.0.1:${this.daemon.localPort()}/health`)).json() as Record<string, any>;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.teardownSteps.push("stop daemon");
      await this.stopDaemon();
    } finally {
      try {
        this.teardownSteps.push("drain background");
        while (this.serverWork.size) await Promise.allSettled([...this.serverWork]);
        await this.layer?.drain();
        if (this.server) await waitFor(() => this.server.pendingRequests === 0, "server requests to drain");
      } finally {
        try {
          this.teardownSteps.push("stop server");
          this.server?.stop(true);
        } finally {
          this.teardownSteps.push("close Store");
          if (this.database) await this.database.close();
          else this.db.close();
          rmSync(this.root, { recursive: true, force: true });
        }
      }
    }
  }
}
