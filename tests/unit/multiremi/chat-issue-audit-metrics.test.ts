import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { runMigrations } from "@multiremi/store/migrations.js";

const runbook = readFileSync(new URL("../../../docs/migrations/chat-issue-decoupling.md", import.meta.url), "utf8");
function documentedSql(name: string): string {
  const blocks = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)];
  const sql = blocks.find((block) => block[1]!.startsWith(`-- mul301-audit-${name}\n`))?.[1];
  if (!sql) throw new Error(`Missing executable runbook SQL: ${name}`);
  return sql;
}
const quote = (value: unknown): string => value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;

function seedAuditMatrix(db: SqlDatabase) {
  runMigrations(db);
  db.exec("ALTER TABLE multiremi_chat_sessions ADD COLUMN issue_id TEXT");
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.run(`INSERT INTO multiremi_agents (id, name, provider, created_at, updated_at)
    VALUES ('agt_metrics', 'Metrics', 'codex', ?, ?)`, [old, old]);
  const cases = [
    { name: "overlap", canonical: true, marker: true, synced: true, activity: "recent" },
    { name: "marker", marker: true, activity: "old" },
    { name: "synced", synced: true, activity: "synced" },
    { name: "metadata" },
    { name: "active", activity: "recent" },
    { name: "unknown" },
    { name: "noise" },
    { name: "p2p", canonical: true, marker: true, synced: true, p2p: true, activity: "old" },
  ];
  for (const entry of cases) {
    const issue = `iss_metrics_${entry.name}`;
    const chat = entry.canonical ? `chat_issue_topic_${issue}` : `chat_metrics_${entry.name}`;
    const binding = `binding_${entry.name}`;
    const external = `oc_metrics_${entry.name}`;
    const thread = `om_root_${entry.name}`;
    const message = `om_creation_${entry.name}`;
    db.run(`INSERT INTO multiremi_issues (id, title, status, context_refs, created_at, updated_at)
      VALUES (?, 'Audit topic', 'todo', ?, ?, ?)`, [issue, JSON.stringify(entry.marker
        ? [{ type: "feishu_bot_message", chat_id: external, message_id: message }] : []), old, recent]);
    db.run(`INSERT INTO multiremi_chat_sessions (id, agent_id, issue_id, title, created_at, updated_at)
      VALUES (?, 'agt_metrics', ?, 'Audit chat', ?, ?)`, [chat, issue, old, recent]);
    db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
      (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, chat_id, thread_id, created_at, updated_at)
      VALUES (?, 'local', 'app_metrics', 'agt_metrics', ?, ?, ?, ?, ?, ?)`,
    [binding, `${external}:thread:${thread}`, chat, external, thread, old, recent]);
    db.run(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, chat_session_id, issue_id, prompt, status, created_at, updated_at)
      VALUES (?, 'local', 'agt_metrics', ?, ?, 'User input', 'completed', ?, ?)`, [`task_${entry.name}`, chat, issue, old, recent]);
    if (entry.activity === "old" || entry.activity === "recent") {
      db.run(`INSERT INTO multiremi_feishu_bot_deliveries
        (workspace_id, external_message_id, binding_id, task_id, created_at, updated_at)
        VALUES ('local', ?, ?, ?, ?, ?)`, [message, binding, `task_${entry.name}`, entry.activity === "recent" ? recent : old, recent]);
    }
    const source = `source_${entry.name}`;
    db.run(`INSERT INTO multiremi_feishu_sources (id, workspace_id, endpoint_name, created_at, updated_at)
      VALUES (?, 'local', ?, ?, ?)`, [source, source, old, recent]);
    if (entry.synced) {
      db.run(`INSERT INTO multiremi_feishu_messages
        (message_id, workspace_id, source_id, chat_id, chat_type, thread_id, sender, content_fingerprint, created_at, ingested_at)
        VALUES (?, 'local', ?, ?, 'group', ?, ?, 'fixture', ?, ?)`,
      [`sync_${entry.name}`, source, external, thread,
        JSON.stringify({ sender_type: entry.activity === "synced" ? "user" : "app" }), recent, recent]);
    }
    if (entry.p2p) {
      db.run(`INSERT INTO multiremi_feishu_messages
        (message_id, workspace_id, source_id, chat_id, chat_type, thread_id, content_fingerprint, created_at, ingested_at)
        VALUES ('sync_p2p_override', 'local', ?, ?, 'p2p', ?, 'fixture', ?, ?)`, [source, external, thread, old, recent]);
    }
  }
  // Recent metadata, retry timestamps, another thread/workspace, app senders,
  // unknown senders, invalid/future receipts must never manufacture activity.
  db.run(`INSERT INTO multiremi_feishu_sources (id, workspace_id, endpoint_name, created_at, updated_at)
    VALUES ('wrong_source', 'other', 'wrong', ?, ?)`, [old, recent]);
  for (const [id, source, thread, sender, at] of [
    ["noise_thread", "source_noise", "another_thread", '{"sender_type":"user"}', recent],
    ["noise_source", "wrong_source", "om_root_noise", '{"sender_type":"user"}', recent],
    ["noise_app", "source_noise", "om_root_noise", '{"sender_type":"app"}', recent],
    ["noise_unknown", "source_noise", "om_root_noise", '{}', recent],
    ["noise_future", "source_noise", "om_root_noise", '{"sender_type":"user"}', future],
  ]) {
    db.run(`INSERT INTO multiremi_feishu_messages
      (message_id, workspace_id, source_id, chat_id, thread_id, sender, content_fingerprint, created_at, ingested_at)
      VALUES (?, 'local', ?, 'oc_metrics_noise', ?, ?, 'fixture', ?, ?)`, [id, source, thread, sender, at, recent]);
  }
  for (const [id, workspace, at] of [["noise_wrong_workspace", "other", recent], ["noise_invalid", "local", "invalid"], ["noise_future_delivery", "local", future]]) {
    db.run(`INSERT INTO multiremi_feishu_bot_deliveries
      (workspace_id, external_message_id, binding_id, task_id, created_at, updated_at)
      VALUES (?, ?, 'binding_noise', 'task_noise', ?, ?)`, [workspace, id, at, recent]);
  }
  db.run(`INSERT INTO multiremi_notification_channels
    (id, workspace_id, kind, name, enabled, target, event_types, min_severity, created_at, updated_at)
    VALUES ('channel_metadata', 'local', 'agent_chat', 'Keep disabled', 0, ?, '["comment_created"]', 'warning', ?, ?)`,
  [JSON.stringify({ chatId: "chat_metrics_metadata" }), old, recent]);
  db.run("DELETE FROM multiremi_schema_migrations WHERE id = '20260916_chat_issue_decoupling'");
  runMigrations(db);
  return { recent, old };
}

