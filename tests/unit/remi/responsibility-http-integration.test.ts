import { afterEach, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { ApiClient } from "../../../frontend/packages/core/api/client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it("uses the browser API client against authenticated HTTP for creation, Q routing and exact delivery acceptance", async () => {
  const db = openSqliteDatabase(":memory:");
  try {
    const store = new MultiremiStore(db); store.ensureLocalWorkspace();
    const user = store.getOrCreateUser({ email: "responsible-http@example.invalid", name: "Designated synthetic human" });
    const human = store.createWorkspaceMember({ userId: user.id, workspaceId: "local", name: user.name, role: "member" });
    const otherUser = store.getOrCreateUser({ email: "other-http@example.invalid", name: "Other synthetic human" });
    store.createWorkspaceMember({ userId: otherUser.id, workspaceId: "local", name: otherUser.name, role: "member" });
    const pat = await store.createAccessToken({ name: "Designated human fixture", type: "pat", userId: user.id, workspaceId: "local" });
    const otherPat = await store.createAccessToken({ name: "Other human fixture", type: "pat", userId: otherUser.id, workspaceId: "local" });
    const runtime = store.registerRuntime({ name: "HTTP synthetic provider", provider: "codex", daemonId: "http-fixture-daemon", ownerId: user.id, maxConcurrency: 8 });
    const owner = store.createAgent({ name: "HTTP root coordinator", provider: "codex", runtimeId: runtime.id, ownerId: user.id, visibility: "workspace", maxConcurrentTasks: 8 });
    const worker = store.createAgent({ name: "HTTP child coordinator", provider: "codex", runtimeId: runtime.id, ownerId: user.id, visibility: "workspace", maxConcurrentTasks: 8 });
    const app = createMultiremiApp({ store, authToken: "fixture-master-required" });
    globalThis.fetch = ((input, init) => app.request(new Request(input, init))) as typeof fetch;
    const client = new ApiClient("http://responsibility-http.test"); client.setToken(pat.token);
    const root = await client.createIssue({ title: "HTTP root", workspace_id: "local", responsible_member_id: human.id, assignee_type: "agent", assignee_id: owner.id });
    const child = await client.createIssue({ title: "HTTP child", workspace_id: "local", parent_issue_id: root.id, assignee_type: "agent", assignee_id: worker.id });
    expect(child.responsible_member_id).toBeNull();
    const facts = await client.getIssueResponsibility(child.id);
    expect(facts.executionOwner?.id).toBe(worker.id); expect(facts.reviewOwner?.id).toBe(owner.id); expect(facts.rootHuman?.id).toBe(human.id);
    const sourceTask = store.createTask({ agentId: worker.id, issueId: child.id, prompt: "Ask and deliver" });
    const ownerTask = store.createTask({ agentId: owner.id, issueId: root.id, prompt: "Coordinate and review" });
    for (let count = 0; count < 8; count++) { const claimed = store.claimTask(runtime.id); if (!claimed) break; store.startTask(claimed.id); }
    const sourceToken = await store.createTaskAccessToken(store.getTask(sourceTask.id)!, user.id);
    const ownerToken = await store.createTaskAccessToken(store.getTask(ownerTask.id)!, user.id);
    const sourceTurn = store.getTurnForAttempt(sourceTask.id)!;
    const request = store.getDaemonTurnBridge().rpc("turn.decision", { turn_id: sourceTurn.id, attempt_id: sourceTask.id, dedupe_key: "http-original-question", wait_id: "http-provider-wait", body_md: "Original multi-question AUQ", options: [], metadata: { kind: "question", context: { text: "Original provider context" }, questions: [
      { fieldKey: "approach", otherFieldKey: "other", question: { question: "Choose approaches?", options: [{ label: "A" }, { label: "B" }], multiSelect: true } },
      { fieldKey: "reason", question: { question: "Why?", options: [] } },
    ] } }, { runtimeId: runtime.id, daemonId: runtime.daemonId ?? "", workspaceId: "local" });
    expect(request).toMatchObject({ ok: true });
    const initial = await client.getQuestion(String(request.message_id));
    expect(initial.current_handler?.id).toBe(owner.id); expect(initial.original_context?.text).toBe("Original provider context");
    client.setToken(ownerToken.token);
    const escalated = await client.actOnQuestion(initial.id, "escalate", { expected_route_revision: initial.route_revision, reason: "Human decision needed" });
    expect(escalated.current_handler).toEqual({ type: "member", id: human.id });
    client.setToken(otherPat.token);
    await expect(client.actOnQuestion(initial.id, "answer", { expected_route_revision: escalated.route_revision, response: { answer: "Impostor" } })).rejects.toThrow();
    client.setToken(pat.token);
    const answered = await client.actOnQuestion(initial.id, "answer", { expected_route_revision: escalated.route_revision, response: { answers: { "Choose approaches?": "A, B", "Why?": "Evidence" } } });
    expect(answered.status).toBe("answered"); expect(answered.answer_revision).toBe(1);
    expect(store.getMessage(answered.answer!.reply_message_id)?.session_id).toBe(initial.session_id);
    expect(store.getMessage(answered.answer!.reply_message_id)?.reply_to_id).toBe(initial.id);
    const consumed = store.getDaemonTurnBridge().rpc("turn.decision.consume", { turn_id: sourceTurn.id, attempt_id: sourceTask.id, message_id: initial.id, reply_message_id: answered.answer!.reply_message_id, wait_id: "http-provider-wait" }, { runtimeId: runtime.id, daemonId: "http-fixture-daemon", workspaceId: "local" });
    expect(consumed).toMatchObject({ ok: true });
    expect((await client.getQuestion(initial.id)).wait_status).toBe("consumed");
    const revised = await client.actOnQuestion(initial.id, "answer", { expected_route_revision: answered.route_revision, expected_answer_revision: answered.answer_revision, revise: true, reason: "New evidence", response: { answers: { "Choose approaches?": "B", "Why?": "Revised evidence" } } });
    expect(revised.answer_revision).toBe(2); expect((await client.listIssueQuestions(root.id)).some(q => q.id === initial.id)).toBe(true);
    client.setToken(sourceToken.token);
    const childDelivery = await client.submitIssueDelivery(child.id, { summary: "Child implementation and evidence" });
    client.setToken(pat.token);
    await expect(client.respondIssueDelivery(child.id, childDelivery.id, { action: "accept", revision: childDelivery.responsibilityRevision })).rejects.toThrow();
    client.setToken(ownerToken.token);
    const childAccepted = await client.respondIssueDelivery(child.id, childDelivery.id, { action: "accept", revision: childDelivery.responsibilityRevision });
    expect(childAccepted.status).toBe("accepted");
    const rootDelivery = await client.submitIssueDelivery(root.id, { summary: "Integrated child evidence" });
    client.setToken(otherPat.token);
    await expect(client.respondIssueDelivery(root.id, rootDelivery.id, { action: "accept", revision: rootDelivery.responsibilityRevision })).rejects.toThrow();
    client.setToken(pat.token);
    const accepted = await client.respondIssueDelivery(root.id, rootDelivery.id, { action: "accept", revision: rootDelivery.responsibilityRevision });
    expect(accepted.status).toBe("accepted"); expect((await client.getIssue(root.id)).status).toBe("done");
    expect((await client.listIssueDeliveries(root.id))[0]?.id).toBe(rootDelivery.id);
  } finally { db.close(); }
}, 30_000);
