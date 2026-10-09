import { createResponsibleTestIssue } from '../helpers.js';
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
  humanBody?: string;
}

export function inboxFlowFixture(store: MultiremiStore, scenario: InboxFlowScenario): InboxFlowFixture {
  store.ensureLocalWorkspace();
  const member = store.findWorkspaceMemberForUser("local", "local")!;
  const agent = store.createAgent({ name: `Inbox ${scenario}`, provider: "codex" });
  const target = createResponsibleTestIssue(store, { title: `Inbox ${scenario} recipient`, status: "in_progress",
    assigneeType: "agent", assigneeId: agent.id });
  const session = store.getOrCreateDefaultIssueSession(target.id);
  const common = { scenario, targetIssueId: target.id, issueSessionId: session.id,
    agentId: agent.id, memberId: member.id };
  if (scenario === "e2") {
    const child = createResponsibleTestIssue(store, { title: "E2 child", status: "in_progress", parentIssueId: target.id });
    return { ...common, subjectIssueId: child.id };
  }
  if (scenario === "e3") {
    const prerequisite = createResponsibleTestIssue(store, { title: "E3 prerequisite", status: "in_progress" });
    createResponsibleTestIssue(store, { title: "E3 waiting dependent", status: "backlog", parentIssueId: target.id,
      blockedBy: [prerequisite.id], assigneeType: "member", assigneeId: member.id });
    return { ...common, subjectIssueId: prerequisite.id };
  }
  if (scenario === "e4") {
    const decision = store.createIssueDecision(target.id, {
      kind: "question", title: "E4 direction", body: "Choose a direction",
    }, { type: "member", id: member.id, taskId: null });
    return { ...common, subjectIssueId: target.id, decisionId: decision.id, decisionIssueId: decision.issueId };
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
    case "e2": store.updateIssue(fixture.subjectIssueId, { status: "done" }); break;
    case "e3": store.updateIssue(fixture.subjectIssueId, { status: "blocked" }); break;
    case "e4": store.answerIssueDecision(fixture.decisionIssueId!, fixture.decisionId!, {
      answer: "E4 approved", reason: "Reviewed",
    }, { type: "member", id: fixture.memberId, taskId: null }, { idempotent: true }); break;
    case "human": store.createIssueComment(fixture.subjectIssueId, {
      authorType: "member", authorId: fixture.memberId, body: fixture.humanBody!,
    }); break;
  }
}

export function inboxFlowStatus(store: MultiremiStore, fixture: InboxFlowFixture): string {
  return fixture.scenario === "e4"
    ? store.getIssueDecision(fixture.decisionIssueId!, fixture.decisionId!)!.status
    : store.getIssue(fixture.subjectIssueId)!.status;
}

export function inboxWakeSeq(db: SqlDatabase, taskId: string): number {
  const row = db.query("SELECT wake_seq FROM multiremi_turns WHERE current_attempt_id = ?").get(taskId) as { wake_seq: number } | null;
  if (!row) throw new Error(`Inbox task is missing: ${taskId}`);
  return Number(row.wake_seq);
}
