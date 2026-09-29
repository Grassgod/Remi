import { beforeEach, expect, it } from "bun:test";
import type { Envelope } from "@multiremi/contracts/inbox.js";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import { installPendingTurnTestConstraints, pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import type { EnsurePendingTurnInput, PendingTurnLane } from "@multiremi/store/repos/tasks-repo.js";

pendingTurnBackendTests("transactional inbox writers", (fixture) => {
  beforeEach(() => {
    installPendingTurnTestConstraints(fixture());
  });
  function setup() {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Inbox owner", provider: "codex" });
    const issue = f.store.createIssue({ title: "Inbox", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const chat = f.store.createChatSession({ agentId: agent.id });
    const collector: import("@multiremi/store/repos/tasks-repo.js").ChildStatusChangeCollector = [];
    const queue = createCommitEventQueue();
    const env: Envelope = { to: { role: "agent", agentId: agent.id, issueSessionId: session.id },
      kind: "report", outcome: "done", wake: "now", body: "A complete report", source: {} };
    const send = (changes: Partial<Envelope> = {}) => f.transaction(() => f.store.sendEnvelopeWithinTransaction({ ...env, ...changes }, collector, queue));
    const entry = () => send({ wake: "inbox_only" })[0]!.entry;
    const issueLane: PendingTurnLane = { kind: "issue", agentId: agent.id, issueSessionId: session.id, executionScope: "" };
    const chatLane: PendingTurnLane = { kind: "chat", agentId: agent.id, chatSessionId: chat.id, issueId: null };
    const ensure = (changes: Partial<EnsurePendingTurnInput> = {}) => {
      const lane = changes.lane ?? issueLane;
      const wake = changes.wake ?? { reason: "test", seq: entry().seq };
      return f.transaction(() => f.store.ensurePendingTurnWithinTransaction({
        lane, wake, steerBody: "A complete steer report",
        create: () => {
          const task = (f.store as unknown as { ctx: StoreContext }).ctx.tasks().createTaskWithinWorkspaceLock({ agentId: agent.id,
            issueSessionId: lane.kind === "issue" ? lane.issueSessionId : null,
            issueId: lane.kind === "issue" ? issue.id : lane.issueId,
            chatSessionId: lane.kind === "chat" ? lane.chatSessionId : null,
            prompt: "Read the inbox", wakeSource: wake.reason, preserveIssueStatus: true,
          }, collector, queue, undefined, lane.kind === "issue" ? lane.executionScope : "");
          queue.enqueuedTasks.push(task);
          return f.store.getTask(task.id)!;
        }, ...changes,
      }));
    };
    const queued = () => Number(f.db.query("SELECT COUNT(*) AS n FROM multiremi_tasks WHERE status = 'queued'").get().n);
    return { ...f, agent, issue, session, chat, issueLane, chatLane, collector, queue, env, send, entry, ensure, queued };
  }

  it("rejects both writers outside a transaction without a write", () => {
    const f = setup();
    const pointer = f.entry();
    expect(() => f.store.ensurePendingTurnWithinTransaction({ lane: f.issueLane, wake: { reason: "test", seq: pointer.seq },
      create: () => { throw new Error("Unexpected create"); } })).toThrow("open transaction");
    expect(() => f.store.sendEnvelopeWithinTransaction(f.env, [], f.queue)).toThrow("open transaction");
    expect(f.queued()).toBe(0);
  });

  it("coalesces an existing queued turn, raises wake_seq monotonically and audits the merge", () => {
    const f = setup();
    const first = f.ensure({ wake: { seq: 10, reason: "test" } });
    const next = f.ensure({ wake: { seq: 20, reason: "later" } });
    const older = f.ensure({ wake: { seq: 15, reason: "test" } });
    expect(first.action).toBe("created");
    expect(next.action).toBe("coalesced");
    expect(older.task!.id).toBe(first.task!.id);
    expect(f.queued()).toBe(1);
    expect(Number(f.db.query("SELECT wake_seq FROM multiremi_tasks WHERE id = ?").get(first.task!.id).wake_seq)).toBe(20);
    const rows = f.db.query("SELECT data FROM multiremi_issue_activity WHERE type = 'pending_turn_coalesced' ORDER BY created_at, id").all();
    expect(rows.map(row => JSON.parse(row.data))).toContainEqual({ task_id: first.task!.id, seq: 20, reason: "later", commentId: null });
    expect(rows).toHaveLength(2);
    expect(f.queue.enqueuedTasks).toHaveLength(1);
    expect(first.task!.prompt).not.toContain(f.env.body);
    expect(first.task!.wakeSource).toBe("test");
    expect(f.store.getIssue(f.issue.id)!.status).toBe("in_progress");
  });

  it("T4: next_turn rides queued Issue work and returns none for running or idle lanes", () => {
    const f = setup();
    const wake = { mode: "next_turn" as const, seq: 20, reason: "test" };
    expect(f.ensure({ wake })).toEqual({ task: null, action: "none" });
    const first = f.ensure({ wake: { seq: 10, reason: "test" } });
    expect(first.action).toBe("created");
    expect(f.ensure({ wake }).action).toBe("coalesced");
    expect(Number(f.db.query("SELECT wake_seq FROM multiremi_tasks WHERE id = ?").get(first.task!.id).wake_seq)).toBe(20);
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [first.task!.id]);
    expect(f.ensure({ wake })).toEqual({ task: null, action: "none" });
    expect(f.queued()).toBe(0);
    expect(f.ensure().action).toBe("created");
    expect(f.queued()).toBe(1);
  });

  it("keeps execution scopes independent and coalesces Chat-only turns", () => {
    const f = setup();
    const main = f.ensure();
    const alphaLane: PendingTurnLane = { kind: "issue", agentId: f.agent.id, issueSessionId: f.session.id, executionScope: "alpha" };
    const betaLane: PendingTurnLane = { ...alphaLane, executionScope: "beta" };
    const alpha = f.ensure({ lane: alphaLane });
    const beta = f.ensure({ lane: betaLane });
    expect(alpha.task!.execution_scope).toBe("alpha");
    expect(main.task!.id).not.toBe(alpha.task!.id);
    expect(alpha.task!.id).not.toBe(beta.task!.id);
    expect(f.ensure({ lane: alphaLane }).task!.id).toBe(alpha.task!.id);
    const chat = f.ensure({ lane: f.chatLane });
    expect(f.ensure({ lane: f.chatLane }).task!.id).toBe(chat.task!.id);
    expect(f.queued()).toBe(4);
    expect(Number(f.db.query("SELECT COUNT(*) AS n FROM multiremi_system_events WHERE event = 'pending_turn_coalesced' AND resource_id = ? AND status = 'processed'").get(chat.task!.id).n)).toBe(1);
  });

  it("writes Issue system comments with contract metadata and returns duplicates without allocating seq", () => {
    const f = setup();
    const changes = { dedupeKey: "report:1", replyTo: "decision:1", grantRef: "reserved", outcome: "failed" as const };
    const first = f.send(changes)[0]!;
    const before = f.db.query("SELECT head_seq, log_version FROM multiremi_conversation_heads WHERE session_id = ?").get(f.session.id);
    const duplicate = f.send({ ...changes, body: "Must not replace the original" })[0]!;
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.entry).toEqual(first.entry);
    expect(f.db.query("SELECT head_seq, log_version FROM multiremi_conversation_heads WHERE session_id = ?").get(f.session.id)).toEqual(before);
    expect(first.entry.kind).toBe("system");
    expect(first.entry.author_type).toBe("system");
    const { body, ...expected } = f.env;
    expect(first.entry.metadata.envelope).toEqual({ ...expected, ...changes, priority: 2 });
    expect(Object.hasOwn(first.entry.metadata.envelope!, "body")).toBe(false);
    expect(f.store.getIssueComment(first.entry.id)!.type).toBe("system");
    expect(f.queued()).toBe(1);
  });

  it("T4: rides the earliest human or continuation queued row without changing its prompt", () => {
    const f = setup();
    const first = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: "Human request" });
    const later = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: "Later request" });
    f.db.run("UPDATE multiremi_tasks SET created_at = '2026-09-28T00:00:00.000Z' WHERE id = ?", [first.id]);
    const result = f.ensure({ wake: { reason: "child_status", seq: 40, commentId: "cmt_trigger" } });
    expect(result.action).toBe("coalesced");
    expect(result.task!.id).toBe(first.id);
    expect(result.task!.wakeSource).toBeNull();
    expect(result.task!.prompt).toBe("Human request");
    expect(f.queued()).toBe(2);
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id IN (?, ?)", [first.id, later.id]);
    const continued = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: "Continuation", continuedFromTaskId: first.id });
    expect(f.ensure().task!.id).toBe(continued.id);
  });

  it("T4: creates after a queued-row CAS loses to a claim and validates the callback lane", () => {
    const f = setup();
    const first = f.ensure().task!;
    const original = f.db.run.bind(f.db);
    let intercepted = false;
    f.db.run = (sql, params) => {
      if (!intercepted && sql.includes("wake_seq = CASE") && sql.includes("status = 'queued'")) {
        intercepted = true;
        original("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [first.id]);
        return { changes: 0, lastInsertRowid: 0 };
      }
      return original(sql, params);
    };
    try {
      const result = f.ensure();
      expect(result.action).toBe("created");
      expect(result.task!.id).not.toBe(first.id);
    } finally { f.db.run = original; }
    expect(f.queued()).toBe(1);
    f.db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE status = 'queued'");
    const before = Number(f.db.query("SELECT COUNT(*) AS n FROM multiremi_tasks").get().n);
    expect(() => f.ensure({ create: () => f.store.createTaskWithinTransaction({
      agentId: f.agent.id, chatSessionId: f.chat.id, prompt: "Wrong lane",
    }, [], f.queue) })).toThrow("outside its queued lane");
    expect(Number(f.db.query("SELECT COUNT(*) AS n FROM multiremi_tasks").get().n)).toBe(before);
  });

  it("T5: creates, coalesces, and steers the Chat pending task in the caller transaction", () => {
    const f = setup();
    const first = f.ensure({ lane: f.chatLane });
    expect(first.action).toBe("created");
    expect(f.ensure({ lane: f.chatLane }).action).toBe("coalesced");
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [first.task!.id]);
    const result = f.ensure({ lane: f.chatLane, steerBody: "Deliver the new report" });
    expect(result.action).toBe("steered");
    expect(result.task!.id).toBe(first.task!.id);
    expect(f.store.listTaskSteerMessages(first.task!.id).map(row => ({ kind: row.kind, content: row.content, authorType: row.authorType })))
      .toEqual([{ kind: "steer", content: "Deliver the new report", authorType: "system" }]);
    expect(() => f.transaction(() => {
      f.store.ensurePendingTurnWithinTransaction({ lane: f.chatLane, wake: { reason: "relay", seq: null },
        steerBody: "Rolled back steer", create: () => { throw new Error("Unexpected create"); } });
      throw new Error("abort steer");
    })).toThrow("abort steer");
    expect(f.store.listTaskSteerMessages(first.task!.id)).toHaveLength(1);
    expect(f.queued()).toBe(0);
  });

  it("T5: checks transport identity before coalescing into a user's pending Chat task", () => {
    const f = setup();
    const privateTask = f.store.sendChatMessage(f.chat.id, { content: "Private conversation" }).task;
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [privateTask.id]);
    f.store.sendChatMessage(f.chat.id, { content: "Private queued message" });
    f.db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
      (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, issue_id, created_at, updated_at)
      VALUES ('transport_changed', ?, 'test', ?, 'transport_changed', ?, ?, ?, ?)`,
    [f.agent.workspaceId, f.agent.id, f.chat.id, f.issue.id, "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:00.000Z"]);
    const lane: PendingTurnLane = { kind: "chat", chatSessionId: f.chat.id, agentId: f.agent.id, issueId: f.issue.id };
    const result = f.ensure({ lane, wake: { reason: "relay", seq: null } });
    expect(result.action).toBe("created");
    expect(result.task!.issueId).toBe(f.issue.id);
    expect(result.task!.wakeSource).toBe("relay");
    expect(result.task!.id).not.toBe(privateTask.id);
    expect(f.store.listTaskSteerMessages(privateTask.id)).toEqual([]);
    expect(f.store.getTask(privateTask.id)!.prompt).toBe(privateTask.prompt);
  });

  it("T5: next_turn on Chat rides or steers existing work and never creates an idle turn", () => {
    const f = setup();
    const wake = { mode: "next_turn" as const, reason: "relay", seq: null };
    expect(f.ensure({ lane: f.chatLane, wake })).toEqual({ task: null, action: "none" });
    const first = f.ensure({ lane: f.chatLane }).task!;
    expect(f.ensure({ lane: f.chatLane, wake }).action).toBe("coalesced");
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [first.id]);
    expect(f.ensure({ lane: f.chatLane, wake }).action).toBe("steered");
    expect(f.store.listTaskSteerMessages(first.id)).toHaveLength(1);
  });

  it("writes Chat system messages on the same log axis with metadata and no duplicate seq", () => {
    const f = setup();
    const changes: Partial<Envelope> = { to: { role: "chat", agentId: f.agent.id, chatSessionId: f.chat.id }, dedupeKey: "chat:1" };
    const first = f.send(changes)[0]!;
    const before = f.db.query("SELECT head_seq, log_version FROM multiremi_conversation_heads WHERE session_id = ?").get(f.chat.id);
    expect(f.send(changes)[0]!.entry).toEqual(first.entry);
    expect(f.db.query("SELECT head_seq, log_version FROM multiremi_conversation_heads WHERE session_id = ?").get(f.chat.id)).toEqual(before);
    const message = f.store.getChatMessage(first.entry.id)!;
    expect(message.role).toBe("system");
    expect(Number(f.db.query("SELECT sequence FROM multiremi_chat_messages WHERE id = ?").get(message.id).sequence)).toBe(first.entry.seq);
    expect(first.entry.author_type).toBe("system");
    expect(first.entry.metadata.envelope!.to).toEqual(changes.to!);
    expect(first.entry.metadata.envelope!.priority).toBe(3);
    expect(f.queued()).toBe(1);
  });

  it("preserves Markdown whitespace in Chat envelopes and publishes as system only after commit", () => {
    const f = setup();
    const events: Array<{ type: string; actorType?: string }> = [];
    const unsubscribe = f.store.onWorkspaceEvent(event => events.push(event));
    const body = "  indented Markdown\n\nlast line\n";
    try {
      const delivery = f.transaction(() => {
        const result = f.store.sendEnvelopeWithinTransaction({ ...f.env, body,
          to: { role: "chat", agentId: f.agent.id, chatSessionId: f.chat.id }, wake: "inbox_only" }, [], f.queue)[0]!;
        expect(events).toEqual([]);
        return result;
      });
      expect(delivery.entry.body_md).toBe(body);
      expect(f.store.getChatMessage(delivery.entry.id)!.body).toBe(body);
      expect(events).toMatchObject([{ type: "chat:message", actorType: "system" }]);
    } finally { unsubscribe(); }
  });

  it("inbox_only writes both session kinds without creating turns", () => {
    const f = setup();
    const issue = f.send({ wake: "inbox_only" })[0]!;
    const chat = f.send({ wake: "inbox_only", to: { role: "chat", agentId: f.agent.id, chatSessionId: f.chat.id } })[0]!;
    expect(issue.task).toBeNull();
    expect(chat.task).toBeNull();
    expect(issue.entry.metadata.envelope!.priority).toBe(4);
    expect(chat.entry.metadata.envelope!.priority).toBe(4);
    expect(f.queued()).toBe(0);
  });

  it("uses sessionId in dedupe keys and resolves Issue owners and parent owners", () => {
    const f = setup();
    const child = f.store.createIssue({ title: "Child", parentIssueId: f.issue.id });
    const side = f.store.createIssueSession(f.issue.id, { title: "Side", inheritMode: "none" });
    const owner = f.send({ to: { role: "issue_owner", issueId: f.issue.id }, dedupeKey: "same", wake: "inbox_only" })[0]!;
    const parent = f.send({ to: { role: "parent_owner", childIssueId: child.id }, dedupeKey: "same", wake: "inbox_only" })[0]!;
    expect(parent.entry.id).toBe(owner.entry.id);
    const other = f.send({ to: { role: "agent", agentId: f.agent.id, issueSessionId: side.id }, dedupeKey: "same", wake: "inbox_only" })[0]!;
    expect(other.entry.id).not.toBe(owner.entry.id);
  });

  it("rolls back envelopes, pending turns and notifications with the outer transaction", () => {
    const f = setup();
    const before = f.db.query("SELECT head_seq, log_version FROM multiremi_conversation_heads WHERE session_id = ?").get(f.session.id);
    const chatBefore = f.db.query("SELECT head_seq, log_version FROM multiremi_conversation_heads WHERE session_id = ?").get(f.chat.id);
    const events: string[] = [];
    const unsubscribe = f.store.onWorkspaceEvent(event => events.push(event.type));
    try {
      expect(() => f.transaction(() => {
        f.store.sendEnvelopeWithinTransaction({ ...f.env, dedupeKey: "rollback" }, f.collector, f.queue);
        f.store.sendEnvelopeWithinTransaction({ ...f.env, dedupeKey: "rollback",
          to: { role: "chat", agentId: f.agent.id, chatSessionId: f.chat.id } }, f.collector, f.queue);
        (f.store as unknown as { ctx: StoreContext }).ctx.emitCommitEvents(f.queue);
        expect(events).toEqual([]);
        throw new Error("abort");
      })).toThrow("abort");
      expect(events).toEqual([]);
    } finally { unsubscribe(); }
    expect(f.queued()).toBe(0);
    expect(f.db.query("SELECT head_seq, log_version FROM multiremi_conversation_heads WHERE session_id = ?").get(f.session.id)).toEqual(before);
    expect(f.db.query("SELECT head_seq, log_version FROM multiremi_conversation_heads WHERE session_id = ?").get(f.chat.id)).toEqual(chatBefore);
    expect(Number(f.db.query("SELECT COUNT(*) AS n FROM multiremi_conversation_log WHERE session_id = ? AND kind = 'system'").get(f.session.id).n)).toBe(0);
  });

  it("addresses delegation reports to the delegator's originating Issue session", () => {
    const f = setup();
    const worker = f.store.createAgent({ name: "Delegate", provider: "codex" });
    const parent = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, issueSessionId: f.session.id, prompt: "Original round" });
    const child = f.store.createIssue({ title: "Delegated issue", parentIssueId: f.issue.id });
    const source = f.store.createTask({ agentId: worker.id, issueId: child.id, prompt: "Delegated round", parentTaskId: parent.id,
      delegationId: "return_address", delegatedByAgentId: f.agent.id, delegatedFromIssueSessionId: f.session.id });
    const delivery = f.send({ to: { role: "delegator", delegationId: "return_address" }, source: { taskId: source.id } })[0]!;
    expect(delivery.recipient.issueSessionId).toBe(f.session.id);
    expect(delivery.recipient.agentId).toBe(f.agent.id);
    expect(delivery.task!.id).toBe(parent.id);
    expect(delivery.action).toBe("coalesced");
  });

  it("fans relay addresses out as Chat-lane system messages with relay wakes", () => {
    const f = setup();
    const secondChat = f.store.createChatSession({ agentId: f.agent.id });
    for (const [i, chat] of [f.chat, secondChat].entries()) {
      f.db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
        (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, issue_id, created_at, updated_at)
        VALUES (?, ?, 'relay_test', ?, ?, ?, ?, ?, ?)`,
      [`relay_${i}`, f.agent.workspaceId, f.agent.id, `relay_${i}`, chat.id, f.issue.id,
        "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:00.000Z"]);
    }
    const deliveries = f.send({ to: { role: "relay", issueId: f.issue.id }, dedupeKey: "fanout" });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]!.entry.id).not.toBe(deliveries[1]!.entry.id);
    expect(deliveries.map(row => row.recipient.chatSessionId).sort()).toEqual([f.chat.id, secondChat.id].sort());
    expect(deliveries.map(row => row.task!.wakeSource)).toEqual(["relay", "relay"]);
    expect(deliveries.map(row => row.action)).toEqual(["created", "created"]);
    expect(deliveries.map(row => row.task!.issueSessionId)).toEqual([null, null]);
    expect(f.queued()).toBe(2);
    expect(f.send({ to: { role: "relay", issueId: f.issue.id }, dedupeKey: "fanout" }).map(row => row.deduplicated)).toEqual([true, true]);
  });
});
