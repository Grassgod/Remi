# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                          # Install dependencies
bun test                             # Run all tests (bun:test)
bun test tests/memory.test.ts        # Run single test file
bun run src/main.ts                  # Interactive CLI REPL (default)
bun run src/main.ts serve            # Daemon mode (connectors + scheduler)
```

## Architecture

Hub-and-spoke design. `Remi` (core.ts) is the hub orchestrator that routes messages between **Connectors** (input) and **Providers** (AI backends).

```
Connector → IncomingMessage → Remi → Provider.send() → AgentResponse → Connector.reply()
```

**Message flow in Remi._process():**
1. Assemble memory context via `MemoryStore.gatherContext(cwd)`
2. Resolve session (chatId → sessionId mapping for multi-turn)
3. Route to provider (with fallback on failure)
4. Append interaction to daily journal
5. Return AgentResponse

**Key interfaces** (in `*/base.ts`):
- `Provider`: `send()`, `healthCheck()`, `name` — AI backend interface
- `Connector`: `start(handler)`, `stop()`, `reply()`, `name` — input adapter interface

**Providers**: `ClaudeCLIProvider` uses Claude Code subscription via long-running subprocess with bidirectional JSONL streaming. No API key needed.

**Connectors**: `CLIConnector` (dev REPL).

**Memory**: Dual-layer markdown files at `~/.remi/memory/`. `MemoryStore` handles read/write with automatic `.versions/` backups. Hierarchical context assembly: root MEMORY.md → project memory.md → today's daily notes.

**Scheduler**: Pure async, runs heartbeat (provider health) + daily memory compaction (summarize yesterday's notes → append to long-term memory) + cleanup (old dailies/versions).

**Config**: `RemiConfig` loaded from env vars > `remi.toml` > defaults. Search path: `./remi.toml`, `~/.remi/remi.toml`.

## Conventions

- Full async/await — no threads, no sync blocking in async paths
- TypeScript strict mode
- Interfaces over class inheritance for loose coupling
- Plain objects + interfaces for data types (IncomingMessage, AgentResponse, ToolDefinition, configs)
- AsyncLock per chatId prevents race conditions in concurrent message handling
- Bun runtime, `bun:test` for testing
- `node:fs` sync APIs for memory store (file I/O), `Bun.spawn()` for subprocesses
