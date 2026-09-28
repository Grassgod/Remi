import { version } from "../../package.json";
import { MultiremiDaemon, type MultiremiDaemonOptions } from "@multiremi/daemon.js";
import type { MultiremiDaemonClient, MultiremiDaemonHeartbeatConfigAck } from "@multiremi/client.js";

/** Source tests do not receive the release build's MULTIREMI_VERSION define. */
export class TestMultiremiDaemon extends MultiremiDaemon {
  constructor(options: MultiremiDaemonOptions) {
    super({
      ...options,
      protocolClientOptions: { cliVersion: version, ...options.protocolClientOptions },
    });
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
