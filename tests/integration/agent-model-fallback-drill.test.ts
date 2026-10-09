import { createResponsibleTestIssue } from "../unit/multiremi/helpers.js";
/**
 * MUL-336 / MUL-478 drill — a REAL primary -> fallback switch on the execution
 * engine, in an isolated environment with controllable availability errors.
 *
 * Everything below the model process is production code: the HTTP server, the
 * daemon's claim/dispatch/prompt/report pipeline, the provider error
 * classification, the store's recovery chain and the execution record. Only the
 * model process itself is stubbed, because the point of the drill is a gateway
 * that runs out of accounts for the primary model — an error a real gateway
 * produces happily and no test can summon on demand.
 *
 * The stub is deliberately NOT told which attempt it is. It fails whenever the
 * model it was handed is the primary one, so the drill only passes if the
 * fallback model genuinely travelled from the Agent's configuration through the
 * recovery chain and the claim payload into the engine's hands.
 */
import { disabledSshMeshRuntime } from "../helpers/ssh-mesh-isolation.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpProvider, AcpRpcError, type AcpProviderOptions, type ProviderEvent } from "@acp/index.js";
import { startMultiremiServer } from "../fixtures/daemon-protocol.js";
import type { MultiremiDaemonProviderFactory } from "@multiremi/daemon.js";
import { TestMultiremiDaemon as MultiremiDaemon } from "../fixtures/daemon-protocol.js";
import { MultiremiStore } from "@multiremi/store.js";
import { TaskFailureReason } from "@multiremi/task-failure.js";

const PRIMARY_MODEL = "primary-gpt-5";
const FALLBACK_MODEL = "fallback-deepseek-v3";
/** What the gateway answers once the primary model's account pool is empty. */
const GATEWAY_ERROR = `API Error: 503 no available accounts for model ${PRIMARY_MODEL}`;
const FALLBACK_OUTPUT = "Completed on the fallback model";

let db: Database | null = null;
let workDir: string | null = null;
let providerHomeBase: string | null = null;
let gateway: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  // Keep runtime model probing away from the developer's real credentials, the
  // same isolation tests/integration/multiremi-daemon-smoke.test.ts applies.
  providerHomeBase = mkdtempSync(join(tmpdir(), "multiremi-fallback-provider-home-"));
  process.env.CLAUDE_CONFIG_DIR = join(providerHomeBase, "claude");
  process.env.CODEX_HOME = join(providerHomeBase, "codex");
});

afterAll(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  if (providerHomeBase) rmSync(providerHomeBase, { recursive: true, force: true });
  providerHomeBase = null;
});

