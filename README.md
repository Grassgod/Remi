# Remi

> A Bun-based agent platform that brings Multiremi agents into chat and task workflows.

Remi connects coding agents such as Claude Code and Codex to Feishu through the Agent Client
Protocol. Multiremi owns agent definitions, project memory, issues, tasks, and runtime state; the
Remi daemon supplies the connector lifecycle and executes platform tasks.

## Highlights

- **Unified task execution** — Feishu messages enter the platform Chat/Task path through the daemon concierge. Task history, steering, cancellation, human requests, and ACP execution share the same runtime flow.
- **Control-plane bot configuration** — Workspace Feishu concierge settings select an Agent and Runtime. The assigned `multiremi_agents` row controls instructions and execution options; the daemon reconciles configuration revisions delivered through heartbeats.
- **Multiremi project memory** — Agents recall and record durable knowledge through the canonical `remi memory` CLI and API.
- **Multi-connector by design** — Ships with a full Feishu/Lark connector (cards, streaming, mentions, reactions, threading, dynamic menus). The `Connector` interface is a small surface — Slack, Discord, or HTTP webhooks fit the same shape.
- **ACP providers** — One `AcpProvider` speaks the Agent Client Protocol over stdio to Claude Code or Codex (`acp:claude` / `acp:codex`), using your existing subscription — no API key required. Per-agent behavior lives in swappable adapters.
- **Multiremi platform** — A Hono API (`apps/server/main.ts`) plus a Next.js dashboard (`frontend/`) for workspaces, projects, issues, agents, autopilots, and live task transcripts. The `remi` CLI is its agent-side client.
- **SQLite plus Postgres** — The server owns authoritative task and session state in SQLite or Postgres; the daemon keeps local operational state. Feishu bot configuration is stored by the control plane.
- **Agent runtime** — The daemon (`packages/daemon/`) checks out repos, assembles per-task context, and spawns isolated agent sessions for issues and autopilot runs.

## Architecture

```text
Workspace Feishu bot config → heartbeat directive → Runtime concierge supervisor
                                                     ↓ config fetch
Feishu message → Connector → platform Chat / Task → daemon worker → AgentRuntime → ACP
                                 ↑                                      ↓
                                 └──────── messages / usage / result ────┘
```

The current foreground daemon boots a Feishu transport through `controlPlaneConciergeHost`.
Ordinary messages become canonical platform Chat/Task operations; live-task steering, duplicate
messages, cancellation, and human requests use that same task path. Connector replies consume
persisted task events. The control plane selects the bot Agent and Runtime and coordinates
configuration revisions and handover.

