import { acceptTestIssueDelivery, createResponsibleTestIssue, seedHistoricalIssueFacts } from './helpers.js';
import { runTurnExecutionMutation } from '@multiremi/store/turn-execution-records.js';
import type { SqlDatabase as UnifiedFixtureDatabase } from '@multiremi/store/db/postgres.js';
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
    return { ...f, flow, ctx, send,
      preparedSystemCommentIds: new Set(f.store.listIssueComments(flow.targetIssueId)
        .filter(comment => comment.authorType === "system").map(comment => comment.id)),
      preparedMergedCount: f.store.listIssueActivity(flow.targetIssueId).filter(row => row.type === "turn_merged").length,
    };
  }

  function createPrerequisite(store: ReturnType<typeof setup>["store"], title: string) {
    const agent = store.createAgent({ name: `${title} execution`, provider: "codex" });
    return createResponsibleTestIssue(store, { title, status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
  }

  function createLegacyMemberDependent(f: ReturnType<typeof setup>, prerequisiteId: string, title: string) {
    const member = f.store.findWorkspaceMemberForUser("local", "local")!;
    const issue = createResponsibleTestIssue(f.store, { title, status: "backlog", blockedBy: [prerequisiteId],
      parentIssueId: f.flow.targetIssueId });
    // Readiness delivery still consumes historical member execution assignments;
    // current Issue creation must not offer this unsupported execution choice.
    seedHistoricalIssueFacts(f.store, issue.id, { assigneeType: "member", assigneeId: member.id });
  }

  it("T4: E2 uses the earliest human round and writes a system report without copying it into the prompt", () => {
    const f = setup();
    const human = f.store.createTask({ agentId: f.flow.agentId, issueId: f.flow.targetIssueId,
      prompt: "Human request that must remain unchanged" });
    triggerInboxFlow(f.store, f.flow);
    const tasks = f.store.listTasksForIssue(f.flow.targetIssueId).filter(task => task.status === "queued");
    expect(tasks.map(task => task.id)).toEqual([human.id]);
    expect(tasks[0]!.wakeSource).toBe("human_sender");
    expect(tasks[0]!.prompt).toBe(human.prompt);
    const comments = f.store.listIssueComments(f.flow.targetIssueId)
      .filter(comment => comment.authorType === "system" && !f.preparedSystemCommentIds.has(comment.id));
    expect(comments).toHaveLength(1);
    const entry = f.store.getConversationLogEntryById(comments[0]!.id)!;
    expect(f.store.getMessage(entry.id)).toMatchObject({ message_kind: "status", wake_applied: "now" });
    expect(inboxWakeSeq(f.db, tasks[0]!.id)).toBe(entry.seq);
    expect(f.store.listIssueActivity(f.flow.targetIssueId).filter(row => row.type === "turn_merged")).toHaveLength(f.preparedMergedCount + 1);
  });

  it("T4: E3 readiness leaves an idle or running recipient without a new queued turn", () => {
    const f = setup();
    const prerequisite = createPrerequisite(f.store, "Readiness prerequisite");
    createLegacyMemberDependent(f, prerequisite.id, "Readiness dependent");
    acceptTestIssueDelivery(f.store, prerequisite.id);
    expect(f.store.listTasksForIssue(f.flow.targetIssueId).filter(task => task.status === "queued")).toEqual([]);
    const running = f.store.createTask({ agentId: f.flow.agentId, issueId: f.flow.targetIssueId, prompt: "Already running" });
    runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [running.id]);
    const another = createPrerequisite(f.store, "Next readiness prerequisite");
    createLegacyMemberDependent(f, another.id, "Next readiness dependent");
    acceptTestIssueDelivery(f.store, another.id);
    expect(f.store.listTasksForIssue(f.flow.targetIssueId).filter(task => task.status === "queued")).toEqual([]);
    const entries = f.store.listIssueComments(f.flow.targetIssueId)
      .filter(comment => comment.authorType === "system" && !f.preparedSystemCommentIds.has(comment.id))
      .map(comment => f.store.getConversationLogEntryById(comment.id)!);
    expect(entries).toHaveLength(2);
    expect(entries.every(entry => f.store.getMessage(entry.id)?.wake_applied === "next_turn")).toBe(true);
  });

  it("T4: E3 next_turn coalesces queued work while another scope is running", () => {
    const f = setup();
    const running = f.store.createTask({ agentId: f.flow.agentId, issueId: f.flow.targetIssueId, prompt: "Running" });
    runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [running.id]);
    // The running turn occupies an independent scope; the readiness lane is pending.
    f.db.run('UPDATE multiremi_turns SET execution_scope=? WHERE current_attempt_id=?',['independent',running.id]);
    const queued = f.store.createTask({ agentId: f.flow.agentId, issueId: f.flow.targetIssueId, prompt: "Queued human request" });
    const prerequisite = createPrerequisite(f.store, "Ready beside running");
    createLegacyMemberDependent(f, prerequisite.id, "Ready dependent");
    acceptTestIssueDelivery(f.store, prerequisite.id);
    const comment = f.store.listIssueComments(f.flow.targetIssueId)
      .find(row => row.authorType === "system" && !f.preparedSystemCommentIds.has(row.id))!;
    const entry = f.store.getConversationLogEntryById(comment.id)!;
    expect(f.store.getMessage(entry.id)?.wake_applied).toBe("next_turn");
    expect(inboxWakeSeq(f.db, queued.id)).toBe(entry.seq);
    expect(f.store.listTasksForIssue(f.flow.targetIssueId).filter(task => task.status === "queued").map(task => task.id))
      .toEqual([queued.id]);
    expect(f.store.getTask(queued.id)!.prompt).toBe("Queued human request");
    expect(f.store.getTask(running.id)!.status).toBe("running");
    expect(f.store.listIssueActivity(f.flow.targetIssueId).filter(row => row.type === "turn_merged")).toHaveLength(f.preparedMergedCount + 1);
  });

  it("T5: Chat envelope delivery creates, coalesces, steers and deduplicates on the startup schema", () => {
    const f = setup();
    const chat = f.store.createChatSession({ agentId: f.flow.agentId });
    const first = f.send(chat.id);
    expect(first.action).toBe("created");
    const second = f.send(chat.id);
    expect(second.action).toBe("coalesced");
    expect(second.task!.id).toBe(first.task!.id);
    runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [first.task!.id]);
    const steered = f.send(chat.id, "now", "steer-once");
    expect(steered.action).toBe("steered");
    expect(steered.task!.id).toBe(first.task!.id);
    const head = f.db.query("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ?").get(chat.id);
    const duplicate = f.send(chat.id, "now", "steer-once");
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.entry.id).toBe(steered.entry.id);
    expect(f.db.query("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ?").get(chat.id)).toEqual(head);
    expect(f.store.getMessage(steered.entry.id)).toMatchObject({body_md:steered.entry.body_md,to_agent_id:f.flow.agentId,wake_applied:"now"});
    expect(Number(f.db.query("SELECT COUNT(*) AS n FROM multiremi_system_events WHERE event='message_delivered_running' AND payload LIKE ?").get(`%${steered.entry.id}%`)?.n)).toBe(1);
    expect(f.db.query("SELECT id FROM multiremi_turn_execution_records WHERE chat_session_id = ? AND status = 'queued'").all(chat.id)).toEqual([]);
  });

  it("T5: transport mismatch creates a separate bound Chat turn and never steers private work", () => {
    const f = setup();
    const chat = f.store.createChatSession({ agentId: f.flow.agentId });
    const privateTask = f.store.sendChatMessage(chat.id, { content: "Private user message" }).task;
    runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [privateTask.id]);
    const bound=f.store.createChatSession({agentId:f.flow.agentId});
    const at = "2026-09-29T00:00:00.000Z";
    f.db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
      (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, issue_id, created_at, updated_at)
      VALUES ('chain_transport', 'local', 'test', ?, 'chain_transport', ?, ?, ?, ?)`,
      [f.flow.agentId, bound.id, f.flow.targetIssueId, at, at]);
    const delivery = f.send(bound.id);
    expect(delivery.action).toBe("created");
    expect(delivery.task!.issueId).toBe(f.flow.targetIssueId);
    expect(delivery.task!.id).not.toBe(privateTask.id);
    expect(f.store.listTaskSteerMessages(privateTask.id)).toEqual([]);
    expect(f.store.getTask(privateTask.id)!.prompt).toBe("Private user message");
  });
}, { isolation: 'committed-baseline' });
