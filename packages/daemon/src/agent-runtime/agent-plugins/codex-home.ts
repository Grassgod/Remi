import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { PreparedAgentPluginRuntime } from "./types.js";
import { AgentPluginError } from "./types.js";

const INSTALL_MARKER = ".remi-plugins.json";

export interface CodexPluginCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface InstallCodexPluginHomeOptions {
  codexExecutable?: string;
  env?: Record<string, string>;
  /** Copy/link authentication and approved base config into the isolated home. */
  seedHome?: (home: string) => Promise<void>;
  runCommand?: (command: CodexPluginCommand) => Promise<void>;
}

export interface SeedCodexHomeFromBaseOptions {
  baseHome: string;
  targetHome: string;
  /** Sanitized config produced by the daemon/relay. Omit to inherit the local execution allowlist. */
  configToml?: string;
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
  if (!authInfo.isFile() || authInfo.isSymbolicLink()) {
    throw new AgentPluginError(
      `Codex authentication must be a regular file: ${sourceAuth}`,
      "plugin_codex_auth_invalid",
      "setup_required",
    );
  }
  await copyFile(sourceAuth, join(targetHome, "auth.json"));
  await chmod(join(targetHome, "auth.json"), 0o600);
  const configToml = options.configToml ?? await readCodexExecutionConfig(baseHome);
  await writeFile(join(targetHome, "config.toml"), configToml, { mode: 0o600 });
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
    if (CODEX_EXECUTION_CONFIG_KEYS.has(key)) allowed[key] = value;
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

  try {
    const marker = JSON.parse(await readFile(join(home, INSTALL_MARKER), "utf8")) as {
      executionFingerprint?: unknown;
    };
    if (marker.executionFingerprint === prepared.executionFingerprint) return home;
    throw new AgentPluginError(
      `Codex home fingerprint mismatch at ${home}`,
      "plugin_codex_home_mismatch",
      "blocked",
    );
  } catch (error) {
    if (error instanceof AgentPluginError) throw error;
    if (!isNotFound(error)) {
      throw new AgentPluginError(
        `Cannot validate isolated Codex home ${home}`,
        "plugin_codex_home_invalid",
        "blocked",
        { cause: error },
      );
    }
  }

  const parent = dirname(home);
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
    await runCommand({
      executable,
      args: ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
      cwd: marketplaceRoot,
      env,
    });
    for (const pluginName of pluginNames) {
      await runCommand({
        executable,
        args: ["plugin", "add", `${pluginName}@${marketplaceName}`, "--json"],
        cwd: marketplaceRoot,
        env,
      });
    }
    await writeFile(join(staging, INSTALL_MARKER), `${JSON.stringify({
      schemaVersion: 1,
      executionFingerprint: prepared.executionFingerprint,
      marketplaceName,
      pluginNames,
      installedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    assertContained(parent, home);
    await rm(home, { recursive: true, force: true });
    await rename(staging, home);
    return home;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultRunCommand(command: CodexPluginCommand): Promise<void> {
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
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    readSpawnOutput(processHandle.stdout),
    readSpawnOutput(processHandle.stderr),
  ]);
  if (exitCode !== 0) {
    throw new AgentPluginError(
      `Codex Plugin install failed (exit ${exitCode}): ${(stderr || stdout).trim().slice(0, 1000)}`,
      "plugin_codex_install_failed",
      "blocked",
    );
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
