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
mount_count=$2
shift 2
mount --make-rprivate /
while [ "$mount_count" -gt 0 ]; do
  source_path=$1
  relative_path=$2
  source_kind=$3
  shift 3
  target_path="$private_tmp/$relative_path"
  if [ "$source_kind" = directory ]; then
    mkdir -p "$target_path"
  else
    mkdir -p "$(dirname "$target_path")"
    : > "$target_path"
  fi
  mount --bind "$source_path" "$target_path"
  mount_count=$((mount_count - 1))
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
  assertNamespaceAvailable(unshare, shell, directory);
  const environmentMounts = environmentTmpMounts(env);
  return {
    executable: unshare,
    args: [
      "--user", "--map-root-user", "--mount", "--fork", "--kill-child",
      shell, "-ceu", PRIVATE_TMP_SCRIPT, "sh", directory, String(environmentMounts.length),
      ...environmentMounts.flatMap(({ source, relativePath, kind }) => [source, relativePath, kind]),
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

/** Translate a host backing path into the path visible inside task /tmp. */
export function privateTmpVisiblePath(path: string, privateTmpDirectory?: string): string {
  if (!privateTmpDirectory) return path;
  const relativePath = relative(resolve(privateTmpDirectory), resolve(path));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new PrivateTmpIsolationUnavailableError("task temporary path escapes its private directory");
  }
  return relativePath ? join("/tmp", relativePath) : "/tmp";
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

function environmentTmpMounts(
  env: NodeJS.ProcessEnv,
): Array<{ source: string; relativePath: string; kind: "directory" | "file" }> {
  const mounts = new Map<string, { source: string; relativePath: string; kind: "directory" | "file" }>();
  for (const value of Object.values(env)) {
    if (!value || !isAbsolute(value)) continue;
    const normalized = resolve(value);
    const relativePath = relative(resolve("/tmp"), normalized);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) continue;
    try {
      const info = statSync(normalized);
      mounts.set(normalized, {
        source: normalized,
        relativePath,
        kind: info.isDirectory() ? "directory" : "file",
      });
    } catch {
      // Environment values are not required to name files. Missing paths are
      // left untouched rather than turning unrelated variables into failures.
    }
  }
  return [...mounts.values()];
}
