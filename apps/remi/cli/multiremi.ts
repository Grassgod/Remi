/**
 * `remi multiremi` — CLI entry facade.
 *
 * Command dispatch, config/setup commands and daemon lifecycle live here; the
 * REST command handlers, HTTP client, output rendering, service templating and
 * daemon health probing live in `./multiremi/`.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname } from "node:path";
import {
  MultiremiDaemon,
  startMultiremiServer,
  MultiremiStore,
} from "@multiremi/index.js";
import type { MultiremiDaemonOptions } from "@multiremi/daemon.js";
import type {
  FeishuBotSessionSnapshot,
} from "@multiremi/contracts/types.js";
import type { TaskStreamingHandler, TaskStreamEvent } from "@connectors/base.js";
import { MultiremiCliUpdateCoordinator } from "@multiremi/worker/cli-update-coordinator.js";
import { setLogLevel } from "@shared/logger.js";
import { multiremiVersion } from "@multiremi/version.js";
import {
  loadMultiremiConfig,
  multiremiConfigPath,
  redactMultiremiConfig,
  saveMultiremiConfig,
  type MultiremiCliConfig,
} from "@multiremi/config.js";
import { bootFeishuChannel, type FeishuChannelHandle } from "./agent.js";
import { FeishuConciergeError, type FeishuConciergeHost } from "@multiremi/worker/feishu-concierge.js";
import { ensureAcpBridges, type ProvisionProvider } from "@acp/provision.js";
import { IssueWorkspaceLifecycleLocker } from "@daemon/agent-runtime/workspace/lifecycle-lock.js";
import {
  acquireWorkspaceSupervisorLease,
  configuredMultiremiWorkspacesRoot,
  type WorkspaceSupervisorLease,
} from "@daemon/agent-runtime/workspace/process-owner.js";
import { type CliOptions, numberOpt, parseArgs, stringOpt } from "./multiremi/options.js";
import {
  SUPPORTED_DAEMON_PROVIDERS,
  type SupportedDaemonProvider,
  checkManagedDaemonHealth,
  daemonAlive,
  daemonSupervisorReady,
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
import { memory, wiki } from "./multiremi/commands/knowledge.js";

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

// A cold start may download Node and install both ACP bridges before the
// supervisor can become ready. Leave headroom above their command timeouts.
const DEFAULT_STARTUP_TIMEOUT_MS = 12 * 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const SUPERVISOR_INSTANCE_ENV = "MULTIREMI_SUPERVISOR_INSTANCE_ID";

export async function runMultiremi(args: string[], runOptions: RunMultiremiOptions = {}): Promise<void> {
  const parsed = parseArgs(args);
  setLogLevel(String(parsed.options.logLevel ?? parsed.options["log-level"] ?? process.env.REMI_LOG_LEVEL ?? "INFO"));
  const programName = runOptions.programName ?? "remi multiremi";

  switch (parsed.command) {
    case "setup":
      if (!setup(parsed.options, programName)) return;
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
    case "memory":
      await memory(parsed.positional, parsed.options);
      return;
    case "wiki":
      await wiki(parsed.positional, parsed.options);
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

function setup(options: CliOptions, programName: string): boolean {
  if (options.help || options.h) {
    showHelp(programName);
    return false;
  }
  const current = loadMultiremiConfig();
  const next = resolveSetupConfig(current, options);

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
  console.log("Ready. Start the agent with:  remi daemon start");
  return true;
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
    const allowed = ["server_url", "workspace_id", "token", "provider", "runtime_id", "runtime_name", "device_name", "max_concurrency"];
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
export interface WorkerDaemonSupervisorOptions {
  workspacesRoot?: string;
  workspaceRootFence?: () => void;
  onRestartRequested?: () => void;
  issueWorkspaceLifecycleLocker?: IssueWorkspaceLifecycleLocker;
}

function configuredWorkerWorkspaceId(
  options: CliOptions,
  config: MultiremiCliConfig,
): string | undefined {
  return stringOpt(options.workspace, process.env.MULTIREMI_WORKSPACE_ID)
    ?? config.workspace_id
    ?? undefined;
}

export async function resolveWorkerDaemons(
  options: CliOptions,
  supervisor: WorkerDaemonSupervisorOptions = {},
): Promise<MultiremiDaemon[]> {
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
  const deviceName = resolveDeviceName(options, config);
  // 0 = "unset" → the daemon defaults to CPU-1 (resolveDaemonConcurrency).
  const maxConcurrency = numberOpt(options["max-concurrency"] ?? options.maxConcurrency, process.env.MULTIREMI_MAX_CONCURRENCY, config.max_concurrency ?? 0);
  const baseDaemonPort = daemonPortFromOptions(options);
  const daemons: MultiremiDaemon[] = [];
  const stopAllForRestart = () => {
    for (const runtimeDaemon of daemons) runtimeDaemon.stop();
    supervisor.onRestartRequested?.();
  };
  const daemonOptions = providers.map((provider): MultiremiDaemonOptions => ({
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
    workspaceId: configuredWorkerWorkspaceId(options, config) ?? "local",
    issueWorkspaceLifecycleLocker: supervisor.issueWorkspaceLifecycleLocker,
    daemonPort: providers.length > 1 && baseDaemonPort !== 0 ? baseDaemonPort + providers.indexOf(provider) : baseDaemonPort,
    workspacesRoot: supervisor.workspacesRoot,
    workspaceRootFence: supervisor.workspaceRootFence,
    repoCacheRoot: stringOpt(options.repoCacheRoot ?? options["repo-cache-root"], process.env.MULTIREMI_REPO_CACHE_ROOT) ?? undefined,
    once: Boolean(options.once),
    onRestartRequested: stopAllForRestart,
  }));
  daemons.push(...instantiateCoResidentWorkerDaemons(daemonOptions));
  return daemons;
}

/** Construct provider daemons that share one local Issue workspace tree. */
export function instantiateCoResidentWorkerDaemons(
  options: MultiremiDaemonOptions[],
): MultiremiDaemon[] {
  // Claude and Codex are separate daemon instances but their provider
  // lifecycle and GC must cross the same archive-and-delete barrier.
  const issueWorkspaceLifecycleLocker = options[0]?.issueWorkspaceLifecycleLocker
    ?? new IssueWorkspaceLifecycleLocker();
  const cliUpdateCoordinator = options.length > 1
    ? new MultiremiCliUpdateCoordinator()
    : null;
  const readyProviders = new Set<number>();
  const gcLeaderIndex = options.findIndex((daemonOptions) => daemonOptions.gcEnabled !== false);
  return options.map((daemonOptions, index) => {
    const extraReadyCheck = daemonOptions.supervisorReady;
    const notifyReadyChange = daemonOptions.onReadyChange;
    return new MultiremiDaemon({
      ...daemonOptions,
      issueWorkspaceLifecycleLocker,
      ...(cliUpdateCoordinator ? { cliUpdateCoordinator } : {}),
      // Provider lanes share one Issue workspace tree. A single lane owns its
      // periodic GC so Claude and Codex cannot duplicate the same archive and
      // repository maintenance pass inside one Bun process.
      gcEnabled: index === gcLeaderIndex ? daemonOptions.gcEnabled : false,
      supervisorReady: () =>
        readyProviders.size === options.length && (extraReadyCheck?.() ?? true),
      onReadyChange: (ready) => {
        if (ready) readyProviders.add(index);
        else readyProviders.delete(index);
        notifyReadyChange?.(ready);
      },
    });
  });
}

