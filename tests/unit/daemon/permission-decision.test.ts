import { describe, expect, it } from "bun:test";
import { MultiremiDaemon, type MultiremiTaskProvider } from "@multiremi/worker/daemon.js";
import { DaemonProtocolRpcError } from "@multiremi/worker/daemon-protocol-client.js";
import type { MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";
import type { UnifiedMessage } from "@multiremi/contracts/unified-model.js";
import type { PermissionOutcome, RequestPermissionParams } from "@multiremi/contracts/acp-protocol.js";

const params: RequestPermissionParams = {
  sessionId: "provider_session",
  toolCall: { sessionUpdate: "tool_call_update", toolCallId: "tool_one", title: "Write file" },
  options: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "deny", name: "Reject", kind: "reject_once" },
  ],
};
const decision: UnifiedMessage = {
  id: "msg_decision", kind: "message", message_kind: "decision", session_id: "ises_one", seq: 1,
  visibility: "shown", task_id: "tsk_one", body_md: "Allow tool?", body_html: null, render_version: null,
  resolved_at: null, resolved_by_type: null, resolved_by_id: null, metadata: {}, revision: 1,
  created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z", deleted_at: null,
  sender_type: "agent", sender_id: "agent_one", to_type: "member", to_ref: "member_one",
  to_agent_id: null, to_member_id: "member_one", wake_requested: "inbox_only", wake_applied: "inbox_only",
  wake_reason: "requested_inbox_only", reply_to_id: null, dedupe_key: "permission:one", options: null,
  card_token_hash: null, card_token_recipient: null, card_token_consumed_at: null,
};
const answer = (optionId: string): UnifiedMessage => ({ ...decision, id: "msg_reply", seq: 2,
  reply_to_id: decision.id, message_kind: "reply", sender_type: "member", sender_id: "member_one",
  body_md: optionId, metadata: { option_id: optionId } });

function fixture(input: { reply?: UnifiedMessage | null; expiredReply?: UnifiedMessage; failure?: Error; abort?: boolean } = {}) {
  const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const trace: Array<Record<string, unknown>> = [];
  const confirmed: UnifiedMessage[] = [];
  const boundaries: string[] = [];
  const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon;
  const signal = input.abort ? AbortSignal.abort() : new AbortController().signal;
  Object.assign(daemon, {
    options: { approvalMode: "ask", humanRequestTimeoutMs: 1000, runtimeId: "rt_one" },
    pollAbort: new AbortController(),
    ensureTrace: () => ({ append: (_attempt: string, _runtime: string, events: Record<string, unknown>[]) => trace.push(...events) }),
    taskDownlinks: {
      beginDecision: () => boundaries.push("begin"), finishDecision: () => boundaries.push("finish"),
      turnInput: () => ({ turn_id: "turn_one", attempt_id: "tsk_one", input_to_seq: 1 }),
      rpc: async (type: string, payload: Record<string, unknown>) => {
        calls.push({ type, payload });
        if (input.failure) throw input.failure;
        return type === "turn.decision" ? { ok: true, message: decision } : { ok: true, reply: input.expiredReply };
      },
      registerDecision: (message: UnifiedMessage, attempt: string) => {
        expect(message).toBe(decision); expect(attempt).toBe("tsk_one");
      },
      waitForDecisionReply: async (id: string) => { expect(id).toBe(decision.id); return input.reply ?? null; },
      confirmDecisionReply: (attempt: string, reply: UnifiedMessage) => {
        expect(attempt).toBe("tsk_one"); confirmed.push(reply);
      },
    },
  });
  let handler!: (params: RequestPermissionParams) => Promise<PermissionOutcome>;
  const provider = { setPermissionHandler: (value: typeof handler) => { handler = value; } } as MultiremiTaskProvider;
  const attach = daemon as unknown as { attachHumanInputHandlers(provider: MultiremiTaskProvider,
    task: MultiremiTaskWithAgent, signal: AbortSignal, nextSeq: () => number): () => void };
  attach.attachHumanInputHandlers(provider, { id: "tsk_one" } as MultiremiTaskWithAgent, signal, () => 1);
  return { calls, trace, confirmed, boundaries, run: () => handler(params) };
}

describe("permission decision messages", () => {
  for (const optionId of ["allow", "deny"]) it(`returns the selected ${optionId} option and confirms its reply`, async () => {
    const reply = answer(optionId); const h = fixture({ reply });
    expect(await h.run()).toEqual({ outcome: "selected", optionId });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ type: "turn.decision", payload: {
      turn_id: "turn_one", attempt_id: "tsk_one", timeout_ms: 1000,
      body_md: "Permission requested: Write file",
      options: [{ label: "Allow once", value: "allow", description: "allow_once" },
        { label: "Reject", value: "deny", description: "reject_once" }],
      metadata: { decision_kind: "permission", session_id: params.sessionId, tool_call: params.toolCall, options: params.options },
    } });
    expect(h.calls[0]!.payload.dedupe_key).toMatch(/^permission:tsk_one:/);
    expect(h.calls[0]!.payload).not.toHaveProperty("task_id");
    expect(h.confirmed).toEqual([reply]);
    expect(h.boundaries).toEqual(["begin", "finish"]);
    expect(h.trace[0]).toMatchObject({ type: "permission_request", input: { message_id: decision.id } });
  });

  it("cancels an unknown option instead of granting permission", async () => {
    const h = fixture({ reply: answer("not_an_option") });
    expect(await h.run()).toEqual({ outcome: "cancelled" });
  });

  for (const abort of [false, true]) it(`expires an unanswered decision as ${abort ? "cancelled" : "timeout"}`, async () => {
    const h = fixture({ abort });
    expect(await h.run()).toEqual({ outcome: "cancelled" });
    expect(h.calls[1]).toMatchObject({ type: "turn.decision.expire", payload: {
      turn_id: "turn_one", attempt_id: "tsk_one", message_id: decision.id, status: abort ? "cancelled" : "timeout",
    } });
    expect(h.confirmed).toEqual([]);
    expect(h.boundaries).toEqual(["begin", "finish"]);
  });

  it("honors the reply that commits before expiry", async () => {
    const reply = answer("allow"); const h = fixture({ expiredReply: reply });
    expect(await h.run()).toEqual({ outcome: "selected", optionId: "allow" });
    expect(h.confirmed).toEqual([reply]);
  });

  it("cancels on bridge failure without using the retired channel", async () => {
    const h = fixture({ failure: new DaemonProtocolRpcError("server_error", true) });
    expect(await h.run()).toEqual({ outcome: "cancelled" });
    expect(h.calls.map(call => call.type)).toEqual(["turn.decision"]);
    expect(h.boundaries).toEqual(["begin", "finish"]);
  });
});
