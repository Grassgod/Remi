import { requestMessageBody, sentTask } from "./unified-test-paths.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createMultiremiApp } from "@multiremi/api.js";
import { CONVERSATION_LOG_HIDDEN_KINDS, CONVERSATION_LOG_SHOWN_KINDS } from "@multiremi/contracts/conversation-log.js";
import type { EnvelopeAddress } from "@multiremi/contracts/inbox.js";
import type { MultiremiSessionEvent } from "@multiremi/contracts/types.js";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore as createStore, resetMultiremiTestEnv } from "./helpers.js";

const plan = readFileSync(new URL("../../fixtures/multiremi/mul404-plan.md", import.meta.url), "utf8").trimEnd();

async function verifyPlanRoundTrip(store: MultiremiStore): Promise<void> {
  const issue = store.createIssue({ title: "MUL-485 fixture", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const comment = store.createIssueComment(issue.id, { issueSessionId: session.id, body: plan });
  const entry = store.getConversationLogEntryById(comment.id)!;
  const event: MultiremiSessionEvent = {
    id: entry.id, sessionId: session.id, seq: entry.seq, kind: entry.kind,
    authorType: "member", authorId: "local", body: entry.body_md,
    taskId: null, sourceCommentId: comment.id, metadata: entry.metadata,
    createdAt: entry.created_at,
  };
  const projection = buildSessionProjection({
    sessionId: session.id, targetAgentId: "agt_reader", events: [event], cursorSeq: 0,
    providerSessionId: null, tokenBudget: 20_000,
  });
  const [header, toc, folded] = projection.jsonl.split("\n").map((line) => JSON.parse(line));
  expect(header.type).toBe("session_projection");
  expect(toc.entries[0]).toMatchObject({ seq: entry.seq, id: entry.id, chars: plan.length, folded: true });
  expect(folded.body_folded).toBe(true);
  expect(folded.body_summary).toContain(plan.slice(0, 600));
  expect(folded.body_summary).toContain("## 0. 结论");
  expect(folded.body_omitted_chars).toBe(plan.length - 600);
  expect(folded.expand).toBe(`remi message get ${entry.id}`);
  expect(folded.body).toBeUndefined();

  const app = createMultiremiApp({ store });
  for (const locator of [`seq=${entry.seq}`, `id=${entry.id}`]) {
    const response = await app.request(`/api/sessions/${session.id}/log/entry?${locator}`);
    expect(response.status).toBe(200);
    const complete = await response.json();
    expect(complete.body_md).toBe(plan);
    expect(complete.body_md.length).toBe(plan.length);
    expect(complete.metadata).toEqual(entry.metadata);
    expect(complete.delivered).toBeNull();
  }
  for (const query of ["", "?seq=-1", "?seq=1.5", `?seq=${entry.seq}&id=${entry.id}`]) {
    expect((await app.request(`/api/sessions/${session.id}/log/entry${query}`)).status).toBe(400);
  }
  expect((await app.request(`/api/sessions/${session.id}/log/entry?id=missing`)).status).toBe(404);
  expect((await app.request(`/api/sessions/ises_other/log/entry?seq=${entry.seq}`)).status).not.toBe(200);
}

async function verifyLegacyDeliveryUnknown(store: MultiremiStore): Promise<void> {
  const issue = store.createIssue({ title: "Legacy delivery", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const entry = store.appendConversationLog({ sessionId: session.id, kind: "message",
    authorType: "member", authorId: "local", bodyMd: "Before envelopes" });
  const app = createMultiremiApp({ store });
  for (const locator of [`seq=${entry.seq}`, `id=${entry.id}`]) {
    const response = await app.request(`/api/sessions/${session.id}/log/entry?${locator}`);
    expect(response.status).toBe(200);
    expect((await response.json()).delivered).toBeNull();
  }
}

async function verifyLegacyReportStaysWhole(store: MultiremiStore): Promise<void> {
  const agent = store.createAgent({ name: "Legacy report reader", provider: "codex", visibility: "workspace" });
  const issue = store.createIssue({ title: "Long legacy report", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const body = "R".repeat(4_001);
  const report = store.appendSessionEvent(session.id, { kind: "delegation_report", authorType: "system", body });
  const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Read report" });
  const projection = store.buildTaskSessionProjection(task.id)!;
  const lines = projection.jsonl.split("\n").map((line) => JSON.parse(line));
  const rendered = lines.find((line) => line.type === "session_event" && line.seq === report.seq);
  expect(rendered.body_folded).toBe(true);
  expect(rendered.expand).toBe(`remi message get ${report.id}`);
  const app=createMultiremiApp({store});
  expect((await (await app.request(`/api/messages/${report.id}`)).json()).message.body_md).toBe(body);
  expect(lines[1].entries.find((entry: { seq: number }) => entry.seq === report.seq).folded).toBe(true);
}

async function verifyEveryFoldedEntryExpands(store: MultiremiStore): Promise<void> {
  const agent = store.createAgent({ name: "Expansion invariant reader", provider: "codex", visibility: "workspace" });
  const issue = store.createIssue({ title: "Expansion invariant", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const expected = new Map<number, { id: string; body: string; expandable: boolean }>();
  for (const kind of CONVERSATION_LOG_SHOWN_KINDS) {
    if (kind === "head" || kind === "turn") continue;
    const body = `${kind}:${"x".repeat(4_001)}`;
    const entry = store.appendConversationLog({ sessionId: session.id, kind, authorType: "system", bodyMd: body });
    expected.set(entry.seq, { id: entry.id, body, expandable: true });
  }
  for (const kind of CONVERSATION_LOG_HIDDEN_KINDS) {
    const body = `${kind}:${"x".repeat(4_001)}`;
    const entry = store.appendConversationLog({ sessionId: session.id, kind, authorType: "system", bodyMd: body,visibility:"hidden" });
    expected.set(entry.seq, { id: entry.id, body, expandable: false });
  }
  const reportBody = "D".repeat(4_001);
  const report = store.appendSessionEvent(session.id, { kind: "delegation_report", authorType: "system", body: reportBody });
  expected.set(report.seq, { id: report.id, body: reportBody, expandable: true });
  const editedBody = "E".repeat(4_001);
  const edited = store.createIssueComment(issue.id, { issueSessionId: session.id, body: editedBody });
  const editedEntry = store.getConversationLogEntryById(edited.id)!;
  store.updateIssueComment(edited.id, { body: "Edited" });
  expected.set(editedEntry.seq, { id: edited.id, body: editedBody, expandable: false });
  // #9: provider replay retains the immutable original plus the edit marker.
  expect(store.getMessage(edited.id)?.body_md).toBe("Edited");
  const deletedBody = "X".repeat(4_001);
  const deleted = store.createIssueComment(issue.id, { issueSessionId: session.id, body: deletedBody });
  const deletedEntry = store.getConversationLogEntryById(deleted.id)!;
  store.deleteIssueComment(deleted.id);
  // #9: deleted messages leave hidden audit markers, not a visible body.
  expect(store.getMessage(deleted.id)?.deleted_at).not.toBeNull();

  const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Read every kind" });
  const projection = store.buildTaskSessionProjection(task.id)!;
  expect(projection.omittedEvents).toBe(0);
  const lines = projection.jsonl.split("\n").map((line) => JSON.parse(line));
  const toc = lines[1].entries as Array<{ seq: number; folded: boolean }>;
  const rendered = lines.filter((line) => line.type === "session_event");
  const app = createMultiremiApp({ store });
  let foldedCount = 0;
  for (const [seq, entry] of expected) {
    const line = rendered.find((candidate) => candidate.seq === seq);
    expect(line,JSON.stringify({seq,entry,rendered:rendered.map(row=>({seq:row.seq,kind:row.kind}))})).toBeDefined();
    expect(toc.find((candidate) => candidate.seq === seq)?.folded, JSON.stringify({seq,id:entry.id,visibility:store.getMessage(entry.id)?.visibility,body:entry.body.slice(0,50),expandable:entry.expandable})).toBe(entry.expandable);
    if (!entry.expandable) {
      expect(line.body).toBe(entry.body);
      expect(line.body_folded).toBeUndefined();
      expect(line.expand).toBeUndefined();
      continue;
    }
    foldedCount += 1;
    expect(line.body_folded).toBe(true);
    expect(line.expand).toBe(`remi message get ${entry.id}`);
    expect(line.body).toBeUndefined();
    for (const locator of [`seq=${seq}`, `id=${entry.id}`]) {
      const response = await app.request(`/api/sessions/${session.id}/log/entry?${locator}`);
      expect(response.status).toBe(200);
      expect((await response.json()).body_md).toBe(entry.body);
    }
  }
  expect(foldedCount).toBe(CONVERSATION_LOG_SHOWN_KINDS.length-1);
  expect(rendered.filter((line) => line.body_folded).length).toBe(foldedCount);
}

async function verifyDeliveryReceipt(store: MultiremiStore): Promise<void> {
  const agent = store.createAgent({ name: "MUL485 recipient", provider: "codex", visibility: "workspace" });
  const issue = store.createIssue({ title: "Receipt", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const comment = store.createIssueComment(issue.id, { issueSessionId: session.id, body: "Decide" });
  const entry = store.getConversationLogEntryById(comment.id)!;
  (store as any).db.run("UPDATE multiremi_conversation_log SET to_type='agent',to_ref=?,to_agent_id=?,message_kind='decision' WHERE id=?",[agent.id,agent.id,entry.id]);
  const app = createMultiremiApp({ store });
  const path = `/api/sessions/${session.id}/log/entry?seq=${entry.seq}`;
  expect((await (await app.request(path)).json()).delivered).toBe(false);
  const receiptagent = store.createSessionTask(session.id,{agentId:agent.id,prompt:"Receipt reader"});
  (store as any).db.transaction(()=>store.recordTurnInboxDeliveryWithinTransaction(receiptagent.id,0,entry.seq))();
  expect((await (await app.request(path)).json()).delivered).toBe(true);
}

async function verifySymbolicRecipientDelivery(
  store: MultiremiStore,
  role: "issue_owner" | "parent_owner" | "delegator",
): Promise<void> {
  const recipient = store.createAgent({ name: "Symbolic recipient", provider: "codex", visibility: "workspace" });
  const other = store.createAgent({ name: "Other recipient", provider: "codex", visibility: "workspace" });
  const issue = store.createIssue({ title: "Symbolic report", workspaceId: "local", status: "in_progress",
    assigneeType: "agent", assigneeId: recipient.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  let to: EnvelopeAddress = { role: "issue_owner", issueId: issue.id };
  let source: { taskId?: string } = {};
  if (role !== "issue_owner") {
    const child = store.createIssue({ title: "Report source", workspaceId: "local", parentIssueId: issue.id });
    if (role === "parent_owner") {
      to = { role: "parent_owner", childIssueId: child.id };
    } else {
      const worker = store.createAgent({ name: "Delegated worker", provider: "codex", visibility: "workspace" });
      const parentTask = store.createTask({ agentId: recipient.id, issueId: issue.id,
        issueSessionId: session.id, prompt: "Original turn" });
      const delegated = store.createTask({ agentId: worker.id, issueId: child.id,
        prompt: "Delegated turn", parentTaskId: parentTask.id, delegationId: "mul485_return",
        delegatedByAgentId: recipient.id, delegatedFromIssueSessionId: session.id });
      to = { role: "delegator", delegationId: "mul485_return" };
      source = { taskId: delegated.id };
    }
  }
  const body = `# Completed report\n${"R".repeat(4_001)}`;
  const [delivery] = (store as any).db.transaction(() => store.sendEnvelopeWithinTransaction({
    to, kind: "report", outcome: "done", wake: "next_turn", body, source,
  }, [], createCommitEventQueue()))();
  const entry = delivery.entry;
  expect(delivery.recipient.agentId).toBe(recipient.id);
  expect(entry.metadata.address_context).toEqual(to);
  expect(store.getMessage(entry.id)?.to_agent_id).toBe(recipient.id);

  const event: MultiremiSessionEvent = {
    id: entry.id, sessionId: session.id, seq: entry.seq, kind: entry.kind,
    authorType: "system", authorId: null, body: entry.body_md, taskId: null,
    sourceCommentId: entry.id, metadata: entry.metadata, createdAt: entry.created_at,
  };
  const projection = buildSessionProjection({ sessionId: session.id, targetAgentId: recipient.id,
    events: [event], cursorSeq: 0, providerSessionId: null, tokenBudget: 20_000 });
  const lines = projection.jsonl.split("\n").map((line) => JSON.parse(line));
  expect(lines[1].entries[0]).toMatchObject({ id: entry.id, priority: 3, folded: true });
  expect(lines[2]).toMatchObject({ body_folded: true, expand: `remi message get ${entry.id}` });

  const app = createMultiremiApp({ store });
  const assertDelivered = async (expected: boolean) => {
    for (const locator of [`seq=${entry.seq}`, `id=${entry.id}`]) {
      const response = await app.request(`/api/sessions/${session.id}/log/entry?${locator}`);
      expect(response.status).toBe(200);
      const expanded = await response.json();
      expect(expanded.body_md).toBe(body);
      expect(expanded.delivered).toBe(expected);
    }
  };
  await assertDelivered(false);
  if (role === "issue_owner") {
    store.updateIssue(issue.id, { assigneeType: "agent", assigneeId: other.id });
    expect(store.getIssue(issue.id)?.assigneeId).toBe(other.id);
    await assertDelivered(false);
  }
  const receiptother = store.createSessionTask(session.id,{agentId:other.id,prompt:"Receipt reader"});
  (store as any).db.transaction(()=>store.recordTurnInboxDeliveryWithinTransaction(receiptother.id,0,entry.seq))();
  await assertDelivered(false);
  const receiptrecipient = store.createSessionTask(session.id,{agentId:recipient.id,prompt:"Receipt reader"});
  (store as any).db.transaction(()=>store.recordTurnInboxDeliveryWithinTransaction(receiptrecipient.id,0,entry.seq))();
  await assertDelivered(true);
}

async function verifyCursorDeliveryAcrossScopes(
  store: MultiremiStore,
  lanes: Array<{ scope: string; cursor: number }>,
  delivered: boolean,
): Promise<void> {
  const agent = store.createAgent({ name: "Scoped receipt agent", provider: "codex", visibility: "workspace" });
  const issue = store.createIssue({ title: "Scoped receipt", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const comment = store.createIssueComment(issue.id, { issueSessionId: session.id, body: "Read this" });
  const entry = store.getConversationLogEntryById(comment.id)!;
  expect(entry.seq).toBe(1);
  (store as any).db.run("UPDATE multiremi_conversation_log SET to_type='agent',to_ref=?,to_agent_id=?,message_kind='decision' WHERE id=?",[agent.id,agent.id,entry.id]);
  for (const { scope, cursor } of lanes) {
    store.getOrCreateSessionAgentLane(session.id, agent.id, scope);
    (store as any).db.run(
      "UPDATE multiremi_session_lanes SET cursor_seq = ? WHERE session_id = ? AND reader_type='agent' AND reader_id = ? AND execution_scope = ?",
      [cursor, session.id, agent.id, scope],
    );
  }
  expect(store.getSessionAgentMaxCursorSeq(session.id, agent.id))
    .toBe(Math.max(0, ...lanes.filter((lane) => !lane.scope.startsWith("relay:")).map((lane) => lane.cursor)));
  if (lanes.length === 1 && lanes[0]!.scope) {
    expect(store.getSessionAgentLane(session.id, agent.id)).toBeNull();
  }
  const app = createMultiremiApp({ store });
  for (const locator of [`seq=${entry.seq}`, `id=${entry.id}`]) {
    const response = await app.request(`/api/sessions/${session.id}/log/entry?${locator}`);
    expect(response.status).toBe(200);
    expect((await response.json()).delivered).toBe(delivered);
  }
}

async function verifyDeliveryLaneIsolation(store: MultiremiStore, otherLane: "session" | "agent"): Promise<void> {
  const recipient = store.createAgent({ name: "Lane isolation recipient", provider: "codex", visibility: "workspace" });
  const issue = store.createIssue({ title: "Lane isolation", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const comment = store.createIssueComment(issue.id, { issueSessionId: session.id, body: "Read this entry" });
  const entry = store.getConversationLogEntryById(comment.id)!;
  (store as any).db.run("UPDATE multiremi_conversation_log SET to_type='agent',to_ref=?,to_agent_id=?,message_kind='decision' WHERE id=?",[recipient.id,recipient.id,entry.id]);

  let otherSessionId = session.id;
  let otherAgentId = recipient.id;
  if (otherLane === "session") {
    const otherIssue = store.createIssue({ title: "Other lane session", workspaceId: "local" });
    otherSessionId = store.getOrCreateDefaultIssueSession(otherIssue.id).id;
    store.createIssueComment(otherIssue.id, { issueSessionId: otherSessionId, body: "Unrelated entry" });
  } else {
    otherAgentId = store.createAgent({ name: "Other lane agent", provider: "codex", visibility: "workspace" }).id;
  }
  store.getOrCreateSessionAgentLane(otherSessionId, otherAgentId, "dlg_other");
  (store as any).db.run(
    "UPDATE multiremi_session_lanes SET cursor_seq = ? WHERE session_id = ? AND reader_type='agent' AND reader_id = ? AND execution_scope = ?",
    [entry.seq, otherSessionId, otherAgentId, "dlg_other"],
  );
  const app = createMultiremiApp({ store });
  const assertDelivered = async (delivered: boolean) => {
    for (const locator of [`seq=${entry.seq}`, `id=${entry.id}`]) {
      const response = await app.request(`/api/sessions/${session.id}/log/entry?${locator}`);
      expect(response.status).toBe(200);
      expect((await response.json()).delivered).toBe(delivered);
    }
  };

  await assertDelivered(false);
  expect(store.getSessionAgentMaxCursorSeq(session.id, recipient.id)).toBe(0);
  if (otherLane === "agent") {
    store.getOrCreateSessionAgentLane(session.id, recipient.id, "dlg_recipient");
    (store as any).db.run(
      "UPDATE multiremi_session_lanes SET cursor_seq = ? WHERE session_id = ? AND reader_type='agent' AND reader_id = ? AND execution_scope = ?",
      [entry.seq, session.id, recipient.id, "dlg_recipient"],
    );
    expect(store.getSessionAgentMaxCursorSeq(session.id, recipient.id)).toBe(entry.seq);
    await assertDelivered(true);
  }
}

async function verifyChatProjectionAndAccess(store: MultiremiStore): Promise<void> {
  const agent = store.createAgent({ name: "MUL485 chat", provider: "codex", visibility: "workspace" });
  const runtime = store.registerRuntime({ name: "MUL485 runtime", provider: "codex" });
  for (const userId of ["mul485_alice", "mul485_bob"]) {
    store.createWorkspaceMember({ workspaceId: "local", userId, name: userId, role: "member" });
  }
  const alice = await store.createAccessToken({ name: "MUL485 Alice", type: "pat", workspaceId: "local", userId: "mul485_alice" });
  const bob = await store.createAccessToken({ name: "MUL485 Bob", type: "pat", workspaceId: "local", userId: "mul485_bob" });
  const app = createMultiremiApp({ store, authToken: "mul485-test-master" });
  const aliceHeaders = { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" };
  const created = await app.request("/api/chat/sessions", {
    method: "POST", headers: aliceHeaders, body: JSON.stringify({ agent_id: agent.id, title: "Private plan" }),
  });
  expect(created.status).toBe(201);
  const chatId = (await created.json()).id as string;
  const sent = await app.request(`/api/sessions/${chatId}/messages`, {
    method: "POST", headers: aliceHeaders, body: JSON.stringify(requestMessageBody(store, { content: plan }, { type: "agent", ref: store.getChatSession(chatId)!.agentId })),
  });
  expect(sent.status).toBe(200);
  const sentBody = await sent.json();
  const firstTaskId = sentTask(store, sentBody).id;
  const messageId = sentBody.message.id;
  const firstLogEntry = store.getConversationLogEntryById(messageId)!;
  (store as any).db.run("UPDATE multiremi_conversation_log SET to_type='agent',to_ref=?,to_agent_id=?,message_kind='decision' WHERE id=?",[agent.id,agent.id,firstLogEntry.id]);
  const extraMessages = (store as any).db.transaction(() => [
    store.appendChatMessageWithinTransaction({ chatSessionId: chatId, role: "system", body: `System:${"s".repeat(4_001)}` }),
    store.sendMessage({session_id:chatId,sender:{type:"agent",id:agent.id},to:{type:"none"},message_kind:"report",wake_requested:"inbox_only",source_turn_id:store.getTurnForAttempt(firstTaskId)!.id,body_md:`Assistant:${"a".repeat(4_001)}`}).message,
  ])();
  const extraEntries = extraMessages.map((message: { id: string }) => store.getConversationLogEntryById(message.id)!);
  const coldProjection = store.buildTaskSessionProjection(firstTaskId)!;
  const coldEvents = coldProjection.jsonl.split("\n").slice(2).map((line) => JSON.parse(line));
  const systemEntry = extraEntries[0]!;
  const systemLine = coldEvents.find((line) => line.type === "session_event" && line.seq === systemEntry.seq);
  expect(systemLine?.body_folded).toBe(true);
  expect(systemLine?.expand).toBe(`remi message get ${systemEntry.id}`);
  for (const locator of [`seq=${systemEntry.seq}`, `id=${systemEntry.id}`]) {
    const allowed = await app.request(`/api/sessions/${chatId}/log/entry?${locator}`, { headers: aliceHeaders });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).body_md).toBe(systemEntry.body_md);
  }
  const assistantLine = coldEvents.find((line) => line.type === "session_event" && line.seq === extraEntries[1]!.seq);
  expect(assistantLine?.body_folded).toBe(true);
  expect(assistantLine?.expand).toBe(`remi message get ${extraEntries[1]!.id}`);
  expect(store.claimTask(runtime.id)?.id).toBe(firstTaskId);
  store.startTask(firstTaskId);
  store.completeTask(firstTaskId, { output: "Read", workDir: "/tmp/mul485-chat" });
  const next = await app.request(`/api/sessions/${chatId}/messages`, {
    method: "POST", headers: aliceHeaders, body: JSON.stringify(requestMessageBody(store, { content: "Continue" }, { type: "agent", ref: store.getChatSession(chatId)!.agentId })),
  });
  expect(next.status).toBe(200);
  const projection = store.buildTaskSessionProjection(sentTask(store, (await next.json())).id)!;
  const toc = JSON.parse(projection.jsonl.split("\n")[1]!);
  expect(toc.entries).toContainEqual(expect.objectContaining({ id: messageId, chars: plan.length, folded: true, priority: 1 }));
  const folded = projection.jsonl.split("\n").slice(2).map((line) => JSON.parse(line))
    .find((line) => line.type === "session_event" && line.body_folded);
  const firstEntry = toc.entries.find((entry: { id: string }) => entry.id === messageId);
  expect(folded?.expand).toBe(`remi message get ${messageId}`);
  const foldedEvents = projection.jsonl.split("\n").slice(2).map((line) => JSON.parse(line))
    .filter((line) => line.type === "session_event" && line.body_folded);
  const expected = [{ seq: firstEntry.seq, id: messageId, body: plan },
    { seq: extraEntries[0]!.seq, id: extraEntries[0]!.id, body: extraEntries[0]!.body_md },
    { seq: extraEntries[1]!.seq,id:extraEntries[1]!.id,body:extraEntries[1]!.body_md }];
  expect(foldedEvents.length).toBe(expected.length);
  for (const entry of expected) {
    expect(foldedEvents.find((line) => line.seq === entry.seq)?.expand)
      .toBe(`remi message get ${entry.id}`);
    for (const locator of [`seq=${entry.seq}`, `id=${entry.id}`]) {
      const allowed = await app.request(`/api/sessions/${chatId}/log/entry?${locator}`, { headers: aliceHeaders });
      expect(allowed.status).toBe(200);
      expect((await allowed.json()).body_md).toBe(entry.body);
    }
  }
  const path = `/api/sessions/${chatId}/log/entry?id=${messageId}`;
  const denied = await app.request(path, { headers: { Authorization: `Bearer ${bob.token}` } });
  expect(denied.status).not.toBe(200);
}

async function verifyIssueWorkspaceAccess(store: MultiremiStore): Promise<void> {
  const workspace = store.createWorkspace({ name: "MUL485 isolated", slug: `mul485-${Math.random().toString(36).slice(2)}` });
  store.createWorkspaceMember({ workspaceId: workspace.id, userId: "mul485_reader", name: "Reader", role: "member" });
  store.createWorkspaceMember({ workspaceId: "local", userId: "mul485_outsider", name: "Outsider", role: "member" });
  const reader = await store.createAccessToken({ name: "MUL485 reader", type: "pat", workspaceId: workspace.id, userId: "mul485_reader" });
  const outsider = await store.createAccessToken({ name: "MUL485 outsider", type: "pat", workspaceId: "local", userId: "mul485_outsider" });
  const issue = store.createIssue({ title: "Workspace-only plan", workspaceId: workspace.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const comment = store.createIssueComment(issue.id, { issueSessionId: session.id, body: plan });
  const path = `/api/sessions/${session.id}/log/entry?id=${comment.id}`;
  const app = createMultiremiApp({ store, authToken: "mul485-test-master" });
  const allowed = await app.request(path, { headers: { Authorization: `Bearer ${reader.token}` } });
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).body_md).toBe(plan);
  const denied = await app.request(path, { headers: { Authorization: `Bearer ${outsider.token}` } });
  expect(denied.status).not.toBe(200);
}

afterEach(resetMultiremiTestEnv);

describe("MUL-485 SQLite", () => {
  it("folds the complete published plan and expands it by seq or id", async () => {
    expect(plan.length).toBe(40_447);
    await verifyPlanRoundTrip(createStore());
  });

  it("orders the inbox by priority then seq and leaves old daemon JSONL readable", () => {
    verifyPriorityAndCompatibility();
  });

  it("folds a private Chat and denies another member the expanded body", async () => {
    await verifyChatProjectionAndAccess(createStore());
  });

  it("limits issue entry expansion to its workspace", async () => {
    await verifyIssueWorkspaceAccess(createStore());
  });

  it("derives the delivery flag from a recipient turn receipt", async () => {
    await verifyDeliveryReceipt(createStore());
  });

  for (const role of ["issue_owner", "parent_owner", "delegator"] as const) {
    it(`resolves a ${role} report recipient at write time and uses its receipt`, async () => {
      await verifySymbolicRecipientDelivery(createStore(), role);
    });
  }

  it("reports a non-default execution scope cursor as delivered without a turn receipt", async () => {
    await verifyCursorDeliveryAcrossScopes(createStore(), [{ scope: "dlg_scoped", cursor: 1 }], true);
  });

  it("reports the default scope cursor as delivered without a turn receipt", async () => {
    await verifyCursorDeliveryAcrossScopes(createStore(), [{ scope: "", cursor: 1 }], true);
  });

  it("does not mistake a relay cursor for issue inbox delivery", async () => {
    await verifyCursorDeliveryAcrossScopes(createStore(), [{ scope: "relay:chat_bound", cursor: 1 }], false);
  });

  it("counts a differently cased Relay scope as issue inbox delivery", async () => {
    await verifyCursorDeliveryAcrossScopes(createStore(), [{ scope: "Relay:other", cursor: 1 }], true);
  });

  it("reports undelivered when every execution scope cursor is behind", async () => {
    await verifyCursorDeliveryAcrossScopes(createStore(), [
      { scope: "", cursor: 0 }, { scope: "dlg_scoped", cursor: 0 },
    ], false);
  });

  it("ignores a read lane for the same agent in another session", async () => {
    await verifyDeliveryLaneIsolation(createStore(), "session");
  });

  it("ignores another agent's read lane until the recipient reads", async () => {
    await verifyDeliveryLaneIsolation(createStore(), "agent");
  });

  it("reports unknown delivery for a legacy entry without a recipient", async () => {
    await verifyLegacyDeliveryUnknown(createStore());
  });

  it("keeps a 4,001-character legacy delegation report whole", async () => {
    await verifyLegacyReportStaysWhole(createStore());
  });

  it("expands every folded log kind by seq and id without folding unavailable bodies", async () => {
    await verifyEveryFoldedEntryExpands(createStore());
  });
});

function verifyPriorityAndCompatibility(): void {
  const events = [
      makeEvent(1, "system", "FYI", "system", { envelope: envelope("lifecycle", 4) }),
      makeEvent(2, "system", "child finished", "system", { envelope: envelope("report", 3, "done") }),
      makeEvent(3, "system", "child blocked", "system", { envelope: envelope("report", 2, "failed") }),
      makeEvent(4, "message", "@Reader decide", "member"),
      makeEvent(5, "message", "@agt_reader another decision", "member"),
      makeEvent(6, "task_failed", "legacy failure", "system"),
      makeEvent(7, "task_completed", "legacy completion", "system"),
      makeEvent(8, "message", "[@Earlier alias](mention://agent/agt_reader) decide", "member"),
      makeEvent(9, "system", "lifecycle marked failed", "system", { envelope: {
        ...envelope("lifecycle", 2, "failed"), wake: "now", lifecycleEvent: "session_created",
      } }),
      makeEvent(10, "system", "task failed", "system", { envelope: {
        ...envelope("lifecycle", 2, "failed"), wake: "now", lifecycleEvent: "task_failed",
      } }),
    ];
    const projection = buildSessionProjection({ sessionId: "ises_priority", targetAgentId: "agt_reader",
      events, cursorSeq: 0, providerSessionId: null, tokenBudget: 10_000,
      resolveAuthorName: (type, id) => type === "agent" && id === "agt_reader" ? "Reader" : null });
    const toc = JSON.parse(projection.jsonl.split("\n")[1]!);
    expect(toc.entries.map((entry: { seq: number; priority: number }) => [entry.seq, entry.priority]))
      .toEqual([[4, 1], [5, 1], [8, 1], [3, 2], [6, 2], [10, 2], [2, 3], [7, 3], [1, 4], [9, 4]]);
    const task = { id: "tsk_inbox", workspaceId: "local", issueId: "iss_inbox", chatSessionId: null,
      prompt: "Read inbox", issueSession: { id: "ises_priority", title: "Inbox" },
      sessionProjection: projection, repos: [], projectResources: [], project: null,
      agent: { id: "agt_reader", name: "Reader", provider: "codex", skills: [], instructions: "", customEnv: {} } };
    const prompt = buildTaskPrompt(task as never);
    expect(prompt).toContain("## Inbox");
    expect(prompt.indexOf("## Inbox")).toBeLessThan(prompt.indexOf("## Current Session Context"));
    const old = buildTaskPrompt({ ...task, id: "tsk_old", prompt: "Read history", sessionProjection: {
      ...projection, jsonl: projection.jsonl.split("\n").filter((line) => !line.includes('"type":"inbox_toc"')).join("\n"),
    } } as never);
    expect(old).toContain("## Current Session Context");
    expect(old).not.toContain("## Inbox");
    const unknown = buildTaskPrompt({ ...task, id: "tsk_unknown", sessionProjection: {
      ...projection,
      jsonl: projection.jsonl.replace('"type":"inbox_toc"', '"type":"future_directory"'),
    } } as never);
    expect(unknown).toContain("## Current Session Context");
    expect(unknown).not.toContain("## Inbox");
}

function makeEvent(seq: number, kind: string, body: string, authorType: string, metadata: Record<string, unknown> = {}): MultiremiSessionEvent {
  return { id: `sevt_${seq}`, sessionId: "ises_priority", seq, kind, body, authorType,
    authorId: authorType === "member" ? "local" : null, taskId: null, sourceCommentId: null,
    metadata, createdAt: "2026-09-29T00:00:00.000Z" };
}

function envelope(kind: "lifecycle" | "report", priority: number, outcome?: "done" | "failed") {
  return { kind, wake: kind === "lifecycle" ? "inbox_only" : "now", priority, outcome,
    to: { role: "agent", agentId: "agt_reader", issueSessionId: "ises_priority" }, source: {} };
}

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const pgDbName = `mul485_test_${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
describe.skipIf(!pgAdminUrl)("MUL-485 PostgreSQL", () => {
  let admin: Bun.SQL;
  let database: PostgresSyncDatabase;
  let store: MultiremiStore;

  beforeAll(async () => {
    const url = new URL(pgAdminUrl!);
    if (!(["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
      throw new Error("MULTIREMI_TEST_POSTGRES_URL must point to a local dedicated test server");
    }
    try {
      admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
      await admin`SELECT 1`;
      await admin.unsafe(`CREATE DATABASE ${pgDbName}`);
      url.pathname = `/${pgDbName}`;
      database = new PostgresSyncDatabase(url.toString());
      store = new MultiremiStore(database);
      store.ensureLocalWorkspace();
    } catch {
      throw new Error("Configured local test PostgreSQL is unavailable or cannot create a dedicated database");
    }
  });

  afterAll(async () => {
    database?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${pgDbName} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("folds and expands the identical plan fixture on real PostgreSQL", async () => {
    await verifyPlanRoundTrip(store);
  });

  it("orders the same envelope and legacy entries on the PostgreSQL run", () => {
    verifyPriorityAndCompatibility();
  });

  it("folds a private Chat and enforces creator access on real PostgreSQL", async () => {
    await verifyChatProjectionAndAccess(store);
  });

  it("limits issue entry expansion to its workspace on real PostgreSQL", async () => {
    await verifyIssueWorkspaceAccess(store);
  });

  it("derives the delivery flag from a recipient turn receipt on real PostgreSQL", async () => {
    await verifyDeliveryReceipt(store);
  });

  for (const role of ["issue_owner", "parent_owner", "delegator"] as const) {
    it(`resolves a ${role} report recipient at write time on real PostgreSQL`, async () => {
      await verifySymbolicRecipientDelivery(store, role);
    });
  }

  it("reports a non-default execution scope cursor as delivered on real PostgreSQL", async () => {
    await verifyCursorDeliveryAcrossScopes(store, [{ scope: "dlg_scoped", cursor: 1 }], true);
  });

  it("reports the default scope cursor as delivered on real PostgreSQL", async () => {
    await verifyCursorDeliveryAcrossScopes(store, [{ scope: "", cursor: 1 }], true);
  });

  it("does not mistake a relay cursor for issue inbox delivery on real PostgreSQL", async () => {
    await verifyCursorDeliveryAcrossScopes(store, [{ scope: "relay:chat_bound", cursor: 1 }], false);
  });

  it("counts a differently cased Relay scope as issue inbox delivery on real PostgreSQL", async () => {
    await verifyCursorDeliveryAcrossScopes(store, [{ scope: "Relay:other", cursor: 1 }], true);
  });

  it("reports undelivered when every execution scope cursor is behind on real PostgreSQL", async () => {
    await verifyCursorDeliveryAcrossScopes(store, [
      { scope: "", cursor: 0 }, { scope: "dlg_scoped", cursor: 0 },
    ], false);
  });

  it("ignores a read lane for the same agent in another session on real PostgreSQL", async () => {
    await verifyDeliveryLaneIsolation(store, "session");
  });

  it("ignores another agent's read lane until the recipient reads on real PostgreSQL", async () => {
    await verifyDeliveryLaneIsolation(store, "agent");
  });

  it("reports unknown delivery for a legacy entry without a recipient on real PostgreSQL", async () => {
    await verifyLegacyDeliveryUnknown(store);
  });

  it("keeps a 4,001-character legacy delegation report whole on real PostgreSQL", async () => {
    await verifyLegacyReportStaysWhole(store);
  });

  it("expands every folded log kind by seq and id on real PostgreSQL", async () => {
    await verifyEveryFoldedEntryExpands(store);
  });
});
