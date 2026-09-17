/**
 * What `bun test` strips from the host environment, and why.
 *
 * Pure module, no side effects: importing it must not change `process.env`.
 * `tests/setup/hermetic-env.ts` is the preload that actually applies the policy;
 * `tests/arch/hermetic-test-env.test.ts` imports only this file, so the sentinel it
 * checks can only have been set by the real preload (importing the preload from the
 * guard would make the guard prove itself — MUL-318 QA).
 */

/** Every env var under these prefixes is this repo's own configuration surface. */
export const SCRUBBED_ENV_PREFIXES = [
  "MULTIREMI_",
  "REMI_",
  // Provider/connector credentials and endpoints. A developer with real keys
  // exported would otherwise run a different code path than CI does.
  "ANTHROPIC_",
  "FEISHU_",
] as const;

/**
 * Test-owned inputs that survive the scrub.
 *
 * A `<PREFIX>_TEST_*` name under a scrubbed prefix is something a developer or CI
 * exports to *drive* the suite, not to configure the product, so the scrub must not
 * eat it. `MULTIREMI_TEST_POSTGRES_URL` selects the integration database and
 * `tests/unit/multiremi/chat-issue-audit-metrics.test.ts` requires an explicit
 * target's failure to throw instead of skip — scrubbing it turned "this integration
 * target is unreachable" into a silent skip against a localhost fallback, exactly the
 * class of false green this preload exists to kill. `FEISHU_TEST_CHAT_ID` is only read
 * by the `bun run` harnesses under `tests/manual/` today, which never load this
 * preload; it is listed so that stays true if one of them ever becomes a `*.test.ts`.
 */
export const SCRUBBED_ENV_EXEMPT_PREFIXES = ["MULTIREMI_TEST_", "FEISHU_TEST_"] as const;

/**
 * Unprefixed variables that also change server behavior.
 *
 * Deliberately absent, and why:
 * - `NODE_ENV` — `bun test` sets it to "test", and the code reads that as a mode:
 *   `packages/server/src/api/helpers/jwt.ts` only falls back to the default signing
 *   secret in development/test, and `packages/server/src/agent-plugins/git-import.ts`
 *   guards a network path on `!== "test"`. Deleting it would break the suite, not
 *   isolate it.
 * - `PATH` / `HOME` / `SHELL` / `USER` / `GIT_SSH_COMMAND` / `GIT_CONFIG_*` — host
 *   capabilities the test process needs to run at all.
 * - `SQLITE_LIB_PATH` — points at a host-provided sqlite build; a capability, not a
 *   behavior toggle, and dropping it breaks machines that need it.
 */
export const SCRUBBED_ENV_KEYS = [
  "JWT_SECRET",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "OPENAI_API_KEY",
  "OPENVIKING_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GITHUB_TOKEN",
  "POSTHOG_API_KEY",
  "POSTHOG_HOST",
  "ANALYTICS_DISABLED",
] as const;

/** True when `name` is one of the variables the preload removes. */
export function isScrubbedEnvKey(name: string): boolean {
  if (SCRUBBED_ENV_EXEMPT_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  return SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
    || (SCRUBBED_ENV_KEYS as readonly string[]).includes(name);
}

/** Remove every scrubbed var from `env`; returns the names removed, for diagnostics. */
export function scrubInheritedEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!isScrubbedEnvKey(name)) continue;
    removed.push(name);
    delete env[name];
  }
  return removed.sort();
}

/** Set on `globalThis` by the preload so the guard can prove the preload actually ran. */
export const HERMETIC_ENV_SENTINEL = Symbol.for("multiremi.test.hermeticEnv");
