# Remi ACP Codex via codex-acp

## Goal

Reuse an existing ACP-compatible Codex agent such as `codex-acp` instead of
building a Remi-side Codex app-server adapter.

Target runtime path:

```text
Feishu
  -> Remi FeishuConnector
  -> Remi AcpProvider(agentType="codex")
  -> codex-acp over ACP stdio
  -> Codex
```

This keeps Remi's current ACP provider, session pool, streaming card renderer,
permission UI, `/switch codex` entry, and tracing path. Remi only needs thin
agent-selection and Codex event interpretation fixes.

## Current Code Evidence

The repository is already close to this shape:

| Area | Evidence | Current state |
| --- | --- | --- |
| Provider construction | `src/core.ts` `_buildProvider()` accepts `acp:codex` | Remi can instantiate `AcpProvider({ agentType: "codex" })` |
| Runtime switch | `src/switch-mode.ts` maps `codex` to `acp:codex` | P2P `/switch codex` route exists |
| ACP provider | `src/providers/acp/provider.ts` delegates behavior to `createAdapter(agentType)` | Generic enough for another ACP server |
| Codex adapter | `src/providers/acp/adapters/codex.ts` | Stub only; default executable is `codex-acp` |
| Feishu renderer | `src/connectors/feishu/index.ts` uses `createAdapter("claude")` | Blocks Codex-specific tool/input parsing |
| Health check | `src/providers/acp/provider.ts` runs `claude --version` | Incorrect for `acp:codex` |

## Non-goals

- Do not implement a direct `codex app-server` client in Remi.
- Do not add a Remi-owned `remi-codex-agent-acp` bridge unless `codex-acp`
  is proven incompatible.
- Do not change Claude ACP behavior beyond making shared code agent-aware.
- Do not remove `claude_cli`; it remains the rollback path.

## Proposed Changes

### 1. Agent-aware executable and health check

Keep `CodexAdapter.defaultExecutable()` returning `codex-acp` unless local
verification shows a different command name.

Update `AcpProvider.healthCheck()` to resolve and execute the configured ACP
agent executable by `agentType`:

- `acp:claude`: current Claude wrapper or `claude-agent-acp`.
- `acp:codex`: `provider.executable` or `codex-acp`.

The check should avoid sending a prompt; a lightweight `--version` or spawn
existence check is enough for scheduled heartbeat.

### 2. Pass agent type into streaming consumers

Extend `StreamMeta` with one of:

```ts
providerName?: string | null;
agentType?: string | null;
```

In `Remi.handleMessageStream()`, after selecting the provider, populate this
metadata. For `AcpProvider`, prefer `provider.adapter.agentType`.

Then replace the Feishu hardcode:

```ts
createAdapter("claude")
```

with the selected ACP agent type, defaulting to `claude` for compatibility.

### 3. Complete the Codex adapter for display-level semantics

Keep the Codex adapter shallow. It does not need to understand app-server.
It only needs to interpret ACP `SessionUpdate` objects emitted by `codex-acp`.

Minimum behavior:

- Resolve tool names from known Codex ACP metadata if present.
- Fall back to `kind` + `title` mappings:
  - `execute` -> `Bash`
  - `read` -> `Read`
  - `edit` -> `Edit`
  - `search` -> `Grep` or `Search`
  - `fetch` -> `WebFetch`
  - `think` -> `Think`
- Extract structured input from `rawInput`, including JSON strings.
- Reconstruct file path from `locations`.
- Reconstruct command from `title` for execute events.
- Extract text, diff path, terminal output, and raw output as result previews.

Do not add Remi-side tool execution. `codex-acp` owns execution.

### 4. Permission flow compatibility

Use Remi's existing `session/request_permission` handler unchanged where
possible. Required verification:

- Codex tool approval options are presented in Feishu.
- Selecting allow/reject returns an ACP `selected` or `cancelled` outcome that
  `codex-acp` accepts.
