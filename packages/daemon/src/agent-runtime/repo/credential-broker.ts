import { spawnSync } from "node:child_process";
import { basename } from "node:path";

export const MULTIREMI_GIT_CREDENTIAL_ENDPOINT = "/api/daemon/scm/git-credentials";
export const DEFAULT_GIT_CREDENTIAL_TIMEOUT_MS = 10_000;

export interface GitCredentialBrokerEnvOptions {
  serverUrl: string;
  token?: string | null;
  workspaceId: string;
  taskId?: string | null;
  repositoryUrl?: string | null;
  repositoryUrls?: string[];
  timeoutMs?: number;
  helperCommand?: string;
  /** Trusted machine-level helpers used only when Multiremi has no credential. */
  fallbackHelpers?: string[];
}

export interface GitCredentialProtocolInput {
  protocol?: string;
  host?: string;
  path?: string;
  username?: string;
  url?: string;
}

export interface GitCredentialHelperOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

interface GitCredentialResponse {
  repositoryId: string;
  repositoryUrl: string;
  cloneUrl: string;
  username: string;
  password: string;
  expiresAt: string | null;
}

/**
 * Add a process-only credential helper. The helper command and repository
 * identities are non-secret; the Multiremi token remains a child-process env
 * value and the JIT Git credential only crosses the helper's stdout pipe.
 */
export function appendGitCredentialBrokerEnv(
  base: NodeJS.ProcessEnv | Record<string, string>,
  options: GitCredentialBrokerEnvOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const helper = options.helperCommand?.trim() || defaultRemiGitCredentialHelperCommand();
  appendGitConfig(env, "credential.helper", "");
  appendGitConfig(env, "credential.helper", `!${helper}`);
  for (const fallback of options.fallbackHelpers ?? trustedGlobalCredentialHelpers(base)) {
    const value = fallback.trim();
    if (value && value !== `!${helper}`) appendGitConfig(env, "credential.helper", value);
  }
  appendGitConfig(env, "credential.useHttpPath", "true");

  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "Never";
  if (!env.GIT_SSH_COMMAND?.trim()) {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=10";
  }
  env.MULTIREMI_SERVER_URL = options.serverUrl.replace(/\/+$/, "");
  env.MULTIREMI_WORKSPACE_ID = options.workspaceId;
  if (options.token) env.MULTIREMI_TOKEN = options.token;
  else delete env.MULTIREMI_TOKEN;
  if (options.taskId) env.MULTIREMI_TASK_ID = options.taskId;
  if (options.repositoryUrl) env.MULTIREMI_GIT_REPOSITORY_URL = options.repositoryUrl;
  else delete env.MULTIREMI_GIT_REPOSITORY_URL;
  const repositoryUrls = [...new Set((options.repositoryUrls ?? []).map((url) => url.trim()).filter(Boolean))];
  if (repositoryUrls.length) env.MULTIREMI_GIT_REPOSITORIES_JSON = JSON.stringify(repositoryUrls);
  else delete env.MULTIREMI_GIT_REPOSITORIES_JSON;
  env.MULTIREMI_GIT_CREDENTIAL_TIMEOUT_MS = String(
    positiveInteger(options.timeoutMs, DEFAULT_GIT_CREDENTIAL_TIMEOUT_MS),
  );
  return env;
}

/** Convert the common SSH clone forms to the equivalent credential-helper HTTP transport. */
export function preferredHttpsCloneUrl(repositoryUrl: string): string {
  const value = repositoryUrl.trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (isLocalRepositoryUrl(value)) return value;

  if (value.includes("://")) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "ssh:" && parsed.protocol !== "git+ssh:") return value;
      if (parsed.port && parsed.port !== "22") return value;
      return `https://${parsed.hostname}/${parsed.pathname.replace(/^\/+/, "")}`;
    } catch {
      return value;
    }
  }

  const scp = value.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
  return scp && !looksLikeWindowsPath(value)
    ? `https://${scp[1]}/${scp[2].replace(/^\/+/, "")}`
    : value;
}

