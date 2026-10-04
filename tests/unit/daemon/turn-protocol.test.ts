import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonTaskDownlinks } from "@multiremi/worker/daemon-downlinks.js";
import { DaemonProtocolRpcError, type DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";
import { outboxRecordFrame } from "@multiremi/worker/report-frames.js";
import { MultiremiDaemonClient } from "@multiremi/worker/client.js";
import { captureReports, reportFrame } from "../../fixtures/report-session.js";
import { createLocalStore, resetMultiremiTestEnv } from "../multiremi/helpers.js";
import type { UnifiedMessage } from "@multiremi/contracts/unified-model.js";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";
import { normalizeDaemonTurnOffer } from "@multiremi/worker/daemon-offers.js";
import { daemonTurnOfferPayload } from "@multiremi/api/daemon-protocol/task-offers.js";
import { checkHandshakeVersion } from "@multiremi/api/daemon-protocol/handshake.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import type { DaemonTurnBridge } from "@multiremi/api/daemon-protocol/turn-bridge.js";
import { taskInputSnapshot } from "@multiremi/api/daemon-protocol/task-input-snapshot.js";

const turn = { turn_id: "turn_one", attempt_id: "tsk_one", input_from_seq: 0, input_to_seq: 1, input_messages: [] };
const message = (seq: number, extra: Partial<UnifiedMessage> = {}): UnifiedMessage => ({
  id: `msg_${seq}`, kind: "message", seq, session_id: "ises_one", body_md: `input ${seq}`,
  sender_type: "member", sender_id: "member_one", message_kind: "request", metadata: {},
  created_at: "2026-10-04T00:00:00Z", ...extra,
} as UnifiedMessage);

function downlinks() {
  const handlers = new Map<string, (frame: any) => void>();
  const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let failure: Error | null = null;
  const peer = {
    registerFrameHandler: (type: string, handler: (frame: any) => void) => handlers.set(type, handler),
    connectionState: () => "connected",
    rpc: async (type: string, payload: Record<string, unknown>) => {
      calls.push({ type, payload }); if (failure) throw failure; return { ok: true };
    },
  } as unknown as DaemonProtocolClient;
  const inbox = new DaemonTaskDownlinks(peer, () => "rt_one");
  inbox.bindTurn(turn);
  const push = (seq: number, override: Record<string, unknown> = {}) => handlers.get("turn.message")!({
    rt: "rt_one", payload: { turn_id: turn.turn_id, attempt_id: turn.attempt_id, message: message(seq), ...override },
  });
  const wrap = (at = "2026-10-04T01:00:00Z") => handlers.get("turn.wrap_up")!({ rt: "rt_one",
    payload: { turn_id: turn.turn_id, attempt_id: turn.attempt_id, requested_at: at } });
  return { inbox, calls, handlers, push, wrap, fail: (value: Error | null) => { failure = value; } };
}

describe("unified turn input", () => {
  it("rejects the 0.2.85 daemon while admitting the payload release and newer versions", () => {
    expect(checkHandshakeVersion({ protocol: 2, cli_version: "0.2.85" })).toMatchObject({ code: 4426, errorCode: "daemon_cli_upgrade_required" });
    expect(checkHandshakeVersion({ protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION })).toBeNull();
    expect(checkHandshakeVersion({ protocol: 2, cli_version: `${Number(DAEMON_MIN_CLI_VERSION.split(".")[0]) + 1}.0.0` })).toBeNull();
  });
  it("publishes the new offer without id/prompt and refuses claims missing canonical input", () => {
    expect(daemonTurnOfferPayload({ id: "tsk_one", prompt: "old", runtime_id: "rt_one" }, turn)).toEqual({ ...turn, runtime_id: "rt_one" });
    expect(() => daemonTurnOfferPayload({}, {} as typeof turn)).toThrow("unified turn offer context missing");
  });
  it("orders and deduplicates messages, rejects foreign attempts and advances only confirmed input", async () => {
    const h = downlinks();
    h.push(3); h.push(2); h.push(2);
    h.push(4, { attempt_id: "tsk_foreign" }); h.push(4, { turn_id: "turn_foreign" });
    expect(h.inbox.pendingTaskSteerMessages("tsk_one").map(m => m.id)).toEqual(["msg_2", "msg_3"]);
    await expect(h.inbox.consumeTaskSteerMessages("tsk_one", ["msg_3"])).rejects.toThrow("unconfirmed turn input gap");
    expect(h.calls).toHaveLength(0);
    h.fail(new DaemonProtocolRpcError("server_error", true));
    await expect(h.inbox.consumeTaskSteerMessages("tsk_one", ["msg_2", "msg_3"])).rejects.toThrow();
    expect(h.inbox.turnInput("tsk_one").input_to_seq).toBe(1);
    expect(h.inbox.pendingTaskSteerMessages("tsk_one")).toHaveLength(2);
    h.fail(null);
    await h.inbox.consumeTaskSteerMessages("tsk_one", ["msg_2", "msg_3"]);
    expect(h.calls.at(-1)).toEqual({ type: "turn.input", payload: {
      turn_id: "turn_one", attempt_id: "tsk_one", input_to_seq: 3, message_ids: ["msg_2", "msg_3"],
    } });
    h.push(2); h.push(3);
    expect(h.inbox.pendingTaskSteerMessages("tsk_one")).toEqual([]);
    expect(h.inbox.turnInput("tsk_one").input_to_seq).toBe(3);
  });

  it("keeps a canonical range hint when expiry returns the answer before its WS projection", async () => {
    const h = downlinks();
    h.inbox.beginDecision("tsk_one");
    h.inbox.registerDecision(message(2, { id: "decision_one", message_kind: "decision", sender_type: "agent" }), "tsk_one");
    h.inbox.confirmDecisionReply("tsk_one", message(4, { id: "reply_one", reply_to_id: "decision_one" }));
    h.inbox.finishDecision("tsk_one");
    const pending = h.inbox.pendingTaskSteerMessages("tsk_one");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.content).toContain("remi message list");
    expect(pending[0]!.content).not.toContain("remi session log get");
    await expect(h.inbox.consumeTaskSteerMessages("tsk_one", [])).rejects.toThrow("unconfirmed turn input gap");
    expect(h.inbox.turnInput("tsk_one").input_to_seq).toBe(1);
  });

  it("delivers wrap-up once as a control and keeps the message cursor unchanged", async () => {
    const h = downlinks(); let interrupted = 0;
    h.inbox.subscribeTaskSteerMessages("tsk_one", () => interrupted++);
    h.wrap(); h.wrap();
    const controls = h.inbox.pendingTaskSteerMessages("tsk_one");
    expect(controls).toHaveLength(1);
    expect(controls[0]!.kind).toBe("force_answer");
    expect(interrupted).toBe(1);
    await h.inbox.consumeTaskSteerMessages("tsk_one", [controls[0]!.id]);
    h.wrap();
    expect(h.inbox.pendingTaskSteerMessages("tsk_one")).toEqual([]);
    expect(h.inbox.turnInput("tsk_one").input_to_seq).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.handlers.has("task.steer")).toBe(false);
  });

  it("matches decision replies by message id, including replies racing the create response", async () => {
    const h = downlinks();
    let interrupted = 0;
    h.inbox.subscribeTaskSteerMessages("tsk_one", () => interrupted++);
    h.inbox.beginDecision("tsk_one");
    h.push(2, { message: message(2, { reply_to_id: "decision_one", body_md: "free text" }) });
    h.inbox.registerDecision(message(1, { id: "decision_one", message_kind: "decision" }), "tsk_one");
    const reply = await h.inbox.waitForDecisionReply("decision_one", new AbortController().signal, 100);
    expect(reply).toMatchObject({ id: "msg_2", body_md: "free text", reply_to_id: "decision_one" });
    h.inbox.confirmDecisionReply("tsk_one", reply!);
    h.inbox.finishDecision("tsk_one");
    expect(interrupted).toBe(0);
    expect(h.inbox.pendingTaskSteerMessages("tsk_one")).toEqual([]);
    await h.inbox.consumeTaskSteerMessages("tsk_one", []);
    expect(h.calls.at(-1)?.payload).toMatchObject({ input_to_seq: 2, message_ids: ["msg_2"] });
    const aborted = AbortSignal.abort();
    expect(await h.inbox.waitForDecisionReply("decision_other", aborted, 100)).toBeNull();
  });
  it("keeps an answered decision behind earlier unconfirmed input", async () => {
    const h = downlinks();
    h.inbox.registerDecision(message(1, { id: "decision_one", message_kind: "decision" }), "tsk_one");
    h.push(2); h.push(3, { message: message(3, { reply_to_id: "decision_one" }) });
    const reply = await h.inbox.waitForDecisionReply("decision_one", new AbortController().signal, 100);
    h.inbox.confirmDecisionReply("tsk_one", reply!);
    await expect(h.inbox.consumeTaskSteerMessages("tsk_one", [])).rejects.toThrow("unconfirmed turn input gap");
    expect(h.calls).toEqual([]);
    await h.inbox.consumeTaskSteerMessages("tsk_one", ["msg_2"]);
    expect(h.inbox.turnInput("tsk_one").input_to_seq).toBe(3);
    expect(h.inbox.pendingTaskSteerMessages("tsk_one")).toEqual([]);
  });
  it("receipts the daemon's outgoing decision in seq order without skipping earlier input", async () => {
    const h = downlinks();
    h.push(2); h.inbox.beginDecision("tsk_one");
    h.inbox.registerDecision(message(3, { id: "decision_one", message_kind: "decision", sender_type: "agent" }), "tsk_one");
    h.push(4, { message: message(4, { reply_to_id: "decision_one" }) });
    const reply = await h.inbox.waitForDecisionReply("decision_one", new AbortController().signal, 100);
    h.inbox.confirmDecisionReply("tsk_one", reply!); h.inbox.finishDecision("tsk_one");
    await expect(h.inbox.consumeTaskSteerMessages("tsk_one", [])).rejects.toThrow("unconfirmed turn input gap");
    expect(h.calls).toEqual([]);
    await h.inbox.consumeTaskSteerMessages("tsk_one", ["msg_2"]);
    expect(h.calls).toEqual([{ type: "turn.input", payload: { turn_id: "turn_one", attempt_id: "tsk_one",
      input_to_seq: 4, message_ids: ["msg_2", "decision_one", "msg_4"] } }]);
    expect(h.inbox.turnInput("tsk_one").input_to_seq).toBe(4);
    expect(h.inbox.pendingTaskSteerMessages("tsk_one")).toEqual([]);
  });
});

