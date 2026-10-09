import { createResponsibleTestIssue, prepareTestIssueDelivery } from '../helpers.js';
import type { MultiremiStore } from "@multiremi/store.js";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

export type InboxFlowScenario = "e2" | "e3" | "e4" | "human";

export interface InboxFlowFixture {
  scenario: InboxFlowScenario;
  subjectIssueId: string;
  targetIssueId: string;
  issueSessionId: string;
  agentId: string;
  memberId: string;
  decisionId?: string;
  decisionIssueId?: string;
  seededTaskId?: string;
  seededWakeSeq?: number;
  questionTurnId?: string;
  questionTaskId?: string;
  humanBody?: string;
  deliveryId?: string;
  deliveryRevision?: string;
  reviewerTaskId?: string;
  preparedMessageIds?: string[];
}

export function inboxFlowFixture(store: MultiremiStore, scenario: InboxFlowScenario): InboxFlowFixture {
  store.ensureLocalWorkspace();
  const member = store.findWorkspaceMemberForUser("local", "local")!;
  const agent = store.createAgent({ name: `Inbox ${scenario}`, provider: "codex" });
  const target = createResponsibleTestIssue(store, { title: `Inbox ${scenario} recipient`, status: "in_progress",
    assigneeType: "agent", assigneeId: agent.id, responsibleMemberId: member.id });
  const session = store.getOrCreateDefaultIssueSession(target.id);
  const common = { scenario, targetIssueId: target.id, issueSessionId: session.id,
    agentId: agent.id, memberId: member.id };
  if (scenario === "e2") {
    const worker=store.createAgent({name:'E2 delivering worker',provider:'claude'});
    const child = createResponsibleTestIssue(store, { title: "E2 child", status: "in_progress", parentIssueId: target.id,
      assigneeType:'agent',assigneeId:worker.id });
    const prepared=prepareTestIssueDelivery(store,child.id);
    // Consume the preparation notices before measuring the acceptance transaction.
    // The source parent turn remains the verified reviewer session; no fake receipt is seeded.
    const runtime=store.registerRuntime({name:'E2 reviewer host',provider:'codex'});
    store.updateAgent(agent.id,{runtimeId:runtime.id});
    if(store.claimTask(runtime.id)?.id!==prepared.actor.taskId)throw new Error('E2 reviewer was not claimed');
    store.startTask(prepared.actor.taskId!);
    store.getDaemonTurnBridge().offerInput(store.getTaskWithAgent(prepared.actor.taskId!)!);
    store.completeTask(prepared.actor.taskId!,{output:'Read the concrete child delivery'});
    return { ...common, subjectIssueId: child.id,deliveryId:prepared.delivery.id,
      preparedMessageIds:store.listMessages(session.id).filter(message=>message.to_agent_id===agent.id).map(message=>message.id),
      deliveryRevision:prepared.delivery.responsibilityRevision,reviewerTaskId:prepared.actor.taskId! };
  }
  if (scenario === "e3") {
    const prerequisite = createResponsibleTestIssue(store, { title: "E3 prerequisite", status: "in_progress" });
    createResponsibleTestIssue(store, { title: "E3 waiting dependent", status: "backlog", parentIssueId: target.id,
      blockedBy: [prerequisite.id], assigneeType: "agent", assigneeId: agent.id });
    return { ...common, subjectIssueId: prerequisite.id };
  }
  if (scenario === "e4") {
    const runtime = store.registerRuntime({ name: "E4 question host", provider: "codex", daemonId: "e4-question-host" });
    store.updateAgent(agent.id, { runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, issueId: target.id, issueSessionId: session.id, prompt: "Choose a direction" });
    if (store.claimTask(runtime.id)?.id !== task.id) throw new Error("E4 source execution was not claimed");
    store.startTask(task.id);
    const turn = store.getTurnForAttempt(task.id)!;
    const bridge = store.getDaemonTurnBridge();
    const scope = { runtimeId: runtime.id, daemonId: "e4-question-host", workspaceId: "local" };
    const decision = bridge.rpc("turn.decision", { turn_id: turn.id, attempt_id: task.id,
      dedupe_key: `e4:${task.id}`, wait_id: `e4-wait:${task.id}`, body_md: "Choose a direction",
      options: [], metadata: { kind: "question", questions: [{ question: "Choose a direction" }] }, timeout_ms: 50 }, scope);
    if (!decision.ok || !decision.message_id) throw new Error("E4 native question was not created");
    return { ...common, subjectIssueId: target.id, decisionId: String(decision.message_id), decisionIssueId: target.id,
      questionTaskId: task.id, questionTurnId: turn.id,
      seededWakeSeq: inboxWakeSeq((store as unknown as { db: SqlDatabase }).db, task.id) };
  }
  const { db, ctx } = store as unknown as { db: SqlDatabase; ctx: StoreContext };
  const events = createCommitEventQueue();
  const delivery = db.transaction(() => store.sendEnvelopeWithinTransaction({
    to: { role: "issue_owner", issueId: target.id }, kind: "report", outcome: "done", wake: "now",
    dedupeKey: "human-crash-seed", body: "A platform report is waiting", source: { issueId: target.id },
  }, [], events)[0]!)();
  ctx.emitCommitEvents(events);
  return { ...common, subjectIssueId: target.id, seededTaskId: delivery.task!.id,
    seededWakeSeq: inboxWakeSeq(db, delivery.task!.id),
    humanBody: `Human inbox follow-up [@${agent.name}](mention://agent/${agent.id})` };
}

export function triggerInboxFlow(store: MultiremiStore, fixture: InboxFlowFixture): void {
  switch (fixture.scenario) {
    case "e2": store.respondIssueDelivery(fixture.subjectIssueId,fixture.deliveryId!,
      {action:'accept',revision:fixture.deliveryRevision!},{type:'agent',id:fixture.agentId,taskId:fixture.reviewerTaskId!}); break;
    case "e3": store.updateIssue(fixture.subjectIssueId, { status: "blocked" }); break;
    case "e4": {
      const question = store.getQuestion(fixture.decisionId!)!;
      // Crash probes repeat the trigger after commit. Replaying an answer is
      // explicitly different from amending it and must not schedule twice.
      if (question.status === "answered") break;
      store.answerQuestion(question.id, { expected_route_revision: question.route_revision,
        response: { answer: "E4 approved" }, reason: "Reviewed" }, { type: "member", id: fixture.memberId });
      break;
    }
    case "human": store.createIssueComment(fixture.subjectIssueId, {
      authorType: "member", authorId: fixture.memberId, body: fixture.humanBody!,
    }); break;
  }
}

export function inboxFlowStatus(store: MultiremiStore, fixture: InboxFlowFixture): string {
  return fixture.scenario === "e4"
    ? store.getQuestion(fixture.decisionId!)!.status
    : store.getIssue(fixture.subjectIssueId)!.status;
}

export function inboxWakeSeq(db: SqlDatabase, taskId: string): number {
  const row = db.query("SELECT wake_seq FROM multiremi_turns WHERE current_attempt_id = ?").get(taskId) as { wake_seq: number } | null;
  if (!row) throw new Error(`Inbox task is missing: ${taskId}`);
  return Number(row.wake_seq);
}
