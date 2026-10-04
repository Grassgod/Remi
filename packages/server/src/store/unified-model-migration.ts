import { createAutopilotRunReadProjection } from "./autopilot-run-records.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlDatabase } from "./db/postgres.js";
import { autopilotSessionId } from "@multiremi/contracts/unified-model.js";
import { createTurnExecutionReadProjection } from "./turn-execution-records.js";
import { UNIFIED_MODEL_MIGRATION, UNIFIED_TURNS_SCHEMA, UNIFIED_LANES_SCHEMA,
  UNIFIED_ATTEMPTS_SCHEMA, UNIFIED_MESSAGE_COLUMNS, UNIFIED_MESSAGE_INDEXES } from "./unified-model-schema.js";

type Row = Record<string, any>;
export interface UnifiedMigrationCheck { name: string; count: number; ok: boolean }
export interface UnifiedModelReport {
  migration: string;
  phase: "before" | "after";
  generated_at: string;
  checks: UnifiedMigrationCheck[];
  counts: Record<string, number>;
  attempt_ids_digest: string;
  chains: Array<{ turn_id: string; attempts: string[] }>;
  sessions: Array<{ session_id: string; head_seq: number; entries: number }>;
  lane_cursors: Array<{session_id:string;reader_type:string;reader_id:string;execution_scope:string;
    cursor_seq:number;parent_cursor_seq:number;wake_hint_seq:number;swept_to_seq:number}>;
  unread_attention: Array<{ id: string; recipient_id: string; type: string; resource_id: string | null }>;
  mismatches: string[];
}

export class UnifiedModelPreflightError extends Error {
  constructor(readonly checks: UnifiedMigrationCheck[]) {
    super(`Unified model migration refused: ${checks.filter(c => !c.ok).map(c => `${c.name}: ${c.count}`).join("; ")}`);
  }
}

