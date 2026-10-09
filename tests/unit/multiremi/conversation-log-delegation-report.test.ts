import { createResponsibleTestIssue } from './helpers.js';
import { requestMessageBody, taskRequestPath, sentTask } from "./unified-test-paths.js";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { conversationLogKindForSessionEvent } from "@multiremi/store/conversation-log-mirror.js";
import type { ConversationLogEntry } from "@multiremi/contracts/conversation-log";
import type { MultiremiIssue, MultiremiTask } from "@multiremi/contracts/types.js";

// MUL-402: main's cross-issue `delegation_report` session event (ADR 0005) is
// mirrored into `multiremi_conversation_log` at the same seq, so the log has no
// hole where the bridge event sits and a log reader sees the same report.

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let sequence = 0;

async function withStore(backend: "sqlite" | "postgres", run: (store: MultiremiStore) => Promise<void>): Promise<void> {
  if (backend === "sqlite") {
    const db = openSqliteDatabase(":memory:");
    try {
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      await run(store);
    } finally {
      db.close();
    }
    return;
  }
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  const name = `m402dr_${process.pid}_${++sequence}`;
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  let db: PostgresSyncDatabase | null = null;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    db = new PostgresSyncDatabase(url.toString());
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    await run(store);
  } finally {
    db?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

function fixture(store: MultiremiStore) {
  const leaderRuntime = store.registerRuntime({ name: "Leader runtime", provider: "claude", workspaceId: "local" });
  const workerRuntime = store.registerRuntime({ name: "Worker runtime", provider: "claude", workspaceId: "local" });
  const leader = store.createAgent({ name: "Leader", provider: "claude", runtimeId: leaderRuntime.id });
  const worker = store.createAgent({ name: "Worker", provider: "claude", runtimeId: workerRuntime.id });
  const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [worker.id] });
  const parent = createResponsibleTestIssue(store, { title: "Parent", status: "in_progress", assigneeType: "squad", assigneeId: squad.id });
  const child = createResponsibleTestIssue(store, { title: "Child", parentIssueId: parent.id, status: "in_progress",
    assigneeType: "agent", assigneeId: worker.id });
  const leaderSession = store.createIssueSession(parent.id, { title: "Dispatch round" });
  const leaderTask = store.createTask({ agentId: leader.id, issueId: parent.id,
    issueSessionId: leaderSession.id, prompt: "Coordinate." });
  return { leaderRuntime, workerRuntime, leader, worker, parent, child, leaderSession, leaderTask };
}

async function dispatch(store: MultiremiStore, source: MultiremiTask, issue: MultiremiIssue, agentId: string) {
  const app = createMultiremiApp({ store, authToken: "test-root" });
  const token = await store.createTaskAccessToken(source, "local");
  const response = await app.request(taskRequestPath(store, { issueId: issue.id }), {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestMessageBody(store, { agentId, issueId: issue.id, prompt: "Execute delegated work." })),
  });
  expect(response.status).toBe(200);
  return store.getTask(sentTask(store, await response.json()).id)!;
}

function rawDb(store: MultiremiStore) {
  return (store as unknown as { ctx: { db: { run: (sql: string, params: unknown[]) => { changes: number } } } }).ctx.db;
}

