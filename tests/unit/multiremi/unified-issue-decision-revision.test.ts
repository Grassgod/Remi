import { afterEach, expect, it, setSystemTime } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

afterEach(() => setSystemTime());

pendingTurnBackendTests("MUL-508 Issue decision revisions", fixture => {
  async function setup() {
    const { store, db } = fixture();
    const member = store.findWorkspaceMemberForUser("local", "local")!;
    const owner = store.createAgent({ name: "Parent owner", provider: "codex", ownerId: member.id });
    const worker = store.createAgent({ name: "Source owner", provider: "codex" });
    const parent = store.createIssue({ title: "Parent", assigneeType: "agent", assigneeId: owner.id });
    const source = store.createIssue({ title: "Source", parentIssueId: parent.id, assigneeType: "agent", assigneeId: worker.id });
    const task = store.createTask({ agentId: owner.id, issueId: parent.id, prompt: "Decide" });
    const sourceTask = store.createTask({ agentId: worker.id, issueId: source.id, prompt: "Ask" });
    const token = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store });
    const decision = store.createIssueDecision(source.id, { kind: "merge", title: "Merge?" }, { type: "agent", id: worker.id, taskId: sourceTask.id });
    const sessionId = store.getMessage(decision.id)!.session_id;
    const reply = async (id: string, body_md: string, auth?: string) => {
      const response = await app.request(`/api/sessions/${sessionId}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify({ message_kind: "reply", reply_to_id: id, body_md,
          response: { reason: "Reviewed", overturn: "A member may revise" } }),
      });
      return { status: response.status, data: await response.json() as any };
    };
    return { store, db, member, owner, worker, parent, source, decision, sessionId, token, reply };
  }

  it("appends each member revision and refreshes history, timestamp and both owner notifications", async () => {
    const f = await setup();
    setSystemTime(new Date("2026-10-01T00:00:00Z"));
    expect((await f.reply(f.decision.id, "Merge after CI", f.token.token)).status).toBe(200);
    const original = f.store.getIssueDecision(f.parent.id, f.decision.id)!;
    const repliesBefore = f.store.listMessages(f.sessionId, { thread: f.decision.id }).filter(m => m.sender_type === "member");
    setSystemTime(new Date("2026-10-01T00:00:01Z"));
    const revised = await f.reply(f.decision.id, "Hold for QA");
    expect(revised.status, JSON.stringify(revised.data)).toBe(200);
    expect(revised.data.message).toMatchObject({ message_kind: "reply", reply_to_id: f.decision.id,
      body_md: "Hold for QA", sender_type: "member", sender_id: f.member.id });
    const { attachments, reactions, ...persistedFields } = revised.data.message;
    expect(attachments).toEqual([]);
    expect(reactions).toEqual([]);
    expect(f.store.getMessage(revised.data.message.id)).toMatchObject(persistedFields);
    const after = f.store.getIssueDecision(f.parent.id, f.decision.id)!;
    expect(after.history.map(h => h.answererType)).toEqual(["agent", "member"]);
    expect(after.history[0]).toEqual(original.history[0]);
    expect(after.answeredAt).toBe("2026-10-01T00:00:01.000Z");
    expect(after.answeredAt).toBe(after.history[1]!.answeredAt);
    expect(f.store.listMessages(f.sessionId, { thread: f.decision.id }).filter(m => m.sender_type === "member"))
      .toHaveLength(repliesBefore.length + 1);
    const notifications = f.db.query("SELECT dedupe_key,to_agent_id,body_md FROM multiremi_conversation_log WHERE dedupe_key IN (?,?)")
      .all(`decision_answer:${f.decision.id}:2`, `decision_overturn:${f.decision.id}:2`);
    expect(notifications).toHaveLength(2);
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ dedupe_key: `decision_answer:${f.decision.id}:2`, to_agent_id: f.worker.id }),
      expect.objectContaining({ dedupe_key: `decision_overturn:${f.decision.id}:2`, to_agent_id: f.owner.id }),
    ]));
    expect(notifications.every(n => String(n.body_md).includes("Hold for QA"))).toBe(true);
    expect((await f.reply(f.decision.id, "Agent cannot revise", f.token.token)).status).toBe(409);
    expect(f.store.getIssueDecision(f.parent.id, f.decision.id)?.history).toEqual(after.history);
    setSystemTime(new Date("2026-10-01T00:00:02Z"));
    const again = await f.reply(f.decision.id, "Wait for final QA");
    expect(again.status).toBe(200);
    expect(again.data.message.id).not.toBe(revised.data.message.id);
    expect(f.store.getIssueDecision(f.parent.id, f.decision.id)?.history).toHaveLength(3);
    expect(f.db.query("SELECT id FROM multiremi_conversation_log WHERE dedupe_key=?").get(`decision_overturn:${f.decision.id}:3`)).toBeNull();
  });

  it("keeps withdrawn Issue decisions, ordinary decisions and human requests settled without writes", async () => {
    const f = await setup();
    f.store.withdrawIssueDecision(f.parent.id, f.decision.id, { type: "member", id: f.member.id, taskId: null });
    const plain = f.store.sendMessage({ session_id: f.sessionId, sender: { type: "agent", id: f.owner.id },
      to: { type: "member", ref: f.member.id }, message_kind: "decision", wake_requested: "inbox_only", body_md: "Plain?" }).message;
    expect((await f.reply(plain.id, "Yes")).status).toBe(200);
    const humanTask = f.store.createTask({ agentId: f.owner.id, issueId: f.parent.id, prompt: "Question" });
    const human = f.store.createTaskHumanRequest({ taskId: humanTask.id, kind: "question", payload: { questions: [{ question: "Continue?" }] } });
    const app = createMultiremiApp({ store: f.store });
    const response = await app.request(`/api/sessions/${f.sessionId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply_to_id: human.id, response: { answers: { "Continue?": "Yes" } } }) });
    expect(response.status, await response.clone().text()).toBe(200);
    for (const id of [f.decision.id, plain.id, human.id]) {
      const head = f.store.getConversationLogHead(f.sessionId)!.headSeq;
      expect((await f.reply(id, "Second answer")).status).toBe(409);
      expect(f.store.getConversationLogHead(f.sessionId)!.headSeq).toBe(head);
    }
    expect(f.store.getIssueDecision(f.parent.id, f.decision.id)?.history).toEqual([]);
  });
});
