import { resolveApiRole, isApiRoleConfigured, type ApiRole, type ApiRoleConfiguration } from "./api-role.js";

export type StartupEnvironment = Record<string, string | undefined>;

export interface StartupDegradation {
  id: string;
  status: "disabled";
  effectiveValue: string | null;
  message: string;
}

export interface StartupEffectiveConfig {
  mode: "local" | "production";
  nodeEnv: string;
  databaseUrl: string;
  multiremiToken: string;
  jwtSecret: string;
  daemonDirectBaseUrl: string | null;
  /** MUL-461: the process role this API serves, after env resolution. */
  apiRole: ApiRole;
  apiRoleConfigured: boolean;
}

export interface StartupEnvResult {
  missingRequired: string[];
  degradations: StartupDegradation[];
  effective: StartupEffectiveConfig;
}

export interface ObservableConfigurationItem {
  id: string;
  status: "enabled" | "disabled";
  effectiveValue: string | null;
  detail: string;
}

const PRODUCTION_REQUIRED = [
  "MULTIREMI_DATABASE_URL",
  "MULTIREMI_TOKEN",
  "JWT_SECRET",
] as const;

export const SESSION_ARCHIVE_DEGRADATION_MESSAGE =
  "Session Archive direct upload disabled, falling back to 8 MiB proxy limit";

/**
 * MUL-461: SQLite cannot back a split deployment.
 *
 * The whole point of `ui`/`runtime` is that two processes see the same rows. A
 * file-backed SQLite database gives each process its own file, so a split pair
 * would diverge silently — the browser would write an issue the daemon process
 * never reads. A warning rather than a startup failure: this is also how someone
 * runs the roles locally to reproduce a routing bug, and `all` is unaffected.
 */
export const API_ROLE_SQLITE_DEGRADATION_MESSAGE =
  "MULTIREMI_API_ROLE is set to a split role while SQLite is the store; "
  + "split roles require MULTIREMI_DATABASE_URL so both processes share one database";

/** Sole production role-resolution entry, shared by server startup and standalone apps. */
export function resolveStartupApiRole(env: StartupEnvironment, override?: ApiRole): ApiRoleConfiguration {
  const role = resolveApiRole(env);
  return { role: override ?? role, configured: override !== undefined || isApiRoleConfigured(env) };
}

export function evaluateStartupEnv(env: StartupEnvironment, apiRole?: ApiRoleConfiguration): StartupEnvResult {
  const production = isProductionEnvironment(env);
  const daemonDirectBaseUrl = normalizeDaemonDirectBaseUrl(env.MULTIREMI_DAEMON_DIRECT_BASE_URL);
  const resolvedApiRole = apiRole ?? resolveStartupApiRole(env);
  const missingRequired = production
    ? PRODUCTION_REQUIRED.filter((key) => !clean(env[key]))
    : [];
  const degradations: StartupDegradation[] = daemonDirectBaseUrl
    ? []
    : [{
        id: "session_archive_direct_upload",
        status: "disabled",
        effectiveValue: null,
        message: SESSION_ARCHIVE_DEGRADATION_MESSAGE,
      }];
  if (resolvedApiRole.role !== "all" && !isPostgresDatabaseUrl(env.MULTIREMI_DATABASE_URL)) {
    degradations.push({
      id: "api_role_split_store",
      status: "disabled",
      effectiveValue: resolvedApiRole.role,
      message: API_ROLE_SQLITE_DEGRADATION_MESSAGE,
    });
  }

  return {
    missingRequired,
    degradations,
    effective: {
      mode: production ? "production" : "local",
      nodeEnv: clean(env.NODE_ENV) ?? "unset",
      databaseUrl: redactDatabaseUrl(env.MULTIREMI_DATABASE_URL),
      multiremiToken: redactSecret(env.MULTIREMI_TOKEN),
      jwtSecret: redactSecret(env.JWT_SECRET),
      daemonDirectBaseUrl,
      apiRole: resolvedApiRole.role,
      apiRoleConfigured: resolvedApiRole.configured,
    },
  };
}

/**
 * Mirrors `isPostgresConfigured()` in the store without importing it: this module
 * is pure configuration, and the store module pulls in the SQLite singleton.
 */
function isPostgresDatabaseUrl(value: string | null | undefined): boolean {
  return /^postgres(ql)?:\/\//i.test(clean(value) ?? "");
}

// An explicit development/test NODE_ENV wins over the database heuristic. Picking
// Postgres is a storage choice, not a deployment mode, and `jwtSecret()` still hands
// out DEFAULT_JWT_SECRET for those two values -- treating them as production here
// would refuse to start a local Postgres server that has no JWT_SECRET, even though
// the running code would have accepted the dev default. The heuristic still covers an
// unset NODE_ENV, where `jwtSecret()` returns null and a configured database URL is
// the only signal that this is a real deployment.
export function isProductionEnvironment(env: StartupEnvironment): boolean {
  const nodeEnv = clean(env.NODE_ENV)?.toLowerCase();
  if (nodeEnv === "development" || nodeEnv === "test") return false;
  return nodeEnv === "production" || clean(env.MULTIREMI_DATABASE_URL) !== null;
}

export function redactSecret(value: string | null | undefined): string {
  const configured = clean(value);
  return configured ? `set(length=${configured.length})` : "unset";
}

export function redactDatabaseUrl(value: string | null | undefined): string {
  const raw = clean(value);
  if (!raw) return "unset";
  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//iu);
  if (!schemeMatch) return "invalid";

  const scheme = schemeMatch[1]!.toLowerCase();
  const remainder = raw.slice(schemeMatch[0].length);
  const lastAt = remainder.lastIndexOf("@");
  const authorityAndPath = lastAt >= 0 ? remainder.slice(lastAt + 1) : remainder;
  const credentials = lastAt >= 0 ? remainder.slice(0, lastAt) : "";
  const separatorIndex = credentials.indexOf(":");
  const username = credentials
    ? credentials.slice(0, separatorIndex < 0 ? undefined : separatorIndex)
    : "";

  try {
    const parsed = new URL(`${scheme}://${authorityAndPath}`);
    const user = username ? `${safeDecodeURIComponent(username)}@` : "";
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
    return `${scheme}://${user}${parsed.host}${pathname}`;
  } catch {
    return "invalid";
  }
}

export function normalizeDaemonDirectBaseUrl(value: string | null | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MULTIREMI_DAEMON_DIRECT_BASE_URL must be an absolute http(s) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("MULTIREMI_DAEMON_DIRECT_BASE_URL must be an http(s) origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

export function observableConfiguration(daemonDirectBaseUrl: string | null): ObservableConfigurationItem[] {
  return [{
    id: "session_archive_direct_upload",
    status: daemonDirectBaseUrl ? "enabled" : "disabled",
    effectiveValue: daemonDirectBaseUrl,
    detail: daemonDirectBaseUrl
      ? "Session Archive content uploads use the direct API origin"
      : SESSION_ARCHIVE_DEGRADATION_MESSAGE,
  }];
}

function clean(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
