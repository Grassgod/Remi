import { disabledSshMeshRuntime } from "../helpers/ssh-mesh-isolation.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { antigravityGatewayFor } from "@multiremi/daemon.js";
import { createRuntimeProvider, isolateProcessTmp, PrivateTmpIsolationUnavailableError } from "@acp/index.js";
import { AntigravityGatewayShim } from "@daemon/agent-runtime/antigravity/gateway-shim.js";
import { startMultiremiServer, TestMultiremiDaemon } from "../fixtures/daemon-protocol.js";
import { foldTraceLines } from "../helpers/turn-trace.js";
import { TaskUsageLedger } from "@multiremi/worker/task-usage-ledger.js";

/**
 * Antigravity through the real API, daemon, provider and gateway shim, with a
 * fake ACP server (tests/fixtures/antigravity-acp-fake.mjs) and a fake Gemini
 * gateway. Google's proprietary server is never used here.
 */

const GATEWAY_KEY = "gw-secret-key-for-the-integration-test";
const SESSION_MODEL = "gemini-test-pro";
const FIXTURE = resolve("tests/fixtures/antigravity-acp-fake.mjs");

interface GatewayRequest { path: string; search: string; authorization: string | null; googKey: boolean; model: string | null }

let cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

/** Counters of the n-th session-model call (1-based): prompt includes the cache. */
function usageOf(n: number) {
  const prompt = 1_000 + 100 * n;
  return { promptTokenCount: prompt, cachedContentTokenCount: 600, candidatesTokenCount: 40, thoughtsTokenCount: 10, totalTokenCount: prompt + 50 };
}
const LITE_USAGE = { promptTokenCount: 300, candidatesTokenCount: 5, totalTokenCount: 305 };
const CUT_USAGE = { promptTokenCount: 500, totalTokenCount: 500 };

function fakeGateway() {
  const requests: GatewayRequest[] = [];
  let calls = 0;
  /** Status of model listings: 200, or a refused / failing gateway. */
  const control = { listStatus: 200 };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const model = /\/models\/([^/:]+):/.exec(url.pathname)?.[1] ?? null;
      requests.push({ path: url.pathname, search: url.search, authorization: request.headers.get("authorization"),
        googKey: request.headers.has("x-goog-api-key"), model });
      if (request.headers.get("authorization") !== `Bearer ${GATEWAY_KEY}` || request.headers.has("x-goog-api-key")) {
        return Response.json({ error: { code: 401, message: "API key not valid", status: "UNAUTHENTICATED" } }, { status: 401 });
      }
      if (request.method === "GET" && url.pathname === "/antigravity/v1beta/models" && control.listStatus !== 200) {
        return Response.json({ error: { code: control.listStatus } }, { status: control.listStatus });
      }
      if (request.method === "GET" && url.pathname === "/antigravity/v1beta/models") {
        // The server defaults to the first listed model, so the session model must be selected explicitly.
        return Response.json({ models: ["gemini-test-lite", SESSION_MODEL].map((name) => ({
          name: `models/${name}`, displayName: name, supportedGenerationMethods: ["generateContent", "countTokens"], inputTokenLimit: 1_048_576,
        })) });
      }
      if (request.method !== "POST" || !url.pathname.endsWith(":streamGenerateContent")) return new Response("not found", { status: 404 });
      const body = await request.text();
      const encoder = new TextEncoder();
      const event = (chunk: unknown) => encoder.encode(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
      if (body.includes("ABORT_STREAM")) {
        // First chunk only, then silence until the client gives up.
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(event({ responseId: "resp-cut", modelVersion: `${model}-001`, usageMetadata: CUT_USAGE,
            candidates: [{ content: { parts: [{ text: "Sto" }] } }] }));
        } }), { headers: { "content-type": "text/event-stream" } });
      }
      if (body.includes("SLOW_RESPONSE")) {
        await Bun.sleep(600);
        return new Response(event({ responseId: "resp-crossing", modelVersion: `${model}-001`, usageMetadata: usageOf(9) }),
          { headers: { "content-type": "text/event-stream" } });
      }
      const usage = model === SESSION_MODEL ? usageOf(++calls) : LITE_USAGE;
      const responseId = `resp-${model}-${model === SESSION_MODEL ? calls : "lite"}`;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(event({ responseId, modelVersion: `${model}-001`, usageMetadata: { promptTokenCount: usage.promptTokenCount },
          candidates: [{ content: { parts: [{ text: "Do" }] } }] }));
        controller.enqueue(event({ responseId, modelVersion: `${model}-001`, usageMetadata: usage,
          candidates: [{ content: { parts: [{ text: "ne" }] }, finishReason: "STOP" }] }));
        controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  cleanup.push(() => server.stop(true));
  return { requests, control, base: `http://127.0.0.1:${server.port}/antigravity` };
}

