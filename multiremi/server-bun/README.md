# Multimira Bun backend

The TypeScript/Bun rewrite of the Go server (`../server`), with all 12 agent
backends unified behind one ACP provider. This is the backend the web app runs
against; the Go tree stays as reference and still provides the `multimira` CLI.

## Fresh-clone quickstart

Prereqs: [Bun](https://bun.sh) ≥ 1.3, Node 22 + pnpm, Docker (for PostgreSQL).

```bash
# 1. Env + DB + frontend deps (creates .env from .env.example, starts
#    postgres, runs migrations)
make setup            # or: cp .env.example .env && make db-up && make migrate-up
pnpm install

# 2. Backend (Bun) — reads .env, installs server-bun deps on first run
make server-bun

# 3. Frontend
pnpm dev:web

# 4. Log in: paste into the browser address bar
#    http://localhost:3000/auth/dev-login?email=you@example.com&redirect=/
#    (enabled by MULTIMIRA_DEV_LOGIN=1 in .env; hard-disabled when
#    APP_ENV=production. For real Feishu SSO fill LARK_SSO_* in .env.)
```

## Running agents (the daemon)

Tasks queue in Postgres; a daemon process claims and executes them through ACP
on the machine where your coding agent lives.

```bash
# One-time: install the ACP bridge for Codex (codex-cli has no native ACP)
npm i -g @zed-industries/codex-acp

# Create a runtime in the UI (Runtimes → New, provider e.g. "codex"),
# then run the daemon with its id:
make daemon-bun RUNTIME_ID=<runtime-uuid>
```

The runtime shows Online while the daemon heartbeats. Assign an issue to an
agent on that runtime (or use quick-create / comment on an assigned issue) and
the daemon picks the task up, runs the agent in the project's repo/directory,
posts the report back as a comment, and moves the issue to in_review.

Agent working directory comes from the issue's project resources:
`local_directory` runs in place; `github_repo` gets a fresh git worktree.

## Tests

```bash
cd server-bun
DATABASE_URL="postgres://multimira:multimira@localhost:5432/multimira?sslmode=disable" \
JWT_SECRET=devsecret bun test
```

Tests are DB-gated (skip when Postgres is unreachable) and create/tear down
their own fixtures. See `MIGRATION.md` for the Go→Bun porting log.
