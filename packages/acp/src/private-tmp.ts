import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ProcessLaunch {
  executable: string;
  args: string[];
}

export class PrivateTmpIsolationUnavailableError extends Error {
  readonly code = "private_tmp_isolation_unavailable";

  constructor(message: string) {
    super(`[private_tmp_isolation_unavailable] ${message}`);
    this.name = "PrivateTmpIsolationUnavailableError";
  }
}

const PRIVATE_TMP_SCRIPT = `
set -eu
private_tmp=$1
socket_count=$2
shift 2
mount --make-rprivate /
while [ "$socket_count" -gt 0 ]; do
  source_path=$1
  relative_path=$2
  shift 2
  target_path="$private_tmp/$relative_path"
  mkdir -p "$(dirname "$target_path")"
  : > "$target_path"
  mount --bind "$source_path" "$target_path"
  socket_count=$((socket_count - 1))
done
mount --rbind "$private_tmp" /tmp
mount --make-private /tmp
exec "$@"
`.trim();

/**
 * Put a provider process and all descendants in a mount namespace whose
 * literal /tmp is owned by one task execution. There is deliberately no
 * shared-/tmp fallback: callers receive a stable, observable error instead.
 */
export function isolateProcessTmp(
  launch: ProcessLaunch,
  privateTmpDirectory: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProcessLaunch {
  if (!privateTmpDirectory) return launch;
  if (process.platform !== "linux") {
    throw new PrivateTmpIsolationUnavailableError(`Linux mount namespaces are unavailable on ${process.platform}`);
  }
  const unshare = Bun.which("unshare");
  const shell = Bun.which("sh");
  if (!unshare || !shell || !Bun.which("mount")) {
    throw new PrivateTmpIsolationUnavailableError("unshare, mount, and sh are required");
  }

  let directory: string;
  try {
    directory = realpathSync(privateTmpDirectory);
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a real directory");
  } catch (error) {
    throw new PrivateTmpIsolationUnavailableError(
      `private directory is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const hostTmpRelative = relative(resolve("/tmp"), directory);
  if (!hostTmpRelative || hostTmpRelative === "." || (!hostTmpRelative.startsWith(`..${sep}`) && hostTmpRelative !== "..")) {
    throw new PrivateTmpIsolationUnavailableError("private directory must not live below host /tmp");
  }

  assertNamespaceAvailable(unshare, shell, directory);
  const sockets = environmentTmpSockets(env);
  return {
    executable: unshare,
    args: [
      "--user", "--map-root-user", "--mount", "--fork", "--kill-child",
      shell, "-ceu", PRIVATE_TMP_SCRIPT, "sh", directory, String(sockets.length),
      ...sockets.flatMap(({ source, relativePath }) => [source, relativePath]),
      launch.executable, ...launch.args,
    ],
  };
}

/** Map ACP file-tool requests into the same private /tmp seen by child tools. */
export function mapPrivateTmpPath(path: string, privateTmpDirectory?: string): string {
  if (!privateTmpDirectory || !isAbsolute(path)) return path;
  const normalized = resolve(path);
  const relativePath = relative(resolve("/tmp"), normalized);
  if (relativePath === "") return privateTmpDirectory;
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return path;
  return join(privateTmpDirectory, relativePath);
}

function assertNamespaceAvailable(unshare: string, shell: string, directory: string): void {
  const probe = Bun.spawnSync([
    unshare, "--user", "--map-root-user", "--mount", "--fork", "--kill-child",
    shell, "-ceu", 'mount --make-rprivate / && mount --bind "$1" /tmp && test -d /tmp', "sh", directory,
  ], { stdout: "ignore", stderr: "pipe" });
  if (probe.exitCode !== 0) {
    const detail = new TextDecoder().decode(probe.stderr).trim();
    throw new PrivateTmpIsolationUnavailableError(
      `runtime cannot create a private /tmp mount${detail ? `: ${detail}` : ""}`,
    );
  }
}

function environmentTmpSockets(env: NodeJS.ProcessEnv): Array<{ source: string; relativePath: string }> {
  const sockets = new Map<string, { source: string; relativePath: string }>();
  for (const value of Object.values(env)) {
    if (!value || !isAbsolute(value)) continue;
    const normalized = resolve(value);
    const relativePath = relative(resolve("/tmp"), normalized);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) continue;
    try {
      if (statSync(normalized).isSocket()) sockets.set(normalized, { source: normalized, relativePath });
    } catch {
      // Environment values are not required to name files. Missing paths are
      // left untouched rather than turning unrelated variables into failures.
    }
  }
  return [...sockets.values()];
}
