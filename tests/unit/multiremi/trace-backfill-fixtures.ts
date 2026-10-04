/** Historical trace rows attached to the current turn/attempt storage model. */
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import {
  generateSyntheticCorpus as generateTraceCorpus,
  type SyntheticCorpusParams,
  type SyntheticTask,
} from "../../../scripts/lib/task-trace-synthetic.js";
export * from "../../../scripts/lib/task-trace-synthetic.js";

function appendPointer(db: SqlDatabase, sessionId: string, id: string, kind: string, at: string,
  body = "", senderType = "agent", senderId: string | null = null, taskId: string | null = null) {
  db.run(`INSERT INTO multiremi_conversation_heads(session_id,head_seq,log_version,updated_at)
    VALUES(?,0,0,?) ON CONFLICT(session_id) DO NOTHING`, sessionId, at);
  db.run(`INSERT INTO multiremi_conversation_log(session_id,seq,id,kind,visibility,sender_type,body_md,created_at,updated_at)
    VALUES(?,0,?,'head','shown','platform','',?,?) ON CONFLICT(session_id,seq) DO NOTHING`, sessionId, `head_${sessionId}`, at, at);
  const seq = Number(db.query(`UPDATE multiremi_conversation_heads SET head_seq=head_seq+1,log_version=log_version+1,updated_at=?
    WHERE session_id=? RETURNING head_seq`).get(at, sessionId).head_seq);
  db.run(`INSERT INTO multiremi_conversation_log(session_id,seq,id,kind,visibility,sender_type,sender_id,task_id,
    body_md,message_kind,metadata,created_at,updated_at) VALUES(?,?,?,?,'shown',?,?,?,?,'reply','{}',?,?)`,
    sessionId, seq, id, kind, senderType, senderId, taskId, body, at, at);
  return seq;
}

export function insertSyntheticTask(db: SqlDatabase, task: SyntheticTask): void {
  const workspace = task.workspaceId ?? "local";
  const sessionId = task.chatSessionId ?? task.issueSessionId ?? (task.issueId ? `ises_${task.issueId}` : `auto_orphan_${workspace}`);
  const ended = task.endedAt ?? null;
  const status = task.status === "queued" ? "pending" : task.status === "dispatched" ? "running" : task.status;
  const seq = appendPointer(db, sessionId, task.id, "turn", task.createdAt, "", "agent", task.agentId, task.id);
  if (task.issueId && !db.query("SELECT id FROM multiremi_issue_sessions WHERE id=?").get(sessionId)) {
    db.run(`INSERT INTO multiremi_issue_sessions(id,issue_id,is_default,created_at,updated_at) VALUES(?,?,0,?,?)`,
      sessionId, task.issueId, task.createdAt, task.createdAt);
  }
  db.run(`INSERT INTO multiremi_turns(id,session_id,seq,agent_id,status,current_attempt_id,issue_id,workspace_id,
    legacy_prompt,created_at,started_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    task.id, sessionId, seq, task.agentId, status, task.id, task.issueId ?? null, workspace, "synthetic",
    task.createdAt, task.startedAt ?? null, ended);
  db.run(`INSERT INTO multiremi_turn_attempts(id,turn_id,attempt_no,status,runtime_id,provider,created_at,updated_at,
    accepted_at,started_at,ended_at) VALUES(?,?,1,?,?,?,?,?,?,?,?)`,
    task.id, task.id, task.status === "queued" ? "offered" : task.status === "dispatched" ? "accepted" : task.status,
    task.runtimeId ?? null, task.provider ?? null, task.createdAt, ended ?? task.createdAt,
    task.startedAt ?? null, task.startedAt ?? null, ended);
}

export function insertFixtureMessage(db: SqlDatabase, input: {
  id: string; sessionId: string; body: string; role: "user" | "assistant"; taskId?: string | null;
  at: string; failureReason?: string | null;
}): void {
  const turn = input.taskId ? db.query("SELECT agent_id FROM multiremi_turns WHERE current_attempt_id=?").get(input.taskId) : null;
  appendPointer(db, input.sessionId, input.id, "message", input.at, input.body,
    input.role === "user" ? "member" : "agent", turn?.agent_id ?? "local", input.taskId ?? null);
  if (input.role === "assistant" && input.taskId) {
    db.run("UPDATE multiremi_turns SET reply_message_id=? WHERE current_attempt_id=?", input.id, input.taskId);
    db.run("UPDATE multiremi_turn_attempts SET failure_reason=? WHERE id=?", input.failureReason ?? null, input.taskId);
  }
}

/** Reuse the deterministic trace payload generator, but construct canonical
 * turns/attempts instead of its historical task-table fixture. This adapter is
 * confined to tests; no production writer accepts legacy task SQL. */
export function generateSyntheticCorpus(db: SqlDatabase, params: SyntheticCorpusParams) {
  const fixtureDb = new Proxy(db, {
    get(target, key) {
      if (key === "run") return (sql: string, ...values: unknown[]) => {
        const normalized = values.map(value => typeof value === "string" && value.startsWith("chs_") ? value.replace(/^chs_/, "chat_") : value);
        const columns = sql.match(/INSERT INTO multiremi_tasks\s*\(([^)]+)\)/)?.[1];
        if (!columns) return target.run(sql, ...normalized);
        const row = Object.fromEntries(columns.split(",").map((column, index) => [column.trim(), normalized[index]]));
        insertSyntheticTask(target, {
          id: String(row.id), agentId: String(row.agent_id), runtimeId: row.runtime_id as string | null,
          issueId: row.issue_id as string | null, issueSessionId: row.issue_session_id as string | null,
          chatSessionId: row.chat_session_id as string | null, status: String(row.status),
          provider: row.provider as string | null, workspaceId: String(row.workspace_id),
          createdAt: String(row.created_at), startedAt: row.started_at as string | null,
          endedAt: (row.completed_at ?? row.failed_at ?? row.cancelled_at) as string | null,
        });
        return { changes: 1, lastInsertRowid: 0 };
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return generateTraceCorpus(fixtureDb, params);
}
