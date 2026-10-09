import { createResponsibleTestIssue } from '../multiremi/helpers.js';
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "../multiremi/helpers.js";
import { AcpProvider } from "@acp/index.js";
import { DaemonProtocolHarness, waitFor } from "../../integration/daemon-protocol-v2/harness.js";

afterEach(resetMultiremiTestEnv);
const root = resolve(import.meta.dir, "../../..");
async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("PPE fixture condition timed out"); await Bun.sleep(10); }
}
async function world(kind: "chat" | "issue", pause = "") {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ id: "rt_ppe_fixture", name: "PPE", provider: "codex", daemonId: "ppe-fixture-daemon" });
  const agent = store.createAgent({ name: "PPE", provider: "codex", runtimeId: runtime.id });
  const session = kind === "chat" ? store.createChatSession({ agentId: agent.id })
    : store.getOrCreateDefaultIssueSession(createResponsibleTestIssue(store, { title: "PPE", assigneeType: "agent", assigneeId: agent.id, responsibleMemberId: "mem_local_local" }).id);
  const marker = `MUL-493/PROBE/${kind}-first`;
  const send = (text: string) => store.sendMessage({ session_id: session.id, sender: { type: "member", id: "mem_local_local" },
    to: { type: "agent", ref: agent.id }, message_kind: "request", wake_requested: "now", body_md: text });
  const sent = send(`${marker}\nprivate unrelated text`);
  const task = store.claimTask(runtime.id)!;
  store.recordTaskOffered(task.id, runtime.id); store.acceptTaskOffer(task.id, runtime.id); store.startTask(task.id);
  const bridge = store.getDaemonTurnBridge(); bridge.offerInput(store.getTaskWithAgent(task.id)!);
  const access = await store.createTaskAccessToken(store.getTask(task.id)!, "local");
  const app = createMultiremiApp({ store, authToken: "fixture-master" });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const dir = mkdtempSync(join(tmpdir(), "ppe-fake-acp-test-"));
  const child = Bun.spawn([process.execPath, join(root, "deploy/zadig/ppe/fake-acp.ts")], {
    env: { ...process.env, MULTIREMI_SERVER_URL: server.url.toString(), MULTIREMI_TOKEN: access.token,
      MULTIREMI_WORKSPACE_ID: "local", MULTIREMI_TURN_ID: sent.turn_id!, MULTIREMI_ATTEMPT_ID: task.id,
      PPE_ACP_EVIDENCE_DIR: dir, PPE_ACP_PAUSE: pause, PPE_ACP_REMI_BIN: process.execPath,
      PPE_ACP_REMI_ENTRY: join(root, "apps/remi/main.ts") }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const frames: any[] = [], diagnostics: any[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>, into: any[]) => {
    let pending = ""; const decoder = new TextDecoder();
    for await (const bytes of stream) {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split("\n"); pending = lines.pop()!;
      for (const line of lines) if (line) into.push(JSON.parse(line));
    }
  };
  const pumping = [pump(child.stdout, frames), pump(child.stderr, diagnostics)];
  let seq = 0;
  const notify = (method: string, params: unknown) => { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); };
  const respond = (id: string, result: unknown) => { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); };
  const rpc = async (method: string, params: unknown = {}) => {
    const id = ++seq; child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await until(() => frames.some(f => f.id === id)); return frames.find(f => f.id === id);
  };
  await rpc("initialize"); const providerSession = (await rpc("session/new")).result.sessionId;
  const prompt = (text = marker) => rpc("session/prompt", { sessionId: providerSession, prompt: [{ type: "text", text }] });
  const close = async () => { child.kill(); await child.exited; await Promise.all(pumping); server.stop(true);
    store.stopNotificationDeliverySweeper(); rmSync(dir, { recursive: true, force: true }); };
  return { store, session, sent, task, bridge, marker, send, rpc, notify, respond, prompt, providerSession, frames, diagnostics, dir, close };
}

for (const kind of ["chat", "issue"] as const) test(`PPE ${kind} marker uses a real CLI range read and persisted receipt`, async () => {
  const f = await world(kind);
  try {
    expect(await f.prompt()).toMatchObject({ result: { stopReason: "end_turn" } });
    const text = f.frames.find(frame => frame.method === "session/update").params.update.content.text;
    const evidence = JSON.parse(text.replace("PPE_PROBE_EVIDENCE ", ""));
    expect(evidence).toMatchObject({ turn_id: f.sent.turn_id, attempt_id: f.task.id });
    expect(evidence.reads[0]).toMatchObject({ conversation_id: f.session.id, runtime_id: "rt_ppe_fixture", provider: "codex",
      input_read_offset: 0, messages: [{ message_id: f.sent.message.id, seq: f.sent.message.seq, markers: [f.marker], read_count: 1 }] });
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.task.agentId).seq).toBeGreaterThanOrEqual(f.sent.message.seq);
    const file = join(f.dir, readdirSync(f.dir).find(n => n.endsWith(".jsonl"))!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("private unrelated text");
    expect(text).not.toContain("private unrelated text");
  } finally { await f.close(); }
}, 20_000);

