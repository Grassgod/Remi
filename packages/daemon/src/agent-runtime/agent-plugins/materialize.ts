import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";
import type { AgentPluginCache } from "./cache.js";
import { normalizeSha256Digest } from "./cache.js";
import type {
  AgentPluginArtifactSpec,
  AgentPluginSnapshot,
  PreparedAgentPluginRuntime,
} from "./types.js";
import { AgentPluginError, PluginCacheMissError } from "./types.js";

const RUNTIME_DIR = ".remi-runtime";
const MATERIALIZED_MARKER = ".remi-materialized.json";
const materializationFlights = new Map<string, Promise<void>>();
const marketplaceFlights = new Map<string, Promise<{ name: string; pluginNames: string[] }>>();

export interface MaterializeTaskPluginsOptions {
  signal?: AbortSignal;
  /**
   * Directory that owns `.remi-runtime`. Required for non-Issue tasks so a
   * user's Git cwd is never polluted with Runtime state.
   */
  runtimeBase?: string;
}

/**
 * Build the same native marketplace shape used by task execution for one
 * Runtime desired artifact. The caller installs it into the returned isolated
 * CODEX_HOME before reporting this digest Ready.
 */
export async function prepareCodexPluginReadinessRuntime(
  snapshot: AgentPluginArtifactSpec,
  payloadPath: string,
  readinessRoot: string,
  signal?: AbortSignal,
): Promise<PreparedAgentPluginRuntime> {
  if (snapshot.provider !== "codex") {
    throw new AgentPluginError(
      `Codex Plugin readiness cannot prepare provider ${snapshot.provider}`,
      "plugin_provider_mismatch",
      "blocked",
    );
  }
  throwIfAborted(signal);
  const digest = normalizeSha256Digest(snapshot.digest);
  const executionFingerprint = `sha256:${digest}`;
  const runtimeRoot = join(resolve(readinessRoot), digest);
  const codexHome = join(runtimeRoot, "home");
  const codexMarketplaceRoot = join(runtimeRoot, "marketplace");
  const readinessSnapshot: AgentPluginSnapshot = {
    ...snapshot,
    bindingId: `runtime-${snapshot.pluginId}`,
  };
  const marketplace = await buildCodexMarketplace(
    codexMarketplaceRoot,
    digest,
    [readinessSnapshot],
    [resolve(payloadPath)],
  );
  throwIfAborted(signal);
  await mkdir(dirname(codexHome), { recursive: true, mode: 0o700 });
  return {
    runtimeRoot,
    pluginPaths: [resolve(payloadPath)],
    pluginFingerprint: executionFingerprint,
    executionFingerprint,
    codexHome,
    codexMarketplaceRoot,
    codexMarketplaceName: marketplace.name,
    codexPluginNames: marketplace.pluginNames,
  };
}

/**
 * Reads the immutable claim snapshot. `agent.plugins` is accepted only as a
 * compatibility fallback while older server wires are rolling forward.
 */
export function resolveTaskPluginSnapshot(task: AgentTask): AgentPluginSnapshot[] {
  const exact = task.pluginSnapshot ?? task.plugin_snapshot;
  if (Array.isArray(exact)) return exact.map(validateSnapshot);
  if (Array.isArray(task.agent?.plugins)) return task.agent.plugins.map(validateSnapshot);
  return [];
}

/**
 * Materialize already-ready cache entries into the Issue-private runtime dir.
 * This function never fetches from Git/Marketplace/Artifact Store: a cache miss
 * is surfaced so scheduling can wait for Runtime reconciliation.
 */
