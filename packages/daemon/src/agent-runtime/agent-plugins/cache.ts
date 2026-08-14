import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentPluginArtifactSpec, PluginInstallPhase } from "./types.js";
import { AgentPluginError } from "./types.js";

const READY_MARKER = "ready.json";
const PAYLOAD_DIR = "payload";
const SHA256_RE = /^[a-f0-9]{64}$/;

interface ReadyMarker {
  schemaVersion: 1;
  digest: string;
  provider: string;
  installedAt: string;
}

export interface AgentPluginCacheOptions {
  root?: string;
  serverUrl?: string;
  getAuthToken?: () => string | null | undefined | Promise<string | null | undefined>;
  fetch?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
  maxArchiveBytes?: number;
  maxExtractedBytes?: number;
  maxFiles?: number;
  lockPollMs?: number;
  lockWaitMs?: number;
  staleLockMs?: number;
}

export interface EnsurePluginOptions {
  signal?: AbortSignal;
  onPhase?: (phase: PluginInstallPhase) => void | Promise<void>;
}

/**
 * Runtime-local, content-addressed Agent Plugin cache.
 *
 * A cache entry is immutable and has the form:
 *   <root>/<sha256>/payload
 *   <root>/<sha256>/ready.json
 *
 * Downloads happen under `.tmp`, their raw canonical JSON bytes are digest
 * verified, every embedded file is validated, and the result is atomically
 * renamed. A directory lock prevents duplicate work across daemon
 * processes; the in-memory promise map handles callers in the same process.
 */
export class AgentPluginCache {
  readonly root: string;
  private readonly options: Required<Pick<
    AgentPluginCacheOptions,
    "maxArchiveBytes" | "maxExtractedBytes" | "maxFiles" | "lockPollMs" | "lockWaitMs" | "staleLockMs"
  >> & AgentPluginCacheOptions;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(options: AgentPluginCacheOptions = {}) {
    this.root = resolve(options.root ?? join(homedir(), ".remi", "plugin-cache", "sha256"));
    this.options = {
      ...options,
      maxArchiveBytes: options.maxArchiveBytes ?? 100 * 1024 * 1024,
      maxExtractedBytes: options.maxExtractedBytes ?? 500 * 1024 * 1024,
      maxFiles: options.maxFiles ?? 20_000,
      lockPollMs: options.lockPollMs ?? 100,
      lockWaitMs: options.lockWaitMs ?? 2 * 60 * 1000,
      staleLockMs: options.staleLockMs ?? 5 * 60 * 1000,
    };
  }

  /** Returns the immutable payload path only when its ready marker is valid. */
  async getReadyPath(snapshotOrDigest: AgentPluginArtifactSpec | string): Promise<string | null> {
    const digest = normalizeSha256Digest(
      typeof snapshotOrDigest === "string" ? snapshotOrDigest : snapshotOrDigest.digest,
    );
    const entry = this.entryPath(digest);
    try {
      const marker = JSON.parse(await readFile(join(entry, READY_MARKER), "utf8")) as ReadyMarker;
      if (marker.schemaVersion !== 1 || marker.digest !== digest) return null;
      if (typeof snapshotOrDigest !== "string" && marker.provider !== snapshotOrDigest.provider) return null;
      if (!(await lstat(join(entry, PAYLOAD_DIR))).isDirectory()) return null;
      return join(entry, PAYLOAD_DIR);
    } catch {
      return null;
    }
  }

  async ensure(snapshot: AgentPluginArtifactSpec, options: EnsurePluginOptions = {}): Promise<string> {
    const digest = normalizeSha256Digest(snapshot.digest);
    const ready = await this.getReadyPath(snapshot);
    if (ready) return ready;

    const existing = this.inflight.get(digest);
    if (existing) return existing;

    const promise = this.install(snapshot, digest, options).finally(() => {
      if (this.inflight.get(digest) === promise) this.inflight.delete(digest);
    });
    this.inflight.set(digest, promise);
    return promise;
  }

