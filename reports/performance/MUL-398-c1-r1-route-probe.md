# MUL-398 C-1: decision-independent route probe archive

Status: measurement only. No exception was added for the new non-messaging findings, and the 8 MiB default/rejection policy was not changed. Strategy is awaiting Senior's ruling. This report follows the stop record `MUL-398-c1-r1-rework-stop.md`.

## Reproduction and scope

- Baseline: main `889efdeb`; comparison: managed `agent/MUL-398` after merging that main, with the archived HEAD mapping and 15 QA messaging exceptions. The merge had no textual conflict.
- A self-owned PostgreSQL 15.19 loopback instance supplied a separate, identically seeded database to each version. The complete `createMultiremiApp` runtime registration had 776 routes, including 329 distinct GET patterns. Every pattern received GET and HEAD once per version: 658 requests per version, 1,316 in the pair. No production or external service was called. Each request had a 20 s timeout.
- The worker bridge serializes `JSON.stringify({rows,count})`. The probe wraps `PgBridge.exec` locally and measures the same serialization for successful SQL; `api_db_reply_rejected.bytes` supplies the exact length for refused SQL. `maxReplyBytes` in the raw JSON is the largest single bridge reply seen while that request ran, not HTTP response length or aggregate `db_bytes`.
- Raw, sanitized per-request output: `MUL-398-c1-r1-main-routes.json` and `MUL-398-c1-r1-head-routes.json`. Each row has method, Hono route pattern, status, response bytes, maximum single DB reply bytes, and a reason. The files contain no real path parameters, SQL, body, authorization data, or connection string.

## Fixture and coverage

The schema-driven scanner found 132 tables and 1,562 TEXT/JSON/BLOB columns after MUL-487. It reported 308 conservative, unreviewed call candidates and four loop-registered routes it cannot map; this is a manual report, not a failing CI gate. The initial cumulative fixture covered the domains below; the final isolated matrix extends this to 57 representative columns, including runtime requests, plugin artifacts, SCM, revisions, decisions and platform operations. Task messages total 24 MiB through 96 rows of 256 KiB, within the current per-row writer cap. Every isolated category must produce a >=9 MiB reply on main; this tests payload categories, **not all 1,562 individual columns**. `multiremi_project_resources` appears as a join alongside a long project doc and is not claimed as its own long fixture.

| Category / seeded table | Example route exercising the row | Observed single reply, bytes |
|---|---|---:|
| Workspace context, `multiremi_workspaces` | `GET /api/workspaces/:id` | 9,437,521 |
| Agent instructions, `multiremi_agents` | `GET /api/multiremi/chats/:id` | 9,437,825 |
| Project instructions, `multiremi_projects` | `GET /api/projects/:id/docs` | 9,437,806 |
| Issue description, `multiremi_issues` | `GET /api/issues/:id` | 9,437,903 |
| Skill body and file, `multiremi_skills`, `multiremi_skill_files` | `GET /api/skills/:id/files` | 9,437,440 / 9,437,383 |
| Task transcript, `multiremi_task_messages` | `GET /api/tasks/:taskId/messages` | 25,185,987 |
| Assembled prompt, `multiremi_task_prompts` | `GET /api/tasks/:taskId/prompt` | 9,437,325 |
| Session event, `multiremi_session_events` | `GET /api/issues/:id/sessions/:sessionId/events` | 9,437,729 |
| Issue comment, `multiremi_issue_comments` | `GET /api/issues/:id/comments` | 9,437,533 |
| Chat message, `multiremi_chat_messages` | `GET /api/chat/sessions/:sessionId/messages` | 9,437,451 |
| Messaging text/raw, `multiremi_message_messages` | `GET /api/workspaces/:workspaceId/messaging/messages` | 9,437,960 |
| Messaging allowlist, `multiremi_message_sources` | `GET /api/workspaces/:workspaceId/messaging/sources` | 9,437,840 |
| Knowledge submission, `multiremi_knowledge_submissions` | `GET /api/knowledge/submissions/:id` | 9,437,648 |
| Project doc, `multiremi_project_docs` | `GET /api/projects/:id/docs/:ref` | 9,437,806 |
| Repository wiki doc, `multiremi_repository_wiki_docs` | `GET /api/workspaces/:id/repos/:repositoryId/wiki/:ref` | 9,437,788 |
| Gateway model JSON, `multiremi_gateway_models` | `GET /api/workspaces/:id/relay-config/:engine/reasoning-levels` | 9,437,452 |
| Autopilot payload/result, `multiremi_autopilot_runs` | `GET /api/autopilots/:id/runs` | 18,874,893 |

