export interface ResolvedScmRepositoryRemote {
  cloneUrl: string;
  host: string;
  transport: "https" | "ssh";
}

/**
 * Resolve a repository remote only when the connection credential is safe to
 * use for it. HTTPS remotes are origin-bound; SSH remotes are host-bound and
 * converted to the connection's HTTPS origin for daemon credential helpers.
 */
export function resolveScmRepositoryRemote(
  repositoryUrl: string,
  connectionBaseUrl: string,
): ResolvedScmRepositoryRemote {
  const base = parseConnectionBaseUrl(connectionBaseUrl);
  const remote = repositoryUrl.trim();
  if (!remote || /\s/u.test(remote)) throw new Error("SCM repository URL is invalid");

  const scp = remote.includes("://")
    ? null
    : remote.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/u);
  if (scp) {
    const host = normalizeHost(scp[1]!);
    assertSameHost(host, base.hostname);
    return {
      cloneUrl: cloneUrlFromPath(base, scp[2]!),
      host,
      transport: "ssh",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    throw new Error("SCM repository URL is invalid");
  }
  if (!parsed.hostname || parsed.password) throw new Error("SCM repository URL is invalid");

  if (parsed.protocol === "https:") {
    if (parsed.username || parsed.origin !== base.origin) {
      throw new Error("SCM repository HTTPS origin does not match the connection base URL");
    }
    assertRepositoryPath(parsed.pathname);
    parsed.hash = "";
    return {
      cloneUrl: parsed.toString(),
      host: normalizeHost(parsed.hostname),
      transport: "https",
    };
  }

  if (parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:") {
    if (parsed.port && parsed.port !== "22") {
      throw new Error("SCM repository SSH URL must not use a custom port");
    }
    const host = normalizeHost(parsed.hostname);
    assertSameHost(host, base.hostname);
    return {
      cloneUrl: cloneUrlFromPath(base, parsed.pathname),
      host,
      transport: "ssh",
    };
  }

  throw new Error("SCM repository URL must use HTTPS or SSH");
}

export function assertScmRepositoryMatchesConnection(
  repositoryUrl: string,
  connectionBaseUrl: string,
): void {
  resolveScmRepositoryRemote(repositoryUrl, connectionBaseUrl);
}

function parseConnectionBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("SCM connection base URL is invalid");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error("SCM connection base URL must be an HTTPS origin");
  }
  return parsed;
}

function assertSameHost(repositoryHost: string, connectionHost: string): void {
  if (repositoryHost !== normalizeHost(connectionHost)) {
    throw new Error("SCM repository SSH host does not match the connection base URL");
  }
}

function cloneUrlFromPath(base: URL, path: string): string {
  assertRepositoryPath(path);
  return `${base.origin}/${path.replace(/^\/+/, "")}`;
}

function assertRepositoryPath(path: string): void {
  if (!path.replace(/^\/+|\/+$/gu, "")) throw new Error("SCM repository URL is invalid");
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/gu, "");
}
