import { closeSync, copyFileSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { createLogger } from "@shared/logger.js";

const log = createLogger("relay-sync");

export interface RelayEngineWire {
  fragment: string;
  auth_token: string;
  revision: number;
}
export interface RelayWire {
  claude: RelayEngineWire | null;
  codex: RelayEngineWire | null;
  model_discovery?: boolean;
}

export interface RelayPaths {
  claudeSettings: string;
  codexConfig: string;
  codexAuth: string;
  stateFile: string;
}

export function defaultRelayPaths(home = homedir()): RelayPaths {
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  return {
    claudeSettings: join(home, ".claude", "settings.json"),
    codexConfig: join(codexHome, "config.toml"),
    codexAuth: join(codexHome, "auth.json"),
    stateFile: join(home, ".multiremi", "relay-state.json"),
  };
}

// ── managed state (revision + content hash we last applied per engine) ──

interface RelayEngineState {
  revision: number;
}
interface RelayState {
  workspace?: string;
  claude?: RelayEngineState;
  codex?: RelayEngineState;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readState(path: string): RelayState {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    // A `null`/array/garbage state must not crash the daemon — treat as empty.
    return isPlainObject(parsed) ? (parsed as RelayState) : {};
  } catch {
    return {};
  }
}


// ── pure merge helpers (exported for tests) ────────────────────────

/** Recursive object merge: patch keys override, everything else preserved. Arrays/scalars replace. */
export function deepMerge<T extends Record<string, unknown>>(target: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Merge the claude fragment + token into an existing settings.json object. */
export function mergeClaudeSettings(current: Record<string, unknown>, fragment: string, token: string): Record<string, unknown> {
  let patch: Record<string, unknown> = {};
  if (fragment.trim()) {
    // Parse errors can echo the source line — throw a sanitized message.
    try { patch = JSON.parse(fragment) as Record<string, unknown>; }
    catch { throw new Error("claude fragment is not valid JSON"); }
  }
  if (!isPlainObject(patch)) throw new Error("claude fragment is not an object");
  const merged = deepMerge(current, patch);
  const env = isPlainObject(merged.env) ? { ...(merged.env as Record<string, unknown>) } : {};
  if (token) env.ANTHROPIC_AUTH_TOKEN = token;
  else delete env.ANTHROPIC_AUTH_TOKEN;
  // A gateway AUTH_TOKEN and an API_KEY are mutually exclusive; the key would bypass the gateway.
  delete env.ANTHROPIC_API_KEY;
  merged.env = env;
  // Fail closed: the base_url must come from THIS fragment, not from a stale value
  // already on the machine — otherwise a token-only wire update would pair the new
  // token with the old local gateway.
  if (token) {
    const patchBase = isPlainObject(patch.env) ? (patch.env as Record<string, unknown>).ANTHROPIC_BASE_URL : undefined;
    if (typeof patchBase !== "string" || !patchBase.trim()) {
      throw new Error("refusing to write claude token without a gateway base_url in this fragment");
    }
  }
  return merged;
}

/** Merge the codex fragment into an existing config.toml text, cleaning inline secrets. */
export function mergeCodexConfig(currentToml: string, fragment: string): string {
  // A corrupt existing config.toml may carry a bearer token on the failing line;
  // smol-toml puts that line in its error, so never surface the raw parse error.
  let current: Record<string, unknown> = {};
  if (currentToml.trim()) {
    try { current = parseToml(currentToml) as Record<string, unknown>; }
    catch { throw new Error("existing config.toml is not valid TOML"); }
  }
  let patch: Record<string, unknown> = {};
  if (fragment.trim()) {
    try { patch = parseToml(fragment) as Record<string, unknown>; }
    catch { throw new Error("codex fragment is not valid TOML"); }
  }
  const merged = deepMerge(current, patch);
  // Inline secrets (dev-only bearer / env_key) must not linger next to the auth.json key path.
  const providers = merged.model_providers;
  const patchProviders = isPlainObject(patch.model_providers) ? (patch.model_providers as Record<string, unknown>) : {};
  if (isPlainObject(providers)) {
    for (const id of Object.keys(patchProviders)) {
      const table = providers[id];
      if (isPlainObject(table)) {
        delete (table as Record<string, unknown>).experimental_bearer_token;
        delete (table as Record<string, unknown>).env_key;
      }
    }
  }
  return stringifyToml(merged);
}

export function buildCodexAuth(token: string): Record<string, unknown> {
  // Relay's recommended shape is a static API key; the daemon owns this file entirely.
  return token ? { OPENAI_API_KEY: token } : {};
}

// ── safe file reads / atomic writes ────────────────────────────────

/** Fail-closed: an unreadable/malformed existing file must NOT be silently replaced. */
function readJsonFileStrict(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  // settings.json holds the AUTH_TOKEN, so a JSON.parse error must not echo its
  // contents into logs — throw a sanitized message instead.
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${basename(path)} is not valid JSON`); }
  if (!isPlainObject(parsed)) throw new Error(`${basename(path)} is not a JSON object`);
  return parsed;
}

interface TargetStat { mtimeMs: number; size: number }
function statTarget(path: string): TargetStat | null {
  if (!existsSync(path)) return null;
  const s = lstatSync(path);
  if (s.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${path}`);
  return { mtimeMs: s.mtimeMs, size: s.size };
}

/**
 * Atomic write with backup, symlink refusal, and lost-update detection.
 * `expected` is the target's stat captured before we read it — if the file
 * changed in between (user / another process wrote it), we abort rather than
 * clobber their change.
 */
function atomicWrite(path: string, content: string, expected: TargetStat | null): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const exists = existsSync(path);
  if (exists) {
    const s = lstatSync(path);
    if (s.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${path}`);
    if (!expected || s.mtimeMs !== expected.mtimeMs || s.size !== expected.size) {
      throw new Error(`${basename(path)} changed since read; skipping to avoid clobbering`);
    }
    const versionsDir = join(dir, ".versions");
    mkdirSync(versionsDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = join(versionsDir, `${basename(path)}.${stamp}`);
    copyFileSync(path, backup);
    try { const bf = openSync(backup, "r+"); fchmodSync(bf, 0o600); closeSync(bf); } catch { /* best-effort */ }
    pruneVersions(versionsDir, basename(path), 5);
  } else if (expected) {
    throw new Error(`${basename(path)} appeared since read; skipping`);
  }
  // O_EXCL random tmp: never follow an attacker-planted symlink or reuse a stale tmp.
  const tmp = `${path}.multiremi.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

function pruneVersions(dir: string, prefix: string, keep: number): void {
  try {
    const files = readdirSync(dir).filter((f) => f.startsWith(`${prefix}.`)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f), { force: true });
  } catch { /* best-effort */ }
}

// ── orchestration ──────────────────────────────────────────────────

function syncClaude(engine: RelayEngineWire, paths: RelayPaths): void {
  const before = statTarget(paths.claudeSettings);
  const current = readJsonFileStrict(paths.claudeSettings);
  const merged = mergeClaudeSettings(current, engine.fragment, engine.auth_token);
  atomicWrite(paths.claudeSettings, `${JSON.stringify(merged, null, 2)}\n`, before);
}

/** Resolve the active provider's base_url from a merged config.toml (the model_provider target). */
function activeProviderBaseUrl(configToml: string): string | null {
  try {
    const parsed = parseToml(configToml) as { model_provider?: string; model_providers?: Record<string, { base_url?: unknown }> };
    const id = parsed.model_provider ?? Object.keys(parsed.model_providers ?? {})[0];
    const base = id ? parsed.model_providers?.[id]?.base_url : undefined;
    return typeof base === "string" ? base : null;
  } catch {
    return null;
  }
}

/** Codex needs config.toml (routing) + auth.json (key) applied atomically together. */
function syncCodex(engine: RelayEngineWire, paths: RelayPaths): void {
  const cfgBefore = statTarget(paths.codexConfig);
  const authBefore = statTarget(paths.codexAuth);
  const prevConfig = existsSync(paths.codexConfig) ? readFileSync(paths.codexConfig, "utf8") : null;
  const newConfig = mergeCodexConfig(prevConfig ?? "", engine.fragment);
  const newAuth = `${JSON.stringify(buildCodexAuth(engine.auth_token), null, 2)}\n`;

  // Fail closed: the active-provider base_url must come from THIS fragment (not the
  // merged-in stale local config), so a token-only update can't reuse the old gateway.
  if (engine.auth_token && !activeProviderBaseUrl(engine.fragment)) {
    throw new Error("refusing to write codex token without an active-provider base_url in this fragment");
  }

  atomicWrite(paths.codexConfig, newConfig, cfgBefore);
  try {
    atomicWrite(paths.codexAuth, newAuth, authBefore);
  } catch (err) {
    // Roll config back so we never leave a half-applied "new gateway + old/no key" state.
    if (prevConfig !== null) {
      try { atomicWrite(paths.codexConfig, prevConfig, statTarget(paths.codexConfig)); } catch { /* best-effort */ }
    } else {
      // config.toml did not exist before this run — undo the fresh file entirely.
      try { rmSync(paths.codexConfig, { force: true }); } catch { /* best-effort */ }
    }
    throw err;
  }
}

/**
 * Deep-merge the fleet relay config into this machine's CLI files. Applies an engine
 * only when its revision strictly advances (monotonic — a stale, late-arriving
 * response can never roll a newer config back). Best-effort per engine: a failure
 * is logged (sanitized, no secrets), not thrown.
 */
export function syncRelayConfigs(relay: RelayWire | undefined, workspaceId: string, pathsOverride?: Partial<RelayPaths>): void {
  if (!relay) return;
  const paths = { ...defaultRelayPaths(), ...pathsOverride };
  let state = readState(paths.stateFile);
  // A different workspace's daemon on the same OS user must not inherit this
  // workspace's applied revisions (the files/state are global to the user).
  if (state.workspace && state.workspace !== workspaceId) state = { workspace: workspaceId };
  else state.workspace = workspaceId;
  let changed = false;

  for (const engineName of ["claude", "codex"] as const) {
    const config = relay[engineName];
    if (!config) continue;
    const applied = state[engineName];
    if (applied && config.revision <= applied.revision) continue;
    try {
      if (engineName === "claude") syncClaude(config, paths);
      else syncCodex(config, paths);
      state[engineName] = { revision: config.revision };
      changed = true;
      log.info(`relay ${engineName} config applied (revision ${config.revision})`);
    } catch (err) {
      // Error messages from a corrupt local file can echo a token-bearing source
      // line, so the merge/read helpers throw sanitized messages; still, keep it terse.
      log.warn(`relay ${engineName} sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (changed) {
    try {
      mkdirSync(dirname(paths.stateFile), { recursive: true, mode: 0o700 });
      atomicWrite(paths.stateFile, JSON.stringify(state, null, 2), statTarget(paths.stateFile));
    } catch (err) {
      // Loud: files were applied but the applied-revision record didn't persist. The
      // next heartbeat re-applies the SAME content (idempotent) — but surface it.
      log.error(`relay state write failed (applied files not recorded): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
