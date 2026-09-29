import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const rootFlag = process.argv.indexOf("--root");
const outFlag = process.argv.indexOf("--out");
const sourceRoot = rootFlag < 0 ? resolve(import.meta.dir, "../..") : resolve(process.argv[rootFlag + 1] ?? "");
const output = outFlag < 0 ? null : process.argv[outFlag + 1];
const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
if (!output || !adminUrl || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl).hostname)) {
  throw new Error("A loopback PostgreSQL target and --out are required");
}
delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;

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
  const size = 9 * 1_048_576;
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

  const app = createMultiremiApp({ store, authToken: "c1-route-fixture", backgroundJobs: false });
  const keys: string[] = [...new Set<string>((app.routes as Array<{ method: string; path: string }>)
    .filter(route => route.method === "GET").map(route => route.path))];
  const params: Record<string, string> = {
    workspaceId: "local", taskId: task.id, issueId: issue.id, sessionId: session.id,
    projectId: project.id, agentId: agent.id, skillId: skill.id, chatId: chat.id,
    connectionId: "mconn_c1", externalMessageId: "message_c1", messageId: "message_c1",
    sourceId: "msrc_c1", id: "fixture",
  };
  const rows: Array<{ method: string; route: string; status: number | null; reason: string; bytes: number }> = [];
  const originalLog = console.log;
  let rejected = 0;
  console.log = (...args: unknown[]) => {
    try {
      const entry = JSON.parse(String(args[0])) as { event?: string };
      if (entry.event === "api_db_reply_rejected") rejected += 1;
      if (entry.event?.startsWith("api_")) return;
    } catch { /* Preserve ordinary output. */ }
    originalLog(...args);
  };
  for (const route of keys) {
    const contextualId = route.includes("/issues/") ? issue.id
      : route.includes("/projects/") ? project.id
      : route.includes("/agents/") ? agent.id
      : route.includes("/skills/") ? skill.id
      : route.includes("/tasks/") ? task.id
      : route.includes("/chats/") || route.includes("/chat/sessions/") ? chat.id
      : route.includes("/workspaces/") ? "local" : "fixture";
    const path = route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_, param: string) =>
      encodeURIComponent(param === "id" ? contextualId : params[param] ?? "fixture"));
    for (const method of ["GET", "HEAD"]) {
      if (path.includes("*") || path.includes("{")) {
        rows.push({ method, route, status: null, reason: "path requires non-scalar fixture", bytes: 0 });
        continue;
      }
      try {
        const response = await app.request(path, {
          method, headers: { Authorization: "Bearer c1-route-fixture" }, signal: AbortSignal.timeout(20_000),
        });
        const bytes = (await response.arrayBuffer()).byteLength;
        rows.push({ method, route, status: response.status,
          reason: response.status === 404 ? "fixture id absent or route not found"
            : response.status === 401 || response.status === 403 ? "requires scoped actor" : "requested",
          bytes });
      } catch {
        rows.push({ method, route, status: null, reason: "request failed or timed out", bytes: 0 });
      }
    }
  }
  console.log = originalLog;
  writeFileSync(output, JSON.stringify({ root: sourceRoot, routeCount: keys.length, rows }, null, 2) + "\n");
  console.log(JSON.stringify({ routeCount: keys.length, requests: rows.length,
    success: rows.filter(row => row.status && row.status >= 200 && row.status < 300).length,
    failed: rows.filter(row => row.status && row.status >= 500).length,
    skipped: rows.filter(row => row.status === null).length, rejected }));
} finally {
  db?.close();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}