async function runDaemonForeground(options: CliOptions, programName: string): Promise<void> {
  let workspaceSupervisor: WorkspaceSupervisorLease | null = acquireWorkspaceSupervisorLease(
    configuredMultiremiWorkspacesRoot(),
    { basePort: daemonPortFromOptions(options) },
  );
  let daemons: MultiremiDaemon[] = [];
  let feishu: Awaited<ReturnType<typeof bootFeishuChannel>> | null = null;
  let stopAll = (): void => {};
  let signalsRegistered = false;
  let ownerWatch: ReturnType<typeof setInterval> | null = null;
  let ownershipFailure: unknown = null;
  let restartRequested = false;
  try {
    const issueWorkspaceLifecycleLocker = new IssueWorkspaceLifecycleLocker();
    const conciergeFromControlPlane = !Boolean(options.once);
    daemons = await resolveWorkerDaemons(options, {
      workspacesRoot: workspaceSupervisor.workspaceRoot,
      workspaceRootFence: () => workspaceSupervisor?.assertOwner(),
      issueWorkspaceLifecycleLocker,
      // Provider updates must stop the whole supervisor, including Feishu.
      onRestartRequested: () => stopAll(),
    });
    // Co-resident Feishu requires the daemon's authenticated workspace control
    // plane because every message is submitted through the canonical Task API.
    if (daemons.length === 0) {
      workspaceSupervisor.release();
      workspaceSupervisor = null;
    }
    if (daemons.length === 0) {
      throw new Error(`Nothing to start: no healthy runtime provider (install/authenticate one of: ${SUPPORTED_DAEMON_PROVIDERS.join(", ")}) and Feishu is not configured.`);
    }

    /**
     * Tear down whichever concierge is running. The supervisor goes first so
     * the control plane hears `stopped` from this Runtime before the process
     * disappears; otherwise a workspace whose bot was moved elsewhere waits out
     * the staleness window before the new Runtime is allowed to start.
     */
    const stopFeishu = async (): Promise<void> => {
      await daemons[0]?.shutdownFeishuConcierge();
      const handle = feishu;
      feishu = null;
      if (handle) await handle.stop();
    };
    stopAll = (): void => {
      for (const runtimeDaemon of daemons) runtimeDaemon.stop();
      stopFeishu().catch(() => {});
    };
    process.on("SIGINT", stopAll);
    process.on("SIGTERM", stopAll);
    signalsRegistered = true;
    if (workspaceSupervisor) {
      ownerWatch = setInterval(() => {
        try {
          workspaceSupervisor?.assertOwner();
        } catch (error) {
          if (ownershipFailure) return;
          ownershipFailure = error;
          for (const runtimeDaemon of daemons) {
            runtimeDaemon.stopForWorkspaceOwnershipLoss(error);
          }
          stopFeishu().catch(() => {});
        }
      }, 250);
      ownerWatch.unref?.();
    }

    const providerRuns = daemons.map((runtimeDaemon) => runtimeDaemon.start());
    const running: Promise<void>[] = [...providerRuns];
    try {
      if (conciergeFromControlPlane) {
        daemons[0]!.setFeishuConciergeHost(controlPlaneConciergeHost({
          daemon: () => daemons[0],
          workspacesRoot: () => workspaceSupervisor?.workspaceRoot,
          current: () => feishu,
          attach: (handle) => { feishu = handle; },
        }));
      }
      stopChannelWhenProvidersFinish(providerRuns, { stop: stopFeishu });
      await Promise.all(running);
    } catch (error) {
      // Promise.all returns on the first provider failure. Keep ownership until
      // every co-resident provider has drained its tasks and archive/GC pass.
      stopAll();
      await Promise.allSettled(running);
      throw error;
    }
    if (ownershipFailure) throw ownershipFailure;
    restartRequested = !Boolean(options.once)
      && daemons.some((runtimeDaemon) => runtimeDaemon.restartRequested());
  } finally {
    if (ownerWatch) clearInterval(ownerWatch);
    if (signalsRegistered) {
      process.off("SIGINT", stopAll);
      process.off("SIGTERM", stopAll);
    }
    workspaceSupervisor?.release();
  }
  if (restartRequested) {
    restartForegroundDaemonProcess(options, programName);
  }
}

