# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
uv sync                              # Install dependencies
uv sync --extra feishu --extra dev   # Install with all extras
pytest tests                         # Run all tests (asyncio_mode=auto)
pytest tests/test_memory.py -x       # Run single test file, stop on first failure
ruff check .                         # Lint
ruff format .                        # Format
python -m remi                       # Interactive CLI REPL (default)
python -m remi serve                 # Daemon mode (connectors + scheduler)
```

## Architecture

Hub-and-spoke design. `Remi` (core.py) is the hub orchestrator that routes messages between **Connectors** (input) and **Providers** (AI backends).

```
Connector → IncomingMessage → Remi → Provider.send() → AgentResponse → Connector.reply()
```

**Message flow in Remi._process():**
1. Assemble memory context via `MemoryStore.read_with_ancestors(project)`
2. Resolve session (chat_id → session_id mapping for multi-turn)
3. Route to provider (with fallback on failure)
4. Append interaction to daily journal
5. Return AgentResponse

**Key protocols** (runtime_checkable, in `*/base.py`):
- `Provider`: `send()`, `health_check()`, `name` — AI backend interface
- `Connector`: `start(handler)`, `stop()`, `reply()`, `name` — input adapter interface

**Providers**: `ClaudeCLIProvider` uses Claude Code subscription via long-running subprocess with bidirectional JSONL streaming. No API key needed.

**Connectors**: `CLIConnector` (dev REPL), `FeishuConnector` (Feishu IM, optional).

**Memory**: Dual-layer markdown files at `~/.remi/memory/`. `MemoryStore` handles read/write with automatic `.versions/` backups. Hierarchical context assembly: root MEMORY.md → project MEMORY.md → today's daily notes.

**Scheduler**: Pure asyncio, runs heartbeat (provider health) + daily memory compaction (summarize yesterday's notes → append to long-term memory) + cleanup (old dailies/versions).

**Config**: `RemiConfig` loaded from env vars > `remi.toml` > defaults. Search path: `./remi.toml`, `~/.remi/remi.toml`.

## Conventions

- Full async/await — no threads, no sync blocking
- `from __future__ import annotations` in every file
- `TYPE_CHECKING` blocks for circular imports
- Protocols over inheritance for loose coupling
- Dataclasses for all data types (`IncomingMessage`, `AgentResponse`, `ToolDefinition`, configs)
- Lane locks per chat_id prevent race conditions in concurrent message handling
- Python 3.10+, ruff line-length 100
