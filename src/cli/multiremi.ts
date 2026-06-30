import { execFileSync, spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { MultiremiDaemon, startMultiremiServer, MultiremiStore } from "../multiremi/index.js";
import { AcpProvider } from "@acp/index.js";
import { setLogLevel } from "../shared/logger.js";
import { multiremiVersion } from "../multiremi/version.js";
import {
  loadMultiremiConfig,
  multiremiConfigPath,
  redactMultiremiConfig,
  saveMultiremiConfig,
  type MultiremiCliConfig,
} from "../multiremi/config.js";

interface ParsedArgs {
  command: string;
  options: CliOptions;
  positional: string[];
}

interface RunMultiremiOptions {
  programName?: string;
}

type CliOptionValue = string | boolean | string[];
export type CliOptions = Record<string, CliOptionValue>;

const SUPPORTED_DAEMON_PROVIDERS = ["claude", "codex"] as const;
type SupportedDaemonProvider = typeof SUPPORTED_DAEMON_PROVIDERS[number];
const DEFAULT_DAEMON_PORT = 6131;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const VALID_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];
const VALID_ISSUE_ASSIGNEE_TYPES = ["agent", "member", "squad"];
type CliOutputMode = "json" | "table";

interface MultiremiDaemonHealth {
  status?: string;
  pid?: number;
  uptime?: string;
  runtime_id?: string | null;
  runtime_name?: string;
  provider?: string;
  workspace_id?: string | null;
  server_url?: string;
  cli_version?: string;
  active_task_count?: number;
  daemon_port?: number;
  error?: string;
}

export interface MultiremiDaemonLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  stateDir: string;
  logPath: string;
  pidPath: string;
  port: number;
}

export type MultiremiDaemonServicePlatform = "launchd" | "systemd";

export interface MultiremiDaemonServiceSpec {
  platform: MultiremiDaemonServicePlatform;
  label: string;
  unitName: string;
  path: string;
  content: string;
  enableCommands: string[][];
  disableCommands: string[][];
}

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
    case "issue":
      await issue(parsed.positional, parsed.options);
      return;
    case "attachment":
      await attachment(parsed.positional, parsed.options);
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
  if (!next.token) {
    console.log("Token is not set. Run:");
    console.log("  multiremi login --token <YOUR_TOKEN>");
  }
  console.log("Ready. Start the daemon with:");
  console.log("  multiremi daemon");
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
        ?? null,
      runtimeName: providers.length > 1 ? formatRuntimeName(runtimeName, provider) : runtimeName,
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
  if (daemons.length === 0) {
    throw new Error(`No healthy Multiremi runtime provider found. Install and authenticate one of: ${SUPPORTED_DAEMON_PROVIDERS.join(", ")}`);
  }
  process.on("SIGINT", () => daemons.forEach((runtimeDaemon) => runtimeDaemon.stop()));
  process.on("SIGTERM", () => daemons.forEach((runtimeDaemon) => runtimeDaemon.stop()));
  await Promise.all(daemons.map((runtimeDaemon) => runtimeDaemon.start()));
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

