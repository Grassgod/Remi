# Multimira backend: Go → Bun rewrite

Rewrite the Go backend (`../server`, ~119k lines of non-test Go) into Bun/TypeScript,
and collapse the 12 native agent backends into **one unified ACP agent layer**
(referencing Remi's `src/providers/acp`).

## Strategy

Incremental, module-by-module. The Go `../server` stays as the reference
implementation + parity oracle until each module reaches behavior parity.
Start from the **agent/ACP layer** — it is the keystone of "12 backends → 1 ACP"
and is directly reusable from Remi.

## Dependency mapping (Go → Bun)

| Go | Bun/TS |
| --- | --- |
| `chi` router | Hono |
| `pgx` + `sqlc` | `postgres` (postgres.js) + Drizzle |
| `gorilla/websocket` | `Bun.serve` WebSocket |
| `golang-jwt` | `jose` |
| `aws-sdk-go-v2` (S3/Secrets) | `@aws-sdk/client-s3` / `client-secrets-manager` |
| codex `app-server` (native) | **`codex-acp` over ACP** |
| claude `stream-json` (native) | **`claude-agent-acp` over ACP** |
| daemon (goroutines/channels) | Bun async + workers |

## Status

- [x] **Chunk 1 — ACP core.** Ported `protocol.ts`, `client.ts`, and adapters
      (`base`/`claude`/`codex`/`index`) from Remi. `tsc --noEmit` clean, loads in Bun.
- [x] **Chunk 2 — AcpProvider + agent interface.** `src/agent/types.ts` (one
      `AgentBackend` contract: Execute → async-generator of events + result);
      lean `AcpProvider` driving any ACP agent via the ported client; mock-ACP
      smoke test passing (`bun test` 2/2). **The 12 Go backends now collapse to
      one ACP-driven provider.**
- [x] **Chunk 3 — HTTP shell.** Hono app (`src/http/app.ts`), config loader,
      JWT auth via jose (HS256, JWT_SECRET — wire-compatible with Go so tokens
      interoperate), bearer+cookie auth gate, `/health` + `/api/me`, `main.ts`
      Bun.serve entry. `bun test` 9/9. Feishu SSO handler lands with Chunk 5.
- [x] **Chunk 4 — DB layer.** Drizzle schema (user/workspace/member) + postgres.js
      client, the typed sqlc replacement. Verified with a real insert->select->delete
      round-trip against the live pgvector container (bun test 10/10). Remaining
      tables/queries port incrementally alongside their handlers.
- [~] **Chunk 5 — Handlers.** Auth done: Feishu SSO routes (TS port of auth_lark.go)
      + findOrCreateUser (Drizzle) + domain gating, wired into the Hono app,
      verified incl. live-DB round-trip (bun test 13/13). Remaining: issues /
      projects / workspaces / agents / inbox / … (the 31.7k-line bulk).
- [ ] **Chunk 6 — Daemon.** claim loop (WS wakeup + HTTP fallback), repocache,
      git worktrees, per-task CODEX_HOME.
- [ ] **Chunk 7 — Integrations & jobs.** Lark chatops, autopilots, scheduler,
      realtime hub.
- [ ] **Chunk 8 — Tests & parity.** Port/recreate tests; verify against Go server.

## Scale note

This is a multi-session effort. ~119k lines of production Go + ~102k lines of
tests. Each chunk lands typecheck-clean and incrementally verifiable; the Go
server remains runnable as the reference throughout.