function assertAuditMetricsAndRecovery(db: SqlDatabase) {
  const { recent, old } = seedAuditMatrix(db);
  const rows = db.query(documentedSql("detail")).all() as Array<Record<string, any>>;
  expect(rows).toHaveLength(8);
  const byId = Object.fromEntries(rows.map((row) => [row.binding_id, row]));
  expect(byId.binding_overlap).toMatchObject({ disposition: "preserved", reason: "canonical_topic",
    classification_version: 2, hit_canonical: 1, hit_marker: 1, hit_synced_group: 1, hit_synced_p2p: 0,
    last_inbound_at: recent, active_last7d: 1 });
  expect(byId.binding_p2p).toMatchObject({ disposition: "discarded", reason: "p2p_evidence",
    hit_canonical: 1, hit_marker: 1, hit_synced_group: 1, hit_synced_p2p: 1, last_inbound_at: old, active_last7d: 0 });
  expect(byId.binding_marker).toMatchObject({ last_inbound_at: old, active_last7d: 0 });
  expect(byId.binding_synced).toMatchObject({ last_inbound_at: recent, active_last7d: 1 });
  for (const id of ["binding_metadata", "binding_unknown", "binding_noise"]) {
    expect(byId[id]).toMatchObject({ disposition: "discarded", last_inbound_at: null, active_last7d: 0 });
  }
  db.exec(documentedSql("review"));
  // PostgreSQL's bigint/numeric aggregates are strings; compare SQL values.
  const readMetrics = () => Object.fromEntries(Object.entries(db.query(documentedSql("metrics")).get() as Record<string, unknown>)
    .map(([key, value]) => [key, value === null ? null : Number(value)]));
  expect(readMetrics()).toMatchObject({ evaluated_links: 8, preserved_links: 3,
    canonical_hits: 2, marker_hits: 3, synced_group_hits: 3, unresolved_links: 4, confirmed_group_topics: 3 });
  for (const [workspace, binding, type] of [["local", "binding_metadata", "group"], ["local", "binding_active", "group"],
    ["local", "binding_p2p", "group"], ["other", "binding_unknown", "group"]]) {
    db.run("INSERT INTO mul301_type_review VALUES (?, ?, ?, 'authoritative-fixture-reference')", [workspace, binding, type]);
  }
  const metrics = readMetrics() as Record<string, number | null>;
  expect(metrics).toMatchObject({ evaluated_links: 8, incomplete_audit_rows: 0,
    canonical_hits: 2, marker_hits: 3, synced_group_hits: 3, p2p_overrides: 1,
    canonical_preserved: 1, marker_preserved: 2, synced_group_preserved: 2,
    preserved_links: 3, dropped_feishu_links: 5, confirmed_group_topics: 5,
    confirmed_affected_group_topics: 2, confirmed_private_links: 1, unresolved_links: 2,
    active_group_topics_last7d: 3, active_affected_group_topics_last7d: 1,
    active_preserved_group_topics_last7d: 2, active_unresolved_links_last7d: 0,
    inbound_unobserved_links: 3, affected_group_inbound_unobserved: 1, evidence_conflicts: 1,
    canonical_coverage_pct: 12.5, marker_coverage_pct: 25, synced_group_coverage_pct: 25,
    preservation_coverage_pct: 37.5 });
  expect(Number(metrics.active_group_preservation_coverage_pct)).toBeCloseTo(200 / 3);
  // Changes after the migration do not rewrite its authoritative observations.
  db.run("UPDATE multiremi_chat_sessions SET updated_at = ?", [new Date().toISOString()]);
  runMigrations(db);
  expect(readMetrics()).toEqual(metrics);

  function restoreSql(bindingId: string) {
    const audit = db.query("SELECT * FROM multiremi_feishu_bot_issue_link_audit WHERE binding_id = ?").get(bindingId) as Record<string, string>;
    const binding = JSON.parse(audit.binding_snapshot);
    const values: Record<string, unknown> = {
      "binding-id": bindingId, "workspace-id": audit.workspace_id, "audited-app-id": binding.app_id,
      "audited-agent-id": binding.agent_id, "audited-external-session-key": binding.external_session_key,
      "audited-chat-session-id": binding.chat_session_id, "authoritatively-verified-group-chat-id": binding.chat_id,
      "audited-thread-id-or-SQL-NULL": binding.thread_id, "audited-reply-id-or-SQL-NULL": binding.reply_to_message_id,
    };
    return documentedSql("restore").replace(/'<([^>]+)>'/g, (_, key) => quote(values[key])).split("BEGIN;\n")[1]!
      .split("-- Require exactly")[0]!;
  }
  const audit = db.query("SELECT * FROM multiremi_feishu_bot_issue_link_audit WHERE binding_id = 'binding_metadata'").get() as Record<string, string>;
  // Actual runbook UPDATE rejects an altered destination and a p2p audit.
  db.run("UPDATE multiremi_feishu_bot_chat_bindings SET thread_id = 'wrong' WHERE id = 'binding_metadata'");
  expect(db.query(restoreSql("binding_metadata")).all()).toEqual([]);
  db.run("UPDATE multiremi_feishu_bot_chat_bindings SET thread_id = 'om_root_metadata' WHERE id = 'binding_metadata'");
  expect(db.query(restoreSql("binding_p2p")).all()).toEqual([]);
  // Preserved audit rows are ineligible even if someone clears the live link.
  db.run("UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = NULL WHERE id = 'binding_marker'");
  expect(db.query(restoreSql("binding_marker")).all()).toEqual([]);
  db.exec("BEGIN");
  expect(db.query(restoreSql("binding_metadata")).all()).toEqual([{ id: "binding_metadata", issue_id: "iss_metrics_metadata" }]);
  const channel = JSON.parse(audit.channel_snapshot);
  const channelValues: Record<string, unknown> = { "channel-id": channel.id, "workspace-id": channel.workspace_id,
    "member-id-or-SQL-NULL": channel.member_id, name: channel.name, "target-json": channel.target,
    "event-types-json": channel.event_types, "min-severity": channel.min_severity,
    "creator-or-SQL-NULL": channel.created_by, "created-at": channel.created_at, "updated-at": channel.updated_at };
  const channelSql = documentedSql("restore-channel")
    .replace(/'<([^>]+)>'/g, (_, key) => quote(channelValues[key])).replace("<enabled-0-or-1>", String(channel.enabled))
    .split("-- A conflicting ID")[0]!;
  expect(db.query(channelSql).all()).toEqual([{ id: channel.id, enabled: 0, event_types: '["comment_created"]' }]);
  db.exec("COMMIT");
  expect(db.query(restoreSql("binding_metadata")).all()).toEqual([]);
  expect(db.query("SELECT * FROM multiremi_feishu_bot_issue_link_audit WHERE binding_id = 'binding_metadata'").get()).toEqual(audit);

  // Incomplete early-draft rows cannot manufacture coverage or override p2p.
  db.run("UPDATE multiremi_feishu_bot_issue_link_audit SET classification_version = 1, hit_synced_p2p = 0 WHERE binding_id = 'binding_p2p'");
  expect(readMetrics()).toMatchObject({ incomplete_audit_rows: 1,
    confirmed_private_links: 1, preservation_coverage_pct: null, canonical_coverage_pct: null,
    marker_coverage_pct: null, synced_group_coverage_pct: null, active_group_preservation_coverage_pct: null });
  db.run("DELETE FROM multiremi_feishu_bot_issue_link_audit");
  expect(readMetrics()).toMatchObject({ evaluated_links: 0, preserved_links: 0,
    preservation_coverage_pct: null });
}

