/**
 * Multiremi CLI — supported runtime providers and daemon health probing.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { AcpProvider } from "@acp/index.js";

export const SUPPORTED_DAEMON_PROVIDERS = ["claude", "codex"] as const;

export type SupportedDaemonProvider = typeof SUPPORTED_DAEMON_PROVIDERS[number];

export interface MultiremiDaemonHealth {
  status?: string;
  mode?: "starting" | "serving" | "cleanup_only";
  ssh_mesh_cleanup_attempts?: number;
  pid?: number;
  uptime?: string;
  runtime_id?: string | null;
  runtime_name?: string;
  provider?: string;
  workspace_id?: string | null;
  server_url?: string;
  cli_version?: string;
  /** True only after every provider managed by this process is ready. */
  supervisor_ready?: boolean;
  active_task_count?: number;
  daemon_port?: number;
  workspace_cleanup_capability?: "available" | "blocked";
  workspace_cleanup_error?: string | null;
  error?: string;
}

export function managedDaemonPorts(basePort: number): number[] {
  if (basePort === 0) return [0];
  return SUPPORTED_DAEMON_PROVIDERS.map((_, index) => basePort + index);
}

export async function checkManagedDaemonHealth(basePort: number): Promise<Array<{ port: number; health: MultiremiDaemonHealth }>> {
  const entries = await Promise.all(managedDaemonPorts(basePort).map(async (port) => ({
    port,
    health: await checkDaemonHealth(port),
  })));
  return entries;
}

export interface WaitForDaemonReadyOptions {
  expectedPid?: number;
  requireSupervisorReady?: boolean;
}

export async function waitForDaemonReady(
  port: number,
  timeoutMs: number,
  options: WaitForDaemonReadyOptions = {},
): Promise<MultiremiDaemonHealth> {
  const deadline = Date.now() + timeoutMs;
  let last: MultiremiDaemonHealth = { status: "stopped" };
  while (Date.now() < deadline) {
    last = await checkDaemonHealth(port);
    if (daemonSupervisorReady(last, options)) return last;
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  return last;
}

export function daemonSupervisorReady(
  health: MultiremiDaemonHealth,
  options: WaitForDaemonReadyOptions = {},
): boolean {
  if (health.status !== "running") return false;
  if (options.expectedPid !== undefined && health.pid !== options.expectedPid) return false;
  return options.requireSupervisorReady
    ? health.supervisor_ready === true
    : health.supervisor_ready !== false;
}

export async function checkDaemonHealth(port: number): Promise<MultiremiDaemonHealth> {
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/health`, { method: "GET" }, 2_000);
    if (!response.ok) return { status: "stopped", error: `health returned ${response.status}` };
    return await response.json() as MultiremiDaemonHealth;
  } catch (err) {
    return { status: "stopped", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function requestDaemonShutdown(port: number): Promise<void> {
  const response = await fetchWithTimeout(`http://127.0.0.1:${port}/shutdown`, { method: "POST" }, 2_000);
  if (!response.ok) throw new Error(`shutdown returned ${response.status}`);
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function daemonAlive(health: MultiremiDaemonHealth): boolean {
  return health.status === "running" || health.status === "starting";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function detectMultiremiProviders(options: {
  pathEnv?: string;
  pathExt?: string;
  canExecute?: (path: string) => boolean;
} = {}): SupportedDaemonProvider[] {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const canExecute = options.canExecute ?? isExecutable;
  const paths = pathEnv.split(delimiter).filter(Boolean);
  const extensions = executableExtensions(options.pathExt);
  return SUPPORTED_DAEMON_PROVIDERS.filter((provider) => {
    const commands = provider === "claude"
      ? ["remi-claude-agent-acp", "claude-agent-acp", "claude"]
      : ["codex-acp", "codex"];
    return paths.some((dir) => commands.some((command) => {
      return extensions.some((extension) => canExecute(join(dir, `${command}${extension}`)));
    }));
  });
}

export async function resolveHealthyDaemonProviders(explicitProvider: SupportedDaemonProvider | null): Promise<SupportedDaemonProvider[]> {
  const candidates = explicitProvider ? [explicitProvider] : detectMultiremiProviders();
  const healthy: SupportedDaemonProvider[] = [];
  for (const provider of candidates) {
    const checker = new AcpProvider({ agentType: provider });
    try {
      if (await checker.healthCheck()) {
        healthy.push(provider);
      } else if (explicitProvider) {
        throw new Error(`Multiremi provider ${provider} failed ACP health check`);
      }
    } finally {
      await checker.close?.();
    }
  }
  return healthy;
}

export function isSupportedDaemonProvider(provider: string): provider is SupportedDaemonProvider {
  return (SUPPORTED_DAEMON_PROVIDERS as readonly string[]).includes(provider);
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function executableExtensions(pathExt?: string): string[] {
  if (process.platform !== "win32") return [""];
  const extensions = (pathExt ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return ["", ...extensions];
}
