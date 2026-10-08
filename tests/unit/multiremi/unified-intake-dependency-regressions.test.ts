import { expect, it, setSystemTime, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("MUL-508 C1/C2", (fixture) => {
  function intake(assigned = false, generated = true) {
    const f = fixture();
    const runtime = f.store.registerRuntime({ name: "Intake runtime", provider: "codex", daemonId: "intake-daemon", maxConcurrency: 4 });
    const agent = f.store.createAgent({ name: "Intake worker", provider: "codex", runtimeId: runtime.id });
    const issue = f.store.createIssue({ title: "Intake", issueKind: "intake", status: "todo",
      ...(assigned ? { assigneeType: "agent" as const, assigneeId: agent.id } : {}) });
    if (generated) f.store.createIssue({ title: "Generated work", sourceIssueId: issue.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const sent = f.store.sendMessage({ session_id: session.id, sender: { type: "member", id: "mem_local_local" },
      to: { type: "agent", ref: agent.id }, message_kind: "request", wake_requested: "now", body_md: "Finish intake" });
    const attempt = f.store.claimTask(runtime.id)!;
    expect(f.store.getTurnForAttempt(attempt.id)?.id).toBe(sent.turn_id);
    f.store.startTask(attempt.id);
    const bridge = f.store.getDaemonTurnBridge();
    const scope = { workspaceId: "local", runtimeId: runtime.id, daemonId: runtime.daemonId! };
    function completion(taskId = attempt.id) {
      const turn = f.store.getTurnForAttempt(taskId)!;
      const offer = bridge.offerInput(f.store.getTaskWithAgent(taskId)!);
      // Bootstrap reads the full Session range, including messages in sibling lanes.
      f.store.listMessages(session.id, { from: 0, to: offer.input_to_seq });
      f.store.recordSessionAgentRangeRead(session.id, turn.agent_id, { seq: 1, offset: 0 },
        { seq: offer.input_to_seq + 1, offset: 0 }, taskId);
      expect(bridge.rpc("turn.input", { turn_id: turn.id, attempt_id: taskId, input_to_seq: offer.input_to_seq,
        message_ids: offer.input_messages.map(m => m.id) }, scope).ok).toBe(true);
      return { payload: { turn_id: turn.id, attempt_id: taskId, input_to_seq: offer.input_to_seq,
        reply: { body_md: "Intake result", message_kind: "final" as const } }, completionFields: null };
    }
    return { ...f, runtime, agent, issue, session, sent, attempt, bridge, scope, completion };
  }

  for (const assigned of [false, true]) for (const generated of [false, true]) {
    it(`C1: normally finished intake assigned=${assigned} generated=${generated}`, () => {
      const f = intake(assigned, generated);
      const input = f.completion();
      expect(f.bridge.complete(input, f.scope).ok).toBe(true);
      expect(f.store.getTurn(f.sent.turn_id!)?.status).toBe("completed");
      const issue = f.store.getIssue(f.issue.id)!;
      expect(issue.status).toBe(generated ? "done" : "in_review");
      if (generated) expect(issue.completedAt).toBe(issue.updatedAt);
      else expect(issue.completedAt).toBeNull();
      const events = f.db.query("SELECT id FROM multiremi_system_events WHERE resource_id=? AND event='dependency_auto_start_check'").all(issue.id);
      expect(events).toHaveLength(generated ? 1 : 0);
      if (generated) expect(f.store.getSystemEvent(events[0]!.id)?.payload.automation_source_task_id).toBe(f.attempt.id);
      expect(f.bridge.complete(input, f.scope).ok).toBe(true);
      expect(f.store.getIssue(f.issue.id)).toEqual(issue);
      expect(f.db.query("SELECT id FROM multiremi_system_events WHERE resource_id=? AND event='dependency_auto_start_check'").all(issue.id)).toEqual(events);
    });
  }

  it("C1: failed intake blocks while cancelled intake returns to todo", () => {
    const f = intake();
    f.store.failTask(f.attempt.id, { error: "Intake failed", failureReason: "agent_error.unknown" });
    expect(f.store.getTurn(f.sent.turn_id!)?.status).toBe("failed");
    expect(f.store.getIssue(f.issue.id)?.status).toBe("blocked");
    expect(f.store.getIssue(f.issue.id)?.completedAt).toBeNull();
    const replacement = f.store.retryTurn(f.sent.turn_id!, true);
    expect(f.store.getIssue(f.issue.id)?.status).toBe("blocked");
    f.store.cancelTurn(replacement.id);
    expect(f.store.getIssue(f.issue.id)?.status).toBe("todo");
  });

  it("C1: an infrastructure attempt retry leaves intake active until normal round completion", () => {
    const f = intake();
    const before = f.store.getIssue(f.issue.id)!;
    f.store.failTask(f.attempt.id, { error: "Runtime disconnected", failureReason: "runtime_offline" });
    const turn = f.store.getTurn(f.sent.turn_id!)!;
    expect(turn.current_attempt_id).not.toBe(f.attempt.id);
    expect(f.store.listTurnAttempts(turn.id)).toHaveLength(2);
    expect(f.store.getIssue(f.issue.id)).toEqual(before);
    const replacement = f.store.claimTask(f.runtime.id)!;
    expect(replacement.id).toBe(turn.current_attempt_id!);
    f.store.startTask(replacement.id);
    expect(f.bridge.complete(f.completion(replacement.id), f.scope).ok).toBe(true);
    expect(f.store.getIssue(f.issue.id)?.status).toBe("done");
  });

  it("C1: pending sibling work takes precedence over completed intake", () => {
    const f = intake();
    const agent = f.store.createAgent({ name: "Second intake worker", provider: "codex", runtimeId: f.runtime.id });
    const sibling = f.store.sendMessage({ session_id: f.session.id, sender: { type: "member", id: "mem_local_local" },
      to: { type: "agent", ref: agent.id }, message_kind: "request", wake_requested: "now", body_md: "Check intake" });
    expect(f.bridge.complete(f.completion(), f.scope).ok).toBe(true);
    expect(f.store.getIssue(f.issue.id)?.status).toBe("todo");
    expect(f.store.getIssue(f.issue.id)?.completedAt).toBeNull();
    const task = f.store.claimTask(f.runtime.id)!;
    expect(f.store.getTurnForAttempt(task.id)?.id).toBe(sibling.turn_id);
    f.store.startTask(task.id);
    expect(f.bridge.complete(f.completion(task.id), f.scope).ok).toBe(true);
    expect(f.store.getIssue(f.issue.id)?.status).toBe("done");
  });

  it("C1: an intake parent with an unfinished generated child retains guard B", () => {
    const f = intake(true);
    f.store.createIssue({ title: "Open child", sourceIssueId: f.issue.id, parentIssueId: f.issue.id });
    expect(f.bridge.complete(f.completion(), f.scope).ok).toBe(true);
    expect(f.store.getIssue(f.issue.id)?.status).toBe("in_progress");
    expect(f.store.getIssue(f.issue.id)?.completedAt).toBeNull();
    expect(f.store.listIssueActivity(f.issue.id).some(event => event.type === "parent_status_held")).toBe(true);
  });

  it("C1: the last finished round supplies status and dependency-check lineage", () => {
    const f = intake();
    const secondAgent = f.store.createAgent({ name: "Later worker", provider: "codex", runtimeId: f.runtime.id });
    const second = f.store.createTask({ agentId: secondAgent.id, issueId: f.issue.id, prompt: "Check generated work", holdsWorkspace: false });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(second.id);
    f.store.startTask(second.id);
    f.store.completeTask(second.id, { output: "Check completed" });
    expect(f.store.getIssue(f.issue.id)?.status).toBe("in_progress");
    try {
      setSystemTime(new Date(Date.now() + 1000));
      expect(f.bridge.complete(f.completion(), f.scope).ok).toBe(true);
      expect(f.store.getIssue(f.issue.id)?.status).toBe("done");
      const events = f.db.query("SELECT id FROM multiremi_system_events WHERE resource_id=? AND event='dependency_auto_start_check'").all(f.issue.id);
      expect(events).toHaveLength(1);
      expect(f.store.getSystemEvent(events[0]!.id)?.payload.automation_source_task_id).toBe(f.attempt.id);
    } finally { setSystemTime(); }
  });

  async function waiting() {
    const f = fixture();
    const user = f.store.getOrCreateUser({ externalId: "request-user", name: "Request member" });
    const member = f.store.createWorkspaceMember({ userId: user.id, name: user.name, role: "member" });
    const pat = await f.store.createAccessToken({ type: "pat", name: "Request", workspaceId: "local", userId: user.id, purpose: "session" });
    const owner = f.store.createAgent({ name: "Owner", provider: "codex", visibility: "workspace" });
    const target = f.store.createAgent({ name: "Specialist", provider: "codex", visibility: "workspace" });
    const prerequisite = f.store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const issue = f.store.createIssue({ title: "Waiting", status: "backlog", blockedBy: [prerequisite.id], assigneeType: "agent", assigneeId: owner.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const app = createMultiremiApp({ store: f.store, authToken: "fixture-master" });
    const input = { body_md: "Start now", to: { type: "agent", ref: target.id }, message_kind: "request", wake_requested: "now", dedupe_key: "request-once" };
    const post = (body: Record<string, unknown>) => app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const audits = () => f.store.listIssueActivity(issue.id).filter(event => event.type === "dependency_force_started");
    return { ...f, user, member, owner, target, prerequisite, issue, session, input, post, audits };
  }

  it("#2-C2: non-owner member request starts once with verified audit and post-commit events", async () => {
    const f = await waiting();
    const premature: string[] = [];
    const stop = f.store.onWorkspaceEvent(event => { if (f.db.inTransaction) premature.push(event.type); });
    try {
      const response = await f.post(f.input);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ wake_applied: "now", wake_reason: "human_sender", message: { sender_type: "member", sender_id: f.member.id } });
      expect(f.store.getIssue(f.issue.id)?.status).toBe("todo");
      const tasks = f.store.listTasksForIssue(f.issue.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.agentId).toBe(f.target.id);
      expect(tasks[0]!.prompt).toContain("unfinished prerequisites");
      expect(f.audits()).toHaveLength(1);
      expect(f.audits()[0]).toMatchObject({ actorType: "member", actorId: f.user.id });
      expect(f.audits()[0]!.data).toMatchObject({ source: "comment", commentId: result.message.id, taskId: tasks[0]!.id,
        agentId: f.target.id, assigneeDispatched: false, unmet: [{ dependsOnIssueId: f.prerequisite.id }] });
      const duplicate = await f.post(f.input);
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ turn_id: result.turn_id, message: { id: result.message.id } });
      expect(f.store.listMessages(f.session.id)).toHaveLength(1);
      expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
      expect(f.audits()).toHaveLength(1);
      expect(premature).toEqual([]);
    } finally { stop(); }
  });

  it("#2-C2: audit failure rolls back a direct request, head, lane, turn and events", async () => {
    const f = await waiting();
    const head = f.store.getConversationLogHead(f.session.id)!;
    const events: string[] = [];
    const stop = f.store.onWorkspaceEvent(event => { events.push(event.type); });
    const fault = spyOn(IssuesRepo.prototype, "recordDependencyForceStarted").mockImplementation(() => { throw new Error("injected direct request audit failure"); });
    try {
      expect((await f.post(f.input)).status).toBe(400);
      expect(f.store.getIssue(f.issue.id)?.status).toBe("backlog");
      expect(f.store.listMessages(f.session.id)).toEqual([]);
      expect(f.store.getConversationLogHead(f.session.id)).toEqual(head);
      expect(f.store.listTasksForIssue(f.issue.id)).toEqual([]);
      expect(f.db.query("SELECT reader_id FROM multiremi_session_lanes WHERE session_id=?").all(f.session.id)).toEqual([]);
      expect(f.audits()).toEqual([]);
      expect(events).toEqual([]);
    } finally { fault.mockRestore(); stop(); }
    expect((await f.post(f.input)).status).toBe(200);
    expect(f.audits()).toHaveLength(1);
  });

  for (const wake of ["next_turn", "inbox_only"]) {
    it(`#2-C2: explicit ${wake} remains quiet without a force audit`, async () => {
      const f = await waiting();
      const response = await f.post({ ...f.input, wake_requested: wake });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.wake_applied).toBe(wake);
      expect(result.turn_id).toBeUndefined();
      expect(f.store.getIssue(f.issue.id)?.status).toBe("backlog");
      expect(f.store.listTasksForIssue(f.issue.id)).toEqual([]);
      expect(f.audits()).toEqual([]);
    });
  }
});
