// What happens while a claimed task runs: ACP message ingress, completion
// side effects (issue comments, realtime events), per-agent/per-runtime capacity,
// and the runtime ownership + lifecycle analytics that gate claiming.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createAdapter } from "@acp/index.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { createEventMapper } from "@multiremi/daemon.js";
import { createStore, db, metricValue, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — task message ingress, completion, and capacity", () => {
  it("replays a turn-ending compaction without replacing the task or issue reply", () => {
    const frames = JSON.parse(readFileSync(
      new URL("../../fixtures/acp/claude-compaction-tail-notifications-1787700000000.json", import.meta.url),
      "utf-8",
    )) as Array<{ params?: { update?: Record<string, unknown> } }>;
    const map = createEventMapper(createAdapter("claude"));
    const messages = frames.flatMap((frame) => frame.params?.update
      ? map(frame.params.update as unknown as ProviderEvent)
      : []);
    const output = messages
      .filter((message) => message.type === "text")
      .map((message) => message.content ?? "")
      .join("")
      .trim();

    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_compaction", name: "compaction", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Compaction Bot", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Compaction tail", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "fix it" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.appendTaskMessages(task.id, messages.map((message, index) => ({ ...message, seq: index + 1 })));
    store.completeTask(task.id, { output });

    expect(messages.map((message) => message.type)).toEqual(["text", "compaction", "compaction"]);
    expect(store.getTask(task.id)?.result).toBe("Implemented the fix and verified the targeted tests.");
    expect(store.listIssueComments(issue.id).at(-1)?.body).toBe("Implemented the fix and verified the targeted tests.");
    expect(store.getTask(task.id)?.result).not.toContain("Compacting");
    expect(store.listIssueComments(issue.id).at(-1)?.body).not.toContain("Compacting");

    const persisted = store.listTaskMessages(task.id);
    const finalAnswer = [...persisted].reverse().find((message) => message.type === "text" && message.content?.trim());
    expect(finalAnswer?.content).toBe("Implemented the fix and verified the targeted tests.");
  });

  it("round-trips ACP tool-call semantics (tool_call_id/status/meta) and fires onTaskMessages", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_acp_semantics", name: "acp", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "ACP Bot", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "ACP", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "x" });

    const fired: number[] = [];
    const unsub = store.onTaskMessages(({ task: t, messages }) => {
      expect(t.id).toBe(task.id);
      fired.push(messages.length);
    });

    store.appendTaskMessages(task.id, [
      { seq: 1, type: "tool_use", tool: "Bash", input: { command: "ls" }, toolCallId: "tc_1", status: "in_progress", meta: { title: "Bash", locations: [{ path: "/a" }] } },
    ]);
    // A tool_call_update sharing the seq upserts the same row (terminal state).
    store.appendTaskMessages(task.id, [
      { seq: 1, type: "tool_result", tool: "Bash", output: "ok", toolCallId: "tc_1", status: "completed", meta: { duration_ms: 42 } },
    ]);

    const rows = store.listTaskMessages(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolCallId: "tc_1", status: "completed", type: "tool_result", output: "ok" });
    expect(rows[0]!.meta).toMatchObject({ duration_ms: 42 });
    expect(fired).toEqual([1, 1]);
    unsub();
  });

  it("masks sensitive keys and byte-caps oversized fields on the message ingress", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_caps", name: "caps", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Caps Bot", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Caps", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "x" });

    const big = "a".repeat(200_000);
    store.appendTaskMessages(task.id, [
      { type: "tool_result", tool: "Bash", output: big, status: "not-a-real-status" },
    ]);
    const row = store.listTaskMessages(task.id)[0]!;
    expect((row.output ?? "").length).toBeLessThan(big.length);
    expect(row.output).toContain("[truncated]");
    // an unknown status is dropped to null
    expect(row.status).toBeNull();
  });

  it("posts the agent's final reply as an issue comment on completion", async () => {
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
    // The reply carries its run so the chat stream can open that transcript.
    expect(comments[0]).toMatchObject({ taskId: task.id, task_id: task.id });
    // A human comment has no run attached.
    expect(store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "谢谢" }).taskId).toBeNull();

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
    expect(reply?.taskId).toBe(mentionTask.id);

    // …and reaches the browser through the timeline wire, where the chat
    // stream reads it to offer that run's transcript.
    const app = createMultiremiApp({ store });
    const timeline = await (await app.request(`/api/issues/${issue.id}/timeline`)).json();
    const agentEntry = timeline.find((entry: { id: string }) => entry.id === comments[0]!.id);
    expect(agentEntry).toMatchObject({ actor_type: "agent", task_id: task.id });

    // Placeholder / empty outputs post nothing.
    const silent = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "quiet" });
    expect(store.claimTask(runtime.id)?.id).toBe(silent.id);
    store.startTask(silent.id);
    const before = store.listIssueComments(issue.id).length;
    store.completeTask(silent.id, { output: "Task completed." });
    expect(store.listIssueComments(issue.id)).toHaveLength(before);
  });

  it("does not double-post when the agent already replied itself during the run", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_no_dup", name: "no dup", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Self Bot", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "架构", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "总结架构" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);

    // Agent posts its own formatted reply via a tool during execution.
    store.createIssueComment(issue.id, { authorType: "agent", authorId: agent.id, body: "## 架构\n1. Hub-and-Spoke…" });
    const afterSelfReply = store.listIssueComments(issue.id).length;

    // Completion must NOT append a second (narration-heavy) comment.
    store.completeTask(task.id, { output: "Let me read the conversation…Now I'll post the reply.回复已发布。" });
    expect(store.listIssueComments(issue.id)).toHaveLength(afterSelfReply);
  });

  // Agent-driven writes bypass the HTTP layer, where issue events are normally
  // published — the store must broadcast them itself or open issue pages only
  // see the result after a manual refresh.
  it("broadcasts comment:created / activity:created / issue:updated when an agent completes an issue task", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_ws_events", name: "ws events", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Event Bot", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "实时推送", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "回答" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);

    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown> }> = [];
    store.onWorkspaceEvent((event) => events.push(event));
    store.completeTask(task.id, { output: "答案在此。" });

    const commentEvent = events.find((e) => e.type === "comment:created");
    expect(commentEvent?.workspaceId).toBe("local");
    expect(commentEvent?.payload.comment).toMatchObject({
      issue_id: issue.id,
      content: "答案在此。",
      author_type: "agent",
      author_id: agent.id,
    });

    const activityEvent = events.find((e) => e.type === "activity:created");
    expect(activityEvent?.payload.issue_id).toBe(issue.id);
    expect(activityEvent?.payload.entry).toMatchObject({
      type: "activity",
      action: "task_completed",
      actor_type: "agent",
      actor_id: agent.id,
    });

    const issueEvent = events.find((e) => e.type === "issue:updated");
    expect(issueEvent?.workspaceId).toBe("local");
    expect(issueEvent?.payload.issue).toMatchObject({ id: issue.id, status: "in_review" });
    expect(issueEvent?.payload.status_changed).toBe(true);
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
    expect(store.getIssue(issueA.id)?.status).toBe("todo");
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

  it("keeps a dispatched task claimed while its daemon renews the preparation lease", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex", maxConcurrency: 1 });
    const task = store.createTask({ agentId: agent.id, prompt: "Wait for workspace preparation" });

    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const stale = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ?, updated_at = ? WHERE id = ?", [stale, stale, task.id]);

    const renewed = store.renewTaskDispatchLease(task.id);
    expect(renewed.status).toBe("dispatched");
    expect(Date.parse(renewed.dispatchedAt!)).toBeGreaterThan(Date.parse(stale));
    expect(store.claimTask(runtime.id)).toBeNull();
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
      metadata: { version: "1.0.0", cli_version: "0.2.26", launched_by: "desktop" },
      models: [{ id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true }],
    });
    const firstIssue = store.createIssue({ title: "First usage task", assigneeType: "agent", assigneeId: agent.id });
    const secondIssue = store.createIssue({ title: "Second usage task", assigneeType: "agent", assigneeId: agent.id });
    const first = store.createTask({ agentId: agent.id, issueId: firstIssue.id, prompt: "First" });
    const second = store.createTask({ agentId: agent.id, issueId: secondIssue.id, prompt: "Second" });

    expect(runtime.ownerId).toBe(member.id);
    expect(runtime.runtimeMode).toBe("local");
    expect(runtime.deviceInfo).toBe("Laptop · 1.0.0");
    expect(runtime.metadata).toMatchObject({ version: "1.0.0", cli_version: "0.2.26", launched_by: "desktop" });
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
});
