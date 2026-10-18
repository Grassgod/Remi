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
 */
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { startMultiremiServer } from "../../packages/server/src/api/server.js";

const API_PORT = Number(process.env.CHAT_SWITCH_API_PORT ?? 16391);
const CHATS = Number(process.env.CHAT_SWITCH_CHATS ?? 6);
const TURNS = Number(process.env.CHAT_SWITCH_TURNS ?? 40);

const database = openSqliteDatabase(":memory:");
const store = new MultiremiStore(database);
const workspace = store.ensureLocalWorkspace();
const me = store.getCurrentUser();
const agent = store.createAgent({ name: "Switch Perf Agent", provider: "codex", workspaceId: workspace.id } as never);
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

const minted = await store.createAccessToken({
  name: "chat switch harness", type: "pat", purpose: "personal",
  workspaceId: workspace.id, userId: me.id, expiresInDays: 1,
});
process.stdout.write(`api=http://127.0.0.1:${API_PORT} slug=${workspace.slug ?? "local"}\n`);
process.stdout.write(`chats=${chatIds.join(",")}\n`);
process.stdout.write(`token=${minted.token}\n`);
process.on("SIGTERM", () => { server.stop(true); database.close(); process.exit(0); });
await new Promise(() => {});
