import { mkdtemp, rm } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ipaddr from "ipaddr.js";

const MAX_ARTIFACT_FILES = 2_000;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_PLUGIN_CANDIDATES = 200;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_GIT_STDERR_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const GIT_OPERATION_TIMEOUT_MS = 60_000;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FULL_GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TEST_FILE_URL_ENV = "MULTIREMI_AGENT_PLUGIN_TEST_ALLOW_FILE_URLS";
const PRIVATE_GIT_HOSTS_ENV = "MULTIREMI_AGENT_PLUGIN_GIT_PRIVATE_HOSTS";

const MANIFESTS = [
  { provider: "claude" as const, path: ".claude-plugin/plugin.json" },
  { provider: "codex" as const, path: ".codex-plugin/plugin.json" },
];

export class AgentPluginGitImportError extends Error {
  constructor(
    message: string,
    readonly code = "invalid_agent_plugin_git_source",
    readonly status: 400 | 409 | 502 | 503 | 504 = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentPluginGitImportError";
  }
}

export interface ResolveAgentPluginGitSourceInput {
  sourceUrl: string;
  sourceRef?: string | null;
  sourceSubdir?: string | null;
  provider?: "claude" | "codex" | null;
  manifestPath?: string | null;
  includeFiles?: boolean;
  exactSourceSubdir?: boolean;
}

export interface ResolvedAgentPluginGitFile {
  path: string;
  content: string;
  encoding: "base64";
  executable?: boolean;
}

export interface ResolvedAgentPluginGitCandidate {
  provider: "claude" | "codex";
  name: string;
  description: string;
  version: string;
  pluginSubdir: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  /** Includes the manifest, even though `files` deliberately excludes it. */
  fileCount: number;
  /** Includes the manifest bytes. */
  artifactSize: number;
  /**
   * Paths are relative to the Plugin root. The manifest is omitted because the
   * canonical artifact builder regenerates it from `manifest`.
   */
  files?: ResolvedAgentPluginGitFile[];
}

export interface ResolvedAgentPluginGitSource {
  sourceUrl: string;
  sourceRef: string;
  defaultBranch: string;
  branches: string[];
  sourceRevision: string;
  candidates: ResolvedAgentPluginGitCandidate[];
}

export type AgentPluginGitSourceResolver = (
  input: ResolveAgentPluginGitSourceInput,
) => Promise<ResolvedAgentPluginGitSource>;

interface GitTreeEntry {
  mode: string;
  type: string;
  objectId: string;
  size: number | null;
  path: string;
}

interface GitRemoteMetadata {
  defaultBranch: string;
  branches: string[];
}

interface GitCommandOptions {
  input?: Uint8Array;
  maxOutputBytes?: number;
  timeoutMs?: number;
  errorCode?: string;
  errorMessage?: string;
  errorStatus?: 400 | 409 | 502 | 503 | 504;
  deadlineAt?: number;
}

/**
 * Resolve one immutable Git revision into provider-native Plugin candidates.
 *
 * Production accepts the same remote URL families as workspace repositories.
 * `file://` exists solely for hermetic tests and requires both NODE_ENV=test and
 * MULTIREMI_AGENT_PLUGIN_TEST_ALLOW_FILE_URLS=1.
 */