async function setup(options: { gateway: ReturnType<typeof fakeGateway> | null; turnStallTimeoutMs?: number }) {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), "remi-agy-daemon-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const database: Database = openSqliteDatabase(":memory:");
  cleanup.push(() => database.close());
  const store = new MultiremiStore(database);
  store.ensureLocalWorkspace();
  const local = join(root, "user-project");
  const capture = join(root, "capture.jsonl");
  mkdirSync(local);
  writeFileSync(capture, "");
  writeFileSync(join(local, "AGENTS.md"), "AGY_LOCAL_CONTEXT_SENTINEL");
  writeFileSync(join(local, "README.md"), "# project\n");
  if (options.gateway) {
    store.upsertRelayConfig("local", "antigravity", {
      fragment: JSON.stringify({ base_url: options.gateway.base, default_model: SESSION_MODEL }), tokenOp: "set", authToken: GATEWAY_KEY,
    });
  }
  // The agent names no model: the engine's default_model applies.
  const agent = store.createAgent({ name: "AGY", provider: "antigravity", executable: process.execPath, customArgs: [FIXTURE],
    customEnv: { FAKE_AGY_CAPTURE: capture } });
  const token = await store.createAccessToken({ name: "AGY test daemon", type: "daemon", workspaceId: "local", daemonId: "agy-test-machine" });
  const server = startMultiremiServer({ store, scheduler: null, authToken: "agy-test-root", hostname: "127.0.0.1", port: 0 });
  cleanup.push(() => server.stop(true));
  // The fake gateway is loopback http; production only reaches public https gateways.
  const shim = new AntigravityGatewayShim({ assertUpstream: async (url) => { expect(url.hostname).toBe("127.0.0.1"); } });
  cleanup.push(() => shim.stop());
  const homeSpy = spyOn(os, "homedir").mockReturnValue(join(root, "user-home"));
  cleanup.push(() => homeSpy.mockRestore());
  const daemon = new TestMultiremiDaemon({
    sshMeshManager: disabledSshMeshRuntime(), antigravityGatewayShim: shim,
    serverUrl: `http://127.0.0.1:${server.port}`, token: token.token, daemonId: "agy-test-machine", runtimeName: "AGY integration",
    provider: "antigravity", workspaceId: "local", daemonPort: 0, pollIntervalMs: 20, gcEnabled: false,
    workspacesRoot: join(root, "state"), repoCacheRoot: join(root, "repo-cache"), taskDrainTimeoutMs: 2_000,
    // The model probe has no pinned install here: run it in-process against the fake server.
    inProcessRuntimeModelDiscoveryEnabled: true,
    providerFactory: (provider) => createRuntimeProvider({
      ...(provider.executable ? provider : { ...provider, executable: process.execPath, args: [FIXTURE], env: { ...provider.env, FAKE_AGY_CAPTURE: capture } }),
      ...(options.turnStallTimeoutMs ? { turnStallTimeoutMs: options.turnStallTimeoutMs } : {}),
    }),
  });
  void daemon.start().catch(() => {});
  cleanup.push(() => daemon.stopAndDrainTestWork());
  await poll(() => store.listRuntimes().length > 0);
  const lines = () => readFileSync(capture, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
  return { root, local, capture, store, database, agent, daemon, shim, lines, runtime: store.listRuntimes()[0]! };
}

function privateTmpUnavailable(root: string): PrivateTmpIsolationUnavailableError | null {
  const probe = join(root, "isolation-probe");
  mkdirSync(probe, { recursive: true });
  try {
    isolateProcessTmp({ executable: Bun.which("true") ?? "true", args: [] }, probe);
    return null;
  } catch (error) {
    if (error instanceof PrivateTmpIsolationUnavailableError) return error;
    throw error;
  }
}

