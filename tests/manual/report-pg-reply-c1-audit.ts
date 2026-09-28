import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DB_REPLY_TRANSITION_EXCEPTIONS } from "../../packages/server/src/observability/request-metrics.js";

type Audit = { tables: string; shape: string; caller: string };
const rules: Array<[RegExp, Audit]> = [
  [/POST \/api\/chat\/attachments\/send$/, {
    tables: "multiremi_tasks *: prompt, result, error；attachment metadata",
    shape: "task credential scope 的 getTask 单行整读；附件文件正文走外部存储",
    caller: "attachments.ts: task scope check → TasksRepo.getTask",
  }],
  [/\/inbox(?:\/|$)/, {
    tables: "multiremi_inbox_items: details；hydrate 关联 issue/comment/task 大列",
    shape: "legacy/list 全量；page 有行分页；summary 只投影 completed-run details 但集合仍无行/字节界，保守保留",
    caller: "inbox.ts → IssuesRepo.listInboxItems/listInboxItemsPage/getInboxSummary",
  }],
  [/\/decisions$/, {
    tables: "multiremi_issue_decisions *: body, options, answer；human_requests.payload",
    shape: "issue decision 集合无 LIMIT；human-request payload 集合辅助读取",
    caller: "issues.ts → IssuesRepo.listIssueDecisions",
  }],
  [/session-archives|session-archive$/, {
    tables: "multiremi_session_archives: metadata, last_error; workspace archive metadata",
    shape: "list SELECT * 无 LIMIT；get/init/verify/upload 回读单行；metadata 无字节 cap；归档文件正文在外部存储",
    caller: "session-archives.ts → SessionArchivesRepo.list/get/init/withWritableIssueArchive",
  }],
  [/\/dashboard\//, {
    tables: "multiremi_tasks t.*: usage, prompt, result, error；runtime/agent 关联标量",
    shape: "filteredUsageTaskRows 按时间/工作区筛选，无行 LIMIT；TS 聚合发生在全行读取之后",
    caller: "dashboard.ts → UsageRepo.filteredUsageTaskRows",
  }],
  [/GET .*\/tasks\/:[^/]+\/messages$/, {
    tables: "multiremi_task_messages *: content, input, output, meta；task getter",
    shape: "全量 SELECT *；since_seq 仅筛选，五个逻辑读取调用方均未传 limit",
    caller: "tasks.ts / daemon.ts → TasksRepo.listTaskMessages",
  }],
  [/\/inspection$/, {
    tables: "multiremi_task_messages *: content, input, output, meta；multiremi_tasks *",
    shape: "organizerTaskInspection 全量消息，无 LIMIT",
    caller: "tasks.ts → helpers/organizer.ts: organizerTaskInspection",
  }],
  [/GET \/api\/shares\//, {
    tables: "task_messages *: content/input/output/meta；session_events *: body/metadata；issue_comments: body",
    shape: "shareResponse 两分支均全量消息；全量 session events/timeline；无 LIMIT",
    caller: "issue-shares.ts: shareResponse",
  }],
  [/\/events$/, {
    tables: "multiremi_session_events *: body, metadata",
    shape: "seq 范围筛选，无 LIMIT；projection budget 是 SQL 读取之后的处理",
    caller: "issues.ts → IssueSessionsRepo.listSessionEvents",
  }],
  [/\/comments$/, {
    tables: "multiremi_issue_comments *: body",
    shape: "集合 SQL 无 LIMIT；CLI filter/slice/hard cap 均在读后",
    caller: "issues.ts → IssuesRepo.listIssueComments",
  }],
  [/\/timeline$/, {
    tables: "multiremi_issue_comments: body；multiremi_issue_activity: body, data",
    shape: "listIssueTimelinePage 有 SQL 行分页；仍含正文，行 LIMIT 不是字节上限",
    caller: "issues.ts → IssuesRepo.listIssueTimelinePage",
  }],
  [/\/session-results$/, {
    tables: "multiremi_session_results *: body, metadata",
    shape: "issue_id 集合 SELECT *，无 LIMIT",
    caller: "issues.ts → IssueSessionsRepo.listIssueSessionResults",
  }],
  [/\/knowledge\/submissions/, {
    tables: "multiremi_knowledge_submissions: body, patch；actor scope 可能取 autopilot_run *",
    shape: "列表已 LIMIT/投影；单条 getter 含 body/patch；POST actor 可解析整行 run；保留旧生产候选",
    caller: "knowledge.ts → KnowledgeRepo.listSubmissionsPage/getSubmission；submission actor resolution",
  }],
  [/\/knowledge\/runs/, {
    tables: "multiremi_knowledge_compilation_runs: result_summary；run_sources: metadata；关联project_docs: body；outputs标量",
    shape: "列表有 LIMIT/投影；详情 sources/outputs 无 LIMIT，关联 docs 可读正文；保留旧生产候选",
    caller: "knowledge.ts → KnowledgeRepo.listRunsPage/getRun/listRunSources/listRunOutputs",
  }],
  [/\/repository-wikis$/, {
    tables: "autopilot_runs 标量/条件 payload；repository_wiki_docs 元数据；compilations 八列",
    shape: "A/A2 去正文/整行读，最新 run SQL 排名；观测集合仍读所有有引用的完成行；当前 PG 模型 <1 MB，但保守保留",
    caller: "workspaces.ts → repository-wiki-outcome.ts / AutopilotsRepo / RepositoryWikiRepo",
  }],
  [/\/repos\/:repositoryId\/wiki/, {
    tables: "repository_wiki_docs / revisions: body；knowledge_compilation_runs: result_summary；autopilot_runs: payload, result, schedule_prompt",
    shape: "list 常规投影；include_body/legacy/batch/revision/正文和 mutation 辅助读仍可整行或无界；build 还 advance queued runs",
    caller: "workspaces.ts → RepositoryWikiService / AutopilotsRepo.advanceScheduledTargetRuns",
  }],
  [/\/projects\/:id\/(docs|knowledge)|\/project-docs|\/project-knowledge|\/knowledge\/migrate-legacy/, {
    tables: "multiremi_project_docs / project_doc_revisions: body, tags, refs；compilation sources metadata / outputs标量",
    shape: "list/recall/backlinks/migration/revisions 可全量正文；get 为单行正文；写入/发布涉及 get 与 doc graph 读取；无总字节界",
    caller: "projects.ts / knowledge.ts → ProjectsRepo / project-knowledge/service.ts: ProjectKnowledgeService",
  }],
  [/\/autopilots\/[^ ]*deliveries/, {
    tables: "multiremi_webhook_deliveries: raw_body, response_body, selected_headers, error；autopilot run *",
    shape: "list 行分页，raw_body 可显式包含；get/replay 单行全字段；无正文总字节界",
    caller: "autopilots.ts → AutopilotsRepo.listWebhookDeliveries/getWebhookDelivery",
  }],
  [/\/autopilot-runs|\/autopilots|\/scheduler$|\/knowledge\/events\/repository-merged/, {
    tables: "multiremi_autopilot_runs *: payload, result, schedule_prompt；autopilots: prompt, compiled_prompt",
    shape: "run list LIMIT 20/最大100，getter 单行仍带大列；autopilot 集合无字节界；触发/定时目标 queued SELECT * 无 LIMIT",
    caller: "autopilots.ts / daemon.ts / knowledge.ts → AutopilotsRepo.getAutopilotRun/listAutopilotRuns/advanceScheduledTargetRuns",
  }],
  [/\/cli\/context$/, {
    tables: "autopilot_runs */task_prompts/tasks: payload, result, schedule_prompt, prompt；context metadata",
    shape: "task scope 解析整行 run 与 prompt；单行未等于字节有界",
    caller: "cli.ts → task scope / build context / getAutopilotRun",
  }],
  [/\/chat\//, {
    tables: "multiremi_chat_messages: body/failure_reason；chat sessions .* + last-message excerpt；queued task rows",
    shape: "message/page 为全量 SQL 后 TS slice；POST 构建历史；session 列表 last body 已 SQL 截240字符；pending-tasks 已投影，缺本轮排除长样本，保守保留",
    caller: "chat.ts → ChatRepo.listChatMessages/getChatSession/listChatSessions / chat dispatch",
  }],
  [/\/multiremi\/chats/, {
    tables: "multiremi_chat_messages: body/failure_reason；chat sessions .* + last-message excerpt；tasks",
    shape: "legacy chat bundle/消息/历史读；TS 分页在 SQL 后；session 列表 last body 已 SQL 截240字符，缺本轮排除长样本，保守保留",
    caller: "chat.ts → ChatRepo.listChatMessages/getChatSession/listChatSessions / chat dispatch",
  }],
  [/\/prompt$/, {
    tables: "multiremi_task_prompts *: prompt；multiremi_tasks getter",
    shape: "task_id 单行；prompt 原文 cap 2 MiB，JSON 转义最坏六倍，可超过 8 MiB",
    caller: "tasks.ts / daemon.ts → TasksRepo.getTaskPrompt/recordTaskPrompt",
  }],
  [/\/tasks|\/agents\/:[^/]+\/tasks|recover-orphans/, {
    tables: "multiremi_tasks: prompt, result, error, usage；steer text / human-request options/response；session events",
    shape: "任务集合/单行 getter 或写后回读；部分 identity/status 投影已修，但 result/error 无字节界；claim 会投影读取全量 session events",
    caller: "tasks.ts / daemon.ts / agents.ts → TasksRepo / claim context projection",
  }],
  [/\/issues|\/inbox$/, {
    tables: "issues: description/metadata；comments: body；activity: body/data；tasks/session context: prompt/result/error",
    shape: "bundle 或任务集合/完整行辅助读；inbox summary 修复不代表 legacy inbox 完整集合字节有界",
    caller: "issues.ts / inbox.ts → IssuesRepo / task hydration",
  }],
];

