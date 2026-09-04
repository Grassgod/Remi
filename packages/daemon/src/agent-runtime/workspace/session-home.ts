import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { access, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";
import { linkCodexAuthFromBase, seedCodexHomeFromBase } from "../agent-plugins/codex-home.js";
import { AgentPluginError } from "../agent-plugins/types.js";
import { sanitizeProviderConfigValue } from "../provider-config-sanitize.js";
import { mergeClaudeSettings, mergeCodexSessionConfig } from "../relay-sync.js";
import { removeOwnedDirectorySync } from "./safe-remove.js";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const SESSION_HOME_MARKER = ".multiremi-session-home.json";
const PROVIDER_CONFIG_BASELINE = ".multiremi-provider-config-baseline.json";

export interface IssueSessionProviderHome {
  /** Trusted daemon/workspace boundary beneath which every parent is validated. */
  storageRoot: string;
  /** Workspace-visible lineage root for one provider lane generation. */
  root: string;
  /** Actual CLAUDE_CONFIG_DIR/CODEX_HOME. Native history is written here. */
  home: string;
  sessionId: string;
  agentId: string;
  generation: number;
  provider: "claude" | "codex";
  /** Codex execution identity. Different Plugin sets must never share a Home. */
  executionFingerprint?: string;
  /** Daemon-owned GC boundary for non-Issue provider state. */
  runtimeStateRoot?: string;
  /** Present only for non-Issue task-scoped homes that must be removed after the run. */
  temporaryTaskRoot?: string;
}

export interface IssueSessionRuntimeRoot {
  sessionId: string;
  root: string;
}

export interface PrepareIssueSessionProviderHomeOptions {
  /** A Codex Plugin installer already created and seeded this exact home. */
  codexPluginInstalled?: boolean;
  baseClaudeConfigDir?: string;
  baseCodexHome?: string;
  /** Relay-approved provider routing. These fragments never contain credentials. */
  relayFragment?: string;
  /** The Relay token is injected as OPENAI_API_KEY into the Codex child. */
  codexRelayUsesEnvApiKey?: boolean;
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
 * Resolve the canonical Issue working root. The fallback branch is defensive:
 * legacy local-directory tasks still redirect runtime state away from the
 * user's checkout and into `${R}/issues`.
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
  const issueKey = cleanString(task.issue?.key) ?? `legacy-${issueId}`;
  return join(resolve(workspacesRoot), "issues", safePathSegment(issueKey));
}

/**
 * Resolve provider-native state under the single daemon-owned runtime tree.
 * One product session/Agent/generation tuple owns one home regardless of which
 * surface (Issue, discussion, Chat) initiated the run.
 */
export function resolveIssueSessionProviderHome(
  task: AgentTask,
  _workDir: string,
  workspacesRoot: string,
): IssueSessionProviderHome | null {
  const formalSessionId = cleanString(task.issueSessionId ?? task.issue_session_id);
  const issueId = cleanString(task.issueId ?? task.issue_id);
  const sessionId = formalSessionId ?? (issueId ? `legacy-${issueId}` : null);
  const agentId = cleanString(task.agent?.id);
  const provider = task.agent?.provider;
  if (!sessionId || !agentId || (provider !== "claude" && provider !== "codex")) return null;

  const generation = formalSessionId
    ? positiveInteger(task.issueSessionGeneration ?? task.issue_session_generation, 1)
    : 1;
  const storageRoot = resolve(workspacesRoot);
  const generationRoot = join(
    storageRoot,
    ".runtime",
    safePathSegment(sessionId),
    safePathSegment(agentId),
    String(generation),
  );
  const execution = provider === "codex" ? codexExecutionIdentity(task) : null;
  const root = execution
    ? join(generationRoot, "executions", execution.segment)
    : generationRoot;
  return {
    storageRoot,
    root,
    home: join(root, "home"),
    sessionId,
    agentId,
    generation,
    provider,
    ...(execution ? { executionFingerprint: execution.fingerprint } : {}),
    runtimeStateRoot: join(storageRoot, ".runtime", safePathSegment(sessionId)),
  };
}

/** Find the runtime Session roots that belong to one Issue without following links. */
export function listIssueSessionRuntimeRoots(
  workspacesRoot: string,
  issueId: string,
): IssueSessionRuntimeRoot[] {
  const runtimeRoot = join(resolve(workspacesRoot), ".runtime");
  let rootInfo;
  try {
    rootInfo = lstatSync(runtimeRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Runtime state root must be a real directory: ${runtimeRoot}`);
  }

  const roots: IssueSessionRuntimeRoot[] = [];
  for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const sessionRoot = join(runtimeRoot, entry.name);
    const metadataPath = join(sessionRoot, ".multiremi", "gc.json");
    try {
      const metadataInfo = lstatSync(metadataPath);
      if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) continue;
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      if (metadata.kind === "issue_runtime" && metadata.issue_id === issueId) {
        roots.push({ sessionId: entry.name, root: sessionRoot });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return roots.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

/**
 * Resolve an isolated provider home for every daemon task. Issue tasks keep
 * their stable, archiveable Session lineage. Chats reuse one home until Chat
 * GC, while one-shot task kinds get a temporary task-scoped home. Both live in
 * daemon-owned runtime state, independent of the provider cwd.
 */
export function resolveTaskProviderHome(
  task: AgentTask,
  issueRuntimeStateRoot: string,
  workspacesRoot: string,
): IssueSessionProviderHome | null {
  const issueId = cleanString(task.issueId ?? task.issue_id);
  if (issueId && !cleanString(task.chatSessionId)) {
    const issueHome = resolveIssueSessionProviderHome(task, issueRuntimeStateRoot, workspacesRoot);
    return issueHome;
  }

  const agentId = cleanString(task.agent?.id);
  const provider = task.agent?.provider;
  if (!agentId || (provider !== "claude" && provider !== "codex")) return null;

  const taskId = cleanString(task.id);
  if (!taskId) throw new Error("Task provider home requires a task id");
  const storageRoot = resolve(workspacesRoot);
  const execution = provider === "codex" ? codexExecutionIdentity(task) : null;
  const chatSessionId = cleanString(task.chatSessionId);
  if (chatSessionId) {
    const runtimeStateRoot = join(storageRoot, ".runtime", safePathSegment(chatSessionId));
    const providerRoot = join(
      runtimeStateRoot,
      safePathSegment(agentId),
      "1",
    );
    const root = execution
      ? join(providerRoot, "executions", execution.segment)
      : providerRoot;
    return {
      storageRoot,
      root,
      home: join(root, "home"),
      sessionId: chatSessionId,
      agentId,
      generation: 1,
      provider,
      ...(execution ? { executionFingerprint: execution.fingerprint } : {}),
      runtimeStateRoot,
    };
  }

  const temporaryTaskRoot = join(storageRoot, ".runtime", safePathSegment(taskId));
  const providerRoot = join(
    temporaryTaskRoot,
    safePathSegment(agentId),
    "1",
  );
  const root = execution
    ? join(providerRoot, "executions", execution.segment)
    : providerRoot;
  return {
    storageRoot,
    root,
    home: join(root, "home"),
    sessionId: taskId,
    agentId,
    generation: 1,
    provider,
    ...(execution ? { executionFingerprint: execution.fingerprint } : {}),
    runtimeStateRoot: temporaryTaskRoot,
    temporaryTaskRoot,
  };
}

/**
 * Establish a Provider Home parent using one lstat-verified directory at a
 * time. Recursive mkdir is deliberately limited to the trusted storage root;
 * every daemon-owned descendant rejects symlinks and non-directories before a
 * Plugin installer or provider can write through it.
 */
export async function ensureProviderHomeDirectory(
  resolvedHome: IssueSessionProviderHome,
): Promise<void> {
  await ensureRealDirectoryTree(
    resolvedHome.storageRoot,
    resolvedHome.root,
    "Provider Home",
  );
}

/** Remove provider-native state for a completed non-Issue task. */
export async function cleanupTemporaryTaskProviderHome(
  resolvedHome: IssueSessionProviderHome | null | undefined,
  workspacesRoot: string,
  assertRootOwner?: () => void,
): Promise<void> {
  const temporaryTaskRoot = resolvedHome?.temporaryTaskRoot;
  if (!resolvedHome || !temporaryTaskRoot) return;

  const ownerRoot = join(resolve(workspacesRoot), ".runtime");
  const expectedTaskRoot = join(ownerRoot, safePathSegment(resolvedHome.sessionId));
  if (resolve(temporaryTaskRoot) !== resolve(expectedTaskRoot)) {
    throw new Error(`Temporary provider home escapes task runtime root: ${temporaryTaskRoot}`);
  }
  const relativeHome = relative(resolve(temporaryTaskRoot), resolve(resolvedHome.root));
  if (
    !relativeHome
    || relativeHome === ".."
    || relativeHome.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(relativeHome)
  ) {
    throw new Error(`Temporary provider home is not contained by its task runtime: ${resolvedHome.root}`);
  }

  removeOwnedDirectorySync(workspacesRoot, temporaryTaskRoot, { assertRootOwner });
}

/** Seed a provider Home once, then reconcile its non-secret routing on every start. */
export async function prepareIssueSessionProviderHome(
  resolvedHome: IssueSessionProviderHome,
  options: PrepareIssueSessionProviderHomeOptions = {},
): Promise<void> {
  await ensureProviderHomeDirectory(resolvedHome);
  if (!(await isPreparedHome(resolvedHome.home))) {
    if (resolvedHome.provider === "codex") {
      if (!options.codexPluginInstalled) {
        await seedCodexHomeFromBase({
          baseHome: options.baseCodexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
          targetHome: resolvedHome.home,
          requireAuth: false,
          copyAuth: false,
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
      executionFingerprint: resolvedHome.executionFingerprint ?? null,
      preparedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
  }

  // Capture Plugin/native configuration once, before applying Relay routing.
  // Every later start rebuilds the provider config from this credential-free
  // baseline, so deep-merge cannot retain a removed or superseded gateway.
  const baseline = await ensureProviderConfigBaseline(resolvedHome, options);

  // Homes are stable for a Session lane, while workspace Relay configuration
  // may change between turns. Reconcile routing on every start without touching
  // provider-native history or Plugin-owned configuration.
  await reconcileIssueSessionProviderConfig(resolvedHome, baseline, options);

  // Authentication is runtime state, not immutable home configuration. Reconcile
  // it on every start so removing a Relay from an existing lane can fall back to
  // provider-native OAuth without forcing a new generation.
  if (resolvedHome.provider === "codex" && options.linkCodexAuth !== false) {
    const baseCodexHome = options.baseCodexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    if (options.relayFragment !== undefined && options.codexRelayUsesEnvApiKey !== true) {
      await removeSessionCredential(join(resolvedHome.home, "auth.json"), "Codex");
      await assertIssueSessionNativeCodexOAuth(baseCodexHome);
    }
    await linkCodexAuthFromBase(baseCodexHome, resolvedHome.home);
  } else if (resolvedHome.provider === "codex") {
    await removeSessionCredential(join(resolvedHome.home, "auth.json"), "Codex");
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
  } else if (resolvedHome.provider === "claude") {
    await removeSessionCredential(join(resolvedHome.home, ".credentials.json"), "Claude");
  }

  await writeFile(join(resolvedHome.root, "meta.json"), `${JSON.stringify({
    schemaVersion: 1,
    provider: resolvedHome.provider,
    sessionId: resolvedHome.sessionId,
    agentId: resolvedHome.agentId,
    generation: resolvedHome.generation,
    executionFingerprint: resolvedHome.executionFingerprint ?? null,
    providerHome: "home",
  }, null, 2)}\n`, { mode: 0o600 });
}

async function ensureRealDirectoryTree(
  storageRoot: string,
  target: string,
  label: string,
): Promise<void> {
  const root = resolve(storageRoot);
  const destination = resolve(target);
  assertContainedOrEqual(root, destination, label);

  // The configured/workspace root is the trust boundary. It may be created by
  // the daemon, but the daemon-owned descendants below it are never created via
  // recursive traversal.
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertRealDirectory(root, `${label} storage root`);
  let current = root;
  const remainder = relative(root, destination);
  if (!remainder) return;
  for (const segment of remainder.split(sep)) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await assertRealDirectory(current, label);
  }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
}

function assertContainedOrEqual(storageRoot: string, target: string, label: string): void {
  const rel = relative(resolve(storageRoot), resolve(target));
  if (
    rel === ".."
    || rel.startsWith(`..${sep}`)
    || isAbsolute(rel)
  ) {
    throw new Error(`${label} escapes its storage root: ${target}`);
  }
}

function codexExecutionIdentity(task: AgentTask): { fingerprint: string; segment: string } | null {
  const fingerprint = cleanString(task.executionFingerprint ?? task.execution_fingerprint);
  if (!fingerprint) return null;
  const digest = fingerprint.toLowerCase().replace(/^sha256:/, "");
  return {
    fingerprint,
    segment: /^[a-f0-9]{64}$/.test(digest)
      ? digest
      : createHash("sha256").update(fingerprint).digest("hex"),
  };
}

async function reconcileIssueSessionProviderConfig(
  resolvedHome: IssueSessionProviderHome,
  baseline: string,
  options: PrepareIssueSessionProviderHomeOptions,
): Promise<void> {
  if (resolvedHome.provider === "claude") {
    const target = join(resolvedHome.home, "settings.json");
    const current = parseJsonObject(baseline, `${resolvedHome.root}/${PROVIDER_CONFIG_BASELINE}`);
    // An empty token deliberately strips credential-shaped Claude env keys from
    // the file. The real Relay token is injected into the ACP child environment.
    const merged = mergeClaudeSettings(current, options.relayFragment ?? "", "");
    const mergedEnv = objectField(merged, "env");
    if (mergedEnv && Object.keys(mergedEnv).length === 0) delete merged.env;
    await writePrivateFileIfChanged(target, `${JSON.stringify(merged, null, 2)}\n`);
    return;
  }

  const target = join(resolvedHome.home, "config.toml");
  const merged = mergeCodexSessionConfig(
    baseline,
    options.relayFragment ?? "",
    options.codexRelayUsesEnvApiKey === true,
  );
  await writePrivateFileIfChanged(target, merged);
}

interface ProviderConfigBaseline {
  schemaVersion: 1;
  provider: "claude" | "codex";
  content: string;
}

async function ensureProviderConfigBaseline(
  resolvedHome: IssueSessionProviderHome,
  options: PrepareIssueSessionProviderHomeOptions,
): Promise<string> {
  const baselinePath = join(resolvedHome.root, PROVIDER_CONFIG_BASELINE);
  const existing = await readProviderConfigBaseline(baselinePath, resolvedHome.provider);
  if (existing !== null) return existing;

  const configPath = join(
    resolvedHome.home,
    resolvedHome.provider === "claude" ? "settings.json" : "config.toml",
  );
  const current = await readTextFileForReconcile(configPath)
    ?? (resolvedHome.provider === "claude" ? "{}\n" : "");
  const content = resolvedHome.provider === "claude"
    ? sanitizeClaudeBaseline(current, options.relayFragment !== undefined, configPath)
    : sanitizeCodexBaseline(current, options.relayFragment !== undefined);
  const payload: ProviderConfigBaseline = {
    schemaVersion: 1,
    provider: resolvedHome.provider,
    content,
  };
  try {
    await writeFile(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return content;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const winner = await readProviderConfigBaseline(baselinePath, resolvedHome.provider);
    if (winner === null) throw new Error(`Provider configuration baseline disappeared: ${baselinePath}`);
    return winner;
  }
}

async function readProviderConfigBaseline(
  path: string,
  expectedProvider: "claude" | "codex",
): Promise<string | null> {
  const text = await readTextFileForReconcile(path);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Provider configuration baseline is not valid JSON: ${path}`, { cause: error });
  }
  const baseline = parsed as Partial<ProviderConfigBaseline> | null;
  if (
    !baseline
    || typeof baseline !== "object"
    || baseline.schemaVersion !== 1
    || baseline.provider !== expectedProvider
    || typeof baseline.content !== "string"
  ) {
    throw new Error(`Provider configuration baseline is invalid: ${path}`);
  }
  return baseline.content;
}

function sanitizeClaudeBaseline(current: string, relayAuthoritative: boolean, path: string): string {
  const parsed = parseJsonObject(current, path);
  const env = objectField(parsed, "env");
  if (env) {
    const cleanEnv = { ...env };
    delete cleanEnv.ANTHROPIC_AUTH_TOKEN;
    delete cleanEnv.ANTHROPIC_API_KEY;
    if (relayAuthoritative) delete cleanEnv.ANTHROPIC_BASE_URL;
    if (Object.keys(cleanEnv).length) parsed.env = cleanEnv;
    else delete parsed.env;
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function sanitizeCodexBaseline(current: string, relayAuthoritative: boolean): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = current.trim() ? parseToml(current) as Record<string, unknown> : {};
  } catch {
    throw new Error("Provider configuration is not valid TOML");
  }
  parsed = sanitizeProviderConfigValue(parsed) as Record<string, unknown>;
  if (relayAuthoritative) {
    // The daemon's global CLI files may have been deep-merged by an older
    // version. Provider routing is therefore not a trustworthy native baseline
    // when the server supplied an authoritative workspace Relay (including a
    // clear payload). Default Codex routing + native OAuth is the safe fallback.
    delete parsed.model_provider;
    delete parsed.model_providers;
  }
  return stringifyToml(parsed);
}

function parseJsonObject(text: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Provider configuration is not valid JSON: ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Provider configuration is not a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

async function readTextFileForReconcile(path: string): Promise<string | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Provider configuration must be a regular file: ${path}`);
  }
  return readFile(path, "utf8");
}

async function writePrivateFileIfChanged(path: string, content: string): Promise<void> {
  const current = await readTextFileForReconcile(path);
  if (current === content) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.multiremi.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
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

async function removeSessionCredential(target: string, provider: string): Promise<void> {
  let targetInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    targetInfo = await lstat(target);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (!targetInfo.isSymbolicLink() && !targetInfo.isFile()) {
    throw new AgentPluginError(
      `${provider} credential target is not a managed file: ${target}`,
      `plugin_${provider.toLowerCase()}_auth_invalid`,
      "setup_required",
    );
  }
  await rm(target);
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
    const relayAuthoritative = options.relayFragment !== undefined
      || options.relayAuthToken !== undefined;
    if (relayAuthoritative) {
      const relaySettings = mergeClaudeSettings(
        {},
        options.relayFragment ?? "",
        options.relayAuthToken ?? "",
      );
      return {
        // AcpClient starts with the daemon's machine env. Empty values are
        // deliberate tombstones that prevent stale machine/custom credentials
        // from surviving an authoritative workspace Relay clear.
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_BASE_URL: "",
        ...pickStringFields(objectField(relaySettings, "env"), CLAUDE_PROVIDER_ENV_KEYS),
      };
    }
    const baseDir = options.baseClaudeConfigDir
      ?? process.env.CLAUDE_CONFIG_DIR
      ?? join(homedir(), ".claude");
    const baseSettings = await readJsonObjectIfRegular(join(resolve(baseDir), "settings.json"));
    const baseEnv = objectField(baseSettings, "env");
    return pickStringFields(baseEnv, CLAUDE_PROVIDER_ENV_KEYS);
  }

  if (options.relayFragment !== undefined || options.relayAuthToken !== undefined) {
    return { OPENAI_API_KEY: options.relayAuthToken?.trim() ?? "" };
  }
  const baseHome = options.baseCodexHome
    ?? process.env.CODEX_HOME
    ?? join(homedir(), ".codex");
  const auth = await readJsonObjectIfRegular(join(resolve(baseHome), "auth.json"));
  const env: Record<string, string> = {};
  const staticKey = auth && typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY.trim() : "";
  if (staticKey) env.OPENAI_API_KEY = staticKey;
  return env;
}

export async function assertIssueSessionNativeCodexOAuth(baseHome: string): Promise<void> {
  const auth = await readJsonObjectIfRegular(join(resolve(baseHome), "auth.json"));
  const hasStaticKey = typeof auth?.OPENAI_API_KEY === "string" && Boolean(auth.OPENAI_API_KEY.trim());
  const authMode = typeof auth?.auth_mode === "string" ? auth.auth_mode.trim().toLowerCase() : "";
  const hasTokenBundle = Boolean(objectField(auth, "tokens"));
  if (!auth || hasStaticKey || (authMode !== "chatgpt" && !hasTokenBundle)) {
    throw new AgentPluginError(
      "Codex native OAuth is unavailable after clearing the workspace model gateway; sign in to Codex on this Runtime and retry",
      "plugin_codex_native_oauth_required",
      "setup_required",
    );
  }
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
