/**
 * `remi` CLI entrypoint — the single-file binary that connects a machine to the
 * server and runs agent tasks over HTTP. Built via
 * `bun build src/remi-cli.ts --compile --define REMI_VERSION='"…"' --outfile remi`.
 *
 * Subcommands:
 *   remi setup self-host --server-url <url> --app-url <url> --workspace-id <id> [--token <mul_…>] [--start]
 *   remi login --token <mul_…>          store the PAT
 *   remi config set <key> <value>       set server_url / workspace_id / token
 *   remi config get                     print config (token redacted)
 *   remi daemon start [--foreground]    run the remote loop (background by default)
 *   remi daemon stop|status|restart|logs
 *   remi --version | version            print the CLI version
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  configDir,
  configPath,
  daemonLogPath,
  daemonPidPath,
  loadConfig,
  saveConfig,
  type RemiConfig,
} from "./daemon/config.js";
import { runRemoteDaemon } from "./daemon/remote.js";
import { remiVersion } from "./daemon/version.js";

const CONFIG_KEYS = ["server_url", "app_url", "workspace_id", "token"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

/** Read `--token <v>` / `--token=v` from args; "" when the flag is absent. */
function flagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === name) return args[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function redactConfig(cfg: RemiConfig): RemiConfig {
  return { ...cfg, token: cfg.token ? "***" : undefined };
}

function pidFilePid(): number | null {
  try {
    const raw = readFileSync(daemonPidPath(), "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function selfCommand(): { cmd: string; args: string[] } {
  const script = process.argv[1];
  if (script && /(?:^|[/\\])remi-cli\.tsx?$/.test(script)) {
    return { cmd: process.execPath, args: [script] };
  }
  return { cmd: process.execPath, args: [] };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilStopped(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

function printSetupNextSteps(cfg: RemiConfig): void {
  console.log(`Config saved to ${configPath()}`);
  if (!cfg.token) {
    console.log("Token is not set. Create a personal access token in the web app, then run:");
    console.log("  remi login --token <mul_...>");
  }
  if (!cfg.workspace_id) {
    console.log("Workspace is not set. Run:");
    console.log("  remi config set workspace_id <workspace-id>");
  }
  if (cfg.server_url && cfg.workspace_id && cfg.token) {
    console.log("Ready. Start the daemon with:");
    console.log("  remi daemon start");
  }
}

async function cmdSetup(args: string[]): Promise<void> {
  let rest = args;
  const mode = rest[0] && !rest[0]!.startsWith("--") ? rest[0] : "self-host";
  if (mode !== "self-host" && mode !== "cloud") {
    die("usage: remi setup [self-host] --server-url <url> --app-url <url> --workspace-id <id> [--token <mul_…>] [--start]");
  }
  if (rest[0] === mode) rest = rest.slice(1);

  const cfg = loadConfig();
  const serverUrl = flagValue(rest, "--server-url") ?? flagValue(rest, "--server") ?? cfg.server_url;
  const appUrl = flagValue(rest, "--app-url") ?? flagValue(rest, "--app") ?? cfg.app_url;
  const workspaceId = flagValue(rest, "--workspace-id") ?? flagValue(rest, "--workspace") ?? cfg.workspace_id;
  const token = flagValue(rest, "--token") ?? cfg.token;

  if (!serverUrl && mode === "self-host") {
    die("server_url is required — run `remi setup self-host --server-url <url> --app-url <url> --workspace-id <id>`");
  }

  const next: RemiConfig = { ...cfg };
  if (serverUrl) next.server_url = serverUrl.trim().replace(/\/+$/, "");
  if (appUrl) next.app_url = appUrl.trim().replace(/\/+$/, "");
  if (workspaceId) next.workspace_id = workspaceId.trim();
  if (token) next.token = token.trim();
  saveConfig(next);
  printSetupNextSteps(next);

  if (hasFlag(rest, "--start")) {
    if (!next.server_url || !next.workspace_id || !next.token) {
      die("--start requires server_url, workspace_id, and token");
    }
    await cmdDaemon(["start"]);
  }
}

function cmdLogin(args: string[]): void {
  const token = flagValue(args, "--token");
  if (!token) die("usage: remi login --token <mul_…>");
  const cfg = loadConfig();
  cfg.token = token.trim();
  saveConfig(cfg);
  console.log(`Token saved to ${configPath()}`);
}

function cmdConfig(args: string[]): void {
  const sub = args[0];
  if (sub === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) die("usage: remi config set <key> <value>");
    if (!CONFIG_KEYS.includes(key as ConfigKey)) {
      die(`unknown config key '${key}' (one of: ${CONFIG_KEYS.join(", ")})`);
    }
    const cfg = loadConfig();
    (cfg as Record<string, string>)[key] = value.trim();
    saveConfig(cfg);
    console.log(`${key} set`);
    return;
  }
  if (sub === "get" || sub === undefined) {
    const cfg = loadConfig();
    console.log(JSON.stringify(redactConfig(cfg), null, 2));
    return;
  }
  die("usage: remi config set <key> <value> | remi config get");
}

async function startDaemonBackground(): Promise<void> {
  const existingPid = pidFilePid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`remi daemon already running (pid ${existingPid})`);
    return;
  }
  if (existingPid) rmSync(daemonPidPath(), { force: true });

  mkdirSync(configDir(), { recursive: true });
  const logFd = openSync(daemonLogPath(), "a");
  const { cmd, args } = selfCommand();
  const child = spawn(cmd, [...args, "daemon", "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  closeSync(logFd);
  if (!child.pid) die("failed to start daemon");
  writeFileSync(daemonPidPath(), `${child.pid}\n`, { mode: 0o644 });
  console.log(`remi daemon started (pid ${child.pid})`);
  console.log(`log: ${daemonLogPath()}`);
}

async function stopDaemon(): Promise<void> {
  const pid = pidFilePid();
  if (!pid) {
    console.log("remi daemon is not running (no pid file)");
    return;
  }
  if (!isProcessAlive(pid)) {
    rmSync(daemonPidPath(), { force: true });
    console.log("remi daemon is not running");
    return;
  }
  process.kill(pid, "SIGTERM");
  const stopped = await waitUntilStopped(pid);
  if (!stopped) die(`failed to stop daemon pid ${pid}`);
  rmSync(daemonPidPath(), { force: true });
  console.log("remi daemon stopped");
}

function showDaemonStatus(): void {
  const pid = pidFilePid();
  const running = pid != null && isProcessAlive(pid);
  console.log(running ? `remi daemon running (pid ${pid})` : "remi daemon stopped");
  console.log(`config: ${configPath()}`);
  console.log(`log: ${daemonLogPath()}`);
  console.log(JSON.stringify(redactConfig(loadConfig()), null, 2));
  if (!running) process.exitCode = 1;
}

async function showDaemonLogs(args: string[]): Promise<void> {
  const file = daemonLogPath();
  if (!existsSync(file)) {
    console.log(`no daemon log yet: ${file}`);
    return;
  }
  if (hasFlag(args, "--follow") || hasFlag(args, "-f")) {
    await new Promise<void>((resolve) => {
      const child = spawn("tail", ["-f", file], { stdio: "inherit" });
      child.on("exit", () => resolve());
      child.on("error", () => {
        console.log(readFileSync(file, "utf8"));
        resolve();
      });
    });
    return;
  }
  const maxBytes = 64 * 1024;
  const size = statSync(file).size;
  const text = readFileSync(file, "utf8");
  const slice = size > maxBytes ? text.slice(-maxBytes) : text;
  const lines = slice.split(/\r?\n/);
  console.log(lines.slice(-120).join("\n"));
}

async function cmdDaemon(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "start":
      if (hasFlag(args, "--foreground")) {
        await runRemoteDaemon();
      } else {
        await startDaemonBackground();
      }
      return;
    case "stop":
      await stopDaemon();
      return;
    case "restart":
      await stopDaemon();
      await startDaemonBackground();
      return;
    case "status":
      showDaemonStatus();
      return;
    case "logs":
      await showDaemonLogs(args.slice(1));
      return;
    default:
      die("usage: remi daemon <start|stop|status|restart|logs> [--foreground]");
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "setup":
      return cmdSetup(rest);
    case "login":
      return cmdLogin(rest);
    case "config":
      return cmdConfig(rest);
    case "daemon":
      return cmdDaemon(rest);
    case "version":
    case "--version":
    case "-v":
      console.log(remiVersion);
      return;
    default:
      die(
        "usage: remi <setup|login|config|daemon|version>\n" +
          "  remi setup self-host --server-url <url> --app-url <url> --workspace-id <id> [--token <mul_…>] [--start]\n" +
          "  remi login --token <mul_…>\n" +
          "  remi config set <server_url|app_url|workspace_id> <value>\n" +
          "  remi daemon start|stop|status|restart|logs",
      );
  }
}

await main();
