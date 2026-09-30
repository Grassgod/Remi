import { beforeEach, expect, it } from "bun:test";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { runMigrations } from "@multiremi/store/migrations.js";
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

  function claimRelayAfterCompletedIssueRound(f: ReturnType<typeof setup>) {
    const issueTask = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Issue work" });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(issueTask.id);
    f.store.startTask(issueTask.id);
    f.store.completeTask(issueTask.id, { output: "Issue result" });
    const relay = f.store.listTasks().find(task => task.chatSessionId === f.chat.id && task.wakeSource === "relay")!;
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(relay.id);
    return relay;
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

  it("keeps the relay cursor when claim log reading fails and replays the unread interval", () => {
    const f = setup();
    const relay = claimRelayAfterCompletedIssueRound(f);
    const toSeq = f.store.getBoundIssueLogToSeq(relay.id)!;
    expect(toSeq).toBe(3);
    const unreadSeqs = f.store.listConversationLogShown(f.session.id, { toSeq }).map(entry => entry.seq);
    const originalList = f.store.listConversationLogShown;
    f.store.listConversationLogShown = () => { throw new Error("injected relay log read failure"); };
    let response: Record<string, unknown>;
    try {
      response = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(relay.id)!);
    } finally {
      f.store.listConversationLogShown = originalList;
    }
    expect(response!.bound_issue_log).toBeUndefined();
    f.store.startTask(relay.id);
    f.store.completeTask(relay.id, { output: "Summary without log" });
    expect(f.lane()?.cursorSeq).toBe(0);

    const nextRelay = claimRelayAfterCompletedIssueRound(f);
    const nextLog = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(nextRelay.id)!).bound_issue_log as {
      from_seq: number; to_seq: number; content_jsonl: string;
    };
    expect(nextLog.from_seq).toBe(0);
    expect(nextLog.to_seq).toBeGreaterThan(toSeq);
    const deliveredSeqs = nextLog.content_jsonl.split("\n")
      .map(line => JSON.parse(line) as { type: string; seq?: number })
      .filter(line => line.type === "session_event")
      .map(line => line.seq);
    expect(deliveredSeqs).toEqual(expect.arrayContaining(unreadSeqs));
  });

  it("keeps the relay cursor when the claim delivery marker write fails", () => {
    const f = setup();
    const relay = claimRelayAfterCompletedIssueRound(f);
    const originalMark = f.store.markBoundIssueLogDelivered;
    f.store.markBoundIssueLogDelivered = () => { throw new Error("injected relay delivery marker failure"); };
    let response: Record<string, unknown>;
    try {
      response = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(relay.id)!);
    } finally {
      f.store.markBoundIssueLogDelivered = originalMark;
    }
    expect(response!.bound_issue_log).toMatchObject({ from_seq: 0, to_seq: 3 });
    const row = f.db.query("SELECT bound_issue_log_delivered_seq FROM multiremi_tasks WHERE id = ?")
      .get(relay.id) as { bound_issue_log_delivered_seq: number | null };
    expect(row.bound_issue_log_delivered_seq).toBeNull();
    f.store.startTask(relay.id);
    f.store.completeTask(relay.id, { output: "Summary after marker failure" });
    expect(f.lane()?.cursorSeq).toBe(0);
  });

  it("reports a zero-row delivery marker update without advancing the relay cursor", () => {
    const f = setup();
    const relay = claimRelayAfterCompletedIssueRound(f);
    expect(f.store.getBoundIssueLogToSeq(relay.id)).toBe(3);
    expect(f.store.markBoundIssueLogDelivered(relay.id, 4)).toBe(false);
    expect(f.db.query("SELECT bound_issue_log_delivered_seq FROM multiremi_tasks WHERE id = ?")
      .get(relay.id)).toEqual({ bound_issue_log_delivered_seq: null });
    f.store.startTask(relay.id);
    f.store.completeTask(relay.id, { output: "No matching delivery window" });
    expect(f.lane()?.cursorSeq).toBe(0);
  });

  it("replays the relay and pending-turn migrations twice without losing either column", () => {
    const f = setup();
    runMigrations(f.db);
    runMigrations(f.db);
    const task = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Migration check" });
    expect(f.db.query("SELECT bound_issue_log_to_seq, bound_issue_log_delivered_seq FROM multiremi_tasks WHERE id = ?")
      .get(task.id)).toEqual({ bound_issue_log_to_seq: null, bound_issue_log_delivered_seq: null });
    for (const id of ["20260929_relay_issue_log_to_seq", "20260929_relay_issue_log_delivered_seq", "20260929_tasks_one_pending_turn"]) {
      const row = f.db.query("SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = ?")
        .get(id) as { count: number | bigint };
      expect(Number(row.count)).toBe(1);
    }
  });

  it("clears a prior delivery marker before retrying a stale relay claim", () => {
    const f = setup();
    const relay = claimRelayAfterCompletedIssueRound(f);
    const firstLog = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(relay.id)!).bound_issue_log as {
      to_seq: number;
    };
    const deliveredSeq = () => (f.db.query("SELECT bound_issue_log_delivered_seq FROM multiremi_tasks WHERE id = ?")
      .get(relay.id) as { bound_issue_log_delivered_seq: number | null }).bound_issue_log_delivered_seq;
    expect(deliveredSeq()).toBe(firstLog.to_seq);

    f.db.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", [
      new Date(Date.now() - 120_000).toISOString(), relay.id,
    ]);
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(relay.id);
    expect(deliveredSeq()).toBeNull();
    const originalList = f.store.listConversationLogShown;
    f.store.listConversationLogShown = () => { throw new Error("injected reclaimed relay read failure"); };
    try {
      expect(daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(relay.id)!).bound_issue_log).toBeUndefined();
    } finally {
      f.store.listConversationLogShown = originalList;
    }
    f.store.startTask(relay.id);
    f.store.completeTask(relay.id, { output: "Reclaimed without log" });
    expect(f.lane()?.cursorSeq).toBe(0);
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

  it("folds only expandable relay log bodies and keeps the full entry readable", () => {
    const f = setup();
    const body = "Relay detail: " + "x".repeat(4_001);
    const entry = f.store.appendConversationLog({
      sessionId: f.session.id, kind: "message", authorType: "member", bodyMd: body,
    });
    const relay = claimRelayAfterCompletedIssueRound(f);
    const log = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(relay.id)!).bound_issue_log as {
      content_jsonl: string;
    };
    const lines = log.content_jsonl.split("\n").map((line) => JSON.parse(line));
    const projected = lines.find((line) => line.type === "session_event" && line.seq === entry.seq);
    expect(projected).toMatchObject({
      body_folded: true,
      expand: `remi session log get ${f.session.id} ${entry.seq}`,
    });
    expect(projected.body).toBeUndefined();
    expect(f.store.getConversationLogEntry(f.session.id, entry.seq)?.body_md).toBe(body);
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
    f.store.startTask(relay.id);
    f.store.completeTask(relay.id, { output: "Window summary" });
    expect(f.lane()?.cursorSeq).toBe(log.to_seq);
  }, 30_000);

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
