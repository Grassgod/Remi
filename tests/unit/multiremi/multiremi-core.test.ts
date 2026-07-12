import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { detectMultiremiProviders } from "../../../apps/remi/cli/multiremi.js";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import { writeAgentSkillContext, writeProjectResourceContext } from "@multiremi/daemon.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import { MultiremiScheduler } from "@multiremi/scheduler.js";
import { daemonRuntimeId, MultiremiStore } from "@multiremi/store.js";

let db: Database | null = null;
let previousUploadDir: string | undefined;
let uploadDir: string | null = null;
let previousFetch: typeof globalThis.fetch | null = null;

function createStore(): MultiremiStore {
  db = new Database(":memory:");
  return new MultiremiStore(db);
}

function signTestJwt(payload: Record<string, unknown>, secret = "multiremi-dev-secret-change-in-production"): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

function workspaceRepoVersion(urls: string[]): string {
  return createHash("sha256").update([...urls].sort().join("\n")).digest("hex");
}

afterEach(() => {
  db?.close();
  db = null;
  if (uploadDir) {
    rmSync(uploadDir, { recursive: true, force: true });
    uploadDir = null;
  }
  if (previousUploadDir === undefined) delete process.env.MULTIREMI_UPLOAD_DIR;
  else process.env.MULTIREMI_UPLOAD_DIR = previousUploadDir;
  previousUploadDir = undefined;
  if (previousFetch) {
    globalThis.fetch = previousFetch;
    previousFetch = null;
  }
});

function useUploadDir(): string {
  previousUploadDir = process.env.MULTIREMI_UPLOAD_DIR;
  uploadDir = mkdtempSync(join(tmpdir(), "multiremi-upload-"));
  process.env.MULTIREMI_UPLOAD_DIR = uploadDir;
  return uploadDir;
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  previousFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof globalThis.fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function metricValue(store: MultiremiStore, name: string, labels: Record<string, string>): number {
  return store.listMetricCounters({ name }).find((counter) => {
    const keys = Object.keys(labels);
    return Object.keys(counter.labels).length === keys.length && keys.every((key) => counter.labels[key] === labels[key]);
  })?.value ?? 0;
}

function nextWebSocketMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for websocket message")), 2000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(event.data)));
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error"));
    }, { once: true });
  });
}

function nextWebSocketMessages(socket: WebSocket, count: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const timeout = setTimeout(() => done(() => reject(new Error("Timed out waiting for websocket messages"))), 2000);
    const done = (fn: () => void) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      fn();
    };
    const onMessage = (event: MessageEvent) => {
      messages.push(JSON.parse(String(event.data)));
      if (messages.length === count) done(() => resolve(messages));
    };
    const onError = () => done(() => reject(new Error("WebSocket error")));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
  });
}

function expectWebSocketRejected(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for websocket rejection")), 2000);
    const done = (fn: () => void) => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onRejected);
      socket.removeEventListener("error", onRejected);
      fn();
    };
    const onOpen = () => done(() => reject(new Error("WebSocket unexpectedly opened")));
    const onMessage = () => done(() => reject(new Error("WebSocket unexpectedly received a message")));
    const onRejected = () => done(resolve);
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("close", onRejected, { once: true });
    socket.addEventListener("error", onRejected, { once: true });
  });
}

function waitWebSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for websocket open")), 2000);
    const done = (fn: () => void) => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      fn();
    };
    const onOpen = () => done(resolve);
    const onError = () => done(() => reject(new Error("WebSocket error")));
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

async function authenticateBrowserWebSocket(socket: WebSocket, token: string): Promise<void> {
  await waitWebSocketOpen(socket);
  socket.send(JSON.stringify({ type: "auth", payload: { token } }));
  expect(await nextWebSocketMessage(socket)).toMatchObject({ type: "auth_ack" });
}

function expectNoWebSocketMessage(socket: WebSocket, timeoutMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => done(resolve), timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      fn();
    };
    const onMessage = (event: MessageEvent) => done(() => reject(new Error(`Unexpected websocket message: ${String(event.data)}`)));
    const onError = () => done(() => reject(new Error("WebSocket error")));
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

describe("Bun Multiremi core store", () => {
  it("claims queued tasks by runtime provider and completes them", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex", maxConcurrentTasks: 2 });
    const other = store.createAgent({ name: "Claude", provider: "claude" });
    const issue = store.createIssue({ title: "Fix bug", workspaceId: "local" });
    const codexTask = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Fix the bug" });
    store.createTask({ agentId: other.id, issueId: issue.id, prompt: "Should not claim" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex", workspaceId: "local" });

    const claimed = store.claimTask(runtime.id);
    expect(claimed?.id).toBe(codexTask.id);
    expect(claimed?.status).toBe("dispatched");
    expect(claimed?.agent?.provider).toBe("codex");

    store.startTask(codexTask.id);
    store.appendTaskMessages(codexTask.id, [
      { type: "assistant", content: "done" },
      { type: "usage", content: "{}" },
    ]);
    store.reportTaskUsage(codexTask.id, [{
      provider: "codex",
      model: "test",
      inputTokens: 10,
      outputTokens: 4,
    }]);
    const completed = store.completeTask(codexTask.id, { output: "done", sessionId: "sess_1", workDir: "/tmp/work" });

    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("done");
    expect(completed.sessionId).toBe("sess_1");
    const rawResult = db!.query("SELECT result FROM multiremi_tasks WHERE id = ?").get(codexTask.id) as { result: string };
    expect(JSON.parse(rawResult.result)).toEqual({
      pr_url: "",
      output: "done",
      session_id: "sess_1",
      work_dir: "/tmp/work",
    });
    expect(store.listTaskMessages(codexTask.id)).toHaveLength(2);
    expect(store.getTask(codexTask.id)?.usage[0].inputTokens).toBe(10);

    const legacyTask = store.createTask({ agentId: agent.id, prompt: "legacy result row" });
    db!.run("UPDATE multiremi_tasks SET status = 'completed', result = ? WHERE id = ?", ["legacy done", legacyTask.id]);
    expect(store.getTask(legacyTask.id)?.result).toBe("legacy done");
  });

  it("routes tasks to an agent-bound runtime before falling back to provider matching", () => {
    const store = createStore();
    const firstRuntime = store.registerRuntime({ id: "rt_first_codex", name: "first", provider: "codex" });
    const secondRuntime = store.registerRuntime({ id: "rt_second_codex", name: "second", provider: "codex" });
    const boundAgent = store.createAgent({ name: "Bound Codex", provider: "codex", runtimeId: secondRuntime.id });
    const task = store.createTask({ agentId: boundAgent.id, prompt: "Run on the bound runtime" });

    expect(boundAgent.runtimeId).toBe(secondRuntime.id);
    expect(task.runtimeId).toBe(secondRuntime.id);
    expect(store.claimTask(firstRuntime.id)).toBeNull();
    expect(store.claimTask(secondRuntime.id)?.id).toBe(task.id);
  });

  it("claims unbound agents' tasks from any provider-matching runtime and stamps the claimer", () => {
    const store = createStore();
    const claude = store.registerRuntime({ id: "rt_pool_claude", name: "pool claude", provider: "claude" });
    const codexA = store.registerRuntime({ id: "rt_pool_codex_a", name: "pool codex a", provider: "codex" });
    const codexB = store.registerRuntime({ id: "rt_pool_codex_b", name: "pool codex b", provider: "codex" });
    const agent = store.createAgent({ name: "Pool Codex", provider: "codex" });
    expect(agent.runtimeId).toBeNull();
    const task = store.createTask({ agentId: agent.id, prompt: "run anywhere" });
    expect(task.runtimeId).toBeNull();

    expect(store.claimTask(claude.id)).toBeNull();
    expect(store.claimTask(codexA.id)?.id).toBe(task.id);
    expect(store.getTask(task.id)?.runtimeId).toBe(codexA.id);

    const secondAgent = store.createAgent({ name: "Pool Codex 2", provider: "codex" });
    const secondTask = store.createTask({ agentId: secondAgent.id, prompt: "second machine" });
    expect(store.claimTask(codexB.id)?.id).toBe(secondTask.id);
    expect(store.getTask(secondTask.id)?.runtimeId).toBe(codexB.id);

    const anyRuntime = store.registerRuntime({ id: "rt_pool_any", name: "pool any", provider: "any" });
    const thirdAgent = store.createAgent({ name: "Pool Codex 3", provider: "codex" });
    const thirdTask = store.createTask({ agentId: thirdAgent.id, prompt: "any provider" });
    expect(store.claimTask(anyRuntime.id)?.id).toBe(thirdTask.id);
  });

  it("keeps private runtimes from claiming other members' agent tasks", () => {
    const store = createStore();
    const bobPrivate = store.registerRuntime({
      id: "rt_own_bob_private",
      name: "bob private",
      provider: "codex",
      workspaceId: "local",
      ownerId: "bob",
      visibility: "private",
    });
    const bobPublic = store.registerRuntime({
      id: "rt_own_bob_public",
      name: "bob public",
      provider: "codex",
      workspaceId: "local",
      ownerId: "bob",
      visibility: "public",
    });
    const aliceAgent = store.createAgent({ name: "Alice codex", provider: "codex", workspaceId: "local", ownerId: "alice" });
    const issueA = store.createIssue({ title: "alice a", workspaceId: "local" });
    const task = store.createTask({ agentId: aliceAgent.id, issueId: issueA.id, prompt: "alice work", workspaceId: "local" });

    // Bob's private machine must not receive alice's agent (custom_env /
    // mcp_config ride along with a claim); his public one may.
    expect(store.claimTask(bobPrivate.id)).toBeNull();
    expect(store.claimTask(bobPublic.id)?.id).toBe(task.id);

    // A stamp is NOT an escape hatch: the unauthenticated /tasks API lets any
    // member stamp an arbitrary agent+runtime, so bob stamping alice's private
    // agent to his own private runtime must still be refused at claim time.
    const issueB = store.createIssue({ title: "alice b", workspaceId: "local" });
    store.createTask({
      agentId: aliceAgent.id,
      issueId: issueB.id,
      prompt: "stamped-steal",
      workspaceId: "local",
      runtimeId: bobPrivate.id,
    });
    expect(store.claimTask(bobPrivate.id)).toBeNull();

    // Bob's own agents still flow to his private machine.
    const bobAgent = store.createAgent({ name: "Bob codex", provider: "codex", workspaceId: "local", ownerId: "bob" });
    const bobTask = store.createTask({ agentId: bobAgent.id, prompt: "bob work", workspaceId: "local" });
    expect(store.claimTask(bobPrivate.id)?.id).toBe(bobTask.id);
  });

  it("pairs an owner-null private runtime with local agents but not multi-user ones", () => {
    const store = createStore();
    // Single-machine shape: runtime registered without auth (owner null),
    // default agent owner "local" — must still pair.
    const localRuntime = store.registerRuntime({ id: "rt_null_owner", name: "local box", provider: "codex", visibility: "private" });
    expect(localRuntime.ownerId).toBeNull();
    const localAgent = store.createAgent({ name: "Local codex", provider: "codex" });
    expect(localAgent.ownerId).toBe("local");
    const localTask = store.createTask({ agentId: localAgent.id, prompt: "local work" });
    expect(store.claimTask(localRuntime.id)?.id).toBe(localTask.id);
    store.startTask(localTask.id);
    store.completeTask(localTask.id, { output: "done" });

    // Multi-user shape: a real member's agent must NOT be swept up by the same
    // owner-null private runtime.
    const aliceAgent = store.createAgent({ name: "Alice codex", provider: "codex", ownerId: "alice" });
    store.createTask({ agentId: aliceAgent.id, prompt: "alice work" });
    expect(store.claimTask(localRuntime.id)).toBeNull();
  });

  it("re-pools and abandons the session when the chat runtime can no longer run the agent", () => {
    const store = createStore();
    const codexA = store.registerRuntime({ id: "rt_repool_a", name: "codex a", provider: "codex" });
    const codexB = store.registerRuntime({ id: "rt_repool_b", name: "codex b", provider: "codex" });
    const agent = store.createAgent({ name: "Repool", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(codexA.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_repool", workDir: "/tmp/repool" });

    // The machine that holds the session is deleted → its runtime row is gone.
    store.deleteRuntime(codexA.id);
    const followUp = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    // Task re-pools (not pinned to the dead runtime) and drops the now-orphan
    // session/work_dir so the new machine doesn't resume a vanished session.
    expect(followUp.runtimeId).toBeNull();
    expect(followUp.sessionId).toBeNull();
    expect(followUp.workDir).toBeNull();
    expect(store.claimTask(codexB.id)?.id).toBe(followUp.id);
  });

  it("truly abandons the provider session on a resume-unsafe chat retry", () => {
    const store = createStore();
    const codexA = store.registerRuntime({ id: "rt_unsafe_a", name: "codex a", provider: "codex" });
    const codexB = store.registerRuntime({ id: "rt_unsafe_b", name: "codex b", provider: "codex" });
    const agent = store.createAgent({ name: "Unsafe", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(codexA.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_unsafe", workDir: "/tmp/unsafe" });

    const second = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    expect(store.claimTask(codexA.id)?.id).toBe(second.id);
    store.startTask(second.id);
    // Resume-unsafe failure → retry must drop the session and re-pool, not
    // resume the failed session on codexA.
    store.failTask(second.id, { error: "stalled", failureReason: "codex_semantic_inactivity" });
    const retry = store.listTasks().find((task) => task.parentTaskId === second.id)!;
    expect(retry.runtimeId).toBeNull();
    expect(retry.sessionId).toBeNull();
    expect(retry.workDir).toBeNull();
    // Any codex machine can pick it up (fresh session), including a different one.
    expect(store.claimTask(codexB.id)?.id).toBe(retry.id);
  });

  it("keeps unbound agents unbound when a daemon registers", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Pool stays unbound", provider: "codex", workspaceId: "local" });
    const app = createMultiremiApp({ store });
    const register = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: "daemon-pool", workspace_id: "local", runtimes: [{ name: "", type: "codex" }] }),
    });
    expect(register.status).toBe(200);
    expect(store.getAgent(agent.id)?.runtimeId).toBeNull();
  });

  it("unpins legacy agent runtime bindings at startup", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_legacy_pin", name: "legacy pin", provider: "codex" });
    const agent = store.createAgent({ name: "Legacy pinned", provider: "codex", runtimeId: runtime.id });
    expect(store.getAgent(agent.id)?.runtimeId).toBe(runtime.id);
    const reopened = new MultiremiStore(db!);
    expect(reopened.getAgent(agent.id)?.runtimeId).toBeNull();
  });

  it("keeps follow-up chat messages on the machine that holds the provider session", () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_chat_codex_a", name: "chat codex a", provider: "codex" });
    const codexB = store.registerRuntime({ id: "rt_chat_codex_b", name: "chat codex b", provider: "codex" });
    const agent = store.createAgent({ name: "Chat pool", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "hello" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(first.runtimeId).toBeNull();

    expect(store.claimTask(codexB.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "done", sessionId: "sess_chat_affinity", workDir: "/tmp/chat" });
    expect(store.getChatSession(session.id)?.sessionId).toBe("sess_chat_affinity");

    const second = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    expect(second.runtimeId).toBe(codexB.id);
    // Same-engine follow-up resumes the promoted provider session + work_dir.
    expect(second.sessionId).toBe("sess_chat_affinity");
    expect(second.workDir).toBe("/tmp/chat");

    // A provider switch drops the affinity — a codex-machine stamp would make
    // the task unclaimable by any claude runtime — AND abandons the codex
    // session/work_dir so the claude engine doesn't resume a foreign session.
    store.updateAgent(agent.id, { provider: "claude" });
    const third = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "after switch" });
    expect(third.runtimeId).toBeNull();
    expect(third.sessionId).toBeNull();
    expect(third.workDir).toBeNull();
  });

  it("routes project tasks to the machine holding the local directory", () => {
    const store = createStore();
    const dirRuntime = store.registerRuntime({ id: "rt_dir_codex", name: "dir codex", provider: "codex", daemonId: "daemon-dir" });
    store.registerRuntime({ id: "rt_dir_claude", name: "dir claude", provider: "claude", daemonId: "daemon-dir" });
    store.registerRuntime({ id: "rt_elsewhere_codex", name: "elsewhere codex", provider: "codex", daemonId: "daemon-elsewhere" });
    const agent = store.createAgent({ name: "Dir pool", provider: "codex" });
    const project = store.createProject({ title: "Local project", workspaceId: "local" });
    store.createProjectResource(project.id, {
      resourceType: "local_directory",
      resourceRef: { local_path: "/abs/project", daemon_id: "daemon-dir" },
    });
    const issue = store.createIssue({ title: "dir issue", workspaceId: "local", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work in the local dir" });
    expect(task.runtimeId).toBe(dirRuntime.id);

    // A directory on a daemon with no runtime row (never registered / GC'd)
    // stamps the deterministic id that daemon's runtime WILL get, so the
    // task waits for the right machine instead of running elsewhere.
    const orphanProject = store.createProject({ title: "Orphan project", workspaceId: "local" });
    store.createProjectResource(orphanProject.id, {
      resourceType: "local_directory",
      resourceRef: { local_path: "/abs/orphan", daemon_id: "daemon-gone" },
    });
    const orphanIssue = store.createIssue({ title: "orphan issue", workspaceId: "local", projectId: orphanProject.id });
    const orphanTask = store.createTask({ agentId: agent.id, issueId: orphanIssue.id, prompt: "no machine has this" });
    expect(orphanTask.runtimeId).toBe(daemonRuntimeId("daemon-gone", "codex"));
    // Not claimable by machines that don't have the directory.
    expect(store.claimTask(dirRuntime.id)?.id).not.toBe(orphanTask.id);
    // Once the daemon registers (same deterministic id), the task dispatches there.
    const lateRuntime = store.registerRuntime({
      id: daemonRuntimeId("daemon-gone", "codex"),
      name: "late arrival",
      provider: "codex",
      daemonId: "daemon-gone",
    });
    expect(store.claimTask(lateRuntime.id)?.id).toBe(orphanTask.id);
  });

  it("frees resume-unsafe retries to the pool while resume-safe retries stay pinned", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_retry_codex", name: "retry codex", provider: "codex" });
    const agent = store.createAgent({ name: "Retry pool", provider: "codex" });

    const offlineIssue = store.createIssue({ title: "offline retry", workspaceId: "local" });
    const offlineTask = store.createTask({ agentId: agent.id, issueId: offlineIssue.id, prompt: "fails offline" });
    expect(store.claimTask(runtime.id)?.id).toBe(offlineTask.id);
    store.startTask(offlineTask.id);
    store.failTask(offlineTask.id, { error: "runtime went away", failureReason: "runtime_offline" });
    const offlineRetry = store.listTasks().find((task) => task.parentTaskId === offlineTask.id)!;
    expect(offlineRetry.runtimeId).toBe(runtime.id);

    const unsafeIssue = store.createIssue({ title: "unsafe retry", workspaceId: "local" });
    // Priority beats the queued offline retry in the claim ordering.
    const unsafeTask = store.createTask({ agentId: agent.id, issueId: unsafeIssue.id, prompt: "fails unsafely", priority: 100 });
    expect(store.claimTask(runtime.id)?.id).toBe(unsafeTask.id);
    store.startTask(unsafeTask.id);
    store.failTask(unsafeTask.id, { error: "stalled", failureReason: "codex_semantic_inactivity" });
    const unsafeRetry = store.listTasks().find((task) => task.parentTaskId === unsafeTask.id)!;
    expect(unsafeRetry.runtimeId).toBeNull();
  });

  it("keeps another member's private default agent out of the default endpoint", async () => {
    const store = createStore();
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "member" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "Bob", type: "pat", workspaceId: "local", userId: "bob" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

    // Alice seeds the workspace default (created workspace-visible), then
    // locks it down and stores secrets on it.
    const seeded = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(seeded.status).toBe(201);
    const aliceAgent = (await seeded.json()).agent;
    expect(aliceAgent.visibility).toBe("workspace");
    expect(aliceAgent.ownerId).toBe("alice");
    store.updateAgent(aliceAgent.id, { visibility: "private", customEnv: { SECRET_TOKEN: "s3cret-value" } });

    // Bob's provider-only call must neither return alice's private agent nor
    // leak her custom_env — he gets his own default under a distinct id.
    const bobSeed = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(bobSeed.status).toBe(201);
    const bobBody = await bobSeed.json();
    expect(bobBody.agent.id).not.toBe(aliceAgent.id);
    expect(bobBody.agent.ownerId).toBe("bob");
    expect(JSON.stringify(bobBody)).not.toContain("s3cret-value");

    // Alice keeps resolving to her own (now private) default.
    const aliceAgain = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(aliceAgain.status).toBe(200);
    expect((await aliceAgain.json()).agent.id).toBe(aliceAgent.id);
  });

  it("rejects unknown providers smuggled through an any-provider runtime", async () => {
    const store = createStore();
    const anyRuntime = store.registerRuntime({ id: "rt_any_gate", name: "any gate", provider: "any", workspaceId: "local" });
    const app = createMultiremiApp({ store });

    const smuggled = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Gemini smuggle", runtime_id: anyRuntime.id, provider: "gemini" }),
    });
    expect(smuggled.status).toBe(400);
    expect(await smuggled.json()).toEqual({ error: 'unknown provider "gemini"' });

    // Omitting the provider falls back to the default engine.
    const defaulted = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Any default", runtime_id: anyRuntime.id }),
    });
    expect(defaulted.status).toBe(201);
    expect(store.getAgent((await defaulted.json()).id)?.provider).toBe("claude");
  });

  it("surfaces engines through an any-provider runtime in the fleet catalog", async () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_fleet_any_only", name: "fleet any only", provider: "any", workspaceId: "local" });
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/models");
    const body = await response.json();
    const providers = new Map(body.providers.map((entry: any) => [entry.provider, entry]));
    expect((providers.get("claude") as any)?.online_runtime_count).toBe(1);
    expect((providers.get("codex") as any)?.online_runtime_count).toBe(1);
  });

  it("counts only the caller's usable runtimes in the fleet catalog", async () => {
    const store = createStore();
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "member" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    // Alice's private codex runtime + Bob's private codex runtime + a public one.
    store.registerRuntime({ id: "rt_cap_alice", name: "alice codex", provider: "codex", workspaceId: "local", ownerId: "alice", visibility: "private" });
    store.registerRuntime({ id: "rt_cap_bob", name: "bob codex", provider: "codex", workspaceId: "local", ownerId: "bob", visibility: "private" });
    store.registerRuntime({ id: "rt_cap_pub", name: "shared codex", provider: "codex", workspaceId: "local", ownerId: "bob", visibility: "public" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/models", { headers: { Authorization: `Bearer ${aliceToken.token}` } });
    const body = await response.json();
    const codex = body.providers.find((entry: any) => entry.provider === "codex");
    // Alice sees her own private + the public one, NOT bob's private one.
    expect(codex.online_runtime_count).toBe(2);
  });

  it("serves the fleet model catalog grouped by provider", async () => {
    const store = createStore();
    store.registerRuntime({
      id: "rt_fleet_claude_a",
      name: "fleet claude a",
      provider: "claude",
      workspaceId: "local",
      models: [
        { id: "claude-opus-4-8", label: "Opus 4.8", provider: "claude", default: true },
        { id: "claude-sonnet-5", label: "Sonnet 5", provider: "claude", default: false },
      ],
    });
    store.registerRuntime({
      id: "rt_fleet_claude_b",
      name: "fleet claude b",
      provider: "claude",
      workspaceId: "local",
      models: [{ id: "claude-sonnet-5", label: "Sonnet 5", provider: "claude", default: false }],
    });
    const offline = store.registerRuntime({
      id: "rt_fleet_codex",
      name: "fleet codex",
      provider: "codex",
      workspaceId: "local",
      models: [{ id: "gpt-5.2", label: "GPT-5.2", provider: "codex", default: true }],
    });
    db!.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", offline.id]);

    const app = createMultiremiApp({ store });
    const response = await app.request("/api/models");
    expect(response.status).toBe(200);
    const body = await response.json();
    const claude = body.providers.find((entry: any) => entry.provider === "claude");
    expect(claude.online_runtime_count).toBe(2);
    expect(claude.models.map((model: any) => model.id).sort()).toEqual(["claude-opus-4-8", "claude-sonnet-5"]);
    expect(claude.models.find((model: any) => model.id === "claude-opus-4-8").default).toBe(true);
    // Offline runtimes still surface their provider (capacity 0) but not a catalog.
    const codex = body.providers.find((entry: any) => entry.provider === "codex");
    expect(codex.online_runtime_count).toBe(0);
    expect(codex.models).toEqual([]);
  });

  it("claims runtime tasks atomically across sqlite connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "multiremi-task-claim-"));
    const path = join(dir, "multiremi.db");
    const dbA = new Database(path);
    const dbB = new Database(path);
    try {
      const storeA = new MultiremiStore(dbA);
      const storeB = new MultiremiStore(dbB);
      const runtime = storeA.registerRuntime({ id: "rt_atomic_claim", name: "atomic", provider: "codex", maxConcurrency: 1 });
      const agent = storeA.createAgent({ name: "Atomic Codex", provider: "codex" });
      const otherAgent = storeA.createAgent({ name: "Other Atomic Codex", provider: "codex" });
      const task = storeA.createTask({ agentId: agent.id, prompt: "claim exactly once" });
      const otherTask = storeA.createTask({ agentId: otherAgent.id, prompt: "wait for runtime capacity" });

      const first = storeA.claimTask(runtime.id);
      const second = storeB.claimTask(runtime.id);
      const claimedIds = [first?.id, second?.id].filter(Boolean);
      expect(claimedIds).toEqual([task.id]);
      expect(storeA.getTask(task.id)?.status).toBe("dispatched");
      expect(storeA.getTask(task.id)?.runtimeId).toBe(runtime.id);
      expect(storeA.getTask(otherTask.id)?.status).toBe("queued");
    } finally {
      dbA.close();
      dbB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists daemon pending tasks like Go runtime polling", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_pending_codex", name: "pending", provider: "codex", workspaceId: "local" });
    const otherRuntime = store.registerRuntime({ id: "rt_other_codex", name: "other", provider: "codex", workspaceId: "local" });
    const boundAgent = store.createAgent({ name: "Bound Codex", provider: "codex", runtimeId: runtime.id });
    const unboundAgent = store.createAgent({ name: "Unbound Codex", provider: "codex" });
    const otherBoundAgent = store.createAgent({ name: "Other Bound Codex", provider: "codex", runtimeId: otherRuntime.id });
    const issue = store.createIssue({ title: "Pending response parity", assigneeType: "agent", assigneeId: boundAgent.id });
    const high = store.createTask({ agentId: boundAgent.id, issueId: issue.id, workspaceId: "local", prompt: "high", priority: 100 });
    const sameOld = store.createTask({ agentId: boundAgent.id, workspaceId: "local", prompt: "same old", priority: 5 });
    const sameNew = store.createTask({ agentId: boundAgent.id, workspaceId: "local", prompt: "same new", priority: 5 });
    const low = store.createTask({ agentId: boundAgent.id, workspaceId: "local", prompt: "low", priority: 1 });
    const eligibleUnbound = store.createTask({ agentId: unboundAgent.id, workspaceId: "local", prompt: "eligible but unbound", priority: 99 });
    const otherBound = store.createTask({ agentId: otherBoundAgent.id, workspaceId: "local", prompt: "other runtime", priority: 20 });
    db!.run("UPDATE multiremi_tasks SET created_at = ?, updated_at = ? WHERE id = ?", [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      sameOld.id,
    ]);
    db!.run("UPDATE multiremi_tasks SET created_at = ?, updated_at = ? WHERE id = ?", [
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:01.000Z",
      sameNew.id,
    ]);

    expect(store.claimTask(runtime.id)?.id).toBe(high.id);

    const app = createMultiremiApp({ store });
    const pending = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    const pendingBody = await pending.json();
    expect(pendingBody.map((item: any) => item.id)).toEqual([high.id, sameOld.id, sameNew.id, low.id]);
    expect(pendingBody.map((item: any) => item.status)).toEqual(["dispatched", "queued", "queued", "queued"]);
    expect(Object.keys(pendingBody[0]).sort()).toEqual([
      "agent_id",
      "attempt",
      "completed_at",
      "created_at",
      "dispatched_at",
      "error",
      "id",
      "issue_id",
      "kind",
      "max_attempts",
      "priority",
      "result",
      "runtime_id",
      "started_at",
      "status",
      "workspace_id",
    ]);
    expect(pendingBody[0]).toMatchObject({
      id: high.id,
      agent_id: boundAgent.id,
      runtime_id: runtime.id,
      issue_id: issue.id,
      workspace_id: "local",
      status: "dispatched",
      priority: 100,
      started_at: null,
      completed_at: null,
      result: null,
      error: null,
      attempt: 1,
      max_attempts: 3,
      kind: "direct",
    });
    expect(pendingBody[0].dispatched_at).toBeString();
    expect(pendingBody[0].created_at).toBeString();
    expect(pendingBody[0]).not.toHaveProperty("agentId");
    expect(pendingBody[0]).not.toHaveProperty("runtimeId");
    expect(pendingBody[1].kind).toBe("quick_create");
    expect(pendingBody.some((item: any) => item.id === eligibleUnbound.id)).toBe(false);
    expect(pendingBody.some((item: any) => item.id === otherBound.id)).toBe(false);
  });

  it("serves daemon claim responses in Go wire shape and normalizes them for the Bun daemon", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_claim_shape", name: "claim shape", provider: "codex", workspaceId: "local", ownerId: "local", maxConcurrency: 2 });
    const agent = store.createAgent({
      id: "agt_claim_shape",
      name: "Claim Shape Codex",
      provider: "codex",
      runtimeId: runtime.id,
      instructions: "Keep the claim shape stable.",
      customEnv: { CLAIM_SECRET: "present" },
      customArgs: ["--fast"],
      allowedTools: ["Read"],
      model: "gpt-5",
      cwd: "/tmp/claim-shape",
    });
    const project = store.createProject({
      id: "prj_claim_shape",
      title: "Claim project",
      description: "Project context",
      resources: [{
        resourceType: "github_repo",
        resourceRef: { url: "https://github.com/example/claim-shape", defaultBranchHint: "main" },
        label: "primary",
      }, {
        resourceType: "local_directory",
        resourceRef: { localPath: "/tmp/claim-local", daemonId: "daemon-claim", label: "local" },
        label: "local",
      }],
    });
    const issue = store.createIssue({
      id: "iss_claim_shape",
      title: "Claim shape issue",
      description: "Issue context",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    store.setIssueMetadataKey(issue.id, "target", "daemon-claim");
    const secondIssue = store.createIssue({
      id: "iss_claim_shape_second",
      title: "Second claim shape issue",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    store.setIssueMetadataKey(secondIssue.id, "target", "daemon-claim");
    const first = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "First claim" });
    const second = store.createTask({ agentId: agent.id, issueId: secondIssue.id, prompt: "Second claim" });
    const app = createMultiremiApp({ store });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    const claimTask = (await claim.json()).task;
    expect(claimTask).toMatchObject({
      id: first.id,
      agent_id: agent.id,
      runtime_id: runtime.id,
      issue_id: issue.id,
      workspace_id: "local",
      status: "dispatched",
      prompt: "First claim",
      kind: "direct",
      agent: {
        id: agent.id,
        name: "Claim Shape Codex",
        provider: "codex",
        instructions: "Keep the claim shape stable.",
        custom_env: { CLAIM_SECRET: "present" },
        custom_args: ["--fast"],
        allowed_tools: ["Read"],
        model: "gpt-5",
        cwd: "/tmp/claim-shape",
        max_concurrent_tasks: 6,
      },
      issue: {
        id: issue.id,
        identifier: issue.key,
        workspace_id: "local",
        project_id: project.id,
        metadata: { target: "daemon-claim" },
      },
      project: {
        id: project.id,
        workspace_id: "local",
        title: "Claim project",
      },
      project_resources: [
        {
          resource_type: "github_repo",
          resource_ref: { url: "https://github.com/example/claim-shape", default_branch_hint: "main" },
        },
        {
          resource_type: "local_directory",
          resource_ref: { local_path: "/tmp/claim-local", daemon_id: "daemon-claim", label: "local" },
        },
      ],
      repos: [{ url: "https://github.com/example/claim-shape" }],
    });
    expect(claimTask.auth_token).toStartWith("mat_");
    const firstClaimToken = await store.verifyAccessToken(claimTask.auth_token);
    expect(firstClaimToken).toMatchObject({
      type: "task",
      taskId: first.id,
      agentId: agent.id,
      workspaceId: "local",
      userId: "local",
    });
    expect(store.listAccessTokens("local").some((token) => token.id === firstClaimToken?.id)).toBe(false);
    expect(claimTask.agentId).toBeUndefined();
    expect(claimTask.runtimeId).toBeUndefined();
    expect(claimTask.maxAttempts).toBeUndefined();
    expect(claimTask.authToken).toBeUndefined();
    expect(claimTask.projectResources).toBeUndefined();
    expect(claimTask.agent.customEnv).toBeUndefined();
    expect(claimTask.issue.workspaceId).toBeUndefined();
    expect(claimTask.project_resources[0].resourceRef).toBeUndefined();

    mockFetch((url, init) => {
      const parsed = new URL(url);
      return app.request(`${parsed.pathname}${parsed.search}`, init);
    });
    const client = new MultiremiDaemonClient("https://remi.example");
    const normalized = await client.claimTask(runtime.id);
    expect(normalized).toMatchObject({
      id: second.id,
      agentId: agent.id,
      runtimeId: runtime.id,
      issueId: secondIssue.id,
      workspaceId: "local",
      prompt: "Second claim",
      agent: {
        id: agent.id,
        customEnv: { CLAIM_SECRET: "present" },
        customArgs: ["--fast"],
        allowedTools: ["Read"],
        maxConcurrentTasks: 6,
      },
      issue: {
        id: secondIssue.id,
        workspaceId: "local",
        projectId: project.id,
        metadata: { target: "daemon-claim" },
      },
      project: {
        id: project.id,
        workspaceId: "local",
      },
      projectResources: [
        {
          resourceType: "github_repo",
          resourceRef: { url: "https://github.com/example/claim-shape", default_branch_hint: "main" },
        },
        {
          resourceType: "local_directory",
          resourceRef: { local_path: "/tmp/claim-local", daemon_id: "daemon-claim", label: "local" },
        },
      ],
      repos: [{ url: "https://github.com/example/claim-shape" }],
    });
    expect(normalized?.authToken).toStartWith("mat_");
  });

  it("serves daemon claim execution context for chat, autopilot, and quick-create", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateCurrentUser({
      name: "Local Alice",
      profileDescription: "Prefers concise updates with verification notes.",
    });
    store.updateWorkspace("local", { context: "Use the workspace TypeScript conventions." });
    const runtime = store.registerRuntime({
      id: "rt_claim_context",
      name: "claim context",
      provider: "claude",
      workspaceId: "local",
      ownerId: "local",
      maxConcurrency: 4,
    });
    const agent = store.createAgent({
      id: "agt_claim_context",
      name: "Claim Context Claude",
      provider: "claude",
      runtimeId: runtime.id,
    });
    const project = store.createProject({
      id: "prj_claim_context",
      title: "Claim Context Project",
      resources: [{
        resourceType: "github_repo",
        resourceRef: { url: "https://github.com/example/claim-context" },
      }],
    });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", title: "Claim chat context" });
    const firstChat = store.sendChatMessage(chat.id, { body: "Check Shanghai weather" });
    store.sendChatMessage(chat.id, { body: "and Qingdao too" });
    const autopilot = store.createAutopilot({
      id: "ap_claim_context",
      title: "Webhook triage",
      description: "Investigate incoming webhook",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    const run = store.runAutopilot(autopilot.id, {
      source: "webhook",
      payload: { repository: "remi", action: "push" },
    });
    const quick = store.quickCreateIssue({
      agentId: agent.id,
      projectId: project.id,
      prompt: "Create onboarding screenshot follow-up",
    });
    const app = createMultiremiApp({ store });

    const claimed: any[] = [];
    for (let index = 0; index < 3; index++) {
      const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
      expect(claim.status).toBe(200);
      claimed.push((await claim.json()).task);
    }
    const byId = new Map(claimed.map((task) => [task.id, task]));

    expect(byId.get(firstChat.task.id)).toMatchObject({
      id: firstChat.task.id,
      kind: "chat",
      chat_session_id: chat.id,
      chat_message: "Check Shanghai weather\n\nand Qingdao too",
      workspace_context: "Use the workspace TypeScript conventions.",
      requesting_user_name: "Local Alice",
      requesting_user_profile_description: "Prefers concise updates with verification notes.",
    });
    expect(byId.get(firstChat.task.id).chatMessage).toBeUndefined();

    expect(byId.get(run.taskId!)).toMatchObject({
      id: run.taskId,
      kind: "autopilot",
      autopilot_run_id: run.id,
      autopilot_id: autopilot.id,
      autopilot_source: "webhook",
      autopilot_title: "Webhook triage",
      autopilot_description: "Investigate incoming webhook",
      autopilot_trigger_payload: { repository: "remi", action: "push" },
    });
    expect(byId.get(run.taskId!).autopilotTitle).toBeUndefined();

    expect(byId.get(quick.task.id)).toMatchObject({
      id: quick.task.id,
      issue_id: quick.issue.id,
      project_id: project.id,
      quick_create_prompt: "Create onboarding screenshot follow-up",
    });
    expect(byId.get(quick.task.id).quickCreatePrompt).toBeUndefined();

    mockFetch(() => jsonResponse({
      task: {
        id: "tsk_norm_context",
        agent_id: agent.id,
        runtime_id: runtime.id,
        workspace_id: "local",
        status: "dispatched",
        priority: 0,
        prompt: "normalized context",
        attempt: 1,
        max_attempts: 3,
        result: null,
        error: null,
        created_at: "2026-01-01T00:00:00.000Z",
        kind: "chat",
        prior_session_id: "sess-prior",
        prior_work_dir: "/tmp/prior-work",
        chat_message: "Normalized chat",
        chat_message_attachments: [{ id: "att_1", filename: "brief.txt" }],
        autopilot_id: "ap_norm",
        autopilot_source: "webhook",
        autopilot_title: "Normalized autopilot",
        autopilot_description: "Normalized description",
        autopilot_trigger_payload: { ok: true },
        quick_create_prompt: "Normalized quick-create",
        workspace_context: "Normalized workspace context",
        requesting_user_name: "Normalized Alice",
        requesting_user_profile_description: "Normalized requester profile",
      },
    }));
    const normalized = await new MultiremiDaemonClient("https://remi.example").claimTask(runtime.id);
    expect(normalized).toMatchObject({
      id: "tsk_norm_context",
      agentId: agent.id,
      runtimeId: runtime.id,
      priorSessionId: "sess-prior",
      priorWorkDir: "/tmp/prior-work",
      chatMessage: "Normalized chat",
      chatMessageAttachments: [{ id: "att_1", filename: "brief.txt" }],
      autopilotId: "ap_norm",
      autopilotSource: "webhook",
      autopilotTitle: "Normalized autopilot",
      autopilotDescription: "Normalized description",
      autopilotTriggerPayload: { ok: true },
      quickCreatePrompt: "Normalized quick-create",
      workspaceContext: "Normalized workspace context",
      requestingUserName: "Normalized Alice",
      requestingUserProfileDescription: "Normalized requester profile",
    });
  });

  it("includes Go pending task optional chat, autopilot, and workdir fields", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_pending_optional", name: "pending optional", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Claude Runtime", provider: "claude", runtimeId: runtime.id });
    const workdirTask = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "workdir", priority: 50 });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", title: "Pending chat" });
    const chatTask = store.sendChatMessage(chat.id, { body: "continue the chat" }).task;
    const autopilot = store.createAutopilot({
      title: "Pending autopilot",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    const run = store.runAutopilot(autopilot.id);
    const autopilotTask = store.getTask(run.taskId!)!;

    expect(store.claimTask(runtime.id)?.id).toBe(workdirTask.id);
    store.pinTaskSession(workdirTask.id, "sess-workdir", "/Users/alice/src/remi");

    const app = createMultiremiApp({ store });
    const pending = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    const pendingBody = await pending.json();
    const byId = new Map(pendingBody.map((task: any) => [task.id, task]));

    expect(byId.get(workdirTask.id)).toMatchObject({
      id: workdirTask.id,
      status: "dispatched",
      kind: "quick_create",
      work_dir: "/Users/alice/src/remi",
      relative_work_dir: "src/remi",
    });
    expect(byId.get(chatTask.id)).toMatchObject({
      id: chatTask.id,
      chat_session_id: chat.id,
      kind: "chat",
      issue_id: "",
    });
    expect(byId.get(autopilotTask.id)).toMatchObject({
      id: autopilotTask.id,
      autopilot_run_id: run.id,
      kind: "autopilot",
      issue_id: "",
    });
  });

  it("matches Go relative_work_dir privacy edge cases", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_pending_workdir_edges", name: "pending workdir edges", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Claude Runtime", provider: "claude", runtimeId: runtime.id });
    const envTaskId = "12345678-aaaa-bbbb-cccc-123456789abc";
    const envShort = envTaskId.replaceAll("-", "").slice(0, 8);
    const envRoot = store.createTask({
      id: envTaskId,
      agentId: agent.id,
      workspaceId: "local",
      prompt: "env root",
      workDir: `/tmp/multiremi/local/${envShort}/worktree`,
      priority: 50,
    });
    const linuxHome = store.createTask({
      agentId: agent.id,
      workspaceId: "local",
      prompt: "linux home",
      workDir: "/home/alice",
      priority: 40,
    });
    const windowsHome = store.createTask({
      agentId: agent.id,
      workspaceId: "local",
      prompt: "windows home",
      workDir: "C:\\Users\\Alice\\src\\repo",
      priority: 30,
    });
    const unknownMount = store.createTask({
      agentId: agent.id,
      workspaceId: "local",
      prompt: "unknown mount",
      workDir: "/srv/shared/repo/",
      priority: 20,
    });
    const rootPath = store.createTask({
      agentId: agent.id,
      workspaceId: "local",
      prompt: "root path",
      workDir: "/",
      priority: 10,
    });

    const app = createMultiremiApp({ store });
    const pending = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    const pendingBody = await pending.json();
    const byId = new Map(pendingBody.map((task: any) => [task.id, task]));

    expect(byId.get(envRoot.id)).toMatchObject({
      work_dir: `/tmp/multiremi/local/${envShort}/worktree`,
      relative_work_dir: `local/${envShort}/worktree`,
    });
    expect(byId.get(linuxHome.id)).toMatchObject({
      work_dir: "/home/alice",
    });
    expect(byId.get(linuxHome.id)).not.toHaveProperty("relative_work_dir");
    expect(byId.get(windowsHome.id)).toMatchObject({
      work_dir: "C:\\Users\\Alice\\src\\repo",
      relative_work_dir: "src/repo",
    });
    expect(byId.get(unknownMount.id)).toMatchObject({
      work_dir: "/srv/shared/repo/",
      relative_work_dir: "repo",
    });
    expect(byId.get(rootPath.id)).toMatchObject({
      work_dir: "/",
    });
    expect(byId.get(rootPath.id)).not.toHaveProperty("relative_work_dir");
  });

  it("marks comment-triggered pending tasks like Go", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_pending_comment", name: "pending comment", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Comment Bot", provider: "claude", runtimeId: runtime.id });
    const member = store.createWorkspaceMember({ id: "mem_alice", name: "Alice Reviewer", workspaceId: "local" });
    const issue = store.createIssue({ title: "Comment trigger", workspaceId: "local" });
    const previous = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "previous run" });
    const previousStartedAt = "2025-01-01T00:00:00.000Z";
    expect(store.claimTask(runtime.id)?.id).toBe(previous.id);
    store.startTask(previous.id);
    db!.run("UPDATE multiremi_tasks SET started_at = ?, updated_at = ? WHERE id = ?", [previousStartedAt, previousStartedAt, previous.id]);
    store.completeTask(previous.id, { output: "done" });

    const root = store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: member.id,
      body: "Root discussion.",
    });
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: agent.id,
      body: "Agent's own follow-up should not count.",
    });
    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: member.id,
      body: "Another human follow-up.",
    });
    const body = `Please handle this [@Comment Bot](mention://agent/${agent.id}).`;
    const comment = store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: member.id,
      parentId: root.id,
      body,
    });
    const task = store.listTasks().find((item) => item.triggerCommentId === comment.id)!;

    expect(task.triggerCommentId).toBe(comment.id);
    expect(task.triggerSummary).toBe(body);

    const app = createMultiremiApp({ store });
    const pending = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    const pendingBody = await pending.json();

    expect(pendingBody).toHaveLength(1);
    expect(pendingBody[0]).toMatchObject({
      id: task.id,
      issue_id: issue.id,
      kind: "comment",
      trigger_comment_id: comment.id,
      trigger_summary: body,
      trigger_thread_id: root.id,
      trigger_comment_content: body,
      trigger_author_type: "member",
      trigger_author_name: "Alice Reviewer",
      new_comment_count: 2,
      new_comments_since: previousStartedAt,
    });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    const claimBody = await claim.json();
    expect(claimBody.task).toMatchObject({
      id: task.id,
      trigger_comment_id: comment.id,
      trigger_thread_id: root.id,
      trigger_comment_content: body,
      trigger_author_type: "member",
      trigger_author_name: "Alice Reviewer",
      new_comment_count: 2,
      new_comments_since: previousStartedAt,
    });
  });

  it("dispatches a task when an issue update assigns an agent (assign-on-update)", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_assign_update", name: "assign update", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Update Bot", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Assign later", workspaceId: "local" });
    const app = createMultiremiApp({ store });

    const res = await app.request(`/api/issues/${issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignee_type: "agent", assignee_id: agent.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("in_progress");

    const tasks = store.listTasks().filter((task) => task.issueId === issue.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agentId).toBe(agent.id);

    // Unrelated edits must not re-dispatch or cancel the running task.
    const rename = await app.request(`/api/issues/${issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Assign later (renamed)" }),
    });
    expect(rename.status).toBe(200);
    expect(store.listTasks().filter((task) => task.issueId === issue.id)).toHaveLength(1);
  });

  it("dispatches a task when an assigned backlog issue moves to an active status", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_backlog_update", name: "backlog update", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Backlog Bot", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({
      title: "Parked work",
      workspaceId: "local",
      status: "backlog",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    expect(store.listTasks().filter((task) => task.issueId === issue.id)).toHaveLength(0);
    const app = createMultiremiApp({ store });

    const res = await app.request(`/api/issues/${issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "todo" }),
    });
    expect(res.status).toBe(200);
    const tasks = store.listTasks().filter((task) => task.issueId === issue.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agentId).toBe(agent.id);

    // Closing a backlog issue must NOT wake the agent.
    const parked = store.createIssue({
      title: "Parked forever",
      workspaceId: "local",
      status: "backlog",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const close = await app.request(`/api/issues/${parked.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    expect(close.status).toBe(200);
    expect(store.listTasks().filter((task) => task.issueId === parked.id)).toHaveLength(0);
  });

  it("posts the agent's final reply as an issue comment on completion", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_reply_comment", name: "reply comment", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Reply Bot", provider: "claude", runtimeId: runtime.id });

    // Plain issue task: reply lands as a top-level agent comment.
    const issue = store.createIssue({ title: "总结项目", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "总结项目" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "Remi 是一个 AI 消息路由器。" });
    const comments = store.listIssueComments(issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      authorType: "agent",
      authorId: agent.id,
      body: "Remi 是一个 AI 消息路由器。",
      parentId: null,
    });

    // Comment-mention task: reply threads under the triggering comment.
    const trigger = store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "local",
      body: `[@Reply Bot](mention://agent/${agent.id}) 再说一遍`,
    });
    const mentionTask = store.listTasks().find((item) => item.triggerCommentId === trigger.id)!;
    expect(store.claimTask(runtime.id)?.id).toBe(mentionTask.id);
    store.startTask(mentionTask.id);
    store.completeTask(mentionTask.id, { output: "好的:是一个消息路由器。" });
    const reply = store.listIssueComments(issue.id).find((c) => c.parentId === trigger.id);
    expect(reply).toMatchObject({ authorType: "agent", body: "好的:是一个消息路由器。" });

    // Placeholder / empty outputs post nothing.
    const silent = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "quiet" });
    expect(store.claimTask(runtime.id)?.id).toBe(silent.id);
    store.startTask(silent.id);
    const before = store.listIssueComments(issue.id).length;
    store.completeTask(silent.id, { output: "Task completed." });
    expect(store.listIssueComments(issue.id)).toHaveLength(before);
  });

  it("accepts comments authored with a user id when the member row uses the mem_<ws>_<uid> convention", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_uid_comment", name: "uid comment", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Diagram Bot", provider: "claude", runtimeId: runtime.id });
    // Production shape: the request identity is a user id ("local"), while the
    // workspace member row is keyed mem_<ws>_<userId> with a user_id link.
    store.createWorkspaceMember({ id: "mem_local_local", userId: "local", name: "贺华杰", workspaceId: "local" });
    const issue = store.createIssue({ title: "架构图", workspaceId: "local", createdBy: "local" });

    const subscribersAfterCreate = store.listIssueSubscribers(issue.id);
    expect(subscribersAfterCreate.map((s) => s.userId)).toContain("mem_local_local");

    const body = `[@Diagram Bot](mention://agent/${agent.id}) 请开始`;
    const comment = store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "local",
      body,
    });

    expect(comment.body).toBe(body);
    const task = store.listTasks().find((item) => item.triggerCommentId === comment.id);
    expect(task?.agentId).toBe(agent.id);
  });

  it("cancels active tasks when their trigger comment changes or is deleted", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_trigger_cancel", name: "trigger cancel", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Comment Bot", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Trigger cancellation", workspaceId: "local" });

    const edited = store.createIssueComment(issue.id, {
      body: `Please inspect [@Comment Bot](mention://agent/${agent.id}).`,
    });
    const editedTask = store.listTasks().find((task) => task.triggerCommentId === edited.id)!;
    expect(store.getTask(editedTask.id)?.status).toBe("queued");

    store.updateIssueComment(edited.id, { body: "Changed request." });
    expect(store.getTask(editedTask.id)?.status).toBe("cancelled");

    const deleted = store.createIssueComment(issue.id, {
      body: `Please inspect this too [@Comment Bot](mention://agent/${agent.id}).`,
    });
    const deletedTask = store.listTasks().find((task) => task.triggerCommentId === deleted.id)!;
    expect(store.claimTask(runtime.id)?.id).toBe(deletedTask.id);

    store.deleteIssueComment(deleted.id);
    expect(store.getTask(deletedTask.id)?.status).toBe("cancelled");
  });

  it("serializes claim per agent issue and respects agent max concurrency", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex", maxConcurrentTasks: 2 });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex", maxConcurrency: 3 });
    const issueA = store.createIssue({ title: "Issue A", assigneeType: "agent", assigneeId: agent.id });
    const issueB = store.createIssue({ title: "Issue B", assigneeType: "agent", assigneeId: agent.id });
    const firstA = store.createTask({ agentId: agent.id, issueId: issueA.id, prompt: "A1" });
    const secondA = store.createTask({ agentId: agent.id, issueId: issueA.id, prompt: "A2" });
    const firstB = store.createTask({ agentId: agent.id, issueId: issueB.id, prompt: "B1" });

    expect(store.claimTask(runtime.id)?.id).toBe(firstA.id);
    expect(store.claimTask(runtime.id)?.id).toBe(firstB.id);
    expect(store.claimTask(runtime.id)).toBeNull();

    store.completeTask(firstA.id, { output: "done" });
    expect(store.claimTask(runtime.id)?.id).toBe(secondA.id);

    const cappedAgent = store.createAgent({ name: "Capped", provider: "codex", maxConcurrentTasks: 1 });
    const cappedFirst = store.createTask({ agentId: cappedAgent.id, prompt: "one" });
    const cappedSecond = store.createTask({ agentId: cappedAgent.id, prompt: "two" });
    expect(store.claimTask(runtime.id)?.id).toBe(cappedFirst.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.completeTask(cappedFirst.id, { output: "done" });
    expect(store.claimTask(runtime.id)?.id).toBe(cappedSecond.id);
  });

  it("reclaims stale dispatched tasks before applying runtime capacity", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex", maxConcurrency: 1 });
    const task = store.createTask({ agentId: agent.id, prompt: "Recover claim response" });

    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const stale = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ?, updated_at = ? WHERE id = ?", [stale, stale, task.id]);

    const reclaimed = store.claimTask(runtime.id);
    expect(reclaimed?.id).toBe(task.id);
    expect(Date.parse(store.getTask(task.id)!.dispatchedAt!)).toBeGreaterThan(Date.parse(stale));
  });

  it("tracks waiting_local_directory as an active in-flight state", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex", maxConcurrentTasks: 2 });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex", maxConcurrency: 2 });
    const issue = store.createIssue({ title: "Local directory lock", assigneeType: "agent", assigneeId: agent.id });
    const first = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "First" });
    const second = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Second" });

    expect(() => store.startTask(first.id)).toThrow("Task not found or not dispatched");
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    const waiting = store.markTaskWaitingLocalDirectory(first.id, "/tmp/worktree");
    expect(waiting.status).toBe("waiting_local_directory");
    expect(waiting.waitReason).toBe("/tmp/worktree");
    expect(store.getRuntime(runtime.id)!.activeTaskCount).toBe(1);
    expect(store.claimTask(runtime.id)).toBeNull();

    const running = store.startTask(first.id);
    expect(running.status).toBe("running");
    expect(running.waitReason).toBeNull();
    expect(() => store.startTask(first.id)).toThrow("Task not found or not dispatched");
    store.completeTask(first.id, { output: "done" });
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);
  });

  it("honors runtime max concurrency and derives stale liveness", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex", maxConcurrentTasks: 2 });
    const firstIssue = store.createIssue({ title: "First usage task", assigneeType: "agent", assigneeId: agent.id });
    const secondIssue = store.createIssue({ title: "Second usage task", assigneeType: "agent", assigneeId: agent.id });
    const first = store.createTask({ agentId: agent.id, issueId: firstIssue.id, prompt: "First" });
    const second = store.createTask({ agentId: agent.id, issueId: secondIssue.id, prompt: "Second" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex", maxConcurrency: 1 });

    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)).toBeNull();

    store.completeTask(first.id, { output: "done" });
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);

    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db!.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?", [stale, stale, runtime.id]);
    expect(store.listRuntimes()[0]?.status).toBe("offline");
  });

  it("tracks runtime ownership, visibility, and usage rollups", () => {
    const store = createStore();
    const member = store.createWorkspaceMember({ name: "Runtime owner", workspaceId: "local" });
    const agent = store.createAgent({ name: "Codex", provider: "codex", maxConcurrentTasks: 2 });
    const runtime = store.registerRuntime({
      name: "local-codex",
      provider: "codex",
      workspace_id: "local",
      owner_id: member.id,
      visibility: "public",
      max_concurrency: 2,
      runtime_mode: "local",
      device_info: "Laptop · 1.0.0",
      metadata: { version: "1.0.0", cli_version: "0.2.0", launched_by: "desktop" },
      models: [{ id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true }],
    });
    const firstIssue = store.createIssue({ title: "First usage task", assigneeType: "agent", assigneeId: agent.id });
    const secondIssue = store.createIssue({ title: "Second usage task", assigneeType: "agent", assigneeId: agent.id });
    const first = store.createTask({ agentId: agent.id, issueId: firstIssue.id, prompt: "First" });
    const second = store.createTask({ agentId: agent.id, issueId: secondIssue.id, prompt: "Second" });

    expect(runtime.ownerId).toBe(member.id);
    expect(runtime.runtimeMode).toBe("local");
    expect(runtime.deviceInfo).toBe("Laptop · 1.0.0");
    expect(runtime.metadata).toMatchObject({ version: "1.0.0", cli_version: "0.2.0", launched_by: "desktop" });
    expect(runtime.visibility).toBe("public");
    expect(runtime.maxConcurrency).toBe(2);
    expect(runtime.models[0].id).toBe("gpt-5.5");
    const reconnected = store.registerRuntime({
      id: runtime.id,
      name: "codex-owned-reconnect",
      provider: "codex",
      workspaceId: "local",
      ownerId: null,
    });
    expect(reconnected.ownerId).toBe(member.id);
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);
    store.startTask(first.id);
    store.reportTaskUsage(first.id, [
      { provider: "codex", model: "gpt-5", inputTokens: 100, outputTokens: 25, cacheReadTokens: 5 },
      { provider: "codex", model: "gpt-5", inputTokens: 40, outputTokens: 10, cacheWriteTokens: 3 },
    ]);
    store.reportTaskUsage(second.id, [
      { provider: "codex", model: "gpt-5-mini", inputTokens: 7, outputTokens: 2 },
    ]);
    store.completeTask(first.id, { output: "done" });

    const detailed = store.getRuntime(runtime.id)!;
    expect(detailed.taskCount).toBe(2);
    expect(detailed.activeTaskCount).toBe(1);
    expect(detailed.completedTaskCount).toBe(1);
    expect(detailed.inputTokens).toBe(47);
    expect(detailed.outputTokens).toBe(12);
    expect(detailed.cacheReadTokens).toBe(0);
    expect(detailed.cacheWriteTokens).toBe(3);

    const usage = store.listRuntimeUsage(runtime.id);
    expect(usage).toHaveLength(2);
    expect(usage.find((row) => row.model === "gpt-5")?.taskCount).toBe(1);
    expect(usage.find((row) => row.model === "gpt-5")?.inputTokens).toBe(40);

    const daily = store.listUsageDaily({ runtimeId: runtime.id });
    expect(daily.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(47);
    expect(store.listUsageByAgent({ runtimeId: runtime.id })[0]?.agentId).toBe(agent.id);
    expect(store.listUsageByHour({ runtimeId: runtime.id })[0]?.hour).toBeNumber();
    expect(store.listTaskActivityByHour({ runtimeId: runtime.id })).not.toHaveLength(0);
    expect(store.listRuntimeDaily({ runtimeId: runtime.id }).reduce((sum, row) => sum + row.taskCount, 0)).toBe(2);

    const updated = store.updateRuntime(runtime.id, {
      name: "codex-shared",
      ownerId: null,
      visibility: "private",
      maxConcurrency: 3,
      deviceInfo: "Laptop · 1.0.1",
      metadata: { version: "1.0.1", cli_version: "0.2.1", launched_by: "manual" },
    });
    expect(updated.name).toBe("codex-shared");
    expect(updated.ownerId).toBeNull();
    expect(updated.deviceInfo).toBe("Laptop · 1.0.1");
    expect(updated.metadata).toMatchObject({ version: "1.0.1", cli_version: "0.2.1", launched_by: "manual" });
    expect(updated.visibility).toBe("private");
    expect(updated.maxConcurrency).toBe(3);

    const models = store.updateRuntimeModels(runtime.id, [{
      id: "gpt-5.4",
      label: "GPT-5.4",
      provider: "openai",
      default: false,
      thinking: { supportedLevels: [{ value: "high", label: "High" }], defaultLevel: "high" },
    }]);
    expect(models[0].thinking?.supportedLevels[0].value).toBe("high");
  });

  it("records Go-style runtime lifecycle analytics and metrics", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_runtime_analytics",
      name: "Runtime analytics",
      provider: "codex",
      workspaceId: "local",
      ownerId: "usr_runtime",
      daemonId: "daemon-runtime",
      runtimeMode: "local",
      metadata: { version: "1.2.3", cli_version: "0.2.0" },
    });

    const registered = store.listAnalyticsEvents({ name: "runtime_registered" })[0]!;
    expect(registered.metricsOnly).toBe(true);
    expect(registered.distinctId).toBe("usr_runtime");
    expect(registered.workspaceId).toBe("local");
    expect(registered.properties).toMatchObject({
      runtime_id: runtime.id,
      daemon_id: "daemon-runtime",
      provider: "codex",
      runtime_mode: "local",
      runtime_version: "1.2.3",
      cli_version: "0.2.0",
      source: "manual",
      user_id: "usr_runtime",
      is_demo: false,
    });
    const ready = store.listAnalyticsEvents({ name: "runtime_ready" })[0]!;
    expect(ready.properties).toMatchObject({
      runtime_id: runtime.id,
      daemon_id: "daemon-runtime",
      provider: "codex",
      runtime_mode: "local",
      source: "manual",
      user_id: "usr_runtime",
      is_demo: false,
    });
    expect(ready.properties).not.toHaveProperty("ready_duration_ms");
    expect(metricValue(store, "multiremi_runtime_registered_total", { runtime_mode: "local", provider: "codex" })).toBe(1);
    expect(metricValue(store, "multiremi_runtime_ready_total", { runtime_mode: "local", provider: "codex" })).toBe(1);

    store.registerRuntime({
      id: runtime.id,
      name: "Runtime analytics reconnect",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-runtime",
      metadata: { version: "1.2.4", cli_version: "0.2.1" },
    });
    expect(store.listAnalyticsEvents({ name: "runtime_registered" })).toHaveLength(1);
    expect(store.listAnalyticsEvents({ name: "runtime_ready" })).toHaveLength(1);
    expect(metricValue(store, "multiremi_runtime_registered_total", { runtime_mode: "local", provider: "codex" })).toBe(1);

    const daemonTokenRuntime = store.registerRuntime({
      id: "rt_runtime_daemon_token",
      name: "Daemon token runtime",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-token-runtime",
      ownerId: null,
    });
    const daemonTokenRegistered = store.listAnalyticsEvents({ name: "runtime_registered" })
      .find((event) => event.properties.runtime_id === daemonTokenRuntime.id)!;
    expect(daemonTokenRegistered.distinctId).toBe("workspace:local");
    expect(daemonTokenRegistered.properties).not.toHaveProperty("user_id");
    expect(metricValue(store, "multiremi_runtime_registered_total", { runtime_mode: "local", provider: "claude" })).toBe(1);

    const offline = store.registerRuntime({
      id: "rt_runtime_offline_register",
      name: "Offline runtime",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-offline",
      status: "offline",
    });
    expect(offline.status).toBe("offline");
    expect(store.listAnalyticsEvents({ name: "runtime_registered" }).some((event) => event.properties.runtime_id === offline.id)).toBe(true);
    expect(store.listAnalyticsEvents({ name: "runtime_ready" }).some((event) => event.properties.runtime_id === offline.id)).toBe(false);

    store.setRuntimeOffline(runtime.id);
    store.setRuntimeOffline(runtime.id);
    const offlineEvent = store.listAnalyticsEvents({ name: "runtime_offline" })[0]!;
    expect(offlineEvent.properties).toMatchObject({
      runtime_id: runtime.id,
      daemon_id: "daemon-runtime",
      provider: "codex",
      runtime_mode: "local",
      source: "manual",
      user_id: "usr_runtime",
      is_demo: false,
    });
    expect(store.listAnalyticsEvents({ name: "runtime_offline" })).toHaveLength(1);
    expect(metricValue(store, "multiremi_runtime_offline_total", { runtime_mode: "local", provider: "codex" })).toBe(1);
    expect(store.listAnalyticsEvents({ includeMetricsOnly: false })).toEqual([]);
  });

  it("updates and archives agents from scheduling surfaces", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex", allowedTools: ["Read"] });
    const updated = store.updateAgent(agent.id, { name: "Codex Pro", allowedTools: ["Read", "Bash"] });
    expect(updated.name).toBe("Codex Pro");
    expect(updated.allowedTools).toHaveLength(2);

    const task = store.createTask({ agentId: agent.id, prompt: "Before archive" });
    expect(task.id).toStartWith("tsk_");
    expect(store.archiveAgent(agent.id).archivedAt).toBeString();
    expect(store.listAgents()).toHaveLength(0);
    expect(() => store.createTask({ agentId: agent.id, prompt: "After archive" })).toThrow("Agent is archived");

    const runtime = store.registerRuntime({ name: "codex-runtime", provider: "codex" });
    expect(store.claimTask(runtime.id)).toBeNull();

    const defaultAgent = store.ensureDefaultAgent("codex");
    store.archiveAgent(defaultAgent.id);
    expect(store.listAgents()).toHaveLength(0);
    expect(store.ensureDefaultAgent("codex").archivedAt).toBeNull();
  });

  it("manages workspace skills, attaches them to agents, and includes files in claims", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Reviewer", provider: "claude" });
    const skill = store.createSkill({
      id: "skl_review",
      workspaceId: "local",
      name: "Review Helper",
      description: "Review pull requests",
      content: "# Review Helper",
      config: { origin: { type: "local" } },
      files: [{ path: "templates/check.md", content: "Check list" }],
    });

    expect(store.listSkills("local")[0].content).toBe("# Review Helper");
    expect(store.listSkills("local", { includeFiles: true })[0].files?.[0].path).toBe("templates/check.md");

    const attached = store.setAgentSkills(agent.id, { skill_ids: [skill.id!] });
    expect(attached[0].name).toBe("Review Helper");
    expect(store.getAgent(agent.id)?.skills[0].files?.[0].content).toBe("Check list");

    const task = store.createTask({ agentId: agent.id, prompt: "Review this" });
    const runtime = store.registerRuntime({ name: "local", provider: "claude" });
    const claimed = store.claimTask(runtime.id);
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.agent?.skills[0].name).toBe("Review Helper");
    expect(claimed?.agent?.skills[0].files?.[0].path).toBe("templates/check.md");

    const updated = store.updateSkill(skill.id!, { name: "Review Helper", files: [{ path: "rules.md", content: "Rules" }] });
    expect(updated.files?.[0].path).toBe("rules.md");
    expect(() => store.updateSkill(skill.id!, { files: [{ path: "../../../escape.md", content: "" }] })).toThrow();

    store.archiveSkill(skill.id!);
    expect(store.listAgentSkills(agent.id)).toHaveLength(0);
  });

  it("manages workspace members and squad membership", () => {
    const store = createStore();
    const squad = store.createSquad({ name: "Product squad" });
    const member = store.createWorkspaceMember({ name: "Ada Lovelace", email: "ada@example.com", role: "owner" });

    expect(store.listWorkspaceMembers()).toHaveLength(1);
    expect(() => store.updateWorkspaceMember(member.id, { role: "reviewer" })).toThrow("workspace must have at least one owner");
    expect(() => store.archiveWorkspaceMember(member.id)).toThrow("workspace must have at least one owner");
    const backupOwner = store.createWorkspaceMember({ name: "Backup Owner", email: "backup@example.com", role: "owner" });
    expect(store.updateWorkspaceMember(member.id, { role: "reviewer" }).role).toBe("reviewer");
    expect(store.addSquadMember(squad.id, { memberType: "member", memberId: member.id, role: "reviewer" }).memberType).toBe("member");
    expect(store.listSquadMembers(squad.id)[0]?.memberId).toBe(member.id);

    expect(store.archiveWorkspaceMember(member.id).archivedAt).toBeString();
    expect(store.listWorkspaceMembers()).toHaveLength(1);
    expect(() => store.archiveWorkspaceMember(backupOwner.id)).toThrow("workspace must have at least one owner");
    expect(() => store.addSquadMember(squad.id, { memberType: "member", memberId: member.id })).toThrow("Member is archived");
  });

  it("assigns issues to members, agents, and squads", () => {
    const store = createStore();
    const codex = store.createAgent({ name: "Codex", provider: "codex" });
    const leader = store.createAgent({ name: "Squad lead", provider: "claude" });
    const member = store.createWorkspaceMember({ name: "Human reviewer", email: "human@example.com", role: "member" });
    const squad = store.createSquad({ name: "Feature squad", leaderId: leader.id });
    const issue = store.createIssue({ title: "Implement assignment" });

    const memberAssigned = store.assignIssue(issue.id, { assigneeType: "member", assigneeId: member.id });
    expect(memberAssigned.issue.assigneeType).toBe("member");
    expect(memberAssigned.task).toBeNull();

    const agentAssigned = store.assignIssue(issue.id, { assigneeType: "agent", assigneeId: codex.id, prompt: "Run codex" });
    expect(agentAssigned.issue.assigneeType).toBe("agent");
    expect(agentAssigned.task?.agentId).toBe(codex.id);
    expect(agentAssigned.task?.prompt).toBe("Run codex");

    const squadAssigned = store.assignIssue(issue.id, { assigneeType: "squad", assigneeId: squad.id });
    expect(squadAssigned.issue.assigneeId).toBe(squad.id);
    expect(squadAssigned.task?.agentId).toBe(leader.id);
    expect(store.getTask(agentAssigned.task!.id)?.status).toBe("cancelled");

    const fuzzyIssue = store.createIssue({ title: "Assign by fuzzy refs", assigneeId: "human@example.com" });
    expect(fuzzyIssue.assigneeType).toBe("member");
    expect(fuzzyIssue.assigneeId).toBe(member.id);
    const fuzzyAgent = store.assignIssue(fuzzyIssue.id, { assigneeId: "cod", prompt: "Run fuzzy Codex" });
    expect(fuzzyAgent.issue.assigneeType).toBe("agent");
    expect(fuzzyAgent.issue.assigneeId).toBe(codex.id);
    expect(fuzzyAgent.task?.agentId).toBe(codex.id);
    const fuzzySquad = store.assignIssue(fuzzyIssue.id, { assigneeId: "feature" });
    expect(fuzzySquad.issue.assigneeType).toBe("squad");
    expect(fuzzySquad.issue.assigneeId).toBe(squad.id);
    expect(fuzzySquad.task?.agentId).toBe(leader.id);
    const quick = store.quickCreateIssue({ agentId: "codex", prompt: "Fuzzy quick create" });
    expect(quick.issue.assigneeId).toBe(codex.id);
    expect(quick.task.agentId).toBe(codex.id);

    const unassigned = store.assignIssue(issue.id, {});
    expect(unassigned.issue.assigneeType).toBeNull();
    expect(unassigned.task).toBeNull();
    expect(store.getTask(squadAssigned.task!.id)?.status).toBe("cancelled");
  });

  it("aggregates assignee frequency from created issues and assignment activity", () => {
    const store = createStore();
    const alice = store.createWorkspaceMember({ name: "Alice", role: "member" });
    const bob = store.createWorkspaceMember({ name: "Bob", role: "member" });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const created = store.createIssue({
      title: "Created with assignee",
      createdBy: alice.id,
      assigneeType: "member",
      assigneeId: bob.id,
    });
    const reassigned = store.createIssue({ title: "Reassigned later", createdBy: alice.id });

    store.assignIssue(reassigned.id, {
      assignee_type: "member",
      assignee_id: bob.id,
      actorType: "member",
      actorId: alice.id,
    });
    store.assignIssue(created.id, {
      assigneeType: "agent",
      assigneeId: agent.id,
      actor_type: "member",
      actor_id: alice.id,
    });

    const frequency = store.listAssigneeFrequency({ memberId: alice.id });

    expect(frequency.find((entry) => entry.assigneeId === bob.id)).toMatchObject({
      assigneeType: "member",
      assignee_type: "member",
      assigneeId: bob.id,
      assignee_id: bob.id,
      frequency: 2,
    });
    expect(frequency.find((entry) => entry.assigneeId === agent.id)?.frequency).toBe(2);
  });

  it("assigns human-readable issue keys per workspace", () => {
    const store = createStore();
    const first = store.createIssue({ title: "First issue" });
    const second = store.createIssue({ title: "Second issue" });
    const legacyOpen = store.createIssue({ title: "Legacy open input", status: "open" });

    expect(first.key).toBe("MUL-1");
    expect(first.number).toBe(1);
    expect(second.key).toBe("MUL-2");
    expect(first.status).toBe("todo");
    expect(legacyOpen.status).toBe("todo");
  });

  it("links GitHub pull requests by issue key and closes merged issues", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Implement GitHub linking" });

    const pullRequest = store.upsertGitHubPullRequest({
      repoOwner: "example",
      repoName: "remi",
      number: 17,
      title: `${issue.key} add linked pull request sidebar`,
      branch: `feature/${issue.key}-github-links`,
      state: "open",
      checksConclusion: "pending",
      checksPending: 1,
      additions: 12,
      deletions: 3,
      changedFiles: 2,
    });

    expect(pullRequest.issueId).toBe(issue.id);
    expect(pullRequest.htmlUrl).toBe("https://github.com/example/remi/pull/17");
    expect(store.listGitHubPullRequests({ issueId: issue.id })[0]?.number).toBe(17);

    const merged = store.upsertGitHubPullRequest({
      repoOwner: "example",
      repoName: "remi",
      number: 17,
      title: `${issue.key} add linked pull request sidebar`,
      branch: `feature/${issue.key}-github-links`,
      state: "merged",
      checksConclusion: "passed",
      checksPassed: 4,
      mergedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(merged.id).toBe(pullRequest.id);
    expect(store.getIssue(issue.id)?.status).toBe("done");

    store.updateGitHubSettings({ enabled: false });
    const ignoredIssue = store.createIssue({ title: "Disabled GitHub linking" });
    const ignored = store.upsertGitHubPullRequest({
      repoOwner: "example",
      repoName: "remi",
      number: 18,
      title: `${ignoredIssue.key} should not auto-link`,
    });
    expect(ignored.issueId).toBeNull();
  });

  it("manages issue hierarchy, priority, scheduling, and planning fields", () => {
    const store = createStore();
    const project = store.createProject({ title: "Hierarchy project" });
    const parent = store.createIssue({
      title: "Parent issue",
      projectId: project.id,
      priority: "high",
      dueDate: "2026-06-10T12:00:00+08:00",
      acceptanceCriteria: ["parent done"],
      contextRefs: [{ type: "doc", url: "https://example.com/spec" }],
    });
    const child = store.createIssue({
      title: "Child issue",
      parent_issue_id: parent.id,
      position: 2.5,
      start_date: "2026-06-04T09:00:00+08:00",
    });

    expect(parent.priority).toBe("high");
    expect(parent.dueDate).toBe("2026-06-10T04:00:00.000Z");
    expect(parent.acceptanceCriteria).toEqual(["parent done"]);
    expect(parent.contextRefs[0]).toEqual({ type: "doc", url: "https://example.com/spec" });
    expect(child.parentIssueId).toBe(parent.id);
    expect(child.projectId).toBe(project.id);
    expect(child.position).toBe(2.5);
    expect(store.listChildIssues(parent.id).map((item) => item.id)).toEqual([child.id]);
    expect(store.getIssueWithTasks(parent.id)?.children[0]?.id).toBe(child.id);

    store.updateIssue(child.id, { status: "done" });
    expect(store.getChildIssueProgress(parent.id)).toEqual({ parentIssueId: parent.id, total: 1, done: 1 });
    expect(store.listChildIssueProgress("local")).toEqual([{ parentIssueId: parent.id, total: 1, done: 1 }]);

    const sibling = store.createIssue({ title: "Sibling", parentIssueId: parent.id, priority: "urgent", position: 1 });
    expect(store.listChildIssues(parent.id).map((item) => item.id)).toEqual([sibling.id, child.id]);

    expect(() => store.updateIssue(parent.id, { parentIssueId: child.id })).toThrow("Circular parent");
    expect(() => store.updateIssue(parent.id, { parentIssueId: parent.id })).toThrow("own parent");
    expect(() => store.createIssue({ title: "Bad priority", priority: "must" })).toThrow("priority");

    const remoteParent = store.createIssue({ title: "Remote parent", workspaceId: "remote" });
    expect(() => store.createIssue({ title: "Cross workspace", parentIssueId: remoteParent.id, workspaceId: "local" })).toThrow("another workspace");
  });

  it("posts Go-style system comments when child issues transition to done", () => {
    const store = createStore();
    const parent = store.createIssue({ title: "Child-done parent", status: "in_progress" });
    const child = store.createIssue({
      title: "Child with [@spoof](mention://agent/agt_spoof)",
      parentIssueId: parent.id,
      status: "in_progress",
    });

    store.updateIssue(child.id, { status: "done" });
    let comments = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.type).toBe("system");
    expect(comments[0]?.authorId).toBe("00000000-0000-0000-0000-000000000000");
    expect(comments[0]?.parentId).toBeNull();
    expect(comments[0]?.body).toContain(child.key);
    expect(comments[0]?.body).toContain(`mention://issue/${child.id}`);
    expect(comments[0]?.body).not.toContain("mention://agent/agt_spoof");
    expect(comments[0]?.body).not.toContain("mention://member/");
    expect(comments[0]?.body).not.toContain("mention://squad/");

    store.updateIssue(child.id, { status: "done" });
    comments = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system");
    expect(comments).toHaveLength(1);

    store.updateIssue(child.id, { status: "in_progress" });
    store.updateIssue(child.id, { status: "done" });
    comments = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system");
    expect(comments).toHaveLength(2);

    const doneParent = store.createIssue({ title: "Already done parent", status: "done" });
    const doneChild = store.createIssue({ title: "Done child", parentIssueId: doneParent.id, status: "in_progress" });
    store.updateIssue(doneChild.id, { status: "done" });
    expect(store.listIssueComments(doneParent.id).filter((comment) => comment.authorType === "system")).toHaveLength(0);
  });

  it("triggers parent assignee tasks for child-done system comments", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Parent] Agent", provider: "codex" });
    const parent = store.createIssue({
      title: "Agent parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const child = store.createIssue({
      title: "Agent child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    store.updateIssue(child.id, { status: "done" });
    const comments = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(`mention://agent/${agent.id}`);
    expect(comments[0]?.body).toContain("@Parent Agent");
    const tasks = store.listTasksForIssue(parent.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.agentId).toBe(agent.id);
    expect(tasks[0]?.triggerCommentId).toBe(comments[0]?.id);
    expect(tasks[0]?.prompt).toContain("A sub-issue assigned under this issue was marked done.");

    const member = store.createWorkspaceMember({ name: "Human parent", role: "member" });
    const memberParent = store.createIssue({
      title: "Member parent",
      status: "in_progress",
      assigneeType: "member",
      assigneeId: member.id,
    });
    const memberChild = store.createIssue({ title: "Member child", parentIssueId: memberParent.id, status: "in_progress" });
    store.updateIssue(memberChild.id, { status: "done" });
    expect(store.listIssueComments(memberParent.id).filter((comment) => comment.authorType === "system")).toHaveLength(0);

    const leader = store.createAgent({ name: "Squad leader", provider: "claude" });
    const squad = store.createSquad({ name: "Parent Squad", leaderId: leader.id });
    const squadParent = store.createIssue({
      title: "Squad parent",
      status: "in_progress",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const squadChild = store.createIssue({ title: "Squad child", parentIssueId: squadParent.id, status: "in_progress" });
    store.updateIssue(squadChild.id, { status: "done" });
    const squadComments = store.listIssueComments(squadParent.id).filter((comment) => comment.authorType === "system");
    expect(squadComments).toHaveLength(1);
    expect(squadComments[0]?.body).toContain(`mention://squad/${squad.id}`);
    expect(store.listTasksForIssue(squadParent.id).map((task) => task.agentId)).toEqual([leader.id]);

    const guardedParent = store.createIssue({
      title: "Same squad parent",
      status: "in_progress",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const guardedChild = store.createIssue({
      title: "Same squad child",
      parentIssueId: guardedParent.id,
      status: "in_progress",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    store.updateIssue(guardedChild.id, { status: "done" });
    expect(store.listIssueComments(guardedParent.id).filter((comment) => comment.authorType === "system")).toHaveLength(1);
    expect(store.listTasksForIssue(guardedParent.id)).toHaveLength(0);
  });

  it("manages issue dependencies with workspace and duplicate guards", () => {
    const store = createStore();
    const blocker = store.createIssue({ title: "Blocker" });
    const blocked = store.createIssue({ title: "Blocked" });

    const dependency = store.createIssueDependency(blocked.id, {
      depends_on_issue_id: blocker.id,
      type: "blocked_by",
    });
    expect(dependency.issueId).toBe(blocked.id);
    expect(dependency.dependsOnIssueId).toBe(blocker.id);
    expect(dependency.type).toBe("blocked_by");
    expect(dependency.issue?.title).toBe("Blocked");
    expect(dependency.dependsOnIssue?.title).toBe("Blocker");
    expect(store.listIssueDependencies(blocked.id)).toHaveLength(1);
    expect(store.listIssueDependencies(blocker.id)).toHaveLength(1);

    const duplicate = store.createIssueDependency(blocked.id, {
      dependsOnIssueId: blocker.id,
      type: "blocked_by",
    });
    expect(duplicate.id).toBe(dependency.id);
    expect(store.listIssueDependencies(blocked.id)).toHaveLength(1);

    expect(() => store.createIssueDependency(blocked.id, { dependsOnIssueId: blocked.id })).toThrow("itself");
    const remote = store.createIssue({ title: "Remote", workspaceId: "remote" });
    expect(() => store.createIssueDependency(blocked.id, { dependsOnIssueId: remote.id })).toThrow("within a workspace");
    expect(() => store.createIssueDependency(blocked.id, { dependsOnIssueId: blocker.id, type: "must" })).toThrow("dependency type");

    store.deleteIssueDependency(blocked.id, dependency.id);
    expect(store.listIssueDependencies(blocked.id)).toEqual([]);
  });

  it("queues comment mentions without changing issue assignee", () => {
    const store = createStore();
    const reviewer = store.createAgent({ name: "Review Bot", provider: "codex" });
    const leader = store.createAgent({ name: "Squad Lead", provider: "claude" });
    const squad = store.createSquad({ name: "Frontend Squad", leaderId: leader.id });
    const issue = store.createIssue({ title: "Mention routing" });

    store.createIssueComment(issue.id, {
      body: `Please inspect this [@Review Bot](mention://agent/${reviewer.id}) and @Frontend Squad`,
    });

    const tasks = store.listTasks();
    expect(tasks.map((task) => task.agentId).sort()).toEqual([leader.id, reviewer.id].sort());
    expect(store.getIssue(issue.id)?.assigneeId).toBeNull();
    expect(store.getIssue(issue.id)?.status).toBe("todo");
    expect(store.listIssueActivity(issue.id).filter((item) => item.type === "comment_mention_triggered")).toHaveLength(2);
  });

  it("notifies subscribed members through inbox items", () => {
    const store = createStore();
    const alice = store.createWorkspaceMember({ name: "Alice Reviewer" });
    const bob = store.createWorkspaceMember({ name: "Bob Approver" });
    const carol = store.createWorkspaceMember({ name: "Carol Owner" });
    const issue = store.createIssue({ title: "Notify people", createdBy: alice.id });

    expect(store.listIssueSubscribers(issue.id).map((subscriber) => subscriber.memberId)).toEqual([alice.id]);

    store.assignIssue(issue.id, { assigneeType: "member", assigneeId: bob.id });
    expect(store.listInboxItems(bob.id).some((item) => item.type === "issue_assigned")).toBe(true);

    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: carol.id,
      body: `Please review [@Bob Approver](mention://member/${bob.id}) and @Alice Reviewer`,
    });

    expect(store.listIssueSubscribers(issue.id).map((subscriber) => subscriber.memberId).sort()).toEqual([
      alice.id,
      bob.id,
      carol.id,
    ].sort());
    expect(store.listInboxItems(bob.id).filter((item) => item.type === "comment_mention")).toHaveLength(1);
    expect(store.listInboxItems(bob.id).filter((item) => item.type === "comment_created")).toHaveLength(0);
    expect(store.listInboxItems(alice.id).some((item) => item.type === "comment_mention")).toBe(true);

    const item = store.listInboxItems(bob.id)[0]!;
    expect(store.markInboxItemRead(item.id).read).toBe(true);
    expect(store.archiveInboxItem(item.id).archived).toBe(true);
    expect(store.listInboxItems(bob.id).some((inboxItem) => inboxItem.id === item.id)).toBe(false);
  });

  it("honors notification preferences when creating inbox items", () => {
    const store = createStore();
    const bob = store.createWorkspaceMember({ name: "Bob Approver" });
    const issue = store.createIssue({ title: "Quiet assignment" });

    store.updateNotificationPreferences({
      preferences: { assignments: "muted" },
    });
    store.assignIssue(issue.id, { assigneeType: "member", assigneeId: bob.id });

    expect(store.getNotificationPreferences().preferences.assignments).toBe("muted");
    expect(store.listInboxItems(bob.id).filter((item) => item.type === "issue_assigned")).toHaveLength(0);
  });

  it("tracks comment threads, reactions, and attachments", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Collaborate with context" });
    const issueAttachment = store.createAttachment({
      issueId: issue.id,
      uploaderType: "member",
      uploaderId: "local",
      filename: "spec.md",
      url: "https://example.com/spec.md",
      contentType: "text/markdown",
      sizeBytes: 42,
    });
    const root = store.createIssueComment(issue.id, { body: "Root question" });
    const replyAttachment = store.createAttachment({
      uploaderType: "member",
      uploaderId: "local",
      filename: "reply.txt",
      url: "https://example.com/reply.txt",
      contentType: "text/plain",
      sizeBytes: 12,
    });
    const reply = store.createIssueComment(issue.id, {
      body: "Thread reply",
      parentId: root.id,
      attachmentIds: [replyAttachment.id],
    });

    expect(reply.parentId).toBe(root.id);
    expect(store.listAttachmentsForIssue(issue.id)[0]?.id).toBe(issueAttachment.id);
    expect(store.listAttachmentsForComment(reply.id)[0]?.id).toBe(replyAttachment.id);

    expect(store.addIssueReaction(issue.id, { actorType: "member", actorId: "local", emoji: "👍" }).emoji).toBe("👍");
    store.addIssueReaction(issue.id, { actorType: "member", actorId: "local", emoji: "👍" });
    expect(store.listIssueReactions(issue.id)).toHaveLength(1);

    expect(store.addCommentReaction(reply.id, { actorType: "agent", actorId: "agt-test", emoji: "👀" }).emoji).toBe("👀");
    expect(store.getIssueWithTasks(issue.id)?.reactions).toHaveLength(1);
    expect(store.listIssueComments(issue.id).find((comment) => comment.id === reply.id)?.attachments).toHaveLength(1);
    expect(store.listIssueComments(issue.id).find((comment) => comment.id === reply.id)?.reactions).toHaveLength(1);
  });

  it("serves Go-style issue comment list windows and cursors", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Long discussion" });
    const base = Date.parse("2025-01-01T00:00:00.000Z");
    const stamp = (id: string, minutes: number) => {
      const at = new Date(base + minutes * 60_000).toISOString();
      (store as any).db.run("UPDATE multiremi_issue_comments SET created_at = ?, updated_at = ? WHERE id = ?", [at, at, id]);
      return at;
    };
    const root1 = store.createIssueComment(issue.id, { body: "x".repeat(500) });
    const r1a = store.createIssueComment(issue.id, { body: "r1a", parentId: root1.id });
    const r1b = store.createIssueComment(issue.id, { body: "r1b", parentId: root1.id });
    const r1b1 = store.createIssueComment(issue.id, { body: "r1b1", parentId: r1b.id });
    const root2 = store.createIssueComment(issue.id, { body: "root2" });
    const r2a = store.createIssueComment(issue.id, { body: "r2a", parentId: root2.id });
    const r2b = store.createIssueComment(issue.id, { body: "r2b", parentId: root2.id });
    stamp(root1.id, 0);
    stamp(r1a.id, 1);
    stamp(r1b.id, 2);
    stamp(r1b1.id, 3);
    stamp(root2.id, 10);
    stamp(r2a.id, 11);
    stamp(r2b.id, 12);

    const ids = (rows: any[]) => rows.map((comment) => comment.id);
    const getComments = async (query: string) => {
      const response = await app.request(`/api/issues/${issue.id}/comments${query ? `?${query}` : ""}`);
      return { response, rows: await response.json() as any[] };
    };

    const roots = await getComments("roots_only=true&summary=true");
    expect(ids(roots.rows)).toEqual([root1.id, root2.id]);
    expect(roots.rows[0].reply_count).toBe(3);
    expect(roots.rows[0].last_activity_at).toBe("2025-01-01T00:03:00.000Z");
    expect(roots.rows[0].content_truncated).toBe(true);
    expect(roots.rows[0].content.endsWith("…")).toBe(true);
    expect(roots.rows[0].body).toBeUndefined();
    expect(roots.rows[0].parentId).toBeUndefined();

    const nestedThread = await getComments(`thread=${encodeURIComponent(r1b1.id)}`);
    expect(ids(nestedThread.rows)).toEqual([root1.id, r1a.id, r1b.id, r1b1.id]);

    const recent = await getComments("recent=1");
    expect(ids(recent.rows)).toEqual([root2.id, r2a.id, r2b.id]);
    expect(recent.response.headers.get("X-Multiremi-Next-Before-Id")).toBe(root2.id);
    expect(recent.response.headers.get("X-Multimira-Next-Before-Id")).toBeNull();
    const nextThread = new URLSearchParams({
      recent: "1",
      before: recent.response.headers.get("X-Multiremi-Next-Before")!,
      before_id: recent.response.headers.get("X-Multiremi-Next-Before-Id")!,
    });
    const olderThread = await getComments(nextThread.toString());
    expect(ids(olderThread.rows)).toEqual([root1.id, r1a.id, r1b.id, r1b1.id]);

    const tail = await getComments(`thread=${encodeURIComponent(root1.id)}&tail=1`);
    expect(ids(tail.rows)).toEqual([root1.id, r1b1.id]);
    expect(tail.response.headers.get("X-Multiremi-Next-Before-Id")).toBe(r1b1.id);
    expect(tail.response.headers.get("X-Multimira-Next-Before-Id")).toBeNull();
    const nextReply = new URLSearchParams({
      thread: root1.id,
      tail: "1",
      before: tail.response.headers.get("X-Multiremi-Next-Before")!,
      before_id: tail.response.headers.get("X-Multiremi-Next-Before-Id")!,
    });
    const olderReply = await getComments(nextReply.toString());
    expect(ids(olderReply.rows)).toEqual([root1.id, r1b.id]);

    const invalid = await app.request(`/api/issues/${issue.id}/comments?roots_only=true&thread=${root1.id}`);
    expect(invalid.status).toBe(400);
  });

  it("updates, deletes, resolves, and reopens comment threads", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Comment lifecycle" });
    const root = store.createIssueComment(issue.id, { body: "Root thread" });
    const reply = store.createIssueComment(issue.id, { body: "Reply", parentId: root.id });

    const updated = store.updateIssueComment(reply.id, { content: "Edited reply" });
    expect(updated.body).toBe("Edited reply");
    expect(store.listIssueActivity(issue.id).some((item) => item.type === "comment_updated")).toBe(true);

    const resolved = store.resolveIssueComment(root.id, { actorType: "member", actorId: "local" });
    expect(resolved.resolvedAt).toBeString();
    expect(resolved.resolvedByType).toBe("member");
    expect(() => store.resolveIssueComment(reply.id)).toThrow("Only root comments");

    const reopenedReply = store.createIssueComment(issue.id, { body: "Reopen thread", parentId: root.id });
    expect(reopenedReply.parentId).toBe(root.id);
    expect(store.getIssueComment(root.id)?.resolvedAt).toBeNull();

    const resolvedAgain = store.resolveIssueComment(root.id);
    expect(resolvedAgain.resolvedAt).toBeString();
    expect(store.unresolveIssueComment(root.id).resolvedAt).toBeNull();

    store.deleteIssueComment(root.id);
    expect(store.getIssueComment(root.id)).toBeNull();
    expect(store.getIssueComment(reply.id)).toBeNull();
    expect(store.getIssueComment(reopenedReply.id)).toBeNull();
    expect(store.listIssueActivity(issue.id).some((item) => item.type === "comment_deleted")).toBe(true);
  });

  it("manages issue labels with workspace scoping", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Needs labels", workspaceId: "local" });
    const label = store.createLabel({ name: "Bug", color: "FF3333", workspaceId: "local" });

    expect(label.color).toBe("#ff3333");
    expect(store.listLabels("local").map((item) => item.name)).toEqual(["Bug"]);
    expect(() => store.createLabel({ name: "bug", color: "#00ff00", workspaceId: "local" })).toThrow("Label already exists");
    expect(() => store.createLabel({ name: "bad-color", color: "red", workspaceId: "local" })).toThrow("6-digit hex");

    expect(store.attachLabelToIssue(issue.id, label.id).map((item) => item.id)).toEqual([label.id]);
    store.attachLabelToIssue(issue.id, label.id);
    expect(store.listLabelsForIssue(issue.id)).toHaveLength(1);
    expect(store.getIssue(issue.id)?.labels[0]?.name).toBe("Bug");
    expect(store.listIssues()[0]?.labels[0]?.color).toBe("#ff3333");

    const updated = store.updateLabel(label.id, { name: "Regression", color: "#22AA66" });
    expect(updated.color).toBe("#22aa66");
    expect(store.getIssueWithTasks(issue.id)?.labels[0]?.name).toBe("Regression");

    const otherWorkspaceLabel = store.createLabel({ name: "Remote", color: "#111111", workspaceId: "remote" });
    expect(() => store.attachLabelToIssue(issue.id, otherWorkspaceLabel.id)).toThrow("another workspace");

    expect(store.detachLabelFromIssue(issue.id, label.id)).toEqual([]);
    store.deleteLabel(label.id);
    expect(store.listLabelsForIssue(issue.id)).toEqual([]);
  });

  it("manages pinned issue and project shortcuts", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Pinned issue", workspaceId: "local" });
    const project = store.createProject({ title: "Pinned project", workspaceId: "local" });

    const issuePin = store.createPinnedItem({ itemType: "issue", itemId: issue.id, workspaceId: "local", userId: "local" });
    const projectPin = store.createPinnedItem({ item_type: "project", item_id: project.id, workspace_id: "local", user_id: "local" });

    expect(issuePin.position).toBe(1);
    expect(projectPin.position).toBe(2);
    expect(store.listPinnedItems("local", "local").map((pin) => pin.itemType)).toEqual(["issue", "project"]);
    expect(() => store.createPinnedItem({ itemType: "issue", itemId: issue.id })).toThrow("already pinned");
    expect(() => store.createPinnedItem({ itemType: "issue", itemId: issue.id, workspaceId: "remote" })).toThrow("Issue not found");
    expect(() => store.createPinnedItem({ itemType: "agent", itemId: issue.id })).toThrow("item_type");

    const reordered = store.reorderPinnedItems("local", "local", [
      { id: issuePin.id, position: 20 },
      { id: projectPin.id, position: 10 },
    ]);
    expect(reordered.map((pin) => pin.id)).toEqual([projectPin.id, issuePin.id]);

    store.deletePinnedItem("local", "local", "project", project.id);
    expect(store.listPinnedItems("local", "local").map((pin) => pin.id)).toEqual([issuePin.id]);
  });

  it("searches issues and projects with ranking and snippets", () => {
    const store = createStore();
    store.createIssue({ title: "Alpha title", description: "No special details", workspaceId: "local" });
    const descIssue = store.createIssue({ title: "Other title", description: "Contains needle phrase inside a longer issue description", workspaceId: "local" });
    store.updateIssue(descIssue.id, { status: "done" });
    store.createProject({ title: "Project Alpha", description: "No details", workspaceId: "local" });
    store.createProject({ title: "Project Other", description: "Contains project needle phrase", workspaceId: "local" });

    const issues = store.searchIssues({ q: "alpha", workspaceId: "local" });
    expect(issues.total).toBe(1);
    expect(issues.issues[0]?.matchSource).toBe("title");

    const withoutClosed = store.searchIssues({ q: "needle", workspaceId: "local" });
    expect(withoutClosed.total).toBe(0);
    const withClosed = store.searchIssues({ q: "needle", workspaceId: "local", includeClosed: true });
    expect(withClosed.issues[0]?.matchSource).toBe("description");
    expect(withClosed.issues[0]?.matchedDescriptionSnippet).toContain("needle");

    const commentIssue = store.createIssue({ title: "Comment search", description: "No comment target here", workspaceId: "local" });
    store.createIssueComment(commentIssue.id, { body: "Fresh discussion needle in a comment" });
    const commentMatch = store.searchIssues({ q: "discussion needle", workspaceId: "local" });
    expect(commentMatch.issues[0]?.id).toBe(commentIssue.id);
    expect(commentMatch.issues[0]?.matchSource).toBe("comment");
    expect(commentMatch.issues[0]?.matchedSnippet).toContain("needle");
    expect(commentMatch.issues[0]?.matchedCommentSnippet).toContain("needle");

    const projects = store.searchProjects({ q: "needle", workspaceId: "local" });
    expect(projects.projects[0]?.matchSource).toBe("description");
    expect(projects.projects[0]?.matchedSnippet).toContain("needle");
  });

  it("skips agent self-mentions", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Loop Guard", provider: "codex" });
    const issue = store.createIssue({ title: "No recursion" });

    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: agent.id,
      body: `I already handled this [@Loop Guard](mention://agent/${agent.id})`,
    });

    expect(store.listTasks()).toHaveLength(0);
  });

  it("skips archived agents when resolving squad autopilots", () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "codex" });
    const backup = store.createAgent({ name: "Backup", provider: "codex" });
    const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [leader.id, backup.id] });
    const autopilot = store.createAutopilot({
      title: "Resolve squad",
      assigneeType: "squad",
      assigneeId: squad.id,
      issueTitleTemplate: "Use active member",
    });

    store.archiveAgent(leader.id);
    const run = store.runAutopilot(autopilot.id);
    expect(run.status).toBe("running");
    expect(store.getTask(run.taskId!)?.agentId).toBe(backup.id);

    store.archiveAgent(backup.id);
    const skipped = store.runAutopilot(autopilot.id);
    expect(skipped.status).toBe("skipped");
    expect(skipped.failureReason).toBe("No runnable agent");
    expect(() => store.addSquadMember(squad.id, { memberType: "agent", memberId: backup.id })).toThrow("Agent is archived");
  });

  it("fails dispatched, running, and waiting tasks for a runtime during orphan recovery", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude", maxConcurrentTasks: 3 });
    const runtime = store.registerRuntime({ name: "local", provider: "claude", maxConcurrency: 3 });
    const firstIssue = store.createIssue({ title: "Running orphan", assigneeType: "agent", assigneeId: agent.id });
    const secondIssue = store.createIssue({ title: "Waiting orphan", assigneeType: "agent", assigneeId: agent.id });
    const first = store.createTask({ agentId: agent.id, issueId: firstIssue.id, prompt: "Run" });
    const second = store.createTask({ agentId: agent.id, issueId: secondIssue.id, prompt: "Wait" });

    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    store.startTask(first.id);
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);
    store.markTaskWaitingLocalDirectory(second.id, "/tmp/project");
    expect(store.recoverOrphans(runtime.id)).toEqual({ orphaned: 2, retried: 2 });

    const recoveredRunning = store.getTask(first.id);
    const recoveredWaiting = store.getTask(second.id);
    const retryRunning = store.listTasks().find((task) => task.parentTaskId === first.id);
    const retryWaiting = store.listTasks().find((task) => task.parentTaskId === second.id);
    expect(recoveredRunning?.status).toBe("failed");
    expect(recoveredRunning?.runtimeId).toBe(runtime.id);
    expect(recoveredRunning?.error).toBe("daemon restarted while task was in flight");
    expect(recoveredRunning?.failureReason).toBe("runtime_recovery");
    expect(recoveredWaiting?.status).toBe("failed");
    expect(recoveredWaiting?.failureReason).toBe("runtime_recovery");
    expect(recoveredWaiting?.waitReason).toBeNull();
    expect(retryRunning).toMatchObject({
      status: "queued",
      parentTaskId: first.id,
      attempt: 2,
      maxAttempts: 3,
      runtimeId: runtime.id,
      issueId: firstIssue.id,
    });
    expect(retryWaiting).toMatchObject({
      status: "queued",
      parentTaskId: second.id,
      attempt: 2,
      maxAttempts: 3,
      issueId: secondIssue.id,
    });
    expect(store.getIssue(firstIssue.id)?.status).toBe("in_progress");
    expect(store.getIssue(secondIssue.id)?.status).toBe("in_progress");
  });

  it("applies Go retry edge rules during orphan recovery", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude", maxConcurrentTasks: 8 });
    const runtime = store.registerRuntime({ name: "local", provider: "claude", maxConcurrency: 8 });
    const retryIssue = store.createIssue({ title: "Retry issue", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const retryTask = store.createTask({
      agentId: agent.id,
      issueId: retryIssue.id,
      prompt: "retry issue",
      sessionId: "sess-issue",
      workDir: "/tmp/issue",
    });
    const chat = store.createChatSession({ agentId: agent.id, title: "Retry chat" });
    const chatTask = store.createTask({
      agentId: agent.id,
      chatSessionId: chat.id,
      prompt: "retry chat",
      sessionId: "sess-chat",
      workDir: "/tmp/chat",
    });
    const autopilot = store.createAutopilot({
      title: "No double retry",
      assigneeType: "agent",
      assigneeId: agent.id,
      issueTitleTemplate: "Autopilot task",
    });
    const run = store.runAutopilot(autopilot.id);
    store.updateIssue(run.issueId!, { status: "in_progress" });
    const autopilotTask = store.getTask(run.taskId!)!;
    const exhaustedIssue = store.createIssue({ title: "Exhausted issue", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const exhaustedTask = store.createTask({
      agentId: agent.id,
      issueId: exhaustedIssue.id,
      prompt: "exhausted",
      attempt: 3,
      maxAttempts: 3,
    });
    const directTask = store.createTask({ agentId: agent.id, prompt: "direct" });
    const pendingClaims = new Set([retryTask.id, chatTask.id, autopilotTask.id, exhaustedTask.id, directTask.id]);

    for (let i = 0; i < 5; i++) {
      const claimed = store.claimTask(runtime.id);
      expect(claimed).not.toBeNull();
      expect(pendingClaims.delete(claimed!.id)).toBeTrue();
    }
    expect(pendingClaims.size).toBe(0);

    expect(store.recoverOrphans(runtime.id)).toEqual({ orphaned: 5, retried: 2 });

    const issueRetry = store.listTasks().find((task) => task.parentTaskId === retryTask.id);
    const chatRetry = store.listTasks().find((task) => task.parentTaskId === chatTask.id);
    expect(issueRetry).toMatchObject({
      status: "queued",
      issueId: retryIssue.id,
      attempt: 2,
      maxAttempts: 3,
      sessionId: "sess-issue",
      workDir: "/tmp/issue",
    });
    expect(chatRetry).toMatchObject({
      status: "queued",
      chatSessionId: chat.id,
      attempt: 2,
      sessionId: "sess-chat",
      workDir: "/tmp/chat",
    });
    expect(store.getChatSession(chat.id)?.latestTaskId).toBe(chatRetry?.id);
    expect(store.listTasks().some((task) => task.parentTaskId === autopilotTask.id)).toBeFalse();
    expect(store.listTasks().some((task) => task.parentTaskId === exhaustedTask.id)).toBeFalse();
    expect(store.listTasks().some((task) => task.parentTaskId === directTask.id)).toBeFalse();
    expect(store.getAutopilotRun(run.id)?.status).toBe("failed");
    expect(store.getIssue(retryIssue.id)?.status).toBe("in_progress");
    expect(store.getIssue(run.issueId!)?.status).toBe("todo");
    expect(store.getIssue(exhaustedIssue.id)?.status).toBe("todo");
  });

  it("auto-retries retryable daemon failures and freshens resume-unsafe sessions", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex", maxConcurrentTasks: 2 });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex", maxConcurrency: 2 });
    const issue = store.createIssue({ title: "Fresh retry", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const task = store.createTask({
      agentId: agent.id,
      issueId: issue.id,
      prompt: "retry after stuck output",
      sessionId: "poisoned-session",
      workDir: "/tmp/poisoned",
      maxAttempts: 2,
    });

    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const failed = store.failTask(task.id, {
      error: "Codex did not make semantic progress",
      failureReason: "codex_semantic_inactivity",
    });

    const retry = store.listTasks().find((item) => item.parentTaskId === task.id);
    expect(failed.status).toBe("failed");
    expect(retry).toMatchObject({
      status: "queued",
      issueId: issue.id,
      attempt: 2,
      maxAttempts: 2,
      sessionId: null,
      workDir: null,
    });
    expect(store.getIssue(issue.id)?.status).toBe("in_progress");
  });

  it("creates projects, squads, and autopilot runs", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const project = store.createProject({ title: "Launch", priority: "high" });
    const squad = store.createSquad({
      name: "Core squad",
      leaderId: agent.id,
      memberIds: [agent.id],
    });
    const autopilot = store.createAutopilot({
      title: "Triage regressions",
      projectId: project.id,
      assigneeType: "squad",
      assigneeId: squad.id,
      issueTitleTemplate: "Investigate nightly regression",
    });

    const run = store.runAutopilot(autopilot.id);
    expect(run.status).toBe("running");
    expect(run.issueId).toBeString();
    expect(run.taskId).toBeString();

    const task = store.getTask(run.taskId!);
    expect(task?.agentId).toBe(agent.id);
    expect(task?.prompt).toBe("Investigate nightly regression");

    const updatedProject = store.getProject(project.id);
    expect(updatedProject?.issueCount).toBe(1);
    expect(store.listSquadMembers(squad.id)).toHaveLength(1);
    expect(store.listAutopilotRuns(autopilot.id)[0]?.id).toBe(run.id);
  });

  it("manages project resources and includes them in task prompts", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{ url: "https://github.com/example/workspace", description: "workspace repo" }],
    });
    const project = store.createProject({
      title: "Repo scoped work",
      resources: [{
        resourceType: "github_repo",
        resourceRef: { url: "https://github.com/example/repo", defaultBranchHint: "main" },
        label: "primary repo",
      }, {
        resourceType: "local_directory",
        resourceRef: { localPath: "/tmp/multiremi-local-project", daemonId: "daemon-local", label: "local clone" },
        label: "local clone",
      }],
    });
    const issue = store.createIssue({ title: "Use resources", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Inspect the repo" });

    expect(store.getProject(project.id)?.resourceCount).toBe(2);
    const repoResource = store.listProjectResources(project.id).find((resource) => resource.resourceType === "github_repo")!;
    expect(repoResource.resourceRef.url).toBe("https://github.com/example/repo");
    const updatedRepoResource = store.updateProjectResource(project.id, repoResource.id, {
      resource_ref: { url: "https://github.com/example/repo-updated", default_branch_hint: "develop" },
      label: "",
      position: 5,
    });
    expect(updatedRepoResource.resourceRef).toEqual({
      url: "https://github.com/example/repo-updated",
      defaultBranchHint: "develop",
      default_branch_hint: "develop",
    });
    expect(updatedRepoResource.label).toBeNull();
    expect(updatedRepoResource.position).toBe(5);
    expect(() => store.createProjectResource(project.id, {
      resourceType: "local_directory",
      resourceRef: { localPath: "/tmp/multiremi-local-project-duplicate", daemonId: "daemon-local" },
    })).toThrow("this daemon already has a local_directory attached to the project; remove it before adding another");
    const otherLocal = store.createProjectResource(project.id, {
      resourceType: "local_directory",
      resourceRef: { localPath: "/tmp/multiremi-local-project-other", daemonId: "daemon-other" },
    });
    expect(() => store.updateProjectResource(project.id, otherLocal.id, {
      resource_ref: { local_path: "/tmp/multiremi-local-project-other", daemon_id: "daemon-local" },
    })).toThrow("another local_directory on this daemon is already attached to the project");

    const taskWithContext = store.getTaskWithAgent(task.id)!;
    expect(taskWithContext.repos).toEqual([{ url: "https://github.com/example/repo-updated" }]);
    const prompt = buildTaskPrompt(taskWithContext);
    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("## Available Repositories");
    expect(prompt).toContain("remi repo checkout <url>");
    expect(prompt).toContain("https://github.com/example/repo-updated");
    expect(prompt).toContain("Local directory: /tmp/multiremi-local-project (local clone)");
    expect(prompt).not.toContain("https://github.com/example/workspace");

    store.deleteProjectResource(project.id, updatedRepoResource.id);
    expect(store.getProject(project.id)?.resourceCount).toBe(2);
  });

  it("falls back to workspace repos when a task has no project repos", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{ url: "https://github.com/example/workspace", description: "workspace repo" }],
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Use workspace repo" });
    const taskWithContext = store.getTaskWithAgent(task.id)!;

    expect(taskWithContext.repos).toEqual([{ url: "https://github.com/example/workspace", description: "workspace repo" }]);
    expect(buildTaskPrompt(taskWithContext)).toContain("https://github.com/example/workspace - workspace repo");
  });

  it("writes project resources into the daemon workdir", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const project = store.createProject({
      title: "Runtime resources",
      resources: [{
        resourceType: "github_repo",
        resourceRef: { url: "https://github.com/example/runtime", defaultBranchHint: "main" },
        label: "runtime repo",
      }],
    });
    const issue = store.createIssue({ title: "Run with context", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Use runtime context" });
    const dir = mkdtempSync(join(tmpdir(), "multiremi-context-"));

    try {
      writeProjectResourceContext(dir, store.getTaskWithAgent(task.id)!);
      const payload = JSON.parse(readFileSync(join(dir, ".multiremi", "project", "resources.json"), "utf8"));

      expect(payload.project_id).toBe(project.id);
      expect(payload.project_title).toBe("Runtime resources");
      expect(payload.resources[0]).toEqual({
        id: store.listProjectResources(project.id)[0]!.id,
        resource_type: "github_repo",
        resource_ref: { url: "https://github.com/example/runtime", default_branch_hint: "main" },
        label: "runtime repo",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes agent skills into the daemon workdir", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const skill = store.createSkill({
      name: "Review Helper",
      description: "Review pull requests",
      content: "# Body",
      files: [{ path: "templates/check.md", content: "Check list" }],
    });
    store.setAgentSkills(agent.id, { skillIds: [skill.id!] });
    const task = store.getTaskWithAgent(store.createTask({ agentId: agent.id, prompt: "Review" }).id)!;
    const dir = mkdtempSync(join(tmpdir(), "multiremi-skill-"));

    try {
      writeAgentSkillContext(dir, task);
      const skillDir = join(dir, ".claude", "skills", "review-helper");

      expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("name: \"Review Helper\"");
      expect(readFileSync(join(skillDir, "templates", "check.md"), "utf8")).toBe("Check list");
      expect(existsSync(join(dir, ".claude", "skills", "..", "escape.md"))).toBeFalse();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores issue metadata as a bounded primitive map and includes it in prompts", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const issue = store.createIssue({ title: "Remember PR state" });

    expect(issue.metadata).toEqual({});
    expect(store.setIssueMetadataKey(issue.id, "pr_url", "https://github.com/example/repo/pull/1")).toEqual({
      pr_url: "https://github.com/example/repo/pull/1",
    });
    store.setIssueMetadataKey(issue.id, "ready", true);
    store.setIssueMetadataKey(issue.id, "attempts", 2);
    expect(() => store.setIssueMetadataKey(issue.id, "bad key", "x")).toThrow("key must match");
    expect(() => store.setIssueMetadataKey(issue.id, "nested", { value: "x" })).toThrow("value must be a primitive");

    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Use pinned facts" });
    const prompt = buildTaskPrompt(store.getTaskWithAgent(task.id)!);
    expect(prompt).toContain("## Issue Metadata");
    expect(prompt).toContain(`Key: ${issue.key}`);
    expect(prompt).toContain("pr_url: https://github.com/example/repo/pull/1");

    expect(store.deleteIssueMetadataKey(issue.id, "ready")).toEqual({
      attempts: 2,
      pr_url: "https://github.com/example/repo/pull/1",
    });
  });

  it("renders Go-style comment trigger context in daemon prompts", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Worker", provider: "codex" });
    const reviewer = store.createAgent({ name: "Reviewer", provider: "codex" });
    const issue = store.createIssue({ title: "Reply with context" });
    const root = store.createIssueComment(issue.id, { body: "Root context." });
    const comment = store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: reviewer.id,
      parentId: root.id,
      body: `Please inspect \`$PATH\` handling.\nSecond line [@Worker](mention://agent/${agent.id}).`,
    });
    const task = store.listTasks().find((item) => item.triggerCommentId === comment.id)!;
    const metadata = store.getTaskTriggerMetadata(task)!;
    const prompt = buildTaskPrompt({
      ...store.getTaskWithAgent(task.id)!,
      trigger_comment_id: comment.id,
      trigger_thread_id: metadata.triggerThreadId,
      trigger_comment_content: metadata.triggerCommentContent,
      trigger_author_type: metadata.triggerAuthorType,
      trigger_author_name: metadata.triggerAuthorName,
      new_comment_count: 3,
      new_comments_since: "2025-01-01T00:00:00.000Z",
    } as any);

    expect(prompt).toContain("## Triggering Comment");
    expect(prompt).toContain("Another agent (Reviewer) just left a new comment");
    expect(prompt).toContain("> Please inspect `$PATH` handling.");
    expect(prompt).toContain("> Second line");
    expect(prompt).toContain("do not reply");
    expect(prompt).toContain(`remi issue comment list ${issue.id} --thread ${root.id} --since 2025-01-01T00:00:00.000Z --output json`);
    expect(prompt).toContain(`remi issue comment add ${issue.id} --parent ${comment.id} --content-stdin`);
    expect(prompt).toContain("<<'COMMENT'");
    expect(prompt).not.toContain("multimira");
  });

  it("renders daemon claim execution context in provider prompts", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Context Worker", provider: "claude" });
    const task = store.getTaskWithAgent(store.createTask({ agentId: agent.id, prompt: "Fallback prompt" }).id)!;
    const prompt = buildTaskPrompt({
      ...task,
      workspaceContext: "Use the shared release checklist.",
      requestingUserName: "Alice",
      requestingUserProfileDescription: "Likes concrete dates and verification output.",
      chatMessage: "Check Shanghai weather\n\nand Qingdao too",
      chatMessageAttachments: [{ id: "att_1", filename: "forecast.txt", content_type: "text/plain" }],
      autopilotTitle: "Webhook triage",
      autopilotSource: "webhook",
      autopilotDescription: "Investigate the incoming push.",
      autopilotTriggerPayload: { repository: "remi", action: "push" },
      quickCreatePrompt: "Create onboarding screenshot follow-up",
    });

    expect(prompt).toContain("## Workspace Context");
    expect(prompt).toContain("Use the shared release checklist.");
    expect(prompt).toContain("## Requesting User");
    expect(prompt).toContain("Name: Alice");
    expect(prompt).toContain("Likes concrete dates and verification output.");
    expect(prompt).toContain("## Chat Message");
    expect(prompt).toContain("Check Shanghai weather\n\nand Qingdao too");
    expect(prompt).toContain("att_1 - forecast.txt (text/plain)");
    expect(prompt).toContain("## Autopilot Context");
    expect(prompt).toContain("Title: Webhook triage");
    expect(prompt).toContain("Source: webhook");
    expect(prompt).toContain('"repository": "remi"');
    expect(prompt).toContain("## Quick Create Request");
    expect(prompt).toContain("Create onboarding screenshot follow-up");
  });

  it("persists chat sessions and resumes provider context across turns", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "Private plan" });

    const first = store.sendChatMessage(session.id, { body: "How should we approach this?" });
    expect(first.message.role).toBe("user");
    expect(first.task.chatSessionId).toBe(session.id);

    expect(store.claimTask(runtime.id)?.id).toBe(first.task.id);
    store.startTask(first.task.id);
    store.completeTask(first.task.id, {
      output: "Start with a small patch.",
      sessionId: "provider-session-1",
      workDir: "/tmp/multiremi-chat",
    });

    const messages = store.listChatMessages(session.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.body).toBe("Start with a small patch.");
    expect(store.getChatSession(session.id)?.sessionId).toBe("provider-session-1");

    const second = store.sendChatMessage(session.id, { body: "Continue" });
    expect(second.task.sessionId).toBe("provider-session-1");
    expect(second.task.workDir).toBe("/tmp/multiremi-chat");
    expect(store.claimTask(runtime.id)?.id).toBe(second.task.id);
    store.startTask(second.task.id);
    store.failTask(second.task.id, {
      error: "Invalid request",
      sessionId: "unsafe-provider-session",
      workDir: "/tmp/unsafe-chat",
      failureReason: "api_invalid_request",
    });

    const failedMessages = store.listChatMessages(session.id);
    expect(failedMessages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(failedMessages[3]?.failureReason).toBe("api_invalid_request");
    expect(failedMessages[3]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(store.getChatSession(session.id)?.sessionId).toBe("provider-session-1");
    expect(store.getChatSession(session.id)?.workDir).toBe("/tmp/multiremi-chat");
    expect(store.getChatSession(session.id)?.hasUnread).toBe(true);
    store.markChatSessionRead(session.id);
    expect(store.getChatSession(session.id)?.hasUnread).toBe(false);
  });

  it("scopes chat session HTTP routes to the current creator", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Chat runtime", provider: "codex" });
    const agent = store.createAgent({ name: "Chat Codex", provider: "codex", visibility: "workspace", runtimeId: runtime.id });
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "member" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "Bob", type: "pat", workspaceId: "local", userId: "bob" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const aliceHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${aliceToken.token}` };
    const bobHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${bobToken.token}` };
    const aliceAuthHeaders = { Authorization: `Bearer ${aliceToken.token}` };
    const bobAuthHeaders = { Authorization: `Bearer ${bobToken.token}` };

    const created = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ agent_id: agent.id, creator_id: "bob", title: "Alice private chat" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(Object.keys(createdBody).sort()).toEqual([
      "agent_id",
      "created_at",
      "creator_id",
      "has_unread",
      "id",
      "status",
      "title",
      "updated_at",
      "workspace_id",
    ]);
    expect(createdBody.creator_id).toBe("alice");
    expect(createdBody.agent_id).toBe(agent.id);
    expect(createdBody.has_unread).toBe(false);

    const aliceList = await app.request("/api/chat/sessions", { headers: aliceAuthHeaders });
    expect((await aliceList.json()).map((session: any) => session.id)).toEqual([createdBody.id]);
    const bobList = await app.request("/api/chat/sessions", { headers: bobAuthHeaders });
    expect(await bobList.json()).toEqual([]);
    const bobMultiremiList = await app.request("/api/multiremi/chats", { headers: bobAuthHeaders });
    expect(await bobMultiremiList.json()).toMatchObject({ sessions: [], total: 0 });

    const attachment = store.createAttachment({
      chatSessionId: createdBody.id,
      workspaceId: "local",
      filename: "brief.txt",
      url: "/api/attachments/att_chat_brief/content",
      contentType: "text/plain",
      sizeBytes: 12,
    });
    const sent = await app.request(`/api/chat/sessions/${createdBody.id}/messages`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ content: "Use Go-compatible content", attachment_ids: [attachment.id] }),
    });
    expect(sent.status).toBe(201);
    const sentBody = await sent.json();
    expect(Object.keys(sentBody).sort()).toEqual(["created_at", "message_id", "task_id"]);
    expect(store.getTask(sentBody.task_id)?.chatSessionId).toBe(createdBody.id);
    const messages = await app.request(`/api/chat/sessions/${createdBody.id}/messages`, { headers: aliceAuthHeaders });
    const messagesBody = await messages.json();
    expect(Object.keys(messagesBody[0]).sort()).toEqual([
      "attachments",
      "chat_session_id",
      "content",
      "created_at",
      "elapsed_ms",
      "failure_reason",
      "id",
      "role",
      "task_id",
    ]);
    expect(messagesBody[0]).toMatchObject({
      chat_session_id: createdBody.id,
      content: "Use Go-compatible content",
      role: "user",
      task_id: sentBody.task_id,
    });
    expect(messagesBody[0].attachments[0]).toMatchObject({
      id: attachment.id,
      chat_session_id: createdBody.id,
      chat_message_id: messagesBody[0].id,
      filename: "brief.txt",
      content_type: "text/plain",
      size_bytes: 12,
      download_url: `/api/attachments/${attachment.id}/download`,
    });
    expect(Object.keys(messagesBody[0].attachments[0]).filter((key) => /[A-Z]/.test(key))).toEqual([]);
    expect(store.getAttachment(attachment.id)?.chatMessageId).toBe(messagesBody[0].id);
    const invalidPageLimit = await app.request(`/api/chat/sessions/${createdBody.id}/messages/page?limit=101`, {
      headers: aliceAuthHeaders,
    });
    expect(invalidPageLimit.status).toBe(400);
    expect(await invalidPageLimit.json()).toEqual({ error: "invalid limit" });

    const pendingAlice = await app.request("/api/chat/pending-tasks", { headers: aliceAuthHeaders });
    expect((await pendingAlice.json()).tasks.map((task: any) => task.chat_session_id)).toEqual([createdBody.id]);
    const pendingBob = await app.request("/api/chat/pending-tasks", { headers: bobAuthHeaders });
    expect(await pendingBob.json()).toEqual({ tasks: [] });

    expect(store.claimTask(runtime.id)?.id).toBe(sentBody.task_id);
    store.startTask(sentBody.task_id);
    store.completeTask(sentBody.task_id, { output: "Done with chat", sessionId: "provider-chat-session" });
    const unreadDetail = await app.request(`/api/chat/sessions/${createdBody.id}`, { headers: aliceAuthHeaders });
    expect((await unreadDetail.json()).has_unread).toBe(true);
    const terminalMessages = await app.request(`/api/chat/sessions/${createdBody.id}/messages`, { headers: aliceAuthHeaders });
    const terminalMessagesBody = await terminalMessages.json();
    expect(terminalMessagesBody[1]).toMatchObject({
      role: "assistant",
      content: "Done with chat",
      failure_reason: null,
      task_id: sentBody.task_id,
    });
    expect(terminalMessagesBody[1].elapsed_ms).toBeGreaterThanOrEqual(0);
    expect((await app.request(`/api/chat/sessions/${createdBody.id}/read`, {
      method: "POST",
      headers: aliceAuthHeaders,
    })).status).toBe(204);
    const readDetail = await app.request(`/api/chat/sessions/${createdBody.id}`, { headers: aliceAuthHeaders });
    expect((await readDetail.json()).has_unread).toBe(false);

    const bobForbiddenRequests: Array<[string, string, unknown?]> = [
      ["GET", `/api/chat/sessions/${createdBody.id}`],
      ["PATCH", `/api/chat/sessions/${createdBody.id}`, { title: "Bob rename" }],
      ["GET", `/api/chat/sessions/${createdBody.id}/messages`],
      ["GET", `/api/chat/sessions/${createdBody.id}/messages/page?limit=1`],
      ["POST", `/api/chat/sessions/${createdBody.id}/messages`, { content: "Bob should not send" }],
      ["GET", `/api/chat/sessions/${createdBody.id}/pending-task`],
      ["POST", `/api/chat/sessions/${createdBody.id}/read`],
      ["DELETE", `/api/chat/sessions/${createdBody.id}`],
      ["GET", `/api/multiremi/chats/${createdBody.id}`],
      ["PATCH", `/api/multiremi/chats/${createdBody.id}`, { title: "Bob Multiremi rename" }],
      ["GET", `/api/multiremi/chats/${createdBody.id}/messages`],
      ["POST", `/api/multiremi/chats/${createdBody.id}/messages`, { content: "Bob Multiremi send" }],
    ];
    for (const [method, path, body] of bobForbiddenRequests) {
      const response = await app.request(path, {
        method,
        headers: body ? bobHeaders : bobAuthHeaders,
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "not your chat session" });
    }

    const pendingBeforeDelete = await app.request(`/api/chat/sessions/${createdBody.id}/messages`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ content: "Pending before delete" }),
    });
    expect(pendingBeforeDelete.status).toBe(201);
    const pendingBeforeDeleteBody = await pendingBeforeDelete.json();
    expect(store.getTask(pendingBeforeDeleteBody.task_id)?.chatSessionId).toBe(createdBody.id);

    const aliceSession = await app.request(`/api/chat/sessions/${createdBody.id}`, { headers: aliceAuthHeaders });
    expect((await aliceSession.json()).id).toBe(createdBody.id);
    expect((await app.request(`/api/chat/sessions/${createdBody.id}`, {
      method: "DELETE",
      headers: aliceAuthHeaders,
    })).status).toBe(204);
    expect(store.getChatSession(createdBody.id)).toBeNull();
    expect(store.getTask(sentBody.task_id)?.status).toBe("completed");
    expect(store.getTask(sentBody.task_id)?.chatSessionId).toBeNull();
    expect(store.getTask(pendingBeforeDeleteBody.task_id)?.status).toBe("cancelled");
    expect(store.getTask(pendingBeforeDeleteBody.task_id)?.chatSessionId).toBeNull();
    expect(store.getAttachment(attachment.id)).toBeNull();
  });

  it("rechecks private agent access across chat and agent HTTP surfaces", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "member" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "Bob", type: "pat", workspaceId: "local", userId: "bob" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const aliceRuntime = store.registerRuntime({
      id: "rt_private_alice",
      name: "Alice private runtime",
      provider: "codex",
      workspaceId: "local",
      ownerId: "alice",
      visibility: "private",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const aliceHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${aliceToken.token}` };
    const aliceAuthHeaders = { Authorization: `Bearer ${aliceToken.token}` };
    const bobAuthHeaders = { Authorization: `Bearer ${bobToken.token}` };
    const adminAuthHeaders = { Authorization: `Bearer ${adminToken.token}` };

    const createdAgent = await app.request("/api/agents", {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({
        name: "Private Codex",
        provider: "claude",
        runtime_id: aliceRuntime.id,
        owner_id: "bob",
        visibility: "private",
      }),
    });
    expect(createdAgent.status).toBe(201);
    const agent = await createdAgent.json();
    expect(agent.owner_id).toBe("alice");
    // Pool model: the legacy runtime_id only picks the provider; no binding.
    expect(agent.runtime_id).toBe("");
    expect(agent.provider).toBe("codex");
    expect(store.getAgent(agent.id)?.provider).toBe("codex");
    expect(store.getAgent(agent.id)?.runtimeId).toBeNull();
    expect(agent.visibility).toBe("private");

    expect((await app.request(`/api/agents/${agent.id}`, { headers: aliceAuthHeaders })).status).toBe(200);
    expect((await app.request(`/api/agents/${agent.id}`, { headers: adminAuthHeaders })).status).toBe(200);
    const bobAgentList = await app.request("/api/agents", { headers: bobAuthHeaders });
    expect((await bobAgentList.json()).map((item: any) => item.id)).not.toContain(agent.id);
    const bobAgentDetail = await app.request(`/api/agents/${agent.id}`, { headers: bobAuthHeaders });
    expect(bobAgentDetail.status).toBe(403);
    expect(await bobAgentDetail.json()).toEqual({ error: "you do not have access to this agent" });

    const bobChatCreate = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bobToken.token}` },
      body: JSON.stringify({ agent_id: agent.id, title: "Bob should not start" }),
    });
    expect(bobChatCreate.status).toBe(403);
    expect(await bobChatCreate.json()).toEqual({ error: "you do not have access to this agent" });

    const aliceChatCreate = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ agent_id: agent.id, title: "Alice private chat" }),
    });
    expect(aliceChatCreate.status).toBe(201);
    const chat = await aliceChatCreate.json();
    const aliceCleanupChatCreate = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ agent_id: agent.id, title: "Alice private cleanup" }),
    });
    expect(aliceCleanupChatCreate.status).toBe(201);
    const cleanupChat = await aliceCleanupChatCreate.json();
    const sent = await app.request(`/api/chat/sessions/${chat.id}/messages`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ content: "queued before access changes" }),
    });
    expect(sent.status).toBe(201);

    store.updateAgent(agent.id, { ownerId: "carol" });
    const aliceHiddenList = await app.request("/api/chat/sessions", { headers: aliceAuthHeaders });
    expect(await aliceHiddenList.json()).toEqual([]);
    const aliceHiddenPending = await app.request("/api/chat/pending-tasks", { headers: aliceAuthHeaders });
    expect(await aliceHiddenPending.json()).toEqual({ tasks: [] });
    const aliceHiddenChat = await app.request(`/api/chat/sessions/${chat.id}`, { headers: aliceAuthHeaders });
    expect(aliceHiddenChat.status).toBe(403);
    expect(await aliceHiddenChat.json()).toEqual({ error: "you do not have access to this agent" });
    const aliceHiddenDelete = await app.request(`/api/chat/sessions/${cleanupChat.id}`, {
      method: "DELETE",
      headers: aliceAuthHeaders,
    });
    expect(aliceHiddenDelete.status).toBe(204);
    expect(store.getChatSession(cleanupChat.id)).toBeNull();

    store.updateAgent(agent.id, { visibility: "workspace" });
    const aliceVisibleAgain = await app.request(`/api/chat/sessions/${chat.id}`, { headers: aliceAuthHeaders });
    expect(aliceVisibleAgain.status).toBe(200);
    expect((await aliceVisibleAgain.json()).id).toBe(chat.id);
  });

  it("gates agent creation and runtime moves like the Go server", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ id: "bob", name: "Bob", role: "member" });
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "Bob", type: "pat", workspaceId: "local", userId: "bob" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const alicePrivate = store.registerRuntime({
      id: "rt_gate_alice_private",
      name: "Alice private",
      provider: "codex",
      workspaceId: "local",
      ownerId: "alice",
      visibility: "private",
    });
    const bobPublic = store.registerRuntime({
      id: "rt_gate_bob_public",
      name: "Bob public",
      provider: "claude",
      workspaceId: "local",
      ownerId: "bob",
      visibility: "public",
    });
    const remoteRuntime = store.registerRuntime({
      id: "rt_gate_remote",
      name: "Remote",
      provider: "codex",
      workspaceId: "remote",
      ownerId: "alice",
      visibility: "public",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

    const invalidNativeCreate = await app.request("/api/multiremi/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: "{",
    });
    expect(invalidNativeCreate.status).toBe(400);
    expect(await invalidNativeCreate.json()).toEqual({ error: "invalid request body" });

    const invalidCreate = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: "{",
    });
    expect(invalidCreate.status).toBe(400);
    expect(await invalidCreate.json()).toEqual({ error: "invalid request body" });

    const unknownProvider = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ name: "Bad provider", provider: "gemini" }),
    });
    expect(unknownProvider.status).toBe(400);
    expect(await unknownProvider.json()).toEqual({ error: 'unknown provider "gemini"' });

    const crossWorkspaceRuntime = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ name: "Remote runtime", runtime_id: remoteRuntime.id }),
    });
    expect(crossWorkspaceRuntime.status).toBe(400);
    expect(await crossWorkspaceRuntime.json()).toEqual({ error: "invalid runtime_id" });

    const tooLongDescription = "x".repeat(256);
    const invalidDescriptionCreate = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ name: "Long description", runtime_id: alicePrivate.id, description: tooLongDescription }),
    });
    expect(invalidDescriptionCreate.status).toBe(400);
    expect(await invalidDescriptionCreate.json()).toEqual({ error: "description must be 255 characters or fewer" });

    const invalidThinkingCreate = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ name: "Bad thinking", runtime_id: alicePrivate.id, thinking_level: "max" }),
    });
    expect(invalidThinkingCreate.status).toBe(400);
    expect(await invalidThinkingCreate.json()).toEqual({
      error: 'thinking_level "max" is not a recognised value for runtime "codex"',
    });

    const bobPrivateRuntime = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ name: "Bob blocked", runtime_id: alicePrivate.id }),
    });
    expect(bobPrivateRuntime.status).toBe(403);
    expect(await bobPrivateRuntime.json()).toEqual({
      error: "this runtime is private; only its owner or a workspace admin can create agents on it",
    });

    const bobPublicRuntime = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({
        name: "Bob public agent",
        runtime_id: bobPublic.id,
        provider: "codex",
        description: "Bob public description",
        avatar_url: "https://example.com/bob-agent.png",
      }),
    });
    expect(bobPublicRuntime.status).toBe(201);
    const bobAgent = await bobPublicRuntime.json();
    // Legacy runtime_id still forces the provider but no longer binds.
    expect(bobAgent.provider).toBe("claude");
    expect(store.getAgent(bobAgent.id)?.provider).toBe("claude");
    expect(store.getAgent(bobAgent.id)?.runtimeId).toBeNull();
    expect(store.getAgent(bobAgent.id)?.description).toBe("Bob public description");
    expect(store.getAgent(bobAgent.id)?.avatarUrl).toBe("https://example.com/bob-agent.png");
    expect(bobAgent.description).toBe("Bob public description");
    expect(bobAgent.avatar_url).toBe("https://example.com/bob-agent.png");
    expect(bobAgent.runtime_id).toBe("");
    expect(bobAgent.owner_id).toBe("bob");
    expect(bobAgent.max_concurrent_tasks).toBe(6);
    const bobAgentCreated = store.listAnalyticsEvents({ name: "agent_created" })[0]!;
    expect(bobAgentCreated.distinctId).toBe("bob");
    expect(bobAgentCreated.workspaceId).toBe("local");
    expect(bobAgentCreated.metricsOnly).toBe(false);
    expect(bobAgentCreated.properties).toMatchObject({
      agent_id: bobAgent.id,
      provider: "claude",
      runtime_mode: "local",
      template: "",
      is_first_agent_in_workspace: true,
      user_id: "bob",
      source: "manual",
      is_demo: false,
    });
    expect(metricValue(store, "multiremi_agent_created_total", { runtime_mode: "local", source: "manual" })).toBe(1);

    const invalidDefaultJson = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: "{",
    });
    expect(invalidDefaultJson.status).toBe(400);
    expect(await invalidDefaultJson.json()).toEqual({ error: "invalid request body" });

    // Pool model: the default agent seeds without a runtime and stays unbound.
    const defaultSeed = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ runtime_id: bobPublic.id, provider: "codex" }),
    });
    expect(defaultSeed.status).toBe(201);
    const defaultSeedBody = await defaultSeed.json();
    expect(defaultSeedBody.agent).toMatchObject({
      id: "agt_default_local_claude",
      name: "Claude",
      provider: "claude",
      runtimeId: null,
      workspaceId: "local",
      ownerId: "bob",
      description: "Default Claude agent",
    });
    const agentCreatedEventsAfterDefault = store.listAnalyticsEvents({ name: "agent_created" });
    expect(agentCreatedEventsAfterDefault).toHaveLength(2);
    expect(agentCreatedEventsAfterDefault[1]!.properties).toMatchObject({
      agent_id: "agt_default_local_claude",
      provider: "claude",
      runtime_mode: "local",
      template: "default",
      is_first_agent_in_workspace: false,
      user_id: "bob",
      source: "manual",
    });
    expect(metricValue(store, "multiremi_agent_created_total", { runtime_mode: "local", source: "manual" })).toBe(2);

    // Provider-only seeding works and reuses the same default agent.
    const providerOnlyDefault = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(providerOnlyDefault.status).toBe(200);
    expect((await providerOnlyDefault.json()).agent.id).toBe("agt_default_local_claude");

    const defaultSeedAgain = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ runtime_id: bobPublic.id }),
    });
    expect(defaultSeedAgain.status).toBe(200);
    expect((await defaultSeedAgain.json()).agent.id).toBe("agt_default_local_claude");
    expect(store.listAnalyticsEvents({ name: "agent_created" })).toHaveLength(2);

    const invalidNativeUpdate = await app.request(`/api/multiremi/agents/${bobAgent.id}`, {
      method: "PATCH",
      headers: jsonHeaders(bobToken.token),
      body: "{",
    });
    expect(invalidNativeUpdate.status).toBe(400);
    expect(await invalidNativeUpdate.json()).toEqual({ error: "invalid request body" });

    const invalidUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: "{",
    });
    expect(invalidUpdate.status).toBe(400);
    expect(await invalidUpdate.json()).toEqual({ error: "invalid request body" });

    const invalidDescriptionUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ description: tooLongDescription }),
    });
    expect(invalidDescriptionUpdate.status).toBe(400);
    expect(await invalidDescriptionUpdate.json()).toEqual({ error: "description must be 255 characters or fewer" });

    const invalidThinkingUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ thinking_level: "minimal" }),
    });
    expect(invalidThinkingUpdate.status).toBe(400);
    expect(await invalidThinkingUpdate.json()).toEqual({
      error: 'thinking_level "minimal" is not a recognised value for runtime "claude"',
    });

    const duplicateName = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ name: "Bob public agent", runtime_id: bobPublic.id }),
    });
    expect(duplicateName.status).toBe(409);
    expect(await duplicateName.json()).toEqual({ error: "an agent named \"Bob public agent\" already exists in this workspace" });

    // Machine binding is gone, but a legacy "move" keeps its engine-switch
    // effect and the private-runtime gate: bob still can't reference alice's
    // private runtime.
    const forbiddenMove = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ runtime_id: alicePrivate.id }),
    });
    expect(forbiddenMove.status).toBe(403);

    // A legal legacy move switches the engine (and resets the model) without
    // binding the agent to the machine.
    store.updateAgent(bobAgent.id, { model: "claude-opus-4-8" });
    const codexPublic = store.registerRuntime({
      id: "rt_gate_codex_public",
      name: "Codex public",
      provider: "codex",
      workspaceId: "local",
      ownerId: "alice",
      visibility: "public",
    });
    const legacyMove = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ runtime_id: codexPublic.id }),
    });
    expect(legacyMove.status).toBe(200);
    expect((await legacyMove.json()).runtime_id).toBe("");
    expect(store.getAgent(bobAgent.id)?.runtimeId).toBeNull();
    expect(store.getAgent(bobAgent.id)?.provider).toBe("codex");
    expect(store.getAgent(bobAgent.id)?.model).toBe("");

    // Provider is editable on unbound agents (and round-trips cleanly).
    const providerOnlyUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ provider: "codex" }),
    });
    expect(providerOnlyUpdate.status).toBe(200);
    const providerOnlyUpdateBody = await providerOnlyUpdate.json();
    expect(providerOnlyUpdateBody.provider).toBe("codex");
    expect(store.getAgent(bobAgent.id)?.provider).toBe("codex");

    const unknownProviderUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ provider: "gemini" }),
    });
    expect(unknownProviderUpdate.status).toBe(400);
    expect(await unknownProviderUpdate.json()).toEqual({ error: 'unknown provider "gemini"' });

    const providerRestore = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(providerRestore.status).toBe(200);
    expect(store.getAgent(bobAgent.id)?.provider).toBe("claude");

    // A legacy move to an any-provider runtime must keep the agent's current
    // provider (not silently default to claude).
    store.updateAgent(bobAgent.id, { provider: "codex", model: "gpt-5.2" });
    const anyRuntime = store.registerRuntime({
      id: "rt_gate_any",
      name: "any gate",
      provider: "any",
      workspaceId: "local",
      ownerId: "bob",
      visibility: "public",
    });
    const anyMove = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ runtime_id: anyRuntime.id }),
    });
    expect(anyMove.status).toBe(200);
    expect(store.getAgent(bobAgent.id)?.provider).toBe("codex");
    // Provider unchanged → model is preserved (no engine switch reset).
    expect(store.getAgent(bobAgent.id)?.model).toBe("gpt-5.2");
    store.updateAgent(bobAgent.id, { provider: "claude", model: "" });

    const descriptionUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({
        description: "Updated Bob description",
        avatar_url: "https://example.com/bob-agent-updated.png",
        thinking_level: "max",
      }),
    });
    expect(descriptionUpdate.status).toBe(200);
    const descriptionUpdateBody = await descriptionUpdate.json();
    expect(descriptionUpdateBody.description).toBe("Updated Bob description");
    expect(descriptionUpdateBody.avatar_url).toBe("https://example.com/bob-agent-updated.png");
    expect(descriptionUpdateBody.thinking_level).toBe("max");
    expect(store.getAgent(bobAgent.id)?.description).toBe("Updated Bob description");
    expect(store.getAgent(bobAgent.id)?.avatarUrl).toBe("https://example.com/bob-agent-updated.png");

    const adminPrivateRuntime = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ name: "Admin private agent", runtime_id: alicePrivate.id }),
    });
    expect(adminPrivateRuntime.status).toBe(201);
    const adminAgent = await adminPrivateRuntime.json();
    expect(adminAgent.runtime_id).toBe("");
    expect(adminAgent.provider).toBe("codex");
  });

  it("redacts agent mcp_config like the Go server", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createWorkspaceMember({ id: "owner", name: "Owner", role: "member" });
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    store.createWorkspaceMember({ id: "member", name: "Member", role: "member" });
    const ownerToken = await store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "owner" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const memberToken = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "member" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });
    const secretConfig = { mcpServers: { local: { command: "secret-command", env: { API_KEY: "secret" } } } };
    const agent = store.createAgent({
      id: "agt_mcp_redact",
      name: "MCP Redact",
      provider: "codex",
      ownerId: "owner",
      visibility: "workspace",
      mcpConfig: secretConfig,
    });

    const ownerRead = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(ownerToken.token) });
    expect(ownerRead.status).toBe(200);
    expect(await ownerRead.json()).toMatchObject({
      id: agent.id,
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });

    const adminRead = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(adminToken.token) });
    expect(await adminRead.json()).toMatchObject({
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });

    const memberRead = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(memberToken.token) });
    expect(memberRead.status).toBe(200);
    expect(await memberRead.json()).toMatchObject({
      id: agent.id,
      mcp_config: null,
      mcp_config_redacted: true,
    });

    const memberList = await app.request("/api/agents", { headers: authHeaders(memberToken.token) });
    const listedAgent = (await memberList.json()).find((item: any) => item.id === agent.id);
    expect(listedAgent).toMatchObject({
      mcp_config: null,
      mcp_config_redacted: true,
    });

    const task = store.createTask({ agentId: agent.id, prompt: "read agent list" });
    const taskToken = await store.createTaskAccessToken(task, "owner");
    const taskRead = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(taskToken.token) });
    expect(taskRead.status).toBe(200);
    expect(await taskRead.json()).toMatchObject({
      mcp_config: null,
      mcp_config_redacted: true,
    });

    store.updateWorkspace("local", { settings: { always_redact_env: true } });
    const alwaysRedactedAdminRead = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(adminToken.token) });
    expect(await alwaysRedactedAdminRead.json()).toMatchObject({
      mcp_config: null,
      mcp_config_redacted: true,
    });
  });

  it("gates agent mutations and emits Go-style redacted agent events", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createWorkspaceMember({ id: "owner", name: "Owner", role: "member" });
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    store.createWorkspaceMember({ id: "member", name: "Member", role: "member" });
    const ownerToken = await store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "owner" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const memberToken = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "member" });
    const runtime = store.registerRuntime({
      id: "rt_agent_event_public",
      name: "Agent Event Runtime",
      provider: "codex",
      workspaceId: "local",
      ownerId: "owner",
      visibility: "public",
    });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const secretConfig = { mcpServers: { local: { command: "secret-command", env: { API_KEY: "secret" } } } };

    const created = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(ownerToken.token),
      body: JSON.stringify({
        name: "Event Agent",
        runtime_id: runtime.id,
        visibility: "workspace",
        mcp_config: secretConfig,
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      name: "Event Agent",
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });
    expect(events.find((event) => event.type === "agent:created")).toMatchObject({
      workspaceId: "local",
      actorType: "member",
      actorId: "owner",
      payload: {
        agent: {
          id: createdBody.id,
          mcp_config: null,
          mcp_config_redacted: true,
        },
      },
    });

    const memberUpdate = await app.request(`/api/agents/${createdBody.id}`, {
      method: "PUT",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ name: "Member Should Not Update" }),
    });
    expect(memberUpdate.status).toBe(403);
    expect(await memberUpdate.json()).toEqual({ error: "only the agent owner can manage this agent" });

    const task = store.createTask({ agentId: createdBody.id, prompt: "try to mutate agent" });
    const taskToken = await store.createTaskAccessToken(task, "owner");
    const taskUpdate = await app.request(`/api/agents/${createdBody.id}`, {
      method: "PUT",
      headers: jsonHeaders(taskToken.token),
      body: JSON.stringify({ name: "Task Should Not Update" }),
    });
    expect(taskUpdate.status).toBe(403);
    expect(await taskUpdate.json()).toEqual({ error: "this endpoint is only available to human actors" });

    const ownerUpdate = await app.request(`/api/agents/${createdBody.id}`, {
      method: "PUT",
      headers: jsonHeaders(ownerToken.token),
      body: JSON.stringify({ name: "Event Agent Updated" }),
    });
    expect(ownerUpdate.status).toBe(200);
    expect(await ownerUpdate.json()).toMatchObject({
      name: "Event Agent Updated",
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });
    expect(events.find((event) =>
      event.type === "agent:status" &&
      (event.payload.agent as any)?.id === createdBody.id &&
      (event.payload.agent as any)?.name === "Event Agent Updated"
    )).toMatchObject({
      actorId: "owner",
      payload: {
        agent: {
          mcp_config: null,
          mcp_config_redacted: true,
        },
      },
    });

    const adminArchive = await app.request(`/api/agents/${createdBody.id}/archive`, {
      method: "POST",
      headers: jsonHeaders(adminToken.token),
    });
    expect(adminArchive.status).toBe(200);
    expect(await adminArchive.json()).toMatchObject({
      id: createdBody.id,
      status: "archived",
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });
    expect(events.find((event) => event.type === "agent:archived")).toMatchObject({
      actorId: "admin",
      payload: {
        agent: {
          id: createdBody.id,
          status: "archived",
          mcp_config: null,
          mcp_config_redacted: true,
        },
      },
    });

    const memberRestore = await app.request(`/api/agents/${createdBody.id}/restore`, {
      method: "POST",
      headers: jsonHeaders(memberToken.token),
    });
    expect(memberRestore.status).toBe(403);
    expect(await memberRestore.json()).toEqual({ error: "only the agent owner can manage this agent" });

    const ownerRestore = await app.request(`/api/agents/${createdBody.id}/restore`, {
      method: "POST",
      headers: jsonHeaders(ownerToken.token),
    });
    expect(ownerRestore.status).toBe(200);
    expect(await ownerRestore.json()).toMatchObject({
      id: createdBody.id,
      status: "active",
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });
    expect(events.find((event) => event.type === "agent:restored")).toMatchObject({
      actorId: "owner",
      payload: {
        agent: {
          id: createdBody.id,
          status: "active",
          mcp_config: null,
          mcp_config_redacted: true,
        },
      },
    });
  });

  it("gates agent env management like the Go server", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "owner", name: "Owner", role: "owner" });
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    store.createWorkspaceMember({ id: "member", name: "Member", role: "member" });
    const ownerToken = await store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "owner" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const memberToken = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "member" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const agent = store.createAgent({
      id: "agt_env_gate",
      name: "Env Gate",
      provider: "codex",
      ownerId: "member",
      customEnv: { SECRET_TOKEN: "real-value", KEEP_ME: "yes" },
    });

    const memberRead = await app.request(`/api/agents/${agent.id}/env`, { headers: headers(memberToken.token) });
    expect(memberRead.status).toBe(403);
    expect(await memberRead.json()).toEqual({ error: "insufficient permissions" });

    const memberWrite = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: headers(memberToken.token),
      body: JSON.stringify({ custom_env: { SECRET_TOKEN: "changed" } }),
    });
    expect(memberWrite.status).toBe(403);
    expect(await memberWrite.json()).toEqual({ error: "insufficient permissions" });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value", KEEP_ME: "yes" });

    const ownerRead = await app.request(`/api/agents/${agent.id}/env`, { headers: headers(ownerToken.token) });
    expect(ownerRead.status).toBe(200);
    expect(await ownerRead.json()).toEqual({
      agent_id: agent.id,
      custom_env: { SECRET_TOKEN: "real-value", KEEP_ME: "yes" },
    });

    const envTask = store.createTask({ agentId: agent.id, prompt: "env access" });
    const envTaskToken = await store.createTaskAccessToken(envTask, "owner");
    const taskTokenRead = await app.request(`/api/agents/${agent.id}/env`, { headers: headers(envTaskToken.token) });
    expect(taskTokenRead.status).toBe(403);
    expect(await taskTokenRead.json()).toEqual({ error: "this endpoint is only available to human actors" });

    const taskTokenWrite = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: headers(envTaskToken.token),
      body: JSON.stringify({ custom_env: { SECRET_TOKEN: "changed" } }),
    });
    expect(taskTokenWrite.status).toBe(403);
    expect(await taskTokenWrite.json()).toEqual({ error: "this endpoint is only available to human actors" });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value", KEEP_ME: "yes" });

    const invalidWrite = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: headers(ownerToken.token),
      body: "{",
    });
    expect(invalidWrite.status).toBe(400);
    expect(await invalidWrite.json()).toEqual({ error: "invalid request body" });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value", KEEP_ME: "yes" });

    const ownerWrite = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: headers(ownerToken.token),
      body: JSON.stringify({ custom_env: { SECRET_TOKEN: "****", ADDED: "new" } }),
    });
    expect(ownerWrite.status).toBe(200);
    expect(await ownerWrite.json()).toEqual({
      agent_id: agent.id,
      custom_env: { SECRET_TOKEN: "real-value", ADDED: "new" },
    });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value", ADDED: "new" });

    const adminClear = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: headers(adminToken.token),
      body: JSON.stringify({ custom_env: {} }),
    });
    expect(adminClear.status).toBe(200);
    expect(await adminClear.json()).toEqual({ agent_id: agent.id, custom_env: {} });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({});
  });

  it("syncs issue and autopilot run state when tasks finish", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const runtime = store.registerRuntime({ name: "local-claude", provider: "claude" });
    const project = store.createProject({ title: "Core" });
    const autopilot = store.createAutopilot({
      title: "Regression sweep",
      projectId: project.id,
      assigneeId: agent.id,
      issueTitleTemplate: "Sweep regressions",
    });
    const run = store.runAutopilot(autopilot.id);
    expect(store.getTask(run.taskId!)?.autopilotRunId).toBe(run.id);
    expect(store.getTaskWithAgent(run.taskId!)?.autopilotRunId).toBe(run.id);
    expect(store.listTasks().find((task) => task.id === run.taskId)?.autopilotRunId).toBe(run.id);

    const comment = store.createIssueComment(run.issueId!, { body: "Looks important" });
    expect(comment.body).toBe("Looks important");
    expect(store.listIssueActivity(run.issueId!)).toHaveLength(2);

    store.updateIssue(run.issueId!, { status: "in_progress" });
    expect(store.claimTask(runtime.id)?.id).toBe(run.taskId!);
    store.startTask(run.taskId!);
    store.completeTask(run.taskId!, { output: "fixed" });

    expect(store.getIssue(run.issueId!)?.status).toBe("done");
    expect(store.getProject(project.id)?.doneCount).toBe(1);
    expect(store.listAutopilotRuns(autopilot.id)[0]?.status).toBe("completed");
    // Completion appends task_completed, then the agent-reply comment_created.
    const activityTypes = store.listIssueActivity(run.issueId!).map((entry) => entry.type);
    expect(activityTypes).toContain("task_completed");
    expect(activityTypes.at(-1)).toBe("comment_created");
  });

  it("includes autopilot run ids in daemon task payloads", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Autopilot Claude", provider: "claude" });
    const runtime = store.registerRuntime({ name: "autopilot-runtime", provider: "claude" });
    const autopilot = store.createAutopilot({
      title: "Autopilot payload",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    const run = store.runAutopilot(autopilot.id);
    const app = createMultiremiApp({ store });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    const body = await claim.json();
    expect(body.task.id).toBe(run.taskId);
    expect(body.task.autopilot_run_id).toBe(run.id);
    expect(body.task.autopilotRunId).toBeUndefined();
  });

  it("schedules active cron autopilots and unschedules inactive ones", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Scheduled triage",
      assigneeId: agent.id,
      triggerKind: "schedule",
      cronExpression: "*/5 * * * * *",
      issueTitleTemplate: "Scheduled prompt",
    });
    const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 60_000 });

    scheduler.start();
    expect(scheduler.scheduledIds()).toContain(autopilot.id);

    const run = scheduler.trigger(autopilot.id);
    expect(run?.source).toBe("schedule");
    expect(store.getTask(run!.taskId!)?.prompt).toBe("Scheduled prompt");

    store.updateAutopilot(autopilot.id, { status: "paused" });
    scheduler.sync();
    expect(scheduler.scheduledIds()).not.toContain(autopilot.id);
    expect(scheduler.trigger(autopilot.id)).toBeNull();
    scheduler.stop();
  });

  it("claims due schedule triggers and recovers lost next_run_at like Go", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Trigger scheduled triage",
      assigneeId: agent.id,
      triggerKind: "manual",
      issueTitleTemplate: "Trigger scheduled prompt",
    });
    const trigger = store.createAutopilotTrigger(autopilot.id, {
      kind: "schedule",
      cronExpression: "*/5 * * * * *",
      timezone: "UTC",
      label: "Every five seconds",
    });
    expect(trigger.nextRunAt).toBeString();

    const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 60_000 });
    scheduler.sync();
    expect(scheduler.scheduledIds()).not.toContain(autopilot.id);

    db!.run("UPDATE multiremi_autopilot_triggers SET next_run_at = ? WHERE id = ?", [
      new Date(Date.now() - 1_000).toISOString(),
      trigger.id,
    ]);
    const runs = scheduler.tickDueTriggers();
    expect(runs).toHaveLength(1);
    expect(runs[0].source).toBe("schedule");
    expect(runs[0].payload).toMatchObject({
      cronExpression: "*/5 * * * * *",
      triggerId: trigger.id,
      trigger_id: trigger.id,
      timezone: "UTC",
    });
    expect(store.getTask(runs[0].taskId!)?.prompt).toBe("Trigger scheduled prompt");
    const advanced = store.getAutopilotTrigger(trigger.id)!;
    expect(advanced.nextRunAt).toBeString();
    expect(advanced.lastFiredAt).toBeString();

    db!.run("UPDATE multiremi_autopilot_triggers SET next_run_at = NULL WHERE id = ?", [trigger.id]);
    expect(store.recoverLostScheduleTriggers()).toBe(1);
    expect(store.getAutopilotTrigger(trigger.id)!.nextRunAt).toBeString();
    scheduler.stop();
  });

  it("claims due schedule triggers atomically across sqlite connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "multiremi-schedule-claim-"));
    const path = join(dir, "multiremi.db");
    const dbA = new Database(path);
    const dbB = new Database(path);
    try {
      const storeA = new MultiremiStore(dbA);
      const storeB = new MultiremiStore(dbB);
      const agent = storeA.createAgent({ name: "Codex", provider: "codex" });
      const autopilot = storeA.createAutopilot({
        title: "Atomic trigger claim",
        assigneeId: agent.id,
        triggerKind: "manual",
      });
      const trigger = storeA.createAutopilotTrigger(autopilot.id, {
        kind: "schedule",
        cronExpression: "*/5 * * * * *",
        timezone: "UTC",
      });
      dbA.run("UPDATE multiremi_autopilot_triggers SET next_run_at = ? WHERE id = ?", [
        new Date(Date.now() - 1_000).toISOString(),
        trigger.id,
      ]);

      const first = storeA.claimDueScheduleTriggers();
      const second = storeB.claimDueScheduleTriggers();
      const claimedIds = [...first, ...second].map((item) => item.id);
      expect(claimedIds.filter((id) => id === trigger.id)).toHaveLength(1);
      expect(storeA.getAutopilotTrigger(trigger.id)?.nextRunAt).toBeNull();
    } finally {
      dbA.close();
      dbB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-pauses active autopilots exceeding the Go failure-rate threshold", () => {
    const store = createStore();
    const creator = store.createWorkspaceMember({ id: "mem_failure_creator", name: "Failure Creator", workspaceId: "local" });
    const owner = store.createWorkspaceMember({ id: "mem_failure_owner", name: "Failure Owner", workspaceId: "local" });
    const agent = store.createAgent({ name: "Codex", provider: "codex", ownerId: owner.id });
    const offender = store.createAutopilot({
      title: "Failure loop",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "member",
      createdById: creator.id,
    });
    const skippedDiluted = store.createAutopilot({
      title: "Failure loop with skips",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "agent",
      createdById: agent.id,
    });
    const outsideLookback = store.createAutopilot({
      title: "Old failures",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "member",
      createdById: creator.id,
    });
    const belowThreshold = store.createAutopilot({
      title: "Mixed outcomes",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "member",
      createdById: creator.id,
    });
    const now = new Date();
    let seq = 0;
    const insertRun = (autopilotId: string, status: "completed" | "failed" | "skipped", createdAt: Date) => {
      const at = createdAt.toISOString();
      db!.run(
        `INSERT INTO multiremi_autopilot_runs (
          id, autopilot_id, source, status, issue_id, task_id, triggered_at,
          completed_at, failure_reason, payload, result, created_at
        ) VALUES (?, ?, 'schedule', ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?)`,
        [
          `run_failure_monitor_${++seq}`,
          autopilotId,
          status,
          at,
          at,
          status === "failed" ? "agent_error" : status === "skipped" ? "No runnable agent" : null,
          at,
        ],
      );
    };
    const recent = new Date(now.getTime() - 60 * 60 * 1000);
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 11; i++) insertRun(offender.id, "failed", recent);
    insertRun(offender.id, "completed", recent);
    for (let i = 0; i < 9; i++) insertRun(skippedDiluted.id, "failed", recent);
    insertRun(skippedDiluted.id, "completed", recent);
    for (let i = 0; i < 100; i++) insertRun(skippedDiluted.id, "skipped", recent);
    for (let i = 0; i < 12; i++) insertRun(outsideLookback.id, "failed", old);
    for (let i = 0; i < 8; i++) insertRun(belowThreshold.id, "failed", recent);
    for (let i = 0; i < 4; i++) insertRun(belowThreshold.id, "completed", recent);

    const events: Array<{ type: string; payload: Record<string, unknown>; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));
    const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 60_000, failureMonitorIntervalMs: 0 });
    const paused = scheduler.runFailureMonitorOnce({
      since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      minRuns: 10,
      failRatioThreshold: 0.9,
    });

    expect(paused.map((candidate) => candidate.autopilot.id)).toEqual([offender.id, skippedDiluted.id]);
    expect(paused.map((candidate) => [candidate.failedRuns, candidate.totalRuns])).toEqual([[11, 12], [9, 10]]);
    expect(store.getAutopilot(offender.id)?.status).toBe("paused");
    expect(store.getAutopilot(skippedDiluted.id)?.status).toBe("paused");
    expect(store.getAutopilot(outsideLookback.id)?.status).toBe("active");
    expect(store.getAutopilot(belowThreshold.id)?.status).toBe("active");

    const updateEvents = events.filter((event) => event.type === "autopilot:updated");
    expect(updateEvents).toHaveLength(2);
    expect(updateEvents.map((event) => (event.payload.autopilot as { id: string }).id)).toEqual([offender.id, skippedDiluted.id]);
    expect(updateEvents.every((event) => event.actorType === "system")).toBe(true);
    expect(updateEvents.every((event) => event.payload.reason === "auto_paused_high_failure_rate")).toBe(true);
    const inboxEvents = events.filter((event) => event.type === "inbox:new");
    expect(inboxEvents).toHaveLength(2);
    expect(inboxEvents.map((event) => (event.payload.item as { memberId: string }).memberId).sort()).toEqual([creator.id, owner.id].sort());

    const creatorInbox = store.listInboxItems(creator.id).find((item) => item.type === "autopilot_paused")!;
    expect(creatorInbox.issueId).toBeNull();
    expect(creatorInbox.severity).toBe("attention");
    expect(creatorInbox.details).toMatchObject({
      autopilot_id: offender.id,
      failed_runs: 11,
      total_runs: 12,
      threshold_min_runs: 10,
      threshold_fail_ratio: 0.9,
      reason: "auto_paused_high_failure_rate",
    });
    const ownerInbox = store.listInboxItems(owner.id).find((item) => item.type === "autopilot_paused")!;
    expect(ownerInbox.issueId).toBeNull();
    expect(ownerInbox.details).toMatchObject({ autopilot_id: skippedDiluted.id, failed_runs: 9, total_runs: 10 });
    expect(scheduler.runFailureMonitorOnce({ since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), minRuns: 10 })).toEqual([]);
  });

  it("records Go-style autopilot analytics events and metrics", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_autopilot_analytics", name: "Autopilot analytics", provider: "codex" });
    const agent = store.createAgent({ name: "Analytics Codex", provider: "codex", runtimeId: runtime.id });
    const autopilot = store.createAutopilot({
      title: "Analytics autopilot",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "member",
      createdById: "usr_analytics",
    });

    const created = store.listAnalyticsEvents({ name: "autopilot_created" })[0]!;
    expect(created.metricsOnly).toBe(false);
    expect(created.distinctId).toBe("usr_analytics");
    expect(created.workspaceId).toBe("local");
    expect(created.properties).toMatchObject({
      autopilot_id: autopilot.id,
      cadence: "manual",
      trigger_kind: "manual",
      source: "manual",
      user_id: "usr_analytics",
      is_demo: false,
    });
    expect(metricValue(store, "multiremi_autopilot_created_total", { cadence: "manual" })).toBe(1);

    const completedRun = store.runAutopilot(autopilot.id, { source: "webhook" });
    expect(store.claimTask(runtime.id)?.id).toBe(completedRun.taskId!);
    store.startTask(completedRun.taskId!);
    store.completeTask(completedRun.taskId!, { output: "done" });

    const started = store.listAnalyticsEvents({ name: "autopilot_run_started" })[0]!;
    expect(started.metricsOnly).toBe(true);
    expect(started.properties).toMatchObject({
      autopilot_id: autopilot.id,
      autopilot_run_id: completedRun.id,
      agent_id: agent.id,
      assignee_type: "agent",
      trigger_source: "webhook",
      trigger_kind: "webhook",
      cadence: "webhook",
      source: "autopilot",
      user_id: "usr_analytics",
      is_demo: false,
    });
    const completed = store.listAnalyticsEvents({ name: "autopilot_run_completed" })[0]!;
    expect(completed.properties).toMatchObject({
      autopilot_id: autopilot.id,
      autopilot_run_id: completedRun.id,
      trigger_kind: "webhook",
      duration_ms: expect.any(Number),
    });
    expect(metricValue(store, "multiremi_autopilot_run_started_total", { cadence: "webhook", trigger_kind: "webhook" })).toBe(1);
    expect(metricValue(store, "multiremi_autopilot_run_terminal_total", { cadence: "webhook", trigger_kind: "webhook", terminal_status: "completed" })).toBe(1);

    const failingAutopilot = store.createAutopilot({
      title: "Failing analytics autopilot",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "agent",
      createdById: agent.id,
    });
    const failedRun = store.runAutopilot(failingAutopilot.id, { source: "schedule" });
    expect(store.claimTask(runtime.id)?.id).toBe(failedRun.taskId!);
    store.startTask(failedRun.taskId!);
    store.failTask(failedRun.taskId!, { error: "task crashed" });

    const failed = store.listAnalyticsEvents({ name: "autopilot_run_failed" })[0]!;
    expect(failed.distinctId).toBe(`agent:${agent.id}`);
    expect(failed.properties).toMatchObject({
      autopilot_id: failingAutopilot.id,
      autopilot_run_id: failedRun.id,
      agent_id: agent.id,
      trigger_source: "schedule",
      trigger_kind: "schedule",
      cadence: "schedule",
      source: "autopilot",
      failure_reason: "task crashed",
      error_type: "task_error",
      will_retry: false,
    });
    expect(failed.properties).not.toHaveProperty("user_id");
    expect(store.listAnalyticsEvents({ includeMetricsOnly: false }).map((event) => event.name)).toEqual([
      "autopilot_created",
      "autopilot_created",
    ]);
    expect(metricValue(store, "multiremi_autopilot_run_terminal_total", { cadence: "unknown", trigger_kind: "schedule", terminal_status: "failed" })).toBe(1);
  });

  it("records, deduplicates, ignores, rejects, and replays webhook deliveries", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Webhook delivery",
      assigneeId: agent.id,
      triggerKind: "webhook",
    });

    const first = store.handleAutopilotWebhook(autopilot.id, {
      payload: { prompt: "Delivery prompt", event: "opened" },
      prompt: "Delivery prompt",
      rawBody: JSON.stringify({ prompt: "Delivery prompt", event: "opened" }),
      headers: { "Idempotency-Key": "delivery-1", "Content-Type": "application/json" },
    });

    expect(first.status).toBe("accepted");
    expect(first.delivery.status).toBe("dispatched");
    expect(first.delivery.dedupeKey).toBe("delivery-1");
    expect(first.delivery.contentType).toBe("application/json");
    expect(first.delivery.selectedHeaders).toEqual({ "idempotency-key": "delivery-1" });
    expect(first.run?.source).toBe("webhook");
    expect(first.run?.payload).toMatchObject({
      event: "opened",
      eventPayload: { prompt: "Delivery prompt", event: "opened" },
      request: { contentType: "application/json" },
    });
    expect(store.getIssue(first.run!.issueId!)?.title).toBe("Delivery prompt");

    const duplicate = store.handleAutopilotWebhook(autopilot.id, {
      payload: { prompt: "Duplicate prompt" },
      headers: { "Idempotency-Key": "delivery-1" },
    });
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.delivery.id).toBe(first.delivery.id);
    expect(duplicate.delivery.attemptCount).toBe(2);
    expect(store.listWebhookDeliveries(autopilot.id)).toHaveLength(1);

    const replay = store.replayWebhookDelivery(autopilot.id, first.delivery.id);
    expect(replay.status).toBe("accepted");
    expect(replay.delivery.replayedFromDeliveryId).toBe(first.delivery.id);
    expect(store.listWebhookDeliveries(autopilot.id)).toHaveLength(2);

    const rejected = store.handleAutopilotWebhook(autopilot.id, {
      payload: { prompt: "Bad signature" },
      signatureStatus: "invalid",
      headers: { "Idempotency-Key": "bad-signature" },
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.delivery.status).toBe("rejected");
    expect(() => store.replayWebhookDelivery(autopilot.id, rejected.delivery.id)).toThrow("Cannot replay");

    store.updateAutopilot(autopilot.id, { status: "paused" });
    const ignored = store.handleAutopilotWebhook(autopilot.id, {
      payload: { prompt: "Paused" },
      headers: { "Idempotency-Key": "paused-delivery" },
    });
    expect(ignored.status).toBe("ignored");
    expect(ignored.delivery.status).toBe("ignored");
    expect(ignored.run).toBeNull();

    store.updateAutopilot(autopilot.id, { status: "active" });
    const filteredTrigger = store.createAutopilotTrigger(autopilot.id, {
      kind: "webhook",
      label: "Pull request opened only",
      eventFilters: [{ event: "pull_request", actions: ["opened"] }],
    });
    const filtered = store.handleAutopilotWebhook(autopilot.id, {
      payload: { action: "closed" },
      rawBody: JSON.stringify({ action: "closed" }),
      headers: { "X-GitHub-Event": "pull_request", "Idempotency-Key": "filtered-delivery" },
      provider: "github",
      triggerId: filteredTrigger.id,
    });
    expect(filtered.status).toBe("ignored");
    expect(filtered.delivery.error).toBe("event_filtered");
    expect(filtered.run).toBeNull();

    const allowed = store.handleAutopilotWebhook(autopilot.id, {
      payload: { action: "opened" },
      rawBody: JSON.stringify({ action: "opened" }),
      headers: { "X-GitHub-Event": "pull_request", "Idempotency-Key": "allowed-delivery" },
      provider: "github",
      triggerId: filteredTrigger.id,
    });
    expect(allowed.status).toBe("accepted");
    expect(allowed.run?.payload).toMatchObject({
      event: "github.pull_request.opened",
      eventPayload: { action: "opened" },
    });

    const typed = store.handleAutopilotWebhook(autopilot.id, {
      payload: { action: "published" },
      rawBody: "\uFEFF" + JSON.stringify({ action: "published" }),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Idempotency-Key": "typed-delivery",
        "User-Agent": "WebhookClient/1.0",
        "X-Event-Type": "deploy.published",
        "X-Hub-Signature-256": "sha256=redacted",
      },
    });
    expect(typed.status).toBe("accepted");
    expect(typed.delivery.contentType).toBe("application/json");
    expect(typed.delivery.selectedHeaders).toEqual({
      "user-agent": "WebhookClient/1.0",
      "x-event-type": "deploy.published",
      "idempotency-key": "typed-delivery",
      "x-hub-signature-256-present": true,
    });
    expect(typed.run?.payload).toMatchObject({
      event: "deploy.published",
      eventPayload: { action: "published" },
      request: { contentType: "application/json" },
    });
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "generic", status: "dispatched" })).toBe(3);
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "github", status: "dispatched" })).toBe(1);
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "generic", status: "rejected" })).toBe(1);
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "generic", status: "ignored" })).toBe(1);
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "github", status: "ignored" })).toBe(1);
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "generic", status: "duplicate" })).toBe(0);
  });
});

describe("Bun Multiremi CLI", () => {
  it("detects supported daemon providers from PATH", () => {
    const pathEnv = ["/mock/bin", "/other/bin"].join(delimiter);

    expect(detectMultiremiProviders({
      pathEnv,
      canExecute: (path) => path === join("/mock/bin", "claude") || path === join("/other/bin", "codex"),
    })).toEqual(["claude", "codex"]);

    expect(detectMultiremiProviders({
      pathEnv,
      canExecute: (path) => path === "/mock/bin/gemini",
    })).toEqual([]);
  });
});

describe("Bun Multiremi API", () => {
  it("serves Multiremi daemon install commands and mints daemon tokens", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const preview = await app.request("/api/multiremi/install/daemon?server_url=https%3A%2F%2Fremi.example&workspace_id=ws_1&token=tok_123&provider=codex&version=v1.2.3");
    const previewBody = await preview.json();
    expect(preview.status).toBe(200);
    expect(previewBody.product).toBe("multiremi");
    expect(previewBody.installScriptUrl).toBe("https://github.com/Grassgod/remi/releases/download/v1.2.3/install-multiremi.sh");
    expect(previewBody.installCommand).toBe("curl -fsSL https://github.com/Grassgod/remi/releases/download/v1.2.3/install-multiremi.sh | bash");
    expect(previewBody.setupCommand).toBe("multiremi setup --server https://remi.example --workspace ws_1 --token tok_123 --provider codex");
    expect(previewBody.daemonCommand).toBe("multiremi daemon");
    expect(previewBody.installCommand).not.toContain("multimira");
    expect(previewBody.setupCommand).not.toContain("multica");
    expect(/\bremi setup\b/.test(previewBody.setupCommand)).toBe(false);

    const unsupportedProvider = await app.request("/api/multiremi/install/daemon?provider=gemini");
    expect(unsupportedProvider.status).toBe(400);
    expect(await unsupportedProvider.json()).toEqual({ error: "Unsupported Multiremi runtime provider: gemini" });

    const minted = await app.request("/api/multiremi/install/daemon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverUrl: "https://remi.example", workspaceId: "local", provider: "claude" }),
    });
    const mintedBody = await minted.json();

    expect(minted.status).toBe(201);
    expect(mintedBody.token).toStartWith("mdt_");
    expect(mintedBody.tokenId).toStartWith("dtk_");
    expect(mintedBody.setupCommand).toContain("--token mdt_");
    expect(mintedBody.setupCommand).toContain("--provider claude");
    expect(mintedBody.commands.map((command: any) => command.key)).toEqual(["install", "setup", "daemon"]);
    expect(store.listAccessTokens("local")[0]).toMatchObject({ id: mintedBody.tokenId, type: "daemon" });
  });

  it("serves daemon websocket upgrades and realtime health", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_ws", name: "WS runtime", provider: "codex" });
    const agent = store.createAgent({ name: "WS Codex", provider: "codex" });
    const updateRequest = store.createRuntimeUpdateRequest(runtime.id, { target_version: "v3.0.0" });
    const modelRequest = store.createRuntimeModelListRequest(runtime.id);
    const localSkillRequest = store.createRuntimeLocalSkillListRequest(runtime.id);
    const importOne = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "ws-one" });
    const importTwo = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "ws-two" });
    const camelRuntime = store.registerRuntime({ id: "rt_ws_camel", name: "Camel WS runtime", provider: "codex" });
    const camelImportOne = store.createRuntimeLocalSkillImportRequest(camelRuntime.id, { skill_key: "ws-camel-one" });
    const camelImportTwo = store.createRuntimeLocalSkillImportRequest(camelRuntime.id, { skill_key: "ws-camel-two" });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1" });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      await expectWebSocketRejected(new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtimeId=rt_ws_camel`));
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws`);
      const ready = await nextWebSocketMessage(ws);
      expect(ready).toMatchObject({ type: "ready", transport: "websocket", runtime_id: "rt_ws", runtime_ids: ["rt_ws"] });
      const camelWs = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_camel`);
      expect(await nextWebSocketMessage(camelWs)).toMatchObject({ type: "ready", runtime_id: "rt_ws_camel" });

      camelWs.send(JSON.stringify({
        type: "daemon:heartbeat",
        payload: { runtimeId: "rt_ws_camel", supports_batch_import: true },
      }));
      await expectNoWebSocketMessage(camelWs);

      camelWs.send(JSON.stringify({
        type: "daemon:heartbeat",
        payload: { runtime_id: "rt_ws_camel", supportsBatchImport: true },
      }));
      const camelHeartbeatAck = await nextWebSocketMessage(camelWs);
      expect(camelHeartbeatAck).toMatchObject({
        type: "daemon:heartbeat_ack",
        payload: {
          runtime_id: "rt_ws_camel",
          status: "ok",
          pending_local_skill_import: { id: camelImportOne.id, skill_key: "ws-camel-one" },
        },
      });
      expect(camelHeartbeatAck.payload.pending_local_skill_imports).toBeUndefined();
      expect(store.getRuntimeLocalSkillImportRequest(camelRuntime.id, camelImportTwo.id)?.status).toBe("pending");
      camelWs.close();
      await Bun.sleep(25);

      const connectedHealth = await fetch(`${baseUrl}/health/realtime`);
      expect(await connectedHealth.json()).toMatchObject({ enabled: true, connections: 1, transport: "websocket" });

      ws.send(JSON.stringify({ type: "ping", runtime_id: "rt_ws" }));
      const pong = await nextWebSocketMessage(ws);
      expect(pong).toMatchObject({ type: "pong", received_type: "ping", runtime_id: "rt_ws", ok: true });

      const queued = store.createTask({ agentId: agent.id, prompt: "wake runtime" });
      const wakeup = await nextWebSocketMessage(ws);
      expect(wakeup).toMatchObject({
        type: "daemon:task_available",
        payload: { runtime_id: "rt_ws", task_id: queued.id },
      });

      expect(store.claimTask(runtime.id)?.id).toBe(queued.id);
      store.markTaskWaitingLocalDirectory(queued.id, "/tmp/ws-runtime");
      const waiting = await nextWebSocketMessage(ws);
      expect(waiting).toMatchObject({
        type: "task:waiting_local_directory",
        payload: {
          runtime_id: "rt_ws",
          task_id: queued.id,
          status: "waiting_local_directory",
          wait_reason: "/tmp/ws-runtime",
        },
      });

      ws.send(JSON.stringify({
        type: "daemon:heartbeat",
        payload: { runtime_id: "rt_ws", supports_batch_import: true },
      }));
      const heartbeatAck = await nextWebSocketMessage(ws);
      expect(heartbeatAck).toMatchObject({
        type: "daemon:heartbeat_ack",
        payload: {
          runtime_id: "rt_ws",
          status: "ok",
          pending_update: { id: updateRequest.id, target_version: "v3.0.0" },
          pending_model_list: { id: modelRequest.id },
          pending_local_skills: { id: localSkillRequest.id },
          pending_local_skill_import: { id: importOne.id, skill_key: "ws-one" },
        },
      });
      expect(heartbeatAck.payload.pending_local_skill_imports.map((item: any) => item.id)).toEqual([importOne.id, importTwo.id]);

      store.deleteRuntime(runtime.id);
      ws.send(JSON.stringify({
        type: "daemon:heartbeat",
        payload: { runtime_id: "rt_ws" },
      }));
      const runtimeGoneAck = await nextWebSocketMessage(ws);
      expect(runtimeGoneAck).toMatchObject({
        type: "daemon:heartbeat_ack",
        payload: { runtime_id: "rt_ws", status: "runtime_gone", runtime_gone: true },
      });

      ws.close();
      await Bun.sleep(25);

      const closedHealth = await fetch(`${baseUrl}/health/realtime`);
      expect(await closedHealth.json()).toMatchObject({ enabled: true, connections: 0, transport: "websocket" });
    } finally {
      server.stop(true);
    }
  });

  it("serves browser workspace websocket fanout with workspace isolation", async () => {
    const store = createStore();
    const localRuntime = store.registerRuntime({ id: "rt_browser_local", name: "Browser local runtime", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Browser Claude", provider: "claude" });
    const remoteWorkspace = store.createWorkspace({ id: "ws_browser_remote", name: "Browser Remote", slug: "browser-remote" });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: "local", title: "Private browser chat" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "local", name: "Local", role: "owner" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "other-user", name: "Other Local", role: "member" });
    store.createWorkspaceMember({ workspaceId: remoteWorkspace.id, userId: "local", name: "Local", role: "owner" });
    const localToken = await store.createAccessToken({ name: "Local browser", type: "pat", workspaceId: "local" });
    const otherLocalToken = await store.createAccessToken({ name: "Other local browser", type: "pat", workspaceId: "local", userId: "other-user" });
    const remoteToken = await store.createAccessToken({ name: "Remote browser", type: "pat", workspaceId: remoteWorkspace.id });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1" });
    const local = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_slug=local`);
    const remote = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${remoteWorkspace.id}`);
    const otherLocal = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=local`);
    const jwtUpgrade = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_slug=local`, {
      headers: { Authorization: `Bearer ${signTestJwt({ sub: "local", exp: Math.floor(Date.now() / 1000) + 60 })}` },
    } as any);
    const jwtForbidden = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${remoteWorkspace.id}`, {
      headers: { Authorization: `Bearer ${signTestJwt({ sub: "ghost-user", exp: Math.floor(Date.now() / 1000) + 60 })}` },
    } as any);
    try {
      expect(await nextWebSocketMessage(jwtUpgrade)).toMatchObject({ type: "auth_ack" });
      jwtUpgrade.close();
      await expectWebSocketRejected(jwtForbidden);

      await authenticateBrowserWebSocket(local, localToken.token);
      await authenticateBrowserWebSocket(remote, remoteToken.token);
      await authenticateBrowserWebSocket(otherLocal, otherLocalToken.token);

      const localTask = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "local browser realtime" });
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "task:queued",
        payload: {
          task_id: localTask.id,
          workspace_id: "local",
          status: "queued",
        },
        actor_id: agent.id,
        actor_type: "agent",
      });
      expect(await nextWebSocketMessage(otherLocal)).toMatchObject({
        type: "task:queued",
        payload: { task_id: localTask.id, workspace_id: "local" },
      });
      await expectNoWebSocketMessage(remote);

      local.send(JSON.stringify({ type: "ping" }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "pong" });
      local.send(JSON.stringify({ type: "subscribe", payload: { scope: "workspace", id: "local" } }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "subscribe_ack", payload: { scope: "workspace", id: "local" } });
      local.send(JSON.stringify({ type: "subscribe", payload: { scope: "user", id: "local" } }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "subscribe_ack", payload: { scope: "user", id: "local" } });
      local.send(JSON.stringify({ type: "subscribe", payload: { scope: "task", id: localTask.id } }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "subscribe_ack", payload: { scope: "task", id: localTask.id } });
      local.send(JSON.stringify({ type: "subscribe", payload: { scope: "chat", id: chat.id } }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "subscribe_ack", payload: { scope: "chat", id: chat.id } });
      local.send(JSON.stringify({ type: "subscribe", payload: { scope: "unknown", id: "scope-1" } }));
      expect(await nextWebSocketMessage(local)).toEqual({
        type: "subscribe_error",
        payload: { scope: "unknown", id: "scope-1", error: "unknown_scope" },
      });
      otherLocal.send(JSON.stringify({ type: "subscribe", payload: { scope: "chat", id: chat.id } }));
      expect(await nextWebSocketMessage(otherLocal)).toEqual({
        type: "subscribe_error",
        payload: { scope: "chat", id: chat.id, error: "forbidden" },
      });
      local.send(JSON.stringify({ type: "unsubscribe", payload: { scope: "task", id: localTask.id } }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "unsubscribe_ack", payload: { scope: "task", id: localTask.id } });

      const remoteTask = store.createTask({ agentId: agent.id, workspaceId: remoteWorkspace.id, prompt: "remote browser realtime" });
      expect(await nextWebSocketMessage(remote)).toMatchObject({
        type: "task:queued",
        payload: {
          task_id: remoteTask.id,
          workspace_id: remoteWorkspace.id,
          status: "queued",
        },
      });
      await expectNoWebSocketMessage(local);

      expect(store.claimTask(localRuntime.id)?.id).toBe(localTask.id);
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "task:dispatch",
        payload: {
          task_id: localTask.id,
          runtime_id: localRuntime.id,
          status: "dispatched",
        },
      });
      store.markTaskWaitingLocalDirectory(localTask.id, "/tmp/browser-local");
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "task:waiting_local_directory",
        payload: {
          task_id: localTask.id,
          wait_reason: "/tmp/browser-local",
          status: "waiting_local_directory",
        },
      });
      store.startTask(localTask.id);
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "task:running",
        payload: {
          task_id: localTask.id,
          status: "running",
        },
      });
      store.completeTask(localTask.id, { output: "done", sessionId: "sess-browser", workDir: "/tmp/browser-local" });
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "task:completed",
        payload: {
          task_id: localTask.id,
          status: "completed",
          session_id: "sess-browser",
          work_dir: "/tmp/browser-local",
          result: "done",
        },
      });
    } finally {
      local.close();
      remote.close();
      otherLocal.close();
      jwtUpgrade.close();
      jwtForbidden.close();
      server.stop(true);
    }
  });

  it("routes chat realtime events privately to the chat creator scope", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat Claude", provider: "claude", workspaceId: "local" });
    const runtime = store.registerRuntime({ id: "rt_chat_realtime", name: "chat runtime", provider: "claude", workspaceId: "local" });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: "local", title: "Private chat" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "local", name: "Creator", role: "owner" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "peer-user", name: "Workspace peer", role: "member" });
    const creatorToken = await store.createAccessToken({ name: "Creator", type: "pat", workspaceId: "local", userId: "local" });
    const peerToken = await store.createAccessToken({ name: "Workspace peer", type: "pat", workspaceId: "local", userId: "peer-user" });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1" });
    const creator = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_slug=local`);
    const peer = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=local`);
    const creatorMessages: any[] = [];
    const peerMessages: any[] = [];
    try {
      await authenticateBrowserWebSocket(creator, creatorToken.token);
      await authenticateBrowserWebSocket(peer, peerToken.token);

      creator.send(JSON.stringify({ type: "subscribe", payload: { scope: "chat", id: chat.id } }));
      expect(await nextWebSocketMessage(creator)).toEqual({ type: "subscribe_ack", payload: { scope: "chat", id: chat.id } });
      // A workspace peer cannot subscribe to a chat it does not own.
      peer.send(JSON.stringify({ type: "subscribe", payload: { scope: "chat", id: chat.id } }));
      expect(await nextWebSocketMessage(peer)).toEqual({
        type: "subscribe_error",
        payload: { scope: "chat", id: chat.id, error: "forbidden" },
      });

      // Accumulate every frame each socket receives from here on.
      creator.addEventListener("message", (event) => creatorMessages.push(JSON.parse(String(event.data))));
      peer.addEventListener("message", (event) => peerMessages.push(JSON.parse(String(event.data))));

      const sent = store.sendChatMessage(chat.id, { body: "hello private" });
      expect(store.claimTask(runtime.id)?.id).toBe(sent.task.id);
      store.startTask(sent.task.id);
      store.completeTask(sent.task.id, { output: "all done", sessionId: "sess-chat", workDir: "/tmp/chat" });
      store.markChatSessionRead(chat.id);
      store.updateChatSession(chat.id, { title: "Renamed chat" });
      store.deleteChatSession(chat.id);

      // Let the asynchronous websocket delivery settle.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const first = (type: string) => creatorMessages.find((m) => m.type === type);
      expect(first("chat:message")).toMatchObject({
        type: "chat:message",
        payload: { chat_session_id: chat.id, message_id: sent.message.id, role: "user", content: "hello private", task_id: sent.task.id },
      });
      expect(first("chat:done")).toMatchObject({
        type: "chat:done",
        actor_type: "system",
        payload: { chat_session_id: chat.id, task_id: sent.task.id, content: "all done" },
      });
      expect(first("chat:session_read")).toMatchObject({ type: "chat:session_read", payload: { chat_session_id: chat.id } });
      expect(first("chat:session_updated")).toMatchObject({
        type: "chat:session_updated",
        payload: { chat_session_id: chat.id, title: "Renamed chat" },
      });
      expect(first("chat:session_deleted")).toMatchObject({ type: "chat:session_deleted", payload: { chat_session_id: chat.id } });
      // Chat-linked task lifecycle (which carries the assistant result text) stays on the private chat scope.
      expect(first("task:completed")?.payload).toMatchObject({ task_id: sent.task.id, chat_session_id: chat.id, result: "all done" });
      // The workspace peer must never receive any private chat session traffic.
      expect(peerMessages).toEqual([]);
    } finally {
      creator.close();
      peer.close();
      server.stop(true);
    }
  });

  it("routes workspace member and invitation realtime events like Go", async () => {
    const store = createStore();
    const localWorkspace = store.ensureLocalWorkspace();
    const localOwner = store.getWorkspaceMember(`mem_${localWorkspace.id}_local`)!;
    store.createWorkspaceMember({
      id: "mem_browser_realtime_backup",
      workspaceId: localWorkspace.id,
      name: "Browser Realtime Backup",
      email: "browser-realtime-backup@example.com",
      role: "owner",
    });
    const remoteWorkspace = store.createWorkspace({ id: "ws_browser_events_remote", name: "Browser Events Remote", slug: "browser-events-remote" });
    store.createWorkspaceMember({
      id: `mem_${remoteWorkspace.id}_admin-user`,
      workspaceId: remoteWorkspace.id,
      name: "Remote Admin",
      email: "remote-admin@example.com",
      role: "owner",
    });
    db!.run("DELETE FROM multiremi_workspace_members WHERE id = ?", [`mem_${remoteWorkspace.id}_local`]);
    const localToken = await store.createAccessToken({ name: "Local browser events", type: "pat", workspaceId: localWorkspace.id });
    const remoteToken = await store.createAccessToken({
      name: "Remote browser events",
      type: "pat",
      workspaceId: remoteWorkspace.id,
      userId: "admin-user",
    });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "test-root", port: 0, hostname: "127.0.0.1" });
    const local = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${localWorkspace.id}`);
    const remote = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${remoteWorkspace.id}`);
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      await authenticateBrowserWebSocket(local, localToken.token);
      await authenticateBrowserWebSocket(remote, remoteToken.token);

      const updatedEvent = nextWebSocketMessage(local);
      const updated = await fetch(`${baseUrl}/api/workspaces/${localWorkspace.id}/members/${localOwner.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${localToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "admin" }),
      });
      expect(updated.status).toBe(200);
      expect(await updatedEvent).toMatchObject({
        type: "member:updated",
        payload: {
          member: {
            id: localOwner.id,
            workspace_id: localWorkspace.id,
            user_id: "local",
            role: "admin",
          },
        },
        actor_id: "local",
        actor_type: "member",
      });
      await expectNoWebSocketMessage(remote);

      const invited = await fetch(`${baseUrl}/api/workspaces/${localWorkspace.id}/members`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: "browser-invite@example.com", role: "member" }),
      });
      expect(invited.status).toBe(201);
      const invitedBody = await invited.json();
      await expectNoWebSocketMessage(local);
      await expectNoWebSocketMessage(remote);

      const revoked = await fetch(`${baseUrl}/api/workspaces/${localWorkspace.id}/invitations/${invitedBody.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${localToken.token}` },
      });
      expect(revoked.status).toBe(204);
      await expectNoWebSocketMessage(local);
      await expectNoWebSocketMessage(remote);

      const localInviteCreatedEvent = nextWebSocketMessage(local);
      const localInviteCreated = await fetch(`${baseUrl}/api/workspaces/${remoteWorkspace.id}/members`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${remoteToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: store.getCurrentUser().email, role: "member" }),
      });
      expect(localInviteCreated.status).toBe(201);
      const localInviteBody = await localInviteCreated.json();
      expect(await localInviteCreatedEvent).toMatchObject({
        type: "invitation:created",
        payload: {
          invitation: {
            id: localInviteBody.id,
            workspace_id: remoteWorkspace.id,
            invitee_email: store.getCurrentUser().email,
            invitee_user_id: "local",
            role: "member",
            status: "pending",
          },
          workspace_name: remoteWorkspace.name,
        },
        actor_id: "admin-user",
        actor_type: "member",
      });
      await expectNoWebSocketMessage(remote);

      const localInviteRevokedEvent = nextWebSocketMessage(local);
      const localInviteRevoked = await fetch(`${baseUrl}/api/workspaces/${remoteWorkspace.id}/invitations/${localInviteBody.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${remoteToken.token}` },
      });
      expect(localInviteRevoked.status).toBe(204);
      expect(await localInviteRevokedEvent).toMatchObject({
        type: "invitation:revoked",
        payload: {
          invitation_id: localInviteBody.id,
          invitee_email: store.getCurrentUser().email,
          invitee_user_id: "local",
        },
        actor_id: "admin-user",
        actor_type: "member",
      });
      await expectNoWebSocketMessage(remote);

      const acceptedInviteCreatedEvent = nextWebSocketMessage(local);
      const acceptedInviteCreated = await fetch(`${baseUrl}/api/workspaces/${remoteWorkspace.id}/members`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${remoteToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: store.getCurrentUser().email, role: "member" }),
      });
      expect(acceptedInviteCreated.status).toBe(201);
      const acceptedInviteBody = await acceptedInviteCreated.json();
      expect(await acceptedInviteCreatedEvent).toMatchObject({ type: "invitation:created" });
      await expectNoWebSocketMessage(remote);

      const localMemberAddedEvent = nextWebSocketMessage(local);
      const remoteAcceptedEvents = nextWebSocketMessages(remote, 2);
      const accepted = await fetch(`${baseUrl}/api/invitations/${acceptedInviteBody.id}/accept`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localToken.token}` },
      });
      expect(accepted.status).toBe(200);
      expect(await localMemberAddedEvent).toMatchObject({
        type: "member:added",
        payload: {
          member: {
            workspace_id: remoteWorkspace.id,
            user_id: "local",
            role: "member",
          },
          workspace_name: remoteWorkspace.name,
        },
        actor_id: "local",
        actor_type: "member",
      });
      const [remoteMemberAddedEvent, remoteInvitationAcceptedEvent] = await remoteAcceptedEvents;
      expect(remoteMemberAddedEvent).toMatchObject({
        type: "member:added",
        payload: {
          member: {
            workspace_id: remoteWorkspace.id,
            user_id: "local",
            role: "member",
          },
          workspace_name: remoteWorkspace.name,
        },
      });
      expect(remoteInvitationAcceptedEvent).toMatchObject({
        type: "invitation:accepted",
        payload: {
          invitation_id: acceptedInviteBody.id,
          member: {
            workspace_id: remoteWorkspace.id,
            user_id: "local",
          },
        },
      });
      await expectNoWebSocketMessage(local);
    } finally {
      local.close();
      remote.close();
      server.stop(true);
    }
  });

  it("scopes daemon websocket upgrades to authorized runtime workspaces", async () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_ws_local", name: "Local WS", provider: "codex", workspaceId: "local", daemonId: "daemon-local" });
    store.registerRuntime({ id: "rt_ws_other_daemon", name: "Other daemon WS", provider: "codex", workspaceId: "local", daemonId: "daemon-other" });
    store.registerRuntime({ id: "rt_ws_remote", name: "Remote WS", provider: "codex", workspaceId: "remote" });
    const daemonToken = await store.createAccessToken({
      workspaceId: "local",
      daemonId: "daemon-local",
      name: "Local daemon",
      type: "daemon",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: "root-secret",
    });
    try {
      const local = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_local`, {
        headers: { Authorization: `Bearer ${daemonToken.token}` },
      } as any);
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "ready",
        runtime_id: "rt_ws_local",
        runtime_ids: ["rt_ws_local"],
      });
      local.close();

      const otherDaemon = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_other_daemon`, {
        headers: { Authorization: `Bearer ${daemonToken.token}` },
      } as any);
      await expectWebSocketRejected(otherDaemon);

      const remote = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_remote`, {
        headers: { Authorization: `Bearer ${daemonToken.token}` },
      } as any);
      await expectWebSocketRejected(remote);
    } finally {
      server.stop(true);
    }
  });

  it("fans out runtime offline events on daemon deregister with workspace scoping", async () => {
    const store = createStore();
    const localRuntime = store.registerRuntime({
      id: "rt_deregister_ws_local",
      name: "Deregister Local WS",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-local",
    });
    const remoteWorkspace = store.createWorkspace({
      id: "ws_deregister_remote",
      name: "Deregister Remote",
      slug: "deregister-remote",
    });
    const remoteRuntime = store.registerRuntime({
      id: "rt_deregister_ws_remote",
      name: "Deregister Remote WS",
      provider: "codex",
      workspaceId: remoteWorkspace.id,
      daemonId: "daemon-remote",
    });
    store.createWorkspaceMember({ workspaceId: "local", userId: "local", name: "Local", role: "owner" });
    store.createWorkspaceMember({ workspaceId: remoteWorkspace.id, userId: "remote-user", name: "Remote", role: "owner" });
    const localBrowserToken = await store.createAccessToken({
      name: "Local browser",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const remoteBrowserToken = await store.createAccessToken({
      name: "Remote browser",
      type: "pat",
      workspaceId: remoteWorkspace.id,
      userId: "remote-user",
    });
    const daemonToken = await store.createAccessToken({
      workspaceId: "local",
      daemonId: "daemon-local",
      name: "Local daemon",
      type: "daemon",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: "root-secret",
    });
    const local = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=local`);
    const remote = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${remoteWorkspace.id}`);
    try {
      await authenticateBrowserWebSocket(local, localBrowserToken.token);
      await authenticateBrowserWebSocket(remote, remoteBrowserToken.token);

      const runtimeUpdatedEvent = nextWebSocketMessage(local);
      const deregistered = await fetch(`http://127.0.0.1:${server.port}/api/daemon/deregister`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemonToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ runtime_ids: [localRuntime.id, remoteRuntime.id, "rt_missing_deregister_ws"] }),
      });
      expect(deregistered.status).toBe(200);
      expect(await deregistered.json()).toEqual({ status: "ok" });
      expect(await runtimeUpdatedEvent).toMatchObject({
        type: "runtime:updated",
        actor_id: "daemon-local",
        actor_type: "daemon",
        payload: {
          reason: "daemon_deregistered",
          runtime: {
            id: localRuntime.id,
            workspace_id: "local",
            daemon_id: "daemon-local",
            status: "offline",
          },
        },
      });
      await expectNoWebSocketMessage(remote);
      expect(store.getRuntime(localRuntime.id)?.status).toBe("offline");
      expect(store.getRuntime(remoteRuntime.id)?.status).toBe("online");

      const duplicateDeregister = await fetch(`http://127.0.0.1:${server.port}/api/daemon/deregister`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemonToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ runtime_ids: [localRuntime.id] }),
      });
      expect(duplicateDeregister.status).toBe(200);
      await expectNoWebSocketMessage(local);
    } finally {
      local.close();
      remote.close();
      server.stop(true);
    }
  });

  it("serves daemon claim/start/complete endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const issue = store.createIssue({ title: "Daemon issue", assigneeType: "agent", assigneeId: agent.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "hello" });
    const runtime = store.registerRuntime({ name: "local", provider: "claude" });
    const app = createMultiremiApp({ store });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    expect((await claim.json()).task.id).toBe(task.id);

    const start = await app.request(`/api/daemon/tasks/${task.id}/start`, { method: "POST" });
    expect(start.status).toBe(200);
    const startBody = await start.json();
    expect(startBody.status).toBe("running");
    expect(startBody.agent_id).toBe(agent.id);
    expect(startBody.agentId).toBeUndefined();

    const complete = await app.request(`/api/daemon/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        output: "ok",
        pr_url: "https://example.test/pull/1",
        session_id: "sess-complete",
        work_dir: "/tmp/work",
      }),
    });
    expect(complete.status).toBe(200);
    const completeBody = await complete.json();
    expect(completeBody.status).toBe("completed");
    expect(completeBody.agentId).toBeUndefined();
    expect(completeBody.result).toEqual({
      pr_url: "https://example.test/pull/1",
      output: "ok",
      session_id: "sess-complete",
      work_dir: "/tmp/work",
    });

    const status = await app.request(`/api/daemon/tasks/${task.id}/status`);
    expect((await status.json()).status).toBe("completed");

    const taskRuns = await app.request(`/api/issues/${issue.id}/task-runs`);
    expect(taskRuns.status).toBe(200);
    const taskRunsBody = await taskRuns.json();
    expect(taskRunsBody[0].result).toEqual(completeBody.result);

    const duplicateComplete = await app.request(`/api/daemon/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "late" }),
    });
    expect(duplicateComplete.status).toBe(200);
    const duplicateCompleteBody = await duplicateComplete.json();
    expect(duplicateCompleteBody.status).toBe("completed");
    expect(duplicateCompleteBody.result).toEqual(completeBody.result);

    const terminalFail = await app.request(`/api/daemon/tasks/${task.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "late failure" }),
    });
    expect(terminalFail.status).toBe(200);
    const terminalFailBody = await terminalFail.json();
    expect(terminalFailBody.status).toBe("completed");
    expect(terminalFailBody.result).toEqual(completeBody.result);

    const branchAliasTask = store.createTask({ agentId: agent.id, prompt: "branch alias should not work" });
    expect(store.claimTask(runtime.id)?.id).toBe(branchAliasTask.id);
    expect((await (await app.request(`/api/daemon/tasks/${branchAliasTask.id}/start`, { method: "POST" })).json()).status).toBe("running");
    const branchAliasComplete = await app.request(`/api/daemon/tasks/${branchAliasTask.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "branch alias", branch_name: "https://example.test/pull/branch-alias" }),
    });
    expect(branchAliasComplete.status).toBe(200);
    const branchAliasBody = await branchAliasComplete.json();
    expect(branchAliasBody.result.pr_url).toBe("");
    expect(store.getTask(branchAliasTask.id)?.branchName).not.toBe("https://example.test/pull/branch-alias");

    const failingTask = store.createTask({ agentId: agent.id, prompt: "fail me" });
    expect(store.claimTask(runtime.id)?.id).toBe(failingTask.id);
    const fail = await app.request(`/api/daemon/tasks/${failingTask.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "boom",
        failure_reason: "codex_semantic_inactivity",
        session_id: "sess-fail",
        work_dir: "/tmp/fail-work",
      }),
    });
    expect(fail.status).toBe(200);
    const failBody = await fail.json();
    expect(failBody.status).toBe("failed");
    expect(failBody.completed_at).toBeString();
    expect(failBody.result).toBeNull();
    expect(failBody.error).toBe("boom");
    expect(failBody.work_dir).toBe("/tmp/fail-work");
    expect(failBody.session_id).toBeUndefined();
    expect(failBody.failed_at).toBeUndefined();
    expect(failBody.failureReason).toBeUndefined();
    expect(failBody.failure_reason).toBe("codex_semantic_inactivity");
    const failedTask = store.getTask(failingTask.id);
    expect(failedTask?.completedAt).toBe(failedTask?.failedAt);

    const camelReasonTask = store.createTask({ agentId: agent.id, prompt: "camel reason should not work" });
    expect(store.claimTask(runtime.id)?.id).toBe(camelReasonTask.id);
    const camelReasonFail = await app.request(`/api/daemon/tasks/${camelReasonTask.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "camel boom", failureReason: "codex_semantic_inactivity" }),
    });
    expect(camelReasonFail.status).toBe(200);
    const camelReasonBody = await camelReasonFail.json();
    expect(camelReasonBody.failure_reason).toBe("agent_error");
    expect(store.getTask(camelReasonTask.id)?.failureReason).toBe("agent_error");

    const queuedTask = store.createTask({ agentId: agent.id, prompt: "not claimed yet" });
    const startQueued = await app.request(`/api/daemon/tasks/${queuedTask.id}/start`, { method: "POST" });
    expect(startQueued.status).toBe(400);
    expect(await startQueued.json()).toEqual({ error: "start task: no rows in result set" });

    const completeQueued = await app.request(`/api/daemon/tasks/${queuedTask.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "too early" }),
    });
    expect(completeQueued.status).toBe(200);
    expect((await completeQueued.json()).status).toBe("queued");

    const waitQueued = await app.request(`/api/daemon/tasks/${queuedTask.id}/wait-local-directory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "/tmp/not-claimed" }),
    });
    expect(waitQueued.status).toBe(400);
    expect(await waitQueued.json()).toEqual({ error: "mark task waiting_local_directory: no rows in result set" });

    const invalidComplete = await app.request(`/api/daemon/tasks/${queuedTask.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidComplete.status).toBe(400);
    expect(await invalidComplete.json()).toEqual({ error: "invalid request body" });

    const missingStart = await app.request("/api/daemon/tasks/missing/start", { method: "POST" });
    expect(missingStart.status).toBe(404);
    const missingStatus = await app.request("/api/daemon/tasks/missing/status");
    expect(missingStatus.status).toBe(404);
  });

  it("does not duplicate task dispatch across concurrent daemon claims", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Concurrent Claude", provider: "claude" });
    const runtime = store.registerRuntime({ name: "concurrent-local", provider: "claude", maxConcurrency: 1 });
    const task = store.createTask({ agentId: agent.id, prompt: "claim once" });
    const app = createMultiremiApp({ store });

    const claims = await Promise.all(Array.from({ length: 8 }, () =>
      app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" })
    ));
    expect(claims.every((response) => response.status === 200)).toBe(true);
    const bodies = await Promise.all(claims.map((response) => response.json()));
    const claimedIds = bodies.map((body: any) => body.task?.id).filter(Boolean);
    expect(claimedIds).toEqual([task.id]);
    expect(bodies.filter((body: any) => body.task === null)).toHaveLength(7);
    expect(store.getTask(task.id)).toMatchObject({
      status: "dispatched",
      runtimeId: runtime.id,
    });

    const emptyClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(emptyClaim.status).toBe(200);
    expect(await emptyClaim.json()).toEqual({ task: null });
  });

  it("serves Go-compatible daemon recover-orphans response", async () => {
    const store = createStore();
    const runningAgent = store.createAgent({ name: "Running Claude", provider: "claude", maxConcurrentTasks: 3 });
    const waitingAgent = store.createAgent({ name: "Waiting Claude", provider: "claude", maxConcurrentTasks: 3 });
    const runtime = store.registerRuntime({ name: "local", provider: "claude", maxConcurrency: 3 });
    const runningIssue = store.createIssue({ title: "Retry running", assigneeType: "agent", assigneeId: runningAgent.id });
    const waitingIssue = store.createIssue({ title: "Retry waiting", assigneeType: "agent", assigneeId: waitingAgent.id });
    const running = store.createTask({ agentId: runningAgent.id, issueId: runningIssue.id, prompt: "running", sessionId: "sess-running", workDir: "/tmp/running" });
    const waiting = store.createTask({ agentId: waitingAgent.id, issueId: waitingIssue.id, prompt: "waiting" });
    const app = createMultiremiApp({ store });

    expect(store.claimTask(runtime.id)?.id).toBe(running.id);
    store.startTask(running.id);
    expect(store.claimTask(runtime.id)?.id).toBe(waiting.id);
    store.markTaskWaitingLocalDirectory(waiting.id, "/tmp/project");

    const recovered = await app.request(`/api/daemon/runtimes/${runtime.id}/recover-orphans`, { method: "POST" });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ orphaned: 2, retried: 2 });
    expect(store.getTask(running.id)?.failureReason).toBe("runtime_recovery");
    expect(store.getTask(running.id)?.completedAt).toBe(store.getTask(running.id)?.failedAt);
    expect(store.getTask(waiting.id)?.waitReason).toBeNull();
    expect(store.getTask(waiting.id)?.completedAt).toBe(store.getTask(waiting.id)?.failedAt);
    const retryRunning = store.listTasks().find((task) => task.parentTaskId === running.id);
    expect(retryRunning).toMatchObject({
      status: "queued",
      attempt: 2,
      maxAttempts: 3,
      runtimeId: runtime.id,
      issueId: runningIssue.id,
      sessionId: "sess-running",
      workDir: "/tmp/running",
    });

    const missing = await app.request("/api/daemon/runtimes/rt_missing/recover-orphans", { method: "POST" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "runtime not found" });
  });

  it("serves daemon task reports with message idempotency, session pinning, and usage upserts", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "write a patch" });
    const waitingTask = store.createTask({ agentId: agent.id, prompt: "wait for checkout" });
    const app = createMultiremiApp({ store });

    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" })).json()).task.id).toBe(task.id);

    const session = await app.request(`/api/daemon/tasks/${task.id}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-live", work_dir: "/tmp/live" }),
    });
    expect(session.status).toBe(204);
    expect(store.getTask(task.id)?.sessionId).toBe("sess-live");
    expect(store.getTask(task.id)?.workDir).toBe("/tmp/live");

    const emptySession = await app.request(`/api/daemon/tasks/${task.id}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(emptySession.status).toBe(400);
    expect(await emptySession.json()).toEqual({ error: "session_id or work_dir required" });

    const camelCaseSession = await app.request(`/api/daemon/tasks/${task.id}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess-camel", workDir: "/tmp/camel" }),
    });
    expect(camelCaseSession.status).toBe(400);
    expect(await camelCaseSession.json()).toEqual({ error: "session_id or work_dir required" });
    expect(store.getTask(task.id)?.sessionId).toBe("sess-live");
    expect(store.getTask(task.id)?.workDir).toBe("/tmp/live");

    const progress = await app.request(`/api/daemon/tasks/${task.id}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "editing", step: 1, total: 3 }),
    });
    expect(progress.status).toBe(200);
    expect(await progress.json()).toEqual({ status: "ok" });
    expect(store.getTask(task.id)?.progressSummary).toBe("editing");

    const firstMessages = await app.request(`/api/daemon/tasks/${task.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { seq: 1, type: "assistant", content: "starting" },
          { seq: 2, type: "tool", tool: "edit", input: { path: "README.md" }, output: "ok" },
        ],
      }),
    });
    expect(firstMessages.status).toBe(200);
    expect(await firstMessages.json()).toEqual({ status: "ok" });
    const seqTwoId = store.listTaskMessages(task.id).find((message) => message.seq === 2)?.id;
    expect(seqTwoId).toBeString();

    const replayedMessages = await app.request(`/api/daemon/tasks/${task.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ seq: 2, type: "tool", tool: "edit", input: { path: "README.md" }, output: "updated" }] }),
    });
    expect(await replayedMessages.json()).toEqual({ status: "ok" });
    const replayedMessage = store.listTaskMessages(task.id).find((message) => message.seq === 2);
    expect(replayedMessage?.id).toBe(seqTwoId);
    expect(replayedMessage?.output).toBe("updated");
    const since = await app.request(`/api/daemon/tasks/${task.id}/messages?since_seq=1`);
    const sinceBody = await since.json();
    expect(sinceBody.map((message: any) => [message.seq, message.output])).toEqual([[2, "updated"]]);
    expect(sinceBody[0].task_id).toBe(task.id);
    expect(sinceBody[0].taskId).toBeUndefined();
    const invalidSince = await app.request(`/api/daemon/tasks/${task.id}/messages?since=bad`);
    expect(invalidSince.status).toBe(400);

    const invalidMessages = await app.request(`/api/daemon/tasks/${task.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidMessages.status).toBe(400);
    expect(await invalidMessages.json()).toEqual({ error: "invalid request body" });

    const usageFirst = await app.request(`/api/daemon/tasks/${task.id}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usage: [{ provider: "codex", model: "gpt-5", inputTokens: 10, outputTokens: 5 }] }),
    });
    expect(await usageFirst.json()).toEqual({ status: "ok" });
    expect(store.getTask(task.id)!.usage).toEqual([{
      provider: "codex",
      model: "gpt-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    }]);
    const usageSecond = await app.request(`/api/daemon/tasks/${task.id}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usage: [
          { provider: "codex", model: "gpt-5", input_tokens: 12, output_tokens: 6, cache_read_tokens: 3 },
          { provider: "claude", model: "sonnet", input_tokens: 2, output_tokens: 1 },
        ],
      }),
    });
    expect(await usageSecond.json()).toEqual({ status: "ok" });
    const usage = store.getTask(task.id)!.usage;
    expect(usage).toHaveLength(2);
    expect(usage.find((entry) => entry.provider === "codex" && entry.model === "gpt-5")).toMatchObject({
      inputTokens: 12,
      outputTokens: 6,
      cacheReadTokens: 3,
    });

    store.completeTask(task.id, { output: "done" });
    const terminalProgress = await app.request(`/api/daemon/tasks/${task.id}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "too late" }),
    });
    expect(terminalProgress.status).toBe(200);
    expect(await terminalProgress.json()).toEqual({ status: "ok" });

    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" })).json()).task.id).toBe(waitingTask.id);
    store.markTaskWaitingLocalDirectory(waitingTask.id, "/tmp/repo");
    const skippedSession = await app.request(`/api/daemon/tasks/${waitingTask.id}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-should-not-stick", work_dir: "/tmp/waiting" }),
    });
    expect(skippedSession.status).toBe(204);
    expect(store.getTask(waitingTask.id)?.sessionId).toBeNull();
    expect(store.getTask(waitingTask.id)?.workDir).toBeNull();

    const missingMessages = await app.request("/api/daemon/tasks/missing/messages");
    expect(missingMessages.status).toBe(404);
  });

  it("serves Go-compatible daemon GC checks with workspace anti-enumeration", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "GC Codex", provider: "codex" });
    const runtime = store.registerRuntime({ name: "local-gc-codex", provider: "codex", workspaceId: "local" });
    const issue = store.createIssue({ title: "GC issue", workspaceId: "local" });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", title: "GC chat" });
    const autopilot = store.createAutopilot({
      title: "GC autopilot",
      workspaceId: "local",
      assigneeId: agent.id,
      issueTitleTemplate: "GC run",
    });
    const run = store.runAutopilot(autopilot.id);
    expect(store.claimTask(runtime.id)?.id).toBe(run.taskId!);
    store.startTask(run.taskId!);
    store.completeTask(run.taskId!, { output: "done" });
    const completedRun = store.getAutopilotRun(run.id)!;
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "quick create gc" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const completedTask = store.completeTask(task.id, { output: "done" });

    const remoteIssue = store.createIssue({ title: "Remote GC issue", workspaceId: "remote" });
    const remoteAgent = store.createAgent({ name: "Remote GC Codex", provider: "codex", workspaceId: "remote" });
    const remoteChat = store.createChatSession({ agentId: remoteAgent.id, workspaceId: "remote", title: "Remote GC chat" });
    const remoteAutopilot = store.createAutopilot({
      title: "Remote GC autopilot",
      workspaceId: "remote",
      assigneeId: remoteAgent.id,
      issueTitleTemplate: "Remote GC run",
    });
    const remoteRun = store.runAutopilot(remoteAutopilot.id);
    const remoteTask = store.createTask({ agentId: remoteAgent.id, workspaceId: "remote", prompt: "remote quick create gc" });
    const daemonToken = await store.createAccessToken({
      workspaceId: "local",
      name: "Local daemon",
      type: "daemon",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const daemonHeaders = { Authorization: `Bearer ${daemonToken.token}` };

    const issueGc = await app.request(`/api/daemon/issues/${issue.id}/gc-check`, { headers: daemonHeaders });
    expect(await issueGc.json()).toEqual({ status: "todo", updated_at: issue.updatedAt });
    const chatGc = await app.request(`/api/daemon/chat-sessions/${chat.id}/gc-check`, { headers: daemonHeaders });
    expect(await chatGc.json()).toEqual({ status: "active", updated_at: chat.updatedAt });
    const runGc = await app.request(`/api/daemon/autopilot-runs/${completedRun.id}/gc-check`, { headers: daemonHeaders });
    expect(await runGc.json()).toEqual({ status: "completed", completed_at: completedRun.completedAt });
    const taskGc = await app.request(`/api/daemon/tasks/${completedTask.id}/gc-check`, { headers: daemonHeaders });
    expect(await taskGc.json()).toEqual({ status: "completed", completed_at: completedTask.completedAt });

    for (const path of [
      `/api/daemon/issues/${remoteIssue.id}/gc-check`,
      `/api/daemon/chat-sessions/${remoteChat.id}/gc-check`,
      `/api/daemon/autopilot-runs/${remoteRun.id}/gc-check`,
      `/api/daemon/tasks/${remoteTask.id}/gc-check`,
    ]) {
      const crossWorkspace = await app.request(path, { headers: daemonHeaders });
      expect(crossWorkspace.status).toBe(404);
      expect(await crossWorkspace.json()).toEqual({ error: "not found" });
    }

    const remoteTaskStart = await app.request(`/api/daemon/tasks/${remoteTask.id}/start`, {
      method: "POST",
      headers: daemonHeaders,
    });
    expect(remoteTaskStart.status).toBe(403);
  });

  it("serves agent task history and workspace task snapshots", async () => {
    const store = createStore();
    const agentA = store.createAgent({ name: "Snapshot A", provider: "codex" });
    const agentB = store.createAgent({ name: "Snapshot B", provider: "claude" });
    const agentC = store.createAgent({ name: "Snapshot C", provider: "codex" });
    const runtime = store.registerRuntime({ name: "snapshot-runtime", provider: "any" });
    const app = createMultiremiApp({ store });

    const queued = store.createTask({ agentId: agentA.id, prompt: "A queued" });
    const running = store.createTask({ agentId: agentA.id, prompt: "A running" });
    db!.run("UPDATE multiremi_tasks SET status = 'running', runtime_id = ?, started_at = ?, updated_at = ? WHERE id = ?", [
      runtime.id,
      "2026-06-04T01:00:00.000Z",
      "2026-06-04T01:00:00.000Z",
      running.id,
    ]);
    const oldFailed = store.createTask({ agentId: agentA.id, prompt: "A old failed" });
    db!.run("UPDATE multiremi_tasks SET status = 'failed', failed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T01:01:00.000Z",
      "2026-06-04T01:01:00.000Z",
      oldFailed.id,
    ]);
    const latestCompleted = store.createTask({ agentId: agentA.id, prompt: "A latest completed" });
    db!.run("UPDATE multiremi_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T01:02:00.000Z",
      "2026-06-04T01:02:00.000Z",
      latestCompleted.id,
    ]);
    const staleFailure = store.createTask({ agentId: agentB.id, prompt: "B stale failed" });
    db!.run("UPDATE multiremi_tasks SET status = 'failed', failed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T00:50:00.000Z",
      "2026-06-04T00:50:00.000Z",
      staleFailure.id,
    ]);
    const failureBeforeCancel = store.createTask({ agentId: agentC.id, prompt: "C failure" });
    db!.run("UPDATE multiremi_tasks SET status = 'failed', failed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T00:55:00.000Z",
      "2026-06-04T00:55:00.000Z",
      failureBeforeCancel.id,
    ]);
    const cancelled = store.createTask({ agentId: agentC.id, prompt: "C cancelled" });
    db!.run("UPDATE multiremi_tasks SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T01:03:00.000Z",
      "2026-06-04T01:03:00.000Z",
      cancelled.id,
    ]);

    const snapshot = await app.request("/api/agent-task-snapshot?workspace_id=local");
    const snapshotBody = await snapshot.json();
    const ids = snapshotBody.map((task: any) => task.id).sort();
    expect(ids).toEqual([queued.id, running.id, latestCompleted.id, staleFailure.id, failureBeforeCancel.id].sort());
    expect(ids).not.toContain(oldFailed.id);
    expect(ids).not.toContain(cancelled.id);

    const multiremiSnapshot = await app.request("/api/multiremi/agent-task-snapshot?workspace_id=local");
    const multiremiSnapshotBody = await multiremiSnapshot.json();
    expect(multiremiSnapshotBody.total).toBe(5);
    expect(multiremiSnapshotBody.tasks.map((task: any) => task.id).sort()).toEqual(ids);

    const agentTasks = await app.request(`/api/agents/${agentA.id}/tasks`);
    const agentTaskBody = await agentTasks.json();
    expect(agentTaskBody.map((task: any) => task.id)).toContain(queued.id);

    const multiremiAgentTasks = await app.request(`/api/multiremi/agents/${agentA.id}/tasks`);
    const multiremiAgentTaskBody = await multiremiAgentTasks.json();
    expect(multiremiAgentTaskBody.total).toBe(4);
  });

  it("serves workspace agent run counts and 30 day activity buckets", async () => {
    const store = createStore();
    const agentA = store.createAgent({ name: "Activity A", provider: "codex" });
    const agentB = store.createAgent({ name: "Activity B", provider: "claude" });
    const app = createMultiremiApp({ store });

    const now = Date.now();
    const recentCreated = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oldCreated = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recentCompletedA = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const recentCompletedB = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();

    const completed = store.createTask({ agentId: agentA.id, prompt: "completed" });
    db!.run("UPDATE multiremi_tasks SET status = 'completed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      recentCreated,
      recentCompletedA,
      recentCompletedA,
      completed.id,
    ]);
    const failed = store.createTask({ agentId: agentA.id, prompt: "failed" });
    db!.run("UPDATE multiremi_tasks SET status = 'failed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      recentCreated,
      recentCompletedA,
      recentCompletedA,
      failed.id,
    ]);
    const inFlight = store.createTask({ agentId: agentA.id, prompt: "in flight" });
    db!.run("UPDATE multiremi_tasks SET created_at = ?, updated_at = ? WHERE id = ?", [recentCreated, recentCreated, inFlight.id]);
    const old = store.createTask({ agentId: agentA.id, prompt: "old" });
    db!.run("UPDATE multiremi_tasks SET status = 'completed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      oldCreated,
      oldCreated,
      oldCreated,
      old.id,
    ]);
    const otherAgent = store.createTask({ agentId: agentB.id, prompt: "other agent" });
    db!.run("UPDATE multiremi_tasks SET status = 'completed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      recentCreated,
      recentCompletedB,
      recentCompletedB,
      otherAgent.id,
    ]);

    const runCounts = await app.request("/api/agent-run-counts?workspace_id=local");
    const runCountBody = await runCounts.json();
    expect(runCountBody.find((row: any) => row.agent_id === agentA.id)?.run_count).toBe(3);
    expect(runCountBody.find((row: any) => row.agent_id === agentB.id)?.run_count).toBe(1);

    const multiremiRunCounts = await app.request("/api/multiremi/agent-run-counts?workspace_id=local");
    const multiremiRunCountBody = await multiremiRunCounts.json();
    expect(multiremiRunCountBody.total).toBe(2);
    expect(multiremiRunCountBody.counts.find((row: any) => row.agentId === agentA.id)?.runCount).toBe(3);

    const activity = await app.request("/api/agent-activity-30d?workspace_id=local");
    const activityBody = await activity.json();
    const agentABucket = activityBody.find((row: any) => row.agent_id === agentA.id);
    expect(agentABucket.task_count).toBe(2);
    expect(agentABucket.failed_count).toBe(1);
    expect(agentABucket.bucket_at).toEndWith("T00:00:00.000Z");
    expect(activityBody.find((row: any) => row.agent_id === agentB.id)?.task_count).toBe(1);

    const multiremiActivity = await app.request("/api/multiremi/agent-activity-30d?workspace_id=local");
    const multiremiActivityBody = await multiremiActivity.json();
    expect(multiremiActivityBody.total).toBe(2);
    expect(multiremiActivityBody.activity.find((row: any) => row.agentId === agentA.id)?.failedCount).toBe(1);
  });

  it("protects APIs with bearer auth and scopes daemon tokens to daemon routes", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const unauthorized = await app.request("/api/multiremi/agents");
    expect(unauthorized.status).toBe(401);

    const patCreated = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({ name: "Console token", type: "pat", workspaceId: "local", expiresInDays: 3 }),
    });
    expect(patCreated.status).toBe(201);
    const patBody = await patCreated.json();
    expect(patBody.token.token).toStartWith("mul_");
    expect(patBody.token.tokenPrefix).toBe(patBody.token.token.slice(0, 12));

    const longPatCreated = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({ name: "Long console token", type: "pat", workspaceId: "local", expiresInDays: 30 }),
    });
    expect(longPatCreated.status).toBe(201);
    const longPatBody = await longPatCreated.json();

    const daemonCreated = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({ name: "Local daemon", type: "daemon", workspaceId: "local" }),
    });
    expect(daemonCreated.status).toBe(201);
    const daemonBody = await daemonCreated.json();
    expect(daemonBody.token.token).toStartWith("mdt_");
    expect(daemonBody.token.tokenPrefix).toBe(daemonBody.token.token.slice(0, 12));

    const publicTaskTokenCreated = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({ name: "Bad task token", type: "task", workspaceId: "local", taskId: "tsk_bad", agentId: "agt_bad" }),
    });
    expect(publicTaskTokenCreated.status).toBe(400);
    expect(await publicTaskTokenCreated.json()).toEqual({ error: "task tokens are minted by daemon task claim" });

    const ownerPatCreated = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({
        name: "Runtime owner token",
        type: "pat",
        workspaceId: "local",
        userId: "usr_runtime_owner",
        expiresInDays: 30,
      }),
    });
    expect(ownerPatCreated.status).toBe(201);
    const ownerPatBody = await ownerPatCreated.json();
    expect(ownerPatBody.token.userId).toBe("usr_runtime_owner");

    const ownerRegistered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerPatBody.token.token}` },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-owner",
        device_name: "Owner Laptop",
        runtimes: [{ type: "codex", version: "1.0.0" }],
      }),
    });
    expect(ownerRegistered.status).toBe(200);
    const ownerRegisteredBody = await ownerRegistered.json();
    const ownerRuntimeId = ownerRegisteredBody.runtimes[0].id;
    expect(ownerRegisteredBody.runtimes[0].owner_id).toBe("usr_runtime_owner");
    expect(store.getRuntime(ownerRuntimeId)?.ownerId).toBe("usr_runtime_owner");

    const crossWorkspacePatRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerPatBody.token.token}` },
      body: JSON.stringify({ workspace_id: "remote", daemon_id: "daemon-owner-remote", runtimes: [{ type: "codex" }] }),
    });
    expect(crossWorkspacePatRegister.status).toBe(403);

    const ownerReregisteredByDaemon = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemonBody.token.token}` },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-owner",
        device_name: "Owner Laptop",
        runtimes: [{ type: "codex", version: "1.0.1" }],
      }),
    });
    expect(ownerReregisteredByDaemon.status).toBe(200);
    expect(store.getRuntime(ownerRuntimeId)?.ownerId).toBe("usr_runtime_owner");

    const taskTokenAgent = store.createAgent({
      name: "Task token agent",
      provider: "codex",
      workspaceId: "local",
      // Owner matches the private runtime's owner so the ownership guard lets
      // the claim through — this case exercises task tokens, not scheduling.
      ownerId: "usr_runtime_owner",
      runtimeId: ownerRuntimeId,
    });
    const taskTokenIssue = store.createIssue({
      title: "Task token issue",
      assigneeType: "agent",
      assigneeId: taskTokenAgent.id,
    });
    const taskTokenTask = store.createTask({
      agentId: taskTokenAgent.id,
      issueId: taskTokenIssue.id,
      workspaceId: "local",
      prompt: "use task token",
    });
    const taskTokenClaim = await app.request(`/api/daemon/runtimes/${ownerRuntimeId}/tasks/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(taskTokenClaim.status).toBe(200);
    const taskTokenClaimBody = await taskTokenClaim.json();
    expect(taskTokenClaimBody.task.auth_token).toStartWith("mat_");
    const taskAccessToken = await store.verifyAccessToken(taskTokenClaimBody.task.auth_token);
    expect(taskAccessToken).toMatchObject({
      type: "task",
      workspaceId: "local",
      userId: "usr_runtime_owner",
      taskId: taskTokenTask.id,
      agentId: taskTokenAgent.id,
    });

    const taskTokenOnDaemonRoute = await app.request(`/api/daemon/tasks/${taskTokenTask.id}/status`, {
      headers: { Authorization: `Bearer ${taskTokenClaimBody.task.auth_token}` },
    });
    expect(taskTokenOnDaemonRoute.status).toBe(403);
    expect(await taskTokenOnDaemonRoute.json()).toEqual({ error: "forbidden for task token" });

    const taskTokenComment = await app.request(`/api/issues/${taskTokenIssue.id}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${taskTokenClaimBody.task.auth_token}`,
      },
      body: JSON.stringify({
        content: "agent-authenticated comment",
        authorType: "member",
        authorId: "forged-member",
      }),
    });
    expect(taskTokenComment.status).toBe(201);
    const taskTokenCommentBody = await taskTokenComment.json();
    expect(taskTokenCommentBody).toMatchObject({
      author_type: "agent",
      author_id: taskTokenAgent.id,
      content: "agent-authenticated comment",
    });

    store.completeTask(taskTokenTask.id, { output: "done" });
    expect(await store.verifyAccessToken(taskTokenClaimBody.task.auth_token)).toBeNull();
    const taskTokenAfterTerminal = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${taskTokenClaimBody.task.auth_token}` },
    });
    expect(taskTokenAfterTerminal.status).toBe(401);

    const jwtToken = signTestJwt({ sub: "local", exp: Math.floor(Date.now() / 1000) + 60 });
    const jwtRegistered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtToken}` },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-jwt-owner",
        device_name: "JWT Laptop",
        runtimes: [{ type: "codex", version: "1.0.0" }],
      }),
    });
    expect(jwtRegistered.status).toBe(200);
    const jwtRegisteredBody = await jwtRegistered.json();
    expect(jwtRegisteredBody.runtimes[0].owner_id).toBe("local");
    expect(store.getRuntime(jwtRegisteredBody.runtimes[0].id)?.ownerId).toBe("local");

    const jwtWithoutWorkspaceAccess = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signTestJwt({ sub: "ghost-user" })}` },
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-jwt-ghost", runtimes: [{ type: "codex" }] }),
    });
    expect(jwtWithoutWorkspaceAccess.status).toBe(403);

    const expiredJwtRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signTestJwt({ sub: "local", exp: Math.floor(Date.now() / 1000) - 60 })}`,
      },
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-jwt-expired", runtimes: [{ type: "codex" }] }),
    });
    expect(expiredJwtRegister.status).toBe(401);

    const withPatToken = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${patBody.token.token}` },
    });
    expect(withPatToken.status).toBe(200);

    const patRenewed = await app.request("/api/tokens/current/renew", {
      method: "POST",
      headers: { Authorization: `Bearer ${patBody.token.token}` },
    });
    expect(patRenewed.status).toBe(200);
    const patRenewedBody = await patRenewed.json();
    expect(patRenewedBody.renewed).toBe(true);
    expect(patRenewedBody.access_token).toStartWith("mul_");
    expect(patRenewedBody.access_token).not.toBe(patBody.token.token);
    expect(patRenewedBody.token_type).toBe("bearer");
    expect(patRenewedBody.expires_at).toBeString();
    expect(Date.parse(patRenewedBody.expires_at)).toBeGreaterThan(Date.now() + 80 * 24 * 60 * 60 * 1000);

    const oldPatAfterRenew = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${patBody.token.token}` },
    });
    expect(oldPatAfterRenew.status).toBe(401);
    const rotatedPatWorksAfterRenew = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${patRenewedBody.access_token}` },
    });
    expect(rotatedPatWorksAfterRenew.status).toBe(200);

    const patRenewedAgain = await app.request("/api/tokens/current/renew", {
      method: "POST",
      headers: { Authorization: `Bearer ${patRenewedBody.access_token}` },
    });
    expect(patRenewedAgain.status).toBe(200);
    const patRenewedAgainBody = await patRenewedAgain.json();
    expect(patRenewedAgainBody.renewed).toBe(false);
    expect(patRenewedAgainBody.access_token).toBeUndefined();
    expect(patRenewedAgainBody.expires_at).toBe(patRenewedBody.expires_at);

    const longPatRenewed = await app.request("/api/tokens/current/renew", {
      method: "POST",
      headers: { Authorization: `Bearer ${longPatBody.token.token}` },
    });
    expect(longPatRenewed.status).toBe(200);
    const longPatRenewedBody = await longPatRenewed.json();
    expect(longPatRenewedBody.renewed).toBe(false);
    expect(longPatRenewedBody.expires_at).toBe(longPatBody.token.expiresAt);

    const withDaemonOnConsole = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(withDaemonOnConsole.status).toBe(403);

    const daemonRenew = await app.request("/api/tokens/current/renew", {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(daemonRenew.status).toBe(403);

    const registeredRuntime = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemonBody.token.token}` },
      body: JSON.stringify({ id: "rt_auth_daemon", name: "Auth daemon", provider: "codex", workspaceId: "local" }),
    });
    expect(registeredRuntime.status).toBe(201);

    const daemonClaim = await app.request("/api/daemon/runtimes/rt_auth_daemon/tasks/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(daemonClaim.status).toBe(200);

    const localHeartbeat = await app.request("/api/multiremi/runtimes/rt_auth_daemon/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(localHeartbeat.status).toBe(200);

    store.registerRuntime({ id: "rt_remote_auth", name: "Remote runtime", provider: "codex", workspaceId: "remote" });
    const remoteAgent = store.createAgent({ name: "Remote Codex", provider: "codex" });
    const remoteTask = store.createTask({ agentId: remoteAgent.id, workspaceId: "remote", prompt: "remote task" });

    const remoteRuntimeRegister = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemonBody.token.token}` },
      body: JSON.stringify({ id: "rt_bad_remote", name: "Bad remote", provider: "codex", workspaceId: "remote" }),
    });
    expect(remoteRuntimeRegister.status).toBe(403);

    const remoteDaemonRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemonBody.token.token}` },
      body: JSON.stringify({ workspace_id: "remote", daemon_id: "daemon-remote", runtimes: [{ type: "codex" }] }),
    });
    expect(remoteDaemonRegister.status).toBe(403);

    const remoteRepos = await app.request("/api/daemon/workspaces/remote/repos", {
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(remoteRepos.status).toBe(403);

    const remoteClaim = await app.request("/api/daemon/runtimes/rt_remote_auth/tasks/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(remoteClaim.status).toBe(403);
    expect(await remoteClaim.json()).toEqual({ error: "forbidden for daemon token workspace" });

    const remotePending = await app.request("/api/daemon/runtimes/rt_remote_auth/tasks/pending", {
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(remotePending.status).toBe(403);
    expect(await remotePending.json()).toEqual({ error: "forbidden for daemon token workspace" });

    const remoteRecover = await app.request("/api/daemon/runtimes/rt_remote_auth/recover-orphans", {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(remoteRecover.status).toBe(403);
    expect(await remoteRecover.json()).toEqual({ error: "forbidden for daemon token workspace" });

    const remoteTaskStart = await app.request(`/api/daemon/tasks/${remoteTask.id}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(remoteTaskStart.status).toBe(403);
    expect(await remoteTaskStart.json()).toEqual({ error: "forbidden for daemon token workspace" });

    const remoteTaskReportRoutes: Array<{ method: string; path: string; body?: unknown }> = [
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/wait-local-directory`, body: { reason: "/tmp/remote" } },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/progress`, body: { summary: "remote progress" } },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/messages`, body: { messages: [{ seq: 1, type: "assistant", content: "remote" }] } },
      { method: "GET", path: `/api/daemon/tasks/${remoteTask.id}/messages` },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/session`, body: { session_id: "sess-remote", work_dir: "/tmp/remote" } },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/complete`, body: { output: "remote done" } },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/fail`, body: { error: "remote failed" } },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/usage`, body: { usage: [{ provider: "codex", model: "remote", input_tokens: 1 }] } },
      { method: "GET", path: `/api/daemon/tasks/${remoteTask.id}/status` },
    ];
    for (const route of remoteTaskReportRoutes) {
      const response = await app.request(route.path, {
        method: route.method,
        headers: {
          Authorization: `Bearer ${daemonBody.token.token}`,
          ...(route.body ? { "Content-Type": "application/json" } : {}),
        },
        body: route.body ? JSON.stringify(route.body) : undefined,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden for daemon token workspace" });
    }
    expect(store.getTask(remoteTask.id)?.sessionId).toBeNull();
    expect(store.listTaskMessages(remoteTask.id)).toEqual([]);
    expect(store.listRuntimeUsage(null)).toEqual([]);

    const scopedDeregister = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemonBody.token.token}` },
      body: JSON.stringify({ runtime_ids: ["rt_auth_daemon", "rt_remote_auth", "rt_missing_auth"] }),
    });
    expect(scopedDeregister.status).toBe(200);
    expect((await scopedDeregister.json()).status).toBe("ok");
    expect(store.getRuntime("rt_auth_daemon")?.status).toBe("offline");
    expect(store.getRuntime("rt_remote_auth")?.status).toBe("online");

    const listed = await app.request("/api/tokens", {
      headers: { Authorization: "Bearer root-secret" },
    });
    const listedBody = await listed.json();
    expect(listedBody.find((token: any) => token.id === patBody.token.id)?.lastUsedAt).toBeString();
    expect(listedBody.find((token: any) => token.id === daemonBody.token.id)?.lastUsedAt).toBeString();

    const revoked = await app.request(`/api/tokens/${patBody.token.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(revoked.status).toBe(204);

    const afterRevoke = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${patBody.token.token}` },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("serves workspace skills and agent skill assignment endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/multiremi/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "skl_api",
        workspace_id: "local",
        name: "API Skill",
        description: "API managed skill",
        content: "# API Skill",
        files: [{ path: "notes/guide.md", content: "Guide" }],
      }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).skill.files[0].path).toBe("notes/guide.md");

    const list = await app.request("/api/skills?workspace_id=local");
    const listBody = await list.json();
    expect(listBody[0].id).toBe("skl_api");
    expect(listBody[0].workspace_id).toBe("local");
    expect(Object.keys(listBody[0]).filter((key) => /[A-Z]/.test(key))).toEqual([]);
    expect(listBody[0].content).toBeUndefined();
    expect(listBody[0].files).toBeUndefined();
    expect(listBody[0].workspaceId).toBeUndefined();

    const multiremiList = await app.request("/api/multiremi/skills?workspace_id=local");
    expect((await multiremiList.json()).skills[0].content).toBeUndefined();

    const invalidCreateJson = await app.request("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCreateJson.status).toBe(400);
    expect(await invalidCreateJson.json()).toEqual({ error: "invalid request body" });

    const namelessCreate = await app.request("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Missing name" }),
    });
    expect(namelessCreate.status).toBe(400);
    expect(await namelessCreate.json()).toEqual({ error: "name is required" });

    const reservedSupportingFile = await app.request("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Reserved Skill",
        content: "# Reserved",
        files: [
          { path: "sub/../SKILL.md", content: "Duplicate primary content" },
          { path: "notes/a..b.md", content: "Safe dots" },
        ],
      }),
    });
    expect(reservedSupportingFile.status).toBe(201);
    const reservedBody = await reservedSupportingFile.json();
    expect(reservedBody.files.map((file: any) => file.path)).toEqual(["notes/a..b.md"]);

    const detail = await app.request("/api/skills/skl_api");
    const detailBody = await detail.json();
    expect(detailBody.content).toBe("# API Skill");
    expect(detailBody.workspace_id).toBe("local");
    expect(detailBody.files[0].content).toBe("Guide");
    expect(detailBody.files[0].skill_id).toBe("skl_api");
    expect(detailBody.files[0].skillId).toBeUndefined();
    expect(Object.keys(detailBody).filter((key) => /[A-Z]/.test(key))).toEqual([]);

    const invalidAssignJson = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidAssignJson.status).toBe(400);
    expect(await invalidAssignJson.json()).toEqual({ error: "invalid request body" });

    const missingAssign = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_ids: ["skl_missing"] }),
    });
    expect(missingAssign.status).toBe(404);
    expect(await missingAssign.json()).toEqual({ error: "skill not found" });

    const assign = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_ids: ["skl_api"] }),
    });
    expect(assign.status).toBe(200);
    const assignBody = await assign.json();
    expect(assignBody[0].name).toBe("API Skill");
    expect(assignBody[0].workspace_id).toBe("local");
    expect(assignBody[0].content).toBeUndefined();
    expect(assignBody[0].files).toBeUndefined();
    expect(Object.keys(assignBody[0]).filter((key) => /[A-Z]/.test(key))).toEqual([]);

    const agentDetail = await app.request(`/api/multiremi/agents/${agent.id}`);
    const agentBody = await agentDetail.json();
    expect(agentBody.agent.skills[0].files[0].path).toBe("notes/guide.md");

    const deleted = await app.request("/api/skills/skl_api", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const afterDelete = await app.request(`/api/multiremi/agents/${agent.id}/skills`);
    expect((await afterDelete.json()).skills).toHaveLength(0);
  });

  it("gates Go-compatible skill mutations by creator/admin and emits workspace events", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ id: "ws_skill_guard", name: "Skill Guard", slug: "skill-guard" });
    store.createWorkspaceMember({
      id: "skill-admin",
      workspaceId: workspace.id,
      name: "Skill Admin",
      email: "skill-admin@example.com",
      role: "admin",
    });
    const creator = store.createWorkspaceMember({
      id: "skill-creator",
      workspaceId: workspace.id,
      name: "Skill Creator",
      email: "skill-creator@example.com",
      role: "member",
    });
    const plain = store.createWorkspaceMember({
      id: "skill-member",
      workspaceId: workspace.id,
      name: "Skill Member",
      email: "skill-member@example.com",
      role: "member",
    });
    const agent = store.createAgent({
      name: "Skill Guard Agent",
      provider: "claude",
      workspaceId: workspace.id,
      ownerId: creator.id,
      visibility: "workspace",
    });
    const ownerToken = await store.createAccessToken({ name: "Skill Owner", type: "pat", workspaceId: workspace.id, userId: "local" });
    const adminToken = await store.createAccessToken({ name: "Skill Admin", type: "pat", workspaceId: workspace.id, userId: "skill-admin" });
    const creatorToken = await store.createAccessToken({ name: "Skill Creator", type: "pat", workspaceId: workspace.id, userId: creator.id });
    const memberToken = await store.createAccessToken({ name: "Skill Member", type: "pat", workspaceId: workspace.id, userId: plain.id });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

    const created = await app.request("/api/skills", {
      method: "POST",
      headers: jsonHeaders(creatorToken.token),
      body: JSON.stringify({
        workspace_id: workspace.id,
        name: "Guarded Skill",
        content: "# Guarded",
        created_by: "forged",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.workspace_id).toBe(workspace.id);
    expect(createdBody.created_by).toBe(creator.id);

    const createdEvent = events.find((event) => event.type === "skill:created");
    expect(createdEvent).toMatchObject({
      workspaceId: workspace.id,
      actorId: creator.id,
      actorType: "member",
      payload: { skill: { id: createdBody.id, workspace_id: workspace.id, created_by: creator.id } },
    });

    const memberRead = await app.request(`/api/skills/${createdBody.id}`, { headers: authHeaders(memberToken.token) });
    expect(memberRead.status).toBe(200);

    const memberUpdate = await app.request(`/api/skills/${createdBody.id}`, {
      method: "PATCH",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ description: "Nope" }),
    });
    expect(memberUpdate.status).toBe(403);
    expect(await memberUpdate.json()).toEqual({ error: "only the skill creator can manage this skill" });

    const creatorUpdate = await app.request(`/api/skills/${createdBody.id}`, {
      method: "PATCH",
      headers: jsonHeaders(creatorToken.token),
      body: JSON.stringify({ description: "Updated", workspace_id: "local", created_by: plain.id }),
    });
    expect(creatorUpdate.status).toBe(200);
    const updatedBody = await creatorUpdate.json();
    expect(updatedBody.workspace_id).toBe(workspace.id);
    expect(updatedBody.created_by).toBe(creator.id);
    expect(updatedBody.description).toBe("Updated");
    expect(events.some((event) =>
      event.type === "skill:updated" &&
      event.actorId === creator.id &&
      (event.payload.skill as any)?.id === createdBody.id
    )).toBe(true);

    const memberFilePut = await app.request(`/api/skills/${createdBody.id}/files`, {
      method: "PUT",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ path: "notes/nope.md", content: "Nope" }),
    });
    expect(memberFilePut.status).toBe(403);
    expect(await memberFilePut.json()).toEqual({ error: "only the skill creator can manage this skill" });

    const adminFilePut = await app.request(`/api/skills/${createdBody.id}/files`, {
      method: "PUT",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ path: "notes/admin.md", content: "Admin note" }),
    });
    expect(adminFilePut.status).toBe(200);
    const fileBody = await adminFilePut.json();
    expect(fileBody.skill_id).toBe(createdBody.id);

    const memberFileDelete = await app.request(`/api/skills/${createdBody.id}/files/${fileBody.id}`, {
      method: "DELETE",
      headers: authHeaders(memberToken.token),
    });
    expect(memberFileDelete.status).toBe(403);

    const adminFileDelete = await app.request(`/api/skills/${createdBody.id}/files/${fileBody.id}`, {
      method: "DELETE",
      headers: authHeaders(adminToken.token),
    });
    expect(adminFileDelete.status).toBe(204);

    const memberBind = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ skill_ids: [createdBody.id] }),
    });
    expect(memberBind.status).toBe(403);
    expect(await memberBind.json()).toEqual({ error: "only the agent owner can manage this agent" });

    const creatorBind = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: jsonHeaders(creatorToken.token),
      body: JSON.stringify({ skill_ids: [createdBody.id] }),
    });
    expect(creatorBind.status).toBe(200);
    expect((await creatorBind.json())[0].id).toBe(createdBody.id);
    expect(events.some((event) =>
      event.type === "agent:status" &&
      event.actorId === creator.id &&
      event.workspaceId === workspace.id &&
      (event.payload.skills as any[])?.[0]?.id === createdBody.id
    )).toBe(true);

    const memberDelete = await app.request(`/api/skills/${createdBody.id}`, {
      method: "DELETE",
      headers: authHeaders(memberToken.token),
    });
    expect(memberDelete.status).toBe(403);

    const ownerDelete = await app.request(`/api/skills/${createdBody.id}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken.token),
    });
    expect(ownerDelete.status).toBe(204);
    expect(events.some((event) =>
      event.type === "skill:deleted" &&
      event.actorId === "local" &&
      event.workspaceId === workspace.id &&
      event.payload.skill_id === createdBody.id
    )).toBe(true);
  });

  it("gates native skill wrapper routes with workspace scope and Go-style events", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ id: "ws_native_skill_guard", name: "Native Skill Guard", slug: "native-skill-guard" });
    store.createWorkspaceMember({
      id: "native-skill-admin",
      workspaceId: workspace.id,
      name: "Native Skill Admin",
      email: "native-skill-admin@example.com",
      role: "admin",
    });
    const creator = store.createWorkspaceMember({
      id: "native-skill-creator",
      workspaceId: workspace.id,
      name: "Native Skill Creator",
      email: "native-skill-creator@example.com",
      role: "member",
    });
    const plain = store.createWorkspaceMember({
      id: "native-skill-member",
      workspaceId: workspace.id,
      name: "Native Skill Member",
      email: "native-skill-member@example.com",
      role: "member",
    });
    store.createSkill({ workspaceId: "local", name: "Local Only Skill", content: "# Local" });
    store.createSkill({ workspaceId: "ws_native_other", name: "Other Workspace Skill", content: "# Other" });
    const adminToken = await store.createAccessToken({ name: "Native Skill Admin", type: "pat", workspaceId: workspace.id, userId: "native-skill-admin" });
    const creatorToken = await store.createAccessToken({ name: "Native Skill Creator", type: "pat", workspaceId: workspace.id, userId: creator.id });
    const memberToken = await store.createAccessToken({ name: "Native Skill Member", type: "pat", workspaceId: workspace.id, userId: plain.id });
    const otherToken = await store.createAccessToken({ name: "Other Native Skill", type: "pat", workspaceId: "ws_native_other", userId: "local" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

    const created = await app.request("/api/multiremi/skills", {
      method: "POST",
      headers: jsonHeaders(creatorToken.token),
      body: JSON.stringify({
        workspace_id: workspace.id,
        name: "Native Guarded Skill",
        content: "# Native",
        createdBy: "forged-native",
        files: [{ path: "docs/native.md", content: "Native note" }],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.skill.workspaceId).toBe(workspace.id);
    expect(createdBody.skill.createdBy).toBe(creator.id);
    expect(createdBody.skill.files[0].path).toBe("docs/native.md");
    expect(events.some((event) =>
      event.type === "skill:created" &&
      event.actorId === creator.id &&
      (event.payload.skill as any)?.workspace_id === workspace.id
    )).toBe(true);

    const scopedList = await app.request("/api/multiremi/skills", { headers: authHeaders(memberToken.token) });
    const scopedListBody = await scopedList.json();
    expect(scopedList.status).toBe(200);
    expect(scopedListBody.total).toBe(1);
    expect(scopedListBody.skills[0].name).toBe("Native Guarded Skill");
    expect(scopedListBody.skills[0].content).toBeUndefined();

    const scopedSearch = await app.request("/api/multiremi/skills/search?q=Skill", { headers: authHeaders(memberToken.token) });
    const scopedSearchBody = await scopedSearch.json();
    expect(scopedSearchBody.skills.map((skill: any) => skill.name)).toEqual(["Native Guarded Skill"]);

    const crossWorkspaceDetail = await app.request(`/api/multiremi/skills/${createdBody.skill.id}`, { headers: authHeaders(otherToken.token) });
    expect(crossWorkspaceDetail.status).toBe(404);
    expect(await crossWorkspaceDetail.json()).toEqual({ error: "skill not found" });

    const memberUpdate = await app.request(`/api/multiremi/skills/${createdBody.skill.id}`, {
      method: "PATCH",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ description: "Nope" }),
    });
    expect(memberUpdate.status).toBe(403);
    expect(await memberUpdate.json()).toEqual({ error: "only the skill creator can manage this skill" });

    const adminUpdate = await app.request(`/api/multiremi/skills/${createdBody.skill.id}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ description: "Native updated", workspaceId: "local", createdBy: plain.id }),
    });
    expect(adminUpdate.status).toBe(200);
    const updatedBody = await adminUpdate.json();
    expect(updatedBody.skill.workspaceId).toBe(workspace.id);
    expect(updatedBody.skill.createdBy).toBe(creator.id);
    expect(updatedBody.skill.description).toBe("Native updated");
    expect(events.some((event) =>
      event.type === "skill:updated" &&
      event.actorId === "native-skill-admin" &&
      (event.payload.skill as any)?.id === createdBody.skill.id
    )).toBe(true);

    const deleted = await app.request(`/api/multiremi/skills/${createdBody.skill.id}`, {
      method: "DELETE",
      headers: authHeaders(adminToken.token),
    });
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).skill.archivedAt).toBeString();
    expect(events.some((event) =>
      event.type === "skill:deleted" &&
      event.actorId === "native-skill-admin" &&
      event.payload.skill_id === createdBody.skill.id
    )).toBe(true);
  });

  it("serves agent templates and creates agents from templates", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const codexRuntime = store.registerRuntime({ id: "rt_template_codex", name: "Template Codex", provider: "codex" });
    const claudeRuntime = store.registerRuntime({ id: "rt_template_claude", name: "Template Claude", provider: "claude" });
    const existingSkill = store.createSkill({
      workspaceId: "local",
      name: "root-cause-tracing",
      description: "Trace bugs",
      content: "# Root cause",
    });

    const templates = await app.request("/api/agent-templates");
    const templateBody = await templates.json();
    expect(templateBody.length).toBeGreaterThan(10);
    expect(templateBody.find((template: any) => template.slug === "bug-fixer")?.instructions).toBeUndefined();
    expect(templateBody.find((template: any) => template.slug === "bug-fixer")?.skills[0].cached_name).toBe("root-cause-tracing");

    const detail = await app.request("/api/agent-templates/bug-fixer");
    const detailBody = await detail.json();
    expect(detailBody.instructions).toContain("You debug systematically");

    const invalidTemplateCreate = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidTemplateCreate.status).toBe(400);
    expect(await invalidTemplateCreate.json()).toEqual({ error: "invalid request body" });

    const invalidNativeTemplateCreate = await app.request("/api/multiremi/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativeTemplateCreate.status).toBe(400);
    expect(await invalidNativeTemplateCreate.json()).toEqual({ error: "invalid request body" });

    const unknownProviderTemplate = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_slug: "summarizer", name: "No Runtime", provider: "gemini" }),
    });
    expect(unknownProviderTemplate.status).toBe(400);
    expect(await unknownProviderTemplate.json()).toMatchObject({ error: 'unknown provider "gemini"' });

    const multiremiTemplates = await app.request("/api/multiremi/agent-templates");
    const multiremiTemplatesBody = await multiremiTemplates.json();
    expect(multiremiTemplatesBody.total).toBe(templateBody.length);

    const created = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_slug: "bug-fixer",
        name: "Bug Fixer Agent",
        provider: "codex",
        runtime_id: codexRuntime.id,
        avatar_url: "https://example.com/template-bug-fixer.png",
        extra_skill_ids: [existingSkill.id],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.agent.name).toBe("Bug Fixer Agent");
    expect(createdBody.agent.provider).toBe("codex");
    expect(store.getAgent(createdBody.agent.id)?.provider).toBe("codex");
    expect(createdBody.agent.runtime_id).toBe("");
    expect(store.getAgent(createdBody.agent.id)?.runtimeId).toBeNull();
    expect(createdBody.agent.avatar_url).toBe("https://example.com/template-bug-fixer.png");
    expect(store.getAgent(createdBody.agent.id)?.avatarUrl).toBe("https://example.com/template-bug-fixer.png");
    expect(createdBody.agent.max_concurrent_tasks).toBe(6);
    expect(createdBody.agent.instructions).toContain("root cause");
    expect(createdBody.imported_skill_ids).toEqual([]);
    expect(createdBody.reused_skill_ids).toEqual([existingSkill.id]);
    expect(store.listAgentSkills(createdBody.agent.id).map((skill) => skill.id)).toEqual([existingSkill.id]);

    const duplicate = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_slug: "summarizer",
        name: "Bug Fixer Agent",
        runtime_id: codexRuntime.id,
      }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: "an agent named \"Bug Fixer Agent\" already exists in this workspace" });

    const multiremiCreated = await app.request("/api/multiremi/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateSlug: "summarizer",
        name: "Summarizer Agent",
        provider: "claude",
        runtimeId: claudeRuntime.id,
      }),
    });
    expect(multiremiCreated.status).toBe(201);
    const multiremiCreatedBody = await multiremiCreated.json();
    expect(multiremiCreatedBody.agent.name).toBe("Summarizer Agent");
    expect(multiremiCreatedBody.importedSkillIds).toEqual([]);
    expect(multiremiCreatedBody.reusedSkillIds).toEqual([]);
    const agentCreatedEvents = store.listAnalyticsEvents({ name: "agent_created" });
    expect(agentCreatedEvents).toHaveLength(2);
    expect(agentCreatedEvents[0]!.properties).toMatchObject({
      agent_id: createdBody.agent.id,
      provider: "codex",
      runtime_mode: "local",
      template: "bug-fixer",
      is_first_agent_in_workspace: true,
      source: "manual",
    });
    expect(agentCreatedEvents[1]!.properties).toMatchObject({
      agent_id: multiremiCreatedBody.agent.id,
      provider: "claude",
      runtime_mode: "local",
      template: "summarizer",
      is_first_agent_in_workspace: false,
      source: "manual",
    });
    expect(metricValue(store, "multiremi_agent_created_total", { runtime_mode: "local", source: "manual" })).toBe(2);

    const missing = await app.request("/api/agent-templates/not-real");
    expect(missing.status).toBe(404);
  });

  it("reuses imported template skills by resolved skill name", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const runtime = store.registerRuntime({ id: "rt_template_reuse", name: "Template reuse", provider: "codex" });
    const existing = store.createSkill({
      workspaceId: "local",
      name: "vercel-react-best-practices",
      description: "Existing real frontmatter name",
      content: "# Existing",
    });
    mockFetch((url) => {
      if (url === "https://api.github.com/repos/vercel-labs/agent-skills") {
        return jsonResponse({ default_branch: "main" });
      }
      if (url === "https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/SKILL.md") {
        return new Response("---\nname: vercel-react-best-practices\ndescription: React best practices\n---\n# Body");
      }
      if (url === "https://api.github.com/repos/vercel-labs/agent-skills/git/trees/main?recursive=1") {
        return jsonResponse({ tree: [{ path: "skills/react-best-practices/SKILL.md", type: "blob" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const response = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_slug: "code-reviewer",
        name: "Reviewer from Template",
        provider: "codex",
        runtime_id: runtime.id,
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.imported_skill_ids).toEqual([]);
    expect(body.reused_skill_ids).toEqual([existing.id]);
    expect(store.listSkills("local")).toHaveLength(1);
    expect(store.listAgentSkills(body.agent.id).map((skill) => skill.id)).toEqual([existing.id]);
  });

  it("imports skills from GitHub and skills.sh URLs", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const skillMd = [
      "---",
      "name: review-helper",
      "description: Review imported pull requests",
      "---",
      "# Review Helper",
    ].join("\n");
    const requestedUrls: string[] = [];

    mockFetch((url) => {
      requestedUrls.push(url);
      if (url === "https://api.github.com/repos/example/skills/commits/main") return new Response("sha", { status: 200 });
      if (url === "https://raw.githubusercontent.com/example/skills/main/review-helper/SKILL.md") return new Response(skillMd);
      if (url === "https://api.github.com/repos/example/skills/contents/review-helper?ref=main") {
        return jsonResponse([
          { name: "SKILL.md", path: "review-helper/SKILL.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/review-helper/SKILL.md" },
          { name: "templates", path: "review-helper/templates", type: "dir", url: "https://api.github.com/repos/example/skills/contents/review-helper/templates?ref=main" },
          { name: "logo.png", path: "review-helper/logo.png", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/review-helper/logo.png" },
        ]);
      }
      if (url === "https://api.github.com/repos/example/skills/contents/review-helper/templates?ref=main") {
        return jsonResponse([
          { name: "check.md", path: "review-helper/templates/check.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/review-helper/templates/check.md" },
        ]);
      }
      if (url === "https://raw.githubusercontent.com/example/skills/main/review-helper/templates/check.md") return new Response("Check list");

      if (url === "https://api.github.com/repos/example/skills") return jsonResponse({ default_branch: "main" });
      if (url === "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/SKILL.md") return new Response(skillMd);
      if (url === "https://api.github.com/repos/example/skills/contents/skills/review-helper?ref=main") {
        return jsonResponse([
          { name: "SKILL.md", path: "skills/review-helper/SKILL.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/SKILL.md" },
          { name: "notes.md", path: "skills/review-helper/notes.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/notes.md" },
        ]);
      }
      if (url === "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/notes.md") return new Response("Notes");
      return new Response("not found", { status: 404 });
    });

    const githubImport = await app.request("/api/multiremi/skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/example/skills/tree/main/review-helper", workspaceId: "local" }),
    });
    expect(githubImport.status).toBe(201);
    const githubBody = await githubImport.json();
    expect(githubBody.source).toBe("github");
    expect(githubBody.skill.name).toBe("review-helper");
    expect(githubBody.skill.description).toBe("Review imported pull requests");
    expect(githubBody.skill.config.origin.type).toBe("github");
    expect(githubBody.skill.files).toHaveLength(1);
    expect(githubBody.skill.files[0].path).toBe("templates/check.md");
    expect(githubBody.skill.files[0].content).toBe("Check list");

    const skillsShImport = await app.request("/api/skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://skills.sh/example/skills/review-helper", workspaceId: "local", name: "Imported Review" }),
    });
    expect(skillsShImport.status).toBe(201);
    const skillsShBody = await skillsShImport.json();
    expect(skillsShBody.name).toBe("Imported Review");
    expect(skillsShBody.workspace_id).toBe("local");
    expect(skillsShBody.config.origin.type).toBe("skills_sh");
    expect(skillsShBody.files[0].path).toBe("notes.md");
    expect(skillsShBody.files[0].skill_id).toBe(skillsShBody.id);
    expect(skillsShBody.files[0].skillId).toBeUndefined();
    expect(Object.keys(skillsShBody).filter((key) => /[A-Z]/.test(key))).toEqual([]);

    const duplicateSkillsShImport = await app.request("/api/skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://skills.sh/example/skills/review-helper", workspaceId: "local", name: "Imported Review" }),
    });
    expect(duplicateSkillsShImport.status).toBe(409);
    expect(await duplicateSkillsShImport.json()).toEqual({
      error: "a skill with this name already exists",
      existing_skill: { id: skillsShBody.id, name: "Imported Review" },
    });
    expect(requestedUrls).toContain("https://api.github.com/repos/example/skills/contents/skills/review-helper?ref=main");
  });

  it("serves runtime metadata updates and usage endpoints", async () => {
    const store = createStore();
    const member = store.createWorkspaceMember({ name: "Ada", workspaceId: "local" });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "usage" });
    const app = createMultiremiApp({ store });

    const unsupportedProvider = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "rt_gemini", name: "Gemini runtime", provider: "gemini", workspace_id: "local" }),
    });
    expect(unsupportedProvider.status).toBe(400);
    expect(await unsupportedProvider.json()).toEqual({ error: "Unsupported Multiremi runtime provider: gemini" });
    expect(store.getRuntime("rt_gemini")).toBeNull();

    const created = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "rt_api",
        name: "API runtime",
        provider: "codex",
        workspace_id: "local",
        owner_id: member.id,
        visibility: "public",
        max_concurrency: 2,
        runtime_mode: "local",
        device_info: "API Laptop · 1.0.0",
        metadata: { version: "1.0.0", cli_version: "0.2.0", launched_by: "api" },
        models: [{ id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true }],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.runtime.ownerId).toBe(member.id);
    expect(createdBody.runtime.runtimeMode).toBe("local");
    expect(createdBody.runtime.deviceInfo).toBe("API Laptop · 1.0.0");
    expect(createdBody.runtime.metadata).toMatchObject({ version: "1.0.0", cli_version: "0.2.0", launched_by: "api" });
    expect(createdBody.runtime.visibility).toBe("public");
    expect(createdBody.runtime.maxConcurrency).toBe(2);
    expect(createdBody.runtime.models[0].default).toBeTrue();

    const models = await app.request("/api/runtimes/rt_api/models");
    expect((await models.json()).models[0].id).toBe("gpt-5.5");

    const updatedModels = await app.request("/api/multiremi/runtimes/rt_api/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: [{ id: "gpt-5.4", label: "GPT-5.4", provider: "openai", default: true }] }),
    });
    expect((await updatedModels.json()).models[0].id).toBe("gpt-5.4");

    const claim = await app.request("/api/daemon/runtimes/rt_api/tasks/claim", { method: "POST" });
    expect((await claim.json()).task.id).toBe(task.id);
    await app.request(`/api/daemon/tasks/${task.id}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usage: [{ provider: "codex", model: "gpt-5", input_tokens: 11, output_tokens: 5, cache_read_tokens: 2 }],
      }),
    });

    const detail = await app.request("/api/multiremi/runtimes/rt_api");
    const detailBody = await detail.json();
    expect(detailBody.runtime.taskCount).toBe(1);
    expect(detailBody.runtime.inputTokens).toBe(11);
    expect(detailBody.usage[0].model).toBe("gpt-5");

    const usage = await app.request("/api/runtimes/rt_api/usage");
    const usageBody = await usage.json();
    expect(usageBody[0]).toEqual({
      runtime_id: "rt_api",
      date: expect.any(String),
      provider: "codex",
      model: "gpt-5",
      input_tokens: 11,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
    });
    expect(usageBody[0].runtimeId).toBeUndefined();
    expect(usageBody[0].cacheReadTokens).toBeUndefined();

    const byAgent = await app.request("/api/runtimes/rt_api/usage/by-agent");
    const byAgentBody = await byAgent.json();
    expect(byAgentBody[0]).toEqual({
      agent_id: agent.id,
      model: "gpt-5",
      input_tokens: 11,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
      task_count: 1,
    });
    expect(byAgentBody[0].agentId).toBeUndefined();

    const byHour = await app.request("/api/multiremi/runtimes/rt_api/usage/by-hour");
    const byHourBody = await byHour.json();
    expect(byHourBody.usage[0].model).toBe("gpt-5");

    const compatibilityByHour = await app.request("/api/runtimes/rt_api/usage/by-hour");
    const compatibilityByHourBody = await compatibilityByHour.json();
    expect(compatibilityByHourBody[0]).toEqual({
      hour: expect.any(Number),
      model: "gpt-5",
      input_tokens: 11,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
      task_count: 1,
    });
    expect(compatibilityByHourBody[0].inputTokens).toBeUndefined();

    const activity = await app.request("/api/runtimes/rt_api/task-activity");
    expect((await activity.json())[0].count).toBe(1);
    const compatibilityActivity = await app.request("/api/runtimes/rt_api/activity");
    expect((await compatibilityActivity.json())[0]).toEqual({ hour: expect.any(Number), count: 1 });

    const dashboardUsage = await app.request("/api/dashboard/usage/daily");
    expect((await dashboardUsage.json())[0].model).toBe("gpt-5");

    const invalidNativePatch = await app.request("/api/multiremi/runtimes/rt_api", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativePatch.status).toBe(400);
    expect(await invalidNativePatch.json()).toEqual({ error: "invalid request body" });

    const updated = await app.request("/api/multiremi/runtimes/rt_api", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner_id: null,
        visibility: "private",
        max_concurrency: 4,
        device_info: "API Laptop · 1.0.1",
        metadata: { version: "1.0.1", cli_version: "0.2.1", launched_by: "patch" },
      }),
    });
    const updatedBody = await updated.json();
    expect(updatedBody.runtime.ownerId).toBeNull();
    expect(updatedBody.runtime.deviceInfo).toBe("API Laptop · 1.0.1");
    expect(updatedBody.runtime.metadata).toMatchObject({ version: "1.0.1", cli_version: "0.2.1", launched_by: "patch" });
    expect(updatedBody.runtime.visibility).toBe("private");
    expect(updatedBody.runtime.maxConcurrency).toBe(4);

    const invalidJsonCompatibilityPatch = await app.request("/api/runtimes/rt_api", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJsonCompatibilityPatch.status).toBe(400);
    expect(await invalidJsonCompatibilityPatch.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntime("rt_api")?.visibility).toBe("private");

    const compatibilityPatch = await app.request("/api/runtimes/rt_api", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "public", max_concurrency: 9 }),
    });
    const compatibilityPatchBody = await compatibilityPatch.json();
    expect(compatibilityPatch.status).toBe(200);
    expect(compatibilityPatchBody.visibility).toBe("public");
    expect(compatibilityPatchBody.launch_header).toBe("codex app-server");
    expect(compatibilityPatchBody.runtime_mode).toBe("local");
    expect(compatibilityPatchBody.max_concurrency).toBeUndefined();
    expect(store.getRuntime("rt_api")?.maxConcurrency).toBe(4);

    const invalidCompatibilityPatch = await app.request("/api/runtimes/rt_api", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "workspace" }),
    });
    expect(invalidCompatibilityPatch.status).toBe(400);
    expect(await invalidCompatibilityPatch.json()).toEqual({ error: "visibility must be 'private' or 'public'" });
  });

  it("scopes runtime console APIs by workspace and owner permissions", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ id: "bob", name: "Bob", role: "member" });
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "Bob", type: "pat", workspaceId: "local", userId: "bob" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const alicePrivate = store.registerRuntime({
      id: "rt_scope_alice",
      name: "Alice private",
      provider: "codex",
      workspaceId: "local",
      ownerId: "alice",
      visibility: "private",
    });
    const bobPublic = store.registerRuntime({
      id: "rt_scope_bob",
      name: "Bob public",
      provider: "claude",
      workspaceId: "local",
      ownerId: "bob",
      visibility: "public",
    });
    const remoteRuntime = store.registerRuntime({
      id: "rt_scope_remote",
      name: "Remote runtime",
      provider: "codex",
      workspaceId: "remote",
      ownerId: "alice",
      visibility: "public",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

    const bobList = await app.request("/api/runtimes", { headers: authHeaders(bobToken.token) });
    const bobRuntimes = await bobList.json();
    const bobRuntimeIds = bobRuntimes.map((runtime: any) => runtime.id);
    expect(bobRuntimeIds).toContain(alicePrivate.id);
    expect(bobRuntimeIds).toContain(bobPublic.id);
    expect(bobRuntimeIds).not.toContain(remoteRuntime.id);
    expect(bobRuntimes.find((runtime: any) => runtime.id === alicePrivate.id)).toMatchObject({
      workspace_id: "local",
      owner_id: "alice",
      launch_header: "codex app-server",
      runtime_mode: "local",
    });

    const bobOwnedList = await app.request("/api/runtimes?owner=me", { headers: authHeaders(bobToken.token) });
    expect((await bobOwnedList.json()).map((runtime: any) => runtime.id)).toEqual([bobPublic.id]);
    const bobOwnedNativeList = await app.request("/api/multiremi/runtimes?owner=me", { headers: authHeaders(bobToken.token) });
    expect((await bobOwnedNativeList.json()).runtimes.map((runtime: any) => runtime.id)).toEqual([bobPublic.id]);

    const bobDetail = await app.request(`/api/runtimes/${alicePrivate.id}`, { headers: authHeaders(bobToken.token) });
    expect(bobDetail.status).toBe(200);
    expect((await bobDetail.json()).runtime.id).toBe(alicePrivate.id);

    const remoteDetail = await app.request(`/api/runtimes/${remoteRuntime.id}`, { headers: authHeaders(aliceToken.token) });
    expect(remoteDetail.status).toBe(404);
    expect(await remoteDetail.json()).toEqual({ error: "runtime not found" });

    const bobUsage = await app.request(`/api/runtimes/${alicePrivate.id}/usage`, { headers: authHeaders(bobToken.token) });
    expect(bobUsage.status).toBe(200);

    const bobModelRequest = await app.request(`/api/runtimes/${alicePrivate.id}/models`, {
      method: "POST",
      headers: authHeaders(bobToken.token),
    });
    expect(bobModelRequest.status).toBe(200);
    expect((await bobModelRequest.json()).status).toBe("pending");

    const bobModelCatalogWrite = await app.request(`/api/runtimes/${alicePrivate.id}/models`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ models: [{ id: "blocked", label: "Blocked" }] }),
    });
    expect(bobModelCatalogWrite.status).toBe(403);
    expect(await bobModelCatalogWrite.json()).toEqual({ error: "you can only edit your own runtimes" });

    const bobPatch = await app.request(`/api/runtimes/${alicePrivate.id}`, {
      method: "PATCH",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(bobPatch.status).toBe(403);
    expect(await bobPatch.json()).toEqual({ error: "you can only edit your own runtimes" });

    const bobDelete = await app.request(`/api/runtimes/${alicePrivate.id}`, {
      method: "DELETE",
      headers: authHeaders(bobToken.token),
    });
    expect(bobDelete.status).toBe(403);
    expect(await bobDelete.json()).toEqual({ error: "you can only delete your own runtimes" });

    const alicePatch = await app.request(`/api/runtimes/${alicePrivate.id}`, {
      method: "PATCH",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(alicePatch.status).toBe(200);
    expect((await alicePatch.json()).visibility).toBe("public");

    const adminPatch = await app.request(`/api/runtimes/${alicePrivate.id}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ visibility: "private", max_concurrency: 4 }),
    });
    expect(adminPatch.status).toBe(200);
    const adminPatchBody = await adminPatch.json();
    expect(adminPatchBody.visibility).toBe("private");
    expect(adminPatchBody.max_concurrency).toBeUndefined();
    expect(store.getRuntime(alicePrivate.id)?.maxConcurrency).toBe(1);

    const adminLocalSkills = await app.request(`/api/runtimes/${alicePrivate.id}/local-skills`, {
      method: "POST",
      headers: authHeaders(adminToken.token),
    });
    expect(adminLocalSkills.status).toBe(403);
    expect(await adminLocalSkills.json()).toEqual({ error: "you can only access local skills from your own runtimes" });

    const aliceLocalSkills = await app.request(`/api/runtimes/${alicePrivate.id}/local-skills`, {
      method: "POST",
      headers: authHeaders(aliceToken.token),
    });
    expect(aliceLocalSkills.status).toBe(200);
    expect((await aliceLocalSkills.json()).status).toBe("pending");
  });

  it("matches Go runtime delete cascade contracts", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_delete_contract", name: "Delete contract", provider: "codex" });
    const agent = store.createAgent({
      id: "agt_delete_contract",
      name: "Delete Contract Agent",
      provider: "codex",
      runtimeId: runtime.id,
    });
    const helper = store.createAgent({
      id: "agt_delete_helper",
      name: "Delete Helper",
      provider: "codex",
    });
    const agentTask = store.createTask({ agentId: agent.id, prompt: "agent-bound active task" });
    const runtimeTask = store.createTask({ agentId: helper.id, runtimeId: runtime.id, prompt: "runtime-bound active task" });
    const app = createMultiremiApp({ store });

    const strictDelete = await app.request(`/api/runtimes/${runtime.id}`, { method: "DELETE" });
    expect(strictDelete.status).toBe(409);
    const strictBody = await strictDelete.json();
    expect(strictBody.code).toBe("runtime_has_active_agents");
    expect(strictBody.error).toContain("cannot delete runtime");
    expect(strictBody.active_agents.map((item: any) => item.id)).toEqual([agent.id]);
    expect(store.getRuntime(runtime.id)).not.toBeNull();

    const invalidBody = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntime(runtime.id)).not.toBeNull();

    const badExpected = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_active_agent_ids: [agent.id, 42] }),
    });
    expect(badExpected.status).toBe(400);
    expect(await badExpected.json()).toEqual({ error: "expected_active_agent_ids must be a list of valid UUIDs" });

    const camelExpected = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedActiveAgentIds: [agent.id] }),
    });
    expect(camelExpected.status).toBe(409);
    const camelExpectedBody = await camelExpected.json();
    expect(camelExpectedBody.code).toBe("runtime_delete_plan_changed");
    expect(camelExpectedBody.active_agents.map((item: any) => item.id)).toEqual([agent.id]);
    expect(store.getRuntime(runtime.id)).not.toBeNull();

    const planChanged = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_active_agent_ids: [] }),
    });
    expect(planChanged.status).toBe(409);
    const planChangedBody = await planChanged.json();
    expect(planChangedBody.code).toBe("runtime_delete_plan_changed");
    expect(planChangedBody.error).toBe("the active agent set changed; please review and confirm again.");
    expect(planChangedBody.active_agents.map((item: any) => item.id)).toEqual([agent.id]);
    expect(store.getRuntime(runtime.id)).not.toBeNull();

    const cascade = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_active_agent_ids: [agent.id] }),
    });
    expect(cascade.status).toBe(200);
    expect(await cascade.json()).toEqual({ status: "ok", agents_archived: 1, tasks_cancelled: 2 });
    expect(store.getRuntime(runtime.id)).toBeNull();
    expect(store.getAgent(agent.id)).toBeNull();
    expect(store.getTask(agentTask.id)?.status).toBe("cancelled");
    expect(store.getTask(runtimeTask.id)?.status).toBe("cancelled");
  });

  it("serves runtime model list request flow", async () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_models_flow", name: "Models runtime", provider: "codex" });
    const app = createMultiremiApp({ store });

    const nativeInvalidCatalogWrite = await app.request("/api/multiremi/runtimes/rt_models_flow/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(nativeInvalidCatalogWrite.status).toBe(400);
    expect(await nativeInvalidCatalogWrite.json()).toEqual({ error: "invalid request body" });

    const invalidCatalogWrite = await app.request("/api/runtimes/rt_models_flow/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCatalogWrite.status).toBe(400);
    expect(await invalidCatalogWrite.json()).toEqual({ error: "invalid request body" });

    const created = await app.request("/api/runtimes/rt_models_flow/models", { method: "POST" });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.id).toStartWith("rml_");
    expect(createdBody.status).toBe("pending");

    const claimed = await app.request("/api/daemon/runtimes/rt_models_flow/models/claim", { method: "POST" });
    const claimedBody = await claimed.json();
    expect(claimedBody.request.id).toBe(createdBody.id);
    expect(claimedBody.request.status).toBe("running");

    const reported = await app.request(`/api/daemon/runtimes/rt_models_flow/models/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        supported: true,
        models: [{
          id: "gpt-5.1-codex",
          label: "GPT-5.1 Codex",
          provider: "openai",
          default: true,
          thinking: {
            supported_levels: [{ value: "high", label: "High", description: "More reasoning" }],
            default_level: "high",
          },
        }],
      }),
    });
    expect(reported.status).toBe(200);

    const detail = await app.request(`/api/runtimes/rt_models_flow/models/${createdBody.id}`);
    const detailBody = await detail.json();
    expect(detailBody.status).toBe("completed");
    expect(detailBody.runtime_id).toBe("rt_models_flow");
    expect(detailBody.runtimeId).toBeUndefined();
    expect(detailBody.created_at).toBeString();
    expect(detailBody.createdAt).toBeUndefined();
    expect(detailBody.models[0].default).toBe(true);
    expect(detailBody.models[0].thinking.supported_levels[0].value).toBe("high");
    expect(detailBody.models[0].thinking.default_level).toBe("high");
    expect(detailBody.models[0].thinking.supportedLevels).toBeUndefined();

    const models = await app.request("/api/runtimes/rt_models_flow/models");
    const modelsBody = await models.json();
    expect(modelsBody.runtime_id).toBe("rt_models_flow");
    expect(modelsBody.runtimeId).toBeUndefined();
    expect(modelsBody.models[0].id).toBe("gpt-5.1-codex");
    expect(modelsBody.models[0].thinking.supported_levels[0].label).toBe("High");
    expect(modelsBody.models[0].createdAt).toBeUndefined();

    const failed = await app.request("/api/multiremi/runtimes/rt_models_flow/models", { method: "POST" });
    const failedBody = await failed.json();
    await app.request(`/api/daemon/runtimes/rt_models_flow/models/${failedBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "failed", error: "provider not available" }),
    });
    const failedDetail = await app.request(`/api/multiremi/runtimes/rt_models_flow/models/${failedBody.id}`);
    const failedDetailBody = await failedDetail.json();
    expect(failedDetailBody.status).toBe("failed");
    expect(failedDetailBody.error).toBe("provider not available");

    const missingModelReport = await app.request("/api/daemon/runtimes/rt_models_flow/models/rml_missing/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(missingModelReport.status).toBe(404);
    expect(await missingModelReport.json()).toEqual({ error: "request not found" });

    const invalidJsonModelRequest = store.createRuntimeModelListRequest("rt_models_flow");
    const invalidJsonModelReport = await app.request(`/api/daemon/runtimes/rt_models_flow/models/${invalidJsonModelRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJsonModelReport.status).toBe(400);
    expect(await invalidJsonModelReport.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntimeModelListRequest("rt_models_flow", invalidJsonModelRequest.id)?.status).toBe("pending");
    const cleanupInvalidJsonModelRequest = await app.request(`/api/daemon/runtimes/rt_models_flow/models/${invalidJsonModelRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "failed", error: "invalid json test cleanup" }),
    });
    expect(cleanupInvalidJsonModelRequest.status).toBe(200);

    const stalePending = store.createRuntimeModelListRequest("rt_models_flow");
    const oldPendingAt = new Date(Date.now() - 31_000).toISOString();
    db!.run("UPDATE multiremi_runtime_model_list_requests SET created_at = ?, updated_at = ? WHERE id = ?", [
      oldPendingAt,
      oldPendingAt,
      stalePending.id,
    ]);
    const stalePendingPoll = await app.request(`/api/runtimes/rt_models_flow/models/${stalePending.id}`);
    const stalePendingBody = await stalePendingPoll.json();
    expect(stalePendingBody.status).toBe("timeout");
    expect(stalePendingBody.error).toBe("daemon did not respond within 30 seconds");
    expect(stalePendingBody.created_at).toBe(oldPendingAt);
    expect(stalePendingBody.createdAt).toBeUndefined();
    expect((await (await app.request("/api/daemon/runtimes/rt_models_flow/models/claim", { method: "POST" })).json()).request).toBeNull();

    const staleRunning = store.createRuntimeModelListRequest("rt_models_flow");
    await app.request("/api/daemon/runtimes/rt_models_flow/models/claim", { method: "POST" });
    const oldRunningAt = new Date(Date.now() - 61_000).toISOString();
    db!.run("UPDATE multiremi_runtime_model_list_requests SET run_started_at = ?, updated_at = ? WHERE id = ?", [
      oldRunningAt,
      oldRunningAt,
      staleRunning.id,
    ]);
    const staleRunningPoll = await app.request(`/api/multiremi/runtimes/rt_models_flow/models/${staleRunning.id}`);
    const staleRunningBody = await staleRunningPoll.json();
    expect(staleRunningBody.status).toBe("timeout");
    expect(staleRunningBody.error).toBe("daemon did not finish within 60 seconds");

    const lateModelReport = await app.request(`/api/daemon/runtimes/rt_models_flow/models/${staleRunning.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", models: [{ id: "late-model", label: "Late Model" }] }),
    });
    expect(lateModelReport.status).toBe(200);
    expect(store.getRuntimeModelListRequest("rt_models_flow", staleRunning.id)?.status).toBe("timeout");
  });

  it("serves runtime update request flow", async () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_update_flow", name: "Update runtime", provider: "codex" });
    const app = createMultiremiApp({ store });

    const nativeInvalidCreated = await app.request("/api/multiremi/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(nativeInvalidCreated.status).toBe(400);
    expect(await nativeInvalidCreated.json()).toEqual({ error: "invalid request body" });

    const invalidCreated = await app.request("/api/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCreated.status).toBe(400);
    expect(await invalidCreated.json()).toEqual({ error: "invalid request body" });

    const camelCreated = await app.request("/api/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "v1.2.3" }),
    });
    expect(camelCreated.status).toBe(400);
    expect(await camelCreated.json()).toEqual({ error: "target_version is required" });

    const created = await app.request("/api/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_version: "v1.2.3" }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.id).toStartWith("rup_");
    expect(createdBody.target_version).toBe("v1.2.3");
    expect(createdBody.targetVersion).toBeUndefined();
    expect(createdBody.runtime_id).toBe("rt_update_flow");
    expect(createdBody.runtimeId).toBeUndefined();
    expect(createdBody.created_at).toBeString();
    expect(createdBody.createdAt).toBeUndefined();
    expect(createdBody.status).toBe("pending");

    const duplicate = await app.request("/api/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_version: "v1.2.4" }),
    });
    expect(duplicate.status).toBe(409);

    const missingUpdateReport = await app.request("/api/daemon/runtimes/rt_update_flow/update/rup_missing/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(missingUpdateReport.status).toBe(404);
    expect(await missingUpdateReport.json()).toEqual({ error: "update not found" });

    const invalidJsonUpdateReport = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJsonUpdateReport.status).toBe(400);
    expect(await invalidJsonUpdateReport.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntimeUpdateRequest("rt_update_flow", createdBody.id)?.status).toBe("pending");

    const invalidStatusUpdateReport = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });
    expect(invalidStatusUpdateReport.status).toBe(400);
    expect(await invalidStatusUpdateReport.json()).toEqual({ error: "invalid status: bogus" });
    expect(store.getRuntimeUpdateRequest("rt_update_flow", createdBody.id)?.status).toBe("pending");

    const claimed = await app.request("/api/daemon/runtimes/rt_update_flow/update/claim", { method: "POST" });
    const claimedBody = await claimed.json();
    expect(claimedBody.request.id).toBe(createdBody.id);
    expect(claimedBody.request.status).toBe("running");

    const running = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "running" }),
    });
    expect(running.status).toBe(200);

    const completed = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", output: "updated ok" }),
    });
    expect(completed.status).toBe(200);

    const detail = await app.request(`/api/runtimes/rt_update_flow/update/${createdBody.id}`);
    const detailBody = await detail.json();
    expect(detailBody.status).toBe("completed");
    expect(detailBody.output).toBe("updated ok");
    expect(detailBody.target_version).toBe("v1.2.3");
    expect(detailBody.targetVersion).toBeUndefined();

    const next = await app.request("/api/multiremi/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "v1.2.4" }),
    });
    expect(next.status).toBe(200);
    const nextBody = await next.json();
    await app.request("/api/daemon/runtimes/rt_update_flow/update/claim", { method: "POST" });
    await app.request(`/api/daemon/runtimes/rt_update_flow/update/${nextBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "failed", error: "download failed" }),
    });
    const failedDetail = await app.request(`/api/multiremi/runtimes/rt_update_flow/update/${nextBody.id}`);
    const failedDetailBody = await failedDetail.json();
    expect(failedDetailBody.status).toBe("failed");
    expect(failedDetailBody.error).toBe("download failed");

    const stalePending = store.createRuntimeUpdateRequest("rt_update_flow", { target_version: "v2.0.0" });
    const oldPendingAt = new Date(Date.now() - 121_000).toISOString();
    db!.run("UPDATE multiremi_runtime_update_requests SET created_at = ?, updated_at = ? WHERE id = ?", [
      oldPendingAt,
      oldPendingAt,
      stalePending.id,
    ]);
    const stalePendingPoll = await app.request(`/api/runtimes/rt_update_flow/update/${stalePending.id}`);
    const stalePendingBody = await stalePendingPoll.json();
    expect(stalePendingBody.status).toBe("timeout");
    expect(stalePendingBody.error).toBe("daemon did not respond within 120 seconds");
    expect(stalePendingBody.created_at).toBe(oldPendingAt);
    expect(stalePendingBody.createdAt).toBeUndefined();
    expect((await (await app.request("/api/daemon/runtimes/rt_update_flow/update/claim", { method: "POST" })).json()).request).toBeNull();

    const staleRunning = store.createRuntimeUpdateRequest("rt_update_flow", { target_version: "v2.1.0" });
    await app.request("/api/daemon/runtimes/rt_update_flow/update/claim", { method: "POST" });
    const oldRunningAt = new Date(Date.now() - 151_000).toISOString();
    db!.run("UPDATE multiremi_runtime_update_requests SET run_started_at = ?, updated_at = ? WHERE id = ?", [
      oldRunningAt,
      oldRunningAt,
      staleRunning.id,
    ]);
    const staleRunningPoll = await app.request(`/api/multiremi/runtimes/rt_update_flow/update/${staleRunning.id}`);
    const staleRunningBody = await staleRunningPoll.json();
    expect(staleRunningBody.status).toBe("timeout");
    expect(staleRunningBody.error).toBe("update did not complete within 150 seconds");

    const lateUpdateReport = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${staleRunning.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", output: "late ok" }),
    });
    expect(lateUpdateReport.status).toBe(200);
    expect(store.getRuntimeUpdateRequest("rt_update_flow", staleRunning.id)?.status).toBe("timeout");
  });

  it("supports ACP-scope update requests (no target version, defaults to latest)", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_acp_update", name: "ACP update runtime", provider: "codex" });
    const app = createMultiremiApp({ store });

    // ACP-bridge updates always pull @latest, so no target_version is required.
    const created = await app.request(`/api/runtimes/${runtime.id}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "acp" }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.scope).toBe("acp");
    expect(createdBody.target_version).toBe("latest");
    expect(createdBody.status).toBe("pending");

    // The heartbeat ack carries the scope so the daemon reinstalls bridges (not the CLI).
    const ack = store.heartbeatRuntime(runtime.id, { supportsBatchImport: true });
    expect(ack.pending_update).toMatchObject({ id: createdBody.id, scope: "acp", target_version: "latest" });
    expect(store.getRuntimeUpdateRequest(runtime.id, createdBody.id)?.scope).toBe("acp");
  });

  it("supports agent-scope update requests (runs the agent CLI updater)", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_agent_update", name: "Agent update runtime", provider: "claude" });
    const app = createMultiremiApp({ store });

    const created = await app.request(`/api/runtimes/${runtime.id}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "agent" }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.scope).toBe("agent");
    expect(createdBody.target_version).toBe("latest");

    const ack = store.heartbeatRuntime(runtime.id, { supportsBatchImport: true });
    expect(ack.pending_update).toMatchObject({ id: createdBody.id, scope: "agent" });
    expect(store.getRuntimeUpdateRequest(runtime.id, createdBody.id)?.scope).toBe("agent");
  });

  it("serves runtime local skill list and import request flows", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "skill-runtime", provider: "claude", workspaceId: "local" });
    const app = createMultiremiApp({ store });

    const listInit = await app.request(`/api/runtimes/${runtime.id}/local-skills`, { method: "POST" });
    expect(listInit.status).toBe(200);
    const listRequest = await listInit.json();
    expect(listRequest.status).toBe("pending");

    const listClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/claim`, { method: "POST" });
    const listClaimBody = await listClaim.json();
    expect(listClaimBody.request.id).toBe(listRequest.id);
    expect(listClaimBody.request.status).toBe("running");

    const missingListReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/rls_missing/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(missingListReport.status).toBe(404);
    expect(await missingListReport.json()).toEqual({ error: "request not found" });

    const invalidJsonListReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/${listRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJsonListReport.status).toBe(400);
    expect(await invalidJsonListReport.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntimeLocalSkillListRequest(runtime.id, listRequest.id)?.status).toBe("running");

    const listReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/${listRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skills: [{
          key: "review-helper",
          name: "Review Helper",
          description: "Review local files",
          source_path: "/home/me/.claude/skills/review-helper",
          provider: "claude",
          file_count: 2,
        }],
      }),
    });
    expect(listReport.status).toBe(200);

    const listPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/${listRequest.id}`);
    const listPollBody = await listPoll.json();
    expect(listPollBody.status).toBe("completed");
    expect(listPollBody.runtime_id).toBe(runtime.id);
    expect(listPollBody.runtimeId).toBeUndefined();
    expect(listPollBody.created_at).toBeString();
    expect(listPollBody.createdAt).toBeUndefined();
    expect(listPollBody.skills[0].source_path).toBe("/home/me/.claude/skills/review-helper");
    expect(listPollBody.skills[0].file_count).toBe(2);
    expect(listPollBody.skills[0].sourcePath).toBeUndefined();
    expect(listPollBody.skills[0].fileCount).toBeUndefined();

    const camelListRequest = store.createRuntimeLocalSkillListRequest(runtime.id);
    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/claim`, { method: "POST" })).json()).request.id).toBe(camelListRequest.id);
    const camelListReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/${camelListRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skills: [{
          key: "camel-helper",
          name: "Camel Helper",
          description: "Camel aliases should be ignored",
          sourcePath: "/home/me/.claude/skills/camel-helper",
          provider: "claude",
          fileCount: 7,
        }],
      }),
    });
    expect(camelListReport.status).toBe(200);
    const camelListBody = await (await app.request(`/api/runtimes/${runtime.id}/local-skills/${camelListRequest.id}`)).json();
    expect(camelListBody.skills[0]).toMatchObject({
      key: "camel-helper",
      source_path: "",
      file_count: 0,
    });

    const nativeInvalidImportInit = await app.request(`/api/multiremi/runtimes/${runtime.id}/local-skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(nativeInvalidImportInit.status).toBe(400);
    expect(await nativeInvalidImportInit.json()).toEqual({ error: "invalid request body" });

    const invalidImportInit = await app.request(`/api/runtimes/${runtime.id}/local-skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidImportInit.status).toBe(400);
    expect(await invalidImportInit.json()).toEqual({ error: "invalid request body" });

    const importInit = await app.request(`/api/runtimes/${runtime.id}/local-skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_key: "review-helper", name: "Imported Local Review" }),
    });
    expect(importInit.status).toBe(200);
    const importRequest = await importInit.json();
    expect(importRequest.status).toBe("pending");
    expect(importRequest.skill_key).toBe("review-helper");
    expect(importRequest.skillKey).toBeUndefined();
    expect(importRequest.created_at).toBeString();
    expect(importRequest.createdAt).toBeUndefined();

    const importClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/claim?limit=5`, { method: "POST" });
    const importClaimBody = await importClaim.json();
    expect(importClaimBody.requests[0].id).toBe(importRequest.id);
    expect(importClaimBody.requests[0].skillKey).toBe("review-helper");

    const missingImportReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/rli_missing/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(missingImportReport.status).toBe(404);
    expect(await missingImportReport.json()).toEqual({ error: "request not found" });

    const invalidJsonImportReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${importRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJsonImportReport.status).toBe(400);
    expect(await invalidJsonImportReport.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntimeLocalSkillImportRequest(runtime.id, importRequest.id)?.status).toBe("running");

    const importReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${importRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skill: {
          name: "Review Helper",
          description: "Daemon description",
          content: "# Review Helper",
          provider: "claude",
          source_path: "/home/me/.claude/skills/review-helper",
          files: [{ path: "notes/check.md", content: "Check" }],
        },
      }),
    });
    expect(importReport.status).toBe(200);

    const importPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/import/${importRequest.id}`);
    const importPollBody = await importPoll.json();
    expect(importPollBody.status).toBe("completed");
    expect(importPollBody.skill_key).toBe("review-helper");
    expect(importPollBody.skillKey).toBeUndefined();
    expect(importPollBody.skill.name).toBe("Imported Local Review");
    expect(importPollBody.skill.workspace_id).toBe("local");
    expect(importPollBody.skill.workspaceId).toBeUndefined();
    expect(importPollBody.skill.config.origin.type).toBe("runtime_local");
    expect(importPollBody.skill.files[0].skill_id).toBe(importPollBody.skill.id);
    expect(importPollBody.skill.files[0].path).toBe("notes/check.md");

    const camelImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "camel-import", name: "Camel Import" });
    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/claim?limit=5`, { method: "POST" })).json()).requests[0].id).toBe(camelImport.id);
    const camelImportReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${camelImport.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skill: {
          name: "Camel Import",
          description: "Camel sourcePath should be ignored",
          content: "# Camel Import",
          provider: "claude",
          sourcePath: "/home/me/.claude/skills/camel-import",
        },
      }),
    });
    expect(camelImportReport.status).toBe(200);
    const camelImportBody = await (await app.request(`/api/runtimes/${runtime.id}/local-skills/import/${camelImport.id}`)).json();
    expect(camelImportBody.skill.config.origin).toMatchObject({
      type: "runtime_local",
      runtime_id: runtime.id,
      provider: "claude",
      source_path: "",
    });

    const emptyImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "empty-bundle", name: "Empty Bundle" });
    const emptyImportReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${emptyImport.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(emptyImportReport.status).toBe(200);
    expect(await emptyImportReport.json()).toEqual({ status: "ok" });
    const emptyImportDetail = store.getRuntimeLocalSkillImportRequest(runtime.id, emptyImport.id);
    expect(emptyImportDetail?.status).toBe("failed");
    expect(emptyImportDetail?.error).toBe("daemon returned an empty skill bundle");

    const staleListPending = store.createRuntimeLocalSkillListRequest(runtime.id);
    const oldLocalSkillPendingAt = new Date(Date.now() - 181_000).toISOString();
    db!.run("UPDATE multiremi_runtime_local_skill_list_requests SET created_at = ?, updated_at = ? WHERE id = ?", [
      oldLocalSkillPendingAt,
      oldLocalSkillPendingAt,
      staleListPending.id,
    ]);
    const staleListPendingPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/${staleListPending.id}`);
    const staleListPendingBody = await staleListPendingPoll.json();
    expect(staleListPendingBody.status).toBe("timeout");
    expect(staleListPendingBody.error).toBe("daemon did not respond within 3 minutes");
    expect(staleListPendingBody.created_at).toBe(oldLocalSkillPendingAt);
    expect(staleListPendingBody.createdAt).toBeUndefined();
    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/claim`, { method: "POST" })).json()).request).toBeNull();

    const staleListRunning = store.createRuntimeLocalSkillListRequest(runtime.id);
    await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/claim`, { method: "POST" });
    const oldLocalSkillRunningAt = new Date(Date.now() - 61_000).toISOString();
    db!.run("UPDATE multiremi_runtime_local_skill_list_requests SET run_started_at = ?, updated_at = ? WHERE id = ?", [
      oldLocalSkillRunningAt,
      oldLocalSkillRunningAt,
      staleListRunning.id,
    ]);
    const staleListRunningPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/${staleListRunning.id}`);
    const staleListRunningBody = await staleListRunningPoll.json();
    expect(staleListRunningBody.status).toBe("timeout");
    expect(staleListRunningBody.error).toBe("daemon did not finish within 60 seconds");

    const lateListReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/${staleListRunning.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", skills: [] }),
    });
    expect(lateListReport.status).toBe(200);
    expect(store.getRuntimeLocalSkillListRequest(runtime.id, staleListRunning.id)?.status).toBe("timeout");

    const staleImportPending = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "stale-pending" });
    db!.run("UPDATE multiremi_runtime_local_skill_import_requests SET created_at = ?, updated_at = ? WHERE id = ?", [
      oldLocalSkillPendingAt,
      oldLocalSkillPendingAt,
      staleImportPending.id,
    ]);
    const staleImportPendingPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/import/${staleImportPending.id}`);
    const staleImportPendingBody = await staleImportPendingPoll.json();
    expect(staleImportPendingBody.status).toBe("timeout");
    expect(staleImportPendingBody.error).toBe("daemon did not respond within 3 minutes");
    expect(staleImportPendingBody.skill_key).toBe("stale-pending");
    expect(staleImportPendingBody.skillKey).toBeUndefined();
    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/claim?limit=5`, { method: "POST" })).json()).requests).toEqual([]);

    const staleImportRunning = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "stale-running", name: "Late Import" });
    await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/claim?limit=5`, { method: "POST" });
    db!.run("UPDATE multiremi_runtime_local_skill_import_requests SET run_started_at = ?, updated_at = ? WHERE id = ?", [
      oldLocalSkillRunningAt,
      oldLocalSkillRunningAt,
      staleImportRunning.id,
    ]);
    const staleImportRunningPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/import/${staleImportRunning.id}`);
    const staleImportRunningBody = await staleImportRunningPoll.json();
    expect(staleImportRunningBody.status).toBe("timeout");
    expect(staleImportRunningBody.error).toBe("daemon did not finish within 60 seconds");

    const lateImportReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${staleImportRunning.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skill: {
          name: "Late Import",
          description: "Should not be created",
          content: "# Late",
          provider: "claude",
          source_path: "/tmp/late",
        },
      }),
    });
    expect(lateImportReport.status).toBe(200);
    expect(store.getRuntimeLocalSkillImportRequest(runtime.id, staleImportRunning.id)?.status).toBe("timeout");
    expect(store.listSkills("local").some((skill) => skill.name === "Late Import")).toBe(false);
  });

  it("serves original daemon heartbeat pending request protocol", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_heartbeat_flow", name: "Heartbeat runtime", provider: "codex" });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const issue = store.createIssue({ title: "Do not steal heartbeat requests" });
    store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Claim task" });
    const app = createMultiremiApp({ store });

    const modelRequest = store.createRuntimeModelListRequest(runtime.id);
    const updateRequest = store.createRuntimeUpdateRequest(runtime.id, { target_version: "v9.9.9" });
    const localSkillRequest = store.createRuntimeLocalSkillListRequest(runtime.id);
    const importOne = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "review-helper" });
    const importTwo = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "test-helper" });

    const invalidHeartbeatJson = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidHeartbeatJson.status).toBe(400);
    expect(await invalidHeartbeatJson.json()).toEqual({ error: "invalid request body" });

    const camelRuntimeHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: runtime.id }),
    });
    expect(camelRuntimeHeartbeat.status).toBe(400);
    expect(await camelRuntimeHeartbeat.json()).toEqual({ error: "runtime_id is required" });

    const camelBatchRuntime = store.registerRuntime({ id: "rt_heartbeat_camel_batch", name: "Camel batch heartbeat", provider: "codex" });
    const camelBatchImportOne = store.createRuntimeLocalSkillImportRequest(camelBatchRuntime.id, { skill_key: "camel-one" });
    const camelBatchImportTwo = store.createRuntimeLocalSkillImportRequest(camelBatchRuntime.id, { skill_key: "camel-two" });
    const camelBatchHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: camelBatchRuntime.id, supportsBatchImport: true }),
    });
    const camelBatchBody = await camelBatchHeartbeat.json();
    expect(camelBatchHeartbeat.status).toBe(200);
    expect(camelBatchBody.pending_local_skill_import).toMatchObject({ id: camelBatchImportOne.id, skill_key: "camel-one" });
    expect(camelBatchBody.pending_local_skill_imports).toBeUndefined();
    expect(store.getRuntimeLocalSkillImportRequest(camelBatchRuntime.id, camelBatchImportOne.id)?.status).toBe("running");
    expect(store.getRuntimeLocalSkillImportRequest(camelBatchRuntime.id, camelBatchImportTwo.id)?.status).toBe("pending");

    const taskClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(taskClaim.status).toBe(200);
    expect(store.getRuntimeModelListRequest(runtime.id, modelRequest.id)?.status).toBe("pending");
    expect(store.getRuntimeUpdateRequest(runtime.id, updateRequest.id)?.status).toBe("pending");

    const heartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: runtime.id, supports_batch_import: true }),
    });
    const heartbeatBody = await heartbeat.json();

    expect(heartbeat.status).toBe(200);
    expect(heartbeatBody).toMatchObject({
      status: "ok",
      pending_update: { id: updateRequest.id, target_version: "v9.9.9" },
      pending_model_list: { id: modelRequest.id },
      pending_local_skills: { id: localSkillRequest.id },
      pending_local_skill_import: { id: importOne.id, skill_key: "review-helper" },
    });
    expect(heartbeatBody.runtime_id).toBeUndefined();
    expect(heartbeatBody.pending_local_skill_imports.map((item: any) => item.id)).toEqual([importOne.id, importTwo.id]);
    expect(store.getRuntimeModelListRequest(runtime.id, modelRequest.id)?.status).toBe("running");
    expect(store.getRuntimeUpdateRequest(runtime.id, updateRequest.id)?.status).toBe("running");
    expect(store.getRuntimeLocalSkillListRequest(runtime.id, localSkillRequest.id)?.status).toBe("running");
    expect(store.getRuntimeLocalSkillImportRequest(runtime.id, importOne.id)?.status).toBe("running");

    const legacyRuntime = store.registerRuntime({ id: "rt_heartbeat_legacy", name: "Legacy heartbeat", provider: "codex" });
    const legacyImportOne = store.createRuntimeLocalSkillImportRequest(legacyRuntime.id, { skill_key: "legacy-one" });
    const legacyImportTwo = store.createRuntimeLocalSkillImportRequest(legacyRuntime.id, { skill_key: "legacy-two" });
    const legacyHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: legacyRuntime.id }),
    });
    const legacyHeartbeatBody = await legacyHeartbeat.json();
    expect(legacyHeartbeat.status).toBe(200);
    expect(legacyHeartbeatBody).toMatchObject({
      status: "ok",
      pending_local_skill_import: { id: legacyImportOne.id, skill_key: "legacy-one" },
    });
    expect(legacyHeartbeatBody.pending_local_skill_imports).toBeUndefined();
    expect(store.getRuntimeLocalSkillImportRequest(legacyRuntime.id, legacyImportOne.id)?.status).toBe("running");
    expect(store.getRuntimeLocalSkillImportRequest(legacyRuntime.id, legacyImportTwo.id)?.status).toBe("pending");

    const emptyHeartbeat = await app.request(`/api/multiremi/runtimes/${runtime.id}/heartbeat`, { method: "POST" });
    const emptyHeartbeatBody = await emptyHeartbeat.json();
    expect(emptyHeartbeat.status).toBe(200);
    expect(emptyHeartbeatBody.pending_update).toBeUndefined();
  });

  it("records Go-style runtime_failed telemetry when daemon register persistence fails", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store });
    store.registerRuntime = (() => {
      throw new Error("database is locked");
    }) as typeof store.registerRuntime;

    const failed = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-failed-register",
        runtimes: [{ type: "codex", version: "1.2.3" }],
      }),
    });

    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "failed to register runtime: database is locked" });
    const event = store.listAnalyticsEvents({ name: "runtime_failed" })[0]!;
    expect(event.metricsOnly).toBe(true);
    expect(event.distinctId).toBe("workspace:local");
    expect(event.workspaceId).toBe("local");
    expect(event.properties).toMatchObject({
      daemon_id: "daemon-failed-register",
      provider: "codex",
      runtime_mode: "local",
      failure_reason: "registration_failed",
      error_type: "db_error",
      recoverable: true,
      source: "manual",
      is_demo: false,
    });
    expect(event.properties).not.toHaveProperty("user_id");
    expect(metricValue(store, "multiremi_runtime_failed_total", {
      runtime_mode: "local",
      provider: "codex",
      failure_reason: "registration_failed",
      recoverable: "true",
    })).toBe(1);
    expect(store.listAnalyticsEvents({ includeMetricsOnly: false }).some((analyticsEvent) => analyticsEvent.name === "runtime_failed")).toBe(false);
  });

  it("serves original daemon register and deregister endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const invalidRegisterJson = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidRegisterJson.status).toBe(400);
    expect(await invalidRegisterJson.json()).toEqual({ error: "invalid request body" });

    const missing = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: "daemon-missing", runtimes: [{ type: "codex" }] }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "workspace_id is required" });

    const camelRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "local", daemonId: "daemon-camel", runtimes: [{ type: "codex" }] }),
    });
    expect(camelRegister.status).toBe(400);
    expect(await camelRegister.json()).toEqual({ error: "daemon_id is required" });

    const invalidDeregister = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_ids: "rt_not_array" }),
    });
    expect(invalidDeregister.status).toBe(400);

    const invalidDeregisterJson = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidDeregisterJson.status).toBe(400);
    expect(await invalidDeregisterJson.json()).toEqual({ error: "invalid request body" });

    const camelDeregister = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeIds: ["rt_camel_alias"] }),
    });
    expect(camelDeregister.status).toBe(400);
    expect(await camelDeregister.json()).toEqual({ error: "runtime_ids is required" });

    const missingWorkspaceRepos = await app.request("/api/daemon/workspaces/missing/repos");
    expect(missingWorkspaceRepos.status).toBe(404);

    const missingWorkspaceRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "missing",
        daemon_id: "daemon-missing-workspace",
        runtimes: [{ type: "codex" }],
      }),
    });
    expect(missingWorkspaceRegister.status).toBe(404);

    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      settings: { coauthor_enabled: true },
      repos: [
        { url: "git@example.com:team/api.git", description: "API" },
        { url: "  git@example.com:team/web.git  ", description: " Web " },
        { url: "git@example.com:team/api.git", description: "duplicate ignored" },
        { url: " " },
        "not-a-repo",
      ],
    });
    const expectedRepos = [
      { url: "git@example.com:team/api.git", description: "API" },
      { url: "git@example.com:team/web.git", description: " Web " },
    ];
    const expectedReposVersion = workspaceRepoVersion(expectedRepos.map((repo) => repo.url));

    const unsupportedProvider = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-provider", runtimes: [{ type: "gemini" }] }),
    });
    expect(unsupportedProvider.status).toBe(400);
    expect(await unsupportedProvider.json()).toEqual({ error: "Unsupported Multiremi runtime provider: gemini" });
    expect(store.listRuntimes().some((runtime) => runtime.provider === "gemini")).toBe(false);

    const camelProviderAlias = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-provider-alias", runtimes: [{ provider: "codex" }] }),
    });
    expect(camelProviderAlias.status).toBe(400);
    expect(await camelProviderAlias.json()).toEqual({ error: "Unsupported Multiremi runtime provider: unknown" });
    expect(store.listRuntimes().some((runtime) => runtime.daemonId === "daemon-provider-alias")).toBe(false);

    const camelMetadataRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-camel-metadata",
        deviceName: "Ignored Laptop",
        cliVersion: "ignored-cli",
        launchedBy: "ignored-launcher",
        runtimes: [{ type: "codex", version: "0.1.0" }],
      }),
    });
    expect(camelMetadataRegister.status).toBe(200);
    const camelMetadataRuntime = (await camelMetadataRegister.json()).runtimes[0];
    expect(camelMetadataRuntime.device_info).toBe("0.1.0");
    expect(camelMetadataRuntime.metadata).toMatchObject({
      version: "0.1.0",
      cli_version: "",
      launched_by: "",
    });

    const registered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-1",
        device_name: "Laptop",
        cli_version: "0.2.0",
        launched_by: "desktop",
        runtimes: [
          { name: "Codex local", type: "codex", version: "1.0.0", status: "online" },
          { type: "claude", version: "2.0.0", status: "offline" },
        ],
      }),
    });
    const registeredBody = await registered.json();

    expect(registered.status).toBe(200);
    expect(registeredBody.repos).toEqual(expectedRepos);
    expect(registeredBody.repos_version).toBe(expectedReposVersion);
    expect(registeredBody.settings).toEqual({ coauthor_enabled: true });
    expect(registeredBody.runtimes).toHaveLength(2);
    expect(registeredBody.runtimes[0]).toMatchObject({
      workspace_id: "local",
      daemon_id: "daemon-1",
      runtime_mode: "local",
      provider: "codex",
      launch_header: "Codex",
      device_info: "Laptop · 1.0.0",
      metadata: {
        version: "1.0.0",
        cli_version: "0.2.0",
        launched_by: "desktop",
      },
      visibility: "private",
    });
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.status).toBe("online");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.daemonId).toBe("daemon-1");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.runtimeMode).toBe("local");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.deviceInfo).toBe("Laptop · 1.0.0");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.metadata).toMatchObject({
      version: "1.0.0",
      cli_version: "0.2.0",
      launched_by: "desktop",
    });
    expect(store.getRuntime(registeredBody.runtimes[1].id)?.status).toBe("offline");
    expect(store.getRuntime(registeredBody.runtimes[1].id)?.daemonId).toBe("daemon-1");

    const camelDeregisterRegistered = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeIds: [registeredBody.runtimes[0].id] }),
    });
    expect(camelDeregisterRegistered.status).toBe(400);
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.status).toBe("online");

    const reconnected = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-1",
        runtimes: [{ type: "codex", version: "1.0.1" }],
      }),
    });
    const reconnectedBody = await reconnected.json();
    expect(reconnectedBody.runtimes[0].id).toBe(registeredBody.runtimes[0].id);
    expect(reconnectedBody.runtimes[0].metadata.version).toBe("1.0.1");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.deviceInfo).toBe("1.0.1");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.metadata).toMatchObject({
      version: "1.0.1",
      cli_version: "",
      launched_by: "",
    });

    const legacyRegistered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "LegacyHost.local",
        runtimes: [{ type: "codex", version: "0.9.0" }],
      }),
    });
    expect(legacyRegistered.status).toBe(200);
    const legacyRegisteredBody = await legacyRegistered.json();
    const legacyRuntimeId = legacyRegisteredBody.runtimes[0].id;
    const legacyAgent = store.createAgent({ name: "Legacy Codex", provider: "codex", runtimeId: legacyRuntimeId });
    const legacyTask = store.createTask({ agentId: legacyAgent.id, prompt: "legacy runtime task" });
    const legacyClaim = await app.request(`/api/daemon/runtimes/${legacyRuntimeId}/tasks/claim`, { method: "POST" });
    expect(legacyClaim.status).toBe(200);
    expect((await legacyClaim.json()).task.id).toBe(legacyTask.id);
    expect(store.getTask(legacyTask.id)?.runtimeId).toBe(legacyRuntimeId);
    expect(store.getAgent(legacyAgent.id)?.runtimeId).toBe(legacyRuntimeId);

    const duplicateLegacyRuntime = store.registerRuntime({
      id: "rt_legacy_case_duplicate",
      name: "Legacy duplicate",
      provider: "codex",
      workspaceId: "local",
      daemonId: "legacyhost.local",
    });
    const duplicateLegacyAgent = store.createAgent({
      name: "Legacy Duplicate Codex",
      provider: "codex",
      runtimeId: duplicateLegacyRuntime.id,
    });
    const duplicateLegacyTask = store.createTask({ agentId: duplicateLegacyAgent.id, prompt: "duplicate legacy runtime task" });
    expect(duplicateLegacyTask.runtimeId).toBe(duplicateLegacyRuntime.id);

    const camelLegacyIgnored = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "stable-camel-legacy",
        legacyDaemonIds: ["LegacyHost.local", "legacyhost.local"],
        runtimes: [{ type: "codex", version: "1.0.5" }],
      }),
    });
    expect(camelLegacyIgnored.status).toBe(200);
    const camelLegacyRuntimeId = (await camelLegacyIgnored.json()).runtimes[0].id;
    expect(store.getRuntime(camelLegacyRuntimeId)?.legacyDaemonId).toBeNull();
    expect(store.getRuntime(camelLegacyRuntimeId)?.metadata.legacy_runtime_merges).toBeUndefined();
    expect(store.getTask(legacyTask.id)?.runtimeId).toBe(legacyRuntimeId);
    expect(store.getAgent(legacyAgent.id)?.runtimeId).toBe(legacyRuntimeId);
    expect(store.getTask(duplicateLegacyTask.id)?.runtimeId).toBe(duplicateLegacyRuntime.id);
    expect(store.getAgent(duplicateLegacyAgent.id)?.runtimeId).toBe(duplicateLegacyRuntime.id);

    const migrated = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "stable-daemon",
        legacy_daemon_ids: ["LegacyHost.local", "legacyhost.local", " "],
        runtimes: [{ type: "codex", version: "1.1.0" }],
      }),
    });
    expect(migrated.status).toBe(200);
    const migratedBody = await migrated.json();
    const migratedRuntimeId = migratedBody.runtimes[0].id;
    expect(migratedRuntimeId).not.toBe(legacyRuntimeId);
    expect(store.getTask(legacyTask.id)?.runtimeId).toBe(migratedRuntimeId);
    expect(store.getAgent(legacyAgent.id)?.runtimeId).toBe(migratedRuntimeId);
    expect(store.getTask(duplicateLegacyTask.id)?.runtimeId).toBe(migratedRuntimeId);
    expect(store.getAgent(duplicateLegacyAgent.id)?.runtimeId).toBe(migratedRuntimeId);
    expect(store.getRuntime(migratedRuntimeId)?.daemonId).toBe("stable-daemon");
    expect(store.getRuntime(migratedRuntimeId)?.legacyDaemonId).toBe("LegacyHost.local");
    expect(store.getRuntime(legacyRuntimeId)).toBeNull();
    expect(store.getRuntime(duplicateLegacyRuntime.id)).toBeNull();
    const mergeAudit = store.getRuntime(migratedRuntimeId)?.metadata.legacy_runtime_merges as Array<Record<string, unknown>>;
    expect(mergeAudit).toHaveLength(2);
    expect(mergeAudit.map((entry) => entry.old_runtime_id).sort()).toEqual([duplicateLegacyRuntime.id, legacyRuntimeId].sort());
    expect(mergeAudit.every((entry) => entry.agents_reassigned === 1 && entry.tasks_reassigned === 1)).toBe(true);

    const migratedReconnect = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "stable-daemon",
        runtimes: [{ type: "codex", version: "1.1.1" }],
      }),
    });
    expect(migratedReconnect.status).toBe(200);
    expect((store.getRuntime(migratedRuntimeId)?.metadata.legacy_runtime_merges as Array<unknown>)).toHaveLength(2);

    const deregistered = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_ids: [registeredBody.runtimes[0].id] }),
    });
    expect(deregistered.status).toBe(200);
    expect((await deregistered.json()).status).toBe("ok");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.status).toBe("offline");

    const repos = await app.request("/api/daemon/workspaces/local/repos");
    const reposBody = await repos.json();
    expect(repos.status).toBe(200);
    expect(reposBody).toEqual({
      workspace_id: "local",
      repos: expectedRepos,
      repos_version: expectedReposVersion,
      settings: { coauthor_enabled: true },
    });

    store.updateWorkspace("local", {
      repos: [
        { url: "git@example.com:team/web.git", description: "frontend" },
        { url: "git@example.com:team/api.git", description: "backend" },
      ],
    });
    const reorderedRepos = await app.request("/api/daemon/workspaces/local/repos");
    const reorderedReposBody = await reorderedRepos.json();
    expect(reorderedRepos.status).toBe(200);
    expect(reorderedReposBody.repos_version).toBe(expectedReposVersion);

    store.updateWorkspace("local", {
      repos: [
        { url: "git@example.com:team/api.git", description: "backend" },
        { url: "git@example.com:team/mobile.git", description: "mobile" },
      ],
    });
    const changedRepos = await app.request("/api/daemon/workspaces/local/repos");
    const changedReposBody = await changedRepos.json();
    expect(changedRepos.status).toBe(200);
    expect(changedReposBody.repos_version).toBe(workspaceRepoVersion([
      "git@example.com:team/api.git",
      "git@example.com:team/mobile.git",
    ]));
    expect(changedReposBody.repos_version).not.toBe(expectedReposVersion);
  });

  it("serves local user and workspace compatibility endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const me = await app.request("/api/me");
    const meBody = await me.json();
    expect(me.status).toBe(200);
    expect(meBody).toMatchObject({
      id: "local",
      email: "local@multiremi.local",
      onboarding_questionnaire: {},
      profile_description: "",
    });

    const invalidLanguage = await app.request("/api/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "<script>" }),
    });
    expect(invalidLanguage.status).toBe(400);

    const updated = await app.request("/api/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Local Operator",
        language: "zh-Hans",
        timezone: "Asia/Shanghai",
        profile_description: "Works locally",
      }),
    });
    const updatedBody = await updated.json();
    expect(updated.status).toBe(200);
    expect(updatedBody.name).toBe("Local Operator");
    expect(updatedBody.language).toBe("zh-Hans");
    expect(updatedBody.timezone).toBe("Asia/Shanghai");
    expect(updatedBody.profile_description).toBe("Works locally");

    const onboarding = await app.request("/api/me/onboarding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionnaire: { source: "codex", role: "builder" } }),
    });
    expect((await onboarding.json()).onboarding_questionnaire).toEqual({ source: "codex", role: "builder" });

    const completed = await app.request("/api/me/onboarding/complete", { method: "POST" });
    expect((await completed.json()).onboarded_at).toBeString();

    const initialWorkspaces = await app.request("/api/workspaces");
    const initialWorkspacesBody = await initialWorkspaces.json();
    expect(initialWorkspaces.status).toBe(200);
    expect(initialWorkspacesBody[0]).toMatchObject({
      id: "local",
      slug: "local",
      issue_prefix: "MUL",
    });

    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Product Team", slug: "product-team", description: "Builds product" }),
    });
    const createdBody = await created.json();
    expect(created.status).toBe(201);
    expect(createdBody.slug).toBe("product-team");
    expect(createdBody.issue_prefix).toBe("PRO");

    const duplicate = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Product Team", slug: "product-team" }),
    });
    expect(duplicate.status).toBe(409);

    const detail = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}`);
    expect((await detail.json()).name).toBe("Product Team");

    const members = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members`);
    const membersBody = await members.json();
    expect(membersBody[0]).toMatchObject({
      workspace_id: createdBody.id,
      user_id: "local",
      role: "owner",
      created_at: expect.any(String),
    });
    expect(membersBody[0].workspaceId).toBeUndefined();
    expect(membersBody[0].createdAt).toBeUndefined();
    expect(membersBody[0].email).toBeUndefined();

    const lastOwnerDemote = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(lastOwnerDemote.status).toBe(400);
    expect(await lastOwnerDemote.json()).toEqual({ error: "workspace must have at least one owner" });

    const backupOwner = store.createWorkspaceMember({
      workspaceId: createdBody.id,
      name: "Product Owner Backup",
      email: "backup-owner@example.com",
      role: "owner",
    });
    const missingRoleUpdate = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ignored by Go role contract" }),
    });
    expect(missingRoleUpdate.status).toBe(400);
    expect(await missingRoleUpdate.json()).toEqual({ error: "role is required" });

    const invalidRoleUpdate = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect(invalidRoleUpdate.status).toBe(400);
    expect(await invalidRoleUpdate.json()).toEqual({ error: "invalid member role" });

    const updatedMember = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(updatedMember.status).toBe(200);
    const updatedMemberBody = await updatedMember.json();
    expect(updatedMemberBody).toMatchObject({
      id: membersBody[0].id,
      workspace_id: createdBody.id,
      user_id: "local",
      role: "admin",
      name: expect.any(String),
      email: "local@multiremi.local",
      avatar_url: null,
    });
    expect(updatedMemberBody.workspaceId).toBeUndefined();
    expect(updatedMemberBody.createdAt).toBeUndefined();

    const deleteOnlyOwner = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(backupOwner.id)}`, {
      method: "DELETE",
    });
    expect(deleteOnlyOwner.status).toBe(403);
    expect(await deleteOnlyOwner.json()).toEqual({ error: "insufficient permissions" });

    const githubConnect = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/github/connect`);
    expect(await githubConnect.json()).toEqual({ configured: false });
    const githubInstallations = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/github/installations`);
    expect(await githubInstallations.json()).toEqual({
      installations: [],
      configured: false,
      can_manage: true,
    });

    const deletedMember = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "DELETE",
    });
    expect(deletedMember.status).toBe(204);

    const invitations = await app.request("/api/invitations");
    expect(await invitations.json()).toEqual([]);
  });

  it("serves workspace, runtime, auth, webhook, and setup compatibility fallbacks", async () => {
    process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN = "1";
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Fallback Team", slug: "fallback-team" });
    const runtime = store.registerRuntime({ name: "Fallback Runtime", provider: "codex", workspaceId: workspace.id });
    const app = createMultiremiApp({ store });

    const updated = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fallback Renamed", issue_prefix: "FB" }),
    });
    expect((await updated.json()).issue_prefix).toBe("FB");

    const leave = await app.request(`/api/workspaces/${workspace.id}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: `mem_${workspace.id}_local` }),
    });
    expect(leave.status).toBe(400);
    expect(await leave.json()).toEqual({ error: "workspace must have at least one owner" });
    store.createWorkspaceMember({ workspaceId: workspace.id, name: "Leave Backup Owner", email: "leave-owner@example.com", role: "owner" });
    const leaveWithBackup = await app.request(`/api/workspaces/${workspace.id}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: `mem_${workspace.id}_local` }),
    });
    expect(leaveWithBackup.status).toBe(204);

    const sentCode = await app.request("/auth/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Compat@Example.com", name: "Compat User" }),
    });
    const sentCodeBody = await sentCode.json();
    expect(sentCode.status).toBe(200);
    expect(sentCodeBody.email).toBe("compat@example.com");
    expect(sentCodeBody.code).toMatch(/^\d{6}$/);
    const verifiedCode = await app.request("/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "compat@example.com", code: sentCodeBody.code }),
    });
    const verifiedCodeBody = await verifiedCode.json();
    expect(verifiedCode.status).toBe(200);
    expect(verifiedCodeBody.access_token).toStartWith("mul_");
    expect(verifiedCodeBody.user.email).toBe("compat@example.com");
    const googleLogin = await app.request("/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "google@example.com", name: "Google User" }),
    });
    const googleLoginBody = await googleLogin.json();
    expect(googleLogin.status).toBe(200);
    expect(googleLoginBody.user.name).toBe("Google User");
    const realtimeHealth = await app.request("/health/realtime");
    expect(await realtimeHealth.json()).toMatchObject({ enabled: true, connections: 0, transport: "websocket" });
    expect((await (await app.request("/api/github/setup")).json()).configured).toBe(false);
    expect((await app.request("/api/webhooks/github", { method: "POST" })).status).toBe(202);
    expect((await app.request("/api/webhooks/autopilots/missing", { method: "POST" })).status).toBe(404);
    const wsFallback = await app.request("/api/daemon/ws");
    expect(wsFallback.status).toBe(426);
    expect((await wsFallback.json()).upgrade_required).toBe(true);

    expect((await app.request(`/api/runtimes/${runtime.id}/activity`)).status).toBe(200);
    const deletedRuntime = await app.request(`/api/runtimes/${runtime.id}`, { method: "DELETE" });
    expect(deletedRuntime.status).toBe(200);
    expect(await deletedRuntime.json()).toEqual({ status: "ok" });

    const removable = store.createWorkspace({ name: "Removable Team", slug: "removable-team" });
    expect((await app.request(`/api/workspaces/${removable.id}`, { method: "DELETE" })).status).toBe(204);
    delete process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN;
  });

  it("serves local workspace invitation compatibility endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const workspace = store.createWorkspace({ name: "Invite Team", slug: "invite-team" });

    const invalid = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    });
    expect(invalid.status).toBe(400);

    const created = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "teammate@example.com", role: "admin" }),
    });
    const createdBody = await created.json();
    expect(created.status).toBe(201);
    expect(createdBody).toMatchObject({
      workspace_id: workspace.id,
      inviter_id: "local",
      invitee_email: "teammate@example.com",
      role: "admin",
      status: "pending",
      workspace_name: "Invite Team",
      inviter_email: "local@multiremi.local",
    });

    const duplicate = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "teammate@example.com", role: "member" }),
    });
    expect(duplicate.status).toBe(409);

    const workspaceInvitations = await app.request(`/api/workspaces/${workspace.id}/invitations`);
    const workspaceInvitationsBody = await workspaceInvitations.json();
    expect(workspaceInvitationsBody[0].id).toBe(createdBody.id);

    const fetched = await app.request(`/api/invitations/${createdBody.id}`);
    expect((await fetched.json()).invitee_email).toBe("teammate@example.com");

    const revoked = await app.request(`/api/workspaces/${workspace.id}/invitations/${createdBody.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(204);

    db!.run(
      `INSERT INTO multiremi_workspace_invitations (
        id, workspace_id, inviter_id, invitee_email, invitee_user_id, role, status, expires_at, created_at, updated_at
      ) VALUES (?, ?, 'local', 'expired@example.com', NULL, 'member', 'pending', ?, ?, ?)`,
      ["inv_stale_pending", workspace.id, "2026-06-04T00:00:00.000Z", "2026-05-28T00:00:00.000Z", "2026-05-28T00:00:00.000Z"],
    );
    const pendingWithoutExpired = await app.request(`/api/workspaces/${workspace.id}/invitations`);
    expect((await pendingWithoutExpired.json()).map((invitation: any) => invitation.id)).not.toContain("inv_stale_pending");
    const reinvitedAfterExpiry = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "expired@example.com", role: "member" }),
    });
    expect(reinvitedAfterExpiry.status).toBe(201);
    expect(store.getInvitation("inv_stale_pending")?.status).toBe("expired");
    expect((await reinvitedAfterExpiry.json()).status).toBe("pending");

    db!.run(
      `INSERT INTO multiremi_workspaces (
        id, name, slug, settings, repos, issue_prefix, created_at, updated_at
      ) VALUES ('ws_external_invite', 'External Invite', 'external-invite', '{}', '[]', 'EXT', '2026-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z')`,
    );
    store.createWorkspaceMember({
      id: "external-admin",
      workspaceId: "ws_external_invite",
      name: "External Admin",
      email: "external-admin@example.com",
      role: "admin",
    });
    const externalAdminToken = await store.createAccessToken({
      name: "External Admin",
      type: "pat",
      workspaceId: "ws_external_invite",
      userId: "external-admin",
    });
    const localInviteeToken = await store.createAccessToken({
      name: "Local Invitee",
      type: "pat",
      workspaceId: "ws_external_invite",
      userId: "local",
    });
    const authedApp = createMultiremiApp({ store, authToken: "root-secret" });
    const authedJsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const authedHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

    db!.run(
      `INSERT INTO multiremi_workspace_invitations (
        id, workspace_id, inviter_id, invitee_email, invitee_user_id, role, status, expires_at, created_at, updated_at
      ) VALUES ('inv_expired_accept', 'ws_external_invite', 'local', 'local@multiremi.local', 'local', 'member', 'pending', '2026-06-04T00:00:00.000Z', '2026-05-28T00:00:00.000Z', '2026-05-28T00:00:00.000Z')`,
    );
    const expiredAccept = await app.request("/api/invitations/inv_expired_accept/accept", { method: "POST" });
    expect(expiredAccept.status).toBe(410);
    expect(await expiredAccept.json()).toEqual({ error: "invitation has expired" });

    const acceptInvite = await authedApp.request("/api/workspaces/ws_external_invite/members", {
      method: "POST",
      headers: authedJsonHeaders(externalAdminToken.token),
      body: JSON.stringify({ email: "local@multiremi.local", role: "member" }),
    });
    const acceptInviteBody = await acceptInvite.json();
    const myInvites = await authedApp.request("/api/invitations", { headers: authedHeaders(localInviteeToken.token) });
    expect((await myInvites.json())[0].id).toBe(acceptInviteBody.id);

    const accepted = await authedApp.request(`/api/invitations/${acceptInviteBody.id}/accept`, {
      method: "POST",
      headers: authedHeaders(localInviteeToken.token),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    expect(acceptedBody).toMatchObject({
      workspace_id: "ws_external_invite",
      user_id: "local",
      role: "member",
      name: "Local User",
      email: "local@multiremi.local",
      avatar_url: null,
    });
    expect(typeof acceptedBody.created_at).toBe("string");
    expect(acceptedBody.status).toBeUndefined();
    expect(acceptedBody.workspaceId).toBeUndefined();
    expect(store.listWorkspaceMembers("ws_external_invite").some((member) => member.email === "local@multiremi.local")).toBe(true);

    db!.run(
      `INSERT INTO multiremi_workspace_invitations (
        id, workspace_id, inviter_id, invitee_email, invitee_user_id, role, status, expires_at, created_at, updated_at
      ) VALUES ('inv_already_member_accept', 'ws_external_invite', 'local', 'local@multiremi.local', 'local', 'member', 'pending', '2030-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z')`,
    );
    const alreadyMemberAccept = await app.request("/api/invitations/inv_already_member_accept/accept", { method: "POST" });
    expect(alreadyMemberAccept.status).toBe(409);
    expect(await alreadyMemberAccept.json()).toEqual({ error: "you are already a member of this workspace" });
    expect(store.getInvitation("inv_already_member_accept")?.status).toBe("pending");

    const existingMemberInvite = await authedApp.request("/api/workspaces/ws_external_invite/members", {
      method: "POST",
      headers: authedJsonHeaders(externalAdminToken.token),
      body: JSON.stringify({ email: "local@multiremi.local", role: "admin" }),
    });
    expect(existingMemberInvite.status).toBe(409);
  });

  it("gates Go-compatible workspace member and invitation mutations by actor role", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Guard Team", slug: "guard-team" });
    const owner = store.getWorkspaceMember(`mem_${workspace.id}_local`)!;
    store.createWorkspaceMember({
      id: "guard-admin",
      workspaceId: workspace.id,
      name: "Guard Admin",
      email: "guard-admin@example.com",
      role: "admin",
    });
    const plain = store.createWorkspaceMember({
      id: "guard-member",
      workspaceId: workspace.id,
      name: "Guard Member",
      email: "guard-member@example.com",
      role: "member",
    });
    const target = store.createWorkspaceMember({
      id: "guard-target",
      workspaceId: workspace.id,
      name: "Guard Target",
      email: "guard-target@example.com",
      role: "member",
    });
    const ownerToken = await store.createAccessToken({ name: "Guard Owner", type: "pat", workspaceId: workspace.id, userId: "local" });
    const adminToken = await store.createAccessToken({ name: "Guard Admin", type: "pat", workspaceId: workspace.id, userId: "guard-admin" });
    const memberToken = await store.createAccessToken({ name: "Guard Member", type: "pat", workspaceId: workspace.id, userId: plain.id });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

    const memberList = await app.request(`/api/workspaces/${workspace.id}/members`, { headers: authHeaders(memberToken.token) });
    expect(memberList.status).toBe(200);

    const memberInvite = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ email: "member-invite@example.com", role: "member" }),
    });
    expect(memberInvite.status).toBe(403);
    expect(await memberInvite.json()).toEqual({ error: "insufficient permissions" });

    const adminInvite = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ email: "admin-invite@example.com", role: "member" }),
    });
    expect(adminInvite.status).toBe(201);
    const adminInviteBody = await adminInvite.json();

    const memberRevoke = await app.request(`/api/workspaces/${workspace.id}/invitations/${adminInviteBody.id}`, {
      method: "DELETE",
      headers: authHeaders(memberToken.token),
    });
    expect(memberRevoke.status).toBe(403);
    expect(await memberRevoke.json()).toEqual({ error: "insufficient permissions" });

    const memberUpdate = await app.request(`/api/workspaces/${workspace.id}/members/${target.id}`, {
      method: "PATCH",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ role: "admin" }),
    });
    expect(memberUpdate.status).toBe(403);

    const adminPromoteOwner = await app.request(`/api/workspaces/${workspace.id}/members/${target.id}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ role: "owner" }),
    });
    expect(adminPromoteOwner.status).toBe(403);
    expect(await adminPromoteOwner.json()).toEqual({ error: "insufficient permissions" });

    const ownerDeleteOnlyOwner = await app.request(`/api/workspaces/${workspace.id}/members/${owner.id}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken.token),
    });
    expect(ownerDeleteOnlyOwner.status).toBe(400);
    expect(await ownerDeleteOnlyOwner.json()).toEqual({ error: "workspace must have at least one owner" });

    const adminDeleteOwner = await app.request(`/api/workspaces/${workspace.id}/members/${owner.id}`, {
      method: "DELETE",
      headers: authHeaders(adminToken.token),
    });
    expect(adminDeleteOwner.status).toBe(403);
    expect(await adminDeleteOwner.json()).toEqual({ error: "insufficient permissions" });

    const adminUpdateMember = await app.request(`/api/workspaces/${workspace.id}/members/${target.id}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ role: "admin" }),
    });
    expect(adminUpdateMember.status).toBe(200);

    const ownerRevoke = await app.request(`/api/workspaces/${workspace.id}/invitations/${adminInviteBody.id}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken.token),
    });
    expect(ownerRevoke.status).toBe(204);

    const forgedLeave = await app.request(`/api/workspaces/${workspace.id}/leave`, {
      method: "POST",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ member_id: owner.id }),
    });
    expect(forgedLeave.status).toBe(204);
    expect(store.getWorkspaceMember(owner.id)?.archivedAt).toBeNull();
    expect(store.getWorkspaceMember(plain.id)?.archivedAt).toBeString();
  });

  it("serves config, cli token, logout, and onboarding bootstrap compatibility endpoints", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Onboarding Team", slug: "onboarding-team" });
    const runtime = store.registerRuntime({ name: "Codex Runtime", provider: "codex", workspaceId: workspace.id });
    const app = createMultiremiApp({ store });

    const config = await app.request("/api/config");
    const configBody = await config.json();
    expect(config.status).toBe(200);
    expect(configBody.allow_signup).toBe(true);
    expect(configBody.cdn_domain).toBe("");

    const cliToken = await app.request("/api/cli-token", { method: "POST" });
    const cliTokenBody = await cliToken.json();
    expect(cliToken.status).toBe(200);
    expect(cliTokenBody.token).toStartWith("mul_");

    const logout = await app.request("/auth/logout", { method: "POST" });
    expect(await logout.json()).toEqual({ message: "logged out" });

    const badWaitlist = await app.request("/api/me/onboarding/cloud-waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-email" }),
    });
    expect(badWaitlist.status).toBe(400);

    const waitlist = await app.request("/api/me/onboarding/cloud-waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "local@example.com", reason: "cloud please" }),
    });
    expect((await waitlist.json()).onboarding_questionnaire.cloud_waitlist_email).toBe("local@example.com");

    const runtimeBootstrap = await app.request("/api/me/onboarding/runtime-bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace.id, runtime_id: runtime.id }),
    });
    const runtimeBootstrapBody = await runtimeBootstrap.json();
    expect(runtimeBootstrap.status).toBe(200);
    expect(runtimeBootstrapBody.workspace_id).toBe(workspace.id);
    expect(runtimeBootstrapBody.agent_id).toBe(`agt_default_${workspace.id}_codex`);
    expect(store.getAgent(runtimeBootstrapBody.agent_id)).toMatchObject({
      provider: "codex",
      runtimeId: null,
      workspaceId: workspace.id,
    });
    const onboardingAgentCreated = store.listAnalyticsEvents({ name: "agent_created" })[0]!;
    expect(onboardingAgentCreated.distinctId).toBe(store.getCurrentUser().id);
    expect(onboardingAgentCreated.workspaceId).toBe(workspace.id);
    expect(onboardingAgentCreated.properties).toMatchObject({
      agent_id: runtimeBootstrapBody.agent_id,
      provider: "codex",
      runtime_mode: "local",
      template: "multiremi_helper",
      is_first_agent_in_workspace: true,
      source: "manual",
    });
    expect(metricValue(store, "multiremi_agent_created_total", { runtime_mode: "local", source: "manual" })).toBe(1);
    expect(store.getIssue(runtimeBootstrapBody.issue_id)?.title).toBe("Connect your local runtime");
    expect(store.listTasks().some((task) => task.issueId === runtimeBootstrapBody.issue_id)).toBe(true);

    const noRuntimeBootstrap = await app.request("/api/me/onboarding/no-runtime-bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace.id }),
    });
    const noRuntimeBootstrapBody = await noRuntimeBootstrap.json();
    expect(noRuntimeBootstrap.status).toBe(200);
    expect(store.getIssue(noRuntimeBootstrapBody.issue_id)?.title).toBe("Install a local runtime");
    expect(store.getCurrentUser().onboardedAt).toBeString();
  });

  it("serves original health, cloud runtime, issue task, subscription, and daemon polling compatibility endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const member = store.createWorkspaceMember({ id: "mem_compat", name: "Compat Member" });
    const issue = store.createIssue({
      title: "Compatibility task surface",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Run compatibility" });
    store.reportTaskUsage(task.id, [{
      provider: "codex",
      model: "gpt-5",
      inputTokens: 12,
      outputTokens: 8,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    }]);
    const runtime = store.registerRuntime({ name: "Codex Runtime", provider: "codex", workspaceId: "local" });
    const app = createMultiremiApp({ store });

    expect((await app.request("/readyz")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(200);
    const cloudHealth = await app.request("/api/cloud-runtime/healthz");
    expect(await cloudHealth.json()).toMatchObject({ ok: true, configured: true, mode: "local" });

    const createdCloudNode = await app.request("/api/cloud-runtime/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_type: "g5.xlarge", name: "Local GPU", tags: { env: "test" } }),
    });
    expect(createdCloudNode.status).toBe(201);
    const createdCloudNodeBody = await createdCloudNode.json();
    expect(createdCloudNodeBody.instance_type).toBe("g5.xlarge");
    expect(createdCloudNodeBody.name).toBe("Local GPU");
    expect(createdCloudNodeBody.status).toBe("launching");
    expect(createdCloudNodeBody.tags.env).toBe("test");

    const cloudRuntime = await app.request("/api/cloud-runtime/nodes?limit=10&offset=0");
    const cloudRuntimeBody = await cloudRuntime.json();
    expect(cloudRuntime.status).toBe(200);
    expect(cloudRuntimeBody[0].id).toBe(createdCloudNodeBody.id);

    const startedCloudNode = await app.request("/api/cloud-runtime/nodes/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: createdCloudNodeBody.id }),
    });
    expect((await startedCloudNode.json()).status).toBe("running");

    const execCloudNode = await app.request("/api/cloud-runtime/nodes/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: createdCloudNodeBody.id, command: "echo ok" }),
    });
    expect((await execCloudNode.json()).stdout).toContain("echo ok");

    const deletedCloudNode = await app.request("/api/cloud-runtime/nodes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: createdCloudNodeBody.id }),
    });
    expect(deletedCloudNode.status).toBe(204);

    const active = await app.request(`/api/issues/${issue.id}/active-task`);
    const activeBody = await active.json();
    expect(activeBody.tasks[0].id).toBe(task.id);
    expect(activeBody.tasks[0].issue_id).toBe(issue.id);

    const keyDetail = await app.request(`/api/issues/${issue.key.toLowerCase()}`);
    expect((await keyDetail.json()).id).toBe(issue.id);
    const keyActive = await app.request(`/api/issues/${issue.key}/active-task`);
    expect((await keyActive.json()).tasks[0].id).toBe(task.id);

    const runs = await app.request(`/api/issues/${issue.key}/task-runs`);
    const runsBody = await runs.json();
    expect(runsBody[0].agent_id).toBe(agent.id);

    const usage = await app.request(`/api/issues/${issue.key}/usage`);
    expect(await usage.json()).toMatchObject({
      total_input_tokens: 12,
      total_output_tokens: 8,
      total_cache_read_tokens: 3,
      total_cache_write_tokens: 2,
      task_count: 1,
    });

    const rerun = await app.request(`/api/issues/${issue.id}/rerun`, { method: "POST" });
    expect(rerun.status).toBe(202);
    expect((await rerun.json()).issue_id).toBe(issue.id);

    const subscribe = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: member.id }),
    });
    expect(await subscribe.json()).toEqual({ subscribed: true });
    const subscribers = await app.request(`/api/issues/${issue.id}/subscribers`);
    const subscribersBody = await subscribers.json();
    expect(subscribersBody.some((item: any) => item.user_id === member.id && item.user_type === "member")).toBe(true);
    expect(subscribersBody[0].memberId).toBeUndefined();
    const unsubscribe = await app.request(`/api/issues/${issue.id}/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: member.id }),
    });
    expect(await unsubscribe.json()).toEqual({ subscribed: false });

    const pendingBeforeClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    expect((await pendingBeforeClaim.json()).some((item: any) => item.id === task.id)).toBe(false);

    const claimed = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    const claimedBody = await claimed.json();
    expect(claimedBody.task.id).toBe(task.id);
    const pendingAfterClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    expect((await pendingAfterClaim.json()).some((item: any) =>
      item.id === task.id && item.workspace_id === "local" && item.status === "dispatched"
    )).toBe(true);
    const waiting = await app.request(`/api/daemon/tasks/${task.id}/wait-local-directory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "/tmp/compat" }),
    });
    const waitingBody = await waiting.json();
    expect(waitingBody.status).toBe("waiting_local_directory");
    expect(waitingBody.wait_reason).toBe("/tmp/compat");
    const started = await app.request(`/api/daemon/tasks/${task.id}/start`, { method: "POST" });
    const startedBody = await started.json();
    expect(startedBody.status).toBe("running");
    expect(startedBody.wait_reason ?? null).toBeNull();
    expect(startedBody.waitReason).toBeUndefined();
    await app.request(`/api/daemon/tasks/${task.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ type: "assistant", content: "compat done" }] }),
    });
    const taskPrefix = task.id.slice(0, 8);
    expect((await (await app.request(`/api/tasks/${taskPrefix}/messages`)).json())[0].content).toBe("compat done");

    const gc = await app.request(`/api/daemon/issues/${issue.key}/gc-check`);
    expect((await gc.json()).updated_at).toBeString();

    const scopedTask = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Cancel scoped" });
    const issueScopedCancel = await app.request(`/api/issues/${issue.key}/tasks/${scopedTask.id.slice(0, 8)}/cancel`, { method: "POST" });
    const issueScopedCancelBody = await issueScopedCancel.json();
    expect(issueScopedCancelBody.status).toBe("cancelled");
    expect(issueScopedCancelBody.completed_at).toBeString();
    expect(issueScopedCancelBody.result).toBeNull();

    const cancelledByTaskId = await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(cancelledByTaskId.status).toBe(200);
    const cancelledByTaskIdBody = await cancelledByTaskId.json();
    expect(cancelledByTaskIdBody.status).toBe("cancelled");
    expect(cancelledByTaskIdBody.completed_at).toBeString();
    expect(cancelledByTaskIdBody.result).toBeNull();
  });

  it("serves upstream client compatibility endpoints for env, billing, lark, chat, and batched children", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const agent = store.createAgent({
      name: "Compat Codex",
      provider: "codex",
      customEnv: { SECRET_TOKEN: "real-value", KEEP_ME: "yes" },
    });
    const skill = store.createSkill({ name: "Deploy Helper", description: "Deployment skill", content: "ship it" });
    const parent = store.createIssue({ title: "Parent issue", workspaceId: "local" });
    const child = store.createIssue({ title: "Child issue", workspaceId: "local", parentIssueId: parent.id });
    const runtime = store.registerRuntime({ name: "Compat runtime", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "wait locally" });
    const chat = store.createChatSession({ agentId: agent.id, title: "Compat chat" });
    const squad = store.createSquad({ name: "Compat squad", leaderId: agent.id });
    const squadIssue = store.createIssue({
      title: "Squad evaluation",
      workspaceId: "local",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const squadTask = store.createTask({ agentId: agent.id, issueId: squadIssue.id, prompt: "evaluate squad" });

    const env = await app.request(`/api/agents/${agent.id}/env`);
    expect(await env.json()).toMatchObject({ agent_id: agent.id, custom_env: { SECRET_TOKEN: "real-value" } });

    const updatedEnv = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_env: { SECRET_TOKEN: "****", ADDED: "new" } }),
    });
    expect((await updatedEnv.json()).custom_env).toEqual({ SECRET_TOKEN: "real-value", ADDED: "new" });

    const addedSkills = await app.request(`/api/agents/${agent.id}/skills/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_ids: [skill.id, skill.id] }),
    });
    expect((await addedSkills.json()).map((item: any) => item.id)).toEqual([skill.id]);

    const skillSearchWithoutQuery = await app.request("/api/skills/search");
    expect(skillSearchWithoutQuery.status).toBe(400);
    expect(await skillSearchWithoutQuery.json()).toEqual({ error: "query is required" });

    const skillSearch = await app.request("/api/skills/search?q=deploy");
    const skillSearchBody = await skillSearch.json();
    expect(Array.isArray(skillSearchBody)).toBe(true);
    expect(skillSearchBody[0].name).toBe("Deploy Helper");
    expect(skillSearchBody[0]).toMatchObject({
      description: "Deployment skill",
      source: "local",
      repo: null,
      github_stars: null,
      install_count: null,
    });
    expect(skillSearchBody[0].id).toBeUndefined();
    expect(skillSearchBody[0].workspaceId).toBeUndefined();

    const batchedChildren = await app.request(`/api/issues/children?parent_ids=${encodeURIComponent(parent.id)}`);
    expect((await batchedChildren.json()).issues[0].id).toBe(child.id);

    const squadEvaluated = await app.request(`/api/issues/${squadIssue.id}/squad-evaluated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-ID": agent.id,
        "X-Task-ID": squadTask.id,
      },
      body: JSON.stringify({ outcome: "no_action", reason: "nothing to delegate" }),
    });
    const squadEvaluatedBody = await squadEvaluated.json();
    expect(squadEvaluated.status).toBe(201);
    expect(squadEvaluatedBody.type).toBe("squad_leader_evaluated");
    expect(squadEvaluatedBody.data).toMatchObject({ outcome: "no_action", squad_id: squad.id, task_id: squadTask.id });

    await app.request(`/api/chat/sessions/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "hello page" }),
    });
    const chatPage = await app.request(`/api/chat/sessions/${chat.id}/messages/page?limit=1`);
    const chatPageBody = await chatPage.json();
    expect(chatPageBody.messages[0].chat_session_id).toBe(chat.id);
    expect(chatPageBody.limit).toBe(1);
    expect(chatPageBody.has_more).toBe(false);

    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const waitLocalDirectory = await app.request(`/api/daemon/tasks/${task.id}/wait-local-directory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "/tmp/repo" }),
    });
    const waitLocalDirectoryBody = await waitLocalDirectory.json();
    expect(waitLocalDirectoryBody.status).toBe("waiting_local_directory");
    expect(waitLocalDirectoryBody.wait_reason).toBe("/tmp/repo");
    expect(waitLocalDirectoryBody.progress_summary).toContain("/tmp/repo");

    const renew = await app.request("/api/tokens/current/renew", { method: "POST" });
    const renewBody = await renew.json();
    expect(renew.status).toBe(201);
    expect(renewBody.access_token).toStartWith("mul_");

    expect(await (await app.request("/api/cloud-billing/balance")).json()).toMatchObject({
      owner_id: "local",
      balance_micro: 0,
      balance_credit: 0,
      configured: false,
    });
    expect((await (await app.request("/api/cloud-billing/transactions?page=2&page_size=5")).json()).page).toBe(2);
    expect((await (await app.request("/api/cloud-billing/price-tiers")).json())[0].configured).toBe(false);
    expect((await (await app.request("/api/cloud-billing/checkout-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier_id: "local-disabled" }),
    })).json()).session_id).toBe("local-disabled");
    expect((await (await app.request("/api/cloud-billing/portal-sessions", { method: "POST" })).json()).configured).toBe(false);

    const larkList = await app.request("/api/workspaces/local/lark/installations");
    expect(await larkList.json()).toMatchObject({ configured: false, install_supported: false, installations: [] });
    expect((await (await app.request("/api/workspaces/local/lark/install/begin?agent_id=agt", { method: "POST" })).json()).error_reason).toBe("not_configured");
    expect((await (await app.request("/api/workspaces/local/lark/install/session-1/status")).json()).status).toBe("error");
    expect((await app.request("/api/workspaces/local/lark/installations/lin_1", { method: "DELETE" })).status).toBe(204);
    expect((await app.request("/api/lark/binding/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "lark-token" }),
    })).status).toBe(409);

    expect((await app.request("/api/webhooks/stripe", { method: "POST" })).status).toBe(202);
    expect((await app.request("/api/contact-sales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com" }),
    })).status).toBe(201);

    store.updateAgent(agent.id, { runtimeId: runtime.id });
    const cascade = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_active_agent_ids: [agent.id] }),
    });
    const cascadeBody = await cascade.json();
    expect(cascadeBody).toEqual({ status: "ok", agents_archived: 1, tasks_cancelled: 3 });
    expect(store.getRuntime(runtime.id)).toBeNull();
    expect(store.getAgent(agent.id)).toBeNull();
  });

  it("serves selected console workflows across linked workspace resources", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const runtime = store.registerRuntime({
      id: "rt_console_contract",
      name: "Console Claude",
      provider: "claude",
      workspaceId: "local",
      metadata: { cli_version: "0.2.0-test" },
    });
    const agent = store.createAgent({
      id: "agt_console_contract",
      name: "Console Agent",
      provider: "claude",
      runtimeId: runtime.id,
      workspaceId: "local",
    });
    const skill = store.createSkill({
      id: "skl_console_contract",
      name: "Console Skill",
      description: "Skill detail used by the console contract",
      content: "Use the selected console workflow.",
      workspaceId: "local",
      files: [{ path: "notes/console.md", content: "Use the selected console workflow." }],
    });
    const project = store.createProject({ id: "prj_console_contract", title: "Console Project", workspaceId: "local" });
    const issue = store.createIssue({
      id: "iss_console_contract",
      title: "Console Issue",
      workspaceId: "local",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const autopilot = store.createAutopilot({
      id: "aut_console_contract",
      title: "Console Autopilot",
      workspaceId: "local",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
      triggerKind: "manual",
    });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "console usage" });

    const config = await app.request("/api/config");
    expect(await config.json()).toMatchObject({ allow_signup: true, analytics_environment: expect.any(String) });

    const me = await app.request("/api/me");
    expect(await me.json()).toMatchObject({ id: "local", email: "local@multiremi.local" });

    const workspaces = await app.request("/api/workspaces");
    expect((await workspaces.json()).map((workspace: any) => workspace.id)).toContain("local");

    const assignedSkills = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_ids: [skill.id] }),
    });
    expect((await assignedSkills.json()).map((item: any) => item.id)).toEqual([skill.id]);

    const runtimeList = await app.request("/api/runtimes?workspace_id=local");
    const runtimeListBody = await runtimeList.json();
    expect(runtimeListBody.find((item: any) => item.id === runtime.id)).toMatchObject({
      id: runtime.id,
      workspace_id: "local",
      provider: "claude",
    });

    const runtimePatch = await app.request(`/api/runtimes/${runtime.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(await runtimePatch.json()).toMatchObject({ id: runtime.id, visibility: "public", workspace_id: "local" });

    const runtimeDetail = await app.request(`/api/runtimes/${runtime.id}`);
    const runtimeDetailBody = await runtimeDetail.json();
    expect(runtimeDetailBody.runtime.id).toBe(runtime.id);
    expect(runtimeDetailBody.usage).toEqual([]);

    const agents = await app.request("/api/agents?workspace_id=local");
    expect((await agents.json()).find((item: any) => item.id === agent.id)).toMatchObject({
      id: agent.id,
      runtime_id: runtime.id,
    });
    expect((await (await app.request(`/api/agents/${agent.id}`)).json()).name).toBe("Console Agent");
    expect((await (await app.request(`/api/agents/${agent.id}/skills`)).json()).map((item: any) => item.id)).toEqual([skill.id]);

    const skills = await app.request("/api/skills?workspace_id=local");
    expect((await skills.json()).find((item: any) => item.id === skill.id)).toMatchObject({ id: skill.id, name: "Console Skill" });
    const skillDetail = await app.request(`/api/skills/${skill.id}`);
    expect((await skillDetail.json()).files[0]).toMatchObject({ path: "notes/console.md" });

    const projects = await app.request("/api/projects?workspace_id=local");
    const projectsBody = await projects.json();
    expect(projectsBody.projects.find((item: any) => item.id === project.id)).toMatchObject({
      id: project.id,
      title: "Console Project",
      workspace_id: "local",
    });
    expect(projectsBody.total).toBeGreaterThanOrEqual(1);
    expect((await (await app.request(`/api/projects/${project.id}`)).json()).workspace_id).toBe("local");

    const issuePatch = await app.request(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(await issuePatch.json()).toMatchObject({ id: issue.id, status: "in_progress", project_id: project.id });

    const issueList = await app.request("/api/issues?workspace_id=local&status=in_progress");
    const issueListBody = await issueList.json();
    const listedIssue = issueListBody.issues.find((item: any) => item.id === issue.id);
    expect(listedIssue).toMatchObject({
      id: issue.id,
      assignee_id: agent.id,
      project_id: project.id,
    });
    expect(listedIssue.latestTaskStatus).toBeUndefined();
    const issueDetail = await app.request(`/api/issues/${issue.key.toLowerCase()}`);
    const issueDetailBody = await issueDetail.json();
    expect(issueDetailBody).toMatchObject({
      id: issue.id,
      workspace_id: "local",
      identifier: issue.key,
      project_id: project.id,
    });
    expect(issueDetailBody.tasks).toBeUndefined();
    const taskRuns = await app.request(`/api/issues/${issue.key}/task-runs`);
    expect((await taskRuns.json())[0].id).toBe(task.id);
    const timeline = await app.request(`/api/issues/${issue.id}/timeline`);
    const timelineBody = await timeline.json();
    expect(timelineBody.map((entry: any) => entry.type)).toContain("activity");
    expect(timelineBody[0].actorType).toBeUndefined();
    expect(timelineBody[0].actor_type).toBeDefined();

    const autopilotPatch = await app.request(`/api/autopilots/${autopilot.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    const autopilotPatchBody = await autopilotPatch.json();
    expect(autopilotPatchBody).toMatchObject({ id: autopilot.id, status: "paused", project_id: project.id });
    expect(autopilotPatchBody.projectId).toBeUndefined();
    const autopilots = await app.request("/api/autopilots?workspace_id=local");
    const autopilotsBody = await autopilots.json();
    expect(autopilotsBody.autopilots.find((item: any) => item.id === autopilot.id)).toMatchObject({ id: autopilot.id });
    expect(autopilotsBody.total).toBeGreaterThanOrEqual(1);
    const autopilotDetailBody = await (await app.request(`/api/autopilots/${autopilot.id}`)).json();
    expect(autopilotDetailBody.autopilot.id).toBe(autopilot.id);
    expect(autopilotDetailBody.autopilot.projectId).toBeUndefined();

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect((await claim.json()).task.id).toBe(task.id);
    await app.request(`/api/daemon/tasks/${task.id}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usage: [{ provider: "claude", model: "sonnet", input_tokens: 21, output_tokens: 8 }] }),
    });

    const dailyUsage = await app.request("/api/dashboard/usage/daily?workspace_id=local");
    expect((await dailyUsage.json())[0]).toMatchObject({
      runtimeId: runtime.id,
      provider: "claude",
      model: "sonnet",
      inputTokens: 21,
      taskCount: 1,
    });
    const usageByAgent = await app.request("/api/dashboard/usage/by-agent?workspace_id=local");
    expect((await usageByAgent.json())[0]).toMatchObject({ agentId: agent.id, model: "sonnet", outputTokens: 8, taskCount: 1 });
    const runtimeDaily = await app.request("/api/dashboard/runtime/daily?workspace_id=local");
    expect((await runtimeDaily.json())[0]).toMatchObject({ taskCount: 1, failedCount: 0 });
  });

  it("serves issues as first-class records with linked tasks", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/multiremi/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "First class issue", agentId: agent.id, prompt: "Do it" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    const listed = await app.request("/api/multiremi/issues");
    const listBody = await listed.json();
    expect(listBody.issues[0].taskCount).toBe(1);
    expect(listBody.issues[0].latestTaskId).toBe(createdBody.task.id);

    const detail = await app.request(`/api/multiremi/issues/${createdBody.issue.id}`);
    const detailBody = await detail.json();
    expect(detailBody.issue.tasks).toHaveLength(1);
    expect(detailBody.issue.tasks[0].prompt).toBe("Do it");

    const updated = await app.request(`/api/issues/${createdBody.issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: "high" }),
    });
    expect((await updated.json()).priority).toBe("high");
  });

  it("serves issue compatibility list, grouped, and batch endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Issue owner" });
    const project = store.createProject({ title: "Batch project" });
    const app = createMultiremiApp({ store });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));

    const first = store.createIssue({
      title: "Batch first",
      workspaceId: "local",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
      status: "open",
      priority: "low",
      position: 2,
    });
    const second = store.createIssue({
      title: "Batch second",
      workspaceId: "local",
      assigneeType: "member",
      assigneeId: member.id,
      status: "open",
      priority: "medium",
      position: 1,
    });
    store.createIssue({ title: "Other workspace", workspaceId: "other", status: "open" });
    const remoteIssue = store.createIssue({ title: "Remote workspace issue", workspaceId: "remote", status: "open" });
    const label = store.createLabel({ name: "Batch label", color: "#22c55e" });
    store.attachLabelToIssue(first.id, label.id);
    const reaction = store.addIssueReaction(first.id, { actorType: "member", actorId: "local", emoji: "👍" });
    const attachment = store.createAttachment({
      issueId: first.id,
      filename: "batch.txt",
      url: "/uploads/batch.txt",
      contentType: "text/plain",
      sizeBytes: 42,
    });
    expect(first.status).toBe("todo");
    expect(second.status).toBe("todo");

    const listed = await app.request("/api/issues?workspace_id=local&status=open");
    const listedBody = await listed.json();
    expect(listedBody.total).toBe(2);
    expect(listedBody.issues.map((issue: any) => issue.id).sort()).toEqual([first.id, second.id].sort());
    const firstListed = listedBody.issues.find((issue: any) => issue.id === first.id);
    expect(firstListed).toMatchObject({
      id: first.id,
      workspace_id: "local",
      identifier: first.key,
      project_id: project.id,
      assignee_type: "agent",
      assignee_id: agent.id,
      labels: [{ id: label.id, workspace_id: "local", name: "Batch label" }],
    });
    expect(firstListed.workspaceId).toBeUndefined();
    expect(firstListed.assigneeId).toBeUndefined();
    expect(firstListed.latestTaskStatus).toBeUndefined();

    const camelWorkspaceList = await app.request("/api/issues?workspaceId=remote&status=open");
    const camelWorkspaceListBody = await camelWorkspaceList.json();
    expect(camelWorkspaceListBody.issues.map((issue: any) => issue.id)).not.toContain(remoteIssue.id);
    const snakeWorkspaceList = await app.request("/api/issues?workspace_id=remote&status=open");
    const snakeWorkspaceListBody = await snakeWorkspaceList.json();
    expect(snakeWorkspaceListBody.issues.map((issue: any) => issue.id)).toEqual([remoteIssue.id]);

    const camelWorkspaceDetail = await app.request(`/api/issues/${remoteIssue.key}?workspaceId=remote`);
    const camelWorkspaceDetailBody = await camelWorkspaceDetail.json();
    expect(camelWorkspaceDetailBody.id).toBe(first.id);
    const snakeWorkspaceDetail = await app.request(`/api/issues/${remoteIssue.key}?workspace_id=remote`);
    const snakeWorkspaceDetailBody = await snakeWorkspaceDetail.json();
    expect(snakeWorkspaceDetailBody.id).toBe(remoteIssue.id);

    const detail = await app.request(`/api/issues/${first.key.toLowerCase()}`);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({
      id: first.id,
      workspace_id: "local",
      identifier: first.key,
      labels: [{ id: label.id, workspace_id: "local", name: "Batch label" }],
      reactions: [{ id: reaction.id, issue_id: first.id, actor_type: "member", actor_id: "local", emoji: "👍" }],
      attachments: [{
        id: attachment.id,
        issue_id: first.id,
        filename: "batch.txt",
        content_type: "text/plain",
        size_bytes: 42,
      }],
    });
    expect(detailBody.tasks).toBeUndefined();
    expect(detailBody.workspaceId).toBeUndefined();
    expect(detailBody.reactions[0].issueId).toBeUndefined();
    expect(detailBody.attachments[0].issueId).toBeUndefined();

    const memberFiltered = await app.request("/api/issues?workspace_id=local&assignee_id=issue%20owner");
    const memberFilteredBody = await memberFiltered.json();
    expect(memberFilteredBody.total).toBe(1);
    expect(memberFilteredBody.issues[0].id).toBe(second.id);

    const agentFiltered = await app.request("/api/issues?workspace_id=local&assignee_id=cod");
    const agentFilteredBody = await agentFiltered.json();
    expect(agentFilteredBody.total).toBe(1);
    expect(agentFilteredBody.issues[0].id).toBe(first.id);

    const camelAssigneeFiltered = await app.request("/api/issues?workspace_id=local&assigneeId=cod");
    const camelAssigneeFilteredBody = await camelAssigneeFiltered.json();
    expect(camelAssigneeFilteredBody.issues.map((issue: any) => issue.id).sort()).toEqual([first.id, second.id].sort());

    const camelProjectFiltered = await app.request(`/api/issues?workspace_id=local&projectId=${project.id}`);
    const camelProjectFilteredBody = await camelProjectFiltered.json();
    expect(camelProjectFilteredBody.issues.map((issue: any) => issue.id).sort()).toEqual([first.id, second.id].sort());

    const grouped = await app.request("/api/issues/grouped?workspace_id=local&statuses=open&limit=10");
    const groupedBody = await grouped.json();
    expect(groupedBody.groups.map((group: any) => group.id)).toEqual([
      `member:${member.id}`,
      `agent:${agent.id}`,
    ]);
    expect(groupedBody.groups[0].total).toBe(1);
    expect(groupedBody.groups[1].issues[0].id).toBe(first.id);

    const camelGrouped = await app.request("/api/issues/grouped?workspaceId=remote&statuses=open&limit=10");
    const camelGroupedBody = await camelGrouped.json();
    expect(camelGroupedBody.groups.flatMap((group: any) => group.issues.map((issue: any) => issue.id))).not.toContain(remoteIssue.id);

    const camelCreated = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Camel ignored issue",
        workspaceId: "remote",
        projectId: project.id,
        assigneeId: member.id,
        dueDate: "2026-05-01",
        acceptanceCriteria: ["ignored"],
      }),
    });
    expect(camelCreated.status).toBe(201);
    const camelCreatedBody = await camelCreated.json();
    expect(camelCreatedBody).toMatchObject({
      workspace_id: "local",
      project_id: null,
      assignee_type: null,
      assignee_id: null,
      due_date: null,
    });
    const camelStored = store.getIssue(camelCreatedBody.id)!;
    expect(camelStored.workspaceId).toBe("local");
    expect(camelStored.projectId).toBeNull();
    expect(camelStored.assigneeId).toBeNull();
    expect(camelStored.dueDate).toBeNull();
    expect(camelStored.acceptanceCriteria).toEqual([]);

    const camelUpdated = await app.request(`/api/issues/${camelCreatedBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, assigneeId: member.id, dueDate: "2026-05-02", acceptanceCriteria: ["ignored"] }),
    });
    expect(camelUpdated.status).toBe(200);
    const camelUpdatedBody = await camelUpdated.json();
    expect(camelUpdatedBody).toMatchObject({
      project_id: null,
      assignee_type: null,
      assignee_id: null,
      due_date: null,
    });
    const camelUpdatedStored = store.getIssue(camelCreatedBody.id)!;
    expect(camelUpdatedStored.projectId).toBeNull();
    expect(camelUpdatedStored.assigneeId).toBeNull();
    expect(camelUpdatedStored.dueDate).toBeNull();
    expect(camelUpdatedStored.acceptanceCriteria).toEqual([]);

    const noMutation = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_ids: [first.id], updates: {} }),
    });
    expect(await noMutation.json()).toEqual({ updated: 0 });

    const camelBatchIds = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueIds: [first.id], updates: { priority: "urgent" } }),
    });
    expect(camelBatchIds.status).toBe(400);
    expect(await camelBatchIds.json()).toEqual({ error: "issue_ids is required" });

    const camelBatchUpdates = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_ids: [first.id], updates: { projectId: project.id, assigneeId: member.id } }),
    });
    expect(await camelBatchUpdates.json()).toEqual({ updated: 0 });
    expect(store.getIssue(first.id)?.assigneeId).toBe(agent.id);

    const updated = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issue_ids: [first.id, "missing", second.id],
        updates: { status: "done", priority: "urgent", project_id: project.id },
      }),
    });
    expect(await updated.json()).toEqual({ updated: 2 });
    expect(store.getIssue(first.id)?.status).toBe("done");
    expect(store.getIssue(second.id)?.priority).toBe("urgent");

    const camelDeleted = await app.request("/api/issues/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueIds: [first.id] }),
    });
    expect(camelDeleted.status).toBe(400);
    expect(await camelDeleted.json()).toEqual({ error: "issue_ids is required" });
    expect(store.getIssue(first.id)).not.toBeNull();

    const deleted = await app.request("/api/issues/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_ids: [first.id, second.id, "missing"] }),
    });
    expect(await deleted.json()).toEqual({ deleted: 2 });
    expect(store.getIssue(first.id)).toBeNull();
    expect(store.getIssue(second.id)).toBeNull();

    const invalidCreate = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCreate.status).toBe(400);
    expect(await invalidCreate.json()).toEqual({ error: "invalid request body" });

    const compatCreated = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Compat created issue",
        workspace_id: "local",
        assignee_type: "member",
        assignee_id: member.id,
      }),
    });
    expect(compatCreated.status).toBe(201);
    const compatCreatedBody = await compatCreated.json();
    const compatCreatedIdentifier = String(compatCreatedBody.identifier);
    expect(compatCreatedIdentifier).toMatch(/^MUL-\d+$/);
    expect(compatCreatedBody).toMatchObject({
      workspace_id: "local",
      creator_type: "member",
      creator_id: "local",
      assignee_type: "member",
      assignee_id: member.id,
    });
    expect(compatCreatedBody.workspaceId).toBeUndefined();
    expect(events.find((event) => event.type === "issue:created" && (event.payload.issue as any)?.id === compatCreatedBody.id)).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: {
        issue: {
          id: compatCreatedBody.id,
          workspace_id: "local",
          assignee_type: "member",
          assignee_id: member.id,
        },
      },
    });

    const compatUpdated = await app.request(`/api/issues/${compatCreatedIdentifier.toLowerCase()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress", priority: "high", assignee_id: null, due_date: "2026-02-03" }),
    });
    expect(compatUpdated.status).toBe(200);
    const compatUpdatedBody = await compatUpdated.json();
    expect(compatUpdatedBody).toMatchObject({
      id: compatCreatedBody.id,
      workspace_id: "local",
      status: "in_progress",
      priority: "high",
      assignee_type: null,
      assignee_id: null,
    });
    expect(compatUpdatedBody.assigneeId).toBeUndefined();
    expect(events.find((event) => event.type === "issue:updated" && (event.payload.issue as any)?.id === compatCreatedBody.id)).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: {
        issue: { id: compatCreatedBody.id, status: "in_progress", priority: "high", assignee_type: null },
        assignee_changed: true,
        status_changed: true,
        priority_changed: true,
        due_date_changed: true,
        prev_status: "todo",
        prev_priority: "none",
        prev_assignee_type: "member",
        prev_assignee_id: member.id,
        creator_type: "member",
        creator_id: "local",
      },
    });
  });

  it("serves quick-create issue compatibility endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Quick Codex", provider: "codex" });
    const leader = store.createAgent({ name: "Squad Lead", provider: "claude" });
    const squad = store.createSquad({ name: "Quick squad", leaderId: leader.id });
    const project = store.createProject({ title: "Quick project" });
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "quick cod",
        prompt: "Create an issue for improving onboarding screenshots",
        project_id: project.id,
        workspace_id: "local",
      }),
    });
    expect(created.status).toBe(202);
    const createdBody = await created.json();
    expect(createdBody.task_id).toStartWith("tsk_");
    const task = store.getTask(createdBody.task_id)!;
    expect(task.agentId).toBe(agent.id);
    expect(task.issueId).toBeString();
    const issue = store.getIssue(task.issueId!)!;
    expect(issue.title).toBe("Create an issue for improving onboarding screenshots");
    expect(issue.projectId).toBe(project.id);
    expect(issue.assigneeType).toBe("agent");
    expect(issue.contextRefs[0]).toEqual({ type: "quick_create", prompt: "Create an issue for improving onboarding screenshots" });

    const camelAgentQuickCreate = await app.request("/api/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: agent.id,
        prompt: "Camel agent should not queue",
      }),
    });
    expect(camelAgentQuickCreate.status).toBe(400);
    expect(await camelAgentQuickCreate.json()).toEqual({ error: "exactly one of agent_id or squad_id is required" });

    const camelProjectQuickCreate = await app.request("/api/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agent.id,
        prompt: "Camel project should be ignored",
        projectId: project.id,
        workspaceId: "remote",
      }),
    });
    expect(camelProjectQuickCreate.status).toBe(202);
    const camelProjectQuickBody = await camelProjectQuickCreate.json();
    const camelProjectQuickTask = store.getTask(camelProjectQuickBody.task_id)!;
    const camelProjectQuickIssue = store.getIssue(camelProjectQuickTask.issueId!)!;
    expect(camelProjectQuickIssue.workspaceId).toBe("local");
    expect(camelProjectQuickIssue.projectId).toBeNull();

    const squadCreated = await app.request("/api/multiremi/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ squad_id: squad.id, prompt: "Plan squad handoff" }),
    });
    expect(squadCreated.status).toBe(202);
    const squadBody = await squadCreated.json();
    expect(squadBody.task.agentId).toBe(leader.id);
    expect(squadBody.issue.assigneeType).toBe("squad");
    expect(squadBody.task_id).toBe(squadBody.task.id);

    const badPrompt = await app.request("/api/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agent.id, prompt: "   " }),
    });
    expect(badPrompt.status).toBe(400);
    expect((await badPrompt.json()).error).toBe("prompt is required");
  });

  it("serves issue hierarchy and planning fields through API endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "API hierarchy" });

    const parentRes = await app.request("/api/multiremi/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "API parent",
        project_id: project.id,
        priority: "high",
        due_date: "2026-06-10T12:00:00+08:00",
        acceptance_criteria: ["works"],
        context_refs: [{ type: "repo", url: "git@example.com:repo.git" }],
      }),
    });
    expect(parentRes.status).toBe(201);
    const parent = (await parentRes.json()).issue;

    const childRes = await app.request("/api/multiremi/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "API child", parent_issue_id: parent.id, position: 3 }),
    });
    expect(childRes.status).toBe(201);
    const child = (await childRes.json()).issue;
    expect(child.parentIssueId).toBe(parent.id);
    expect(child.projectId).toBe(project.id);

    const updated = await app.request(`/api/multiremi/issues/${child.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done", priority: "urgent", start_date: "2026-06-04T09:00:00+08:00" }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).issue.priority).toBe("urgent");

    const detail = await app.request(`/api/multiremi/issues/${parent.id}`);
    const detailBody = await detail.json();
    expect(detailBody.issue.dueDate).toBe("2026-06-10T04:00:00.000Z");
    expect(detailBody.issue.acceptanceCriteria).toEqual(["works"]);
    expect(detailBody.children.map((item: any) => item.id)).toEqual([child.id]);
    expect(detailBody.childProgress).toEqual({ parentIssueId: parent.id, total: 1, done: 1 });

    const children = await app.request(`/api/issues/${parent.id}/children`);
    expect((await children.json()).total).toBe(1);

    const progress = await app.request("/api/issues/child-progress?workspaceId=local");
    expect((await progress.json()).progress).toEqual([{ parentIssueId: parent.id, total: 1, done: 1 }]);

    const remoteParent = store.createIssue({ title: "Remote API parent", workspaceId: "remote" });
    const remoteChild = store.createIssue({ title: "Remote API child", workspaceId: "remote", parentIssueId: remoteParent.id });

    const camelProgress = await app.request("/api/issues/child-progress?workspaceId=remote");
    expect((await camelProgress.json()).progress).toEqual([{ parentIssueId: parent.id, total: 1, done: 1 }]);
    const snakeProgress = await app.request("/api/issues/child-progress?workspace_id=remote");
    expect((await snakeProgress.json()).progress).toEqual([{ parentIssueId: remoteParent.id, total: 1, done: 0 }]);

    const camelBatchChildren = await app.request(`/api/issues/children?parentIds=${remoteParent.id}`);
    expect(await camelBatchChildren.json()).toEqual({ issues: [], total: 0 });
    const snakeBatchChildren = await app.request(`/api/issues/children?parent_ids=${remoteParent.id}`);
    const snakeBatchChildrenBody = await snakeBatchChildren.json();
    expect(snakeBatchChildrenBody.total).toBe(1);
    expect(snakeBatchChildrenBody.issues[0].id).toBe(remoteChild.id);
  });

  it("serves issue dependency endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const blocker = store.createIssue({ title: "API blocker" });
    const blocked = store.createIssue({ title: "API blocked" });

    const created = await app.request(`/api/issues/${blocked.id}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depends_on_issue_id: blocker.id, type: "blocked_by" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.dependency).toMatchObject({
      workspace_id: "local",
      issue_id: blocked.id,
      depends_on_issue_id: blocker.id,
      type: "blocked_by",
      depends_on_issue: {
        id: blocker.id,
        workspace_id: "local",
        title: "API blocker",
      },
    });
    expect(createdBody.dependency.dependsOnIssueId).toBeUndefined();
    expect(createdBody.dependency.depends_on_issue.workspaceId).toBeUndefined();

    const compatListed = await app.request(`/api/issues/${blocker.id}/dependencies`);
    const compatListedBody = await compatListed.json();
    expect(compatListedBody.dependencies[0]).toMatchObject({
      id: createdBody.dependency.id,
      issue_id: blocked.id,
      depends_on_issue_id: blocker.id,
    });
    expect(compatListedBody.dependencies[0].issueId).toBeUndefined();

    const listed = await app.request(`/api/multiremi/issues/${blocker.id}/dependencies`);
    const listedBody = await listed.json();
    expect(listedBody.total).toBe(1);
    expect(listedBody.dependencies[0].dependsOnIssueId).toBe(blocker.id);

    const detail = await app.request(`/api/multiremi/issues/${blocked.id}`);
    expect((await detail.json()).dependencies[0].id).toBe(createdBody.dependency.id);

    const invalid = await app.request(`/api/issues/${blocked.id}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid request body" });

    const deleted = await app.request(`/api/issues/${blocked.id}/dependencies/${createdBody.dependency.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ status: "ok" });
    expect(store.listIssueDependencies(blocked.id)).toEqual([]);
  });

  it("assigns issues through API endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Grace Hopper", email: "grace@example.com" });
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/multiremi/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Assignable issue", assigneeId: "grace@example.com" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.issue.assigneeType).toBe("member");
    expect(createdBody.task).toBeNull();

    const assigned = await app.request(`/api/multiremi/issues/${createdBody.issue.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeId: "cod", prompt: "Please implement" }),
    });
    expect(assigned.status).toBe(200);
    const assignedBody = await assigned.json();
    expect(assignedBody.issue.assigneeId).toBe(agent.id);
    expect(assignedBody.task.agentId).toBe(agent.id);
    expect(assignedBody.task.prompt).toBe("Please implement");

    const camelReassigned = await app.request(`/api/issues/${createdBody.issue.key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeId: "Grace Hopper" }),
    });
    expect(camelReassigned.status).toBe(200);
    const camelReassignedBody = await camelReassigned.json();
    expect(camelReassignedBody.assignee_type).toBe("agent");
    expect(camelReassignedBody.assignee_id).toBe(agent.id);

    const reassigned = await app.request(`/api/issues/${createdBody.issue.key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignee_id: "Grace Hopper" }),
    });
    const reassignedBody = await reassigned.json();
    expect(reassignedBody.assignee_type ?? reassignedBody.assigneeType).toBe("member");
    expect(reassignedBody.assignee_id ?? reassignedBody.assigneeId).toBe(member.id);
  });

  it("updates and archives workspace objects", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const project = store.createProject({ title: "Ops" });
    const squad = store.createSquad({ name: "Ops squad", leaderId: agent.id });
    const autopilot = store.createAutopilot({
      title: "Ops auto",
      projectId: project.id,
      assigneeType: "squad",
      assigneeId: squad.id,
    });

    expect(store.updateSquad(squad.id, { name: "Ops team" }).name).toBe("Ops team");
    store.removeSquadMember(squad.id, { memberType: "agent", memberId: agent.id });
    expect(store.listSquadMembers(squad.id)).toHaveLength(0);
    expect(store.getSquad(squad.id)?.leaderId).toBeNull();

    expect(store.updateAutopilot(autopilot.id, { status: "paused" }).status).toBe("paused");
    expect(store.archiveAutopilot(autopilot.id).status).toBe("archived");
    expect(store.listAutopilots()).toHaveLength(0);

    expect(store.archiveProject(project.id).status).toBe("cancelled");
    expect(store.archiveSquad(squad.id).archivedAt).toBeString();
    expect(store.listSquads()).toHaveLength(0);
  });

  it("serves project resource endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "Resources" });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));

    const invalidNativeResourceCreate = await app.request(`/api/multiremi/projects/${project.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativeResourceCreate.status).toBe(400);
    expect(await invalidNativeResourceCreate.json()).toEqual({ error: "invalid request body" });

    const created = await app.request(`/api/multiremi/projects/${project.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_type: "github_repo",
        resource_ref: { url: "git@github.com:example/repo.git", default_branch_hint: "main" },
        label: "ssh repo",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.resource.resourceRef.url).toBe("git@github.com:example/repo.git");
    expect(events.find((event) => event.type === "project_resource:created")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: {
        project_id: project.id,
        resource: {
          id: createdBody.resource.id,
          resource_type: "github_repo",
          resource_ref: { url: "git@github.com:example/repo.git", default_branch_hint: "main" },
        },
      },
    });

    const invalidNativeResourceUpdate = await app.request(`/api/multiremi/projects/${project.id}/resources/${createdBody.resource.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativeResourceUpdate.status).toBe(400);
    expect(await invalidNativeResourceUpdate.json()).toEqual({ error: "invalid request body" });

    const updated = await app.request(`/api/multiremi/projects/${project.id}/resources/${createdBody.resource.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_ref: { url: "git@github.com:example/repo-updated.git", default_branch_hint: "develop" },
        label: "",
        position: 2,
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.resource.resourceRef.url).toBe("git@github.com:example/repo-updated.git");
    expect(updatedBody.resource.label).toBeNull();
    expect(updatedBody.resource.position).toBe(2);
    expect(events.find((event) => event.type === "project_resource:updated")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: {
        project_id: project.id,
        resource: {
          id: createdBody.resource.id,
          resource_type: "github_repo",
          resource_ref: { url: "git@github.com:example/repo-updated.git", default_branch_hint: "develop" },
          label: null,
          position: 2,
        },
      },
    });

    const listed = await app.request(`/api/multiremi/projects/${project.id}/resources`);
    expect((await listed.json()).total).toBe(1);

    const detail = await app.request(`/api/multiremi/projects/${project.id}`);
    expect((await detail.json()).resources).toHaveLength(1);

    const deleted = await app.request(`/api/multiremi/projects/${project.id}/resources/${createdBody.resource.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(store.listProjectResources(project.id)).toHaveLength(0);
    expect(events.find((event) => event.type === "project_resource:deleted")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: {
        project_id: project.id,
        resource_id: createdBody.resource.id,
      },
    });

    const missingDelete = await app.request(`/api/multiremi/projects/${project.id}/resources/${createdBody.resource.id}`, {
      method: "DELETE",
    });
    expect(missingDelete.status).toBe(404);
    expect(await missingDelete.json()).toEqual({ error: "project resource not found" });
  });

  it("serves original project, squad, and autopilot compatibility endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Original Codex", provider: "codex" });
    const app = createMultiremiApp({ store });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));

    const invalidNativeProjectCreate = await app.request("/api/multiremi/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativeProjectCreate.status).toBe(400);
    expect(await invalidNativeProjectCreate.json()).toEqual({ error: "invalid request body" });

    const invalidProjectCreate = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidProjectCreate.status).toBe(400);
    expect(await invalidProjectCreate.json()).toEqual({ error: "invalid request body" });

    const project = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Original Project", priority: "high", lead_type: "agent", lead_id: agent.id }),
    });
    const projectBody = await project.json();
    expect(project.status).toBe(201);
    expect(projectBody.title).toBe("Original Project");
    expect(projectBody.workspace_id).toBe("local");
    expect(projectBody.lead_type).toBe("agent");
    expect(projectBody.lead_id).toBe(agent.id);
    expect(projectBody.issue_count).toBe(0);
    expect(projectBody.resource_count).toBe(0);
    expect(projectBody.workspaceId).toBeUndefined();
    expect(events.find((event) => event.type === "project:created")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: { project: { id: projectBody.id, workspace_id: "local", lead_type: "agent", lead_id: agent.id } },
    });

    const remoteProject = store.createProject({ title: "Remote Compatibility Project", workspaceId: "remote" });
    const projectListBody = await (await app.request("/api/projects")).json();
    expect(projectListBody.projects[0].id).toBe(projectBody.id);
    expect(projectListBody.total).toBe(1);
    const camelWorkspaceProjects = await (await app.request("/api/projects?workspaceId=remote")).json();
    expect(camelWorkspaceProjects.projects.some((item: any) => item.id === remoteProject.id)).toBe(false);
    const snakeWorkspaceProjects = await (await app.request("/api/projects?workspace_id=remote")).json();
    expect(snakeWorkspaceProjects.projects.map((item: any) => item.id)).toEqual([remoteProject.id]);

    const invalidNativeProjectUpdate = await app.request(`/api/multiremi/projects/${projectBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativeProjectUpdate.status).toBe(400);
    expect(await invalidNativeProjectUpdate.json()).toEqual({ error: "invalid request body" });

    const invalidProjectUpdate = await app.request(`/api/projects/${projectBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidProjectUpdate.status).toBe(400);
    expect(await invalidProjectUpdate.json()).toEqual({ error: "invalid request body" });

    const updatedProject = await app.request(`/api/projects/${projectBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Original Project Updated", lead_type: null, lead_id: null }),
    });
    const updatedProjectBody = await updatedProject.json();
    expect(updatedProject.status).toBe(200);
    expect(updatedProjectBody.title).toBe("Original Project Updated");
    expect(updatedProjectBody.lead_type).toBeNull();
    expect(updatedProjectBody.lead_id).toBeNull();
    expect(updatedProjectBody.updated_at).toBeString();

    const camelProjectUpdate = await app.request(`/api/projects/${projectBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadType: "agent", leadId: agent.id }),
    });
    expect(camelProjectUpdate.status).toBe(200);
    const camelProjectUpdateBody = await camelProjectUpdate.json();
    expect(camelProjectUpdateBody.lead_type).toBeNull();
    expect(camelProjectUpdateBody.lead_id).toBeNull();
    expect(events.find((event) => event.type === "project:updated")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: { project: { id: projectBody.id, title: "Original Project Updated", lead_type: null, lead_id: null } },
    });

    const camelProjectCreate = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Camel Project", workspaceId: "remote", leadType: "agent", leadId: agent.id }),
    });
    const camelProjectCreateBody = await camelProjectCreate.json();
    expect(camelProjectCreate.status).toBe(201);
    expect(camelProjectCreateBody.workspace_id).toBe("local");
    expect(camelProjectCreateBody.lead_type).toBeNull();
    expect(camelProjectCreateBody.lead_id).toBeNull();

    const invalidResourceCreate = await app.request(`/api/projects/${projectBody.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidResourceCreate.status).toBe(400);
    expect(await invalidResourceCreate.json()).toEqual({ error: "invalid request body" });

    const resource = await app.request(`/api/projects/${projectBody.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_type: "github_repo", resource_ref: { url: "https://github.com/example/repo" } }),
    });
    const resourceBody = await resource.json();
    expect(resource.status).toBe(201);
    expect(resourceBody.resource_type).toBe("github_repo");
    expect(resourceBody.resource_ref.url).toBe("https://github.com/example/repo");

    const duplicateResource = await app.request(`/api/projects/${projectBody.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_type: "github_repo", resource_ref: { url: "https://github.com/example/repo" } }),
    });
    expect(duplicateResource.status).toBe(409);
    expect(await duplicateResource.json()).toEqual({ error: "this resource is already attached to the project" });

    const invalidResourceUpdate = await app.request(`/api/projects/${projectBody.id}/resources/${resourceBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidResourceUpdate.status).toBe(400);
    expect(await invalidResourceUpdate.json()).toEqual({ error: "invalid request body" });

    const updatedResource = await app.request(`/api/projects/${projectBody.id}/resources/${resourceBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_ref: { url: "https://github.com/example/repo-updated", default_branch_hint: "develop" },
        label: "",
        position: 3,
      }),
    });
    expect(updatedResource.status).toBe(200);
    const updatedResourceBody = await updatedResource.json();
    expect(updatedResourceBody.resource_ref).toEqual({
      url: "https://github.com/example/repo-updated",
      default_branch_hint: "develop",
    });
    expect(updatedResourceBody.label).toBeNull();
    expect(updatedResourceBody.position).toBe(3);

    const listedResourcesBody = await (await app.request(`/api/projects/${projectBody.id}/resources`)).json();
    expect(listedResourcesBody.total).toBe(1);
    expect(listedResourcesBody.resources[0].id).toBe(resourceBody.id);

    const localResource = await app.request(`/api/projects/${projectBody.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_type: "local_directory",
        resource_ref: { local_path: "/tmp/multiremi-local-project-api", daemon_id: "daemon-api" },
      }),
    });
    expect(localResource.status).toBe(201);
    const duplicateLocalResource = await app.request(`/api/projects/${projectBody.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_type: "local_directory",
        resource_ref: { local_path: "/tmp/multiremi-local-project-api-other", daemon_id: "daemon-api" },
      }),
    });
    expect(duplicateLocalResource.status).toBe(409);
    expect(await duplicateLocalResource.json()).toEqual({
      error: "this daemon already has a local_directory attached to the project; remove it before adding another",
    });

    const camelSquad = await app.request("/api/squads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Camel Squad", leaderId: agent.id }),
    });
    expect(camelSquad.status).toBe(400);
    expect(await camelSquad.json()).toEqual({ error: "leader_id is required" });

    const remoteAgent = store.createAgent({ name: "Remote Squad Agent", provider: "codex", workspaceId: "remote" });
    const remoteSquad = store.createSquad({ name: "Remote Squad", leaderId: remoteAgent.id, workspaceId: "remote" });

    const squad = await app.request("/api/squads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Original Squad", leader_id: agent.id }),
    });
    const squadBody = await squad.json();
    expect(squad.status).toBe(201);
    expect(squadBody).toMatchObject({
      workspace_id: "local",
      leader_id: agent.id,
      member_count: 1,
      member_preview: [{ member_type: "agent", member_id: agent.id, role: "leader" }],
    });
    expect(squadBody.leaderId).toBeUndefined();
    const localSquads = await (await app.request("/api/squads?workspaceId=remote")).json();
    expect(localSquads.some((item: any) => item.id === remoteSquad.id)).toBe(false);
    const remoteSquads = await (await app.request("/api/squads?workspace_id=remote")).json();
    expect(remoteSquads.some((item: any) => item.id === remoteSquad.id)).toBe(true);
    expect(remoteSquads[0].workspaceId).toBeUndefined();
    expect((await (await app.request(`/api/squads/${squadBody.id}/members/status`)).json())[0].status).toBe("available");
    const squadMember = store.createWorkspaceMember({ name: "Squad API Member" });
    const camelSquadMember = await app.request(`/api/squads/${squadBody.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberType: "member", memberId: squadMember.id }),
    });
    expect(camelSquadMember.status).toBe(400);
    expect(await camelSquadMember.json()).toEqual({ error: "member_type must be 'agent' or 'member'" });
    const addedSquadMember = await app.request(`/api/squads/${squadBody.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_type: "member", member_id: squadMember.id, role: "reviewer" }),
    });
    expect(addedSquadMember.status).toBe(201);
    const addedSquadMemberBody = await addedSquadMember.json();
    expect(addedSquadMemberBody).toMatchObject({ member_type: "member", member_id: squadMember.id, role: "reviewer" });
    expect(addedSquadMemberBody.memberId).toBeUndefined();
    const listedSquadMembers = await (await app.request(`/api/squads/${squadBody.id}/members`)).json();
    expect(listedSquadMembers.some((member: any) => member.member_id === squadMember.id)).toBe(true);
    expect((await app.request(`/api/squads/${squadBody.id}/members`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_type: "member", member_id: squadMember.id }),
    })).status).toBe(204);

    const autopilot = await app.request("/api/autopilots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Original Autopilot",
        project_id: projectBody.id,
        assignee_id: agent.id,
        execution_mode: "create_issue",
      }),
    });
    const autopilotBody = await autopilot.json();
    expect(autopilot.status).toBe(201);
    expect(autopilotBody.title).toBe("Original Autopilot");
    expect(autopilotBody.project_id).toBe(projectBody.id);
    expect(autopilotBody.assignee_id).toBe(agent.id);
    expect(autopilotBody.execution_mode).toBe("create_issue");
    expect(autopilotBody.projectId).toBeUndefined();

    const remoteAutopilot = store.createAutopilot({
      title: "Remote Autopilot",
      workspaceId: "remote",
      assigneeId: remoteAgent.id,
      executionMode: "run_only",
    });
    const camelWorkspaceAutopilots = await (await app.request("/api/autopilots?workspaceId=remote")).json();
    expect(camelWorkspaceAutopilots.autopilots.some((item: any) => item.id === remoteAutopilot.id)).toBe(false);
    const snakeWorkspaceAutopilots = await (await app.request("/api/autopilots?workspace_id=remote")).json();
    expect(snakeWorkspaceAutopilots.autopilots.map((item: any) => item.id)).toEqual([remoteAutopilot.id]);
    expect(snakeWorkspaceAutopilots.autopilots[0].workspaceId).toBeUndefined();

    const camelAutopilotCreate = await app.request("/api/autopilots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Camel Autopilot",
        projectId: projectBody.id,
        assigneeId: agent.id,
        executionMode: "create_issue",
      }),
    });
    expect(camelAutopilotCreate.status).toBe(400);
    expect(await camelAutopilotCreate.json()).toEqual({ error: "assignee_id is required" });

    const camelProjectAutopilot = await app.request("/api/autopilots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Camel Project Autopilot",
        workspaceId: "remote",
        projectId: projectBody.id,
        assignee_id: agent.id,
        execution_mode: "create_issue",
        issueTitleTemplate: "Camel {{title}}",
      }),
    });
    const camelProjectAutopilotBody = await camelProjectAutopilot.json();
    expect(camelProjectAutopilot.status).toBe(201);
    expect(camelProjectAutopilotBody.workspace_id).toBe("local");
    expect(camelProjectAutopilotBody.project_id).toBeNull();
    expect(camelProjectAutopilotBody.issue_title_template).toBeNull();

    const camelAutopilotUpdate = await app.request(`/api/autopilots/${camelProjectAutopilotBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: projectBody.id,
        executionMode: "run_only",
        issueTitleTemplate: "Updated {{title}}",
      }),
    });
    const camelAutopilotUpdateBody = await camelAutopilotUpdate.json();
    expect(camelAutopilotUpdate.status).toBe(200);
    expect(camelAutopilotUpdateBody.project_id).toBeNull();
    expect(camelAutopilotUpdateBody.execution_mode).toBe("create_issue");
    expect(camelAutopilotUpdateBody.issue_title_template).toBeNull();

    const run = await app.request(`/api/autopilots/${autopilotBody.id}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Run original autopilot" }),
    });
    const runBody = await run.json();
    expect(run.status).toBe(200);
    expect(runBody.source).toBe("manual");
    expect(runBody.autopilot_id).toBe(autopilotBody.id);
    expect(runBody.trigger_payload).toBeNull();
    expect(runBody.autopilotId).toBeUndefined();

    const runsBody = await (await app.request(`/api/autopilots/${autopilotBody.id}/runs`)).json();
    expect(runsBody.runs[0]).toMatchObject({ id: runBody.id, autopilot_id: autopilotBody.id, trigger_payload: null });
    expect(runsBody.total).toBe(1);

    const runDetailBody = await (await app.request(`/api/autopilots/${autopilotBody.id}/runs/${runBody.id}`)).json();
    expect(runDetailBody.id).toBe(runBody.id);
    expect(runDetailBody.trigger_payload).toBeNull();

    const trigger = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook", label: "Original Webhook" }),
    });
    const triggerBody = await trigger.json();
    expect(trigger.status).toBe(201);
    expect(triggerBody.autopilot_id).toBe(autopilotBody.id);
    expect(triggerBody.webhook_token).toStartWith("awt_");
    expect(triggerBody.webhook_path).toBe(`/api/webhooks/autopilots/${triggerBody.webhook_token}`);
    expect(triggerBody.provider).toBe("generic");
    expect(triggerBody.has_signing_secret).toBe(false);
    expect(triggerBody.signing_secret_hint).toBeNull();
    expect(triggerBody.autopilotId).toBeUndefined();

    const camelWebhookFilters = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook", label: "Camel Filters", eventFilters: [{ event: "push" }] }),
    });
    expect(camelWebhookFilters.status).toBe(201);
    expect((await camelWebhookFilters.json()).event_filters).toBeUndefined();

    const camelWebhookFilterPatch = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${triggerBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventFilters: [{ event: "push" }] }),
    });
    expect(camelWebhookFilterPatch.status).toBe(200);
    expect((await camelWebhookFilterPatch.json()).event_filters).toBeUndefined();

    const invalidTriggerKind = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "api" }),
    });
    expect(invalidTriggerKind.status).toBe(400);
    expect(await invalidTriggerKind.json()).toEqual({ error: "kind must be schedule or webhook" });

    const webhookTimezone = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook", timezone: "UTC" }),
    });
    expect(webhookTimezone.status).toBe(400);
    expect(await webhookTimezone.json()).toEqual({ error: "timezone is not valid for webhook triggers" });

    const scheduleProvider = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "schedule", cron_expression: "*/5 * * * *", provider: "generic" }),
    });
    expect(scheduleProvider.status).toBe(400);
    expect(await scheduleProvider.json()).toEqual({ error: "provider is only valid for webhook triggers" });

    const invalidProvider = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook", provider: "slack" }),
    });
    expect(invalidProvider.status).toBe(400);
    expect(await invalidProvider.json()).toEqual({ error: "provider must be generic or github" });

    const camelSchedule = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "schedule", cronExpression: "*/5 * * * *" }),
    });
    expect(camelSchedule.status).toBe(400);
    expect(await camelSchedule.json()).toEqual({ error: "cron_expression is required for schedule triggers" });

    const schedule = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "schedule", cron_expression: "*/5 * * * *", timezone: "UTC", label: "Every 5" }),
    });
    const scheduleBody = await schedule.json();
    expect(schedule.status).toBe(201);
    expect(scheduleBody.provider).toBeNull();
    expect(scheduleBody.next_run_at).toBeString();

    const camelSchedulePatch = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${scheduleBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cronExpression: "*/10 * * * *" }),
    });
    const camelSchedulePatchBody = await camelSchedulePatch.json();
    expect(camelSchedulePatch.status).toBe(200);
    expect(camelSchedulePatchBody.cron_expression).toBe("*/5 * * * *");

    const scheduleEventFilters = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${scheduleBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_filters: [{ event: "push" }] }),
    });
    expect(scheduleEventFilters.status).toBe(400);
    expect(await scheduleEventFilters.json()).toEqual({ error: "event_filters is only valid for webhook triggers" });

    const rotateSchedule = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${scheduleBody.id}/rotate-webhook-token`, { method: "POST" });
    expect(rotateSchedule.status).toBe(400);
    expect(await rotateSchedule.json()).toEqual({ error: "trigger is not a webhook trigger" });

    const signSchedule = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${scheduleBody.id}/signing-secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signing_secret: "0123456789abcdef" }),
    });
    expect(signSchedule.status).toBe(400);
    expect(await signSchedule.json()).toEqual({ error: "trigger is not a webhook trigger" });

    const webhookCronPatch = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${triggerBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expression: "*/5 * * * *" }),
    });
    expect(webhookCronPatch.status).toBe(400);
    expect(await webhookCronPatch.json()).toEqual({ error: "cron_expression is only valid for schedule triggers" });

    const shortSecret = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${triggerBody.id}/signing-secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signing_secret: "short" }),
    });
    expect(shortSecret.status).toBe(400);
    expect(await shortSecret.json()).toEqual({ error: "signing_secret must be at least 16 characters" });

    const signingSecret = "0123456789abcdef";
    const signedTrigger = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${triggerBody.id}/signing-secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signing_secret: signingSecret }),
    });
    const signedTriggerBody = await signedTrigger.json();
    expect(signedTrigger.status).toBe(200);
    expect(signedTriggerBody.has_signing_secret).toBe(true);
    expect(signedTriggerBody.signing_secret_hint).toBe("cdef");

    const missingSignatureWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Missing signature" }),
    });
    expect(missingSignatureWebhook.status).toBe(401);
    expect(await missingSignatureWebhook.json()).toMatchObject({ status: "rejected", reason: "missing_signature" });

    const signedPayload = JSON.stringify({ prompt: "Signed original autopilot" });
    const signedSignature = `sha256=${createHmac("sha256", signingSecret).update(signedPayload).digest("hex")}`;
    const signedWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signedSignature, "Idempotency-Key": "original-signed" },
      body: signedPayload,
    });
    expect(signedWebhook.status).toBe(200);
    expect(await signedWebhook.json()).toMatchObject({
      status: "accepted",
      autopilot_id: autopilotBody.id,
      trigger_id: triggerBody.id,
      delivery_id: expect.any(String),
      run_id: expect.any(String),
    });

    const triggerDetail = await app.request(`/api/autopilots/${autopilotBody.id}`);
    const triggerDetailBody = await triggerDetail.json();
    expect(triggerDetailBody.triggers[0].id).toBe(triggerBody.id);
    expect(triggerDetailBody.triggers[0].autopilotId).toBeUndefined();

    expect((await app.request(`/api/projects/${projectBody.id}/resources/${resourceBody.id}`, { method: "DELETE" })).status).toBe(204);
    const missingCompatibilityDelete = await app.request(`/api/projects/${projectBody.id}/resources/${resourceBody.id}`, { method: "DELETE" });
    expect(missingCompatibilityDelete.status).toBe(404);
    expect(await missingCompatibilityDelete.json()).toEqual({ error: "project resource not found" });
    expect((await app.request(`/api/squads/${squadBody.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/api/autopilots/${autopilotBody.id}`, { method: "DELETE" })).status).toBe(204);
    const deletedProject = await app.request(`/api/projects/${projectBody.id}`, { method: "DELETE" });
    expect(deletedProject.status).toBe(204);
    expect(events.find((event) => event.type === "project:deleted")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: { project_id: projectBody.id },
    });
    const missingProjectDelete = await app.request("/api/projects/missing-project", { method: "DELETE" });
    expect(missingProjectDelete.status).toBe(404);
    expect(await missingProjectDelete.json()).toEqual({ error: "project not found" });
  });

  it("serves issue metadata endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Metadata API" });

    const set = await app.request(`/api/multiremi/issues/${issue.id}/metadata/pipeline_status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "waiting_review" }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()).metadata.pipeline_status).toBe("waiting_review");

    const listed = await app.request(`/api/multiremi/issues/${issue.id}/metadata`);
    expect((await listed.json()).metadata).toEqual({ pipeline_status: "waiting_review" });

    const other = store.createIssue({ title: "Other Metadata API" });
    store.setIssueMetadataKey(other.id, "pipeline_status", "done");
    const filtered = await app.request(`/api/issues?metadata=${encodeURIComponent(JSON.stringify({ pipeline_status: "waiting_review" }))}`);
    expect((await filtered.json()).issues.map((item: any) => item.id)).toEqual([issue.id]);

    const deleted = await app.request(`/api/multiremi/issues/${issue.id}/metadata/pipeline_status`, { method: "DELETE" });
    expect((await deleted.json()).metadata).toEqual({});
  });

  it("serves issue label endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Label API", workspaceId: "local" });

    const created = await app.request("/api/multiremi/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Review", color: "3399FF", workspace_id: "local" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.label.color).toBe("#3399ff");

    const listed = await app.request("/api/multiremi/labels?workspaceId=local");
    expect((await listed.json()).total).toBe(1);

    const updated = await app.request(`/api/labels/${createdBody.label.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reviewed", color: "#22aa66" }),
    });
    const updatedBody = await updated.json();
    expect(updatedBody.name).toBe("Reviewed");
    expect(updatedBody.workspace_id).toBe("local");
    expect(updatedBody.workspaceId).toBeUndefined();

    const compatibilityDetail = await app.request(`/api/labels/${createdBody.label.id}`);
    const compatibilityDetailBody = await compatibilityDetail.json();
    expect(compatibilityDetailBody).toMatchObject({ id: createdBody.label.id, name: "Reviewed", workspace_id: "local" });
    expect(compatibilityDetailBody.label).toBeUndefined();

    const compatibilityList = await app.request("/api/labels?workspace_id=local");
    const compatibilityListBody = await compatibilityList.json();
    expect(compatibilityListBody.labels[0].workspace_id).toBe("local");
    expect(compatibilityListBody.labels[0].workspaceId).toBeUndefined();

    const remoteLabel = store.createLabel({ name: "Remote Label", color: "#112244", workspaceId: "remote" });
    const camelWorkspaceLabelList = await app.request("/api/labels?workspaceId=remote");
    const camelWorkspaceLabelListBody = await camelWorkspaceLabelList.json();
    expect(camelWorkspaceLabelListBody.labels.some((label: any) => label.id === remoteLabel.id)).toBe(false);
    const snakeWorkspaceLabelList = await app.request("/api/labels?workspace_id=remote");
    const snakeWorkspaceLabelListBody = await snakeWorkspaceLabelList.json();
    expect(snakeWorkspaceLabelListBody.labels.map((label: any) => label.id)).toEqual([remoteLabel.id]);

    const camelWorkspaceLabel = await app.request("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Camel Workspace", color: "#445566", workspaceId: "remote" }),
    });
    const camelWorkspaceLabelBody = await camelWorkspaceLabel.json();
    expect(camelWorkspaceLabel.status).toBe(201);
    expect(camelWorkspaceLabelBody.workspace_id).toBe("local");

    const attached = await app.request(`/api/issues/${issue.id}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label_id: createdBody.label.id }),
    });
    expect(attached.status).toBe(200);
    const attachedBody = await attached.json();
    expect(attachedBody.labels[0].name).toBe("Reviewed");
    expect(attachedBody.labels[0].workspace_id).toBe("local");
    expect(attachedBody.labels[0].workspaceId).toBeUndefined();
    expect(attachedBody.total).toBeUndefined();

    const detail = await app.request(`/api/multiremi/issues/${issue.id}`);
    expect((await detail.json()).issue.labels[0].color).toBe("#22aa66");

    const issueLabels = await app.request(`/api/issues/${issue.id}/labels`);
    const issueLabelsBody = await issueLabels.json();
    expect(issueLabelsBody.labels[0].workspace_id).toBe("local");
    expect(issueLabelsBody.total).toBeUndefined();

    const missingLabelId = await app.request(`/api/issues/${issue.id}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingLabelId.status).toBe(400);
    expect(await missingLabelId.json()).toEqual({ error: "label_id is required" });

    const camelLabelId = await app.request(`/api/issues/${issue.id}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelId: createdBody.label.id }),
    });
    expect(camelLabelId.status).toBe(400);
    expect(await camelLabelId.json()).toEqual({ error: "label_id is required" });

    const invalidLabelJson = await app.request("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidLabelJson.status).toBe(400);
    expect(await invalidLabelJson.json()).toEqual({ error: "invalid request body" });
    const missingName = await app.request("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: "#112233" }),
    });
    expect(missingName.status).toBe(400);
    expect(await missingName.json()).toEqual({ error: "name is required" });
    const invalidColor = await app.request("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Invalid color", color: "blue" }),
    });
    expect(invalidColor.status).toBe(400);
    expect(await invalidColor.json()).toEqual({ error: "color must be a 6-digit hex value like #3b82f6" });
    const duplicate = await app.request("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reviewed", color: "#334455" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "a label with that name already exists" });

    const detached = await app.request(`/api/issues/${issue.id}/labels/${createdBody.label.id}`, {
      method: "DELETE",
    });
    expect((await detached.json()).labels).toHaveLength(0);
    const deleted = await app.request(`/api/labels/${createdBody.label.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const missing = await app.request(`/api/labels/${createdBody.label.id}`);
    expect(missing.status).toBe(404);
  });

  it("serves direct skill PUT compatibility endpoint", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const skill = store.createSkill({ name: "api-skill", content: "# API Skill" });

    const updated = await app.request(`/api/skills/${skill.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated through direct PUT" }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).description).toBe("Updated through direct PUT");
  });

  it("serves pinned item endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Pinned API issue", workspaceId: "local" });
    const project = store.createProject({ title: "Pinned API project", workspaceId: "local" });

    const issuePin = await app.request("/api/multiremi/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemType: "issue", itemId: issue.id, workspaceId: "local", userId: "local" }),
    });
    expect(issuePin.status).toBe(201);
    const issuePinBody = await issuePin.json();
    expect(issuePinBody.pin.itemType).toBe("issue");

    const projectPin = await app.request("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_type: "project", item_id: project.id, workspace_id: "local", user_id: "local" }),
    });
    expect(projectPin.status).toBe(201);
    const projectPinBody = await projectPin.json();
    expect(projectPinBody).toMatchObject({
      item_type: "project",
      item_id: project.id,
      workspace_id: "local",
      user_id: "local",
      position: 2,
    });
    expect(projectPinBody.itemType).toBeUndefined();

    const camelPin = await app.request("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemType: "project", itemId: project.id, workspaceId: "local", userId: "local" }),
    });
    expect(camelPin.status).toBe(400);
    expect(await camelPin.json()).toEqual({ error: "item_type must be 'issue' or 'project'" });

    const listed = await app.request("/api/multiremi/pins?workspaceId=local&userId=local");
    expect((await listed.json()).pins).toHaveLength(2);

    const compatibilityList = await app.request("/api/pins?workspace_id=local&user_id=local");
    const compatibilityListBody = await compatibilityList.json();
    expect(compatibilityListBody).toHaveLength(2);
    expect(compatibilityListBody[0].workspaceId).toBeUndefined();

    const reordered = await app.request("/api/pins/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        user_id: "local",
        items: [
          { id: issuePinBody.pin.id, position: 2 },
          { id: projectPinBody.id, position: 1 },
        ],
      }),
    });
    expect((await reordered.json()).map((pin: any) => pin.id)).toEqual([projectPinBody.id, issuePinBody.pin.id]);

    const deleted = await app.request(`/api/pins/project/${project.id}?workspace_id=local&user_id=local`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(store.listPinnedItems("local", "local")).toHaveLength(1);
  });

  it("serves issue and project search endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Searchable API issue", description: "Has api needle context", workspaceId: "local" });
    const closedIssue = store.createIssue({ title: "Closed API issue", description: "closed needle", workspaceId: "local" });
    store.updateIssue(closedIssue.id, { status: "done" });
    const commentedIssue = store.createIssue({ title: "Comment API issue", description: "No matching body", workspaceId: "local", createdBy: "api-user" });
    store.createIssueComment(commentedIssue.id, { authorType: "member", body: "Fresh comment needle context" });
    const remoteIssue = store.createIssue({ title: "Remote Issue Needle", description: "Remote issue needle", workspaceId: "remote" });
    store.createProject({ title: "Searchable API project", description: "No needle", workspaceId: "local" });
    store.createProject({ title: "Other project", description: "Project needle context", workspaceId: "local" });
    const closedProject = store.createProject({ title: "Closed Project", description: "Closed project needle", status: "cancelled", workspaceId: "local" });
    const remoteProject = store.createProject({ title: "Remote Project Needle", description: "Remote project needle", workspaceId: "remote" });

    const byTitle = await app.request("/api/multiremi/issues/search?q=searchable%20api&workspaceId=local");
    expect(byTitle.status).toBe(200);
    const byTitleBody = await byTitle.json();
    expect(byTitleBody.issues[0].id).toBe(issue.id);
    expect(byTitleBody.issues[0].matchSource).toBe("title");

    const invalidIssueSearch = await app.request("/api/issues/search?workspace_id=local");
    expect(invalidIssueSearch.status).toBe(400);
    expect(await invalidIssueSearch.json()).toEqual({ error: "q parameter is required" });

    const compatIssueSearch = await app.request("/api/issues/search?q=comment%20needle&workspace_id=local&include_closed=true&limit=1");
    const compatIssueBody = await compatIssueSearch.json();
    expect(compatIssueBody.issues).toHaveLength(1);
    expect(compatIssueSearch.headers.get("X-Total-Count")).toBe(String(compatIssueBody.total));
    expect(compatIssueBody.total).toBe(1);
    expect(compatIssueBody.issues[0]).toMatchObject({
      id: commentedIssue.id,
      workspace_id: "local",
      identifier: commentedIssue.key,
      creator_type: "member",
      creator_id: "api-user",
      match_source: "comment",
    });
    expect(compatIssueBody.issues[0].matched_snippet).toContain("needle");
    expect(compatIssueBody.issues[0].matched_comment_snippet).toContain("needle");
    expect(compatIssueBody.issues[0].workspaceId).toBeUndefined();
    expect(compatIssueBody.issues[0].matchSource).toBeUndefined();
    expect(compatIssueBody.issues[0].matchedCommentSnippet).toBeUndefined();

    const camelClosedIssueSearch = await app.request("/api/issues/search?q=closed%20needle&workspace_id=local&includeClosed=true");
    expect((await camelClosedIssueSearch.json()).total).toBe(0);
    const snakeClosedIssueSearch = await app.request("/api/issues/search?q=closed%20needle&workspace_id=local&include_closed=true");
    const snakeClosedIssueBody = await snakeClosedIssueSearch.json();
    expect(snakeClosedIssueBody.issues[0].id).toBe(closedIssue.id);

    const camelRemoteIssueSearch = await app.request("/api/issues/search?q=remote%20issue%20needle&workspaceId=remote");
    expect((await camelRemoteIssueSearch.json()).total).toBe(0);
    const snakeRemoteIssueSearch = await app.request("/api/issues/search?q=remote%20issue%20needle&workspace_id=remote");
    const snakeRemoteIssueBody = await snakeRemoteIssueSearch.json();
    expect(snakeRemoteIssueBody.issues[0].id).toBe(remoteIssue.id);

    const invalidProjectSearch = await app.request("/api/projects/search?workspace_id=local");
    expect(invalidProjectSearch.status).toBe(400);
    expect(await invalidProjectSearch.json()).toEqual({ error: "q parameter is required" });

    const projectSearch = await app.request("/api/projects/search?q=project%20needle&workspace_id=local");
    const projectBody = await projectSearch.json();
    expect(projectSearch.headers.get("X-Total-Count")).toBe(String(projectBody.total));
    expect(projectBody.projects[0].match_source).toBe("description");
    expect(projectBody.projects[0].matched_snippet).toContain("needle");
    expect(projectBody.projects[0].workspace_id).toBe("local");
    expect(projectBody.projects[0].matchSource).toBeUndefined();
    expect(projectBody.projects[0].matchedSnippet).toBeUndefined();

    const camelClosedProjectSearch = await app.request("/api/projects/search?q=closed%20project%20needle&workspace_id=local&includeClosed=true");
    expect((await camelClosedProjectSearch.json()).total).toBe(0);
    const snakeClosedProjectSearch = await app.request("/api/projects/search?q=closed%20project%20needle&workspace_id=local&include_closed=true");
    const snakeClosedProjectBody = await snakeClosedProjectSearch.json();
    expect(snakeClosedProjectBody.projects[0].id).toBe(closedProject.id);

    const camelRemoteProjectSearch = await app.request("/api/projects/search?q=remote%20project%20needle&workspaceId=remote");
    expect((await camelRemoteProjectSearch.json()).total).toBe(0);
    const snakeRemoteProjectSearch = await app.request("/api/projects/search?q=remote%20project%20needle&workspace_id=remote");
    const snakeRemoteProjectBody = await snakeRemoteProjectSearch.json();
    expect(snakeRemoteProjectBody.projects[0].id).toBe(remoteProject.id);
  });

  it("serves issue subscribers and member inbox endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorType?: string; actorId?: string | null }> = [];
    store.onWorkspaceEvent((event) => events.push(event));
    const alice = store.createWorkspaceMember({ name: "Alice API" });
    const bob = store.createWorkspaceMember({ name: "Bob API" });
    const issue = store.createIssue({ title: "Inbox API", createdBy: alice.id });

    const subscribed = await app.request(`/api/multiremi/issues/${issue.id}/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: bob.id, reason: "manual" }),
    });
    expect(subscribed.status).toBe(201);
    expect((await subscribed.json()).subscriber.memberId).toBe(bob.id);

    const subscribers = await app.request(`/api/multiremi/issues/${issue.id}/subscribers`);
    expect((await subscribers.json()).subscribers.map((subscriber: any) => subscriber.memberId).sort()).toEqual([
      alice.id,
      bob.id,
    ].sort());
    const compatibilitySubscribers = await app.request(`/api/issues/${issue.id}/subscribers`);
    const compatibilitySubscribersBody = await compatibilitySubscribers.json();
    expect(compatibilitySubscribersBody.map((subscriber: any) => subscriber.user_id).sort()).toEqual([
      alice.id,
      bob.id,
    ].sort());
    expect(compatibilitySubscribersBody[0].memberId).toBeUndefined();
    expect(compatibilitySubscribersBody[0]).toMatchObject({
      issue_id: issue.id,
      user_type: "member",
    });

    const charlie = store.createWorkspaceMember({ name: "Charlie API" });
    const camelSubscribe = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: charlie.id, userType: "member" }),
    });
    expect(camelSubscribe.status).toBe(403);
    expect(await camelSubscribe.json()).toEqual({ error: "target user is not a member of this workspace" });
    const afterCamelSubscribe = await (await app.request(`/api/issues/${issue.id}/subscribers`)).json();
    expect(afterCamelSubscribe.some((subscriber: any) =>
      subscriber.user_id === charlie.id && subscriber.user_type === "member"
    )).toBe(false);

    const goSubscribe = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: charlie.id, user_type: "member" }),
    });
    expect(await goSubscribe.json()).toEqual({ subscribed: true });
    const goSubscribers = await (await app.request(`/api/issues/${issue.id}/subscribers`)).json();
    expect(goSubscribers.some((subscriber: any) => subscriber.user_id === charlie.id && subscriber.user_type === "member")).toBe(true);
    expect(events.some((event) =>
      event.type === "subscriber:added"
      && event.payload.issue_id === issue.id
      && event.payload.user_type === "member"
      && event.payload.user_id === charlie.id
    )).toBe(true);

    const runtime = store.registerRuntime({ id: "rt_subscriber_agent", provider: "codex", name: "Subscriber agent runtime" });
    const agent = store.createAgent({ name: "Subscriber Agent", provider: "codex", runtimeId: runtime.id });
    const agentSubscribe = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: agent.id, user_type: "agent" }),
    });
    expect(agentSubscribe.status).toBe(200);
    expect(await agentSubscribe.json()).toEqual({ subscribed: true });
    const typedSubscribers = await (await app.request(`/api/issues/${issue.id}/subscribers`)).json();
    const agentSubscriber = typedSubscribers.find((subscriber: any) => subscriber.user_id === agent.id);
    expect(agentSubscriber).toMatchObject({
      issue_id: issue.id,
      user_type: "agent",
      user_id: agent.id,
      reason: "manual",
    });
    expect(agentSubscriber.memberId).toBeUndefined();
    expect(store.listIssueSubscribers(issue.id).find((subscriber) => subscriber.userId === agent.id)?.userType).toBe("agent");

    const unsupportedSubscriber = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "agt_missing_subscriber", user_type: "agent" }),
    });
    expect(unsupportedSubscriber.status).toBe(403);
    expect(await unsupportedSubscriber.json()).toEqual({ error: "target user is not a member of this workspace" });
    const unsupportedSquadSubscriber = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "sqd_subscriber", user_type: "squad" }),
    });
    expect(unsupportedSquadSubscriber.status).toBe(403);
    expect(await unsupportedSquadSubscriber.json()).toEqual({ error: "target user is not a member of this workspace" });
    const goAgentUnsubscribe = await app.request(`/api/issues/${issue.id}/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: agent.id, user_type: "agent" }),
    });
    expect(await goAgentUnsubscribe.json()).toEqual({ subscribed: false });
    expect((await (await app.request(`/api/issues/${issue.id}/subscribers`)).json()).some((subscriber: any) =>
      subscriber.user_id === agent.id && subscriber.user_type === "agent"
    )).toBe(false);
    expect(events.some((event) =>
      event.type === "subscriber:removed"
      && event.payload.issue_id === issue.id
      && event.payload.user_type === "agent"
      && event.payload.user_id === agent.id
    )).toBe(true);
    const goUnsubscribe = await app.request(`/api/issues/${issue.id}/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: charlie.id, user_type: "member" }),
    });
    expect(await goUnsubscribe.json()).toEqual({ subscribed: false });

    const commented = await app.request(`/api/multiremi/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorType: "member", authorId: alice.id, body: "Can you check this?" }),
    });
    expect(commented.status).toBe(201);

    const inbox = await app.request(`/api/multiremi/inbox?memberId=${encodeURIComponent(bob.id)}`);
    const inboxBody = await inbox.json();
    expect(inboxBody.unread).toBe(1);
    expect(inboxBody.items[0].issue.key).toBe(issue.key);

    const read = await app.request(`/api/multiremi/inbox/${inboxBody.items[0].id}/read`, { method: "POST" });
    expect((await read.json()).item.read).toBe(true);

    const archived = await app.request(`/api/multiremi/inbox/${inboxBody.items[0].id}/archive`, { method: "POST" });
    expect((await archived.json()).item.archived).toBe(true);

    const afterArchive = await app.request(`/api/multiremi/inbox?memberId=${encodeURIComponent(bob.id)}`);
    expect((await afterArchive.json()).items).toHaveLength(0);
  });

  it("serves original agent, skill file, chat, and inbox compatibility endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const alice = store.createWorkspaceMember({ name: "Original Alice" });
    const bob = store.createWorkspaceMember({ name: "Original Bob" });
    const runtime = store.registerRuntime({ id: "rt_original_compat", name: "Original runtime", provider: "codex" });

    const createdAgent = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Original Codex",
        provider: "codex",
        runtime_id: runtime.id,
        custom_env: { SECRET_TOKEN: "real-value" },
        custom_args: ["--sandbox"],
        mcp_config: { mcpServers: { local: { command: "secret-command" } } },
        thinking_level: "high",
      }),
    });
    const agent = await createdAgent.json();
    expect(createdAgent.status).toBe(201);
    expect(agent.provider).toBe("codex");
    expect(store.getAgent(agent.id)?.provider).toBe("codex");
    expect(Object.keys(agent).filter((key) => /[A-Z]/.test(key))).toEqual([]);
    expect(agent).toMatchObject({
      workspace_id: "local",
      runtime_id: "",
      max_concurrent_tasks: 6,
      has_custom_env: true,
      custom_env_key_count: 1,
      custom_args: ["--sandbox"],
      thinking_level: "high",
      skills: [],
    });
    expect(agent.custom_env).toBeUndefined();
    expect(agent.customEnv).toBeUndefined();
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value" });

    const envThroughGenericUpdate = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_env: { ROTATED_TOKEN: "new-value" }, custom_args: ["--updated"], thinking_level: "low" }),
    });
    expect(envThroughGenericUpdate.status).toBe(400);
    expect(await envThroughGenericUpdate.json()).toEqual({
      error: "custom_env is no longer accepted on this endpoint; use PUT /api/agents/{id}/env (or `multiremi agent env set`)",
    });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value" });

    const updatedAgent = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_args: ["--updated"], thinking_level: "low" }),
    });
    const updatedAgentBody = await updatedAgent.json();
    expect(updatedAgentBody).toMatchObject({
      id: agent.id,
      has_custom_env: true,
      custom_env_key_count: 1,
      custom_args: ["--updated"],
      thinking_level: "low",
    });
    expect(updatedAgentBody.custom_env).toBeUndefined();
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value" });

    const updatedEnv = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_env: { SECRET_TOKEN: "****", ROTATED_TOKEN: "new-value" } }),
    });
    expect(updatedEnv.status).toBe(200);
    expect((await updatedEnv.json()).custom_env).toEqual({ SECRET_TOKEN: "real-value", ROTATED_TOKEN: "new-value" });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value", ROTATED_TOKEN: "new-value" });

    const archived = await app.request(`/api/agents/${agent.id}/archive`, { method: "POST" });
    expect((await archived.json()).archived_at).toBeString();
    const restored = await app.request(`/api/agents/${agent.id}/restore`, { method: "POST" });
    expect((await restored.json()).archived_at).toBeNull();

    const skill = store.createSkill({ name: "Original Skill", content: "# Skill" });
    const missingSkillFiles = await app.request("/api/skills/skl_missing/files");
    expect(missingSkillFiles.status).toBe(404);
    expect(await missingSkillFiles.json()).toEqual({ error: "skill not found" });

    const invalidFileJson = await app.request(`/api/skills/${skill.id}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidFileJson.status).toBe(400);
    expect(await invalidFileJson.json()).toEqual({ error: "invalid request body" });

    const invalidFilePath = await app.request(`/api/skills/${skill.id}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "../../../escape.md", content: "Nope" }),
    });
    expect(invalidFilePath.status).toBe(400);
    expect(await invalidFilePath.json()).toEqual({ error: "invalid file path" });

    const reservedFilePath = await app.request(`/api/skills/${skill.id}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "SKILL.md", content: "Nope" }),
    });
    expect(reservedFilePath.status).toBe(400);
    expect(await reservedFilePath.json()).toEqual({ error: "SKILL.md is reserved for the primary skill content" });

    const file = await app.request(`/api/skills/${skill.id}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/check.md", content: "Check" }),
    });
    const fileBody = await file.json();
    expect(fileBody.path).toBe("notes/check.md");
    expect(fileBody.skill_id).toBe(skill.id);
    expect(fileBody.skillId).toBeUndefined();
    const files = await app.request(`/api/skills/${skill.id}/files`);
    const filesBody = await files.json();
    expect(filesBody[0].content).toBe("Check");
    expect(filesBody[0].skill_id).toBe(skill.id);

    const chat = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, title: "Original chat" }),
    });
    const chatBody = await chat.json();
    expect(chatBody.agent_id).toBe(agent.id);
    const sent = await app.request(`/api/chat/sessions/${chatBody.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hello original" }),
    });
    const sentBody = await sent.json();
    expect(Object.keys(sentBody).sort()).toEqual(["created_at", "message_id", "task_id"]);
    expect(store.getTask(sentBody.task_id)?.chatSessionId).toBe(chatBody.id);
    const pending = await app.request(`/api/chat/sessions/${chatBody.id}/pending-task`);
    expect((await pending.json()).task_id).toBe(sentBody.task_id);
    const pendingAll = await app.request("/api/chat/pending-tasks");
    expect((await pendingAll.json()).tasks[0].chat_session_id).toBe(chatBody.id);
    expect((await app.request(`/api/chat/sessions/${chatBody.id}/read`, { method: "POST" })).status).toBe(204);

    const issue = store.createIssue({ title: "Original inbox", createdBy: alice.id });
    store.addIssueSubscriber(issue.id, bob.id);
    store.createIssueComment(issue.id, { authorType: "member", authorId: alice.id, body: "Ping Bob" });
    const camelInbox = await app.request(`/api/inbox?memberId=${encodeURIComponent(bob.id)}`);
    expect(await camelInbox.json()).toEqual([]);
    expect((await (await app.request(`/api/inbox/unread-count?memberId=${encodeURIComponent(bob.id)}`)).json()).count).toBe(0);
    const inbox = await app.request(`/api/inbox?member_id=${encodeURIComponent(bob.id)}`);
    const inboxBody = await inbox.json();
    expect(inboxBody[0].member_id).toBe(bob.id);
    expect((await (await app.request(`/api/inbox/unread-count?member_id=${encodeURIComponent(bob.id)}`)).json()).count).toBe(1);
    expect((await (await app.request(`/api/inbox/mark-all-read?member_id=${encodeURIComponent(bob.id)}`, { method: "POST" })).json()).count).toBe(1);
    expect((await (await app.request(`/api/inbox/archive-all-read?member_id=${encodeURIComponent(bob.id)}`, { method: "POST" })).json()).count).toBe(1);
    expect((await app.request(`/api/chat/sessions/${chatBody.id}`, { method: "DELETE" })).status).toBe(204);

    expect((await app.request(`/api/skills/${skill.id}/files/${fileBody.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await (await app.request(`/api/agents/${agent.id}/cancel-tasks`, { method: "POST" })).json()).cancelled).toBe(0);
  });

  it("serves comment threads, reactions, and attachments through API", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "API collaboration" });

    const issueAttachment = await app.request(`/api/multiremi/issues/${issue.id}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "design.png",
        url: "https://example.com/design.png",
        contentType: "image/png",
        sizeBytes: 1024,
        uploaderType: "member",
        uploaderId: "local",
      }),
    });
    expect(issueAttachment.status).toBe(201);
    const issueAttachmentBody = await issueAttachment.json();
    expect(issueAttachmentBody.attachment.issueId).toBe(issue.id);

    const root = await app.request(`/api/multiremi/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Root API comment" }),
    });
    const rootBody = await root.json();
    const originalComment = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Original API comment" }),
    });
    const originalCommentBody = await originalComment.json();
    expect(originalComment.status).toBe(201);
    expect(originalCommentBody.content).toBe("Original API comment");
    expect(originalCommentBody.issue_id).toBe(issue.id);
    expect(originalCommentBody.body).toBeUndefined();
    expect(originalCommentBody.issueId).toBeUndefined();
    expect(originalCommentBody.comment).toBeUndefined();

    const pendingAttachment = store.createAttachment({
      filename: "reply.md",
      url: "https://example.com/reply.md",
      uploaderType: "member",
      uploaderId: "local",
    });
    const reply = await app.request(`/api/multiremi/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Reply API comment", parentId: rootBody.comment.id, attachmentIds: [pendingAttachment.id] }),
    });
    const replyBody = await reply.json();
    expect(replyBody.comment.parentId).toBe(rootBody.comment.id);
    expect(replyBody.comment.attachments[0].id).toBe(pendingAttachment.id);

    const edited = await app.request(`/api/comments/${replyBody.comment.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Edited API reply" }),
    });
    const editedBody = await edited.json();
    expect(editedBody.content).toBe("Edited API reply");
    expect(editedBody.comment).toBeUndefined();
    expect(editedBody.body).toBeUndefined();
    expect(editedBody.parent_id).toBe(rootBody.comment.id);
    expect(editedBody.parentId).toBeUndefined();

    const invalidCommentCreate = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCommentCreate.status).toBe(400);
    expect(await invalidCommentCreate.json()).toEqual({ error: "invalid request body" });

    const emptyCommentCreate = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(emptyCommentCreate.status).toBe(400);
    expect(await emptyCommentCreate.json()).toEqual({ error: "content is required" });

    const resolved = await app.request(`/api/multiremi/comments/${rootBody.comment.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorType: "member", actorId: "local" }),
    });
    expect((await resolved.json()).comment.resolvedAt).toBeString();

    const unresolved = await app.request(`/api/comments/${rootBody.comment.id}/resolve`, { method: "DELETE" });
    const unresolvedBody = await unresolved.json();
    expect(unresolvedBody.resolved_at).toBeNull();
    expect(unresolvedBody.comment).toBeUndefined();
    expect(unresolvedBody.resolvedAt).toBeUndefined();

    const compatibilityResolved = await app.request(`/api/comments/${rootBody.comment.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_type: "member", actor_id: "local" }),
    });
    const compatibilityResolvedBody = await compatibilityResolved.json();
    expect(compatibilityResolvedBody.resolved_at).toBeString();
    expect(compatibilityResolvedBody.resolved_by_type).toBe("member");
    expect(compatibilityResolvedBody.resolvedByType).toBeUndefined();

    const invalidReplyResolve = await app.request(`/api/comments/${replyBody.comment.id}/resolve`, { method: "POST" });
    expect(invalidReplyResolve.status).toBe(400);
    expect(await invalidReplyResolve.json()).toEqual({ error: "only root comments can be resolved" });

    const issueReaction = await app.request(`/api/multiremi/issues/${issue.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "👍", actor_type: "member", actor_id: "local" }),
    });
    expect((await issueReaction.json()).reaction.emoji).toBe("👍");
    const issueReactions = await (await app.request(`/api/issues/${issue.id}/reactions`)).json();
    expect(issueReactions[0].emoji).toBe("👍");
    expect(issueReactions[0].issueId).toBeUndefined();
    expect(issueReactions[0].issue_id).toBe(issue.id);
    expect(issueReactions[0].actorType).toBeUndefined();
    expect(issueReactions[0].actor_type).toBe("member");
    const originalIssueReaction = await app.request(`/api/issues/${issue.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "🚀", actorType: "member", actorId: "local" }),
    });
    const originalIssueReactionBody = await originalIssueReaction.json();
    expect(originalIssueReaction.status).toBe(201);
    expect(originalIssueReactionBody.issueId).toBeUndefined();
    expect(originalIssueReactionBody.issue_id).toBe(issue.id);
    expect(originalIssueReactionBody.actorType).toBeUndefined();
    expect(originalIssueReactionBody.actor_type).toBe("member");
    const invalidIssueReaction = await app.request(`/api/issues/${issue.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidIssueReaction.status).toBe(400);
    expect(await invalidIssueReaction.json()).toEqual({ error: "invalid request body" });
    const missingIssueEmoji = await app.request(`/api/issues/${issue.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_type: "member", actor_id: "local" }),
    });
    expect(missingIssueEmoji.status).toBe(400);
    expect(await missingIssueEmoji.json()).toEqual({ error: "emoji is required" });
    const metadata = await app.request(`/api/issues/${issue.id}/metadata/original_path`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: true }),
    });
    expect((await metadata.json()).original_path).toBe(true);
    expect((await (await app.request(`/api/issues/${issue.id}/metadata`)).json()).original_path).toBe(true);
    const issueAttachments = await (await app.request(`/api/issues/${issue.id}/attachments`)).json();
    expect(issueAttachments[0].id).toBe(issueAttachmentBody.attachment.id);
    expect(issueAttachments[0].download_url).toBe(`/api/attachments/${issueAttachmentBody.attachment.id}/download`);

    const commentReaction = await app.request(`/api/multiremi/comments/${replyBody.comment.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "👀", actorType: "agent", actorId: "agt-api" }),
    });
    expect((await commentReaction.json()).reaction.emoji).toBe("👀");
    const originalCommentReaction = await app.request(`/api/comments/${replyBody.comment.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "✅", actorType: "member", actorId: "local" }),
    });
    const originalCommentReactionBody = await originalCommentReaction.json();
    expect(originalCommentReactionBody.emoji).toBe("✅");
    expect(originalCommentReactionBody.commentId).toBeUndefined();
    expect(originalCommentReactionBody.comment_id).toBe(replyBody.comment.id);
    expect(originalCommentReactionBody.workspace_id).toBeUndefined();
    expect(originalCommentReactionBody.actorType).toBeUndefined();
    expect(originalCommentReactionBody.actor_type).toBe("member");
    const invalidCommentReaction = await app.request(`/api/comments/${replyBody.comment.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCommentReaction.status).toBe(400);
    expect(await invalidCommentReaction.json()).toEqual({ error: "invalid request body" });
    const missingCommentEmoji = await app.request(`/api/comments/${replyBody.comment.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_type: "member", actor_id: "local" }),
    });
    expect(missingCommentEmoji.status).toBe(400);
    expect(await missingCommentEmoji.json()).toEqual({ error: "emoji is required" });

    const detail = await app.request(`/api/multiremi/issues/${issue.id}`);
    const detailBody = await detail.json();
    expect(detailBody.issue.reactions).toHaveLength(2);
    expect(detailBody.issue.attachments).toHaveLength(1);
    expect(detailBody.comments.find((comment: any) => comment.id === replyBody.comment.id).reactions).toHaveLength(2);

    const timeline = await app.request(`/api/issues/${issue.id}/timeline`);
    const timelineBody = await timeline.json();
    const timelineIds = timelineBody.map((entry: any) => entry.id);
    expect(timelineIds).toContain(rootBody.comment.id);
    expect(timelineIds).toContain(replyBody.comment.id);
    const replyEntry = timelineBody.find((entry: any) => entry.id === replyBody.comment.id);
    expect(replyEntry.actorType).toBeUndefined();
    expect(replyEntry.actor_type).toBe("member");
    expect(replyEntry.parentId).toBeUndefined();
    expect(replyEntry.parent_id).toBe(rootBody.comment.id);
    expect(replyEntry.commentType).toBeUndefined();
    expect(replyEntry.comment_type).toBe("comment");
    expect(replyEntry.attachments[0].id).toBe(pendingAttachment.id);
    expect(replyEntry.attachments[0].commentId).toBeUndefined();
    expect(replyEntry.attachments[0].comment_id).toBe(replyBody.comment.id);
    expect(replyEntry.attachments[0].downloadUrl).toBeUndefined();
    expect(replyEntry.attachments[0].download_url).toBe(`/api/attachments/${pendingAttachment.id}/download`);
    expect(replyEntry.reactions).toHaveLength(2);
    expect(replyEntry.reactions[0].actorType).toBeUndefined();
    expect(replyEntry.reactions[0].actor_type).toBeDefined();
    expect(replyEntry.reactions[0].comment_id).toBe(replyBody.comment.id);
    expect(replyEntry.reactions[0].workspace_id).toBeUndefined();
    for (let index = 1; index < timelineBody.length; index++) {
      expect(timelineBody[index - 1].created_at <= timelineBody[index].created_at).toBe(true);
    }

    const compatibilityWrappedTimeline = await app.request(`/api/issues/${issue.id}/timeline?limit=50&around=${encodeURIComponent(rootBody.comment.id)}`);
    const compatibilityWrappedTimelineBody = await compatibilityWrappedTimeline.json();
    expect(compatibilityWrappedTimelineBody.entries[0].actorType).toBeUndefined();
    expect(compatibilityWrappedTimelineBody.entries[0].actor_type).toBeDefined();
    expect(compatibilityWrappedTimelineBody.entries[compatibilityWrappedTimelineBody.target_index].id).toBe(rootBody.comment.id);

    const wrappedTimeline = await app.request(`/api/multiremi/issues/${issue.id}/timeline?limit=50&around=${encodeURIComponent(rootBody.comment.id)}`);
    const wrappedTimelineBody = await wrappedTimeline.json();
    expect(wrappedTimelineBody.next_cursor).toBeNull();
    expect(wrappedTimelineBody.prev_cursor).toBeNull();
    expect(wrappedTimelineBody.has_more_before).toBe(false);
    expect(wrappedTimelineBody.has_more_after).toBe(false);
    expect(wrappedTimelineBody.entries[0].createdAt).toBeDefined();
    expect(wrappedTimelineBody.entries[wrappedTimelineBody.target_index].id).toBe(rootBody.comment.id);
    for (let index = 1; index < wrappedTimelineBody.entries.length; index++) {
      expect(wrappedTimelineBody.entries[index - 1].created_at >= wrappedTimelineBody.entries[index].created_at).toBe(true);
    }

    const deleteTarget = store.createIssueComment(issue.id, { body: "Compatibility delete target" });
    const compatibilityDeleted = await app.request(`/api/comments/${deleteTarget.id}`, { method: "DELETE" });
    expect(compatibilityDeleted.status).toBe(204);
    expect(await compatibilityDeleted.text()).toBe("");
    const missingDelete = await app.request(`/api/comments/${deleteTarget.id}`, { method: "DELETE" });
    expect(missingDelete.status).toBe(404);
    expect(await missingDelete.json()).toEqual({ error: "comment not found" });

    const deleted = await app.request(`/api/multiremi/comments/${replyBody.comment.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(store.getIssueComment(replyBody.comment.id)).toBeNull();
  });

  it("uploads, downloads, and deletes local attachment files", async () => {
    useUploadDir();
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Upload API" });
    const form = new FormData();
    form.append("file", new File(["hello upload"], "note.txt", { type: "text/plain" }));
    form.append("issue_id", issue.id);
    form.append("workspace_id", "local");

    const uploaded = await app.request("/api/upload-file", {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(200);
    const uploadedBody = await uploaded.json();
    expect(uploadedBody.attachment.issueId).toBe(issue.id);
    expect(uploadedBody.attachment.url).toStartWith("/api/attachments/");
    expect(uploadedBody.issue_id).toBe(issue.id);
    expect(uploadedBody.download_url).toBe(`/api/attachments/${uploadedBody.attachment.id}/download`);
    expect(store.listAttachmentsForIssue(issue.id)[0]?.filename).toBe("note.txt");

    const meta = await app.request(`/api/attachments/${uploadedBody.attachment.id}`);
    const metaBody = await meta.json();
    expect(metaBody.attachment.filename).toBe("note.txt");
    expect(metaBody.download_url).toBe(`/api/attachments/${uploadedBody.attachment.id}/download`);

    const content = await app.request(`/api/attachments/${uploadedBody.attachment.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toContain("text/plain");
    expect(await content.text()).toBe("hello upload");

    const download = await app.request(`/api/attachments/${uploadedBody.attachment.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("note.txt");
    expect(await download.text()).toBe("hello upload");

    const deleted = await app.request(`/api/attachments/${uploadedBody.attachment.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(store.getAttachment(uploadedBody.attachment.id)).toBeNull();

    const missing = await app.request(`/api/attachments/${uploadedBody.attachment.id}/content`);
    expect(missing.status).toBe(404);
  });

  it("enforces Go-style attachment access boundaries", async () => {
    useUploadDir();
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const remoteWorkspace = store.createWorkspace({ id: "ws_att_remote", name: "Att Remote", slug: "att-remote" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "local", name: "Local", role: "owner" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "peer-user", name: "Peer", role: "member" });
    const remoteToken = await store.createAccessToken({ name: "remote", type: "pat", workspaceId: remoteWorkspace.id });
    const localToken = await store.createAccessToken({ name: "local", type: "pat", workspaceId: "local", userId: "local" });
    const peerToken = await store.createAccessToken({ name: "peer", type: "pat", workspaceId: "local", userId: "peer-user" });

    // A token scoped to another workspace gets Go's anti-enumeration 404 across read/serve/delete.
    const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

    // Issue attachment in the local workspace.
    const issue = store.createIssue({ title: "Att issue", workspaceId: "local" });
    const issueForm = new FormData();
    issueForm.append("file", new File(["issue secret"], "issue.txt", { type: "text/plain" }));
    issueForm.append("issue_id", issue.id);
    issueForm.append("workspace_id", "local");
    const issueUpload = await app.request("/api/upload-file", { method: "POST", body: issueForm, ...auth(localToken.token) });
    const issueAttId = (await issueUpload.json()).attachment.id;
    expect((await app.request(`/api/attachments/${issueAttId}`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/attachments/${issueAttId}/content`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/attachments/${issueAttId}/download`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/multiremi/attachments/${issueAttId}`, auth(remoteToken.token))).status).toBe(404);
    const crossDelete = await app.request(`/api/attachments/${issueAttId}`, { method: "DELETE", ...auth(remoteToken.token) });
    expect(crossDelete.status).toBe(404);
    expect(store.getAttachment(issueAttId)).not.toBeNull();

    // A same-workspace token can read the issue attachment.
    const okContent = await app.request(`/api/attachments/${issueAttId}/content`, auth(localToken.token));
    expect(okContent.status).toBe(200);
    expect(await okContent.text()).toBe("issue secret");

    // Chat attachment uploaded by the creator.
    const agent = store.createAgent({ name: "Chat", provider: "claude", workspaceId: "local" });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: "local", title: "Private" });
    const chatForm = new FormData();
    chatForm.append("file", new File(["chat secret"], "chat.txt", { type: "text/plain" }));
    chatForm.append("chat_session_id", chat.id);
    const chatUpload = await app.request("/api/upload-file", { method: "POST", body: chatForm, ...auth(localToken.token) });
    expect(chatUpload.status).toBe(200);
    const chatAttId = (await chatUpload.json()).attachment.id;

    // A different workspace member cannot read another user's private chat attachment.
    expect((await app.request(`/api/attachments/${chatAttId}/content`, auth(peerToken.token))).status).toBe(403);
    expect((await app.request(`/api/attachments/${chatAttId}/download`, auth(peerToken.token))).status).toBe(403);
    expect((await app.request(`/api/attachments/${chatAttId}`, { method: "DELETE", ...auth(peerToken.token) })).status).toBe(403);
    expect(store.getAttachment(chatAttId)).not.toBeNull();

    // The chat creator can read their own attachment.
    const creatorRead = await app.request(`/api/attachments/${chatAttId}/content`, auth(localToken.token));
    expect(creatorRead.status).toBe(200);
    expect(await creatorRead.text()).toBe("chat secret");
  });

  it("enforces Go-style attachment delete authz and listing/upload workspace gates", async () => {
    useUploadDir();
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

    store.createWorkspaceMember({ id: "mem_local_alice", workspaceId: "local", name: "Alice", email: "alice@x.com", role: "member" });
    store.createWorkspaceMember({ id: "mem_local_bob", workspaceId: "local", name: "Bob", email: "bob@x.com", role: "member" });
    store.createWorkspaceMember({ id: "mem_local_carol", workspaceId: "local", name: "Carol", email: "carol@x.com", role: "admin" });
    const aliceToken = await store.createAccessToken({ name: "alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "bob", type: "pat", workspaceId: "local", userId: "bob" });
    const carolToken = await store.createAccessToken({ name: "carol", type: "pat", workspaceId: "local", userId: "carol" });

    const issue = store.createIssue({ title: "Delete authz", workspaceId: "local" });
    const seed = () => store.createAttachment({
      issueId: issue.id, workspaceId: "local", uploaderType: "member", uploaderId: "alice",
      filename: "secret.txt", url: "/api/attachments/seed/content", contentType: "text/plain", sizeBytes: 5,
    });

    // DELETE authz (Go file.go DeleteAttachment: uploader or workspace admin/owner only).
    const att1 = seed();
    expect((await app.request(`/api/attachments/${att1.id}`, { method: "DELETE", ...auth(bobToken.token) })).status).toBe(403);
    expect(store.getAttachment(att1.id)).not.toBeNull();
    expect((await app.request(`/api/attachments/${att1.id}`, { method: "DELETE", ...auth(aliceToken.token) })).status).toBe(200);
    expect(store.getAttachment(att1.id)).toBeNull();
    const att2 = seed();
    expect((await app.request(`/api/attachments/${att2.id}`, { method: "DELETE", ...auth(carolToken.token) })).status).toBe(200);
    expect(store.getAttachment(att2.id)).toBeNull();

    // Cross-workspace metadata enumeration is blocked on listing + detail routes.
    const remoteWorkspace = store.createWorkspace({ id: "ws_att_remote2", name: "Remote2", slug: "att-remote2" });
    const remoteToken = await store.createAccessToken({ name: "remote2", type: "pat", workspaceId: remoteWorkspace.id });
    seed();
    const comment = store.createIssueComment(issue.id, { body: "c", authorType: "member", authorId: "mem_local_alice" });
    store.createAttachment({
      commentId: comment.id, issueId: issue.id, workspaceId: "local", uploaderType: "member", uploaderId: "alice",
      filename: "c.txt", url: "/api/attachments/seedc/content", contentType: "text/plain", sizeBytes: 1,
    });
    expect((await app.request(`/api/issues/${issue.id}/attachments?workspace_id=local`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/multiremi/issues/${issue.id}/attachments`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/multiremi/comments/${comment.id}/attachments`, auth(remoteToken.token))).status).toBe(404);
    expect((await app.request(`/api/issues/${issue.id}?workspace_id=local`, auth(remoteToken.token))).status).toBe(404);
    // The same-workspace owner still sees them.
    expect((await app.request(`/api/issues/${issue.id}/attachments`, auth(carolToken.token))).status).toBe(200);

    // Cross-workspace upload is blocked (Go requires workspace membership before writing).
    const form = new FormData();
    form.append("file", new File(["x"], "x.txt", { type: "text/plain" }));
    form.append("issue_id", issue.id);
    form.append("workspace_id", "local");
    expect((await app.request("/api/upload-file", { method: "POST", body: form, ...auth(remoteToken.token) })).status).toBe(404);
    const bareCreate = await app.request("/api/multiremi/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${remoteToken.token}` },
      body: JSON.stringify({ workspaceId: "local", filename: "x.txt", url: "/x", contentType: "text/plain", sizeBytes: 1 }),
    });
    expect(bareCreate.status).toBe(404);
  });

  it("serves chat session and message endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex" });
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/multiremi/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, title: "API chat" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    const sent = await app.request(`/api/multiremi/chats/${createdBody.session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hello" }),
    });
    expect(sent.status).toBe(201);
    const sentBody = await sent.json();
    expect(sentBody.task.chatSessionId).toBe(createdBody.session.id);

    const detail = await app.request(`/api/multiremi/chats/${createdBody.session.id}`);
    const detailBody = await detail.json();
    expect(detailBody.messages[0].body).toBe("Hello");

    expect(store.claimTask(runtime.id)?.id).toBe(sentBody.task.id);
    store.startTask(sentBody.task.id);
    store.completeTask(sentBody.task.id, { output: "Hi there", sessionId: "sess-chat" });
    const messages = await app.request(`/api/multiremi/chats/${createdBody.session.id}/messages`);
    expect((await messages.json()).messages.map((message: any) => message.role)).toEqual(["user", "assistant"]);
  });

  it("triggers autopilots through API and webhook endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Webhook triage",
      assigneeId: agent.id,
      triggerKind: "webhook",
    });
    const app = createMultiremiApp({ store });

    const apiTrigger = await app.request(`/api/multiremi/autopilots/${autopilot.id}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "API prompt", payload: { source: "suite" } }),
    });
    expect(apiTrigger.status).toBe(201);
    const apiBody = await apiTrigger.json();
    expect(apiBody.run.source).toBe("api");
    expect(store.getTask(apiBody.run.taskId)?.prompt).toBe("API prompt");

    const webhookTrigger = await app.request(`/api/multiremi/autopilots/${autopilot.id}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "api-delivery-1" },
      body: JSON.stringify({ prompt: "Webhook prompt", event: "opened" }),
    });
    expect(webhookTrigger.status).toBe(201);
    const webhookBody = await webhookTrigger.json();
    expect(webhookBody.status).toBe("accepted");
    expect(webhookBody.delivery.status).toBe("dispatched");
    expect(webhookBody.delivery.dedupeKey).toBe("api-delivery-1");
    expect(webhookBody.run.source).toBe("webhook");
    expect(webhookBody.run.payload.event).toBe("opened");
    expect(store.getIssue(webhookBody.run.issueId)?.title).toBe("Webhook prompt");

    const duplicate = await app.request(`/api/multiremi/autopilots/${autopilot.id}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "api-delivery-1" },
      body: JSON.stringify({ prompt: "Webhook duplicate" }),
    });
    expect(duplicate.status).toBe(200);
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.status).toBe("duplicate");
    expect(duplicateBody.deliveryId).toBe(webhookBody.deliveryId);

    const deliveries = await app.request(`/api/multiremi/autopilots/${autopilot.id}/deliveries`);
    const deliveriesBody = await deliveries.json();
    expect(deliveriesBody.total).toBe(1);
    expect(deliveriesBody.deliveries[0].attemptCount).toBe(2);

    const detail = await app.request(`/api/multiremi/autopilots/${autopilot.id}`);
    expect((await detail.json()).deliveries[0].id).toBe(webhookBody.deliveryId);

    const trigger = await app.request(`/api/autopilots/${autopilot.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "webhook",
        label: "Token webhook",
        event_filters: [{ event: "webhook", actions: ["received"] }],
      }),
    });
    const triggerBody = await trigger.json();
    expect(trigger.status).toBe(201);
    expect(triggerBody.webhook_token).toStartWith("awt_");
    expect(triggerBody.event_filters).toEqual([{ event: "webhook", actions: ["received"] }]);

    const emptyTokenWebhook = await app.request(triggerBody.webhook_path, { method: "POST" });
    expect(emptyTokenWebhook.status).toBe(400);
    expect(await emptyTokenWebhook.json()).toEqual({ error: "empty body" });

    const scalarTokenWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("not an envelope"),
    });
    expect(scalarTokenWebhook.status).toBe(400);
    expect(await scalarTokenWebhook.json()).toEqual({ error: "body must be a JSON object or array" });

    const invalidTokenWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidTokenWebhook.status).toBe(400);
    expect((await invalidTokenWebhook.json()).error).toStartWith("invalid json:");

    const largeTokenWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(260 * 1024) }),
    });
    expect(largeTokenWebhook.status).toBe(413);
    expect(await largeTokenWebhook.json()).toEqual({ error: "payload too large" });

    const tokenWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "token-delivery-1" },
      body: JSON.stringify({ prompt: "Token webhook prompt", payload: { via: "token" } }),
    });
    const tokenWebhookBody = await tokenWebhook.json();
    expect(tokenWebhook.status).toBe(200);
    const tokenWebhookRunId = tokenWebhookBody.run_id;
    const tokenWebhookDeliveryId = tokenWebhookBody.delivery_id;
    expect(tokenWebhookBody).toMatchObject({
      status: "accepted",
      autopilot_id: autopilot.id,
      trigger_id: triggerBody.id,
      delivery_id: expect.any(String),
      run_id: expect.any(String),
    });
    expect(tokenWebhookBody.delivery).toBeUndefined();
    const tokenWebhookRun = store.getAutopilotRun(tokenWebhookRunId)!;
    expect(tokenWebhookRun.payload).toMatchObject({
      event: "webhook.received",
      eventPayload: { prompt: "Token webhook prompt", payload: { via: "token" } },
      request: { contentType: "application/json" },
    });

    const duplicateTokenWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "token-delivery-1" },
      body: JSON.stringify({ prompt: "Token webhook duplicate" }),
    });
    expect(duplicateTokenWebhook.status).toBe(200);
    expect(await duplicateTokenWebhook.json()).toEqual({
      status: "duplicate",
      delivery_id: tokenWebhookDeliveryId,
      run_id: tokenWebhookRunId,
    });

    const githubTrigger = await app.request(`/api/autopilots/${autopilot.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "webhook",
        label: "GitHub webhook",
        provider: "github",
        event_filters: [{ event: "pull_request", actions: ["opened"] }],
      }),
    });
    expect(githubTrigger.status).toBe(201);
    const githubTriggerBody = await githubTrigger.json();
    const githubPayload = "\uFEFF" + JSON.stringify({ action: "opened", prompt: "GitHub token webhook", pull_request: { number: 42 } });
    const githubTokenWebhook = await app.request(githubTriggerBody.webhook_path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Idempotency-Key": "ignored-generic-key",
        "User-Agent": "GitHub-Hookshot/test",
        "X-GitHub-Delivery": "github-delivery-1",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": "sha256=not-used-without-secret",
      },
      body: githubPayload,
    });
    expect(githubTokenWebhook.status).toBe(200);
    const githubTokenWebhookBody = await githubTokenWebhook.json();
    const githubRunId = githubTokenWebhookBody.run_id;
    const githubDeliveryId = githubTokenWebhookBody.delivery_id;
    expect(githubTokenWebhookBody).toMatchObject({
      status: "accepted",
      autopilot_id: autopilot.id,
      trigger_id: githubTriggerBody.id,
      delivery_id: expect.any(String),
      run_id: expect.any(String),
    });
    const githubRun = store.getAutopilotRun(githubRunId)!;
    expect(githubRun.payload).toMatchObject({
      event: "github.pull_request.opened",
      eventPayload: { action: "opened", pull_request: { number: 42 } },
      request: { contentType: "application/json" },
    });
    const githubDelivery = store.getWebhookDelivery(githubDeliveryId)!;
    expect(githubDelivery.event).toBe("github.pull_request.opened");
    expect(githubDelivery.dedupeKey).toBe("github-delivery-1");
    expect(githubDelivery.dedupeSource).toBe("x-github-delivery");
    expect(githubDelivery.contentType).toBe("application/json");
    expect(githubDelivery.selectedHeaders).toEqual({
      "user-agent": "GitHub-Hookshot/test",
      "x-github-event": "pull_request",
      "x-github-delivery": "github-delivery-1",
      "idempotency-key": "ignored-generic-key",
      "x-hub-signature-256-present": true,
    });

    const rotated = await app.request(`/api/autopilots/${autopilot.id}/triggers/${triggerBody.id}/rotate-webhook-token`, { method: "POST" });
    const rotatedBody = await rotated.json();
    expect(rotatedBody.webhook_token).not.toBe(triggerBody.webhook_token);
    expect((await app.request(triggerBody.webhook_path, { method: "POST" })).status).toBe(404);

    const disabled = await app.request(`/api/autopilots/${autopilot.id}/triggers/${triggerBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect((await disabled.json()).enabled).toBe(false);
    const ignored = await app.request(rotatedBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "token-delivery-2" },
      body: JSON.stringify({ prompt: "Ignored token" }),
    });
    const ignoredBody = await ignored.json();
    expect(ignored.status).toBe(200);
    expect(ignoredBody.status).toBe("ignored");
    expect(ignoredBody.reason).toBe("trigger_disabled");

    const replay = await app.request(`/api/multiremi/autopilots/${autopilot.id}/deliveries/${webhookBody.deliveryId}/replay`, { method: "POST" });
    expect(replay.status).toBe(201);
    expect((await replay.json()).delivery.replayedFromDeliveryId).toBe(webhookBody.deliveryId);
  });

  it("rate limits public autopilot webhooks by token and source bucket", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const autopilot = store.createAutopilot({ title: "Webhook limited", assigneeId: agent.id, triggerKind: "webhook" });
    store.updateAutopilot(autopilot.id, { status: "paused" });
    const trigger = store.createAutopilotTrigger(autopilot.id, { kind: "webhook", label: "Limited webhook" });

    const tokenLimitedApp = createMultiremiApp({
      store,
      webhookRateLimit: { limit: 2, windowMs: 60_000 },
      webhookIpRateLimit: false,
    });
    for (const key of ["token-limit-1", "token-limit-2"]) {
      const allowed = await tokenLimitedApp.request(trigger.webhookPath!, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ prompt: key }),
      });
      expect(allowed.status).toBe(200);
      expect((await allowed.json()).status).toBe("ignored");
    }
    const overTokenLimit = await tokenLimitedApp.request(trigger.webhookPath!, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "token-limit-3" },
      body: JSON.stringify({ prompt: "third" }),
    });
    expect(overTokenLimit.status).toBe(429);
    expect(await overTokenLimit.json()).toEqual({ error: "rate limit exceeded" });

    const ipLimitedApp = createMultiremiApp({
      store: createStore(),
      webhookRateLimit: false,
      webhookIpRateLimit: { limit: 2, windowMs: 60_000 },
    });
    for (const [token, spoofedIp] of [["awt_unknown_a", "1.1.1.1"], ["awt_unknown_b", "2.2.2.2"]] as const) {
      const allowedProbe = await ipLimitedApp.request(`/api/webhooks/autopilots/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": spoofedIp },
        body: JSON.stringify({ x: 1 }),
      });
      expect(allowedProbe.status).toBe(404);
    }
    const overIpLimit = await ipLimitedApp.request("/api/webhooks/autopilots/awt_unknown_c", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "3.3.3.3" },
      body: JSON.stringify({ x: 1 }),
    });
    expect(overIpLimit.status).toBe(429);
    expect(await overIpLimit.json()).toEqual({ error: "rate limit exceeded" });
  });

  it("syncs scheduler state through autopilot API updates", async () => {
    const store = createStore();
    const scheduler = new MultiremiScheduler({ store });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const app = createMultiremiApp({ store, scheduler });

    const created = await app.request("/api/multiremi/autopilots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "API scheduled",
        assigneeId: agent.id,
        triggerKind: "schedule",
        cronExpression: "*/10 * * * * *",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(scheduler.scheduledIds()).toContain(createdBody.autopilot.id);

    const scheduled = await app.request(`/api/multiremi/autopilots/${createdBody.autopilot.id}/run-scheduled`, {
      method: "POST",
    });
    expect(scheduled.status).toBe(201);
    expect((await scheduled.json()).run.source).toBe("schedule");

    const paused = await app.request(`/api/multiremi/autopilots/${createdBody.autopilot.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(paused.status).toBe(200);
    expect(scheduler.scheduledIds()).not.toContain(createdBody.autopilot.id);
    scheduler.stop();
  });

  it("serves workspace member endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/multiremi/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Grace Hopper", email: "grace@example.com", role: "admin" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json();

    const listed = await app.request("/api/multiremi/members");
    expect((await listed.json()).members[0].id).toBe(body.member.id);

    const updated = await app.request(`/api/multiremi/members/${body.member.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect((await updated.json()).member.role).toBe("reviewer");

    const archived = await app.request(`/api/multiremi/members/${body.member.id}`, { method: "DELETE" });
    expect((await archived.json()).member.archivedAt).toBeString();

    const owner = store.createWorkspaceMember({ name: "Native Owner", email: "native-owner@example.com", role: "owner" });
    const lastOwnerDelete = await app.request(`/api/multiremi/members/${owner.id}`, { method: "DELETE" });
    expect(lastOwnerDelete.status).toBe(400);
    expect(await lastOwnerDelete.json()).toEqual({ error: "workspace must have at least one owner" });
  });

  it("serves notification preference endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const updated = await app.request("/api/multiremi/notification-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: { assignments: "muted", comments: "all" } }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).preferences.assignments).toBe("muted");

    const listed = await app.request("/api/multiremi/notification-preferences");
    expect((await listed.json()).preferences.assignments).toBe("muted");
  });

  it("serves feedback endpoints with validation and rate limiting", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "remi-test",
        "x-multiremi-platform": "desktop",
        "x-multiremi-version": "1.2.3",
      },
      body: JSON.stringify({
        message: "  Love the product, dark mode flashes on startup  ",
        url: "http://localhost:6130/issues",
        workspace_id: "local",
        member_id: "mem_feedback",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.id).toStartWith("fdb_");
    expect(createdBody.created_at).toBeString();

    const feedback = store.listFeedback("local")[0];
    expect(feedback.message).toBe("Love the product, dark mode flashes on startup");
    expect(feedback.memberId).toBe("mem_feedback");
    expect(feedback.userId).toBe("mem_feedback");
    expect(feedback.metadata.url).toBe("http://localhost:6130/issues");
    expect(feedback.metadata.platform).toBe("desktop");
    expect(feedback.metadata.version).toBe("1.2.3");
    expect(feedback.metadata.user_agent).toBe("remi-test");

    const multiremiFeedback = await app.request("/api/multiremi/feedback");
    const multiremiFeedbackBody = await multiremiFeedback.json();
    expect(multiremiFeedbackBody.total).toBe(1);
    expect(multiremiFeedbackBody.feedback[0].id).toBe(createdBody.id);

    const empty = await app.request("/api/multiremi/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    expect(empty.status).toBe(400);

    for (let i = 0; i < 9; i++) {
      const response = await app.request("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `feedback #${i}`, member_id: "mem_feedback" }),
      });
      expect(response.status).toBe(201);
    }

    const overLimit = await app.request("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "one too many", member_id: "mem_feedback" }),
    });
    expect(overLimit.status).toBe(429);
  });

  it("serves GitHub settings, pull request, and webhook endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "GitHub API issue" });

    const unavailableConnect = await app.request("/api/workspaces/local/github/connect");
    expect(await unavailableConnect.json()).toEqual({ configured: false });

    const settings = await app.request("/api/multiremi/github/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prSidebar: false, coAuthor: false }),
    });
    expect(settings.status).toBe(200);
    const settingsBody = await settings.json();
    expect(settingsBody.settings.enabled).toBe(true);
    expect(settingsBody.settings.prSidebar).toBe(false);
    expect(settingsBody.settings.coAuthor).toBe(false);

    const created = await app.request("/api/multiremi/github/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_owner: "example",
        repo_name: "remi",
        number: 7,
        title: `${issue.key} API linked PR`,
        branch: `feature/${issue.key}-api-pr`,
        checksConclusion: "passed",
        checksPassed: 2,
        additions: 5,
        deletions: 1,
        changedFiles: 2,
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.pullRequest.issueId).toBe(issue.id);
    expect(createdBody.pullRequest.checksPassed).toBe(2);

    const listed = await app.request(`/api/multiremi/github/pull-requests?issueId=${encodeURIComponent(issue.id)}`);
    const listedBody = await listed.json();
    expect(listedBody.total).toBe(1);
    expect(listedBody.pullRequests[0].number).toBe(7);

    const issuePullRequests = await app.request(`/api/issues/${encodeURIComponent(issue.id)}/pull-requests`);
    const issuePullRequestsBody = await issuePullRequests.json();
    expect(issuePullRequests.status).toBe(200);
    expect(issuePullRequestsBody.pull_requests[0].repo_owner).toBe("example");
    expect(issuePullRequestsBody.pull_requests[0].html_url).toBe("https://github.com/example/remi/pull/7");
    expect(issuePullRequestsBody.pull_requests[0].checks_passed).toBe(2);

    const merged = await app.request("/api/multiremi/github/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoOwner: "example",
        repoName: "remi",
        number: 7,
        title: `${issue.key} API linked PR`,
        state: "merged",
        mergedAt: "2026-06-03T00:00:00.000Z",
      }),
    });
    expect(merged.status).toBe(201);
    expect(store.getIssue(issue.id)?.status).toBe("done");

    const ping = await app.request("/api/multiremi/github/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zen: "Keep it logically awesome." }),
    });
    expect((await ping.json()).ok).toBe("pong");

    const webhookIssue = store.createIssue({ title: "GitHub webhook issue" });
    const webhook = await app.request("/api/multiremi/github/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: { name: "remi", owner: { login: "example" } },
        pull_request: {
          number: 8,
          title: `${webhookIssue.key} webhook linked PR`,
          state: "open",
          draft: false,
          merged: false,
          html_url: "https://github.com/example/remi/pull/8",
          head: { ref: `feature/${webhookIssue.key}-webhook` },
          user: { login: "octocat", avatar_url: "https://example.com/avatar.png" },
          created_at: "2026-06-03T00:00:00.000Z",
          updated_at: "2026-06-03T01:00:00.000Z",
          mergeable_state: "clean",
          additions: 3,
          deletions: 0,
          changed_files: 1,
        },
      }),
    });
    expect(webhook.status).toBe(202);
    expect((await webhook.json()).pullRequest.issueId).toBe(webhookIssue.id);

    const originalWebhookIssue = store.createIssue({ title: "GitHub original webhook issue" });
    const originalWebhook = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: { name: "remi", owner: { login: "example" } },
        pull_request: {
          number: 9,
          title: `${originalWebhookIssue.key} original webhook linked PR`,
          state: "closed",
          draft: false,
          merged: true,
          html_url: "https://github.com/example/remi/pull/9",
          head: { ref: `feature/${originalWebhookIssue.key}-original-webhook` },
          user: { login: "octocat" },
          merged_at: "2026-06-03T02:00:00.000Z",
          closed_at: "2026-06-03T02:00:00.000Z",
          created_at: "2026-06-03T00:00:00.000Z",
          updated_at: "2026-06-03T02:00:00.000Z",
        },
      }),
    });
    const originalWebhookBody = await originalWebhook.json();
    expect(originalWebhook.status).toBe(202);
    expect(originalWebhookBody.pullRequest.issueId).toBe(originalWebhookIssue.id);
    expect(originalWebhookBody.pullRequest.state).toBe("merged");
    expect(store.getIssue(originalWebhookIssue.id)?.status).toBe("done");
  });

  it("serves configured GitHub setup and connect compatibility responses", async () => {
    const previousSlug = process.env.GITHUB_APP_SLUG;
    const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
    try {
      process.env.GITHUB_APP_SLUG = "multiremi-local";
      process.env.GITHUB_WEBHOOK_SECRET = "local-secret";
      const app = createMultiremiApp({ store: createStore() });

      const connect = await app.request("/api/workspaces/local/github/connect");
      const connectBody = await connect.json();
      expect(connect.status).toBe(200);
      expect(connectBody.configured).toBe(true);
      expect(connectBody.url).toStartWith("https://github.com/apps/multiremi-local/installations/new?state=");

      const installations = await app.request("/api/workspaces/local/github/installations");
      expect(await installations.json()).toMatchObject({
        configured: true,
        installations: [],
        can_manage: true,
      });

      const setup = await app.request("/api/github/setup?installation_id=123&state=local.state.sig");
      expect(await setup.json()).toMatchObject({
        configured: true,
        installation_id: "123",
        state: "local.state.sig",
      });
    } finally {
      if (previousSlug === undefined) delete process.env.GITHUB_APP_SLUG;
      else process.env.GITHUB_APP_SLUG = previousSlug;
      if (previousSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
      else process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
    }
  });

  it("serves assignee frequency through original Multiremi route", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const alice = store.createWorkspaceMember({ name: "Alice API", role: "member" });
    const bob = store.createWorkspaceMember({ name: "Bob API", role: "member" });
    const issue = store.createIssue({
      title: "Assigned on create",
      createdBy: alice.id,
      assigneeType: "member",
      assigneeId: bob.id,
    });
    store.assignIssue(issue.id, {
      assigneeType: "member",
      assigneeId: bob.id,
      actorType: "member",
      actorId: alice.id,
    });

    const response = await app.request(`/api/assignee-frequency?memberId=${encodeURIComponent(alice.id)}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0]).toMatchObject({
      assignee_type: "member",
      assignee_id: bob.id,
      frequency: 2,
    });
  });
});

describe("Bun Multiremi dashboard JSON API", () => {
  // D11 removed the server-rendered HTML dashboard (src/multiremi/dashboard.ts) and its
  // 8 HTML-string assertions. The data endpoints survived in api.ts; these tests lock the
  // surviving JSON contract that the Next.js frontend now consumes.

  function seedRuntimeWithUsage(store: MultiremiStore, options: {
    runtimeId: string;
    workspaceId?: string;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
  }): { agentId: string; runtimeId: string; taskId: string } {
    const workspaceId = options.workspaceId ?? "local";
    const provider = options.provider ?? "claude";
    store.registerRuntime({ id: options.runtimeId, name: `Runtime ${options.runtimeId}`, provider, workspaceId });
    const agent = store.createAgent({ name: `Agent ${options.runtimeId}`, provider, workspaceId });
    const task = store.createTask({ agentId: agent.id, workspaceId, prompt: "seed usage" });
    const claimed = store.claimTask(options.runtimeId);
    expect(claimed?.id).toBe(task.id);
    store.reportTaskUsage(task.id, [{
      provider,
      model: options.model ?? "sonnet",
      inputTokens: options.inputTokens ?? 21,
      outputTokens: options.outputTokens ?? 8,
    }]);
    return { agentId: agent.id, runtimeId: options.runtimeId, taskId: task.id };
  }

  it("serves the JSON service status at / instead of HTML", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ service: "multiremi-api", ui: "frontend/apps/web" });
    expect(JSON.stringify(body)).not.toContain("<html");
    expect(JSON.stringify(body)).not.toContain("<!DOCTYPE");
  });

  it("returns 204 with no body for /favicon.ico", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const response = await app.request("/favicon.ico");
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("serves /api/dashboard/usage/daily matching store.listUsageDaily", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    seedRuntimeWithUsage(store, { runtimeId: "rt_daily", inputTokens: 21, outputTokens: 8 });

    const response = await app.request("/api/dashboard/usage/daily?workspace_id=local");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual(store.listUsageDaily({ workspaceId: "local" }));
    expect(body[0]).toMatchObject({
      runtimeId: "rt_daily",
      provider: "claude",
      model: "sonnet",
      inputTokens: 21,
      outputTokens: 8,
      taskCount: 1,
    });
  });

  it("serves /api/dashboard/usage/by-agent matching store.listUsageByAgent", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const seeded = seedRuntimeWithUsage(store, { runtimeId: "rt_by_agent", inputTokens: 13, outputTokens: 4 });

    const response = await app.request("/api/dashboard/usage/by-agent?workspace_id=local");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(store.listUsageByAgent({ workspaceId: "local" }));
    expect(body[0]).toMatchObject({
      agentId: seeded.agentId,
      model: "sonnet",
      inputTokens: 13,
      outputTokens: 4,
      taskCount: 1,
    });
  });

  it("serves /api/dashboard/runtime/daily matching store.listRuntimeDaily with failed counts", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const okRuntime = seedRuntimeWithUsage(store, { runtimeId: "rt_runtime_daily" });
    store.completeTask(okRuntime.taskId, { output: "done" });

    const agent = store.createAgent({ name: "Failing", provider: "claude", workspaceId: "local" });
    const failingTask = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "will fail" });
    store.claimTask("rt_runtime_daily");
    store.failTask(failingTask.id, { error: "boom" });

    const response = await app.request("/api/dashboard/runtime/daily?workspace_id=local");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(store.listRuntimeDaily({ workspaceId: "local" }));
    expect(body[0]).toMatchObject({ taskCount: 2, failedCount: 1 });
  });

  it("serves /api/dashboard/agent-runtime as the listRuntimeDaily alias of runtime/daily", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    seedRuntimeWithUsage(store, { runtimeId: "rt_alias" });

    const agentRuntime = await app.request("/api/dashboard/agent-runtime?workspace_id=local");
    expect(agentRuntime.status).toBe(200);
    const agentRuntimeBody = await agentRuntime.json();
    expect(agentRuntimeBody).toEqual(store.listRuntimeDaily({ workspaceId: "local" }));

    const runtimeDaily = await app.request("/api/dashboard/runtime/daily?workspace_id=local");
    expect(agentRuntimeBody).toEqual(await runtimeDaily.json());
  });

  it("isolates dashboard usage by workspace_id", async () => {
    const store = createStore();
    store.createWorkspace({ id: "ws_other", name: "Other", slug: "other" });
    const app = createMultiremiApp({ store });
    seedRuntimeWithUsage(store, { runtimeId: "rt_local_ws", workspaceId: "local", model: "sonnet" });
    seedRuntimeWithUsage(store, { runtimeId: "rt_other_ws", workspaceId: "ws_other", model: "opus" });

    const localBody = await (await app.request("/api/dashboard/usage/daily?workspace_id=local")).json();
    expect(localBody).toEqual(store.listUsageDaily({ workspaceId: "local" }));
    expect(localBody.map((row: any) => row.model)).toEqual(["sonnet"]);

    const otherBody = await (await app.request("/api/dashboard/usage/daily?workspace_id=ws_other")).json();
    expect(otherBody).toEqual(store.listUsageDaily({ workspaceId: "ws_other" }));
    expect(otherBody.map((row: any) => row.model)).toEqual(["opus"]);
  });

  it("requires auth on dashboard endpoints while keeping / public when a token is configured", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    seedRuntimeWithUsage(store, { runtimeId: "rt_auth" });

    const root = await app.request("/");
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual({ service: "multiremi-api", ui: "frontend/apps/web" });

    const unauthorized = await app.request("/api/dashboard/usage/daily?workspace_id=local");
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });

    const authorized = await app.request("/api/dashboard/usage/daily?workspace_id=local", {
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual(store.listUsageDaily({ workspaceId: "local" }));
  });

  it("authenticates dashboard endpoints with a workspace access token", async () => {
    const store = createStore();
    const patToken = await store.createAccessToken({ name: "Dashboard PAT", type: "pat", workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    seedRuntimeWithUsage(store, { runtimeId: "rt_pat" });

    const response = await app.request("/api/dashboard/usage/by-agent?workspace_id=local", {
      headers: { Authorization: `Bearer ${patToken.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(store.listUsageByAgent({ workspaceId: "local" }));
  });
});
