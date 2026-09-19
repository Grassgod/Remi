/**
 * MUL-336 acceptance drill — a REAL primary -> fallback switch on the execution
 * engine, in an isolated environment with a controllable resource error.
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpProviderOptions } from "@acp/index.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiDaemon, type MultiremiDaemonProviderFactory } from "@multiremi/daemon.js";
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
}

/**
 * The model process: no accounts for the primary model, works for everything
 * else — the shape of a real gateway exhaustion, minus the gateway.
 */
function gatewayProviderFactory(
  engineModels: Drill["engineModels"],
  fallbackLevels: string[] = ["high"],
): MultiremiDaemonProviderFactory {
  return (options: AcpProviderOptions) => ({
    async *sendStream() {
      const model = options.model ?? null;
      engineModels.push(model);
      if (model === PRIMARY_MODEL) throw new Error(GATEWAY_ERROR);
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

async function runDrill(options: { fallback: boolean; fallbackLevels?: string[]; fallbackThinkingLevel?: string | null }): Promise<Drill & { taskId: string; issueId: string }> {
  db = new Database(":memory:");
  workDir = mkdtempSync(join(tmpdir(), "multiremi-fallback-drill-"));
  const store = new MultiremiStore(db);
  const engineModels: Drill["engineModels"] = [];
  store.ensureLocalWorkspace();
  const fallbackThinkingLevel = options.fallbackThinkingLevel === undefined ? "high" : options.fallbackThinkingLevel;
  const agent = store.createAgent({
    name: "Drill agent", provider: "claude", maxConcurrentTasks: 2,
    model: PRIMARY_MODEL, thinkingLevel: "high",
    ...(options.fallback
      ? { fallbackModel: FALLBACK_MODEL, ...(fallbackThinkingLevel == null ? {} : { fallbackThinkingLevel }) }
      : {}),
  });
  const issue = store.createIssue({ title: "Gateway drill", workspaceId: "local", assigneeType: "agent", assigneeId: agent.id });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Do the work" });
  const daemonToken = await store.createAccessToken({ name: "Drill daemon", type: "daemon", workspaceId: "local" });
  const server = startMultiremiServer({ store, scheduler: null, authToken: "drill-root", hostname: "127.0.0.1", port: 0 });
  const daemon = new MultiremiDaemon({
    serverUrl: `http://127.0.0.1:${server.port}`,
    token: daemonToken.token,
    runtimeName: "Drill runtime",
    provider: "claude",
    workspaceId: "local",
    daemonPort: 0,
    pollIntervalMs: 25,
    maxConcurrency: 2,
    gcEnabled: false,
    inProcessRuntimeModelDiscoveryEnabled: true,
    workspacesRoot: join(workDir, "daemon-state"),
    repoCacheRoot: join(workDir, "repo-cache"),
    providerFactory: gatewayProviderFactory(engineModels, options.fallbackLevels),
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
        id: candidate.id, status: candidate.status, error: candidate.error,
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
  return { store, engineModels, taskId: task.id, issueId: issue.id };
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