/**
 * Host the Workspace-configured Feishu concierge (MUL-206).
 *
 * The supervisor in `packages/server/src/worker/feishu-concierge.ts` decides
 * *whether* the bot should run; this decides *how* to boot its transport.
 * Everything the channel needs — the Agent row and credentials — arrives in
 * the assignment, so
 * switching the workspace to a different bot or a different Agent never
 * requires touching this machine.
 *
 * The accessors exist because `runDaemonForeground` owns the daemon list, the
 * workspace lease and the channel handle, and any of them can be replaced while
 * the process runs; reading them at call time is what keeps a restart from
 * binding to a stale one.
 */
export function controlPlaneConciergeHost(deps: {
  daemon: () => MultiremiDaemon | undefined;
  workspacesRoot: () => string | undefined;
  current: () => FeishuChannelHandle | null;
  attach: (handle: FeishuChannelHandle | null) => void;
  /** Overridden by tests; booting a real channel needs a Feishu app. */
  boot?: typeof bootFeishuChannel;
}): FeishuConciergeHost {
  const boot = deps.boot ?? bootFeishuChannel;
  return {
    async start(assignment) {
      const daemon = deps.daemon();
      const workspacesRoot = deps.workspacesRoot();
      // The daemon and workspace root are still mandatory because the channel
      // submits every message through the canonical Chat/Task path. Sender
      // identity and membership are classified there using union_id; an
      // app-scoped open_id must not be used as an admission gate.
      if (!daemon || !workspacesRoot) {
        throw new FeishuConciergeError(
          "the Multiremi daemon is not available to run Feishu tasks",
          "runtime_unavailable",
        );
      }
      const { config, agent } = assignment;
      const handle = await boot(
        async () => true,
        {
          daemonPort: daemon.localPort(),
          workspacesRoot,
          ensureTopicWorkspace: (sessionKey, topicId) => daemon.ensureTopicWorkspace(sessionKey, topicId),
          credentials: {
            appId: config.app_id,
            appSecret: config.app_secret,
            domain: config.domain,
          },
          taskHandler: createFeishuTaskHandler(daemon, config.revision, agent.name),
          abortTask: async (sessionKey) => {
            await daemon.cancelFeishuBotSessionTask(config.revision, sessionKey);
          },
        },
      );
      deps.attach(handle);
      daemon.setBotMenuPublisher(handle.publishBotMenu);
      // `handle.start` runs for the life of the channel. Nobody awaits it here —
      // the daemon loop owns the process lifetime — so a connector that dies on
      // its own is reported back rather than leaving the settings page showing
      // `online` for a bot that stopped answering.
      void handle.start.catch((error: unknown) => {
        if (deps.current() !== handle) return;
        deps.attach(null);
        daemon.setBotMenuPublisher(null);
        void daemon.reportFeishuConciergeFailure(error);
      });
      return { botName: agent.name };
    },
    async stop() {
      const handle = deps.current();
      deps.attach(null);
      deps.daemon()?.setBotMenuPublisher(null);
      if (handle) await handle.stop();
    },
    async sendOutbound(delivery) {
      const handle = deps.current();
      if (!handle) throw new Error("Feishu concierge channel is not running");
      return handle.sendProactiveThreadReply({
        chatId: delivery.chatId,
        replyToMessageId: delivery.replyToMessageId ?? undefined,
        body: delivery.body,
        idempotencyKey: delivery.idempotencyKey,
      });
    },
  };
}

