import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MultiremiDaemonSshMeshStatus,
  MultiremiSshMeshHeartbeatAck,
} from "@multiremi/contracts/types.js";
import { startMultiremiServer } from "@multiremi/api.js";
import {
  ControlPlaneSshMeshReconciler,
  createControlPlaneSshMeshFromEnv,
  type ControlPlaneSshMeshManagerContract,
  type ControlPlaneSshMeshStore,
} from "@multiremi/ssh-mesh/control-plane.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  resetMultiremiTestEnv();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("control-plane SSH Mesh reconciler", () => {
  it("is opt-in and validates required stable identity and storage", () => {
    const store = fakeStore();
    expect(createControlPlaneSshMeshFromEnv(store, {})).toBeNull();
    expect(() => createControlPlaneSshMeshFromEnv(store, {
      MULTIREMI_SSH_MESH_CONTROL_PLANE: "1",
    })).toThrow("MULTIREMI_SSH_MESH_CONTROL_PLANE_NODE_ID is required");
    expect(() => createControlPlaneSshMeshFromEnv(store, {
      MULTIREMI_SSH_MESH_CONTROL_PLANE: "1",
      MULTIREMI_SSH_MESH_CONTROL_PLANE_NODE_ID: "platform-test",
      MULTIREMI_SSH_MESH_CONTROL_PLANE_ROOT: "relative/ssh-mesh",
    })).toThrow("must be an absolute path");
  });

  it("reports immediately, reconciles single-flight, and reports the applied status", async () => {
    const home = tempHome();
    const reports: MultiremiDaemonSshMeshStatus[] = [];
    let reportCount = 0;
    let active = 0;
    let maxActive = 0;
    let resolveFirst!: () => void;
    const firstReconcile = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const manager: ControlPlaneSshMeshManagerContract = {
      getHeartbeatStatus: () => ({
        status: reportCount > 1 ? "ready" : "syncing",
        hostname: "platform-test",
      }),
      reconcile: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await firstReconcile;
        active--;
      },
    };
    const store: ControlPlaneSshMeshStore = {
      recordControlPlaneSshMeshHeartbeat: (workspaceId, nodeId, displayName, protocol, status) => {
        expect(workspaceId).toBe("local");
        expect(nodeId).toBe("control-plane-test");
        expect(displayName).toBe("Test platform");
        expect(protocol).toBe(1);
        reports.push(status);
        reportCount++;
        return desired(reportCount === 1);
      },
      getSshMeshConfigForNode: () => null,
    };
    const reconciler = new ControlPlaneSshMeshReconciler({
      store,
      nodeId: "control-plane-test",
      displayName: "Test platform",
      workspaceIds: ["local", "local"],
      root: join(home, "Services", "remi-platform", "ssh-mesh"),
      home,
      heartbeatIntervalMs: 5,
      retryDelaysMs: [5],
      managerFactory: () => manager,
    });

    expect(reconciler.start()).toBe(true);
    await waitFor(() => reportCount === 1);
    await Bun.sleep(15);
    expect(maxActive).toBe(1);
    expect(reportCount).toBe(1);

    resolveFirst();
    await waitFor(() => reports.some((status) => status.status === "ready"));
    reconciler.stop();
    await reconciler.whenStopped();

    expect(maxActive).toBe(1);
    expect(reports[0]?.status).toBe("syncing");
    expect(reports.at(-1)?.status).toBe("ready");
  });

  it("holds one process owner lease per stable root and stop never cleans SSH files", async () => {
    const home = tempHome();
    const root = join(home, "Services", "remi-platform", "ssh-mesh");
    let cleanupCalls = 0;
    const manager = {
      getHeartbeatStatus: () => ({ status: "disabled" as const }),
      reconcile: async () => {},
      cleanupForRetirement: async () => { cleanupCalls++; },
    };
    const options = {
      store: fakeStore(),
      nodeId: "control-plane-test",
      displayName: "Test platform",
      workspaceIds: ["local"],
      root,
      home,
      heartbeatIntervalMs: 1_000,
      retryDelaysMs: [5],
      managerFactory: () => manager,
    };
    const first = new ControlPlaneSshMeshReconciler(options);
    let secondReports = 0;
    const second = new ControlPlaneSshMeshReconciler({
      ...options,
      store: {
        recordControlPlaneSshMeshHeartbeat: () => {
          secondReports++;
          return desired(false);
        },
        getSshMeshConfigForNode: () => null,
      },
    });

    expect(first.start()).toBe(true);
    expect(second.start()).toBe(true);
    await Bun.sleep(15);
    expect(secondReports).toBe(0);
    first.stop();
    await first.whenStopped();
    expect(cleanupCalls).toBe(0);

    await waitFor(() => secondReports > 0);
    second.stop();
    await second.whenStopped();
    expect(cleanupCalls).toBe(0);
  });

  it("starts and stops with the API server lifecycle", () => {
    const store = createStore();
    let starts = 0;
    let stops = 0;
    const server = startMultiremiServer({
      store,
      scheduler: null,
      controlPlaneSshMesh: {
        start: () => { starts++; },
        stop: () => { stops++; },
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    expect(starts).toBe(1);
    expect(stops).toBe(0);
    server.stop(true);
    expect(stops).toBe(1);
  });
});

function fakeStore(): ControlPlaneSshMeshStore {
  return {
    recordControlPlaneSshMeshHeartbeat: () => desired(false),
    getSshMeshConfigForNode: () => null,
  };
}

function desired(needsSync: boolean): MultiremiSshMeshHeartbeatAck {
  return {
    enabled: false,
    key_version: 0,
    config_revision: "disabled-revision",
    needs_sync: needsSync,
    rotation_state: "stable",
    probe_revision: 0,
    needs_probe: false,
  };
}

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "control-plane-ssh-mesh-"));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await Bun.sleep(5);
  }
}