const all = [...DB_REPLY_TRANSITION_EXCEPTIONS];
const observed = new Set(all.slice(0, 18));
const queuedEntries = new Set([
  "POST /api/multiremi/autopilots/:id/run", "POST /api/multiremi/autopilots/:id/run-scheduled",
  "POST /api/multiremi/autopilots/:id/trigger", "POST /api/workspaces/:id/repos/:repositoryId/wiki/build",
]);
const common = "C-2: 对应读有界/投影，修复同包或更早上线；有埋点单次 <6 MiB，至少三天含工作日高峰，Explorer 复核";
const rows = all.map(key => {
  let audit: Audit | undefined;
  let source = observed.has(key) ? "209 请求总量候选 + 审计" : "审计";
  let condition = common;
  if (key === "<background> <background>") {
    audit = { tables: "autopilot_runs *: schedule_prompt/payload/result；迁移/各后台读取",
      shape: "Scheduler.sync → advanceScheduledTargetRuns queued/active SELECT * 无 LIMIT；peer 有8行分页；启动迁移整表读取",
      caller: "Scheduler.sync / startup migrations / background reader checklist" };
    source = "续做裁定 + Senior cmt_tvxpad98uqtz";
    condition = "C-2: queued 读有界 AND v0.2.84+后台单次数据 <6 MiB；检查全部后台读者";
  } else if (["POST /api/daemon/tasks/:taskId/messages", "POST /internal/peer/events"].includes(key)) {
    audit = { tables: "multiremi_task_messages *: content/input/output/meta；task identity",
      shape: "MUL-462 按8行 SQL分页；例外为保留页大小/桥调用数，算法未改",
      caller: key.includes("/internal/") ? "peer.receive → realtime-fanout reference consumer" : "daemon.ts → TasksRepo.appendTaskMessages" };
    source = "续做裁定 + Senior cmt_tvxpad98uqtz";
    condition = "C-2: MUL-402 去掉该读 OR 另单按实际行宽算法；不必等三天";
  } else {
    audit = rules.find(([pattern]) => pattern.test(key))?.[1];
    if (/POST .*\/(run|run-scheduled|trigger|build)$/.test(key)) {
      condition += "；advanceScheduledTargetRuns queued 读必须有界";
    }
    if (queuedEntries.has(key)) {
      source = "审计 / Senior: advanceScheduledTargetRuns 无界读";
      condition = "与后台相同：C-2 queued 读有界 AND v0.2.84+后台单次数据 <6 MiB";
    }
  }
  if (!audit) throw new Error(`Missing audit for ${key}`);
  const cell = (value: string) => value.replaceAll("|", " / ").replaceAll("\n", " ");
  return `| \`${key}\` | ${source} | ${cell(audit.tables)} | ${cell(audit.shape)} | ${cell(audit.caller)} | 是，64 MiB；${condition} |`;
});