export async function resolveAgentPluginGitSource(
  input: ResolveAgentPluginGitSourceInput,
): Promise<ResolvedAgentPluginGitSource> {
  const sourceUrl = normalizeGitRemoteUrl(input.sourceUrl);
  await assertGitRemoteHostAllowed(sourceUrl);
  const requestedRef = normalizeGitRef(input.sourceRef);
  const sourceSubdirWasSelected = input.sourceSubdir !== undefined && input.sourceSubdir !== null;
  const sourceSubdir = normalizeSourceSubdir(input.sourceSubdir);
  const selectedProvider = normalizeProvider(input.provider);
  const selectedManifestPath = normalizeManifestPath(input.manifestPath);
  const deadlineAt = Date.now() + GIT_OPERATION_TIMEOUT_MS;
  const remote = await inspectGitRemote(sourceUrl, requestedRef === null, deadlineAt);
  const sourceRef = requestedRef ?? remote.defaultBranch;
  await assertRequestedRefAvailable(sourceUrl, sourceRef, remote.branches, deadlineAt);
  const tempRoot = await mkdtemp(join(tmpdir(), "multiremi-agent-plugin-git-"));
  const bareRepo = join(tempRoot, "source.git");

  try {
    await runGit(["init", "--bare", bareRepo], {
      errorCode: "plugin_git_init_failed",
      errorMessage: "unable to initialize the temporary Plugin repository",
      errorStatus: 503,
      deadlineAt,
    });
    await runGit([`--git-dir=${bareRepo}`, "remote", "add", "origin", sourceUrl], {
      errorCode: "plugin_git_init_failed",
      errorMessage: "unable to configure the temporary Plugin repository",
      errorStatus: 503,
      deadlineAt,
    });
    await runGit(
      [
        `--git-dir=${bareRepo}`,
        "fetch",
        "--depth=1",
        "--filter=blob:none",
        "--no-tags",
        "origin",
        remoteFetchRef(sourceRef, remote.branches),
      ],
      {
        errorCode: "plugin_git_fetch_failed",
        errorMessage: `unable to fetch Plugin source ref ${JSON.stringify(sourceRef)}`,
        errorStatus: 502,
        deadlineAt,
      },
    );
    const revisionOutput = await runGit(
      [`--git-dir=${bareRepo}`, "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
      {
        errorCode: "plugin_git_ref_invalid",
        errorMessage: "the fetched Plugin source does not resolve to a commit",
        deadlineAt,
      },
    );
    const sourceRevision = Buffer.from(revisionOutput).toString("utf8").trim().toLowerCase();
    if (!FULL_GIT_OBJECT_ID.test(sourceRevision)) {
      throw new AgentPluginGitImportError(
        "the fetched Plugin source returned an invalid revision",
        "plugin_git_revision_invalid",
      );
    }

    const discovered = (await discoverManifestEntries(
      bareRepo,
      sourceRevision,
      sourceSubdir,
      deadlineAt,
    ))
      .filter((candidate) => !selectedProvider || candidate.provider === selectedProvider)
      .filter((candidate) => !selectedManifestPath || candidate.manifestPath === selectedManifestPath)
      .filter((candidate) => (
        input.includeFiles !== true
        || input.exactSourceSubdir !== true
        || !sourceSubdirWasSelected
        || candidate.pluginSubdir === (sourceSubdir ?? "")
      ));
    if (discovered.length === 0) {
      throw new AgentPluginGitImportError(
        sourceSubdir
          ? `no Claude or Codex Plugin manifest was found under ${sourceSubdir}`
          : "no Claude or Codex Plugin manifest was found in the repository",
        "plugin_manifest_not_found",
      );
    }
    if (discovered.length > MAX_PLUGIN_CANDIDATES) {
      throw new AgentPluginGitImportError(
        `Plugin repository contains more than ${MAX_PLUGIN_CANDIDATES} candidates`,
        "plugin_candidate_limit_exceeded",
      );
    }

    const candidates: ResolvedAgentPluginGitCandidate[] = [];
    let firstCandidateError: AgentPluginGitImportError | null = null;
    for (const discoveredManifest of discovered) {
      try {
        candidates.push(await resolveCandidate(
          bareRepo,
          sourceRevision,
          discoveredManifest,
          input.includeFiles === true,
          deadlineAt,
        ));
      } catch (error) {
        if (input.includeFiles === true || !(error instanceof AgentPluginGitImportError)) {
          throw error;
        }
        firstCandidateError ??= error;
      }
    }
    if (candidates.length === 0 && firstCandidateError) {
      throw firstCandidateError;
    }

    return {
      sourceUrl,
      sourceRef,
      defaultBranch: remote.defaultBranch,
      branches: remote.branches,
      sourceRevision,
      candidates: candidates.sort((left, right) =>
        left.pluginSubdir.localeCompare(right.pluginSubdir) || left.provider.localeCompare(right.provider)
      ),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function inspectGitRemote(
  sourceUrl: string,
  requireDefaultBranch: boolean,
  deadlineAt: number,
): Promise<GitRemoteMetadata> {
  const output = await runGit(
    ["ls-remote", "--symref", sourceUrl, "HEAD", "refs/heads/*"],
    {
      maxOutputBytes: 8 * 1024 * 1024,
      errorCode: "plugin_git_remote_unavailable",
      errorMessage: "unable to read Plugin repository metadata; check the clone URL and server credentials",
      errorStatus: 502,
      deadlineAt,
    },
  );
  const text = decodeUtf8(output, "plugin_git_remote_invalid");
  const branches = new Set<string>();
  let defaultBranch = "";
  for (const line of text.split(/\r?\n/)) {
    const symbolicHead = line.match(/^ref:\s+refs\/heads\/(.+)\tHEAD$/);
    if (symbolicHead?.[1]) {
      defaultBranch = validateRemoteBranch(symbolicHead[1]);
      branches.add(defaultBranch);
      continue;
    }
    const branch = line.match(/^[0-9a-f]{40}(?:[0-9a-f]{24})?\trefs\/heads\/(.+)$/i)?.[1];
    if (branch) branches.add(validateRemoteBranch(branch));
  }
  const sortedBranches = [...branches].sort((left, right) => left.localeCompare(right));
  if (!defaultBranch && sortedBranches.length === 1) defaultBranch = sortedBranches[0]!;
  if (!defaultBranch && requireDefaultBranch) {
    throw new AgentPluginGitImportError(
      "Plugin repository does not advertise a default branch",
      "plugin_git_default_branch_missing",
    );
  }
  return { defaultBranch, branches: sortedBranches };
}

async function assertRequestedRefAvailable(
  sourceUrl: string,
  sourceRef: string,
  branches: string[],
  deadlineAt: number,
): Promise<void> {
  if (FULL_GIT_OBJECT_ID.test(sourceRef) || branches.includes(sourceRef)) return;
  const patterns = sourceRef.startsWith("refs/")
    ? [sourceRef]
    : [sourceRef, `refs/heads/${sourceRef}`, `refs/tags/${sourceRef}`];
  const output = await runGit(["ls-remote", "--refs", sourceUrl, ...patterns], {
    maxOutputBytes: 1024 * 1024,
    errorCode: "plugin_git_remote_unavailable",
    errorMessage: "unable to verify the Plugin repository ref",
    errorStatus: 502,
    deadlineAt,
  });
  if (output.byteLength === 0) {
    throw new AgentPluginGitImportError(
      `Plugin source ref ${JSON.stringify(sourceRef)} was not found`,
      "plugin_git_ref_not_found",
    );
  }
}

async function discoverManifestEntries(
  bareRepo: string,
  revision: string,
  sourceSubdir: string | null,
  deadlineAt: number,
): Promise<Array<GitTreeEntry & { provider: "claude" | "codex"; pluginSubdir: string; manifestPath: string }>> {
  const args = [
    `--git-dir=${bareRepo}`,
    "ls-tree",
    "-r",
    "-z",
    "-l",
    "--full-tree",
    revision,
  ];
  if (sourceSubdir) args.push("--", `:(literal)${sourceSubdir}`);
  const output = await runGit(args, {
    maxOutputBytes: 8 * 1024 * 1024,
    errorCode: "plugin_git_tree_invalid",
    errorMessage: "unable to inspect Plugin manifests in the fetched revision",
    deadlineAt,
  });
  const matches: Array<GitTreeEntry & {
    provider: "claude" | "codex";
    pluginSubdir: string;
    manifestPath: string;
  }> = [];
  for (const entry of parseLsTree(output)) {
    for (const nativeManifest of MANIFESTS) {
      const suffix = `/${nativeManifest.path}`;
      if (entry.path !== nativeManifest.path && !entry.path.endsWith(suffix)) continue;
      const pluginSubdir = entry.path === nativeManifest.path
        ? ""
        : entry.path.slice(0, -suffix.length);
      if (
        sourceSubdir
        && pluginSubdir !== sourceSubdir
        && !pluginSubdir.startsWith(`${sourceSubdir}/`)
      ) continue;
      matches.push({
        ...entry,
        provider: nativeManifest.provider,
        pluginSubdir,
        manifestPath: nativeManifest.path,
      });
    }
  }
  return matches;
}

async function resolveCandidate(
  bareRepo: string,
  revision: string,
  discovered: GitTreeEntry & {
    provider: "claude" | "codex";
    pluginSubdir: string;
    manifestPath: string;
  },
  includeFiles: boolean,
  deadlineAt: number,
): Promise<ResolvedAgentPluginGitCandidate> {
  if (discovered.mode !== "100644" && discovered.mode !== "100755") {
    throw unsafeFile(discovered.path);
  }
  const entries = await listPluginEntries(
    bareRepo,
    revision,
    discovered.pluginSubdir,
    deadlineAt,
  );
  if (entries.length > MAX_ARTIFACT_FILES) {
    throw new AgentPluginGitImportError(
      `Plugin artifact exceeds ${MAX_ARTIFACT_FILES} files`,
      "plugin_artifact_too_large",
    );
  }

  let artifactSize = 0;
  const normalized = entries.map((entry) => {
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755") || entry.size === null) {
      throw unsafeFile(entry.path);
    }
    const size = entry.size;
    const path = relativePluginPath(entry.path, discovered.pluginSubdir);
    if (path === ".git" || path.startsWith(".git/")) throw unsafeFile(entry.path);
    artifactSize += size;
    return { ...entry, size, relativePath: path };
  });
  if (artifactSize > MAX_ARTIFACT_BYTES) {
    throw new AgentPluginGitImportError(
      `Plugin artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`,
      "plugin_artifact_too_large",
    );
  }

  const manifestEntry = normalized.find((entry) => entry.relativePath === discovered.manifestPath);
  if (!manifestEntry) {
    throw new AgentPluginGitImportError("Plugin manifest disappeared from the fetched tree", "plugin_manifest_not_found");
  }
  const [manifestBytes] = await catFileObjects(
    bareRepo,
    [manifestEntry.objectId],
    manifestEntry.size + 1024,
    deadlineAt,
  );
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(Buffer.from(manifestBytes!).toString("utf8"));
  } catch {
    throw new AgentPluginGitImportError(
      `invalid JSON in ${discovered.path}`,
      "plugin_manifest_invalid",
    );
  }
  if (!isRecord(manifestValue)) {
    throw new AgentPluginGitImportError(
      `Plugin manifest ${discovered.path} must be a JSON object`,
      "plugin_manifest_invalid",
    );
  }
  const manifest = manifestValue as Record<string, unknown>;
  const name = cleanString(manifest.name);
  if (!name) {
    throw new AgentPluginGitImportError(
      `Plugin manifest ${discovered.path} requires a name`,
      "plugin_name_missing",
    );
  }
  const description = cleanString(manifest.description) ?? "";
  const version = resolveVersion(manifest, discovered.provider, revision, discovered.path);

  let files: ResolvedAgentPluginGitFile[] | undefined;
  if (includeFiles) {
    const artifactEntries = normalized.filter((entry) => entry.relativePath !== discovered.manifestPath);
    const contents = await catFileObjects(
      bareRepo,
      artifactEntries.map((entry) => entry.objectId),
      artifactEntries.reduce((total, entry) => total + entry.size, 0) + artifactEntries.length * 128 + 1024,
      deadlineAt,
    );
    files = artifactEntries.map((entry, index) => {
      const bytes = contents[index]!;
      if (bytes.byteLength !== entry.size) {
        throw new AgentPluginGitImportError(
          `Git object size changed while reading ${entry.path}`,
          "plugin_artifact_file_invalid",
        );
      }
      return {
        path: entry.relativePath,
        content: Buffer.from(bytes).toString("base64"),
        encoding: "base64" as const,
        ...(entry.mode === "100755" ? { executable: true } : {}),
      };
    });
  }

  return {
    provider: discovered.provider,
    name,
    description,
    version,
    pluginSubdir: discovered.pluginSubdir,
    manifestPath: discovered.manifestPath,
    manifest,
    fileCount: normalized.length,
    artifactSize,
    ...(files ? { files } : {}),
  };
}

async function listPluginEntries(
  bareRepo: string,
  revision: string,
  pluginSubdir: string,
  deadlineAt: number,
): Promise<GitTreeEntry[]> {
  const args = [
    `--git-dir=${bareRepo}`,
    "ls-tree",
    "-r",
    "-z",
    "-l",
    "--full-tree",
    revision,
  ];
  if (pluginSubdir) args.push("--", `:(literal)${pluginSubdir}`);
  const output = await runGit(args, {
    maxOutputBytes: 8 * 1024 * 1024,
    errorCode: "plugin_git_tree_invalid",
    errorMessage: "unable to inspect files in the fetched Plugin revision",
    deadlineAt,
  });
  return parseLsTree(output);
}

async function catFileObjects(
  bareRepo: string,
  objectIds: string[],
  outputLimit: number,
  deadlineAt: number,
): Promise<Uint8Array[]> {
  if (objectIds.length === 0) return [];
  const input = Buffer.from(`${objectIds.join("\n")}\n`, "utf8");
  const output = await runGit(
    [`--git-dir=${bareRepo}`, "cat-file", "--batch"],
    {
      input,
      maxOutputBytes: Math.min(MAX_GIT_OUTPUT_BYTES, Math.max(1024, outputLimit)),
      errorCode: "plugin_git_object_invalid",
      errorMessage: "unable to read Plugin files from the fetched revision",
      deadlineAt,
    },
  );
  const results: Uint8Array[] = [];
  let offset = 0;
  for (const expected of objectIds) {
    const newline = output.indexOf(10, offset);
    if (newline < 0) throw invalidBatchOutput();
    const header = Buffer.from(output.subarray(offset, newline)).toString("utf8");
    const match = header.match(/^([0-9a-f]{40}(?:[0-9a-f]{24})?) blob (\d+)$/);
    if (!match || match[1] !== expected) throw invalidBatchOutput();
    const size = Number(match[2]);
    const contentStart = newline + 1;
    const contentEnd = contentStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || contentEnd >= output.byteLength || output[contentEnd] !== 10) {
      throw invalidBatchOutput();
    }
    results.push(output.slice(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  if (offset !== output.byteLength) throw invalidBatchOutput();
  return results;
}

function parseLsTree(output: Uint8Array): GitTreeEntry[] {
  const text = decodeUtf8(output, "plugin_git_tree_invalid");
  if (!text) return [];
  const records = text.split("\0");
  if (records.at(-1) === "") records.pop();
  return records.map((record) => {
    const match = record.match(/^([0-7]{6}) ([a-z]+) ([0-9a-f]{40}(?:[0-9a-f]{24})?) +(-|\d+)\t([\s\S]+)$/);
    if (!match) {
      throw new AgentPluginGitImportError("Git returned an invalid tree entry", "plugin_git_tree_invalid");
    }
    const size = match[4] === "-" ? null : Number(match[4]);
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) {
      throw new AgentPluginGitImportError("Git returned an invalid object size", "plugin_git_tree_invalid");
    }
    return {
      mode: match[1]!,
      type: match[2]!,
      objectId: match[3]!,
      size,
      path: match[5]!,
    };
  });
}

function relativePluginPath(path: string, pluginSubdir: string): string {
  const relative = pluginSubdir ? path.slice(pluginSubdir.length + 1) : path;
  if (
    !relative
    || relative.includes("\0")
    || relative.includes("\\")
    || relative.startsWith("/")
    || /^[A-Za-z]:/.test(relative)
    || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new AgentPluginGitImportError(
      `invalid Plugin file path: ${JSON.stringify(path)}`,
      "plugin_artifact_path_invalid",
    );
  }
  return relative;
}

function resolveVersion(
  manifest: Record<string, unknown>,
  provider: "claude" | "codex",
  revision: string,
  manifestPath: string,
): string {
  const version = cleanString(manifest.version);
  if (!version) {
    if (provider === "claude") return `0.0.0+git.${revision.slice(0, 12)}`;
    throw new AgentPluginGitImportError(
      `Codex Plugin manifest ${manifestPath} requires a version`,
      "plugin_version_missing",
    );
  }
  if (!SEMVER_PATTERN.test(version)) {
    throw new AgentPluginGitImportError(
      `Plugin manifest ${manifestPath} has an invalid SemVer version`,
      "plugin_version_invalid",
    );
  }
  return version;
}

function normalizeGitRemoteUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || /\s/.test(raw)) throw invalidGitUrl();
  if (/^[^@\s]+@[^:\s]+:.+/.test(raw)) return raw.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidGitUrl();
  }
  if (parsed.protocol === "file:") {
    if (
      process.env.NODE_ENV !== "test"
      || process.env[TEST_FILE_URL_ENV] !== "1"
      || parsed.username
      || parsed.password
      || (parsed.hostname && parsed.hostname !== "localhost")
      || !parsed.pathname.startsWith("/")
    ) throw invalidGitUrl();
    return parsed.href.replace(/\/$/, "");
  }
  if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) throw invalidGitUrl();
  const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
  if (
    !parsed.hostname
    || !normalizedRepositoryPath(parsed.pathname)
    || parsed.password
    || parsed.search
    || parsed.hash
    || (isHttp && parsed.username)
  ) throw invalidGitUrl();
  return raw.replace(/\/+$/, "");
}

