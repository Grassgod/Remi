// `multiremi config` persistence/redaction plus the launch, foreground-arg and
// launchd/systemd service specs the daemon installer emits.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMultiremiConfig,
  redactMultiremiConfig,
  saveMultiremiConfig,
} from "@multiremi/config.js";
import {
  buildDaemonForegroundArgs,
  buildMultiremiDaemonLaunchSpec,
  buildMultiremiDaemonServiceSpec,
  multiremiDaemonPaths,
  multiremiDaemonServicePath,
  planDaemonRestart,
  planSpawnedSuccessorRestart,
  resolveDeviceName,
  resolveSetupConfig,
  runMultiremi,
  systemdUnitFromCgroup,
} from "../../../apps/remi/cli/multiremi.js";

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("Multiremi CLI — config file and daemon service specs", () => {
  test("saves, loads, and redacts local daemon config", () => {
    tmp = mkdtempSync(join(tmpdir(), "multiremi-config-"));
    const path = join(tmp, "config.json");

    saveMultiremiConfig({
      server_url: "https://example.test",
      workspace_id: "ws_1",
      token: "mul_secret",
      provider: "claude",
      device_name: "Owner Laptop",
      daemon_id: "daemon-devbox",
    }, path);

    expect(loadMultiremiConfig(path)).toEqual({
      server_url: "https://example.test",
      workspace_id: "ws_1",
      token: "mul_secret",
      provider: "claude",
      device_name: "Owner Laptop",
      daemon_id: "daemon-devbox",
    });
    expect(redactMultiremiConfig(loadMultiremiConfig(path))).toEqual({
      server_url: "https://example.test",
      workspace_id: "ws_1",
      token: "***",
      provider: "claude",
      device_name: "Owner Laptop",
      daemon_id: "daemon-devbox",
    });
  });

  test("resolves device names in CLI, environment, config, runtime-name, fallback order", () => {
    const environment = {
      MULTIREMI_DEVICE_NAME: "Environment Device",
      MULTIREMI_RUNTIME_NAME: undefined,
      USER: "runner",
    };
    const config = {
      device_name: "Config Device",
      runtime_name: "Config Runtime",
    };

    expect(resolveDeviceName({ "device-name": "CLI Device", name: "CLI Runtime" }, config, environment, "host"))
      .toBe("CLI Device");
    expect(resolveDeviceName({ deviceName: "Camel Device", name: "CLI Runtime" }, config, environment, "host"))
      .toBe("Camel Device");
    expect(resolveDeviceName({ name: "CLI Runtime" }, config, environment, "host"))
      .toBe("Environment Device");
    expect(resolveDeviceName({ name: "CLI Runtime" }, config, { ...environment, MULTIREMI_DEVICE_NAME: undefined }, "host"))
      .toBe("Config Device");
    expect(resolveDeviceName({ name: "CLI Runtime" }, {}, { ...environment, MULTIREMI_DEVICE_NAME: undefined }, "host"))
      .toBe("CLI Runtime");
    expect(resolveDeviceName({}, {}, { MULTIREMI_DEVICE_NAME: undefined, MULTIREMI_RUNTIME_NAME: undefined, USER: "runner" }, "host"))
      .toBe("host-runner");
  });

  test("pins an existing machine identity before adding a device name", () => {
    const next = resolveSetupConfig(
      { server_url: "https://example.test", workspace_id: "ws_1" },
      { "device-name": "New name" },
      { MULTIREMI_DEVICE_NAME: undefined, MULTIREMI_RUNTIME_NAME: undefined, USER: "runner" },
      "host",
    );

    expect(next.device_name).toBe("New name");
    expect(next.daemon_id).toBe("host-runner");
  });

  test("pins the pre-rename identity when the device name arrives via environment", () => {
    const next = resolveSetupConfig(
      { server_url: "https://example.test", workspace_id: "ws_1" },
      {},
      { MULTIREMI_DEVICE_NAME: "New name", MULTIREMI_RUNTIME_NAME: undefined, USER: "runner" },
      "host",
    );

    expect(next.device_name).toBe("New name");
    expect(next.daemon_id).toBe("host-runner");
  });

  test("keeps an explicit daemon id when adding a device name", () => {
    const next = resolveSetupConfig(
      {},
      { "device-name": "New name", "daemon-id": "dmn_x" },
      { MULTIREMI_DEVICE_NAME: undefined, MULTIREMI_RUNTIME_NAME: undefined, USER: "runner" },
      "host",
    );

    expect(next.device_name).toBe("New name");
    expect(next.daemon_id).toBe("dmn_x");
  });

  test("does not pin a daemon id when setup has no device name", () => {
    const next = resolveSetupConfig(
      {},
      {},
      { MULTIREMI_DEVICE_NAME: undefined, MULTIREMI_RUNTIME_NAME: undefined, USER: "runner" },
      "host",
    );

    expect(next).not.toHaveProperty("daemon_id");
  });

  test("preserves an existing daemon id when changing the device name", () => {
    const next = resolveSetupConfig(
      { daemon_id: "dmn_existing", device_name: "Old name" },
      { "device-name": "New name" },
      { MULTIREMI_DEVICE_NAME: undefined, MULTIREMI_RUNTIME_NAME: undefined, USER: "runner" },
      "host",
    );

    expect(next.device_name).toBe("New name");
    expect(next.daemon_id).toBe("dmn_existing");
  });

  test("shows setup help without creating or rewriting config", async () => {
    tmp = mkdtempSync(join(tmpdir(), "multiremi-setup-help-"));
    const configPath = join(tmp, "config.json");
    const previousConfigPath = process.env.MULTIREMI_CONFIG;
    const originalLog = console.log;
    const logs: string[] = [];
    try {
      process.env.MULTIREMI_CONFIG = configPath;
      console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };

      await runMultiremi(["setup", "--help"], { programName: "remi" });

      expect(existsSync(configPath)).toBeFalse();
      expect(logs.join("\n")).toContain("Usage: remi <command> [options]");

      const originalConfig = '{ "server_url": "https://example.test", "workspace_id": "ws_1" }\n';
      writeFileSync(configPath, originalConfig);
      await runMultiremi(["setup", "--help"], { programName: "remi" });
      expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    } finally {
      console.log = originalLog;
      if (previousConfigPath === undefined) delete process.env.MULTIREMI_CONFIG;
      else process.env.MULTIREMI_CONFIG = previousConfigPath;
    }
  });

  test("builds background daemon launch spec without leaking token in argv", () => {
    tmp = mkdtempSync(join(tmpdir(), "multiremi-daemon-launch-"));
    const previousStateDir = process.env.MULTIREMI_STATE_DIR;
    try {
      process.env.MULTIREMI_STATE_DIR = tmp;
      const spec = buildMultiremiDaemonLaunchSpec({
        server: "https://api.example.test",
        workspace: "ws_1",
        token: "mul_secret",
        provider: "claude",
        daemonId: "daemon-devbox",
        daemonPort: "6222",
        name: "devbox",
      }, "remi multiremi", ["/usr/bin/bun", "/repo/src/main.ts"], "/usr/bin/bun");

      expect(spec.command).toBe("/usr/bin/bun");
      expect(spec.args).toEqual([
        "/repo/src/main.ts",
        "multiremi",
        "daemon",
        "start",
        "--foreground",
        "--server",
        "https://api.example.test",
        "--workspace",
        "ws_1",
        "--provider",
        "claude",
        "--daemon-id",
        "daemon-devbox",
        "--daemon-port",
        "6222",
        "--name",
        "devbox",
      ]);
      expect(spec.args.join(" ")).not.toContain("mul_secret");
      expect(spec.env).toEqual({ MULTIREMI_TOKEN: "mul_secret" });
      expect(spec.port).toBe(6222);
      expect(spec.pidPath).toBe(join(tmp, "daemon.pid"));
      expect(spec.logPath).toBe(join(tmp, "daemon.log"));
    } finally {
      if (previousStateDir === undefined) delete process.env.MULTIREMI_STATE_DIR;
      else process.env.MULTIREMI_STATE_DIR = previousStateDir;
    }
  });

  test("normalizes daemon foreground args and state paths", () => {
    expect(buildDaemonForegroundArgs({
      "server-url": "https://api.example.test",
      "workspace-id": "ws_2",
      "runtime-id": "rt_1",
      "daemon-id": "daemon-local",
      "device-name": "Owner Laptop",
      "repo-cache-root": "/tmp/repos",
      token: "mul_secret",
    })).toEqual([
      "daemon",
      "start",
      "--foreground",
      "--server",
      "https://api.example.test",
      "--workspace",
      "ws_2",
      "--runtime-id",
      "rt_1",
      "--daemon-id",
      "daemon-local",
      "--repo-cache-root",
      "/tmp/repos",
      "--device-name",
      "Owner Laptop",
    ]);
    expect(multiremiDaemonPaths("/tmp/multiremi-state")).toEqual({
      stateDir: "/tmp/multiremi-state",
      pidPath: "/tmp/multiremi-state/daemon.pid",
      logPath: "/tmp/multiremi-state/daemon.log",
    });
  });

  test("builds launchd and systemd service files without leaking tokens in argv", () => {
    tmp = mkdtempSync(join(tmpdir(), "multiremi-service-spec-"));
    const previousStateDir = process.env.MULTIREMI_STATE_DIR;
    try {
      process.env.MULTIREMI_STATE_DIR = join(tmp, "state dir");
      const commonOptions = {
        server: "https://api.example.test",
        workspace: "ws_1",
        provider: "claude",
        daemonId: "daemon-devbox",
        daemonPort: "6222",
        name: "devbox",
      };

      const launchd = buildMultiremiDaemonServiceSpec(
        commonOptions,
        "remi multiremi",
        "launchd",
        join(tmp, "home"),
        ["/usr/bin/bun", "/repo/src/main.ts"],
        "/usr/bin/bun",
      );
      expect(launchd.path).toBe(join(tmp, "home", "Library", "LaunchAgents", "dev.remi.multiremi.daemon.plist"));
      expect(launchd.content).toContain("<key>ProgramArguments</key>");
      expect(launchd.content).toContain("<string>/usr/bin/bun</string>");
      expect(launchd.content).toContain("<string>/repo/src/main.ts</string>");
      expect(launchd.content).toContain("<string>daemon</string>");
      expect(launchd.content).toContain("<string>--daemon-id</string>");
      expect(launchd.content).toContain("<string>daemon-devbox</string>");
      expect(launchd.content).toContain("<key>MULTIREMI_STATE_DIR</key>");
      expect(launchd.content).not.toContain("mul_secret");

      const systemd = buildMultiremiDaemonServiceSpec(
        commonOptions,
        "remi multiremi",
        "systemd",
        join(tmp, "home"),
        ["/usr/bin/bun", "/repo/src/main.ts"],
        "/usr/bin/bun",
      );
      expect(systemd.path).toBe(join(tmp, "home", ".config", "systemd", "user", "multiremi-daemon.service"));
      expect(systemd.content).toContain("ExecStart=/usr/bin/bun /repo/src/main.ts multiremi daemon start --foreground");
      expect(systemd.content).toContain("--daemon-id daemon-devbox");
      expect(systemd.content).toContain('Environment="MULTIREMI_STATE_DIR=');
      expect(systemd.content).toContain("Restart=always");
      expect(systemd.content).not.toContain("mul_secret");
      expect(() => buildMultiremiDaemonServiceSpec(
        { ...commonOptions, token: "mul_secret" },
        "multiremi",
        "systemd",
        join(tmp!, "home"),
        ["/usr/bin/bun", "/repo/src/main.ts"],
        "/usr/bin/bun",
      )).toThrow("does not write tokens");
    } finally {
      if (previousStateDir === undefined) delete process.env.MULTIREMI_STATE_DIR;
      else process.env.MULTIREMI_STATE_DIR = previousStateDir;
    }
  });

  test("daemon service install writes a user service file", async () => {
    tmp = mkdtempSync(join(tmpdir(), "multiremi-service-install-"));
    const serviceDir = join(tmp, "services");
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      console.error = (value?: unknown) => { errors.push(String(value)); };

      await runMultiremi([
        "daemon",
        "service",
        "install",
        "--platform",
        "systemd",
        "--service-dir",
        serviceDir,
        "--server",
        "https://api.example.test",
        "--workspace",
        "ws_1",
        "--provider",
        "codex",
      ], { programName: "multiremi" });

      const servicePath = multiremiDaemonServicePath("systemd", tmp, serviceDir);
      expect(existsSync(servicePath)).toBeTrue();
      const service = readFileSync(servicePath, "utf8");
      expect(service).toContain("ExecStart=");
      expect(service).toContain("--provider codex");
      expect(service).not.toContain("MULTIREMI_TOKEN");
      expect(logs).toEqual([]);
      expect(errors[0]).toContain("Multiremi daemon service written:");
      expect(errors.join("\n")).toContain("systemctl --user daemon-reload");
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});

describe("Multiremi CLI — daemon restart handoff", () => {
  test("asks systemd to replace the unit instead of orphaning a successor", () => {
    // Under KillMode=control-group a detached successor dies with the main
    // process, and staying alive to dodge that leaks one supervisor per
    // upgrade. The manager has to own the replacement.
    const plan = planDaemonRestart({
      platform: "linux",
      env: { INVOCATION_ID: "abc123" },
      cgroup: "0::/user.slice/user-1001.slice/user@1001.service/app.slice/multiremi-daemon.service\n",
    });
    expect(plan).toEqual({
      kind: "service-manager",
      command: "systemctl",
      args: ["--user", "restart", "--no-block", "multiremi-daemon.service"],
    });
  });

  test("names the daemon unit, not the user manager, on a cgroup v1 host", () => {
    // Only name=systemd reaches the daemon unit; the controller lines above it
    // name user@1001.service, which `systemctl --user` cannot find.
    const plan = planDaemonRestart({
      platform: "linux",
      env: { INVOCATION_ID: "abc123" },
      cgroup: CGROUP_V1_HOST,
    });
    expect(plan).toEqual({
      kind: "service-manager",
      command: "systemctl",
      args: ["--user", "restart", "--no-block", "multiremi-daemon.service"],
    });
  });

  test("reads the unit only from the unified or name=systemd hierarchy", () => {
    expect(systemdUnitFromCgroup("0::/user.slice/user-1001.slice/user@1001.service/app.slice/multiremi-daemon.service\n"))
      .toBe("multiremi-daemon.service");
    expect(systemdUnitFromCgroup([
      "0::/",
      "1:name=systemd:/user.slice/user-1001.slice/user@1001.service/app.slice/renamed.service",
    ].join("\n"))).toBe("renamed.service");
    // Only controller hierarchies name a service: that is the user manager.
    expect(systemdUnitFromCgroup([
      "11:pids:/user.slice/user-1001.slice/user@1001.service",
      "10:memory:/user.slice/user-1001.slice/user@1001.service",
      "1:name=systemd:/user.slice/user-1001.slice/session-4.scope",
    ].join("\n"))).toBeNull();
    expect(systemdUnitFromCgroup(null)).toBeNull();
  });

  test("falls back to the default unit name without a usable cgroup", () => {
    const plan = planDaemonRestart({
      platform: "linux",
      env: { INVOCATION_ID: "abc123" },
      cgroup: "",
    });
    expect(plan).toEqual({
      kind: "service-manager",
      command: "systemctl",
      args: ["--user", "restart", "--no-block", "multiremi-daemon.service"],
    });
  });

  test("asks launchd to kickstart on macOS", () => {
    const plan = planDaemonRestart({
      platform: "darwin",
      env: { XPC_SERVICE_NAME: "dev.remi.multiremi.daemon" },
      uid: 501,
    });
    expect(plan).toEqual({
      kind: "service-manager",
      command: "launchctl",
      args: ["kickstart", "-k", "gui/501/dev.remi.multiremi.daemon"],
    });
  });

  test("spawns a successor when no service manager owns the process", () => {
    expect(planDaemonRestart({ platform: "linux", env: {} })).toEqual({ kind: "spawn-successor" });
    expect(planDaemonRestart({ platform: "darwin", env: {} })).toEqual({ kind: "spawn-successor" });
  });
});

describe("Multiremi CLI — spawned successor collapses its unit", () => {
  const DAEMON_ARGV = ["/usr/local/bin/remi", "multiremi", "daemon", "start", "--foreground"];
  // What the spawn fallback leaves in the unit: each successor is a child of
  // the daemon it replaced, back to the unit's main process.
  const CHAIN: Record<number, number> = { 1549685: 1427417, 1427417: 3192044, 3192044: 221547, 221547: 39871 };

  function successor(overrides: Partial<Parameters<typeof planSpawnedSuccessorRestart>[0]> = {}) {
    return planSpawnedSuccessorRestart({
      platform: "linux",
      env: { INVOCATION_ID: "abc123" },
      cgroup: CGROUP_V1_HOST,
      pid: 1549685,
      mainPid: () => 221547,
      parentPid: (pid) => CHAIN[pid] ?? null,
      commandLine: () => DAEMON_ARGV,
      activeSupervisorPids: () => [],
      ...overrides,
    });
  }

  test("restarts the unit when it runs beside an idle main daemon", () => {
    expect(successor()).toEqual({
      kind: "service-manager",
      unit: "multiremi-daemon.service",
      mainPid: 221547,
      command: "systemctl",
      args: ["--user", "restart", "--no-block", "multiremi-daemon.service"],
    });
    // Its own lease is not a reason to hold back.
    expect(successor({ activeSupervisorPids: () => [1549685] }).kind).toBe("service-manager");
  });

  test("does nothing once it is the unit's main process", () => {
    // The process systemd starts after the restart is MainPID, so this
    // cannot trigger a second restart.
    expect(successor({ mainPid: () => 1549685 })).toEqual({ kind: "none" });
    expect(successor({ mainPid: () => null })).toEqual({ kind: "none" });
  });

  test("does nothing outside a systemd unit", () => {
    expect(successor({ env: {} })).toEqual({ kind: "none" });
    expect(successor({ platform: "darwin" })).toEqual({ kind: "none" });
    expect(successor({ cgroup: null })).toEqual({ kind: "none" });
    expect(successor({ cgroup: "11:pids:/user.slice/user-1001.slice/user@1001.service\n" })).toEqual({ kind: "none" });
  });

  test("never restarts a unit for a daemon a task started", () => {
    // Task processes run inside the unit and inherit INVOCATION_ID. A daemon
    // started from a task shell with its own HOME sees none of the unit's
    // leases, so only its ancestry tells it apart from a spawned successor.
    const fromTask: Record<number, number> = { ...CHAIN, 1549685: 1538228, 1538228: 1531090, 1531090: 1427417 };
    const shell = (pid: number) => pid === 1538228 ? ["/bin/bash", "-c", "remi multiremi daemon start --foreground"] : DAEMON_ARGV;
    const plan = successor({ parentPid: (pid) => fromTask[pid] ?? null, commandLine: shell });
    expect(plan.kind).toBe("blocked");
    expect(plan.kind === "blocked" && plan.reason).toContain("not spawned by the unit's daemons");

    // `daemon start` without --foreground spawns the foreground child.
    const background = ["/usr/local/bin/remi", "multiremi", "daemon", "start"];
    expect(successor({ commandLine: (pid) => pid === 1427417 ? background : DAEMON_ARGV }).kind).toBe("blocked");
    // Orphaned into the service manager, or the parent is already gone.
    expect(successor({ parentPid: (pid) => pid === 1549685 ? 39871 : null }).kind).toBe("blocked");
    expect(successor({ parentPid: () => null }).kind).toBe("blocked");
  });

  test("never restarts a unit while another daemon owns a workspace", () => {
    // A daemon that still holds its lease may be running tasks.
    const plan = successor({ activeSupervisorPids: () => [1427417] });
    expect(plan.kind).toBe("blocked");
    expect(plan.kind === "blocked" && plan.reason).toContain("1427417");

    const unreadable = successor({ activeSupervisorPids: () => { throw new Error("EACCES"); } });
    expect(unreadable.kind).toBe("blocked");
  });

  test("never restarts a unit whose main process is not a daemon", () => {
    expect(successor({ commandLine: () => ["/usr/bin/tmux", "new-session", "-d"] }).kind).toBe("blocked");
    expect(successor({ commandLine: () => null }).kind).toBe("blocked");
  });
});

// /proc/self/cgroup of the daemon unit on n37-066-008, verbatim; n37-206-133
// has the same layout. Every controller hierarchy stops at the user manager.
const CGROUP_V1_HOST = [
  "11:memory:/user.slice/user-1001.slice/user@1001.service",
  "10:hugetlb:/",
  "9:freezer:/",
  "8:pids:/user.slice/user-1001.slice/user@1001.service",
  "7:blkio:/",
  "6:cpuset:/",
  "5:net_cls,net_prio:/",
  "4:devices:/user.slice",
  "3:cpu,cpuacct:/user.slice/user-1001.slice",
  "2:perf_event:/",
  "1:name=systemd:/user.slice/user-1001.slice/user@1001.service/app.slice/multiremi-daemon.service",
  "",
].join("\n");