const directories: string[] = [];
afterEach(() => { resetMultiremiTestEnv(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("turn completion reliability", () => {
  it("keeps the reply and both identities durable across restart, with the attempt as partition key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-outbox-")); directories.push(dir);
    const path = join(dir, "outbox.db");
    const reply = { body_md: "final **reply**", message_kind: "final" };
    const first = new MultiremiTaskReportOutbox({ path, canSend: () => false, deliver: async () => {} });
    first.enqueue("tsk_one", "turn.complete", { turn_id: "turn_one", input_to_seq: 3, reply, runtime_id: "rt_one" });
    expect(first.taskIdsWithPendingTerminal()).toEqual(["tsk_one"]);
    await first.close();
    const frames: ReturnType<typeof outboxRecordFrame>[] = [];
    const second = new MultiremiTaskReportOutbox({ path, deliver: async record => { frames.push(outboxRecordFrame(record)); } });
    try {
      expect(await second.waitForTaskDrain("tsk_one")).toBe("delivered");
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ t: "turn.complete", rt: "rt_one", p: {
        attempt_id: "tsk_one", turn_id: "turn_one", input_to_seq: 3, reply,
      } });
      expect(frames[0]!.p).not.toHaveProperty("task_id");
      expect(frames[0]!.p).not.toHaveProperty("output");
      expect(second.stats().pending).toBe(0);
    } finally { await second.close(); }
  });

  it("quarantines retired reports without retrying before or after restart", async () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ id: "rt_old", name: "old report", provider: "claude" });
    const dir = mkdtempSync(join(tmpdir(), "retired-outbox-")); directories.push(dir);
    const path = join(dir, "outbox.db"); let deliveries = 0;
    const deliver = async () => {
      deliveries++;
      const response = await reportFrame(store, "task.complete", { task_id: "old_attempt", output: "legacy" }, { runtimeId: runtime.id });
      expect(response).toMatchObject({ ok: false, code: "report_shape_retired", retryable: false });
      throw new DaemonProtocolRpcError(response.code, response.retryable);
    };
    const first = new MultiremiTaskReportOutbox({ path, deliver });
    try {
      first.enqueue("old_attempt", "complete", { runtime_id: runtime.id, output: "legacy" });
      expect(await first.waitForTaskDrain("old_attempt")).toBe("blocked");
      expect(deliveries).toBe(1);
      expect(first.stats()).toMatchObject({ blocked: 1, pending: 0 });
      await first.close();
      const second = new MultiremiTaskReportOutbox({ path, deliver });
      try {
        second.pumpAll();
        expect(await second.waitForTaskDrain("old_attempt")).toBe("blocked");
        expect(deliveries).toBe(1);
        expect(second.stats()).toMatchObject({ blocked: 1, pending: 0 });
      } finally { await second.close(); }
    } finally { await first.close(); }
  });

  it("reports a final message through turn.complete and waits for the durable acknowledgement", async () => {
    const client = new MultiremiDaemonClient("http://fixture");
    const calls = captureReports(client);
    await client.completeTurn({ turn_id: "turn_one", attempt_id: "tsk_one", input_to_seq: 3 }, "final answer", "native_one", "/work");
    expect(calls).toEqual([{ type: "turn.complete", partition: "tsk_one", wait: true, payload: {
      turn_id: "turn_one", attempt_id: "tsk_one", input_to_seq: 3,
      reply: { body_md: "final answer", message_kind: "final" }, session_id: "native_one", work_dir: "/work",
    } }]);
  });
});

