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
import { HERMETIC_ENV_SENTINEL, scrubInheritedEnv } from "./hermetic-env-policy.js";

const removed = scrubInheritedEnv();
(globalThis as Record<symbol, unknown>)[HERMETIC_ENV_SENTINEL] = { removed };

if (removed.length > 0 && process.env.CI !== "true") {
  // One line, names only — never values; some of these are credentials.
  console.error(`[hermetic-env] stripped ${removed.length} inherited env var(s): ${removed.join(", ")}`);
}
