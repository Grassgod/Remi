# Contributing to Remi

Thanks for your interest in Remi! This guide covers everything you need to set up a development environment, follow our conventions, and extend the platform with new connectors, providers, or skills.

## Requirements

- **[Bun](https://bun.sh) 1.0+** — Remi's runtime, package manager, test runner, and bundler.
- **SQLite** — Used for sessions, conversations, metrics, and vector search. Bun's built-in `bun:sqlite` is sufficient on most systems; macOS users may need a custom SQLite for `sqlite-vec` (handled automatically by `src/db/sqlite-custom.ts`).
- **Git** — For source control.
- **Optional**: [Claude Code CLI](https://docs.claude.com/claude-code) signed in if you plan to test the default provider locally.

## Development workflow

### 1. Fork and clone

```bash
git clone https://github.com/<your-username>/remi.git
cd remi
git remote add upstream https://github.com/grasscoder/remi.git
```

### 2. Install and verify

```bash
bun install
bun test
```

All tests should pass on a fresh clone. If they don't, please open an issue before starting work.

### 3. Create a topic branch

```bash
git checkout -b feat/your-feature
# or
git checkout -b fix/short-description
```

### 4. Code, test, iterate

```bash
# Run a single test file
bun test tests/memory.test.ts

# Watch mode (re-run on save)
bun test --watch

# Run the daemon locally (connectors + scheduler)
bun run src/main.ts serve

# Develop the Web Dashboard
cd web/frontend && bun run dev
```

### 5. Open a Pull Request

- Push your branch to your fork.
- Open a PR against `main` on `grasscoder/remi`.
- Describe **what** changed and **why**, link any related issues, and include a short test plan.
- Keep PRs focused — one logical change per PR. Refactors and feature work should be separate.

## Code style

- **TypeScript strict mode.** Do not weaken `tsconfig.json`. Prefer narrow types over `any`.
- **Async/await throughout.** Never block the event loop in an async path. Use `Bun.spawn()` for subprocesses.
- **Interfaces over inheritance.** New backends should implement an existing interface (`Provider`, `Connector`, queue handler) rather than extend a base class.
- **Plain data objects.** Message payloads, configs, and tool definitions are interfaces — no constructors, no classes for data.
- **Comments are rare.** Names should explain *what*. Comments are reserved for non-obvious *why* — invariants, workarounds, hidden constraints.
- **No dead code.** If you remove a feature, remove its tests, types, and docs in the same PR.
- **File layout.** Keep modules under ~500 lines where possible. Split by responsibility, not by file-size limit.

Lint and format are enforced through `bun test` and review. There is no separate formatter step; match the surrounding style.

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

Common types:

- `feat:` — new user-facing feature
- `fix:` — bug fix
- `refactor:` — non-behavioral change
- `perf:` — performance improvement
- `docs:` — documentation only
- `test:` — tests only
- `chore:` — tooling, deps, build
- `revert:` — revert a prior commit

Examples:

```
feat(connectors): add Slack connector with thread support
fix(memory): handle missing frontmatter in legacy notes
docs(readme): update Quick Start for Bun 1.2
```

Keep the subject line under 72 characters. Use the body to explain the *why* when it isn't obvious from the diff.

## Testing expectations

- New code paths need tests under `tests/`. Use `bun:test`.
- Unit-test the public surface of new connectors, providers, and queue handlers.
- For changes that touch the memory store or the message router, exercise the relevant flow end-to-end (see `tests/core.test.ts` and `tests/memory.test.ts` for patterns).
- Tests must run offline. Mock external services; don't hit the network.

## Extending Remi

### Add a new Connector

A connector is anything that turns external events into `IncomingMessage` and dispatches `AgentResponse` back. Implement `src/connectors/base.ts`:

```ts
export interface Connector {
  name: string;
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
  reply(message: IncomingMessage, response: AgentResponse): Promise<void>;
}
```

Steps:

1. Create `src/connectors/<your-connector>/index.ts` exporting a class that implements `Connector`.
2. Translate inbound events into `IncomingMessage` (set `chatId`, `userId`, `content`, optional `threadId`, `mentioned`).
3. Register the connector in `src/core.ts` where other connectors are wired up, and add config under a new section in `src/config.ts`.
4. Add a unit test under `tests/` that drives the connector with a fake transport and asserts `IncomingMessage` shape.
5. Document the new TOML section in `README.md` and `src/cli/template.toml`.

The Feishu connector (`src/connectors/feishu/`) is the reference implementation. It covers cards, streaming replies, mentions, reactions, threading, and dynamic menus — copy patterns from there.

### Add a new Provider

A provider is an AI backend. Implement `src/providers/base.ts`:

```ts
export interface Provider {
  name: string;
  send(message: IncomingMessage, ctx: ProviderContext): Promise<AgentResponse>;
  healthCheck(): Promise<boolean>;
}
```

Steps:

1. Create `src/providers/<your-provider>/index.ts` and `provider.ts`.
2. Map `IncomingMessage` + context (memory, session, tools) into your backend's request format.
3. Stream or batch the response back as an `AgentResponse`.
4. Register the provider in `src/core.ts` and accept it in `RemiConfig.provider.name`.
5. Test with a recorded protocol fixture (`src/providers/claude-cli/protocol.ts` is a good reference).

The default `ClaudeCLIProvider` runs Claude Code as a long-running subprocess and exchanges JSONL frames over stdio — useful when your provider also exposes a CLI.

### Add a new scheduled Skill

Scheduled skills are recipes for recurring missions (daily briefings, retros, audits). They live under `pipeline/skills/<name>/SKILL.md` and run via the `skill:gen` and `skill:push` cron handlers.

Steps:

1. Create `pipeline/skills/<your-skill>/SKILL.md` describing the prompt, inputs, and output format.
2. Reference the skill in `remi.toml` under `[[cron.jobs]]`:
   ```toml
   [[cron.jobs]]
   id = "your-skill:gen"
   handler = "skill:gen"
   cron = "0 7 * * *"
   handler_config = { skillName = "your-skill", outputDir = "/path/to/output" }

   [[cron.jobs]]
   id = "your-skill:push"
   handler = "skill:push"
   cron = "0 9 * * *"
   handler_config = { skillName = "your-skill", outputDir = "/path/to/output", connectorName = "feishu", pushTargets = ["oc_xxx"] }
   ```
3. Verify with `bun run src/main.ts doctor` and check the queue.

### Add a new MCP tool

The MCP server lives in `src/memory/mcp-server.ts`. Add a new tool by registering it in the server's tool list and implementing the handler. Tools should be small, composable, and idempotent — the LLM may call them many times in a single turn.

## Filing issues

When reporting a bug, include:

- Remi version (`bun run src/main.ts --version` or `package.json`).
- Bun version (`bun --version`).
- OS and architecture.
- Minimal reproduction steps.
- Relevant logs from `~/.remi/logs/` (redact secrets).

Feature requests are welcome — please describe the *use case* before the *solution*. Prior art from other AI assistants is helpful context.

## Code of Conduct

Be kind, assume good faith, and keep discussions focused on the work. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) at minimum.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
