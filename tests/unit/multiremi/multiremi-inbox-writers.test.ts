import { beforeEach, expect, it } from "bun:test";
import type { Envelope } from "@multiremi/contracts/inbox.js";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import { installPendingTurnTestConstraints, pendingTurnBackendTests } from "./pending-turn-test-backends.js";

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
    const ensure = (changes: Partial<import("@multiremi/store/repos/tasks-repo.js").EnsurePendingTurnInput> = {}) => {
      const pointer = entry();
      return f.transaction(() => f.store.ensurePendingTurnWithinTransaction({
        agentId: agent.id, issueSessionId: session.id, entryId: pointer.id, entrySeq: pointer.seq,
        reason: "test", childStatusChanges: collector, deferredEvents: queue, ...changes,
      }));
    };
    const queued = () => Number(f.db.query("SELECT COUNT(*) AS n FROM multiremi_tasks WHERE status = 'queued'").get().n);
    return { ...f, agent, issue, session, chat, collector, queue, env, send, entry, ensure, queued };
  }

  it("rejects both writers outside a transaction without a write", () => {
    const f = setup();
    const pointer = f.entry();
    expect(() => f.store.ensurePendingTurnWithinTransaction({ agentId: f.agent.id, issueSessionId: f.session.id,
      entryId: pointer.id, entrySeq: pointer.seq, reason: "test", childStatusChanges: [], deferredEvents: f.queue })).toThrow("open transaction");
    expect(() => f.store.sendEnvelopeWithinTransaction(f.env, [], f.queue)).toThrow("open transaction");
    expect(f.queued()).toBe(0);
  });

  it("coalesces an existing queued turn, raises wake_seq monotonically and audits the merge", () => {
    const f = setup();
    const first = f.ensure({ entrySeq: 10 });
    const next = f.ensure({ entrySeq: 20, reason: "later" });
    const older = f.ensure({ entrySeq: 15 });
    expect(first.created).toBe(true);
    expect(next.created).toBe(false);
    expect(older.task!.id).toBe(first.task!.id);
    expect(f.queued()).toBe(1);
    expect(Number(f.db.query("SELECT wake_seq FROM multiremi_tasks WHERE id = ?").get(first.task!.id).wake_seq)).toBe(20);
    const rows = f.db.query("SELECT data FROM multiremi_issue_activity WHERE type = 'pending_turn_coalesced' ORDER BY created_at, id").all();
    expect(rows.map(row => JSON.parse(row.data))).toContainEqual({ task_id: first.task!.id, entry_seq: 20, reason: "later" });
    expect(rows).toHaveLength(2);
    expect(f.queue.enqueuedTasks).toHaveLength(1);
    expect(first.task!.prompt).not.toContain(f.env.body);
    expect(first.task!.wakeSource).toBe("test");
    expect(f.store.getIssue(f.issue.id)!.status).toBe("in_progress");
  });

  it("next_turn creates only on an idle lane and does not change an existing queued or running turn", () => {
    const f = setup();
    const first = f.ensure({ wake: "next_turn", entrySeq: 10 });
    expect(first.created).toBe(true);
    expect(f.ensure({ wake: "next_turn", entrySeq: 20 }).created).toBe(false);
    expect(Number(f.db.query("SELECT wake_seq FROM multiremi_tasks WHERE id = ?").get(first.task!.id).wake_seq)).toBe(10);
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [first.task!.id]);
    expect(f.ensure({ wake: "next_turn" }).created).toBe(false);
    expect(f.queued()).toBe(0);
    expect(f.ensure({ wake: "now" }).created).toBe(true);
    expect(f.queued()).toBe(1);
  });

  it("keeps execution scopes independent and coalesces Chat-only turns", () => {
    const f = setup();
    const main = f.ensure();
    const alpha = f.ensure({ executionScope: "alpha" });
    const beta = f.ensure({ executionScope: "beta" });
    expect(alpha.task!.execution_scope).toBe("alpha");
    expect(main.task!.id).not.toBe(alpha.task!.id);
    expect(alpha.task!.id).not.toBe(beta.task!.id);
    expect(f.ensure({ executionScope: "alpha" }).task!.id).toBe(alpha.task!.id);
    const chat = f.ensure({ issueSessionId: null, chatSessionId: f.chat.id });
    expect(f.ensure({ issueSessionId: null, chatSessionId: f.chat.id }).task!.id).toBe(chat.task!.id);
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
    expect(delivery.created).toBe(false);
  });

  it("fans relay addresses out to active bound Chats while writing one recipient-session entry", () => {
    const f = setup();
    const secondChat = f.store.createChatSession({ agentId: f.agent.id });
    for (const [i, chat] of [f.chat, secondChat].entries()) {
      f.db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
        (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, issue_id, created_at, updated_at)
        VALUES (?, ?, 'relay_test', ?, ?, ?, ?, ?, ?)`,
      [`relay_${i}`, f.agent.workspaceId, f.agent.id, `relay_${i}`, chat.id, f.issue.id,
        "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:00.000Z"]);
    }
    const deliveries = f.send({ to: { role: "relay", issueId: f.issue.id }, wake: "inbox_only", dedupeKey: "fanout" });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]!.entry.id).toBe(deliveries[1]!.entry.id);
    expect(deliveries.map(row => row.recipient.executionScope).sort())
      .toEqual([`relay:${f.chat.id}`, `relay:${secondChat.id}`].sort());
    expect(f.queued()).toBe(0);
  });
});
