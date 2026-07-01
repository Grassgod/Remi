/**
 * ACP bridge provisioning.
 *
 * Users should only need the agents they actually use — `claude` and `codex`.
 * The ACP bridges (`claude-agent-acp`, `codex-acp`) that the daemon spawns are
 * an implementation detail, so `remi` provisions them itself: for each provider
 * whose CLI is present but whose bridge is missing, npm-install the bridge into
 * `~/.remi/acp`. If `node` is missing, download an official build into
 * `~/.remi/node` first. Everything degrades gracefully — a provider whose bridge
 * can't be provisioned simply won't register; nothing crashes.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProvisionProvider = "claude" | "codex";
type Logger = (message: string) => void;

const NODE_VERSION = "v22.14.0"; // pinned LTS for the bundled fallback

const PROVIDER_CLI: Record<ProvisionProvider, string> = { claude: "claude", codex: "codex" };
// First entry is the package we install; both are checked when locating an
// already-installed bridge. @zed-industries/claude-agent-acp is deprecated
// (stuck at 0.23.1, renamed) — prefer the maintained @agentclientprotocol one.
const PROVIDER_PACKAGES: Record<ProvisionProvider, string[]> = {
  claude: ["@agentclientprotocol/claude-agent-acp", "@zed-industries/claude-agent-acp"],
  codex: ["@agentclientprotocol/codex-acp"],
};
const PROVIDER_BIN: Record<ProvisionProvider, string> = { claude: "claude-agent-acp", codex: "codex-acp" };

function remiHome(): string {
  return process.env.REMI_HOME ?? join(homedir(), ".remi");
}
function acpPrefix(): string {
  return join(remiHome(), "acp");
}
function remiBin(): string {
  return join(remiHome(), "bin");
}
function nodeDir(): string {
  return join(remiHome(), "node");
}

function which(cmd: string): string | null {
  try {
    return (Bun.which(cmd) as string | null) ?? null;
  } catch {
    return null;
  }
}

/** Directory of an installed bridge package (with package.json), or null. */
export function locateBridgePackage(provider: ProvisionProvider): string | null {
  const roots = [
    join(acpPrefix(), "node_modules"),
    join(homedir(), ".npm-global", "lib", "node_modules"),
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
  ];
  for (const pkg of PROVIDER_PACKAGES[provider]) {
    for (const root of roots) {
      const dir = join(root, ...pkg.split("/"));
      if (existsSync(join(dir, "package.json"))) return dir;
    }
  }
  return null;
}

/** Is the bridge already usable on this machine (npm package or a PATH binary)? */
function bridgePresent(provider: ProvisionProvider): boolean {
  if (locateBridgePackage(provider)) return true;
  // A standalone bridge binary on PATH counts too (e.g. homebrew's Rust codex-acp).
  if (which(PROVIDER_BIN[provider])) return true;
  if (existsSync(join(remiBin(), PROVIDER_BIN[provider]))) return true;
  return false;
}

/** Read the version of the provisioned/located bridge package, or null. */
export function bridgeVersion(provider: ProvisionProvider): string | null {
  const dir = locateBridgePackage(provider);
  if (dir) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {}
  }
  // Best-effort for standalone binaries (e.g. Rust codex-acp): try --version.
  const bin = which(PROVIDER_BIN[provider]) ?? (existsSync(join(remiBin(), PROVIDER_BIN[provider])) ? join(remiBin(), PROVIDER_BIN[provider]) : null);
  if (bin) {
    try {
      const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/\d+\.\d+\.\d+[\w.-]*/);
      if (m) return m[0];
    } catch {}
  }
  return null;
}

