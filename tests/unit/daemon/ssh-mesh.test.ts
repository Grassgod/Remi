import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MultiremiDaemonSshMeshConfig,
  MultiremiSshMeshHeartbeatAck,
} from "@multiremi/contracts/types.js";
import {
  classifySshProbeFailure,
  defaultSshMeshPaths,
  discoverHostPublicKeys,
  replaceManagedBlock,
  SshMeshManager,
  sshMeshPathsForRoot,
  tryAcquireReconcileLock,
  type SshMeshCommandRunner,
  type SshMeshLocalIdentity,
} from "@daemon/ssh-mesh.js";

const roots: string[] = [];
const TEST_PUBLIC_KEY = `ssh-ed25519 ${"A".repeat(64)} mesh-test`;
const TEST_HOST_KEY = `ssh-ed25519 ${"B".repeat(64)}`;
const TEST_PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "ZmFrZS10ZXN0LWtleQ==",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("SSH Mesh file reconciliation", () => {
  it("installs a verified key and preserves user SSH files idempotently", async () => {
    const home = tempHome();
    chmodSync(home, 0o755);
    const paths = defaultSshMeshPaths("workspace-a", home);
    mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    writeFileSync(paths.sshConfig, "Host personal\n  HostName example.com\n", { mode: 0o600 });
    writeFileSync(paths.authorizedKeys, `ssh-ed25519 ${"C".repeat(64)} personal\n`, { mode: 0o600 });
    let fetches = 0;
    const commands: Array<{ executable: string; args: string[] }> = [];
    const manager = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      now: () => Date.parse("2026-08-18T01:00:00.000Z"),
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner(commands),
      getConfig: async () => {
        fetches++;
        return enabledConfig();
      },
    });

    await manager.reconcile(enabledDesired());

    expect(readFileSync(paths.privateKey, "utf8")).toBe(`${TEST_PRIVATE_KEY}\n`);
    expect(statSync(paths.privateKey).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o755);
    expect(readFileSync(paths.publicKey, "utf8")).toBe(`ssh-ed25519 ${"A".repeat(64)} mesh-test\n`);
    const authorized = readFileSync(paths.authorizedKeys, "utf8");
    expect(authorized).toContain(`ssh-ed25519 ${"C".repeat(64)} personal`);
    expect(authorized).toContain("no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519");
    expect(authorized.match(/>>> multiremi ssh mesh/g)).toHaveLength(1);
    const userConfig = readFileSync(paths.sshConfig, "utf8");
    expect(userConfig).toContain("Host personal");
    expect(userConfig).toContain("Include \"");
    expect(userConfig.startsWith("# >>> multiremi ssh mesh >>>\n")).toBe(true);
    expect(userConfig.match(/>>> multiremi ssh mesh/g)).toHaveLength(1);
    expect(readFileSync(paths.config, "utf8")).toContain("Host remi-target");
    expect(readFileSync(paths.config, "utf8")).toContain("StrictHostKeyChecking yes");
    expect(readFileSync(paths.knownHosts, "utf8")).toContain(`remi-target,10.37.66.8,target-host ${TEST_HOST_KEY}`);
    expect(commands.filter((command) => command.executable === "ssh")).toHaveLength(1);
    if (Bun.which("ssh")) {
      const parsed = Bun.spawnSync(["ssh", "-G", "-F", paths.sshConfig, "remi-target"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(parsed.exitCode).toBe(0);
      const resolved = parsed.stdout.toString().toLowerCase();
      expect(resolved).toContain("hostname 10.37.66.8");
      expect(resolved).toContain("stricthostkeychecking true");
    }
    expect(manager.getHeartbeatStatus()).toMatchObject({
      status: "ready",
      key_version: 1,
      config_revision: "rev-1",
      probe_revision: 1,
      public_key_installed: true,
      config_installed: true,
      peers: [{ daemon_id: "daemon-target", status: "ready" }],
    });

    const keyInode = statSync(paths.privateKey).ino;
    await manager.reconcile(enabledDesired());
    expect(statSync(paths.privateKey).ino).toBe(keyInode);
    const before = snapshotFiles(paths);
    await manager.reconcile({ ...enabledDesired(), needs_sync: false, needs_probe: false });
    expect(snapshotFiles(paths)).toEqual(before);
    expect(fetches).toBe(2);
  });

  it("repairs missing, modified and incorrectly permissioned managed files", async () => {
    const home = tempHome();
    const paths = defaultSshMeshPaths("workspace-a", home);
    let fetches = 0;
    const manager = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner([]),
      getConfig: async () => {
        fetches++;
        return enabledConfig();
      },
    });
    await manager.reconcile(enabledDesired());

    unlinkSync(paths.knownHosts);
    writeFileSync(paths.configInclude, "broken include\n", { mode: 0o600 });
    writeFileSync(paths.authorizedKeys, `ssh-ed25519 ${"C".repeat(64)} personal\n`, { mode: 0o600 });
    chmodSync(paths.privateKey, 0o644);

    await manager.reconcile({ ...enabledDesired(), needs_sync: false, needs_probe: false });

    expect(fetches).toBe(2);
    expect(manager.getHeartbeatStatus().status).toBe("ready");
    expect(statSync(paths.privateKey).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.knownHosts, "utf8")).toContain("remi-target");
    expect(readFileSync(paths.configInclude, "utf8")).toContain("Generated by Multiremi");
    const authorized = readFileSync(paths.authorizedKeys, "utf8");
    expect(authorized).toContain(`ssh-ed25519 ${"C".repeat(64)} personal`);
    expect(authorized.match(/>>> multiremi ssh mesh/g)).toHaveLength(1);
    const state = readFileSync(paths.stateFile, "utf8");
    expect(state).toContain('"fileDigests"');
    expect(state).not.toContain(TEST_PRIVATE_KEY);
  });

  it("requires a private local address instead of advertising a public fallback", async () => {
    const home = tempHome();
    const paths = defaultSshMeshPaths("workspace-a", home);
    const manager = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      discoverIdentity: async () => ({ ...localIdentity(), addresses: ["203.0.113.8"] }),
      commandRunner: fakeRunner([]),
      getConfig: async () => enabledConfig(),
    });

    await manager.reconcile(enabledDesired());

    expect(existsSync(paths.privateKey)).toBe(false);
    expect(manager.getHeartbeatStatus()).toMatchObject({
      status: "setup_required",
      addresses: [],
      last_error_code: "ssh_mesh_private_address_missing",
    });
  });

  it("does not connect to a peer through a public address or hostname fallback", async () => {
    const home = tempHome();
    const paths = defaultSshMeshPaths("workspace-a", home);
    const config = enabledConfig();
    config.hosts[0] = {
      ...config.hosts[0]!,
      addresses: ["203.0.113.9"],
      hostname: "public.example.com",
    };
    const manager = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner([]),
      getConfig: async () => config,
    });

    await manager.reconcile(enabledDesired());

    const rendered = readFileSync(paths.config, "utf8");
    expect(rendered).not.toContain("203.0.113.9");
    expect(rendered).not.toContain("public.example.com");
    expect(manager.getHeartbeatStatus()).toMatchObject({
      status: "ready",
      peers: [{ daemon_id: "daemon-target", error_code: "ssh_peer_config_incomplete" }],
    });
  });

  it("rejects a symlink before writing any managed key material", async () => {
    const home = tempHome();
    const paths = defaultSshMeshPaths("workspace-a", home);
    mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    const victim = join(home, "victim-config");
    writeFileSync(victim, "do-not-touch\n");
    symlinkSync(victim, paths.sshConfig);
    const manager = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner([]),
      getConfig: async () => enabledConfig(),
    });

    await manager.reconcile(enabledDesired());

    expect(readFileSync(victim, "utf8")).toBe("do-not-touch\n");
    expect(existsSync(paths.privateKey)).toBe(false);
    expect(manager.getHeartbeatStatus()).toMatchObject({
      status: "blocked",
      last_error_code: "ssh_mesh_unsafe_path",
    });
  });

  it("rejects a mismatched public/private pair without installing the private key", async () => {
    const home = tempHome();
    const paths = defaultSshMeshPaths("workspace-a", home);
    const manager = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      discoverIdentity: async () => localIdentity(),
      commandRunner: async (executable) => executable === "ssh-keygen"
        ? { exitCode: 0, stdout: `ssh-ed25519 ${"D".repeat(64)}\n`, stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" },
      getConfig: async () => enabledConfig(),
    });

    await manager.reconcile(enabledDesired());

    expect(existsSync(paths.privateKey)).toBe(false);
    expect(manager.getHeartbeatStatus()).toMatchObject({
      status: "blocked",
      last_error_code: "ssh_mesh_key_pair_mismatch",
    });
  });

  it("uses a shared lock so co-resident provider workers do not fetch or probe twice", async () => {
    const home = tempHome();
    const paths = defaultSshMeshPaths("workspace-a", home);
    let fetches = 0;
    let releaseFetch!: () => void;
    const blocked = new Promise<void>((resolveBlocked) => { releaseFetch = resolveBlocked; });
    const options = {
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner([]),
      getConfig: async () => {
        fetches++;
        await blocked;
        return enabledConfig();
      },
    };
    const claudeWorker = new SshMeshManager(options);
    const codexWorker = new SshMeshManager(options);

    const first = claudeWorker.reconcile(enabledDesired());
    await Bun.sleep(5);
    const second = codexWorker.reconcile(enabledDesired());
    await second;
    releaseFetch();
    await first;

    expect(fetches).toBe(1);
    expect(claudeWorker.getHeartbeatStatus().status).toBe("ready");
    expect(codexWorker.getHeartbeatStatus().status).toBe("ready");
  });

  it("does not let a stale owner's release delete a replacement lease", () => {
    const home = tempHome();
    const lockPath = join(home, ".multiremi", "ssh", "lease-test.lock");
    const ownerA = tryAcquireReconcileLock(lockPath);
    expect(ownerA).not.toBeNull();

    const ownerB = tryAcquireReconcileLock(lockPath, Date.now() + 3 * 60_000);
    expect(ownerB).not.toBeNull();
    ownerA!.release();

    expect(() => ownerB!.assertOwner()).not.toThrow();
    expect(tryAcquireReconcileLock(lockPath)).toBeNull();
    ownerB!.release();

    const ownerC = tryAcquireReconcileLock(lockPath);
    expect(ownerC).not.toBeNull();
    ownerC!.release();
  });

  it("fences a stale enabled reconciler before it can overwrite a replacement generation", async () => {
    const home = tempHome();
    const paths = defaultSshMeshPaths("workspace-a", home);
    const clock = Date.now();
    let releaseValidation!: () => void;
    let validationStarted!: () => void;
    const blockedValidation = new Promise<void>((resolveValidation) => { releaseValidation = resolveValidation; });
    const validationEntered = new Promise<void>((resolveEntered) => { validationStarted = resolveEntered; });
    const configA = enabledConfig();
    const configB = enabledConfig();
    configB.config_revision = "rev-2";
    configB.probe_revision = 2;
    configB.hosts[0] = {
      ...configB.hosts[0]!,
      alias: "remi-new-generation",
      addresses: ["10.37.222.202"],
    };
    const managerA = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      now: () => clock,
      discoverIdentity: async () => localIdentity(),
      commandRunner: async (executable) => {
        if (executable === "ssh-keygen") {
          validationStarted();
          await blockedValidation;
          return { exitCode: 0, stdout: `${TEST_PUBLIC_KEY}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      getConfig: async () => configA,
    });
    const managerB = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      now: () => clock + 3 * 60_000,
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner([]),
      getConfig: async () => configB,
    });

    const staleRun = managerA.reconcile(enabledDesired());
    await validationEntered;
    await managerB.reconcile({
      ...enabledDesired(),
      config_revision: "rev-2",
      probe_revision: 2,
    });
    releaseValidation();
    await staleRun;

    const rendered = readFileSync(paths.config, "utf8");
    expect(rendered).toContain("Host remi-new-generation");
    expect(rendered).not.toContain("Host remi-target\n");
    expect(JSON.parse(readFileSync(paths.stateFile, "utf8"))).toMatchObject({
      status: "ready",
      configRevision: "rev-2",
      lastErrorCode: null,
    });
    expect(managerA.getHeartbeatStatus()).toMatchObject({ status: "ready", config_revision: "rev-2" });
  });

  it("fences retirement cleanup that loses its workspace lease while waiting for the shared lock", async () => {
    const home = tempHome();
    const paths = defaultSshMeshPaths("workspace-a", home);
    const manager = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner([]),
      getConfig: async () => enabledConfig(),
    });
    await manager.reconcile(enabledDesired());
    const sharedBlocker = tryAcquireReconcileLock(paths.sharedFilesLockDirectory);
    expect(sharedBlocker).not.toBeNull();

    const cleanupResult = manager.cleanupForRetirement().then(
      () => null,
      (error: unknown) => error,
    );
    await waitForActiveLease(paths.lockDirectory);
    const replacement = tryAcquireReconcileLock(paths.lockDirectory, Date.now() + 3 * 60_000);
    expect(replacement).not.toBeNull();
    sharedBlocker!.release();

    const cleanupError = await cleanupResult;
    expect(cleanupError).toMatchObject({ code: "ssh_mesh_lock_lost" });
    expect(existsSync(paths.privateKey)).toBe(true);
    expect(existsSync(paths.config)).toBe(true);
    expect(readFileSync(paths.authorizedKeys, "utf8")).toContain(">>> multiremi ssh mesh");
    replacement!.release();
  });

  it("bounds a hung config fetch and releases the reconciliation lease for retry", async () => {
    const home = tempHome();
    const paths = defaultSshMeshPaths("workspace-a", home);
    let fetchSignal: AbortSignal | null = null;
    let fetchReleased = false;
    const manager = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      configFetchTimeoutMs: 20,
      retryDelaysMs: [1],
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner([]),
      getConfig: async (signal) => {
        if (!signal) throw new Error("missing config fetch abort signal");
        fetchSignal = signal;
        return await new Promise<MultiremiDaemonSshMeshConfig>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            fetchReleased = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    });
    const startedAt = Date.now();

    await manager.reconcile(enabledDesired());

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(manager.getHeartbeatStatus()).toMatchObject({
      status: "error",
      last_error_code: "ssh_mesh_config_timeout",
    });
    expect(fetchSignal).not.toBeNull();
    expect(fetchSignal!.aborted).toBe(true);
    expect(fetchReleased).toBe(true);
    const retryOwner = tryAcquireReconcileLock(paths.lockDirectory);
    expect(retryOwner).not.toBeNull();
    retryOwner!.release();
  });

  it("serializes shared SSH file updates across workspaces without losing either block", async () => {
    const home = tempHome();
    const pathsA = defaultSshMeshPaths("workspace-a", home);
    const pathsB = defaultSshMeshPaths("workspace-b", home);
    mkdirSync(pathsA.meshRoot, { recursive: true, mode: 0o700 });
    mkdirSync(pathsA.sharedFilesLockDirectory, { mode: 0o700 });
    let fetches = 0;
    const common = {
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner([]),
      getConfig: async () => {
        fetches++;
        return enabledConfig();
      },
    };
    const managerA = new SshMeshManager({
      ...common,
      workspaceId: "workspace-a",
      daemonId: "daemon-a",
      paths: pathsA,
    });
    const managerB = new SshMeshManager({
      ...common,
      workspaceId: "workspace-b",
      daemonId: "daemon-b",
      paths: pathsB,
    });

    const reconciles = Promise.all([
      managerA.reconcile(enabledDesired()),
      managerB.reconcile(enabledDesired()),
    ]);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (existsSync(pathsA.privateKey) && existsSync(pathsB.privateKey)) break;
      await Bun.sleep(5);
    }
    expect(existsSync(pathsA.privateKey)).toBe(true);
    expect(existsSync(pathsB.privateKey)).toBe(true);
    expect(existsSync(pathsA.authorizedKeys)).toBe(false);
    rmdirSync(pathsA.sharedFilesLockDirectory);
    await reconciles;

    const authorized = readFileSync(pathsA.authorizedKeys, "utf8");
    expect(authorized.match(/^# >>> multiremi ssh mesh [a-f0-9]+ >>>$/gm)).toHaveLength(2);
    expect(readFileSync(pathsA.sshConfig, "utf8").match(/>>> multiremi ssh mesh >>>/g)).toHaveLength(1);

    const noChanges = { ...enabledDesired(), needs_sync: false, needs_probe: false };
    await managerA.reconcile(noChanges);
    await managerB.reconcile(noChanges);
    expect(fetches).toBe(3);
    expect(readFileSync(pathsA.authorizedKeys, "utf8")).toBe(authorized);
  });

  it("backs off transient config failures and retries on a later heartbeat", async () => {
    const home = tempHome();
    let now = Date.parse("2026-08-18T01:00:00.000Z");
    let fetches = 0;
    const manager = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths: defaultSshMeshPaths("workspace-a", home),
      now: () => now,
      retryDelaysMs: [100],
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner([]),
      getConfig: async () => {
        fetches++;
        if (fetches === 1) throw new Error(`private material must never appear: ${TEST_PRIVATE_KEY}`);
        return enabledConfig();
      },
    });

    await manager.reconcile(enabledDesired());
    expect(manager.getHeartbeatStatus()).toMatchObject({
      status: "error",
      last_error_code: "ssh_mesh_sync_failed",
      last_error: "SSH Mesh synchronization failed",
    });
    await manager.reconcile(enabledDesired());
    expect(fetches).toBe(1);
    now += 100;
    await manager.reconcile(enabledDesired());
    expect(fetches).toBe(2);
    expect(manager.getHeartbeatStatus().status).toBe("ready");
    expect(readFileSync(defaultSshMeshPaths("workspace-a", home).stateFile, "utf8")).not.toContain(TEST_PRIVATE_KEY);
  });

  it("disables only the workspace-managed authorization and removes its secret", async () => {
    const home = tempHome();
    const paths = defaultSshMeshPaths("workspace-a", home);
    mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    writeFileSync(paths.authorizedKeys, `ssh-ed25519 ${"C".repeat(64)} personal\n`, { mode: 0o600 });
    let config = enabledConfig();
    const manager = new SshMeshManager({
      workspaceId: "workspace-a",
      daemonId: "daemon-source",
      paths,
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner([]),
      getConfig: async () => config,
    });
    await manager.reconcile(enabledDesired());
    config = { ...config, enabled: false, config_revision: "rev-2", probe_revision: 2 };

    await manager.reconcile({
      ...enabledDesired(),
      enabled: false,
      config_revision: "rev-2",
      probe_revision: 2,
      needs_sync: true,
      needs_probe: false,
    });

    expect(readFileSync(paths.authorizedKeys, "utf8")).toBe(`ssh-ed25519 ${"C".repeat(64)} personal\n`);
    expect(existsSync(paths.privateKey)).toBe(false);
    expect(existsSync(paths.configInclude)).toBe(false);
    expect(manager.getHeartbeatStatus()).toMatchObject({ status: "disabled", config_revision: "rev-2" });
  });

  it("cleans a retired workspace idempotently without touching another workspace or user keys", async () => {
    const home = tempHome();
    const pathsA = defaultSshMeshPaths("workspace-a", home);
    const pathsB = defaultSshMeshPaths("workspace-b", home);
    mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    writeFileSync(pathsA.authorizedKeys, `ssh-ed25519 ${"C".repeat(64)} personal\n`, { mode: 0o600 });
    const common = {
      discoverIdentity: async () => localIdentity(),
      commandRunner: fakeRunner([]),
      getConfig: async () => enabledConfig(),
    };
    const managerA = new SshMeshManager({
      ...common,
      workspaceId: "workspace-a",
      daemonId: "daemon-a",
      paths: pathsA,
    });
    const managerB = new SshMeshManager({
      ...common,
      workspaceId: "workspace-b",
      daemonId: "daemon-b",
      paths: pathsB,
    });
    await managerA.reconcile(enabledDesired());
    await managerB.reconcile(enabledDesired());

    await managerA.cleanupForRetirement();
    await managerA.cleanupForRetirement();

    expect(existsSync(pathsA.privateKey)).toBe(false);
    expect(existsSync(pathsA.publicKey)).toBe(false);
    expect(existsSync(pathsA.config)).toBe(false);
    expect(existsSync(pathsA.knownHosts)).toBe(false);
    expect(existsSync(pathsA.configInclude)).toBe(false);
    expect(existsSync(pathsB.privateKey)).toBe(true);
    expect(existsSync(pathsB.configInclude)).toBe(true);
    const authorized = readFileSync(pathsA.authorizedKeys, "utf8");
    expect(authorized).toContain(`ssh-ed25519 ${"C".repeat(64)} personal`);
    expect(authorized.match(/^# >>> multiremi ssh mesh [a-f0-9]+ >>>$/gm)).toHaveLength(1);
    expect(managerA.getHeartbeatStatus()).toMatchObject({
      status: "disabled",
      public_key_installed: false,
      config_installed: false,
    });
  });
});

describe("SSH Mesh helpers", () => {
  it("discovers standard host public-key files while rejecting unsafe entries", () => {
    const root = tempHome();
    const ecdsaHostKey = `ecdsa-sha2-nistp256 ${"E".repeat(64)}`;
    writeFileSync(join(root, "ssh_host_ecdsa_key.pub"), `${ecdsaHostKey} runtime-host\r\n`);
    writeFileSync(join(root, "ssh_host_ed25519_key.pub"), `${TEST_HOST_KEY} runtime-host\n`);
    writeFileSync(
      join(root, "ssh_host_rsa_key.pub"),
      `ssh-rsa ${"C".repeat(64)}\nssh-ed25519 ${"D".repeat(64)}\n`,
    );
    symlinkSync(join(root, "ssh_host_ed25519_key.pub"), join(root, "ssh_host_link_key.pub"));

    expect(discoverHostPublicKeys(root).sort()).toEqual([ecdsaHostKey, TEST_HOST_KEY].sort());
  });

  it("derives a traversal-safe workspace path without storing the raw id in a directory name", () => {
    const home = tempHome();
    const paths = defaultSshMeshPaths("../../other workspace", home);
    expect(paths.workspaceRoot.startsWith(home)).toBe(true);
    expect(paths.workspaceRoot).not.toContain("other workspace");
    expect(paths.workspaceRoot).not.toContain("..");
  });

  it("keeps service Mesh state under a stable root and OpenSSH integration in the user home", () => {
    const home = tempHome();
    const stableRoot = join(home, "Services", "remi-platform", "ssh-mesh");
    const paths = sshMeshPathsForRoot("workspace-a", stableRoot, home);

    expect(paths.meshRoot).toBe(stableRoot);
    expect(paths.workspaceRoot.startsWith(join(stableRoot, "workspaces"))).toBe(true);
    expect(paths.privateKey.startsWith(stableRoot)).toBe(true);
    expect(paths.stateFile.startsWith(stableRoot)).toBe(true);
    expect(paths.configInclude.startsWith(join(stableRoot, "config.d"))).toBe(true);
    expect(paths.sshConfig).toBe(join(home, ".ssh", "config"));
    expect(paths.authorizedKeys).toBe(join(home, ".ssh", "authorized_keys"));
  });

  it("updates and removes a single managed block while preserving surrounding content", () => {
    const original = "before\n# start\nold\n# end\nafter\n";
    const updated = replaceManagedBlock(original, "# start", "# end", "new");
    expect(updated).toBe("before\n# start\nnew\n# end\nafter\n");
    expect(replaceManagedBlock(updated, "# start", "# end", "new")).toBe(updated);
    expect(replaceManagedBlock(updated, "# start", "# end", null)).toBe("before\nafter\n");
    expect(() => replaceManagedBlock("# start\nunterminated\n", "# start", "# end", "x")).toThrow(/malformed/);
  });

  it("classifies unreachable, host-key and authentication failures", () => {
    expect(classifySshProbeFailure({ exitCode: 255, stdout: "", stderr: "Connection timed out" }).status).toBe("unreachable");
    expect(classifySshProbeFailure({ exitCode: 255, stdout: "", stderr: "Host key verification failed." }).status).toBe("host_key_mismatch");
    expect(classifySshProbeFailure({ exitCode: 255, stdout: "", stderr: "Permission denied (publickey)." }).status).toBe("auth_failed");
  });
});

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "ssh-mesh-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function localIdentity(): SshMeshLocalIdentity {
  return {
    sshUser: "hehuajie",
    hostname: "source-host",
    port: 22,
    addresses: ["10.37.206.133"],
    hostKeys: [TEST_HOST_KEY],
    sshdListening: true,
  };
}

function enabledDesired(): MultiremiSshMeshHeartbeatAck {
  return {
    enabled: true,
    key_version: 1,
    config_revision: "rev-1",
    needs_sync: true,
    rotation_state: "stable",
    probe_revision: 1,
    needs_probe: true,
  };
}

function enabledConfig(): MultiremiDaemonSshMeshConfig {
  return {
    protocol_version: 1,
    enabled: true,
    key_version: 1,
    config_revision: "rev-1",
    rotation_state: "stable",
    probe_revision: 1,
    probe_target_daemon_ids: [],
    private_key: TEST_PRIVATE_KEY,
    public_key: TEST_PUBLIC_KEY,
    authorized_public_keys: [TEST_PUBLIC_KEY],
    hosts: [{
      daemon_id: "daemon-target",
      alias: "remi-target",
      hostname: "target-host",
      ssh_user: "hehuajie",
      port: 22,
      addresses: ["10.37.66.8"],
      host_keys: [TEST_HOST_KEY],
    }],
  };
}

function fakeRunner(commands: Array<{ executable: string; args: string[] }>): SshMeshCommandRunner {
  return async (executable, args) => {
    commands.push({ executable, args });
    if (executable === "ssh-keygen") return { exitCode: 0, stdout: `${TEST_PUBLIC_KEY}\n`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function snapshotFiles(paths: ReturnType<typeof defaultSshMeshPaths>): Record<string, string> {
  return Object.fromEntries([
    paths.privateKey,
    paths.publicKey,
    paths.config,
    paths.knownHosts,
    paths.stateFile,
    paths.configInclude,
    paths.sshConfig,
    paths.authorizedKeys,
  ].map((path) => [path, existsSync(path) ? readFileSync(path, "utf8") : "<missing>"]));
}

async function waitForActiveLease(lockPath: string): Promise<void> {
  const ownerPath = join(lockPath, "owner.json");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(ownerPath)) {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { released?: boolean };
      if (owner.released === false) return;
    }
    await Bun.sleep(5);
  }
  throw new Error("SSH Mesh lease did not become active");
}