function createFeishuTaskHandler(
  daemon: MultiremiDaemon,
  revision: number,
  displayName: string,
): TaskStreamingHandler {
  return async (message, sessionKey, consumer) => {
    const command = message.text.trim().toLowerCase();
    if (command === "/new") {
      await daemon.cancelFeishuBotSessionTask(revision, sessionKey);
      const reset = await daemon.resetFeishuBotSession(revision, sessionKey);
      await consumer(singleMessageStream(reset ? "New conversation started." : "Conversation is already new."), {
        taskId: "feishu-command-new",
        displayName,
        respondHumanRequest: async () => { throw new Error("command has no human request"); },
      });
      return;
    }
    if (command === "/status" || command === "/sessions" || command === "/context") {
      const snapshot = await daemon.inspectFeishuBotSession(revision, sessionKey);
      await consumer(singleMessageStream(renderFeishuSessionCommand(command, snapshot)), {
        taskId: `feishu-command-${command.slice(1)}`,
        displayName,
        respondHumanRequest: async () => { throw new Error("command has no human request"); },
      });
      return;
    }
    if (command === "/cwd" || command === "/compact") {
      await consumer(singleMessageStream(`${command} is no longer supported.`), {
        taskId: "feishu-command-removed",
        displayName,
        respondHumanRequest: async () => { throw new Error("command has no human request"); },
      });
      return;
    }

    const externalMessageId = String(message.metadata?.messageId ?? "").trim();
    if (!externalMessageId) throw new Error("Feishu message id is missing");
    const submitted = await daemon.submitFeishuBotMessage({
      revision,
      externalSessionKey: sessionKey,
      externalMessageId,
      replyToMessageId: externalMessageId,
      senderOpenId: String(message.metadata?.senderOpenId ?? "").trim() || null,
      senderUserId: String(message.metadata?.senderUserId ?? "").trim() || null,
      senderUnionId: String(message.metadata?.senderUnionId ?? "").trim() || null,
      senderTenantKey: String(message.metadata?.senderTenantKey ?? "").trim() || null,
      senderName: String(message.metadata?.senderName ?? "").trim() || null,
      chatId: message.chatId,
      threadId: String(message.metadata?.rootId ?? "").trim() || null,
      text: message.text,
    });
    // A live Task already has the card created by its first event. The steer is
    // persisted and injected by the normal Task worker; do not replay it into a
    // second card.
    if (submitted.steered || submitted.duplicate) return;

    await consumer(pollFeishuTask(daemon, submitted.taskId), {
      taskId: submitted.taskId,
      displayName,
      respondHumanRequest: (requestId, response) =>
        daemon.respondFeishuBotHumanRequest(submitted.taskId, requestId, response),
    });
  };
}

function renderFeishuSessionCommand(command: string, snapshot: FeishuBotSessionSnapshot): string {
  if (!snapshot.chatSessionId) return "No conversation has been started yet.";
  const task = snapshot.task;
  if (command === "/sessions") {
    return [
      `Conversation: ${snapshot.chatSessionId}`,
      task ? `Latest task: ${task.taskId} (${task.status})` : "Latest task: none",
    ].join("\n");
  }
  if (command === "/context") {
    if (!task) return `Conversation: ${snapshot.chatSessionId}\nContext usage: no task usage yet.`;
    const input = task.usage.reduce((sum, entry) => sum + entry.inputTokens, 0);
    const output = task.usage.reduce((sum, entry) => sum + entry.outputTokens, 0);
    const total = task.usage.reduce(
      (sum, entry) => sum + (
        entry.totalTokens && entry.totalTokens > 0
          ? entry.totalTokens
          : entry.inputTokens + entry.outputTokens
      ),
      0,
    );
    return `Context usage: ${total} tokens (${input} input, ${output} output)`;
  }
  return [
    `Conversation: ${snapshot.chatSessionId}`,
    task ? `Task: ${task.taskId}` : "Task: none",
    task ? `Status: ${task.status}` : "Status: idle",
    task?.workDir ? `Working directory: ${task.workDir}` : "Working directory: not created yet",
  ].join("\n");
}

async function* pollFeishuTask(
  daemon: MultiremiDaemon,
  taskId: string,
): AsyncGenerator<TaskStreamEvent> {
  let sinceSeq = 0;
  for (;;) {
    const messages = await daemon.listFeishuBotTaskMessages(taskId, sinceSeq);
    for (const message of messages) {
      sinceSeq = Math.max(sinceSeq, message.seq);
      yield { kind: "message", message };
    }
    const snapshot = await daemon.getFeishuBotTaskSnapshot(taskId);
    if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "cancelled") {
      // Completion and Task messages commit together, but they are read over
      // separate HTTP calls. Drain once more so a completion that landed
      // between the first list and this snapshot cannot hide the final tool,
      // thinking, or text events.
      const finalMessages = await daemon.listFeishuBotTaskMessages(taskId, sinceSeq);
      for (const message of finalMessages) {
        sinceSeq = Math.max(sinceSeq, message.seq);
        yield { kind: "message", message };
      }
      yield { kind: "snapshot", snapshot };
      return;
    }
    await sleep(400);
  }
}