/** True when an SSH URL can be moved to HTTPS without guessing a custom port. */
export function isBrokerCompatibleRepositoryUrl(repositoryUrl: string): boolean {
  const value = repositoryUrl.trim();
  if (!value || isLocalRepositoryUrl(value) || /^https?:\/\//i.test(value)) return true;
  return preferredHttpsCloneUrl(value) !== value;
}

/**
 * Git credential-helper implementation. Only `get` reaches the Server;
 * `store`/`erase` are intentionally no-ops because credentials are ephemeral.
 */
export async function runGitCredentialHelper(
  operation: string,
  options: GitCredentialHelperOptions = {},
): Promise<string> {
  if (operation === "store" || operation === "erase") return "";
  if (operation !== "get") throw new Error("git credential helper expects get, store, or erase");

  const env = options.env ?? process.env;
  const input = parseGitCredentialProtocolInput(options.input ?? await readStandardInput());
  const protocol = input.protocol?.toLowerCase();
  if (protocol !== "http" && protocol !== "https") return "";
  if (!input.host) return "";

  const serverUrl = String(env.MULTIREMI_SERVER_URL ?? "").trim().replace(/\/+$/, "");
  const workspaceId = String(env.MULTIREMI_WORKSPACE_ID ?? "").trim();
  if (!serverUrl) throw new Error("Git credential broker is missing MULTIREMI_SERVER_URL");
  if (!workspaceId) throw new Error("Git credential broker is missing MULTIREMI_WORKSPACE_ID");

  const requestedUrl = gitCredentialInputUrl(input);
  const repositoryUrl = resolveRepositoryIdentity(input, env, options.cwd ?? process.cwd());
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? Number(env.MULTIREMI_GIT_CREDENTIAL_TIMEOUT_MS),
    DEFAULT_GIT_CREDENTIAL_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = String(env.MULTIREMI_TOKEN ?? "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await (options.fetchImpl ?? fetch)(`${serverUrl}${MULTIREMI_GIT_CREDENTIAL_ENDPOINT}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId,
        repositoryUrl,
        protocol,
        host: input.host,
        path: input.path ?? "",
      }),
      signal: controller.signal,
    });
    // No binding/credential is not an authentication failure. Returning no
    // fields lets Git continue to a trusted machine-level helper. This keeps
    // existing HTTPS repositories working while SCM connections are adopted
    // incrementally.
    if ([404, 409, 502, 503, 504].includes(response.status)) return "";
    if (!response.ok) {
      throw new Error(`Git credential broker returned HTTP ${response.status}`);
    }
    const credential = normalizeGitCredentialResponse(await response.json());
    if (!sameGitCredentialTarget(requestedUrl, credential.cloneUrl)) {
      throw new Error("Git credential broker returned a credential for a different repository");
    }
    if (!credential.username || !credential.password) return "";
    const lines = [
      `username=${credential.username}`,
      `password=${credential.password}`,
    ];
    const expiry = credentialExpirySeconds(credential.expiresAt);
    if (expiry !== null) lines.push(`password_expiry_utc=${expiry}`);
    return `${lines.join("\n")}\n`;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Git credential broker timed out after ${timeoutMs}ms`);
    }
    throw new Error(redactGitCredentialError(error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
}

export function parseGitCredentialProtocolInput(value: string): GitCredentialProtocolInput {
  const input: GitCredentialProtocolInput = {};
  for (const line of value.split(/\r?\n/)) {
    if (!line) break;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals) as keyof GitCredentialProtocolInput;
    if (["protocol", "host", "path", "username", "url"].includes(key)) {
      input[key] = line.slice(equals + 1);
    }
  }
  return input;
}

export function redactGitCredentialError(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(authorization|password|token|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
}

export function defaultRemiGitCredentialHelperCommand(
  argv = process.argv,
  execPath = process.execPath,
): string {
  const executable = basename(execPath).toLowerCase();
  if (executable === "bun" || executable === "bun.exe" || executable.startsWith("bun-debug")) {
    const script = argv[1];
    if (script) return `${shellQuote(execPath)} ${shellQuote(script)} git-credential`;
  }
  return `${shellQuote(execPath)} git-credential`;
}

function appendGitConfig(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isSafeInteger(parsed) && parsed >= 0 && parsed < 10_000 ? parsed : 0;
  env.GIT_CONFIG_COUNT = String(index + 1);
  env[`GIT_CONFIG_KEY_${index}`] = key;
  env[`GIT_CONFIG_VALUE_${index}`] = value;
}

function trustedGlobalCredentialHelpers(
  base: NodeJS.ProcessEnv | Record<string, string>,
): string[] {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) delete env[key];
  }
  const result = spawnSync("git", ["config", "--global", "--get-all", "credential.helper"], {
    encoding: "utf8",
    env,
  });
  if (result.status !== 0 && result.status !== 1) return [];
  return String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function isLocalRepositoryUrl(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith("./")
    || value.startsWith("../")
    || value.startsWith("file://")
    || looksLikeWindowsPath(value);
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function gitCredentialInputUrl(input: GitCredentialProtocolInput): string {
  if (input.url) return input.url;
  const path = (input.path ?? "").replace(/^\/+/, "");
  return `${input.protocol}://${input.host}${path ? `/${path}` : ""}`;
}

