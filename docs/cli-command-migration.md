# CLI command migration

This document is the user-facing migration contract for the Registry-based Remi CLI.
The machine-readable source of truth remains `cli-capabilities.json`; CI checks this
table against that manifest.

Agent creation, editing and default-agent commands accept `--provider antigravity`.
`remi daemon start --provider antigravity` selects the native `agy` runtime;
automatic daemon discovery also detects it. Install/sign in to agy on the daemon
machine first. See [Antigravity Runtime](antigravity.md) for model discovery,
configuration and execution limits. Agent Plugin provider filters remain scoped
to Claude/Codex.

## Canonical command tree

Codex Runtime connections use `remi runtime codex-profile get <runtime>` and
`remi runtime codex-profile set <runtime> --file profile.json`. The JSON body
contains `profile` and an optional write-only `api_key`; `profile: null` restores
the workspace gateway. These are human configuration commands; task credentials
cannot read or change them. See [Codex Runtime connections](design/acp-codex-via-codex-acp.md#runtime-自定义连接)
for authentication, environment variables and session behavior.

Claude Code uses `remi runtime claude-profile get <runtime>` and
`remi runtime claude-profile set <runtime> --file profile.json`, with the same
credential and clear semantics plus `auth_header: bearer | x-api-key`. See
[Claude Code Runtime connections](design/acp-claude-via-claude-agent-acp.md).

The canonical tree includes a focused top-level Attachment download command;
Issue and Comment keep their scoped attachment listing and management commands.

```text
remi context
remi workspace
remi member
remi invite
remi token

remi project
remi repo
remi knowledge
remi memory
remi wiki

remi issue
remi comment
remi session
remi share
remi label
remi attachment download

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
remi messaging
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

Password authentication uses `remi context auth password --file -` with JSON
containing `email` and `password` on standard input. It saves the returned session
in the selected CLI configuration and prints a user summary without credentials.
Deployment administrators can provision or reset an account with
`remi context auth password-account set --file -`; the body additionally accepts
`name` and `workspaceId` (default `local`). That operation requires the deployment
master token and grants the account owner membership in the selected workspace.
Both commands are unavailable to task identities; password values have no dedicated
command-line flag and should be supplied without putting them in shell history.
Both commands validate file/stdin JSON before resolving request context or making
network requests, so malformed input errors cannot quote password fragments.
Account provisioning sends only the API's `workspaceId` field; `--workspace`
overrides either workspace spelling in the input and selects the same request header.

`remi runtime workspace list|create|get|rename|archive` manages persistent execution
directories owned by a Runtime's daemon. This is distinct from the team tenant
managed by `remi workspace`. Use `--runtime-workspace <id>` on `chat create` or
`issue create|update` to select it. See the [runtime workspace contract](dev/runtime-workspaces.md)
for local context, directory lifetime, and the immutable execution binding.
`remi runtime skill scan <runtime> --root '~/.agents/skills'` discovers skills in
a directory on that Runtime's machine. Poll `runtime skill status <runtime>
<scan-request>` until it completes, then import a returned key with `runtime skill
import <runtime> --scan-request <scan-request> --key <skill-key>`. The scan binds
the import to the selected directory; `--name` and `--description` optionally
override library metadata. Poll `runtime skill import-status <runtime>
<import-request>` to obtain the imported skill. These operations require an online
Runtime owned by the caller. Imports copy content into the Remi skill library;
assign the imported skill to a cloud agent separately. Runtime imports preserve
text and binary supporting files. File JSON uses optional `encoding: "base64"`
for binary content; omitted encoding means UTF-8. Agents using binary files
require an updated daemon; older daemons receive an upgrade error when no
compatible task can be claimed, leaving those tasks available after the update. See the
[Runtime skill import contract](runtime-skills.md) for file limits and daemon
compatibility. JSON request input remains available through `--data` or `--file`;
`--json` selects JSON output.

### Repository checkout defaults

`remi repo checkout <repository-or-url>` without `--ref` prefers the workspace
repository's configured `default_branch`. Direct URLs use a best-effort lookup
in the repository directory; lookup failures do not prevent checkout. If the
configured branch cannot be resolved, checkout falls back to the existing remote
default selection (`origin/HEAD`, then `main`, then `master`). An explicit `--ref`
remains strict: an unknown branch or commit fails rather than falling back.

Issue worktrees and intake snapshots use the same preference. Repository records
are authoritative; stored project resource `default_branch_hint` values remain
read-time fallbacks, without rewriting resource rows. Existing issue worktrees
are preserved, not reset to a newly configured branch. Workspace API `base_ref`
retains its full ref; `base_commit` reports the common baseline with the existing
worktree HEAD, or null when no common ancestor can be resolved.

Chat management uses `remi chat pin|unpin|archive|restore <chat>`. Archiving stops
unfinished runs and makes the conversation read-only until restored. While a
Chat is running, `remi chat queue list|update|remove|clear|prioritize` manages its
queued follow-ups. `prioritize <chat> <task>` moves the selected message next and
stops the current run; `update <chat> <task> --content-file <path>` edits only a
message that has not started. See the [Chat contract](chat.md).

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
remi wiki repository list|get|create|update|delete|revisions|backlinks|build
remi knowledge submit|submissions|inspect|runs|run show|migrate-legacy
remi wiki publish
remi memory publish
remi platform operation cancel <operation> --yes
```

## Current user identity

`remi member get me`, `remi member update me`, and `remi member onboarding ...`
read or update the authenticated user's profile and onboarding state. The Web
console uses the same `/api/me` routes, so reloading a page preserves that
identity. The Web-to-CLI exchange at `POST /api/cli-token` keeps the same user ID
and workspace membership permissions. A signed identity whose user no longer
exists is rejected with `401`; deployment-master requests and unauthenticated
requests in open local mode retain the existing `local` identity.

## Workspace request context

Workspace-scoped collection and creation routes in both API families resolve
context before authorizing and accessing the same workspace. This includes
agents, skills, chats, runtimes, model catalogs, dashboards, issues, projects,
labels, autopilots, squads, pins, members, tokens, notifications, feedback,
plugins, daemon management, knowledge migration and onboarding bootstrap.
Supported explicit body/query workspace IDs generally come first, followed by
`X-Workspace-ID`, `X-Workspace-Slug`, the credential's workspace, and finally
`local` when no context exists. Existing field priorities remain unchanged:
compatibility context routes keep the ID header ahead of `workspace_id` query;
compatibility label creation accepts both body fields with snake_case first.
Unknown slugs return `404` when slug resolution is needed, without falling back
to `local`. Selecting a workspace does not grant membership or broaden a
task, daemon, share or workspace-scoped machine credential.

Agent list, ordinary creation, template creation and default-agent creation share
this resolution. Their explicit workspace IDs use body before query, with
`workspaceId` before `workspace_id` within each source. An explicit ID takes
priority over a conflicting or unknown slug; when slug resolution is needed, an
unknown slug returns `404` without falling back. Membership and credential-scope
checks still apply to the resolved workspace. Regression coverage is in
[`agent-workspace-context.test.ts`](../tests/unit/multiremi/agent-workspace-context.test.ts).

Resource operations authorize the resource's workspace. Runtime usage queries
use that same workspace even when a page sends a stale selector; an empty
runtime list cannot redirect the model catalog to `local`. Skill and label
details and mutations check resource access, and skill search requires workspace
access before returning summaries. Skills retain their explicit query mismatch
check, and attachment creation derives scope from the referenced resource when
the body omits a workspace. Multipart uploads reject references spanning
different workspaces before writing either attachment metadata or a file.

Inbox collection and bulk operations resolve the caller's membership only
inside the selected workspace. Human and task credentials cannot select another
member's inbox. Store queries and bulk updates also filter the inbox row's
workspace, so moving a membership does not expose or modify its former
workspace's notifications. Single-item read/archive operations authorize both the resource
workspace and recipient before writing; an explicit selector must match, and
repeated authorized operations remain valid for archived items.
Moving a workspace member requires administration of both source and destination;
the source workspace's administrator cannot grant membership in another workspace.

Daemon installation resolves and authorizes the selected workspace before
generating instructions or credentials. Registration without a body workspace
uses request context or the daemon credential's scope; daemon identity and
owner checks still apply. CLI daemon context filters runtimes by both daemon ID
and credential workspace. A login session does not become a daemon credential:
the install flow issues a daemon token, while legacy CLI-token promotion keeps
its existing workspace and purpose constraints.

The `*-workspace-context.test.ts` suites and
[`workspace-context-remaining.test.ts`](../tests/unit/multiremi/workspace-context-remaining.test.ts)
cover header-only requests, unknown slugs, explicit-selector priority, resource
scope and credential boundaries.

Registry resource commands choose `--workspace` first, then the JSON/file input's
`workspaceId` or `workspace_id`, environment, saved configuration, and `local`.
The request header and body use that same workspace; a default cannot overwrite
an explicit workspace from `--data` or `--file`.

An authenticated local-login session represents the real `local` user and checks
that user's memberships. Legacy workspace-scoped machine credentials retain
their scope. User-issued native tokens cannot impersonate another user or mint
login sessions; listing and revoking tokens also enforce the credential's scope.
CLI exchange preserves the source workspace and the verified local-login identity
without promoting legacy machine credentials into a human session.

Comment authors, resolution actors, reactions and upload ownership follow the
authenticated user or task agent. Caller-supplied actor fields remain available
for deployment-master and auth-disabled requests. Comment resolution accepts an
empty body even when the client sends `Content-Type: application/json`.

## Deprecated aliases

`remi wiki lint` is deprecated since `0.2.58` with no CLI replacement. Wiki
review and organization now belong to Atlas lint mode; the legacy heuristic
scan remains hidden and executable for one release so in-flight task prompts
do not fail. It must be removed after that compatibility window.

All aliases below are deprecated since `0.3.0`. They remain executable for at
least one complete release cycle. Removal requires all supported platform and
daemon versions to advertise the canonical capability, prompt and skill audits
to remain clean, and a separately approved release change. This branch does not
remove any alias.

| Deprecated command | Canonical replacement | Lifecycle |
| --- | --- | --- |
| `remi wiki lint` | `remi wiki internal-lint` | Hidden one-release compatibility only; use Atlas lint mode for review |
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
| `remi issue attachment download` | `remi attachment download` | One-release compatibility alias |
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

The matching durable command examples use canonical commands in
`docs/project-wiki-memory-spec.md`, `docs/issue-key-results.md`, and the frontend
Session-result convention comment. The repository-maintained
[Remi skill](../.agents/skills/remi/SKILL.md) provides CLI workflows with
task-specific references; keep its examples aligned with this command contract.
Legacy handler usage strings remain unchanged because they document commands
that are deliberately supported during the compatibility period.
