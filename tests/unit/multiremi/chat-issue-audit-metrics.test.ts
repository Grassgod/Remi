import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { CHAT_ISSUE_DECOUPLED_FINGERPRINT } from "@multiremi/store/helpers.js";

const runbook = readFileSync(new URL("../../../docs/migrations/chat-issue-decoupling.md", import.meta.url), "utf8");
function documentedSql(name: string): string {
  const blocks = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)];
  const sql = blocks.find((block) => block[1]!.startsWith(`-- mul301-audit-${name}\n`))?.[1];
  if (!sql) throw new Error(`Missing executable runbook SQL: ${name}`);
  return sql;
}
const quote = (value: unknown): string => value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;

function assertMultiplicitySql(db: SqlDatabase) {
  runMigrations(db);
  const summary = () => Object.fromEntries(Object.entries(db.query(documentedSql("multiplicity-summary")).get()!)
    .map(([key, value]) => [key, Number(value)]));
  expect(db.query(documentedSql("multiplicity-detail")).all()).toEqual([]);
  expect(db.query(documentedSql("live-multi-issue")).all()).toEqual([]);
  expect(summary()).toEqual({ affected_chats: 0, conflict_bindings: 0, excess_bindings: 0 });
  for (const [id, chat, workspace] of [["a", "shared", "local"], ["b", "shared", "local"],
    ["c", "shared", "other"], ["d", "single", "local"]]) {
    db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
      (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, created_at, updated_at)
      VALUES (?, ?, 'audit_app', 'audit_agent', ?, ?, 'fixture', 'fixture')`, [id, workspace, id, chat]);
  }
  expect(summary()).toEqual({ affected_chats: 1, conflict_bindings: 3, excess_bindings: 2 });
  expect(db.query(documentedSql("multiplicity-detail")).all().map((row: any) => row.binding_id)).toEqual(["a", "b", "c"]);
  db.run("DELETE FROM multiremi_feishu_bot_chat_bindings");
}

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
  assertMultiplicitySql(db);
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
  // Restoring a group must not introduce ownership into a still-shared Chat,
  // even when the other binding is in an anomalous different workspace.
  db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
    (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, created_at, updated_at)
    VALUES ('restore_conflict', 'other', 'app_metrics', 'agt_metrics', 'restore_conflict',
      'chat_metrics_metadata', ?, ?)`, [old, recent]);
  expect(db.query(restoreSql("binding_metadata")).all()).toEqual([]);
  db.run("DELETE FROM multiremi_feishu_bot_chat_bindings WHERE id = 'restore_conflict'");
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
    preservation_coverage_pct: null, missing_chat_identity_rows: 0,
    shared_chat_count: 0, shared_chat_binding_count: 0, mixed_disposition_chat_count: 0,
    mixed_disposition_binding_count: 0, preserved_group_discarded_p2p_chat_count: 0,
    preserved_multi_issue_chat_count: 0 });
  assertSharedChatMetrics(db);
  assertPrelinkedIssueConflicts(db);
}

