// `multiremi config` persistence/redaction plus the launch, foreground-arg and
// launchd/systemd service specs the daemon installer emits.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  runMultiremi,
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
      daemon_id: "daemon-devbox",
    }, path);

    expect(loadMultiremiConfig(path)).toEqual({
      server_url: "https://example.test",
      workspace_id: "ws_1",
      token: "mul_secret",
      provider: "claude",
      daemon_id: "daemon-devbox",
    });
    expect(redactMultiremiConfig(loadMultiremiConfig(path))).toEqual({
      server_url: "https://example.test",
      workspace_id: "ws_1",
      token: "***",
      provider: "claude",
      daemon_id: "daemon-devbox",
    });
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