/** D1 keeps the log bridge and routes the wake through a deduplicated inbox envelope. */
function reportEnvelope(store: MultiremiStore, sessionId: string, sourceTaskId: string) {
  const entries = store.listConversationLogEntries(sessionId).filter(entry => {
    const message = store.getMessage(entry.id);
    return message?.message_kind === "report" && (message.metadata.message_source as any)?.taskId === sourceTaskId;
  });
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

it("structural offer failures ring the delegator with byte diagnostics and derives the failed owner turn as blocked", async () => {
  await withStore("sqlite", async store => {
    const f = fixture(store);
    const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
    expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(f.leaderTask.id);
    store.startTask(f.leaderTask.id); store.completeTask(f.leaderTask.id, { output: "Dispatched." });
    expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
    store.failTask(childTask.id, { failureReason: "offer_too_large", error: "offer_too_large: bytes=1201234; parts=repos:1200001,agent:25" });
    const envelope = reportEnvelope(store, f.leaderSession.id, childTask.id);
    expect(envelope.body_md).toContain("Status: failed");
    expect(envelope.body_md).toContain("offer_too_large");
    expect(envelope.body_md).toContain("repos:1200001");
    expect(envelope.body_md).toContain(`remi turn get ${store.getTurnForAttempt(childTask.id)!.id}`);
    expect(Buffer.byteLength(envelope.body_md)).toBeLessThan(2048);
    expect(store.getIssue(f.child.id)!.status).toBe("blocked");
  });
});

/** Every session-event seq has a log row at the same seq, and nothing else is in the log. */
function expectNoSeqHole(store: MultiremiStore, sessionId: string): void {
  const eventSeqs = store.listSessionEvents(sessionId).map((event) => event.seq);
  const logSeqs = store.listConversationLogEntries(sessionId)
    .filter((entry) => entry.kind !== "head")
    .map((entry) => entry.seq);
  expect(logSeqs).toEqual(eventSeqs);
  expect(eventSeqs).toEqual(Array.from({ length: eventSeqs.length }, (_, index) => index + 1));
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !pgAdminUrl)(`MUL-402 delegation_report log mirror (${backend})`, () => {
    for (const [terminal, withComment] of [["completed", true], ["failed", false], ["cancelled", false]] as const) {
      it(`mirrors one ${terminal} report ${withComment ? "with" : "without"} a result comment at the event's seq`,
        async () => withStore(backend, async (store) => {
          const f = fixture(store);
          const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
          expect(childTask.delegatedFromIssueSessionId).toBe(f.leaderSession.id);
          expect(childTask.issueSessionId).not.toBe(f.leaderSession.id);
          expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(f.leaderTask.id);
          store.buildTaskSessionProjection(f.leaderTask.id);
          store.startTask(f.leaderTask.id);
          store.completeTask(f.leaderTask.id, { output: "Dispatched." });
          expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
          store.buildTaskSessionProjection(childTask.id);
          store.startTask(childTask.id);
          const comment = withComment
            ? store.createIssueComment(f.child.id, { authorType: "agent", authorId: f.worker.id,
              taskId: childTask.id, issueSessionId: childTask.issueSessionId, body: "Result details" })
            : null;
          if (terminal === "completed") store.completeTask(childTask.id, { output: "Result details" });
          else if (terminal === "failed") store.failTask(childTask.id, { error: "Failure details" });
          else store.cancelTask(childTask.id);

          const message = store.getMessage(reportEnvelope(store, f.leaderSession.id, childTask.id).id)!;
          const event = store.listSessionEvents(f.leaderSession.id).find(row => row.id === message.id)!;
          const entry = store.listConversationLogEntries(f.leaderSession.id).find(row => row.id === message.id)!;
          expect(message).toMatchObject({message_kind:"report",sender_type:"platform",to_agent_id:f.leader.id,wake_applied:"now",wake_requested:"now"});
          expect(entry).toMatchObject({kind:"message",visibility:"shown",session_id:event.sessionId,seq:event.seq,id:event.id,body_md:event.body});
          const {parent_comment_id, ...eventMetadata} = event.metadata;
          expect(parent_comment_id).toBeNull();
          expect(entry.metadata).toStrictEqual(eventMetadata);
          expect(entry.metadata.message_source).toMatchObject({taskId:childTask.id,issueId:f.child.id});
          expect(message.body_md).toContain(`Status: ${terminal}`);
          if(comment)expect((entry.metadata.message_source as any).commentId).toBe(comment.id);
          expect(store.getTurn(store.getTask(childTask.id)!.delegationReturnTaskId!)?.status).toBe("pending");
          expect(childTask.delegationId).toEqual(expect.any(String));
          expectNoSeqHole(store, f.leaderSession.id);
          expectNoSeqHole(store, childTask.issueSessionId!);
        }), backend === "postgres" ? 20_000 : 5_000);
    }
  });
}