export async function materializeTaskPlugins(
  task: AgentTask,
  workDir: string,
  cache: AgentPluginCache,
  options: MaterializeTaskPluginsOptions = {},
): Promise<PreparedAgentPluginRuntime> {
  const snapshots = resolveTaskPluginSnapshot(task);
  const provider = normalizeProvider(task.agent?.provider);
  for (const snapshot of snapshots) {
    if (snapshot.provider !== provider) {
      throw new AgentPluginError(
        `Agent provider ${provider} cannot load ${snapshot.provider} Plugin ${snapshot.name}`,
        "plugin_provider_mismatch",
        "blocked",
      );
    }
  }

  const pluginFingerprint = fingerprintSnapshots(provider, snapshots);
  const executionFingerprint = cleanString(task.executionFingerprint ?? task.execution_fingerprint)
    ?? pluginFingerprint;
  const fingerprintSegment = safeFingerprintSegment(executionFingerprint);
  const runtimeBase = resolveRuntimeBase(task, workDir, options.runtimeBase);
  const ownerRuntimeRoot = join(runtimeBase, RUNTIME_DIR);
  // Plugin payloads and generated marketplaces are execution-private. The
  // surrounding Issue/session runtime remains the GC boundary, but one task
  // can never persist mutations into a later task's provider inputs.
  const runtimeRoot = join(ownerRuntimeRoot, "executions", safePathSegment(task.id));
  const pluginsRoot = join(runtimeRoot, "plugins");
  await mkdir(pluginsRoot, { recursive: true, mode: 0o700 });

  const pluginPaths: string[] = [];
  for (const snapshot of snapshots) {
    throwIfAborted(options.signal);
    const digest = normalizeSha256Digest(snapshot.digest);
    const cached = await cache.getReadyPath(snapshot);
    if (!cached) throw new PluginCacheMissError(`sha256:${digest}`);
    const destination = join(pluginsRoot, digest);
    await materializeOne(cached, destination, digest);
    pluginPaths.push(destination);
    await mkdir(join(runtimeRoot, "plugin-data", safePathSegment(snapshot.bindingId)), {
      recursive: true,
      mode: 0o700,
    });
  }

  let codexHome: string | undefined;
  let codexMarketplaceRoot: string | undefined;
  let codexMarketplaceName: string | undefined;
  let codexPluginNames: string[] | undefined;
  if (provider === "codex" && snapshots.length) {
    // CODEX_HOME is deliberately session-stable for an exact server-frozen
    // execution fingerprint. Marketplace input remains task-private.
    codexHome = join(ownerRuntimeRoot, "codex-home", fingerprintSegment);
    codexMarketplaceRoot = join(runtimeRoot, "codex-marketplace");
    const marketplace = await buildCodexMarketplace(
      codexMarketplaceRoot,
      fingerprintSegment,
      snapshots,
      pluginPaths,
    );
    codexMarketplaceName = marketplace.name;
    codexPluginNames = marketplace.pluginNames;
    // installCodexPluginHome() owns creation of the final home so it can build
    // in a sibling temp dir and atomically publish a complete installation.
    await mkdir(dirname(codexHome), { recursive: true, mode: 0o700 });
  }

  await writeJsonAtomic(join(runtimeRoot, "execution.json"), {
    schemaVersion: 1,
    taskId: task.id,
    issueId: task.issueId ?? task.issue_id ?? null,
    provider,
    pluginFingerprint,
    executionFingerprint,
    plugins: snapshots.map((snapshot) => ({
      bindingId: snapshot.bindingId,
      pluginId: snapshot.pluginId,
      versionId: snapshot.versionId,
      name: snapshot.name,
      version: snapshot.version,
      digest: `sha256:${normalizeSha256Digest(snapshot.digest)}`,
      sourceRevision: snapshot.sourceRevision ?? null,
      connectionId: snapshot.connectionId ?? null,
      configDigest: snapshot.config ? sha256Text(canonicalJson(snapshot.config)) : null,
    })),
  });

  return {
    runtimeRoot,
    pluginPaths,
    pluginFingerprint,
    executionFingerprint,
    codexHome,
    codexMarketplaceRoot,
    codexMarketplaceName,
    codexPluginNames,
  };
}

/** Explicit cleanup hook; normal Issue GC also removes this child directory. */
export async function cleanupTaskPluginRuntime(workDir: string): Promise<void> {
  const workspace = resolve(workDir);
  const runtimeRoot = resolve(workspace, RUNTIME_DIR);
  assertDirectChild(workspace, runtimeRoot, RUNTIME_DIR);
  await makeTreeWritable(runtimeRoot);
  await rm(runtimeRoot, { recursive: true, force: true });
}

/** Remove the whole daemon-owned non-Issue task directory, including empty parents. */
export async function cleanupNonIssueTaskPluginRuntime(task: AgentTask, workspacesRoot: string): Promise<void> {
  if (task.issueId ?? task.issue_id) {
    throw new AgentPluginError(
      "Issue Plugin runtimes are reclaimed by workspace GC",
      "plugin_runtime_cleanup_invalid",
      "blocked",
    );
  }
  if (task.chatSessionId) {
    throw new AgentPluginError(
      "Chat Plugin runtimes are retained until session GC",
      "plugin_runtime_cleanup_invalid",
      "blocked",
    );
  }
  const owner = resolve(workspacesRoot, ".task-runtime");
  const taskRoot = resolveTaskPluginRuntimeBase(task, workspacesRoot, workspacesRoot);
  assertDirectChild(owner, taskRoot, safePathSegment(task.id));
  await makeTreeWritable(taskRoot);
  await rm(taskRoot, { recursive: true, force: true });
}