See the [current architecture map](docs/ARCHITECTURE.md) for source ownership and the separate
[message ingestion service](docs/feishu-message-ingestion.md) for Connection/Source polling.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.3.14
- macOS, Linux, or WSL (SQLite-compatible filesystem)
- For the default provider: [Claude Code CLI](https://docs.claude.com/claude-code) installed and signed in. No API key needed if you have a Claude subscription.

### Install

```bash
git clone https://github.com/moesin-lab/Remi.git remi
cd remi
bun install
```

### Run the agent

```bash
# 1. Authenticate and configure the Multiremi connection
bun run apps/remi/main.ts login
bun run apps/remi/main.ts setup

# 2. Start the Runtime daemon
bun run apps/remi/main.ts start

# 3. Check status
bun run apps/remi/main.ts status
bun run apps/remi/main.ts doctor
```

In workspace settings, configure the Feishu concierge credentials, select an eligible Agent and
Runtime, test the credentials, and deploy. The daemon starts the assigned bot after receiving the
control-plane directive. `remi workspace feishu-bot --help` exposes the corresponding CLI operations.
See the [daemon configuration guide](docs/deploy/66-8-remi-environment.md) for prerequisites.

`remi --help` lists every subcommand. `remi start` is the daemon lifecycle entry.

## Configuration

For bot tasks, ACP execution configuration comes from the Agent assigned by workspace Feishu concierge settings.
The control plane validates the Agent and Runtime, and coordinates handover before releasing the
configuration. The daemon supervisor fetches the assignment, reconciles its revision, and reports
the actual connector state. Implementation entry points are in the [architecture map](docs/ARCHITECTURE.md).

Process-level plugin, token-sync, and log settings are assembled from defaults plus environment
variables; see [`docs/deploy/66-8-remi-environment.md`](docs/deploy/66-8-remi-environment.md) for
the complete contract. `remi login` performs user authentication only and stores OAuth tokens in
`~/.remi/auth/tokens.json`. The provider/model/executable, agent instructions, cwd, tools, custom
env/args, MCP configuration, thinking level, and concurrency all come from the agent row.

## Development

Start with the [developer context index](docs/dev/README.md) for current architecture,
frontend ownership, performance investigation, and validation commands.

```bash
# Clone and install (one bun workspace covers backend + frontend)
git clone https://github.com/moesin-lab/Remi.git remi
cd remi
bun install

# Backend: all tests, one file, typecheck
bun test
bun test tests/unit/daemon/agent-runtime-send-options.test.ts
bunx tsc --noEmit

# Frontend: Vitest suites + typecheck
bun run test:frontend
bun run typecheck:frontend

# Guard: the API route surface must match the golden snapshot
bun run scripts/snapshot-api-routes.ts --check

# Build the release archives (compiled binary + ACP wrapper, all platforms)
bun run build:multiremi
```

See [`TESTING.md`](TESTING.md) for the full test layout and [`CONTRIBUTING.md`](CONTRIBUTING.md)
for how to extend Remi.

Conventions:

- **TypeScript strict mode** everywhere.
- **Concurrency constraints** — the Store and PostgreSQL bridge currently expose synchronous calls. Read the [storage and performance constraints](docs/ARCHITECTURE.md#存储与事务) before changing request concurrency or transactions.
- **Interfaces over inheritance** — Providers and Connectors are small interfaces, not class hierarchies.
- **Plain data types** — `IncomingMessage`, `AgentResponse`, `ToolDefinition` are interfaces, not classes.
- **Task lifecycle** — use platform task history and runtime state when changing chat continuation, steering, cancellation, or retries.

## Project Structure

One bun workspace. `apps/` holds entry points, `packages/` holds the layered libraries they
compose, `frontend/` is its own nested workspace of web packages.

```
remi/
├── apps/
│   ├── remi/                  # `remi` CLI entry
│   │   ├── main.ts            #   dispatch
│   │   └── cli/               #   subcommands (start/login/doctor/multiremi/…)
│   └── server/main.ts         # `multiremi` server + CLI entry
├── packages/
│   ├── shared/                # L0: config, SQLite (~/.remi/remi.db), logger, tracing, metrics
│   ├── contracts/             # L0: shared types — API, ACP protocol, Provider/Connector payloads
│   ├── acp/                   # L1: AcpProvider + per-agent adapters (claude-code, codex)
│   ├── connectors/            # L1: base.ts (Connector interface) + feishu/ (cards, streaming, menus)
│   ├── auth/                  # L1: 1Passport — Feishu OAuth, token sync, adapters
│   ├── daemon/                # L2: agent runtime (repo checkout, prompts, skills, plugins),
│   │                          #     orchestrator (LaneScheduler), autopilot scheduler
│   ├── remi/                  # Remi core library + project/session helpers
│   ├── server/                # L3: Multiremi — Hono api/ (routers + wire), store/ (repos), worker/
│   └── plugin-sdk/            # Public plugin contract (@remi/plugin-sdk)
├── frontend/                  # Nested workspace — Next.js dashboard
│   ├── apps/web/              #   the Next.js app
│   ├── packages/{ui,core,views}/  # design system, data/state layer, page views
│   └── e2e/                   #   Playwright specs
├── bin/                       # Shipped ACP wrapper (remi-claude-agent-acp)
├── scripts/                   # build-multiremi, install-remi.sh, nginx, API-route snapshot
├── tests/                     # bun:test — unit/, integration/, manual/, arch/, fixtures/
└── docs/                      # Design notes and specs
```

## License

[MIT](LICENSE) © 2024-2026 Huajie He and contributors.
