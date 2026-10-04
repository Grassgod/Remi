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
 * class of bug. Tests that set/restore env capture the preload's defaults.
 *
 * MUL-512: stripping path knobs also exposed production HOME fallbacks. Create a
 * private run root after scrubbing and redirect the existing product path knobs
 * into it. Never assign HOME here: Bun 1.3.14 fixes homedir()/userInfo().homedir
 * at process startup. `bun run test` changes HOME before starting `bun test` and
 * checks the entire home afterward; direct `bun test` has only the path-knob layer.
 *
 * The policy (what is stripped, what is deliberately kept) lives in
 * `./hermetic-env-policy.ts`. This file is the only place that applies it, so
 * importing the policy from a test has no side effects.
 *
 * Scope: only `bun test` loads this (see `[test] preload` in `bunfig.toml`). The
 * standalone harnesses under `tests/` that are run via `bun run` (no `.test` suffix,
 * see TESTING.md) are untouched and keep reading the real environment.
 *
 * Guarded by `tests/arch/hermetic-test-env.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERMETIC_ENV_DEFAULTS, HERMETIC_ENV_RUN_ROOT_PATHS, HERMETIC_ENV_SENTINEL, scrubInheritedEnv } from "./hermetic-env-policy.js";

const removed = scrubInheritedEnv();

// The lock-order sentinel is a check the suite runs with by default, but it is
// also a diagnostic a developer may want off; `MULTIREMI_TEST_*` survives the
// scrub, so capture the caller's choice before the defaults force the rest.
const explicitSentinel = process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL;

// Deliberate defaults the suite runs with, applied only after the host values are
// gone, so they cannot be influenced from outside. See HERMETIC_ENV_DEFAULTS.
for (const [name, value] of Object.entries(HERMETIC_ENV_DEFAULTS)) {
  process.env[name] = value;
}
if (explicitSentinel === "0") process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL = "0";

const runRoot = mkdtempSync(join(tmpdir(), "remi-bun-test-"));
process.env.MULTIREMI_TEST_RUN_ROOT = runRoot;
for (const [name, subpath] of Object.entries(HERMETIC_ENV_RUN_ROOT_PATHS)) {
  process.env[name] = join(runRoot, subpath);
}
function cleanupRunRoot(): void {
  try { rmSync(runRoot, { recursive: true, force: true }); }
  catch { /* Open SQLite handles can prevent cleanup on Windows. */ }
}
// Bun 1.3.14's test runner does not emit process exit events on normal completion.
// A preload afterAll runs once after the suite, including ordinary test failures.
afterAll(cleanupRunRoot);
process.on("exit", cleanupRunRoot);

(globalThis as Record<symbol, unknown>)[HERMETIC_ENV_SENTINEL] = { removed };

if (removed.length > 0 && process.env.CI !== "true") {
  // One line, names only — never values; some of these are credentials.
  console.error(`[hermetic-env] stripped ${removed.length} inherited env var(s): ${removed.join(", ")}`);
}
