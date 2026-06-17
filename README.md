# Remi

> A personal AI assistant platform built on Bun — your AI lives in chat, remembers what matters, and grows with you.

Remi is an extensible AI assistant runtime that connects modern LLM agents (Claude Code, and pluggable backends) to the messengers and tools you already use. Unlike a stateless chatbot, Remi maintains a structured, file-based memory of your work, relationships, and decisions, and orchestrates long-running missions through a queue-driven scheduler. It is designed to be self-hosted, hackable, and to scale from a single process on your laptop to a full daemon serving Feishu/Lark groups with a Web Dashboard.

## Highlights

- **Hub-and-Spoke orchestration** — A single `Remi` core (`src/core.ts`) routes messages between any **Connector** (input adapter) and any **Provider** (AI backend). Per-chat async locks serialize concurrent traffic without blocking unrelated lanes.
- **Markdown-based memory (CoALA-inspired)** — Persistent memory stored as plain Markdown under `~/.remi/memory/`, organized into semantic, episodic, procedural, and working layers. Versioned automatically, queryable through MCP tools, and human-readable on disk.
- **Multi-connector by design** — Ships with a full Feishu/Lark connector (cards, streaming, mentions, reactions, threading, dynamic menus). The `Connector` interface is a small surface — Slack, Discord, or HTTP webhooks fit the same shape.
- **Multi-provider backends** — Claude Code CLI provider (uses your Claude subscription via long-running subprocess + JSONL streaming, no API key required) and an Aiden CLI provider, behind a 3-method `Provider` interface. Plug in any LLM by implementing `send`, `healthCheck`, and `name`.
- **BunQueue task pipeline** — Durable queues for conversation persistence, memory extraction, scheduled missions, and cron jobs. One unified `[[cron.jobs]]` config drives heartbeats, daily compaction, skill reports, and one-shot agents.
- **SvelteKit-style Web Dashboard** — A React + Vite + Tailwind dashboard (`web/frontend/`) backed by a Hono API (`web/server.ts`) for inspecting conversations, missions, memory entities, traces, and queue health.
- **MCP server included** — A built-in Model Context Protocol server (`src/mcp/memory-server.ts`) exposes `recall`, `remember`, and `backlinks` so any MCP-compatible agent can read and write your memory graph.
- **SQLite + sqlite-vec** — Conversations, sessions, and metrics live in SQLite. Vector search over memory uses `sqlite-vec` with pluggable embedding providers (Voyage, OpenAI-compatible).
- **Remote agent system** — Spawn child agents (Claude Code subprocesses) with scoped context injection for long-running, isolated tasks (memory audits, daily briefings, retro reports).

## Architecture

```
                           ┌─────────────────────────────────────────┐
                           │              Remi (core.ts)             │
   ┌─────────────┐         │                                         │         ┌──────────────┐
   │ Connectors  │ ──IM──▶ │  Lane Lock → Session → Memory → Route   │ ──send─▶│  Providers   │
   │             │         │                                         │         │              │
   │ • Feishu    │         │   ┌─────────┐  ┌─────────┐ ┌─────────┐  │         │ • Claude CLI │
   │ • (Slack…)  │ ◀─reply─│   │ Memory  │  │  Queue  │ │ Tracing │  │ ◀─resp──│ • Aiden CLI  │
   │ • (HTTP…)   │         │   │  Store  │  │ BunQueue│ │ +Metrics│  │         │ • (custom)   │
   └─────────────┘         │   └────┬────┘  └────┬────┘ └─────────┘  │         └──────────────┘
                           └────────┼────────────┼───────────────────┘
                                    │            │
                                    ▼            ▼
                          ~/.remi/memory/   ~/.remi/queue/
                          (Markdown +       (durable jobs:
                           sqlite-vec)       cron, missions,
                                             memory extract)

                           ┌─────────────────────────────────────────┐
                           │  Web Dashboard (web/)  •  MCP Server    │
                           │  Hono API + React UI   •  recall/remember
                           └─────────────────────────────────────────┘
```

Message flow inside `Remi._process()`:

1. **Resolve session** — `chatId` → `sessionId` (multi-turn continuity).
2. **Acquire lane lock** — per-chat `AsyncLock` prevents interleaved replies.
3. **Route to provider** — primary provider with optional fallback on failure.
4. **Persist** — append interaction to daily journal; enqueue conversation/memory tasks.
5. **Reply** — `AgentResponse` returned via the originating connector.

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

### Run as a daemon (connectors + scheduler)

