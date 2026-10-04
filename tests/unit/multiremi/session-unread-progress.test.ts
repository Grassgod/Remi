import { afterEach, expect, spyOn, test } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { useTaskSessionInput } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { DaemonTaskOffers } from "@multiremi/api/daemon-protocol/task-offers.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { log } from "@multiremi/api/helpers/common.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ id: "rt_reader", name: "Reader", provider: "claude", daemonId: "reader-daemon",
    workspaceId: "local", ownerId: "local", status: "online", maxConcurrency: 1, metadata: { parallel_agent_execution: 1 } });
  const agent = store.createAgent({ name: "Reader", provider: "claude", runtimeId: runtime.id });
  const issue = store.createIssue({ title: "Unread progress" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const claim = () => {
    store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "read context" });
    const task = store.claimTask(runtime.id)!;
    const response = daemonTaskClaimResponse(store, task, store.getTaskTriggerMetadata(task));
    useTaskSessionInput(store, task, response);
    return { task, response, range: JSON.parse((response.session_projection as any).jsonl.split("\n")[0]) };
  };
  const finish = (taskId: string) => {
    store.startTask(taskId);
    store.completeTask(taskId, { output: "done", sessionId: "provider-reader", workDir: "/tmp/reader-work" });
  };
  return { store, runtime, agent, issue, session, claim, finish };
}

for (const read of ["none", "partial", "all"] as const) test(`warm resume keeps actual unread progress after ${read} range reads`, async () => {
  const f = fixture();
  const first = f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local", body: "FIRST_UNREAD" });
  const long = f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local", body: "LONG_UNREAD".repeat(10_000) });
  const initial = f.claim();
  const credential = await f.store.createTaskAccessToken(initial.task, "local");
  const app = createMultiremiApp({ store: f.store });
  let cursor: string | null = null;
  if (read !== "none") do {
    const params = new URLSearchParams({ from: "0", to: String(initial.range.to_seq) });
    if (cursor) params.set("cursor", cursor);
    const response = await app.request(`/api/sessions/${f.session.id}/log/entry?${params}`,
      { headers: { Authorization: `Bearer ${credential.token}` } });
    expect(response.status).toBe(200);
    cursor = ((await response.json()) as any).next_cursor;
    if (read === "partial") break;
  } while (cursor);
  const progress = f.store.getSessionAgentReadProgress(f.session.id, f.agent.id);
  if (read === "none") expect(progress).toEqual({ seq: 0, offset: 0 });
  if (read === "partial") {
    expect(progress.seq).toBe(f.store.locateConversationLogEntry(f.session.id, first.id)!.seq);
    expect(progress.offset).toBeGreaterThan(0);
    expect(progress.seq + 1).toBe(f.store.locateConversationLogEntry(f.session.id, long.id)!.seq);
  }
  if (read === "all") expect(progress).toEqual({ seq: initial.range.to_seq, offset: 0 });
  f.finish(initial.task.id);
  expect(f.store.getSessionAgentLane(f.session.id, f.agent.id)).toMatchObject({
    providerSessionId: "provider-reader", cursorSeq: initial.range.to_seq,
  });
  expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual(progress);
  f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local", body: "NEW_UNREAD" });
  const next = f.claim();
  expect(next.response.session_projection).toMatchObject({ mode: "delta" });
  expect(next.range.from_seq).toBe(progress.seq);
  expect(next.range.to_seq).toBeGreaterThan(initial.range.to_seq);
  const other = f.store.createAgent({ name: "Independent reader", provider: "codex" });
  expect(f.store.getSessionAgentReadProgress(f.session.id, other.id)).toEqual({ seq: 0, offset: 0 });
});

