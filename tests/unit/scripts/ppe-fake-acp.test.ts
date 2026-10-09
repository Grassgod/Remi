import { createResponsibleTestIssue } from '../multiremi/helpers.js';
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "../multiremi/helpers.js";

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
    : store.getOrCreateDefaultIssueSession(createResponsibleTestIssue(store, { title: "PPE", assigneeType: "agent", assigneeId: agent.id }).id);
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
  const rpc = async (method: string, params: unknown = {}) => {
    const id = ++seq; child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await until(() => frames.some(f => f.id === id)); return frames.find(f => f.id === id);
  };
  await rpc("initialize"); const providerSession = (await rpc("session/new")).result.sessionId;
  const prompt = (text = marker) => rpc("session/prompt", { sessionId: providerSession, prompt: [{ type: "text", text }] });
  const close = async () => { child.kill(); await child.exited; await Promise.all(pumping); server.stop(true);
    store.stopNotificationDeliverySweeper(); rmSync(dir, { recursive: true, force: true }); };
  return { store, session, sent, task, bridge, marker, send, rpc, notify, prompt, providerSession, frames, diagnostics, dir, close };
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