afterEach(() => {
  gateway?.stop(true);
  gateway = null;
  db?.close();
  db = null;
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

interface Drill {
  store: MultiremiStore;
  /** The model each engine run was handed, in dispatch order. */
  engineModels: Array<string | null>;
  issueStateAtPrimaryFailure?: string;
  leaderId?: string;
}

type FailureShape = "legacy-text" | "typed" | "rpc-detail" | "rpc-kind" | "compaction" | "native-compaction" | "typed-prose";

function failureProviderFactory(engineModels: Drill["engineModels"], shape: FailureShape, failureText?: string): MultiremiDaemonProviderFactory {
  const baseFactory = gatewayProviderFactory(engineModels);
  return (options) => {
    const base = baseFactory(options);
    if (shape === "legacy-text") return {
      ...base,
      typedSessionFailures: false,
      async *sendStream(): AsyncGenerator<ProviderEvent> {
        engineModels.push(options.model ?? null);
        if (options.model === PRIMARY_MODEL) {
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Earlier progress. ".repeat(50) }] };
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: failureText ?? `unexpected status 404 Not Found: Model "${PRIMARY_MODEL}" is not supported by any configured account in this group` }] };
        } else {
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: FALLBACK_OUTPUT }] };
        }
      },
    };
    // Exercise the production ACP provider's event/result/RPC handling; only
    // the bridge's stdio endpoint is replaced with this controllable client.
    const provider = new AcpProvider(options);
    let turn = 0;
    const client = {
      typedSessionFailures: true,
      _options: { onSessionUpdate: (_event: unknown) => {} },
      prompt: async () => {
        if (turn++ === 0) engineModels.push(options.model ?? null);
        const update = (value: unknown) => client._options.onSessionUpdate({ sessionId: "fallback-native-session", update: value });
        if (options.model !== PRIMARY_MODEL) {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: FALLBACK_OUTPUT } });
          return { stopReason: "end_turn" };
        }
        if (shape === "typed-prose") {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "unexpected status 404 Not Found: Model example is not supported" } });
          return { stopReason: "end_turn" };
        }
        if (shape === "rpc-detail") throw new AcpRpcError(-32603, "Internal error", "API Error: 503 Service Unavailable");
        if (shape === "rpc-kind") throw new AcpRpcError(-32603, "Internal error", { errorKind: "model_not_found" });
        if (shape === "native-compaction") {
          if (turn === 1) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Earlier successful turn. ".repeat(50) } });
          else update({ sessionUpdate: "tool_call_update", toolCallId: "compact:1", status: "failed",
            _meta: { contextCompaction: { version: 1, error: failureText ?? "Error during compaction: API Error: 503 Service Unavailable" }, claudeCode: { toolName: "compact" } } });
          return { stopReason: "end_turn" };
        }
        if (shape === "compaction") update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Compacting..." } });
        update({ sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { sessionFailure: {
          id: "turn:error", revision: 1, category: "service", severity: "error", title: failureText ?? "unexpected status 503 Service Unavailable",
        } } } } });
        return { stopReason: "end_turn" };
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "fallback-native-session" });
    if (shape === "native-compaction" && options.model === PRIMARY_MODEL) {
      const send = provider.sendStream.bind(provider);
      provider.sendStream = async function* (message, sendOptions) {
        yield* send(message, sendOptions);
        yield* send("/compact", sendOptions);
      };
    }
    provider.discoverModelCapabilities = base.discoverModelCapabilities!;
    return provider;
  };
}

/**
 * The model process: no accounts for the primary model, works for everything
 * else — the shape of a real gateway exhaustion, minus the gateway.
 */
function gatewayProviderFactory(
  engineModels: Drill["engineModels"],
  fallbackLevels: string[] = ["high"],
  failureText?: string,
): MultiremiDaemonProviderFactory {
  return (options: AcpProviderOptions) => ({
    async *sendStream() {
      const model = options.model ?? null;
      engineModels.push(model);
      if (model === PRIMARY_MODEL) throw new Error(failureText ?? GATEWAY_ERROR);
      yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: FALLBACK_OUTPUT }] } as never;
    },
    getLastResponse: () => ({
      text: FALLBACK_OUTPUT,
      sessionId: "fallback-native-session",
      requestId: "req-fallback",
    }),
    // Both models are genuinely runnable on this runtime, so the recovery
    // attempt passes the same capability gate a fresh task would. The fallback
    // is allowed a DIFFERENT set of effort levels than the primary: models do
    // not agree on what they accept, which is what makes an inherited level
    // unrunnable rather than merely odd.
    discoverModelCapabilities: async () => [
      { id: PRIMARY_MODEL, label: PRIMARY_MODEL, default: true, effort: { supportedLevels: [{ value: "high", label: "high" }], defaultLevel: "high" } },
      {
        id: FALLBACK_MODEL,
        label: FALLBACK_MODEL,
        effort: {
          supportedLevels: fallbackLevels.map((value) => ({ value, label: value })),
          defaultLevel: fallbackLevels[0],
        },
      },
    ] as never,
    close: async () => {},
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCondition(predicate: () => boolean, timeoutMs = 10_000, describeState?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`condition was not met before timeout${describeState ? ` — ${describeState()}` : ""}`);
}

