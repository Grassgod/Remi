import { createResponsibleTestIssue } from './helpers.js';
import { expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { RETIRED_CLI_COMMANDS } from "../../../apps/remi/cli/core/retired-commands.js";
import { createRealtimeFanout } from "../../../packages/server/src/api/realtime-fanout.js";

pendingTurnBackendTests("MUL-508 stage 1 regressions", (fixture) => {
  async function scaffold() {
    const { store, db } = fixture();
    const user = store.getOrCreateUser({ externalId: "stage1-member", name: "Member" });
    store.createWorkspaceMember({ userId: user.id, name: user.name, role: "member" });
    const agent = store.createAgent({ name: "Private", provider: "codex", visibility: "private", ownerId: "local" });
    const issue = createResponsibleTestIssue(store, { title: "Stage 1", assigneeType: "agent", assigneeId: agent.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const token = await store.createAccessToken({ type: "pat", name: "Member", userId: user.id, workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "stage1-master" });
    const headers = { Authorization: `Bearer ${token.token}` };
    const owner = { Authorization: "Bearer stage1-master" };
    const path = `/api/sessions/${session.id}/messages`;
    const request = async (url: string, method = "GET", body?: unknown, auth = headers) => {
      const response = await app.request(url, { method, headers: { "Content-Type": "application/json", ...auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() as any };
    };
    return { store, db, user, agent, issue, session, app, headers, owner, path, request };
  }
  function runningRequest(store: MultiremiStore, db: SqlDatabase, agentId: string, issueId: string, kind: "permission" | "question", payload: Record<string, unknown>) {
    const task = store.createTask({ agentId, issueId, prompt: "Work" });
    db.run("UPDATE multiremi_turns SET status='running' WHERE current_attempt_id=?", [task.id]);
    db.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?", [task.id]);
    const request = store.createTaskHumanRequest({ taskId: task.id, kind, payload });
    return { task, request, turn: store.getTurnForAttempt(task.id)! };
  }
  const permission = { options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }, { optionId: "reject_once", kind: "reject_once", name: "Reject" }] };
  const question = { questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }] };

  it("B1: rejects direct and final role private-agent dispatch, rolling back uploads and all writes", async () => {
    const f = await scaffold();
    expect((await f.request(`/api/agents/${f.agent.id}`)).status).toBe(403);
    const dir = mkdtempSync(join(tmpdir(), "mul508-denied-")), previous = process.env.MULTIREMI_UPLOAD_DIR;
    process.env.MULTIREMI_UPLOAD_DIR = dir;
    const snapshot = () => ["multiremi_conversation_log", "multiremi_turns", "multiremi_turn_attempts", "multiremi_attachments", "multiremi_conversation_heads"].map(table => Number(f.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get().n));
    const parent = createResponsibleTestIssue(f.store, { title: "Parent", assigneeType: "agent", assigneeId: f.agent.id });
    f.store.updateIssue(f.issue.id, { parentIssueId: parent.id });
    const before = snapshot();
    let enqueued = 0;
    const unsubscribe = f.store.onTaskEnqueued(() => { enqueued++; });
    try {
      for (const to of [{ type: "agent", ref: f.agent.id }, { type: "role", ref: "issue_owner" }, { type: "role", ref: "parent_owner" }]) {
        expect((await f.request(f.path, "POST", { body_md: "Forbidden work", to })).status).toBe(403);
        const form = new FormData();
        form.set("message", JSON.stringify({ body_md: "Forbidden upload", to }));
        form.append("file", new File(["private bytes"], "denied.txt"));
        expect((await f.app.request(f.path, { method: "POST", headers: f.headers, body: form })).status).toBe(403);
        expect(snapshot()).toEqual(before);
      }
      expect(enqueued).toBe(0);
      expect(readdirSync(dir, { recursive: true }).filter(p => String(p).endsWith(".txt"))).toHaveLength(0);
    } finally {
      unsubscribe();
      if (previous === undefined) delete process.env.MULTIREMI_UPLOAD_DIR; else process.env.MULTIREMI_UPLOAD_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
    expect((await f.request(f.path, "POST", { body_md: "Owner work", to: { type: "agent", ref: f.agent.id } }, f.owner)).status).toBe(200);
  });

  for (const kind of ["permission", "question"] as const) it(`B2: hides private-agent ${kind} across read protocols and refuses answers without consuming`, async () => {
    const f = await scaffold(), q = runningRequest(f.store, f.db, f.agent.id, f.issue.id, kind, kind === "permission" ? permission : question);
    expect((await f.request(`/api/agents/${f.agent.id}`)).status).toBe(403);
    expect((await f.request(`/api/turns/${q.turn.id}`)).status).toBe(404);
    expect((await f.request(`/api/messages/${q.request.id}`)).status).toBe(404);
    expect((await f.request(f.path)).data.messages).toHaveLength(1);
    const log = `/api/sessions/${f.session.id}/log`;
    expect((await f.request(`${log}/entry?id=${q.request.id}`)).status).toBe(404);
    expect((await f.request(`${log}/locate?id=${q.request.id}`)).status).toBe(404);
    const range = await f.request(`${f.path}?from=0&to=${f.store.getConversationLogHead(f.session.id)!.headSeq}`);
    expect(range.data.entries.some((e: any) => e.id === q.request.id)).toBe(false);
    expect((await f.request(log)).data.entries.some((e: any) => e.id === q.request.id)).toBe(false);
    // Include the pending question in this member's inbox to exercise counts.
    const member = f.store.getWorkspaceMemberByRef(f.user.id, "local")!;
    f.db.run("UPDATE multiremi_conversation_log SET to_member_id=? WHERE id=?", [member.id, q.request.id]);
    const inbox = await f.request("/api/inbox");
    expect(inbox.data.items).toEqual([]); expect(inbox.data.unread_count).toBe(0); expect(inbox.data.attention_count).toBe(0);
    const before = f.store.getConversationLogHead(f.session.id)!.headSeq;
    expect((await f.request(f.path, "POST", { reply_to_id: q.request.id, body_md: "allow", response: { allow: true } })).status).toBe(404);
    expect(f.store.getTaskHumanRequest(q.request.id)?.status).toBe("pending");
    expect(f.store.getTurn(q.turn.id)?.status).toBe("awaiting_human");
    expect(f.store.getConversationLogHead(f.session.id)?.headSeq).toBe(before);
    expect((await f.request(f.path, "POST", { reply_to_id: q.request.id, response: kind === "permission" ? { option_id: "allow_once" } : { answers: { "Continue?": "Yes" } } }, f.owner)).status).toBe(200);
    expect((await f.request(f.path)).data.messages.some((m: any) => m.reply_to_id === q.request.id)).toBe(false);
  });

  it("B2: keeps shared-agent questions answerable by an authorized member other than the recipient", async () => {
    const f = await scaffold(); f.store.updateAgent(f.agent.id, { visibility: "workspace" });
    const q = runningRequest(f.store, f.db, f.agent.id, f.issue.id, "question", question);
    expect((await f.request(`/api/messages/${q.request.id}`)).status).toBe(200);
    expect((await f.request(f.path, "POST", { reply_to_id: q.request.id, metadata: { selected_options: ["Yes"] } })).status).toBe(200);
    expect(f.store.getTaskHumanRequest(q.request.id)?.response).toMatchObject({ answers: { "Continue?": "Yes" } });
  });

  it("B3: accepts only the exact current Chat task capability throughout message, range, inbox and turn", async () => {
    const f = await scaffold(); f.store.updateAgent(f.agent.id, { visibility: "workspace" });
    const chat = f.store.createChatSession({ agentId: f.agent.id, creatorId: f.user.id });
    const sent = f.store.sendMessage({ session_id: chat.id, sender: { type: "member", id: "mem_local_local" }, to: { type: "agent", ref: f.agent.id }, message_kind: "request", body_md: "Chat work", wake_requested: "now" });
    const turn = f.store.getTurn(sent.turn_id!)!;
    f.db.run("UPDATE multiremi_turns SET status='running' WHERE id=?", [turn.id]);
    f.db.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?", [turn.current_attempt_id!]);
    const token = await f.store.createAccessToken({ type: "task", name: "Shared runtime task", taskId: turn.current_attempt_id!, agentId: f.agent.id, userId: "local", workspaceId: "local" });
    const auth = { Authorization: `Bearer ${token.token}` }, path = `/api/sessions/${chat.id}/messages`;
    expect((await f.request(path, "GET", undefined, auth)).status).toBe(200);
    expect((await f.request(`/api/messages/${sent.message.id}`, "GET", undefined, auth)).status).toBe(200);
    expect((await f.request(`${path}?from=0&to=${sent.message.seq}`, "GET", undefined, auth)).status).toBe(200);
    expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id).seq).toBe(sent.message.seq);
    expect((await f.request(path, "POST", { body_md: "Agent reply" }, auth)).status).toBe(200);
    const unseen = f.store.sendMessage({ session_id: chat.id, sender: { type: "member", id: "mem_local_local" }, to: { type: "agent", ref: f.agent.id }, message_kind: "request", body_md: "Unread", wake_requested: "inbox_only" }).message;
    expect((await f.request("/api/inbox", "GET", undefined, auth)).data.items.map((m: any) => m.id)).toContain(unseen.id);
    expect((await f.request("/api/inbox/read", "POST", { session_id: chat.id }, auth)).status).toBe(200);
    expect((await f.request("/api/inbox/read", "POST", { all: true }, auth)).status).toBe(200);
    expect((await f.request(`/api/turns/${turn.id}?input=true&attempts=true`, "GET", undefined, auth)).status).toBe(200);
    expect((await f.request(`/api/turns/${turn.id}/trace`, "GET", undefined, auth)).status).toBe(200);
    expect((await f.request(`/api/turns/${turn.id}/wrap-up`, "POST", {}, auth)).status).toBe(200);
    expect((await f.request(`/api/turns?chat=${chat.id}`, "GET", undefined, auth)).data.turns.map((t: any) => t.id)).toContain(turn.id);
    const otherChat = f.store.createChatSession({ agentId: f.agent.id, creatorId: "local" });
    const other = f.store.sendMessage({ session_id: otherChat.id, sender: { type: "member", id: "mem_local_local" }, to: { type: "agent", ref: f.agent.id }, message_kind: "request", body_md: "Other Chat", wake_requested: "now" });
    expect((await f.request(`/api/sessions/${otherChat.id}/messages`, "GET", undefined, auth)).status).toBe(403);
    expect((await f.request(`/api/sessions/${otherChat.id}/messages`, "POST", { body_md: "Forbidden" }, auth)).status).toBe(403);
    expect((await f.request(`/api/sessions/${otherChat.id}/messages?from=0&to=1`, "GET", undefined, auth)).status).toBe(403);
    expect((await f.request(`/api/turns/${other.turn_id}`, "GET", undefined, auth)).status).toBe(403);
    expect((await f.request(`/api/turns/${other.turn_id}/cancel`, "POST", {}, auth)).status).toBe(403);
    const otherUser = await f.store.createAccessToken({ type: "pat", name: "Unrelated user", userId: "local", workspaceId: "local" });
    expect((await f.request(path, "GET", undefined, { Authorization: `Bearer ${otherUser.token}` })).status).toBe(403);
    expect((await f.request("/api/inbox", "GET", undefined, auth)).data.items.every((m: any) => m.session_id !== otherChat.id)).toBe(true);
    const unrelated = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: "Unrelated" });
    const unrelatedToken = await f.store.createAccessToken({ type: "task", name: "Unrelated task", taskId: unrelated.id, agentId: f.agent.id, userId: f.user.id, workspaceId: "local" });
    expect((await f.request(path, "GET", undefined, { Authorization: `Bearer ${unrelatedToken.token}` })).status).toBe(403);
    expect((await f.request(`/api/turns/${turn.id}/cancel`, "POST", {}, auth)).status).toBe(200);
    f.store.retryTurn(turn.id, true);
    expect((await f.request(path, "GET", undefined, auth)).status).not.toBe(200);
  });

  async function cli(app: ReturnType<typeof createMultiremiApp>, auth: string, args: string[]) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      const child = Bun.spawn([process.execPath, "apps/remi/main.ts", ...args, "--output", "json"], {
        cwd: process.cwd(), env: { ...process.env, MULTIREMI_SERVER_URL: `http://127.0.0.1:${server.port}`, MULTIREMI_TOKEN: auth, MULTIREMI_WORKSPACE_ID: "local" }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    } finally { server.stop(true); }
  }
  for (const kind of ["permission", "question"] as const) it(`B4: real CLI ${kind} option is normalized; invalid responses preserve pending state`, async () => {
    const f = await scaffold(), q = runningRequest(f.store, f.db, f.agent.id, f.issue.id, kind, kind === "permission" ? permission : question);
    const before = f.store.getConversationLogHead(f.session.id)!.headSeq;
    expect((await f.request(f.path, "POST", { response: { option_id: "allow_once" } }, f.owner)).status).toBe(400);
    expect((await f.request(f.path, "POST", { reply_to_id: q.request.id, message_kind: "request", response: { option_id: "allow_once" } }, f.owner)).status).toBe(400);
    expect(f.store.getTaskHumanRequest(q.request.id)?.status).toBe("pending"); expect(f.store.getTurn(q.turn.id)?.status).toBe("awaiting_human");
    expect(f.store.getConversationLogHead(f.session.id)?.headSeq).toBe(before);
    for (const args of [["--option", "unknown"], ["--response", kind === "permission" ? '{"option_id":"unknown"}' : '{"answers":{"Other":"Yes"}}'], ["--response", '{"answers":[]}']]) {
      const result = await cli(f.app, "stage1-master", ["message", "send", f.session.id, "--reply-to", q.request.id, ...args]);
      expect(result.code).not.toBe(0);
      expect(f.store.getTaskHumanRequest(q.request.id)?.status).toBe("pending");
      expect(f.store.getTurn(q.turn.id)?.status).toBe("awaiting_human");
      expect(f.store.getConversationLogHead(f.session.id)?.headSeq).toBe(before);
    }
    const result = await cli(f.app, "stage1-master", ["message", "send", f.session.id, "--reply-to", q.request.id, "--option", kind === "permission" ? "allow_once" : "Yes"]);
    expect(result.code, result.stderr).toBe(0);
    const delivered = JSON.parse(result.stdout).message;
    expect(delivered.reply_to_id).toBe(q.request.id);
    expect(delivered.metadata.human_response).toMatchObject(kind === "permission" ? { option_id: "allow_once" } : { answers: { "Continue?": "Yes" } });
    const settled = f.store.getTaskHumanRequest(q.request.id)!;
    expect(settled.status).toBe("responded"); expect(f.store.getTurn(q.turn.id)?.status).toBe("running");
    expect(settled.response).toMatchObject(kind === "permission" ? { option_id: "allow_once" } : { answers: { "Continue?": "Yes" } });
    expect((await cli(f.app, "stage1-master", ["message", "send", f.session.id, "--reply-to", q.request.id, "--option", "Yes"])).code).not.toBe(0);
    expect(f.store.listMessages(f.session.id).filter(m => m.reply_to_id === q.request.id)).toHaveLength(1);
  });

  it("B4: multi-question CLI response requires complete answers before consuming", async () => {
    const f = await scaffold(), q = runningRequest(f.store, f.db, f.agent.id, f.issue.id, "question", { questions: [{ question: "First?" }, { question: "Second?" }] });
    for (const args of [["--option", "Yes"], ["--response", '{"answers":{"First?":"Yes"}}']]) {
      expect((await cli(f.app, "stage1-master", ["message", "send", f.session.id, "--reply-to", q.request.id, ...args])).code).not.toBe(0);
      expect(f.store.getTaskHumanRequest(q.request.id)?.status).toBe("pending");
      expect(f.store.getTurn(q.turn.id)?.status).toBe("awaiting_human");
    }
    const response = { answers: { "First?": "Yes", "Second?": "Some free text" } };
    expect((await cli(f.app, "stage1-master", ["message", "send", f.session.id, "--reply-to", q.request.id, "--response", JSON.stringify(response)])).code).toBe(0);
    expect(f.store.getTaskHumanRequest(q.request.id)?.response).toEqual(response);
  });

  it("S5: preserves head, turn card, location and message sidecars without advancing read cursors", async () => {
    const f = await scaffold();
    const sent = await f.request(f.path, "POST", { body_md: "Display", to: { type: "agent", ref: f.agent.id } }, f.owner);
    const turn = f.store.getTurn(sent.data.turn_id)!;
    await f.request(`/api/messages/${sent.data.message.id}/reactions`, "POST", { emoji: "+1" }, f.owner);
    const attachment = f.store.createAttachment({ issueId: f.issue.id, workspaceId: "local", filename: "display.txt", url: "/api/attachments/display/file", contentType: "text/plain", sizeBytes: 12 });
    f.store.linkAttachmentsToComment(sent.data.message.id, f.issue.id, [attachment.id]);
    f.store.appendIssueActivity(f.issue.id, { actorType: "member", actorId: "local", type: "stage1_display", body: "Display sidecar" });
    const log = `/api/sessions/${f.session.id}/log`;
    const window = await f.request(log, "GET", undefined, f.owner);
    expect(window.status).toBe(200); expect(window.data.head_seq).toBeGreaterThan(0); expect(window.data.log_version).toBeGreaterThan(0);
    expect(window.data.entries.some((e: any) => e.kind === "head")).toBe(true);
    expect(window.data.entries.find((e: any) => e.id === turn.id)?.metadata.status).toBe("queued");
    expect(window.data.entries.find((e: any) => e.id === sent.data.message.id)?.metadata.reactions).toHaveLength(1);
    expect(window.data.entries.find((e: any) => e.id === sent.data.message.id)?.metadata.attachments).toMatchObject([{ id: attachment.id }]);
    const detail = await f.request(`/api/multiremi/issues/${f.issue.id}`, "GET", undefined, f.owner);
    expect(detail.status).toBe(200); expect(detail.data.activity.some((a: any) => a.type === "stage1_display")).toBe(true);
    const location = await f.request(`${log}/locate?id=${turn.id}`, "GET", undefined, f.owner);
    expect(location.status).toBe(200); expect(location.data.head_seq).toBe(window.data.head_seq);
    const expanded = await f.request(`${log}/entry?seq=${location.data.seq}`, "GET", undefined, f.owner);
    expect(expanded.status).toBe(200); expect(expanded.data.id).toBe(turn.id); expect(expanded.data.metadata.status).toBe("queued");
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id).seq).toBe(0);
    expect((await f.request(`${log}/entry?seq=-1`, "GET", undefined, f.owner)).status).toBe(400);
  });

  it("B5: all display log GETs reject from/to, including empty parameters, with the same message", async () => {
    const f = await scaffold();
    const sent = await f.request(f.path, "POST", { body_md: "Display range rejection" }, f.owner);
    const log = `/api/sessions/${f.session.id}/log`;
    for (const route of [log, `${log}/locate?id=${sent.data.message.id}`, `${log}/entry?id=${sent.data.message.id}`]) {
      for (const range of ["from=0", "to=2", "from=0&to=2", "from=", "to="]) {
        const result = await f.request(`${route}${route.includes("?") ? "&" : "?"}${range}`, "GET", undefined, f.owner);
        expect(result.status).toBe(400);
        expect(result.data).toEqual({ error: "log is display-only; use remi message list <conversation> --from <seq> --to <seq>" });
      }
    }
  });

  it("S5: sends committed workspace inbox invalidations to both tabs, isolating rollback and other workspaces", async () => {
    const f = await scaffold();
    const second = createResponsibleTestIssue(f.store, { title: "Other conversation" }), session = f.store.getOrCreateDefaultIssueSession(second.id);
    const frames: any[][] = [[], [], []], events: any[] = [], transactionStates: boolean[] = [];
    const client = (i: number, workspaceId: string) => ({ data: { kind: "browser", workspaceId, authenticated: true, userId: "local", accessToken: null }, sendText: (frame: string) => frames[i]!.push(JSON.parse(frame)), close() {} });
    const fanout = createRealtimeFanout({ role: "all", store: f.store, registries: { browser: new Map([["local", new Set([client(0, "local"), client(1, "local")])], ["other-workspace", new Set([client(2, "other-workspace")])]]) as any, browserUser: new Map() } });
    const unsubscribe = f.store.onWorkspaceEvent(event => {
      if (!event.type.startsWith("inbox:")) return;
      events.push(event); transactionStates.push(f.db.inTransaction === true);
    });
    const send = (sessionId: string, to: "member" | "agent" = "member", dedupe_key?: string) => f.store.sendMessage({ session_id: sessionId, sender: { type: "platform", id: null }, to: { type: to, ref: to === "member" ? "mem_local_local" : f.agent.id }, message_kind: "request", body_md: "Private inbox content", wake_requested: "now", dedupe_key });
    try {
      expect(() => fixture().transaction(() => { send(f.session.id); expect(events).toEqual([]); throw new Error("rollback send"); })).toThrow("rollback send");
      expect(frames[0]).toEqual([]);
      fixture().transaction(() => { send(f.session.id, "member", "index-once"); send(session.id); expect(events).toEqual([]); });
      expect(events.map(e => e.type)).toEqual(["inbox:new", "inbox:new"]);
      send(f.session.id, "member", "index-once"); expect(events).toHaveLength(2);
      expect((await f.request("/api/inbox", "GET", undefined, f.owner)).data.unread_count).toBe(2);
      expect(() => fixture().transaction(() => { f.store.readMessageInbox("mem_local_local", f.session.id); expect(events).toHaveLength(2); throw new Error("rollback read"); })).toThrow("rollback read");
      expect(events).toHaveLength(2);
      expect((await f.request("/api/inbox", "GET", undefined, f.owner)).data.unread_count).toBe(2);
      fixture().transaction(() => { f.store.readMessageInbox("mem_local_local", f.session.id); expect(events).toHaveLength(2); });
      expect(events.at(-1).type).toBe("inbox:read");
      expect((await f.request("/api/inbox", "GET", undefined, f.owner)).data.unread_count).toBe(1);
      expect(() => fixture().transaction(() => { f.store.readAllMessageInbox("mem_local_local", "local"); throw new Error("rollback all"); })).toThrow("rollback all");
      expect(events).toHaveLength(3);
      fixture().transaction(() => { f.store.readAllMessageInbox("mem_local_local", "local"); expect(events).toHaveLength(3); });
      expect(events.at(-1).type).toBe("inbox:batch-read");
      expect((await f.request("/api/inbox", "GET", undefined, f.owner)).data.unread_count).toBe(0);
      send(f.session.id, "agent");
      f.store.readAgentMessageInbox(f.agent.id, "local", f.session.id);
      expect(events.at(-1).type).toBe("inbox:read");
      f.store.readAgentMessageInbox(f.agent.id, "local");
      expect(events.at(-1).type).toBe("inbox:batch-read");
      expect(frames[0]).toEqual(frames[1]); expect(frames[2]).toEqual([]);
      const inboxFrames = frames[0]!.filter(frame => frame.type.startsWith("inbox:"));
      expect(inboxFrames).toHaveLength(events.length);
      expect(frames[0]!.filter(frame => frame.type === "task:queued")).toHaveLength(1);
      expect(transactionStates.every(state => !state)).toBe(true);
      for (const frame of inboxFrames) expect(frame).toEqual({ type: expect.stringMatching(/^inbox:/), payload: { index_only: true }, actor_id: null, actor_type: "system" });
    } finally { unsubscribe(); fanout.close(); }
  });

  it("S5: returns canonical turn_id with current and historical AgentTask attempts for trace routing", async () => {
    const f = await scaffold();
    const task = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: "Snapshot trace" });
    const turn = f.store.getTurnForAttempt(task.id)!;
    f.store.cancelTurn(turn.id); const replacement = f.store.retryTurn(turn.id, true);
    for (const path of [`/api/agents/${f.agent.id}/tasks`, `/api/multiremi/agents/${f.agent.id}/tasks`]) {
      const result = await f.request(path, "GET", undefined, f.owner);
      expect(result.status).toBe(200);
      const tasks = Array.isArray(result.data) ? result.data : result.data.tasks;
      for (const id of [task.id, replacement.current_attempt_id]) expect(tasks.find((t: any) => t.id === id)?.turn_id).toBe(turn.id);
    }
    for (const path of ["/api/agent-task-snapshot", "/api/multiremi/agent-task-snapshot"]) {
      const result = await f.request(path, "GET", undefined, f.owner);
      expect(result.status).toBe(200);
      const tasks = Array.isArray(result.data) ? result.data : result.data.tasks;
      const current = tasks.find((t: any) => t.id === replacement.current_attempt_id);
      expect(current.turn_id).toBe(turn.id); expect(current.turn_id).not.toBe(current.id);
      const trace = await f.request(`/api/turns/${current.turn_id}/trace?attempt_id=${task.id}`, "GET", undefined, f.owner);
      expect(trace.status).toBe(200); expect(trace.data.attempt_id).toBe(task.id); expect(trace.data.turn_id).toBe(turn.id);
    }
  });

  it("S1: retired rerun advertises a runnable conversation send with content", async () => {
    const f = await scaffold();
    const command = RETIRED_CLI_COMMANDS["issue rerun"]!.replace("remi ", "").replace("<conversation>", f.session.id).replace("<prompt>", "Rerun");
    expect(command).not.toContain("<issue>");
    const result = await cli(f.app, "stage1-master", command.split(" "));
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).message.to_agent_id).toBe(f.agent.id);
  });

  it("S3: batches complete turn input and bounds inbox page hydration independently of counts", async () => {
    const f = await scaffold(), first = f.store.sendMessage({ session_id: f.session.id, sender: { type: "member", id: "mem_local_local" }, to: { type: "agent", ref: f.agent.id }, message_kind: "request", body_md: "First", wake_requested: "now" });
    const head = f.store.getConversationLogHead(f.session.id)!.headSeq;
    const source = f.db.query("SELECT * FROM multiremi_conversation_log WHERE id=?").get(first.message.id);
    const keys = Object.keys(source), insert = f.db.query(`INSERT INTO multiremi_conversation_log(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`);
    f.db.transaction(() => {
      for (let i = 1; i <= 1005; i++) insert.run(...keys.map(k => k === "id" ? `stage1_bulk_${i}` : k === "seq" ? head + i : k === "body_md" ? `Body ${i}` : k === "to_member_id" ? "mem_local_local" : source[k]));
      f.db.run("UPDATE multiremi_conversation_heads SET head_seq=? WHERE session_id=?", [head + 1005, f.session.id]);
      f.db.run("UPDATE multiremi_turns SET input_from_seq=0,input_to_seq=? WHERE id=?", [head + 1005, first.turn_id!]);
    })();
    const originalQuery = f.db.query.bind(f.db); let queries = 0, maxPageRows = 0;
    f.db.query = sql => {
      const statement = originalQuery(sql);
      return { ...statement, get: (...p) => { queries++; return statement.get(...p); }, all: (...p) => {
        queries++; const rows = statement.all(...p);
        if (sql.startsWith("SELECT m.* FROM multiremi_conversation_log m\n")) maxPageRows = Math.max(maxPageRows, rows.length);
        return rows;
      }, run: (...p) => { queries++; return statement.run(...p); }, values: (...p) => { queries++; return statement.values(...p); } };
    };
    try {
      const result = await f.request(`/api/turns/${first.turn_id}?input=true`, "GET", undefined, f.owner);
      expect(result.status).toBe(200); expect(result.data.input.messages).toHaveLength(1006);
      expect(result.data.input.messages.at(-1).body_md).toBe("Body 1005"); expect(queries).toBeLessThan(100);
      const inputQueries = queries;
      queries = 0;
      const inbox = await f.request("/api/inbox?limit=1", "GET", undefined, f.owner);
      expect(inbox.data.items).toHaveLength(1); expect(inbox.data.unread_count).toBe(1005); expect(inbox.data.attention_count).toBe(1005);
      expect(inbox.data.next_cursor).toBeTruthy(); expect(maxPageRows).toBeLessThanOrEqual(2); expect(queries).toBeLessThan(50);
      console.log(JSON.stringify({ stage1_batch_read: f.db.dialect, input_messages: 1006, input_queries: inputQueries, inbox_queries: queries, inbox_page_rows: maxPageRows }));
      const next = await f.request(`/api/inbox?limit=1&cursor=${inbox.data.next_cursor}`, "GET", undefined, f.owner);
      expect(next.data.items[0].id).not.toBe(inbox.data.items[0].id); expect(next.data.unread_count).toBe(1005);
    } finally { f.db.query = originalQuery; }
  });
});
