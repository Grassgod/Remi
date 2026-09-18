# Contributing to Remi

Read [AGENTS.md](AGENTS.md) for repository rules, [the development index](docs/dev/README.md) for task context, and [CLAUDE.md](CLAUDE.md) for commands. Architecture is maintained in [one current map](docs/ARCHITECTURE.md).

## Environment and verification

Use Bun 1.3.14, Git, and the single root workspace install. Node.js 22+ runs the documentation checks without dependencies. Real ACP tests need the selected provider CLI and credentials; ordinary unit tests should use isolated fixtures. See [TESTING.md](TESTING.md) for discovery, service prerequisites, and CI coverage.

For dependency changes, use the public registry and verify [the lockfile guard](tests/arch/lockfile-registry.test.ts). `bun run lock:clean` removes non-public tarball origins recorded in the lockfile; it does not replace dependency or integrity review.

## Find the implementation to extend

| Change | Sources and validation |
|---|---|
| Connector | [Connector interface](packages/connectors/src/base.ts), [Feishu implementation](packages/connectors/src/feishu), [foreground task wiring](apps/remi/cli/multiremi.ts), [concierge supervisor](packages/server/src/worker/feishu-concierge.ts); tests in [connectors](tests/unit/connectors) |
| ACP backend | [AgentAdapter contract](packages/contracts/src/acp-protocol.ts), [adapter registry](packages/acp/src/adapters/index.ts), [provisioning](packages/acp/src/provision.ts), [runtime assembly](packages/daemon/src/agent-runtime/runtime.ts); tests in [acp](tests/unit/acp) |
| Platform API / CLI | [routers](packages/server/src/api/routers), [wire serialization](packages/server/src/api/wire), [domain repos](packages/server/src/store/repos), [CommandRegistry](apps/remi/cli/core/command-registry.ts); follow [CLI contract](docs/cli-command-migration.md) |
| Scheduled work | [autopilot repos](packages/server/src/store/repos/autopilots-repo.ts), [scheduler](packages/daemon/src/scheduler.ts), [task worker](packages/server/src/worker/daemon.ts) |
| Project knowledge | [current Memory/Wiki contract](docs/project-wiki-memory-spec.md) |
| Host plugin / agent bundle | [SDK](packages/plugin-sdk/src/index.ts), [host plugin loader](packages/daemon/src/agent-runtime/plugins), [agent bundle materialization](packages/daemon/src/agent-runtime/agent-plugins); [configuration spec](docs/agent-config-spec.md) |
| Agent MCP | [stdio MCP assembly](packages/daemon/src/agent-runtime/mcp/ephemeral.ts); current injection requires `command`, not only a saved URL |
| Web | [frontend rules](frontend/AGENTS.md), [frontend map](docs/dev/frontend.md) |

Use source types rather than copying interface declarations into documentation. ACP execution settings come from the selected agent row; connector configuration and provider credentials have separate lifecycles.

The [package boundary tests](tests/arch/package-boundaries.test.ts) and [tsconfig aliases](tsconfig.json) define the enforced dependency surface. The synchronous store and PostgreSQL bridge require special care when changing request concurrency or transactions; see [performance constraints](docs/dev/performance.md).

## Review evidence

Explain the changed behavior, relevant source/contract changes, commands actually run, and unverified boundaries. For API additions, include the Registry capability and route snapshot updates required by [AGENTS.md](AGENTS.md). Update the owning documentation in the same change; [context maintenance](docs/dev/context-maintenance.md) describes replacement and validation.

Bug reports should include version, OS/architecture, reproduction steps, and relevant logs with secrets removed. Contributions use the repository's [MIT license](LICENSE).
