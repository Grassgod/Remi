# Changelog

All notable changes to Remi will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-29

First public open-source release. Remi 0.2.0 packages the Hub-and-Spoke runtime, memory system, queue pipeline, and Web Dashboard that have been used internally as a personal AI assistant.

### Core

- **Hub-and-Spoke orchestrator** (`src/core.ts`) routes `IncomingMessage` from any connector to any provider, with per-`chatId` `AsyncLock` serialization, session continuity, and automatic provider fallback.
- **`Remi` library entry** (`src/index.ts`) re-exports the public API: `Remi`, `MemoryStore`, `RemiQueueManager`, `Provider`/`Connector` interfaces, and config types.
- **`remi` CLI** with subcommands: `start`, `stop`, `restart`, `status`, `doctor`, `login`, `update`, plus internal `serve`/`chat`/`auth`/`pm2` (`src/cli/`).

### Connectors

- **CLI connector** (`src/connectors/cli.ts`) — interactive REPL for local development.
- **Feishu/Lark connector** (`src/connectors/feishu/`) — chat, streaming replies, interactive cards, mentions, reactions, threads, dynamic per-user menus, and media uploads.

### Providers

- **Claude Code CLI provider** (`src/providers/claude-cli/`) — long-running Claude Code subprocess with bidirectional JSONL streaming. Uses an existing Claude subscription; no API key required.
- **Aiden CLI provider** (`src/providers/aiden-cli/`) — alternative CLI-backed provider.

### Memory system

- **Markdown-based memory store** (`src/memory/`) following CoALA-inspired layers (semantic, episodic, procedural, working).
- Automatic `.versions/` backups on every write.
- **Link graph** (`src/memory/link-graph.ts`) for `[[entity]]` cross-references and backlink queries.
- **MCP server** (`src/memory/mcp-server.ts`) exposing `recall`, `remember`, and `backlinks` to any MCP-compatible agent.

### Queue and scheduler

- **BunQueue task pipeline** (`src/queue/`) — durable handlers for conversation persistence, memory extraction, mission execution, and skill reports.
- **Unified `[[cron.jobs]]` config** with `cron`/`every`/`at` triggers, per-job timeouts, one-shot deletion, and arbitrary handler config.
- **Scheduled skills pipeline** (`pipeline/skills/`) — daily changelog, mission summary, release notes, contract eval, RFC, intake.

### Storage

- **SQLite** for sessions (`src/db/sessions.ts`), conversations, and metrics, with a custom SQLite loader (`src/db/sqlite-custom.ts`) for `sqlite-vec` compatibility on macOS.
- **Vector store** (`src/db/vector-store.ts`) with pluggable embeddings (Voyage, OpenAI-compatible).

### Web

- **Hono API server** (`web/server.ts`) for dashboard endpoints.
- **React + Vite + Tailwind dashboard** (`web/frontend/`) — conversations, missions, memory entities, traces, queue health, mission board.
- **Mission board** (`web/board/`) for long-running mission tracking.

### Auth and integrations

- **Feishu OAuth** + **ByteDance SSO** adapters (`src/auth/`).
- **Token sync rules** to distribute access tokens to external tools.
- **Bot menu config** for Feishu千人千面 (per-user) menus.

### Remote agents

- **Memory-audit, memory-extract, wiki-curate** child-agent definitions under `agents/`, executed as scoped Claude Code subprocesses with context injection.

### Operations

- **PM2 ecosystem** generation from `[[services]]` config (`src/pm2.ts`).
- **Tracing** (`src/tracing.ts`) with daily log/trace directories and configurable retention.
- **Metrics collector** (`src/metrics/`) for provider and conversation health.
- **One-click installer** at `scripts/install.sh`.

### Build and tooling

- **`bun run build`** with optional JavaScript obfuscation for releases.
- **`bun:test`** suite covering core routing, providers, memory, queue, vector recall, JSONL protocol, and process management.
- **TypeScript strict mode** throughout, full async/await, interfaces over inheritance.

[0.2.0]: https://github.com/grasscoder/remi/releases/tag/v0.2.0