test("PPE pauses before reading and resumes to consume a real injected marker", async () => {
  const f = await world("issue", "before-read,after-read");
  try {
    const done = f.prompt();
    await until(() => f.diagnostics.some(e => e.event === "paused" && e.stage === "before-read"));
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.task.agentId).seq).toBe(0);
    expect(await f.rpc("ppe/resume", { sessionId: f.providerSession, stage: "wrong" })).toMatchObject({ result: { resumed: false } });
    expect(await f.rpc("ppe/resume", { sessionId: f.providerSession, stage: "before-read" })).toMatchObject({ result: { resumed: true } });
    await until(() => f.diagnostics.some(e => e.event === "paused" && e.stage === "after-read"));
    const later = f.send("MUL-493/PROBE/injected");
    f.bridge.offerInput(f.store.getTaskWithAgent(f.task.id)!);
    writeFileSync(f.diagnostics.find(e => e.stage === "after-read").control_file, "after-read");
    expect(await done).toMatchObject({ result: { stopReason: "end_turn" } });
    const reads = f.diagnostics.filter(e => e.event === "actual_read");
    expect(reads.flatMap(e => e.messages).map(m => m.message_id)).toEqual([f.sent.message.id, later.message.id]);
    expect(reads.flatMap(e => e.messages).map(m => m.read_count)).toEqual([1, 1]);
  } finally { await f.close(); }
}, 20_000);

test("PPE cancellation stops a paused read without a successful reply", async () => {
  const f = await world("chat", "before-read");
  try {
    const done = f.prompt(); await until(() => f.diagnostics.some(e => e.event === "paused"));
    f.notify("session/cancel", { sessionId: f.providerSession });
    expect(await done).toMatchObject({ result: { stopReason: "cancelled" } });
    expect(f.frames.filter(e => e.method === "session/update")).toHaveLength(0);
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.task.agentId).seq).toBe(0);
  } finally { await f.close(); }
}, 20_000);

test("PPE refuses a successful range response without an actual persisted read receipt", async () => {
  const f = await world("issue");
  const read = spyOn(f.store, "recordSessionAgentRangeRead").mockReturnValue({ seq: 0, offset: 0 });
  try {
    expect(await f.prompt()).toMatchObject({ error: { message: "ppe_read_not_confirmed" } });
    expect(f.frames.filter(e => e.method === "session/update")).toHaveLength(0);
    expect(f.diagnostics.filter(e => e.event === "actual_read")).toHaveLength(0);
  } finally { read.mockRestore(); await f.close(); }
}, 20_000);

test("PPE untagged smoke prompts keep their response and can reuse a provider session", async () => {
  const f = await world("chat");
  try {
    expect(await f.prompt("ordinary smoke")).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(await f.rpc("session/resume", { sessionId: f.providerSession })).toMatchObject({ result: { sessionId: f.providerSession } });
    expect(await f.prompt("ordinary followup")).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(f.frames.filter(e => e.method === "session/update").map(e => e.params.update.content.text))
      .toEqual(["PPE daemon ACP smoke test completed.", "PPE daemon ACP smoke test completed."]);
    expect(readdirSync(f.dir)).toHaveLength(0);
  } finally { await f.close(); }
}, 20_000);

test("PPE ASK waits for a real elicitation answer and records the original business Q", async () => {
  const f = await world("issue");
  try {
    f.send("PR404/RESP/ASK"); f.bridge.offerInput(f.store.getTaskWithAgent(f.task.id)!);
    const done = f.prompt("PR404/RESP/ASK");
    await until(() => f.frames.some(frame => frame.method === "elicitation/create"));
    const request = f.frames.find(frame => frame.method === "elicitation/create");
    expect(f.frames.filter(frame => frame.method === "session/update")).toHaveLength(0);
    const created = f.bridge.rpc("turn.decision", { turn_id: f.sent.turn_id, attempt_id: f.task.id,
      wait_id: request.id, dedupe_key: "ppe-ask-native", body_md: request.params.message, options: [],
      metadata: { kind: "question", questions: [{ question: "PPE decision", fieldKey: "answer", options: [{ label: "Continue" }, { label: "Stop" }] }] } },
      { runtimeId: "rt_ppe_fixture", daemonId: "ppe-fixture-daemon", workspaceId: "local" });
    expect(created.ok).toBe(true);
    const questionId = String(created.message_id);
    f.store.answerQuestion(questionId, { expected_route_revision: 1, response: { answers: { "PPE decision": "Continue" } } },
      { type: "member", id: "mem_local_local" });
    f.respond(request.id, { action: "accept", content: { answer: "Continue" } });
    expect(await done).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(f.diagnostics.find(event => event.event === "responsibility_answer_observed"))
      .toMatchObject({ question_id: questionId, turn_id: f.sent.turn_id, attempt_id: f.task.id });
    // A later prompt in this same product lane reads the saved answer; it never
    // manufactures a second Q from the marker in the original conversation.
    expect(await f.prompt("PR404/RESP/ASK")).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(f.frames.filter(frame => frame.method === "elicitation/create")).toHaveLength(1);
    expect(f.store.listIssueQuestions(f.task.issueId!)).toHaveLength(1);
    const evidence = readFileSync(join(f.dir, `${f.task.id}-responsibility.jsonl`), "utf8");
    expect(evidence).not.toContain("private unrelated text");
    expect(evidence).not.toContain("Bearer");
  } finally { await f.close(); }
}, 20_000);