// #9: there is one canonical message, so mutating a deleted legacy shadow
// table is no longer a meaningful test. Pin the same dedupe, replay and cursor
// guarantees directly on canonical reports and pending turns.
async function startDelegatedChild(store: MultiremiStore, f: ReturnType<typeof fixture>): Promise<MultiremiTask> {
  const child = await dispatch(store, f.leaderTask, f.child, f.worker.id);
  expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(f.leaderTask.id);
  store.buildTaskSessionProjection(f.leaderTask.id); store.startTask(f.leaderTask.id);
  store.completeTask(f.leaderTask.id, {output:"Dispatched."});
  expect(store.claimTask(f.workerRuntime.id)?.id).toBe(child.id);
  store.buildTaskSessionProjection(child.id); store.startTask(child.id);
  return child;
}
for(const backend of ["sqlite","postgres"] as const) {
  describe.skipIf(backend === "postgres" && !pgAdminUrl)(`Canonical delegation report replay (${backend})`,()=>{
    for(const terminal of ["completed","failed","cancelled"] as const)it(`replays ${terminal} without another report or wake`,async()=>withStore(backend,async store=>{
      const f=fixture(store), child=await startDelegatedChild(store,f);
      if(terminal === "completed")store.completeTask(child.id,{output:"Final details"});
      else if(terminal === "failed")store.failTask(child.id,{error:"Final failure"});
      else store.cancelTask(child.id);
      const report=reportEnvelope(store,f.leaderSession.id,child.id);
      const before=store.listConversationLogEntries(f.leaderSession.id);
      const returnId=store.getTask(child.id)!.delegationReturnTaskId!;
      const repeated=store.ensureDelegationWakeup({sourceTaskId:child.id,requiredEventSeq:report.seq,terminalStatus:terminal,terminalBody:"Final details"});
      expect(repeated).toMatchObject({created:false,covered:true});
      expect(store.getTask(child.id)!.delegationReturnTaskId).toBe(returnId);
      expect(store.listConversationLogEntries(f.leaderSession.id)).toEqual(before);
      expectNoSeqHole(store,f.leaderSession.id);
    }), backend === "postgres" ? 20_000 : 5_000);
    it("a cancelled unclaimed return re-rings the same report with a new attempt",async()=>withStore(backend,async store=>{
      const f=fixture(store),child=await startDelegatedChild(store,f);
      store.completeTask(child.id,{output:"Final details"});
      const report=reportEnvelope(store,f.leaderSession.id,child.id);
      const returnId=store.getTask(child.id)!.delegationReturnTaskId!;
      const before=store.getTurn(returnId)!;
      store.cancelTask(before.current_attempt_id!);
      const returned=store.getTurn(store.getTask(child.id)!.delegationReturnTaskId!)!;
      expect(returned.status).toBe("pending");
      expect(returned.current_attempt_id).not.toBe(before.current_attempt_id);
      expect(reportEnvelope(store,f.leaderSession.id,child.id).id).toBe(report.id);
      expectNoSeqHole(store,f.leaderSession.id);
    }), backend === "postgres" ? 20_000 : 5_000);
    it("the return's offered input includes the shown canonical report once",async()=>withStore(backend,async store=>{
      const f=fixture(store),child=await startDelegatedChild(store,f);
      store.completeTask(child.id,{output:"Final details"});
      const report=reportEnvelope(store,f.leaderSession.id,child.id);
      const returnId=store.getTask(child.id)!.delegationReturnTaskId!;
      const returned=store.getTurn(returnId)!;
      const first=store.claimTask(f.leaderRuntime.id)!;
      if(first.id!==returned.current_attempt_id){store.startTask(first.id);store.completeTask(first.id,{output:"Parent status reviewed"});}
      const offered=first.id===returned.current_attempt_id?first:store.claimTask(f.leaderRuntime.id)!;
      expect(offered.id).toBe(returned.current_attempt_id!);
      const projection=store.buildTaskSessionProjection(returned.current_attempt_id!);
      expect(JSON.stringify(projection)).toContain(report.id);
      expect(store.listMessages(f.leaderSession.id).filter(row=>row.id===report.id)).toHaveLength(1);
    }), backend === "postgres" ? 20_000 : 5_000);
  });
}

// --- Every kind an `appendSessionEvent*` caller can write is mirrored -------
//
// A static scan of the server sources: each call's input object is resolved to
// its `kind` (an omitted kind is the writer's default, "message"). A kind the
// scan cannot resolve fails the test, so a new call site has to be looked at.

const SERVER_SRC = join(import.meta.dir, "../../../packages/server/src");
/** The writer's default when `kind` is omitted (`issue-sessions-repo.ts`). */
const DEFAULT_KIND = "message";
/** `afterTaskTerminal(status: "completed" | "failed" | "cancelled")` writes `task_${status}`. */
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
/**
 * No exemptions. MUL-427 maps `follow_frozen`, `thread_resolved` and
 * `thread_unresolved` (ruling cmt_u7m8e7yitmai), the last kinds this list used to
 * name, so every kind a caller writes now has a log row at its seq.
 */
const UNMAPPED: string[] = [];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function skipQuoted(src: string, start: number): number {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === quote) return i;
  }
  throw new Error(`unterminated string at ${start}`);
}

function skipTemplate(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") return i;
    else if (src[i] === "$" && src[i + 1] === "{") i = matchBracket(src, i + 1);
  }
  throw new Error(`unterminated template at ${start}`);
}