describe("unified store transport boundary", () => {
  const bridge = (overrides: Partial<DaemonTurnBridge> = {}): DaemonTurnBridge => ({
    offerInput: () => turn, snapshot: () => ({ messages: [], wrapUps: [] }),
    rpc: () => ({ ok: true }), complete: () => ({ ok: true }), ...overrides,
  });
  it("uses the Store bridge by default and rejects unbound attempts without retrying", async () => {
    const store = createLocalStore();
    const rt = store.registerRuntime({ id: "rt_boundary", name: "boundary", provider: "claude" });
    const payload = { turn_id: "turn_one", attempt_id: "tsk_one", input_to_seq: 1, reply: { body_md: "reply", message_kind: "final" } };
    expect(await reportFrame(store, "turn.complete", payload, { runtimeId: rt.id })).toMatchObject({ ok: false, code: "stale_attempt", retryable: false });
    expect(await reportFrame(store, "turn.input", { ...turn, message_ids: [] }, { runtimeId: rt.id })).toMatchObject({ ok: false, code: "stale_attempt", retryable: false });
    expect(await reportFrame(store, "turn.complete", { ...payload, output: "old" }, { runtimeId: rt.id })).toMatchObject({ ok: false, code: "invalid_report", retryable: false });
  });
  it("passes validated input and decisions to a runtime-scoped store boundary", async () => {
    const store = createLocalStore();
    const rt = store.registerRuntime({ id: "rt_boundary", name: "boundary", provider: "claude" });
    const calls: unknown[] = [];
    const turns = bridge({ rpc: (type, payload, scope) => { calls.push({ type, payload, scope }); return { ok: true, message: message(2, { message_kind: "decision" }) }; } });
    const input = { turn_id: "turn_one", attempt_id: "tsk_one", input_to_seq: 2, message_ids: ["msg_2"] };
    expect(await reportFrame(store, "turn.input", input, { runtimeId: rt.id, turns })).toMatchObject({ ok: true });
    const decision = { turn_id: "turn_one", attempt_id: "tsk_one", body_md: "Pick", dedupe_key: "question:one", options: [{ label: "A", value: "a" }], metadata: {} };
    expect(await reportFrame(store, "turn.decision", decision, { runtimeId: rt.id, turns })).toMatchObject({ ok: true, message: { message_kind: "decision" } });
    expect(calls).toEqual([
      { type: "turn.input", payload: input, scope: { runtimeId: rt.id, daemonId: "fixture-reports", workspaceId: "local" } },
      { type: "turn.decision", payload: decision, scope: { runtimeId: rt.id, daemonId: "fixture-reports", workspaceId: "local" } },
    ]);
    expect(await reportFrame(store, "turn.input", { ...input, input_to_seq: -1 }, { runtimeId: rt.id, turns })).toMatchObject({ ok: false, code: "invalid_report" });
    expect(await reportFrame(store, "turn.decision", { ...decision, task_id: "old" }, { runtimeId: rt.id, turns })).toMatchObject({ ok: false, code: "invalid_report" });
    expect(calls).toHaveLength(2);
  });
  it("routes permission decisions through the bridge without reading or writing retired human requests", async () => {
    const store = createLocalStore();
    const rt = store.registerRuntime({ id: "rt_permission", name: "permission", provider: "claude" });
    const legacyWrite = spyOn(store, "createTaskHumanRequest");
    const legacyRead = spyOn(store, "getTaskHumanRequest");
    const calls: unknown[] = [];
    const turns = bridge({ rpc: (type, payload, scope) => {
      calls.push({ type, payload, scope });
      return { ok: true, message: message(2, { message_kind: "decision", metadata: payload.metadata as Record<string, unknown> }),
        status: "awaiting_human" };
    } });
    try {
      const payload = { turn_id: "turn_one", attempt_id: "tsk_one", body_md: "Allow tool?", dedupe_key: "permission:one",
        options: [{ label: "Allow once", value: "allow", description: "allow_once" }], metadata: { kind: "permission" } };
      expect(await reportFrame(store, "turn.decision", payload, { runtimeId: rt.id, turns })).toMatchObject({
        ok: true, message: { message_kind: "decision", metadata: { kind: "permission" } }, status: "awaiting_human",
      });
      expect(calls).toEqual([{ type: "turn.decision", payload,
        scope: { runtimeId: rt.id, daemonId: "fixture-reports", workspaceId: "local" } }]);
      expect(legacyWrite).not.toHaveBeenCalled(); expect(legacyRead).not.toHaveBeenCalled();
    } finally { legacyWrite.mockRestore(); legacyRead.mockRestore(); }
  });
  it("closes the attempt trace only after the atomic completion barrier accepts the reply", async () => {
    const store = createLocalStore();
    const rt = store.registerRuntime({ id: "rt_boundary", name: "boundary", provider: "claude" });
    const closed: string[] = []; const completions: unknown[] = [];
    let pending = true;
    const turns = bridge({ complete: (input, scope) => {
      completions.push({ input, scope });
      return pending ? { ok: false, code: "turn_input_pending", retryable: false } : { ok: true, reply_message_id: "msg_final" };
    } });
    const payload = { turn_id: "turn_one", attempt_id: "tsk_one", input_to_seq: 3,
      reply: { body_md: "final", message_kind: "final" }, trace: { head: 0, event_count: 0, tool_call_count: 0, closed: true, type_histogram: [] },
      final_reply_md: "stale card text", model: { provider: "claude", model: "fixture" } };
    const options = { runtimeId: rt.id, turns, onTraceClosed: (id: string) => { closed.push(id); } };
    expect(await reportFrame(store, "turn.complete", payload, options)).toMatchObject({ ok: false, code: "turn_input_pending" });
    expect(closed).toEqual([]);
    pending = false;
    expect(await reportFrame(store, "turn.complete", payload, options)).toMatchObject({ ok: true, reply_message_id: "msg_final" });
    expect(closed).toEqual(["tsk_one"]);
    expect(completions[1]).toMatchObject({ input: { payload, completionFields: { final_reply_md: "final" }, traceEventCount: 0 },
      scope: { runtimeId: rt.id, daemonId: "fixture-reports", workspaceId: "local" } });
  });
  it("reconstructs separate message and wrap-up entities without advancing the input cursor", () => {
    const store = createLocalStore();
    const rt = store.registerRuntime({ id: "rt_boundary", name: "boundary", provider: "claude" });
    const turns = bridge({ snapshot: () => ({ messages: [{ turn_id: "turn_one", attempt_id: "tsk_one", message: message(2) }],
      wrapUps: [{ turn_id: "turn_one", attempt_id: "tsk_one", requested_at: "2026-10-04T01:00:00Z" }] }) });
    const snapshot = taskInputSnapshot(store, rt.id, "fixture-reports", new Set(), () => {}, turns);
    expect(snapshot.map(entity => entity.type)).toEqual(["turn.message", "turn.wrap_up"]);
    expect(snapshot.every(entity => !entity.claimed)).toBe(true);
    expect(snapshot[0]!.key).toBe("turn.message:tsk_one:msg_2");
  });
});

