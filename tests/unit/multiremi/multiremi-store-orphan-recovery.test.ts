// Recovery of tasks a runtime abandoned, and the Go-compatible retry edge rules.
import { afterEach, describe, expect, it } from "bun:test";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — orphan recovery and retry rules", () => {
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
    });
    const chat = store.createChatSession({ agentId: agent.id, title: "Retry chat" });
    const chatTask = store.createTask({
      agentId: agent.id,
      chatSessionId: chat.id,
      prompt: "retry chat",
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

    // Provider sessions are runtime-owned state. The daemon reports them only
    // after a successful claim; pre-claim task input is not an established
    // Issue Session lane and is deliberately discarded at claim time.
    store.pinTaskSession(retryTask.id, "sess-issue", "/tmp/issue");
    store.pinTaskSession(chatTask.id, "sess-chat", "/tmp/chat");

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
    expect(store.getIssue(run.issueId!)?.status).toBe("blocked");
    expect(store.getIssue(exhaustedIssue.id)?.status).toBe("blocked");
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

  it("blocks an issue after its final failure and returns a cancellation to todo", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Terminal states", provider: "codex" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex" });

    const failedIssue = store.createIssue({ title: "Final failure", assigneeType: "agent", assigneeId: agent.id });
    const failedTask = store.createTask({
      agentId: agent.id,
      issueId: failedIssue.id,
      prompt: "fail",
      maxAttempts: 1,
    });
    expect(store.claimTask(runtime.id)?.id).toBe(failedTask.id);
    store.startTask(failedTask.id);
    store.failTask(failedTask.id, { error: "terminal", failureReason: "agent_error" });
    expect(store.getIssue(failedIssue.id)?.status).toBe("blocked");

    const cancelledIssue = store.createIssue({ title: "Cancelled", assigneeType: "agent", assigneeId: agent.id });
    const cancelledTask = store.createTask({ agentId: agent.id, issueId: cancelledIssue.id, prompt: "cancel" });
    expect(store.claimTask(runtime.id)?.id).toBe(cancelledTask.id);
    store.startTask(cancelledTask.id);
    store.cancelTask(cancelledTask.id);
    expect(store.getIssue(cancelledIssue.id)?.status).toBe("todo");
  });
});
