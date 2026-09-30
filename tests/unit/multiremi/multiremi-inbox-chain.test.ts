import { expect, it } from "bun:test";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { inboxFlowFixture, triggerInboxFlow, inboxWakeSeq } from "./fixtures/inbox-flow-fixture.js";

pendingTurnBackendTests("D1 inbox integrated chains", fixture => {
  function setup() {
    const f = fixture();
    const flow = inboxFlowFixture(f.store, "e2");
    const ctx = (f.store as unknown as { ctx: StoreContext }).ctx;
    const send = (chatSessionId: string, wake: "now" | "next_turn" = "now", key: string = crypto.randomUUID()) => {
      const events = createCommitEventQueue();
      const delivery = f.transaction(() => f.store.sendEnvelopeWithinTransaction({
        to: { role: "chat", chatSessionId, agentId: flow.agentId }, kind: "report", outcome: "done",
        wake, body: `Chat inbox report ${key}`, dedupeKey: key, source: {},
      }, [], events)[0]!);
      ctx.emitCommitEvents(events);
      return delivery;
    };
    return { ...f, flow, ctx, send };
  }

  it("T4: E2 uses the earliest human round and writes a system report without copying it into the prompt", () => {
    const f = setup();
    const human = f.store.createTask({ agentId: f.flow.agentId, issueId: f.flow.targetIssueId,
      prompt: "Human request that must remain unchanged" });
    triggerInboxFlow(f.store, f.flow);
    const tasks = f.store.listTasksForIssue(f.flow.targetIssueId).filter(task => task.status === "queued");
    expect(tasks.map(task => task.id)).toEqual([human.id]);
    expect(tasks[0]!.wakeSource).toBeNull();
    expect(tasks[0]!.prompt).toBe(human.prompt);
    const comments = f.store.listIssueComments(f.flow.targetIssueId).filter(comment => comment.authorType === "system");
    expect(comments).toHaveLength(1);
    const entry = f.store.getConversationLogEntryById(comments[0]!.id)!;
    expect(entry.metadata.envelope).toMatchObject({ kind: "report", outcome: "done", wake: "now" });
    expect(inboxWakeSeq(f.db, tasks[0]!.id)).toBe(entry.seq);
    expect(f.store.listIssueActivity(f.flow.targetIssueId).filter(row => row.type === "pending_turn_coalesced")).toHaveLength(1);
  });

  it("T4: E3 readiness leaves an idle or running recipient without a new queued turn", () => {
    const f = setup();
    const member = f.store.findWorkspaceMemberForUser("local", "local")!;
    const prerequisite = f.store.createIssue({ title: "Readiness prerequisite", status: "in_progress" });
    f.store.createIssue({ title: "Readiness dependent", status: "backlog", blockedBy: [prerequisite.id],
      parentIssueId: f.flow.targetIssueId, assigneeType: "member", assigneeId: member.id });
    f.store.updateIssue(prerequisite.id, { status: "done" });
    expect(f.store.listTasksForIssue(f.flow.targetIssueId).filter(task => task.status === "queued")).toEqual([]);
    const running = f.store.createTask({ agentId: f.flow.agentId, issueId: f.flow.targetIssueId, prompt: "Already running" });
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [running.id]);
    const another = f.store.createIssue({ title: "Next readiness prerequisite", status: "in_progress" });
    f.store.createIssue({ title: "Next readiness dependent", status: "backlog", blockedBy: [another.id],
      parentIssueId: f.flow.targetIssueId, assigneeType: "member", assigneeId: member.id });
    f.store.updateIssue(another.id, { status: "done" });
    expect(f.store.listTasksForIssue(f.flow.targetIssueId).filter(task => task.status === "queued")).toEqual([]);
    const entries = f.store.listIssueComments(f.flow.targetIssueId).filter(comment => comment.authorType === "system")
      .map(comment => f.store.getConversationLogEntryById(comment.id)!);
    expect(entries).toHaveLength(2);
    expect(entries.every(entry => entry.metadata.envelope?.wake === "next_turn")).toBe(true);
  });

  it("T4: E3 next_turn coalesces queued work beside a running turn", () => {
    const f = setup();
    const running = f.store.createTask({ agentId: f.flow.agentId, issueId: f.flow.targetIssueId, prompt: "Running" });
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [running.id]);
    const queued = f.store.createTask({ agentId: f.flow.agentId, issueId: f.flow.targetIssueId, prompt: "Queued human request" });
    const member = f.store.findWorkspaceMemberForUser("local", "local")!;
    const prerequisite = f.store.createIssue({ title: "Ready beside running", status: "in_progress" });
    f.store.createIssue({ title: "Ready dependent", status: "backlog", blockedBy: [prerequisite.id],
      parentIssueId: f.flow.targetIssueId, assigneeType: "member", assigneeId: member.id });
    f.store.updateIssue(prerequisite.id, { status: "done" });
    const comment = f.store.listIssueComments(f.flow.targetIssueId).find(row => row.authorType === "system")!;
    const entry = f.store.getConversationLogEntryById(comment.id)!;
    expect(entry.metadata.envelope?.wake).toBe("next_turn");
    expect(inboxWakeSeq(f.db, queued.id)).toBe(entry.seq);
    expect(f.store.listTasksForIssue(f.flow.targetIssueId).filter(task => task.status === "queued").map(task => task.id))
      .toEqual([queued.id]);
    expect(f.store.getTask(queued.id)!.prompt).toBe("Queued human request");
    expect(f.store.getTask(running.id)!.status).toBe("running");
    expect(f.store.listIssueActivity(f.flow.targetIssueId).filter(row => row.type === "pending_turn_coalesced")).toHaveLength(1);
  });

  it("T5: Chat envelope delivery creates, coalesces, steers and deduplicates on the startup schema", () => {
    const f = setup();
    const chat = f.store.createChatSession({ agentId: f.flow.agentId });
    const first = f.send(chat.id);
    expect(first.action).toBe("created");
    const second = f.send(chat.id);
    expect(second.action).toBe("coalesced");
    expect(second.task!.id).toBe(first.task!.id);
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [first.task!.id]);
    const steered = f.send(chat.id, "now", "steer-once");
    expect(steered.action).toBe("steered");
    expect(steered.task!.id).toBe(first.task!.id);
    const head = f.db.query("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ?").get(chat.id);
    const duplicate = f.send(chat.id, "now", "steer-once");
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.entry.id).toBe(steered.entry.id);
    expect(f.db.query("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ?").get(chat.id)).toEqual(head);
    const messages = f.store.listTaskSteerMessages(first.task!.id);
    expect(messages.map(message => ({ kind: message.kind, authorType: message.authorType, content: message.content })))
      .toEqual([{ kind: "steer", authorType: "system", content: steered.entry.body_md }]);
    expect(f.db.query("SELECT id FROM multiremi_tasks WHERE chat_session_id = ? AND status = 'queued'").all(chat.id)).toEqual([]);
  });

  it("T5: transport mismatch creates a separate bound Chat turn and never steers private work", () => {
    const f = setup();
    const chat = f.store.createChatSession({ agentId: f.flow.agentId });
    const privateTask = f.store.sendChatMessage(chat.id, { content: "Private user message" }).task;
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [privateTask.id]);
    const at = "2026-09-29T00:00:00.000Z";
    f.db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
      (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, issue_id, created_at, updated_at)
      VALUES ('chain_transport', 'local', 'test', ?, 'chain_transport', ?, ?, ?, ?)`,
      [f.flow.agentId, chat.id, f.flow.targetIssueId, at, at]);
    const delivery = f.send(chat.id);
    expect(delivery.action).toBe("created");
    expect(delivery.task!.issueId).toBe(f.flow.targetIssueId);
    expect(delivery.task!.id).not.toBe(privateTask.id);
    expect(f.store.listTaskSteerMessages(privateTask.id)).toEqual([]);
    expect(f.store.getTask(privateTask.id)!.prompt).toBe("Private user message");
  });
});
