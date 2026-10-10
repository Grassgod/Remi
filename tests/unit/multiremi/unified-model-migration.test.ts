import { MultiremiStore } from "@multiremi/store.js";
import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUnifiedModelMigration, reconcileUnifiedModel, retryChains,
  UnifiedModelPreflightError, unifiedModelPreflight } from "@multiremi/store/unified-model-migration.js";
import { UNIFIED_MODEL_MIGRATION } from "@multiremi/store/unified-model-schema.js";
import { dropRetiredTables, RETIRED_TABLE_SETS, RETIRED_COLUMN_SETS } from "../../../scripts/drop-retired-tables.js";
import { unifiedModelBackendTests } from "./unified-model-test-backends.js";
import { createReplacementAttemptWithinTransaction } from "@multiremi/store/turn-attempts.js";
import { ensureUsageAccountingSchema, USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER } from "@multiremi/store/usage-accounting.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

const dirs: string[] = [];
function reportDir(): string { const dir=mkdtempSync(join(tmpdir(),"mul505-"));dirs.push(dir);return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });

unifiedModelBackendTests("MUL-505 normalized model migration", fixture => {
  it("starts an already unified database without rebuilding its old execution view", () => {
    const { db } = fixture();
    // Reproduce the v0.2.89 projection's extra column on both real backends.
    const historical = new Proxy(db, { get(target, key) {
      if (key === "exec") return (sql: string) => target.exec(sql.includes("VIEW IF NOT EXISTS multiremi_turn_execution_records AS SELECT")
        || sql.includes("VIEW multiremi_turn_execution_records AS SELECT")
        ? sql.replace("a.created_at AS created_at", "a.usage AS usage,a.created_at AS created_at") : sql);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    new MultiremiStore(historical);
    const definition = () => db.dialect === "postgres"
      ? db.query("SELECT pg_get_viewdef('multiremi_turn_execution_records'::regclass) AS definition").get().definition
      : db.query("SELECT sql AS definition FROM sqlite_master WHERE name='multiremi_turn_execution_records'").get().definition;
    const before = definition();
    expect(db.query("PRAGMA table_info(multiremi_turn_execution_records)").all().some((column: any) => column.name === "usage")).toBe(true);
    let rebuilds = 0;
    const recording = new Proxy(db, { get(target, key) {
      if (key === "exec") return (sql: string) => {
        if (/CREATE(?: OR REPLACE)? VIEW(?: IF NOT EXISTS)? multiremi_turn_execution_records/i.test(sql)) rebuilds++;
        return target.exec(sql);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const restarted = new MultiremiStore(recording);
    expect(rebuilds).toBe(0);
    expect(definition()).toBe(before);
    expect(db.query("SELECT * FROM multiremi_turn_execution_records").all()).toEqual([]);
    expect(restarted.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(0);
  });
  it("blocks unconsumed steer for every unfinished task state and does not exempt a failed attempt's queued retry", () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "Active steer", provider: "codex" });
    const first = store.createTask({ agentId: agent.id, prompt: "failed", status: "failed" });
    const retry = store.createTask({ agentId: agent.id, prompt: "retry", parentTaskId: first.id, attempt: 2 });
    db.run("INSERT INTO multiremi_task_steer_messages(id,task_id,content,created_at) VALUES('str_active',?,'pending steer',?)", [retry.id, retry.createdAt]);
    for (const status of ["queued", "running", "dispatched", "awaiting_human", "waiting_local_directory"]) {
      db.run("UPDATE multiremi_tasks SET status=? WHERE id=?", [status, retry.id]);
      expect(unifiedModelPreflight(db).find(c => c.name === "unconsumed_steer")).toEqual({ name: "unconsumed_steer", count: 1, ok: false });
    }
  });

  it("preserves terminal unconsumed steer bodies and source rows as non-waking history, including retry attempts", () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "Terminal steer", provider: "codex" });
    const issue = store.createIssue({ title: "History" });
    const first = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "first", status: "failed" });
    const retry = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "retry", parentTaskId: first.id, attempt: 2, status: "completed" });
    const cancelled = store.createTask({ agentId: agent.id, prompt: "cancelled", status: "cancelled" });
    const bodies = ["long-history-".repeat(2500), "completed history", "cancelled history"];
    for (const [index, task] of [first, retry, cancelled].entries()) {
      db.run("INSERT INTO multiremi_task_steer_messages(id,task_id,author_id,content,created_at) VALUES(?,?,'local',?,?)",
        [`str_terminal_${index}`, task.id, bodies[index], task.createdAt]);
    }
    db.run("INSERT INTO multiremi_task_steer_messages(id,task_id,content,created_at,consumed_at) VALUES('str_consumed',?,'consumed',?,?)",
      [retry.id, retry.createdAt, retry.createdAt]);
    const source = db.query("SELECT * FROM multiremi_task_steer_messages ORDER BY id").all();
    const dir = reportDir();
    const after = runUnifiedModelMigration(db, { reportDir: dir });
    const before = JSON.parse(readFileSync(join(dir, `${UNIFIED_MODEL_MIGRATION}-before.json`), "utf8"));
    expect(before.checks.find((c: any) => c.name === "unconsumed_steer").count).toBe(0);
    expect(after.orphan_steer).toEqual(before.orphan_steer);
    expect(after.orphan_steer.count).toBe(3);
    expect(after.orphan_steer.by_task_status).toEqual({ completed: 1, failed: 1, cancelled: 1 });
    expect(after.mismatches).toEqual([]);
    expect(db.query("SELECT * FROM multiremi_task_steer_messages ORDER BY id").all()).toEqual(source);
    for (const [index, entry] of after.orphan_steer.entries.entries()) {
      const message = db.query("SELECT body_md,task_id,to_type,wake_applied,sender_type,sender_id FROM multiremi_conversation_log WHERE id=?").get(entry.message_id);
      expect(message.body_md).toBe(bodies[index]);
      expect(message).toMatchObject({ to_type: "none", wake_applied: "inbox_only", sender_type: "member", sender_id: "mem_local_local" });
    }
    expect(db.query("SELECT task_id FROM multiremi_conversation_log WHERE id='msg_migrated_steer_str_terminal_1'").get()?.task_id).toBe(first.id);
    expect(runUnifiedModelMigration(db, { reportDir: dir }).orphan_steer.count).toBe(3);
    db.run("UPDATE multiremi_conversation_log SET body_md='lost' WHERE id='msg_migrated_steer_str_terminal_0'");
    expect(reconcileUnifiedModel(db, before).mismatches).toContain("terminal unconsumed steer identity/body changed");
    db.exec("DROP TABLE multiremi_task_steer_messages");
    expect(reconcileUnifiedModel(db).orphan_steer.count).toBe(3);
  });

  it("preserves main usage facts and their cascading attempt foreign keys through cutover", () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "Usage cutover", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Already metered", status: "completed" });
    // Reproduce #384's historical schema before invoking the current cutover.
    const historical = new Proxy(db, { get(target, key) {
      if (key === "exec") return (sql: string) => target.exec(sql.replaceAll("multiremi_turn_attempts", "multiremi_tasks"));
      if (key === "query") return (sql: string) => target.query(sql.replaceAll("multiremi_turn_execution_records", "multiremi_tasks").replaceAll("multiremi_turn_attempts", "multiremi_tasks"));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as SqlDatabase;
    for (const marker of [USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER]) db.run("INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING", [marker, task.createdAt]);
    ensureUsageAccountingSchema(historical);
    if (db.dialect === "postgres") {
      db.exec("ALTER TABLE multiremi_usage_runs ADD CONSTRAINT historical_usage_attempt_fk FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE");
      db.exec("ALTER TABLE multiremi_usage_units ADD CONSTRAINT historical_usage_run_fk FOREIGN KEY(task_id,run_id) REFERENCES multiremi_usage_runs(task_id,run_id) ON DELETE CASCADE");
    } else db.exec("PRAGMA foreign_keys=ON");
    db.run("INSERT INTO multiremi_usage_runs(task_id,run_id,revision,complete) VALUES(?,'existing',1,1)", [task.id]);
    db.run(`INSERT INTO multiremi_usage_units(task_id,run_id,unit_id,revision,workspace_id,agent_id,provider,model,scope,source,accuracy,input_tokens,output_tokens,occurred_at)
      VALUES(?,'existing','request',1,'local',?,'claude','opus','request','provider_request','exact',5,2,'2026-10-01T00:00:00.000Z')`, [task.id, agent.id]);
    const current = new MultiremiStore(db);
    expect(current.getTask(task.id)?.usage).toMatchObject([{ inputTokens: 5, outputTokens: 2, totalTokens: 7 }]);
    expect(current.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(7);
    db.run("DELETE FROM multiremi_turn_attempts WHERE id=?", [task.id]);
    expect(Number(db.query("SELECT COUNT(*) AS n FROM multiremi_usage_units").get().n)).toBe(0);
    expect(db.query("SELECT task_id FROM multiremi_usage_runs WHERE task_id=?").get(task.id)).toBeNull();
  });

  it("migrates empty stores, writes both reports, and is idempotent", () => {
    const { db } = fixture();
    const dir=reportDir();
    const report=runUnifiedModelMigration(db,{reportDir:dir});
    expect(report.mismatches).toEqual([]);
    expect(report.counts.attempts).toBe(0);
    for (const phase of ["before","after"]) {
      expect(JSON.parse(readFileSync(join(dir,`${UNIFIED_MODEL_MIGRATION}-${phase}.json`),"utf8")).phase).toBe(phase);
    }
    expect(runUnifiedModelMigration(db,{reportDir:dir}).attempt_ids_digest).toBe(report.attempt_ids_digest);
    const attemptColumns=db.query("PRAGMA table_info(multiremi_turn_attempts)").all().map((r: any)=>r.name);
    expect(attemptColumns).toContain("turn_id");
    expect(attemptColumns).not.toContain("parent_task_id");
    expect(attemptColumns).not.toContain("agent_id");
    const headers=db.query("PRAGMA table_info(multiremi_conversation_log)").all().map((r: any)=>r.name);
    expect(headers).toContain("sender_type");
    expect(headers).toContain("reply_to_id");
    expect(headers).not.toContain("author_type");
    expect(headers).not.toContain("parent_id");
  });

  it("rejects orphan attempts after historical migration and on reopen", () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "FK worker", provider: "codex" });
    const issue = store.createIssue({ title: "Attempt FK" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "input" });
    db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE id = ?", [task.id]);
    db.exec("CREATE TABLE mul505_attempt_evidence (attempt_id TEXT NOT NULL, FOREIGN KEY (attempt_id) REFERENCES multiremi_tasks(id))");
    if (db.dialect === "postgres") {
      db.exec("ALTER TABLE mul505_attempt_evidence ADD CONSTRAINT evidence_attempt_fk FOREIGN KEY (attempt_id) REFERENCES multiremi_tasks(id)");
    }
    db.run("INSERT INTO mul505_attempt_evidence(attempt_id) VALUES (?)", [task.id]);
    const dir = reportDir();
    if (db.dialect === "sqlite") db.exec("PRAGMA foreign_keys = ON");
    runUnifiedModelMigration(db, { reportDir: dir });
    const attempt = db.query("SELECT * FROM multiremi_turn_attempts WHERE id = ?").get(task.id)!;
    const insertClone = (id: string, turnId: string) => {
      const row = { ...attempt, id, turn_id: turnId, attempt_no: 2 };
      db.transaction(() => db.run(`INSERT INTO multiremi_turn_attempts (${Object.keys(row).join(",")})
        VALUES (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row)))();
    };
    // Reproduce an already-applied PG snapshot that lost this FK. Startup
    // repairs it while retaining the original attempt table and inbound FKs.
    if (db.dialect === "postgres") {
      db.exec("ALTER TABLE multiremi_turn_attempts DROP CONSTRAINT unified_attempt_turn_fk");
      runUnifiedModelMigration(db, { reportDir: dir });
    }
    expect(() => insertClone("tsk_orphan", "missing_turn")).toThrow();
    insertClone("tsk_valid_fk", task.id);
    expect(db.query("SELECT attempt_id FROM mul505_attempt_evidence").get()?.attempt_id).toBe(task.id);
    expect(() => db.transaction(() => db.run("DELETE FROM multiremi_turn_attempts WHERE id = ?", [task.id]))()).toThrow();
    db.run("INSERT INTO mul505_attempt_evidence(attempt_id) VALUES ('tsk_valid_fk')");
    expect(() => db.transaction(() => db.run("INSERT INTO mul505_attempt_evidence(attempt_id) VALUES ('missing_attempt')"))()).toThrow();
    expect(db.query("SELECT turn_id FROM multiremi_turn_attempts WHERE id = 'tsk_valid_fk'").get()?.turn_id).toBe(task.id);
    runUnifiedModelMigration(db, { reportDir: dir });
    expect(() => insertClone("tsk_orphan_again", "missing_turn")).toThrow();
  });

  it("preserves attempts and agent checkpoints while collapsing retries, lifting headers and starting human cursors at head", () => {
    const { db,store }=fixture();
    const agent=store.createAgent({name:"historical worker",provider:"codex"});
    const issue=store.createIssue({title:"history",assigneeType:"member",assigneeId:"mem_local_local"});
    const root=store.createTask({agentId:agent.id,issueId:issue.id,prompt:"root input"});
    db.run("UPDATE multiremi_tasks SET status='failed',failed_at=created_at WHERE id=?",[root.id]);
    const retry=store.createTask({agentId:agent.id,issueId:issue.id,prompt:"retry input",parentTaskId:root.id,attempt:2});
    db.run("UPDATE multiremi_tasks SET status='completed',completed_at=created_at WHERE id=?",[retry.id]);
    const continuation=store.createTask({agentId:agent.id,issueId:issue.id,prompt:"next requested round",continuedFromTaskId:retry.id});
    db.run("UPDATE multiremi_tasks SET status='completed',completed_at=created_at WHERE id=?",[continuation.id]);
    const orphan=store.createTask({agentId:agent.id,prompt:"no conversation"});
    db.run("UPDATE multiremi_tasks SET status='completed',completed_at=created_at WHERE id=?",[orphan.id]);
    const session=store.getOrCreateDefaultIssueSession(issue.id);
    const at="2026-10-01T00:00:00.000Z";
    db.run(`UPDATE multiremi_session_agent_lanes SET cursor_seq=2,parent_cursor_seq=1,
      provider_session_id='provider-checkpoint',work_dir='/tmp/checkpoint',generation=4,
      wake_hint_seq=3,swept_to_seq=2 WHERE session_id=? AND agent_id=?`,[session.id,agent.id]);
    const laneBefore=db.query("SELECT * FROM multiremi_session_agent_lanes WHERE session_id=? AND agent_id=?").get(session.id,agent.id);
    store.appendConversationLog({sessionId:session.id,id:"cmt_env_history",kind:"system",authorType:"system",bodyMd:"historical notice",
      metadata:{envelope:{to:{role:"issue_owner",issueId:issue.id},kind:"lifecycle",wake:"now",dedupeKey:"legacy-key",source:{},priority:4}}});
    store.appendConversationLog({sessionId:session.id,id:"cmt_report_history",kind:"delegation_report",authorType:"agent",authorId:agent.id,
      bodyMd:"delegation returned",metadata:{delegation_id:"dlg_historical"}});
    db.run(`INSERT INTO multiremi_issue_decisions(id,workspace_id,issue_id,source_issue_id,kind,title,body,options,
      status,created_by_agent_id,created_at,updated_at,token_hash,token_recipient)
      VALUES ('dec_history','local',?,?,'question','Choose','pick one','[{"label":"yes","value":"yes"}]',
        'pending',?,?,?,'hash-history','mem_local_local')`,[issue.id,issue.id,agent.id,at,at]);
    const result=runUnifiedModelMigration(db,{reportDir:reportDir()});
    expect(result.mismatches).toEqual([]);
    expect(result.counts.attempts).toBe(4);
    expect(result.counts.turns).toBe(3);
    expect(db.query("SELECT turn_id,attempt_no FROM multiremi_turn_attempts WHERE id=?").get(retry.id))
      .toEqual({turn_id:root.id,attempt_no:2});
    expect(db.query("SELECT continued_from_turn_id FROM multiremi_turns WHERE id=?").get(continuation.id)?.continued_from_turn_id).toBe(root.id);
    expect(db.query("SELECT session_id,legacy_prompt FROM multiremi_turns WHERE id=?").get(orphan.id))
      .toMatchObject({session_id:"auto_orphan_local",legacy_prompt:"no conversation"});
    expect(db.query("SELECT * FROM multiremi_conversation_log WHERE id='cmt_env_history'").get())
      .toMatchObject({kind:"message",sender_type:"platform",message_kind:"status",dedupe_key:"legacy-key",to_member_id:"mem_local_local"});
    expect(db.query("SELECT visibility,message_kind,to_ref FROM multiremi_conversation_log WHERE id='cmt_report_history'").get())
      .toEqual({visibility:"shown",message_kind:"report",to_ref:"delegator"});
    expect(db.query("SELECT * FROM multiremi_conversation_log WHERE id='dec_history'").get())
      .toMatchObject({message_kind:"decision",card_token_hash:"hash-history",card_token_recipient:"mem_local_local",created_at:at});
    const lane=db.query("SELECT * FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=?").get(session.id,agent.id);
    for (const key of ["cursor_seq","parent_cursor_seq","provider_session_id","work_dir","generation","wake_hint_seq","swept_to_seq","created_at","updated_at"]) {
      expect(lane[key]).toBe(laneBefore[key]);
    }
    const human=db.query("SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='member'").get(session.id);
    expect(human.cursor_seq).toBe(db.query("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id=?").get(session.id).head_seq);
    expect(() => db.run(`INSERT INTO multiremi_conversation_log(session_id,seq,id,kind,visibility,sender_type,dedupe_key,created_at,updated_at)
      VALUES (?,999,'msg_duplicate','message','shown','platform','legacy-key',?,?)`,[session.id,at,at])).toThrow();
    // Other conversations can use the same key; uniqueness is per session.
    db.run(`INSERT INTO multiremi_conversation_log(session_id,seq,id,kind,visibility,sender_type,dedupe_key,created_at,updated_at)
      VALUES ('auto_other',1,'msg_other','message','shown','platform','legacy-key',?,?)`,[at,at]);
  });

  it('preserves each queued work identity while folding its input into one pending lane',()=>{
    const {db,store}=fixture();const agent=store.createAgent({name:'queue',provider:'codex'});
    const issue=store.createIssue({title:'queue'});
    const first=store.createTask({agentId:agent.id,issueId:issue.id,prompt:'first input'});
    const second=store.createTask({agentId:agent.id,issueId:issue.id,prompt:'second input'});
    db.run('UPDATE multiremi_tasks SET created_at=? WHERE id=?',['2026-10-02T00:00:00.000Z',second.id]);
    runUnifiedModelMigration(db,{reportDir:reportDir()});
    expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_turns').get().n)).toBe(2);
    expect(db.query('SELECT id,status,legacy_prompt FROM multiremi_turns WHERE id=?').get(first.id))
      .toEqual({id:first.id,status:'pending',legacy_prompt:'first input\n\nsecond input'});
    expect(db.query('SELECT turn_id,status FROM multiremi_turn_attempts WHERE id=?').get(second.id))
      .toEqual({turn_id:second.id,status:'cancelled'});
    expect(()=>db.run("UPDATE multiremi_turns SET status='pending' WHERE id=?",[second.id])).toThrow();
  });
  it('starts a historical store and preserves structured outputs and automation lineage',()=>{
    const {db,store}=fixture();const agent=store.createAgent({name:'auto',provider:'codex'});
    for (const marker of [USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER]) db.run("INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING", [marker, "2026-10-01T00:00:00.000Z"]);
    const a=store.createTask({agentId:agent.id,prompt:'first auto'});
    const b=store.createTask({agentId:agent.id,prompt:'scheduled target',parentTaskId:a.id,attempt:1});
    const at='2026-10-01T00:00:00.000Z';
    for(const [task,output] of [[a,'first reply'],[b,'second reply']] as const)
      db.run("UPDATE multiremi_tasks SET status='completed',completed_at=created_at,result=? WHERE id=?",[JSON.stringify({output,pr_url:'https://example.test/pr/1'}),task.id]);
    db.run('INSERT INTO multiremi_autopilots(id,workspace_id,title,assignee_type,assignee_id,execution_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', ['aut_history','local','Auto','agent',agent.id,'run_only',at,at]);
    for(const [id,task,source] of [['run_a',a.id,null],['run_b',b.id,a.id]])
      db.run("INSERT INTO multiremi_autopilot_runs(id,autopilot_id,task_id,source_task_id,status,result,source,triggered_at,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)",[id,'aut_history',task,source,'completed','historic ledger result','manual',at,at,at]);
    const dir=reportDir(),previous=process.env.MULTIREMI_MIGRATION_REPORT_DIR;
    process.env.MULTIREMI_MIGRATION_REPORT_DIR=dir;
    try{new MultiremiStore(db);}finally{if(previous==null)delete process.env.MULTIREMI_MIGRATION_REPORT_DIR;else process.env.MULTIREMI_MIGRATION_REPORT_DIR=previous;}
    expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_turns').get().n)).toBe(2);
    expect(db.query('SELECT session_id FROM multiremi_turns WHERE id=?').get(b.id).session_id).toBe('auto_aut_history');
    expect(db.query('SELECT status,result FROM multiremi_autopilot_run_records WHERE id=?').get('run_b')).toEqual({status:'completed',result:'historic ledger result'});
    const reply=db.query('SELECT m.body_md,m.metadata FROM multiremi_turns t JOIN multiremi_conversation_log m ON m.id=t.reply_message_id WHERE t.id=?').get(b.id);
    expect(reply.body_md).toBe('second reply');expect(JSON.parse(reply.metadata).task_result.pr_url).toBe('https://example.test/pr/1');
    expect(JSON.parse(db.query('SELECT result FROM multiremi_turn_execution_records WHERE id=?').get(b.id).result)).toEqual({output:'second reply',pr_url:'https://example.test/pr/1'});
    expect(JSON.parse(readFileSync(join(dir,`${UNIFIED_MODEL_MIGRATION}-after.json`),'utf8')).mismatches).toEqual([]);
  });
  it('rolls back an invalid historical envelope and retries after repair',()=>{
    const {db,store}=fixture();const agent=store.createAgent({name:'rollback',provider:'codex'});
    store.createTask({agentId:agent.id,prompt:'original'});
    store.appendConversationLog({sessionId:'auto_bad',id:'msg_bad',kind:'message',authorType:'member',bodyMd:'preserved'});
    db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?',['broken-json','msg_bad']);
    const snapshot=db.query('SELECT * FROM multiremi_tasks').all(),dir=reportDir();
    expect(()=>runUnifiedModelMigration(db,{reportDir:dir})).toThrow('malformed historical JSON');
    expect(db.query('SELECT * FROM multiremi_tasks').all()).toEqual(snapshot);
    expect(db.query('PRAGMA table_info(multiremi_conversation_log)').all().map((r:any)=>r.name)).toContain('author_type');
    expect(()=>db.query('SELECT id FROM multiremi_turn_attempts').all()).toThrow();
    db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?',['{}','msg_bad']);
    expect(runUnifiedModelMigration(db,{reportDir:dir}).mismatches).toEqual([]);
  });

  for (const shape of ["awaiting_human","steer","backfill","undrained"] as const) {
    it(`refuses ${shape} before model mutation`, () => {
      const {db,store}=fixture();
      const agent=store.createAgent({name:"precheck",provider:"codex"});
      const task=store.createTask({agentId:agent.id,prompt:"queued"});
      if (shape==="awaiting_human" || shape==="undrained") db.run("UPDATE multiremi_tasks SET status=? WHERE id=?",[shape==="undrained"?"dispatched":"awaiting_human",task.id]);
      if (shape==="steer") db.run(`INSERT INTO multiremi_task_steer_messages(id,task_id,content,created_at) VALUES ('str_history',?,'unconsumed',?)`,[task.id,task.createdAt]);
      if (shape==="backfill") db.run(`INSERT INTO multiremi_trace_backfill_progress(subject_kind,subject_id,status,updated_at) VALUES ('task','legacy','running',?)`,[task.createdAt]);
      const before=db.query("SELECT * FROM multiremi_tasks ORDER BY id").all();
      const dir=reportDir();
      expect(()=>runUnifiedModelMigration(db,{reportDir:dir})).toThrow(UnifiedModelPreflightError);
      const prior=process.env.MULTIREMI_MIGRATION_REPORT_DIR;process.env.MULTIREMI_MIGRATION_REPORT_DIR=dir;
      try{expect(()=>new MultiremiStore(db)).toThrow(UnifiedModelPreflightError);}
      finally{if(prior==null)delete process.env.MULTIREMI_MIGRATION_REPORT_DIR;else process.env.MULTIREMI_MIGRATION_REPORT_DIR=prior;}
      expect(db.query("SELECT * FROM multiremi_tasks ORDER BY id").all()).toEqual(before);
      expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(UNIFIED_MODEL_MIGRATION)).toBeNull();
      expect(JSON.parse(readFileSync(join(dir,`${UNIFIED_MODEL_MIGRATION}-before.json`),"utf8")).checks.some((c:any)=>!c.ok)).toBe(true);
    });
  }

  it("replacement attempts retain one turn and leave Issue state and log pointers unchanged",()=>{
    const {db,store}=fixture();
    const agent=store.createAgent({name:"replacement",provider:"codex"});
    const issue=store.createIssue({title:"replacement history"});
    const task=store.createTask({agentId:agent.id,issueId:issue.id,prompt:"one work unit"});
    runUnifiedModelMigration(db,{reportDir:reportDir()});
    db.run("UPDATE multiremi_issues SET status='in_review' WHERE id=?",[issue.id]);
    db.run("UPDATE multiremi_turns SET status='running' WHERE id=?",[task.id]);
    db.run("UPDATE multiremi_turn_attempts SET status='running',session_id='old-provider',work_dir='/tmp/old' WHERE id=?",[task.id]);
    const pointers=db.query("SELECT id,seq,metadata FROM multiremi_conversation_log WHERE kind='turn'").all();
    const first=db.transaction(()=>createReplacementAttemptWithinTransaction(db,task.id,{previousStatus:"lost",reason:"runtime_recovery"}))();
    expect(first).toMatchObject({turn_id:task.id,attempt_no:2});
    const second=db.transaction(()=>createReplacementAttemptWithinTransaction(db,task.id,{previousStatus:"cancelled",reason:"redispatch",cold:true}))();
    expect(second).toMatchObject({turn_id:task.id,attempt_no:3});
    expect(db.query("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM multiremi_turns").get().count).toBe(1);
    expect(db.query("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM multiremi_turn_attempts").get().count).toBe(3);
    expect(db.query("SELECT status,current_attempt_id FROM multiremi_turns WHERE id=?").get(task.id))
      .toEqual({status:"running",current_attempt_id:second.attempt_id});
    expect(db.query("SELECT session_id,work_dir FROM multiremi_turn_attempts WHERE id=?").get(second.attempt_id))
      .toEqual({session_id:null,work_dir:null});
    expect(db.query("SELECT status FROM multiremi_issues WHERE id=?").get(issue.id).status).toBe("in_review");
    expect(db.query("SELECT id,seq,metadata FROM multiremi_conversation_log WHERE kind='turn'").all()).toEqual(pointers);
  });

  for (const set of ["mul432","mul493"] as const) {
    it(`guards and rehearses ${set} independently, defaulting to dry-run`,()=>{
      const {db}=fixture();
      const dir=reportDir();
      const report=runUnifiedModelMigration(db,{reportDir:dir});
      const now=new Date();
      db.run("UPDATE multiremi_schema_migrations SET applied_at=? WHERE id=?",[new Date(now.getTime()-8*86_400_000).toISOString(),UNIFIED_MODEL_MIGRATION]);
      const previous=process.env.MULTIREMI_MIGRATION_REPORT_DIR;
      process.env.MULTIREMI_MIGRATION_REPORT_DIR=dir;
      try { new MultiremiStore(db); } finally {
        if(previous===undefined)delete process.env.MULTIREMI_MIGRATION_REPORT_DIR;
        else process.env.MULTIREMI_MIGRATION_REPORT_DIR=previous;
      }
      const args={set,reconciliation:report,now};
      expect(dropRetiredTables(db,args)).toEqual({dry_run:true,tables:[...RETIRED_TABLE_SETS[set]],columns:RETIRED_COLUMN_SETS[set],minimum_age_days:7});
      expect(()=>dropRetiredTables(db,{...args,execute:true})).toThrow("--confirm-drop");
      const backup=join(dir,"local-backup");writeFileSync(backup,"local fixture backup");
      expect(dropRetiredTables(db,{...args,execute:true,confirmDrop:true,backup}).dry_run).toBe(false);
      expect(reconcileUnifiedModel(db).mismatches).toEqual([]);
    });
  }
});

it("rejects cycles and missing retry parents instead of losing historical tasks",()=>{
  expect(()=>retryChains([{id:"tsk_a",parent_task_id:"tsk_b"}])).toThrow("missing retry parent");
  expect(()=>retryChains([{id:"tsk_a",parent_task_id:"tsk_b"},{id:"tsk_b",parent_task_id:"tsk_a"}])).toThrow("cyclic retry chain");
});
