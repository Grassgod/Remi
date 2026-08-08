# Remi

> A personal AI assistant platform built on Bun — your AI lives in chat, remembers what matters, and grows with you.

Remi is an extensible AI assistant runtime that connects modern coding agents (Claude Code, Codex — over the Agent Client Protocol) to the messengers and tools you already use. Unlike a stateless chatbot, Remi maintains a structured, file-based memory of your work, relationships, and decisions, and runs long-lived agent sessions against real repositories. It is designed to be self-hosted, hackable, and to scale from a single process on your laptop to a fleet of agents driven by the Multiremi server and its web dashboard.

## Highlights

- **Hub-and-Spoke orchestration** — A single `Remi` core (`packages/remi/src/core.ts`) routes messages between any **Connector** (input adapter) and any **Provider** (AI backend). A per-session-key `LaneScheduler` serializes concurrent traffic without blocking unrelated lanes.
- **Markdown-based memory** — Persistent memory stored as plain Markdown under `~/.remi/memory/` (`MEMORY.md`, `daily/`, per-entity files). Every write is backed up under `.versions/`, and recall runs a three-layer pipeline (index/substring → vector → rerank).
- **Multi-connector by design** — Ships with a full Feishu/Lark connector (cards, streaming, mentions, reactions, threading, dynamic menus). The `Connector` interface is a small surface — Slack, Discord, or HTTP webhooks fit the same shape.
- **ACP providers** — One `AcpProvider` speaks the Agent Client Protocol over stdio to Claude Code or Codex (`acp:claude` / `acp:codex`), using your existing subscription — no API key required. Per-agent behavior lives in swappable adapters.
- **BunQueue cron pipeline** — A durable `remi:cron` queue drives provider heartbeats, the proactive pulse briefing, and skill report generation/delivery.
- **Multiremi platform** — A Hono API (`apps/server/main.ts`) plus a Next.js dashboard (`frontend/`) for workspaces, projects, issues, agents, autopilots, and live task transcripts. The `remi` CLI is its agent-side client.
- **MCP server included** — A built-in Model Context Protocol server (`packages/memory/src/mcp-server.ts`) exposes `recall`, `remember`, and `backlinks` so any MCP-compatible agent can read and write your memory graph.
- **SQLite (or Postgres) + sqlite-vec** — Config, sessions, and metrics live in SQLite at `~/.remi/remi.db`; the Multiremi server also runs on Postgres. Vector search over memory uses `sqlite-vec` with pluggable embedding providers (Voyage, OpenAI-compatible).
- **Agent runtime** — The daemon (`packages/daemon/`) checks out repos, assembles per-task context, and spawns isolated agent sessions for issues and autopilot runs.

## Architecture

```
                           ┌─────────────────────────────────────────┐
                           │      Remi (packages/remi/src/core.ts)   │
   ┌─────────────┐         │                                         │         ┌──────────────┐
   │ Connectors  │ ──IM──▶ │  Lane Lock → Session → Runtime → Route  │ ──ACP──▶│  Providers   │
   │             │         │                                         │         │              │
   │ • Feishu    │         │   ┌─────────┐  ┌─────────┐ ┌─────────┐  │         │ • acp:claude │
   │ • (Slack…)  │ ◀─reply─│   │ Memory  │  │  Queue  │ │ Tracing │  │ ◀─resp──│ • acp:codex  │
   │ • (HTTP…)   │         │   │  Store  │  │ BunQueue│ │ +Metrics│  │         │ • (custom)   │
   └─────────────┘         │   └────┬────┘  └────┬────┘ └─────────┘  │         └──────────────┘
                           └────────┼────────────┼───────────────────┘
                                    │            │
                                    ▼            ▼
                          ~/.remi/memory/   ~/.remi/remi.db
                          (Markdown +       (config, sessions,
                           .versions/)       metrics, cron queue)

     ┌──────────────────────────────────┐   ┌──────────────────────────────┐
     │  Multiremi server                │   │  MCP Server                  │
     │  apps/server + frontend (Next.js)│   │  recall / remember / backlinks
     └──────────────────────────────────┘   └──────────────────────────────┘
```

Message flow inside `Remi._process()` → `processStream()`:

1. **Acquire lane lock** — a per-session-key `AsyncLock` prevents interleaved replies.
2. **Resolve session** — `chatId` → `sessionId` from `~/.remi/remi.db` (multi-turn continuity).
3. **Assemble runtime** — cwd, provider, group policy, MCP servers, permission mode.
4. **Run an ACP session** — provider events stream back to the connector in real time.
5. **Persist** — append the interaction to the daily journal; record token metrics.
6. **Reply** — `AgentResponse` returned via the originating connector.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.0 or newer
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
# 1. Configure interactively (writes config into ~/.remi/remi.db)
bun run apps/remi/main.ts login

# 2. Start the agent (Multiremi worker + Feishu channel, per config)
bun run apps/remi/main.ts start

# 3. Check status
bun run apps/remi/main.ts status
bun run apps/remi/main.ts doctor
```

`remi --help` lists every subcommand. `bun run apps/remi/main.ts serve` runs the Feishu
connector daemon (connectors + cron queue + admin API) directly in the foreground.

## Configuration

Configuration lives in SQLite — the `remi_config` table of `~/.remi/remi.db` — and is read by
`loadConfig()` in `packages/shared/src/config.ts` (`RemiConfig` interface). There is no
`remi.toml`. Resolution order:

1. Environment variables (e.g. `REMI_PROVIDER`, `REMI_MODEL`, `FEISHU_APP_ID`, `GOOGLE_API_KEY`)
2. The stored `remi_config` sections (`provider`, `feishu`, `plugins`, `auth`, `cronJobs`, `proxy`,
   `embedding`, `mcp`, `tracing`, …)
3. Built-in defaults (`defaultRemiConfig`)

`remi login` walks through the most common settings and writes them for you; `remi config` reads
and sets individual keys.

## Development

```bash
# Clone and install (one bun workspace covers backend + frontend)
git clone https://github.com/grasscoder/remi.git
cd remi
bun install

# Backend: all tests, one file, typecheck
bun test
bun test tests/unit/memory/memory.test.ts
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
- **Full async/await** — no sync blocking in async paths; `Bun.spawn()` for subprocesses; `node:fs` sync APIs only inside the memory store.
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
│   │   └── cli/               #   subcommands (login/doctor/serve/multiremi/…)
│   └── server/main.ts         # `multiremi` server + CLI entry
├── packages/
│   ├── shared/                # L0: config, SQLite (~/.remi/remi.db), logger, tracing, metrics
│   ├── contracts/             # L0: shared types — API, ACP protocol, Provider/Connector payloads
│   ├── acp/                   # L1: AcpProvider + per-agent adapters (claude-code, codex)
│   ├── connectors/            # L1: base.ts (Connector interface) + feishu/ (cards, streaming, menus)
│   ├── memory/                # L1: Markdown memory store, link graph, MCP server
│   ├── auth/                  # L1: 1Passport — Feishu OAuth, token sync, adapters
│   ├── queue/                 # L1: BunQueue `remi:cron` queue + handlers
│   ├── daemon/                # L2: agent runtime (repo checkout, prompts, skills, plugins),
│   │                          #     orchestrator (LaneScheduler), autopilot scheduler
│   ├── remi/                  # L3: core.ts hub + admin dashboard API, group/project stores
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
