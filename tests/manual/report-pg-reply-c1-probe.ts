import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Row = { method: string; route: string; status: number | null; reason: string; bytes: number; maxReplyBytes: number };
type Scenario = { column: string; routeCount: number; rows: Row[] };
const directory = resolve(import.meta.dir, "../../reports/performance");
const load = (version: string): Scenario[] => JSON.parse(readFileSync(`${directory}/MUL-398-c1-r1-${version}-matrix.json`, "utf8"));
const baseline = load("main");
const current = load("head");
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
  multiremi_repository_wiki_docs: "RepositoryWikiRepo.get/list/readBodies",
  multiremi_gateway_models: "WorkspacesRepo.getGatewayModels",
  multiremi_autopilot_runs: "AutopilotsRepo.listRuns/getRun",
  multiremi_session_results: "IssueSessionsRepo.listIssueSessionResults/getSessionResult",
  multiremi_issue_activity: "IssuesRepo.listIssueActivity/listIssueTimeline",
  multiremi_task_human_requests: "TasksRepo.getTaskHumanRequest/listTaskHumanRequests",
  multiremi_issue_decisions: "IssuesRepo.getIssueDecision/listIssueDecisions",
  multiremi_task_steer_messages: "TasksRepo.listTaskSteerMessages/listPendingTaskSteerMessages",
  multiremi_knowledge_compilation_runs: "KnowledgeRepo.getRun/listRunsPage",
  multiremi_project_doc_revisions: "ProjectsRepo.listProjectDocRevisions",
  multiremi_repository_wiki_doc_revisions: "RepositoryWikiRepo.listRepositoryWikiDocRevisions",
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
writeFileSync(`${directory}/MUL-398-c1-r1-route-matrix.json`, JSON.stringify(pairs, null, 2) + "\n");
const groups = pairs.map(scenario => ({
  column: scenario.column,
  reader: readers[scenario.column.split(".")[0]!] ?? "See static audit",
  regressions: scenario.rows.filter(row => success(row.main.status) && row.head.status !== null && row.head.status >= 500),
  changes: scenario.rows.filter(row => row.main.status !== row.head.status),
  maxReplyBytes: Math.max(...scenario.rows.map(row => row.main.maxReplyBytes)),
}));
const affected = new Set(groups.flatMap(group => group.regressions.map(row => row.route)));
const requests = pairs.reduce((sum, scenario) => sum + scenario.rows.length, 0);
const regressions = groups.reduce((sum, group) => sum + group.regressions.length, 0);
const content = [
  "## Isolated Column Matrix",
  "",
  `${pairs.length} isolated column scenarios, ${requests} GET/HEAD requests per version (${requests * 2} total). Across scenarios: ${regressions} main 2xx -> head 5xx observations, ${affected.size} distinct patterns. The raw paired JSON has every route's status, maximum single reply size and skip/error reason for both versions. A path appearing under several roots is deliberately retained in each root group.`,
  "",
  "| Root column | Reader | GET patterns with main 2xx -> head 5xx | Observed maximum reply bytes |",
  "|---|---|---|---:|",
  ...groups.map(group => `| \`${group.column}\` | ${group.reader} | ${new Set(group.regressions.map(row => row.route)).size} | ${group.maxReplyBytes} |`),
  "",
  ...groups.filter(group => group.regressions.length).flatMap(group => [
    `### ${group.column}`, "", `Read path: ${group.reader}.`, "",
    "| Pattern | main GET/HEAD | head GET/HEAD | Largest main/head reply bytes |",
    "|---|---|---|---:|",
    ...[...new Set(group.regressions.map(row => row.route))].map(route => {
      const rows = group.regressions.filter(row => row.route === route);
      return `| \`${route}\` | ${rows.map(row => row.main.status).join("/")} | ${rows.map(row => row.head.status).join("/")} | ${Math.max(...rows.map(row => row.main.maxReplyBytes))}/${Math.max(...rows.map(row => row.head.maxReplyBytes))} |`;
    }), "",
  ]),
];
const report = `${directory}/MUL-398-c1-r1-route-probe.md`;
const original = readFileSync(report, "utf8").split("\n## Isolated Column Matrix")[0]!;
const markdown = `${original}\n${content.join("\n")}\n`;
writeFileSync(report, markdown);
const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
writeFileSync(`${directory}/MUL-398-c1-r1-route-probe.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MUL-398 C-1 Route Probe</title><style>body{margin:24px;background:#fff;color:#202124;font:14px/1.5 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;max-width:1280px;margin:auto}</style><body><pre>${escape(markdown)}</pre></body></html>\n`);
console.log(JSON.stringify({ scenarios: pairs.length, requestsPerVersion: requests,
  regressionObservations: regressions, affectedPatterns: affected.size,
  groups: groups.filter(group => group.regressions.length).map(group => ({ column: group.column, patterns: new Set(group.regressions.map(row => row.route)).size })) }));