async function assertGitRemoteHostAllowed(sourceUrl: string): Promise<void> {
  if (sourceUrl.startsWith("file:")) return;
  const scpHost = sourceUrl.match(/^[^@\s]+@([^:\s]+):/)?.[1];
  let hostname = scpHost ?? "";
  if (!hostname) {
    try {
      hostname = new URL(sourceUrl).hostname;
    } catch {
      throw invalidGitUrl();
    }
  }
  const normalizedHost = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (privateGitHostAllowed(normalizedHost)) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dnsLookup(normalizedHost, { all: true });
  } catch (cause) {
    throw new AgentPluginGitImportError(
      "unable to resolve Plugin Git repository host",
      "plugin_git_remote_unavailable",
      502,
      { cause },
    );
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new AgentPluginGitImportError(
      "Plugin Git repository host is not allowed",
      "plugin_git_host_not_allowed",
    );
  }
}

function privateGitHostAllowed(hostname: string): boolean {
  const configured = String(process.env[PRIVATE_GIT_HOSTS_ENV] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return ["code.byted.org", ...configured].some((pattern) => (
    pattern.startsWith("*.")
      ? hostname.endsWith(pattern.slice(1)) && hostname !== pattern.slice(2)
      : hostname === pattern
  ));
}

function isPrivateIp(value: string): boolean {
  try {
    const address = ipaddr.process(value.split("%", 1)[0]!);
    return address.range() !== "unicast";
  } catch {
    return true;
  }
}

function normalizeProvider(value: unknown): "claude" | "codex" | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === "claude" || value === "codex") return value;
  throw new AgentPluginGitImportError(
    "invalid Plugin provider selection",
    "plugin_provider_invalid",
  );
}