/**
 * Worker helper: Issue state lives beside repo worktrees; chat/direct tasks use
 * a daemon-owned task runtime and keep ACP cwd untouched.
 */
export function resolveTaskPluginRuntimeBase(
  task: AgentTask,
  issueWorkDir: string,
  workspacesRoot: string,
): string {
  if (task.issueId ?? task.issue_id) return resolve(issueWorkDir);
  if (task.chatSessionId) {
    return join(resolve(workspacesRoot), ".session-runtime", safePathSegment(task.chatSessionId));
  }
  return join(resolve(workspacesRoot), ".task-runtime", safePathSegment(task.id));
}

async function materializeOne(source: string, destination: string, digest: string): Promise<void> {
  const existing = materializationFlights.get(destination);
  if (existing) return existing;
  const flight = publishMaterializedPlugin(source, destination, digest);
  materializationFlights.set(destination, flight);
  try {
    await flight;
  } finally {
    if (materializationFlights.get(destination) === flight) materializationFlights.delete(destination);
  }
}

async function publishMaterializedPlugin(source: string, destination: string, digest: string): Promise<void> {
  assertDirectChild(dirname(destination), destination, basename(destination));
  if (await validatePublishedMaterialization(destination, digest)) return;
  const temp = join(dirname(destination), `.${basename(destination)}-${randomUUID()}.tmp`);
  try {
    await cloneTree(source, temp);
    await writeFile(join(temp, MATERIALIZED_MARKER), `${JSON.stringify({ schemaVersion: 1, digest })}\n`, {
      mode: 0o444,
    });
    await freezeDirectories(temp);
    try {
      await rename(temp, destination);
    } catch (error) {
      // Another task or daemon process may have published the same immutable
      // digest while this copy was being built. Reuse only a fully validated
      // winner; never remove or replace an already-published directory.
      if (!(await validatePublishedMaterialization(destination, digest))) throw error;
    }
  } finally {
    await makeTreeWritable(temp).catch(() => {});
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

async function validatePublishedMaterialization(destination: string, digest: string): Promise<boolean> {
  try {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new AgentPluginError(
        `Agent Plugin materialization is not a safe directory: ${destination}`,
        "plugin_materialization_invalid",
        "blocked",
      );
    }
    const markerInfo = await lstat(join(destination, MATERIALIZED_MARKER));
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
      throw new AgentPluginError(
        `Agent Plugin materialization marker is invalid: ${destination}`,
        "plugin_materialization_invalid",
        "blocked",
      );
    }
    const marker = JSON.parse(await readFile(join(destination, MATERIALIZED_MARKER), "utf8")) as {
      schemaVersion?: unknown;
      digest?: unknown;
    };
    if (marker.schemaVersion !== 1 || marker.digest !== digest) {
      throw new AgentPluginError(
        `Agent Plugin materialization digest mismatch at ${destination}`,
        "plugin_materialization_mismatch",
        "blocked",
      );
    }
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    if (error instanceof AgentPluginError) throw error;
    throw new AgentPluginError(
      `Cannot validate Agent Plugin materialization ${destination}`,
      "plugin_materialization_invalid",
      "blocked",
      { cause: error },
    );
  }
}

async function cloneTree(source: string, destination: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new AgentPluginError("Agent Plugin cache payload is not a safe directory", "plugin_cache_invalid", "blocked");
  }
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const src = join(source, entry.name);
    const dest = join(destination, entry.name);
    const info = await lstat(src);
    if (info.isSymbolicLink()) {
      throw new AgentPluginError(
        `Agent Plugin cache contains a symbolic link: ${entry.name}`,
        "plugin_cache_invalid",
        "blocked",
      );
    }
    if (info.isDirectory()) {
      await cloneTree(src, dest);
      continue;
    }
    if (!info.isFile()) {
      throw new AgentPluginError(
        `Agent Plugin cache contains a special file: ${entry.name}`,
        "plugin_cache_invalid",
        "blocked",
      );
    }
    // COPYFILE_FICLONE already falls back to a regular copy when reflinks are
    // unsupported. A real I/O error must propagate instead of being masked by
    // an unconditional second copy attempt.
    await copyFile(src, dest, fsConstants.COPYFILE_FICLONE);
    await chmod(dest, info.mode & ~0o222);
  }
}