export function tableExists(db: SqlDatabase, name: string): boolean {
  if (db.dialect === "postgres") return Boolean(db.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename=?").get(name));
  return Boolean(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
function count(db: SqlDatabase, table: string, where = "1=1"): number {
  if (!tableExists(db, table)) return 0;
  return Number(db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get()?.count ?? 0);
}
function columns(db: SqlDatabase, table: string): string[] {
  return db.query(`PRAGMA table_info(${table})`).all().map((r: Row) => String(r.name));
}
function addColumn(db: SqlDatabase, table: string, definition: string): void {
  if (!columns(db, table).includes(definition.split(" ")[0]!)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export function unifiedModelPreflight(db: SqlDatabase): UnifiedMigrationCheck[] {
  return [
    ["awaiting_human_tasks", "multiremi_tasks", "status = 'awaiting_human'"],
    ["unconsumed_steer", "multiremi_task_steer_messages", "consumed_at IS NULL"],
    ["running_trace_backfill_groups", "multiremi_trace_backfill_progress", "status = 'running'"],
    ["undrained_tasks", "multiremi_tasks", "status IN ('running', 'dispatched')"],
  ].map(([name, table, where]) => {
    const n = count(db, table!, where!);
    return { name: name!, count: n, ok: n === 0 };
  });
}

/** Page ids and reconstruct text separately so long prompts never overflow the PG bridge. */
function* rows(db: SqlDatabase, table: string): Generator<Row> {
  const schema = db.query(`PRAGMA table_info(${table})`).all() as Row[];
  const text = schema.filter(c => String(c.type).toUpperCase().includes("TEXT")).map(c => String(c.name));
  const selected = schema.map(c => text.includes(c.name) ? `SUBSTR(${c.name}, 1, 8192) AS ${c.name}` : c.name);
  let previous = "";
  for (;;) {
    const page = db.query(`SELECT ${selected.join(", ")} FROM ${table} WHERE id > ? ORDER BY id LIMIT 16`).all(previous) as Row[];
    if (!page.length) return;
    for (const row of page) {
      for (const col of text) {
        if (row[col] == null || String(row[col]).length < 8192) continue;
        for (let start = 8193; ; start += 8192) {
          const part = db.query(`SELECT SUBSTR(${col}, ?, 8192) AS part FROM ${table} WHERE id = ?`).get(start, row.id)?.part;
          if (!part) break;
          row[col] += String(part);
          if (String(part).length < 8192) break;
        }
      }
      yield row;
    }
    previous = String(page.at(-1)!.id);
  }
}
/** Bounded scalar report pages also avoid the bridge limit on large inventories. */
function* pagedQuery(db:SqlDatabase,sql:string,params:unknown[]=[]):Generator<Row> {
  for(let offset=0;;offset+=128){
    const page=db.query(`${sql} LIMIT 128 OFFSET ?`).all(...params,offset) as Row[];
    yield* page;if(page.length<128)return;
  }
}
function json(value: unknown, fallback: any = {}): any {
  if (typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value); } catch { throw new Error("Unified model migration: malformed historical JSON"); }
}
function digest(ids: string[]): string { return createHash("sha256").update(JSON.stringify(ids.sort())).digest("hex"); }

/** A parent pointer only groups infrastructure retries; explicit continuations remain separate. */
export function retryChains(tasks: readonly Row[]): Array<Row[]> {
  const byId = new Map(tasks.map(t => [String(t.id), t]));
  const grouped = new Map<string, Row[]>();
  for (const task of tasks) {
    let root = task;
    const seen = new Set<string>();
    while (root.parent_task_id && Number(root.attempt??2)>1) {
      if (seen.has(root.id)) throw new Error(`Unified migration: cyclic retry chain at ${root.id}`);
      seen.add(root.id);
      const parent = byId.get(String(root.parent_task_id));
      if (!parent) throw new Error(`Unified migration: missing retry parent ${root.parent_task_id}`);
      if (parent.agent_id !== task.agent_id || parent.workspace_id !== task.workspace_id) {
        throw new Error(`Unified migration: retry chain crosses agent/workspace at ${task.id}`);
      }
      root = parent;
    }
    const list = grouped.get(root.id) ?? [];
    list.push(task);
    grouped.set(root.id, list);
  }
  return [...grouped.values()].map(chain => chain.sort((a, b) =>
    Number(a.attempt ?? 1) - Number(b.attempt ?? 1) || String(a.created_at).localeCompare(b.created_at) || String(a.id).localeCompare(b.id)));
}

function historicalResult(value:unknown):{output:string|null;provenance:Record<string,unknown>} {
  let parsed:any=value;
  if(typeof value==='string'){try{parsed=JSON.parse(value);}catch{parsed=value;}}
  if(typeof parsed==='object'&&parsed!==null){const{output,...provenance}=parsed;return {output:output==null?null:String(output),provenance};}
  return {output:parsed==null?null:String(parsed),provenance:{}};
}

export function collectUnifiedBeforeReport(db: SqlDatabase): UnifiedModelReport {
  const tasks = [...rows(db, "multiremi_tasks")];
  const chains = retryChains(tasks);
  const unreadAttention = tableExists(db, "multiremi_inbox_items")
    ? [...pagedQuery(db, `SELECT id,recipient_id,type,issue_id AS resource_id FROM multiremi_inbox_items
        WHERE read=0 AND archived=0 AND severity='attention' ORDER BY id`)] : [];
  return {
    migration: UNIFIED_MODEL_MIGRATION, phase: "before", generated_at: new Date().toISOString(),
    checks: unifiedModelPreflight(db), counts: {
      tasks: tasks.length, turns: chains.length,
      agent_lanes: count(db, "multiremi_session_agent_lanes"),
      pending_decisions: count(db, "multiremi_issue_decisions", "status = 'pending'"),
      messages: count(db, "multiremi_conversation_log", "kind IN ('message','system','delegation_report')"),
      autopilots: count(db, "multiremi_autopilots"),
      inbox_items_not_migrated: count(db, "multiremi_inbox_items"),
    },
    attempt_ids_digest: digest(tasks.map(t => String(t.id))),
    chains: chains.map(c => ({ turn_id: String(c[0]!.id), attempts: c.map(t => String(t.id)) })),
    sessions: [...pagedQuery(db,`SELECT h.session_id,h.head_seq,COUNT(l.id) AS entries FROM multiremi_conversation_heads h
      LEFT JOIN multiremi_conversation_log l ON l.session_id=h.session_id GROUP BY h.session_id,h.head_seq ORDER BY h.session_id`)] as any,
    lane_cursors:[...pagedQuery(db,`SELECT session_id,'agent' AS reader_type,agent_id AS reader_id,execution_scope,
      cursor_seq,parent_cursor_seq,wake_hint_seq,swept_to_seq FROM multiremi_session_agent_lanes ORDER BY session_id,agent_id,execution_scope`)] as any,
    unread_attention: unreadAttention.map(r => ({ id: r.id, recipient_id: r.recipient_id, type: r.type, resource_id: r.resource_id })),
    mismatches: [],
  };
}

export function writeUnifiedModelReport(dir: string, phase: string, report: UnifiedModelReport): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${UNIFIED_MODEL_MIGRATION}-${phase}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}
function insert(db: SqlDatabase, table: string, value: Row): void {
  const keys = Object.keys(value);
  db.run(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, keys.map(k => value[k] ?? null));
}
function append(db: SqlDatabase, sessionId: string, value: Row): number {
  const now = String(value.created_at ?? new Date().toISOString());
  db.run(`INSERT INTO multiremi_conversation_heads(session_id, head_seq, log_version, updated_at)
    VALUES (?, 0, 0, ?) ON CONFLICT(session_id) DO NOTHING`, [sessionId, now]);
  const head = db.query(`UPDATE multiremi_conversation_heads SET head_seq = head_seq + 1,
    log_version = log_version + 1, updated_at = ? WHERE session_id = ? RETURNING head_seq`).get(now, sessionId);
  insert(db, "multiremi_conversation_log", {
    session_id: sessionId, seq: head.head_seq, kind: "message", visibility: "shown", sender_type: "platform",
    sender_id: null, body_md: "", metadata: "{}", revision: 1, created_at: now, updated_at: now, ...value,
  });
  return Number(head.head_seq);
}
function ensureAutoHead(db: SqlDatabase, sessionId: string, title: string, at: string): void {
  db.run(`INSERT INTO multiremi_conversation_heads(session_id, head_seq, log_version, updated_at)
    VALUES (?, 0, 0, ?) ON CONFLICT(session_id) DO NOTHING`, [sessionId, at]);
  if (!db.query("SELECT id FROM multiremi_conversation_log WHERE session_id = ? AND seq = 0").get(sessionId)) {
    insert(db, "multiremi_conversation_log", { session_id: sessionId, seq: 0, id: `head_${sessionId}`,
      kind: "head", visibility: "shown", sender_type: "platform", sender_id: null, body_md: title,
      metadata: JSON.stringify({ title }), created_at: at, updated_at: at });
  }
}
function resolveIssueOwner(db: SqlDatabase, issueId: string): { agent: string | null; member: string | null } {
  const issue = db.query("SELECT assignee_type, assignee_id, workspace_id FROM multiremi_issues WHERE id = ?").get(issueId);
  if (issue?.assignee_type === "agent") return { agent: issue.assignee_id, member: null };
  if (issue?.assignee_type === "squad") {
    return { agent: db.query("SELECT leader_id FROM multiremi_squads WHERE id = ?").get(issue.assignee_id)?.leader_id ?? null, member: null };
  }
  const member = issue?.assignee_type === "member" ? issue.assignee_id
    : issue?.assignee_type === "user" ? db.query("SELECT id FROM multiremi_workspace_members WHERE user_id = ? AND workspace_id = ?")
        .get(issue.assignee_id, issue.workspace_id)?.id : null;
  return { agent: null, member: member ?? null };
}

function migrateHeaders(db: SqlDatabase): void {
  db.exec("ALTER TABLE multiremi_conversation_log RENAME COLUMN author_type TO sender_type");
  db.exec("ALTER TABLE multiremi_conversation_log RENAME COLUMN author_id TO sender_id");
  db.exec("ALTER TABLE multiremi_conversation_log RENAME COLUMN parent_id TO reply_to_id");
  for (const definition of UNIFIED_MESSAGE_COLUMNS) addColumn(db, "multiremi_conversation_log", definition);
  for (const row of rows(db, "multiremi_conversation_log")) {
    const metadata = json(row.metadata);
    const envelope = metadata.envelope;
    delete metadata.envelope;
    if(envelope){const {to,kind,wake,dedupeKey,replyTo,recipient_agent_id,...provenance}=envelope;
      metadata.message_source=provenance.source;metadata.priority=provenance.priority;metadata.message_outcome=provenance.outcome;
      metadata.address_context=Object.fromEntries(Object.entries(to??{}).filter(([k])=>k!=='role'&&k!=='agentId'));}
    let toType = "none", toRef: string | null = null, toAgent: string | null = null, toMember: string | null = null;
    let messageKind = row.reply_to_id ? "reply" : row.sender_type === "member" ? "request" : "status";
    let requested = "inbox_only", applied = "inbox_only";
    if (envelope) {
      const address = envelope.to ?? {};
      const role = address.role;
      toType = role === "agent" || role === "chat" ? "agent" : "role";
      toRef = toType === "agent" ? address.agentId : role;
      toAgent = envelope.recipient_agent_id ?? (toType === "agent" ? address.agentId : null);
      if (!toAgent && (role === "issue_owner" || role === "parent_owner")) {
        const issueId = role === "issue_owner" ? address.issueId
          : db.query("SELECT parent_issue_id FROM multiremi_issues WHERE id = ?").get(address.childIssueId)?.parent_issue_id;
        if (issueId) { const owner = resolveIssueOwner(db, issueId); toAgent = owner.agent; toMember = owner.member; }
      }
      messageKind = envelope.kind === "decision_needed" ? "decision" : envelope.kind === "lifecycle" ? "status" : envelope.kind;
      requested = envelope.wake ?? "inbox_only";
      applied = requested;
    }
    if (row.kind === "delegation_report") {
      toType = "role"; toRef = "delegator"; messageKind = "report";
      const delegation=metadata.delegation_id;
      toAgent=metadata.delegated_by_agent_id ?? (delegation?db.query('SELECT delegated_by_agent_id FROM multiremi_tasks WHERE delegation_id=? ORDER BY created_at LIMIT 1').get(delegation)?.delegated_by_agent_id:null) ?? null;
    }
    const senderType = row.sender_type === "system" || row.sender_type === "external" ? "platform" : row.sender_type;
    db.run(`UPDATE multiremi_conversation_log SET sender_type = ?, kind = ?, visibility = ?,
      to_type = ?, to_ref = ?, to_agent_id = ?, to_member_id = ?, message_kind = ?,
      wake_requested = ?, wake_applied = ?, wake_reason = 'migration', reply_to_id = ?, dedupe_key = ?, metadata = ? WHERE id = ?`,
      [senderType, row.kind === "system" || row.kind === "delegation_report" ? "message" : row.kind,
        row.kind === "delegation_report" ? "shown" : row.visibility, toType, toRef, toAgent, toMember,
        messageKind, requested, applied, row.reply_to_id ?? envelope?.replyTo ?? null, envelope?.dedupeKey ?? null,
        JSON.stringify(metadata), row.id]);
  }
  db.exec(UNIFIED_MESSAGE_INDEXES);
}

/** Normalized turn fields not exposed to the wire: scheduling and legacy producer provenance. */
const TURN_INTERNAL_COLUMNS = [
  "runtime_workspace_id TEXT", "task_kind TEXT NOT NULL DEFAULT 'direct'", "issue_session_generation INTEGER",
  "trigger_comment_id TEXT", "trigger_summary TEXT", "max_attempts INTEGER NOT NULL DEFAULT 3",
  "issue_creation_restricted INTEGER NOT NULL DEFAULT 0", "assignment_event_id TEXT", "assignment_source_event_id TEXT",
  "chat_queue_order INTEGER NOT NULL DEFAULT 0", "bound_issue_log_to_seq INTEGER", "bound_issue_log_delivered_seq INTEGER",
] as const;
const ATTEMPT_INTERNAL_COLUMNS = [
  "inherited_projection_truncated INTEGER", "inherited_projection_omitted_events INTEGER", "inherited_projection_estimated_tokens INTEGER",
  "inherited_projection_to_seq INTEGER", "inherited_projection_from_seq INTEGER", "inherited_projection_token_budget INTEGER",
  "inherited_projection_recorded_at TEXT",
] as const;

function migrateTurns(db: SqlDatabase, tasks: Row[]): void {
  db.exec(UNIFIED_TURNS_SCHEMA.replace(/CREATE UNIQUE INDEX[\s\S]*?WHERE status = 'pending';/, ""));
  for (const col of TURN_INTERNAL_COLUMNS) addColumn(db, "multiremi_turns", col);
  db.exec("ALTER TABLE multiremi_tasks RENAME TO multiremi_turn_attempts");
  // SQLite keeps id foreign keys pointed at the final name while rebuilding the
  // same table with foreign keys disabled by the outer migration owner.
  if (db.dialect === "postgres") {
    db.exec("ALTER TABLE multiremi_turn_attempts RENAME TO multiremi_unified_attempt_source");
    // Rename references back after copying, before dropping the source below.
  }
  db.exec(UNIFIED_ATTEMPTS_SCHEMA.replaceAll("multiremi_turn_attempts", "multiremi_unified_attempt_copy"));
  for (const col of ATTEMPT_INTERNAL_COLUMNS) addColumn(db, "multiremi_unified_attempt_copy", col);
  const attemptColumns = columns(db, "multiremi_unified_attempt_copy");
  const turnColumns = columns(db, "multiremi_turns");
  const chains = retryChains(tasks);
  const turnByAttempt = new Map<string, string>();
  for (const chain of chains) {
    const root = chain[0]!;
    for (const task of chain) turnByAttempt.set(task.id, root.id);
  }
  chains.sort((a,b) => String(a[0]!.created_at).localeCompare(b[0]!.created_at)||String(a[0]!.id).localeCompare(b[0]!.id));
  // Keep each historical work identity. Queue entries for the same reader fold
  // into the oldest pending input; the other turns remain cancelled history.
  const pendingGroups=new Map<string,Row[][]>();
  for(const chain of chains){const current=chain.at(-1)!;
    if(current.status!=='queued')continue;
    const run=db.query('SELECT autopilot_id FROM multiremi_autopilot_runs WHERE task_id=? OR source_task_id=? ORDER BY created_at LIMIT 1').get(chain[0]!.id,chain[0]!.id);
    const session=chain[0]!.issue_session_id??chain[0]!.chat_session_id??autopilotSessionId(run?.autopilot_id??`orphan_${chain[0]!.workspace_id}`);
    const key=JSON.stringify([session,current.agent_id,current.execution_scope??'']);
    const group=pendingGroups.get(key)??[];group.push(chain);pendingGroups.set(key,group);
  }
  const folded=new Set<string>(),pendingPrompts=new Map<string,string>();
  for(const group of pendingGroups.values()){if(group.length<2)continue;
    pendingPrompts.set(group[0]![0]!.id,group.map(c=>c[0]!.prompt??'').join('\n\n'));
    for(const chain of group.slice(1))folded.add(chain[0]!.id);
  }
  for (const chain of chains) {
    const root = chain[0]!;
    const current = chain.at(-1)!;
    const run = db.query("SELECT autopilot_id FROM multiremi_autopilot_runs WHERE task_id = ? OR source_task_id = ? ORDER BY created_at LIMIT 1")
      .get(root.id, root.id);
    const sessionId = root.issue_session_id ?? root.chat_session_id ?? autopilotSessionId(run?.autopilot_id ?? `orphan_${root.workspace_id}`);
    ensureAutoHead(db, sessionId, run ? "Automation" : "Historical execution", root.created_at);
    const cards = db.query(`SELECT id, seq, metadata, body_md FROM multiremi_conversation_log
      WHERE task_id = ? AND kind = 'turn' AND session_id = ? ORDER BY seq LIMIT 1`).get(root.id, sessionId) as Row | null;
    const metadata = json(cards?.metadata);
    let replyId:string|null=null;
    const currentCard=db.query("SELECT id,metadata FROM multiremi_conversation_log WHERE task_id=? AND kind='turn' ORDER BY seq DESC LIMIT 1").get(current.id);
    const currentMetadata=json(currentCard?.metadata);
    replyId=currentMetadata.final_entry_id??metadata.final_entry_id??null;
    const taskResult=historicalResult(current.result);
    const finalBody=currentMetadata.final_reply_md??taskResult.output;
    if(!replyId&&finalBody){replyId=`msg_migrated_${root.id}`;append(db,sessionId,{id:replyId,sender_type:'agent',sender_id:root.agent_id,message_kind:'reply',task_id:root.id,body_md:finalBody,metadata:JSON.stringify({task_result:taskResult.provenance}),created_at:current.completed_at??current.updated_at});}
    if(replyId&&Object.keys(taskResult.provenance).length){const reply=db.query('SELECT metadata FROM multiremi_conversation_log WHERE id=?').get(replyId);
      if(reply)db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?',[JSON.stringify({...json(reply.metadata),task_result:taskResult.provenance}),replyId]);}
    const turnValue: Row = {
      ...Object.fromEntries(turnColumns.filter(c => root[c] !== undefined).map(c => [c, root[c]])),
      id: root.id, session_id: sessionId, seq: cards?.seq ?? 0,
      status: folded.has(root.id) ? "cancelled" : current.status === "queued" ? "pending" : current.status === "dispatched" || current.status === "waiting_local_directory" ? "running" : current.status,
      current_attempt_id: current.id, legacy_prompt: pendingPrompts.get(root.id) ?? cards?.body_md ?? root.prompt ?? null,
      input_from_seq: metadata.inbox?.delivered_from_seq ?? current.projection_from_seq ?? null,
      input_to_seq: metadata.inbox?.delivered_to_seq ?? current.projection_to_seq ?? null,
      reply_message_id: replyId,
      continued_from_turn_id: turnByAttempt.get(root.continued_from_task_id) ?? root.continued_from_task_id ?? null,
      delegation_return_turn_id: turnByAttempt.get(current.delegation_return_task_id) ?? current.delegation_return_task_id ?? null,
      started_at: chain.find(t => t.started_at)?.started_at ?? null,
      ended_at: current.completed_at ?? current.failed_at ?? current.cancelled_at ?? null,
      ended_reason: current.failure_reason ?? null,
    };
    if (!cards) turnValue.seq = append(db, sessionId, { id: root.id, kind: "turn", sender_type: "agent", sender_id: root.agent_id,
      task_id: root.id, created_at: root.created_at });
    insert(db, "multiremi_turns", turnValue);
    for (let index = 0; index < chain.length; index++) {
      const task = chain[index]!;
      const card = db.query("SELECT metadata FROM multiremi_conversation_log WHERE task_id = ? AND kind = 'turn' ORDER BY seq LIMIT 1").get(task.id);
      const cardMeta = json(card?.metadata);
      const value: Row = Object.fromEntries(attemptColumns.filter(c => task[c] !== undefined).map(c => [c, task[c]]));
      Object.assign(value, { id: task.id, turn_id: root.id, attempt_no: index + 1,
        status: task.status === "queued" ? (task.id===current.id&&!folded.has(root.id)?"offered":"cancelled") : task.status === "dispatched" ? "accepted" : task.status === "awaiting_human" ? "running" : task.status,
        ended_at: task.completed_at ?? task.failed_at ?? task.cancelled_at ?? null,
        event_count: cardMeta.event_count ?? null, tool_call_count: cardMeta.tool_call_count ?? null,
        type_histogram: cardMeta.type_histogram == null ? null : JSON.stringify(cardMeta.type_histogram),
        model: cardMeta.model == null ? null : JSON.stringify(cardMeta.model), trace_ref: cardMeta.trace_ref == null ? null : JSON.stringify(cardMeta.trace_ref) });
      insert(db, "multiremi_unified_attempt_copy", value);
    }
    // Retried cards lose their display identity but retain their seq as hidden
    // markers, so already persisted lane cursors never change meaning.
    for (const task of chain) {
      db.run(`UPDATE multiremi_conversation_log SET id = ?, body_md = '', body_html = NULL, render_version = NULL,
        metadata = '{}', task_id = ? WHERE session_id = ? AND seq = ? AND kind = 'turn'`, [root.id, root.id, sessionId, turnValue.seq]);
      db.run(`UPDATE multiremi_conversation_log SET kind = 'task_failed', visibility = 'hidden', metadata = '{}', body_md = ''
        WHERE task_id = ? AND kind = 'turn' AND id <> ?`, [task.id, root.id]);
      db.run("UPDATE multiremi_conversation_log SET task_id = ? WHERE task_id = ?", [root.id, task.id]);
      db.run("UPDATE multiremi_issue_comments SET task_id = ? WHERE task_id = ?", [root.id, task.id]);
    }
  }
  if (db.dialect === "postgres") {
    // Preserve the renamed table's OID and all referencing FKs: replace its
    // columns/data in place instead of redirecting references to a new OID.
    const original = columns(db, "multiremi_unified_attempt_source");
    for (const col of attemptColumns) {
      if (!original.includes(col)) {
        const info = db.query("PRAGMA table_info(multiremi_unified_attempt_copy)").all().find((r: Row) => r.name === col)!;
        addColumn(db, "multiremi_unified_attempt_source", `${col} ${info.type}`);
      }
    }
    for (const col of original.filter(c => !attemptColumns.includes(c))) db.exec(`ALTER TABLE multiremi_unified_attempt_source DROP COLUMN ${col}`);
    db.exec(`UPDATE multiremi_unified_attempt_source AS target SET ${attemptColumns.filter(c => c !== "id").map(c =>
      `${c} = (SELECT ${c} FROM multiremi_unified_attempt_copy WHERE id = target.id)`).join(",")}`);
    db.exec("DROP TABLE multiremi_unified_attempt_copy");
    db.exec("ALTER TABLE multiremi_unified_attempt_source RENAME TO multiremi_turn_attempts");
    db.exec("ALTER TABLE multiremi_turn_attempts ALTER COLUMN turn_id SET NOT NULL; ALTER TABLE multiremi_turn_attempts ALTER COLUMN attempt_no SET NOT NULL");
    for (const info of db.query('PRAGMA table_info(multiremi_turn_attempts)').all() as Row[]) {
      if(info.name==='id')continue;
      const definition=UNIFIED_ATTEMPTS_SCHEMA.match(new RegExp(`\\b${info.name} (TEXT|INTEGER)([^,\\n]*)`));
      const fallback=definition?.[2]?.match(/DEFAULT (.*)/)?.[1];
      if(fallback)db.exec(`ALTER TABLE multiremi_turn_attempts ALTER COLUMN ${info.name} SET DEFAULT ${fallback}`);
    }
    db.exec("ALTER TABLE multiremi_turn_attempts ADD CONSTRAINT unified_attempt_status CHECK(status IN ('offered','accepted','running','waiting_local_directory','completed','failed','cancelled','lost'))");
  } else {
    db.exec("DROP TABLE multiremi_turn_attempts");
    db.exec("ALTER TABLE multiremi_unified_attempt_copy RENAME TO multiremi_turn_attempts");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_turn_attempts_turn_no ON multiremi_turn_attempts(turn_id, attempt_no);
    CREATE INDEX IF NOT EXISTS idx_multiremi_turn_attempts_runtime ON multiremi_turn_attempts(runtime_id,status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_turns_pending_lane ON multiremi_turns(session_id,agent_id,execution_scope) WHERE status='pending';`);
}

function migrateLanes(db: SqlDatabase): void {
  db.exec(UNIFIED_LANES_SCHEMA);
  const sourceColumns = columns(db, "multiremi_session_agent_lanes");
  const targetColumns = columns(db, "multiremi_session_lanes");
  const shared = targetColumns.filter(c => sourceColumns.includes(c));
  db.exec(`INSERT INTO multiremi_session_lanes (${shared.join(",")},reader_type,reader_id,last_attempt_id)
    SELECT ${shared.join(",")},'agent',agent_id,last_task_id FROM multiremi_session_agent_lanes`);
  db.exec("DROP TABLE multiremi_session_agent_lanes");
  for (const chat of rows(db, "multiremi_chat_sessions")) {
    if (!chat.agent_id) continue;
    const receipt = db.query("SELECT input_to_seq FROM multiremi_turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(chat.id);
    const head = db.query("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ?").get(chat.id);
    db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,cursor_seq,created_at,updated_at)
      VALUES (?,'agent',?,?,?,?) ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO NOTHING`,
      [chat.id, chat.agent_id, receipt?.input_to_seq ?? head?.head_seq ?? 0, chat.created_at, chat.updated_at]);
  }
  db.exec(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,cursor_seq,created_at,updated_at)
    SELECT log.session_id,'member',log.to_member_id,head.head_seq,head.updated_at,head.updated_at
    FROM multiremi_conversation_log log JOIN multiremi_conversation_heads head ON head.session_id=log.session_id
    WHERE log.to_member_id IS NOT NULL GROUP BY log.session_id,log.to_member_id,head.head_seq,head.updated_at
    ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO NOTHING`);
}
function migrateDecisions(db: SqlDatabase): void {
  for (const decision of rows(db, "multiremi_issue_decisions")) {
    if (decision.status !== "pending") continue;
    const session = db.query("SELECT id FROM multiremi_issue_sessions WHERE issue_id = ? ORDER BY is_default DESC,created_at,id LIMIT 1").get(decision.issue_id);
    if (!session) throw new Error(`Unified migration: pending decision ${decision.id} has no conversation`);
    const owner = resolveIssueOwner(db, decision.issue_id);
    append(db, session.id, { id: decision.id, sender_type: decision.created_by_agent_id ? "agent" : "platform",
      sender_id: decision.created_by_agent_id, to_type: "role", to_ref: "issue_owner", to_agent_id: owner.agent,
      to_member_id: owner.member, message_kind: "decision", wake_requested: "now", wake_applied: "now", wake_reason: "migration",
      body_md: [decision.title,decision.body].filter(Boolean).join("\n\n"), options: decision.options,
      card_token_hash: decision.token_hash, card_token_recipient: decision.token_recipient,
      card_token_consumed_at: decision.token_consumed_at, created_at: decision.created_at,
      metadata: JSON.stringify({ migrated_decision_id: decision.id, source_issue_id: decision.source_issue_id }) });
  }
}
function migrateAutopilots(db: SqlDatabase): void {
  addColumn(db, "multiremi_autopilots", "session_id TEXT");
  for (const autopilot of rows(db, "multiremi_autopilots")) {
    const id = autopilotSessionId(autopilot.id);
    db.run("UPDATE multiremi_autopilots SET session_id = ? WHERE id = ?", [id, autopilot.id]);
    ensureAutoHead(db, id, autopilot.title, autopilot.created_at);
  }
  addColumn(db, "multiremi_autopilot_runs", "turn_id TEXT");
  db.exec(`UPDATE multiremi_autopilot_runs SET turn_id=(SELECT turn_id FROM multiremi_turn_attempts WHERE id=multiremi_autopilot_runs.task_id)`);
  addColumn(db,'multiremi_autopilot_runs','outcome_message_id TEXT');
  for(const run of rows(db,'multiremi_autopilot_runs')) {
    const session=autopilotSessionId(run.autopilot_id),id=`msg_migrated_${run.id}`;
    append(db,session,{id,sender_type:'timer',sender_id:run.autopilot_id,message_kind:'status',
      body_md:run.failure_reason??`Historical run ${run.status}`,
      metadata:JSON.stringify({run_id:run.id,turn_id:run.turn_id,run_result:run.result}),created_at:run.created_at});
    db.run('UPDATE multiremi_autopilot_runs SET outcome_message_id=? WHERE id=?',[id,run.id]);
  }
  const retired=['task_id','status','result'];
  if(db.dialect==='sqlite'){
    const info=db.query('PRAGMA table_info(multiremi_autopilot_runs)').all() as Row[];
    const kept=info.filter(c=>!retired.includes(c.name));
    const indexes=db.query("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='multiremi_autopilot_runs' AND sql IS NOT NULL").all() as Row[];
    db.exec(`CREATE TABLE multiremi_unified_run_copy(${kept.map(c=>`${c.name} ${c.type}${c.pk?' PRIMARY KEY':''}${c.notnull?' NOT NULL':''}${c.dflt_value!=null?` DEFAULT ${c.dflt_value}`:''}`).join(',')})`);
    db.exec(`INSERT INTO multiremi_unified_run_copy SELECT ${kept.map(c=>c.name).join(',')} FROM multiremi_autopilot_runs; DROP TABLE multiremi_autopilot_runs; ALTER TABLE multiremi_unified_run_copy RENAME TO multiremi_autopilot_runs`);
    for(const index of indexes)if(!retired.some(c=>new RegExp(`\\b${c}\\b`).test(index.sql)))db.exec(index.sql);
  }else for(const col of retired)db.exec(`ALTER TABLE multiremi_autopilot_runs DROP COLUMN ${col}`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_multiremi_autopilot_runs_turn ON multiremi_autopilot_runs(turn_id); CREATE INDEX IF NOT EXISTS idx_autopilot_schedule_queue ON multiremi_autopilot_runs(autopilot_id,schedule_batch_id,schedule_position)');
}

function migrateConversationReferences(db:SqlDatabase):void {
  const retired=['multiremi_issue_comments','multiremi_chat_messages','multiremi_session_events'];
  if(db.dialect==='postgres'){
    const constraints=db.query(`SELECT c.conname,t.relname,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_class target ON target.oid=c.confrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE c.contype='f' AND n.nspname=current_schema() AND target.relname IN ('multiremi_issue_comments','multiremi_chat_messages','multiremi_session_events')`).all() as Row[];
    for(const c of constraints){if(retired.includes(c.relname))continue;
      const definition=String(c.definition).replace(/REFERENCES (?:\w+\.)?(multiremi_issue_comments|multiremi_chat_messages|multiremi_session_events)/,'REFERENCES multiremi_conversation_log');
      db.exec(`ALTER TABLE "${c.relname}" DROP CONSTRAINT "${c.conname}"; ALTER TABLE "${c.relname}" ADD CONSTRAINT "${c.conname}" ${definition}`);}
  }else{
    const tables=db.query("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all() as Row[];
    for(const table of tables){if(retired.includes(table.name)||!retired.some(t=>new RegExp(`REFERENCES\\s+${t}\\b`,'i').test(table.sql)))continue;
      const indexes=db.query("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table.name) as Row[];
      const copy=`${table.name}_unified_copy`;
      const ddl=String(table.sql).replace(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ["\\x60]?${table.name}["\\x60]?`,'i'),`CREATE TABLE ${copy}`)
        .replace(/REFERENCES\s+(?:multiremi_issue_comments|multiremi_chat_messages|multiremi_session_events)/g,'REFERENCES multiremi_conversation_log');
      db.exec(ddl);db.exec(`INSERT INTO ${copy} SELECT * FROM ${table.name}; DROP TABLE ${table.name}; ALTER TABLE ${copy} RENAME TO ${table.name}`);
      for(const index of indexes)db.exec(index.sql);
    }
  }
}