function normalizeManifestPath(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const path = typeof value === "string" ? value.trim() : "";
  if (!MANIFESTS.some((manifest) => manifest.path === path)) {
    throw new AgentPluginGitImportError(
      "invalid Plugin manifest selection",
      "plugin_manifest_path_invalid",
    );
  }
  return path;
}

function normalizeGitRef(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const ref = typeof value === "string" ? value.trim() : "";
  if (
    !ref
    || ref.length > 1024
    || ref.startsWith("-")
    || ref.startsWith("/")
    || ref.endsWith("/")
    || ref.endsWith(".")
    || ref.includes("..")
    || ref.includes("//")
    || ref.includes("@{")
    || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref)
    || ref.split("/").some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"))
  ) {
    throw new AgentPluginGitImportError("invalid Plugin source ref", "plugin_git_ref_invalid");
  }
  return ref;
}

function normalizeSourceSubdir(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const raw = typeof value === "string" ? value.trim().replace(/\/$/, "") : "";
  if (
    !raw
    || raw.length > 4096
    || raw.includes("\0")
    || raw.includes("\\")
    || raw.startsWith("/")
    || /^[A-Za-z]:/.test(raw)
    || raw.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new AgentPluginGitImportError("invalid Plugin source subdirectory", "plugin_git_subdir_invalid");
  }
  return raw;
}

