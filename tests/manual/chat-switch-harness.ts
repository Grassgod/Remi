#!/usr/bin/env bun
/**
 * Local API for measuring Chat switching (in-memory SQLite, seeded chats).
 *
 *   bun run tests/manual/chat-switch-harness.ts
 *
 * Starts the real API with a few Chats whose replies carry paragraphs, lists,
 * tables and code blocks, mints a PAT and prints it. Pair it with a web server
 * built against the same API port (`REMOTE_API_URL`), then switch chats in a
 * browser. Nothing here reads or writes a remote host.
 *
 * Env:
 *   CHAT_SWITCH_API_PORT   API port (default 16391)
 *   CHAT_SWITCH_CHATS      number of chats (default 6)
 *   CHAT_SWITCH_TURNS      user/assistant pairs per chat (default 40)
 *   CHAT_SWITCH_SQL_MS     synchronous wait per executed statement once serving,
 *                          a stand-in for the PostgreSQL bridge round trip (default 0)
 *   CHAT_SWITCH_PG_URL     admin URL of a disposable PostgreSQL server: the API runs on
 *                          a fresh database there (and needs JWT_SECRET) instead of SQLite
 *   CHAT_SWITCH_AGENT_MS   > 0 starts a fake agent that claims each queued chat turn and
 *                          completes it with a Markdown reply after this many ms
 *   CHAT_SWITCH_AGENT_DAEMONISH=1  the fake agent also reports progress every 2s and
 *                          progress, usage and activity right after completing
 *   CHAT_SWITCH_AGENT_FLIP=1  toggle the running turn between running and awaiting_human every
 *                          40 ms without events, to race the reads that find the pending turn
 *   CHAT_SWITCH_AGENT_ASK_AT_MS  the fake agent asks a question this long into each run
 *                          (awaiting_human) that times out CHAT_SWITCH_AGENT_ANSWER_MS later (default 3000)
 *   CHAT_SWITCH_MEMBER=1   mint the PAT for a plain workspace member, not the local owner
 */
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { startMultiremiServer } from "../../packages/server/src/api/server.js";

const API_PORT = Number(process.env.CHAT_SWITCH_API_PORT ?? 16391);
const CHATS = Number(process.env.CHAT_SWITCH_CHATS ?? 6);
const TURNS = Number(process.env.CHAT_SWITCH_TURNS ?? 40);