  private async install(
    snapshot: AgentPluginArtifactSpec,
    digest: string,
    options: EnsurePluginOptions,
  ): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, ".tmp"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, ".locks"), { recursive: true, mode: 0o700 });

    const release = await this.acquireDigestLock(snapshot, digest, options.signal);
    if (!release) {
      const ready = await this.getReadyPath(snapshot);
      if (ready) return ready;
      throw new AgentPluginError(
        `Agent Plugin ${digest} cache lock completed without a ready entry`,
        "plugin_lock_incomplete",
        "transient",
      );
    }

    const readyAfterLock = await this.getReadyPath(snapshot);
    if (readyAfterLock) {
      await release();
      return readyAfterLock;
    }

    const tempRoot = join(this.root, ".tmp", `${digest}-${randomUUID()}`);
    const artifactPath = join(tempRoot, "artifact.json");
    const payloadPath = join(tempRoot, PAYLOAD_DIR);
    try {
      throwIfAborted(options.signal);
      await mkdir(tempRoot, { recursive: false, mode: 0o700 });

      await options.onPhase?.("downloading");
      await this.download(snapshot.artifactUrl, artifactPath, options.signal);

      await options.onPhase?.("verifying");
      const actualDigest = await sha256File(artifactPath);
      if (actualDigest !== digest) {
        throw new AgentPluginError(
          `Agent Plugin digest mismatch: expected ${digest}, got ${actualDigest}`,
          "plugin_digest_mismatch",
          "transient",
        );
      }

      await options.onPhase?.("installing");
      await mkdir(payloadPath, { recursive: false, mode: 0o700 });
      await materializeCanonicalBundle(snapshot, artifactPath, payloadPath, {
        maxFiles: this.options.maxFiles,
        maxBytes: this.options.maxExtractedBytes,
      });

      const marker: ReadyMarker = {
        schemaVersion: 1,
        digest,
        provider: snapshot.provider,
        installedAt: new Date().toISOString(),
      };
      await writeFile(join(tempRoot, READY_MARKER), `${JSON.stringify(marker)}\n`, { mode: 0o600 });

      const entry = this.entryPath(digest);
      await removeContained(this.root, entry);
      await rename(tempRoot, entry);
      return join(entry, PAYLOAD_DIR);
    } finally {
      await removeContained(this.root, tempRoot).catch(() => {});
      await release().catch(() => {});
    }
  }

  private async download(urlValue: string, destination: string, signal?: AbortSignal): Promise<void> {
    const rawUrl = urlValue.trim();
    if (!rawUrl) {
      throw new AgentPluginError("Agent Plugin artifact URL is empty", "plugin_artifact_missing", "blocked");
    }

    const base = this.options.serverUrl?.trim();
    let url: URL;
    try {
      url = base ? new URL(rawUrl, ensureTrailingSlash(base)) : new URL(rawUrl);
    } catch (error) {
      throw new AgentPluginError(
        `Invalid Agent Plugin artifact URL: ${rawUrl}`,
        "plugin_artifact_url_invalid",
        "blocked",
        { cause: error },
      );
    }

    const headers = new Headers();
    if (base && url.origin === new URL(base).origin) {
      const token = await this.options.getAuthToken?.();
      if (token?.trim()) headers.set("Authorization", `Bearer ${token.trim()}`);
    }

    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, { headers, signal });
    } catch (error) {
      throw new AgentPluginError(
        `Agent Plugin download failed: ${error instanceof Error ? error.message : String(error)}`,
        "plugin_download_failed",
        "transient",
        { cause: error },
      );
    }
    if (!response.ok) {
      const retryKind = response.status >= 500 || response.status === 408 || response.status === 429
        ? "transient"
        : "blocked";
      throw new AgentPluginError(
        `Agent Plugin download returned HTTP ${response.status}`,
        "plugin_download_http_error",
        retryKind,
      );
    }

    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > this.options.maxArchiveBytes) {
      throw new AgentPluginError(
        `Agent Plugin artifact is too large (${declaredSize} bytes)`,
        "plugin_artifact_too_large",
        "blocked",
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.options.maxArchiveBytes) {
      throw new AgentPluginError(
        `Agent Plugin artifact is too large (${bytes.byteLength} bytes)`,
        "plugin_artifact_too_large",
        "blocked",
      );
    }
    throwIfAborted(signal);
    await writeFile(destination, bytes, { mode: 0o600 });
  }

  private async acquireDigestLock(
    snapshot: AgentPluginArtifactSpec,
    digest: string,
    signal?: AbortSignal,
  ): Promise<(() => Promise<void>) | null> {
    const lockPath = join(this.root, ".locks", `${digest}.lock`);
    const started = Date.now();
    while (true) {
      throwIfAborted(signal);
      try {
        await mkdir(lockPath, { mode: 0o700 });
        await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }), {
          mode: 0o600,
        });
        return async () => {
          await removeContained(join(this.root, ".locks"), lockPath);
        };
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }

      if (await this.getReadyPath(snapshot)) return null;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > this.options.staleLockMs) {
        await removeContained(join(this.root, ".locks"), lockPath).catch(() => {});
        continue;
      }
      if (Date.now() - started > this.options.lockWaitMs) {
        throw new AgentPluginError(
          `Timed out waiting for Agent Plugin cache lock ${digest}`,
          "plugin_lock_timeout",
          "transient",
        );
      }
      await abortableDelay(this.options.lockPollMs, signal);
    }
  }

  private entryPath(digest: string): string {
    return join(this.root, digest);
  }
}