function remoteFetchRef(sourceRef: string, branches: string[]): string {
  if (sourceRef.startsWith("refs/") || FULL_GIT_OBJECT_ID.test(sourceRef)) return sourceRef;
  return branches.includes(sourceRef) ? `refs/heads/${sourceRef}` : sourceRef;
}

async function runGit(args: string[], options: GitCommandOptions = {}): Promise<Uint8Array> {
  const remainingBudget = options.deadlineAt === undefined
    ? GIT_TIMEOUT_MS
    : options.deadlineAt - Date.now();
  if (remainingBudget <= 0) throw gitTimeoutError();
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
  };
  const proc = (() => {
    try {
      return Bun.spawn(["git", "-c", "http.followRedirects=false", ...args], {
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (cause) {
      throw new AgentPluginGitImportError(
        options.errorMessage ?? "unable to run git",
        options.errorCode ?? "plugin_git_command_failed",
        options.errorStatus ?? 503,
        { cause },
      );
    }
  })();
  if (options.input) proc.stdin.write(options.input);
  try {
    proc.stdin.end();
  } catch {}

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, Math.min(options.timeoutMs ?? GIT_TIMEOUT_MS, remainingBudget));
  const stdoutPromise = readLimited(proc.stdout, options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES, () => proc.kill());
  const stderrPromise = readLimited(proc.stderr, MAX_GIT_STDERR_BYTES, () => proc.kill());
  const [exitResult, stdoutResult, stderrResult] = await Promise.allSettled([
    proc.exited,
    stdoutPromise,
    stderrPromise,
  ]);
  clearTimeout(timeout);
  if (timedOut) {
    throw gitTimeoutError();
  }
  if (stdoutResult.status === "rejected") throw stdoutResult.reason;
  if (stderrResult.status === "rejected") throw stderrResult.reason;
  if (exitResult.status === "rejected" || exitResult.value !== 0) {
    throw new AgentPluginGitImportError(
      options.errorMessage ?? "Plugin Git operation failed",
      options.errorCode ?? "plugin_git_command_failed",
      options.errorStatus ?? 400,
    );
  }
  return stdoutResult.value;
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onLimit: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        onLimit();
        throw new AgentPluginGitImportError("Plugin Git output is too large", "plugin_git_output_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function invalidGitUrl(): AgentPluginGitImportError {
  return new AgentPluginGitImportError("invalid Plugin Git repository URL", "plugin_git_url_invalid");
}

function unsafeFile(path: string): AgentPluginGitImportError {
  return new AgentPluginGitImportError(
    `Plugin artifact contains a symbolic link or special file: ${path}`,
    "plugin_artifact_file_invalid",
  );
}

function invalidBatchOutput(): AgentPluginGitImportError {
  return new AgentPluginGitImportError("Git returned invalid Plugin object data", "plugin_git_object_invalid");
}

function gitTimeoutError(): AgentPluginGitImportError {
  return new AgentPluginGitImportError(
    "Plugin Git operation timed out",
    "plugin_git_timeout",
    504,
  );
}

function validateRemoteBranch(value: string): string {
  try {
    return normalizeGitRef(value)!;
  } catch {
    throw new AgentPluginGitImportError(
      "Plugin repository advertised an invalid branch name",
      "plugin_git_remote_invalid",
    );
  }
}

function decodeUtf8(value: Uint8Array, code: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new AgentPluginGitImportError("Git returned invalid UTF-8 data", code);
  }
}

function normalizedRepositoryPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
}

function cleanString(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