export function reconcileUnifiedModel(db: SqlDatabase, before?: UnifiedModelReport): UnifiedModelReport {
  const attemptIds = [...pagedQuery(db,"SELECT id FROM multiremi_turn_attempts ORDER BY id")].map(r=>String(r.id));
  const report: UnifiedModelReport = {
    migration: UNIFIED_MODEL_MIGRATION, phase: "after", generated_at: new Date().toISOString(), checks: [],
    counts: { attempts: attemptIds.length, turns: count(db,"multiremi_turns"),
      agent_lanes: count(db,"multiremi_session_lanes","reader_type='agent'"),
      member_lanes: count(db,"multiremi_session_lanes","reader_type='member'"),
      decisions: count(db,"multiremi_conversation_log","message_kind='decision' AND kind='message'"),
      autopilots: count(db,"multiremi_autopilots"), messages: count(db,"multiremi_conversation_log","kind='message'") },
    attempt_ids_digest: digest(attemptIds),
    chains: [...pagedQuery(db,"SELECT id FROM multiremi_turns ORDER BY id")].map((t: Row) => ({ turn_id: t.id,
      attempts: [...pagedQuery(db,"SELECT id FROM multiremi_turn_attempts WHERE turn_id=? ORDER BY attempt_no",[t.id])].map((a: Row) => a.id) })),
    sessions: [...pagedQuery(db,`SELECT h.session_id,h.head_seq,COUNT(l.id) AS entries FROM multiremi_conversation_heads h
      LEFT JOIN multiremi_conversation_log l ON l.session_id=h.session_id GROUP BY h.session_id,h.head_seq ORDER BY h.session_id`)] as any,
    lane_cursors:[...pagedQuery(db,`SELECT session_id,reader_type,reader_id,execution_scope,cursor_seq,parent_cursor_seq,
      wake_hint_seq,swept_to_seq FROM multiremi_session_lanes ORDER BY session_id,reader_type,reader_id,execution_scope`)] as any,
    unread_attention: before?.unread_attention ?? [], mismatches: [],
  };
  const checks = [
    ["orphan_attempts", `SELECT COUNT(*) AS count FROM multiremi_turn_attempts a LEFT JOIN multiremi_turns t ON t.id=a.turn_id WHERE t.id IS NULL`],
    ["missing_current_attempts", `SELECT COUNT(*) AS count FROM multiremi_turns t LEFT JOIN multiremi_turn_attempts a ON a.id=t.current_attempt_id AND a.turn_id=t.id WHERE a.id IS NULL`],
    ["turn_pointer_mismatches", `SELECT COUNT(*) AS count FROM multiremi_turns t LEFT JOIN multiremi_conversation_log l ON l.session_id=t.session_id AND l.seq=t.seq AND l.kind='turn' AND l.id=t.id WHERE l.id IS NULL`],
    ["heads_behind_log", `SELECT COUNT(*) AS count FROM multiremi_conversation_log l LEFT JOIN multiremi_conversation_heads h ON h.session_id=l.session_id WHERE h.session_id IS NULL OR l.seq>h.head_seq`],
    ["retired_message_kinds", `SELECT COUNT(*) AS count FROM multiremi_conversation_log WHERE kind IN ('system','delegation_report')`],
    ["missing_reply_messages", `SELECT COUNT(*) AS count FROM multiremi_turns t LEFT JOIN multiremi_conversation_log m ON m.id=t.reply_message_id WHERE t.reply_message_id IS NOT NULL AND m.id IS NULL`],
    ["attempt_number_gaps", `SELECT COUNT(*) AS count FROM (SELECT turn_id FROM multiremi_turn_attempts GROUP BY turn_id HAVING MIN(attempt_no)<>1 OR MAX(attempt_no)<>COUNT(*)) gaps`],
    ["turn_payloads", `SELECT COUNT(*) AS count FROM multiremi_conversation_log WHERE kind='turn' AND (metadata<>'{}' OR body_md<>'')`],
    ["member_cursor_ahead", `SELECT COUNT(*) AS count FROM multiremi_session_lanes l JOIN multiremi_conversation_heads h ON h.session_id=l.session_id WHERE l.reader_type='member' AND l.cursor_seq>h.head_seq`],
  ];
  for (const [name, sql] of checks) {
    const n = Number(db.query(sql!).get()?.count ?? 0);
    report.checks.push({ name: name!, count: n, ok: n === 0 });
    if (n) report.mismatches.push(`${name}: ${n}`);
  }
  if (before) {
    if (before.counts.tasks !== report.counts.attempts || before.attempt_ids_digest !== report.attempt_ids_digest) report.mismatches.push("attempt identity/count changed");
    if(before.counts.agent_lanes>report.counts.agent_lanes)report.mismatches.push("agent lanes lost");
    if(before.counts.autopilots!==report.counts.autopilots)report.mismatches.push("autopilot count changed");
    if(before.counts.pending_decisions>report.counts.decisions)report.mismatches.push("pending decisions lost");
    if(before.counts.messages+before.counts.pending_decisions>report.counts.messages)report.mismatches.push("historical messages lost");
    if (before.counts.turns !== report.counts.turns) report.mismatches.push("retry chain/turn count changed");
    for(const lane of before.lane_cursors??[]){
      const actual=report.lane_cursors.find(l=>l.session_id===lane.session_id&&l.reader_type===lane.reader_type&&l.reader_id===lane.reader_id&&l.execution_scope===lane.execution_scope);
      if(!actual||['cursor_seq','parent_cursor_seq','wake_hint_seq','swept_to_seq'].some(k=>Number((actual as any)[k])!==Number((lane as any)[k])))report.mismatches.push(`agent cursor changed: ${lane.session_id}/${lane.reader_id}/${lane.execution_scope}`);
    }
    for (const chain of before.chains) {
      const after = report.chains.find(c => c.turn_id === chain.turn_id);
      if (JSON.stringify(after?.attempts) !== JSON.stringify(chain.attempts)) report.mismatches.push(`retry chain changed: ${chain.turn_id}`);
    }
    const memberNotAtHead = Number(db.query(`SELECT COUNT(*) AS count FROM multiremi_session_lanes l JOIN multiremi_conversation_heads h
      ON h.session_id=l.session_id WHERE l.reader_type='member' AND l.cursor_seq<>h.head_seq`).get()?.count ?? 0);
    if (memberNotAtHead) report.mismatches.push(`cutover member cursors not at head: ${memberNotAtHead}`);
  }
  return report;
}

