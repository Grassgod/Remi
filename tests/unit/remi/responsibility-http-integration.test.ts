import { afterEach, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { ApiClient } from "../../../frontend/packages/core/api/client";
import { getCurrentSlug, getCurrentWsId, setCurrentWorkspace } from "../../../frontend/packages/core/platform/workspace-storage";

const originalFetch = globalThis.fetch;
const originalWorkspace = { slug: getCurrentSlug(), id: getCurrentWsId() };
afterEach(() => {
  globalThis.fetch = originalFetch;
  setCurrentWorkspace(originalWorkspace.slug, originalWorkspace.id);
});

/** An old client may still send the deprecated field; the typed browser client no longer does. */
const deprecatedResponsible = (memberId: string | null) => ({ responsible_member_id: memberId }) as unknown as Record<string, never>;

it("uses the browser client against real HTTP: a deprecated responsible member is ignored, the Chat question handler stays", async () => {
  const db = openSqliteDatabase(":memory:");
  const encryptionBefore = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const store = new MultiremiStore(db);
    const workspace = store.ensureLocalWorkspace();
    setCurrentWorkspace(workspace.slug, workspace.id);
    const user = store.getOrCreateUser({ email: "configuration-http@example.invalid", name: "Configuration admin" });
    const admin = store.createWorkspaceMember({ userId: user.id, workspaceId: "local", name: user.name, role: "admin" });
    const handlerUser = store.getOrCreateUser({ email: "chat-handler-http@example.invalid", name: "Chat question handler" });
    const handler = store.createWorkspaceMember({ userId: handlerUser.id, workspaceId: "local", name: handlerUser.name, role: "member" });
    const pat = await store.createAccessToken({ type: "pat", workspaceId: "local", userId: user.id, name: "Synthetic admin" });
    const runtime = store.registerRuntime({ name: "Configuration HTTP provider", provider: "codex", daemonId: "config-fixture-daemon", ownerId: user.id });
    const agent = store.createAgent({ name: "Configured automation execution", provider: "codex", runtimeId: runtime.id, ownerId: user.id, visibility: "workspace" });
    const app = createMultiremiApp({ store, authToken: "fixture-master-required" });
    globalThis.fetch = ((input, init) => app.request(new Request(input, init))) as typeof fetch;
    const client = new ApiClient("http://responsibility-http.test"); client.setToken(pat.token);
    const stored = (table: string, id: string) => db.query(`SELECT responsible_member_id FROM ${table} WHERE id=?`).get(id);
    const raw = async (path: string, init: RequestInit = {}) => {
      const response = await app.request(path, { ...init, headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" } });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    // Automations create Issues without a designated human; the field is accepted and dropped.
    const automation = await client.createAutopilot({ title: "Plain automation", assignee_type: "agent", assignee_id: agent.id, execution_mode: "create_issue",
      ...deprecatedResponsible(handler.id) });
    expect(store.getAutopilot(automation.id)).not.toHaveProperty("responsibleMemberId");
    expect(stored("multiremi_autopilots", automation.id)).toEqual({ responsible_member_id: null });
    await client.updateAutopilot(automation.id, { ...deprecatedResponsible(admin.id) });
    expect(stored("multiremi_autopilots", automation.id)).toEqual({ responsible_member_id: null });
    const run = await client.triggerAutopilot(automation.id);
    expect(store.getIssue(run.issue_id!)).toMatchObject({ assigneeType: "agent", assigneeId: agent.id });
    expect(stored("multiremi_issues", run.issue_id!)).toEqual({ responsible_member_id: null });

    // The Feishu bot keeps its Chat question handler.
    const bot = await client.saveFeishuBot("local", { agent_id: agent.id, runtime_id: runtime.id, app_id: "cli_http_fixture", app_secret: "synthetic-secret",
      app_secret_op: "set", domain: "feishu", enabled: false, responsible_member_id: handler.id });
    expect(bot.responsible_member_id).toBe(handler.id);
    expect(store.getFeishuBotConfig("local")?.responsibleMemberId).toBe(handler.id);

    // Issue topics and Issues accept the deprecated field and never return it.
    await client.saveIssueTopicConfig("local", { enabled: true, chat_id: "oc_http_fixture", project_ids: null, ...deprecatedResponsible(admin.id) });
    const topic = await raw("/api/workspaces/local/issue-topics");
    expect(topic.status).toBe(200);
    expect(topic.body.config).toMatchObject({ enabled: true, chat_id: "oc_http_fixture" });
    expect(topic.body.config).not.toHaveProperty("responsible_member_id");
    const root = await client.createIssue({ title: "Plain root", ...deprecatedResponsible(handler.id) });
    expect(stored("multiremi_issues", root.id)).toEqual({ responsible_member_id: null });
    expect((await raw(`/api/issues/${root.id}`)).body).not.toHaveProperty("responsible_member_id");

    // The historical mapping routes are retired with a replacement hint.
    for (const [path, method] of [["/api/workspaces/local/issue-responsibility-migration", "GET"],
      ["/api/workspaces/local/issue-responsibility-migration/map", "POST"]] as const) {
      const retired = await raw(path, { method, ...(method === "POST" ? { body: JSON.stringify({ reason: "Retired", mappings: [] }) } : {}) });
      expect(retired.status, path).toBe(410);
      expect(retired.body, path).toMatchObject({ code: "route_retired" });
    }
  } finally {
    if (encryptionBefore === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = encryptionBefore;
    db.close();
  }
}, 30_000);

it("uses the browser API client against authenticated HTTP for creation, Q routing, member answers and the done rule", async () => {
  const db = openSqliteDatabase(":memory:");
  try {
    const store = new MultiremiStore(db);
    const workspace = store.ensureLocalWorkspace();
    setCurrentWorkspace(workspace.slug, workspace.id);
    const user = store.getOrCreateUser({ email: "member-http@example.invalid", name: "Synthetic member" });
    store.createWorkspaceMember({ userId: user.id, workspaceId: "local", name: user.name, role: "member" });
    const otherUser = store.getOrCreateUser({ email: "other-http@example.invalid", name: "Other synthetic member" });
    const other = store.createWorkspaceMember({ userId: otherUser.id, workspaceId: "local", name: otherUser.name, role: "member" });
    const foreign = store.createWorkspace({ name: "Foreign HTTP", slug: "foreign-http" });
    const foreignUser = store.getOrCreateUser({ email: "foreign-http@example.invalid", name: "Foreign member" });
    store.createWorkspaceMember({ userId: foreignUser.id, workspaceId: foreign.id, name: foreignUser.name, role: "member" });
    const pat = await store.createAccessToken({ name: "Member fixture", type: "pat", userId: user.id, workspaceId: "local" });
    const otherPat = await store.createAccessToken({ name: "Other member fixture", type: "pat", userId: otherUser.id, workspaceId: "local" });
    const foreignPat = await store.createAccessToken({ name: "Foreign member fixture", type: "pat", userId: foreignUser.id, workspaceId: foreign.id });
    const runtime = store.registerRuntime({ name: "HTTP synthetic provider", provider: "codex", daemonId: "http-fixture-daemon", ownerId: user.id, visibility: "public", maxConcurrency: 8 });
    const owner = store.createAgent({ name: "HTTP root coordinator", provider: "codex", runtimeId: runtime.id, ownerId: user.id, visibility: "workspace", maxConcurrentTasks: 8 });
    const worker = store.createAgent({ name: "HTTP child coordinator", provider: "codex", runtimeId: runtime.id, ownerId: user.id, visibility: "workspace", maxConcurrentTasks: 8 });
    const app = createMultiremiApp({ store, authToken: "fixture-master-required" });
    globalThis.fetch = ((input, init) => app.request(new Request(input, init))) as typeof fetch;
    const client = new ApiClient("http://responsibility-http.test"); client.setToken(pat.token);
    // Creation needs no designated human.
    const root = await client.createIssue({ title: "HTTP root", assignee_type: "agent", assignee_id: owner.id });
    const child = await client.createIssue({ title: "HTTP child", parent_issue_id: root.id, assignee_type: "agent", assignee_id: worker.id });
    expect(root.workspace_id).toBe(workspace.id);
    expect(child.workspace_id).toBe(workspace.id);
    const factsResponse = await app.request(`/api/issues/${child.id}/responsibility`, { headers: { Authorization: `Bearer ${pat.token}` } });
    expect(factsResponse.status).toBe(200);
    const facts = await factsResponse.json() as Record<string, any>;
    expect(facts.executionOwner?.id).toBe(worker.id);
    expect(facts.chain.map((node: any) => node.executionOwner?.id)).toEqual([worker.id, owner.id]);
    expect(facts).not.toHaveProperty("reviewOwner"); expect(facts).not.toHaveProperty("rootHuman");
    const sourceTask = store.createTask({ agentId: worker.id, issueId: child.id, prompt: "Ask and finish" });
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
    store.updateAgent(worker.id, { visibility: "private", ownerId: "local" });
    // The asker owns the child, so the Q starts with the parent's execution owner,
    // who reads it through its routed notification lane.
    client.setToken(ownerToken.token);
    const initial = await client.getQuestion(String(request.message_id));
    expect(initial).toMatchObject({ stage: "parent_owner", current_handler: { type: "agent", id: owner.id } });
    expect(initial.original_context?.text).toBe("Original provider context");
    // At the Agent stage a member reads only through the original (here private) conversation.
    client.setToken(pat.token);
    await expect(client.getQuestion(initial.id)).rejects.toThrow();
    client.setToken(ownerToken.token);
    await expect(client.getTurn(sourceTurn.id)).rejects.toThrow();
    await expect(client.getMessage(initial.id)).rejects.toThrow();
    const escalated = await client.actOnQuestion(initial.id, "escalate", { expected_route_revision: initial.route_revision, reason: "Members decide this" });
    expect(escalated).toMatchObject({ stage: "human", current_handler: null });
    // At the human stage any active member of the workspace answers; nobody else does.
    client.setToken(sourceToken.token);
    await expect(client.actOnQuestion(initial.id, "answer", { expected_route_revision: escalated.route_revision, response: { answer: "Source" } })).rejects.toThrow();
    // A daemon credential carries no member authority either.
    const daemonToken = await store.createAccessToken({ name: "HTTP fixture daemon", type: "daemon", workspaceId: "local", userId: user.id, daemonId: "http-fixture-daemon" });
    const daemonAnswer = await app.request(`/api/messages/${initial.id}/question/answer`, { method: "POST",
      headers: { Authorization: `Bearer ${daemonToken.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expected_route_revision: escalated.route_revision, response: { answers: { "Choose approaches?": "A", "Why?": "Daemon" } } }) });
    expect(daemonAnswer.status).toBe(403);
    expect(store.getQuestion(initial.id)?.status).toBe("pending");
    client.setToken(foreignPat.token);
    await expect(client.getQuestion(initial.id)).rejects.toThrow();
    client.setToken(otherPat.token);
    expect((await client.getQuestion(initial.id)).actions.allowed).toEqual(["answer", "close"]);
    const answered = await client.actOnQuestion(initial.id, "answer", { expected_route_revision: escalated.route_revision, response: { answers: { "Choose approaches?": "A, B", "Why?": "Evidence" } } });
    expect(answered).toMatchObject({ status: "answered", answer_revision: 1, answer: { actor: { type: "member", id: other.id } } });
    expect(store.getMessage(answered.answer!.reply_message_id)?.session_id).toBe(initial.session_id);
    expect(store.getMessage(answered.answer!.reply_message_id)?.reply_to_id).toBe(initial.id);
    const consumed = store.getDaemonTurnBridge().rpc("turn.decision.consume", { turn_id: sourceTurn.id, attempt_id: sourceTask.id, message_id: initial.id, reply_message_id: answered.answer!.reply_message_id, wait_id: "http-provider-wait" }, { runtimeId: runtime.id, daemonId: "http-fixture-daemon", workspaceId: "local" });
    expect(consumed).toMatchObject({ ok: true });
    client.setToken(pat.token);
    const consumedQuestion = await client.getQuestion(initial.id);
    expect(consumedQuestion.wait_status).toBe("consumed");
    expect(consumedQuestion.recovery?.consumer_attempt_id).toBe(sourceTask.id);
    expect(consumedQuestion.recovery?.consumer_turn_id).toBe(sourceTurn.id);
    expect(consumedQuestion.recovery?.reply_message_id).toBe(answered.answer!.reply_message_id);
    // Another member may revise an answer given at the human stage.
    const revised = await client.actOnQuestion(initial.id, "answer", { expected_route_revision: answered.route_revision, expected_answer_revision: answered.answer_revision, revise: true, reason: "New evidence", response: { answers: { "Choose approaches?": "B", "Why?": "Revised evidence" } } });
    expect(revised.answer_revision).toBe(2); expect((await client.listIssueQuestions(root.id)).some(q => q.id === initial.id)).toBe(true);
    store.updateAgent(worker.id, { visibility: "workspace", ownerId: user.id });

    // The done rule: the child's own owner never closes it, its parent's owner does,
    // and only a member closes the root.
    client.setToken(sourceToken.token);
    await expect(client.patchIssue(child.id, { status: "done" })).rejects.toThrow();
    expect(store.getIssue(child.id)?.status).not.toBe("done");
    client.setToken(ownerToken.token);
    expect((await client.patchIssue(child.id, { status: "done" })).status).toBe("done");
    await expect(client.patchIssue(root.id, { status: "done" })).rejects.toThrow();
    expect(store.getIssue(root.id)?.status).not.toBe("done");
    client.setToken(pat.token);
    expect((await client.patchIssue(root.id, { status: "done" })).status).toBe("done");
    expect((await client.getIssue(root.id)).status).toBe("done");
    // Formal delivery is retired.
    const retired = await app.request(`/api/issues/${root.id}/deliveries`, { headers: { Authorization: `Bearer ${pat.token}` } });
    expect(retired.status).toBe(410);
  } finally { db.close(); }
}, 30_000);
