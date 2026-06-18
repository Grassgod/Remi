/**
 * CLI version reported by the `remi` daemon on register (stored in runtime
 * metadata as cli_version). Injected at compile time via
 * `bun build --define REMI_VERSION='"…"'`; when run from source (no define) it
 * falls back to a git-describe-shaped string the quick-create version gate
 * treats as a dev build and exempts — see packages/core/runtimes/cli-version.ts
 * and server/pkg/agent/version.go.
 *
 * `typeof` guards the bare identifier so this is safe both compiled (define
 * present) and interpreted (`bun run`, identifier absent).
 */
declare const REMI_VERSION: string | undefined;

export const remiVersion: string =
  typeof REMI_VERSION !== "undefined" && REMI_VERSION ? REMI_VERSION : "v0.2.20-1-g0000000";
