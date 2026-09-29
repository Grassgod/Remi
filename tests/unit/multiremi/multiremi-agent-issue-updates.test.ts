import { beforeEach, expect, it } from "bun:test";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";
import { installPendingTurnTestConstraints, pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("MUL-486 relay Issue log", (fixture) => {
  beforeEach(() => installPendingTurnTestConstraints(fixture()));

  function setup() {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Relay", provider: "codex", maxConcurrentTasks: 4 });
    const issue = f.store.createIssue({ title: "Relay log", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const chat = f.store.createChatSession({ agentId: agent.id });
    bindFeishuTopicFixture(f.store, f.db, chat.id, issue.id);
    const runtime = f.store.registerRuntime({ name: "Relay test runtime", provider: "codex", maxConcurrency: 4 });
    const legacyRows = () => Number((f.db.query("SELECT COUNT(*) AS count FROM multiremi_agent_issue_update_state").get() as { count: number }).count);
    const lane = () => f.store.getSessionAgentLane(session.id, agent.id, `relay:${chat.id}`);
    const reports = () => f.store.listChatMessages(chat.id).filter(message => message.role === "system" && message.body.includes(issue.key));
    return { ...f, agent, issue, session, chat, runtime, lane, reports, legacyRows };
  }

  for (const status of ["failed", "cancelled"] as const) {
    it(`reports a ${status} Issue round and advances the cursor only after relay completion`, () => {
      const f = setup();
      const before = f.legacyRows();
      const task = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Work on the Issue" });
      expect(f.store.claimTask(f.runtime.id)?.id).toBe(task.id);
      f.store.startTask(task.id);
      if (status === "failed") f.store.failTask(task.id, { error: "Known failure", failureReason: "agent_error" });
      else f.store.cancelTask(task.id);
      expect(f.reports()).toHaveLength(1);
      expect(f.reports()[0]!.body).toContain(`状态 ${status}`);
      const entry = f.store.listConversationLogShown(f.chat.id).find(item => item.id === f.reports()[0]!.id)!;
      expect(entry.metadata.envelope).toMatchObject({ kind: "report", outcome: status, wake: "now" });
      const relay = f.store.listTasks().find(item => item.chatSessionId === f.chat.id && item.wakeSource === "relay")!;
      expect(relay).toBeDefined();
      expect(f.lane()?.cursorSeq).toBe(0);
      expect(f.store.claimTask(f.runtime.id)?.id).toBe(relay.id);
      const log = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(relay.id)!).bound_issue_log as {
        session_id: string; from_seq: number; to_seq: number; content_jsonl: string;
      };
      expect(log.session_id).toBe(f.session.id);
      expect(log.from_seq).toBe(0);
      expect(log.to_seq).toBeGreaterThan(0);
      expect(log.content_jsonl).toContain("inbox_toc");
      expect(log.content_jsonl).toContain(`"status":"${status}"`);
      expect(f.lane()?.cursorSeq).toBe(0);
      f.store.startTask(relay.id);
      f.store.completeTask(relay.id, { output: "Reported to Feishu" });
      expect(f.lane()?.cursorSeq).toBe(log.to_seq);
      expect(f.legacyRows()).toBe(before);
    });
  }

  it("deduplicates a repeated round trigger and reads only the next interval", () => {
    const f = setup();
    const first = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "First round" });
    f.store.claimTask(f.runtime.id);
    f.store.startTask(first.id);
    f.store.completeTask(first.id, { output: "First result" });
    const relay = f.store.listTasks().find(task => task.chatSessionId === f.chat.id && task.wakeSource === "relay")!;
    f.store.claimTask(f.runtime.id);
    const firstLog = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(relay.id)!).bound_issue_log as { to_seq: number };
    f.store.startTask(relay.id);
    f.store.completeTask(relay.id, { output: "First summary" });
    expect(f.lane()?.cursorSeq).toBe(firstLog.to_seq);
    const duplicate = f.transaction(() => f.store.sendEnvelopeWithinTransaction({
      to: { role: "relay", issueId: f.issue.id }, kind: "report", outcome: "done", wake: "now",
      dedupeKey: `relay:${f.issue.id}:${first.id}`, body: "Repeated terminal hook", source: { issueId: f.issue.id, taskId: first.id },
    }, [], createCommitEventQueue()));
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]).toMatchObject({ deduplicated: true, action: "none" });
    expect(f.reports()).toHaveLength(1);
    const second = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Second round" });
    f.store.claimTask(f.runtime.id);
    f.store.startTask(second.id);
    f.store.completeTask(second.id, { output: "Second result" });
    const nextRelay = f.store.listTasks().find(task => task.chatSessionId === f.chat.id && task.status === "queued")!;
    f.store.claimTask(f.runtime.id);
    const nextLog = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(nextRelay.id)!).bound_issue_log as {
      from_seq: number; to_seq: number; content_jsonl: string;
    };
    expect(nextLog.from_seq).toBe(firstLog.to_seq);
    expect(nextLog.to_seq).toBeGreaterThan(firstLog.to_seq);
    expect(nextLog.content_jsonl).toContain("Second result");
    expect(nextLog.content_jsonl).not.toContain("First result");
    expect(JSON.parse(nextLog.content_jsonl.split("\n")[0]!).from_seq).toBe(firstLog.to_seq);
  });

  it("waits for the final active Issue task regardless of its assignee", () => {
    const f = setup();
    const other = f.store.createAgent({ name: "Contributor", provider: "codex", maxConcurrentTasks: 4 });
    const first = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "First" });
    const second = f.store.createSessionTask(f.session.id, { agentId: other.id, prompt: "Second" });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(first.id);
    f.store.startTask(first.id);
    f.store.failTask(first.id, { error: "Failed while contributor is pending", failureReason: "agent_error" });
    expect(f.reports()).toHaveLength(0);
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(second.id);
    f.store.startTask(second.id);
    f.store.cancelTask(second.id);
    expect(f.reports()).toHaveLength(1);
    expect(f.reports()[0]!.body).toContain(second.id);
  });

  it("does not advance the relay lane after a failed chat task", () => {
    const f = setup();
    const first = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Issue work" });
    f.store.claimTask(f.runtime.id);
    f.store.startTask(first.id);
    f.store.completeTask(first.id, { output: "First result" });
    const relay = f.store.listTasks().find(task => task.chatSessionId === f.chat.id && task.wakeSource === "relay")!;
    f.store.claimTask(f.runtime.id);
    const firstLog = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(relay.id)!).bound_issue_log as { to_seq: number };
    f.store.startTask(relay.id);
    f.store.failTask(relay.id, { error: "Delivery failed", failureReason: "agent_error" });
    expect(f.lane()?.cursorSeq).toBe(0);
    const second = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Another round" });
    f.store.claimTask(f.runtime.id);
    f.store.startTask(second.id);
    f.store.completeTask(second.id, { output: "Second result" });
    const nextRelay = f.store.listTasks().find(task => task.chatSessionId === f.chat.id && task.status === "queued")!;
    f.store.claimTask(f.runtime.id);
    const nextLog = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(nextRelay.id)!).bound_issue_log as {
      from_seq: number; to_seq: number; content_jsonl: string;
    };
    expect(nextLog.from_seq).toBe(0);
    expect(nextLog.to_seq).toBeGreaterThan(firstLog.to_seq);
    expect(nextLog.content_jsonl).toContain("First result");
    expect(nextLog.content_jsonl).toContain("Second result");
  });

  it("caps claimed Issue log rows at 100 and provides a continuation cursor", () => {
    const f = setup();
    for (let index = 0; index < 110; index++) {
      f.store.createIssueComment(f.issue.id, {
        issueSessionId: f.session.id, authorType: "system", authorId: null,
        body: `Log item ${index.toString().padStart(3, "0")}`,
      });
    }
    const task = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Report the log" });
    f.store.claimTask(f.runtime.id);
    f.store.startTask(task.id);
    f.store.completeTask(task.id, { output: "Done" });
    const relay = f.store.listTasks().find(item => item.chatSessionId === f.chat.id && item.wakeSource === "relay")!;
    f.store.claimTask(f.runtime.id);
    const log = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(relay.id)!).bound_issue_log as {
      from_seq: number; to_seq: number; next_seq: number; has_more: boolean; content_jsonl: string;
    };
    expect(log.has_more).toBe(true);
    expect(log.next_seq).toBeLessThan(log.to_seq);
    const directory = JSON.parse(log.content_jsonl.split("\n")[1]!) as { entries: Array<{ seq: number }> };
    expect(directory.entries.length).toBeLessThanOrEqual(100);
    expect(log.content_jsonl).not.toContain("Log item 109");
  });

  it("hides system queue rows from user edits, priority, and removal", () => {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Relay queue", provider: "codex", maxConcurrentTasks: 4 });
    const issue = f.store.createIssue({ title: "Bound", status: "in_progress" });
    const chat = f.store.createChatSession({ agentId: agent.id });
    const runtime = f.store.registerRuntime({ name: "Chat", provider: "codex", maxConcurrency: 4 });
    const user = f.store.sendChatMessage(chat.id, { content: "Private turn" });
    f.store.claimTask(runtime.id);
    f.store.startTask(user.task.id);
    bindFeishuTopicFixture(f.store, f.db, chat.id, issue.id);
    const sent = f.transaction(() => f.store.sendEnvelopeWithinTransaction({
      to: { role: "chat", chatSessionId: chat.id, agentId: agent.id }, kind: "report", wake: "now",
      body: "Read bound Issue", source: { issueId: issue.id },
    }, [], createCommitEventQueue()))[0]!;
    expect(sent.action).toBe("created");
    expect(sent.task?.wakeSource).not.toBeNull();
    expect(f.store.listQueuedChatTasks(chat.id)).toEqual([]);
    expect(() => f.store.updateQueuedChatTask(chat.id, sent.task!.id, "Tampered")).toThrow();
    expect(() => f.store.prioritizeQueuedChatTask(chat.id, sent.task!.id)).toThrow();
    expect(() => f.store.removeQueuedChatTasks(chat.id, sent.task!.id)).toThrow();
    f.store.removeQueuedChatTasks(chat.id);
    expect(f.store.getTask(sent.task!.id)?.status).toBe("queued");
  });
});