test("out-of-order pages cannot acknowledge unread gaps; partial pages persist and final-page telemetry is explicit", async () => {
  const f = fixture();
  const body = "x".repeat(70_000);
  f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local", body });
  const initial = f.claim();
  const credential = await f.store.createTaskAccessToken(initial.task, "local");
  const app = createMultiremiApp({ store: f.store });
  const info = spyOn(log, "info").mockImplementation(() => {});
  const page = async (cursor?: string, to = initial.range.to_seq) => {
    const params = new URLSearchParams({ from: "0", to: String(to) });
    if (cursor) params.set("cursor", cursor);
    const response = await app.request(`/api/sessions/${f.session.id}/log/entry?${params}`,
      { headers: { Authorization: `Bearer ${credential.token}` } });
    expect(response.status).toBe(200);
    return await response.json() as any;
  };
  try {
    const forgedFinal = await page(JSON.stringify({ seq: initial.range.to_seq + 1, offset: 0 }));
    expect(forgedFinal.next_cursor).toBeNull();
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
    await page(JSON.stringify({ seq: 1, offset: 64_000 }));
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
    const first = await page();
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual({ seq: 0, offset: 32_000 });
    const second = await page(first.next_cursor);
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual({ seq: 0, offset: 64_000 });
    const last = await page(second.next_cursor);
    expect(last.next_cursor).toBeNull();
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual({ seq: initial.range.to_seq, offset: 0 });
    await page(undefined, initial.range.to_seq + 100);
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id).seq).toBe(initial.range.to_seq);
    expect(info.mock.calls).toContainEqual(["Session unread range read", expect.objectContaining({
      complete: false, returned_from_seq: 1, returned_to_seq: 1,
      read_start: { seq: 1, offset: 32_000 }, read_end: { seq: 1, offset: 64_000 }, read_high_water: 0, read_offset: 64_000,
    })]);
    expect(info.mock.calls).toContainEqual(["Session unread range read", expect.objectContaining({
      complete: true, read_high_water: initial.range.to_seq, read_offset: 0,
    })]);
    expect(JSON.stringify(info.mock.calls)).not.toContain(credential.token);
    expect(JSON.stringify(info.mock.calls)).not.toContain(body);
  } finally { info.mockRestore(); }
});

for (const scenario of ["adjacent", "gap", "folded", "budget-folded", "reject"] as const) test(`offer acceptance acknowledges only contiguous complete inline triggers: ${scenario}`, async () => {
  const f = fixture();
  if (scenario === "gap") f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local", body: "UNREAD_GAP" });
  const trigger = f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local",
    body: "trigger".repeat(scenario === "folded" ? 2_000 : scenario === "budget-folded" ? 1_000 : 1) });
  const task = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: trigger.body, triggerCommentId: trigger.id });
  const layer = new DaemonProtocolLayer({ store: f.store });
  new DaemonTaskOffers({ store: f.store, layer, prepare: async claimed => {
    const response = daemonTaskClaimResponse(f.store, claimed, f.store.getTaskTriggerMetadata(claimed));
    useTaskSessionInput(f.store, claimed, response);
    if (scenario === "budget-folded") (response.agent as any).instructions = "x".repeat(700_000);
    return response;
  } });
  const frames: any[] = [];
  const session = layer.openSession({ send: text => { frames.push(JSON.parse(text)); return text.length; }, close() {} },
    { masterToken: true, accessToken: null });
  try {
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2, daemon_id: "reader-daemon",
      cli_version: DAEMON_MIN_CLI_VERSION, caps: ["offer"], runtimes: [{ runtime_id: f.runtime.id, provider: "claude", max_concurrency: 1, active_task_ids: [] }] } }));
    await layer.drain();
    expect(frames).toContainEqual(expect.objectContaining({ t: "welcome" }));
    expect(session.runtimeIds).toContain(f.runtime.id);
    expect(f.store.getTask(task.id)).toMatchObject({ status: "dispatched", runtimeId: f.runtime.id });
    expect(frames).toContainEqual(expect.objectContaining({ t: "task.offer" }));
    const offered = frames.find(frame => frame.t === "task.offer")!;
    expect(offered.p.id).toBe(task.id);
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id)).toEqual({ seq: 0, offset: 0 });
    await session.handleMessage(JSON.stringify({ v: 2, t: "res", re: String(offered.seq), ack: offered.seq,
      p: scenario === "reject" ? { ok: false, code: "capacity" } : { ok: true } }));
    await layer.drain();
    const progress = f.store.getSessionAgentReadProgress(f.session.id, f.agent.id);
    if (scenario === "adjacent") expect(progress.seq).toBe(f.store.locateConversationLogEntry(f.session.id, trigger.id)!.seq);
    else expect(progress).toEqual({ seq: 0, offset: 0 });
  } finally { layer.closeAll(); layer.stop(); await layer.drain(); }
});

test("Chat range reads use the same persistent high-water independent of provider completion", async () => {
  const f = fixture(); const chat = f.store.createChatSession({ agentId: f.agent.id });
  const task = f.store.sendChatMessage(chat.id, { body: "CHAT_UNREAD" }).task;
  const claimed = f.store.claimTask(f.runtime.id)!;
  const credential = await f.store.createTaskAccessToken(claimed, "local");
  const to = f.store.getConversationLogHead(chat.id)!.headSeq;
  const app = createMultiremiApp({ store: f.store });
  const response = await app.request(`/api/sessions/${chat.id}/log/entry?from=0&to=${to}`,
    { headers: { Authorization: `Bearer ${credential.token}` } });
  expect(response.status).toBe(200);
  expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: to, offset: 0 });
  f.finish(task.id);
  expect(f.store.getSessionAgentReadProgress(chat.id, f.agent.id)).toEqual({ seq: to, offset: 0 });
});
