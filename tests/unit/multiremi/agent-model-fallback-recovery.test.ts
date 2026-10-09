import { createResponsibleTestIssue } from './helpers.js';
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
/**
 * MUL-336 / MUL-478 — the Agent's default fallback model.
 *
 * When the primary model's gateway reports resource exhaustion or unavailability the CURRENT task
 * must move to the Agent's fallback model and carry on, exactly once, without
 * touching the Agent's own configuration or any other task. MUL-478 includes
 * model lookup and server failures while retaining auth/configuration exclusions.
 *
 * These tests drive the real store (claim -> fail -> retry -> claim) instead of
 * the policy helpers, because the contract is about what the recovery chain
 * does to the task, to the Agent and to the surrounding surfaces.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { daemonTaskClaimResponse, taskCompatibilityResponse } from "@multiremi/api/wire/tasks.js";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { classifyDaemonTaskFailure, TaskFailureReason } from "@multiremi/task-failure.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const PRIMARY = "primary-gpt";
const FALLBACK = "fallback-deepseek";
/** The gateway's account pool is empty for the primary model. */
const NO_ACCOUNT_ERROR = "gateway error: 503 no available accounts for model primary-gpt";

function model(id: string, available = true): MultiremiRuntimeModel {
  return {
    id,
    label: id,
    provider: "anthropic",
    default: id === PRIMARY,
    thinking: available
      ? { status: "supported", supportedLevels: [{ value: "high", label: "high" }], defaultLevel: "high" }
      : { status: "error", supportedLevels: [], error: "catalog HTTP 503 (fixture)" },
  };
}

/** A model that supports exactly `levels` — models differ in what they accept,
 *  which is what makes an inherited reasoning level unrunnable. */
function modelWithLevels(id: string, levels: string[]): MultiremiRuntimeModel {
  return {
    id,
    label: id,
    provider: "anthropic",
    default: id === PRIMARY,
    thinking: {
      status: "supported",
      supportedLevels: levels.map((value) => ({ value, label: value })),
      defaultLevel: levels[0],
    },
  };
}

type Store = ReturnType<typeof createStore>;

/** Primary model exhausted; the fallback is a different, runnable model. */
function fixture(options: { fallback?: boolean } = {}) {
  const store = createStore();
  const runtime = store.registerRuntime({
    name: "Gateway", provider: "claude", maxConcurrency: 4,
    models: [model(PRIMARY), model(FALLBACK)],
  });
  const agent = store.createAgent({
    name: "Dual model", provider: "claude", maxConcurrentTasks: 4,
    model: PRIMARY, thinkingLevel: "high",
    ...(options.fallback === false ? {} : { fallbackModel: FALLBACK, fallbackThinkingLevel: "high" }),
  });
  const issue = createResponsibleTestIssue(store, {
    title: "Gateway exhausted", assigneeType: "agent", assigneeId: agent.id,
  });
  return { store, runtime, agent, issue };
}

/** Claim and fail the task the way the daemon does: classify, then report. */
function failClaimed(store: Store, runtimeId: string, taskId: string, error: string): void {
  expect(store.claimTask(runtimeId)?.id).toBe(taskId);
  store.startTask(taskId);
  store.failTask(taskId, { error, failureReason: classifyDaemonTaskFailure("claude", error) });
}

function successor(store: Store, parentTaskId: string) {
  return store.listTasks().find((task) => task.parentTaskId === parentTaskId) ?? null;
}