describe("MUL-301 executable audit metrics and recovery runbook", () => {
  it("audits overlapping proofs and real inbound activity, and executes guarded recovery on SQLite", () => {
    const db = new Database(":memory:");
    try { assertAuditMetricsAndRecovery(db); } finally { db.close(); }
  });
});

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const pgAvailable = await (async () => {
  const probe = new Bun.SQL(pgAdminUrl, { max: 1 });
  try { await probe`SELECT 1`; return true; }
  catch (error) {
    // An explicitly configured integration database must run, never silently skip.
    if (process.env.MULTIREMI_TEST_POSTGRES_URL) throw error;
    return false;
  } finally { await probe.end(); }
})();
describe.skipIf(!pgAvailable)("MUL-301 PostgreSQL executable audit runbook", () => {
  const databaseName = `multiremi_audit_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  let admin: InstanceType<typeof Bun.SQL>;
  let db: PostgresSyncDatabase;
  beforeAll(async () => {
    admin = new Bun.SQL(pgAdminUrl);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    const url = new URL(pgAdminUrl);
    url.pathname = `/${databaseName}`;
    db = new PostgresSyncDatabase(url.toString());
  });
  afterAll(async () => {
    db?.close();
    if (admin) { await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); await admin.end(); }
  });
  it("runs the same actual metrics and recovery SQL against PostgreSQL", () => {
    assertAuditMetricsAndRecovery(db);
  }, 15_000);
});
