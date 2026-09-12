import { afterEach, describe, expect, it } from "bun:test";
import { FeishuStreamingSession } from "@connectors/feishu/streaming.js";
import { FeishuChannel } from "@connectors/feishu/channel.js";
import { buildFinalCard } from "@connectors/feishu/streaming/card-elements.js";
import { compactModelName, formatCardStats, formatExecutionSubtitle } from "@connectors/feishu/card-metadata.js";
import { readContextUsage, readExecutionModel } from "@shared/agent-execution.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import { buildToolApprovalForm } from "@connectors/feishu/permission-ui.js";

const sessions: FeishuStreamingSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.detach(); });
const credentials = { appId: "cli_test", appSecret: "test-only" };

function harness() {
  const cards: any[] = [];
  const sends: any[] = [];
  const send = async (input: any) => {
    sends.push(input);
    cards.push(JSON.parse(input.data.content));
    return { code: 0, data: { message_id: "om_card" } };
  };
  const client = { request: async () => ({ code: 0, data: { cot_id: "cot_1", message_id: "om_native" } }), im: { message: { create: send, reply: send,
    patch: async (input: any) => { cards.push(JSON.parse(input.data.content)); return { code: 0 }; },
  } } };
  const channel = new FeishuChannel(credentials);
  (channel as any)._makeClient = () => client;
  channel.createStream = () => {
    const session = new FeishuStreamingSession(client as any, credentials, { log: () => {} });
    sessions.push(session);
    return session;
  };
  return { channel, cards, sends };
}

function event(seq: number, type: string, meta: Record<string, unknown>): TaskStreamEvent {
  return { kind: "message", message: { id: `msg_${seq}`, taskId: "tsk_card", seq, type,
    content: null, tool: null, input: null, output: null, toolCallId: null, status: null, meta,
    createdAt: "2026-09-08T00:00:00Z" } };
}

async function* stream(messages: TaskStreamEvent[], status: "completed" | "failed" | "cancelled" = "completed"): AsyncGenerator<TaskStreamEvent> {
  yield* messages;
  yield { kind: "snapshot", snapshot: {
    taskId: "tsk_card", status, result: "Answer", error: status === "failed" ? "Failed" : null,
    sessionId: "sess_same", workDir: "/chats/chat1",
    usage: [{ provider: "claude", model: "billing-model", inputTokens: 880000, outputTokens: 3000 }],
  } };
}

const meta = { taskId: "tsk_card", displayName: "Remi", respondHumanRequest: async () => { throw new Error("unexpected"); } };
const execution = event(1, "execution", { agentName: "Remi", provider: "claude", model: "claude-opus-5" });