function resolveRepositoryIdentity(
  input: GitCredentialProtocolInput,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  const explicit = String(env.MULTIREMI_GIT_REPOSITORY_URL ?? "").trim();
  if (explicit) return explicit;
  const requestedUrl = gitCredentialInputUrl(input);
  const configured = parseRepositoryUrlList(env.MULTIREMI_GIT_REPOSITORIES_JSON);
  const match = configured.find((candidate) => sameGitCredentialTarget(requestedUrl, preferredHttpsCloneUrl(candidate)));
  if (match) return match;

  const fromGit = spawnSync("git", ["config", "--get", "multiremi.repository-url"], {
    cwd,
    encoding: "utf8",
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
  });
  const repositoryUrl = String(fromGit.stdout ?? "").trim();
  return repositoryUrl || requestedUrl;
}

function parseRepositoryUrlList(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
  } catch {
    return [];
  }
}

function normalizeGitCredentialResponse(value: unknown): GitCredentialResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Git credential broker returned an invalid response");
  }
  const row = value as Record<string, unknown>;
  const string = (...keys: string[]) => {
    for (const key of keys) {
      if (typeof row[key] === "string") return String(row[key]);
    }
    return "";
  };
  const cloneUrl = string("cloneUrl", "clone_url").trim();
  if (!cloneUrl || !/^https?:\/\//i.test(cloneUrl)) {
    throw new Error("Git credential broker did not return an HTTPS clone URL");
  }
  const username = string("username");
  const password = string("password");
  if (/[\r\n]/u.test(username) || /[\r\n]/u.test(password)) {
    throw new Error("Git credential broker returned an invalid credential field");
  }
  return {
    repositoryId: string("repositoryId", "repository_id").trim(),
    repositoryUrl: string("repositoryUrl", "repository_url").trim(),
    cloneUrl,
    username,
    password,
    expiresAt: string("expiresAt", "expires_at").trim() || null,
  };
}

function sameGitCredentialTarget(left: string, right: string): boolean {
  const normalize = (value: string) => {
    try {
      const parsed = new URL(value);
      const port = parsed.port ? `:${parsed.port}` : "";
      const path = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
      return `${parsed.hostname.toLowerCase()}${port}${path}`;
    } catch {
      return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
    }
  };
  return normalize(left) === normalize(right);
}

function credentialExpirySeconds(value: string | null): number | null {
  if (!value) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return Math.floor(millis / 1000);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
