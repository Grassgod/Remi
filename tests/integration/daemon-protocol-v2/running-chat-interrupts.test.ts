import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AcpProvider } from "@acp/index.js";
import { AcpClient } from "@acp/client.js";
import type { SendMessageResult } from "@multiremi/contracts/unified-model.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const harnesses: DaemonProtocolHarness[] = [];
const originalCodexHome = process.env.CODEX_HOME;
let prompts: ReturnType<typeof spyOn<AcpClient, "prompt">>;
afterEach(async () => {
  try { for (const h of harnesses.splice(0)) await h.dispose(); }
  finally {
    prompts?.mockRestore();
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }
});
const repository = resolve(import.meta.dir, "../../..");
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

async function world(provider: "claude" | "codex") {
  prompts = spyOn(AcpClient.prototype, "prompt");
  let evidenceDirectory: string;
  const h = await DaemonProtocolHarness.create({
    providers: [provider],
    providerFactory: options => new AcpProvider({
      ...options,
      executable: process.execPath,
      args: [join(repository, "deploy/zadig/ppe/fake-acp.ts")],
      // The fixture and its CLI use the harness's temporary tree directly.
      privateTmpDirectory: undefined,
      env: { ...options.env, PPE_ACP_EVIDENCE_DIR: evidenceDirectory!,
        PPE_ACP_REMI_BIN: process.execPath, PPE_ACP_REMI_ENTRY: join(repository, "apps/remi/main.ts") },
    }),
  });
  harnesses.push(h);
  evidenceDirectory = join(h.root, "probe-evidence");
  if (provider === "codex") {
    // This credential only clears the daemon's native-auth preflight. The
    // fixture never contacts a model or uses a real provider credential.
    process.env.CODEX_HOME = join(h.root, "codex-fixture");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    writeFileSync(join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt", tokens: { access_token: "ppe-fixture-only" },
    }), { mode: 0o600 });
  }
  await h.startDaemon();
  await h.settleHeartbeat();
  const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
  const agent = h.store.createAgent({ name: "Chat probe", provider, runtimeId, customEnv: { PPE_ACP_PAUSE: "after-read" } });
  const chat = h.store.createChatSession({ agentId: agent.id });
  const send = (body: string, wake: "now" | "next_turn" = "now") => h.store.sendMessage({
    session_id: chat.id, sender: { type: "member", id: "mem_local_local" },
    to: { type: "agent", ref: agent.id }, message_kind: "request", wake_requested: wake, body_md: body,
  });
  const records = (attemptId: string): any[] => existsSync(evidenceDirectory)
    ? readdirSync(evidenceDirectory).filter(name => name.startsWith(attemptId + "-") && name.endsWith(".jsonl"))
      .flatMap(name => readFileSync(join(evidenceDirectory, name), "utf8").trim().split("\n").map(line => JSON.parse(line)))
    : [];
  const finish = async (sent: SendMessageResult) => {
    await waitFor(() => ["completed", "failed"].includes(h.store.getTurn(sent.turn_id!)?.status ?? ""), "Chat terminal report", 20_000);
    const turn = h.store.getTurn(sent.turn_id!)!;
    const attempt = h.store.getTask(turn.current_attempt_id!)!;
    expect({ status: turn.status, error: attempt.error }).toEqual({ status: "completed", error: null });
    const reply = h.store.getMessage(turn.reply_message_id!)!;
    expect(reply.body_md).toStartWith("PPE_PROBE_EVIDENCE ");
    const evidence = JSON.parse(reply.body_md.slice("PPE_PROBE_EVIDENCE ".length));
    expect(evidence).toMatchObject({ boundary: "real daemon + test provider", turn_id: turn.id, attempt_id: attempt.id });
    const reads = records(attempt.id).filter(row => row.event === "actual_read");
    expect(reads).toHaveLength(evidence.reads.length);
    const last = evidence.reads.at(-1);
    const receipt = h.store.listTurnAttempts(turn.id).find(row => row.id === attempt.id)!;
    expect(receipt).toMatchObject({ input_read_seq: last.to_seq, input_read_offset: 0, input_ack_seq: last.to_seq });
    expect(h.store.listMessages(chat.id, { unread_by: agent.id })).toEqual([]);
    await h.settleHeartbeat();
    return { turn, attempt, evidence, observed: evidence.reads.flatMap((read: any) => read.messages) as any[] };
  };
  return { h, agent, chat, send, finish, records };
}