The values above are per-table observations from the baseline; a route may issue several SQL statements and its per-request maximum can come from another seeded table. The raw JSON is authoritative for each route's maximum. The task prompt, project instructions, and gateway snapshot rows bypass normal writers; their actual writer limits are below.

The initial cumulative fixture returned 482/658 2xx on main. The other 176 requests were exercised but not fixture-covered success paths: 143 returned 404 (missing dependent id or route-specific record), 10 returned 400 (missing extra input), 14 returned 401/403 (actor scope), 1 returned 405, 6 returned 426, and 2 returned 503 (`/auth/lark/url`, which lacks integration configuration). Both GET and HEAD rows and their individual reason appear in the initial raw JSON. There were zero unrequested patterns and zero probe timeouts. Head returned 424/658 2xx, 66 5xx, and 64 `api_db_reply_rejected` events. These numbers are retained as the initial observation, not the final matrix's coverage. The final fixture creates dependent records, supplies a signed CLI share header, and uses valid knowledge compilation modes/statuses; final coverage is tabulated below.

## Main 2xx to head 5xx

All 58 transitions were 200 -> 500, across 29 patterns, GET and HEAD for each. In both versions the largest single reply was identical. These are **not** new exception entries pending the policy decision.

| Root column and read method | Affected GET patterns | Reply size |
|---|---|---:|
| `multiremi_workspaces.context` TEXT; `WorkspacesRepo.listWorkspaces/getWorkspace` `SELECT *` | `/api/daemon/workspaces/:workspaceId/repos`; `/api/workspaces`; `/api/workspaces/:id`; `/:id/organizer`; `/:id/issue-topics`; `/:id/bot-menu`; `/:id/prompts`; `/:id/prompt-template`; `/:id/repos`; `/:id/env`; `/:id/ssh-mesh`; `/:id/relay-config`; `/:id/feishu-bot/status`; `/:id/feishu-bot/routes`; `/:id/feishu-bot/senders`; `/:id/members`; `/:id/invitations`; `/:id/issue-archive`; `/api/multiremi/platform/config`; `/api/multiremi/platform/status`; `/api/multiremi/platform/operations` (21 patterns) | 9,437,521 |
| `multiremi_message_sources.allowlist` TEXT/JSON; `MessagingRepo.listSources/getSource` full-row reads | `/api/workspaces/:workspaceId/messaging/connections`; `/messaging/sources`; `/messaging/sources/:sourceId`; `/messaging/sources/:sourceId/status`; `/feishu/endpoints`; `/feishu/sources`; `/feishu/sources/:sourceId`; `/feishu/sources/:sourceId/status` under the same workspace prefix (8 patterns) | 9,437,840 |

Six further requests changed from an existing non-2xx result to 500 before that result could be formed: GET+HEAD `/api/workspaces/:workspaceId/messaging/sources/:sourceId/available-conversations` and Feishu `available-chats` (400 -> 500, allowlist), and `/api/workspaces/:id/feishu-bot/chats` (404 -> 500, workspace context). These are separate from the 58 success-to-error transitions.

## New main route and write-side bounds

MUL-487 added `POST /api/daemon/tasks/:taskId/human-requests/:requestId/card`. It calls `getTaskHumanRequest`, which selects the whole `multiremi_task_human_requests` row by id; `payload` and `response` are unconstrained TEXT columns. This is a new candidate for Senior's chosen policy. It was not added to the exception set or exercised as a write route in this decision-independent pass. Its targeted auth and card tests remain CI's responsibility.

Application writer review below distinguishes count/character limits from a per-column byte cap. Direct SQL seeding intentionally bypasses these writers, so a synthetic 9 MiB row does not prove ordinary clients can create it.

The CLI does not add a separate length guard to these fields: for example `workspace update --context` is forwarded as the API body (`apps/remi/cli/commands/workspace.ts:515-533`) and project instructions are forwarded at `apps/remi/cli/commands/project.ts:228-236`. The server-side caps below therefore still apply to CLI callers. The daemon message endpoint caps each batch at 256 rows; its repo also truncates the stored fields, as shown below. No general application request-body size guard was found in `packages`/`apps`; specific webhook/upload limits are separate.

