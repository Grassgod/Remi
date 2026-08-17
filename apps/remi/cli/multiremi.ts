/**
 * `remi multiremi` — CLI entry facade.
 *
 * Command dispatch, config/setup commands and daemon lifecycle live here; the
 * REST command handlers, HTTP client, output rendering, service templating and
 * daemon health probing live in `./multiremi/`.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname } from "node:path";
import { MultiremiDaemon, startMultiremiServer, MultiremiStore } from "@multiremi/index.js";
import { setLogLevel } from "@shared/logger.js";
import { multiremiVersion } from "@multiremi/version.js";
import {
  loadMultiremiConfig,
  multiremiConfigPath,
  redactMultiremiConfig,
  saveMultiremiConfig,
  type MultiremiCliConfig,
} from "@multiremi/config.js";
import { bootFeishuChannel } from "./agent.js";
import { ensureAcpBridges, type ProvisionProvider } from "@acp/provision.js";
import { type CliOptions, numberOpt, parseArgs, stringOpt } from "./multiremi/options.js";
import {
  SUPPORTED_DAEMON_PROVIDERS,
  type SupportedDaemonProvider,
  checkManagedDaemonHealth,
  daemonAlive,
  isSupportedDaemonProvider,
  requestDaemonShutdown,
  resolveHealthyDaemonProviders,
  sleep,
  waitForDaemonReady,
} from "./multiremi/daemon-health.js";
import {
  buildMultiremiDaemonLaunchSpec,
  buildMultiremiDaemonServiceSpec,
  daemonPortFromOptions,
  multiremiDaemonPaths,
  runServiceCommands,
  servicePlatformFromOptions,
  shellQuote,
} from "./multiremi/service.js";
import { showHelp } from "./multiremi/help.js";
import { prepareDaemonEnvironment } from "./multiremi/environment.js";
import { repo } from "./multiremi/commands/repo.js";
import { attachment } from "./multiremi/commands/attachment.js";
import { agent } from "./multiremi/commands/agent.js";
import { issue } from "./multiremi/commands/issue.js";
import { project } from "./multiremi/commands/project.js";
import { runProjectKnowledgeMcp } from "./multiremi/project-knowledge-mcp.js";

export type { CliOptions } from "./multiremi/options.js";
export type {
  MultiremiDaemonLaunchSpec,
  MultiremiDaemonServicePlatform,
  MultiremiDaemonServiceSpec,
} from "./multiremi/service.js";
export {
  buildDaemonForegroundArgs,
  buildMultiremiDaemonLaunchSpec,
  buildMultiremiDaemonServiceSpec,
  detectMultiremiServicePlatform,
  multiremiDaemonPaths,
  multiremiDaemonServicePath,
} from "./multiremi/service.js";
export { detectMultiremiProviders } from "./multiremi/daemon-health.js";

interface RunMultiremiOptions {
  programName?: string;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;

export async function runMultiremi(args: string[], runOptions: RunMultiremiOptions = {}): Promise<void> {
  const parsed = parseArgs(args);
  setLogLevel(String(parsed.options.logLevel ?? parsed.options["log-level"] ?? process.env.REMI_LOG_LEVEL ?? "INFO"));
  const programName = runOptions.programName ?? "remi multiremi";

  switch (parsed.command) {
    case "setup":
      setup(parsed.options);
      if (Boolean(parsed.options.start)) await daemon(parsed.options, [], programName);
      return;
    case "login":
      login(parsed.options);
      return;
    case "config":
      configCommand(parsed.positional, parsed.options);
      return;
    case "serve":
      await serve(parsed.options);
      return;
    case "daemon":
      await daemon(parsed.options, parsed.positional, programName);
      return;
    case "repo":
      await repo(parsed.positional, parsed.options);
      return;
    case "agent":
      await agent(parsed.positional, parsed.options);
      return;
    case "issue":
      await issue(parsed.positional, parsed.options);
      return;
    case "attachment":
      await attachment(parsed.positional, parsed.options);
      return;
    case "project":
      await project(parsed.positional, parsed.options);
      return;
    case "project-knowledge-mcp":
      await runProjectKnowledgeMcp(parsed.positional[0] ?? "");
      return;
    case "seed":
      seed(parsed.options);
      return;
    case "version":
    case "--version":
    case "-V":
      console.log(multiremiVersion);
      return;
    case "help":
    case "--help":
    case "-h":
      showHelp(programName);
      return;
    default:
      console.error(`Unknown multiremi command: ${parsed.command}`);
      showHelp(programName);
      process.exit(1);
  }
}

async function serve(options: CliOptions): Promise<void> {
  const port = numberOpt(options.port, process.env.MULTIREMI_PORT, 6120);
  const host = stringOpt(options.host, process.env.MULTIREMI_HOST) ?? "0.0.0.0";
  const token = stringOpt(options.token, process.env.MULTIREMI_TOKEN);
  const server = startMultiremiServer({ port, hostname: host, authToken: token });
  console.log(`Bun Multiremi API listening on ${formatListenUrls(host, server.port ?? port).join(", ")}`);
  await waitForShutdown(() => server.stop(true));
}

function setup(options: CliOptions): void {
  const current = loadMultiremiConfig();
  const next: MultiremiCliConfig = { ...current };
  const serverUrl = stringOpt(options.server ?? options["server-url"], process.env.MULTIREMI_SERVER_URL);
  const workspaceId = stringOpt(options.workspace ?? options["workspace-id"], process.env.MULTIREMI_WORKSPACE_ID);
  const token = stringOpt(options.token, process.env.MULTIREMI_TOKEN);
  const provider = stringOpt(options.provider, process.env.MULTIREMI_PROVIDER);
  const runtimeId = stringOpt(options.runtimeId ?? options["runtime-id"], process.env.MULTIREMI_RUNTIME_ID);
  const runtimeName = stringOpt(options.name ?? options["runtime-name"], process.env.MULTIREMI_RUNTIME_NAME);
  const daemonId = stringOpt(options.daemonId ?? options["daemon-id"], process.env.MULTIREMI_DAEMON_ID);
  const maxConcurrency = stringOpt(options["max-concurrency"] ?? options.maxConcurrency, process.env.MULTIREMI_MAX_CONCURRENCY);

  if (serverUrl) next.server_url = serverUrl.replace(/\/+$/, "");
  if (workspaceId) next.workspace_id = workspaceId;
  if (token) next.token = token;
  if (provider) next.provider = provider;
  if (runtimeId) next.runtime_id = runtimeId;
  if (runtimeName) next.runtime_name = runtimeName;
  if (daemonId) next.daemon_id = daemonId;
  if (maxConcurrency) {
    const n = parseInt(maxConcurrency, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error("--max-concurrency must be an integer >= 1");
    }
    next.max_concurrency = n;
  }

  if (!next.server_url) {
    throw new Error("server URL is required: multiremi setup --server <url> --workspace <id> [--token <token>]");
  }
  if (!next.workspace_id) {
    throw new Error("workspace id is required: multiremi setup --server <url> --workspace <id> [--token <token>]");
  }
  if (next.provider && !isSupportedDaemonProvider(next.provider)) {
    throw new Error(`Unsupported Multiremi runtime provider: ${next.provider}. Supported providers: ${SUPPORTED_DAEMON_PROVIDERS.join(", ")}`);
  }

  saveMultiremiConfig(next);
  console.log(`Config saved to ${multiremiConfigPath()}`);
  // Pre-provision ACP bridges for whichever agents the user has (no-op if absent
  // or already present). The user only needs `claude` / `codex` themselves.
  const provisionTargets = (next.provider && isSupportedDaemonProvider(next.provider)
    ? [next.provider]
    : [...SUPPORTED_DAEMON_PROVIDERS]) as ProvisionProvider[];
  ensureAcpBridges(provisionTargets, (m) => console.log(`  ${m}`));
  if (!next.token) {
    console.log("Token is not set. Run:");
    console.log("  remi login --token <YOUR_TOKEN>");
  }
  console.log("Ready. Start the agent with:  remi start");
}

function login(options: CliOptions): void {
  const token = stringOpt(options.token, process.env.MULTIREMI_TOKEN);
  if (!token) throw new Error("token is required: multiremi login --token <YOUR_TOKEN>");
  const config = loadMultiremiConfig();
  config.token = token;
  saveMultiremiConfig(config);
  console.log(`Token saved to ${multiremiConfigPath()}`);
}

function configCommand(positional: string[], options: CliOptions): void {
  const action = positional[0] ?? "get";
  const config = loadMultiremiConfig();
  if (action === "get") {
    console.log(JSON.stringify(redactMultiremiConfig(config), null, 2));
    return;
  }
  if (action === "set") {
    const key = positional[1] as keyof MultiremiCliConfig | undefined;
    const value = positional[2];
    const allowed = ["server_url", "workspace_id", "token", "provider", "runtime_id", "runtime_name", "max_concurrency"];
    if (!key || !allowed.includes(key)) {
      throw new Error(`usage: multiremi config set <${allowed.join("|")}> <value>`);
    }
    if (!value) throw new Error(`value is required for ${key}`);
    if (key === "provider" && !isSupportedDaemonProvider(value)) {
      throw new Error(`Unsupported Multiremi runtime provider: ${value}. Supported providers: ${SUPPORTED_DAEMON_PROVIDERS.join(", ")}`);
    }
    if (key === "max_concurrency") {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) throw new Error("max_concurrency must be an integer >= 1");
      config.max_concurrency = n;
    } else {
      config[key] = value;
    }
    saveMultiremiConfig(config);
    console.log(`Updated ${key}`);
    return;
  }
  throw new Error("usage: multiremi config get | multiremi config set <key> <value>");
}

async function daemon(options: CliOptions, positional: string[], programName: string): Promise<void> {
  const action = positional[0] ?? "start";
  switch (action) {
    case "start":
      if (Boolean(options.foreground) || Boolean(options.once)) {
        await runDaemonForeground(options, programName);
      } else {
        await startDaemonBackground(options, programName);
      }
      return;
    case "stop":
      await stopDaemon(options);
      return;
    case "restart":
      await stopDaemon(options, { quietIfStopped: true });
      await startDaemonBackground(options, programName);
      return;
    case "status":
      await daemonStatus(options);
      return;
    case "logs":
      await daemonLogs(options);
      return;
    case "service":
      await daemonService(options, positional.slice(1), programName);
      return;
    default:
      throw new Error("usage: multiremi daemon [start|stop|restart|status|logs|service] [options]");
  }
}

/**
 * Build (but do not start) the worker daemon(s) for the multiremi-server channel
 * from CLI options + saved config. Returns one MultiremiDaemon per healthy
 * provider, or `[]` if no provider is healthy (the caller decides whether that
 * is an error — e.g. the unified agent tolerates it when Feishu is configured).
 */
