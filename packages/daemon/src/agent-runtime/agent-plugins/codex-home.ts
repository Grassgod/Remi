import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { sanitizeProviderConfigValue } from "../provider-config-sanitize.js";
import type { PreparedAgentPluginRuntime } from "./types.js";
import { AgentPluginError } from "./types.js";

const INSTALL_MARKER = ".remi-plugins.json";
const DEFAULT_CODEX_PLUGIN_COMMAND_TIMEOUT_MS = 60_000;
const installFlights = new Map<string, Promise<string>>();

export interface CodexPluginCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface InstallCodexPluginHomeOptions {
  codexExecutable?: string;
  env?: Record<string, string>;
  /** Copy/link authentication and approved base config into the isolated home. */
  seedHome?: (home: string) => Promise<void>;
  runCommand?: (command: CodexPluginCommand) => Promise<void>;
  signal?: AbortSignal;
  commandTimeoutMs?: number;
}

export interface SeedCodexHomeFromBaseOptions {
  baseHome: string;
  targetHome: string;
  /** Sanitized config produced by the daemon/relay. Omit to inherit the local execution allowlist. */
  configToml?: string;
  /** Plugin execution requires native auth; plain session homes may use env credentials. */
  requireAuth?: boolean;
  /** Copy auth.json into the isolated home. Defaults to true for native Plugin installation. */
  copyAuth?: boolean;
  /** Link auth.json to the daemon's base home so OAuth refreshes do not fork. */
  linkAuth?: boolean;
}

const CODEX_EXECUTION_CONFIG_KEYS = new Set([
  "approval_policy",
  "approvals_reviewer",
  "disable_response_storage",
  "hide_agent_reasoning",
  "model",
  "model_provider",
  "model_providers",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "network_access",
  "personality",
  "review_model",
  "sandbox_mode",
  "service_tier",
  "show_raw_agent_reasoning",
  "web_search",
]);

/**
 * Seed Codex authentication plus either relay-approved config or a strict
 * allowlist of local model/transport settings. Global Plugins, marketplaces,
 * hooks, project trust and MCP config are deliberately excluded.
 */
export async function seedCodexHomeFromBase(options: SeedCodexHomeFromBaseOptions): Promise<void> {
  const baseHome = resolve(options.baseHome);
  const targetHome = resolve(options.targetHome);
  if (baseHome === targetHome) {
    throw new AgentPluginError("Isolated CODEX_HOME must differ from the base home", "plugin_codex_home_invalid", "blocked");
  }
  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  const sourceAuth = join(baseHome, "auth.json");
  let authInfo: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    authInfo = await lstat(sourceAuth);
  } catch (error) {
    if (!isNotFound(error) || options.requireAuth !== false) {
      throw new AgentPluginError(
        `Codex authentication is missing at ${sourceAuth}`,
        "plugin_codex_auth_missing",
        "setup_required",
        { cause: error },
      );
    }
  }
  if (authInfo && (!authInfo.isFile() || authInfo.isSymbolicLink())) {
    throw new AgentPluginError(
      `Codex authentication must be a regular file: ${sourceAuth}`,
      "plugin_codex_auth_invalid",
      "setup_required",
    );
  }
  if (authInfo && options.linkAuth) {
    await linkCodexAuthFromBase(baseHome, targetHome);
  } else if (authInfo && options.copyAuth !== false) {
    await copyFile(sourceAuth, join(targetHome, "auth.json"));
    await chmod(join(targetHome, "auth.json"), 0o600);
  }
  const configToml = options.configToml ?? await readCodexExecutionConfig(baseHome);
  await writeFile(join(targetHome, "config.toml"), configToml, { mode: 0o600 });
}

/** Reconcile the OAuth auth link independently from one-time home seeding. */
export async function linkCodexAuthFromBase(baseHome: string, targetHome: string): Promise<void> {
  const sourceAuth = join(resolve(baseHome), "auth.json");
  let authInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    authInfo = await lstat(sourceAuth);
  } catch (error) {
    throw new AgentPluginError(
      `Codex authentication is missing at ${sourceAuth}`,
      "plugin_codex_auth_missing",
      "setup_required",
      { cause: error },
    );
  }
  if (!authInfo.isFile() || authInfo.isSymbolicLink() || (authInfo.mode & 0o077) !== 0) {
    throw new AgentPluginError(
      `Codex authentication must be a private regular file: ${sourceAuth}`,
      "plugin_codex_auth_invalid",
      "setup_required",
    );
  }
  await mkdir(resolve(targetHome), { recursive: true, mode: 0o700 });
  await ensureCredentialLink(sourceAuth, join(resolve(targetHome), "auth.json"));
}

