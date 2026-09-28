/** Run in an origin/main snapshot with `baseline`, then in the Hub branch with `upgrade`. */
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

const [phase, backend] = process.argv.slice(2);
if ((phase !== "baseline" && phase !== "upgrade") || (backend !== "sqlite" && backend !== "postgres")) {
  throw new Error("usage: bun tests/manual/mul436-main-schema-upgrade.ts baseline|upgrade sqlite|postgres");
}

process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.MULTIREMI_LARK_APP_ID = "cli_mul436_upgrade";
process.env.MULTIREMI_LARK_APP_SECRET = randomUUID();
process.env.MULTIREMI_PUBLIC_URL = "https://example.com";

const sqlitePath = process.env.MUL436_TEST_SQLITE_PATH;
const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const databaseName = process.env.MUL436_TEST_DB_NAME;
if (backend === "sqlite" && !sqlitePath) throw new Error("MUL436_TEST_SQLITE_PATH is required");
if (backend === "postgres" && (!adminUrl || !databaseName || !/^mul436_[a-z0-9_]+$/.test(databaseName))) {
  throw new Error("local MULTIREMI_TEST_POSTGRES_URL and MUL436_TEST_DB_NAME are required");
}

if (phase === "baseline" && backend === "postgres") {
  const admin = new Bun.SQL(adminUrl!, { max: 1 });
  try { await admin.unsafe(`CREATE DATABASE ${databaseName}`); }
  finally { await admin.end(); }
}

const targetUrl = new URL(adminUrl ?? "postgresql://postgres@127.0.0.1/postgres");
targetUrl.pathname = `/${databaseName ?? "unused"}`;
const db: SqlDatabase = backend === "sqlite"
  ? new Database(sqlitePath!) as unknown as SqlDatabase
  : new PostgresSyncDatabase(targetUrl.toString());

try {
  const store = new MultiremiStore(db);
  if (phase === "baseline") {
    store.ensureLocalWorkspace();
    const member = store.findWorkspaceMemberForUser("local", "local")!;
    const user = store.getOrCreateUser({ externalId: "ou_mul436", name: "Upgrade", email: "mul436@example.com" });
    db.run("UPDATE multiremi_workspace_members SET user_id = ? WHERE id = ?", [user.id, member.id]);
    const agentId = store.createAgent({ name: "Upgrade", provider: "codex", workspaceId: "local" }).id;
    store.registerRuntime({ id: "rt_mul436", name: "Upgrade", provider: "codex", workspaceId: "local", daemonId: "daemon_mul436" });
    store.heartbeatRuntime("rt_mul436", { supportsFeishuBotConfig: true, supportsIssueDecisionCard: true });
    const config = store.upsertFeishuBotConfig("local", {
      agentId, runtimeId: "rt_mul436", appId: "cli_mul436_upgrade", appSecretOp: "set",
      appSecret: randomUUID(), domain: "feishu", enabled: true,
    });
    store.reportFeishuBotRuntimeStatus("local", "rt_mul436", { appliedRevision: config.revision, state: "online" });
    const workspace = store.getWorkspace("local")!;
    store.updateWorkspace("local", { settings: {
      ...workspace.settings,
      issueTopics: { enabled: true, chatId: "oc_mul436", notifyMode: "person", notifyOpenId: "ou_mul436" },
    } });
    const parent = store.createIssue({ title: "Upgrade parent", workspaceId: "local", assigneeType: "agent", assigneeId: agentId });
    store.prepareFeishuIssueTopicWithinTransaction(parent);
    const root = store.claimFeishuBotOutbound("local", "rt_mul436")!;
    store.reportFeishuBotOutbound("local", "rt_mul436", root.id, {
      claimToken: root.claimToken, status: "sent", externalMessageId: "om_mul436_root",
    });
    const child = store.createIssue({ title: "Upgrade child", workspaceId: "local", parentIssueId: parent.id,
      assigneeType: "agent", assigneeId: agentId });
    const task = store.createTask({ agentId, issueId: child.id, workspaceId: "local", prompt: "Review" });
    const decision = store.createIssueDecision(child.id, { kind: "production_change", title: "Approve?",
      body: "Review", options: ["yes", "no"] }, { type: "agent", id: agentId, taskId: task.id });
    db.run("UPDATE multiremi_issue_decisions SET reminder_sent_at = ? WHERE id = ?",
      ["2026-09-29T00:00:00.000Z", decision.id]);
  }

  const deliveries = db.query("SELECT kind, decision_id, decision_issue_id FROM multiremi_feishu_bot_outbound_deliveries ORDER BY created_at, id").all() as
    Array<{ kind: string | null; decision_id: string | null; decision_issue_id: string | null }>;
  if (!deliveries.some(row => row.kind === null) || !deliveries.some(row => row.kind === "decision_card" && row.decision_id && row.decision_issue_id)) {
    throw new Error("main baseline lost the legacy or E4 decision delivery");
  }
  const reminder = db.query("SELECT reminder_sent_at FROM multiremi_issue_decisions LIMIT 1").get() as { reminder_sent_at: string };
  if (reminder.reminder_sent_at !== "2026-09-29T00:00:00.000Z") throw new Error("decision reminder timestamp changed");

  if (phase === "upgrade") {
    const columns = db.query("PRAGMA table_info(multiremi_feishu_bot_outbound_deliveries)").all() as Array<{ name: string }>;
    for (const name of ["decision_id", "decision_issue_id", "unit_key", "cascade_failure", "delivery_mode"]) {
      if (!columns.some(column => column.name === name)) throw new Error(`missing column ${name}`);
    }
    const binding = db.query("SELECT id FROM multiremi_feishu_bot_chat_bindings LIMIT 1").get() as { id: string };
    const task = db.query("SELECT id FROM multiremi_tasks LIMIT 1").get() as { id: string };
    const now = "2026-09-29T00:01:00.000Z";
    const add = (kind: string, unitKey: string) => db.run(`INSERT INTO multiremi_feishu_bot_outbound_deliveries
      (id, workspace_id, binding_id, task_id, chat_id, body, available_at, created_at, updated_at, kind, unit_key)
      VALUES (?, 'local', ?, ?, 'oc_mul436', 'test', ?, ?, ?, ?, ?)`,
      [randomUUID(), binding.id, task.id, now, now, now, kind, unitKey]);
    add("cot", "");
    add("result_card", "result");
    let duplicateRejected = false;
    try { add("result_card", "result"); } catch { duplicateRejected = true; }
    if (!duplicateRejected) throw new Error("kind/unit uniqueness was not enforced");
    const indexName = "idx_multiremi_feishu_bot_outbound_decision";
    const indexRows = backend === "sqlite"
      ? db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").all(indexName) as Array<{ name: string }>
      : db.query("SELECT indexname AS name FROM pg_indexes WHERE tablename = 'multiremi_feishu_bot_outbound_deliveries' AND indexname = ?").all(indexName) as Array<{ name: string }>;
    if (indexRows.length !== 1) throw new Error("decision delivery index was lost");
    db.query("SELECT 1 FROM multiremi_feishu_bot_outbound_operations LIMIT 1").all();
  }
  console.log(`${backend} ${phase}: E4 and legacy rows preserved${phase === "upgrade" ? ", kind uniqueness and indexes verified" : ""}`);
} finally {
  db.close();
}