async function poll(check: () => boolean, what = "condition") {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Antigravity daemon test timed out waiting for ${what}`);
    await Bun.sleep(30);
  }
}

function usageUnits(database: Database, taskId: string) {
  return database.query(`SELECT provider, model, requested_model, connection_id, identity_kind, provider_session_id, provider_request_id,
    accuracy, input_tokens, cache_read_tokens, output_tokens, reported_total_tokens, scope
    FROM multiremi_usage_units WHERE task_id = ? AND purpose = 'agent' AND scope = 'request' ORDER BY provider_request_id`).all(taskId) as Array<Record<string, unknown>>;
}

describe("Antigravity through the daemon gateway shim", () => {
  it("runs a turn into a turn + items trace, meters every model call through the shim, resumes, and records a cut stream as partial", async () => {
    const gateway = fakeGateway();
    const { root, local, capture, store, database, agent, daemon, lines, runtime } = await setup({ gateway });
    const directory = store.runtimeWorkspaces.create(runtime.id, { name: "User project", root_path: local });
    const chat = store.createChatSession({ agentId: agent.id, runtime_workspace_id: directory.id });
    const isolation = privateTmpUnavailable(root);

    const first = store.sendChatMessage(chat.id, { body: "Inspect project SUBAGENT_LAST" }).task;
    await poll(() => ["completed", "failed"].includes(store.getTask(first.id)?.status ?? ""), "the first turn");
    const done = store.getTask(first.id)!;
    if (isolation) {
      // Linux runners without user namespaces cannot run any ACP agent here.
      expect(done.status).toBe("failed");
      expect(done.error).toContain("[private_tmp_isolation_unavailable]");
      return;
    }
    expect(done.error).toBeNull();
    expect(done.status).toBe("completed");
    expect(done.sessionId).toBe("agy-fake-session-1");
    // The runtime's executable models came from the server's own listing, through a probe token of the shim.
    await poll(() => store.listRuntimeModels(runtime.id).length === 2, "the probed runtime models");
    expect(store.listRuntimeModels(runtime.id).map((model) => [model.id, model.thinking?.status ?? null]).sort()).toEqual([
      ["gemini-test-lite", "unsupported"], [SESSION_MODEL, "unsupported"],
    ]);

    // The server process: the shim's loopback token and the placeholder key, never the real key.
    const taskEnvs = () => lines().filter((line) => line.kind === "env" && line.cwd === local);
    const env = taskEnvs()[0]!;
    expect(env.cwd).toBe(local);
    expect(env.AGY_LLM_GATEWAY_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r_[A-Za-z0-9_-]{43}$/);
    expect(env.AGY_LLM_GATEWAY_API_KEY).toBe("remi-shim");
    expect(env.AGY_ACP_ENABLE_GATEWAY_AUTH).toBe("1");
    expect(env.AGY_ACP_DEFAULT_MODEL).toBe(SESSION_MODEL);
    expect(env.GEMINI_API_KEY).toBe("");
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(env.GEMINI_HOME.startsWith(join(root, "state"))).toBe(true);
    // Nothing the server saw (its whole environment and every request) carries the real key.
    expect(readFileSync(capture, "utf8")).not.toContain(GATEWAY_KEY);
    // Seeded home: gateway auth, task directories untrusted (no repository hooks, no trust prompt).
    expect(JSON.parse(readFileSync(join(env.GEMINI_HOME, "antigravity-acp", "settings.json"), "utf8"))).toEqual({ auth: { type: "gateway" } });
    expect(JSON.parse(readFileSync(join(env.GEMINI_HOME, "antigravity-acp", "trusted_workspaces.json"), "utf8")).untrusted).toContain(local);
    expect(existsSync(join(env.GEMINI_HOME, "antigravity-cli", "skills"))).toBe(false);
    // Session: runtime-context instructions appended to the system prompt; the engine default model selected strictly.
    const task = lines().filter((line) => line.pid === env.pid);
    const created = task.find((line) => line.kind === "request" && line.method === "session/new")!;
    expect(created.params._meta.antigravity.systemPrompt.append).toContain("AGY_LOCAL_CONTEXT_SENTINEL");
    expect(task.some((line) => line.kind === "request" && line.method === "session/set_config_option" && line.params.value === SESSION_MODEL)).toBe(true);
    // Auto approval answered the shell command's permission request.
    expect(task.find((line) => line.kind === "permission")!.outcome).toEqual({ outcome: "selected", optionId: "allow_always" });

    // The gateway saw only the real key as Bearer, never the placeholder header or query key.
    expect(gateway.requests.length).toBeGreaterThanOrEqual(4);
    for (const request of gateway.requests) {
      expect(request.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
      expect(request.googKey).toBe(false);
      expect(request.search).not.toContain("key=");
    }
    expect(gateway.requests.filter((request) => request.model).map((request) => [request.path, request.search])).toEqual([
      [`/antigravity/v1beta/models/${SESSION_MODEL}:streamGenerateContent`, "?alt=sse"],
      [`/antigravity/v1beta/models/${SESSION_MODEL}:streamGenerateContent`, "?alt=sse"],
      ["/antigravity/v1beta/models/gemini-test-lite:streamGenerateContent", "?alt=sse"],
    ]);

    // Billing: one request-identity unit per model call, cache split, thinking in output; the native `used` is ignored.
    await poll(() => usageUnits(database, first.id).length === 3, "three usage units");
    const units = usageUnits(database, first.id);
    const expected = (n: number) => { const u = usageOf(n); return { input_tokens: u.promptTokenCount - 600, cache_read_tokens: 600, output_tokens: 50, reported_total_tokens: u.totalTokenCount }; };
    expect(units).toEqual([
      { provider: "antigravity", model: "gemini-test-lite-001", requested_model: "gemini-test-lite", connection_id: "workspace:local:relay:antigravity",
        identity_kind: "request", provider_session_id: "agy-fake-session-1", provider_request_id: "resp-gemini-test-lite-lite", accuracy: "exact",
        input_tokens: 300, cache_read_tokens: 0, output_tokens: 5, reported_total_tokens: 305, scope: "request" },
      ...[1, 2].map((n) => ({ provider: "antigravity", model: `${SESSION_MODEL}-001`, requested_model: SESSION_MODEL, connection_id: "workspace:local:relay:antigravity",
        identity_kind: "request", provider_session_id: "agy-fake-session-1", provider_request_id: `resp-${SESSION_MODEL}-${n}`, accuracy: "exact",
        ...expected(n), scope: "request" })),
    ]);
    expect(units.reduce((sum, unit) => sum + Number(unit.input_tokens) + Number(unit.cache_read_tokens) + Number(unit.output_tokens), 0))
      .toBe(usageOf(1).totalTokenCount + usageOf(2).totalTokenCount + LITE_USAGE.totalTokenCount);

    // Trace: one turn with the command and the reply; context is the last session-model call, not the later subagent call (R9).
    // The server can report completion just before the daemon seals the turn.
    await poll(() => foldTraceLines(daemon.traceStore().read(first.id).events).turn?.status === "completed", "the sealed trace");
    const trace = foldTraceLines(daemon.traceStore().read(first.id).events);
    expect(trace.turn?.context_usage).toEqual({ used: usageOf(2).totalTokenCount, size: 1_048_576 });
    const command = trace.items.find((item) => item.type === "command");
    expect(command).toMatchObject({ type: "command", command: "ls -la", cwd: local, status: "completed" });
    expect(trace.items.filter((item) => item.type === "agent_message").map((item) => item.type === "agent_message" && item.text)).toEqual(["Done."]);

    // A follow-up starts a new server process that resumes the native session.
    const second = store.sendChatMessage(chat.id, { body: "Continue" }).task;
    await poll(() => ["completed", "failed"].includes(store.getTask(second.id)?.status ?? ""), "the resumed turn");
    expect(store.getTask(second.id)?.error).toBeNull();
    const resumed = lines().find((line) => line.kind === "request" && line.method === "session/resume");
    expect(resumed?.params.sessionId).toBe("agy-fake-session-1");
    expect(new Set(taskEnvs().map((line) => line.AGY_LLM_GATEWAY_URL)).size).toBe(2);

    // A cut-short stream bills only the counters it carried, as partial (R8).
    const third = store.sendChatMessage(chat.id, { body: "ABORT_STREAM please" }).task;
    await poll(() => ["completed", "failed"].includes(store.getTask(third.id)?.status ?? ""), "the cut-stream turn");
    expect(store.getTask(third.id)?.error).toBeNull();
    await poll(() => usageUnits(database, third.id).length === 1, "the cut-stream unit");
    expect(usageUnits(database, third.id)).toEqual([{ provider: "antigravity", model: `${SESSION_MODEL}-001`, requested_model: SESSION_MODEL,
      connection_id: "workspace:local:relay:antigravity", identity_kind: "request", provider_session_id: "agy-fake-session-1", provider_request_id: "resp-cut",
      accuracy: "partial", input_tokens: 500, cache_read_tokens: 0, output_tokens: 0, reported_total_tokens: 500, scope: "request" }]);
    // Every run's tokens are revoked when it ends (just after its completion is reported).
    for (const url of new Set(taskEnvs().map((line) => line.AGY_LLM_GATEWAY_URL as string))) {
      let status = 0;
      for (let i = 0; i < 100 && (status = (await fetch(`${url}/v1beta/models`)).status) !== 404; i++) await Bun.sleep(20);
      expect(status).toBe(404);
    }
  }, 90_000);

  it("stops a turn a background command holds open, as an agent timeout, while a long foreground command completes", async () => {
    const gateway = fakeGateway();
    const { root, local, store, database, agent, daemon, lines, runtime } = await setup({ gateway, turnStallTimeoutMs: 400 });
    const directory = store.runtimeWorkspaces.create(runtime.id, { name: "User project", root_path: local });
    const chat = store.createChatSession({ agentId: agent.id, runtime_workspace_id: directory.id });
    if (privateTmpUnavailable(root)) return;

    // 1.5 s of foreground work, nearly 4× the bound: the model waits on the tool, so nothing trips.
    const foreground = store.sendChatMessage(chat.id, { body: "FOREGROUND_CMD build it" }).task;
    await poll(() => ["completed", "failed"].includes(store.getTask(foreground.id)?.status ?? ""), "the foreground turn");
    expect(store.getTask(foreground.id)?.error).toBeNull();
    expect(store.getTask(foreground.id)?.status).toBe("completed");
    await poll(() => foldTraceLines(daemon.traceStore().read(foreground.id).events).turn?.status === "completed", "the sealed trace");
    const built = foldTraceLines(daemon.traceStore().read(foreground.id).events);
    expect(built.items.find((item) => item.type === "command")).toMatchObject({ command: "make build", status: "completed" });

    // The model backgrounds a command, says so, and the server never ends the turn nor honours the cancel.
    const started = Date.now();
    const background = store.sendChatMessage(chat.id, { body: "BACKGROUND_CMD start the dev server" }).task;
    await poll(() => ["completed", "failed"].includes(store.getTask(background.id)?.status ?? ""), "the stalled turn");
    const stalled = store.getTask(background.id)!;
    expect(stalled.status).toBe("failed");
    expect(stalled.failureReason).toBe("agent_error.agent_timeout");
    expect(stalled.error).toContain("The antigravity turn timed out after 400 ms without progress");
    // Bound plus the 5 s cancel grace before the process is stopped.
    expect(Date.now() - started).toBeLessThan(15_000);
    const waiting = lines().find((line) => line.kind === "background_wait")!;
    const process = lines().filter((line) => line.pid === waiting.pid);
    expect(process.some((line) => line.kind === "request" && line.method === "session/cancel")).toBe(true);
    // Stopped like an unanswered cancel: the server process is gone.
    expect(() => globalThis.process.kill(waiting.pid, 0)).toThrow();
    // The model call before the stall was still billed.
    await poll(() => (database.query("SELECT COUNT(*) AS n FROM multiremi_usage_units WHERE task_id = ? AND scope = 'request'").get(background.id) as { n: number }).n === 1,
      "the stalled turn's usage");
  }, 60_000);

  it("falls back to cancel + re-prompt for a steer, without leaking the server's cancel acknowledgement", async () => {
    const gateway = fakeGateway();
    const { root, local, store, agent, daemon, lines, runtime } = await setup({ gateway });
    const directory = store.runtimeWorkspaces.create(runtime.id, { name: "User project", root_path: local });
    const chat = store.createChatSession({ agentId: agent.id, runtime_workspace_id: directory.id });
    if (privateTmpUnavailable(root)) return;
    const task = store.sendChatMessage(chat.id, { body: "STEER_ME please" }).task;
    await poll(() => lines().some((line) => line.kind === "waiting_for_steer"), "the running turn");
    const steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "STEER_FOLLOW_UP now" }).id;
    await poll(() => ["completed", "failed"].includes(store.getTask(task.id)?.status ?? ""), "the steered turn");
    expect(store.getTask(task.id)?.error).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("completed");
    const requests = lines().filter((line) => line.kind === "request").map((line) => line.method);
    // No native steering on the wire: cancel, then the steer as the next prompt on the same session.
    expect(requests.filter((method) => method === "session/cancel")).toHaveLength(1);
    expect(requests.some((method) => String(method).includes("steer"))).toBe(false);
    const prompts = lines().filter((line) => line.kind === "request" && line.method === "session/prompt")
      .map((line) => JSON.stringify(line.params.prompt));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("STEER_FOLLOW_UP now");
    await poll(() => foldTraceLines(daemon.traceStore().read(task.id).events).turn?.status === "completed", "the sealed trace");
    const items = foldTraceLines(daemon.traceStore().read(task.id).events).items;
    expect(items.filter((item) => item.type === "agent_message").map((item) => item.type === "agent_message" && item.text))
      .toEqual(["Working on it.", "Following the steer."]);
    expect(JSON.stringify(items)).not.toContain("The request was cancelled by the client.");
    expect(items.find((item) => item.type === "user_message" && item.origin === "steer")).toMatchObject({
      steer: { steer_id: steerId, injected: true, result: { via: "reprompt", native_outcome: "unsupported" } } });
  }, 60_000);

  it("reports a refused or failing gateway, not the unsupported model the server's fallback list implies", async () => {
    const gateway = fakeGateway();
    const { root, local, store, agent, lines, runtime } = await setup({ gateway });
    const directory = store.runtimeWorkspaces.create(runtime.id, { name: "User project", root_path: local });
    const chat = store.createChatSession({ agentId: agent.id, runtime_workspace_id: directory.id });
    if (privateTmpUnavailable(root)) return;
    const run = async (status: number, body: string) => {
      gateway.control.listStatus = status;
      const task = store.sendChatMessage(chat.id, { body }).task;
      await poll(() => ["completed", "failed"].includes(store.getTask(task.id)?.status ?? ""), `the turn with a ${status} listing`);
      return store.getTask(task.id)!;
    };
    // A revoked key: the listing's 401 opens the breaker before any prompt.
    const revoked = await run(401, "Inspect project");
    expect(revoked.status).toBe("failed");
    expect(revoked.failureReason).toBe("agent_error.provider_auth_or_access");
    expect(revoked.error).toContain("The model gateway rejected the credentials");
    expect(revoked.error).not.toContain("acp_model_unsupported");
    // A gateway outage: two failed listings stay under the breaker threshold, but the session model is missing.
    const outage = await run(503, "Inspect project");
    expect(outage.status).toBe("failed");
    expect(outage.failureReason).toBe("agent_error.provider_server_error");
    expect(outage.error).toContain("The model gateway is unreachable");
    expect(outage.error).not.toContain("acp_model_unsupported");
    // The server really fell back to its built-in ids, and no prompt reached it.
    expect(lines().filter((line) => line.kind === "list").map((line) => line.status)).toContain(401);
    expect(lines().some((line) => line.kind === "request" && line.method === "session/prompt")).toBe(false);
    // The runtime's models never became the fallback list.
    expect(store.listRuntimeModels(runtime.id).map((model) => model.id)).not.toContain("gemini-3-flash-preview");
  }, 60_000);

  it("refuses model calls after the turn, bills a call crossing its end once, and revokes before the ledger closes", async () => {
    const gateway = fakeGateway();
    const order: string[] = [];
    const finish = TaskUsageLedger.prototype.finish;
    const ledgerSpy = spyOn(TaskUsageLedger.prototype, "finish").mockImplementation(function (this: TaskUsageLedger) {
      order.push("ledger.finish");
      return finish.call(this);
    });
    cleanup.push(() => ledgerSpy.mockRestore());
    const { root, local, store, database, agent, shim, lines, runtime } = await setup({ gateway });
    const forRun = shim.forRun.bind(shim);
    shim.forRun = (options) => {
      const run = forRun(options);
      if (options.runId === "runtime-model-probe") return run;
      const close = run.close.bind(run);
      run.close = () => { order.push("revoke"); close(); };
      return run;
    };
    const directory = store.runtimeWorkspaces.create(runtime.id, { name: "User project", root_path: local });
    const chat = store.createChatSession({ agentId: agent.id, runtime_workspace_id: directory.id });
    if (privateTmpUnavailable(root)) return;
    const units = (taskId: string) => database.query("SELECT provider_request_id, accuracy FROM multiremi_usage_units WHERE task_id = ? AND scope = 'request'")
      .all(taskId) as Array<{ provider_request_id: string; accuracy: string }>;

    const late = store.sendChatMessage(chat.id, { body: "LATE_CALL please" }).task;
    await poll(() => lines().some((line) => line.kind === "late_call"), "the late call");
    await poll(() => store.getTask(late.id)?.status === "completed", "the late-call turn");
    // Refused (503 while the run lives, 404 once its token is revoked), never forwarded, never billed.
    expect([503, 404]).toContain(lines().find((line) => line.kind === "late_call")!.status);
    const modelCalls = () => gateway.requests.filter((request) => request.model).length;
    expect(modelCalls()).toBe(1);
    await poll(() => units(late.id).length === 1, "the late-call turn's usage");
    expect(units(late.id)).toHaveLength(1);
    // The run revoked its tokens before its ledger's final close. (The earlier
    // finish sent with the completion leaves the session open for a racing
    // steer; no prompt is active there, so the shim serves no model call.)
    await poll(() => order.lastIndexOf("ledger.finish") > order.indexOf("revoke") && order.indexOf("revoke") >= 0, "the run's teardown");
    expect(order.slice(order.indexOf("revoke"))).toContain("ledger.finish");

    const crossing = store.sendChatMessage(chat.id, { body: "CROSSING_CALL please" }).task;
    await poll(() => store.getTask(crossing.id)?.status === "completed", "the crossing turn");
    await poll(() => units(crossing.id).length === 1, "the crossing call's usage");
    expect(units(crossing.id)).toEqual([{ provider_request_id: "resp-crossing", accuracy: "exact" }]);
  }, 60_000);

  it("fails an unconfigured gateway before the start ACK, without spawning the server", async () => {
    const { store, database, agent, lines } = await setup({ gateway: null });
    const task = store.createTask({ agentId: agent.id, prompt: "Inspect project", maxAttempts: 1 });
    await poll(() => ["completed", "failed"].includes(store.getTask(task.id)?.status ?? ""), "the failed task");
    const failed = store.getTask(task.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("[antigravity_gateway_unconfigured]");
    expect(failed.failureReason).toBe("agent_error.missing_config");
    expect(lines()).toEqual([]);
    // No start ACK means no accepted usage run.
    expect(database.query("SELECT COUNT(*) AS n FROM multiremi_usage_runs WHERE task_id = ?").get(task.id)).toEqual({ n: 0 });
  }, 60_000);

  it("requires a base URL and a key, and carries the engine default model", () => {
    expect(() => antigravityGatewayFor(null)).toThrow("[antigravity_gateway_unconfigured]");
    expect(() => antigravityGatewayFor({ fragment: "", auth_token: "k", revision: 1 })).toThrow("a base URL and an API key");
    expect(() => antigravityGatewayFor({ fragment: JSON.stringify({ base_url: "https://gw.example/antigravity" }), auth_token: "", revision: 1 }))
      .toThrow("with an API key");
    expect(antigravityGatewayFor({ fragment: JSON.stringify({ base_url: "https://gw.example/antigravity", default_model: "gemini-x" }), auth_token: "k", revision: 1 }))
      .toEqual({ upstreamBase: "https://gw.example/antigravity", apiKey: "k", defaultModel: "gemini-x" });
  });
});