async function repo(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  if (action !== "checkout") throw new Error("usage: multiremi repo checkout <url> [--ref <branch-or-sha>]");
  const repoUrl = positional[1]?.trim();
  if (!repoUrl) throw new Error("usage: multiremi repo checkout <url> [--ref <branch-or-sha>]");
  const daemonPort = stringOpt(options.daemonPort ?? options["daemon-port"], process.env.MULTIREMI_DAEMON_PORT);
  if (!daemonPort) {
    throw new Error("MULTIREMI_DAEMON_PORT not set (this command is intended to run inside a Multiremi daemon task)");
  }
  const workDir = process.cwd();
  const response = await fetch(`http://127.0.0.1:${daemonPort}/repo/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: repoUrl,
      workspace_id: stringOpt(options.workspace ?? options["workspace-id"], process.env.MULTIREMI_WORKSPACE_ID) ?? "",
      workdir: workDir,
      ref: stringOpt(options.ref, undefined) ?? "",
      agent_name: stringOpt(options.agentName ?? options["agent-name"], process.env.MULTIREMI_AGENT_NAME) ?? "",
      task_id: stringOpt(options.taskId ?? options["task-id"], process.env.MULTIREMI_TASK_ID) ?? "",
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`checkout failed: ${text}`);
  const result = JSON.parse(text) as { path?: string; branch_name?: string };
  if (!result.path) throw new Error(`checkout failed: invalid daemon response ${text}`);
  console.log(result.path);
  console.error(`Checked out ${repoUrl} -> ${result.path}${result.branch_name ? ` (branch: ${result.branch_name})` : ""}`);
}

async function attachment(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  if (action !== "download") throw new Error("usage: multiremi attachment download <attachment-id> [--output-dir <dir>]");
  const attachmentId = positional[1]?.trim();
  if (!attachmentId) throw new Error("usage: multiremi attachment download <attachment-id> [--output-dir <dir>]");

  const metadata = await multiremiApiRequest<Record<string, unknown>>("GET", `/api/attachments/${encodeURIComponent(attachmentId)}`, undefined, options);
  const attachmentRow = normalizedAttachmentRecord(metadata);
  const downloadUrl = attachmentStringField(attachmentRow, "download_url", "downloadUrl", "url");
  if (!downloadUrl) throw new Error("attachment has no download URL");

  const filename = safeOutputFilename(attachmentStringField(attachmentRow, "filename") ?? attachmentId, attachmentId);
  const outputDir = rawStringOption(options, "output-dir", "outputDir", "o") ?? ".";
  const data = await multiremiApiDownloadFile(downloadUrl, options);
  const outputPath = join(outputDir, filename);
  writeFileSync(outputPath, data, { mode: 0o644 });
  const absolutePath = resolve(outputPath);

  console.error(`Downloaded: ${absolutePath}`);
  printJson({
    id: attachmentStringField(attachmentRow, "id") ?? attachmentId,
    filename,
    path: absolutePath,
    size: attachmentStringField(attachmentRow, "size_bytes", "sizeBytes") ?? String(data.byteLength),
  });
}

async function issue(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  if (action === "list") {
    const query = buildIssueListQuery(options);
    const response = await multiremiApiRequest("GET", `/api/issues${query ? `?${query}` : ""}`, undefined, options);
    printIssueCollection(response, options);
    return;
  }
  if (action === "get") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue get <issue-id> [--output json]");
    const response = await multiremiApiRequest("GET", `/api/issues/${encodeURIComponent(issueId)}`, undefined, options);
    printJson(response);
    return;
  }
  if (action === "create") {
    await issueCreate(options);
    return;
  }
  if (action === "update") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue update <issue-id> [--title <title>] [--description <text>] [--status <status>] [--priority <priority>] [--assignee <id|name|email> --assignee-type <type>] [--project <id>] [--parent <id>]");
    await issueUpdate(issueId, options);
    return;
  }
  if (action === "assign") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue assign <issue-id> (--to <id|name|email> [--to-type agent|member|squad] | --unassign)");
    await issueAssign(issueId, options);
    return;
  }
  if (action === "status") {
    const issueId = positional[1]?.trim();
    const status = positional[2]?.trim();
    if (!issueId || !status) throw new Error("usage: multiremi issue status <issue-id> <status> [--output json]");
    if (!VALID_ISSUE_STATUSES.includes(status)) {
      throw new Error(`invalid status ${JSON.stringify(status)}; valid values: ${VALID_ISSUE_STATUSES.join(", ")}`);
    }
    const response = await multiremiApiRequest("PUT", `/api/issues/${encodeURIComponent(issueId)}`, { status }, options);
    printJson(response);
    return;
  }
  if (action === "delete") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue delete <issue-id>");
    await multiremiApiRequest("DELETE", `/api/issues/${encodeURIComponent(issueId)}`, undefined, options);
    printJson({ deleted: true });
    return;
  }
  if (action === "comment") {
    await issueComment(positional.slice(1), options);
    return;
  }
  if (action === "metadata") {
    await issueMetadata(positional.slice(1), options);
    return;
  }
  if (action === "subscriber") {
    await issueSubscriber(positional.slice(1), options);
    return;
  }
  if (action === "runs") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue runs <issue-id>");
    printTaskRuns(await multiremiApiRequest("GET", `/api/issues/${encodeURIComponent(issueId)}/task-runs`, undefined, options), options);
    return;
  }
  if (action === "run-messages") {
    const taskId = positional[1]?.trim();
    if (!taskId) throw new Error("usage: multiremi issue run-messages <task-id> [--since <seq>]");
    const since = integerOption(options, "since");
    const query = since === null ? "" : `?since=${encodeURIComponent(String(since))}`;
    printTaskMessages(await multiremiApiRequest("GET", `/api/tasks/${encodeURIComponent(taskId)}/messages${query}`, undefined, options), options);
    return;
  }
  if (action === "rerun") {
    const issueId = positional[1]?.trim();
    if (!issueId) throw new Error("usage: multiremi issue rerun <issue-id> [--agent-id <id>] [--prompt <text>]");
    const body: Record<string, unknown> = {};
    const agentId = rawStringOption(options, "agent-id", "agentId");
    const prompt = rawStringOption(options, "prompt");
    if (agentId) body.agent_id = agentId;
    if (prompt) body.prompt = prompt;
    printJson(await multiremiApiRequest("POST", `/api/issues/${encodeURIComponent(issueId)}/rerun`, body, options));
    return;
  }
  if (action === "cancel-task") {
    const taskId = positional[1]?.trim();
    if (!taskId) throw new Error("usage: multiremi issue cancel-task <task-id>");
    printJson(await multiremiApiRequest("POST", `/api/tasks/${encodeURIComponent(taskId)}/cancel`, {}, options));
    return;
  }
  if (action === "search") {
    const queryText = positional[1]?.trim();
    if (!queryText) throw new Error("usage: multiremi issue search <query> [--limit <n>] [--include-closed]");
    const params = new URLSearchParams({ q: queryText });
    const limit = integerOption(options, "limit");
    if (limit !== null) params.set("limit", String(limit));
    if (Boolean(options.includeClosed ?? options["include-closed"])) params.set("include_closed", "true");
    printIssueSearch(await multiremiApiRequest("GET", `/api/issues/search?${params.toString()}`, undefined, options), options);
    return;
  }
  throw new Error("usage: multiremi issue list|get|create|update|assign|status|delete|search|runs|run-messages|rerun|cancel-task|comment|subscriber|metadata ...");
}

async function issueComment(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  const issueId = positional[1]?.trim();
  if (action === "list") {
    if (!issueId) throw new Error("usage: multiremi issue comment list <issue-id> [--thread <comment-id>] [--since <iso>] [--tail <n>] [--recent <n>] [--roots-only] [--summary] [--before <iso> --before-id <id>] [--output json]");
    const query = buildIssueCommentListQuery(options);
    const response = await multiremiApiFetch<CliIssueComment[]>(
      "GET",
      `/api/issues/${encodeURIComponent(issueId)}/comments${query ? `?${query}` : ""}`,
      undefined,
      options,
    );
    const nextBefore = response.headers.get("X-Multiremi-Next-Before") ?? response.headers.get("X-Multimira-Next-Before");
    const nextBeforeId = response.headers.get("X-Multiremi-Next-Before-Id") ?? response.headers.get("X-Multimira-Next-Before-Id");
    if (nextBefore && nextBeforeId) {
      const label = stringOpt(options.thread, undefined) && hasOption(options, "tail")
        ? "Next reply cursor"
        : "Next thread cursor";
      console.error(`${label}: --before ${nextBefore} --before-id ${nextBeforeId}`);
    }
    printIssueComments(response.data, options);
    return;
  }
  if (action === "add") {
    if (!issueId) throw new Error("usage: multiremi issue comment add <issue-id> [--parent <comment-id>] (--content <text>|--content-file <path>|--content-stdin)");
    const body = await readCommentBody(options);
    if (!body.trim()) throw new Error("comment body is required");
    const attachmentIds: string[] = [];
    for (const attachmentFile of readAttachmentFiles(options)) {
      const uploaded = await multiremiApiUploadFile(attachmentFile, issueId, options);
      const uploadedId = attachmentStringField(normalizedAttachmentRecord(uploaded), "id");
      if (!uploadedId) throw new Error(`upload attachment ${attachmentFile.path}: upload response missing attachment id`);
      attachmentIds.push(uploadedId);
      console.error(`Uploaded ${attachmentFile.path}`);
    }
    const response = await multiremiApiRequest(
      "POST",
      `/api/issues/${encodeURIComponent(issueId)}/comments`,
      {
        content: body,
        parent_id: stringOpt(options.parent, undefined) ?? null,
        ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}),
      },
      options,
    );
    printJson(response);
    return;
  }
  if (action === "update") {
    const commentId = positional[1]?.trim();
    if (!commentId) throw new Error("usage: multiremi issue comment update <comment-id> (--content <text>|--content-file <path>|--content-stdin)");
    const body = await readCommentBody(options);
    if (!body.trim()) throw new Error("comment body is required");
    printJson(await multiremiApiRequest("PUT", `/api/comments/${encodeURIComponent(commentId)}`, { content: body }, options));
    return;
  }
  if (action === "delete") {
    const commentId = positional[1]?.trim();
    if (!commentId) throw new Error("usage: multiremi issue comment delete <comment-id>");
    const response = await multiremiApiRequest("DELETE", `/api/comments/${encodeURIComponent(commentId)}`, undefined, options);
    printJson(response ?? { deleted: true });
    return;
  }
  if (action === "resolve") {
    const commentId = positional[1]?.trim();
    if (!commentId) throw new Error("usage: multiremi issue comment resolve <comment-id> [--actor-type <type>] [--actor-id <id>]");
    printJson(await multiremiApiRequest("POST", `/api/comments/${encodeURIComponent(commentId)}/resolve`, actorBodyFromOptions(options), options));
    return;
  }
  if (action === "unresolve") {
    const commentId = positional[1]?.trim();
    if (!commentId) throw new Error("usage: multiremi issue comment unresolve <comment-id>");
    printJson(await multiremiApiRequest("DELETE", `/api/comments/${encodeURIComponent(commentId)}/resolve`, undefined, options));
    return;
  }
  throw new Error("usage: multiremi issue comment list|add|update|delete|resolve|unresolve ...");
}

async function issueMetadata(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  const issueId = positional[1]?.trim();
  if (!issueId) throw new Error("usage: multiremi issue metadata <list|get|set|delete> <issue-id> [--key <key>] [--value <value>]");
  if (action === "list") {
    try {
      printJson(await multiremiApiRequest("GET", `/api/issues/${encodeURIComponent(issueId)}/metadata`, undefined, options));
    } catch (err) {
      if (err instanceof MultiremiCliHttpError && err.status === 404) {
        printJson({});
        return;
      }
      throw err;
    }
    return;
  }
  const key = stringOpt(options.key, undefined);
  if (!key) throw new Error("--key is required");
  if (action === "get") {
    const metadata = await multiremiApiRequest<Record<string, unknown>>("GET", `/api/issues/${encodeURIComponent(issueId)}/metadata`, undefined, options);
    if (!(key in metadata)) throw new Error(`key ${JSON.stringify(key)} not found on issue`);
    printJson(metadata[key]);
    return;
  }
  if (action === "set") {
    if (!hasOption(options, "value")) throw new Error("--value is required");
    const value = parseMetadataValue(String(options.value ?? ""), stringOpt(options.type, undefined));
    const response = await multiremiApiRequest("PUT", `/api/issues/${encodeURIComponent(issueId)}/metadata/${encodeURIComponent(key)}`, { value }, options);
    printJson(response);
    return;
  }
  if (action === "delete") {
    const response = await multiremiApiRequest("DELETE", `/api/issues/${encodeURIComponent(issueId)}/metadata/${encodeURIComponent(key)}`, undefined, options);
    printJson(response ?? { deleted: true });
    return;
  }
  throw new Error("usage: multiremi issue metadata list|get|set|delete <issue-id> [--key <key>] [--value <value>]");
}

async function issueCreate(options: CliOptions): Promise<void> {
  const title = rawStringOption(options, "title");
  if (!title?.trim()) throw new Error("usage: multiremi issue create --title <title> [--description <text>] [--status <status>] [--priority <priority>]");
  const attachments = readAttachmentFiles(options);
  const body: Record<string, unknown> = { title };
  const description = await readOptionalTextBody(options, "description");
  if (description.set) body.description = description.value;
  addStringBodyField(body, options, "status", "status", true);
  addStringBodyField(body, options, "priority", "priority");
  addStringBodyField(body, options, "project_id", "project", false, true);
  addStringBodyField(body, options, "parent_issue_id", "parent", false, true);
  addStringBodyField(body, options, "start_date", "start-date", false, true);
  addStringBodyField(body, options, "due_date", "due-date", false, true);
  if (Boolean(options.allowDuplicate ?? options["allow-duplicate"])) body.allow_duplicate = true;
  addAssigneeBodyFields(body, options, "assignee-id", "assignee-type", "assignee");
  const response = await multiremiApiRequest("POST", "/api/issues", body, options);
  if (attachments.length) {
    const issueId = responseIssueId(response);
    for (const attachmentFile of attachments) {
      try {
        await multiremiApiUploadFile(attachmentFile, issueId, options);
        console.error(`Uploaded ${attachmentFile.path}`);
      } catch (err) {
        console.error(`warning: upload attachment ${attachmentFile.path} failed (issue already created, ${issueId}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  printJson(response);
}

async function issueUpdate(issueId: string, options: CliOptions): Promise<void> {
  const body: Record<string, unknown> = {};
  addStringBodyField(body, options, "title", "title", false, true);
  const description = await readOptionalTextBody(options, "description");
  if (description.set) body.description = description.value;
  addStringBodyField(body, options, "status", "status", true, true);
  addStringBodyField(body, options, "priority", "priority", false, true);
  addStringBodyField(body, options, "project_id", "project", false, true);
  addStringBodyField(body, options, "parent_issue_id", "parent", false, true);
  addStringBodyField(body, options, "start_date", "start-date", false, true);
  addStringBodyField(body, options, "due_date", "due-date", false, true);
  addAssigneeBodyFields(body, options, "assignee-id", "assignee-type", "assignee");
  if (Object.keys(body).length === 0) throw new Error("no fields to update; pass --title, --description, --status, --priority, --assignee, --project, --parent, --start-date, or --due-date");
  printJson(await multiremiApiRequest("PUT", `/api/issues/${encodeURIComponent(issueId)}`, body, options));
}

async function issueAssign(issueId: string, options: CliOptions): Promise<void> {
  const unassign = Boolean(options.unassign);
  const hasTarget = hasOption(options, "to-id") || hasOption(options, "toId") || hasOption(options, "to");
  if (unassign && hasTarget) throw new Error("--to/--to-id and --unassign are mutually exclusive");
  const body: Record<string, unknown> = {};
  if (unassign) {
    body.assignee_type = null;
    body.assignee_id = null;
  } else {
    if (!hasTarget) throw new Error("provide --to <id|name|email> [--to-type agent|member|squad] or --unassign");
    addAssigneeBodyFields(body, options, "to-id", "to-type", "to");
  }
  printJson(await multiremiApiRequest("PUT", `/api/issues/${encodeURIComponent(issueId)}`, body, options));
}

async function issueSubscriber(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  const issueId = positional[1]?.trim();
  if (!issueId) throw new Error("usage: multiremi issue subscriber <list|add|remove> <issue-id> [--user-id <member-id>]");
  if (action === "list") {
    printIssueSubscribers(await multiremiApiRequest("GET", `/api/issues/${encodeURIComponent(issueId)}/subscribers`, undefined, options), options);
    return;
  }
  if (action === "add" || action === "remove") {
    const body = subscriberBodyFromOptions(options);
    const pathAction = action === "add" ? "subscribe" : "unsubscribe";
    printJson(await multiremiApiRequest("POST", `/api/issues/${encodeURIComponent(issueId)}/${pathAction}`, body, options));
    return;
  }
  throw new Error("usage: multiremi issue subscriber list|add|remove <issue-id> [--user-id <member-id>]");
}

interface CliIssueComment {
  id: string;
  parentId?: string | null;
  parent_id?: string | null;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

function buildIssueListQuery(options: CliOptions): string {
  const params = new URLSearchParams();
  addQueryParam(params, "workspace_id", rawStringOption(options, "workspace", "workspace-id"));
  addQueryParam(params, "status", rawStringOption(options, "status"));
  addQueryParam(params, "priority", rawStringOption(options, "priority"));
  addQueryParam(params, "assignee_id", rawStringOption(options, "assignee-id", "assigneeId", "assignee"));
  addQueryParam(params, "assignee_type", rawStringOption(options, "assignee-type", "assigneeType"));
  addQueryParam(params, "project_id", rawStringOption(options, "project", "project-id"));
  const limit = integerOption(options, "limit");
  const offset = integerOption(options, "offset");
  if (limit !== null) params.set("limit", String(limit));
  if (offset !== null) params.set("offset", String(offset));
  const metadata = metadataFilterFromOptions(options);
  if (metadata) params.set("metadata", JSON.stringify(metadata));
  return params.toString();
}

function buildIssueCommentListQuery(options: CliOptions): string {
  const thread = stringOpt(options.thread, undefined);
  const since = stringOpt(options.since, undefined);
  const recent = integerOption(options, "recent");
  const tail = integerOption(options, "tail");
  const rootsOnly = Boolean(options.rootsOnly ?? options["roots-only"]);
  const summary = Boolean(options.summary);
  const before = stringOpt(options.before, undefined);
  const beforeId = stringOpt(options.beforeId ?? options["before-id"], undefined);

  if (recent !== null && recent <= 0) throw new Error("--recent must be a positive integer");
  if (tail !== null && tail < 0) throw new Error("--tail must be a non-negative integer (0 returns just the thread root)");
  if (thread && recent !== null) throw new Error("--thread and --recent are mutually exclusive");
  if (rootsOnly && thread) throw new Error("--roots-only and --thread are mutually exclusive");
  if (rootsOnly && recent !== null) throw new Error("--roots-only and --recent are mutually exclusive");
  if (rootsOnly && tail !== null) throw new Error("--roots-only and --tail are mutually exclusive");
  if (rootsOnly && before) throw new Error("--roots-only does not support --before / --before-id");
  if (tail !== null && !thread) throw new Error("--tail requires --thread (it is a thread-scoped limit)");
  if (Boolean(before) !== Boolean(beforeId)) throw new Error("--before and --before-id must be set together (composite cursor for stable pagination)");
  if (before && recent === null && !(thread && tail !== null)) {
    throw new Error("--before / --before-id require --recent (thread cursor) or --thread + --tail (reply cursor)");
  }

  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (thread) params.set("thread", thread);
  if (recent !== null) params.set("recent", String(recent));
  if (tail !== null) params.set("tail", String(tail));
  if (rootsOnly) params.set("roots_only", "true");
  if (summary) params.set("summary", "true");
  if (before && beforeId) {
    params.set("before", before);
    params.set("before_id", beforeId);
  }
  return params.toString();
}

function parseMetadataValue(raw: string, forcedType: string | null): string | number | boolean {
  switch (forcedType) {
    case "string":
      return raw;
    case "number": {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new Error(`value ${JSON.stringify(raw)} is not a valid number`);
      return number;
    }
    case "bool":
      if (raw !== "true" && raw !== "false") throw new Error(`value ${JSON.stringify(raw)} is not a valid bool (expected true or false)`);
      return raw === "true";
    case null:
      break;
    default:
      throw new Error(`unknown --type ${JSON.stringify(forcedType)} (expected string, number, or bool)`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") return parsed;
  } catch {}
  return raw;
}

async function readOptionalTextBody(options: CliOptions, name: string): Promise<{ set: boolean; value: string }> {
  const stdinKey = `${name}-stdin`;
  const fileKey = `${name}-file`;
  const camelFileKey = `${name}File`;
  const sources = [hasOption(options, name), hasOption(options, stdinKey), hasOption(options, fileKey) || hasOption(options, camelFileKey)]
    .filter(Boolean).length;
  if (sources === 0) return { set: false, value: "" };
  if (sources > 1) throw new Error(`--${name}, --${stdinKey}, and --${fileKey} are mutually exclusive`);
  if (hasOption(options, stdinKey)) return { set: true, value: await readStdin() };
  const file = rawStringOption(options, fileKey, camelFileKey);
  if (file != null) return { set: true, value: readFileSync(file, "utf8") };
  const inline = rawStringOption(options, name);
  if (inline == null) throw new Error(`--${name} requires a value`);
  return { set: true, value: inline };
}

function addStringBodyField(
  body: Record<string, unknown>,
  options: CliOptions,
  bodyKey: string,
  optionKey: string,
  validateStatus = false,
  includeEmptyAsNull = false,
): void {
  if (!hasOption(options, optionKey)) return;
  const value = rawStringOption(options, optionKey);
  if (value == null) throw new Error(`--${optionKey} requires a value`);
  if (validateStatus && value && !VALID_ISSUE_STATUSES.includes(value)) {
    throw new Error(`invalid status ${JSON.stringify(value)}; valid values: ${VALID_ISSUE_STATUSES.join(", ")}`);
  }
  body[bodyKey] = value === "" && includeEmptyAsNull ? null : value;
}

function addAssigneeBodyFields(
  body: Record<string, unknown>,
  options: CliOptions,
  idKey: string,
  typeKey: string,
  nameKey: string,
): void {
  const id = rawStringOption(options, idKey, camelizeOptionKey(idKey)) ?? rawStringOption(options, nameKey);
  if (id == null) return;
  if (!id.trim()) throw new Error(`--${idKey} requires a value`);
  const type = rawStringOption(options, typeKey, camelizeOptionKey(typeKey)) ?? inferAssigneeTypeFromId(id);
  if (type && !VALID_ISSUE_ASSIGNEE_TYPES.includes(type)) {
    throw new Error(`invalid --${typeKey} ${JSON.stringify(type)}; expected agent, member, or squad`);
  }
  if (type) body.assignee_type = type;
  body.assignee_id = id;
}

function inferAssigneeTypeFromId(id: string): string | null {
  if (/^agt_/i.test(id)) return "agent";
  if (/^mem_/i.test(id)) return "member";
  if (/^sqd_/i.test(id)) return "squad";
  return null;
}

function subscriberBodyFromOptions(options: CliOptions): Record<string, unknown> {
  const memberId = rawStringOption(options, "user-id", "userId", "member-id", "memberId", "user");
  const body: Record<string, unknown> = {};
  if (memberId) body.member_id = memberId;
  return body;
}

function actorBodyFromOptions(options: CliOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const actorType = rawStringOption(options, "actor-type", "actorType");
  const actorId = rawStringOption(options, "actor-id", "actorId");
  if (actorType) body.actor_type = actorType;
  if (actorId) body.actor_id = actorId;
  return body;
}

function metadataFilterFromOptions(options: CliOptions): Record<string, string | number | boolean> | null {
  const raw = rawStringOption(options, "metadata");
  if (!raw) return null;
  const filter: Record<string, string | number | boolean> = {};
  for (const pair of raw.split(",")) {
    if (!pair.trim()) continue;
    const index = pair.indexOf("=");
    if (index <= 0) throw new Error(`--metadata ${JSON.stringify(pair)} must be in key=value form`);
    const key = pair.slice(0, index).trim();
    if (key in filter) throw new Error(`--metadata key ${JSON.stringify(key)} given more than once`);
    filter[key] = parseMetadataValue(pair.slice(index + 1), null);
  }
  return Object.keys(filter).length ? filter : null;
}

function addQueryParam(params: URLSearchParams, key: string, value: string | null): void {
  if (value !== null) params.set(key, value);
}

function integerOption(options: CliOptions, key: string): number | null {
  if (!hasOption(options, key)) return null;
  const value = rawStringOption(options, key);
  if (value == null) throw new Error(`--${key} must be an integer`);
  if (!/^-?\d+$/.test(value)) throw new Error(`--${key} must be an integer`);
  return Number.parseInt(value, 10);
}

function hasOption(options: CliOptions, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(options, key);
}

function rawStringOption(options: CliOptions, ...keys: string[]): string | null {
  for (const key of keys) {
    if (!hasOption(options, key)) continue;
    const value = options[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const last = value.at(-1);
      return typeof last === "string" ? last : null;
    }
    return null;
  }
  return null;
}

function stringListOption(options: CliOptions, ...keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    if (!hasOption(options, key)) continue;
    const value = options[key];
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) values.push(...value.filter((entry): entry is string => typeof entry === "string"));
  }
  return values;
}

function camelizeOptionKey(key: string): string {
  return key.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

async function readCommentBody(options: CliOptions): Promise<string> {
  const content = stringOpt(options.content, undefined);
  if (content != null) return content;
  const contentFile = stringOpt(options.contentFile ?? options["content-file"], undefined);
  if (contentFile) return readFileSync(contentFile, "utf8");
  if (Boolean(options.contentStdin ?? options["content-stdin"])) return await readStdin();
  throw new Error("comment body is required: pass --content, --content-file, or --content-stdin");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface CliAttachmentFile {
  path: string;
  filename: string;
  contentType: string;
  // Backed by a plain ArrayBuffer (not SharedArrayBuffer) so it is a valid BlobPart.
  data: Uint8Array<ArrayBuffer>;
}

interface MultiremiApiConnection {
  serverUrl: string;
  token: string | null;
  workspaceId: string | null;
}

function readAttachmentFiles(options: CliOptions): CliAttachmentFile[] {
  const files: CliAttachmentFile[] = [];
  for (const value of stringListOption(options, "attachment")) {
    const filePath = value.trim();
    if (!filePath) continue;
    if (isHttpUrl(filePath)) {
      console.error(`Skipping --attachment ${JSON.stringify(filePath)}: URLs are not supported here, only local file paths.`);
      continue;
    }
    let data: Buffer;
    try {
      data = readFileSync(filePath);
    } catch (err) {
      throw new Error(`read attachment ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const filename = basename(filePath) || "upload.bin";
    files.push({
      path: filePath,
      filename,
      contentType: detectCliContentTypeFromFilename(filename),
      data: new Uint8Array(data),
    });
  }
  return files;
}

async function multiremiApiUploadFile(attachmentFile: CliAttachmentFile, issueId: string, options: CliOptions): Promise<Record<string, unknown>> {
  const connection = multiremiApiConnection(options);
  const form = new FormData();
  form.append("file", new File([attachmentFile.data], attachmentFile.filename, { type: attachmentFile.contentType }));
  if (issueId) form.append("issue_id", issueId);
  if (connection.workspaceId) form.append("workspace_id", connection.workspaceId);
  const headers: Record<string, string> = {};
  if (connection.token) headers.Authorization = `Bearer ${connection.token}`;
  const response = await fetch(`${connection.serverUrl}/api/upload-file`, {
    method: "POST",
    headers,
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new MultiremiCliHttpError("POST", "/api/upload-file", response.status, text);
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

async function multiremiApiDownloadFile(downloadUrl: string, options: CliOptions): Promise<Buffer> {
  const connection = multiremiApiConnection(options);
  const isRelative = !/^https?:\/\//i.test(downloadUrl);
  const url = isRelative ? `${connection.serverUrl}${downloadUrl.startsWith("/") ? "" : "/"}${downloadUrl}` : downloadUrl;
  const headers: Record<string, string> = {};
  if (isRelative && connection.token) headers.Authorization = `Bearer ${connection.token}`;
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new MultiremiCliHttpError("GET", downloadUrl, response.status, text);
  }
  return Buffer.from(await response.arrayBuffer());
}

function multiremiApiConnection(options: CliOptions): MultiremiApiConnection {
  const config = loadMultiremiConfig();
  return {
    serverUrl: (
      stringOpt(options.server ?? options["server-url"], process.env.MULTIREMI_SERVER_URL)
      ?? config.server_url
      ?? `http://127.0.0.1:6120`
    ).replace(/\/+$/, ""),
    token: stringOpt(options.token, process.env.MULTIREMI_TOKEN) ?? config.token ?? null,
    workspaceId: stringOpt(options.workspace ?? options["workspace-id"], process.env.MULTIREMI_WORKSPACE_ID) ?? config.workspace_id ?? null,
  };
}

function isHttpUrl(value: string): boolean {
  const text = value.trim().toLowerCase();
  return text.startsWith("http://") || text.startsWith("https://");
}

function responseIssueId(value: unknown): string {
  const row = isRecord(value) && isRecord(value.issue) ? value.issue : value;
  const id = isRecord(row) ? attachmentStringField(row, "id", "issue_id", "issueId") : null;
  if (!id) throw new Error("create issue response missing issue id; cannot upload attachments");
  return id;
}

function normalizedAttachmentRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return isRecord(value.attachment) ? { ...value.attachment, ...value } : value;
}

function attachmentStringField(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function safeOutputFilename(value: string, fallback: string): string {
  const filename = basename(value).trim();
  return filename && filename !== "." ? filename : fallback;
}

function detectCliContentTypeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

type MultiremiCliHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

class MultiremiCliHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} returned ${status}: ${body}`);
  }
}

async function multiremiApiRequest<T = unknown>(
  method: MultiremiCliHttpMethod,
  path: string,
  body: unknown,
  options: CliOptions,
): Promise<T> {
  return (await multiremiApiFetch<T>(method, path, body, options)).data;
}

async function multiremiApiFetch<T = unknown>(
  method: MultiremiCliHttpMethod,
  path: string,
  body: unknown,
  options: CliOptions,
): Promise<{ data: T; headers: Headers }> {
  const connection = multiremiApiConnection(options);
  const headers: Record<string, string> = {};
  if (connection.token) headers.Authorization = `Bearer ${connection.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(connection.serverUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new MultiremiCliHttpError(method, path, response.status, text);
  return {
    data: text ? JSON.parse(text) as T : undefined as T,
    headers: response.headers,
  };
}

function outputMode(options: CliOptions, defaultMode: CliOutputMode = "json"): CliOutputMode {
  if (Boolean(options.json)) return "json";
  const output = stringOpt(options.output, undefined);
  if (!output) return defaultMode;
  if (output === "json") return "json";
  if (output === "table") return "table";
  throw new Error(`unsupported --output ${JSON.stringify(output)} (expected json or table)`);
}

function printIssueCollection(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printIssueTable(extractList(value, "issues"), { match: false, fullId: Boolean(options["full-id"] ?? options.fullId) });
}

function printIssueSearch(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printIssueTable(extractList(value, "issues"), { match: true, fullId: false });
}

function printTaskRuns(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value), [
    { header: "ID", value: (row) => displayTaskId(field(row, "id"), Boolean(options["full-id"] ?? options.fullId)), maxWidth: Boolean(options["full-id"] ?? options.fullId) ? 0 : 12 },
    { header: "AGENT", value: (row) => field(row, "agent_id", "agentId"), maxWidth: 18 },
    { header: "STATUS", value: (row) => field(row, "status") },
    { header: "STARTED", value: (row) => shortDate(field(row, "started_at", "startedAt", "created_at", "createdAt")) },
    { header: "COMPLETED", value: (row) => shortDate(field(row, "completed_at", "completedAt", "updated_at", "updatedAt")) },
    { header: "ERROR", value: (row) => field(row, "error", "error_message", "errorMessage"), maxWidth: 50 },
  ], "No task runs found.");
}

function printTaskMessages(value: unknown, options: CliOptions): void {
  if (outputMode(options) !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value), [
    { header: "SEQ", value: (row) => field(row, "seq") },
    { header: "TYPE", value: (row) => field(row, "type", "role") },
    { header: "TOOL", value: (row) => field(row, "tool", "tool_name", "toolName") },
    { header: "CONTENT", value: (row) => field(row, "content", "output", "body", "text"), maxWidth: 80 },
  ], "No task messages found.");
}

function printIssueComments(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value, "comments"), [
    { header: "ID", value: (row) => field(row, "id"), maxWidth: 18 },
    { header: "PARENT", value: (row) => field(row, "parent_id", "parentId") ?? "—", maxWidth: 18 },
    { header: "AUTHOR", value: (row) => assigneeLabel(field(row, "author_type", "authorType"), field(row, "author_id", "authorId")), maxWidth: 22 },
    { header: "TYPE", value: (row) => field(row, "type") },
    { header: "CONTENT", value: (row) => field(row, "content", "body"), maxWidth: 80 },
    { header: "CREATED", value: (row) => shortDate(field(row, "created_at", "createdAt")) },
  ], "No comments found.");
}

