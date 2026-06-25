# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                          # Install dependencies
bun test                             # Run all tests (bun:test)
bun test tests/memory.test.ts        # Run single test file
bun run src/main.ts serve            # Daemon mode (connectors + scheduler)
```

## Architecture

Hub-and-spoke design. `Remi` (core.ts) is the hub orchestrator that routes messages between **Connectors** (input) and **Providers** (AI backends).

```
Connector → IncomingMessage → Remi → Provider.send() → AgentResponse → Connector.reply()
```

**Message flow in Remi._process():**
1. Resolve session (chatId → sessionId mapping for multi-turn)
2. Route to provider (with fallback on failure)
3. Append interaction to daily journal
4. Return AgentResponse

**Key interfaces** (in `*/base.ts`):
- `Provider`: `send()`, `healthCheck()`, `name` — AI backend interface
- `Connector`: `start(handler)`, `stop()`, `reply()`, `name` — input adapter interface

**Providers**: `ClaudeCLIProvider` uses Claude Code subscription via long-running subprocess with bidirectional JSONL streaming. No API key needed.

**Connectors**: `FeishuConnector` (Feishu/Lark — cards, streaming, threads, menus).

**Memory**: Dual-layer markdown files at `~/.remi/memory/`. `MemoryStore` handles read/write with automatic `.versions/` backups. Context is loaded natively by Claude Code via CLAUDE.md + MEMORY.md; recall MCP tool provides on-demand search.

**Scheduler**: Pure async, runs heartbeat (provider health) + daily memory compaction (summarize yesterday's notes → append to long-term memory) + cleanup (old dailies/versions).

**Config**: `RemiConfig` loaded from env vars > `remi.toml` > defaults. Search path: `./remi.toml`, `~/.remi/remi.toml`.

## Debugging Principles

- **先有证据再修复**：遇到生产问题时，不要基于推测直接改代码。先加诊断日志定位根因，确认后再修复。
- **不要用 REMI_DEBUG**：该环境变量会导致崩溃，不要建议启用。
- **重放测试**：`bun run tests/manual/replay-fixture.ts <name>` 可以重放 ACP fixture 到真实飞书卡片，用于验证渲染逻辑。`bun run tests/replay-coverage.ts` 跑覆盖率。

## Conventions

- Full async/await — no threads, no sync blocking in async paths
- TypeScript strict mode
- Interfaces over class inheritance for loose coupling
- Plain objects + interfaces for data types (IncomingMessage, AgentResponse, ToolDefinition, configs)
- AsyncLock per chatId prevents race conditions in concurrent message handling
- Bun runtime, `bun:test` for testing
- `node:fs` sync APIs for memory store (file I/O), `Bun.spawn()` for subprocesses
