# CLI command migration

Communication uses `remi message`, addressed unread messages use `remi inbox`,
and execution uses `remi turn`. Issue, Chat and Autopilot remain conversation containers.
An ordinary decision is a message with options and a same-session reply. A persisted
business question uses the versioned `message question` actions below.

Issue responsibility is resolved with `remi issue responsibility <issue>`: the
execution coordinator belongs to the Issue, the direct parent coordinator reviews
child results, and the root explicitly designates a human. Create/update accepts
`--responsible-member <workspace-member-id>`; `remi issue responsible set <root>
--member <member-id>` explicitly transfers it and preserves ownership audit.
Children inherit the root human and never persist an independent copy. New execution
assignees use `agent` or `squad`; historical member assignments remain visible as
needing configuration and are not valid execution coordinators.

`remi issue delivery list|submit <issue>` reads or submits formal delivery evidence;
submit requires the execution coordinator's identity and `--summary` or JSON input.
Delivery list takes `--limit 1..100` and `--cursor <nextCursor>` for older pages.
`remi issue delivery accept|return <issue> <delivery> --revision <responsibilityRevision>`
reviews that exact delivery (`return` requires `--reason`). The designated human can
use `remi issue delivery authorize <issue> <delivery> --revision <revision> --agent
<execution-owner>` or `--revoke`; this authorization applies only to that delivery
and ownership version. Task completion and ordinary parent-done grants do not
replace formal acceptance.

`remi issue question list <issue>` and `remi message question get <Q>` expose the
one original question, unchanged options, separate Remi summary, current handler,
routing/answer history and actual consumption state. Actions use
`remi message question answer|escalate|transfer|present|continue|close <Q> --revision
<route_revision>`. Answer takes `--data '{"response":{"answers":{"question":"answer"}}}'`;
escalate/transfer/close require `--reason`, and present requires `--summary`. Close
preserves the original question and history instead of deleting it. Explicit
human revisions additionally require `--revise --answer-revision <answer_revision>
--reason <reason>`. Continue is an exceptional human authorization for detached
calls, not an extra button required after ordinary answers. All replies return to
the original Q session; a parent/Remi notification references its Q ID.
`message send --reply-to <Q>` also requires the explicitly read `--revision`;
answer changes additionally require `--revise --answer-revision --reason`.
Ordinary message replies do not require a question revision.

`remi issue responsibility-unassigned list <workspace> --limit 100 --offset 0`
shows original ownership, creator facts, unconfirmed candidates and the current
responsibility revision. Workspace administrators apply explicit selections with
`remi issue responsibility-unassigned map <workspace> --reason <reason> --data
'{"mappings":[{"issueId":"root","memberId":"human","revision":"current"}]}'`.
No candidate is automatically selected or promoted into responsibility.
`remi autopilot responsible set <autopilot> --member <member>` configures future
automatic root issues; create/update JSON uses `responsible_member_id`.
Feishu bot configuration JSON uses the same field.
`workspace feishu-bot set --responsible-member <member>` explicitly configures
the bot human, while `--clear-responsible` leaves new automatic roots unconfigured.
Topic configuration accepts
`workspace issue-topics set --responsible-member <member>` or
`--inherit-bot-responsible` to clear its override. Missing explicit bot/automation
configuration blocks automatic root creation while preserving incoming Chat.

