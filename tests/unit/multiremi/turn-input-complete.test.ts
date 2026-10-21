import { expect, it, describe } from "bun:test";
import type { ConversationLogEntry } from "@multiremi/contracts/conversation-log.js";
import { parseUnreadRange, splitProjectedInput } from "@multiremi/contracts/session-input.js";
import { taskSessionInput, unreadInputInline } from "@multiremi/store/task-session-input.js";
import { fitTaskOfferToBudget } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

const AGENT = "agt_reader";

function entry(seq: number, overrides: Partial<ConversationLogEntry> = {}): ConversationLogEntry {
  return { session_id: "ses", seq, id: `e${seq}`, kind: "message", visibility: "shown", author_type: "member",
    author_id: "mem_alice", task_id: null, body_md: `body ${seq}`, body_html: null, render_version: null, parent_id: null,
    resolved_at: null, resolved_by_type: null, resolved_by_id: null, metadata: {}, revision: 1,
    created_at: "2026-10-17T00:00:00.000Z", updated_at: "2026-10-17T00:00:00.000Z", deleted_at: null, ...overrides };
}

function complete(entries: ConversationLogEntry[], triggers: number[], fromSeq = 0, toSeq = entries.at(-1)?.seq ?? 0, readSeq?: number) {
  return unreadInputInline({ agentId: AGENT, fromSeq, toSeq, readSeq, entries, triggerSeqs: new Set(triggers) });
}

describe("complete unread input", () => {
  it("is complete when every unread entry is an inline trigger", () => {
    expect(complete([entry(1, { body_md: "你好" })], [1])).toBe(true);
    // Coalesced messages, several human authors and another agent's request are all inline triggers.
    expect(complete([entry(1), entry(2, { author_id: "mem_bob" }), entry(3, { author_type: "agent", author_id: "agt_peer" })], [1, 2, 3])).toBe(true);
    // A cold start reads from 0; the reader's own history never needs a read, hidden and deleted rows are not unread.
    expect(complete([entry(1), entry(2, { author_type: "agent", author_id: AGENT, kind: "turn" }),
      entry(3, { visibility: "hidden", kind: "task_completed" }), entry(4, { deleted_at: "2026-10-17T00:00:00.000Z" }), entry(5)], [1, 5])).toBe(true);
    // An agent-authored trigger from the reader itself is its own words, not unread content.
    expect(complete([entry(1, { author_type: "agent", author_id: AGENT })], [])).toBe(true);
  });

  it("is incomplete when any unread entry is folded or not inline", () => {
    expect(complete([entry(1, { body_md: "x".repeat(8_001) })], [1])).toBe(false);
    expect(complete([entry(1, { body_md: "x".repeat(8_000) })], [1])).toBe(true);
    // Non-trigger unread: a message for another agent, or a peer's turn row and reply.
    expect(complete([entry(1), entry(2)], [2])).toBe(false);
    expect(complete([entry(1, { author_type: "agent", author_id: "agt_peer", kind: "turn" }), entry(2)], [2])).toBe(false);
    // An agent-authored message that is not addressed as a trigger still needs its read.
    expect(complete([entry(1, { author_type: "agent", author_id: "agt_peer" }), entry(2)], [2])).toBe(false);
    // An empty-bodied non-trigger is still not inline.
    expect(complete([entry(1, { body_md: "" }), entry(2)], [2])).toBe(false);
  });

  it("ignores entries outside the range and entries this reader has already read", () => {
    expect(complete([entry(1), entry(2), entry(3)], [3], 2, 3)).toBe(true);
    expect(complete([entry(1), entry(2), entry(3)], [3], 0, 3, 2)).toBe(true);
    expect(complete([entry(1), entry(2), entry(3)], [2], 1, 2)).toBe(true);
    expect(complete([entry(1), entry(2), entry(3)], [3], 0, 3, 1)).toBe(false);
  });

  it("marks only a complete range record and leaves an incomplete one unchanged", () => {
    const entries = [entry(1)];
    const input = { sessionId: "ses", agentId: AGENT, fromSeq: 0, toSeq: 1, entries, triggerSeqs: new Set([1]), coldStart: true };
    const plain = taskSessionInput(input);
    expect(taskSessionInput({ ...input, complete: false })).toBe(plain);
    const marked = taskSessionInput({ ...input, complete: true });
    expect(parseUnreadRange(marked.split("\n")[0])).toMatchObject({ unread_count: 1, complete: true });
    expect(marked.split("\n")[0]).toBe(plain.split("\n")[0]!.replace(/}$/, ',"complete":true}'));
    expect(marked.split("\n").slice(1)).toEqual(plain.split("\n").slice(1));
  });

  it("drops a complete mark once the offer budget folds a body under it", () => {
    const record = (complete: boolean) => JSON.stringify({ type: "unread_range", session_id: "ses", from_seq: 0, to_seq: 1, unread_count: 1,
      instruction: "read", ...(complete ? { complete: true } : {}) });
    const body = "大".repeat(7_000);
    const response = { id: "tsk", session_projection: { session_id: "ses", jsonl: [record(true), JSON.stringify({ type: "triggering_message", seq: 1, id: "e1", body })].join("\n") },
      input_messages: [{ id: "e1", seq: 1, body_md: `${record(true)}\n${body}` }], filler: "x".repeat(600_000) };
    fitTaskOfferToBudget(response, "rt");
    // The projection's trigger was folded; the input body it duplicates is still whole.
    expect(response.session_projection.jsonl.split("\n")[0]).toBe(record(false));
    expect(response.input_messages[0]!.body_md).toBe(`${record(true)}\n${body}`);
    // Coalesced input too large for the offer is cut itself, and its range needs a read again.
    const many = { id: "tsk", input_messages: Array.from({ length: 80 }, (_, index) => ({ id: `e${index + 1}`, seq: index + 1,
      body_md: `${index ? "" : `${record(true)}\n`}${"长".repeat(7_000)}` })) };
    fitTaskOfferToBudget(many, "rt");
    expect(many.input_messages.some(message => message.body_md.includes("字没看"))).toBe(true);
    expect(splitProjectedInput(many.input_messages[0]!.body_md).range?.complete).toBeUndefined();
    const fits = { id: "tsk", session_projection: { session_id: "ses", jsonl: record(true) }, input_messages: [{ id: "e1", seq: 1, body_md: `${record(true)}\nhi` }] };
    fitTaskOfferToBudget(fits, "rt");
    expect(fits.session_projection.jsonl).toBe(record(true));
    expect(fits.input_messages[0]!.body_md).toBe(`${record(true)}\nhi`);
  });
});

