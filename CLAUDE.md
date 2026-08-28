# CLAUDE.md

> **Agent 权威指令：** 请先阅读 [`AGENTS.md`](./AGENTS.md)。
> 新增或更新 Agent 规则时只维护 `AGENTS.md`，不要在本文件中重复。

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                                # Install dependencies (single root bun workspace)
bun test                                   # Run all backend tests (bun:test; bunfig root = tests/)
bun test tests/unit/daemon/agent-runtime-send-options.test.ts  # Run single test file
bunx tsc --noEmit                          # Backend typecheck
bun run apps/remi/main.ts start             # Multiremi daemon + configured Feishu channel
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
2. Resolve the `MULTIREMI_BOT_AGENT_ID` row through daemon registration/heartbeat
3. Assemble cwd, provider, prompt, tools, env, args, MCP, and thinking from that agent row
4. Run an ACP `AgentSession`, record token metrics, and return `AgentResponse`

**Key interfaces**:
- `Provider` (`packages/contracts/src/provider-types.ts`): `send()`, `healthCheck()`, `name`
- `Connector` (`packages/connectors/src/base.ts`): `start(handler, streamHandler)`, `stop()`, `reply()`, `name`

**Providers**: one `AcpProvider` (`packages/acp/src/provider.ts`) speaking ACP over stdio to an
agent bridge; per-agent behavior lives in `packages/acp/src/adapters/{claude-code,codex}`.
Registered as `acp:claude` / `acp:codex`. Uses your Claude Code / Codex subscription — no API key.

**Connectors**: `FeishuConnector` (Feishu/Lark — cards, streaming, threads, menus).

**Memory**: Multiremi project memory is authoritative. Agents use the canonical `remi memory`
commands (`recall`, `remember`, `get`, `update`, `forget`, `backlinks`) over the Multiremi API.
Legacy files under `~/.remi/memory/` are migration input only: runtime code neither reads nor
deletes them. See `docs/migrations/remi-memory-to-multiremi.md`.

**Scheduler**: `MultiremiScheduler` (`packages/daemon/src/scheduler.ts`) owns autopilot cron
triggers and failure monitoring. Remi has no separate local queue.

**Config**: ACP execution has one source of truth: the `multiremi_agents` row selected by
`MULTIREMI_BOT_AGENT_ID`. Its `instructions`, provider/model/executable, cwd, tools, custom env,
custom args, MCP config, thinking level, and concurrency limit feed the persistent Remi lane.
`RemiConfig` remains temporarily for connector/auth/plugin/menu/tracing settings in
`~/.remi/remi.db`; it is not an execution-config fallback. There is no `remi.toml`.

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
- `Bun.spawn()` for subprocesses; keep sync file I/O out of async hot paths