/** Version of the underlying agent CLI itself (`claude` / `codex`), or null. */
export function agentCliVersion(provider: ProvisionProvider): string | null {
  const cli = which(PROVIDER_CLI[provider]);
  if (!cli) return null;
  try {
    const out = execFileSync(cli, ["--version"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/\d+\.\d+\.\d+[\w.-]*/);
    if (m) return m[0];
  } catch {}
  return null;
}

/** Resolve `node` + `npm`, downloading an official build into ~/.remi/node if absent. */
function ensureNode(log: Logger): { node: string; npm: string } | null {
  const sysNode = which("node");
  const sysNpm = which("npm");
  if (sysNode && sysNpm) return { node: sysNode, npm: sysNpm };

  const localNode = join(nodeDir(), "bin", "node");
  const localNpm = join(nodeDir(), "bin", "npm");
  if (existsSync(localNode) && existsSync(localNpm)) return { node: localNode, npm: localNpm };

  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const base = `node-${NODE_VERSION}-${os}-${arch}`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${base}.tar.gz`;
  log(`node not found — downloading ${base} from nodejs.org`);
  const tmpTar = join(remiHome(), `.node-download-${process.pid}.tar.gz`);
  try {
    mkdirSync(remiHome(), { recursive: true });
    const res = execFileSync("curl", ["-fsSL", "-o", tmpTar, url], { timeout: 120000, stdio: ["ignore", "ignore", "pipe"] });
    void res;
    const extractRoot = join(remiHome(), `.node-extract-${process.pid}`);
    rmSync(extractRoot, { recursive: true, force: true });
    mkdirSync(extractRoot, { recursive: true });
    execFileSync("tar", ["-xzf", tmpTar, "-C", extractRoot], { timeout: 120000, stdio: ["ignore", "ignore", "pipe"] });
    const inner = join(extractRoot, base);
    rmSync(nodeDir(), { recursive: true, force: true });
    renameSync(inner, nodeDir());
    rmSync(extractRoot, { recursive: true, force: true });
    rmSync(tmpTar, { force: true });
    if (existsSync(localNode) && existsSync(localNpm)) {
      log(`installed node ${NODE_VERSION} → ${nodeDir()}`);
      return { node: localNode, npm: localNpm };
    }
  } catch (err) {
    rmSync(tmpTar, { force: true });
    log(`node download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function npmInstall(npm: string, node: string, pkg: string, log: Logger): boolean {
  const prefix = acpPrefix();
  mkdirSync(prefix, { recursive: true });
  try {
    execFileSync(npm, ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", pkg], {
      timeout: 180000,
      stdio: ["ignore", "ignore", "pipe"],
      // Make sure npm's own node lookup uses our node when it's the bundled one.
      env: { ...process.env, PATH: `${join(nodeDir(), "bin")}:${process.env.PATH ?? ""}` },
    });
    return true;
  } catch (err) {
    log(`npm install ${pkg} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Symlink the codex-acp bin into ~/.remi/bin (a path the resolver already checks). */
function linkCodexBin(log: Logger): void {
  const dir = locateBridgePackage("codex");
  if (!dir) return;
  const src = join(acpPrefix(), "node_modules", ".bin", "codex-acp");
  if (!existsSync(src)) return;
  const dst = join(remiBin(), "codex-acp");
  try {
    mkdirSync(remiBin(), { recursive: true });
    if (existsSync(dst)) unlinkSync(dst);
    symlinkSync(src, dst);
    chmodSync(src, 0o755);
  } catch (err) {
    log(`codex-acp link failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Ensure the ACP bridges for `providers` are present, installing the missing
 * ones. Also prepends ~/.remi/node/bin (if bundled) + ~/.remi/bin onto this
 * process's PATH so spawned bridges (node scripts) resolve. Best-effort.
 */
export function ensureAcpBridges(providers: ProvisionProvider[], log: Logger = (m) => console.error(`[provision] ${m}`)): void {
  // Always put our managed dirs on PATH so already-provisioned bridges + node
  // are visible to child processes (the daemon spawns the bridges), and point
  // the claude wrapper directly at the located package via env — this is
  // resolution-proof: it works even when a stale remi-claude-agent-acp on PATH
  // would otherwise be picked and fail to find the package.
  prependManagedPath();
  pointClaudeBridgeDir();

  const missing = providers.filter((p) => which(PROVIDER_CLI[p]) && !bridgePresent(p));
  if (missing.length === 0) return;

  const node = ensureNode(log);
  if (!node) {
    log(`cannot provision bridges (${missing.join(", ")}): node unavailable`);
    return;
  }
  for (const provider of missing) {
    const pkg = PROVIDER_PACKAGES[provider][0];
    log(`installing ${provider} ACP bridge (${pkg}) into ${acpPrefix()}`);
    if (npmInstall(node.npm, node.node, pkg, log)) {
      if (provider === "codex") linkCodexBin(log);
      log(`${provider} ACP bridge ready`);
    }
  }
  prependManagedPath();
  pointClaudeBridgeDir();
}

/**
 * Force-reinstall the ACP bridge for `provider` to the latest published version
 * (ignores whether one is already present), re-link/re-point, and return the
 * new bridge version. Throws on failure. Services a remote "update ACP bridge"
 * request from the dashboard.
 */
export function reinstallBridge(provider: ProvisionProvider, log: Logger = (m) => console.error(`[provision] ${m}`)): string {
  const node = ensureNode(log);
  if (!node) throw new Error("cannot reinstall ACP bridge: node unavailable");
  const pkg = `${PROVIDER_PACKAGES[provider][0]}@latest`;
  log(`reinstalling ${provider} ACP bridge (${pkg}) into ${acpPrefix()}`);
  if (!npmInstall(node.npm, node.node, pkg, log)) {
    throw new Error(`npm install ${pkg} failed`);
  }
  if (provider === "codex") linkCodexBin(log);
  prependManagedPath();
  // Re-point the claude wrapper unconditionally — the located package dir may
  // have changed (e.g. @zed-industries → @agentclientprotocol).
  if (provider === "claude") {
    const dir = locateBridgePackage("claude");
    if (dir) process.env.REMI_CLAUDE_AGENT_ACP_DIR = dir;
  }
  const version = bridgeVersion(provider);
  log(`${provider} ACP bridge ready${version ? ` (${version})` : ""}`);
  return version ?? "latest";
}

/** Point the claude wrapper at the located package via REMI_CLAUDE_AGENT_ACP_DIR. */
function pointClaudeBridgeDir(): void {
  if (process.env.REMI_CLAUDE_AGENT_ACP_DIR) return;
  const dir = locateBridgePackage("claude");
  if (dir) process.env.REMI_CLAUDE_AGENT_ACP_DIR = dir;
}

function prependManagedPath(): void {
  const parts = [join(nodeDir(), "bin"), remiBin()].filter((d) => existsSync(d));
  if (parts.length === 0) return;
  const current = process.env.PATH ?? "";
  const have = new Set(current.split(":"));
  const add = parts.filter((d) => !have.has(d));
  if (add.length) process.env.PATH = `${add.join(":")}:${current}`;
}