| Root column(s) | Application write path | Application length limit |
|---|---|---|
| `workspaces.context` | `PUT /api/workspaces/:id` -> `WorkspacesRepo.updateWorkspace` | None; direct assignment (`workspaces-repo.ts:575`). A 9 MiB context is application-reachable. |
| `agents.instructions` | agent create/update -> `AgentsSkillsRepo.updateAgent` | No instruction byte cap found; description alone is limited to 255 chars (`api/helpers/agents.ts:48`). |
| `projects.instructions` | project create/update -> `validateProjectInstructions` | 4,000 Unicode characters (`api/helpers/projects.ts:16-23`); the 9 MiB direct-SQL row is writer-inaccessible. |
| `issues.description` | issue create/update -> `IssuesRepo` | No description byte cap found; metadata has a separate 8 KiB cap (`issues-repo.ts:7032`). |
| `skills.content`, `skill_files.content` | skill create/update -> `AgentsSkillsRepo`, `normalizeSkillFiles` | Path and encoding checked, no content byte cap (`agents-skills-repo.ts:871-890`). |
| `task_messages.content/input/output/meta` | daemon POST messages -> `TasksRepo.appendTaskMessages` | 256 rows per request; repo truncates content/input to 256 KiB each and output/meta to 64 KiB each (`tasks-repo.ts:4279-4288,6758-6769`). A 24 MiB collection remains reachable through 96 content rows of 256 KiB. |
| `tasks.prompt/result/usage` | task creation; daemon complete / usage -> `TasksRepo` | No prompt/result byte cap on these task-row fields; usage numbers are normalized but model/provider strings and total entries have no byte cap (`api/helpers/tasks.ts:21-38`). This is distinct from the bounded assembled prompt artifact below. |
| `task_prompts.prompt` | `TasksRepo.recordTaskPrompt` | 2 MiB UTF-8 bytes (`tasks-repo.ts:174,4340`); 9 MiB direct-SQL row is writer-inaccessible. |
| `session_events.body/metadata` | `IssueSessionsRepo.appendSessionEventWithinTransaction` | No body/metadata byte cap (`issue-sessions-repo.ts:376-401`). |
| `issue_comments.body` | `IssuesRepo.createIssueComment` | Requires nonblank text; no byte cap (`issues-repo.ts:4556-4595`). |
| `chat_messages.body` | `ChatRepo.appendChatMessageWithinTransaction` | No body byte cap (`chat-repo.ts:437-475`). |
| `message_messages.searchable_text/raw/conversation_name` | messaging ingest and Feishu compatibility -> `MessagingRepo.ingestMessages` | No stored-field byte cap found (`messaging-repo.ts:363-365,953-986`); webhook ingress alone caps its whole body at 256 KiB (`api/helpers/webhooks.ts:14`), polling/other ingest paths are separate. |
| `message_sources.allowlist/name` | messaging source create/update -> `normalizeAllowlist`, `MessagingRepo.upsertSource` | Checks array shape and dedupes ids, no entry or total byte cap (`api/routers/messaging.ts:764-787`). |
| `knowledge_submissions.body/patch` | knowledge submit -> `KnowledgeRepo.createSubmission` | No body/patch byte cap (`knowledge-repo.ts:113-153`). |
| `project_docs.body` | project doc create/update -> `ProjectsRepo` | No per-doc body byte cap found (`projects-repo.ts:953`). |
| `repository_wiki_docs.body` | wiki create/update/batch -> `RepositoryWikiRepo` | Batch/read row count is bounded, but no per-doc body byte cap (`repository-wiki-repo.ts:248`). |
| `gateway_models.models` | relay discovery -> `WorkspacesRepo.saveGatewayModels` | Default gateway HTTP response is capped at 1,000,000 bytes (`relay/discovery.ts:10,35`); the 9 MiB direct-SQL snapshot is not reachable through default discovery. Store writer itself has no independent cap. |
| `autopilot_runs.payload/result/schedule_prompt` | autopilot enqueue/finish -> `AutopilotsRepo` | No JSON/prompt byte cap found (`autopilots-repo.ts:440`); failure message alone is truncated to 1,000 chars (`autopilots-repo.ts:990`). |
| `task_human_requests.payload/response` | daemon human request/response, new card read | No per-field byte cap found (`tasks-repo.ts:3968`); GET reads are measured in the final matrix, while the new card POST is deferred. |
| `workspaces.settings` | workspace update -> `WorkspacesRepo.updateWorkspace` | JSON serialization without a total byte cap (`workspaces-repo.ts:579-581`). API sanitizes specific progress/auto-title settings, not total JSON size. |
| `projects.delta_instructions` | project update -> `validateProjectInstructions` | Same 4,000-Unicode-character API guard as instructions (`api/helpers/projects.ts:30-31`). |
| `session_results.body` | `IssueSessionsRepo.publishSessionResult` | No body byte cap (`issue-sessions-repo.ts:669-720`). |
| `issue_activity.body/data` | `IssuesRepo.appendIssueActivity` | No total body/JSON byte cap (`issues-repo.ts:5942`). |
| `issue_decisions.body/options` | decision create -> `IssuesRepo.createIssueDecision` | Title <=500 chars; options must be strings; no body/option byte cap (`issues-repo.ts:583-606`). |
| `task_steer_messages.content` | task steer -> `TasksRepo` | No stored content byte cap found (`tasks-repo.ts`, steer insertion). |
| `knowledge_compilation_runs.result_summary` | `KnowledgeRepo.completeRun` | No summary byte cap (`knowledge-repo.ts:244-257`). |
| `project_doc_revisions.body`, `repository_wiki_doc_revisions.body` | doc/wiki revision creation | No per-revision body byte cap; revision count limits do not limit bytes. |
| `agent_plugin_versions.artifact_json` | `buildAgentPluginArtifact` -> version insert | Artifact files <=2,000 and decoded bytes <=25 MiB (`agent-plugins/import.ts:9-10,113-115`), so a 9 MiB artifact is possible. JSON/base64 encoding can increase stored size. |
| `runtimes.metadata` | runtime register/update -> `normalizeRuntimeMetadata` | 8 KiB serialized JSON (`runtimes-repo.ts:2610-2617`); 9 MiB direct-SQL row is writer-inaccessible. |
| `runtime_models.catalog` | `normalizeRuntimeModelCatalog` | Ready is only a status object; error text <=200 chars (`runtimes-repo.ts:2682-2686`); 9 MiB direct-SQL catalog is writer-inaccessible. |
| `runtime_model_list_requests.models` | daemon model report -> `reportRuntimeModelListResult` | Models normalized, but array and model/label/reasoning strings have no aggregate byte cap (`runtimes-repo.ts:1295-1327,2663-2678`). |
| `runtime_update_requests.output` | daemon update report -> `reportRuntimeUpdateResult` | Direct assignment, no output byte cap (`runtimes-repo.ts:1460-1481`). |
| `runtime_command_requests.stdout` | daemon command report -> `normalizeRuntimeCommandOutput` | 64 KiB stored output (`runtime-command-safety.ts:1,31-34`); 9 MiB direct-SQL output is writer-inaccessible. |
| `runtime_directory_scan_requests.candidates` | daemon directory report -> `RuntimesRepo` | No aggregate candidate JSON byte cap found; input/path shape validation is separate. |
| `scm_change_requests.body`, `scm_events.payload`, `scm_event_evidence.raw_body` | SCM snapshot/change/event ingest -> `ScmRepo` | Stored payload/raw body have no repo byte cap (`scm-repo.ts:898,1079,1108`). Webhook ingress limits and external provider limits are separate; provider limits were not audited. |
| `webhook_deliveries.raw_body` | webhook ingest -> `AutopilotsRepo` | HTTP webhook ingress <=256 KiB (`api/helpers/webhooks.ts:14,111`); store has no independent per-field cap. The 9 MiB HTTP-ingress sample is writer-inaccessible. |
| `platform_operations.output` | `PlatformOperationsRepo.report` | Direct output assignment, no byte cap (`platform-operations-repo.ts:277-303`). |
| `attachments.filename` | attachment reference/create -> `IssuesRepo.createAttachment` | Repo requires nonblank filename, no byte cap (`issues-repo.ts:5694-5734`). Upload path sanitization/file limits are separate. |
| `session_archives.metadata` | archive metadata registration -> `SessionArchivesRepo` | No total JSON byte cap in repo registration (`session-archives-repo.ts:315`); archive content lives outside SQL. |
| `squads.instructions` | squad create/update -> `SquadsRepo` | No instruction byte cap found (`squads-repo.ts:21`). |
| `message_connections.config` | messaging connection upsert -> `MessagingRepo.upsertConnection` | No total config JSON byte cap found; provider configuration validation is separate. |

## Limits of this pass

The runtime GET/HEAD list is complete. The initial 176 non-2xx requests were narrowed by extending the relational fixture; the final matrix still records every non-success path and its reason. The 1,562 schema columns include identifiers, timestamps, enums, credentials and internal lifecycle records; this pass tests 57 representative payload columns rather than claiming byte reachability for every schema field. The measured transition list is an observed lower bound, not proof that the exception table is complete. Ten messaging POST routes and browser pages were deliberately deferred pending Senior's policy decision. The app's static AST route audit remains report-only; `--enforce` can still fail on unreviewed conservative candidates, but CI does not treat them as proven omissions.