async function ensureCredentialLink(source: string, target: string): Promise<void> {
  try {
    await symlink(source, target, "file");
    return;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  const targetInfo = await lstat(target);
  if (!targetInfo.isSymbolicLink()) {
    throw new AgentPluginError(
      `Codex authentication target is not a managed link: ${target}`,
      "plugin_codex_auth_invalid",
      "setup_required",
    );
  }
  const existingTarget = resolve(dirname(target), await readlink(target));
  if (existingTarget !== resolve(source)) {
    throw new AgentPluginError(
      `Codex authentication link points to an unexpected file: ${target}`,
      "plugin_codex_auth_invalid",
      "setup_required",
    );
  }
}

async function readCodexExecutionConfig(baseHome: string): Promise<string> {
  const sourceConfig = join(baseHome, "config.toml");
  let configInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    configInfo = await lstat(sourceConfig);
  } catch (error) {
    if (isNotFound(error)) return "";
    throw new AgentPluginError(
      `Cannot read Codex configuration at ${sourceConfig}`,
      "plugin_codex_config_invalid",
      "setup_required",
      { cause: error },
    );
  }
  if (!configInfo.isFile() || configInfo.isSymbolicLink()) {
    throw new AgentPluginError(
      `Codex configuration must be a regular file: ${sourceConfig}`,
      "plugin_codex_config_invalid",
      "setup_required",
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(await readFile(sourceConfig, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new AgentPluginError(
      `Codex configuration is not valid TOML: ${sourceConfig}`,
      "plugin_codex_config_invalid",
      "setup_required",
      { cause: error },
    );
  }
  const allowed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (CODEX_EXECUTION_CONFIG_KEYS.has(key)) allowed[key] = sanitizeProviderConfigValue(value);
  }
  return stringifyToml(allowed);
}

/**
 * Installs a generated local marketplace into an isolated CODEX_HOME.
 * Publication is atomic, so codex-acp can never observe a half-installed home.
 */
export async function installCodexPluginHome(
  prepared: PreparedAgentPluginRuntime,
  options: InstallCodexPluginHomeOptions = {},
): Promise<string | null> {
  const home = prepared.codexHome;
  const marketplaceRoot = prepared.codexMarketplaceRoot;
  const marketplaceName = prepared.codexMarketplaceName;
  const pluginNames = prepared.codexPluginNames;
  if (!home || !marketplaceRoot || !marketplaceName || !pluginNames?.length) return null;

  const existing = installFlights.get(home);
  if (existing) return existing;
  const flight = publishCodexPluginHome(prepared, options, home, marketplaceRoot, marketplaceName, pluginNames);
  installFlights.set(home, flight);
  try {
    return await flight;
  } finally {
    if (installFlights.get(home) === flight) installFlights.delete(home);
  }
}

async function publishCodexPluginHome(
  prepared: PreparedAgentPluginRuntime,
  options: InstallCodexPluginHomeOptions,
  home: string,
  marketplaceRoot: string,
  marketplaceName: string,
  pluginNames: string[],
): Promise<string> {
  if (await validatePublishedCodexHome(home, prepared.executionFingerprint)) return home;

  const parent = dirname(home);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.${basename(home)}-${randomUUID()}.tmp`);
  const executable = options.codexExecutable ?? "codex";
  const runCommand = options.runCommand ?? defaultRunCommand;
  try {
    await mkdir(staging, { recursive: false, mode: 0o700 });
    await options.seedHome?.(staging);
    const env = {
      ...(process.env as Record<string, string>),
      ...options.env,
      CODEX_HOME: staging,
    };
    await runCodexPluginCommand(runCommand, {
      executable,
      args: ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
      cwd: marketplaceRoot,
      env,
    }, options);
    for (const pluginName of pluginNames) {
      await runCodexPluginCommand(runCommand, {
        executable,
        args: ["plugin", "add", `${pluginName}@${marketplaceName}`, "--json"],
        cwd: marketplaceRoot,
        env,
      }, options);
    }
    await writeFile(join(staging, INSTALL_MARKER), `${JSON.stringify({
      schemaVersion: 1,
      executionFingerprint: prepared.executionFingerprint,
      marketplaceName,
      pluginNames,
      installedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    assertContained(parent, home);
    try {
      await rename(staging, home);
    } catch (error) {
      // The home is immutable for an execution fingerprint. A concurrent
      // publisher wins; validate and reuse it rather than deleting it.
      if (!(await validatePublishedCodexHome(home, prepared.executionFingerprint))) throw error;
    }
    return home;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function runCodexPluginCommand(
  runCommand: (command: CodexPluginCommand) => Promise<void>,
  command: CodexPluginCommand,
  options: InstallCodexPluginHomeOptions,
): Promise<void> {
  const timeoutMs = Math.max(1, options.commandTimeoutMs ?? DEFAULT_CODEX_PLUGIN_COMMAND_TIMEOUT_MS);
  const scope = commandAbortScope(options.signal, timeoutMs);
  try {
    await raceWithAbort(
      runCommand({ ...command, signal: scope.signal, timeoutMs }),
      scope.signal,
    );
  } catch (error) {
    const message = redactCommandSecrets(
      error instanceof Error ? error.message : String(error),
      command.env,
    );
    if (error instanceof AgentPluginError) {
      if (message === error.message) throw error;
      throw new AgentPluginError(message, error.code, error.retryKind, { cause: error });
    }
    throw new AgentPluginError(
      `Codex Plugin install failed: ${message}`,
      "plugin_codex_install_failed",
      "blocked",
      { cause: error },
    );
  } finally {
    scope.dispose();
  }
}

function redactCommandSecrets(message: string, env: Record<string, string>): string {
  let redacted = message;
  for (const [key, value] of Object.entries(env)) {
    if (!/(?:token|api[_-]?key|secret|authorization|password|credential|bearer)/i.test(key)) continue;
    if (value.length < 4) continue;
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}

async function validatePublishedCodexHome(home: string, executionFingerprint: string): Promise<boolean> {
  try {
    const info = await lstat(home);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new AgentPluginError(
        `Isolated Codex home is not a safe directory: ${home}`,
        "plugin_codex_home_invalid",
        "blocked",
      );
    }
    const markerInfo = await lstat(join(home, INSTALL_MARKER));
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
      throw new AgentPluginError(
        `Isolated Codex home marker is invalid: ${home}`,
        "plugin_codex_home_invalid",
        "blocked",
      );
    }
    const marker = JSON.parse(await readFile(join(home, INSTALL_MARKER), "utf8")) as {
      executionFingerprint?: unknown;
    };
    if (marker.executionFingerprint !== executionFingerprint) {
      throw new AgentPluginError(
        `Codex home fingerprint mismatch at ${home}`,
        "plugin_codex_home_mismatch",
        "blocked",
      );
    }
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    if (error instanceof AgentPluginError) throw error;
    throw new AgentPluginError(
      `Cannot validate isolated Codex home ${home}`,
      "plugin_codex_home_invalid",
      "blocked",
      { cause: error },
    );
  }
}

async function defaultRunCommand(command: CodexPluginCommand): Promise<void> {
  if (command.signal?.aborted) throw command.signal.reason;
  let processHandle: ReturnType<typeof Bun.spawn>;
  try {
    processHandle = Bun.spawn([command.executable, ...command.args], {
      cwd: command.cwd,
      env: command.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new AgentPluginError(
      `Cannot start Codex CLI ${command.executable}: ${error instanceof Error ? error.message : String(error)}`,
      "plugin_codex_cli_missing",
      "setup_required",
      { cause: error },
    );
  }
  let result: [number, string, string];
  try {
    result = await raceWithAbort(Promise.all([
      processHandle.exited,
      readSpawnOutput(processHandle.stdout),
      readSpawnOutput(processHandle.stderr),
    ]), command.signal);
  } catch (error) {
    try {
      processHandle.kill();
    } catch {}
    const exited = await Promise.race([
      processHandle.exited.then(() => true, () => true),
      new Promise<false>((resolveTimeout) => {
        const timer = setTimeout(() => resolveTimeout(false), 250);
        timer.unref?.();
      }),
    ]);
    if (!exited) {
      try {
        processHandle.kill(9);
      } catch {}
    }
    throw error;
  }
  const [exitCode, stdout, stderr] = result;
  if (exitCode !== 0) {
    throw new AgentPluginError(
      `Codex Plugin install failed (exit ${exitCode}): ${(stderr || stdout).trim().slice(0, 1000)}`,
      "plugin_codex_install_failed",
      "blocked",
    );
  }
}

function commandAbortScope(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort(new AgentPluginError(
      "Codex Plugin installation was cancelled",
      "plugin_cancelled",
      "transient",
    ));
  };
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    controller.abort(new AgentPluginError(
      `Codex Plugin install timed out after ${timeoutMs}ms`,
      "plugin_codex_install_timeout",
      "setup_required",
    ));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
    },
  };
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason;
  let abort: (() => void) | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function readSpawnOutput(value: unknown): Promise<string> {
  return value instanceof ReadableStream ? await new Response(value).text() : "";
}

function assertContained(parent: string, child: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error(`refusing to replace Codex home outside managed directory: ${child}`);
  }
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}
