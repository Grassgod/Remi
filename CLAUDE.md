# CLAUDE.md

> **Agent 权威指令：** 请先阅读 [`AGENTS.md`](./AGENTS.md)。
> 新增或更新 Agent 规则时只维护 `AGENTS.md`，不要在本文件中重复。

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                                # Install dependencies (single root bun workspace)
bun test                                   # Run all backend tests (bun:test; bunfig root = tests/)
bun test tests/unit/memory/memory.test.ts  # Run single test file
bunx tsc --noEmit                          # Backend typecheck
bun run apps/remi/main.ts serve            # Feishu-connector daemon (connectors + queue + admin UI)
cd frontend && bun run test                # Frontend Vitest suites (see TESTING.md)
```

## Architecture

Two products share one bun workspace:

- **Remi** — the chat agent. Hub-and-spoke: `packages/remi/src/core.ts` routes messages
  between **Connectors** (input) and **Providers** (AI backends). Entry: `apps/remi/main.ts`.
- **Multiremi** — the server/daemon platform. `packages/server` (Hono API + SQLite/Postgres
  store, served by `apps/server/main.ts`), `packages/daemon` (agent runtime, orchestrator,
  autopilot scheduler), `frontend/` (Next.js dashboard). The `remi` CLI is a client of it.

```
Connector → IncomingMessage → Remi → AcpProvider (ACP session) → ProviderEvent* → Connector.reply()
```

**Message flow** (`core.ts` `_process()` → `core/message-stream.ts` `processStream()`):
1. Resolve session key (chatId → sessionId, persisted in `~/.remi/remi.db`)
2. Assemble runtime config (cwd, provider, group policy) and run an ACP `AgentSession`
3. Append the interaction to the daily journal + record token metrics
4. Return AgentResponse

**Key interfaces**:
- `Provider` (`packages/contracts/src/provider-types.ts`): `send()`, `healthCheck()`, `name`
- `Connector` (`packages/connectors/src/base.ts`): `start(handler, streamHandler)`, `stop()`, `reply()`, `name`

**Providers**: one `AcpProvider` (`packages/acp/src/provider.ts`) speaking ACP over stdio to an
agent bridge; per-agent behavior lives in `packages/acp/src/adapters/{claude-code,codex}`.
Registered as `acp:claude` / `acp:codex`. Uses your Claude Code / Codex subscription — no API key.

**Connectors**: `FeishuConnector` (Feishu/Lark — cards, streaming, threads, menus).

**Memory**: markdown files under `~/.remi/memory/` (`MEMORY.md`, `daily/`, entity files).
`MemoryStore` (`packages/memory/src/store.ts`) writes through `.versions/` backups, pruned to the
newest 10 per file on each write. The MCP server (`packages/memory/src/mcp-server.ts`) exposes
`recall` / `remember` / `backlinks` for on-demand search.

**Schedulers** (two, unrelated):
- `remi:cron` BunQueue (`packages/queue`) — `builtin:heartbeat` (provider health, auth token
  refresh, usage quota), `builtin:pulse`, `skill:gen|push|run`.
- `MultiremiScheduler` (`packages/daemon/src/scheduler.ts`) — autopilot cron triggers + failure monitor.

Neither prunes `~/.remi/memory`: `.versions/` retention happens on each backup write, and
`MemoryStore.cleanupOldDailies()` / `cleanupOldVersions()` have no production caller.

**Config**: `RemiConfig` lives in SQLite (`remi_config` table in `~/.remi/remi.db`), loaded by
`loadConfig()` with env-var overrides (`REMI_*`, `FEISHU_*`). `remi login` writes it. There is no
`remi.toml` anymore.

## Debugging Principles

- **先有证据再修复**：遇到生产问题时，不要基于推测直接改代码。先加诊断日志定位根因，确认后再修复。
- **不要用 REMI_DEBUG**：该环境变量会导致崩溃，不要建议启用。
- **重放测试**：`bun run tests/manual/replay-fixture.ts <name>` 可以重放 `tests/fixtures/acp/` 里的 ACP fixture 到真实飞书卡片，用于验证渲染逻辑。`bun run replay:coverage`（= `tests/integration/replay-coverage.ts`）跑覆盖率。

## Conventions

- Full async/await — no threads, no sync blocking in async paths
- TypeScript strict mode
- Interfaces over class inheritance for loose coupling
- Plain objects + interfaces for data types (IncomingMessage, AgentResponse, ToolDefinition, configs)
- `LaneScheduler` (`packages/daemon/src/orchestrator.ts`) serializes each session key via a
  per-lane `AsyncLock`, so concurrent messages in one chat never interleave
- Bun runtime, `bun:test` for testing
- `node:fs` sync APIs for memory store (file I/O), `Bun.spawn()` for subprocesses
