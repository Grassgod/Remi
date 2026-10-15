/**
 * Antigravity access config (PR 4 §2): Google's official ACP server, pinned
 * per machine, authenticated through its gateway mode and pointed at the
 * daemon's loopback gateway shim. The real gateway key never enters the server
 * process; it sees only the placeholder below.
 *
 * Behaviour notes refer to the pinned server (1.4.0) as observed through its
 * protocol and the live probe; re-check them on every pin bump
 * (docs/daemon-runtime-upgrades.md).
 */

import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ANTIGRAVITY_HARNESS_BINARY, antigravityHealthProblem, resolveAntigravityServer,
} from "../antigravity-install.js";
import type { AcpAccessConfig, AcpAccessEnvInput } from "./types.js";

/** Non-secret placeholder the shim discards; the harness also echoes it as `x-goog-api-key`. */
export const ANTIGRAVITY_PLACEHOLDER_KEY = "remi-shim";
/** Default gateway context window (server 1.4.0 in gateway mode, and the probe). */
export const ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW = 1_048_576;
const LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1"];

/**
 * Variables the server or its harness would read to authenticate, route or
 * trust something other than Remi's shim. `os.environ.get` treats "" as unset,
 * and `AcpClient` merges this overlay over the daemon environment, so an empty
 * value is the only way to keep an inherited one out.
 *
 * Never blanked: `ANTIGRAVITY_HARNESS_PATH` (server 1.4.0 takes the key as
 * set even when empty). `AGY_ACP_DISABLE_WORKSPACE_TRUST` is blanked rather
 * than set (server 1.4.0: set means every workspace is trusted).
 */
export const ANTIGRAVITY_BLANKED_ENV = [
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
  "AGY_GATEWAY_URL", "AGY_GATEWAY_API_KEY", "AGY_GATEWAY_HEADERS",
  "AGY_LLM_GATEWAY_HEADERS", "AGY_LLM_GATEWAY_MODELS", "AGY_LLM_GATEWAY_PROXY_URL", "AGY_LLM_GATEWAY_CA_CERT", "AGY_CA_CERT",
  "AGY_ACP_ENABLE_OAUTH", "AGY_ACP_DISABLE_WORKSPACE_TRUST", "AGY_ACP_BAIC_BASE_URL",
] as const;
const BLANKED_PREFIXES = ["AGY_ACP_CCPA_"];

function loopbackGatewayUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`[antigravity_gateway_unconfigured] invalid shim URL`); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !LOOPBACK_NO_PROXY.includes(host) || url.username || url.password || url.search || url.hash) {
    throw new Error("[antigravity_gateway_unconfigured] the Antigravity gateway URL must be the daemon's loopback shim");
  }
  const base = url.toString().replace(/\/+$/, "");
  // Server 1.4.0 appends `/v1beta/...` itself.
  if (/\/v1(?:beta)?$/.test(base)) throw new Error("[antigravity_gateway_unconfigured] the shim URL must not end in /v1beta");
  return base;
}

function mergeNoProxy(inherited: string | undefined): string {
  const entries = (inherited ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const host of LOOPBACK_NO_PROXY) if (!entries.includes(host)) entries.push(host);
  return entries.join(",");
}

/**
 * The server process environment (§2.1). Proxy variables are inherited from
 * the daemon unchanged; a non-empty `no_proxy` alone already stops CPython on
 * macOS from reading the system SOCKS settings that crashed the probe.
 */
export function buildAntigravityEnv(input: AcpAccessEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ANTIGRAVITY_BLANKED_ENV) env[name] = "";
  for (const name of Object.keys(input.daemonEnv)) {
    if (BLANKED_PREFIXES.some((prefix) => name.startsWith(prefix))) env[name] = "";
  }
  Object.assign(env, {
    GEMINI_HOME: input.home,
    AGY_ACP_ENABLE_GATEWAY_AUTH: "1",
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    BROWSER: "/usr/bin/false",
    AGY_LLM_GATEWAY_URL: loopbackGatewayUrl(input.shimUrl),
    AGY_LLM_GATEWAY_API_KEY: ANTIGRAVITY_PLACEHOLDER_KEY,
  });
  // Only saves one harness rebuild; `session/set_config_option` still selects the model.
  if (input.model) env.AGY_ACP_DEFAULT_MODEL = input.model;
  const noProxy = mergeNoProxy(input.daemonEnv.NO_PROXY ?? input.daemonEnv.no_proxy);
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  if (input.launch) env.ANTIGRAVITY_HARNESS_PATH = join(dirname(input.launch.executable), ANTIGRAVITY_HARNESS_BINARY);
  return env;
}

/**
 * `GEMINI_HOME/antigravity-acp/` files seeded before the first spawn: gateway
 * auth selected by settings, and the task directories marked untrusted so
 * repository hooks stay off and no trust prompt is asked (server 1.4.0).
 */
export function antigravityHomeFiles(input: { cwd: string; workspaceDir?: string | null }): Array<{ path: string; content: string }> {
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  const untrusted = [...new Set([input.cwd, input.workspaceDir].filter((path): path is string => !!path).map(canonical))];
  return [
    { path: join("antigravity-acp", "settings.json"), content: JSON.stringify({ auth: { type: "gateway" } }, null, 2) + "\n" },
    { path: join("antigravity-acp", "trusted_workspaces.json"), content: JSON.stringify({ trusted: [], untrusted }, null, 2) + "\n" },
  ];
}

/** Write the seeded files (mode 0600) under `home`, replacing earlier copies. */
export function seedAntigravityHome(input: { home: string; cwd: string; workspaceDir?: string | null }): void {
  for (const file of antigravityHomeFiles(input)) {
    const target = join(input.home, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, file.content, { mode: 0o600 });
    chmodSync(target, 0o600);
  }
}

/** Remi mode names → the server's `default` / `auto_edit` / `yolo` (server 1.4.0's modes). */
const PERMISSION_MODES: Record<string, string[]> = {
  bypassPermissions: ["yolo"],
  dontAsk: ["yolo"],
  auto: ["yolo"],
  acceptEdits: ["auto_edit"],
  default: ["default"],
  plan: ["default"],
};

export function mapAntigravityPermissionMode(mode: string): string[] {
  return PERMISSION_MODES[mode] ?? [];
}

export const ANTIGRAVITY_ACCESS: AcpAccessConfig = {
  agentType: "antigravity",
  launch: () => resolveAntigravityServer(),
  healthProblem: () => antigravityHealthProblem(),
  retiredExecutables: ["agy", "agy.exe"],
  buildEnv: buildAntigravityEnv,
  defaultPermissionMode: "bypassPermissions",
  strictModel: true,
  modelRequired: true,
  // Server 1.4.0: gateway mode offers no `thought_level` option.
  effort: "none",
  usage: "gateway-shim",
  defaultContextWindow: ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW,
  permissionQuestions: true,
  denyWorkspaceTrust: true,
  serviceMessages: true,
  requiresHome: true,
  // A background shell command keeps a server 1.4.0 turn open, and the server
  // ignores session/cancel meanwhile; a resumed turn can then never end.
  turnStallTimeoutMs: 120_000,
};