/** Index of the bracket closing `src[start]`, skipping strings, templates and comments. */
function matchBracket(src: string, start: number): number {
  const closers: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "\"" || ch === "'") i = skipQuoted(src, i);
    else if (ch === "`") i = skipTemplate(src, i);
    else if (ch === "/" && src[i + 1] === "/") i = src.indexOf("\n", i);
    else if (ch === "/" && src[i + 1] === "*") i = src.indexOf("*/", i) + 1;
    else if (closers[ch]) stack.push(closers[ch]!);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  throw new Error(`unbalanced bracket at ${start}`);
}

/** The object literal's top level, with nested brackets blanked out. */
function topLevel(objectLiteral: string): string {
  let out = "";
  for (let i = 1; i < objectLiteral.length - 1; i++) {
    const ch = objectLiteral[i]!;
    if (ch === "{" || ch === "(" || ch === "[") {
      const end = matchBracket(objectLiteral, i);
      out += " ".repeat(end - i + 1);
      i = end;
    } else if (ch === "\"" || ch === "'" || ch === "`") {
      const end = ch === "`" ? skipTemplate(objectLiteral, i) : skipQuoted(objectLiteral, i);
      out += objectLiteral.slice(i, end + 1);
      i = end;
    } else {
      out += ch;
    }
  }
  return out;
}

function kindsOf(objectLiteral: string, site: string): string[] {
  const match = /(?:^|[\s,])kind\s*:\s*("[^"]*"|`[^`]*`|[^,\n]+)/.exec(topLevel(objectLiteral));
  if (!match) return [DEFAULT_KIND];
  const value = match[1]!.trim();
  if (value.startsWith("\"")) return [value.slice(1, -1)];
  if (value === "`task_${status}`") return TERMINAL_STATUSES.map((status) => `task_${status}`);
  throw new Error(`${site}: cannot resolve kind ${value}`);
}

function scanSessionEventWrites() {
  const kinds = new Map<string, string[]>();
  const forwarders: string[] = [];
  for (const file of tsFiles(SERVER_SRC)) {
    const src = readFileSync(file, "utf8");
    for (const call of src.matchAll(/\.appendSessionEvent(?:WithinTransaction)?\(/g)) {
      const open = call.index! + call[0].length - 1;
      const args = src.slice(open, matchBracket(src, open) + 1);
      const site = `${relative(SERVER_SRC, file)}:${src.slice(0, call.index).split("\n").length}`;
      // The second argument starts after the first top-level comma.
      const comma = topLevel(args.replace(/^\(/, "{").replace(/\)$/, "}")).indexOf(",");
      const input = args.slice(comma + 2, -1).trim().replace(/,$/, "").trim();
      let objectLiteral: string;
      if (input.startsWith("{")) {
        objectLiteral = input.slice(0, matchBracket(input, 0) + 1);
      } else if (input === "input") {
        forwarders.push(basename(file));
        continue;
      } else if (/^[A-Za-z_$][\w$]*$/.test(input)) {
        const declaration = src.lastIndexOf(`const ${input} = {`, call.index);
        if (declaration < 0) throw new Error(`${site}: cannot find the declaration of ${input}`);
        const brace = src.indexOf("{", declaration);
        objectLiteral = src.slice(brace, matchBracket(src, brace) + 1);
      } else {
        throw new Error(`${site}: cannot resolve input ${input.slice(0, 40)}`);
      }
      for (const kind of kindsOf(objectLiteral, site)) kinds.set(kind, [...(kinds.get(kind) ?? []), site]);
    }
  }
  return { kinds, forwarders };
}

describe("MUL-402 session event kinds all reach the conversation log", () => {
  it("maps every kind an appendSessionEvent caller writes, except the listed exemptions", () => {
    const { kinds, forwarders } = scanSessionEventWrites();
    // The wrappers pass their own `input` through; a new pass-through is a new
    // way in and has to be reviewed here.
    expect(forwarders.sort()).toEqual(["issue-sessions-repo.ts", "store.ts", "store.ts"]);
    // Guards against a scan that silently finds nothing.
    expect(kinds.has("delegation_report")).toBe(false);
    expect([...kinds.keys()].sort()).toEqual(expect.arrayContaining(["system", "task_assigned",
      "task_completed", "task_failed", "task_cancelled", "result_published", "session_created",
      "message_edited", "message_deleted"]));

    const unmapped = [...kinds.keys()].filter((kind) => conversationLogKindForSessionEvent(kind) == null).sort();
    expect(unmapped).toEqual(UNMAPPED);
  });
});
