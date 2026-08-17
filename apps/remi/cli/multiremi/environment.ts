import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const NPM_PREFIX_TIMEOUT_MS = 2_000;

export interface PrepareDaemonEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  resolveNpmPrefix?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
}

/**
 * Give every daemon launch mode the same deterministic command search path.
 * Include user-level bin directories even before they exist so tools installed
 * later by an Agent Plugin are immediately visible to subsequent hooks.
 */
export async function prepareDaemonEnvironment(
  options: PrepareDaemonEnvironmentOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const remiHome = absoluteEnvPath(env.REMI_HOME, homeDir) ?? join(homeDir, ".remi");
  const configuredNpmPrefix = absoluteEnvPath(env.NPM_CONFIG_PREFIX, homeDir);
  const npmPrefix = configuredNpmPrefix
    ?? await (options.resolveNpmPrefix ?? resolveNpmGlobalPrefix)(env);

  const managedPaths = [
    join(remiHome, "bin"),
    join(remiHome, "node", "bin"),
    npmPrefix ? npmBinDir(npmPrefix, platform) : null,
    join(homeDir, ".npm-global", "bin"),
    join(homeDir, ".local", "bin"),
  ];
  const currentPaths = String(env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== ".");
  const paths = [...new Set([...managedPaths.filter((entry): entry is string => Boolean(entry)), ...currentPaths])];
  env.PATH = paths.join(delimiter);
  return env.PATH;
}

export async function resolveNpmGlobalPrefix(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const npm = Bun.which("npm", { PATH: env.PATH });
  if (!npm) return null;

  const proc = Bun.spawn([npm, "config", "get", "prefix"], {
    env: processEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve(-1);
    }, NPM_PREFIX_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const [exitCode, stdout] = await Promise.all([
      Promise.race([proc.exited, timedOut]),
      new Response(proc.stdout).text(),
    ]);
    if (exitCode !== 0) return null;
    return absoluteEnvPath(stdout.trim(), homedir());
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function absoluteEnvPath(value: string | undefined, homeDir: string): string | null {
  const path = String(value ?? "").trim();
  if (!path) return null;
  const expanded = path === "~" ? homeDir : path.startsWith("~/") ? join(homeDir, path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : null;
}

function npmBinDir(prefix: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? prefix : join(prefix, "bin");
}

function processEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
