import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

pendingTurnBackendTests("MUL-508 unified API", (fixture) => {
let store: MultiremiStore, app: ReturnType<typeof createMultiremiApp>;
let db: SqlDatabase;
let agent: ReturnType<MultiremiStore["createAgent"]>, other: typeof agent;
let issue: ReturnType<MultiremiStore["createIssue"]>, session: ReturnType<MultiremiStore["getOrCreateDefaultIssueSession"]>;
beforeEach(() => {
  store = fixture().store;
  db = fixture().db;
  agent = store.createAgent({ name: "Worker", provider: "codex", visibility: "workspace" });
  other = store.createAgent({ name: "Other", provider: "codex", visibility: "workspace" });
  issue = store.createIssue({ title: "API", assigneeType: "agent", assigneeId: agent.id });
  session = store.getOrCreateDefaultIssueSession(issue.id); app = createMultiremiApp({ store });
});
afterEach(() => { store.stopNotificationDeliverySweeper(); });
const path = () => `/api/sessions/${session.id}/messages`;
async function request(url: string, method = "GET", input?: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(url, { method, headers: { "Content-Type": "application/json", ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  return { status: response.status, data: await response.json() as any };
}
const send = (body_md: string, input = {}) => request(path(), "POST", { body_md, to: { type: "agent", ref: agent.id }, ...input });

it("sends all message kinds and wake values, freezes identity, and deduplicates", async () => {
  for (const message_kind of ["request", "reply", "report", "decision", "status", "final"]) {
    const result = await send(message_kind, { message_kind, wake_requested: "inbox_only", sender: { type: "agent", id: other.id }, visibility: "hidden" });
    expect(result.status).toBe(200); expect(result.data.message.sender_type).toBe("member");
    expect(result.data.message.sender_id).toBe("mem_local_local"); expect(result.data.message.visibility).toBe("shown");
    expect(result.data.message.message_kind).toBe(message_kind);
    expect(result.data.message).not.toHaveProperty("card_token_hash");
  }
  const first = await send("dedupe", { dedupe_key: "once" });
  const twice = await send("dedupe", { dedupe_key: "once" });
  expect(first.data.message.id).toBe(twice.data.message.id); expect(first.data.turn_id).toBe(twice.data.turn_id);
  expect(store.listMessages(session.id).filter(m => m.dedupe_key === "once")).toHaveLength(1);
  expect((await send("later", { wake_requested: "next_turn" })).data.wake_applied).toBe("next_turn");
});
it("lists pages, kind, thread and recipient unread filters without advancing cursors", async () => {
  const first = (await send("first")).data.message;
  const reply = (await send("reply", { reply_to_id: first.id })).data.message;
  await send("report", { message_kind: "report" });
  const page = await request(`${path()}?limit=1`);
  expect(page.data.messages.map((m: any) => m.id)).toEqual([first.id]); expect(page.data.next_cursor).toBeTruthy();
  const next = await request(`${path()}?limit=1&cursor=${page.data.next_cursor}`);
  expect(next.data.messages[0].id).toBe(reply.id);
  expect((await request(`${path()}?thread=${first.id}`)).data.messages).toHaveLength(2);
  expect((await request(`${path()}?message_kind=report`)).data.messages).toHaveLength(1);
  expect((await request(`${path()}?unread_by=${other.id}`)).data.messages).toHaveLength(0);
  expect(store.getSessionAgentReadProgress(session.id, agent.id).seq).toBe(0);
  expect((await request(`${path()}?cursor=bad`)).status).toBe(400);
  expect((await request(`${path()}?limit=0`)).status).toBe(400);
});
it("reads full range pages and rejects mixed range/list queries", async () => {
  const first = (await send("range")).data.message;
  const range = await request(`${path()}?from=0&to=${first.seq}`);
  expect(range.status).toBe(200); expect(range.data.entries.some((e: any) => e.body_md === "range")).toBe(true);
  expect((await request(`${path()}?from=0&to=${first.seq}&limit=1`)).status).toBe(400);
});
it("gets, edits, resolves, reacts and tombstones a message", async () => {
  const id = (await send("draft")).data.message.id;
  expect((await request(`/api/messages/${id}`, "PATCH", { body_md: "edited", to: { type: "agent", ref: other.id } })).data.message.body_md).toBe("edited");
  expect(store.getMessage(id)?.to_agent_id).toBe(agent.id);
  expect((await request(`/api/messages/${id}/resolve`, "POST", {})).data.message.resolved_at).toBeTruthy();
  expect((await request(`/api/messages/${id}/resolve`, "POST", { resolved: false })).data.message.resolved_at).toBeNull();
  // Unauthenticated internal requests trust an explicitly supplied actor.
  for (let i = 0; i < 2; i++) {
    const explicit = await request(`/api/messages/${id}/reactions`, "POST", { emoji: "+1", actorId: "forged" });
    expect(explicit.status).toBe(200);
    expect(explicit.data.reactions).toEqual([expect.objectContaining({ actorId: "forged", actorType: "member", emoji: "+1" })]);
  }
  expect((await request(`/api/messages/${id}/reactions`, "POST", { emoji: "+1", actorId: "forged", remove: true })).data.reactions).toHaveLength(0);
  const reactions = (await request(`/api/messages/${id}/reactions`, "POST", { emoji: "+1" })).data.reactions;
  expect(reactions[0]).toMatchObject({ commentId: id, actorId: "local", actorType: "member", emoji: "+1" });
  expect((await request(`/api/messages/${id}`)).data.message.reactions).toEqual(reactions);
  expect((await request(`/api/messages/${id}/reactions`, "POST", { emoji: "+1", remove: true })).data.reactions).toHaveLength(0);
  expect((await request(`/api/messages/${id}`, "GET")).data.message.body_md).toBe("edited");
  expect((await request(`/api/messages/${id}`, "DELETE")).data.message.deleted_at).toBeTruthy();
  expect((await request(`/api/messages/${id}`, "DELETE")).status).toBe(200);
  expect((await request(path())).data.messages).toHaveLength(0);
});
it("uses the authenticated member PAT for reactions despite an explicit forged actor", async () => {
  const id = (await send("reaction")).data.message.id;
  const user = store.getOrCreateUser({ externalId: "reaction-member", name: "Reaction member" });
  store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: user.name, role: "member" });
  const access = await store.createAccessToken({ name: "reaction-member", type: "pat", userId: user.id, workspaceId: "local" });
  app = createMultiremiApp({ store, authToken: "fixture-master" });
  const headers = { Authorization: `Bearer ${access.token}` };
  for (let i = 0; i < 2; i++) {
    const result = await request(`/api/messages/${id}/reactions`, "POST", { emoji: "+1", actorId: "forged" }, headers);
    expect(result.status).toBe(200);
    expect(result.data.reactions).toEqual([expect.objectContaining({ commentId: id, actorId: user.id, actorType: "member", emoji: "+1" })]);
    expect((await request(`/api/messages/${id}`, "GET", undefined, headers)).data.message.reactions).toEqual(result.data.reactions);
  }
  const removed = await request(`/api/messages/${id}/reactions`, "POST", { emoji: "+1", actorId: "forged", remove: true }, headers);
  expect(removed.status).toBe(200); expect(removed.data.reactions).toHaveLength(0);
});
it("rejects editing consumed content and editing another sender's message", async () => {
  const sent = await send("consumed");
  store.recordSessionAgentInlineRead(session.id, agent.id, [sent.data.message.seq], sent.data.message.seq);
  expect((await request(`/api/messages/${sent.data.message.id}`, "PATCH", { body_md: "changed" })).status).toBe(409);
  expect((await request(`/api/messages/${sent.data.message.id}`, "DELETE")).status).toBe(409);
  const message = store.sendMessage({ session_id: session.id, sender: { type: "agent", id: other.id }, to: { type: "none" }, message_kind: "report", wake_requested: "inbox_only", body_md: "other" }).message;
  expect((await request(`/api/messages/${message.id}`, "PATCH", { body_md: "changed" })).status).toBe(403);
});
it("stores member inbox cursor and attention counts without old inbox_items", async () => {
  db.exec("DROP TABLE multiremi_inbox_items");
  for (const kind of ["decision", "status"] as const) store.sendMessage({ session_id: session.id, sender: { type: "agent", id: agent.id }, to: { type: "member", ref: "mem_local_local" }, message_kind: kind, wake_requested: "now", body_md: kind });
  const page = await request("/api/inbox?limit=1");
  expect(page.status).toBe(200); expect(page.data.items).toHaveLength(1); expect(page.data.unread_count).toBe(2); expect(page.data.attention_count).toBe(1);
  const second = await request(`/api/inbox?limit=1&cursor=${page.data.next_cursor}`);
  expect(second.data.items[0].id).not.toBe(page.data.items[0].id); expect(second.data.unread_count).toBe(2);
  const seq = store.listMessages(session.id)[0]!.seq;
  expect((await request("/api/inbox/read", "POST", { session_id: session.id, to_seq: seq })).data.cursor_seq).toBe(seq);
  expect((await request("/api/inbox/read", "POST", { session_id: session.id, to_seq: 0 })).data.cursor_seq).toBe(seq);
  expect((await request("/api/inbox/read", "POST", { session_id: session.id, to_seq: 9999 })).status).toBe(400);
  expect((await request("/api/inbox/read", "POST", { all: true })).data.conversations_read).toBe(1);
  expect((await request("/api/inbox")).data.unread_count).toBe(0);
});
it("routes decision option answers through the original message and rejects replay", async () => {
  const message = store.sendMessage({ session_id: session.id, sender: { type: "agent", id: agent.id }, to: { type: "member", ref: "mem_local_local" }, body_md: "Choose", message_kind: "decision", wake_requested: "now", options: [{ label: "Yes", value: "yes" }] }).message;
  expect((await send("", { reply_to_id: message.id, metadata: { selected_options: ["bad"] } })).status).toBe(400);
  const answered = await send("", { reply_to_id: message.id, metadata: { selected_options: ["yes"] } });
  expect(answered.status).toBe(200); expect(answered.data.message.reply_to_id).toBe(message.id); expect(answered.data.message.body_md).toBe("yes");
  expect(store.getMessage(message.id)?.resolved_at).toBeTruthy();
  expect((await send("again", { reply_to_id: message.id })).status).toBe(409);
  const range = await request(`${path()}?from=0&to=${message.seq}`);
  const entry = range.data.entries.find((m: any) => m.id === message.id);
  expect(entry).not.toHaveProperty("card_token_hash");
  expect(entry).not.toHaveProperty("card_token_recipient");
});
it("answers an awaiting human request and restores the same turn", async () => {
  const sent = await send("work"), turn = store.getTurn(sent.data.turn_id)!;
  db.run("UPDATE multiremi_turns SET status='running' WHERE id=?", [turn.id]);
  db.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?", [turn.current_attempt_id!]);
  const question = store.createTaskHumanRequest({ taskId: turn.current_attempt_id!, kind: "question", payload: { title: "Question", questions: [{ question: "Continue?" }] } });
  expect(store.getTurn(turn.id)?.status).toBe("awaiting_human");
  expect((await send("Yes", { reply_to_id: question.id })).status).toBe(200);
  expect(store.getTaskHumanRequest(question.id)?.response).toEqual({ answer: "Yes", answers: { "Continue?": "Yes" } });
  expect(store.getTurn(turn.id)?.status).toBe("running");
  expect(store.listTurns({ workspace_id: "local" })).toHaveLength(1);
});
it("lists and inspects turns, wraps up, cancels and retries with trace tied to the attempt", async () => {
  const sent = await send("work"), id = sent.data.turn_id, oldAttempt = store.getTurn(id)!.current_attempt_id;
  const listed = await request(`/api/turns?issue=${issue.key}&agent=${agent.id}&status=pending&limit=1`);
  expect(listed.data.turns).toHaveLength(1);
  const detail = await request(`/api/turns/${id}?input=true&attempts=true`);
  expect(detail.data.input.messages[0].body_md).toBe("work"); expect(detail.data.attempts[0].id).toBe(oldAttempt);
  expect((await request(`/api/turns/${id}/wrap-up`, "POST", {})).status).toBe(409);
  db.run("UPDATE multiremi_turns SET status='running' WHERE id=?", [id]);
  db.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?", [oldAttempt]);
  expect((await request(`/api/turns/${id}/wrap-up`, "POST", {})).data.turn.wrap_up_requested_at).toBeTruthy();
  expect(store.listMessages(session.id)).toHaveLength(1);
  expect((await request(`/api/turns/${id}/cancel`, "POST", {})).data.turn.status).toBe("cancelled");
  store.setAgentRole(other.id, "supervisor");
  const supervisorIssue = store.createIssue({ title: "Supervision", assigneeType: "agent", assigneeId: other.id });
  const supervisorTask = store.createTask({ agentId: other.id, issueId: supervisorIssue.id, prompt: "Supervise" });
  const supervisor = await store.createTaskAccessToken(supervisorTask, "local");
  store.updateWorkspace("local", { settings: { ...store.getWorkspace("local")!.settings, organizer: { mode: "act" } } });
  const retried = await request(`/api/turns/${id}/retry`, "POST", { cold: true }, { Authorization: `Bearer ${supervisor.token}` });
  expect(retried.status, JSON.stringify(retried.data)).toBe(200); expect(retried.data.turn.id).toBe(id); expect(retried.data.turn.current_attempt_id).not.toBe(oldAttempt);
  expect(store.listTurns({ workspace_id: "local", issue_id: issue.id })).toHaveLength(1); expect(store.listTurnAttempts(id)).toHaveLength(2);
  expect((await request(`/api/turns/${id}/trace`)).data.attempt_id).toBe(retried.data.turn.current_attempt_id);
  expect((await request(`/api/turns/${id}/trace?attempt_id=${oldAttempt}`)).data.attempt_id).toBe(oldAttempt);
  expect((await request(`/api/turns/${id}/trace?attempt_id=other`)).status).toBe(404);
});
it("rejects a supervisor retrying its own target task with its task token", async () => {
  store.setAgentRole(agent.id, "supervisor");
  store.updateWorkspace("local", { settings: { ...store.getWorkspace("local")!.settings, organizer: { mode: "act" } } });
  const sent = await send("work"), turn = store.getTurn(sent.data.turn_id)!;
  const access = await store.createTaskAccessToken(store.getTask(turn.current_attempt_id!)!, "local");
  app = createMultiremiApp({ store, authToken: "fixture-master" });
  const result = await request(`/api/turns/${turn.id}/retry`, "POST", { cold: true }, { Authorization: `Bearer ${access.token}` });
  expect(result.status).toBe(403); expect(result.data.code).toBe("organizer_self_action_forbidden");
  expect(store.getTurn(turn.id)).toEqual(turn); expect(store.listTurnAttempts(turn.id)).toHaveLength(1);
});
it("uses the task credential for message sender, source turn and its own inbox", async () => {
  const sent = await send("source"), turn = store.getTurn(sent.data.turn_id)!;
  const token = await store.createAccessToken({ name: "fixture", type: "task", workspaceId: "local", userId: "local", taskId: turn.current_attempt_id!, agentId: agent.id });
  app = createMultiremiApp({ store, authToken: "fixture-master" });
  const headers = { Authorization: `Bearer ${token.token}` };
  const dispatched = await request(path(), "POST", { body_md: "dispatch", to: { type: "agent", ref: other.id }, sender: { type: "member", id: "mem_local_local" } }, headers);
  expect(dispatched.status).toBe(200); expect(dispatched.data.message.sender_id).toBe(agent.id); expect(dispatched.data.message.task_id).toBe(turn.id); expect(dispatched.data.wake_reason).toBe("agent_dispatch");
  const inbox = await request("/api/inbox", "GET", undefined, headers);
  expect(inbox.data.items.map((m: any) => m.id)).toEqual([sent.data.message.id]);
  expect((await request("/api/inbox/read", "POST", { session_id: session.id }, headers)).status).toBe(200);
  expect((await request("/api/inbox", "GET", undefined, headers)).data.unread_count).toBe(0);
  expect((await request(`/api/turns/${dispatched.data.turn_id}/cancel`, "POST", {}, headers)).status).toBe(403);
});
it("rejects cross workspace resources and malformed sends without writes", async () => {
  const workspace = store.createWorkspace({ name: "Foreign" }), foreignAgent = store.createAgent({ name: "Foreign", provider: "codex", workspaceId: workspace.id });
  const user = store.getOrCreateUser({ externalId: "api-user", name: "Reader" });
  store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: "Reader", role: "member" });
  const access = await store.createAccessToken({ name: "reader", type: "pat", userId: user.id, workspaceId: "local", purpose: "session" });
  app = createMultiremiApp({ store, authToken: "fixture-master" });
  const headers = { Authorization: `Bearer ${access.token}` };
  expect((await request(path(), "POST", { body_md: "foreign", to: { type: "agent", ref: foreignAgent.id } }, headers)).status).toBe(400);
  expect((await request(path(), "POST", { body_md: "invalid", wake_requested: "invalid" }, headers)).status).toBe(400);
  const foreignIssue = store.createIssue({ title: "Foreign", workspaceId: workspace.id }), foreignSession = store.getOrCreateDefaultIssueSession(foreignIssue.id);
  expect((await request(`/api/sessions/${foreignSession.id}/messages`, "GET", undefined, headers)).status).toBe(404);
  expect(store.listMessages(session.id)).toHaveLength(0);
});
it("sends atomic multipart attachments and cleans files on validation failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mul508-upload-")), previous = process.env.MULTIREMI_UPLOAD_DIR;
  process.env.MULTIREMI_UPLOAD_DIR = dir;
  try {
    const form = new FormData(); form.set("message", JSON.stringify({ body_md: "file", to: { type: "none" }, dedupe_key: "file-once" })); form.append("file", new File(["bytes"], "sample.txt"));
    const response = await app.request(path(), { method: "POST", body: form }), result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(200); expect(result.message.attachments).toHaveLength(1);
    expect(store.getAttachment(result.message.attachments[0].id)?.commentId).toBe(result.message.id);
    expect((await request(`/api/messages/${result.message.id}`)).data.message.attachments[0].filename).toBe("sample.txt");
    const retry = new FormData(); retry.set("message", JSON.stringify({ body_md: "retry", dedupe_key: "file-once" })); retry.append("file", new File(["again"], "again.txt"));
    const repeated = await app.request(path(), { method: "POST", body: retry });
    expect(repeated.status).toBe(200); expect((await repeated.json() as any).message.id).toBe(result.message.id);
    const failed = new FormData(); failed.set("message", JSON.stringify({ body_md: "bad", attachment_ids: [result.message.attachments[0].id] })); failed.append("file", new File(["rollback"], "rollback.txt"));
    expect((await app.request(path(), { method: "POST", body: failed })).status).toBe(400);
    expect(readdirSync(dir, { recursive: true }).filter(name => String(name).endsWith(".txt"))).toHaveLength(1);
    expect(Number((db.query("SELECT COUNT(*) AS n FROM multiremi_attachments").get() as { n: number }).n)).toBe(1);
    expect(store.listMessages(session.id)).toHaveLength(1);
    const parent = store.createIssue({ title: "Parent", assigneeType: "agent", assigneeId: other.id });
    store.updateIssue(issue.id, { parentIssueId: parent.id });
    const routed = new FormData();
    routed.set("message", JSON.stringify({ body_md: "parent file", to: { type: "role", ref: "parent_owner" }, wake_requested: "inbox_only" }));
    routed.append("file", new File(["parent"], "parent.txt"));
    const routedResponse = await app.request(path(), { method: "POST", body: routed });
    const delivered = await routedResponse.json() as any;
    expect(routedResponse.status, JSON.stringify(delivered)).toBe(200);
    expect(delivered.message.session_id).toBe(store.getOrCreateDefaultIssueSession(parent.id).id);
    expect(delivered.message.attachments[0]).toMatchObject({ commentId: delivered.message.id, issueId: parent.id });
  } finally { if (previous === undefined) delete process.env.MULTIREMI_UPLOAD_DIR; else process.env.MULTIREMI_UPLOAD_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
});
it("filters private conversations before inbox counts, pagination and read-all", async () => {
  const user = store.getOrCreateUser({ externalId: "private-chat-owner", name: "Private" });
  const chat = store.createChatSession({ agentId: agent.id, creatorId: user.id });
  store.sendMessage({ session_id: chat.id, sender: { type: "agent", id: agent.id }, to: { type: "member", ref: "mem_local_local" }, message_kind: "decision", wake_requested: "now", body_md: "Private" });
  const shown = store.sendMessage({ session_id: session.id, sender: { type: "agent", id: agent.id }, to: { type: "member", ref: "mem_local_local" }, message_kind: "request", wake_requested: "now", body_md: "Visible" }).message;
  app = createMultiremiApp({ store, authToken: "master" });
  const token = await store.createAccessToken({ name: "local", type: "pat", userId: "local", workspaceId: "local" });
  const headers = { Authorization: `Bearer ${token.token}` };
  const page = await request("/api/inbox?limit=1", "GET", undefined, headers);
  expect(page.data.items.map((m: any) => m.id)).toEqual([shown.id]); expect(page.data.unread_count).toBe(1); expect(page.data.next_cursor).toBeNull();
  expect((await request("/api/inbox/read", "POST", { all: true }, headers)).data.conversations_read).toBe(1);
  expect(store.listMessageInbox("mem_local_local", "local").unread_count).toBe(1);
});
it("lets the addressed agent answer a decision once through its authenticated message sender", async () => {
  const turn = store.getTurn((await send("source")).data.turn_id)!;
  const question = store.sendMessage({ session_id: session.id, sender: { type: "agent", id: other.id }, to: { type: "agent", ref: agent.id }, message_kind: "decision", wake_requested: "inbox_only", body_md: "Choose", options: [{ label: "Yes", value: "yes" }] }).message;
  app = createMultiremiApp({ store, authToken: "master" });
  const token = await store.createAccessToken({ name: "agent", type: "task", taskId: turn.current_attempt_id!, agentId: agent.id, userId: "local", workspaceId: "local" });
  const headers = { Authorization: `Bearer ${token.token}` };
  const memberToken = await store.createAccessToken({ name: "member", type: "pat", userId: "local", workspaceId: "local" });
  expect((await request(path(), "POST", { reply_to_id: question.id, body_md: "forged" }, { Authorization: `Bearer ${memberToken.token}` })).status).toBe(400);
  expect(store.getMessage(question.id)?.metadata.decision_record).toMatchObject({ status: "pending" });
  expect(store.getMessage(question.id)?.resolved_at).toBeNull();
  const result = await request(path(), "POST", { reply_to_id: question.id, metadata: { selected_options: ["yes"] } }, headers);
  expect(result.status).toBe(200); expect(result.data.message.sender_id).toBe(agent.id); expect(result.data.message.to_agent_id).toBe(other.id);
  expect(store.getMessage(question.id)?.resolved_at).toBeTruthy();
  expect((await request(path(), "POST", { reply_to_id: question.id, body_md: "replay" }, headers)).status).toBe(409);
});
it("run-now leaves a request in auto conversation with an execution turn", async () => {
  const auto = store.createAutopilot({ title: "Manual", assigneeId: agent.id, executionMode: "run_only", description: "Run" });
  expect((await request(`/api/autopilots/${auto.id}/trigger`, "POST", {})).status).toBe(200);
  const messages = await request(`/api/sessions/auto_${auto.id}/messages`);
  expect(messages.status).toBe(200); expect(messages.data.messages.filter((m: any) => m.message_kind === "request")).toHaveLength(1);
  expect((await request(`/api/turns?session_id=auto_${auto.id}`)).data.turns).toHaveLength(1);
});
});