Unified usage uses `remi dashboard usage report` with `--days n|all`,
`--since`, `--until`, `--tz`, `--project` and `--runtime`.
`--include day_model` adds one genuine consumption-date × model detail page;
`--detail-limit 1..500` defaults to 200 and `--detail-cursor <next_cursor>`
continues the same workspace, filters, resolved range, timezone and price
revision. Detail rows omit lifecycle duration/status; distinct related task
counts are not additive. A stale or invalid cursor returns an error and must
restart at the first page. Default reports omit this lazy projection.
JSON output preserves explicit accounting token counters as nonnegative safe
integers or null, and `coverage.token_ratio` as a finite ratio or null.
Credential fields remain filtered; strings or objects disguised as token
statistics do not bypass that filter.
`remi dashboard usage prices list|set|close` reads or appends exact
provider/model/connection price versions (`set --file <json>`,
`close <price-id> --effective-to <ISO>`). Price writes are human/admin only.
`remi dashboard usage reconcile` checks additive metrics and each currency
across one report snapshot; distinct model/day/Runtime task counts are not
summed. All commands use the selected workspace. Legacy statistical paths
remain available as normalized-fact compatibility projections, while Web
uses the unified report. Schema-only startup gates historical installations
with HTTP 503 until explicit resumable backfill completes. Database migration
and evidence recovery are internal maintenance scripts, with explicit DB
environment and reviewed apply plans, not ordinary API writes. Current
semantics and executable maintenance commands are in
[Unified usage and prices](usage-accounting.md).


The browser-only `GET /api/sessions/:sessionId/log?with_activity=1` adds an
activity sidecar for the default Issue session: `activities`,
`activities_truncated`, and `prev_entry_created_at`. Activities do not consume
log sequence numbers or change pagination counts. The latest 200 matching
activities remain chronological within the log window's timestamp interval.
Side sessions and Chat ignore the flag. The retired CLI log commands remain
local replacement notices; range reads use `remi message list`.

This document is the user-facing migration contract for the Registry-based Remi CLI.
The machine-readable source of truth remains `cli-capabilities.json`; CI checks this
table against that manifest.

`remi issue status-pages --statuses todo,in_progress --limit 50
--include-archived-total --output json` calls `GET /api/issues/status-pages`.
The response is `{ groups: { [status]: { issues, total, has_more } },
archived_total? }`. Each bucket contains the same compatibility Issue records
and total as `/api/issues?status=...&limit=...&offset=0`. Default statuses are
all seven server statuses, including `cancelled`; `open` normalizes to `todo`.
The default limit is 50 per status, capped at 500. Only offset 0 is accepted;
continue each bucket through the existing `/api/issues` route.

`remi issue grouped --include-archived-total --output json` also opts into
the workspace-wide `archived_total` for assignee boards. Omitting the flag
preserves the existing response and avoids the additional archive count.

The API reuses the compatibility list query: `workspace_id`, `statuses`/`status`,
`priorities`/`priority`, `assignee_types`, `assignee_id`, `assignee_ids`,
`project_id`, `project_ids`, `parent_id`, `top_level_only`, `metadata` (JSON
equality filters), `include_no_assignee`, `include_no_project`, `include_archived`,
`archived_only`, `limit`, and `offset`. Lists are comma-separated. CLI options
use `--workspace`, `--statuses`/`--status`, `--priority`, `--assignee-type`,
`--assignee`, `--assignee-ids`, `--project`, `--project-ids`, `--parent`,
`--metadata`, and hyphenated forms of the Boolean flags. Assignee references
use the shared resolver, including user IDs, member IDs, Agent IDs and names.
The compatibility list query also accepts the legacy `assignee_type` spelling
when `assignee_types` is absent; the plural takes precedence, including when
empty. Native queries retain `assigneeTypes`/`assignee_types` only. The CLI sends
`assignee_types` for `--assignee-type`.
Like the existing list, ordering is `updated_at DESC`; `sort_by`, `sort_order`,
`creator_id` and `involves_user_id` currently have no effect.