async function freezeDirectories(root: string): Promise<void> {
  const directories = [root];
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index]!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(directory, entry.name));
    }
  }
  // Files are immutable; directories retain owner write permission so normal
  // Issue workspace GC can recursively remove the runtime without chmod hacks.
  for (const directory of directories.reverse()) await chmod(directory, 0o755);
}

async function makeTreeWritable(root: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(root);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) {
    await chmod(root, info.mode | 0o600);
    return;
  }
  await chmod(root, info.mode | 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await makeTreeWritable(join(root, entry.name));
  }
}

async function buildCodexMarketplace(
  marketplaceRoot: string,
  fingerprintSegment: string,
  snapshots: AgentPluginSnapshot[],
  pluginPaths: string[],
): Promise<{ name: string; pluginNames: string[] }> {
  const name = `remi-${fingerprintSegment.slice(0, 16)}`;
  const expectedPluginNames = await readCodexPluginNames(snapshots, pluginPaths);
  const existing = marketplaceFlights.get(marketplaceRoot);
  if (existing) return existing;
  const flight = publishCodexMarketplace(
    marketplaceRoot,
    fingerprintSegment,
    snapshots,
    pluginPaths,
    name,
    expectedPluginNames,
  );
  marketplaceFlights.set(marketplaceRoot, flight);
  try {
    return await flight;
  } finally {
    if (marketplaceFlights.get(marketplaceRoot) === flight) marketplaceFlights.delete(marketplaceRoot);
  }
}

async function readCodexPluginNames(
  snapshots: AgentPluginSnapshot[],
  pluginPaths: string[],
): Promise<string[]> {
  const pluginNames: string[] = [];
  for (let index = 0; index < snapshots.length; index++) {
    const manifestPath = join(pluginPaths[index]!, ".codex-plugin", "plugin.json");
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new AgentPluginError(
        `Cannot read Codex Plugin manifest for ${snapshots[index]!.name}`,
        "plugin_manifest_invalid",
        "blocked",
        { cause: error },
      );
    }
    const pluginName = cleanString(manifest.name);
    if (!pluginName || !/^[A-Za-z0-9._-]+$/.test(pluginName)) {
      throw new AgentPluginError(
        `Codex Plugin ${snapshots[index]!.name} has an invalid native name`,
        "plugin_manifest_invalid",
        "blocked",
      );
    }
    if (pluginNames.includes(pluginName)) {
      throw new AgentPluginError(
        `Codex Plugin name collision in execution snapshot: ${pluginName}`,
        "plugin_name_collision",
        "blocked",
      );
    }
    pluginNames.push(pluginName);
  }
  return pluginNames;
}