async function runDrill(options: {
  fallback: boolean; fallbackLevels?: string[]; fallbackThinkingLevel?: string | null;
  provider?: "claude" | "codex"; failureShape?: FailureShape; delegated?: boolean;
  failureText?: string; providerKey?: string;
}): Promise<Drill & { taskId: string; issueId: string }> {
  db = openSqliteDatabase(":memory:");
  workDir = mkdtempSync(join(tmpdir(), "multiremi-fallback-drill-"));
  const store = new MultiremiStore(db);
  const engineModels: Drill["engineModels"] = [];
  const provider = options.provider ?? "claude";
  store.ensureLocalWorkspace();
  if (provider === "codex") {
    gateway = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({ data: [{ id: PRIMARY_MODEL }, { id: FALLBACK_MODEL }] }),
    });
    store.upsertRelayConfig("local", "codex", {
      fragment: `model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "http://127.0.0.1:${gateway.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = true`,
      tokenOp: "set", authToken: options.providerKey ?? "fixture-gateway-key",
    });
  }
  const fallbackThinkingLevel = options.fallbackThinkingLevel === undefined ? "high" : options.fallbackThinkingLevel;
  const agent = store.createAgent({
    name: "Drill agent", provider, maxConcurrentTasks: 2,
    model: PRIMARY_MODEL, thinkingLevel: "high",
    ...(options.fallback
      ? { fallbackModel: FALLBACK_MODEL, ...(fallbackThinkingLevel == null ? {} : { fallbackThinkingLevel }) }
      : {}),
  });
  const leader = options.delegated ? store.createAgent({ name: "Drill leader", provider, model: FALLBACK_MODEL, thinkingLevel: "high" }) : null;
  const issue = createResponsibleTestIssue(store, { title: "Gateway drill", workspaceId: "local", assigneeType: "agent", assigneeId: leader?.id ?? agent.id });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Do the work",
    ...(leader ? { delegationId: "dlg_drill", delegatedByAgentId: leader.id } : {}) });
  let issueStateAtPrimaryFailure: string | undefined;
  store.onTaskEvent((event) => {
    if (event.type === "task:failed" && event.task.id === task.id) issueStateAtPrimaryFailure = store.getIssue(issue.id)?.status;
  });
  const daemonToken = await store.createAccessToken({ name: "Drill daemon", type: "daemon", workspaceId: "local" });
  const server = startMultiremiServer({ store, scheduler: null, authToken: "drill-root", hostname: "127.0.0.1", port: 0 });
  const daemon = new MultiremiDaemon({
    sshMeshManager: disabledSshMeshRuntime(),
    serverUrl: `http://127.0.0.1:${server.port}`,
    token: daemonToken.token,
    runtimeName: "Drill runtime",
    provider,
    workspaceId: "local",
    daemonPort: 0,
    pollIntervalMs: 25,
    maxConcurrency: 2,
    gcEnabled: false,
    inProcessRuntimeModelDiscoveryEnabled: true,
    workspacesRoot: join(workDir, "daemon-state"),
    repoCacheRoot: join(workDir, "repo-cache"),
    providerFactory: options.failureShape
      ? failureProviderFactory(engineModels, options.failureShape, options.failureText)
      : gatewayProviderFactory(engineModels, options.fallbackLevels, options.failureText),
  });

  let daemonRun: Promise<void> | null = null;
  try {
    daemonRun = daemon.start();
    await waitForCondition(() => store.listRuntimes().length > 0, 10_000);
    // Nothing left in flight means the chain is over: either it ended, or the
    // recovery attempt finished.
    await waitForCondition(() =>
      !store.listTasks().some((candidate) => ["queued", "dispatched", "running"].includes(candidate.status)), 30_000,
      () => JSON.stringify(store.listTasks().map((candidate) => ({
        id: candidate.id, status: candidate.status, error: options.failureText ? Boolean(candidate.error) : candidate.error,
        reason: candidate.failureReason, model: candidate.executionModel,
      }))));
    // Let the daemon finish the ack round-trip of the last terminal report.
    // Stopping mid-flight leaves it replaying from its outbox against a closed
    // database — noisy logs for the next test in a shared suite.
    await sleep(300);
  } finally {
    daemon.stop();
    await daemonRun?.catch(() => {});
    server.stop(true);
  }
  return { store, engineModels, taskId: task.id, issueId: issue.id, issueStateAtPrimaryFailure, leaderId: leader?.id };
}

/** A drill starts a real server and daemon; the default 5s budget is not enough. */
const drillIt = (name: string, run: () => Promise<void>) => it(name, run, 60_000);

