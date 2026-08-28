# Remi

> A Bun-based agent platform that brings Multiremi agents into chat and task workflows.

Remi connects coding agents such as Claude Code and Codex to Feishu through the Agent Client
Protocol. Multiremi owns agent definitions, project memory, issues, tasks, and runtime state; the
Remi process supplies the persistent chat lane and connector lifecycle.

## Highlights

- **Hub-and-Spoke orchestration** — A single `Remi` core (`packages/remi/src/core.ts`) routes messages between any **Connector** (input adapter) and any **Provider** (AI backend). A per-session-key `LaneScheduler` serializes concurrent traffic without blocking unrelated lanes.
- **One agent configuration** — The `multiremi_agents` row selected by `MULTIREMI_BOT_AGENT_ID` controls the bot's instructions, cwd, provider, model, executable, tools, env, args, MCP servers, thinking level, and concurrency.
- **Multiremi project memory** — Agents recall and record durable knowledge through the canonical `remi memory` CLI and API.
- **Multi-connector by design** — Ships with a full Feishu/Lark connector (cards, streaming, mentions, reactions, threading, dynamic menus). The `Connector` interface is a small surface — Slack, Discord, or HTTP webhooks fit the same shape.
- **ACP providers** — One `AcpProvider` speaks the Agent Client Protocol over stdio to Claude Code or Codex (`acp:claude` / `acp:codex`), using your existing subscription — no API key required. Per-agent behavior lives in swappable adapters.
- **Multiremi platform** — A Hono API (`apps/server/main.ts`) plus a Next.js dashboard (`frontend/`) for workspaces, projects, issues, agents, autopilots, and live task transcripts. The `remi` CLI is its agent-side client.
- **SQLite plus Postgres** — Persistent ACP session bindings and connector configuration live in local SQLite; Multiremi's authoritative data lives in SQLite or Postgres on the server.
- **Agent runtime** — The daemon (`packages/daemon/`) checks out repos, assembles per-task context, and spawns isolated agent sessions for issues and autopilot runs.

## Architecture

```
Feishu → Connector → lane/session → persistent AgentRuntime → ACP provider
                               ↑
             Multiremi daemon registration/heartbeat
                               ↑
           multiremi_agents + projects/memory/issues/tasks
```

Message flow inside `Remi._process()` → `processStream()`:

1. **Acquire lane lock** — a per-session-key `AsyncLock` prevents interleaved replies.
2. **Resolve session** — `chatId` → `sessionId` from `~/.remi/remi.db` (multi-turn continuity).
3. **Resolve agent** — registration/heartbeat fetches the configured agent from the runtime's workspace.
4. **Assemble runtime** — the agent row supplies cwd, instructions, provider/model, tools, env, args, MCP, thinking, and permissions.
5. **Run an ACP session** — provider events stream back to the connector in real time.
6. **Persist** — retain the ACP session binding and token metrics.
7. **Reply** — `AgentResponse` returned via the originating connector.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.3.14
- macOS, Linux, or WSL (SQLite-compatible filesystem)
- For the default provider: [Claude Code CLI](https://docs.claude.com/claude-code) installed and signed in. No API key needed if you have a Claude subscription.

### Install

```bash
git clone https://github.com/grasscoder/remi.git
cd remi
bun install
```

### Run the agent

```bash
# 1. Configure connector credentials and the Multiremi connection
bun run apps/remi/main.ts login
bun run apps/remi/main.ts setup

# 2. Select one active agent in the same workspace and start the co-resident daemon
export MULTIREMI_BOT_AGENT_ID=<agent-id>
bun run apps/remi/main.ts start

# 3. Check status
bun run apps/remi/main.ts status
bun run apps/remi/main.ts doctor
```

`remi --help` lists every subcommand. `remi start` is the supported lifecycle entry; the legacy
top-level `remi serve` command no longer exists.

## Configuration

ACP execution configuration has one source of truth: an active `multiremi_agents` row in the
daemon runtime's workspace. Set `MULTIREMI_BOT_AGENT_ID` to select it. Startup fails if the ID is
missing, cross-workspace, archived, unknown, or has no cwd; Remi does not fall back to local
provider settings or the home directory.

Connector, plugin, token-sync, and log settings are assembled from defaults plus environment
variables; see [`docs/deploy/66-8-remi-environment.md`](docs/deploy/66-8-remi-environment.md) for
the complete contract. `remi login` performs user authentication only and stores OAuth tokens in
`~/.remi/auth/tokens.json`. The provider/model/executable, agent instructions, cwd, tools, custom
env/args, MCP configuration, thinking level, and concurrency all come from the agent row.

## Development

```bash
# Clone and install (one bun workspace covers backend + frontend)
git clone https://github.com/grasscoder/remi.git
cd remi
bun install

# Backend: all tests, one file, typecheck
bun test
bun test tests/unit/daemon/agent-runtime-send-options.test.ts
bunx tsc --noEmit

# Frontend: Vitest suites + typecheck
cd frontend && bun run test
cd frontend && bun run typecheck

# Guard: the API route surface must match the golden snapshot
bun run scripts/snapshot-api-routes.ts --check

# Build the release archives (compiled binary + ACP wrapper, all platforms)
bun run build:multiremi
```

See [`TESTING.md`](TESTING.md) for the full test layout and [`CONTRIBUTING.md`](CONTRIBUTING.md)
for how to extend Remi.

Conventions:

- **TypeScript strict mode** everywhere.
- **Full async/await** — no sync blocking in async paths; use `Bun.spawn()` for subprocesses.
- **Interfaces over inheritance** — Providers and Connectors are small interfaces, not class hierarchies.
- **Plain data types** — `IncomingMessage`, `AgentResponse`, `ToolDefinition` are interfaces, not classes.
- **Per-session-key `AsyncLock`** (via `LaneScheduler`) to serialize a single conversation while keeping lanes independent.

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
│   ├── remi/                  # L3: persistent chat core + project/session integration
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