`remi issue children <key-or-id>` accepts either reference. Both children batch
routes resolve `parent_ids` to parent IDs and deduplicate those IDs before
listing children. A full issue ID resolves globally, whatever workspace is
selected, so the CLI's default `X-Workspace-ID` never hides a parent the caller
can access; the workspace only distinguishes keys, numbers and ID prefixes.
For those, explicit workspace selectors take precedence in this order: query
`workspace_id` (native requests first check `workspaceId`, then `workspace_id`),
`X-Workspace-ID`, then `X-Workspace-Slug` resolved to a workspace ID. An unknown
explicit slug skips keys, numbers and prefixes but still resolves full IDs. With
no explicit selector, resolution remains unscoped and does not infer token or
member defaults. Non-ID references follow `getIssueByRef`, like
`/api/issues/:id/children`: a unique match wins, or, without a workspace
selector, the unique local row takes precedence among multiple matches. An
explicit workspace restricts resolution to that workspace's row. Unknown or
still unresolved references and inaccessible parents are skipped; children must
also pass the existing workspace access check. Compatibility responses retain
snake_case Issue fields, while native responses retain camelCase.

`include_archived_total=true` (CLI `--include-archived-total`) adds the
workspace-wide archived count, independent of other list filters. Omission
performs no archive count query and omits the field. Buckets, totals, labels
and the optional count share a SQLite read transaction or a PostgreSQL
read-only Repeatable Read transaction. The Web pages do not call this API yet.

Agent creation, editing and default-agent commands accept `--provider antigravity`.
`remi daemon start --provider antigravity` selects the native `agy` runtime;
automatic daemon discovery also detects it. Install/sign in to agy on the daemon
machine first. See [Antigravity Runtime](antigravity.md) for model discovery,
configuration and execution limits. Agent Plugin provider filters remain scoped
to Claude/Codex.

