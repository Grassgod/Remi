import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiSessionEvent } from "@multiremi/contracts/types.js";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

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
  expect(folded.expand).toBe(`remi session log get ${session.id} ${entry.seq}`);
  expect(folded.body).toBeUndefined();

  const app = createMultiremiApp({ store });
  for (const locator of [`seq=${entry.seq}`, `id=${entry.id}`]) {
    const response = await app.request(`/api/sessions/${session.id}/log/entry?${locator}`);
    expect(response.status).toBe(200);
    const complete = await response.json();
    expect(complete.body_md).toBe(plan);
    expect(complete.body_md.length).toBe(plan.length);
    expect(complete.metadata).toEqual(entry.metadata);
    expect(complete).toHaveProperty("delivered");
  }
  for (const query of ["", "?seq=-1", "?seq=1.5", `?seq=${entry.seq}&id=${entry.id}`]) {
    expect((await app.request(`/api/sessions/${session.id}/log/entry${query}`)).status).toBe(400);
  }
  expect((await app.request(`/api/sessions/${session.id}/log/entry?id=missing`)).status).toBe(404);
  expect((await app.request(`/api/sessions/ises_other/log/entry?seq=${entry.seq}`)).status).not.toBe(200);
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
  const sent = await app.request(`/api/chat/sessions/${chatId}/messages`, {
    method: "POST", headers: aliceHeaders, body: JSON.stringify({ content: plan }),
  });
  expect(sent.status).toBe(201);
  const { task_id: firstTaskId, message_id: messageId } = await sent.json();
  const firstLogEntry = store.getConversationLogEntryById(messageId)!;
  (store as any).db.transaction(() => store.updateConversationLogWithinTransaction(chatId, firstLogEntry.seq, {
    fields: { metadata: { ...firstLogEntry.metadata, envelope: {
      kind: "decision_needed", wake: "now", priority: 1,
      to: { role: "chat", chatSessionId: chatId, agentId: agent.id }, source: {},
    } } },
  }))();
  expect(store.claimTask(runtime.id)?.id).toBe(firstTaskId);
  store.startTask(firstTaskId);
  store.completeTask(firstTaskId, { output: "Read", workDir: "/tmp/mul485-chat" });
  const next = await app.request(`/api/chat/sessions/${chatId}/messages`, {
    method: "POST", headers: aliceHeaders, body: JSON.stringify({ content: "Continue" }),
  });
  expect(next.status).toBe(201);
  const projection = store.buildTaskSessionProjection((await next.json()).task_id)!;
  const toc = JSON.parse(projection.jsonl.split("\n")[1]!);
  expect(toc.entries).toContainEqual(expect.objectContaining({ id: messageId, chars: plan.length, folded: true, priority: 1 }));
  const folded = projection.jsonl.split("\n").slice(2).map((line) => JSON.parse(line))
    .find((line) => line.type === "session_event" && line.body_folded);
  const firstEntry = toc.entries.find((entry: { id: string }) => entry.id === messageId);
  expect(folded?.expand).toBe(`remi session log get ${chatId} ${firstEntry.seq}`);
  const path = `/api/sessions/${chatId}/log/entry?id=${messageId}`;
  const allowed = await app.request(path, { headers: aliceHeaders });
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).body_md).toBe(plan);
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
    ];
    const projection = buildSessionProjection({ sessionId: "ises_priority", targetAgentId: "agt_reader",
      events, cursorSeq: 0, providerSessionId: null, tokenBudget: 10_000,
      resolveAuthorName: (type, id) => type === "agent" && id === "agt_reader" ? "Reader" : null });
    const toc = JSON.parse(projection.jsonl.split("\n")[1]!);
    expect(toc.entries.map((entry: { seq: number; priority: number }) => [entry.seq, entry.priority]))
      .toEqual([[4, 1], [5, 1], [3, 2], [6, 2], [2, 3], [7, 3], [1, 4]]);
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
});