function assertRead(observed: any[], message: { id: string; seq: number; body_md: string }) {
  const receipt = observed.filter(row => row.message_id === message.id);
  expect(receipt).toEqual([{ message_id: message.id, seq: message.seq,
    markers: [message.body_md.split("\n")[0]], body_sha256: digest(message.body_md), read_count: 1 }]);
}

for (const provider of ["claude", "codex"] as const) test(`real daemon running ${provider} Chat consumes now input after an actual read`, async () => {
  const f = await world(provider);
  const first = f.send("MUL-493/PROBE/running-first");
  const attemptId = f.h.store.getTurn(first.turn_id!)!.current_attempt_id!;
  await waitFor(() => {
    if (f.h.store.getTask(attemptId)?.status === "failed") throw new Error(f.h.store.getTask(attemptId)!.error!);
    return f.records(attemptId).some(row => row.event === "paused" && row.stage === "after-read");
  }, "after-read pause", 15_000);
  const paused = f.records(attemptId).find(row => row.event === "paused" && row.stage === "after-read");
  expect(f.h.store.getTurn(first.turn_id!)!.status).toBe("running");
  const injected = f.send("MUL-493/PROBE/running-injected");
  expect(injected.turn_id).toBe(first.turn_id);
  await waitFor(() => f.h.store.getTask(attemptId)!.projectionToSeq! >= injected.message.seq, "offered injected head", 10_000);
  writeFileSync(paused.control_file, "after-read");
  await waitFor(() => {
    for (const row of f.records(attemptId).filter(row => row.event === "paused")) writeFileSync(row.control_file, row.stage);
    return ["completed", "failed"].includes(f.h.store.getTurn(first.turn_id!)?.status ?? "");
  }, "terminal", 20_000);
  const turn = f.h.store.getTurn(first.turn_id!)!;
  const attempt = f.h.store.getTask(attemptId)!;
  const reply = f.h.store.getMessage(turn.reply_message_id!)!;
  const receipt: any = f.h.store.listTurnAttempts(turn.id).find(row => row.id === attemptId)!;
  console.log("B3_LOCAL_EVIDENCE " + JSON.stringify({ turn_id: turn.id, attempt_id: attempt.id,
    accepted_at: f.h.store.listTurnAttempts(turn.id)[0]!.accepted_at, prompt_count: prompts.mock.calls.length, status: turn.status, error: attempt.error,
    input_read_seq: receipt.input_read_seq, input_read_offset: receipt.input_read_offset, input_ack_seq: receipt.input_ack_seq,
    events: f.records(attemptId).sort((a, b) => a.at.localeCompare(b.at)), reply_id: reply.id, final_reply: reply.body_md }));
  const result = await f.finish(first);
  assertRead(result.observed, first.message);
  assertRead(result.observed, injected.message);
  const events = f.records(attemptId).sort((a, b) => a.at.localeCompare(b.at));
  const deliveries = events.filter(row => row.event === "provider_input");
  const cancellations = events.filter(row => row.event === "provider_cancelled");
  expect(deliveries).toHaveLength(2);
  expect(cancellations).toHaveLength(1);
  expect(deliveries[1].provider_session_id).toBe(deliveries[0].provider_session_id);
  expect(cancellations[0].at <= deliveries[1].at).toBe(true);
  expect(f.h.store.listTurns({ workspace_id: "local", session_id: f.chat.id })).toHaveLength(1);
}, 45_000);