function printIssueSubscribers(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value, "subscribers"), [
    { header: "USER", value: (row) => assigneeLabel(field(row, "user_type", "userType"), field(row, "user_id", "userId", "member_id", "memberId")), maxWidth: 22 },
    { header: "REASON", value: (row) => field(row, "reason") },
    { header: "CREATED", value: (row) => shortDate(field(row, "created_at", "createdAt")) },
  ], "No subscribers found.");
}

function printIssueTable(rows: Record<string, unknown>[], options: { match: boolean; fullId: boolean }): void {
  if (options.match) {
    printTable(rows, [
      { header: "KEY", value: issueKey, maxWidth: 14 },
      { header: "TITLE", value: (row) => field(row, "title"), maxWidth: 72 },
      { header: "STATUS", value: (row) => field(row, "status") },
      { header: "MATCH", value: searchMatchInfo, maxWidth: 60 },
    ], "No issues found.");
    return;
  }
  printTable(rows, [
    { header: "KEY", value: issueKey, maxWidth: 14 },
    ...(options.fullId ? [{ header: "ID", value: (row: Record<string, unknown>) => field(row, "id"), maxWidth: 18 }] : []),
    { header: "TITLE", value: (row) => field(row, "title"), maxWidth: 72 },
    { header: "STATUS", value: (row) => field(row, "status") },
    { header: "PRIORITY", value: (row) => field(row, "priority") },
    { header: "ASSIGNEE", value: (row) => assigneeLabel(field(row, "assignee_type", "assigneeType"), field(row, "assignee_id", "assigneeId")), maxWidth: 24 },
    { header: "START DATE", value: (row) => dateOnly(field(row, "start_date", "startDate")) },
    { header: "DUE DATE", value: (row) => dateOnly(field(row, "due_date", "dueDate")) },
  ], "No issues found.");
}