describe("MUL-336 model fallback recovery chain", () => {
  it("moves the failed task to the Agent's fallback model and leaves the Agent alone", () => {
    const { store, runtime, agent, issue } = fixture();
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Ship the feature" });
    expect(task.executionModel).toBeNull();

    failClaimed(store, runtime.id, task.id, NO_ACCOUNT_ERROR);

    const failed = store.getTask(task.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe(TaskFailureReason.AgentProviderNoAvailableAccount);
    // The failed attempt itself never claims to have switched.
    expect(failed.fallbackSwitched).toBe(false);

    const retry = successor(store, task.id)!;
    expect(retry).toMatchObject({
      status: "queued",
      attempt: 2,
      executionModel: FALLBACK,
      executionThinkingLevel: "high",
      fallbackSwitched: true,
      parentTaskId: task.id,
      agentId: agent.id,
      issueId: issue.id,
      nextRetryAt: null,
    });
    expect(retry.switchReason).toBe(
      `gateway_resource:${TaskFailureReason.AgentProviderNoAvailableAccount};provider_session_reset`,
    );
    // Requirement 4: recovery must not rewrite the Agent's own selection.
    expect(store.getAgent(agent.id)).toMatchObject({
      model: PRIMARY, thinkingLevel: "high", fallbackModel: FALLBACK, fallbackThinkingLevel: "high",
    });
    // The retry keeps the same engine and workspace — only the model differs.
    expect(retry.provider).toBe(store.getTask(task.id)!.provider);
    // A switch cannot carry the previous model's provider session, so the chain
    // restarts the provider conversation rather than resuming it.
    expect(retry.sessionId).toBeNull();
    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
  });

  it("dispatches the fallback model to the execution engine and records it", () => {
    const { store, runtime, agent, issue } = fixture();
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Run the fallback" });
    failClaimed(store, runtime.id, task.id, NO_ACCOUNT_ERROR);
    const retry = successor(store, task.id)!;

    // The engine runs whatever model the claim hands it, so the override has to
    // survive all the way to the daemon payload — otherwise the recovery chain
    // would re-run the exhausted primary model and fail again.
    const recovered = store.claimTask(runtime.id)!;
    expect(recovered.id).toBe(retry.id);
    const claimAgent = daemonTaskClaimResponse(store, recovered).agent as Record<string, unknown>;
    expect(claimAgent).toMatchObject({ model: FALLBACK, thinking_level: "high", fallback_model: "" });

    // The record view names the model that really ran, why, and that the chain
    // already spent its switch (requirement 9).
    expect(taskCompatibilityResponse(store.getTask(retry.id)!)).toMatchObject({
      execution_model: FALLBACK,
      executionModel: FALLBACK,
      fallback_switched: true,
      fallbackSwitched: true,
      switch_reason: `gateway_resource:${TaskFailureReason.AgentProviderNoAvailableAccount};provider_session_reset`,
    });

    // An independent task still hands the engine the primary selection, with the
    // configured fallback available for its own future recovery.
    const otherIssue = createResponsibleTestIssue(store, {
      title: "Independent", assigneeType: "agent", assigneeId: agent.id,
    });
    const plain = store.createTask({ agentId: agent.id, issueId: otherIssue.id, prompt: "Primary again" });
    const plainClaim = store.claimTask(runtime.id)!;
    expect(plainClaim.id).toBe(plain.id);
    expect(daemonTaskClaimResponse(store, plainClaim).agent as Record<string, unknown>).toMatchObject({
      model: PRIMARY, thinking_level: "high", fallback_model: FALLBACK, fallback_thinking_level: "high",
    });
  });

  it("prefers the primary model again for the next independent task", () => {
    const { store, runtime, agent, issue } = fixture();
    const first = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "First" });
    failClaimed(store, runtime.id, first.id, NO_ACCOUNT_ERROR);
    expect(successor(store, first.id)!.executionModel).toBe(FALLBACK);

    const independentIssue = createResponsibleTestIssue(store, { title: "Independent primary-model lane" });
    const independent = store.createTask({ agentId: agent.id, issueId: independentIssue.id, prompt: "Second" });
    expect(independent.executionModel).toBeNull();
    expect(independent.fallbackSwitched).toBe(false);
    // The queued fallback retry is older, so it is claimed first — and it is the
    // only task on the fallback model.
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.executionModel).toBe(FALLBACK);
    expect(store.getTask(independent.id)).toMatchObject({
      status: "queued", executionModel: null, fallbackSwitched: false,
    });
  });

  it("judges runtime capability on the task's actual model, not the Agent's", () => {
    const { store, runtime, agent, issue } = fixture();
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Switch then route" });
    failClaimed(store, runtime.id, task.id, NO_ACCOUNT_ERROR);
    const retry = successor(store, task.id)!;

    // The gateway now only advertises the fallback model: this machine can no
    // longer execute the Agent's primary selection.
    store.updateRuntimeModels(runtime.id, [model(FALLBACK)]);
    const nextIssue = createResponsibleTestIssue(store, { title: "Independent capability probe" });
    const next = store.createTask({ agentId: agent.id, issueId: nextIssue.id, prompt: "Primary only" });
    // The queued retry still runs, because the capability that matters is the
    // one the task will actually execute with (requirement 6) ...
    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
    // ... while the fresh task on the primary model is left queued rather than
    // dispatched to a machine that cannot execute it.
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(next.id)?.status).toBe("queued");
    expect(store.getTask(retry.id)?.executionModel).toBe(FALLBACK);
  });

  it("switches at most once and ends the chain when the fallback is exhausted too", () => {
    const { store, runtime, agent, issue } = fixture();
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Bound the chain" });
    failClaimed(store, runtime.id, task.id, NO_ACCOUNT_ERROR);
    const retry = successor(store, task.id)!;

    failClaimed(store, runtime.id, retry.id, "503 no available accounts for model fallback-deepseek");

    expect(successor(store, retry.id)).toBeNull();
    const ended = store.getTask(retry.id)!;
    expect(ended).toMatchObject({
      status: "failed",
      executionModel: FALLBACK,
      fallbackSwitched: true,
      failureReason: TaskFailureReason.AgentProviderNoAvailableAccount,
    });
    expect(store.listTasks().filter((candidate) => candidate.parentTaskId === retry.id)).toHaveLength(0);
  });

  it("keeps the previous bounded failure when no fallback model is configured", () => {
    const { store, runtime, agent, issue } = fixture({ fallback: false });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "No fallback" });

    failClaimed(store, runtime.id, task.id, NO_ACCOUNT_ERROR);

    expect(successor(store, task.id)).toBeNull();
    expect(store.getTask(task.id)).toMatchObject({
      status: "failed",
      failureReason: TaskFailureReason.AgentProviderNoAvailableAccount,
      executionModel: null,
    });
  });

  it.each([
    ["an auth failure", "API Error: 401 Unauthorized", TaskFailureReason.AgentProviderAuthOrAccess],
    ["a tool/business failure", "agent exit status 1", TaskFailureReason.AgentProcessFailure],
    ["a context overflow", "prompt is too long: maximum context length exceeded", TaskFailureReason.AgentContextOverflow],
  ])("never spends the switch on %s", (_label, error, reason) => {
    const { store, runtime, agent, issue } = fixture();
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Not a resource fault" });

    failClaimed(store, runtime.id, task.id, error);

    expect(store.getTask(task.id)?.failureReason).toBe(reason);
    // Some of these reasons legitimately auto-retry the SAME model; none of them
    // may smuggle in the fallback model.
    const retry = successor(store, task.id);
    if (retry) {
      expect(retry).toMatchObject({ executionModel: null, fallbackSwitched: false, switchReason: null });
    }
  });

  it.each([
    ["Error: model primary-gpt not found in this workspace", TaskFailureReason.AgentModelNotFoundOrUnavailable],
    ["Compacting failed: unexpected status 503", TaskFailureReason.AgentProviderServerError],
  ])("switches once on unavailable model/server errors: %s", (error, reason) => {
    const { store, runtime, agent, issue } = fixture();
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Recover availability" });
    failClaimed(store, runtime.id, task.id, error);
    expect(store.getTask(task.id)).toMatchObject({ status: "failed", failureReason: reason });
    const retry = successor(store, task.id)!;
    expect(retry).toMatchObject({ executionModel: FALLBACK, fallbackSwitched: true, sessionId: null });
    expect(retry.switchReason).toBe(`gateway_resource:${reason};provider_session_reset`);
    expect(store.getIssue(issue.id)?.status).toBe("in_progress");
    failClaimed(store, runtime.id, retry.id, "HTTP 503");
    expect(successor(store, retry.id)).toBeNull();
    expect(store.getIssue(issue.id)?.status).toBe("blocked");
  });

  it.each([
    "Error: model primary-gpt not found",
    "unexpected status 503",
  ])("blocks without a configured fallback: %s", (error) => {
    const { store, runtime, agent, issue } = fixture({ fallback: false });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Report failure" });
    failClaimed(store, runtime.id, task.id, error);
    expect(successor(store, task.id)).toBeNull();
    expect(store.getIssue(issue.id)?.status).toBe("blocked");
  });

  it("switches capability-starved queued tasks at five minutes through the recovery chain", () => {
    const { store, runtime, agent, issue } = fixture();
    store.updateRuntimeModels(runtime.id, [model(FALLBACK)]);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Queued availability" });
    const created = Date.parse(task.createdAt);
    store.refreshQueuedCapabilityWaitReasons(created + 4 * 60_000);
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.getTask(task.id)?.waitReason).toContain("等待模型能力恢复");
    expect(successor(store, task.id)).toBeNull();
    store.refreshQueuedCapabilityWaitReasons(created + 5 * 60_000);
    expect(store.getTask(task.id)).toMatchObject({
      status: "failed", failureReason: TaskFailureReason.QueuedModelUnavailable, waitReason: null,
    });
    const retry = successor(store, task.id)!;
    expect(retry).toMatchObject({ status: "queued", executionModel: FALLBACK, fallbackSwitched: true, attempt: 2 });
    expect(retry.switchReason).toBe(`gateway_resource:${TaskFailureReason.QueuedModelUnavailable};provider_session_reset`);
    expect(store.getIssue(issue.id)?.status).toBe("todo");
    store.refreshQueuedCapabilityWaitReasons(created + 15 * 60_000);
    expect(store.listTasks().filter((candidate) => candidate.parentTaskId === task.id)).toHaveLength(1);
    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
  });

  it("keeps queued fallback creation atomic and publishes events only after commit", () => {
    const { store, runtime, agent, issue } = fixture();
    store.updateRuntimeModels(runtime.id, [model(FALLBACK)]);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Atomic queue switch" });
    const events: string[] = [];
    store.onTaskEnqueued((retry) => events.push(`queued:${retry.id}`));
    store.onTaskEvent(({ type, task: updated }) => {
      if (type !== "task:failed" || updated.id !== task.id) return;
      expect(successor(store, task.id)?.status).toBe("queued");
      events.push(`failed:${updated.id}`);
    });
    const repo = (store as any).tasks;
    const insert = spyOn(repo, "createRetryAttemptWithinWorkspaceLock").mockImplementation(() => {
      throw new Error("retry insert rejected");
    });
    const now = Date.parse(task.createdAt) + 5 * 60_000;
    try {
      expect(() => store.refreshQueuedCapabilityWaitReasons(now)).toThrow("retry insert rejected");
    } finally {
      insert.mockRestore();
    }
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", failureReason: null, error: null });
    expect(successor(store, task.id)).toBeNull();
    expect(events).toEqual([]);
    store.refreshQueuedCapabilityWaitReasons(now);
    expect(events).toEqual([`queued:${successor(store, task.id)!.id}`, `failed:${task.id}`]);
  });

  it("switches on a pinned Runtime only when that same Runtime supports the fallback", () => {
    const { store, runtime, agent, issue } = fixture();
    store.updateRuntimeModels(runtime.id, [model(FALLBACK)]);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, runtimeId: runtime.id, prompt: "Pinned availability" });
    store.refreshQueuedCapabilityWaitReasons(Date.parse(task.createdAt) + 5 * 60_000);
    expect(store.getTask(task.id)?.failureReason).toBe(TaskFailureReason.QueuedModelUnavailable);
    const retry = successor(store, task.id)!;
    expect(retry).toMatchObject({ executionModel: FALLBACK, fallbackSwitched: true });
    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
  });

  it.each(["no fallback", "already switched", "attempt limit", "pinned runtime"])("keeps capability waits when switching is ineligible: %s", (scenario) => {
    const { store, runtime, agent, issue } = fixture({ fallback: scenario !== "no fallback" });
    store.updateRuntimeModels(runtime.id, scenario === "pinned runtime" ? [model(PRIMARY, false)] : [model(FALLBACK)]);
    if (scenario === "pinned runtime") {
      store.registerRuntime({ name: "Other gateway", provider: "claude", models: [model(FALLBACK)] });
    }
    const task = store.createTask({
      agentId: agent.id, issueId: issue.id, prompt: "Bounded queue policy",
      ...(scenario === "already switched" ? { fallbackSwitched: true } : {}),
      ...(scenario === "attempt limit" ? { attempt: 3, maxAttempts: 3 } : {}),
      ...(scenario === "pinned runtime" ? { runtimeId: runtime.id } : {}),
    });
    const result = store.refreshQueuedCapabilityWaitReasons(Date.parse(task.createdAt) + 15 * 60_000);
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(successor(store, task.id)).toBeNull();
    expect(result.alerted).toBe(1);
  });

  it("defers a throttled retry on the same model and honours Retry-After", () => {
    const { store, runtime, agent, issue } = fixture();
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Throttled" });

    failClaimed(store, runtime.id, task.id, "429 rate limit reached; retry-after: 300");

    const retry = successor(store, task.id)!;
    expect(retry).toMatchObject({
      status: "queued",
      failureReason: null,
      executionModel: null,
      fallbackSwitched: false,
      attempt: 2,
    });
    expect(store.getTask(task.id)?.failureReason).toBe(TaskFailureReason.AgentProviderCapacityOrRateLimit);
    // The provider's own window wins over the exponential fallback backoff.
    const waitMs = Date.parse(retry.nextRetryAt!) - Date.now();
    expect(waitMs).toBeGreaterThan(290_000);
    expect(waitMs).toBeLessThanOrEqual(300_000);
    // Deferred work must not be claimed early — that is the whole point of
    // honouring Retry-After instead of hammering a shared account pool.
    expect(store.claimTask(runtime.id)).toBeNull();
    runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET next_retry_at = ? WHERE id = ?", [
      new Date(Date.now() - 1_000).toISOString(), retry.id,
    ]);
    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
  });

  it("isolates concurrent tasks of the same Agent", () => {
    const { store, runtime, agent, issue } = fixture();
    const chatIssue = createResponsibleTestIssue(store, {
      title: "Parallel work", assigneeType: "agent", assigneeId: agent.id,
    });
    const first = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "A" });
    const second = store.createTask({ agentId: agent.id, issueId: chatIssue.id, prompt: "B" });

    failClaimed(store, runtime.id, first.id, NO_ACCOUNT_ERROR);

    expect(store.getTask(first.id)?.fallbackSwitched).toBe(false);
    expect(successor(store, first.id)!.executionModel).toBe(FALLBACK);
    // The sibling never ran and must stay on the primary model.
    expect(store.getTask(second.id)).toMatchObject({
      status: "queued", executionModel: null, fallbackSwitched: false,
    });
    const retry = successor(store, first.id)!;
    const claimed = [store.claimTask(runtime.id)?.id, store.claimTask(runtime.id)?.id].sort();
    expect(claimed).toEqual([retry.id, second.id].sort());
    expect(store.getTask(second.id)?.executionModel).toBeNull();
    expect(store.getTask(retry.id)?.executionModel).toBe(FALLBACK);
  });

  it("hands an automation run to the retry and reports the run's real outcome once", () => {
    const store = createStore();
    const owner = store.createWorkspaceMember({ id: "mem_fallback_owner", name: "Fallback Owner" });
    const runtime = store.registerRuntime({
      name: "Automation gateway", provider: "claude", ownerId: owner.id, maxConcurrency: 4,
      models: [model(PRIMARY), model(FALLBACK)],
    });
    const agent = store.createAgent({
      name: "Automation", provider: "claude", ownerId: owner.id, model: PRIMARY, thinkingLevel: "high",
      fallbackModel: FALLBACK, fallbackThinkingLevel: "high",
    });
    const autopilot = store.createAutopilot({
      title: "Nightly sweep",
      assigneeId: agent.id,
      issueTitleTemplate: "Nightly sweep",
      createdByType: "member",
      createdById: owner.id,
    });
    const run = store.runAutopilot(autopilot.id);
    store.updateIssue(run.issueId!, { status: "in_progress" });

    failClaimed(store, runtime.id, run.taskId!, NO_ACCOUNT_ERROR);

    // Requirement 8: the run is NOT terminal yet, so the owner must not be told
    // the automation failed while the fallback still has its turn.
    const retry = successor(store, run.taskId!)!;
    expect(retry).toMatchObject({ executionModel: FALLBACK, fallbackSwitched: true });
    expect(store.getTask(retry.id)?.autopilotRunId).toBe(run.id);
    expect(store.getAutopilotRun(run.id)).toMatchObject({ status: "running", completedAt: null });
    expect(store.listInboxItems(owner.id).filter((item) => item.type.startsWith("autopilot_run"))).toHaveLength(0);

    // The fallback finishes the work: the run succeeds and is announced once.
    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
    store.startTask(retry.id);
    store.completeTask(retry.id, { output: "Sweep complete on the fallback model" });

    expect(store.getAutopilotRun(run.id)).toMatchObject({ status: "completed" });
    const notifications = store.listInboxItems(owner.id).filter((item) => item.type.startsWith("autopilot_run"));
    expect(notifications.map((item) => item.type)).toEqual(["autopilot_run_completed"]);
  });

  it("ends an automation run once when the fallback fails too", () => {
    const store = createStore();
    const owner = store.createWorkspaceMember({ id: "mem_fallback_owner_2", name: "Fallback Owner" });
    const runtime = store.registerRuntime({
      name: "Automation gateway", provider: "claude", ownerId: owner.id, maxConcurrency: 4,
      models: [model(PRIMARY), model(FALLBACK)],
    });
    const agent = store.createAgent({
      name: "Automation", provider: "claude", ownerId: owner.id, model: PRIMARY, thinkingLevel: "high",
      fallbackModel: FALLBACK, fallbackThinkingLevel: "high",
    });
    const autopilot = store.createAutopilot({
      title: "Nightly sweep",
      assigneeId: agent.id,
      issueTitleTemplate: "Nightly sweep",
      createdByType: "member",
      createdById: owner.id,
    });
    const run = store.runAutopilot(autopilot.id);
    store.updateIssue(run.issueId!, { status: "in_progress" });

    failClaimed(store, runtime.id, run.taskId!, NO_ACCOUNT_ERROR);
    const retry = successor(store, run.taskId!)!;
    failClaimed(store, runtime.id, retry.id, "503 no available accounts for model fallback-deepseek");

    expect(successor(store, retry.id)).toBeNull();
    expect(store.getAutopilotRun(run.id)).toMatchObject({ status: "failed" });
    const notifications = store.listInboxItems(owner.id).filter((item) => item.type.startsWith("autopilot_run"));
    expect(notifications.map((item) => item.type)).toEqual(["autopilot_run_failed"]);
  });

  it("keeps a Chat turn on the fallback and appends the assistant reply once", () => {
    const { store, runtime, agent } = fixture();
    const chat = store.createChatSession({ agentId: agent.id });
    const turn = store.sendChatMessage(chat.id, { body: "Ship it" }).task;

    failClaimed(store, runtime.id, turn.id, NO_ACCOUNT_ERROR);

    // No "task failed" bubble while the chain is still running.
    expect(store.listChatMessages(chat.id).map((message) => message.role)).toEqual(["user"]);
    const retry = successor(store, turn.id)!;
    expect(retry).toMatchObject({ executionModel: FALLBACK, chatSessionId: chat.id, issueId: null });
    expect(store.getChatSession(chat.id)?.latestTaskId).toBe(retry.id);

    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
    store.startTask(retry.id);
    store.completeTask(retry.id, { output: "Shipped on the fallback" });

    const messages = store.listChatMessages(chat.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages.at(-1)?.body).toBe("Shipped on the fallback");
  });

  it("carries the switch through a delegated child and reports back to the delegator once", () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "claude" });
    const teammate = store.createAgent({
      name: "Teammate", provider: "claude", model: PRIMARY, thinkingLevel: "high",
      fallbackModel: FALLBACK, fallbackThinkingLevel: "high",
    });
    store.registerRuntime({
      name: "Gateway", provider: "claude", maxConcurrency: 4,
      models: [model(PRIMARY), model(FALLBACK)],
    });
    const runtime = store.listRuntimes()[0]!;
    const issue = createResponsibleTestIssue(store, { title: "Delegated work", assigneeType: "agent", assigneeId: leader.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const child = store.createTask({
      agentId: teammate.id, issueId: issue.id, issueSessionId: session.id,
      delegationId: "dlg_fallback", delegatedByAgentId: leader.id,
      prompt: "Implement it",
    });

    failClaimed(store, runtime.id, child.id, NO_ACCOUNT_ERROR);

    const retry = successor(store, child.id)!;
    expect(retry).toMatchObject({
      executionModel: FALLBACK,
      fallbackSwitched: true,
      delegationId: "dlg_fallback",
      delegatedByAgentId: leader.id,
      issueSessionId: session.id,
    });
    // The delegator hears nothing until the chain actually ends.
    expect(store.listTasksForIssue(issue.id).filter((task) => task.agentId === leader.id)).toHaveLength(0);

    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
    store.startTask(retry.id);
    store.completeTask(retry.id, { output: "Done by the fallback model" });

    const returns = store.listTasksForIssue(issue.id)
      .filter((task) => task.agentId === leader.id && task.delegationId === "dlg_fallback");
    expect(returns).toHaveLength(1);
    expect(returns[0]!.parentTaskId).toBeNull();
    expect(store.getMessage(returns[0]!.triggerCommentId!)?.task_id).toBe(store.getTurnForAttempt(retry.id)!.id);
  });

  it("runs a switched task on the fallback's own level when the Agent configured none", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      name: "Gateway", provider: "claude", maxConcurrency: 4,
      models: [modelWithLevels(PRIMARY, ["high"]), modelWithLevels(FALLBACK, ["low"])],
    });
    const agent = store.createAgent({
      name: "Level mismatch", provider: "claude", maxConcurrentTasks: 4,
      model: PRIMARY, thinkingLevel: "high", fallbackModel: FALLBACK,
    });
    const issue = createResponsibleTestIssue(store, {
      title: "Level mismatch", assigneeType: "agent", assigneeId: agent.id,
    });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Recover at another level" });

    failClaimed(store, runtime.id, task.id, NO_ACCOUNT_ERROR);
    const retry = successor(store, task.id)!;
    // The Agent's 'high' was chosen for the primary model and the fallback does
    // not accept it, so the chain must not carry it across as an override.
    expect(retry.executionModel).toBe(FALLBACK);
    expect(retry.executionThinkingLevel).toBeNull();

    // The recovered task must actually be claimable: pinning the primary's level
    // leaves every Runtime rejecting the fallback model, and the task waits
    // forever instead of recovering.
    const recovered = store.claimTask(runtime.id);
    expect(recovered?.id).toBe(retry.id);
    const claimAgent = daemonTaskClaimResponse(store, recovered!).agent as Record<string, unknown>;
    // An empty level means "the engine's default for THIS model", which for the
    // fallback is its own 'low' rather than the primary's 'high'.
    expect(claimAgent).toMatchObject({ model: FALLBACK, thinking_level: "" });
  });

  it("ends a throttled chain instead of retrying inside a Retry-After window it cannot honour", () => {
    const { store, runtime, agent, issue } = fixture();
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Long throttle" });

    failClaimed(store, runtime.id, task.id, "429 Too Many Requests; Retry-After: 3600");

    expect(store.getTask(task.id)).toMatchObject({
      status: "failed",
      failureReason: TaskFailureReason.AgentProviderCapacityOrRateLimit,
    });
    // The gateway said the pool is unavailable for an hour: retrying at the
    // short backoff would fire inside that window and hammer the same pool, so
    // the chain ends instead and keeps the throttle as its reported reason.
    expect(successor(store, task.id)).toBeNull();
    expect(store.claimTask(runtime.id)).toBeNull();
  });
});