pendingTurnBackendTests("plain turn input acknowledgement", fixture => {
  function setup() {
    const f = fixture();
    f.store.registerRuntime({ id: "rt_plain", daemonId: "daemon_plain", name: "Plain input", provider: "codex", workspaceId: "local" });
    const agent = f.store.createAgent({ name: "Plain reader", provider: "codex", runtimeId: "rt_plain" });
    const bridge = f.store.getDaemonTurnBridge();
    const scope = { workspaceId: "local", runtimeId: "rt_plain", daemonId: "daemon_plain" };
    const claim = () => {
      const attempt = f.store.claimTask("rt_plain")!;
      f.store.startTask(attempt.id);
      const offer = bridge.offerInput(f.store.getTaskWithAgent(attempt.id)!);
      return { attempt, offer, range: splitProjectedInput(offer.input_messages[0]!.body_md).range };
    };
    // What the daemon sends at completion: every offered input id, in seq order.
    const receipt = (offer: ReturnType<typeof claim>["offer"]) => ({ turn_id: offer.turn_id, attempt_id: offer.attempt_id,
      input_to_seq: offer.input_to_seq, message_ids: offer.input_messages.map(m => m.id) });
    return { ...f, agent, bridge, scope, claim, receipt };
  }
  const issueRequest = (f: ReturnType<typeof setup>, sessionId: string, body: string, to = f.agent.id, wake: "now" | "next_turn" = "now") =>
    f.store.sendMessage({ session_id: sessionId, sender: { type: "member", id: "mem_local_local" }, to: { type: "agent", ref: to },
      message_kind: "request", wake_requested: wake, body_md: body });

  it("acknowledges a complete Chat input without a range read", () => {
    const f = setup();
    const chat = f.store.createChatSession({ agentId: f.agent.id });
    f.store.sendChatMessage(chat.id, { body: "你好" });
    const { offer, range } = f.claim();
    expect(range).toMatchObject({ from_seq: 0, unread_count: 1, complete: true });
    expect(splitProjectedInput(offer.input_messages[0]!.body_md).body).toBe("你好");
    const before = f.store.getSessionAgentReadProgress(chat.id, f.agent.id, offer.attempt_id);
    expect(before.seq).toBe(0);
    // No recordSessionAgentRangeRead: the inline trigger is the whole unread input.
    expect(f.bridge.rpc("turn.input", f.receipt(offer), f.scope)).toMatchObject({ ok: true, input_to_seq: offer.input_to_seq });
    expect(f.store.getTurn(offer.turn_id)?.input_to_seq).toBe(offer.input_to_seq);
    expect(f.store.getSessionAgentLane(chat.id, f.agent.id)!.cursorSeq).toBe(offer.input_to_seq);
    expect(f.bridge.complete({ payload: { turn_id: offer.turn_id, attempt_id: offer.attempt_id, input_to_seq: offer.input_to_seq,
      reply: { body_md: "你好！", message_kind: "final" }, session_id: "provider-1" }, completionFields: null }, f.scope).ok).toBe(true);

    // The warm second turn reads on from the cursor; the agent's own reply needs no read.
    f.store.sendChatMessage(chat.id, { body: "再说一遍" });
    const next = f.claim();
    expect(next.offer.input_from_seq).toBe(offer.input_to_seq);
    expect(next.range).toMatchObject({ unread_count: 1, complete: true });
    expect(f.bridge.rpc("turn.input", f.receipt(next.offer), f.scope).ok).toBe(true);
  });

  it("does not mark or acknowledge an Issue input that has unread context outside the triggers", () => {
    const f = setup();
    const other = f.store.createAgent({ name: "Other", provider: "codex" });
    const issue = f.store.createIssue({ title: "Context", assigneeType: "agent", assigneeId: f.agent.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    issueRequest(f, session.id, "for the other agent", other.id, "next_turn");
    issueRequest(f, session.id, "please do X");
    const { offer, range } = f.claim();
    expect(range).toMatchObject({ unread_count: 2 });
    expect(range!.complete).toBeUndefined();
    expect(f.bridge.rpc("turn.input", f.receipt(offer), f.scope).code).toBe("input_gap");
    f.store.recordSessionAgentRangeRead(session.id, f.agent.id, { seq: 1, offset: 0 }, { seq: offer.input_to_seq + 1, offset: 0 }, offer.attempt_id);
    expect(f.bridge.rpc("turn.input", f.receipt(offer), f.scope).ok).toBe(true);
  });

  it("marks a complete Issue trigger and keeps folded or foreign-scope input incomplete", () => {
    const f = setup();
    const issue = f.store.createIssue({ title: "Plain", assigneeType: "agent", assigneeId: f.agent.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    issueRequest(f, session.id, "please do X");
    const first = f.claim();
    expect(first.range?.complete).toBe(true);
    expect(f.bridge.rpc("turn.input", f.receipt(first.offer), f.scope).ok).toBe(true);
    expect(f.bridge.complete({ payload: { turn_id: first.offer.turn_id, attempt_id: first.offer.attempt_id, input_to_seq: first.offer.input_to_seq,
      reply: { body_md: "done", message_kind: "final" }, session_id: "provider-1" }, completionFields: null }, f.scope).ok).toBe(true);

    issueRequest(f, session.id, "y".repeat(9_000));
    const folded = f.claim();
    expect(folded.range?.complete).toBeUndefined();
    expect(f.bridge.rpc("turn.input", f.receipt(folded.offer), f.scope).code).toBe("input_gap");
  });

  it("marks a steer complete only when every message since the cursor is inline", () => {
    const f = setup();
    const other = f.store.createAgent({ name: "Other", provider: "codex" });
    const issue = f.store.createIssue({ title: "Steer", assigneeType: "agent", assigneeId: f.agent.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    issueRequest(f, session.id, "start");
    const { attempt } = f.claim();
    const steer = issueRequest(f, session.id, "改用中文输出");
    const pushed = f.bridge.snapshot(f.scope, new Set([attempt.id])).messages;
    expect(pushed.map(m => m.message.id)).toEqual([steer.message.id]);
    const steerRange = splitProjectedInput(pushed[0]!.message.body_md);
    expect(steerRange).toMatchObject({ range: { complete: true }, body: "改用中文输出" });

    issueRequest(f, session.id, "aside for the other agent", other.id, "next_turn");
    const later = issueRequest(f, session.id, "再加一句");
    const again = f.bridge.snapshot(f.scope, new Set([attempt.id])).messages;
    expect(again.map(m => m.message.id)).toEqual([steer.message.id, later.message.id]);
    expect(splitProjectedInput(again[0]!.message.body_md).range!.complete).toBeUndefined();
  });

  it("keeps a cold replacement's replayed original input incomplete", () => {
    const f = setup();
    const issue = f.store.createIssue({ title: "Replay", assigneeType: "agent", assigneeId: f.agent.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const sent = issueRequest(f, session.id, "original");
    const { offer } = f.claim();
    expect(f.bridge.rpc("turn.input", f.receipt(offer), f.scope).ok).toBe(true);
    const retried = f.store.retryTurn(sent.turn_id!, true);
    expect(f.store.claimTask("rt_plain")?.id).toBe(retried.current_attempt_id!);
    // A replacement whose own receipt starts past the original input replays it ahead of the range.
    f.db.run("UPDATE multiremi_turn_attempts SET input_ack_seq=?,input_read_seq=? WHERE id=?", [offer.input_to_seq, offer.input_to_seq, retried.current_attempt_id]);
    const replay = f.bridge.offerInput(f.store.getTaskWithAgent(retried.current_attempt_id!)!);
    const head = splitProjectedInput(replay.input_messages[0]!.body_md);
    expect(head.replay).toBe(true);
    expect(head.range!.complete).toBeUndefined();
  });
}, { isolation: "snapshot", file: import.meta.path });
