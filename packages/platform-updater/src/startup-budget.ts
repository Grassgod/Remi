export const DEFAULT_USAGE_MIGRATION_TIMEOUT_MS = 300_000;
export const STARTUP_MARGIN_MS = 60_000;

const GUIDE = "deploy/README.md#usage-accounting-startup-cutover";
const MIGRATION_ENV = "MULTIREMI_USAGE_MIGRATION_TIMEOUT_MS";
const HEALTH_ENV = "MULTIREMI_PLATFORM_HEALTH_TIMEOUT_MS";
const DURATION_UNITS: Record<string, number> = {
  h: 3_600_000, m: 60_000, s: 1_000, ms: 1, us: 0.001,
  "\u00b5s": 0.001, "\u03bcs": 0.001, ns: 0.000001,
};

/** Nonnegative Go durations as emitted by Compose, including compound units. */
export function parseComposeDurationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (value === "0") return 0;
  const source = value.startsWith("+") ? value.slice(1) : value;
  const part = /^(\d+(?:\.\d*)?|\.\d+)(ns|us|\u00b5s|\u03bcs|ms|s|m|h)/;
  let remaining = source;
  let total = 0;
  if (!remaining) return null;
  while (remaining) {
    const match = remaining.match(part);
    if (!match) return null;
    total += Number(match[1]) * DURATION_UNITS[match[2]!]!;
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) return null;
    remaining = remaining.slice(match[0].length);
  }
  return total;
}

interface StartupBudgetOptions {
  coreServices: readonly string[];
  healthTimeoutMs: number;
  composeFile: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Read only the migration budget: rendered environment also contains secrets. */
export function validateComposeStartupBudgets(config: unknown, options: StartupBudgetOptions): void {
  const services = record(record(config)?.services);
  if (!services) {
    throw new Error(`Compose startup budget validation requires a services object. Fix ${options.composeFile}; see ${GUIDE}.`);
  }
  const violations: string[] = [];
  for (const name of ["api", "api-runtime"]) {
    if (!options.coreServices.includes(name) || !Object.hasOwn(services, name)) continue;
    const service = record(services[name]);
    if (!service) {
      violations.push(`${name}: invalid service configuration; fix ${options.composeFile}.`);
      continue;
    }
    const rawBudget = record(service.environment)?.[MIGRATION_ENV];
    const budget = rawBudget === undefined ? DEFAULT_USAGE_MIGRATION_TIMEOUT_MS
      : typeof rawBudget === "string" || typeof rawBudget === "number" ? Number(rawBudget) : NaN;
    const validBudget = Number.isSafeInteger(budget) && budget > 0;
    const required = budget + STARTUP_MARGIN_MS;
    if (!validBudget) {
      violations.push(`${name}: ${MIGRATION_ENV} is invalid; require a positive safe integer in ms. Fix ${options.composeFile} environment or its API env_file.`);
    } else if (!Number.isSafeInteger(required)) {
      violations.push(`${name}: required startup budget ${budget}ms + ${STARTUP_MARGIN_MS}ms margin exceeds the safe integer range. Lower ${MIGRATION_ENV} in ${options.composeFile} environment or its API env_file.`);
    } else if (options.healthTimeoutMs < required) {
      violations.push(`${name}: updater ${HEALTH_ENV}=${options.healthTimeoutMs}ms must be >= ${required}ms (${MIGRATION_ENV}=${budget}ms + ${STARTUP_MARGIN_MS}ms startup margin). Fix the host updater.env.`);
    }

    const health = record(service.healthcheck);
    if (!health || health.disable === true || health.test === "NONE"
      || (Array.isArray(health.test) && health.test[0] === "NONE")) continue;
    const startPeriod = health.start_period === undefined ? 0 : parseComposeDurationMs(health.start_period);
    if (startPeriod === null) {
      violations.push(`${name}: healthcheck.start_period is invalid; require a nonnegative Go duration (for example 360s or 6m0s). Fix ${options.composeFile}.`);
      continue;
    }
    if (validBudget && Number.isSafeInteger(required) && startPeriod < required) {
      violations.push(`${name}: healthcheck.start_period=${startPeriod}ms must be >= ${required}ms (${MIGRATION_ENV}=${budget}ms + ${STARTUP_MARGIN_MS}ms startup margin). Fix ${options.composeFile}.`);
    }
    if (options.healthTimeoutMs < startPeriod) {
      violations.push(`${name}: updater ${HEALTH_ENV}=${options.healthTimeoutMs}ms must be >= healthcheck.start_period=${startPeriod}ms. Fix the host updater.env or ${options.composeFile}.`);
    }
  }
  if (violations.length) {
    throw new Error(`Compose startup budget validation failed:\n${violations.join("\n")}\nSee ${GUIDE}.`);
  }
}
