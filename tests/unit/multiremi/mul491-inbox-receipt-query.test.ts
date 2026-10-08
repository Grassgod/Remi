import { appendCanonicalInboxInput } from "./fixtures/canonical-inbox-input.js";
import { runTurnExecutionMutation } from '@multiremi/store/turn-execution-records.js';
import type { SqlDatabase as UnifiedFixtureDatabase } from '@multiremi/store/db/postgres.js';
import { describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { conversationLogPgAdminUrl, withConversationLogStore } from "./fixtures/conversation-log-store.js";

type Read = { sql: string; rows: number };
const AUTH_TOKEN = "mul491-fixture-token";
const QUERY_CAP = 4;
const ROW_CAP = 1;

/** Count executions and rows returned by the database, before store mapping. */
function countingDatabase(db: SqlDatabase, reads: Read[]): SqlDatabase {
  const statement = (sql: string, raw: SqlStatement): SqlStatement => new Proxy(raw, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (["get", "all", "values", "run"].includes(String(property))) {
        return (...params: unknown[]) => {
          const result = value.apply(target, params);
          reads.push({ sql: sql.replace(/\s+/g, " ").trim(), rows:
            property === "get" ? Number(result != null) : property === "run" ? 0 : result.length });
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === "query" || property === "prepare") {
        return (sql: string) => statement(sql, target[property](sql));
      }
      const value = Reflect.get(target, property, target);
      if (property === "run" || property === "exec") {
        return (sql: string, ...params: unknown[]) => {
          const result = value.apply(target, [sql, ...params]);
          reads.push({ sql: sql.replace(/\s+/g, " ").trim(), rows: 0 });
          return result;
        };
      }
      // Includes dialect and transaction/advisory-lock hooks on the PG bridge.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function scaffold(db: SqlDatabase) {
  const reads: Read[] = [];
  const store = new MultiremiStore(countingDatabase(db, reads));
  store.ensureLocalWorkspace();
  const recipient = store.createAgent({ name: "Recipient", provider: "codex" });
  const other = store.createAgent({ name: "Foreign", provider: "codex" });
  const issue = store.createIssue({ title: "Receipt read", status: "in_progress",
    assigneeType: "agent", assigneeId: recipient.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const task = store.createSessionTask(session.id, { agentId: recipient.id, prompt: "Read" });
  const otherTask = store.createSessionTask(session.id, { agentId: other.id, prompt: "Foreign" });
  const earlyTurn = store.findTurnEntry(task.id)!;
  const entry = appendCanonicalInboxInput(store, { sessionId: session.id, kind: "message",
    authorType: "system", bodyMd: "Envelope", metadata: { envelope: {
      to: { role: "agent", agentId: recipient.id, issueSessionId: session.id },
      kind: "report", wake: "inbox_only", priority: 4, source: {},
    } } });
  const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
  const receiptReads = () => reads.filter((read) => read.sql.startsWith(
    "SELECT 1 AS present FROM multiremi_turns"));
  const request = async (query: string) => {
    reads.length = 0;
    return app.request(`/api/sessions/${session.id}/log/entry?${query}`,
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
  };
  const get = async (query = `seq=${entry.seq}`) => {
    const response = await request(query);
    expect(response.status).toBe(200);
    return await response.json() as { delivered: boolean | null; id: string };
  };
  return { store, reads, recipient, other, session, task, otherTask, earlyTurn, entry, get, request, receiptReads };
}

describe("MUL-491 bounded inbox receipt reads", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    const test = it.skipIf(backend === "pg" && !conversationLogPgAdminUrl);

    test(`${backend}: 20/400 normalized turns keep SQL count and returned rows bounded`, async () => {
      await withConversationLogStore(backend, async (_, db) => {
        const f = scaffold(db);
        const addNoise=(start:number,end:number)=>db.transaction(()=>{
          for(let i=start;i<end;i++)db.run(`INSERT INTO multiremi_turns(id,session_id,seq,agent_id,status,input_to_seq,workspace_id,created_at)
            VALUES(?,?,?,?,'completed',?,'local','2026-10-01')`,[`noise_${i}`,f.session.id,f.entry.seq+1000+i,f.other.id,f.entry.seq+1000]);
        })();
        const measure=async(delivered:boolean)=>{
          expect((await f.get()).delivered).toBe(delivered);
          expect(f.reads.filter(read=>/multiremi_(conversation_log|session_lanes|turns)/.test(read.sql)).length).toBeLessThanOrEqual(QUERY_CAP);
          expect(Math.max(...f.reads.map(read=>read.rows))).toBeLessThanOrEqual(ROW_CAP);
          expect(f.receiptReads()).toHaveLength(1);
          expect(f.receiptReads()[0]!.rows).toBe(Number(delivered));
          expect(f.receiptReads()[0]!.sql).toContain('LIMIT 1');
          return {queries:f.reads.length,rows:f.reads.reduce((sum,read)=>sum+read.rows,0)};
        };
        const cover=(to:number|null)=>db.run('UPDATE multiremi_turns SET input_to_seq=? WHERE current_attempt_id=?',[to,f.task.id]);
        addNoise(0,20);
        const shortFalse=await measure(false);
        cover(f.entry.seq);const shortTrue=await measure(true);
        cover(null);addNoise(20,400);
        expect(await measure(false)).toEqual(shortFalse);
        cover(f.entry.seq);expect(await measure(true)).toEqual(shortTrue);
        console.info(`[MUL-491 ${backend}] N=20/400 false=${JSON.stringify(shortFalse)} true=${JSON.stringify(shortTrue)} maxRows<=${ROW_CAP}`);
      });
    }, 60_000);

    test(`${backend}: ownership, business boundaries and ignored legacy receipt metadata`, async () => {
      await withConversationLogStore(backend, async (_, db) => {
        const f = scaffold(db);
        const otherSession=f.store.getOrCreateDefaultIssueSession(f.store.createIssue({title:'Other conversation'}).id);
        const turnId=f.store.getTask(f.task.id)!.turn_id!;
        db.run("UPDATE multiremi_turns SET status='completed' WHERE id=?",[turnId]);
        for(const c of [
          {label:'below',seq:f.entry.seq-1,agent:f.recipient.id,session:f.session.id,expected:false},
          {label:'equal',seq:f.entry.seq,agent:f.recipient.id,session:f.session.id,expected:true},
          {label:'above',seq:f.entry.seq+1,agent:f.recipient.id,session:f.session.id,expected:true},
          {label:'foreign agent',seq:f.entry.seq+1,agent:f.other.id,session:f.session.id,expected:false},
          {label:'foreign session',seq:f.entry.seq+1,agent:f.recipient.id,session:otherSession.id,expected:false},
          {label:'no receipt',seq:null,agent:f.recipient.id,session:f.session.id,expected:false},
        ]){
          db.run('UPDATE multiremi_turns SET input_to_seq=?,agent_id=?,session_id=? WHERE id=?',[c.seq,c.agent,c.session,turnId]);
          expect((await f.get()).delivered,c.label).toBe(c.expected);
          f.reads.length=0;
          expect(f.store.hasInboxReceiptCovering(f.session.id,f.recipient.id,f.entry.seq),c.label).toBe(c.expected);
          expect(f.reads).toHaveLength(1);
          expect(f.reads[0]!.rows).toBe(Number(c.expected));
        }
        db.run('UPDATE multiremi_turns SET input_to_seq=NULL,agent_id=?,session_id=? WHERE id=?',[f.recipient.id,f.session.id,turnId]);
        for(const metadata of [JSON.stringify({inbox:{delivered_to_seq:f.entry.seq}}),'{"inbox":','not-json']){
          db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?',[metadata,f.earlyTurn.id]);
          expect((await f.get()).delivered).toBe(false);
        }
        db.run("UPDATE multiremi_conversation_log SET metadata='{}' WHERE id=?",[f.earlyTurn.id]);
        for(const status of ['pending','running','completed','cancelled']){
          db.run('UPDATE multiremi_turns SET status=?,input_to_seq=? WHERE id=?',[status,f.entry.seq,turnId]);
          expect((await f.get()).delivered).toBe(true);
        }
        expect(await f.get(`id=${f.entry.id}`)).toEqual(await f.get());
      });
    }, 60_000);

    test(`${backend}: cursor and unknown recipient skip the receipt query`, async () => {
      await withConversationLogStore(backend, async (_, db) => {
        const f = scaffold(db);
        f.store.getOrCreateSessionAgentLane(f.session.id, f.recipient.id, "");
        for (const cursor of [f.entry.seq - 1, f.entry.seq, f.entry.seq + 1]) {
          db.run(`UPDATE multiremi_session_lanes SET cursor_seq = ?
            WHERE session_id = ? AND reader_id = ? AND execution_scope = ?`,
          [cursor, f.session.id, f.recipient.id, ""]);
          expect((await f.get()).delivered).toBe(cursor >= f.entry.seq);
          expect(f.receiptReads()).toHaveLength(cursor >= f.entry.seq ? 0 : 1);
        }
        const legacy = f.store.appendConversationLog({ sessionId: f.session.id, kind: "message",
          authorType: "member", authorId: "local", bodyMd: "No recipient" });
        expect((await f.get(`seq=${legacy.seq}`)).delivered).toBeNull();
        expect(f.receiptReads()).toHaveLength(0);
        expect(f.reads.some((read) => read.sql.includes("multiremi_agent_lane_records"))).toBe(false);

        // Target visibility and input validation still run before delivery.
        for (const query of ["seq=999999", "id=missing"]) {
          expect((await f.request(query)).status).toBe(404);
          expect(f.receiptReads()).toHaveLength(0);
        }
        for (const [visibility, deletedAt] of [["hidden", null], ["shown", new Date().toISOString()]]) {
          db.run("UPDATE multiremi_conversation_log SET visibility = ?, deleted_at = ? WHERE id = ?",
            [visibility, deletedAt, f.entry.id]);
          for (const query of [`seq=${f.entry.seq}`, `id=${f.entry.id}`]) {
            expect((await f.request(query)).status).toBe(404);
            expect(f.receiptReads()).toHaveLength(0);
          }
        }
        for (const query of ["", "seq=-1", "seq=1.5", "seq=9007199254740992", "seq=1&id=missing"]) {
          expect((await f.request(query)).status).toBe(400);
          expect(f.receiptReads()).toHaveLength(0);
        }
      });
    }, 60_000);
  }
});
