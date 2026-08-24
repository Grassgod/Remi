#!/usr/bin/env bun

import "@shared/db/sqlite-custom.js";

import { createControlPlaneSshMeshFromEnv } from "@multiremi/ssh-mesh/control-plane.js";
import { MultiremiStore } from "@multiremi/store.js";

const enabled = process.env.MULTIREMI_SSH_MESH_CONTROL_PLANE === "1";
let stop: (() => Promise<void>) | null = null;

if (enabled) {
  const store = new MultiremiStore();
  const reconciler = createControlPlaneSshMeshFromEnv(store);
  if (!reconciler) throw new Error("SSH Mesh control plane is enabled but unavailable");
  reconciler.start();
  stop = async () => {
    reconciler.stop();
    await reconciler.whenStopped();
  };
  console.log("Multiremi SSH Mesh control plane started");
} else {
  console.log("Multiremi SSH Mesh control plane is disabled");
}

await waitForShutdown(stop);

async function waitForShutdown(shutdown: (() => Promise<void>) | null): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const handleSignal = () => {
      if (stopping) return;
      stopping = true;
      Promise.resolve(shutdown?.()).finally(resolve);
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  });
}
