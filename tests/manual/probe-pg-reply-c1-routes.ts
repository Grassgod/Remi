import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const rootFlag = process.argv.indexOf("--root");
const outFlag = process.argv.indexOf("--out");
const scenarioFlag = process.argv.indexOf("--scenario");
const scenario = scenarioFlag < 0 ? null : process.argv[scenarioFlag + 1];
const sourceRoot = rootFlag < 0 ? resolve(import.meta.dir, "../..") : resolve(process.argv[rootFlag + 1] ?? "");
const output = outFlag < 0 ? null : process.argv[outFlag + 1];
const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
if (!output || !adminUrl || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl).hostname)) {
  throw new Error("A loopback PostgreSQL target and --out are required");
}
delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
if (process.argv.includes("--enforce")) process.env.MULTIREMI_PG_REPLY_ENFORCE = "1";
else delete process.env.MULTIREMI_PG_REPLY_ENFORCE;

const { createMultiremiApp } = await import(`${sourceRoot}/packages/server/src/api/server.ts`);
const { MultiremiStore } = await import(`${sourceRoot}/packages/server/src/store/store.ts`);
const { PostgresSyncDatabase } = await import(`${sourceRoot}/packages/server/src/store/db/postgres.ts`);
const admin = new Bun.SQL(adminUrl, { max: 1 });
const name = `mul398_c1_routes_${process.pid}`;
await admin.unsafe(`CREATE DATABASE ${name}`);
const url = new URL(adminUrl);
url.pathname = `/${name}`;
let db: InstanceType<typeof PostgresSyncDatabase> | undefined;