- If `codex-acp` uses option names that differ from Claude, update only
  option-selection helpers, not provider architecture.

`AskUserQuestion` and `ExitPlanMode` are Claude-specific until a Codex ACP
fixture proves equivalent behavior.

### 5. Configuration

Recommended local config:

```toml
[provider]
name = "acp:codex"
# executable = "/absolute/path/to/codex-acp"
# model = "gpt-5.4"
```

P2P switch:

```text
/switch codex
```

Rollback:

```toml
[provider]
name = "acp:claude"
```

or:

```toml
[provider]
name = "claude_cli"
```

Current local prerequisite status:

- `command -v codex-acp` returned no path in this workspace shell.
- `npm view @agentclientprotocol/codex-acp` resolves package version `0.0.43`
  with bin `codex-acp` in the current registry.
- Before implementation smoke tests, install `codex-acp` or set
  `REMI_CODEX_AGENT_ACP_EXECUTABLE` / `[provider].executable` to an absolute
  path for the ACP-compatible Codex server.

## Implementation Plan

1. Verify the external ACP agent command:
   - `npm install -g @agentclientprotocol/codex-acp`
   - `command -v codex-acp`
   - `codex-acp --version`
   - optional smoke: start it and send ACP `initialize`.
2. Patch health check:
   - make `AcpProvider.healthCheck()` agent-aware.
   - add unit coverage for Claude and Codex executable resolution.
3. Patch stream metadata:
   - add `agentType` or `providerName` to `StreamMeta`.
   - pass selected provider metadata from `Remi.handleMessageStream()`.
   - update Feishu connector to create the matching adapter.
4. Complete `CodexAdapter` display parsing:
   - raw input JSON parsing.
   - title/kind fallback tool name mapping.
   - result preview extraction.
5. Add fixtures and tests:
   - unit tests for Codex adapter.
   - a fake ACP Codex server fixture for `AcpProvider` if `codex-acp` is not
     available in CI.
6. Run e2e smoke locally with real `codex-acp`.
7. Update `remi.toml.example` with an ACP Codex example.

## Acceptance Criteria

The goal is done when all of these pass:

- `name = "acp:codex"` starts Remi without attempting `claude --version`.
- `/switch codex` selects `acp:codex` and clears the old provider session.
- A simple prompt returns streamed `agent_message_chunk` content in Feishu.
- A read-file prompt shows a readable `Read` step with file path.
- A shell prompt shows a readable `Bash` step with command.
- A file-edit prompt shows an `Edit` or `Write` step with path and diff preview.
- A permission request renders in Feishu and allow/reject reaches `codex-acp`.
- `/esc` cancels the active Codex turn and clears the Remi session process.
- Session resume works for at least one follow-up turn.
- Existing Claude ACP tests still pass.

## Verification Commands

```bash
bun test tests/providers.test.ts
bun test tests/switch-mode.test.ts
bun test tests/feishu-card.test.ts
```

Manual smoke:

```bash
REMI_PROVIDER=acp:codex REMI_DEBUG=1 bun run src/main.ts serve
```

Then test from Feishu:

```text
/switch codex
你好
读取当前项目的 package.json
运行 pwd
修改一个临时文件
/esc
```

## Risk Register

| Risk | Mitigation |
| --- | --- |
| `codex-acp` emits non-Claude tool metadata | Keep Codex parsing in `CodexAdapter`; add fixtures from real runs |
| `codex-acp` permission outcomes differ | Normalize in permission option helpers after observing fixture |
| `codex-acp` session resume IDs differ from Claude | Treat session IDs as provider-specific; existing `/switch` already clears provider sessions |
| Heartbeat starts a heavy Codex process | Prefer executable existence or `--version` check |
| Feishu cards depend on Claude tool names | Map Codex events into Remi's display tool vocabulary |

## Decision

Proceed with `codex-acp` as the ACP server boundary. Remi should not implement
Codex app-server directly for this integration.
