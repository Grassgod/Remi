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
  const entry = store.appendConversationLog({ sessionId: session.id, kind: "message",
    authorType: "system", bodyMd: "Envelope", metadata: { envelope: {
      to: { role: "agent", agentId: recipient.id, issueSessionId: session.id },
      kind: "report", wake: "inbox_only", priority: 4, source: {},
    } } });
  const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
  const receiptReads = () => reads.filter((read) => read.sql.startsWith(
    "SELECT 1 AS present FROM multiremi_conversation_log log"));
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

    test(`${backend}: 20/400 shown entries keep SQL count and returned rows bounded`, async () => {
      await withConversationLogStore(backend, async (_, db) => {
        const f = scaffold(db);
        const secondForeign = f.store.createAgent({ name: "Second foreign", provider: "codex" });
        const at = new Date().toISOString();
        const addNoise = (start: number, end: number) => db.transaction(() => {
          for (let i = start; i < end; i++) {
            const mirror = i % 3 === 2;
            const taskId = mirror ? `tsk_mul491_foreign_${i}` : null;
            if (taskId) {
              // Distinct foreign tasks prevent the old request cache from
              // concealing the per-turn task lookup. No lifecycle work here.
              db.run(`INSERT INTO multiremi_tasks (id, agent_id, status, prompt, created_at, updated_at)
                VALUES (?, ?, 'completed', '', ?, ?)`,
              [taskId, i % 2 ? f.other.id : secondForeign.id, at, at]);
            }
            f.store.appendConversationLogWithinTransaction({ sessionId: f.session.id,
              kind: i % 3 === 0 ? "message" : "turn", authorType: mirror ? "system" : "agent",
              authorId: mirror ? null : f.other.id, taskId,
              bodyMd: "Irrelevant shown content ".repeat(100),
              metadata: { inbox: { delivered_to_seq: f.entry.seq + 1000 } } });
          }
        })();
        const measure = async (delivered: boolean) => {
          expect((await f.get()).delivered).toBe(delivered);
          expect(f.reads.length).toBeLessThanOrEqual(QUERY_CAP);
          expect(Math.max(...f.reads.map((read) => read.rows))).toBeLessThanOrEqual(ROW_CAP);
          const receipts = f.receiptReads();
          expect(receipts).toHaveLength(1);
          expect(receipts[0].rows).toBe(Number(delivered));
          expect(receipts[0].sql).toContain("LIMIT 1");
          expect(f.reads.some((read) => /SELECT \* FROM multiremi_(conversation_log|tasks)/.test(read.sql)
            && !read.sql.includes("AND seq ="))).toBe(false);
          return { queries: f.reads.length, rows: f.reads.reduce((sum, read) => sum + read.rows, 0) };
        };
        const cover = () => f.store.appendConversationLog({ sessionId: f.session.id,
          kind: "turn", authorType: "agent", authorId: f.recipient.id,
          metadata: { inbox: { delivered_to_seq: f.entry.seq } } });

        addNoise(0, 20);
        const shortFalse = await measure(false);
        const shortReceipt = cover();
        const shortTrue = await measure(true);
        db.run("DELETE FROM multiremi_conversation_log WHERE id = ?", [shortReceipt.id]);
        addNoise(20, 400);
        const longFalse = await measure(false);
        cover();
        const longTrue = await measure(true);
        expect(longFalse).toEqual(shortFalse);
        expect(longTrue).toEqual(shortTrue);
        console.info(`[MUL-491 ${backend}] N=20/400 false=${JSON.stringify(longFalse)} true=${JSON.stringify(longTrue)} maxRows<=${ROW_CAP}`);
      });
    }, 60_000);

    test(`${backend}: ownership, boundaries, JSON types and malformed metadata`, async () => {
      await withConversationLogStore(backend, async (_, db) => {
        const f = scaffold(db);
        const candidate = f.store.appendConversationLog({ sessionId: f.session.id, kind: "turn",
          authorType: "agent", authorId: f.recipient.id });
        const otherSession = f.store.getOrCreateDefaultIssueSession(
          f.store.createIssue({ title: "Other session" }).id);
        const metadata = (value: unknown) => JSON.stringify({ inbox: { delivered_to_seq: value } });
        type Case = { label: string; expected: boolean; author?: string | null; task?: string | null;
          session?: string; kind?: string; visibility?: string; deleted?: string; metadata?: string };
        const cases: Case[] = [
          { label: "author wins over foreign task", task: f.otherTask.id, expected: true },
          { label: "foreign author wins over recipient task", author: f.other.id, task: f.task.id, expected: false },
          { label: "null author falls back to recipient task", author: null, task: f.task.id, expected: true },
          { label: "null author foreign task", author: null, task: f.otherTask.id, expected: false },
          { label: "null author no task", author: null, expected: false },
          { label: "null author missing task", author: null, task: "tsk_missing", expected: false },
          { label: "wrong session", session: otherSession.id, expected: false },
          { label: "hidden turn", visibility: "hidden", expected: false },
          { label: "deleted turn", deleted: new Date().toISOString(), expected: false },
          { label: "message receipt", kind: "message", expected: false },
          { label: "system receipt", kind: "system", expected: false },
          { label: "numeric boundary below", metadata: metadata(f.entry.seq - 1), expected: false },
          { label: "numeric boundary equal / historical minimal receipt", expected: true },
          { label: "numeric boundary above", metadata: metadata(f.entry.seq + 1), expected: true },
          { label: "real below", metadata: metadata(f.entry.seq - 0.25), expected: false },
          { label: "real above", metadata: metadata(f.entry.seq + 0.25), expected: true },
          ...[String(f.entry.seq), "garbage", true, false, null, [], [f.entry.seq], {}].map((value) => ({
            label: `nonnumeric ${JSON.stringify(value)}`, metadata: metadata(value), expected: false })),
          ...[{}, { inbox: {} }, { inbox: null }, { inbox: [] }].map((value) => ({
            label: `missing receipt ${JSON.stringify(value)}`, metadata: JSON.stringify(value), expected: false })),
          { label: "truncated JSON", metadata: '{"inbox":', expected: false },
          { label: "invalid JSON", metadata: "not-json", expected: false },
        ];
        for (const c of cases) {
          db.run(`UPDATE multiremi_conversation_log SET session_id = ?, kind = ?, visibility = ?,
            author_id = ?, task_id = ?, metadata = ?, deleted_at = ? WHERE id = ?`,
          [c.session ?? f.session.id, c.kind ?? "turn", c.visibility ?? "shown",
            c.author === undefined ? f.recipient.id : c.author, c.task ?? null,
            c.metadata ?? metadata(f.entry.seq), c.deleted ?? null, candidate.id]);
          expect((await f.get()).delivered, c.label).toBe(c.expected);
          f.reads.length = 0;
          expect(f.store.hasInboxReceiptCovering(f.session.id, f.recipient.id, f.entry.seq), c.label).toBe(c.expected);
          expect(f.reads).toHaveLength(1);
          expect(f.reads[0].rows).toBe(Number(c.expected));
        }
        // An invalid candidate must not poison a later valid receipt.
        db.run("UPDATE multiremi_conversation_log SET metadata = ? WHERE id = ?", ['{"inbox":', candidate.id]);
        db.run("UPDATE multiremi_conversation_log SET metadata = ? WHERE id = ?",
          [metadata(f.entry.seq), f.earlyTurn.id]);
        expect(f.earlyTurn.seq).toBeLessThan(f.entry.seq);
        expect((await f.get()).delivered).toBe(true);
        db.run("UPDATE multiremi_conversation_log SET author_id = NULL WHERE id = ?", [f.earlyTurn.id]);
        for (const status of ["completed", "cancelled"]) {
          db.run("UPDATE multiremi_tasks SET status = ? WHERE id = ?", [status, f.task.id]);
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
          db.run(`UPDATE multiremi_session_agent_lanes SET cursor_seq = ?
            WHERE session_id = ? AND agent_id = ? AND execution_scope = ?`,
          [cursor, f.session.id, f.recipient.id, ""]);
          expect((await f.get()).delivered).toBe(cursor >= f.entry.seq);
          expect(f.receiptReads()).toHaveLength(cursor >= f.entry.seq ? 0 : 1);
        }
        const legacy = f.store.appendConversationLog({ sessionId: f.session.id, kind: "message",
          authorType: "member", authorId: "local", bodyMd: "No recipient" });
        expect((await f.get(`seq=${legacy.seq}`)).delivered).toBeNull();
        expect(f.receiptReads()).toHaveLength(0);
        expect(f.reads.some((read) => read.sql.includes("multiremi_session_agent_lanes"))).toBe(false);

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
