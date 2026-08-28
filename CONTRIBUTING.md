# Contributing to Remi

This guide covers the development environment, the repository layout, and how to extend the
platform with a new connector, provider, or plugin.

## Requirements

- **[Bun](https://bun.sh) 1.3.14+** — runtime, package manager, test runner, and bundler.
  CI pins 1.3.14 (`.github/workflows/release-build-check.yml`).
- **Git**.
- **Optional**: [Claude Code CLI](https://docs.claude.com/claude-code) or Codex signed in, if you
  want to exercise a real ACP provider locally.

SQLite comes from `bun:sqlite`. macOS ships a proprietary SQLite that disables `loadExtension()`,
so `packages/shared/src/db/sqlite-custom.ts` swaps in a custom build — it must stay the first
import in every entry point.

## Repository layout

One bun workspace (`packages/*`, `frontend`, `frontend/apps/*`, `frontend/packages/*`).

```
apps/remi/            `remi` CLI entry (main.ts + cli/ subcommands)
apps/server/          `multiremi` server + CLI entry
packages/
  shared/             L0 — config (SQLite-backed), db, logger, tracing, metrics
  contracts/          L0 — pure shared types (API, ACP protocol, provider payloads)
  acp/                L1 — AcpProvider + adapters/{claude-code,codex}
  connectors/         L1 — base.ts (Connector interface) + feishu/
  auth/               L1 — 1Passport: Feishu OAuth, token sync
  daemon/             L2 — agent runtime, orchestrator, autopilot scheduler
  remi/               L3 — persistent chat core and project/session integration
  server/             L3 — Multiremi: api/ (routers + wire), store/ (repos), worker/, relay/
  plugin-sdk/         Public plugin contract (@remi/plugin-sdk)
frontend/             Nested workspace — Next.js dashboard
  apps/web/           the app
  packages/{ui,core,views}/
  e2e/                Playwright specs
tests/                bun:test — unit/, integration/, manual/, arch/, fixtures/
```

Imports use the tsconfig path aliases (`@shared/*`, `@acp/*`, `@connectors/*`, `@auth/*`,
`@daemon/*`, `@remi/*`, `@multiremi/*`), never deep relative paths across
packages. A lower layer must never import upward. `tests/arch/package-boundaries.test.ts` is the
machine-checked part of that rule and fails `bun test` if you break it: `packages/contracts` stays
free of `bun:`/`node:`/`process.`, no `packages/*` may import the application core
(`@remi/*`, `@multiremi/*`) except `packages/server` addressing itself, and `packages/server`'s
used workspace aliases must exactly equal its declared allowlist.

## Development workflow

```bash
# 1. Fork, clone, install
git clone https://github.com/<your-username>/remi.git
cd remi
git remote add upstream https://github.com/grasscoder/remi.git
bun install

# 2. Verify a clean baseline
bun test                                    # backend suite (bunfig root = tests/)
bunx tsc --noEmit                           # backend typecheck — must be zero errors
cd frontend && bun run test && bun run typecheck && cd ..

# 3. Branch
git checkout -b feat/your-feature

# 4. Iterate
bun test tests/unit/daemon/agent-runtime-send-options.test.ts  # single file
bun test --watch                            # watch mode
bun run apps/remi/main.ts start             # Multiremi daemon + configured Feishu channel
bun run scripts/snapshot-api-routes.ts --check   # API route surface unchanged?
bun run build:multiremi                     # release archives (binary + ACP wrapper)
```

`bun test` compares the Multiremi route surface against `scripts/api-routes.golden.json`
byte-for-byte, so any drift fails the suite. If you are *moving* code, a diff means the move
changed behavior — fix the move, never regenerate the baseline. Only when you deliberately add or
change an endpoint do you rerun `bun run scripts/snapshot-api-routes.ts` (no flag) and include the
regenerated golden file in the PR.

### Dependency changes (依赖变更)

Installing through a fast internal npm mirror (a `registry=` line in your `~/.npmrc` or
`~/.bunfig.toml`) is fine and encouraged — keep it. But bun records an absolute tarball URL in
`bun.lock` for every package it resolves off a non-default registry, and Bun offers no way
to fetch from a mirror while writing a registry-neutral lockfile. So whenever `bun.lock` changes
(`bun add`, a bumped range, `bun install --force`), run `bun run lock:clean` before committing: it
blanks those URLs back to the default-registry form and leaves integrity hashes untouched. Everyday
`bun install` with an unchanged lockfile rewrites nothing and needs no cleanup.
`tests/arch/lockfile-registry.test.ts` fails `bun test` if a mirror URL slips through; if one
reaches `main` anyway, the release workflows install with
`--registry https://registry.npmjs.org --frozen-lockfile` and die trying to reach a host that does
not exist from a GitHub runner.

Then open a PR against `main`. Describe **what** changed and **why**, link related issues, and
include a test plan. Keep PRs focused — refactors and feature work go in separate PRs.

## Code style

- **TypeScript strict mode.** Do not weaken `tsconfig.json`. Prefer narrow types over `any`.
- **Async/await throughout.** Never block the event loop in an async path. Use `Bun.spawn()` for
  subprocesses.
- **Interfaces over inheritance.** New backends implement an existing interface (`Provider`,
  `Connector`) rather than extend a base class.
- **Plain data objects.** Message payloads, configs, and tool definitions are interfaces —
  no constructors, no classes for data.
- **Comments are rare.** Names explain *what*; comments are reserved for non-obvious *why*.
- **No dead code.** Removing a feature removes its tests, types, and docs in the same PR.
- **File layout.** Keep modules under ~500 lines where possible. Split by responsibility.

There is no separate formatter step; match the surrounding style.

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`, with
`feat` / `fix` / `refactor` / `perf` / `docs` / `test` / `chore` / `revert`. Keep the subject under
72 characters and use the body for the *why*.

```
feat(connectors): add Slack connector with thread support
fix(daemon): reject an archived bot agent
refactor(api): split routers by domain
```

## Testing expectations

`TESTING.md` is the full reference. The short version:

- Backend tests are **centralized** under `tests/` — `bunfig.toml` sets `[test] root = "tests"`,
  so only `tests/**/*.test.ts` is discovered.
  - `tests/unit/<area>/` — pure logic and interface-level tests, no external services. Areas
    mirror the packages: `acp/`, `connectors/`, `daemon/`, `multiremi/`, `remi/`, `shared/`.
  - `tests/integration/` — cross-component and full-stack harnesses. Anything needing a real
    provider, browser, or Postgres is a plain `*.ts` (not `*.test.ts`) so `bun test` skips it,
    **and must get a `package.json` script entry** or it becomes an orphan nobody runs.
  - `tests/manual/` — parameterized debugging scripts against real services, not regression tests.
  - `tests/arch/` — architecture guards (package boundaries, type mirrors, endpoint wiring).
  - `tests/fixtures/` — recorded data, e.g. `acp/*.json` for replay.
- **Multiremi API/store tests** use the shared fixtures in `tests/unit/multiremi/helpers.ts`
  (`createStore()` on an in-memory DB, `signTestJwt()`, `mockFetch()`/`jsonResponse()`, the
  WebSocket wait helpers). Import them — do not re-declare a local copy.
  `tests/unit/multiremi/multiremi-api-issues.test.ts` is the model for an API-level test:
  `createMultiremiApp()` + `app.request()` in-process, no network.
- **New store repos ship with a sibling test.** The convention for
  `packages/server/src/store/repos/<domain>-repo.ts` is a `tests/unit/multiremi/*store-<domain>*.test.ts`
  driving it against a `:memory:` DB (see `multiremi-store-issues.test.ts`,
  `store-agents-skills-repo.test.ts`). Coverage is not yet uniform across the existing repos —
  several are only exercised through the API-level tests — but new work is expected to add one.
- Frontend tests sit **next to the source** (`foo.test.ts` beside `foo.ts`) and run under Vitest.
- Tests must run offline. Mock external services; don't hit the network.

## Extending Remi

### Add a Connector

A connector turns external events into `IncomingMessage` and dispatches responses back.
Implement `Connector` from `packages/connectors/src/base.ts`:

```ts
export interface Connector {
  readonly name: string;
  start(handler: MessageHandler, streamHandler?: StreamingHandler): Promise<void>;
  stop(): Promise<void>;
  reply(chatId: string, response: AgentResponse): Promise<void>;
}
```

1. Create `packages/connectors/src/<your-connector>/index.ts` exporting a class that implements it.
2. Translate inbound events into `IncomingMessage` (`text`, `chatId`, optional `sender`,
   `connectorName`, `media`, `metadata`).
3. Prefer the `streamHandler` path: it hands you an `AsyncIterable<ProviderEvent>` plus a
   `StreamMeta`, so you can render tool calls and thinking live instead of waiting for the final
   text. `start()` receives both handlers.
4. Register it in `Remi.boot()` (`packages/remi/src/core.ts`) alongside the Feishu wiring, and add
   its config section and environment parser to `packages/shared/src/config.ts`. Document every
   new variable and its missing/invalid behavior under `docs/deploy/`.
5. Add a test under `tests/unit/connectors/` that drives the connector with a fake transport.

`packages/connectors/src/feishu/` is the reference implementation — cards, streaming, mentions,
reactions, threading, dynamic menus. Note that it stays at L1: it never imports from
`packages/remi` or `packages/server`, and takes product-level lookups by injection instead.

### Add a Provider

A provider is an AI backend. Implement `Provider` from
`packages/contracts/src/provider-types.ts` (`name`, `send()`, `healthCheck()`).

In practice there is now exactly one provider class — `AcpProvider`
(`packages/acp/src/provider.ts`) — which speaks the Agent Client Protocol over stdio. **If your
backend has an ACP bridge, do not write a provider: write an adapter.**

1. Create `packages/acp/src/adapters/<agent>/index.ts` implementing `AgentAdapter`
   (`packages/contracts/src/acp-protocol.ts`).
2. Register it in the `registry` map in `packages/acp/src/adapters/index.ts`.
3. Teach the ACP adapter registry and `Remi._buildProvider()` (`packages/remi/src/core.ts`) the
   new provider name. Runtime selection and options stay in `multiremi_agents`; do not add a local
   provider config.
4. Test against a recorded fixture: drop a recording in `tests/fixtures/acp/` and check coverage
   with `bun run replay:coverage`. `tests/unit/acp/` holds the adapter-level tests.

Write a fresh `Provider` implementation only for a backend that has no ACP bridge at all.

### Add scheduled work

Scheduled platform work belongs in Multiremi autopilots and
`packages/daemon/src/scheduler.ts`. Do not add a second local queue or cron config to Remi. A
connector-local timer is appropriate only when the work must access a live connector instance in
the same process; keep that lifecycle next to the co-resident daemon startup and test shutdown.

### Add a plugin

External drop-in plugins live under `~/.remi/plugins/<id>/` and are loaded through
`@remi/plugin-sdk` (`packages/plugin-sdk/src/index.ts`). A plugin can contribute CLI commands and
auth adapters. `tests/arch/package-boundaries.test.ts` includes a type-mirror probe that keeps the
SDK's public types in sync with `packages/auth` — if you change one, change both.

### Add MCP configuration

MCP servers used by Remi are configured on the selected `multiremi_agents.mcp_config` row and are
passed through ACP `session/new`. Durable project knowledge uses the canonical `remi memory`
commands rather than a local memory MCP server. Add a server implementation only when it owns a
distinct external capability, then configure it on the agent row and add runtime assembly tests.

## Filing issues

Include:

- Remi version (`bun run apps/remi/main.ts --version`) and Bun version (`bun --version`).
- OS and architecture.
- Minimal reproduction steps.
- Relevant logs from `~/.remi/logs/` (redact secrets).

Feature requests are welcome — describe the *use case* before the *solution*.

## Code of Conduct

Be kind, assume good faith, and keep discussions focused on the work. We follow the
[Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) at
minimum.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