```bash
# 1. Generate a config file interactively
bun run src/main.ts login

# 2. Start the production daemon (connectors, queue, cron, web)
bun run src/main.ts start

# 3. Check status
bun run src/main.ts status
bun run src/main.ts doctor
```

`remi start` uses PM2 under the hood and brings up every service declared under `[[services]]` in `remi.toml`, including the Web Dashboard if configured.

## Configuration

Remi loads configuration in this priority order:

1. Environment variables (e.g. `REMI_PROVIDER`, `FEISHU_APP_ID`, `REMI_MEMORY_DIR`)
2. `./remi.toml` in the working directory
3. `~/.remi/remi.toml`
4. Built-in defaults

A minimal example is shipped at `src/cli/template.toml`:

```toml
[feishu]
app_id = ""
app_secret = ""
domain = "feishu"   # or "lark"

# [proxy]
# http = "http://proxy:8118"
# no_proxy = "localhost,127.0.0.1"

# [google]                # Optional: image generation
# api_key = ""

# [embedding]             # Optional: vector search
# provider = "voyage"
# api_key = ""

# [[services]]            # Optional: PM2-managed services
# name = "remi-web"
# script = "web/server.ts"
# interpreter = "bun"
# cwd = "/path/to/remi"
# port = 6120

# [[cron.jobs]]           # Optional: scheduled jobs
# id = "daily-briefing"
# handler = "skill:gen"
# cron = "0 8 * * *"
```

The full schema lives in `src/config.ts` (`RemiConfig` interface). `remi login` walks through the most common settings and writes a working `remi.toml` for you.

## Development

```bash
# Clone and install
git clone https://github.com/grasscoder/remi.git
cd remi
bun install

# Run all tests
bun test

# Run a single test file
bun test tests/memory.test.ts

# Develop the Web Dashboard frontend
cd web/frontend && bun install && bun run dev

# Build a distributable bundle
bun run build         # with obfuscation (release)
bun run build:dev     # without obfuscation
```

Conventions:

- **TypeScript strict mode** everywhere.
- **Full async/await** — no sync blocking in async paths; `Bun.spawn()` for subprocesses; `node:fs` sync APIs only inside the memory store.
- **Interfaces over inheritance** — Providers and Connectors are small interfaces, not class hierarchies.
- **Plain data types** — `IncomingMessage`, `AgentResponse`, `ToolDefinition` are interfaces, not classes.
- **Per-`chatId` `AsyncLock`** to serialize a single conversation while keeping lanes independent.

## Project Structure

```
remi/
├── src/
│   ├── core.ts                # Hub orchestrator (the heart, ~46KB)
│   ├── main.ts                # CLI entry point
│   ├── config.ts              # remi.toml + env loader
│   ├── connectors/            # Input adapters
│   │   ├── base.ts            #   Connector interface
│   │   ├── cli.ts             #   Interactive REPL
│   │   └── feishu/            #   Feishu/Lark (chat, cards, streaming, menus)
│   ├── providers/             # AI backends
│   │   ├── base.ts            #   Provider interface
│   │   ├── claude-cli/        #   Claude Code subprocess provider
│   │   └── aiden-cli/         #   Aiden CLI provider
│   ├── memory/                # Markdown memory store + link graph
│   ├── queue/                 # BunQueue task pipeline + handlers
│   ├── mcp/                   # MCP server (recall / remember / backlinks)
│   ├── db/                    # SQLite + sqlite-vec (sessions, conversations, vectors)
│   ├── auth/                  # Feishu OAuth, ByteDance SSO, token sync
│   ├── mission/               # Long-running mission state
│   ├── group/, project/       # Group + project profile stores
│   ├── tracing.ts             # Distributed tracing
│   ├── metrics/               # Conversation + provider metrics
│   └── cli/                   # `remi` subcommands (start/stop/login/doctor/…)
├── web/
│   ├── server.ts              # Hono API server
│   ├── frontend/              # React + Vite + Tailwind dashboard
│   ├── board/                 # Mission board views
│   └── handlers/              # API route handlers
├── agents/                    # Remote child-agent definitions
│   ├── memory-audit/
│   ├── memory-extract/
│   └── wiki-curate/
├── pipeline/skills/           # Scheduled skills (daily briefing, retro, …)
├── scripts/                   # Build, install, migration scripts
├── tests/                     # bun:test specs
└── docs/                      # Design notes and specs
```

## License

[MIT](LICENSE) © 2024-2026 Huajie He and contributors.
