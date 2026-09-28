import { randomUUID } from "node:crypto";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { createPeerChannel, resolvePeerSecret, resolvePeerUrl } from "../../packages/server/src/api/peer/peer-channel.js";
import { redactDiagnostic } from "./two-process.js";

const db = new PostgresSyncDatabase(process.env.MULTIREMI_DATABASE_URL!);
let store: MultiremiStore;
let server: ReturnType<typeof startMultiremiServer> | undefined;
let peer: ReturnType<typeof createPeerChannel> | undefined;

process.on("SIGTERM", () => {
  server?.stop(true);
  db.close();
  process.exit(0);
});

process.on("message", async (message: { id?: number; command: string; args: any }) => {
  try {
    const value = await command(message.command, message.args);
    if (message.id !== undefined) process.send!({ id: message.id, value });
  } catch (error) {
    const diagnostic = redactDiagnostic(error instanceof Error ? error.message : String(error));
    process.send!({ id: message.id, event: message.id === undefined ? "error" : undefined, error: diagnostic });
  }
});

async function command(name: string, args: any): Promise<unknown> {
  if (name === "start") {
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    server = startMultiremiServer({ store });
    process.send!({ event: "ready" });
    return;
  }
  if (name === "seed") {
    const agent = store.createAgent({ name: "Two-process comments", provider: "codex" });
    const issue = store.createIssue({ title: "Two-process comments", workspaceId: "local" });
    const browser = await store.createAccessToken({ name: "Two-process browser", type: "pat", workspaceId: "local" });
    return { agentId: agent.id, issueId: issue.id, browserToken: browser.token };
  }
  if (name === "comments") {
    return Array.from({ length: args.count }, (_, index) => store.createIssueComment(args.issueId, {
      body: `two-process ${args.label} ${index}`,
      authorType: "agent",
      authorId: args.agentId,
    }).id);
  }
  if (name === "queue") {
    const suffix = randomUUID();
    const runtimes = [0, 1].map((index) => store.registerRuntime({
      id: `rt_${suffix}_${index}`, name: `Two-process daemon ${index}`, provider: "codex",
      daemonId: `daemon_${suffix}_${index}`, maxConcurrency: 2,
    }));
    const agent = store.createAgent({ name: `Two-process queue ${suffix}`, provider: "codex", maxConcurrentTasks: 1 });
    return { runtimeIds: runtimes.map((runtime) => runtime.id), agentId: agent.id };
  }
  if (name === "enqueue") {
    return store.createTask({ agentId: args.agentId, prompt: `two-process ${randomUUID()}`, runtimeId: args.runtimeId }).id;
  }
  if (name === "task") {
    const task = store.getTask(args.id)!;
    return { id: task.id, status: task.status, runtimeId: task.runtimeId };
  }
  if (name === "complete") {
    store.completeTask(args.id, { output: "two-process test complete" });
    return;
  }
  if (name === "small-queue") {
    // Use the existing peer injection point to reach overflow with real writes
    // in a bounded test; the normal pair above uses the production env path.
    server!.stop(true);
    peer = createPeerChannel({ url: resolvePeerUrl(), secret: resolvePeerSecret(), queueLimit: 8 });
    server = startMultiremiServer({ store, peerChannel: peer });
    return;
  }
  throw new Error(`Unknown child command: ${name}`);
}

process.send!({ event: "prepared" });
