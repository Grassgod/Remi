# CLI command migration

This document is the user-facing migration contract for the Registry-based Remi CLI.
The machine-readable source of truth remains `cli-capabilities.json`; CI checks this
table against that manifest.

## Canonical command tree

The canonical tree has 32 top-level resources. Attachment is the 33rd API domain
and is exposed below Issue and Comment rather than as another top-level resource.

```text
remi context
remi workspace
remi member
remi invite
remi token

remi project
remi repo
remi memory
remi wiki

remi issue
remi comment
remi session
remi share
remi label

remi chat
remi task

remi agent
remi squad
remi skill
remi plugin

remi runtime
remi daemon
remi autopilot
remi scm
remi feishu

remi inbox
remi notification
remi pin
remi dashboard
remi platform
remi billing
remi lark
```

Use `remi help <path>` or `remi <path> --help` for the registered positional and
option contract. All capability commands declare their authentication identities,
mutation class, and `table|json|jsonl` output contract in the Registry.

The Feishu ingestion domain exposes source administration through
`remi feishu source list|get|status|add|update` and task-safe processing through
`remi feishu messages list|resolve|notify|draft-reply|propose-issue`. Issue
proposals are non-blocking Inbox items; only humans can run
`remi feishu proposals approve|reject` or the administrative direct
`messages create-issue` command. Dedicated commands atomically create their
Inbox/Issue object and audited outcome, and generic `resolve` cannot forge those
outcomes. An empty source allowlist means zero ingestion; `source update
--clear-allowlist` restores that state.

The current main integration also exposes archived Issue recovery, Workspace
prompt/archive settings, and Repository Wiki administration through:

```text
remi issue restore
remi workspace prompt get|update
remi workspace issue-archive get|update
remi wiki repository list|get|create|update|delete|revisions|build
remi wiki repository atlas status|configure
remi platform operation cancel <operation> --yes
```

## Deprecated aliases

All aliases below are deprecated since `0.3.0`. They remain executable for at
least one complete release cycle. Removal requires all supported platform and
daemon versions to advertise the canonical capability, prompt and skill audits
to remain clean, and a separately approved release change. This branch does not
remove any alias.

| Deprecated command | Canonical replacement | Lifecycle |
| --- | --- | --- |
| `remi project delete` | `remi project archive` | One-release compatibility alias |
| `remi repo import` | `remi repo create` | One-release compatibility alias |
| `remi memory recall` | `remi memory search` | One-release compatibility alias |
| `remi memory read` | `remi memory get` | One-release compatibility alias |
| `remi memory remember` | `remi memory create` | One-release compatibility alias |
| `remi memory add` | `remi memory create` | One-release compatibility alias |
| `remi memory forget` | `remi memory delete` | One-release compatibility alias |
| `remi wiki read` | `remi wiki get` | One-release compatibility alias |
| `remi wiki history` | `remi wiki revisions` | One-release compatibility alias |
| `remi project knowledge status` | `remi memory migration status` | One-release compatibility alias |
| `remi project knowledge backfill` | `remi memory migration backfill` | One-release compatibility alias |
| `remi project knowledge verify` | `remi memory migration verify` | One-release compatibility alias |
| `remi project knowledge retry-failed` | `remi memory migration retry` | One-release compatibility alias |
| `remi issue comment list` | `remi comment list` | One-release compatibility alias |
| `remi issue comment add` | `remi comment add` | One-release compatibility alias |
| `remi issue comment update` | `remi comment update` | One-release compatibility alias |
| `remi issue comment delete` | `remi comment delete` | One-release compatibility alias |
| `remi issue comment resolve` | `remi comment resolve` | One-release compatibility alias |
| `remi issue comment unresolve` | `remi comment unresolve` | One-release compatibility alias |
| `remi issue session list` | `remi session list` | One-release compatibility alias |
| `remi issue session result list` | `remi session result list` | One-release compatibility alias |
| `remi issue session result publish` | `remi session result publish` | One-release compatibility alias |
| `remi issue archive list` | `remi session archive list` | One-release compatibility alias |
| `remi issue archive status` | `remi session archive status` | One-release compatibility alias |
| `remi issue archive verify` | `remi session archive verify` | One-release compatibility alias |
| `remi issue archive retry` | `remi session archive retry` | One-release compatibility alias |
| `remi attachment download` | `remi issue attachment download` | One-release compatibility alias |
| `remi task messages` | `remi task message list` | One-release compatibility alias |
| `remi multiremi agent list` | `remi agent list` | One-release compatibility alias |
| `remi multiremi agent get` | `remi agent get` | One-release compatibility alias |
| `remi agent edit` | `remi agent update` | One-release compatibility alias |
| `remi multiremi agent edit` | `remi agent update` | One-release compatibility alias |
| `remi multiremi agent update` | `remi agent update` | One-release compatibility alias |
| `remi seed` | `remi agent default` | One-release compatibility alias; keeps `--provider` |
| `remi multiremi seed` | `remi agent default` | Hidden one-release compatibility alias |
| `remi squad delete` | `remi squad archive` | One-release compatibility alias |
| `remi skill delete` | `remi skill archive` | One-release compatibility alias |
| `remi plugin delete` | `remi plugin archive` | One-release compatibility alias |
| `remi start` | `remi daemon start` | Byte-compatible local lifecycle alias |
| `remi stop` | `remi daemon stop` | Byte-compatible local lifecycle alias |
| `remi restart` | `remi daemon restart` | Byte-compatible local lifecycle alias |
| `remi status` | `remi daemon status` | Byte-compatible local lifecycle alias |
| `remi logs` | `remi daemon logs` | Byte-compatible local lifecycle alias |
| `remi service` | `remi daemon service` | Byte-compatible local lifecycle alias |
| `remi update` | `remi platform operation create` | Byte-compatible local updater alias |
| `remi multiremi` | `remi <command>` | Hidden compatibility entry |

Nested Issue aliases and the local lifecycle aliases intentionally keep their
legacy dispatchers for byte-compatible arguments, stdout/stderr, and exit codes.
They are still present in Registry inventory and the capability manifest, so
they cannot become undocumented bypasses.

## Prompt and documentation migration

The server-injected agent prompt now uses only canonical commands in
`packages/daemon/src/agent-runtime/prompts/ephemeral.ts`:

- `remi comment list|add`
- `remi session result publish`
- `remi memory search|get|create|update`

The matching durable command examples were updated in
`docs/project-wiki-memory-spec.md`, `docs/issue-key-results.md`, and the frontend
Session-result convention comment. There are no tracked `SKILL.md` files in this
repository, so there were no in-repository skill command strings to migrate.
Legacy handler usage strings remain unchanged because they document commands
that are deliberately supported during the compatibility period.
