import { version } from "../../package.json";
import { MultiremiDaemon, type MultiremiDaemonOptions } from "@multiremi/daemon.js";
import type { MultiremiDaemonClient, MultiremiDaemonHeartbeatConfigAck } from "@multiremi/client.js";

/** Source tests do not receive the release build's MULTIREMI_VERSION define. */
export class TestMultiremiDaemon extends MultiremiDaemon {
  private testRun: Promise<void> | null = null;
  private readonly testRequests = new Set<Promise<unknown>>();
  constructor(options: MultiremiDaemonOptions) {
    const cliVersion = options.protocolClientOptions?.cliVersion ?? version;
    super({
      ...options,
      protocolClientOptions: { ...options.protocolClientOptions, cliVersion },
    });
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
    while (this.testRequests.size) await Promise.allSettled([...this.testRequests]);
  }
}

/** Temporary test input adapter, removed when MUL-419 wires business downlinks. */
export async function injectDaemonHeartbeatInput(
  daemon: MultiremiDaemon,
  options: { onNextRegistration?: boolean; input?: MultiremiDaemonHeartbeatConfigAck } = {},
): Promise<void> {
  const internal = daemon as unknown as {
    options: { runtimeId?: string };
    client: MultiremiDaemonClient;
    pollAbort: AbortController;
    activeTaskCount: number;
    appliedDrainGeneration: number;
    sshMeshManager: { getHeartbeatStatus(): Parameters<MultiremiDaemonClient["heartbeatRuntime"]>[1] };
    registerCurrentRuntime(): Promise<string>;
    handleHeartbeatAck(runtimeId: string, input: MultiremiDaemonHeartbeatConfigAck): Promise<boolean>;
    reconcileRuntimeAgentPlugins(runtimeId: string, revision: string | null): Promise<void>;
    wakeClaim(): void;
  };
  const deliver = async () => {
    const runtimeId = internal.options.runtimeId;
    if (!runtimeId) throw new Error("Register the test daemon before injecting heartbeat input");
    const input = options.input ?? await internal.client.heartbeatRuntime(
      runtimeId, internal.sshMeshManager.getHeartbeatStatus(),
      { ackGeneration: internal.appliedDrainGeneration, activeTaskCount: internal.activeTaskCount },
      false, false, internal.pollAbort.signal,
    );
    await internal.handleHeartbeatAck(runtimeId, input);
    if (options.input) await internal.reconcileRuntimeAgentPlugins(runtimeId, options.input.agent_plugins?.revision ?? null);
    internal.wakeClaim();
  };
  if (options.onNextRegistration) {
    const register = internal.registerCurrentRuntime;
    internal.registerCurrentRuntime = async () => {
      internal.registerCurrentRuntime = register;
      const runtimeId = await register.call(daemon);
      await deliver();
      return runtimeId;
    };
    return;
  }
  if (!options.input) {
    const client = daemon.daemonProtocolClient();
    const deadline = performance.now() + 5_000;
    while (client.connectionState() !== "connected") {
      if (performance.now() >= deadline) throw new Error("Test daemon did not complete the v2 handshake before input injection");
      await Bun.sleep(5);
    }
    await client.drain();
  }
  await deliver();
}