async function publishCodexMarketplace(
  marketplaceRoot: string,
  fingerprintSegment: string,
  snapshots: AgentPluginSnapshot[],
  pluginPaths: string[],
  name: string,
  pluginNames: string[],
): Promise<{ name: string; pluginNames: string[] }> {
  if (await validatePublishedMarketplace(marketplaceRoot, name, pluginNames)) return { name, pluginNames };
  const temp = `${marketplaceRoot}.${randomUUID()}.tmp`;
  const entries: Array<Record<string, unknown>> = [];
  try {
    await mkdir(join(temp, ".agents", "plugins"), { recursive: true, mode: 0o700 });
    await mkdir(join(temp, "plugins"), { recursive: true, mode: 0o700 });
    for (let index = 0; index < snapshots.length; index++) {
      const pluginName = pluginNames[index]!;
      await cloneTree(pluginPaths[index]!, join(temp, "plugins", pluginName));
      entries.push({
        name: pluginName,
        source: { source: "local", path: `./plugins/${pluginName}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      });
    }
    await writeJsonAtomic(join(temp, ".agents", "plugins", "marketplace.json"), {
      name,
      interface: { displayName: `Multiremi ${fingerprintSegment.slice(0, 8)}` },
      plugins: entries,
    });
    await freezeDirectories(temp);
    await mkdir(dirname(marketplaceRoot), { recursive: true, mode: 0o700 });
    try {
      await rename(temp, marketplaceRoot);
    } catch (error) {
      if (!(await validatePublishedMarketplace(marketplaceRoot, name, pluginNames))) throw error;
    }
    return { name, pluginNames };
  } finally {
    await makeTreeWritable(temp).catch(() => {});
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

async function validatePublishedMarketplace(
  marketplaceRoot: string,
  name: string,
  pluginNames: string[],
): Promise<boolean> {
  try {
    const info = await lstat(marketplaceRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new AgentPluginError(
        `Codex marketplace is not a safe directory: ${marketplaceRoot}`,
        "plugin_codex_marketplace_invalid",
        "blocked",
      );
    }
    const manifestPath = join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
    const markerInfo = await lstat(manifestPath);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
      throw new AgentPluginError(
        `Codex marketplace manifest is invalid: ${marketplaceRoot}`,
        "plugin_codex_marketplace_invalid",
        "blocked",
      );
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name?: unknown;
      plugins?: Array<{ name?: unknown }>;
    };
    const actualNames = Array.isArray(manifest.plugins)
      ? manifest.plugins.map((entry) => cleanString(entry?.name))
      : [];
    if (manifest.name !== name || actualNames.length !== pluginNames.length
      || actualNames.some((pluginName, index) => pluginName !== pluginNames[index])) {
      throw new AgentPluginError(
        `Codex marketplace fingerprint mismatch at ${marketplaceRoot}`,
        "plugin_codex_marketplace_mismatch",
        "blocked",
      );
    }
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    if (error instanceof AgentPluginError) throw error;
    throw new AgentPluginError(
      `Cannot validate Codex marketplace ${marketplaceRoot}`,
      "plugin_codex_marketplace_invalid",
      "blocked",
      { cause: error },
    );
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function validateSnapshot(value: AgentPluginSnapshot): AgentPluginSnapshot {
  if (!value || typeof value !== "object") {
    throw new AgentPluginError("Invalid Agent Plugin task snapshot", "plugin_snapshot_invalid", "blocked");
  }
  const provider = normalizeProvider(value.provider);
  const required = ["bindingId", "pluginId", "versionId", "name", "version", "digest", "artifactUrl"] as const;
  for (const field of required) {
    if (!cleanString(value[field])) {
      throw new AgentPluginError(
        `Agent Plugin task snapshot is missing ${field}`,
        "plugin_snapshot_invalid",
        "blocked",
      );
    }
  }
  normalizeSha256Digest(value.digest);
  return { ...value, provider };
}

function normalizeProvider(value: unknown): "claude" | "codex" {
  const provider = cleanString(value)?.toLowerCase();
  if (provider === "claude" || provider === "codex") return provider;
  throw new AgentPluginError(`Unsupported Agent Plugin provider: ${String(value)}`, "plugin_provider_invalid", "blocked");
}

function fingerprintSnapshots(provider: string, snapshots: AgentPluginSnapshot[]): string {
  const values = snapshots.map((snapshot) => ({
    bindingId: snapshot.bindingId,
    pluginId: snapshot.pluginId,
    versionId: snapshot.versionId,
    provider: snapshot.provider,
    version: snapshot.version,
    digest: `sha256:${normalizeSha256Digest(snapshot.digest)}`,
    config: snapshot.config ?? null,
    connectionId: snapshot.connectionId ?? null,
  })).sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  return `sha256:${sha256Text(canonicalJson({ provider, plugins: values }))}`;
}

function safeFingerprintSegment(value: string): string {
  const digest = value.trim().toLowerCase().replace(/^sha256:/, "");
  return /^[a-f0-9]{64}$/.test(digest) ? digest : sha256Text(value);
}

function safePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") return sha256Text(value).slice(0, 16);
  return normalized;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalClone(value));
}

function canonicalClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalClone);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonicalClone((value as Record<string, unknown>)[key]);
  }
  return result;
}

function assertDirectChild(parent: string, child: string, expectedBasename: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (rel !== expectedBasename || isAbsolute(rel)) {
    throw new Error(`refusing to mutate path outside task Plugin runtime: ${child}`);
  }
}

function resolveRuntimeBase(task: AgentTask, workDir: string, explicit: string | undefined): string {
  if (explicit?.trim()) {
    const base = resolve(explicit);
    if (!(task.issueId ?? task.issue_id)) {
      const rel = relative(resolve(workDir), base);
      if (!rel || rel === "." || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel))) {
        throw new AgentPluginError(
          "Non-Issue Agent Plugin runtime must be outside the task Git cwd",
          "plugin_runtime_base_invalid",
          "blocked",
        );
      }
    }
    return base;
  }
  if (task.issueId ?? task.issue_id) return resolve(workDir);
  throw new AgentPluginError(
    "Non-Issue Agent Plugin execution requires a daemon-owned runtimeBase",
    "plugin_runtime_base_required",
    "setup_required",
  );
}

function cleanString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AgentPluginError("Agent Plugin materialization cancelled", "plugin_cancelled", "transient");
  }
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