it("renders message-range input and canonical inbox/message/turn guidance", () => {
  const task = normalizeDaemonTurnOffer({ ...turn, input_to_seq: 3, input_messages: [message(2), message(3)],
    issue_id: "iss_one", issue_session_id: "ises_one", issue: { id: "iss_one", key: "UNIT-1", title: "unit", metadata: {} },
    session_projection: { mode: "bootstrap", session_id: "ises_one", jsonl: '{"type":"session_projection"}\n{"type":"inbox_toc","entries":[{"id":"msg_2","seq":2,"priority":1,"folded":true,"title":"input","chars":8}]}' },
    squad_context: { id: "sq_one", name: "team", leaderAgentId: "agt_one", members: [{ agentId: "agt_other", name: "other" }] },
    agent_id: "agt_one", agent: { id: "agt_one", name: "unit", provider: "claude", skills: [] } });
  const prompt = buildTaskPrompt(task);
  expect(prompt).toContain("Turn: turn_one; attempt: tsk_one; input seq (0, 3].");
  expect(prompt).toContain("input 2"); expect(prompt).toContain("input 3");
  expect(prompt).toContain("remi message get msg_2"); expect(prompt).toContain("remi inbox read");
  expect(prompt).toContain("remi message send ises_one --to agt_other --kind request");
  expect(prompt).not.toMatch(/remi (?:task (?:create|continue|steer)|comment |session (?:task |log ))/);
});
