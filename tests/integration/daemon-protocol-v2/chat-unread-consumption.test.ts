import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AcpProvider } from "@acp/index.js";
import { AcpClient } from "@acp/client.js";
import type { SendMessageResult } from "@multiremi/contracts/unified-model.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const harnesses: DaemonProtocolHarness[] = [];
let resume: ReturnType<typeof spyOn<AcpClient, "resumeSession">>;
afterEach(async () => {
  try { for (const h of harnesses.splice(0)) await h.dispose(); }
  finally { resume?.mockRestore(); }
});
const repository = resolve(import.meta.dir, "../../..");
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

async function world() {
  resume = spyOn(AcpClient.prototype, "resumeSession");
  let evidenceDirectory: string;
  const h = await DaemonProtocolHarness.create({
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
  await h.startDaemon();
  await h.settleHeartbeat();
  const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
  const agent = h.store.createAgent({ name: "Chat probe", provider: "claude", runtimeId });
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

test("real daemon warm Chat consumes both consecutive requests with actual ACP receipts", async () => {
  const f = await world();
  const first = f.send("MUL-493/PROBE/warm-first\nFirst request");
  const cold = await f.finish(first);
  assertRead(cold.observed, first.message);
  expect(cold.attempt.projectionMode).toBe("bootstrap");
  expect(resume).not.toHaveBeenCalled();
  const cursor = f.h.store.getSessionAgentReadProgress(f.chat.id, f.agent.id).seq;

  const second = f.send("MUL-493/PROBE/warm-second\nSecond request");
  const warm = await f.finish(second);
  expect(warm.attempt.projectionMode).toBe("delta");
  expect(warm.attempt.projectionFromSeq).toBe(cursor);
  expect(warm.attempt.projectionToSeq).toBeGreaterThan(cursor);
  expect(warm.evidence.provider_session_id).toBe(cold.evidence.provider_session_id);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume.mock.calls[0]![0]).toBe(cold.evidence.provider_session_id);
  assertRead(warm.observed, second.message);
  expect(warm.observed.some(row => row.message_id === first.message.id)).toBe(false);
}, 45_000);

test("real daemon warm Chat consumes edited next_turn and never consumes the deleted request", async () => {
  const f = await world();
  await f.finish(f.send("MUL-493/PROBE/queue-bootstrap"));
  const cursor = f.h.store.getSessionAgentReadProgress(f.chat.id, f.agent.id).seq;
  const queued = f.send("MUL-493/PROBE/before-edit", "next_turn");
  const deleted = f.send("MUL-493/PROBE/deleted", "next_turn");
  f.h.store.editMessage(queued.message.id, { body_md: "MUL-493/PROBE/after-edit\nSaved request" });
  f.h.store.deleteMessage(deleted.message.id);
  const saved = f.h.store.getMessage(queued.message.id)!;
  expect(f.h.store.listTurns({ workspace_id: "local", session_id: f.chat.id }).filter(turn => turn.status === "pending")).toEqual([]);
  f.h.store.updateAgent(f.agent.id, { customEnv: { PPE_ACP_PAUSE: "before-read" } });
  const trigger = f.send("MUL-493/PROBE/queue-trigger");
  const attemptId = f.h.store.getTurn(trigger.turn_id!)!.current_attempt_id!;
  await waitFor(() => f.records(attemptId).some(row => row.event === "paused"), "ACP before-read pause", 15_000);
  expect(f.records(attemptId).filter(row => row.event === "actual_read")).toEqual([]);
  const paused = f.records(attemptId).find(row => row.event === "paused");
  writeFileSync(paused.control_file, "before-read");
  const warm = await f.finish(trigger);
  expect(warm.attempt.projectionMode).toBe("delta");
  expect(warm.attempt.projectionFromSeq).toBe(cursor);
  expect(resume).toHaveBeenCalledTimes(1);
  assertRead(warm.observed, saved);
  assertRead(warm.observed, trigger.message);
  expect(warm.observed.some(row => row.message_id === deleted.message.id)).toBe(false);
  expect(JSON.stringify(warm.observed)).not.toContain("MUL-493/PROBE/before-edit");
  expect(JSON.stringify(warm.observed)).not.toContain("MUL-493/PROBE/deleted");
}, 45_000);