describe("MUL-336 real-engine fallback drill", () => {
  drillIt("continues the task on the fallback model after the primary gateway is exhausted", async () => {
    const { store, engineModels, taskId, issueId } = await runDrill({ fallback: true });

    // The engine was handed the primary model first and the fallback second.
    // The stub fails on the primary by construction, so the second run could
    // only have started if the override reached the engine.
    expect(engineModels).toEqual([PRIMARY_MODEL, FALLBACK_MODEL]);

    const failed = store.getTask(taskId)!;
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe(TaskFailureReason.AgentProviderNoAvailableAccount);

    const attempts = store.listTasksForIssue(issueId);
    expect(attempts).toHaveLength(2);
    const recovered = attempts.find((attempt) => attempt.parentTaskId === taskId)!;
    expect(recovered).toMatchObject({
      status: "completed",
      attempt: 2,
      executionModel: FALLBACK_MODEL,
      executionThinkingLevel: "high",
      fallbackSwitched: true,
      switchReason: `gateway_resource:${TaskFailureReason.AgentProviderNoAvailableAccount};provider_session_reset`,
      sessionId: "fallback-native-session",
      result: FALLBACK_OUTPUT,
    });
    expect(recovered.error).toBeNull();
    // Requirement 4: the Agent keeps its own selection for the next task.
    expect(store.getAgent(failed.agentId)).toMatchObject({
      model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL,
    });
  });

  drillIt("recovers onto a fallback model that does not share the primary's reasoning level", async () => {
    // The Agent configured a fallback model but no level for it, and the
    // fallback does not accept the primary's 'high'. The recovery attempt must
    // still reach the engine instead of being excluded from every Runtime by a
    // level that was never the fallback's to begin with.
    const { store, engineModels, taskId, issueId } = await runDrill({
      fallback: true, fallbackLevels: ["low"], fallbackThinkingLevel: null,
    });

    expect(engineModels).toEqual([PRIMARY_MODEL, FALLBACK_MODEL]);

    const recovered = store.listTasksForIssue(issueId).find((attempt) => attempt.parentTaskId === taskId)!;
    expect(recovered).toMatchObject({
      status: "completed",
      attempt: 2,
      executionModel: FALLBACK_MODEL,
      // No level was configured for the fallback, so the record carries none —
      // the engine applied the model's own default rather than the primary's.
      executionThinkingLevel: null,
      fallbackSwitched: true,
      result: FALLBACK_OUTPUT,
    });
    // Requirement 4 still holds: the Agent keeps its primary selection.
    expect(store.getAgent(recovered.agentId)).toMatchObject({
      model: PRIMARY_MODEL, thinkingLevel: "high", fallbackThinkingLevel: null,
    });
  });

  drillIt("ends the chain bounded when the Agent has no fallback model", async () => {
    const { store, engineModels, taskId } = await runDrill({ fallback: false });

    expect(engineModels).toEqual([PRIMARY_MODEL]);
    expect(store.getTask(taskId)).toMatchObject({
      status: "failed",
      failureReason: TaskFailureReason.AgentProviderNoAvailableAccount,
      executionModel: null,
      fallbackSwitched: false,
    });
    expect(store.listTasks().filter((candidate) => candidate.parentTaskId === taskId)).toHaveLength(0);
  });
});