function assertSharedChatMetrics(db: SqlDatabase) {
  db.exec("ALTER TABLE multiremi_chat_sessions ADD COLUMN issue_id TEXT");
  const now = new Date().toISOString();
  db.run(`INSERT INTO multiremi_feishu_sources (id, workspace_id, endpoint_name, created_at, updated_at)
    VALUES ('shared_metrics_source', 'local', 'shared_metrics', ?, ?)`, [now, now]);
  const cases = [
    ["group", "p2p"], ["group", "unknown", "unknown"],
    ["group", "group"], ["p2p", "p2p"], ["group"],
  ];
  for (const [index, types] of cases.entries()) {
    const chat = `shared_metrics_${index}`;
    db.run(`INSERT INTO multiremi_issues (id, title, status, created_at, updated_at)
      VALUES (?, 'Shared metrics', 'todo', ?, ?)`, [chat, now, now]);
    db.run(`INSERT INTO multiremi_chat_sessions
      (id, agent_id, issue_id, title, session_id, session_provider, session_execution_fingerprint,
       work_dir, session_runtime_id, created_at, updated_at)
      VALUES (?, 'agt_metrics', ?, 'Shared metrics', 'old-provider', 'codex', 'old-fingerprint',
        '/fixture/keep', 'fixture-runtime', ?, ?)`, [chat, chat, now, now]);
    for (const status of ["queued", "running"]) db.run(`INSERT INTO multiremi_tasks
      (id, agent_id, chat_session_id, issue_id, prompt, status, session_id, created_at, updated_at)
      VALUES (?, 'agt_metrics', ?, ?, 'Fixture', ?, 'old-task-provider', ?, ?)`,
    [`${chat}_${status}`, chat, chat, status, now, now]);
    for (const [ordinal, type] of types.entries()) {
      const binding = `${chat}_${ordinal}`;
      db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
        (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, chat_id, created_at, updated_at)
        VALUES (?, 'local', 'app_metrics', 'agt_metrics', ?, ?, ?, ?, ?)`, [binding, binding, chat, binding, now, now]);
      if (type !== "unknown") db.run(`INSERT INTO multiremi_feishu_messages
        (message_id, workspace_id, source_id, chat_id, chat_type, content_fingerprint, created_at, ingested_at)
        VALUES (?, 'local', 'shared_metrics_source', ?, ?, 'fixture', ?, ?)`, [binding, binding, type, now, now]);
    }
  }
  db.run("DELETE FROM multiremi_schema_migrations WHERE id = '20260916_chat_issue_decoupling'");
  runMigrations(db);
  for (const [index, types] of cases.entries()) {
    const chat = `shared_metrics_${index}`;
    const coldStart = types.some((type) => type !== "group");
    const hasRetained = types.includes("group");
    expect(db.query(`SELECT session_id, session_provider, session_execution_fingerprint,
      work_dir, session_runtime_id FROM multiremi_chat_sessions WHERE id = ?`).get(chat)).toEqual({
      session_id: coldStart ? null : "old-provider", session_provider: coldStart ? null : "codex",
      session_execution_fingerprint: coldStart ? null : "old-fingerprint",
      work_dir: "/fixture/keep", session_runtime_id: "fixture-runtime",
    });
    expect(db.query(`SELECT status, session_id, issue_id FROM multiremi_tasks WHERE id = ?`).get(`${chat}_queued`))
      .toEqual({ status: "queued", session_id: coldStart ? null : "old-task-provider", issue_id: hasRetained ? chat : null });
    expect(db.query(`SELECT status, session_id, execution_fingerprint FROM multiremi_tasks WHERE id = ?`).get(`${chat}_running`))
      .toEqual({ status: "running", session_id: coldStart ? null : "old-task-provider",
        execution_fingerprint: coldStart ? CHAT_ISSUE_DECOUPLED_FINGERPRINT : null });
    expect(db.query(`SELECT disposition FROM multiremi_feishu_bot_issue_link_audit
      WHERE chat_session_id = ? ORDER BY binding_id`).all(chat))
      .toEqual(types.map((type) => ({ disposition: type === "group" ? "preserved" : "discarded" })));
  }
  const read = () => Object.fromEntries(Object.entries(db.query(documentedSql("metrics")).get()!)
    .map(([key, value]) => [key, value === null ? null : Number(value)]));
  const metrics = read();
  expect(metrics).toMatchObject({ evaluated_links: 10, missing_chat_identity_rows: 0,
    shared_chat_count: 4, shared_chat_binding_count: 9, mixed_disposition_chat_count: 2,
    mixed_disposition_binding_count: 5, preserved_group_discarded_p2p_chat_count: 1,
    preserved_multi_issue_chat_count: 0 });
  const rows = db.query(documentedSql("detail")).all();
  expect(rows).toHaveLength(10);
  for (const row of rows) expect(row.chat_session_id).toBe(JSON.parse(row.binding_snapshot).chat_session_id);
  runMigrations(db);
  expect(read()).toEqual(metrics);
  // Live repairs/deletions must not erase the migration's conflict evidence.
  db.run("DELETE FROM multiremi_feishu_bot_chat_bindings WHERE app_id = 'app_metrics'");
  expect(read()).toEqual(metrics);
  // Synthetic historical/imported audit rows, deliberately NOT a migration
  // output: newly classified bindings all inherit their Chat's one legacy Issue.
  for (const [id, chat, issue, disposition] of [
    ["synthetic_a", "synthetic_shared", "issue_a", "preserved"],
    ["synthetic_a_duplicate", "synthetic_shared", "issue_a", "preserved"],
    ["synthetic_b", "synthetic_shared", "issue_b", "preserved"],
    ["synthetic_single", "synthetic_single", "issue_b", "preserved"],
  ]) db.run(`INSERT INTO multiremi_feishu_bot_issue_link_audit
    (binding_id, workspace_id, chat_session_id, issue_id, disposition, reason, audited_at, classification_version, binding_snapshot)
    VALUES (?, 'local', ?, ?, ?, ?, ?, 2, '{}')`,
  [id, chat, issue, disposition, disposition === "preserved" ? "synced_group" : "unproven_ownership", now]);
  expect(read()).toMatchObject({ preserved_multi_issue_chat_count: 1, shared_chat_count: 5,
    mixed_disposition_chat_count: 2 });
  db.run(`INSERT INTO multiremi_feishu_bot_issue_link_audit
    (binding_id, workspace_id, chat_session_id, issue_id, disposition, reason, audited_at, classification_version, binding_snapshot)
    VALUES ('synthetic_c', 'local', 'synthetic_shared', 'issue_c', 'discarded', 'unproven_ownership', ?, 2, '{}')`, [now]);
  expect(read()).toMatchObject({ preserved_multi_issue_chat_count: 1, mixed_disposition_chat_count: 3 });
  db.run("UPDATE multiremi_feishu_bot_issue_link_audit SET issue_id = 'issue_a' WHERE binding_id = 'synthetic_b'");
  expect(read()).toMatchObject({ preserved_multi_issue_chat_count: 0 });
  db.run("UPDATE multiremi_feishu_bot_issue_link_audit SET issue_id = 'issue_b' WHERE binding_id = 'synthetic_b'");
  // An already-migrated early schema gets the nullable column idempotently,
  // without inventing Chat IDs or replaying the ownership migration.
  db.exec("ALTER TABLE multiremi_feishu_bot_issue_link_audit DROP COLUMN chat_session_id");
  runMigrations(db);
  runMigrations(db);
  expect(read()).toMatchObject({ evaluated_links: 15, missing_chat_identity_rows: 15,
    shared_chat_count: null, shared_chat_binding_count: null, mixed_disposition_chat_count: null,
    mixed_disposition_binding_count: null, preserved_group_discarded_p2p_chat_count: null,
    preserved_multi_issue_chat_count: null });
}

function assertPrelinkedIssueConflicts(db: SqlDatabase) {
  db.run("DELETE FROM multiremi_feishu_bot_issue_link_audit");
  db.exec("ALTER TABLE multiremi_chat_sessions ADD COLUMN issue_id TEXT");
  const now = new Date().toISOString();
  for (const issue of ["prelinked_a", "prelinked_b"]) db.run(`INSERT INTO multiremi_issues
    (id, title, status, created_at, updated_at) VALUES (?, 'Prelinked', 'todo', ?, ?)`, [issue, now, now]);
  // Both prelinked A/B, and newly preserved A + prelinked B, are schema-valid.
  // They bypass the ambiguity fallback when old Chat/task ownership matches A.
  for (const kind of ["both", "partial"]) {
    const chat = `prelinked_${kind}`;
    db.run(`INSERT INTO multiremi_chat_sessions
      (id, agent_id, issue_id, title, session_id, session_provider, session_execution_fingerprint, created_at, updated_at)
      VALUES (?, 'agt_metrics', 'prelinked_a', 'Prelinked', 'ambiguous-provider', 'codex', 'ambiguous-fingerprint', ?, ?)`, [chat, now, now]);
    for (const status of ["queued", "running"]) db.run(`INSERT INTO multiremi_tasks
      (id, agent_id, chat_session_id, issue_id, status, prompt, session_id, created_at, updated_at)
      VALUES (?, 'agt_metrics', ?, 'prelinked_a', ?, 'Fixture', 'ambiguous-task-provider', ?, ?)`,
    [`${chat}_${status}`, chat, status, now, now]);
    for (const issue of ["prelinked_a", "prelinked_b"]) {
      const binding = `${chat}_${issue}`;
      db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
        (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, chat_id, issue_id, created_at, updated_at)
        VALUES (?, 'local', 'app_metrics', 'agt_metrics', ?, ?, ?, ?, ?, ?)`,
      [binding, binding, chat, binding, kind === "partial" && issue === "prelinked_a" ? null : issue, now, now]);
      db.run(`INSERT INTO multiremi_feishu_messages
        (message_id, workspace_id, source_id, chat_id, chat_type, content_fingerprint, created_at, ingested_at)
        VALUES (?, 'local', 'shared_metrics_source', ?, 'group', 'fixture', ?, ?)`, [binding, binding, now, now]);
    }
  }
  expect(db.query(documentedSql("live-multi-issue")).all().map((row) => row.chat_session_id)).toEqual(["prelinked_both"]);
  db.run("DELETE FROM multiremi_schema_migrations WHERE id = '20260916_chat_issue_decoupling'");
  for (let startup = 0; startup < 2; startup++) {
    runMigrations(db);
    const conflicts = db.query(documentedSql("live-multi-issue")).all();
    expect(conflicts.map((row) => ({ chat: row.chat_session_id, bindings: Number(row.live_binding_count), issues: Number(row.live_issue_count) })))
      .toEqual([{ chat: "prelinked_both", bindings: 2, issues: 2 }, { chat: "prelinked_partial", bindings: 2, issues: 2 }]);
    for (const kind of ["both", "partial"]) {
      const chat = `prelinked_${kind}`;
      // Characterize current behavior, not an endorsement of ambiguous resume.
      expect(db.query(`SELECT session_id, session_provider, session_execution_fingerprint
        FROM multiremi_chat_sessions WHERE id = ?`).get(chat)).toEqual({ session_id: "ambiguous-provider",
        session_provider: "codex", session_execution_fingerprint: "ambiguous-fingerprint" });
      expect(db.query(`SELECT issue_id FROM multiremi_feishu_bot_chat_bindings
        WHERE chat_session_id = ? ORDER BY issue_id`).all(chat)).toEqual([{ issue_id: "prelinked_a" }, { issue_id: "prelinked_b" }]);
      for (const status of ["queued", "running"]) expect(db.query(`SELECT status, issue_id, session_id, execution_fingerprint
        FROM multiremi_tasks WHERE id = ?`).get(`${chat}_${status}`)).toEqual({ status, issue_id: "prelinked_a",
        session_id: "ambiguous-task-provider", execution_fingerprint: null });
      expect(Number(db.query(`SELECT COUNT(*) AS n FROM multiremi_feishu_bot_issue_link_audit
        WHERE chat_session_id = ?`).get(chat).n)).toBe(kind === "both" ? 0 : 1);
    }
    expect(Number(db.query(documentedSql("metrics")).get()!.preserved_multi_issue_chat_count)).toBe(0);
  }
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