export function normalizeSha256Digest(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, "");
  if (!SHA256_RE.test(normalized)) {
    throw new AgentPluginError(
      `Invalid Agent Plugin SHA-256 digest: ${JSON.stringify(value)}`,
      "plugin_digest_invalid",
      "blocked",
    );
  }
  return normalized;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

interface CanonicalPluginBundle {
  provider: unknown;
  manifestPath: unknown;
  manifest: unknown;
  files: unknown;
}

interface CanonicalPluginFile {
  path: unknown;
  encoding: unknown;
  content: unknown;
  size: unknown;
  digest: unknown;
  executable?: unknown;
}

async function materializeCanonicalBundle(
  snapshot: AgentPluginArtifactSpec,
  artifactPath: string,
  payloadPath: string,
  limits: { maxFiles: number; maxBytes: number },
): Promise<void> {
  let bundle: CanonicalPluginBundle;
  try {
    bundle = JSON.parse(await readFile(artifactPath, "utf8")) as CanonicalPluginBundle;
  } catch (error) {
    throw new AgentPluginError(
      `Agent Plugin artifact is not valid canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
      "plugin_artifact_invalid",
      "blocked",
      { cause: error },
    );
  }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new AgentPluginError("Agent Plugin artifact must be an object", "plugin_artifact_invalid", "blocked");
  }
  if (bundle.provider !== snapshot.provider) {
    throw new AgentPluginError(
      `Agent Plugin provider mismatch: expected ${snapshot.provider}, got ${String(bundle.provider)}`,
      "plugin_provider_mismatch",
      "blocked",
    );
  }
  const expectedManifestPath = snapshot.provider === "claude"
    ? ".claude-plugin/plugin.json"
    : ".codex-plugin/plugin.json";
  if (bundle.manifestPath !== expectedManifestPath) {
    throw new AgentPluginError(
      `${snapshot.provider} Plugins require ${expectedManifestPath}`,
      "plugin_manifest_invalid",
      "blocked",
    );
  }
  if (!bundle.manifest || typeof bundle.manifest !== "object" || Array.isArray(bundle.manifest)) {
    throw new AgentPluginError("Agent Plugin manifest must be an object", "plugin_manifest_invalid", "blocked");
  }
  if (!Array.isArray(bundle.files) || bundle.files.length === 0) {
    throw new AgentPluginError("Agent Plugin artifact has no files", "plugin_artifact_empty", "blocked");
  }
  if (bundle.files.length > limits.maxFiles) {
    throw new AgentPluginError(
      `Agent Plugin artifact exceeds ${limits.maxFiles} files`,
      "plugin_payload_too_large",
      "blocked",
    );
  }

  const declaredPaths = (bundle.files as CanonicalPluginFile[]).map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new AgentPluginError("Agent Plugin files must be objects", "plugin_artifact_file_invalid", "blocked");
    }
    return normalizeBundlePath(file.path);
  }).sort();
  for (let index = 1; index < declaredPaths.length; index++) {
    const previous = declaredPaths[index - 1]!;
    const current = declaredPaths[index]!;
    if (current === previous) continue;
    if (current.startsWith(`${previous}/`)) {
      throw new AgentPluginError(
        `Agent Plugin path is both a file and directory: ${previous}`,
        "plugin_artifact_path_collision",
        "blocked",
      );
    }
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  let manifestBytes: Uint8Array | null = null;
  for (const rawFile of bundle.files as CanonicalPluginFile[]) {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) {
      throw new AgentPluginError("Agent Plugin files must be objects", "plugin_artifact_file_invalid", "blocked");
    }
    const path = normalizeBundlePath(rawFile.path);
    if (seen.has(path)) {
      throw new AgentPluginError(`Duplicate Agent Plugin file: ${path}`, "plugin_artifact_file_duplicate", "blocked");
    }
    seen.add(path);

    if (rawFile.encoding !== "utf8" && rawFile.encoding !== "base64") {
      throw new AgentPluginError(
        `Invalid encoding for Agent Plugin file ${path}`,
        "plugin_artifact_file_invalid",
        "blocked",
      );
    }
    if (typeof rawFile.content !== "string") {
      throw new AgentPluginError(
        `Missing content for Agent Plugin file ${path}`,
        "plugin_artifact_file_invalid",
        "blocked",
      );
    }
    const bytes = decodeBundleFile(rawFile.content, rawFile.encoding, path);
    const declaredSize = typeof rawFile.size === "number" ? rawFile.size : NaN;
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize !== bytes.byteLength) {
      throw new AgentPluginError(
        `Size mismatch for Agent Plugin file ${path}: expected ${String(rawFile.size)}, got ${bytes.byteLength}`,
        "plugin_artifact_file_size_mismatch",
        "blocked",
      );
    }
    const actualDigest = sha256Bytes(bytes);
    let expectedDigest: string;
    try {
      expectedDigest = normalizeSha256Digest(String(rawFile.digest ?? ""));
    } catch (error) {
      throw new AgentPluginError(
        `Invalid digest for Agent Plugin file ${path}`,
        "plugin_artifact_file_digest_invalid",
        "blocked",
        { cause: error },
      );
    }
    if (actualDigest !== expectedDigest) {
      throw new AgentPluginError(
        `Digest mismatch for Agent Plugin file ${path}: expected ${expectedDigest}, got ${actualDigest}`,
        "plugin_artifact_file_digest_mismatch",
        "blocked",
      );
    }

    totalBytes += bytes.byteLength;
    if (totalBytes > limits.maxBytes) {
      throw new AgentPluginError(
        `Agent Plugin payload exceeds ${limits.maxBytes} bytes`,
        "plugin_payload_too_large",
        "blocked",
      );
    }

    const destination = resolve(payloadPath, path);
    assertContained(payloadPath, destination);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: rawFile.executable === true ? 0o555 : 0o444 });
    if (path === expectedManifestPath) manifestBytes = bytes;
  }

  if (!manifestBytes) {
    throw new AgentPluginError(
      `${snapshot.provider} Plugin manifest file is missing`,
      "plugin_manifest_invalid",
      "blocked",
    );
  }
  let fileManifest: unknown;
  try {
    fileManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (error) {
    throw new AgentPluginError(
      `${snapshot.provider} Plugin manifest file is invalid JSON`,
      "plugin_manifest_invalid",
      "blocked",
      { cause: error },
    );
  }
  if (canonicalJson(fileManifest) !== canonicalJson(bundle.manifest)) {
    throw new AgentPluginError(
      "Agent Plugin top-level manifest does not match its manifest file",
      "plugin_manifest_mismatch",
      "blocked",
    );
  }

  // Re-read the finished tree to prove no unexpected filesystem entries were
  // introduced while materializing the bundle.
  const queue = [payloadPath];
  while (queue.length) {
    const directory = queue.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isDirectory()) {
        queue.push(path);
      } else if (!info.isFile() || info.isSymbolicLink()) {
        throw new AgentPluginError(
          `Agent Plugin payload contains an unsafe entry: ${relative(payloadPath, path)}`,
          "plugin_artifact_file_invalid",
          "blocked",
        );
      }
    }
  }
}

function normalizeBundlePath(value: unknown): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new AgentPluginError(
      `Invalid Agent Plugin file path: ${path || "(empty)"}`,
      "plugin_artifact_path_invalid",
      "blocked",
    );
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new AgentPluginError(`Invalid Agent Plugin file path: ${path}`, "plugin_artifact_path_invalid", "blocked");
  }
  return segments.join("/");
}

function decodeBundleFile(content: string, encoding: "utf8" | "base64", path: string): Uint8Array {
  if (encoding === "utf8") return Buffer.from(content, "utf8");
  const compact = content.replace(/\s+/g, "");
  if (compact && (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0)) {
    throw new AgentPluginError(
      `Invalid base64 content for Agent Plugin file ${path}`,
      "plugin_artifact_file_invalid",
      "blocked",
    );
  }
  return Buffer.from(compact, "base64");
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

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new AgentPluginError(
      `Agent Plugin file escapes payload directory: ${target}`,
      "plugin_artifact_path_invalid",
      "blocked",
    );
  }
}

async function removeContained(root: string, target: string): Promise<void> {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`refusing to remove path outside Agent Plugin cache: ${target}`);
  }
  await rm(targetPath, { recursive: true, force: true });
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AgentPluginError("Agent Plugin operation cancelled", "plugin_cancelled", "transient");
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  throwIfAborted(signal);
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AgentPluginError("Agent Plugin operation cancelled", "plugin_cancelled", "transient"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