describe("MUL-478 turn failure recovery drill", () => {
  for (const shape of ["typed", "native-compaction", "legacy-text", "generic"] as const) {
    drillIt(`${shape} errors cannot leak into task records, activity, messages or delegation`, async () => {
      const secret = `privacy_${crypto.randomUUID().replaceAll("-", "")}: /+?=`;
      const provider = shape === "legacy-text" || shape === "generic" ? "codex" : "claude";
      const details = shape === "generic" ? `upstream detail ${secret} ${encodeURIComponent(secret)}`
        : `Bearer ${secret.split(":")[0]}`;
      const raw = `unexpected status 503 Service Unavailable: ${details}`;
      const logs: unknown[] = [];
      const spies = ["log", "warn", "error"].map(method => spyOn(console, method as "log")
        .mockImplementation((...args) => { logs.push(args); }));
      try {
        const { store, taskId, issueId, leaderId } = await runDrill({
          fallback: false, provider, delegated: true, failureText: raw, providerKey: secret,
          ...(shape === "generic" ? {} : { failureShape: shape }),
        });
        const records = [store.getTask(taskId)?.error, store.listTaskMessages(taskId),
          store.listIssueActivity(issueId), store.listTasks().filter(task => task.agentId === leaderId).map(task => task.prompt), logs];
        const needle = shape === "generic" ? secret : secret.split(":")[0];
        for (const record of records) {
          const serialized = JSON.stringify(record);
          expect(serialized.includes(needle)).toBe(false);
          expect(serialized.includes(encodeURIComponent(needle))).toBe(false);
        }
        expect(store.getTask(taskId)?.failureReason).toBe(TaskFailureReason.AgentProviderServerError);
        expect(store.listTasks().filter(task => task.agentId === leaderId && task.delegationId === "dlg_drill")).toHaveLength(1);
      } finally { for (const spy of spies) spy.mockRestore(); }
    });
  }
  drillIt("does not classify normal error-like prose from a typed bridge as a failed turn", async () => {
    const { store, taskId, issueId, engineModels } = await runDrill({
      fallback: true, provider: "codex", failureShape: "typed-prose",
    });
    expect(engineModels).toEqual([PRIMARY_MODEL]);
    expect(store.getTask(taskId)).toMatchObject({ status: "completed", failureReason: null, fallbackSwitched: false });
    expect(store.listTasksForIssue(issueId)).toHaveLength(1);
  });
  const cases: Array<{ provider: "claude" | "codex"; shape: FailureShape; reason: string }> = [
    { provider: "codex", shape: "legacy-text", reason: TaskFailureReason.AgentModelNotFoundOrUnavailable },
    { provider: "codex", shape: "typed", reason: TaskFailureReason.AgentProviderServerError },
    { provider: "claude", shape: "rpc-detail", reason: TaskFailureReason.AgentProviderServerError },
    { provider: "claude", shape: "rpc-kind", reason: TaskFailureReason.AgentModelNotFoundOrUnavailable },
    { provider: "codex", shape: "compaction", reason: TaskFailureReason.AgentProviderServerError },
    { provider: "claude", shape: "native-compaction", reason: TaskFailureReason.AgentProviderServerError },
  ];
  for (const { provider, shape, reason } of cases) {
    drillIt(`${provider} ${shape}: fails, switches and returns once`, async () => {
      const { store, engineModels, taskId, issueId, issueStateAtPrimaryFailure, leaderId } = await runDrill({
        fallback: true, provider, failureShape: shape, delegated: true,
      });
      expect(engineModels.slice(0, 2)).toEqual([PRIMARY_MODEL, FALLBACK_MODEL]);
      expect(store.getTask(taskId)).toMatchObject({ status: "failed", failureReason: reason });
      expect(issueStateAtPrimaryFailure).toBe("in_progress");
      const tasks = store.listTasksForIssue(issueId);
      const retry = tasks.find((candidate) => candidate.parentTaskId === taskId && candidate.agentId !== leaderId)!;
      expect(retry).toMatchObject({ status: "completed", executionModel: FALLBACK_MODEL, fallbackSwitched: true, result: FALLBACK_OUTPUT });
      expect(store.getTurnForAttempt(taskId)?.id).toBe(store.getTurnForAttempt(retry.id)?.id);
      const turn = store.getTurnForAttempt(retry.id)!;
      expect(store.getMessage(turn.reply_message_id!)?.body_md).toBe(FALLBACK_OUTPUT);
      expect(retry.switchReason).toBe(`gateway_resource:${reason};provider_session_reset`);
      const returns = tasks.filter((candidate) => candidate.agentId === leaderId && candidate.delegationId === "dlg_drill");
      expect(returns).toHaveLength(1);
      expect(returns[0]!.parentTaskId).toBeNull();
      expect(store.getMessage(returns[0]!.triggerCommentId!)?.task_id).toBe(store.getTurnForAttempt(retry.id)!.id);
    });
  }
  drillIt("Claude model-not-found without a fallback wakes the delegator once", async () => {
    const { store, taskId, issueId, issueStateAtPrimaryFailure, leaderId } = await runDrill({
      fallback: false, provider: "claude", failureShape: "rpc-kind", delegated: true,
    });
    expect(store.getTask(taskId)).toMatchObject({ status: "failed", failureReason: TaskFailureReason.AgentModelNotFoundOrUnavailable });
    expect(issueStateAtPrimaryFailure).not.toBe("in_review");
    const tasks = store.listTasksForIssue(issueId);
    expect(tasks.filter((candidate) => candidate.agentId === leaderId
      && store.getMessage(candidate.triggerCommentId!)?.task_id === store.getTurnForAttempt(taskId)!.id)).toHaveLength(1);
    expect(tasks.filter((candidate) => candidate.fallbackSwitched)).toHaveLength(0);
  });
});