describe("Feishu card execution identity and context", () => {
  it("formats compact one-line identities without changing the actual model id", () => {
    const info = { agentName: "Remi", provider: "acp:claude", model: "claude-opus-5" };
    expect(formatExecutionSubtitle(info)).toBe("Remi Claude opus5");
    expect(info.model).toBe("claude-opus-5");
    expect(compactModelName("fable-5-1")).toBe("fable51");
    expect(compactModelName("claude-opus-5-thinking")).toBe("opus5thinking");
    expect(formatExecutionSubtitle({ ...info, modelName: "Claude Opus 5" })).toBe("Remi Claude opus5");
    expect(formatExecutionSubtitle({ agentName: "Remi", provider: "codex" })).toBe("Remi Codex");
    const long = "custom-model-".repeat(50);
    const card = buildFinalCard({ text: "Answer", subtitle: formatExecutionSubtitle({ ...info, model: long }) }) as any;
    expect(card.header.subtitle.tag).toBe("plain_text");
    expect(card.header.subtitle.content).not.toContain("\n");
    expect(card.body.elements).toHaveLength(1);
  });

  it("reads selected model state, not effort or default placeholders", () => {
    expect(readExecutionModel({ id: "effort", value: "high" })).toBeNull();
    expect(readExecutionModel({ id: "model", value: "default" })).toEqual({ model: null, modelName: null });
    expect(readExecutionModel({ configOptions: [{ id: "model", currentValue: "m1", options: [
      { group: "Custom", options: [{ value: "m1", name: "Fable 51" }] },
    ] }] })).toEqual({ model: "m1", modelName: "Fable 51" });
  });

  it("uses only valid context snapshots, including zero and missing limits", () => {
    expect(readContextUsage({ usage: { used: 0, size: 200000 } })).toEqual({ used: 0, size: 200000 });
    expect(readContextUsage({ used: 82000, size: 200000, usage: { totalTokens: 883000 } }))
      .toEqual({ used: 82000, size: 200000 });
    for (const used of [-1, NaN, Infinity, "82000", null]) expect(readContextUsage({ used })).toBeNull();
    expect(readContextUsage({ totalTokens: 883000, inputTokens: 880000, outputTokens: 3000 })).toBeNull();
    expect(formatCardStats(54, { used: 82000, size: null }, 3)).toBe("54s · 82k/— · 3 tools");
    expect(formatCardStats(54, null, 3)).toBe("54s · 3 tools");
  });

  for (const status of ["completed", "failed", "cancelled"] as const) {
    it(`keeps latest context, identity and sender in a ${status} Task card`, async () => {
      const h = harness();
      await h.channel.handleTaskStream("oc_chat", "topic1", stream([
        execution,
        event(2, "usage", { used: 190000, size: 200000 }),
        event(3, "compaction", {}),
        event(4, "usage", { used: 82000, size: 200000 }),
        event(5, "usage", { used: 999, size: 1000, parent_tool_call_id: "subagent" }),
        event(6, "usage", { totalTokens: 883000 }),
      ], status), meta, { mentionOpenId: "ou_sender" });
      const final = h.cards.at(-1);
      expect(final.header.subtitle.content).toBe("Remi Claude opus5");
      expect(JSON.stringify(final)).toContain("82k/200k");
      expect(JSON.stringify(final)).not.toContain("883k");
      expect(JSON.stringify(final)).not.toContain("billingmodel");
      expect(final.body.elements.at(-1).columns[0].elements[0].content).toBe("<at id=ou_sender></at>");
      expect(h.sends).toHaveLength(1);
    });
  }

  it("clears context on model switches, and does not keep a stale upper limit", async () => {
    const h = harness();
    await h.channel.handleTaskStream("oc_chat", "topic1", stream([
      execution,
      event(2, "usage", { used: 190000, size: 200000 }),
      event(3, "execution", { model: "fable-5-1" }),
      event(4, "usage", { used: 0 }),
    ]), meta);
    const final = h.cards.at(-1);
    expect(final.header.subtitle.content).toBe("Remi Claude fable51");
    expect(JSON.stringify(final)).toContain("0/—");
    expect(JSON.stringify(final)).not.toContain("200k");
  });

  it("hides billing-only context and does not infer a model for old Tasks", async () => {
    const h = harness();
    await h.channel.handleTaskStream("oc_chat", "topic1", stream([event(1, "usage", { total_tokens: 883000 })]), meta);
    expect(h.cards.at(-1).header.subtitle.content).toBe("Remi");
    expect(JSON.stringify(h.cards)).not.toContain("883");
  });

  it("replays a proactive card into its existing message with the same metadata", async () => {
    const h = harness();
    await h.channel.handleTaskStream("oc_chat", "report", stream([
      execution, event(2, "usage", { used: 82000, size: 200000 }),
    ]), meta, { durable: { idempotencyKey: "delivery", messageId: "om_existing" } });
    expect(h.sends).toHaveLength(0);
    expect(h.cards.at(-1).header.subtitle.content).toBe("Remi Claude opus5");
    expect(JSON.stringify(h.cards)).toContain("82k/200k");
    expect(JSON.stringify(h.cards)).not.toContain("<at ");
  });

  it("keeps the original footer icons at completion and hides statistics during legacy progress", async () => {
    const h = harness();
    const session = h.channel.createStream();
    await session.start("oc_chat", "chat_id", { displayName: "Remi", mentionOpenId: "ou_sender" });
    session.updateExecution({ provider: "claude", model: "claude-opus-5" });
    session.updateContextUsage({ used: 82000, size: 200000 });
    session.addStep("Read", "Read source");
    (session as any).startTime = Date.now() - 54000;
    await session.appendPermissionForm(buildToolApprovalForm("approval", "Read", "source", []));
    await session.close("Answer");
    for (const card of h.cards.slice(1)) {
      expect(card.header.subtitle.content).toBe("Remi Claude opus5");
      if (card !== h.cards.at(-1)) {
        expect(JSON.stringify(card)).not.toContain("54s");
        expect(JSON.stringify(card)).not.toContain("82k/200k");
        expect(JSON.stringify(card)).not.toContain("<at ");
        continue;
      }
      const footer = card.body.elements.at(-1);
      expect(footer.flex_mode).toBe("flow");
      const final = card === h.cards.at(-1);
      expect(footer.columns.map((column: any) => column.elements[0].content ?? column.elements[0].text.content))
        .toEqual([...(final ? ["<at id=ou_sender></at>"] : []), "54s", "82k/200k", "1 tools"]);
      expect(footer.columns.slice(final ? 1 : 0).map((column: any) => column.elements[0].icon.token))
        .toEqual(["time_outlined", "translate_outlined", "setting-inter_outlined"]);
    }
    const noContext = buildFinalCard({ text: "Answer", stats: "54s · 3 tools" }) as any;
    expect(noContext.body.elements.at(-1).columns[1].elements[0].icon.token).toBe("setting-inter_outlined");
  });
});
