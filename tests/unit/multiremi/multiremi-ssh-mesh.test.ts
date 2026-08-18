import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import {
  decryptSshMeshPrivateKey,
  encryptSshMeshPrivateKey,
  SshMeshKeyError,
} from "@multiremi/ssh-mesh/keys.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

const ROOT_TOKEN = "ssh-mesh-root-secret";
let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY;
  process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

afterEach(() => {
  resetMultiremiTestEnv();
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY;
  else process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY = previousEncryptionKey;
});

describe("Multiremi SSH Mesh", () => {
  it("binds AES-256-GCM private-key envelopes to workspace and key version", () => {
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\ntest-only\n-----END OPENSSH PRIVATE KEY-----\n";
    const encrypted = encryptSshMeshPrivateKey(privateKey, "workspace-a", 3);

    expect(encrypted).toStartWith("v1.");
    expect(encrypted).not.toContain("OPENSSH");
    expect(decryptSshMeshPrivateKey(encrypted, "workspace-a", 3)).toBe(privateKey);
    expect(() => decryptSshMeshPrivateKey(encrypted, "workspace-b", 3)).toThrow(SshMeshKeyError);
    expect(() => decryptSshMeshPrivateKey(encrypted, "workspace-a", 4)).toThrow(SshMeshKeyError);
  });

  it("generates a dedicated key, withholds it from browsers, and serves it only to the bound daemon", async () => {
    const { store, app, runtimeA, runtimeA2, runtimeB, daemonA, daemonB } = await setupFleet();

    const enabledResponse = await app.request("/api/workspaces/local/ssh-mesh", {
      method: "PUT",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabledResponse.status).toBe(200);
    const enabled = await enabledResponse.json() as any;
    expect(enabled).toMatchObject({ enabled: true, key_version: 1, rotation_state: "stable" });
    expect(enabled.fingerprint).toStartWith("SHA256:");
    expect(enabled.runtimes).toHaveLength(2);
    expect(enabled.runtimes.find((item: any) => item.daemon_id === "daemon-a").runtime_ids.sort())
      .toEqual([runtimeA.id, runtimeA2.id].sort());
    expect(JSON.stringify(enabled)).not.toContain("PRIVATE KEY");
    expect(enabled).not.toHaveProperty("public_key");

    const stored = db!.query(
      "SELECT active_private_key_encrypted FROM multiremi_workspace_ssh_mesh WHERE workspace_id = 'local'",
    ).get() as { active_private_key_encrypted: string };
    expect(stored.active_private_key_encrypted).toStartWith("v1.");
    expect(stored.active_private_key_encrypted).not.toContain("OPENSSH");

    const configResponse = await app.request(
      `/api/daemon/ssh-mesh/config?runtime_id=${runtimeA.id}`,
      { headers: { Authorization: `Bearer ${daemonA.token}` } },
    );
    expect(configResponse.status).toBe(200);
    expect(configResponse.headers.get("cache-control")).toBe("no-store");
    const config = await configResponse.json() as any;
    expect(config.private_key).toStartWith("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(config.public_key).toStartWith("ssh-ed25519 ");
    expect(config.authorized_public_keys).toEqual([config.public_key]);
    expect(config.hosts).toEqual([]);

    const wrongDaemon = await app.request(
      `/api/daemon/ssh-mesh/config?runtime_id=${runtimeB.id}`,
      { headers: { Authorization: `Bearer ${daemonA.token}` } },
    );
    expect(wrongDaemon.status).toBe(403);
    const masterCannotReadPrivateKey = await app.request(
      `/api/daemon/ssh-mesh/config?runtime_id=${runtimeA.id}`,
      { headers: { Authorization: `Bearer ${ROOT_TOKEN}` } },
    );
    expect(masterCannotReadPrivateKey.status).toBe(403);

    const browserRouteWithDaemon = await app.request("/api/workspaces/local/ssh-mesh", {
      headers: { Authorization: `Bearer ${daemonB.token}` },
    });
    expect(browserRouteWithDaemon.status).toBe(403);

    const rejectedImport = await app.request("/api/workspaces/local/ssh-mesh", {
      method: "PUT",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ enabled: true, private_key: config.private_key }),
    });
    expect(rejectedImport.status).toBe(400);
    expect(await rejectedImport.json()).toEqual({ error: "only server-generated SSH Mesh keys are supported" });
    expect(store.getSshMeshOverview("local").key_version).toBe(1);
  });

  it("deduplicates provider runtimes, propagates endpoint state, and triggers an immediate peer probe", async () => {
    const { store, app, runtimeA, runtimeB, daemonA, daemonB } = await setupFleet();
    await enableMesh(app);
    const workspaceEvents: any[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => workspaceEvents.push(event));

    const firstHeartbeat = await daemonHeartbeat(app, runtimeA.id, daemonA.token, {
      status: "syncing",
      key_version: null,
      config_revision: null,
      probe_revision: 0,
      ssh_user: "hehuajie",
      hostname: "n37-206-133-hehuajie",
      port: 22,
      addresses: ["10.37.206.133"],
      host_keys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestA"],
      public_key_installed: false,
      config_installed: false,
    });
    expect(firstHeartbeat.ssh_mesh).toMatchObject({ enabled: true, key_version: 1, needs_sync: true });
    unsubscribe();
    const heartbeatEvent = workspaceEvents.find((event) => event.type === "daemon:heartbeat");
    expect(heartbeatEvent).toMatchObject({
      workspaceId: "local",
      actorType: "daemon",
      actorId: "daemon-a",
      payload: {
        runtime_id: runtimeA.id,
        daemon_id: "daemon-a",
        ssh_mesh: { status: "syncing", enabled: true, key_version: 1 },
      },
    });
    expect(JSON.stringify(heartbeatEvent)).not.toContain("PRIVATE KEY");
    expect(heartbeatEvent.payload.ssh_mesh).not.toHaveProperty("public_key");
    expect(heartbeatEvent.payload.ssh_mesh).not.toHaveProperty("authorized_public_keys");

    const configAResponse = await app.request(
      `/api/daemon/ssh-mesh/config?runtime_id=${runtimeA.id}`,
      { headers: { Authorization: `Bearer ${daemonA.token}` } },
    );
    const configA = await configAResponse.json() as any;
    expect(configA.hosts).toHaveLength(1);
    expect(configA.hosts[0]).toMatchObject({
      daemon_id: "daemon-a",
      hostname: "n37-206-133-hehuajie",
      addresses: ["10.37.206.133"],
    });
    expect(configA.hosts[0].alias).toStartWith("remi-n37-206-133-hehuajie-");

    await daemonHeartbeat(app, runtimeB.id, daemonB.token, {
      status: "ready",
      key_version: 1,
      config_revision: configA.config_revision,
      probe_revision: 0,
      ssh_user: "hehuajie",
      hostname: "n37-066-008-hehuajie",
      addresses: ["10.37.66.8"],
      host_keys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestB"],
      public_key_installed: true,
      config_installed: true,
    });
    const probeConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(probeConfig));

    const testResponse = await app.request("/api/workspaces/local/ssh-mesh/test", {
      method: "POST",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ source_daemon_id: "daemon-a", target_daemon_id: "daemon-b" }),
    });
    expect(testResponse.status).toBe(202);
    const requested = await testResponse.json() as any;
    expect(requested).toMatchObject({ probe_revision: 1, status: "pending" });

    const probeAck = await daemonHeartbeat(app, runtimeA.id, daemonA.token, {
      status: "ready",
      key_version: probeConfig.key_version,
      config_revision: probeConfig.config_revision,
      probe_revision: 0,
      public_key_installed: true,
      config_installed: true,
    });
    expect(probeAck.ssh_mesh).toMatchObject({ probe_revision: 1, needs_probe: true });
    const refreshedConfig = await (await app.request(
      `/api/daemon/ssh-mesh/config?runtime_id=${runtimeA.id}`,
      { headers: { Authorization: `Bearer ${daemonA.token}` } },
    )).json() as any;
    expect(refreshedConfig.probe_target_daemon_ids).toEqual(["daemon-b"]);

    await daemonHeartbeat(app, runtimeA.id, daemonA.token, {
      status: "ready",
      key_version: 1,
      config_revision: refreshedConfig.config_revision,
      probe_revision: 1,
      public_key_installed: true,
      config_installed: true,
      peers: [{ daemon_id: "daemon-b", status: "ready", latency_ms: 12 }],
    });
    const overview = await (await app.request("/api/workspaces/local/ssh-mesh", {
      headers: { Authorization: `Bearer ${ROOT_TOKEN}` },
    })).json() as any;
    const machineA = overview.runtimes.find((item: any) => item.daemon_id === "daemon-a");
    expect(machineA).toMatchObject({ probe_revision: 1, desired_probe_revision: 1 });
    expect(machineA.peer_tests[0]).toMatchObject({ daemon_id: "daemon-b", status: "ready", latency_ms: 12 });
    expect(machineA.peer_tests[0].checked_at).toBeTruthy();
    const postProbeConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    expect(postProbeConfig.probe_target_daemon_ids).toEqual([]);
  });

  it("retires the previous key without waiting for a daemon whose persisted online status is stale", async () => {
    const { app, runtimeA, runtimeB, daemonA, daemonB } = await setupFleet();
    await enableMesh(app);
    const bootstrapConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(bootstrapConfig));
    await daemonHeartbeat(app, runtimeB.id, daemonB.token, readyStatusFor(bootstrapConfig));
    const initialConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(initialConfig));
    await daemonHeartbeat(app, runtimeB.id, daemonB.token, readyStatusFor(initialConfig));
    db!.run(
      `UPDATE multiremi_runtimes
       SET status = 'online', last_heartbeat_at = '2000-01-01T00:00:00.000Z'
       WHERE daemon_id = 'daemon-b'`,
    );

    const rotatedResponse = await app.request("/api/workspaces/local/ssh-mesh/rotate", {
      method: "POST",
      headers: { Authorization: `Bearer ${ROOT_TOKEN}` },
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as any;
    expect(rotated).toMatchObject({ key_version: 2, rotation_state: "rolling_out" });

    const rolloutConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    expect(rolloutConfig.key_version).toBe(2);
    expect(rolloutConfig.private_key).not.toBe(initialConfig.private_key);
    expect(rolloutConfig.authorized_public_keys).toHaveLength(2);

    const onlineAck = await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(rolloutConfig));
    expect(onlineAck.ssh_mesh.rotation_state).toBe("stable");
    expect(onlineAck.ssh_mesh.needs_sync).toBe(true);
    const finalizedConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    expect(finalizedConfig.rotation_state).toBe("stable");
    expect(finalizedConfig.authorized_public_keys).toHaveLength(1);
    expect(finalizedConfig.public_key).toBe(rolloutConfig.public_key);

    const returningAck = await daemonHeartbeat(app, runtimeB.id, daemonB.token, readyStatusFor(initialConfig));
    expect(returningAck.ssh_mesh).toMatchObject({
      rotation_state: "stable",
      key_version: 2,
      needs_sync: true,
    });
  });

  it("serializes concurrent key rotations and rejects another rotation while rollout is active", async () => {
    const { store, app, runtimeA, daemonA } = await setupFleet();
    await enableMesh(app);
    const initialConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(initialConfig));

    const responses = await Promise.all([
      app.request("/api/workspaces/local/ssh-mesh/rotate", {
        method: "POST",
        headers: { Authorization: `Bearer ${ROOT_TOKEN}` },
      }),
      app.request("/api/workspaces/local/ssh-mesh/rotate", {
        method: "POST",
        headers: { Authorization: `Bearer ${ROOT_TOKEN}` },
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(store.getSshMeshOverview("local")).toMatchObject({
      key_version: 2,
      rotation_state: "rolling_out",
    });

    const disableDuringRollout = await app.request("/api/workspaces/local/ssh-mesh", {
      method: "PUT",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableDuringRollout.status).toBe(409);
    expect(await disableDuringRollout.json()).toMatchObject({
      error: "SSH Mesh key rotation is in progress; wait for rollout or invalidate the key",
    });
    expect(store.getSshMeshOverview("local")).toMatchObject({ enabled: true, rotation_state: "rolling_out" });

    const continuous = await app.request("/api/workspaces/local/ssh-mesh/rotate", {
      method: "POST",
      headers: { Authorization: `Bearer ${ROOT_TOKEN}` },
    });
    expect(continuous.status).toBe(409);
    expect(await continuous.json()).toMatchObject({ error: "SSH Mesh key rotation is already in progress" });
    expect(store.getSshMeshOverview("local").key_version).toBe(2);
  });

  it("fails closed when the server encryption key is not configured", async () => {
    delete process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY;
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store, authToken: ROOT_TOKEN });

    const response = await app.request("/api/workspaces/local/ssh-mesh", {
      method: "PUT",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "encryption_key_missing" });
    expect(Number((db!.query("SELECT COUNT(*) AS count FROM multiremi_workspace_ssh_mesh").get() as any).count)).toBe(0);
  });

  it("blocks SSH Mesh enable for a legacy bound daemon credential that can expire", async () => {
    const { store, app, daemonA } = await setupFleet();
    db!.run(
      "UPDATE multiremi_access_tokens SET expires_at = '2999-01-01T00:00:00.000Z' WHERE id = ?",
      [daemonA.id],
    );

    const response = await app.request("/api/workspaces/local/ssh-mesh", {
      method: "PUT",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "ssh_mesh_expiring_daemon_credentials",
      daemon_ids: ["daemon-a"],
    });
    expect(store.getSshMeshOverview("local")).toMatchObject({ enabled: false, key_version: 0 });
  });

  it("rotates the shared key when a daemon is retired", async () => {
    const { store, app, runtimeA, daemonA } = await setupFleet();
    await enableMesh(app);
    const initialConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(initialConfig));
    const plan = store.getDaemonRetirementPlan("local", "daemon-b");
    expect(plan.canRetire).toBeTrue();

    const response = await app.request("/api/multiremi/daemons/daemon-b/retire", {
      method: "POST",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: plan.snapshot }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "retired",
      ssh_mesh_key_rotation: { status: "rolling_out", key_version: 2 },
    });
    expect(store.getSshMeshOverview("local")).toMatchObject({
      key_version: 2,
      rotation_state: "rolling_out",
    });
  });

  it("invalidates all shared key material when retirement rotation fails and creates a fresh key on re-enable", async () => {
    const { store, app, runtimeA, daemonA } = await setupFleet();
    await enableMesh(app);
    const originalConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    const plan = store.getDaemonRetirementPlan("local", "daemon-b");

    delete process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY;
    const response = await app.request("/api/multiremi/daemons/daemon-b/retire", {
      method: "POST",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: plan.snapshot }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "retired",
      ssh_mesh_key_rotation: {
        status: "failed_rekey_required",
        rotation_state: "rekey_required",
      },
    });
    expect(store.getSshMeshOverview("local")).toMatchObject({
      enabled: false,
      key_version: 2,
      fingerprint: null,
      rotation_state: "rekey_required",
    });
    const invalidated = db!.query(
      `SELECT active_private_key_encrypted, active_public_key, active_fingerprint,
              previous_private_key_encrypted, previous_public_key, previous_fingerprint
       FROM multiremi_workspace_ssh_mesh WHERE workspace_id = 'local'`,
    ).get() as Record<string, unknown>;
    expect(Object.values(invalidated).every((value) => value === null)).toBeTrue();

    process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const retryPlan = store.getDaemonRetirementPlan("local", "daemon-b");
    const retry = await app.request("/api/multiremi/daemons/daemon-b/retire", {
      method: "POST",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: retryPlan.snapshot }),
    });
    expect(await retry.json()).toMatchObject({
      already_retired: true,
      ssh_mesh_key_rotation: {
        status: "rekey_required",
        key_version: 2,
        rotation_state: "rekey_required",
      },
    });
    expect(store.getSshMeshOverview("local").key_version).toBe(2);

    const reenabled = await app.request("/api/workspaces/local/ssh-mesh", {
      method: "PUT",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    expect(reenabled.status).toBe(200);
    expect(await reenabled.json()).toMatchObject({
      enabled: true,
      key_version: 3,
      rotation_state: "stable",
    });
    const replacementConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    expect(replacementConfig.private_key).not.toBe(originalConfig.private_key);
    expect(replacementConfig.public_key).not.toBe(originalConfig.public_key);
  });

  it("recovers a crash after retirement commit and never repeats its associated rotation", async () => {
    const { store, app, runtimeA, daemonA } = await setupFleet();
    await enableMesh(app);
    const initialConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(initialConfig));
    const plan = store.getDaemonRetirementPlan("local", "daemon-b");

    const committed = store.retireDaemon("local", "daemon-b", plan.snapshot, "local");
    expect(committed).toMatchObject({ status: "retired", alreadyRetired: false });
    expect(store.getDaemonRetirementSshMeshRekey("local", "daemon-b")).toMatchObject({
      status: "pending",
      compromisedKeyVersion: 1,
      replacementKeyVersion: null,
    });

    const retryPlan = store.getDaemonRetirementPlan("local", "daemon-b");
    const retry = () => app.request("/api/multiremi/daemons/daemon-b/retire", {
      method: "POST",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: retryPlan.snapshot }),
    });
    const recovered = await retry();
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      already_retired: true,
      ssh_mesh_key_rotation: { status: "rolling_out", key_version: 2 },
    });
    expect(store.getDaemonRetirementSshMeshRekey("local", "daemon-b")).toMatchObject({
      status: "rolling_out",
      replacementKeyVersion: 2,
    });

    const idempotent = await retry();
    expect(idempotent.status).toBe(200);
    expect(await idempotent.json()).toMatchObject({
      ssh_mesh_key_rotation: { status: "rolling_out", key_version: 2 },
    });
    expect(store.getSshMeshOverview("local").key_version).toBe(2);

    const rolloutConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(rolloutConfig));
    const completed = await retry();
    expect(await completed.json()).toMatchObject({
      ssh_mesh_key_rotation: { status: "completed", key_version: 2 },
    });
    const completedAgain = await retry();
    expect(await completedAgain.json()).toMatchObject({
      ssh_mesh_key_rotation: { status: "completed", key_version: 2 },
    });
    expect(store.getSshMeshOverview("local").key_version).toBe(2);
  });

  it("keeps invalidated key material fenced when a rotate request races revocation", async () => {
    const { store, app } = await setupFleet();
    await enableMesh(app);

    const rotate = app.request("/api/workspaces/local/ssh-mesh/rotate", {
      method: "POST",
      headers: { Authorization: `Bearer ${ROOT_TOKEN}` },
    });
    const invalidated = store.invalidateSshMeshKey("local");
    const rotateResponse = await rotate;
    expect([200, 409]).toContain(rotateResponse.status);

    const overview = store.getSshMeshOverview("local");
    expect(overview).toMatchObject({
      enabled: false,
      fingerprint: null,
      rotation_state: "rekey_required",
    });
    expect(overview.key_version).toBeGreaterThanOrEqual(invalidated.key_version);
    const fencedVersion = overview.key_version;
    expect(store.invalidateSshMeshKey("local").key_version).toBe(fencedVersion);
    const stored = db!.query(
      `SELECT active_private_key_encrypted, active_public_key,
              previous_private_key_encrypted, previous_public_key
       FROM multiremi_workspace_ssh_mesh WHERE workspace_id = 'local'`,
    ).get() as Record<string, unknown>;
    expect(Object.values(stored).every((value) => value === null)).toBeTrue();
  });

  it("never accepts an unrelated newer key generation as a retirement replacement", async () => {
    const { store, app } = await setupFleet();
    await enableMesh(app);
    const plan = store.getDaemonRetirementPlan("local", "daemon-b");
    expect(store.retireDaemon("local", "daemon-b", plan.snapshot, "local")).toMatchObject({
      status: "retired",
      alreadyRetired: false,
    });
    const pending = store.getDaemonRetirementSshMeshRekey("local", "daemon-b")!;
    expect(pending).toMatchObject({
      status: "pending",
      compromisedKeyVersion: 1,
      replacementKeyVersion: null,
    });
    expect(pending.operationId).toStartWith("sshrekey_");
    expect(() => store.rotateSshMeshKey("local", {
      privateKey: "test-private-key",
      publicKey: "ssh-ed25519 test",
      fingerprint: "SHA256:test",
    })).toThrow("daemon retirement SSH key replacement is in progress");

    // Reproduce the state a cross-process, unrelated rotation could have left
    // before lifecycle serialization was introduced.
    db!.run(
      `UPDATE multiremi_workspace_ssh_mesh
       SET active_key_version = 2, active_operation_id = 'sshrot_unrelated'
       WHERE workspace_id = 'local'`,
    );
    const retryPlan = store.getDaemonRetirementPlan("local", "daemon-b");
    const retry = await app.request("/api/multiremi/daemons/daemon-b/retire", {
      method: "POST",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: retryPlan.snapshot }),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      already_retired: true,
      ssh_mesh_key_rotation: { status: "rekey_required", key_version: 3 },
    });
    expect(store.getDaemonRetirementSshMeshRekey("local", "daemon-b")).toMatchObject({
      status: "rekey_required",
      operationId: pending.operationId,
      replacementKeyVersion: null,
    });
    expect(store.getSshMeshOverview("local")).toMatchObject({
      enabled: false,
      key_version: 3,
      fingerprint: null,
      rotation_state: "rekey_required",
    });
  });

  it("rejects probes from a source that is not ready, is stale, is offline, or is rotating", async () => {
    const { app, runtimeA, daemonA } = await setupFleet();
    await enableMesh(app);
    const probe = () => app.request("/api/workspaces/local/ssh-mesh/test", {
      method: "POST",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ source_daemon_id: "daemon-a" }),
    });

    const notReady = await probe();
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toMatchObject({ code: "ssh_mesh_source_not_ready" });

    let config = await daemonConfig(app, runtimeA.id, daemonA.token);
    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(config));
    config = await daemonConfig(app, runtimeA.id, daemonA.token);
    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(config));
    db!.run(
      `UPDATE multiremi_daemon_ssh_mesh_states
       SET last_reported_at = '2000-01-01T00:00:00.000Z'
       WHERE workspace_id = 'local' AND daemon_id = 'daemon-a'`,
    );
    const stale = await probe();
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "ssh_mesh_source_stale" });

    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(config));
    db!.run(
      `UPDATE multiremi_runtimes
       SET status = 'online', last_heartbeat_at = '2000-01-01T00:00:00.000Z'
       WHERE workspace_id = 'local' AND daemon_id = 'daemon-a'`,
    );
    const offline = await probe();
    expect(offline.status).toBe(409);
    expect(await offline.json()).toMatchObject({ code: "ssh_mesh_source_offline" });

    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(config));
    const rotate = await app.request("/api/workspaces/local/ssh-mesh/rotate", {
      method: "POST",
      headers: { Authorization: `Bearer ${ROOT_TOKEN}` },
    });
    expect(rotate.status).toBe(200);
    const rotating = await probe();
    expect(rotating.status).toBe(409);
    expect(await rotating.json()).toMatchObject({ code: "ssh_mesh_rotation_in_progress" });
  });

  it("downgrades a ready daemon when its SSH protocol report is omitted or stale", async () => {
    const { store, app, runtimeA, daemonA } = await setupFleet();
    await enableMesh(app);
    const config = await daemonConfig(app, runtimeA.id, daemonA.token);
    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(config));
    const reconciledConfig = await daemonConfig(app, runtimeA.id, daemonA.token);
    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(reconciledConfig));
    expect(store.getSshMeshOverview("local").runtimes.find((runtime) => runtime.daemon_id === "daemon-a"))
      .toMatchObject({ status: "ready", protocol_version: 1 });

    const genericHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: runtimeA.id }),
    });
    expect(genericHeartbeat.status).toBe(200);
    expect(await genericHeartbeat.json()).not.toHaveProperty("ssh_mesh");
    expect(store.getSshMeshOverview("local").runtimes.find((runtime) => runtime.daemon_id === "daemon-a"))
      .toMatchObject({ status: "setup_required", protocol_version: 0 });

    await daemonHeartbeat(app, runtimeA.id, daemonA.token, readyStatusFor(reconciledConfig));
    db!.run(
      `UPDATE multiremi_daemon_ssh_mesh_states
       SET last_reported_at = '2000-01-01T00:00:00.000Z'
       WHERE workspace_id = 'local' AND daemon_id = 'daemon-a'`,
    );
    expect(store.getSshMeshOverview("local").runtimes.find((runtime) => runtime.daemon_id === "daemon-a"))
      .toMatchObject({ status: "setup_required", protocol_version: 1 });
  });

  it("includes workspace identity in deterministic SSH aliases", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const remote = store.createWorkspace({ id: "ssh-alias-remote", name: "SSH Alias Remote", slug: "ssh-alias-remote" });
    const localRuntime = store.registerRuntime({
      id: "rt-alias-local",
      name: "Alias local",
      provider: "codex",
      daemonId: "shared-daemon",
      workspaceId: "local",
    });
    const remoteRuntime = store.registerRuntime({
      id: "rt-alias-remote",
      name: "Alias remote",
      provider: "codex",
      daemonId: "shared-daemon",
      workspaceId: remote.id,
    });
    store.recordSshMeshHeartbeat(localRuntime.id, 1, { status: "ready", hostname: "shared-host" });
    store.recordSshMeshHeartbeat(remoteRuntime.id, 1, { status: "ready", hostname: "shared-host" });

    const localAlias = store.getSshMeshOverview("local").runtimes[0]?.ssh_alias;
    const remoteAlias = store.getSshMeshOverview(remote.id).runtimes[0]?.ssh_alias;
    expect(localAlias).toStartWith("remi-shared-host-");
    expect(remoteAlias).toStartWith("remi-shared-host-");
    expect(localAlias).not.toBe(remoteAlias);
  });

  it("requires daemon retirement and confirmed SSH cleanup before deleting a workspace", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const workspace = store.createWorkspace({
      id: "ssh-delete-guard",
      name: "SSH Delete Guard",
      slug: "ssh-delete-guard",
    });
    const runtime = store.registerRuntime({
      id: "rt-ssh-delete-guard",
      name: "Delete guard daemon",
      provider: "claude",
      daemonId: "daemon-delete-guard",
      workspaceId: workspace.id,
    });
    const daemon = await store.createAccessToken({
      name: "Delete guard daemon",
      type: "daemon",
      daemonId: "daemon-delete-guard",
      workspaceId: workspace.id,
      userId: "local",
    });
    const app = createMultiremiApp({ store, authToken: ROOT_TOKEN });
    const meshPath = `/api/workspaces/${workspace.id}/ssh-mesh`;

    expect((await app.request(meshPath, {
      method: "PUT",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ enabled: true }),
    })).status).toBe(200);
    const activeDelete = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ROOT_TOKEN}` },
    });
    expect(activeDelete.status).toBe(409);
    expect(await activeDelete.json()).toMatchObject({
      code: "daemon_retirement_required",
      daemon_ids: ["daemon-delete-guard"],
    });

    const disabled = await (await app.request(meshPath, {
      method: "PUT",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ enabled: false }),
    })).json() as any;
    await daemonHeartbeat(app, runtime.id, daemon.token, {
      status: "disabled",
      key_version: disabled.key_version,
      config_revision: disabled.config_revision,
      public_key_installed: false,
      config_installed: false,
    });
    const plan = store.getDaemonRetirementPlan(workspace.id, "daemon-delete-guard");
    const retired = await app.request("/api/multiremi/daemons/daemon-delete-guard/retire", {
      method: "POST",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ workspace_id: workspace.id, expected_snapshot: plan.snapshot }),
    });
    expect(retired.status).toBe(200);

    const cleanupRequired = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ROOT_TOKEN}` },
    });
    expect(cleanupRequired.status).toBe(409);
    expect(await cleanupRequired.json()).toMatchObject({
      code: "ssh_mesh_cleanup_required",
      ssh_mesh: { enabled: false, rotation_state: "rekey_required" },
    });

    expect((await app.request(meshPath, {
      method: "PUT",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ enabled: true }),
    })).status).toBe(200);
    expect((await app.request(meshPath, {
      method: "PUT",
      headers: rootJsonHeaders(),
      body: JSON.stringify({ enabled: false }),
    })).status).toBe(200);
    expect((await app.request(`/api/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ROOT_TOKEN}` },
    })).status).toBe(204);
    expect(store.getWorkspace(workspace.id)).toBeNull();
  });

  it("allows only human workspace owners and admins to delete workspaces", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const ownerWorkspace = store.createWorkspace({
      id: "delete-auth-owner",
      name: "Delete Auth Owner",
      slug: "delete-auth-owner",
    });
    store.createWorkspaceMember({
      id: "delete-auth-member",
      workspaceId: ownerWorkspace.id,
      userId: "delete-auth-member-user",
      name: "Delete Auth Member",
      role: "member",
    });
    const ownerToken = await store.createAccessToken({
      name: "Delete owner",
      type: "pat",
      workspaceId: ownerWorkspace.id,
      userId: "local",
    });
    const memberToken = await store.createAccessToken({
      name: "Delete member",
      type: "pat",
      workspaceId: ownerWorkspace.id,
      userId: "delete-auth-member-user",
    });
    const taskToken = await store.createTaskAccessToken({
      id: "tsk_delete_auth",
      agentId: "agt_delete_auth",
      workspaceId: ownerWorkspace.id,
    }, "local");
    const daemonToken = await store.createAccessToken({
      name: "Unbound delete daemon",
      type: "daemon",
      workspaceId: ownerWorkspace.id,
      userId: "local",
    });
    const app = createMultiremiApp({ store, authToken: ROOT_TOKEN });
    const removeAs = (token: string, workspaceId = ownerWorkspace.id) => app.request(
      `/api/workspaces/${workspaceId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );

    expect((await removeAs(memberToken.token)).status).toBe(403);
    const taskDenied = await removeAs(taskToken.token);
    expect(taskDenied.status).toBe(403);
    expect(await taskDenied.json()).toMatchObject({ code: "human_admin_required" });
    expect((await removeAs(daemonToken.token)).status).toBe(403);
    expect(store.getWorkspace(ownerWorkspace.id)).not.toBeNull();
    expect((await removeAs(ownerToken.token)).status).toBe(204);

    const adminWorkspace = store.createWorkspace({
      id: "delete-auth-admin",
      name: "Delete Auth Admin",
      slug: "delete-auth-admin",
    });
    store.createWorkspaceMember({
      id: "delete-auth-admin-member",
      workspaceId: adminWorkspace.id,
      userId: "delete-auth-admin-user",
      name: "Delete Auth Admin",
      role: "admin",
    });
    const adminToken = await store.createAccessToken({
      name: "Delete admin",
      type: "pat",
      workspaceId: adminWorkspace.id,
      userId: "delete-auth-admin-user",
    });
    expect((await removeAs(adminToken.token, adminWorkspace.id)).status).toBe(204);
  });
});

async function setupFleet() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const runtimeA = store.registerRuntime({
    id: "rt-ssh-a-claude",
    name: "Machine A / Claude",
    provider: "claude",
    daemonId: "daemon-a",
    workspaceId: "local",
  });
  const runtimeA2 = store.registerRuntime({
    id: "rt-ssh-a-codex",
    name: "Machine A / Codex",
    provider: "codex",
    daemonId: "daemon-a",
    workspaceId: "local",
  });
  const runtimeB = store.registerRuntime({
    id: "rt-ssh-b-claude",
    name: "Machine B / Claude",
    provider: "claude",
    daemonId: "daemon-b",
    workspaceId: "local",
  });
  const daemonA = await store.createAccessToken({
    name: "Daemon A",
    type: "daemon",
    daemonId: "daemon-a",
    workspaceId: "local",
    userId: "local",
  });
  const daemonB = await store.createAccessToken({
    name: "Daemon B",
    type: "daemon",
    daemonId: "daemon-b",
    workspaceId: "local",
    userId: "local",
  });
  return {
    store,
    app: createMultiremiApp({ store, authToken: ROOT_TOKEN }),
    runtimeA,
    runtimeA2,
    runtimeB,
    daemonA,
    daemonB,
  };
}

async function enableMesh(app: ReturnType<typeof createMultiremiApp>): Promise<void> {
  const response = await app.request("/api/workspaces/local/ssh-mesh", {
    method: "PUT",
    headers: rootJsonHeaders(),
    body: JSON.stringify({ enabled: true }),
  });
  expect(response.status).toBe(200);
}

async function daemonHeartbeat(
  app: ReturnType<typeof createMultiremiApp>,
  runtimeId: string,
  token: string,
  status: Record<string, unknown>,
): Promise<any> {
  const response = await app.request("/api/daemon/heartbeat", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runtime_id: runtimeId,
      ssh_mesh_protocol: 1,
      ssh_mesh_status: status,
    }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function daemonConfig(
  app: ReturnType<typeof createMultiremiApp>,
  runtimeId: string,
  token: string,
): Promise<any> {
  const response = await app.request(`/api/daemon/ssh-mesh/config?runtime_id=${runtimeId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

function readyStatusFor(config: any): Record<string, unknown> {
  return {
    status: "ready",
    key_version: config.key_version,
    config_revision: config.config_revision,
    probe_revision: config.probe_revision,
    public_key_installed: true,
    config_installed: true,
  };
}

function rootJsonHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ROOT_TOKEN}`, "Content-Type": "application/json" };
}