/** A single cutover transaction; rejected preflight never mutates model data. */
export function runUnifiedModelMigration(db: SqlDatabase, options: { reportDir?: string } = {}): UnifiedModelReport {
  const reportDir = options.reportDir ?? "reports/migrations";
  const applied = db.query("SELECT applied_at FROM multiremi_schema_migrations WHERE id=?").get(UNIFIED_MODEL_MIGRATION);
  if (applied) {
    const report=reconcileUnifiedModel(db);
    if(!existsSync(join(reportDir,`${UNIFIED_MODEL_MIGRATION}-after.json`))){
      const beforePath=join(reportDir,`${UNIFIED_MODEL_MIGRATION}-before.json`);
      if(!existsSync(beforePath))throw new Error('Unified migration before report missing: restore the persistent report directory');
      const before=JSON.parse(readFileSync(beforePath,'utf8')) as UnifiedModelReport;
      writeUnifiedModelReport(reportDir,'after',{...report,unread_attention:before.unread_attention});
    }
    return report;
  }
  const before = collectUnifiedBeforeReport(db);
  writeUnifiedModelReport(reportDir,"before",before);
  if (before.checks.some(c => !c.ok)) throw new UnifiedModelPreflightError(before.checks);
  if (db.inTransaction) throw new Error("Unified cutover requires ownership of the outer transaction");
  const tasks = [...rows(db,"multiremi_tasks")];
  let after!: UnifiedModelReport;
  const sqliteForeignKeys = db.dialect === "sqlite" ? Number(db.query("PRAGMA foreign_keys").get()?.foreign_keys ?? 0) : 0;
  if (sqliteForeignKeys) db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      migrateHeaders(db);
      migrateTurns(db,tasks);
      migrateAutopilots(db);
      migrateDecisions(db);
      migrateLanes(db);
      migrateConversationReferences(db);
      createTurnExecutionReadProjection(db);
      createAutopilotRunReadProjection(db);
      after = reconcileUnifiedModel(db,before);
      if (after.mismatches.length) throw new Error(`Unified migration reconciliation failed: ${after.mismatches.join("; ")}`);
      if (db.dialect === "sqlite" && db.query("PRAGMA foreign_key_check").all().length) throw new Error("Unified migration foreign key check failed");
      db.run("INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES (?,?)",[UNIFIED_MODEL_MIGRATION,new Date().toISOString()]);
    })();
  } finally { if (sqliteForeignKeys) db.exec("PRAGMA foreign_keys=ON"); }
  writeUnifiedModelReport(reportDir,"after",after);
  return after;
}