// CHAT_SWITCH_PG_URL (an admin URL of a disposable server) runs the API on a
// fresh PostgreSQL database instead, with the read pool the hub uses in production.
const PG_URL = process.env.CHAT_SWITCH_PG_URL ?? "";
let database: ReturnType<typeof openSqliteDatabase>;
if (PG_URL) {
  const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
  const url = new URL(PG_URL);
  const name = `chat_switch_${process.pid}`;
  const admin = new Bun.SQL(PG_URL, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  url.pathname = `/${name}`;
  process.env.MULTIREMI_DATABASE_URL = url.toString();
  database = new PostgresSyncDatabase(url.toString()) as never;
} else database = openSqliteDatabase(":memory:");
const store = new MultiremiStore(database);
const workspace = store.ensureLocalWorkspace();
const me = store.getCurrentUser();
const MEMBER = process.env.CHAT_SWITCH_MEMBER === "1";
const agent = store.createAgent({ name: "Switch Perf Agent", provider: "codex", workspaceId: workspace.id,
  ...(MEMBER ? { visibility: "workspace" } : {}) } as never);
const runtime = store.registerRuntime({ name: "switch-perf-codex", provider: "codex" } as never);

const reply = (chat: number, turn: number): string => [
  `Here is what I found for **chat ${chat}, step ${turn}**. The change touches three places:`,
  "",
  "1. `packages/core/session-log/issue-log.ts` — the replica window",
  "2. `packages/views/chat/components/chat-window.tsx` — the page shell",
  "3. `packages/views/common/session-log/session-log-list.tsx` — reveal",
  "",
  "```ts",
  "export function useIssueLog(sessionId: string) {",
  `  const replica = useMemo(() => new IssueLogReplica(sessionId), [sessionId]); // ${chat}.${turn}`,
  "  return useSyncExternalStore(replica.subscribe, replica.getSnapshot);",
  "}",
  "```",
  "",
  "| step | before | after |",
  "| --- | --- | --- |",
  `| read | ${turn * 3} ms | ${turn} ms |`,
  "| paint | 120 ms | 40 ms |",
  "",
  "filler sentence so the row wraps over several lines in the reading column. ".repeat(4),
].join("\n");

const chatIds: string[] = [];
for (let chat = 1; chat <= CHATS; chat++) {
  const session = store.createChatSession({
    agentId: agent.id, workspaceId: workspace.id, creatorId: me.id, title: `Perf chat ${chat}`,
  });
  chatIds.push(session.id);
  // The production path: a member message queues a turn, the runtime claims and
  // completes it, and the reply lands with its turn card.
  for (let turn = 1; turn <= TURNS; turn++) {
    const sent = store.sendChatMessage(session.id, { body: `Question ${turn} in chat ${chat}: can you look at the replica again?` });
    if (store.claimTask(runtime.id)?.id !== sent.task.id) throw new Error("seed task was not claimed");
    store.startTask(sent.task.id);
    store.completeTask(sent.task.id, { output: reply(chat, turn) } as never);
  }
}

// Production runs every statement through a synchronous PostgreSQL bridge that
// blocks the API thread for a round trip; model that cost after seeding.
const SQL_MS = Number(process.env.CHAT_SWITCH_SQL_MS ?? 0);
if (SQL_MS > 0) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const original = database.query.bind(database);
  (database as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
    const statement = original(sql) as unknown as Record<string, (...args: unknown[]) => unknown>;
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key !== "get" && key !== "all" && key !== "run" && key !== "values") return value.bind(target);
        return (...args: unknown[]) => { Atomics.wait(pause, 0, 0, SQL_MS); return value.apply(target, args); };
      },
    });
  };
}

const server = startMultiremiServer({
  store,
  port: API_PORT,
  hostname: "127.0.0.1",
  authToken: "local-chat-switch-token-not-a-real-credential",
  backgroundJobs: false,
  requestMetrics: { enabled: true, slowRequestMs: 100, summaryIntervalMs: 600_000, summaryTopRoutes: 10, bufferCapacity: 1024, role: "all" },
});