`remi agent create|update|template create` accept `--fallback-model <model>` and
`--fallback-thinking-level <level>`. The backup must differ from the primary
model and be executable on the same selected target; its reasoning level must
belong to the backup model's catalog. Use `remi agent update <agent>
--fallback-model ''` to clear the backup. Changing an Agent's provider, Runtime,
execution group or workspace clears the saved backup unless supplied again.

`remi agent create`, `remi agent template create <template>`, `remi agent update
<agent>` and `remi agent default` accept `--execution-group <group-id>`.
Use `remi runtime group list` to find groups and their online Runtime counts,
then `remi runtime model catalog --execution-group <group-id>` to inspect models.
Groups default to one machine and Runtime type. Assign the same custom group ID
with `remi runtime update <runtime> --execution-group <group-id>` to pool Runtimes
in the same workspace and provider. Workspace boundaries remain isolated;
a group cannot mix Runtime types. Restore a Runtime's default group with
`remi runtime update <runtime> --data '{"execution_group_id":null}'`.

The legacy `--runtime <runtime-id>` agent and model-catalog option remains
supported, and is mutually exclusive with `--execution-group`. Omitting both
on agent update preserves the existing target. The provider is inferred from
the selected target unless explicitly supplied; an explicit provider must match.
Tasks use eligible members of the selected group and wait when none is available;
they do not fall back to unrelated Runtimes sharing a provider.

`remi runtime model catalog --agent <agent-id> --json` returns the same selectable
models and reasoning capabilities as the Agent editor. For the Codex gateway,
`model_catalog_status: "ready"` means `models` is the authoritative execution
catalog. A saved model absent from that list is not executable; its saved model
and thinking level remain intact. New selections of that model return
`model_not_in_execution_catalog`. `model_catalog_status: "error"` retains the
ordinary gateway inventory and reports capability loading failure instead of
emptying the picker. Each model's `execution_status` distinguishes `available`,
`unavailable`, and `unknown`; only actual ACP fallback members stay executable
when that Runtime cannot load the native catalog. Bundled GPT reasoning options
remain usable. `model_catalog_status: "unknown"` marks missing, obsolete, or
unrefreshed snapshots; new explicit selections return
`model_execution_catalog_unknown` until discovery finishes. The saved model and
thinking level are preserved. Custom Runtime connections keep their own catalogs.

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

For either custom connection, `remi runtime model refresh <runtime>` asks its
daemon to discover the provider catalog. Poll `runtime model status <runtime>
<request-id>` for completion, then use `runtime model list <runtime>`. These
model commands are available to task credentials without exposing connection
secrets. Set a cloud agent's selection with `remi agent update <agent> --model <model-id>`;
the connection's configured model remains the default when no model is selected.

The canonical tree includes a focused top-level Attachment download command;
Issue and Comment keep their scoped attachment listing and management commands.

`remi turn list --limit <n> --cursor <cursor>` lists authorized turns.
`remi turn get <turn> --input --attempts` reads the input range and attempt history;
`remi turn trace read <turn> --attempt <attempt>` reads a selected attempt's trace.

Chat Tasks can deliver files to their current conversation with
`remi message send --attachment report.html --attachment chart.png`.
`--content`, `--content-file`, and `--content-stdin` optionally add a caption.
The server resolves the destination from the Task credential; no Feishu chat ID
is needed. Each file must be non-empty, at most 20MB, and pass the server's file type allowlist.
Within one command, the caption precedes the files, which are delivered in input
order. A retry keeps later files waiting; a permanent failure marks the remaining
files failed with the reason. Raster images larger than 10MB use file cards;
smaller images use inline image messages. SVG files always use file cards.
The response includes attachment IDs and queued delivery IDs; queueing does not
mean Feishu has acknowledged delivery. The current conversation comes from CLI context when no conversation is supplied.

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
remi message
remi session
remi share
remi label
remi attachment download

remi chat
remi turn

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

`remi runtime delete <runtime> --yes` and `runtime archive-agents-and-delete`
block on uncleaned Issue workspaces. Add `--abandon-issue-workspaces` only after
reviewing the affected Issue list. For historical records with no Runtime,
`remi issue workspace abandon <issue> --yes` releases their task affinity and
retains local files. Records still attached to a Runtime must use deletion or
retirement instead. `remi issue workspace <issue>` remains the read command.

`remi runtime prepare [--provider claude|codex]` installs this release's fixed ACP
and Agent dependencies, verifying executables and ACP initialization without
switching a running daemon. Without `--provider` it prepares the configured or
detected providers that have an ACP bundle and skips the rest (such as
antigravity), succeeding with empty `runtimes` when none remain; an explicit
`--provider` other than claude or codex is rejected. This local command does not require server authentication.
Maintainers refresh dependencies before every release with
`bun run release:prepare --version <next>`; daemons do not poll the registry.
See [daemon runtime upgrades](daemon-runtime-upgrades.md) for the release and
installation checks.

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
Chat is running, directed now messages join the running turn. Unread follow-ups
are listed with `remi message list <chat> --unread-by <agent>` and edited or deleted
by message ID; order follows seq. See the [Chat contract](chat.md).

The Feishu ingestion domain exposes source administration through
`remi feishu source list|get|status|add|update` and task-safe processing through
`remi feishu messages list|resolve|notify|draft-reply|propose-issue`. Issue
proposals are non-blocking Inbox items; only humans can run
`remi feishu proposals approve|reject` or the administrative direct
`messages create-issue` command. Dedicated commands atomically create their
Inbox/Issue object and audited outcome, and generic `resolve` cannot forge those
outcomes. An empty source allowlist means zero ingestion; `source update
--clear-allowlist` restores that state.

Feishu bots default to Agent capabilities: anyone who can message the bot may
use its enabled capabilities without sender approval. `remi workspace feishu-bot
set <workspace> ... --sender-access-policy agent|allowlist` selects this policy;
omitting the option preserves the saved choice. Existing bot configurations
upgrade to `agent`. Agent and inherited task proposal policies still apply.

The optional Feishu bot sender allowlist uses `remi workspace feishu-bot sender
list <workspace>`, `allow <workspace> <sender>`, and `revoke <workspace> <sender>`.
The sender ID comes from `list`; accounts are discovered from incoming bot
requests and deduplicated within the current bot app. These human-only commands
manage permission to create Issues through bot Chats without linking senders to
Remi users or workspace members. This account allowlist is separate from the
Messaging Source conversation allowlist. See the [sender policy](feishu-message-ingestion.md#机器人发送者白名单)
for active Chat checks and legacy restricted sessions.

`sender list` also refreshes names from previously received bot messages; JSON
includes optional `name_en`, and table output includes `ENGLISH_NAME`. Profile
refresh preserves sender IDs and allowlist decisions.

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

`remi wiki repository list <repo>` prints document metadata only, matching the
API list contract from [ADR 0002](adr/0002-repository-wiki-list-without-bodies.md).
Pass `--include-body --ids <a,b>` (at most 20 ids per request) to fetch bodies
for specific documents.

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

## Removed Chat Issue binding (MUL-301)

Chat Sessions are independent conversations. Creating an Issue from Chat no longer
binds the Chat or subscribes it to Issue activity. Feishu Issue topics retain their
Issue association in the Feishu binding table and continue receiving updates and
work-round replies. Legacy group associations without deterministic ownership
evidence require audited operator restoration before daemon traffic resumes;
see the [migration runbook](migrations/chat-issue-decoupling.md).

This is an intentional breaking capability removal, with no replacement command.
Unlike renamed command paths, it has no executable compatibility alias: retaining
one would restore the binding capability being removed. The five executable
commands removed are:

- `remi chat issue bind`
- `remi chat issue unbind`
- `remi chat issue updates get`
- `remi chat issue updates enable`
- `remi chat issue updates disable`

The `chat.issue` and `chat.issue.updates` grouping nodes are also removed.
Chat creation, messages, queues, pinning, archiving and restoration remain supported.
Chat session lists and the global pending-task list exclude Feishu Issue-topic
transport sessions, including topics created by the current user.

API changes:

- Chat session create/update no longer accept `issueId` or `issue_id`; sending
  either field returns HTTP 400.
- Chat session responses no longer include `issueId` (native API) or `issue_id`
  (compatibility API).
- Issue creation no longer returns `chat_issue_binding` or `chat_issue_binding_hint`.
- `GET` and `PUT /api/chat/sessions/:sessionId/issue-updates` are removed.
- CLI context no longer includes `current.chat.issue_id` or `current.bound_issue`.
- Internal daemon task wire removes `chat_bootstrap_transcript`; cold conversation
  history continues through the existing session projection.

## Autopilot run must not read as a query (MUL-468)

`remi autopilot run <autopilot>` shares its prefix with the read-only
`remi autopilot run list <autopilot>` and `remi autopilot run get <autopilot>
<run>`. In the parent help the `run` line borrowed the description of its first
child ("List autopilot runs including queued schedule targets"), so the trigger
command read as a query. On 2026-09-27 that misfire launched six unrequested
autopilot runs and published an unintended release; a second operator read it the
same way later that day.

Starting one run now has its own verb, matching the UI label:

- `remi autopilot run-now <autopilot>` — POST a run now, the same action as
  "立即运行 / Run now". `--data '{"trigger_id":"..."}'` selects the schedule
  trigger to start.
- `remi autopilot run <autopilot>` — rejects the invocation with a usage error and
  names the three correct commands. It sends no request at all, not even the
  autopilot name lookup.
- `remi autopilot run list|get` — unchanged read-only queries.

**This rename intentionally ships without a compatibility alias.** The repository
rule that deprecated command paths stay executable for one release assumes the old
path was a working spelling of the intent. Here the old spelling is exactly the
hazard: an alias would keep turning a read into a manual run on every Runtime that
has not upgraded yet, which is how this incident happened twice. The path is
therefore removed outright and replaced by the guard above, so an un-upgraded CLI
is the only way to still reach the old behavior.

Running turns receive directed messages through `remi message send`; explicit
finish requests use `remi turn wrap-up`. Missing send input fails locally before
capability negotiation or any mutation.

## Deprecated aliases

`remi wiki lint` is deprecated since `0.2.58` with no CLI replacement. Wiki
review and organization now belong to Atlas lint mode; the legacy heuristic
scan remains hidden and executable for one release so in-flight task prompts
do not fail. It must be removed after that compatibility window.

All aliases below are deprecated since `0.3.0`. They remain executable for at
least one complete release cycle. Removal requires all supported platform and
daemon versions to advertise the canonical capability, prompt and skill audits
to remain clean, and a separately approved release change. Commands explicitly retired below have no executable alias.

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
| `remi issue session list` | `remi session list` | One-release compatibility alias |
| `remi issue session result list` | `remi session result list` | One-release compatibility alias |
| `remi issue session result publish` | `remi session result publish` | One-release compatibility alias |
| `remi issue archive list` | `remi session archive list` | One-release compatibility alias |
| `remi issue archive status` | `remi session archive status` | One-release compatibility alias |
| `remi issue archive verify` | `remi session archive verify` | One-release compatibility alias |
| `remi issue archive retry` | `remi session archive retry` | One-release compatibility alias |
| `remi issue attachment download` | `remi attachment download` | One-release compatibility alias |
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

Prompts and durable examples use message / inbox / turn commands. Folded messages
expand with `remi message get <message>`. Delegation is a directed request, progress
is a report. AskUserQuestion retains one original Q and uses the versioned
`remi message question` actions above; ordinary decision messages use
`--kind decision --option ...` and same-session `--reply-to <message>` replies.
Use `remi turn get --input --attempts` for
execution evidence. Session result publishing and project knowledge commands retain
their separate responsibilities.

`remi message list <conversation> --from X --to Y` reads the complete range
`X < seq ≤ Y`, automatically follows every page and rejoins long bodies without
truncating table output. Task credentials omit the requesting agent's own history.
Only contiguous range reads advance the agent's persistent high water; skipped
pages cannot mark an unread gap as read. Range flags cannot be combined with list
filters, limits or an explicit cursor.

`message send` treats a pair round-trip limit as a successful send (HTTP 200),
with `wake_applied=next_turn` and `wake_reason=pair_round_trip_limit`.
It reports the applied wake result, including six downgrade explanations:
`agent_pair_not_privileged`, `pair_round_trip_limit`, `dependencies_unmet`,
`self`, `recipient_unavailable` and `source_side_session`.
The message, inbox and turn APIs now call the S2 Store transaction methods.
See [the HTTP interface contract](dev/message-api.md) for the page integration
shapes, authenticated identities, pagination and decision replies.

`scripts/migrations/rewrite-retired-cli-commands.ts --dry-run` reports platform
instruction changes. Execute only after reviewing its entity / field / original /
replacement output; optimistic locking protects concurrent edits and successful
writes record an activity. This operator script never runs at startup.

## Retired in the unified model release (MUL-493)

Each entry remains in Registry and `cli-capabilities.json.retired`. Execution
raises one removal error before any network request. Old API routes return 410
with `code: route_retired` and a replacement. The reused inbox list/read paths
serve the new message and cursor contract. Old item IDs are rejected locally.

| Retired command | Replacement |
| --- | --- |
| `remi task create` | `remi message send --to <agent> --kind request` |
| `remi task continue` | `remi message send --to <agent> --kind request` |
| `remi session task create` | `remi message send <conversation> --to <agent> --kind request` |
| `remi issue rerun` | `remi message send <conversation> --to issue-owner --kind request --content <prompt>` |
| `remi task steer` | `remi message send --to <agent> (收尾用 remi turn wrap-up <turn>)` |
| `remi task steer list` | `remi message list <conversation> --unread-by <agent>` |
| `remi comment add` | `remi message send <conversation>` |
| `remi issue comment add` | `remi message send <conversation>` |
| `remi session message create` | `remi message send <conversation>` |
| `remi chat message create` | `remi message send <conversation>` |
| `remi chat attachment send` | `remi message send --attachment <path>` |
| `remi issue decision request` | `remi message send --kind decision --option <option>` |
| `remi issue decision answer` | `remi message question answer <question> --revision <route_revision> --data <json>` |
| `remi issue decision list` | `remi issue question list <issue>` |
| `remi issue decision escalate` | `remi message question escalate <question> --revision <route_revision> --reason <reason>` |
| `remi issue decision withdraw` | `remi message question close <question> --revision <route_revision> --reason <reason>` |
| `remi task request list` | `remi inbox` |
| `remi task request respond` | `remi message question answer <question> --revision <route_revision> --data <json>` |
| `remi comment list` | `remi message list <conversation>` |
| `remi comment update` | `remi message edit <message>` |
| `remi comment delete` | `remi message delete <message>` |
| `remi comment resolve` | `remi message resolve <message>` |
| `remi comment unresolve` | `remi message resolve <message> --no-resolved` |
| `remi comment reaction list` | `remi message get <message>` |
| `remi comment reaction add` | `remi message react <message> --emoji <emoji>` |
| `remi comment reaction remove` | `remi message react <message> --emoji <emoji> --remove` |
| `remi comment attachment list` | `remi message get <message>` |
| `remi session log get` | `remi message get <message>` |
| `remi session log window` | `remi message list <conversation>` |
| `remi session log locate` | `remi message get <message>` |
| `remi session event list` | `remi message list <conversation>` |
| `remi chat message list` | `remi message list <conversation>` |
| `remi chat queue list` | `remi message list <conversation> --unread-by <agent>` |
| `remi chat queue update` | `remi message edit <message>` |
| `remi chat queue remove` | `remi message delete <message>` |
| `remi chat queue clear` | `remi message list <conversation> --unread-by <agent> 后逐条 remi message delete <message>` |
| `remi chat queue prioritize` | `remi message delete <message> 后重新 remi message send <conversation>（按消息顺序）` |
| `remi chat pending` | `remi message list <conversation> --unread-by <agent>` |
| `remi chat read` | `remi inbox read <conversation>` |
| `remi inbox list` | `remi inbox` |
| `remi inbox page` | `remi inbox --limit <n> --cursor <cursor>` |
| `remi inbox summary` | `remi inbox` |
| `remi inbox unread-count` | `remi inbox` |
| `remi inbox archive` | `remi inbox read <conversation>` |
| `remi inbox mark-all-read` | `remi inbox read-all` |
| `remi inbox archive-all` | `remi inbox read-all` |
| `remi inbox archive-all-read` | `remi inbox read-all` |
| `remi inbox archive-completed` | `remi inbox read-all` |
| `remi task list` | `remi turn list` |
| `remi task get` | `remi turn get <turn>` |
| `remi task inspect` | `remi turn get <turn> --attempts` |
| `remi task cancel` | `remi turn cancel <turn>` |
| `remi task prompt` | `remi turn get <turn> --input` |
| `remi task redispatch` | `remi turn retry <turn> --cold` |
| `remi task trace read` | `remi turn trace read <turn>` |
| `remi task message list` | `remi turn trace read <turn>` |
| `remi task messages` | `remi turn trace read <turn>` |
| `remi issue run-messages` | `remi turn trace read <turn>` |
| `remi issue runs` | `remi turn list --issue <issue>` |
| `remi issue active-task` | `remi turn list --issue <issue>` |
| `remi issue cancel-task` | `remi turn cancel <turn>` |
| `remi session task list` | `remi turn list --session <conversation>` |
| `remi issue comment list` | `remi message list <conversation>` |
| `remi issue comment update` | `remi message edit <message>` |
| `remi issue comment delete` | `remi message delete <message>` |
| `remi issue comment resolve` | `remi message resolve <message>` |
| `remi issue comment unresolve` | `remi message resolve <message> --no-resolved` |
| `remi inbox read <inb_item>` | `remi inbox read <conversation> [--to <seq>]` |