test("PPE actual daemon Bootstrap reads its range, consumes a normalized native Q and submits formal delivery", async () => {
  let evidenceDirectory: string;
  const h = await DaemonProtocolHarness.create({ database: "sqlite", providerFactory: options => new AcpProvider({
    ...options, executable: process.execPath, args: [join(root, "deploy/zadig/ppe/fake-acp.ts")], privateTmpDirectory: undefined,
    env: { ...options.env, PPE_ACP_EVIDENCE_DIR: evidenceDirectory!, PPE_ACP_REMI_BIN: process.execPath, PPE_ACP_REMI_ENTRY: join(root, "apps/remi/main.ts") },
  }) });
  evidenceDirectory = join(h.root, "responsibility-evidence");
  try {
    await h.startDaemon(); await h.settleHeartbeat();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    const agent = h.store.createAgent({ name: "Actual PPE responsibility execution", provider: "claude", runtimeId });
    const issue = createResponsibleTestIssue(h.store, { title: "PR404/RESP/ASK PR404/RESP/SUBMIT — native answer and acceptance", assigneeType: "agent", assigneeId: agent.id, responsibleMemberId: "mem_local_local" });
    const session = h.store.getOrCreateDefaultIssueSession(issue.id);
    const sent = h.store.sendMessage({ session_id: session.id, sender: { type: "member", id: "mem_local_local" }, to: { type: "agent", ref: agent.id }, message_kind: "request", wake_requested: "now", body_md: issue.title });
    await waitFor(() => h.store.listIssueQuestions(issue.id).length === 1, "actual native elicitation", 20_000);
    const question = h.store.listIssueQuestions(issue.id)[0]!;
    const attemptId = h.store.getTurn(sent.turn_id!)!.current_attempt_id!;
    const prompt = h.store.getTaskPrompt(attemptId)!;
    expect(prompt.prompt).toStartWith("# Bootstrap Prompt");
    expect(prompt.prompt).toContain(`Turn: ${sent.turn_id}; attempt: ${attemptId};`);
    expect(question.original_message).toBe("PR404/RESP/ASK: Should this PPE Issue continue?\n\nPR404/RESP/ASK: Should this PPE Issue continue?");
    expect(question.wait_status).toBe("waiting");
    expect(h.store.listIssueDeliveries(issue.id)).toHaveLength(0);
    h.store.answerQuestion(question.id, { expected_route_revision: question.route_revision, response: { answers: { "PR404/RESP/ASK: Should this PPE Issue continue?": "Continue" } } }, { type: "member", id: "mem_local_local" });
    await waitFor(() => ["completed", "failed"].includes(h.store.getTurn(sent.turn_id!)?.status ?? ""), "native answer and formal submit", 20_000);
    const turn = h.store.getTurn(sent.turn_id!)!;
    expect({ status: turn.status, error: h.store.getTask(attemptId)?.error }).toEqual({ status: "completed", error: null });
    expect(h.store.getQuestion(question.id)).toMatchObject({ status: "answered", wait_status: "consumed", recovery: { consumer_turn_id: turn.id, consumer_attempt_id: attemptId } });
    expect(h.store.listIssueDeliveries(issue.id)).toHaveLength(1);
    const delivery = h.store.listIssueDeliveries(issue.id)[0]!;
    expect(delivery).toMatchObject({ issueId: issue.id, status: "pending", sourceSessionId: session.id, submittedBy: { type: "agent", id: agent.id } });
    const receipt = h.store.listTurnAttempts(turn.id).find(attempt => attempt.id === attemptId)!;
    expect(receipt.input_read_seq).toBeGreaterThanOrEqual(sent.message.seq); expect(receipt.input_read_offset).toBe(0);
    await h.settleHeartbeat();
    expect(h.db.query('SELECT id FROM multiremi_turns WHERE issue_id=? AND agent_id=?').all(issue.id, agent.id)).toEqual([{ id: turn.id }]);
    expect(h.store.listTurnAttempts(turn.id)).toHaveLength(1);
    expect(h.store.listIssueDeliveries(issue.id)).toHaveLength(1);
    const evidence = readFileSync(join(evidenceDirectory, `${attemptId}-responsibility.jsonl`), "utf8");
    expect(evidence).toContain('"event":"responsibility_input_read"'); expect(evidence).toContain('"event":"responsibility_answer_observed"'); expect(evidence).toContain('"event":"responsibility_submitted"');
    expect(evidence).not.toContain("Bearer");
  } finally { await h.dispose(); }
}, 45_000);