export async function resolveWorkerDaemons(options: CliOptions): Promise<MultiremiDaemon[]> {
  await prepareDaemonEnvironment();
  const config = loadMultiremiConfig();
  const serverUrl = stringOpt(options.server, undefined)
    ?? stringOpt(options["server-url"], undefined)
    ?? stringOpt(undefined, process.env.MULTIREMI_SERVER_URL)
    ?? config.server_url
    ?? "http://127.0.0.1:6120";
  const explicitProvider = stringOpt(options.provider, process.env.MULTIREMI_PROVIDER)
    ?? config.provider;
  if (explicitProvider && !isSupportedDaemonProvider(explicitProvider)) {
    throw new Error(`Unsupported Multiremi runtime provider: ${explicitProvider}. Supported providers: ${SUPPORTED_DAEMON_PROVIDERS.join(", ")}`);
  }
  const requestedProvider: SupportedDaemonProvider | null =
    explicitProvider && isSupportedDaemonProvider(explicitProvider) ? explicitProvider : null;
  // Provision the ACP bridges for the candidate providers (install any that are
  // missing) before the health check decides what's available — the user only
  // needs `claude` / `codex` themselves.
  ensureAcpBridges((requestedProvider ? [requestedProvider] : [...SUPPORTED_DAEMON_PROVIDERS]) as ProvisionProvider[]);
  const providers = await resolveHealthyDaemonProviders(requestedProvider);
  if (providers.length === 0) return [];

  const runtimeId = stringOpt(options.runtimeId ?? options["runtime-id"], process.env.MULTIREMI_RUNTIME_ID)
    ?? config.runtime_id;
  if (providers.length > 1 && runtimeId) {
    throw new Error("--runtime-id requires --provider when multiple providers are auto-detected");
  }

  const runtimeName = stringOpt(options.name, process.env.MULTIREMI_RUNTIME_NAME)
    ?? config.runtime_name
    ?? undefined;
  // Machine identity (host+user, no internal "bun-runtime" token, no provider
  // suffix). Used as BOTH the shared daemon_id — so the dashboard groups this
  // host's providers into ONE card and single→multi provider never orphans it —
  // and the card title; the server derives each row label as
  // `<provider> (<deviceName>)`.
  const deviceName = runtimeName ?? `${hostname()}-${Bun.env.USER ?? "local"}`;
  // 0 = "unset" → the daemon defaults to CPU-1 (resolveDaemonConcurrency).
  const maxConcurrency = numberOpt(options["max-concurrency"] ?? options.maxConcurrency, process.env.MULTIREMI_MAX_CONCURRENCY, config.max_concurrency ?? 0);
  const baseDaemonPort = daemonPortFromOptions(options);
  const daemons: MultiremiDaemon[] = [];
  const stopAllForRestart = () => {
    for (const runtimeDaemon of daemons) runtimeDaemon.stop();
  };
  for (const provider of providers) {
    daemons.push(new MultiremiDaemon({
      serverUrl,
      token: stringOpt(options.token, process.env.MULTIREMI_TOKEN) ?? config.token,
      runtimeId,
      daemonId: stringOpt(options.daemonId ?? options["daemon-id"], process.env.MULTIREMI_DAEMON_ID)
        ?? config.daemon_id
        ?? (providers.length > 1 ? deviceName : null),
      runtimeName: providers.length > 1 ? formatRuntimeName(runtimeName, provider) : runtimeName,
      deviceName,
      provider,
      maxConcurrency,
      workspaceId: stringOpt(options.workspace, process.env.MULTIREMI_WORKSPACE_ID)
        ?? config.workspace_id
        ?? "local",
      daemonPort: providers.length > 1 && baseDaemonPort !== 0 ? baseDaemonPort + providers.indexOf(provider) : baseDaemonPort,
      repoCacheRoot: stringOpt(options.repoCacheRoot ?? options["repo-cache-root"], process.env.MULTIREMI_REPO_CACHE_ROOT) ?? undefined,
      once: Boolean(options.once),
      onRestartRequested: stopAllForRestart,
    }));
  }
  return daemons;
}

