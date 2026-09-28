import { version } from "../../package.json";
import { MultiremiDaemon, type MultiremiDaemonOptions } from "@multiremi/daemon.js";
import type { MultiremiDaemonClient } from "@multiremi/client.js";
import { startMultiremiServer as startNativeServer } from "@multiremi/api.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";

const serverLayers = new Map<string, DaemonProtocolLayer>();

export function startMultiremiServer(options: NonNullable<Parameters<typeof startNativeServer>[0]> = {}) {
  let layer!: DaemonProtocolLayer;
  const server = startNativeServer({ backgroundJobs: false, ...options, onDaemonProtocol: value => {
    layer = value;
    options.onDaemonProtocol?.(value);
  } });
  const key = `http://${options.hostname ?? "127.0.0.1"}:${server.port}`;
  serverLayers.set(key, layer);
  const stop = server.stop.bind(server);
  server.stop = (...args) => { serverLayers.delete(key); return stop(...args); };
  return server;
}

/** Source tests do not receive the release build's MULTIREMI_VERSION define. */
export class TestMultiremiDaemon extends MultiremiDaemon {
  private testRun: Promise<void> | null = null;
  private readonly testRequests = new Set<Promise<unknown>>();
  private readonly socketClosures: Set<Promise<void>>;
  constructor(options: MultiremiDaemonOptions) {
    const socketClosures = new Set<Promise<void>>();
    const connect = options.protocolClientOptions?.connect;
    const cliVersion = options.protocolClientOptions?.cliVersion ?? version;
    super({
      onceOfferTimeoutMs: 1_000,
      ...options,
      protocolClientOptions: { ...options.protocolClientOptions, cliVersion,
        connect: (url, init) => {
          const socket = connect ? connect(url, init) : new WebSocket(url, init as never);
          let resolveClose!: () => void;
          const closed = new Promise<void>(resolve => { resolveClose = resolve; });
          const onClose = () => { socket.removeEventListener("close", onClose); resolveClose(); socketClosures.delete(closed); };
          socket.addEventListener("close", onClose);
          socketClosures.add(closed);
          return socket;
        },
      },
    });
    this.socketClosures = socketClosures;
    const client = (this as unknown as { client: MultiremiDaemonClient }).client;
    // Registration and hello must advertise the same fixture release, including
    // the startup input injected before hello can be sent.
    const registerRuntime = client.registerRuntime.bind(client);
    client.registerRuntime = input => registerRuntime({ ...input, metadata: { ...input.metadata, version: cliVersion, cli_version: cliVersion } });
    const registerDaemonRuntime = client.registerDaemonRuntime.bind(client);
    client.registerDaemonRuntime = input => registerDaemonRuntime({ ...input, cliVersion, runtime: { ...input.runtime, version: cliVersion } });
    // The legacy steer feed stops its timer without awaiting its final HTTP read.
    const listSteers = client.listPendingTaskSteerMessages.bind(client);
    client.listPendingTaskSteerMessages = (...args) => {
      const request = listSteers(...args);
      this.testRequests.add(request);
      void request.then(() => this.testRequests.delete(request), () => this.testRequests.delete(request));
      return request;
    };
  }

  override start(): Promise<void> {
    this.testRun = super.start();
    void this.testRun.catch(() => {});
    return this.testRun;
  }

  async stopAndDrainTestWork(): Promise<void> {
    this.stop();
    await this.testRun?.catch(() => {});
    await this.daemonProtocolClient().drain();
    await Promise.all([...this.socketClosures]);
    const internal = this as unknown as { options: { serverUrl: string; runtimeId?: string } };
    const layer = serverLayers.get(internal.options.serverUrl.replace(/\/$/, ""));
    if (layer && this.daemonProtocolClient().connectionState() === "stopped") {
      const deadline = performance.now() + 2_000;
      while (internal.options.runtimeId && layer.registry.sessionForRuntime(internal.options.runtimeId)) {
        if (performance.now() >= deadline) throw new Error("Server did not finish the daemon socket close callback");
        await Bun.sleep(1);
      }
      await layer.drain();
    }
    while (this.testRequests.size) await Promise.allSettled([...this.testRequests]);
  }
}
