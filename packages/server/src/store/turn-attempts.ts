import { renderMarkdown } from "../render/markdown.js";
import { createId, nowIso } from "@multiremi/ids.js";
import type { SqlDatabase } from "./db/postgres.js";
import type { ConversationLogEntry, ConversationLogTurnMetadata } from "@multiremi/contracts/conversation-log.js";
import type { TurnAttemptStatus } from "@multiremi/contracts/unified-model.js";
import { notifyTurnChanged } from "./turn-execution-records.js";
import { parseJson } from "./helpers.js";

/**
 * Replace an execution in the caller's transaction. The turn is the mutex and
 * the work identity: this function never inserts a turn or mutates an Issue.
 */
export function createReplacementAttemptWithinTransaction(db: SqlDatabase, turnId: string, input: {
  previousStatus: "failed" | "cancelled" | "lost";
  reason: string;
  cold?: boolean;
  allowCancelledTurn?: boolean;
  id?: string;
  now?: string;
}): { turn_id: string; attempt_id: string; attempt_no: number } {
  if (!db.inTransaction) throw new Error("Replacement attempt requires the caller's transaction");
  // UPDATE rather than a pre-lock SELECT also avoids a SQLite snapshot upgrade.
  if (!db.run("UPDATE multiremi_turns SET current_attempt_id=current_attempt_id WHERE id=?",[turnId]).changes) {
    throw new Error(`Turn not found: ${turnId}`);
  }
  const turn=db.query("SELECT current_attempt_id,status,input_to_seq,session_id,agent_id,execution_scope FROM multiremi_turns WHERE id=?").get(turnId);
  const previous=db.query("SELECT * FROM multiremi_turn_attempts WHERE id=? AND turn_id=?").get(turn.current_attempt_id,turnId);
  if (!previous) throw new Error(`Current attempt not found for turn: ${turnId}`);
  if (turn.status==="completed" || (turn.status==="cancelled" && !input.allowCancelledTurn)) throw new Error("A completed or cancelled turn cannot be retried");
  const id=input.id ?? createId("tsk");
  const now=input.now ?? nowIso();
  const attemptNo=Number(db.query("SELECT COALESCE(MAX(attempt_no),0)+1 AS next_no FROM multiremi_turn_attempts WHERE turn_id=?").get(turnId).next_no);
  db.run(`UPDATE multiremi_turn_attempts SET status=?,failure_reason=?,ended_at=COALESCE(ended_at,?),updated_at=? WHERE id=?`,
    [input.previousStatus,input.reason,now,now,previous.id]);
  const carry=["runtime_id","provider","session_id","work_dir","plugin_snapshot","codex_profile","claude_profile",
    "execution_fingerprint","execution_model","execution_thinking_level","fallback_switched","switch_reason",
    "projection_degrade_level"];
  const value: Record<string,unknown>=Object.fromEntries(carry.map(k=>[k,previous[k]]));
  if (input.cold) Object.assign(value,{runtime_id:null,session_id:null,work_dir:null,execution_fingerprint:null,
    plugin_snapshot:"[]",codex_profile:null,claude_profile:null});
  const lane=db.query("SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?").get(turn.session_id,turn.agent_id,turn.execution_scope);
  const cold=input.cold||!previous.session_id;
  const from=cold?Number(lane?.cursor_seq??0):Number(previous.input_ack_seq??turn.input_to_seq??lane?.cursor_seq??0);
  Object.assign(value,{input_ack_seq:from,input_read_seq:cold?0:Number(previous.input_read_seq??from),
    input_read_offset:cold?0:Number(previous.input_read_offset??0),input_trigger_ack:cold?0:1});
  Object.assign(value,{id,turn_id:turnId,attempt_no:attemptNo,status:"offered" satisfies TurnAttemptStatus,created_at:now,updated_at:now});
  const keys=Object.keys(value);
  db.run(`INSERT INTO multiremi_turn_attempts(${keys.join(",")}) VALUES(${keys.map(()=>"?").join(",")})`,keys.map(k=>value[k] ?? null));
  db.run(`UPDATE multiremi_turns SET current_attempt_id=?,status=CASE WHEN status IN ('failed','cancelled') THEN 'running' ELSE status END,
    ended_at=NULL,ended_reason=NULL WHERE id=?`,[id,turnId]);
  notifyTurnChanged(db,turnId);
  return {turn_id:turnId,attempt_id:id,attempt_no:attemptNo};
}

/** Materialize the existing card wire from the turn and its current attempt. */
export function projectTurnCard(db: SqlDatabase, entry: ConversationLogEntry): ConversationLogEntry {
  if (entry.kind!=="turn") return entry;
  const row=db.query(`SELECT t.*,a.status AS attempt_status,a.attempt_no,a.failure_reason,a.progress_summary,a.event_count,
    a.tool_call_count,a.type_histogram,a.model,a.trace_ref,a.usage,a.started_at AS attempt_started_at,a.ended_at AS attempt_ended_at
    FROM multiremi_turns t LEFT JOIN multiremi_turn_attempts a ON a.id=t.current_attempt_id WHERE t.id=?`).get(entry.id);
  if (!row) throw new Error(`Missing turn for conversation pointer: ${entry.id}`);
  const reply=row.reply_message_id ? db.query("SELECT body_md FROM multiremi_conversation_log WHERE id=?").get(row.reply_message_id) : null;
  const status=row.status==="pending" ? "queued" : row.status;
  const start=row.attempt_started_at ? Date.parse(row.attempt_started_at) : NaN;
  const end=row.attempt_ended_at ? Date.parse(row.attempt_ended_at) : NaN;
  const metadata: ConversationLogTurnMetadata={
    status,summary:row.progress_summary ?? null,event_count:row.event_count==null?null:Number(row.event_count),tool_call_count:row.tool_call_count==null?null:Number(row.tool_call_count),
    type_histogram:parseJson(row.type_histogram,null),model:parseJson(row.model,null),trace_ref:parseJson(row.trace_ref,null),
    usage:parseJson(row.usage,[]),failure_reason:row.failure_reason ?? null,
    final_entry_id:row.reply_message_id ?? null,
    ...(entry.session_id.startsWith("chat_") ? {final_reply_md:reply?.body_md ?? null} : {}),
    elapsed_ms:Number.isFinite(start) && Number.isFinite(end) ? Math.max(0,end-start) : null,
    ...(row.input_to_seq!=null ? {inbox:{delivered_from_seq:row.input_from_seq ?? undefined,delivered_to_seq:row.input_to_seq}} : {}),
    assignee_agent_id:row.agent_id,attempt:row.attempt_no,
    source_event_id:row.assignment_source_event_id??null,continued_from_task_id:row.continued_from_turn_id??null,
    delegation_id:row.delegation_id??null,delegated_by_agent_id:row.delegated_by_agent_id??null,
    turn_id:row.id,current_attempt_id:row.current_attempt_id,legacy_prompt:row.legacy_prompt,
  };
  const body=String(row.legacy_prompt??'');const rendered=renderMarkdown(body);
  return {...entry,visibility:entry.session_id.startsWith("chat_") && !["completed","failed","cancelled"].includes(row.status) ? "hidden" : entry.visibility,task_id:row.current_attempt_id,body_md:body,body_html:rendered.html,render_version:rendered.render_version,metadata};
}
