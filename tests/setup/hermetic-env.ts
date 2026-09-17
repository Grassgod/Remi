/**
 * `bun test` preload: cut the backend test process off from the host environment.
 *
 * Why this exists (MUL-318): the daemon injects `MULTIREMI_TOKEN=<task token>`
 * into every Agent process (`packages/daemon/src/agent-runtime/env/injector.ts`),
 * and `createMultiremiApp()` reads `options.authToken ?? process.env.MULTIREMI_TOKEN`
 * (`packages/server/src/api/server.ts`). Unit tests call `createMultiremiApp({ store })`
 * without an `authToken`, so inside an Agent the whole API suite silently turned on
 * dashboard auth and ~242 `app.request(...)` assertions got 401 instead of 2xx.
 * GitHub Actions has no such variable, so CI stayed green and only Agents (and any
 * shell with a token exported) saw the false red.
 *
 * Rather than patch that one variable, strip the repo's whole env namespace before
 * any test module is evaluated: a test that wants an env var must set it itself.
 * Prefix matching means a newly added `MULTIREMI_*` knob can never reintroduce this
 * class of bug. Individual tests that set/restore env still work — they capture
 * `undefined` at import time and restore to `undefined`.
 *
 * Scope: only `bun test` loads this (see `[test] preload` in `bunfig.toml`). The
 * standalone harnesses under `tests/` that are run via `bun run` (no `.test` suffix,
 * see TESTING.md) are untouched and keep reading the real environment.
 *
 * Guarded by `tests/arch/hermetic-test-env.test.ts`.
 */

/** Every env var under these prefixes is this repo's own configuration surface. */
export const SCRUBBED_ENV_PREFIXES = ["MULTIREMI_", "REMI_"] as const;

/**
 * Unprefixed variables that also change server behavior. `SQLITE_LIB_PATH` is
 * deliberately absent: it points at a host-provided sqlite build (a capability,
 * not a behavior toggle), and dropping it would break machines that need it.
 */
export const SCRUBBED_ENV_KEYS = [
  "JWT_SECRET",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENVIKING_API_KEY",
  "POSTHOG_API_KEY",
  "POSTHOG_HOST",
  "ANALYTICS_DISABLED",
] as const;

/** True when `name` is one of the variables this preload removes. */
export function isScrubbedEnvKey(name: string): boolean {
  return SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
    || (SCRUBBED_ENV_KEYS as readonly string[]).includes(name);
}

/** Env vars inherited from the host that this process removed, for diagnostics. */
export function scrubInheritedEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!isScrubbedEnvKey(name)) continue;
    removed.push(name);
    delete env[name];
  }
  return removed.sort();
}

/** Set on `globalThis` so the guard test can prove the preload actually ran. */
export const HERMETIC_ENV_SENTINEL = Symbol.for("multiremi.test.hermeticEnv");

const removed = scrubInheritedEnv();
(globalThis as Record<symbol, unknown>)[HERMETIC_ENV_SENTINEL] = { removed };

if (removed.length > 0 && process.env.CI !== "true") {
  // One line, names only — never values; some of these are credentials.
  console.error(`[hermetic-env] stripped ${removed.length} inherited env var(s): ${removed.join(", ")}`);
}