interface TableColumn {
  header: string;
  value: (row: Record<string, unknown>) => unknown;
  maxWidth?: number;
}

function printTable(rows: Record<string, unknown>[], columns: TableColumn[], emptyMessage: string): void {
  if (rows.length === 0) {
    console.log(emptyMessage);
    return;
  }
  const rendered = rows.map((row) => columns.map((column) => tableCell(column.value(row), column.maxWidth)));
  const widths = columns.map((column, index) => {
    const maxCell = rendered.reduce((max, row) => Math.max(max, displayWidth(row[index] ?? "")), displayWidth(column.header));
    return column.maxWidth ? Math.min(column.maxWidth, maxCell) : maxCell;
  });
  const lines = [
    columns.map((column, index) => column.header.padEnd(widths[index]!)).join("  ").trimEnd(),
    ...rendered.map((row) => row.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd()),
  ];
  console.log(lines.join("\n"));
}

function extractList(value: unknown, key?: string): Record<string, unknown>[] {
  const source = key && isRecord(value) ? value[key] : value;
  if (!Array.isArray(source)) return [];
  return source.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function field(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function issueKey(row: Record<string, unknown>): unknown {
  return field(row, "identifier", "key", "issue_key", "issueKey", "id");
}

function searchMatchInfo(row: Record<string, unknown>): string {
  const source = tableCell(field(row, "match_source", "matchSource"));
  const snippet = tableCell(field(row, "matched_snippet", "matchedSnippet"), 50);
  if (snippet === "-") return source;
  if (source === "-") return snippet;
  return `${source}: ${snippet}`;
}

function assigneeLabel(type: unknown, id: unknown): string {
  const typeText = tableCell(type);
  const idText = tableCell(id);
  if (typeText === "-" && idText === "-") return "-";
  if (typeText === "-") return idText;
  if (idText === "-") return typeText;
  return `${typeText}:${idText}`;
}

function displayTaskId(value: unknown, fullId: boolean): string {
  const text = tableCell(value);
  if (fullId || text === "-") return text;
  if (text.length <= 12) return text;
  return text.slice(0, 12);
}

function dateOnly(value: unknown): string {
  const text = tableCell(value);
  if (text === "-") return text;
  return text.length >= 10 ? text.slice(0, 10) : text;
}

function shortDate(value: unknown): string {
  const text = tableCell(value);
  if (text === "-") return text;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  if (!match) return text;
  return match[2] ? `${match[1]} ${match[2]}` : match[1]!;
}

function tableCell(value: unknown, maxWidth = 0): string {
  let text: string;
  if (value === null || value === undefined || value === "") text = "-";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else text = JSON.stringify(value);
  text = text.replace(/\s+/g, " ").trim();
  if (maxWidth > 1 && displayWidth(text) > maxWidth) return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
  return text;
}

function displayWidth(value: string): number {
  return value.length;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function seed(options: CliOptions): void {
  const provider = stringOpt(options.provider, process.env.MULTIREMI_PROVIDER) ?? "claude";
  const store = new MultiremiStore();
  const agent = store.ensureDefaultAgent(provider);
  console.log(`Default ${provider} agent: ${agent.id}`);
}

function showHelp(programName = "remi multiremi"): void {
  console.log(`
Usage: ${programName} <command> [options]

Commands:
  setup                  Save server/workspace/token config
  login                  Save a personal access token
  config                 Show or update saved config
  serve                  Start Bun Multiremi API server
  daemon                 Manage the local Bun Multiremi runtime daemon
  daemon start           Start daemon in the background
  daemon stop            Stop the background daemon
  daemon restart         Restart the background daemon
  daemon status          Show daemon health
  daemon logs            Show daemon logs
  daemon service         Install, uninstall, or print a user-level service
  repo checkout <url>    Check out an allowed workspace repository
  attachment download <id> Download an attachment to a local file
  issue get <id>         Print an issue as JSON
  issue list             List issues
  issue create           Create an issue
  issue update <id>      Update an issue
  issue assign <id>      Assign or unassign an issue
  issue status <id> <s>  Change issue status
  issue delete <id>      Delete an issue
  issue search <query>   Search issues
  issue comment list <id> List issue comments
  issue comment add <id> Add an issue comment
  issue comment update <comment-id>
  issue comment delete <comment-id>
  issue comment resolve <comment-id>
  issue subscriber list <id>
  issue subscriber add <id> [--user-id <member-id>]
  issue subscriber remove <id> [--user-id <member-id>]
  issue runs <id>        List task runs for an issue
  issue run-messages <task-id>
  issue rerun <id>       Enqueue a fresh issue task
  issue cancel-task <task-id>
  issue metadata list <id> List issue metadata
  issue metadata get <id> --key <k>
  issue metadata set <id> --key <k> --value <v> [--type string|number|bool]
  issue metadata delete <id> --key <k>
  seed                   Create a default local agent
  version                Print Multiremi version

Options:
  --port <number>        API port for serve (default: 6120)
  --host <address>       API listen host for serve (default: 0.0.0.0)
  --token <token>        Bearer token for server/daemon auth
  --server <url>         Daemon server URL (default: http://127.0.0.1:6120)
  --output json|table    Output format for supported read commands
  --full-id              Show full IDs in supported table output
  --attachment <path>    Attach a local file to issue create/comment add (repeatable)
  --output-dir <dir>     Directory for attachment download
  --provider <name>      Limit daemon to one provider: claude or codex (default: auto-detect)
  --workspace <id>       Workspace id (default: local)
  --runtime-id <id>      Reuse a fixed runtime id
  --daemon-id <id>       Stable daemon id for local directory resources
  --daemon-port <number> Local daemon helper port (default: 6131)
  --repo-cache-root <p>  Local bare repository cache root
  --name <name>          Runtime display name
  --start                Start daemon in the background after setup
  --foreground           Run daemon in the current terminal
  --once                 Daemon exits after one poll/claimed task
  --lines <number>       Log lines for daemon logs (default: 50)
  --follow               Follow daemon logs
  --platform <name>      Service platform: launchd or systemd
  --service-dir <dir>    Directory for daemon service files
  --enable               Enable service after daemon service install
  --disable              Disable service before daemon service uninstall
`);
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? "help";
  const options: CliOptions = {};
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 2) {
      setParsedOption(options, arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      setParsedOption(options, key, next);
      i++;
    } else {
      setParsedOption(options, key, true);
    }
  }
  return { command, options, positional };
}

function setParsedOption(options: CliOptions, key: string, value: string | boolean): void {
  const current = options[key];
  if (current === undefined) {
    options[key] = value;
    return;
  }
  const nextValue = typeof value === "string" ? value : String(value);
  if (Array.isArray(current)) {
    current.push(nextValue);
    return;
  }
  options[key] = [String(current), nextValue];
}

export function buildMultiremiDaemonLaunchSpec(
  options: CliOptions = {},
  programName = "multiremi",
  argv = process.argv,
  execPath = process.execPath,
): MultiremiDaemonLaunchSpec {
  const launcher = currentProcessLauncher(argv, execPath);
  const port = daemonPortFromOptions(options);
  const paths = multiremiDaemonPaths();
  return {
    command: launcher.command,
    args: [
      ...launcher.argsPrefix,
      ...programSubcommandPrefix(programName),
      ...buildDaemonForegroundArgs(options),
    ],
    env: daemonLaunchEnv(options),
    stateDir: paths.stateDir,
    logPath: paths.logPath,
    pidPath: paths.pidPath,
    port,
  };
}

export function buildMultiremiDaemonServiceSpec(
  options: CliOptions = {},
  programName = "multiremi",
  platform = detectMultiremiServicePlatform(),
  homeDir = homedir(),
  argv = process.argv,
  execPath = process.execPath,
): MultiremiDaemonServiceSpec {
  if (stringOpt(options.token, undefined)) {
    throw new Error("daemon service install does not write tokens into service files; run `multiremi login --token <token>` first");
  }
  const spec = buildMultiremiDaemonLaunchSpec(options, programName, argv, execPath);
  const serviceDir = stringOpt(options.serviceDir ?? options["service-dir"], undefined);
  const path = multiremiDaemonServicePath(platform, homeDir, serviceDir);
  const label = "dev.remi.multiremi.daemon";
  const unitName = "multiremi-daemon.service";
  const env = {
    ...spec.env,
    MULTIREMI_STATE_DIR: spec.stateDir,
  };
  const content = platform === "launchd"
    ? renderLaunchdService({ label, spec, env })
    : renderSystemdService({ spec, env });
  return {
    platform,
    label,
    unitName,
    path,
    content,
    enableCommands: platform === "launchd"
      ? launchdEnableCommands(label, path)
      : [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", unitName]],
    disableCommands: platform === "launchd"
      ? launchdDisableCommands(label)
      : [["systemctl", "--user", "disable", "--now", unitName], ["systemctl", "--user", "daemon-reload"]],
  };
}

export function detectMultiremiServicePlatform(platform = process.platform): MultiremiDaemonServicePlatform {
  return platform === "darwin" ? "launchd" : "systemd";
}

function servicePlatformFromOptions(options: CliOptions): MultiremiDaemonServicePlatform {
  const platform = stringOpt(options.platform, undefined);
  if (!platform) return detectMultiremiServicePlatform();
  if (platform === "launchd" || platform === "systemd") return platform;
  throw new Error("invalid daemon service platform; expected launchd or systemd");
}

export function multiremiDaemonServicePath(
  platform: MultiremiDaemonServicePlatform,
  homeDir = homedir(),
  serviceDir?: string | null,
): string {
  if (serviceDir) {
    return join(serviceDir, platform === "launchd" ? "dev.remi.multiremi.daemon.plist" : "multiremi-daemon.service");
  }
  if (platform === "launchd") return join(homeDir, "Library", "LaunchAgents", "dev.remi.multiremi.daemon.plist");
  return join(homeDir, ".config", "systemd", "user", "multiremi-daemon.service");
}

export function buildDaemonForegroundArgs(options: CliOptions = {}): string[] {
  const args = ["daemon", "start", "--foreground"];
  pushStringOption(args, "--server", options.server ?? options["server-url"]);
  pushStringOption(args, "--workspace", options.workspace ?? options["workspace-id"]);
  pushStringOption(args, "--provider", options.provider);
  pushStringOption(args, "--runtime-id", options.runtimeId ?? options["runtime-id"]);
  pushStringOption(args, "--daemon-id", options.daemonId ?? options["daemon-id"]);
  pushStringOption(args, "--daemon-port", options.daemonPort ?? options["daemon-port"]);
  pushStringOption(args, "--repo-cache-root", options.repoCacheRoot ?? options["repo-cache-root"]);
  pushStringOption(args, "--name", options.name ?? options["runtime-name"]);
  pushStringOption(args, "--max-concurrency", options["max-concurrency"] ?? options.maxConcurrency);
  pushStringOption(args, "--log-level", options.logLevel ?? options["log-level"]);
  return args;
}

export function multiremiDaemonPaths(stateDir = process.env.MULTIREMI_STATE_DIR ?? join(homedir(), ".multiremi")): {
  stateDir: string;
  pidPath: string;
  logPath: string;
} {
  return {
    stateDir,
    pidPath: join(stateDir, "daemon.pid"),
    logPath: join(stateDir, "daemon.log"),
  };
}

function stringOpt(value: unknown, fallback?: string): string | null {
  const optionValue = Array.isArray(value) ? value.at(-1) : value;
  const raw = typeof optionValue === "string" ? optionValue : fallback;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function numberOpt(value: unknown, fallback: string | undefined, defaultValue: number): number {
  const raw = typeof value === "string" ? value : fallback;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function daemonPortFromOptions(options: CliOptions): number {
  return numberOpt(options.daemonPort ?? options["daemon-port"], process.env.MULTIREMI_DAEMON_PORT, DEFAULT_DAEMON_PORT);
}

function daemonLaunchEnv(options: CliOptions): Record<string, string> {
  const env: Record<string, string> = {};
  const token = stringOpt(options.token, undefined);
  if (token) env.MULTIREMI_TOKEN = token;
  return env;
}

function renderLaunchdService(input: {
  label: string;
  spec: MultiremiDaemonLaunchSpec;
  env: Record<string, string>;
}): string {
  const argv = [input.spec.command, ...input.spec.args]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(input.env)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");
  const envBlock = envEntries
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
${envBlock}  <key>WorkingDirectory</key>
  <string>${escapeXml(input.spec.stateDir)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(input.spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(input.spec.logPath)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

function renderSystemdService(input: {
  spec: MultiremiDaemonLaunchSpec;
  env: Record<string, string>;
}): string {
  const execStart = [input.spec.command, ...input.spec.args].map(systemdQuote).join(" ");
  const envLines = Object.entries(input.env)
    .map(([key, value]) => `Environment="${systemdEnvironmentEscape(key)}=${systemdEnvironmentEscape(value)}"`)
    .join("\n");
  return `[Unit]
Description=Multiremi daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${systemdQuote(input.spec.stateDir)}
${envLines}
Restart=always
RestartSec=10
StandardOutput=append:${input.spec.logPath}
StandardError=append:${input.spec.logPath}

[Install]
WantedBy=default.target
`;
}

function launchdEnableCommands(label: string, path: string): string[][] {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return [["launchctl", "load", "-w", path]];
  return [
    ["launchctl", "bootstrap", `gui/${uid}`, path],
    ["launchctl", "enable", `gui/${uid}/${label}`],
  ];
}

function launchdDisableCommands(label: string): string[][] {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return [["launchctl", "unload", "-w", multiremiDaemonServicePath("launchd")]];
  return [["launchctl", "bootout", `gui/${uid}/${label}`]];
}

function runServiceCommands(commands: string[][]): void {
  for (const [command, ...args] of commands) {
    execFileSync(command, args, { stdio: "inherit" });
  }
}

function currentProcessLauncher(argv: string[], execPath: string): { command: string; argsPrefix: string[] } {
  const executable = basename(execPath, extname(execPath)).toLowerCase();
  const script = argv[1];
  if ((executable === "bun" || executable.startsWith("bun-")) && script) {
    return { command: execPath, argsPrefix: [script] };
  }
  return { command: execPath, argsPrefix: [] };
}

function programSubcommandPrefix(programName: string): string[] {
  const parts = programName.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1) : [];
}

function pushStringOption(args: string[], flag: string, value: unknown): void {
  const option = stringOpt(value, undefined);
  if (option) args.push(flag, option);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function systemdQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value.replace(/%/g, "%%");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%")}"`;
}

function systemdEnvironmentEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function managedDaemonPorts(basePort: number): number[] {
  if (basePort === 0) return [0];
  return SUPPORTED_DAEMON_PROVIDERS.map((_, index) => basePort + index);
}

async function checkManagedDaemonHealth(basePort: number): Promise<Array<{ port: number; health: MultiremiDaemonHealth }>> {
  const entries = await Promise.all(managedDaemonPorts(basePort).map(async (port) => ({
    port,
    health: await checkDaemonHealth(port),
  })));
  return entries;
}

async function waitForDaemonReady(port: number, timeoutMs: number): Promise<MultiremiDaemonHealth> {
  const deadline = Date.now() + timeoutMs;
  let last: MultiremiDaemonHealth = { status: "stopped" };
  while (Date.now() < deadline) {
    last = await checkDaemonHealth(port);
    if (last.status === "running") return last;
    await sleep(500);
  }
  return last;
}

async function checkDaemonHealth(port: number): Promise<MultiremiDaemonHealth> {
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/health`, { method: "GET" }, 2_000);
    if (!response.ok) return { status: "stopped", error: `health returned ${response.status}` };
    return await response.json() as MultiremiDaemonHealth;
  } catch (err) {
    return { status: "stopped", error: err instanceof Error ? err.message : String(err) };
  }
}

async function requestDaemonShutdown(port: number): Promise<void> {
  const response = await fetchWithTimeout(`http://127.0.0.1:${port}/shutdown`, { method: "POST" }, 2_000);
  if (!response.ok) throw new Error(`shutdown returned ${response.status}`);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function daemonAlive(health: MultiremiDaemonHealth): boolean {
  return health.status === "running" || health.status === "starting";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function detectMultiremiProviders(options: {
  pathEnv?: string;
  pathExt?: string;
  canExecute?: (path: string) => boolean;
} = {}): SupportedDaemonProvider[] {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const canExecute = options.canExecute ?? isExecutable;
  const paths = pathEnv.split(delimiter).filter(Boolean);
  const extensions = executableExtensions(options.pathExt);
  return SUPPORTED_DAEMON_PROVIDERS.filter((provider) => {
    const commands = provider === "claude"
      ? ["remi-claude-agent-acp", "claude-agent-acp", "claude"]
      : ["codex-acp", "codex"];
    return paths.some((dir) => commands.some((command) => {
      return extensions.some((extension) => canExecute(join(dir, `${command}${extension}`)));
    }));
  });
}

async function resolveHealthyDaemonProviders(explicitProvider: SupportedDaemonProvider | null): Promise<SupportedDaemonProvider[]> {
  const candidates = explicitProvider ? [explicitProvider] : detectMultiremiProviders();
  const healthy: SupportedDaemonProvider[] = [];
  for (const provider of candidates) {
    const checker = new AcpProvider({ agentType: provider });
    try {
      if (await checker.healthCheck()) {
        healthy.push(provider);
      } else if (explicitProvider) {
        throw new Error(`Multiremi provider ${provider} failed ACP health check`);
      }
    } finally {
      await checker.close?.();
    }
  }
  return healthy;
}

function isSupportedDaemonProvider(provider: string): provider is SupportedDaemonProvider {
  return (SUPPORTED_DAEMON_PROVIDERS as readonly string[]).includes(provider);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableExtensions(pathExt?: string): string[] {
  if (process.platform !== "win32") return [""];
  const extensions = (pathExt ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return ["", ...extensions];
}

function formatRuntimeName(baseName: string | undefined, provider: string): string {
  return `${baseName ?? `${Bun.env.USER ?? "local"}-bun-runtime`}-${provider}`;
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
