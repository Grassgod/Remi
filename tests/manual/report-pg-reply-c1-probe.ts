import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Row = { method: string; route: string; status: number | null; reason: string; bytes: number; maxReplyBytes: number };
type Scenario = { column: string; routeCount: number; rows: Row[] };
const directory = resolve(import.meta.dir, "../../reports/performance");
const load = (version: string): Scenario[] => JSON.parse(readFileSync(`${directory}/MUL-398-c1-b-${version}-matrix.json`, "utf8"));
const baseline = load("main");
const current = load("enforced");
const success = (status: number | null): boolean => status !== null && status >= 200 && status < 300;
const readers: Record<string, string> = {
  multiremi_workspaces: "WorkspacesRepo.getWorkspace/listWorkspaces",
  multiremi_agents: "AgentsSkillsRepo.getAgent/listAgents",
  multiremi_projects: "ProjectsRepo.getProject/listProjects",
  multiremi_issues: "IssuesRepo.getIssue/listIssues",
  multiremi_skills: "AgentsSkillsRepo.getSkill/listSkills",
  multiremi_skill_files: "AgentsSkillsRepo.getSkillFiles",
  multiremi_task_messages: "TasksRepo.listTaskMessages",
  multiremi_task_prompts: "TasksRepo.getTaskPrompt",
  multiremi_tasks: "TasksRepo.getTask/listTasks/listTasksForIssue",
  multiremi_session_events: "IssueSessionsRepo.listSessionEvents",
  multiremi_issue_comments: "IssuesRepo.listIssueComments/listIssueTimeline",
  multiremi_chat_messages: "ChatRepo.listChatMessages",
  multiremi_message_messages: "MessagingRepo.listMessages/getMessage/listConversations",
  multiremi_message_sources: "MessagingRepo.listSources/getSource",
  multiremi_knowledge_submissions: "KnowledgeRepo.getSubmission/listSubmissions",
  multiremi_project_docs: "ProjectsRepo.listProjectDocs/getProjectDoc",
  multiremi_repository_wiki_docs: "RepositoryWikiRepo.getByRef/list/listWorkspace",
  multiremi_gateway_models: "WorkspacesRepo.getGatewayModels",
  multiremi_autopilot_runs: "AutopilotsRepo.listAutopilotRuns/getAutopilotRun",
  multiremi_session_results: "IssueSessionsRepo.listIssueSessionResults/getSessionResult",
  multiremi_issue_activity: "IssuesRepo.listIssueActivity/listIssueTimeline",
  multiremi_task_human_requests: "TasksRepo.getTaskHumanRequest/listTaskHumanRequests",
  multiremi_issue_decisions: "IssuesRepo.getIssueDecision/listIssueDecisions",
  multiremi_task_steer_messages: "TasksRepo.listTaskSteerMessages/listPendingTaskSteerMessages",
  multiremi_knowledge_compilation_runs: "KnowledgeRepo.getRun/listRunsPage",
  multiremi_project_doc_revisions: "ProjectsRepo.listProjectDocRevisions",
  multiremi_repository_wiki_doc_revisions: "MultiremiStore.listRepositoryWikiDocRevisions -> RepositoryWikiRepo.revisions",
  multiremi_agent_plugin_versions: "AgentPluginsRepo.getAgentPluginArtifactByDigest",
  multiremi_runtimes: "RuntimesRepo.getRuntime/listRuntimes",
  multiremi_runtime_models: "RuntimesRepo.listRuntimeModels",
  multiremi_runtime_model_list_requests: "RuntimesRepo.getRuntimeModelListRequest",
  multiremi_runtime_update_requests: "RuntimesRepo.getRuntimeUpdateRequest",
  multiremi_runtime_command_requests: "RuntimesRepo.getRuntimeCommandRequest",
  multiremi_runtime_directory_scan_requests: "RuntimesRepo.getRuntimeDirectoryScanRequest",
  multiremi_scm_change_requests: "ScmRepo.listChangeRequestsForIssue/getChangeRequest",
  multiremi_scm_events: "ScmRepo.getCanonicalEvent/listCanonicalEvents",
  multiremi_scm_event_evidence: "ScmRepo.listEventEvidence",
  multiremi_webhook_deliveries: "AutopilotsRepo.getWebhookDelivery/listWebhookDeliveries",
  multiremi_platform_operations: "PlatformOperationsRepo.list/get",
  multiremi_attachments: "IssuesRepo.getAttachment/listAttachmentsForIssue",
  multiremi_session_archives: "SessionArchivesRepo.list/get",
  multiremi_squads: "SquadsRepo.getSquad/listSquads",
  multiremi_message_connections: "MessagingRepo.getConnection/listConnections",
};
const pairs = baseline.map((scenario, index) => {
  const after = current[index];
  if (after?.column !== scenario.column || after.rows.length !== scenario.rows.length) throw new Error("Unpaired fixture matrix");
  return { column: scenario.column, rows: scenario.rows.map((before, rowIndex) => {
    const head = after.rows[rowIndex]!;
    if (head.method !== before.method || head.route !== before.route) throw new Error("Unpaired runtime routes");
    return { method: before.method, route: before.route,
      main: { status: before.status, bytes: before.bytes, maxReplyBytes: before.maxReplyBytes, reason: before.reason },
      head: { status: head.status, bytes: head.bytes, maxReplyBytes: head.maxReplyBytes, reason: head.reason } };
  }) };
});
const full = Object.fromEntries(["main", "observe", "enforced"].map(version => [version,
  JSON.parse(readFileSync(`${directory}/MUL-398-c1-b-${version}-routes.json`, "utf8")) as { routeCount: number; rows: Row[] },
])) as Record<string, { routeCount: number; rows: Row[] }>;
const fullPairs = full.main!.rows.map((main, index) => {
  const observe = full.observe!.rows[index]!;
  const enforced = full.enforced!.rows[index]!;
  if (main.route !== observe.route || main.method !== observe.method || main.route !== enforced.route || main.method !== enforced.method) {
    throw new Error("Unpaired full-fixture routes");
  }
  return { method: main.method, route: main.route,
    main: { status: main.status, bytes: main.bytes, maxReplyBytes: main.maxReplyBytes, reason: main.reason },
    observe: { status: observe.status, bytes: observe.bytes, maxReplyBytes: observe.maxReplyBytes, reason: observe.reason },
    enforced: { status: enforced.status, bytes: enforced.bytes, maxReplyBytes: enforced.maxReplyBytes, reason: enforced.reason } };
});
const observeChanges = fullPairs.filter(row => row.main.status !== row.observe.status);
if (observeChanges.length) throw new Error(`Observe mode changed ${observeChanges.length} statuses`);
writeFileSync(`${directory}/MUL-398-c1-b-route-matrix.json`, JSON.stringify({ completeFixture: fullPairs, isolatedColumns: pairs }, null, 2) + "\n");
const groups = pairs.map(scenario => ({
  column: scenario.column,
  reader: readers[scenario.column.split(".")[0]!] ?? "See static audit",
  regressions: scenario.rows.filter(row => success(row.main.status) && row.head.status !== null && row.head.status >= 500),
  blocked: scenario.rows.filter(row => success(row.main.status) && row.head.status !== null && !success(row.head.status)),
  changes: scenario.rows.filter(row => row.main.status !== row.head.status),
  maxReplyBytes: Math.max(...scenario.rows.map(row => row.main.maxReplyBytes)),
}));
const affected = new Set(groups.flatMap(group => group.regressions.map(row => row.route)));
const blockedPatterns = new Set(groups.flatMap(group => group.blocked.map(row => row.route)));
const requests = pairs.reduce((sum, scenario) => sum + scenario.rows.length, 0);
const regressions = groups.reduce((sum, group) => sum + group.regressions.length, 0);
if (groups.some(group => group.maxReplyBytes < 9 * 1_048_576)) throw new Error("A payload category was not read at >=9 MiB");
const coverage = (rows: Row[]) => ({
  requested: rows.filter(row => row.status !== null).length,
  successful: rows.filter(row => success(row.status)).length,
  skipped: rows.filter(row => row.status === null).length,
  statuses: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [String(status), rows.filter(row => row.status === status).length])),
});
const fullRegressions = fullPairs.filter(row => success(row.main.status) && row.enforced.status !== null && row.enforced.status >= 500);
const fullBlocked = fullPairs.filter(row => success(row.main.status) && row.enforced.status !== null && !success(row.enforced.status));
const writerArchive = readFileSync(`${directory}/MUL-398-c1-r1-route-probe.md`, "utf8");
const writerTable = writerArchive.slice(writerArchive.indexOf("| Root column(s) |"), writerArchive.indexOf("\n## Limits of this pass"));
const content = [
  "## Probe Results",
  "",
  `Complete runtime fixture: ${full.main!.routeCount} GET patterns, GET plus HEAD = ${fullPairs.length} requests per run. Main versus observe: **${observeChanges.length} status differences**. Main versus enforced: ${fullPairs.filter(row => row.main.status !== row.enforced.status).length} status differences, including ${fullRegressions.length} main 2xx -> 5xx requests (${new Set(fullRegressions.map(row => row.route)).size} patterns).`,
  `Enforced mode changes ${fullBlocked.length} successful requests (${new Set(fullBlocked.map(row => row.route)).size} patterns) to non-2xx. SCM events list maps its bridge rejection to 400; this is also a C-2 candidate.`,
  "",
  "| Full fixture mode | Requested | 2xx | Skipped | Status counts |",
  "|---|---:|---:|---:|---|",
  ...Object.entries(full).map(([mode, run]) => {
    const counts = coverage(run.rows);
    return `| ${mode} | ${counts.requested} | ${counts.successful} | ${counts.skipped} | ${JSON.stringify(counts.statuses)} |`;
  }),
  "",
  "All runtime GET patterns were requested. Non-2xx rows were exercised, not silently skipped; they are not claims of successful fixture coverage. Each reason and each route's maximum single reply is retained in the raw attachment. Baseline Lark-login 503 is expected without integration configuration.",
  "",
  "### Transcript Floor",
  "",
  "| Pattern | Method | Main / observe | Largest main / observe single reply bytes |",
  "|---|---|---|---:|",
  ...fullPairs.filter(row => /\/tasks\/.+\/messages$|^\/api\/shares\/:token$|\/sessions\/.+\/events$|^\/api\/chat\/sessions\/.+\/messages$/.test(row.route))
    .map(row => `| \`${row.route}\` | ${row.method} | ${row.main.status} / ${row.observe.status} | ${row.main.maxReplyBytes} / ${row.observe.maxReplyBytes} |`),
  "",
  "### Non-Success Coverage And Reasons",
  "",
  "| Pattern | Method | Main / observe / enforced | Reason on main |",
  "|---|---|---|---|",
  ...fullPairs.filter(row => !success(row.main.status)).map(row => `| \`${row.route}\` | ${row.method} | ${row.main.status} / ${row.observe.status} / ${row.enforced.status} | ${row.main.reason} |`),
  "",
  "### Full-Fixture Status Differences With Enforcement",
  "",
  "| Pattern | Method | Main -> enforced | Largest main / enforced single reply bytes |",
  "|---|---|---|---:|",
  ...fullPairs.filter(row => row.main.status !== row.enforced.status).map(row => `| \`${row.route}\` | ${row.method} | ${row.main.status} -> ${row.enforced.status} | ${row.main.maxReplyBytes} / ${row.enforced.maxReplyBytes} |`),
  "",
  "### Isolated Column Matrix",
  "",
  `${pairs.length} isolated column scenarios, ${requests} GET/HEAD requests per version (${requests * 2} total). Across scenarios: ${regressions} main 2xx -> enforced 5xx observations, ${affected.size} distinct patterns. Including the SCM 400 gives ${blockedPatterns.size} successful patterns blocked. These are C-2 candidates, not exception additions. A path appearing under several roots remains in each root group.`,
  "",
  "| Root column | Reader | GET patterns with main 2xx -> enforced non-2xx | Observed maximum reply bytes |",
  "|---|---|---|---:|",
  ...groups.map(group => `| \`${group.column}\` | ${group.reader} | ${new Set(group.blocked.map(row => row.route)).size} | ${group.maxReplyBytes} |`),
  "",
  ...groups.filter(group => group.blocked.length).flatMap(group => [
    `### ${group.column}`, "", `Read path: ${group.reader}.`, "",
    "| Pattern | main GET/HEAD | enforced GET/HEAD | Largest main/enforced reply bytes |",
    "|---|---|---|---:|",
    ...[...new Set(group.blocked.map(row => row.route))].map(route => {
      const rows = group.blocked.filter(row => row.route === route);
      return `| \`${route}\` | ${rows.map(row => row.main.status).join("/")} | ${rows.map(row => row.head.status).join("/")} | ${Math.max(...rows.map(row => row.main.maxReplyBytes))}/${Math.max(...rows.map(row => row.head.maxReplyBytes))} |`;
    }), "",
  ]),
  "## Writer Bounds",
  "",
  "The CLI forwards these text fields to their API guards. Limits below were reviewed read-only; SQL seeding bypasses writer caps. Uncapped workspace context is writable through ordinary API/CLI calls within the transport's body limit. Polling message ingest also bypasses the webhook-only 256 KiB ingress cap.",
  "",
  writerTable,
];
const report = `${directory}/MUL-398-c1-b.md`;
const original = readFileSync(report, "utf8").split("\n## Probe Results")[0]!;
const markdown = `${original}\n${content.join("\n").trimEnd()}\n`;
writeFileSync(report, markdown);
const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
writeFileSync(`${directory}/MUL-398-c1-b.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MUL-398 C-1 Ruling B</title><style>body{margin:24px;background:#fff;color:#202124;font:14px/1.5 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;max-width:1280px;margin:auto}</style><body><pre>${escape(markdown)}</pre></body></html>\n`);
console.log(JSON.stringify({ scenarios: pairs.length, requestsPerVersion: requests,
  regressionObservations: regressions, affectedPatterns: affected.size, blockedPatterns: blockedPatterns.size,
  groups: groups.filter(group => group.blocked.length).map(group => ({ column: group.column, patterns: new Set(group.blocked.map(row => row.route)).size })) }));
