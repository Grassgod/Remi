import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { conversationLogKindForSessionEvent } from "@multiremi/store/conversation-log-mirror.js";
import type { MultiremiIssue, MultiremiTask } from "@multiremi/contracts/types.js";

// MUL-402: main's cross-issue `delegation_report` session event (ADR 0005) is
// mirrored into `multiremi_conversation_log` at the same seq, so the log has no
// hole where the bridge event sits and a log reader sees the same report.

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let sequence = 0;

async function withStore(backend: "sqlite" | "postgres", run: (store: MultiremiStore) => Promise<void>): Promise<void> {
  if (backend === "sqlite") {
    const db = new Database(":memory:");
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
  const parent = store.createIssue({ title: "Parent", status: "in_progress", assigneeType: "squad", assigneeId: squad.id });
  const child = store.createIssue({ title: "Child", parentIssueId: parent.id, status: "in_progress",
    assigneeType: "agent", assigneeId: worker.id });
  const leaderSession = store.createIssueSession(parent.id, { title: "Dispatch round" });
  const leaderTask = store.createTask({ agentId: leader.id, issueId: parent.id,
    issueSessionId: leaderSession.id, prompt: "Coordinate." });
  return { leaderRuntime, workerRuntime, leader, worker, parent, child, leaderSession, leaderTask };
}

async function dispatch(store: MultiremiStore, source: MultiremiTask, issue: MultiremiIssue, agentId: string) {
  const app = createMultiremiApp({ store, authToken: "test-root" });
  const token = await store.createTaskAccessToken(source, "local");
  const response = await app.request("/api/multiremi/tasks", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, issueId: issue.id, prompt: "Execute delegated work." }),
  });
  expect(response.status).toBe(201);
  return store.getTask(((await response.json()) as { task: { id: string } }).task.id)!;
}

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

          const reports = store.listSessionEvents(f.leaderSession.id)
            .filter((event) => event.kind === "delegation_report");
          expect(reports).toHaveLength(1);
          const event = reports[0]!;
          expect(event.taskId).toBe(childTask.id);
          const mirrored = store.listConversationLogEntries(f.leaderSession.id)
            .filter((entry) => entry.kind === "delegation_report");
          expect(mirrored).toHaveLength(1);
          expect(mirrored[0]).toMatchObject({
            session_id: event.sessionId,
            seq: event.seq,
            id: event.id,
            task_id: event.taskId,
            visibility: "hidden",
            author_type: event.authorType,
            author_id: event.authorId,
            body_md: event.body,
            parent_id: null,
            created_at: event.createdAt,
          });
          expect(store.listConversationLogEntriesByTask(childTask.id)
            .filter((entry) => entry.kind === "delegation_report").map((entry) => entry.id)).toEqual([event.id]);
          // The whole payload, keys and values, including an explicit null result.
          // (`MultiremiSessionEvent.metadata` is `Record<string, unknown>`; main's
          // `delegation_report` writer always puts a string or an explicit null
          // here, and the assertions below pin the mirrored value.)
          expect(mirrored[0]!.metadata).toStrictEqual(event.metadata);
          expect(mirrored[0]!.metadata).toStrictEqual({
            source_issue_id: f.child.id,
            source_issue_key: f.child.key,
            source_task_id: childTask.id,
            delegate_agent_id: f.worker.id,
            terminal_status: terminal,
            result_comment_id: event.metadata.result_comment_id as string | null,
            delegation_id: childTask.delegationId,
          });
          if (comment) expect(mirrored[0]!.metadata.result_comment_id).toEqual(expect.stringMatching(/^cmt_/));
          else {
            expect(Object.hasOwn(mirrored[0]!.metadata, "result_comment_id")).toBe(true);
            expect(mirrored[0]!.metadata.result_comment_id).toBeNull();
          }
          expect(childTask.delegationId).toEqual(expect.any(String));
          expectNoSeqHole(store, f.leaderSession.id);
          expectNoSeqHole(store, childTask.issueSessionId!);
        }));
    }
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
/** The v2 resolve updates the comment row in place instead of appending a marker (B1). */
const UNMAPPED_BY_DESIGN = ["thread_resolved", "thread_unresolved"];
/**
 * Written through `appendSessionEventWithinTransaction` (MUL-324) but not
 * mirrored on this branch, so it still leaves a seq hole here. Ruling
 * cmt_u7m8e7yitmai maps it, with `thread_resolved` / `thread_unresolved`, in
 * MUL-427; listed here so the gap stays visible and the test fails once the kind
 * is mapped or removed.
 */
const UNMAPPED_PENDING_DECISION = ["follow_frozen"];

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
    expect(kinds.get("delegation_report")).toEqual([expect.stringMatching(/^store\/repos\/tasks-repo\.ts:\d+$/)]);
    expect([...kinds.keys()].sort()).toEqual(expect.arrayContaining(["message", "system", "task_assigned",
      "task_completed", "task_failed", "task_cancelled", "result_published", "session_created", "task_steer",
      "message_edited", "message_deleted"]));

    const unmapped = [...kinds.keys()].filter((kind) => conversationLogKindForSessionEvent(kind) == null).sort();
    expect(unmapped).toEqual([...UNMAPPED_BY_DESIGN, ...UNMAPPED_PENDING_DECISION].sort());
  });
});
