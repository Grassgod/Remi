import type { Database } from "bun:sqlite";
import { createInterface } from "node:readline";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { createPeerChannel } from "../../../packages/server/src/api/peer/peer-channel.js";
import { createRealtimeFanout } from "../../../packages/server/src/api/realtime-fanout.js";

const [databasePath, runtimePort, peerSecret] = process.argv.slice(2);
if (!databasePath || !runtimePort || !peerSecret) throw new Error("ui fixture arguments missing");

const db = openSqliteDatabase(databasePath);
db.exec("PRAGMA busy_timeout = 5000");
const store = new MultiremiStore(db);
const peer = createPeerChannel({
  url: `http://127.0.0.1:${runtimePort}`,
  secret: peerSecret,
  origin: "mul419-ui-process",
  minBackoffMs: 20,
  maxBackoffMs: 100,
});
let daemonSessions = () => 0;
let daemonHookCalls = 0;
const server = startMultiremiServer({
  store,
  scheduler: null,
  backgroundJobs: false,
  port: 0,
  hostname: "127.0.0.1",
  apiRole: "ui",
  authToken: "fixture-master",
  peerChannel: peer,
  peerSecret,
  onDaemonProtocol: layer => { daemonSessions = () => layer.registry.size; },
  createRealtimeFanout: options => createRealtimeFanout({
    ...options,
    onDaemonTask: event => { daemonHookCalls++; options.onDaemonTask?.(event); },
    onDaemonWorkspaceEvent: event => { daemonHookCalls++; options.onDaemonWorkspaceEvent?.(event); },
  }),
});

function reply(value: Record<string, unknown>): void {
  process.stdout.write(`MUL419 ${JSON.stringify(value)}\n`);
}

reply({ ready: true, port: server.port });
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line) as { op: string; runtimeId?: string; taskId?: string; agentId?: string;
    issueId?: string; requestId?: string; status?: "timeout" | "cancelled" };
  try {
    if (command.op === "create_task") {
      const task = store.createTask({ agentId: command.agentId!, issueId: command.issueId, runtimeId: command.runtimeId,
        prompt: "cross-process offer" });
      reply({ op: command.op, taskId: task.id });
    } else if (command.op === "create_human_request") {
      const request = store.createTaskHumanRequest({ taskId: command.taskId!, kind: "question",
        payload: { message: "Continue?", questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] } });
      reply({ op: command.op, requestId: request.id });
    } else if (command.op === "respond_human_request") {
      const request = store.respondTaskHumanRequest(command.requestId!, { response: { answer: "Yes" } });
      reply({ op: command.op, requestId: request?.id });
    } else if (command.op === "expire_human_request") {
      const request = store.expireTaskHumanRequest(command.requestId!, command.status ?? "timeout");
      reply({ op: command.op, requestId: request?.id });
    } else if (command.op === "create_command") {
      const request = store.createRuntimeCommandRequest(command.runtimeId!, {
        command: "echo", args: ["cross-process"], createdBy: "fixture",
      });
      reply({ op: command.op, requestId: request.id });
    } else if (command.op === "create_steer") {
      const steer = store.createTaskSteerMessage({ taskId: command.taskId!, kind: "steer",
        content: "cross-process steer" });
      reply({ op: command.op, steerId: steer.id });
    } else if (command.op === "stats") {
      reply({ op: command.op, daemonHookCalls, daemonSessions: daemonSessions() });
    } else if (command.op === "stop") {
      server.stop(true);
      await Bun.sleep(25);
      db.close();
      reply({ op: command.op, stopped: true });
      break;
    } else {
      throw new Error(`unknown operation ${command.op}`);
    }
  } catch (error) {
    reply({ op: command.op, error: error instanceof Error ? error.message : String(error) });
  }
}