// A stand-in for the daemon: claims each queued chat turn, starts it, and
// completes it with a Markdown reply after CHAT_SWITCH_AGENT_MS.
const AGENT_MS = Number(process.env.CHAT_SWITCH_AGENT_MS ?? 0);
// Like the daemon, report progress while running and progress/usage/activity
// once more after the completion.
const AGENT_DAEMONISH = process.env.CHAT_SWITCH_AGENT_DAEMONISH === "1";
// The status a running turn takes while an agent decision waits (permission or
// question) and loses when it is answered, toggled every 40 ms with no event:
// it exercises reads that race status changes, not the decision flow.
const AGENT_FLIP = process.env.CHAT_SWITCH_AGENT_FLIP === "1";
// An AskUserQuestion-style human request this long into each run (the turn
// goes awaiting_human), which times out CHAT_SWITCH_AGENT_ANSWER_MS later (running again).
const AGENT_ASK_AT = Number(process.env.CHAT_SWITCH_AGENT_ASK_AT_MS ?? 0);
const AGENT_ANSWER_AFTER = Number(process.env.CHAT_SWITCH_AGENT_ANSWER_MS ?? 3000);
const agentStep = (label: string, fn: () => unknown) => {
  try { fn(); process.stdout.write(`agent ${label}\n`); } catch (error) { process.stderr.write(`agent ${label}: ${String(error)}\n`); }
};
if (AGENT_MS > 0) {
  let turn = 0;
  setInterval(() => {
    let claimed;
    try { claimed = store.claimTask(runtime.id); } catch (error) { process.stderr.write(`agent claim: ${String(error)}\n`); return; }
    if (!claimed) return;
    const taskId = claimed.id;
    const n = ++turn;
    process.stdout.write(`agent claimed ${taskId}\n`);
    setTimeout(() => {
      agentStep(`started ${taskId}`, () => store.startTask(taskId));
      let progress: ReturnType<typeof setInterval> | null = null;
      let step = 0;
      const flip = AGENT_FLIP ? setInterval(() => {
        (database as unknown as { run: (sql: string, params: unknown[]) => unknown }).run(
          "UPDATE multiremi_turns SET status=CASE status WHEN 'running' THEN 'awaiting_human' ELSE 'running' END WHERE current_attempt_id=? AND status IN ('running','awaiting_human')",
          [taskId]);
      }, Number(process.env.CHAT_SWITCH_AGENT_FLIP_MS ?? 40)) : null;
      if (AGENT_ASK_AT > 0) setTimeout(() => {
        let requestId = "";
        agentStep(`ask ${taskId}`, () => {
          requestId = store.createTaskHumanRequest({ taskId, kind: "question", timeoutMs: 600_000,
            payload: { title: "Which tickets?", questions: [{ question: "Which tickets?", options: [{ label: "Last three" }] }] } } as never).id;
        });
        if (requestId) setTimeout(() => agentStep(`answer ${requestId}`,
          () => store.expireTaskHumanRequest(requestId, "timeout")), AGENT_ANSWER_AFTER);
      }, AGENT_ASK_AT);
      if (AGENT_DAEMONISH) progress = setInterval(() => {
        step += 1;
        agentStep(`progress ${step}`, () => store.reportProgress(taskId, `Working on step ${step}`, step, null));
      }, 2000);
      setTimeout(() => {
        if (progress) clearInterval(progress);
        if (flip) {
          clearInterval(flip);
          (database as unknown as { run: (sql: string, params: unknown[]) => unknown }).run(
            "UPDATE multiremi_turns SET status='running' WHERE current_attempt_id=? AND status='awaiting_human'", [taskId]);
        }
        agentStep(`completed ${taskId}`, () => store.completeTask(taskId, { output: reply(0, n) } as never));
        if (!AGENT_DAEMONISH) return;
        setTimeout(() => {
          agentStep("final progress", () => store.reportProgress(taskId, "Done", step + 1, step + 1, { allowTerminal: true }));
          agentStep("usage", () => store.reportTaskUsage(taskId, [{ provider: "codex", model: "gpt-5", inputTokens: 1200, outputTokens: 300 }]));
          agentStep("activity", () => store.recordTaskActivity(taskId, { runningSubagents: 0, runningBackgroundTasks: 0 }));
        }, 150);
      }, AGENT_MS);
    }, 200);
  }, 250);
}

// CHAT_SWITCH_MEMBER=1 mints the PAT for a plain workspace member instead of
// the local owner, so the read and hub visibility checks run as in production.
let reader = me.id;
if (MEMBER) {
  const member = store.getOrCreateUser({ externalId: "chat-switch-member", email: "member@chat-switch.invalid", name: "Switch Member" });
  store.markCurrentUserOnboarded(member.id);
  store.createWorkspaceMember({ workspaceId: workspace.id, userId: member.id, name: "Switch Member", role: "member" } as never);
  reader = member.id;
}
const minted = await store.createAccessToken({
  name: "chat switch harness", type: "pat", purpose: "personal",
  workspaceId: workspace.id, userId: reader, expiresInDays: 1,
});
process.stdout.write(`api=http://127.0.0.1:${API_PORT} slug=${workspace.slug ?? "local"}\n`);
process.stdout.write(`chats=${chatIds.join(",")}\n`);
process.stdout.write(`token=${minted.token}\n`);
process.on("SIGTERM", () => { server.stop(true); database.close(); process.exit(0); });
await new Promise(() => {});
