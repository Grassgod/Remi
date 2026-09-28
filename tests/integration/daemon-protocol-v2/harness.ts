import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instantiateCoResidentWorkerDaemons } from "../../../apps/remi/cli/multiremi.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import type { DaemonProtocolSession } from "@multiremi/api/daemon-protocol/session.js";
import { daemonFrameText } from "@multiremi/api/daemon-protocol/frames.js";
import type { MultiremiDaemon } from "@multiremi/daemon.js";
import type { DaemonProtocolSocketLike } from "@multiremi/worker/daemon-protocol-client.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";

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
  readonly db = new Database(join(this.root, "server.db"));
  readonly store = new MultiremiStore(this.db);
  readonly clock = new ManualDaemonProtocolClock();
  readonly sockets: InjectedSocket[] = [];
  readonly sessions: DaemonProtocolSession[] = [];
  readonly ledger: LedgerEntry[] = [];
  readonly teardownSteps: string[] = [];
  readonly errors: Error[] = [];
  readonly received: Record<string, any>[] = [];
  layer!: DaemonProtocolLayer;
  server!: ReturnType<typeof startMultiremiServer>;
  daemons: MultiremiDaemon[] = [];
  private runs: Promise<void>[] = [];
  private readonly serverWork = new Set<Promise<void>>();
  private disposed = false;
  private runError: unknown;
  private createDaemons!: () => MultiremiDaemon[];
  private apiRole: "all" | "runtime" = "all";
  get client() { return this.daemons[0]!.daemonProtocolClient(); }
  get daemon() { return this.daemons[0]!; }
  get url() { return `http://127.0.0.1:${this.server.port}`; }

  static async create(options: {
    providers?: string[];
    runtimeId?: string;
    omitDaemonId?: boolean;
    cliVersion?: string;
    updateRunner?: (version: string) => Promise<string>;
    apiRole?: "all" | "runtime";
    beforeSend?: (frame: Record<string, any>, socket: InjectedSocket, harness: DaemonProtocolHarness) => boolean | void;
    onReady?: (daemon: MultiremiDaemon, harness: DaemonProtocolHarness) => void;
  } = {}): Promise<DaemonProtocolHarness> {
    const h = new DaemonProtocolHarness();
    try {
      h.store.ensureLocalWorkspace();
      const daemonId = options.omitDaemonId ? "protocol-fixture-device" : "dmn_fixture";
      h.apiRole = options.apiRole ?? "all";
      const token = await h.store.createAccessToken({ name: "protocol fixture", type: "daemon", workspaceId: "local", daemonId });
      h.startServer();
      h.createDaemons = () => instantiateCoResidentWorkerDaemons((options.providers ?? ["claude"]).map(provider => ({
        serverUrl: h.url, token: token.token, ...(options.omitDaemonId ? {} : { daemonId }), runtimeId: options.runtimeId,
        deviceName: "protocol-fixture-device", ...(options.updateRunner ? { updateRunner: options.updateRunner } : {}),
        runtimeName: "protocol fixture", provider, workspaceId: "local", daemonPort: 0,
        workspacesRoot: join(h.root, "workspaces"), repoCacheRoot: join(h.root, "repos"),
        pluginCacheRoot: join(h.root, "plugins"), outboxPath: join(h.root, `${provider}-outbox.db`),
        gcEnabled: false, pollIntervalMs: 25, claimIdleMaxMs: 30_000,
        onReadyChange: ready => { if (ready) options.onReady?.(h.daemons.find(daemon => (daemon as any).options.provider === provider)!, h); },
        providerFactory: () => ({
          async *sendStream() { yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "fixture" }] } as any; },
          getLastResponse: () => ({ text: "fixture", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
          close: async () => {},
        }),
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
      })));
      h.daemons = h.createDaemons();
      return h;
    } catch (error) { await h.dispose(); throw error; }
  }

  private startServer(port = 0): void {
    this.server = startMultiremiServer({
      store: this.store, scheduler: null, backgroundJobs: false, hostname: "127.0.0.1", port,
      authToken: "fixture-master", apiRole: this.apiRole,
      onDaemonProtocol: layer => {
        this.layer = layer;
        const open = layer.openSession.bind(layer);
        layer.openSession = (...args) => {
          const session = open(...args);
          this.sessions.push(session);
          const handle = session.handleMessage.bind(session);
          session.handleMessage = message => {
            const frame = JSON.parse(daemonFrameText(message));
            // Record at the server ingress, not when the client attempts a write.
            this.ledger.push({ sessionId: session.sessionId, partition: frame.p?.task_id ?? (frame.rt ? `rt:${frame.rt}` : "daemon"), seq: frame.seq ?? null, type: frame.t, frame });
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

  async startDaemon(expectedState = "connected"): Promise<void> {
    this.runError = null;
    this.runs = this.daemons.map(daemon => daemon.start());
    for (const run of this.runs) void run.catch(error => { this.runError = error; });
    await waitFor(() => this.client.connectionState() === expectedState || !!this.runError, "daemon handshake");
    if (this.runError) throw this.runError;
  }

  async settleHeartbeat(): Promise<void> {
    await waitFor(() => this.client.diagnostics().pending_rpcs === 0 && this.client.diagnostics().background === 0, "heartbeat and runtime callbacks");
  }

  async stopDaemon(): Promise<void> {
    for (const daemon of this.daemons) daemon.stop();
    await Promise.allSettled(this.runs);
    this.runs = [];
    if (this.daemons.length) await this.client.drain();
    await waitFor(() => this.sockets.every(socket => socket.closed), "daemon sockets to close");
    if (this.layer) await waitFor(() => this.layer.registry.size === 0, "server socket close callbacks");
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
        if (this.server) await waitFor(() => this.server.pendingRequests === 0, "server requests to drain");
      } finally {
        try {
          this.teardownSteps.push("stop server");
          this.server?.stop(true);
        } finally {
          this.teardownSteps.push("close Store");
          this.db.close();
          rmSync(this.root, { recursive: true, force: true });
        }
      }
    }
  }
}