try {
  db = new PostgresSyncDatabase(url.toString());
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const agent = store.createAgent({ name: "C1 route fixture", provider: "codex", workspaceId: "local" });
  const project = store.createProject({ title: "C1 route fixture", workspaceId: "local" });
  const issue = store.createIssue({ title: "C1 route fixture", workspaceId: "local", projectId: project.id });
  const session = store.createIssueSession(issue.id);
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "fixture" });
  const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: "local" });
  const skill = store.createSkill({ name: "C1 route fixture", content: "fixture", workspaceId: "local" });
  const runtime = store.registerRuntime({ id: "rt_c1", name: "Fixture", provider: "codex", workspaceId: "local", daemonId: "daemon_c1" });
  const squad = store.createSquad({ name: "Fixture", workspaceId: "local", creatorId: "local", leaderId: agent.id });
  store.updateWorkspace("local", { repos: [{ id: "repo_c1", name: "Fixture", url: "https://example.invalid/fixture.git" }] });
  const size = 9 * 1_048_576;
  const now = "2026-09-29T00:00:00.000Z";
  const artifactDigest = scenario === null || scenario === "multiremi_agent_plugin_versions.artifact_json"
    ? "1".repeat(64) : "fixture";
  for (const [table, column, id] of [
    ["multiremi_workspaces", "context", "local"],
    ["multiremi_agents", "instructions", agent.id],
    ["multiremi_projects", "instructions", project.id],
    ["multiremi_issues", "description", issue.id],
    ["multiremi_skills", "content", skill.id],
  ]) {
    db.prepare(`UPDATE ${table} SET ${column} = repeat('x', ?) WHERE id = ?`).run(size, id);
  }
  store.messaging.upsertConnection({ id: "mconn_c1", workspaceId: "local", provider: "feishu",
    channel: "feishu", name: "Fixture", status: "ready" });
  store.messaging.upsertSource({ id: "msrc_c1", workspaceId: "local", connectionId: "mconn_c1",
    name: "Fixture", allowlist: [{ externalConversationId: "conversation_c1", addedAt: "2026-09-29T00:00:00.000Z" }] });
  store.messaging.ingestMessages({ connectionId: "mconn_c1", sourceId: "msrc_c1", messages: [{
    externalMessageId: "message_c1", externalConversationId: "conversation_c1",
    conversationName: "Fixture", conversationKind: "group", externalThreadId: null,
    externalRootId: null, externalParentId: null,
    sender: { externalSenderId: "sender_c1", displayName: "Fixture", kind: "user", isSelf: false },
    text: "fixture", attachments: [], mentions: [], reactions: [], url: null,
    sentAt: "2026-09-29T00:01:00.000Z", editedAt: null, recalled: false, raw: {},
  }] });
  db.prepare("UPDATE multiremi_message_messages SET searchable_text = repeat('x', ?) WHERE external_message_id = ?")
    .run(size, "message_c1");
  db.prepare("UPDATE multiremi_message_sources SET allowlist = ? WHERE id = ?")
    .run(JSON.stringify([{ externalConversationId: "x".repeat(size), addedAt: "2026-09-29T00:00:00.000Z" }]), "msrc_c1");
  const messageRows = scenario && scenario !== "multiremi_task_messages.content" ? 3 : 96;
  for (let seq = 1; seq <= messageRows; seq++) {
    db.prepare("INSERT INTO multiremi_task_messages (id, task_id, seq, type, content, created_at) VALUES (?, ?, ?, 'text', repeat('x', ?), ?)")
      .run(`tmsg_c1_${seq}`, task.id, seq, 256 * 1024, now);
  }
  db.prepare("INSERT INTO multiremi_session_events (id, session_id, seq, author_type, body, created_at) VALUES (?, ?, 1000, 'member', repeat('x', ?), ?)")
    .run("sevt_c1", session.id, size, now);
  db.prepare("INSERT INTO multiremi_issue_comments (id, issue_id, issue_session_id, body, created_at, updated_at) VALUES (?, ?, ?, repeat('x', ?), ?, ?)")
    .run("cmt_c1", issue.id, session.id, size, now, now);
  db.prepare("INSERT INTO multiremi_chat_messages (id, chat_session_id, role, body, created_at) VALUES (?, ?, 'user', repeat('x', ?), ?)")
    .run("chatmsg_c1", chat.id, size, now);
  db.prepare("INSERT INTO multiremi_skill_files (id, skill_id, path, content, created_at, updated_at) VALUES (?, ?, 'fixture.md', repeat('x', ?), ?, ?)")
    .run("sfile_c1", skill.id, size, now, now);
  db.prepare("INSERT INTO multiremi_task_prompts (task_id, mode, prompt, sha256, assembled_at) VALUES (?, 'default', repeat('x', ?), 'fixture', ?)")
    .run(task.id, size, now);
  db.prepare("INSERT INTO multiremi_knowledge_submissions (id, workspace_id, project_id, scope, source_type, body, content_sha256, created_at, updated_at) VALUES (?, 'local', ?, 'project_wiki', 'external', repeat('x', ?), 'fixture', ?, ?)")
    .run("ksub_c1", project.id, size, now, now);
  db.prepare("INSERT INTO multiremi_project_docs (id, project_id, workspace_id, slug, path, title, body, created_at, updated_at) VALUES (?, ?, 'local', 'fixture', 'fixture.md', 'Fixture', repeat('x', ?), ?, ?)")
    .run("pdoc_c1", project.id, size, now, now);
  db.prepare("INSERT INTO multiremi_repository_wiki_docs (id, repository_id, workspace_id, path, title, body, created_at, updated_at) VALUES (?, 'repo_c1', 'local', 'fixture.md', 'Fixture', repeat('x', ?), ?, ?)")
    .run("rwdoc_c1", size, now, now);
  db.prepare("INSERT INTO multiremi_gateway_models (workspace_id, engine, models, updated_at) VALUES ('local', 'codex', ?, ?)")
    .run(JSON.stringify([{ id: "fixture", name: "Fixture", description: "x".repeat(size) }]), now);
  db.prepare("INSERT INTO multiremi_autopilots (id, title, assignee_id, workspace_id, created_at, updated_at) VALUES ('ap_c1', 'Fixture', ?, 'local', ?, ?)")
    .run(agent.id, now, now);
  db.prepare("INSERT INTO multiremi_autopilot_runs (id, autopilot_id, source, status, triggered_at, payload, result, created_at) VALUES ('aprun_c1', 'ap_c1', 'manual', 'completed', ?, ?, ?, ?)")
    .run(now, JSON.stringify({ data: "x".repeat(size) }), JSON.stringify({ data: "x".repeat(size) }), now);
  // Short relational rows let isolated payloads reach detail and collection readers.
  const fixtures: Array<[string, Record<string, unknown>]> = [
    ["multiremi_session_results", { id: "sresult_c1", issue_id: issue.id, source_session_id: session.id, body: "fixture", created_at: now }],
    ["multiremi_issue_activity", { id: "activity_c1", issue_id: issue.id, type: "comment", body: "fixture", data: "{}", created_at: now }],
    ["multiremi_task_human_requests", { id: "hreq_c1", task_id: task.id, kind: "question", payload: "{}", created_at: now }],
    ["multiremi_issue_decisions", { id: "decision_c1", workspace_id: "local", issue_id: issue.id, source_issue_id: issue.id, kind: "question", title: "Fixture", body: "fixture", options: "[]", created_at: now, updated_at: now }],
    ["multiremi_task_steer_messages", { id: "steer_c1", task_id: task.id, content: "fixture", created_at: now }],
    ["multiremi_knowledge_compilation_runs", { id: "krun_c1", workspace_id: "local", project_id: project.id, task_id: task.id, agent_id: agent.id, mode: "manual_edit", status: "published", result_summary: "fixture", created_at: now }],
    ["multiremi_project_doc_revisions", { id: "pdrev_c1", doc_id: "pdoc_c1", version: 1, title: "Fixture", body: "fixture", created_at: now }],
    ["multiremi_repository_wiki_doc_revisions", { id: "rwrev_c1", doc_id: "rwdoc_c1", version: 1, path: "fixture.md", title: "Fixture", body: "fixture", created_at: now }],
    ["multiremi_agent_plugins", { id: "plugin_c1", workspace_id: "local", provider: "codex", name: "Fixture", active_version_id: "pluginver_c1", created_at: now, updated_at: now }],
    ["multiremi_agent_plugin_versions", { id: "pluginver_c1", plugin_id: "plugin_c1", version: "1.0.0", manifest_path: "plugin.json", artifact_json: "{}", artifact_digest: artifactDigest, created_at: now }],
    ["multiremi_runtime_models", { runtime_id: runtime.id, model_id: "fixture", label: "Fixture", provider: "codex", created_at: now, updated_at: now }],
    ["multiremi_runtime_model_list_requests", { id: "models_c1", runtime_id: runtime.id, status: "completed", models: "[]", created_at: now, updated_at: now }],
    ["multiremi_runtime_update_requests", { id: "update_c1", runtime_id: runtime.id, status: "completed", scope: "daemon", target_version: "v0.0.0", created_at: now, updated_at: now }],
    ["multiremi_runtime_command_requests", { id: "command_c1", runtime_id: runtime.id, command: "fixture", args: "[]", redacted_command: "fixture", redacted_args: "[]", timeout_ms: 20000, status: "completed", created_at: now, updated_at: now }],
    ["multiremi_runtime_directory_scan_requests", { id: "scan_c1", runtime_id: runtime.id, status: "completed", params: "{}", candidates: "[]", created_at: now, updated_at: now }],
    ["multiremi_scm_connections", { id: "scmconn_c1", workspace_id: "local", name: "Fixture", provider: "github", enabled: 0, base_url: "https://example.invalid", api_base_url: "https://example.invalid", created_at: now, updated_at: now }],
    ["multiremi_scm_change_requests", { id: "cr_c1", workspace_id: "local", connection_id: "scmconn_c1", repository_id: "repo_c1", provider: "github", external_id: "1", title: "Fixture", body: "fixture", state: "open", created_at: now, updated_at: now }],
    ["multiremi_scm_events", { id: "scmevt_c1", workspace_id: "local", connection_id: "scmconn_c1", repository_id: "repo_c1", provider: "github", type: "change_request.opened", subject_type: "change_request", subject_id: "cr_c1", logical_key: "fixture", primary_source: "poll", fidelity: "full", observed_at: now, available_at: now, created_at: now }],
    ["multiremi_scm_event_evidence", { id: "evidence_c1", event_id: "scmevt_c1", source: "poll", dedupe_key: "fixture", payload: "{}", raw_body: "fixture", observed_at: now, created_at: now }],
    ["multiremi_webhook_deliveries", { id: "delivery_c1", workspace_id: "local", autopilot_id: "ap_c1", trigger_id: "fixture", provider: "fixture", event: "fixture", status: "completed", raw_body: "fixture", received_at: now, last_attempt_at: now, created_at: now }],
    ["multiremi_platform_operations", { id: "operation_c1", kind: "update", status: "completed", driver: "systemd_release", requested_by: "local", output: "fixture", created_at: now, updated_at: now }],
    ["multiremi_attachments", { id: "attachment_c1", workspace_id: "local", issue_id: issue.id, uploader_id: "local", filename: "fixture.txt", url: "https://example.invalid/fixture.txt", content_type: "text/plain", created_at: now }],
    ["multiremi_session_archives", { id: "archive_c1", workspace_id: "local", issue_id: issue.id, runtime_id: runtime.id, daemon_id: "daemon_c1", source_revision: "fixture", sha256: "fixture", size_bytes: 0, status: "completed", relative_path: "fixture", created_at: now, updated_at: now }],
  ];
  for (const [table, row] of fixtures) {
    const names = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...Object.values(row));
  }
  if (scenario === null || scenario === "multiremi_scm_change_requests.body") {
    db.prepare("INSERT INTO multiremi_scm_issue_links (id, workspace_id, change_request_id, issue_id, source, linked_at, created_at, updated_at) VALUES ('scmlink_c1', 'local', 'cr_c1', ?, 'explicit', ?, ?, ?)")
      .run(issue.id, now, now, now);
  }
  const seeds = [
    ["multiremi_workspaces", "context", "text"],
    ["multiremi_agents", "instructions", "text"],
    ["multiremi_projects", "instructions", "text"],
    ["multiremi_issues", "description", "text"],
    ["multiremi_skills", "content", "text"],
    ["multiremi_skill_files", "content", "text"],
    ["multiremi_task_messages", "content", "text"],
    ["multiremi_task_prompts", "prompt", "text"],
    ["multiremi_tasks", "prompt", "text"],
    ["multiremi_tasks", "result", "object"],
    ["multiremi_tasks", "usage", "usage"],
    ["multiremi_session_events", "body", "text"],
    ["multiremi_session_events", "metadata", "object"],
    ["multiremi_issue_comments", "body", "text"],
    ["multiremi_chat_messages", "body", "text"],
    ["multiremi_message_messages", "searchable_text", "message"],
    ["multiremi_message_messages", "raw", "object"],
    ["multiremi_message_messages", "conversation_name", "text"],
    ["multiremi_message_sources", "allowlist", "allowlist"],
    ["multiremi_message_sources", "name", "text"],
    ["multiremi_knowledge_submissions", "body", "text"],
    ["multiremi_knowledge_submissions", "patch", "text"],
    ["multiremi_project_docs", "body", "text"],
    ["multiremi_repository_wiki_docs", "body", "text"],
    ["multiremi_gateway_models", "models", "models"],
    ["multiremi_autopilot_runs", "payload", "object"],
    ["multiremi_autopilot_runs", "result", "object"],
    ["multiremi_autopilot_runs", "schedule_prompt", "text"],
    ["multiremi_session_results", "body", "text"],
    ["multiremi_issue_activity", "body", "text"],
    ["multiremi_issue_activity", "data", "object"],
    ["multiremi_task_human_requests", "payload", "object"],
    ["multiremi_task_human_requests", "response", "object"],
    ["multiremi_issue_decisions", "body", "text"],
    ["multiremi_issue_decisions", "options", "array"],
    ["multiremi_task_steer_messages", "content", "text"],
    ["multiremi_knowledge_compilation_runs", "result_summary", "text"],
    ["multiremi_project_doc_revisions", "body", "text"],
    ["multiremi_repository_wiki_doc_revisions", "body", "text"],
    ["multiremi_agent_plugin_versions", "artifact_json", "object"],
    ["multiremi_runtimes", "metadata", "object"],
    ["multiremi_runtime_models", "catalog", "object"],
    ["multiremi_runtime_model_list_requests", "models", "models"],
    ["multiremi_runtime_update_requests", "output", "text"],
    ["multiremi_runtime_command_requests", "stdout", "text"],
    ["multiremi_runtime_directory_scan_requests", "candidates", "array"],
    ["multiremi_scm_change_requests", "body", "text"],
    ["multiremi_scm_events", "payload", "object"],
    ["multiremi_scm_event_evidence", "raw_body", "text"],
    ["multiremi_webhook_deliveries", "raw_body", "text"],
    ["multiremi_platform_operations", "output", "text"],
    ["multiremi_attachments", "filename", "text"],
    ["multiremi_session_archives", "metadata", "object"],
    ["multiremi_squads", "instructions", "text"],
    ["multiremi_message_connections", "config", "object"],
    ["multiremi_workspaces", "settings", "object"],
    ["multiremi_projects", "delta_instructions", "text"],
  ] as const;
  {
    if (scenario && !seeds.some(([table, column]) => `${table}.${column}` === scenario)) throw new Error("Unknown seed column");
    for (const [table, column, kind] of seeds) {
      const large = scenario === null || `${table}.${column}` === scenario;
      const text = "x".repeat(large ? table === "multiremi_task_messages" ? 256 * 1024 : size : 8);
      const value = kind === "object" ? JSON.stringify({ data: text })
        : kind === "array" ? JSON.stringify([text])
        : kind === "usage" ? JSON.stringify([{ model: text, totalTokens: 1 }])
        : kind === "models" ? JSON.stringify([{ id: "fixture", label: text }])
        : kind === "allowlist" ? JSON.stringify([{ externalConversationId: large ? text : "conversation_c1", addedAt: now }])
        : kind === "message" && !large ? "fixture" : text;
      db.prepare(`UPDATE ${table} SET ${column} = ?`).run(value);
    }
  }

  const { signIssueShareId } = await import(`${sourceRoot}/packages/server/src/api/helpers/issue-share-tokens.ts`);
  const share = store.ensureIssueShare(issue.id, "local", "local", 60);
  const shareSecret = "c1-fixture-share";
  const app = createMultiremiApp({ store, authToken: "c1-route-fixture", shareSecret, backgroundJobs: false });
  const keys: string[] = [...new Set<string>((app.routes as Array<{ method: string; path: string }>)
    .filter(route => route.method === "GET").map(route => route.path))];
  const params: Record<string, string> = {
    workspaceId: "local", taskId: task.id, issueId: issue.id, sessionId: session.id,
    projectId: project.id, agentId: agent.id, skillId: skill.id, chatId: chat.id,
    connectionId: "mconn_c1", externalMessageId: "message_c1", messageId: "message_c1",
    sourceId: "msrc_c1", repositoryId: "repo_c1", docId: "pdoc_c1", submissionId: "ksub_c1",
    autopilotId: "ap_c1", runId: "aprun_c1", commentId: "cmt_c1", ref: "fixture.md", engine: "codex",
    runtimeId: runtime.id, daemonId: "daemon_c1", decisionId: "decision_c1", eventId: "scmevt_c1",
    requestId: "hreq_c1", deliveryId: "delivery_c1", attachmentId: "attachment_c1", archiveId: "archive_c1",
    digest: artifactDigest,
    token: signIssueShareId(share.id, shareSecret),
    id: "fixture",
  };
  const rows: Array<{ method: string; route: string; status: number | null; reason: string; bytes: number; maxReplyBytes: number }> = [];
  const originalLog = console.log;
  let rejected = 0;
  let activeRejected = false;
  let activeMaxReplyBytes = 0;
  const largeTables = new Map<string, number>();
  const bridge = (db as unknown as { bridge: { exec: (sql: string, params: unknown[]) => { rows: unknown[]; count: number } } }).bridge;
  const originalExec = bridge.exec.bind(bridge);
  bridge.exec = (sql, params) => {
    const result = originalExec(sql, params);
    // pg-worker sends exactly JSON.stringify({ rows, count }) across the bridge.
    const replyBytes = Buffer.byteLength(JSON.stringify(result));
    activeMaxReplyBytes = Math.max(activeMaxReplyBytes, replyBytes);
    if (replyBytes >= size) {
      for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+(multiremi_[a-z_]+)/gi)) {
        largeTables.set(match[1]!, Math.max(largeTables.get(match[1]!) ?? 0, replyBytes));
      }
    }
    return result;
  };
  console.log = (...args: unknown[]) => {
    try {
      const entry = JSON.parse(String(args[0])) as { event?: string; bytes?: number };
      if (entry.event === "api_db_reply_rejected") {
        rejected += 1;
        activeRejected = true;
        activeMaxReplyBytes = Math.max(activeMaxReplyBytes, entry.bytes ?? 0);
      }
      if (entry.event?.startsWith("api_")) return;
    } catch { /* Preserve ordinary output. */ }
    originalLog(...args);
  };
  for (const route of keys) {
    const contextualId = route.includes("/knowledge/submissions/") ? "ksub_c1"
      : route.includes("/knowledge/runs/") ? "krun_c1"
      : route.includes("/agent-plugins/") ? "plugin_c1"
      : route.includes("/runtime-workspaces/") ? "fixture"
      : route.includes("/runtimes/") ? runtime.id
      : route.includes("/squads/") ? squad.id
      : route.includes("/attachments/") ? "attachment_c1"
      : route.includes("/comments/") ? "cmt_c1"
      : route.includes("/autopilots/") ? "ap_c1"
      : route.includes("/issues/") ? issue.id
      : route.includes("/projects/") ? project.id
      : route.includes("/agents/") ? agent.id
      : route.includes("/skills/") ? skill.id
      : route.includes("/tasks/") ? task.id
      : route.includes("/chats/") || route.includes("/chat/sessions/") ? chat.id
      : route.includes("/workspaces/") ? "local" : "fixture";
    const path = route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_, param: string) =>
      encodeURIComponent(param === "id" ? contextualId
        : param === "connectionId" && route.includes("/scm/") ? "scmconn_c1"
        : param === "ref" && route.includes("/projects/") ? "pdoc_c1"
        : param === "requestId" && route.includes("/models/") ? "models_c1"
        : param === "updateId" ? "update_c1"
        : param === "requestId" && route.includes("/commands/") ? "command_c1"
        : param === "requestId" && route.includes("/directory-scans/") ? "scan_c1"
        : param === "sessionId" && route.includes("/chat/") ? chat.id
        : params[param] ?? "fixture"));
    const query = /\/search$|\/knowledge\/recall$/.test(route) ? "?q=fixture"
      : route === "/api/knowledge/submissions" ? "?scope=project_wiki" : "";
    for (const method of ["GET", "HEAD"]) {
      activeMaxReplyBytes = 0;
      activeRejected = false;
      if (path.includes("*") || path.includes("{")) {
        rows.push({ method, route, status: null, reason: "path requires non-scalar fixture", bytes: 0, maxReplyBytes: 0 });
        continue;
      }
      try {
        const headers: Record<string, string> = { Authorization: "Bearer c1-route-fixture" };
        if (route.startsWith("/api/shares/")) headers["X-Remi-Share"] = params.token!;
        const response = await app.request(path + query, {
          method, headers, signal: AbortSignal.timeout(20_000),
        });
        const bytes = (await response.arrayBuffer()).byteLength;
        rows.push({ method, route, status: response.status, maxReplyBytes: activeMaxReplyBytes,
          reason: activeRejected ? "PG reply rejected"
            : response.status === 404 ? "fixture id absent or route not found"
            : response.status === 401 || response.status === 403 ? "requires scoped actor"
            : response.status === 400 ? "fixture lacks required request fields"
            : response.status === 405 ? "route does not accept this method"
            : response.status === 426 ? "requires a WebSocket upgrade"
            : response.status === 503 ? "integration configuration absent"
            : response.status >= 500 ? "handler error in fixture"
            : response.status >= 300 ? "route redirects or has another non-2xx result" : "requested",
          bytes });
      } catch {
        rows.push({ method, route, status: null, reason: "request failed or timed out", bytes: 0, maxReplyBytes: activeMaxReplyBytes });
      }
    }
    if (rows.length % 64 === 0) originalLog(JSON.stringify({ requested: rows.length, total: keys.length * 2 }));
  }
  console.log = originalLog;
  writeFileSync(output, JSON.stringify({ routeCount: keys.length, rows }, null, 2) + "\n");
  console.log(JSON.stringify({ routeCount: keys.length, requests: rows.length,
    success: rows.filter(row => row.status && row.status >= 200 && row.status < 300).length,
    failed: rows.filter(row => row.status && row.status >= 500).length,
    skipped: rows.filter(row => row.status === null).length, rejected,
    largeTables: Object.fromEntries([...largeTables].sort(([a], [b]) => a.localeCompare(b))) }));
} finally {
  db?.close();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}