test("PPE SUBMIT invokes the real task-authenticated formal delivery CLI", async () => {
  const f = await world("issue");
  try {
    f.send("PR404/RESP/SUBMIT"); f.bridge.offerInput(f.store.getTaskWithAgent(f.task.id)!);
    expect(await f.prompt("PR404/RESP/SUBMIT")).toMatchObject({ result: { stopReason: "end_turn" } });
    const deliveries = f.store.listIssueDeliveries(f.task.issueId!);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ issueId: f.task.issueId, status: "pending", submittedBy: { type: "agent", id: f.task.agentId } });
    expect(f.diagnostics.find(event => event.event === "responsibility_submitted"))
      .toMatchObject({ issue_id: f.task.issueId, delivery_id: deliveries[0]!.id });
  } finally { await f.close(); }
}, 20_000);

test("PPE cancellation releases an unanswered provider RPC without a successful reply", async () => {
  const f = await world("issue");
  try {
    f.send("PR404/RESP/ASK"); f.bridge.offerInput(f.store.getTaskWithAgent(f.task.id)!);
    const done = f.prompt("PR404/RESP/ASK");
    await until(() => f.frames.some(frame => frame.method === "elicitation/create"));
    f.notify("session/cancel", { sessionId: f.providerSession });
    expect(await done).toMatchObject({ result: { stopReason: "cancelled" } });
    expect(f.frames.filter(frame => frame.method === "session/update")).toHaveLength(0);
  } finally { await f.close(); }
}, 20_000);

test("PPE PRESENTER reads a real authorized notification and summarizes its original Q", async () => {
  const f = await world("issue");
  const previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    f.store.heartbeatRuntime("rt_ppe_fixture", { supportsFeishuBotConfig: true });
    f.store.upsertFeishuBotConfig("local", { agentId: f.task.agentId, runtimeId: "rt_ppe_fixture", appId: "cli_ppe_responsibility",
      appSecretOp: "set", appSecret: "synthetic-ppe-secret", domain: "feishu", enabled: false, responsibleMemberId: "mem_local_local" });
    const worker = f.store.createAgent({ name: "PPE asking worker", provider: "codex", runtimeId: "rt_ppe_fixture" });
    f.store.updateIssue(f.task.issueId!, { assigneeType: "agent", assigneeId: worker.id });
    f.store.registerRuntime({ id: "rt_ppe_fixture", name: "PPE", provider: "codex", daemonId: "ppe-fixture-daemon", maxConcurrency: 4 });
    const source = f.store.createTask({ agentId: worker.id, issueId: f.task.issueId!, prompt: "PPE question" });
    expect(f.store.claimTask("rt_ppe_fixture")?.id).toBe(source.id); f.store.startTask(source.id);
    const created = f.bridge.rpc("turn.decision", { turn_id: f.store.getTurnForAttempt(source.id)!.id, attempt_id: source.id,
      wait_id: "ppe-presenter-native", dedupe_key: "ppe-presentation", body_md: "Should we continue?", options: [],
      metadata: { kind: "question", questions: [{ question: "Should we continue?", options: [{ label: "Yes" }, { label: "No" }] }] } },
      { runtimeId: "rt_ppe_fixture", daemonId: "ppe-fixture-daemon", workspaceId: "local" });
    expect(created.ok).toBe(true);
    f.bridge.offerInput(f.store.getTaskWithAgent(f.task.id)!);
    expect(await f.prompt("PR404/RESP/PRESENTER")).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(f.store.getQuestion(String(created.message_id))).toMatchObject({ status: "pending", original_message: "Should we continue?",
      summary: { agent_id: f.task.agentId }, original_questions: [{ question: "Should we continue?", options: [{ label: "Yes" }, { label: "No" }] }] });
    expect(f.diagnostics.find(event => event.event === "responsibility_presented"))
      .toMatchObject({ question_id: created.message_id, route_revision: 1 });
  } finally {
    if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
    await f.close();
  }
}, 20_000);