const report = `# MUL-398 C-1 最终例外逐条审计

基线 main \`b95dd2fa\`；机制与表以本 PR 当前代码为准。由 \`tests/manual/report-pg-reply-c1-audit.ts\` 读取集中 Set，生成 ${all.length} 项，避免表与代码漏项。HTTP 注册/实际 Hono origin 的逐项正式用例覆盖全部 HTTP 项；不存在静默删除、挂载前缀改写或参数名替换。

209 \`cmt_5ncm70lxe805\`：v0.2.83 无单次回包埋点。最先18行全部是 >500ms 慢请求内 **总** DB 字节 ≥6 MiB 的保守超集，并非单条超限证据；其余来自审计或续做/Senior裁定。快请求只能由源码审计覆盖。行 LIMIT、id 单行、读后裁剪均不能单独证明字节有界。

本轮没有排除已识别风险项，尤其 repository-wikis 保守保留；当前 PG 规模测量见正式报告。原文档/代码归属以下表具体 caller 和对应 repos 为依据，\`*\` 指整行或未去掉所列大列的读取。表中同一类辅助读取可能在鉴权、actor scope 或写后回读中执行，例外覆盖整个 method+pattern。

| method + Hono 模式 | 来源 | 表 / 大列 | LIMIT / 投影 / 字节界 | 具体调用方 | 是否进表 / 收回条件 |
|---|---|---|---|---|---|
${rows.join("\n")}

## Trace / 归档区别

本地/provider trace 与 session archive 文件正文走文件/对象存储，没有定位到一张承载 trace 正文的 PG 全量表。\`SessionArchivesRepo.list\` 仍全行返回 \`metadata\`，init 接受 metadata object 而未设置字节 cap，所以相关归档路由纳入例外；没有拿「正文在外部」推导 SQL metadata 安全。

## 64 MiB 边界

本轮长样本实测最大单次消息回包约24 MiB，queued 样本约10 MiB；未观测单次 ≥64 MiB。209 dashboard 58.42 MiB 为请求内所有 SQL 总和，不能当作单次。源码无界读仍可能增长至物理64 MiB以上，属于原有风险；没有声称全量未来数据永远不超64 MiB，C-1没有修这些读。
`;
writeFileSync(resolve(import.meta.dir, "../../reports/performance/MUL-398-c1-exception-audit.md"), report);
console.log(`Wrote ${all.length} exceptions (${all.length - 1} HTTP + background).`);