async function* singleMessageStream(text: string): AsyncGenerator<TaskStreamEvent> {
  yield {
    kind: "message",
    message: {
      id: "feishu-command-message",
      taskId: "feishu-command",
      seq: 1,
      type: "text",
      tool: null,
      content: text,
      input: null,
      output: null,
      toolCallId: null,
      status: null,
      meta: null,
      createdAt: new Date().toISOString(),
    },
  };
  yield {
    kind: "snapshot",
    snapshot: {
      taskId: "feishu-command",
      status: "completed",
      result: text,
      error: null,
      sessionId: null,
      workDir: null,
      usage: [],
    },
  };
}

export function stopChannelWhenProvidersFinish(
  providerRuns: Promise<void>[],
  channel: { stop(): Promise<void> } | null,
): void {
  if (!channel || providerRuns.length === 0) return;
  // A terminal-authority provider exit is a clean resolution, not a rejection.
  // Tie the co-resident channel to the provider group so it cannot keep the
  // process and workspace lease alive after every worker control port closes.
  void Promise.all(providerRuns)
    .then(() => channel.stop())
    .catch(() => {
      // Provider failures are handled by runDaemonForeground's stop-and-drain.
    });
}

async function startDaemonBackground(options: CliOptions, programName: string): Promise<void> {
  const spec = buildMultiremiDaemonLaunchSpec(options, programName);
  const startupTimeoutMs = daemonStartupTimeoutMs(options);
  if (spec.port === 0) throw new Error("--daemon-port 0 requires --foreground because background daemon control needs a stable port");
  const live = await checkManagedDaemonHealth(spec.port);
  const running = live.find((entry) => daemonAlive(entry.health));
  if (running) {
    throw new Error(`Multiremi daemon is already running on port ${running.port} (pid ${running.health.pid ?? "unknown"}). Use 'multiremi daemon restart' to restart it.`);
  }

  mkdirSync(spec.stateDir, { recursive: true });
  const logFd = openSync(spec.logPath, "a", 0o644);
  let child: ChildProcess | null = null;
  let childPid = 0;
  let exitedBeforeReady: Promise<never> | null = null;
  const supervisorInstanceId = randomUUID();
  try {
    const spawned = spawn(spec.command, spec.args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, ...spec.env, [SUPERVISOR_INSTANCE_ENV]: supervisorInstanceId },
    });
    child = spawned;
    childPid = spawned.pid ?? 0;
    exitedBeforeReady = new Promise<never>((_, reject) => {
      spawned.once("error", reject);
      spawned.once("exit", (code, signal) => {
        reject(new Error(
          `Multiremi daemon exited before becoming ready (code ${code ?? "none"}, signal ${signal ?? "none"}). Check logs: ${spec.logPath}`,
        ));
      });
    });
    spawned.unref();
  } finally {
    closeSync(logFd);
  }
  if (!childPid) throw new Error("failed to start Multiremi daemon");
  writeFileSync(spec.pidPath, `${childPid}\n`, { mode: 0o644 });

  try {
    const health = await Promise.race([
      waitForDaemonReady(spec.port, startupTimeoutMs, {
        expectedPid: childPid,
        requireSupervisorReady: true,
      }),
      exitedBeforeReady!,
    ]);
    if (!daemonSupervisorReady(health, { expectedPid: childPid, requireSupervisorReady: true })) {
      throw new Error(
        `Multiremi daemon did not make every provider ready within ${startupTimeoutMs}ms. `
          + `The failed supervisor has been stopped; check logs: ${spec.logPath}`,
      );
    }
    console.error(`Multiremi daemon started (pid ${childPid}, version ${health.cli_version ?? multiremiVersion})`);
    console.error(`Logs: ${spec.logPath}`);
  } catch (error) {
    try {
      await terminateUnreadyBackgroundProcess(child!, spec.pidPath, DEFAULT_SHUTDOWN_TIMEOUT_MS, supervisorInstanceId);
    } catch (cleanupError) {
      throw new Error(
        `Multiremi daemon startup failed and pid ${childPid} could not be stopped: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Stop a supervisor that never reached process-wide readiness. */
export async function terminateUnreadyBackgroundProcess(
  child: ChildProcess,
  pidPath: string,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  supervisorInstanceId?: string,
): Promise<void> {
  const trackedDescendants = new Map<number, TrackedProcess>();
  const supervisorIdentity = currentProcessRecord(child.pid ?? 0);
  captureDescendants(supervisorIdentity, trackedDescendants);
  captureMarkedProcesses(supervisorInstanceId, child.pid ?? 0, trackedDescendants);
  child.ref();
  try {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGTERM"); } catch {}
    }
    if (!(await waitForSupervisorExit(
      child,
      timeoutMs,
      trackedDescendants,
      supervisorIdentity,
      supervisorInstanceId,
    ))) {
      captureDescendants(supervisorIdentity, trackedDescendants);
      captureMarkedProcesses(supervisorInstanceId, child.pid ?? 0, trackedDescendants);
      signalTrackedProcesses(trackedDescendants, "SIGTERM", supervisorInstanceId);
      try { child.kill("SIGKILL"); } catch {}
      if (!(await waitForSupervisorExit(
        child,
        Math.min(timeoutMs, 5_000),
        trackedDescendants,
        supervisorIdentity,
        supervisorInstanceId,
      ))) {
        throw new Error("process remained alive after SIGTERM and SIGKILL");
      }
    }
    captureMarkedProcesses(supervisorInstanceId, child.pid ?? 0, trackedDescendants);
    await terminateTrackedProcesses(trackedDescendants, timeoutMs, supervisorInstanceId, child.pid ?? 0);
    removeMatchingPidFile(pidPath, child.pid ?? 0);
  } finally {
    child.unref();
  }
}

interface TrackedProcess {
  pid: number;
  parentPid: number;
  processGroupId: number;
  startId: string;
}

async function waitForSupervisorExit(
  child: ChildProcess,
  timeoutMs: number,
  tracked: Map<number, TrackedProcess>,
  supervisorIdentity: TrackedProcess | null,
  supervisorInstanceId?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    captureDescendants(supervisorIdentity, tracked);
    captureMarkedProcesses(supervisorInstanceId, child.pid ?? 0, tracked);
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  captureDescendants(supervisorIdentity, tracked);
  captureMarkedProcesses(supervisorInstanceId, child.pid ?? 0, tracked);
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateTrackedProcesses(
  tracked: Map<number, TrackedProcess>,
  timeoutMs: number,
  supervisorInstanceId?: string,
  supervisorPid = 0,
): Promise<void> {
  captureMarkedProcesses(supervisorInstanceId, supervisorPid, tracked);
  if (await waitForTrackedProcessesExit(
    tracked,
    Math.min(timeoutMs, 200),
    supervisorInstanceId,
    supervisorPid,
  )) return;
  signalTrackedProcesses(tracked, "SIGTERM", supervisorInstanceId);
  if (await waitForTrackedProcessesExit(
    tracked,
    Math.min(timeoutMs, 2_000),
    supervisorInstanceId,
    supervisorPid,
  )) return;
  signalTrackedProcesses(tracked, "SIGKILL", supervisorInstanceId);
  if (await waitForTrackedProcessesExit(
    tracked,
    Math.min(timeoutMs, 5_000),
    supervisorInstanceId,
    supervisorPid,
  )) return;
  const remaining = [...tracked.values()]
    .filter((entry) => trackedProcessAlive(entry, supervisorInstanceId))
    .map((entry) => entry.pid);
  throw new Error(`descendant processes remained alive after SIGKILL: ${remaining.join(", ")}`);
}

async function waitForTrackedProcessesExit(
  tracked: Map<number, TrackedProcess>,
  timeoutMs: number,
  supervisorInstanceId?: string,
  supervisorPid = 0,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let quietSince: number | null = null;
  while (Date.now() < deadline) {
    captureMarkedProcesses(supervisorInstanceId, supervisorPid, tracked);
    if (!trackedProcessesAlive(tracked, supervisorInstanceId)) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 100) return true;
    } else {
      quietSince = null;
    }
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  captureMarkedProcesses(supervisorInstanceId, supervisorPid, tracked);
  return !trackedProcessesAlive(tracked, supervisorInstanceId)
    && quietSince !== null
    && Date.now() - quietSince >= 100;
}

function trackedProcessesAlive(
  tracked: Map<number, TrackedProcess>,
  supervisorInstanceId?: string,
): boolean {
  const marked = supervisorInstanceId ? markedProcessIds(supervisorInstanceId) : null;
  return [...tracked.values()].some((entry) => trackedProcessAlive(entry, supervisorInstanceId, marked));
}

function trackedProcessAlive(
  expected: TrackedProcess,
  supervisorInstanceId?: string,
  marked = supervisorInstanceId ? markedProcessIds(supervisorInstanceId) : null,
): boolean {
  if (currentProcessRecord(expected.pid)?.startId !== expected.startId) return false;
  return !supervisorInstanceId || Boolean(marked?.has(expected.pid));
}

function signalTrackedProcesses(
  tracked: Map<number, TrackedProcess>,
  signal: NodeJS.Signals,
  supervisorInstanceId?: string,
): void {
  // Signal leaves before their parents so wrappers cannot keep a native child
  // alive through inherited pipes. Dedicated ACP process groups are swept as
  // groups, while start identity checks prevent PID-reuse kills.
  const entries = [...tracked.values()].sort(
    (left, right) => trackedProcessDepth(right, tracked) - trackedProcessDepth(left, tracked),
  );
  const marked = supervisorInstanceId ? markedProcessIds(supervisorInstanceId) : null;
  for (const entry of entries) {
    const current = currentProcessRecord(entry.pid);
    if (!current || current.startId !== entry.startId) continue;
    if (supervisorInstanceId && !marked?.has(current.pid)) continue;
    if (process.platform !== "win32" && current.processGroupId === current.pid) {
      try { process.kill(-current.pid, signal); } catch {}
    }
    try { process.kill(current.pid, signal); } catch {}
  }
}

function trackedProcessDepth(entry: TrackedProcess, tracked: Map<number, TrackedProcess>): number {
  let depth = 0;
  let parentPid = entry.parentPid;
  const seen = new Set<number>();
  while (!seen.has(parentPid)) {
    seen.add(parentPid);
    const parent = tracked.get(parentPid);
    if (!parent) break;
    depth++;
    parentPid = parent.parentPid;
  }
  return depth;
}

function captureDescendants(root: TrackedProcess | null, target: Map<number, TrackedProcess>): void {
  if (!root) return;
  const records = allProcessRecords();
  const observedRoot = records.find((record) => record.pid === root.pid);
  if (!observedRoot || observedRoot.startId !== root.startId) return;
  const children = new Map<number, TrackedProcess[]>();
  for (const record of records) {
    const siblings = children.get(record.parentPid) ?? [];
    siblings.push(record);
    children.set(record.parentPid, siblings);
  }
  const pending = [...(children.get(root.pid) ?? [])];
  while (pending.length) {
    const child = pending.pop()!;
    const existing = target.get(child.pid);
    if (!existing || existing.startId === child.startId) target.set(child.pid, child);
    pending.push(...(children.get(child.pid) ?? []));
  }
}

function captureMarkedProcesses(
  supervisorInstanceId: string | undefined,
  supervisorPid: number,
  target: Map<number, TrackedProcess>,
): void {
  if (!supervisorInstanceId) return;
  const records = allProcessRecords();
  const marked = markedProcessIds(supervisorInstanceId);
  for (const record of records) {
    if (record.pid === supervisorPid || !marked.has(record.pid)) continue;
    const existing = target.get(record.pid);
    if (!existing || existing.startId === record.startId) target.set(record.pid, record);
  }
}

function markedProcessIds(supervisorInstanceId: string): Set<number> {
  const marker = `${SUPERVISOR_INSTANCE_ENV}=${supervisorInstanceId}`;
  if (process.platform === "linux") {
    let entries: string[];
    try { entries = readdirSync("/proc"); } catch { return new Set(); }
    const result = new Set<number>();
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const environ = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
        if (environ.includes(marker)) result.add(Number(entry));
      } catch {}
    }
    return result;
  }
  if (process.platform === "win32") return new Set();
  const result = spawnSync("ps", ["eww", "-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0 || !result.stdout) return new Set();
  return new Set(result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match && match[2]?.includes(marker) ? [Number(match[1])] : [];
  }));
}

function currentProcessRecord(pid: number): TrackedProcess | null {
  if (process.platform === "linux") return readLinuxProcessRecord(pid);
  return allProcessRecords().find((entry) => entry.pid === pid) ?? null;
}

function allProcessRecords(): TrackedProcess[] {
  if (process.platform === "linux") {
    let entries: string[];
    try { entries = readdirSync("/proc"); } catch { return []; }
    return entries
      .filter((entry) => /^\d+$/.test(entry))
      .map((entry) => readLinuxProcessRecord(Number(entry)))
      .filter((entry): entry is TrackedProcess => entry !== null);
  }
  if (process.platform === "win32") return [];
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const pid = Number(fields[0]);
    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const startId = fields.slice(3).join(" ");
    return Number.isSafeInteger(pid)
      && Number.isSafeInteger(parentPid)
      && Number.isSafeInteger(processGroupId)
      && Boolean(startId)
      ? [{ pid, parentPid, processGroupId, startId }]
      : [];
  });
}

function readLinuxProcessRecord(pid: number): TrackedProcess | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    if (fields[0] === "Z") return null;
    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const startId = fields[19];
    if (!Number.isSafeInteger(parentPid) || !Number.isSafeInteger(processGroupId) || !startId) return null;
    return { pid, parentPid, processGroupId, startId };
  } catch {
    return null;
  }
}

function removeMatchingPidFile(pidPath: string, expectedPid: number): void {
  if (expectedPid <= 0) return;
  try {
    if (readFileSync(pidPath, "utf8").trim() !== String(expectedPid)) return;
    rmSync(pidPath, { force: true });
  } catch {
    // Missing or concurrently replaced PID files belong to no cleanup here.
  }
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
  const timeoutMs = daemonShutdownTimeoutMs(options);
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

  const deadline = Date.now() + timeoutMs;
  let remaining = live;
  while (Date.now() < deadline) {
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    const reported = (await checkManagedDaemonHealth(port)).filter((entry) => daemonAlive(entry.health));
    const reportedPorts = new Set(reported.map((entry) => entry.port));
    remaining = [...reported];
    // A transient health miss is not proof that the old supervisor released
    // its root ownership. Retain an original entry while its PID is alive.
    for (const entry of live) {
      const pid = typeof entry.health.pid === "number" ? entry.health.pid : 0;
      if (!reportedPorts.has(entry.port) && pid > 0 && processIsAlive(pid)) {
        remaining.push(entry);
      }
    }
    if (remaining.length === 0) {
      console.error("Multiremi daemon stopped.");
      return;
    }
  }
  const owners = remaining.map((entry) => {
    const pid = entry.health.pid ?? "unknown";
    const tasks = entry.health.active_task_count ?? "unknown";
    return `port ${entry.port}, pid ${pid}, active tasks ${tasks}`;
  }).join("; ");
  throw new Error(
    `Multiremi daemon is still draining after ${timeoutMs}ms (${owners}). `
      + "No replacement daemon was started. Check `multiremi daemon status` and logs, then retry.",
  );
}

function daemonShutdownTimeoutMs(options: CliOptions): number {
  const option = options.shutdownTimeoutMs ?? options["shutdown-timeout-ms"];
  const value = Array.isArray(option) ? option.at(-1) : option;
  const raw = value ?? process.env.MULTIREMI_DAEMON_SHUTDOWN_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error("--shutdown-timeout-ms must be a positive integer");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("--shutdown-timeout-ms must be a positive integer");
  }
  return parsed;
}

export function daemonStartupTimeoutMs(options: CliOptions): number {
  const option = options.startupTimeoutMs ?? options["startup-timeout-ms"];
  const value = Array.isArray(option) ? option.at(-1) : option;
  const raw = value ?? process.env.MULTIREMI_DAEMON_STARTUP_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_STARTUP_TIMEOUT_MS;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error("--startup-timeout-ms must be a positive integer");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("--startup-timeout-ms must be a positive integer");
  }
  return parsed;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
    if (health.draining_task_count !== undefined) console.log(`Draining tasks: ${health.draining_task_count}`);
    if (health.outbox) {
      const pendingNonTerminal = health.outbox.pendingNonTerminal
        ?? Math.max(0, health.outbox.pending - health.outbox.pendingTerminal);
      const taskCount = health.outbox.pendingTasks === undefined
        ? ""
        : ` across ${health.outbox.pendingTasks} task(s)`;
      console.log(
        `Outbox: ${pendingNonTerminal} non-terminal, `
        + `${health.outbox.pendingTerminal} terminal${taskCount}`,
      );
    }
    if (health.workspace_cleanup_capability === "blocked") {
      console.log(`Workspace cleanup capability: blocked${health.workspace_cleanup_error ? ` (${health.workspace_cleanup_error})` : ""}`);
    } else if (health.workspace_cleanup_capability === "available") {
      console.log("Workspace cleanup capability: available");
    }
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

export function resolveSetupConfig(
  current: MultiremiCliConfig,
  options: CliOptions,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fallbackHostname = hostname(),
): MultiremiCliConfig {
  const next: MultiremiCliConfig = { ...current };
  const serverUrl = stringOpt(options.server ?? options["server-url"], environment.MULTIREMI_SERVER_URL);
  const workspaceId = stringOpt(options.workspace ?? options["workspace-id"], environment.MULTIREMI_WORKSPACE_ID);
  const token = stringOpt(options.token, environment.MULTIREMI_TOKEN);
  const provider = stringOpt(options.provider, environment.MULTIREMI_PROVIDER);
  const runtimeId = stringOpt(options.runtimeId ?? options["runtime-id"], environment.MULTIREMI_RUNTIME_ID);
  const runtimeName = stringOpt(options.name ?? options["runtime-name"], environment.MULTIREMI_RUNTIME_NAME);
  const deviceName = stringOpt(options["device-name"] ?? options.deviceName, environment.MULTIREMI_DEVICE_NAME);
  const daemonId = stringOpt(options.daemonId ?? options["daemon-id"], environment.MULTIREMI_DAEMON_ID);
  const maxConcurrency = stringOpt(options["max-concurrency"] ?? options.maxConcurrency, environment.MULTIREMI_MAX_CONCURRENCY);

  if (serverUrl) next.server_url = serverUrl.replace(/\/+$/, "");
  if (workspaceId) next.workspace_id = workspaceId;
  if (token) next.token = token;
  if (provider) next.provider = provider;
  if (runtimeId) next.runtime_id = runtimeId;
  if (runtimeName) next.runtime_name = runtimeName;
  if (daemonId) next.daemon_id = daemonId;
  if (deviceName && !next.daemon_id) {
    // Pin the machine's existing identity before the display name changes,
    // otherwise the daemon re-registers under a new id and orphans its old card.
    // MULTIREMI_DEVICE_NAME is dropped here: when the rename arrives through
    // that env var, keeping it would resolve the "before" identity to the new
    // name and defeat the pin.
    next.daemon_id = resolveDeviceName(
      {},
      current,
      { ...environment, MULTIREMI_DEVICE_NAME: undefined },
      fallbackHostname,
    );
  }
  if (deviceName) next.device_name = deviceName;
  if (maxConcurrency) {
    const n = parseInt(maxConcurrency, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error("--max-concurrency must be an integer >= 1");
    }
    next.max_concurrency = n;
  }
  return next;
}

export function resolveDeviceName(
  options: CliOptions,
  config: MultiremiCliConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fallbackHostname = hostname(),
): string {
  const runtimeName = stringOpt(options.name, environment.MULTIREMI_RUNTIME_NAME)
    ?? config.runtime_name
    ?? undefined;
  return stringOpt(options["device-name"] ?? options.deviceName, environment.MULTIREMI_DEVICE_NAME)
    ?? config.device_name
    ?? runtimeName
    ?? `${fallbackHostname}-${environment.USER ?? "local"}`;
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
