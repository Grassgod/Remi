import { access, lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";
import { linkCodexAuthFromBase, seedCodexHomeFromBase } from "../agent-plugins/codex-home.js";
import { mergeClaudeSettings } from "../relay-sync.js";

const SESSION_HOME_MARKER = ".multiremi-session-home.json";

export interface IssueSessionProviderHome {
  /** Workspace-visible lineage root for one provider lane generation. */
  root: string;
  /** Actual CLAUDE_CONFIG_DIR/CODEX_HOME. Native history is written here. */
  home: string;
  sessionId: string;
  agentId: string;
  generation: number;
  provider: "claude" | "codex";
}

export interface PrepareIssueSessionProviderHomeOptions {
  /** A Codex Plugin installer already created and seeded this exact home. */
  codexPluginInstalled?: boolean;
  baseClaudeConfigDir?: string;
  baseCodexHome?: string;
  /** Relay-approved Codex routing, already stripped of inline credentials. */
  codexConfigToml?: string;
  /** Link the base Codex auth file for subscription OAuth. Defaults to true. */
  linkCodexAuth?: boolean;
  /** Link the base Claude credentials file for subscription OAuth. Defaults to true. */
  linkClaudeCredentials?: boolean;
}

export interface IssueSessionProviderEnvOptions {
  baseClaudeConfigDir?: string;
  baseCodexHome?: string;
  relayFragment?: string;
  relayAuthToken?: string;
}

const CLAUDE_EXECUTION_SETTING_KEYS = new Set([
  "alwaysThinkingEnabled",
  "language",
  "model",
  "outputStyle",
]);

const CLAUDE_PROVIDER_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
]);

/**
 * Resolve the daemon-owned state root for an Issue run. The fallback branch is
 * defensive: Issue tasks normally never resolve to local_directory, but old
 * data must still not place provider/plugin state inside a user's checkout.
 */
export function resolveIssueRuntimeStateRoot(
  task: AgentTask,
  workDir: string,
  workspacesRoot: string,
  localDirectory: boolean,
): string {
  if (!localDirectory) return resolve(workDir);
  const issueId = cleanString(task.issueId ?? task.issue_id);
  if (!issueId) return resolve(workspacesRoot);
  return join(resolve(workspacesRoot), ".issue-runtime", safePathSegment(issueId));
}

/**
 * Resolve provider-native state beneath the stable Issue workspace. One lane
 * generation owns one home, so a provider reset never mixes its JSONL/history
 * with the lineage that was abandoned. The ACP child receives this exact home,
 * which makes the provider's native session files directly inspectable under
 * `.multiremi/sessions`.
 */
export function resolveIssueSessionProviderHome(
  task: AgentTask,
  workDir: string,
  _workspacesRoot: string,
): IssueSessionProviderHome | null {
  const sessionId = cleanString(task.issueSessionId ?? task.issue_session_id);
  const agentId = cleanString(task.agent?.id);
  const provider = task.agent?.provider;
  if (!sessionId || !agentId || (provider !== "claude" && provider !== "codex")) return null;

  const generation = positiveInteger(
    task.issueSessionGeneration ?? task.issue_session_generation,
    1,
  );
  const root = join(
    resolve(workDir),
    ".multiremi",
    "sessions",
    safePathSegment(sessionId),
    safePathSegment(agentId),
    String(generation),
  );
  return {
    root,
    home: join(root, "home"),
    sessionId,
    agentId,
    generation,
    provider,
  };
}