async function runDaemonForeground(options: CliOptions, programName: string): Promise<void> {
  const daemons = await resolveWorkerDaemons(options);
  // Co-resident Feishu channel: a long-running agent process also brings up the
  // Feishu channel when configured, so one `remi start` runs both. Skipped in
  // --once mode (tests / one-shot worker runs never touch Feishu).
  const feishu = Boolean(options.once) ? null : await bootFeishuChannel();
  if (daemons.length === 0 && !feishu) {
    throw new Error(`Nothing to start: no healthy runtime provider (install/authenticate one of: ${SUPPORTED_DAEMON_PROVIDERS.join(", ")}) and Feishu is not configured.`);
  }
  const stopAll = (): void => {
    for (const runtimeDaemon of daemons) runtimeDaemon.stop();
    feishu?.stop().catch(() => {});
  };
  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);
  const running: Promise<void>[] = daemons.map((runtimeDaemon) => runtimeDaemon.start());
  if (feishu) running.push(feishu.start);
  await Promise.all(running);
  if (!Boolean(options.once) && daemons.some((runtimeDaemon) => runtimeDaemon.restartRequested())) {
    restartForegroundDaemonProcess(options, programName);
  }
}

async function startDaemonBackground(options: CliOptions, programName: string): Promise<void> {
  const spec = buildMultiremiDaemonLaunchSpec(options, programName);
  if (spec.port === 0) throw new Error("--daemon-port 0 requires --foreground because background daemon control needs a stable port");
  const live = await checkManagedDaemonHealth(spec.port);
  const running = live.find((entry) => daemonAlive(entry.health));
  if (running) {
    throw new Error(`Multiremi daemon is already running on port ${running.port} (pid ${running.health.pid ?? "unknown"}). Use 'multiremi daemon restart' to restart it.`);
  }

  mkdirSync(spec.stateDir, { recursive: true });
  const logFd = openSync(spec.logPath, "a", 0o644);
  let childPid = 0;
  try {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, ...spec.env },
    });
    childPid = child.pid ?? 0;
    child.unref();
  } finally {
    closeSync(logFd);
  }
  if (!childPid) throw new Error("failed to start Multiremi daemon");
  writeFileSync(spec.pidPath, `${childPid}\n`, { mode: 0o644 });

  const health = await waitForDaemonReady(spec.port, DEFAULT_STARTUP_TIMEOUT_MS);
  if (health.status !== "running") {
    console.error(`Multiremi daemon may still be starting. Check logs: ${spec.logPath}`);
    return;
  }
  console.error(`Multiremi daemon started (pid ${childPid}, version ${health.cli_version ?? multiremiVersion})`);
  console.error(`Logs: ${spec.logPath}`);
}

function restartForegroundDaemonProcess(options: CliOptions, programName: string): void {
  const spec = buildMultiremiDaemonLaunchSpec(options, programName);
  const child = spawn(spec.command, spec.args, {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, ...spec.env },
  });
  child.unref();
  console.error(`Multiremi daemon restarting with updated binary (pid ${child.pid ?? "unknown"})`);
}

async function stopDaemon(options: CliOptions, opts: { quietIfStopped?: boolean } = {}): Promise<void> {
  const port = daemonPortFromOptions(options);
  const live = (await checkManagedDaemonHealth(port)).filter((entry) => daemonAlive(entry.health));
  if (live.length === 0) {
    if (!opts.quietIfStopped) console.error("Multiremi daemon is not running.");
    return;
  }

  for (const entry of live) {
    try {
      await requestDaemonShutdown(entry.port);
      console.error(`Stopping Multiremi daemon on port ${entry.port} (pid ${entry.health.pid ?? "unknown"})...`);
    } catch (err) {
      const pid = typeof entry.health.pid === "number" ? entry.health.pid : 0;
      if (pid > 0) {
        console.error(`Graceful shutdown failed on port ${entry.port}: ${err instanceof Error ? err.message : String(err)}. Sending SIGTERM to pid ${pid}.`);
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sleep(250);
    const remaining = (await checkManagedDaemonHealth(port)).filter((entry) => daemonAlive(entry.health));
    if (remaining.length === 0) {
      console.error("Multiremi daemon stopped.");
      return;
    }
  }
  console.error("Multiremi daemon is still stopping. It may be finishing a running task.");
}

async function daemonStatus(options: CliOptions): Promise<void> {
  const port = daemonPortFromOptions(options);
  const entries = await checkManagedDaemonHealth(port);
  const live = entries.filter((entry) => daemonAlive(entry.health));
  const output = stringOpt(options.output, undefined);
  if (output === "json" || Boolean(options.json)) {
    if (live.length === 1) {
      console.log(JSON.stringify(live[0].health, null, 2));
    } else {
      console.log(JSON.stringify({
        status: live.length > 0 ? "running" : "stopped",
        daemons: live.map((entry) => ({ port: entry.port, ...entry.health })),
      }, null, 2));
    }
    return;
  }
  if (live.length === 0) {
    console.log("Multiremi daemon: stopped");
    return;
  }
  for (const entry of live) {
    const health = entry.health;
    console.log(`Multiremi daemon (${health.provider ?? "runtime"}): ${health.status ?? "unknown"} (pid ${health.pid ?? "unknown"}, port ${entry.port})`);
    if (health.cli_version) console.log(`Version: ${health.cli_version}`);
    if (health.runtime_id) console.log(`Runtime: ${health.runtime_id}`);
    if (health.active_task_count !== undefined) console.log(`Active tasks: ${health.active_task_count}`);
  }
}

async function daemonLogs(options: CliOptions): Promise<void> {
  const paths = multiremiDaemonPaths();
  if (!existsSync(paths.logPath)) {
    throw new Error(`no log file found at ${paths.logPath}; the daemon may not have been started in background mode`);
  }
  const lines = numberOpt(options.lines ?? options.n, undefined, 50);
  if (Boolean(options.follow) || Boolean(options.f)) {
    await followLog(paths.logPath, lines);
    return;
  }
  const raw = readFileSync(paths.logPath, "utf8");
  const selected = raw.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line.length > 0).slice(-Math.max(0, lines));
  console.log(selected.join("\n"));
}

async function daemonService(options: CliOptions, positional: string[], programName: string): Promise<void> {
  const action = positional[0] ?? "install";
  const spec = buildMultiremiDaemonServiceSpec(options, programName, servicePlatformFromOptions(options));
  if (action === "print") {
    console.log(spec.content);
    return;
  }
  if (action === "install") {
    mkdirSync(dirname(spec.path), { recursive: true });
    writeFileSync(spec.path, spec.content, { mode: 0o644 });
    console.error(`Multiremi daemon service written: ${spec.path}`);
    if (Boolean(options.enable)) {
      runServiceCommands(spec.enableCommands);
      console.error("Multiremi daemon service enabled.");
    } else {
      console.error("Enable it with:");
      console.error(`  ${spec.enableCommands.map((command) => command.map(shellQuote).join(" ")).join(" && ")}`);
    }
    return;
  }
  if (action === "uninstall") {
    if (Boolean(options.disable)) runServiceCommands(spec.disableCommands);
    rmSync(spec.path, { force: true });
    console.error(`Multiremi daemon service removed: ${spec.path}`);
    return;
  }
  if (action === "status") {
    const installed = existsSync(spec.path);
    if (Boolean(options.json) || stringOpt(options.output, undefined) === "json") {
      console.log(JSON.stringify({
        installed,
        platform: spec.platform,
        path: spec.path,
        label: spec.label,
        unit_name: spec.unitName,
      }, null, 2));
      return;
    }
    console.log(`Multiremi daemon service: ${installed ? "installed" : "not installed"}`);
    console.log(`Platform: ${spec.platform}`);
    console.log(`Path: ${spec.path}`);
    return;
  }
  throw new Error("usage: multiremi daemon service [install|uninstall|status|print] [--platform launchd|systemd] [--enable|--disable]");
}

function seed(options: CliOptions): void {
  const provider = stringOpt(options.provider, process.env.MULTIREMI_PROVIDER) ?? "claude";
  const store = new MultiremiStore();
  const agent = store.ensureDefaultAgent(provider);
  console.log(`Default ${provider} agent: ${agent.id}`);
}

async function followLog(logPath: string, lines: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const tail = spawn("tail", ["-n", String(lines), "-f", logPath], { stdio: "inherit" });
    tail.on("error", reject);
    tail.on("exit", (code) => {
      if (code === 0 || code === null) resolvePromise();
      else reject(new Error(`tail exited with code ${code}`));
    });
  });
}

function formatRuntimeName(baseName: string | undefined, provider: string): string {
  return `${baseName ?? `${hostname()}-${Bun.env.USER ?? "local"}-bun-runtime`}-${provider}`;
}

function formatListenUrls(host: string, port: number): string[] {
  if (host !== "0.0.0.0" && host !== "::") return [`http://${host}:${port}`];
  const urls = [`http://127.0.0.1:${port}`];
  for (const address of localIPv4Addresses()) {
    urls.push(`http://${address}:${port}`);
  }
  return [...new Set(urls)];
}

function localIPv4Addresses(): string[] {
  const result: string[] = [];
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) result.push(entry.address);
    }
  }
  return result;
}

async function waitForShutdown(stop: () => void): Promise<void> {
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const shutdown = () => {
    stop();
    resolve();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await done;
}

export const run = runMultiremi;