/** Seed provider configuration once, leaving all native session files intact. */
export async function prepareIssueSessionProviderHome(
  resolvedHome: IssueSessionProviderHome,
  options: PrepareIssueSessionProviderHomeOptions = {},
): Promise<void> {
  await mkdir(resolvedHome.root, { recursive: true, mode: 0o700 });
  if (!(await isPreparedHome(resolvedHome.home))) {
    if (resolvedHome.provider === "codex") {
      if (!options.codexPluginInstalled) {
        await seedCodexHomeFromBase({
          baseHome: options.baseCodexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
          targetHome: resolvedHome.home,
          requireAuth: false,
          copyAuth: false,
          ...(options.codexConfigToml === undefined ? {} : { configToml: options.codexConfigToml }),
        });
      }
    } else {
      await mkdir(resolvedHome.home, { recursive: true, mode: 0o700 });
      const baseClaudeConfigDir = resolve(
        options.baseClaudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      );
      await seedClaudeSettings(baseClaudeConfigDir, resolvedHome.home);
    }
    await writeFile(join(resolvedHome.home, SESSION_HOME_MARKER), `${JSON.stringify({
      schemaVersion: 1,
      provider: resolvedHome.provider,
      sessionId: resolvedHome.sessionId,
      agentId: resolvedHome.agentId,
      generation: resolvedHome.generation,
      preparedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
  }

  // Authentication is runtime state, not immutable home configuration. Reconcile
  // it on every start so removing a Relay from an existing lane can fall back to
  // provider-native OAuth without forcing a new generation.
  if (resolvedHome.provider === "codex" && options.linkCodexAuth !== false) {
    await linkCodexAuthFromBase(
      options.baseCodexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      resolvedHome.home,
    );
  }
  if (resolvedHome.provider === "claude" && options.linkClaudeCredentials !== false) {
    const baseClaudeConfigDir = resolve(
      options.baseClaudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    );
    await ensureCredentialLink(
      join(baseClaudeConfigDir, ".credentials.json"),
      join(resolvedHome.home, ".credentials.json"),
      "Claude",
      false,
    );
  }

  await writeFile(join(resolvedHome.root, "meta.json"), `${JSON.stringify({
    schemaVersion: 1,
    provider: resolvedHome.provider,
    sessionId: resolvedHome.sessionId,
    agentId: resolvedHome.agentId,
    generation: resolvedHome.generation,
    providerHome: "home",
  }, null, 2)}\n`, { mode: 0o600 });
}

async function ensureCredentialLink(
  source: string,
  target: string,
  provider: string,
  required = true,
): Promise<boolean> {
  let sourceInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    sourceInfo = await lstat(source);
  } catch (error) {
    if (isNotFound(error) && !required) return false;
    if (isNotFound(error)) {
      throw new Error(`${provider} filesystem credentials are missing at ${source}; configure a workspace Relay or provider token`);
    }
    throw error;
  }
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`${provider} filesystem credentials must be a regular file: ${source}`);
  }
  if ((sourceInfo.mode & 0o077) !== 0) {
    throw new Error(`${provider} filesystem credentials must not be accessible by group or other users: ${source}`);
  }
  try {
    await symlink(source, target, "file");
    return true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const targetInfo = await lstat(target);
  if (!targetInfo.isSymbolicLink()) {
    throw new Error(`${provider} credential target is not a managed link: ${target}`);
  }
  const existingTarget = resolve(dirname(target), await readlink(target));
  if (existingTarget !== resolve(source)) {
    throw new Error(`${provider} credential link points to an unexpected file: ${target}`);
  }
  return true;
}

/**
 * Read the minimum provider credentials needed by the ACP child and return
 * them as an in-memory environment overlay. Secrets are never written into
 * the Issue workspace provider home.
 */
export async function loadIssueSessionProviderEnv(
  resolvedHome: IssueSessionProviderHome,
  options: IssueSessionProviderEnvOptions = {},
): Promise<Record<string, string>> {
  if (resolvedHome.provider === "claude") {
    const baseDir = options.baseClaudeConfigDir
      ?? process.env.CLAUDE_CONFIG_DIR
      ?? join(homedir(), ".claude");
    const baseSettings = await readJsonObjectIfRegular(join(resolve(baseDir), "settings.json"));
    const baseEnv = objectField(baseSettings, "env");
    const env = pickStringFields(baseEnv, CLAUDE_PROVIDER_ENV_KEYS);
    if (options.relayFragment !== undefined || options.relayAuthToken !== undefined) {
      const relaySettings = mergeClaudeSettings(
        {},
        options.relayFragment ?? "",
        options.relayAuthToken ?? "",
      );
      Object.assign(env, pickStringFields(objectField(relaySettings, "env"), CLAUDE_PROVIDER_ENV_KEYS));
      if (options.relayAuthToken) delete env.ANTHROPIC_API_KEY;
    }
    return env;
  }

  const baseHome = options.baseCodexHome
    ?? process.env.CODEX_HOME
    ?? join(homedir(), ".codex");
  const auth = await readJsonObjectIfRegular(join(resolve(baseHome), "auth.json"));
  const env: Record<string, string> = {};
  const staticKey = auth && typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY.trim() : "";
  if (staticKey) env.OPENAI_API_KEY = staticKey;
  if (options.relayAuthToken?.trim()) env.OPENAI_API_KEY = options.relayAuthToken.trim();
  return env;
}

async function seedClaudeSettings(baseDir: string, targetDir: string): Promise<void> {
  const source = join(resolve(baseDir), "settings.json");
  const target = join(resolve(targetDir), "settings.json");
  if (!(await isRegularFile(source)) || await pathExists(target)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(source, "utf8"));
  } catch (error) {
    throw new Error(`Claude settings are not valid JSON: ${source}`, { cause: error });
  }
  const sanitized: Record<string, unknown> = {};
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (CLAUDE_EXECUTION_SETTING_KEYS.has(key)) sanitized[key] = value;
    }
  }
  try {
    await writeFile(target, `${JSON.stringify(sanitized, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // Two tasks may cold-start the same lane concurrently. The winner's
    // complete sanitized file is equivalent; any other failure is real.
    if (!isAlreadyExists(error)) throw error;
  }
}

async function readJsonObjectIfRegular(path: string): Promise<Record<string, unknown> | null> {
  if (!(await isRegularFile(path))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Provider configuration is not valid JSON: ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Provider configuration is not a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function objectField(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const field = value?.[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? field as Record<string, unknown>
    : null;
}

function pickStringFields(
  value: Record<string, unknown> | null,
  allowlist: ReadonlySet<string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    if (allowlist.has(key) && typeof raw === "string" && raw.trim()) result[key] = raw;
  }
  return result;
}

async function isPreparedHome(home: string): Promise<boolean> {
  return isRegularFile(join(home, SESSION_HOME_MARKER));
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safePathSegment(value: string): string {
  const segment = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!segment || segment === "." || segment === "..") {
    throw new Error(`invalid Issue Session path segment: ${JSON.stringify(value)}`);
  }
  return segment;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
